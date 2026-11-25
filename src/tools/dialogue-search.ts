import type { DialogueRecordStore } from '../storage/dialogue-records.ts'
import type { DialogueTokenizer } from '../search/dialogue-tokenizer.ts'
import { DIALOGUE_BM25_WEIGHTS } from '../search/dialogue-tokenizer.ts'
import { rankSegments, groupHitsByTurn, orderCandidates, fillBudget, segmentKey, dialogueTerms, compareDialogueTurns } from '../search/dialogue-rank.ts'
import type { DialogueSegment, DialogueFill } from '../search/dialogue-rank.ts'
import { groupQueryTerms, judgeTopHit, termHitCounts, type TermHitCount } from '../search/coverage.ts'
import { dialogueBudgetOf, dialogueNote, coverageNote, omittedNote, excerptNote, formatMessageRef, messageReferenceNote, renderDialogueLine, wrapDialogueQuote, dialogueSessionHeading, DIALOGUE_OR_FALLBACK_NOTE, DIALOGUE_LOW_COVERAGE_NOTE, DIALOGUE_SUBSTRING_FALLBACK_NOTE, dialogueTermHitNote, DIALOGUE_SEGMENT_GAP, DIALOGUE_SESSIONS_UNAVAILABLE, DIALOGUE_NO_HIT, DIALOGUE_COVERAGE_PENDING } from '../search/dialogue-format.ts'
import type { DialogueSpeaker } from '../contract-codes.ts'
import type { SearchContext } from './search.ts'
import type { HostSession, HostSessionEntry } from './host-session.ts'
import { sessionTable, sessionReadPolicy, type SessionTable } from './session-access.ts'
import { CATCHUP_FOCUS_BUDGET_MS, CATCHUP_QUEUE_BUDGET_MS } from './dialogue-catchup.ts'
import type { DialogueCatchup, DialogueReadiness } from './dialogue-catchup.ts'

/** 原话检索和附原话合计最多占两秒，从检索开始算；到点丢弃结果，不拖累记忆一路。 */
export const DIALOGUE_PATH_BUDGET_MS = 2000
/** 原话执行器的边界，配置均在每次请求时读取。 */
export interface DialogueSearchDeps {
  store: Pick<DialogueRecordStore, 'state' | 'search' | 'segmentsOf' | 'turnsOf' | 'session'>
  catchup: Pick<DialogueCatchup, 'beforeSearch'>
  host: Pick<HostSession, 'listSessions' | 'sessionTitleOf'>
  noReview: { sessionIds(): Promise<Set<string>> }
  workspaceOf(cwd: string | undefined): Promise<string | undefined>
  tokenizer(): Promise<DialogueTokenizer>
  hasBackgroundTimer?(): boolean
  budget?(): number
  includeTools?(): boolean
  /** 异步读取回来后复核开关，避免已关闭的原话仍被返回。 */
  isEnabled?(): boolean
  /** 同一次检索里共用的会话表；缺省每次现查。 */
  sessions?(): Promise<ListedSessions>
}
/** 现查的会话表，连同宿主列出的会话清单。 */
export interface ListedSessions { table: SessionTable; entries: HostSessionEntry[] }
/** 一条输出消息保留原文段数，渲染时判定完整还是节选。 */
export interface DialogueMessage { seq: number; speaker: DialogueSpeaker; at: number | undefined; text: string; segmentCount: number; givenSegments: number; ref: string }
/** 会话、轮、消息三级结构；说明与引用正文分开。 */
export interface DialogueSearchResult {
  kind: 'ready' | 'off' | 'unavailable'
  notes: string[]
  groups: Array<{ sessionId: string; title?: string; turns: Array<{ turnSeq: number; at: number | undefined; messages: DialogueMessage[] }> }>
  fill?: DialogueFill
  diagnostics?: { kind: 'or' | 'low' | 'substring'; counts: TermHitCount[]; isLimited: boolean }
}
/** 一路失败不污染别路；既检查墙钟，也让未结束的异步读取在预算到期后让出。 */
export async function runPath<T>(name: string, fn: () => Promise<T>, budgetMs: number, now: () => number): Promise<{ ok: true; value: T } | { ok: false; name: string }> {
  const start = now()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(name)), budgetMs) })
    const value = await Promise.race([fn(), timeout])
    return now() - start > budgetMs ? { ok: false, name } : { ok: true, value }
  } catch { return { ok: false, name } }
  finally { clearTimeout(timer) }
}
function isVisibleSegment(segment: DialogueSegment, includeTools: boolean): boolean {
  return includeTools || segment.speaker !== 'tool'
}

/** 现查一次会话表，留下宿主列出的清单。 */
export async function listSessionTable(deps: Pick<DialogueSearchDeps, 'host' | 'noReview' | 'workspaceOf'>): Promise<ListedSessions> {
  let entries: HostSessionEntry[] = []
  const table = await sessionTable({ listSessions: async () => { const listed = await deps.host.listSessions(); entries = listed ?? []; return listed } }, deps.noReview, deps.workspaceOf)
  return { table, entries }
}

async function allowedSessions(context: SearchContext, deps: DialogueSearchDeps): Promise<string[] | undefined> {
  const { table, entries } = await (deps.sessions?.() ?? listSessionTable(deps))
  return table.isComplete ? entries.filter(e => sessionReadPolicy(table, e.id, context).ok).map(e => e.id) : undefined
}

/** 检索前追库：当前会话先追，没有后台计时器时顺带推进待建队列。原话检索和附原话走同一个入口。 */
export function catchUpFor(context: SearchContext, deps: Pick<DialogueSearchDeps, 'catchup' | 'hasBackgroundTimer'>): Promise<DialogueReadiness> {
  const handle = context.session.handle as { header?: { cwd?: string } } | undefined
  const cwd = handle?.header === undefined ? context.workspacePath : handle.header.cwd
  return deps.catchup.beforeSearch({ sessionId: context.session.id, cwd, isSubagent: context.delegation !== undefined }, CATCHUP_FOCUS_BUDGET_MS, deps.hasBackgroundTimer?.() ? 0 : CATCHUP_QUEUE_BUDGET_MS)
}

/** 一次检索里原话检索和附原话共用追库和会话表：各只做一次，先到的那路发起。 */
export function shareDialogueReads(deps: DialogueSearchDeps): DialogueSearchDeps {
  let readiness: Promise<DialogueReadiness> | undefined
  let sessions: Promise<ListedSessions> | undefined
  return {
    ...deps,
    catchup: { beforeSearch: (...args) => readiness ??= deps.catchup.beforeSearch(...args) },
    sessions: () => sessions ??= deps.sessions?.() ?? listSessionTable(deps),
  }
}

function queryAndRank(query: string, tokenizer: DialogueTokenizer, store: DialogueSearchDeps['store'], gen: number, sessionIds: string[], includeTools: boolean) {
  const match = tokenizer.match(query)
  const opts = { limit: 60, weights: DIALOGUE_BM25_WEIGHTS, sessionIds, speakers: includeTools ? ['user', 'assistant', 'tool'] : ['user', 'assistant'] }
  const all = match ? store.search(gen, match.all, opts) : []
  const any = match && match.all !== match.any && new Set(all.map(h => JSON.stringify([h.sessionId, h.turnSeq]))).size < 3 ? store.search(gen, match.any, opts) : []
  const seen = new Set<string>()
  const hits = [...all, ...any].filter(h => { const key = segmentKey(h); if (seen.has(key)) return false; seen.add(key); return true }).slice(0, 60)
  const ranked = rankSegments(hits, query, tokenizer)
  const terms = dialogueTerms(query, tokenizer)
  const termGroups = groupQueryTerms(query, terms, text => dialogueTerms(text, tokenizer))
  const tokenHits = ranked.map(row => terms.map(term => row.matched.includes(term)))
  let diagnostics: DialogueSearchResult['diagnostics']
  if (ranked.length > 0 && !ranked.some(r => r.tier === 'all')) {
    const verdict = judgeTopHit(termGroups, terms, tokenHits[0]!)
    diagnostics = { kind: ranked[0]!.tier === 'substring' ? 'substring' : verdict.weak ? 'low' : 'or', counts: verdict.missingKeywords.length > 0 ? termHitCounts(termGroups, terms, tokenHits) : [], isLimited: hits.length === 60 }
  }
  return { hits, ranked, diagnostics }
}

function assembleOutput(
  groups: ReturnType<typeof orderCandidates>, fill: DialogueFill,
  turnTables: Map<string, ReturnType<DialogueSearchDeps['store']['turnsOf']>>,
  messageOf: (segment: DialogueSegment) => DialogueSegment[],
): DialogueSearchResult['groups'] {
  const output: DialogueSearchResult['groups'] = []
  for (const group of groups) {
    const selected = fill.segments.filter(s => s.sessionId === group.sessionId)
    if (selected.length === 0) continue
    const turns = [...new Set(selected.map(s => s.turnSeq))].map(turnSeq => {
      const rows = selected.filter(s => s.turnSeq === turnSeq).sort((a, b) => a.seq - b.seq || a.segment - b.segment)
      const outputMessages = [...new Set(rows.map(s => s.seq))].map(seq => {
        const parts = rows.filter(s => s.seq === seq)
        const first = parts[0]!
        return { seq, speaker: first.speaker as DialogueSpeaker, at: first.at, text: parts.map((s, i) => (i > 0 && s.segment !== parts[i - 1]!.segment + 1 ? DIALOGUE_SEGMENT_GAP : '') + s.text).join(''), segmentCount: messageOf(first).length, givenSegments: parts.length, ref: formatMessageRef(first) }
      })
      return { turnSeq, at: turnTables.get(group.sessionId)?.find(t => t.turnSeq === turnSeq)?.at, messages: outputMessages }
    }).sort(compareDialogueTurns)
    output.push({ sessionId: group.sessionId, turns })
  }
  return output
}

/** 追水位、放行、查库、排序、装填；不从日志取正文，也不改写原文。 */
export async function searchDialogue(args: { query: string }, context: SearchContext, deps: DialogueSearchDeps): Promise<DialogueSearchResult> {
  const readiness = await catchUpFor(context, deps)
  if (readiness.kind === 'off') return { kind: 'off', notes: [], groups: [] }
  if (readiness.kind === 'unavailable') return { kind: 'unavailable', notes: [], groups: [] }
  const tokenizer = await deps.tokenizer()
  const sessionIds = await allowedSessions(context, deps)
  if (!sessionIds) return { kind: 'unavailable', notes: [DIALOGUE_SESSIONS_UNAVAILABLE], groups: [] }
  if (deps.isEnabled?.() === false) return { kind: 'off', notes: [], groups: [] }
  // 异步等待期间可能删库或切代；复核之后到全部取段结束都不让出。
  const current = deps.store.state()
  if (current.status === 'none') return { kind: 'unavailable', notes: [], groups: [] }
  const gen = current.read.gen
  const notes: string[] = []
  const isComplete = current.status === 'ready' && readiness.isCaughtUp && readiness.coverage.queued === 0 && gen === readiness.gen
  if (current.status !== 'ready') notes.push(dialogueNote('dialogue-index-building', readiness.coverage.sessions))
  if (!isComplete) notes.push(readiness.coverage.coveredUntil === undefined ? DIALOGUE_COVERAGE_PENDING : coverageNote(readiness.coverage.coveredUntil))
  if (tokenizer.degraded) notes.push(dialogueNote('dialogue-tokenizer-basic'))
  const includeTools = deps.includeTools?.() ?? false
  const { hits, ranked, diagnostics } = queryAndRank(args.query, tokenizer, deps.store, gen, sessionIds, includeTools)
  const turnTables = new Map<string, ReturnType<DialogueSearchDeps['store']['turnsOf']>>()
  for (const hit of hits) if (!turnTables.has(hit.sessionId)) turnTables.set(hit.sessionId, deps.store.turnsOf(gen, hit.sessionId))
  const candidates = groupHitsByTurn(ranked.map(r => ({ ...r.segment, tier: r.tier })))
  for (const turn of candidates) turn.at = turnTables.get(turn.sessionId)?.find(t => t.turnSeq === turn.turnSeq)?.at
  const groups = orderCandidates(candidates)
  const messages = new Map<string, DialogueSegment[]>()
  const messageOf = (s: DialogueSegment) => {
    const key = JSON.stringify([s.sessionId, s.seq])
    let rows = messages.get(key)
    if (!rows) { rows = deps.store.segmentsOf(gen, s.sessionId, s.seq, s.seq).filter(s => isVisibleSegment(s, includeTools)); messages.set(key, rows) }
    return rows
  }
  const fill = fillBudget(groups, {
    adjacent: s => messageOf(s).filter(row => Math.abs(row.segment - s.segment) === 1),
    turns: t => {
      const turns = turnTables.get(t.sessionId)!
      const index = turns.findIndex(row => row.turnSeq === t.turnSeq)
      if (index < 0) return []
      return [index - 1, index + 1].flatMap(i => {
        const turn = turns[i]
        return !turn ? [] : deps.store.segmentsOf(gen, t.sessionId, turn.turnSeq, (turns[i + 1]?.turnSeq ?? Number.MAX_SAFE_INTEGER) - 1).filter(s => isVisibleSegment(s, includeTools))
      })
    },
  }, dialogueBudgetOf(deps.budget?.() ?? NaN))
  const omitted = omittedNote(fill.omittedTurns, fill.partialTurns)
  if (omitted) notes.push(omitted)
  if (hits.length === 0 && isComplete) notes.push(DIALOGUE_NO_HIT)
  const output = assembleOutput(groups, fill, turnTables, messageOf)
  await Promise.all(output.map(async group => { group.title = await deps.host.sessionTitleOf(group.sessionId) }))
  if (deps.isEnabled?.() === false) return { kind: 'off', notes: [], groups: [] }
  return { kind: 'ready', notes, groups: output, fill, diagnostics }
}
/** 说明全部先出，原话只包一次；消息内只在缺段处添加省略标记。 */
export function renderDialogueSearch(result: DialogueSearchResult): string {
  const notes = [...result.notes]
  if (result.diagnostics) {
    const { kind, counts, isLimited } = result.diagnostics
    const hints = { or: DIALOGUE_OR_FALLBACK_NOTE, low: DIALOGUE_LOW_COVERAGE_NOTE, substring: DIALOGUE_SUBSTRING_FALLBACK_NOTE }
    notes.push(hints[kind])
    const termNote = dialogueTermHitNote(counts, isLimited)
    if (termNote) notes.push(termNote)
  }
  const renderMessage = (message: DialogueMessage) => renderDialogueLine(message) + (message.givenSegments < message.segmentCount ? excerptNote(message.segmentCount, message.ref) : messageReferenceNote(message.ref))
  const body = result.groups.map(group => {
    const turns = group.turns.map(turn => turn.messages.map(renderMessage).join('\n'))
    return [dialogueSessionHeading(group.title, group.turns[0]?.at), ...turns].filter(Boolean).join('\n\n')
  }).join('\n\n')
  return [...notes, ...(body ? [wrapDialogueQuote(body)] : [])].join('\n')
}
