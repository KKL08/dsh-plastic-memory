import { describe, expect, it } from 'vitest'
import { rankSegments, groupHitsByTurn, orderCandidates, fillBudget, fuseLanes, RRF_K } from '../src/search/dialogue-rank.ts'
import { dialogueTokenizer } from '../src/search/dialogue-tokenizer.ts'
import { estimateTokens } from '../src/snapshot.ts'
import type { DialogueHit } from '../src/storage/dialogue-records.ts'
import type { SearchTier } from '../src/search/ranking.ts'
import * as format from '../src/search/dialogue-format.ts'
const hit = (sessionId: string, turnSeq: number, text: string, score = -1, segment = 0): DialogueHit & { tier: SearchTier } => ({ tier: 'all', sessionId, turnSeq, seq: turnSeq + 1, segment, text, score, speaker: 'user', at: undefined, cwd: '/p', isSubagent: false })
it('六段按档位和相关度排列，强命中排在弱命中前', async () => {
  const tokenizer = await dialogueTokenizer()
  const rows = ['alpha', 'alpha beta', 'beta', 'other', 'alpha beta alpha', 'neither'].map(text => ({ text }))
  const ranked = rankSegments(rows, 'alpha beta', tokenizer)
  expect(ranked.map(r => r.segment.text)).toEqual(['alpha beta', 'alpha beta alpha', 'alpha', 'beta', 'other', 'neither'])
  expect(ranked[0]!.matched).toEqual(['alpha', 'beta'])
})
it('轮分数取最好段而不累加，会话分组后按轮序号排列', () => {
  const groups = orderCandidates(groupHitsByTurn([hit('a', 20, 'a', -2), hit('a', 10, 'b', -1), hit('b', 10, 'c', -3), hit('a', 20, 'd', -2, 1)]))
  expect(groups.map(g => g.sessionId)).toEqual(['b', 'a'])
  expect(groups[1]!.turns.map(t => t.turnSeq)).toEqual([10, 20])
  expect(groups[1]!.turns[1]!.score).toBe(-2)
})
it('先每个会话给一轮，跳过超长段，命中装完才装邻居并去重', () => {
  const hits = [hit('a', 10, '甲', -3), hit('a', 20, '乙', -2), hit('b', 10, '丙', -1)]
  const groups = orderCandidates(groupHitsByTurn(hits))
  const fill = fillBudget(groups, { adjacent: () => [hits[0]!, hit('a', 10, '长'.repeat(100), -1, 1)], turns: () => [hits[0]!] }, 2 * estimateTokens('甲'))
  expect(fill.segments.map(s => s.text)).toEqual(['甲', '丙'])
  expect(fill.omittedTurns).toBe(1)
  expect(fill.partialTurns).toBe(0)
})
it('装不下的段不截断，后面短段仍能装入并统计部分轮', () => {
  const groups = orderCandidates(groupHitsByTurn([hit('a', 10, '长'.repeat(100)), hit('a', 10, '短', -1, 1)]))
  const fill = fillBudget(groups, { adjacent: () => [], turns: () => [] }, 2)
  expect(fill.segments.map(s => s.text)).toEqual(['短'])
  expect(fill.partialTurns).toBe(1)
})
it('同消息邻段优先于邻轮，重叠邻居只计一次且预算不挤掉命中', () => {
  const h = hit('s', 10, '命', -2, 1)
  const before = hit('s', 10, '前', -1, 0)
  const after = hit('s', 10, '后', -1, 2)
  const neighbor = hit('s', 20, '邻')
  const groups = orderCandidates(groupHitsByTurn([h]))
  const neighbors = { adjacent: () => [before, after, before, h], turns: () => [neighbor, after] }
  expect(fillBudget(groups, neighbors, 2).segments.map(s => s.text)).toEqual(['命', '前'])
  expect(fillBudget(groups, neighbors, 4).segments.map(s => s.text)).toEqual(['命', '前', '后', '邻'])
  expect(fillBudget(groups, neighbors, 4).omittedTurns).toBe(0)
})
it('长消息三段弱命中不压过另一轮的强命中', async () => {
  const tokenizer = await dialogueTokenizer()
  const rows = [hit('weak', 0, 'alpha', -100, 0), hit('weak', 0, 'alpha', -100, 1), hit('weak', 0, 'alpha', -100, 2), hit('strong', 0, 'alpha beta', -1)]
  const groups = orderCandidates(groupHitsByTurn(rankSegments(rows, 'alpha beta', tokenizer).map(r => ({ ...r.segment, tier: r.tier }))))
  expect(groups[0]!.sessionId).toBe('strong')
})
it('会话轮次不受时间倒序影响，统一按轮序号排列', () => {
  const groups = orderCandidates(groupHitsByTurn([{ ...hit('s', 10, '晚'), at: 2000 }, { ...hit('s', 20, '早'), at: 1000 }]))
  expect(groups[0]!.turns.map(t => t.turnSeq)).toEqual([10, 20])
})
it('命中用完预算时不再读取邻居', () => {
  const groups = orderCandidates(groupHitsByTurn([hit('s', 0, '甲')]))
  const never = () => { throw new Error('预算已满不该读邻居') }
  expect(fillBudget(groups, { adjacent: never, turns: never }, estimateTokens('甲')).segments).toHaveLength(1)
})
it('中文跨词二元组命中按子串档，完整词命中排在前面', async () => {
  const tokenizer = await dialogueTokenizer()
  const result = rankSegments([{ text: '抄写锁定' }, { text: '写锁' }], '写锁', tokenizer)
  expect(result.map(r => r.tier)).toEqual(['all', 'substring'])
})

it('长消息有八个命中段时先给其他会话留出最好一段', () => {
  const hits = [...Array.from({ length: 8 }, (_, i) => hit('a', 10, '甲'.repeat(480), -10, i)), hit('b', 10, '乙'.repeat(480), -1)]
  const filled = fillBudget(orderCandidates(groupHitsByTurn(hits)), { adjacent: () => [], turns: () => [] }, 1500)
  expect(filled.segments.slice(0, 2).map(s => s.sessionId)).toEqual(['a', 'b'])
})
it('首段配额之后其余段先比档位再比分数', () => {
  const hits = [hit('a', 10, '甲', -10), { ...hit('a', 10, '乙', -100, 1), tier: 'partial' as const }, hit('b', 10, '丙', -2), hit('b', 20, '丁', -1)]
  const filled = fillBudget(orderCandidates(groupHitsByTurn(hits)), { adjacent: () => [], turns: () => [] }, 3)
  expect(filled.segments.map(s => s.text)).toEqual(['甲', '丙', '丁'])
})
it('开启邻居不会减少预算内的命中轮数', () => {
  const hits = [hit('a', 10, '甲'), hit('a', 20, '乙'), hit('b', 10, '丙')]
  const groups = orderCandidates(groupHitsByTurn(hits))
  const plain = fillBudget(groups, { adjacent: () => [], turns: () => [] }, 4)
  const expanded = fillBudget(groups, { adjacent: () => [hit('a', 10, '邻', -1, 1)], turns: () => [hit('a', 30, '邻')] }, 4)
  const matched = (rows: typeof plain.segments) => new Set(rows.filter(s => hits.some(h => h.sessionId === s.sessionId && h.seq === s.seq && h.segment === s.segment)).map(s => JSON.stringify([s.sessionId, s.turnSeq]))).size
  expect(matched(expanded.segments)).toBeGreaterThanOrEqual(matched(plain.segments))
})

it('子串提示说明关键词都出现且不判命中弱', () => {
  expect(format.DIALOGUE_SUBSTRING_FALLBACK_NOTE).toContain('关键词都出现了，但有的不是完整的词')
  expect(format.DIALOGUE_SUBSTRING_FALLBACK_NOTE).not.toContain('命中弱')
})
it('逐词计数以段为单位且候选截断时限定统计范围', () => {
  expect(format.dialogueTermHitNote([{ label: '部署', count: 2 }, { label: '写锁', count: 0 }])).toBe('各关键词命中的原话段数：部署 2 段、写锁 0 段。范围内一段都没命中的：写锁。')
  expect(format.dialogueTermHitNote([{ label: '部署', count: 2 }], true)).toBe('本次取到的候选段中，各关键词命中的原话段数：部署 2 段。')
  expect(format.dialogueTermHitNote([])).toBeUndefined()
})
it('缺口标记独占一行以区分原文连续段', () => {
  expect(format.DIALOGUE_SEGMENT_GAP).toBe('\n……\n')
})

describe('多路按名次融合', () => {
  const lane = (name: string, turns: string[]) => ({ name, items: turns.map((turn, i) => ({ id: `${name}-${i}`, turn, rank: i + 1 })) })

  it('只用名次合并（k=60）：两路都命中的轮排在只有一路命中的前面', () => {
    expect(RRF_K).toBe(60)
    const fused = fuseLanes([lane('dialogue', ['a', 'b', 'c']), lane('memory', ['c'])])
    expect(fused.map(f => f.turn)).toEqual(['c', 'a', 'b'])
    expect(fused[0]!.score).toBeCloseTo(1 / 63 + 1 / 61)
    expect(fused[0]!.sources).toEqual([{ lane: 'memory', id: 'memory-0' }, { lane: 'dialogue', id: 'dialogue-2' }])
  })

  it('一路里同一轮有几个候选：按最好的那个算一次名次，不累加', () => {
    const dialogue = { name: 'dialogue', items: [{ id: 'x0', turn: 'a', rank: 1 }, { id: 'x1', turn: 'a', rank: 2 }, { id: 'y', turn: 'b', rank: 3 }] }
    const fused = fuseLanes([dialogue])
    expect(fused.map(f => [f.turn, f.score])).toEqual([['a', 1 / 61], ['b', 1 / 63]])
  })

  it('按候选给的名次算分：并列的分数相同，名次有空缺时不往前挪', () => {
    const tied = fuseLanes([{ name: 'memory', items: [{ id: 'x', turn: 'a', rank: 1 }, { id: 'y', turn: 'b', rank: 1 }] }])
    expect(tied.map(f => f.score)).toEqual([1 / 61, 1 / 61])
    const sparse = fuseLanes([{ name: 'memory', items: [{ id: 'z', turn: 'c', rank: 10 }] }])
    expect(sparse[0]!.score).toBe(1 / 70)
  })

  it('三路以上照样合并，原始分数不参与', () => {
    const fused = fuseLanes([lane('dialogue', ['a', 'b']), lane('memory', ['b', 'c']), lane('expansion', ['c', 'b'])])
    expect(fused.map(f => f.turn)).toEqual(['b', 'c', 'a'])
    expect(fused.find(f => f.turn === 'b')!.sources.map(s => s.lane)).toEqual(['memory', 'dialogue', 'expansion'])
  })

  it('哪一路的前几名固定是参数：换固定的那一路，头部跟着变', () => {
    const lanes = [lane('dialogue', ['a', 'b', 'c']), lane('memory', ['c', 'b'])]
    expect(fuseLanes(lanes).map(f => f.turn)).toEqual(['c', 'b', 'a'])
    expect(fuseLanes(lanes, { lane: 'dialogue', count: 1 }).map(f => f.turn)).toEqual(['a', 'c', 'b'])
    expect(fuseLanes(lanes, { lane: 'memory', count: 1 }).map(f => f.turn)).toEqual(['c', 'b', 'a'])
  })
})
