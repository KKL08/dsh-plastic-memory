import { describe, expect, it, vi } from 'vitest'

// 设了 PM_SHIFT_CLOCK=1 跑全量时，「现在」确实往后平移了三年：平移静默失效时这里会红。没设就跳过。
const isShifted = process.env.PM_SHIFT_CLOCK === '1'
/** 真实的当前时间：performance 的时间原点不随 Date 平移。 */
const realNow = () => performance.timeOrigin + performance.now()
const yearsAhead = (ms: number) => (ms - realNow()) / (365.25 * 86_400_000)

describe.skipIf(!isShifted)('系统时间平移三年', () => {
  it('PA-48 Date.now、new Date() 与假计时器的起点都比真实时间晚三年；换回真计时器后仍平移', () => {
    expect(yearsAhead(Date.now())).toBeCloseTo(3, 1)
    expect(yearsAhead(new Date().getTime())).toBeCloseTo(3, 1)
    const real = realNow()
    vi.useFakeTimers()
    try {
      expect((Date.now() - real) / (365.25 * 86_400_000)).toBeCloseTo(3, 1)
    } finally {
      vi.useRealTimers()
    }
    expect(yearsAhead(Date.now())).toBeCloseTo(3, 1)
  })
})
