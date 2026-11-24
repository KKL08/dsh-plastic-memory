import { describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import { assertSerialEquivalent, describeOrder, headStartArb, interleaveParams, interleaveRuns, interleaveScheduler, tallyOrder, type Step } from './helpers/interleave.ts'
import { initArb, memorySubject, seedArb, snapshotIdsArb, writeOpArb, type MemOp, type Seed } from './helpers/memory-subject.ts'

// 文件系统是进程边界：存储层 import 的 node:fs/promises 换成夹具包过的那份，调用的全序交给调度器（见 helpers/interleave.ts）
vi.mock('node:fs/promises', async () => (await import('./helpers/interleave.ts')).interleavedFs)

// 三个操作的串行顺序多、单次贵，缺省少跑几次，整个文件在跑全量测试的负载下也在 5 秒内；调大 PM_INTERLEAVE_RUNS 时按次数放宽
const DEFAULT_RUNS = 10
const TIMEOUT_MS = Math.max(20_000, interleaveRuns(DEFAULT_RUNS) * 600)

describe('强制模板', () => {
  it('界面就地编辑 × 模型改写同一条，串行等价，且搜到的交错对上不止一种串行顺序', async () => {
    // 按对上的串行顺序里「界面（G）、模型（M）谁先、谁被拆开」归类计数；只有一类说明调度没起作用
    const tally = new Map<string, number>()
    const classOf = (order: Step[]) => describeOrder(order.filter(st => st.index < 2)).replaceAll('0', 'G').replaceAll('1', 'M')
    await fc.assert(
      // 模型改写在锁内按最新版落盘，界面先写完它照样写得进去；界面要排到后面，得让它晚开始（模型改写不延后）
      fc.asyncProperty(seedArb.filter(sd => sd.a !== 'deleted'), fc.boolean(), fc.option(writeOpArb, { nil: undefined }), fc.nat(400), interleaveScheduler(),
        async (seed, allowsSecret, extra, guiDelay, s) => {
          const ops: MemOp[] = [{ kind: 'guiEdit', id: 'a' }, { kind: 'modelRewrite', id: 'a', allowsSecret }, ...(extra === undefined ? [] : [extra])]
          const eq = await assertSerialEquivalent(memorySubject(seed), s, ops, [guiDelay, 0])
          const c = classOf(eq.order)
          tally.set(c, (tally.get(c) ?? 0) + 1)
        }),
      interleaveParams(DEFAULT_RUNS),
    )
    console.info(`[IL-01 模板] 对上的串行顺序分布：${JSON.stringify(Object.fromEntries(tally))}`)
    expect(tally.size).toBeGreaterThanOrEqual(2)
  }, TIMEOUT_MS)

  it('精确修改 × 别处直接改写同一条：精确修改在别处改过的正文上重做时，结果同样和某个串行顺序对得上', async () => {
    // 改写夹在精确修改的读和写之间时，精确修改被拆开比（0读→1→0写）；一次都没拆开说明没搜到重做那一支
    const tally = new Map<string, number>()
    await fc.assert(
      fc.asyncProperty(headStartArb(2, 300), interleaveScheduler(), async (head, s) => {
        const ops: MemOp[] = [{ kind: 'preciseEdit', id: 'a' }, { kind: 'update', id: 'a' }]
        const eq = await assertSerialEquivalent(memorySubject({ a: 'workspace', b: 'workspace', isSameName: false }), s, ops, head)
        const c = describeOrder(eq.order)
        tally.set(c, (tally.get(c) ?? 0) + 1)
      }),
      interleaveParams(DEFAULT_RUNS * 2),
    )
    console.info(`[精确修改 × 直接改写] 对上的串行顺序分布：${JSON.stringify(Object.fromEntries(tally))}`)
    expect([...tally.keys()].some(order => order.includes('读'))).toBe(true)
  }, TIMEOUT_MS * 2)

  it('拍快照 × 清除（彻底删除最近删除里的一条，先抹掉所有快照里的它）：串行等价，且对上不止一种串行顺序', async () => {
    // 两者结果可交换，对上的顺序取与实际先后最接近的；彻底删除收尾还要重写界面视图，拍快照得晚开始很久才排得到后面
    const tally = new Map<string, number>()
    await fc.assert(
      fc.asyncProperty(initArb, snapshotIdsArb, headStartArb(2, 400), interleaveScheduler(), async (b, ids, head, s) => {
        const seed: Seed = { a: 'deleted', b, isSameName: false, isSnapshotted: true }
        tallyOrder(tally, (await assertSerialEquivalent(memorySubject(seed), s, [{ kind: 'snapshot', ids }, { kind: 'hardDelete', id: 'a' }], head)).order)
      }),
      interleaveParams(DEFAULT_RUNS),
    )
    console.info(`[拍快照 × 清除] 对上的串行顺序分布：${JSON.stringify(Object.fromEntries(tally))}`)
    expect(tally.size).toBeGreaterThanOrEqual(2)
  }, TIMEOUT_MS)
})
