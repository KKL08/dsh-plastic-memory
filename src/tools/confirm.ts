import type { MemoryLogger, MemoryStore } from '../store.ts'
import { conflictFingerprint, isBaselineCurrent, isBasisCurrent, type PendingDecisionsStore } from '../governance/decisions.ts'
import { baselineFor, type ReadInstructions } from '../governance/instructions.ts'
import { FINDING_LEDGER_KINDS, resolveVerdictsOf, kindOf, verdictLoser, type PendingDecision, type ResolveVerdict, type SettledProposal, type SuggestionBasis } from '../governance/schema.ts'
import { editFingerprint, type SnapshotStore } from '../governance/snapshots.ts'
import { ALREADY_REVIEWED_REASON, NOT_DELEGATED_REASON, isPendingDelegated, type MemoryRecord } from '../record-schema.ts'
import { verdictOfAction, type AcceptRejectCode, type DecisionRejectCode, type GovernanceRejectCode, type GroupAcceptSkipCode, type ProposalAction } from '../contract-codes.ts'
import { duplicateComparison, findNearDuplicate, listSimilar, NEAR_DUPLICATE_THRESHOLD, type SimilarMemory } from '../create-gate.ts'
import { findTopicCandidates, topicGroupOf, type TopicScope } from '../search/topic-context.ts'
import { topicDisplayName } from '../topic-members.ts'
import { UNSORTED_TITLE } from '../topic-index.ts'
import { injectionText } from '../index-line.ts'
import { charSimilarity } from '../text.ts'
import { isCompleteRead } from './dreams-run.ts'
import type { QueryTokenizerOptions } from '../search/jieba-segmenter.ts'
import { RecordNotFoundError } from '../errors.ts'
import { crossWorkspaceNote, gateRecords, locateCopy, type CrossWorkspaceRejection, type GovernanceContext, type OtherWorkspaceMark } from './workspace-gate.ts'
import { scopeOfLedger, scopeOfMemory, type Scope } from '../scope.ts'
import { executeForget } from './forget.ts'
import { memberScanFingerprints } from '../governance/checkup-plan.ts'
import { hasCriticalSecret, maskSecretSurface } from '../secrets.ts'
import { copyKey } from '../governance/changeset.ts'
import { versionPlan } from '../governance/changeset-plans.ts'
import { applyChangeset } from './changeset.ts'

export interface ConfirmToolDeps {
  store: MemoryStore
  decisions: PendingDecisionsStore
  snapshots: SnapshotStore
  now?: () => number
  /** 日志注入口（裁决删败方走 forget，它记删除日志），缺省回退 console。 */
  log?: MemoryLogger
  /**
   * 按作用域取指令文件。resolve 垂直冲突时取这条记忆对应的那份（项目记忆是它所在项目的，全局记忆是全局层的），
   * 用来核对采纳的依据、给没有指纹的旧条目现算两边都留的指纹；界面和 agent 工具用同一个来源。
   */
  instructions: ReadInstructions
  /** 成组接受分组、比重叠时的候选检索分词器选项（用户词典、降级日志），同新建闸；缺省不带用户词典。 */
  tokenizer?: QueryTokenizerOptions
}

/**
 * allowCrossWorkspace：用户明确选择「全局整理」时才为 true，放行其他项目的记录（见 workspace-gate.ts）。
 * resolve 的 verdict 按待决项的种类取 VERDICTS_BY_KIND 里的值，表外的组合回 invalid-args、条目不动。
 * current 只给 as-versions 用：留作当前状态页的那一条，必须是这一对里的一条（缺省或不在这一对里回 invalid-args）。
 * 可用的裁决按条目取 resolveVerdictsOf：「重要、等你定」（important-pending）是它原来那种发现的裁决，带梦境方案的另有 adopt；adopt 只对它有效。
 */
export type ConfirmArgs =
  | { action: 'refresh'; memoryId: string; allowCrossWorkspace?: boolean }
  | { action: 'resolve'; decisionId: string; verdict: ResolveVerdict | 'adopt'; current?: string; allowCrossWorkspace?: boolean }
  | { action: 'accept-subagent'; memoryId: string; memoryIds?: undefined; allowCrossWorkspace?: boolean }
  /** 成组接受：memoryIds 一次接受一批；和 memoryId 只给一个（同时给、给空数组、都不给回 invalid-args）。 */
  | { action: 'accept-subagent'; memoryId?: string; memoryIds?: readonly string[]; allowCrossWorkspace?: boolean }

/** 成组接受里一条的结果。 */
export type GroupAcceptOutcome =
  | { kind: 'accepted'; lastConfirmedAt: number }
  /** reason 是给模型看的原因：not-subagent-pending 取 notPendingReason 那句，其余取 GROUP_ACCEPT_REASONS。 */
  | { kind: 'skipped'; code: GroupAcceptSkipCode; reason: string }

/** 一条和在用记忆的重叠，按新建闸同一套判法（create-gate 的 findNearDuplicate、listSimilar）。 */
export interface GroupAcceptOverlap {
  /** 近乎重复的那条；没有时不带。 */
  duplicateOf?: SimilarMemory
  /** 相近的，不含 duplicateOf 那条。 */
  similar: SimilarMemory[]
}

/** 进了分组的一条（定位到、过了跨项目门的）。名称、摘要遮盖密钥后折成一行（injectionText）。 */
export interface GroupAcceptItem {
  memoryId: string
  name: string
  summary: string
  outcome: GroupAcceptOutcome
  /** 这条的候选检索出错时不带。 */
  overlap?: GroupAcceptOverlap
}

/** 一组：一个主题（作用域 + 主题页）、「未整理」，或分组数据读不到时的唯一一组。 */
export interface GroupAcceptGroup {
  /** 全局主题组是「global:主题页文件名」，项目主题组是「workspace:项目路径:主题页文件名」；「未整理」是 unsorted，读不到时是 flat。一次结果里不重复。 */
  key: string
  kind: 'topic' | 'unsorted' | 'flat'
  /** 主题组：topicDisplayName，全局主题后面加 GROUP_ACCEPT_TEXT.globalMark；「未整理」：UNSORTED_TITLE；flat：GROUP_ACCEPT_TEXT.unreadable。 */
  title: string
  /** 只有主题组带：主题所在的作用域。 */
  scope?: TopicScope
  /** 按 memoryIds 去重后的先后。 */
  items: GroupAcceptItem[]
  /** 组内两两比较文字相似度 ≥ NEAR_DUPLICATE_THRESHOLD 的成对 id，每对按批内先后，各对按（前一个，后一个）的批内先后。 */
  nearDuplicatePairs: Array<[string, string]>
}

/** 成组接受的结果。没有一条接受上也是这个 kind。 */
export interface GroupAcceptResult {
  kind: 'group-accepted'
  /** topics：按主题分组；unreadable：分组数据读不到，groups 只有一组 flat。 */
  grouping: 'topics' | 'unreadable'
  /** 主题组按其第一条在批内的先后，「未整理」最后；没有定位到任何一条时为空。 */
  groups: GroupAcceptGroup[]
  /** 没进分组的：not-found、unreadable、cross-workspace，按批内先后。 */
  ungrouped: Array<{ memoryId: string; outcome: Extract<GroupAcceptOutcome, { kind: 'skipped' }> }>
  /** 接受上的 id，按批内先后。 */
  acceptedIds: string[]
  /** 带 allowCrossWorkspace 放行的其他项目的记录。 */
  otherWorkspaces: OtherWorkspaceMark[]
  /** 被跨项目门挡下的记录。 */
  rejected: CrossWorkspaceRejection[]
  message: string
}

/** 成组接受结果文字里的固定片段：措辞由提示词审查定稿，测试按常量比较。 */
export const GROUP_ACCEPT_TEXT = {
  accepted: '已接受',
  skipped: '没接受',
  duplicateOf: '和已有记忆近乎重复',
  similar: '相近的已有记忆',
  pairs: '组内近乎重复',
  ungrouped: '没有分组的',
  globalMark: '（全局）',
  groupingNote: '分组只用于这次查看：接受的记忆先进「未整理」，整理索引时再归主题。',
  unreadable: '分组数据读不到，下面逐条列出',
  mergeGuide: '要把重叠的几条合成一条：先对留下的那条调 memory_save（action=update），写进合并后的内容；再对其余几条调 memory_forget。',
} as const

/** 成组接受一条没接受的原因（not-subagent-pending 用 notPendingReason 的那几句，不在这里）。 */
export const GROUP_ACCEPT_REASONS = {
  'cross-workspace': '属于其他项目，只有用户明确选择「全局整理」后才能带 allowCrossWorkspace: true 操作',
  'not-found': '不存在',
  unreadable: '读不到',
  'missing-at-write': '读到之后在原来的作用域里找不到了（被删除、挪走或读不出）',
  'write-failed': '写入出错，不确定接受上没有；可以单独重发这一条，已经接受过的会回「已经被接受了」',
} as const satisfies Record<Exclude<GroupAcceptSkipCode, 'not-subagent-pending'>, string>

/** accept-subagent 参数组合不合法时的说法（code 为 invalid-args，什么都没动）。 */
export const GROUP_ACCEPT_INVALID = {
  both: 'memoryId 和 memoryIds 只给一个：接受一条用 memoryId，接受一批用 memoryIds。未做改动。',
  empty: 'memoryIds 是空的：给出要接受的待确认记忆 id。未做改动。',
  none: 'accept-subagent 要给 memoryId（接受一条）或 memoryIds（接受一批）。未做改动。',
} as const

/** 只给 GUI 用的选项，不在工具参数里，模型传不进来。 */
export interface ConfirmOptions {
  /** refresh 时同 id 多副本只认这一份（GUI 按页面上那一份操作）；缺省按会话 workspace 定位。跨 workspace 门照旧按会话判定。 */
  target?: Scope
  /**
   * resolve 是在落盘一份处理方案：条目上的这份处理建议（GUI「采纳建议」，suggestionId），或界面带回的按要求生成的方案
   * （GUI「补充要求」，request：结论和生成时的依据版本）。认领条目后核对建议 id（按要求的没有这一项）、结论和裁决对得上、
   * 依据版本仍是此刻的，对不上回 stale、什么都不动；删败方时锁内按依据里它的完整内容指纹再比一次。结清时记下来源和结论代码。
   * 垂直冲突另按这条记忆此刻对应的指令文件（deps.instructions）重算依据里的基线，对不上同样回 stale。
   */
  adopt?: { suggestionId: string } | { request: { action: ProposalAction; basis: SuggestionBasis } }
}

/**
 * otherWorkspaces：带参数放行、属于其他项目的记录；error 带 code 时 rejected 列出被拒记录。
 * isUnrecorded：两边都留，但条目没有指纹、也现算不出（垂直冲突取不到或没有这条记忆对应的指令文件），结论没记下，条目已移出账本。
 * isHardDeleted：败方含高危密钥，已物理删除、不可恢复，条目已移出账本，没有撤销。
 */
export type ConfirmResult =
  | SettleResult
  | { kind: 'accepted'; memoryId: string; lastConfirmedAt: number; otherWorkspaces: OtherWorkspaceMark[]; message: string }
  | GroupAcceptResult
  | ConfirmError<AcceptRejectCode>

/** refresh、resolve 的结果，不带 accept-subagent 的拒绝码（GUI 只调这两个动作）。 */
export type SettleResult =
  | { kind: 'refreshed'; memoryId: string; lastConfirmedAt: number; otherWorkspaces: OtherWorkspaceMark[]; message: string }
  | {
    kind: 'resolved'; decisionId: string; verdict: string; actions: string[]; alsoCleared: number; otherWorkspaces: OtherWorkspaceMark[]
    isUnrecorded?: true; isHardDeleted?: true; message: string
  }
  | ConfirmError<GovernanceRejectCode | DecisionRejectCode>

type ConfirmError<C extends string> = { kind: 'error'; code?: C; rejected?: CrossWorkspaceRejection[]; message: string }

/**
 * memory_confirm：refresh 刷新新鲜度；resolve 裁决待决冲突；accept-subagent 把子 agent 存的待确认记录接受为本项目主档。
 * verdict 约定：横向冲突 left=memoryIds[0]、right=memoryIds[1]；
 * 垂直冲突（有 baselineRef）left=记忆、right=基线（基线不可删，keep-right 意为记忆过时删除）。
 */
export async function executeConfirm(
  rawArgs: Exclude<ConfirmArgs, { action: 'accept-subagent' }>, context: GovernanceContext, deps: ConfirmToolDeps, options?: ConfirmOptions,
): Promise<SettleResult>
export async function executeConfirm(rawArgs: unknown, context: GovernanceContext, deps: ConfirmToolDeps, options?: ConfirmOptions): Promise<ConfirmResult>
export async function executeConfirm(
  rawArgs: unknown,
  context: GovernanceContext,
  deps: ConfirmToolDeps,
  options: ConfirmOptions = {},
): Promise<ConfirmResult> {
  const args = rawArgs as ConfirmArgs
  const now = deps.now?.() ?? Date.now()
  // 预读范围：按 id 两级定位单条记录（含非 active，当前 workspace 优先，由下方逐处判 deleted）与账本单条目，不预读整层
  const locate = (id: string) => deps.store.get(id, { workspacePath: context.workspacePath })

  if (args.action === 'refresh') {
    const target = options.target === undefined ? await locate(args.memoryId) : await locateCopy(deps.store, args.memoryId, options.target)
    if (!target || target.status === 'deleted') {
      return { kind: 'error', message: `记忆不存在或已删除：${args.memoryId}` }
    }
    const { rejected, otherWorkspaces } = gateRecords([target], context, args.allowCrossWorkspace)
    if (rejected.length > 0) {
      return { kind: 'error', code: 'cross-workspace', rejected, message: `未刷新记忆 ${args.memoryId}。${crossWorkspaceNote(rejected, [])}` }
    }
    // refresh 不是内容编辑，updatedAt 保持为最近一次内容修改的时刻；lastConfirmedAt 独立记录确认动作
    // （快照恢复按内容投影判断"快照后被修改"，不看 updatedAt，见 governance/snapshots.ts restoreProjection）。
    // 读到之后被别处删掉（硬删或软删）：与预读时就不在同一个答复
    // 指明了副本的按同一个作用域写回：别的作用域里同 id 的副本再新也不改到它头上
    if (!(await deps.store.updateIfLive(target, r => ({ ...r, lastConfirmedAt: now }), options.target))) {
      return { kind: 'error', message: `记忆不存在或已删除：${args.memoryId}` }
    }
    return {
      kind: 'refreshed', memoryId: args.memoryId, lastConfirmedAt: now, otherWorkspaces,
      message: `已确认记忆 ${args.memoryId} 仍然准确，新鲜度已刷新。${crossWorkspaceNote([], otherWorkspaces)}`,
    }
  }

  if (args.action === 'accept-subagent') {
    if (args.memoryIds !== undefined || args.memoryId === undefined) return acceptSubagentGroup(args, context, deps, now)
    return acceptSubagent({ ...args, memoryId: args.memoryId }, context, deps, now, locate)
  }

  // 先认领条目再裁决：两条相反的裁决同时到（两个标签页、两个宿主进程），只让一条删败方，另一条什么都不动
  const claimed = await deps.decisions.withClaim(args.decisionId, () => resolveClaimed(args, context, deps, now, locate, options))
  if (!claimed.isClaimed) {
    return { kind: 'error', code: 'claimed', message: `待决项 ${args.decisionId} 正在被另一次裁决处理，未做任何改动。` }
  }
  return claimed.value
}

/** 锁内发现目标不是在用的待确认记录：不写盘，带着原因退出 store.update。 */
class NotPendingError extends Error {}

/** 目标为什么不能接受；是在用的待确认记录返回 undefined。 */
function notPendingReason(record: MemoryRecord): string | undefined {
  if (record.status === 'deleted') return '已删除'
  if (record.status === 'superseded') return '已被取代'
  if (record.delegation === undefined) return NOT_DELEGATED_REASON
  if (!isPendingDelegated(record)) return record.delegation.reviewed?.by === 'user' ? '用户已经改过' : ALREADY_REVIEWED_REASON
  return undefined
}

/**
 * accept-subagent：只写 reviewed（by main）和 lastConfirmedAt，其余字段含 validTo 不动（不延长有效期）。
 * 状态在 store.update 锁内按磁盘上的当前内容判，读到之后被删、被取代、被接受的都不写。不入账本、不拍快照：
 * 内容没变，要撤就删。
 */
async function acceptSubagent(
  args: { memoryId: string; allowCrossWorkspace?: boolean },
  context: GovernanceContext,
  deps: ConfirmToolDeps,
  now: number,
  locate: (id: string) => Promise<MemoryRecord | undefined>,
): Promise<ConfirmResult> {
  const target = await locate(args.memoryId)
  if (!target) return { kind: 'error', message: `记忆不存在：${args.memoryId}` }
  const { rejected, otherWorkspaces } = gateRecords([target], context, args.allowCrossWorkspace)
  if (rejected.length > 0) {
    return { kind: 'error', code: 'cross-workspace', rejected, message: `未接受记忆 ${args.memoryId}。${crossWorkspaceNote(rejected, [])}` }
  }
  let accepted: MemoryRecord
  try {
    accepted = await writeSubagentAcceptance(target, deps.store, now)
  } catch (err) {
    if (err instanceof RecordNotFoundError) return { kind: 'error', message: `记忆不存在：${args.memoryId}` }
    if (!(err instanceof NotPendingError)) throw err
    return {
      kind: 'error', code: 'not-subagent-pending',
      message: `记忆 ${args.memoryId} ${err.message}，不是待确认的子 agent 记忆，未做改动。accept-subagent 只接受子 agent 存的、还在用的待确认记忆。`,
    }
  }
  return {
    kind: 'accepted', memoryId: args.memoryId, lastConfirmedAt: accepted.lastConfirmedAt, otherWorkspaces,
    message: `已接受子 agent 存的记忆 ${args.memoryId}，不再待确认，和本项目其他记忆一样注入、检索。${crossWorkspaceNote([], otherWorkspaces)}`,
  }
}

/** 单条和成组共用锁内写回：只动定位到的那一层，接受时间不早于当前记录的修改、确认时间。 */
async function writeSubagentAcceptance(target: MemoryRecord, store: MemoryStore, now: number): Promise<MemoryRecord> {
  const scope = scopeOfMemory(target)
  if (scope === undefined) throw new RecordNotFoundError(target.id)
  return store.update(target, (cur) => {
    const why = notPendingReason(cur)
    if (why !== undefined) throw new NotPendingError(why)
    const at = Math.max(now, cur.updatedAt, cur.lastConfirmedAt)
    return { ...cur, lastConfirmedAt: at, delegation: { ...cur.delegation!, reviewed: { by: 'main', at } } }
  }, scope)
}

/**
 * accept-subagent 带 memoryIds（或参数组合不合法）：先核参数组合，再逐条（按去重后的先后、一条一次写入段）照单条的口径接受，
 * 一条没接受不影响其余几条、不回滚已接受的；再按主题分组、标出组内近重复和与在用记忆的重叠。分组只读、不调模型、不写索引，
 * 分组出错不影响接受。不入账本、不拍快照、不写回执。
 */
async function acceptSubagentGroup(
  args: Extract<ConfirmArgs, { action: 'accept-subagent' }>,
  context: GovernanceContext,
  deps: ConfirmToolDeps,
  now: number,
): Promise<ConfirmResult> {
  if (args.memoryId !== undefined && args.memoryIds !== undefined) return { kind: 'error', code: 'invalid-args', message: GROUP_ACCEPT_INVALID.both }
  if (args.memoryIds === undefined) return { kind: 'error', code: 'invalid-args', message: GROUP_ACCEPT_INVALID.none }
  if (args.memoryIds.length === 0) return { kind: 'error', code: 'invalid-args', message: GROUP_ACCEPT_INVALID.empty }

  const ids = [...new Set(args.memoryIds)]
  const acceptedIds: string[] = []
  const ungrouped: GroupAcceptResult['ungrouped'] = []
  const rejected: CrossWorkspaceRejection[] = []
  const otherWorkspaces: OtherWorkspaceMark[] = []
  const located: Array<{ record: MemoryRecord; item: GroupAcceptItem }> = []
  let isReadComplete: boolean | undefined
  const skip = (memoryId: string, code: keyof typeof GROUP_ACCEPT_REASONS) => {
    ungrouped.push({ memoryId, outcome: { kind: 'skipped', code, reason: GROUP_ACCEPT_REASONS[code] } })
  }
  for (const memoryId of ids) {
    let target: MemoryRecord | undefined
    try {
      target = await deps.store.get(memoryId, { workspacePath: context.workspacePath })
    } catch {
      skip(memoryId, 'unreadable')
      continue
    }
    if (target === undefined) {
      // 会话视角会查其他项目和归档；只有这些目录都读全了，才能把定位不到说成不存在。
      if (isReadComplete === undefined) {
        try {
          isReadComplete = isCompleteRead(await deps.store.readRaw(undefined, { includeArchive: true }))
        } catch {
          isReadComplete = false
        }
      }
      skip(memoryId, isReadComplete ? 'not-found' : 'unreadable')
      continue
    }
    const gate = gateRecords([target], context, args.allowCrossWorkspace)
    rejected.push(...gate.rejected)
    otherWorkspaces.push(...gate.otherWorkspaces)
    if (gate.rejected.length > 0) {
      skip(memoryId, 'cross-workspace')
      continue
    }
    let outcome: GroupAcceptOutcome
    try {
      const accepted = await writeSubagentAcceptance(target, deps.store, now)
      outcome = { kind: 'accepted', lastConfirmedAt: accepted.lastConfirmedAt }
      acceptedIds.push(memoryId)
    } catch (err) {
      if (err instanceof NotPendingError) outcome = { kind: 'skipped', code: 'not-subagent-pending', reason: err.message }
      else {
        const code = err instanceof RecordNotFoundError ? 'missing-at-write' : 'write-failed'
        outcome = { kind: 'skipped', code, reason: GROUP_ACCEPT_REASONS[code] }
      }
    }
    const masked = maskSecretSurface(target, { severity: 'suspected' })
    located.push({ record: target, item: { memoryId, name: injectionText(masked.name), summary: injectionText(masked.summary), outcome } })
  }

  const grouped = new Map<string, GroupAcceptGroup>()
  let grouping: GroupAcceptResult['grouping'] = 'topics'
  for (const { record, item } of located) {
    let set: Awaited<ReturnType<typeof findTopicCandidates>>
    try {
      set = await findTopicCandidates({
        query: `${record.name}\n${record.summary}\n${record.content}`,
        scope: { kind: 'visible', workspacePath: record.workspacePath },
        includesNotYetInEffect: true,
      }, { store: deps.store, tokenizer: deps.tokenizer, now: () => now })
    } catch {
      grouping = 'unreadable'
      continue
    }
    const excludeIds = new Set([...ids, ...set.candidates.filter(c => isPendingDelegated(c.record)).map(c => c.record.id)])
    const duplicateOf = findNearDuplicate(record, set, { excludeIds })
    const similar = listSimilar(record, set, { excludeIds }).filter(s => s.id !== duplicateOf?.id)
    item.overlap = { ...(duplicateOf === undefined ? {} : { duplicateOf }), similar }
    const nearest = set.candidates.find(c => !excludeIds.has(c.record.id))?.record
    if (nearest !== undefined && set.topics.unreadable.includes(nearest.scope === 'global' ? 'global' : 'workspace')) {
      grouping = 'unreadable'
      continue
    }
    const topic = nearest === undefined ? undefined : topicGroupOf(set.topics, nearest)
    const group: GroupAcceptGroup = topic === undefined || topic.isUnsorted
      ? { key: 'unsorted', kind: 'unsorted', title: UNSORTED_TITLE, items: [], nearDuplicatePairs: [] }
      : {
        key: topic.scope === 'global' ? `global:${topic.fileName}` : `workspace:${record.workspacePath}:${topic.fileName}`, kind: 'topic', scope: topic.scope,
        title: topicDisplayName(topic) + (topic.scope === 'global' ? GROUP_ACCEPT_TEXT.globalMark : ''), items: [], nearDuplicatePairs: [],
      }
    if (!grouped.has(group.key)) grouped.set(group.key, group)
    grouped.get(group.key)!.items.push(item)
  }
  const groups: GroupAcceptGroup[] = grouping === 'unreadable'
    ? [{ key: 'flat', kind: 'flat', title: GROUP_ACCEPT_TEXT.unreadable, items: located.map(l => l.item), nearDuplicatePairs: [] }]
    : [...grouped.values()].sort((a, b) => Number(a.kind === 'unsorted') - Number(b.kind === 'unsorted'))
  // 比较始终用定位时的原文，展示的遮盖、折行不会影响近重复判定。
  const comparisons = new Map(located.map(l => [l.item.memoryId, duplicateComparison(l.record)]))
  for (const group of groups) {
    for (let i = 0; i < group.items.length; i++) {
      for (let j = i + 1; j < group.items.length; j++) {
        const first = group.items[i]!.memoryId
        const second = group.items[j]!.memoryId
        if (charSimilarity(comparisons.get(first)!, comparisons.get(second)!, NEAR_DUPLICATE_THRESHOLD) >= NEAR_DUPLICATE_THRESHOLD) group.nearDuplicatePairs.push([first, second])
      }
    }
  }
  const result: GroupAcceptResult = { kind: 'group-accepted', grouping, groups, ungrouped, acceptedIds, otherWorkspaces, rejected, message: '' }
  result.message = groupAcceptMessage(result, ids.length)
  return result
}

function groupAcceptMessage(result: GroupAcceptResult, total: number): string {
  const lines = [`已接受 ${result.acceptedIds.length} 条，没接受 ${total - result.acceptedIds.length} 条。`]
  if (result.grouping === 'topics' && result.groups.length > 0) lines.push(GROUP_ACCEPT_TEXT.groupingNote)
  for (const group of result.groups) {
    lines.push('', `【${group.title}】`)
    for (const item of group.items) {
      const outcome = item.outcome.kind === 'accepted' ? GROUP_ACCEPT_TEXT.accepted : `${GROUP_ACCEPT_TEXT.skipped}：${item.outcome.reason}`
      lines.push(`- ${injectionText(item.memoryId)}「${item.name}」：${item.summary}——${outcome}`)
      if (item.overlap?.duplicateOf !== undefined) {
        const duplicate = item.overlap.duplicateOf
        lines.push(`  ${GROUP_ACCEPT_TEXT.duplicateOf}：${injectionText(duplicate.id)}「${duplicate.name}」`)
      }
      if (item.overlap !== undefined && item.overlap.similar.length > 0) {
        lines.push(`  ${GROUP_ACCEPT_TEXT.similar}：${item.overlap.similar.map(s => `${injectionText(s.id)}「${s.name}」${s.scope === 'global' ? GROUP_ACCEPT_TEXT.globalMark : ''}`).join('、')}`)
      }
    }
    for (const [first, second] of group.nearDuplicatePairs) lines.push(`${GROUP_ACCEPT_TEXT.pairs}：${injectionText(first)} 和 ${injectionText(second)}`)
  }
  if (result.ungrouped.length > 0) {
    lines.push('', `【${GROUP_ACCEPT_TEXT.ungrouped}】`)
    for (const item of result.ungrouped) lines.push(`- ${injectionText(item.memoryId)}——${GROUP_ACCEPT_TEXT.skipped}：${item.outcome.reason}`)
  }
  lines.push('', GROUP_ACCEPT_TEXT.mergeGuide)
  return lines.join('\n')
}

/** 持有认领时裁决：条目在认领之后重读，刚被别人裁决完的这里读不到。 */
async function resolveClaimed(
  args: Extract<ConfirmArgs, { action: 'resolve' }>,
  context: GovernanceContext,
  deps: ConfirmToolDeps,
  now: number,
  locate: (id: string) => Promise<MemoryRecord | undefined>,
  options: ConfirmOptions,
): Promise<ConfirmResult> {
  let entry = await deps.decisions.get(args.decisionId)
  if (!entry) {
    return { kind: 'error', code: 'not-found', message: `待决项不存在：${args.decisionId}（可能已被裁决或涉及的记忆已删除）` }
  }

  // 提升候选、超限提醒不是冲突，不能按 memoryIds 位置裁决（否则可能删掉候选记忆）；条目不动
  if (kindOf(entry) !== 'important-pending' && !(FINDING_LEDGER_KINDS as readonly string[]).includes(kindOf(entry))) {
    return { kind: 'error', message: `待决项 ${entry.id} 不是冲突（${kindOf(entry)}），不能用 resolve 裁决，账本条目保留。` }
  }

  const allowed: readonly string[] = resolveVerdictsOf(entry)
  if (!allowed.includes(args.verdict)) {
    return { kind: 'error', code: 'invalid-args', message: `这种待决项可用的裁决：${allowed.join('、')}。条目保留。` }
  }
  if (args.verdict === 'adopt') return adoptDreams(entry, args, context, deps, now)
  // 仅在内存里按原发现分流；失败时账本仍保留待确认状态，结清时由 settle 转换种类。
  if (kindOf(entry) === 'important-pending' && entry.dreamsHold !== undefined) entry = { ...entry, kind: entry.dreamsHold.fromKind }
  // 并成版本在落盘前还没有删除回执，须独立认领这一对，不能用 verdictLoser 决定。
  if (args.verdict === 'as-versions') {
    if (entry.baselineRef !== undefined || entry.memoryIds.length !== 2 || entry.memoryIds[0] === entry.memoryIds[1] || args.current === undefined || !entry.memoryIds.includes(args.current)) {
      return { kind: 'error', code: 'invalid-args', message: '并成版本需要两条不同的横向记忆，并用 current 指定其中一条留作当前页。' }
    }
    const paired = await deps.decisions.withPairClaim(entry, () => resolveVersions(entry, args, context, deps, now, locate))
    if (!paired.isClaimed) return { kind: 'error', code: 'claimed', message: `待决项 ${entry.id} 的这一对记忆正在被另一次操作处理，未做任何改动。` }
    return paired.value
  }

  if (verdictLoser(entry, args.verdict) === undefined) return resolveEntry(entry, args, context, deps, now, locate, options)
  // 要删一方的裁决再认领冲突身份：账本里同一对有两条条目时（旧版本并发挂账留下的，下次体检才收拢），两条相反的裁决
  // 各认领各的条目、都读到双方在用，会各删一方。认领之后才定位双方，后到的一条什么都不动
  const paired = await deps.decisions.withPairClaim(entry, () => resolveEntry(entry, args, context, deps, now, locate, options))
  if (!paired.isClaimed) {
    return { kind: 'error', code: 'claimed', message: `待决项 ${entry.id} 的这一对记忆正在被另一次操作处理，未做任何改动。` }
  }
  return paired.value
}

/** 采纳梦境方案时精确读取所有参与副本，跨项目许可通过后再交给变更集核对依据。 */
async function adoptDreams(
  entry: PendingDecision,
  args: Extract<ConfirmArgs, { action: 'resolve' }>,
  context: GovernanceContext,
  deps: ConfirmToolDeps,
  now: number,
): Promise<ConfirmResult> {
  const proposal = entry.dreamsHold!.proposal!
  const copies = new Map(proposal.ops.flatMap(op => [op, ...op.basis, ...(op.into === undefined ? [] : [op.into])])
    .map(ref => [copyKey(ref), ref]))
  const records: MemoryRecord[] = []
  for (const ref of copies.values()) {
    const record = await locateCopy(deps.store, ref.memoryId, scopeOfLedger(ref.scopeKey))
    if (record === undefined || hasCriticalSecret(record)) return { kind: 'error', code: 'stale', message: '方案里的记忆已读不到或含高危密钥，保留条目，请重新体检。' }
    records.push(record)
  }
  const { rejected, otherWorkspaces } = gateRecords(records, context, args.allowCrossWorkspace)
  if (rejected.length > 0) return { kind: 'error', code: 'cross-workspace', rejected, message: `未裁决待决项 ${entry.id}，账本条目保留。${crossWorkspaceNote(rejected, [])}` }
  const paired = await deps.decisions.withPairClaim(entry, async (): Promise<ConfirmResult> => {
    const result = await applyChangeset(proposal.ops,
      { entryId: entry.id, by: 'main', at: now, isSecretChecked: false, isSecret: hasCriticalSecret }, deps)
    if (result.groups?.[0]?.state !== 'applied') return { kind: 'error', code: 'stale', message: '梦境方案的依据已失效，保留条目，请重新体检。' }
    await deps.decisions.settle(entry.id, 'adopt', now)
    const older = entry.memoryIds.find(id => id !== proposal.newer)!
    const alsoCleared = entry.change === 'state-change' ? await deps.decisions.removeByMemoryIds([older], entry.id) : 0
    const actions = ['已采纳梦境的处理方案']
    return { kind: 'resolved', decisionId: entry.id, verdict: 'adopt', actions, alsoCleared, otherWorkspaces,
      message: `${actions[0]}。${crossWorkspaceNote([], otherWorkspaces)}` }
  })
  if (!paired.isClaimed) return { kind: 'error', code: 'claimed', message: `待决项 ${entry.id} 的这一对记忆正在被另一次操作处理，未做任何改动。` }
  return paired.value
}

/** 持有条目和配对认领后并成版本，按整组结果结清，回执交给现有撤销流程。 */
async function resolveVersions(
  entry: PendingDecision,
  args: Extract<ConfirmArgs, { action: 'resolve' }>,
  context: GovernanceContext,
  deps: ConfirmToolDeps,
  now: number,
  locate: (id: string) => Promise<MemoryRecord | undefined>,
): Promise<ConfirmResult> {
  const members = await Promise.all(entry.memoryIds.map(locate))
  if (members.some(r => r?.status !== 'active') || entry.fingerprint === undefined || conflictFingerprint(members as MemoryRecord[]) !== entry.fingerprint) {
    return { kind: 'error', code: 'stale', message: '这两条记忆已改变或不在用，保留条目，请重新体检。' }
  }
  const records = members as MemoryRecord[]
  const { rejected, otherWorkspaces } = gateRecords(records, context, args.allowCrossWorkspace)
  if (rejected.length > 0) return { kind: 'error', code: 'cross-workspace', rejected, message: `未裁决待决项 ${entry.id}，账本条目保留。${crossWorkspaceNote(rejected, [])}` }
  const current = records.find(r => r.id === args.current)!
  const old = records.find(r => r.id !== args.current)!
  const result = await applyChangeset(
    versionPlan({ id: `${entry.id}-version`, current, old, group: entry.id }),
    { entryId: entry.id, by: 'main', at: now, isSecretChecked: false, isSecret: hasCriticalSecret }, deps,
  )
  if (result.groups?.[0]?.state !== 'applied') {
    if (result.groups?.[0]?.state === 'skipped' && result.outcomes.some(o => o.kind === 'skipped' && o.reason === 'has-secret')) {
      return { kind: 'error', message: '旧状态那条含高危密钥，无法并成版本；要删除请用 memory_forget。' }
    }
    return { kind: 'error', code: 'stale', message: '并成版本的依据已失效，保留条目，请重新体检。' }
  }
  await deps.decisions.settle(entry.id, 'as-versions', now)
  const alsoCleared = await deps.decisions.removeByMemoryIds([old.id], entry.id)
  const actions = [`将 ${old.name} 并为 ${current.name} 的历史版本`]
  return {
    kind: 'resolved', decisionId: entry.id, verdict: 'as-versions', actions, alsoCleared, otherWorkspaces,
    message: `已并成版本：${actions.join('；')}。${crossWorkspaceNote([], otherWorkspaces)}`,
  }
}

/** 条目已认领（要删一方时冲突身份也已认领）后裁决。 */
async function resolveEntry(
  entry: PendingDecision,
  args: Extract<ConfirmArgs, { action: 'resolve' }>,
  context: GovernanceContext,
  deps: ConfirmToolDeps,
  now: number,
  locate: (id: string) => Promise<MemoryRecord | undefined>,
  { adopt }: ConfirmOptions,
): Promise<ConfirmResult> {
  const vertical = entry.baselineRef !== undefined
  // 账本里的条目也要过基数校验：跨项目重复至少两个不同 id，其余横向恰好两个，垂直恰好一个。旧版本写入的或
  // 手工篡改的非法条目一旦按 memoryIds[0]/[1] 裁决，就可能删掉用户要保留的那条。
  const wellFormed = vertical
    ? entry.memoryIds.length === 1
    : kindOf(entry) === 'cross-duplicate'
      ? entry.memoryIds.length >= 2 && new Set(entry.memoryIds).size === entry.memoryIds.length
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
  // 垂直冲突这条记忆此刻对应的指令文件：采纳核对依据、旧条目现算指纹都用它
  const vertMemory = vertical ? members.get(entry.memoryIds[0]!) : undefined
  const baseline = vertMemory !== undefined ? await baselineFor(deps.instructions, vertMemory) : null
  // 落盘处理方案：用户看到的是这一份方案、依据的是生成时的两条。认领后重读的条目上建议已换成别的一份，或两条（含只改了摘要、标签）被改过，都不落盘
  const plan = adopt === undefined ? undefined : 'request' in adopt
    ? { source: 'request' as const, ...adopt.request }
    : entry.suggestion?.id === adopt.suggestionId ? { source: 'suggestion' as const, action: entry.suggestion.action, basis: entry.suggestion.basis } : undefined
  if (adopt !== undefined) {
    const live = entry.memoryIds.map(id => (members.get(id)?.status === 'active' ? members.get(id) : undefined))
    // 垂直冲突：采纳时按这条记忆此刻对应的指令文件重算，取不到或指令文件改过都对不上
    const isBaselineOk = !vertical || (plan !== undefined && live[0] !== undefined && isBaselineCurrent(plan.basis, baseline))
    if (plan === undefined || verdictOfAction(plan.action) !== args.verdict || !isBasisCurrent(entry, plan.basis, live) || !isBaselineOk) {
      return { kind: 'error', code: 'stale', message: `待决项 ${entry.id} 的处理方案已失效（建议换了一份，或${vertical ? '这条记忆、指令文件' : '两条'}在方案生成后被改过），未做任何改动。` }
    }
  }
  const proposal: { proposal?: SettledProposal } = plan === undefined ? {} : { proposal: { source: plan.source, action: plan.action } }
  const { rejected, otherWorkspaces } = gateRecords([...members.values()], context, args.allowCrossWorkspace)
  if (rejected.length > 0) {
    return { kind: 'error', code: 'cross-workspace', rejected, message: `未裁决待决项 ${entry.id}，账本条目保留。${crossWorkspaceNote(rejected, [])}` }
  }

  // 败方（keep-left/keep-right 要删的记忆）；keep-both/dismiss 无败方。
  // 垂直：left=记忆 right=基线，keep-right = 基线胜、记忆删除；横向：left=memoryIds[0]、right=memoryIds[1]
  const loserId = verdictLoser(entry, args.verdict)
  const toDelete = loserId === undefined ? undefined : members.get(loserId)
  if (loserId !== undefined && toDelete === undefined) {
    return { kind: 'error', message: `定位不到败方记忆 ${loserId}，未做任何删除，待决项 ${entry.id} 保留在账本里。可确认 id 后重试，或用 dismiss 清除该条目。` }
  }
  // 横向删一方前核对保留方仍在用：挂账之后它可能已被别处删掉或取代（另一条同一对的裁决、遗忘、替代），
  // 这时再删败方，两条就都没了。垂直冲突的保留方是基线，不用核对
  const winnerId = loserId === undefined || vertical ? undefined : entry.memoryIds.find(id => id !== loserId)
  if (winnerId !== undefined && members.get(winnerId)?.status !== 'active') {
    return { kind: 'error', message: `保留方记忆 ${winnerId} 已不在用（已删除、已被取代或定位不到），未做任何删除，待决项 ${entry.id} 保留在账本里。可用 dismiss 清除该条目。` }
  }

  const actions: string[] = []
  let alsoCleared = 0
  let isUnrecorded = false
  let isHardDeleted = false
  if (vertical && args.verdict === 'keep-left') actions.push(`保留记忆 ${entry.memoryIds[0]}（用户确认 override ${entry.baselineRef}）`)

  if (toDelete && toDelete.status !== 'deleted') {
    // 走 forget 的同一条路：先拍快照；含高危密钥的物理删除、所有快照里脱敏，其余（含只有疑似密钥的，用户存的时候确认过）软删、误操作可以恢复。
    // 该记忆的一方删掉后，可能还挂在其他待决项上——这些冲突已无法再裁决，forget 一并清理（本次条目留着，
    // clearedDecisions 只统计「额外」清理的条目）。但不能悄悄发生：把清理数量报进 actions，让用户知道有条目被顺带处理
    // 采纳建议：核对之后、删之前败方被别处改过的，锁内按建议依据里它的指纹挡下
    const basisFingerprint = plan?.basis.memories.find(m => m.memoryId === toDelete.id)?.fingerprint
    const forgot = await executeForget(
      { ids: [toDelete.id], reason: `裁决冲突 ${entry.id}（${args.verdict}）删除败方`, allowCrossWorkspace: args.allowCrossWorkspace },
      context, { ...deps, now: () => now }, {
        keepDecisionId: entry.id, operation: 'pre-resolve', isSecret: hasCriticalSecret,
        ...(basisFingerprint !== undefined ? { isChanged: (cur: MemoryRecord) => cur.status !== 'active' || editFingerprint(cur) !== basisFingerprint } : {}),
      },
    )
    if (!forgot.forgotten.includes(toDelete.id) && plan !== undefined) {
      return { kind: 'error', code: 'stale', message: `败方记忆 ${toDelete.id} 在方案生成后被改过，没有删除，待决项 ${entry.id} 保留在账本里。` }
    }
    if (!forgot.forgotten.includes(toDelete.id)) {
      return { kind: 'error', message: `败方记忆 ${toDelete.id} 没有删掉：${forgot.message}待决项 ${entry.id} 保留在账本里，可以重试。` }
    }
    alsoCleared = forgot.clearedDecisions
    if (forgot.hardDeleted.includes(toDelete.id)) {
      // 物理删除撤不回来：条目不留，界面上也不给撤销
      isHardDeleted = true
      await deps.decisions.remove(entry.id)
      actions.push(`败方记忆 ${toDelete.id} 含高危密钥，已物理删除，不进 14 天回收、不可恢复，快照里的副本已脱敏；请轮换泄漏的凭证`)
    } else {
      actions.push(`已删除败方记忆 ${toDelete.id}（快照 ${forgot.snapshotId}）`)
      // 条目标 settled 留在账本里并记下快照 id，供撤销（撤销 = 去掉 settled、按快照恢复败方）
      await deps.decisions.settle(entry.id, args.verdict, now, { snapshotId: forgot.snapshotId!, ...proposal })
    }
    if (alsoCleared > 0) {
      actions.push(`另清理 ${alsoCleared} 条同样引用该记忆的待决冲突（其一方已删除，无法再裁决）`)
    }
  } else {
    if (toDelete) actions.push(`败方记忆 ${toDelete.id} 已是删除状态，无需再删`)
    if (args.verdict === 'keep-both' || args.verdict === 'not-conflict') actions.push('两条并存（用户确认不冲突）')
    if (args.verdict === 'exception') actions.push('记成例外，保留双方记忆')
    if (args.verdict === 'dismiss') actions.push('忽略这条发现')
    // 两边都留（keep-both / dismiss / 垂直 keep-left）：记下裁决，双方内容不变时体检不再报。
    // 败方早已删除的删一方裁决同样记下（没有快照可恢复）。
    // 升级前导入的条目没有指纹：按双方此刻的内容现算（同体检），垂直冲突拿不到这条记忆对应的指令文件时算不出，只能移出账本
    const fingerprint = entry.fingerprint !== undefined || loserId !== undefined ? undefined : currentFingerprint(entry, members, baseline)
    // 两边都留：再记下双方此刻的扫描指纹，之后任一方改了事实时间、有效期这类冲突指纹不含的内容，体检也会重新报
    const live = entry.memoryIds.map(id => members.get(id))
    const scanned = loserId === undefined && live.every(r => r !== undefined) ? { memberScanFingerprints: memberScanFingerprints(live as MemoryRecord[]) } : {}
    if (await deps.decisions.settle(entry.id, args.verdict, now, { ...(fingerprint !== undefined ? { fingerprint } : {}), ...scanned, ...proposal })) {
      if (loserId === undefined) actions.push('以后体检不再报这一对，除非其中一条（或基线）被改写')
    } else isUnrecorded = true
  }

  return {
    kind: 'resolved', decisionId: entry.id, verdict: args.verdict, actions, alsoCleared, otherWorkspaces,
    ...(isUnrecorded ? { isUnrecorded: true as const } : {}), ...(isHardDeleted ? { isHardDeleted: true as const } : {}),
    message: `冲突已裁决（${args.verdict}）：${actions.join('；')}${crossWorkspaceNote([], otherWorkspaces)}`,
  }
}

/**
 * 冲突双方此刻的内容指纹（同体检挂账时算的）；有一方定位不到、或垂直冲突没有这条记忆对应的指令文件时为 undefined。
 */
function currentFingerprint(
  entry: { memoryIds: string[]; baselineRef?: string },
  members: ReadonlyMap<string, MemoryRecord>,
  baseline: readonly string[] | null,
): string | undefined {
  const records = entry.memoryIds.flatMap(id => members.get(id) ?? [])
  if (records.length !== entry.memoryIds.length) return undefined
  if (entry.baselineRef === undefined) return conflictFingerprint(records)
  if (baseline === null) return undefined
  return conflictFingerprint(records, baseline)
}
