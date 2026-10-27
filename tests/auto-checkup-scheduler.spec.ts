import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { FileTable } from '../src/storage/file-table.ts'
import { SidecarStore } from '../src/storage/sidecar.ts'
import { MemoryStore } from '../src/store.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'
import { PendingDecisionsStore } from '../src/governance/decisions.ts'
import { AdviceIgnoreStore } from '../src/governance/advice-ignores.ts'
import { CheckupRecordStore, checkupKey } from '../src/governance/checkup-records.ts'
import { AutoCheckupSettingStore } from '../src/governance/auto-checkups.ts'
import { hostSemanticLlm, type HostModelRoute } from '../src/governance/host-llm.ts'
import { adviceIgnoreSchema, memorySnapshotSchema, pendingDecisionSchema, scanCacheSchema } from '../src/governance/schema.ts'
import type { LayerRef } from '../src/governance/layer-health.ts'
import type { ScanToolResult } from '../src/tools/scan.ts'
import { ViewWriter, collectCheckupView } from '../src/gui/view-writer.ts'
import { AUTO_CHECKUP_FIRST_CHECK_MS, AUTO_CHECKUP_INTERVAL_MS, CHECKUP_CLAIM_REFRESH_MS, AutoCheckupScheduler, type AutoCheckupTimer } from '../src/gui/auto-checkup.ts'
import { GUI_CHECKUP_VIEW_FILE, GUI_VIEW_DIR, checkupViewSchema, type AutoCheckupFrequency, type CheckupView, type ScopeRef } from '../src/gui/contract.ts'
import { executeScan } from '../src/tools/scan.ts'
import type { SemanticLlm } from '../src/governance/semantic-scan.ts'
import { fakeExec } from './helpers/exec.ts'
import { record } from './helpers/record.ts'
import { DAY, NOW } from './helpers/clock.ts'

// 自动体检调度（测试切入点 2）：真实记忆根（FileTable + .state 侧表 + 视图文件），只在进程边界换成假的：
// 时钟、宿主计时服务、宿主默认模型选择和宿主 llm 服务（按宿主真实的流形状回 text-delta / usage / finish）。
// 由测试推进时间；断言完成记录、账本、视图文件和发给模型的请求。

const HOUR = 3_600_000
const DISCUSSION = '/work/discussion'
const OTHER_A = '/work/a'
const OTHER_B = '/work/b'
const DEFAULT_ROUTE = { provider: 'deepseek', model: 'deepseek-v4-flash' }
const registry = buildTypeRegistry({ template: 'coding', customTypes: {} })

let root: string
let live: AutoCheckupScheduler[] = []
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'pm-auto-checkup-')) })
afterEach(async () => {
  for (const s of live.splice(0)) await s.dispose()
  await rm(root, { recursive: true, force: true })
})

/** 宿主计时服务的替身：记下定时器，由 advance 推进时钟并按时刻先后触发（interval 触发后排下一次）。 */
function fakeTimer(clock: { now: number }) {
  const timers: Array<{ at: number; every?: number; callback: () => void; isLive: boolean }> = []
  const add = (callback: () => void, delayMs: number, every?: number) => {
    const t = { at: clock.now + delayMs, ...(every !== undefined ? { every } : {}), callback, isLive: true }
    timers.push(t)
    return () => { t.isLive = false }
  }
  const timer: AutoCheckupTimer = {
    timeout: (callback, delayMs) => add(callback, delayMs),
    interval: (callback, delayMs) => add(callback, delayMs, delayMs),
  }
  return {
    timer,
    /** 还活着的定时器：[距现在多久触发, 间隔]。 */
    live: () => timers.filter(t => t.isLive).map(t => [t.at - clock.now, t.every ?? null]),
    advance(ms: number) {
      const end = clock.now + ms
      for (;;) {
        const next = timers.filter(t => t.isLive && t.at <= end).sort((a, b) => a.at - b.at)[0]
        if (next === undefined) break
        clock.now = next.at
        if (next.every !== undefined) next.at += next.every
        else next.isLive = false
        next.callback()
      }
      clock.now = end
    },
  }
}

/**
 * 宿主 llm 服务的替身：每次 stream 记下请求，按宿主真实的流形状回一段：文本、usage、以 stop 收尾的 finish。
 * findings 按请求给（缺省没问题）；gate 给出时先等它，期间 signal 中断就按宿主的做法以 aborted 收尾。
 */
function fakeHostLlm(opts: { findings?: (req: GenerateOptions) => unknown[]; gate?: () => Promise<void> } = {}) {
  const requests: GenerateOptions[] = []
  let active = 0
  let maxActive = 0
  let waiters: Array<{ n: number; resolve: () => void }> = []
  return {
    requests,
    maxActive: () => maxActive,
    /** 第 n 次请求开始时 resolve。 */
    nthStarted: (n: number) => new Promise<void>(resolve => {
      if (requests.length >= n) resolve()
      else waiters.push({ n, resolve })
    }),
    async *stream(req: GenerateOptions): AsyncIterable<StreamChunk> {
      requests.push(req)
      for (const w of waiters.filter(w => requests.length >= w.n)) w.resolve()
      waiters = waiters.filter(w => requests.length < w.n)
      active++
      maxActive = Math.max(maxActive, active)
      try {
        if (opts.gate !== undefined) {
          const aborted = new Promise<'aborted'>(resolve => req.signal?.addEventListener('abort', () => resolve('aborted'), { once: true }))
          if (await Promise.race([opts.gate().then(() => 'open' as const), aborted]) === 'aborted') {
            yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'aborted', message: 'request aborted' } } } as StreamChunk
            return
          }
        }
        yield { type: 'text-delta', index: 0, text: JSON.stringify({ findings: opts.findings?.(req) ?? [] }) }
        yield { type: 'usage', usage: { inputTokens: 1200, outputTokens: 80 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      } finally {
        active--
      }
    },
  }
}

function env(opts: {
  llm?: ReturnType<typeof fakeHostLlm>
  defaultModel?: HostModelRoute | undefined
  governanceEnabled?: boolean
  /** 包一层调度器读状态（在读完之后插入别的进程的动作）。 */
  wrapStatus?: (read: () => Promise<CheckupView>) => () => Promise<CheckupView>
} = {}) {
  const clock = { now: NOW }
  // 侧表也用这个时钟：认领的时间和是否残留按它算
  const sidecar = new SidecarStore({ root, schemas: { snapshots: memorySnapshotSchema, pending: pendingDecisionSchema, scanCache: scanCacheSchema, adviceIgnores: adviceIgnoreSchema }, now: () => clock.now })
  const store = new MemoryStore(new FileTable({ root, stats: sidecar.recallStats, now: () => clock.now }), undefined, sidecar.recallStats)
  const decisions = new PendingDecisionsStore(sidecar.pending)
  const checkups = new CheckupRecordStore(sidecar.checkups)
  const autoCheckups = new AutoCheckupSettingStore(sidecar.autoCheckups)
  const cache = sidecar.scanCache
  const llm = opts.llm ?? fakeHostLlm()
  const governance = { isEnabled: opts.governanceEnabled ?? true }
  // 宿主默认模型选择的当前值（用例中途可以改）
  const route = { current: 'defaultModel' in opts ? opts.defaultModel : DEFAULT_ROUTE }
  const source = { store, checkups, autoCheckups, cache, isGovernanceEnabled: () => governance.isEnabled, now: () => clock.now }
  const writer = new ViewWriter({ memoryRoot: root, collect: () => { throw new Error('这里只写体检视图') }, collectCheckups: () => collectCheckupView(source) })
  const timers = fakeTimer(clock)
  const scanned: Array<{ layer: LayerRef; result: ScanToolResult }> = []
  const scheduler = new AutoCheckupScheduler({
    scan: { store, registry, decisions, cache, ignores: new AdviceIgnoreStore(sidecar.adviceIgnores) },
    checkups,
    status: opts.wrapStatus?.(() => collectCheckupView(source)) ?? (() => collectCheckupView(source)),
    // 每次开跑现读宿主默认模型（假的那份可以在用例中途改）
    getDefaultLlm: () => hostSemanticLlm(llm, route.current),
    isGovernanceEnabled: () => governance.isEnabled,
    timer: timers.timer,
    onChecked: () => writer.requestCheckups(),
    onClaimChanged: () => writer.requestCheckups(),
    // 接线层在这里重写视图（含体检视图）
    onScanned: async (layer, result) => { scanned.push({ layer, result }); await writer.requestCheckups() },
    now: () => clock.now,
  })
  live.push(scheduler)
  const set = (scope: ScopeRef, frequency: AutoCheckupFrequency) => autoCheckups.set(scope, frequency)
  const completed = async () => Object.fromEntries((await checkups.list()).map(r => [r.id, r.completed]))
  const readView = async () => checkupViewSchema.parse(JSON.parse(await readFile(join(root, GUI_VIEW_DIR, GUI_CHECKUP_VIEW_FILE), 'utf8')))
  /** 推进时间并等这次检查（含它跑的体检）做完。 */
  const advance = async (ms: number) => { timers.advance(ms); await scheduler.whenIdle() }
  return { clock, store, decisions, checkups, autoCheckups, cache, llm, governance, route, timers, scheduler, scanned, set, completed, readView, advance, sidecar }
}

const ws = (path: string) => ({ kind: 'workspace' as const, workspacePath: path })
const schemas = { snapshots: memorySnapshotSchema, pending: pendingDecisionSchema, scanCache: scanCacheSchema, adviceIgnores: adviceIgnoreSchema }
/** 范围的认领文件（体检记录旁边）。 */
const claimFile = (key: string) => join(root, '.state', 'checkups', `${createHash('sha1').update(key).digest('hex')}.claim`)
const readClaim = async (key: string) => JSON.parse(await readFile(claimFile(key), 'utf8')) as { pid: number; at: number; id: string }
/** 这次请求查的是哪个范围：项目体检的输入是全局加本项目，全局体检只有全局记忆。 */
const scopeOfRequest = (req: GenerateOptions) => {
  const text = JSON.stringify(req.messages)
  return text.includes('项目 a 的记忆') ? OTHER_A : text.includes('项目 b 的记忆') ? OTHER_B : text.includes('discussion 的记忆') ? DISCUSSION : 'global'
}

describe('自动体检调度：计时', () => {
  it('启动后 3 分钟第一次检查，之后每 10 分钟检查一次；卸载后定时器全部停掉', async () => {
    const e = env()
    e.scheduler.start()
    expect(e.timers.live()).toEqual([[AUTO_CHECKUP_FIRST_CHECK_MS, null]])
    expect(AUTO_CHECKUP_FIRST_CHECK_MS).toBe(3 * 60_000)
    await e.advance(AUTO_CHECKUP_FIRST_CHECK_MS)
    expect(e.timers.live()).toEqual([[AUTO_CHECKUP_INTERVAL_MS, AUTO_CHECKUP_INTERVAL_MS]])
    expect(AUTO_CHECKUP_INTERVAL_MS).toBe(10 * 60_000)
    await e.scheduler.dispose()
    expect(e.timers.live()).toEqual([])
  })

  it('从没设过自动体检（老用户升级）：所有范围仅手动，后台不发起体检', async () => {
    const e = env()
    await e.store.create(record({ id: 'mem_g', name: '全局', content: '全局的记忆' }))
    await e.store.create(record({ id: 'mem_d', name: '讨论', content: 'discussion 的记忆', scope: 'workspace', workspacePath: DISCUSSION }))
    e.scheduler.start()
    await e.advance(AUTO_CHECKUP_FIRST_CHECK_MS + 3 * AUTO_CHECKUP_INTERVAL_MS)
    expect(e.llm.requests).toEqual([])
    expect(await e.completed()).toEqual({})
    const view = await e.readView()
    expect(view.defaultFrequency).toBe('manual')
    expect(view.scopes.map(s => [s.scope, s.frequency, s.isOwn, s.isDue])).toEqual([
      [{ kind: 'global' }, 'manual', false, false],
      [ws(DISCUSSION), 'manual', false, false],
    ])
  })
})

describe('自动体检调度：到期就在后台体检一次', () => {
  it('discussion 每天、上次体检在 25 小时前：第一次检查时用宿主默认模型无会话体检一次，结果进账本，写完成记录和体检视图；之后不再连跑', async () => {
    const llm = fakeHostLlm({ findings: () => [{ type: 'conflict', memoryIds: ['mem_x', 'mem_y'], summary: '端口说法矛盾', suggestedAction: '请裁决' }] })
    const e = env({ llm })
    await e.store.create(record({ id: 'mem_x', name: '端口甲', content: 'discussion 的记忆：端口 3000', scope: 'workspace', workspacePath: DISCUSSION }))
    await e.store.create(record({ id: 'mem_y', name: '端口乙', content: 'discussion 的记忆：端口 4000', scope: 'workspace', workspacePath: DISCUSSION }))
    await e.set(ws(DISCUSSION), 1)
    const lastAt = NOW - 25 * HOUR
    await e.checkups.complete([{ kind: 'workspace', path: DISCUSSION }], { startedAt: lastAt - 60_000, completedAt: lastAt, by: 'manual' })
    e.scheduler.start()
    await e.advance(AUTO_CHECKUP_FIRST_CHECK_MS)

    // 只查到期的 discussion；不经过任何会话，用宿主默认模型
    expect(e.llm.requests).toHaveLength(1)
    expect(e.llm.requests[0]).toMatchObject(DEFAULT_ROUTE)
    expect(e.llm.requests[0]).not.toHaveProperty('sessionId')
    const at = NOW + AUTO_CHECKUP_FIRST_CHECK_MS
    expect((await e.completed())[checkupKey({ kind: 'workspace', path: DISCUSSION })]).toEqual({ startedAt: at, completedAt: at, by: 'auto' })
    expect((await e.decisions.list()).map(d => d.memoryIds)).toEqual([['mem_x', 'mem_y']])
    // 后台没有会话投影：不查和 AGENTS.md 基线的冲突，结果带 baseline-missing；只查这一个范围，不跑跨项目重复检查
    expect(e.scanned).toHaveLength(1)
    expect(e.scanned[0]!.layer).toEqual({ kind: 'workspace', path: DISCUSSION })
    const result = e.scanned[0]!.result
    expect(result.kind).toBe('single')
    expect(result.kind !== 'error' && result.notes.map(n => n.code)).toContain('baseline-missing')

    const view = await e.readView()
    expect(view.scopes.find(s => s.scope.kind === 'workspace')).toEqual({
      scope: ws(DISCUSSION), frequency: 1, isOwn: true, lastCheckupAt: at, nextCheckupAt: at + DAY, isDue: false, isInProgress: false,
    })

    await e.advance(3 * AUTO_CHECKUP_INTERVAL_MS)
    expect(e.llm.requests).toHaveLength(1)
  })

  it('dsh 关着时错过了好几个周期：打开后补跑一次，不按错过的次数连跑', async () => {
    const e = env()
    await e.store.create(record({ id: 'mem_g', content: '全局的记忆' }))
    await e.set({ kind: 'all' }, 1)
    await e.checkups.complete([{ kind: 'global' }], { startedAt: NOW - 10 * DAY, completedAt: NOW - 10 * DAY, by: 'auto' })
    e.scheduler.start()
    await e.advance(AUTO_CHECKUP_FIRST_CHECK_MS + 5 * AUTO_CHECKUP_INTERVAL_MS)
    expect(e.llm.requests).toHaveLength(1)
  })

  it('手动体检和 agent 体检都重新计时：完成记录还在周期内的范围不跑，从没体检过的立刻跑', async () => {
    const e = env()
    await e.store.create(record({ id: 'mem_g', content: '全局的记忆' }))
    await e.store.create(record({ id: 'mem_a', content: '项目 a 的记忆', scope: 'workspace', workspacePath: OTHER_A }))
    await e.store.create(record({ id: 'mem_b', content: '项目 b 的记忆', scope: 'workspace', workspacePath: OTHER_B }))
    await e.set({ kind: 'all' }, 1)
    await e.checkups.complete([{ kind: 'global' }], { startedAt: NOW - HOUR, completedAt: NOW - HOUR, by: 'agent' })
    await e.checkups.complete([{ kind: 'workspace', path: OTHER_A }], { startedAt: NOW - HOUR, completedAt: NOW - HOUR, by: 'manual' })
    e.scheduler.start()
    await e.advance(AUTO_CHECKUP_FIRST_CHECK_MS)
    expect(e.llm.requests.map(scopeOfRequest)).toEqual([OTHER_B])
  })

  it('一次只跑一个：到期的范围依次查，全局先、项目按路径；正在查时再来的检查不另起一个', async () => {
    let open!: () => void
    const gate = new Promise<void>(resolve => { open = resolve })
    const llm = fakeHostLlm({ gate: () => gate })
    const e = env({ llm })
    await e.store.create(record({ id: 'mem_b', content: '项目 b 的记忆', scope: 'workspace', workspacePath: OTHER_B }))
    await e.store.create(record({ id: 'mem_a', content: '项目 a 的记忆', scope: 'workspace', workspacePath: OTHER_A }))
    await e.store.create(record({ id: 'mem_g', content: '全局的记忆' }))
    await e.set({ kind: 'all' }, 7)
    e.scheduler.start()
    e.timers.advance(AUTO_CHECKUP_FIRST_CHECK_MS)
    await llm.nthStarted(1)
    // 第一个还没查完：到了下一次检查、本进程又改了设置，都不另起一个
    e.timers.advance(AUTO_CHECKUP_INTERVAL_MS)
    void e.scheduler.recheck()
    expect(llm.requests).toHaveLength(1)
    open()
    await e.scheduler.whenIdle()
    expect(llm.requests.map(scopeOfRequest)).toEqual(['global', OTHER_A, OTHER_B])
    expect(llm.maxActive()).toBe(1)
    expect(Object.keys(await e.completed()).sort()).toEqual(['global', OTHER_A, OTHER_B].sort())
  })

  it('另一个进程改的设置：下一次检查时读到', async () => {
    const e = env()
    await e.store.create(record({ id: 'mem_g', content: '全局的记忆' }))
    e.scheduler.start()
    await e.advance(AUTO_CHECKUP_FIRST_CHECK_MS)
    expect(e.llm.requests).toEqual([])
    // 另一个宿主进程：同一个记忆根上的另一份侧表
    const other = new SidecarStore({ root, schemas: { snapshots: memorySnapshotSchema, pending: pendingDecisionSchema, scanCache: scanCacheSchema, adviceIgnores: adviceIgnoreSchema } })
    await new AutoCheckupSettingStore(other.autoCheckups).set({ kind: 'global' }, 30)
    await e.advance(AUTO_CHECKUP_INTERVAL_MS)
    expect(e.llm.requests.map(scopeOfRequest)).toEqual(['global'])
  })
})

describe('自动体检调度：不跑的情况', () => {
  it('体检开关关着时不跑；改回开着后重算立刻跑', async () => {
    const e = env({ governanceEnabled: false })
    await e.store.create(record({ id: 'mem_g', content: '全局的记忆' }))
    await e.set({ kind: 'all' }, 1)
    e.scheduler.start()
    await e.advance(AUTO_CHECKUP_FIRST_CHECK_MS + AUTO_CHECKUP_INTERVAL_MS)
    expect(e.llm.requests).toEqual([])
    expect((await e.readView()).governanceEnabled).toBe(false)
    e.governance.isEnabled = true
    await e.scheduler.recheck()
    expect(e.llm.requests.map(scopeOfRequest)).toEqual(['global'])
    expect((await e.readView()).governanceEnabled).toBe(true)
  })

  it('拿不到宿主默认模型时不跑、不写完成记录；默认模型回来后下一次检查照常跑', async () => {
    const e = env({ defaultModel: undefined })
    await e.store.create(record({ id: 'mem_g', content: '全局的记忆' }))
    await e.set({ kind: 'all' }, 1)
    e.scheduler.start()
    await e.advance(AUTO_CHECKUP_FIRST_CHECK_MS)
    expect(e.llm.requests).toEqual([])
    expect(await e.completed()).toEqual({})
    e.route.current = DEFAULT_ROUTE
    await e.advance(AUTO_CHECKUP_INTERVAL_MS)
    expect(e.llm.requests).toHaveLength(1)
  })

  it('插件卸载时取消正在跑的体检：不写缓存和完成记录，下次打开这个范围仍是到期', async () => {
    const llm = fakeHostLlm({ gate: () => new Promise<void>(() => {}) })
    const e = env({ llm })
    await e.store.create(record({ id: 'mem_g', content: '全局的记忆' }))
    await e.set({ kind: 'all' }, 1)
    e.scheduler.start()
    e.timers.advance(AUTO_CHECKUP_FIRST_CHECK_MS)
    await llm.nthStarted(1)
    await e.scheduler.dispose()
    expect(await e.completed()).toEqual({})
    expect(await e.cache.list()).toEqual([])
    expect(e.scanned).toEqual([])
    // 下次打开：仍是到期
    const status = await collectCheckupView({ store: e.store, checkups: e.checkups, autoCheckups: e.autoCheckups, cache: e.cache, now: () => e.clock.now })
    expect(status.scopes[0]).toMatchObject({ scope: { kind: 'global' }, isDue: true, lastCheckupAt: null })
  })
})

describe('自动体检调度：按范围认领', () => {
  it('别的进程正在体检这个范围（认领着）：跳过它、不调模型，下一个到期的范围照常查', async () => {
    const e = env()
    await e.store.create(record({ id: 'mem_g', content: '全局的记忆' }))
    await e.store.create(record({ id: 'mem_a', content: '项目 a 的记忆', scope: 'workspace', workspacePath: OTHER_A }))
    await e.set({ kind: 'all' }, 1)
    e.scheduler.start()
    e.timers.advance(AUTO_CHECKUP_FIRST_CHECK_MS - 1000)
    // 另一个宿主进程：同一个记忆根上的另一份侧表，检查前一秒认领了全局
    const other = new CheckupRecordStore(new SidecarStore({ root, schemas, now: () => e.clock.now }).checkups)
    const held = await other.claim([{ kind: 'global' }])
    expect('claims' in held).toBe(true)
    await e.advance(1000)
    expect(e.llm.requests.map(scopeOfRequest)).toEqual([OTHER_A])
    expect(Object.keys(await e.completed())).toEqual([OTHER_A])
    // 别的进程的认领原样留着；体检视图写它在进行中
    expect(await other.isInProgress({ kind: 'global' })).toBe(true)
    expect((await e.readView()).scopes.map(s => [s.scope.kind, s.isInProgress])).toEqual([['global', true], ['workspace', false]])
  })

  it('认领到之后重读完成记录：别的进程刚查完、已经不到期的，放掉认领不跑', async () => {
    const other = new CheckupRecordStore(new SidecarStore({ root, schemas }).checkups)
    let reads = 0
    const e = env({
      // 第一次读状态之后、认领之前，别的进程把全局查完了
      wrapStatus: read => async () => {
        const status = await read()
        if (++reads === 1) await other.complete([{ kind: 'global' }], { startedAt: NOW, completedAt: NOW, by: 'auto' })
        return status
      },
    })
    await e.store.create(record({ id: 'mem_g', content: '全局的记忆' }))
    await e.set({ kind: 'all' }, 1)
    e.scheduler.start()
    await e.advance(AUTO_CHECKUP_FIRST_CHECK_MS)
    expect(reads).toBe(2)
    expect(e.llm.requests).toEqual([])
    expect(await e.completed()).toEqual({ global: { startedAt: NOW, completedAt: NOW, by: 'auto' } })
    expect(await other.isInProgress({ kind: 'global' })).toBe(false)
  })

  it('持有期间用宿主计时服务每 10 秒刷新认领时间，体检视图写进行中；做完停掉心跳、放掉认领', async () => {
    let open!: () => void
    const llm = fakeHostLlm({ gate: () => new Promise<void>(resolve => { open = resolve }) })
    const e = env({ llm })
    await e.store.create(record({ id: 'mem_g', content: '全局的记忆' }))
    await e.set({ kind: 'all' }, 1)
    e.scheduler.start()
    e.timers.advance(AUTO_CHECKUP_FIRST_CHECK_MS)
    await llm.nthStarted(1)
    const startedAt = e.clock.now
    expect(CHECKUP_CLAIM_REFRESH_MS).toBe(10_000)
    expect(e.timers.live()).toContainEqual([CHECKUP_CLAIM_REFRESH_MS, CHECKUP_CLAIM_REFRESH_MS])
    expect(await readClaim('global')).toMatchObject({ pid: process.pid, at: startedAt })
    expect((await e.readView()).scopes[0]).toMatchObject({ scope: { kind: 'global' }, isInProgress: true })
    e.timers.advance(CHECKUP_CLAIM_REFRESH_MS)
    await vi.waitFor(async () => { expect((await readClaim('global')).at).toBe(startedAt + CHECKUP_CLAIM_REFRESH_MS) })
    open()
    await e.scheduler.whenIdle()
    expect(e.timers.live()).toEqual([[AUTO_CHECKUP_INTERVAL_MS - CHECKUP_CLAIM_REFRESH_MS, AUTO_CHECKUP_INTERVAL_MS]])
    await expect(readFile(claimFile('global'), 'utf8')).rejects.toThrow()
    expect((await e.readView()).scopes[0]).toMatchObject({ scope: { kind: 'global' }, isInProgress: false })
  })

  it('agent 在自动体检进行中调 memory_scan：不认领、不被挡，照常回结果；它比自动体检晚结束，上次体检不往回退', async () => {
    let openAuto!: () => void
    const llm = fakeHostLlm({ gate: () => new Promise<void>(resolve => { openAuto = resolve }) })
    const e = env({ llm })
    await e.store.create(record({ id: 'mem_g', content: '全局的记忆' }))
    await e.set({ kind: 'all' }, 1)
    e.scheduler.start()
    e.timers.advance(AUTO_CHECKUP_FIRST_CHECK_MS)
    await llm.nthStarted(1)
    const autoStartedAt = e.clock.now
    // agent 的 memory_scan 在自动体检进行中开始
    let openAgent!: () => void
    let agentCalled!: () => void
    const agentStarted = new Promise<void>(resolve => { agentCalled = resolve })
    const agentGate = new Promise<void>(resolve => { openAgent = resolve })
    const agentLlm: SemanticLlm = { complete: async () => { agentCalled(); await agentGate; return '{"findings":[]}' } }
    e.clock.now = autoStartedAt + 1000
    const agent = executeScan({}, {
      store: e.store, registry, decisions: e.decisions, cache: e.cache, checkups: e.checkups,
      getBaseline: () => null, getLlm: () => agentLlm, resolveContext: async () => ({ workspacePath: undefined }), now: () => e.clock.now,
    }, fakeExec())
    await agentStarted
    expect(await e.checkups.isInProgress({ kind: 'global' })).toBe(true)
    // 自动体检先结束
    e.clock.now = autoStartedAt + 2000
    openAuto()
    await e.scheduler.whenIdle()
    const lastAfterAuto = (await e.readView()).scopes[0]!.lastCheckupAt!
    expect(lastAfterAuto).toBe(autoStartedAt + 2000)
    // agent 后结束
    e.clock.now = autoStartedAt + 3000
    openAgent()
    const result = await agent
    expect(result.kind).toBe('single')
    expect(await e.completed()).toEqual({ global: { startedAt: autoStartedAt + 1000, completedAt: autoStartedAt + 3000, by: 'agent' } })
    const status = await collectCheckupView({ store: e.store, checkups: e.checkups, autoCheckups: e.autoCheckups, cache: e.cache, now: () => e.clock.now })
    expect(status.scopes[0]!.lastCheckupAt).toBeGreaterThanOrEqual(lastAfterAuto)
    expect((await e.cache.get('global'))?.scannedAt ?? (await e.cache.list())[0]?.[1].scannedAt).toBeGreaterThanOrEqual(autoStartedAt)
  })
})
