import type { MemoryLogger, MemoryStore } from '../store.ts'
import { scopeKey, type Scope } from '../scope.ts'
import { dreamsGate, resolveDreamsEnabled } from '../governance/dreams-gate.ts'
import type { DreamsState } from '../governance/dreams-records.ts'
import { countDreamChanges, runDreams, type DreamsRunDeps, type DreamsRunResult } from './dreams-run.ts'
import { scheduledScopes } from '../governance/scope-health.ts'
import { isIdle, type ActivityView } from '../governance/session-activity.ts'

/**
 * 记忆梦境的调度：什么时候查门槛、查哪些范围、一次只跑一个。不自己定时：接在自动体检每一轮检查之后查一遍，
 * 本进程里有工作目录从有会话在跑变成没有时，过了空闲时间再查一遍。
 *
 * 一轮检查按成本从低到高取数据：侧表里的时间、重试、用量先判一遍，过了才读这个范围的记忆数变化，再过了才读活动表判空闲；
 * 都过了交给一次运行（认领和认领后确认在那里做）。一个范围没跑成（让路、被占着、出错）只影响它自己，后面的范围照常看。
 */

const MINUTE_MS = 60_000

export interface DreamsSchedulerDeps {
  /** 一次运行的依赖；config、isGovernanceEnabled、dreams、store、now 调度也用。 */
  run: DreamsRunDeps
  store: Pick<MemoryStore, 'listWorkspaceDirs' | 'readRaw'>
  /** 活动表：各进程合起来的活动，和本进程转安静的通知。 */
  board: { view(maxAgeMs?: number): Promise<ActivityView>; onQuiet(listener: () => void): () => void }
  /** 一次性的计时（宿主的计时服务）；返回取消。 */
  timeout: (callback: () => void, delayMs: number) => () => void
  /** 配置里有用了默认值的坏值时给出键名（记日志用）；缺省不查。 */
  badConfigKeys?: () => readonly string[]
  log?: MemoryLogger
}

export class DreamsScheduler {
  private readonly deps: DreamsSchedulerDeps
  private readonly log: MemoryLogger
  private readonly stops: Array<() => void> = []
  private cancelQuietCheck: (() => void) | undefined
  /** 进行中的那一轮或那次手动运行；一个进程同时只有一个。 */
  private running: Promise<unknown> | undefined
  private isRerunRequested = false
  private controller: AbortController | undefined
  private isDisposed = false

  constructor(deps: DreamsSchedulerDeps) {
    this.deps = deps
    this.log = deps.log ?? console
  }

  /** 订阅本进程转安静的通知：过了空闲时间再查一遍（期间又转安静就重新计时）。 */
  start(): void {
    this.stops.push(this.deps.board.onQuiet(() => {
      if (this.isDisposed || !this.deps.run.isGovernanceEnabled()) return
      this.cancelQuietCheck?.()
      // 多等一小会儿：刚好满空闲时间的那一刻查，按「不少于」判是过的，留一点余量给时钟取整
      this.cancelQuietCheck = this.deps.timeout(() => {
        this.cancelQuietCheck = undefined
        void this.recheck()
      }, this.deps.run.config().idleMinutes * MINUTE_MS + 1_000)
    }))
  }

  /** 查一轮（自动体检每一轮之后、开关或配置改了时也调它）。正在查或正在跑时不另起：等这一轮做完再查一遍。 */
  recheck(): Promise<void> {
    if (this.isDisposed) return Promise.resolve()
    if (this.running !== undefined) {
      this.isRerunRequested = true
      return this.running.then(() => {}, () => {})
    }
    const round = (async () => {
      try {
        do {
          this.isRerunRequested = false
          await this.checkOnce()
        } while (this.isRerunRequested && !this.isDisposed)
      } catch (err) {
        this.log.warn('[plastic-memory] 记忆梦境这一轮检查出错，下次再查', err)
      } finally {
        this.running = undefined
      }
    })()
    this.running = round
    return round
  }

  /**
   * 用户点的立即运行：不看间隔、变化、空闲和这个范围的开关，排在进行中的那一轮之后。
   * yieldOnlyToNew：用户看到有会话在跑仍坚持要跑，只对之后新开始跑的会话让路。
   */
  async runNow(scope: Scope, opts: { yieldOnlyToNew?: boolean } = {}): Promise<DreamsRunResult> {
    while (this.running !== undefined) await this.running.then(() => {}, () => {})
    if (this.isDisposed) return { kind: 'lost', steps: [], usageTokens: 0 }
    const run = this.runOne(scope, { by: 'manual', ...(opts.yieldOnlyToNew === true ? { yieldOnlyToNew: true } : {}) })
    this.running = run
    try {
      return await run
    } finally {
      this.running = undefined
      if (this.isRerunRequested) void this.recheck()
    }
  }

  /** 进行中的那一轮做完（没有就立刻）。 */
  whenIdle(): Promise<void> {
    return (this.running ?? Promise.resolve()).then(() => {}, () => {})
  }

  /** 插件卸载：停订阅和计时，取消正在跑的运行（在下一个检查点停，不写记录）并等它收尾。 */
  async dispose(): Promise<void> {
    this.isDisposed = true
    for (const stop of this.stops.splice(0)) stop()
    this.cancelQuietCheck?.()
    this.cancelQuietCheck = undefined
    this.controller?.abort(new DOMException('plugin unloaded', 'AbortError'))
    await this.whenIdle()
  }

  private async checkOnce(): Promise<void> {
    const { run } = this.deps
    // 治理关着：什么都不读
    if (!run.isGovernanceEnabled()) return
    const bad = this.deps.badConfigKeys?.() ?? []
    if (bad.length > 0) this.log.warn(`[plastic-memory] 记忆梦境的配置有不能用的值，这几项用默认值：${bad.join('、')}`)
    const state = await run.dreams.read()
    if (!state.isComplete) {
      this.log.warn('[plastic-memory] 记忆梦境的记录读不全，这一轮不运行')
      return
    }
    // 一个开着的都没有：不用列目录
    if (![...state.settings.values()].some(isOn => isOn)) return
    const listing = await this.deps.store.listWorkspaceDirs()
    for (const scope of scheduledScopes(listing.entries.map(e => e.workspacePath), state.settings.keys())) {
      if (this.isDisposed || !run.isGovernanceEnabled()) return
      if (!resolveDreamsEnabled(state.settings, scope).isEnabled) continue
      try {
        if (await this.isDue(scope, state)) await this.runOne(scope, { by: 'auto' })
      } catch (err) {
        this.log.warn('[plastic-memory] 记忆梦境查这个范围时出错，先看下一个', err)
      }
    }
  }

  /** 第 1、4、2 道门槛（第 3 道是认领，在运行里做）。 */
  private async isDue(scope: Scope, state: DreamsState): Promise<boolean> {
    const { run } = this.deps
    const record = state.records.get(scopeKey(scope))
    const base = { config: run.config(), record, usageRuns: state.usageRuns }
    if (!dreamsGate({ ...base, now: run.now() }).pass) return false
    // 读记忆数变化。读不全时不知道变了多少：交给运行，它在读基线那一步按出错收（记进结果、按出错的间隔重试）
    const changes = await countDreamChanges({ store: this.deps.store, dreams: run.dreams }, scope, record?.completed?.runId)
    if (!dreamsGate({ ...base, now: run.now(), changes }).pass) return false
    const now = run.now()
    return dreamsGate({ ...base, now, changes, isIdle: isIdle(await this.deps.board.view(), scope, base.config.idleMinutes * MINUTE_MS, now) }).pass
  }

  private async runOne(scope: Scope, opts: { by: 'auto' | 'manual'; yieldOnlyToNew?: boolean }): Promise<DreamsRunResult> {
    const controller = new AbortController()
    this.controller = controller
    try {
      const result = await runDreams(scope, { ...opts, signal: controller.signal }, this.deps.run)
      if (result.kind !== 'not-due' && result.kind !== 'busy' && result.kind !== 'disabled') {
        this.log.info(`[plastic-memory] 记忆梦境（${scopeKey(scope)}）：${result.kind}`)
      }
      return result
    } finally {
      if (this.controller === controller) this.controller = undefined
    }
  }
}
