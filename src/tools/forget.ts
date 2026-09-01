import type { MemoryStore, MemoryLogger } from '../store.ts'
import type { SnapshotStore } from '../governance/snapshots.ts'
import type { PendingDecisionsStore } from '../governance/decisions.ts'
import type { MemoryRecord } from '../record-schema.ts'

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
}

export interface ForgetResult {
  ok: boolean
  message: string
  forgotten: string[]
  missing: string[]
  snapshotId: string | null
}

/**
 * memory_forget（批量）：快照先行 → 逐条软删 → 清理待决账本悬空引用。
 * 不依赖任何 dsh 框架包，测试直接调它。
 */
export async function executeForget(
  args: ForgetArgs,
  deps: ForgetToolDeps,
): Promise<ForgetResult> {
  const { ids, reason } = args
  const now = deps.now?.() ?? Date.now()

  // 调用者从多个扫描结果汇总 id 列表时可能重复某个 id
  // 去重保证快照、计数、删除日志中都不会出现重复
  const uniqueIds = [...new Set(ids)]

  const found: MemoryRecord[] = []
  const missing: string[] = []
  for (const id of uniqueIds) {
    const record = deps.store.get(id)
    if (record && record.status !== 'deleted') found.push(record)
    else missing.push(id)
  }

  if (found.length === 0) {
    return {
      ok: false, forgotten: [], missing, snapshotId: null,
      message: `没有找到可遗忘的记忆（${missing.join('、')}），可能 id 有误或已删除。`,
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
    ok: true, forgotten, missing, snapshotId: snapshot.id,
    message: `已遗忘 ${forgotten.length} 条记忆${missingNote}。已自动快照（${snapshot.id}），14 天内可用 memory_snapshot 恢复。`,
  }
}
