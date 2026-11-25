import type { MemoryRecord } from '../record-schema.ts'
import type { MemoryLogger, MemoryStore } from '../store.ts'
import { ledgerLabel, scopeKey, type Scope } from '../scope.ts'
import { applyChangeset, settleOpenGroups, type ApplyOptions, type ApplyResult, type ChangesetDeps } from './changeset.ts'
import { scopeKeyOf, type ChangeOp } from '../governance/changeset.ts'
import type { PlanWrite } from '../governance/decisions.ts'
import type { ResolvedLlm } from '../governance/background-llm.ts'
import type { SemanticLlm } from '../governance/semantic-scan.ts'
import { DREAMS_INITIATOR } from '../governance/write-gate.ts'
import { countChanges, dreamContentFingerprint, dreamsGate, resolveDreamsEnabled, type DreamsConfig } from '../governance/dreams-gate.ts'
import type { DreamsLastResult, DreamsStore } from '../governance/dreams-records.ts'
import { ACTIVITY_REREAD_MS, isAnyRunning, type ActivityView } from '../governance/session-activity.ts'

/**
 * 记忆梦境的一次运行：认领范围 → 认领后确认 → 记开始 → 收尾上次留下的 → 读基线 → 按运行计划逐步做 → 记结果 → 放认领。
 * 步骤只经 ctx 写记忆、调模型、记用量；让路（有会话开始跑）和认领被接手都在步骤之间、操作之间停下。
 */

/** 一次 ctx.apply 最多这么多个操作：账本条目的占用 60 秒不刷新算残留，一次不能做太久。 */
export const DREAMS_APPLY_MAX_OPS = 20
/** 运行期间隔这么久查一次要不要让路（本进程的状态取内存里的，别的进程的按活动表的重读间隔）。 */
export const DREAMS_YIELD_POLL_MS = 2_000

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
  /**
   * 应用变更集：回执记到这次运行的条目上，操作之间会查要不要停。一次不超过 DREAMS_APPLY_MAX_OPS 个操作。
   * 写成了的记忆顺手记进这次运行的基线：梦境自己的改动下次不算「内容变了」。
   * 这次运行的条目中途被撤销、移出账本了：抛 DreamsEntryGone，这次运行按出错收（不再往下写）。
   */
  apply(ops: readonly ChangeOp[], opts?: Pick<ApplyOptions, 'anchor' | 'fingerprint' | 'isSecret'>): Promise<ApplyResult>
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
  if (read.quarantined.length > 0 || read.directoryNotes.some(note => note.code === 'dir-unreadable' || note.code === 'marker-missing')) return undefined
  const byId = new Map<string, string[]>()
  for (const { record } of read.records) {
    if (record.status !== 'active') continue
    byId.set(record.id, [...(byId.get(record.id) ?? []), dreamContentFingerprint(record)])
  }
  return Object.fromEntries([...byId].map(([id, prints]) => [id, prints.sort().join('+')]))
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
    const ctx: DreamsStepContext = {
      scope, runId, startedAt, changes: 'unknown',
      previousEntryIds: previous?.entryIds ?? [],
      entryId: () => entryId,
      shouldStop,
      async apply(ops, applyOpts = {}) {
        if (ops.length > DREAMS_APPLY_MAX_OPS) throw new Error(`一次应用的操作超过 ${DREAMS_APPLY_MAX_OPS} 个`)
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
          const applied = await applyChangeset(ops, { ...applyOpts, entryId, by: DREAMS_INITIATOR, at: deps.now(), isSecretChecked: true, shouldStop }, deps)
          if (applied.isStopped === true) sawStop = true
          const undone = new Set((applied.groups ?? []).filter(g => g.state !== 'applied').map(g => g.group))
          const groupOf = new Map(ops.map(op => [op.id, op.group]))
          for (const outcome of applied.outcomes) {
            const group = groupOf.get(outcome.opId)
            if (outcome.kind !== 'applied' || (group !== undefined && undone.has(group))) continue
            writes.push(writeOf(outcome))
            remark(outcome.written)
          }
          return applied
        } finally {
          await release().catch((err: unknown) => { log.warn('[plastic-memory] 放掉账本条目的占用失败，60 秒后按残留处理', err) })
        }
      },
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
        for (const id of leftover) if (unfinished.has(id)) await deps.decisions.finishChangeRun(id, { writes: [] })
        isLeftoverSettled = true
      }

      // 5 读基线
      startMarks = await readDreamMarks(deps.store, scope)
      if (startMarks === undefined) throw new Error('这个范围的记忆读不全')
      const baseline = await deps.dreams.baseline(scope, record?.completed?.runId)
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
      if (entryId !== undefined) await deps.decisions.finishChangeRun(entryId, { writes, summary: `记忆梦境整理 ${writes.length} 条` })
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
    }
    try {
      const isWritten = result.kind === 'completed' && startMarks !== undefined
        ? await deps.dreams.complete(scope, { runId, startedAt, endedAt }, startMarks, lastResult)
        : await deps.dreams.stop(scope, runId, { stoppedAt: endedAt, reason: result.kind, entryIds: [...(isLeftoverSettled ? [] : leftover), ...(entryId !== undefined ? [runId] : [])] }, lastResult)
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

/** 建这次运行的批次条目。写进去之后才抛错（清扫过期条目出错）的，条目已在就接着做。 */
async function addRun(deps: DreamsRunDeps, runId: string, scope: Scope, now: number): Promise<void> {
  try {
    await deps.decisions.addChangeRun(runId, { kind: 'edit', summary: '记忆梦境', memoryIds: [], workspaces: [ledgerLabel(scope)] }, 'batch-edited', now)
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
