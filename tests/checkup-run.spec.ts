import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmod, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { FileTable } from '../src/storage/file-table.ts'
import { SidecarStore } from '../src/storage/sidecar.ts'
import { STATE_DIR } from '../src/storage/paths.ts'
import { MemoryStore } from '../src/store.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'
import { PendingDecisionsStore } from '../src/governance/decisions.ts'
import { SnapshotStore } from '../src/governance/snapshots.ts'
import { AdviceIgnoreStore } from '../src/governance/advice-ignores.ts'
import { CheckupRecordStore } from '../src/governance/checkup-records.ts'
import { AutoCheckupSettingStore } from '../src/governance/auto-checkups.ts'
import { memorySnapshotSchema, pendingDecisionSchema, scanCacheSchema, adviceIgnoreSchema } from '../src/governance/schema.ts'
import type { SemanticLlm } from '../src/governance/semantic-scan.ts'
import { RETENTION_MS } from '../src/retention.ts'
import { ViewWriter, collectCheckupView, collectGlobalViews } from '../src/gui/view-writer.ts'
import { runCheckup, type CheckupRunDeps, type CheckupRunInput } from '../src/gui/checkup-run.ts'
import { GUI_VIEW_DIR, GUI_VIEW_FILES, checkupKey, pendingItemKey, pendingViewSchema, type PendingItem } from '../src/gui/contract.ts'
import type { Scope } from '../src/scope.ts'
import { record } from './helpers/record.ts'
import { FAKE_SECRET } from './helpers/secrets.ts'

// 一次体检：真实临时目录（FileTable + .state 侧表 + 视图文件），体检核心用真的；
// 只把进程边界换掉：宿主模型（假 llm）、心跳计时（手动触发）、时钟、文件系统故障。

const NOW = 10 * RETENTION_MS
const SESSION_WS = '/tmp/pm-run-session'
const OTHER_WS = '/tmp/pm-run-other'
const GLOBAL = { kind: 'global' as const }
const SESSION = { kind: 'workspace' as const, workspacePath: SESSION_WS }
const OTHER = { kind: 'workspace' as const, workspacePath: OTHER_WS }
const registry = buildTypeRegistry({ template: 'coding', customTypes: {} })
const quietLog = { info() {}, warn() {}, error() {} }
const schemas = { snapshots: memorySnapshotSchema, pending: pendingDecisionSchema, scanCache: scanCacheSchema, adviceIgnores: adviceIgnoreSchema }

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'pm-checkup-run-')) })
afterEach(async () => {
  await chmod(join(root, GUI_VIEW_DIR), 0o700).catch(() => {})
  await rm(root, { recursive: true, force: true })
})

/** 心跳计时：记下登记的回调，由测试手动触发。 */
function manualHeartbeat() {
  const beats: Array<{ callback: () => void; delayMs: number; isLive: boolean }> = []
  const interval = (callback: () => void, delayMs: number) => {
    const beat = { callback, delayMs, isLive: true }
    beats.push(beat)
    return () => { beat.isLive = false }
  }
  return { beats, interval }
}

function env(opts: { log?: CheckupRunDeps['log']; views?: (w: ViewWriter) => CheckupRunDeps['views']; onClaimChanged?: () => Promise<void> } = {}) {
  const clock = { now: NOW }
  const sidecar = new SidecarStore({ root, schemas, now: () => clock.now, log: quietLog })
  const store = new MemoryStore(new FileTable({ root, stats: sidecar.recallStats, now: () => clock.now }), quietLog, sidecar.recallStats)
  const decisions = new PendingDecisionsStore(sidecar.pending)
  const snapshots = new SnapshotStore(sidecar.snapshots)
  const cache = sidecar.scanCache
  const ignores = new AdviceIgnoreStore(sidecar.adviceIgnores)
  const checkups = new CheckupRecordStore(sidecar.checkups)
  const autoCheckups = new AutoCheckupSettingStore(sidecar.autoCheckups)
  const checkupView = () => collectCheckupView({ store, checkups, autoCheckups, cache, now: () => clock.now })
  const writer = new ViewWriter({
    memoryRoot: root, log: quietLog,
    collect: () => collectGlobalViews({ store, decisions, snapshots, cache, ignores, checkups, autoCheckups, registry, memoryRoot: root, now: () => clock.now, log: quietLog }),
    collectCheckups: checkupView,
    now: () => clock.now, sleep: async () => {},
  })
  const heartbeat = manualHeartbeat()
  const deps: CheckupRunDeps = {
    scan: { store, registry, decisions, cache, ignores },
    checkups, views: opts.views?.(writer) ?? writer,
    interval: heartbeat.interval,
    ...(opts.onClaimChanged !== undefined ? { onClaimChanged: opts.onClaimChanged } : {}),
    now: () => clock.now, log: opts.log ?? quietLog,
  }
  const run = (input: Partial<CheckupRunInput> & Pick<CheckupRunInput, 'target' | 'llm'>) =>
    runCheckup({ by: 'manual', baseline: null, currentWorkspace: SESSION_WS, ...input }, deps)
  /** 同一个记忆根上的另一个宿主进程：另一份侧表（同一个时钟）。 */
  const otherProcess = () => new SidecarStore({ root, schemas, now: () => clock.now, log: quietLog }).checkups
  const recordOf = async (key: string) => (await checkups.list()).find(r => r.id === key)
  const readPending = async () => pendingViewSchema.parse(JSON.parse(await readFile(join(root, GUI_VIEW_DIR, GUI_VIEW_FILES.pending), 'utf8')))
  return { clock, store, decisions, cache, checkups, autoCheckups, checkupView, heartbeat, run, otherProcess, recordOf, readPending }
}
type Env = ReturnType<typeof env>

async function seedScopes(e: Env) {
  await e.store.create(record({ id: 'mem_g', name: '全局', content: '回答用中文' }))
  await e.store.create(record({ id: 'mem_s', name: '本项目', content: '用 pnpm', scope: 'workspace', workspacePath: SESSION_WS }))
  await e.store.create(record({ id: 'mem_o', name: '别的项目', content: '用 npm', scope: 'workspace', workspacePath: OTHER_WS }))
}

/**
 * 模型只报这次输入里有的记忆之间的发现；每次调用宿主报 usage 个 token（不给就是宿主没报）。
 * gate 给出时等它开了再回（不理会取消信号：模型在认领丢了之后才回来）。
 */
function answering(findings: object[], opts: { usage?: number; gate?: Promise<void> } = {}) {
  const calls: string[] = []
  let onCall: (() => void) | undefined
  const called = new Promise<void>(resolve => { onCall = resolve })
  const llm: SemanticLlm = {
    complete: async (input, _signal, onUsage) => {
      calls.push(input.user)
      onCall?.()
      if (opts.gate !== undefined) await opts.gate
      if (opts.usage !== undefined) onUsage?.(opts.usage)
      const text = JSON.stringify(input)
      return JSON.stringify({ findings: findings.filter(f => (f as { memoryIds: string[] }).memoryIds.every(id => text.includes(id))) })
    },
  }
  return { llm, calls, called }
}
const quiet = answering([]).llm
const hostError = (code: string): SemanticLlm => ({ complete: async () => { throw Object.assign(new Error(`host ${code}`), { code }) } })

describe('认领', () => {
  it('PA-30 范围正在体检（别的进程认领着）：返回正忙并带上是哪个作用域，没有调用模型，不写缓存和完成记录；别的范围照常体检', async () => {
    const m = answering([])
    const e = env()
    await seedScopes(e)
    const other = e.otherProcess()
    const held = await other.claimRefreshable(checkupKey(SESSION))
    expect(await e.run({ target: SESSION, llm: m.llm })).toEqual({ kind: 'busy', scope: SESSION })
    expect(m.calls).toEqual([])
    expect(await e.cache.list()).toEqual([])
    expect(await e.checkups.list()).toEqual([])
    // 别的进程的认领原样留着
    expect(await other.isClaimed(checkupKey(SESSION))).toBe(true)
    expect((await e.run({ target: OTHER, llm: m.llm })).kind).toBe('done')
    expect(m.calls).toHaveLength(1)
    await held!.release()
  })

  it('PA-30 「全部」要认领所有范围：有一个认领不到就整个回正忙（带那个作用域），已认领的范围立刻放掉', async () => {
    const m = answering([])
    const e = env()
    await seedScopes(e)
    const other = e.otherProcess()
    const held = await other.claimRefreshable(checkupKey(OTHER))
    expect(await e.run({ target: { kind: 'all' }, llm: m.llm })).toEqual({ kind: 'busy', scope: OTHER })
    expect(m.calls).toEqual([])
    expect(await e.checkups.list()).toEqual([])
    for (const scope of [GLOBAL, SESSION]) {
      const again = await other.claimRefreshable(checkupKey(scope))
      expect(again, checkupKey(scope)).toBeDefined()
      await again!.release()
    }
    await held!.release()
    expect((await e.run({ target: { kind: 'all' }, llm: m.llm })).kind).toBe('done')
  })

  describe('「全部」只查开跑时认领到的范围：认领之后才建的项目不查、不写完成记录', () => {
    const LATE = { kind: 'workspace' as const, workspacePath: '/tmp/pm-run-late' }
    /** 认领到之后（认领变化的通知里）新建一个项目。 */
    const envWithLateProject = () => {
      let isCreated = false
      const e: Env = env({
        onClaimChanged: async () => {
          if (isCreated) return
          isCreated = true
          await e.store.create(record({ id: 'mem_late', name: '后来的', content: '用 bun', scope: 'workspace', workspacePath: LATE.workspacePath }))
        },
      })
      return e
    }

    it('有项目：只查认领到的全局和项目', async () => {
      const e = envWithLateProject()
      await seedScopes(e)
      expect((await e.run({ target: { kind: 'all' }, llm: quiet })).kind).toBe('done')
      for (const scope of [GLOBAL, SESSION, OTHER]) expect((await e.recordOf(checkupKey(scope)))?.completed).toEqual({ startedAt: NOW, completedAt: NOW, by: 'manual' })
      expect(await e.recordOf(checkupKey(LATE))).toBeUndefined()
      expect((await e.recordOf('all'))?.lastResult).toMatchObject({ by: 'manual', completedAt: NOW })
    })

    it('还没有项目：只查全局，结果仍记在「全部」名下', async () => {
      const e = envWithLateProject()
      await e.store.create(record({ id: 'mem_g', name: '全局', content: '回答用中文' }))
      expect((await e.run({ target: { kind: 'all' }, llm: quiet })).kind).toBe('done')
      expect((await e.recordOf(checkupKey(GLOBAL)))?.completed).toEqual({ startedAt: NOW, completedAt: NOW, by: 'manual' })
      expect(await e.recordOf(checkupKey(LATE))).toBeUndefined()
      expect((await e.recordOf('all'))?.lastResult).toMatchObject({ by: 'manual', completedAt: NOW })
    })
  })
})

describe('取消', () => {
  const conflict = { type: 'conflict', memoryIds: ['mem_s', 'mem_s2'], summary: '包管理器矛盾', suggestedAction: '裁决' }
  async function seedConflicting(e: Env) {
    await seedScopes(e)
    await e.store.create(record({ id: 'mem_s2', name: '本项目二', content: '用 yarn', scope: 'workspace', workspacePath: SESSION_WS }))
  }

  it('PA-31 体检中途认领被别的进程接手：返回取消，不写缓存、不挂账、不写完成记录和最近一次结果，这个范围仍到期', async () => {
    let open!: () => void
    const m = answering([conflict], { gate: new Promise<void>(resolve => { open = resolve }) })
    const infos: string[] = []
    const e = env({ log: { info: (msg: string) => { infos.push(msg) }, warn() {}, error() {} } })
    await seedConflicting(e)
    await e.autoCheckups.set(SESSION, 1)
    const running = e.run({ target: SESSION, llm: m.llm, by: 'auto' })
    await m.called
    expect(e.heartbeat.beats.map(b => [b.delayMs, b.isLive])).toEqual([[10_000, true]])
    // 别的进程把它当残留清掉、接手了
    await rm(join(root, STATE_DIR, 'checkups', `${createHash('sha1').update(SESSION_WS).digest('hex')}.claim`))
    const taker = await e.otherProcess().claimRefreshable(checkupKey(SESSION))
    expect(taker).toBeDefined()
    e.heartbeat.beats[0]!.callback()
    // 心跳发现之后模型才回来
    await vi.waitFor(() => { expect(infos.some(msg => msg.includes('被别的进程接手'))).toBe(true) })
    open()
    expect(await running).toEqual({ kind: 'cancelled' })
    expect(await e.cache.list()).toEqual([])
    expect(await e.decisions.list()).toEqual([])
    expect(await e.recordOf(checkupKey(SESSION))).toBeUndefined()
    expect((await e.checkupView()).scopes.find(s => checkupKey(s.scope) === checkupKey(SESSION))?.isDue).toBe(true)
    expect(e.heartbeat.beats[0]!.isLive).toBe(false)
    // 接手者的认领没被旧持有者删掉
    expect(await e.otherProcess().isClaimed(checkupKey(SESSION))).toBe(true)
    await taker!.release()
  })

  it('调用方取消（插件卸载）：返回取消，不写完成记录、结果、失败，认领放掉', async () => {
    let open!: () => void
    const m = answering([conflict], { gate: new Promise<void>(resolve => { open = resolve }) })
    const e = env()
    await seedConflicting(e)
    const controller = new AbortController()
    const running = e.run({ target: SESSION, llm: m.llm, by: 'auto', signal: controller.signal })
    await m.called
    controller.abort(new DOMException('plugin unloaded', 'AbortError'))
    open()
    expect(await running).toEqual({ kind: 'cancelled' })
    expect(await e.checkups.list()).toEqual([])
    expect(await e.decisions.list()).toEqual([])
    expect(await e.otherProcess().isClaimed(checkupKey(SESSION))).toBe(false)
  })

  it('取消落在体检提交之后、写结果之前（重写视图时）：体检算做完（完成记录在），只是不比新增、不写最近一次结果', async () => {
    const controller = new AbortController()
    const e = env({ views: w => ({ collectViews: () => w.collectViews(), rewriteAll: () => { controller.abort(new DOMException('plugin unloaded', 'AbortError')); return w.rewriteAll() } }) })
    await seedScopes(e)
    const r = await e.run({ target: SESSION, llm: quiet, signal: controller.signal, by: 'auto' })
    expect(r).toMatchObject({ kind: 'done' })
    expect(r).not.toHaveProperty('compared')
    const rec = (await e.recordOf(checkupKey(SESSION)))!
    expect(rec.completed).toMatchObject({ by: 'auto' })
    expect(rec.lastResult).toBeUndefined()
    expect(rec.failure).toBeUndefined()
  })

  it('全部体检写下完成记录之后、跨项目分析时取消：体检算做完，视图照样重写', async () => {
    const controller = new AbortController()
    let rewrites = 0
    const e = env({ views: w => ({ collectViews: () => w.collectViews(), rewriteAll: () => { rewrites++; return w.rewriteAll() } }) })
    await seedScopes(e)
    const llm: SemanticLlm = {
      complete: async () => {
        // 完成记录已写下才到的调用就是提交之后的跨项目分析
        if ((await e.recordOf(checkupKey(GLOBAL)))?.completed !== undefined) controller.abort(new DOMException('plugin unloaded', 'AbortError'))
        return JSON.stringify({ findings: [] })
      },
    }
    const r = await e.run({ target: { kind: 'all' }, llm, signal: controller.signal })
    expect([r.kind, rewrites]).toEqual(['done', 1])
  })

  it('全部体检各范围内容检查都没做成、跨项目分析时取消：照样重写视图（账本和提升候选已经写下）', async () => {
    const controller = new AbortController()
    let rewrites = 0
    const e = env({ views: w => ({ collectViews: () => w.collectViews(), rewriteAll: () => { rewrites++; return w.rewriteAll() } }) })
    await seedScopes(e)
    await e.store.create(record({ id: 'mem_g2', name: '全局二', content: '回答简短' }))
    await e.store.create(record({ id: 'mem_s2', name: '本项目二', content: '用 yarn', scope: 'workspace', workspacePath: SESSION_WS }))
    await e.store.create(record({ id: 'mem_o2', name: '别的项目二', content: '用 bun', scope: 'workspace', workspacePath: OTHER_WS }))
    const llm: SemanticLlm = {
      complete: async (input) => {
        if (input.system.includes('多个项目（workspace）')) controller.abort(new DOMException('plugin unloaded', 'AbortError'))
        return '不是 JSON'
      },
    }
    await e.run({ target: { kind: 'all' }, llm, signal: controller.signal })
    expect([await e.recordOf(checkupKey(GLOBAL)), rewrites]).toEqual([undefined, 1])
  })

  it('取消后刷新视图出错（视图目录不可写）：体检照样回做完，不往外抛，记一条日志', async () => {
    const controller = new AbortController()
    const warns: string[] = []
    const e = env({
      log: { info() {}, warn: (msg: string) => { warns.push(msg) }, error() {} },
      views: w => ({ collectViews: () => w.collectViews(), rewriteAll: async () => { throw new Error('ENOSPC') } }),
    })
    await seedScopes(e)
    const llm: SemanticLlm = {
      complete: async () => {
        if ((await e.recordOf(checkupKey(GLOBAL)))?.completed !== undefined) controller.abort(new DOMException('plugin unloaded', 'AbortError'))
        return JSON.stringify({ findings: [] })
      },
    }
    expect((await e.run({ target: { kind: 'all' }, llm, signal: controller.signal })).kind).toBe('done')
    expect(warns.some(m => m.includes('视图'))).toBe(true)
  })

  it('完成记录的开始时间是核心开读的时刻，不含认领和体检前收集视图的时间', async () => {
    let isAdvanced = false
    const e: Env = env({ onClaimChanged: async () => { if (!isAdvanced) { isAdvanced = true; e.clock.now = NOW + 5000 } } })
    await seedScopes(e)
    expect((await e.run({ target: SESSION, llm: quiet })).kind).toBe('done')
    expect((await e.recordOf(checkupKey(SESSION)))?.completed).toEqual({ startedAt: NOW + 5000, completedAt: NOW + 5000, by: 'manual' })
  })

  it('PA-32 认领后确认返回 false：放掉认领、算取消，不调模型、不写任何记录', async () => {
    const m = answering([])
    const e = env()
    await seedScopes(e)
    expect(await e.run({ target: SESSION, llm: m.llm, by: 'auto', confirmHeld: async () => false })).toEqual({ kind: 'cancelled' })
    expect(m.calls).toEqual([])
    expect(await e.checkups.list()).toEqual([])
    expect(await e.otherProcess().isClaimed(checkupKey(SESSION))).toBe(false)
  })
})

describe('做完：重写视图与最近一次结果', () => {
  const globalConflict = { type: 'conflict', memoryIds: ['mem_g1', 'mem_g2'], summary: '回答语言矛盾', suggestedAction: '裁决' }
  const crossConflict = { type: 'conflict', memoryIds: ['mem_g1', 'mem_s1'], summary: '全局和本项目矛盾', suggestedAction: '裁决' }
  const redundancy = { type: 'redundancy', memoryIds: ['mem_s1', 'mem_s2'], summary: '说的是一件事' }
  const otherUnclear = { type: 'unclear', memoryIds: ['mem_o'], summary: '说得不清楚' }
  async function seed(e: Env) {
    await e.store.create(record({ id: 'mem_g1', name: '全局甲', content: '回答用中文' }))
    await e.store.create(record({ id: 'mem_g2', name: '全局乙', content: '回答用英文' }))
    await e.store.create(record({ id: 'mem_s1', name: '本项目甲', content: '测试用 vitest', scope: 'workspace', workspacePath: SESSION_WS }))
    await e.store.create(record({ id: 'mem_s2', name: '本项目乙', content: '单测跑 vitest', scope: 'workspace', workspacePath: SESSION_WS }))
    await e.store.create(record({ id: 'mem_o', name: '别的项目', content: '那个配置', scope: 'workspace', workspacePath: OTHER_WS }))
  }
  const resultOf = async (e: Env, scope: Scope) => (await e.recordOf(checkupKey(scope)))?.lastResult
  /** 待处理视图里某类条目的身份。 */
  const keyOf = async (e: Env, pick: (i: PendingItem) => boolean) => {
    const items = (await e.readPending()).items.filter(pick)
    expect(items).toHaveLength(1)
    return pendingItemKey(items[0]!)
  }
  const conflictOf = (a: string, b: string) => (i: PendingItem) => i.kind === 'conflict-horizontal' && i.left?.id === a && i.right?.id === b
  const adviceOf = (type: string) => (i: PendingItem) => i.kind === 'advice' && i.type === type
  const sorted = (keys: readonly string[]) => [...keys].sort()

  it('PA-34 项目体检做完立即重写视图；记下体检标识、属于本项目的新增身份与条数、宿主报的用量、说明码；全局自己的记录不动', async () => {
    const { llm, calls } = answering([crossConflict, redundancy], { usage: 300 })
    const e = env()
    await seed(e)
    const r = await e.run({ target: SESSION, llm })
    // 返回时视图已经写好：新冲突已在待处理里
    const cc = await keyOf(e, conflictOf('mem_g1', 'mem_s1'))
    expect(r).toMatchObject({ kind: 'done', usageTokens: calls.length * 300, compared: { after: { pending: await e.readPending() } } })
    expect(await resultOf(e, SESSION)).toEqual({
      checkupId: expect.any(String), by: 'manual', completedAt: NOW,
      added: { keys: [cc, await keyOf(e, adviceOf('redundancy'))], pending: 1, advice: 1 },
      globalAdded: { keys: [], pending: 0, advice: 0 },
      usageTokens: calls.length * 300,
      notes: [{ code: 'baseline-missing' }],
    })
    expect(await resultOf(e, GLOBAL)).toBeUndefined()
    expect(await e.recordOf('all')).toBeUndefined()
  })

  it('PA-34 新增归属：项目体检顺带发现两条全局记忆之间的冲突，项目的新增里不算它，记在全局名下；全局和本项目之间的冲突算本项目的', async () => {
    const e = env()
    await seed(e)
    await e.run({ target: SESSION, llm: answering([globalConflict, crossConflict]).llm })
    const result = (await resultOf(e, SESSION))!
    expect(result.added).toEqual({ keys: [await keyOf(e, conflictOf('mem_g1', 'mem_s1'))], pending: 1, advice: 0 })
    expect(result.globalAdded).toEqual({ keys: [await keyOf(e, conflictOf('mem_g1', 'mem_g2'))], pending: 1, advice: 0 })
  })

  it('PA-34 全部体检：每个被查的范围各写自己的结果（同一个体检标识），另写键 all 的一条（新增按身份去重、按所属范围分组，带用量和说明）', async () => {
    const { llm, calls } = answering([globalConflict, crossConflict, redundancy, otherUnclear], { usage: 100 })
    const e = env()
    await seed(e)
    expect((await e.run({ target: { kind: 'all' }, llm })).kind).toBe('done')
    const gc = await keyOf(e, conflictOf('mem_g1', 'mem_g2'))
    const cc = await keyOf(e, conflictOf('mem_g1', 'mem_s1'))
    const red = await keyOf(e, adviceOf('redundancy'))
    const unclear = await keyOf(e, adviceOf('unclear'))
    const [global, session, other] = await Promise.all([GLOBAL, SESSION, OTHER].map(s => resultOf(e, s)))
    const all = (await e.recordOf('all'))!
    const checkupId = all.lastResult!.checkupId
    // 说明码各记各的范围（没有基线对每个范围都成立）；用量是整次体检的，只记在 all 上
    for (const r of [global, session, other]) expect(r).toMatchObject({ checkupId, by: 'manual', completedAt: NOW, notes: [{ code: 'baseline-missing' }] })
    for (const r of [global, session, other]) expect(r).not.toHaveProperty('usageTokens')
    expect({ ...global!.added, keys: sorted(global!.added.keys) }).toEqual({ keys: sorted([gc, cc]), pending: 2, advice: 0 })
    expect(session!.added).toEqual({ keys: [cc, red], pending: 1, advice: 1 })
    expect(other!.added).toEqual({ keys: [unclear], pending: 0, advice: 1 })
    // 全局和本项目之间的冲突在 all 里只算一次
    expect(all.lastResult).toEqual({
      checkupId, by: 'manual', completedAt: NOW,
      added: { keys: expect.any(Array), pending: 2, advice: 2 },
      byScope: [
        { scope: GLOBAL, keys: expect.any(Array) },
        { scope: OTHER, keys: [unclear] },
        { scope: SESSION, keys: [cc, red] },
      ],
      usageTokens: calls.length * 100,
      notes: expect.arrayContaining([{ code: 'baseline-missing' }]),
    })
    expect(sorted(all.lastResult!.added.keys)).toEqual(sorted([gc, cc, red, unclear]))
    // 体检视图：各范围带自己的最近一次结果，「全部」的结果单独一项；all 不是体检视图里的范围
    const view = await e.checkupView()
    expect(view.allResult).toEqual(all.lastResult)
    expect(view.scopes.map(s => [s.scope, s.lastResult])).toEqual([[GLOBAL, global], [OTHER, other], [SESSION, session]])
  })

  it('再体检一次：最近一次结果换成新的体检标识，没有新增', async () => {
    const llm = answering([crossConflict]).llm
    const e = env()
    await seed(e)
    await e.run({ target: SESSION, llm })
    const first = (await resultOf(e, SESSION))!
    e.clock.now = NOW + 1000
    await e.run({ target: SESSION, llm })
    const second = (await resultOf(e, SESSION))!
    expect(second.checkupId).not.toBe(first.checkupId)
    expect(second).toMatchObject({ completedAt: NOW + 1000, added: { keys: [], pending: 0, advice: 0 } })
  })

  it.each(['manual', 'auto'] as const)('PA-33 清过期的已结清条目（sweep），手动与自动一致：%s', async (by) => {
    const e = env()
    await seed(e)
    const old = (await e.decisions.upsert({ memoryIds: ['mem_g1', 'mem_g2'], summary: '旧冲突', fingerprint: 'fp-old' }, 1)).entry
    await e.decisions.settle(old.id, 'keep-right', NOW - RETENTION_MS - 1000, { snapshotId: 'snap_old' })
    expect(await e.decisions.listSettled()).toHaveLength(1)
    expect((await e.run({ target: GLOBAL, llm: quiet, by })).kind).toBe('done')
    expect(await e.decisions.listSettled()).toEqual([])
  })

  it('PA-34 自动体检做完立即重写视图；最近一次结果发起方自动、新增身份与条数、用量；不写键 all 的那条', async () => {
    const { llm, calls } = answering([crossConflict], { usage: 1280 })
    const e = env()
    await seed(e)
    expect(await e.run({ target: SESSION, llm, by: 'auto', baseline: null, currentWorkspace: undefined })).toMatchObject({ kind: 'done' })
    const cc = await keyOf(e, conflictOf('mem_g1', 'mem_s1'))
    const result = await resultOf(e, SESSION)
    expect(result).toEqual({
      checkupId: expect.any(String), by: 'auto', completedAt: NOW,
      added: { keys: [cc], pending: 1, advice: 0 },
      globalAdded: { keys: [], pending: 0, advice: 0 },
      usageTokens: calls.length * 1280,
      notes: [{ code: 'baseline-missing' }],
    })
    expect((await e.recordOf(checkupKey(SESSION)))?.completed).toEqual({ startedAt: NOW, completedAt: NOW, by: 'auto' })
    const view = await e.checkupView()
    expect(view.scopes.find(s => checkupKey(s.scope) === checkupKey(SESSION))!.lastResult).toEqual(result)
    expect(view.allResult).toBeNull()
    expect(await e.recordOf('all')).toBeUndefined()
  })
})

describe('没做成', () => {
  it('PA-57 手动：内容检查没做完照样算做完，说明码带原因、结果照写，不写完成记录、不写失败记录', async () => {
    const e = env()
    await seedScopes(e)
    const r = await e.run({ target: SESSION, llm: hostError('RATE_LIMIT') })
    expect(r).toMatchObject({ kind: 'done', notes: expect.arrayContaining([expect.objectContaining({ code: 'semantic-failed' })]) })
    const rec = (await e.recordOf(checkupKey(SESSION)))!
    expect(rec.completed).toBeUndefined()
    expect(rec.failure).toBeUndefined()
    expect(rec.lastResult!.notes).toContainEqual({ code: 'semantic-failed', cause: expect.objectContaining({ kind: 'model-error', hostCode: 'RATE_LIMIT' }) })
  })

  it('PA-57 手动：体检出错返回失败，不写失败记录', async () => {
    const e = env()
    await seedScopes(e)
    const r = await e.run({ target: { kind: 'workspace', workspacePath: '/tmp/pm-run-unknown' }, llm: quiet })
    expect(r).toMatchObject({ kind: 'failed', cause: { kind: 'error', message: expect.stringContaining('/tmp/pm-run-unknown') } })
    expect(await e.checkups.list()).toEqual([])
  })

  it('PA-57 自动：模型出错时失败记录在放掉认领之前已写下，返回失败；不写完成记录和结果', async () => {
    const e = env()
    await seedScopes(e)
    let isHeldWhenFailed: boolean | undefined
    const recordFailure = e.checkups.recordFailure.bind(e.checkups)
    vi.spyOn(e.checkups, 'recordFailure').mockImplementation(async (...args) => {
      isHeldWhenFailed = await e.otherProcess().isClaimed(checkupKey(SESSION))
      return recordFailure(...args)
    })
    const r = await e.run({ target: SESSION, llm: hostError('RATE_LIMIT'), by: 'auto' })
    expect(r).toMatchObject({ kind: 'failed', cause: { kind: 'model-error', hostCode: 'RATE_LIMIT' } })
    expect(isHeldWhenFailed).toBe(true)
    const rec = (await e.recordOf(checkupKey(SESSION)))!
    expect(rec.failure).toMatchObject({ count: 1, cause: expect.objectContaining({ hostCode: 'RATE_LIMIT' }) })
    expect(rec.completed).toBeUndefined()
    expect(rec.lastResult).toBeUndefined()
  })

  it('PA-57 自动：宿主报模型用不了，返回原因，一次体检不写任何记录', async () => {
    const e = env()
    await seedScopes(e)
    const r = await e.run({ target: SESSION, llm: hostError('ACCOUNT_SIGN_IN_REQUIRED'), by: 'auto' })
    expect(r).toMatchObject({ kind: 'model-unavailable', cause: { kind: 'model-error', hostCode: 'ACCOUNT_SIGN_IN_REQUIRED' } })
    expect(await e.checkups.list()).toEqual([])
  })
})

describe('收集与记录出错不挡体检', () => {
  const log = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })

  it('提交之后清理过期条目出错（账本目录不可写）：自动体检照常算做完，不记失败，记一条日志', async () => {
    const l = log()
    const e = env({ log: l })
    await seedScopes(e)
    const old = (await e.decisions.upsert({ memoryIds: ['mem_g', 'mem_s'], summary: '旧冲突', fingerprint: 'fp-old' }, 1)).entry
    await e.decisions.settle(old.id, 'keep-right', NOW - RETENTION_MS - 1000, { snapshotId: 'snap_old' })
    await chmod(join(root, STATE_DIR, 'pending'), 0o500)
    try {
      const r = await e.run({ target: GLOBAL, llm: quiet, by: 'auto' })
      expect(r).toMatchObject({ kind: 'done' })
      const rec = (await e.recordOf(checkupKey(GLOBAL)))!
      expect(rec.completed).toMatchObject({ by: 'auto' })
      expect(rec.failure).toBeUndefined()
      expect(l.warn).toHaveBeenCalledTimes(1)
    } finally {
      await chmod(join(root, STATE_DIR, 'pending'), 0o700)
    }
  })

  it('自动体检出错的原话带疑似密钥：记进失败原因前遮掉', async () => {
    const e = env()
    await seedScopes(e)
    const r = await e.run({ target: SESSION, llm: quiet, by: 'auto', confirmHeld: async () => { throw new Error(`读不出 ${FAKE_SECRET.sk}`) } })
    expect(r).toMatchObject({ kind: 'failed', cause: { kind: 'error' } })
    const rec = (await e.recordOf(checkupKey(SESSION)))!
    expect(rec.failure?.cause.message).toContain('读不出')
    expect(JSON.stringify(rec)).not.toContain(FAKE_SECRET.sk)
  })

  it('体检后视图写不出（视图目录不可写）：补收集一份照样比出新增、写结果', async () => {
    const e = env()
    await seedScopes(e)
    await mkdir(join(root, GUI_VIEW_DIR), { recursive: true })
    await chmod(join(root, GUI_VIEW_DIR), 0o500)
    const r = await e.run({ target: SESSION, llm: quiet })
    expect(r).toMatchObject({ kind: 'done', compared: expect.anything() })
    expect((await e.recordOf(checkupKey(SESSION)))?.lastResult).toMatchObject({ by: 'manual' })
  })

  it('体检提交之后记最近一次结果出错（体检记录文件被目录占住）：照常做完、完成记录在，记一条日志', async () => {
    const l = log()
    const e = env({ log: l })
    await seedScopes(e)
    await mkdir(join(root, STATE_DIR, 'checkups', `${createHash('sha1').update('all').digest('hex')}.json`), { recursive: true })
    const r = await e.run({ target: { kind: 'all' }, llm: quiet })
    expect(r).toMatchObject({ kind: 'done', compared: expect.anything() })
    expect((await e.recordOf(checkupKey(SESSION)))?.completed).toMatchObject({ by: 'manual' })
    expect(l.warn).toHaveBeenCalledTimes(1)
  })

  // 视图收集对文件系统的读错误本身就按空读、不抛，下面两例只能用抛错的收集来造
  it('体检前收集视图出错：体检照常做完、带回说明，不比新增、不写结果，记一条日志', async () => {
    const l = log()
    const e = env({ log: l, views: w => ({ rewriteAll: () => w.rewriteAll(), collectViews: () => Promise.reject(new Error('读不出')) }) })
    await seedScopes(e)
    const r = await e.run({ target: SESSION, llm: answering([{ type: 'conflict', memoryIds: ['mem_g', 'mem_s'], summary: '矛盾', suggestedAction: '裁决' }]).llm })
    expect(r).toMatchObject({ kind: 'done', notes: [{ code: 'baseline-missing' }] })
    expect(r).not.toHaveProperty('compared')
    expect(await e.decisions.list()).toHaveLength(1)
    expect((await e.recordOf(checkupKey(SESSION)))?.lastResult).toBeUndefined()
    expect(l.warn).toHaveBeenCalledTimes(1)
  })

  it('体检后视图没写成、补收集也出错：体检不算失败，不比新增，记一条日志', async () => {
    const l = log()
    let collects = 0
    const e = env({ log: l, views: w => ({ rewriteAll: async () => undefined, collectViews: () => (++collects === 1 ? w.collectViews() : Promise.reject(new Error('读不出'))) }) })
    await seedScopes(e)
    const r = await e.run({ target: SESSION, llm: quiet })
    expect(r).toMatchObject({ kind: 'done' })
    expect(r).not.toHaveProperty('compared')
    expect(l.warn).toHaveBeenCalledTimes(1)
  })
})
