import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as sqlite from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RawEvent, SessionLog } from '../src/session-log.ts'
import { dialogueTokenizer, type DialogueTokenizer } from '../src/search/dialogue-tokenizer.ts'
import { DialogueRecordStore, type DialogueBatch } from '../src/storage/dialogue-records.ts'
import type { SqliteModule } from '../src/storage/root-lock.ts'
import { CATCHUP_LOG_READ_TIMEOUT_MS, DialogueCatchup, type DialogueReadiness } from '../src/tools/dialogue-catchup.ts'
import type { HostSessionEntry } from '../src/tools/host-session.ts'

// 宿主读会话日志一直不返回时，追赶照样往下走。库、分词器是真的；宿主是内存里的假清单，
// 点名「挂住」的会话读日志时拿到一个由测试决定何时完成的 Promise。超时计时器是假的，业务时钟手动走。

let dir: string
let opened: DialogueRecordStore[] = []
let tokenizer: DialogueTokenizer
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pm-catchup-hang-'))
  tokenizer = await dialogueTokenizer({ log: { warn() {} } })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
})
afterEach(async () => {
  vi.useRealTimers()
  for (const store of opened.splice(0)) store.close()
  await rm(dir, { recursive: true, force: true })
})

const APP = '/w/app'

const event = (seq: number, type: string, data: unknown = {}): RawEvent => ({ seq, type, time: 1_000 + seq * 10, data })
const text = (value: string) => [{ type: 'text', text: value }]
const turn = (from: number, ask: string, answer: string) => [
  event(from, 'turn/start'),
  event(from + 1, 'user/message', { role: 'user', content: text(ask), source: { kind: 'user' } }),
  event(from + 2, 'assistant/message', { message: { role: 'assistant', content: text(answer) } }),
  event(from + 3, 'turn/end'),
]
const logOf = (id: string, events: RawEvent[]): SessionLog => ({ header: { id, isSeeded: false }, inheritedEventCount: 0, events })

function rig() {
  const log = { info() {}, warn: vi.fn(), error() {} }
  const commits: DialogueBatch[] = []
  class Recording extends DialogueRecordStore {
    override commitBatch(batch: DialogueBatch): boolean {
      commits.push(batch)
      return super.commitBatch(batch)
    }
  }
  const store = new Recording({ path: join(dir, 'dialogue.sqlite'), log, loadSqlite: () => ({ DatabaseSync: sqlite.DatabaseSync }) as unknown as SqliteModule })
  opened.push(store)
  const sessions = new Map<string, { events: RawEvent[]; isLive: boolean }>()
  /** 读日志会挂住的会话。 */
  const hungIds = new Set<string>()
  /** 还没结束的挂住的底层调用：测试调 resolve、reject 让它迟到地结束。 */
  type Settle<T> = { resolve(value: T): void; reject(err: Error): void }
  const pendingReads: Array<{ id: string } & Settle<SessionLog | null>> = []
  const pendingLists: Array<Settle<HostSessionEntry[] | null>> = []
  const reads: string[] = []
  const clock = { now: 100_000 }
  let isListHung = false
  let listCalls = 0
  const host = {
    listSessions(): Promise<HostSessionEntry[] | null> {
      listCalls += 1
      if (isListHung) return new Promise((resolve, reject) => { pendingLists.push({ resolve, reject }) })
      return Promise.resolve([...sessions].map(([id, s]) => ({ id, cwd: APP, isSubagent: false, isLive: s.isLive })))
    },
    readSessionLog(id: string): Promise<SessionLog | null> {
      reads.push(id)
      const s = sessions.get(id)
      if (hungIds.has(id)) return new Promise((resolve, reject) => { pendingReads.push({ id, resolve, reject }) })
      return Promise.resolve(s === undefined ? null : logOf(id, [...s.events]))
    },
  }
  const catchup = new DialogueCatchup({
    store, host, log,
    noReview: { isMarkedNoReview: async () => false, sessionIds: async () => new Set() },
    tokenizer: async () => tokenizer,
    workspaceOf: async cwd => cwd,
    knownWorkspaces: async () => [APP],
    isEnabled: () => true,
    sessionStore: '/sessions',
    now: () => clock.now,
    pause: async () => { clock.now += 1 },
  })
  const hang = (id: string) => { hungIds.add(id) }
  const unhang = (id: string) => { hungIds.delete(id) }
  const setListHung = (isHung: boolean) => { isListHung = isHung }
  const readsOf = (id: string) => reads.filter(r => r === id).length
  return { catchup, store, commits, sessions, hang, unhang, pendingReads, setListHung, pendingLists, listCalls: () => listCalls, readsOf, log }
}

const genOf = (store: DialogueRecordStore) => {
  const state = store.state()
  if (state.status === 'none') throw new Error('库还没建')
  return state.write.gen
}
const segmentsOf = (store: DialogueRecordStore, id: string) =>
  store.segmentsOf(genOf(store), id, 0, Number.MAX_SAFE_INTEGER).map(s => s.text)

/** 发起一次调用，记下它有没有结束；推进假计时器之后再看。 */
function track(call: Promise<DialogueReadiness>) {
  const seen: { result?: DialogueReadiness } = {}
  void call.then(result => { seen.result = result })
  return seen
}

describe('宿主读日志一直不返回', () => {
  it('检索前读当前会话的日志挂住：等满时限后检索结束、标没追到，后台下一拍照常推进别的会话', async () => {
    const r = rig()
    r.sessions.set('cur', { events: turn(0, '当前问', '当前答'), isLive: true })
    r.sessions.set('other', { events: turn(0, '别处问', '别处答'), isLive: false })
    r.hang('cur')
    const search = track(r.catchup.beforeSearch({ sessionId: 'cur', cwd: APP, isSubagent: false }, 300, 0))
    await vi.advanceTimersByTimeAsync(CATCHUP_LOG_READ_TIMEOUT_MS)
    expect(search.result).toMatchObject({ kind: 'ready', isCaughtUp: false })
    // 检索已经不在等结果：后台不再让路
    await r.catchup.advance(150)
    expect(segmentsOf(r.store, 'other')).toEqual(['别处问', '别处答'])
  })

  it('后台读日志挂住：等满时限后这一拍结束，会话留在队里、库里没有它；底层没读完前不再发起新读，别的会话照常建完', async () => {
    const r = rig()
    r.sessions.set('a', { events: turn(0, '甲问', '甲答'), isLive: false })
    r.sessions.set('b', { events: turn(0, '乙问', '乙答'), isLive: false })
    r.hang('a')
    const tick = track(r.catchup.advance(150))
    await vi.advanceTimersByTimeAsync(CATCHUP_LOG_READ_TIMEOUT_MS)
    expect(tick.result).toMatchObject({ kind: 'ready' })
    const gen = genOf(r.store)
    expect(r.store.isQueued(gen, 'a')).toBe(true)
    expect(segmentsOf(r.store, 'a')).toEqual([])
    expect(r.store.session(gen, 'a')?.watermark).toBe(-1)
    // 下一拍照常推进；挂着的会话不再读
    await r.catchup.advance(150)
    expect(r.readsOf('a')).toBe(1)
    expect(segmentsOf(r.store, 'b')).toEqual(['乙问', '乙答'])
    expect(r.log.warn).toHaveBeenCalledTimes(1)
  })

  it('超时之后底层才读完：迟到的日志不写库；之后的推进重新读这个会话并收进来', async () => {
    const r = rig()
    r.sessions.set('a', { events: turn(0, '甲问', '甲答'), isLive: false })
    r.hang('a')
    const tick = track(r.catchup.advance(150))
    await vi.advanceTimersByTimeAsync(CATCHUP_LOG_READ_TIMEOUT_MS)
    expect(tick.result).toMatchObject({ kind: 'ready' })
    r.unhang('a')
    r.pendingReads.shift()!.resolve(logOf('a', turn(0, '迟到问', '迟到答')))
    await vi.advanceTimersByTimeAsync(0)
    expect(r.commits.filter(c => c.sessionId === 'a')).toEqual([])
    expect(segmentsOf(r.store, 'a')).toEqual([])
    await r.catchup.advance(150)
    expect(r.readsOf('a')).toBe(2)
    expect(segmentsOf(r.store, 'a')).toEqual(['甲问', '甲答'])
  })

  it('读日志挂着时停用：等到时限后这一拍返回关闭，不写库', async () => {
    const r = rig()
    r.sessions.set('a', { events: turn(0, '甲问', '甲答'), isLive: false })
    r.hang('a')
    const tick = track(r.catchup.advance(150))
    await vi.advanceTimersByTimeAsync(0)
    r.catchup.stop()
    await vi.advanceTimersByTimeAsync(CATCHUP_LOG_READ_TIMEOUT_MS)
    expect(tick.result).toEqual({ kind: 'off' })
    expect(r.commits).toEqual([])
  })
})

describe('同一会话同时有两笔读取都超时', () => {
  const ends: Array<[string, (p: { resolve(log: SessionLog | null): void; reject(err: Error): void }) => void]> = [
    ['迟到读完', p => p.resolve(logOf('cur', turn(0, '迟到问', '迟到答')))],
    ['返回读不到', p => p.resolve(null)],
    ['读取失败', p => p.reject(new Error('读失败'))],
  ]
  it.each(ends)('先结束的一笔%s：另一笔还挂着就不再发起新读，两笔都结束后才重新读', async (_, end) => {
    const r = rig()
    r.sessions.set('cur', { events: turn(0, '当前问', '当前答'), isLive: true })
    r.hang('cur')
    const current = { sessionId: 'cur', cwd: APP, isSubagent: false }
    const first = track(r.catchup.beforeSearch(current, 300, 0))
    const second = track(r.catchup.beforeSearch(current, 300, 0))
    await vi.advanceTimersByTimeAsync(CATCHUP_LOG_READ_TIMEOUT_MS)
    expect([first.result, second.result]).toMatchObject([{ isCaughtUp: false }, { isCaughtUp: false }])
    expect(r.readsOf('cur')).toBe(2)
    end(r.pendingReads.shift()!)
    await vi.advanceTimersByTimeAsync(0)
    const third = track(r.catchup.beforeSearch(current, 300, 0))
    await vi.advanceTimersByTimeAsync(0)
    expect(third.result).toMatchObject({ isCaughtUp: false })
    expect(r.readsOf('cur')).toBe(2)
    r.unhang('cur')
    r.pendingReads.shift()!.resolve(null)
    await vi.advanceTimersByTimeAsync(0)
    expect(await r.catchup.beforeSearch(current, 300, 0)).toMatchObject({ isCaughtUp: true })
    expect(r.readsOf('cur')).toBe(3)
  })
})

describe('宿主列会话清单一直不返回', () => {
  it('等满时限后这一拍结束、这次不对账；迟到的清单不用，底层结束后重新列、照常建', async () => {
    const r = rig()
    r.sessions.set('a', { events: turn(0, '甲问', '甲答'), isLive: false })
    r.setListHung(true)
    const tick = track(r.catchup.advance(150))
    await vi.advanceTimersByTimeAsync(CATCHUP_LOG_READ_TIMEOUT_MS)
    expect(tick.result).toMatchObject({ kind: 'ready' })
    expect(r.readsOf('a')).toBe(0)
    // 迟到的清单不用：底层结束之后下一拍重新列
    r.setListHung(false)
    r.pendingLists.shift()!.resolve([])
    await vi.advanceTimersByTimeAsync(0)
    await r.catchup.advance(150)
    expect(segmentsOf(r.store, 'a')).toEqual(['甲问', '甲答'])
  })

  it('超时的清单请求没结束前不再发起新的：后台连推几拍只留一笔，前台连续检索不再每次等满时限；结束后重新列', async () => {
    const r = rig()
    r.sessions.set('a', { events: turn(0, '甲问', '甲答'), isLive: false })
    r.setListHung(true)
    const tick = track(r.catchup.advance(150))
    await vi.advanceTimersByTimeAsync(CATCHUP_LOG_READ_TIMEOUT_MS)
    expect(tick.result).toMatchObject({ kind: 'ready' })
    for (let i = 0; i < 4; i++) {
      const next = track(r.catchup.advance(150))
      await vi.advanceTimersByTimeAsync(0)
      expect(next.result).toMatchObject({ kind: 'ready' })
    }
    for (let i = 0; i < 3; i++) {
      const search = track(r.catchup.beforeSearch({ sessionId: 'cur', cwd: APP, isSubagent: false }, 300, 0))
      await vi.advanceTimersByTimeAsync(0)
      expect(search.result).toMatchObject({ kind: 'ready' })
    }
    expect(r.listCalls()).toBe(1)
    r.setListHung(false)
    r.pendingLists.shift()!.reject(new Error('列失败'))
    await vi.advanceTimersByTimeAsync(0)
    await r.catchup.advance(150)
    expect(r.listCalls()).toBe(2)
    expect(segmentsOf(r.store, 'a')).toEqual(['甲问', '甲答'])
  })
})
