import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import { kindOf, verdictLoser } from '../src/governance/schema.ts'
import { assertSerialEquivalent, headStartArb, interleaveParams, interleaveRuns, interleaveScheduler, tallyOrder, type Subject } from './helpers/interleave.ts'
import { STORE_NOW, W, keyArb, memorySubject, type MemOp, type MemoryWorld, type Seed, type Verdict } from './helpers/memory-subject.ts'

// 文件系统是进程边界：存储层 import 的 node:fs/promises 换成夹具包过的那份，调用的全序交给调度器（见 helpers/interleave.ts）
vi.mock('node:fs/promises', async () => (await import('./helpers/interleave.ts')).interleavedFs)

// 时钟也是进程边界：裁决删败方走遗忘工具的软删，软删的 updatedAt 不取注入的时钟、取当前时间，这里把当前时间钉住，并发与串行重放可比
beforeAll(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(STORE_NOW) })
afterAll(() => { vi.useRealTimers() })

// 单次贵，缺省次数比别处少，整个文件在跑全量测试的负载下也在 5 秒内；调大 PM_INTERLEAVE_RUNS 时按次数放宽
const DEFAULT_RUNS = 10
const TIMEOUT_MS = Math.max(20_000, interleaveRuns(DEFAULT_RUNS) * 600)

/**
 * 账本与盘面一致：未决的冲突条目引用的两条都在用；已结清为删一方的条目，败方不在用（模型改写另记的可撤销改写条目不在此列）。
 * 认领不到（claimed）的操作由判据当成没发生过，并核对当时确有别的操作持有同一认领（见 assertSerialEquivalent）。
 */
const decisionsSubject = (seed: Seed): Subject<MemoryWorld, MemOp> => ({
  ...memorySubject(seed),
  invariant: async w => {
    const isActive = async (id: string) => (await w.store.get(id, { workspacePath: W }))?.status === 'active'
    const problems: string[] = []
    for (const entry of (await w.decisions.list()).filter(e => kindOf(e) === 'conflict')) {
      for (const id of entry.memoryIds) if (!(await isActive(id))) problems.push(`未决条目 ${entry.id} 引用的 ${id} 不在用`)
    }
    for (const entry of await w.decisions.listSettled()) {
      const loser = verdictLoser(entry, entry.settled!.verdict)
      if (loser !== undefined && await isActive(loser)) problems.push(`条目 ${entry.id} 已结清为删 ${loser}，它却还在用`)
    }
    return problems
  },
})

const verdictArb = fc.constantFrom<Verdict>('keep-left', 'keep-right', 'keep-both')
/** 裁决（删一方或两边都留）、撤销该裁决、改写冲突里的任一方（随裁决不同，是败方或胜方）。 */
const decisionOpArb: fc.Arbitrary<MemOp> = fc.oneof(
  fc.record({ kind: fc.constant('resolve' as const), verdict: verdictArb }),
  fc.constant<MemOp>({ kind: 'undo' }),
  fc.record({ kind: fc.constant('modelRewrite' as const), id: keyArb, isForced: fc.boolean() }),
)

describe('IL-03 裁决、撤销与写入', () => {
  it('IL-03：裁决、两边都留、撤销、改写败方或胜方任取 2–3 个并发（未决或已裁决的冲突上），串行等价（含认领不到），账本与盘面一致', async () => {
    let claimedRuns = 0
    await fc.assert(
      fc.asyncProperty(fc.constantFrom<'open' | 'settled'>('open', 'settled'), fc.array(decisionOpArb, { minLength: 2, maxLength: 3 }), interleaveScheduler(),
        async (conflict, ops, s) => {
          const eq = await assertSerialEquivalent(decisionsSubject({ a: 'workspace', b: 'workspace', isSameName: false, conflict }), s, ops)
          if (eq.claimed.length > 0) claimedRuns++
        }),
      interleaveParams(DEFAULT_RUNS),
    )
    console.info(`[IL-03] 有操作认领不到的次数：${claimedRuns}`)
  }, TIMEOUT_MS)
})

describe('IL-03 强制模板', () => {
  it('裁决删一方 × 改写败方：串行等价，账本与盘面一致，且对上不止一种串行顺序', async () => {
    const tally = new Map<string, number>()
    await fc.assert(
      fc.asyncProperty(fc.boolean(), fc.option(decisionOpArb, { nil: undefined }), headStartArb(2, 150), interleaveScheduler(), async (isForced, extra, head, s) => {
        const ops: MemOp[] = [{ kind: 'resolve', verdict: 'keep-left' }, { kind: 'modelRewrite', id: 'b', isForced }, ...(extra === undefined ? [] : [extra])]
        tallyOrder(tally, (await assertSerialEquivalent(decisionsSubject({ a: 'workspace', b: 'workspace', isSameName: false, conflict: 'open' }), s, ops, head)).order)
      }),
      interleaveParams(DEFAULT_RUNS),
    )
    console.info(`[裁决删一方 × 改写败方] 对上的串行顺序分布：${JSON.stringify(Object.fromEntries(tally))}`)
    expect(tally.size).toBeGreaterThanOrEqual(2)
  }, TIMEOUT_MS)
})
