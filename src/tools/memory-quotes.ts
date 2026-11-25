import { anchorsOf, type MemoryRecord, type SourceAnchor } from '../record-schema.ts'
import type { DialogueRecordStore } from '../storage/dialogue-records.ts'
import type { DialogueTokenizer } from '../search/dialogue-tokenizer.ts'
import {
  MEMORY_QUOTE_BUDGET_TOKENS, MEMORY_QUOTE_LIMIT, fillMemoryQuotes, isLocatableRange, isSameAsMemory, keywordRanker, memoryLabelOf, orderTurnsByRelevance,
  pickTurnMessages, quoteCoverage, quoteTurnKey, renderMemoryQuote, resolveAnchorTurns, type QuoteTurnView, type SegmentRanker,
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
  store: Pick<DialogueRecordStore, 'state' | 'session' | 'segmentsOf' | 'turnsOf'>
  /** 这次检索的会话表，和原话检索共用。 */
  sessionTable(): Promise<SessionTable>
  tokenizer(): Promise<DialogueTokenizer>
}

/** quotes 和传进来的候选逐条对应（只到前 MEMORY_QUOTE_LIMIT 条）；note 是整路的说明，只出一次。 */
export interface MemoryQuotes { quotes: Array<string | undefined>; note?: string }

/** 一个锚取到的结果：几轮原话，或一句说明；skip 是不该给这条记忆附任何东西（不属于当前项目的记忆）。 */
type AnchorOutcome =
  | { kind: 'turns'; turns: Array<{ key: string; cost: number; view: QuoteTurnView }> }
  | { kind: 'status'; note: string }
  | { kind: 'skip' }

const LAST_SEQ = Number.MAX_SAFE_INTEGER

/** 给候选里排名靠前的记忆取出处原话。query 是这次检索的查询，和记忆正文一起用来在一轮里挑段。 */
export async function quoteMemories(
  candidates: ReadonlyArray<{ record: MemoryRecord }>, query: string, context: SearchContext, deps: MemoryQuoteDeps,
): Promise<MemoryQuotes> {
  const top = candidates.slice(0, MEMORY_QUOTE_LIMIT)
  const anchors = top.map(c => anchorsOf(c.record))
  if (anchors.every(list => list.length === 0)) return { quotes: [] }
  const [table, tokenizer] = await Promise.all([deps.sessionTable(), deps.tokenizer()])
  if (!table.isComplete) return { quotes: [], note: memoryQuoteStatus(QUOTE_SESSIONS_UNAVAILABLE) }
  // 从读库状态到取完所有段都不让出：等待期间可能删库或切代，读到的状态要和取段对得上
  const state = deps.store.state()
  const read = state.status === 'none' ? undefined : { gen: state.read.gen, isRebuilding: state.status === 'rebuilding' }
  const reader: Reader = { table, read, tokenizer }
  const plans: Array<Array<{ key: string; cost: number; view: QuoteTurnView }>> = []
  const statuses: Array<string | undefined> = []
  for (const [i, { record }] of top.entries()) {
    const turns: Array<{ key: string; cost: number; view: QuoteTurnView }> = []
    let status: string | undefined
    for (const anchor of anchors[i]!) {
      const outcome = quoteAnchor(record, anchor, query, context, deps, reader)
      if (outcome.kind === 'turns') {
        for (const t of outcome.turns) if (!turns.some(x => x.key === t.key)) turns.push(t)
      } else if (outcome.kind === 'status') status ??= outcome.note
    }
    plans.push(turns)
    statuses.push(status)
  }
  const items = fillMemoryQuotes(plans.map(turns => ({ turns })), MEMORY_QUOTE_BUDGET_TOKENS)
  return {
    quotes: items.map((list, i) => renderMemoryQuote({
      memoryId: top[i]!.record.id,
      turns: list.flatMap(item => item.kind === 'quote' ? [plans[i]![item.turn]!.view] : []),
      sameSource: list.flatMap(item => item.kind === 'same-source' ? [memoryLabelOf(top[item.owner]!.record)] : []),
      ...(plans[i]!.length === 0 && statuses[i] !== undefined ? { status: statuses[i] } : {}),
    })),
  }
}

interface Reader {
  table: SessionTable
  read: { gen: number; isRebuilding: boolean } | undefined
  tokenizer: DialogueTokenizer
}

/** 一个锚：放行 → 库里有没有 → 换成轮 → 每轮挑一问一答。 */
function quoteAnchor(record: MemoryRecord, anchor: SourceAnchor, query: string, context: SearchContext, deps: MemoryQuoteDeps, reader: Reader): AnchorOutcome {
  const status = (note: string): AnchorOutcome => ({ kind: 'status', note })
  const checked = checkAnchor(record, anchor.sessionId, context)
  if (!checked.ok) return checked.kind === 'rejected' ? status(checked.reason) : { kind: 'skip' }
  const policy = quoteReadPolicy(checked.anchor, reader.table)
  if (!policy.ok) return status(policy.kind === 'gone' ? QUOTE_SESSION_GONE : policy.kind === 'no-review' ? QUOTE_NO_REVIEW : QUOTE_SESSIONS_UNAVAILABLE)
  // 区间写坏、整会话兜底的锚：先回定位不到，不去判收录、不读段
  if (!isLocatableRange(anchor.eventRange)) return status(QUOTE_UNLOCATED)
  const { read } = reader
  const sessionId = anchor.sessionId
  const [start, end] = anchor.eventRange
  const coverage = read === undefined ? 'pending'
    : quoteCoverage(deps.store.session(read.gen, sessionId), { isRebuilding: read.isRebuilding }, end)
  if (coverage === 'pending') return status(QUOTE_PENDING)
  if (coverage === 'not-collected') return status(QUOTE_NOT_COLLECTED)
  const gen = read!.gen
  const turnRows = deps.store.turnsOf(gen, sessionId)
  const nextTurnAfter = (seq: number) => turnRows.find(t => t.turnSeq > seq)?.turnSeq
  const segmentsUntilNextTurn = (from: number, after: number) => deps.store.segmentsOf(gen, sessionId, from, (nextTurnAfter(after) ?? LAST_SEQ) - 1)
  // 判断时间对不对得上要用锚起点和锚区间之后的位置；只有带改动性质的锚才判
  const points = anchor.change !== undefined ? segmentsUntilNextTurn(start, end).map(s => ({ seq: s.seq, at: s.at })) : []
  const located = resolveAnchorTurns(anchor, turnRows, points)
  if (located.kind === 'unlocated') return status(QUOTE_UNLOCATED)
  const rankers: SegmentRanker[] = [keywordRanker(`${record.content} ${query}`, reader.tokenizer)]
  const turns = orderTurnsByRelevance(located.turnSeqs.map(turnSeq => ({ turnSeq, segments: segmentsUntilNextTurn(turnSeq, turnSeq) })), rankers)
  const isInProject = context.workspacePath !== undefined && reader.table.get(sessionId)?.workspacePath === context.workspacePath
  const quoted = turns.flatMap(turn => {
    const messages = pickTurnMessages(turn.segments, rankers).map(m => ({ ...m, isSameAsMemory: isSameAsMemory(m.text, record.content) }))
    if (messages.length === 0) return []
    const cost = messages.reduce((n, m) => n + (m.isSameAsMemory ? 0 : estimateTokens(m.text)), 0)
    return [{ key: quoteTurnKey(sessionId, turn.turnSeq), cost, view: { sessionId, isInProject, messages } }]
  })
  // 锚所在的轮都还没有可展示的内容：如实说，不落到上一轮去
  return quoted.length === 0 ? status(TURN_NOT_INDEXED_NOTE) : { kind: 'turns', turns: quoted }
}
