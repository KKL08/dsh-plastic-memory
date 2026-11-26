import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RawEvent, SessionLog } from '../src/session-log.ts'
import { dialogueTokenizer, type DialogueTokenizer } from '../src/search/dialogue-tokenizer.ts'
import { DialogueRecordStore } from '../src/storage/dialogue-records.ts'
import { CATCHUP_FOCUS_BUDGET_MS, CATCHUP_QUEUE_BUDGET_MS, DialogueCatchup, RECONCILE_INTERVAL_MS } from '../src/tools/dialogue-catchup.ts'
import { catchUpFor } from '../src/tools/dialogue-search.ts'
import type { HostSessionEntry } from '../src/tools/host-session.ts'
import type { SearchContext } from '../src/tools/search.ts'

// 检索前追赶的时间上限，按操作次数断言，不看本机耗时：时钟是手动的，只有读会话日志会让它往前走
// （每个会话给一个读取耗时，模拟宿主整份读日志），切段、分词、提交都不走钟。
// 检索走生产入口 catchUpFor，用的是生产的两份时限常量。库和分词器是真的。

const PROJECT = '/proj'
/** 普通会话读一次日志的模拟耗时。 */
const READ_MS = 40

let dir: string
let opened: DialogueRecordStore[] = []
let tokenizer: DialogueTokenizer
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pm-catchup-budget-'))
  tokenizer = await dialogueTokenizer({ log: { warn() {} } })
})
afterEach(async () => {
  for (const store of opened.splice(0)) store.close()
  await rm(dir, { recursive: true, force: true })
})

const event = (seq: number, type: string, data: unknown = {}): RawEvent => ({ seq, type, time: 1_000 + seq * 10, data })
const text = (value: string) => [{ type: 'text', text: value }]
function logOf(id: string, turns: number): SessionLog {
  const events = Array.from({ length: turns }, (_, i) => [
    event(i * 4, 'turn/start'),
    event(i * 4 + 1, 'user/message', { role: 'user', content: text(`${id}的第${i}个问题`), source: { kind: 'user' } }),
    event(i * 4 + 2, 'assistant/message', { message: { role: 'assistant', content: text(`${id}的第${i}个回答`) } }),
    event(i * 4 + 3, 'turn/end'),
  ]).flat()
  return { header: { id, isSeeded: false }, inheritedEventCount: 0, events }
}

interface Session { log: SessionLog; isLive: boolean; readMs: number }

function rig() {
  const clock = { now: 100_000 }
  /** 宿主列会话的顺序就是这张表的插入顺序。 */
  const sessions = new Map<string, Session>()
  /** 每次读日志：会话 id 和开始读的时刻。 */
  const reads: Array<{ id: string; at: number }> = []
  const host = {
    async listSessions(): Promise<HostSessionEntry[]> {
      return [...sessions].map(([id, s]) => ({ id, cwd: PROJECT, isSubagent: false, isLive: s.isLive }))
    },
    async readSessionLog(id: string): Promise<SessionLog | null> {
      const s = sessions.get(id)
      if (s === undefined) return null
      reads.push({ id, at: clock.now })
      clock.now += s.readMs
      return { ...s.log, events: [...s.log.events] }
    },
  }
  const log = { info() {}, warn() {}, error() {} }
  const store = new DialogueRecordStore({ path: join(dir, 'dialogue.sqlite'), log })
  opened.push(store)
  const catchup = new DialogueCatchup({
    store, host, log,
    noReview: { isMarkedNoReview: async () => false, sessionIds: async () => new Set<string>() },
    tokenizer: async () => tokenizer,
    workspaceOf: async cwd => cwd,
    knownWorkspaces: async () => [PROJECT],
    isEnabled: () => true,
    sessionStore: '/sessions',
    now: () => clock.now,
    pause: async () => {},
  })
  const add = (id: string, opts: { isLive: boolean; readMs?: number; turns?: number }) => {
    sessions.set(id, { log: logOf(id, opts.turns ?? 3), isLive: opts.isLive, readMs: opts.readMs ?? READ_MS })
  }
  /** 给开着的会话各追加一轮新消息。 */
  const grow = () => {
    for (const [id, s] of sessions) {
      if (!s.isLive) continue
      const next = logOf(id, s.log.events.length / 4 + 1)
      s.log = { ...s.log, events: next.events }
    }
  }
  const context: SearchContext = { workspacePath: PROJECT, session: { id: 'cur', lastSeq: 0 } }
  /** 预热：建完库、对过账，之后计时的那一次不再对账（除非测试把钟拨过对账间隔）。 */
  const warmUp = async () => {
    const r = await catchup.beforeSearch({ sessionId: 'cur', cwd: PROJECT, isSubagent: false }, 1e9, 1e9)
    if (r.kind !== 'ready' || r.coverage.queued !== 0 || !r.isCaughtUp) throw new Error('夹具：预热没建完')
    reads.length = 0
  }
  return { clock, sessions, reads, catchup, add, grow, context, warmUp, store }
}

/** 二十个开着的会话加当前会话：一次检索前追赶追不完。 */
function manyLive(r: ReturnType<typeof rig>, readMs = READ_MS): void {
  r.add('cur', { isLive: true, readMs })
  for (let i = 0; i < 20; i++) r.add(`live${i}`, { isLive: true })
}

describe('检索前追赶的时间上限', () => {
  it('有后台计时器时：开着的会话追不完，超出时限的量不超过一个会话的读取耗时，到点之后不再开始读新的会话', async () => {
    const r = rig()
    manyLive(r)
    await r.warmUp()
    r.grow()
    const started = r.clock.now
    const readiness = await catchUpFor(r.context, { catchup: r.catchup, hasBackgroundTimer: () => true })
    const elapsed = r.clock.now - started
    if (readiness.kind !== 'ready') throw new Error(`预期原话可用，实际是 ${readiness.kind}`)
    // 前提：时限确实起了作用，不是一口气都追完了
    expect(readiness.isCaughtUp).toBe(false)
    expect(r.reads.length).toBeGreaterThanOrEqual(2)
    expect(r.reads.length).toBeLessThan(r.sessions.size)
    expect(r.reads[0]!.id).toBe('cur')
    expect(elapsed).toBeLessThanOrEqual(CATCHUP_FOCUS_BUDGET_MS + READ_MS)
    for (const read of r.reads) expect(read.at - started).toBeLessThan(CATCHUP_FOCUS_BUDGET_MS)
  })

  it('没有后台计时器时：追完开着的会话再推进一段待建队列，总耗时不超过两份时限各加一个会话的读取耗时', async () => {
    const r = rig()
    // 新会话排在清单前面：对账时先进队，队列那一段先读到它们
    const fresh = Array.from({ length: 10 }, (_, i) => `fresh${i}`)
    manyLive(r)
    await r.warmUp()
    const live = new Map(r.sessions)
    r.sessions.clear()
    for (const id of fresh) r.add(id, { isLive: false })
    for (const [id, s] of live) r.sessions.set(id, s)
    r.grow()
    // 过了对账间隔：这一次检索先对账（不走钟），把新会话排进队
    r.clock.now += RECONCILE_INTERVAL_MS
    const started = r.clock.now
    const readiness = await catchUpFor(r.context, { catchup: r.catchup, hasBackgroundTimer: () => false })
    const elapsed = r.clock.now - started
    if (readiness.kind !== 'ready') throw new Error(`预期原话可用，实际是 ${readiness.kind}`)
    const freshRead = r.reads.filter(x => fresh.includes(x.id))
    // 前提：队列那一段真的跑了，也被时限截住了
    expect(freshRead.length).toBeGreaterThanOrEqual(1)
    expect(freshRead.length).toBeLessThan(fresh.length)
    expect(readiness.coverage.queued).toBeGreaterThan(0)
    expect(elapsed).toBeLessThanOrEqual(CATCHUP_FOCUS_BUDGET_MS + CATCHUP_QUEUE_BUDGET_MS + 2 * READ_MS)
    for (const read of freshRead) expect(read.at - started).toBeLessThan(CATCHUP_FOCUS_BUDGET_MS + CATCHUP_QUEUE_BUDGET_MS + READ_MS)
  })

  it('当前会话的日志很大、读一次就超过时限：追完它就停，不再读别的会话，结果说没追完', async () => {
    const r = rig()
    const hugeReadMs = 2_000
    manyLive(r, hugeReadMs)
    await r.warmUp()
    r.grow()
    const started = r.clock.now
    const readiness = await catchUpFor(r.context, { catchup: r.catchup, hasBackgroundTimer: () => true })
    const elapsed = r.clock.now - started
    if (readiness.kind !== 'ready') throw new Error(`预期原话可用，实际是 ${readiness.kind}`)
    expect(r.reads.map(x => x.id)).toEqual(['cur'])
    expect(readiness.isCaughtUp).toBe(false)
    expect(elapsed).toBeLessThanOrEqual(CATCHUP_FOCUS_BUDGET_MS + hugeReadMs)
    // 当前会话这次追到了日志末尾：新的一轮已经在库里
    const state = r.store.state()
    if (state.status === 'none') throw new Error('库还没建')
    expect(r.store.session(state.read.gen, 'cur')!.watermark).toBe(r.sessions.get('cur')!.log.events.at(-1)!.seq)
  })
})
