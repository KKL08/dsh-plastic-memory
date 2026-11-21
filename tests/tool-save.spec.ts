import { describe, expect, it } from 'vitest'
import { fakeExec } from './helpers/exec.ts'
import { record } from './helpers/record.ts'
import { executeSave, renderSaveResult, type SaveToolDeps } from '../src/tools/save.ts'
import { MemoryStore } from '../src/store.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'
import { SnapshotStore } from '../src/governance/snapshots.ts'
import type { MemorySnapshot, PendingDecision } from '../src/governance/schema.ts'
import { PendingDecisionsStore } from '../src/governance/decisions.ts'
import { InMemoryTable } from './helpers/in-memory-table.ts'
import { InMemoryKvTable, InMemoryBatchKvTable } from './helpers/in-memory-kv.ts'

const registry = buildTypeRegistry({ template: 'coding', customTypes: {} })

function makeDeps(store = new MemoryStore(new InMemoryTable(), undefined, new InMemoryBatchKvTable())): SaveToolDeps {
  return {
    store,
    registry,
    snapshots: new SnapshotStore(new InMemoryKvTable<MemorySnapshot>()),
    host: { saveContextOf: async () => ({ workspacePath: '/proj', session: { id: 's1', lastSeq: 3 } }) },
    globalUpdateGuided: new Map(),
  }
}

const base = {
  action: 'create' as const,
  type: 'preference',
  scope: 'global' as const,
  sourceMode: 'user-explicit' as const,
  tags: [] as string[],
}

describe('executeSave', () => {
  it('create 走管线返回 saved，store 多一条', async () => {
    const store = new MemoryStore(new InMemoryTable(), undefined, new InMemoryBatchKvTable())
    const result = await executeSave(
      { ...base, name: 'commit 语言', content: 'commit 信息用英文', summary: 'commit 英文' },
      fakeExec(),
      makeDeps(store),
    )
    expect(result.kind).toBe('saved')
    expect((await store.query({})).length).toBe(1)
  })

  it('tags 缺省时归一化为空数组仍能保存', async () => {
    const store = new MemoryStore(new InMemoryTable(), undefined, new InMemoryBatchKvTable())
    const result = await executeSave(
      // 故意不传 tags，验证 executeSave 里的归一化
      { action: 'create', type: 'preference', scope: 'global', sourceMode: 'user-explicit', name: '标题', content: '内容', summary: '摘要' },
      fakeExec(),
      makeDeps(store),
    )
    if (result.kind !== 'saved') throw new Error(result.kind)
    expect(result.record.tags).toEqual([])
  })

  it('同实体的同类记忆触发 duplicate-suspected', async () => {
    const store = new MemoryStore(new InMemoryTable(), undefined, new InMemoryBatchKvTable())
    const deps = makeDeps(store)
    await executeSave({ ...base, name: '认证位置', content: '认证逻辑在 `src/auth.ts`', summary: 'auth 位置' }, fakeExec(), deps)
    const dup = await executeSave({ ...base, name: '认证位置改', content: '`src/auth.ts` 负责认证', summary: 'auth 位置改' }, fakeExec(), deps)
    expect(dup.kind).toBe('duplicate-suspected')
  })

  it('保存上下文无 workspacePath（无 cwd 会话）时 create 拒存', async () => {
    const store = new MemoryStore(new InMemoryTable(), undefined, new InMemoryBatchKvTable())
    const deps: SaveToolDeps = {
      ...makeDeps(store),
      host: { saveContextOf: async () => ({ workspacePath: undefined, session: { id: 's1', lastSeq: 3 } }) },
    }
    const result = await executeSave(
      { ...base, scope: 'workspace', name: '项目规则', content: '本项目用 pnpm', summary: 'pnpm' },
      fakeExec(), deps,
    )
    if (result.kind !== 'rejected') throw new Error(result.kind)
    expect(result).toMatchObject({ kind: 'rejected', code: 'no-workspace' })
  })

  // 回归：executeSave 必须无条件把 workspacePath 传给管线，否则 scope=global 时管线看不到
  // workspace 上下文，降级永不触发（真机实测发现的 bug——单测直调 runSavePipeline 会漏掉这层）。
  it('scope=global 且有 workspace 上下文时，executeSave 降级 workspace + globalCandidate', async () => {
    const store = new MemoryStore(new InMemoryTable(), undefined, new InMemoryBatchKvTable())
    const deps: SaveToolDeps = {
      ...makeDeps(store),
      host: { saveContextOf: async () => ({ workspacePath: '/proj', session: { id: 's1', lastSeq: 3 } }) },
    }
    const result = await executeSave(
      { ...base, scope: 'global', name: '全局偏好', content: '所有项目用 pnpm', summary: 'pnpm' },
      fakeExec(), deps,
    )
    if (result.kind !== 'saved') throw new Error(result.kind)
    expect(result.record.scope).toBe('workspace')
    expect(result.record.workspacePath).toBe('/proj')
    expect(result.record.globalCandidate).toBe(true)
  })

  // B1c 接线：executeSave 把 snapshots dep 透传给管线，update global 目标时拍快照
  it('update global 目标时经 snapshots dep 拍 pre-update 快照', async () => {
    const store = new MemoryStore(new InMemoryTable(), undefined, new InMemoryBatchKvTable())
    const snapshots = new SnapshotStore(new InMemoryKvTable<MemorySnapshot>())
    const deps: SaveToolDeps = { ...makeDeps(store), snapshots }
    const created = await executeSave(
      { ...base, name: '全局偏好', content: '旧全局内容', summary: 'pref' }, fakeExec(), deps)
    if (created.kind !== 'saved') throw new Error(created.kind)
    // 降级成了 workspace 候选，手工提到 global 模拟 promote 后
    await store.put({ ...created.record, scope: 'global', workspacePath: undefined } as never)
    const update = { ...base, action: 'update' as const, confirmGlobal: true, id: created.record.id, name: '全局偏好', content: '新全局内容', summary: 'pref' }
    await executeSave(update, fakeExec(), deps) // 第一次回引导
    const updated = await executeSave(update, fakeExec(), deps)
    if (updated.kind !== 'updated') throw new Error(updated.kind)
    const list = await snapshots.list()
    expect(list).toHaveLength(1)
    expect(list[0].operation).toBe('pre-update')
    expect(list[0].data[0].content).toBe('旧全局内容')
  })

  // 项目会话里改全局记忆：引导要真的回到模型面前，预先填 confirmGlobal 跳不过去
  describe('改写全局记忆先回引导', () => {
    async function globalMemory(deps: SaveToolDeps) {
      const created = await executeSave({ ...base, name: '提交规范', content: '提交信息用英文', summary: '提交规范' }, fakeExec(), deps)
      if (created.kind !== 'saved') throw new Error(created.kind)
      await deps.store.put({ ...created.record, scope: 'global', workspacePath: undefined } as never)
      return { ...base, action: 'update' as const, id: created.record.id, name: '提交规范', content: '提交信息用英文，不加类型前缀', summary: '提交规范', confirmGlobal: true }
    }
    const contentOf = async (deps: SaveToolDeps, id: string) => (await deps.store.get(id))?.content

    it('第一次就带 confirmGlobal：照样先回引导、不写入；收到引导后重发才写', async () => {
      const deps = makeDeps()
      const update = await globalMemory(deps)
      const first = await executeSave(update, fakeExec(), deps)
      expect(first).toMatchObject({ kind: 'rejected', code: 'global-update-unconfirmed' })
      expect(await contentOf(deps, update.id)).toBe('提交信息用英文')
      expect(await executeSave(update, fakeExec(), deps)).toMatchObject({ kind: 'updated' })
      expect(await contentOf(deps, update.id)).toBe('提交信息用英文，不加类型前缀')
    })

    it('收到引导后不带 confirmGlobal 重发：仍回引导', async () => {
      const deps = makeDeps()
      const update = await globalMemory(deps)
      await executeSave(update, fakeExec(), deps)
      const { confirmGlobal: _, ...unconfirmed } = update
      expect(await executeSave(unconfirmed, fakeExec(), deps)).toMatchObject({ kind: 'rejected', code: 'global-update-unconfirmed' })
      expect(await executeSave(update, fakeExec(), deps)).toMatchObject({ kind: 'updated' })
    })

    it('引导只抵一次改写：写成后再改同一条，重新回引导', async () => {
      const deps = makeDeps()
      const update = await globalMemory(deps)
      await executeSave(update, fakeExec(), deps)
      await executeSave(update, fakeExec(), deps)
      const again = { ...update, content: '提交信息用英文祈使句' }
      expect(await executeSave(again, fakeExec(), deps)).toMatchObject({ kind: 'rejected', code: 'global-update-unconfirmed' })
      expect(await executeSave(again, fakeExec(), deps)).toMatchObject({ kind: 'updated' })
    })

    it('收到引导后改存项目记忆，同一会话再预填 confirmGlobal 改全局：重新回引导', async () => {
      const deps = makeDeps()
      const update = await globalMemory(deps)
      await executeSave(update, fakeExec(), deps)
      expect(await executeSave({ ...base, name: '本仓库提交不加前缀', content: '这个仓库的提交不加类型前缀', summary: '本仓库提交规范' }, fakeExec(), deps)).toMatchObject({ kind: 'saved' })
      expect(await executeSave(update, fakeExec(), deps)).toMatchObject({ kind: 'rejected', code: 'global-update-unconfirmed' })
      expect(await contentOf(deps, update.id)).toBe('提交信息用英文')
    })

    it('引导按会话算：别的会话回过引导，这个会话照样先回引导', async () => {
      const store = new MemoryStore(new InMemoryTable(), undefined, new InMemoryBatchKvTable())
      const shared = makeDeps(store)
      const inSession = (id: string): SaveToolDeps => ({ ...shared, host: { saveContextOf: async () => ({ workspacePath: '/proj', session: { id, lastSeq: 3 } }) } })
      const update = await globalMemory(inSession('a'))
      await executeSave(update, fakeExec(), inSession('a'))
      expect(await executeSave(update, fakeExec(), inSession('b'))).toMatchObject({ kind: 'rejected', code: 'global-update-unconfirmed' })
    })
  })

  it('改写记下撤销记录：会话取上下文、调用 id 取这次工具调用', async () => {
    const store = new MemoryStore(new InMemoryTable(), undefined, new InMemoryBatchKvTable())
    const snapshots = new SnapshotStore(new InMemoryKvTable<MemorySnapshot>())
    const decisions = new PendingDecisionsStore(new InMemoryKvTable<PendingDecision>())
    const deps: SaveToolDeps = { ...makeDeps(store), snapshots, decisions }
    const created = await executeSave({ ...base, scope: 'workspace', name: '偏好', content: '旧内容', summary: 'pref' }, fakeExec(), deps)
    if (created.kind !== 'saved') throw new Error(created.kind)
    expect(await decisions.listSettled()).toEqual([])
    await executeSave(
      { ...base, scope: 'workspace', action: 'update', id: created.record.id, name: '偏好', content: '新内容', summary: 'pref' },
      fakeExec({ callId: 'call-9' } as never), deps)
    expect((await decisions.listSettled())[0]).toMatchObject({ kind: 'rewrite', origin: { sessionId: 's1', callId: 'call-9' } })
  })
})

describe('renderSaveResult', () => {
  it('saved 文案含 id、类型、scope', async () => {
    const store = new MemoryStore(new InMemoryTable(), undefined, new InMemoryBatchKvTable())
    const result = await executeSave(
      { ...base, name: 'commit 语言', content: 'commit 信息用英文', summary: 'commit 英文' },
      fakeExec(),
      makeDeps(store),
    )
    if (result.kind !== 'saved') throw new Error(result.kind)
    const text = renderSaveResult(result)
    expect(text).toContain(result.record.id)
    expect(text).toContain('preference')
    expect(text).toContain('workspace') // scope=global 在有 workspace 时降级为候选
  })

  it('子 agent 存下的待确认记录：文案写明待确认、不进主会话注入，含 id 与摘要，并叫它在回复里报给委派方', () => {
    const pending = record({ id: 'mem_sub', type: 'knowledge', scope: 'workspace', summary: 'main 上 pnpm test 会挂', delegation: { sessionId: 's-child', depth: 1, parentSessionId: 's-main' } })
    const text = renderSaveResult({ kind: 'saved', record: pending })
    expect(text).toContain('mem_sub')
    expect(text).toContain('main 上 pnpm test 会挂')
    expect(text).toContain('待确认')
    expect(text).toContain('不进主会话注入')
    expect(text).toContain('在回复里报给委派方')
    expect(text).toContain('接受、改写或丢弃')
    expect(text).not.toContain('回复里不用提这次保存')
    // 主会话的保存照旧：不提委派方
    expect(renderSaveResult({ kind: 'saved', record: record({ id: 'mem_main' }) })).not.toContain('委派方')
  })

  it('待确认文案把摘要嵌进句子：摘要自带句末句号时不拼出「。。」', () => {
    const pending = record({ id: 'mem_sub', type: 'knowledge', scope: 'workspace', summary: '端口 3000 被占用。', delegation: { sessionId: 's-child', depth: 1, parentSessionId: 's-main' } })
    const text = renderSaveResult({ kind: 'saved', record: pending })
    expect(text).toContain('已存为待确认：端口 3000 被占用。不进主会话注入')
    expect(text).not.toContain('。。')
  })

  it('子 agent 改写自己的待确认记录：文案写明仍待确认，含 id 与摘要，叫它报给委派方', () => {
    const pending = record({ id: 'mem_sub', type: 'knowledge', scope: 'workspace', summary: 'main 上 pnpm test 会挂', delegation: { sessionId: 's-child', depth: 1, parentSessionId: 's-main' } })
    const text = renderSaveResult({ kind: 'updated', record: pending })
    expect(text.startsWith('已更新记忆 mem_sub')).toBe(true)
    expect(text).toContain('main 上 pnpm test 会挂')
    expect(text).toContain('仍待确认')
    expect(text).toContain('在回复里报给委派方')
    expect(text).not.toContain('回复里不用提这次保存')
    // 主会话改写照旧
    expect(renderSaveResult({ kind: 'updated', record: record({ id: 'mem_main' }) })).not.toContain('委派方')
  })

  it('updated 文案含 id', async () => {
    const store = new MemoryStore(new InMemoryTable(), undefined, new InMemoryBatchKvTable())
    const deps = makeDeps(store)
    const created = await executeSave(
      { ...base, name: 'commit 语言', content: 'commit 信息用英文', summary: 'commit 英文' },
      fakeExec(),
      deps,
    )
    if (created.kind !== 'saved') throw new Error(created.kind)
    const updated = await executeSave(
      { ...base, action: 'update', id: created.record.id, name: 'commit 语言', content: '改用中文', summary: 'commit 中文' },
      fakeExec(),
      deps,
    )
    if (updated.kind !== 'updated') throw new Error(updated.kind)
    expect(renderSaveResult(updated)).toContain(updated.record.id)
  })

  it('duplicate-suspected 提示改用 update 且含命中 id', () => {
    const text = renderSaveResult({ kind: 'duplicate-suspected', existing: [{ id: 'mem_1', summary: '已有' }] })
    expect(text).toContain('mem_1')
    expect(text).toContain('update')
  })

  it('rejected 文案含原因', () => {
    const text = renderSaveResult({ kind: 'rejected', code: 'unknown-type', reason: '未知类型 "ghost"' })
    expect(text).toContain('未保存')
    expect(text).toContain('ghost')
  })

  it('saved 含 warnings 时渲染显示警告行', async () => {
    const store = new MemoryStore(new InMemoryTable(), undefined, new InMemoryBatchKvTable())
    const result = await executeSave(
      { ...base, name: '密钥记录', content: '内部约定 api_key: 1234567890abcdefghij', summary: 'key', force: true },
      fakeExec(),
      makeDeps(store),
    )
    if (result.kind !== 'saved') throw new Error(result.kind)
    const text = renderSaveResult(result)
    expect(text).toContain('⚠️')
    const warning = result.warnings?.[0]
    expect(text).toContain(warning!.text)
  })

  it('updated 含 warnings 时渲染显示警告行', async () => {
    const store = new MemoryStore(new InMemoryTable(), undefined, new InMemoryBatchKvTable())
    const deps = makeDeps(store)
    const created = await executeSave(
      { ...base, name: 'title', content: '普通内容', summary: '摘要' },
      fakeExec(),
      deps,
    )
    if (created.kind !== 'saved') throw new Error(created.kind)
    const updated = await executeSave(
      { ...base, action: 'update', id: created.record.id, name: 'title', content: '密码:TESTONLYpassw0rd', summary: 'summary', force: true },
      fakeExec(),
      deps,
    )
    if (updated.kind !== 'updated') throw new Error(updated.kind)
    const text = renderSaveResult(updated)
    expect(text).toContain('⚠️')
    const warning = updated.warnings?.[0]
    expect(text).toContain(warning!.text)
  })

  it('saved/updated 提醒模型回复里不用提这次保存；拒存、疑似重复不带', () => {
    const saved = record({ id: 'mem_1' })
    const quiet = '回复里不用提这次保存。'
    expect(renderSaveResult({ kind: 'saved', record: saved })).toContain(quiet)
    expect(renderSaveResult({ kind: 'updated', record: saved })).toContain(quiet)
    expect(renderSaveResult({ kind: 'rejected', code: 'unknown-type', reason: '未知类型' })).not.toContain(quiet)
    expect(renderSaveResult({ kind: 'duplicate-suspected', existing: [{ id: 'mem_1', summary: '已有' }] })).not.toContain(quiet)
  })

  it('saved/updated 无 warnings 时渲染文案不改变', async () => {
    const store = new MemoryStore(new InMemoryTable(), undefined, new InMemoryBatchKvTable())
    const result = await executeSave(
      { ...base, name: 'clean content', content: 'just regular text', summary: 'summary' },
      fakeExec(),
      makeDeps(store),
    )
    if (result.kind !== 'saved') throw new Error(result.kind)
    const text = renderSaveResult(result)
    expect(text).not.toContain('⚠️')
  })
})

describe('renderSaveDescription（memory_save 工具描述来源）', () => {
  it('含通用引导层与各类型记什么、什么时候记', () => {
    const description = registry.renderSaveDescription()
    expect(description).toContain('各类型记什么、什么时候记')
    expect(description).toContain('preference')
  })

  it('不再交代手改保护：改写用户改过的记忆不用先问', () => {
    expect(registry.renderSaveDescription()).not.toContain('手改')
  })

  it('保存说明交代更新全局记忆的边界：只并入对所有项目都成立的，只对当前项目成立的新建项目记忆', () => {
    expect(registry.renderSaveDescription()).toContain('更新全局记忆时，只并入对所有项目都成立的内容；只对当前项目成立的（用户说「这个仓库」「这个项目」），新建一条 workspace 记忆，全局那条保持原样。')
  })

  it('交代记录是过程动作：回复不特意说记下了，用户明确要求记住时才应一句', () => {
    const description = registry.renderSaveDescription()
    expect(description).toContain('不要特意说「记下了」')
    expect(description).toContain('只在这时简短应一句')
  })

  it('update 与 supersedes 分工：旧说法要留档时新建一条、supersedes 填旧的 id', () => {
    expect(registry.renderSaveDescription()).toContain('更新已有记忆传 action=update 和目标 id，别重复新增；旧说法要留档时（比如决定改了），新建一条、supersedes 填旧记忆的 id。')
  })

  it('用户要求记住时记内容本身，不记「用户让我记」这个动作', () => {
    expect(registry.renderSaveDescription()).toContain('按最贴合的类型马上记下内容本身')
  })

  it('相对时间换成具体日期；确定不了的保留原来的精度，不编日期', () => {
    const description = registry.renderSaveDescription()
    expect(description).toContain('落库时换成具体日期')
    expect(description).toContain('确定不了具体日期的保留原来的精度')
  })
})
