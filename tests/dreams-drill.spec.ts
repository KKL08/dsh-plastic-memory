import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileTable } from '../src/storage/file-table.ts'
import { OpJournal } from '../src/storage/op-journal.ts'
import { createRootLock } from '../src/storage/root-lock.ts'
import { NoReviewList } from '../src/storage/no-review.ts'
import type { DreamMarks, DreamsRecord, RecallStats } from '../src/storage/schema.ts'
import { RECOVERED_VERSION, layerOf } from '../src/storage/history.ts'
import { HISTORY_DIR, STATE_DIR } from '../src/storage/paths.ts'
import { MemoryStore } from '../src/store.ts'
import { PendingDecisionsStore } from '../src/governance/decisions.ts'
import { SnapshotStore } from '../src/governance/snapshots.ts'
import { ledgerSteps } from '../src/governance/op-steps.ts'
import type { MemorySnapshot, PendingDecision } from '../src/governance/schema.ts'
import type { SemanticLlm } from '../src/governance/semantic-scan.ts'
import { DREAMS_DEFAULTS } from '../src/governance/dreams-gate.ts'
import { DreamsStore } from '../src/governance/dreams-records.ts'
import { undoRuleOf } from '../src/governance/undo-rules.ts'
import {
  DRILL_CANDIDATES_MAX, DRILL_FILL_SYSTEM_PROMPT, DRILL_FIND_HITS, DRILL_READ_MAX_CHARS, DRILL_REQUEST_SYSTEM_PROMPT, DRILL_WINDOW_MESSAGES,
  drillAnchorKey, newDrillLog, type DrillAnchor, type DrillRequest,
} from '../src/governance/drill-down.ts'
import type { Scope } from '../src/scope.ts'
import { DIALOGUE_QUOTE_TAG } from '../src/search/dialogue-format.ts'
import { maintainStep, runDreams, type DreamsRunDeps, type DreamsStep } from '../src/tools/dreams-run.ts'
import { drillDownStep, drillRead, type DrillSourceDeps } from '../src/tools/dreams-drill.ts'
import { executeUndo } from '../src/tools/undo.ts'
import type { HostSession, HostSessionEntry } from '../src/tools/host-session.ts'
import type { RawEvent, SessionLog } from '../src/session-log.ts'
import type { MemoryRecord, SourceAnchor } from '../src/record-schema.ts'
import { InMemoryBatchKvTable, InMemoryKvTable } from './helpers/in-memory-kv.ts'
import { interleaveRuns, interleaveSeed } from './helpers/interleave.ts'
import { record } from './helpers/record.ts'
import { messageFrom } from './helpers/session-log.ts'
import { FAKE_SECRET } from './helpers/secrets.ts'

// 记忆梦境整理中的下钻补全。真文件、真操作日志、真写锁、真「不回看」清单；宿主会话和模型是边界上的替身。

const quiet = { info() {}, warn() {}, error() {} }
/** 运行里被收成出错的异常：桩上抛的「未实现」原样抛出来，失败原因一眼看得出。 */
let runErrors: unknown[] = []
const runLog = { info() {}, error() {}, warn(_message: string, err?: unknown) { if (err !== undefined) runErrors.push(err) } }
const GLOBAL = { kind: 'global' } as const
/** 项目范围（会话里的项目路径和它一致才看得见）。 */
const W: Scope = { kind: 'workspace', workspacePath: '/proj/a' }
/** 疑似级密钥（库里的疑似密钥是用户确认放行的）：遮盖、拦截都要连它一起管。 */
const SUSPECTED = 'password=Abc12345xyz'
const SUSPECTED_VALUE = 'Abc12345xyz'
const NOW = 1_800_000_000_000
/** 会话里的事件时刻：一个固定的过去时刻，不是今天。 */
const T0 = Date.UTC(2025, 2, 1, 2, 0)
const sec = (n: number) => T0 + n * 1000

// ---- 会话日志的替身（宿主边界） ----
const turn = (seq: number, time: number): RawEvent => ({ type: 'turn/start', seq, time })
const user = (seq: number, text: string, time: number): RawEvent => messageFrom('user', seq, text, time)
const assistant = (seq: number, text: string, time: number): RawEvent => ({ type: 'assistant/message', seq, time, data: { message: { content: [{ type: 'text', text }] } } })
const tool = (seq: number, text: string, time: number): RawEvent => ({ type: 'tool/result', seq, time, data: { message: { content: [{ type: 'text', text }] } } })
const logOf = (events: RawEvent[]): SessionLog => ({ header: { isSeeded: false }, inheritedEventCount: 0, events })

const USER_REASON = '改用 pnpm，因为 CI 里缓存快、装得快'
const ASSISTANT_REPLY = '好的，那我把 lockfile 换掉'
const TOOL_OUTPUT = `pnpm 9.1.0 token=${FAKE_SECRET.sk}`
const USER_PAST = '去年三月我们还在用 npm 装依赖'
/** s1：第一轮说了改用 pnpm 的原因（助手回话、工具结果各一条），第二轮说了过去的状态。 */
const S1 = () => logOf([
  turn(0, sec(0)), user(1, USER_REASON, sec(1)), assistant(2, ASSISTANT_REPLY, sec(2)), tool(3, TOOL_OUTPUT, sec(3)),
  turn(4, sec(10)), user(5, USER_PAST, sec(11)), assistant(6, '明白', sec(12)),
])

// ---- 宿主替身 ----
let sessions: Map<string, SessionLog>
/** 宿主会话列表里有的会话；null 是列不出。 */
let listed: Set<string> | null
/** 宿主登记为已存档的会话；null 是读不出。 */
let archived: Set<string> | null
/** 在列表里、但日志读不出的会话。 */
let logFails: Set<string>
let readCalls: string[]
/** 宿主会话列表被列了几次。 */
let listCalls: number
const host: Pick<HostSession, 'readSessionLog' | 'listSessions' | 'archivedSessionIds'> = {
  readSessionLog: async (id: string) => {
    readCalls.push(id)
    return logFails.has(id) ? null : sessions.get(id) ?? null
  },
  listSessions: async () => (listCalls++, listed === null ? null : [...listed].map((id): HostSessionEntry => ({ id, cwd: undefined, isSubagent: false, isLive: false }))),
  archivedSessionIds: async () => (archived === null ? null : new Set(archived)),
}

// ---- 模型替身：按系统提示词分两段，按次取回复 ----
type Reply = unknown | (() => unknown | Promise<unknown>)
let requestReplies: Reply[]
let fillReplies: Reply[]
let requestPrompts: string[]
let fillPrompts: string[]
const reply = async (queue: Reply[]): Promise<string> => {
  const next = queue.shift()
  const value = typeof next === 'function' ? await (next as () => unknown)() : next
  return typeof value === 'string' ? value : JSON.stringify(value ?? { requests: [] })
}
const llm: SemanticLlm = {
  model: 'stub',
  complete: async (prompt, _signal, onUsage) => {
    onUsage?.(10)
    if (prompt.system === DRILL_REQUEST_SYSTEM_PROMPT) {
      requestPrompts.push(prompt.user)
      return reply(requestReplies)
    }
    if (prompt.system === DRILL_FILL_SYSTEM_PROMPT) {
      fillPrompts.push(prompt.user)
      return reply(fillReplies.length > 0 ? fillReplies : [{ result: 'none' }])
    }
    return '{}'
  },
}

let root: string
let lock: ReturnType<typeof createRootLock>
let journal: OpJournal
let store: MemoryStore
let decisions: PendingDecisionsStore
let snapshots: SnapshotStore
let dreams: DreamsStore
let noReview: NoReviewList
let maxDrills: unknown
let runSeq = 0
/** 运行计划里排在下钻之前的步骤（缺省没有）。 */
let beforeDrill: DreamsStep[]
/** 改动量上限的比例（缺省放开）。 */
let changeRatio: number
/** 活动表报这个范围有会话在跑（梦境要让路）。 */
let isBusy: boolean
/** 运行里的定时检查（让路）：叫停时现跑一次。 */
let polls: Array<() => void>

async function setup() {
  root = await mkdtemp(join(tmpdir(), 'pm-dreams-drill-'))
  journal = new OpJournal({ path: join(root, '.state', 'op-journal.sqlite'), log: quiet })
  lock = createRootLock({ root, log: quiet })
  const stats = new InMemoryBatchKvTable<RecallStats>()
  decisions = new PendingDecisionsStore(new InMemoryKvTable<PendingDecision>(), lock)
  snapshots = new SnapshotStore(new InMemoryKvTable<MemorySnapshot>())
  dreams = new DreamsStore(new InMemoryKvTable<DreamsRecord>(), new InMemoryKvTable<DreamMarks>())
  store = new MemoryStore(new FileTable({ root, stats, log: quiet, lock, journal, now: () => NOW }), quiet, stats)
  store.registerSteps(ledgerSteps(decisions, quiet))
  noReview = new NoReviewList(root)
  sessions = new Map([['s1', S1()]])
  listed = new Set(['s1'])
  archived = new Set()
  logFails = new Set()
  readCalls = []
  listCalls = 0
  beforeDrill = []
  changeRatio = 1
  isBusy = false
  polls = []
  requestReplies = []
  fillReplies = []
  requestPrompts = []
  fillPrompts = []
  maxDrills = 5
  runSeq = 0
}
async function teardown() {
  journal.close()
  await rm(root, { recursive: true, force: true })
}
beforeEach(setup)
afterEach(teardown)

const step = () => drillDownStep({ store, decisions, host, noReview, maxDrillDowns: () => maxDrills, now: () => NOW })
function deps(): DreamsRunDeps {
  const claims = new InMemoryKvTable<{ id: string }>()
  return {
    store, snapshots, decisions, dreams, log: runLog,
    claimScope: async (scope) => {
      const release = await claims.claim(scope.kind === 'global' ? 'global' : scope.workspacePath)
      return release === undefined ? { busy: scope } : { release }
    },
    activity: async () => ({ isComplete: !isBusy, workspaces: new Map() }),
    resolveLlm: async () => ({ llm, isSelected: true, fellBack: false }),
    config: () => ({ ...DREAMS_DEFAULTS, minChanges: 0, maxChangeRatio: changeRatio }),
    isGovernanceEnabled: () => true,
    plan: [maintainStep(store), ...beforeDrill, step()],
    interval: (callback) => {
      polls.push(callback)
      return () => { polls.splice(polls.indexOf(callback), 1) }
    },
    now: () => NOW,
    newRunId: () => `run_${++runSeq}`,
  }
}
async function dream(scope: Scope = GLOBAL) {
  runErrors = []
  const r = await runDreams(scope, { by: 'manual' }, deps())
  const missing = runErrors.find(e => e instanceof Error && e.message.startsWith('未实现'))
  if (missing !== undefined) throw missing
  return r
}

const anchor = (sessionId: string, eventRange: [number, number], at: number, extra: Partial<SourceAnchor> = {}): SourceAnchor =>
  ({ sessionId, eventRange, sourceMode: 'user-explicit', at, change: 'refine', ...extra })
/** 决定：只说了改用 pnpm，没写依据和没选的方案；出处是 s1 的第一轮。 */
const DECISION = { id: 'mem_d', type: 'decision', name: '包管理器', content: '项目改用 pnpm。', summary: '用 pnpm' }
/** 状态页：现在用 pnpm；出处是 s1 的两轮。 */
const PAGE = { id: 'mem_p', type: 'project', name: '包管理现状', content: '现在用 pnpm', summary: '用 pnpm', factTime: '2025-09' }

async function seed(rows: Array<Partial<MemoryRecord>>, scope: Scope = GLOBAL): Promise<MemoryRecord[]> {
  const out: MemoryRecord[] = []
  const at = scope.kind === 'workspace' ? { scope: 'workspace' as const, workspacePath: scope.workspacePath } : {}
  for (const row of rows) {
    const trail = row.sourceTrail ?? [anchor('s1', [0, 3], sec(0))]
    const first = trail[0]!
    const rec = record({ createdAt: NOW, updatedAt: NOW, lastConfirmedAt: NOW, tags: [], ...at, ...row, sourceTrail: trail, source: { sessionId: first.sessionId, eventRange: first.eventRange, sourceMode: 'user-explicit' } })
    await store.create(rec)
    out.push((await store.get(rec.id, scope))!)
  }
  await store.maintain(scope)
  return out
}
const get = async (id: string) => (await store.get(id, GLOBAL))!
const located = async (id: string, scope: Scope = GLOBAL) => (await store.locate(id, scope))!
const versionsOf = async (id: string, scope: Scope = GLOBAL) => (await store.history.list(layerOf(await located(id, scope)), id)).versions
const entryOf = async (id: string) => (await decisions.listSettled()).find(d => d.id === id)
const lastResult = async (key = 'global') => (await dreams.read()).records.get(key)?.lastResult
const skippedOf = async (key = 'global') => (await lastResult(key))?.skipped?.items ?? []
const undo = (decisionId: string, op?: string, context: { workspacePath: string | undefined } = { workspacePath: undefined }, allowCrossWorkspace?: boolean) => executeUndo(
  { decisionId, ...(op !== undefined ? { op } : {}), ...(allowCrossWorkspace !== undefined ? { allowCrossWorkspace } : {}) }, context,
  { store, decisions, snapshots, dreams, log: quiet, ignores: { unignoreIfSame: async () => false }, now: () => NOW },
)
/** 第 i 次请求阶段交给模型的候选（提示词里第一个 [ 起是 JSON 数组）。 */
const requestRows = (i = 0) => JSON.parse(requestPrompts[i]!.slice(requestPrompts[i]!.indexOf('['))) as Array<{ id: string; gaps: string[] }>
/** 叫停：活动表报这个范围有会话在跑，现跑一次定时检查，等它记下（检查只走微任务，下一个宏任务时已经记下）。 */
async function yieldNow() {
  isBusy = true
  for (const poll of polls) poll()
  await new Promise(resolve => setImmediate(resolve))
}
/** 召回统计、提交标记之外的内容。 */
const stable = ({ lastWriteOp: _op, recallCount: _c, lastRecalledAt: _a, ...rest }: MemoryRecord) => rest

const REFINED = '项目改用 pnpm。依据：CI 里缓存快、装得快。'
const requestOf = (id: string, gap: string, extra: Record<string, unknown> = {}) => ({ id, gap, anchor: 1, purpose: 'fill-gap', ...extra })
/** 细化：依据是 s1 第一轮用户那句（编号 1）。 */
const REFINE_FROM_USER = { result: 'refine', content: REFINED, evidence: [1] }
/** 补回：依据是 s1 第二轮用户那句（开窗 [0,6] 时编号 4）。 */
const RECOVER_FROM_USER = { result: 'recover', content: '用 npm', summary: '那时用 npm', factTime: '2024-03', reason: '后来换成 pnpm', evidence: [4] }

describe('补缺口：依据是用户原话的直接写', () => {
  it('决定缺依据：读锚指向的那一段，按用户原话细化正文；回执和报告记在这次运行的批次条目上', async () => {
    await seed([DECISION])
    requestReplies = [{ requests: [requestOf('mem_d', 'missing-basis')] }]
    fillReplies = [REFINE_FROM_USER]
    expect((await dream()).kind).toBe('completed')
    expect(await get('mem_d')).toMatchObject({ content: REFINED, status: 'active', lastChange: { by: 'dreams', kind: 'refine' } })
    const entry = (await entryOf('run_1'))!
    expect(entry.changes!.map(c => [c.kind, c.memoryId])).toEqual([['edit', 'mem_d']])
    expect(entry.drillDown).toEqual({
      drills: 1, archivedSessionsRead: 0, unreadable: [], proposals: [],
      filled: [{ memoryId: 'mem_d', gap: 'missing-basis', kind: 'refine', opId: entry.changes![0]!.id, excerpts: [{ sessionId: 's1', seq: 1, speaker: 'user', text: USER_REASON }] }],
    })
    expect(readCalls).toEqual(['s1'])
  })

  it('请求阶段：代码标出的缺口交给模型；补写阶段：原对话原样（不遮盖）包在引用标签里、带编号', async () => {
    await seed([DECISION])
    requestReplies = [{ requests: [requestOf('mem_d', 'missing-basis')] }]
    fillReplies = [REFINE_FROM_USER]
    await dream()
    expect(requestPrompts).toHaveLength(1)
    expect(requestPrompts[0]).toContain('mem_d')
    expect(requestPrompts[0]).toContain('missing-basis')
    expect(requestPrompts[0]).toContain('missing-alternatives')
    expect(fillPrompts).toHaveLength(1)
    const fill = fillPrompts[0]!
    expect(fill).toContain(`<${DIALOGUE_QUOTE_TAG}>`)
    expect(fill).toContain(`[#1] `)
    for (const text of [USER_REASON, ASSISTANT_REPLY, TOOL_OUTPUT]) expect(fill).toContain(text)
    expect(fill).toContain(FAKE_SECRET.sk)
    // 只读锚的那一段：第二轮不在里面
    expect(fill).not.toContain(USER_PAST)
  })

  it('状态页补回过去的状态：写成这条记忆名下的 recovered 历史版本，记忆文件不动；回执记版本标识', async () => {
    const [page] = await seed([{ ...PAGE, sourceTrail: [anchor('s1', [0, 6], sec(0))] }])
    requestReplies = [{ requests: [requestOf('mem_p', 'fact-gap')] }]
    fillReplies = [RECOVER_FROM_USER]
    expect((await dream()).kind).toBe('completed')
    expect(stable(await get('mem_p'))).toEqual(stable(page!))
    const versions = await versionsOf('mem_p')
    expect(versions).toHaveLength(1)
    const v = versions[0]!
    expect(v).toMatchObject({ kind: RECOVERED_VERSION, startedAt: sec(11), endedAt: sec(11) })
    expect(v.record).toMatchObject({ id: 'mem_p', content: '用 npm', summary: '那时用 npm', factTime: '2024-03', sourceTrail: [{ sessionId: 's1', eventRange: [5, 5], at: sec(11), by: 'dreams', change: 'state-change' }] })
    expect(v.writes[0]!.reason).toBe('后来换成 pnpm')
    const entry = (await entryOf('run_1'))!
    expect(entry.changes ?? []).toEqual([])
    expect(entry.recoveredVersions).toEqual([{ op: v.writes[0]!.op, memoryId: 'mem_p', scopeKey: 'global', versionId: v.versionId, at: NOW }])
    expect(entry.drillDown!.filled).toEqual([{ memoryId: 'mem_p', gap: 'fact-gap', kind: 'recovered', opId: v.writes[0]!.op, excerpts: [{ sessionId: 's1', seq: 5, speaker: 'user', text: USER_PAST }] }])
    // 撤销入口认得这条只有补回版本的条目
    expect(undoRuleOf(entry as Parameters<typeof undoRuleOf>[0]).targets).toEqual(['mem_p'])
    // 没有改记忆文件：条目的概述保留建条目时的原值，不写「整理 0 条」
    expect(entry.summary).toBe('记忆梦境')
  })

  it('同一次运行里细化和补回各写各的；操作 id 按运行 id 编号、互不相同', async () => {
    await seed([DECISION, { ...PAGE, sourceTrail: [anchor('s1', [0, 6], sec(0))] }])
    requestReplies = [{ requests: [requestOf('mem_d', 'missing-basis'), requestOf('mem_p', 'fact-gap')] }]
    fillReplies = [REFINE_FROM_USER, RECOVER_FROM_USER]
    expect((await dream()).kind).toBe('completed')
    const entry = (await entryOf('run_1'))!
    const ops = [entry.changes![0]!.id, entry.recoveredVersions![0]!.op]
    expect(new Set(ops).size).toBe(2)
    for (const op of ops) expect(op.startsWith('run_1:drill:')).toBe(true)
    expect(entry.drillDown!.drills).toBe(2)
  })
})

describe('推断的交给用户', () => {
  it('依据里有助手的话或工具结果：不写，稿和依据节选进报告（已遮盖）', async () => {
    const [d] = await seed([DECISION])
    requestReplies = [{ requests: [requestOf('mem_d', 'missing-basis')] }]
    fillReplies = [{ result: 'refine', content: `${REFINED}版本见 ${FAKE_SECRET.sk}`, evidence: [1, 3] }]
    expect((await dream()).kind).toBe('completed')
    expect(stable(await get('mem_d'))).toEqual(stable(d!))
    const entry = (await entryOf('run_1'))!
    expect(entry.changes ?? []).toEqual([])
    const [proposal] = entry.drillDown!.proposals
    expect(proposal).toMatchObject({ memoryId: 'mem_d', gap: 'missing-basis', kind: 'refine' })
    expect(proposal!.content).not.toContain(FAKE_SECRET.sk)
    expect(proposal!.excerpts.map(e => [e.seq, e.speaker])).toEqual([[1, 'user'], [3, 'tool']])
    expect(JSON.stringify(proposal!.excerpts)).not.toContain(FAKE_SECRET.sk)
    expect(entry.drillDown!.filled).toEqual([])
  })

  it('没给依据：交给用户；引用了没读到的编号：拒收，不写也不交给用户', async () => {
    await seed([DECISION, { ...PAGE, sourceTrail: [anchor('s1', [0, 6], sec(0))] }])
    requestReplies = [{ requests: [requestOf('mem_d', 'missing-basis'), requestOf('mem_p', 'fact-gap')] }]
    fillReplies = [{ result: 'refine', content: REFINED }, { ...RECOVER_FROM_USER, evidence: [4, 99] }]
    expect((await dream()).kind).toBe('completed')
    const entry = (await entryOf('run_1'))!
    expect(entry.drillDown!.proposals.map(p => p.memoryId)).toEqual(['mem_d'])
    expect(await versionsOf('mem_p')).toEqual([])
    expect(await skippedOf()).toContainEqual(expect.objectContaining({ target: 'mem_p', reason: 'unknown-ref' }))
  })

  it('模型说补不上、回复读不出：这处不补，不写', async () => {
    const [d, p] = await seed([DECISION, { ...PAGE, sourceTrail: [anchor('s1', [0, 6], sec(0))] }])
    requestReplies = [{ requests: [requestOf('mem_d', 'missing-basis'), requestOf('mem_p', 'fact-gap')] }]
    fillReplies = [{ result: 'none' }, '补不上', '还是补不上']
    expect((await dream()).kind).toBe('completed')
    // 两处都读了、都问了（第二处读不出的回复重问了一次）
    expect(fillPrompts).toHaveLength(3)
    expect(stable(await get('mem_d'))).toEqual(stable(d!))
    expect(stable(await get('mem_p'))).toEqual(stable(p!))
    expect(await versionsOf('mem_p')).toEqual([])
  })
})

describe('写入时的密钥拦截照常', () => {
  it('细化稿把会话里的疑似密钥带进正文：不写', async () => {
    const [d] = await seed([DECISION])
    sessions.set('s1', logOf([turn(0, sec(0)), user(1, `改用 pnpm，registry token 是 ${FAKE_SECRET.github}`, sec(1))]))
    requestReplies = [{ requests: [requestOf('mem_d', 'missing-basis')] }]
    fillReplies = [{ result: 'refine', content: `项目改用 pnpm。依据：token ${FAKE_SECRET.github}`, evidence: [1] }]
    await dream()
    // 交给模型的原文不遮盖
    expect(fillPrompts[0]).toContain(FAKE_SECRET.github)
    expect(stable(await get('mem_d'))).toEqual(stable(d!))
    expect((await entryOf('run_1'))?.changes ?? []).toEqual([])
  })

  it('补回版本带疑似密钥：不写版本、不记回执', async () => {
    await seed([{ ...PAGE, sourceTrail: [anchor('s1', [0, 6], sec(0))] }])
    requestReplies = [{ requests: [requestOf('mem_p', 'fact-gap')] }]
    fillReplies = [{ ...RECOVER_FROM_USER, content: `用 npm，token ${FAKE_SECRET.sk}` }]
    await dream()
    expect(await versionsOf('mem_p')).toEqual([])
    expect((await entryOf('run_1'))?.recoveredVersions ?? []).toEqual([])
    expect(await skippedOf()).toContainEqual(expect.objectContaining({ kind: 'recover-version', target: 'mem_p', reason: 'has-secret' }))
  })
})

describe('请求的核对（经整次运行）', () => {
  it('锚不属于这条记忆、不是交给模型的候选：不读，记进跳过清单', async () => {
    await seed([DECISION])
    requestReplies = [{ requests: [
      requestOf('mem_d', 'missing-basis', { anchor: 2 }),
      requestOf('mem_zz', 'missing-basis'),
    ] }]
    await dream()
    expect(requestPrompts).toHaveLength(1)
    expect(readCalls).toEqual([])
    expect(fillPrompts).toEqual([])
    const skipped = await skippedOf()
    expect(skipped).toContainEqual(expect.objectContaining({ target: 'mem_d', reason: 'anchor-not-owned' }))
    expect(skipped).toContainEqual(expect.objectContaining({ target: 'mem_zz', reason: 'unknown-memory' }))
  })

  it('核实矛盾不在这一步做：拒绝，不读', async () => {
    await seed([DECISION])
    requestReplies = [{ requests: [requestOf('mem_d', 'missing-basis', { purpose: 'verify-conflict' })] }]
    await dream()
    expect(requestPrompts).toHaveLength(1)
    expect(readCalls).toEqual([])
    expect(await skippedOf()).toContainEqual(expect.objectContaining({ target: 'mem_d', reason: 'purpose-elsewhere' }))
  })

  it('历史版本的锚也属于这条记忆：编号接在当前出处后面', async () => {
    const [d] = await seed([{ ...DECISION, sourceTrail: [anchor('s2', [0, 1], sec(100))] }])
    sessions.set('s2', logOf([turn(0, sec(100)), user(1, '记一下', sec(101))]))
    listed = new Set(['s1', 's2'])
    await store.history.write(layerOf(await located('mem_d')), {
      versionId: 'v-early', record: { ...d!, sourceTrail: [anchor('s1', [0, 3], sec(0))], source: { sessionId: 's1', eventRange: [0, 3], sourceMode: 'user-explicit' } }, extras: {}, startedAt: sec(0), endedAt: sec(50), kind: 'state-change', writes: [],
    })
    requestReplies = [{ requests: [requestOf('mem_d', 'missing-basis', { anchor: 2 })] }]
    fillReplies = [REFINE_FROM_USER]
    await dream()
    expect(readCalls).toEqual(['s1'])
    expect((await get('mem_d')).content).toBe(REFINED)
  })

  it('按关键词找：读整个会话里含关键词的消息（不分大小写），不开窗', async () => {
    await seed([DECISION])
    requestReplies = [{ requests: [requestOf('mem_d', 'missing-basis', { query: '用 NPM' })] }]
    fillReplies = [{ result: 'none' }]
    await dream()
    expect(fillPrompts[0]).toContain(USER_PAST)
    expect(fillPrompts[0]).not.toContain(USER_REASON)
  })

  it(`按关键词找最多给 ${DRILL_FIND_HITS} 条`, async () => {
    await seed([DECISION])
    const many = Array.from({ length: DRILL_FIND_HITS + 3 }, (_, i) => user(i + 1, `命中-${String(i).padStart(2, '0')}`, sec(i + 1)))
    sessions.set('s1', logOf([turn(0, sec(0)), ...many]))
    requestReplies = [{ requests: [requestOf('mem_d', 'missing-basis', { query: '命中' })] }]
    fillReplies = [{ result: 'none' }]
    await dream()
    expect(fillPrompts[0]!.match(/命中-\d\d/g)).toHaveLength(DRILL_FIND_HITS)
  })
})

describe('下钻上限', () => {
  it('名额用完的请求不读、记进跳过清单；这条下次运行再提', async () => {
    maxDrills = 1
    await seed([DECISION, { ...PAGE, sourceTrail: [anchor('s1', [0, 6], sec(0))] }])
    requestReplies = [{ requests: [requestOf('mem_d', 'missing-basis'), requestOf('mem_p', 'fact-gap')] }]
    fillReplies = [REFINE_FROM_USER]
    await dream()
    expect(readCalls).toEqual(['s1'])
    expect((await entryOf('run_1'))!.drillDown!.drills).toBe(1)
    expect(await skippedOf()).toContainEqual(expect.objectContaining({ target: 'mem_p', reason: 'over-limit' }))
    requestReplies = []
    await dream()
    expect(requestPrompts).toHaveLength(2)
    expect(requestPrompts[1]).toContain('mem_p')
    // 补完的那条是梦境自己改的，不算上次以来的变化
    expect(requestPrompts[1]).not.toContain('mem_d')
  })

  it('上限是 0：这一步不调模型、不读会话', async () => {
    maxDrills = 0
    await seed([DECISION])
    expect((await dream()).kind).toBe('completed')
    expect(requestPrompts).toEqual([])
    expect(readCalls).toEqual([])
  })

  it('上限写坏了按缺省（5）', async () => {
    maxDrills = -3
    await seed([DECISION])
    requestReplies = [{ requests: [requestOf('mem_d', 'missing-basis')] }]
    fillReplies = [REFINE_FROM_USER]
    await dream()
    expect(readCalls).toEqual(['s1'])
  })

  it('没读到会话日志的不占名额', async () => {
    maxDrills = 1
    await seed([{ ...DECISION, sourceTrail: [anchor('s_gone', [0, 3], sec(0))] }, { ...PAGE, sourceTrail: [anchor('s1', [0, 6], sec(0))] }])
    requestReplies = [{ requests: [requestOf('mem_d', 'missing-basis'), requestOf('mem_p', 'fact-gap')] }]
    fillReplies = [RECOVER_FROM_USER]
    await dream()
    expect((await versionsOf('mem_p'))).toHaveLength(1)
    expect((await entryOf('run_1'))!.drillDown!.drills).toBe(1)
  })
})

describe('读不到的锚', () => {
  it('会话不在宿主的会话列表里：列进报告，不读日志', async () => {
    await seed([{ ...DECISION, sourceTrail: [anchor('s_gone', [0, 3], sec(0))] }])
    requestReplies = [{ requests: [requestOf('mem_d', 'missing-basis')] }]
    await dream()
    expect(readCalls).toEqual([])
    expect((await entryOf('run_1'))!.drillDown).toEqual({
      drills: 0, archivedSessionsRead: 0, filled: [], proposals: [],
      unreadable: [{ memoryId: 'mem_d', sessionId: 's_gone', eventRange: [0, 3], at: sec(0), reason: 'session-gone' }],
    })
  })

  it('标了不回看的会话：列进报告，不读日志', async () => {
    await seed([DECISION])
    await noReview.mark('s1', NOW)
    requestReplies = [{ requests: [requestOf('mem_d', 'missing-basis')] }]
    await dream()
    expect(readCalls).toEqual([])
    expect((await entryOf('run_1'))!.drillDown!.unreadable).toEqual([{ memoryId: 'mem_d', sessionId: 's1', eventRange: [0, 3], at: sec(0), reason: 'no-review' }])
  })

  it('锚失效（序号对不上、按时间也找不回）：列进报告', async () => {
    // 锚的时间早于会话里的每一轮
    await seed([{ ...DECISION, sourceTrail: [anchor('s1', [20, 23], T0 - 60_000)] }])
    requestReplies = [{ requests: [requestOf('mem_d', 'missing-basis')] }]
    await dream()
    expect(fillPrompts).toEqual([])
    expect((await entryOf('run_1'))!.drillDown!.unreadable).toEqual([{ memoryId: 'mem_d', sessionId: 's1', eventRange: [20, 23], at: T0 - 60_000, reason: 'anchor-lost' }])
  })

  it('锚那一段没有可读的消息：列进报告', async () => {
    await seed([{ ...DECISION, sourceTrail: [anchor('s1', [0, 0], sec(0))] }])
    requestReplies = [{ requests: [requestOf('mem_d', 'missing-basis')] }]
    await dream()
    expect(fillPrompts).toEqual([])
    expect((await entryOf('run_1'))!.drillDown!.unreadable.map(u => u.reason)).toEqual(['empty'])
  })

  it('序号对不上、时间对得上别的一轮：按时间重新定位，整段平移', async () => {
    // 会话前面多了一轮：原来的 [0,3] 现在在 [5,8]；seq 0 起那一段的时间和锚对不上
    sessions.set('s1', logOf([
      turn(0, sec(-20)), user(1, '更早的一轮', sec(-19)), assistant(2, '更早的回答', sec(-18)), tool(3, '更早的工具结果', sec(-17)), assistant(4, '更早的收尾', sec(-16)),
      turn(5, sec(0)), user(6, USER_REASON, sec(1)), assistant(7, ASSISTANT_REPLY, sec(2)), tool(8, TOOL_OUTPUT, sec(3)),
      turn(9, sec(10)), user(10, USER_PAST, sec(11)),
    ]))
    await seed([DECISION])
    requestReplies = [{ requests: [requestOf('mem_d', 'missing-basis')] }]
    fillReplies = [{ result: 'none' }]
    await dream()
    expect(fillPrompts[0]).toContain(USER_REASON)
    expect(fillPrompts[0]).not.toContain('更早的一轮')
    expect(fillPrompts[0]).not.toContain(USER_PAST)
  })

  it('没有改动性质的旧锚：序号对不上也按序号原样读，不按时间重新定位', async () => {
    sessions.set('s1', logOf([
      turn(0, sec(-20)), user(1, '更早的一轮', sec(-19)), assistant(2, '更早的回答', sec(-18)),
      turn(3, sec(0)), user(4, USER_REASON, sec(1)),
    ]))
    await seed([{ ...DECISION, sourceTrail: [{ sessionId: 's1', eventRange: [0, 1], sourceMode: 'user-explicit', at: sec(0) }] }])
    requestReplies = [{ requests: [requestOf('mem_d', 'missing-basis')] }]
    fillReplies = [{ result: 'none' }]
    await dream()
    expect(fillPrompts[0]).toContain('更早的一轮')
    expect(fillPrompts[0]).not.toContain(USER_REASON)
  })
})

describe('这次读不出：不列报告、不占名额，下次重试', () => {
  const retried = async () => {
    requestReplies = [{ requests: [requestOf('mem_d', 'missing-basis')] }]
    await dream()
    expect(requestPrompts).toHaveLength(1)
    expect(fillPrompts).toEqual([])
    expect((await entryOf('run_1'))?.drillDown?.unreadable ?? []).toEqual([])
    expect((await entryOf('run_1'))?.drillDown?.drills ?? 0).toBe(0)
    // 下次运行（这条没再改过）仍交给模型、照常读
    requestReplies = [{ requests: [requestOf('mem_d', 'missing-basis')] }]
    fillReplies = [REFINE_FROM_USER]
    return async () => {
      await dream()
      expect(requestPrompts.at(-1)).toContain('mem_d')
      expect((await get('mem_d')).content).toBe(REFINED)
    }
  }

  it('宿主列不出会话列表', async () => {
    await seed([DECISION])
    listed = null
    const next = await retried()
    listed = new Set(['s1'])
    await next()
  })

  it('会话在列表里、日志读不出', async () => {
    await seed([DECISION])
    logFails = new Set(['s1'])
    const next = await retried()
    logFails = new Set()
    await next()
  })

  it('存档状态读不出：不当存档也不当没存档', async () => {
    await seed([DECISION])
    archived = null
    const next = await retried()
    expect(readCalls).toEqual([])
    archived = new Set()
    await next()
  })

  it('「不回看」清单读不出', async () => {
    await seed([DECISION])
    // 这个会话的标记文件位置上是个目录：读它报错，不是「不存在」
    const blocker = join(root, STATE_DIR, 'no-review', `${createHash('sha1').update('s1').digest('hex')}.json`)
    await mkdir(blocker, { recursive: true })
    const next = await retried()
    await rm(blocker, { recursive: true })
    await next()
  })
})

describe('存档会话', () => {
  it('补缺口不读存档会话：拒绝、不读、不列进读不到；报告里读了 0 个存档会话', async () => {
    await seed([DECISION])
    archived = new Set(['s1'])
    requestReplies = [{ requests: [requestOf('mem_d', 'missing-basis')] }]
    await dream()
    expect(requestPrompts).toHaveLength(1)
    expect(readCalls).toEqual([])
    expect((await entryOf('run_1'))?.drillDown?.unreadable ?? []).toEqual([])
    expect(await skippedOf()).toContainEqual(expect.objectContaining({ target: 'mem_d', reason: 'archived-fill-gap' }))
  })

  const pairDeps = (): DrillSourceDeps => ({ host, noReview, limit: 5 })
  const req = (a: DrillAnchor, purpose: DrillRequest['purpose'] = 'verify-conflict'): DrillRequest => ({ memoryId: 'mem_d', gap: 'conflict', purpose, anchor: a })
  const live: DrillAnchor = { sessionId: 's1', eventRange: [0, 3], at: sec(0), change: 'refine' }
  const old: DrillAnchor = { sessionId: 's_old', eventRange: [0, 1], at: sec(0), change: 'refine' }
  const old2: DrillAnchor = { sessionId: 's_old', eventRange: [4, 5], at: sec(10), change: 'refine' }

  it('核实矛盾：这一对没存档的锚都试过之后才读存档会话；读过的存档会话按会话去重计数', async () => {
    sessions.set('s_old', S1())
    listed = new Set(['s1', 's_old'])
    archived = new Set(['s_old'])
    const log = newDrillLog()
    const pairAnchors = [live, old, old2]
    expect(await drillRead({ ...req(old), pairAnchors }, log, pairDeps())).toEqual({ kind: 'refused', reason: 'archived-too-early' })
    expect(readCalls).toEqual([])
    expect((await drillRead({ ...req(live), pairAnchors }, log, pairDeps())).kind).toBe('read')
    expect(log.attempted.has(drillAnchorKey(live))).toBe(true)
    const first = await drillRead({ ...req(old), pairAnchors }, log, pairDeps())
    expect(first).toMatchObject({ kind: 'read', sessionId: 's_old', isArchived: true })
    expect((await drillRead({ ...req(old2), pairAnchors }, log, pairDeps())).kind).toBe('read')
    expect(log.used).toBe(3)
    expect([...log.archivedSessions]).toEqual(['s_old'])
  })

  it('读到的一段：给出交给编号的事件和其中用户原话的序号；只读，不写侧表', async () => {
    const log = newDrillLog()
    const out = await drillRead(req(live, 'fill-gap'), log, pairDeps())
    expect(out.kind).toBe('read')
    if (out.kind !== 'read') return
    expect(out.events.map(e => e.seq)).toEqual([1, 2, 3])
    expect([...out.userSeqs]).toEqual([1])
    expect(out.isArchived).toBe(false)
    expect(log.used).toBe(1)
    expect(log.unreadable).toEqual([])
  })

  it('确认读不到的锚也算试过；名额满了拒绝（没读到日志的不算名额）', async () => {
    const log = newDrillLog()
    const gone: DrillAnchor = { sessionId: 's_gone', eventRange: [0, 1], at: sec(0) }
    expect(await drillRead(req(gone, 'fill-gap'), log, pairDeps())).toEqual({ kind: 'unreadable', reason: 'session-gone' })
    expect(log.attempted.has(drillAnchorKey(gone))).toBe(true)
    expect(log.used).toBe(0)
    const tight = { ...pairDeps(), limit: 1 }
    expect((await drillRead(req(live, 'fill-gap'), log, tight)).kind).toBe('read')
    expect(await drillRead(req(live, 'fill-gap'), log, tight)).toEqual({ kind: 'refused', reason: 'over-limit' })
  })
})

describe('撤销', () => {
  async function both() {
    const [d, p] = await seed([DECISION, { ...PAGE, sourceTrail: [anchor('s1', [0, 6], sec(0))] }])
    requestReplies = [{ requests: [requestOf('mem_d', 'missing-basis'), requestOf('mem_p', 'fact-gap')] }]
    fillReplies = [REFINE_FROM_USER, RECOVER_FROM_USER]
    expect((await dream()).kind).toBe('completed')
    return { d: d!, p: p! }
  }

  it('撤整批：细化改回原样，补回的版本删掉，条目移出账本', async () => {
    const { d, p } = await both()
    expect(await undo('run_1')).toMatchObject({ kind: 'undone' })
    expect(stable(await get('mem_d'))).toEqual(stable(d))
    expect(stable(await get('mem_p'))).toEqual(stable(p))
    expect(await versionsOf('mem_p')).toEqual([])
    expect(await entryOf('run_1')).toBeUndefined()
  })

  it('单撤补回的那一版：只删这一版，细化留着；条目还在、回执拿掉', async () => {
    await both()
    const op = (await entryOf('run_1'))!.recoveredVersions![0]!.op
    expect(await undo('run_1', op)).toMatchObject({ kind: 'undone' })
    expect(await versionsOf('mem_p')).toEqual([])
    expect((await get('mem_d')).content).toBe(REFINED)
    const entry = (await entryOf('run_1'))!
    expect(entry.recoveredVersions ?? []).toEqual([])
    expect(entry.changes).toHaveLength(1)
  })

  it('只有补回版本的批次：撤掉后条目移出账本；那一版已被别处删掉时照样撤成', async () => {
    await seed([{ ...PAGE, sourceTrail: [anchor('s1', [0, 6], sec(0))] }])
    requestReplies = [{ requests: [requestOf('mem_p', 'fact-gap')] }]
    fillReplies = [RECOVER_FROM_USER]
    await dream()
    const [v] = await versionsOf('mem_p')
    await store.history.remove(layerOf(await located('mem_p')), 'mem_p', v!.versionId)
    expect(await undo('run_1')).toMatchObject({ kind: 'undone' })
    expect(await entryOf('run_1')).toBeUndefined()
  })

  it('补回版本的历史读不全、又找不到那一版：回执留着，下次还能撤', async () => {
    await seed([{ ...PAGE, sourceTrail: [anchor('s1', [0, 6], sec(0))] }])
    requestReplies = [{ requests: [requestOf('mem_p', 'fact-gap')] }]
    fillReplies = [RECOVER_FROM_USER]
    await dream()
    const loc = await located('mem_p')
    const [v] = await versionsOf('mem_p')
    await store.history.remove(layerOf(loc), 'mem_p', v!.versionId)
    await writeFile(join(loc.dir, HISTORY_DIR, 'mem_p', 'v-bad.md'), '读不出的版本文件')
    const r = await undo('run_1')
    expect(r).toMatchObject({ skipped: 1 })
    expect((await entryOf('run_1'))!.recoveredVersions).toHaveLength(1)
  })

  it('什么都没写、只有读不到的锚：条目留着给报告看，撤销时没有可撤的', async () => {
    await seed([{ ...DECISION, sourceTrail: [anchor('s_gone', [0, 3], sec(0))] }])
    requestReplies = [{ requests: [requestOf('mem_d', 'missing-basis')] }]
    await dream()
    const entry = (await entryOf('run_1'))!
    expect(entry.drillDown!.unreadable).toHaveLength(1)
    expect(entry.changes ?? []).toEqual([])
    expect(entry.summary).toBe('记忆梦境')
    expect(await undo('run_1')).toMatchObject({ kind: 'error', code: 'not-found' })
    expect((await entryOf('run_1'))!.drillDown!.unreadable).toHaveLength(1)
  })

  it('什么都没做（没请求）：不留条目', async () => {
    await seed([DECISION])
    requestReplies = [{ requests: [] }]
    expect((await dream()).kind).toBe('completed')
    expect(requestPrompts).toHaveLength(1)
    expect(await entryOf('run_1')).toBeUndefined()
  })
})

describe('并发：模型调用期间前台改动', () => {
  const duringFill = (action: () => Promise<unknown>, then: unknown) => async () => { await action(); return then }

  it('细化：前台改过正文就跳过，前台的改动不被盖掉', async () => {
    await seed([DECISION])
    requestReplies = [{ requests: [requestOf('mem_d', 'missing-basis')] }]
    fillReplies = [duringFill(() => store.updateIfLive({ id: 'mem_d' }, cur => ({ ...cur, content: '前台改的', updatedAt: NOW + 5 })), REFINE_FROM_USER)]
    await dream()
    expect(fillPrompts).toHaveLength(1)
    expect((await get('mem_d')).content).toBe('前台改的')
    expect((await entryOf('run_1'))?.changes ?? []).toEqual([])
  })

  it('补回：前台改过就跳过，不写版本', async () => {
    await seed([{ ...PAGE, sourceTrail: [anchor('s1', [0, 6], sec(0))] }])
    requestReplies = [{ requests: [requestOf('mem_p', 'fact-gap')] }]
    fillReplies = [duringFill(() => store.updateIfLive({ id: 'mem_p' }, cur => ({ ...cur, content: '前台改的', updatedAt: NOW + 5 })), RECOVER_FROM_USER)]
    await dream()
    expect(await versionsOf('mem_p')).toEqual([])
    expect(await skippedOf()).toContainEqual(expect.objectContaining({ kind: 'recover-version', target: 'mem_p', reason: 'basis-changed' }))
  })

  it('补回：前台上了锁就跳过', async () => {
    await seed([{ ...PAGE, sourceTrail: [anchor('s1', [0, 6], sec(0))] }])
    requestReplies = [{ requests: [requestOf('mem_p', 'fact-gap')] }]
    fillReplies = [duringFill(() => store.updateIfLive({ id: 'mem_p' }, cur => ({ ...cur, locked: true })), RECOVER_FROM_USER)]
    await dream()
    expect(await versionsOf('mem_p')).toEqual([])
    expect(await skippedOf()).toContainEqual(expect.objectContaining({ target: 'mem_p', reason: expect.stringMatching(/^(locked|basis-changed)$/) }))
  })

  it('补回：前台删了这条就跳过', async () => {
    await seed([{ ...PAGE, sourceTrail: [anchor('s1', [0, 6], sec(0))] }])
    requestReplies = [{ requests: [requestOf('mem_p', 'fact-gap')] }]
    fillReplies = [duringFill(() => store.softDelete({ id: 'mem_p' }), RECOVER_FROM_USER)]
    await dream()
    expect((await store.history.list(layerOf((await store.locate('mem_p', GLOBAL))!), 'mem_p')).versions).toEqual([])
    expect(await skippedOf()).toContainEqual(expect.objectContaining({ target: 'mem_p', reason: 'gone' }))
  })

  it('这次运行的条目中途被撤销：之后的补回不写，运行不算做完', async () => {
    await seed([DECISION, { ...PAGE, sourceTrail: [anchor('s1', [0, 6], sec(0))] }])
    requestReplies = [{ requests: [requestOf('mem_d', 'missing-basis'), requestOf('mem_p', 'fact-gap')] }]
    fillReplies = [REFINE_FROM_USER, duringFill(() => undo('run_1'), RECOVER_FROM_USER)]
    const r = await dream()
    expect(fillPrompts).toHaveLength(2)
    expect(r.kind).not.toBe('completed')
    expect(await versionsOf('mem_p')).toEqual([])
    expect(await entryOf('run_1')).toBeUndefined()
  })
})

describe('前台改动落在随机时刻', () => {
  // 种子：缺省固定（helpers/interleave.ts），PM_INTERLEAVE_SEED 覆盖；轮数缺省 60，PM_INTERLEAVE_RUNS 覆盖
  const RUNS = interleaveRuns(60)
  it('前台在下钻的某个写入段之前改、锁、删一条，或撤销这次运行：补回的版本和回执一一对应，前台的改动不丢，锁上的不再被改', async () => {
    await teardown()
    try {
      await fc.assert(fc.asyncProperty(
        fc.integer({ min: 0, max: 8 }), fc.constantFrom('mem_d', 'mem_p'), fc.constantFrom('edit', 'lock', 'delete', 'undo'),
        async (at, target, action) => {
          await setup()
          try {
            await seed([DECISION, { ...PAGE, sourceTrail: [anchor('s1', [0, 6], sec(0))] }])
            const pageBefore = await get('mem_p')
            const section = store.writeSection.bind(store)
            let depth = 0
            let count = 0
            let isInjecting = false
            let landed: MemoryRecord | undefined
            let isAfterRead = false
            store.writeSection = async <T>(fn: () => Promise<T>): Promise<T> => {
              if (!isInjecting && depth === 0 && count++ === at) {
                isInjecting = true
                try {
                  isAfterRead = fillPrompts.length > 0
                  if (action === 'undo') {
                    if ((await entryOf('run_1')) !== undefined) await undo('run_1')
                  } else if (action === 'delete') {
                    if (await store.softDelete({ id: target })) landed = await store.get(target, GLOBAL)
                  } else {
                    landed = await store.updateIfLive({ id: target }, cur => (
                      action === 'edit' ? { ...cur, content: `前台改的${target}`, updatedAt: NOW + 5 }
                        : { ...cur, locked: true }))
                  }
                } finally {
                  isInjecting = false
                }
              }
              if (isInjecting) return section(fn)
              depth++
              try { return await section(fn) } finally { depth-- }
            }
            requestReplies = [{ requests: [requestOf('mem_d', 'missing-basis'), requestOf('mem_p', 'fact-gap')] }]
            // 按这次补写的是哪条给回复：前台删掉的那条不再是候选，回复不能错配到另一条上
            const byMemory = () => (fillPrompts.at(-1)!.includes('mem_d') ? REFINE_FROM_USER : RECOVER_FROM_USER)
            fillReplies = [byMemory, byMemory]
            await dream()
            store.writeSection = section
            // 请求阶段在任何写入段之前：总会问一次
            expect(requestPrompts).toHaveLength(1)
            // 补回的版本和条目上的回执一一对应（按 op）
            const loc = await store.locate('mem_p', GLOBAL)
            const recovered = loc === undefined ? [] : (await store.history.list(layerOf(loc), 'mem_p')).versions.filter(v => v.kind === RECOVERED_VERSION)
            const receipts = (await entryOf('run_1'))?.recoveredVersions ?? []
            expect(recovered.map(v => v.writes[0]!.op).sort()).toEqual(receipts.map(r => r.op).sort())
            // 状态页的记忆文件梦境不动：只有前台改过的样子或原样
            const page = await store.get('mem_p', GLOBAL)
            if (!(landed !== undefined && target === 'mem_p')) expect(stable(page!)).toEqual(stable(pageBefore))
            // 模型读过之后前台写成的改动不被盖掉
            if (landed !== undefined && action === 'edit' && isAfterRead) expect((await get(target)).content).toBe(`前台改的${target}`)
            // 锁上之后梦境不再改它
            if (landed !== undefined && action === 'lock') expect(stable(await get(target))).toEqual(stable(landed))
            // 删掉的不再写补回的版本：有版本就一定写在删除之前（删除之后写的会被跳过）
            if (landed !== undefined && action === 'delete') expect((await get(target)).status).toBe('deleted')
            expect(await decisions.withOpenGroups()).toEqual([])
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

describe('会话归属与用户本人原话', () => {
  const forked = (events: RawEvent[], inherited: number | undefined): SessionLog => ({ header: { isSeeded: true }, inheritedEventCount: inherited, events })
  /** fork 出来的会话：seq 0–4 是从父会话继承的，5 起是自己的。 */
  const FORKED = () => [
    turn(0, sec(-30)), user(1, '父会话里也聊过 pnpm', sec(-29)), assistant(2, '父会话的回答', sec(-28)), turn(3, sec(-20)), user(4, '父会话第二轮', sec(-19)),
    turn(5, sec(0)), user(6, USER_REASON, sec(1)), assistant(7, ASSISTANT_REPLY, sec(2)),
  ]

  it('fork 会话开窗只读自己的事件，继承来的不给模型；自己的用户原话照常直接写', async () => {
    sessions.set('s1', forked(FORKED(), 5))
    await seed([{ ...DECISION, sourceTrail: [{ sessionId: 's1', eventRange: [0, 7], sourceMode: 'user-explicit', at: sec(-30) }] }])
    requestReplies = [{ requests: [requestOf('mem_d', 'missing-basis')] }]
    fillReplies = [REFINE_FROM_USER]
    await dream()
    expect(fillPrompts[0]).toContain(USER_REASON)
    for (const text of ['父会话里也聊过 pnpm', '父会话的回答', '父会话第二轮']) expect(fillPrompts[0]).not.toContain(text)
    expect((await get('mem_d')).content).toBe(REFINED)
  })

  it('fork 会话重新定位只在自己的事件里找：时间落在继承的轮里就算锚失效', async () => {
    sessions.set('s1', forked(FORKED(), 5))
    await seed([{ ...DECISION, sourceTrail: [anchor('s1', [20, 23], sec(-25))] }])
    requestReplies = [{ requests: [requestOf('mem_d', 'missing-basis')] }]
    await dream()
    expect(fillPrompts).toEqual([])
    expect((await entryOf('run_1'))!.drillDown!.unreadable.map(u => u.reason)).toEqual(['anchor-lost'])
  })

  it('fork 会话按关键词找只找自己的事件', async () => {
    sessions.set('s1', forked(FORKED(), 5))
    await seed([DECISION])
    requestReplies = [{ requests: [requestOf('mem_d', 'missing-basis', { query: 'pnpm' })] }]
    fillReplies = [{ result: 'none' }]
    await dream()
    expect(fillPrompts[0]).toContain(USER_REASON)
    expect(fillPrompts[0]).not.toContain('父会话里也聊过 pnpm')
  })

  it('分不清哪些是继承来的（边界未知）：按关键词找不下「没有」的结论，不列报告、不算试过，记进跳过清单', async () => {
    sessions.set('s1', forked(S1().events, undefined))
    await seed([DECISION])
    requestReplies = [{ requests: [requestOf('mem_d', 'missing-basis', { query: 'pnpm' })] }]
    await dream()
    expect(fillPrompts).toEqual([])
    expect((await entryOf('run_1'))?.drillDown?.unreadable ?? []).toEqual([])
    expect(await skippedOf()).toContainEqual(expect.objectContaining({ target: 'mem_d', reason: 'boundary-unknown' }))
    const log = newDrillLog()
    const a: DrillAnchor = { sessionId: 's1', eventRange: [0, 3], at: sec(0), change: 'refine' }
    expect(await drillRead({ memoryId: 'mem_d', gap: 'missing-basis', purpose: 'fill-gap', anchor: a, query: 'pnpm' }, log, { host, noReview, limit: 5 })).toEqual({ kind: 'missed', reason: 'boundary-unknown' })
    expect(log.attempted.has(drillAnchorKey(a))).toBe(false)
    expect(log.unreadable).toEqual([])
  })

  it('边界未知的会话开窗照读，但里面的话不算用户本人说的：只交给用户', async () => {
    sessions.set('s1', forked(S1().events, undefined))
    const [d] = await seed([DECISION])
    requestReplies = [{ requests: [requestOf('mem_d', 'missing-basis')] }]
    fillReplies = [REFINE_FROM_USER]
    await dream()
    expect(fillPrompts[0]).toContain(USER_REASON)
    expect(stable(await get('mem_d'))).toEqual(stable(d!))
    expect((await entryOf('run_1'))!.drillDown!.proposals.map(p => p.memoryId)).toEqual(['mem_d'])
  })

  it('子 agent 会话里委派来的任务、没有来源标记的消息：编进原文，但不算用户原话，只交给用户', async () => {
    sessions.set('s_sub', { header: { isSeeded: false, delegationDepth: 1 }, inheritedEventCount: 0, events: S1().events })
    sessions.set('s_raw', logOf([turn(0, sec(0)), { type: 'user/message', seq: 1, time: sec(1), data: { id: 'm1', role: 'user', content: [{ type: 'text', text: USER_REASON }] } }]))
    listed = new Set(['s_sub', 's_raw'])
    const [d, e] = await seed([
      { ...DECISION, sourceTrail: [anchor('s_sub', [0, 3], sec(0))] },
      { ...DECISION, id: 'mem_e', name: '锁文件', sourceTrail: [anchor('s_raw', [0, 1], sec(0))] },
    ])
    requestReplies = [{ requests: [requestOf('mem_d', 'missing-basis'), requestOf('mem_e', 'missing-basis')] }]
    fillReplies = [REFINE_FROM_USER, REFINE_FROM_USER]
    await dream()
    for (const fill of fillPrompts) expect(fill).toContain(USER_REASON)
    expect(stable(await get('mem_d'))).toEqual(stable(d!))
    expect(stable(await get('mem_e'))).toEqual(stable(e!))
    const entry = (await entryOf('run_1'))!
    expect(entry.changes ?? []).toEqual([])
    expect(entry.drillDown!.proposals.map(p => p.memoryId)).toEqual(['mem_d', 'mem_e'])
  })
})

describe('读之前的顺序', () => {
  const sourceDeps = (limit = 5): DrillSourceDeps => ({ host, noReview, limit })
  const a: DrillAnchor = { sessionId: 's1', eventRange: [0, 3], at: sec(0), change: 'refine' }

  it('名额已满：直接拒绝，不列会话、不读日志', async () => {
    const log = newDrillLog()
    log.used = 2
    expect(await drillRead({ memoryId: 'mem_d', gap: 'missing-basis', purpose: 'fill-gap', anchor: a }, log, sourceDeps(2))).toEqual({ kind: 'refused', reason: 'over-limit' })
    expect(listCalls).toBe(0)
    expect(readCalls).toEqual([])
    expect(log.attempted.size).toBe(0)
  })

  it('补缺口碰上存档会话：先按存档拒绝，会话不在列表里也不报「会话没了」', async () => {
    archived = new Set(['s_gone'])
    const log = newDrillLog()
    const gone: DrillAnchor = { sessionId: 's_gone', eventRange: [0, 1], at: sec(0) }
    expect(await drillRead({ memoryId: 'mem_d', gap: 'missing-basis', purpose: 'fill-gap', anchor: gone }, log, sourceDeps())).toEqual({ kind: 'refused', reason: 'archived-fill-gap' })
    expect(listCalls).toBe(0)
    expect(log.unreadable).toEqual([])
    expect(log.attempted.size).toBe(0)
  })

  it('关键词没命中：读过日志（占名额），但不列进读不到、不算试过；整次运行里记进跳过清单', async () => {
    const log = newDrillLog()
    expect(await drillRead({ memoryId: 'mem_d', gap: 'missing-basis', purpose: 'fill-gap', anchor: a, query: '找不到的词' }, log, sourceDeps())).toEqual({ kind: 'missed', reason: 'no-hits' })
    expect(log.used).toBe(1)
    expect(log.unreadable).toEqual([])
    expect(log.attempted.has(drillAnchorKey(a))).toBe(false)
    await seed([DECISION])
    requestReplies = [{ requests: [requestOf('mem_d', 'missing-basis', { query: '找不到的词' })] }]
    await dream()
    expect(fillPrompts).toEqual([])
    expect((await entryOf('run_1'))?.drillDown?.unreadable ?? []).toEqual([])
    expect(await skippedOf()).toContainEqual(expect.objectContaining({ target: 'mem_d', reason: 'no-hits' }))
  })
})

describe('读出的量', () => {
  it(`开窗最多给 ${DRILL_WINDOW_MESSAGES} 条消息`, async () => {
    const many = Array.from({ length: DRILL_WINDOW_MESSAGES + 10 }, (_, i) => user(i + 1, `第${String(i).padStart(2, '0')}条`, sec(i + 1)))
    sessions.set('s1', logOf([turn(0, sec(0)), ...many]))
    await seed([{ ...DECISION, sourceTrail: [anchor('s1', [0, DRILL_WINDOW_MESSAGES + 10], sec(0))] }])
    requestReplies = [{ requests: [requestOf('mem_d', 'missing-basis')] }]
    fillReplies = [{ result: 'none' }]
    await dream()
    expect(fillPrompts[0]!.match(/第\d\d条/g)).toHaveLength(DRILL_WINDOW_MESSAGES)
    expect(fillPrompts[0]).toContain('第00条')
  })

  it(`读出的正文合计到 ${DRILL_READ_MAX_CHARS} 字为止，整条整条地给；第一条再长也给`, async () => {
    const big = (i: number) => `段${i}${'长'.repeat(10_000)}`
    sessions.set('s1', logOf([turn(0, sec(0)), ...[1, 2, 3, 4].map(i => user(i, big(i), sec(i)))]))
    sessions.set('s2', logOf([turn(0, sec(0)), user(1, `段1${'长'.repeat(DRILL_READ_MAX_CHARS + 10)}`, sec(1)), user(2, '段2', sec(2))]))
    listed = new Set(['s1', 's2'])
    await seed([
      { ...DECISION, sourceTrail: [anchor('s1', [0, 4], sec(0))] },
      { ...DECISION, id: 'mem_e', name: '锁文件', sourceTrail: [anchor('s2', [0, 2], sec(0))] },
    ])
    requestReplies = [{ requests: [requestOf('mem_d', 'missing-basis'), requestOf('mem_e', 'missing-basis')] }]
    fillReplies = [{ result: 'none' }, { result: 'none' }]
    await dream()
    expect(fillPrompts[0]!.match(/段\d/g)).toEqual(['段1', '段2'])
    expect(fillPrompts[1]!.match(/段\d/g)).toEqual(['段1'])
    expect(fillPrompts[1]).toContain('长'.repeat(DRILL_READ_MAX_CHARS + 10))
  })
})

describe('候选与请求', () => {
  it(`候选按缺口多少、再按 id 排，最多交 ${DRILL_CANDIDATES_MAX} 条；排不进的有缺口的下次运行再交`, async () => {
    const ids = Array.from({ length: DRILL_CANDIDATES_MAX + 1 }, (_, i) => `mem_d${String(i).padStart(2, '0')}`)
    // 先建没有缺口的（id 排最前），决定倒着建
    await seed([{ ...PAGE, id: 'mem_a', type: 'knowledge', factTime: undefined }, ...[...ids].reverse().map(id => ({ ...DECISION, id }))])
    requestReplies = [{ requests: [] }]
    await dream()
    expect(requestRows(0).map(r => r.id)).toEqual(ids.slice(0, DRILL_CANDIDATES_MAX))
    requestReplies = [{ requests: [] }]
    await dream()
    expect(requestRows(1).map(r => r.id)).toEqual([ids.at(-1)])
  })

  it('含密钥的记忆（疑似级也算）不交给模型', async () => {
    await seed([DECISION, { ...DECISION, id: 'mem_s', name: '测试库', content: `测试库用 pnpm，本地账号 ${SUSPECTED}。` }])
    requestReplies = [{ requests: [] }]
    await dream()
    expect(requestRows().map(r => r.id)).toEqual(['mem_d'])
    expect(requestPrompts[0]).not.toContain(SUSPECTED_VALUE)
  })

  it('留给下次运行的记忆这次不交给模型', async () => {
    beforeDrill = [{ name: 'hold', needsChanges: false, run: async (ctx) => { ctx.holdForNextRun(['mem_d']) } }]
    await seed([DECISION, { ...PAGE, sourceTrail: [anchor('s1', [0, 6], sec(0))] }])
    requestReplies = [{ requests: [] }]
    await dream()
    expect(requestRows().map(r => r.id)).toEqual(['mem_p'])
  })

  it('同一条记忆：被拒的请求不占位，后面对的那条照读；对的请求重复了只读一次', async () => {
    await seed([DECISION])
    requestReplies = [{ requests: [
      requestOf('mem_d', 'missing-basis', { anchor: 9 }),
      requestOf('mem_d', 'missing-basis'),
      requestOf('mem_d', 'missing-alternatives'),
    ] }]
    fillReplies = [REFINE_FROM_USER]
    await dream()
    expect(readCalls).toEqual(['s1'])
    expect(fillPrompts).toHaveLength(1)
    expect((await get('mem_d')).content).toBe(REFINED)
    const skipped = await skippedOf()
    expect(skipped).toContainEqual(expect.objectContaining({ target: 'mem_d', reason: 'anchor-not-owned' }))
    expect(skipped).toContainEqual(expect.objectContaining({ target: 'mem_d', reason: 'duplicate' }))
  })

  it('请求阶段两次都读不出：这次不读会话，有缺口的候选下次运行再交', async () => {
    await seed([DECISION])
    requestReplies = ['读不出', '还是读不出']
    expect((await dream()).kind).toBe('completed')
    expect(requestPrompts).toHaveLength(2)
    expect(readCalls).toEqual([])
    requestReplies = [{ requests: [] }]
    await dream()
    expect(requestPrompts).toHaveLength(3)
    expect(requestRows(2).map(r => r.id)).toEqual(['mem_d'])
  })

  it('细化稿带着摘要：一起写', async () => {
    await seed([DECISION])
    requestReplies = [{ requests: [requestOf('mem_d', 'missing-basis')] }]
    fillReplies = [{ ...REFINE_FROM_USER, summary: '用 pnpm（缓存快）' }]
    await dream()
    expect(await get('mem_d')).toMatchObject({ content: REFINED, summary: '用 pnpm（缓存快）' })
  })

  it('改动量用完跳过的细化：下次运行再交', async () => {
    changeRatio = 0
    await seed([DECISION, { ...DECISION, id: 'mem_e', name: '锁文件' }])
    requestReplies = [{ requests: [requestOf('mem_d', 'missing-basis'), requestOf('mem_e', 'missing-basis')] }]
    fillReplies = [REFINE_FROM_USER, REFINE_FROM_USER]
    await dream()
    expect((await get('mem_d')).content).toBe(REFINED)
    expect((await get('mem_e')).content).toBe(DECISION.content)
    expect(await skippedOf()).toContainEqual(expect.objectContaining({ target: 'mem_e', reason: 'quota' }))
    requestReplies = [{ requests: [] }]
    await dream()
    expect(requestRows(1).map(r => r.id)).toEqual(['mem_e'])
  })

  it('补回时历史读不全：这次不写，下次运行再交', async () => {
    await seed([{ ...PAGE, sourceTrail: [anchor('s1', [0, 6], sec(0))] }])
    const loc = await located('mem_p')
    const bad = join(loc.dir, HISTORY_DIR, 'mem_p', 'v-bad.md')
    requestReplies = [{ requests: [requestOf('mem_p', 'fact-gap')] }]
    fillReplies = [async () => {
      await mkdir(join(loc.dir, HISTORY_DIR, 'mem_p'), { recursive: true })
      await writeFile(bad, '读不出的版本文件')
      return RECOVER_FROM_USER
    }]
    await dream()
    expect(await skippedOf()).toContainEqual(expect.objectContaining({ kind: 'recover-version', target: 'mem_p', reason: 'history-unreadable' }))
    await rm(bad)
    expect(await versionsOf('mem_p')).toEqual([])
    requestReplies = [{ requests: [] }]
    await dream()
    expect(requestRows(1).map(r => r.id)).toEqual(['mem_p'])
  })
})

describe('让路', () => {
  it('请求阶段的模型调用期间该让路了：不读会话，这次运行按让路收', async () => {
    await seed([DECISION])
    requestReplies = [async () => { await yieldNow(); return { requests: [requestOf('mem_d', 'missing-basis')] } }]
    expect((await dream()).kind).toBe('yielded')
    expect(readCalls).toEqual([])
    expect(fillPrompts).toEqual([])
  })

  it('补写阶段的模型调用期间该让路了：这一处不写，后面的不再读', async () => {
    await seed([DECISION, { ...PAGE, sourceTrail: [anchor('s1', [0, 6], sec(0))] }])
    requestReplies = [{ requests: [requestOf('mem_d', 'missing-basis'), requestOf('mem_p', 'fact-gap')] }]
    fillReplies = [async () => { await yieldNow(); return REFINE_FROM_USER }, RECOVER_FROM_USER]
    expect((await dream()).kind).toBe('yielded')
    expect(readCalls).toEqual(['s1'])
    expect(fillPrompts).toHaveLength(1)
    expect((await get('mem_d')).content).toBe(DECISION.content)
    expect(await versionsOf('mem_p')).toEqual([])
  })
})

describe('报告和跳过清单里的密钥', () => {
  it('交给用户的稿：正文、摘要、原因都遮盖疑似密钥，补回稿的事实时间留着', async () => {
    await seed([DECISION, { ...PAGE, sourceTrail: [anchor('s1', [0, 6], sec(0))] }])
    requestReplies = [{ requests: [requestOf('mem_d', 'missing-basis'), requestOf('mem_p', 'fact-gap')] }]
    fillReplies = [
      { result: 'refine', content: `${REFINED}账号 ${SUSPECTED}`, summary: `用 pnpm ${SUSPECTED}`, evidence: [1, 2] },
      { result: 'recover', content: `用 npm ${SUSPECTED}`, summary: `那时用 npm ${SUSPECTED}`, factTime: '2024-03', reason: `后来换了 ${SUSPECTED}`, evidence: [4, 5] },
    ]
    await dream()
    const [refine, recovered] = (await entryOf('run_1'))!.drillDown!.proposals
    expect(JSON.stringify([refine, recovered])).not.toContain(SUSPECTED_VALUE)
    expect(refine).toMatchObject({ memoryId: 'mem_d', kind: 'refine' })
    expect(refine!.summary).toContain('用 pnpm')
    expect(recovered).toMatchObject({ memoryId: 'mem_p', kind: 'recovered', factTime: '2024-03' })
    expect(recovered!.summary).toContain('那时用 npm')
    expect(recovered!.reason).toContain('后来换了')
  })

  it('补回稿带疑似密钥：不写版本', async () => {
    await seed([{ ...PAGE, sourceTrail: [anchor('s1', [0, 6], sec(0))] }])
    requestReplies = [{ requests: [requestOf('mem_p', 'fact-gap')] }]
    fillReplies = [{ ...RECOVER_FROM_USER, content: `用 npm，${SUSPECTED}` }]
    await dream()
    expect(await versionsOf('mem_p')).toEqual([])
    expect(await skippedOf()).toContainEqual(expect.objectContaining({ kind: 'recover-version', target: 'mem_p', reason: 'has-secret' }))
  })

  it('模型写的缺口和认不出的 id：进报告、跳过清单前遮盖', async () => {
    await seed([DECISION])
    const strange = `mem_x ${FAKE_SECRET.sk} ${SUSPECTED} ${'x'.repeat(300)}`
    requestReplies = [{ requests: [requestOf(strange, 'missing-basis'), requestOf('mem_d', `missing-basis ${SUSPECTED}`)] }]
    fillReplies = [REFINE_FROM_USER]
    await dream()
    const [filled] = (await entryOf('run_1'))!.drillDown!.filled
    expect(filled!.gap).toContain('missing-basis')
    expect(filled!.gap).not.toContain(SUSPECTED_VALUE)
    const unknown = (await skippedOf()).find(i => i.reason === 'unknown-memory')!
    expect(unknown.target).not.toContain(FAKE_SECRET.sk)
    expect(unknown.target).not.toContain(SUSPECTED_VALUE)
    expect(unknown.target.length).toBeLessThan(strange.length)
  })
})

describe('补回版本的写入顺序与撤销', () => {
  const recoverOne = async (scope: Scope = GLOBAL) => {
    await seed([{ ...PAGE, sourceTrail: [anchor('s1', [0, 6], sec(0))] }], scope)
    requestReplies = [{ requests: [requestOf('mem_p', 'fact-gap')] }]
    fillReplies = [RECOVER_FROM_USER]
    return dream(scope)
  }
  const recoveredIn = async (scope: Scope) => (await versionsOf('mem_p', scope)).filter(v => v.kind === RECOVERED_VERSION)

  it('写版本文件出错：回执已先记下，版本没落盘；之后撤销找不到那一版，照样拿掉回执', async () => {
    const history = store.history
    const write = history.write.bind(history)
    history.write = async () => { throw new Error('写不进') }
    const r = await recoverOne()
    history.write = write
    expect(r.kind).toBe('failed')
    expect(await versionsOf('mem_p')).toEqual([])
    expect((await entryOf('run_1'))!.recoveredVersions).toHaveLength(1)
    expect(await undo('run_1')).toMatchObject({ kind: 'undone' })
    expect(await entryOf('run_1')).toBeUndefined()
  })

  it('回执记不下：不写版本文件', async () => {
    const append = decisions.appendRecoveredVersion.bind(decisions)
    decisions.appendRecoveredVersion = async () => { throw new Error('账本写不进') }
    await recoverOne()
    decisions.appendRecoveredVersion = append
    expect(await versionsOf('mem_p')).toEqual([])
    expect((await entryOf('run_1'))?.recoveredVersions ?? []).toEqual([])
  })

  it('撤销时删版本文件出错：回执留着，之后再撤还能撤', async () => {
    await recoverOne()
    const history = store.history
    const remove = history.remove.bind(history)
    history.remove = async () => { throw new Error('删不掉') }
    await undo('run_1').catch(() => undefined)
    history.remove = remove
    expect(await versionsOf('mem_p')).toHaveLength(1)
    expect((await entryOf('run_1'))!.recoveredVersions).toHaveLength(1)
    expect(await undo('run_1')).toMatchObject({ kind: 'undone' })
    expect(await versionsOf('mem_p')).toEqual([])
  })

  it('全局和项目里有同 id 的两份：补回和撤销都只动这次运行的那一份', async () => {
    await seed([{ ...PAGE, sourceTrail: [anchor('s1', [0, 6], sec(0))] }])
    expect((await recoverOne(W)).kind).toBe('completed')
    expect(await recoveredIn(W)).toHaveLength(1)
    expect(await versionsOf('mem_p', GLOBAL)).toEqual([])
    expect((await entryOf('run_1'))!.recoveredVersions![0]!.scopeKey).toBe('/proj/a')
    expect(await undo('run_1', undefined, { workspacePath: '/proj/a' })).toMatchObject({ kind: 'undone' })
    expect(await versionsOf('mem_p', W)).toEqual([])
    expect(await versionsOf('mem_p', GLOBAL)).toEqual([])
    expect(await entryOf('run_1')).toBeUndefined()
  })

  it('在别的项目里撤销：不放行就什么都不动；放行了照常撤', async () => {
    await recoverOne(W)
    const op = (await entryOf('run_1'))!.recoveredVersions![0]!.op
    const elsewhere = { workspacePath: '/proj/b' }
    expect(await undo('run_1', undefined, elsewhere)).toMatchObject({ kind: 'error', code: 'cross-workspace' })
    expect(await undo('run_1', op, elsewhere)).toMatchObject({ kind: 'error', code: 'cross-workspace' })
    expect(await recoveredIn(W)).toHaveLength(1)
    expect((await entryOf('run_1'))!.recoveredVersions).toHaveLength(1)
    expect(await undo('run_1', undefined, elsewhere, true)).toMatchObject({ kind: 'undone' })
    expect(await recoveredIn(W)).toEqual([])
  })

  it('补回之后这条提升到了全局：撤销到它现在所在的作用域里按 op 找到那一版删掉', async () => {
    await recoverOne(W)
    const { workspacePath: _w, ...rest } = (await store.get('mem_p', W))!
    await store.put({ ...rest, scope: 'global' }, W)
    expect(await recoveredIn(GLOBAL)).toHaveLength(1)
    expect(await undo('run_1', undefined, { workspacePath: '/proj/a' })).toMatchObject({ kind: 'undone' })
    expect(await recoveredIn(GLOBAL)).toEqual([])
    expect(await entryOf('run_1')).toBeUndefined()
  })

  it('版本文件改了名：撤销按写入清单里的 op 认，照样删掉', async () => {
    await recoverOne()
    const layer = layerOf(await located('mem_p'))
    const [v] = await versionsOf('mem_p')
    await store.history.remove(layer, 'mem_p', v!.versionId)
    await store.history.write(layer, { ...v!, versionId: 'v-renamed' })
    expect(await undo('run_1')).toMatchObject({ kind: 'undone' })
    expect(await versionsOf('mem_p')).toEqual([])
  })

  it('单撤补回的那一版后，条目上还有交给用户的稿：条目留着', async () => {
    await seed([DECISION, { ...PAGE, sourceTrail: [anchor('s1', [0, 6], sec(0))] }])
    requestReplies = [{ requests: [requestOf('mem_d', 'missing-basis'), requestOf('mem_p', 'fact-gap')] }]
    fillReplies = [{ result: 'refine', content: REFINED, evidence: [1, 3] }, RECOVER_FROM_USER]
    await dream()
    const op = (await entryOf('run_1'))!.recoveredVersions![0]!.op
    expect(await undo('run_1', op)).toMatchObject({ kind: 'undone' })
    const left = (await entryOf('run_1'))!
    expect(left.recoveredVersions ?? []).toEqual([])
    expect(left.drillDown!.proposals.map(p => p.memoryId)).toEqual(['mem_d'])
  })

  it('收尾中断的组时移出空条目：带补回回执或下钻报告的条目留着', async () => {
    await store.writeSection(async () => {
      for (const id of ['run_a', 'run_b', 'run_c']) await decisions.addDreamsRun(id, { summary: '记忆梦境', workspace: 'global' }, NOW)
      await decisions.appendRecoveredVersion('run_a', { op: 'run_a:drill:1', memoryId: 'mem_p', scopeKey: 'global', versionId: 'v1', at: NOW })
      await decisions.recordDrillReport('run_b', {
        drills: 0, archivedSessionsRead: 0, filled: [], proposals: [],
        unreadable: [{ memoryId: 'mem_d', sessionId: 's_gone', eventRange: [0, 3], at: sec(0), reason: 'session-gone' }],
      })
      for (const id of ['run_a', 'run_b', 'run_c']) await decisions.removeEmptyRun(id)
    })
    expect(await entryOf('run_a')).toBeDefined()
    expect(await entryOf('run_b')).toBeDefined()
    expect(await entryOf('run_c')).toBeUndefined()
  })
})

describe('缺口线索', () => {
  it('有未决「依据已变」条目的决定：请求阶段带上 premise-changed', async () => {
    await seed([DECISION, { ...PAGE, id: 'mem_q' }])
    await decisions.upsert({ kind: 'premise-changed', memoryIds: ['mem_d', 'mem_q'], summary: '依据变了', fingerprint: 'fp-premise' }, NOW)
    requestReplies = [{ requests: [] }]
    await dream()
    expect(requestPrompts[0]).toContain('premise-changed')
  })

  it('依据已变只标条目里的那条决定（第一项），后面的前提记忆不标；别的项目的条目不算', async () => {
    await seed([DECISION, { ...DECISION, id: 'mem_e', name: '锁文件' }, { ...DECISION, id: 'mem_f', name: '镜像源' }])
    // mem_d 是决定、mem_e 是它的前提
    await decisions.upsert({ kind: 'premise-changed', memoryIds: ['mem_d', 'mem_e'], summary: '依据变了', fingerprint: 'fp-1' }, NOW)
    // 别的项目里的条目：成员 id 碰巧相同也不算
    await decisions.upsert({ kind: 'premise-changed', memoryIds: ['mem_f', 'mem_e'], summary: '依据变了', fingerprint: 'fp-2', workspaces: ['/proj/other'] }, NOW)
    requestReplies = [{ requests: [] }]
    await dream()
    const gaps = new Map(requestRows().map(r => [r.id, r.gaps]))
    expect(gaps.get('mem_d')).toContain('premise-changed')
    expect(gaps.get('mem_e')).not.toContain('premise-changed')
    expect(gaps.get('mem_f')).not.toContain('premise-changed')
  })

  it('历史版本读不全的记忆：这次不交给模型，下次再看', async () => {
    const [d] = await seed([DECISION])
    const loc = await located('mem_d')
    await mkdir(join(loc.dir, HISTORY_DIR, 'mem_d'), { recursive: true })
    await writeFile(join(loc.dir, HISTORY_DIR, 'mem_d', 'v-bad.md'), '读不出的版本文件')
    requestReplies = [{ requests: [requestOf('mem_d', 'missing-basis')] }]
    expect((await dream()).kind).toBe('completed')
    // 一条候选都没有：不调模型
    expect(requestPrompts).toEqual([])
    expect(readCalls).toEqual([])
    expect(stable(await get('mem_d'))).toEqual(stable(d!))
    expect(await skippedOf()).toContainEqual(expect.objectContaining({ target: 'mem_d', reason: 'history-unreadable' }))
    // 修好之后（这条没再改过）下次运行照常交给模型
    await rm(join(loc.dir, HISTORY_DIR, 'mem_d', 'v-bad.md'))
    fillReplies = [REFINE_FROM_USER]
    await dream()
    expect(requestPrompts).toHaveLength(1)
    expect(requestPrompts[0]).toContain('mem_d')
    expect((await get('mem_d')).content).toBe(REFINED)
  })
})
