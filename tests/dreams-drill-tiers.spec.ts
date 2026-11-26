import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileTable } from '../src/storage/file-table.ts'
import { OpJournal } from '../src/storage/op-journal.ts'
import { createRootLock } from '../src/storage/root-lock.ts'
import type { DreamMarks, DreamsRecord, RecallStats } from '../src/storage/schema.ts'
import { layerOf } from '../src/storage/history.ts'
import { MemoryStore } from '../src/store.ts'
import { PendingDecisionsStore, conflictFingerprint } from '../src/governance/decisions.ts'
import { SnapshotStore } from '../src/governance/snapshots.ts'
import { ledgerSteps } from '../src/governance/op-steps.ts'
import type { MemorySnapshot, PendingDecision } from '../src/governance/schema.ts'
import type { SemanticLlm } from '../src/governance/semantic-scan.ts'
import { DREAMS_DEFAULTS } from '../src/governance/dreams-gate.ts'
import { DreamsStore } from '../src/governance/dreams-records.ts'
import { resolveGroupId } from '../src/governance/dreams-merge.ts'
import { TIER_SYSTEM_PROMPT, tierConclusion } from '../src/governance/dreams-tiers.ts'
import { DRILL_FILL_SYSTEM_PROMPT, DRILL_REQUEST_SYSTEM_PROMPT } from '../src/governance/drill-down.ts'
import { scanFingerprint } from '../src/governance/changeset.ts'
import { runDreams, type DreamsRunDeps } from '../src/tools/dreams-run.ts'
import { dreamsPlan } from '../src/tools/dreams-plan.ts'
import { executeUndo } from '../src/tools/undo.ts'
import { mergedIntoOf, type MemoryRecord, type SourceAnchor } from '../src/record-schema.ts'
import type { RawEvent, SessionLog } from '../src/session-log.ts'
import type { Scope } from '../src/scope.ts'
import { InMemoryBatchKvTable, InMemoryKvTable } from './helpers/in-memory-kv.ts'
import { record } from './helpers/record.ts'
import { messageFrom } from './helpers/session-log.ts'

// 同一轮梦境里先下钻补全、再处理矛盾：处理矛盾用的是下钻之后现读的内容；批次条目上两边的记录（补回版本、下钻报告、
// 直接处理的矛盾）收尾时都留着，撤销各按各的规则。真文件、真操作日志、真写锁；宿主会话和模型是替身。本机时区固定成新加坡。

const quiet = { info() {}, warn() {}, error() {} }
const GLOBAL: Scope = { kind: 'global' }
const NOW = 1_800_000_000_000
const OLD_AT = Date.UTC(2025, 2, 1, 2)
const NEW_AT = Date.UTC(2025, 5, 1, 2)
const P_AT = Date.UTC(2025, 8, 1, 2)
const Q_AT = Date.UTC(2025, 9, 1, 2)

const ZONE = 'Asia/Singapore'
const savedTz = process.env.TZ
beforeAll(() => { process.env.TZ = ZONE })
afterAll(() => { if (savedTz === undefined) delete process.env.TZ; else process.env.TZ = savedTz })

const OLD_TEXT = '项目用 npm 管依赖'
const OLD_REASON = '因为 CI 镜像里只有 npm'
/** 下钻按 mem_old 出处里用户的第二句细化出来的正文。 */
const REFINED = `${OLD_TEXT}。原因：CI 镜像里只有 npm`

let root: string
let lock: ReturnType<typeof createRootLock>
let journal: OpJournal
let store: MemoryStore
let decisions: PendingDecisionsStore
let snapshots: SnapshotStore
let dreams: DreamsStore
let sessions: Map<string, SessionLog>
let warnings: unknown[]
let tierPrompts: string[]
let fillReplies: unknown[]
let runSeq: number

const reply = (value: unknown) => (typeof value === 'string' ? value : JSON.stringify(value))
/** 用户消息里含 text 的那条原文的编号。 */
function num(user: string, text: string): number {
  const m = new RegExp(`\\[#(\\d+)\\][^\\n]*${text}`).exec(user)
  if (m === null) throw new Error(`提示词里没有「${text}」`)
  return Number(m[1])
}
const llm: SemanticLlm = {
  model: 'stub',
  complete: async (prompt, _signal, onUsage) => {
    onUsage?.(10)
    if (prompt.system === DRILL_REQUEST_SYSTEM_PROMPT) {
      return reply({ requests: [
        { id: 'mem_old', gap: 'missing-reason', anchor: 1, purpose: 'fill-gap' },
        { id: 'mem_p', gap: 'fact-gap', anchor: 1, purpose: 'fill-gap' },
        { id: 'mem_q', gap: 'missing-basis', anchor: 1, purpose: 'fill-gap' },
      ] })
    }
    if (prompt.system === DRILL_FILL_SYSTEM_PROMPT) return reply(fillReplies.shift() ?? { result: 'none' })
    if (prompt.system === TIER_SYSTEM_PROMPT) {
      tierPrompts.push(prompt.user)
      return reply({
        ids: ['mem_old', 'mem_new'], subject: '这个项目的包管理器', dimension: '用哪个', compatible: false, newer: 'mem_new', change: 'state-change',
        uncertain: false, evidence: [num(prompt.user, '改用 pnpm')], reason: '用户说从今天起改用 pnpm',
      })
    }
    return reply({})
  },
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pm-dreams-drill-tiers-'))
  journal = new OpJournal({ path: join(root, '.state', 'op-journal.sqlite'), log: quiet })
  lock = createRootLock({ root, log: quiet })
  const stats = new InMemoryBatchKvTable<RecallStats>()
  decisions = new PendingDecisionsStore(new InMemoryKvTable<PendingDecision>(), lock)
  snapshots = new SnapshotStore(new InMemoryKvTable<MemorySnapshot>())
  dreams = new DreamsStore(new InMemoryKvTable<DreamsRecord>(), new InMemoryKvTable<DreamMarks>())
  store = new MemoryStore(new FileTable({ root, stats, log: quiet, lock, journal, now: () => NOW }), quiet, stats)
  store.registerSteps(ledgerSteps(decisions, quiet))
  sessions = new Map()
  warnings = []
  tierPrompts = []
  // 按请求的顺序：mem_old 按用户第二句细化（直接写）、mem_p 按用户第二句补回过去的状态（直接写）、mem_q 的稿引了助手的话（交给用户）
  fillReplies = [
    { result: 'refine', content: REFINED, evidence: [2] },
    { result: 'recover', content: '用 pnpm 7', summary: '那时用 pnpm 7', factTime: '2024-03', evidence: [2] },
    { result: 'refine', content: '用 vitest 跑测试。依据：和 vite 共用配置', evidence: [2] },
  ]
  runSeq = 0
})
afterEach(async () => {
  journal.close()
  await rm(root, { recursive: true, force: true })
})

/** 一条全局记忆，出处是会话 s_<id> 里的 seq 1、2 两条（同一轮）。 */
async function memory(id: string, spec: { type: string; mode: string; content: string; at: number; second: RawEvent; factTime?: string }): Promise<MemoryRecord> {
  sessions.set(`s_${id}`, { header: { isSeeded: false }, inheritedEventCount: 0, events: [
    { type: 'turn/start', seq: 0, time: spec.at }, messageFrom('user', 1, spec.content, spec.at), spec.second,
  ] })
  const trail: SourceAnchor[] = [{ sessionId: `s_${id}`, eventRange: [1, 2], sourceMode: spec.mode as SourceAnchor['sourceMode'], at: spec.at, change: 'create', by: 'main' }]
  const { source: _source, ...plain } = record({
    id, name: `${id} 的名称`, type: spec.type, content: spec.content, summary: `${id} 的摘要`, createdAt: NOW, updatedAt: NOW, lastConfirmedAt: NOW,
    ...(spec.factTime !== undefined ? { factTime: spec.factTime } : {}),
  })
  await store.create({ ...plain, sourceTrail: trail })
  await store.maintain(GLOBAL)
  return (await store.get(id, GLOBAL))!
}
const get = async (id: string) => (await store.get(id, GLOBAL))!
const versionsOf = async (id: string) => (await store.history.list(layerOf((await store.locate(id, GLOBAL))!), id)).versions
const entryOf = async (id: string) => (await decisions.listSettled()).find(d => d.id === id)
const undo = (decisionId: string, op?: string) => executeUndo(
  { decisionId, ...(op !== undefined ? { op } : {}) }, { workspacePath: undefined },
  { store, decisions, snapshots, dreams, log: quiet, ignores: { unignoreIfSame: async () => false }, now: () => NOW },
)

/**
 * 四条记忆：一对矛盾（mem_old、mem_new，体检按下钻之前的内容挂了发现、记了成员指纹）、一张状态页（mem_p）、一条决定（mem_q）。
 * 跑一轮插件的运行计划（dreamsPlan 的顺序，只留维护、下钻、处理矛盾三步：别的步骤不在这里测）。
 */
async function dreamOnce() {
  const old = await memory('mem_old', { type: 'knowledge', mode: 'agent-inferred', content: OLD_TEXT, at: OLD_AT, factTime: '2025-03-01', second: messageFrom('user', 2, OLD_REASON, OLD_AT) })
  const neu = await memory('mem_new', { type: 'knowledge', mode: 'user-explicit', content: '从今天起改用 pnpm', at: NEW_AT, factTime: '2025-06-01', second: messageFrom('user', 2, '以后都用 pnpm', NEW_AT) })
  await memory('mem_p', { type: 'project', mode: 'user-explicit', content: '现在用 pnpm 9', at: P_AT, factTime: '2025-09', second: messageFrom('user', 2, '去年三月我们还在用 pnpm 7', P_AT) })
  await memory('mem_q', { type: 'decision', mode: 'user-explicit', content: '用 vitest 跑测试', at: Q_AT, second: { type: 'assistant/message', seq: 2, time: Q_AT, data: { message: { id: 'a2', role: 'assistant', content: [{ type: 'text', text: '因为 vitest 和 vite 共用配置' }] } } } })
  const { entry: finding } = await decisions.upsert({
    memoryIds: ['mem_old', 'mem_new'], summary: '包管理器的说法对不上', workspaces: ['global', 'global'],
    fingerprint: conflictFingerprint([old, neu]), memberScanFingerprints: { mem_old: scanFingerprint(old), mem_new: scanFingerprint(neu) },
  }, NOW)
  const host = {
    readSessionLog: async (id: string) => sessions.get(id) ?? null,
    listSessions: async () => [...sessions.keys()].map(id => ({ id, cwd: undefined, isSubagent: false, isLive: false })),
    archivedSessionIds: async () => new Set<string>(),
  }
  const noReview = { isMarkedNoReview: async () => false }
  const plan = dreamsPlan({
    tidy: { store, maxTopics: () => 30, now: () => NOW, typeRecall: () => 'search' },
    merge: { store, dreams },
    drill: { store, decisions, host, noReview, maxDrillDowns: () => 5, now: () => NOW },
    resolve: { store, decisions, dreams, readSessionLog: host.readSessionLog, noReview, memoryRoot: root, tier: () => 'trust', focusTypes: () => [], now: () => NOW },
  }).filter(step => ['maintain', 'drill-down', 'resolve-findings'].includes(step.name))
  const claims = new InMemoryKvTable<{ id: string }>()
  const deps: DreamsRunDeps = {
    store, snapshots, decisions, dreams,
    log: { info() {}, warn: (_message, detail) => { warnings.push(detail) }, error() {} },
    claimScope: async () => {
      const release = await claims.claim('global')
      return release === undefined ? { busy: GLOBAL } : { release }
    },
    activity: async () => ({ isComplete: true, workspaces: new Map() }),
    resolveLlm: async () => ({ llm, isSelected: true, fellBack: false }),
    config: () => ({ ...DREAMS_DEFAULTS, minChanges: 0, maxChangeRatio: 1 }),
    isGovernanceEnabled: () => true,
    plan,
    interval: () => () => {},
    now: () => NOW,
    newRunId: () => `run_${++runSeq}`,
  }
  const result = await runDreams(GLOBAL, { by: 'manual' }, deps)
  if (result.kind !== 'completed') throw warnings.find(w => w instanceof Error) ?? new Error(`运行没做完：${result.kind}`)
  // 结论身份按处理矛盾时现读的两条算（mem_old 已细化），组号从条目上的结果取
  const group = (await entryOf('run_1'))!.dreamsResults![0]!.group
  return { old, neu, finding, group, conclusion: group.slice(resolveGroupId('run_1', '').length) }
}

describe('同一轮里先下钻、再处理矛盾', () => {
  it('处理矛盾核实和落盘用的是下钻细化之后现读的内容：体检记下的旧成员指纹不拿来写，细化的内容并进新的一方的历史', async () => {
    const { old, neu, finding, conclusion } = await dreamOnce()
    // 交给模型核实的是细化之后的正文
    expect(tierPrompts).toHaveLength(1)
    expect(tierPrompts[0]).toContain(REFINED)
    // 旧的一方按现读的那一版并成新的一方的历史版本：细化没被盖掉、也没按旧依据跳过
    expect(await get('mem_old')).toMatchObject({ status: 'deleted', content: REFINED })
    expect(mergedIntoOf(await get('mem_old'))).toMatchObject({ id: 'mem_new', as: 'version' })
    // 结论身份也按现读的两条算，不是体检时的那一版
    expect(conclusion).not.toBe(tierConclusion([old, neu]))
    expect(await decisions.get(finding.id)).toBeUndefined()
    const skipped = (await dreams.read()).records.get('global')?.lastResult?.skipped?.items ?? []
    expect(skipped.filter(i => i.kind === 'resolve')).toEqual([])
  })

  it('收尾：批次条目上记忆的回执、补回版本、下钻报告、直接处理的矛盾都留着', async () => {
    const { group } = await dreamOnce()
    const entry = (await entryOf('run_1'))!
    expect(entry.changes!.map(c => [c.memoryId, c.group])).toEqual([['mem_old', undefined], ['mem_old', group]])
    expect(entry.recoveredVersions!.map(r => r.memoryId)).toEqual(['mem_p'])
    expect(entry.drillDown!.filled.map(f => [f.memoryId, f.kind])).toEqual([['mem_old', 'refine'], ['mem_p', 'recovered']])
    expect(entry.drillDown!.proposals.map(p => p.memoryId)).toEqual(['mem_q'])
    expect(entry.dreamsResults!.map(r => [r.group, r.older, r.newer])).toEqual([[group, 'mem_old', 'mem_new']])
  })

  it('单撤：补回的版本删掉；矛盾那一组撤回、结论记下，结果列表照旧；细化撤回后条目还带着交给用户的稿，留着', async () => {
    const { group, conclusion } = await dreamOnce()
    const entry = (await entryOf('run_1'))!
    expect(await undo('run_1', entry.recoveredVersions![0]!.op)).toMatchObject({ kind: 'undone' })
    expect(await versionsOf('mem_p')).toEqual([])
    let left = (await entryOf('run_1'))!
    expect(left.recoveredVersions ?? []).toEqual([])
    expect(left.changes).toHaveLength(2)
    expect(left.dreamsResults).toHaveLength(1)

    const resolveOp = entry.changes!.find(c => c.group === group)!.op
    expect(await undo('run_1', resolveOp)).toMatchObject({ kind: 'undone' })
    expect(await get('mem_old')).toMatchObject({ status: 'active', content: REFINED })
    expect(mergedIntoOf(await get('mem_old'))).toBeUndefined()
    expect((await dreams.undoneMerges(GLOBAL))?.has(conclusion)).toBe(true)
    left = (await entryOf('run_1'))!
    expect(left.changes!.map(c => c.group)).toEqual([undefined])
    expect(left.dreamsResults).toHaveLength(1)

    const refineOp = left.changes![0]!.op
    expect(await undo('run_1', refineOp)).toMatchObject({ kind: 'undone' })
    expect((await get('mem_old')).content).toBe(OLD_TEXT)
    left = (await entryOf('run_1'))!
    expect(left.changes ?? []).toEqual([])
    expect(left.drillDown!.proposals.map(p => p.memoryId)).toEqual(['mem_q'])
    expect(left.dreamsResults).toHaveLength(1)
  })

  it('撤整批：细化和矛盾的改动都撤回、补回的版本删掉，条目连同报告和结果移出账本；矛盾的结论记下', async () => {
    const { neu, conclusion } = await dreamOnce()
    expect(await undo('run_1')).toMatchObject({ kind: 'undone' })
    expect(await get('mem_old')).toMatchObject({ status: 'active', content: OLD_TEXT })
    expect(mergedIntoOf(await get('mem_old'))).toBeUndefined()
    expect((await get('mem_new')).content).toBe(neu.content)
    expect(await versionsOf('mem_p')).toEqual([])
    expect(await entryOf('run_1')).toBeUndefined()
    expect((await dreams.undoneMerges(GLOBAL))?.has(conclusion)).toBe(true)
  })
})

describe('批次条目收尾（没有记忆的回执时）', () => {
  it('带下钻报告又带直接处理的矛盾：两样都留着', async () => {
    const result = {
      group: 'g1', fromKind: 'conflict' as const, change: 'state-change' as const, newer: 'mem_new', older: 'mem_old', reason: '用户改了说法', excerpts: [], at: NOW,
    }
    const report = { drills: 1, archivedSessionsRead: 0, filled: [], unreadable: [], proposals: [{ memoryId: 'mem_q', gap: 'missing-basis', kind: 'refine' as const, content: '稿', excerpts: [] }] }
    const done = await store.writeSection(async () => {
      await decisions.addDreamsRun('run_x', { summary: '记忆梦境', workspace: 'global' }, NOW)
      expect(await decisions.appendDreamsResult('run_x', result)).toBe(true)
      expect(await decisions.recordDrillReport('run_x', report)).toBe(true)
      return decisions.finishChangeRun('run_x', { writes: [] })
    })
    expect(done).toMatchObject({ dreamsResults: [result], drillDown: report })
    expect(await entryOf('run_x')).toMatchObject({ dreamsResults: [result], drillDown: report })
  })
})
