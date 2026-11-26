import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import fc from 'fast-check'
import { DIALOGUE_BM25_WEIGHTS } from '../src/search/dialogue-tokenizer.ts'
import {
  DialogueRecordStore, DialogueStoreUnavailable,
  type DialogueHit, type DialogueRecordStoreOptions, type DialogueSearchOptions, type DialogueSegmentInput, type DialogueVersions,
} from '../src/storage/dialogue-records.ts'
import { interleaveParams } from './helpers/interleave.ts'
import { readsFullText, readsSegmentText, sqliteProbe } from './helpers/sqlite-probe.ts'

// 原话查询分两步（先按相关度取前 N 个段的行号和分数，再按行号取正文）之后：
// 结果和原来一条查询的写法逐项相同；正文只取前 N 段；两步之间别的连接改不了这次看到的库。
// 「原来的写法」是下面 searchInOneStatement 里那条查询的原样，在同一个库文件上另开一个连接执行，当对照。

let dir: string
let opened: DialogueRecordStore[] = []
let raws: DatabaseSync[] = []
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'pm-dialogue-top-n-')) })
afterEach(async () => {
  for (const store of opened.splice(0)) store.close()
  for (const raw of raws.splice(0)) raw.close()
  await rm(dir, { recursive: true, force: true })
})

const V1: DialogueVersions = { segmentRule: 1, tokenizer: 1, intake: 1 }
const V2: DialogueVersions = { segmentRule: 2, tokenizer: 1, intake: 1 }
const HOME = '/sessions/home'
const quiet = { info() {}, warn() {}, error() {} }

function open(path: string, extra: Partial<DialogueRecordStoreOptions> = {}) {
  const store = new DialogueRecordStore({ path, log: quiet, ...extra })
  opened.push(store)
  return store
}

function rawOf(path: string) {
  const raw = new DatabaseSync(path)
  raws.push(raw)
  return raw
}

interface HitRow { session_id: string; turn_seq: number; seq: number; segment: number; at: number | null; speaker: string; text: Uint8Array; cwd: string | null; is_subagent: number; score: number }

/** 对照：原来的写法，一条查询里连上正文和会话表、按相关度排、取前 limit 条。 */
function searchInOneStatement(raw: DatabaseSync, gen: number, match: string, opts: DialogueSearchOptions): DialogueHit[] {
  if (opts.sessionIds?.length === 0) return []
  const where: string[] = ['segments_fts MATCH ?', 's.gen = ?']
  const args: Array<string | number> = [match, gen]
  const among = (column: string, values: readonly string[], negate = false) => {
    where.push(`${column} ${negate ? 'NOT ' : ''}IN (${values.map(() => '?').join(', ')})`)
    args.push(...values)
  }
  if (opts.sessionIds !== undefined) {
    where.push('s.session_id IN (SELECT value FROM json_each(?))')
    args.push(JSON.stringify(opts.sessionIds))
  }
  if (opts.speakers !== undefined) among('s.speaker', opts.speakers)
  if (opts.cwds !== undefined) among('se.cwd', opts.cwds)
  if (opts.excludeSessionIds !== undefined && opts.excludeSessionIds.length > 0) among('s.session_id', opts.excludeSessionIds, true)
  const rows = raw.prepare(`SELECT s.session_id, s.turn_seq, s.seq, s.segment, s.at, s.speaker, CAST(s.text AS BLOB) AS text, se.cwd, se.is_subagent,
      bm25(segments_fts, ?, ?, ?) AS score
    FROM segments_fts JOIN segments s ON s.id = segments_fts.rowid
    JOIN sessions se ON se.gen = s.gen AND se.session_id = s.session_id
    WHERE ${where.join(' AND ')} ORDER BY score, s.id LIMIT ?`).all(...opts.weights, ...args, opts.limit) as unknown as HitRow[]
  return rows.map(r => ({
    sessionId: r.session_id, turnSeq: r.turn_seq, seq: r.seq, segment: r.segment, at: r.at ?? undefined, speaker: r.speaker,
    text: Buffer.from(r.text).toString('utf8'), cwd: r.cwd ?? undefined, isSubagent: r.is_subagent === 1, score: r.score,
  }))
}

/** 一个词的查询式：和分词器拼的一样，整词列或二元组列命中都算。 */
const term = (word: string) => `(w : "${word}" OR b : "${word}")`
const allOf = (words: readonly string[]) => words.map(term).join(' AND ')
const anyOf = (words: readonly string[]) => words.map(term).join(' OR ')

/** 一段：正文的词同时放进 w、b 两列，c 列留空。 */
const seg = (seq: number, text: string, extra: Partial<DialogueSegmentInput> = {}): DialogueSegmentInput =>
  ({ turnSeq: Math.floor(seq / 2), seq, segment: 0, at: 1000 + seq, speaker: 'user', text, w: text, b: text, c: '', ...extra })

/** 在 gen 里收一个会话的全部段（一批）。 */
function addSession(store: DialogueRecordStore, gen: number, sessionId: string, info: { cwd: string | undefined; isSubagent: boolean }, segments: DialogueSegmentInput[]) {
  const started = store.startSession(gen, sessionId, info)
  if (started === undefined) throw new Error('夹具：这一代不在')
  const turns = [...new Set(segments.map(s => s.turnSeq))].map(turnSeq => ({ turnSeq }))
  const ok = store.commitBatch({ gen, sessionId, revision: started.revision, dictionary: 'dict-1', fromWatermark: started.watermark, watermark: segments.length, segments, turns })
  if (!ok) throw new Error('夹具：提交没进去')
}

const WORDS = ['alpha', 'beta', 'gamma', 'delta', 'omega'] as const
const SESSION_IDS = ['s0', 's1', 's2', 's3', 's4'] as const
const CWDS = ['/w/a', '/w/b'] as const

const segmentArb = fc.record({
  words: fc.array(fc.constantFrom(...WORDS), { minLength: 1, maxLength: 5 }),
  speaker: fc.constantFrom('user', 'assistant', 'tool'),
  at: fc.option(fc.integer({ min: 0, max: 40 }), { nil: undefined }),
})
const sessionArb = fc.record({
  cwd: fc.option(fc.constantFrom(...CWDS), { nil: undefined }),
  isSubagent: fc.boolean(),
  segments: fc.array(segmentArb, { maxLength: 30 }),
})
const optionsArb = fc.record({
  sessionIds: fc.option(fc.subarray([...SESSION_IDS, 'unknown']), { nil: undefined }),
  speakers: fc.option(fc.subarray(['user', 'assistant', 'tool']), { nil: undefined }),
  cwds: fc.option(fc.subarray([...CWDS, '/w/none']), { nil: undefined }),
  excludeSessionIds: fc.option(fc.subarray([...SESSION_IDS]), { nil: undefined }),
  limit: fc.constantFrom(1, 3, 10, 60, 500),
  weights: fc.constantFrom<readonly [number, number, number]>([4, 2, 1], [1, 1, 1], DIALOGUE_BM25_WEIGHTS, [1, 5, 0.5]),
})
const queryArb = fc.record({
  words: fc.array(fc.constantFrom(...WORDS, 'absent'), { minLength: 1, maxLength: 3 }),
  mode: fc.constantFrom('all', 'any'),
})

describe('两步查询和原来一条查询的写法逐项相同', () => {
  // 种子：缺省固定（helpers/interleave.ts），PM_INTERLEAVE_SEED 覆盖；轮数缺省 30，PM_INTERLEAVE_RUNS 覆盖。每轮一个库、六组查询和筛选
  it('随机生成的库和查询：全部词命中、任一词回退，各种筛选组合下返回的段、分数和顺序都相同；正在重建时新旧两代各查各的', async () => {
    let nonEmpty = 0
    let fullPages = 0
    let filtered = 0
    let fromWriteGen = 0
    let round = 0
    await fc.assert(fc.asyncProperty(
      fc.array(sessionArb, { minLength: 1, maxLength: SESSION_IDS.length }),
      fc.option(fc.array(sessionArb, { minLength: 1, maxLength: 3 }), { nil: undefined }),
      fc.array(fc.tuple(queryArb, optionsArb, fc.boolean()), { minLength: 6, maxLength: 6 }),
      async (sessions, rebuilt, queries) => {
        const path = join(dir, `round-${round++}.sqlite`)
        const store = open(path)
        const state = store.prepare(V1, 'dict-1', HOME)
        if (state.status === 'none') throw new Error('夹具：准备之后应当有库')
        const readGen = state.write.gen
        const fill = (gen: number, list: typeof sessions) => list.forEach((s, i) => {
          addSession(store, gen, SESSION_IDS[i]!, { cwd: s.cwd, isSubagent: s.isSubagent }, s.segments.map((x, seq) => seg(seq, x.words.join(' '), { speaker: x.speaker, at: x.at })))
        })
        fill(readGen, sessions)
        let writeGen = readGen
        if (rebuilt !== undefined) {
          store.completeBuild(readGen)
          const next = store.prepare(V2, 'dict-1', HOME)
          if (next.status !== 'rebuilding') throw new Error('夹具：规则变了应当在重建')
          writeGen = next.write.gen
          fill(writeGen, rebuilt)
        }
        const raw = rawOf(path)
        for (const [query, options, useWriteGen] of queries) {
          const gen = useWriteGen ? writeGen : readGen
          const match = query.mode === 'all' ? allOf(query.words) : anyOf(query.words)
          const expected = searchInOneStatement(raw, gen, match, options)
          expect(store.search(gen, match, options)).toEqual(expected)
          if (expected.length > 0) nonEmpty++
          if (expected.length === options.limit) fullPages++
          if (expected.length > 0 && (options.speakers ?? options.cwds ?? options.excludeSessionIds ?? options.sessionIds) !== undefined) filtered++
          if (expected.length > 0 && gen !== readGen) fromWriteGen++
        }
        raw.close()
        raws.splice(raws.indexOf(raw), 1)
        store.destroy()
      },
    ), interleaveParams(30))
    // 前提：比较的不全是空结果，有取满条数上限的、带筛选还有结果的、查正在建的新一代的
    expect(nonEmpty).toBeGreaterThan(0)
    expect(fullPages).toBeGreaterThan(0)
    expect(filtered).toBeGreaterThan(0)
    expect(fromWriteGen).toBeGreaterThan(0)
  })

  it('分数相同的段按行号先后排：前 N 名的边界落在一串同分段中间时，取到的和原来一样', () => {
    const path = join(dir, 'ties.sqlite')
    const store = open(path)
    const state = store.prepare(V1, 'dict-1', HOME)
    if (state.status === 'none') throw new Error('夹具：准备之后应当有库')
    const gen = state.write.gen
    addSession(store, gen, 's0', { cwd: '/w/a', isSubagent: false }, Array.from({ length: 20 }, (_, i) => seg(i, 'alpha beta')))
    addSession(store, gen, 's1', { cwd: '/w/b', isSubagent: true }, Array.from({ length: 20 }, (_, i) => seg(i, 'alpha beta', { speaker: 'assistant' })))
    const options = { limit: 25, weights: DIALOGUE_BM25_WEIGHTS }
    const expected = searchInOneStatement(rawOf(path), gen, allOf(['alpha', 'beta']), options)
    // 前提：确实全部同分，第 25 名落在第二个会话中间
    expect(new Set(expected.map(h => h.score)).size).toBe(1)
    expect(expected.filter(h => h.sessionId === 's1')).toHaveLength(5)
    expect(store.search(gen, allOf(['alpha', 'beta']), options)).toEqual(expected)
  })
})

/** 语句的查询计划里，最外层的第一个循环（扫描或查找）。 */
function outermostLoop(raw: DatabaseSync, sql: string): string | undefined {
  const plan = raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ parent: number; detail: string }>
  return plan.find(p => p.parent === 0 && /^(SCAN|SEARCH) /.test(p.detail))?.detail
}

describe('只取前 N 段的正文，全文索引只扫一遍', () => {
  it.each([
    ['全部词命中', allOf(['alpha', 'beta']), {}],
    ['任一词回退、带放行会话和说话人筛选', anyOf(['alpha', 'absent']), { sessionIds: ['s0', 's1'], speakers: ['user', 'assistant'] }],
  ] as const)('%s：命中几百段、只要 7 条时，排名从全文索引出发、它在最外层只扫一遍；取正文的查询不碰全文索引，取回的正文正好 7 行', (_, match, filters) => {
    const probe = sqliteProbe()
    const path = join(dir, 'probe.sqlite')
    const store = open(path, { loadSqlite: () => probe.module })
    const state = store.prepare(V1, 'dict-1', HOME)
    if (state.status === 'none') throw new Error('夹具：准备之后应当有库')
    const gen = state.write.gen
    const filler = ' 记下的排查过程很长'.repeat(40)
    for (const [i, id] of ['s0', 's1', 's2'].entries()) {
      addSession(store, gen, id, { cwd: '/w/a', isSubagent: false }, Array.from({ length: 150 }, (_, seq) =>
        seg(seq, `alpha beta ${seq % 5 === 0 ? 'gamma' : ''}${filler}`, { speaker: (['user', 'assistant', 'tool'] as const)[(seq + i) % 3] })))
    }
    const options = { limit: 7, weights: DIALOGUE_BM25_WEIGHTS, ...filters }
    const raw = rawOf(path)
    const matching = (raw.prepare('SELECT COUNT(*) AS n FROM segments_fts WHERE segments_fts MATCH ?').get(match) as { n: number }).n
    const expected = searchInOneStatement(raw, gen, match, options)
    // 前提：命中远多于条数上限，筛选之后也取得满
    expect(matching).toBe(450)
    expect(expected).toHaveLength(7)

    const { result, statements } = probe.record(() => store.search(gen, match, options))
    expect(result).toEqual(expected)
    // 前提：这次查询确实在库上做了全文检索
    expect(statements.some(readsFullText)).toBe(true)
    const textReads = statements.filter(readsSegmentText)
    expect(textReads.length).toBeGreaterThan(0)
    expect(textReads.filter(readsFullText)).toEqual([])
    expect(textReads.reduce((n, s) => n + s.rows, 0)).toBe(7)
    // 排名那一步：全文索引在最外层扫一遍，命中的段再按行号回表；反过来按段逐个去全文索引里查，命中越多越慢（每查一次都要重算一遍查询式）
    const ranking = statements.filter(readsFullText)
    for (const statement of ranking) expect(outermostLoop(raw, statement.sql), statement.sql).toMatch(/^SCAN segments_fts VIRTUAL TABLE/)
  })
})

it('别的连接拿着写锁、删了段还没提交时照常能查：这次返回的和对照写法逐项相同，看不到没提交的删除', () => {
  const path = join(dir, 'writer.sqlite')
  const store = open(path)
  const state = store.prepare(V1, 'dict-1', HOME)
  if (state.status === 'none') throw new Error('夹具：准备之后应当有库')
  const gen = state.write.gen
  addSession(store, gen, 's0', { cwd: '/w/a', isSubagent: false }, Array.from({ length: 30 }, (_, i) => seg(i, `alpha beta ${i}`)))
  addSession(store, gen, 's1', { cwd: '/w/b', isSubagent: false }, Array.from({ length: 30 }, (_, i) => seg(i, `alpha ${i}`)))
  const options = { limit: 40, weights: DIALOGUE_BM25_WEIGHTS }
  const match = anyOf(['alpha', 'beta'])
  const expected = searchInOneStatement(rawOf(path), gen, match, options)
  expect(expected.some(h => h.sessionId === 's1')).toBe(true)

  // 另一个连接拿写锁（RESERVED），删掉 s1 的段但不提交：两步都只读的查询照常取到共享锁；用写事务查的会报忙
  const writer = rawOf(path)
  writer.exec('BEGIN IMMEDIATE')
  writer.prepare('DELETE FROM segments WHERE session_id = ?').run('s1')
  try {
    expect(store.search(gen, match, options)).toEqual(expected)
  } finally {
    writer.exec('ROLLBACK')
  }
})

it('两步之间别的连接要移出命中所在的会话：等这次查询做完才移得掉，这次返回的和移出前的结果逐项相同', () => {
  const probe = sqliteProbe()
  const path = join(dir, 'snapshot.sqlite')
  const store = open(path, { loadSqlite: () => probe.module })
  const state = store.prepare(V1, 'dict-1', HOME)
  if (state.status === 'none') throw new Error('夹具：准备之后应当有库')
  const gen = state.write.gen
  addSession(store, gen, 's0', { cwd: '/w/a', isSubagent: false }, Array.from({ length: 30 }, (_, i) => seg(i, `alpha beta ${i}`)))
  addSession(store, gen, 's1', { cwd: '/w/b', isSubagent: false }, Array.from({ length: 30 }, (_, i) => seg(i, `alpha ${i}`)))
  const options = { limit: 20, weights: DIALOGUE_BM25_WEIGHTS }
  const match = anyOf(['alpha', 'beta'])
  const expected = searchInOneStatement(rawOf(path), gen, match, options)
  expect(expected.some(h => h.sessionId === 's0')).toBe(true)

  const other = open(path)
  // 另一个连接先打开好：插进来的只有移出这一个写
  expect(other.state()).toMatchObject({ status: 'building' })
  let attempt: unknown = 'not attempted'
  probe.beforeExecute = statement => {
    if (!readsSegmentText(statement) || attempt !== 'not attempted') return
    try {
      other.removeSession('s0')
      attempt = 'removed'
    } catch (err) {
      attempt = err
    }
  }
  const hits = store.search(gen, match, options)
  probe.beforeExecute = undefined

  // 前提：确实在取正文之前插进了移出
  expect(attempt).not.toBe('not attempted')
  expect(attempt).toBeInstanceOf(DialogueStoreUnavailable)
  expect((attempt as DialogueStoreUnavailable).isBusy).toBe(true)
  expect(hits).toEqual(expected)
  // 查询做完之后照常移得掉，再查就没有它了
  other.removeSession('s0')
  const after = store.search(gen, match, options)
  expect(after.length).toBeGreaterThan(0)
  expect(after.some(h => h.sessionId === 's0')).toBe(false)
})
