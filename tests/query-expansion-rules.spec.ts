import { describe, expect, it } from 'vitest'
import { fuseLanes, RRF_K } from '../src/search/dialogue-rank.ts'
import { memoryCommandSchema } from '../src/gui/contract.ts'
import {
  EXPANSION_EXCERPTS_LEAD, EXPANSION_FAILED_NOTE, EXPANSION_LANE_WEIGHT, EXPANSION_MAX_GROUPS, EXPANSION_MAX_TERMS, EXPANSION_MEMORIES_LEAD, EXPANSION_MODEL_FALLBACK_NOTE,
  EXPANSION_QUERY_LEAD, EXPANSION_SELECTION_KEY, EXPANSION_SYSTEM_PROMPT, EXPANSION_TERM_MAX_CHARS, EXPANSION_USER_MESSAGE_LEAD,
  isWeakRound, parseExpansionGroups,
} from '../src/tools/query-expansion.ts'

// 扩查的几条纯规则：第一轮弱不弱、模型回的文字怎么取词、融合时各路的权重。

describe('第一轮弱不弱', () => {
  it('一轮都没有：弱', () => {
    expect(isWeakRound([])).toBe(true)
  })
  it('只有二元组命中、部分命中：弱', () => {
    expect(isWeakRound([{ tier: 'substring' }])).toBe(true)
    expect(isWeakRound([{ tier: 'partial' }, { tier: 'substring' }])).toBe(true)
  })
  it('有一轮全命中：不弱，排在哪都算', () => {
    expect(isWeakRound([{ tier: 'all' }])).toBe(false)
    expect(isWeakRound([{ tier: 'partial' }, { tier: 'all' }])).toBe(false)
  })
})

describe('模型回的文字怎么取词', () => {
  it('一行一组，组内按空格分词', () => {
    expect(parseExpansionGroups('限流 阈值\n每秒')).toEqual(['限流 阈值', '每秒'])
  })
  it('去掉行首的列表记号，只留前几组', () => {
    expect(parseExpansionGroups('1. 限流 阈值\n- 每秒\n2、流控\n3) 令牌桶\n* 熔断')).toEqual(['限流 阈值', '每秒', '流控'])
    expect(parseExpansionGroups('• 限流')).toEqual(['限流'])
    expect(EXPANSION_MAX_GROUPS).toBe(3)
  })
  it('被组数上限截掉之前的几种记号也剥：数字加右括号、星号、圆点', () => {
    expect(parseExpansionGroups('3) 令牌桶\n* 熔断\n• 限流')).toEqual(['令牌桶', '熔断', '限流'])
  })
  it('记号后面要有空白或到行尾才剥；数字加顿号可以不带空白', () => {
    expect(parseExpansionGroups('1.5 升级')).toEqual(['1.5 升级'])
    expect(parseExpansionGroups('--timeout 设置')).toEqual(['--timeout 设置'])
    expect(parseExpansionGroups('*熔断')).toEqual(['*熔断'])
    expect(parseExpansionGroups('2)限流')).toEqual(['2)限流'])
    expect(parseExpansionGroups('•限流')).toEqual(['•限流'])
    expect(parseExpansionGroups('1、限流')).toEqual(['限流'])
    expect(parseExpansionGroups('-\n每秒')).toEqual(['每秒'])
  })
  it('逗号、顿号也当词的分隔', () => {
    expect(parseExpansionGroups('限流，阈值、每秒,上限')).toEqual(['限流 阈值 每秒 上限'])
  })
  it('组内重复的词只留一个，空行和没有词的组丢掉', () => {
    expect(parseExpansionGroups('限流 限流 阈值\n\n   \n- \n、，\n每秒')).toEqual(['限流 阈值', '每秒'])
  })
  it('每组只留前几个词', () => {
    expect(parseExpansionGroups('一 二 三 四 五 六 七')).toEqual(['一 二 三 四 五'])
    expect(EXPANSION_MAX_TERMS).toBe(5)
  })
  it('先去重再数前几个词：重复的词不占名额', () => {
    expect(parseExpansionGroups('一 一 二 三 四 五 六')).toEqual(['一 二 三 四 五'])
  })
  it('单个词截到上限长度，按码点算', () => {
    expect(parseExpansionGroups(`${'x'.repeat(40)} 限流`)).toEqual([`${'x'.repeat(EXPANSION_TERM_MAX_CHARS)} 限流`])
    expect(parseExpansionGroups('😀'.repeat(40))).toEqual(['😀'.repeat(EXPANSION_TERM_MAX_CHARS)])
  })
  it('先截长再去重：截完一样的两个词只留一个', () => {
    const head = 'x'.repeat(EXPANSION_TERM_MAX_CHARS)
    expect(parseExpansionGroups(`${head}a ${head}b 限流`)).toEqual([`${head} 限流`])
  })
  it('代码围栏行跳过', () => {
    expect(parseExpansionGroups('```text\n限流 阈值\n```')).toEqual(['限流 阈值'])
  })
  it('什么词都没有：没有组', () => {
    expect(parseExpansionGroups('')).toEqual([])
    expect(parseExpansionGroups('```\n\n```')).toEqual([])
  })
})

describe('融合时各路的权重', () => {
  const lanes = (weight?: number) => [
    { name: 'dialogue', items: [{ id: 's1', turn: 't1', rank: 2 }] },
    { name: 'expansion-1', items: [{ id: 's2', turn: 't2', rank: 1 }], ...(weight === undefined ? {} : { weight }) },
  ]
  it('权重低的一路名次再靠前，也排在原查询那一路后面', () => {
    const fused = fuseLanes(lanes(0.5))
    expect(fused.map(f => f.turn)).toEqual(['t1', 't2'])
    expect(fused[1]!.score).toBeCloseTo(0.5 / (RRF_K + 1), 12)
    expect(fused[0]!.score).toBeCloseTo(1 / (RRF_K + 2), 12)
  })
  it('扩查路的权重：只被一组命中的轮，该组第 1 名排进原查询前 10 名，仍在原查询第 1 名之后', () => {
    const dialogue = { name: 'dialogue', items: Array.from({ length: 20 }, (_, i) => ({ id: `s${i + 1}`, turn: `t${i + 1}`, rank: i + 1 })) }
    const fused = fuseLanes([dialogue, { name: 'expansion-1', items: [{ id: 'x', turn: 'tx', rank: 1 }], weight: EXPANSION_LANE_WEIGHT }])
    const at = fused.findIndex(f => f.turn === 'tx')
    expect(fused[at]!.score).toBeCloseTo(EXPANSION_LANE_WEIGHT / (RRF_K + 1), 12)
    expect(at).toBeGreaterThan(0)
    expect(fused.map(f => f.turn).indexOf('t10')).toBeGreaterThan(at)
  })
  it('不给权重和给 1 一样', () => {
    expect(fuseLanes(lanes())).toEqual(fuseLanes(lanes(1)))
    expect(fuseLanes(lanes()).map(f => f.turn)).toEqual(['t2', 't1'])
  })
})

describe('静态文案', () => {
  it('提示、各部分开头、两句说明都非空且互不相同', () => {
    const texts = [EXPANSION_SYSTEM_PROMPT, EXPANSION_QUERY_LEAD, EXPANSION_USER_MESSAGE_LEAD, EXPANSION_EXCERPTS_LEAD, EXPANSION_MEMORIES_LEAD, EXPANSION_FAILED_NOTE, EXPANSION_MODEL_FALLBACK_NOTE]
    for (const t of texts) expect(t.trim()).not.toBe('')
    expect(new Set(texts).size).toBe(texts.length)
  })
  it('设置页能存扩查的模型选择', () => {
    const parsed = memoryCommandSchema.safeParse({ cmd: 'set-model-selection', key: EXPANSION_SELECTION_KEY, selection: { provider: 'p', model: 'm' } })
    expect(parsed.success).toBe(true)
  })
})
