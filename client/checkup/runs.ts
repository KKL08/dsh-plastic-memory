/**
 * 「立即体检」的进行中，三种来源合并成一个判断：
 * 1. 本窗口发起、命令还没回来的；
 * 2. 命令回 busy（范围正在别处体检）、体检视图还没重写的：视图读到新内容就以视图为准；
 * 3. 体检视图里 isInProgress 的（别的窗口或自动体检认领着这个范围）。
 * 本窗口发起、还在跑的「全部」让各范围都算进行中；「全部」回了 busy 只算「全部」自己（它没在查，是别处在查某个范围，
 * 那个范围由体检视图的 isInProgress 说明）；「全部」在任一范围进行中时都算。命令回别的错误（拿不到模型等）不算进行中，
 * 记成这个范围的「没做成」，状态条结果行读它；再发起一次、或体检视图里这个范围出现晚于失败的完成（别处体检成功了）就清掉。
 * 状态挂在记忆页这一层，切范围、切视图都不丢；标题行按钮和状态条结果行读同一份。
 */
import { useEffect, useRef, useState } from 'react'
import { scopeKey, type CheckupView, type GuiErrorCode, type MemoryCommand } from '../../src/gui/contract.ts'
import { useGateway, type BorrowedSession } from '../gateway.ts'
import { ALL_SCOPE, type PageScope } from '../nav.ts'

/** 本窗口发起的手动体检没做成（busy 之外的错误）：错误码和宿主或执行器的原话。 */
export interface RunFailure { code: GuiErrorCode; detail: string | undefined }

export interface CheckupRuns {
  /** 让 scope 显示「体检中…」的那个范围：本窗口发起的「全部」是 ALL_SCOPE；scope 是「全部」时取第一个在体检的。没有为 undefined。 */
  busyScope(scope: PageScope): PageScope | undefined
  /** 本窗口在这个范围发起的上一次手动体检没做成时的错误；「全部」只看「全部」那一次。 */
  failure(scope: PageScope): RunFailure | undefined
  /** 发起这个范围的体检；没有会话或已在进行中时什么都不做。 */
  run(scope: PageScope): void
}

/** 范围 → scan 的目标：「全部」不带参数，全局只查全局层，项目带它的路径。 */
export function scanCommand(scope: PageScope): MemoryCommand {
  return scope.kind === 'all' ? { cmd: 'scan' }
    : scope.kind === 'global' ? { cmd: 'scan', layer: { kind: 'global' } }
      : { cmd: 'scan', workspacePath: scope.workspacePath }
}

/** 本窗口记下的：running = 命令还没回来；busy = 命令回了 busy，等体检视图重写；failed = 回了别的错误（failedAt 是命令回来的时刻）。 */
type Entry = { scope: PageScope; state: 'running' | 'busy' } | { scope: PageScope; state: 'failed'; failure: RunFailure; failedAt: number }
type Local = ReadonlyMap<string, Entry>

export function useCheckupRuns(session: BorrowedSession, checkups: CheckupView | undefined): CheckupRuns {
  const gateway = useGateway()
  const [local, setLocal] = useState<Local>(new Map())
  const live = useRef(true)
  useEffect(() => () => { live.current = false }, [])
  // 体检视图重写了：busy 的以视图为准（别处的体检还在跑，视图里就是 isInProgress）；failed 的范围在别处体检成功了就收起
  useEffect(() => {
    const isStale = (e: Entry) => e.state === 'busy' || (e.state === 'failed' && checkups !== undefined && completedAfter(checkups, e.scope, e.failedAt))
    setLocal(prev => [...prev.values()].some(isStale) ? new Map([...prev].filter(([, e]) => !isStale(e))) : prev)
  }, [checkups])

  const active = [...local].filter(([, e]) => e.state !== 'failed')
  const viewBusy = (checkups?.scopes ?? []).filter(s => s.isInProgress).map((s): PageScope => s.scope)
  const busyScope = (scope: PageScope): PageScope | undefined => {
    if (active.some(([key, e]) => key === scopeKey(ALL_SCOPE) && e.state === 'running')) return ALL_SCOPE
    if (scope.kind === 'all') return active[0]?.[1].scope ?? viewBusy[0]
    const key = scopeKey(scope)
    return active.some(([k]) => k === key) || viewBusy.some(s => scopeKey(s) === key) ? scope : undefined
  }
  const failure = (scope: PageScope): RunFailure | undefined => {
    const entry = local.get(scopeKey(scope))
    return entry?.state === 'failed' ? entry.failure : undefined
  }
  const run = (scope: PageScope) => {
    if (session.kind !== 'ready' || busyScope(scope) !== undefined) return
    const key = scopeKey(scope)
    setLocal(prev => new Map(prev).set(key, { scope, state: 'running' }))
    void gateway.execute(session.sessionId, scanCommand(scope)).then((result) => {
      if (!live.current) return
      setLocal((prev) => {
        const next = new Map(prev)
        if (result.ok) next.delete(key)
        else if (result.code === 'busy') next.set(key, { scope, state: 'busy' })
        else next.set(key, { scope, state: 'failed', failure: { code: result.code, detail: result.detail }, failedAt: Date.now() })
        return next
      })
    })
  }
  return { busyScope, failure, run }
}

/** 体检视图里这个范围有晚于 at 的完成：上次体检或最近一次结果的完成时间；「全部」看「全部」那次的结果。 */
function completedAfter(checkups: CheckupView, scope: PageScope, at: number): boolean {
  if (scope.kind === 'all') return (checkups.allResult?.completedAt ?? -Infinity) > at
  const entry = checkups.scopes.find(s => scopeKey(s.scope) === scopeKey(scope))
  return entry !== undefined && Math.max(entry.lastCheckupAt ?? -Infinity, entry.lastResult?.completedAt ?? -Infinity) > at
}
