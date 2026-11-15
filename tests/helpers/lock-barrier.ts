import type { RootLock } from '../../src/root-lock.ts'
import { signal, waitForSignal } from './signal-files.ts'

export interface BarrierOptions {
  /** 信号目录（signal-files.ts）。 */
  dir: string
  /** 信号名前缀，两个进程各用各的，例如 `a`、`b`。 */
  name: string
  /** 第 n 次 run 拿到锁后要不要停住；缺省每次都停。 */
  pause?: (n: number) => boolean
}

/**
 * 写锁的屏障装饰器：套在真锁外面，跨进程用例拿它固定交错，不靠 sleep。
 * 第 n 次 run（从 1 数，嵌套、并发的也各算一次）：
 *   - 进入 run、还没拿锁：发 `<name>.<n>.arrived`；
 *   - 拿到锁、执行 fn 之前：发 `<name>.<n>.held`；要停时等 `<name>.<n>.go` 再执行 fn。
 */
export function barrierLock(inner: RootLock, opts: BarrierOptions): RootLock {
  const pause = opts.pause ?? (() => true)
  let count = 0
  return {
    async run<T>(fn: () => Promise<T>): Promise<T> {
      const n = ++count
      await signal(opts.dir, `${opts.name}.${n}.arrived`)
      return inner.run(async () => {
        await signal(opts.dir, `${opts.name}.${n}.held`)
        if (pause(n)) await waitForSignal(opts.dir, `${opts.name}.${n}.go`)
        return fn()
      })
    },
  }
}
