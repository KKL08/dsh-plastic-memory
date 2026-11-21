import { describe, expect, it } from 'vitest'
import { runSavePipeline, type SaveInput } from '../src/pipeline.ts'
import { createSaveTool } from '../src/tools/save-tool.ts'
import { executeSave, type SaveToolDeps } from '../src/tools/save.ts'
import { MemoryStore } from '../src/store.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'
import { SnapshotStore } from '../src/governance/snapshots.ts'
import { PendingDecisionsStore } from '../src/governance/decisions.ts'
import type { MemorySnapshot, PendingDecision } from '../src/governance/schema.ts'
import type { MemoryRecord } from '../src/record-schema.ts'
import { SECRET_MASK } from '../src/secrets.ts'
import { fakeExec } from './helpers/exec.ts'
import { record } from './helpers/record.ts'
import { FAKE_SECRET } from './helpers/secrets.ts'
import { InMemoryTable } from './helpers/in-memory-table.ts'
import { InMemoryKvTable, InMemoryBatchKvTable } from './helpers/in-memory-kv.ts'

// memory_save update 的精确修改（edits）：按 oldString 精确、唯一命中替换正文片段，其余正文和没传的字段原样保留。
// 写入仍走同一条管线：密钥检查、改前快照、撤销记录、读后被改复核都照旧。

const registry = buildTypeRegistry({ template: 'coding', customTypes: {} })
const WS = '/proj'
const session = { id: 's-edit', lastSeq: 9 }

function env() {
  const store = new MemoryStore(new InMemoryTable(), undefined, new InMemoryBatchKvTable())
  const snapshots = new SnapshotStore(new InMemoryKvTable<MemorySnapshot>())
  const decisions = new PendingDecisionsStore(new InMemoryKvTable<PendingDecision>())
  return { store, snapshots, decisions, deps: { store, registry, workspacePath: WS as string | undefined, session, snapshots, decisions, callId: 'call-e' } }
}

const target = (partial: Partial<MemoryRecord> = {}) => record({
  id: 'mem_t', name: '服务配置', type: 'project', scope: 'workspace', workspacePath: WS,
  content: '开发服务端口 3000。\n接口超时 5 秒，重试 2 次。', summary: '本地服务的端口与超时', tags: ['dev-server'],
  source: { sessionId: 's-old', eventRange: [1, 2], sourceMode: 'user-explicit' },
  ...partial,
})

const edit = (edits: SaveInput['edits'], partial: Partial<SaveInput> = {}): SaveInput =>
  ({ action: 'update', id: 'mem_t', sourceMode: 'user-explicit', edits, ...partial })

async function seeded(partial: Partial<MemoryRecord> = {}) {
  const e = env()
  await e.store.put(target(partial))
  return e
}

const rejected = async (p: Promise<unknown>, code: string) => {
  const r = await p as { kind: string; code?: string; reason?: string }
  expect(r).toMatchObject({ kind: 'rejected', code })
  return r.reason ?? ''
}

describe('精确修改：命中与替换', () => {
  it('只改命中的片段，其余正文原样；name、summary、tags、type、scope 没传就保留；出处换成本会话；拍快照、记一条 rewrite', async () => {
    const e = await seeded()
    const r = await runSavePipeline(edit([{ oldString: '端口 3000', newString: '端口 8080' }]), e.deps)
    if (r.kind !== 'updated') throw new Error(r.kind)
    const after = (await e.store.get('mem_t', { workspacePath: WS }))!
    expect(after.content).toBe('开发服务端口 8080。\n接口超时 5 秒，重试 2 次。')
    expect([after.name, after.summary, after.tags, after.type, after.scope]).toEqual(['服务配置', '本地服务的端口与超时', ['dev-server'], 'project', 'workspace'])
    expect(after.source).toMatchObject({ sessionId: 's-edit', sourceMode: 'user-explicit' })
    const [snap] = await e.snapshots.list()
    expect(snap!.data[0]!.content).toBe('开发服务端口 3000。\n接口超时 5 秒，重试 2 次。')
    expect((await e.decisions.listSettled())[0]).toMatchObject({ kind: 'rewrite', memoryIds: ['mem_t'] })
  })

  it('同时传 summary、name 就一并换掉', async () => {
    const e = await seeded()
    const r = await runSavePipeline(edit([{ oldString: '5 秒', newString: '30 秒' }], { summary: '本地服务的端口与 30 秒超时', name: '服务参数' }), e.deps)
    if (r.kind !== 'updated') throw new Error(r.kind)
    expect(r.record).toMatchObject({ name: '服务参数', summary: '本地服务的端口与 30 秒超时', content: '开发服务端口 3000。\n接口超时 30 秒，重试 2 次。' })
  })

  it('多处修改按顺序应用，后一处匹配的是前一处改完的正文', async () => {
    const e = await seeded()
    const r = await runSavePipeline(edit([
      { oldString: '端口 3000', newString: '端口 8080' },
      { oldString: '端口 8080。', newString: '端口 8080（容器里映射到 80）。' },
    ]), e.deps)
    if (r.kind !== 'updated') throw new Error(r.kind)
    expect(r.record.content).toBe('开发服务端口 8080（容器里映射到 80）。\n接口超时 5 秒，重试 2 次。')
  })

  it('replaceAll 替换全部命中', async () => {
    const e = await seeded({ content: '用 npm 安装依赖，CI 里也用 npm。' })
    const r = await runSavePipeline(edit([{ oldString: 'npm', newString: 'pnpm', replaceAll: true }]), e.deps)
    if (r.kind !== 'updated') throw new Error(r.kind)
    expect(r.record.content).toBe('用 pnpm 安装依赖，CI 里也用 pnpm。')
  })

  it('newString 里的 $& 之类原样写入，不当替换模式', async () => {
    const e = await seeded()
    const r = await runSavePipeline(edit([{ oldString: '端口 3000', newString: '端口 $& $1 $$' }]), e.deps)
    if (r.kind !== 'updated') throw new Error(r.kind)
    expect(r.record.content.startsWith('开发服务端口 $& $1 $$。')).toBe(true)
  })

  it('正文是 CRLF 换行（手建文件）时，oldString 按 LF 写也能命中', async () => {
    const e = await seeded({ content: '第一行\r\n第二行\r\n' })
    const r = await runSavePipeline(edit([{ oldString: '第一行\n第二行', newString: '第一行\n改过的第二行' }]), e.deps)
    if (r.kind !== 'updated') throw new Error(r.kind)
    expect(r.record.content).toBe('第一行\n改过的第二行\n')
  })
})

describe('精确修改：拒绝时什么都不写', () => {
  const untouched = async (e: Awaited<ReturnType<typeof seeded>>) => {
    expect((await e.store.get('mem_t', { workspacePath: WS }))!.content).toBe(target().content)
    expect(await e.snapshots.list()).toEqual([])
    expect(await e.decisions.listSettled()).toEqual([])
  }

  it('找不到：edit-not-found，原因说明是第几处、带当前正文让模型照着重摘', async () => {
    const e = await seeded()
    const reason = await rejected(runSavePipeline(edit([
      { oldString: '端口 3000', newString: '端口 8080' },
      { oldString: '超时 10 秒', newString: '超时 30 秒' },
    ]), e.deps), 'edit-not-found')
    expect(reason).toContain('第 2 处')
    expect(reason).toContain('接口超时 5 秒，重试 2 次。')
    await untouched(e)
  })

  it('命中多处又没带 replaceAll：edit-ambiguous，原因带命中次数', async () => {
    const e = await seeded({ content: '用 npm 安装依赖，CI 里也用 npm。' })
    const reason = await rejected(runSavePipeline(edit([{ oldString: 'npm', newString: 'pnpm' }]), e.deps), 'edit-ambiguous')
    expect(reason).toContain('2 次')
    expect(reason).toContain('replaceAll')
    expect((await e.store.get('mem_t', { workspacePath: WS }))!.content).toBe('用 npm 安装依赖，CI 里也用 npm。')
  })

  it.each([
    ['action=create 带 edits', { action: 'create' as const, scope: 'workspace' as const, type: 'project', name: 'n', summary: 's' }],
    ['edits 和 content 一起传', { content: '整条新正文' }],
  ])('%s：edit-invalid', async (_label, partial) => {
    const e = await seeded()
    await rejected(runSavePipeline(edit([{ oldString: '端口', newString: '端口号' }], partial), e.deps), 'edit-invalid')
    await untouched(e)
  })

  it.each([
    ['空数组', []],
    ['oldString 为空', [{ oldString: '', newString: '开头' }]],
    ['oldString 与 newString 相同', [{ oldString: '端口 3000', newString: '端口 3000' }]],
  ])('%s：edit-invalid', async (_label, edits) => {
    const e = await seeded()
    await rejected(runSavePipeline(edit(edits as SaveInput['edits']), e.deps), 'edit-invalid')
    await untouched(e)
  })

  it('目标不存在：target-missing', async () => {
    await rejected(runSavePipeline(edit([{ oldString: 'a', newString: 'b' }], { id: 'mem_none' }), env().deps), 'target-missing')
  })

  it('目标在别的项目：cross-workspace，原因里不出现那条记忆的正文', async () => {
    const e = await seeded({ workspacePath: '/other' })
    const reason = await rejected(runSavePipeline(edit([{ oldString: '找不到的', newString: 'x' }]), e.deps), 'cross-workspace')
    expect(reason).not.toContain('接口超时')
  })

  it('原因里的当前正文遮掉密钥', async () => {
    const e = await seeded({ content: `部署令牌 ${FAKE_SECRET.github}，端口 3000` })
    const reason = await rejected(runSavePipeline(edit([{ oldString: '端口 4000', newString: '端口 8080' }]), e.deps), 'edit-not-found')
    expect(reason).not.toContain(FAKE_SECRET.github)
    expect(reason).toContain(SECRET_MASK)
  })

  it('改出来的正文含高危密钥：secret-critical', async () => {
    const e = await seeded()
    await rejected(runSavePipeline(edit([{ oldString: '端口 3000', newString: `令牌 ${FAKE_SECRET.github}` }]), e.deps), 'secret-critical')
    await untouched(e)
  })
})

describe('精确修改：子 agent', () => {
  const delegation = { depth: 1, parentSessionId: 's-main', mode: 'one-shot' as const }
  const pending = (by: string) => target({
    type: 'knowledge', source: { sessionId: by, eventRange: [0, 1], sourceMode: 'environment-observed' },
    delegation: { sessionId: by, depth: 1, parentSessionId: 's-main' },
  })

  it('改自己存下的待确认记录：照常写，仍待确认', async () => {
    const e = env()
    await e.store.put(pending('s-edit'))
    const r = await runSavePipeline(edit([{ oldString: '端口 3000', newString: '端口 8080' }], { sourceMode: 'environment-observed' }), { ...e.deps, delegation })
    if (r.kind !== 'updated') throw new Error(r.kind)
    expect(r.record.content).toContain('端口 8080')
    expect(r.record.delegation?.reviewed).toBeUndefined()
  })

  it('改别的会话的记录：subagent-restricted', async () => {
    const e = env()
    await e.store.put(pending('s-other'))
    const r = await runSavePipeline(edit([{ oldString: '端口 3000', newString: '端口 8080' }], { sourceMode: 'environment-observed' }), { ...e.deps, delegation })
    expect(r).toMatchObject({ kind: 'rejected', code: 'subagent-restricted', subcode: 'subagent-not-own' })
  })

  it('改不了的记录先报归属，不先比对原文：oldString 对不上也回 subagent-not-own，原因里没有那条的正文', async () => {
    const e = env()
    await e.store.put(pending('s-other'))
    const r = await runSavePipeline(edit([{ oldString: '端口 4000', newString: '端口 8080' }], { sourceMode: 'environment-observed' }), { ...e.deps, delegation })
    expect(r).toMatchObject({ kind: 'rejected', code: 'subagent-restricted', subcode: 'subagent-not-own' })
    expect((r as { reason: string }).reason).not.toContain('接口超时')
  })

  it('目标不存在：同整条更新回 subagent-target-gone，不回 target-missing', async () => {
    const r = await runSavePipeline(edit([{ oldString: 'a', newString: 'b' }], { id: 'mem_none', sourceMode: 'environment-observed' }), { ...env().deps, delegation })
    expect(r).toMatchObject({ kind: 'rejected', code: 'subagent-restricted', subcode: 'subagent-target-gone' })
  })
})

describe('必填字段按 action 校验', () => {
  it.each([
    ['create 缺 content', { action: 'create', name: 'n', type: 'project', scope: 'workspace', summary: 's' }, 'content'],
    ['create 缺 name、summary', { action: 'create', type: 'project', scope: 'workspace', content: 'c' }, 'name'],
    ['update 既没 content 也没 edits', { action: 'update', id: 'mem_t', name: 'n', type: 'project', scope: 'workspace', summary: 's' }, 'edits'],
  ])('%s：schema-invalid，原因点名缺的字段', async (_label, partial, field) => {
    const e = await seeded()
    const reason = await rejected(runSavePipeline({ sourceMode: 'user-explicit', ...partial } as SaveInput, e.deps), 'schema-invalid')
    expect(reason).toContain(field)
  })
})

describe('工具层', () => {
  function toolDeps(store: MemoryStore): SaveToolDeps {
    return { store, registry, snapshots: new SnapshotStore(new InMemoryKvTable<MemorySnapshot>()), host: { saveContextOf: async () => ({ workspacePath: WS, session }) }, globalUpdateGuided: new Map() }
  }

  it('executeSave：edits 不传 tags 时保留原标签（整条更新照旧按空数组处理）', async () => {
    const store = new MemoryStore(new InMemoryTable(), undefined, new InMemoryBatchKvTable())
    await store.put(target())
    const r = await executeSave({ action: 'update', id: 'mem_t', sourceMode: 'user-explicit', edits: [{ oldString: '端口 3000', newString: '端口 8080' }] }, fakeExec(), toolDeps(store))
    if (r.kind !== 'updated') throw new Error(r.kind)
    expect(r.record.tags).toEqual(['dev-server'])
  })

  it('参数表：edits 是对象数组（oldString、newString 必填，replaceAll 可选）；只有 action、sourceMode 必填', () => {
    const tool = createSaveTool(toolDeps(new MemoryStore(new InMemoryTable(), undefined, new InMemoryBatchKvTable())))
    const schema = tool.parameters as unknown as {
      required?: string[]
      properties: Record<string, { type?: string; description?: string; items?: { type: string; required?: string[]; properties: Record<string, { type: string }> } }>
    }
    expect([...(schema.required ?? [])].sort()).toEqual(['action', 'sourceMode'])
    const edits = schema.properties.edits!
    expect(edits.type).toBe('array')
    expect(edits.items).toMatchObject({ type: 'object', required: ['oldString', 'newString'] })
    expect(Object.keys(edits.items!.properties).sort()).toEqual(['newString', 'oldString', 'replaceAll'])
    expect(schema.properties.content!.description).toContain('edits')
  })

  it('保存说明交代：改几处用 edits，重写整条才传 content', () => {
    const description = registry.renderSaveDescription()
    expect(description).toContain('edits')
    expect(description).not.toContain('更新会替换整条正文')
  })
})
