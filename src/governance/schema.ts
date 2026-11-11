import { z } from 'zod'
import { memoryRecordSchema } from '../record-schema.ts'
import { MODEL_CHANGE_KINDS, PROPOSAL_ACTIONS, PROPOSAL_SOURCES, SUGGESTION_FAILURE_KINDS } from '../contract-codes.ts'

/** 与 mem_ id 同模式（pipeline.ts），不引入 nanoid。 */
export function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

/**
 * 账本条目的种类。缺省 = conflict（旧条目没有此字段）；promote-candidate、overflow 是 GUI 加的提醒；
 * edit 是 GUI 直接改、直接合并留的撤销记录，move 是把全局记忆移到项目留的撤销记录：两者都生来就已结清，撤销时移出账本，不进待处理。
 * rewrite、supersede 是模型用 memory_save 改写、替代已有记忆留的撤销记录：同样生来就已结清、不进待处理；撤销后标 isUndone 留到保留窗口结束，
 * 对话卡与右侧栏据此显示「已撤销」。
 */
export const PENDING_KINDS = ['conflict', 'promote-candidate', 'overflow', 'edit', 'move', ...MODEL_CHANGE_KINDS] as const
export type PendingKind = (typeof PENDING_KINDS)[number]

/** 条目种类，缺省即冲突（旧条目）。 */
export function kindOf(entry: { kind?: PendingKind }): PendingKind {
  return entry.kind ?? 'conflict'
}

/**
 * 已裁决条目的 verdict。两边都留：keep-both、dismiss（也是超限提醒的「忽略」）、垂直 keep-left；
 * 删一方：横向 keep-left / keep-right、垂直 keep-right（败方见 verdictLoser）；keep-local：提升候选「留在本项目」；
 * promoted：提升候选已提升为全局，snapshotId 是提升前的快照，保留窗口内可撤销；
 * edited / merged：直接改、直接合并（memoryIds 是保留的那条，合并时再跟上删掉的那条），snapshotId 是改前的快照，
 * fingerprint 是写完后的内容（editFingerprint），撤销前据此确认之后没被别处改过；
 * moved：全局记忆移到了项目（memoryIds 是那条，workspaces 是目标项目），snapshotId 是移动前的快照，fingerprint 同直接改。
 * rewritten / superseded：模型改写了 memoryIds 那条、模型把那条标成了已取代，snapshotId 是改前的快照，fingerprint 是改完后那条的内容（同直接改）。
 * batch-edited：整理所选一次应用（种类 edit，memoryIds 是这次写下的全部，按计划顺序），snapshotId 是整批改前的快照，
 * 不记 fingerprint，改记逐项回执 receipts。
 * plan-applied：冲突按处理方案改写了记忆（融合、垂直改写），记在冲突条目自己身上：settled 里有改前快照 snapshotId、逐项回执 receipts、
 * 依据和结论代码 proposal、改前的冲突指纹 priorFingerprint；条目 fingerprint 换成改后的。
 */
export const SETTLED_VERDICTS = ['keep-both', 'dismiss', 'keep-left', 'keep-right', 'keep-local', 'promoted', 'edited', 'merged', 'moved', 'rewritten', 'superseded', 'batch-edited', 'plan-applied'] as const
export type SettledVerdict = (typeof SETTLED_VERDICTS)[number]

/**
 * 裁决要删掉的一方（败方）；两边都留、或不是冲突条目时为 undefined。
 * 横向：left=memoryIds[0]、right=memoryIds[1]；垂直（有 baselineRef）：left=记忆、right=基线，基线不可删，keep-right 意为记忆删除。
 * plan-applied 的败方是结清信息回执里删除的那一条（融合时并入的那条；垂直改写没有败方）。
 */
export function verdictLoser(
  entry: { kind?: PendingKind; memoryIds: string[]; baselineRef?: string; settled?: { receipts?: readonly BatchReceipt[] } }, verdict: SettledVerdict,
): string | undefined {
  if (kindOf(entry) !== 'conflict') return undefined
  if (verdict === 'plan-applied') return entry.settled?.receipts?.find(r => r.op === 'forget')?.memoryId
  if (entry.baselineRef !== undefined) return verdict === 'keep-right' ? entry.memoryIds[0] : undefined
  return verdict === 'keep-left' ? entry.memoryIds[1] : verdict === 'keep-right' ? entry.memoryIds[0] : undefined
}

/**
 * 处理方案落盘的依据（记在已结清条目上）：source 是按建议还是按要求，action 是结论代码。直接点候选项处理的条目没有它。
 */
export const settledProposalSchema = z.object({ source: z.enum(PROPOSAL_SOURCES), action: z.enum(PROPOSAL_ACTIONS) })
export type SettledProposal = z.infer<typeof settledProposalSchema>

/**
 * 整理所选一次应用的逐项回执：这一项是改写还是删除，写下时的内容指纹（editFingerprint，取实际提交的那份），
 * 写完后应有的状态（改写 active、删除 deleted）。撤销前逐项比对，状态和指纹都对得上才算「还是那次写下的」。
 */
export const batchReceiptSchema = z.object({
  memoryId: z.string(),
  op: z.enum(['edit', 'forget']),
  fingerprint: z.string(),
  expectedStatus: z.enum(['active', 'deleted']),
})
export type BatchReceipt = z.infer<typeof batchReceiptSchema>

/**
 * 处理方案对一条记忆的操作（存盘形状，和 GUI 契约分开、经视图映射）：edit 改写成这一稿（四个面），forget 删除，keep 不动。
 * 处理方案对涉及的每条记忆各有一项，按条目 memoryIds 的顺序。
 */
export const proposalOpSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('edit'), memoryId: z.string(), content: z.string(), name: z.string(), summary: z.string(), tags: z.array(z.string()) }),
  z.object({ kind: z.literal('forget'), memoryId: z.string() }),
  z.object({ kind: z.literal('keep'), memoryId: z.string() }),
])
export type ProposalOp = z.infer<typeof proposalOpSchema>

/**
 * 处理建议生成时的依据版本：条目当时的冲突指纹（旧条目没有指纹时缺省），和每条涉及记忆的完整内容指纹（editFingerprint，
 * 撤销用的那一种，不含位置）、作用域键（scope.ts 的 scopeKey），按条目 memoryIds 的顺序。
 * 条目指纹、任一条记忆此刻的指纹或作用域对不上，这份建议（或这次失败）就不算数。作用域键缺省的（加它之前写下的）一律算对不上，条目照常解析。
 * 垂直冲突另记 baseline：生成时用的基线所属项目（会话的 workspace 路径，没有项目为 'global'）和基线指纹（decisions.ts baselineFingerprint）。
 * 重写视图时没有会话、拿不到指令文件，视图只核对记忆那一半；基线这一半在补上建议、采纳、按要求应用时按会话此刻的基线核对。
 */
export const suggestionBasisSchema = z.object({
  conflictFingerprint: z.string().optional(),
  memories: z.array(z.object({ memoryId: z.string(), fingerprint: z.string(), scopeKey: z.string().optional() })),
  baseline: z.object({ workspace: z.string(), fingerprint: z.string() }).optional(),
})
export type SuggestionBasis = z.infer<typeof suggestionBasisSchema>

/**
 * 处理建议（体检或「补上建议」时模型给一条冲突的结论）：每次生成一个新 id，处理方案（结论、一句理由、逐条操作），依据版本，
 * 是否回查过出处（由代码设定），生成时刻。理由存盘前已按疑似级遮盖密钥；稿不遮盖，存盘前已保证不含高危密钥、疑似值都出自原文。
 */
export const storedSuggestionSchema = z.object({
  id: z.string(),
  action: z.enum(PROPOSAL_ACTIONS),
  reason: z.string(),
  ops: z.array(proposalOpSchema),
  basis: suggestionBasisSchema,
  isSourced: z.boolean(),
  generatedAt: z.number(),
})
export type StoredSuggestion = z.infer<typeof storedSuggestionSchema>

/**
 * 处理建议最近一次没生成成：依据版本（同建议，对不上就不算数）、原因（kind 见 SUGGESTION_FAILURE_KINDS，原话已脱敏；
 * undecided 带模型说明的理由 reason，已按疑似级遮盖），时刻。
 */
export const suggestionFailureSchema = z.object({
  basis: suggestionBasisSchema,
  cause: z.object({ kind: z.enum(SUGGESTION_FAILURE_KINDS), hostCode: z.string().optional(), message: z.string().optional(), reason: z.string().optional() }),
  at: z.number(),
})
export type SuggestionFailure = z.infer<typeof suggestionFailureSchema>

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
  /** 整理所选的应用（batch-edited）：逐项回执，与 memoryIds 同序。其余条目没有此字段。 */
  receipts: z.array(batchReceiptSchema).optional(),
  /** 模型改写、替代：哪个会话里哪次 memory_save 调用改的（对话卡按 callId、右侧栏按 sessionId 认领）；替代时 by 是替代它的那条。 */
  origin: z.object({ sessionId: z.string(), callId: z.string(), by: z.string().optional() }).optional(),
  /** 冲突：模型给的处理建议，见 storedSuggestionSchema。依据版本对不上时视图当作没有建议。其余条目没有此字段。 */
  suggestion: storedSuggestionSchema.optional(),
  /** 冲突：处理建议最近一次没生成成的原因；生成成功时清掉。 */
  suggestionFailure: suggestionFailureSchema.optional(),
  /** 冲突：体检自己发起的生成对这个冲突指纹试过几次（用户点「补上建议」不计）；指纹变了从头算。 */
  suggestionAttempts: z.object({ fingerprint: z.string().optional(), count: z.number().int().positive() }).optional(),
  /**
   * 用户已裁决：条目留作记录。两边都留的指纹不变就不再报；删一方的留着供撤销，snapshotId 是删败方前的快照。
   * isBornSettled：提升候选在等你决定之外就地处理（对话卡片、右侧栏）时账本里还没有它，这条是处理完才记的；
   * 撤销时移出账本、回到没点过的样子，不重开进等你决定。isUndone：模型改写、替代已撤销（见 PENDING_KINDS）。
   * misplacedIgnore：「留在本项目」顺带写进建议忽略表的那条「放错层」忽略（忽略时间、记忆指纹 adviceFingerprint）；
   * 记忆原本没有放错层的忽略才写、才记。撤销时只在忽略表里那一条仍是它（时间、指纹都对得上）时才删。旧条目没有此字段，撤销不碰忽略表。
   * proposal：冲突按处理方案落盘时的依据和结论代码（见 settledProposalSchema）；撤销时随 settled 一起去掉，条目上的处理建议不动。
   * receipts、priorFingerprint 只在 plan-applied 上：逐项回执（同整理所选，按写入顺序；整理所选的回执在条目顶层，这里在结清信息里，
   * 撤销、账本清理随结清信息一起处理），和结清前条目的冲突指纹（旧条目没有指纹时缺省），撤销时还原。
   */
  settled: z.object({
    verdict: z.enum(SETTLED_VERDICTS),
    at: z.number(),
    snapshotId: z.string().optional(),
    isBornSettled: z.literal(true).optional(),
    isUndone: z.literal(true).optional(),
    misplacedIgnore: z.object({ ignoredAt: z.number(), fingerprint: z.string() }).optional(),
    proposal: settledProposalSchema.optional(),
    receipts: z.array(batchReceiptSchema).optional(),
    priorFingerprint: z.string().optional(),
  }).optional(),
})
export type PendingDecision = z.infer<typeof pendingDecisionSchema>

/** 密钥硬删（S1）后快照里命中字段的占位文本。识别脱敏记录看 redacted 标记，不匹配这段文本。 */
export const REDACTED_PLACEHOLDER = '[redacted: secret]'

/** 快照里的记录：记忆记录 + 脱敏标记。redacted: true = 该记忆因含密钥已物理删除，命中字段已换成占位文本，
 *  restore 跳过；脱敏不可逆。缺省 = 未脱敏，旧快照照常解析。 */
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
  /**
   * 带提交点的执行器写的（这一版起都带 true）：这次体检做没做完以体检记录为准，缓存写了不代表做完（写完缓存、挂账前可能被中断）。
   * 旧缓存没有此字段，没有完成记录时才拿它的时间当上次体检（见 checkup-records.ts lastCheckupAt）。
   */
  isTrackedByCheckups: z.boolean().optional(),
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
