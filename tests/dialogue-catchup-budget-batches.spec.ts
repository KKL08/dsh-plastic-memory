import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RawEvent, SessionLog } from '../src/session-log.ts'
import { dialogueTokenizer } from '../src/search/dialogue-tokenizer.ts'
import type { DialogueTokenizer } from '../src/search/dialogue-tokenizer.ts'
import { DialogueRecordStore } from '../src/storage/dialogue-records.ts'
import { CATCHUP_BATCH_MESSAGES, DialogueCatchup } from '../src/tools/dialogue-catchup.ts'
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
  const context: SearchContext = { workspacePath: PROJECT, session: { id: 'cur', lastSeq: 0 } }
  /** 预热：建完库、对过账，之后计时的那一次不再对账（除非测试把钟拨过对账间隔）。 */
  const warmUp = async () => {
    const r = await catchup.beforeSearch({ sessionId: 'cur', cwd: PROJECT, isSubagent: false }, 1e9, 1e9)
    if (r.kind !== 'ready' || r.coverage.queued !== 0 || !r.isCaughtUp) throw new Error('夹具：预热没建完')
    reads.length = 0
  }
  return { clock, sessions, reads, catchup, add, context, warmUp, store }
}


describe('单会话多批追赶的时间上限', () => {
  it('读日志超过时限时只提交第一批，水位停在批末且不再读其他会话', async () => {
    const r = rig()
    r.add('cur', { isLive: true, readMs: 2_000 })
    r.add('other', { isLive: true })
    await r.warmUp()
    const state = r.store.state()
    if (state.status === 'none') throw new Error('库还没建')
    const watermark = r.store.session(state.read.gen, 'cur')!.watermark
    const before = r.store.segmentsOf(state.read.gen, 'cur', 0, Number.MAX_SAFE_INTEGER).length
    // 每轮两条短消息，追加的消息数正好覆盖两批。
    r.sessions.get('cur')!.log = logOf('cur', 3 + CATCHUP_BATCH_MESSAGES)
    const readiness = await catchUpFor(r.context, { catchup: r.catchup, hasBackgroundTimer: () => true })
    if (readiness.kind !== 'ready') throw new Error('预期原话可用')
    expect(r.reads.map(x => x.id)).toEqual(['cur'])
    expect(readiness.isCaughtUp).toBe(false)
    const segments = r.store.segmentsOf(state.read.gen, 'cur', 0, Number.MAX_SAFE_INTEGER)
    expect(segments.length - before).toBe(CATCHUP_BATCH_MESSAGES)
    const expected = watermark + 2 * CATCHUP_BATCH_MESSAGES - 1
    expect(r.store.session(state.read.gen, 'cur')!.watermark).toBe(expected)
    expect(segments.at(-1)!.seq).toBe(expected)
    expect(expected).toBeLessThan(r.sessions.get('cur')!.log.events.at(-1)!.seq!)
  })
})
