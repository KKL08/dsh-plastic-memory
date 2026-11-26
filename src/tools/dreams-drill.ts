import type { MemoryStore } from '../store.ts'
import type { PendingDecisionsStore } from '../governance/decisions.ts'
import {
  DECISION_ALTERNATIVES_MARKS, DECISION_BASIS_MARKS, DRILL_CANDIDATES_MAX, DRILL_FIND_HITS, DRILL_READ_MAX_CHARS, DRILL_REASON_MAX, DRILL_WINDOW_MESSAGES,
  buildDrillFillPrompt, buildDrillRequestPrompt, checkDrillRequest, drillAnchorKey, drillExcerpts, drillReadGate, factDay, isFactGap, judgeDrillReply,
  parseDrillReply, parseDrillRequests, recoveredAnchor, resolveMaxDrillDowns,
  type DrillAnchor, type DrillCandidate, type DrillDraft, type DrillGapKind, type DrillGateRefusal, type DrillLog, type DrillRequest,
} from '../governance/drill-down.ts'
import { anchorSourceMode, anchorsOf, type MemoryRecord, type SourceAnchor } from '../record-schema.ts'
import { RECOVERED_VERSION, STATE_CHANGE_VERSION, byVersionEnd, layerOf, versionReason, type HistoryVersion } from '../storage/history.ts'
import { anchorTimeMatches, isOwnEvent, isRealUserMessage, messageText, relocateByTime, type RawEvent, type SessionLog } from '../session-log.ts'
import type { NoReviewList } from '../storage/no-review.ts'
import type { LocatedRecord } from '../storage/table.ts'
import { numberDialogue } from '../governance/session-excerpt.ts'
import { basisOf, scopeKeyOf, type ChangeOp } from '../governance/changeset.ts'
import { droppedText, oneLine } from '../governance/dreams-tidy.ts'
import { ledgerLabel } from '../scope.ts'
import { clipText } from '../save-signals.ts'
import { hasSecret, maskSecrets } from '../secrets.ts'
import { isCompleteRead, type DreamsStep } from './dreams-run.ts'
import { ask } from './dreams-tidy.ts'
import type { HostSession } from './host-session.ts'

/**
 * 记忆梦境整理中的下钻补全（执行器）：读锚指向的会话，和运行计划里的下钻一步。
 * 读到的消息和工具结果原样交给模型，不遮盖；写下的记忆照常过写入时的密钥拦截（细化经变更集，补回版本经 recoverVersion）。
 */

// 下面三个是纯函数，但要用历史版本的取值（版本种类常量、按结束时间排序、版本原因），治理层只能按类型引用存储层，所以放在执行器这一层。

/**
 * 这条记忆能下钻的锚：当前出处清单（anchorsOf，新的在前），再接各历史版本记录的出处（版本按结束时间从新到旧，
 * 每版内同样 anchorsOf 的顺序，带 fromVersion）。并进来的别的记忆的版本（mergedFrom）不算。按身份键去重，留第一次出现的。
 */
export function drillAnchorsOf(record: MemoryRecord, versions: readonly HistoryVersion[]): DrillAnchor[] {
  const out: DrillAnchor[] = []
  const seen = new Set<string>()
  const push = (a: SourceAnchor, fromVersion?: string) => {
    const d: DrillAnchor = { sessionId: a.sessionId, eventRange: [a.eventRange[0], a.eventRange[1]], at: a.at, ...(a.change !== undefined ? { change: a.change } : {}), ...(fromVersion !== undefined ? { fromVersion } : {}) }
    const key = drillAnchorKey(d)
    if (seen.has(key)) return
    seen.add(key)
    out.push(d)
  }
  for (const a of anchorsOf(record)) push(a)
  for (const v of versions.filter(v => v.mergedFrom === undefined).sort(byVersionEnd).reverse()) for (const a of anchorsOf(v.record)) push(a, v.versionId)
  return out
}

/**
 * 代码标出这条记忆的缺口，按 DRILL_GAP_KINDS 的顺序给出：
 * - missing-reason：自己的历史版本（mergedFrom 为空）里结束得最晚的那个 state-change 版本，versionReason 为空；
 * - missing-basis / missing-alternatives：类型是 decision，正文里没有对应的标记（DECISION_BASIS_MARKS / DECISION_ALTERNATIVES_MARKS）；
 * - fact-gap：按事实时间轴比相邻两项，有一对 isFactGap 就标。基础序列是自己的历史版本里补回的（RECOVERED_VERSION）以外那些，
 *   按结束时间排好、最后接上当前记录。补回的版本结束时间是回忆起它的那次会话的时间，不是那个状态的时间，所以按 factDay 插进去：
 *   几个补回版本按 factDay 先后，各插在序列里第一个 factDay 晚于它的那一项之前，没有就接在最后；factDay 为 undefined 的不参与；
 * - premise-changed：类型是 decision，且调用方说它有未决的依据已变条目。
 * versions 是这一层这条记忆的历史（调用方确认读全了才给）。
 */
export function markGaps(input: { record: MemoryRecord; versions: readonly HistoryVersion[]; hasOpenPremiseChange: boolean }): DrillGapKind[] {
  const { record } = input
  const own = input.versions.filter(v => v.mergedFrom === undefined).sort(byVersionEnd)
  const gaps: DrillGapKind[] = []
  const lastState = own.filter(v => v.kind === STATE_CHANGE_VERSION).at(-1)
  if (lastState !== undefined && versionReason(lastState) === '') gaps.push('missing-reason')
  const isDecision = record.type === 'decision'
  if (isDecision && !DECISION_BASIS_MARKS.some(m => record.content.includes(m))) gaps.push('missing-basis')
  if (isDecision && !DECISION_ALTERNATIVES_MARKS.some(m => record.content.includes(m))) gaps.push('missing-alternatives')
  const chain: Array<string | undefined> = [...own.filter(v => v.kind !== RECOVERED_VERSION).map(v => v.record.factTime), record.factTime]
  const recovered = own.filter(v => v.kind === RECOVERED_VERSION && factDay(v.record.factTime) !== undefined)
    .sort((a, b) => factDay(a.record.factTime)! - factDay(b.record.factTime)!)
  for (const v of recovered) {
    const day = factDay(v.record.factTime)!
    const at = chain.findIndex(t => { const d = factDay(t); return d !== undefined && d > day })
    chain.splice(at < 0 ? chain.length : at, 0, v.record.factTime)
  }
  if (chain.some((t, i) => i > 0 && isFactGap(chain[i - 1], t))) gaps.push('fact-gap')
  if (isDecision && input.hasOpenPremiseChange) gaps.push('premise-changed')
  return gaps
}

/**
 * 补回的历史版本：record 取 current 的全部字段，换掉 content、summary、factTime（取稿），sourceTrail 换成 [anchor]，
 * source 换成这个锚的旧三项（sessionId、eventRange、sourceMode），去掉 lastChange 和 stateSince；extras 为空。
 * startedAt、endedAt 都是 anchor.at；kind recovered；writes 只有一项 { op, at, reason? }，reason 是稿里的原因
 * 遮盖疑似密钥（maskSecrets 疑似级）、折成一行、截到 DRILL_REASON_MAX。
 */
export function recoveredVersion(current: MemoryRecord, input: {
  draft: Extract<DrillDraft, { kind: 'recovered' }>
  anchor: SourceAnchor
  versionId: string
  op: string
  at: number
}): HistoryVersion {
  const { lastChange: _l, stateSince: _s, ...rest } = current
  const { draft, anchor } = input
  const reason = draft.reason === undefined ? '' : clipText(oneLine(maskSecrets(draft.reason, { severity: 'suspected' })), DRILL_REASON_MAX)
  return {
    versionId: input.versionId,
    record: { ...rest, content: draft.content, summary: draft.summary, factTime: draft.factTime, sourceTrail: [anchor], source: { sessionId: anchor.sessionId, eventRange: anchor.eventRange, sourceMode: anchorSourceMode(anchor) } },
    extras: {}, startedAt: anchor.at, endedAt: anchor.at, kind: RECOVERED_VERSION,
    writes: [{ op: input.op, at: input.at, ...(reason !== '' ? { reason } : {}) }],
  }
}

/** 读会话要的：宿主的会话日志、会话列表、存档状态，「不回看」清单，这次运行的下钻上限。 */
export interface DrillSourceDeps {
  host: Pick<HostSession, 'readSessionLog' | 'listSessions' | 'archivedSessionIds'>
  noReview: Pick<NoReviewList, 'isMarkedNoReview'>
  limit: number
}

/** 这次跳过、下次重试的原因（不列进报告、不占名额）：列不出会话、会话在列表里但日志读不出、存档状态读不出、不回看清单读不出。 */
export type DrillRetryReason = 'sessions-unlisted' | 'log-unreadable' | 'archive-unknown' | 'no-review-unknown'
/** 确认读不到的原因（列进报告）：会话不在宿主的会话列表里、标了不回看、锚失效（按时间也找不回）、锚那一段没有可读的消息。 */
export type DrillUnreadableReason = 'session-gone' | 'no-review' | 'anchor-lost' | 'empty'
/**
 * 按关键词找没给出消息的原因（不列进报告、不算试过这个锚：关键词没找到不说明锚那一段读不到）：没命中；会话分不清哪些事件是自己的
 * （seeded 会话给不出继承边界，整个会话找会把继承来的当成自己的）。
 */
export type DrillMissReason = 'no-hits' | 'boundary-unknown'

/**
 * 一处下钻的结果。read：读到了，events 是交给 numberDialogue 的那一段（按日志顺序），userSeqs 是其中用户本人原话
 * （isRealUserMessage）的序号；refused：放行没过（drillReadGate）；unreadable：确认读不到；retry：这次跳过；missed：按关键词找没给出消息。
 */
export type DrillOutcome =
  | { kind: 'read'; sessionId: string; isArchived: boolean; events: readonly RawEvent[]; userSeqs: ReadonlySet<number> }
  | { kind: 'refused'; reason: DrillGateRefusal }
  | { kind: 'unreadable'; reason: DrillUnreadableReason }
  | { kind: 'retry'; reason: DrillRetryReason }
  | { kind: 'missed'; reason: DrillMissReason }

/**
 * 读一处下钻，记进 log。顺序（有先后约束）：
 * 1. 放行：archivedSessionIds 为 null 时存档状态按「不知道」交给 drillReadGate（核实矛盾时 pairAnchors 的会话同样按这份名单判）。
 *    refused、retry 原样返回，不记账；这时不列会话、不读「不回看」清单和日志（名额满了在这一步就拒掉）。
 * 2. listSessions 为 null → retry sessions-unlisted；锚的会话不在列表里 → unreadable session-gone（不读日志）。
 * 3. isMarkedNoReview 抛错 → retry no-review-unknown；为真 → unreadable no-review（不读日志）。
 * 4. readSessionLog 为 null → retry log-unreadable。读到了：used 加一，存档的会话记进 archivedSessions。
 * 5. 往下只看这个会话自己的事件：带数字序号、isOwnEvent 不为 false 的（fork 继承来的前缀不算）。其中有 isOwnEvent 为 unknown 的，
 *    这个会话算「分不清归属」。「可读」的事件：messageText 取得出文字，角色是 user、assistant、tool 之一，user/message 事件的角色
 *    还得是 user（别的来源开的消息不算，同 numberDialogue）。
 * 6. 按关键词找（request.query 给了）：分不清归属 → missed boundary-unknown；否则取 isOwnEvent 为真、可读、正文含关键词（不分大小写）的事件，
 *    最多 DRILL_FIND_HITS 条，一条都没有 → missed no-hits。不定位锚。
 * 7. 开窗（没给 query）：锚起点事件（在第 5 步的事件里找）的时间和 at 对不上（anchorTimeMatches），或会话分不清归属时，带 change 的锚
 *    在第 5 步的事件里按 relocateByTime 找回那一轮，整段平移（终点不超过这些事件的最后一条）；找不回 → unreadable anchor-lost。
 *    不带 change 的旧锚按序号原样读。取范围里可读的事件，最多 DRILL_WINDOW_MESSAGES 条；一条都没有 → unreadable empty。
 * 8. 两种取法都按日志顺序，正文合计到 DRILL_READ_MAX_CHARS 为止（整条地给，第一条总给）。
 * 9. unreadable 记进 log.unreadable（{ memoryId, sessionId, eventRange（锚原来的）, at, reason }）和 log.attempted；read 的锚记进 attempted；
 *    missed 两样都不记。
 * 只读：不写任何文件、侧表。
 */
export async function drillRead(request: DrillRequest & { pairAnchors?: readonly DrillAnchor[] }, log: DrillLog, deps: DrillSourceDeps): Promise<DrillOutcome> {
  const { anchor, memoryId } = request
  const sid = anchor.sessionId
  const unreadable = (reason: DrillUnreadableReason): DrillOutcome => {
    log.attempted.add(drillAnchorKey(anchor))
    log.unreadable.push({ memoryId, sessionId: sid, eventRange: [anchor.eventRange[0], anchor.eventRange[1]], at: anchor.at, reason })
    return { kind: 'unreadable', reason }
  }
  const archived = log.used >= deps.limit ? null : await deps.host.archivedSessionIds()
  const gate = drillReadGate({
    purpose: request.purpose, anchor, archivedOf: id => (archived === null ? undefined : archived.has(id)), used: log.used, limit: deps.limit,
    ...(request.pairAnchors !== undefined ? { pairAnchors: request.pairAnchors } : {}), attempted: log.attempted,
  })
  if (gate.kind !== 'ok') return gate
  const list = await deps.host.listSessions()
  if (list === null) return { kind: 'retry', reason: 'sessions-unlisted' }
  if (!list.some(e => e.id === sid)) return unreadable('session-gone')
  let isMarked: boolean
  try {
    isMarked = await deps.noReview.isMarkedNoReview(sid)
  } catch {
    return { kind: 'retry', reason: 'no-review-unknown' }
  }
  if (isMarked) return unreadable('no-review')
  const sl = await deps.host.readSessionLog(sid)
  if (sl === null) return { kind: 'retry', reason: 'log-unreadable' }
  log.used++
  if (gate.isArchived) log.archivedSessions.add(sid)
  const own = sl.events.filter(e => typeof e.seq === 'number' && isOwnEvent(sl, e) !== false)
  const isUnknown = own.some(e => isOwnEvent(sl, e) === 'unknown')
  let picked: RawEvent[]
  if (request.query !== undefined) {
    if (isUnknown) return { kind: 'missed', reason: 'boundary-unknown' }
    const q = request.query.toLowerCase()
    picked = own.filter(e => isOwnEvent(sl, e) === true && readableText(e)?.toLowerCase().includes(q) === true).slice(0, DRILL_FIND_HITS)
    if (picked.length === 0) return { kind: 'missed', reason: 'no-hits' }
  } else {
    let [start, end] = anchor.eventRange
    const startTime = own.find(e => e.seq === start)?.time
    const nextTime = own.find(e => e.seq! > end && typeof e.time === 'number')?.time
    if (anchor.change !== undefined && (isUnknown || !anchorTimeMatches(anchor.at, startTime, nextTime))) {
      const relocated = relocateByTime(anchor, own)
      if (relocated === null) return unreadable('anchor-lost')
      if (relocated !== start) {
        end = Math.min(relocated + end - start, own.at(-1)!.seq!)
        start = relocated
      }
    }
    picked = own.filter(e => e.seq! >= start && e.seq! <= end && readableText(e) !== undefined).slice(0, DRILL_WINDOW_MESSAGES)
    if (picked.length === 0) return unreadable('empty')
  }
  let chars = 0
  const events: RawEvent[] = []
  for (const e of picked) {
    const len = readableText(e)!.length
    if (events.length > 0 && chars + len > DRILL_READ_MAX_CHARS) break
    chars += len
    events.push(e)
  }
  log.attempted.add(drillAnchorKey(anchor))
  return { kind: 'read', sessionId: sid, isArchived: gate.isArchived, events, userSeqs: userSeqsOf(sl, events) }
}

/** 可读的消息正文（见 drillRead 第 5 步）；不可读为 undefined。 */
function readableText(e: RawEvent): string | undefined {
  const m = messageText(e)
  if (m === null || !['user', 'assistant', 'tool'].includes(m.role) || (e.type === 'user/message' && m.role !== 'user')) return undefined
  return m.text
}

const userSeqsOf = (log: SessionLog, events: readonly RawEvent[]) => new Set(events.filter(e => isRealUserMessage(log, e)).map(e => e.seq!))

export interface DrillDownStepDeps {
  store: Pick<MemoryStore, 'readRaw' | 'history'>
  /** 未决账本：只读，找有未决「依据已变」条目的决定（当缺口线索）。 */
  decisions: Pick<PendingDecisionsStore, 'list'>
  host: Pick<HostSession, 'readSessionLog' | 'listSessions' | 'archivedSessionIds'>
  noReview: Pick<NoReviewList, 'isMarkedNoReview'>
  /** 配置里的下钻上限原值（brewingDreams.maxDrillDowns），用时经 resolveMaxDrillDowns。 */
  maxDrillDowns: () => unknown
  now: () => number
}

/**
 * 运行计划里的下钻补全一步（排在合并零碎记忆之后、处理矛盾之前）。没有新变化、上次也做完了的时候跳过；上限为 0 时不做。
 * 1. 候选：本范围这一层在用、id 唯一、上次以来变过、没留给下次、不含密钥（疑似级也算）、至少有一个锚的记忆。历史读不全的不交给模型，
 *    记跳过、留到下次。按代码标出的缺口多少、再按 id 排，最多 DRILL_CANDIDATES_MAX 条，排不进去又有缺口的留到下次。没有候选就不调模型。
 * 2. 请求：一次模型调用（没有代码标出的缺口时也问，让模型自己提）。回复读不出时有缺口的候选留到下次，这一步照常结束。
 * 3. 逐个请求核对（这一步只做补缺口）、读锚指向的会话；读不到的进报告，这次读不出的留到下次，名额满了的记跳过并留到下次。
 * 4. 补写：一次模型调用。依据全是用户本人原话的直接写（细化走变更集，补回的过去状态写成历史版本），其余的稿遮盖后进报告交给用户。
 * 每次模型调用之后、每个请求之前看要不要让路。
 */
export const drillDownStep = (deps: DrillDownStepDeps): DreamsStep => ({
  name: 'drill-down',
  needsChanges: true,
  async run(ctx) {
    const limit = resolveMaxDrillDowns(deps.maxDrillDowns())
    if (limit === 0) return
    const read = await deps.store.readRaw(ctx.scope)
    if (!isCompleteRead(read)) throw new Error('这个范围的记忆读不全')
    const byId = new Map<string, LocatedRecord>()
    const doubled = new Set<string>()
    for (const found of read.records) {
      if (found.record.status !== 'active') continue
      if (byId.has(found.record.id)) doubled.add(found.record.id)
      byId.set(found.record.id, found)
    }
    for (const id of doubled) byId.delete(id)
    const label = ledgerLabel(ctx.scope)
    const premise = new Set((await deps.decisions.list())
      .filter(e => e.kind === 'premise-changed' && (e.workspaces === undefined || e.workspaces[0] === label))
      .flatMap(e => e.memoryIds.slice(0, 1)))
    const all: Array<DrillCandidate & { versions: readonly HistoryVersion[] }> = []
    for (const [id, found] of byId) {
      // 文件格式允许空 id，这样的记忆不会有历史版本（历史存储也不收空 id），不是候选
      if (id === '' || !ctx.isChanged(id) || ctx.isHeldForNextRun(id) || hasSecret(found.record)) continue
      const listing = await deps.store.history.list(layerOf(found), id)
      if (!listing.isComplete) {
        ctx.skip({ kind: 'drill-down', target: id, reason: 'history-unreadable' })
        ctx.markUnprocessed([id])
        continue
      }
      const anchors = drillAnchorsOf(found.record, listing.versions)
      if (anchors.length === 0) continue
      all.push({ record: found.record, gaps: markGaps({ record: found.record, versions: listing.versions, hasOpenPremiseChange: premise.has(id) }), anchors, versions: listing.versions })
    }
    all.sort((a, b) => b.gaps.length - a.gaps.length || (a.record.id < b.record.id ? -1 : 1))
    const offered = all.slice(0, DRILL_CANDIDATES_MAX)
    ctx.markUnprocessed(all.slice(DRILL_CANDIDATES_MAX).filter(c => c.gaps.length > 0).map(c => c.record.id))
    if (offered.length === 0) return
    const llm = await ctx.llm()
    const requests = await ask(llm, buildDrillRequestPrompt(offered), parseDrillRequests, ctx)
    if (ctx.shouldStop()) return
    if (requests === undefined) {
      ctx.markUnprocessed(offered.filter(c => c.gaps.length > 0).map(c => c.record.id))
      return
    }
    const byCandidate = new Map(offered.map(c => [c.record.id, c]))
    const candidates = new Map(offered.map(c => [c.record.id, c.anchors]))
    const seen = new Set<string>()
    const mask = (text: string) => maskSecrets(text, { severity: 'suspected' })
    let seq = 0
    for (const raw of requests) {
      if (ctx.shouldStop()) return
      const check = checkDrillRequest({ request: raw, candidates, purposes: ['fill-gap'], seen })
      if (!check.ok) {
        ctx.skip({ kind: 'drill-down', target: droppedText(check.memoryId ?? '', candidates), reason: check.reason })
        continue
      }
      const { request } = check
      seen.add(request.memoryId)
      const outcome = await drillRead(request, ctx.drillLog, { host: deps.host, noReview: deps.noReview, limit })
      if (outcome.kind === 'refused' || outcome.kind === 'missed') {
        ctx.skip({ kind: 'drill-down', target: request.memoryId, reason: outcome.reason })
        if (outcome.reason === 'over-limit') ctx.markUnprocessed([request.memoryId])
        continue
      }
      if (outcome.kind === 'retry') {
        ctx.markUnprocessed([request.memoryId])
        continue
      }
      if (outcome.kind === 'unreadable') continue
      const cand = byCandidate.get(request.memoryId)!
      const numbered = numberDialogue([{ sessionId: outcome.sessionId, events: outcome.events }])
      const userRefs = new Set([...numbered.refs].filter(([, r]) => outcome.userSeqs.has(r.seq)).map(([n]) => n))
      const reply = await ask(llm, buildDrillFillPrompt({ record: cand.record, versions: cand.versions, gap: request.gap, dialogue: numbered.blocks[0]! }), parseDrillReply, ctx)
      if (ctx.shouldStop()) return
      if (reply === undefined) continue
      const judged = judgeDrillReply(reply, { current: cand.record, refs: numbered.refs, userRefs })
      if (judged.kind === 'none') continue
      if (judged.kind === 'skip') {
        ctx.skip({ kind: 'drill-down', target: request.memoryId, reason: judged.reason })
        continue
      }
      const refs = judged.refs.map(n => numbered.refs.get(n)!)
      const excerpts = drillExcerpts(refs)
      const { draft } = judged
      if (judged.kind === 'hand-over') {
        ctx.drillLog.proposals.push({
          memoryId: request.memoryId, gap: request.gap, kind: draft.kind, content: mask(draft.content),
          ...(draft.summary !== undefined ? { summary: mask(draft.summary) } : {}),
          ...(draft.kind === 'recovered' ? { factTime: draft.factTime, ...(draft.reason !== undefined ? { reason: mask(draft.reason) } : {}) } : {}),
          excerpts,
        })
        continue
      }
      const opId = `${ctx.runId}:drill:${++seq}`
      const r = cand.record
      if (draft.kind === 'refine') {
        const op: ChangeOp = {
          id: opId, kind: 'edit', memoryId: r.id, scopeKey: scopeKeyOf(r), basis: [basisOf(r)], change: 'refine',
          patch: { content: draft.content, ...(draft.summary !== undefined ? { summary: draft.summary } : {}) },
          expect: { content: r.content, ...(draft.summary !== undefined ? { summary: r.summary } : {}) },
        }
        const o = (await ctx.apply([op])).outcomes.find(x => x.opId === opId)
        if (o?.kind === 'applied') ctx.drillLog.filled.push({ memoryId: r.id, gap: request.gap, kind: 'refine', opId, excerpts })
        else if (o?.kind === 'skipped' && o.reason === 'quota') ctx.markUnprocessed([r.id])
      } else {
        const anchor = recoveredAnchor(refs, r.updatedAt)
        const done = await ctx.recoverVersion({ op: opId, basis: basisOf(r), endedAt: anchor.at, build: (current, versionId) => recoveredVersion(current, { draft, anchor, versionId, op: opId, at: deps.now() }) })
        if (done.kind === 'applied') ctx.drillLog.filled.push({ memoryId: r.id, gap: request.gap, kind: 'recovered', opId, excerpts })
        else if (done.reason === 'history-unreadable') ctx.markUnprocessed([r.id])
      }
    }
  },
})
