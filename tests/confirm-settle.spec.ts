import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileTable } from '../src/storage/file-table.ts'
import { SidecarStore } from '../src/storage/sidecar.ts'
import { MemoryStore } from '../src/store.ts'
import { PendingDecisionsStore } from '../src/governance/decisions.ts'
import { SnapshotStore } from '../src/governance/snapshots.ts'
import { memorySnapshotSchema, pendingDecisionSchema, scanCacheSchema, adviceIgnoreSchema } from '../src/governance/schema.ts'
import { executeConfirm } from '../src/tools/confirm.ts'
import { record } from './helpers/record.ts'

// 删一方的裁决（keep-left / keep-right）不再从账本删条目：标 settled 并记下删败方前的快照 id，供撤销。
// 真实临时目录：FileTable + .state 侧表。

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'pm-confirm-settle-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

function env() {
  const sidecar = new SidecarStore({ root, schemas: { snapshots: memorySnapshotSchema, pending: pendingDecisionSchema, scanCache: scanCacheSchema, adviceIgnores: adviceIgnoreSchema } })
  const store = new MemoryStore(new FileTable({ root, stats: sidecar.recallStats }), undefined, sidecar.recallStats)
  const decisions = new PendingDecisionsStore(sidecar.pending)
  const snapshots = new SnapshotStore(sidecar.snapshots)
  const resolve = (decisionId: string, verdict: 'keep-left' | 'keep-right' | 'keep-both') =>
    executeConfirm({ action: 'resolve', decisionId, verdict }, { workspacePath: undefined }, { store, decisions, snapshots, now: () => 5000 })
  return { store, decisions, snapshots, resolve }
}

describe('删一方的裁决标 settled 并记快照 id', () => {
  it('横向 keep-left：删 right、快照先行，条目 settled 带该快照 id，待处理里看不到', async () => {
    const e = env()
    await e.store.create(record({ id: 'mem_l', name: '左', content: '用 pnpm' }))
    await e.store.create(record({ id: 'mem_r', name: '右', content: '用 npm' }))
    const { entry } = await e.decisions.upsert({ memoryIds: ['mem_l', 'mem_r'], summary: '矛盾', fingerprint: 'fp' }, 1)

    const r = await e.resolve(entry.id, 'keep-left')
    expect(r.kind).toBe('resolved')
    expect((await e.store.get('mem_r'))!.status).toBe('deleted')
    const [snap] = await e.snapshots.list()
    expect(snap.memoryIds).toEqual(['mem_r'])
    expect(await e.decisions.list()).toEqual([])
    expect((await e.decisions.listSettled()).map(d => [d.id, d.settled])).toEqual([[entry.id, { verdict: 'keep-left', at: 5000, snapshotId: snap.id }]])
  })

  it('垂直 keep-right（基线胜）：删记忆，条目 settled 带快照 id', async () => {
    const e = env()
    await e.store.create(record({ id: 'mem_v', content: '用 npm' }))
    const { entry } = await e.decisions.upsert({ memoryIds: ['mem_v'], baselineRef: 'AGENTS.md：包管理', summary: '与基线矛盾', fingerprint: 'fp' }, 1)
    await e.resolve(entry.id, 'keep-right')
    const [snap] = await e.snapshots.list()
    expect((await e.decisions.listSettled()).map(d => d.settled)).toEqual([{ verdict: 'keep-right', at: 5000, snapshotId: snap.id }])
  })

  it('同样引用败方的其他未决条目照旧顺带清掉并计数，裁决的这条留着', async () => {
    const e = env()
    for (const id of ['mem_l', 'mem_r', 'mem_o']) await e.store.create(record({ id, name: id }))
    const { entry } = await e.decisions.upsert({ memoryIds: ['mem_l', 'mem_r'], summary: '待裁决', fingerprint: 'f1' }, 1)
    await e.decisions.upsert({ memoryIds: ['mem_r', 'mem_o'], summary: '另一条', fingerprint: 'f2' }, 2)
    const r = await e.resolve(entry.id, 'keep-left')
    expect(r.kind === 'resolved' && r.alsoCleared).toBe(1)
    expect(await e.decisions.list()).toEqual([])
    expect((await e.decisions.listSettled()).map(d => d.id)).toEqual([entry.id])
  })

  it('不是冲突的条目（提升候选）不能当冲突裁决：报错，条目和记忆都不动', async () => {
    const e = env()
    await e.store.create(record({ id: 'mem_p' }))
    const { entry } = await e.decisions.upsert({ kind: 'promote-candidate', memoryIds: ['mem_p'], summary: '', fingerprint: 'c' }, 1)
    const r = await e.resolve(entry.id, 'keep-right')
    expect(r.kind).toBe('error')
    expect((await e.decisions.list()).map(d => d.id)).toEqual([entry.id])
    expect((await e.store.get('mem_p'))!.status).toBe('active')
    expect(await e.snapshots.list()).toEqual([])
  })
})
