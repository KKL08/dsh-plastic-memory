import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { formatValidity, parseValidityInput } from '../src/validity.ts'

// 有效期按本机时区解释与展示。期望值用 new Date(年, 月, 日, 时, 分) 在同一时区里算，结果与机器时区无关；
// 「不是 UTC」的那几条单独固定到东八区，免得在 UTC 机器上恒真。
const local = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime()
const WRITE_AT = local(2026, 10, 29, 14, 37) + 20_500   // 写入时刻带秒和毫秒：补时分时只取 HH:mm

describe('parseValidityInput', () => {
  it('YYYY-MM-DD HH:mm 按本机时间换算成毫秒', () => {
    expect(parseValidityInput('2026-10-29 15:00', WRITE_AT)).toEqual({ ok: true, ms: local(2026, 10, 29, 15, 0) })
    expect(parseValidityInput('2027-02-28 00:05', WRITE_AT)).toEqual({ ok: true, ms: local(2027, 2, 28, 0, 5) })
  })

  it('只有日期：补上写入时刻的本机时分（秒、毫秒不要）', () => {
    expect(parseValidityInput('2026-11-05', WRITE_AT)).toEqual({ ok: true, ms: local(2026, 11, 5, 14, 37) })
  })

  it.each([
    ['带秒', '2026-10-29 15:00:00'],
    ['T 分隔', '2026-10-29T15:00'],
    ['带时区后缀', '2026-10-29 15:00Z'],
    ['带偏移', '2026-10-29 15:00+08:00'],
    ['ISO 毫秒', '2026-10-29T07:00:00.000Z'],
    ['斜杠日期', '2026/10/29 15:00'],
    ['一位数月份', '2026-1-05 15:00'],
    ['一位数小时', '2026-10-29 9:00'],
    ['数字字符串', '1793203200000'],
    ['空串', ''],
    ['自然语言', '明天下午三点'],
  ])('格式不对（%s）→ validity-format', (_label, text) => {
    expect(parseValidityInput(text, WRITE_AT)).toEqual({ ok: false, code: 'validity-format' })
  })

  it.each([[1793203200000], [null], [true]])('不是字符串（%s）→ validity-format', (value) => {
    expect(parseValidityInput(value, WRITE_AT)).toEqual({ ok: false, code: 'validity-format' })
  })

  it.each([
    ['2 月 30 日', '2026-02-30 10:00'],
    ['平年 2 月 29 日', '2027-02-29'],
    ['13 月', '2026-13-01 10:00'],
    ['0 日', '2026-10-00'],
    ['25 点', '2026-10-29 25:00'],
    ['24 点', '2026-10-29 24:00'],
    ['60 分', '2026-10-29 10:60'],
  ])('日期或时刻不存在（%s）→ validity-nonexistent', (_label, text) => {
    expect(parseValidityInput(text, WRITE_AT)).toEqual({ ok: false, code: 'validity-nonexistent' })
  })

  it('闰年 2 月 29 日存在', () => {
    expect(parseValidityInput('2028-02-29 08:00', WRITE_AT)).toEqual({ ok: true, ms: local(2028, 2, 29, 8, 0) })
  })
})

describe('formatValidity', () => {
  it('毫秒 → 本机时间 YYYY-MM-DD HH:mm，补零、丢秒', () => {
    expect(formatValidity(local(2026, 1, 5, 9, 3) + 59_999)).toBe('2026-01-05 09:03')
    expect(formatValidity(local(2026, 12, 31, 23, 59))).toBe('2026-12-31 23:59')
  })

  it('与 parseValidityInput 互逆', () => {
    for (const text of ['2026-10-29 15:00', '2030-06-01 00:00', '2026-12-31 23:59']) {
      const parsed = parseValidityInput(text, WRITE_AT)
      if (!parsed.ok) throw new Error(parsed.code)
      expect(formatValidity(parsed.ms)).toBe(text)
    }
  })
})

describe('按本机时区（固定东八区）', () => {
  const saved = process.env.TZ
  beforeAll(() => { process.env.TZ = 'Asia/Shanghai' })
  afterAll(() => { if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved })

  it('解析与展示都按本机时间，不按 UTC', () => {
    expect(parseValidityInput('2026-10-29 15:00', 0)).toEqual({ ok: true, ms: Date.UTC(2026, 9, 29, 7, 0) })
    expect(formatValidity(Date.UTC(2026, 9, 29, 7, 0))).toBe('2026-10-29 15:00')
    // 只有日期：补的是写入时刻的本机时分（UTC 06:37 = 东八区 14:37）
    expect(parseValidityInput('2026-11-05', Date.UTC(2026, 9, 29, 6, 37, 20))).toEqual({ ok: true, ms: Date.UTC(2026, 10, 5, 6, 37) })
  })
})
