import type { MemoryStore } from '../store.ts'
import type { PendingDecisionsStore } from '../governance/decisions.ts'
import type { SnapshotStore } from '../governance/snapshots.ts'
import type { MemoryRecord } from '../record-schema.ts'
import type { GovernanceRejectCode } from '../contract-codes.ts'
import { crossWorkspaceNote, gateRecords, type CrossWorkspaceRejection, type GovernanceContext, type OtherWorkspaceMark } from './workspace-gate.ts'

export interface ConfirmToolDeps {
  store: MemoryStore
  decisions: PendingDecisionsStore
  snapshots: SnapshotStore
  now?: () => number
}

/** allowCrossWorkspace：用户明确选择「全局整理」时才为 true，放行其他项目的记录（见 workspace-gate.ts）。 */
export type ConfirmArgs =
  | { action: 'refresh'; memoryId: string; allowCrossWorkspace?: boolean }
  | { action: 'resolve'; decisionId: string; verdict: 'keep-left' | 'keep-right' | 'keep-both' | 'dismiss'; allowCrossWorkspace?: boolean }

/** otherWorkspaces：带参数放行、属于其他项目的记录；error 带 code 时 rejected 列出被拒记录。 */
export type ConfirmResult =
  | { kind: 'refreshed'; memoryId: string; lastConfirmedAt: number; otherWorkspaces: OtherWorkspaceMark[]; message: string }
  | { kind: 'resolved'; decisionId: string; verdict: string; actions: string[]; alsoCleared: number; otherWorkspaces: OtherWorkspaceMark[]; message: string }
  | { kind: 'error'; code?: GovernanceRejectCode; rejected?: CrossWorkspaceRejection[]; message: string }

/**
 * memory_confirm（docs/p1-governance-health-design.md §7.1）：refresh 刷新新鲜度；resolve 裁决待决冲突。
 * verdict 约定：横向冲突 left=memoryIds[0]、right=memoryIds[1]；
 * 垂直冲突（有 baselineRef）left=记忆、right=基线（基线不可删，keep-right 意为记忆过时删除）。
 */
export async function executeConfirm(
  rawArgs: unknown,
  context: GovernanceContext,
  deps: ConfirmToolDeps,
): Promise<ConfirmResult> {
  const args = rawArgs as ConfirmArgs
  const now = deps.now?.() ?? Date.now()
  // 预读范围：按 id 两级定位单条记录（含非 active，当前 workspace 优先，由下方逐处判 deleted）与账本单条目，不预读整层
  const locate = (id: string) => deps.store.get(id, { workspacePath: context.workspacePath })

  if (args.action === 'refresh') {
    const target = await locate(args.memoryId)
    if (!target || target.status === 'deleted') {
      return { kind: 'error', message: `记忆不存在或已删除：${args.memoryId}` }
    }
    const { rejected, otherWorkspaces } = gateRecords([target], context, args.allowCrossWorkspace)
    if (rejected.length > 0) {
      return { kind: 'error', code: 'cross-workspace', rejected, message: `未刷新记忆 ${args.memoryId}。${crossWorkspaceNote(rejected, [])}` }
    }
    // refresh 不是内容编辑，updatedAt 保持为最近一次内容修改的时刻；lastConfirmedAt 独立记录确认动作
    // （快照恢复按内容投影判断"快照后被修改"，不看 updatedAt，见 governance/snapshots.ts restoreProjection）。
    await deps.store.put({ ...target, lastConfirmedAt: now })
    return {
      kind: 'refreshed', memoryId: args.memoryId, lastConfirmedAt: now, otherWorkspaces,
      message: `已确认记忆 ${args.memoryId} 仍然准确，新鲜度已刷新。${crossWorkspaceNote([], otherWorkspaces)}`,
    }
  }

  const entry = await deps.decisions.get(args.decisionId)
  if (!entry) {
    return { kind: 'error', message: `待决项不存在：${args.decisionId}（可能已被裁决或涉及的记忆已删除）` }
  }

  const vertical = entry.baselineRef !== undefined
  // 账本里的条目也要过基数校验：横向必须是两个不同 id，垂直必须恰好一个。旧版本写入的或
  // 手工篡改的非法条目一旦按 memoryIds[0]/[1] 裁决，就可能删掉用户要保留的那条。
  const wellFormed = vertical
    ? entry.memoryIds.length === 1
    : entry.memoryIds.length === 2 && entry.memoryIds[0] !== entry.memoryIds[1]
  if (!wellFormed) {
    await deps.decisions.remove(entry.id)
    return { kind: 'error', message: `待决项 ${entry.id} 的记忆 id 不合法（${entry.memoryIds.join('、')}），已从账本清除，未做任何删除。` }
  }

  // 条目涉及的记忆逐条定位，过跨 workspace 门：任一方属于其他项目且未带参数，整条拒绝、账本不动
  const members = new Map<string, MemoryRecord>()
  for (const id of entry.memoryIds) {
    const r = await locate(id)
    if (r) members.set(id, r)
  }
  const { rejected, otherWorkspaces } = gateRecords([...members.values()], context, args.allowCrossWorkspace)
  if (rejected.length > 0) {
    return { kind: 'error', code: 'cross-workspace', rejected, message: `未裁决待决项 ${entry.id}，账本条目保留。${crossWorkspaceNote(rejected, [])}` }
  }

  // 败方（keep-left/keep-right 要删的记忆）；keep-both/dismiss 无败方。
  // 垂直：left=记忆 right=基线，keep-right = 基线胜、记忆删除；横向：left=memoryIds[0]、right=memoryIds[1]
  const loserId = vertical
    ? (args.verdict === 'keep-right' ? entry.memoryIds[0] : undefined)
    : args.verdict === 'keep-left' ? entry.memoryIds[1] : args.verdict === 'keep-right' ? entry.memoryIds[0] : undefined
  const toDelete = loserId === undefined ? undefined : members.get(loserId)
  if (loserId !== undefined && toDelete === undefined) {
    return { kind: 'error', message: `定位不到败方记忆 ${loserId}，未做任何删除，待决项 ${entry.id} 保留在账本里。可确认 id 后重试，或用 dismiss 清除该条目。` }
  }

  const actions: string[] = []
  let alsoCleared = 0
  if (vertical && args.verdict === 'keep-left') actions.push(`保留记忆 ${entry.memoryIds[0]}（用户确认 override ${entry.baselineRef}）`)

  if (toDelete && toDelete.status !== 'deleted') {
    // 快照先行（docs/p1-governance-health-design.md §6），再软删
    const snapshot = await deps.snapshots.capture({
      operation: 'pre-resolve',
      description: `裁决冲突 ${entry.id}（${args.verdict}）删除败方前`,
      records: [toDelete],
    }, now)
    await deps.store.softDelete(toDelete)
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
    if (toDelete) actions.push(`败方记忆 ${toDelete.id} 已是删除状态，无需再删`)
    if (args.verdict === 'keep-both') actions.push('两条并存（用户确认不冲突）')
    if (args.verdict === 'dismiss') actions.push('标记为误报')
    await deps.decisions.remove(entry.id)
  }

  return {
    kind: 'resolved', decisionId: entry.id, verdict: args.verdict, actions, alsoCleared, otherWorkspaces,
    message: `冲突已裁决（${args.verdict}）：${actions.join('；')}${crossWorkspaceNote([], otherWorkspaces)}`,
  }
}
