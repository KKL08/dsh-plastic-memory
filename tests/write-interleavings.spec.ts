import { describe, it, vi } from 'vitest'
import fc from 'fast-check'
import { withInterleaveCase, assertSerialEquivalent, interleaveParams, interleaveRuns, interleaveScheduler } from './helpers/interleave.ts'
import { memorySubject, seedArb, writeOpArb } from './helpers/memory-subject.ts'

// 文件系统是进程边界：存储层 import 的 node:fs/promises 换成夹具包过的那份，调用的全序交给调度器（见 helpers/interleave.ts）
vi.mock('node:fs/promises', async () => (await import('./helpers/interleave.ts')).interleavedFs)

// 单次贵，缺省次数比别处少；调大 PM_INTERLEAVE_RUNS 时按次数放宽
const DEFAULT_RUNS = 25
const TIMEOUT_MS = Math.max(20_000, interleaveRuns(DEFAULT_RUNS) * 600)

describe('IL-01 记忆写路径', () => {
  it('IL-01：create / update / 模型改写 / 界面就地编辑 / 软删 / 恢复 / 彻底删除 / 提升任取 2–3 个并发，结果与盘面和某个串行顺序一致', async ({ signal }) => withInterleaveCase(signal, async () => {
    await fc.assert(
      fc.asyncProperty(seedArb, fc.array(writeOpArb, { minLength: 2, maxLength: 3 }), interleaveScheduler(),
        async (seed, ops, s) => { await assertSerialEquivalent(memorySubject(seed), s, ops) }),
      interleaveParams(DEFAULT_RUNS),
    )
  }), TIMEOUT_MS)
})
