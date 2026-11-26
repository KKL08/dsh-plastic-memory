import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import * as sqlite from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionLog, RawEvent } from '../src/session-log.ts'
import { dialogueTokenizer, type DialogueTokenizer } from '../src/search/dialogue-tokenizer.ts'
import {
  DialogueRecordStore, DialogueStoreUnavailable,
  type DialogueBatch, type DialogueSegmentInput, type DialogueVersions,
} from '../src/storage/dialogue-records.ts'
import type { SqliteModule } from '../src/storage/root-lock.ts'
import { DialogueCatchup, RECONCILE_INTERVAL_MS } from '../src/tools/dialogue-catchup.ts'
import type { HostSessionEntry } from '../src/tools/host-session.ts'

// 「库这一次用不了」的告警：同一种原因连续出现只告警一次，库再写进去一次（恢复）之后再出现，再告警一次。
// 盘满、只读在加载 node:sqlite 这道进程边界上注入：换成打开后就把库封顶在当前大小的连接（PRAGMA max_page_count），
// 或只读打开的连接。换盘之后关一次连接，下一个操作按新的盘重新打开。时钟用固定值，不 sleep。

let dir: string
let opened: DialogueRecordStore[] = []
let tokenizer: DialogueTokenizer
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pm-dialogue-warning-'))
  tokenizer = await dialogueTokenizer({ log: { warn() {} } })
})
afterEach(async () => {
  for (const store of opened.splice(0)) store.close()
  await rm(dir, { recursive: true, force: true })
})

const V1: DialogueVersions = { segmentRule: 1, tokenizer: 1, intake: 1 }
const HOME = '/sessions/home'
const storePath = () => join(dir, 'dialogue-records.sqlite')

/** 打开后就封顶在当前大小：之后要长大的写入都报盘满。 */
const fullDisk: SqliteModule = {
  DatabaseSync: class extends sqlite.DatabaseSync {
    constructor(path: string) {
      super(path)
      this.exec('PRAGMA max_page_count = 1')
    }
  },
} as unknown as SqliteModule
/** 只读打开：写入都报只读。 */
const readOnlyDisk: SqliteModule = {
  DatabaseSync: class extends sqlite.DatabaseSync {
    constructor(path: string) {
      super(path, { readOnly: true })
    }
  },
} as unknown as SqliteModule
const normalDisk: SqliteModule = { DatabaseSync: sqlite.DatabaseSync }

type Disk = 'ok' | 'full' | 'readonly'

/** 一个盘可以换的库：换盘后关连接，下一个操作按新盘打开。 */
function rig() {
  const warnings: string[] = []
  const log = { info() {}, warn: (m: string) => { warnings.push(m) }, error: (m: string) => { warnings.push(m) } }
  let disk: Disk = 'ok'
  const store = new DialogueRecordStore({
    path: storePath(), log,
    loadSqlite: () => disk === 'full' ? fullDisk : disk === 'readonly' ? readOnlyDisk : normalDisk,
  })
  opened.push(store)
  const use = (next: Disk) => { disk = next; store.close() }
  return { store, warnings, log, use }
}

const isDiskFull = (m: string) => /disk is full/i.test(m)
const isReadOnly = (m: string) => /readonly/i.test(m)

/** 一大段：每一批都要给库加页。 */
const big = (seq: number): DialogueSegmentInput => {
  const text = `deploy ${seq} ${'记下的排查过程很长'.repeat(200)}`
  return { turnSeq: seq, seq, segment: 0, at: 1000 + seq, speaker: 'user', text, w: text, b: text, c: '' }
}

/** 准备好库、开始收 s1，返回提交下一批的函数：成功才推进水位。 */
function begin(store: DialogueRecordStore) {
  const state = store.prepare(V1, 'dict-1', HOME)
  if (state.status === 'none') throw new Error('夹具：准备之后应当有库')
  const gen = state.write.gen
  const started = store.startSession(gen, 's1', { cwd: '/w/app', isSubagent: false })!
  let watermark = started.watermark
  const next = (): DialogueBatch => {
    const segments = Array.from({ length: 10 }, (_, i) => big(watermark + 1 + i))
    return { gen, sessionId: 's1', revision: started.revision, dictionary: 'dict-1', fromWatermark: watermark, watermark: watermark + 10, segments, turns: segments.map(s => ({ turnSeq: s.turnSeq })) }
  }
  const commit = () => {
    const batch = next()
    const ok = store.commitBatch(batch)
    if (ok) watermark = batch.watermark
    return ok
  }
  return { gen, commit }
}

/** 断言这一步抛的是「这一次用不了」、不是「忙」，返回错误信息。 */
function unavailable(fn: () => unknown): string {
  let caught: unknown
  try { fn() } catch (err) { caught = err }
  expect(caught).toBeInstanceOf(DialogueStoreUnavailable)
  expect((caught as DialogueStoreUnavailable).isBusy).toBe(false)
  return (caught as Error).message
}

describe('库这一层的告警去重', () => {
  it('盘满连续出现只告警一次，其间读得出来不算恢复；再写进去一次之后又盘满，再告警一次', () => {
    const { store, warnings, use } = rig()
    const { gen, commit } = begin(store)
    expect(commit()).toBe(true)

    use('full')
    for (let i = 0; i < 3; i++) {
      // 前提：每一次都确实撞上盘满，其间的读照常成功
      expect(unavailable(commit)).toMatch(/full/i)
      expect(store.state()).toMatchObject({ status: 'building' })
      expect(store.search(gen, 'deploy', { limit: 5, weights: [4, 2, 1] })).toHaveLength(5)
    }
    expect(warnings.filter(isDiskFull)).toHaveLength(1)

    use('ok')
    expect(commit()).toBe(true)
    expect(warnings.filter(isDiskFull)).toHaveLength(1)

    use('full')
    expect(unavailable(commit)).toMatch(/full/i)
    expect(warnings.filter(isDiskFull)).toHaveLength(2)
    expect(unavailable(commit)).toMatch(/full/i)
    expect(warnings.filter(isDiskFull)).toHaveLength(2)
    expect(warnings).toHaveLength(2)
  })

  it('库被占着照旧不告警，也不算恢复：盘满、被占、盘满只告警一次', () => {
    const { store, warnings, use } = rig()
    const { commit } = begin(store)
    expect(commit()).toBe(true)

    use('full')
    expect(unavailable(commit)).toMatch(/full/i)
    const other = new DatabaseSync(storePath())
    other.exec('BEGIN EXCLUSIVE')
    use('ok')
    let caught: unknown
    try { commit() } catch (err) { caught = err }
    other.exec('ROLLBACK')
    other.close()
    expect(caught).toBeInstanceOf(DialogueStoreUnavailable)
    expect((caught as DialogueStoreUnavailable).isBusy).toBe(true)

    use('full')
    expect(unavailable(commit)).toMatch(/full/i)
    expect(warnings.filter(isDiskFull)).toHaveLength(1)
    expect(warnings).toHaveLength(1)
  })

  it('换了一种原因算新的一次：盘满两次、只读两次、再盘满两次，告警依次是盘满、只读、盘满', () => {
    const { store, warnings, use } = rig()
    const { commit } = begin(store)
    expect(commit()).toBe(true)

    for (const disk of ['full', 'readonly', 'full'] as const) {
      use(disk)
      for (let i = 0; i < 2; i++) expect(unavailable(commit)).toMatch(disk === 'full' ? /full/i : /readonly/i)
    }
    expect(warnings).toHaveLength(3)
    expect([isDiskFull(warnings[0]!), isReadOnly(warnings[1]!), isDiskFull(warnings[2]!)]).toEqual([true, true, true])
  })
})

// —— 后台推进：接上追赶编排，同一个库每隔几秒推进一次 ——

const PROJECT = '/proj'
const event = (seq: number, type: string, data: unknown = {}): RawEvent => ({ seq, type, time: 1_000 + seq * 10, data })
const text = (value: string) => [{ type: 'text', text: value }]
/** n 轮对话；每句带一大段填充，让每一批都要给库加页。 */
function logOf(id: string, n: number): SessionLog {
  const filler = '记下的排查过程很长'.repeat(60)
  const events = Array.from({ length: n }, (_, i) => [
    event(i * 4, 'turn/start'),
    event(i * 4 + 1, 'user/message', { role: 'user', content: text(`${id}第${i}轮：部署脚本放哪。${filler}`), source: { kind: 'user' } }),
    event(i * 4 + 2, 'assistant/message', { message: { role: 'assistant', content: text(`${id}第${i}轮回答：部署脚本在 scripts 下。${filler}`) } }),
    event(i * 4 + 3, 'turn/end'),
  ]).flat()
  return { header: { id, isSeeded: false }, inheritedEventCount: 0, events }
}

it('后台连续推进时盘满：只告警一次；腾出空间收进去之后又盘满，再告警一次', async () => {
  const { store, warnings, log, use } = rig()
  // 假时钟：每加一批会话就拨过一个对账间隔，让下一次推进去对账、把它们排进队
  let clock = 1_000
  const logs = new Map<string, SessionLog>([['cur', logOf('cur', 3)], ['old', logOf('old', 3)]])
  const entries = (): HostSessionEntry[] => [...logs.keys()].map(id => ({ id, cwd: PROJECT, isSubagent: false, isLive: false }))
  const catchup = new DialogueCatchup({
    store, host: { readSessionLog: async id => logs.get(id) ?? null, listSessions: async () => entries() },
    noReview: { isMarkedNoReview: async () => false, sessionIds: async () => new Set<string>() },
    workspaceOf: async cwd => cwd, tokenizer: async () => tokenizer, knownWorkspaces: async () => [PROJECT],
    isEnabled: () => true, sessionStore: '/sessions', log, now: () => clock,
  })
  const settle = async () => {
    for (let i = 0; i < 10; i++) {
      const r = await catchup.advance(60_000)
      if (r.kind === 'ready' && r.coverage.queued === 0) return
    }
    throw new Error('夹具：十次推进还没建完')
  }
  await settle()

  for (const id of ['new1', 'new2', 'new3']) logs.set(id, logOf(id, 4))
  clock += RECONCILE_INTERVAL_MS
  use('full')
  for (let i = 0; i < 4; i++) expect(await catchup.advance(60_000)).toEqual({ kind: 'unavailable', isBusy: false })
  expect(warnings.filter(isDiskFull)).toHaveLength(1)

  use('ok')
  await settle()
  expect(warnings.filter(isDiskFull)).toHaveLength(1)

  for (const id of ['new4', 'new5']) logs.set(id, logOf(id, 4))
  clock += RECONCILE_INTERVAL_MS
  use('full')
  for (let i = 0; i < 3; i++) expect(await catchup.advance(60_000)).toEqual({ kind: 'unavailable', isBusy: false })
  expect(warnings.filter(isDiskFull)).toHaveLength(2)
  expect(warnings).toHaveLength(2)
})
