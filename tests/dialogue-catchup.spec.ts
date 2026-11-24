import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RawEvent, SessionLog } from '../src/session-log.ts'
import { dialogueTokenizer, type DialogueTokenizer } from '../src/search/dialogue-tokenizer.ts'
import { DialogueRecordStore, type DialogueBatch } from '../src/storage/dialogue-records.ts'
import { DialogueCatchup, RECONCILE_INTERVAL_MS, type DialogueCatchupDeps, type DialogueReadiness } from '../src/tools/dialogue-catchup.ts'
import type { HostSessionEntry } from '../src/tools/host-session.ts'

// 追赶编排：真的对话记录库（临时目录里的 node:sqlite）、真的分词器，宿主会话用内存里的假清单。
// 「另一个进程」是同一个库文件上的第二个连接加第二个编排对象。时钟是手动的，交错靠批与批之间的让出点安排。

let dir: string
let opened: DialogueRecordStore[] = []
let tokenizer: DialogueTokenizer
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pm-dialogue-catchup-'))
  tokenizer = await dialogueTokenizer()
})
afterEach(async () => {
  for (const store of opened.splice(0)) store.close()
  await rm(dir, { recursive: true, force: true })
})

const storePath = () => join(dir, 'dialogue-records.sqlite')
const WEIGHTS = [4, 2, 1] as const
const APP = '/w/app'
const OTHER = '/w/other'

const event = (seq: number, type: string, data: unknown = {}): RawEvent => ({ seq, type, time: 1_000 + seq * 10, data })
const text = (value: string) => [{ type: 'text', text: value }]
const user = (seq: number, value: string) => event(seq, 'user/message', { id: `u${seq}`, role: 'user', content: text(value), source: { kind: 'user' } })
const assistant = (seq: number, value: string) =>
  event(seq, 'assistant/message', { turn: 1, step: 1, message: { id: `a${seq}`, role: 'assistant', content: text(value) }, stream: [] })
/** 一轮：起点、用户一句、助手一句、终点，占四个序号。 */
const turn = (from: number, ask: string, answer: string) => [event(from, 'turn/start'), user(from + 1, ask), assistant(from + 2, answer), event(from + 3, 'turn/end')]
/** n 轮对话，每轮的话里带轮号。 */
const turns = (n: number, tag: string) => Array.from({ length: n }, (_, i) => turn(i * 4, `${tag}问题${i}`, `${tag}回答${i}`)).flat()

interface FakeSession { entry: HostSessionEntry; events: RawEvent[]; isUnreadable?: boolean; isSeeded?: boolean }

/** 假宿主：一张会话清单。测试直接改它来模拟新消息、关会话、删会话。 */
function fakeHost() {
  const sessions = new Map<string, FakeSession>()
  let isListable = true
  return {
    sessions,
    add(id: string, events: RawEvent[], extra: Partial<HostSessionEntry> = {}) {
      sessions.set(id, { entry: { id, cwd: APP, isSubagent: false, isLive: false, ...extra }, events })
    },
    setListable(value: boolean) { isListable = value },
    async listSessions() { return isListable ? [...sessions.values()].map(s => s.entry) : null },
    async readSessionLog(id: string): Promise<SessionLog | null> {
      const s = sessions.get(id)
      if (s === undefined || s.isUnreadable) return null
      return { header: { id, isSeeded: s.isSeeded ?? false }, inheritedEventCount: s.isSeeded ? undefined : 0, events: [...s.events] }
    },
  }
}

interface Rig {
  catchup: DialogueCatchup
  store: DialogueRecordStore
  /** 每次提交的批（成功失败都记）。 */
  batches: Array<{ batch: DialogueBatch; ok: boolean }>
  warnings: string[]
}

interface World {
  host: ReturnType<typeof fakeHost>
  marked: Set<string>
  clock: { now: number }
  isEnabled: boolean
  known: string[]
  tokenizer: () => Promise<DialogueTokenizer>
}

function world(): World {
  return { host: fakeHost(), marked: new Set(), clock: { now: 100_000 }, isEnabled: true, known: [APP], tokenizer: async () => tokenizer }
}

function rig(w: World, extra: Partial<DialogueCatchupDeps> = {}, storeExtra: ConstructorParameters<typeof DialogueRecordStore>[0] | object = {}): Rig {
  const warnings: string[] = []
  const log = { info: () => {}, warn: (m: string) => { warnings.push(m) }, error: (m: string) => { warnings.push(m) } }
  const batches: Rig['batches'] = []
  class Recording extends DialogueRecordStore {
    override commitBatch(batch: DialogueBatch): boolean {
      const ok = super.commitBatch(batch)
      batches.push({ batch, ok })
      return ok
    }
  }
  const store = new Recording({ path: storePath(), log, ...storeExtra })
  opened.push(store)
  const catchup = new DialogueCatchup({
    store, host: w.host, log,
    noReview: { isMarkedNoReview: async id => w.marked.has(id), sessionIds: async () => new Set(w.marked) },
    tokenizer: () => w.tokenizer(),
    workspaceOf: async cwd => cwd,
    knownWorkspaces: async () => w.known,
    isEnabled: () => w.isEnabled,
    sessionStore: '/sessions/home',
    now: () => w.clock.now,
    pause: async () => {},
    ...extra,
  })
  return { catchup, store, batches, warnings }
}

const CURRENT = { sessionId: 'cur', cwd: APP, isSubagent: false }
const ready = (r: DialogueReadiness) => {
  if (r.kind !== 'ready') throw new Error(`预期原话可用，实际是 ${r.kind}`)
  return r
}
const find = (store: DialogueRecordStore, gen: number, query: string) =>
  store.search(gen, tokenizer.match(query)!.all, { limit: 50, weights: WEIGHTS }).map(h => `${h.sessionId}#${h.seq}:${h.text}`)
/** 一个会话在库里的全部段，拼成可比的字符串。 */
const dump = (store: DialogueRecordStore, gen: number, sessionId: string) =>
  store.segmentsOf(gen, sessionId, 0, Number.MAX_SAFE_INTEGER).map(s => `${s.turnSeq}/${s.seq}/${s.segment}/${s.speaker}/${s.text}`)

describe('建库和检索前追赶', () => {
  it('第一次检索把当前会话和范围里的旧会话都收进来，库里的文本和日志逐字一致', async () => {
    const w = world()
    w.host.add('cur', turn(0, '部署脚本放在哪个目录', '放在 scripts/deploy 下面。'), { isLive: true })
    w.host.add('old', turn(0, '上次定的数据库端口是多少', '定的是 5433，避开本机的 5432。'))
    const { catchup, store } = rig(w)
    const r = ready(await catchup.beforeSearch(CURRENT, 1_000, 1_000))
    expect(r).toMatchObject({ status: 'ready', isCaughtUp: true, coverage: { sessions: 2, queued: 0 } })
    expect(find(store, r.gen, '数据库端口')).toEqual(['old#1:上次定的数据库端口是多少'])
    expect(dump(store, r.gen, 'cur')).toEqual(['0/1/0/user/部署脚本放在哪个目录', '0/2/0/assistant/放在 scripts/deploy 下面。'])
    expect(store.turnsOf(r.gen, 'old')).toEqual([{ turnSeq: 0, at: 1_000 }])
  })

  it('原文是全角字母数字，半角查询也搜得到', async () => {
    const w = world()
    w.host.add('cur', turn(0, '版本号写成ＡＢＣ１２３可以吗', '可以。'), { isLive: true })
    const { catchup, store } = rig(w)
    const r = ready(await catchup.beforeSearch(CURRENT, 1_000, 0))
    expect(find(store, r.gen, 'ABC123')).toHaveLength(1)
  })

  it('范围：记忆根没见过的项目的会话不收；当前会话的项目还没有记忆时也收它自己', async () => {
    const w = world()
    w.known = []
    w.host.add('cur', turn(0, '新项目的第一句话', '好的。'), { isLive: true, cwd: OTHER })
    w.host.add('elsewhere', turn(0, '别的项目里说的话', '嗯。'), { cwd: '/w/unrelated' })
    w.host.add('sibling', turn(0, '同一个新项目的旧会话', '嗯。'), { cwd: OTHER })
    const { catchup, store } = rig(w)
    const r = ready(await catchup.beforeSearch({ sessionId: 'cur', cwd: OTHER, isSubagent: false }, 1_000, 1_000))
    expect(store.sessionIds(r.gen)).toEqual(['cur', 'sibling'])
    expect(find(store, r.gen, '别的项目')).toEqual([])
  })

  it('分不清哪些消息属于自己的会话整个不收，也不留在队里', async () => {
    const w = world()
    w.host.add('cur', turn(0, '当前会话', '好。'), { isLive: true })
    w.host.add('seeded', turn(0, '带着别处消息开的会话', '好。'))
    w.host.sessions.get('seeded')!.isSeeded = true
    const { catchup, store } = rig(w)
    const r = ready(await catchup.beforeSearch(CURRENT, 1_000, 1_000))
    expect(dump(store, r.gen, 'seeded')).toEqual([])
    expect(r.coverage.queued).toBe(0)
  })

  it('当前会话有了新消息，下一次检索前接着水位往后收，不重复', async () => {
    const w = world()
    w.host.add('cur', turn(0, '第一轮的问题', '第一轮的回答'), { isLive: true })
    const { catchup, store } = rig(w)
    await catchup.beforeSearch(CURRENT, 1_000, 0)
    w.host.sessions.get('cur')!.events.push(...turn(4, '第二轮的问题', '第二轮的回答'))
    const r = ready(await catchup.beforeSearch(CURRENT, 1_000, 0))
    expect(dump(store, r.gen, 'cur')).toHaveLength(4)
    expect(store.session(r.gen, 'cur')!.watermark).toBe(7)
  })
})

describe('有界批次和待建队列', () => {
  it('一个会话分几批提交，每批不超过上限；批间到点停下，下次从水位续上，结果和一次建完相同', async () => {
    const w = world()
    w.host.add('cur', turns(5, '甲'), { isLive: true })
    // 每让出一次过 10 毫秒：时限 15 毫秒只够提交两批
    const slow = rig(w, { batchMessages: 2, pause: async () => { w.clock.now += 10 } })
    const first = ready(await slow.catchup.beforeSearch(CURRENT, 15, 0))
    expect(first.isCaughtUp).toBe(false)
    for (const { batch } of slow.batches) expect(new Set(batch.segments.map(s => s.seq)).size).toBeLessThanOrEqual(2)
    const partial = dump(slow.store, first.gen, 'cur')
    expect(partial.length).toBeGreaterThan(0)
    expect(partial.length).toBeLessThan(10)
    // 水位只推到提交过的那一批
    expect(slow.store.session(first.gen, 'cur')!.watermark).toBe(Math.max(...slow.batches.filter(b => b.ok).map(b => b.batch.watermark)))
    const second = ready(await slow.catchup.beforeSearch(CURRENT, 10_000, 0))
    expect(second.isCaughtUp).toBe(true)
    const resumed = dump(slow.store, second.gen, 'cur')

    slow.catchup.destroy()
    const once = rig(w)
    const r = ready(await once.catchup.beforeSearch(CURRENT, 10_000, 0))
    expect(resumed).toEqual(dump(once.store, r.gen, 'cur'))
    expect(resumed).toHaveLength(10)
  })

  it('没有后台计时器：连续几次检索各推进一段队列，每次都报已收几个、还剩几个，最后建全', async () => {
    const w = world()
    w.host.add('cur', turn(0, '当前', '好'), { isLive: true })
    for (const id of ['a', 'b', 'c']) w.host.add(id, turns(2, id))
    // 读一份日志算 10 毫秒，队列预算 15 毫秒：一次检索最多建两个旧会话
    const { catchup } = rig(w, {
      host: { listSessions: () => w.host.listSessions(), readSessionLog: async id => { w.clock.now += 10; return w.host.readSessionLog(id) } },
    })
    const seen: Array<[number, number, string]> = []
    for (let i = 0; i < 6; i++) {
      const r = ready(await catchup.beforeSearch(CURRENT, 1_000, 15))
      seen.push([r.coverage.sessions, r.coverage.queued, r.status])
      if (r.status === 'ready') break
    }
    expect(seen.length).toBeGreaterThan(1)
    expect(seen[0]![2]).toBe('building')
    expect(seen[seen.length - 1]).toEqual([4, 0, 'ready'])
    // 已收的只增不减
    expect(seen.map(s => s[0])).toEqual([...seen.map(s => s[0])].sort((x, y) => x - y))
  })

  it('待建队列存在库里：换一个进程接着推进', async () => {
    const w = world()
    w.host.add('cur', turn(0, '当前', '好'), { isLive: true })
    w.host.add('a', turns(2, '子'))
    w.host.add('b', turns(2, '丑'))
    const first = rig(w)
    const r1 = ready(await first.catchup.beforeSearch(CURRENT, 1_000, 0))
    expect(r1).toMatchObject({ status: 'building', coverage: { queued: 2 } })
    first.catchup.stop()
    const second = rig(w)
    const r2 = ready(await second.catchup.advance(10_000))
    expect(r2).toMatchObject({ status: 'ready', coverage: { sessions: 3, queued: 0 } })
    expect(dump(second.store, r2.gen, 'b')).toHaveLength(4)
  })

  it('读不到日志的会话留在队尾，不挡后面的，不当成会话没了，也不挡着这一代建完', async () => {
    const w = world()
    w.host.add('cur', turn(0, '当前', '好'), { isLive: true })
    w.host.add('broken', turns(1, '坏'))
    w.host.add('fine', turns(1, '好'))
    w.host.sessions.get('broken')!.isUnreadable = true
    const { catchup, store } = rig(w)
    const r = ready(await catchup.beforeSearch(CURRENT, 1_000, 1_000))
    expect(dump(store, r.gen, 'fine')).toHaveLength(2)
    expect(store.queued(r.gen, 5)).toEqual(['broken'])
    expect(r).toMatchObject({ status: 'ready', coverage: { queued: 1 } })
    w.host.sessions.get('broken')!.isUnreadable = false
    expect(ready(await catchup.advance(1_000))).toMatchObject({ status: 'ready', coverage: { queued: 0 } })
    expect(dump(store, r.gen, 'broken')).toHaveLength(2)
  })

  it('规则变了重建时有一个会话读不到日志：新的一代照样建完、接手查询，读不到的留在队里', async () => {
    const w = world()
    w.host.add('cur', turn(0, '当前', '好'), { isLive: true })
    w.host.add('broken', turns(1, '坏'))
    const first = rig(w)
    const r1 = ready(await first.catchup.beforeSearch(CURRENT, 1_000, 1_000))
    w.host.sessions.get('broken')!.isUnreadable = true
    const next = rig(w, { tokenizer: async () => ({ ...tokenizer, tokenizerVersion: tokenizer.tokenizerVersion + 1 }) })
    const r2 = ready(await next.catchup.beforeSearch(CURRENT, 1_000, 1_000))
    expect(r2.gen).toBeGreaterThan(r1.gen)
    expect(r2).toMatchObject({ status: 'ready', isCaughtUp: true, coverage: { queued: 1 } })
    expect(next.store.queued(r2.gen, 5)).toEqual(['broken'])
  })

  it('有检索在等结果时后台让路：手上这一批交完就停，剩下的下次再做', async () => {
    const w = world()
    w.host.add('cur', turn(0, '当前', '好'), { isLive: true })
    w.host.add('old', turns(6, '旧'))
    let release = () => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    let isGated = false
    let search: Promise<DialogueReadiness> | undefined
    let own: Rig
    const r = own = rig(w, {
      batchMessages: 2,
      host: {
        listSessions: () => w.host.listSessions(),
        readSessionLog: async id => { if (isGated && id === 'cur') await gate; return w.host.readSessionLog(id) },
      },
      // 后台交完第一批让出时来了一次检索，它卡在读当前会话的日志上
      pause: async () => {
        if (search !== undefined) return
        isGated = true
        search = own.catchup.beforeSearch(CURRENT, 10_000, 0)
      },
    })
    await r.catchup.advance(10_000)
    expect(r.batches.filter(x => x.batch.sessionId === 'old')).toHaveLength(1)
    release()
    await search
    isGated = false
    const done = ready(await r.catchup.advance(10_000))
    expect(dump(r.store, done.gen, 'old')).toHaveLength(12)
  })

  it('上次收的时候还开着的会话，关了之后再收一次尾巴', async () => {
    const w = world()
    w.host.add('cur', turn(0, '当前', '好'), { isLive: true })
    w.host.add('peer', turn(0, '另一个窗口的第一轮', '好'), { isLive: true })
    const { catchup, store } = rig(w)
    await catchup.beforeSearch(CURRENT, 1_000, 1_000)
    const peer = w.host.sessions.get('peer')!
    peer.events.push(...turn(4, '关窗前的最后一轮', '好'))
    peer.entry = { ...peer.entry, isLive: false }
    w.clock.now += RECONCILE_INTERVAL_MS
    const r = ready(await catchup.advance(1_000))
    expect(find(store, r.gen, '最后一轮')).toEqual(['peer#5:关窗前的最后一轮'])
    expect(store.openSessionIds(r.gen)).toEqual(['cur'])
  })

  it('检索前追赶超过时限：先用已有的，报没追完和覆盖情况', async () => {
    const w = world()
    w.host.add('cur', turns(6, '长'), { isLive: true })
    const { catchup } = rig(w, { batchMessages: 1, pause: async () => { w.clock.now += 100 } })
    const r = ready(await catchup.beforeSearch(CURRENT, 150, 0))
    expect(r.isCaughtUp).toBe(false)
    expect(r.coverage.coveredUntil).toBeDefined()
  })
})

describe('对账', () => {
  it('后台不知道当前会话是哪个项目：别的进程按它的当前项目收进来的会话不删，排在队里的照收', async () => {
    const w = world()
    w.known = []
    w.host.add('cur', turn(0, '新项目的第一句话', '好的。'), { isLive: true, cwd: OTHER })
    w.host.add('sibling', turns(1, '同项目'), { cwd: OTHER })
    const front = rig(w, { batchMessages: 1 })
    // 前台只追了当前会话，同项目的旧会话还排在队里
    const r = ready(await front.catchup.beforeSearch({ sessionId: 'cur', cwd: OTHER, isSubagent: false }, 1_000, 0))
    expect(front.store.queued(r.gen, 5)).toContain('sibling')
    const back = rig(w)
    ready(await back.catchup.advance(10_000))
    expect(dump(back.store, r.gen, 'cur')).toHaveLength(2)
    expect(dump(back.store, r.gen, 'sibling')).toHaveLength(2)
    expect(back.store.queued(r.gen, 5)).toEqual([])
  })

  it('队里有一个清单旧了还不认识的会话（别的进程刚排进来的新会话）：留着，下一次先对账再收', async () => {
    const w = world()
    w.host.add('cur', turn(0, '当前', '好'), { isLive: true })
    const a = rig(w)
    const r = ready(await a.catchup.beforeSearch(CURRENT, 1_000, 1_000))
    w.host.add('fresh', turns(1, '新'))
    // 甲的清单过期了还没重对；乙对账把新会话排进队
    w.clock.now += RECONCILE_INTERVAL_MS + 1
    const b = rig(w)
    await b.catchup.beforeSearch(CURRENT, 1_000, 0)
    expect(a.store.queued(r.gen, 5)).toEqual(['fresh'])
    await a.catchup.advance(1_000)
    expect(dump(a.store, r.gen, 'fresh')).toHaveLength(2)
  })

  it('当前会话认不出属于哪个项目：不收它，如实报没追到', async () => {
    const w = world()
    w.host.add('cur', turn(0, '没有工作目录的会话', '好'), { isLive: true, cwd: undefined })
    const { catchup, store } = rig(w)
    const r = ready(await catchup.beforeSearch({ sessionId: 'cur', cwd: undefined, isSubagent: false }, 1_000, 1_000))
    expect(r.isCaughtUp).toBe(false)
    expect(store.sessionIds(r.gen)).toEqual([])
  })

  it('宿主那边删掉的会话，下次对账时行被清掉', async () => {
    const w = world()
    w.host.add('cur', turn(0, '当前', '好'), { isLive: true })
    w.host.add('gone', turn(0, '这个会话后来被删了', '好'))
    const { catchup, store } = rig(w)
    const r1 = ready(await catchup.beforeSearch(CURRENT, 1_000, 1_000))
    expect(find(store, r1.gen, '后来被删')).toHaveLength(1)
    w.host.sessions.delete('gone')
    w.clock.now += RECONCILE_INTERVAL_MS
    const r2 = ready(await catchup.beforeSearch(CURRENT, 1_000, 1_000))
    expect(find(store, r2.gen, '后来被删')).toEqual([])
    expect(store.session(r2.gen, 'gone')).toMatchObject({ isRemoved: true })
  })

  it('宿主这一次列不出会话清单：不对账，已有的行不动', async () => {
    const w = world()
    w.host.add('cur', turn(0, '当前', '好'), { isLive: true })
    w.host.add('old', turn(0, '旧会话里的话', '好'))
    const { catchup, store } = rig(w)
    await catchup.beforeSearch(CURRENT, 1_000, 1_000)
    w.host.setListable(false)
    w.clock.now += RECONCILE_INTERVAL_MS
    const r = ready(await catchup.beforeSearch(CURRENT, 1_000, 1_000))
    expect(find(store, r.gen, '旧会话')).toHaveLength(1)
  })

  it('标成不回看：行马上清掉，之后对账也不再收它', async () => {
    const w = world()
    w.host.add('cur', turn(0, '当前', '好'), { isLive: true })
    w.host.add('private', turn(0, '不想被回看的内容', '好'))
    const { catchup, store } = rig(w)
    const r1 = ready(await catchup.beforeSearch(CURRENT, 1_000, 1_000))
    expect(find(store, r1.gen, '不想被回看')).toHaveLength(1)
    w.marked.add('private')
    catchup.dropSession('private')
    expect(find(store, r1.gen, '不想被回看')).toEqual([])
    w.clock.now += RECONCILE_INTERVAL_MS
    const r2 = ready(await catchup.advance(1_000))
    expect(find(store, r2.gen, '不想被回看')).toEqual([])
    expect(r2.coverage).toMatchObject({ sessions: 1, queued: 0 })
  })

  it('别的进程标了不回看、这边还没对账：追到这个会话时现查到，清掉不收', async () => {
    const w = world()
    w.host.add('cur', turn(0, '当前', '好'), { isLive: true })
    w.host.add('private', turns(1, '私'))
    const { catchup, store } = rig(w)
    const r1 = ready(await catchup.beforeSearch(CURRENT, 1_000, 0))
    w.marked.add('private')
    const r2 = ready(await catchup.advance(1_000))
    expect(dump(store, r2.gen, 'private')).toEqual([])
    expect(r2).toMatchObject({ status: 'ready', coverage: { queued: 0 } })
    expect(r1.gen).toBe(r2.gen)
  })
})

describe('重建', () => {
  it('删库之后从会话日志重建，查询结果和删之前一致', async () => {
    const w = world()
    w.host.add('cur', turns(2, '当前'), { isLive: true })
    w.host.add('old', turns(3, '旧'))
    const { catchup, store } = rig(w)
    const r1 = ready(await catchup.beforeSearch(CURRENT, 1_000, 1_000))
    const before = [find(store, r1.gen, '问题'), dump(store, r1.gen, 'old'), store.turnsOf(r1.gen, 'old')]
    catchup.destroy()
    expect(existsSync(storePath())).toBe(false)
    const r2 = ready(await catchup.beforeSearch(CURRENT, 1_000, 1_000))
    expect([find(store, r2.gen, '问题'), dump(store, r2.gen, 'old'), store.turnsOf(r2.gen, 'old')]).toEqual(before)
  })

  it('分词器版本变了：整份重建，建完之前查询读旧的一代，建完切到新的一代', async () => {
    const w = world()
    w.host.add('cur', turn(0, '当前会话的话', '好'), { isLive: true })
    w.host.add('old', turns(2, '旧'))
    const { catchup, store } = rig(w)
    const r1 = ready(await catchup.beforeSearch(CURRENT, 1_000, 1_000))
    w.tokenizer = async () => ({ ...tokenizer, tokenizerVersion: tokenizer.tokenizerVersion + 1 })
    const during = ready(await catchup.beforeSearch(CURRENT, 1_000, 0))
    expect(during).toMatchObject({ status: 'rebuilding', gen: r1.gen, isCaughtUp: false })
    expect(find(store, during.gen, '旧问题0')).toHaveLength(1)
    const after = ready(await catchup.advance(10_000))
    expect(after.status).toBe('ready')
    expect(after.gen).not.toBe(r1.gen)
    expect(dump(store, after.gen, 'old')).toHaveLength(4)
  })

  it('只换了词典：不换代，已有段的整词列按新词典重算', async () => {
    const w = world()
    w.host.add('cur', turn(0, '我们讨论塑性记忆插件', '好'), { isLive: true })
    const { catchup, store } = rig(w)
    const r1 = ready(await catchup.beforeSearch(CURRENT, 1_000, 1_000))
    const state1 = store.state()
    // 新词典把每段的整词列都换成一个记号
    w.tokenizer = async () => ({ ...tokenizer, dictionaryVersion: 'dict-next', columns: t => ({ ...tokenizer.columns(t), w: 'zzmarker' }) })
    const r2 = ready(await catchup.advance(10_000))
    expect(r2.gen).toBe(r1.gen)
    const state2 = store.state()
    if (state1.status === 'none' || state2.status === 'none') throw new Error('库应当在')
    expect(state2.write.dictionary).toBe('dict-next')
    expect(state1.write.dictionary).not.toBe('dict-next')
    expect(store.search(r2.gen, 'w : zzmarker', { limit: 10, weights: WEIGHTS })).toHaveLength(2)
  })

  it('没有后台计时器：换了词典之后，检索自己带着把已有段的整词列重算掉', async () => {
    const w = world()
    w.host.add('cur', turn(0, '我们讨论塑性记忆插件', '好'), { isLive: true })
    const { catchup, store } = rig(w)
    await catchup.beforeSearch(CURRENT, 1_000, 1_000)
    w.tokenizer = async () => ({ ...tokenizer, dictionaryVersion: 'dict-next', columns: t => ({ ...tokenizer.columns(t), w: 'zzmarker' }) })
    const r = ready(await catchup.beforeSearch(CURRENT, 1_000, 1_000))
    expect(store.search(r.gen, 'w : zzmarker', { limit: 10, weights: WEIGHTS })).toHaveLength(2)
    const state = store.state()
    if (state.status === 'none') throw new Error('库应当在')
    expect(state.write).toMatchObject({ dictionary: 'dict-next' })
    expect(state.write.wRewriteAfter).toBeUndefined()
  })

  it('分词器降级时收的段没有整词列：词典加载得起来之后补算', async () => {
    const w = world()
    w.host.add('cur', turn(0, '我们讨论塑性记忆插件', '好'), { isLive: true })
    w.tokenizer = async () => ({ ...tokenizer, degraded: true, dictionaryVersion: undefined, columns: t => ({ ...tokenizer.columns(t), w: '' }) })
    const { catchup, store } = rig(w)
    const r1 = ready(await catchup.beforeSearch(CURRENT, 1_000, 1_000))
    expect(store.search(r1.gen, tokenizer.match('塑性记忆')!.all, { limit: 10, weights: WEIGHTS })).not.toEqual([])
    w.tokenizer = async () => ({ ...tokenizer, columns: t => ({ ...tokenizer.columns(t), w: 'zzmarker' }) })
    const r2 = ready(await catchup.advance(10_000))
    expect(r2.gen).toBe(r1.gen)
    expect(store.search(r2.gen, 'w : zzmarker', { limit: 10, weights: WEIGHTS })).toHaveLength(2)
  })
})

describe('并发交错', () => {
  /** 在第 n 次让出时先做一件事。 */
  const pauseHook = (at: number, act: () => Promise<void> | void) => {
    let count = 0
    return async () => { if (++count === at) await act() }
  }

  it('两个连接同时追同一个会话：不丢不重，水位不回退', async () => {
    const w = world()
    w.host.add('cur', turns(4, '并'), { isLive: true })
    const b = rig(w, { batchMessages: 2 })
    // 甲提交完第一批后让出，乙趁机把整个会话追完；甲回来时自己的下一批作废
    const a = rig(w, { batchMessages: 2, pause: pauseHook(1, async () => { await b.catchup.beforeSearch(CURRENT, 10_000, 0) }) })
    const r = ready(await a.catchup.beforeSearch(CURRENT, 10_000, 0))
    expect(a.batches.some(x => !x.ok)).toBe(true)
    const rows = dump(a.store, r.gen, 'cur')
    expect(rows).toHaveLength(8)
    expect(new Set(rows).size).toBe(8)
    expect(rows[0]).toBe('0/1/0/user/并问题0')
    expect(rows[7]).toBe('12/14/0/assistant/并回答3')
    expect(a.store.session(r.gen, 'cur')!.watermark).toBe(15)
  })

  it('对账删掉会话和旧批次提交交错：删了的不会被写回', async () => {
    const w = world()
    w.host.add('cur', turn(0, '当前', '好'), { isLive: true })
    w.host.add('old', turns(4, '删'))
    const b = rig(w)
    const a = rig(w, {
      batchMessages: 2,
      // 甲追 old 追到一半让出：会话在宿主那边被删，乙对账把它移出
      pause: pauseHook(1, async () => {
        w.host.sessions.delete('old')
        await b.catchup.advance(10_000)
      }),
    })
    await a.catchup.beforeSearch(CURRENT, 10_000, 0)
    const r = ready(await a.catchup.advance(10_000))
    expect(a.batches.filter(x => x.batch.sessionId === 'old').map(x => x.ok)).toEqual([true, false])
    expect(dump(a.store, r.gen, 'old')).toEqual([])
  })

  it('重建切代时旧连接在途的批次被丢弃', async () => {
    const w = world()
    w.host.add('cur', turns(4, '代'), { isLive: true })
    const b = rig(w, { tokenizer: async () => ({ ...tokenizer, tokenizerVersion: tokenizer.tokenizerVersion + 1 }) })
    const a = rig(w, { batchMessages: 2, pause: pauseHook(1, async () => { await b.catchup.beforeSearch(CURRENT, 10_000, 10_000) }) })
    await a.catchup.beforeSearch(CURRENT, 10_000, 0)
    expect(a.batches.map(x => x.ok)).toEqual([true, false])
    const state = b.store.state()
    if (state.status === 'none') throw new Error('库应当在')
    // 第一次还没建完规则就变了：旧的半代直接换掉，新的一代是乙按新规则完整建的
    expect(state.read.versions.tokenizer).toBe(tokenizer.tokenizerVersion + 1)
    expect(dump(b.store, state.read.gen, 'cur')).toHaveLength(8)
  })

  it('读日志期间标成不回看：读回来的旧日志不会被写进库', async () => {
    const w = world()
    w.host.add('cur', turn(0, '当前', '好'), { isLive: true })
    w.host.add('private', turns(2, '私'))
    let own: Rig
    const a = own = rig(w, {
      host: {
        listSessions: () => w.host.listSessions(),
        readSessionLog: async id => {
          const log = await w.host.readSessionLog(id)
          if (id === 'private' && !w.marked.has(id)) {
            w.marked.add(id)
            own.catchup.dropSession(id)
          }
          return log
        },
      },
    })
    const r = ready(await a.catchup.beforeSearch(CURRENT, 10_000, 10_000))
    expect(a.batches.filter(x => x.batch.sessionId === 'private').map(x => x.ok)).toEqual([false])
    expect(dump(a.store, r.gen, 'private')).toEqual([])
    expect(a.store.session(r.gen, 'private')).toMatchObject({ isRemoved: true })
  })

  it('建完之后规则变了，另一个进程重建并切过去：旧进程在途的批次不要', async () => {
    const w = world()
    w.host.add('cur', turns(1, '代'), { isLive: true })
    const a = rig(w, { batchMessages: 2 })
    const r1 = ready(await a.catchup.beforeSearch(CURRENT, 10_000, 10_000))
    expect(r1.status).toBe('ready')
    w.host.sessions.get('cur')!.events.push(...turn(4, '第二轮', '好'), ...turn(8, '第三轮', '好'))
    const b = rig(w, { tokenizer: async () => ({ ...tokenizer, tokenizerVersion: tokenizer.tokenizerVersion + 1 }) })
    const late = rig(w, { batchMessages: 2, pause: pauseHook(1, async () => { await b.catchup.beforeSearch(CURRENT, 10_000, 10_000) }) })
    await late.catchup.beforeSearch(CURRENT, 10_000, 0)
    expect(late.batches.map(x => x.ok)).toEqual([true, false])
    const state = b.store.state()
    if (state.status === 'none') throw new Error('库应当在')
    expect(state).toMatchObject({ status: 'ready', read: { versions: { tokenizer: tokenizer.tokenizerVersion + 1 } } })
    expect(dump(b.store, state.read.gen, 'cur')).toHaveLength(6)
  })

  it('一个进程换了词典：另一个进程手里按旧词典算的批不要', async () => {
    const w = world()
    w.host.add('cur', turns(4, '词'), { isLive: true })
    const b = rig(w, { tokenizer: async () => ({ ...tokenizer, dictionaryVersion: 'dict-next' }) })
    const a = rig(w, { batchMessages: 2, pause: pauseHook(1, async () => { await b.catchup.advance(10_000) }) })
    await a.catchup.beforeSearch(CURRENT, 10_000, 0)
    expect(a.batches.map(x => x.ok)).toEqual([true, false])
    const state = b.store.state()
    if (state.status === 'none') throw new Error('库应当在')
    expect(state.write.dictionary).toBe('dict-next')
    expect(state.write.wRewriteAfter).toBeUndefined()
  })

  it('追到一半标成不回看：在途的批次作废，行清掉', async () => {
    const w = world()
    w.host.add('cur', turn(0, '当前', '好'), { isLive: true })
    w.host.add('private', turns(4, '私'))
    let rigA: Rig
    const a = rigA = rig(w, {
      batchMessages: 2,
      pause: pauseHook(1, () => {
        w.marked.add('private')
        rigA.catchup.dropSession('private')
      }),
    })
    await a.catchup.beforeSearch(CURRENT, 10_000, 0)
    const r = ready(await a.catchup.advance(10_000))
    expect(a.batches.filter(x => x.batch.sessionId === 'private').map(x => x.ok)).toEqual([true, false])
    expect(dump(a.store, r.gen, 'private')).toEqual([])
  })
})

describe('关闭、删除和故障', () => {
  it('功能关着：不建库，不读会话日志', async () => {
    const w = world()
    w.isEnabled = false
    let reads = 0
    w.host.add('cur', turn(0, '当前', '好'), { isLive: true })
    const { catchup } = rig(w, { host: { listSessions: () => w.host.listSessions(), readSessionLog: async id => { reads++; return w.host.readSessionLog(id) } } })
    expect(await catchup.beforeSearch(CURRENT, 1_000, 1_000)).toEqual({ kind: 'off' })
    expect(await catchup.advance(1_000)).toEqual({ kind: 'off' })
    expect(existsSync(storePath())).toBe(false)
    expect(reads).toBe(0)
  })

  it('建库途中关掉功能：之后不再写入', async () => {
    const w = world()
    w.host.add('cur', turns(4, '关'), { isLive: true })
    const { catchup, store, batches } = rig(w, { batchMessages: 2, pause: async () => { w.isEnabled = false } })
    expect(await catchup.beforeSearch(CURRENT, 10_000, 0)).toEqual({ kind: 'off' })
    expect(batches).toHaveLength(1)
    w.isEnabled = true
    const state = store.state()
    if (state.status === 'none') throw new Error('库应当在')
    expect(dump(store, state.write.gen, 'cur')).toHaveLength(2)
  })

  it('建库途中删库：在途的追赶停下，库不会被建回来', async () => {
    const w = world()
    w.host.add('cur', turns(4, '删'), { isLive: true })
    let own: Rig
    const r = own = rig(w, { batchMessages: 2, pause: async () => { own.catchup.destroy() } })
    expect(await r.catchup.beforeSearch(CURRENT, 10_000, 0)).toEqual({ kind: 'off' })
    expect(r.batches).toHaveLength(1)
    expect(existsSync(storePath())).toBe(false)
  })

  it('重算整词列途中删库：在途的重算停下，库不会被建回来', async () => {
    const w = world()
    w.host.add('cur', turn(0, '我们讨论塑性记忆插件', '好'), { isLive: true })
    let isRewriting = false
    let own: Rig
    const r = own = rig(w, { pause: async () => { if (isRewriting) own.catchup.destroy() } })
    await r.catchup.beforeSearch(CURRENT, 1_000, 1_000)
    w.tokenizer = async () => ({ ...tokenizer, dictionaryVersion: 'dict-next' })
    isRewriting = true
    expect(await r.catchup.advance(10_000)).toEqual({ kind: 'off' })
    expect(existsSync(storePath())).toBe(false)
  })

  it('加载分词器期间关掉功能：回来之后不打开、不新建库', async () => {
    const w = world()
    w.host.add('cur', turn(0, '当前', '好'), { isLive: true })
    w.tokenizer = async () => { w.isEnabled = false; return tokenizer }
    const { catchup } = rig(w)
    expect(await catchup.beforeSearch(CURRENT, 1_000, 1_000)).toEqual({ kind: 'off' })
    expect(existsSync(storePath())).toBe(false)
  })

  it('库打不开：报原话暂不可用，不抛', async () => {
    const w = world()
    w.host.add('cur', turn(0, '当前', '好'), { isLive: true })
    const { catchup } = rig(w, {}, { loadSqlite: () => undefined })
    expect(await catchup.beforeSearch(CURRENT, 1_000, 1_000)).toEqual({ kind: 'unavailable', isBusy: false })
    expect(catchup.coverageOf('cur')).toBeUndefined()
  })

  it('读会话时宿主抛错：报原话暂不可用；同一个故障只记一条警告', async () => {
    const w = world()
    const { catchup, warnings } = rig(w, { host: { listSessions: async () => [], readSessionLog: async () => { throw new Error('boom') } } })
    expect(await catchup.beforeSearch(CURRENT, 1_000, 1_000)).toEqual({ kind: 'unavailable', isBusy: false })
    expect(await catchup.beforeSearch(CURRENT, 1_000, 1_000)).toEqual({ kind: 'unavailable', isBusy: false })
    expect(warnings.filter(m => m.includes('这一次只查记忆'))).toHaveLength(1)
  })

  it('「不回看」清单读不了：报原话暂不可用，一段都不收', async () => {
    const w = world()
    w.host.add('cur', turn(0, '当前', '好'), { isLive: true })
    const { catchup, batches } = rig(w, { noReview: { isMarkedNoReview: async () => { throw new Error('unreadable') }, sessionIds: async () => { throw new Error('unreadable') } } })
    expect(await catchup.beforeSearch(CURRENT, 1_000, 1_000)).toEqual({ kind: 'unavailable', isBusy: false })
    expect(batches).toEqual([])
  })
})

describe('给按会话读原文的入口：会话收到了哪', () => {
  it('收过的会话给出读的那一代和水位；没收过、被移出的没有', async () => {
    const w = world()
    w.host.add('cur', turn(0, '当前', '好'), { isLive: true })
    const { catchup } = rig(w)
    expect(catchup.coverageOf('cur')).toBeUndefined()
    const r = ready(await catchup.beforeSearch(CURRENT, 1_000, 0))
    expect(catchup.coverageOf('cur')).toEqual({ gen: r.gen, watermark: 3, isRebuilding: false })
    expect(catchup.coverageOf('nobody')).toBeUndefined()
    catchup.dropSession('cur')
    expect(catchup.coverageOf('cur')).toBeUndefined()
  })
})
