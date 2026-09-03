import type { MemoryStore } from '../store.ts'
import type { PendingDecisionsStore } from '../governance/decisions.ts'
import type { SnapshotStore } from '../governance/snapshots.ts'
import type { MemoryRecord } from '../record-schema.ts'

export interface ConfirmToolDeps {
  store: MemoryStore
  decisions: PendingDecisionsStore
  snapshots: SnapshotStore
  now?: () => number
}

export type ConfirmArgs =
  | { action: 'refresh'; memoryId: string }
  | { action: 'resolve'; decisionId: string; verdict: 'keep-left' | 'keep-right' | 'keep-both' | 'dismiss' }

export type ConfirmResult =
  | { kind: 'refreshed'; memoryId: string; lastConfirmedAt: number; message: string }
  | { kind: 'resolved'; decisionId: string; verdict: string; actions: string[]; alsoCleared: number; message: string }
  | { kind: 'error'; message: string }

/**
 * memory_confirm（docs/p1-governance-health-design.md §7.1）：refresh 刷新新鲜度；resolve 裁决待决冲突。
 * verdict 约定：横向冲突 left=memoryIds[0]、right=memoryIds[1]；
 * 垂直冲突（有 baselineRef）left=记忆、right=基线（基线不可删，keep-right 意为记忆过时删除）。
 */
export async function executeConfirm(
  rawArgs: unknown,
  deps: ConfirmToolDeps,
): Promise<ConfirmResult> {
  const args = rawArgs as ConfirmArgs
  const now = deps.now?.() ?? Date.now()

  if (args.action === 'refresh') {
    const target = deps.store.get(args.memoryId)
    if (!target || target.status === 'deleted') {
      return { kind: 'error', message: `记忆不存在或已删除：${args.memoryId}` }
    }
    // refresh 不是内容编辑，写 updatedAt 会让快照把它误判为"快照后被编辑过"而拒绝恢复
    // （isConflicting 读 updatedAt 判断编辑冲突），lastConfirmedAt 已足够独立记录确认动作。
    await deps.store.put({ ...target, lastConfirmedAt: now })
    return {
      kind: 'refreshed', memoryId: args.memoryId, lastConfirmedAt: now,
      message: `已确认记忆 ${args.memoryId} 仍然准确，新鲜度已刷新。`,
    }
  }

  const entry = deps.decisions.get(args.decisionId)
  if (!entry) {
    return { kind: 'error', message: `待决项不存在：${args.decisionId}（可能已被裁决或涉及的记忆已删除）` }
  }

  const actions: string[] = []
  let alsoCleared = 0
  const vertical = entry.baselineRef !== undefined

  // 需要删除的记忆（keep-left/keep-right 的败方）；keep-both/dismiss 无删除
  let toDelete: MemoryRecord | undefined
  if (vertical) {
    // 垂直：left=记忆 right=基线。keep-right = 基线胜，记忆删除
    if (args.verdict === 'keep-right') toDelete = deps.store.get(entry.memoryIds[0])
    if (args.verdict === 'keep-left') actions.push(`保留记忆 ${entry.memoryIds[0]}（用户确认 override ${entry.baselineRef}）`)
  } else {
    if (args.verdict === 'keep-left') toDelete = deps.store.get(entry.memoryIds[1])
    if (args.verdict === 'keep-right') toDelete = deps.store.get(entry.memoryIds[0])
  }

  if (toDelete && toDelete.status !== 'deleted') {
    // 快照先行（docs/p1-governance-health-design.md §6），再软删
    const snapshot = await deps.snapshots.capture({
      operation: 'pre-resolve',
      description: `裁决冲突 ${entry.id}（${args.verdict}）删除败方前`,
      records: [toDelete],
    }, now)
    await deps.store.softDelete(toDelete.id)
    actions.push(`已删除败方记忆 ${toDelete.id}（快照 ${snapshot.id}）`)
    // 先移除当前条目，这样 removeByMemoryIds 的返回值就只统计"额外"清理的条目
    await deps.decisions.remove(entry.id)
    // 该记忆的一方已被删除，可能还挂在其他待决项上——这些冲突已无法再裁决，一并清理
    // 但不能悄悄发生：把清理数量报进 actions，让用户知道有条目被顺带处理
    alsoCleared = await deps.decisions.removeByMemoryIds([toDelete.id])
    if (alsoCleared > 0) {
      actions.push(`另清理 ${alsoCleared} 条同样引用该记忆的待决冲突（其一方已删除，无法再裁决）`)
    }
  } else {
    if (args.verdict === 'keep-both') actions.push('两条并存（用户确认不冲突）')
    if (args.verdict === 'dismiss') actions.push('标记为误报')
    await deps.decisions.remove(entry.id)
  }

  return {
    kind: 'resolved', decisionId: entry.id, verdict: args.verdict, actions, alsoCleared,
    message: `冲突已裁决（${args.verdict}）：${actions.join('；')}`,
  }
}
