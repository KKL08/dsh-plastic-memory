import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { MemoryLogger } from '../store.ts'
import type { SemanticLlm } from '../governance/semantic-scan.ts'
import type { LayerRef } from '../governance/layer-health.ts'
import type { CheckupRecordStore } from '../governance/checkup-records.ts'
import { executeScan, type ScanToolDeps, type ScanToolResult } from '../tools/scan.ts'
import type { CheckupView } from './contract.ts'

/** 插件启动后等这么久第一次检查（不跟首轮对话抢资源）。 */
export const AUTO_CHECKUP_FIRST_CHECK_MS = 3 * 60_000
/** 之后每隔这么久检查一次到期。不用几天后才触发的长定时器：笔记本睡眠时计时器会停，固定间隔检查醒来就能补上。 */
export const AUTO_CHECKUP_INTERVAL_MS = 10 * 60_000

/** 体检持有认领期间每隔这么久刷新一次认领时间；60 秒没刷新算残留（storage/sidecar.ts）。 */
export const CHECKUP_CLAIM_REFRESH_MS = 10_000

/** 定时重复执行 callback，返回停掉它的函数。 */
export type IntervalTimer = (callback: () => void, delayMs: number) => () => void

/** 宿主计时服务的结构子集（ctx.timeout / ctx.interval）：返回停掉它的函数，插件卸载时宿主也会停。 */
export interface AutoCheckupTimer {
  timeout(callback: () => void, delayMs: number): () => void
  interval: IntervalTimer
}

/** 进程自己的 setInterval（命令处理器没有宿主计时服务时用），不拖住进程退出。 */
export const processInterval: IntervalTimer = (callback, delayMs) => {
  const timer = setInterval(callback, delayMs)
  timer.unref()
  return () => { clearInterval(timer) }
}

/**
 * 体检开跑前认领这些范围并保持心跳，界面手动体检和自动体检共用。有一个范围认领不到（别的体检正认领着、没过期）就把已认领的
 * 立刻放掉，返回那个正在体检的范围。认领到之后每 10 秒刷新一次认领时间；刷新时发现认领已不是自己的（被当成残留清掉、
 * 别的进程接手了）就调 onLost，由调用方触发这次体检的取消信号：执行器在下一个写入检查点前停下，不再提交。
 * 认领到和放掉之后都调 onChange（重写体检视图里的「进行中」）。release 先停心跳、等在途的刷新做完，再放掉认领（只删自己的）。
 */
export async function holdCheckups(checkups: Pick<CheckupRecordStore, 'claim'>, layers: readonly LayerRef[], opts: {
  interval: IntervalTimer
  onLost: () => void
  onChange?: () => Promise<void> | void
  log: MemoryLogger
}): Promise<{ release: () => Promise<void> } | { busy: LayerRef }> {
  const claimed = await checkups.claim(layers)
  if ('busy' in claimed) return claimed
  let isLost = false
  // 刷新串成一条链，释放时等它跑完，免得放掉之后又被在途的刷新写回来
  let refreshing: Promise<void> = Promise.resolve()
  const stop = opts.interval(() => {
    refreshing = refreshing.then(async () => {
      if (isLost) return
      for (const claim of claimed.claims) {
        if (await claim.refresh()) continue
        isLost = true
        opts.log.info('[plastic-memory] 体检的认领被别的进程接手，这次体检停下、不提交')
        opts.onLost()
        return
      }
    }).catch((err: unknown) => { opts.log.warn('[plastic-memory] 刷新体检认领失败，下次心跳再试', err) })
  }, CHECKUP_CLAIM_REFRESH_MS)
  await opts.onChange?.()
  return {
    release: async () => {
      stop()
      await refreshing
      try {
        for (const claim of claimed.claims) await claim.release()
      } catch (err) {
        // 没放掉的认领不再刷新，60 秒后按残留处理
        opts.log.warn('[plastic-memory] 放掉体检认领失败，60 秒后按残留处理', err)
      }
      await opts.onChange?.()
    },
  }
}

export interface AutoCheckupSchedulerDeps {
  /** 体检执行器里和会话无关的依赖；模型、基线、所属项目由调度器按无会话给。 */
  scan: Omit<ScanToolDeps, 'getLlm' | 'getBaseline' | 'resolveContext' | 'now' | 'checkups'>
  /** 体检记录表：开跑前按范围认领，体检做完由执行器写完成记录。 */
  checkups: Pick<CheckupRecordStore, 'list' | 'complete' | 'claim'>
  /** 每个范围此刻的情况（体检视图的内容：有效频率、是否到期，全局在前、项目按路径排序）。每次检查现读，别的进程改的设置也能读到。 */
  status: () => Promise<CheckupView>
  /** 宿主当前的默认模型；拿不到为 null（这次不跑）。每次开跑现读，不缓存。 */
  getDefaultLlm: () => SemanticLlm | null
  /** 体检开关（用时读配置）：关着时不跑。 */
  isGovernanceEnabled: () => boolean
  timer: AutoCheckupTimer
  /** 每次检查读完状态后调用：重写体检视图（到期了、别的进程写了完成记录）。 */
  onChecked?: () => Promise<void>
  /** 认领到、放掉一个范围之后调用：重写体检视图（进行中）。 */
  onClaimChanged?: () => Promise<void>
  /** 一个范围体检完（没被取消）后调用：重写视图，以后在这里记最近一次结果。 */
  onScanned?: (layer: LayerRef, result: ScanToolResult) => Promise<void> | void
  now: () => number
  log?: MemoryLogger
}

/**
 * 自动体检调度：dsh 开着时，按共享的设置表和完成记录，在后台对到期的范围做体检。不借会话、不打断对话：
 * 用宿主的默认模型无会话调用，结果照常写缓存、挂账、写完成记录（发起方 auto），和手动体检那个范围同口径。
 * 到期的范围依次查、一次只跑一个（全局先，项目按路径）；一次检查每个范围只补一次。
 * 跨进程：开跑前认领这个范围（与界面手动体检共用，见 holdCheckups），别的进程正在查就跳过；认领到之后重读完成记录，
 * 别的进程刚查过、已经不到期的放掉不跑。持有期间心跳，认领被别的进程接手就取消这次体检、不再提交。
 * 卸载时取消正在跑的体检：执行器在写入检查点前停下，不写完成记录，下次照常到期。
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
    let status: CheckupView
    try {
      status = await this.deps.status()
    } catch (err) {
      this.log.warn('[plastic-memory] 自动体检读不到设置或体检记录，下次检查再试', err)
      return
    }
    await this.deps.onChecked?.()
    for (const { scope, isDue } of status.scopes) {
      if (!isDue) continue
      if (this.isDisposed || !this.deps.isGovernanceEnabled()) return
      // 每次开跑现读默认模型：用户在两次之间换了模型就用新的
      const llm = this.deps.getDefaultLlm()
      if (llm === null) {
        this.log.warn('[plastic-memory] 拿不到宿主的默认模型，自动体检这次不跑，下次检查再试')
        return
      }
      await this.run(scope.kind === 'global' ? { kind: 'global' } : { kind: 'workspace', path: scope.workspacePath }, llm)
    }
  }

  /** 体检一个范围，和手动体检那个范围同口径：项目读全局加本项目、写本项目的缓存；全局只查全局。后台没有会话投影，不查基线。 */
  private async run(layer: LayerRef, llm: SemanticLlm): Promise<void> {
    const controller = new AbortController()
    this.controller = controller
    let held: Awaited<ReturnType<typeof holdCheckups>> | undefined
    try {
      held = await holdCheckups(this.deps.checkups, [layer], {
        interval: (callback, delayMs) => this.deps.timer.interval(callback, delayMs),
        onLost: () => { controller.abort(new DOMException('checkup claim taken over', 'AbortError')) },
        ...(this.deps.onClaimChanged !== undefined ? { onChange: this.deps.onClaimChanged } : {}),
        log: this.log,
      })
      // 别的进程正在查这个范围：跳过；认领到之后别的进程刚查完、已经不到期的，也不跑
      if ('busy' in held || !(await this.isStillDue(layer))) return
      const result = await executeScan(
        layer.kind === 'global' ? { layers: 'full' } : { scope: layer.path, layers: 'full' },
        {
          ...this.deps.scan,
          checkups: this.deps.checkups,
          getLlm: () => llm,
          getBaseline: () => null,
          resolveContext: async () => ({ workspacePath: undefined }),
          now: this.deps.now,
        },
        { signal: controller.signal } as ToolRunContext,
        { by: 'auto', isGlobalOnly: layer.kind === 'global' },
      )
      if (result.kind === 'error') this.log.warn(`[plastic-memory] 自动体检没做成：${result.message}`)
      if (!controller.signal.aborted) await this.deps.onScanned?.(layer, result)
    } catch (err) {
      // 取消（插件卸载、认领被接手）不算失败：什么都不记，下次检查照常到期
      if (!controller.signal.aborted) this.log.warn('[plastic-memory] 自动体检出错，下次检查再试', err)
    } finally {
      if (held !== undefined && !('busy' in held)) await held.release()
      this.controller = undefined
    }
  }

  /** 认领到之后重读完成记录：这个范围此刻还到期。 */
  private async isStillDue(layer: LayerRef): Promise<boolean> {
    const { scopes } = await this.deps.status()
    return scopes.some(({ scope, isDue }) => isDue
      && (scope.kind === 'global' ? layer.kind === 'global' : layer.kind === 'workspace' && scope.workspacePath === layer.path))
  }
}
