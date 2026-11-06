// 设了 PM_SHIFT_CLOCK=1 时由 vitest.config.ts 挂上（两个项目都挂）：把「现在」整体往后平移三年跑全量，
// 写死字面日期、悄悄依赖今天日期的用例会提前挂掉。不进 CI，发版前手动跑一次。
// 平移 Date 的无参构造与 Date.now；vi.useFakeTimers() 安装时取 Date.now() 作起点，假计时器跟着一起平移。
// 文件 mtime 由文件系统按真实时间记，不跟着平移。
import { beforeEach } from 'vitest'

/** 平移量（年）。tests/shift-clock.spec.ts 按三年核对。 */
const CLOCK_SHIFT_YEARS = 3

const ORIGINAL = Symbol.for('pm.shift-clock.original')
type Marked = DateConstructor & { [ORIGINAL]?: DateConstructor }
// 同一个进程里跑多个测试文件时全局 Date 可能已被换过：取最初那个，不叠加平移
const RealDate = (globalThis.Date as Marked)[ORIGINAL] ?? globalThis.Date
const now = RealDate.now()
const shiftMs = new RealDate(now).setFullYear(new RealDate(now).getFullYear() + CLOCK_SHIFT_YEARS) - now

class ShiftedDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(RealDate.now() + shiftMs)
    else super(...(args as [string | number | Date]))
  }

  static override now(): number {
    return RealDate.now() + shiftMs
  }
}
Object.defineProperty(ShiftedDate, ORIGINAL, { value: RealDate })

globalThis.Date = ShiftedDate as DateConstructor
// vi.setSystemTime 不开假计时器时，vi.useRealTimers() 会把全局 Date 换回真实的那个：下一例开始前装回来
beforeEach(() => {
  if (globalThis.Date === RealDate) globalThis.Date = ShiftedDate as DateConstructor
})
