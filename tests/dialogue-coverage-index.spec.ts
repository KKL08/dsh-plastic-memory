import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DialogueRecordStore, DialogueStoreUnavailable,
  type DialogueCoverage, type DialogueRecordStoreOptions, type DialogueSegmentInput, type DialogueVersions,
} from '../src/storage/dialogue-records.ts'
import { sqliteProbe } from './helpers/sqlite-probe.ts'

// 检索前追赶收尾的覆盖情况（coverage）：结果和原来的算法逐项相同；查「库里最晚一段的时刻」不扫这一代的全部段。
// 「原来的算法」是下面 coverageByScan 里的三条查询原样，在同一个库文件上另开一个连接执行，当对照。
// 「上一版留下的库」按上一版建库的语句在临时目录里现建，结构版本号同样是 1。

let dir: string
let opened: DialogueRecordStore[] = []
let raws: DatabaseSync[] = []
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'pm-dialogue-coverage-')) })
afterEach(async () => {
  for (const store of opened.splice(0)) store.close()
  for (const raw of raws.splice(0)) raw.close()
  await rm(dir, { recursive: true, force: true })
})

const V1: DialogueVersions = { segmentRule: 1, tokenizer: 1, intake: 1 }
const V2: DialogueVersions = { segmentRule: 2, tokenizer: 1, intake: 1 }
const HOME = '/sessions/home'
const quiet = { info() {}, warn() {}, error() {} }
const storePath = () => join(dir, 'dialogue-records.sqlite')

function open(extra: Partial<DialogueRecordStoreOptions> = {}) {
  const store = new DialogueRecordStore({ path: storePath(), log: quiet, ...extra })
  opened.push(store)
  return store
}

function rawOf() {
  const raw = new DatabaseSync(storePath())
  raws.push(raw)
  return raw
}

/** 对照：原来的算法，最晚时刻按这一代的全部段取最大。 */
function coverageByScan(raw: DatabaseSync, gen: number): DialogueCoverage {
  const count = (sql: string) => (raw.prepare(sql).get(gen) as { n: number }).n
  const sessions = count('SELECT COUNT(*) AS n FROM sessions s WHERE s.gen = ? AND s.is_removed = 0 AND NOT EXISTS (SELECT 1 FROM queue q WHERE q.gen = s.gen AND q.session_id = s.session_id)')
  const queued = count('SELECT COUNT(*) AS n FROM queue WHERE gen = ?')
  const until = (raw.prepare('SELECT MAX(at) AS at FROM segments WHERE gen = ?').get(gen) as { at: number | null }).at
  return { sessions, queued, coveredUntil: until ?? undefined }
}

/** 段表上的索引和各自的列（按索引里的先后）。 */
function segmentIndexes(raw: DatabaseSync): Array<{ name: string; columns: string[] }> {
  return (raw.prepare('PRAGMA index_list(segments)').all() as Array<{ name: string }>).map(({ name }) => ({
    name,
    columns: (raw.prepare(`PRAGMA index_info(${JSON.stringify(name)})`).all() as Array<{ seqno: number; name: string }>)
      .sort((a, b) => a.seqno - b.seqno).map(c => c.name),
  }))
}
const isGenAtIndex = (index: { columns: string[] }) => index.columns[0] === 'gen' && index.columns[1] === 'at'

const seg = (seq: number, at: number | undefined, text = `alpha ${seq}`): DialogueSegmentInput =>
  ({ turnSeq: 0, seq, segment: 0, ...(at !== undefined ? { at } : {}), speaker: 'user', text, w: text, b: text, c: '' })

function addSession(store: DialogueRecordStore, gen: number, sessionId: string, segments: DialogueSegmentInput[]) {
  const started = store.startSession(gen, sessionId, { cwd: '/w/app', isSubagent: false })
  if (started === undefined) throw new Error('夹具：这一代不在')
  const ok = store.commitBatch({ gen, sessionId, revision: started.revision, dictionary: 'dict-1', fromWatermark: started.watermark, watermark: segments.length, segments, turns: [{ turnSeq: 0 }] })
  if (!ok) throw new Error('夹具：提交没进去')
}

/** 上一版建库的语句：表和列与现在相同，段表上只有唯一约束带的那个索引。 */
const PREVIOUS_SCHEMA = [
  'CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)',
  'CREATE TABLE generations(gen INTEGER PRIMARY KEY, segment_rule INTEGER NOT NULL, tokenizer INTEGER NOT NULL, intake INTEGER NOT NULL, dictionary TEXT NOT NULL, is_read INTEGER NOT NULL, is_complete INTEGER NOT NULL, w_rewrite_after INTEGER)',
  'CREATE TABLE sessions(gen INTEGER NOT NULL, session_id TEXT NOT NULL, watermark INTEGER NOT NULL, revision INTEGER NOT NULL, cwd TEXT, is_subagent INTEGER NOT NULL, is_open INTEGER NOT NULL DEFAULT 0, is_removed INTEGER NOT NULL, PRIMARY KEY(gen, session_id))',
  'CREATE TABLE segments(id INTEGER PRIMARY KEY AUTOINCREMENT, gen INTEGER NOT NULL, session_id TEXT NOT NULL, turn_seq INTEGER NOT NULL, seq INTEGER NOT NULL, segment INTEGER NOT NULL, at REAL, speaker TEXT NOT NULL, text TEXT NOT NULL, UNIQUE(gen, session_id, seq, segment))',
  "CREATE VIRTUAL TABLE segments_fts USING fts5(w, b, c, tokenize = 'unicode61')",
  'CREATE TABLE turns(gen INTEGER NOT NULL, session_id TEXT NOT NULL, turn_seq INTEGER NOT NULL, at REAL, PRIMARY KEY(gen, session_id, turn_seq))',
  'CREATE TABLE queue(position INTEGER PRIMARY KEY, gen INTEGER NOT NULL, session_id TEXT NOT NULL, UNIQUE(gen, session_id))',
]

/** 上一版留下的库：建好的一代，一个会话、segmentCount 段，最晚一段在 segmentCount * 10。 */
function previousVersionStore(segmentCount: number): void {
  const raw = new DatabaseSync(storePath())
  raw.exec('PRAGMA journal_mode = TRUNCATE')
  for (const sql of PREVIOUS_SCHEMA) raw.exec(sql)
  raw.exec('PRAGMA user_version = 1')
  raw.prepare("INSERT INTO meta(key, value) VALUES ('session_store', ?), ('last_gen', '1')").run(HOME)
  raw.exec("INSERT INTO generations(gen, segment_rule, tokenizer, intake, dictionary, is_read, is_complete) VALUES (1, 1, 1, 1, 'dict-1', 1, 1)")
  raw.exec("INSERT INTO sessions(gen, session_id, watermark, revision, cwd, is_subagent, is_open, is_removed) VALUES (1, 's1', 0, 7, '/w/app', 0, 0, 0)")
  const segment = raw.prepare("INSERT INTO segments(gen, session_id, turn_seq, seq, segment, at, speaker, text) VALUES (1, 's1', 0, ?, 0, ?, 'user', ?)")
  const fts = raw.prepare('INSERT INTO segments_fts(rowid, w, b, c) VALUES (?, ?, ?, ?)')
  raw.exec('BEGIN')
  for (let i = 1; i <= segmentCount; i++) {
    const { lastInsertRowid } = segment.run(i, i * 10, `alpha ${i}`)
    fts.run(lastInsertRowid, `alpha ${i}`, `alpha ${i}`, '')
  }
  raw.exec('COMMIT')
  raw.close()
}

describe('查最晚时刻不扫整代', () => {
  it('收尾统计读段表时走按代、时刻排的索引，在这一代里定位一次就取到最晚时刻，不按代把段逐行扫一遍', () => {
    const probe = sqliteProbe()
    const store = open({ loadSqlite: () => probe.module })
    const state = store.prepare(V1, 'dict-1', HOME)
    if (state.status === 'none') throw new Error('夹具：准备之后应当有库')
    const gen = state.write.gen
    addSession(store, gen, 's1', Array.from({ length: 300 }, (_, i) => seg(i, i % 7 === 0 ? undefined : 5_000 + i)))
    const raw = rawOf()

    const { result, statements } = probe.record(() => store.coverage(gen))
    expect(result).toEqual(coverageByScan(raw, gen))
    expect(result.coveredUntil).toBe(5_000 + 299)
    const plans = statements.filter(s => [...s.reads].some(r => r.startsWith('segments.')))
      .flatMap(s => (raw.prepare(`EXPLAIN QUERY PLAN ${s.sql}`).all() as Array<{ detail: string }>).map(p => p.detail))
      .filter(detail => /\bsegments\b/.test(detail))
    // 前提：最晚时刻确实是从段表上查出来的
    expect(plans.length).toBeGreaterThan(0)
    const indexes = segmentIndexes(raw)
    for (const detail of plans) {
      const used = /^SEARCH segments USING (?:COVERING )?INDEX (\S+) \(gen=\?\)$/.exec(detail)
      expect(used, detail).not.toBeNull()
      expect(indexes.find(i => i.name === used![1])).toSatisfy(isGenAtIndex)
    }
  })
})

describe('覆盖情况和原来的算法逐项相同', () => {
  it('空的一代、只有没时刻的段、移出带最晚一段的会话、排队、重建期间新旧两代、切代删掉旧代之后，都相同', () => {
    const store = open()
    const raw = rawOf()
    const same = (gen: number) => expect(store.coverage(gen)).toEqual(coverageByScan(raw, gen))
    const state = store.prepare(V1, 'dict-1', HOME)
    if (state.status === 'none') throw new Error('夹具：准备之后应当有库')
    const gen = state.write.gen
    same(gen)
    addSession(store, gen, 'untimed', [seg(1, undefined), seg(2, undefined)])
    same(gen)
    expect(store.coverage(gen).coveredUntil).toBeUndefined()
    addSession(store, gen, 'late', [seg(1, 900), seg(2, 9_000)])
    addSession(store, gen, 'early', [seg(1, 500), seg(2, 700)])
    same(gen)
    expect(store.coverage(gen).coveredUntil).toBe(9_000)
    store.removeSession('late')
    same(gen)
    expect(store.coverage(gen).coveredUntil).toBe(700)
    store.enqueue(gen, ['early', 'other'])
    same(gen)
    store.completeBuild(gen, ['early', 'other'])

    const next = store.prepare(V2, 'dict-1', HOME)
    if (next.status !== 'rebuilding') throw new Error('夹具：规则变了应当在重建')
    const nextGen = next.write.gen
    same(gen)
    same(nextGen)
    addSession(store, nextGen, 'early', [seg(1, 500), seg(2, 12_000)])
    same(gen)
    same(nextGen)
    expect(store.coverage(nextGen).coveredUntil).toBe(12_000)
    store.dequeue(gen, 'early')
    store.dequeue(gen, 'other')
    expect(store.completeBuild(nextGen)).toBe(true)
    same(gen)
    same(nextGen)
    expect(store.coverage(gen)).toEqual({ sessions: 0, queued: 0, coveredUntil: undefined })
  })
})

describe('上一版留下的库', () => {
  it('打开时补上按代、时刻排的索引：结构版本号还是 1，原有的段一行不少，覆盖情况和检索都照旧', () => {
    previousVersionStore(200)
    const store = open()
    expect(store.state()).toMatchObject({ status: 'ready', read: { gen: 1 } })
    expect(store.coverage(1)).toEqual({ sessions: 1, queued: 0, coveredUntil: 2_000 })
    expect(store.search(1, 'alpha', { limit: 500, weights: [4, 2, 1] })).toHaveLength(200)
    const raw = rawOf()
    expect(segmentIndexes(raw).some(isGenAtIndex)).toBe(true)
    expect((raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(1)
    expect((raw.prepare('SELECT COUNT(*) AS n FROM segments').get() as { n: number }).n).toBe(200)
  })

  it('上一版的进程接着往同一个库里写段、删段：覆盖情况跟着变，和原来的算法相同', () => {
    previousVersionStore(20)
    const store = open()
    expect(store.coverage(1).coveredUntil).toBe(200)
    // 上一版不知道这个索引：它照自己的语句写，索引由 SQLite 跟着维护
    const raw = rawOf()
    raw.prepare("INSERT INTO segments(gen, session_id, turn_seq, seq, segment, at, speaker, text) VALUES (1, 's1', 0, 21, 0, 50000, 'user', 'alpha 21')").run()
    expect(store.coverage(1)).toEqual(coverageByScan(raw, 1))
    expect(store.coverage(1).coveredUntil).toBe(50_000)
    raw.prepare('DELETE FROM segments WHERE seq >= 20').run()
    expect(store.coverage(1)).toEqual(coverageByScan(raw, 1))
    expect(store.coverage(1).coveredUntil).toBe(190)
  })

  it('补索引时库正被别的连接写着：这一次用不了（忙），库不动；对方放开后补上，覆盖情况照旧', () => {
    previousVersionStore(50)
    const other = rawOf()
    other.exec('BEGIN IMMEDIATE')
    const store = open()
    let caught: unknown
    try { store.state() } catch (err) { caught = err }
    expect(caught).toBeInstanceOf(DialogueStoreUnavailable)
    expect((caught as DialogueStoreUnavailable).isBusy).toBe(true)
    other.exec('ROLLBACK')
    expect(existsSync(storePath())).toBe(true)
    expect((other.prepare('SELECT COUNT(*) AS n FROM segments').get() as { n: number }).n).toBe(50)

    expect(store.coverage(1)).toEqual({ sessions: 1, queued: 0, coveredUntil: 500 })
    expect(segmentIndexes(other).some(isGenAtIndex)).toBe(true)
  })
})
