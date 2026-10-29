import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fakeExec } from './helpers/exec.ts'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { TurnBoundaryProjection } from '@deepseek-ai/dsh-agent'
import { Context } from '@deepseek-ai/cordis'
import Registry, { type SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { Session, SESSION_FORMAT_VERSION, type SessionEvent, type SessionHeader, type SessionId } from '@deepseek-ai/dsh-session'
import { createSystemMessage, createUserMessage, type MessageSourceMap, type UserMessage } from '@deepseek-ai/dsh-llm'

// 真实 dsh-tools / dsh-storage-domain 包已从 npm 装好，此处不 mock 任何框架包。
import { apply, Config, inject } from '../src/index.ts'
import { InMemoryKvTable } from '../src/kv-table.ts'
import { SidecarStore, STATE_DIR, KV_IMPORT_MARKER, RECALL_STATS_FILE } from '../src/storage/sidecar.ts'
import { kvImportMarkerSchema } from '../src/storage/schema.ts'
import { WORKSPACE_MARKER, workspaceDirName } from '../src/storage/paths.ts'
import { encodeRecord } from '../src/storage/frontmatter.ts'
import { TypeRegistryError } from '../src/errors.ts'
import { buildSemanticPrompt } from '../src/governance/semantic-scan.ts'
import { record } from './helpers/record.ts'
import { MemoryStore } from '../src/store.ts'
import { overflowLevel } from '../src/snapshot.ts'
import { SNAPSHOT_SOURCE_KIND, lastVisibleSnapshot, snapshotTextOf } from '../src/snapshot-message.ts'
import { FileTable } from '../src/storage/file-table.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { cacheKey } from '../src/tools/scan.ts'
import { IN_SNAPSHOT_NOTE } from '../src/tools/search.ts'
import {
  memorySnapshotSchema, pendingDecisionSchema, scanCacheSchema, adviceIgnoreSchema,
  type MemorySnapshot, type PendingDecision, type ScanCacheEntry,
} from '../src/governance/schema.ts'
import { baselineProjectionDefinition } from '../src/governance/baseline.ts'
import { EVIDENCE_GUIDANCE } from '../src/evidence-guidance.ts'
import {
  GUI_CHECKUP_VIEW_FILE, GUI_VIEW_DIR, GUI_VIEW_FILES, GUI_WORKSPACE_MAP_FILE, deletedViewSchema, healthViewSchema, libraryViewSchema, pendingViewSchema, sessionViewFile, sessionViewSchema,
  workspaceMapViewSchema, type LibraryView, type PendingView,
} from '../src/gui/contract.ts'
import { PendingDecisionsStore } from '../src/governance/decisions.ts'
import { CheckupRecordStore } from '../src/governance/checkup-records.ts'
import { AutoCheckupSettingStore } from '../src/governance/auto-checkups.ts'
import { defaultJiebaLoader } from '../src/search/jieba-segmenter.ts'

// 进程边界的观察：fsTrace.on 期间记下插件对 node:fs、node:fs/promises 的每次调用（函数名 + 第一个参数）。平时原样透传。
const { fsTrace } = vi.hoisted(() => ({ fsTrace: { on: false, calls: [] as string[] } }))
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>()
  return Object.fromEntries(Object.entries(actual).map(([key, value]) => [key, typeof value === 'function' && /^[a-z]/.test(key)
    ? (...args: unknown[]) => { if (fsTrace.on) fsTrace.calls.push(`fs/promises.${key}(${String(args[0])})`); return (value as (...a: unknown[]) => unknown)(...args) }
    : value]))
})
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>()
  return Object.fromEntries(Object.entries(actual).map(([key, value]) => [key, typeof value === 'function' && /^[a-z]/.test(key)
    ? (...args: unknown[]) => { if (fsTrace.on) fsTrace.calls.push(`fs.${key}(${String(args[0])})`); return (value as (...a: unknown[]) => unknown)(...args) }
    : value]))
})

/** 宿主 storageDomain 表的替身（@deepseek-ai/dsh-storage-domain KvTable 的形状）：读同步、写异步。 */
class HostKvTable<T = unknown> {
  private map = new Map<string, T>()
  get(key: string) { return this.map.get(key) }
  entries() { return this.map.entries() }
  keys() { return this.map.keys() }
  async put(key: string, value: T) { this.map.set(key, value) }
  async delete(key: string) { return this.map.delete(key) }
}

/** 放一条全局记忆：语义检查只在层里有记忆时才调用模型。 */
async function seedMemory(memoryRoot: string): Promise<string> {
  await mkdir(join(memoryRoot, 'global'), { recursive: true })
  await writeFile(join(memoryRoot, 'global', 'seed.md'), encodeRecord(record({ id: 'mem_seed' }), {}), 'utf8')
  return memoryRoot
}

/** 本文件建出的全部替身 ctx 的卸载入口：afterEach 先卸载插件、等它的写入收尾，再删临时目录。 */
const liveCtxs: Array<() => Promise<void>> = []

/**
 * projections：ctx.get('sessionProjections') 给出的注册表（缺省 = 服务缺席）。inject 仿 cordis 的
 * ctx.inject(deps, cb)：依赖齐了才同步回调、把服务放进 child；registerProjection=false 模拟回调始终没触发。
 * 回调返回的 disposer 记下来，dispose() 仿插件卸载逆序逐个 await。
 */
function mockCtx(opts: {
  projections?: SessionProjectionRegistry; registerProjection?: boolean; storageDomain?: boolean; commands?: { register(def: unknown): () => void }
  /** 宿主计时服务（ctx.inject(['timer'], …) 的 child 上的 timeout / interval）；缺省服务缺席。 */
  timer?: { timeout(callback: () => void, delayMs: number): () => void; interval(callback: () => void, delayMs: number): () => void }
  /** 宿主默认模型选择（ctx.get('agentDefaultModel')）；缺省服务缺席。 */
  agentDefaultModel?: { currentSelection(): { provider: string; model: string } }
} = {}) {
  const registered: string[] = []
  const listeners = new Map<string, (...args: unknown[]) => unknown>()
  // ctx.on 的第三参数（cordis EventOptions，如 prepend）按事件名记下，没传的不记
  const listenerOptions = new Map<string, unknown>()
  // 假 llm：记下每次 stream 收到的请求对象；每次调用从 llmScript 取一段 chunk 序列，
  // 脚本用完回默认序列——语义扫描能解析的空结果，以 stop 收尾（宿主每条流都以 finish 结束）。
  const llmRequests: Array<{ messages: unknown[] }> = []
  const llmScript: StreamChunk[][] = []
  const llm = {
    async *stream(req: { messages: unknown[] }): AsyncIterable<StreamChunk> {
      llmRequests.push(req)
      yield* llmScript.shift() ?? [
        { type: 'text-delta', index: 0, text: '{"findings":[]}' },
        { type: 'finish', reason: { kind: 'stop' } },
      ]
    },
  }
  // 旧宿主 KV 域（opts.storageDomain=true 时经 ctx.get('storageDomain') 给出，缺省服务缺席）。
  // 按表名复用同一张表：用例可以在 apply() 前预置；domainOpens / domainCloses 计数证明域开没开、关没关。
  const tables = new Map<string, HostKvTable>()
  const domain = { opens: 0, closes: 0 }
  const storageDomain = {
    open: async () => {
      domain.opens++
      return {
        table: (name: string) => {
          let table = tables.get(name)
          if (!table) tables.set(name, table = new HostKvTable())
          return table
        },
        global: {}, name: 'plastic_memory', close: async () => { domain.closes++ },
      }
    },
  }
  const disposers: Array<() => unknown> = []
  const dispose = async () => { for (const d of disposers.splice(0).reverse()) await d() }
  liveCtxs.push(dispose)
  return {
    registered, listeners, listenerOptions, llmRequests, llmScript, tables, domain,
    tools: { register: (def: { name: string }) => { registered.push(def.name); return () => { registered.splice(registered.indexOf(def.name), 1) } } },
    on: (event: string, fn: (...args: unknown[]) => unknown, options?: unknown) => {
      listeners.set(event, fn)
      if (options !== undefined) listenerOptions.set(event, options)
      return () => {}
    },
    effect: (fn: () => unknown) => { fn() },
    // 按服务名分发：'llm' 给上面的假 llm，'sessionProjections' 给 opts.projections，'storageDomain'
    // 按 opts.storageDomain 给旧 KV 域；其余（如 resolveWorkspacePath 的 workspaceRegistry）一律
    // undefined，判为服务缺席——这里不模拟 cordis proxy 对未知服务名的抛错行为。
    get: (name: string) => (name === 'llm' ? llm
      : name === 'sessionProjections' ? opts.projections
        : name === 'storageDomain' && opts.storageDomain === true ? storageDomain
          : name === 'agentDefaultModel' ? opts.agentDefaultModel
            : undefined),
    // 按依赖名分发，像 cordis 一样只在依赖的服务都在时才回调
    inject: (deps: string[], callback: (child: Record<string, unknown>) => unknown) => {
      const collect = (dispose: unknown) => { if (typeof dispose === 'function') disposers.push(dispose as () => unknown) }
      if (deps.includes('sessionProjections') && opts.projections !== undefined && opts.registerProjection !== false) {
        collect(callback({ sessionProjections: opts.projections }))
      }
      if (deps.includes('commands') && opts.commands !== undefined) collect(callback({ commands: opts.commands }))
      if (deps.includes('timer') && opts.timer !== undefined) collect(callback({ timeout: opts.timer.timeout, interval: opts.timer.interval }))
      return () => {}
    },
    dispose,
  }
}

/**
 * 让 get() 像 cordis 的 Context proxy 一样，对任何服务名都抛错（真实 cordis 对未 inject 的
 * 服务名抛 "cannot get property ... without inject"）。用于证明 apply() 不受 ctx.get 抛错影响：
 * getLlm 现在按调用解析（Fix 2），apply() 期间不会同步碰 ctx.get('llm')，这个 stub 对每个名字
 * 都抛错，正好把"任何服务解析失败/抛错都不该拖垮插件加载"这条钉死，而不只是 llm 这一个名字。
 */
function mockCtxWithThrowingGet() {
  const ctx = mockCtx()
  return {
    ...ctx,
    get: (name: string) => { throw new Error(`no such service: ${name}`) },
  }
}

// 用户词典热生效的用例要真实 @node-rs/jieba（可选依赖没装上或平台二进制缺失时 skip）。
const hasRealJieba = await defaultJiebaLoader.importJieba().then(() => true, () => false)

// FileTable 是纯 fs 类，vitest 下用 mkdtemp 真实落盘跑；afterEach 统一清理，
// 避免任何用例（包括抛错用例）碰到缺省 memoryRoot 从而落到真实 ~/.dsh/memories。
const tmpDirs: string[] = []
async function makeTmpRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'plastic-memory-apply-'))
  tmpDirs.push(dir)
  return dir
}
afterEach(async () => {
  await Promise.all(liveCtxs.splice(0).map(dispose => dispose()))
  await Promise.all(tmpDirs.splice(0).map(d => rm(d, { recursive: true, force: true })))
})

/** 同一 memoryRoot 上的另一个侧表实例：用例经它预置或读回插件落在 .state/ 的数据（文件是唯一真相）。 */
function sidecarAt(memoryRoot: string) {
  return new SidecarStore({ root: memoryRoot, schemas: { snapshots: memorySnapshotSchema, pending: pendingDecisionSchema, scanCache: scanCacheSchema, adviceIgnores: adviceIgnoreSchema } })
}

describe('apply', () => {
  it('治理默认开启：注册九个工具', async () => {
    const ctx = mockCtx()
    const memoryRoot = await makeTmpRoot()
    await apply(ctx as never, new Config({ memoryRoot } as never))
    expect(ctx.registered.sort()).toEqual([
      'memory_confirm', 'memory_forget', 'memory_health', 'memory_promote',
      'memory_save', 'memory_scan', 'memory_search', 'memory_snapshot', 'memory_source',
    ])
  })

  it('governance.enabled=false 时只注册 P0 三工具 + memory_snapshot（快照写入/恢复必须成对）', async () => {
    // Config 的 governance 嵌套对象会自动取默认值 {enabled:true,onWrite:true}（已实测），
    // 显式传 false 才关闭治理工具。forget 仍持有快照能力这一点不由本测试断言——
    // 是 mockCtx 的 tools.register 只记 name 把 deps 丢了（defineTool 的 stub 本身是原样返回的）——
    // 该保证靠读 src/index.ts 里 forget 注册位于治理开关之上确认。
    // memory_snapshot 同样放在治理开关之外（Fix F）：治理关闭时 forget 仍会拍快照，
    // 没有恢复入口的话 14 天保留窗口的快照就是死存储。
    const ctx = mockCtx()
    const memoryRoot = await makeTmpRoot()
    const config = new Config({ memoryRoot, governance: { enabled: false, onWrite: false } } as never)
    await apply(ctx as never, config)
    expect(ctx.registered.sort()).toEqual(['memory_forget', 'memory_save', 'memory_search', 'memory_snapshot', 'memory_source'])
  })

  it('监听 session/created、session/event、loader/volatile-update（配置热生效）与 agent/pre-step、agent/request-error（快照的发送点）', async () => {
    const ctx = mockCtx()
    const memoryRoot = await makeTmpRoot()
    await apply(ctx as never, new Config({ memoryRoot } as never))
    expect([...ctx.listeners.keys()].sort()).toEqual([
      'agent/pre-step', 'agent/request-error', 'loader/volatile-update', 'session/created', 'session/event',
    ])
    // 两个监听都排在最外层：next() 返回时压缩已经做完；compaction-basic 恢复时返回 retry 不调 next()，里层看不到
    expect(ctx.listenerOptions.get('agent/pre-step')).toEqual({ prepend: true })
    expect(ctx.listenerOptions.get('agent/request-error')).toEqual({ prepend: true })
  })

  it('Fix 1 回归：ctx.get 对任意服务名抛错也不拖垮插件加载，九个工具照常注册', async () => {
    // 真实 cordis 的 Context 是 proxy：对未 inject 的服务名走属性访问会抛错，且不会退化为
    // undefined。mockCtx() 的 get() 对未知服务名返回 undefined，测不出这种抛错——这里用会抛错的
    // get() 逼近 cordis 行为，钉住"服务解析失败/抛错不能让 apply() 整体失败"这条回归。
    const ctx = mockCtxWithThrowingGet()
    const memoryRoot = await makeTmpRoot()
    await apply(ctx as never, new Config({ memoryRoot } as never))
    expect(ctx.registered.sort()).toEqual([
      'memory_confirm', 'memory_forget', 'memory_health', 'memory_promote',
      'memory_save', 'memory_scan', 'memory_search', 'memory_snapshot', 'memory_source',
    ])
  })

  it('接线集成：apply 注册后的 memory_search 能看见之后外部新写入的文件（每次调用直接读目录）', async () => {
    // 留住真实 ToolDefinition，经注册后的 execute 走一遍：apply 之后外部落盘的记忆必须能被检索到。
    type ToolDef = { name: string; execute(args: unknown, exec: unknown): Promise<unknown> }
    const defs = new Map<string, ToolDef>()
    const ctx = { ...mockCtx(), tools: { register: (def: ToolDef) => { defs.set(def.name, def); return () => {} } } }
    const memoryRoot = await makeTmpRoot()
    await apply(ctx as never, new Config({ memoryRoot } as never))
    await mkdir(join(memoryRoot, 'global'), { recursive: true })   // 加载期零 I/O：global/ 由首次写或外部建
    await writeFile(join(memoryRoot, 'global', 'external.md'),
      encodeRecord(record({ id: 'mem_ext', content: '外部落盘的记忆 zebra' }), {}), 'utf8')
    const out = await defs.get('memory_search')!.execute({ query: 'zebra' }, fakeExec()) as { hits: Array<{ id: string }> }
    expect(out.hits.map(h => h.id)).toEqual(['mem_ext'])
  })

  it('自定义类型与内置重名时加载即抛错', async () => {
    // profile 与内置类型同名，触发 buildTypeRegistry 的碰撞检查。
    // decayDays 用数字而非 null：Config 的 customTypes.decayDays 是 .required() 的 nullable
    // 联合，schemastery 会把传入的 null 当成"缺失必填值"拒绝（Task 1 schema 的既有行为）。
    const memoryRoot = await makeTmpRoot()
    const config = new Config({
      memoryRoot,
      customTypes: { profile: { label: 'x', description: 'x', whenToSave: 'x', recall: 'core', decayDays: 90, governancePriority: 'low' } },
    } as never)
    // 该用例在 buildTypeRegistry 阶段就抛错，FileTable 根本没构造——传 memoryRoot 只是
    // 确保就算未来实现顺序调整，也不会有路径意外落到默认值指向的真实 ~/.dsh/memories。
    await expect(apply(mockCtx() as never, config)).rejects.toThrow(TypeRegistryError)
  })

  it('磁盘上有坏 md（无 frontmatter）时 apply 仍正常完成且加载期零 I/O（插件加载不受记忆坏文件影响）', async () => {
    type ToolDef = { name: string; execute(args: unknown, exec: unknown): Promise<unknown> }
    const defs = new Map<string, ToolDef>()
    const ctx = { ...mockCtx(), tools: { register: (def: ToolDef) => { defs.set(def.name, def); return () => {} } } }
    const memoryRoot = await makeTmpRoot()
    await mkdir(join(memoryRoot, 'global'), { recursive: true })
    await writeFile(join(memoryRoot, 'global', 'broken.md'), '这是一段没有 frontmatter 的纯文本\n', 'utf8')
    await writeFile(join(memoryRoot, 'global', 'good.md'),
      encodeRecord(record({ id: 'mem_good', content: '坏文件旁边的好记忆 zebra' }), {}), 'utf8')
    await apply(ctx as never, new Config({ memoryRoot } as never))
    expect([...defs.keys()].sort()).toEqual([
      'memory_confirm', 'memory_forget', 'memory_health', 'memory_promote',
      'memory_save', 'memory_scan', 'memory_search', 'memory_snapshot', 'memory_source',
    ])
    // 加载期零 I/O：apply 不建索引、不建 .state/，目录里只有测试放的两个文件
    expect((await readdir(join(memoryRoot, 'global'))).sort()).toEqual(['broken.md', 'good.md'])
    expect(await readdir(memoryRoot)).toEqual(['global'])
    // 钉住 root 真的来自 config：经注册后的 memory_search 读到 config 指定目录里的好记忆，坏文件不碍事
    const out = await defs.get('memory_search')!.execute({ query: 'zebra' }, fakeExec()) as { hits: Array<{ id: string }> }
    expect(out.hits.map(h => h.id)).toEqual(['mem_good'])
  })

  it('加载期零磁盘 I/O：带齐 commands、计时、旧 KV 域时，apply 及其随后排进队列的工作都不读、不列、不写文件；第一次工具调用才碰磁盘', async () => {
    type ToolDef = { name: string; execute(args: unknown, exec: unknown): Promise<unknown> }
    const defs = new Map<string, ToolDef>()
    const base = mockCtx({
      storageDomain: true,
      commands: { register: () => () => {} },
      timer: { timeout: () => () => {}, interval: () => () => {} },
    })
    const ctx = { ...base, tools: { register: (def: ToolDef) => { defs.set(def.name, def); return () => {} } }, logger: { info() {}, warn() {}, error() {} } }
    const memoryRoot = await seedMemory(await makeTmpRoot())
    await mkdir(join(memoryRoot, STATE_DIR), { recursive: true })
    await writeFile(join(memoryRoot, STATE_DIR, RECALL_STATS_FILE), '{}', 'utf8')

    fsTrace.calls = []
    fsTrace.on = true
    try {
      await apply(ctx as never, new Config({ memoryRoot } as never))
      // apply 里不 await 就排出去的工作也算加载期：让微任务与一轮 I/O 回调跑完
      for (let i = 0; i < 3; i++) await new Promise<void>(resolve => { setImmediate(resolve) })
    } finally {
      fsTrace.on = false
    }
    expect(fsTrace.calls).toEqual([])

    // 观察本身是灵的：第一次工具调用就读到了记忆目录
    fsTrace.on = true
    try {
      await defs.get('memory_search')!.execute({ query: '内容' }, fakeExec())
    } finally {
      fsTrace.on = false
    }
    expect(fsTrace.calls.some(c => c.includes(memoryRoot))).toBe(true)
  })
})

/** 启动时那遍视图写入是旁路（不 await）：等四个全局视图都落盘，免得它和用例的后续写入、afterEach 的清理交错。 */
async function startupViews(memoryRoot: string): Promise<void> {
  await vi.waitFor(async () => {
    for (const file of Object.values(GUI_VIEW_FILES)) await stat(join(memoryRoot, GUI_VIEW_DIR, file))
  })
}

/** GUI 半侧的服务端接线：commands 服务在时注册 /memory 命令处理器，缺席时静默跳过；加载期都不碰磁盘。 */
describe('GUI 命令接线', () => {
  type CommandDef = { name: string; handler(inv: { rawInput: string; agent: unknown }): Promise<{ kind: string; text?: string }> }
  async function withCommands() {
    const memoryRoot = await makeTmpRoot()
    const defs: CommandDef[] = []
    const ctx = mockCtx({ commands: { register: (def) => { defs.push(def as CommandDef); return () => {} } } })
    await apply({ ...ctx, logger: { info() {}, warn() {}, error() {} } } as never, new Config({ memoryRoot } as never))
    ctx.listeners.get('session/created')!({ id: 'sess-x' })
    await startupViews(memoryRoot)
    // 借来的会话：没有 cwd（只有 global 可见），会话 id 来自 header
    const agent = { session: { header: { id: 'sess-x' }, seq: 1 } }
    const exec = async (line: string) => {
      const r = await defs[0]!.handler({ rawInput: line.slice('/memory'.length), agent })
      return { kind: r.kind, body: JSON.parse(r.text!) as Record<string, unknown> }
    }
    return { memoryRoot, defs, exec, ctx }
  }

  it('宿主有 commands：注册一条 memory 命令；第一个会话出现后不等调用就写一遍全局视图（首次打开记忆页要有内容）', async () => {
    const { memoryRoot, defs } = await withCommands()
    expect(defs.map(d => d.name)).toEqual(['memory'])
    expect(JSON.parse(await readFile(join(memoryRoot, GUI_VIEW_DIR, GUI_VIEW_FILES.pending), 'utf8'))).toMatchObject({ items: [] })
  })

  it('执行回调：info 返回配置的 memoryRoot 与该会话的视图路径', async () => {
    const { memoryRoot, exec } = await withCommands()
    const { kind, body } = await exec('/memory info')
    expect(kind).toBe('success')
    expect(body).toMatchObject({ ok: true, cmd: 'info', info: { memoryRoot, views: { session: join(memoryRoot, '.state', 'gui', 'session-sess-x.json') } } })
  })

  it('执行回调：refresh-views 写出视图文件；改记忆的子命令落盘后也重写视图', async () => {
    const { memoryRoot, exec } = await withCommands()
    expect((await exec('/memory refresh-views')).body).toEqual({ ok: true, cmd: 'refresh-views' })
    const pendingPath = join(memoryRoot, '.state', 'gui', 'pending.json')
    expect(JSON.parse(await readFile(pendingPath, 'utf8'))).toMatchObject({ items: [] })

    await mkdir(join(memoryRoot, 'global'), { recursive: true })
    await writeFile(join(memoryRoot, 'global', 'gone.md'), encodeRecord(record({ id: 'mem_gone', name: '要删的' }), {}), 'utf8')
    const forgot = await exec('/memory forget {"memoryId":"mem_gone"}')
    expect(forgot.body).toMatchObject({ ok: true, cmd: 'forget', memoryIds: ['mem_gone'] })
    const deleted = JSON.parse(await readFile(join(memoryRoot, '.state', 'gui', 'deleted.json'), 'utf8')) as { items: Array<{ memory: { id: string } }> }
    expect(deleted.items.map(i => i.memory.id)).toEqual(['mem_gone'])
  })

  describe('让模型改：经宿主 llm 服务', () => {
    // 会话带 provider/model（makeSemanticLlm 三层解析的第二层），模型才解析得到
    const routed = { session: { header: { id: 'sess-x' }, seq: 1, requestHeader: () => undefined }, options: { provider: 'deepseek', model: 'deepseek-v4-flash' } }
    async function withMemory() {
      const t = await withCommands()
      await mkdir(join(t.memoryRoot, 'global'), { recursive: true })
      const file = join(t.memoryRoot, 'global', 'long.md')
      await writeFile(file, encodeRecord(record({ id: 'mem_long', name: '发版流程', content: '先跑测试，再打包，再发版。', summary: '发版步骤' }), {}), 'utf8')
      const run = async (line: string, agent: unknown = routed) => {
        const r = await t.defs[0]!.handler({ rawInput: line.slice('/memory'.length), agent })
        return JSON.parse(r.text!) as Record<string, unknown>
      }
      return { ...t, file, run }
    }
    const DRAFT_LINE = '/memory draft-edit {"adviceType":"bloat","memories":[{"memoryId":"mem_long","layer":{"kind":"global"}}]}'

    it('model-info 回会话解析出的模型名；会话没有路由时 llm-unavailable，不猜默认模型', async () => {
      const t = await withMemory()
      expect(await t.run('/memory model-info')).toEqual({ ok: true, cmd: 'model-info', model: 'deepseek-v4-flash' })
      expect(await t.run('/memory model-info', { session: { header: { id: 'sess-x' }, seq: 1 } })).toMatchObject({ ok: false, code: 'llm-unavailable' })
      expect(t.ctx.llmRequests).toEqual([])
    })

    it('draft-edit 只发一次不进会话的请求（RequestUserInput：只有 role 与 content），只累加 text-delta；记忆文件不动', async () => {
      const t = await withMemory()
      const before = await readFile(t.file, 'utf8')
      t.ctx.llmScript.push([
        { type: 'reasoning-delta', index: 0, text: '先想想' },
        { type: 'text-delta', index: 1, text: '{"content":"测试、打包、发版。",' },
        { type: 'text-delta', index: 1, text: '"summary":"发版三步"}' },
        { type: 'finish', reason: { kind: 'stop' } },
      ] as StreamChunk[])
      expect(await t.run(DRAFT_LINE)).toEqual({ ok: true, cmd: 'draft-edit', draft: { content: '测试、打包、发版。', summary: '发版三步' }, model: 'deepseek-v4-flash' })
      expect(t.ctx.llmRequests).toHaveLength(1)
      const [request] = t.ctx.llmRequests
      expect(request).toMatchObject({ provider: 'deepseek', model: 'deepseek-v4-flash' })
      expect(request!.messages).toHaveLength(1)
      expect(Object.keys(request!.messages[0] as object).sort()).toEqual(['content', 'role'])
      expect(await readFile(t.file, 'utf8')).toBe(before)
    })

    it('流已吐出合法 JSON 却以 error 收尾：按失败返回（llm-failed），不重试', async () => {
      const t = await withMemory()
      t.ctx.llmScript.push([
        { type: 'text-delta', index: 0, text: '{"content":"短","summary":"短"}' },
        { type: 'finish', reason: { kind: 'error', failure: { code: 'STREAM_CLOSED', message: 'stream ended before message_stop' } } },
      ])
      expect(await t.run(DRAFT_LINE)).toMatchObject({ ok: false, code: 'llm-failed', detail: 'stream ended before message_stop' })
      expect(t.ctx.llmRequests).toHaveLength(1)
    })
  })

  it('会话归属对照：在会话里执行 /memory 命令时，记下原始 cwd → 服务端解析出的项目（软链接、子目录都按 realpath）', async () => {
    const { memoryRoot, defs } = await withCommands()
    const real = await makeTmpRoot()
    await mkdir(join(real, 'sub'))
    const link = join(await makeTmpRoot(), 'link')
    await symlink(real, link)
    const sub = join(link, 'sub')
    await defs[0]!.handler({ rawInput: ' info', agent: { session: { header: { id: 'sess-sub', cwd: sub }, seq: 1 } } })
    const file = join(memoryRoot, GUI_VIEW_DIR, GUI_WORKSPACE_MAP_FILE)
    await vi.waitFor(async () => {
      expect(workspaceMapViewSchema.parse(JSON.parse(await readFile(file, 'utf8'))).cwds).toEqual({ [sub]: await realpath(sub) })
    })
  })

  it('会话归属对照：session/created 预热解析时也记下', async () => {
    const memoryRoot = await makeTmpRoot()
    const ctx = mockCtx({ commands: { register: () => () => {} } })
    await apply({ ...ctx, logger: { info() {}, warn() {}, error() {} } } as never, new Config({ memoryRoot } as never))
    const real = await makeTmpRoot()
    const link = join(await makeTmpRoot(), 'link')
    await symlink(real, link)
    ctx.listeners.get('session/created')!({ header: { id: 'sess-link', cwd: link } })
    const file = join(memoryRoot, GUI_VIEW_DIR, GUI_WORKSPACE_MAP_FILE)
    await vi.waitFor(async () => {
      expect(workspaceMapViewSchema.parse(JSON.parse(await readFile(file, 'utf8'))).cwds).toEqual({ [link]: await realpath(real) })
    })
  })

  it('执行回调：未知子命令返回 error 与 invalid-args', async () => {
    const { exec } = await withCommands()
    const { kind, body } = await exec('/memory ping')
    expect(kind).toBe('error')
    expect(body).toMatchObject({ ok: false, code: 'invalid-args' })
  })

  it('插件卸载：等进行中的视图写入落完才算卸载完，之后不再有视图落盘', async () => {
    const memoryRoot = await makeTmpRoot()
    const ctx = mockCtx({ commands: { register: () => () => {} } })
    await apply({ ...ctx, logger: { info() {}, warn() {}, error() {} } } as never, new Config({ memoryRoot } as never))
    const guiFiles = async () => {
      const dir = join(memoryRoot, GUI_VIEW_DIR)
      const names = (await readdir(dir).catch(() => [] as string[])).sort()
      return Promise.all(names.map(async name => [name, await readFile(join(dir, name), 'utf8')]))
    }
    // 配置热生效触发的全量重写：让出一个微任务，它已开始收集（还没落盘），这时开始卸载
    const rewriting = ctx.listeners.get('loader/volatile-update')!([['governance', 'enabled']]) as Promise<void>
    await Promise.resolve()
    await ctx.dispose()
    const atDispose = await guiFiles()
    expect(atDispose.map(([name]) => name).sort()).toEqual([...Object.values(GUI_VIEW_FILES), GUI_CHECKUP_VIEW_FILE].sort())
    // 卸载后的事件不再写视图
    ctx.listeners.get('session/created')!({ header: { id: 'sess-late' } })
    await rewriting
    for (let i = 0; i < 3; i++) await new Promise<void>(resolve => setImmediate(resolve))
    expect(await guiFiles()).toEqual(atDispose)
  })

  it('卸载契约（真 cordis）：inject 回调返回的异步 disposer，重启（改配置）与删插件（热重载）都先 await 完它', async () => {
    const host = new Context()
    host.provide('commands' as never, {} as never)
    const order: string[] = []
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let applies = 0
    const probe = {
      name: 'probe',
      apply(p: Context) {
        const n = ++applies
        order.push(`apply ${n}`)
        p.inject(['commands' as never], () => async () => { order.push(`dispose ${n}`); await gate; order.push(`disposed ${n}`) })
      },
    }
    const fiber = await host.plugin(probe)
    const restarting = fiber.restart()
    for (let i = 0; i < 3; i++) await new Promise<void>(resolve => setImmediate(resolve))
    expect(order).toEqual(['apply 1', 'dispose 1'])
    release()
    await restarting
    expect(order).toEqual(['apply 1', 'dispose 1', 'disposed 1', 'apply 2'])
    // 热重载先删插件、await 旧 fiber 再装新实现：await 返回时 disposer 已跑完
    host.registry.delete(probe)
    await fiber.await()
    expect(order.slice(-2)).toEqual(['dispose 2', 'disposed 2'])
    await host.fiber.dispose()
  })

  it('宿主没有 commands（旧宿主）：apply 照常完成，不注册、不写 .state/', async () => {
    const memoryRoot = await makeTmpRoot()
    await apply(mockCtx() as never, new Config({ memoryRoot } as never))
    await expect(stat(join(memoryRoot, '.state'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

/**
 * 侧表落文件与旧 KV 导入（spec「侧表」、测试第 4 层）：storageDomain 退出必需注入，只在首次侧表访问时
 * 经 ctx.get 探测、惰性打开旧域导入 snapshots 与 pending；apply 期间 .state/ 不出现。
 */
/** 自动体检：宿主有计时服务时创建调度器；没有会话，用宿主默认模型；插件卸载时停。 */
describe('自动体检接线', () => {
  const DEFAULT_ROUTE = { provider: 'deepseek', model: 'deepseek-v4-pro' }
  function fakeTimer() {
    const timers: Array<{ delayMs: number; every: boolean; callback: () => void; isLive: boolean }> = []
    const add = (every: boolean) => (callback: () => void, delayMs: number) => {
      const t = { delayMs, every, callback, isLive: true }
      timers.push(t)
      return () => { t.isLive = false }
    }
    return { timers, timeout: add(false), interval: add(true) }
  }

  it('到期的范围在后台体检：不借会话，用宿主当前的默认模型，写自动体检的完成记录；卸载后定时器停掉', async () => {
    const memoryRoot = await seedMemory(await makeTmpRoot())
    const sidecar = sidecarAt(memoryRoot)
    await new AutoCheckupSettingStore(sidecar.autoCheckups).set({ kind: 'all' }, 1)
    const timer = fakeTimer()
    const ctx = mockCtx({ timer, agentDefaultModel: { currentSelection: () => DEFAULT_ROUTE } })
    await apply({ ...ctx, logger: { info() {}, warn() {}, error() {} } } as never, new Config({ memoryRoot } as never))
    // 启动后 3 分钟第一次检查
    const first = timer.timers.find(t => !t.every)!
    expect(first.delayMs).toBe(3 * 60_000)
    // 到点：一次性定时器触发后就不在了
    first.isLive = false
    first.callback()
    await vi.waitFor(async () => expect((await new CheckupRecordStore(sidecar.checkups).list()).map(r => r.completed?.by)).toEqual(['auto']))
    expect(ctx.llmRequests).toHaveLength(1)
    expect(ctx.llmRequests[0]).toMatchObject(DEFAULT_ROUTE)
    expect(ctx.llmRequests[0]).not.toHaveProperty('sessionId')
    // 完成记录由执行器写；之后还要重写视图、放掉认领，认领的心跳停了只剩每 10 分钟的检查
    await vi.waitFor(() => expect(timer.timers.filter(t => t.isLive).map(t => [t.delayMs, t.every])).toEqual([[10 * 60_000, true]]))
    await ctx.dispose()
    expect(timer.timers.filter(t => t.isLive)).toEqual([])
  })

  it('没有计时服务的宿主：不创建调度器，插件照常挂载', async () => {
    const memoryRoot = await seedMemory(await makeTmpRoot())
    await new AutoCheckupSettingStore(sidecarAt(memoryRoot).autoCheckups).set({ kind: 'all' }, 1)
    const ctx = mockCtx({ agentDefaultModel: { currentSelection: () => DEFAULT_ROUTE } })
    await apply(ctx as never, new Config({ memoryRoot } as never))
    expect(ctx.registered).toContain('memory_scan')
    expect(ctx.llmRequests).toEqual([])
  })

  it('有会话的手动体检照旧用借用会话的模型：会话解析不出模型时回 llm-unavailable，不改用默认模型', async () => {
    const memoryRoot = await seedMemory(await makeTmpRoot())
    const defs: Array<{ handler(inv: { rawInput: string; agent: unknown }): Promise<{ text?: string }> }> = []
    const ctx = mockCtx({
      commands: { register: (def) => { defs.push(def as (typeof defs)[number]); return () => {} } },
      agentDefaultModel: { currentSelection: () => DEFAULT_ROUTE },
    })
    await apply({ ...ctx, logger: { info() {}, warn() {}, error() {} } } as never, new Config({ memoryRoot } as never))
    const scan = async (agent: unknown) => JSON.parse((await defs[0]!.handler({ rawInput: ' scan {"layer":{"kind":"global"}}', agent })).text!) as Record<string, unknown>
    expect(await scan({ session: { header: { id: 'sess-x' }, seq: 1 } })).toMatchObject({ ok: false, code: 'llm-unavailable' })
    expect(ctx.llmRequests).toEqual([])
    const routed = { session: { header: { id: 'sess-x' }, seq: 1, requestHeader: () => undefined }, options: { provider: 'deepseek', model: 'deepseek-v4-flash' } }
    expect(await scan(routed)).toMatchObject({ ok: true, cmd: 'scan' })
    expect(ctx.llmRequests[0]).toMatchObject({ provider: 'deepseek', model: 'deepseek-v4-flash' })
  })
})

describe('侧表与旧 KV 导入接线', () => {
  type ToolDef = { name: string; execute(args: unknown, exec: unknown): Promise<unknown> }
  function withTools(base: ReturnType<typeof mockCtx>) {
    const defs = new Map<string, ToolDef>()
    const ctx = {
      ...base,
      tools: { register: (def: ToolDef) => { defs.set(def.name, def); return () => {} } },
      logger: { info() {}, warn() {}, error() {} },
    }
    return { ctx, defs }
  }
  // 含一条 global 记忆：list 只列含可见记录的快照
  const snap = (id: string): MemorySnapshot => {
    const r = record({ id: `mem_${id}` })
    return { id, createdAt: Date.now(), operation: 'manual', description: id, memoryIds: [r.id], data: [r] }
  }
  const pd = (id: string): PendingDecision => ({ id, memoryIds: ['mem_a', 'mem_b'], summary: id, firstSeenAt: 1 })
  async function readMarker(memoryRoot: string) {
    return kvImportMarkerSchema.parse(JSON.parse(await readFile(join(memoryRoot, STATE_DIR, KV_IMPORT_MARKER), 'utf8')))
  }

  it('注册列表只要求 tools：不要求 storageDomain，快照走自己的消息、不要求 systemPrompt', () => {
    expect(inject).toEqual(['tools'])
  })

  it('加载期零侧表 I/O：apply 返回时 .state/ 不存在，旧域没被打开（即使已有记忆文件）', async () => {
    const memoryRoot = await makeTmpRoot()
    await mkdir(join(memoryRoot, 'global'), { recursive: true })
    await writeFile(join(memoryRoot, 'global', 'a.md'), encodeRecord(record({ id: 'mem_a' }), {}), 'utf8')
    const base = mockCtx({ storageDomain: true })
    await apply(withTools(base).ctx as never, new Config({ memoryRoot } as never))
    await expect(stat(join(memoryRoot, STATE_DIR))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(base.domain.opens).toBe(0)
  })

  it('有 storageDomain：首次侧表访问时导入 snapshots 与 pending（不导 recall_stats / scan_cache），写 kv 标记、删掉旧行并关域', async () => {
    const memoryRoot = await makeTmpRoot()
    const base = mockCtx({ storageDomain: true })
    const kv = (name: string) => { const t = new HostKvTable(); base.tables.set(name, t); return t }
    await kv('snapshots').put('snap_old', snap('snap_old'))
    await kv('pending_decisions').put('pd_old', pd('pd_old'))
    await kv('recall_stats').put('mem_a', { id: 'mem_a', recallCount: 3, lastRecalledAt: 1 })
    await kv('scan_cache').put('cache_all', { id: 'cache_all', scannedAt: 1, scope: 'all', findings: [] })
    const { ctx, defs } = withTools(base)
    await apply(ctx as never, new Config({ memoryRoot } as never))

    const out = await defs.get('memory_snapshot')!.execute({ action: 'list' }, fakeExec()) as { snapshots: Array<{ id: string }> }
    expect(out.snapshots.map(s => s.id)).toEqual(['snap_old'])
    const state = join(memoryRoot, STATE_DIR)
    expect(await readdir(join(state, 'snapshots'))).toEqual(['snap_old.json'])
    expect(await readdir(join(state, 'pending'))).toEqual(['pd_old.json'])
    await expect(stat(join(state, 'scan-cache'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(join(state, RECALL_STATS_FILE))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readMarker(memoryRoot)).toMatchObject({ version: 1, source: 'kv', counts: { snapshots: 1, pending: 1 } })
    // 读一次、删一次，各自开关域
    expect(base.domain).toEqual({ opens: 2, closes: 2 })
    // 导入的两张表清空，不再留副本；另两张表不碰
    expect([...base.tables.get('snapshots')!.keys()]).toEqual([])
    expect([...base.tables.get('pending_decisions')!.keys()]).toEqual([])
    expect([...base.tables.get('recall_stats')!.keys()]).toEqual(['mem_a'])
    expect([...base.tables.get('scan_cache')!.keys()]).toEqual(['cache_all'])
  })

  it('标记已存在：不再打开旧域', async () => {
    const memoryRoot = await makeTmpRoot()
    await sidecarAt(memoryRoot).snapshots.list() // 无旧 KV 的实例先写下 none 标记
    const base = mockCtx({ storageDomain: true })
    base.tables.set('snapshots', new HostKvTable())
    await base.tables.get('snapshots')!.put('snap_old', snap('snap_old'))
    const { ctx, defs } = withTools(base)
    await apply(ctx as never, new Config({ memoryRoot } as never))
    const out = await defs.get('memory_snapshot')!.execute({ action: 'list' }, fakeExec()) as { snapshots: unknown[] }
    expect(out.snapshots).toEqual([])
    expect(base.domain.opens).toBe(0)
  })

  it('storageDomain 缺席：照常挂载九个工具，侧表照常可用；不写标记、本进程只探测一次（服务可能只是暂时没挂上，下次启动再探）', async () => {
    const memoryRoot = await makeTmpRoot()
    const base = mockCtx()
    let probes = 0
    const get = base.get
    const { ctx, defs } = withTools({ ...base, get: (name: string) => { if (name === 'storageDomain') probes++; return get(name) } })
    await apply(ctx as never, new Config({ memoryRoot } as never))
    expect([...defs.keys()].sort()).toEqual([
      'memory_confirm', 'memory_forget', 'memory_health', 'memory_promote',
      'memory_save', 'memory_scan', 'memory_search', 'memory_snapshot', 'memory_source',
    ])
    await defs.get('memory_snapshot')!.execute({ action: 'create' }, fakeExec())
    await defs.get('memory_snapshot')!.execute({ action: 'list' }, fakeExec())
    expect(probes).toBe(1)
    await expect(stat(join(memoryRoot, STATE_DIR, KV_IMPORT_MARKER))).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await sidecarAt(memoryRoot).snapshots.list())).toHaveLength(1)
  })

  it('storageDomain 在但两张表都空：写 source: none 的标记，只开关一次域', async () => {
    const memoryRoot = await makeTmpRoot()
    const base = mockCtx({ storageDomain: true })
    const { ctx, defs } = withTools(base)
    await apply(ctx as never, new Config({ memoryRoot } as never))
    await defs.get('memory_snapshot')!.execute({ action: 'list' }, fakeExec())
    expect(await readMarker(memoryRoot)).toMatchObject({ source: 'none', counts: { snapshots: 0, pending: 0 } })
    expect(base.domain).toEqual({ opens: 1, closes: 1 })
  })

  it('memory_search 命中只写 .state/recall-stats.json', async () => {
    const memoryRoot = await makeTmpRoot()
    await mkdir(join(memoryRoot, 'global'), { recursive: true })
    await writeFile(join(memoryRoot, 'global', 'a.md'), encodeRecord(record({ id: 'mem_a', content: '斑马 zebra' }), {}), 'utf8')
    const { ctx, defs } = withTools(mockCtx())
    await apply(ctx as never, new Config({ memoryRoot } as never))
    await defs.get('memory_search')!.execute({ query: 'zebra' }, fakeExec())
    expect(await sidecarAt(memoryRoot).recallStats.get('mem_a')).toMatchObject({ recallCount: 1 })
  })
})

/** 宿主真 Session（脱离 store）：header 按宿主格式补齐；seed 给出时是带着这段历史的会话（fork、重启后续上）。 */
function hostSession(id: string, header: Partial<Pick<SessionHeader, 'cwd' | 'delegationDepth' | 'parentSession'>> = {}, seed: readonly SessionEvent[] = []) {
  return Session.create(id as SessionId, seed, {
    version: SESSION_FORMAT_VERSION, id: id as SessionId, createdAt: 0, isSeeded: seed.length > 0, ...header,
  }, seed.length as never) // 下界宿主是 number、新宿主是带品牌的偏移量，两边都收
}

const userSaid = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })

/** 会话可见历史里本插件的快照文本，按出现顺序。 */
const visibleSnapshots = (session: Session) =>
  session.deriveMessages().map(snapshotTextOf).filter((text): text is string => text !== undefined)

/**
 * 注入链（spec「快照改走插件自己的消息」）：快照是本插件自己的一条 user 消息，发送点只有 agent/pre-step 与
 * agent/request-error 两个监听，发不发只看会话可见历史里最后一份快照。测试台按宿主回合循环的顺序走一步：
 * pre-step（next 里先做里层监听的事，如压缩）→ 第一步没有消息时宿主直接收尾 → 否则先写系统提示词、再按序写入 decision 的消息。
 */
describe('注入链接线', () => {
  type ToolDef = { name: string; execute(args: unknown, exec: unknown): Promise<unknown> }
  type Decision = { kind: 'enter'; messages: UserMessage[]; startsRequestSeries?: true } | { kind: 'reject' }

  async function boot(opts: { memories?: Array<Parameters<typeof record>[0]>; memoryRoot?: string; get?: (name: string) => unknown } = {}) {
    const defs = new Map<string, ToolDef>()
    const errors: unknown[][] = []
    const base = mockCtx({ commands: { register: () => () => {} } })
    const ctx = {
      ...base,
      ...(opts.get === undefined ? {} : { get: opts.get }),
      tools: { register: (def: ToolDef) => { defs.set(def.name, def); return () => {} } },
      logger: { info() {}, warn() {}, error: (...args: unknown[]) => { errors.push(args) } },
    }
    const memoryRoot = opts.memoryRoot ?? await makeTmpRoot()
    await mkdir(join(memoryRoot, 'global'), { recursive: true })
    for (const m of opts.memories ?? [{ id: 'mem_old', type: 'preference', content: '压缩前就有的偏好' }]) {
      await writeFile(join(memoryRoot, 'global', `${m!.id}.md`), encodeRecord(record(m), {}), 'utf8')
    }
    await apply(ctx as never, new Config({ memoryRoot } as never))
    const preStep = ctx.listeners.get('agent/pre-step')!
    const requestError = ctx.listeners.get('agent/request-error')!
    const onEvent = ctx.listeners.get('session/event')!

    /** 宿主走一步：pre-step 的 next 先做 inner（里层监听，如压缩）再交出 decision；返回 pre-step 的结果。 */
    const step = async (session: Session, n: number, o: { messages?: UserMessage[]; decision?: Decision; inner?: () => void; signal?: AbortSignal; turn?: number } = {}) => {
      const messages = o.messages ?? []
      const proposed: Decision = o.decision ?? { kind: 'enter', messages }
      const signal = o.signal ?? new AbortController().signal
      const turn = o.turn ?? 1
      const decision = await preStep({ agent: { session }, messages, turn, step: n, signal }, async () => { o.inner?.(); return proposed }) as Decision
      if (decision.kind !== 'enter' || signal.aborted || (n === 1 && decision.messages.length === 0)) return decision
      if (session.surface.nodes.length === 0) {
        session.append('system/message', { turn, step: n, message: createSystemMessage('系统提示词') }, { surfaceOp: 'append' })
      }
      for (const m of decision.messages) session.append('user/message', m, { surfaceOp: 'append' })
      return decision
    }
    /** 一次请求失败：里层监听先做 inner（如压缩）再交出 action。 */
    const failRequest = (session: Session, action: { kind: 'retry' } | undefined, o: { inner?: () => void; signal?: AbortSignal } = {}) =>
      requestError({
        agent: { session }, turn: 1, step: 2, provider: 'deepseek', failure: { code: 'CONTEXT_WINDOW_EXCEEDED', message: 'overflow' },
        retryPolicy: undefined, signal: o.signal ?? new AbortController().signal,
      }, async () => { o.inner?.(); return action })
    /**
     * 宿主压缩，顺序同压缩插件：summary、带 replace 的 checkpoint 遮蔽系统提示词之后的全部节点、compaction/end。
     * 失败的压缩什么都不遮蔽，只有带 error 的 compaction/end。
     */
    const compact = (session: Session, o: { error?: string; time?: number } = {}) => {
      const time = o.time ?? Date.now()
      if (o.error !== undefined) {
        onEvent(session, { type: 'compaction/end', time, data: { compactionId: 'cmp', turn: 1, error: o.error } })
        return
      }
      const shadowed = session.surface.nodes.slice(1)
      // compaction 事件的类型由压缩插件增广，不在本插件的类型图里，按最小结构写入
      const appendCompaction = (type: string, data: unknown) =>
        (session.append as unknown as (type: string, data: unknown) => { seq: (typeof shadowed)[number] }).call(session, type, data)
      const start = appendCompaction('compaction/start', { compactionId: 'cmp', turn: 1 })
      const summary = appendCompaction('compaction/summary', {
        compactionId: 'cmp', summary: '压缩摘要', shadowedRange: { start: shadowed[0], end: shadowed.at(-1) }, shadowedSeqs: shadowed,
      })
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: '<compacted-summary>压缩摘要</compacted-summary>' }], source: { kind: 'compaction' } as never,
      }), { surfaceOp: { op: 'replace', startSeq: shadowed[0]!, endSeq: shadowed.at(-1)! }, sourceEventSeqs: [start.seq, summary.seq, ...shadowed] })
      onEvent(session, { type: 'compaction/end', time, data: { compactionId: 'cmp', turn: 1 } })
    }
    /** 外部落一条新记忆，经工具入口刷新进内存（注入路径本身不刷新）。 */
    const addMemory = async () => {
      await writeFile(join(memoryRoot, 'global', 'new.md'),
        encodeRecord(record({ id: 'mem_new', type: 'preference', content: '压缩后新增的偏好 zebra' }), {}), 'utf8')
      await defs.get('memory_search')!.execute({ query: 'zebra' }, fakeExec())
    }
    const search = async (session: Session, query: string) =>
      (await defs.get('memory_search')!.execute({ query }, fakeExec({ agent: { session } as unknown as ToolRunContext['agent'] }))) as { hits: Array<{ id: string; content: string }> }
    const recallStats = () => readFile(join(memoryRoot, STATE_DIR, RECALL_STATS_FILE), 'utf8').catch(() => '')
    const sessionView = (sessionId: string) => vi.waitFor(async () =>
      sessionViewSchema.parse(JSON.parse(await readFile(join(memoryRoot, GUI_VIEW_DIR, sessionViewFile(sessionId)), 'utf8'))))
    const listens = (name: string) => ctx.listeners.has(name)
    return { memoryRoot, errors, preStep, step, failRequest, compact, addMemory, search, recallStats, sessionView, listens }
  }

  it('新会话第一步：快照放在 decision 最前返回，pre-step 里不直接写会话；宿主先写系统提示词再写 decision，快照落在系统提示词之后', async () => {
    const t = await boot()
    const session = hostSession('sess-1')
    const hello = userSaid('你好')
    const decision = await t.preStep({ agent: { session }, messages: [hello], turn: 1, step: 1, signal: new AbortController().signal },
      async () => ({ kind: 'enter', messages: [hello] })) as Extract<Decision, { kind: 'enter' }>
    expect(decision.messages.map(m => m.source.kind)).toEqual([SNAPSHOT_SOURCE_KIND, 'user'])
    expect(decision.messages[1]).toBe(hello)
    expect(session.surface.nodes).toEqual([])

    // 按宿主 step() 的顺序写入：系统提示词仍是 node 0
    session.append('system/message', { turn: 1, step: 1, message: createSystemMessage('系统提示词') }, { surfaceOp: 'append' })
    for (const m of decision.messages) session.append('user/message', m, { surfaceOp: 'append' })
    expect(session.deriveMessages().map(m => [m.role, m.source.kind])).toEqual([['system', 'system-prompt'], ['user', SNAPSHOT_SOURCE_KIND], ['user', 'user']])
    expect(visibleSnapshots(session)).toEqual([expect.stringContaining('压缩前就有的偏好')])
  })

  it('第一步 decision 没有消息（宿主不调模型、直接收尾）：decision 原样返回，不写会话', async () => {
    const t = await boot()
    const session = hostSession('sess-1')
    const empty: Decision = { kind: 'enter', messages: [] }
    expect(await t.step(session, 1, { decision: empty })).toBe(empty)
    expect(session.surface.nodes).toEqual([])
  })

  it('之后的步 decision 没有消息、可见历史里没有快照（升级后续上的老会话）：直接追加一份，decision 原样返回', async () => {
    const t = await boot()
    const session = hostSession('sess-1')
    session.append('system/message', { turn: 1, step: 1, message: createSystemMessage('系统提示词') }, { surfaceOp: 'append' })
    session.append('user/message', userSaid('你好'), { surfaceOp: 'append' })
    const empty: Decision = { kind: 'enter', messages: [] }
    expect(await t.step(session, 2, { decision: empty })).toBe(empty)
    expect(session.deriveMessages().map(m => m.source.kind)).toEqual(['system-prompt', 'user', SNAPSHOT_SOURCE_KIND])
  })

  it('可见历史里已有同文本快照：轮中的步、溢出重试、下一轮第一步都不再发，decision 与 action 原样返回', async () => {
    const t = await boot()
    const session = hostSession('sess-1')
    await t.step(session, 1, { messages: [userSaid('你好')] })
    const empty: Decision = { kind: 'enter', messages: [] }
    expect(await t.step(session, 2, { decision: empty })).toBe(empty)
    expect(await t.step(session, 3, { decision: empty })).toBe(empty)
    const retry = { kind: 'retry' } as const
    expect(await t.failRequest(session, retry)).toBe(retry)
    const nextTurn: Decision = { kind: 'enter', messages: [userSaid('继续')] }
    expect(await t.step(session, 1, { decision: nextTurn, turn: 2 })).toBe(nextTurn)
    expect(visibleSnapshots(session)).toHaveLength(1)
  })

  it('pre-step 不吞 decision：reject 原样返回；带 startsRequestSeries 的 decision 原样返回（快照照常判断）', async () => {
    const t = await boot()
    const session = hostSession('sess-1')
    await t.step(session, 1, { messages: [userSaid('你好')] })
    const reject: Decision = { kind: 'reject' }
    expect(await t.step(session, 2, { decision: reject })).toBe(reject)
    const series: Decision = { kind: 'enter', messages: [], startsRequestSeries: true }
    expect(await t.step(session, 2, { decision: series })).toBe(series)
    expect(visibleSnapshots(session)).toHaveLength(1)
  })

  it('轮中自动压缩：next 里遮蔽了快照，返回后同一步补发一份最新的，排在 checkpoint 之后', async () => {
    const t = await boot()
    const session = hostSession('sess-1')
    await t.step(session, 1, { messages: [userSaid('你好')] })
    await t.addMemory()
    const empty: Decision = { kind: 'enter', messages: [] }
    expect(await t.step(session, 2, { decision: empty, inner: () => t.compact(session) })).toBe(empty)
    expect(session.deriveMessages().map(m => m.source.kind)).toEqual(['system-prompt', 'compaction', SNAPSHOT_SOURCE_KIND])
    expect(visibleSnapshots(session)).toEqual([expect.stringContaining('压缩后新增的偏好 zebra')])
  })

  it('轮首自动压缩：decision 带用户消息时补发的快照放进 decision 最前，落在 checkpoint 之后、用户消息之前', async () => {
    const t = await boot()
    const session = hostSession('sess-1')
    await t.step(session, 1, { messages: [userSaid('你好')] })
    await t.addMemory()
    await t.step(session, 1, { messages: [userSaid('继续')], turn: 2, inner: () => t.compact(session) })
    expect(session.deriveMessages().map(m => m.source.kind)).toEqual(['system-prompt', 'compaction', SNAPSHOT_SOURCE_KIND, 'user'])
    expect(visibleSnapshots(session)).toEqual([expect.stringContaining('压缩后新增的偏好 zebra')])
  })

  it('失败的压缩（compaction/end 带 error，什么都没遮蔽）：不发，可见的仍是原来那份', async () => {
    const t = await boot()
    const session = hostSession('sess-1')
    await t.step(session, 1, { messages: [userSaid('你好')] })
    const [before] = visibleSnapshots(session)
    await t.addMemory()
    await t.step(session, 2, { inner: () => t.compact(session, { error: 'summary is not smaller than the shadowed content' }) })
    expect(visibleSnapshots(session)).toEqual([before])
  })

  it('溢出恢复：request-error 的 next 压缩后返回 retry，直接追加一份最新的，action 原样返回', async () => {
    const t = await boot()
    const session = hostSession('sess-1')
    await t.step(session, 1, { messages: [userSaid('你好')] })
    await t.addMemory()
    const retry = { kind: 'retry' } as const
    expect(await t.failRequest(session, retry, { inner: () => t.compact(session) })).toBe(retry)
    expect(session.deriveMessages().map(m => m.source.kind)).toEqual(['system-prompt', 'compaction', SNAPSHOT_SOURCE_KIND])
    expect(visibleSnapshots(session)).toEqual([expect.stringContaining('压缩后新增的偏好 zebra')])
  })

  it('request-error 不重试或已中止：不发，返回值原样透传', async () => {
    const t = await boot()
    const session = hostSession('sess-1')
    await t.step(session, 1, { messages: [userSaid('你好')] })
    expect(await t.failRequest(session, undefined, { inner: () => t.compact(session) })).toBeUndefined()
    expect(visibleSnapshots(session)).toEqual([])
    const controller = new AbortController()
    controller.abort()
    const retry = { kind: 'retry' } as const
    expect(await t.failRequest(session, retry, { signal: controller.signal })).toBe(retry)
    expect(visibleSnapshots(session)).toEqual([])
  })

  it('pre-step 的 signal 已中止：decision 原样返回，不发', async () => {
    const t = await boot()
    const session = hostSession('sess-1')
    const controller = new AbortController()
    controller.abort()
    const hello: Decision = { kind: 'enter', messages: [userSaid('你好')] }
    expect(await t.step(session, 1, { decision: hello, signal: controller.signal })).toBe(hello)
  })

  /** 一个已经写过系统提示词和用户消息、可见历史里还没有快照的会话：之后的空 decision 会直接追加快照。 */
  const sessionWithoutSnapshot = () => {
    const session = hostSession('sess-1')
    session.append('system/message', { turn: 1, step: 1, message: createSystemMessage('系统提示词') }, { surfaceOp: 'append' })
    session.append('user/message', userSaid('你好'), { surfaceOp: 'append' })
    return session
  }

  it('pre-step 的 signal 已中止、本来会直接追加快照的那一步：不组装、不写会话、不计召回，decision 原样返回；之后没中止的步照常发', async () => {
    const t = await boot()
    const session = sessionWithoutSnapshot()
    const nodesBefore = [...session.surface.nodes]
    const statsBefore = await t.recallStats()
    const controller = new AbortController()
    controller.abort()
    const empty: Decision = { kind: 'enter', messages: [] }
    const readLayer = vi.spyOn(MemoryStore.prototype, 'readLayer')
    try {
      // 直接调监听：测试台的 step 遇到中止会自己提前返回，看不出插件做没做
      expect(await t.preStep({ agent: { session }, messages: [], turn: 1, step: 2, signal: controller.signal }, async () => empty)).toBe(empty)
      expect(readLayer).not.toHaveBeenCalled()
    } finally {
      readLayer.mockRestore()
    }
    expect(session.surface.nodes).toEqual(nodesBefore)
    expect(await t.recallStats()).toBe(statsBefore)

    await t.step(session, 3, { decision: empty })
    expect(visibleSnapshots(session)).toEqual([expect.stringContaining('压缩前就有的偏好')])
  })

  it('pre-step 拿到 reject：可见历史里没有快照、本来该发的时候也不发，不组装，reject 原样返回', async () => {
    const t = await boot()
    const session = sessionWithoutSnapshot()
    const reject: Decision = { kind: 'reject' }
    const readLayer = vi.spyOn(MemoryStore.prototype, 'readLayer')
    try {
      expect(await t.step(session, 2, { decision: reject })).toBe(reject)
      expect(readLayer).not.toHaveBeenCalled()
    } finally {
      readLayer.mockRestore()
    }
    expect(visibleSnapshots(session)).toEqual([])
  })

  it('组装失败：这一步不发、只记日志；下一个发送点恢复后发', async () => {
    const t = await boot()
    const session = hostSession('sess-1')
    const spy = vi.spyOn(MemoryStore.prototype, 'readLayer').mockRejectedValueOnce(new Error('disk gone'))
    try {
      const hello: Decision = { kind: 'enter', messages: [userSaid('你好')] }
      expect(await t.step(session, 1, { decision: hello })).toBe(hello)
      expect(t.errors).toHaveLength(1)
      expect(visibleSnapshots(session)).toEqual([])
      await t.step(session, 2)
      expect(visibleSnapshots(session)).toEqual([expect.stringContaining('压缩前就有的偏好')])
    } finally {
      spy.mockRestore()
    }
  })

  // 解析超时放行要等满组装的超时（1.5 秒），两步约 3 秒
  it('工作区解析超时：两步拿到同一份临时文本只发一次；解析落定后冻结的完整版不同，再发一次', async () => {
    const memoryRoot = await makeTmpRoot()
    const cwd = await makeTmpRoot() // resolveWorkspacePath 走 realpath，cwd 须真实存在
    const workspacePath = await realpath(cwd)
    const wsDir = join(memoryRoot, workspaceDirName(workspacePath))
    await mkdir(wsDir, { recursive: true })
    await writeFile(join(wsDir, WORKSPACE_MARKER), workspacePath, 'utf8')
    const now = Date.now()
    await writeFile(join(wsDir, 'local.md'), encodeRecord(record({
      id: 'mem_local', type: 'preference', scope: 'workspace', workspacePath, content: '仅本仓库生效的偏好',
      createdAt: now, updatedAt: now, lastConfirmedAt: now,
    }), {}), 'utf8')
    let settle!: () => void
    const gate = new Promise<void>(resolve => { settle = resolve })
    const workspaceRegistry = { resolveByPath: async () => { await gate; return { path: workspacePath } } }
    const t = await boot({ memoryRoot, get: name => (name === 'workspaceRegistry' ? workspaceRegistry : undefined) })
    const session = hostSession('sess-1', { cwd })

    await t.step(session, 1, { messages: [userSaid('你好')] })
    await t.step(session, 2)
    expect(visibleSnapshots(session)).toEqual([expect.not.stringContaining('仅本仓库生效的偏好')])

    settle()
    await t.step(session, 3)
    const [provisional, full] = visibleSnapshots(session)
    expect(provisional).toContain('压缩前就有的偏好')
    expect(full).toContain('仅本仓库生效的偏好')
    expect(visibleSnapshots(session)).toHaveLength(2)
  }, 10_000)

  it('记忆里的 {{ 原样出现在快照消息里（自有消息不过宿主的变量插值）', async () => {
    const t = await boot({ memories: [{ id: 'mem_vue', type: 'preference', content: 'Vue 模板写 {{ msg }}，CI 里写 ${{ secrets.NPM_TOKEN }}' }] })
    const session = hostSession('sess-1')
    const decision = await t.step(session, 1, { messages: [userSaid('你好')] }) as Extract<Decision, { kind: 'enter' }>
    const block = decision.messages[0]!.content[0] as { type: 'text'; text: string }
    expect(block.text).toContain('Vue 模板写 {{ msg }}，CI 里写 ${{ secrets.NPM_TOKEN }}')
    expect(visibleSnapshots(session)[0]).toContain('Vue 模板写 {{ msg }}')
  })

  it('子 agent 与 fork：各会话按自己的可见历史判断；fork 出的会话继承了同文本快照，不重发', async () => {
    const t = await boot()
    const parent = hostSession('sess-1')
    await t.step(parent, 1, { messages: [userSaid('你好')] })
    const child = hostSession('sess-sub', { delegationDepth: 1 })
    await t.step(child, 1, { messages: [userSaid('子任务')] })
    expect(visibleSnapshots(child)).toHaveLength(1)
    expect(visibleSnapshots(parent)).toHaveLength(1)

    const fork = hostSession('sess-fork', { parentSession: 'sess-1' as SessionId }, parent.snapshotEvents())
    const again: Decision = { kind: 'enter', messages: [userSaid('换个说法')] }
    expect(await t.step(fork, 1, { decision: again, turn: 2 })).toBe(again)
    expect(visibleSnapshots(fork)).toHaveLength(1)
  })

  it('冻结只发生在发送点：第一步空 decision 不冻结、不计召回，检索照常给全文；发出之后计召回一次，检索换成说明', async () => {
    const t = await boot({ memories: [{ id: 'mem_core', type: 'preference', content: '测试里不要 mock 数据库' }] })
    const session = hostSession('sess-1')
    await t.step(session, 1)
    expect(await t.recallStats()).not.toContain('mem_core')
    expect((await t.search(session, '数据库')).hits[0]!.content).toBe('测试里不要 mock 数据库')

    await t.step(session, 1, { messages: [userSaid('你好')] })
    expect(JSON.parse(await t.recallStats())).toMatchObject({ mem_core: { recallCount: 1 } })
    expect((await t.search(session, '数据库')).hits[0]!.content).toBe(IN_SNAPSHOT_NOTE)
  })

  it('宿主压掉运行时上下文（极简模式、会话中途关掉）不影响快照：不挂组装；压缩后照常补发、冻结，检索新记忆换成说明', async () => {
    const t = await boot({ memories: [{ id: 'mem_core', type: 'preference', content: '测试里不要 mock 数据库' }] })
    expect(t.listens('system-prompt/assemble')).toBe(false)
    const session = hostSession('sess-1')
    await t.step(session, 1, { messages: [userSaid('你好')] })
    await t.addMemory()
    await t.step(session, 2, { inner: () => t.compact(session) })
    expect(visibleSnapshots(session)).toEqual([expect.stringContaining('压缩后新增的偏好 zebra')])
    expect((await t.search(session, 'zebra')).hits[0]!.content).toBe(IN_SNAPSHOT_NOTE)
    await vi.waitFor(async () => expect(await t.sessionView('sess-1')).toMatchObject({ origin: 'compacted' }))
  })

  it('快照来历：首次发送是对话开始时；成功压缩后补发是压缩后、带压缩时刻；失败的压缩不改', async () => {
    const t = await boot()
    const session = hostSession('sess-1')
    await t.step(session, 1, { messages: [userSaid('你好')] })
    await vi.waitFor(async () => expect(await t.sessionView('sess-1')).toMatchObject({ origin: 'start' }))
    await t.step(session, 2, { inner: () => t.compact(session, { error: 'summarizer failed', time: 4_000 }) })
    expect((await t.sessionView('sess-1')).compactedAt).toBeUndefined()
    await t.step(session, 3, { inner: () => t.compact(session, { time: 5_000 }) })
    await vi.waitFor(async () => expect(await t.sessionView('sess-1')).toMatchObject({ origin: 'compacted', compactedAt: 5_000 }))
  })

  it('快照来历读 turnBoundary 投影：本实例首次冻结时会话已过第 1 轮记为重新带入，即使可见历史里已有同文本快照、这次没发', async () => {
    const first = await boot()
    const session = hostSession('sess-1')
    await first.step(session, 1, { messages: [userSaid('你好')] })

    // 插件重载（新实例、同一记忆目录），续上同一段历史，已到第 3 轮
    const projections = { stateOf: (_s: object, key: string) => (key === 'turnBoundary' ? { openTurnStartSeq: 1, lastTurn: 3 } : undefined) }
    const second = await boot({ memoryRoot: first.memoryRoot, get: name => (name === 'sessionProjections' ? projections : undefined) })
    const resumed = hostSession('sess-1', {}, session.snapshotEvents())
    const next: Decision = { kind: 'enter', messages: [userSaid('继续')] }
    expect(await second.step(resumed, 1, { decision: next, turn: 3 })).toBe(next)
    await vi.waitFor(async () => expect(await second.sessionView('sess-1')).toMatchObject({ origin: 'resumed' }))
  })

  it('投影读不到（服务缺席或读取抛错）按对话开始时', async () => {
    const t = await boot({ get: () => { throw new Error('no such service') } })
    const session = hostSession('sess-none')
    await t.step(session, 1, { messages: [userSaid('你好')] })
    await vi.waitFor(async () => expect(await t.sessionView('sess-none')).toMatchObject({ origin: 'start' }))
  })

  it('快照消息写进会话失败：只记日志，decision 原样返回；下一个发送点再发', async () => {
    const t = await boot()
    const session = hostSession('sess-1')
    session.append('system/message', { turn: 1, step: 1, message: createSystemMessage('系统提示词') }, { surfaceOp: 'append' })
    const spy = vi.spyOn(session, 'append').mockImplementationOnce(() => { throw new Error('log closed') })
    const empty: Decision = { kind: 'enter', messages: [] }
    expect(await t.step(session, 2, { decision: empty })).toBe(empty)
    expect(t.errors).toHaveLength(1)
    spy.mockRestore()
    await t.step(session, 3)
    expect(visibleSnapshots(session)).toHaveLength(1)
  })
})

/**
 * 语义扫描发给宿主 llm 的请求形状：只发一次、不进会话的辅助请求用宿主的 RequestUserInput
 * （只有 role + content，没有 id/source）。exec 里的假 agent 带 options.provider/model，
 * makeSemanticLlm 走三层解析的第二层拿到路由，才会真的调 stream。
 */
describe('语义扫描请求形状', () => {
  it('memory_scan 语义层发出的 messages[0] 是 RequestUserInput：只有 role 与 content', async () => {
    type ToolDef = { name: string; execute(args: unknown, exec: unknown): Promise<unknown> }
    const defs = new Map<string, ToolDef>()
    const base = mockCtx()
    const ctx = {
      ...base,
      tools: { register: (def: ToolDef) => { defs.set(def.name, def); return () => {} } },
      logger: { info() {}, warn() {}, error() {} },
    }
    const memoryRoot = await seedMemory(await makeTmpRoot())
    await apply(ctx as never, new Config({ memoryRoot } as never))
    const cwd = await makeTmpRoot()
    const session = { header: { id: 'sess-1', cwd }, seq: 0, requestHeader: () => undefined }
    const exec = fakeExec({
      agent: { session, options: { provider: 'deepseek', model: 'deepseek-chat' } } as unknown as ToolRunContext['agent'],
    })
    await defs.get('memory_scan')!.execute({ layers: 'semantic' }, exec)

    expect(base.llmRequests).toHaveLength(1)
    const [request] = base.llmRequests
    expect(request).toMatchObject({ provider: 'deepseek', model: 'deepseek-chat' })
    const msg = request!.messages[0]
    expect(msg).toEqual({ role: 'user', content: [{ type: 'text', text: expect.stringContaining('id=mem_seed') }] })
    expect(msg).not.toHaveProperty('id')
    expect(msg).not.toHaveProperty('source')
  })

  it('流已吐出可解析 JSON 后以 error 收尾：按失败处理（重试一次后 semantic-failed），语义缓存保持原样', async () => {
    type ToolDef = { name: string; execute(args: unknown, exec: unknown): Promise<unknown> }
    const defs = new Map<string, ToolDef>()
    const base = mockCtx()
    const ctx = {
      ...base,
      tools: { register: (def: ToolDef) => { defs.set(def.name, def); return () => {} } },
      logger: { info() {}, warn() {}, error() {} },
    }
    const memoryRoot = await seedMemory(await makeTmpRoot())
    const cwd = await makeTmpRoot()
    const bucket = cacheKey(await realpath(cwd)) // 无 workspaceRegistry 时规范化 cwd 即目录桶
    const prior: ScanCacheEntry = {
      id: bucket, scannedAt: 1, scope: await realpath(cwd),
      findings: [{
        type: 'conflict', layer: 'semantic', severity: 'critical', memoryIds: ['mem_a', 'mem_b'],
        summary: '先前缓存的冲突', suggestedAction: '裁决',
      }],
    }
    const cache = sidecarAt(memoryRoot).scanCache
    await cache.put(bucket, prior)
    // 首次与重试都是：先吐完整 JSON，再以 error 终止（DeepSeek 适配器在 message_stop 前断流）
    const brokenStream = (): StreamChunk[] => [
      { type: 'text-delta', index: 0, text: '{"findings":[]}' },
      { type: 'finish', reason: { kind: 'error', failure: { code: 'STREAM_CLOSED', message: 'stream ended before message_stop' } } },
    ]
    base.llmScript.push(brokenStream(), brokenStream())

    await apply(ctx as never, new Config({ memoryRoot } as never))
    const session = { header: { id: 'sess-1', cwd }, seq: 0, requestHeader: () => undefined }
    const exec = fakeExec({
      agent: { session, options: { provider: 'deepseek', model: 'deepseek-chat' } } as unknown as ToolRunContext['agent'],
    })
    const out = await defs.get('memory_scan')!.execute({ layers: 'semantic' }, exec) as { notes?: Array<{ code: string }> }

    expect(base.llmRequests).toHaveLength(2)
    expect(out.notes?.map(n => n.code)).toContain('semantic-failed')
    expect(await cache.get(bucket)).toEqual(prior)
  })

  it('流以 aborted 收尾而 signal 未触发：按取消拒绝（AbortError、不重试），不当成功', async () => {
    type ToolDef = { name: string; execute(args: unknown, exec: unknown): Promise<unknown> }
    const defs = new Map<string, ToolDef>()
    const base = mockCtx()
    const ctx = {
      ...base,
      tools: { register: (def: ToolDef) => { defs.set(def.name, def); return () => {} } },
      logger: { info() {}, warn() {}, error() {} },
    }
    base.llmScript.push([
      { type: 'text-delta', index: 0, text: '{"findings":[]}' },
      { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'request aborted' } } },
    ])
    const memoryRoot = await seedMemory(await makeTmpRoot())
    await apply(ctx as never, new Config({ memoryRoot } as never))
    const cwd = await makeTmpRoot()
    const session = { header: { id: 'sess-1', cwd }, seq: 0, requestHeader: () => undefined }
    const exec = fakeExec({
      agent: { session, options: { provider: 'deepseek', model: 'deepseek-chat' } } as unknown as ToolRunContext['agent'],
    })
    await expect(defs.get('memory_scan')!.execute({ layers: 'semantic' }, exec)).rejects.toMatchObject({ name: 'AbortError' })
    expect(base.llmRequests).toHaveLength(1)
    expect(await sidecarAt(memoryRoot).scanCache.get(cacheKey(await realpath(cwd)))).toBeUndefined()
  })

  it('用量取每条流最后一个 usage 块，宿主在出错收尾前报了用量的也计入；一次都没报时结果不带用量', async () => {
    type ToolDef = { name: string; execute(args: unknown, exec: unknown): Promise<unknown> }
    const defs = new Map<string, ToolDef>()
    const base = mockCtx()
    const ctx = {
      ...base,
      tools: { register: (def: ToolDef) => { defs.set(def.name, def); return () => {} } },
      logger: { info() {}, warn() {}, error() {} },
    }
    base.llmScript.push(
      // 首次：报了用量后断流（error），进重试
      [
        { type: 'text-delta', index: 0, text: '{"findings":[]}' },
        { type: 'usage', usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 3000 } },
        { type: 'finish', reason: { kind: 'error', failure: { code: 'STREAM_CLOSED', message: 'closed' } } },
      ],
      // 重试：两个 usage 块，以最后一个为准
      [
        { type: 'text-delta', index: 0, text: '{"findings":[]}' },
        { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
        { type: 'usage', usage: { inputTokens: 1000, outputTokens: 300, totalTokens: 2600 } },
        { type: 'finish', reason: { kind: 'stop' } },
      ],
    )
    const memoryRoot = await seedMemory(await makeTmpRoot())
    await apply(ctx as never, new Config({ memoryRoot } as never))
    const cwd = await makeTmpRoot()
    const session = { header: { id: 'sess-1', cwd }, seq: 0, requestHeader: () => undefined }
    const exec = fakeExec({
      agent: { session, options: { provider: 'deepseek', model: 'deepseek-chat' } } as unknown as ToolRunContext['agent'],
    })
    const metered = await defs.get('memory_scan')!.execute({ layers: 'semantic' }, exec) as { usageTokens?: number }
    expect(base.llmRequests).toHaveLength(2)
    expect(metered.usageTokens).toBe(4200 + 2600)

    // 脚本用完回默认流：没有 usage 块
    const silent = await defs.get('memory_scan')!.execute({ layers: 'semantic' }, exec)
    expect(silent).not.toHaveProperty('usageTokens')
  })
})

/**
 * 证据锚（这条记忆出自会话的哪段事件）在宿主 0.1.5 上的读法：起点来自 agent-loop 注册的 turnBoundary
 * 投影（openTurnStartSeq = 当轮 turn/start 的 seq），终点是 session.seq - 1。投影是宿主
 * 按事件增量折叠的状态，插件按调用经 ctx.get('sessionProjections') 探测，缺席一律退回整会话锚。
 * 这里用 apply 注册后的真 ToolDefinition 走一遍 memory_save，只看落到记录上的 eventRange。
 */
describe('证据锚：读 turnBoundary 投影', () => {
  type SaveOut = { kind: string; record?: { source: { eventRange: [number, number] } } }
  type ToolDef = { name: string; execute(args: unknown, exec: unknown): Promise<unknown> }
  const SAVE_ARGS = { action: 'create', name: 'anchor', summary: '锚', content: '证据锚探针', type: 'knowledge', scope: 'workspace', sourceMode: 'user-explicit', tags: [] }

  /** 起一个带 sessionProjections 桩的 ctx，并留住注册后的工具定义。 */
  async function boot(projections: { stateOf: (session: object, key: string) => unknown } | undefined) {
    const defs = new Map<string, ToolDef>()
    const warnings: string[] = []
    const base = mockCtx()
    const ctx = {
      ...base,
      tools: { register: (def: ToolDef) => { defs.set(def.name, def); return () => {} } },
      get: (name: string) => (name === 'sessionProjections' ? projections : undefined),
      logger: { info() {}, warn: (msg: string) => { warnings.push(msg) }, error() {} },
    }
    const memoryRoot = await makeTmpRoot()
    await apply(ctx as never, new Config({ memoryRoot } as never))
    const cwd = await makeTmpRoot() // 会话 cwd 必须真实存在（resolveWorkspacePath 走 realpath）
    const session = (seq: number) => ({ header: { id: 'sess-1', cwd }, seq, requestHeader: () => undefined })
    const save = async (s: ReturnType<typeof session>, name = 'anchor'): Promise<[number, number]> => {
      const exec = fakeExec({ agent: { session: s, options: {} } as unknown as ToolRunContext['agent'] })
      const out = await defs.get('memory_save')!.execute({ ...SAVE_ARGS, name, force: true }, exec) as SaveOut
      expect(out.kind).toBe('saved')
      return out.record!.source.eventRange
    }
    return { session, save, warnings }
  }
  const projectionWith = (state: Partial<TurnBoundaryProjection> | undefined) => ({
    stateOf: (_session: object, key: string) => (key === 'turnBoundary' ? state : undefined),
  })

  it('投影给出 openTurnStartSeq 时，eventRange = [openTurnStartSeq, seq - 1]，不打 warn', async () => {
    const { session, save, warnings } = await boot(projectionWith({ openTurnStartSeq: 3 as TurnBoundaryProjection['openTurnStartSeq'] }))
    expect(await save(session(7))).toEqual([3, 6])
    expect(warnings).toEqual([])
  })

  it('sessionProjections 服务缺席 → 退回整会话锚 [0, seq - 1]，warn 说明原因', async () => {
    const { session, save, warnings } = await boot(undefined)
    expect(await save(session(7))).toEqual([0, 6])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('sess-1')
    expect(warnings[0]).toContain('service is absent')
  })

  it('stateOf 对 turnBoundary 返回 undefined（投影未注册）→ [0, seq - 1]，warn 说明原因', async () => {
    const { session, save, warnings } = await boot(projectionWith(undefined))
    expect(await save(session(7))).toEqual([0, 6])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('not registered')
  })

  it('openTurnStartSeq 为 null（工具执行时却没有开着的轮）→ [0, seq - 1]，warn 说明原因', async () => {
    const { session, save, warnings } = await boot(projectionWith({ openTurnStartSeq: null }))
    expect(await save(session(7))).toEqual([0, 6])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('no open turn')
  })

  it('投影对象缺少 openTurnStartSeq 字段（宿主形状变化）→ [0, seq - 1]，warn 而不是静默', async () => {
    const { session, save, warnings } = await boot(projectionWith({}))
    expect(await save(session(7))).toEqual([0, 6])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('undefined')
  })

  it('stateOf 抛错（宿主行为变化）→ 退回 [0, seq - 1]，warn 带上错误', async () => {
    const { session, save, warnings } = await boot({ stateOf: () => { throw new Error('projection exploded') } })
    expect(await save(session(7))).toEqual([0, 6])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('projection exploded')
  })

  it('同一 session 反复退化只 warn 一次，不同 session 各自 warn', async () => {
    const { session, save, warnings } = await boot(undefined)
    const first = session(7)
    await save(first, 'anchor-1')
    await save(first, 'anchor-2')
    expect(warnings).toHaveLength(1)
    await save(session(9), 'anchor-3')
    expect(warnings).toHaveLength(2)
  })

  it('空日志（seq = 0）→ [0, 0]', async () => {
    const { session, save } = await boot(projectionWith({ openTurnStartSeq: null }))
    expect(await save(session(0))).toEqual([0, 0])
  })
})

/**
 * AGENTS.md 基线来自插件注册到宿主的 plasticMemoryBaseline 投影。这里用真的 SessionProjectionRegistry
 * （挂在裸 cordis Context 上），会话给结构化对象：registry 首次触碰时对 snapshotEvents() 全量补折。
 */
describe('AGENTS.md 基线：读 plasticMemoryBaseline 投影', () => {
  type ToolDef = { name: string; execute(args: unknown, exec: unknown): Promise<unknown> }
  type ScanOut = { notes?: Array<{ code: string }> }

  async function hostRegistry(): Promise<SessionProjectionRegistry> {
    const host = new Context()
    await host.plugin(Registry)
    return host.sessionProjections
  }

  /** 宿主 agent-instructions 的完整基线消息（source 形状照 AgentInstructionSource）。 */
  function baselineMessage(seq: number, text: string): SessionEvent {
    const source: MessageSourceMap['agent-instructions'] = {
      kind: 'agent-instructions', form: 'instructions', baseline: true,
      changes: [{ action: 'set', scope: '.', path: 'AGENTS.md' }],
    }
    return { type: 'user/message', seq, time: 0, data: { id: `instr-${seq}`, role: 'user', content: [{ type: 'text', text }], source } } as unknown as SessionEvent
  }

  let sessionCount = 0
  function fakeSession(cwd: string, events: SessionEvent[]) {
    return {
      header: { id: `sess-${++sessionCount}`, cwd },
      inheritedEventCount: 0,
      get seq() { return events.length },
      snapshotEvents: () => events,
      eventAt: (seq: number) => events[seq],
      requestHeader: () => undefined,
    }
  }

  async function boot(base: ReturnType<typeof mockCtx>, overrides: { get?: (name: string) => unknown } = {}) {
    const defs = new Map<string, ToolDef>()
    const ctx = {
      ...base,
      ...overrides,
      tools: { register: (def: ToolDef) => { defs.set(def.name, def); return () => {} } },
      logger: { info() {}, warn: (msg: string) => { warnings.push(msg) }, error() {} },
    }
    const warnings: string[] = []
    await apply(ctx as never, new Config({ memoryRoot: await seedMemory(await makeTmpRoot()) } as never))
    const scan = async (session: object, args: object) => await defs.get('memory_scan')!.execute(args, fakeExec({
      agent: { session, options: { provider: 'deepseek', model: 'deepseek-chat' } } as unknown as ToolRunContext['agent'],
    })) as ScanOut
    return { scan, warnings }
  }
  /** prompt 里的基线段（记忆列表之前的部分）。 */
  const promptUser = (request: { messages: unknown[] } | undefined) =>
    baselinePart((request?.messages[0] as { content: Array<{ text: string }> }).content[0]!.text)
  const baselinePart = (user: string) => user.split('\n\n## 记忆列表')[0]!
  const expectedBaseline = (baseline: string[]) => baselinePart(buildSemanticPrompt([], baseline).user)

  it('apply() 注册 plasticMemoryBaseline：checkpoint 读回键、ver 与折叠出的正文', async () => {
    const projections = await hostRegistry()
    await boot(mockCtx({ projections }))
    const session = fakeSession(await makeTmpRoot(), [baselineMessage(0, '# AGENTS.md\n用 pnpm')])
    const row = projections.checkpoint(session as never).plasticMemoryBaseline
    expect(row?.ver).toBe(baselineProjectionDefinition.stateVersion)
    expect(row?.val).toMatchObject({ entries: [{ text: '# AGENTS.md\n用 pnpm' }] })
  })

  it('注册归属随父插件（真 cordis）：父插件经 inject 注册，dispose 后键随之卸载，stateOf 返回 undefined', async () => {
    const host = new Context()
    await host.plugin(Registry)
    let child: unknown
    const parent = await host.plugin({
      name: 'parent',
      apply(p: Context) { child = p.inject(['sessionProjections'], c => void c.sessionProjections.register(baselineProjectionDefinition)) },
    })
    await child
    const session = fakeSession(await makeTmpRoot(), [baselineMessage(0, '# AGENTS.md\n用 pnpm')])
    expect(host.sessionProjections.stateOf(session as never, 'plasticMemoryBaseline')?.entries).toEqual([{ text: '# AGENTS.md\n用 pnpm', scopes: ['.'] }])
    const row = host.sessionProjections.checkpoint(session as never).plasticMemoryBaseline
    expect(row?.ver).toBe(baselineProjectionDefinition.stateVersion)
    expect(baselineProjectionDefinition.stateSchema.safeParse(row?.val).success).toBe(true)
    await parent.dispose()
    expect(host.sessionProjections.stateOf(session as never, 'plasticMemoryBaseline')).toBeUndefined()
    await host.fiber.dispose()
  })

  it('日志里早有完整基线、之后才注册：首次语义扫描的 prompt 就带基线正文（宿主晚注册补折）', async () => {
    const projections = await hostRegistry()
    const session = fakeSession(await makeTmpRoot(), [baselineMessage(0, '# AGENTS.md\n不要 mock 数据库')])
    const base = mockCtx({ projections })
    const { scan } = await boot(base)
    const out = await scan(session, { layers: 'semantic' })
    expect(base.llmRequests).toHaveLength(1)
    expect(promptUser(base.llmRequests[0])).toBe(expectedBaseline(['# AGENTS.md\n不要 mock 数据库']))
    expect(out.notes?.map(n => n.code) ?? []).not.toContain('baseline-missing')
  })

  it('两个 session 的基线互不串台', async () => {
    const projections = await hostRegistry()
    const base = mockCtx({ projections })
    const { scan } = await boot(base)
    const a = fakeSession(await makeTmpRoot(), [baselineMessage(0, '项目甲：用 pnpm')])
    const b = fakeSession(await makeTmpRoot(), [baselineMessage(0, '项目乙：用 npm')])
    await scan(a, { layers: 'semantic' })
    await scan(b, { layers: 'semantic' })
    await scan(a, { layers: 'semantic' })
    expect(base.llmRequests.map(promptUser)).toEqual([
      expectedBaseline(['项目甲：用 pnpm']),
      expectedBaseline(['项目乙：用 npm']),
      expectedBaseline(['项目甲：用 pnpm']),
    ])
  })

  it('sessionProjections 服务缺席（ctx.get 返回 undefined，cordis 的真实形状）：体检扫描带 baseline-missing，不告警', async () => {
    const { scan, warnings } = await boot(mockCtx())
    const out = await scan(fakeSession(await makeTmpRoot(), [baselineMessage(0, '有基线但没有投影服务')]), { scope: 'all' })
    expect(out.notes?.map(n => n.code)).toContain('baseline-missing')
    expect(warnings.filter(w => /baseline/i.test(w))).toEqual([])
  })

  it('sessionProjections 服务缺席（ctx.get 抛错）：体检扫描带 baseline-missing，不抛', async () => {
    const base = mockCtx()
    const { scan } = await boot(base, {
      get: name => {
        if (name === 'sessionProjections') throw new Error(`no such service: ${name}`)
        return base.get(name)
      },
    })
    const out = await scan(fakeSession(await makeTmpRoot(), [baselineMessage(0, '有基线但读不到')]), { scope: 'all' })
    expect(out.notes?.map(n => n.code)).toContain('baseline-missing')
  })

  it('注册表在、但插件的投影没注册上（stateOf 返回 undefined）：体检扫描带 baseline-missing，不抛', async () => {
    const projections = await hostRegistry()
    const { scan } = await boot(mockCtx({ projections, registerProjection: false }))
    const session = fakeSession(await makeTmpRoot(), [baselineMessage(0, '有基线但键未注册')])
    const out = await scan(session, { scope: 'all' })
    expect(projections.checkpoint(session as never)).not.toHaveProperty('plasticMemoryBaseline')
    expect(out.notes?.map(n => n.code)).toContain('baseline-missing')
  })

  it('日志里有形状漂移的指令消息：首次扫描 warn 一次，同一 session 再扫不重复', async () => {
    const projections = await hostRegistry()
    const { scan, warnings } = await boot(mockCtx({ projections }))
    const broken = baselineMessage(0, '缺 changes 的基线')
    delete (broken.data as { source: { changes?: unknown } }).source.changes
    const session = fakeSession(await makeTmpRoot(), [broken])
    const out = await scan(session, { scope: 'all' })
    expect(out.notes?.map(n => n.code) ?? []).not.toContain('baseline-missing')
    await scan(session, { scope: 'all' })
    const drift = warnings.filter(w => w.includes('agent-instructions message'))
    expect(drift).toEqual(['agent-instructions message at seq 0 carries no changes array; keeping its text without scope tracking'])
  })

  it('stateOf 读取抛错（会话日志读不出）：体检扫描带 baseline-missing、不抛，同一 session 只 warn 一次', async () => {
    const projections = await hostRegistry()
    const { scan, warnings } = await boot(mockCtx({ projections }))
    const session = {
      ...fakeSession(await makeTmpRoot(), []),
      snapshotEvents: () => { throw new Error('log unreadable') },
    }
    const first = await scan(session, { scope: 'all' })
    const second = await scan(session, { scope: 'all' })
    expect(first.notes?.map(n => n.code)).toContain('baseline-missing')
    expect(second.notes?.map(n => n.code)).toContain('baseline-missing')
    const baselineWarnings = warnings.filter(w => w.includes('plasticMemoryBaseline'))
    expect(baselineWarnings).toHaveLength(1)
    expect(baselineWarnings[0]).toContain(session.header.id)
    expect(baselineWarnings[0]).toContain('log unreadable')
  })
})

/**
 * 配置热生效：宿主 Loader 只把 volatile 字段的新值写进运行中的引用、再向本插件发一次 loader/volatile-update
 * （载荷是变化路径的键数组），不重挂插件。这里用 commitVolatile 当 Loader 的替身，其余全走 apply 注册出来的真实接线。
 */
describe('配置热生效（loader/volatile-update）', () => {
  type ToolDef = { name: string; description: string; parameters: { properties: Record<string, { enum?: string[] }> }; execute(args: unknown, exec: unknown): Promise<unknown> }
  type CommandDef = { name: string; handler(inv: { rawInput: string; agent: unknown }): Promise<{ kind: string; text?: string }> }
  const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')
  const GOVERNANCE_TOOLS = ['memory_confirm', 'memory_health', 'memory_promote', 'memory_scan']
  const regulation = { label: '合规要求', description: '行业法规', whenToSave: '出现合规要求时', recall: 'core', decayDays: null, governancePriority: 'high' }

  /** Loader 替身：按 schema 校验候选配置，值变了的 volatile 引用写入新值，返回变化路径（等值不报）。 */
  function commitVolatile(config: Config, raw: object): string[][] {
    const next = new Config(raw as never)
    const paths: string[][] = []
    const visit = (current: unknown, candidate: unknown, path: string[]) => {
      if (typeof current !== 'object' || current === null) return
      if (VOLATILE_WRITE in current) {
        const ref = current as unknown as { get(): unknown; [VOLATILE_WRITE](v: unknown): void }
        const value = (candidate as { get(): unknown }).get()
        if (JSON.stringify(ref.get()) === JSON.stringify(value)) return
        ref[VOLATILE_WRITE](value)
        paths.push(path)
        return
      }
      for (const [key, child] of Object.entries(current)) visit(child, (candidate as Record<string, unknown>)[key], [...path, key])
    }
    visit(config, next, [])
    return paths
  }

  async function setup(raw: object = {}) {
    const memoryRoot = await makeTmpRoot()
    const workDir = await realpath(await makeTmpRoot())
    const defs = new Map<string, ToolDef>()
    const commands: CommandDef[] = []
    const base = mockCtx({ commands: { register: def => { commands.push(def as CommandDef); return () => {} } } })
    const ctx = {
      ...base,
      logger: { info() {}, warn() {}, error() {} },
      // 同名重复注册在宿主里直接抛错：重注册必须先注销
      tools: {
        register: (def: ToolDef) => {
          if (defs.has(def.name)) throw new Error(`tool "${def.name}" already registered`)
          defs.set(def.name, def)
          return () => { defs.delete(def.name) }
        },
      },
    }
    const config = new Config({ memoryRoot, ...raw } as never)
    await apply(ctx as never, config)
    const session = hostSession('sess-hot', { cwd: workDir })
    session.append('system/message', { turn: 1, step: 1, message: createSystemMessage('系统提示词') }, { surfaceOp: 'append' })
    ctx.listeners.get('session/created')!(session)
    await startupViews(memoryRoot)

    /** 走一个轮中的发送点（decision 没有消息、直接追加），返回模型此后看到的快照文本。 */
    const assembleOnce = async () => {
      const payload = { agent: { session }, messages: [], turn: 1, step: 2, signal: new AbortController().signal }
      await ctx.listeners.get('agent/pre-step')!(payload, async () => ({ kind: 'enter', messages: [] }))
      return lastVisibleSnapshot(session.deriveMessages())
    }
    /** 改配置并发事件；监听器返回的 promise（含视图重写）等它跑完。 */
    const update = async (next: object) => {
      const paths = commitVolatile(config, { memoryRoot, ...next })
      await ctx.listeners.get('loader/volatile-update')!(paths)
      return paths
    }
    const tool = (name: string) => defs.get(name)!
    const exec = fakeExec({ agent: { session, options: {} } } as never)
    const save = (args: object) => tool('memory_save').execute(
      { action: 'create', scope: 'workspace', summary: '摘要', sourceMode: 'user-explicit', ...args }, exec) as Promise<{ kind: string; code?: string; record?: { id: string } }>
    const command = async (line: string) => {
      const r = await commands[0]!.handler({ rawInput: line.slice('/memory'.length), agent: { session } })
      return { kind: r.kind, body: JSON.parse(r.text!) as Record<string, unknown> }
    }
    const sessionViewPath = join(memoryRoot, GUI_VIEW_DIR, sessionViewFile('sess-hot'))
    /** 会话视图是旁路写入：等它满足条件。 */
    const sessionView = (check: (v: ReturnType<typeof sessionViewSchema.parse>) => void) =>
      vi.waitFor(async () => {
        const v = sessionViewSchema.parse(JSON.parse(await readFile(sessionViewPath, 'utf8')))
        check(v)
        return v
      })
    const putGlobal = async (r: Parameters<typeof record>[0]) => {
      await mkdir(join(memoryRoot, 'global'), { recursive: true })
      await writeFile(join(memoryRoot, 'global', `${r!.id}.md`), encodeRecord(record(r), {}), 'utf8')
    }
    /** 宿主压缩结束（成功不带 error，失败带 error）。 */
    const endCompaction = (time: number, error?: string) => ctx.listeners.get('session/event')!(session,
      { type: 'compaction/end', time, data: { compactionId: 'cmp_1', turn: 1, ...(error === undefined ? {} : { error }) } })
    /** 会话里一共发过几份快照消息（含已被后来那份取代的）。 */
    const snapshotCount = () => session.deriveMessages().filter(m => m.source.kind === SNAPSHOT_SOURCE_KIND).length
    return { memoryRoot, defs, config, assembleOnce, snapshotCount, update, tool, exec, save, command, sessionView, putGlobal, endCompaction }
  }

  it('改上限、超限处理、溯源档位后，同一会话下一次组装就按新值（不等压缩）', async () => {
    const t = await setup()
    await t.putGlobal({ id: 'mem_k', type: 'knowledge', name: '报销截止', content: '报销截止每月 25 日', summary: '报销截止日' })
    const first = await t.assembleOnce()
    expect(first).toContain(EVIDENCE_GUIDANCE.strict)
    expect(first).toContain('mem_k')
    await t.sessionView(v => expect(v).toMatchObject({ budget: 4000, overflowMode: 'relax', injectedIds: ['mem_k'], omittedCount: 0 }))
    expect(await t.assembleOnce()).toBe(first) // 没改配置：冻结快照不动

    const paths = await t.update({ snapshotTokenBudget: 1.5, snapshotOverflow: 'strict', evidenceLookup: 'active' })
    expect(paths).toEqual([['snapshotTokenBudget'], ['snapshotOverflow'], ['evidenceLookup']])
    const second = await t.assembleOnce()
    expect(second).toContain(EVIDENCE_GUIDANCE.active)
    expect(second).not.toContain(EVIDENCE_GUIDANCE.strict)
    expect(second).not.toContain('- [mem_k]') // 严格按 1.5 token 的上限：这条装不下
    // 上限是 number（配置就是 number），会话视图原样带出
    await t.sessionView(v => expect(v).toMatchObject({ budget: 1.5, overflowMode: 'strict', injectedIds: [], omittedCount: 1 }))
  })

  it('热更新后组装出的文本没变就不发：只在文本变了时恰好多一份', async () => {
    const t = await setup()
    await t.putGlobal({ id: 'mem_k', type: 'knowledge', name: '报销截止', content: '报销截止每月 25 日', summary: '报销截止日' })
    const first = await t.assembleOnce()
    expect(t.snapshotCount()).toBe(1)

    // 放宽上限：这条本来就装得下，文本不变；会话视图换成新上限，说明这次热更新确实重新组装过
    expect(await t.update({ snapshotTokenBudget: 8000 })).toEqual([['snapshotTokenBudget']])
    expect(await t.assembleOnce()).toBe(first)
    await t.sessionView(v => expect(v).toMatchObject({ budget: 8000, injectedIds: ['mem_k'] }))
    expect(t.snapshotCount()).toBe(1)

    expect(await t.update({ snapshotTokenBudget: 8000, evidenceLookup: 'active' })).toEqual([['evidenceLookup']])
    expect(await t.assembleOnce()).toContain(EVIDENCE_GUIDANCE.active)
    expect(t.snapshotCount()).toBe(2)
    expect(await t.assembleOnce()).toContain(EVIDENCE_GUIDANCE.active)
    expect(t.snapshotCount()).toBe(2)
  })

  it('改模板与自定义类型：memory_save 重注册（类型枚举重算），写时只认新模板，带入按新类型定义', async () => {
    const t = await setup()
    await t.putGlobal({ id: 'mem_reg', type: 'regulation', content: '数据出境要先过安全评估', summary: '数据出境' })
    const saveDef = t.tool('memory_save')
    expect(saveDef.parameters.properties.type!.enum).toContain('procedure')
    expect(saveDef.parameters.properties.type!.enum).not.toContain('regulation')
    expect(await t.assembleOnce()).not.toContain('【记忆·合规要求】')
    await expect(t.save({ type: 'regulation', name: '合规', content: '某条合规' })).rejects.toThrow(/type/) // 宿主按枚举校验参数

    expect(await t.update({ template: 'office', customTypes: { regulation } })).toEqual([['template'], ['customTypes']])
    const resaved = t.tool('memory_save')
    expect(resaved).not.toBe(saveDef)
    expect(resaved.parameters.properties.type!.enum).toEqual(expect.arrayContaining(['decision', 'commitment', 'person', 'regulation']))
    expect(resaved.parameters.properties.type!.enum).not.toContain('procedure')
    expect(resaved.description).toContain('regulation（合规要求）')
    // 自定义类型是常驻（core）：下一次组装就以完整正文带入；旧模板独有类型的记忆照常带入，分组名不退化
    await t.putGlobal({ id: 'mem_proc', type: 'procedure', name: '发版流程', summary: '发版步骤' })
    const switched = await t.assembleOnce()
    expect(switched).toContain('【记忆·合规要求】数据出境要先过安全评估')
    expect(switched).toContain('## 可复用流程（procedure）\n- [mem_proc] 发版流程（发版步骤）')
    await expect(t.save({ type: 'procedure', name: '流程', content: '旧模板的类型' })).rejects.toThrow(/type/)
    expect(await t.save({ type: 'decision', name: '定了用 A', content: '周会定了选型用 A 方案' })).toMatchObject({ kind: 'saved' })
  })

  it('关闭体检：四个治理工具注销、治理类子命令返回 governance-disabled、其余照常；重开后恢复，记忆不变', async () => {
    const t = await setup()
    await t.putGlobal({ id: 'mem_keep', content: '一直都在的记忆' })
    const before = await readFile(join(t.memoryRoot, 'global', 'mem_keep.md'), 'utf8')
    expect([...t.defs.keys()]).toEqual(expect.arrayContaining(GOVERNANCE_TOOLS))

    expect(await t.update({ governance: { enabled: false } })).toEqual([['governance', 'enabled']])
    expect([...t.defs.keys()].sort()).toEqual(['memory_forget', 'memory_save', 'memory_search', 'memory_snapshot', 'memory_source'])
    for (const line of [
      '/memory resolve {"decisionId":"pd_x","verdict":"keep-left"}', '/memory undo {"decisionId":"pd_x"}',
      '/memory promote {"decisionId":"pd_x","target":"global"}', '/memory promote-memory {"memoryId":"mem_keep"}',
      '/memory keep-local {"decisionId":"pd_x"}',
      '/memory scan',
    ]) {
      expect(await t.command(line)).toMatchObject({ kind: 'error', body: { ok: false, code: 'governance-disabled' } })
    }
    // 超限提醒在体检关闭时照样入账，忽略它不属于治理动作
    expect((await t.command('/memory dismiss-overflow {"decisionId":"pd_x"}')).body).toMatchObject({ ok: false, code: 'not-found' })
    expect((await t.command('/memory info')).body).toMatchObject({ ok: true, cmd: 'info' })
    expect((await t.command('/memory refresh-views')).body).toEqual({ ok: true, cmd: 'refresh-views' })
    expect((await t.command('/memory restore {"memoryId":"mem_keep"}')).body).toMatchObject({ ok: false, code: 'not-found' })
    // 「仍然有效」在体检关闭时照常可用：很久没确认的建议不靠模型，关闭时照样列出
    expect((await t.command('/memory confirm {"memoryId":"mem_none"}')).body).toMatchObject({ ok: false, code: 'not-found' })

    await t.update({ governance: { enabled: true } })
    expect([...t.defs.keys()]).toEqual(expect.arrayContaining(GOVERNANCE_TOOLS))
    expect((await t.command('/memory resolve {"decisionId":"pd_x","verdict":"keep-left"}')).body).toMatchObject({ ok: false, code: 'not-found' })
    expect(await readFile(join(t.memoryRoot, 'global', 'mem_keep.md'), 'utf8')).toBe(before)
  })

  it('配置热更新之后重写一遍全局视图', async () => {
    const t = await setup()
    await rm(join(t.memoryRoot, GUI_VIEW_DIR), { recursive: true })
    await t.update({ governance: { health: { sensitivity: 'proactive' } } })
    for (const file of Object.values(GUI_VIEW_FILES)) await stat(join(t.memoryRoot, GUI_VIEW_DIR, file))
  })

  it('配置热更新一次：每个全局视图文件恰好替换一次（在文件系统边界数 rename）', async () => {
    const t = await setup()
    const viewDir = join(t.memoryRoot, GUI_VIEW_DIR)
    fsTrace.calls = []
    fsTrace.on = true
    try {
      await t.update({ governance: { health: { sensitivity: 'proactive' } } })
    } finally {
      fsTrace.on = false
    }
    const replaced = (file: string) => fsTrace.calls.filter(c => c.startsWith(`fs/promises.rename(${join(viewDir, file)}.tmp-`)).length
    expect(Object.fromEntries(Object.values(GUI_VIEW_FILES).map(f => [f, replaced(f)]))).toEqual(Object.fromEntries(Object.values(GUI_VIEW_FILES).map(f => [f, 1])))
  })

  // 观察切法：查询「插件记忆」，记录只写了「插件的记忆」。只用主词典时查询切成 插件 / 记忆，记录全命中；
  // 用户词典加了「插件记忆」后查询多出这个整词，记录只部分命中，结果带 or-fallback。
  it.skipIf(!hasRealJieba)('改 search.userDictionaryPath：下一次 memory_search 按新词典切分，清空回到只用主词典', async () => {
    const t = await setup()
    const dict = join(t.memoryRoot, 'user.dict.txt')
    await writeFile(dict, '插件记忆 10 n\n')
    await t.putGlobal({ id: 'mem_plugin', content: '插件的记忆放在这里' })
    const search = () => t.tool('memory_search').execute({ query: '插件记忆' }, fakeExec()) as Promise<{ hits: Array<{ id: string }>; noteCode?: string }>

    expect(await search()).toMatchObject({ hits: [{ id: 'mem_plugin' }] })
    expect((await search()).noteCode).toBeUndefined()

    expect(await t.update({ search: { userDictionaryPath: dict } })).toEqual([['search', 'userDictionaryPath']])
    expect(await search()).toMatchObject({ hits: [{ id: 'mem_plugin' }], noteCode: 'or-fallback' })

    expect(await t.update({})).toEqual([['search', 'userDictionaryPath']])
    expect((await search()).noteCode).toBeUndefined()
  })

  it('快照冻结写该会话的视图；这次对话 memory_save 新记的 id 追加进去', async () => {
    const t = await setup()
    await t.putGlobal({ id: 'mem_p', type: 'preference', content: '测试里不要 mock 数据库' })
    await t.assembleOnce()
    const frozen = await t.sessionView(v => expect(v).toMatchObject({ sessionId: 'sess-hot', injectedIds: ['mem_p'], savedIds: [] }))
    const saved = await t.save({ type: 'project', name: '冻结到 3 月', content: 'merge freeze 到 3 月 5 日' })
    expect(saved.kind).toBe('saved')
    await t.sessionView(v => expect(v).toEqual({ ...frozen, savedIds: [saved.record!.id] }))
  })

  it('快照来历：首次冻结是对话开始时；失败的压缩与配置热更新不改；成功压缩后重建是压缩后，压缩前新写入的进了带入', async () => {
    const t = await setup()
    await t.putGlobal({ id: 'mem_p', type: 'preference', content: '测试里不要 mock 数据库' })
    await t.assembleOnce()
    await t.sessionView(v => expect(v).toMatchObject({ origin: 'start', coreIds: ['mem_p'], injectedIds: ['mem_p'] }))
    const saved = await t.save({ type: 'project', name: '冻结到 3 月', content: 'merge freeze 到 3 月 5 日' })
    const id = saved.record!.id

    t.endCompaction(4_000, 'summarizer failed')
    await t.assembleOnce()
    await t.update({ evidenceLookup: 'active' })
    await t.assembleOnce()
    const unchanged = await t.sessionView(v => expect(v).toMatchObject({ origin: 'start', savedIds: [id] }))
    expect(unchanged.compactedAt).toBeUndefined()

    t.endCompaction(5_000)
    await t.assembleOnce()
    const compacted = await t.sessionView(v => expect(v).toMatchObject({ origin: 'compacted', compactedAt: 5_000, savedIds: [id] }))
    expect(compacted.injectedIds).toContain(id)
  })

  /** 全局视图是旁路写入：等它满足条件。 */
  const globalView = <T>(t: Awaited<ReturnType<typeof setup>>, name: keyof typeof GUI_VIEW_FILES, schema: { parse(v: unknown): T }, check: (v: T) => void) =>
    vi.waitFor(async () => {
      const v = schema.parse(JSON.parse(await readFile(join(t.memoryRoot, GUI_VIEW_DIR, GUI_VIEW_FILES[name]), 'utf8')))
      check(v)
      return v
    })
  const libraryIds = (v: LibraryView) => v.layers.flatMap(l => l.items.map(m => m.id))

  it('模型 memory_save 后全部记忆里就有这条：右侧栏「这次对话新记的」按会话视图的 savedIds 到全部记忆里取卡片，两边都要到位', async () => {
    const t = await setup()
    await t.assembleOnce()
    const saved = await t.save({ type: 'project', name: '冻结到 3 月', content: 'merge freeze 到 3 月 5 日' })
    const id = saved.record!.id
    await t.sessionView(v => expect(v.savedIds).toEqual([id]))
    const library = await globalView(t, 'library', libraryViewSchema, v => expect(libraryIds(v)).toContain(id))
    // 右侧栏的取法：savedIds 里的每个 id 都能在全部记忆里找到卡片
    const byId = new Map(library.layers.flatMap(l => l.items.map(m => [m.id, m])))
    expect(byId.get(id)).toMatchObject({ name: '冻结到 3 月', scope: 'workspace' })
  })

  it('模型 memory_forget / memory_snapshot 恢复后，全部记忆与最近删除跟着变', async () => {
    const t = await setup()
    const saved = await t.save({ type: 'project', name: '冻结到 3 月', content: 'merge freeze 到 3 月 5 日' })
    const id = saved.record!.id
    await globalView(t, 'library', libraryViewSchema, v => expect(libraryIds(v)).toContain(id))
    const forgot = await t.tool('memory_forget').execute({ ids: [id], reason: '不再需要' }, t.exec) as { snapshotId: string }
    await globalView(t, 'library', libraryViewSchema, v => expect(libraryIds(v)).not.toContain(id))
    await globalView(t, 'deleted', deletedViewSchema, v => expect(v.items.map(i => i.memory.id)).toEqual([id]))
    await t.tool('memory_snapshot').execute({ action: 'restore', snapshotId: forgot.snapshotId, memoryIds: [id] }, t.exec)
    await globalView(t, 'library', libraryViewSchema, v => expect(libraryIds(v)).toContain(id))
    await globalView(t, 'deleted', deletedViewSchema, v => expect(v.items).toEqual([]))
  })

  it('模型 memory_scan / memory_promote / memory_confirm 后，待处理与全部记忆跟着变', async () => {
    const t = await setup()
    // 在项目会话里存 global：管线降级为本项目 + 提升候选
    const saved = await t.save({ type: 'preference', scope: 'global', name: '都用 vitest', content: '所有项目都用 vitest' })
    const id = saved.record!.id
    await t.tool('memory_scan').execute({ layers: 'rule' }, t.exec)
    await globalView(t, 'pending', pendingViewSchema, v => expect(v.items.map(i => i.kind)).toEqual(['promote-candidate']))
    await t.tool('memory_promote').execute({ ids: [id], target: 'global' }, t.exec)
    await globalView(t, 'pending', pendingViewSchema, v => expect(v.items).toEqual([]))
    await globalView(t, 'library', libraryViewSchema, v => expect(v.layers.find(l => l.layer.kind === 'global')!.items.map(m => m.id)).toEqual([id]))

    await t.putGlobal({ id: 'mem_a', content: '用 pnpm' })
    await t.putGlobal({ id: 'mem_b', content: '用 npm' })
    const { entry } = await new PendingDecisionsStore(sidecarAt(t.memoryRoot).pending)
      .upsert({ memoryIds: ['mem_a', 'mem_b'], summary: '包管理器矛盾', fingerprint: 'fp-ab' }, 1)
    await t.command('/memory refresh-views')
    // 这两条的确认时间很早，另有「很久没确认」的建议整理，与账本无关，不看
    const ledgerKinds = (v: PendingView) => v.items.filter(i => i.kind !== 'advice').map(i => i.kind)
    await globalView(t, 'pending', pendingViewSchema, v => expect(ledgerKinds(v)).toEqual(['conflict-horizontal']))
    await t.tool('memory_confirm').execute({ action: 'resolve', decisionId: entry.id, verdict: 'keep-both' }, t.exec)
    await globalView(t, 'pending', pendingViewSchema, v => expect(ledgerKinds(v)).toEqual([]))
  })

  it('调高上限：超限提醒当场按新上限重算（不等下一次组装），用量回到上限以内就了结，视图跟着重写', async () => {
    const t = await setup({ snapshotTokenBudget: 20 })
    await t.putGlobal({ id: 'mem_long', type: 'preference', name: '长偏好', summary: '长偏好', content: '回答先给结论再讲理由，'.repeat(30) })
    await t.assembleOnce()
    const { usedTokens, workspacePath } = await t.sessionView(v => expect(v.usedTokens).toBeGreaterThan(40))
    await globalView(t, 'pending', pendingViewSchema, v => expect(v.items.map(i => i.kind)).toEqual(['overflow']))
    const readNow = async <T>(name: keyof typeof GUI_VIEW_FILES, schema: { parse(v: unknown): T }) =>
      schema.parse(JSON.parse(await readFile(join(t.memoryRoot, GUI_VIEW_DIR, GUI_VIEW_FILES[name]), 'utf8')))

    // 还超，但档位按新上限算：用量约为新上限的 1.1 倍，落在第 1 档
    const mid = Math.ceil(usedTokens / 1.1)
    await t.update({ snapshotTokenBudget: mid })
    const expected = overflowLevel('relax', usedTokens, mid)!
    expect((await readNow('pending', pendingViewSchema)).items).toEqual([
      expect.objectContaining({ kind: 'overflow', mode: 'relax', tier: expected.tier, workspacePath }),
    ])
    expect(expected.tier).toBe(1)
    // 会话所在项目自己没有记忆：健康里单列这条超限，档位与待处理一致
    expect((await readNow('health', healthViewSchema)).overflowOnlyLayers).toEqual([{ layer: { kind: 'workspace', workspacePath }, overflow: { ...expected, isDismissed: false } }])

    await t.update({ snapshotTokenBudget: usedTokens + 1000 })
    const pending = await readNow('pending', pendingViewSchema)
    expect([pending.items, pending.dot]).toEqual([[], 'none'])
    const health = await readNow('health', healthViewSchema)
    expect([health.layers.map(l => l.overflow).filter(o => o !== null), health.overflowOnlyLayers]).toEqual([[], []])
    expect(await new PendingDecisionsStore(sidecarAt(t.memoryRoot).pending).listOverflow()).toEqual([])
  })
})
