import fc from 'fast-check'
import { phasedScheduler, type TaskScheduler } from './interleave.ts'

/** 输入最多六项；按长度穷举，不要求失败具有单调性。最短仅指固定调度下原输入的子序列。 */
export async function shortestFailure<T>(input: readonly T[], fails: (xs: T[]) => Promise<boolean>): Promise<T[]> {
  for (let size = 0; size < input.length; size++) {
    const visit = async (start: number, picked: T[]): Promise<T[] | undefined> => {
      if (picked.length === size) return await fails(picked) ? picked : undefined
      for (let i = start; i <= input.length - (size - picked.length); i++) {
        const found = await visit(i + 1, [...picked, input[i]!])
        if (found !== undefined) return found
      }
      return undefined
    }
    const found = await visit(0, [])
    if (found !== undefined) return found
  }
  return [...input]
}

/** 同一种子生成输入及逐次文件调用的偏好；重放不依赖运行耗时。 */
export function sequenceCase<T>(seed: number, arbitrary: fc.Arbitrary<T>, writers = 2) {
  return fc.sample(fc.tuple(arbitrary, fc.array(fc.integer({ min: 0, max: writers - 1 }), { minLength: 64, maxLength: 64 })), { seed, numRuns: 1 })[0]!
}

export function sequenceScheduler(turns: readonly number[]): TaskScheduler {
  return phasedScheduler(turns.map(op => ({ op, until: () => true })))
}

/** 失败时在全新世界重放子序列，输出种子、最短输入、固定调度与原始错误。 */
export async function checkSequence<T>(seed: number, input: readonly T[], turns: readonly number[], run: (xs: readonly T[], scheduler: TaskScheduler) => Promise<void>): Promise<void> {
  try { await run(input, sequenceScheduler(turns)) } catch (cause) {
    const minimal = await shortestFailure(input, async xs => {
      try { await run(xs, sequenceScheduler(turns)); return false } catch { return true }
    })
    throw new Error(`种子：${seed}\n最短失败子序列：${JSON.stringify(minimal)}\n调度：${JSON.stringify(turns)}`, { cause })
  }
}
