import { z } from 'zod'
import { linkIdsSchema, memoryRecordSchema } from '../record-schema.ts'
import type { IndexPlan } from '../topic-ops.ts'
import { MODEL_CHANGE_KINDS, PROPOSAL_ACTIONS, PROPOSAL_SOURCES, SUGGESTION_FAILURE_KINDS, SUGGESTION_PARSE_STAGES } from '../contract-codes.ts'
import { changeOpSchema, changeReceiptSchema } from './changeset.ts'

/** 与 mem_ id 同模式（pipeline.ts），不引入 nanoid。 */
export function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

/**
 * 账本条目的种类。缺省 = conflict（旧条目没有此字段）；promote-candidate、overflow 是 GUI 加的提醒；
 * edit 是 GUI 直接改、直接合并留的撤销记录，move 是把全局记忆移到项目留的撤销记录：两者都生来就已结清，撤销时移出账本，不进待处理。
 * rewrite、supersede 是模型用 memory_save 改写、替代已有记忆留的撤销记录：同样生来就已结清、不进待处理；撤销后标 isUndone 留到保留窗口结束，
 * 对话卡与右侧栏据此显示「已撤销」。
 * index-organize 是一次「整理索引」留的撤销记录：同样生来就已结清，memoryIds 为空，做过的每个索引操作各有一条回执（indexRun），撤销时逐条倒着撤。
 * link 是一次只挂关联、前提的保存（只改元数据，不拍快照）留的回执：生来就已结清，links 记这次新加的 id，撤销时只去掉这些，撤后标 isUndone。
 * brewing-dreams-run 是记忆梦境一次运行的批次条目：生来就已结清（裁决记 batch-edited），记忆的改动回执在 changes、索引操作的回执在 indexRun，
 * 可以整批撤，也可以按回执单条撤；一条回执都不剩时移出账本。0.2.0 不认识这个种类，读到时跳过。
 * 体检的另外四种发现（FINDING_LEDGER_KINDS）：missed-change 漏记的变化（两条分开的记忆，时间先后解释得了差异）、
 * exception 例外提示（范围解释得了差异）、premise-changed 依据已变（决定记下的前提摘要和被依据记忆现在的对不上，代码直接判）、
 * cross-duplicate 跨项目重复（几个项目各记了同一件事）。0.2.0 不认识这几个种类，读到时跳过。
 * important-pending「重要、等你定」：记忆梦境核实过的一对矛盾（原是 conflict 或 missed-change，就地改成这个种类），
 * 把关档下有把握但改的是重要记忆，或任一方锁定；归「先处理」。用户可以 adopt 梦境的方案，也可以按原来那种发现裁决（见 resolveVerdictsOf）：
 * 后者结清时种类换回原来那种、dreamsHold 留着，撤销或败方回来重开时换回 important-pending。0.2.0 不认识，读到时跳过、不计数。
 */
export const PENDING_KINDS = [
  'conflict', 'promote-candidate', 'overflow', 'edit', 'move', ...MODEL_CHANGE_KINDS, 'index-organize', 'link', 'brewing-dreams-run',
  'missed-change', 'premise-changed', 'exception', 'cross-duplicate', 'important-pending',
] as const
export type PendingKind = (typeof PENDING_KINDS)[number]

/** 条目种类，缺省即冲突（旧条目）。 */
export function kindOf(entry: { kind?: PendingKind }): PendingKind {
  return entry.kind ?? 'conflict'
}

/** 体检挂进账本、等用户看的五种发现（冲突加四种新发现）。 */
export const FINDING_LEDGER_KINDS = ['conflict', 'missed-change', 'premise-changed', 'exception', 'cross-duplicate'] as const satisfies readonly PendingKind[]
export type FindingLedgerKind = (typeof FINDING_LEDGER_KINDS)[number]

/**
 * 对「一对记忆」下的判断：冲突、漏记的变化、例外提示。用户对其中任一种裁成「确实不冲突」「记成例外」（以及沿用的「两条都留」）之后，
 * 两边的扫描指纹都没变时，这一对再被报成三种里的哪一种都不挂账（配对排除）。
 */
export const PAIR_FINDING_KINDS = ['conflict', 'missed-change', 'exception'] as const satisfies readonly FindingLedgerKind[]

/** 配对排除的裁决：两条都留（旧取值，按确实不冲突处理）、确实不冲突、记成例外。 */
export const PAIR_EXCLUDING_VERDICTS = ['keep-both', 'not-conflict', 'exception'] as const

/**
 * 每种发现能用的裁决（memory_confirm resolve 与界面共用这一份；不在表里的组合退回，条目不动）。
 * 冲突：全部取值；as-versions 只用在横向冲突上（要两条记忆）。漏记的变化：并成版本、确实不冲突、忽略。
 * 依据已变：忽略（复查过仍成立；要改决定走 memory_save）。例外提示：忽略。跨项目重复：忽略（要提升走 memory_promote）。
 */
export const VERDICTS_BY_KIND = {
  'conflict': ['keep-left', 'keep-right', 'keep-both', 'dismiss', 'not-conflict', 'exception', 'as-versions'],
  'missed-change': ['as-versions', 'not-conflict', 'dismiss'],
  'premise-changed': ['dismiss'],
  'exception': ['dismiss'],
  'cross-duplicate': ['dismiss'],
} as const satisfies Record<FindingLedgerKind, readonly SettledVerdict[]>
export type ResolveVerdict = (typeof VERDICTS_BY_KIND)[FindingLedgerKind][number]

/**
 * 这条待决项此刻能用的裁决（memory_confirm resolve 与界面共用）。配对和其余发现照 VERDICTS_BY_KIND；
 * 「重要、等你定」（important-pending）是它原来那种发现（dreamsHold.fromKind）的全部裁决，含义和原来一样，
 * 带梦境方案（dreamsHold.proposal）的另在最前加 adopt（按方案落盘）；没有方案的（锁定通知）没有 adopt。
 * 没有 dreamsHold 的 important-pending（手改出来的、读不懂的条目）只能 dismiss。其余种类返回空。
 */
export function resolveVerdictsOf(_entry: { kind?: PendingKind; dreamsHold?: { fromKind: TierFindingKind; proposal?: unknown } }): readonly (ResolveVerdict | 'adopt')[] {
  const kind = kindOf(_entry)
  if (kind === 'important-pending') {
    const hold = _entry.dreamsHold
    if (!hold) return ['dismiss']
    const verdicts = VERDICTS_BY_KIND[hold.fromKind]
    return hold.proposal === undefined ? verdicts : ['adopt', ...verdicts]
  }
  return Object.hasOwn(VERDICTS_BY_KIND, kind) ? VERDICTS_BY_KIND[kind as FindingLedgerKind] : []
}

/** 记忆梦境按把关档、信任档处理的配对发现：两条分开的记忆之间的矛盾、漏记的变化。纵向冲突（带 baselineRef）不在内。 */
export const TIER_FINDING_KINDS = ['conflict', 'missed-change'] as const satisfies readonly PendingKind[]
export type TierFindingKind = (typeof TIER_FINDING_KINDS)[number]

/** 记忆梦境处理矛盾时会落盘的改动性质：状态变化（旧的一方并成新的一方的历史版本）、纠错（改写旧的一方）。 */
export const TIER_CHANGE_KINDS = ['state-change', 'correct'] as const
export type TierChangeKind = (typeof TIER_CHANGE_KINDS)[number]

/**
 * 记忆梦境核实一对发现后没有直接处理、交给用户的原因（记在条目的 dreamsReview 上，按两边的扫描指纹认，指纹不变不再交给模型）。
 * 前九个是「有把握」没过的那一条（judgeConfidence 的 doubt，按检查顺序）；has-secret：任一方或纠错稿含疑似密钥；
 * draft-unusable：纠错没给能用的稿（缺正文、和原文一样、超长、名称或摘要不合规）；undone-before：用户撤销过记忆梦境对同一个结论的处理
 * （用户在「先处理」里不采纳、按原来那种发现裁决都不算）。
 */
export const TIER_OUTCOMES = [
  'pair-mismatch', 'not-same-dimension', 'change-unclear', 'not-a-change',
  'evidence-missing', 'evidence-unknown-ref', 'evidence-not-qualified', 'order-unclear', 'both-user-unclear',
  'has-secret', 'draft-unusable', 'undone-before',
] as const
export type TierOutcome = (typeof TIER_OUTCOMES)[number]

/** 方案依据的一条会话事件：会话 id 加事件序号。 */
export const evidenceRefSchema = z.object({ sessionId: z.string(), seq: z.number() })
export type EvidenceRef = z.infer<typeof evidenceRefSchema>

/** 依据原文节选：模型引用的那条事件的说话方和文字（已遮盖疑似密钥、折成一行、截到 TIER_EXCERPT_MAX）。 */
export const dreamsExcerptSchema = z.object({ sessionId: z.string(), seq: z.number(), speaker: z.enum(['user', 'tool']), text: z.string() })
export type DreamsExcerpt = z.infer<typeof dreamsExcerptSchema>

/**
 * 「重要、等你定」上记忆梦境留的东西。cause：important 是把关档下要改重要记忆，locked 是任一方锁定（两档都通知，不调模型、没有方案；
 * 两边都解锁、含锁到期之后，下次运行把条目改回 fromKind 照常处理）。
 * fromKind：改成这个种类之前是哪种发现，用户按它的裁决处理。conclusion：这一对的结论身份（tierConclusion），撤销梦境处理的那一组时记进撤销过的结论。
 * proposal：有把握时的方案：ops 是 versionPlan 或纠错的 edit（组号 resolveGroupId(runId, conclusion)），newer 是新的一方，
 * reason 已遮盖、折一行；olderBoundNote 是旧的一方没填事实时间、用出处时间当上限时给用户看的说明（不是事实时间）。
 */
export const dreamsHoldSchema = z.object({
  runId: z.string(),
  at: z.number(),
  cause: z.enum(['important', 'locked']),
  fromKind: z.enum(TIER_FINDING_KINDS),
  conclusion: z.string(),
  proposal: z.object({
    ops: z.array(changeOpSchema),
    newer: z.string(),
    reason: z.string(),
    excerpts: z.array(dreamsExcerptSchema),
    olderBoundNote: z.string().optional(),
  }).optional(),
})
export type DreamsHold = z.infer<typeof dreamsHoldSchema>

/** 记忆梦境核实过、交给用户的配对发现：哪次运行、什么时候、为什么没直接处理，当时两边的配对依据（pairBasis）。 */
export const dreamsReviewSchema = z.object({ runId: z.string(), at: z.number(), outcome: z.enum(TIER_OUTCOMES), basis: z.string() })
export type DreamsReview = z.infer<typeof dreamsReviewSchema>

/**
 * 记忆梦境直接处理掉的一对矛盾（记在这次运行的批次条目上，梦境报告读它）：变更组号、原是哪种发现、改动性质、新旧两条、
 * 是否重要（信任档下直接处理的重要记忆，列在最前）、理由和依据节选（都已遮盖），olderBoundNote 同 dreamsHoldSchema。
 */
export const dreamsResultSchema = z.object({
  group: z.string(),
  fromKind: z.enum(TIER_FINDING_KINDS),
  change: z.enum(TIER_CHANGE_KINDS),
  newer: z.string(),
  older: z.string(),
  isImportant: z.literal(true).optional(),
  reason: z.string(),
  excerpts: z.array(dreamsExcerptSchema),
  olderBoundNote: z.string().optional(),
  at: z.number(),
})
export type DreamsResult = z.infer<typeof dreamsResultSchema>

/**
 * 已裁决条目的 verdict。两边都留：keep-both、dismiss（也是超限提醒的「忽略」）、垂直 keep-left；
 * 删一方：横向 keep-left / keep-right、垂直 keep-right（败方见 verdictLoser）；keep-local：提升候选「留在本项目」；
 * promoted：提升候选已提升为全局，snapshotId 是提升前的快照，保留窗口内可撤销；
 * edited / merged：直接改、直接合并（memoryIds 是保留的那条，合并时再跟上删掉的那条），snapshotId 是改前的快照，
 * fingerprint 是写完后的内容（editFingerprint），撤销前据此确认之后没被别处改过；
 * moved：全局记忆移到了项目（memoryIds 是那条，workspaces 是目标项目），snapshotId 是移动前的快照，fingerprint 同直接改。
 * rewritten / superseded：模型改写了 memoryIds 那条、模型把那条标成了已取代，snapshotId 是改前的快照，fingerprint 是改完后那条的内容（同直接改）。
 * batch-edited：整理所选一次应用（种类 edit，memoryIds 是这次写下的全部，按计划顺序），snapshotId 是整批改前的快照，
 * 不记 fingerprint，改记逐项回执 receipts；记忆梦境的一次运行（种类 brewing-dreams-run）也记它。
 * plan-applied：冲突按处理方案改写了记忆（融合、垂直改写），记在冲突条目自己身上：settled 里有改前快照 snapshotId、逐项回执 receipts、
 * 依据和结论代码 proposal、改前的冲突指纹 priorFingerprint；条目 fingerprint 换成改后的。
 * index-organized：一次整理索引（种类 index-organize），回执在条目的 indexRun 里。
 * linked：一次只挂关联、前提的保存（种类 link），新加的 id 在条目的 links 里。
 * not-conflict：确实不冲突（配对排除，见 PAIR_EXCLUDING_VERDICTS）；exception：记成例外（同样配对排除；对方是项目记忆的例外由例外表从这里重建）；
 * as-versions：两条并成状态页的新旧版本（旧状态那条软删、记下去向），逐操作回执在条目的 changes 里，撤销按回执还原、条目回到待处理。
 * 这三个取值 0.2.0 不认识：用它们结清的条目它读到时跳过。
 * adopt：「重要、等你定」按记忆梦境给的方案落盘（逐操作回执在条目的 changes 里，撤销按回执还原、条目回到待处理）。0.2.0 不认识。
 */
export const SETTLED_VERDICTS = [
  'keep-both', 'dismiss', 'keep-left', 'keep-right', 'keep-local', 'promoted', 'edited', 'merged', 'moved', 'rewritten', 'superseded', 'batch-edited', 'plan-applied', 'index-organized', 'linked',
  'not-conflict', 'exception', 'as-versions', 'adopt',
] as const
export type SettledVerdict = (typeof SETTLED_VERDICTS)[number]

/**
 * 条目里这条记忆的改前快照：按变更集应用的条目每个操作各拍各的，取它那条回执上的；其余条目整条只有一份。
 */
export function snapshotIdFor(
  entry: { settled?: { snapshotId?: string }; changes?: ReadonlyArray<{ memoryId: string; snapshotId?: string }> }, memoryId: string,
): string | undefined {
  return entry.changes?.find(r => r.memoryId === memoryId && r.snapshotId !== undefined)?.snapshotId ?? entry.settled?.snapshotId
}

/**
 * 裁决要删掉的一方（败方）；并成版本、采纳梦境的方案（adopt）按删除回执取被删的那条（采纳纠错方案没有删除，没有败方），两边都留时为 undefined。
 * 横向：left=memoryIds[0]、right=memoryIds[1]；垂直（有 baselineRef）：left=记忆、right=基线，基线不可删，keep-right 意为记忆删除。
 * plan-applied 的败方是结清信息回执里删除的那一条（融合时并入的那条；垂直改写没有败方）。
 */
export function verdictLoser(
  entry: { kind?: PendingKind; memoryIds: string[]; baselineRef?: string; settled?: { receipts?: readonly BatchReceipt[] }; changes?: ReadonlyArray<{ kind: string; memoryId: string }> }, verdict: SettledVerdict,
): string | undefined {
  if (verdict === 'as-versions' || verdict === 'adopt') return entry.changes?.find(r => r.kind === 'forget')?.memoryId
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
 * 垂直冲突另记 baseline：生成时用的指令文件所属（这条记忆的项目路径，全局记忆为 'global'；只作说明，旧版本记的是会话所在项目）
 * 和基线指纹（decisions.ts baselineFingerprint）。重写视图时不读指令文件，视图只核对记忆那一半；基线这一半在补上建议、采纳、
 * 按要求应用时按这条记忆此刻对应的指令文件核对指纹。
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
 * undecided 带模型说明的理由 reason，已按疑似级遮盖；unparseable 带卡在哪一步 stage，见 SUGGESTION_PARSE_STAGES；字段不合要求时带不合的字段名 fields，如 draft.summary），时刻。
 */
export const suggestionFailureSchema = z.object({
  basis: suggestionBasisSchema,
  cause: z.object({
    kind: z.enum(SUGGESTION_FAILURE_KINDS), hostCode: z.string().optional(), message: z.string().optional(), reason: z.string().optional(),
    stage: z.enum(SUGGESTION_PARSE_STAGES).optional(), fields: z.array(z.string()).optional(),
  }),
  at: z.number(),
})
export type SuggestionFailure = z.infer<typeof suggestionFailureSchema>


const movedMemberSchema = z.object({ id: z.string(), from: z.string(), at: z.number() })
/** 做下去的一个索引操作（存盘形状，同 topic-ops.ts 的 IndexPlan）：带撤销要用的改前数据，说到记忆只有 id，手写的文字已遮过密钥。 */
export const indexPlanSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('assign'), page: z.string(), name: z.string(), isNew: z.boolean(), about: z.string().optional(), createdAt: z.number().optional(), moved: z.array(movedMemberSchema) }),
  z.object({ kind: z.literal('rename'), page: z.string(), from: z.string(), to: z.string(), aboutBefore: z.string(), aliasesBefore: z.array(z.string()) }),
  z.object({
    kind: z.literal('merge'), page: z.string(), name: z.string(), moved: z.array(movedMemberSchema),
    sources: z.array(z.object({
      page: z.string(), name: z.string(), aliases: z.array(z.string()), text: z.string(), body: z.string(),
      section: z.object({ text: z.string(), at: z.number() }).optional(),
    })),
    about: z.string().optional(), aboutBefore: z.string(), aliasesBefore: z.array(z.string()),
  }),
  z.object({ kind: z.literal('order-topics'), order: z.array(z.string()), before: z.array(z.string()) }),
  z.object({ kind: z.literal('order-members'), page: z.string(), order: z.array(z.string()), before: z.array(z.string()) }),
  z.object({ kind: z.literal('describe'), page: z.string(), about: z.string(), before: z.string() }),
]) satisfies z.ZodType<IndexPlan>

/**
 * 一个索引操作的回执：op 是那次操作的 id，plan 是做下去的计划。撤销按 plan 的效果判（见 topic-ops.ts undoPlan）。
 * 回执在写索引之前先记下，操作提交之后才标 isConfirmed；没标的是没做成的操作留下的，撤销不看它，整理收尾时清掉。
 */
export const indexReceiptSchema = z.object({ op: z.string(), plan: indexPlanSchema, isConfirmed: z.literal(true).optional() })
export type IndexReceipt = z.infer<typeof indexReceiptSchema>

/**
 * 一次整理索引：回执按做的先后，一个操作一条，提交后经操作日志步骤确认（中断后已做的照样有回执）；撤掉的那条随即拿掉。
 */
export const indexRunSchema = z.object({ receipts: z.array(indexReceiptSchema) })
export type IndexRun = z.infer<typeof indexRunSchema>

/**
 * 记忆梦境下钻补回的一个历史版本（versionKind recovered，不经变更集）：写版本文件之前先在批次条目上记下，撤销时按 op 找到那一版删掉。
 * op 是这次补回的操作 id，同时写进那一版的写入清单；versionId 是写下时的版本标识（之后换作用域可能改名，撤销按 op 认）。
 */
export const recoveredVersionReceiptSchema = z.object({ op: z.string(), memoryId: z.string(), scopeKey: z.string(), versionId: z.string(), at: z.number() })
export type RecoveredVersionReceipt = z.infer<typeof recoveredVersionReceiptSchema>

/** 报告里依据的一条消息：会话、序号、说话人，正文已遮盖、折成一行、截短。 */
export const drillExcerptSchema = z.object({ sessionId: z.string(), seq: z.number(), speaker: z.string(), text: z.string() })
export type DrillExcerpt = z.infer<typeof drillExcerptSchema>

/**
 * 记忆梦境一次运行的下钻报告（记在 brewing-dreams-run 批次条目上，运行收尾时写一次）。种类、原因是开放取值。
 * drills：实际读了几处（占名额的）；archivedSessionsRead：读了几个存档会话（按会话去重）；
 * unreadable：确认读不到的锚（会话没了、标了不回看、锚失效、锚那段没有可读的消息）；
 * filled：直接补上的（refine 的回执在 changes 里、id 等于 opId；recovered 的回执在 recoveredVersions 里、op 等于 opId）；
 * proposals：依据里有推断的，交给用户的稿（已遮盖）。
 */
export const drillDownReportSchema = z.object({
  drills: z.number().int().nonnegative(),
  archivedSessionsRead: z.number().int().nonnegative(),
  unreadable: z.array(z.object({ memoryId: z.string(), sessionId: z.string(), eventRange: z.tuple([z.number(), z.number()]), at: z.number(), reason: z.string() })),
  filled: z.array(z.object({ memoryId: z.string(), gap: z.string(), kind: z.string(), opId: z.string(), excerpts: z.array(drillExcerptSchema) })),
  proposals: z.array(z.object({
    memoryId: z.string(), gap: z.string(), kind: z.string(), content: z.string(),
    summary: z.string().optional(), factTime: z.string().optional(), reason: z.string().optional(), excerpts: z.array(drillExcerptSchema),
  })),
})
export type DrillDownReport = z.infer<typeof drillDownReportSchema>

export { linkIdsSchema, type LinkIds } from '../record-schema.ts'

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
  /**
   * 冲突：各成员的扫描指纹（副本身份 → 指纹，见 governance/checkup-plan.ts memberScanFingerprints），挂账和结清两边都留时写。
   * 有它的已裁决条目，再报同一冲突时冲突指纹和各成员扫描指纹都没变才算裁决过（事实时间、有效期这类冲突指纹不含的改动也算变了）；
   * 没有它的旧条目照旧只比冲突指纹。上一个发布版读到时丢掉它，写回后照旧只比冲突指纹。
   */
  memberScanFingerprints: z.record(z.string(), z.string()).optional(),
  /** 整理所选的应用（batch-edited）：逐项回执，与 memoryIds 同序。其余条目没有此字段。 */
  receipts: z.array(batchReceiptSchema).optional(),
  /** 整理索引（index-organize）、记忆梦境的一次运行（brewing-dreams-run）：这一次做过的索引操作。其余条目没有此字段。 */
  indexRun: indexRunSchema.optional(),
  /** 按变更集应用的条目：逐个操作的回执，按做的先后，一个操作提交后记一条、撤掉后拿掉（见 changeset.ts）。有它的条目撤销按它逐个还原字段。 */
  changes: z.array(changeReceiptSchema).optional(),
  /** 还没做完的组（见 ChangeOp.group）：开始前记上，做成或撤干净后拿掉。留在这里的是中断或没撤干净的，下次应用、撤销之前先按回执撤回。 */
  openGroups: z.array(z.string()).optional(),
  /** 记忆梦境的一次运行（brewing-dreams-run）：下钻补回的历史版本，一版一条，撤掉后拿掉。上一个发布版读到时丢掉它。 */
  recoveredVersions: z.array(recoveredVersionReceiptSchema).optional(),
  /** 记忆梦境的一次运行（brewing-dreams-run）：这次的下钻报告。上一个发布版读到时丢掉它。 */
  drillDown: drillDownReportSchema.optional(),
  /** 只挂关联、前提的保存（link）：这一次新加的 id（已有的不算）。撤销只去掉这些。其余条目没有此字段。 */
  links: linkIdsSchema.optional(),
  /** 模型改写、替代：哪个会话里哪次 memory_save 调用改的（对话卡按 callId、右侧栏按 sessionId 认领）；替代时 by 是替代它的那条。 */
  origin: z.object({ sessionId: z.string(), callId: z.string(), by: z.string().optional() }).optional(),
  /** 冲突：模型给的处理建议，见 storedSuggestionSchema。依据版本对不上时视图当作没有建议。其余条目没有此字段。 */
  suggestion: storedSuggestionSchema.optional(),
  /**
   * 体检给的方案（新发现种类上）：漏记的变化建议并成版本、哪一条留作当前状态页（current 是这一对里的一条）；
   * 跨项目重复建议把哪一条升为全局（memoryId 是这一组里的一条）。模型没给或给的不在条目里时没有这一项。
   */
  plan: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('as-versions'), current: z.string() }),
    z.object({ kind: z.literal('promote'), memoryId: z.string() }),
  ]).optional(),
  /**
   * 横向的疑似矛盾报出之前回查两边出处的结果：checked 两边都读到、核实过；unreadable 有一边读不到（没有出处、会话读不出、
   * 用户标了不回看）；unchecked 这次没读（超出一次体检的回查上限，或核实那次调用没做成）。没回查过的（纵向冲突、旧条目）没有这一项。
   */
  sourceCheck: z.enum(['checked', 'unreadable', 'unchecked']).optional(),
  /**
   * 依据已变（premise-changed）条目是怎么来的：'related' 是沿关联发的复查信号（实验，见 tools/related-recheck.ts），
   * 实验开关关掉后体检按它认出、删掉未结清的；没有这个字段的是体检按前提判的。读的一侧放开取值：不认识的值照读，不据此动手。
   * 上一个发布版不认识 premise-changed 种类，整条跳过。
   */
  via: z.string().optional(),
  /** 「重要、等你定」：方案的改动性质（有方案时才有）。 */
  change: z.enum(TIER_CHANGE_KINDS).optional(),
  /** 「重要、等你定」：方案依据的会话事件（有方案时才有）。 */
  evidence: z.array(evidenceRefSchema).optional(),
  /** 「重要、等你定」：记忆梦境留的原因、结论身份和方案，见 dreamsHoldSchema。 */
  dreamsHold: dreamsHoldSchema.optional(),
  /** 配对发现：记忆梦境核实过、交给用户的记录，见 dreamsReviewSchema。两边扫描指纹变了就不算数。 */
  dreamsReview: dreamsReviewSchema.optional(),
  /** 记忆梦境的批次条目：这次直接处理掉的矛盾，重要的在前，见 dreamsResultSchema。 */
  dreamsResults: z.array(dreamsResultSchema).optional(),
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
   * droppedLinks：换作用域时越界去掉的关联和前提（promoted、moved 上，没去掉的不记）。撤销提升核对全局那份时按「改前快照去掉这些」比，
   * 快照恢复时它们随作用域一起回来；撤销移到项目时从改前快照放回去。放回来的都按要回到的作用域再重验一次。
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
    /** plan-applied：结清前各成员的内容指纹（撤销时还原）；结清前条目没有的不记。上一个发布版读到时丢掉它。 */
    priorMemberScanFingerprints: z.record(z.string(), z.string()).optional(),
    droppedLinks: linkIdsSchema.optional(),
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
  'missed-change', 'exception', 'premise-changed', // 只进账本（见 LEDGER_ONLY_FINDING_TYPES）
] as const
export type FindingType = (typeof FINDING_TYPES)[number]

/**
 * 只进待决账本的发现：漏记的变化、例外（语义层）和依据已变（代码按前提摘要判，规则层）。它们出现在体检结果库的行里和 memory_scan 的结果里，
 * 不写进体检视图（语义缓存是 0.2.0 也读的侧表，它不认识这几个类型，整条视图会被它跳过），也不计健康分。
 */
export const LEDGER_ONLY_FINDING_TYPES = ['missed-change', 'exception', 'premise-changed'] as const satisfies readonly FindingType[]
export type LedgerOnlyFindingType = (typeof LEDGER_ONLY_FINDING_TYPES)[number]

export const SEVERITY_BY_TYPE = {
  secret: 'critical', conflict: 'critical',
  expired: 'warning', misplaced: 'warning', bloat: 'warning', malformed: 'warning', 'premise-changed': 'warning',
  redundancy: 'info', unclear: 'info', orphan: 'info', 'missed-change': 'info', exception: 'info',
} as const satisfies Record<FindingType, 'critical' | 'warning' | 'info'>

export const findingSchema = z.object({
  type: z.enum(FINDING_TYPES),
  layer: z.enum(['rule', 'semantic']),
  severity: z.enum(['critical', 'warning', 'info']),
  memoryIds: z.array(z.string()),
  summary: z.string(),
  suggestedAction: z.string(),
  baselineRef: z.string().optional(),
  /** 漏记的变化：模型建议留作当前状态页的那一条（memoryIds 里的一条）；不在 memoryIds 里的解析时丢掉。 */
  current: z.string().optional(),
  /** 横向冲突回查出处的结果（见 PendingDecision.sourceCheck），随这一批的结论存进体检结果库，命中时照用。 */
  sourceCheck: z.enum(['checked', 'unreadable', 'unchecked']).optional(),
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
