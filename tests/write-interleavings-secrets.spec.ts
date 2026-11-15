import { describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import { assertSerialEquivalent, headStartArb, interleaveParams, interleaveRuns, interleaveScheduler, tallyOrder, type Subject } from './helpers/interleave.ts'
import { IDS, initArb, keyArb, secretSubject, snapshotIdsArb, type Key, type MemOp, type MemoryWorld, type Seed } from './helpers/memory-subject.ts'

// 文件系统是进程边界：存储层 import 的 node:fs/promises 换成夹具包过的那份，调用的全序交给调度器（见 helpers/interleave.ts）
vi.mock('node:fs/promises', async () => (await import('./helpers/interleave.ts')).interleavedFs)

// 单次贵，缺省次数比别处少，整个文件在跑全量测试的负载下也在 5 秒内；调大 PM_INTERLEAVE_RUNS 时按次数放宽
const DEFAULT_RUNS = 12
const TIMEOUT_MS = Math.max(20_000, interleaveRuns(DEFAULT_RUNS) * 600)

/** 密钥硬删的两个真实入口：界面上的彻底删除（可只删一层），模型的遗忘工具（含密钥的物理删除）。 */
const secretDeleteArb: fc.Arbitrary<MemOp> = fc.oneof(
  fc.record({ kind: fc.constant('hardDelete' as const), id: fc.constant<Key>('a'), layer: fc.constantFrom(undefined, 'workspace' as const) }),
  fc.constant<MemOp>({ kind: 'forget', id: 'a' }),
)
/**
 * 全局有相同副本时只删项目这一层：不限层的硬删要删两个文件，锁外按目录读的可见集合快照能读到删了一半的样子，
 * 这是接受的行为（快照只是那一刻的近似，删完的那层照样脱敏），不在这条性质里比。
 */
const deletionArb = fc.boolean().chain(hasCopy =>
  fc.tuple(fc.constant(hasCopy), hasCopy ? fc.constant<MemOp>({ kind: 'hardDelete', id: 'a', layer: 'workspace' }) : secretDeleteArb))
/**
 * 第三个操作不含召回：先行快照里的召回次数取预读那一刻，中间插进来的召回让它比串行时旧一拍；这是接受的行为，
 * 召回统计不随快照恢复（见 FileTable.put），旧值不影响任何读写。
 */
const extraArb: fc.Arbitrary<MemOp> = fc.oneof(
  fc.record({ kind: fc.constantFrom('redact' as const, 'purge' as const), id: keyArb }),
  fc.record({ kind: fc.constant('snapshot' as const), ids: snapshotIdsArb }),
)

/**
 * 全局有相同副本时，快照里全局那份脱敏与否不比，其余照比，泄露不变量 secretProblems 照查。接受的行为：硬删收尾按事先列出的快照
 * 分辨别层副本，列完之后才落盘的快照里仍在用的全局副本也一并脱敏；密钥路径宁可多脱敏，代价只是那份快照恢复不了一份还活着的副本。
 */
function withCopyRedactionIgnored(subject: Subject<MemoryWorld, MemOp>): Subject<MemoryWorld, MemOp> {
  const isGlobalCopy = (r: { id: string; scope: string }) => r.id === IDS.a && r.scope === 'global'
  return {
    ...subject,
    state: async (w, root) => (await subject.state(w, root)).map(([path, text]): [string, string] => {
      if (!path.startsWith('.state/snapshots/') || !path.endsWith('.json')) return [path, text]
      const snap = JSON.parse(text) as { data: Array<{ id: string; scope: string }> }
      return [path, JSON.stringify({ ...snap, data: snap.data.map(r => (isGlobalCopy(r) ? { id: r.id, scope: r.scope } : r)) })]
    }),
  }
}

// 强制模板：只随机内部的调度（和少量初始盘面），每组统计对上了几种不同的串行顺序。
// 不变量（secretSubject）：快照里带明文密钥的那条记录，它自己那一层必须还在
describe('IL-02③ 与密钥硬删的强制模板', () => {
  it('拍快照 × 密钥硬删（含同一条；全局可有一份相同的独立副本，这时只删项目这一层）：硬删返回后任何快照里都没有它的明文', async () => {
    const tally = new Map<string, number>()
    await fc.assert(
      fc.asyncProperty(deletionArb, snapshotIdsArb, fc.option(extraArb, { nil: undefined }), headStartArb(2, 150), interleaveScheduler(),
        async ([hasCopy, del], ids, extra, head, s) => {
          const seed: Seed = { a: 'workspace', b: 'workspace', isSameName: false, secret: 'a', ...(hasCopy ? { copy: 'a' as const } : {}) }
          const ops: MemOp[] = [{ kind: 'snapshot', ids }, del, ...(extra === undefined ? [] : [extra])]
          const subject = hasCopy ? withCopyRedactionIgnored(secretSubject(seed)) : secretSubject(seed)
          tallyOrder(tally, (await assertSerialEquivalent(subject, s, ops, head)).order)
        }),
      interleaveParams(DEFAULT_RUNS),
    )
    console.info(`[拍快照 × 密钥硬删] 对上的串行顺序分布：${JSON.stringify(Object.fromEntries(tally))}`)
    expect(tally.size).toBeGreaterThanOrEqual(2)
  }, TIMEOUT_MS)

  it('快照恢复 × 密钥硬删同一条：恢复不出删掉的密钥，快照里也不留明文', async () => {
    const tally = new Map<string, number>()
    await fc.assert(
      fc.asyncProperty(deletionArb, initArb.filter(i => i !== 'deleted'), headStartArb(2, 150), interleaveScheduler(), async ([hasCopy, del], b, head, s) => {
        const seed: Seed = { a: 'workspace', b, isSameName: false, secret: 'a', isSnapshotted: true, ...(hasCopy ? { copy: 'a' as const } : {}) }
        tallyOrder(tally, (await assertSerialEquivalent(secretSubject(seed), s, [{ kind: 'restoreSnapshot' }, del], head)).order)
      }),
      interleaveParams(DEFAULT_RUNS),
    )
    console.info(`[快照恢复 × 密钥硬删] 对上的串行顺序分布：${JSON.stringify(Object.fromEntries(tally))}`)
    expect(tally.size).toBeGreaterThanOrEqual(2)
  }, TIMEOUT_MS)
})
