import { describe, expect, it } from 'vitest'
import { stalenessNote, withinValidity } from '../src/record-freshness.ts'
import type { MemoryRecord } from '../src/record-schema.ts'
import { NOW as T0, DAY } from './helpers/clock.ts'

// 全部使用固定时间戳（无 Date.now()）。DAY = 一天的毫秒数。

function record(partial: Partial<MemoryRecord>): MemoryRecord {
  return {
    id: 'mem_x', name: '条目', type: 'knowledge', scope: 'global',
    tags: [], content: '内容', summary: '摘要',
    source: { sessionId: 's1', eventRange: [0, 1], sourceMode: 'user-explicit' },
    createdAt: T0, updatedAt: T0, lastConfirmedAt: T0, lastRecalledAt: null,
    recallCount: 0, status: 'active', confidence: 0.9, ...partial,
  }
}

// stalenessNote 边缘案例（每条一个 it）：
// 1. decayDays === null：该类型不衰减，即便久未确认也返回空串。
// 2. 恰好过 decayDays 天：days === decayDays，用 > 判定 → 不标注（守 > 而非 >=）。
// 3. 超过 decayDays 整一天：明确陈旧 → 非空标注。
// 4. 越界不足一整天：floor 后仍等于 decayDays → 不标注（守 floor，非 ceil/round）。
// 5. 陈旧度按 lastConfirmedAt 计，不按 updatedAt：updatedAt 新、lastConfirmedAt 旧 → 陈旧。
describe('stalenessNote', () => {
  it('decayDays 为 null：不衰减，久未确认也返回空串', () => {
    const r = record({ lastConfirmedAt: T0 })
    expect(stalenessNote(r, null, T0 + 100 * DAY)).toBe('')
  })

  it('恰好过 decayDays 天：不标注（边界用 > 而非 >=）', () => {
    const r = record({ lastConfirmedAt: T0 })
    expect(stalenessNote(r, 10, T0 + 10 * DAY)).toBe('')
  })

  it('超过 decayDays 整一天：返回非空标注', () => {
    const r = record({ lastConfirmedAt: T0 })
    expect(stalenessNote(r, 10, T0 + 11 * DAY)).not.toBe('')
  })

  it('越界不足一整天：floor 后仍等于 decayDays，不标注', () => {
    const r = record({ lastConfirmedAt: T0 })
    expect(stalenessNote(r, 10, T0 + 10 * DAY + DAY / 2)).toBe('')
  })

  it('陈旧度按 lastConfirmedAt 计，不按 updatedAt', () => {
    const now = T0 + 100 * DAY
    const r = record({ lastConfirmedAt: T0, updatedAt: now })
    expect(stalenessNote(r, 10, now)).not.toBe('')
  })
})

// withinValidity 边缘案例（每条一个 it）：
// 1. validTo === undefined：无失效时间，恒有效。
// 2. validTo === now：边界，用 >= 判定 → 仍有效。
// 3. validTo < now：已过失效时间 → 无效。
// 4. validTo > now：尚未失效 → 有效。
describe('withinValidity', () => {
  it('validTo 缺省：恒有效', () => {
    expect(withinValidity(record({}), T0)).toBe(true)
  })

  it('validTo 恰等于 now：仍有效（边界用 >=）', () => {
    expect(withinValidity(record({ validTo: T0 }), T0)).toBe(true)
  })

  it('validTo 早于 now：已失效', () => {
    expect(withinValidity(record({ validTo: T0 - 1 }), T0)).toBe(false)
  })

  it('validTo 晚于 now：有效', () => {
    expect(withinValidity(record({ validTo: T0 + 1 }), T0)).toBe(true)
  })
})
