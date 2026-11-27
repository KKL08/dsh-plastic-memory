import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileTable } from '../src/storage/file-table.ts'
import { OpJournal } from '../src/storage/op-journal.ts'
import { createRootLock } from '../src/storage/root-lock.ts'
import { SidecarStore } from '../src/storage/sidecar.ts'
import { CheckupCache } from '../src/storage/checkup-cache.ts'
import { CHECKUP_CACHE_FILE, GLOBAL_DIR, ARCHIVE_DIR } from '../src/storage/paths.ts'
import { MemoryStore } from '../src/store.ts'
import { PendingDecisionsStore, conflictFingerprint } from '../src/governance/decisions.ts'
import { SnapshotStore } from '../src/governance/snapshots.ts'
import { CheckupRecordStore } from '../src/governance/checkup-records.ts'
import { ledgerSteps } from '../src/governance/op-steps.ts'
import { kindOf, type AdviceIgnore, type MemorySnapshot, type PendingDecision, type ScanCacheEntry } from '../src/governance/schema.ts'
import type { SemanticLlm } from '../src/governance/semantic-scan.ts'
import type { ResolvedLlm } from '../src/governance/background-llm.ts'
import { DREAMS_DEFAULTS } from '../src/governance/dreams-gate.ts'
import { DreamsStore } from '../src/governance/dreams-records.ts'
import { TIER_SYSTEM_PROMPT } from '../src/governance/dreams-tiers.ts'
import { REFRESH_AFTER_MS } from '../src/governance/checkup-plan.ts'
import { holdCheckups } from '../src/gui/checkup-run.ts'
import { checkupStep } from '../src/tools/dreams-checkup.ts'
import { resolveFindingsStep } from '../src/tools/dreams-tiers.ts'
import { runDreams, type DreamsRunDeps, type DreamsRunResult, type DreamsStep } from '../src/tools/dreams-run.ts'
import type { ScanCoreDeps } from '../src/tools/scan.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'
import type { MemoryRecord, SourceAnchor } from '../src/record-schema.ts'
import type { SessionLog } from '../src/session-log.ts'
import { scopeCacheKey, type Scope } from '../src/scope.ts'
import { bigRecord, stubModel, type StubModel } from './helpers/checkup-env.ts'
import { noInstructions } from './helpers/instructions.ts'
import { sidecarSchemas } from './helpers/plugin-env.ts'
import { record } from './helpers/record.ts'
import { messageFrom } from './helpers/session-log.ts'

// 记忆梦境运行里的增量体检（测试切入点：一次梦境运行 runDreams，计划里是体检和处理矛盾两步）。记忆是真文件、侧表是真的
// SidecarStore、同一把记忆根写锁，认领是真的体检认领；宿主会话和模型是替身。本机时区固定成新加坡（UTC+8）。

const GLOBAL: Scope = { kind: 'global' }
const NOW = 1_800_000_000_000
const DAY_MS = 86_400_000
const OLD_AT = Date.UTC(2025, 2, 1, 2)
const NEW_AT = Date.UTC(2025, 5, 1, 2)

const ZONE = 'Asia/Singapore'
const savedTz = process.env.TZ
beforeAll(() => { process.env.TZ = ZONE })
afterAll(() => { if (savedTz === undefined) delete process.env.TZ; else process.env.TZ = savedTz })

let root: string
let clock: number
let journal: OpJournal
let resultsDb: CheckupCache
let store: MemoryStore
let decisions: PendingDecisionsStore
let snapshots: SnapshotStore
let dreams: DreamsStore
let checkups: CheckupRecordStore
let sidecar: SidecarStore<MemorySnapshot, PendingDecision, ScanCacheEntry, AdviceIgnore>
let sessions: Map<string, SessionLog>
let warnings: unknown[]
let runSeq: number
let tier: string
let tokenCap: unknown
/** 体检用的模型（体检选的那个）：照提示词里的 id 报矛盾。 */
let checkupModel: StubModel
/** 体检这一步取模型的结果；缺省给 checkupModel。 */
let resolveCheckupLlm: () => Promise<ResolvedLlm>
/** 梦境自己的模型：只答处理矛盾的核实。 */
let tierCalls: number
/** 活动表这次读不全（按有会话在跑算，梦境让路）。 */
let isBusy: boolean
/** 运行期间定时查让路的回调。 */
let poll: (() => void) | undefined

const dreamsModel: SemanticLlm = {
  model: 'dreams-model',
  complete: async (prompt) => {
    if (prompt.system !== TIER_SYSTEM_PROMPT) return JSON.stringify({ operations: [] })
    tierCalls++
    const cite = /\[#(\d+)\][^\n]*改用 pnpm/.exec(prompt.user)
    return JSON.stringify({
      ids: ['mem_old', 'mem_new'], subject: '这个项目的包管理器', dimension: '用哪个', compatible: false, newer: 'mem_new', change: 'state-change',
      uncertain: false, evidence: [Number(cite![1])], reason: '用户说从今天起改用 pnpm',
    })
  },
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pm-dreams-checkup-'))
  clock = NOW
  const quiet = { info() {}, warn() {}, error() {} }
  const lock = createRootLock({ root, log: quiet })
  journal = new OpJournal({ path: join(root, '.state', 'op-journal.sqlite'), log: quiet })
  resultsDb = new CheckupCache({ path: join(root, CHECKUP_CACHE_FILE), log: quiet })
  sidecar = new SidecarStore({ root, schemas: sidecarSchemas, lock, now: () => clock, log: quiet })
  store = new MemoryStore(new FileTable({ root, stats: sidecar.recallStats, log: quiet, lock, journal, now: () => clock }), quiet, sidecar.recallStats)
  decisions = new PendingDecisionsStore(sidecar.pending, lock)
  store.registerSteps(ledgerSteps(decisions, quiet))
  snapshots = new SnapshotStore(sidecar.snapshots)
  dreams = new DreamsStore(sidecar.dreams, sidecar.dreamMarks)
  checkups = new CheckupRecordStore(sidecar.checkups, { views: sidecar.scanCache, lock: sidecar.lock, log: quiet })
  sessions = new Map()
  warnings = []
  runSeq = 0
  tier = 'gatekeep'
  tokenCap = undefined
  checkupModel = stubModel({ findings: [{ type: 'conflict', ids: ['mem_old', 'mem_new'] }] })
  resolveCheckupLlm = async () => ({ llm: checkupModel, isSelected: true, fellBack: false })
  tierCalls = 0
  isBusy = false
  poll = undefined
})
afterEach(async () => {
  journal.close()
  resultsDb.close()
  await rm(root, { recursive: true, force: true })
})

/** 一条全局记忆，出处是会话 s_<id> 里 seq 1 那句用户的话。 */
async function memory(id: string, spec: { text: string; at: number; type?: string; mode?: string; factTime?: string }): Promise<MemoryRecord> {
  sessions.set(`s_${id}`, { header: { isSeeded: false }, inheritedEventCount: 0, events: [{ type: 'turn/start', seq: 0, time: spec.at }, messageFrom('user', 1, spec.text, spec.at)] })
  const trail: SourceAnchor[] = [{ sessionId: `s_${id}`, eventRange: [1, 1], sourceMode: (spec.mode ?? 'user-explicit') as SourceAnchor['sourceMode'], at: spec.at, change: 'create', by: 'main' }]
  const { source: _source, ...plain } = record({
    id, name: `${id} 的名称`, type: spec.type ?? 'knowledge', content: spec.text, summary: `${id} 的摘要`, createdAt: NOW, updatedAt: NOW, lastConfirmedAt: NOW,
    ...(spec.factTime !== undefined ? { factTime: spec.factTime } : {}),
  })
  await store.create({ ...plain, sourceTrail: trail })
  await store.maintain(GLOBAL)
  return (await store.get(id, GLOBAL))!
}
/** 新写下的一对矛盾：旧的说用 npm，新的说改用 pnpm。type 给 preference 时旧的一方算重要。 */
async function npmPair(type = 'knowledge') {
  const old = await memory('mem_old', { text: '项目用 npm 管依赖', at: OLD_AT, factTime: '2025-03-01', type, mode: type === 'knowledge' ? 'agent-inferred' : 'user-explicit' })
  const neu = await memory('mem_new', { text: '从今天起改用 pnpm', at: NEW_AT, factTime: '2025-06-01', type })
  return [old, neu] as const
}
const get = async (id: string) => (await store.get(id, GLOBAL))!

const scanDeps = (): Omit<ScanCoreDeps, 'checkups'> => ({
  store, decisions, cache: sidecar.scanCache, checkupCache: resultsDb, instructions: noInstructions,
  registry: buildTypeRegistry({ template: 'coding', customTypes: {} }), tokenCap: () => tokenCap,
  log: { info() {}, warn: (_message: string, detail?: unknown) => { warnings.push(detail) }, error() {} }, now: () => clock,
})
const host = {
  readSessionLog: async (id: string) => sessions.get(id) ?? null,
  listSessions: async () => [...sessions.keys()].map(id => ({ id, cwd: undefined, isSubagent: false, isLive: false })),
  archivedSessionIds: async () => new Set<string>(),
}
const plan = (before: DreamsStep[] = []): DreamsStep[] => [
  ...before,
  checkupStep({ scan: scanDeps(), resolveLlm: () => resolveCheckupLlm() }),
  resolveFindingsStep({
    store, decisions, dreams, host, noReview: { isMarkedNoReview: async () => false }, memoryRoot: root,
    tier: () => tier, focusTypes: () => ['preference', 'profile', 'decision'], now: () => clock,
  }),
]
function deps(steps: DreamsStep[]): DreamsRunDeps {
  return {
    store, snapshots, decisions, dreams,
    log: { info() {}, warn: (_message, detail) => { warnings.push(detail) }, error() {} },
    // 和接线层一样：梦境整次运行占着这个范围的体检认领
    claimScope: (scope, onLost) => holdCheckups(checkups, [scope], { interval: () => () => {}, onLost, log: { info() {}, warn() {}, error() {} } }),
    activity: async () => ({ isComplete: !isBusy, workspaces: new Map() }),
    resolveLlm: async () => ({ llm: dreamsModel, isSelected: true, fellBack: false }),
    config: () => ({ ...DREAMS_DEFAULTS, minChanges: 0, maxChangeRatio: 1 }),
    isGovernanceEnabled: () => true,
    plan: steps,
    interval: (callback) => { poll = callback; return () => {} },
    now: () => clock,
    newRunId: () => `run_${++runSeq}`,
  }
}
const runOnce = (by: 'manual' | 'auto' = 'manual', before: DreamsStep[] = []) => runDreams(GLOBAL, { by }, deps(plan(before)))
async function run(by: 'manual' | 'auto' = 'manual', before: DreamsStep[] = []): Promise<DreamsRunResult> {
  const r = await runOnce(by, before)
  if (r.kind !== 'completed') throw warnings.find(w => w instanceof Error) ?? new Error(`运行没做完：${r.kind}`)
  return r
}
const lastResult = async () => (await dreams.read()).records.get('global')?.lastResult
const checkupSkips = async () => ((await lastResult())?.skipped?.items ?? []).filter(i => i.step === 'checkup').map(i => i.reason)
const stepStates = (r: DreamsRunResult) => Object.fromEntries(r.steps.map(s => [s.name, s.state]))

describe('梦境开着、自动体检关着：一次运行自己查出新写入的矛盾，同一次运行里处理', () => {
  it.each(['manual', 'auto'] as const)('不重要的一对（%s 触发）：体检挂账，处理矛盾那一步直接处理掉', async (by) => {
    await dreams.setEnabled('all', true)
    await npmPair()
    expect(await decisions.list()).toEqual([])
    const r = await run(by)
    expect(stepStates(r)).toEqual({ checkup: 'done', 'resolve-findings': 'done' })
    // 体检用体检选的模型，核实用梦境的模型
    expect(checkupModel.calls).toHaveLength(1)
    expect(tierCalls).toBe(1)
    expect((await get('mem_old')).status).toBe('deleted')
    expect(await decisions.list()).toEqual([])
    expect(await checkupSkips()).toEqual([])
  })

  it.each([
    ['gatekeep', 'important-pending', 'active'],
    ['trust', undefined, 'deleted'],
  ] as const)('重要的一对，%s档：把关档改成「重要、等你定」，信任档直接处理', async (t, kind, oldStatus) => {
    tier = t
    await npmPair('preference')
    await run()
    expect(tierCalls).toBe(1)
    expect((await get('mem_old')).status).toBe(oldStatus)
    const open = await decisions.list()
    expect(open.map(kindOf)).toEqual(kind === undefined ? [] : [kind])
  })

  it('梦境里的体检不写体检完成记录、不约下次，界面上「上次体检」不变', async () => {
    await npmPair()
    await run()
    expect(await checkups.list()).toEqual([])
  })
})

describe('认领', () => {
  it('运行期间同范围的手动、自动体检拿不到认领；运行结束后拿得到', async () => {
    await npmPair()
    const busy: unknown[] = []
    const complete = checkupModel.complete
    checkupModel.complete = async (...args) => {
      busy.push(await checkups.claim([GLOBAL]))
      busy.push(await holdCheckups(checkups, [GLOBAL], { interval: () => () => {}, onLost: () => {}, log: { info() {}, warn() {}, error() {} } }))
      return complete(...args)
    }
    await run()
    expect(busy).toEqual([{ busy: GLOBAL }, { busy: GLOBAL }])
    const after = await checkups.claim([GLOBAL])
    expect('claims' in after).toBe(true)
  })
})

describe('用量和上限', () => {
  it('体检这一步的实际用量计入这次运行的用量和七天用量', async () => {
    await npmPair()
    const complete = checkupModel.complete
    checkupModel.complete = async (input, signal, onUsage) => { onUsage?.(40); return complete(input, signal) }
    const r = await run()
    expect(r.usageTokens).toBe(40)
    expect((await dreams.read()).usageRuns).toEqual([expect.objectContaining({ runId: 'run_1', tokens: 40 })])
  })

  it('体检的 token 上限照常管排批：到上限停下记一条跳过，后面的步骤照常，下一次运行接着查', async () => {
    for (const id of ['mem_b1', 'mem_b2']) await store.put(bigRecord({ id, createdAt: id === 'mem_b1' ? 1 : 2 }))
    tokenCap = 1
    const r = await run()
    expect(stepStates(r)).toEqual({ checkup: 'done', 'resolve-findings': 'done' })
    expect(checkupModel.calls).toHaveLength(1)
    expect(await checkupSkips()).toEqual(['capped'])
    await run()
    expect(checkupModel.calls).toHaveLength(2)
    expect(await checkupSkips()).toEqual([])
  })
})

describe('体检这一步没做成：记一条跳过，后面的步骤照常处理账本里已有的发现', () => {
  /** 账本里已有一对（之前的体检挂的）。 */
  async function existingFinding() {
    const [old, neu] = await npmPair()
    await decisions.upsert({ memoryIds: [old.id, neu.id], summary: '包管理器的说法对不上', workspaces: ['global', 'global'], fingerprint: conflictFingerprint([old, neu]) }, NOW)
  }

  it.each([
    ['模型出错', 'failed', () => { checkupModel.fail = () => new Error('上游 500') }],
    // 不是这次运行叫停的取消（模型或宿主自己抛的）：照出错记，不当让路
    ['模型自己报取消', 'failed', () => { checkupModel.fail = () => new DOMException('上游取消了这次请求', 'AbortError') }],
    ['宿主报模型用不了', 'model-unavailable', () => { checkupModel.fail = () => Object.assign(new Error('请先登录'), { code: 'ACCOUNT_SIGN_IN_REQUIRED' }) }],
    ['拿不到模型', 'model-unavailable', () => { resolveCheckupLlm = async () => ({ llm: null, isSelected: false, fellBack: true }) }],
    ['取模型出错', 'failed', () => { resolveCheckupLlm = async () => { throw new Error('选择表读不出') } }],
    ['体检核心出错', 'failed', () => {
      const list = store.listWorkspaceDirs.bind(store)
      store.listWorkspaceDirs = async () => { store.listWorkspaceDirs = list; throw new Error('目录列不出') }
    }],
  ])('%s', async (_name, reason, breakIt) => {
    await existingFinding()
    await breakIt()
    const r = await run()
    expect(stepStates(r)).toEqual({ checkup: 'done', 'resolve-findings': 'done' })
    expect(await checkupSkips()).toEqual([reason])
    expect(tierCalls).toBe(1)
    expect((await get('mem_old')).status).toBe('deleted')
  })

  it('这个范围读不全：记 read-incomplete，账本里已有的那对照常交给处理矛盾（把关档的重要一对改成「重要、等你定」）', async () => {
    const [old, neu] = await npmPair('preference')
    await decisions.upsert({ memoryIds: [old.id, neu.id], summary: '包管理器的说法对不上', workspaces: ['global', 'global'], fingerprint: conflictFingerprint([old, neu]) }, NOW)
    // 全局的最近删除目录读不了（换成同名文件）：体检算没读全
    await writeFile(join(root, GLOBAL_DIR, ARCHIVE_DIR), '')
    const r = await run()
    expect(stepStates(r)).toEqual({ checkup: 'done', 'resolve-findings': 'done' })
    expect(await checkupSkips()).toEqual(['read-incomplete'])
    expect(tierCalls).toBe(1)
    expect((await decisions.list()).map(kindOf)).toEqual(['important-pending'])
  })
})

describe('没有新变化', () => {
  it('连续两次运行之间没有新变化：第二次体检这一步不调模型；过了刷新时间也不调', async () => {
    await memory('mem_a', { text: '用 vitest 跑测试', at: OLD_AT })
    checkupModel.findings = []
    await run()
    expect(checkupModel.calls).toHaveLength(1)
    clock += DAY_MS
    await run()
    expect(checkupModel.calls).toHaveLength(1)
    clock += REFRESH_AFTER_MS
    await run()
    expect(checkupModel.calls).toHaveLength(1)
  })
})

describe('让路', () => {
  it('体检的模型调用返回时该让路了：这次运行按让路收，这一批的结论不写、不挂账、不写视图；下一次运行重查这一批并处理', async () => {
    await npmPair()
    const complete = checkupModel.complete
    checkupModel.complete = async (...args) => {
      const reply = await complete(...args)
      if (checkupModel.calls.length === 1) {
        isBusy = true
        poll!()
        await new Promise<void>(resolve => setImmediate(resolve))
      }
      return reply
    }
    const r = await runOnce()
    expect(r.kind).toBe('yielded')
    expect(stepStates(r)).toEqual({ checkup: 'not-run', 'resolve-findings': 'not-run' })
    expect(await decisions.list()).toEqual([])
    expect(await sidecar.scanCache.get(scopeCacheKey(GLOBAL))).toBeUndefined()
    isBusy = false
    await run()
    expect(checkupModel.calls).toHaveLength(2)
    expect(tierCalls).toBe(1)
    expect((await get('mem_old')).status).toBe('deleted')
  })
})

describe('合并的存活方', () => {
  it('体检查出的矛盾牵涉这次留给下次的那条：这次不处理，下一次运行处理', async () => {
    await npmPair()
    const held: DreamsStep = { name: 'merge-fragments', needsChanges: false, run: async (ctx) => { ctx.holdForNextRun(['mem_new']) } }
    await run('manual', [held])
    expect(await decisions.list()).toHaveLength(1)
    expect(tierCalls).toBe(0)
    await run()
    expect(tierCalls).toBe(1)
    expect(await decisions.list()).toEqual([])
  })
})
