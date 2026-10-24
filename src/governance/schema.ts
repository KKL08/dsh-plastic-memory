import { z } from 'zod'
import { memoryRecordSchema } from '../record-schema.ts'

/** 与 mem_ id 同模式（pipeline.ts），不引入 nanoid。 */
export function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

/** 账本条目的种类。缺省 = conflict（旧条目没有此字段）；promote-candidate、overflow 是 GUI 加的提醒（ARCHITECTURE.md ⑥-7）。 */
export const PENDING_KINDS = ['conflict', 'promote-candidate', 'overflow'] as const
export type PendingKind = (typeof PENDING_KINDS)[number]

/**
 * 已裁决条目的 verdict。两边都留：keep-both、dismiss（也是超限提醒的「忽略」）、垂直 keep-left；
 * 删一方：横向 keep-left / keep-right、垂直 keep-right（败方见 decisions.ts verdictLoser）；keep-local：提升候选「留在本项目」；
 * promoted：提升候选已提升为全局，snapshotId 是提升前的快照，保留窗口内可撤销。
 */
export const SETTLED_VERDICTS = ['keep-both', 'dismiss', 'keep-left', 'keep-right', 'keep-local', 'promoted'] as const
export type SettledVerdict = (typeof SETTLED_VERDICTS)[number]

export const pendingDecisionSchema = z.object({
  id: z.string(),
  kind: z.enum(PENDING_KINDS).optional(),
  memoryIds: z.array(z.string()),
  baselineRef: z.string().optional(),
  summary: z.string(),
  firstSeenAt: z.number(),
  /** 与 memoryIds 一一对应的所属 workspace 路径，global 记忆为 'global'。旧条目没有此字段。 */
  workspaces: z.array(z.string()).optional(),
  /** 冲突：最近一次扫描时双方的内容指纹（垂直冲突含基线），见 conflictFingerprint；提升候选：记忆内容指纹；超限：档位号。
   *  旧条目没有此字段。 */
  fingerprint: z.string().optional(),
  /** 用户已裁决：条目留作记录。两边都留的指纹不变就不再报；删一方的留着供撤销，snapshotId 是删败方前的快照。 */
  settled: z.object({
    verdict: z.enum(SETTLED_VERDICTS),
    at: z.number(),
    snapshotId: z.string().optional(),
  }).optional(),
})
export type PendingDecision = z.infer<typeof pendingDecisionSchema>

/** 密钥硬删（S1）后快照里命中字段的占位文本。识别脱敏记录看 redacted 标记，不匹配这段文本。 */
export const REDACTED_PLACEHOLDER = '[redacted: secret]'

/** 快照里的记录：记忆记录 + 脱敏标记。redacted: true = 该记忆因含密钥已物理删除，命中字段已换成占位文本，
 *  restore 跳过；脱敏不可逆（ARCHITECTURE.md ⑥-6c）。缺省 = 未脱敏，旧快照照常解析。 */
export const snapshotRecordSchema = memoryRecordSchema.extend({
  redacted: z.literal(true).optional(),
})
export type SnapshotRecord = z.infer<typeof snapshotRecordSchema>

export const memorySnapshotSchema = z.object({
  id: z.string(),
  createdAt: z.number(),
  operation: z.enum(['pre-forget', 'pre-resolve', 'manual', 'pre-promote', 'pre-update']),
  description: z.string(),
  memoryIds: z.array(z.string()),
  data: z.array(snapshotRecordSchema),
})
export type MemorySnapshot = z.infer<typeof memorySnapshotSchema>

export const FINDING_TYPES = [
  'secret', 'expired', 'bloat', 'orphan', 'malformed', // 规则层
  'conflict', 'redundancy', 'misplaced', 'unclear', // 语义层
] as const
export type FindingType = (typeof FINDING_TYPES)[number]

export const SEVERITY_BY_TYPE = {
  secret: 'critical', conflict: 'critical',
  expired: 'warning', misplaced: 'warning', bloat: 'warning', malformed: 'warning',
  redundancy: 'info', unclear: 'info', orphan: 'info',
} as const satisfies Record<FindingType, 'critical' | 'warning' | 'info'>

export const findingSchema = z.object({
  type: z.enum(FINDING_TYPES),
  layer: z.enum(['rule', 'semantic']),
  severity: z.enum(['critical', 'warning', 'info']),
  memoryIds: z.array(z.string()),
  summary: z.string(),
  suggestedAction: z.string(),
  baselineRef: z.string().optional(),
})
export type Finding = z.infer<typeof findingSchema>

export const scanCacheSchema = z.object({
  id: z.string(),
  scannedAt: z.number(),
  scope: z.string(), // workspacePath 或 'all'
  findings: z.array(findingSchema),
})
export type ScanCacheEntry = z.infer<typeof scanCacheSchema>
