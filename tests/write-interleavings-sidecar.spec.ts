import { describe, it, vi } from 'vitest'
import fc from 'fast-check'
import { assertSerialEquivalent, interleaveParams, interleaveRuns, interleaveScheduler, type Subject } from './helpers/interleave.ts'
import { IDS, initArb, keyArb, memorySubject, snapshotIdsArb, type Key, type MemOp, type MemoryWorld, type Seed } from './helpers/memory-subject.ts'

// 文件系统是进程边界：存储层 import 的 node:fs/promises 换成夹具包过的那份，调用的全序交给调度器（见 helpers/interleave.ts）
vi.mock('node:fs/promises', async () => (await import('./helpers/interleave.ts')).interleavedFs)

// 单次贵，缺省次数比别处少，整个文件在跑全量测试的负载下也在 5 秒内；调大 PM_INTERLEAVE_RUNS 时按次数放宽
const DEFAULT_RUNS = 15
const TIMEOUT_MS = Math.max(20_000, interleaveRuns(DEFAULT_RUNS) * 600)

const recallArb = fc.record({ kind: fc.constant('recall' as const), ids: fc.constantFrom<Key[]>(['a'], ['b'], ['a', 'b'], ['a', 'a']) })

// 侧表的读改写（召回计数整表合并、快照逐份条件写）都在写锁内重读；进程内的排队已经删掉，并发由这里搜
describe('IL-02 侧表读改写', () => {
  it('IL-02①：两三条并发的召回记录，各条记忆的召回次数等于各次之和', async () => {
    const subject = (seed: Seed): Subject<MemoryWorld, MemOp> => ({
      ...memorySubject(seed),
      invariant: async (w, ops) => {
        const expected = new Map<string, number>()
        for (const op of ops) if (op.kind === 'recall') for (const k of op.ids) expected.set(IDS[k], (expected.get(IDS[k]) ?? 0) + 1)
        const problems: string[] = []
        for (const [id, n] of expected) {
          const got = (await w.sidecar.recallStats.get(id))?.recallCount
          if (got !== n) problems.push(`${id} 召回 ${n} 次，记下 ${String(got)}`)
        }
        return problems
      },
    })
    await fc.assert(
      fc.asyncProperty(initArb, fc.array(recallArb, { minLength: 2, maxLength: 3 }), interleaveScheduler(), async (a, ops, s) => {
        await assertSerialEquivalent(subject({ a, b: 'workspace', isSameName: false }), s, ops)
      }),
      interleaveParams(DEFAULT_RUNS),
    )
  }, TIMEOUT_MS)

  it('IL-02②：同一份既有快照上的脱敏、清除并发（可另有召回或新拍快照），各自的效果都在：脱敏的不变回明文，清除的不回来', async () => {
    const subject = (seed: Seed): Subject<MemoryWorld, MemOp> => ({
      ...memorySubject(seed),
      invariant: async (w, ops) => {
        // 只对这份既有快照承诺；之后新拍的快照合法地带着原文
        const snap = w.snapshotId === undefined ? undefined : await w.snapshots.get(w.snapshotId)
        if (snap === undefined) return []
        const problems: string[] = []
        for (const op of ops) {
          if (op.kind !== 'redact' && op.kind !== 'purge') continue
          const entry = snap.data.find(r => r.id === IDS[op.id])
          if (op.kind === 'purge' && entry !== undefined) problems.push(`${IDS[op.id]} 清除后又出现在既有快照里`)
          if (op.kind === 'redact' && entry !== undefined && entry.redacted !== true) problems.push(`${IDS[op.id]} 脱敏后在既有快照里又是明文`)
        }
        return problems
      },
    })
    const pairArb = fc.tuple(keyArb, keyArb).map(([r, p]): MemOp[] => [{ kind: 'redact', id: r }, { kind: 'purge', id: p }])
    const extraArb: fc.Arbitrary<MemOp> = fc.oneof(recallArb, fc.record({ kind: fc.constant('snapshot' as const), ids: snapshotIdsArb }))
    await fc.assert(
      fc.asyncProperty(initArb, pairArb, fc.option(extraArb, { nil: undefined }), interleaveScheduler(), async (a, pair, extra, s) => {
        const ops = [...pair, ...(extra === undefined ? [] : [extra])]
        await assertSerialEquivalent(subject({ a, b: 'workspace', isSameName: false, isSnapshotted: true }), s, ops)
      }),
      interleaveParams(DEFAULT_RUNS),
    )
  }, TIMEOUT_MS)
})
