import type { MemoryStore } from '../store.ts'
import type { SnapshotStore, SnapshotDiffEntry } from '../governance/snapshots.ts'
import type { MemoryRecord } from '../record-schema.ts'

export interface SnapshotToolDeps {
  store: MemoryStore
  snapshots: SnapshotStore
  now?: () => number
}

export type SnapshotToolArgs =
  | { action: 'create'; description?: string; memoryIds?: string[] }
  | { action: 'list' }
  | { action: 'show'; snapshotId: string }
  | { action: 'restore'; snapshotId: string; memoryIds?: string[]; overwriteChanged?: boolean }

export type SnapshotToolResult =
  | { kind: 'created'; snapshotId: string; count: number; message: string }
  | { kind: 'listed'; snapshots: Array<{ id: string; createdAt: number; operation: string; description: string; count: number }>; message: string }
  | { kind: 'shown'; entries: SnapshotDiffEntry[]; message: string }
  | { kind: 'restored'; restored: string[]; skipped: string[]; message: string }
  | { kind: 'error'; message: string }

/**
 * memory_snapshot（docs/p1-governance-health-design.md §6 恢复流程的工具面）：create 手动快照 / list 清单 /
 * show 对比 / restore 选择性恢复。restore 冲突保护：快照后被修改过的记录默认跳过。
 */
export async function executeSnapshotTool(
  rawArgs: unknown,
  deps: SnapshotToolDeps,
): Promise<SnapshotToolResult> {
  const args = rawArgs as SnapshotToolArgs
  const now = deps.now?.() ?? Date.now()
  await deps.snapshots.sweep(now)  // 任何动作都先清一遍超窗旧快照（list 入口也发生）

  if (args.action === 'create') {
    // 去重（与 memory_forget 的约定一致）：调用者传入重复 id 不应重复计入快照
    const uniqueIds = args.memoryIds ? [...new Set(args.memoryIds)] : undefined
    const records = uniqueIds
      ? uniqueIds
          .map(id => deps.store.get(id))
          .filter((r): r is MemoryRecord => r !== undefined && r.status !== 'deleted')
      : deps.store.query({ status: ['active'] })
    const snap = await deps.snapshots.capture({
      operation: 'manual',
      description: args.description ?? `手动快照（${records.length} 条）`,
      records,
    }, now)
    // 未找到或已删除的 id 不能悄悄丢掉——否则用户以为安全网覆盖了全部请求的记忆，
    // 实际只存了一部分
    const capturedIds = new Set(records.map(r => r.id))
    const missing = (uniqueIds ?? []).filter(id => !capturedIds.has(id))
    const missingNote = missing.length > 0 ? `；未找到或已删除：${missing.join('、')}` : ''
    return {
      kind: 'created', snapshotId: snap.id, count: records.length,
      message: `已创建快照 ${snap.id}（${records.length} 条记忆），14 天内可恢复${missingNote}。`,
    }
  }

  if (args.action === 'list') {
    const snapshots = deps.snapshots.list().map(s => ({
      id: s.id, createdAt: s.createdAt, operation: s.operation,
      description: s.description, count: s.memoryIds.length,
    }))
    return {
      kind: 'listed', snapshots,
      message: snapshots.length === 0
        ? '当前没有快照（保留窗口 14 天）。'
        : `共 ${snapshots.length} 个快照：\n${snapshots.map(s => `- ${s.id} [${s.operation}] ${s.description}（${s.count} 条）`).join('\n')}`,
    }
  }

  const snap = deps.snapshots.get(args.snapshotId)
  if (!snap) {
    return { kind: 'error', message: `快照不存在：${args.snapshotId}（可能已超过 14 天保留窗口）` }
  }

  if (args.action === 'show') {
    const entries = deps.snapshots.diff(snap, id => deps.store.get(id))
    const lines = entries.map(e => {
      const state = e.current === undefined ? '当前不存在（已删）'
        : e.current.status === 'deleted' ? '当前已软删'
        : e.changedAfterSnapshot ? '快照后被修改过 ⚠️' : '与快照一致或未变'
      return `- ${e.id}：${state}｜快照内容：${e.snapshotted.summary}`
    })
    return { kind: 'shown', entries, message: `快照 ${snap.id}（${snap.description}）：\n${lines.join('\n')}` }
  }

  // restore
  const { restored, skipped } = await deps.snapshots.restore(
    snap, args.memoryIds,
    r => deps.store.put(r),
    id => deps.store.get(id),
    args.overwriteChanged ?? false,
  )
  const skippedNote = skipped.length > 0
    ? `；${skipped.length} 条因快照后被修改而跳过（确认覆盖请带 overwriteChanged: true）`
    : ''
  return {
    kind: 'restored', restored, skipped,
    message: `已恢复 ${restored.length} 条记忆（${restored.join('、')}）${skippedNote}。`,
  }
}
