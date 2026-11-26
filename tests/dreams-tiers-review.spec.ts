import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore } from '../src/store.ts'
import { PendingDecisionsStore } from '../src/governance/decisions.ts'
import { SnapshotStore } from '../src/governance/snapshots.ts'
import { versionPlan } from '../src/governance/changeset-plans.ts'
import type { MemorySnapshot, PendingDecision } from '../src/governance/schema.ts'
import { executeConfirm } from '../src/tools/confirm.ts'
import { evidenceKindOf } from '../src/tools/dreams-tiers.ts'
import type { SessionLog } from '../src/session-log.ts'
import { InMemoryTable } from './helpers/in-memory-table.ts'
import { InMemoryBatchKvTable, InMemoryKvTable } from './helpers/in-memory-kv.ts'
import { record } from './helpers/record.ts'
import { noInstructions } from './helpers/instructions.ts'
import { FAKE_SECRET } from './helpers/secrets.ts'

const NOW = 1_700_000_000_000
const GLOBAL = { kind: 'global' as const }

describe('梦境方案与证据的输入边界', () => {
  it('结果和调用都缺配对标识时不能把结果当作工具依据', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pm-tier-call-id-'))
    try {
      const memoryRoot = join(root, 'memories')
      const cwd = join(root, 'project')
      await mkdir(memoryRoot)
      await mkdir(cwd)
      const log: SessionLog = {
        header: { isSeeded: false, cwd }, inheritedEventCount: 0,
        events: [
          { type: 'tool/call', seq: 0, data: { name: 'web_search', arguments: '{}' } },
          { type: 'tool/result', seq: 1, data: { message: { content: [{ type: 'text', text: '未找到对应调用的结果' }] } } },
        ],
      }
      expect(await evidenceKindOf(log, 1, { memoryRoot, pluginTools: [] })).toBe('unknown')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('方案生成后依据方标签出现高危凭据时采纳返回失效并保留双方和条目', async () => {
    const store = new MemoryStore(new InMemoryTable('/in-memory', () => NOW), undefined, new InMemoryBatchKvTable())
    const decisions = new PendingDecisionsStore(new InMemoryKvTable<PendingDecision>())
    const snapshots = new SnapshotStore(new InMemoryKvTable<MemorySnapshot>())
    for (const id of ['mem_old', 'mem_new']) await store.create(record({ id, name: id, createdAt: NOW, updatedAt: NOW }))
    const old = (await store.get('mem_old', GLOBAL))!
    const newer = (await store.get('mem_new', GLOBAL))!
    const { entry } = await decisions.upsert({ memoryIds: [old.id, newer.id], workspaces: ['global', 'global'], summary: '状态不同' }, NOW)
    const ops = versionPlan({ id: 'version', current: newer, old, group: 'group' })
    await decisions.reviseFinding(entry.id, current => ({ ...current, kind: 'important-pending', change: 'state-change', dreamsHold: {
      runId: 'run', at: NOW, cause: 'important', fromKind: 'conflict', conclusion: 'conclusion',
      proposal: { ops, newer: newer.id, reason: '状态变化', excerpts: [] },
    } }), id => store.get(id, GLOBAL))
    const held = await decisions.get(entry.id)
    await store.updateIfLive({ id: newer.id }, current => ({ ...current, tags: [FAKE_SECRET.github] }))
    expect(await executeConfirm({ action: 'resolve', decisionId: entry.id, verdict: 'adopt' }, { workspacePath: undefined },
      { store, decisions, snapshots, instructions: noInstructions, now: () => NOW })).toMatchObject({ kind: 'error', code: 'stale' })
    expect((await store.get(old.id, GLOBAL))!.status).toBe('active')
    expect((await store.get(newer.id, GLOBAL))!.status).toBe('active')
    expect(await decisions.get(entry.id)).toEqual(held)
  })
})
