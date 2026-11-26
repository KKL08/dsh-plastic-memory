import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileTable } from '../src/storage/file-table.ts'
import { OpJournal } from '../src/storage/op-journal.ts'
import { createRootLock } from '../src/storage/root-lock.ts'
import type { DreamMarks, DreamsRecord, RecallStats } from '../src/storage/schema.ts'
import { MemoryStore } from '../src/store.ts'
import { PendingDecisionsStore, conflictFingerprint, isConflictOpen } from '../src/governance/decisions.ts'
import { SnapshotStore } from '../src/governance/snapshots.ts'
import { RESOLVED_FINDING_STEP, ledgerSteps, resolvedFindingStep } from '../src/governance/op-steps.ts'
import { VERDICTS_BY_KIND, kindOf, resolveVerdictsOf, type MemorySnapshot, type PendingDecision, type ScanCacheEntry } from '../src/governance/schema.ts'
import type { SemanticLlm } from '../src/governance/semantic-scan.ts'
import { DREAMS_DEFAULTS } from '../src/governance/dreams-gate.ts'
import { DreamsStore } from '../src/governance/dreams-records.ts'
import { resolveGroupId } from '../src/governance/dreams-merge.ts'
import {
  OLDER_BOUND_NOTE_HEAD, OLDER_BOUND_NOTE_TAIL, TIER_EXCERPT_MAX, TIER_MAX_PER_RUN, TIER_REASON_DEFAULT, TIER_REASON_MAX, TIER_SYSTEM_PROMPT,
  TIER_WINDOW_MAX_CHARS, TIER_WINDOW_MAX_MESSAGES, TIER_WINDOW_MESSAGE_MAX_CHARS, tierConclusion,
} from '../src/governance/dreams-tiers.ts'
import { DIALOGUE_CLIPPED_MARK, DIALOGUE_OMITTED_AFTER, DIALOGUE_OMITTED_BEFORE, DIALOGUE_OMITTED_BETWEEN } from '../src/governance/session-excerpt.ts'
import { mergePlan, versionPlan } from '../src/governance/changeset-plans.ts'
import { DREAMS_INITIATOR } from '../src/governance/write-gate.ts'
import { applyChangeset } from '../src/tools/changeset.ts'
import { dreamsPlan } from '../src/tools/dreams-plan.ts'
import { prereadScopes } from '../src/tools/scope-preread.ts'
import { renderScanResult, type SingleScanResult } from '../src/tools/scan.ts'
import { buildDeletedView } from '../src/gui/views.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'
import { Config } from '../src/index.ts'
import { runDreams, type DreamsRunDeps, type DreamsRunResult, type DreamsStep } from '../src/tools/dreams-run.ts'
import { resolveFindingsStep, type ResolveFindingsDeps } from '../src/tools/dreams-tiers.ts'
import { tidyMemoriesStep } from '../src/tools/dreams-tidy.ts'
import { executeConfirm, type ConfirmArgs, type ConfirmToolDeps } from '../src/tools/confirm.ts'
import { createConfirmTool } from '../src/tools/confirm-tool.ts'
import { executeUndo, restoreDeleted } from '../src/tools/undo.ts'
import { RETENTION_MS } from '../src/retention.ts'
import { mergedIntoOf, type MemoryRecord, type SourceAnchor } from '../src/record-schema.ts'
import type { RawEvent, SessionLog } from '../src/session-log.ts'
import type { Scope } from '../src/scope.ts'
import { InMemoryBatchKvTable, InMemoryKvTable } from './helpers/in-memory-kv.ts'
import { noInstructions } from './helpers/instructions.ts'
import { record } from './helpers/record.ts'
import { messageFrom } from './helpers/session-log.ts'
import { FAKE_SECRET } from './helpers/secrets.ts'
import { interleaveRuns, interleaveSeed } from './helpers/interleave.ts'

// 记忆梦境处理矛盾：读出处、交给模型核实、代码判「有把握」「重要」、按档位处理。真文件、真操作日志、真写锁；
// 宿主的会话日志、不回看名单、模型是替身。本机时区固定成新加坡（UTC+8）。

const quiet = { info() {}, warn() {}, error() {} }
const GLOBAL: Scope = { kind: 'global' }
const WS = '/proj/a'
const NOW = 1_800_000_000_000
/** 两条记忆出处里说话的时刻：2025-03-01 10:00、2025-06-01 10:00（本机）。 */
const OLD_AT = Date.UTC(2025, 2, 1, 2)
const NEW_AT = Date.UTC(2025, 5, 1, 2)

const ZONE = 'Asia/Singapore'
const savedTz = process.env.TZ
beforeAll(() => { process.env.TZ = ZONE })
afterAll(() => { if (savedTz === undefined) delete process.env.TZ; else process.env.TZ = savedTz })

let root: string
let project: string
/** 账本、梦境记录的底层表（侧表的替身）：用例里要让它们读不全、写失败、手改一条。 */
let ledger: InMemoryKvTable<PendingDecision>
let dreamsRecords: InMemoryKvTable<DreamsRecord>
/** 这一刻（运行和步骤都按它）；锁到期的用例往后拨。 */
let clock: number
/** 这次运行取了几次模型（ctx.llm 到要调模型时才取）。 */
let llmResolves: number
let lock: ReturnType<typeof createRootLock>
let journal: OpJournal
let store: MemoryStore
let decisions: PendingDecisionsStore
let snapshots: SnapshotStore
let dreams: DreamsStore
let ratio: number
let runSeq: number
let tier: unknown
let focus: string[]
let sessions: Map<string, SessionLog>
let marked: Set<string>
let isNoReviewBroken: boolean
let warnings: unknown[]
let prompts: Array<{ system: string; user: string }>
let tidyPrompts: string[]
/** 模型的回复：按收到的用户消息给（对象按 JSON 发）。 */
let reply: (user: string) => unknown | Promise<unknown>

const llm: SemanticLlm = {
  model: 'stub',
  complete: async (prompt, _signal, onUsage) => {
    if (prompt.system !== TIER_SYSTEM_PROMPT) {
      tidyPrompts.push(prompt.user)
      return JSON.stringify({ operations: [] })
    }
    prompts.push(prompt)
    onUsage?.(10)
    const value = await reply(prompt.user)
    return typeof value === 'string' ? value : JSON.stringify(value)
  },
}

async function setup() {
  root = await mkdtemp(join(tmpdir(), 'pm-dreams-tiers-'))
  project = await mkdtemp(join(tmpdir(), 'pm-dreams-tiers-proj-'))
  await writeFile(join(project, 'package.json'), '{"packageManager":"pnpm@9"}')
  journal = new OpJournal({ path: join(root, '.state', 'op-journal.sqlite'), log: quiet })
  lock = createRootLock({ root, log: quiet })
  const stats = new InMemoryBatchKvTable<RecallStats>()
  ledger = new InMemoryKvTable<PendingDecision>()
  decisions = new PendingDecisionsStore(ledger, lock)
  snapshots = new SnapshotStore(new InMemoryKvTable<MemorySnapshot>())
  dreamsRecords = new InMemoryKvTable<DreamsRecord>()
  dreams = new DreamsStore(dreamsRecords, new InMemoryKvTable<DreamMarks>())
  store = new MemoryStore(new FileTable({ root, stats, log: quiet, lock, journal, now: () => NOW }), quiet, stats)
  store.registerSteps(ledgerSteps(decisions, quiet))
  ratio = 1
  runSeq = 0
  tier = 'gatekeep'
  focus = ['preference', 'profile', 'decision']
  sessions = new Map()
  marked = new Set()
  isNoReviewBroken = false
  warnings = []
  prompts = []
  tidyPrompts = []
  reply = () => ({})
  clock = NOW
  llmResolves = 0
}
async function teardown() {
  journal.close()
  await rm(root, { recursive: true, force: true })
  await rm(project, { recursive: true, force: true })
}
beforeEach(setup)
afterEach(teardown)

// ---- 会话日志（宿主替身） ----

const assistantSays = (seq: number, text: string, time: number): RawEvent => ({ type: 'assistant/message', seq, time, data: { message: { id: `a${seq}`, role: 'assistant', content: [{ type: 'text', text }] } } })
const toolCall = (seq: number, name: string, args: unknown, time: number): RawEvent => ({ type: 'tool/call', seq, time, data: { callId: `c${seq}`, name, arguments: JSON.stringify(args) } })
const toolResult = (seq: number, callSeq: number, text: string, time: number): RawEvent => ({ type: 'tool/result', seq, time, data: { message: { toolCallId: `c${callSeq}`, isError: false, content: [{ type: 'text', text }] } } })

/** 一个会话：seq 0 开一轮，seq 1 是用户本人说的 text（时刻 at），后面接 more（seq 从 2 起）。 */
function addSession(id: string, text: string, at: number, more: (at: number) => RawEvent[] = () => []) {
  sessions.set(id, { header: { isSeeded: false, cwd: project }, inheritedEventCount: 0, events: [{ type: 'turn/start', seq: 0, time: at }, messageFrom('user', 1, text, at), ...more(at)] })
}
/** 助手的一段长话（长度 n 字，带序号好认）。 */
const longAssistant = (seq: number, at: number, n = 400) => assistantSays(seq, `第${seq}段${'长'.repeat(n)}`, at)

// ---- 记忆 ----

interface MemorySpec {
  text: string
  at: number
  content?: string
  type?: string
  mode?: string
  factTime?: string
  more?: (at: number) => RawEvent[]
  extra?: Partial<MemoryRecord>
  workspacePath?: string
  /** 整个会话的事件（给了就不用 addSession 的写法）和锚的区间。 */
  events?: RawEvent[]
  range?: [number, number]
  /** 旧版本写的记忆：只有 source（at 取 updatedAt），没有出处清单。 */
  isLegacy?: boolean
}
/** 建一条记忆，它的出处是会话 s_<id> 里 seq 1 那句用户的话；锚的时刻就是那句话的时刻。 */
async function memory(id: string, spec: MemorySpec): Promise<MemoryRecord> {
  if (spec.events !== undefined) sessions.set(`s_${id}`, { header: { isSeeded: false, cwd: project }, inheritedEventCount: 0, events: spec.events })
  else addSession(`s_${id}`, spec.text, spec.at, spec.more)
  const range = spec.range ?? [1, 1]
  const mode = spec.mode ?? 'user-explicit'
  // 新版本写下的锚都带 change（同 stampAnchor）；isLegacy 的只有 source，合成的锚没有 change
  const trail: SourceAnchor[] = [{ sessionId: `s_${id}`, eventRange: range, sourceMode: mode, at: spec.at, change: 'create', by: 'main' }]
  const { source: _source, sourceTrail: _trail, ...plain } = record({
    id, name: `${id} 的名称`, type: spec.type ?? 'knowledge', content: spec.content ?? spec.text, summary: `${id} 的摘要`,
    createdAt: NOW, updatedAt: NOW, lastConfirmedAt: NOW,
    ...(spec.factTime !== undefined ? { factTime: spec.factTime } : {}),
    ...(spec.workspacePath !== undefined ? { scope: 'workspace' as const, workspacePath: spec.workspacePath } : {}),
  })
  const base = spec.isLegacy === true
    ? { ...plain, source: { sessionId: `s_${id}`, eventRange: range, sourceMode: mode as 'user-explicit' }, ...spec.extra }
    : { ...plain, sourceTrail: trail, ...spec.extra }
  await store.create(base)
  const scope: Scope = spec.workspacePath === undefined ? GLOBAL : { kind: 'workspace', workspacePath: spec.workspacePath }
  await store.maintain(scope)
  return (await store.get(id, scope))!
}
const get = async (id: string, scope: Scope = GLOBAL) => (await store.get(id, scope))!

/** 标准的一对：旧的说用 npm（不重要：knowledge、模型推断），新的说改用 pnpm。 */
async function npmPair(opts: { old?: Partial<MemorySpec>; neu?: Partial<MemorySpec>; prefix?: string } = {}) {
  const p = opts.prefix ?? 'mem'
  const old = await memory(`${p}_old`, { text: '项目用 npm 管依赖', at: OLD_AT, factTime: '2025-03-01', mode: 'agent-inferred', ...opts.old })
  const neu = await memory(`${p}_new`, { text: '从今天起改用 pnpm', at: NEW_AT, factTime: '2025-06-01', ...opts.neu })
  return [old, neu] as const
}

/**
 * 体检挂的配对发现。isLegacy：0.2.0 留下的那种没有冲突指纹的条目。members：同时记下各成员的扫描指纹（体检现在的写法）。
 */
async function report(
  records: readonly MemoryRecord[],
  opts: { kind?: 'missed-change' | 'exception'; labels?: string[]; at?: number; baselineRef?: string; isLegacy?: boolean; members?: Record<string, string> } = {},
): Promise<PendingDecision> {
  const { entry } = await decisions.upsert({
    ...(opts.kind !== undefined ? { kind: opts.kind } : {}), memoryIds: records.map(r => r.id), summary: '包管理器的说法对不上',
    workspaces: opts.labels ?? records.map(r => r.workspacePath ?? 'global'),
    ...(opts.isLegacy === true ? {} : { fingerprint: conflictFingerprint(records) }),
    ...(opts.members !== undefined ? { memberScanFingerprints: opts.members } : {}),
    ...(opts.baselineRef !== undefined ? { baselineRef: opts.baselineRef } : {}),
  }, opts.at ?? NOW)
  return entry
}

// ---- 模型回复 ----

/** 用户消息里含 text 的那条原文的编号。 */
function num(user: string, text: string): number {
  const m = new RegExp(`\\[#(\\d+)\\][^\\n]*${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).exec(user)
  if (m === null) throw new Error(`提示词里没有「${text}」`)
  return Number(m[1])
}
/** 有把握的状态变化：引用新的一方出处里那句用户的话。 */
const confident = (extra: Record<string, unknown> = {}, ids: [string, string] = ['mem_old', 'mem_new'], cite = '改用 pnpm') => (user: string) => ({
  ids, subject: '这个项目的包管理器', dimension: '用哪个', compatible: false, newer: ids[1], change: 'state-change', uncertain: false,
  evidence: [num(user, cite)], reason: '用户说从今天起改用 pnpm', ...extra,
})

// ---- 运行 ----

function deps(plan: DreamsStep[]): DreamsRunDeps {
  const claims = new InMemoryKvTable<{ id: string }>()
  return {
    store, snapshots, decisions, dreams,
    log: { info() {}, warn: (_message, detail) => { warnings.push(detail) }, error() {} },
    claimScope: async (scope) => {
      const release = await claims.claim(scope.kind === 'global' ? 'global' : scope.workspacePath)
      return release === undefined ? { busy: scope } : { release }
    },
    activity: async () => ({ isComplete: true, workspaces: new Map() }),
    resolveLlm: async () => {
      llmResolves++
      return { llm, isSelected: true, fellBack: false }
    },
    config: () => ({ ...DREAMS_DEFAULTS, minChanges: 0, maxChangeRatio: ratio }),
    isGovernanceEnabled: () => true,
    plan,
    interval: () => () => {},
    now: () => clock,
    newRunId: () => `run_${++runSeq}`,
  }
}
const tierDeps = (): ResolveFindingsDeps => ({
  store, decisions, dreams,
  readSessionLog: async id => sessions.get(id) ?? null,
  noReview: { isMarkedNoReview: async (id) => { if (isNoReviewBroken) throw new Error('名单读不出'); return marked.has(id) } },
  memoryRoot: root,
  tier: () => tier,
  focusTypes: () => focus,
  now: () => clock,
})
const tidyStep = () => tidyMemoriesStep({ store, maxTopics: () => 30, now: () => NOW, typeRecall: () => 'search' })
/** 跑一次只有这一步（前后可再接别的步）的运行，返回原样结果。 */
const runRaw = (scope: Scope = GLOBAL, after: DreamsStep[] = [], before: DreamsStep[] = [], signal?: AbortSignal) =>
  runDreams(scope, { by: 'manual', ...(signal !== undefined ? { signal } : {}) }, deps([...before, resolveFindingsStep(tierDeps()), ...after]))
/** 跑一次、要求做完：没做完时把运行记下的出错原因抛出来。 */
async function run(scope: Scope = GLOBAL, after: DreamsStep[] = []): Promise<DreamsRunResult> {
  const r = await runRaw(scope, after)
  if (r.kind !== 'completed') throw warnings.find(w => w instanceof Error) ?? new Error(`运行没做完：${r.kind}`)
  return r
}
const settledEntry = async (id: string) => (await decisions.listSettled()).find(d => d.id === id)
const openEntry = (id: string) => decisions.get(id)
const lastResult = async (scope = 'global') => (await dreams.read()).records.get(scope)?.lastResult
const skippedItems = async (scope = 'global') => (await lastResult(scope))?.skipped?.items ?? []
const undoDeps = (now = NOW) => ({ store, decisions, snapshots, dreams, log: quiet, ignores: { unignoreIfSame: async () => false }, now: () => now })
const undo = (decisionId: string, now = NOW) => executeUndo({ decisionId }, { workspacePath: undefined }, undoDeps(now))
const confirmDeps = (): ConfirmToolDeps => ({ store, decisions, snapshots, now: () => NOW, log: quiet, instructions: noInstructions })
type Verdict = Extract<ConfirmArgs, { action: 'resolve' }>['verdict']
const confirm = (decisionId: string, verdict: Verdict, current?: string, workspacePath?: string) => executeConfirm(
  { action: 'resolve', decisionId, verdict, ...(current !== undefined ? { current } : {}) }, { workspacePath }, confirmDeps(),
)
/** 这一对的未决条目（含已改成「重要、等你定」的）。 */
const openOf = async (a: string, b: string) => (await decisions.list()).filter(e => e.memoryIds.includes(a) && e.memoryIds.includes(b))

describe('有把握、不重要：两档都直接处理，账本里只列结果', () => {
  it.each(['gatekeep', 'trust'])('%s档：状态变化把旧的并成新的历史版本，发现移出账本，结果记在批次条目上', async (t) => {
    tier = t
    const [old, neu] = await npmPair()
    const entry = await report([old, neu])
    reply = confident()
    await run()
    expect(prompts).toHaveLength(1)
    expect((await get('mem_old')).status).toBe('deleted')
    expect(mergedIntoOf(await get('mem_old'))).toEqual({ id: 'mem_new', scopeKey: 'global', as: 'version', endedAt: expect.any(Number) })
    expect((await get('mem_new')).status).toBe('active')
    expect(await openEntry(entry.id)).toBeUndefined()
    const batch = (await settledEntry('run_1'))!
    const group = resolveGroupId('run_1', tierConclusion([old, neu]))
    expect(batch.changes?.map(c => [c.kind, c.memoryId, c.group])).toEqual([['forget', 'mem_old', group]])
    expect(batch.dreamsResults).toEqual([{
      group, fromKind: 'conflict', change: 'state-change', newer: 'mem_new', older: 'mem_old', at: NOW,
      reason: '用户说从今天起改用 pnpm', excerpts: [{ sessionId: 's_mem_new', seq: 1, speaker: 'user', text: '从今天起改用 pnpm' }],
    }])
  })

  it('漏记的变化也按同样的规则处理，结果记着原是哪种发现', async () => {
    const [old, neu] = await npmPair()
    const entry = await report([old, neu], { kind: 'missed-change' })
    reply = confident()
    await run()
    expect((await get('mem_old')).status).toBe('deleted')
    expect(await openEntry(entry.id)).toBeUndefined()
    expect((await settledEntry('run_1'))!.dreamsResults?.[0]).toMatchObject({ fromKind: 'missed-change', change: 'state-change' })
  })

  it('纠错：改写旧的一方，旧内容只在撤销快照里；这次运行后面的逐条整理不再动它', async () => {
    const [old, neu] = await npmPair()
    await report([old, neu])
    reply = confident({ change: 'correct', draft: { content: '项目一直用 pnpm 管依赖', summary: '用 pnpm' } })
    await run(GLOBAL, [tidyStep()])
    const corrected = await get('mem_old')
    expect(corrected).toMatchObject({ status: 'active', content: '项目一直用 pnpm 管依赖', summary: '用 pnpm', lastChange: { kind: 'correct', by: 'dreams' } })
    expect((await get('mem_new')).content).toBe(neu.content)
    const receipt = (await settledEntry('run_1'))!.changes!.find(c => c.memoryId === 'mem_old')!
    expect((await snapshots.get(receipt.snapshotId!))?.data.map(r => r.content)).toEqual(['项目用 npm 管依赖'])
    expect((await settledEntry('run_1'))!.dreamsResults?.[0]).toMatchObject({ change: 'correct', older: 'mem_old', newer: 'mem_new' })
    expect(tidyPrompts.some(p => p.includes('"mem_new"'))).toBe(true)
    expect(tidyPrompts.some(p => p.includes('"mem_old"'))).toBe(false)
  })

  it('旧的没填事实时间、出处时间早于新的：直接处理，报告写出处上限的说明，事实时间不写回', async () => {
    const [old, neu] = await npmPair({ old: { factTime: undefined } })
    expect(old.factTime).toBeUndefined()
    await report([old, neu])
    reply = confident()
    await run()
    expect((await get('mem_old')).status).toBe('deleted')
    expect((await get('mem_old')).factTime).toBeUndefined()
    expect((await get('mem_new')).factTime).toBe('2025-06-01')
    const note = (await settledEntry('run_1'))!.dreamsResults![0]!.olderBoundNote!
    expect(note.startsWith(OLDER_BOUND_NOTE_HEAD)).toBe(true)
    expect(note.endsWith(OLDER_BOUND_NOTE_TAIL)).toBe(true)
    expect(note).toContain('2025-03-01')
  })

  it('交给模型的会话原文不遮盖；存下的理由和依据节选遮盖', async () => {
    const [old, neu] = await npmPair({ neu: { text: `从今天起改用 pnpm，token=${FAKE_SECRET.sk}`, content: '从今天起改用 pnpm' } })
    await report([old, neu])
    reply = confident({ reason: `用户说改用 pnpm，还贴了 ${FAKE_SECRET.sk}` })
    await run()
    expect(prompts[0]!.user).toContain(FAKE_SECRET.sk)
    const result = (await settledEntry('run_1'))!.dreamsResults![0]!
    expect(result.excerpts[0]!.text).toContain('从今天起改用 pnpm')
    expect(JSON.stringify(result)).not.toContain(FAKE_SECRET.sk)
  })

  it('存下的理由和依据节选：疑似级的密钥也遮盖，折成一行，截到上限', async () => {
    const tail = '很'.repeat(TIER_EXCERPT_MAX + 50)
    const [old, neu] = await npmPair({ neu: { text: `从今天起改用 pnpm\n数据库 password=Abc12345xyz\n${tail}`, content: '从今天起改用 pnpm' } })
    await report([old, neu])
    reply = confident({ reason: `用户说改用 pnpm\n还贴了 password=Zzz98765qwe ${'长'.repeat(TIER_REASON_MAX + 50)}` })
    await run()
    expect(prompts[0]!.user).toContain('password=Abc12345xyz')
    const result = (await settledEntry('run_1'))!.dreamsResults![0]!
    expect(result.reason.startsWith('用户说改用 pnpm')).toBe(true)
    expect(result.reason.length).toBeLessThanOrEqual(TIER_REASON_MAX)
    expect(result.excerpts).toHaveLength(1)
    expect(result.excerpts[0]!.text.startsWith('从今天起改用 pnpm')).toBe(true)
    expect(result.excerpts[0]!.text.length).toBeLessThanOrEqual(TIER_EXCERPT_MAX)
    for (const text of [result.reason, result.excerpts[0]!.text]) {
      expect(text).not.toMatch(/[\r\n]/)
      expect(text).not.toContain('Abc12345xyz')
      expect(text).not.toContain('Zzz98765qwe')
    }
  })

  it.each([['没给', undefined], ['只有空白', '  \n ']])('模型的理由%s：存固定的缺省理由', async (_name, reason) => {
    const [old, neu] = await npmPair()
    await report([old, neu])
    reply = confident({ reason })
    await run()
    expect((await settledEntry('run_1'))!.dreamsResults![0]!.reason).toBe(TIER_REASON_DEFAULT)
  })
})

describe('有把握、重要', () => {
  const important = { old: { type: 'decision', mode: 'user-explicit' } }

  it('把关档：不动，条目就地改成「重要、等你定」，带方案、改动性质和依据', async () => {
    const [old, neu] = await npmPair(important)
    const entry = await report([old, neu])
    reply = confident()
    await run()
    expect(prompts).toHaveLength(1)
    expect((await get('mem_old')).status).toBe('active')
    const held = (await openEntry(entry.id))!
    expect(kindOf(held)).toBe('important-pending')
    expect(held.memoryIds).toEqual(entry.memoryIds)
    expect(held.change).toBe('state-change')
    expect(held.evidence).toEqual([{ sessionId: 's_mem_new', seq: 1 }])
    expect(held.dreamsHold).toMatchObject({ runId: 'run_1', cause: 'important', fromKind: 'conflict', conclusion: tierConclusion([old, neu]) })
    expect(held.dreamsHold!.proposal).toMatchObject({ newer: 'mem_new', reason: '用户说从今天起改用 pnpm' })
    expect(held.dreamsHold!.proposal!.ops).toMatchObject([{ kind: 'forget', memoryId: 'mem_old', into: { memoryId: 'mem_new', as: 'version' } }])
    // 账本里这一对只有这一条
    expect((await decisions.list()).filter(e => e.memoryIds.includes('mem_old'))).toHaveLength(1)
  })

  it('信任档：直接处理，结果单列在最前、标「重要」', async () => {
    tier = 'trust'
    const [a, b] = await npmPair({ prefix: 'plain' })
    await report([a, b], { at: NOW - 10 })
    const [c, d] = await npmPair({ prefix: 'key', ...important })
    await report([c, d])
    reply = (user) => (user.includes('key_old') ? confident({}, ['key_old', 'key_new'])(user) : confident({}, ['plain_old', 'plain_new'])(user))
    await run()
    expect(prompts).toHaveLength(2)
    expect((await get('plain_old')).status).toBe('deleted')
    expect((await get('key_old')).status).toBe('deleted')
    const results = (await settledEntry('run_1'))!.dreamsResults!
    expect(results.map(r => [r.older, r.isImportant ?? false])).toEqual([['key_old', true], ['plain_old', false]])
  })

  it('档位配置是不认识的值：按把关档', async () => {
    tier = '以后才有的档位'
    const [old, neu] = await npmPair(important)
    const entry = await report([old, neu])
    reply = confident()
    await run()
    expect(prompts).toHaveLength(1)
    expect(kindOf((await openEntry(entry.id))!)).toBe('important-pending')
    expect((await get('mem_old')).status).toBe('active')
  })

  it('重点类型设成空：同一对按不重要直接处理', async () => {
    focus = []
    const [old, neu] = await npmPair(important)
    await report([old, neu])
    reply = confident()
    await run()
    expect((await get('mem_old')).status).toBe('deleted')
  })

  it('信任档直接做的纠错过了保留天数就撤不回', async () => {
    tier = 'trust'
    const [old, neu] = await npmPair(important)
    await report([old, neu])
    reply = confident({ change: 'correct', draft: { content: '项目一直用 pnpm 管依赖' } })
    await run()
    expect((await get('mem_old')).content).toBe('项目一直用 pnpm 管依赖')
    expect((await settledEntry('run_1'))!.changes?.some(c => c.memoryId === 'mem_old')).toBe(true)
    const r = await undo('run_1', NOW + RETENTION_MS + 60_000)
    expect(r).toMatchObject({ kind: 'error', code: 'not-found', reason: 'expired' })
    expect((await get('mem_old')).content).toBe('项目一直用 pnpm 管依赖')
  })
})

describe('没把握：两档都交给用户，条目照旧，记下这次核实过', () => {
  /** 跑一次信任档（最宽的一档）：条目种类不变、记下这次核实的原因，旧的一方没被改。 */
  async function handedOver(outcome: string) {
    tier = 'trust'
    const entry = (await decisions.list()).find(e => e.memoryIds.includes('mem_old'))!
    await run()
    expect(prompts).toHaveLength(1)
    const after = (await openEntry(entry.id))!
    expect(kindOf(after)).toBe(kindOf(entry))
    expect(after.dreamsReview).toMatchObject({ runId: 'run_1', at: NOW, outcome })
    expect(await get('mem_old')).toMatchObject({ status: 'active', content: '项目用 npm 管依赖' })
  }

  it('依据只有读记忆文件的结果：不算有把握', async () => {
    await mkdir(join(root, '.state'), { recursive: true })
    await writeFile(join(root, '.state', 'notes-copy.txt'), '项目改用 pnpm')
    const [old, neu] = await npmPair({ neu: { more: at => [toolCall(2, 'read', { path: join(root, '.state', 'notes-copy.txt') }, at), toolResult(3, 2, '项目改用 pnpm（记忆文件）', at)] } })
    await report([old, neu])
    reply = confident({}, undefined, '记忆文件')
    await handedOver('evidence-not-qualified')
  })

  it('依据只有本插件工具的结果：不算有把握', async () => {
    const [old, neu] = await npmPair({ neu: { more: at => [toolCall(2, 'memory_search', { query: '包管理器' }, at), toolResult(3, 2, '找到一条：项目改用 pnpm', at)] } })
    await report([old, neu])
    reply = confident({}, undefined, '找到一条')
    await handedOver('evidence-not-qualified')
  })

  it('记忆之外的工具结果算依据：同样的写法直接处理', async () => {
    const [old, neu] = await npmPair({ neu: { more: at => [toolCall(2, 'read', { path: join(project, 'package.json') }, at), toolResult(3, 2, 'packageManager 是 pnpm@9', at)] } })
    await report([old, neu])
    reply = confident({}, undefined, 'packageManager')
    await run()
    expect((await get('mem_old')).status).toBe('deleted')
    expect((await settledEntry('run_1'))!.dreamsResults![0]!.excerpts).toEqual([{ sessionId: 's_mem_new', seq: 3, speaker: 'tool', text: 'packageManager 是 pnpm@9' }])
  })

  it('引用了不存在的编号：拒收', async () => {
    const [old, neu] = await npmPair()
    await report([old, neu])
    reply = confident({ evidence: [999] })
    await handedOver('evidence-unknown-ref')
  })

  it('助手的话只作上下文、不编号：模型引用不到它，报个表外的编号拒收', async () => {
    const [old, neu] = await npmPair({ neu: { more: at => [assistantSays(2, '好的，我们换成 pnpm', at)] } })
    await report([old, neu])
    reply = (user) => {
      // 助手那句话在原文里，但前面没有编号；编过号的只有两边用户的话
      expect(user).toContain('好的，我们换成 pnpm')
      expect(/\[#\d+\][^\n]*我们换成 pnpm/.test(user)).toBe(false)
      const numbered = [...user.matchAll(/\[#(\d+)\]/g)].map(m => Number(m[1]))
      return confident({ evidence: [Math.max(...numbered) + 1] })(user)
    }
    await handedOver('evidence-unknown-ref')
  })

  it('模型提议删除：改动性质不在四种里，交给用户', async () => {
    const [old, neu] = await npmPair()
    await report([old, neu])
    reply = confident({ change: 'delete' })
    await handedOver('change-unclear')
  })

  it('模型标了不确定：交给用户', async () => {
    const [old, neu] = await npmPair()
    await report([old, neu])
    reply = confident({ uncertain: true })
    await handedOver('change-unclear')
  })

  it('双方都是用户明说、分不清先后：不处理，交给用户', async () => {
    const [old, neu] = await npmPair({ old: { mode: 'user-explicit' }, neu: { factTime: undefined } })
    await report([old, neu])
    reply = confident()
    await handedOver('both-user-unclear')
  })

  it('先后分不清（新的没填事实时间）：交给用户', async () => {
    const [old, neu] = await npmPair({ neu: { factTime: undefined } })
    await report([old, neu])
    reply = confident()
    await handedOver('order-unclear')
  })

  it('纠错没给能用的稿：交给用户', async () => {
    const [old, neu] = await npmPair()
    await report([old, neu])
    reply = confident({ change: 'correct' })
    await handedOver('draft-unusable')
  })

  it('纠错稿里带着疑似密钥：交给用户，不落盘', async () => {
    const [old, neu] = await npmPair()
    await report([old, neu])
    reply = confident({ change: 'correct', draft: { content: `项目用 pnpm，token=${FAKE_SECRET.sk}` } })
    await handedOver('has-secret')
  })

  it('纠错稿的名称里带着密钥、正文干净：按改完的整条查，交给用户', async () => {
    const [old, neu] = await npmPair()
    await report([old, neu])
    reply = confident({ change: 'correct', draft: { content: '项目一直用 pnpm 管依赖', name: `pnpm ${FAKE_SECRET.github}` } })
    await handedOver('has-secret')
  })

  it('一方含疑似密钥：不交给模型，交给用户', async () => {
    const [old, neu] = await npmPair({ neu: { content: `从今天起改用 pnpm，token=${FAKE_SECRET.sk}` } })
    const entry = await report([old, neu])
    await run()
    expect(prompts).toHaveLength(0)
    expect((await openEntry(entry.id))!.dreamsReview).toMatchObject({ runId: 'run_1', at: NOW, outcome: 'has-secret' })
  })

  it('核实过、两边没变：下次运行不再交给模型；改了一边就重新核实', async () => {
    const [old, neu] = await npmPair({ neu: { factTime: undefined } })
    const entry = await report([old, neu])
    reply = confident()
    await run()
    expect(prompts).toHaveLength(1)
    expect((await openEntry(entry.id))!.dreamsReview).toMatchObject({ runId: 'run_1', outcome: 'order-unclear' })
    await run()
    expect(prompts).toHaveLength(1)
    await store.updateIfLive({ id: 'mem_new' }, cur => ({ ...cur, factTime: '2025-06-01' }))
    await run()
    expect(prompts).toHaveLength(2)
    expect((await get('mem_old')).status).toBe('deleted')
  })
})

describe('出处读不到：不算有把握，交给用户，不调模型、不记核实', () => {
  it.each([
    ['会话读不出', () => { sessions.delete('s_mem_new') }],
    ['用户标了不回看', () => { marked.add('s_mem_old') }],
    ['不回看名单读不出', () => { isNoReviewBroken = true }],
    ['锚失效（序号和时间都对不上）', () => {
      const s = sessions.get('s_mem_new')!
      sessions.set('s_mem_new', { ...s, events: s.events.map(e => ({ ...e, seq: (e.seq ?? 0) + 50, time: NEW_AT + 3_600_000 })) })
    }],
  ])('%s', async (_name, breakIt) => {
    const [old, neu] = await npmPair()
    const entry = await report([old, neu])
    reply = confident()
    breakIt()
    await run()
    expect(await skippedItems()).toContainEqual({ step: 'resolve-findings', kind: 'resolve', target: entry.id, reason: 'source-unreadable' })
    expect(prompts).toHaveLength(0)
    const after = (await openEntry(entry.id))!
    expect(kindOf(after)).toBe('conflict')
    expect(after.dreamsReview).toBeUndefined()
    expect((await get('mem_old')).status).toBe('active')
  })

  it('一方没有出处（手建）：同样按读不到', async () => {
    const [, neu] = await npmPair()
    await store.updateIfLive({ id: 'mem_old' }, cur => ({ ...cur, sourceTrail: [] }))
    expect((await get('mem_old')).sourceTrail ?? []).toEqual([])
    const entry = await report([await get('mem_old'), neu])
    reply = confident()
    await run()
    expect(await skippedItems()).toContainEqual({ step: 'resolve-findings', kind: 'resolve', target: entry.id, reason: 'source-unreadable' })
    expect(prompts).toHaveLength(0)
  })
})

describe('出处的窗口', () => {
  it('会话序号漂移、时间还对得上：按时间找回那一轮，照常处理，依据记的是现在的序号', async () => {
    const [old, neu] = await npmPair()
    await report([old, neu])
    const s = sessions.get('s_mem_new')!
    sessions.set('s_mem_new', { ...s, events: s.events.map(e => ({ ...e, seq: (e.seq ?? 0) + 50 })) })
    reply = confident()
    await run()
    expect(prompts).toHaveLength(1)
    expect((await get('mem_old')).status).toBe('deleted')
    expect((await settledEntry('run_1'))!.dreamsResults![0]!.excerpts).toEqual([{ sessionId: 's_mem_new', seq: 51, speaker: 'user', text: '从今天起改用 pnpm' }])
  })

  it('一轮很长：保留锚指的那句，往两边截到上限，截掉的头尾标出来', async () => {
    const events: RawEvent[] = [{ type: 'turn/start', seq: 0, time: NEW_AT }]
    for (let i = 1; i <= 60; i++) events.push(longAssistant(i, NEW_AT))
    events.push(messageFrom('user', 61, '从今天起改用 pnpm', NEW_AT))
    for (let i = 62; i <= 121; i++) events.push(longAssistant(i, NEW_AT))
    events.push({ type: 'turn/start', seq: 122, time: NEW_AT + 60_000 }, messageFrom('user', 123, '下一轮的话', NEW_AT + 60_000))
    const old = await memory('mem_old', { text: '项目用 npm 管依赖', at: OLD_AT, factTime: '2025-03-01', mode: 'agent-inferred' })
    const neu = await memory('mem_new', { text: '从今天起改用 pnpm', at: NEW_AT, factTime: '2025-06-01', events, range: [61, 61] })
    await report([old, neu])
    reply = confident()
    await run()
    expect(prompts).toHaveLength(1)
    const user = prompts[0]!.user
    expect(user).toContain(DIALOGUE_OMITTED_BEFORE)
    expect(user).toContain(DIALOGUE_OMITTED_AFTER)
    expect(user).toContain('第60段')
    expect(user).toContain('第62段')
    expect(user).not.toContain('第1段长')
    expect(user).not.toContain('第121段')
    expect(user).not.toContain('下一轮的话')
    const shown = [...user.matchAll(/第\d+段长+/g)].map(m => m[0])
    expect(shown.length).toBeLessThanOrEqual(TIER_WINDOW_MAX_MESSAGES)
    expect(shown.reduce((n, t) => n + t.length, 0)).toBeLessThanOrEqual(TIER_WINDOW_MAX_CHARS)
    expect((await get('mem_old')).status).toBe('deleted')
  })

  it('保存的区间是一整轮（120 多条）：上限照样生效，用户那句话截短后留着，其余按离保存点从近到远放，截掉的每段标出来', async () => {
    const said = `从今天起改用 pnpm。${'细节'.repeat(3000)}`
    const events: RawEvent[] = [{ type: 'turn/start', seq: 0, time: NEW_AT }, messageFrom('user', 1, said, NEW_AT)]
    for (let i = 2; i <= 121; i++) events.push(longAssistant(i, NEW_AT))
    const old = await memory('mem_old', { text: '项目用 npm 管依赖', at: OLD_AT, factTime: '2025-03-01', mode: 'agent-inferred' })
    const neu = await memory('mem_new', { text: said, content: '从今天起改用 pnpm', at: NEW_AT, factTime: '2025-06-01', events, range: [0, 121] })
    await report([old, neu])
    reply = confident()
    await run()
    expect(prompts).toHaveLength(1)
    const user = prompts[0]!.user
    expect(user).toContain('从今天起改用 pnpm')
    expect(user).toContain(DIALOGUE_CLIPPED_MARK)
    expect(user).not.toContain('细节'.repeat(TIER_WINDOW_MESSAGE_MAX_CHARS / 2))
    expect(user).toContain('第121段')
    expect(user).not.toContain('第2段长')
    expect(user).toContain(DIALOGUE_OMITTED_BETWEEN)
    const shown = [...user.matchAll(/第\d+段长+/g)].map(m => m[0])
    expect(shown.length + 1).toBeLessThanOrEqual(TIER_WINDOW_MAX_MESSAGES)
    expect(shown.reduce((n, t) => n + t.length, 0) + TIER_WINDOW_MESSAGE_MAX_CHARS).toBeLessThanOrEqual(TIER_WINDOW_MAX_CHARS)
    expect((await get('mem_old')).status).toBe('deleted')
  })

  it('没取到轮起点、区间退成整份会话（[0, 最后一个序号]）：同样截到上限，区间里用户的话先留，再留离保存点最近的', async () => {
    const events: RawEvent[] = []
    for (let t = 0; t < 25; t++) {
      const base = t * 20
      const at = NEW_AT + t * 60_000
      events.push({ type: 'turn/start', seq: base, time: at }, messageFrom('user', base + 1, t === 24 ? '从今天起改用 pnpm' : `第${t}轮用户的话`, at))
      for (let i = base + 2; i < base + 20; i++) events.push(longAssistant(i, at))
    }
    const old = await memory('mem_old', { text: '项目用 npm 管依赖', at: OLD_AT, factTime: '2025-03-01', mode: 'agent-inferred' })
    const neu = await memory('mem_new', { text: '从今天起改用 pnpm', at: NEW_AT, factTime: '2025-06-01', events, range: [0, 499] })
    await report([old, neu])
    reply = confident()
    await run()
    expect(prompts).toHaveLength(1)
    const user = prompts[0]!.user
    expect(user).toContain('从今天起改用 pnpm')
    expect(user).toContain('第0轮用户的话')
    expect(user).toContain('第499段')
    expect(user).not.toContain('第2段长')
    expect(user).toContain(DIALOGUE_OMITTED_BETWEEN)
    const shown = [...user.matchAll(/第\d+段长+/g)].map(m => m[0])
    expect(shown.length + 25).toBeLessThanOrEqual(TIER_WINDOW_MAX_MESSAGES)
    expect(shown.reduce((n, t) => n + t.length, 0)).toBeLessThanOrEqual(TIER_WINDOW_MAX_CHARS)
    expect((await get('mem_old')).status).toBe('deleted')
  })

  it('一轮不长：整轮给出，不加截断标记，下一轮的话不给', async () => {
    const [old, neu] = await npmPair({ neu: { more: at => [assistantSays(2, '好的，换成 pnpm', at), { type: 'turn/start', seq: 3, time: at + 60_000 }, messageFrom('user', 4, '下一轮的话', at + 60_000)] } })
    await report([old, neu])
    reply = confident()
    await run()
    expect(prompts[0]!.user).toContain('好的，换成 pnpm')
    expect(prompts[0]!.user).not.toContain('下一轮的话')
    expect(prompts[0]!.user).not.toContain(DIALOGUE_OMITTED_BEFORE)
    expect(prompts[0]!.user).not.toContain(DIALOGUE_OMITTED_AFTER)
  })

  it('旧版本写的记忆（只有 source）：不按时间核对、不重定位，它的时间也不当出处上限，判先后不清', async () => {
    // 合成锚的时间取修改时间：早于新的一方的事实时间，当成上限的话会误判成先后清楚
    const old = await memory('mem_old', { text: '项目用 npm 管依赖', at: OLD_AT, mode: 'agent-inferred', isLegacy: true, extra: { updatedAt: Date.UTC(2025, 0, 1) } })
    const neu = await memory('mem_new', { text: '从今天起改用 pnpm', at: NEW_AT, factTime: '2025-06-01' })
    expect(old.sourceTrail ?? []).toEqual([])
    const entry = await report([old, neu])
    tier = 'trust'
    reply = confident()
    await run()
    expect(prompts).toHaveLength(1)
    expect((await openEntry(entry.id))!.dreamsReview).toMatchObject({ runId: 'run_1', outcome: 'order-unclear' })
    expect((await get('mem_old')).status).toBe('active')
  })

  it('出处清单里的锚缺 change（手改漏了）：同样按旧版本的锚，序号对不上不按时间找回', async () => {
    const old = await memory('mem_old', { text: '项目用 npm 管依赖', at: OLD_AT, factTime: '2025-03-01', mode: 'agent-inferred' })
    const neu = await memory('mem_new', { text: '从今天起改用 pnpm', at: NEW_AT, factTime: '2025-06-01' })
    await store.updateIfLive({ id: 'mem_old' }, cur => ({ ...cur, sourceTrail: cur.sourceTrail!.map(({ change: _change, ...a }) => a) }))
    const entry = await report([await get('mem_old'), neu])
    expect(old.sourceTrail![0]!.change).toBe('create')
    const s = sessions.get('s_mem_old')!
    sessions.set('s_mem_old', { ...s, events: s.events.map(e => ({ ...e, seq: (e.seq ?? 0) + 50 })) })
    reply = confident()
    await run()
    expect(prompts).toHaveLength(0)
    expect(await skippedItems()).toContainEqual({ step: 'resolve-findings', kind: 'resolve', target: entry.id, reason: 'source-unreadable' })
  })

  it('旧版本写的记忆序号对不上：不按时间找回，按读不到算', async () => {
    const old = await memory('mem_old', { text: '项目用 npm 管依赖', at: OLD_AT, factTime: '2025-03-01', mode: 'agent-inferred', isLegacy: true, extra: { updatedAt: OLD_AT } })
    const neu = await memory('mem_new', { text: '从今天起改用 pnpm', at: NEW_AT, factTime: '2025-06-01' })
    const entry = await report([old, neu])
    const s = sessions.get('s_mem_old')!
    sessions.set('s_mem_old', { ...s, events: s.events.map(e => ({ ...e, seq: (e.seq ?? 0) + 50 })) })
    reply = confident()
    await run()
    expect(prompts).toHaveLength(0)
    expect(await skippedItems()).toContainEqual({ step: 'resolve-findings', kind: 'resolve', target: entry.id, reason: 'source-unreadable' })
  })
})

describe('不交给这一步的发现', () => {
  it('指令文件的冲突、例外提示、跨范围的一对都不碰，同一次运行里别的一对照常处理', async () => {
    const [old, neu] = await npmPair()
    const normal = await report([old, neu])
    // 纵向、跨范围这两条挂在新的一方：状态变化只清旧的一方的未决发现（D68），这里只看「这一步不处理它们」
    const vertical = await report([neu], { baselineRef: 'AGENTS.md：依赖一律用 npm' })
    const [c, d] = await npmPair({ prefix: 'other' })
    const exception = await report([c, d], { kind: 'exception' })
    const ws = await memory('mem_ws', { text: '这个项目用 yarn', at: NEW_AT, factTime: '2025-07-01', workspacePath: WS })
    const cross = await report([neu, ws], { labels: ['global', WS] })
    reply = confident()
    await run()
    expect(prompts).toHaveLength(1)
    expect(prompts[0]!.user).toContain('mem_new')
    expect(await openEntry(normal.id)).toBeUndefined()
    for (const e of [vertical, exception, cross]) {
      const after = (await openEntry(e.id))!
      expect(kindOf(after)).toBe(kindOf(e))
      expect(after.dreamsReview).toBeUndefined()
    }
    expect((await get('other_old')).status).toBe('active')
  })
})

describe('锁定：不改，两档都通知用户', () => {
  it.each([
    ['gatekeep', 'mem_old'], ['trust', 'mem_old'], ['gatekeep', 'mem_new'], ['trust', 'mem_new'],
  ])('%s档、%s 锁定：不调模型，条目改成「重要、等你定」，原因是锁定，没有方案', async (t, lockedId) => {
    tier = t
    const lockedSpec = { extra: { locked: true } }
    const [old, neu] = await npmPair(lockedId === 'mem_old' ? { old: lockedSpec } : { neu: lockedSpec })
    const entry = await report([old, neu])
    reply = confident()
    await run()
    expect(prompts).toHaveLength(0)
    const held = (await openEntry(entry.id))!
    expect(kindOf(held)).toBe('important-pending')
    expect(held.dreamsHold).toMatchObject({ cause: 'locked', fromKind: 'conflict', conclusion: tierConclusion([old, neu]) })
    expect(held.dreamsHold!.proposal).toBeUndefined()
    expect((await get('mem_old')).status).toBe('active')
  })
})

describe('改动量上限', () => {
  it('名额用完后剩下的发现不交给模型，列进跳过，条目不记核实', async () => {
    const [a, b] = await npmPair({ prefix: 'first' })
    await report([a, b], { at: NOW - 10 })
    const [c, d] = await npmPair({ prefix: 'second' })
    const second = await report([c, d])
    ratio = 0.25
    reply = (user) => (user.includes('first_old') ? confident({}, ['first_old', 'first_new'])(user) : confident({}, ['second_old', 'second_new'])(user))
    await run()
    expect(prompts).toHaveLength(1)
    expect((await get('first_old')).status).toBe('deleted')
    expect((await get('second_old')).status).toBe('active')
    expect(await skippedItems()).toContainEqual({ step: 'resolve-findings', kind: 'resolve', target: second.id, reason: 'quota' })
    expect((await openEntry(second.id))!.dreamsReview).toBeUndefined()
    // 没处理到的两条不进这次的基线，下次仍算变了
    const marks = await dreams.baseline(GLOBAL, (await dreams.read()).records.get('global')?.completed?.runId)
    expect(marks.kind).toBe('ok')
    const keys = marks.kind === 'ok' ? Object.keys(marks.marks) : []
    expect(keys).toContain('first_new')
    expect(keys).not.toContain('second_old')
    expect(keys).not.toContain('second_new')
  })
})

describe('一次运行的模型调用上限', () => {
  it('调满上限之后不再调模型，剩下的列进跳过、不记核实、下次仍算没处理；不调模型的锁定通知照常处理', async () => {
    const entries: PendingDecision[] = []
    for (let i = 0; i <= TIER_MAX_PER_RUN; i++) {
      const [a, b] = await npmPair({ prefix: `p${i}` })
      entries.push(await report([a, b], { at: NOW - 100 + i }))
    }
    const [la, lb] = await npmPair({ prefix: 'locked', old: { extra: { locked: true } } })
    const locked = await report([la, lb], { at: NOW })
    reply = (user) => {
      const p = /"(p\d+)_old"/.exec(user)![1]!
      return confident({}, [`${p}_old`, `${p}_new`])(user)
    }
    await run()
    expect(prompts).toHaveLength(TIER_MAX_PER_RUN)
    expect((await get('p0_old')).status).toBe('deleted')
    const last = entries.at(-1)!
    expect((await get(`p${TIER_MAX_PER_RUN}_old`)).status).toBe('active')
    expect(await skippedItems()).toContainEqual({ step: 'resolve-findings', kind: 'resolve', target: last.id, reason: 'run-limit' })
    expect((await openEntry(last.id))!.dreamsReview).toBeUndefined()
    expect(kindOf((await openEntry(locked.id))!)).toBe('important-pending')
    const marks = await dreams.baseline(GLOBAL, (await dreams.read()).records.get('global')?.completed?.runId)
    const keys = marks.kind === 'ok' ? Object.keys(marks.marks) : []
    expect(keys).toContain('p0_new')
    expect(keys).not.toContain(`p${TIER_MAX_PER_RUN}_old`)
    expect(keys).not.toContain(`p${TIER_MAX_PER_RUN}_new`)
  })

  it('这次没有要调模型的一对：不取模型', async () => {
    const [old, neu] = await npmPair({ old: { extra: { locked: true } } })
    const entry = await report([old, neu])
    await run()
    expect(kindOf((await openEntry(entry.id))!)).toBe('important-pending')
    expect(llmResolves).toBe(0)
    expect(prompts).toHaveLength(0)
  })
})

describe('并发', () => {
  it('调模型期间用户改了旧的一方：跳过、不覆盖用户的改动，条目照旧', async () => {
    const [old, neu] = await npmPair()
    const entry = await report([old, neu])
    reply = async (user) => {
      await store.updateIfLive({ id: 'mem_old' }, cur => ({ ...cur, content: '用户刚改的：项目用 npm 和 pnpm', updatedAt: NOW + 5 }))
      return confident()(user)
    }
    await run()
    expect(prompts).toHaveLength(1)
    expect(await get('mem_old')).toMatchObject({ status: 'active', content: '用户刚改的：项目用 npm 和 pnpm' })
    const after = (await openEntry(entry.id))!
    expect(kindOf(after)).toBe('conflict')
    expect(after.dreamsReview).toBeUndefined()
    // 写之前在认领里重读两条：依据变了，放弃这一对，不交给变更集
    expect(await skippedItems()).toContainEqual({ step: 'resolve-findings', kind: 'resolve', target: entry.id, reason: 'basis-changed' })
    expect((await settledEntry('run_1'))?.dreamsResults ?? []).toEqual([])
  })

  it.each(['mem_old', 'mem_new'])('调模型期间用户锁了 %s：放弃这一对，不改，条目照旧', async (lockedId) => {
    const [old, neu] = await npmPair()
    const entry = await report([old, neu])
    reply = async (user) => {
      await store.updateIfLive({ id: lockedId }, cur => ({ ...cur, locked: true }))
      return confident()(user)
    }
    await run()
    expect(prompts).toHaveLength(1)
    expect((await get('mem_old')).status).toBe('active')
    expect(mergedIntoOf(await get('mem_old'))).toBeUndefined()
    const after = (await openEntry(entry.id))!
    expect(kindOf(after)).toBe('conflict')
    expect(after.dreamsReview).toBeUndefined()
    expect(await skippedItems()).toContainEqual({ step: 'resolve-findings', kind: 'resolve', target: entry.id, reason: 'locked' })
  })

  it('调模型期间用户裁决这条发现：裁决照常成功；梦境之后放弃这一对，不写、不删用户的裁决', async () => {
    const [old, neu] = await npmPair()
    const entry = await report([old, neu])
    let during: Awaited<ReturnType<typeof confirm>> | undefined
    reply = async (user) => {
      during = await confirm(entry.id, 'keep-right')
      return confident()(user)
    }
    await run()
    expect(prompts).toHaveLength(1)
    expect(during).toMatchObject({ kind: 'resolved', verdict: 'keep-right' })
    // 用户删的是左边那条（软删，不是并成版本）
    expect((await get('mem_old')).status).toBe('deleted')
    expect(mergedIntoOf(await get('mem_old'))).toBeUndefined()
    expect((await get('mem_new')).status).toBe('active')
    expect((await settledEntry(entry.id))!.settled?.verdict).toBe('keep-right')
    expect((await settledEntry('run_1'))?.dreamsResults ?? []).toEqual([])
    expect(await skippedItems()).toContainEqual({ step: 'resolve-findings', kind: 'resolve', target: entry.id, reason: 'entry-changed' })
    // 用户的裁决照样能撤
    expect(await undo(entry.id)).toMatchObject({ kind: 'undone' })
    expect((await get('mem_old')).status).toBe('active')
  })

  it('把关档调模型期间用户改了旧的一方：不写过时的方案，条目照旧', async () => {
    const [old, neu] = await npmPair({ old: { type: 'decision', mode: 'user-explicit' } })
    const entry = await report([old, neu])
    reply = async (user) => {
      await store.updateIfLive({ id: 'mem_old' }, cur => ({ ...cur, content: '用户刚改的：项目用 npm', updatedAt: NOW + 5 }))
      return confident()(user)
    }
    await run()
    const after = (await openEntry(entry.id))!
    expect(kindOf(after)).toBe('conflict')
    expect(after.dreamsHold).toBeUndefined()
    expect(after.change).toBeUndefined()
    expect(await skippedItems()).toContainEqual({ step: 'resolve-findings', kind: 'resolve', target: entry.id, reason: 'basis-changed' })
  })

  it('把关档调模型期间用户锁了新的一方：改成锁定通知，不带方案', async () => {
    const [old, neu] = await npmPair({ old: { type: 'decision', mode: 'user-explicit' } })
    const entry = await report([old, neu])
    reply = async (user) => {
      await store.updateIfLive({ id: 'mem_new' }, cur => ({ ...cur, locked: true }))
      return confident()(user)
    }
    await run()
    const after = (await openEntry(entry.id))!
    expect(kindOf(after)).toBe('important-pending')
    expect(after.dreamsHold).toMatchObject({ cause: 'locked', fromKind: 'conflict' })
    expect(after.dreamsHold!.proposal).toBeUndefined()
    expect(after.change).toBeUndefined()
  })

  it('没把握、调模型期间用户锁了新的一方：交给用户时改成锁定通知，不记核实', async () => {
    const [old, neu] = await npmPair()
    const entry = await report([old, neu])
    reply = async (user) => {
      await store.updateIfLive({ id: 'mem_new' }, cur => ({ ...cur, locked: true }))
      return confident({ uncertain: true })(user)
    }
    await run()
    expect(prompts).toHaveLength(1)
    const after = (await openEntry(entry.id))!
    expect(kindOf(after)).toBe('important-pending')
    expect(after.dreamsHold).toMatchObject({ cause: 'locked', fromKind: 'conflict' })
    expect(after.dreamsHold!.proposal).toBeUndefined()
    expect(after.dreamsReview).toBeUndefined()
    expect(after.change).toBeUndefined()
    expect((await get('mem_old')).status).toBe('active')
  })

  it('认领里核对过之后、落盘之前用户锁了新的一方：写入段里按依据方的锁挡住，不写', async () => {
    const [old, neu] = await npmPair()
    const entry = await report([old, neu])
    reply = confident()
    // 拿到回复之后的第一个写入段之前上锁：认领里的复核已经过了，只剩写入段里的门
    const section = store.writeSection.bind(store)
    let isArmed = false
    reply = (user) => { isArmed = true; return confident()(user) }
    store.writeSection = async <T>(fn: () => Promise<T>): Promise<T> => {
      if (isArmed) {
        isArmed = false
        await store.updateIfLive({ id: 'mem_new' }, cur => ({ ...cur, locked: true }))
      }
      return section(fn)
    }
    await run()
    store.writeSection = section
    expect((await get('mem_old')).status).toBe('active')
    expect(mergedIntoOf(await get('mem_old'))).toBeUndefined()
    expect(kindOf((await openEntry(entry.id))!)).toBe('conflict')
    expect((await skippedItems()).some(i => i.reason === 'locked')).toBe(true)
    expect((await settledEntry('run_1'))?.dreamsResults ?? []).toEqual([])
  })

  it('撤过的结论读不全：这一步不处理，运行按没做完收，条目不记核实', async () => {
    const [old, neu] = await npmPair()
    const entry = await report([old, neu])
    reply = confident()
    // 运行开头读记录时还读得全，到这一步之前变得读不出
    const breakRecords: DreamsStep = { name: 'break', needsChanges: false, run: async () => { dreamsRecords.isComplete = false } }
    const r = await runRaw(GLOBAL, [], [breakRecords])
    expect(r.kind).toBe('failed')
    expect(prompts).toHaveLength(0)
    expect((await openEntry(entry.id))!.dreamsReview).toBeUndefined()
    expect((await get('mem_old')).status).toBe('active')
    // 读得全了之后下次照常处理
    dreamsRecords.isComplete = true
    expect((await runRaw()).kind).toBe('completed')
    expect(prompts).toHaveLength(1)
    expect((await get('mem_old')).status).toBe('deleted')
  })

  it('这次运行前面的步骤把一条留给下次：这一对不碰，不列跳过、不记核实', async () => {
    const [old, neu] = await npmPair()
    const entry = await report([old, neu])
    reply = confident()
    const holdOld: DreamsStep = { name: 'hold', needsChanges: false, run: async (ctx) => { ctx.holdForNextRun(['mem_old']) } }
    expect((await runRaw(GLOBAL, [], [holdOld])).kind).toBe('completed')
    expect(prompts).toHaveLength(0)
    expect(await openEntry(entry.id)).toEqual(entry)
    expect((await skippedItems()).filter(i => i.target === entry.id)).toEqual([])
  })

  it('调模型期间叫停：拿到回复之后不写，条目不记核实', async () => {
    const [old, neu] = await npmPair()
    const entry = await report([old, neu])
    const stop = new AbortController()
    reply = (user) => { stop.abort(); return confident()(user) }
    const r = await runRaw(GLOBAL, [], [], stop.signal)
    expect(prompts).toHaveLength(1)
    expect(r.kind).not.toBe('completed')
    expect((await get('mem_old')).status).toBe('active')
    expect(await openEntry(entry.id)).toEqual(entry)
  })

  it('处理到一半用户撤销了这次运行：后面的一对不再写，运行按出错收', async () => {
    const [a, b] = await npmPair({ prefix: 'first' })
    await report([a, b], { at: NOW - 10 })
    const [c, d] = await npmPair({ prefix: 'second' })
    const second = await report([c, d])
    let undone: Awaited<ReturnType<typeof undo>> | undefined
    reply = async (user) => {
      if (user.includes('second_old')) {
        undone = await undo('run_1')
        return confident({}, ['second_old', 'second_new'])(user)
      }
      return confident({}, ['first_old', 'first_new'])(user)
    }
    const r = await runRaw()
    expect(undone).toMatchObject({ kind: 'undone' })
    expect(r.kind).toBe('failed')
    expect((await get('first_old')).status).toBe('active')
    expect((await get('second_old')).status).toBe('active')
    expect(kindOf((await openEntry(second.id))!)).toBe('conflict')
  })

  it.each([
    ['直接处理', {}],
    ['交给用户', { uncertain: true }],
  ] as const)('条目一直被别处占着（%s）：照常调模型，写之前认领不到就放弃这一对，列进跳过；放开后下次照常处理', async (_name, extra) => {
    const [old, neu] = await npmPair()
    const entry = await report([old, neu])
    reply = confident(extra)
    // 调模型不占条目：别处占着也照样核实，只是写不进去
    const release = (await decisions.hold(entry.id))!
    await run()
    expect(prompts).toHaveLength(1)
    expect(await skippedItems()).toContainEqual({ step: 'resolve-findings', kind: 'resolve', target: entry.id, reason: 'busy' })
    expect((await get('mem_old')).status).toBe('active')
    expect(await openEntry(entry.id)).toEqual(entry)
    expect((await settledEntry('run_1'))?.dreamsResults ?? []).toEqual([])
    await release()
    reply = confident()
    await run()
    expect(prompts).toHaveLength(2)
    expect((await get('mem_old')).status).toBe('deleted')
  })

  it('模型回复读不出：重问一次，仍读不出这次按没做完收，条目不记核实', async () => {
    const [old, neu] = await npmPair()
    const entry = await report([old, neu])
    reply = () => '我觉得是状态变化'
    const r = await runRaw()
    expect(prompts).toHaveLength(2)
    expect(r.kind).toBe('failed')
    expect((await openEntry(entry.id))!.dreamsReview).toBeUndefined()
    expect((await get('mem_old')).status).toBe('active')
  })
})

describe('撤过的结论不再重做', () => {
  it('撤销梦境处理的那一组后，同一对再报：下次运行不调模型，交给用户', async () => {
    const [old, neu] = await npmPair()
    await report([old, neu])
    reply = confident()
    await run()
    expect((await get('mem_old')).status).toBe('deleted')
    expect(await undo('run_1')).toMatchObject({ kind: 'undone' })
    expect((await get('mem_old')).status).toBe('active')
    const again = await report([await get('mem_old'), await get('mem_new')])
    await run()
    expect(prompts).toHaveLength(1)
    expect((await openEntry(again.id))!.dreamsReview).toMatchObject({ outcome: 'undone-before' })
    expect((await get('mem_old')).status).toBe('active')
  })
})

describe('「重要、等你定」：用户在先处理里定', () => {
  const important = { old: { type: 'decision', mode: 'user-explicit' } }
  async function held() {
    const [old, neu] = await npmPair(important)
    const entry = await report([old, neu])
    reply = confident()
    await run()
    const after = (await openEntry(entry.id))!
    expect(kindOf(after)).toBe('important-pending')
    return { entry: after, old, neu }
  }

  it('采纳：按方案落盘，条目结清；撤销后回到「重要、等你定」、方案还在', async () => {
    const { entry } = await held()
    expect(await confirm(entry.id, 'adopt')).toMatchObject({ kind: 'resolved', verdict: 'adopt' })
    expect(mergedIntoOf(await get('mem_old'))).toEqual({ id: 'mem_new', scopeKey: 'global', as: 'version', endedAt: expect.any(Number) })
    expect(await openEntry(entry.id)).toBeUndefined()
    expect((await settledEntry(entry.id))!.settled?.verdict).toBe('adopt')
    expect(await undo(entry.id)).toMatchObject({ kind: 'undone' })
    expect((await get('mem_old')).status).toBe('active')
    const reopened = (await openEntry(entry.id))!
    expect(kindOf(reopened)).toBe('important-pending')
    expect(reopened.dreamsHold?.proposal?.ops).toEqual(entry.dreamsHold?.proposal?.ops)
  })

  it('采纳时方案的依据已变：回 stale，条目和记忆都不动', async () => {
    const { entry } = await held()
    await store.updateIfLive({ id: 'mem_old' }, cur => ({ ...cur, content: '用户后来补了一句', updatedAt: NOW + 5 }))
    expect(await confirm(entry.id, 'adopt')).toMatchObject({ kind: 'error', code: 'stale' })
    expect(kindOf((await openEntry(entry.id))!)).toBe('important-pending')
    expect(await get('mem_old')).toMatchObject({ status: 'active', content: '用户后来补了一句' })
  })

  it('不采纳：和普通冲突不采纳一样结清；体检再报同一对沿用这个裁决，不再挂出来；梦境的方案作废、不记撤销过的结论', async () => {
    const { entry, old, neu } = await held()
    expect(await confirm(entry.id, 'dismiss')).toMatchObject({ kind: 'resolved', verdict: 'dismiss' })
    expect(await openEntry(entry.id)).toBeUndefined()
    expect((await settledEntry(entry.id))!.settled?.verdict).toBe('dismiss')
    const again = await report([old, neu])
    expect(again.id).toBe(entry.id)
    expect(await openEntry(entry.id)).toBeUndefined()
    expect((await decisions.list()).filter(e => e.memoryIds.includes('mem_old'))).toHaveLength(0)
    await run()
    expect(prompts).toHaveLength(1)
    const undone = await dreams.undoneMerges(GLOBAL)
    expect(undone).toBeDefined()
    expect(undone!.has(tierConclusion([old, neu]))).toBe(false)
    expect((await get('mem_old')).status).toBe('active')
  })

  it('按原来那种发现留左删右：和普通冲突一样删掉另一条；撤销后回到「重要、等你定」、梦境留的东西原样', async () => {
    const { entry } = await held()
    expect(entry.memoryIds).toEqual(['mem_old', 'mem_new'])
    expect(await confirm(entry.id, 'keep-left')).toMatchObject({ kind: 'resolved', verdict: 'keep-left' })
    expect((await get('mem_new')).status).toBe('deleted')
    expect((await get('mem_old')).status).toBe('active')
    expect(await openEntry(entry.id)).toBeUndefined()
    expect((await settledEntry(entry.id))!.settled?.verdict).toBe('keep-left')
    expect(await undo(entry.id)).toMatchObject({ kind: 'undone' })
    expect((await get('mem_new')).status).toBe('active')
    const reopened = (await openEntry(entry.id))!
    expect(kindOf(reopened)).toBe('important-pending')
    expect(reopened.dreamsHold).toEqual(entry.dreamsHold)
  })

  it('按原来那种发现并成版本：和普通冲突一样；撤销后回到「重要、等你定」、梦境留的东西原样', async () => {
    const { entry } = await held()
    expect(await confirm(entry.id, 'as-versions', 'mem_new')).toMatchObject({ kind: 'resolved', verdict: 'as-versions' })
    expect(mergedIntoOf(await get('mem_old'))).toEqual({ id: 'mem_new', scopeKey: 'global', as: 'version', endedAt: expect.any(Number) })
    expect((await settledEntry(entry.id))!.settled?.verdict).toBe('as-versions')
    expect(await undo(entry.id)).toMatchObject({ kind: 'undone' })
    expect((await get('mem_old')).status).toBe('active')
    const reopened = (await openEntry(entry.id))!
    expect(kindOf(reopened)).toBe('important-pending')
    expect(reopened.dreamsHold).toEqual(entry.dreamsHold)
  })

  /** 留左删右之后不经撤销、按快照把败方恢复回来（裁决条目仍是已结清）。 */
  async function loserBack(entry: PendingDecision) {
    expect(await confirm(entry.id, 'keep-left')).toMatchObject({ kind: 'resolved', verdict: 'keep-left' })
    expect((await get('mem_new')).status).toBe('deleted')
    const snapshotId = (await settledEntry(entry.id))!.settled!.snapshotId!
    const restored = await snapshots.restore((await snapshots.get(snapshotId))!, ['mem_new'], store, { target: 'exact', overwrite: cur => cur?.status === 'deleted', now: () => NOW })
    expect(restored.restored).toEqual(['mem_new'])
    expect((await get('mem_new')).status).toBe('active')
    expect((await settledEntry(entry.id))!.settled?.verdict).toBe('keep-left')
  }

  it('留左删右之后败方被恢复、同一对又被体检报出：回到「重要、等你定」、梦境留的东西原样', async () => {
    const { entry } = await held()
    await loserBack(entry)
    const again = await report([await get('mem_old'), await get('mem_new')])
    expect(again.id).toBe(entry.id)
    const reopened = (await openEntry(entry.id))!
    expect(kindOf(reopened)).toBe('important-pending')
    expect(reopened.dreamsHold).toEqual(entry.dreamsHold)
    expect(reopened.change).toBe(entry.change)
    expect(reopened.evidence).toEqual(entry.evidence)
  })

  it('败方被恢复、但内容改过之后再报：降回原来那种发现，梦境留的东西去掉', async () => {
    const { entry } = await held()
    await loserBack(entry)
    await store.updateIfLive({ id: 'mem_new' }, cur => ({ ...cur, content: '恢复之后又补了一句', updatedAt: NOW + 5 }))
    const again = await report([await get('mem_old'), await get('mem_new')])
    expect(again.id).toBe(entry.id)
    const reopened = (await openEntry(entry.id))!
    expect(kindOf(reopened)).toBe('conflict')
    expect(reopened.dreamsHold).toBeUndefined()
    expect(reopened.change).toBeUndefined()
    expect(reopened.evidence).toBeUndefined()
    expect(await openOf('mem_old', 'mem_new')).toHaveLength(1)
  })

  it('可用的裁决按原来那种发现算：漏记的变化不能留左删右，条目和记忆都不动', async () => {
    const [old, neu] = await npmPair(important)
    const entry = await report([old, neu], { kind: 'missed-change' })
    reply = confident()
    await run()
    const after = (await openEntry(entry.id))!
    expect(kindOf(after)).toBe('important-pending')
    expect(after.dreamsHold?.fromKind).toBe('missed-change')
    expect(resolveVerdictsOf(after)).toEqual(['adopt', ...VERDICTS_BY_KIND['missed-change']])
    expect(await confirm(entry.id, 'keep-left')).toMatchObject({ kind: 'error', code: 'invalid-args' })
    expect(await openEntry(entry.id)).toEqual(after)
    expect((await get('mem_new')).status).toBe('active')
  })

  it('锁定通知没有方案：不能采纳；按原来那种发现裁决照常', async () => {
    const [old, neu] = await npmPair({ old: { extra: { locked: true } } })
    const entry = await report([old, neu])
    await run()
    const after = (await openEntry(entry.id))!
    expect(kindOf(after)).toBe('important-pending')
    expect(resolveVerdictsOf(after)).toEqual(VERDICTS_BY_KIND.conflict)
    expect(await confirm(entry.id, 'adopt')).toMatchObject({ kind: 'error', code: 'invalid-args' })
    expect(await openEntry(entry.id)).toEqual(after)
    expect(await confirm(entry.id, 'keep-both')).toMatchObject({ kind: 'resolved', verdict: 'keep-both' })
    expect(await openEntry(entry.id)).toBeUndefined()
    expect((await settledEntry(entry.id))!.settled?.verdict).toBe('keep-both')
    expect((await get('mem_old')).status).toBe('active')
    expect((await get('mem_new')).status).toBe('active')
  })

  it('memory_confirm 的裁决取值里有采纳', async () => {
    await held()
    const tool = createConfirmTool({ ...confirmDeps(), host: { contextOf: async () => ({ workspacePath: undefined }) } } as never)
    expect((tool.parameters as { properties: Record<string, { enum?: string[] }> }).properties.verdict!.enum).toContain('adopt')
  })
})

describe('「重要、等你定」与再次体检', () => {
  const important = { old: { type: 'decision', mode: 'user-explicit' } }

  it('同一对原样再报：仍是「重要、等你定」，方案留着，账本里只有一条', async () => {
    const [old, neu] = await npmPair(important)
    const entry = await report([old, neu])
    reply = confident()
    await run()
    expect(kindOf((await openEntry(entry.id))!)).toBe('important-pending')
    const r = await report([old, neu])
    expect(r.id).toBe(entry.id)
    const after = (await openEntry(entry.id))!
    expect(kindOf(after)).toBe('important-pending')
    expect(after.dreamsHold?.proposal).toBeDefined()
    expect((await decisions.list()).filter(e => e.memoryIds.includes('mem_old'))).toHaveLength(1)
  })

  it('一边内容变了再报：降回体检报的种类，梦境留的东西去掉', async () => {
    const [old, neu] = await npmPair(important)
    const entry = await report([old, neu])
    reply = confident()
    await run()
    expect(kindOf((await openEntry(entry.id))!)).toBe('important-pending')
    await store.updateIfLive({ id: 'mem_old' }, cur => ({ ...cur, content: '项目用 npm，后来补了说明', updatedAt: NOW + 5 }))
    const r = await report([await get('mem_old'), neu], { kind: 'missed-change' })
    expect(r.id).toBe(entry.id)
    const after = (await openEntry(entry.id))!
    expect(kindOf(after)).toBe('missed-change')
    expect(after.dreamsHold).toBeUndefined()
    expect(after.change).toBeUndefined()
    expect(after.evidence).toBeUndefined()
    expect((await decisions.list()).filter(e => e.memoryIds.includes('mem_old'))).toHaveLength(1)
  })

  it('「重要、等你定」的那一对在体检结果里仍算没裁决', async () => {
    const [old, neu] = await npmPair(important)
    const entry = await report([old, neu])
    reply = confident()
    await run()
    const pending = await decisions.list()
    expect(kindOf(pending.find(e => e.id === entry.id)!)).toBe('important-pending')
    expect(isConflictOpen(pending)({ type: 'conflict', memoryIds: ['mem_old', 'mem_new'] })).toBe(true)
  })
})

describe('项目范围', () => {
  it('项目里的一对在项目的运行里处理，结果记在项目的批次条目上', async () => {
    const old = await memory('p_old', { text: '项目用 npm 管依赖', at: OLD_AT, factTime: '2025-03-01', mode: 'agent-inferred', workspacePath: WS })
    const neu = await memory('p_new', { text: '从今天起改用 pnpm', at: NEW_AT, factTime: '2025-06-01', workspacePath: WS })
    const entry = await report([old, neu])
    reply = confident({}, ['p_old', 'p_new'])
    await run({ kind: 'workspace', workspacePath: WS })
    expect((await get('p_old', { kind: 'workspace', workspacePath: WS })).status).toBe('deleted')
    expect(await openEntry(entry.id)).toBeUndefined()
    expect((await settledEntry('run_1'))!.dreamsResults?.[0]).toMatchObject({ older: 'p_old', newer: 'p_new' })
  })
})

describe('依据方上锁时变更集不写', () => {
  it.each([[undefined], ['g1']])('记忆梦境按锁着的那条并版本（分组 %s）：跳过、记成锁定，锁着的是依据那条；别的发起方照常写', async (group) => {
    const [old, neu] = await npmPair({ neu: { extra: { locked: true } } })
    const entry = await report([old, neu])
    const ops = versionPlan({ id: 'op1', current: neu, old, ...(group !== undefined ? { group } : {}) })
    const changesetDeps = { store, snapshots, decisions, log: quiet }
    const byDreams = await applyChangeset(ops, { entryId: entry.id, by: DREAMS_INITIATOR, at: NOW, isSecretChecked: true }, changesetDeps)
    expect(byDreams.outcomes).toEqual([{ kind: 'skipped', opId: 'op1', memoryId: 'mem_new', reason: 'locked' }])
    expect((await get('mem_old')).status).toBe('active')
    const byMain = await applyChangeset(ops, { entryId: entry.id, by: 'main', at: NOW, isSecretChecked: true }, changesetDeps)
    expect(byMain.outcomes[0]).toMatchObject({ kind: 'applied', memoryId: 'mem_old' })
  })
})

describe('依据方是本组另一操作的目标时', () => {
  it.each([
    ['被合并的一条', 'mem_c', ['group', 'group', 'locked']],
    ['保留的那条', 'mem_a', ['locked', 'group', 'group']],
  ] as const)('锁着的是%s：只由它自己那一步挡住，别的操作不因依据里列着它额外拦', async (_name, lockedId, reasons) => {
    const recs = []
    for (const id of ['mem_a', 'mem_b', 'mem_c']) recs.push(await memory(id, { text: `${id} 发版流程`, at: OLD_AT, ...(id === lockedId ? { extra: { locked: true } } : {}) }))
    const [a, b, c] = recs as [MemoryRecord, MemoryRecord, MemoryRecord]
    const entry = await report([a, b])
    const ops = mergePlan({ group: 'g1', keeper: a, merged: [b, c], fused: { name: '发版流程', summary: '发版流程的摘要', content: '合并后的发版流程', tags: [] } })
    const r = await applyChangeset(ops, { entryId: entry.id, by: DREAMS_INITIATOR, at: NOW, isSecretChecked: true }, { store, snapshots, decisions, log: quiet })
    expect(r.groups).toEqual([{ group: 'g1', state: 'skipped' }])
    expect(r.outcomes.map(o => (o.kind === 'skipped' ? o.reason : o.kind))).toEqual(reasons)
    expect(r.outcomes.find(o => o.kind === 'skipped' && o.reason === 'locked')!.memoryId).toBe(lockedId)
    for (const id of ['mem_a', 'mem_b', 'mem_c']) expect((await get(id)).status).toBe('active')
  })
})

describe('处理掉一对之后清账', () => {
  it('状态变化：别的未决发现里有旧的一方的一起清掉，已裁决的条目留着', async () => {
    const [old, neu] = await npmPair()
    const third = await memory('mem_third', { text: '项目用 npm 跑脚本', at: OLD_AT })
    const fourth = await memory('mem_fourth', { text: '项目用 npm 发包', at: OLD_AT })
    const entry = await report([old, neu])
    // 另几条用例外提示（不交给这一步处理的种类），这次运行只核实配对的那一条
    const other = await report([old, third], { kind: 'exception', at: NOW - 5 })
    const settledOne = await report([old, fourth], { at: NOW - 6 })
    expect(await confirm(settledOne.id, 'keep-both')).toMatchObject({ kind: 'resolved' })
    const unrelated = await report([third, fourth], { kind: 'exception', at: NOW - 7 })
    reply = confident()
    await run()
    expect(prompts).toHaveLength(1)
    expect((await get('mem_old')).status).toBe('deleted')
    expect(await openEntry(entry.id)).toBeUndefined()
    expect(await openEntry(other.id)).toBeUndefined()
    expect(await openEntry(unrelated.id)).toBeDefined()
    expect((await settledEntry(settledOne.id))!.settled?.verdict).toBe('keep-both')
  })

  it('纠错：只清这一对的发现，旧的一方别的发现留着', async () => {
    const [old, neu] = await npmPair()
    const third = await memory('mem_third', { text: '项目用 npm 跑脚本', at: OLD_AT })
    const entry = await report([old, neu])
    const other = await report([old, third], { kind: 'exception', at: NOW - 5 })
    reply = confident({ change: 'correct', draft: { content: '项目一直用 pnpm 管依赖' } })
    await run()
    expect(prompts).toHaveLength(1)
    expect((await get('mem_old')).content).toBe('项目一直用 pnpm 管依赖')
    expect(await openEntry(entry.id)).toBeUndefined()
    expect(await openEntry(other.id)).toBeDefined()
  })

  it('清账的提交后步骤：文件还是这次写下的样子才删发现；补做重复跑不出错', async () => {
    const [old, neu] = await npmPair()
    const third = await memory('mem_third', { text: '项目用 npm 跑脚本', at: OLD_AT })
    const entry = await report([old, neu])
    const other = await report([old, third], { kind: 'missed-change', at: NOW - 5 })
    const settledOne = await report([neu, third], { at: NOW - 6 })
    expect(await confirm(settledOne.id, 'keep-both')).toMatchObject({ kind: 'resolved' })
    const handler = ledgerSteps(decisions, quiet)[RESOLVED_FINDING_STEP]!
    const step = resolvedFindingStep({ entryId: entry.id, olderId: 'mem_old' })
    expect(step).toEqual({ kind: RESOLVED_FINDING_STEP, entryId: entry.id, olderId: 'mem_old' })
    await handler(step, { op: 'op_x', record: undefined, isIntact: false })
    expect(await openEntry(entry.id)).toBeDefined()
    expect(await openEntry(other.id)).toBeDefined()
    // 处理器不认领条目：别处正占着的发现照样清掉
    const release = (await decisions.hold(other.id))!
    await handler(step, { op: 'op_x', record: undefined, isIntact: true })
    expect(await openEntry(entry.id)).toBeUndefined()
    expect(await openEntry(other.id)).toBeUndefined()
    await release()
    await handler(step, { op: 'op_x', record: undefined, isIntact: true })
    await handler(resolvedFindingStep({ entryId: settledOne.id }), { op: 'op_y', record: undefined, isIntact: true })
    expect((await settledEntry(settledOne.id))!.settled?.verdict).toBe('keep-both')
  })

  it('清账出错：不会留下「旧的已并掉、发现还挂着」；之后体检再报、梦境再跑，处理干净', async () => {
    const [old, neu] = await npmPair()
    const entry = await report([old, neu])
    let isBroken = true
    for (const name of ['delete', 'deleteIf'] as const) {
      const original = ledger[name].bind(ledger) as (...args: unknown[]) => Promise<boolean>
      ;(ledger as unknown as Record<string, unknown>)[name] = async (...args: unknown[]) => {
        if (isBroken && args[0] === entry.id) {
          isBroken = false
          throw new Error('账本写不进去')
        }
        return original(...args)
      }
    }
    reply = confident()
    await runRaw()
    expect(isBroken).toBe(false)
    expect(prompts).toHaveLength(1)
    // 写下的那一步按出错撤回、或补做时清了账：两种都行，只是不能两头不一致
    const first = await get('mem_old')
    const isMerged = mergedIntoOf(first)?.as === 'version'
    if (isMerged) expect(await openEntry(entry.id)).toBeUndefined()
    else expect(first.status).toBe('active')
    // 下次体检照常报还矛盾着的一对，梦境再跑一次处理干净
    if (!isMerged) await report([await get('mem_old'), await get('mem_new')])
    await run()
    expect(mergedIntoOf(await get('mem_old'))).toEqual({ id: 'mem_new', scopeKey: 'global', as: 'version', endedAt: expect.any(Number) })
    expect(await openOf('mem_old', 'mem_new')).toEqual([])
  })
})

describe('「重要、等你定」：采纳和别的入口', () => {
  const important = { old: { type: 'decision', mode: 'user-explicit' } }
  async function heldPair(opts: Parameters<typeof report>[1] = {}) {
    const [old, neu] = await npmPair(important)
    const entry = await report([old, neu], opts)
    reply = confident()
    await run()
    const after = (await openEntry(entry.id))!
    expect(kindOf(after)).toBe('important-pending')
    return after
  }

  it('采纳先过跨项目门：同 id 在全局另有一份时，从别的项目采纳仍按方案里那一份判，挡住', async () => {
    const old = await memory('p_old', { text: '项目用 npm 管依赖', at: OLD_AT, factTime: '2025-03-01', type: 'decision', mode: 'user-explicit', workspacePath: WS })
    const neu = await memory('p_new', { text: '从今天起改用 pnpm', at: NEW_AT, factTime: '2025-06-01', workspacePath: WS })
    const entry = await report([old, neu])
    reply = confident({}, ['p_old', 'p_new'])
    await run({ kind: 'workspace', workspacePath: WS })
    expect(kindOf((await openEntry(entry.id))!)).toBe('important-pending')
    // 全局里同 id 的两份（别的项目看得见它们）
    for (const r of [old, neu]) {
      const { workspacePath: _w, ...rest } = r
      await store.create({ ...rest, scope: 'global', content: `全局的${r.id}` })
    }
    const OTHER = '/proj/other'
    expect(await confirm(entry.id, 'adopt', undefined, OTHER)).toMatchObject({ kind: 'error', code: 'cross-workspace' })
    expect(kindOf((await openEntry(entry.id))!)).toBe('important-pending')
    expect((await get('p_old', { kind: 'workspace', workspacePath: WS })).status).toBe('active')
    expect((await get('p_old')).status).toBe('active')
    expect(await confirm(entry.id, 'adopt', undefined, WS)).toMatchObject({ kind: 'resolved', verdict: 'adopt' })
    expect((await get('p_old', { kind: 'workspace', workspacePath: WS })).status).toBe('deleted')
    expect((await get('p_old')).status).toBe('active')
  })

  it.each(['adopt', 'keep-left'] as const)('没有冲突指纹的旧条目（%s）：裁决后条目留着回执，撤销后回到「重要、等你定」', async (verdict) => {
    const entry = await heldPair({ isLegacy: true })
    expect(entry.fingerprint).toBeUndefined()
    expect(await confirm(entry.id, verdict)).toMatchObject({ kind: 'resolved', verdict })
    expect((await settledEntry(entry.id))!.settled?.verdict).toBe(verdict)
    expect(await undo(entry.id)).toMatchObject({ kind: 'undone' })
    expect((await get('mem_old')).status).toBe('active')
    expect((await get('mem_new')).status).toBe('active')
    const reopened = (await openEntry(entry.id))!
    expect(kindOf(reopened)).toBe('important-pending')
    expect(reopened.dreamsHold).toEqual(entry.dreamsHold)
  })

  it('没有冲突指纹的旧条目、纠错方案：采纳后条目和改写回执都留着，旧的一方别的发现不清，撤销后回到「重要、等你定」', async () => {
    const [old, neu] = await npmPair(important)
    const third = await memory('mem_third', { text: '项目用 npm 跑脚本', at: OLD_AT })
    const entry = await report([old, neu], { isLegacy: true })
    const other = await report([old, third], { kind: 'exception', at: NOW - 5 })
    reply = confident({ change: 'correct', draft: { content: '项目一直用 pnpm 管依赖' } })
    await run()
    const held = (await openEntry(entry.id))!
    expect(kindOf(held)).toBe('important-pending')
    expect(held.fingerprint).toBeUndefined()
    expect(held.change).toBe('correct')
    expect(await confirm(entry.id, 'adopt')).toMatchObject({ kind: 'resolved', verdict: 'adopt' })
    expect((await get('mem_old')).content).toBe('项目一直用 pnpm 管依赖')
    // 采纳纠错没有败方、条目也没有指纹：带着改写回执就不能删
    const settled = (await settledEntry(entry.id))!
    expect(settled.settled?.verdict).toBe('adopt')
    expect(settled.changes?.map(c => [c.kind, c.memoryId])).toEqual([['edit', 'mem_old']])
    expect(await openEntry(other.id)).toBeDefined()
    expect(await undo(entry.id)).toMatchObject({ kind: 'undone' })
    expect((await get('mem_old')).content).toBe(old.content)
    const reopened = (await openEntry(entry.id))!
    expect(kindOf(reopened)).toBe('important-pending')
    expect(reopened.dreamsHold).toEqual(held.dreamsHold)
  })

  it('从最近删除恢复采纳删掉的那条：重开条目，回到「重要、等你定」', async () => {
    const entry = await heldPair()
    expect(await confirm(entry.id, 'adopt')).toMatchObject({ kind: 'resolved', verdict: 'adopt' })
    expect((await get('mem_old')).status).toBe('deleted')
    expect(await restoreDeleted({ memoryId: 'mem_old' }, { workspacePath: undefined }, undoDeps())).toMatchObject({ kind: 'restored', decisionId: entry.id })
    expect((await get('mem_old')).status).toBe('active')
    expect(kindOf((await openEntry(entry.id))!)).toBe('important-pending')
  })

  it('最近删除里认得采纳删掉的那条：删除来源按并成版本给出，对方是新的一方', async () => {
    const entry = await heldPair()
    expect(await confirm(entry.id, 'adopt')).toMatchObject({ kind: 'resolved', verdict: 'adopt' })
    const data = await prereadScopes({ store, decisions, cache: new InMemoryKvTable<ScanCacheEntry>() }, [GLOBAL])
    const view = buildDeletedView({
      now: NOW, memoryRoot: root, registry: buildTypeRegistry({ template: 'coding', customTypes: {} }), data,
      readScopes: [GLOBAL], healthScopes: [GLOBAL], open: await decisions.list(), settled: await decisions.listSettled(), listingNotes: [], governanceEnabled: true,
    })
    const item = view.items.find(i => i.memory.id === 'mem_old')!
    expect(item.cause).toMatchObject({ decisionId: entry.id, verdict: 'as-versions', counterpartId: 'mem_new' })
    expect(item.cause?.snapshotId).toBeDefined()
  })

  it('锁定通知里锁着的那条：用户按原种类裁决删掉它照常成功', async () => {
    const [old, neu] = await npmPair({ old: { extra: { locked: true } } })
    const entry = await report([old, neu])
    await run()
    expect(kindOf((await openEntry(entry.id))!)).toBe('important-pending')
    expect(await confirm(entry.id, 'keep-right')).toMatchObject({ kind: 'resolved', verdict: 'keep-right' })
    expect((await get('mem_old')).status).toBe('deleted')
    expect((await settledEntry(entry.id))!.settled?.verdict).toBe('keep-right')
  })

  it('再报时比各成员的扫描指纹：冲突指纹相同、成员指纹变了也降回原种类', async () => {
    const entry = await heldPair({ members: { mem_old: 'fp_old', mem_new: 'fp_new' } })
    const same = await report([await get('mem_old'), await get('mem_new')], { members: { mem_old: 'fp_old', mem_new: 'fp_new' } })
    expect(same.id).toBe(entry.id)
    expect(kindOf((await openEntry(entry.id))!)).toBe('important-pending')
    await report([await get('mem_old'), await get('mem_new')], { members: { mem_old: 'fp_old_2', mem_new: 'fp_new' } })
    const after = (await openEntry(entry.id))!
    expect(kindOf(after)).toBe('conflict')
    expect(after.dreamsHold).toBeUndefined()
  })

  it('没有冲突指纹的条目再报：比不了，降回原种类', async () => {
    const entry = await heldPair({ isLegacy: true })
    await report([await get('mem_old'), await get('mem_new')], { isLegacy: true })
    const after = (await openEntry(entry.id))!
    expect(kindOf(after)).toBe('conflict')
    expect(after.dreamsHold).toBeUndefined()
  })
})

describe('锁定通知在解锁之后', () => {
  it('两边都解锁了：下次运行改回原来那种发现，同一次运行里照常处理', async () => {
    const [old, neu] = await npmPair({ old: { extra: { locked: true } } })
    const entry = await report([old, neu])
    await run()
    expect((await openEntry(entry.id))!.dreamsHold).toMatchObject({ cause: 'locked' })
    await store.updateIfLive({ id: 'mem_old' }, cur => ({ ...cur, locked: false }))
    reply = confident()
    await run()
    expect(prompts).toHaveLength(1)
    expect((await get('mem_old')).status).toBe('deleted')
    expect(await openEntry(entry.id)).toBeUndefined()
  })

  it('锁到期了：同样改回原来那种发现处理；没到期之前照旧是锁定通知', async () => {
    const [old, neu] = await npmPair({ old: { extra: { locked: true, lockedUntil: NOW + 60_000 } } })
    const entry = await report([old, neu])
    await run()
    reply = confident()
    await run()
    expect(prompts).toHaveLength(0)
    expect(kindOf((await openEntry(entry.id))!)).toBe('important-pending')
    clock = NOW + 120_000
    await run()
    expect(prompts).toHaveLength(1)
    expect((await get('mem_old')).status).toBe('deleted')
  })

  it('只解了一边：仍是锁定通知，不调模型', async () => {
    const [old, neu] = await npmPair({ old: { extra: { locked: true } }, neu: { extra: { locked: true } } })
    const entry = await report([old, neu])
    await run()
    await store.updateIfLive({ id: 'mem_old' }, cur => ({ ...cur, locked: false }))
    reply = confident()
    await run()
    expect(prompts).toHaveLength(0)
    expect((await openEntry(entry.id))!.dreamsHold).toMatchObject({ cause: 'locked' })
  })
})

describe('手改出来的「重要、等你定」（没有梦境留的东西）', () => {
  async function bare() {
    const [old, neu] = await npmPair()
    const entry = await report([old, neu])
    const edited = { ...entry, kind: 'important-pending' as const }
    await ledger.put(entry.id, edited)
    return edited
  }

  it('不交给梦境，裁决只认不采纳，不算没裁决的冲突', async () => {
    const entry = await bare()
    reply = confident()
    await run()
    expect(prompts).toHaveLength(0)
    expect(await openEntry(entry.id)).toEqual(entry)
    expect(isConflictOpen(await decisions.list())({ type: 'conflict', memoryIds: ['mem_old', 'mem_new'] })).toBe(false)
    expect(await confirm(entry.id, 'keep-left')).toMatchObject({ kind: 'error', code: 'invalid-args' })
    expect(await confirm(entry.id, 'dismiss')).toMatchObject({ kind: 'resolved', verdict: 'dismiss' })
    expect((await get('mem_new')).status).toBe('active')
  })
})

describe('体检输出里的「重要、等你定」', () => {
  it('列待处理发现时有自己的名称，不出现 undefined', () => {
    const result = {
      kind: 'single', layer: 'global', findings: [],
      pendingDecisions: { created: 0, existing: 1, items: [{ id: 'pd_x', kind: 'important-pending', memoryIds: ['mem_old', 'mem_new'], workspaces: ['global', 'global'], summary: '包管理器的说法对不上', isNew: false }] },
      stats: { scanned: 2, clean: 0, issues: 1, byType: {} }, ignoredCount: 0, promoteCandidates: { items: [], more: 0 },
      semanticCachedAt: null, notes: [], directoryNotes: [], message: '体检完成',
    } as unknown as SingleScanResult
    const text = renderScanResult(result)
    expect(text).toContain('[pd_x]')
    expect(text).not.toContain('undefined')
  })
})

describe('运行计划和配置', () => {
  it('计划按顺序：维护、整理主题索引、合并零碎记忆、处理矛盾、逐条整理', () => {
    const tidy = { store, maxTopics: () => 30, now: () => NOW, typeRecall: () => 'search' as const }
    const plan = dreamsPlan({ tidy, merge: { store, dreams }, resolve: tierDeps() })
    expect(plan.map(s => s.name)).toEqual(['maintain', 'organize-index', 'merge-fragments', 'resolve-findings', 'tidy-memories'])
  })

  it('档位和重点类型的缺省值；写了的值原样读出', () => {
    const defaults = new Config({} as never).brewingDreams
    expect(defaults.tier.get()).toBe('gatekeep')
    expect(defaults.focusTypes.get()).toEqual(['preference', 'profile', 'decision'])
    const set = new Config({ brewingDreams: { tier: 'trust', focusTypes: ['knowledge'] } } as never).brewingDreams
    expect(set.tier.get()).toBe('trust')
    expect(set.focusTypes.get()).toEqual(['knowledge'])
    // 不认识的档位字符串照样读得出（按把关档跑、记告警由运行侧负责）
    expect(new Config({ brewingDreams: { tier: 'aggressive' } } as never).brewingDreams.tier.get()).toBe('aggressive')
  })
})

describe('用户操作落在随机时刻', () => {
  // 种子：缺省固定（helpers/interleave.ts），PM_INTERLEAVE_SEED 覆盖；轮数缺省 60，PM_INTERLEAVE_RUNS 覆盖
  const RUNS = interleaveRuns(60)
  const ACTIONS = ['none', 'keep-left', 'keep-right', 'dismiss', 'edit-old', 'edit-new', 'lock-old', 'lock-new', 'undo', 're-report'] as const
  type Action = typeof ACTIONS[number]

  it('梦境处理一对时用户裁决、手改、上锁、撤销或体检重报：两边不会都算数，用户写成的不被盖掉，账本不留两份', async () => {
    await teardown()
    try {
      await fc.assert(fc.asyncProperty(
        fc.constantFrom(...ACTIONS), fc.integer({ min: 0, max: 6 }), fc.boolean(),
        async (action: Action, point, isImportant) => {
          await setup()
          try {
            const [old, neu] = await npmPair(isImportant ? { old: { type: 'decision', mode: 'user-explicit' } } : {})
            const entry = await report([old, neu])
            // 落点：0 是调模型期间；k 是拿到回复之后第 k 个最外层写入段开始之前
            let acted = false
            let isLanded = false
            let isDoneBefore = false
            const act = async () => {
              acted = true
              isDoneBefore = (await get('mem_old')).status === 'deleted'
              switch (action) {
                case 'none': return
                case 'keep-left': case 'keep-right': case 'dismiss':
                  isLanded = (await confirm(entry.id, action)).kind === 'resolved'
                  return
                case 'edit-old': case 'edit-new':
                  isLanded = (await store.updateIfLive({ id: action === 'edit-old' ? 'mem_old' : 'mem_new' }, cur => ({ ...cur, content: `用户改的${action}`, updatedAt: NOW + 5 }))) !== undefined
                  return
                case 'lock-old': case 'lock-new':
                  isLanded = (await store.updateIfLive({ id: action === 'lock-old' ? 'mem_old' : 'mem_new' }, cur => ({ ...cur, locked: true }))) !== undefined
                  return
                case 'undo':
                  isLanded = (await undo('run_1')).kind === 'undone'
                  return
                case 're-report':
                  if (isDoneBefore) return
                  await report([await get('mem_old'), await get('mem_new')])
                  isLanded = true
              }
            }
            const section = store.writeSection.bind(store)
            let depth = 0
            let count = 0
            store.writeSection = async <T>(fn: () => Promise<T>): Promise<T> => {
              if (depth === 0 && prompts.length > 0 && !acted && ++count === point) await act()
              depth++
              try { return await section(fn) } finally { depth-- }
            }
            reply = async (user) => {
              if (point === 0) await act()
              return confident()(user)
            }
            await runRaw()
            store.writeSection = section

            const [o, n] = [await get('mem_old'), await get('mem_new')]
            const isWritten = mergedIntoOf(o)?.as === 'version'
            const results = (await settledEntry('run_1'))?.dreamsResults ?? []
            const open = await openOf('mem_old', 'mem_new')
            const isVerdict = ['keep-left', 'keep-right', 'dismiss'].includes(action) && isLanded
            const isInterfering = isLanded && !isDoneBefore && action !== 'none'
            // 并成版本只会是完整的一步：旧的软删、指向新的
            if (isWritten) {
              expect(o.status).toBe('deleted')
              expect(mergedIntoOf(o)).toEqual({ id: 'mem_new', scopeKey: 'global', as: 'version', endedAt: expect.any(Number) })
              expect(open).toEqual([])
              expect(results).toHaveLength(1)
            }
            expect(open.length).toBeLessThanOrEqual(1)
            // 重要的一对在把关档从不直接写
            if (isImportant) expect(isWritten).toBe(false)
            // 用户的裁决和梦境的处理不会都算数
            if (isVerdict) {
              expect(isWritten).toBe(false)
              expect(results).toEqual([])
              expect((await settledEntry(entry.id))!.settled?.verdict).toBe(action)
            }
            // 梦境写之前用户写成的改动、上的锁、撤销：梦境之后不写，用户的改动原样
            if (isInterfering && action !== 're-report') expect(isWritten).toBe(false)
            if (isLanded && action === 'edit-old') expect(o).toMatchObject({ status: 'active', content: '用户改的edit-old' })
            if (isLanded && action === 'edit-new') expect(n.content).toBe('用户改的edit-new')
            if (isLanded && action === 'undo') expect(o.status).toBe('active')
            // 没被打扰：照常处理（不重要的直接并成版本，重要的改成「重要、等你定」）
            if (!acted || action === 'none') {
              if (isImportant) expect(kindOf((await openEntry(entry.id))!)).toBe('important-pending')
              else expect(isWritten).toBe(true)
            }
          } finally {
            await teardown()
          }
        },
      ), { seed: interleaveSeed(), numRuns: RUNS })
    } finally {
      await setup()
    }
  }, Math.max(60_000, RUNS * 2_000))
})
