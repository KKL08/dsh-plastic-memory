import type { MemoryLogger } from '../store.ts'
import type { SemanticLlm } from '../governance/semantic-scan.ts'
import type { CheckupRecordStore } from '../governance/checkup-records.ts'
import { genId } from '../governance/schema.ts'
import { maskDiagnostic } from '../secrets.ts'
import { runScan, type ScanCoreDeps, type ScanInput, type ScanNote, type ScanToolResult } from '../tools/scan.ts'
import { checkupWorkspaces } from '../tools/scope-preread.ts'
import type { Scope } from '../scope.ts'
import { checkupKey, type CheckupCause, type PendingView } from './contract.ts'
import { checkupResults, type CheckupTarget, type GlobalViews } from './views.ts'
import type { ViewWriter } from './view-writer.ts'

/** 体检持有认领期间每隔这么久刷新一次认领时间；60 秒没刷新算残留（storage/sidecar.ts）。 */
export const CHECKUP_CLAIM_REFRESH_MS = 10_000

/** 定时重复执行 callback，返回停掉它的函数。 */
export type IntervalTimer = (callback: () => void, delayMs: number) => () => void

/** 进程自己的 setInterval（命令处理器没有宿主计时服务时用），不拖住进程退出。 */
export const processInterval: IntervalTimer = (callback, delayMs) => {
  const timer = setInterval(callback, delayMs)
  timer.unref()
  return () => { clearInterval(timer) }
}

/**
 * 体检开跑前认领这些范围并保持心跳。有一个范围认领不到（别的体检正认领着、没过期）就把已认领的
 * 立刻放掉，返回那个正在体检的范围。认领到之后每 10 秒刷新一次认领时间；刷新时发现认领已不是自己的（被当成残留清掉、
 * 别的进程接手了）就调 onLost，由调用方触发这次体检的取消信号：执行器在下一个写入检查点前停下，不再提交。
 * 认领到和放掉之后都调 onChange（重写体检视图里的「进行中」）。release 先停心跳、等在途的刷新做完，再放掉认领（只删自己的）。
 */
export async function holdCheckups(checkups: Pick<CheckupRecordStore, 'claim'>, scopes: readonly Scope[], opts: {
  interval: IntervalTimer
  onLost: () => void
  onChange?: () => Promise<void> | void
  log: MemoryLogger
}): Promise<{ release: () => Promise<void> } | { busy: Scope }> {
  const claimed = await checkups.claim(scopes)
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

export interface CheckupRunDeps {
  /** 体检核心里和这次体检无关的依赖；体检记录表和时钟单独给。 */
  scan: Omit<ScanCoreDeps, 'checkups' | 'now'>
  /** 体检记录表：认领、完成记录（核心写）、最近一次结果、自动体检的失败。 */
  checkups: Pick<CheckupRecordStore, 'list' | 'complete' | 'claim' | 'recordFailure' | 'recordResults'>
  /** 体检前只收集不落盘；体检后全量重写，返回值就是体检后的视图。 */
  views: Pick<ViewWriter, 'collectViews' | 'rewriteAll'>
  /** 持有认领期间的心跳计时。 */
  interval: IntervalTimer
  /** 认领到、放掉之后调用：重写体检视图（进行中）。 */
  onClaimChanged?: () => Promise<void> | void
  now: () => number
  log: MemoryLogger
}

export interface CheckupRunInput {
  /** 只查全局、某个项目，或全部（全局和开跑时库里的每个项目）。 */
  target: Scope | { kind: 'all' }
  by: 'manual' | 'auto'
  llm: SemanticLlm
  /** 当前会话的 AGENTS.md/CLAUDE.md 基线；null = 没有（自动体检无会话）。 */
  baseline: readonly string[] | null
  /** 当前会话的 workspace；缺省 = 没有当前项目。 */
  currentWorkspace?: string
  /** 调用方的取消信号（插件卸载）；认领被接手时这次体检另有自己的取消。 */
  signal?: AbortSignal
  /** 认领到之后、开跑之前再确认一次：返回 false 就放掉认领，结果算取消（自动体检传「仍到期」）。 */
  confirmHeld?: () => Promise<boolean>
}

export type CheckupRunOutcome =
  | {
      kind: 'done'
      /** 整次的说明码（「全部」体检时各范围的已经按范围写进体检记录）。 */
      notes: readonly ScanNote[]
      semanticBatches?: number
      usageTokens?: number
      /** 体检前的待处理和体检后的视图；收集出错时缺省，结果里不给新增与分数。 */
      compared?: { before: PendingView; after: GlobalViews }
    }
  | { kind: 'busy'; scope: Scope }
  | { kind: 'cancelled' }
  | { kind: 'failed'; cause: CheckupCause }
  | { kind: 'model-unavailable'; cause: CheckupCause }

/**
 * 一次体检，界面手动体检和自动体检共用（agent 的 memory_scan 不经这里、不认领）：
 * 认领范围 → （可选）再确认 → 收集体检前的待处理 → 体检核心 → 清过期的已结清条目 → 立刻重写视图 → 按范围写最近一次结果 → 放掉认领。
 * 认领期间要写的体检记录都在这里写：完成记录由核心在提交点写，最近一次结果、自动体检的失败在放掉认领之前写，别的进程这时还接不了手。
 * 认领被接手或调用方取消时不留半截结果：核心在写入检查点前停下，不写完成记录和结果，这个范围照常到期；
 * 取消落在核心提交之后的，体检算做完，只是不写最近一次结果。
 *
 * 内容检查没做成（模型出错、宿主报模型用不了）两边口径不同：手动体检照样算做完，说明码带原因交给界面，结果照写；
 * 自动体检要据它记失败、管重试节奏，所以模型出错记失败返回「失败」，模型用不了不记、返回原因交给调度器。
 */
export async function runCheckup(input: CheckupRunInput, deps: CheckupRunDeps): Promise<CheckupRunOutcome> {
  const { by, target } = input
  // 「全部」只查认领到的项目：核心自己再枚举会把认领之后才建的项目也查了
  const scopes: Scope[] = target.kind === 'all'
    ? [{ kind: 'global' }, ...checkupWorkspaces(await deps.scan.store.listWorkspaceDirs()).map(workspacePath => ({ kind: 'workspace' as const, workspacePath }))]
    : [target]
  const controller = new AbortController()
  const signal = input.signal !== undefined ? AbortSignal.any([input.signal, controller.signal]) : controller.signal
  let held: Awaited<ReturnType<typeof holdCheckups>> | undefined
  let isCommitted = false
  // 体检挂了账、写了缓存和完成记录：先清过期的已结清条目，再立刻重写视图，体检后的视图就是重写收集到的这份。
  // 清理是顺带的：体检这时已经提交，清不掉只记日志，不把做完的体检报成失败
  const refresh = async (startedAt: number) => {
    try {
      await deps.scan.decisions.sweep(startedAt)
    } catch (err) {
      deps.log.warn('[plastic-memory] 体检后清理过期的已结清条目失败，下次再清', err)
    }
    return await deps.views.rewriteAll()
  }
  let startedAt: number | undefined
  try {
    held = await holdCheckups(deps.checkups, scopes, {
      interval: deps.interval,
      onLost: () => { controller.abort(new DOMException('checkup claim taken over', 'AbortError')) },
      ...(deps.onClaimChanged !== undefined ? { onChange: deps.onClaimChanged } : {}),
      log: deps.log,
    })
    if ('busy' in held) return { kind: 'busy', scope: held.busy }
    if (input.confirmHeld !== undefined && !(await input.confirmHeld())) return { kind: 'cancelled' }

    // 新增条数是附带的：收集视图出错只记日志、不记结果，不挡体检本身
    const collect = () => deps.views.collectViews().catch((err: unknown) => {
      deps.log.warn('[plastic-memory] 体检前后收集视图失败，这次不记新增', err)
      return undefined
    })
    const before = (await collect())?.pending
    const workspaces = scopes.flatMap(s => (s.kind === 'workspace' ? [s.workspacePath] : []))
    // 「全部」时一个项目都没有就只查全局（空的项目列表不是全库体检），结果仍记在「全部」名下
    const scanTarget: ScanInput['target'] = target.kind === 'all' && workspaces.length > 0
      ? { kind: 'checkup', workspaces }
      : { kind: 'scope', scope: target.kind === 'all' ? { kind: 'global' } : target }
    const scopeNotes = new Map<string, readonly ScanNote[]>()
    // 开始时间是核心开读的时刻：认领、收集视图花的时间不算，完成记录才不会被这段时间里开跑的 agent 体检挡掉
    startedAt = deps.now()
    const result = await runScan({
      target: scanTarget, layers: 'full', llm: input.llm, baseline: input.baseline,
      ...(input.currentWorkspace !== undefined ? { currentWorkspace: input.currentWorkspace } : {}),
      signal, startedAt,
    }, { ...deps.scan, checkups: deps.checkups, now: deps.now }, {
      by, onScopeNotes: (scope, notes) => { scopeNotes.set(checkupKey(scope), notes) }, onCommitted: () => { isCommitted = true },
    })
    const after = await refresh(startedAt) ?? (before === undefined ? undefined : await collect())
    // 核心提交之后才被取消（认领被接手、插件卸载）：体检已经做完，只是不写最近一次结果，免得盖掉接手的那次
    if (signal.aborted) return result.kind === 'error' ? { kind: 'cancelled' } : doneOf(result)
    if (result.kind === 'error') return await failed(input, deps, scopes, { kind: 'error', message: result.message }, startedAt)
    if (by === 'auto') {
      const unavailable = result.notes.find(n => n.code === 'model-unavailable')
      if (unavailable !== undefined) return { kind: 'model-unavailable', cause: unavailable.cause ?? { kind: 'model-error' } }
      const semanticFailed = result.notes.find(n => n.code === 'semantic-failed')
      if (semanticFailed !== undefined) return await failed(input, deps, scopes, semanticFailed.cause ?? { kind: 'model-error' }, startedAt)
    }
    const compared = before !== undefined && after !== undefined ? { before, after } : undefined
    if (compared !== undefined) {
      // 体检这时已经提交，记不下结果只记日志，不把做完的体检报成失败
      try {
        const resultTarget: CheckupTarget = target.kind === 'all' ? { kind: 'all', scopes } : target
        await deps.checkups.recordResults(checkupResults(compared.before, compared.after.pending, {
          target: resultTarget, checkupId: genId('ck'), by, completedAt: deps.now(), notes: result.notes, scopeNotes,
          ...(result.usageTokens !== undefined ? { usageTokens: result.usageTokens } : {}),
        }))
      } catch (err) {
        deps.log.warn('[plastic-memory] 记不下体检的结果', err)
      }
    }
    return doneOf(result, compared)
  } catch (err) {
    if (signal.aborted) {
      if (!isCommitted || startedAt === undefined) return { kind: 'cancelled' }
      // 核心提交之后、跑完之前被取消（全部体检提交后还有跨项目分析）：体检已经做完，照样刷新视图，不写最近一次结果；
      // 结果没拿到，说明码随之没有。刷新出错只记日志，不把做完的体检报成失败
      try {
        await refresh(startedAt)
      } catch (err) {
        deps.log.warn('[plastic-memory] 体检取消后刷新视图失败，下次重写再补', err)
      }
      return { kind: 'done', notes: [] }
    }
    // 原话进体检记录和视图：先遮掉疑似密钥
    return await failed(input, deps, scopes, { kind: 'error', message: maskDiagnostic(err instanceof Error ? err.message : String(err)) }, startedAt)
  } finally {
    if (held !== undefined && !('busy' in held)) await held.release()
  }
}

function doneOf(result: Exclude<ScanToolResult, { kind: 'error' }>, compared?: { before: PendingView; after: GlobalViews }): CheckupRunOutcome {
  return {
    kind: 'done', notes: result.notes,
    ...(result.semanticBatches !== undefined ? { semanticBatches: result.semanticBatches } : {}),
    ...(result.usageTokens !== undefined ? { usageTokens: result.usageTokens } : {}),
    ...(compared !== undefined ? { compared } : {}),
  }
}

/** 没做完：自动体检在放掉认领之前给这次的范围记失败（连续失败计数、重试时间）；手动不记，交给界面回失败。 */
async function failed(input: CheckupRunInput, deps: CheckupRunDeps, scopes: readonly Scope[], cause: CheckupCause, startedAt?: number): Promise<CheckupRunOutcome> {
  if (input.by === 'auto') {
    deps.log.warn('[plastic-memory] 自动体检没做完，稍后再试', cause)
    try {
      for (const scope of scopes) await deps.checkups.recordFailure(scope, cause, deps.now(), startedAt)
    } catch (err) {
      // 记不下也不挡：没有失败记录，下一次检查照常到期再试
      deps.log.warn('[plastic-memory] 记不下自动体检的失败，下次检查再试', err)
    }
  }
  return { kind: 'failed', cause }
}
