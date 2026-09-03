import { describe, expect, it } from 'vitest'
import { executeSave, renderSaveResult, type SaveToolDeps } from '../src/tools/save.ts'
import { MemoryStore, InMemoryTable } from '../src/store.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'
import { SnapshotStore } from '../src/governance/snapshots.ts'
import { InMemoryKvTable } from '../src/kv-table.ts'
import type { MemorySnapshot } from '../src/governance/schema.ts'

const registry = buildTypeRegistry({ template: 'coding', customTypes: {} })

function makeDeps(store = new MemoryStore(new InMemoryTable())): SaveToolDeps {
  return {
    store,
    registry,
    resolveContext: async () => ({ workspacePath: '/proj', session: { id: 's1', lastSeq: 3 } }),
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
    const store = new MemoryStore(new InMemoryTable())
    const result = await executeSave(
      { ...base, name: 'commit 语言', content: 'commit 信息用英文', summary: 'commit 英文' },
      {} as never,
      makeDeps(store),
    )
    expect(result.kind).toBe('saved')
    expect(store.query({}).length).toBe(1)
  })

  it('tags 缺省时归一化为空数组仍能保存', async () => {
    const store = new MemoryStore(new InMemoryTable())
    const result = await executeSave(
      // 故意不传 tags，验证 executeSave 里的归一化
      { action: 'create', type: 'preference', scope: 'global', sourceMode: 'user-explicit', name: '标题', content: '内容', summary: '摘要' },
      {} as never,
      makeDeps(store),
    )
    if (result.kind !== 'saved') throw new Error(result.kind)
    expect(result.record.tags).toEqual([])
  })

  it('同实体的同类记忆触发 duplicate-suspected', async () => {
    const store = new MemoryStore(new InMemoryTable())
    const deps = makeDeps(store)
    await executeSave({ ...base, name: '认证位置', content: '认证逻辑在 `src/auth.ts`', summary: 'auth 位置' }, {} as never, deps)
    const dup = await executeSave({ ...base, name: '认证位置改', content: '`src/auth.ts` 负责认证', summary: 'auth 位置改' }, {} as never, deps)
    expect(dup.kind).toBe('duplicate-suspected')
  })

  it('resolveContext 无 workspacePath（无 cwd 会话）时 create 拒存', async () => {
    const store = new MemoryStore(new InMemoryTable())
    const deps: SaveToolDeps = {
      ...makeDeps(store),
      resolveContext: async () => ({ workspacePath: undefined, session: { id: 's1', lastSeq: 3 } }),
    }
    const result = await executeSave(
      { ...base, scope: 'workspace', name: '项目规则', content: '本项目用 pnpm', summary: 'pnpm' },
      {} as never, deps,
    )
    if (result.kind !== 'rejected') throw new Error(result.kind)
    expect(result).toMatchObject({ kind: 'rejected', code: 'no-workspace' })
  })

  // 回归：executeSave 必须无条件把 workspacePath 传给管线，否则 scope=global 时管线看不到
  // workspace 上下文，降级永不触发（真机实测发现的 bug——单测直调 runSavePipeline 会漏掉这层）。
  it('scope=global 且有 workspace 上下文时，executeSave 降级 workspace + globalCandidate', async () => {
    const store = new MemoryStore(new InMemoryTable())
    const deps: SaveToolDeps = {
      ...makeDeps(store),
      resolveContext: async () => ({ workspacePath: '/proj', session: { id: 's1', lastSeq: 3 } }),
    }
    const result = await executeSave(
      { ...base, scope: 'global', name: '全局偏好', content: '所有项目用 pnpm', summary: 'pnpm' },
      {} as never, deps,
    )
    if (result.kind !== 'saved') throw new Error(result.kind)
    expect(result.record.scope).toBe('workspace')
    expect(result.record.workspacePath).toBe('/proj')
    expect(result.record.globalCandidate).toBe(true)
  })

  // B1c 接线：executeSave 把 snapshots dep 透传给管线，update global 目标时拍快照
  it('update global 目标时经 snapshots dep 拍 pre-update 快照', async () => {
    const store = new MemoryStore(new InMemoryTable())
    const snapshots = new SnapshotStore(new InMemoryKvTable<MemorySnapshot>())
    const deps: SaveToolDeps = { ...makeDeps(store), snapshots }
    const created = await executeSave(
      { ...base, name: '全局偏好', content: '旧全局内容', summary: 'pref' }, {} as never, deps)
    if (created.kind !== 'saved') throw new Error(created.kind)
    // 降级成了 workspace 候选，手工提到 global 模拟 promote 后
    await store.put({ ...created.record, scope: 'global', workspacePath: undefined } as never)
    const updated = await executeSave(
      { ...base, action: 'update', id: created.record.id, name: '全局偏好', content: '新全局内容', summary: 'pref' },
      {} as never, deps)
    if (updated.kind !== 'updated') throw new Error(updated.kind)
    const list = snapshots.list()
    expect(list).toHaveLength(1)
    expect(list[0].operation).toBe('pre-update')
    expect(list[0].data[0].content).toBe('旧全局内容')
  })
})

describe('renderSaveResult', () => {
  it('saved 文案含 id、类型、scope', async () => {
    const store = new MemoryStore(new InMemoryTable())
    const result = await executeSave(
      { ...base, name: 'commit 语言', content: 'commit 信息用英文', summary: 'commit 英文' },
      {} as never,
      makeDeps(store),
    )
    if (result.kind !== 'saved') throw new Error(result.kind)
    const text = renderSaveResult(result)
    expect(text).toContain(result.record.id)
    expect(text).toContain('preference')
    expect(text).toContain('workspace') // scope=global 在有 workspace 时降级为候选
  })

  it('updated 文案含 id', async () => {
    const store = new MemoryStore(new InMemoryTable())
    const deps = makeDeps(store)
    const created = await executeSave(
      { ...base, name: 'commit 语言', content: 'commit 信息用英文', summary: 'commit 英文' },
      {} as never,
      deps,
    )
    if (created.kind !== 'saved') throw new Error(created.kind)
    const updated = await executeSave(
      { ...base, action: 'update', id: created.record.id, name: 'commit 语言', content: '改用中文', summary: 'commit 中文' },
      {} as never,
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
    const store = new MemoryStore(new InMemoryTable())
    const result = await executeSave(
      { ...base, name: '密钥记录', content: '内部约定 api_key: 1234567890abcdefghij', summary: 'key' },
      {} as never,
      makeDeps(store),
    )
    if (result.kind !== 'saved') throw new Error(result.kind)
    const text = renderSaveResult(result)
    expect(text).toContain('⚠️')
    const warning = result.warnings?.[0]
    expect(text).toContain(warning!.text)
  })

  it('updated 含 warnings 时渲染显示警告行', async () => {
    const store = new MemoryStore(new InMemoryTable())
    const deps = makeDeps(store)
    const created = await executeSave(
      { ...base, name: 'title', content: '普通内容', summary: '摘要' },
      {} as never,
      deps,
    )
    if (created.kind !== 'saved') throw new Error(created.kind)
    const updated = await executeSave(
      { ...base, action: 'update', id: created.record.id, name: 'title', content: '密码:TESTONLYpassw0rd', summary: 'summary' },
      {} as never,
      deps,
    )
    if (updated.kind !== 'updated') throw new Error(updated.kind)
    const text = renderSaveResult(updated)
    expect(text).toContain('⚠️')
    const warning = updated.warnings?.[0]
    expect(text).toContain(warning!.text)
  })

  it('saved/updated 无 warnings 时渲染文案不改变', async () => {
    const store = new MemoryStore(new InMemoryTable())
    const result = await executeSave(
      { ...base, name: 'clean content', content: 'just regular text', summary: 'summary' },
      {} as never,
      makeDeps(store),
    )
    if (result.kind !== 'saved') throw new Error(result.kind)
    const text = renderSaveResult(result)
    expect(text).not.toContain('⚠️')
  })
})

describe('renderSaveDescription（memory_save 工具描述来源）', () => {
  it('含通用引导层与各类型何时记清单', () => {
    const description = registry.renderSaveDescription()
    expect(description).toContain('各类型何时记')
    expect(description).toContain('preference')
  })
})
