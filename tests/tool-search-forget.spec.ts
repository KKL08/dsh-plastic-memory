import { describe, expect, it } from 'vitest'
import { executeSearch, type SearchToolDeps } from '../src/tools/search.ts'
import { executeForget } from '../src/tools/forget.ts'
import { MemoryStore, InMemoryTable } from '../src/store.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'
import { runSavePipeline } from '../src/pipeline.ts'
import { PendingDecisionsStore } from '../src/governance/decisions.ts'
import { SnapshotStore } from '../src/governance/snapshots.ts'
import { InMemoryKvTable } from '../src/kv-table.ts'
import type { MemorySnapshot, PendingDecision } from '../src/governance/schema.ts'
import { record } from './helpers/record.ts'
import { STALENESS_NOTE } from '../src/record-freshness.ts'

const registry = buildTypeRegistry({ template: 'coding', customTypes: {} })
const session = { id: 's1', lastSeq: 1 }

function makeForgetDeps(store: MemoryStore) {
  const snapshots = new SnapshotStore(new InMemoryKvTable<MemorySnapshot>())
  const decisions = new PendingDecisionsStore(new InMemoryKvTable<PendingDecision>())
  return { store, snapshots, decisions, now: () => 1000 }
}

async function seed(store: MemoryStore, content: string, confidence = 0.9) {
  const r = await runSavePipeline({
    action: 'create', name: content.slice(0, 6), type: 'knowledge', scope: 'workspace',
    content, summary: content.slice(0, 10),
    tags: [], sourceMode: 'user-explicit', confidence, force: true,
  }, { store, registry, workspacePath: '/proj', session })
  if (r.kind !== 'saved') throw new Error(r.kind)
  return r.record
}

function makeSearchDeps(store: MemoryStore): SearchToolDeps {
  return {
    store,
    registry,
    resolveContext: async () => ({ workspacePath: '/proj', session }),
  }
}

describe('executeSearch', () => {
  it('按 confidence 降序排序并截断 limit', async () => {
    const store = new MemoryStore(new InMemoryTable())
    await seed(store, '低置信条目', 0.5)
    const high = await seed(store, '高置信条目', 0.9)
    const result = await executeSearch({ query: '条目', limit: 1 }, {} as never, makeSearchDeps(store))
    expect(result.hits).toHaveLength(1)
    expect(result.hits[0].id).toBe(high.id)
  })

  it('命中后更新召回统计', async () => {
    const store = new MemoryStore(new InMemoryTable())
    const r = await seed(store, '某个知识')
    await executeSearch({ query: '知识' }, {} as never, makeSearchDeps(store))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(store.get(r.id)!.recallCount).toBe(1)
  })

  it('超过衰减期未确认的命中带陈旧度标注', async () => {
    const store = new MemoryStore(new InMemoryTable())
    const r = await seed(store, '老知识')
    await store.put({ ...store.get(r.id)!, lastConfirmedAt: Date.now() - 100 * 86_400_000 }) // knowledge 衰减 90 天
    const result = await executeSearch({ query: '老知识' }, {} as never, makeSearchDeps(store))
    expect(result.hits[0].stalenessNote).toBe(STALENESS_NOTE(100))
  })
})

describe('executeForget（P1 批量版）', () => {
  it('单条遗忘：先快照后软删', async () => {
    const store = new MemoryStore(new InMemoryTable())
    await store.put(record({ id: 'mem_a', content: '要删的' }))
    const deps = makeForgetDeps(store)
    const result = await executeForget({ ids: ['mem_a'], reason: '用户要求' }, deps)
    expect(result.ok).toBe(true)
    expect(result.forgotten).toEqual(['mem_a'])
    expect(store.get('mem_a')!.status).toBe('deleted')
    const snaps = deps.snapshots.list()
    expect(snaps).toHaveLength(1)
    expect(snaps[0].operation).toBe('pre-forget')
    expect(snaps[0].data[0].content).toBe('要删的')
    expect(snaps[0].data[0].status).toBe('active') // 快照存的是删除前的状态
    expect(result.snapshotId).toBe(snaps[0].id)
  })

  it('批量遗忘：一个快照包含全部受影响记忆', async () => {
    const store = new MemoryStore(new InMemoryTable())
    await store.put(record({ id: 'mem_a' }))
    await store.put(record({ id: 'mem_b' }))
    const deps = makeForgetDeps(store)
    const result = await executeForget({ ids: ['mem_a', 'mem_b'], reason: 'scan 清理' }, deps)
    expect(result.forgotten.sort()).toEqual(['mem_a', 'mem_b'])
    expect(deps.snapshots.list()).toHaveLength(1)
    expect(deps.snapshots.list()[0].memoryIds.sort()).toEqual(['mem_a', 'mem_b'])
  })

  it('部分命中：找不到/已删除的进 missing，找到的正常删', async () => {
    const store = new MemoryStore(new InMemoryTable())
    await store.put(record({ id: 'mem_a' }))
    await store.put(record({ id: 'mem_gone', status: 'deleted' }))
    const deps = makeForgetDeps(store)
    const result = await executeForget({ ids: ['mem_a', 'mem_gone', 'mem_ghost'], reason: 'r' }, deps)
    expect(result.forgotten).toEqual(['mem_a'])
    expect(result.missing.sort()).toEqual(['mem_ghost', 'mem_gone'])
    expect(result.ok).toBe(true)
  })

  it('全部未命中：不写快照，ok=false', async () => {
    const store = new MemoryStore(new InMemoryTable())
    const deps = makeForgetDeps(store)
    const result = await executeForget({ ids: ['mem_ghost'], reason: 'r' }, deps)
    expect(result.ok).toBe(false)
    expect(result.snapshotId).toBeNull()
    expect(deps.snapshots.list()).toHaveLength(0)
  })

  it('遗忘后清理引用被删记忆的 pending-decisions 条目', async () => {
    const store = new MemoryStore(new InMemoryTable())
    await store.put(record({ id: 'mem_a' }))
    const deps = makeForgetDeps(store)
    await deps.decisions.upsert({ memoryIds: ['mem_a', 'mem_b'], summary: '冲突' }, 1)
    await deps.decisions.upsert({ memoryIds: ['mem_x', 'mem_y'], summary: '无关' }, 2)
    await executeForget({ ids: ['mem_a'], reason: 'r' }, deps)
    expect(deps.decisions.list().map(e => e.summary)).toEqual(['无关'])
  })

  it('重复 id 只当一条处理：快照不重复存、计数不虚报', async () => {
    const store = new MemoryStore(new InMemoryTable())
    await store.put(record({ id: 'mem_a' }))
    await store.put(record({ id: 'mem_b' }))
    const deps = makeForgetDeps(store)
    const result = await executeForget({ ids: ['mem_a', 'mem_a', 'mem_b'], reason: 'r' }, deps)
    expect(result.forgotten.sort()).toEqual(['mem_a', 'mem_b'])
    const snap = deps.snapshots.list()[0]
    expect(snap.memoryIds.sort()).toEqual(['mem_a', 'mem_b'])
    expect(snap.data).toHaveLength(2)
  })
})
