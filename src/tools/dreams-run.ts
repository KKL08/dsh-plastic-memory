import type { MemoryRecord } from '../record-schema.ts'
import type { MemoryLogger, MemoryStore } from '../store.ts'
import type { ScopeReadResult } from '../storage/table.ts'
import { ledgerLabel, scopeKey, type Scope } from '../scope.ts'
import { applyChangeset, hasPendingReceipts, isOnDisk, settleOpenGroups, type ApplyOptions, type ApplyResult, type ChangesetDeps, type OpOutcome } from './changeset.ts'
import { copyKey, scanFingerprint, scopeKeyOf, type ChangeOp } from '../governance/changeset.ts'
import type { PlanWrite } from '../governance/decisions.ts'
import { INDEX_RECEIPT_STEP, indexReceiptStep, ledgerSteps } from '../governance/op-steps.ts'
import type { IndexOpOutcome } from '../storage/table.ts'
import type { IndexOp, IndexPlan } from '../topic-ops.ts'
import type { ResolvedLlm } from '../governance/background-llm.ts'
import type { SemanticLlm } from '../governance/semantic-scan.ts'
import { DREAMS_INITIATOR } from '../governance/write-gate.ts'
import { changeQuota, countChanges, dreamContentFingerprint, dreamsGate, resolveDreamsEnabled, type DreamsConfig } from '../governance/dreams-gate.ts'
import type { DreamsLastResult, DreamsStore } from '../governance/dreams-records.ts'
import { ACTIVITY_REREAD_MS, isAnyRunning, type ActivityView } from '../governance/session-activity.ts'
import { locateCopy } from './workspace-gate.ts'

/**
 * 记忆梦境的一次运行：认领范围 → 认领后确认 → 记开始 → 收尾上次留下的 → 读基线 → 按运行计划逐步做 → 记结果 → 放认领。
 * 步骤只经 ctx 写记忆、调模型、记用量；让路（有会话开始跑）和认领被接手都在步骤之间、操作之间停下。
 */

/** 一次 ctx.apply 最多这么多个操作：账本条目的占用 60 秒不刷新算残留，一次不能做太久。 */
export const DREAMS_APPLY_MAX_OPS = 20
/** 运行期间隔这么久查一次要不要让路（本进程的状态取内存里的，别的进程的按活动表的重读间隔）。 */
export const DREAMS_YIELD_POLL_MS = 2_000
/** 运行结果里最多列这么多条跳过的操作（总数另记）。 */
export const DREAMS_SKIPPED_MAX = 50

/** 拿不到可用的模型：这次运行按没做完收，不计连续出错。 */
export class DreamsModelUnavailable extends Error {
  constructor() {
    super('没有可用的模型')
    this.name = 'DreamsModelUnavailable'
  }
}

/** 这次运行的批次条目不在账本里了（运行期间被用户撤销）：后面的操作没处记回执，不能再写。 */
export class DreamsEntryGone extends Error {
  constructor() {
    super('这次运行的批次条目已被撤销')
    this.name = 'DreamsEntryGone'
  }
}

export interface DreamsStepContext {
  scope: Scope
  runId: string
  startedAt: number
  /** 上次做完之后内容变了的记忆数；unknown：做完过但基线不可用。 */
  changes: number | 'unknown'
  /** 以前没做完的运行留下的账本条目（已收尾；没应用过操作的不在账本里）；重跑时据此看上次已经生效了什么。 */
  previousEntryIds: readonly string[]
  /** 这次运行的账本条目；还没应用过变更集时没有。 */
  entryId(): string | undefined
  /** 该停了（让路、认领被接手、取消）。步骤拿到模型回复之后、动手之前查一次；查到为真这一步就算没做完。 */
  shouldStop(): boolean
  /** 这次运行的取消信号（插件卸载）：调模型时带上。 */
  signal?: AbortSignal
  /**
   * 应用变更集：回执记到这次运行的条目上，操作之间会查要不要停。一次不超过 DREAMS_APPLY_MAX_OPS 个操作。
   * 写成了的记忆顺手记进这次运行的基线：梦境自己的改动下次不算「内容变了」。
   * 这次运行的条目中途被撤销、移出账本了：抛 DreamsEntryGone，这次运行按出错收（不再往下写）。
   */
  apply(ops: readonly ChangeOp[], opts?: Pick<ApplyOptions, 'anchor' | 'fingerprint' | 'isSecret'>): Promise<ApplyResult>
  /**
   * 对这个范围的主题索引做一个操作（见 MemoryStore.applyIndexOp）：回执记到这次运行的条目上，提交点是第一个改写的索引文件。
   * 落盘前按当下的索引核对，对不上的跳过；超出改动量上限的跳过（reason 'quota'），什么都不写。条目中途被撤销了抛 DreamsEntryGone。
   * basis 是交给模型那一刻读到的记忆（id → 扫描指纹）：给了就在写入段里复核要挪动的成员，有一条不在里面、不在用了或内容变了，
   * 跳过（reason 'basis-changed'）。锁不在复核里：锁只管记忆文件，锁定的记忆的索引行照样能挪。
   */
  applyIndex(op: IndexOp, opts: { maxTopics: number; basis?: ReadonlyMap<string, string> }): Promise<IndexOpOutcome>
  /**
   * 这次运行还能再改动几条记忆。上限是本范围在用条数乘 maxChangeRatio（至少 1），各步按操作产生的先后共用；
   * 同一条记忆做几个操作只算一条；只算写下了、没撤回的。让路、出错之后的续跑接着扣上次用掉的。
   * apply、applyIndex 自己按它把关，超出的跳过（reason 'quota'）。
   */
  quotaLeft(): number
  /** 这条记忆这次还能动：这次已经改动过它（不再占名额），或者还有名额。 */
  canChange(memoryId: string): boolean
  /** 这条记忆上一次做完之后内容变了（没做完过、基线不可用时都算变了）。按这次运行开始时读到的比。 */
  isChanged(memoryId: string): boolean
  /** 这几条记忆这次没处理到（名额用完、没交给模型或模型给的操作因名额跳过）：不进这次的基线，下次仍算变了。 */
  markUnprocessed(memoryIds: Iterable<string>): void
  /**
   * 这几条记忆留给下次运行（合并成功落盘的存活那条）：这次运行后面的步骤不再交给模型（合并组还能单撤），
   * 这次的基线里不留它，下次运行一定算变了。
   */
  holdForNextRun(memoryIds: Iterable<string>): void
  /** 这条记忆这次已留给下次运行（见 holdForNextRun）。 */
  isHeldForNextRun(memoryId: string): boolean
  /** 记一条跳过的操作，列进这次运行的结果（模型给的值不能用之类，reason 用短代码）。 */
  skip(item: { kind: string; target: string; reason: string }): void
  /** 这次运行用的模型（一次运行只解析一次）。拿不到抛 DreamsModelUnavailable。 */
  llm(): Promise<SemanticLlm>
  /** 一次模型调用用了这么多 token：立刻记进七天用量。 */
  addUsage(tokens: number): Promise<void>
}

export interface DreamsStep {
  name: string
  /** 为真：没有新变化、上次也做完了的时候跳过（不调模型）。 */
  needsChanges: boolean
  run(ctx: DreamsStepContext): Promise<void>
}

export type DreamsRunKind = 'completed' | 'yielded' | 'failed' | 'busy' | 'not-due' | 'lost' | 'model-unavailable' | 'disabled'

export interface DreamsRunResult {
  kind: DreamsRunKind
  runId?: string
  steps: Array<{ name: string; state: 'done' | 'skipped' | 'not-run' }>
  usageTokens: number
  modelFallback?: { to: 'checkup' | 'default'; reason: string }
  entryId?: string
}

export interface DreamsRunOptions {
  /** auto：调度到点；manual：用户点的立即运行（不看间隔、变化、空闲，也不看这个范围的开关）。 */
  by: 'auto' | 'manual'
  /** 只在手动时有意义：只对运行开始之后才开始跑的会话让路，开始前就在跑的不算。 */
  yieldOnlyToNew?: boolean
  /** 取消（插件卸载）：在下一个检查点停，按认领被接手处理，不写记录。 */
  signal?: AbortSignal
}

export interface DreamsRunDeps extends ChangesetDeps {
  dreams: DreamsStore
  /** 认领这个范围并保持心跳（和体检、整理索引同一个认领）；被接手时调 onLost。 */
  claimScope: (scope: Scope, onLost: () => void) => Promise<{ release: () => Promise<void> } | { busy: Scope }>
  /** 各进程合起来的活动（ActivityBoard.view）。 */
  activity: (maxAgeMs: number) => Promise<ActivityView>
  resolveLlm: () => Promise<ResolvedLlm>
  config: () => DreamsConfig
  /** 治理的总开关。 */
  isGovernanceEnabled: () => boolean
  plan: readonly DreamsStep[]
  interval: (callback: () => void, delayMs: number) => () => void
  now: () => number
  newRunId: () => string
  log?: MemoryLogger
}

/**
 * 这个范围在用记忆的内容指纹（记忆 id → 指纹），只读这一层（项目范围不带全局）。读不全（有文件解析不了、
 * 目录读不了或缺标记）返回 undefined：不知道少了哪些，不能拿它当基线、也不能拿它数变化。
 * 一层里同一个 id 有几份在用副本时，几份的指纹排序后拼在一起。
 */
export async function readDreamMarks(store: Pick<MemoryStore, 'readRaw'>, scope: Scope): Promise<Record<string, string> | undefined> {
  const read = await store.readRaw(scope)
  if (!isCompleteRead(read)) return undefined
  const byId = new Map<string, string[]>()
  for (const { record } of read.records) {
    if (record.status !== 'active') continue
    byId.set(record.id, [...(byId.get(record.id) ?? []), dreamContentFingerprint(record)])
  }
  return Object.fromEntries([...byId].map(([id, prints]) => [id, prints.sort().join('+')]))
}

/** 这一层读全了：没有解析不了的文件，目录读得了、标记在。 */
export function isCompleteRead(read: Pick<ScopeReadResult, 'quarantined' | 'directoryNotes'>): boolean {
  return read.quarantined.length === 0 && !read.directoryNotes.some(note => note.code === 'dir-unreadable' || note.code === 'marker-missing')
}

/**
 * 上次做完之后内容变了的记忆数（调度预查和认领后确认共用）。unknown：这个范围的记忆读不全，或做完过但基线不可用，
 * 不知道变了多少；门槛按够数算，读不全的由运行在读基线那一步按出错收。
 */
export async function countDreamChanges(deps: { store: Pick<MemoryStore, 'readRaw'>; dreams: Pick<DreamsStore, 'baseline'> }, scope: Scope, completedRunId: string | undefined): Promise<number | 'unknown'> {
  const marks = await readDreamMarks(deps.store, scope)
  const baseline = await deps.dreams.baseline(scope, completedRunId)
  return marks === undefined || baseline.kind === 'unavailable' ? 'unknown' : countChanges(baseline.kind === 'ok' ? baseline.marks : undefined, marks)
}

const NOTHING: Pick<DreamsRunResult, 'steps' | 'usageTokens'> = { steps: [], usageTokens: 0 }

export async function runDreams(scope: Scope, opts: DreamsRunOptions, deps: DreamsRunDeps): Promise<DreamsRunResult> {
  const log = deps.log ?? console
  const isManual = opts.by === 'manual'
  if (!deps.isGovernanceEnabled()) return { kind: 'disabled', ...NOTHING }

  // 1 认领
  let isLost = false
  const claim = await deps.claimScope(scope, () => { isLost = true })
  if ('busy' in claim) return { kind: 'busy', ...NOTHING }
  let stopPolling: (() => void) | undefined
  try {
    // 2 认领后确认：别的进程可能刚做完、刚关掉
    const state = await deps.dreams.read()
    if (!state.isComplete) {
      log.warn('[plastic-memory] 记忆梦境的记录读不全，这次不运行')
      return { kind: 'not-due', ...NOTHING }
    }
    if (!isManual && !resolveDreamsEnabled(state.settings, scope).isEnabled) return { kind: 'disabled', ...NOTHING }
    const record = state.records.get(scopeKey(scope))
    const gate = { config: deps.config(), record, usageRuns: state.usageRuns, isManual }
    if (!dreamsGate({ ...gate, now: deps.now() }).pass) return { kind: 'not-due', ...NOTHING }
    // 自动的再数一遍变化：调度预查之后、认领到之前，前台可能删改过，或别的进程刚做完
    if (!isManual && !dreamsGate({ ...gate, now: deps.now(), changes: await countDreamChanges(deps, scope, record?.completed?.runId) }).pass) return { kind: 'not-due', ...NOTHING }
    // 认领在这期间被接手、被取消：不记开始（那会盖掉接手那次的记录）
    if (isLost || opts.signal?.aborted === true) return { kind: 'lost', ...NOTHING }

    // 3 记开始
    const runId = deps.newRunId()
    const startedAt = deps.now()
    const result: DreamsRunResult = { kind: 'failed', runId, steps: deps.plan.map(step => ({ name: step.name, state: 'not-run' as const })), usageTokens: 0 }
    let previous: Awaited<ReturnType<DreamsStore['begin']>>
    try {
      previous = await deps.dreams.begin(scope, runId, startedAt)
    } catch (err) {
      log.warn('[plastic-memory] 记忆梦境记不下这次运行的开始，这次不运行', err)
      return result
    }

    // 让路：同步的标记，定时刷新；步骤之间另外现查一次
    let isYielding = false
    let sawStop = false
    const since = isManual && opts.yieldOnlyToNew === true ? startedAt : undefined
    const checkYield = async () => {
      try {
        if (isAnyRunning(await deps.activity(ACTIVITY_REREAD_MS), scope, since)) isYielding = true
      } catch (err) {
        log.warn('[plastic-memory] 活动表读不出，记忆梦境先停下', err)
        isYielding = true
      }
    }
    stopPolling = deps.interval(() => { void checkYield() }, DREAMS_YIELD_POLL_MS)
    const isGone = () => isLost || opts.signal?.aborted === true
    const shouldStop = () => {
      const stop = isGone() || isYielding
      if (stop) sawStop = true
      return stop
    }

    const writes: PlanWrite[] = []
    let entryId: string | undefined
    let llm: Promise<SemanticLlm> | undefined
    // 改动量上限：读完基线后按本范围在用条数定；used 是这次已经改动过的记忆（作用域键 + id），carried 是没做完的前几次用掉的
    let quotaLimit = 0
    const carried = previous?.quotaUsed ?? 0
    const used = new Set<string>()
    const fits = (keys: Iterable<string>, taken: ReadonlySet<string>) => {
      const fresh = new Set([...keys].filter(key => !taken.has(key)))
      return carried + taken.size + fresh.size <= quotaLimit
    }
    const keyOf = (memoryId: string) => copyKey({ scopeKey: scopeKey(scope), memoryId })
    // 这次没处理到的记忆：写基线时不记这次的值；留给下次运行的：基线里不留
    const unprocessed = new Set<string>()
    const held = new Set<string>()
    // 上一次做完时的基线和这次开始时读到的：判断哪条变了
    let previousMarks: Record<string, string> | undefined
    let initialMarks: Record<string, string> = {}
    let hasBaseline = false
    // 跳过的操作：列进这次运行的结果
    let stepName = ''
    const skipped: Array<{ step: string; kind: string; target: string; reason: string }> = []
    let skippedTotal = 0
    const noteSkipped = (kind: string, target: string, reason: string) => {
      skippedTotal++
      if (skipped.length < DREAMS_SKIPPED_MAX) skipped.push({ step: stepName, kind, target, reason })
    }
    /** 占住这次运行的条目做 fn：头一次用时建条目，之后条目不在了（被撤销）抛 DreamsEntryGone。 */
    const withEntry = async <T>(fn: (id: string) => Promise<T>): Promise<T> => {
      // 占住条目：别的进程收尾半个组时占不到就不碰它
      const release = await deps.decisions.hold(runId)
      if (release === undefined) throw new Error('这次运行的账本条目被别处占着')
      try {
        if (entryId === undefined) {
          await addRun(deps, runId, scope, startedAt)
          entryId = runId
          result.entryId = runId
        } else if (!(await deps.decisions.listSettled()).some(d => d.id === runId)) {
          throw new DreamsEntryGone()
        }
        return await fn(entryId)
      } finally {
        await release().catch((err: unknown) => { log.warn('[plastic-memory] 放掉账本条目的占用失败，60 秒后按残留处理', err) })
      }
    }
    /**
     * 按这次运行的批次条目上现有的回执补记已用的名额：记忆的回执，和已确认（或提交了、等着补做确认）的索引回执挪动的成员。
     * 只往里加：回执没记上的写入（等着补记、撤不回已拿掉回执的）由应用结果记下，同样占着。账本读不出时按已记下的算。
     */
    const syncUsed = async () => {
      if (entryId === undefined) return
      try {
        const entry = (await deps.decisions.listSettled()).find(d => d.id === entryId)
        for (const receipt of entry?.changes ?? []) used.add(copyKey(receipt))
        for (const receipt of entry?.indexRun?.receipts ?? []) {
          if (receipt.isConfirmed === true || deps.store.isOpPending(receipt.op)) for (const id of indexQuotaIds(receipt.plan)) used.add(keyOf(id))
        }
      } catch (err) {
        log.warn('[plastic-memory] 记忆梦境读不出批次条目，已用名额按这次记下的算', err)
      }
    }
    /** 要挪的成员都还是模型看到的那一版（在用、扫描指纹没变）。在写入段里调用。 */
    const isSameAsSeen = async (ids: readonly string[], seen: ReadonlyMap<string, string>) => {
      for (const id of ids) {
        const current = await locateCopy(deps.store, id, scope)
        if (current?.status !== 'active' || seen.get(id) !== scanFingerprint(current)) return false
      }
      return true
    }
    const ctx: DreamsStepContext = {
      scope, runId, startedAt, changes: 'unknown',
      previousEntryIds: previous?.entryIds ?? [],
      entryId: () => entryId,
      shouldStop,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      async apply(ops, applyOpts = {}) {
        if (ops.length > DREAMS_APPLY_MAX_OPS) throw new Error(`一次应用的操作超过 ${DREAMS_APPLY_MAX_OPS} 个`)
        const byId = new Map(ops.map(op => [op.id, op]))
        // 按操作的先后占改动量：做到这一项（这一组）时已做成的加上它要改的放得下才做
        const admit = (unit: readonly ChangeOp[], done: readonly OpOutcome[]) => {
          const taken = new Set([...used, ...done.flatMap(o => { const op = byId.get(o.opId); return op === undefined ? [] : [copyKey(op)] })])
          return fits(unit.map(op => copyKey(op)), taken)
        }
        let applied: ApplyResult
        try {
          applied = await withEntry(id => applyChangeset(ops, { ...applyOpts, entryId: id, by: DREAMS_INITIATOR, at: deps.now(), isSecretChecked: true, shouldStop, admit }, deps))
        } finally {
          // 正常返回、中途抛错都按账本上已有的回执补记已用的名额：抛错时前面写成的拿不到返回值
          await syncUsed()
        }
        if (applied.isStopped === true) sawStop = true
        const groups = applied.groups ?? []
        for (const outcome of applied.outcomes) {
          const op = byId.get(outcome.opId)
          if (op === undefined) continue
          if (outcome.kind === 'skipped' && outcome.reason !== 'no-change' && outcome.reason !== 'stopped') noteSkipped(op.kind, op.memoryId, outcome.reason)
          // 写下了、没撤回的（含组撤回出错留在盘上的）照样占名额
          if (outcome.kind !== 'applied' || !isOnDisk(outcome, groups, ops)) continue
          used.add(copyKey(op))
          writes.push(writeOf(outcome))
          remark(outcome.written)
        }
        // 组撤回出错、改动留在盘上：回执留在条目上可再撤，这次按出错收，不再往下写
        const kept = groups.flatMap(g => g.kept ?? [])
        if (kept.length > 0) throw new Error(`撤回一组改动时出错，${kept.join('、')} 仍是这次写下的样子`)
        return applied
      },
      async applyIndex(op, indexOpts) {
        if (!deps.store.hasStep(INDEX_RECEIPT_STEP)) deps.store.registerSteps(ledgerSteps(deps.decisions, deps.log))
        let keys: string[] = []
        let r: IndexOpOutcome
        try {
          r = await withEntry(id => deps.store.applyIndexOp(scope, op, {
            maxTopics: indexOpts.maxTopics,
            // 在写入段里、写第一个文件之前：要挪的成员按模型看到的版本复核，放不下就不做；回执先记下（带撤销要用的改前数据），提交后的步骤确认它
            prepare: async (writeOp, plan) => {
              const moved = indexQuotaIds(plan)
              if (indexOpts.basis !== undefined && !(await isSameAsSeen(moved, indexOpts.basis))) throw new IndexSkip('basis-changed')
              keys = moved.map(keyOf)
              if (!fits(keys, used)) throw new IndexSkip('quota')
              if (!(await deps.decisions.appendIndexReceipt(id, { op: writeOp, plan }))) throw new DreamsEntryGone()
              return [indexReceiptStep(id)]
            },
          }))
        } catch (err) {
          if (!(err instanceof IndexSkip)) throw err
          r = { kind: 'skipped', reason: err.reason }
        }
        if (r.kind === 'applied') for (const key of keys) used.add(key)
        else noteSkipped(op.kind, indexTarget(op), r.reason)
        return r
      },
      quotaLeft: () => Math.max(0, quotaLimit - carried - used.size),
      canChange: memoryId => used.has(keyOf(memoryId)) || carried + used.size < quotaLimit,
      isChanged: memoryId => !hasBaseline || previousMarks?.[memoryId] !== initialMarks[memoryId],
      markUnprocessed(memoryIds) { for (const id of memoryIds) unprocessed.add(id) },
      holdForNextRun(memoryIds) { for (const id of memoryIds) held.add(id) },
      isHeldForNextRun: memoryId => held.has(memoryId),
      skip: item => noteSkipped(item.kind, item.target, item.reason),
      llm() {
        llm ??= deps.resolveLlm().then((resolved) => {
          if (resolved.fellBack) result.modelFallback = { to: resolved.isSelected ? 'checkup' : 'default', reason: resolved.reason ?? 'provider-gone' }
          if (resolved.llm === null) throw new DreamsModelUnavailable()
          return resolved.llm
        })
        return llm
      },
      async addUsage(tokens) {
        if (!(tokens > 0)) return
        result.usageTokens += tokens
        try {
          await deps.dreams.addUsage(runId, deps.now(), tokens)
        } catch (err) {
          log.warn('[plastic-memory] 记忆梦境的用量没记上', err)
        }
      },
    }

    let startMarks: Record<string, string> | undefined
    /** 梦境自己写成的记忆：基线里换成写完之后的指纹；离开在用的（软删、并进别的）从基线里拿掉。只管这个范围里的。 */
    const remark = (written: MemoryRecord) => {
      if (startMarks === undefined || scopeKeyOf(written) !== scopeKey(scope)) return
      if (written.status === 'active') startMarks[written.id] = dreamContentFingerprint(written)
      else delete startMarks[written.id]
    }
    // 以前留下、还没收尾的条目：这次收成了才从记录里去掉
    const leftover = previous?.entryIds ?? []
    let isLeftoverSettled = leftover.length === 0
    try {
      // 4 收尾上次的：撤掉中断留下的半个组，把上次没来得及收的批次条目收掉
      await settleOpenGroups(deps, { by: DREAMS_INITIATOR })
      if (leftover.length > 0) {
        // 已经收过的（收尾之后、记结果之前退出的）不再收：再收一遍会把补好的整条回执清空
        const open = await deps.decisions.listUnfinishedRuns()
        // 账本读不全：不在列表里的条目可能只是这次读不出，不能当成收过了，引用留着，这次按出错收
        if (!open.isComplete) throw new Error('账本读不全，上次留下的批次条目没法收尾')
        const unfinished = new Set(open.ids)
        for (const id of leftover) if (unfinished.has(id)) await deps.store.writeSection(() => deps.decisions.finishChangeRun(id, { writes: [] }, op => deps.store.isOpPending(op), () => hasPendingReceipts(deps.store, id)))
        isLeftoverSettled = true
      }

      // 5 读基线
      startMarks = await readDreamMarks(deps.store, scope)
      // 读不全：在用条数（改动量上限的分母）也不准，这次不跑，下次重试
      if (startMarks === undefined) throw new Error('这个范围的记忆读不全')
      quotaLimit = changeQuota(Object.keys(startMarks).length, deps.config().maxChangeRatio)
      initialMarks = { ...startMarks }
      const baseline = await deps.dreams.baseline(scope, record?.completed?.runId)
      if (baseline.kind === 'ok') {
        previousMarks = baseline.marks
        hasBaseline = true
      }
      ctx.changes = baseline.kind === 'unavailable' ? 'unknown' : countChanges(baseline.kind === 'ok' ? baseline.marks : undefined, startMarks)
      if (isGone()) throw new Error('认领被接手')

      // 6 逐步做
      result.kind = 'completed'
      for (const [i, step] of deps.plan.entries()) {
        await checkYield()
        if (isGone()) { result.kind = 'lost'; break }
        if (isYielding) { result.kind = 'yielded'; break }
        if (step.needsChanges && ctx.changes === 0 && previous === undefined) {
          result.steps[i]!.state = 'skipped'
          continue
        }
        sawStop = false
        stepName = step.name
        await step.run(ctx)
        // 步骤中途看到过叫停：它没做完，不能记成做完
        if (sawStop) { result.kind = isGone() ? 'lost' : 'yielded'; break }
        result.steps[i]!.state = 'done'
      }
    } catch (err) {
      if (isGone()) {
        result.kind = 'lost'
      } else if (err instanceof DreamsModelUnavailable) {
        result.kind = 'model-unavailable'
        log.warn('[plastic-memory] 记忆梦境没有可用的模型，这次没做完')
      } else {
        result.kind = 'failed'
        log.warn('[plastic-memory] 记忆梦境这次运行出错', err)
      }
    }
    stopPolling()
    stopPolling = undefined

    // 认领被接手、被取消：别的进程（或下次启动）接着管，这里不再写任何记录
    if (result.kind === 'lost' || isGone()) return { ...result, kind: 'lost' }

    // 7 记结果
    try {
      const id = entryId
      if (id !== undefined) {
        await deps.store.writeSection(() => deps.decisions.finishChangeRun(
          id, { writes, summary: `记忆梦境整理 ${writes.length} 条` }, op => deps.store.isOpPending(op), () => hasPendingReceipts(deps.store, id),
        ))
      }
    } catch (err) {
      // 条目没收成：这次不能记成做完（做完会把它从记录里拿掉，就没人再收了），按出错收，下次运行先收它
      log.warn('[plastic-memory] 记忆梦境的批次条目没收尾，这次按出错收，下次运行再收', err)
      if (result.kind === 'completed') result.kind = 'failed'
    }
    const endedAt = deps.now()
    const lastResult: DreamsLastResult = {
      runId, kind: result.kind, by: opts.by, endedAt, steps: result.steps, usageTokens: result.usageTokens,
      ...(result.modelFallback !== undefined ? { modelFallback: result.modelFallback } : {}),
      ...(entryId !== undefined ? { entryId } : {}),
      ...(skippedTotal > 0 ? { skipped: { items: skipped, total: skippedTotal } } : {}),
    }
    const quotaUsed = carried + used.size
    try {
      const isWritten = result.kind === 'completed' && startMarks !== undefined
        ? await deps.dreams.complete(scope, { runId, startedAt, endedAt }, processedMarks(startMarks, unprocessed, held, previousMarks), lastResult)
        : await deps.dreams.stop(scope, runId, {
          stoppedAt: endedAt, reason: result.kind, entryIds: [...(isLeftoverSettled ? [] : leftover), ...(entryId !== undefined ? [runId] : [])],
          ...(quotaUsed > 0 ? { quotaUsed } : {}),
        }, lastResult)
      if (!isWritten) return { ...result, kind: 'lost' }
    } catch (err) {
      log.warn('[plastic-memory] 记忆梦境的运行结果没记上，下次按上次没做完处理', err)
    }
    return result
  } finally {
    stopPolling?.()
    // 8 放认领
    await claim.release()
  }
}

/** 这个索引操作不做（要挪的成员变了、改动量放不下）：在写第一个文件之前叫停。 */
class IndexSkip extends Error {
  readonly reason: 'basis-changed' | 'quota'
  constructor(reason: 'basis-changed' | 'quota') {
    super(reason)
    this.reason = reason
  }
}

/**
 * 这次的基线：没处理到的记忆不记这次读到的值，留上一次基线里的（上一次也没有就不记），下次它们仍算变了。
 * 留给下次运行的不记（上一次的值可能和这次读到的一样，留着它下次就判成没变）。
 */
function processedMarks(
  marks: Record<string, string>, unprocessed: ReadonlySet<string>, held: ReadonlySet<string>, previous: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const next = { ...marks }
  for (const id of unprocessed) {
    const before = previous?.[id]
    if (before === undefined) delete next[id]
    else next[id] = before
  }
  for (const id of held) delete next[id]
  return next
}

/**
 * 一个索引操作改动了哪些记忆（占改动量）：被挪到别的主题的成员。改名、改说明、调顺序不挪成员，不占。
 * 锁定的记忆的成员行同样能挪（锁只管记忆文件），挪了同样占。
 */
function indexQuotaIds(plan: IndexPlan): string[] {
  return plan.kind === 'assign' || plan.kind === 'merge' ? plan.moved.map(m => m.id) : []
}

/** 跳过的索引操作在结果里怎么称呼：落到的那个主题（调主题顺序没有）。 */
function indexTarget(op: IndexOp): string {
  switch (op.kind) {
    case 'assign': return op.to
    case 'merge': return op.into
    case 'order-topics': return ''
    default: return op.topic
  }
}

/** 建这次运行的批次条目。写进去之后才抛错（清扫过期条目出错）的，条目已在就接着做。 */
async function addRun(deps: DreamsRunDeps, runId: string, scope: Scope, now: number): Promise<void> {
  try {
    await deps.decisions.addDreamsRun(runId, { summary: '记忆梦境', workspace: ledgerLabel(scope) }, now)
  } catch (err) {
    if (!(await deps.decisions.listSettled().catch(() => [])).some(d => d.id === runId)) throw err
  }
}

function writeOf(outcome: { opKind: string; memoryId: string; written: MemoryRecord }): PlanWrite {
  return { memoryId: outcome.memoryId, op: outcome.opKind === 'forget' ? 'forget' : 'edit', written: outcome.written }
}

/** 运行计划里的维护一步：整份核对索引和历史、到期清扫。不调模型，每次都做；整段不可中断。 */
export const maintainStep = (store: Pick<MemoryStore, 'maintain'>): DreamsStep => ({
  name: 'maintain',
  needsChanges: false,
  run: ctx => store.maintain(ctx.scope),
})
