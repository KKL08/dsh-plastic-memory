import type { MemoryLogger } from '../store.ts'
import type { SemanticLlm } from '../governance/semantic-scan.ts'
import type { HostSession } from '../tools/host-session.ts'
import { scopeKey, type Scope } from '../scope.ts'
import type { CheckupRecordStore } from '../governance/checkup-records.ts'
import type { CheckupCause, CheckupView } from './contract.ts'
import { runCheckup, type CheckupRunDeps, type IntervalTimer } from './checkup-run.ts'
import type { CheckupSuggestions } from './checkup-suggestions.ts'

/** 插件启动后等这么久第一次检查（不跟首轮对话抢资源）。 */
export const AUTO_CHECKUP_FIRST_CHECK_MS = 3 * 60_000
/** 之后每隔这么久检查一次到期。不用几天后才触发的长定时器：笔记本睡眠时计时器会停，固定间隔检查醒来就能补上。 */
export const AUTO_CHECKUP_INTERVAL_MS = 10 * 60_000

/** 宿主计时服务的结构子集（ctx.timeout / ctx.interval）：返回停掉它的函数，插件卸载时宿主也会停。 */
export interface AutoCheckupTimer {
  timeout(callback: () => void, delayMs: number): () => void
  interval: IntervalTimer
}

export interface AutoCheckupSchedulerDeps {
  /** 体检核心里和会话无关的依赖（含按范围取指令文件）；模型、所属项目由调度器按无会话给。 */
  scan: CheckupRunDeps['scan']
  /** 体检记录表：一次体检认领、写完成记录、最近一次结果和失败；调度器自己只读状态、记「模型用不了」。 */
  checkups: CheckupRunDeps['checkups'] & Pick<CheckupRecordStore, 'recordModelUnavailable'>
  /** 体检前收集待处理、体检后立刻重写视图（比出这次的新增）。 */
  views: CheckupRunDeps['views']
  /** 每个范围此刻的情况（体检视图的内容：有效频率、是否到期，全局在前、项目按路径排序）。每次检查现读，别的进程改的设置也能读到。 */
  status: () => Promise<CheckupView>
  /** 宿主当前的默认模型；拿不到为 null（这次不跑）。每次开跑现读，不缓存。 */
  host: Pick<HostSession, 'defaultLlm'>
  /** 体检开关（用时读配置）：关着时不跑。 */
  isGovernanceEnabled: () => boolean
  timer: AutoCheckupTimer
  /** 每次检查读完状态后、记下「模型用不了」后调用：重写体检视图（到期了、别的进程写了完成记录、模型用不了）。 */
  onChecked?: () => Promise<void>
  /** 认领到、放掉一个范围之后调用：重写体检视图（进行中）。 */
  onClaimChanged?: () => Promise<void>
  /** 体检之后的后续段（给冲突生成处理建议，一次最多 10 条）；缺省不生成。 */
  suggestions?: Pick<CheckupSuggestions, 'run'>
  now: () => number
  log?: MemoryLogger
}

/**
 * 自动体检调度：dsh 开着时，按共享的设置表和完成记录，在后台对到期的范围做体检。不借会话、不打断对话：
 * 每个范围经一次体检（checkup-run.ts，与界面手动体检同一套规则）：用宿主的默认模型无会话调用，结果照常写缓存、挂账、写完成记录（发起方 auto），
 * 做完立刻重写视图、记下最近一次结果（新增、用量、说明），再给新的冲突逐条生成处理建议（后续段，见 checkup-suggestions.ts）。
 * 后台调用不经过会话，宿主的用量统计看不到，用量取宿主流 usage 块报的数，由插件记在结果里（含生成建议的那几次）。
 * 到期的范围依次查、一次只跑一个（全局先，项目按路径）；一次检查每个范围只补一次。
 * 跨进程：一次体检开跑前认领这个范围，别的进程正在查就跳过；认领到之后经「认领后确认」重读完成记录，
 * 别的进程刚查过、已经不到期的放掉不跑。持有期间心跳，认领被别的进程接手就取消这次体检、不再提交。
 * 卸载时取消正在跑的体检：执行器在写入检查点前停下，不写完成记录，下次照常到期。
 *
 * 没做成的两类，都记进体检记录（各进程共有的事实），不写完成记录、不重新计时：
 * - 模型用不了（拿不到默认模型，或宿主报未登录、缺凭据）：不算失败，由调度器给这次检查里到期的范围都记上原因、不再往下试，下一次检查再试；
 * - 失败（模型调用出错、输出解析不了、体检出错）：一次体检在放掉认领之前记，连续失败次数加一，1 小时后再试，连续 3 次后等到下一个周期；做完一次体检就清零。
 * 取消（插件卸载、认领被别的进程接手）两样都不记。
 */
export class AutoCheckupScheduler {
  private readonly deps: AutoCheckupSchedulerDeps
  private readonly log: MemoryLogger
  private readonly stops: Array<() => void> = []
  private running: Promise<void> | undefined
  private isRerunRequested = false
  private controller: AbortController | undefined
  private isDisposed = false

  constructor(deps: AutoCheckupSchedulerDeps) {
    this.deps = deps
    this.log = deps.log ?? console
  }

  /** 排上第一次检查（3 分钟后），之后每 10 分钟一次。 */
  start(): void {
    this.stops.push(this.deps.timer.timeout(() => {
      if (this.isDisposed) return
      void this.recheck()
      this.stops.push(this.deps.timer.interval(() => void this.recheck(), AUTO_CHECKUP_INTERVAL_MS))
    }, AUTO_CHECKUP_FIRST_CHECK_MS))
  }

  /**
   * 立刻检查一次（设置改了、体检开关打开时也调它）。正在检查或体检时不另起一个：等这一轮做完再查一遍。
   * 返回这一轮（含补的那遍）做完的时刻。
   */
  recheck(): Promise<void> {
    if (this.isDisposed) return Promise.resolve()
    if (this.running !== undefined) {
      this.isRerunRequested = true
      return this.running
    }
    const run = (async () => {
      try {
        do {
          this.isRerunRequested = false
          await this.checkOnce()
        } while (this.isRerunRequested && !this.isDisposed)
      } finally {
        this.running = undefined
      }
    })()
    this.running = run
    return run
  }

  /** 正在进行的这一轮做完（没有在跑就立刻）。 */
  whenIdle(): Promise<void> {
    return this.running ?? Promise.resolve()
  }

  /** 插件卸载：停掉定时器，取消正在跑的体检并等它收尾。 */
  async dispose(): Promise<void> {
    this.isDisposed = true
    for (const stop of this.stops.splice(0)) stop()
    this.controller?.abort(new DOMException('plugin unloaded', 'AbortError'))
    await this.running
  }

  private async checkOnce(): Promise<void> {
    // 这轮检查的开始时间：下面的到期范围都按这时读到的状态定
    const startedAt = this.deps.now()
    let status: CheckupView
    try {
      status = await this.deps.status()
    } catch (err) {
      this.log.warn('[plastic-memory] 自动体检读不到设置或体检记录，下次检查再试', err)
      return
    }
    await this.deps.onChecked?.()
    const now = this.deps.now()
    // 到期、且没在等失败后的重试时间的范围
    const due = status.scopes.filter(s => s.isDue && (s.failure === null || s.failure.retryAt <= now))
    for (const [i, { scope }] of due.entries()) {
      if (this.isDisposed || !this.deps.isGovernanceEnabled()) return
      // 每次开跑现读默认模型：用户在两次之间换了模型就用新的
      const llm = this.deps.host.defaultLlm()
      const outcome = llm === null
        ? { modelUnavailable: { kind: 'no-default-model' as const } }
        : await this.run(scope, llm)
      if (outcome === undefined) continue
      // 模型用不了：别的到期范围不再白试，都记上同一个原因（别的进程正在查的不碰），下一次检查再试
      this.log.warn('[plastic-memory] 默认模型现在用不了，自动体检这次不跑，下次检查再试', outcome.modelUnavailable)
      await this.recordModelUnavailable(due.slice(i).filter(s => !s.isInProgress).map(s => s.scope), outcome.modelUnavailable, startedAt)
      return
    }
  }

  private async recordModelUnavailable(scopes: readonly Scope[], cause: CheckupCause, since: number): Promise<void> {
    try {
      for (const scope of scopes) await this.deps.checkups.recordModelUnavailable(scope, cause, since)
    } catch (err) {
      this.log.warn('[plastic-memory] 记不下「模型用不了」，下次检查再试', err)
    }
    await this.deps.onChecked?.()
  }

  /**
   * 体检一个范围，和手动体检那个范围同口径：项目读全局加本项目、写本项目的缓存；全局只查全局。指令文件按范围现读，垂直冲突照查。
   * 没做完的由一次体检记失败；碰上模型用不了不记，返回原因交给调用方。取消（插件卸载、认领被接手、已不到期）什么都不记。
   */
  private async run(scope: Scope, llm: SemanticLlm): Promise<{ modelUnavailable: CheckupCause } | undefined> {
    const controller = new AbortController()
    this.controller = controller
    try {
      const outcome = await runCheckup({
        target: scope, by: 'auto', llm, signal: controller.signal,
        confirmHeld: () => this.isStillDue(scope),
      }, {
        scan: this.deps.scan, checkups: this.deps.checkups, views: this.deps.views,
        interval: (callback, delayMs) => this.deps.timer.interval(callback, delayMs),
        ...(this.deps.onClaimChanged !== undefined ? { onClaimChanged: this.deps.onClaimChanged } : {}),
        now: this.deps.now, log: this.log,
      })
      // 体检已经做完、认领已放掉：后续段在这里接着跑，卸载时同一个取消信号停下它（不等在途的模型调用）。
      // 它自己兜住异常，不进这个范围的失败计数；等它跑完再查下一个范围，后台同时只有一次模型调用
      await this.deps.suggestions?.run({ target: scope, by: 'auto', llm, outcome, signal: controller.signal })
      return outcome.kind === 'model-unavailable' ? { modelUnavailable: outcome.cause } : undefined
    } finally {
      this.controller = undefined
    }
  }

  /** 认领到之后重读体检记录：这个范围此刻还到期（别的进程刚查完的不到期；别的进程刚记了失败、还没到重试时间的也不跑）。 */
  private async isStillDue(target: Scope): Promise<boolean> {
    const { scopes } = await this.deps.status()
    const now = this.deps.now()
    return scopes.some(({ scope, isDue, failure }) => isDue && (failure === null || failure.retryAt <= now) && scopeKey(scope) === scopeKey(target))
  }
}
