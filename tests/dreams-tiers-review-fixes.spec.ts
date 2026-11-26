import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileTable } from '../src/storage/file-table.ts'
import { OpJournal } from '../src/storage/op-journal.ts'
import { createRootLock } from '../src/storage/root-lock.ts'
import { CheckupCache } from '../src/storage/checkup-cache.ts'
import type { DreamMarks, DreamsRecord, RecallStats } from '../src/storage/schema.ts'
import { MemoryStore } from '../src/store.ts'
import { PendingDecisionsStore, conflictFingerprint, isConflictOpen } from '../src/governance/decisions.ts'
import { SnapshotStore } from '../src/governance/snapshots.ts'
import { ledgerSteps } from '../src/governance/op-steps.ts'
import { kindOf, type MemorySnapshot, type PendingDecision, type ScanCacheEntry } from '../src/governance/schema.ts'
import { DREAMS_DEFAULTS } from '../src/governance/dreams-gate.ts'
import { DreamsStore } from '../src/governance/dreams-records.ts'
import { pairBasis, parseTierReply } from '../src/governance/dreams-tiers.ts'
import { versionPlan } from '../src/governance/changeset-plans.ts'
import { DREAMS_INITIATOR } from '../src/governance/write-gate.ts'
import { scoreScope } from '../src/governance/scope-health.ts'
import { applyChangeset } from '../src/tools/changeset.ts'
import { prereadScopes } from '../src/tools/scope-preread.ts'
import { runScan } from '../src/tools/scan.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'
import { runDreams, type DreamsStep } from '../src/tools/dreams-run.ts'
import { evidenceKindOf, resolveFindingsStep, type ResolveFindingsDeps } from '../src/tools/dreams-tiers.ts'
import { executeConfirm } from '../src/tools/confirm.ts'
import { executeUndo } from '../src/tools/undo.ts'
import type { MemoryRecord } from '../src/record-schema.ts'
import type { SessionLog } from '../src/session-log.ts'
import type { Scope } from '../src/scope.ts'
import { InMemoryBatchKvTable, InMemoryKvTable } from './helpers/in-memory-kv.ts'
import { noInstructions } from './helpers/instructions.ts'
import { record } from './helpers/record.ts'
import { FAKE_SECRET } from './helpers/secrets.ts'
import { messageFrom } from './helpers/session-log.ts'

const NOW = 1_800_000_000_000
const OLD_AT = Date.UTC(2025, 2, 1, 2)
const NEW_AT = Date.UTC(2025, 5, 1, 2)
const GLOBAL: Scope = { kind: 'global' }
const PROJECT: Scope = { kind: 'workspace', workspacePath: '/proj/a' }
const quiet = { info() {}, warn() {}, error() {} }
const registry = buildTypeRegistry({ template: 'coding', customTypes: {} })

// 真实记忆文件、写锁和操作日志；只在文件系统、侧表与宿主边界计数或插入确定的交错。
class ReadTable extends FileTable {
  scopeReads = 0
  override async readScope(...args: Parameters<FileTable['readScope']>) {
    this.scopeReads++
    return super.readScope(...args)
  }
}

class LedgerTable extends InMemoryKvTable<PendingDecision> {
  beforeClaim: (() => Promise<void>) | undefined
  override async claim(key: string) {
    const before = this.beforeClaim
    this.beforeClaim = undefined
    await before?.()
    return super.claim(key)
  }
}

let root: string
let journal: OpJournal
let table: ReadTable
let ledger: LedgerTable
let store: MemoryStore
let decisions: PendingDecisionsStore
let snapshots: SnapshotStore
let dreams: DreamsStore
let sessions: Map<string, SessionLog>
let prompts: string[]
let reply: (user: string) => unknown | Promise<unknown>
let runSeq: number
let stepReads: number

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pm-dreams-fixes-'))
  journal = new OpJournal({ path: join(root, '.state', 'ops.sqlite'), log: quiet })
  const lock = createRootLock({ root, log: quiet })
  const stats = new InMemoryBatchKvTable<RecallStats>()
  ledger = new LedgerTable()
  decisions = new PendingDecisionsStore(ledger, lock)
  snapshots = new SnapshotStore(new InMemoryKvTable<MemorySnapshot>())
  dreams = new DreamsStore(new InMemoryKvTable<DreamsRecord>(), new InMemoryKvTable<DreamMarks>())
  table = new ReadTable({ root, stats, log: quiet, lock, journal, now: () => NOW })
  store = new MemoryStore(table, quiet, stats)
  store.registerSteps(ledgerSteps(decisions, quiet))
  sessions = new Map()
  prompts = []
  reply = confident
  runSeq = 0
  stepReads = 0
})

afterEach(async () => {
  journal.close()
  await rm(root, { recursive: true, force: true })
})

async function pair(opts: { important?: boolean; locked?: boolean; scope?: Scope; prefix?: string } = {}) {
  const scope = opts.scope ?? GLOBAL
  const prefix = opts.prefix ?? 'mem'
  const members: MemoryRecord[] = []
  for (const [suffix, text, at, factTime] of [
    ['old', '项目用 npm 管依赖', OLD_AT, '2025-03-01'],
    ['new', '从今天起改用 pnpm', NEW_AT, '2025-06-01'],
  ] as const) {
    const id = `${prefix}_${suffix}`
    sessions.set(id, { header: { isSeeded: false }, inheritedEventCount: 0,
      events: [{ type: 'turn/start', seq: 0, time: at }, messageFrom('user', 1, text, at)] })
    const { source: _source, ...memory } = record({ id, name: id, content: text, summary: text, factTime,
      type: opts.important ? 'decision' : 'knowledge', createdAt: NOW, updatedAt: NOW, lastConfirmedAt: NOW,
      ...(scope.kind === 'workspace' ? { scope: 'workspace', workspacePath: scope.workspacePath } : {}),
      ...(suffix === 'old' && opts.locked ? { locked: true } : {}),
      sourceTrail: [{ sessionId: id, eventRange: [1, 1], sourceMode: 'user-explicit', at, change: 'create', by: 'main' }],
    })
    await store.create(memory)
    members.push((await store.get(id, scope))!)
  }
  await store.maintain(scope)
  return members as [MemoryRecord, MemoryRecord]
}

async function report(members: readonly MemoryRecord[], kind: 'conflict' | 'missed-change' = 'conflict') {
  return (await decisions.upsert({ kind, memoryIds: members.map(r => r.id), summary: '包管理器的说法对不上',
    fingerprint: conflictFingerprint(members), workspaces: members.map(r => r.workspacePath ?? 'global'),
  }, NOW)).entry
}

function confident(user: string) {
  const number = /\[#(\d+)\][^\n]*改用 pnpm/.exec(user)
  if (number === null) throw new Error('出处里没有新的一方的原话')
  return { ids: ['mem_old', 'mem_new'], newer: 'mem_new', subject: '包管理器', dimension: '用哪个', compatible: false,
    change: 'state-change', uncertain: false, evidence: [Number(number[1])], reason: '用户明确改用 pnpm' }
}

/** 宿主替身：会话清单就是 sessions 里的会话，没有存档的。 */
const hostOf = (readSessionLog: ResolveFindingsDeps['host']['readSessionLog']): ResolveFindingsDeps['host'] => ({
  readSessionLog,
  listSessions: async () => [...sessions.keys()].map(id => ({ id, cwd: undefined, isSubagent: false, isLive: false })),
  archivedSessionIds: async () => new Set<string>(),
})

async function run(scope: Scope = GLOBAL, overrides: Partial<ResolveFindingsDeps> = {}) {
  const step = resolveFindingsStep({ store, decisions, dreams, host: hostOf(async id => sessions.get(id) ?? null),
    noReview: { isMarkedNoReview: async () => false }, memoryRoot: root, tier: () => 'gatekeep',
    focusTypes: () => ['preference', 'profile', 'decision'], now: () => NOW, ...overrides })
  const measured: DreamsStep = { ...step, run: async ctx => {
    table.scopeReads = 0
    await step.run(ctx)
    stepReads = table.scopeReads
  } }
  const warnings: unknown[] = []
  const result = await runDreams(scope, { by: 'manual' }, {
    store, decisions, snapshots, dreams, log: { ...quiet, warn: (_message, detail) => { warnings.push(detail) } },
    claimScope: async () => ({ release: async () => {} }),
    activity: async () => ({ isComplete: true, workspaces: new Map() }),
    resolveLlm: async () => ({ isSelected: true, fellBack: false, llm: { model: 'stub', complete: async prompt => {
      prompts.push(prompt.user)
      return JSON.stringify(await reply(prompt.user))
    } } }),
    config: () => ({ ...DREAMS_DEFAULTS, minChanges: 0, maxChangeRatio: 1 }),
    isGovernanceEnabled: () => true, plan: [measured], interval: () => () => {}, now: () => NOW,
    newRunId: () => `run_${++runSeq}`,
  })
  expect(result.kind, String(warnings)).toBe('completed')
  return result
}

const get = async (id: string, scope: Scope = GLOBAL) => (await store.get(id, scope))!
const undo = (decisionId: string) => executeUndo({ decisionId }, { workspacePath: undefined }, {
  store, decisions, snapshots, dreams, ignores: { unignoreIfSame: async () => false }, now: () => NOW, log: quiet,
})
const skipped = async (scope = 'global') => (await dreams.read()).records.get(scope)?.lastResult?.skipped?.items ?? []

describe('梦境裁决与体检的衔接', () => {
  it('撤销采纳纠错时收拢重复发现，保留原条目与待定方案', async () => {
    const members = await pair({ important: true })
    const entry = await report(members)
    reply = user => ({ ...confident(user), change: 'correct', draft: { content: '项目一直用 pnpm 管依赖' } })
    await run()
    const held = (await decisions.get(entry.id))!
    expect(await executeConfirm({ action: 'resolve', decisionId: entry.id, verdict: 'adopt' }, { workspacePath: undefined },
      { store, decisions, snapshots, instructions: noInstructions, now: () => NOW, log: quiet })).toMatchObject({ kind: 'resolved', verdict: 'adopt' })
    const again = await report([await get('mem_old'), await get('mem_new')])
    expect(again.id).not.toBe(entry.id)
    expect(await undo(entry.id)).toMatchObject({ kind: 'undone' })
    expect(await decisions.list()).toEqual([expect.objectContaining({ id: entry.id, kind: 'important-pending', dreamsHold: held.dreamsHold })])
    expect((await get('mem_old')).content).toBe(members[0].content)
  })

  it('等待用户采纳的冲突仍进入预读，漏记变化和无方案来历的条目不混入冲突', async () => {
    const entry = await report(await pair({ important: true }))
    await run()
    const held = (await decisions.get(entry.id))!
    await ledger.put('other', { ...held, id: 'other', dreamsHold: { ...held.dreamsHold!, fromKind: 'missed-change' } })
    const { dreamsHold: _hold, ...withoutHold } = held
    await ledger.put('unknown', { ...withoutHold, id: 'unknown' })
    const data = await prereadScopes({ store, decisions, cache: new InMemoryKvTable<ScanCacheEntry>() }, [GLOBAL])
    expect(data.pending).toEqual([held])
    expect(isConflictOpen(data.pending)({ type: 'conflict', memoryIds: held.memoryIds })).toBe(true)
  })

  it('等待用户采纳时健康分仍扣冲突分，体检仍列出同一冲突', async () => {
    await pair({ important: true })
    const cache = new InMemoryKvTable<ScanCacheEntry>()
    const checkupCache = new CheckupCache({ path: join(root, '.state', 'checkup.sqlite'), log: quiet })
    let scanCalls = 0
    const scan = () => runScan({ target: { kind: 'scope', scope: GLOBAL }, llm: { model: 'stub', complete: async () => {
      scanCalls++
      return JSON.stringify({ findings: [{ type: 'conflict', memoryIds: ['mem_old', 'mem_new'], summary: '包管理器不同', suggestedAction: '确认采用哪一个' }] })
    } } }, { store, decisions, cache, checkupCache, registry, instructions: noInstructions, now: () => NOW })
    try {
      await scan()
      const before = scoreScope({ registry }, await prereadScopes({ store, decisions, cache }, [GLOBAL]), GLOBAL, NOW)
      expect(before.health.counts.conflict).toBe(1)
      await run()
      const [held] = await decisions.list()
      expect(kindOf(held!)).toBe('important-pending')
      const data = await prereadScopes({ store, decisions, cache }, [GLOBAL])
      const after = scoreScope({ registry }, data, GLOBAL, NOW)
      expect(after.health).toEqual(before.health)
      expect(after.semanticFindings).toEqual(before.semanticFindings)
      expect(after.health.score).toBeLessThan(scoreScope({ registry }, { ...data, pending: [] }, GLOBAL, NOW).health.score)
      expect(await scan()).toMatchObject({ kind: 'single', findings: expect.arrayContaining(before.semanticFindings) })
      expect(scanCalls).toBe(1)
      expect(await decisions.get(held!.id)).toEqual(held)
    } finally { checkupCache.close() }
  })

  it('撤销直接处理后增量体检重新挂账，再跑梦境交给用户且不重复问模型', async () => {
    await pair()
    const cache = new InMemoryKvTable<ScanCacheEntry>()
    const checkupCache = new CheckupCache({ path: join(root, '.state', 'checkup.sqlite'), log: quiet })
    let scanCalls = 0
    const scan = () => runScan({ target: { kind: 'scope', scope: GLOBAL }, llm: { model: 'stub', complete: async () => {
      scanCalls++
      return JSON.stringify({ findings: [{ type: 'conflict', memoryIds: ['mem_old', 'mem_new'], summary: '包管理器不同', suggestedAction: '确认包管理器' }] })
    } } }, { store, decisions, cache, checkupCache, registry, instructions: noInstructions, now: () => NOW })
    try {
      await scan()
      expect(scanCalls).toBe(1)
      expect(await decisions.list()).toHaveLength(1)
      await run()
      expect((await get('mem_old')).status).toBe('deleted')
      expect(await undo('run_1')).toMatchObject({ kind: 'undone' })
      expect((await get('mem_old')).status).toBe('active')
      expect(await decisions.list()).toEqual([])
      await scan()
      expect(scanCalls).toBe(1)
      const [reopened] = await decisions.list()
      expect(reopened?.memoryIds).toEqual(['mem_old', 'mem_new'])
      const calls = prompts.length
      await run()
      expect(prompts).toHaveLength(calls)
      expect((await decisions.get(reopened!.id))?.dreamsReview?.outcome).toBe('undone-before')
      expect((await get('mem_old')).status).toBe('active')
    } finally { checkupCache.close() }
  })
})

const branches = ['等待采纳', '交给用户', '直接处理'] as const

describe('梦境写前复核', () => {
  it.each(branches)('模型等待期间发现改判时%s保留新种类，不写过时结论', async branch => {
    const members = await pair({ important: branch === '等待采纳' })
    const entry = await report(members)
    let changed: PendingDecision
    reply = async user => {
      changed = await report(members, 'missed-change')
      return branch === '交给用户' ? {} : confident(user)
    }
    await run()
    expect(await decisions.get(entry.id)).toEqual(changed!)
    expect((await get('mem_old')).status).toBe('active')
    expect(await skipped()).toEqual(expect.arrayContaining([expect.objectContaining({ reason: branch === '直接处理' ? 'entry-changed' : 'basis-changed' })]))
  })

  it.each(branches)('同标识的其他范围重报时%s保留新范围条目，两个范围的记忆都不改', async branch => {
    const members = await pair({ important: branch === '等待采纳', scope: PROJECT })
    const entry = await report(members)
    const globals = await pair()
    let changed: PendingDecision
    reply = async user => {
      changed = await report(globals)
      expect(changed.id).toBe(entry.id)
      return branch === '交给用户' ? {} : confident(user)
    }
    await run(PROJECT)
    expect(await decisions.get(entry.id)).toEqual(changed!)
    for (const scope of [GLOBAL, PROJECT]) for (const id of ['mem_old', 'mem_new']) expect((await get(id, scope)).status).toBe('active')
  })

  it('写锁定通知前用户解锁时保留原发现，不写过时通知', async () => {
    const entry = await report(await pair({ locked: true }))
    ledger.beforeClaim = async () => {
      await store.updateIfLive({ id: 'mem_old' }, current => { const { locked: _locked, ...rest } = current; return rest })
    }
    await run()
    expect(await decisions.get(entry.id)).toEqual(entry)
    expect(prompts).toEqual([])
    expect(await skipped()).toEqual(expect.arrayContaining([expect.objectContaining({ reason: 'basis-changed' })]))
  })

  it('解锁重开前条目转到其他范围时保留该范围的锁定通知', async () => {
    const entry = await report(await pair({ locked: true }))
    await run()
    const held = (await decisions.get(entry.id))!
    await store.updateIfLive({ id: 'mem_old' }, current => { const { locked: _locked, ...rest } = current; return rest })
    const changed = { ...held, workspaces: ['/proj/b', '/proj/b'] }
    ledger.beforeClaim = () => ledger.put(entry.id, changed)
    await run()
    expect(await decisions.get(entry.id)).toEqual(changed)
    expect(prompts).toEqual([])
  })

  it('模型等待期间已有其他核实记录时保留该记录，不重复写入', async () => {
    const members = await pair({ important: true })
    const entry = await report(members)
    const changed = { ...entry, dreamsReview: { runId: 'other', at: NOW, outcome: 'order-unclear' as const, basis: pairBasis(members) } }
    reply = async user => { await ledger.put(entry.id, changed); return confident(user) }
    await run()
    expect(await decisions.get(entry.id)).toEqual(changed)
    expect((await get('mem_old')).status).toBe('active')
  })
})

describe('读取与写入许可', () => {
  it('同次运行只整读一次范围，后一对在处理前精确读到最新正文', async () => {
    await report(await pair())
    const other = await pair({ prefix: 'other' })
    const entry = await report(other)
    reply = async () => {
      if (prompts.length === 1) await store.updateIfLive({ id: 'other_old' }, current => ({ ...current, content: '稍后确认的新正文' }))
      return {}
    }
    await run()
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toContain('稍后确认的新正文')
    expect(stepReads).toBe(1)
    expect((await decisions.get(entry.id))?.dreamsReview?.basis).toBe(pairBasis([await get('other_old'), await get('other_new')]))
  })

  it('同一对来自同一会话时只读一次日志，原文和依据类别采用同一份', async () => {
    const members = await pair()
    const log: SessionLog = { header: { isSeeded: false }, inheritedEventCount: 0, events: [
      { type: 'turn/start', seq: 0, time: OLD_AT }, messageFrom('user', 1, members[0].content, OLD_AT),
      { type: 'turn/start', seq: 2, time: NEW_AT }, messageFrom('user', 3, members[1].content, NEW_AT),
    ] }
    for (const [i, member] of members.entries()) await store.updateIfLive({ id: member.id }, current => ({ ...current,
      sourceTrail: [{ ...current.sourceTrail![0]!, sessionId: 'shared', eventRange: i === 0 ? [1, 1] : [3, 3] }],
    }))
    await report([await get('mem_old'), await get('mem_new')])
    let reads = 0
    sessions.set('shared', log)
    await run(GLOBAL, { host: hostOf(async () => {
      reads++
      return reads === 1 ? log : { ...log, events: log.events.map(e => e.seq === 3 ? messageFrom('assistant', 3, '另一版日志', NEW_AT) : e) }
    }) })
    expect(reads).toBe(1)
    expect((await get('mem_old')).status).toBe('deleted')
    expect(prompts[0]).toContain('从今天起改用 pnpm')
  })

  it.each([false, true])('并入去向锁定时变更集跳过并保留双方，分组为 %s', async isGrouped => {
    const [old, newer] = await pair()
    await store.updateIfLive({ id: newer.id }, current => ({ ...current, locked: true }))
    const ops = versionPlan({ id: 'version', current: newer, old, ...(isGrouped ? { group: 'version-group' } : {}) })
    const result = await applyChangeset(ops, { entryId: 'batch', by: DREAMS_INITIATOR, at: NOW, isSecretChecked: true }, { store, decisions, snapshots })
    expect(result.outcomes).toEqual([expect.objectContaining({ kind: 'skipped', reason: 'locked', memoryId: newer.id })])
    expect((await get(old.id)).status).toBe('active')
    expect((await get(newer.id)).status).toBe('active')
  })

  it('配对标识完整但工具结果失败时不作为依据', async () => {
    const log: SessionLog = { header: { isSeeded: false }, inheritedEventCount: 0, events: [
      { type: 'tool/call', seq: 0, data: { callId: 'call', name: 'search', arguments: '{}' } },
      { type: 'tool/result', seq: 1, data: { message: { toolCallId: 'call', isError: true, content: [{ type: 'text', text: '读取失败' }] } } },
    ] }
    expect(await evidenceKindOf(log, 1, { memoryRoot: root, pluginTools: [] })).toBe('other')
  })
})

describe('作用域、密钥与回复格式的复核', () => {
  it.each([['缺省', undefined], ['空', []], ['只有一项', ['/proj/a']]] as const)(
    '条目作用域%s时信任档不处理这一对', async (_label, workspaces) => {
      const members = await pair({ scope: PROJECT })
      const { entry } = await decisions.upsert({ memoryIds: members.map(r => r.id), summary: '包管理器的说法对不上',
        fingerprint: conflictFingerprint(members), ...(workspaces === undefined ? {} : { workspaces: [...workspaces] }) }, NOW)
      await run(PROJECT, { tier: () => 'trust' })
      expect(prompts).toEqual([])
      expect(await decisions.get(entry.id)).toEqual(entry)
      for (const id of ['mem_old', 'mem_new']) expect((await get(id, PROJECT)).status).toBe('active')
    })

  it.each([
    ['等待采纳', 'mem_new', 'state-change'],
    ['直接处理状态变化', 'mem_new', 'state-change'],
    ['直接处理纠错', 'mem_old', 'correct'],
  ] as const)('模型等待期间标签写进密钥时%s不落盘', async (branch, target, change) => {
    const members = await pair({ important: branch === '等待采纳' })
    const entry = await report(members)
    reply = async user => {
      await store.updateIfLive({ id: target }, current => ({ ...current, tags: [FAKE_SECRET.github] }))
      return change === 'correct' ? { ...confident(user), change, draft: { content: '项目一直用 pnpm 管依赖' } } : confident(user)
    }
    await run()
    expect(await decisions.get(entry.id)).toEqual(entry)
    expect(await get('mem_old')).toMatchObject({ status: 'active', content: members[0].content })
    expect(await skipped()).toEqual(expect.arrayContaining([expect.objectContaining({ reason: 'basis-changed' })]))
  })

  it('等待采纳的旧条目被其他范围同内容重报时撤下方案', async () => {
    const entry = await report(await pair({ important: true, scope: PROJECT }))
    await run(PROJECT)
    expect((await decisions.get(entry.id))?.dreamsHold?.proposal).toBeDefined()
    const again = await report(await pair())
    expect(again.id).toBe(entry.id)
    expect(again.workspaces).toEqual(['global', 'global'])
    expect(kindOf(again)).toBe('conflict')
    expect(again).not.toHaveProperty('dreamsHold')
    expect(again).not.toHaveProperty('change')
    expect(again).not.toHaveProperty('evidence')
  })

  it('模型在 JSON 前后多说一句时照样读出回复', () => {
    expect(parseTierReply('好的，结果如下：\n```json\n{"ids":["a","b"],"newer":"b"}\n```\n以上。')).toMatchObject({ ids: ['a', 'b'], newer: 'b' })
  })
})
