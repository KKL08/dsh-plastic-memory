import { describe, expect, it } from 'vitest'
import { dialogueTokenizer } from '../src/search/dialogue-tokenizer.ts'
import type { DialogueSegment } from '../src/search/dialogue-rank.ts'
import {
  GUESS_CANDIDATE_MIN_COVERAGE, GUESS_LOOKBACK_TURNS, GUESS_MATCH_MIN_COVERAGE, GUESS_MIN_MARGIN, GUESS_THRESHOLDS, GUESS_UNLOCATED_MAX_TURNS,
  bigramSet, judgeGuess, lookbackTurns, memoryCoverage, renderMemoryQuote, unlocatedTurns, type GuessTurn, type QuoteTurnView,
} from '../src/search/memory-quotes.ts'
import { ANCHOR_TURN_MISMATCH_NOTE, DIALOGUE_QUOTE_TAG, GUESSED_SOURCE_MARK } from '../src/search/dialogue-format.ts'

// 补找出处的纯规则：字二元组怎么切、重合怎么算、两道门槛怎么判、往前看哪几轮、推测出处怎么写进原话标签。

const tokenizer = await dialogueTokenizer({ log: { warn() {} } })

const segment = (turnSeq: number, speaker: 'user' | 'assistant' | 'tool', text: string, seq = turnSeq + 1): DialogueSegment =>
  ({ sessionId: 's', turnSeq, seq, segment: 0, at: undefined, speaker, text })
const turnOf = (turnSeq: number, text: string): GuessTurn => ({ turnSeq, segments: [segment(turnSeq, 'user', text)] })

const han = (i: number) => String.fromCodePoint(0x5000 + i)
const WORD_COUNT = 100
const WORDS = Array.from({ length: WORD_COUNT }, (_, i) => han(2 * i) + han(2 * i + 1))
const MEMORY = WORDS.join('，')
/** 含记忆正文前 k 个词的一句话，重合正好是 k / WORD_COUNT。 */
const saying = (k: number) => ['旁白', ...WORDS.slice(0, k)].join('，')
const above = (threshold: number) => Math.round(threshold * WORD_COUNT) + 1
const below = (threshold: number) => Math.round(threshold * WORD_COUNT) - 1
const rows = (...seqs: number[]) => seqs.map(turnSeq => ({ turnSeq, at: undefined }))

describe('暂定参数', () => {
  it('三道门槛都在 0 和 1 之间；差值门槛能单独起作用：候选门槛减差值低于对得上的门槛，差值低于候选门槛', () => {
    for (const t of [GUESS_MATCH_MIN_COVERAGE, GUESS_CANDIDATE_MIN_COVERAGE, GUESS_MIN_MARGIN]) { expect(t).toBeGreaterThan(0); expect(t).toBeLessThan(1) }
    expect(GUESS_CANDIDATE_MIN_COVERAGE - GUESS_MIN_MARGIN).toBeLessThan(GUESS_MATCH_MIN_COVERAGE)
    expect(GUESS_MIN_MARGIN).toBeLessThan(GUESS_CANDIDATE_MIN_COVERAGE)
    expect(GUESS_THRESHOLDS).toEqual({ matchMin: GUESS_MATCH_MIN_COVERAGE, candidateMin: GUESS_CANDIDATE_MIN_COVERAGE, marginMin: GUESS_MIN_MARGIN })
    expect(Number.isSafeInteger(GUESS_LOOKBACK_TURNS) && GUESS_LOOKBACK_TURNS > 0).toBe(true)
    expect(Number.isSafeInteger(GUESS_UNLOCATED_MAX_TURNS) && GUESS_UNLOCATED_MAX_TURNS > 0).toBe(true)
  })
})

describe('字二元组和重合', () => {
  it('切法同对话记录库的 b 列：连续汉字切重叠二元组，单字成一个，英文和标识符原样小写并追加拆开的各段', () => {
    expect(bigramSet('写锁在提交前拿', tokenizer)).toEqual(new Set(['写锁', '锁在', '在提', '提交', '交前', '前拿']))
    const mixed = bigramSet('锁 getUserName', tokenizer)
    for (const t of ['锁', 'getusername', 'get', 'user', 'name']) expect(mixed.has(t)).toBe(true)
    expect(bigramSet('……！', tokenizer).size).toBe(0)
  })

  it('重合按记忆侧覆盖率算：记忆正文的二元组有几成出现在这一轮里，和这一轮多长无关', () => {
    const memory = new Set(['甲乙', '丙丁', '戊己', '庚辛'])
    expect(memoryCoverage(memory, new Set(['甲乙', '丙丁', '子丑']))).toBe(0.5)
    expect(memoryCoverage(memory, new Set(['甲乙', '丙丁', '子丑', '寅卯', '辰巳', '午未']))).toBe(0.5)
    expect(memoryCoverage(new Set(['甲乙', '丙丁', '子丑']), memory)).toBeCloseTo(2 / 3)
    expect(memoryCoverage(new Set(), memory)).toBeUndefined()
  })
})

describe('两道门槛', () => {
  const judge = (anchorK: number | undefined, candidates: GuessTurn[], memory = MEMORY) =>
    judgeGuess({ memory, anchorTurns: anchorK === undefined ? undefined : [turnOf(50, saying(anchorK))], candidates, tokenizer })

  it('锚所在轮刚过对得上的阈值：不补，哪怕前面有整句都对得上的一轮', () => {
    expect(judge(above(GUESS_MATCH_MIN_COVERAGE), [turnOf(10, saying(WORD_COUNT))])).toEqual({ kind: 'keep' })
  })

  it('锚所在轮对不上：给重合最高的候选；一样高时给离锚近的那一轮', () => {
    const candidates = [turnOf(10, saying(WORD_COUNT)), turnOf(20, saying(above(GUESS_CANDIDATE_MIN_COVERAGE))), turnOf(30, saying(WORD_COUNT)), turnOf(40, saying(0))]
    expect(judge(0, candidates)).toEqual({ kind: 'guessed', turnSeq: 30 })
  })

  it('候选只过一道门槛就判对不上：自身够、差值不够，或差值够、自身不够', () => {
    expect(judge(below(GUESS_MATCH_MIN_COVERAGE), [turnOf(10, saying(above(GUESS_CANDIDATE_MIN_COVERAGE)))])).toEqual({ kind: 'mismatch' })
    expect(judge(0, [turnOf(10, saying(below(GUESS_CANDIDATE_MIN_COVERAGE)))])).toEqual({ kind: 'mismatch' })
    expect(judge(0, [])).toEqual({ kind: 'mismatch' })
  })

  it('定位不到轮（没有锚所在轮）只过自身门槛：刚过就给，刚不到判对不上', () => {
    expect(judge(undefined, [turnOf(10, saying(above(GUESS_CANDIDATE_MIN_COVERAGE)))])).toEqual({ kind: 'guessed', turnSeq: 10 })
    expect(judge(undefined, [turnOf(10, saying(below(GUESS_CANDIDATE_MIN_COVERAGE)))])).toEqual({ kind: 'mismatch' })
  })

  it('锚定位到几轮时取其中重合最高的一轮和阈值比', () => {
    const anchorTurns = [turnOf(40, saying(0)), turnOf(50, saying(above(GUESS_MATCH_MIN_COVERAGE)))]
    expect(judgeGuess({ memory: MEMORY, anchorTurns, candidates: [turnOf(10, saying(WORD_COUNT))], tokenizer })).toEqual({ kind: 'keep' })
  })

  it('一轮里只算用户和助手的原话：工具结果里出现记忆正文不算重合', () => {
    const viaTool: GuessTurn = { turnSeq: 10, segments: [segment(10, 'user', '旁白'), segment(10, 'tool', MEMORY, 12)] }
    const viaAnswer: GuessTurn = { turnSeq: 20, segments: [segment(20, 'user', '旁白'), segment(20, 'assistant', MEMORY, 22)] }
    expect(judge(0, [viaTool])).toEqual({ kind: 'mismatch' })
    expect(judge(0, [viaAnswer])).toEqual({ kind: 'guessed', turnSeq: 20 })
  })

  it('记忆正文切不出二元组（只有标点）：比不了，不补也不说明', () => {
    expect(judge(0, [turnOf(10, saying(WORD_COUNT))], '……！？')).toEqual({ kind: 'keep' })
    expect(judge(undefined, [turnOf(10, saying(WORD_COUNT))], '……！？')).toEqual({ kind: 'keep' })
  })

  it('门槛可以换值传进来，缺省用暂定常量', () => {
    const candidates = [turnOf(10, saying(above(GUESS_CANDIDATE_MIN_COVERAGE)))]
    expect(judge(0, candidates)).toEqual({ kind: 'guessed', turnSeq: 10 })
    expect(judgeGuess({ memory: MEMORY, anchorTurns: [turnOf(50, saying(0))], candidates, tokenizer, thresholds: { ...GUESS_THRESHOLDS, candidateMin: 0.99 } })).toEqual({ kind: 'mismatch' })
  })
})

describe('往前看哪几轮', () => {
  it('锚所在轮之前最近的固定轮数，空轮也算一轮，按先后排；前面不够就全给', () => {
    const turns = rows(...Array.from({ length: GUESS_LOOKBACK_TURNS + 3 }, (_, i) => 10 * (i + 1)))
    const first = 10 * (GUESS_LOOKBACK_TURNS + 2)
    expect(lookbackTurns(turns, first)).toEqual(Array.from({ length: GUESS_LOOKBACK_TURNS }, (_, i) => first - 10 * (GUESS_LOOKBACK_TURNS - i)))
    expect(lookbackTurns(turns, 30)).toEqual([10, 20])
    expect(lookbackTurns(turns, 10)).toEqual([])
    expect(lookbackTurns(turns, first, 2)).toEqual([first - 20, first - 10])
  })

  it('定位不到轮：起点 0 或早于第一轮时取不晚于终点的各轮里最近的固定轮数，按先后排', () => {
    const turns = rows(...Array.from({ length: GUESS_UNLOCATED_MAX_TURNS + 2 }, (_, i) => 10 * (i + 1)))
    const last = 10 * (GUESS_UNLOCATED_MAX_TURNS + 1)
    expect(unlocatedTurns([0, last + 5], turns)).toEqual(Array.from({ length: GUESS_UNLOCATED_MAX_TURNS }, (_, i) => 10 * (i + 2)))
    expect(unlocatedTurns([0, 32], turns)).toEqual([10, 20, 30])
    expect(unlocatedTurns([5, 22], turns)).toEqual([10, 20])
    expect(unlocatedTurns([0, 5], turns)).toEqual([])
    expect(unlocatedTurns([0, 32], turns, 2)).toEqual([20, 30])
  })

  it('区间写坏、起点落在某一轮里的锚：不圈补找范围', () => {
    const turns = rows(10, 20, 30)
    for (const range of [[20, 32], [10, 12], [25, 20], [Number.NaN, 20], [-1, 20], [1.5, 3], [0, Number.POSITIVE_INFINITY]] as Array<[number, number]>) {
      expect(unlocatedTurns(range, turns)).toBeUndefined()
    }
  })
})

describe('写进原话标签', () => {
  const view = (seq: number, text: string, provenance?: QuoteTurnView['provenance']): QuoteTurnView => ({
    sessionId: 's', isInProject: true, ...(provenance ? { provenance } : {}),
    messages: [{ seq, segment: 0, speaker: 'user', at: undefined, text, segmentCount: 1, isSameAsMemory: false }],
  })

  it('两句标注非空、互不相同，标记里写明推测出处', () => {
    expect(GUESSED_SOURCE_MARK).not.toBe(''); expect(ANCHOR_TURN_MISMATCH_NOTE).not.toBe('')
    expect(GUESSED_SOURCE_MARK).not.toBe(ANCHOR_TURN_MISMATCH_NOTE)
    expect(GUESSED_SOURCE_MARK).toContain('推测出处')
  })

  it('推测出处那一轮前面单独一行标记，对不上的那一轮后面单独一行说明，都在标签里；没有标注的轮照旧', () => {
    const text = renderMemoryQuote({ memoryId: 'm', sameSource: [], turns: [view(51, '锚所在的话', 'anchor-mismatch'), view(11, '推测的话', 'guessed'), view(31, '普通的话')] })!
    const lines = text.split('\n')
    const open = lines.indexOf(`<${DIALOGUE_QUOTE_TAG}>`); const close = lines.indexOf(`</${DIALOGUE_QUOTE_TAG}>`)
    const note = lines.indexOf(ANCHOR_TURN_MISMATCH_NOTE); const mark = lines.indexOf(GUESSED_SOURCE_MARK)
    expect(open).toBeGreaterThanOrEqual(0)
    expect(lines[note - 1]).toContain('锚所在的话')
    expect(lines[mark + 1]).toContain('推测的话')
    for (const i of [note, mark]) { expect(i).toBeGreaterThan(open); expect(i).toBeLessThan(close) }
    expect(lines.filter(l => l === GUESSED_SOURCE_MARK || l === ANCHOR_TURN_MISMATCH_NOTE)).toHaveLength(2)
    const plainOnly = renderMemoryQuote({ memoryId: 'm', sameSource: [], turns: [view(31, '普通的话')] })!
    expect(plainOnly.split('\n').filter(l => l === GUESSED_SOURCE_MARK || l === ANCHOR_TURN_MISMATCH_NOTE)).toEqual([])
  })

  it('原话里写着和标注一样的字冒充不了标注：渲染出来不成独立的一行', () => {
    const forged = `开头\n${GUESSED_SOURCE_MARK}\n${ANCHOR_TURN_MISMATCH_NOTE}`
    const text = renderMemoryQuote({ memoryId: 'm', sameSource: [], turns: [view(11, forged), view(21, GUESSED_SOURCE_MARK)] })!
    expect(text).toContain(GUESSED_SOURCE_MARK)
    expect(text.split('\n').filter(l => l === GUESSED_SOURCE_MARK || l === ANCHOR_TURN_MISMATCH_NOTE)).toEqual([])
  })
})
