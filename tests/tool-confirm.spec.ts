import { describe, expect, it } from 'vitest'
import { executeConfirm, type ConfirmToolDeps } from '../src/tools/confirm.ts'
import { MemoryStore, InMemoryTable } from '../src/store.ts'
import { PendingDecisionsStore } from '../src/governance/decisions.ts'
import { SnapshotStore } from '../src/governance/snapshots.ts'
import { InMemoryKvTable } from '../src/kv-table.ts'
import type { MemorySnapshot, PendingDecision } from '../src/governance/schema.ts'
import { record } from './helpers/record.ts'

function makeDeps(): ConfirmToolDeps {
  return {
    store: new MemoryStore(new InMemoryTable()),
    decisions: new PendingDecisionsStore(new InMemoryKvTable<PendingDecision>()),
    snapshots: new SnapshotStore(new InMemoryKvTable<MemorySnapshot>()),
    now: () => 5000,
  }
}

describe('memory_confirm refresh', () => {
  it('刷新 lastConfirmedAt，不动 updatedAt（refresh 不是编辑，避免快照把它误判为编辑过）', async () => {
    const deps = makeDeps()
    await deps.store.put(record({ id: 'mem_a', lastConfirmedAt: 1, updatedAt: 1 }))
    const r = await executeConfirm({ action: 'refresh', memoryId: 'mem_a' }, deps)
    expect(r.kind).toBe('refreshed')
    expect(deps.store.get('mem_a')!.lastConfirmedAt).toBe(5000)
    expect(deps.store.get('mem_a')!.updatedAt).toBe(1)
  })

  it('目标不存在或已删除返回 error', async () => {
    const deps = makeDeps()
    await deps.store.put(record({ id: 'mem_dead', status: 'deleted' }))
    expect((await executeConfirm({ action: 'refresh', memoryId: 'mem_ghost' }, deps)).kind).toBe('error')
    expect((await executeConfirm({ action: 'refresh', memoryId: 'mem_dead' }, deps)).kind).toBe('error')
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

  it('keep-left：删 right，先快照，条目移除', async () => {
    const deps = makeDeps()
    const entry = await setupHorizontal(deps)
    const r = await executeConfirm({ action: 'resolve', decisionId: entry.id, verdict: 'keep-left' }, deps)
    expect(r.kind).toBe('resolved')
    expect(deps.store.get('mem_right')!.status).toBe('deleted')
    expect(deps.store.get('mem_left')!.status).toBe('active')
    expect(deps.snapshots.list()[0].operation).toBe('pre-resolve')
    expect(deps.snapshots.list()[0].memoryIds).toEqual(['mem_right'])
    expect(deps.snapshots.list()[0].data[0].status).toBe('active')
    expect(deps.decisions.list()).toHaveLength(0)
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

    const r = await executeConfirm({ action: 'resolve', decisionId: entry.id, verdict: 'keep-left' }, deps)
    expect(r.kind).toBe('resolved')
    if (r.kind === 'resolved') {
      expect(r.alsoCleared).toBe(1)
    }
    expect(deps.decisions.list()).toHaveLength(0)
  })

  it('keep-right：删 left', async () => {
    const deps = makeDeps()
    const entry = await setupHorizontal(deps)
    await executeConfirm({ action: 'resolve', decisionId: entry.id, verdict: 'keep-right' }, deps)
    expect(deps.store.get('mem_left')!.status).toBe('deleted')
    expect(deps.store.get('mem_right')!.status).toBe('active')
  })

  it('keep-both / dismiss：不删任何记忆、不写快照、条目移除', async () => {
    for (const verdict of ['keep-both', 'dismiss'] as const) {
      const deps = makeDeps()
      const entry = await setupHorizontal(deps)
      const r = await executeConfirm({ action: 'resolve', decisionId: entry.id, verdict }, deps)
      expect(r.kind).toBe('resolved')
      expect(deps.store.get('mem_left')!.status).toBe('active')
      expect(deps.store.get('mem_right')!.status).toBe('active')
      expect(deps.snapshots.list()).toHaveLength(0)
      expect(deps.decisions.list()).toHaveLength(0)
    }
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
    const r = await executeConfirm({ action: 'resolve', decisionId: entry.id, verdict: 'keep-left' }, deps)
    expect(r.kind).toBe('resolved')
    expect(deps.store.get('mem_v')!.status).toBe('active')
    expect(deps.snapshots.list()).toHaveLength(0)
    expect(deps.decisions.list()).toHaveLength(0)
  })

  it('keep-right：基线胜，删记忆（先快照）', async () => {
    const deps = makeDeps()
    const entry = await setupVertical(deps)
    await executeConfirm({ action: 'resolve', decisionId: entry.id, verdict: 'keep-right' }, deps)
    expect(deps.store.get('mem_v')!.status).toBe('deleted')
    expect(deps.snapshots.list()[0].memoryIds).toEqual(['mem_v'])
  })
})

describe('memory_confirm resolve 边界', () => {
  it('decisionId 不存在返回 error', async () => {
    const deps = makeDeps()
    const r = await executeConfirm({ action: 'resolve', decisionId: 'pd_ghost', verdict: 'dismiss' }, deps)
    expect(r.kind).toBe('error')
  })
})
