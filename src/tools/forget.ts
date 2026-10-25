import type { MemoryStore, MemoryLogger } from '../store.ts'
import type { SnapshotStore } from '../governance/snapshots.ts'
import type { PendingDecisionsStore } from '../governance/decisions.ts'
import type { MemoryRecord } from '../record-schema.ts'
import { redactRecord } from '../governance/snapshots.ts'
import { hasSecret } from '../secrets.ts'
import {
  crossWorkspaceNote, gateRecords, locateCopy,
  type CopyTarget, type CrossWorkspaceRejection, type GovernanceContext, type OtherWorkspaceMark,
} from './workspace-gate.ts'

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

/** 只给 GUI 用的选项，不在工具参数里，模型传不进来。 */
export interface ForgetOptions {
  /** 只软删：含密钥的记录不删，列进 skippedSecrets，由调用方先问用户再走彻底删除。 */
  isSoftOnly?: boolean
  /** 同 id 多副本时只认这一份（GUI 按页面上那一份操作）；缺省按会话 workspace 定位。跨 workspace 门照旧按会话判定。 */
  target?: CopyTarget
}

export interface ForgetResult {
  ok: boolean
  message: string
  /** 全部遗忘的 id（软删 + 硬删）。 */
  forgotten: string[]
  /** 其中含密钥、已物理删除的 id：不进 .archive/、不可恢复，所有快照里的副本已脱敏。 */
  hardDeleted: string[]
  missing: string[]
  /** 属于其他项目、因未带 allowCrossWorkspace 被拒的记录。 */
  rejected: CrossWorkspaceRejection[]
  /** 带参数放行、属于其他项目的记录（已遗忘）。 */
  otherWorkspaces: OtherWorkspaceMark[]
  snapshotId: string | null
  /** 只在 isSoftOnly 时出现：含密钥、没有动的 id。 */
  skippedSecrets?: string[]
}

/**
 * memory_forget（批量）：快照先行 → 逐条软删 → 清理待决账本悬空引用。
 * 含密钥的目标（任一级，docs/design-storage-file-is-memory.md §10）走硬删：本次快照里直接存脱敏版，
 * 既有快照先脱敏再物理删除文件——中途失败时文件还在，重跑 forget 即可，不会留下「文件已删、快照仍有明文」。
 * 不依赖任何 dsh 框架包，测试直接调它。
 */
export async function executeForget(
  args: ForgetArgs,
  context: GovernanceContext,
  deps: ForgetToolDeps,
  options: ForgetOptions = {},
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
    const record = options.target === undefined
      ? await deps.store.get(id, { workspacePath: context.workspacePath })
      : await locateCopy(deps.store, id, options.target)
    if (record && record.status !== 'deleted') located.push(record)
    else missing.push(id)
  }
  const { allowed, rejected, otherWorkspaces } = gateRecords(located, context, args.allowCrossWorkspace)
  const wsNote = crossWorkspaceNote(rejected, otherWorkspaces)
  // 只软删：这次读到含密钥的不进快照、不删，交回调用方；删除时锁内再看一次（见下）
  const skippedSecrets = options.isSoftOnly === true ? allowed.filter(hasSecret).map(r => r.id) : []
  const found = options.isSoftOnly === true ? allowed.filter(r => !hasSecret(r)) : allowed
  const softOnlyFields = () => (options.isSoftOnly === true ? { skippedSecrets } : {})
  const secretNote = () => (skippedSecrets.length > 0 ? `${skippedSecrets.length} 条含密钥（${skippedSecrets.join('、')}），只能彻底删除，未做改动。` : '')

  if (found.length === 0) {
    const missingText = missing.length > 0 ? `没有找到可遗忘的记忆（${missing.join('、')}），可能 id 有误或已删除。` : '没有遗忘任何记忆。'
    return {
      ok: false, forgotten: [], hardDeleted: [], missing, rejected, otherWorkspaces, snapshotId: null, ...softOnlyFields(),
      message: `${missingText}${secretNote()}${wsNote}`,
    }
  }

  // 快照先行（docs/p1-governance-health-design.md §6）：删除前把受影响记录的完整状态存进 snapshots 表
  const secretIds = new Set(found.filter(hasSecret).map(r => r.id))
  const snapshot = await deps.snapshots.capture({
    operation: 'pre-forget',
    description: `遗忘 ${found.length} 条记忆前（原因：${reason}）`,
    records: found.map(r => (secretIds.has(r.id) ? redactRecord(r) : r)),
  }, now)
  if (secretIds.size > 0) await deps.snapshots.redact(secretIds)

  const forgotten: string[] = []
  const hardDeleted: string[] = []
  // 指明了副本：删的时候也只认那一层，与定位同口径
  const deleteOpts = { isExactLayer: options.target !== undefined }
  const purge = async (record: MemoryRecord) => {
    if (await deps.store.hardDelete(record, deleteOpts)) {
      forgotten.push(record.id)
      hardDeleted.push(record.id)
    }
  }
  // 读过之后另一个会话才写进密钥的：锁内按当前内容判出来，不软删
  const lateSecrets: MemoryRecord[] = []
  for (const record of found) {
    if (secretIds.has(record.id)) {
      await purge(record)
      continue
    }
    const outcome = await deps.store.softDeleteUnlessSecret(record, deleteOpts)
    if (outcome === 'deleted') forgotten.push(record.id)
    else if (outcome === 'has-secret') {
      if (options.isSoftOnly === true) skippedSecrets.push(record.id)   // 只软删：照样交回调用方
      else lateSecrets.push(record)
    }
  }
  if (lateSecrets.length > 0) {
    // 改走硬删，同样先脱敏所有快照（含本次这份）再物理删除
    await deps.snapshots.redact(new Set(lateSecrets.map(r => r.id)))
    for (const record of lateSecrets) await purge(record)
  }
  await deps.decisions.removeByMemoryIds(forgotten)

  ;(deps.log ?? console).info(`[plastic-memory] 遗忘 ${forgotten.length} 条记忆（${forgotten.join('、')}），其中硬删 ${hardDeleted.length} 条，原因：${reason}`)
  const missingNote = missing.length > 0 ? `；未找到：${missing.join('、')}` : ''
  const hardNote = hardDeleted.length > 0
    ? `其中 ${hardDeleted.length} 条含密钥（${hardDeleted.join('、')}），已物理删除，不进 14 天回收、不可恢复，快照里的副本已脱敏；请轮换泄漏的凭证。`
    : ''
  const restoreNote = hardDeleted.length < forgotten.length ? `已自动快照（${snapshot.id}），14 天内可用 memory_snapshot 恢复。` : ''
  return {
    ok: true, forgotten, hardDeleted, missing, rejected, otherWorkspaces, snapshotId: snapshot.id, ...softOnlyFields(),
    message: `已遗忘 ${forgotten.length} 条记忆${missingNote}。${hardNote}${restoreNote}${secretNote()}${wsNote}`,
  }
}
