import { describe, expect, it } from 'vitest'
import { resolveAutoCheckup, scopeKey, type AutoCheckupFrequency, type ScopeRef } from '../src/gui/contract.ts'
import { AUTO_CHECKUP_MAX_FAILURES, AUTO_CHECKUP_RETRY_MS, autoCheckupDue, autoCheckupRetryAt, isRetryLimitReached } from '../src/governance/auto-checkups.ts'

// 自动体检的纯函数：继承解析（契约，服务端调度和客户端菜单共用）按 spec「自动体检情况表」逐行断言，以 discussion 为例；到期计算（治理层）。

const ALL: ScopeRef = { kind: 'all' }
const DISCUSSION: ScopeRef = { kind: 'workspace', workspacePath: '/work/discussion' }
const OTHER: ScopeRef = { kind: 'workspace', workspacePath: '/work/other' }
const GLOBAL: ScopeRef = { kind: 'global' }
const NEW_PROJECT: ScopeRef = { kind: 'workspace', workspacePath: '/work/new' }

/** 设置表：范围 → 设了的频率；没列的范围没有条目。 */
function settings(entries: Array<[ScopeRef, AutoCheckupFrequency]>): ReadonlyMap<string, AutoCheckupFrequency> {
  return new Map(entries.map(([scope, frequency]) => [scopeKey(scope), frequency]))
}

describe('resolveAutoCheckup：自动体检情况表', () => {
  it('什么都没设：「全部」仅手动，discussion、全局和其他项目都是仅手动（跟随）', () => {
    const s = settings([])
    expect(resolveAutoCheckup(s, ALL)).toEqual({ frequency: 'manual', isOwn: false })
    for (const scope of [DISCUSSION, GLOBAL, OTHER]) expect(resolveAutoCheckup(s, scope)).toEqual({ frequency: 'manual', isOwn: false })
  })

  it('在「全部」改成每 7 天：discussion、其他范围都每 7 天（跟随）', () => {
    const s = settings([[ALL, 7]])
    expect(resolveAutoCheckup(s, ALL)).toEqual({ frequency: 7, isOwn: false })
    expect(resolveAutoCheckup(s, DISCUSSION)).toEqual({ frequency: 7, isOwn: false })
    expect(resolveAutoCheckup(s, GLOBAL)).toEqual({ frequency: 7, isOwn: false })
  })

  it('在 discussion 单独改成每天：discussion 每天（单独设置），「全部」和其他范围仍每 7 天', () => {
    const s = settings([[ALL, 7], [DISCUSSION, 1]])
    expect(resolveAutoCheckup(s, ALL)).toEqual({ frequency: 7, isOwn: false })
    expect(resolveAutoCheckup(s, DISCUSSION)).toEqual({ frequency: 1, isOwn: true })
    expect(resolveAutoCheckup(s, OTHER)).toEqual({ frequency: 7, isOwn: false })
  })

  it('回到「全部」改成仅手动：discussion 仍每天，其他范围仅手动', () => {
    const s = settings([[ALL, 'manual'], [DISCUSSION, 1]])
    expect(resolveAutoCheckup(s, ALL)).toEqual({ frequency: 'manual', isOwn: false })
    expect(resolveAutoCheckup(s, DISCUSSION)).toEqual({ frequency: 1, isOwn: true })
    expect(resolveAutoCheckup(s, OTHER)).toEqual({ frequency: 'manual', isOwn: false })
  })

  it('discussion 改回跟随（条目删掉）：discussion 仅手动（跟随）', () => {
    const s = settings([[ALL, 'manual']])
    expect(resolveAutoCheckup(s, DISCUSSION)).toEqual({ frequency: 'manual', isOwn: false })
  })

  it('「全部」每 7 天时在 discussion 手动选每 7 天：算单独设置，之后「全部」改成每天它不跟', () => {
    expect(resolveAutoCheckup(settings([[ALL, 7], [DISCUSSION, 7]]), DISCUSSION)).toEqual({ frequency: 7, isOwn: true })
    const later = settings([[ALL, 1], [DISCUSSION, 7]])
    expect(resolveAutoCheckup(later, DISCUSSION)).toEqual({ frequency: 7, isOwn: true })
    expect(resolveAutoCheckup(later, OTHER)).toEqual({ frequency: 1, isOwn: false })
  })

  it('新加一个项目：跟随「全部」当前的值', () => {
    expect(resolveAutoCheckup(settings([[ALL, 3], [DISCUSSION, 1]]), NEW_PROJECT)).toEqual({ frequency: 3, isOwn: false })
  })
})

describe('scopeKey', () => {
  it('「全部」是 all、全局是 global、项目是它的绝对路径', () => {
    expect([ALL, GLOBAL, DISCUSSION].map(scopeKey)).toEqual(['all', 'global', '/work/discussion'])
  })
})

describe('autoCheckupDue：到期计算', () => {
  const DAY = 86_400_000
  const NOW = 1_700_000_000_000

  it('每 N 天：上次体检之后满 N × 24 小时到期，下次时间是上次加 N 天', () => {
    expect(autoCheckupDue(1, NOW - DAY + 1, NOW)).toEqual({ nextCheckupAt: NOW + 1, isDue: false })
    expect(autoCheckupDue(1, NOW - DAY, NOW)).toEqual({ nextCheckupAt: NOW, isDue: true })
    expect(autoCheckupDue(7, NOW - 25 * 3_600_000, NOW)).toEqual({ nextCheckupAt: NOW - 25 * 3_600_000 + 7 * DAY, isDue: false })
  })

  it('错过很多个周期也只是到期，下次时间不往后推', () => {
    expect(autoCheckupDue(1, NOW - 10 * DAY, NOW)).toEqual({ nextCheckupAt: NOW - 9 * DAY, isDue: true })
  })

  it('从没体检过：立刻到期，没有下次时间', () => {
    expect(autoCheckupDue(30, null, NOW)).toEqual({ nextCheckupAt: null, isDue: true })
  })

  it('仅手动：从不到期', () => {
    expect(autoCheckupDue('manual', null, NOW)).toEqual({ nextCheckupAt: null, isDue: false })
    expect(autoCheckupDue('manual', NOW - 100 * DAY, NOW)).toEqual({ nextCheckupAt: null, isDue: false })
  })
})

describe('autoCheckupRetryAt：自动体检失败后的重试时间', () => {
  const DAY = 86_400_000
  const HOUR = 3_600_000
  const FAILED_AT = 1_700_000_000_000

  it('第 1、2 次连续失败：1 小时后再试', () => {
    expect(AUTO_CHECKUP_RETRY_MS).toBe(HOUR)
    expect(autoCheckupRetryAt(1, FAILED_AT, 7)).toBe(FAILED_AT + HOUR)
    expect(autoCheckupRetryAt(2, FAILED_AT, 7)).toBe(FAILED_AT + HOUR)
    expect(isRetryLimitReached(1)).toBe(false)
    expect(isRetryLimitReached(2)).toBe(false)
  })

  it('连续失败到第 3 次：等到下一个周期（失败时刻加有效频率的天数）', () => {
    expect(AUTO_CHECKUP_MAX_FAILURES).toBe(3)
    expect(autoCheckupRetryAt(3, FAILED_AT, 7)).toBe(FAILED_AT + 7 * DAY)
    expect(autoCheckupRetryAt(3, FAILED_AT, 1)).toBe(FAILED_AT + DAY)
    expect(isRetryLimitReached(3)).toBe(true)
  })

  it('下一个周期又失败：这个周期照样 1 小时后再试，第 3 次再等下个周期', () => {
    expect(autoCheckupRetryAt(4, FAILED_AT, 7)).toBe(FAILED_AT + HOUR)
    expect(autoCheckupRetryAt(5, FAILED_AT, 7)).toBe(FAILED_AT + HOUR)
    expect(autoCheckupRetryAt(6, FAILED_AT, 7)).toBe(FAILED_AT + 7 * DAY)
    expect(isRetryLimitReached(6)).toBe(true)
  })
})
