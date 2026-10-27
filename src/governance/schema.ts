import { z } from 'zod'
import { memoryRecordSchema } from '../record-schema.ts'
import { MODEL_CHANGE_KINDS } from '../contract-codes.ts'

/** 与 mem_ id 同模式（pipeline.ts），不引入 nanoid。 */
export function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

/**
 * 账本条目的种类。缺省 = conflict（旧条目没有此字段）；promote-candidate、overflow 是 GUI 加的提醒（ARCHITECTURE.md ⑥-7）；
 * edit 是 GUI 直接改、直接合并留的撤销记录，move 是把全局记忆移到项目留的撤销记录：两者都生来就已结清，撤销时移出账本，不进待处理。
 * rewrite、supersede 是模型用 memory_save 改写、替代已有记忆留的撤销记录：同样生来就已结清、不进待处理；撤销后标 isUndone 留到保留窗口结束，
 * 对话卡与右侧栏据此显示「已撤销」。
 */
export const PENDING_KINDS = ['conflict', 'promote-candidate', 'overflow', 'edit', 'move', ...MODEL_CHANGE_KINDS] as const
export type PendingKind = (typeof PENDING_KINDS)[number]

/**
 * 已裁决条目的 verdict。两边都留：keep-both、dismiss（也是超限提醒的「忽略」）、垂直 keep-left；
 * 删一方：横向 keep-left / keep-right、垂直 keep-right（败方见 decisions.ts verdictLoser）；keep-local：提升候选「留在本项目」；
 * promoted：提升候选已提升为全局，snapshotId 是提升前的快照，保留窗口内可撤销；
 * edited / merged：直接改、直接合并（memoryIds 是保留的那条，合并时再跟上删掉的那条），snapshotId 是改前的快照，
 * fingerprint 是写完后的内容（editFingerprint），撤销前据此确认之后没被别处改过；
 * moved：全局记忆移到了项目（memoryIds 是那条，workspaces 是目标项目），snapshotId 是移动前的快照，fingerprint 同直接改。
 * rewritten / superseded：模型改写了 memoryIds 那条、模型把那条标成了已取代，snapshotId 是改前的快照，fingerprint 是改完后那条的内容（同直接改）。
 */
export const SETTLED_VERDICTS = ['keep-both', 'dismiss', 'keep-left', 'keep-right', 'keep-local', 'promoted', 'edited', 'merged', 'moved', 'rewritten', 'superseded'] as const
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
  /** 冲突：最近一次扫描时双方的内容指纹（垂直冲突含基线），见 conflictFingerprint；提升候选：记忆内容指纹；超限：档位号；
   *  直接改、移到项目：写完后的内容指纹。旧条目没有此字段。 */
  fingerprint: z.string().optional(),
  /** 模型改写、替代：哪个会话里哪次 memory_save 调用改的（对话卡按 callId、右侧栏按 sessionId 认领）；替代时 by 是替代它的那条。 */
  origin: z.object({ sessionId: z.string(), callId: z.string(), by: z.string().optional() }).optional(),
  /**
   * 用户已裁决：条目留作记录。两边都留的指纹不变就不再报；删一方的留着供撤销，snapshotId 是删败方前的快照。
   * isBornSettled：提升候选在等你决定之外就地处理（对话卡片、右侧栏）时账本里还没有它，这条是处理完才记的；
   * 撤销时移出账本、回到没点过的样子，不重开进等你决定。isUndone：模型改写、替代已撤销（见 PENDING_KINDS）。
   * misplacedIgnore：「留在本项目」顺带写进建议忽略表的那条「放错层」忽略（忽略时间、记忆指纹 adviceFingerprint）；
   * 记忆原本没有放错层的忽略才写、才记。撤销时只在忽略表里那一条仍是它（时间、指纹都对得上）时才删。旧条目没有此字段，撤销不碰忽略表。
   */
  settled: z.object({
    verdict: z.enum(SETTLED_VERDICTS),
    at: z.number(),
    snapshotId: z.string().optional(),
    isBornSettled: z.literal(true).optional(),
    isUndone: z.literal(true).optional(),
    misplacedIgnore: z.object({ ignoredAt: z.number(), fingerprint: z.string() }).optional(),
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
  /** 体检时各发现涉及的记忆指纹（adviceFingerprint），按记忆 id：手改文件不动 updatedAt，评分靠它认出体检后改过。旧缓存没有此字段。 */
  fingerprints: z.record(z.string(), z.string()).optional(),
})
export type ScanCacheEntry = z.infer<typeof scanCacheSchema>

/**
 * 建议忽略表的一行（`.state/advice-ignores/<sha1(id)>.json`，见 storage/sidecar.ts，由接线层注入）：用户对一条建议整理项点了「忽略」。
 * id 即身份：问题类型 + 排序后的记忆 id（见 advice-ignores.ts adviceIdentity），同一项只有一个文件，
 * 并发忽略同一项落到同一个文件上。fingerprints 与 memoryIds 一一对应，是忽略时每条记忆的指纹（adviceFingerprint）；对不上就不算已忽略。
 * type 存成字符串（取值见 contract-codes.ts IGNORABLE_ADVICE_TYPES）：新版本加的类型旧版本读得出，只是不匹配。
 */
export const adviceIgnoreSchema = z.object({
  id: z.string(),
  type: z.string(),
  memoryIds: z.array(z.string()).min(1),
  fingerprints: z.array(z.string()),
  ignoredAt: z.number(),
})
export type AdviceIgnore = z.infer<typeof adviceIgnoreSchema>
