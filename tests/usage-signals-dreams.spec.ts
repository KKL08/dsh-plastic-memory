import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { FileTable } from '../src/storage/file-table.ts'
import { OpJournal } from '../src/storage/op-journal.ts'
import { createRootLock, type SqliteModule } from '../src/storage/root-lock.ts'
import type { DreamMarks, DreamsRecord, RecallStats } from '../src/storage/schema.ts'
import { MemoryStore } from '../src/store.ts'
import { PendingDecisionsStore } from '../src/governance/decisions.ts'
import { SnapshotStore } from '../src/governance/snapshots.ts'
import { ledgerSteps } from '../src/governance/op-steps.ts'
import type { MemorySnapshot, PendingDecision } from '../src/governance/schema.ts'
import type { SemanticLlm } from '../src/governance/semantic-scan.ts'
import { DREAMS_DEFAULTS } from '../src/governance/dreams-gate.ts'
import { DreamsStore } from '../src/governance/dreams-records.ts'
import { TIDY_USAGE_NOTE, buildTidyPrompt } from '../src/governance/dreams-tidy.ts'
import { runDreams, type DreamsRunDeps } from '../src/tools/dreams-run.ts'
import { tidyMemoriesStep } from '../src/tools/dreams-tidy.ts'
import type { MemoryRecord, RecallTier } from '../src/record-schema.ts'
import { InMemoryBatchKvTable, InMemoryKvTable } from './helpers/in-memory-kv.ts'
import { record } from './helpers/record.ts'

// 使用信号进记忆梦境：逐条整理的提示词里每条记忆带使用情况（召回次数加三项信号），只当参考。
// 拿不到信号时只带召回次数、不写 0；信号不改分批、不让代码自己动手。真文件、真操作日志库；模型是记下提示词的桩。

const quiet = { info() {}, warn() {}, error() {} }
const GLOBAL = { kind: 'global' } as const
const NOW = 1_800_000_000_000
const typeRecall = (): RecallTier => 'search'

let root: string
let journal: OpJournal
let stats: InMemoryBatchKvTable<RecallStats>
let store: MemoryStore
let decisions: PendingDecisionsStore
let snapshots: SnapshotStore
let dreams: DreamsStore
let runSeq = 0
const prompts: Array<{ system: string; user: string }> = []
let reply: unknown[] = []

const llm: SemanticLlm = {
  model: 'stub',
  complete: async (prompt, _signal, onUsage) => {
    prompts.push(prompt)
    onUsage?.(10)
    return JSON.stringify({ operations: reply })
  },
}

function open(loadSqlite: () => SqliteModule | undefined = () => ({ DatabaseSync })) {
  journal = new OpJournal({ path: join(root, 'local', 'op-journal.sqlite'), log: quiet, loadSqlite })
  const lock = createRootLock({ root, log: quiet })
  stats = new InMemoryBatchKvTable<RecallStats>()
  store = new MemoryStore(new FileTable({ root, stats, log: quiet, lock, journal, now: () => NOW }), quiet, stats, journal)
  decisions = new PendingDecisionsStore(new InMemoryKvTable<PendingDecision>(), lock)
  store.registerSteps(ledgerSteps(decisions, quiet))
  snapshots = new SnapshotStore(new InMemoryKvTable<MemorySnapshot>())
  dreams = new DreamsStore(new InMemoryKvTable<DreamsRecord>(), new InMemoryKvTable<DreamMarks>())
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pm-usage-dreams-'))
  prompts.length = 0
  reply = []
  runSeq = 0
  open()
})
afterEach(async () => {
  journal.close()
  await rm(root, { recursive: true, force: true })
})

function deps(): DreamsRunDeps {
  const claims = new InMemoryKvTable<{ id: string }>()
  return {
    store, snapshots, decisions, dreams, log: quiet,
    claimScope: async (scope) => {
      const release = await claims.claim(scope.kind)
      return release === undefined ? { busy: scope } : { release }
    },
    activity: async () => ({ isComplete: true, workspaces: new Map() }),
    resolveLlm: async () => ({ llm, isSelected: true, fellBack: false }),
    config: () => ({ ...DREAMS_DEFAULTS, minChanges: 0, maxChangeRatio: 1 }),
    isGovernanceEnabled: () => true,
    plan: [tidyMemoriesStep({ store, maxTopics: () => 30, now: () => NOW, typeRecall })],
    interval: () => () => {},
    now: () => NOW,
    newRunId: () => `run_${++runSeq}`,
  }
}
const dream = () => runDreams(GLOBAL, { by: 'manual' }, deps())

async function seed(ids: string[]) {
  for (const id of ids) {
    await store.create(record({ id, name: `${id} 的名称`, summary: `${id} 的摘要`, content: `${id} 的正文`, createdAt: NOW, updatedAt: NOW, lastConfirmedAt: NOW }))
  }
  await store.maintain(GLOBAL)
}
const ref = (id: string) => ({ id, scope: 'global' as const, workspacePath: undefined })
type Row = { id: string; usage?: Record<string, number> }
/** 提示词 user 段里 JSON 的成员行，按 id。 */
function rowsOf(prompt: { user: string }): Map<string, Row> {
  const groups = JSON.parse(prompt.user.slice(prompt.user.indexOf('['))) as Array<{ members: Row[] }>
  return new Map(groups.flatMap(g => g.members).map(m => [m.id, m]))
}

describe('提示词里的使用情况', () => {
  it('拿得到信号：每条带召回次数和三项计数，没有信号的那条三项记 0；说明段讲清 usage 只作参考', async () => {
    await seed(['mem_a', 'mem_b'])
    await stats.put('mem_a', { id: 'mem_a', recallCount: 7, lastRecalledAt: NOW - 1000 })
    store.noteUsage(ref('mem_a'), { kind: 'full-read', key: 's1', at: NOW })
    store.noteUsage(ref('mem_a'), { kind: 'full-read', key: 's2', at: NOW })
    store.noteUsage(ref('mem_a'), { kind: 'confirm', key: 'c1', at: NOW })
    store.noteUsage(ref('mem_a'), { kind: 'quick-correction', key: 'op_1', at: NOW })
    const r = await dream()
    expect(r.kind).toBe('completed')
    expect(prompts).toHaveLength(1)
    const rows = rowsOf(prompts[0]!)
    expect(rows.get('mem_a')!.usage).toEqual({ recalls: 7, fullReads: 2, confirms: 1, quickCorrections: 1 })
    expect(rows.get('mem_b')!.usage).toEqual({ recalls: 0, fullReads: 0, confirms: 0, quickCorrections: 0 })
    expect(prompts[0]!.system).toContain(TIDY_USAGE_NOTE)
  })

  it('信号库不可用：梦境照常跑完，每条只带召回次数，三项不出现（不写成 0）', async () => {
    journal.close()
    open(() => undefined)
    await seed(['mem_a'])
    await stats.put('mem_a', { id: 'mem_a', recallCount: 3, lastRecalledAt: NOW - 1000 })
    expect(store.readUsage(GLOBAL, ['mem_a'])).toBeUndefined()
    const r = await dream()
    expect(r.kind).toBe('completed')
    expect(prompts).toHaveLength(1)
    expect(rowsOf(prompts[0]!).get('mem_a')!.usage).toEqual({ recalls: 3 })
  })

  it('说明段的常量非空', () => {
    expect(TIDY_USAGE_NOTE.trim()).not.toBe('')
  })
})

describe('信号只当参考', () => {
  it('一条攒了很多纠错、从没被读过：模型没给操作时代码什么都不改，注入档位和内容原样', async () => {
    await seed(['mem_a'])
    for (const key of ['op_1', 'op_2', 'op_3']) store.noteUsage(ref('mem_a'), { kind: 'quick-correction', key, at: NOW })
    const before = await store.get('mem_a', {})
    const r = await dream()
    expect(r.kind).toBe('completed')
    expect(rowsOf(prompts[0]!).get('mem_a')!.usage).toMatchObject({ quickCorrections: 3 })
    const after = await store.get('mem_a', {})
    expect(after).toEqual(before)
    expect(after!.recall).toBeUndefined()
  })

  it('分组、成员顺序不随信号变：同一批记忆有没有信号，交给模型的分组和顺序一样', async () => {
    await seed(['mem_a', 'mem_b', 'mem_c'])
    const files = (await store.readIndex(GLOBAL))!
    const read = await store.readRaw(GLOBAL)
    const members = new Map<string, MemoryRecord>(read.records.map(({ record: r }) => [r.id, r]))
    const ids = new Set(members.keys())
    const plain = buildTidyPrompt(files, members, ids, typeRecall)
    const counts = new Map([['mem_c', { fullReads: 9, confirms: 9, quickCorrections: 0 }], ['mem_a', { fullReads: 0, confirms: 0, quickCorrections: 5 }]])
    const withUsage = buildTidyPrompt(files, members, ids, typeRecall, counts)
    const order = (p: { user: string }) => (JSON.parse(p.user.slice(p.user.indexOf('['))) as Array<{ topic: string; members: Row[] }>).map(g => [g.topic, g.members.map(m => m.id)])
    expect(order(withUsage)).toEqual(order(plain))
    expect(rowsOf(withUsage).get('mem_c')!.usage).toMatchObject({ fullReads: 9 })
  })
})
