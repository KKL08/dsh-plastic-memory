import { describe, expect, it } from 'vitest'
import {
  DREAMS_DEFAULTS, countChanges, dreamContentFingerprint, dreamsGate, resolveDreamsEnabled, usageWithin,
  type DreamsGateInput,
} from '../src/governance/dreams-gate.ts'
import { record } from './helpers/record.ts'

// 记忆梦境什么时候可以开始：范围开关的取值和四道门槛，都是纯函数，时钟由调用方给

const DAY = 86_400_000
const NOW = 1_800_000_000_000
const WS = '/proj/a'

describe('范围开关', () => {
  const settings = (entries: Record<string, boolean>) => new Map(Object.entries(entries))
  it('单独设过的用它自己的，没设过的跟随默认值，默认值没设是关', () => {
    const ws = { kind: 'workspace', workspacePath: WS } as const
    const global = { kind: 'global' } as const
    expect(resolveDreamsEnabled(settings({}), ws)).toEqual({ isEnabled: false, isOwn: false })
    expect(resolveDreamsEnabled(settings({ all: true }), ws)).toEqual({ isEnabled: true, isOwn: false })
    expect(resolveDreamsEnabled(settings({ all: true, [WS]: false }), ws)).toEqual({ isEnabled: false, isOwn: true })
    expect(resolveDreamsEnabled(settings({ [WS]: true }), ws)).toEqual({ isEnabled: true, isOwn: true })
    expect(resolveDreamsEnabled(settings({ [WS]: true }), global)).toEqual({ isEnabled: false, isOwn: false })
    expect(resolveDreamsEnabled(settings({ all: false, global: true }), global)).toEqual({ isEnabled: true, isOwn: true })
  })
})

describe('内容指纹与变化计数', () => {
  it('名称、摘要、正文、事实时间、有效期、取代关系变了才算变；确认时间、来源方式、召回统计不算', () => {
    const base = record({ id: 'mem_a', name: '甲', summary: '摘要', content: '正文' })
    const same = [
      { ...base, lastConfirmedAt: 99, updatedAt: 99, recallCount: 7, lastRecalledAt: 5 },
      { ...base, source: { sessionId: 's2', eventRange: [3, 4] as [number, number], sourceMode: 'agent-inferred' as const } },
      { ...base, tags: ['x'] },
    ]
    for (const r of same) expect(dreamContentFingerprint(r)).toBe(dreamContentFingerprint(base))
    const changed = [
      { ...base, name: '乙' }, { ...base, summary: '另一个摘要' }, { ...base, content: '另一段正文' },
      { ...base, factTime: '2026-11' }, { ...base, validFrom: 1 }, { ...base, validTo: 2 }, { ...base, supersedes: ['mem_old'] },
    ]
    for (const r of changed) expect(dreamContentFingerprint(r), JSON.stringify(r)).not.toBe(dreamContentFingerprint(base))
  })

  it('新增、删掉、内容变了各算一条，同一条只算一次；没有基线时每条在用记忆算一条', () => {
    const a = record({ id: 'mem_a' })
    const b = record({ id: 'mem_b' })
    const c = record({ id: 'mem_c' })
    const marks = { mem_a: dreamContentFingerprint(a), mem_b: dreamContentFingerprint(b), mem_gone: 'x' }
    const current = { mem_a: dreamContentFingerprint(a), mem_b: dreamContentFingerprint({ ...b, content: '改了' }), mem_c: dreamContentFingerprint(c) }
    expect(countChanges(marks, current)).toBe(3)
    expect(countChanges(marks, marks)).toBe(0)
    expect(countChanges(undefined, current)).toBe(3)
    expect(countChanges(undefined, {})).toBe(0)
  })
})

describe('七天用量', () => {
  it('只数最近 7×24 小时内的运行', () => {
    const runs = [{ at: NOW - 8 * DAY, tokens: 1000 }, { at: NOW - 7 * DAY + 1, tokens: 20 }, { at: NOW - 1, tokens: 3 }]
    expect(usageWithin(runs, NOW)).toBe(23)
    expect(usageWithin([], NOW)).toBe(0)
  })
})

describe('四道门槛', () => {
  const ok: DreamsGateInput = {
    now: NOW,
    config: DREAMS_DEFAULTS,
    record: { completed: { runId: 'r1', startedAt: NOW - 8 * DAY - 10, endedAt: NOW - 8 * DAY } },
    changes: DREAMS_DEFAULTS.minChanges,
    usageRuns: [],
    isIdle: true,
  }
  const gate = (over: Partial<DreamsGateInput>) => dreamsGate({ ...ok, ...over })

  it('都满足：过', () => {
    expect(gate({})).toEqual({ pass: true })
  })

  it('第 1 道：没满间隔不过；满了但没有够多的变化、消息，上次也做完了，不过', () => {
    expect(gate({ record: { completed: { runId: 'r1', startedAt: NOW - 6 * DAY, endedAt: NOW - 6 * DAY } } })).toMatchObject({ pass: false, gate: 1, reason: 'too-soon' })
    expect(gate({ changes: DREAMS_DEFAULTS.minChanges - 1 })).toMatchObject({ pass: false, gate: 1, reason: 'no-changes' })
    expect(gate({ changes: 0, unreviewedMessages: DREAMS_DEFAULTS.minNewMessages - 1 })).toMatchObject({ pass: false, gate: 1, reason: 'no-changes' })
  })

  it('第 1 道的两种计数各自够了都算：变了的记忆够多，或没回看的用户消息够多', () => {
    expect(gate({ changes: DREAMS_DEFAULTS.minChanges, unreviewedMessages: 0 })).toEqual({ pass: true })
    expect(gate({ changes: 0, unreviewedMessages: DREAMS_DEFAULTS.minNewMessages })).toEqual({ pass: true })
  })

  it('从没做完过：视同已满间隔，仍要有够多的内容', () => {
    expect(gate({ record: {} })).toEqual({ pass: true })
    expect(gate({ record: undefined, changes: 1 })).toMatchObject({ pass: false, gate: 1, reason: 'no-changes' })
  })

  it('上次没做完：不看变化数，也不看间隔，空闲了就接着做（手动运行让路之后也一样）', () => {
    const unfinished = { runId: 'r2', startedAt: NOW - 60_000, stoppedAt: NOW - 30_000, reason: 'yielded' }
    const old = { runId: 'r1', startedAt: NOW - 8 * DAY, endedAt: NOW - 8 * DAY }
    const recent = { runId: 'r1', startedAt: NOW - DAY, endedAt: NOW - DAY }
    expect(gate({ record: { completed: old, unfinished }, changes: 0 })).toEqual({ pass: true })
    expect(gate({ record: { completed: recent, unfinished }, changes: 0 })).toEqual({ pass: true })
  })

  it('基线不可用（做完过但对不上）：不知道变了多少，按够数算；还没读记忆时这一条先不判', () => {
    expect(gate({ changes: 'unknown' })).toEqual({ pass: true })
    expect(gate({ changes: undefined })).toEqual({ pass: true })
    expect(gate({ changes: undefined, record: { completed: { runId: 'r1', startedAt: NOW - DAY, endedAt: NOW - DAY } } })).toMatchObject({ pass: false, reason: 'too-soon' })
  })

  it('连续出错：1 小时后再试，连着 3 次后等满一个间隔', () => {
    const unfinished = { runId: 'r2', startedAt: NOW - 100, stoppedAt: NOW - 100, reason: 'failed' }
    const failed = (count: number, ago: number) => gate({ record: { ...ok.record, unfinished, failure: { count, failedAt: NOW - ago } } })
    expect(failed(1, 59 * 60_000)).toMatchObject({ pass: false, gate: 1, reason: 'retry-later' })
    expect(failed(1, 60 * 60_000)).toEqual({ pass: true })
    expect(failed(3, 6 * DAY)).toMatchObject({ pass: false, gate: 1, reason: 'retry-later' })
    expect(failed(3, 7 * DAY)).toEqual({ pass: true })
  })

  it('第 4 道：七天用量到了上限不过；上限为 0 不限', () => {
    const usageRuns = [{ at: NOW - DAY, tokens: DREAMS_DEFAULTS.weeklyTokenCap }]
    expect(gate({ usageRuns })).toMatchObject({ pass: false, gate: 4, reason: 'over-budget' })
    expect(gate({ usageRuns, config: { ...DREAMS_DEFAULTS, weeklyTokenCap: 0 } })).toEqual({ pass: true })
    expect(gate({ usageRuns: [{ at: NOW - 8 * DAY, tokens: DREAMS_DEFAULTS.weeklyTokenCap }] })).toEqual({ pass: true })
  })

  it('第 2 道：不空闲不过；没给（调用方还没查）时只判前面两道', () => {
    expect(gate({ isIdle: false })).toMatchObject({ pass: false, gate: 2, reason: 'busy' })
    expect(gate({ isIdle: undefined })).toEqual({ pass: true })
  })

  it('按 1、4、2 的顺序报第一道没过的', () => {
    const usageRuns = [{ at: NOW - DAY, tokens: DREAMS_DEFAULTS.weeklyTokenCap }]
    expect(gate({ changes: 0, usageRuns, isIdle: false })).toMatchObject({ gate: 1 })
    expect(gate({ usageRuns, isIdle: false })).toMatchObject({ gate: 4 })
  })

  it('手动运行：不看间隔、变化和空闲，用量照查', () => {
    const usageRuns = [{ at: NOW - DAY, tokens: DREAMS_DEFAULTS.weeklyTokenCap }]
    expect(gate({ isManual: true, changes: 0, isIdle: false, record: { completed: { runId: 'r', startedAt: NOW - 1, endedAt: NOW } } })).toEqual({ pass: true })
    expect(gate({ isManual: true, usageRuns })).toMatchObject({ pass: false, gate: 4 })
  })
})
