import { describe, expect, it } from 'vitest'
import {
  ACTIVITY_HEARTBEAT_MS, ACTIVITY_PRUNE_MS, ACTIVITY_STALE_MS, ActivityBoard, UNKNOWN_WORKSPACE_KEY, isAnyRunning, isIdle, mergeActivity,
  type ActivityView, type AgentActivitySource,
} from '../src/governance/session-activity.ts'
import type { ActivityEntry } from '../src/storage/schema.ts'
import { InMemoryKvTable } from './helpers/in-memory-kv.ts'

// 活动表：各进程记下哪些工作目录有会话在跑，记忆梦境据此判空闲和让路

const NOW = 1_800_000_000_000
const MIN = 60_000
const IDLE = 30 * MIN
const A = '/proj/a'
const B = '/proj/b'
const wsA = { kind: 'workspace', workspacePath: A } as const
const wsB = { kind: 'workspace', workspacePath: B } as const
const GLOBAL = { kind: 'global' } as const

const entry = (id: string, at: number, workspaces: ActivityEntry['workspaces']): ActivityEntry => ({ id, at, workspaces })
const viewOf = (entries: ActivityEntry[], isComplete = true): ActivityView => ({ isComplete, workspaces: mergeActivity(entries, NOW) })

describe('合并与判定', () => {
  it('有会话在跑不空闲；停下之后没满时间不空闲，满了才空闲', () => {
    expect(isIdle(viewOf([entry('p1', NOW, { [A]: { isRunning: true, lastActiveAt: NOW - 2 * IDLE } })]), wsA, IDLE, NOW)).toBe(false)
    expect(isIdle(viewOf([entry('p1', NOW, { [A]: { isRunning: false, lastActiveAt: NOW - IDLE + 1 } })]), wsA, IDLE, NOW)).toBe(false)
    expect(isIdle(viewOf([entry('p1', NOW, { [A]: { isRunning: false, lastActiveAt: NOW - IDLE } })]), wsA, IDLE, NOW)).toBe(true)
    expect(isIdle(viewOf([]), wsA, IDLE, NOW)).toBe(true)
  })

  it('项目只看自己的工作目录；全局要所有工作目录都空闲；工作目录还没解析出来的对谁都算在跑', () => {
    const busyB = viewOf([entry('p1', NOW, { [B]: { isRunning: true, lastActiveAt: NOW } })])
    expect([isIdle(busyB, wsA, IDLE, NOW), isIdle(busyB, wsB, IDLE, NOW), isIdle(busyB, GLOBAL, IDLE, NOW)]).toEqual([true, false, false])
    const unknown = viewOf([entry('p1', NOW, { [UNKNOWN_WORKSPACE_KEY]: { isRunning: true, lastActiveAt: NOW } })])
    expect([isIdle(unknown, wsA, IDLE, NOW), isIdle(unknown, GLOBAL, IDLE, NOW)]).toEqual([false, false])
  })

  it('两个进程：一个在跑就算在跑，时间取最大', () => {
    const merged = mergeActivity([
      entry('p1', NOW, { [A]: { isRunning: false, lastActiveAt: NOW - 10 * MIN } }),
      entry('p2', NOW, { [A]: { isRunning: true, lastActiveAt: NOW - 40 * MIN, lastStartedAt: NOW - 40 * MIN } }),
    ], NOW)
    expect(merged.get(A)).toEqual({ isRunning: true, lastActiveAt: NOW - 10 * MIN, lastStartedAt: NOW - 40 * MIN })
  })

  it('标着在跑却久没刷新的条目：那个进程当作没了，它在跑的按停了算，最后活动时间取它最后一次刷新', () => {
    const gone = entry('p2', NOW - ACTIVITY_STALE_MS - 1, { [A]: { isRunning: true, lastActiveAt: NOW - 120 * MIN } })
    expect(mergeActivity([gone], NOW).get(A)).toEqual({ isRunning: false, lastActiveAt: NOW - ACTIVITY_STALE_MS - 1 })
    // 跑了两小时的会话所在的进程刚没：不能凭两小时前的开始时间就算空闲满了
    expect(isIdle(viewOf([gone]), wsA, IDLE, NOW)).toBe(false)
    const fresh = entry('p2', NOW - ACTIVITY_STALE_MS, { [A]: { isRunning: true, lastActiveAt: NOW - 120 * MIN } })
    expect(mergeActivity([fresh], NOW).get(A)!.isRunning).toBe(true)
  })

  it('读不全：不算空闲，让路时按有会话在跑', () => {
    expect(isIdle(viewOf([], false), wsA, IDLE, NOW)).toBe(false)
    expect(isAnyRunning(viewOf([], false), wsA)).toBe(true)
  })

  it('让路只看有没有在跑；给了起点就只算那之后才开始跑的', () => {
    const view = viewOf([entry('p1', NOW, {
      [A]: { isRunning: true, lastActiveAt: NOW - 5 * MIN, lastStartedAt: NOW - 5 * MIN },
      [B]: { isRunning: false, lastActiveAt: NOW - 1 },
    })])
    expect([isAnyRunning(view, wsA), isAnyRunning(view, wsB), isAnyRunning(view, GLOBAL)]).toEqual([true, false, true])
    expect(isAnyRunning(view, wsA, NOW - 10 * MIN)).toBe(true)
    expect(isAnyRunning(view, wsA, NOW - 5 * MIN)).toBe(false)
  })
})

function harness(listed: Array<{ agent: object; status: string }> | 'no-service' = []) {
  const clock = { now: NOW }
  const table = new InMemoryKvTable<ActivityEntry>()
  const listeners = new Set<(agent: object, status: string) => void>()
  const ticks: Array<() => void> = []
  const keys = new Map<object, string | Promise<string>>()
  // 宿主的 agent 列表：跟着发出的状态走；service.isUp 为假时列不出
  const live = new Map<object, string>(listed === 'no-service' ? [] : listed.map(a => [a.agent, a.status]))
  const service = { isUp: listed !== 'no-service' }
  const source: AgentActivitySource = {
    onStatus: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
    list: () => (service.isUp ? [...live].map(([agent, status]) => ({ agent, status })) : undefined),
    workspaceKeyOf: async agent => keys.get(agent) ?? A,
  }
  const board = new ActivityBoard({
    table, processId: 'me', source, now: () => clock.now, log: { info() {}, warn() {}, error() {} },
    interval: (callback) => { ticks.push(callback); return () => { ticks.splice(ticks.indexOf(callback), 1) } },
  })
  const emit = async (agent: object, status: string) => {
    live.set(agent, status)
    for (const listener of listeners) listener(agent, status)
    await new Promise(resolve => setImmediate(resolve))
    await board.whenWritten()
  }
  return { clock, table, board, emit, ticks, keys, listeners, live, service }
}

describe('本进程的记录', () => {
  it('会话开始跑：记成在跑并写进表；停下：记下时刻；期间别的进程读得到', async () => {
    const h = harness()
    await h.board.start()
    const agent = {}
    await h.emit(agent, 'running')
    expect((await h.table.get('me'))!.workspaces[A]).toEqual({ isRunning: true, lastActiveAt: NOW, lastStartedAt: NOW })
    expect(isIdle(await h.board.view(), wsA, IDLE, h.clock.now)).toBe(false)
    h.clock.now += 5 * MIN
    await h.emit(agent, 'idle')
    expect((await h.table.get('me'))!.workspaces[A]).toEqual({ isRunning: false, lastActiveAt: NOW + 5 * MIN, lastStartedAt: NOW })
    h.clock.now += IDLE
    expect(isIdle(await h.board.view(), wsA, IDLE, h.clock.now)).toBe(true)
  })

  it('同一个工作目录两个会话：都停了才算不在跑，这时才通知', async () => {
    const h = harness()
    await h.board.start()
    let quiet = 0
    h.board.onQuiet(() => quiet++)
    const [x, y] = [{}, {}]
    await h.emit(x, 'running')
    await h.emit(y, 'running')
    await h.emit(x, 'idle')
    expect([(await h.table.get('me'))!.workspaces[A]!.isRunning, quiet]).toEqual([true, 0])
    await h.emit(y, 'idle')
    expect([(await h.table.get('me'))!.workspaces[A]!.isRunning, quiet]).toEqual([false, 1])
  })

  it('工作目录解析出来之前：记在未知下，对别的项目也算有会话在跑', async () => {
    const h = harness()
    await h.board.start()
    const agent = {}
    let resolve!: (key: string) => void
    h.keys.set(agent, new Promise<string>((r) => { resolve = r }))
    await h.emit(agent, 'running')
    expect(isIdle(await h.board.view(), wsB, IDLE, h.clock.now + IDLE)).toBe(false)
    resolve(A)
    await new Promise(r => setImmediate(r))
    await h.board.whenWritten()
    const view = await h.board.view()
    expect([isAnyRunning(view, wsA), isAnyRunning(view, wsB)]).toEqual([true, false])
  })

  it('启动时已有会话在跑（插件重载）：列一遍记上；宿主给不出列表时一直不能下空闲的结论', async () => {
    const agent = {}
    const h = harness([{ agent, status: 'running' }, { agent: {}, status: 'idle' }])
    await h.board.start()
    await new Promise(r => setImmediate(r))
    expect(isAnyRunning(await h.board.view(), wsA)).toBe(true)
    const none = harness('no-service')
    await none.board.start()
    expect((await none.board.view()).isComplete).toBe(false)
    // 之后宿主列得出了：下一次读就补上
    none.live.set({}, 'running')
    none.service.isUp = true
    const view = await none.board.view()
    expect(view.isComplete).toBe(true)
    expect(isAnyRunning(view, GLOBAL)).toBe(true)
  })

  it('在跑的会话没发停下的事件就不见了（被销毁）：下一次心跳和宿主的列表对一遍，按停了记', async () => {
    const h = harness()
    await h.board.start()
    const agent = {}
    await h.emit(agent, 'running')
    let quiet = 0
    h.board.onQuiet(() => { quiet++ })
    h.live.delete(agent)
    h.clock.now += ACTIVITY_HEARTBEAT_MS
    h.ticks[0]!()
    await h.board.whenWritten()
    expect((await h.table.get('me'))!.workspaces[A]).toMatchObject({ isRunning: false, lastActiveAt: NOW + ACTIVITY_HEARTBEAT_MS })
    expect(quiet).toBe(1)
    expect(h.ticks).toHaveLength(0)
  })

  it('有会话在跑期间定时刷新自己那条；都停了就不再刷新', async () => {
    const h = harness()
    await h.board.start()
    const agent = {}
    await h.emit(agent, 'running')
    expect(h.ticks).toHaveLength(1)
    h.clock.now += ACTIVITY_HEARTBEAT_MS
    h.ticks[0]!()
    await h.board.whenWritten()
    expect((await h.table.get('me'))!.at).toBe(NOW + ACTIVITY_HEARTBEAT_MS)
    await h.emit(agent, 'idle')
    expect(h.ticks).toHaveLength(0)
  })

  it('卸载：自己那条写成不在跑、留着；第一次写入时清掉很久没更新的别的条目', async () => {
    const h = harness()
    await h.table.put('old', entry('old', NOW - ACTIVITY_PRUNE_MS - 1, {}))
    await h.table.put('recent', entry('recent', NOW - ACTIVITY_PRUNE_MS, {}))
    await h.board.start()
    // 启动不碰磁盘：第一次写自己那条时才清
    expect((await h.table.list()).map(([key]) => key).sort()).toEqual(['old', 'recent'])
    await h.emit({}, 'running')
    expect((await h.table.list()).map(([key]) => key).sort()).toEqual(['me', 'recent'])
    h.clock.now += MIN
    await h.board.dispose()
    expect((await h.table.get('me'))!.workspaces[A]).toMatchObject({ isRunning: false, lastActiveAt: NOW + MIN })
    expect(h.listeners.size).toBe(0)
  })

  it('别的进程的条目在给定的时间内不重读；活动表有条目读不出时不能下空闲的结论', async () => {
    const h = harness()
    await h.board.start()
    expect(isAnyRunning(await h.board.view(), wsA)).toBe(false)
    await h.table.put('p2', entry('p2', NOW, { [A]: { isRunning: true, lastActiveAt: NOW, lastStartedAt: NOW } }))
    expect(isAnyRunning(await h.board.view(30_000), wsA)).toBe(false)
    h.clock.now += 30_000
    expect(isAnyRunning(await h.board.view(30_000), wsA)).toBe(true)
    h.table.isComplete = false
    expect((await h.board.view()).isComplete).toBe(false)
  })
})

describe('工作目录异步解析和会话启停交错', () => {
  const deferred = () => { let resolve!: (key: string) => void; const promise = new Promise<string>((r) => { resolve = r }); return { promise, resolve } }
  const flush = () => new Promise(resolve => setImmediate(resolve))

  it('同一个会话停了又跑：先回来的那次解析只算它那一次的，新的一次按自己的开始时刻记', async () => {
    const h = harness()
    await h.board.start()
    const agent = {}
    const [first, second] = [deferred(), deferred()]
    h.keys.set(agent, first.promise)
    await h.emit(agent, 'running')
    h.clock.now += 10
    await h.emit(agent, 'idle')
    const between = h.clock.now + 1
    h.clock.now += 10
    h.keys.set(agent, second.promise)
    await h.emit(agent, 'running')
    first.resolve(A)
    await flush()
    // 第二次的工作目录还没解析出来：仍记在未知下，对谁都算新开的在跑
    expect(isAnyRunning(await h.board.view(), wsA, between)).toBe(true)
    second.resolve(A)
    await flush()
    const view = await h.board.view()
    expect(view.workspaces.get(A)).toMatchObject({ isRunning: true, lastStartedAt: NOW + 20 })
    expect(isAnyRunning(view, wsA, between)).toBe(true)
  })

  it('会话在工作目录解析出来之前就停了：解析回来后把开始和停下的时刻补记到那个目录，未知那一项等都解析完才拿掉', async () => {
    const h = harness()
    await h.board.start()
    const [first, other] = [{}, {}]
    const [slow, fast] = [deferred(), deferred()]
    h.keys.set(first, slow.promise)
    h.keys.set(other, fast.promise)
    await h.emit(first, 'running')
    h.clock.now += 1
    await h.emit(first, 'idle')
    h.clock.now += 1
    await h.emit(other, 'running')
    fast.resolve(B)
    await flush()
    // A 的那次还没解析回来：未知那一项留着，A 不算空闲
    expect(isIdle(await h.board.view(), wsA, IDLE, h.clock.now)).toBe(false)
    slow.resolve(A)
    await flush()
    await h.board.whenWritten()
    const view = await h.board.view()
    expect(view.workspaces.get(A)).toEqual({ isRunning: false, lastActiveAt: NOW + 1, lastStartedAt: undefined })
    expect(isIdle(view, wsA, IDLE, h.clock.now)).toBe(false)
    expect(view.workspaces.has('?')).toBe(false)
  })
})

describe('合并时的开始时刻', () => {
  it('只取还在跑的会话的：别的进程里已经停了的会话开始得再晚，也不把一直在跑的那个算成新开的', () => {
    const view = viewOf([
      entry('old', NOW, { [A]: { isRunning: true, lastActiveAt: NOW - 60 * MIN, lastStartedAt: NOW - 60 * MIN } }),
      entry('new', NOW, { [A]: { isRunning: false, lastActiveAt: NOW - MIN, lastStartedAt: NOW - 2 * MIN } }),
    ])
    expect(view.workspaces.get(A)).toEqual({ isRunning: true, lastActiveAt: NOW - MIN, lastStartedAt: NOW - 60 * MIN })
    expect(isAnyRunning(view, wsA, NOW - 10 * MIN)).toBe(false)
  })
})
