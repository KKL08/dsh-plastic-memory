import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RawEvent, SessionLog } from '../src/session-log.ts'
import { dialogueTokenizer, type DialogueTokenizer } from '../src/search/dialogue-tokenizer.ts'
import { DialogueRecordStore } from '../src/storage/dialogue-records.ts'
import { CATCHUP_FOCUS_BUDGET_MS, DialogueCatchup } from '../src/tools/dialogue-catchup.ts'
import { catchUpFor } from '../src/tools/dialogue-search.ts'
import type { HostSessionEntry } from '../src/tools/host-session.ts'
import type { SearchContext } from '../src/tools/search.ts'

// 检索前追赶轮到每个开着的会话：时钟是手动的，只有读会话日志会让它往前走（每个会话一个读取耗时），
// 按读日志的次数和顺序断言。检索走生产入口 catchUpFor 和生产的时限常量，库和分词器是真的。

const PROJECT = '/proj'
/** 读一次日志的模拟耗时：时限 300 ms 里能开始读 8 个会话（0、40……280 时开始）。 */
const READ_MS = 40
/** 一次检索前追赶能开始追的会话数（含当前会话）。 */
const K = Math.ceil(CATCHUP_FOCUS_BUDGET_MS / READ_MS)

let dir: string
let opened: DialogueRecordStore[] = []
let tokenizer: DialogueTokenizer
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pm-catchup-fair-'))
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
  const add = (id: string, opts: { isLive: boolean; readMs?: number }) => {
    sessions.set(id, { log: logOf(id, 3), isLive: opts.isLive, readMs: opts.readMs ?? READ_MS })
  }
  /** 给开着的会话各追加一轮新消息。 */
  const grow = () => {
    for (const [id, s] of sessions) {
      if (s.isLive) s.log = { ...s.log, events: logOf(id, s.log.events.length / 4 + 1).events }
    }
  }
  const context: SearchContext = { workspacePath: PROJECT, session: { id: 'cur', lastSeq: 0 } }
  /** 预热：建完库、对过账，之后几次检索都在对账间隔内，不再对账。 */
  const warmUp = async () => {
    const r = await catchup.beforeSearch({ sessionId: 'cur', cwd: PROJECT, isSubagent: false }, 1e9, 1e9)
    if (r.kind !== 'ready' || r.coverage.queued !== 0 || !r.isCaughtUp) throw new Error('夹具：预热没建完')
    reads.length = 0
  }
  return { clock, sessions, reads, catchup, add, grow, context, warmUp, store }
}

describe('检索前追赶轮到每个开着的会话', () => {
  it('开着的会话多于一次能追的数目：连续 ⌈(n−1)/(k−1)⌉ 次检索后每个都读过，每次先读当前会话，时限照旧', async () => {
    const r = rig()
    r.add('cur', { isLive: true })
    for (let i = 0; i < 20; i++) r.add(`live${i}`, { isLive: true })
    await r.warmUp()
    const n = r.sessions.size
    const rounds = Math.ceil((n - 1) / (K - 1))
    // 前提：一次追不完，至少要轮两次
    expect(rounds).toBeGreaterThanOrEqual(2)
    const seen = new Set<string>()
    for (let i = 0; i < rounds; i++) {
      r.grow()
      r.reads.length = 0
      const started = r.clock.now
      const readiness = await catchUpFor(r.context, { catchup: r.catchup, hasBackgroundTimer: () => true })
      if (readiness.kind !== 'ready') throw new Error(`预期原话可用，实际是 ${readiness.kind}`)
      expect(r.reads[0]!.id).toBe('cur')
      expect(r.reads.length).toBe(K)
      expect(r.clock.now - started).toBeLessThanOrEqual(CATCHUP_FOCUS_BUDGET_MS + READ_MS)
      for (const read of r.reads) {
        expect(read.at - started).toBeLessThan(CATCHUP_FOCUS_BUDGET_MS)
        seen.add(read.id)
      }
    }
    expect([...r.sessions.keys()].filter(id => !seen.has(id))).toEqual([])
  })
})
