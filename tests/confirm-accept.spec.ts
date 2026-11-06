import { describe, expect, it } from 'vitest'
import { executeConfirm, type ConfirmToolDeps } from '../src/tools/confirm.ts'
import { MemoryStore, InMemoryTable } from '../src/store.ts'
import { InMemoryKvTable } from '../src/kv-table.ts'
import { PendingDecisionsStore } from '../src/governance/decisions.ts'
import { SnapshotStore } from '../src/governance/snapshots.ts'
import type { MemorySnapshot, PendingDecision } from '../src/governance/schema.ts'
import { isPendingDelegated, type MemoryRecord } from '../src/record-schema.ts'
import { record } from './helpers/record.ts'

// memory_confirm accept-subagent：主会话把子 agent 存的待确认记录接受为本项目主档。

function makeDeps(): ConfirmToolDeps {
  return {
    store: new MemoryStore(new InMemoryTable()),
    decisions: new PendingDecisionsStore(new InMemoryKvTable<PendingDecision>()),
    snapshots: new SnapshotStore(new InMemoryKvTable<MemorySnapshot>()),
    now: () => 5000,
  }
}

const DELEGATION = { sessionId: 'sess-child', depth: 1, parentSessionId: 'sess-main', rootSessionId: 'sess-main' }

/** 当前项目里一条子 agent 存的待确认记录。 */
const pending = (partial: Partial<MemoryRecord> = {}) => record({
  id: 'mem_p', type: 'knowledge', scope: 'workspace', workspacePath: '/proj', content: '子观察', summary: '子观察摘要',
  source: { sessionId: 'sess-child', eventRange: [4, 9], sourceMode: 'environment-observed' },
  createdAt: 10, updatedAt: 20, lastConfirmedAt: 30, confidence: 0.7,
  delegation: DELEGATION,
  ...partial,
})

const accept = (deps: ConfirmToolDeps, memoryId = 'mem_p', allowCrossWorkspace?: boolean) =>
  executeConfirm({ action: 'accept-subagent', memoryId, ...(allowCrossWorkspace === undefined ? {} : { allowCrossWorkspace }) }, { workspacePath: '/proj' }, deps)

describe('memory_confirm accept-subagent', () => {
  it('接受后不再待确认：reviewed 记 main 与当前时间、lastConfirmedAt 更新，其余字段原样', async () => {
    const deps = makeDeps()
    const before = pending()
    await deps.store.put(before)
    const r = await accept(deps)
    expect(r).toMatchObject({ kind: 'accepted', memoryId: 'mem_p' })
    const after = (await deps.store.get('mem_p', { workspacePath: '/proj' }))!
    expect(isPendingDelegated(after)).toBe(false)
    expect(after).toEqual({ ...before, lastConfirmedAt: 5000, delegation: { ...DELEGATION, reviewed: { by: 'main', at: 5000 } } })
  })

  it('主档、已接受（主会话或用户）、已删除、已取代回 not-subagent-pending，原因说明是哪种，记录不动', async () => {
    const cases: Array<[MemoryRecord, string]> = [
      [pending({ delegation: undefined }), '是主会话写的或用户手建的'],
      [pending({ delegation: { ...DELEGATION, reviewed: { by: 'main', at: 7 } } }), '已经被接受了'],
      [pending({ delegation: { ...DELEGATION, reviewed: { by: 'user', at: 7 } } }), '用户已经改过'],
      [pending({ status: 'deleted', deletedAt: 40 }), '已删除'],
      [pending({ status: 'superseded' }), '已被取代'],
    ]
    for (const [before, why] of cases) {
      const deps = makeDeps()
      await deps.store.put(before)
      const r = await accept(deps)
      expect(r, why).toEqual({
        kind: 'error', code: 'not-subagent-pending',
        message: `记忆 mem_p ${why}，不是待确认的子 agent 记忆，未做改动。accept-subagent 只接受子 agent 存的、还在用的待确认记忆。`,
      })
      expect(await deps.store.get('mem_p', { workspacePath: '/proj' }), why).toEqual(before)
    }
  })

  it('过期但仍在用的待确认记录能接受，validTo 不变（接受不延长有效期）', async () => {
    const deps = makeDeps()
    await deps.store.put(pending({ validTo: 100 }))
    expect((await accept(deps)).kind).toBe('accepted')
    const after = (await deps.store.get('mem_p', { workspacePath: '/proj' }))!
    expect(after.validTo).toBe(100)
    expect(after.delegation?.reviewed).toEqual({ by: 'main', at: 5000 })
  })

  it('记忆不存在回 error，不带码', async () => {
    expect(await accept(makeDeps(), 'mem_ghost')).toEqual({ kind: 'error', message: '记忆不存在：mem_ghost' })
  })

  it('跨项目门：别的项目的待确认记录不带参数回 cross-workspace、不动；带 allowCrossWorkspace 接受并标出所属项目', async () => {
    const deps = makeDeps()
    const before = pending({ workspacePath: '/other' })
    await deps.store.put(before)
    const r = await accept(deps)
    expect(r).toMatchObject({ kind: 'error', code: 'cross-workspace', rejected: [{ id: 'mem_p', workspacePath: '/other' }] })
    expect(await deps.store.get('mem_p', { workspacePath: '/other' })).toEqual(before)

    const ok = await accept(deps, 'mem_p', true)
    expect(ok).toMatchObject({ kind: 'accepted', otherWorkspaces: [{ id: 'mem_p', workspacePath: '/other' }] })
    expect(isPendingDelegated((await deps.store.get('mem_p', { workspacePath: '/other' }))!)).toBe(false)
  })

  it('不入账本、不拍快照', async () => {
    const deps = makeDeps()
    await deps.store.put(pending())
    expect((await accept(deps)).kind).toBe('accepted')
    expect(await deps.decisions.list()).toEqual([])
    expect(await deps.snapshots.list()).toEqual([])
  })
})
