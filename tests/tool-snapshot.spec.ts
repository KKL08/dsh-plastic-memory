import { describe, expect, it } from 'vitest'
import { executeSnapshotTool, type SnapshotToolDeps } from '../src/tools/snapshot.ts'
import { executeForget } from '../src/tools/forget.ts'
import { MemoryStore, InMemoryTable } from '../src/store.ts'
import { SnapshotStore, SNAPSHOT_RETENTION_MS } from '../src/governance/snapshots.ts'
import { PendingDecisionsStore } from '../src/governance/decisions.ts'
import { InMemoryKvTable } from '../src/kv-table.ts'
import type { MemorySnapshot } from '../src/governance/schema.ts'
import type { PendingDecision } from '../src/governance/schema.ts'
import { record } from './helpers/record.ts'

function makeDeps(now = 1000): SnapshotToolDeps {
  return {
    store: new MemoryStore(new InMemoryTable()),
    snapshots: new SnapshotStore(new InMemoryKvTable<MemorySnapshot>()),
    now: () => now,
  }
}

describe('memory_snapshot', () => {
  it('create：手动快照默认覆盖全部 active/stale 记忆', async () => {
    const deps = makeDeps()
    await deps.store.put(record({ id: 'mem_a' }))
    await deps.store.put(record({ id: 'mem_dead', status: 'deleted' }))
    const r = await executeSnapshotTool({ action: 'create', description: '大清理前' }, deps)
    expect(r.kind).toBe('created')
    const snap = deps.snapshots.list()[0]
    expect(snap.operation).toBe('manual')
    expect(snap.memoryIds).toEqual(['mem_a'])
  })

  it('create 可指定 memoryIds', async () => {
    const deps = makeDeps()
    await deps.store.put(record({ id: 'mem_a' }))
    await deps.store.put(record({ id: 'mem_b' }))
    await executeSnapshotTool({ action: 'create', memoryIds: ['mem_b'] }, deps)
    expect(deps.snapshots.list()[0].memoryIds).toEqual(['mem_b'])
  })

  it('create：重复 id 去重，未找到/已删除的 id 在返回消息里报告，不悄悄丢弃', async () => {
    const deps = makeDeps()
    await deps.store.put(record({ id: 'mem_a' }))
    await deps.store.put(record({ id: 'mem_dead', status: 'deleted' }))
    const r = await executeSnapshotTool(
      { action: 'create', memoryIds: ['mem_a', 'mem_a', 'mem_typo', 'mem_dead'] }, deps)
    expect(r.kind).toBe('created')
    if (r.kind === 'created') {
      expect(r.count).toBe(1)
      expect(deps.snapshots.list()[0].memoryIds).toEqual(['mem_a'])
      expect(r.missing).toEqual(['mem_typo', 'mem_dead'])
    }
  })

  it('list：返回快照清单（倒序）', async () => {
    const deps = makeDeps()
    await deps.snapshots.capture({ operation: 'manual', description: '早', records: [] }, 100)
    await deps.snapshots.capture({ operation: 'pre-forget', description: '晚', records: [] }, 200)
    const r = await executeSnapshotTool({ action: 'list' }, deps)
    expect(r.kind).toBe('listed')
    if (r.kind === 'listed') {
      expect(r.snapshots.map(s => s.description)).toEqual(['晚', '早'])
    }
  })

  it('show：给出 diff（含 changedAfterSnapshot 标记）', async () => {
    const deps = makeDeps()
    const original = record({ id: 'mem_a', content: '原文', updatedAt: 50 })
    const snap = await deps.snapshots.capture({ operation: 'pre-forget', description: 'd', records: [original] }, 100)
    await deps.store.put(record({ id: 'mem_a', content: '改过', updatedAt: 150 }))
    const r = await executeSnapshotTool({ action: 'show', snapshotId: snap.id }, deps)
    expect(r.kind).toBe('shown')
    if (r.kind === 'shown') {
      expect(r.entries[0].changedAfterSnapshot).toBe(true)
    }
  })

  it('restore：写回旧数据，冲突默认跳过', async () => {
    const deps = makeDeps()
    const original = record({ id: 'mem_a', content: '原文', updatedAt: 50 })
    const snap = await deps.snapshots.capture({ operation: 'pre-forget', description: 'd', records: [original] }, 100)
    // 记录完全不存在（非 forget 场景的软删，而是彻底不在库里）：直接恢复
    const r = await executeSnapshotTool({ action: 'restore', snapshotId: snap.id }, deps)
    expect(r.kind).toBe('restored')
    expect(deps.store.get('mem_a')!.content).toBe('原文')
  })

  it('forget 之后 restore 能把记忆原样救回（撤销误删的核心路径）', async () => {
    const store = new MemoryStore(new InMemoryTable())
    await store.put(record({ id: 'mem_a', content: '不该被删的内容' }))
    const snapshots = new SnapshotStore(new InMemoryKvTable<MemorySnapshot>())
    const decisions = new PendingDecisionsStore(new InMemoryKvTable<PendingDecision>())

    const forgot = await executeForget({ ids: ['mem_a'], reason: '误删' }, { store, snapshots, decisions })
    expect(forgot.ok).toBe(true)
    expect(store.get('mem_a')!.status).toBe('deleted')

    const r = await executeSnapshotTool(
      { action: 'restore', snapshotId: forgot.snapshotId! },
      { store, snapshots },
    )
    expect(r.kind).toBe('restored')
    if (r.kind === 'restored') {
      expect(r.restored).toEqual(['mem_a'])
      expect(r.skipped).toEqual([])
    }
    const revived = store.get('mem_a')!
    expect(revived.status).toBe('active')
    expect(revived.content).toBe('不该被删的内容')
  })

  it('list 入口也清扫超窗旧快照：只造超窗快照后 list 返回空且表被清', async () => {
    const deps = makeDeps(SNAPSHOT_RETENTION_MS + 1)  // 工具入口以此 now 清扫
    await deps.snapshots.capture({ operation: 'manual', description: '超窗', records: [] }, 0)
    const r = await executeSnapshotTool({ action: 'list' }, deps)
    expect(r.kind).toBe('listed')
    if (r.kind === 'listed') expect(r.snapshots).toEqual([])
    expect(deps.snapshots.list()).toEqual([])  // KV 表已被清
  })

  it('snapshotId 不存在返回 error', async () => {
    const deps = makeDeps()
    expect((await executeSnapshotTool({ action: 'show', snapshotId: 'snap_ghost' }, deps)).kind).toBe('error')
    expect((await executeSnapshotTool({ action: 'restore', snapshotId: 'snap_ghost' }, deps)).kind).toBe('error')
  })

  it('restore 默认跳过快照后被真正编辑过的记录，overwriteChanged 才覆盖', async () => {
    const deps = makeDeps()
    const original = record({ id: 'mem_a', content: '快照时的内容', updatedAt: 50 })
    const snap = await deps.snapshots.capture(
      { operation: 'manual', description: 'd', records: [original] }, 100)
    // 快照之后用户又改了这条：它是"更新的编辑"，不是软删除，必须受保护
    await deps.store.put(record({ id: 'mem_a', content: '后来改过的内容', updatedAt: 150 }))

    const skipped = await executeSnapshotTool({ action: 'restore', snapshotId: snap.id }, deps)
    expect(skipped.kind).toBe('restored')
    if (skipped.kind === 'restored') {
      expect(skipped.restored).toEqual([])
      expect(skipped.skipped).toEqual(['mem_a'])
      expect(skipped.message).toContain('overwriteChanged')
    }
    // 关键：默认路径下更新的编辑必须原样保住
    expect(deps.store.get('mem_a')!.content).toBe('后来改过的内容')

    const forced = await executeSnapshotTool(
      { action: 'restore', snapshotId: snap.id, overwriteChanged: true }, deps)
    expect(forced.kind).toBe('restored')
    if (forced.kind === 'restored') {
      expect(forced.restored).toEqual(['mem_a'])
      expect(forced.skipped).toEqual([])
    }
    expect(deps.store.get('mem_a')!.content).toBe('快照时的内容')
  })
})
