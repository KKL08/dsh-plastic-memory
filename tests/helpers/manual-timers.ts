/**
 * 注入给被测代码的手动计时器：setTimeout 只登记、不真等。测试 await scheduled() 等到有计时器挂上，
 * 再 fire() 触发最早那个。elapsed 是已触发计时器的时长之和，即被测代码眼里过去了多久。
 */
export interface ManualTimers {
  setTimeout(fn: () => void, ms: number): void
  /** 等到至少有一个未触发的计时器，返回最早那个的时长。 */
  scheduled(): Promise<number>
  /** 触发最早挂上的计时器；没有挂着的计时器时抛错。 */
  fire(): void
  readonly pending: number
  readonly fired: number
  readonly elapsed: number
}

export function manualTimers(): ManualTimers {
  const queue: Array<{ fn: () => void; ms: number }> = []
  let waiters: Array<() => void> = []
  let fired = 0
  let elapsed = 0
  return {
    setTimeout(fn, ms) {
      queue.push({ fn, ms })
      for (const wake of waiters.splice(0)) wake()
    },
    async scheduled() {
      while (queue.length === 0) await new Promise<void>(resolve => { waiters.push(resolve) })
      return queue[0]!.ms
    },
    fire() {
      const next = queue.shift()
      if (next === undefined) throw new Error('没有挂着的计时器')
      fired++
      elapsed += next.ms
      next.fn()
    },
    get pending() { return queue.length },
    get fired() { return fired },
    get elapsed() { return elapsed },
  }
}

/** 反复触发计时器，直到 promise 落定（兑现或拒绝）；返回时不抛，结果由调用方再 await。 */
export async function fireUntilSettled(promise: Promise<unknown>, timers: ManualTimers): Promise<void> {
  let settled = false
  const done = promise.then(() => { settled = true }, () => { settled = true })
  for (;;) {
    await Promise.race([done, timers.scheduled()])
    if (settled) return
    timers.fire()
  }
}
