import { describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import { assertSerialEquivalent, describeOrder, interleaveParams, interleaveRuns, interleaveScheduler, type Step } from './helpers/interleave.ts'
import { memorySubject, seedArb, writeOpArb, type MemOp } from './helpers/memory-subject.ts'

// 文件系统是进程边界：存储层 import 的 node:fs/promises 换成夹具包过的那份，调用的全序交给调度器（见 helpers/interleave.ts）
vi.mock('node:fs/promises', async () => (await import('./helpers/interleave.ts')).interleavedFs)

// 三个操作的串行顺序多、单次贵，缺省少跑几次，整个文件在跑全量测试的负载下也在 5 秒内；调大 PM_INTERLEAVE_RUNS 时按次数放宽
const DEFAULT_RUNS = 12
const TIMEOUT_MS = Math.max(20_000, interleaveRuns(DEFAULT_RUNS) * 600)

describe('IL-01 强制模板', () => {
  it('界面就地编辑 × 模型改写同一条，串行等价，且搜到的交错对上不止一种串行顺序', async () => {
    // 按对上的串行顺序里「界面（G）、模型（M）谁先、谁被拆开」归类计数；只有一类说明调度没起作用
    const tally = new Map<string, number>()
    const classOf = (order: Step[]) => describeOrder(order.filter(st => st.index < 2)).replaceAll('0', 'G').replaceAll('1', 'M')
    await fc.assert(
      fc.asyncProperty(seedArb.filter(sd => sd.a !== 'deleted'), fc.boolean(), fc.option(writeOpArb, { nil: undefined }), interleaveScheduler(),
        async (seed, isForced, extra, s) => {
          const ops: MemOp[] = [{ kind: 'guiEdit', id: 'a' }, { kind: 'modelRewrite', id: 'a', isForced }, ...(extra === undefined ? [] : [extra])]
          const eq = await assertSerialEquivalent(memorySubject(seed), s, ops)
          const c = classOf(eq.order)
          tally.set(c, (tally.get(c) ?? 0) + 1)
        }),
      interleaveParams(DEFAULT_RUNS),
    )
    console.info(`[IL-01 模板] 对上的串行顺序分布：${JSON.stringify(Object.fromEntries(tally))}`)
    expect(tally.size).toBeGreaterThanOrEqual(2)
  }, TIMEOUT_MS)
})
