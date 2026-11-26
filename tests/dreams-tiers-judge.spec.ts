import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  OLDER_BOUND_NOTE_HEAD, OLDER_BOUND_NOTE_TAIL, TIER_SYSTEM_PROMPT, buildTierPrompt, contentAnchorOf, dispositionOf, factOrder, factTimeInterval,
  isImportant, isKnownTier, isUserStated, judgeConfidence, olderBoundNote, pairBasis, parseTierReply, resolveTier, tierConclusion, tierPlan,
  type ConfidenceInput, type EvidenceKind, type TierReply,
} from '../src/governance/dreams-tiers.ts'
import { conclusionOfGroup, mergeConclusion, mergeGroupId, resolveGroupId } from '../src/governance/dreams-merge.ts'
import { VERDICTS_BY_KIND, resolveVerdictsOf } from '../src/governance/schema.ts'
import { DIALOGUE_QUOTE_TAG } from '../src/search/dialogue-format.ts'
import { CONTENT_LENGTH_HINT } from '../src/save-signals.ts'
import { TIDY_SUMMARY_MAX, oneLine } from '../src/governance/dreams-tidy.ts'
import { isLegacyAnchor, type MemoryRecord, type SourceAnchor } from '../src/record-schema.ts'
import { record } from './helpers/record.ts'
import { FAKE_SECRET } from './helpers/secrets.ts'

// 记忆梦境处理矛盾的判定：先后（溯源定界、精度）、「有把握」五条、「重要」、档位分流，都是纯函数；本机时区固定成新加坡（UTC+8）。

const ZONE = 'Asia/Singapore'
const saved = process.env.TZ
beforeAll(() => { process.env.TZ = ZONE })
afterAll(() => { if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved })

/** 新加坡本机时间的毫秒数（UTC+8，没有夏令时）。 */
const local = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0) => Date.UTC(y, mo - 1, d, h - 8, mi, s)

/** 新版本写下的锚（带 change，同 stampAnchor）。 */
const anchor = (partial: Partial<SourceAnchor> = {}): SourceAnchor => ({ sessionId: 's1', eventRange: [1, 1], sourceMode: 'user-explicit', at: local(2025, 3, 1, 9), change: 'create', by: 'main', ...partial })
/** 去掉 change 的锚：更早版本写进清单的、或手改漏了 change 的。 */
const unstamped = (partial: Partial<SourceAnchor> = {}): SourceAnchor => {
  const { change: _change, ...rest } = anchor(partial)
  return rest
}
/** 只有出处清单、没有旧式 source 的记忆。 */
const mem = (id: string, partial: Partial<MemoryRecord> = {}): MemoryRecord => {
  const { source: _source, ...rest } = record({ id, name: `${id} 名称`, content: `${id} 正文`, type: 'decision', sourceTrail: [anchor()], ...partial })
  return partial.source !== undefined ? { ...rest, source: partial.source } : rest
}

describe('事实时间换成区间', () => {
  it('只到年、月、日的按本机时区换成整年、整月、整天', () => {
    expect(factTimeInterval('2025')).toEqual({ start: local(2025, 1, 1), end: local(2026, 1, 1) })
    expect(factTimeInterval('2025-02')).toEqual({ start: local(2025, 2, 1), end: local(2025, 3, 1) })
    expect(factTimeInterval('2025-03-01')).toEqual({ start: local(2025, 3, 1), end: local(2025, 3, 2) })
  })

  it('带时刻的：写到分是那一分钟，写到秒是那一秒，小数按写到的位数', () => {
    expect(factTimeInterval('2025-03-01T10:02')).toEqual({ start: local(2025, 3, 1, 10, 2), end: local(2025, 3, 1, 10, 3) })
    expect(factTimeInterval('2025-03-01 10:02:30')).toEqual({ start: local(2025, 3, 1, 10, 2, 30), end: local(2025, 3, 1, 10, 2, 31) })
    expect(factTimeInterval('2025-03-01T10:02:30.5Z')).toEqual({ start: Date.UTC(2025, 2, 1, 10, 2, 30, 500), end: Date.UTC(2025, 2, 1, 10, 2, 30, 600) })
    expect(factTimeInterval('2025-03-01T10:02:30.123Z')).toEqual({ start: Date.UTC(2025, 2, 1, 10, 2, 30, 123), end: Date.UTC(2025, 2, 1, 10, 2, 30, 124) })
  })

  it('带时区偏移的按偏移换算，正负号都认', () => {
    expect(factTimeInterval('2025-03-01T10:00+00:00')?.start).toBe(Date.UTC(2025, 2, 1, 10, 0))
    expect(factTimeInterval('2025-03-01T10:02-05:30')?.start).toBe(Date.UTC(2025, 2, 1, 15, 32))
    expect(factTimeInterval('2025-03-01T10:02+0530')?.start).toBe(Date.UTC(2025, 2, 1, 4, 32))
  })

  it('小数超过 3 位的截到毫秒，区间宽 1 毫秒', () => {
    expect(factTimeInterval('2025-03-01T10:02:30.1234Z')).toEqual({ start: Date.UTC(2025, 2, 1, 10, 2, 30, 123), end: Date.UTC(2025, 2, 1, 10, 2, 30, 124) })
    expect(factTimeInterval('2025-03-01T10:02:30.123456789Z')).toEqual({ start: Date.UTC(2025, 2, 1, 10, 2, 30, 123), end: Date.UTC(2025, 2, 1, 10, 2, 30, 124) })
    expect(factTimeInterval('2025-03-01T10:02:30.0001Z')).toEqual({ start: Date.UTC(2025, 2, 1, 10, 2, 30), end: Date.UTC(2025, 2, 1, 10, 2, 30, 1) })
  })

  it('带偏移的终点同样按偏移换算', () => {
    expect(factTimeInterval('2025-03-01T10:02+05:30')).toEqual({ start: Date.UTC(2025, 2, 1, 4, 32), end: Date.UTC(2025, 2, 1, 4, 33) })
    expect(factTimeInterval('2025-03-01T10:02:30-05:00')).toEqual({ start: Date.UTC(2025, 2, 1, 15, 2, 30), end: Date.UTC(2025, 2, 1, 15, 2, 31) })
  })

  it('0 到 99 年按字面的年份算', () => {
    const utc = (y: number, mo: number, d: number, h = 0, mi = 0) => { const t = new Date(0); t.setUTCFullYear(y, mo - 1, d); t.setUTCHours(h, mi, 0, 0); return t.getTime() }
    expect(factTimeInterval('0050-01-01T00:00Z')).toEqual({ start: utc(50, 1, 1), end: utc(50, 1, 1, 0, 1) })
    const year = factTimeInterval('0050')!
    expect(new Date(year.start).getFullYear()).toBe(50)
    expect(new Date(year.end).getFullYear()).toBe(51)
    expect(year.end - year.start).toBe(365 * 86_400_000)
  })

  it('年、月、日的终点按日历加一：有夏令时的时区里那一天是 23 小时', () => {
    process.env.TZ = 'America/New_York'
    try {
      const day = factTimeInterval('2025-03-09')!
      expect(day.end - day.start).toBe(23 * 3_600_000)
      expect(new Date(day.end).getDate()).toBe(10)
      expect(new Date(day.end).getHours()).toBe(0)
    } finally {
      process.env.TZ = ZONE
    }
  })

  it('不认识的写法返回 undefined', () => {
    expect(factTimeInterval('2025-03-01')).toBeDefined()
    expect(factTimeInterval('2025-13')).toBeUndefined()
    expect(factTimeInterval('上周三')).toBeUndefined()
  })
})

describe('先后清楚：溯源定界', () => {
  const said = local(2025, 3, 1, 15)

  it.each([
    ['新的晚于旧的', '2025-06-01', '2025-03-01', 'clear'],
    ['两条一样', '2025-03-01', '2025-03-01', 'not-later'],
    ['区间重叠（整月包着那一天）', '2025-03', '2025-03-15', 'not-later'],
    ['新的反而更早', '2025-02-01', '2025-03-01', 'not-later'],
  ] as const)('两条都有事实时间：%s', (_name, newer, older, expected) => {
    const r = factOrder({ newer: { factTime: newer }, older: { factTime: older }, olderSaidAt: said })
    expect(r.kind === 'clear' ? 'clear' : r.reason).toBe(expected)
    // 旧的一方有事实时间时不拿出处时间当上限
    if (r.kind === 'clear') expect(r.olderBoundAt).toBeUndefined()
  })

  it('旧的没填、出处上限早于新的事实时间：清楚，上限记成 olderBoundAt', () => {
    expect(factOrder({ newer: { factTime: '2025-03-02' }, older: {}, olderSaidAt: said })).toEqual({ kind: 'clear', olderBoundAt: said })
  })

  it.each([
    ['上限晚于新的事实时间', local(2025, 3, 3)],
    ['上限正好是新的区间起点', local(2025, 3, 2)],
  ])('旧的没填、%s：分不清', (_name, at) => {
    expect(factOrder({ newer: { factTime: '2025-03-02' }, older: {}, olderSaidAt: at })).toEqual({ kind: 'unclear', reason: 'not-later' })
  })

  it('新的没填事实时间：分不清', () => {
    expect(factOrder({ newer: {}, older: { factTime: '2025-01-01' }, olderSaidAt: said })).toEqual({ kind: 'unclear', reason: 'newer-missing' })
  })

  it('两条都没填：分不清', () => {
    expect(factOrder({ newer: {}, older: {}, olderSaidAt: said })).toEqual({ kind: 'unclear', reason: 'newer-missing' })
  })

  it('旧的没填事实时间、带生效时间：出处时间不算上限，分不清', () => {
    // 同样的上限，去掉生效时间就是清楚的
    expect(factOrder({ newer: { factTime: '2025-06-01' }, older: {}, olderSaidAt: said }).kind).toBe('clear')
    expect(factOrder({ newer: { factTime: '2025-06-01' }, older: { validFrom: local(2025, 1, 1) }, olderSaidAt: said })).toEqual({ kind: 'unclear', reason: 'older-valid-from' })
  })

  it('旧的没填、出处时间不知道：分不清', () => {
    expect(factOrder({ newer: { factTime: '2025-06-01' }, older: {} })).toEqual({ kind: 'unclear', reason: 'older-source-unknown' })
  })
})

describe('先后清楚：精度不同的事实时间', () => {
  const order = (newer: string, older: string) => {
    const r = factOrder({ newer: { factTime: newer }, older: { factTime: older } })
    return r.kind === 'clear' ? 'clear' : r.reason
  }

  it('同一天只写到日的两条：分不清', () => {
    expect(order('2025-03-01', '2025-03-01')).toBe('not-later')
  })

  it('同一小时里写到分钟、前后差几分钟：清楚', () => {
    expect(order('2025-03-01T10:05', '2025-03-01T10:02')).toBe('clear')
  })

  it('写到分的对写到秒的、秒落在那一分钟里：分不清', () => {
    expect(order('2025-03-01T10:02:30', '2025-03-01T10:02')).toBe('not-later')
  })

  it('相邻两天：清楚', () => {
    expect(order('2025-03-02', '2025-03-01')).toBe('clear')
  })

  it('带偏移的和不带时区的混比：不带的按本机时区（UTC+8）', () => {
    // 旧的是 UTC 10:00，即本机 18:00
    expect(order('2025-03-01T17:30', '2025-03-01T10:00+00:00')).toBe('not-later')
    expect(order('2025-03-01T18:01', '2025-03-01T10:00+00:00')).toBe('clear')
  })

  it('写法不同的同一时刻：分不清', () => {
    expect(order('2025-03-01T18:00+08:00', '2025-03-01T10:00Z')).toBe('not-later')
    expect(order('2025-03-01T18:00', '2025-03-01T10:00Z')).toBe('not-later')
    expect(order('2025-03-01T18:01', '2025-03-01T10:00Z')).toBe('clear')
  })

  it('新的只写到日、出处上限是同一天里的某一刻：分不清', () => {
    const r = factOrder({ newer: { factTime: '2025-03-01' }, older: {}, olderSaidAt: local(2025, 3, 1, 15) })
    expect(r).toEqual({ kind: 'unclear', reason: 'not-later' })
  })
})

describe('出处上限的说明', () => {
  it('写成固定的开头、本机日期、固定的结尾，不是事实时间的写法', () => {
    const note = olderBoundNote(Date.UTC(2025, 2, 1, 20, 0))
    expect(note.startsWith(OLDER_BOUND_NOTE_HEAD)).toBe(true)
    expect(note.endsWith(OLDER_BOUND_NOTE_TAIL)).toBe(true)
    // UTC 20:00 是本机第二天 04:00
    expect(note).toContain('2025-03-02')
    expect(note).not.toContain('2025-03-01')
    expect(OLDER_BOUND_NOTE_HEAD).not.toBe('')
    expect(OLDER_BOUND_NOTE_TAIL).not.toBe('')
  })
})

describe('内容锚与来源', () => {
  it('写出当前内容的锚是最新的不是补证的那个', () => {
    const content = anchor({ sessionId: 's-content', change: 'state-change', at: local(2025, 3, 1) })
    const corroborate = anchor({ sessionId: 's-later', change: 'corroborate', at: local(2025, 5, 1) })
    expect(contentAnchorOf(mem('a', { sourceTrail: [corroborate, content] }))).toEqual(content)
  })

  it('只有补证锚、或没有出处时没有内容锚', () => {
    expect(contentAnchorOf(mem('a', { sourceTrail: [anchor()] }))).toBeDefined()
    expect(contentAnchorOf(mem('a', { sourceTrail: [anchor({ change: 'corroborate' })] }))).toBeUndefined()
    expect(contentAnchorOf(mem('a', { sourceTrail: [] }))).toBeUndefined()
  })

  it('旧版本只写了 source 的：它当成内容锚，时间取修改时间', () => {
    const r = mem('a', { sourceTrail: undefined, source: { sessionId: 's-old', eventRange: [3, 4], sourceMode: 'user-explicit' }, updatedAt: local(2025, 4, 1) })
    expect(contentAnchorOf(r)).toMatchObject({ sessionId: 's-old', eventRange: [3, 4], at: local(2025, 4, 1) })
  })

  it('旧版本的锚：没有 change 的都算，合成的、清单里没盖 change 的、手改漏了的', () => {
    const legacy = mem('a', { sourceTrail: undefined, source: { sessionId: 's-old', eventRange: [3, 4], sourceMode: 'user-explicit' }, updatedAt: local(2025, 4, 1) })
    expect(isLegacyAnchor(contentAnchorOf(legacy)!)).toBe(true)
    const trailed = mem('b', { sourceTrail: [anchor()] })
    expect(isLegacyAnchor(contentAnchorOf(trailed)!)).toBe(false)
    expect(isLegacyAnchor(anchor({ change: 'state-change' }))).toBe(false)
    expect(isLegacyAnchor(unstamped())).toBe(true)
    // source 和清单头一个对不上：补在最前的那个是合成的；清单里盖过 change 的不是
    const both = mem('c', { sourceTrail: [anchor({ sessionId: 's-trail' })], source: { sessionId: 's-newer', eventRange: [8, 9], sourceMode: 'user-explicit' }, updatedAt: local(2025, 5, 1) })
    expect(isLegacyAnchor(contentAnchorOf(both)!)).toBe(true)
    expect(isLegacyAnchor(both.sourceTrail![0]!)).toBe(false)
  })

  it('任一锚是用户明说就算来源是用户明说', () => {
    const observed = anchor({ sourceMode: 'environment-observed', change: 'corroborate' })
    expect(isUserStated(mem('a', { sourceTrail: [observed, anchor({ sourceMode: 'user-explicit' })] }))).toBe(true)
    expect(isUserStated(mem('a', { sourceTrail: [observed, anchor({ sourceMode: 'agent-inferred' })] }))).toBe(false)
    expect(isUserStated(mem('a', { sourceTrail: [] }))).toBe(false)
  })
})

describe('重要', () => {
  const focus = ['preference', 'profile', 'decision']

  it('来源是用户明说、类型在重点类型里：重要', () => {
    expect(isImportant(mem('a', { type: 'decision' }), focus)).toBe(true)
  })

  it('类型不在重点类型里：不重要', () => {
    expect(isImportant(mem('a', { type: 'decision' }), focus)).toBe(true)
    expect(isImportant(mem('a', { type: 'knowledge' }), focus)).toBe(false)
  })

  it('来源不是用户明说（手建、模型推断）：不重要', () => {
    expect(isImportant(mem('a', { type: 'preference' }), focus)).toBe(true)
    expect(isImportant(mem('a', { type: 'preference', sourceTrail: [anchor({ sourceMode: 'agent-inferred' })] }), focus)).toBe(false)
    expect(isImportant(mem('a', { type: 'preference', sourceTrail: [] }), focus)).toBe(false)
  })

  it('用户明说的锚被一次环境观察补证之后仍算重要', () => {
    const trail = [anchor({ sourceMode: 'environment-observed', change: 'corroborate' }), anchor({ sourceMode: 'user-explicit' })]
    expect(isImportant(mem('a', { type: 'profile', sourceTrail: trail }), focus)).toBe(true)
  })

  it('重点类型按配置：设成空就没有重要的', () => {
    expect(isImportant(mem('a', { type: 'decision' }), focus)).toBe(true)
    expect(isImportant(mem('a', { type: 'decision' }), [])).toBe(false)
  })
})

describe('档位取值', () => {
  it.each([
    ['trust', 'trust'], ['gatekeep', 'gatekeep'], ['以后的档位', 'gatekeep'], [undefined, 'gatekeep'], [3, 'gatekeep'],
  ] as const)('%s → %s', (raw, expected) => {
    expect(resolveTier(raw)).toBe(expected)
  })
})

describe('档位是不是认得的取值', () => {
  it.each([
    ['trust', true], ['gatekeep', true], ['以后的档位', false], ['', false], [undefined, false], [3, false],
  ] as const)('%s → %s', (raw, expected) => {
    expect(isKnownTier(raw)).toBe(expected)
  })
})

describe('模型回复', () => {
  it('读出 JSON 对象（允许包在代码围栏里），uncertain 收成 isUncertain', () => {
    const r = parseTierReply('```json\n{"ids":["a","b"],"subject":"包管理器","dimension":"用哪个","compatible":false,"newer":"b","change":"state-change","uncertain":true,"evidence":[1,2],"reason":"改了"}\n```')
    expect(r).toEqual({ ids: ['a', 'b'], subject: '包管理器', dimension: '用哪个', compatible: false, newer: 'b', change: 'state-change', isUncertain: true, evidence: [1, 2], reason: '改了' })
  })

  it('字段类型不对的当没给，其余照收', () => {
    const r = parseTierReply('{"ids":["a","b"],"subject":"x","compatible":"no","newer":"b"}')
    expect(r).toEqual({ ids: ['a', 'b'], subject: 'x', newer: 'b' })
  })

  it('改动性质给成两种时原样收下，交给判定', () => {
    expect(parseTierReply('{"change":["state-change","correct"]}')?.change).toEqual(['state-change', 'correct'])
  })

  it('不是 JSON 对象：读不出', () => {
    expect(parseTierReply('{"ok":true}')).toBeDefined()
    expect(parseTierReply('我觉得是状态变化')).toBeUndefined()
    expect(parseTierReply('[1,2]')).toBeUndefined()
  })
})

describe('有把握：五个条件', () => {
  const older = mem('mem_old', { factTime: '2025-03-01', sourceTrail: [anchor({ sourceMode: 'agent-inferred' })] })
  const newer = mem('mem_new', { factTime: '2025-06-01' })
  const good: TierReply = { ids: ['mem_new', 'mem_old'], subject: '包管理器', dimension: '用哪个', compatible: false, newer: 'mem_new', change: 'state-change', evidence: [1, 3], reason: '用户说改用 pnpm' }
  const kinds = new Map<number, EvidenceKind>([[1, 'user'], [2, 'other'], [3, 'tool'], [4, 'memory'], [5, 'plugin'], [6, 'unknown']])
  const input = (reply: Partial<TierReply> = {}, extra: Partial<ConfidenceInput> = {}): ConfidenceInput =>
    ({ reply: { ...good, ...reply }, pair: [older, newer], evidence: kinds, canChange: () => true, ...extra })
  const doubt = (i: ConfidenceInput) => { const r = judgeConfidence(i); return r.isConfident ? 'confident' : r.doubt }

  it('五条都满足：有把握，带出新旧两条、改动性质和引用的编号', () => {
    const r = judgeConfidence(input())
    expect(r).toEqual({ isConfident: true, change: 'state-change', newer, older, order: { kind: 'clear' }, evidence: [1, 3] })
  })

  it('不是这一对、或新的一方不在这一对里：不算同一主体', () => {
    expect(doubt(input())).toBe('confident')
    expect(doubt(input({ ids: ['mem_new', 'mem_x'] }))).toBe('pair-mismatch')
    expect(doubt(input({ ids: ['mem_new'] }))).toBe('pair-mismatch')
    expect(doubt(input({ newer: 'mem_x' }))).toBe('pair-mismatch')
  })

  it('主体、维度缺了，或说能同时成立：不算有把握', () => {
    expect(doubt(input())).toBe('confident')
    expect(doubt(input({ subject: undefined }))).toBe('not-same-dimension')
    expect(doubt(input({ dimension: '' }))).toBe('not-same-dimension')
    expect(doubt(input({ compatible: true }))).toBe('not-same-dimension')
    expect(doubt(input({ compatible: undefined }))).toBe('not-same-dimension')
  })

  it('改动性质不在四种里、标了不确定、给了两种：不算有把握', () => {
    expect(doubt(input())).toBe('confident')
    expect(doubt(input({ change: 'delete' }))).toBe('change-unclear')
    expect(doubt(input({ change: undefined }))).toBe('change-unclear')
    expect(doubt(input({ isUncertain: true }))).toBe('change-unclear')
    expect(doubt(input({ change: ['state-change', 'correct'] }))).toBe('change-unclear')
  })

  it('补证、细化不是要处理的变化：交给用户', () => {
    expect(doubt(input({ change: 'correct' }))).toBe('confident')
    expect(doubt(input({ change: 'refine' }))).toBe('not-a-change')
    expect(doubt(input({ change: 'corroborate' }))).toBe('not-a-change')
  })

  it('没引用依据、或引用了表里没有的编号：不算有把握', () => {
    expect(doubt(input())).toBe('confident')
    expect(doubt(input({ evidence: [] }))).toBe('evidence-missing')
    expect(doubt(input({ evidence: undefined }))).toBe('evidence-missing')
    expect(doubt(input({ evidence: [1, 99] }))).toBe('evidence-unknown-ref')
    expect(doubt(input({ evidence: [1.5] }))).toBe('evidence-unknown-ref')
    expect(doubt(input({ evidence: ['1'] }))).toBe('evidence-unknown-ref')
  })

  it('依据只有另一条记忆（读记忆文件的结果）：不算有把握', () => {
    expect(doubt(input({ evidence: [1] }))).toBe('confident')
    expect(doubt(input({ evidence: [4] }))).toBe('evidence-not-qualified')
  })

  it('依据只有本插件工具的结果：不算有把握', () => {
    expect(doubt(input({ evidence: [3] }))).toBe('confident')
    expect(doubt(input({ evidence: [5] }))).toBe('evidence-not-qualified')
  })

  it('引用里混着助手的话、判不了的工具结果：整对不算有把握', () => {
    expect(doubt(input({ evidence: [1, 3] }))).toBe('confident')
    expect(doubt(input({ evidence: [1, 2] }))).toBe('evidence-not-qualified')
    expect(doubt(input({ evidence: [1, 6] }))).toBe('evidence-not-qualified')
  })

  it('先后分不清：交给用户', () => {
    expect(doubt(input())).toBe('confident')
    expect(doubt(input({}, { pair: [{ ...older, factTime: '2025-06-01' }, newer] }))).toBe('order-unclear')
    expect(doubt(input({}, { pair: [older, { ...newer, factTime: undefined }] }))).toBe('order-unclear')
  })

  it('双方都是用户明说且分不清先后：单列原因，交给用户', () => {
    const userOlder = { ...older, factTime: '2025-06-01', sourceTrail: [anchor({ sourceMode: 'user-explicit' })] }
    expect(doubt(input({}, { pair: [{ ...userOlder, factTime: '2025-03-01' }, newer] }))).toBe('confident')
    expect(doubt(input({}, { pair: [userOlder, newer] }))).toBe('both-user-unclear')
  })

  it('旧的没填事实时间时用它内容锚的时间当上限，清楚时带出上限', () => {
    const bound = local(2025, 4, 1)
    const noFact = { ...older, factTime: undefined, sourceTrail: [anchor({ change: 'corroborate', at: local(2025, 7, 1) }), anchor({ sourceMode: 'agent-inferred', at: bound })] }
    const r = judgeConfidence(input({}, { pair: [noFact, newer] }))
    expect(r).toMatchObject({ isConfident: true, order: { kind: 'clear', olderBoundAt: bound } })
    // 补证锚的时间（晚于新的一方）不当上限
  })

  it('旧版本的锚（合成的、缺 change 的）的时间不当旧的一方说话的时间：先后分不清', () => {
    const early = local(2025, 1, 1)
    const legacyOlder = { ...older, factTime: undefined, sourceTrail: undefined, source: { sessionId: 's-old', eventRange: [1, 1] as [number, number], sourceMode: 'agent-inferred' as const }, updatedAt: early }
    const trailedOlder = { ...older, factTime: undefined, sourceTrail: [anchor({ sourceMode: 'agent-inferred', at: early })] }
    // 清单里的锚缺 change（手改漏了、更早版本写的）：同样按旧版本的锚，有意保守
    const unstampedOlder = { ...older, factTime: undefined, sourceTrail: [unstamped({ sourceMode: 'agent-inferred', at: early })] }
    expect(doubt(input({}, { pair: [trailedOlder, newer] }))).toBe('confident')
    expect(doubt(input({}, { pair: [legacyOlder, newer] }))).toBe('order-unclear')
    expect(doubt(input({}, { pair: [unstampedOlder, newer] }))).toBe('order-unclear')
  })

  it('ids 去重后才比，两个 id 一样不算这一对；主体、维度只有空白不算', () => {
    expect(doubt(input())).toBe('confident')
    expect(doubt(input({ ids: ['mem_old', 'mem_old'] }))).toBe('pair-mismatch')
    expect(doubt(input({ ids: ['mem_new', 'mem_new'] }))).toBe('pair-mismatch')
    expect(doubt(input({ ids: ['mem_new', 'mem_old', 'mem_old'] }))).toBe('confident')
    expect(doubt(input({ subject: '   ' }))).toBe('not-same-dimension')
    expect(doubt(input({ dimension: '\n' }))).toBe('not-same-dimension')
  })

  it('引用的编号去重，按第一次出现的顺序带出', () => {
    const r = judgeConfidence(input({ evidence: [3, 1, 3, 1] }))
    expect(r).toMatchObject({ isConfident: true, evidence: [3, 1] })
  })

  it('超出这次运行的改动量上限：不算有把握', () => {
    expect(doubt(input())).toBe('confident')
    expect(doubt(input({}, { canChange: id => id !== 'mem_old' }))).toBe('quota')
  })

  it('按顺序查，返回第一条没过的', () => {
    expect(doubt(input({ compatible: true, change: 'delete', evidence: [] }))).toBe('not-same-dimension')
    expect(doubt(input({ change: 'delete', evidence: [] }))).toBe('change-unclear')
    expect(doubt(input({ evidence: [4] }, { canChange: () => false }))).toBe('evidence-not-qualified')
  })

  it('新旧按模型给的 newer 定，和条目里的顺序无关', () => {
    const r = judgeConfidence(input({}, { pair: [newer, older] }))
    expect(r).toMatchObject({ isConfident: true, newer: { id: 'mem_new' }, older: { id: 'mem_old' } })
  })
})

describe('档位分流', () => {
  it.each([
    [true, true, 'gatekeep', 'hold'],
    [true, true, 'trust', 'apply'],
    [true, false, 'gatekeep', 'apply'],
    [true, false, 'trust', 'apply'],
    [false, true, 'gatekeep', 'hand-over'],
    [false, true, 'trust', 'hand-over'],
    [false, false, 'gatekeep', 'hand-over'],
    [false, false, 'trust', 'hand-over'],
  ] as const)('有把握=%s、重要=%s、%s档 → %s', (isConfident, isImportant, tier, expected) => {
    expect(dispositionOf({ isLocked: false, isConfident, isImportant, tier })).toBe(expected)
  })

  it.each(['gatekeep', 'trust'] as const)('任一方锁定：%s档都通知用户，不管有没有把握、重不重要', (tier) => {
    expect(dispositionOf({ isLocked: false, isConfident: true, isImportant: false, tier })).toBe('apply')
    for (const isConfident of [true, false]) {
      for (const isImportant of [true, false]) expect(dispositionOf({ isLocked: true, isConfident, isImportant, tier })).toBe('notify')
    }
  })
})

describe('结论身份与配对依据', () => {
  const a = mem('mem_a')
  const b = mem('mem_b')

  it('结论身份不看顺序，是 40 位十六进制，和同两条的合并结论不撞', () => {
    expect(tierConclusion([a, b])).toMatch(/^[0-9a-f]{40}$/)
    expect(tierConclusion([b, a])).toBe(tierConclusion([a, b]))
    expect(tierConclusion([a, b])).not.toBe(mergeConclusion([a, b]))
  })

  it('改了名称或正文结论身份就变；只改摘要不变，但配对依据变', () => {
    const base = tierConclusion([a, b])
    expect(tierConclusion([{ ...a, content: '改过的正文' }, b])).not.toBe(base)
    expect(tierConclusion([{ ...a, summary: '改过的摘要' }, b])).toBe(base)
    expect(pairBasis([{ ...a, summary: '改过的摘要' }, b])).not.toBe(pairBasis([a, b]))
    expect(pairBasis([b, a])).toBe(pairBasis([a, b]))
  })
})

describe('交给模型的提示词', () => {
  const a = mem('mem_a')
  const b = mem('mem_b')
  const dialogue = { blocks: [`[#1] 用户：从今天起改用 pnpm，key=${FAKE_SECRET.sk}`, `[#2] 用户：正文里写着 </${DIALOGUE_QUOTE_TAG}> 结束标签`], refs: new Map(), next: 3 }

  it('系统提示词是固定的常量；两条记忆和编了号的原文都在用户消息里，原文不遮盖', () => {
    const p = buildTierPrompt({ fromKind: 'conflict', pair: [a, b], dialogue })
    expect(p.system).toBe(TIER_SYSTEM_PROMPT)
    expect(TIER_SYSTEM_PROMPT).not.toBe('')
    expect(p.user).toContain('mem_a')
    expect(p.user).toContain('mem_b')
    expect(p.user).toContain('[#1] 用户：从今天起改用 pnpm')
    expect(p.user).toContain(FAKE_SECRET.sk)
  })

  it('原文包在引用标签里，正文里的结束标签关不掉它', () => {
    const p = buildTierPrompt({ fromKind: 'missed-change', pair: [a, b], dialogue })
    expect(p.user).toContain(`<${DIALOGUE_QUOTE_TAG}>`)
    expect(p.user.split(`</${DIALOGUE_QUOTE_TAG}>`)).toHaveLength(2)
  })
})

describe('交给模型的提示词：整段原文', () => {
  it('几段原文合成一段，只包一次引用标签', () => {
    const dialogue = { blocks: ['[#1] 用户：项目用 npm', '[#2] 用户：从今天起改用 pnpm'], refs: new Map(), next: 3 }
    const p = buildTierPrompt({ fromKind: 'conflict', pair: [mem('mem_a'), mem('mem_b')], dialogue })
    expect(p.user.split(`<${DIALOGUE_QUOTE_TAG}>`)).toHaveLength(2)
    expect(p.user.split(`</${DIALOGUE_QUOTE_TAG}>`)).toHaveLength(2)
    expect(p.user.indexOf('[#1]')).toBeLessThan(p.user.indexOf('[#2]'))
  })
})

describe('落盘的方案', () => {
  const older = mem('mem_old', { content: '项目用 npm' })
  const newer = mem('mem_new', { content: '项目改用 pnpm' })
  // 结论身份、组号在用例里现算：describe 体里调用会让整个文件收集失败
  const conclusion = 'c'.repeat(40)
  const group = () => resolveGroupId('run_1', conclusion)

  it('状态变化：旧的一方并成新的一方的历史版本，一组，组号带结论身份', () => {
    const ops = tierPlan({ runId: 'run_1', conclusion, change: 'state-change', newer, older })!
    expect(ops).toHaveLength(1)
    expect(ops[0]).toMatchObject({ kind: 'forget', memoryId: 'mem_old', into: { memoryId: 'mem_new', as: 'version' }, group: group() })
    expect(ops[0]!.basis.map(x => x.memoryId).sort()).toEqual(['mem_new', 'mem_old'])
  })

  it('纠错：改写旧的一方，改动性质是纠错，依据是两条', () => {
    const ops = tierPlan({ runId: 'run_1', conclusion, change: 'correct', newer, older, draft: { content: '项目用 pnpm（当初记成 npm 是记错了）', summary: '用 pnpm' } })!
    expect(ops).toHaveLength(1)
    expect(ops[0]).toMatchObject({ kind: 'edit', memoryId: 'mem_old', change: 'correct', group: group(), patch: { content: '项目用 pnpm（当初记成 npm 是记错了）', summary: '用 pnpm' } })
    expect(ops[0]!.basis.map(x => x.memoryId).sort()).toEqual(['mem_new', 'mem_old'])
  })

  it('纠错稿不能用：没给正文、和原文一样、超长、名称是空串', () => {
    expect(tierPlan({ runId: 'run_1', conclusion, change: 'correct', newer, older, draft: { content: '改好的' } })).toBeDefined()
    expect(tierPlan({ runId: 'run_1', conclusion, change: 'correct', newer, older })).toBeUndefined()
    expect(tierPlan({ runId: 'run_1', conclusion, change: 'correct', newer, older, draft: { summary: '只有摘要' } })).toBeUndefined()
    expect(tierPlan({ runId: 'run_1', conclusion, change: 'correct', newer, older, draft: { content: '项目用 npm' } })).toBeUndefined()
    expect(tierPlan({ runId: 'run_1', conclusion, change: 'correct', newer, older, draft: { content: '长'.repeat(CONTENT_LENGTH_HINT + 1) } })).toBeUndefined()
    expect(tierPlan({ runId: 'run_1', conclusion, change: 'correct', newer, older, draft: { content: '改好的', name: '' } })).toBeUndefined()
  })
})

describe('落盘的方案：纠错稿的校验', () => {
  const older = mem('mem_old', { content: '项目用 npm\n第二行' })
  const newer = mem('mem_new', { content: '项目改用 pnpm' })
  const conclusion = 'c'.repeat(40)
  const plan = (draft: TierReply['draft']) => tierPlan({ runId: 'run_1', conclusion, change: 'correct', newer, older, ...(draft !== undefined ? { draft } : {}) })
  const patchOf = (draft: TierReply['draft']) => (plan(draft)?.[0] as { patch?: Record<string, unknown> } | undefined)?.patch

  it('正文只有空白、和原文只差换行符写法：不能用', () => {
    expect(plan({ content: '改好的' })).toBeDefined()
    expect(plan({ content: '   \n ' })).toBeUndefined()
    expect(plan({ content: '项目用 npm\r\n第二行' })).toBeUndefined()
    expect(plan({ content: '项目用 npm\r第二行' })).toBeUndefined()
  })

  it('正文去掉首尾空白再用', () => {
    expect(patchOf({ content: '  改好的正文\n' })).toMatchObject({ content: '改好的正文' })
  })

  it('名称、摘要折成一行再用；名称折后为空、摘要超长不能用', () => {
    expect(patchOf({ content: '改好的', name: '新名称\n# 第二行', summary: '摘要\n第二行' })).toMatchObject({ name: oneLine('新名称\n# 第二行'), summary: oneLine('摘要\n第二行') })
    expect(plan({ content: '改好的', name: ' \n\t ' })).toBeUndefined()
    expect(plan({ content: '改好的', summary: '长'.repeat(TIDY_SUMMARY_MAX) })).toBeDefined()
    expect(plan({ content: '改好的', summary: '长'.repeat(TIDY_SUMMARY_MAX + 1) })).toBeUndefined()
  })
})

describe('处理矛盾的组号', () => {
  const conclusion = 'c'.repeat(40)

  it('组号带这次运行的 id 和结论身份，标记和合并组分开；撤销时两种组号都取得回结论身份', () => {
    const group = resolveGroupId('run_1', conclusion)
    expect(group.startsWith('run_1')).toBe(true)
    expect(group).toContain(':resolve:')
    expect(group).not.toBe(mergeGroupId('run_1', conclusion))
    expect(conclusionOfGroup(group)).toBe(conclusion)
    expect(conclusionOfGroup(mergeGroupId('run_1', conclusion))).toBe(conclusion)
    expect(conclusionOfGroup(`run_1:other:${conclusion}`)).toBeUndefined()
    expect(conclusionOfGroup('pd_1')).toBeUndefined()
  })
})

describe('可用的裁决', () => {
  const hold = (fromKind: 'conflict' | 'missed-change', proposal?: object) => ({ fromKind, ...(proposal !== undefined ? { proposal } : {}) })

  it('配对和其余发现照原来的表', () => {
    expect(resolveVerdictsOf({ kind: 'conflict' })).toEqual(VERDICTS_BY_KIND.conflict)
    expect(resolveVerdictsOf({})).toEqual(VERDICTS_BY_KIND.conflict)
    expect(resolveVerdictsOf({ kind: 'missed-change' })).toEqual(VERDICTS_BY_KIND['missed-change'])
    expect(resolveVerdictsOf({ kind: 'cross-duplicate' })).toEqual(VERDICTS_BY_KIND['cross-duplicate'])
  })

  it('「重要、等你定」带方案：最前是采纳，后面是原来那种发现的全部裁决', () => {
    expect(resolveVerdictsOf({ kind: 'important-pending', dreamsHold: hold('conflict', { ops: [] }) })).toEqual(['adopt', ...VERDICTS_BY_KIND.conflict])
    expect(resolveVerdictsOf({ kind: 'important-pending', dreamsHold: hold('missed-change', { ops: [] }) })).toEqual(['adopt', ...VERDICTS_BY_KIND['missed-change']])
  })

  it('「重要、等你定」没有方案（锁定通知）：只有原来那种发现的裁决', () => {
    expect(resolveVerdictsOf({ kind: 'important-pending', dreamsHold: hold('conflict') })).toEqual(VERDICTS_BY_KIND.conflict)
    expect(resolveVerdictsOf({ kind: 'important-pending', dreamsHold: hold('conflict') })).not.toContain('adopt')
  })

  it('没有 dreamsHold 的「重要、等你定」（手改出来的、读不懂的）：只能不采纳', () => {
    expect(resolveVerdictsOf({ kind: 'important-pending' })).toEqual(['dismiss'])
  })

  it('不是发现的种类没有可用的裁决', () => {
    expect(resolveVerdictsOf({ kind: 'promote-candidate' })).toEqual([])
    expect(resolveVerdictsOf({ kind: 'brewing-dreams-run' })).toEqual([])
  })
})
