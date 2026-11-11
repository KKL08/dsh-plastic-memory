import type { MemoryLogger, MemoryStore } from '../store.ts'
import { conflictFingerprint, isBasisCurrent, type PendingDecisionsStore } from '../governance/decisions.ts'
import { kindOf, verdictLoser, type PendingDecision, type SettledProposal, type SuggestionBasis } from '../governance/schema.ts'
import { editFingerprint, type SnapshotStore } from '../governance/snapshots.ts'
import { ALREADY_REVIEWED_REASON, NOT_DELEGATED_REASON, isPendingDelegated, type MemoryRecord } from '../record-schema.ts'
import { verdictOfAction, type AcceptRejectCode, type DecisionRejectCode, type GovernanceRejectCode, type ProposalAction } from '../contract-codes.ts'
import { RecordNotFoundError } from '../errors.ts'
import { crossWorkspaceNote, gateRecords, locateCopy, type CrossWorkspaceRejection, type GovernanceContext, type OtherWorkspaceMark } from './workspace-gate.ts'
import type { Scope } from '../scope.ts'
import { executeForget } from './forget.ts'
import { hasCriticalSecret } from '../secrets.ts'

export interface ConfirmToolDeps {
  store: MemoryStore
  decisions: PendingDecisionsStore
  snapshots: SnapshotStore
  now?: () => number
  /** 日志注入口（裁决删败方走 forget，它记删除日志），缺省回退 console。 */
  log?: MemoryLogger
}

/** allowCrossWorkspace：用户明确选择「全局整理」时才为 true，放行其他项目的记录（见 workspace-gate.ts）。 */
export type ConfirmArgs =
  | { action: 'refresh'; memoryId: string; allowCrossWorkspace?: boolean }
  | { action: 'resolve'; decisionId: string; verdict: 'keep-left' | 'keep-right' | 'keep-both' | 'dismiss'; allowCrossWorkspace?: boolean }
  | { action: 'accept-subagent'; memoryId: string; allowCrossWorkspace?: boolean }

/** 只给 GUI 用的选项，不在工具参数里，模型传不进来。 */
export interface ConfirmOptions {
  /** refresh 时同 id 多副本只认这一份（GUI 按页面上那一份操作）；缺省按会话 workspace 定位。跨 workspace 门照旧按会话判定。 */
  target?: Scope
  /** resolve 时垂直冲突的条目没有指纹，两边都留要现算指纹用的基线（GUI 从借来的会话取）。 */
  baseline?: readonly string[]
  /**
   * resolve 是在落盘一份处理方案：条目上的这份处理建议（GUI「采纳建议」，suggestionId），或界面带回的按要求生成的方案
   * （GUI「补充要求」，request：结论和生成时的依据版本）。认领条目后核对建议 id（按要求的没有这一项）、结论和裁决对得上、
   * 依据版本仍是此刻的，对不上回 stale、什么都不动；删败方时锁内按依据里它的完整内容指纹再比一次。结清时记下来源和结论代码。
   */
  adopt?: { suggestionId: string } | { request: { action: ProposalAction; basis: SuggestionBasis } }
}

/**
 * otherWorkspaces：带参数放行、属于其他项目的记录；error 带 code 时 rejected 列出被拒记录。
 * isUnrecorded：两边都留，但条目没有指纹、也现算不出（垂直冲突缺基线，或记忆属于别的项目、会话的基线不是它的），结论没记下，条目已移出账本。
 * isHardDeleted：败方含高危密钥，已物理删除、不可恢复，条目已移出账本，没有撤销。
 */
export type ConfirmResult =
  | SettleResult
  | { kind: 'accepted'; memoryId: string; lastConfirmedAt: number; otherWorkspaces: OtherWorkspaceMark[]; message: string }
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

  if (args.action === 'accept-subagent') return acceptSubagent(args, context, deps, now, locate)

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
  args: Extract<ConfirmArgs, { action: 'accept-subagent' }>,
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
  try {
    await deps.store.update(target, (cur) => {
      const why = notPendingReason(cur)
      if (why !== undefined) throw new NotPendingError(why)
      return { ...cur, lastConfirmedAt: now, delegation: { ...cur.delegation!, reviewed: { by: 'main', at: now } } }
    })
  } catch (err) {
    if (err instanceof RecordNotFoundError) return { kind: 'error', message: `记忆不存在：${args.memoryId}` }
    if (!(err instanceof NotPendingError)) throw err
    return {
      kind: 'error', code: 'not-subagent-pending',
      message: `记忆 ${args.memoryId} ${err.message}，不是待确认的子 agent 记忆，未做改动。accept-subagent 只接受子 agent 存的、还在用的待确认记忆。`,
    }
  }
  return {
    kind: 'accepted', memoryId: args.memoryId, lastConfirmedAt: now, otherWorkspaces,
    message: `已接受子 agent 存的记忆 ${args.memoryId}，不再待确认，和本项目其他记忆一样注入、检索。${crossWorkspaceNote([], otherWorkspaces)}`,
  }
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
  const entry = await deps.decisions.get(args.decisionId)
  if (!entry) {
    return { kind: 'error', code: 'not-found', message: `待决项不存在：${args.decisionId}（可能已被裁决或涉及的记忆已删除）` }
  }

  // 提升候选、超限提醒不是冲突，不能按 memoryIds 位置裁决（否则可能删掉候选记忆）；条目不动
  if (kindOf(entry) !== 'conflict') {
    return { kind: 'error', message: `待决项 ${entry.id} 不是冲突（${kindOf(entry)}），不能用 resolve 裁决，账本条目保留。` }
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

/** 条目已认领（要删一方时冲突身份也已认领）后裁决。 */
async function resolveEntry(
  entry: PendingDecision,
  args: Extract<ConfirmArgs, { action: 'resolve' }>,
  context: GovernanceContext,
  deps: ConfirmToolDeps,
  now: number,
  locate: (id: string) => Promise<MemoryRecord | undefined>,
  { baseline, adopt }: ConfirmOptions,
): Promise<ConfirmResult> {
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
  // 落盘处理方案：用户看到的是这一份方案、依据的是生成时的两条。认领后重读的条目上建议已换成别的一份，或两条（含只改了摘要、标签）被改过，都不落盘
  const plan = adopt === undefined ? undefined : 'request' in adopt
    ? { source: 'request' as const, ...adopt.request }
    : entry.suggestion?.id === adopt.suggestionId ? { source: 'suggestion' as const, action: entry.suggestion.action, basis: entry.suggestion.basis } : undefined
  if (adopt !== undefined) {
    const live = entry.memoryIds.map(id => (members.get(id)?.status === 'active' ? members.get(id) : undefined))
    if (plan === undefined || verdictOfAction(plan.action) !== args.verdict || !isBasisCurrent(entry, plan.basis, live)) {
      return { kind: 'error', code: 'stale', message: `待决项 ${entry.id} 的处理方案已失效（建议换了一份，或两条在方案生成后被改过），未做任何改动。` }
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
    if (args.verdict === 'keep-both') actions.push('两条并存（用户确认不冲突）')
    if (args.verdict === 'dismiss') actions.push('标记为误报')
    // 两边都留（keep-both / dismiss / 垂直 keep-left）：记下裁决，双方内容不变时体检不再报。
    // 败方早已删除的删一方裁决同样记下（没有快照可恢复）。
    // 升级前导入的条目没有指纹：按双方此刻的内容现算（同体检），垂直冲突拿不到它所在项目的基线时算不出，只能移出账本
    const fingerprint = entry.fingerprint !== undefined || loserId !== undefined ? undefined : currentFingerprint(entry, members, baseline, context.workspacePath)
    if (await deps.decisions.settle(entry.id, args.verdict, now, { ...(fingerprint !== undefined ? { fingerprint } : {}), ...proposal })) {
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
 * 冲突双方此刻的内容指纹（同体检挂账时算的）；有一方定位不到、或垂直冲突没有基线时为 undefined。
 * 基线随会话：记忆属于别的项目时会话的基线不是它的（体检扫别的项目也跳过垂直冲突），同样算不出。
 */
function currentFingerprint(
  entry: { memoryIds: string[]; baselineRef?: string },
  members: ReadonlyMap<string, MemoryRecord>,
  baseline: readonly string[] | undefined,
  sessionWorkspace: string | undefined,
): string | undefined {
  const records = entry.memoryIds.flatMap(id => members.get(id) ?? [])
  if (records.length !== entry.memoryIds.length) return undefined
  if (entry.baselineRef === undefined) return conflictFingerprint(records)
  const ws = records[0]!.scope === 'workspace' ? records[0]!.workspacePath : undefined
  if (baseline === undefined || (ws !== undefined && ws !== sessionWorkspace)) return undefined
  return conflictFingerprint(records, baseline)
}
