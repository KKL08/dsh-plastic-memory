import { describe, expect, it } from 'vitest'
import { executePromote } from '../src/tools/promote.ts'
import { MemoryStore, InMemoryTable } from '../src/store.ts'
import { SnapshotStore } from '../src/governance/snapshots.ts'
import { InMemoryKvTable } from '../src/kv-table.ts'
import type { MemorySnapshot } from '../src/governance/schema.ts'
import type { MemoryRecord } from '../src/record-schema.ts'
import { record as baseRecord } from './helpers/record.ts'

// 本文件默认造一条 workspace 层、待提升的 preference（agent-inferred，globalCandidate）。
const record = (partial: Partial<MemoryRecord> = {}) => baseRecord({
  type: 'preference', scope: 'workspace', workspacePath: '/proj',
  source: { sessionId: 's', eventRange: [0, 1], sourceMode: 'agent-inferred' },
  createdAt: 0, updatedAt: 0, lastConfirmedAt: 0, confidence: 0.5, globalCandidate: true, ...partial,
})

function fakeAgentsMd() {
  const lines: string[] = []
  return { writer: { append: async (l: string) => { lines.push(l) } }, lines }
}

function makeSnapshots() {
  return new SnapshotStore(new InMemoryKvTable<MemorySnapshot>())
}

describe('executePromote', () => {
  it('target=global：scope 改 global、workspacePath 清空、globalCandidate 清除', async () => {
    const store = new MemoryStore(new InMemoryTable())
    await store.put(record({ id: 'mem_x' }))
    const { writer } = fakeAgentsMd()
    const r = await executePromote({ confirmedIds: ['mem_x'], target: 'global' }, { store, agentsMd: writer, snapshots: makeSnapshots() })
    expect(r.promoted).toEqual([{ id: 'mem_x', target: 'global' }])
    const after = store.get('mem_x')!
    expect(after.scope).toBe('global')
    expect(after.workspacePath).toBeUndefined()
    expect(after.globalCandidate).toBeUndefined()
  })

  it('target=global：提升后记录不留 undefined 键（无损 JSON 不变式）', async () => {
    const store = new MemoryStore(new InMemoryTable())
    await store.put(record({ id: 'mem_x' }))
    const { writer } = fakeAgentsMd()
    await executePromote({ confirmedIds: ['mem_x'], target: 'global' }, { store, agentsMd: writer, snapshots: makeSnapshots() })
    const keys = Object.keys(store.get('mem_x')!)
    expect(keys).not.toContain('workspacePath')
    expect(keys).not.toContain('globalCandidate')
  })

  it('target=agents-md：写入 AGENTS.md + 原记忆软删', async () => {
    const store = new MemoryStore(new InMemoryTable())
    await store.put(record({ id: 'mem_y', name: '偏好', content: '用 pnpm' }))
    const { writer, lines } = fakeAgentsMd()
    const r = await executePromote({ confirmedIds: ['mem_y'], target: 'agents-md' }, { store, agentsMd: writer, snapshots: makeSnapshots() })
    expect(r.promoted).toEqual([{ id: 'mem_y', target: 'agents-md' }])
    expect(lines).toEqual(['偏好 — 用 pnpm'])
    expect(store.get('mem_y')!.status).toBe('deleted')
  })

  it('快照先行：两种 target 提升前都对目标整批拍 pre-promote 快照，data 含原记录', async () => {
    for (const target of ['global', 'agents-md'] as const) {
      const store = new MemoryStore(new InMemoryTable())
      await store.put(record({ id: 'mem_s', name: '偏好', content: '用 pnpm' }))
      const snapshots = makeSnapshots()
      const r = await executePromote({ confirmedIds: ['mem_s'], target }, { store, agentsMd: fakeAgentsMd().writer, snapshots })
      const list = snapshots.list()
      expect(list).toHaveLength(1)
      expect(list[0].operation).toBe('pre-promote')
      expect(list[0].memoryIds).toEqual(['mem_s'])
      // 快照存的是改动前的原记录：workspace scope、含 content
      expect(list[0].data[0].scope).toBe('workspace')
      expect(list[0].data[0].content).toBe('用 pnpm')
      expect(r.message).toContain(list[0].id) // 成功话术里带快照 id
    }
  })

  it('无可提升记录时不拍快照', async () => {
    const store = new MemoryStore(new InMemoryTable())
    const snapshots = makeSnapshots()
    await executePromote({ confirmedIds: ['mem_ghost'], target: 'global' }, { store, agentsMd: fakeAgentsMd().writer, snapshots })
    expect(snapshots.list()).toHaveLength(0)
  })

  it('agents-md 分支 append 失败时回滚软删：记忆仍 active、计入 skipped、不谎报 promoted', async () => {
    const store = new MemoryStore(new InMemoryTable())
    await store.put(record({ id: 'mem_z', name: '偏好', content: '用 pnpm' }))
    const failing = { append: async () => { throw new Error('EACCES: AGENTS.md 不可写') } }
    const r = await executePromote({ confirmedIds: ['mem_z'], target: 'agents-md' }, { store, agentsMd: failing, snapshots: makeSnapshots() })
    expect(r.promoted).toEqual([])
    expect(r.skipped).toEqual(['mem_z'])
    expect(store.get('mem_z')!.status).toBe('active')  // 软删已回滚，记忆没有丢
  })

  it('已删除/不存在的 id 跳过、不计入 promoted', async () => {
    const store = new MemoryStore(new InMemoryTable())
    const { writer } = fakeAgentsMd()
    const r = await executePromote({ confirmedIds: ['mem_ghost'], target: 'global' }, { store, agentsMd: writer, snapshots: makeSnapshots() })
    expect(r.promoted).toEqual([])
    expect(r.skipped).toEqual(['mem_ghost'])
  })

  it('只处理 confirmedIds 里的（未确认的不动）', async () => {
    const store = new MemoryStore(new InMemoryTable())
    await store.put(record({ id: 'mem_a' }))
    await store.put(record({ id: 'mem_b' }))
    const { writer } = fakeAgentsMd()
    await executePromote({ confirmedIds: ['mem_a'], target: 'global' }, { store, agentsMd: writer, snapshots: makeSnapshots() })
    expect(store.get('mem_a')!.scope).toBe('global')
    expect(store.get('mem_b')!.scope).toBe('workspace') // 未确认，不动
  })

  it('dismiss：清除候选标记、记忆留在项目内、scope 与 updatedAt 不变', async () => {
    const store = new MemoryStore(new InMemoryTable())
    await store.put(record({ id: 'mem_d', updatedAt: 111 }))
    const { writer } = fakeAgentsMd()
    const r = await executePromote({ confirmedIds: ['mem_d'], target: 'global', dismiss: true }, { store, agentsMd: writer, snapshots: makeSnapshots() })
    expect(r.dismissed).toEqual(['mem_d'])
    expect(r.promoted).toEqual([])
    const after = store.get('mem_d')!
    expect(Object.keys(after)).not.toContain('globalCandidate')
    expect(after.status).toBe('active')
    expect(after.scope).toBe('workspace')
    expect(after.updatedAt).toBe(111) // 清标记不是内容编辑，不动 updatedAt
  })

  it('dismiss：不拍快照', async () => {
    const store = new MemoryStore(new InMemoryTable())
    await store.put(record({ id: 'mem_d' }))
    const snapshots = makeSnapshots()
    await executePromote({ confirmedIds: ['mem_d'], target: 'global', dismiss: true }, { store, agentsMd: fakeAgentsMd().writer, snapshots })
    expect(snapshots.list()).toHaveLength(0)
  })

  it('dismiss：缺失/已删的 id 计入 skipped', async () => {
    const store = new MemoryStore(new InMemoryTable())
    await store.put(record({ id: 'mem_d' }))
    const r = await executePromote({ confirmedIds: ['mem_d', 'mem_ghost'], target: 'global', dismiss: true }, { store, agentsMd: fakeAgentsMd().writer, snapshots: makeSnapshots() })
    expect(r.dismissed).toEqual(['mem_d'])
    expect(r.skipped).toEqual(['mem_ghost'])
  })
})
