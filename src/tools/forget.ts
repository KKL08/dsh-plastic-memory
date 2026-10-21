import type { MemoryStore, MemoryLogger } from '../store.ts'
import type { SnapshotStore } from '../governance/snapshots.ts'
import type { PendingDecisionsStore } from '../governance/decisions.ts'
import type { MemoryRecord } from '../record-schema.ts'
import { crossWorkspaceNote, gateRecords, type CrossWorkspaceRejection, type GovernanceContext, type OtherWorkspaceMark } from './workspace-gate.ts'

/** memory_forget 工具的依赖，纯逻辑层与框架绑定层共用。 */
export interface ForgetToolDeps {
  store: MemoryStore
  snapshots: SnapshotStore
  decisions: PendingDecisionsStore
  now?: () => number
  /** 日志注入口，缺省回退 console（见 store.ts MemoryLogger）。 */
  log?: MemoryLogger
}

export interface ForgetArgs {
  ids: string[]
  reason: string
  /** 用户明确选择「全局整理」时才为 true：放行其他项目的记录（见 workspace-gate.ts）。 */
  allowCrossWorkspace?: boolean
}

export interface ForgetResult {
  ok: boolean
  message: string
  forgotten: string[]
  missing: string[]
  /** 属于其他项目、因未带 allowCrossWorkspace 被拒的记录。 */
  rejected: CrossWorkspaceRejection[]
  /** 带参数放行、属于其他项目的记录（已遗忘）。 */
  otherWorkspaces: OtherWorkspaceMark[]
  snapshotId: string | null
}

/**
 * memory_forget（批量）：快照先行 → 逐条软删 → 清理待决账本悬空引用。
 * 不依赖任何 dsh 框架包，测试直接调它。
 */
export async function executeForget(
  args: ForgetArgs,
  context: GovernanceContext,
  deps: ForgetToolDeps,
): Promise<ForgetResult> {
  const { ids, reason } = args
  const now = deps.now?.() ?? Date.now()

  // 调用者从多个扫描结果汇总 id 列表时可能重复某个 id
  // 去重保证快照、计数、删除日志中都不会出现重复
  const uniqueIds = [...new Set(ids)]

  // 预读范围：按 id 逐条两级定位（含非 active，当前 workspace 优先），已删的计入 missing；
  // 定位到的再过跨 workspace 门，其他项目的记录不带参数时单独列出、不进快照
  const located: MemoryRecord[] = []
  const missing: string[] = []
  for (const id of uniqueIds) {
    const record = await deps.store.get(id, { workspacePath: context.workspacePath })
    if (record && record.status !== 'deleted') located.push(record)
    else missing.push(id)
  }
  const { allowed: found, rejected, otherWorkspaces } = gateRecords(located, context, args.allowCrossWorkspace)
  const wsNote = crossWorkspaceNote(rejected, otherWorkspaces)

  if (found.length === 0) {
    const missingText = missing.length > 0 ? `没有找到可遗忘的记忆（${missing.join('、')}），可能 id 有误或已删除。` : '没有遗忘任何记忆。'
    return {
      ok: false, forgotten: [], missing, rejected, otherWorkspaces, snapshotId: null,
      message: `${missingText}${wsNote}`,
    }
  }

  // 快照先行（docs/p1-governance-health-design.md §6）：删除前把受影响记录的完整状态存进 snapshots 表
  const snapshot = await deps.snapshots.capture({
    operation: 'pre-forget',
    description: `遗忘 ${found.length} 条记忆前（原因：${reason}）`,
    records: found,
  }, now)

  const forgotten: string[] = []
  for (const record of found) {
    if (await deps.store.softDelete(record.id)) forgotten.push(record.id)
  }
  await deps.decisions.removeByMemoryIds(forgotten)

  ;(deps.log ?? console).info(`[plastic-memory] 遗忘 ${forgotten.length} 条记忆（${forgotten.join('、')}），原因：${reason}`)
  const missingNote = missing.length > 0 ? `；未找到：${missing.join('、')}` : ''
  return {
    ok: true, forgotten, missing, rejected, otherWorkspaces, snapshotId: snapshot.id,
    message: `已遗忘 ${forgotten.length} 条记忆${missingNote}。已自动快照（${snapshot.id}），14 天内可用 memory_snapshot 恢复。${wsNote}`,
  }
}
