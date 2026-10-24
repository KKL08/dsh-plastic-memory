import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileTable } from '../src/storage/file-table.ts'
import { SidecarStore } from '../src/storage/sidecar.ts'
import { MemoryStore } from '../src/store.ts'
import { PendingDecisionsStore } from '../src/governance/decisions.ts'
import { SnapshotStore } from '../src/governance/snapshots.ts'
import { memorySnapshotSchema, pendingDecisionSchema, scanCacheSchema } from '../src/governance/schema.ts'
import { executeConfirm } from '../src/tools/confirm.ts'
import { RETENTION_MS } from '../src/retention.ts'
import { record } from './helpers/record.ts'

// 败方过了保留窗口被维护点物理删除时，引用它的删一方已裁决条目一起清掉；两边都留的、窗口内的不动。

const T0 = 1_700_000_000_000

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'pm-ledger-retention-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('保留窗口过后连带清理已裁决条目', () => {
  it('败方被维护点清掉的同一截止线上，删一方的条目清掉，两边都留的与窗口内的留着', async () => {
    let clock = T0
    const sidecar = new SidecarStore({ root, schemas: { snapshots: memorySnapshotSchema, pending: pendingDecisionSchema, scanCache: scanCacheSchema } })
    const store = new MemoryStore(new FileTable({ root, stats: sidecar.recallStats, now: () => clock }), undefined, sidecar.recallStats)
    const decisions = new PendingDecisionsStore(sidecar.pending)
    const snapshots = new SnapshotStore(sidecar.snapshots)
    const resolve = (decisionId: string, verdict: 'keep-left' | 'keep-both') =>
      executeConfirm({ action: 'resolve', decisionId, verdict }, { workspacePath: undefined }, { store, decisions, snapshots, now: () => clock })
    for (const id of ['mem_a', 'mem_b', 'mem_c', 'mem_d', 'mem_e', 'mem_f']) await store.create(record({ id, name: id }))

    const del = (await decisions.upsert({ memoryIds: ['mem_a', 'mem_b'], summary: '1', fingerprint: 'f1' }, T0)).entry
    const both = (await decisions.upsert({ memoryIds: ['mem_c', 'mem_d'], summary: '2', fingerprint: 'f2' }, T0)).entry
    const recent = (await decisions.upsert({ memoryIds: ['mem_e', 'mem_f'], summary: '3', fingerprint: 'f3' }, T0)).entry
    await resolve(del.id, 'keep-left')
    await resolve(both.id, 'keep-both')
    clock = T0 + 1000
    await resolve(recent.id, 'keep-left')

    clock = T0 + RETENTION_MS + 1
    await store.maintain({ kind: 'global' })
    expect(await store.get('mem_b')).toBeUndefined() // 败方已物理删除
    expect((await store.get('mem_f'))!.status).toBe('deleted') // 窗口内的还在 .archive/
    await decisions.sweep(clock)
    expect((await decisions.listSettled()).map(e => e.id).sort()).toEqual([both.id, recent.id].sort())
  })

  it('下一次裁决顺手清扫：不用单独调 sweep', async () => {
    const sidecar = new SidecarStore({ root, schemas: { snapshots: memorySnapshotSchema, pending: pendingDecisionSchema, scanCache: scanCacheSchema } })
    const decisions = new PendingDecisionsStore(sidecar.pending)
    const old = (await decisions.upsert({ memoryIds: ['mem_a', 'mem_b'], summary: '', fingerprint: 'f1' }, T0)).entry
    await decisions.settle(old.id, 'keep-right', T0, { snapshotId: 'snap_old' })
    const next = (await decisions.upsert({ memoryIds: ['mem_c', 'mem_d'], summary: '', fingerprint: 'f2' }, T0)).entry
    await decisions.settle(next.id, 'keep-both', T0 + RETENTION_MS + 1)
    expect((await decisions.listSettled()).map(e => e.id)).toEqual([next.id])
  })
})
