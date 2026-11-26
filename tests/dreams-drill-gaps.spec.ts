import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileTable } from '../src/storage/file-table.ts'
import { OpJournal } from '../src/storage/op-journal.ts'
import { createRootLock } from '../src/storage/root-lock.ts'
import { NoReviewList } from '../src/storage/no-review.ts'
import type { DreamMarks, DreamsRecord, RecallStats } from '../src/storage/schema.ts'
import { RECOVERED_VERSION, layerOf } from '../src/storage/history.ts'
import { MemoryStore } from '../src/store.ts'
import { PendingDecisionsStore } from '../src/governance/decisions.ts'
import { SnapshotStore } from '../src/governance/snapshots.ts'
import { ledgerSteps } from '../src/governance/op-steps.ts'
import type { MemorySnapshot, PendingDecision } from '../src/governance/schema.ts'
import type { SemanticLlm } from '../src/governance/semantic-scan.ts'
import { DREAMS_DEFAULTS } from '../src/governance/dreams-gate.ts'
import { DreamsStore } from '../src/governance/dreams-records.ts'
import { DRILL_FILL_SYSTEM_PROMPT, DRILL_REQUEST_SYSTEM_PROMPT } from '../src/governance/drill-down.ts'
import { maintainStep, runDreams } from '../src/tools/dreams-run.ts'
import { drillDownStep } from '../src/tools/dreams-drill.ts'
import { executeUndo } from '../src/tools/undo.ts'
import type { HostSession } from '../src/tools/host-session.ts'
import type { RawEvent, SessionLog } from '../src/session-log.ts'
import type { MemoryRecord, SourceAnchor } from '../src/record-schema.ts'
import type { Scope } from '../src/scope.ts'
import { InMemoryBatchKvTable, InMemoryKvTable } from './helpers/in-memory-kv.ts'
import { record } from './helpers/record.ts'
import { messageFrom } from './helpers/session-log.ts'

// 下钻补全的三处补充：单撤后只剩读不到的锚时条目的去留、整批撤销连同报告移出、边界未知的会话开窗时按时间重新定位。
// 真文件、真操作日志、真写锁；宿主会话和模型是边界上的替身。

const quiet = { info() {}, warn() {}, error() {} }
const GLOBAL = { kind: 'global' } as const
const NOW = 1_800_000_000_000
/** 会话里的事件时刻：一个固定的过去时刻。 */
const T0 = Date.UTC(2025, 2, 1, 2, 0)
const sec = (n: number) => T0 + n * 1000

const turn = (seq: number, time: number): RawEvent => ({ type: 'turn/start', seq, time })
const user = (seq: number, text: string, time: number): RawEvent => messageFrom('user', seq, text, time)
const assistant = (seq: number, text: string, time: number): RawEvent => ({ type: 'assistant/message', seq, time, data: { message: { content: [{ type: 'text', text }] } } })
const tool = (seq: number, text: string, time: number): RawEvent => ({ type: 'tool/result', seq, time, data: { message: { content: [{ type: 'text', text }] } } })

const USER_REASON = '改用 pnpm，因为 CI 里缓存快、装得快'
const ASSISTANT_REPLY = '好的，那我把 lockfile 换掉'
const TOOL_OUTPUT = 'pnpm 9.1.0 装好了'
const USER_PAST = '去年三月我们还在用 npm 装依赖'
const S1_EVENTS = (): RawEvent[] => [
  turn(0, sec(0)), user(1, USER_REASON, sec(1)), assistant(2, ASSISTANT_REPLY, sec(2)), tool(3, TOOL_OUTPUT, sec(3)),
  turn(4, sec(10)), user(5, USER_PAST, sec(11)), assistant(6, '明白', sec(12)),
]

let sessions: Map<string, SessionLog>
const host: Pick<HostSession, 'readSessionLog' | 'listSessions' | 'archivedSessionIds'> = {
  readSessionLog: async (id: string) => sessions.get(id) ?? null,
  listSessions: async () => [...sessions.keys()].map(id => ({ id, cwd: undefined, isSubagent: false, isLive: false })),
  archivedSessionIds: async () => new Set<string>(),
}

let requestReplies: unknown[]
let fillReplies: unknown[]
let fillPrompts: string[]
let runSeq: number
const llm: SemanticLlm = {
  model: 'stub',
  complete: async (prompt) => {
    if (prompt.system === DRILL_REQUEST_SYSTEM_PROMPT) return JSON.stringify(requestReplies.shift() ?? { requests: [] })
    if (prompt.system === DRILL_FILL_SYSTEM_PROMPT) {
      fillPrompts.push(prompt.user)
      return JSON.stringify(fillReplies.shift() ?? { result: 'none' })
    }
    return '{}'
  },
}

let root: string
let journal: OpJournal
let store: MemoryStore
let decisions: PendingDecisionsStore
let snapshots: SnapshotStore
let dreams: DreamsStore
let noReview: NoReviewList

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pm-dreams-drill-gaps-'))
  journal = new OpJournal({ path: join(root, '.state', 'op-journal.sqlite'), log: quiet })
  const lock = createRootLock({ root, log: quiet })
  const stats = new InMemoryBatchKvTable<RecallStats>()
  decisions = new PendingDecisionsStore(new InMemoryKvTable<PendingDecision>(), lock)
  snapshots = new SnapshotStore(new InMemoryKvTable<MemorySnapshot>())
  dreams = new DreamsStore(new InMemoryKvTable<DreamsRecord>(), new InMemoryKvTable<DreamMarks>())
  store = new MemoryStore(new FileTable({ root, stats, log: quiet, lock, journal, now: () => NOW }), quiet, stats)
  store.registerSteps(ledgerSteps(decisions, quiet))
  noReview = new NoReviewList(root)
  sessions = new Map([['s1', { header: { isSeeded: false }, inheritedEventCount: 0, events: S1_EVENTS() }]])
  requestReplies = []
  fillReplies = []
  fillPrompts = []
  runSeq = 0
})
afterEach(async () => {
  journal.close()
  await rm(root, { recursive: true, force: true })
})

async function dream(scope: Scope = GLOBAL) {
  const claims = new InMemoryKvTable<{ id: string }>()
  return runDreams(scope, { by: 'manual' }, {
    store, snapshots, decisions, dreams, log: quiet,
    claimScope: async (scope) => {
      const release = await claims.claim(scope.kind === 'global' ? 'global' : scope.workspacePath)
      return release === undefined ? { busy: scope } : { release }
    },
    activity: async () => ({ isComplete: true, workspaces: new Map() }),
    resolveLlm: async () => ({ llm, isSelected: true, fellBack: false }),
    config: () => ({ ...DREAMS_DEFAULTS, minChanges: 0, maxChangeRatio: 1 }),
    isGovernanceEnabled: () => true,
    plan: [maintainStep(store), drillDownStep({ store, decisions, host, noReview, maxDrillDowns: () => 5, now: () => NOW })],
    interval: () => () => {},
    now: () => NOW,
    newRunId: () => `run_${++runSeq}`,
  })
}

const anchor = (sessionId: string, eventRange: [number, number], at: number): SourceAnchor =>
  ({ sessionId, eventRange, sourceMode: 'user-explicit', at, change: 'refine' })
async function seed(rows: Array<Partial<MemoryRecord>>, scope: Scope = GLOBAL): Promise<void> {
  const at = scope.kind === 'workspace' ? { scope: 'workspace' as const, workspacePath: scope.workspacePath } : {}
  for (const row of rows) {
    const first = row.sourceTrail![0]!
    await store.create(record({
      createdAt: NOW, updatedAt: NOW, lastConfirmedAt: NOW, tags: [], ...at, ...row,
      source: { sessionId: first.sessionId, eventRange: first.eventRange, sourceMode: 'user-explicit' },
    }))
  }
  await store.maintain(scope)
}
const entryOf = async (id: string) => (await decisions.listSettled()).find(d => d.id === id)
const undo = (decisionId: string, op?: string, context: { workspacePath: string | undefined } = { workspacePath: undefined }) => executeUndo(
  { decisionId, ...(op !== undefined ? { op } : {}) }, context,
  { store, decisions, snapshots, dreams, log: quiet, ignores: { unignoreIfSame: async () => false }, now: () => NOW },
)

/** 决定的出处会话已经不在宿主的会话列表里：这个锚进报告的读不到清单。 */
const GONE_DECISION = { id: 'mem_d', type: 'decision', name: '包管理器', content: '项目改用 pnpm。', summary: '用 pnpm', sourceTrail: [anchor('s_gone', [0, 3], sec(0))] }
/** 状态页：补回一个过去的状态（依据是 s1 第二轮用户那句，开窗 [0,6] 时编号 4）。 */
const PAGE = { id: 'mem_p', type: 'project', name: '包管理现状', content: '现在用 pnpm', summary: '用 pnpm', factTime: '2025-09', sourceTrail: [anchor('s1', [0, 6], sec(0))] }
const RECOVER_FROM_USER = { result: 'recover', content: '用 npm', summary: '那时用 npm', factTime: '2024-03', evidence: [4] }

/** 一次运行：状态页补回一版（有回执），决定的锚读不到（报告里只有 unreadable，没有交给用户的稿）。 */
async function recoveredWithUnreadable() {
  await seed([GONE_DECISION, PAGE])
  requestReplies = [{ requests: [
    { id: 'mem_d', gap: 'missing-basis', anchor: 1, purpose: 'fill-gap' },
    { id: 'mem_p', gap: 'fact-gap', anchor: 1, purpose: 'fill-gap' },
  ] }]
  fillReplies = [RECOVER_FROM_USER]
  expect((await dream()).kind).toBe('completed')
  const entry = (await entryOf('run_1'))!
  expect(entry.recoveredVersions).toHaveLength(1)
  expect(entry.drillDown!.proposals).toEqual([])
  expect(entry.drillDown!.unreadable.map(u => [u.memoryId, u.reason])).toEqual([['mem_d', 'session-gone']])
  return entry
}

describe('撤销后条目的去留', () => {
  it('单撤最后一条补回回执后，报告里只剩读不到的锚：条目留着，报告原样', async () => {
    const entry = await recoveredWithUnreadable()
    expect(await undo('run_1', entry.recoveredVersions![0]!.op)).toMatchObject({ kind: 'undone' })
    const left = (await entryOf('run_1'))!
    expect(left.recoveredVersions ?? []).toEqual([])
    expect(left.drillDown).toEqual(entry.drillDown)
  })

  it('整批撤销带报告的批次：回执撤完，条目连同报告（读不到的锚）一起移出账本', async () => {
    await recoveredWithUnreadable()
    expect(await undo('run_1')).toMatchObject({ kind: 'undone' })
    expect(await entryOf('run_1')).toBeUndefined()
  })
})

describe('边界未知的会话开窗', () => {
  // 锚 [1,3] 的起点时间（sec 1）不晚于锚时间（sec 3）、下一条带时间的事件（sec 10）不早于它：按序号看对得上。
  // 按时间找回的那一轮从 seq 0 开始，整段平移成 [0,2]，工具结果（seq 3）不在里面
  const DECISION = { id: 'mem_d', type: 'decision', name: '包管理器', content: '项目改用 pnpm。', summary: '用 pnpm', sourceTrail: [anchor('s1', [1, 3], sec(3))] }
  const askFill = () => {
    requestReplies = [{ requests: [{ id: 'mem_d', gap: 'missing-basis', anchor: 1, purpose: 'fill-gap' }] }]
    fillReplies = [{ result: 'none' }]
  }

  it('边界清楚、序号和时间对得上：按序号原样读', async () => {
    await seed([DECISION])
    askFill()
    await dream()
    expect(fillPrompts[0]).toContain(USER_REASON)
    expect(fillPrompts[0]).toContain(TOOL_OUTPUT)
  })

  it('分不清哪些事件是自己的：不信序号，带改动性质的锚按时间重新定位、整段平移', async () => {
    sessions.set('s1', { header: { isSeeded: true }, inheritedEventCount: undefined, events: S1_EVENTS() })
    await seed([DECISION])
    askFill()
    await dream()
    expect(fillPrompts).toHaveLength(1)
    expect(fillPrompts[0]).toContain(USER_REASON)
    expect(fillPrompts[0]).toContain(ASSISTANT_REPLY)
    expect(fillPrompts[0]).not.toContain(TOOL_OUTPUT)
    expect(fillPrompts[0]).not.toContain(USER_PAST)
  })
})

describe('撤销补回的版本：找不全时不拿掉回执', () => {
  const W: Scope = { kind: 'workspace', workspacePath: '/proj/a' }
  const recoverPage = async (scope: Scope = GLOBAL) => {
    await seed([PAGE], scope)
    requestReplies = [{ requests: [{ id: 'mem_p', gap: 'fact-gap', anchor: 1, purpose: 'fill-gap' }] }]
    fillReplies = [RECOVER_FROM_USER]
    expect((await dream(scope)).kind).toBe('completed')
    expect((await entryOf('run_1'))!.recoveredVersions).toHaveLength(1)
  }
  const recoveredIn = async (scope: Scope) =>
    (await store.history.list(layerOf((await store.locate('mem_p', scope))!), 'mem_p')).versions.filter(v => v.kind === RECOVERED_VERSION)

  it('记忆文件读不出、一份副本都定位不到：回执留着、算进没撤的；文件修好后再撤，删掉补回的那一版', async () => {
    await recoverPage()
    const { filePath } = (await store.locate('mem_p', GLOBAL))!
    const original = await readFile(filePath, 'utf8')
    await writeFile(filePath, '---\nid: [\n---\n读不出')
    expect(await undo('run_1')).toMatchObject({ kind: 'undone', skipped: 1 })
    expect((await entryOf('run_1'))!.recoveredVersions).toHaveLength(1)
    await writeFile(filePath, original)
    expect(await recoveredIn(GLOBAL)).toHaveLength(1)
    expect(await undo('run_1')).toMatchObject({ kind: 'undone' })
    expect(await recoveredIn(GLOBAL)).toEqual([])
    expect(await entryOf('run_1')).toBeUndefined()
  })

  it('补回之后提升到全局、原项目又新建了同 id 的一条：原项目那份里没有这一版，到全局那份里按 op 找到删掉', async () => {
    await recoverPage(W)
    const { workspacePath: _w, ...rest } = (await store.get('mem_p', W))!
    await store.put({ ...rest, scope: 'global' }, W)
    await seed([{ ...PAGE, name: '另起的一条' }], W)
    expect(await recoveredIn(GLOBAL)).toHaveLength(1)
    expect(await undo('run_1', undefined, { workspacePath: '/proj/a' })).toMatchObject({ kind: 'undone' })
    expect(await recoveredIn(GLOBAL)).toEqual([])
    expect(await entryOf('run_1')).toBeUndefined()
  })

  it('预检放行之后、进写入段之前，带着那一版的记忆被迁到了别的项目：写入段里再过一次门，不删那一版，回执留着、算进没撤的', async () => {
    await recoverPage()
    const elsewhere: Scope = { kind: 'workspace', workspacePath: '/proj/b' }
    const section = store.writeSection.bind(store)
    let isMoved = false
    store.writeSection = async <T>(fn: () => Promise<T>): Promise<T> => {
      if (!isMoved) {
        isMoved = true
        const current = (await store.get('mem_p', GLOBAL))!
        await store.put({ ...current, scope: 'workspace', workspacePath: '/proj/b' }, GLOBAL)
      }
      return section(fn)
    }
    try {
      expect(await undo('run_1', undefined, { workspacePath: '/proj/a' })).toMatchObject({ kind: 'undone', skipped: 1 })
    } finally {
      store.writeSection = section
    }
    expect(isMoved).toBe(true)
    expect(await recoveredIn(elsewhere)).toHaveLength(1)
    expect((await entryOf('run_1'))!.recoveredVersions).toHaveLength(1)
  })
})

describe('收候选', () => {
  it('有一条空 id 的记忆（文件格式允许，不会有历史）：下钻跳过它，这一轮照常跑完，别的记忆照常交给模型', async () => {
    await store.create(record({ id: '', name: '没写 id 的旧记忆', createdAt: NOW, updatedAt: NOW, lastConfirmedAt: NOW, tags: [] }))
    await seed([PAGE])
    let requestPrompt = ''
    const complete = llm.complete
    llm.complete = async (prompt) => {
      if (prompt.system === DRILL_REQUEST_SYSTEM_PROMPT) requestPrompt = prompt.user
      return complete(prompt)
    }
    try {
      expect((await dream()).kind).toBe('completed')
    } finally {
      llm.complete = complete
    }
    expect(requestPrompt).toContain('mem_p')
  })
})

describe('运行收尾', () => {
  /** 决定：出处是 s1 第一轮；细化稿引了助手的话（编号 2），不直接写，交给用户确认。 */
  const DECISION = { id: 'mem_d', type: 'decision', name: '包管理器', content: '项目改用 pnpm。', summary: '用 pnpm', sourceTrail: [anchor('s1', [0, 3], sec(0))] }
  const REFINE_WITH_ASSISTANT = { result: 'refine', content: '项目改用 pnpm。依据：CI 里缓存快、装得快。', evidence: [1, 2] }
  const proposalsOf = async () => (await decisions.listSettled()).flatMap(d => d.drillDown?.proposals ?? []).map(p => p.memoryId)

  it('下钻报告没记上：这一轮按出错收，下次运行重做；存储恢复后再跑，交给用户的稿重新生成并记上；第一轮补回那一版的回执仍撤得掉', async () => {
    await seed([DECISION, PAGE])
    const askFill = () => {
      requestReplies = [{ requests: [
        { id: 'mem_d', gap: 'missing-basis', anchor: 1, purpose: 'fill-gap' },
        { id: 'mem_p', gap: 'fact-gap', anchor: 1, purpose: 'fill-gap' },
      ] }]
      fillReplies = [REFINE_WITH_ASSISTANT, RECOVER_FROM_USER]
    }
    askFill()
    const recordDrillReport = decisions.recordDrillReport.bind(decisions)
    decisions.recordDrillReport = async () => { throw new Error('账本写不进') }
    try {
      expect((await dream()).kind).toBe('failed')
    } finally {
      decisions.recordDrillReport = recordDrillReport
    }
    expect(await proposalsOf()).toEqual([])
    const firstOp = (await entryOf('run_1'))!.recoveredVersions![0]!.op
    askFill()
    expect((await dream()).kind).toBe('completed')
    expect(fillPrompts).toHaveLength(4)
    expect(await proposalsOf()).toEqual(['mem_d'])
    expect(await undo('run_1', firstOp)).toMatchObject({ kind: 'undone' })
    const left = (await store.history.list(layerOf((await store.locate('mem_p', GLOBAL))!), 'mem_p')).versions
    expect(left.some(v => v.writes.some(w => w.op === firstOp))).toBe(false)
  })
})
