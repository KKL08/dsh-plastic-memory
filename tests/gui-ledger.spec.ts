import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SidecarStore } from '../src/storage/sidecar.ts'
import { PendingDecisionsStore } from '../src/governance/decisions.ts'
import { memorySnapshotSchema, pendingDecisionSchema, scanCacheSchema } from '../src/governance/schema.ts'

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
