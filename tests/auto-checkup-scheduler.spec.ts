import { sidecarSchemas, createPluginEnv } from './helpers/plugin-env.ts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SidecarStore } from '../src/storage/sidecar.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'
import { PendingDecisionsStore } from '../src/governance/decisions.ts'
import { AdviceIgnoreStore } from '../src/governance/advice-ignores.ts'
import { CheckupRecordStore } from '../src/governance/checkup-records.ts'
import { AutoCheckupSettingStore } from '../src/governance/auto-checkups.ts'
import { hostSemanticLlm, type HostModelRoute } from '../src/governance/host-llm.ts'
import { ModelSelectionStore, createBackgroundLlmResolver } from '../src/governance/background-llm.ts'
import { GLOBAL_CACHE_KEY } from '../src/governance/scope-health.ts'
import { ViewWriter, collectCheckupView, collectGlobalViews } from '../src/gui/view-writer.ts'
import { AUTO_CHECKUP_FIRST_CHECK_MS, AUTO_CHECKUP_INTERVAL_MS, AutoCheckupScheduler, type AutoCheckupTimer } from '../src/gui/auto-checkup.ts'
import { CHECKUP_CLAIM_REFRESH_MS } from '../src/gui/checkup-run.ts'
import { CheckupSuggestions, type CheckupSuggestionsDeps } from '../src/gui/checkup-suggestions.ts'
import { GUI_CHECKUP_VIEW_FILE, GUI_VIEW_DIR, checkupKey, checkupViewSchema, type AutoCheckupFrequency, type CheckupView, type ScopeOrAll } from '../src/gui/contract.ts'
import { executeScan } from '../src/tools/scan.ts'
import type { SemanticLlm } from '../src/governance/semantic-scan.ts'
import { fakeExec } from './helpers/exec.ts'
import { legacyCheckupRecordSchema } from './helpers/legacy-checkup-record.ts'
import { record } from './helpers/record.ts'
import { DAY, NOW } from './helpers/clock.ts'
import { instructionsOf, noInstructions } from './helpers/instructions.ts'
import type { ReadInstructions } from '../src/governance/instructions.ts'
import type { MemoryLogger } from '../src/store.ts'
import { breakModelSelection } from './helpers/model-selection-file.ts'

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

/** 假模型这次怎么回：正常回 JSON、回解析不了的文本，或以带宿主错误码的 error finish 收尾。 */
type HostReply = 'ok' | 'garbage' | { code: string; message: string }

/**
 * 宿主 llm 服务的替身：每次 stream 记下请求，按宿主真实的流形状回一段：文本、usage、以 stop 收尾的 finish。
 * findings 按请求给（缺省没问题）；gate 给出时先等它，期间 signal 中断就按宿主的做法以 aborted 收尾。
 */
function fakeHostLlm(opts: {
  findings?: (req: GenerateOptions) => unknown[]
  gate?: () => Promise<void>
  reply?: () => HostReply
  /** 生成处理建议的请求怎么回（缺省按内容检查回）；suggestionGate 给出时先等它，不理会取消（模型在卸载之后才回来）。 */
  suggestion?: () => HostReply | string
  suggestionGate?: () => Promise<void>
  /** 宿主里配好的提供方 → 模型 → 推理强度（列模型用）；缺省只有默认模型那一个。 */
  catalog?: Record<string, Record<string, string[]>>
} = {}) {
  const catalog = opts.catalog ?? { [DEFAULT_ROUTE.provider]: { [DEFAULT_ROUTE.model]: [] } }
  const requests: GenerateOptions[] = []
  let active = 0
  let maxActive = 0
  let waiters: Array<{ n: number; resolve: () => void }> = []
  return {
    requests,
    listProviders: () => Object.keys(catalog).map(id => ({ id, name: id })),
    async listModels(provider: string) {
      const models = catalog[provider]
      if (models === undefined) throw Object.assign(new Error(`no adapter registered for provider "${provider}"`), { code: 'NO_ADAPTER' })
      return Object.keys(models).map(id => ({ id, name: id }))
    },
    async resolveModelInfo(provider: string, model: string) {
      const efforts = catalog[provider]?.[model] ?? []
      return efforts.length === 0 ? {} : { reasoning: { efforts: efforts.map(id => ({ id, name: id })) } }
    },
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
        if (opts.suggestion !== undefined && /两条互相矛盾的记忆|一条长期记忆和项目指令文件/.test(String(req.system))) {
          await opts.suggestionGate?.()
          const answer = opts.suggestion()
          if (typeof answer === 'object') {
            yield { type: 'finish', reason: { kind: 'error', failure: answer } } as StreamChunk
            return
          }
          yield { type: 'text-delta', index: 0, text: answer }
          yield { type: 'usage', usage: { inputTokens: 300, outputTokens: 20 } }
          yield { type: 'finish', reason: { kind: 'stop' } }
          return
        }
        const reply = opts.reply?.() ?? 'ok'
        if (typeof reply === 'object') {
          // 宿主把适配器抛的错折成以 error 收尾的 finish，failure 带宿主错误码
          yield { type: 'finish', reason: { kind: 'error', failure: reply } } as StreamChunk
          return
        }
        yield { type: 'text-delta', index: 0, text: reply === 'garbage' ? '这不是 JSON' : JSON.stringify({ findings: opts.findings?.(req) ?? [] }) }
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
  /** 接上体检之后的后续段（生成处理建议）；给出时可以换掉它用的账本（模拟后续段出错）。 */
  suggestions?: { decisions?: (real: PendingDecisionsStore) => CheckupSuggestionsDeps['decisions'] }
  /** 各项目的指令文件；不给就哪里都没有。 */
  instructions?: ReadInstructions
  /** 体检认领到、放掉之后重写完体检视图再调用（看那一刻视图里是什么）。 */
  afterClaimChanged?: () => Promise<void>
  /** 调度器的日志；缺省写到控制台。 */
  log?: MemoryLogger
  /** 包一层宿主默认模型的取法（模拟宿主那边出错）。 */
  wrapDefaultLlm?: (real: () => SemanticLlm | null) => () => SemanticLlm | null
} = {}) {
  const clock = { now: NOW }
  // 侧表也用这个时钟：认领的时间和是否残留按它算
  const sidecar = new SidecarStore({ root, schemas: sidecarSchemas, now: () => clock.now })
  const { store, decisions, ignores, checkups, autoCheckups } = createPluginEnv(sidecar, { root, stats: sidecar.recallStats, now: () => clock.now })
  const cache = sidecar.scanCache
  const llm = opts.llm ?? fakeHostLlm()
  const governance = { isEnabled: opts.governanceEnabled ?? true }
  // 宿主默认模型选择的当前值（用例中途可以改）
  const route = { current: 'defaultModel' in opts ? opts.defaultModel : DEFAULT_ROUTE }
  // 自动体检选的模型：真的选择表（同一个记忆根的侧表），选择在不在按假宿主的模型目录查
  const selections = new ModelSelectionStore(sidecar.modelSelections)
  const defaultLlm = () => hostSemanticLlm(llm, route.current)
  const resolveLlm = createBackgroundLlmResolver({
    selections, catalog: () => llm, llmFor: selection => hostSemanticLlm(llm, selection), defaultLlm: opts.wrapDefaultLlm?.(defaultLlm) ?? defaultLlm,
  })
  const source = { store, checkups, autoCheckups, selections, cache, isGovernanceEnabled: () => governance.isEnabled, now: () => clock.now }
  const collectViews = () => collectGlobalViews({ store, decisions, cache, ignores, checkups, registry, memoryRoot: root, now: () => clock.now })
  const writer = new ViewWriter({ memoryRoot: root, collect: collectViews, collectCheckups: () => collectCheckupView(source), now: () => clock.now, sleep: async () => {}, lock: sidecar.lock })
  const timers = fakeTimer(clock)
  const instructions = opts.instructions ?? noInstructions
  const suggestions = opts.suggestions === undefined ? undefined : new CheckupSuggestions({
    store, instructions, decisions: opts.suggestions.decisions?.(decisions) ?? decisions, checkups, views: writer, now: () => clock.now, log: { info() {}, warn() {}, error() {} },
  })
  const scheduler = new AutoCheckupScheduler({
    scan: { store, registry, decisions, cache, ignores, instructions },
    checkups,
    views: writer,
    status: opts.wrapStatus?.(() => collectCheckupView(source)) ?? (() => collectCheckupView(source)),
    // 每次开跑现读选择和宿主默认模型（假的那份可以在用例中途改）
    resolveLlm: () => resolveLlm('checkup'),
    isGovernanceEnabled: () => governance.isEnabled,
    timer: timers.timer,
    onChecked: () => writer.requestCheckups(),
    onClaimChanged: async () => {
      await writer.requestCheckups()
      await opts.afterClaimChanged?.()
    },
    ...(suggestions !== undefined ? { suggestions } : {}),
    ...(opts.log !== undefined ? { log: opts.log } : {}),
    now: () => clock.now,
  })
  live.push(scheduler)
  const set = (scope: ScopeOrAll, frequency: AutoCheckupFrequency) => autoCheckups.set(scope, frequency)
  const completed = async () => Object.fromEntries((await checkups.list()).map(r => [r.id, r.completed]))
  const readView = async () => checkupViewSchema.parse(JSON.parse(await readFile(join(root, GUI_VIEW_DIR, GUI_CHECKUP_VIEW_FILE), 'utf8')))
  /** 推进时间并等这次检查（含它跑的体检）做完。 */
  const advance = async (ms: number) => { timers.advance(ms); await scheduler.whenIdle() }
  const lastResultOf = async (key: string) => (await checkups.list()).find(r => r.id === key)?.lastResult
  return { clock, store, decisions, checkups, autoCheckups, selections, cache, llm, governance, route, timers, scheduler, set, completed, readView, advance, sidecar, lastResultOf }
}

const ws = (path: string) => ({ kind: 'workspace' as const, workspacePath: path })
const schemas = sidecarSchemas
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
    await e.checkups.complete([{ kind: 'workspace', workspacePath: DISCUSSION }], { startedAt: lastAt - 60_000, completedAt: lastAt, by: 'manual' })
    e.scheduler.start()
    await e.advance(AUTO_CHECKUP_FIRST_CHECK_MS)

    // 只查到期的 discussion；不经过任何会话，用宿主默认模型
    expect(e.llm.requests).toHaveLength(1)
    expect(e.llm.requests[0]).toMatchObject(DEFAULT_ROUTE)
    expect(e.llm.requests[0]).not.toHaveProperty('sessionId')
    const at = NOW + AUTO_CHECKUP_FIRST_CHECK_MS
    expect((await e.completed())[checkupKey({ kind: 'workspace', workspacePath: DISCUSSION })]).toEqual({ startedAt: at, completedAt: at, by: 'auto', coverage: expect.any(Object) })
    expect((await e.decisions.list()).map(d => d.memoryIds)).toEqual([['mem_x', 'mem_y']])
    // 这个项目没有指令文件，结果不带说明；只查这一个范围，不跑跨项目重复检查
    expect((await e.lastResultOf(checkupKey(ws(DISCUSSION))))?.notes).toEqual([])
    expect(await e.lastResultOf(checkupKey({ kind: 'global' }))).toBeUndefined()

    const view = await e.readView()
    expect(view.scopes.find(s => s.scope.kind === 'workspace')).toEqual({
      scope: ws(DISCUSSION), isCheckable: true, frequency: 1, isOwn: true, lastCheckupAt: at, nextCheckupAt: at + DAY, isDue: false, isInProgress: false, failure: null, modelUnavailable: null,
      lastResult: expect.objectContaining({ by: 'auto' }),
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
    await e.checkups.complete([{ kind: 'workspace', workspacePath: OTHER_A }], { startedAt: NOW - HOUR, completedAt: NOW - HOUR, by: 'manual' })
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
    const other = new SidecarStore({ root, schemas: sidecarSchemas })
    await new AutoCheckupSettingStore(other.autoCheckups).set({ kind: 'global' }, 30)
    await e.advance(AUTO_CHECKUP_INTERVAL_MS)
    expect(e.llm.requests.map(scopeOfRequest)).toEqual(['global'])
  })
})

describe('自动体检调度：选用的模型', () => {
  const CATALOG = { deepseek: { 'deepseek-v4-flash': [] }, 'provider-x': { 'model-a': ['low', 'high'] } }

  it('选了模型和推理强度：后台体检用它们调用，结果不带退回说明；体检视图写出选的模型', async () => {
    const e = env({ llm: fakeHostLlm({ catalog: CATALOG }) })
    await e.store.create(record({ id: 'mem_g', content: '全局的记忆' }))
    await e.set({ kind: 'all' }, 1)
    await e.selections.set('checkup', { provider: 'provider-x', model: 'model-a', reasoningEffort: 'high' })
    e.scheduler.start()
    await e.advance(AUTO_CHECKUP_FIRST_CHECK_MS)
    expect(e.llm.requests).toHaveLength(1)
    expect(e.llm.requests[0]).toMatchObject({ provider: 'provider-x', model: 'model-a', reasoningEffort: 'high' })
    expect((await e.lastResultOf('global'))?.notes).toEqual([])
    expect((await e.lastResultOf('global'))?.modelFallback).toBeUndefined()
    expect((await e.readView()).model).toEqual({ provider: 'provider-x', model: 'model-a', reasoningEffort: 'high' })
  })

  it('没选：用宿主默认模型，请求不带推理强度；体检视图里选的模型为 null', async () => {
    const e = env({ llm: fakeHostLlm({ catalog: CATALOG }) })
    await e.store.create(record({ id: 'mem_g', content: '全局的记忆' }))
    await e.set({ kind: 'all' }, 1)
    e.scheduler.start()
    await e.advance(AUTO_CHECKUP_FIRST_CHECK_MS)
    expect(e.llm.requests[0]).toMatchObject(DEFAULT_ROUTE)
    expect(e.llm.requests[0]).not.toHaveProperty('reasoningEffort')
    expect((await e.readView()).model).toBeNull()
  })

  it('选的模型下架了：自动退回默认模型照常体检、写完成记录，结果里说明「选的模型用不了，已改用默认模型」', async () => {
    const e = env({ llm: fakeHostLlm({ catalog: CATALOG }) })
    await e.store.create(record({ id: 'mem_g', content: '全局的记忆' }))
    await e.set({ kind: 'all' }, 1)
    await e.selections.set('checkup', { provider: 'provider-x', model: 'model-gone' })
    e.scheduler.start()
    await e.advance(AUTO_CHECKUP_FIRST_CHECK_MS)
    expect(e.llm.requests).toHaveLength(1)
    expect(e.llm.requests[0]).toMatchObject(DEFAULT_ROUTE)
    expect((await e.completed()).global).toMatchObject({ by: 'auto' })
    expect((await e.lastResultOf('global'))?.modelFallback).toEqual({ reason: 'model-gone' })
    expect((await e.lastResultOf('global'))?.notes).toEqual([])
    // 选择本身不动：模型回来后照样用它
    expect((await e.readView()).model).toEqual({ provider: 'provider-x', model: 'model-gone' })
  })

  /** 选择文件读不出时的这一条（how 是读不出的造法）。 */
  const pickedUnreadable = async (how: 'bad-json' | 'no-permission') => {
    const e = env({ llm: fakeHostLlm({ catalog: CATALOG }), log: { info() {}, warn() {}, error() {} } })
    await e.store.create(record({ id: 'mem_g', content: '全局的记忆' }))
    await e.set({ kind: 'all' }, 1)
    const broken = await breakModelSelection(root, 'checkup', how)
    e.scheduler.start()
    await e.advance(AUTO_CHECKUP_FIRST_CHECK_MS)
    expect(e.llm.requests).toEqual([])
    expect(await e.completed()).toEqual({})
    expect((await e.readView()).scopes[0]).toMatchObject({
      isDue: true, modelUnavailable: null,
      failure: { count: 1, retryAt: e.clock.now + HOUR, cause: { kind: 'error', message: expect.stringContaining('读不出来') } },
    })
    await e.advance(6 * AUTO_CHECKUP_INTERVAL_MS)
    expect(e.llm.requests).toEqual([])
    expect((await e.readView()).scopes[0]!.failure?.count).toBe(2)
    if (how === 'bad-json') expect(await readFile(broken.path, 'utf8')).toBe(broken.text)
  }
  it('选的模型读不出（bad-json）：不调任何模型、不退回默认模型，记一次失败（1 小时后再试）；选择文件原样留着', () => pickedUnreadable('bad-json'))
  // root 读得了没有读权限的文件
  it.skipIf(process.getuid?.() === 0)('选的模型读不出（no-permission）：不调任何模型、不退回默认模型，记一次失败（1 小时后再试）；选择文件原样留着', () => pickedUnreadable('no-permission'))

  it('选的提供方被删了：同样退回默认模型、照常体检并说明', async () => {
    const e = env({ llm: fakeHostLlm({ catalog: CATALOG }) })
    await e.store.create(record({ id: 'mem_g', content: '全局的记忆' }))
    await e.set({ kind: 'all' }, 1)
    await e.selections.set('checkup', { provider: 'provider-gone', model: 'model-a' })
    e.scheduler.start()
    await e.advance(AUTO_CHECKUP_FIRST_CHECK_MS)
    expect(e.llm.requests[0]).toMatchObject(DEFAULT_ROUTE)
    expect((await e.lastResultOf('global'))?.modelFallback).toEqual({ reason: 'provider-gone' })
  })

  it('退回说明写进共享的体检记录后，上一个发布版照样读得出整条记录：完成时间和结果都在', async () => {
    const e = env({ llm: fakeHostLlm({ catalog: CATALOG }) })
    await e.store.create(record({ id: 'mem_g', content: '全局的记忆' }))
    await e.set({ kind: 'all' }, 1)
    await e.selections.set('checkup', { provider: 'provider-x', model: 'model-gone' })
    e.scheduler.start()
    await e.advance(AUTO_CHECKUP_FIRST_CHECK_MS)
    const file = join(root, '.state', 'checkups', `${createHash('sha1').update(checkupKey({ kind: 'global' })).digest('hex')}.json`)
    const raw = JSON.parse(await readFile(file, 'utf8')) as unknown
    expect(raw).toMatchObject({ lastResult: { modelFallback: { reason: 'model-gone' } } })
    const legacy = legacyCheckupRecordSchema.safeParse(raw)
    expect(legacy.success).toBe(true)
    expect(legacy.data?.completed).toMatchObject({ by: 'auto' })
    expect(legacy.data?.lastResult).toMatchObject({ by: 'auto', notes: [] })
  })

  it('选的模型还在列表里、调用时报 key 被拒：记「模型用不了」并注明是选的模型，日志也说是选的模型；上一个发布版照样读得出整条记录', async () => {
    const warns: unknown[][] = []
    const log: MemoryLogger = { info() {}, warn: (...args: unknown[]) => { warns.push(args) }, error() {} }
    const e = env({ llm: fakeHostLlm({ catalog: CATALOG, reply: () => ({ code: 'AUTH', message: 'Incorrect API key provided' }) }), log })
    await e.store.create(record({ id: 'mem_g', content: '全局的记忆' }))
    await e.set({ kind: 'all' }, 1)
    await e.selections.set('checkup', { provider: 'provider-x', model: 'model-a' })
    e.scheduler.start()
    await e.advance(AUTO_CHECKUP_FIRST_CHECK_MS)
    // 用的是选的模型，没有退回默认模型
    expect(e.llm.requests.length).toBeGreaterThan(0)
    expect(e.llm.requests.every(r => r.provider === 'provider-x')).toBe(true)
    expect((await e.readView()).scopes[0]?.modelUnavailable).toEqual({ kind: 'model-error', hostCode: 'AUTH', isSelectedModel: true })
    expect(warns.map(([message]) => message)).toContainEqual(expect.stringContaining('自动体检选的模型现在用不了'))
    expect(warns.map(([message]) => message)).not.toContainEqual(expect.stringContaining('默认模型现在用不了'))
    const file = join(root, '.state', 'checkups', `${createHash('sha1').update(checkupKey({ kind: 'global' })).digest('hex')}.json`)
    const legacy = legacyCheckupRecordSchema.safeParse(JSON.parse(await readFile(file, 'utf8')))
    expect(legacy.success).toBe(true)
    expect(legacy.data?.modelUnavailable).toEqual({ kind: 'model-error', hostCode: 'AUTH' })
  })

  it('选的模型调用时报 key 被拒：放掉认领后的那次视图重写里，这个范围已经记着「模型用不了」', async () => {
    const seen: unknown[] = []
    const e: ReturnType<typeof env> = env({
      llm: fakeHostLlm({ catalog: CATALOG, reply: () => ({ code: 'AUTH', message: 'Incorrect API key provided' }) }),
      afterClaimChanged: async () => { seen.push((await e.readView()).scopes[0]?.modelUnavailable ?? null) },
      log: { info() {}, warn() {}, error() {} },
    })
    await e.store.create(record({ id: 'mem_g', content: '全局的记忆' }))
    await e.set({ kind: 'all' }, 1)
    await e.selections.set('checkup', { provider: 'provider-x', model: 'model-a' })
    e.scheduler.start()
    await e.advance(AUTO_CHECKUP_FIRST_CHECK_MS)
    // 认领到一次、放掉一次；放掉那次重写时已经带上原因，不会先显示「做完了」
    expect(seen).toEqual([null, { kind: 'model-error', hostCode: 'AUTH', isSelectedModel: true }])
  })

  it('没选模型、默认模型调用时报 key 被拒：记的「模型用不了」不带所选模型的标记，日志说默认模型', async () => {
    const warns: unknown[][] = []
    const log: MemoryLogger = { info() {}, warn: (...args: unknown[]) => { warns.push(args) }, error() {} }
    const e = env({ llm: fakeHostLlm({ catalog: CATALOG, reply: () => ({ code: 'AUTH', message: 'Incorrect API key provided' }) }), log })
    await e.store.create(record({ id: 'mem_g', content: '全局的记忆' }))
    await e.set({ kind: 'all' }, 1)
    e.scheduler.start()
    await e.advance(AUTO_CHECKUP_FIRST_CHECK_MS)
    expect((await e.readView()).scopes[0]?.modelUnavailable).toEqual({ kind: 'model-error', hostCode: 'AUTH' })
    expect(warns.map(([message]) => message)).toContainEqual(expect.stringContaining('默认模型现在用不了'))
  })

  it('选的模型下架、退回的默认模型调用时报未登录：记的是默认模型用不了', async () => {
    const e = env({ llm: fakeHostLlm({ catalog: CATALOG, reply: () => ({ code: 'ACCOUNT_SIGN_IN_REQUIRED', message: 'Sign in' }) }) })
    await e.store.create(record({ id: 'mem_g', content: '全局的记忆' }))
    await e.set({ kind: 'all' }, 1)
    await e.selections.set('checkup', { provider: 'provider-x', model: 'model-gone' })
    e.scheduler.start()
    await e.advance(AUTO_CHECKUP_FIRST_CHECK_MS)
    expect(e.llm.requests[0]).toMatchObject(DEFAULT_ROUTE)
    expect((await e.readView()).scopes[0]?.modelUnavailable).toEqual({ kind: 'model-error', hostCode: 'ACCOUNT_SIGN_IN_REQUIRED', message: 'Sign in' })
  })

  it('选的模型失效、宿主也没有默认模型：不跑，记「模型用不了」（没有默认模型）', async () => {
    const e = env({ llm: fakeHostLlm({ catalog: CATALOG }), defaultModel: undefined })
    await e.store.create(record({ id: 'mem_g', content: '全局的记忆' }))
    await e.set({ kind: 'all' }, 1)
    await e.selections.set('checkup', { provider: 'provider-gone', model: 'model-a' })
    e.scheduler.start()
    await e.advance(AUTO_CHECKUP_FIRST_CHECK_MS)
    expect(e.llm.requests).toEqual([])
    expect((await e.readView()).scopes[0]?.modelUnavailable).toEqual({ kind: 'no-default-model' })
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

  it('拿不到宿主默认模型时不跑、不写完成记录，到期的范围都记「模型用不了」（没有默认模型），不算失败；默认模型回来后下一次检查照常跑', async () => {
    const e = env({ defaultModel: undefined })
    await e.store.create(record({ id: 'mem_g', content: '全局的记忆' }))
    await e.store.create(record({ id: 'mem_a', content: '项目 a 的记忆', scope: 'workspace', workspacePath: OTHER_A }))
    await e.store.create(record({ id: 'mem_b', content: '项目 b 的记忆', scope: 'workspace', workspacePath: OTHER_B }))
    await e.set({ kind: 'all' }, 1)
    // 仅手动的范围不到期，不记
    await e.set(ws(OTHER_B), 'manual')
    e.scheduler.start()
    await e.advance(AUTO_CHECKUP_FIRST_CHECK_MS)
    expect(e.llm.requests).toEqual([])
    expect(await e.completed()).toEqual({})
    const view = await e.readView()
    expect(view.scopes.map(s => [s.scope.kind === 'global' ? 'global' : s.scope.workspacePath, s.modelUnavailable, s.failure, s.isDue])).toEqual([
      ['global', { kind: 'no-default-model' }, null, true],
      [OTHER_A, { kind: 'no-default-model' }, null, true],
      [OTHER_B, null, null, false],
    ])
    e.route.current = DEFAULT_ROUTE
    await e.advance(AUTO_CHECKUP_INTERVAL_MS)
    expect(e.llm.requests.map(scopeOfRequest)).toEqual(['global', OTHER_A])
    expect((await e.readView()).scopes.map(s => s.modelUnavailable)).toEqual([null, null, null])
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
    expect(await e.lastResultOf('global')).toBeUndefined()
    // 下次打开：仍是到期
    const status = await collectCheckupView({ store: e.store, checkups: e.checkups, autoCheckups: e.autoCheckups, cache: e.cache, now: () => e.clock.now })
    expect(status.scopes[0]).toMatchObject({ scope: { kind: 'global' }, isDue: true, lastCheckupAt: null })
  })
})

describe('自动体检调度：项目记忆删光', () => {
  it('删光记忆的项目不再自动体检；体检视图仍列出它的单独设置和上次体检', async () => {
    const e = env()
    await e.store.create(record({ id: 'mem_a', content: '项目 a 的记忆', scope: 'workspace', workspacePath: OTHER_A }))
    await e.set(ws(OTHER_A), 1)
    e.scheduler.start()
    await e.advance(AUTO_CHECKUP_FIRST_CHECK_MS)
    expect(e.llm.requests.map(scopeOfRequest)).toEqual([OTHER_A])
    const checkedAt = (await e.completed())[checkupKey(ws(OTHER_A))]?.completedAt
    expect(checkedAt).toBeDefined()

    await e.store.softDelete({ id: 'mem_a', workspacePath: OTHER_A })
    await e.advance(DAY + AUTO_CHECKUP_INTERVAL_MS)
    expect(e.llm.requests.map(scopeOfRequest)).toEqual([OTHER_A])
    const entry = (await e.readView()).scopes.find(s => s.scope.kind === 'workspace')
    expect(entry).toMatchObject({
      scope: ws(OTHER_A), frequency: 1, isOwn: true, isCheckable: false, lastCheckupAt: checkedAt, isDue: false, nextCheckupAt: null,
    })
  })

  it('删光记忆的项目重新有了记忆：按原来的单独设置恢复自动体检，体检视图又列为可体检', async () => {
    const e = env()
    await e.store.create(record({ id: 'mem_a', content: '项目 a 的记忆', scope: 'workspace', workspacePath: OTHER_A }))
    await e.set(ws(OTHER_A), 1)
    e.scheduler.start()
    await e.advance(AUTO_CHECKUP_FIRST_CHECK_MS)
    expect(e.llm.requests.map(scopeOfRequest)).toEqual([OTHER_A])

    await e.store.softDelete({ id: 'mem_a', workspacePath: OTHER_A })
    await e.advance(DAY + AUTO_CHECKUP_INTERVAL_MS)
    expect(e.llm.requests.map(scopeOfRequest)).toEqual([OTHER_A])

    await e.store.create(record({ id: 'mem_a2', content: '重新写入的项目 a 的记忆', scope: 'workspace', workspacePath: OTHER_A }))
    await e.advance(AUTO_CHECKUP_INTERVAL_MS)
    expect(e.llm.requests.map(scopeOfRequest)).toEqual([OTHER_A, OTHER_A])
    const entry = (await e.readView()).scopes.find(s => s.scope.kind === 'workspace')
    expect(entry).toMatchObject({ scope: ws(OTHER_A), frequency: 1, isOwn: true, isCheckable: true, isDue: false })
    expect(entry?.lastCheckupAt).toBe((await e.completed())[checkupKey(ws(OTHER_A))]?.completedAt)
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
      instructions: noInstructions, host: { contextOf: async () => ({ workspacePath: undefined }), llmOf: () => agentLlm }, now: () => e.clock.now,
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
    expect(await e.completed()).toEqual({ global: { startedAt: autoStartedAt + 1000, completedAt: autoStartedAt + 3000, by: 'agent', coverage: expect.any(Object) } })
    const status = await collectCheckupView({ store: e.store, checkups: e.checkups, autoCheckups: e.autoCheckups, cache: e.cache, now: () => e.clock.now })
    expect(status.scopes[0]!.lastCheckupAt).toBeGreaterThanOrEqual(lastAfterAuto)
    expect((await e.cache.get('global'))?.scannedAt ?? (await e.cache.list())[0]?.[1].scannedAt).toBeGreaterThanOrEqual(autoStartedAt)
  })
})

describe('自动体检调度：核对所选模型时宿主列提供方出错', () => {
  const CATALOG = { deepseek: { 'deepseek-v4-flash': [] }, 'provider-x': { 'model-a': ['low', 'high'] } }
  /** 宿主列提供方时抛错，其余照常。 */
  const providersFail = (llm: ReturnType<typeof fakeHostLlm>): ReturnType<typeof fakeHostLlm> =>
    ({ ...llm, listProviders: () => { throw Object.assign(new Error('listing providers failed'), { code: 'TRANSPORT' }) } })

  it('确认不了：这一轮照常用选的模型体检、写完成记录，不算退回', async () => {
    const e = env({ llm: providersFail(fakeHostLlm({ catalog: CATALOG })) })
    await e.store.create(record({ id: 'mem_g', content: '全局的记忆' }))
    await e.set({ kind: 'all' }, 1)
    await e.selections.set('checkup', { provider: 'provider-x', model: 'model-a', reasoningEffort: 'high' })
    await expect(e.scheduler.recheck()).resolves.toBeUndefined()
    expect(e.llm.requests).toHaveLength(1)
    expect(e.llm.requests[0]).toMatchObject({ provider: 'provider-x', model: 'model-a', reasoningEffort: 'high' })
    expect((await e.completed()).global).toMatchObject({ by: 'auto' })
    expect((await e.lastResultOf('global'))?.modelFallback).toBeUndefined()
  })

  it('随后选的模型调用出错：记体检失败、带重试时间，不写完成记录', async () => {
    const e = env({ llm: providersFail(fakeHostLlm({ catalog: CATALOG, reply: () => ({ code: 'RATE_LIMIT', message: 'too many requests' }) })) })
    await e.store.create(record({ id: 'mem_g', content: '全局的记忆' }))
    await e.set({ kind: 'all' }, 1)
    await e.selections.set('checkup', { provider: 'provider-x', model: 'model-a' })
    await expect(e.scheduler.recheck()).resolves.toBeUndefined()
    expect(e.llm.requests[0]).toMatchObject({ provider: 'provider-x', model: 'model-a' })
    expect(await e.completed()).toEqual({})
    expect((await e.readView()).scopes[0]).toMatchObject({
      modelUnavailable: null,
      failure: { count: 1, retryAt: e.clock.now + HOUR, cause: { kind: 'model-error', hostCode: 'RATE_LIMIT' } },
    })
  })
})

describe('自动体检调度：一轮检查里意外出错', () => {
  it('取宿主默认模型时抛错：不冒成未处理的 rejection，记日志和一次失败（1 小时后再试），之后的检查照常调度', async () => {
    const warns: unknown[][] = []
    let warned!: () => void
    const firstWarn = new Promise<void>((resolve) => { warned = resolve })
    const log: MemoryLogger = { info() {}, warn: (...args: unknown[]) => { warns.push(args); warned() }, error() {} }
    let isHostBroken = true
    const e = env({
      log,
      wrapDefaultLlm: real => () => {
        if (isHostBroken) throw new Error('宿主默认模型读取出错')
        return real()
      },
    })
    await e.store.create(record({ id: 'mem_g', content: '全局的记忆' }))
    await e.set({ kind: 'all' }, 1)
    const rejections: unknown[] = []
    const onRejection = (reason: unknown) => { rejections.push(reason); warned() }
    process.on('unhandledRejection', onRejection)
    try {
      e.scheduler.start()
      // 只推进计时、不等这一轮：定时器回调里发起的检查没人接，出错就是未处理的 rejection
      e.timers.advance(AUTO_CHECKUP_FIRST_CHECK_MS)
      await firstWarn
      // 未处理的 rejection 在微任务清空之后才报：再过一个宏任务
      await new Promise<void>((resolve) => { setImmediate(resolve) })
      expect(rejections).toEqual([])
    } finally {
      process.off('unhandledRejection', onRejection)
    }
    await e.scheduler.whenIdle()
    const failedAt = e.clock.now
    expect(warns.some(args => args.some(a => a instanceof Error && a.message === '宿主默认模型读取出错'))).toBe(true)
    expect(e.llm.requests).toEqual([])
    expect((await e.readView()).scopes[0]).toMatchObject({
      isDue: true, modelUnavailable: null,
      failure: { count: 1, retryAt: failedAt + HOUR, cause: { kind: 'error', message: '宿主默认模型读取出错' } },
    })

    // 宿主恢复：1 小时之内的检查不再试，到了 1 小时照常体检
    isHostBroken = false
    await e.advance(5 * AUTO_CHECKUP_INTERVAL_MS)
    expect(e.llm.requests).toEqual([])
    await e.advance(AUTO_CHECKUP_INTERVAL_MS)
    expect(e.llm.requests).toHaveLength(1)
    expect(Object.keys(await e.completed())).toEqual(['global'])
  })
  it('读完到期状态后另一次体检做完了，随后出错：这个范围不记失败，完成记录照留', async () => {
    let isCompletedElsewhere = false
    const e: ReturnType<typeof env> = env({
      log: { info() {}, warn() {}, error() {} },
      // 读完状态（全局还到期）之后，另一次开始得更早的体检刚好做完
      wrapStatus: read => async () => {
        const view = await read()
        if (!isCompletedElsewhere) {
          isCompletedElsewhere = true
          await e.checkups.complete([{ kind: 'global' }], { startedAt: e.clock.now - 60_000, completedAt: e.clock.now, by: 'manual' })
        }
        return view
      },
      wrapDefaultLlm: () => () => { throw new Error('宿主默认模型读取出错') },
    })
    await e.store.create(record({ id: 'mem_g', content: '全局的记忆' }))
    await e.set({ kind: 'all' }, 1)
    await expect(e.scheduler.recheck()).resolves.toBeUndefined()
    expect(e.llm.requests).toEqual([])
    const [stored] = await e.checkups.list()
    expect(stored).toMatchObject({ completed: { completedAt: e.clock.now, by: 'manual' } })
    expect(stored).not.toHaveProperty('failure')
    expect((await e.readView()).scopes[0]).toMatchObject({ failure: null, isDue: false })
  })

  it('一次体检已经记了失败，放掉认领后的收尾又出错：失败只记这一次，原因不被盖掉', async () => {
    let claimChanges = 0
    const e = env({
      llm: fakeHostLlm({ reply: () => 'garbage' }),
      log: { info() {}, warn() {}, error() {} },
      // 第二次是放掉认领之后
      afterClaimChanged: async () => { if (++claimChanges === 2) throw new Error('收尾时重写视图出错') },
    })
    await e.store.create(record({ id: 'mem_g', content: '全局的记忆' }))
    await e.set({ kind: 'all' }, 1)
    await expect(e.scheduler.recheck()).resolves.toBeUndefined()
    expect(claimChanges).toBe(2)
    expect((await e.readView()).scopes[0]!.failure).toMatchObject({ count: 1, cause: { kind: 'unparseable' } })
  })
})

describe('自动体检调度：失败与重试', () => {
  /** 一次体检尝试 = 一次调用加内容检查自带的一次重试（两次都不成才算没做完）。 */
  const ATTEMPT = 2
  const failureOf = async (e: ReturnType<typeof env>) => (await e.readView()).scopes[0]!.failure

  it('模型调用出错：不写完成记录、不重新计时，体检视图写原因和重试时间；1 小时后再试，连续 3 次后等到下一个周期', async () => {
    let reply: HostReply = { code: 'RATE_LIMIT', message: 'too many requests' }
    const e = env({ llm: fakeHostLlm({ reply: () => reply }) })
    await e.store.create(record({ id: 'mem_g', content: '全局的记忆' }))
    await e.set({ kind: 'all' }, 7)
    e.scheduler.start()
    await e.advance(AUTO_CHECKUP_FIRST_CHECK_MS)
    const firstAt = e.clock.now
    expect(e.llm.requests).toHaveLength(ATTEMPT)
    expect(await e.completed()).toEqual({})
    const cause = { kind: 'model-error', hostCode: 'RATE_LIMIT', message: 'too many requests' }
    expect((await e.readView()).scopes[0]).toMatchObject({
      lastCheckupAt: null, isDue: true, modelUnavailable: null,
      failure: { count: 1, retryAt: firstAt + HOUR, isRetryLimitReached: false, cause },
    })

    // 1 小时之内的检查不再试
    await e.advance(5 * AUTO_CHECKUP_INTERVAL_MS)
    expect(e.llm.requests).toHaveLength(ATTEMPT)
    // 到了 1 小时：再试，又失败
    await e.advance(AUTO_CHECKUP_INTERVAL_MS)
    expect(e.llm.requests).toHaveLength(2 * ATTEMPT)
    expect(await failureOf(e)).toEqual({ count: 2, retryAt: firstAt + 2 * HOUR, isRetryLimitReached: false, cause })
    // 第 3 次也失败：等到下一个周期（7 天后）
    await e.advance(6 * AUTO_CHECKUP_INTERVAL_MS)
    expect(e.llm.requests).toHaveLength(3 * ATTEMPT)
    const thirdAt = firstAt + 2 * HOUR
    expect(await failureOf(e)).toEqual({ count: 3, retryAt: thirdAt + 7 * DAY, isRetryLimitReached: true, cause })
    await e.advance(7 * DAY - 2 * AUTO_CHECKUP_INTERVAL_MS)
    expect(e.llm.requests).toHaveLength(3 * ATTEMPT)
    // 到了下一个周期：再试，这次成了，失败记录清掉
    reply = 'ok'
    await e.advance(2 * AUTO_CHECKUP_INTERVAL_MS)
    expect(e.llm.requests).toHaveLength(3 * ATTEMPT + 1)
    expect(Object.keys(await e.completed())).toEqual(['global'])
    expect((await e.readView()).scopes[0]).toMatchObject({ failure: null, modelUnavailable: null, isDue: false })
  })

  it('没做完的自动体检也写最近一次结果，说明码带原因；完成记录仍是上一次做完的那次', async () => {
    let reply: HostReply = 'ok'
    const e = env({ llm: fakeHostLlm({ reply: () => reply }) })
    await e.store.create(record({ id: 'mem_g', content: '全局的记忆' }))
    await e.set({ kind: 'all' }, 1)
    e.scheduler.start()
    await e.advance(AUTO_CHECKUP_FIRST_CHECK_MS)
    const done = await e.lastResultOf('global')
    expect(done).toMatchObject({ by: 'auto' })
    reply = { code: 'RATE_LIMIT', message: 'too many requests' }
    await e.advance(DAY)
    expect((await failureOf(e))?.count).toBe(1)
    const failed = await e.lastResultOf('global')
    expect(failed).toMatchObject({ by: 'auto', notes: [{ code: 'semantic-failed', cause: { kind: 'model-error', hostCode: 'RATE_LIMIT' } }] })
    expect(failed!.checkupId).not.toBe(done!.checkupId)
    expect(Object.keys(await e.completed())).toEqual(['global'])
  })

  it('模型输出解析不了：按失败算，原因是解析不了', async () => {
    const e = env({ llm: fakeHostLlm({ reply: () => 'garbage' }) })
    await e.store.create(record({ id: 'mem_g', content: '全局的记忆' }))
    await e.set({ kind: 'all' }, 1)
    e.scheduler.start()
    await e.advance(AUTO_CHECKUP_FIRST_CHECK_MS)
    expect(await failureOf(e)).toEqual({ count: 1, retryAt: e.clock.now + HOUR, isRetryLimitReached: false, cause: { kind: 'unparseable' } })
    expect(await e.completed()).toEqual({})
  })

  it('一个范围失败不挡别的范围：下一个到期的范围照常查', async () => {
    const e = env({ llm: fakeHostLlm({ reply: () => 'garbage' }) })
    await e.store.create(record({ id: 'mem_g', content: '全局的记忆' }))
    await e.store.create(record({ id: 'mem_a', content: '项目 a 的记忆', scope: 'workspace', workspacePath: OTHER_A }))
    await e.set({ kind: 'all' }, 1)
    e.scheduler.start()
    await e.advance(AUTO_CHECKUP_FIRST_CHECK_MS)
    expect(e.llm.requests.map(scopeOfRequest)).toEqual(['global', 'global', OTHER_A, OTHER_A])
    expect((await e.readView()).scopes.map(s => s.failure?.count)).toEqual([1, 1])
  })

  it('用户手动体检成功后：失败计数清零，重新计时', async () => {
    const e = env({ llm: fakeHostLlm({ reply: () => ({ code: 'TIMEOUT', message: 'request timed out' }) }) })
    await e.store.create(record({ id: 'mem_g', content: '全局的记忆' }))
    await e.set({ kind: 'all' }, 1)
    e.scheduler.start()
    await e.advance(AUTO_CHECKUP_FIRST_CHECK_MS)
    await e.advance(6 * AUTO_CHECKUP_INTERVAL_MS)
    expect((await failureOf(e))?.count).toBe(2)
    // 界面手动体检（借用会话的模型）做完：写完成记录
    const manualAt = e.clock.now
    await executeScan({ layers: 'full' }, {
      store: e.store, registry, decisions: e.decisions, cache: e.cache, checkups: e.checkups,
      instructions: noInstructions, host: { contextOf: async () => ({ workspacePath: undefined }), llmOf: () => ({ complete: async () => '{"findings":[]}' }) }, now: () => e.clock.now,
    }, fakeExec(), { by: 'manual', isGlobalOnly: true })
    await e.advance(AUTO_CHECKUP_INTERVAL_MS)
    expect((await e.readView()).scopes[0]).toMatchObject({ failure: null, lastCheckupAt: manualAt, nextCheckupAt: manualAt + DAY, isDue: false })
    expect((await e.checkups.list())[0]).not.toHaveProperty('failure')
  })
})

describe('自动体检调度：重试时间按当前频率算', () => {
  it('连续失败到上限后把频率从每 30 天改成每天：重试时间跟着变成失败时刻加 1 天，到点就再试', async () => {
    const e = env({ llm: fakeHostLlm({ reply: () => ({ code: 'RATE_LIMIT', message: 'too many requests' }) }) })
    await e.store.create(record({ id: 'mem_g', content: '全局的记忆' }))
    await e.set({ kind: 'all' }, 30)
    e.scheduler.start()
    await e.advance(AUTO_CHECKUP_FIRST_CHECK_MS)
    await e.advance(6 * AUTO_CHECKUP_INTERVAL_MS)
    await e.advance(6 * AUTO_CHECKUP_INTERVAL_MS)
    const thirdAt = NOW + AUTO_CHECKUP_FIRST_CHECK_MS + 2 * HOUR
    expect((await e.readView()).scopes[0]!.failure).toMatchObject({ count: 3, retryAt: thirdAt + 30 * DAY, isRetryLimitReached: true })
    const tried = e.llm.requests.length
    await e.set({ kind: 'all' }, 1)
    await e.advance(AUTO_CHECKUP_INTERVAL_MS)
    expect((await e.readView()).scopes[0]!.failure).toMatchObject({ count: 3, retryAt: thirdAt + DAY })
    expect(e.llm.requests).toHaveLength(tried)
    await e.advance(DAY)
    expect(e.llm.requests.length).toBeGreaterThan(tried)
  })
})

describe('自动体检调度：上次体检的兜底（没有完成记录时取缓存时间）', () => {
  /** 这时刻两个视图里全局的上次体检：体检视图（调度器据它判到期）和健康视图。 */
  const lastOf = async (e: ReturnType<typeof env>) => {
    const now = () => e.clock.now
    const checkup = (await collectCheckupView({ store: e.store, checkups: e.checkups, autoCheckups: e.autoCheckups, cache: e.cache, now })).scopes[0]!
    const { health } = await collectGlobalViews({ store: e.store, decisions: e.decisions, cache: e.cache, ignores: new AdviceIgnoreStore(e.sidecar.adviceIgnores), checkups: e.checkups, registry, memoryRoot: root, now })
    return { checkup: [checkup.lastCheckupAt, checkup.isDue], health: health.layers[0]!.lastCheckupAt }
  }

  it('从没完成过的范围：执行器查完一批、在提交点（写视图）前取消，仍到期、上次体检仍是没体检过，调度器照常去查', async () => {
    const e = env()
    await e.store.create(record({ id: 'mem_g', content: '全局的记忆' }))
    await e.set({ kind: 'all' }, 1)
    const controller = new AbortController()
    // 模型答完就取消：执行器停在挂账前的检查点，不写视图和完成记录
    const llm = { complete: async () => { controller.abort(); return '{"findings":[]}' } }
    await executeScan({ layers: 'full' }, {
      store: e.store, registry, decisions: e.decisions, cache: e.cache, checkups: e.checkups,
      instructions: noInstructions, host: { contextOf: async () => ({ workspacePath: undefined }), llmOf: () => llm }, now: () => e.clock.now,
    }, { ...fakeExec(), signal: controller.signal }, { by: 'auto', isGlobalOnly: true }).catch(() => undefined)
    expect(await e.cache.list()).toHaveLength(0)
    expect(await e.completed()).toEqual({})
    expect(await lastOf(e)).toEqual({ checkup: [null, true], health: null })
    e.scheduler.start()
    await e.advance(AUTO_CHECKUP_FIRST_CHECK_MS)
    expect(e.llm.requests).toHaveLength(1)
  })

  it('升级前的旧缓存（没有标记）：照旧当上次体检', async () => {
    const e = env()
    await e.store.create(record({ id: 'mem_g', content: '全局的记忆' }))
    await e.set({ kind: 'all' }, 1)
    const at = NOW - HOUR
    await e.cache.put(GLOBAL_CACHE_KEY, { id: GLOBAL_CACHE_KEY, scannedAt: at, scope: 'global', findings: [] })
    expect(await lastOf(e)).toEqual({ checkup: [at, false], health: at })
  })
})

describe('自动体检调度：模型用不了', () => {
  it('PA-57 宿主回未登录：这次不跑、不算失败、不重新计时，到期的范围都记「模型用不了」和原因；下一次检查再试，登录后开始跑', async () => {
    let reply: HostReply = { code: 'ACCOUNT_SIGN_IN_REQUIRED', message: 'Sign in to DeepSeek to use the account provider.' }
    const e = env({ llm: fakeHostLlm({ reply: () => reply }) })
    await e.store.create(record({ id: 'mem_g', content: '全局的记忆' }))
    await e.store.create(record({ id: 'mem_a', content: '项目 a 的记忆', scope: 'workspace', workspacePath: OTHER_A }))
    await e.set({ kind: 'all' }, 1)
    e.scheduler.start()
    await e.advance(AUTO_CHECKUP_FIRST_CHECK_MS)
    // 只试了第一个范围：模型用不了，别的范围不再白试
    expect(e.llm.requests.map(scopeOfRequest).every(s => s === 'global')).toBe(true)
    const tried = e.llm.requests.length
    expect(await e.completed()).toEqual({})
    const cause = { kind: 'model-error', hostCode: 'ACCOUNT_SIGN_IN_REQUIRED', message: 'Sign in to DeepSeek to use the account provider.' }
    const view = await e.readView()
    expect(view.scopes.map(s => [s.modelUnavailable, s.failure, s.isDue, s.lastCheckupAt])).toEqual([
      [cause, null, true, null],
      [cause, null, true, null],
    ])
    // 是体检记录里的事实：另一个进程读到的一样
    const other = new SidecarStore({ root, schemas })
    const seen = await collectCheckupView({ store: e.store, checkups: new CheckupRecordStore(other.checkups), autoCheckups: new AutoCheckupSettingStore(other.autoCheckups), cache: other.scanCache, now: () => e.clock.now })
    expect(seen.scopes.map(s => s.modelUnavailable)).toEqual([cause, cause])

    // 下一次检查（10 分钟后，不等 1 小时）再试
    await e.advance(AUTO_CHECKUP_INTERVAL_MS)
    expect(e.llm.requests.length).toBeGreaterThan(tried)
    expect((await e.readView()).scopes.map(s => s.failure)).toEqual([null, null])
    // 登录了：下一次检查开始跑，「模型用不了」清掉
    reply = 'ok'
    await e.advance(AUTO_CHECKUP_INTERVAL_MS)
    expect(Object.keys(await e.completed()).sort()).toEqual(['global', OTHER_A].sort())
    expect((await e.readView()).scopes.map(s => s.modelUnavailable)).toEqual([null, null])
  })

  it('缺凭据（API key 路由）同样记「模型用不了」', async () => {
    const e = env({ llm: fakeHostLlm({ reply: () => ({ code: 'MISSING_CREDENTIAL', message: 'llm-deepseek: no API key' }) }) })
    await e.store.create(record({ id: 'mem_g', content: '全局的记忆' }))
    await e.set({ kind: 'all' }, 1)
    e.scheduler.start()
    await e.advance(AUTO_CHECKUP_FIRST_CHECK_MS)
    expect((await e.readView()).scopes[0]).toMatchObject({
      failure: null, modelUnavailable: { kind: 'model-error', hostCode: 'MISSING_CREDENTIAL', message: 'llm-deepseek: no API key' },
    })
  })

  it('本轮开头读到要查的范围，模型用不了时它已被别处查完（完成在本轮开始之后）：不给它记「模型用不了」', async () => {
    let open!: () => void
    const gate = new Promise<void>(resolve => { open = resolve })
    const llm = fakeHostLlm({ gate: () => gate, reply: () => ({ code: 'ACCOUNT_SIGN_IN_REQUIRED', message: 'Sign in' }) })
    const e = env({ llm })
    await e.store.create(record({ id: 'mem_g', content: '全局的记忆' }))
    await e.store.create(record({ id: 'mem_a', content: '项目 a 的记忆', scope: 'workspace', workspacePath: OTHER_A }))
    await e.set({ kind: 'all' }, 1)
    e.scheduler.start()
    e.timers.advance(AUTO_CHECKUP_FIRST_CHECK_MS)
    await llm.nthStarted(1)
    // 全局还在等模型时，别处（agent 体检不认领）把项目 a 查完了
    const at = e.clock.now
    await e.checkups.complete([{ kind: 'workspace', workspacePath: OTHER_A }], { startedAt: at, completedAt: at, by: 'agent' })
    open()
    await e.scheduler.whenIdle()
    const records = Object.fromEntries((await e.checkups.list()).map(r => [r.id, r]))
    expect(records['global']?.modelUnavailable).toMatchObject({ hostCode: 'ACCOUNT_SIGN_IN_REQUIRED' })
    expect(records[OTHER_A]).not.toHaveProperty('modelUnavailable')
    expect(records[OTHER_A]?.completed).toEqual({ startedAt: at, completedAt: at, by: 'agent' })
  })

  it('key 被拒（AUTH）：原话可能回显部分凭据，不进体检记录和体检视图，只留错误码', async () => {
    const e = env({ llm: fakeHostLlm({ reply: () => ({ code: 'AUTH', message: 'Incorrect API key provided: sk-abcdefghijklmnop1234' }) }) })
    await e.store.create(record({ id: 'mem_g', content: '全局的记忆' }))
    await e.set({ kind: 'all' }, 1)
    e.scheduler.start()
    await e.advance(AUTO_CHECKUP_FIRST_CHECK_MS)
    expect((await e.readView()).scopes[0]!.modelUnavailable).toEqual({ kind: 'model-error', hostCode: 'AUTH' })
    const files = [join(root, GUI_VIEW_DIR, GUI_CHECKUP_VIEW_FILE), join(root, '.state', 'checkups', `${createHash('sha1').update('global').digest('hex')}.json`)]
    for (const file of files) {
      const text = await readFile(file, 'utf8')
      expect(text).not.toContain('abcdefghijklmnop1234')
      expect(text).not.toContain('Incorrect API key')
    }
  })

  it('其他错误的原话带疑似密钥：记进失败原因前遮掉', async () => {
    const e = env({ llm: fakeHostLlm({ reply: () => ({ code: 'RATE_LIMIT', message: 'slow down, token=sk-abcdefghijklmnop1234' }) }) })
    await e.store.create(record({ id: 'mem_g', content: '全局的记忆' }))
    await e.set({ kind: 'all' }, 1)
    e.scheduler.start()
    await e.advance(AUTO_CHECKUP_FIRST_CHECK_MS)
    const cause = (await e.readView()).scopes[0]!.failure?.cause
    expect(cause).toMatchObject({ kind: 'model-error', hostCode: 'RATE_LIMIT' })
    expect(cause?.message).toContain('slow down')
    expect(cause?.message).not.toContain('abcdefghijklmnop1234')
  })

  it('已经失败过一次的范围遇到模型用不了：不加失败次数，原来的失败记录不动；之后再失败接着数', async () => {
    let reply: HostReply = { code: 'RATE_LIMIT', message: 'too many requests' }
    const e = env({ llm: fakeHostLlm({ reply: () => reply }) })
    await e.store.create(record({ id: 'mem_g', content: '全局的记忆' }))
    await e.set({ kind: 'all' }, 1)
    e.scheduler.start()
    await e.advance(AUTO_CHECKUP_FIRST_CHECK_MS)
    const failure = (await e.readView()).scopes[0]!.failure
    expect(failure?.count).toBe(1)
    reply = { code: 'ACCOUNT_TOKEN_INVALID', message: 'token rejected' }
    await e.advance(6 * AUTO_CHECKUP_INTERVAL_MS)
    expect((await e.readView()).scopes[0]).toMatchObject({ failure, modelUnavailable: { kind: 'model-error', hostCode: 'ACCOUNT_TOKEN_INVALID' } })
    // 模型回来了但调用出错：按失败算，接着上次的次数；「模型用不了」清掉（最近一次尝试不是它了）
    reply = { code: 'RATE_LIMIT', message: 'too many requests' }
    await e.advance(AUTO_CHECKUP_INTERVAL_MS)
    expect((await e.readView()).scopes[0]).toMatchObject({ failure: { count: 2 }, modelUnavailable: null })
  })
})

describe('自动体检调度：体检之后生成处理建议', () => {
  const conflict = () => [{ type: 'conflict', memoryIds: ['mem_x', 'mem_y'], summary: '端口说法矛盾', suggestedAction: '请裁决' }]
  async function seedDue(e: ReturnType<typeof env>) {
    await e.store.create(record({ id: 'mem_x', name: '端口甲', content: '端口 3000' }))
    await e.store.create(record({ id: 'mem_y', name: '端口乙', content: '端口 4000' }))
    await e.set({ kind: 'all' }, 1)
  }
  const keepA = JSON.stringify({ action: 'keep-a', reason: '甲更新' })

  it('故事 27：扫出的冲突接着用默认模型生成建议，卡上有建议；用量（含生成建议那次）记进这次的结果', async () => {
    const e = env({ llm: fakeHostLlm({ findings: conflict, suggestion: () => keepA }), suggestions: {} })
    await seedDue(e)
    e.scheduler.start()
    await e.advance(AUTO_CHECKUP_FIRST_CHECK_MS)
    expect(e.llm.requests).toHaveLength(2)
    expect(e.llm.requests[1]).toMatchObject(DEFAULT_ROUTE)
    const [entry] = await e.decisions.list()
    expect(entry?.suggestion).toMatchObject({ action: 'keep-a', reason: '甲更新' })
    expect(entry?.suggestionAttempts?.count).toBe(1)
    expect((await e.lastResultOf(checkupKey({ kind: 'global' })))?.usageTokens).toBe(1280 + 320)
    expect((await e.readView()).scopes[0]?.lastResult?.usageTokens).toBe(1280 + 320)
  })

  it('故事 28：生成建议失败不影响体检：照常算做完，失败次数和重试节奏不动，卡上写没生成成', async () => {
    const e = env({ llm: fakeHostLlm({ findings: conflict, suggestion: () => ({ code: 'RATE_LIMIT', message: 'too many requests' }) }), suggestions: {} })
    await seedDue(e)
    e.scheduler.start()
    await e.advance(AUTO_CHECKUP_FIRST_CHECK_MS)
    const at = NOW + AUTO_CHECKUP_FIRST_CHECK_MS
    expect((await e.completed()).global).toEqual({ startedAt: at, completedAt: at, by: 'auto', coverage: expect.any(Object) })
    expect((await e.readView()).scopes[0]).toMatchObject({ failure: null, isDue: false })
    expect((await e.decisions.list())[0]?.suggestionFailure?.cause).toMatchObject({ kind: 'model-error', hostCode: 'RATE_LIMIT' })
  })

  it('后续段抛错：只记日志，体检照常算做完，不记自动体检的失败', async () => {
    const e = env({
      llm: fakeHostLlm({ findings: conflict, suggestion: () => keepA }),
      suggestions: { decisions: real => ({ list: () => Promise.reject(new Error('读不了账本')), get: id => real.get(id), writeSuggestion: (...args) => real.writeSuggestion(...args) }) },
    })
    await seedDue(e)
    e.scheduler.start()
    await e.advance(AUTO_CHECKUP_FIRST_CHECK_MS)
    expect((await e.readView()).scopes[0]).toMatchObject({ failure: null, isDue: false, lastResult: expect.objectContaining({ by: 'auto' }) })
    expect((await e.decisions.list())[0]?.suggestion).toBeUndefined()
  })

  it('到期项目的记忆和这个项目的指令文件矛盾：后台体检照样查出来，接着生成建议；发给模型的是这个项目的指令文件', async () => {
    const PROJECT_TEXT = '全局：注释用英文\nA：包管理用 pnpm'
    const llm = fakeHostLlm({
      // 指令文件里有那句、记忆列表里有那条记忆，就报这条记忆和指令文件矛盾
      findings: req => JSON.stringify(req.messages).includes('包管理用 pnpm')
        ? [{ type: 'conflict', memoryIds: ['mem_v'], baselineRef: 'AGENTS.md：包管理用 pnpm', summary: '和指令文件矛盾', suggestedAction: '请裁决' }]
        : [],
      suggestion: () => JSON.stringify({ action: 'delete', reason: '指令文件已经规定' }),
    })
    const e = env({ llm, suggestions: {}, instructions: instructionsOf({ [DISCUSSION]: PROJECT_TEXT }) })
    await e.store.create(record({ id: 'mem_v', name: '包管理', content: '包管理用 npm', scope: 'workspace', workspacePath: DISCUSSION }))
    await e.set(ws(DISCUSSION), 1)
    e.scheduler.start()
    await e.advance(AUTO_CHECKUP_FIRST_CHECK_MS)

    const [entry] = await e.decisions.list()
    expect(entry).toMatchObject({ memoryIds: ['mem_v'], baselineRef: 'AGENTS.md：包管理用 pnpm' })
    expect(entry?.suggestion).toMatchObject({ action: 'delete', reason: '指令文件已经规定' })
    expect(entry?.suggestion?.basis?.baseline).toMatchObject({ workspace: DISCUSSION })
    expect(e.llm.requests).toHaveLength(2)
    expect(JSON.stringify(e.llm.requests[1]!.messages)).toContain('A：包管理用 pnpm')
    expect((await e.lastResultOf(checkupKey(ws(DISCUSSION))))?.notes).toEqual([])
  })

  it('插件卸载时不等生成建议的模型调用结束：不写建议，体检的完成记录照留', async () => {
    let open: (() => void) | undefined
    const gate = new Promise<void>(resolve => { open = resolve })
    const e = env({ llm: fakeHostLlm({ findings: conflict, suggestion: () => keepA, suggestionGate: () => gate }), suggestions: {} })
    await seedDue(e)
    e.scheduler.start()
    e.timers.advance(AUTO_CHECKUP_FIRST_CHECK_MS)
    await e.llm.nthStarted(2)
    // 宿主这次调用不理会取消：卸载照样很快结束
    await e.scheduler.dispose()
    expect((await e.decisions.list())[0]?.suggestion).toBeUndefined()
    expect((await e.completed()).global).toMatchObject({ by: 'auto' })
    open?.()
  })
})
