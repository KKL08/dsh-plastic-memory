import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SidecarStore } from '../src/storage/sidecar.ts'
import { PendingDecisionsStore } from '../src/governance/decisions.ts'
import { memorySnapshotSchema, pendingDecisionSchema, scanCacheSchema } from '../src/governance/schema.ts'
import { record } from './helpers/record.ts'

// 账本侧表的 GUI 兼容扩展（ARCHITECTURE.md ⑥-7）：kind、settled.snapshotId、删一方的裁决留账、GUI 条目带指纹。
// 真实临时目录 + 文件侧表。保留窗口的连带清理见 gui-ledger-retention.spec.ts。

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'pm-gui-ledger-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

function ledger() {
  const sidecar = new SidecarStore({ root, schemas: { snapshots: memorySnapshotSchema, pending: pendingDecisionSchema, scanCache: scanCacheSchema } })
  return new PendingDecisionsStore(sidecar.pending)
}

describe('账本 schema 向后兼容', () => {
  it('旧条目（无 kind、settled 无 snapshotId）原样解析，kind 缺省即冲突', () => {
    const old = { id: 'pd_1', memoryIds: ['mem_a', 'mem_b'], summary: 's', firstSeenAt: 1, fingerprint: 'fp', settled: { verdict: 'keep-both', at: 2 } }
    expect(pendingDecisionSchema.parse(old)).toEqual(old)
  })

  it('新字段：kind、删一方的 verdict、settled.snapshotId', () => {
    const entry = { id: 'pd_2', kind: 'promote-candidate', memoryIds: ['mem_a'], summary: '', firstSeenAt: 1, fingerprint: 'fp' }
    expect(pendingDecisionSchema.parse(entry)).toEqual(entry)
    const settled = { id: 'pd_3', memoryIds: ['mem_a', 'mem_b'], summary: '', firstSeenAt: 1, settled: { verdict: 'keep-right', at: 2, snapshotId: 'snap_1' } }
    expect(pendingDecisionSchema.parse(settled)).toEqual(settled)
    expect(() => pendingDecisionSchema.parse({ ...entry, kind: 'other' })).toThrow()
  })
})

describe('删一方的裁决留在账本里', () => {
  it('settle 记下快照 id；get / list 看不到，listSettled 看得到', async () => {
    const s = ledger()
    const { entry } = await s.upsert({ memoryIds: ['mem_a', 'mem_b'], summary: '矛盾', fingerprint: 'fp' }, 1)
    expect(await s.settle(entry.id, 'keep-left', 2, { snapshotId: 'snap_x' })).toBe(true)
    expect(await s.get(entry.id)).toBeUndefined()
    expect(await s.list()).toEqual([])
    expect(await s.listSettled()).toEqual([{ ...entry, settled: { verdict: 'keep-left', at: 2, snapshotId: 'snap_x' } }])
  })

  it('没有指纹的条目也留：删一方的裁决留账是为了撤销，不靠指纹', async () => {
    const s = ledger()
    const { entry } = await s.upsert({ memoryIds: ['mem_a', 'mem_b'], summary: '旧' }, 1)
    expect(await s.settle(entry.id, 'keep-right', 2, { snapshotId: 'snap_y' })).toBe(true)
    expect((await s.listSettled()).map(e => e.id)).toEqual([entry.id])
  })

  it('同一对冲突再次被扫到（败方回来了）：回到待处理，沿用原条目，不多出第二条', async () => {
    const s = ledger()
    const { entry } = await s.upsert({ memoryIds: ['mem_a', 'mem_b'], summary: '矛盾', fingerprint: 'fp' }, 1)
    await s.settle(entry.id, 'keep-left', 2, { snapshotId: 'snap_x' })
    const again = await s.upsert({ memoryIds: ['mem_b', 'mem_a'], summary: '又矛盾', fingerprint: 'fp' }, 3)
    expect(again.settled).toBeUndefined()
    expect(again.entry.id).toBe(entry.id)
    expect((await s.list()).map(e => [e.id, e.summary, e.settled])).toEqual([[entry.id, '又矛盾', undefined]])
    expect(await s.listSettled()).toEqual([])
  })

  it('条目正被认领（裁决进行中）：体检的 upsert 不动它，返回 isSkipped', async () => {
    const s = ledger()
    const { entry } = await s.upsert({ memoryIds: ['mem_a', 'mem_b'], summary: '矛盾', fingerprint: 'fp' }, 1)
    const inner = await s.withClaim(entry.id, () => s.upsert({ memoryIds: ['mem_a', 'mem_b'], summary: '改写', fingerprint: 'fp' }, 2))
    expect(inner).toMatchObject({ isClaimed: true, value: { created: false, isSkipped: true } })
    expect((await s.list()).map(e => e.summary)).toEqual(['矛盾'])
  })

  it('删一方的裁决：给了 read 且败方此刻不在，不当成「败方回来了」重开；败方真回来了照旧重开', async () => {
    const s = ledger()
    const { entry } = await s.upsert({ memoryIds: ['mem_a', 'mem_b'], summary: '矛盾', fingerprint: 'fp' }, 1)
    await s.settle(entry.id, 'keep-left', 2, { snapshotId: 'snap_x' })
    const status: Record<string, 'active' | 'deleted'> = { mem_a: 'active', mem_b: 'deleted' }
    const read = async (id: string) => record({ id, status: status[id] })
    expect((await s.upsert({ memoryIds: ['mem_a', 'mem_b'], summary: '又矛盾', fingerprint: 'fp' }, 3, read)).isSkipped).toBe(true)
    expect((await s.listSettled()).map(e => e.id)).toEqual([entry.id])
    status.mem_b = 'active'
    expect((await s.upsert({ memoryIds: ['mem_a', 'mem_b'], summary: '又矛盾', fingerprint: 'fp' }, 4, read)).entry.id).toBe(entry.id)
    expect((await s.list()).map(e => e.id)).toEqual([entry.id])
  })

  it('提升候选同步：扫描数据还把它当候选、记忆此刻已提升为全局，已提升的条目不被重开', async () => {
    const s = ledger()
    const { entry } = await s.upsert({ kind: 'promote-candidate', memoryIds: ['mem_p'], summary: '', workspaces: ['/w'], fingerprint: 'c1' }, 1)
    await s.settle(entry.id, 'promoted', 2, { snapshotId: 'snap_p' })
    const read = async (id: string) => record({ id, scope: 'global' })
    await s.syncPromoteCandidates('/w', [{ id: 'mem_p', summary: '', fingerprint: 'c1' }], new Set(['mem_p']), 3, read)
    expect((await s.listSettled()).map(e => [e.id, e.settled?.verdict])).toEqual([[entry.id, 'promoted']])
    expect(await s.list()).toEqual([])
  })

  it('removeByMemoryIds 可以留下指定条目（裁决刚记下的那条）', async () => {
    const s = ledger()
    const { entry } = await s.upsert({ memoryIds: ['mem_a', 'mem_b'], summary: '1', fingerprint: 'f1' }, 1)
    await s.upsert({ memoryIds: ['mem_b', 'mem_c'], summary: '2', fingerprint: 'f2' }, 2)
    await s.settle(entry.id, 'keep-left', 3, { snapshotId: 'snap' })
    expect(await s.removeByMemoryIds(['mem_b'], entry.id)).toBe(1)
    expect((await s.listSettled()).map(e => e.id)).toEqual([entry.id])
    expect(await s.list()).toEqual([])
  })
})

describe('GUI 条目：提升候选与超限提醒', () => {
  it('提升候选带内容指纹：留在本项目后 settled，指纹不变不再提示，内容变了重新提示', async () => {
    const s = ledger()
    const { entry } = await s.upsert({ kind: 'promote-candidate', memoryIds: ['mem_p'], summary: '', fingerprint: 'c1' }, 1)
    expect(entry.kind).toBe('promote-candidate')
    expect(await s.settle(entry.id, 'keep-local', 2)).toBe(true)
    expect(await s.list()).toEqual([])
    expect((await s.upsert({ kind: 'promote-candidate', memoryIds: ['mem_p'], summary: '', fingerprint: 'c1' }, 3)).settled).toBe(true)
    const changed = await s.upsert({ kind: 'promote-candidate', memoryIds: ['mem_p'], summary: '', fingerprint: 'c2' }, 4)
    expect(changed.created).toBe(true)
    expect((await s.list()).map(e => e.kind)).toEqual(['promote-candidate'])
  })

  it('超限提醒以档位号为指纹：忽略只确认这一档，进入下一档再提醒', async () => {
    const s = ledger()
    const { entry } = await s.upsert({ kind: 'overflow', memoryIds: [], summary: '', fingerprint: '1' }, 1)
    expect(await s.settle(entry.id, 'dismiss', 2)).toBe(true)
    expect((await s.upsert({ kind: 'overflow', memoryIds: [], summary: '', fingerprint: '1' }, 3)).settled).toBe(true)
    const next = await s.upsert({ kind: 'overflow', memoryIds: [], summary: '', fingerprint: '2' }, 4)
    expect(next.created).toBe(true)
    expect((await s.list()).map(e => [e.kind, e.fingerprint])).toEqual([['overflow', '2']])
  })

  it('不同 kind 的条目不同键：提升候选与同一记忆的垂直冲突各自成条', async () => {
    const s = ledger()
    await s.upsert({ kind: 'promote-candidate', memoryIds: ['mem_x'], summary: '', fingerprint: 'c' }, 1)
    await s.upsert({ memoryIds: ['mem_x'], baselineRef: 'AGENTS.md：规则', summary: '与基线矛盾', fingerprint: 'v' }, 2)
    expect((await s.list()).map(e => e.kind ?? 'conflict')).toEqual(['promote-candidate', 'conflict'])
  })
})
