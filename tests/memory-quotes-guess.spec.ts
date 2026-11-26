import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DialogueRecordStore } from '../src/storage/dialogue-records.ts'
import { FileTable } from '../src/storage/file-table.ts'
import { dialogueTokenizer } from '../src/search/dialogue-tokenizer.ts'
import { DialogueCatchup } from '../src/tools/dialogue-catchup.ts'
import { executeSearch, renderSearchResult, type SearchContext, type SearchToolDeps } from '../src/tools/search.ts'
import { NoReviewList } from '../src/storage/no-review.ts'
import { MemoryStore } from '../src/store.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'
import { estimateTokens } from '../src/snapshot.ts'
import { SEGMENT_MAX_TOKENS } from '../src/search/segments.ts'
import type { RecallStats } from '../src/storage/schema.ts'
import type { MemoryRecord, SourceAnchor } from '../src/record-schema.ts'
import type { RawEvent, SessionLog } from '../src/session-log.ts'
import {
  GUESS_CANDIDATE_MIN_COVERAGE, GUESS_LOOKBACK_TURNS, GUESS_MATCH_MIN_COVERAGE, GUESS_MIN_MARGIN, GUESS_UNLOCATED_MAX_TURNS, MEMORY_QUOTE_BUDGET_TOKENS,
} from '../src/search/memory-quotes.ts'
import {
  ANCHOR_TURN_MISMATCH_NOTE, DIALOGUE_QUOTE_TAG, GUESSED_SOURCE_MARK, MEMORY_QUOTES_UNAVAILABLE, QUOTE_PENDING, QUOTE_UNLOCATED, TURN_NOT_INDEXED_NOTE,
} from '../src/search/dialogue-format.ts'
import { InMemoryTable } from './helpers/in-memory-table.ts'
import { InMemoryBatchKvTable, InMemoryKvTable } from './helpers/in-memory-kv.ts'
import { SOURCE_TIME, assistant, event, user } from './helpers/source-host.ts'
import { fakeExec } from './helpers/exec.ts'
import { record } from './helpers/record.ts'

// 记忆带原话时查询时补找出处：锚所在轮和记忆正文对不上，就在同一会话往前找最相关的一轮补上，标推测出处。
// 夹具用互不相同的汉字拼成两字词：记忆正文是 WORD_COUNT 个词，一轮原话含其中 k 个词，重合就正好是 k / WORD_COUNT，阈值两侧的用例都按常量算 k。

const LOG = { info() {}, warn() {}, error() {} }
const at = (seq: number) => SOURCE_TIME + seq
const turnStart = (seq: number) => event(seq, 'turn/start')

const han = (i: number) => String.fromCodePoint(0x5000 + i)
const WORD_COUNT = 100
const words = (base: number) => Array.from({ length: WORD_COUNT }, (_, i) => han(base + 2 * i) + han(base + 2 * i + 1))
/** 记忆正文用的词；另一组给第二条记忆。 */
const WORDS = words(0)
const OTHER_WORDS = words(400)
const MEMORY = WORDS.join('，')
const OTHER_MEMORY = OTHER_WORDS.join('，')
/** 一段连续的汉字，字都不在两组词里：拼不出记忆正文的二元组。 */
const filler = (from: number, length: number) => Array.from({ length }, (_, j) => han(1000 + from + j)).join('')
/** 刚好过阈值和刚好不过阈值的词数。 */
const above = (threshold: number) => Math.round(threshold * WORD_COUNT) + 1
const below = (threshold: number) => Math.round(threshold * WORD_COUNT) - 1

/** 一轮：mark 用来认出是哪一轮；k 是含记忆正文的前几个词；null 是只有工具调用、没有原话的空轮。pad 是用户消息末尾补的字数。 */
type TurnSpec = { k: number; mark: string; pad?: number; vocabulary?: readonly string[]; reply?: string } | null
const said = (spec: Exclude<TurnSpec, null>) => [filler(0, 6), spec.mark, ...(spec.vocabulary ?? WORDS).slice(0, spec.k), filler(100, spec.pad ?? 0)].filter(Boolean).join('，')
/** 第 i 轮的 turn/start 序号是 10(i+1)，用户消息在 +1，助手回答在 +2。 */
const seqOf = (i: number) => 10 * (i + 1)
function sessionOf(id: string, turns: readonly TurnSpec[], prefix: RawEvent[] = []): SessionLog {
  const events = turns.flatMap((spec, i) => {
    const s = seqOf(i)
    if (spec === null) return [turnStart(s), event(s + 1, 'tool/call', { callId: `c${s}`, name: 'read', arguments: '{}' })]
    return [turnStart(s), user(s + 1, said(spec)), assistant(s + 2, spec.reply ?? filler(50, 4))]
  })
  return { header: { id, isSeeded: false }, inheritedEventCount: prefix.length, events: [...prefix, ...events] }
}
const plain = (n: number, overrides: Record<number, Exclude<TurnSpec, null> | null> = {}): TurnSpec[] =>
  Array.from({ length: n }, (_, i) => (i in overrides ? overrides[i]! : { k: 0, mark: `round-${i}` }))

/** 前台保存的锚：起点是这一轮的 turn/start。 */
const anchorAt = (sessionId: string, i: number, extra: Partial<SourceAnchor> = {}): SourceAnchor =>
  ({ sessionId, eventRange: [seqOf(i), seqOf(i) + 2], sourceMode: 'user-explicit', at: at(seqOf(i)), change: 'create', ...extra })
const memoryOf = (id: string, anchor: SourceAnchor, partial: Partial<MemoryRecord> = {}): MemoryRecord => record({
  id, name: `zebra ${id}`, content: MEMORY, scope: 'workspace', workspacePath: '/proj', ...partial,
  source: { sessionId: anchor.sessionId, eventRange: anchor.eventRange, sourceMode: 'user-explicit' },
  sourceTrail: [anchor],
})

let dir: string
let db: DialogueRecordStore
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'memory-quotes-guess-')); db = new DialogueRecordStore({ path: join(dir, 'db'), log: LOG }) })
afterEach(async () => { db.close(); await rm(dir, { recursive: true, force: true }) })

interface SetupOptions { quotes?: boolean; source?: 'memory' | 'both'; unbuilt?: readonly string[]; files?: boolean }

async function setup(logs: Record<string, SessionLog>, records: MemoryRecord[], opts: SetupOptions = {}) {
  const tokenizer = await dialogueTokenizer({ log: { warn() {} } })
  const ids = Object.keys(logs)
  const entry = (id: string) => ({ id, cwd: '/proj', isSubagent: false, isLive: false })
  const host = {
    readSessionLog: vi.fn(async (id: string): Promise<SessionLog | null> => logs[id] ?? null),
    sessionTitleOf: vi.fn(async () => undefined),
    listSessions: vi.fn(async () => ids.map(entry)),
    contextOf: vi.fn(async (): Promise<SearchContext> => ({ workspacePath: '/proj', session: { id: 'cur', lastSeq: 0 } })),
  }
  const noReview = new NoReviewList(dir)
  const workspaceOf = async (cwd: string | undefined) => cwd
  const catchup = new DialogueCatchup({
    store: db, host, noReview, workspaceOf, tokenizer: async () => tokenizer, knownWorkspaces: async () => ['/proj'],
    isEnabled: () => true, sessionStore: '/sessions', log: LOG, now: () => 1000,
  })
  // unbuilt 里的会话第一次建库时不在清单里：库还没收到
  host.listSessions.mockResolvedValueOnce(ids.filter(id => !opts.unbuilt?.includes(id)).map(entry))
  await catchup.advance(60_000)
  const table = opts.files ? new FileTable({ root: join(dir, 'memories'), stats: new InMemoryKvTable<RecallStats>() }) : new InMemoryTable()
  const store = new MemoryStore(table, undefined, new InMemoryBatchKvTable())
  for (const r of records) await store.put(r)
  const deps: SearchToolDeps = {
    store, registry: buildTypeRegistry({ template: 'coding', customTypes: {} }), host, now: () => 1000,
    searchSource: () => opts.source ?? 'memory', memoryQuotes: () => opts.quotes ?? true,
    dialogue: { store: db, catchup, host, noReview, workspaceOf, hasBackgroundTimer: () => true, tokenizer: async () => tokenizer },
  }
  host.readSessionLog.mockClear(); host.listSessions.mockClear()
  return { deps, store }
}
const run = async (deps: SearchToolDeps, query = 'zebra') => {
  const result = await executeSearch({ query }, fakeExec(), deps)
  return { result, text: renderSearchResult(result) }
}
const quoteOf = (result: { hits: Array<{ id: string; quote?: string }> }, id: string) => result.hits.find(h => h.id === id)?.quote ?? ''
const linesOf = (block: string) => block.split('\n')
/** 推测出处标记那一行的下一行（推测出处那一轮的第一行）。 */
const afterMark = (block: string) => { const lines = linesOf(block); const i = lines.indexOf(GUESSED_SOURCE_MARK); return i < 0 ? undefined : lines[i + 1] }
/** 「这一轮可能不是内容的出处」那一行紧跟着的那一轮（从上一个空行或标签行到这一行之前）。 */
const beforeNote = (block: string) => {
  const lines = linesOf(block)
  const i = lines.indexOf(ANCHOR_TURN_MISMATCH_NOTE)
  if (i < 0) return undefined
  let from = i
  while (from > 0 && lines[from - 1] !== '' && lines[from - 1] !== `<${DIALOGUE_QUOTE_TAG}>`) from--
  return lines.slice(from, i).join('\n')
}
const occurrences = (text: string, needle: string) => text.split(needle).length - 1

describe('补上推测出处', () => {
  it('用户提醒后才存：锚所在轮对不上记忆正文，在这一轮后面补上前几轮里最相关的一轮，标推测出处', async () => {
    const log: SessionLog = {
      header: { id: 'story', isSeeded: false }, inheritedEventCount: 0, events: [
        turnStart(10), user(11, '部署脚本要先跑数据库迁移再重启服务'), assistant(12, '明白，顺序是先迁移再重启'),
        turnStart(20), user(21, '今天天气不错'), assistant(22, '是的'),
        turnStart(30), user(31, '刚才那个记一下'), assistant(32, '已记下'),
      ],
    }
    const r = memoryOf('mem_story', { sessionId: 'story', eventRange: [30, 32], sourceMode: 'user-explicit', at: at(30), change: 'create' }, { content: '部署前先跑数据库迁移，再重启服务' })
    const { deps } = await setup({ story: log }, [r])
    const block = quoteOf((await run(deps)).result, 'mem_story')
    expect(block).toContain('用户：刚才那个记一下')
    expect(afterMark(block)).toContain('用户：部署脚本要先跑数据库迁移再重启服务')
    expect(block.indexOf('用户：刚才那个记一下')).toBeLessThan(block.indexOf(GUESSED_SOURCE_MARK))
    expect(block).not.toContain('今天天气不错')
    expect(linesOf(block)).not.toContain(ANCHOR_TURN_MISMATCH_NOTE)
    // 推测出处在原话标签里，和锚所在的轮一起
    expect(block.indexOf(`<${DIALOGUE_QUOTE_TAG}>`)).toBeLessThan(block.indexOf(GUESSED_SOURCE_MARK))
    expect(block.indexOf(GUESSED_SOURCE_MARK)).toBeLessThan(block.indexOf(`</${DIALOGUE_QUOTE_TAG}>`))
  })

  it('锚所在轮的重合刚过「对得上」的阈值：不补、不加说明；刚不到阈值：补上前面整句都对得上的那一轮', async () => {
    const ok = sessionOf('ok', plain(3, { 0: { k: WORD_COUNT, mark: 'round-0' }, 2: { k: above(GUESS_MATCH_MIN_COVERAGE), mark: 'round-2' } }))
    const off = sessionOf('off', plain(3, { 0: { k: WORD_COUNT, mark: 'round-0' }, 2: { k: below(GUESS_MATCH_MIN_COVERAGE), mark: 'round-2' } }))
    const { deps } = await setup({ ok, off }, [memoryOf('mem_ok', anchorAt('ok', 2)), memoryOf('mem_off', anchorAt('off', 2))])
    const { result } = await run(deps)
    const kept = quoteOf(result, 'mem_ok')
    expect(kept).toContain('round-2')
    expect(kept).not.toContain('round-0')
    expect(linesOf(kept)).not.toContain(GUESSED_SOURCE_MARK)
    expect(linesOf(kept)).not.toContain(ANCHOR_TURN_MISMATCH_NOTE)
    const guessed = quoteOf(result, 'mem_off')
    expect(guessed).toContain('round-2')
    expect(afterMark(guessed)).toContain('round-0')
  })

  it('候选轮的重合刚过自身门槛、刚不到自身门槛：过了才给，没过只写这一轮可能不是出处', async () => {
    const pass = sessionOf('pass', plain(3, { 0: { k: above(GUESS_CANDIDATE_MIN_COVERAGE), mark: 'round-0' } }))
    const fail = sessionOf('fail', plain(3, { 0: { k: below(GUESS_CANDIDATE_MIN_COVERAGE), mark: 'round-0' } }))
    // 锚所在轮一个词都没有：差值只看候选自身，两边都过差值门槛
    expect(below(GUESS_CANDIDATE_MIN_COVERAGE)).toBeGreaterThanOrEqual(Math.ceil(GUESS_MIN_MARGIN * WORD_COUNT))
    const { deps } = await setup({ pass, fail }, [memoryOf('mem_pass', anchorAt('pass', 2)), memoryOf('mem_fail', anchorAt('fail', 2))])
    const { result } = await run(deps)
    expect(afterMark(quoteOf(result, 'mem_pass'))).toContain('round-0')
    const failed = quoteOf(result, 'mem_fail')
    expect(failed).toContain('round-2')
    expect(failed).not.toContain('round-0')
    expect(linesOf(failed)).not.toContain(GUESSED_SOURCE_MARK)
    expect(beforeNote(failed)).toContain('round-2')
  })

  it('两道门槛只过一道（自身相关度够、比锚所在轮好得不够明显）：不给推测出处，只写这一轮可能不是出处', async () => {
    const anchorK = below(GUESS_MATCH_MIN_COVERAGE)
    const candidateK = above(GUESS_CANDIDATE_MIN_COVERAGE)
    expect(candidateK - anchorK).toBeLessThan(GUESS_MIN_MARGIN * WORD_COUNT)
    const s = sessionOf('near', plain(3, { 0: { k: candidateK, mark: 'round-0' }, 2: { k: anchorK, mark: 'round-2' } }))
    const { deps } = await setup({ near: s }, [memoryOf('mem_near', anchorAt('near', 2))])
    const block = quoteOf((await run(deps)).result, 'mem_near')
    expect(block).toContain('round-2')
    expect(block).not.toContain('round-0')
    expect(linesOf(block)).not.toContain(GUESSED_SOURCE_MARK)
    expect(beforeNote(block)).toContain('round-2')
  })

  it('两道门槛只过一道（比锚所在轮好得明显、自身相关度不够）：不给推测出处，只写这一轮可能不是出处', async () => {
    const candidateK = below(GUESS_CANDIDATE_MIN_COVERAGE)
    expect(candidateK).toBeGreaterThanOrEqual(Math.ceil(GUESS_MIN_MARGIN * WORD_COUNT))
    const s = sessionOf('weak', plain(3, { 0: { k: candidateK, mark: 'round-0' } }))
    const { deps } = await setup({ weak: s }, [memoryOf('mem_weak', anchorAt('weak', 2))])
    const block = quoteOf((await run(deps)).result, 'mem_weak')
    expect(block).not.toContain('round-0')
    expect(linesOf(block)).not.toContain(GUESSED_SOURCE_MARK)
    expect(beforeNote(block)).toContain('round-2')
  })

  it('往前只看固定的几轮：最相关的一轮正好在回看范围的最远处时补上，再远一轮就不补', async () => {
    const reach = GUESS_LOOKBACK_TURNS
    const inside = sessionOf('inside', plain(reach + 2, { 1: { k: WORD_COUNT, mark: 'round-1' } }))
    const outside = sessionOf('outside', plain(reach + 2, { 0: { k: WORD_COUNT, mark: 'round-0' } }))
    const { deps } = await setup({ inside, outside }, [memoryOf('mem_in', anchorAt('inside', reach + 1)), memoryOf('mem_out', anchorAt('outside', reach + 1))])
    const { result } = await run(deps)
    expect(afterMark(quoteOf(result, 'mem_in'))).toContain('round-1')
    const far = quoteOf(result, 'mem_out')
    expect(far).not.toContain('round-0')
    expect(beforeNote(far)).toContain(`round-${reach + 1}`)
  })

  it('补找只在锚所在的会话里：fork 继承来的父会话前缀、项目里别的会话都碰不到', async () => {
    const parentTurn = [turnStart(1), user(2, said({ k: WORD_COUNT, mark: 'parent-round' })), assistant(3, filler(50, 4))]
    const child = sessionOf('child', [{ k: 0, mark: 'round-0' }], parentTurn)
    const other = sessionOf('other', [{ k: WORD_COUNT, mark: 'other-round' }])
    const { deps } = await setup({ child, other }, [memoryOf('mem_child', anchorAt('child', 0))])
    const block = quoteOf((await run(deps)).result, 'mem_child')
    expect(block).toContain('round-0')
    expect(block).not.toContain('parent-round')
    expect(block).not.toContain('other-round')
    expect(linesOf(block)).not.toContain(GUESSED_SOURCE_MARK)
    expect(beforeNote(block)).toContain('round-0')
  })
})

describe('定位不到轮的锚', () => {
  it('整会话兜底的锚（起点 0）：在锚覆盖到的轮里补找，给了就只附推测出处那一轮；最相关的轮在锚终点之后不算', async () => {
    // 锚覆盖第 0 到 2 轮
    const covered = sessionOf('covered', plain(4, { 1: { k: WORD_COUNT, mark: 'round-1' } }))
    const later = sessionOf('later', plain(4, { 3: { k: WORD_COUNT, mark: 'round-3' } }))
    const whole = (id: string): SourceAnchor => ({ sessionId: id, eventRange: [0, seqOf(2) + 2], sourceMode: 'user-explicit', at: at(0), change: 'create' })
    const { deps } = await setup({ covered, later }, [memoryOf('mem_cov', whole('covered')), memoryOf('mem_late', whole('later'))])
    const { result } = await run(deps)
    const found = quoteOf(result, 'mem_cov')
    expect(afterMark(found)).toContain('round-1')
    expect(found).not.toContain('round-0'); expect(found).not.toContain('round-2')
    expect(found).not.toContain(QUOTE_UNLOCATED)
    const missed = quoteOf(result, 'mem_late')
    expect(missed).toContain(QUOTE_UNLOCATED)
    expect(missed).not.toContain('round-3')
    expect(missed).not.toContain(DIALOGUE_QUOTE_TAG)
  })

  it('定位不到轮只过自身门槛：刚过就给，刚不到写定位不到出处是哪一轮', async () => {
    const pass = sessionOf('pass', plain(2, { 0: { k: above(GUESS_CANDIDATE_MIN_COVERAGE), mark: 'round-0' } }))
    const fail = sessionOf('fail', plain(2, { 0: { k: below(GUESS_CANDIDATE_MIN_COVERAGE), mark: 'round-0' } }))
    const whole = (id: string): SourceAnchor => ({ sessionId: id, eventRange: [0, seqOf(1) + 2], sourceMode: 'user-explicit', at: at(0), change: 'create' })
    const { deps } = await setup({ pass, fail }, [memoryOf('mem_pass', whole('pass')), memoryOf('mem_fail', whole('fail'))])
    const { result } = await run(deps)
    expect(afterMark(quoteOf(result, 'mem_pass'))).toContain('round-0')
    const failed = quoteOf(result, 'mem_fail')
    expect(failed).toContain(QUOTE_UNLOCATED)
    expect(failed).not.toContain('round-0')
    expect(linesOf(failed)).not.toContain(ANCHOR_TURN_MISMATCH_NOTE)
  })

  it('定位不到轮只看锚覆盖范围里最近的固定轮数：最相关的一轮在最远处之外就不补', async () => {
    const cap = GUESS_UNLOCATED_MAX_TURNS
    const inside = sessionOf('inside', plain(cap + 1, { 1: { k: WORD_COUNT, mark: 'round-1' } }))
    const outside = sessionOf('outside', plain(cap + 1, { 0: { k: WORD_COUNT, mark: 'round-0' } }))
    const whole = (id: string): SourceAnchor => ({ sessionId: id, eventRange: [0, seqOf(cap) + 2], sourceMode: 'user-explicit', at: at(0), change: 'create' })
    const { deps } = await setup({ inside, outside }, [memoryOf('mem_in', whole('inside')), memoryOf('mem_out', whole('outside'))])
    const { result } = await run(deps)
    expect(afterMark(quoteOf(result, 'mem_in'))).toContain('round-1')
    const far = quoteOf(result, 'mem_out')
    expect(far).toContain(QUOTE_UNLOCATED)
    expect(far).not.toContain('round-0')
  })

  it('起点早于第一轮的锚照定位不到轮补找；起点在某一轮里、按时间找不回的锚不补找', async () => {
    const early = sessionOf('early', plain(2, { 0: { k: WORD_COUNT, mark: 'round-0' } }))
    const moved = sessionOf('moved', plain(2, { 0: { k: WORD_COUNT, mark: 'round-0' } }))
    const before: SourceAnchor = { sessionId: 'early', eventRange: [5, seqOf(1) + 2], sourceMode: 'user-explicit', at: at(5), change: 'create' }
    // 锚时间早于会话的每一轮：按时间找不回，序号不可信
    const lost = anchorAt('moved', 0, { at: SOURCE_TIME - 1000 })
    const { deps } = await setup({ early, moved }, [memoryOf('mem_early', before), memoryOf('mem_lost', lost)])
    const { result } = await run(deps)
    expect(afterMark(quoteOf(result, 'mem_early'))).toContain('round-0')
    const block = quoteOf(result, 'mem_lost')
    expect(block).toContain(QUOTE_UNLOCATED)
    expect(block).not.toContain('round-0')
  })
})

describe('预算和去重', () => {
  /** 一轮问答各约 290 token：用户消息含记忆正文的 k 个词再补字，助手回答一整段补字。 */
  const heavy = (k: number, mark: string, vocabulary: readonly string[] = WORDS): Exclude<TurnSpec, null> =>
    ({ k, mark, vocabulary, pad: 470 - 3 * k, reply: filler(600, 480) })

  it('补上的原话计入附原话那份预算：装得下就给，合计不超过上限', async () => {
    const s = sessionOf('fit', plain(2, { 0: heavy(WORD_COUNT, 'round-0') }))
    const { deps } = await setup({ fit: s }, [memoryOf('mem_fit', anchorAt('fit', 1))])
    const block = quoteOf((await run(deps)).result, 'mem_fit')
    expect(afterMark(block)).toContain('round-0')
    const bodies = [...block.matchAll(/(?:用户|助手)：([\s\S]*?)(?:〔|（节选|\n\[|\n<\/|\n【)/g)].map(m => m[1]!)
    expect(bodies.reduce((n, t) => n + estimateTokens(t), 0)).toBeLessThanOrEqual(MEMORY_QUOTE_BUDGET_TOKENS)
  })

  it('补上的原话装不下预算：不给推测出处，锚所在轮后面写这一轮可能不是出处，合计不超过上限', async () => {
    const tight = sessionOf('tight', plain(2, { 0: heavy(WORD_COUNT, 'round-0') }))
    const big = sessionOf('big', [heavy(WORD_COUNT, 'big-round', OTHER_WORDS)])
    const turnCost = estimateTokens(said(heavy(WORD_COUNT, 'round-0'))) + estimateTokens(filler(600, 480))
    // 每条消息不切段；两轮大的加上一轮小的超出预算
    expect(estimateTokens(said(heavy(WORD_COUNT, 'round-0')))).toBeLessThanOrEqual(SEGMENT_MAX_TOKENS)
    expect(estimateTokens(filler(600, 480))).toBeLessThanOrEqual(SEGMENT_MAX_TOKENS)
    expect(2 * turnCost).toBeGreaterThan(MEMORY_QUOTE_BUDGET_TOKENS - estimateTokens(said({ k: 0, mark: 'round-1' })) - estimateTokens(filler(50, 4)))
    const { deps } = await setup({ tight, big }, [
      memoryOf('mem_tight', anchorAt('tight', 1)),
      memoryOf('mem_big', anchorAt('big', 0), { content: OTHER_MEMORY }),
    ])
    const { result, text } = await run(deps)
    expect(quoteOf(result, 'mem_big')).toContain('big-round')
    const block = quoteOf(result, 'mem_tight')
    expect(block).toContain('round-1')
    expect(block).not.toContain('round-0')
    expect(linesOf(block)).not.toContain(GUESSED_SOURCE_MARK)
    expect(beforeNote(block)).toContain('round-1')
    const bodies = [...text.matchAll(/(?:用户|助手)：([\s\S]*?)(?:〔|（节选|\n\[|\n<\/|\n【)/g)].map(m => m[1]!)
    expect(bodies.reduce((n, t) => n + estimateTokens(t), 0)).toBeLessThanOrEqual(MEMORY_QUOTE_BUDGET_TOKENS)
  })

  it('检索来源含原话时，推测出处那一轮附在记忆下面，不再出现在其他原话里', async () => {
    const s = sessionOf('dup', plain(2, { 0: { k: WORD_COUNT, mark: 'zebra round-0' } }))
    const { deps } = await setup({ dup: s }, [memoryOf('mem_dup', anchorAt('dup', 1))], { source: 'both' })
    const { result, text } = await run(deps)
    expect(afterMark(quoteOf(result, 'mem_dup'))).toContain('round-0')
    expect(result.dialogueText ?? '').not.toContain('round-0')
    expect(occurrences(text, said({ k: WORD_COUNT, mark: 'zebra round-0' }))).toBe(1)
  })

  it('推测出处那一轮也是另一条记忆的出处：这一轮在整个结果里只出现一次', async () => {
    const s = sessionOf('shared', plain(2, { 0: { k: WORD_COUNT, mark: 'round-0' } }))
    const { deps } = await setup({ shared: s }, [memoryOf('mem_guess', anchorAt('shared', 1)), memoryOf('mem_own', anchorAt('shared', 0))])
    const { result, text } = await run(deps)
    expect(result.hits.map(h => h.id).sort()).toEqual(['mem_guess', 'mem_own'])
    // 补找确实跑了：推测出处那一轮已附在另一条记忆下面，这条记忆的锚所在轮后面写对不上的说明
    expect(beforeNote(quoteOf(result, 'mem_guess'))).toContain('round-1')
    expect(quoteOf(result, 'mem_own')).toContain('round-0')
    expect(occurrences(text, said({ k: WORD_COUNT, mark: 'round-0' }))).toBe(1)
  })
})

describe('只读、现算', () => {
  it('补找前后记忆文件和锚逐字节不变', async () => {
    const s = sessionOf('file', plain(2, { 0: { k: WORD_COUNT, mark: 'round-0' } }))
    const r = memoryOf('mem_file', anchorAt('file', 1))
    const { deps, store } = await setup({ file: s }, [r], { files: true })
    const root = join(dir, 'memories')
    const snapshot = async () => {
      const files = (await readdir(root, { recursive: true, withFileTypes: true })).filter(e => e.isFile() && e.name.endsWith('.md'))
      return new Map(await Promise.all(files.map(async e => [join(e.parentPath, e.name), await readFile(join(e.parentPath, e.name))] as const)))
    }
    const before = await snapshot()
    const anchorsBefore = (await store.get('mem_file'))?.sourceTrail
    expect(before.size).toBeGreaterThan(0)
    expect(anchorsBefore).toEqual([anchorAt('file', 1)])
    expect(afterMark(quoteOf((await run(deps)).result, 'mem_file'))).toContain('round-0')
    expect(await snapshot()).toEqual(before)
    expect((await store.get('mem_file'))?.sourceTrail).toEqual(anchorsBefore)
  })

  it('不改 memory_search 的排序和返回：开着带原话时命中的条目、顺序和各字段除附的原话外都和关着时一样', async () => {
    const s = sessionOf('rank', plain(2, { 0: { k: WORD_COUNT, mark: 'round-0' } }))
    const own = sessionOf('own', [{ k: WORD_COUNT, mark: 'own-round', vocabulary: OTHER_WORDS }])
    const records = [memoryOf('mem_a', anchorAt('rank', 1)), memoryOf('mem_b', anchorAt('own', 0), { content: OTHER_MEMORY, name: 'zebra zebra mem_b' })]
    const { deps } = await setup({ rank: s, own }, records)
    const on = (await run(deps)).result
    const off = (await run({ ...deps, memoryQuotes: () => false })).result
    expect(on.hits.some(h => afterMark(h.quote ?? '')?.includes('round-0') ?? false)).toBe(true)
    expect(on.hits.map(({ quote: _quote, ...rest }) => rest)).toEqual(off.hits.map(({ quote: _quote, ...rest }) => rest))
  })

  it('带原话关着时不补找：不读对话记录库，输出和不给原话依赖时逐字节一致', async () => {
    const s = sessionOf('quiet', plain(2, { 0: { k: WORD_COUNT, mark: 'round-0' } }))
    const { deps } = await setup({ quiet: s }, [memoryOf('mem_q', anchorAt('quiet', 1))])
    expect(afterMark(quoteOf((await run(deps)).result, 'mem_q'))).toContain('round-0')
    const turns = vi.spyOn(db, 'turnsOf'); const segments = vi.spyOn(db, 'segmentsOf')
    const off = await run({ ...deps, memoryQuotes: () => false })
    const baseline = await run({ ...deps, memoryQuotes: undefined, dialogue: undefined })
    expect(off.text).toBe(baseline.text)
    expect(off.text).not.toContain(GUESSED_SOURCE_MARK); expect(off.text).not.toContain(ANCHOR_TURN_MISMATCH_NOTE)
    expect(turns).not.toHaveBeenCalled(); expect(segments).not.toHaveBeenCalled()
  })

  it('每次检索现算：手改记忆正文后结论跟着变，改回去又补上', async () => {
    const s = sessionOf('live', plain(2, { 0: { k: WORD_COUNT, mark: 'round-0' }, 1: { k: WORD_COUNT, mark: 'round-1', vocabulary: OTHER_WORDS } }))
    const r = memoryOf('mem_live', anchorAt('live', 1))
    const { deps, store } = await setup({ live: s }, [r])
    expect(afterMark(quoteOf((await run(deps)).result, 'mem_live'))).toContain('round-0')
    // 改成锚所在轮说的那些词：对得上，不补
    await store.put({ ...r, content: OTHER_MEMORY })
    const matched = quoteOf((await run(deps)).result, 'mem_live')
    expect(matched).toContain('round-1')
    expect(matched).not.toContain('round-0')
    expect(linesOf(matched)).not.toContain(GUESSED_SOURCE_MARK)
    expect(linesOf(matched)).not.toContain(ANCHOR_TURN_MISMATCH_NOTE)
    await store.put({ ...r, content: MEMORY })
    expect(afterMark(quoteOf((await run(deps)).result, 'mem_live'))).toContain('round-0')
  })
})

describe('取不到和外部输入', () => {
  it('锚所在会话库里还没收到：锚在某一轮的和整会话兜底的都写原话还在整理，不比较、不写对不上的说明', async () => {
    const late = sessionOf('late', plain(2, { 0: { k: WORD_COUNT, mark: 'round-0' } }))
    const whole: SourceAnchor = { sessionId: 'late', eventRange: [0, seqOf(1) + 2], sourceMode: 'user-explicit', at: at(0), change: 'create' }
    const { deps } = await setup({ late }, [memoryOf('mem_turn', anchorAt('late', 1)), memoryOf('mem_whole', whole)], { unbuilt: ['late'] })
    const { result } = await run(deps)
    for (const id of ['mem_turn', 'mem_whole']) {
      const block = quoteOf(result, id)
      expect(block).toContain(QUOTE_PENDING)
      expect(block).not.toContain(QUOTE_UNLOCATED)
      expect(linesOf(block)).not.toContain(GUESSED_SOURCE_MARK)
      expect(linesOf(block)).not.toContain(ANCHOR_TURN_MISMATCH_NOTE)
      expect(block).not.toContain('round-0')
    }
  })

  it('锚所在轮没有可展示的原话：照旧写这一轮暂无原话，不往前补找', async () => {
    const s = sessionOf('empty', plain(2, { 0: { k: WORD_COUNT, mark: 'round-0' }, 1: null }))
    // 空轮只有 turn/start 和一次工具调用
    const { deps } = await setup({ empty: s }, [memoryOf('mem_e', { ...anchorAt('empty', 1), eventRange: [seqOf(1), seqOf(1) + 1] })])
    const block = quoteOf((await run(deps)).result, 'mem_e')
    expect(block).toContain(TURN_NOT_INDEXED_NOTE)
    expect(block).not.toContain('round-0')
    expect(linesOf(block)).not.toContain(GUESSED_SOURCE_MARK)
  })

  it('往前读候选轮时库出错：交给原话这一路现有的故障处理，记忆照常返回，说明一次出处原话取不到', async () => {
    const s = sessionOf('broken', plain(2, { 0: { k: WORD_COUNT, mark: 'round-0' } }))
    const { deps } = await setup({ broken: s }, [memoryOf('mem_x', anchorAt('broken', 1))])
    const original = db.segmentsOf.bind(db)
    const failed: number[] = []
    vi.spyOn(db, 'segmentsOf').mockImplementation((gen, sessionId, fromSeq, toSeq) => {
      if (fromSeq < seqOf(1)) { failed.push(fromSeq); throw new Error('disk') }
      return original(gen, sessionId, fromSeq, toSeq)
    })
    const { result, text } = await run(deps)
    expect(failed.length).toBeGreaterThan(0)
    expect(result.hits.map(h => h.id)).toEqual(['mem_x'])
    expect(occurrences(text, MEMORY_QUOTES_UNAVAILABLE)).toBe(1)
    expect(result.hits[0]!.quote).toBeUndefined()
  })

  it('记忆正文里有检索语法的字符：只拿来在内存里比重合，补找照常', async () => {
    const s = sessionOf('syntax', plain(2, { 0: { k: WORD_COUNT, mark: 'round-0' } }))
    const r = memoryOf('mem_syn', anchorAt('syntax', 1), { content: `${MEMORY} "zebra" OR NEAR(a b) * ^` })
    const { deps } = await setup({ syntax: s }, [r])
    const { result, text } = await run(deps)
    expect(text).not.toContain(MEMORY_QUOTES_UNAVAILABLE)
    expect(afterMark(quoteOf(result, 'mem_syn'))).toContain('round-0')
  })
})
