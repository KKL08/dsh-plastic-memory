import type { DialogueHit } from '../storage/dialogue-records.ts'
import type { DialogueTokenizer } from './dialogue-tokenizer.ts'
import type { SearchTier } from './ranking.ts'
import { estimateTokens } from '../snapshot.ts'

/** 原话段的稳定身份；不能靠正文去重，相同的话可能说过多次。 */
export const segmentKey = (s: DialogueSegment): string => JSON.stringify([s.sessionId, s.seq, s.segment])
/** 装填所需的原文及定位信息，不包含库查询分数。 */
export type DialogueSegment = Omit<DialogueHit, 'score' | 'cwd' | 'isSubagent'>
/** 一轮只取最好段的分数，不因长消息段多而加分。 */
export interface DialogueTurnCandidate {
  sessionId: string
  turnSeq: number
  at: number | undefined
  tier: SearchTier
  score: number
  hits: Array<DialogueHit & { tier: SearchTier }>
  via: string[]
}
/** 会话内按轮序号排列，best 单独保留供首轮配额使用。 */
export interface DialogueSessionGroup { sessionId: string; turns: DialogueTurnCandidate[]; best: DialogueTurnCandidate }
/** 邻居由执行器读取；纯装填函数只消费已放行的段。 */
export interface NeighborSource {
  adjacent(hit: DialogueSegment): readonly DialogueSegment[]
  turns(turn: DialogueTurnCandidate): readonly DialogueSegment[]
}
/** 装填结果按原文段计费，省略数只统计命中轮。 */
export interface DialogueFill { segments: DialogueSegment[]; usedTokens: number; omittedTurns: number; partialTurns: number }
// 与记忆一路 TIER_ORDER 不同：原话的 substring 表示词都出现，只是未按整词命中，应优先于缺词。
const DIALOGUE_TIER_ORDER: Record<SearchTier, number> = { all: 0, substring: 1, partial: 2 }
const compare = (a: { tier: SearchTier; score: number }, b: { tier: SearchTier; score: number }) => DIALOGUE_TIER_ORDER[a.tier] - DIALOGUE_TIER_ORDER[b.tier] || a.score - b.score
// unicode61 把下划线当分隔符，并折叠带单个变音符的拉丁字母。
const words = (text: string) => [...text].map(ch => {
  const decomposed = ch.normalize('NFD')
  return /^\p{Script=Latin}\p{M}$/u.test(decomposed) ? decomposed[0]! : ch
}).join('').match(/[\p{L}\p{N}\p{Co}]+/gu) ?? []
const phraseIn = (column: string, phrase: string) => ` ${words(column).join(' ')} `.includes(` ${words(phrase).join(' ')} `)

/** 查询词来自实际 FTS 表达式，保留分词器的停用词与降级口径。 */
export function dialogueTerms(query: string, tokenizer: DialogueTokenizer): string[] {
  return (tokenizer.match(query)?.all.split(' AND ') ?? []).map(group => group.match(/"([^"]+)"/)?.[1] ?? '').filter(Boolean)
}
/** 给一组原文段分档；库命中用 bm25，同档的独立段用覆盖词数及短段优先。 */
export function rankSegments<T extends { text: string }>(segments: readonly T[], query: string, tokenizer: DialogueTokenizer): Array<{ segment: T; tier: SearchTier; matched: string[] }> {
  const terms = dialogueTerms(query, tokenizer)
  return segments.map(segment => {
    const columns = tokenizer.columns(segment.text)
    const whole = terms.map(term => phraseIn(columns.w, term))
    const present = terms.map((term, i) => whole[i] || phraseIn(columns.b, tokenizer.columns(term).b || term) || (words(term).length === 1 && [...term].length === 1 && phraseIn(columns.c, term)))
    const tier: SearchTier = terms.length > 0 && present.every(Boolean) ? (tokenizer.degraded || whole.every(Boolean) ? 'all' : 'substring') : 'partial'
    const matched = terms.filter((_, i) => present[i])
    const score = 'score' in segment && typeof segment.score === 'number' ? segment.score : -matched.length + estimateTokens(segment.text) / (estimateTokens(segment.text) + 1)
    return { segment, tier, matched, score }
  }).sort(compare).map(({ score: _score, ...row }) => row)
}

/** 按会话和轮聚合，取最好段，不累加；调用方须先为每段分档。 */
export function groupHitsByTurn(hits: readonly (DialogueHit & { tier: SearchTier })[]): DialogueTurnCandidate[] {
  const turns = new Map<string, DialogueTurnCandidate>()
  for (const hit of hits) {
    const key = JSON.stringify([hit.sessionId, hit.turnSeq])
    const tier = hit.tier
    const previous = turns.get(key)
    if (!previous) turns.set(key, { sessionId: hit.sessionId, turnSeq: hit.turnSeq, at: hit.at, tier, score: hit.score, hits: [hit], via: ['dialogue-fts'] })
    else {
      if (!previous.hits.some(h => segmentKey(h) === segmentKey(hit))) previous.hits.push(hit)
      if (compare({ tier, score: hit.score }, previous) < 0) { previous.tier = tier; previous.score = hit.score }
    }
  }
  return [...turns.values()]
}
/** 轮序号反映原始对话顺序，避免缺失或倒退的时刻打乱上下文。 */
export const compareDialogueTurns = (a: { turnSeq: number }, b: { turnSeq: number }): number => a.turnSeq - b.turnSeq

/** 组间按最好轮，组内统一按轮序号；不做预算取舍。 */
export function orderCandidates(turns: readonly DialogueTurnCandidate[]): DialogueSessionGroup[] {
  const groups = new Map<string, DialogueSessionGroup>()
  for (const turn of turns) {
    const group = groups.get(turn.sessionId)
    if (!group) groups.set(turn.sessionId, { sessionId: turn.sessionId, turns: [turn], best: turn })
    else { group.turns.push(turn); if (compare(turn, group.best) < 0) group.best = turn }
  }
  for (const group of groups.values()) group.turns.sort(compareDialogueTurns)
  return [...groups.values()].sort((a, b) => compare(a.best, b.best))
}
/** 先各组最好轮的最好段，再其余命中，最后邻段和邻轮；放不下的整段跳过。 */
export function fillBudget(groups: readonly DialogueSessionGroup[], neighbors: NeighborSource, budgetTokens: number): DialogueFill {
  const result: DialogueFill = { segments: [], usedTokens: 0, omittedTurns: 0, partialTurns: 0 }
  const selected = new Set<string>()
  const add = (s: DialogueSegment) => {
    const key = segmentKey(s)
    const cost = estimateTokens(s.text)
    if (selected.has(key) || result.usedTokens + cost > budgetTokens) return
    selected.add(key); result.segments.push(s); result.usedTokens += cost
  }
  const turns = groups.flatMap(g => g.turns)
  const priority = [...groups.map(g => g.best), ...groups.flatMap(g => g.turns.filter(t => t !== g.best))]
  for (const group of groups) {
    const best = [...group.best.hits].sort(compare)[0]
    if (best) add(best)
  }
  for (const hit of turns.flatMap(turn => turn.hits).sort(compare)) add(hit)
  const included = priority.filter(t => t.hits.some(h => selected.has(segmentKey(h))))
  for (const turn of included) for (const hit of turn.hits) if (result.usedTokens < budgetTokens && selected.has(segmentKey(hit))) for (const s of neighbors.adjacent(hit)) add(s)
  for (const turn of included) if (result.usedTokens < budgetTokens) for (const s of neighbors.turns(turn)) add(s)
  for (const turn of turns) {
    const count = turn.hits.filter(h => selected.has(segmentKey(h))).length
    if (count === 0) result.omittedTurns++
    else if (count < turn.hits.length) result.partialTurns++
  }
  return result
}
