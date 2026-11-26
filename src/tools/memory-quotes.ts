import { anchorsOf, type MemoryRecord, type SourceAnchor } from '../record-schema.ts'
import type { DialogueRecordStore } from '../storage/dialogue-records.ts'
import type { DialogueTokenizer } from '../search/dialogue-tokenizer.ts'
import type { DialogueSpeaker } from '../contract-codes.ts'
import type { DialogueSegment, FusionLane } from '../search/dialogue-rank.ts'
import {
  MEMORY_QUOTE_BUDGET_TOKENS, MEMORY_QUOTE_LIMIT, fillMemoryQuotes, isLocatableRange, isSameAsMemory, judgeGuess, keywordRanker, lookbackTurns, memoryLabelOf, orderTurnsByRelevance,
  pickTurnMessages, quoteCoverage, quoteTurnKey, renderMemoryQuote, resolveAnchorTurns, unlocatedTurns, type GuessTurn, type QuoteTurnView, type SegmentRanker,
} from '../search/memory-quotes.ts'
import {
  QUOTE_NOT_COLLECTED, QUOTE_NO_REVIEW, QUOTE_PENDING, QUOTE_SESSIONS_UNAVAILABLE, QUOTE_SESSION_GONE, QUOTE_UNLOCATED, TURN_NOT_INDEXED_NOTE,
  memoryQuoteStatus,
} from '../search/dialogue-format.ts'
import { estimateTokens } from '../snapshot.ts'
import type { SearchContext } from './search.ts'
import { checkAnchor, quoteReadPolicy, type SessionTable } from './session-access.ts'

/**
 * 记忆带原话的执行器：给 memory_search 排名靠前的记忆取出处那一轮的一问一答。
 * 只读对话记录库和这次检索的会话表，不读会话日志（追库在调用方，和原话检索共用）；锚取自同一次检索的候选，不再按 id 读记忆。
 */

/** 取原话要用的边界。 */
export interface MemoryQuoteDeps {
  store: Pick<DialogueRecordStore, 'state' | 'session' | 'segmentsOf' | 'turnsOf' | 'isQueued'>
  /** 这次检索的会话表，和原话检索共用。 */
  sessionTable(): Promise<SessionTable>
  tokenizer(): Promise<DialogueTokenizer>
  /** 上次对账时这个会话在会话清单里、但不在收录范围。 */
  isOutOfScope(sessionId: string): boolean
}

/** 附在一条记忆下面的内容，渲染前还能并进原话检索命中的段。turns 里每轮带去重用的键（会话 + 这一轮的开始序号）。 */
export interface MemoryQuoteBlock {
  memoryId: string
  turns: Array<{ key: string; view: QuoteTurnView }>
  sameSource: string[]
  status?: string
}

const LAST_SEQ = Number.MAX_SAFE_INTEGER

/** quotes 和传进来的候选逐条对应（只到前 MEMORY_QUOTE_LIMIT 条）；note 是整路的说明，只出一次。 */
export interface MemoryQuotes { quotes: Array<MemoryQuoteBlock | undefined>; note?: string }

/** 渲染一条记忆下面附的文字；没有可写的返回 undefined。 */
export function renderQuoteBlock(block: MemoryQuoteBlock | undefined): string | undefined {
  return block === undefined ? undefined : renderMemoryQuote({ memoryId: block.memoryId, turns: block.turns.map(t => t.view), sameSource: block.sameSource, ...(block.status !== undefined ? { status: block.status } : {}) })
}

/**
 * 原话检索命中、落在这条记忆已附的那几轮里的段，并到对应的轮下面：按原文顺序排，已经给过的段不重复。
 * memoryContent 用来判断哪段和记忆正文相同；记忆这次只给了节选时传 undefined。
 */
export function withDialogueSegments(block: MemoryQuoteBlock, segments: ReadonlyArray<DialogueSegment & { segmentCount: number }>, memoryContent: string | undefined): MemoryQuoteBlock {
  return {
    ...block,
    turns: block.turns.map(({ key, view }) => {
      const extra = segments.filter(s => quoteTurnKey(s.sessionId, s.turnSeq) === key && !view.messages.some(m => m.seq === s.seq && m.segment === s.segment))
      if (extra.length === 0) return { key, view }
      const added = extra.map(s => ({ seq: s.seq, segment: s.segment, speaker: s.speaker as DialogueSpeaker, at: s.at, text: s.text, segmentCount: s.segmentCount, isSameAsMemory: isSameAsMemory(s.text, memoryContent) }))
      return { key, view: { ...view, messages: [...view.messages, ...added].sort((a, b) => a.seq - b.seq || a.segment - b.segment) } }
    }),
  }
}

/** 融合里记忆这一路的名字。 */
export const MEMORY_LANE = 'memory'

/** 记忆一路读库要用的：这次检索读的那一代、分词器，以及这次检索放行的会话（原话一路现查会话表得出的那一份）。 */
export interface MemoryLaneReader { store: MemoryQuoteDeps['store']; gen: number; tokenizer: DialogueTokenizer; allowed: ReadonlySet<string> }

/**
 * 记忆一路投影到融合用的一路：每条记忆按名次记到它最新的锚所在的轮，锚跨几轮时取和记忆正文、查询最相关的那一轮（同带原话的挑法）。
 * 这次检索不放行的会话、锚定位不到、库里还没收到的不记，也不读库。related：每轮排名最靠前的那条记忆。
 */
export function memoryLane(
  candidates: ReadonlyArray<{ record: MemoryRecord }>, query: string, reader: MemoryLaneReader,
): { lane: FusionLane; related: Map<string, MemoryRecord> } {
  const { store, gen } = reader
  const items: Array<{ id: string; turn: string; rank: number }> = []
  const related = new Map<string, MemoryRecord>()
  for (const [i, { record }] of candidates.entries()) {
    const anchor = anchorsOf(record)[0]
    if (anchor === undefined || !isLocatableRange(anchor.eventRange) || !reader.allowed.has(anchor.sessionId)) continue
    const session = store.session(gen, anchor.sessionId)
    if (session === undefined || session.isRemoved || session.watermark < anchor.eventRange[1]) continue
    const { located, segmentsUntilNextTurn } = locateTurns(anchor, store, gen)
    if (located.kind !== 'turns') continue
    const turn = quoteTurnKey(anchor.sessionId, relevantTurns(record, query, reader.tokenizer, located.turnSeqs, segmentsUntilNextTurn).turns[0]!.turnSeq)
    items.push({ id: JSON.stringify([record.scope, record.workspacePath ?? '', record.id]), turn, rank: i + 1 })
    if (!related.has(turn)) related.set(turn, record)
  }
  return { lane: { name: MEMORY_LANE, items }, related }
}

/** 锚换成轮：库里这一会话的轮次边界，带改动性质的锚再取锚区间里的时间点；同时给出按轮取段的读法。 */
function locateTurns(anchor: SourceAnchor, store: MemoryQuoteDeps['store'], gen: number) {
  const sessionId = anchor.sessionId
  const [start, end] = anchor.eventRange
  const turnRows = store.turnsOf(gen, sessionId)
  const nextTurnAfter = (seq: number) => turnRows.find(t => t.turnSeq > seq)?.turnSeq
  const segmentsUntilNextTurn = (from: number, after: number) => store.segmentsOf(gen, sessionId, from, (nextTurnAfter(after) ?? LAST_SEQ) - 1)
  // 判断时间对不对得上要用锚起点和锚区间之后的位置；只有带改动性质且起点能落在轮内的锚才判
  const points = anchor.change !== undefined && isLocatableRange(anchor.eventRange) && turnRows.length > 0 && start >= turnRows[0]!.turnSeq ? segmentsUntilNextTurn(start, end).map(s => ({ seq: s.seq, at: s.at })) : []
  return { located: resolveAnchorTurns(anchor, turnRows, points), segmentsUntilNextTurn, turnRows }
}

/** 锚定位到的几轮按和记忆正文、这次查询的相关程度排：带原话附哪几轮、记忆一路记到哪一轮都按这个顺序。 */
function relevantTurns(
  record: MemoryRecord, query: string, tokenizer: DialogueTokenizer, turnSeqs: readonly number[], segmentsUntilNextTurn: (from: number, after: number) => DialogueSegment[],
) {
  const rankers: SegmentRanker[] = [keywordRanker(`${record.content} ${query}`, tokenizer)]
  return { rankers, turns: orderTurnsByRelevance(turnSeqs.map(turnSeq => ({ turnSeq, segments: segmentsUntilNextTurn(turnSeq, turnSeq) })), rankers) }
}

/** 装填后按轮键核对：推测出处没给出时，在这组锚装填后仍留下的首轮补说明。 */
interface AnchorMismatch { anchorKeys: string[]; guessedKey?: string }

/** 一个锚取到的结果：几轮原话，或一句说明；skip 是不该给这条记忆附任何东西（不属于当前项目的记忆）。 */
type AnchorOutcome =
  | { kind: 'turns'; turns: Array<{ key: string; cost: number; view: QuoteTurnView }>; mismatch?: AnchorMismatch }
  | { kind: 'status'; note: string }
  | { kind: 'skip' }

/**
 * 给候选里排名靠前的记忆取出处原话。query 是这次检索的查询，和记忆正文一起用来在一轮里挑段。
 * isExcerpt：这条记忆这次只给了节选，不拿它的正文判哪段原话和它相同。
 * readGen：原话要和别处已经取好的段对得上时传那些段所在的一代（融合时是原话检索读的那一代）；库没了或已经切到别的一代，这次不附原话。
 */
export async function quoteMemories(
  candidates: ReadonlyArray<{ record: MemoryRecord; isExcerpt?: boolean }>, query: string, context: SearchContext, deps: MemoryQuoteDeps, readGen?: number,
): Promise<MemoryQuotes> {
  const top = candidates.slice(0, MEMORY_QUOTE_LIMIT)
  const anchors = top.map(c => anchorsOf(c.record))
  if (anchors.every(list => list.length === 0)) return { quotes: [] }
  const [table, tokenizer] = await Promise.all([deps.sessionTable(), deps.tokenizer()])
  if (!table.isComplete) return { quotes: [], note: memoryQuoteStatus(QUOTE_SESSIONS_UNAVAILABLE) }
  // 从读库状态到取完所有段都不让出：等待期间可能删库或切代，读到的状态要和取段对得上
  const state = deps.store.state()
  // 等待期间切了代：两代的段号对不上，按段去重会失效
  if (readGen !== undefined && (state.status === 'none' || state.read.gen !== readGen)) return { quotes: [], note: memoryQuoteStatus(QUOTE_PENDING) }
  const read = state.status === 'none' ? undefined : { gen: state.read.gen, isRebuilding: state.status === 'rebuilding' }
  const reader: Reader = { table, read, tokenizer }
  const plans: Array<Array<{ key: string; cost: number; view: QuoteTurnView }>> = []
  const statuses: Array<string | undefined> = []
  const mismatches: AnchorMismatch[][] = []
  for (const [i, { record, isExcerpt }] of top.entries()) {
    const turns: Array<{ key: string; cost: number; view: QuoteTurnView }> = []
    const checks: AnchorMismatch[] = []
    let status: string | undefined
    for (const anchor of anchors[i]!) {
      const outcome = quoteAnchor(record, isExcerpt === true, anchor, query, context, deps, reader)
      if (outcome.kind === 'turns') {
        if (outcome.mismatch !== undefined) checks.push(outcome.mismatch)
        for (const t of outcome.turns) {
          const existing = turns.find(x => x.key === t.key)
          if (existing === undefined) turns.push(t)
          // 同一轮有实际记录的锚时，出处以实际记录为准，与锚的遍历顺序无关。
          else if (existing.view.provenance === 'guessed' && t.view.provenance === undefined) existing.view = t.view
        }
      } else if (outcome.kind === 'status') status ??= outcome.note
    }
    mismatches.push(checks)
    plans.push(turns)
    statuses.push(status)
  }
  const items = fillMemoryQuotes(plans.map(turns => ({ turns })), MEMORY_QUOTE_BUDGET_TOKENS)
  return {
    quotes: items.map((list, i) => {
      const turns = list.flatMap(item => item.kind === 'quote' ? [{ key: plans[i]![item.turn]!.key, view: plans[i]![item.turn]!.view }] : [])
      for (const check of mismatches[i]!) {
        if (check.guessedKey !== undefined && turns.some(t => t.key === check.guessedKey)) continue
        const first = check.anchorKeys.map(key => turns.find(t => t.key === key)).find(t => t !== undefined)
        if (first !== undefined) first.view = { ...first.view, provenance: 'anchor-mismatch' }
      }
      return {
        memoryId: top[i]!.record.id,
        turns,
        sameSource: list.flatMap(item => item.kind === 'same-source' ? [memoryLabelOf(top[item.owner]!.record)] : []),
        ...(plans[i]!.length === 0 && statuses[i] !== undefined ? { status: statuses[i] } : {}),
      }
    }),
  }
}

interface Reader {
  table: SessionTable
  read: { gen: number; isRebuilding: boolean } | undefined
  tokenizer: DialogueTokenizer
}

/** 一个锚：放行 → 库里有没有 → 换成轮 → 每轮挑一问一答。 */
function quoteAnchor(record: MemoryRecord, isExcerpt: boolean, anchor: SourceAnchor, query: string, context: SearchContext, deps: MemoryQuoteDeps, reader: Reader): AnchorOutcome {
  const status = (note: string): AnchorOutcome => ({ kind: 'status', note })
  const checked = checkAnchor(record, anchor.sessionId, context)
  if (!checked.ok) return checked.kind === 'rejected' ? status(checked.reason) : { kind: 'skip' }
  const policy = quoteReadPolicy(checked.anchor, reader.table)
  if (!policy.ok) return status(policy.kind === 'gone' ? QUOTE_SESSION_GONE : policy.kind === 'no-review' ? QUOTE_NO_REVIEW : QUOTE_SESSIONS_UNAVAILABLE)
  // 区间写坏：先回定位不到，不去判收录、不读段
  if (!isLocatableRange(anchor.eventRange) && unlocatedTurns(anchor.eventRange, []) === undefined) return status(QUOTE_UNLOCATED)
  const { read } = reader
  const sessionId = anchor.sessionId
  const end = anchor.eventRange[1]
  const coverage = read === undefined ? 'pending' : quoteCoverage(deps.store.session(read.gen, sessionId), {
    isRebuilding: read.isRebuilding, isQueued: deps.store.isQueued(read.gen, sessionId), isOutOfScope: deps.isOutOfScope(sessionId),
  }, end)
  if (coverage === 'pending') return status(QUOTE_PENDING)
  if (coverage === 'not-collected') return status(QUOTE_NOT_COLLECTED)
  const { located, segmentsUntilNextTurn, turnRows } = locateTurns(anchor, deps.store, read!.gen)
  const isInProject = context.workspacePath !== undefined && reader.table.get(sessionId)?.workspacePath === context.workspacePath
  const readTurns = (seqs: readonly number[]) => seqs.map(turnSeq => ({ turnSeq, segments: segmentsUntilNextTurn(turnSeq, turnSeq) }))
  const ranked = located.kind === 'turns'
    ? relevantTurns(record, query, reader.tokenizer, located.turnSeqs, segmentsUntilNextTurn)
    : { rankers: [keywordRanker(`${record.content} ${query}`, reader.tokenizer)], turns: [] }
  const quote = (turn: GuessTurn, provenance?: 'guessed') => {
    const messages = pickTurnMessages(turn.segments, ranked.rankers).map(m => ({ ...m, isSameAsMemory: isSameAsMemory(m.text, isExcerpt ? undefined : record.content) }))
    if (messages.length === 0) return []
    const cost = messages.reduce((n, m) => n + (m.isSameAsMemory ? 0 : estimateTokens(m.text)), 0)
    return [{ key: quoteTurnKey(sessionId, turn.turnSeq), cost, view: { sessionId, isInProject, messages, ...(provenance === undefined ? {} : { provenance }) } }]
  }
  if (located.kind === 'unlocated') {
    const scope = unlocatedTurns(anchor.eventRange, turnRows)
    if (scope === undefined || scope.length === 0) return status(QUOTE_UNLOCATED)
    if (judgeGuess({ memory: record.content, anchorTurns: undefined, candidates: [], tokenizer: reader.tokenizer }).kind === 'keep') return status(QUOTE_UNLOCATED)
    const candidates = readTurns(scope)
    const verdict = judgeGuess({ memory: record.content, anchorTurns: undefined, candidates, tokenizer: reader.tokenizer })
    if (verdict.kind !== 'guessed') return status(QUOTE_UNLOCATED)
    const quoted = quote(candidates.find(t => t.turnSeq === verdict.turnSeq)!, 'guessed')
    return quoted.length === 0 ? status(QUOTE_UNLOCATED) : { kind: 'turns', turns: quoted }
  }
  const quoted = ranked.turns.flatMap(turn => quote(turn))
  // 锚所在的轮都还没有可展示的内容：如实说，不落到上一轮去
  if (quoted.length === 0) return status(TURN_NOT_INDEXED_NOTE)
  if (judgeGuess({ memory: record.content, anchorTurns: ranked.turns, candidates: [], tokenizer: reader.tokenizer }).kind === 'keep') return { kind: 'turns', turns: quoted }
  const candidates = readTurns(lookbackTurns(turnRows, Math.min(...located.turnSeqs)))
  const verdict = judgeGuess({ memory: record.content, anchorTurns: ranked.turns, candidates, tokenizer: reader.tokenizer })
  const mismatch: AnchorMismatch = { anchorKeys: quoted.map(t => t.key) }
  if (verdict.kind === 'guessed') {
    mismatch.guessedKey = quoteTurnKey(sessionId, verdict.turnSeq)
    quoted.push(...quote(candidates.find(t => t.turnSeq === verdict.turnSeq)!, 'guessed'))
  }
  return { kind: 'turns', turns: quoted, mismatch }
}
