import { describe, expect, it } from 'vitest'
import {
  DECISION_ALTERNATIVES_MARKS, DECISION_BASIS_MARKS, DRILL_CONTENT_CLIP, DRILL_EXCERPT_MAX, DRILL_FACT_GAP_DAYS, DRILL_FILL_SYSTEM_PROMPT, DRILL_GAP_KINDS, DRILL_GAP_MAX,
  DRILL_MAX_DEFAULT, DRILL_QUERY_MAX, DRILL_REASON_MAX, DRILL_REQUEST_SYSTEM_PROMPT,
  buildDrillFillPrompt, buildDrillRequestPrompt, checkDrillRequest, drillAnchorKey, drillExcerpts, drillReadGate, drillReportOf, factDay,
  isDrillLogEmpty, isFactGap, isKnownMaxDrillDowns, judgeDrillReply, newDrillLog, parseDrillReply, parseDrillRequests, recoveredAnchor, resolveMaxDrillDowns,
  type DrillAnchor, type DrillPurpose,
} from '../src/governance/drill-down.ts'
import { drillAnchorsOf, markGaps, recoveredVersion } from '../src/tools/dreams-drill.ts'
import type { DialogueRef } from '../src/governance/session-excerpt.ts'
import { DIALOGUE_QUOTE_TAG } from '../src/search/dialogue-format.ts'
import { CONTENT_LENGTH_HINT } from '../src/save-signals.ts'
import { SECRET_MASK } from '../src/secrets.ts'
import { TIDY_SUMMARY_MAX } from '../src/governance/dreams-tidy.ts'
import { MERGED_VERSION, RECOVERED_VERSION, STATE_CHANGE_VERSION, type HistoryVersion } from '../src/storage/history.ts'
import type { MemoryRecord, SourceAnchor } from '../src/record-schema.ts'
import { record } from './helpers/record.ts'
import { FAKE_SECRET } from './helpers/secrets.ts'

// 下钻补全的纯规则：锚清单、缺口、请求核对、读之前的放行、补写判定、补回版本的形状、下钻账、提示词结构。

const DAY = 86_400_000
/** 疑似级密钥（库里的疑似密钥是用户确认放行的）：遮盖、拦截都要连它一起管。 */
const SUSPECTED = 'password=Abc12345xyz'
const SUSPECTED_VALUE = 'Abc12345xyz'
const T = Date.UTC(2025, 2, 1, 2, 0)

const anchor = (sessionId: string, eventRange: [number, number], at: number, extra: Partial<SourceAnchor> = {}): SourceAnchor =>
  ({ sessionId, eventRange, sourceMode: 'user-explicit', at, change: 'refine', ...extra })

function version(versionId: string, rec: MemoryRecord, endedAt: number, extra: Partial<HistoryVersion> = {}): HistoryVersion {
  return { versionId, record: rec, extras: {}, startedAt: endedAt - DAY, endedAt, kind: STATE_CHANGE_VERSION, writes: [], ...extra }
}

const ref = (n: number, speaker: DialogueRef['speaker'], text: string, seq = n, at = T + seq * 1000, sessionId = 's1'): [number, DialogueRef] =>
  [n, { sessionId, seq, speaker, text, at }]

describe('能下钻的锚', () => {
  it('当前出处在前，历史版本的锚接在后面（版本从新到旧、带版本标识），同一个锚只留一次，并进来的版本不算', () => {
    const current = record({ id: 'mem_s', sourceTrail: [anchor('s3', [0, 4], T + 3 * DAY), anchor('s1', [0, 2], T)], source: { sessionId: 's3', eventRange: [0, 4], sourceMode: 'user-explicit' } })
    const older = version('v1', record({ id: 'mem_s', sourceTrail: [anchor('s1', [0, 2], T)], source: { sessionId: 's1', eventRange: [0, 2], sourceMode: 'user-explicit' } }), T + DAY)
    const newer = version('v2', record({ id: 'mem_s', sourceTrail: [anchor('s2', [5, 9], T + 2 * DAY)], source: { sessionId: 's2', eventRange: [5, 9], sourceMode: 'user-explicit' } }), T + 2 * DAY)
    const merged = version('v3', record({ id: 'mem_other', sourceTrail: [anchor('s9', [0, 1], T)], source: { sessionId: 's9', eventRange: [0, 1], sourceMode: 'user-explicit' } }), T + 3 * DAY, { mergedFrom: 'mem_other', mergedFromScope: 'global', kind: MERGED_VERSION })
    const anchors = drillAnchorsOf(current, [older, merged, newer])
    expect(anchors.map(a => [a.sessionId, a.eventRange, a.fromVersion ?? null])).toEqual([
      ['s3', [0, 4], null], ['s1', [0, 2], null], ['s2', [5, 9], 'v2'],
    ])
    expect(anchors[0]).toMatchObject({ at: T + 3 * DAY, change: 'refine' })
  })

  it('没有出处清单的旧记录：source 当唯一的锚，时间取更新时间，不带改动性质', () => {
    const old = record({ id: 'mem_o', source: { sessionId: 's1', eventRange: [3, 7], sourceMode: 'user-explicit' }, updatedAt: T })
    const anchors = drillAnchorsOf(old, [])
    expect(anchors).toEqual([{ sessionId: 's1', eventRange: [3, 7], at: T }])
    expect(drillAnchorKey(anchors[0]!)).toBe(drillAnchorKey({ sessionId: 's1', eventRange: [3, 7], at: T }))
    expect(drillAnchorKey(anchors[0]!)).not.toBe(drillAnchorKey({ sessionId: 's1', eventRange: [3, 7], at: T + 1 }))
  })
})

describe('下钻上限的配置值', () => {
  it('认得的值是非负整数（含 0）；负数、小数、非数字不认得，报进坏配置告警', () => {
    for (const ok of [0, 1, 5, 40]) expect(isKnownMaxDrillDowns(ok)).toBe(true)
    for (const bad of [-1, 2.5, Number.NaN, Number.POSITIVE_INFINITY, '3', undefined, null]) expect(isKnownMaxDrillDowns(bad)).toBe(false)
  })

  it('非负整数原样用（0 是不下钻），负数、小数、非数字按缺省', () => {
    expect(resolveMaxDrillDowns(0)).toBe(0)
    expect(resolveMaxDrillDowns(3)).toBe(3)
    for (const bad of [-1, 2.5, Number.NaN, Number.POSITIVE_INFINITY, '3', undefined, null]) expect(resolveMaxDrillDowns(bad)).toBe(DRILL_MAX_DEFAULT)
  })
})

describe('事实时间隔得远', () => {
  it('精确到月按当月 1 日，到日或带时刻按写出来的那一天；只写到年、没有、写坏的不算', () => {
    expect(factDay('2025-03')).toBe(Date.UTC(2025, 2, 1) / DAY)
    expect(factDay('2025-03-15')).toBe(Date.UTC(2025, 2, 15) / DAY)
    expect(factDay('2025-03-15T23:30+08:00')).toBe(Date.UTC(2025, 2, 15) / DAY)
    expect(factDay('2025-03-15 08:00')).toBe(Date.UTC(2025, 2, 15) / DAY)
    for (const none of ['2025', undefined, '', '2025-13', '昨天']) expect(factDay(none)).toBeUndefined()
  })

  it(`相差超过 ${DRILL_FACT_GAP_DAYS} 天才算，正好 ${DRILL_FACT_GAP_DAYS} 天不算；先后不论；任一边只写到年或没有不算`, () => {
    const day = (n: number) => new Date(Date.UTC(2025, 0, 1) + n * DAY).toISOString().slice(0, 10)
    expect(isFactGap(day(0), day(DRILL_FACT_GAP_DAYS + 1))).toBe(true)
    expect(isFactGap(day(DRILL_FACT_GAP_DAYS + 1), day(0))).toBe(true)
    expect(isFactGap(day(0), day(DRILL_FACT_GAP_DAYS))).toBe(false)
    expect(isFactGap('2024', '2026-01')).toBe(false)
    expect(isFactGap(undefined, '2026-01')).toBe(false)
    // 精确到月的按 1 日：2025-01 到 2025-07-01 是 181 天
    expect(isFactGap('2025-01', '2025-07')).toBe(true)
  })
})

describe('代码标出的缺口', () => {
  const page = (extra: Partial<MemoryRecord> = {}) => record({ id: 'mem_p', type: 'project', content: '现在用 pnpm', ...extra })
  const reasoned = (versionId: string, endedAt: number, reason: string | undefined, factTime?: string) =>
    version(versionId, page({ ...(factTime !== undefined ? { factTime } : {}) }), endedAt, { writes: [{ op: `op_${versionId}`, at: endedAt, ...(reason !== undefined ? { reason } : {}) }] })

  it('状态页最近一次状态变化没写原因：标 missing-reason；写了原因不标；更早的那次没写不算', () => {
    expect(markGaps({ record: page(), versions: [reasoned('v1', T, '换了包管理器'), reasoned('v2', T + DAY, undefined)], hasOpenPremiseChange: false })).toContain('missing-reason')
    expect(markGaps({ record: page(), versions: [reasoned('v1', T, undefined), reasoned('v2', T + DAY, '换了包管理器')], hasOpenPremiseChange: false })).not.toContain('missing-reason')
    expect(markGaps({ record: page(), versions: [], hasOpenPremiseChange: false })).toEqual([])
  })

  it('只看状态变化留下的版本：最近的是补回的或并进来的版本时，看它之前那个状态变化版本', () => {
    const recovered = version('v3', page(), T + 2 * DAY, { kind: RECOVERED_VERSION })
    const merged = version('v4', page({ id: 'mem_x' }), T + 3 * DAY, { kind: MERGED_VERSION, mergedFrom: 'mem_x', mergedFromScope: 'global' })
    expect(markGaps({ record: page(), versions: [reasoned('v1', T, '原因'), recovered, merged], hasOpenPremiseChange: false })).not.toContain('missing-reason')
    expect(markGaps({ record: page(), versions: [reasoned('v1', T, undefined), recovered, merged], hasOpenPremiseChange: false })).toContain('missing-reason')
  })

  it('决定缺依据、缺没选的方案各标一项；写了标记就不标；别的类型不标', () => {
    const decision = (content: string) => record({ id: 'mem_d', type: 'decision', content })
    expect(markGaps({ record: decision('改用 pnpm。'), versions: [], hasOpenPremiseChange: false })).toEqual(['missing-basis', 'missing-alternatives'])
    expect(markGaps({ record: decision(`改用 pnpm。${DECISION_BASIS_MARKS[0]}安装快。`), versions: [], hasOpenPremiseChange: false })).toEqual(['missing-alternatives'])
    expect(markGaps({ record: decision(`改用 pnpm。${DECISION_BASIS_MARKS[1]}安装快。${DECISION_ALTERNATIVES_MARKS[0]}yarn。`), versions: [], hasOpenPremiseChange: false })).toEqual([])
    expect(markGaps({ record: record({ type: 'knowledge', content: '改用 pnpm。' }), versions: [], hasOpenPremiseChange: false })).toEqual([])
  })

  it('相邻两版的事实时间隔得远标 fact-gap：当前记录接在最后一版之后也算；只写到年的不算', () => {
    const far = new Date(Date.UTC(2025, 2, 1) + (DRILL_FACT_GAP_DAYS + 1) * DAY).toISOString().slice(0, 10)
    expect(markGaps({ record: page({ factTime: '2025-03-05' }), versions: [reasoned('v1', T, '因', '2025-03-01'), reasoned('v2', T + DAY, '因', far)], hasOpenPremiseChange: false })).toContain('fact-gap')
    expect(markGaps({ record: page({ factTime: far }), versions: [reasoned('v1', T, '因', '2025-03-01')], hasOpenPremiseChange: false })).toContain('fact-gap')
    expect(markGaps({ record: page({ factTime: '2025-03-20' }), versions: [reasoned('v1', T, '因', '2025-03-01')], hasOpenPremiseChange: false })).not.toContain('fact-gap')
    expect(markGaps({ record: page({ factTime: '2027' }), versions: [reasoned('v1', T, '因', '2025')], hasOpenPremiseChange: false })).not.toContain('fact-gap')
  })

  it('补回的版本按事实时间插进时间轴再比相邻：补上中间那段状态后缺口消失，不因回忆的时间排在后面造出新缺口', () => {
    const at = (iso: string) => Date.parse(`${iso}T00:00:00Z`)
    const dated = (versionId: string, factTime: string) => reasoned(versionId, at(factTime), '因', factTime)
    const current = page({ factTime: '2025-01-15' })
    const before = [dated('v1', '2024-01-10'), dated('v2', '2024-12-30')]
    expect(markGaps({ record: current, versions: before, hasOpenPremiseChange: false })).toContain('fact-gap')
    // 2025-09 的会话里回忆起 2024-07 的状态：版本的结束时间是 2025-09，比 v2 还晚
    const recalled = version('v_r', page({ factTime: '2024-07-05' }), at('2025-09-01'), { kind: RECOVERED_VERSION })
    expect(markGaps({ record: current, versions: [...before, recalled], hasOpenPremiseChange: false })).not.toContain('fact-gap')
    // 只写到年的补回版本不参与：缺口还在
    const vague = version('v_y', page({ factTime: '2024' }), at('2025-09-01'), { kind: RECOVERED_VERSION })
    expect(markGaps({ record: current, versions: [...before, vague], hasOpenPremiseChange: false })).toContain('fact-gap')
  })

  it('并进来的别的记忆的版本不参与相邻比较', () => {
    const far = new Date(Date.UTC(2025, 2, 1) + (DRILL_FACT_GAP_DAYS + 1) * DAY).toISOString().slice(0, 10)
    const foreign = version('v2', page({ id: 'mem_x', factTime: far }), T + DAY, { kind: MERGED_VERSION, mergedFrom: 'mem_x', mergedFromScope: 'global' })
    expect(markGaps({ record: page({ factTime: '2025-03-05' }), versions: [reasoned('v1', T, '因', '2025-03-01'), foreign], hasOpenPremiseChange: false })).not.toContain('fact-gap')
  })

  it('有未决的依据已变条目时标 premise-changed；几项一起时按缺口表的顺序给出', () => {
    const decision = record({ id: 'mem_d', type: 'decision', content: '改用 pnpm。' })
    const gaps = markGaps({ record: decision, versions: [version('v1', decision, T)], hasOpenPremiseChange: true })
    expect(gaps).toEqual(DRILL_GAP_KINDS.filter(k => ['missing-reason', 'missing-basis', 'missing-alternatives', 'premise-changed'].includes(k)))
    // 只有决定才有依据已变这一说：别的类型调用方说了也不标
    expect(markGaps({ record: page(), versions: [], hasOpenPremiseChange: true })).not.toContain('premise-changed')
  })
})

describe('下钻请求的核对', () => {
  const anchorsA: DrillAnchor[] = [{ sessionId: 's1', eventRange: [0, 4], at: T, change: 'refine' }, { sessionId: 's2', eventRange: [2, 6], at: T + DAY, fromVersion: 'v1' }]
  const candidates = new Map<string, readonly DrillAnchor[]>([['mem_a', anchorsA], ['mem_b', [{ sessionId: 's3', eventRange: [0, 1], at: T }]]])
  const purposes: DrillPurpose[] = ['fill-gap']
  const check = (request: unknown, seen: Set<string> = new Set()) => checkDrillRequest({ request, candidates, purposes, seen })
  const good = { id: 'mem_a', gap: 'missing-basis', anchor: 2, purpose: 'fill-gap' }

  it('合格的请求：给出这条记忆、它的第几个锚、用途；关键词去掉首尾空白；缺口代码折成一行、截到上限', () => {
    expect(check(good)).toEqual({ ok: true, request: { memoryId: 'mem_a', gap: 'missing-basis', purpose: 'fill-gap', anchor: anchorsA[1] } })
    expect(check({ ...good, query: '  pnpm  ' })).toEqual({ ok: true, request: { memoryId: 'mem_a', gap: 'missing-basis', purpose: 'fill-gap', anchor: anchorsA[1], query: 'pnpm' } })
    const long = check({ ...good, gap: `why\nnot-${'x'.repeat(DRILL_GAP_MAX)}` })
    expect(long.ok && long.request.gap.includes('\n')).toBe(false)
    expect(long.ok && [...long.request.gap].length <= DRILL_GAP_MAX + 1).toBe(true)
  })

  it('模型自己写的缺口代码会进报告：疑似和高危密钥都遮盖', () => {
    for (const gap of [`pw ${SUSPECTED}`, `k ${FAKE_SECRET.sk}`]) {
      const r = check({ ...good, gap })
      expect(r.ok).toBe(true)
      expect(r.ok && r.request.gap).not.toContain(SUSPECTED_VALUE)
      expect(r.ok && r.request.gap).not.toContain(FAKE_SECRET.sk)
    }
  })

  it('形状不对：不是对象、id 不是字符串、缺口不是非空字符串', () => {
    for (const bad of [null, 'mem_a', [good], { ...good, id: 3 }, { ...good, gap: '' }, { ...good, gap: '  ' }, { ...good, gap: 7 }]) {
      expect(check(bad)).toMatchObject({ ok: false, reason: 'malformed' })
    }
  })

  it('不是交给模型的候选：拒绝，带上它写的 id', () => {
    expect(check({ ...good, id: 'mem_zz' })).toEqual({ ok: false, reason: 'unknown-memory', memoryId: 'mem_zz' })
  })

  it('同一条记忆这一步已经提过：拒绝', () => {
    expect(check(good).ok).toBe(true)
    expect(check(good, new Set(['mem_a']))).toEqual({ ok: false, reason: 'duplicate', memoryId: 'mem_a' })
  })

  it('用途不认识的拒绝；认识但这一步不做的（核实矛盾）另一个原因', () => {
    expect(check({ ...good, purpose: 'rewrite' })).toEqual({ ok: false, reason: 'unknown-purpose', memoryId: 'mem_a' })
    expect(check({ ...good, purpose: undefined })).toEqual({ ok: false, reason: 'unknown-purpose', memoryId: 'mem_a' })
    expect(check({ ...good, purpose: 'verify-conflict' })).toEqual({ ok: false, reason: 'purpose-elsewhere', memoryId: 'mem_a' })
    expect(checkDrillRequest({ request: { ...good, purpose: 'verify-conflict' }, candidates, purposes: ['fill-gap', 'verify-conflict'], seen: new Set() }).ok).toBe(true)
  })

  it('锚不属于这条记忆：编号越界、不是整数、写成字符串、拿别的记忆的锚编号都拒绝', () => {
    for (const bad of [0, 3, 1.5, '1', undefined, -1]) expect(check({ ...good, anchor: bad })).toEqual({ ok: false, reason: 'anchor-not-owned', memoryId: 'mem_a' })
    // mem_b 只有一个锚：第 2 个是 mem_a 的，不算它的
    expect(check({ ...good, id: 'mem_b', anchor: 2 })).toEqual({ ok: false, reason: 'anchor-not-owned', memoryId: 'mem_b' })
  })

  it(`关键词给了就要是 1–${DRILL_QUERY_MAX} 个字的字符串`, () => {
    for (const bad of ['', '   ', 'x'.repeat(DRILL_QUERY_MAX + 1), 5]) expect(check({ ...good, query: bad })).toEqual({ ok: false, reason: 'bad-query', memoryId: 'mem_a' })
    expect(check({ ...good, query: 'x'.repeat(DRILL_QUERY_MAX) }).ok).toBe(true)
  })

  it('几处都不对时拒绝，报的是其中一处（先后不限）', () => {
    const cases: Array<[unknown, Set<string>, string[]]> = [
      [{ ...good, purpose: 'rewrite', anchor: 9 }, new Set(['mem_a']), ['duplicate', 'unknown-purpose', 'anchor-not-owned']],
      [{ ...good, purpose: 'rewrite', anchor: 9, query: '' }, new Set(), ['unknown-purpose', 'anchor-not-owned', 'bad-query']],
      [{ ...good, anchor: 9, query: '' }, new Set(), ['anchor-not-owned', 'bad-query']],
    ]
    for (const [request, seen, allowed] of cases) {
      const r = checkDrillRequest({ request, candidates, purposes, seen })
      expect(r.ok).toBe(false)
      expect(allowed).toContain(!r.ok && r.reason)
      expect(r).toMatchObject({ memoryId: 'mem_a' })
    }
  })

  it('请求阶段的回复：不是 JSON 对象、没有 requests 数组读不出；有就原样给出数组', () => {
    expect(parseDrillRequests('好的')).toBeUndefined()
    expect(parseDrillRequests('{"requests":"x"}')).toBeUndefined()
    expect(parseDrillRequests(JSON.stringify({ requests: [good, 3] }))).toEqual([good, 3])
    expect(parseDrillRequests(JSON.stringify({ requests: [] }))).toEqual([])
  })
})

describe('读之前的放行', () => {
  const own: DrillAnchor = { sessionId: 's_live', eventRange: [0, 3], at: T }
  const archivedAnchor: DrillAnchor = { sessionId: 's_old', eventRange: [0, 3], at: T }
  const other: DrillAnchor = { sessionId: 's_peer', eventRange: [5, 9], at: T + DAY }
  const states: Record<string, boolean | undefined> = { s_live: false, s_old: true, s_peer: false, s_unknown: undefined }
  const gate = (purpose: DrillPurpose, a: DrillAnchor, extra: { used?: number; limit?: number; pairAnchors?: DrillAnchor[]; attempted?: string[]; states?: Record<string, boolean | undefined> } = {}) => drillReadGate({
    purpose, anchor: a, archivedOf: id => (extra.states ?? states)[id], used: extra.used ?? 0, limit: extra.limit ?? 5,
    ...(extra.pairAnchors !== undefined ? { pairAnchors: extra.pairAnchors } : {}), attempted: new Set(extra.attempted ?? []),
  })

  it('补缺口：没存档的放行，存档的拒绝，存档状态不知道的这次跳过', () => {
    expect(gate('fill-gap', own)).toEqual({ kind: 'ok', isArchived: false })
    expect(gate('fill-gap', archivedAnchor)).toEqual({ kind: 'refused', reason: 'archived-fill-gap' })
    expect(gate('fill-gap', { ...own, sessionId: 's_unknown' })).toEqual({ kind: 'retry', reason: 'archive-unknown' })
  })

  it('核实矛盾：没存档的放行；存档的要等这一对指向没存档会话的锚都试过，一个都没有也算试过', () => {
    expect(gate('verify-conflict', own, { pairAnchors: [own, archivedAnchor, other] })).toEqual({ kind: 'ok', isArchived: false })
    expect(gate('verify-conflict', archivedAnchor, { pairAnchors: [own, archivedAnchor, other], attempted: [drillAnchorKey(own)] })).toEqual({ kind: 'refused', reason: 'archived-too-early' })
    expect(gate('verify-conflict', archivedAnchor, { pairAnchors: [own, archivedAnchor, other], attempted: [drillAnchorKey(own), drillAnchorKey(other)] })).toEqual({ kind: 'ok', isArchived: true })
    expect(gate('verify-conflict', archivedAnchor, { pairAnchors: [archivedAnchor] })).toEqual({ kind: 'ok', isArchived: true })
    expect(gate('verify-conflict', archivedAnchor, { pairAnchors: [] })).toEqual({ kind: 'ok', isArchived: true })
  })

  it('核实矛盾却没给这一对的锚：存档的拒绝（不知道还有哪些锚没试，按没试完算），没存档的照常放行', () => {
    expect(gate('verify-conflict', archivedAnchor)).toEqual({ kind: 'refused', reason: 'archived-too-early' })
    expect(gate('verify-conflict', own)).toEqual({ kind: 'ok', isArchived: false })
  })

  it('核实矛盾时这一对里有存档状态不知道的锚：这次跳过，不当存档也不当没存档', () => {
    const unknown: DrillAnchor = { sessionId: 's_unknown', eventRange: [0, 1], at: T }
    expect(gate('verify-conflict', archivedAnchor, { pairAnchors: [archivedAnchor, unknown] })).toEqual({ kind: 'retry', reason: 'archive-unknown' })
    expect(gate('verify-conflict', unknown, { pairAnchors: [unknown] })).toEqual({ kind: 'retry', reason: 'archive-unknown' })
  })

  it('名额用完拒绝（正好用到上限也算用完，上限 0 一处都不读）；名额满了先报名额，不看存档状态', () => {
    expect(gate('fill-gap', own, { used: 4, limit: 5 })).toEqual({ kind: 'ok', isArchived: false })
    expect(gate('fill-gap', own, { used: 5, limit: 5 })).toEqual({ kind: 'refused', reason: 'over-limit' })
    expect(gate('fill-gap', own, { used: 0, limit: 0 })).toEqual({ kind: 'refused', reason: 'over-limit' })
    expect(gate('fill-gap', archivedAnchor, { used: 5, limit: 5 })).toEqual({ kind: 'refused', reason: 'over-limit' })
    expect(gate('fill-gap', { ...own, sessionId: 's_unknown' }, { used: 5, limit: 5 })).toEqual({ kind: 'refused', reason: 'over-limit' })
    expect(gate('verify-conflict', archivedAnchor, { used: 5, limit: 5, pairAnchors: [own, archivedAnchor] })).toEqual({ kind: 'refused', reason: 'over-limit' })
  })
})

describe('补写的判定', () => {
  const refs = new Map<number, DialogueRef>([ref(1, 'user', '改用 pnpm，因为 CI 缓存快'), ref(2, 'assistant', '好的'), ref(3, 'tool', 'pnpm 9.1.0'), ref(4, 'user', '去年三月还在用 npm')])
  const userRefs = new Set([1, 4])
  const current = { content: '项目用 pnpm。' }
  const judge = (raw: unknown) => judgeDrillReply(parseDrillReply(JSON.stringify(raw))!, { current, refs, userRefs })

  it('回复不是 JSON 对象读不出；字段类型不对的当没给', () => {
    expect(parseDrillReply('补不上')).toBeUndefined()
    expect(parseDrillReply('[1]')).toBeUndefined()
    expect(parseDrillReply(JSON.stringify({ result: 'refine', content: 3, summary: ['x'], evidence: [1] }))).toEqual({ result: 'refine', evidence: [1] })
    expect(parseDrillReply(JSON.stringify({ content: '正文' }))).toEqual({ result: '', content: '正文' })
  })

  it('依据全是用户本人的原话：细化直接写，编号去重、按出现先后', () => {
    expect(judge({ result: 'refine', content: '项目用 pnpm。依据：CI 缓存快。', summary: '用 pnpm', evidence: [1, 1] })).toEqual({
      kind: 'direct', draft: { kind: 'refine', content: '项目用 pnpm。依据：CI 缓存快。', summary: '用 pnpm' }, refs: [1],
    })
    expect(judge({ result: 'refine', content: '项目用 pnpm。依据：CI 缓存快。', summary: '', evidence: [4, 1] })).toEqual({
      kind: 'direct', draft: { kind: 'refine', content: '项目用 pnpm。依据：CI 缓存快。' }, refs: [4, 1],
    })
  })

  it('依据里有助手的话或工具结果、没给依据、依据不是数组：交给用户', () => {
    const draft = { result: 'refine', content: '项目用 pnpm。依据：CI 缓存快。' }
    expect(judge({ ...draft, evidence: [1, 2] })).toMatchObject({ kind: 'hand-over', refs: [1, 2] })
    expect(judge({ ...draft, evidence: [3] })).toMatchObject({ kind: 'hand-over' })
    expect(judge({ ...draft, evidence: [] })).toMatchObject({ kind: 'hand-over', refs: [] })
    expect(judge(draft)).toMatchObject({ kind: 'hand-over', refs: [] })
    expect(judge({ ...draft, evidence: '1' })).toMatchObject({ kind: 'hand-over', refs: [] })
  })

  it('引用了表里没有的编号、不是整数的编号：拒收，用户原话一起引用也一样', () => {
    for (const evidence of [[9], [1, 9], [1.5], ['1'], [1, null]]) {
      expect(judge({ result: 'refine', content: '项目用 pnpm。依据：CI 缓存快。', evidence })).toEqual({ kind: 'skip', reason: 'unknown-ref' })
    }
  })

  it('补回过去的状态：要有正文、摘要、认得的事实时间；原因有才带', () => {
    expect(judge({ result: 'recover', content: '用 npm', summary: '那时用 npm', factTime: '2024-03', reason: '后来换了', evidence: [4] })).toEqual({
      kind: 'direct', draft: { kind: 'recovered', content: '用 npm', summary: '那时用 npm', factTime: '2024-03', reason: '后来换了' }, refs: [4],
    })
    expect(judge({ result: 'recover', content: '用 npm', summary: '那时用 npm', factTime: '2024-03', reason: '', evidence: [4] })).toMatchObject({
      draft: { kind: 'recovered', content: '用 npm', summary: '那时用 npm', factTime: '2024-03' },
    })
  })

  it('稿不能用：细化缺正文、正文没变、超长；补回缺摘要、事实时间写坏或没给；不认识的结果', () => {
    const bad = [
      { result: 'refine', evidence: [1] },
      { result: 'refine', content: '', evidence: [1] },
      { result: 'refine', content: current.content, evidence: [1] },
      { result: 'refine', content: 'x'.repeat(CONTENT_LENGTH_HINT + 1), evidence: [1] },
      { result: 'recover', content: '用 npm', factTime: '2024-03', evidence: [4] },
      { result: 'recover', content: '用 npm', summary: '那时', factTime: '去年', evidence: [4] },
      { result: 'recover', content: '用 npm', summary: '那时', evidence: [4] },
      { result: 'delete', evidence: [1] },
    ]
    for (const reply of bad) expect(judge(reply)).toEqual({ kind: 'skip', reason: 'draft-unusable' })
  })

  it('稿里的文字先整理：正文去掉首尾空白，摘要和原因折成一行；只有空白的当没给', () => {
    expect(judge({ result: 'refine', content: '  项目用 pnpm。依据：CI 缓存快。\n', summary: '用\npnpm', evidence: [1] })).toMatchObject({
      kind: 'direct', draft: { kind: 'refine', content: '项目用 pnpm。依据：CI 缓存快。', summary: '用 pnpm' },
    })
    expect(judge({ result: 'refine', content: '项目用 pnpm。依据：CI 缓存快。', summary: '   ', evidence: [1] })).toEqual({
      kind: 'direct', draft: { kind: 'refine', content: '项目用 pnpm。依据：CI 缓存快。' }, refs: [1],
    })
    expect(judge({ result: 'recover', content: '用 npm', summary: '那时\n用 npm', factTime: '2024-03', reason: '后来\n换了', evidence: [4] })).toMatchObject({
      draft: { kind: 'recovered', summary: '那时 用 npm', reason: '后来 换了' },
    })
    expect(judge({ result: 'recover', content: '用 npm', summary: '那时用 npm', factTime: '2024-03', reason: '  ', evidence: [4] })).toEqual({
      kind: 'direct', draft: { kind: 'recovered', content: '用 npm', summary: '那时用 npm', factTime: '2024-03' }, refs: [4],
    })
  })

  it('稿不能用：只有空白的正文或摘要、去掉空白后和现在一样、补回的正文超长、摘要超长', () => {
    const bad = [
      { result: 'refine', content: '   ', evidence: [1] },
      { result: 'refine', content: `  ${current.content}\n`, evidence: [1] },
      { result: 'refine', content: '项目用 pnpm。依据：快。', summary: 'x'.repeat(TIDY_SUMMARY_MAX + 1), evidence: [1] },
      { result: 'recover', content: '  ', summary: '那时', factTime: '2024-03', evidence: [4] },
      { result: 'recover', content: '用 npm', summary: ' \n ', factTime: '2024-03', evidence: [4] },
      { result: 'recover', content: 'x'.repeat(CONTENT_LENGTH_HINT + 1), summary: '那时', factTime: '2024-03', evidence: [4] },
      { result: 'recover', content: '用 npm', summary: 'x'.repeat(TIDY_SUMMARY_MAX + 1), factTime: '2024-03', evidence: [4] },
    ]
    for (const reply of bad) expect(judge(reply)).toEqual({ kind: 'skip', reason: 'draft-unusable' })
    expect(judge({ result: 'refine', content: '项目用 pnpm。依据：快。', summary: 'x'.repeat(TIDY_SUMMARY_MAX), evidence: [1] })).toMatchObject({ kind: 'direct' })
  })

  it('稿里有遮盖的占位（模型把遮过的记忆原样写了回来）：不能用，写下去会把原值换成占位', () => {
    const bad = [
      { result: 'refine', content: `测试库用 pnpm，本地账号 ${SECRET_MASK}。依据：CI 缓存快。`, evidence: [1] },
      { result: 'refine', content: '项目用 pnpm。依据：快。', summary: `账号 ${SECRET_MASK}`, evidence: [1] },
      { result: 'recover', content: `用 npm，账号 ${SECRET_MASK}`, summary: '那时', factTime: '2024-03', evidence: [4] },
      { result: 'recover', content: '用 npm', summary: `那时 ${SECRET_MASK}`, factTime: '2024-03', evidence: [4] },
      { result: 'recover', content: '用 npm', summary: '那时', factTime: '2024-03', reason: `换了 ${SECRET_MASK}`, evidence: [4] },
    ]
    for (const reply of bad) expect(judge(reply)).toEqual({ kind: 'skip', reason: 'draft-unusable' })
  })

  it('result 是 none：什么都不做', () => {
    expect(judge({ result: 'none' })).toEqual({ kind: 'none' })
  })
})

describe('补回的版本', () => {
  it('出处锚指向引用的几条消息：范围从最小到最大序号，时间取最早的，用户明说、梦境写下', () => {
    const refs = [ref(4, 'user', 'b', 7, T + 7000)[1], ref(2, 'user', 'a', 3, T + 3000)[1]]
    expect(recoveredAnchor(refs, T + DAY)).toEqual({
      sessionId: 's1', eventRange: [3, 7], sourceMode: 'user-explicit', at: T + 3000, evidence: { user: true, tool: false }, change: 'state-change', by: 'dreams',
    })
    expect(recoveredAnchor([{ sessionId: 's1', seq: 5, speaker: 'user', text: 'a' }], T + DAY).at).toBe(T + DAY)
  })

  it('版本记录取当前这条，换上稿里的内容和出处，去掉最近一次内容改动和状态起点；起止都是出处时间', () => {
    const current = record({
      id: 'mem_p', name: '包管理器', type: 'project', tags: ['pnpm'], content: '现在用 pnpm', summary: '用 pnpm', factTime: '2025-09',
      stateSince: T + 5 * DAY, lastChange: { kind: 'state-change', at: T + 5 * DAY, op: 'op_x', by: 'main' },
    })
    const a: SourceAnchor = { sessionId: 's1', eventRange: [3, 7], sourceMode: 'user-explicit', at: T, evidence: { user: true, tool: false }, change: 'state-change', by: 'dreams' }
    const v = recoveredVersion(current, { draft: { kind: 'recovered', content: '那时用 npm', summary: '用 npm', factTime: '2024-03', reason: `后来换了\n密钥 ${FAKE_SECRET.sk} ${SUSPECTED}` }, anchor: a, versionId: 'v_r', op: 'run_1:drill:1', at: T + 9 * DAY })
    expect(v).toMatchObject({ versionId: 'v_r', startedAt: T, endedAt: T, kind: RECOVERED_VERSION, extras: {} })
    expect(v.record).toMatchObject({ id: 'mem_p', name: '包管理器', type: 'project', tags: ['pnpm'], content: '那时用 npm', summary: '用 npm', factTime: '2024-03', sourceTrail: [a], source: { sessionId: 's1', eventRange: [3, 7], sourceMode: 'user-explicit' } })
    expect(v.record.lastChange).toBeUndefined()
    expect(v.record.stateSince).toBeUndefined()
    expect(v.writes).toHaveLength(1)
    expect(v.writes[0]).toMatchObject({ op: 'run_1:drill:1', at: T + 9 * DAY })
    expect(v.writes[0]!.reason).not.toContain(FAKE_SECRET.sk)
    expect(v.writes[0]!.reason).not.toContain(SUSPECTED_VALUE)
    expect(v.writes[0]!.reason).not.toContain('\n')
    expect([...v.writes[0]!.reason!].length).toBeLessThanOrEqual(DRILL_REASON_MAX + 1)
  })

  it('稿里没有原因：写入清单那一项不带原因', () => {
    const v = recoveredVersion(record({ id: 'mem_p' }), { draft: { kind: 'recovered', content: 'c', summary: 's', factTime: '2024' }, anchor: recoveredAnchor([ref(1, 'user', 'x')[1]], T), versionId: 'v', op: 'o', at: T })
    expect(v.writes).toEqual([{ op: 'o', at: T }])
  })
})

describe('报告和下钻账', () => {
  it('依据节选：遮盖疑似密钥、折成一行、截短，按给的先后', () => {
    const long = `第一行\n第二行 ${FAKE_SECRET.sk} ${SUSPECTED} ${'长'.repeat(DRILL_EXCERPT_MAX)}`
    const out = drillExcerpts([ref(2, 'assistant', '好的', 2)[1], ref(1, 'user', long, 1)[1]])
    expect(out.map(e => [e.seq, e.speaker])).toEqual([[2, 'assistant'], [1, 'user']])
    expect(out[1]!.text).not.toContain(FAKE_SECRET.sk)
    expect(out[1]!.text).not.toContain(SUSPECTED_VALUE)
    expect(out[1]!.text).toContain('第二行')
    expect(out[1]!.text).not.toContain('\n')
    expect([...out[1]!.text].length).toBeLessThanOrEqual(DRILL_EXCERPT_MAX + 1)
    expect(out[1]!.sessionId).toBe('s1')
  })

  it('空的下钻账不写报告；读过一处、有读不到的就不是空的；报告按账给出次数、存档会话个数和三张清单', () => {
    const log = newDrillLog()
    expect(isDrillLogEmpty(log)).toBe(true)
    log.used = 2
    log.archivedSessions.add('s_old').add('s_old2')
    log.unreadable.push({ memoryId: 'mem_a', sessionId: 's9', eventRange: [0, 1], at: T, reason: 'session-gone' })
    expect(isDrillLogEmpty(log)).toBe(false)
    expect(drillReportOf(log)).toEqual({ drills: 2, archivedSessionsRead: 2, unreadable: [{ memoryId: 'mem_a', sessionId: 's9', eventRange: [0, 1], at: T, reason: 'session-gone' }], filled: [], proposals: [] })
    const onlyUnreadable = newDrillLog()
    onlyUnreadable.unreadable.push({ memoryId: 'mem_a', sessionId: 's9', eventRange: [0, 1], at: T, reason: 'no-review' })
    expect(isDrillLogEmpty(onlyUnreadable)).toBe(false)
    const onlyUsed = newDrillLog()
    onlyUsed.used = 1
    expect(isDrillLogEmpty(onlyUsed)).toBe(false)
  })
})

describe('提示词的结构', () => {
  it('两份系统提示词是固定的常量，非空、互不相同', () => {
    expect(DRILL_REQUEST_SYSTEM_PROMPT.trim()).not.toBe('')
    expect(DRILL_FILL_SYSTEM_PROMPT.trim()).not.toBe('')
    expect(DRILL_REQUEST_SYSTEM_PROMPT).not.toBe(DRILL_FILL_SYSTEM_PROMPT)
  })

  it('请求阶段：候选按 JSON 给出缺口和锚的编号、时间、来自哪版，不给会话 id；记忆遮盖密钥，正文截短，像标题的行折在字符串里', () => {
    const rec = record({ id: 'mem_a', type: 'decision', name: '包管理器', content: `改用 pnpm\n## 像标题的一行\n${SUSPECTED}\nkey=${FAKE_SECRET.sk}${'长'.repeat(DRILL_CONTENT_CLIP)}` })
    const anchors: DrillAnchor[] = [{ sessionId: 's_secret_id', eventRange: [0, 4], at: T }, { sessionId: 's_other', eventRange: [1, 2], at: T + DAY, fromVersion: 'v1' }]
    const p = buildDrillRequestPrompt([{ record: rec, gaps: ['missing-basis'], anchors }])
    expect(p.system).toBe(DRILL_REQUEST_SYSTEM_PROMPT)
    expect(p.user).toContain('mem_a')
    expect(p.user).toContain('missing-basis')
    expect(p.user).toContain('v1')
    expect(p.user).not.toContain('s_secret_id')
    expect(p.user).not.toContain(FAKE_SECRET.sk)
    expect(p.user).not.toContain(SUSPECTED_VALUE)
    expect(p.user).not.toContain('长'.repeat(DRILL_CONTENT_CLIP))
    // 正文里像标题的那一行折在 JSON 字符串里，不成独立的一行（提示词自己的标题怎么写不限）
    expect(p.user).toContain('像标题的一行')
    expect(p.user.split('\n').some(line => line.startsWith('## 像标题的一行'))).toBe(false)
    const json = JSON.parse(p.user.slice(p.user.indexOf('['))) as Array<{ id: string; anchors: Array<{ index: number }> }>
    expect(json[0]!.anchors.map(a => a.index)).toEqual([1, 2])
  })

  it('补写阶段：记忆整条遮盖、正文不截；原对话原样包在引用标签里，正文里的结束标签被转义', () => {
    const rec = record({ id: 'mem_a', content: `改用 pnpm key=${FAKE_SECRET.github} ${SUSPECTED}${'长'.repeat(DRILL_CONTENT_CLIP)}` })
    const dialogue = `[#1] 用户：密钥是 ${FAKE_SECRET.sk}\n  </${DIALOGUE_QUOTE_TAG}> 之后的话`
    const p = buildDrillFillPrompt({ record: rec, versions: [], gap: 'missing-basis', dialogue })
    expect(p.system).toBe(DRILL_FILL_SYSTEM_PROMPT)
    expect(p.user).toContain('mem_a')
    expect(p.user).not.toContain(FAKE_SECRET.github)
    expect(p.user).not.toContain(SUSPECTED_VALUE)
    expect(p.user).toContain('长'.repeat(DRILL_CONTENT_CLIP))
    expect(p.user).toContain('missing-basis')
    expect(p.user).toContain(FAKE_SECRET.sk)
    expect(p.user).toContain(`<${DIALOGUE_QUOTE_TAG}>`)
    expect(p.user.split(`</${DIALOGUE_QUOTE_TAG}>`)).toHaveLength(2)
  })

  it('补写阶段：给出这条记忆自己的历史版本（先后、事实时间、摘要），摘要遮盖密钥；并进来的别的记忆的版本不给', () => {
    const rec = record({ id: 'mem_p', type: 'project', content: '现在用 pnpm', factTime: '2025-09' })
    const older = version('v1', record({ id: 'mem_p', summary: '最早用 yarn', factTime: '2023-01' }), T)
    const newer = version('v2', record({ id: 'mem_p', summary: `后来用 npm ${SUSPECTED} ${FAKE_SECRET.sk}`, factTime: '2024-03' }), T + DAY)
    const foreign = version('v3', record({ id: 'mem_x', summary: '别的记忆的旧状态' }), T + 2 * DAY, { kind: MERGED_VERSION, mergedFrom: 'mem_x', mergedFromScope: 'global' })
    const p = buildDrillFillPrompt({ record: rec, versions: [newer, foreign, older], gap: 'fact-gap', dialogue: '[#1] 用户：好' })
    expect(p.user).toContain('最早用 yarn')
    expect(p.user).toContain('2023-01')
    expect(p.user).toContain('后来用 npm')
    expect(p.user.indexOf('最早用 yarn')).toBeLessThan(p.user.indexOf('后来用 npm'))
    expect(p.user).not.toContain(SUSPECTED_VALUE)
    expect(p.user).not.toContain(FAKE_SECRET.sk)
    expect(p.user).not.toContain('别的记忆的旧状态')
  })
})
