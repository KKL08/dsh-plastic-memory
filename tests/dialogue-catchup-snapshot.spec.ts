import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as sqlite from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RawEvent, SessionLog } from '../src/session-log.ts'
import { dialogueTokenizer, type DialogueTokenizer } from '../src/search/dialogue-tokenizer.ts'
import { DialogueRecordStore, type DialogueBatch } from '../src/storage/dialogue-records.ts'
import type { SqliteModule } from '../src/storage/root-lock.ts'
import { DialogueCatchup, RECONCILE_INTERVAL_MS, type DialogueCatchupDeps, type DialogueReadiness } from '../src/tools/dialogue-catchup.ts'
import type { HostSessionEntry } from '../src/tools/host-session.ts'

// 后台推进分多次建一个大会话：读日志的次数不随推进次数涨，结果和每次都整份重读相同。
// 库、分词器是真的；宿主是内存里的假清单。时钟是手动的：读一次日志走 READ_MS，批与批之间让出一次走 PAUSE_MS，
// 按读日志的次数和库里的段断言。「另一个进程」是同一个库文件上的第二个连接加第二个编排对象。
// 盘满在加载 node:sqlite 这道进程边界上注入。

let dir: string
let opened: DialogueRecordStore[] = []
let tokenizer: DialogueTokenizer
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pm-catchup-snapshot-'))
  tokenizer = await dialogueTokenizer({ log: { warn() {} } })
})
afterEach(async () => {
  for (const store of opened.splice(0)) store.close()
  await rm(dir, { recursive: true, force: true })
})

const APP = '/w/app'
const READ_MS = 20
const PAUSE_MS = 40
/** 后台每次推进的时限：读一次再交四批，或不读交四批。 */
const BUDGET_MS = 150
const BATCH = 4

const event = (seq: number, type: string, data: unknown = {}): RawEvent => ({ seq, type, time: 1_000 + seq * 10, data })
const text = (value: string) => [{ type: 'text', text: value }]
/** 一轮：起点、用户一句、助手一句、终点，占四个序号。 */
const turn = (from: number, ask: string, answer: string) => [
  event(from, 'turn/start'),
  event(from + 1, 'user/message', { role: 'user', content: text(ask), source: { kind: 'user' } }),
  event(from + 2, 'assistant/message', { message: { role: 'assistant', content: text(answer) } }),
  event(from + 3, 'turn/end'),
]
/** 第 from 轮起的 n 轮，话里带标记和轮号；filler 接在回答后面，把每一批撑大。 */
const turns = (from: number, n: number, tag: string, filler = '') =>
  Array.from({ length: n }, (_, i) => turn((from + i) * 4, `${tag}问题${from + i}`, `${tag}回答${from + i}${filler}`)).flat()

const fullDisk: SqliteModule = {
  DatabaseSync: class extends sqlite.DatabaseSync {
    constructor(path: string) {
      super(path)
      this.exec('PRAGMA max_page_count = 1')
    }
  },
} as unknown as SqliteModule

/** 宿主和时钟：几个编排对象共用。测试直接改会话的事件来模拟追加、截断、改写。 */
function world() {
  const sessions = new Map<string, { events: RawEvent[]; isLive: boolean }>()
  const clock = { now: 100_000 }
  /** 每次读日志：谁读的、读哪个会话。 */
  const reads: Array<{ by: string; id: string }> = []
  /** 标了不回看的会话。 */
  const marked = new Set<string>()
  return { sessions, clock, reads, marked }
}
type World = ReturnType<typeof world>

function rig(w: World, name: string, extra: Partial<DialogueCatchupDeps> = {}, path = join(dir, 'dialogue.sqlite')) {
  const log = { info() {}, warn() {}, error() {} }
  const commits: Array<{ batch: DialogueBatch; ok: boolean }> = []
  const disk = { isFull: false }
  class Recording extends DialogueRecordStore {
    override commitBatch(batch: DialogueBatch): boolean {
      const ok = super.commitBatch(batch)
      commits.push({ batch, ok })
      return ok
    }
  }
  const store = new Recording({ path, log, loadSqlite: () => disk.isFull ? fullDisk : { DatabaseSync: sqlite.DatabaseSync } as unknown as SqliteModule })
  opened.push(store)
  const host = {
    async listSessions(): Promise<HostSessionEntry[]> {
      return [...w.sessions].map(([id, s]) => ({ id, cwd: APP, isSubagent: false, isLive: s.isLive }))
    },
    async readSessionLog(id: string): Promise<SessionLog | null> {
      const s = w.sessions.get(id)
      if (s === undefined) return null
      w.reads.push({ by: name, id })
      w.clock.now += READ_MS
      return { header: { id, isSeeded: false }, inheritedEventCount: 0, events: [...s.events] }
    },
  }
  const catchup = new DialogueCatchup({
    store, host, log,
    noReview: { isMarkedNoReview: async id => w.marked.has(id), sessionIds: async () => new Set(w.marked) },
    tokenizer: async () => tokenizer,
    workspaceOf: async cwd => cwd,
    knownWorkspaces: async () => [APP],
    isEnabled: () => true,
    sessionStore: '/sessions',
    now: () => w.clock.now,
    pause: async () => { w.clock.now += PAUSE_MS },
    batchMessages: BATCH,
    ...extra,
  })
  const readsBy = () => w.reads.filter(r => r.by === name).length
  const setDiskFull = (isFull: boolean) => { disk.isFull = isFull; store.close() }
  return { catchup, store, commits, readsBy, setDiskFull }
}
type Rig = ReturnType<typeof rig>

const isBuilt = (r: DialogueReadiness) => r.kind === 'ready' && r.status === 'ready' && r.coverage.queued === 0
/** 后台一次次推进到建完，返回推进了几次。 */
async function build(r: Rig, limit = 100): Promise<number> {
  for (let i = 1; i <= limit; i++) if (isBuilt(await r.catchup.advance(BUDGET_MS))) return i
  throw new Error(`夹具：${limit} 次推进还没建完`)
}
const genOf = (store: DialogueRecordStore) => {
  const state = store.state()
  if (state.status === 'none') throw new Error('库还没建')
  return state.write.gen
}
/** 一个会话在库里的全部段和轮次边界，拼成可比的字符串。 */
const dump = (store: DialogueRecordStore, id: string) => {
  const gen = genOf(store)
  return {
    segments: store.segmentsOf(gen, id, 0, Number.MAX_SAFE_INTEGER).map(s => `${s.turnSeq}/${s.seq}/${s.segment}/${s.speaker}/${s.text}`),
    turns: store.turnsOf(gen, id),
    watermark: store.session(gen, id)!.watermark,
  }
}
/** 对给定的事件整份重建一次（单独的库、一次推进建完），作为对照。 */
async function rebuilt(events: RawEvent[]): Promise<ReturnType<typeof dump>> {
  const w = world()
  w.sessions.set('big', { events, isLive: false })
  const r = rig(w, 'ref', { batchMessages: 1_000_000 }, join(dir, `ref-${opened.length}.sqlite`))
  await r.catchup.advance(1e9)
  await r.catchup.advance(1e9)
  return dump(r.store, 'big')
}

describe('后台推进分多次建大会话', () => {
  it('关着的大会话分多次推进建完：读日志不超过两次，与推进次数无关；库和整份重建逐段一致', async () => {
    const w = world()
    w.sessions.set('big', { events: turns(0, 40, '甲'), isLive: false })
    const r = rig(w, 'p1')
    const advances = await build(r)
    // 前提：确实分了很多次才建完
    expect(advances).toBeGreaterThanOrEqual(5)
    expect(r.readsBy()).toBeLessThanOrEqual(2)
    expect(dump(r.store, 'big')).toEqual(await rebuilt(w.sessions.get('big')!.events))
  })
})

/** 后台推进一次（第一次：整份读、交四批，留下没交完的批）。返回推进后的水位。 */
async function firstAdvance(r: Rig): Promise<number> {
  await r.catchup.advance(BUDGET_MS)
  const watermark = dump(r.store, 'big').watermark
  if (watermark < 0) throw new Error('夹具：第一次推进一批都没交')
  return watermark
}
/** 段的序号，从 dump 的字符串里取。 */
const seqOf = (segment: string) => Number(segment.split('/')[1])

describe('日志在两次推进之间变了', () => {
  it('被追加：推进到建完、再推进一次没有提交，库和对最终日志整份重建逐段一致', async () => {
    const w = world()
    w.sessions.set('big', { events: turns(0, 40, '甲'), isLive: false })
    const r = rig(w, 'p1')
    await firstAdvance(r)
    w.sessions.get('big')!.events.push(...turns(40, 10, '乙'))
    await build(r)
    const committed = r.commits.length
    await r.catchup.advance(BUDGET_MS)
    expect(r.commits.length).toBe(committed)
    expect(dump(r.store, 'big')).toEqual(await rebuilt(w.sessions.get('big')!.events))
  })

  it('被截断到水位以下：水位之前的行不动，快照照样交到读到的末尾，交完之后那次读判出没有新事件、出队', async () => {
    const w = world()
    const old = turns(0, 40, '甲')
    w.sessions.set('big', { events: [...old], isLive: false })
    const r = rig(w, 'p1')
    const watermark = await firstAdvance(r)
    w.sessions.get('big')!.events = old.filter(e => e.seq! < watermark - 8)
    await build(r)
    expect(r.readsBy()).toBe(2)
    // 按规则：读到的末尾之前都是旧日志的内容
    expect(dump(r.store, 'big')).toEqual(await rebuilt(old))
  })

  it('被整份替换：快照交完之前按旧日志收到旧末尾，交完之后那次读起按新日志收', async () => {
    const w = world()
    const old = turns(0, 40, '甲')
    const replaced = turns(0, 50, '乙')
    w.sessions.set('big', { events: [...old], isLive: false })
    const r = rig(w, 'p1')
    await firstAdvance(r)
    w.sessions.get('big')!.events = [...replaced]
    await build(r)
    const end = old.at(-1)!.seq!
    const before = await rebuilt(old)
    const after = await rebuilt(replaced)
    expect(dump(r.store, 'big')).toEqual({
      segments: [...before.segments.filter(s => seqOf(s) <= end), ...after.segments.filter(s => seqOf(s) > end)],
      turns: [...before.turns.filter(t => t.turnSeq <= end), ...after.turns.filter(t => t.turnSeq > end)],
      watermark: replaced.at(-1)!.seq,
    })
    // 前提：两段确实来自不同的日志
    expect(dump(r.store, 'big').segments.some(s => s.includes('甲'))).toBe(true)
    expect(dump(r.store, 'big').segments.some(s => s.includes('乙'))).toBe(true)
  })
})

describe('快照和别的写入交错', () => {
  it('两次推进之间别的进程推进了水位：对不上，丢掉快照整份重读一次，旧批一批都不提交，库内容正确', async () => {
    const w = world()
    w.sessions.set('big', { events: turns(0, 40, '甲'), isLive: false })
    const p1 = rig(w, 'p1')
    const watermark = await firstAdvance(p1)
    const p2 = rig(w, 'p2')
    // 另一个进程读一次、交一批
    await p2.catchup.advance(1)
    expect(dump(p1.store, 'big').watermark).toBeGreaterThan(watermark)
    const reads = p1.readsBy()
    const commits = p1.commits.length
    await p1.catchup.advance(BUDGET_MS)
    expect(p1.readsBy() - reads).toBe(1)
    expect(p1.commits.slice(commits).every(c => c.ok)).toBe(true)
    expect(p1.commits.length).toBeGreaterThan(commits)
    await build(p1)
    expect(dump(p1.store, 'big')).toEqual(await rebuilt(w.sessions.get('big')!.events))
  })

  it('用快照提交时别的进程抢先提交了一批：这一批被拒、丢掉快照，下一次推进整份重读，最后库内容正确', async () => {
    const w = world()
    w.sessions.set('big', { events: turns(0, 40, '甲'), isLive: false })
    let interleave: (() => Promise<void>) | undefined
    const p1 = rig(w, 'p1', { pause: async () => { w.clock.now += PAUSE_MS; const run = interleave; interleave = undefined; await run?.() } })
    const p2 = rig(w, 'p2')
    await firstAdvance(p1)
    // p1 用快照交第一批之后让出时，p2 读一次、交一批
    interleave = async () => { await p2.catchup.advance(1) }
    const reads = p1.readsBy()
    await p1.catchup.advance(BUDGET_MS)
    expect(p1.readsBy()).toBe(reads)
    expect(p1.commits.filter(c => !c.ok)).toHaveLength(1)
    await p1.catchup.advance(BUDGET_MS)
    expect(p1.readsBy() - reads).toBe(1)
    await build(p1)
    expect(dump(p1.store, 'big')).toEqual(await rebuilt(w.sessions.get('big')!.events))
  })

  it('用快照提交时盘满：这一次用不了，水位不动，丢掉快照；腾出空间后整份重读一次，最后库内容正确', async () => {
    const w = world()
    w.sessions.set('big', { events: turns(0, 40, '甲', '记下的排查过程很长'.repeat(200)), isLive: false })
    const p1 = rig(w, 'p1')
    const watermark = await firstAdvance(p1)
    const reads = p1.readsBy()
    p1.setDiskFull(true)
    expect(await p1.catchup.advance(BUDGET_MS)).toEqual({ kind: 'unavailable', isBusy: false })
    // 用的是快照：没有读日志
    expect(p1.readsBy()).toBe(reads)
    p1.setDiskFull(false)
    expect(dump(p1.store, 'big').watermark).toBe(watermark)
    await p1.catchup.advance(BUDGET_MS)
    expect(p1.readsBy() - reads).toBe(1)
    await build(p1)
    expect(dump(p1.store, 'big')).toEqual(await rebuilt(w.sessions.get('big')!.events))
  })

  it('同一进程里两次推进并发：只有一次拿到快照，另一次整份读；最后库内容正确', async () => {
    const w = world()
    w.sessions.set('big', { events: turns(0, 40, '甲'), isLive: false })
    const p1 = rig(w, 'p1')
    await firstAdvance(p1)
    const reads = p1.readsBy()
    await Promise.all([p1.catchup.advance(BUDGET_MS), p1.catchup.advance(BUDGET_MS)])
    expect(p1.readsBy() - reads).toBe(1)
    await build(p1)
    expect(dump(p1.store, 'big')).toEqual(await rebuilt(w.sessions.get('big')!.events))
  })

  it('停用之后旧快照不再用：下一次推进整份读', async () => {
    const w = world()
    w.sessions.set('big', { events: turns(0, 40, '甲'), isLive: false })
    const p1 = rig(w, 'p1')
    await firstAdvance(p1)
    const reads = p1.readsBy()
    p1.catchup.stop()
    await p1.catchup.advance(BUDGET_MS)
    expect(p1.readsBy() - reads).toBe(1)
    await build(p1)
    expect(dump(p1.store, 'big')).toEqual(await rebuilt(w.sessions.get('big')!.events))
  })

  it('删库之后旧快照不再用：从头整份读，重建结果正确', async () => {
    const w = world()
    w.sessions.set('big', { events: turns(0, 40, '甲'), isLive: false })
    const p1 = rig(w, 'p1')
    await firstAdvance(p1)
    const reads = p1.readsBy()
    p1.catchup.destroy()
    await p1.catchup.advance(BUDGET_MS)
    expect(p1.readsBy() - reads).toBe(1)
    await build(p1)
    expect(dump(p1.store, 'big')).toEqual(await rebuilt(w.sessions.get('big')!.events))
  })

  it('会话被移出又收回、水位碰巧和快照的下一批相同：修订号对不上，旧快照被拒，整份重读', async () => {
    const w = world()
    w.sessions.set('big', { events: turns(0, 40, '甲'), isLive: false })
    const p1 = rig(w, 'p1')
    const watermark = await firstAdvance(p1)
    // 另一个进程把它移出，再按同样的批和时限收回来，停在同一个水位
    const p2 = rig(w, 'p2')
    p2.catchup.dropSession('big')
    await p2.catchup.advance(BUDGET_MS)
    expect(dump(p1.store, 'big').watermark).toBe(watermark)
    const reads = p1.readsBy()
    const rejected = p1.commits.filter(c => !c.ok).length
    await p1.catchup.advance(BUDGET_MS)
    expect(p1.readsBy() - reads).toBe(1)
    expect(p1.commits.filter(c => !c.ok).length).toBe(rejected)
  })

  it('快照的每一批提交前都看时限，第一批也看：一进来就到点时一批不交、不读日志，快照留给下一次', async () => {
    const w = world()
    w.sessions.set('big', { events: turns(0, 40, '甲'), isLive: false })
    let isSlow = false
    const p1 = rig(w, 'p1', {
      noReview: { isMarkedNoReview: async () => { if (isSlow) w.clock.now += BUDGET_MS; return false }, sessionIds: async () => new Set<string>() },
    })
    await firstAdvance(p1)
    const reads = p1.readsBy()
    const commits = p1.commits.length
    isSlow = true
    await p1.catchup.advance(BUDGET_MS)
    expect(p1.commits.length).toBe(commits)
    expect(p1.readsBy()).toBe(reads)
    isSlow = false
    await p1.catchup.advance(BUDGET_MS)
    expect(p1.commits.length).toBeGreaterThan(commits)
    expect(p1.readsBy()).toBe(reads)
  })

  it('读到的末尾在最后一条消息之后还有轮边界和别的事件：最后一批照常提交到末尾，交完之后那次读出队', async () => {
    const w = world()
    const events = turns(0, 30, '甲')
    const tail = events.at(-1)!.seq! + 1
    events.push(event(tail, 'turn/start'), event(tail + 1, 'tool/result', { output: '无关' }), event(tail + 2, 'turn/end'), event(tail + 3, 'turn/start'), event(tail + 4, 'turn/end'))
    w.sessions.set('big', { events, isLive: false })
    const p1 = rig(w, 'p1')
    const advances = await build(p1)
    expect(advances).toBeGreaterThanOrEqual(3)
    expect(p1.readsBy()).toBe(2)
    expect(dump(p1.store, 'big').watermark).toBe(tail + 4)
    expect(dump(p1.store, 'big')).toEqual(await rebuilt(events))
  })
})

/**
 * 编排对象自己的字段里（不含注入的依赖）还有没有含 marker 的字符串：看会话原文是不是还由实例的字段持有。
 * 按字段一路往下找（对象、数组、Map、Set），不依赖字段叫什么。查不到闭包捕获的值和类型化数组里编码的文本，
 * 所以只说明字段不再持有，不等于这段内存已经释放。
 */
function holdsText(catchup: DialogueCatchup, marker: string): boolean {
  const seen = new Set<unknown>()
  const visit = (value: unknown): boolean => {
    if (typeof value === 'string') return value.includes(marker)
    if (typeof value !== 'object' || value === null || seen.has(value)) return false
    seen.add(value)
    const children = value instanceof Map ? [...value.keys(), ...value.values()] : value instanceof Set ? [...value] : Object.values(value)
    return children.some(visit)
  }
  return Object.entries(catchup).some(([key, value]) => key !== 'deps' && visit(value))
}

describe('留在内存里的批什么时候清掉', () => {
  it('标成不回看（dropSession）之后，编排对象里不再有这个会话的原文', async () => {
    const w = world()
    w.sessions.set('big', { events: turns(0, 40, '甲'), isLive: false })
    const p1 = rig(w, 'p1')
    await firstAdvance(p1)
    // 前提：没交完的批确实留着，查得到原文
    expect(holdsText(p1.catchup, '甲问题')).toBe(true)
    w.marked.add('big')
    p1.catchup.dropSession('big')
    expect(holdsText(p1.catchup, '甲问题')).toBe(false)
  })

  it('整份读之后交批，让出期间被标成不回看、又到了点：没交完的批不留下', async () => {
    const w = world()
    w.sessions.set('big', { events: turns(0, 40, '甲'), isLive: false })
    let interleave: (() => Promise<void>) | undefined
    const p1 = rig(w, 'p1', { pause: async () => { w.clock.now += PAUSE_MS; const run = interleave; interleave = undefined; await run?.() } })
    interleave = async () => { w.marked.add('big'); p1.catchup.dropSession('big'); w.clock.now += BUDGET_MS }
    await p1.catchup.advance(BUDGET_MS)
    // 前提：确实是交了一批之后在让出时被标的
    expect(p1.commits.filter(c => c.ok)).toHaveLength(1)
    expect(holdsText(p1.catchup, '甲问题')).toBe(false)
  })

  it('接着交上次留下的批，让出期间被标成不回看、又到了点：取走的批不放回', async () => {
    const w = world()
    w.sessions.set('big', { events: turns(0, 40, '甲'), isLive: false })
    let interleave: (() => Promise<void>) | undefined
    const p1 = rig(w, 'p1', { pause: async () => { w.clock.now += PAUSE_MS; const run = interleave; interleave = undefined; await run?.() } })
    await firstAdvance(p1)
    const commits = p1.commits.length
    interleave = async () => { w.marked.add('big'); p1.catchup.dropSession('big'); w.clock.now += BUDGET_MS }
    await p1.catchup.advance(BUDGET_MS)
    expect(p1.commits.slice(commits).filter(c => c.ok)).toHaveLength(1)
    expect(holdsText(p1.catchup, '甲问题')).toBe(false)
  })

  it('别的进程把会话标成不回看：本进程下一次对账移出它时，留下的批一起清掉', async () => {
    const w = world()
    w.sessions.set('big', { events: turns(0, 40, '甲'), isLive: false })
    const p1 = rig(w, 'p1')
    await firstAdvance(p1)
    expect(holdsText(p1.catchup, '甲问题')).toBe(true)
    w.marked.add('big')
    w.clock.now += RECONCILE_INTERVAL_MS
    await p1.catchup.advance(BUDGET_MS)
    expect(holdsText(p1.catchup, '甲问题')).toBe(false)
  })

  it('交批让出期间，检索前追赶对账时把它移出了（别处标了不回看）：取走的批不放回', async () => {
    const w = world()
    w.sessions.set('big', { events: turns(0, 40, '甲'), isLive: false })
    let interleave: (() => Promise<void>) | undefined
    const p1 = rig(w, 'p1', { pause: async () => { w.clock.now += PAUSE_MS; const run = interleave; interleave = undefined; await run?.() } })
    await firstAdvance(p1)
    interleave = async () => {
      w.marked.add('big')
      w.clock.now += RECONCILE_INTERVAL_MS
      await p1.catchup.beforeSearch({ sessionId: 'cur', cwd: APP, isSubagent: false }, 1_000, 0)
    }
    await p1.catchup.advance(BUDGET_MS)
    const state = p1.store.state()
    if (state.status === 'none') throw new Error('库还没建')
    // 前提：检索前那次对账确实把它移出了
    expect(p1.store.session(state.write.gen, 'big')?.isRemoved).toBe(true)
    expect(holdsText(p1.catchup, '甲问题')).toBe(false)
  })

  it('别的进程把会话建完、出了队：本进程下一次对账时清掉留下的批', async () => {
    const w = world()
    w.sessions.set('big', { events: turns(0, 40, '甲'), isLive: false })
    const p1 = rig(w, 'p1')
    await firstAdvance(p1)
    const p2 = rig(w, 'p2')
    await build(p2)
    expect(holdsText(p1.catchup, '甲问题')).toBe(true)
    w.clock.now += RECONCILE_INTERVAL_MS
    await p1.catchup.advance(BUDGET_MS)
    expect(holdsText(p1.catchup, '甲问题')).toBe(false)
  })

  it('整份读没交完时，槽里已有另一次调用刚存下的批：不覆盖，下一次推进接着用那份、不读日志', async () => {
    const w = world()
    w.sessions.set('big', { events: turns(0, 40, '甲'), isLive: false })
    let interleave: (() => Promise<void>) | undefined
    const p1 = rig(w, 'p1', { pause: async () => { w.clock.now += PAUSE_MS; const run = interleave; interleave = undefined; await run?.() } })
    // 第一次推进交完一批让出时，同一进程里另一次推进整份读、交几批、存下没交完的批；回来时已经到点
    interleave = async () => { await p1.catchup.advance(BUDGET_MS) }
    await p1.catchup.advance(BUDGET_MS)
    expect(p1.readsBy()).toBe(2)
    const commits = p1.commits.length
    await p1.catchup.advance(BUDGET_MS)
    expect(p1.readsBy()).toBe(2)
    expect(p1.commits.slice(commits).filter(c => c.ok).length).toBeGreaterThan(0)
    await build(p1)
    expect(dump(p1.store, 'big')).toEqual(await rebuilt(w.sessions.get('big')!.events))
  })
})

describe('留着的批只在会话仍在这一代的待建队列里时放进槽', () => {
  const CURRENT = { sessionId: 'cur', cwd: APP, isSubagent: false }
  const withInterleave = (w: World) => {
    const slot: { run: (() => Promise<void>) | undefined } = { run: undefined }
    const pause = async () => { w.clock.now += PAUSE_MS; const run = slot.run; slot.run = undefined; await run?.() }
    return { slot, pause }
  }

  it('推进时逐个会话查到它标了不回看：移出它的同时清掉留下的批', async () => {
    const w = world()
    w.sessions.set('big', { events: turns(0, 40, '甲'), isLive: false })
    const p1 = rig(w, 'p1')
    await firstAdvance(p1)
    expect(holdsText(p1.catchup, '甲问题')).toBe(true)
    // 还在对账间隔里：这次推进不对账，是逐个会话查标记时发现的
    w.marked.add('big')
    await p1.catchup.advance(BUDGET_MS)
    expect(p1.store.session(genOf(p1.store), 'big')?.isRemoved).toBe(true)
    expect(holdsText(p1.catchup, '甲问题')).toBe(false)
  })

  it('检索前追赶只对账、不推进队列时，对账移出了别处标成不回看的会话：留下的批当场清掉', async () => {
    const w = world()
    w.sessions.set('big', { events: turns(0, 40, '甲'), isLive: false })
    const p1 = rig(w, 'p1')
    await firstAdvance(p1)
    expect(holdsText(p1.catchup, '甲问题')).toBe(true)
    w.marked.add('big')
    w.clock.now += RECONCILE_INTERVAL_MS
    // 有后台计时器时检索不推进队列：只有对账碰到它
    await p1.catchup.beforeSearch(CURRENT, 0, 0)
    expect(p1.store.session(genOf(p1.store), 'big')?.isRemoved).toBe(true)
    expect(holdsText(p1.catchup, '甲问题')).toBe(false)
  })

  it.each([
    ['整份读之后交批', false],
    ['接着交上次留下的批', true],
  ])('%s，让出期间别的进程标了不回看并移出了它，本进程随后对账：在途的批不放回', async (_, isReuse) => {
    const w = world()
    w.sessions.set('big', { events: turns(0, 40, '甲'), isLive: false })
    const { slot, pause } = withInterleave(w)
    const p1 = rig(w, 'p1', { pause })
    const p2 = rig(w, 'p2')
    if (isReuse) await firstAdvance(p1)
    slot.run = async () => {
      w.marked.add('big')
      p2.catchup.dropSession('big')
      w.clock.now += RECONCILE_INTERVAL_MS
      await p1.catchup.beforeSearch(CURRENT, 0, 0)
    }
    await p1.catchup.advance(BUDGET_MS)
    // 前提：本进程对账时库里已经没有它，看不出是这次移出的
    expect(p1.store.session(genOf(p1.store), 'big')?.isRemoved).toBe(true)
    expect(holdsText(p1.catchup, '甲问题')).toBe(false)
  })

  it('第一次建库没建完时换了规则、宿主那边也删了这个会话：旧一代的批不放回', async () => {
    const w = world()
    w.sessions.set('big', { events: turns(0, 40, '甲'), isLive: false })
    let version = tokenizer.tokenizerVersion
    const { slot, pause } = withInterleave(w)
    const p1 = rig(w, 'p1', { pause, tokenizer: async () => ({ ...tokenizer, tokenizerVersion: version }) })
    await firstAdvance(p1)
    const oldGen = genOf(p1.store)
    slot.run = async () => {
      w.sessions.delete('big')
      version += 1
      await p1.catchup.beforeSearch(CURRENT, 0, 0)
      w.clock.now += BUDGET_MS
    }
    await p1.catchup.advance(BUDGET_MS)
    // 前提：旧的一代整个换掉了
    expect(genOf(p1.store)).toBeGreaterThan(oldGen)
    expect(p1.store.session(oldGen, 'big')).toBeUndefined()
    expect(holdsText(p1.catchup, '甲问题')).toBe(false)
  })

  it.each([
    ['别的进程', true],
    ['本进程的检索前追赶', false],
  ])('留着批的会话被%s建完出了队，后台接着推下一个大会话：换成留它的批，它读日志不超过两次', async (_, isPeer) => {
    const w = world()
    w.sessions.set('big', { events: turns(0, 40, '甲'), isLive: false })
    w.sessions.set('second', { events: turns(0, 80, '乙'), isLive: false })
    const p1 = rig(w, 'p1')
    await firstAdvance(p1)
    const finisher = isPeer ? rig(w, 'p2') : p1
    await finisher.catchup.beforeSearch({ sessionId: 'big', cwd: APP, isSubagent: false }, 100_000, 0)
    // 前提：留着批的会话已经出队，下一次对账还没到
    expect(p1.store.isQueued(genOf(p1.store), 'big')).toBe(false)
    const started = w.clock.now
    const advances = await build(p1)
    expect(w.clock.now - started).toBeLessThan(RECONCILE_INTERVAL_MS)
    expect(advances).toBeGreaterThan(5)
    expect(w.reads.filter(r => r.by === 'p1' && r.id === 'second')).toHaveLength(2)
    expect(dump(p1.store, 'second')).toEqual(await (async () => {
      const ref = world()
      ref.sessions.set('second', { events: w.sessions.get('second')!.events, isLive: false })
      const r = rig(ref, 'ref', { batchMessages: 1_000_000 }, join(dir, 'ref-second.sqlite'))
      await r.catchup.advance(1e9)
      await r.catchup.advance(1e9)
      return dump(r.store, 'second')
    })())
  })

  it('换了规则重建时三个大会话依次建完：每个会话只整份读两次，排在后面的会话留下的批不因队首会话的收尾而丢', async () => {
    const w = world()
    for (const tag of ['甲', '乙', '丙']) w.sessions.set(tag, { events: turns(0, 40, tag), isLive: false })
    let version = tokenizer.tokenizerVersion
    const p1 = rig(w, 'p1', { tokenizer: async () => ({ ...tokenizer, tokenizerVersion: version }) })
    await build(p1)
    const reads = p1.readsBy()
    version += 1
    let isRebuilding = false
    let advances = 0
    for (; advances < 100; advances++) {
      // 每次推进都对账，对账不该清掉还在队里的会话留下的批
      w.clock.now += RECONCILE_INTERVAL_MS
      const r = await p1.catchup.advance(BUDGET_MS)
      if (r.kind === 'ready' && r.status === 'rebuilding') isRebuilding = true
      if (isBuilt(r)) break
    }
    // 前提：确实是分很多次推进重建完的
    expect(isRebuilding).toBe(true)
    expect(advances).toBeGreaterThan(10)
    expect(advances).toBeLessThan(100)
    expect(p1.readsBy() - reads).toBe(6)
  })

  it('同一会话两次队列推进并发、都没交完：后放回的游标更旧时不覆盖槽里更新的那份', async () => {
    const w = world()
    w.sessions.set('big', { events: turns(0, 60, '甲'), isLive: false })
    const { slot, pause } = withInterleave(w)
    const p1 = rig(w, 'p1', { pause })
    await firstAdvance(p1)
    // 第一次用留着的批交完一批让出时，同一进程里另一次推进整份读、接着交几批并留下批；回来时已经到点
    slot.run = async () => { await p1.catchup.advance(BUDGET_MS) }
    const reads = p1.readsBy()
    await p1.catchup.advance(BUDGET_MS)
    expect(p1.readsBy() - reads).toBe(1)
    const commits = p1.commits.length
    await p1.catchup.advance(BUDGET_MS)
    expect(p1.readsBy() - reads).toBe(1)
    expect(p1.commits.slice(commits).filter(c => c.ok).length).toBeGreaterThan(0)
    await build(p1)
    expect(dump(p1.store, 'big')).toEqual(await rebuilt(w.sessions.get('big')!.events))
  })
})
