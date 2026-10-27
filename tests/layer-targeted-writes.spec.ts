import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore, InMemoryTable } from '../src/store.ts'
import { FileTable } from '../src/storage/file-table.ts'
import { GLOBAL_DIR, workspaceDirName } from '../src/storage/paths.ts'
import { InMemoryKvTable } from '../src/kv-table.ts'
import { PendingDecisionsStore } from '../src/governance/decisions.ts'
import { SnapshotStore } from '../src/governance/snapshots.ts'
import { executeConfirm } from '../src/tools/confirm.ts'
import { executePromote } from '../src/tools/promote.ts'
import { locateCopy, type CopyTarget } from '../src/tools/workspace-gate.ts'
import type { MemorySnapshot, PendingDecision } from '../src/governance/schema.ts'
import type { RecallStats } from '../src/storage/schema.ts'
import type { MemoryRecord } from '../src/record-schema.ts'
import { record as baseRecord } from './helpers/record.ts'

// 同一个 id 在本项目和全局各有一份在用的：指明了项目那一份的确认、提升，读和写都只认那一份，全局那份一字不动。
// 两个后端都跑，两份各自较新时各跑一遍（定位不带层时按「在用、较新」挑，正好把两种挑法都走到）。

const WS = '/home/dev/proj-dup'
const ctx = { workspacePath: WS }
const T0 = 1_700_000_000_000
const NOW = T0 + 50_000
const PROJECT: CopyTarget = { kind: 'workspace', workspacePath: WS }
const GLOBAL: CopyTarget = { kind: 'global' }

interface Backend { name: string; make(): Promise<{ store: MemoryStore; seed(r: MemoryRecord): Promise<void>; cleanup(): Promise<void> }> }

const backends: Backend[] = [
  {
    name: 'InMemoryTable',
    make: async () => {
      const root = '/in-memory'
      const t = new InMemoryTable(root)
      return {
        store: new MemoryStore(t),
        // create 会清掉可见集合里同 id 的其余副本：直接放进虚拟目录
        seed: async r => { t.seedFile({ dir: r.scope === 'global' ? join(root, GLOBAL_DIR) : join(root, workspaceDirName(r.workspacePath!)), fileName: `${r.name}.md`, record: r }) },
        cleanup: async () => {},
      }
    },
  },
  {
    name: 'FileTable',
    make: async () => {
      const root = await mkdtemp(join(tmpdir(), 'pm-layer-write-'))
      const t = new FileTable({ root, stats: new InMemoryKvTable<RecallStats>() })
      return { store: new MemoryStore(t), seed: r => t.create(r), cleanup: () => rm(root, { recursive: true, force: true }) }
    },
  },
]

const copy = (partial: Partial<MemoryRecord>) => baseRecord({
  id: 'mem_dup', type: 'preference', createdAt: T0, updatedAt: T0, lastConfirmedAt: T0, ...partial,
})
const globalCopy = (updatedAt: number) => copy({ name: '全局那份', content: '全局那份的正文', updatedAt })
const projectCopy = (updatedAt: number) => copy({
  name: '项目那份', content: '项目那份的正文', scope: 'workspace', workspacePath: WS, globalCandidate: true, updatedAt,
})

describe.each(backends)('指明项目那一份的写入只改它：$name', ({ make }) => {
  let h: Awaited<ReturnType<Backend['make']>>
  beforeEach(async () => { h = await make() })
  afterEach(async () => { await h.cleanup() })

  describe.each([
    { newer: '全局', globalAt: T0 + 1000, projectAt: T0 },
    { newer: '项目', globalAt: T0, projectAt: T0 + 1000 },
  ])('$newer那份较新', ({ globalAt, projectAt }) => {
    const seeded = { global: globalCopy(globalAt), project: projectCopy(projectAt) }
    beforeEach(async () => {
      await h.seed(seeded.global)
      await h.seed(seeded.project)
    })

    /** 全局那份仍在、仍是 seed 时的样子。 */
    async function expectGlobalUntouched() {
      const g = await locateCopy(h.store, 'mem_dup', GLOBAL)
      expect(g).toMatchObject({
        status: 'active', name: '全局那份', content: '全局那份的正文', updatedAt: globalAt, lastConfirmedAt: T0,
      })
      expect(g!.globalCandidate).toBeUndefined()
    }

    const deps = () => ({
      store: h.store,
      decisions: new PendingDecisionsStore(new InMemoryKvTable<PendingDecision>()),
      snapshots: new SnapshotStore(new InMemoryKvTable<MemorySnapshot>()),
      now: () => NOW,
    })
    const promoteDeps = (lines: string[] = []) => ({ ...deps(), agentsMd: { append: async (l: string) => { lines.push(l) } } })

    it('确认还准确：刷新的是项目那份', async () => {
      const r = await executeConfirm({ action: 'refresh', memoryId: 'mem_dup' }, ctx, deps(), { target: PROJECT })
      expect(r.kind).toBe('refreshed')
      expect(await locateCopy(h.store, 'mem_dup', PROJECT)).toMatchObject({ content: '项目那份的正文', lastConfirmedAt: NOW, status: 'active' })
      await expectGlobalUntouched()
    })

    it('提升为全局：全局已有同 id 的，拒绝，两份都不动', async () => {
      const r = await executePromote({ confirmedIds: ['mem_dup'], target: 'global' }, ctx, promoteDeps(), { target: PROJECT })
      expect(r.promoted).toEqual([])
      expect(r.taken).toEqual(['mem_dup'])
      expect(r.snapshotId).toBeNull()
      expect(r.message).toContain('全局已有')
      expect(await locateCopy(h.store, 'mem_dup', PROJECT)).toMatchObject({ scope: 'workspace', content: '项目那份的正文', globalCandidate: true, status: 'active' })
      await expectGlobalUntouched()
    })

    it('留在本项目：清掉的是项目那份的候选标记', async () => {
      const r = await executePromote({ confirmedIds: ['mem_dup'], target: 'global', dismiss: true }, ctx, promoteDeps(), { target: PROJECT })
      expect(r.dismissed).toEqual(['mem_dup'])
      const p = await locateCopy(h.store, 'mem_dup', PROJECT)
      expect(p).toMatchObject({ scope: 'workspace', content: '项目那份的正文', status: 'active' })
      expect(p!.globalCandidate).toBeUndefined()
      await expectGlobalUntouched()
    })

    it('写进 AGENTS.md：软删的是项目那份', async () => {
      const lines: string[] = []
      const r = await executePromote({ confirmedIds: ['mem_dup'], target: 'agents-md' }, ctx, promoteDeps(lines), { target: PROJECT })
      expect(r.promoted).toEqual([{ id: 'mem_dup', target: 'agents-md' }])
      expect(lines).toEqual(['项目那份 — 项目那份的正文'])
      expect(await locateCopy(h.store, 'mem_dup', PROJECT)).toMatchObject({ content: '项目那份的正文', status: 'deleted' })
      await expectGlobalUntouched()
    })
  })

  it('全局只在最近删除里有同 id 的：同样拒绝提升', async () => {
    await h.seed(copy({ name: '全局那份', status: 'deleted', deletedAt: Date.now() }))   // 保留期内，维护点不清它
    await h.seed(projectCopy(T0))
    const deps = { store: h.store, snapshots: new SnapshotStore(new InMemoryKvTable<MemorySnapshot>()), now: () => NOW, agentsMd: { append: async () => {} } }
    const r = await executePromote({ confirmedIds: ['mem_dup'], target: 'global' }, ctx, deps, { target: PROJECT })
    expect(r.promoted).toEqual([])
    expect(r.taken).toEqual(['mem_dup'])
    expect(await locateCopy(h.store, 'mem_dup', PROJECT)).toMatchObject({ scope: 'workspace', status: 'active' })
    expect(await locateCopy(h.store, 'mem_dup', GLOBAL)).toMatchObject({ status: 'deleted' })
  })
})
