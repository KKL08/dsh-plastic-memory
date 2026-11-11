import { describe, expect, it } from 'vitest'
import { executeConfirm, type ConfirmToolDeps } from '../src/tools/confirm.ts'
import { MemoryStore } from '../src/store.ts'
import { PendingDecisionsStore } from '../src/governance/decisions.ts'
import { SnapshotStore } from '../src/governance/snapshots.ts'
import type { MemorySnapshot, PendingDecision } from '../src/governance/schema.ts'
import { record } from './helpers/record.ts'
import { FAKE_SECRET } from './helpers/secrets.ts'
import { InMemoryTable } from './helpers/in-memory-table.ts'
import { InMemoryKvTable, InMemoryBatchKvTable } from './helpers/in-memory-kv.ts'

function makeDeps(): ConfirmToolDeps {
  return {
    store: new MemoryStore(new InMemoryTable(), undefined, new InMemoryBatchKvTable()),
    decisions: new PendingDecisionsStore(new InMemoryKvTable<PendingDecision>()),
    snapshots: new SnapshotStore(new InMemoryKvTable<MemorySnapshot>()),
    now: () => 5000,
  }
}

describe('memory_confirm refresh', () => {
  it('刷新 lastConfirmedAt，不动 updatedAt（refresh 不是编辑，避免快照把它误判为编辑过）', async () => {
    const deps = makeDeps()
    await deps.store.put(record({ id: 'mem_a', lastConfirmedAt: 1, updatedAt: 1 }))
    const r = await executeConfirm({ action: 'refresh', memoryId: 'mem_a' }, { workspacePath: '/proj' }, deps)
    expect(r.kind).toBe('refreshed')
    expect((await deps.store.get('mem_a'))!.lastConfirmedAt).toBe(5000)
    expect((await deps.store.get('mem_a'))!.updatedAt).toBe(1)
  })

  it('目标不存在或已删除返回 error', async () => {
    const deps = makeDeps()
    await deps.store.put(record({ id: 'mem_dead', status: 'deleted' }))
    expect((await executeConfirm({ action: 'refresh', memoryId: 'mem_ghost' }, { workspacePath: '/proj' }, deps)).kind).toBe('error')
    expect((await executeConfirm({ action: 'refresh', memoryId: 'mem_dead' }, { workspacePath: '/proj' }, deps)).kind).toBe('error')
  })
})

describe('memory_confirm resolve（横向冲突）', () => {
  async function setupHorizontal(deps: ConfirmToolDeps) {
    await deps.store.put(record({ id: 'mem_left', content: '左' }))
    await deps.store.put(record({ id: 'mem_right', content: '右' }))
    const { entry } = await deps.decisions.upsert(
      { memoryIds: ['mem_left', 'mem_right'], summary: '矛盾' }, 1)
    return entry
  }

  it('keep-left：删 right，先快照，条目移出待处理', async () => {
    const deps = makeDeps()
    const entry = await setupHorizontal(deps)
    const r = await executeConfirm({ action: 'resolve', decisionId: entry.id, verdict: 'keep-left' }, { workspacePath: '/proj' }, deps)
    expect(r.kind).toBe('resolved')
    expect((await deps.store.get('mem_right'))!.status).toBe('deleted')
    expect((await deps.store.get('mem_left'))!.status).toBe('active')
    expect((await deps.snapshots.list())[0].operation).toBe('pre-resolve')
    expect((await deps.snapshots.list())[0].memoryIds).toEqual(['mem_right'])
    expect((await deps.snapshots.list())[0].data[0].status).toBe('active')
    expect(await deps.decisions.list()).toHaveLength(0)
  })

  it('同一待决项同时收到 keep-left 与 keep-right：只有一条裁决，只删一方；另一条报错、什么都不动', async () => {
    const deps = makeDeps()
    const entry = await setupHorizontal(deps)
    const results = await Promise.all((['keep-left', 'keep-right'] as const).map(verdict =>
      executeConfirm({ action: 'resolve', decisionId: entry.id, verdict }, { workspacePath: '/proj' }, deps)))
    expect(results.map(r => r.kind).sort()).toEqual(['error', 'resolved'])
    const deleted = [(await deps.store.get('mem_left'))!.status, (await deps.store.get('mem_right'))!.status].filter(s => s === 'deleted')
    expect(deleted).toHaveLength(1)
    expect(await deps.snapshots.list()).toHaveLength(1)
  })

  it('同一对冲突留有两条待决项、同时收到相反的裁决：只删一方，另一条报「正在处理」、什么都不动', async () => {
    const table = new InMemoryKvTable<PendingDecision>()
    const deps = { ...makeDeps(), decisions: new PendingDecisionsStore(table) }
    await deps.store.put(record({ id: 'mem_left', content: '左' }))
    await deps.store.put(record({ id: 'mem_right', content: '右' }))
    // 同一对的两条条目只能直接写进账本：现在的挂账已经不会建出第二条
    for (const id of ['pd_first', 'pd_second']) {
      await table.put(id, { id, memoryIds: ['mem_left', 'mem_right'], summary: '矛盾', firstSeenAt: 1 })
    }

    const results = await Promise.all([
      executeConfirm({ action: 'resolve', decisionId: 'pd_first', verdict: 'keep-left' }, { workspacePath: '/proj' }, deps),
      executeConfirm({ action: 'resolve', decisionId: 'pd_second', verdict: 'keep-right' }, { workspacePath: '/proj' }, deps),
    ])

    expect(results.map(r => r.kind).sort()).toEqual(['error', 'resolved'])
    expect(results.find(r => r.kind === 'error')).toMatchObject({ code: 'claimed' })
    const statuses = [(await deps.store.get('mem_left'))!.status, (await deps.store.get('mem_right'))!.status]
    expect(statuses.filter(s => s === 'deleted')).toHaveLength(1)
    expect(await deps.snapshots.list()).toHaveLength(1)
  })

  it('同一对冲突留有两条待决项：不删记忆的裁决不受另一条正在裁决的影响', async () => {
    const table = new InMemoryKvTable<PendingDecision>()
    const deps = { ...makeDeps(), decisions: new PendingDecisionsStore(table) }
    await deps.store.put(record({ id: 'mem_left', content: '左' }))
    await deps.store.put(record({ id: 'mem_right', content: '右' }))
    for (const id of ['pd_first', 'pd_second']) {
      await table.put(id, { id, memoryIds: ['mem_left', 'mem_right'], summary: '矛盾', firstSeenAt: 1 })
    }

    const results = await Promise.all([
      executeConfirm({ action: 'resolve', decisionId: 'pd_first', verdict: 'keep-left' }, { workspacePath: '/proj' }, deps),
      executeConfirm({ action: 'resolve', decisionId: 'pd_second', verdict: 'keep-both' }, { workspacePath: '/proj' }, deps),
    ])

    expect(results.map(r => r.kind)).toEqual(['resolved', 'resolved'])
    expect((await deps.store.get('mem_left'))!.status).toBe('active')
    expect((await deps.store.get('mem_right'))!.status).toBe('deleted')
  })

  it('删除败方时顺带清理其他引用该记忆的待决项，并在 actions 中报告数量', async () => {
    const deps = makeDeps()
    await deps.store.put(record({ id: 'mem_left' }))
    await deps.store.put(record({ id: 'mem_right' }))
    await deps.store.put(record({ id: 'mem_other' }))
    const { entry } = await deps.decisions.upsert(
      { memoryIds: ['mem_left', 'mem_right'], summary: '待裁决' }, 1)
    // mem_right 还牵涉在另一条无关冲突里；它被删后那条冲突无法再裁决
    await deps.decisions.upsert({ memoryIds: ['mem_right', 'mem_other'], summary: '另一条' }, 2)

    const r = await executeConfirm({ action: 'resolve', decisionId: entry.id, verdict: 'keep-left' }, { workspacePath: '/proj' }, deps)
    expect(r.kind).toBe('resolved')
    if (r.kind === 'resolved') {
      expect(r.alsoCleared).toBe(1)
    }
    expect(await deps.decisions.list()).toHaveLength(0)
  })

  it('PA-11 败方含密钥：物理删除，结果写明已物理删除、请轮换凭证；快照里没有明文，条目移出账本', async () => {
    const deps = makeDeps()
    await deps.store.put(record({ id: 'mem_left', content: '左' }))
    await deps.store.put(record({ id: 'mem_right', content: `右 ${FAKE_SECRET.sk}` }))
    const { entry } = await deps.decisions.upsert({ memoryIds: ['mem_left', 'mem_right'], summary: '矛盾' }, 1)

    const r = await executeConfirm({ action: 'resolve', decisionId: entry.id, verdict: 'keep-left' }, { workspacePath: '/proj' }, deps)

    if (r.kind !== 'resolved') throw new Error(r.message)
    expect(r.isHardDeleted).toBe(true)
    expect(r.message).toContain('物理删除')
    expect(r.message).toContain('轮换')
    expect(await deps.store.get('mem_right')).toBeUndefined()
    expect((await deps.store.get('mem_left'))!.status).toBe('active')
    expect(await deps.decisions.get(entry.id)).toBeUndefined()
    expect(await deps.decisions.listSettled()).toEqual([])
    expect(JSON.stringify(await deps.snapshots.list())).not.toContain(FAKE_SECRET.sk)
  })

  it('keep-right：删 left', async () => {
    const deps = makeDeps()
    const entry = await setupHorizontal(deps)
    await executeConfirm({ action: 'resolve', decisionId: entry.id, verdict: 'keep-right' }, { workspacePath: '/proj' }, deps)
    expect((await deps.store.get('mem_left'))!.status).toBe('deleted')
    expect((await deps.store.get('mem_right'))!.status).toBe('active')
  })

  for (const status of ['deleted', 'superseded'] as const) {
    it(`保留方已不在用（${status}）：拒绝裁决，不删败方、不拍快照，条目留在账本里`, async () => {
      const deps = makeDeps()
      const entry = await setupHorizontal(deps)
      // 挂账之后保留方被别处删掉或取代了（另一条同一对的裁决、遗忘、替代）
      await deps.store.put(record({ id: 'mem_left', content: '左', status }))

      const r = await executeConfirm({ action: 'resolve', decisionId: entry.id, verdict: 'keep-left' }, { workspacePath: '/proj' }, deps)

      expect(r.kind).toBe('error')
      expect(r.message).toContain('mem_left')
      expect((await deps.store.get('mem_right'))!.status).toBe('active')
      expect(await deps.snapshots.list()).toHaveLength(0)
      expect((await deps.decisions.list()).map(e => e.id)).toEqual([entry.id])
    })
  }

  it('keep-both / dismiss：不删任何记忆、不写快照、条目移除', async () => {
    for (const verdict of ['keep-both', 'dismiss'] as const) {
      const deps = makeDeps()
      const entry = await setupHorizontal(deps)
      const r = await executeConfirm({ action: 'resolve', decisionId: entry.id, verdict }, { workspacePath: '/proj' }, deps)
      expect(r.kind).toBe('resolved')
      expect((await deps.store.get('mem_left'))!.status).toBe('active')
      expect((await deps.store.get('mem_right'))!.status).toBe('active')
      expect(await deps.snapshots.list()).toHaveLength(0)
      expect(await deps.decisions.list()).toHaveLength(0)
    }
  })
})

describe('memory_confirm resolve（账本里的非法条目）', () => {
  it('横向条目两个 id 相同：拒绝裁决、不删记忆、不拍快照，并把该条目清出账本', async () => {
    const deps = makeDeps()
    await deps.store.put(record({ id: 'mem_c', content: '唯一一条' }))
    const { entry } = await deps.decisions.upsert({ memoryIds: ['mem_c', 'mem_c'], summary: '自冲突' }, 1)
    const r = await executeConfirm({ action: 'resolve', decisionId: entry.id, verdict: 'keep-left' }, { workspacePath: '/proj' }, deps)
    expect(r.kind).toBe('error')
    expect((await deps.store.get('mem_c'))!.status).toBe('active')
    expect(await deps.snapshots.list()).toHaveLength(0)
    expect(await deps.decisions.list()).toHaveLength(0)
  })

  it('横向条目只有一个 id（无 baselineRef）：同样拒绝并清理', async () => {
    const deps = makeDeps()
    await deps.store.put(record({ id: 'mem_only' }))
    const { entry } = await deps.decisions.upsert({ memoryIds: ['mem_only'], summary: '缺一方' }, 1)
    const r = await executeConfirm({ action: 'resolve', decisionId: entry.id, verdict: 'keep-right' }, { workspacePath: '/proj' }, deps)
    expect(r.kind).toBe('error')
    expect((await deps.store.get('mem_only'))!.status).toBe('active')
    expect(await deps.decisions.list()).toHaveLength(0)
  })
})

describe('memory_confirm resolve（垂直冲突）', () => {
  async function setupVertical(deps: ConfirmToolDeps) {
    await deps.store.put(record({ id: 'mem_v', content: '与基线矛盾的记忆' }))
    const { entry } = await deps.decisions.upsert(
      { memoryIds: ['mem_v'], baselineRef: 'AGENTS.md：包管理', summary: '与基线矛盾' }, 1)
    return entry
  }

  it('keep-left：保留记忆（用户明确 override 基线），仅移除条目', async () => {
    const deps = makeDeps()
    const entry = await setupVertical(deps)
    const r = await executeConfirm({ action: 'resolve', decisionId: entry.id, verdict: 'keep-left' }, { workspacePath: '/proj' }, deps)
    expect(r.kind).toBe('resolved')
    expect((await deps.store.get('mem_v'))!.status).toBe('active')
    expect(await deps.snapshots.list()).toHaveLength(0)
    expect(await deps.decisions.list()).toHaveLength(0)
  })

  it('keep-right：基线胜，删记忆（先快照）', async () => {
    const deps = makeDeps()
    const entry = await setupVertical(deps)
    await executeConfirm({ action: 'resolve', decisionId: entry.id, verdict: 'keep-right' }, { workspacePath: '/proj' }, deps)
    expect((await deps.store.get('mem_v'))!.status).toBe('deleted')
    expect((await deps.snapshots.list())[0].memoryIds).toEqual(['mem_v'])
  })
})

describe('memory_confirm resolve 边界', () => {
  it('decisionId 不存在返回 error', async () => {
    const deps = makeDeps()
    const r = await executeConfirm({ action: 'resolve', decisionId: 'pd_ghost', verdict: 'dismiss' }, { workspacePath: '/proj' }, deps)
    expect(r.kind === 'error' && r.code).toBe('not-found')
  })
})
