import type { MemoryRecord, SourceAnchor } from '../record-schema.ts'
import { anchorTimeMatches, relocateByTime, turnOf } from '../session-log.ts'
import { maskSecretSurface } from '../secrets.ts'
import { SKIPPED_WATERMARK, type DialogueSessionState } from '../storage/dialogue-records.ts'
import { rankSegments, type DialogueSegment } from './dialogue-rank.ts'
import type { DialogueTokenizer } from './dialogue-tokenizer.ts'
import type { DialogueSpeaker } from '../contract-codes.ts'
import {
  ANCHOR_TURN_MISMATCH_NOTE, DIALOGUE_SEGMENT_GAP, GUESSED_SOURCE_MARK, SAME_AS_MEMORY_NOTE, excerptByMemoryNote, excerptNote, foldToLine, formatMessageRef, memoryQuoteStatus, messageReferenceNote,
  renderDialogueLine, sameSourceNote, wrapDialogueQuote,
} from './dialogue-format.ts'

/**
 * 记忆带原话的纯逻辑：锚换成轮、一轮里挑段、库里有没有、去重、预算装填、渲染。
 * 只吃数据，不碰库和宿主；取数、放行在执行器（tools/memory-quotes）。原话正文原样给，不遮盖、不截断。
 */

/** 只给排名前几条记忆带原话。暂定值，等评测再调。 */
export const MEMORY_QUOTE_LIMIT = 3
/** 一次检索里附在记忆下面的原话合计最多这么多 token，不占记忆条目的名额。 */
export const MEMORY_QUOTE_BUDGET_TOKENS = 1000

/** 对话记录库里一轮的边界。 */
export interface TurnRow { turnSeq: number; at: number | undefined }

/** 锚落在哪几轮；unlocated：定位不到轮。 */
export type AnchorTurns = { kind: 'turns'; turnSeqs: number[]; isRelocated: boolean } | { kind: 'unlocated' }

const isSeq = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0

/** 锚区间能不能换成轮：两端是不小于 0 的安全整数、终点不小于起点、起点不是 0（整会话兜底的锚）。 */
export function isLocatableRange([start, end]: SourceAnchor['eventRange']): boolean {
  return isSeq(start) && isSeq(end) && start > 0 && end >= start
}

/**
 * 锚换成轮：起点所属的轮（不大于它的最近一个 turn/start）到终点所属的轮，不改锚区间本身的含义。
 * 起点是 0（整会话兜底的锚）、起点在第一轮之前、区间写坏：定位不到轮。
 * 带改动性质的锚，按序号取到的时间和锚时间对不上（points 里是库里带时间的位置）时，按时间找回它那一轮，找不回就定位不到；
 * 起点在库里拿不到时间时按序号定位，跨轮的锚照样跨轮。没有改动性质的旧锚，时间是记录的更新时间，不拿来重新定位。
 */
export function resolveAnchorTurns(
  anchor: Pick<SourceAnchor, 'eventRange' | 'at' | 'change'>, turns: readonly TurnRow[], points: ReadonlyArray<{ seq: number; at: number | undefined }>,
): AnchorTurns {
  if (!isLocatableRange(anchor.eventRange)) return { kind: 'unlocated' }
  const [start, end] = anchor.eventRange
  const starts = turns.map(t => t.turnSeq)
  if (anchor.change !== undefined) {
    const timed = [...turns.map(t => ({ seq: t.turnSeq, at: t.at })), ...points].filter(p => typeof p.at === 'number').sort((a, b) => a.seq - b.seq)
    const startTime = timed.find(p => p.seq === start)?.at
    const nextTime = timed.find(p => p.seq > end)?.at
    // 起点拿不到时间：没有对不上的证据，按序号定位；时间明确对不上又按时间找不回：不退回旧序号
    if (startTime !== undefined && !anchorTimeMatches(anchor.at, startTime, nextTime)) {
      const relocated = relocateByTime({ at: anchor.at }, turns.map(t => ({ type: 'turn/start', seq: t.turnSeq, ...(t.at === undefined ? {} : { time: t.at }) })))
      if (relocated === null) return { kind: 'unlocated' }
      if (relocated !== start) return { kind: 'turns', turnSeqs: [relocated], isRelocated: true }
    }
  }
  const first = turnOf(start, starts)
  const last = turnOf(end, starts)
  if (first === null || last === null) return { kind: 'unlocated' }
  return { kind: 'turns', turnSeqs: starts.slice(first, last + 1), isRelocated: false }
}

/** 一轮里给哪几段的打分来源：按相关度排好，标出哪些对上了。现在只有关键词一种。 */
export type SegmentRanker = (segments: readonly DialogueSegment[]) => ReadonlyArray<{ segment: DialogueSegment; isMatched: boolean }>

/** 关键词打分：复用原话检索的段排序，对上至少一个词算对上。 */
export function keywordRanker(query: string, tokenizer: DialogueTokenizer): SegmentRanker {
  return segments => rankSegments(segments, query, tokenizer).map(r => ({ segment: r.segment, isMatched: r.matched.length > 0 }))
}

/** 打分来源按先后试，第一个有对上的给排第一的那段。 */
function bestOf(segments: readonly DialogueSegment[], rankers: readonly SegmentRanker[]): DialogueSegment | undefined {
  for (const ranker of rankers) {
    const hit = ranker(segments).find(r => r.isMatched)
    if (hit) return hit.segment
  }
  return undefined
}

/** 附在记忆下面的一段原话：库里的一行整段给，不在段内截。segment 是它在这条消息里的段序号，segmentCount 是这条消息共几段。 */
export interface QuotedMessage { seq: number; segment: number; speaker: DialogueSpeaker; at: number | undefined; text: string; segmentCount: number }

const messageOf = (segment: DialogueSegment, all: readonly DialogueSegment[], speaker: 'user' | 'assistant'): QuotedMessage => {
  const count = all.filter(s => s.seq === segment.seq).length
  return { seq: segment.seq, segment: segment.segment, speaker, at: segment.at, text: segment.text, segmentCount: count }
}

/**
 * 一问一答：开这一轮的用户消息（没切的整条，切过的给最相关的一段）加一段助手正文
 * （在这一轮全部助手段里给最相关的；一段都对不上时给最后一条助手正文的第一段）。按序号排。
 */
export function pickTurnMessages(segments: readonly DialogueSegment[], rankers: readonly SegmentRanker[]): QuotedMessage[] {
  const picked: QuotedMessage[] = []
  const users = segments.filter(s => s.speaker === 'user')
  if (users.length > 0) {
    const opener = Math.min(...users.map(s => s.seq))
    const rows = users.filter(s => s.seq === opener)
    picked.push(messageOf((rows.length > 1 ? bestOf(rows, rankers) : undefined) ?? rows[0]!, users, 'user'))
  }
  const answers = segments.filter(s => s.speaker === 'assistant')
  if (answers.length > 0) {
    const lastSeq = Math.max(...answers.map(s => s.seq))
    const fallback = answers.find(s => s.seq === lastSeq)!
    picked.push(messageOf(bestOf(answers, rankers) ?? fallback, answers, 'assistant'))
  }
  return picked.sort((a, b) => a.seq - b.seq)
}

/** 跨几轮的锚：最相关的段所在的轮先给，一段都对不上的轮按先后排在后面。只看用户和助手的段，和附出去的原话一致。 */
export function orderTurnsByRelevance<T extends { turnSeq: number; segments: readonly DialogueSegment[] }>(turns: readonly T[], rankers: readonly SegmentRanker[]): T[] {
  const chronological = [...turns].sort((a, b) => a.turnSeq - b.turnSeq)
  const all = chronological.flatMap(t => t.segments).filter(s => s.speaker === 'user' || s.speaker === 'assistant')
  for (const ranker of rankers) {
    const order: number[] = []
    for (const r of ranker(all)) if (r.isMatched && !order.includes(r.segment.turnSeq)) order.push(r.segment.turnSeq)
    if (order.length === 0) continue
    const rank = (t: T) => { const i = order.indexOf(t.turnSeq); return i < 0 ? order.length : i }
    return chronological.map((t, i) => ({ t, i })).sort((a, b) => rank(a.t) - rank(b.t) || a.i - b.i).map(x => x.t)
  }
  return chronological
}

const comparable = (text: string) => text.normalize('NFKC').toLowerCase().replace(/\s+/g, '')

/**
 * 一条消息和记忆正文相同：NFKC、小写、去掉空白和换行之后完全一样才算，空的不算。
 * 标点、数字、比较符号都留着比：差一个小数点或「不」字就是不同的话，原话要照常给。
 * 记忆这次只给了节选时 memory 传 undefined：没给全的正文不拿来比，一律不算相同。
 */
export function isSameAsMemory(message: string, memory: string | undefined): boolean {
  const a = comparable(message)
  return memory !== undefined && a !== '' && a === comparable(memory)
}

/** 判断收没收录时，库和对账给的事实。isQueued：这个会话在待建队列里；isOutOfScope：上次对账时它在会话清单里、但不在收录范围。 */
export interface QuoteLibraryFacts { isRebuilding: boolean; isQueued: boolean; isOutOfScope: boolean }

/**
 * 锚所在的会话在库里收到没有。covered：水位过了要的位置；pending：还在整理；not-collected：不收这个会话。
 * 没有收录只认三种证据：行标了移出库、也不在待建队列里；记了整个不收（分不清哪些消息是它自己的）；
 * 库里没有它的行、上次对账时它就不在收录范围、也没在队里。新开的会话在下次对账前两样都不沾，按还在整理。
 * 其余还一条没收到的（这次没读到日志、还没有自己的事件）都按还在整理。库在重建时，读的那一代下不了没有收录的结论（移出、跳过两种），按还在整理。
 */
export function quoteCoverage(session: DialogueSessionState | undefined, library: QuoteLibraryFacts, needSeq: number): 'covered' | 'pending' | 'not-collected' {
  if (session === undefined) return library.isOutOfScope && !library.isQueued ? 'not-collected' : 'pending'
  if (session.isRemoved) return library.isRebuilding || library.isQueued ? 'pending' : 'not-collected'
  if (session.watermark >= needSeq) return 'covered'
  return session.watermark === SKIPPED_WATERMARK && !library.isRebuilding ? 'not-collected' : 'pending'
}

/** 去重按轮：会话 + 这一轮 turn/start 的序号。 */
export function quoteTurnKey(sessionId: string, turnSeq: number): string {
  return JSON.stringify([sessionId, turnSeq])
}

/** 认领一轮：第一次出现归 owner；已经有主的指回原主，不改。 */
export function claimTurn(claims: Map<string, number>, key: string, owner: number): { kind: 'new' } | { kind: 'same'; owner: number } {
  const previous = claims.get(key)
  if (previous !== undefined) return { kind: 'same', owner: previous }
  claims.set(key, owner)
  return { kind: 'new' }
}

/** 一条记忆可以带的轮，按给的先后（最新的锚在前）；cost 是这一轮要给的原话正文的 token 数。 */
export interface MemoryQuotePlan { turns: ReadonlyArray<{ key: string; cost: number }> }
/** 装填结果：附原话（turn 是 plan 里的下标），或指回已经附了这一轮的记忆（owner 是记忆的下标）。 */
export type QuoteItem = { kind: 'quote'; turn: number } | { kind: 'same-source'; owner: number }

/**
 * 预算装填，plans 按记忆排名。先按排名给每条记忆带它的第一轮，哪条放不下就停：排在它后面的都不带（从排名靠后的开始不带）；
 * 再按排名给带上了的记忆加其余各轮（新到旧），放不下的跳过。别的记忆已经附过的轮不再附、不占预算。
 * 一条原话都没带上的记忆，才写「出处同」指向排在它前面、附了那一轮的记忆。
 */
export function fillMemoryQuotes(plans: readonly MemoryQuotePlan[], budgetTokens: number): QuoteItem[][] {
  const items: QuoteItem[][] = plans.map(() => [])
  const claims = new Map<string, number>()
  let used = 0
  const offer = (i: number, turn: number, mustFit: boolean): boolean => {
    const { key, cost } = plans[i]!.turns[turn]!
    const owner = claims.get(key)
    if (owner !== undefined) {
      if (owner < i && !items[i]!.some(x => x.kind === 'same-source' && x.owner === owner)) items[i]!.push({ kind: 'same-source', owner })
      return true
    }
    if (used + cost > budgetTokens) return !mustFit
    claimTurn(claims, key, i)
    used += cost
    items[i]!.push({ kind: 'quote', turn })
    return true
  }
  let reached = plans.length
  for (const [i, plan] of plans.entries()) {
    if (plan.turns.length > 0 && !offer(i, 0, true)) { reached = i; break }
  }
  for (let i = 0; i < reached; i++) for (let turn = 1; turn < plans[i]!.turns.length; turn++) offer(i, turn, false)
  return items.map(list => list.some(x => x.kind === 'quote') ? list.filter(x => x.kind === 'quote') : list)
}

/** 「出处同」里怎么称呼一条记忆：名称折成一行；名称里有密钥（遮盖后变了）只写 id。 */
export function memoryLabelOf(record: Pick<MemoryRecord, 'id' | 'name' | 'content' | 'summary' | 'tags'>): string {
  return maskSecretSurface(record).name === record.name ? foldToLine(record.name) : record.id
}

/**
 * 渲染用的一轮。isInProject：出处会话在当前项目里，消息引用用得上。messages 是这一轮给出的各段，同一条消息的几段渲染时拼成一条。
 * provenance：guessed 是查询时补找给的推测出处；anchor-mismatch 是锚所在轮和记忆正文对不上、这条记忆下面又没给出推测出处。缺省是锚所在的轮，照常渲染。
 */
export interface QuoteTurnView {
  sessionId: string
  isInProject: boolean
  messages: ReadonlyArray<QuotedMessage & { isSameAsMemory: boolean }>
  provenance?: 'guessed' | 'anchor-mismatch'
}

// 查询时补找出处：锚所在轮和记忆正文比字二元组重合，对不上时在同一会话往前找最相关的一轮。三处用同一把尺子（记忆侧覆盖率）。
// 下面五个数都是暂定值，等中文原话评测集复核。
/** 锚所在轮和记忆正文「对得上」的最低重合。 */
export const GUESS_MATCH_MIN_COVERAGE = 0.3
/** 候选轮自身的重合至少这么多才给推测出处。 */
export const GUESS_CANDIDATE_MIN_COVERAGE = 0.4
/** 候选轮的重合至少比锚所在轮高这么多才给推测出处（「明显好于」）。 */
export const GUESS_MIN_MARGIN = 0.15
/** 锚所在轮往前看几轮：轮次边界表里开始序号更小的最近几轮，没有原话的空轮也算一轮。 */
export const GUESS_LOOKBACK_TURNS = 5
/** 定位不到轮的锚：只看锚覆盖到的轮里最近的这么多轮。 */
export const GUESS_UNLOCATED_MAX_TURNS = 20

/** 补找的三道门槛；缺省用上面的常量，评测脚本换值对照时传。 */
export interface GuessThresholds { matchMin: number; candidateMin: number; marginMin: number }
export const GUESS_THRESHOLDS: GuessThresholds = { matchMin: GUESS_MATCH_MIN_COVERAGE, candidateMin: GUESS_CANDIDATE_MIN_COVERAGE, marginMin: GUESS_MIN_MARGIN }

/** 一段文字的字二元组集合：切法同对话记录库分词的 b 列（columns(text).b 按空格拆开）。 */
export function bigramSet(text: string, tokenizer: Pick<DialogueTokenizer, 'columns'>): Set<string> {
  return new Set(tokenizer.columns(text).b.split(' ').filter(word => word !== ''))
}

/** 记忆侧覆盖率 |M∩T| / |M|，M 是记忆正文的字二元组集合，T 是一轮原话的。M 为空（记忆正文切不出二元组）时返回 undefined。 */
export function memoryCoverage(memory: ReadonlySet<string>, turn: ReadonlySet<string>): number | undefined {
  if (memory.size === 0) return undefined
  let shared = 0
  for (const word of memory) if (turn.has(word)) shared++
  return shared / memory.size
}

/** 拿来比的一轮：库里这一轮的段，只看用户和助手的段（和附出去的原话一致），工具结果不算。 */
export interface GuessTurn { turnSeq: number; segments: readonly DialogueSegment[] }

/** 补找的结论。keep：不补、不说明；guessed：给这一轮当推测出处；mismatch：锚所在轮对不上，候选也没过两道门槛。 */
export type GuessVerdict = { kind: 'keep' } | { kind: 'guessed'; turnSeq: number } | { kind: 'mismatch' }

/**
 * 判断要不要补推测出处。memory 是记忆正文。
 * anchorTurns 是锚定位到的轮（取各轮重合的最大值作锚所在轮的重合）；不低于 matchMin 就是对得上：keep。
 * 对不上时在 candidates 里取重合最高的一轮（并列取开始序号大的），重合不低于 candidateMin、且比锚所在轮至少高 marginMin 才给，否则 mismatch。
 * anchorTurns 为 undefined 是定位不到轮：没有锚所在轮可比，只过 candidateMin 一道。
 * 记忆正文切不出二元组：比不了，keep。
 */
export function judgeGuess(input: {
  memory: string
  anchorTurns: readonly GuessTurn[] | undefined
  candidates: readonly GuessTurn[]
  tokenizer: Pick<DialogueTokenizer, 'columns'>
  thresholds?: GuessThresholds
}): GuessVerdict {
  const memory = bigramSet(input.memory, input.tokenizer)
  if (memory.size === 0) return { kind: 'keep' }
  const thresholds = input.thresholds ?? GUESS_THRESHOLDS
  const coverage = (turn: GuessTurn) => memoryCoverage(memory, bigramSet(
    turn.segments.filter(s => s.speaker === 'user' || s.speaker === 'assistant').map(s => s.text).join(' '), input.tokenizer,
  ))!
  const anchorCoverage = input.anchorTurns === undefined ? undefined : Math.max(0, ...input.anchorTurns.map(coverage))
  if (anchorCoverage !== undefined && anchorCoverage >= thresholds.matchMin) return { kind: 'keep' }
  let best: { turnSeq: number; coverage: number } | undefined
  for (const turn of input.candidates) {
    const score = coverage(turn)
    if (best === undefined || score > best.coverage || (score === best.coverage && turn.turnSeq > best.turnSeq)) {
      best = { turnSeq: turn.turnSeq, coverage: score }
    }
  }
  // 覆盖率相减会有浮点舍入误差，容许一个机器精度以保留恰好等于门槛的结果。
  if (best !== undefined && best.coverage >= thresholds.candidateMin
    && (anchorCoverage === undefined || best.coverage - anchorCoverage + Number.EPSILON >= thresholds.marginMin)) {
    return { kind: 'guessed', turnSeq: best.turnSeq }
  }
  return { kind: 'mismatch' }
}

/** 往前补找的候选：轮次边界表里开始序号小于 firstTurnSeq 的最近 count 轮（空轮也算），按先后排。 */
export function lookbackTurns(turns: readonly TurnRow[], firstTurnSeq: number, count: number = GUESS_LOOKBACK_TURNS): number[] {
  if (count <= 0) return []
  return turns.filter(t => t.turnSeq < firstTurnSeq).slice(-count).map(t => t.turnSeq)
}

/**
 * 定位不到轮的锚覆盖到的轮：区间两端是不小于 0 的安全整数、终点不小于起点，且起点是 0（整会话兜底）或早于第一轮时，
 * 取开始序号不大于终点的各轮里最近的 count 轮，按先后排（可能为空）。
 * 其余返回 undefined、不补找：区间写坏，或起点落在某一轮里、只是按时间找不回那一轮（序号已经对不上，按序号圈的范围不可信）。
 */
export function unlocatedTurns(range: SourceAnchor['eventRange'], turns: readonly TurnRow[], count: number = GUESS_UNLOCATED_MAX_TURNS): number[] | undefined {
  const [start, end] = range
  if (!isSeq(start) || !isSeq(end) || end < start) return undefined
  if (start !== 0 && turns.length > 0 && start >= turns[0]!.turnSeq) return undefined
  if (count <= 0) return []
  return turns.filter(t => t.turnSeq <= end).slice(-count).map(t => t.turnSeq)
}

/** 按原文顺序把各段归到各自的消息下。 */
function groupBySeq<T extends { seq: number; segment: number }>(parts: readonly T[]): T[][] {
  const sorted = [...parts].sort((a, b) => a.seq - b.seq || a.segment - b.segment)
  const groups: T[][] = []
  for (const part of sorted) {
    const last = groups.at(-1)
    if (last !== undefined && last[0]!.seq === part.seq) last.push(part)
    else groups.push([part])
  }
  return groups
}

/**
 * 附在一条记忆下面的文字：「出处同」各一行、状态说明一行，原话包进标签（几轮之间空一行）。没有可写的返回 undefined。
 * 同一条消息给了几段时拼成一条，不相邻的段之间加缺段标记；和记忆正文相同的段从略。没给全的消息标节选，从略的段也一样：模型要知道还有其余段。
 * 本项目的会话：整条给的带引用，节选的带节选说明（引用写在说明里）；别的项目的会话不带引用，节选说明改成传记忆 id 回查。
 */
export function renderMemoryQuote(input: { memoryId: string; turns: readonly QuoteTurnView[]; sameSource: readonly string[]; status?: string }): string | undefined {
  const lines = input.sameSource.map(sameSourceNote)
  if (input.status !== undefined) lines.push(memoryQuoteStatus(input.status))
  const body = input.turns.map(turn => {
    const body = groupBySeq(turn.messages).map(parts => {
      const m = parts[0]!
      const text = parts.map((p, i) => (i > 0 && p.segment !== parts[i - 1]!.segment + 1 ? DIALOGUE_SEGMENT_GAP : '') + (p.isSameAsMemory ? SAME_AS_MEMORY_NOTE : p.text)).join('')
      const line = renderDialogueLine({ speaker: m.speaker, at: m.at, text })
      const isExcerpt = parts.length < m.segmentCount
      if (!turn.isInProject) return line + (isExcerpt ? excerptByMemoryNote(m.segmentCount, input.memoryId) : '')
      const ref = formatMessageRef({ sessionId: turn.sessionId, seq: m.seq })
      return line + (isExcerpt ? excerptNote(m.segmentCount, ref) : messageReferenceNote(ref))
    }).join('\n')
    if (body === '') return body
    if (turn.provenance === 'guessed') return GUESSED_SOURCE_MARK + '\n' + body
    if (turn.provenance === 'anchor-mismatch') return body + '\n' + ANCHOR_TURN_MISMATCH_NOTE
    return body
  }).filter(t => t !== '').join('\n\n')
  if (body !== '') lines.push(wrapDialogueQuote(body))
  return lines.length === 0 ? undefined : lines.join('\n')
}
