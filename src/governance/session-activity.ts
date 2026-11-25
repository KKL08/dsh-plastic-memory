import type { CasKvTable, CheckedListKvTable } from '../kv-table.ts'
import type { ActivityEntry } from '../storage/schema.ts'
import type { MemoryLogger } from '../store.ts'
import { GLOBAL_SCOPE_KEY, type Scope } from '../scope.ts'

/**
 * 活动表：哪些工作目录现在有会话在跑、最近一次活动是什么时候。宿主没有「工作目录空闲」的事件，也看不到别的进程里的会话，
 * 所以每个装了本插件的宿主进程自己记（听 agent 的状态变化），写到共享的侧表里，别的进程读它。
 * 记忆梦境用它判空闲（开始之前）和让路（运行期间）。只看得到装了这一版及以上插件的进程。
 */

/** 会话的工作目录还没解析出来时先记在这个键下：对所有范围都算有会话在跑。 */
export const UNKNOWN_WORKSPACE_KEY = '?'
/** 有会话在跑期间每隔这么久刷新一次自己那条的时间。 */
export const ACTIVITY_HEARTBEAT_MS = 60_000
/** 一条标着有会话在跑、却这么久没刷新的：那个进程当作已经没了。 */
export const ACTIVITY_STALE_MS = 3 * 60_000
/** 第一次写自己那条时顺手清掉这么久没更新的条目。 */
export const ACTIVITY_PRUNE_MS = 7 * 86_400_000
/** 别的进程的条目最多隔这么久重读一次（运行期间查让路用）。 */
export const ACTIVITY_REREAD_MS = 30_000

export interface WorkspaceActivity { isRunning: boolean; lastActiveAt: number; lastStartedAt?: number }

/** 各进程合起来的样子。isComplete 为假：有条目读不出，或本进程还没把现有的会话列完，这时不能下「空闲」的结论。 */
export interface ActivityView { isComplete: boolean; workspaces: ReadonlyMap<string, WorkspaceActivity> }

/** 把各进程的条目合成一张：同一个工作目录取「有一个在跑就算在跑」、时间取最大。久不刷新的条目按那个进程已经没了算。 */
export function mergeActivity(entries: readonly ActivityEntry[], now: number): Map<string, WorkspaceActivity> {
  const merged = new Map<string, WorkspaceActivity>()
  for (const entry of entries) {
    const isGone = now - entry.at > ACTIVITY_STALE_MS
    for (const [key, ws] of Object.entries(entry.workspaces)) {
      // 进程没了：它那里在跑的都按停了算，最后活动时间取它最后一次心跳
      const isRunning = ws.isRunning && !isGone
      // 开始时刻只取还在跑的那些会话的：已经停了的会话什么时候开始的，和「现在在跑的是不是新开的」无关
      const startedAt = isRunning ? ws.lastStartedAt : undefined
      const lastActiveAt = isGone && ws.isRunning ? Math.max(ws.lastActiveAt, entry.at) : ws.lastActiveAt
      const cur = merged.get(key)
      const lastStartedAt = cur?.lastStartedAt === undefined ? startedAt : startedAt === undefined ? cur.lastStartedAt : Math.max(cur.lastStartedAt, startedAt)
      merged.set(key, {
        isRunning: (cur?.isRunning ?? false) || isRunning,
        lastActiveAt: Math.max(cur?.lastActiveAt ?? 0, lastActiveAt),
        ...(lastStartedAt !== undefined ? { lastStartedAt } : {}),
      })
    }
  }
  return merged
}

/** 这个工作目录键算不算在这个范围里：全局范围各项目共用，所有工作目录都算；项目范围只算它自己和还没解析出来的。 */
const concerns = (scope: Scope, key: string) => scope.kind === 'global' || key === scope.workspacePath || key === UNKNOWN_WORKSPACE_KEY

/** 这个范围空闲：涉及的工作目录都没有会话在跑，并且最近一次活动距现在不少于 idleMs。读不全时不算空闲。 */
export function isIdle(view: ActivityView, scope: Scope, idleMs: number, now: number): boolean {
  if (!view.isComplete) return false
  for (const [key, ws] of view.workspaces) {
    if (concerns(scope, key) && (ws.isRunning || now - ws.lastActiveAt < idleMs)) return false
  }
  return true
}

/**
 * 这个范围现在有会话在跑（让路用，不看空闲了多久）。since：只算这个时刻之后才开始跑的（用户坚持立即运行时，
 * 开始前就在跑的不算）。读不全时按有算。
 */
export function isAnyRunning(view: ActivityView, scope: Scope, since?: number): boolean {
  if (!view.isComplete) return true
  for (const [key, ws] of view.workspaces) {
    if (concerns(scope, key) && ws.isRunning && (since === undefined || (ws.lastStartedAt ?? ws.lastActiveAt) > since)) return true
  }
  return false
}

/** 宿主里 agent 的状态来源（接线层给，见 cordis-host-session.ts）。agent 按对象引用认。 */
export interface AgentActivitySource {
  /** 订阅状态变化；返回退订。 */
  onStatus(listener: (agent: object, status: string) => void): () => void
  /** 此刻活着的 agent 和各自的状态；宿主没有这个服务为 undefined。 */
  list(): Array<{ agent: object; status: string }> | undefined
  /** 这个 agent 的会话所属的工作目录键：项目根；没有工作目录的是 GLOBAL_SCOPE_KEY。 */
  workspaceKeyOf(agent: object): Promise<string>
}

export interface ActivityBoardDeps {
  table: CasKvTable<ActivityEntry> & CheckedListKvTable<ActivityEntry>
  /** 这个进程的条目键：启动时生成，进程内不变。 */
  processId: string
  source: AgentActivitySource
  interval: (callback: () => void, delayMs: number) => () => void
  now: () => number
  log?: MemoryLogger
}

const RUNNING = 'running'

/** agent 的一次运行：每次开始跑新建一个，工作目录解析回来时只认自己这一次。 */
interface Run { key: string; startedAt: number; stoppedAt?: number }

export class ActivityBoard {
  private readonly deps: ActivityBoardDeps
  private readonly log: MemoryLogger
  /** 本进程里在跑的 agent → 这一次运行（工作目录键没解析出来之前是 UNKNOWN_WORKSPACE_KEY）。 */
  private readonly running = new Map<object, Run>()
  /** 工作目录还没解析出来的运行（含已经停了的）：都解析完了「未知」那一项才能拿掉。 */
  private unresolved = 0
  /** 本进程见过的工作目录的活动时间（停了的也留着，算空闲时间要用）。 */
  private readonly seen = new Map<string, { lastActiveAt: number; lastStartedAt?: number }>()
  private readonly quietListeners = new Set<() => void>()
  private stops: Array<() => void> = []
  private stopHeartbeat: (() => void) | undefined
  private isSeeded = false
  private isPruned = false
  private isDisposed = false
  private writing: Promise<void> = Promise.resolve()
  private others: { at: number; entries: ActivityEntry[]; isComplete: boolean } | undefined

  constructor(deps: ActivityBoardDeps) {
    this.deps = deps
    this.log = deps.log ?? console
  }

  /** 先订阅、再把此刻已在跑的记一遍（插件重载时已有会话在跑）。没有会话在跑时不碰磁盘。 */
  async start(): Promise<void> {
    this.stops.push(this.deps.source.onStatus((agent, status) => this.onStatus(agent, status)))
    if (!this.reconcile()) this.log.warn('[plastic-memory] 宿主现在列不出 agent，判断不了有没有会话在跑；列得出之前记忆梦境不会自动运行')
  }

  /**
   * 和宿主此刻的 agent 列表对一遍：列表里在跑、这里还没记的补记上（插件重载时已有会话在跑）；这里记着在跑、
   * 列表里已经没有或不在跑的按停了记（agent 没发停下的事件就被销毁了）。列不出返回 false，什么都不改。
   */
  private reconcile(): boolean {
    const listed = this.deps.source.list()
    if (listed === undefined) return false
    const live = new Set(listed.filter(a => a.status === RUNNING).map(a => a.agent))
    for (const agent of live) this.onStatus(agent, RUNNING)
    for (const agent of [...this.running.keys()]) if (!live.has(agent)) this.onStatus(agent, 'gone')
    this.isSeeded = true
    return true
  }

  /** 本进程里有工作目录从有会话在跑变成没有时调用（调度据此排一次检查）。返回退订。 */
  onQuiet(listener: () => void): () => void {
    this.quietListeners.add(listener)
    return () => this.quietListeners.delete(listener)
  }

  /** 各进程合起来的样子。本进程的取内存里的；别的进程的读侧表，maxAgeMs 之内读过就用上次的。 */
  async view(maxAgeMs = 0): Promise<ActivityView> {
    const now = this.deps.now()
    // 启动时宿主还列不出 agent 的：之后每次读都再试
    if (!this.isSeeded) this.reconcile()
    if (this.others === undefined || now - this.others.at >= maxAgeMs) {
      try {
        const read = await this.deps.table.listChecked()
        this.others = { at: now, entries: read.entries.map(([, entry]) => entry).filter(entry => entry.id !== this.deps.processId), isComplete: read.isComplete }
      } catch (err) {
        this.log.warn('[plastic-memory] 活动表读不出，这次按有会话在跑处理', err)
        return { isComplete: false, workspaces: new Map() }
      }
    }
    return { isComplete: this.isSeeded && this.others.isComplete, workspaces: mergeActivity([...this.others.entries, this.own(now)], now) }
  }

  /** 插件卸载：停订阅和心跳，把自己那条写成都不在跑（条目留着，别的进程还要用它算空闲时间）。 */
  async dispose(): Promise<void> {
    this.isDisposed = true
    for (const stop of this.stops.splice(0)) stop()
    this.stopHeartbeat?.()
    this.stopHeartbeat = undefined
    const now = this.deps.now()
    for (const run of this.running.values()) this.touch(run.key, now)
    this.running.clear()
    this.write()
    await this.writing
  }

  private onStatus(agent: object, status: string): void {
    if (this.isDisposed) return
    const now = this.deps.now()
    if (status === RUNNING) {
      if (this.running.has(agent)) return
      // 工作目录要异步解析：解析出来之前先记在「未知」下，对所有范围都算有会话在跑
      const run: Run = { key: UNKNOWN_WORKSPACE_KEY, startedAt: now }
      this.running.set(agent, run)
      this.unresolved++
      this.touch(UNKNOWN_WORKSPACE_KEY, now, true)
      void this.deps.source.workspaceKeyOf(agent).then(key => key, (err: unknown) => {
        this.log.warn('[plastic-memory] 会话的工作目录解析不出，按没有工作目录记', err)
        return GLOBAL_SCOPE_KEY
      }).then((key) => {
        if (this.isDisposed) return
        // 这一次运行的时刻补记到真正的工作目录上；解析回来时它已经停了的，停下的时刻也补上
        run.key = key
        this.touch(key, run.startedAt, true)
        if (run.stoppedAt !== undefined) this.touch(key, run.stoppedAt)
        if (--this.unresolved === 0) this.seen.delete(UNKNOWN_WORKSPACE_KEY)
        this.write()
      })
    } else {
      const run = this.running.get(agent)
      if (run === undefined) return
      this.running.delete(agent)
      run.stoppedAt = now
      this.touch(run.key, now)
      if (!this.isRunningIn(run.key)) for (const listener of this.quietListeners) listener()
    }
    this.write()
    this.syncHeartbeat()
  }

  private isRunningIn(key: string): boolean {
    for (const run of this.running.values()) if (run.key === key) return true
    return false
  }

  private touch(key: string, now: number, isStart = false): void {
    const cur = this.seen.get(key)
    this.seen.set(key, {
      lastActiveAt: Math.max(cur?.lastActiveAt ?? 0, now),
      ...(isStart || cur?.lastStartedAt !== undefined ? { lastStartedAt: isStart ? Math.max(cur?.lastStartedAt ?? 0, now) : cur!.lastStartedAt! } : {}),
    })
  }

  /** 本进程此刻的条目。 */
  private own(now: number): ActivityEntry {
    const runningKeys = new Set([...this.running.values()].map(run => run.key))
    const workspaces: ActivityEntry['workspaces'] = {}
    for (const [key, ws] of this.seen) workspaces[key] = { isRunning: runningKeys.has(key), ...ws }
    return { id: this.deps.processId, at: now, workspaces }
  }

  /** 写自己那条。串成一条链，后写的不会被先写的盖掉；写不进记日志，下次状态变化或心跳再写。 */
  private write(): void {
    this.writing = this.writing.then(async () => {
      await this.deps.table.put(this.deps.processId, this.own(this.deps.now()))
      // 第一次写的时候顺手清掉很久没更新的条目（不放在启动时：插件加载不碰磁盘）
      if (!this.isPruned) {
        this.isPruned = true
        await this.prune()
      }
    }).catch((err: unknown) => { this.log.warn('[plastic-memory] 活动表写不进，下次再写', err) })
  }

  /** 有会话在跑期间定时刷新自己那条的时间；都不在跑就停。 */
  private syncHeartbeat(): void {
    if (this.running.size > 0 && this.stopHeartbeat === undefined) {
      this.stopHeartbeat = this.deps.interval(() => {
        // 顺手和宿主的列表对一遍；它里面有变化时已经写过，没变化时这里刷新时间
        this.reconcile()
        this.write()
      }, ACTIVITY_HEARTBEAT_MS)
    } else if (this.running.size === 0 && this.stopHeartbeat !== undefined) {
      this.stopHeartbeat()
      this.stopHeartbeat = undefined
    }
  }

  /** 做完在途的写入（测试和卸载用）。 */
  whenWritten(): Promise<void> {
    return this.writing
  }

  private async prune(): Promise<void> {
    try {
      const now = this.deps.now()
      for (const [key, entry] of await this.deps.table.list()) {
        if (key !== this.deps.processId && now - entry.at > ACTIVITY_PRUNE_MS) await this.deps.table.deleteIf(key, cur => cur.at === entry.at)
      }
    } catch (err) {
      this.log.warn('[plastic-memory] 清理活动表里的旧条目失败，下次启动后再试', err)
    }
  }
}
