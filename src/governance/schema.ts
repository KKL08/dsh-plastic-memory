import { z } from 'zod'
import { memoryRecordSchema } from '../record-schema.ts'

/** 与 mem_ id 同模式（pipeline.ts），不引入 nanoid。 */
export function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

export const pendingDecisionSchema = z.object({
  id: z.string(),
  memoryIds: z.array(z.string()),
  baselineRef: z.string().optional(),
  summary: z.string(),
  firstSeenAt: z.number(),
  /** 与 memoryIds 一一对应的所属 workspace 路径，global 记忆为 'global'。旧条目没有此字段。 */
  workspaces: z.array(z.string()).optional(),
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
