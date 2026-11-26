import type { DialogueHit } from '../storage/dialogue-records.ts'
import type { DialogueTokenizer } from './dialogue-tokenizer.ts'
import type { SearchTier } from './ranking.ts'
import { estimateTokens } from '../snapshot.ts'

/** 原话段的稳定身份；不能靠正文去重，相同的话可能说过多次。 */
export const segmentKey = (s: Pick<DialogueSegment, 'sessionId' | 'seq' | 'segment'>): string => JSON.stringify([s.sessionId, s.seq, s.segment])
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
  /** 融合后的名次（0 起）：有它时排序按它，不再比档位和分数。 */
  rank?: number
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
// 与 dialogueTerms 按同样的 AND 边界切组，保留短语所属列，避免把二元组短语当作整词命中。
function dialogueTermForms(query: string, tokenizer: DialogueTokenizer) {
  return (tokenizer.match(query)?.all.split(' AND ') ?? []).map(group =>
    [...group.matchAll(/([wbc]) : "([^"]+)"/g)].map(match => ({ column: match[1]!, phrase: match[2]! })))
}

/** 给一组原文段分档；库命中用 bm25，同档的独立段用覆盖词数及短段优先。 */
export function rankSegments<T extends { text: string }>(segments: readonly T[], query: string, tokenizer: DialogueTokenizer): Array<{ segment: T; tier: SearchTier; matched: string[] }> {
  const terms = dialogueTerms(query, tokenizer)
  const groups = dialogueTermForms(query, tokenizer)
  return segments.map(segment => {
    const columns = tokenizer.columns(segment.text)
    // 单字组只有 c 列一项，它在 w 列里单独成词同样算整词命中；b 列的二元组短语不拿来比 w 列
    const whole = groups.map(forms => forms.some(({ column, phrase }) => column !== 'b' && phraseIn(columns.w, phrase)))
    const present = groups.map((forms, i) => whole[i] || forms.some(({ column, phrase }) => (column === 'b' && phraseIn(columns.b, phrase)) || (column === 'c' && words(phrase).length === 1 && [...phrase].length === 1 && phraseIn(columns.c, phrase))))
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

/** 两轮谁在前：都有融合名次时按名次，否则按档位和分数。 */
export const compareTurns = (a: DialogueTurnCandidate, b: DialogueTurnCandidate) => a.rank !== undefined && b.rank !== undefined ? a.rank - b.rank : compare(a, b)

/** 组间按最好轮，组内统一按轮序号；不做预算取舍。 */
export function orderCandidates(turns: readonly DialogueTurnCandidate[]): DialogueSessionGroup[] {
  const groups = new Map<string, DialogueSessionGroup>()
  for (const turn of turns) {
    const group = groups.get(turn.sessionId)
    if (!group) groups.set(turn.sessionId, { sessionId: turn.sessionId, turns: [turn], best: turn })
    else { group.turns.push(turn); if (compareTurns(turn, group.best) < 0) group.best = turn }
  }
  for (const group of groups.values()) group.turns.sort(compareDialogueTurns)
  return [...groups.values()].sort((a, b) => compareTurns(a.best, b.best))
}

/** 融合的参数 k：名次差在头部影响大、往后变平。 */
export const RRF_K = 60
/**
 * 融合的一路：每个候选给稳定身份、所属的轮、这一路里的名次（1 起，可以并列）。原始分数留在各路内部。
 * weight：这一路的 1/(k+名次) 乘的系数，缺省 1；扩查的各路比原查询低。
 */
export interface FusionLane { name: string; items: ReadonlyArray<{ id: string; turn: string; rank: number }>; weight?: number }
/** 融合结果的一轮：合并后的分数，和来自哪几路的哪些候选（按各自的名次）。 */
export interface FusedTurn { turn: string; score: number; sources: Array<{ lane: string; id: string }> }

/**
 * 多路按名次合并（RRF）：每一路里一轮取它最好的候选的名次，各路的 weight/(k+名次) 相加（weight 缺省 1），不比原始分数；名次用候选给的值，并列的同分。
 * pinned 指定一路的前几轮固定在最前、按那一路的顺序，其余按合并分数排；分数相同时先出现的在前。
 */
export function fuseLanes(lanes: readonly FusionLane[], pinned?: { lane: string; count: number }): FusedTurn[] {
  const fused = new Map<string, FusedTurn & { order: number }>()
  const laneOrders = new Map<string, string[]>()
  for (const lane of lanes) {
    const best = new Map<string, number>()
    for (const item of lane.items) if (!best.has(item.turn) || item.rank < best.get(item.turn)!) best.set(item.turn, item.rank)
    const order = [...best.entries()].sort((a, b) => a[1] - b[1])
    laneOrders.set(lane.name, order.map(([turn]) => turn))
    for (const [turn, rank] of order) {
      let entry = fused.get(turn)
      if (!entry) fused.set(turn, entry = { turn, score: 0, sources: [], order: fused.size })
      entry.score += (lane.weight ?? 1) / (RRF_K + rank)
    }
  }
  const ranked = [...fused.values()].sort((a, b) => b.score - a.score || a.order - b.order)
  for (const entry of ranked) {
    const items = lanes.flatMap(lane => lane.items.filter(item => item.turn === entry.turn).map(item => ({ lane: lane.name, id: item.id, rank: item.rank })))
    entry.sources = items.sort((a, b) => a.rank - b.rank).map(({ lane, id }) => ({ lane, id }))
  }
  const head = pinned === undefined ? [] : (laneOrders.get(pinned.lane) ?? []).slice(0, Math.max(0, pinned.count))
  const ordered = [...head.map(turn => fused.get(turn)!), ...ranked.filter(entry => !head.includes(entry.turn))]
  return ordered.map(({ turn, score, sources }) => ({ turn, score, sources }))
}

/** 装填时别处带来的东西。 */
export interface FillContext {
  /** 别处已经给出的段：不再给、不计费。 */
  given?: ReadonlySet<string>
  /** 已附在别处（记忆下面）的轮：不分组、不占首轮名额、不计入省略数；其余命中和别的命中一起按名次装，邻段照带。 */
  attached?: readonly DialogueTurnCandidate[]
  /** 一段占多少预算；缺省按原文估算。输出时从略的段按输出的长度算。 */
  costOf?(segment: DialogueSegment): number
  /**
   * 位置固定的轮（都在 groups 里）：按给的先后，各装它最好的一段（同各组首段的比法），再走每个会话保底一段和其余步骤。
   * 不给时和没有这一项逐字节一样。
   */
  pinned?: readonly DialogueTurnCandidate[]
}

/** 先各组最好轮的最好段，再其余命中，最后邻段和邻轮；放不下的整段跳过。 */
export function fillBudget(groups: readonly DialogueSessionGroup[], neighbors: NeighborSource, budgetTokens: number, context: FillContext = {}): DialogueFill {
  const result: DialogueFill = { segments: [], usedTokens: 0, omittedTurns: 0, partialTurns: 0 }
  const selected = new Set<string>(context.given)
  const attached = context.attached ?? []
  const add = (s: DialogueSegment) => {
    const key = segmentKey(s)
    const cost = context.costOf?.(s) ?? estimateTokens(s.text)
    if (selected.has(key) || result.usedTokens + cost > budgetTokens) return
    selected.add(key); result.segments.push(s); result.usedTokens += cost
  }
  const turns = groups.flatMap(g => g.turns)
  const priority = [...groups.map(g => g.best), ...groups.flatMap(g => g.turns.filter(t => t !== g.best))]
  for (const turn of context.pinned ?? []) {
    const best = [...turn.hits].sort(compare)[0]
    if (best) add(best)
  }
  for (const group of groups) {
    const best = [...group.best.hits].sort(compare)[0]
    if (best) add(best)
  }
  // 其余命中：融合过的按所属轮的融合名次、同一轮里按段分数；没融合过的先比档位再比分数
  const pool = [...turns, ...attached]
  const rankOf = new Map(pool.flatMap(t => t.hits.map(h => [segmentKey(h), t.rank] as const)))
  const byRank = (a: DialogueHit & { tier: SearchTier }, b: DialogueHit & { tier: SearchTier }) => {
    const [ra, rb] = [rankOf.get(segmentKey(a)), rankOf.get(segmentKey(b))]
    return ra !== undefined && rb !== undefined ? ra - rb || a.score - b.score : compare(a, b)
  }
  for (const hit of pool.flatMap(turn => turn.hits).sort(byRank)) add(hit)
  const included = [...priority, ...attached].filter(t => t.hits.some(h => selected.has(segmentKey(h))))
  for (const turn of included) for (const hit of turn.hits) if (result.usedTokens < budgetTokens && selected.has(segmentKey(hit))) for (const s of neighbors.adjacent(hit)) add(s)
  for (const turn of included) if (result.usedTokens < budgetTokens) for (const s of neighbors.turns(turn)) add(s)
  for (const turn of turns) {
    const count = turn.hits.filter(h => selected.has(segmentKey(h))).length
    if (count === 0) result.omittedTurns++
    else if (count < turn.hits.length) result.partialTurns++
  }
  return result
}
