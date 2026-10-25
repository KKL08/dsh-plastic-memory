import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fakeExec } from './helpers/exec.ts'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { TurnBoundaryProjection } from '@deepseek-ai/dsh-agent'
import { Context } from '@deepseek-ai/cordis'
import Registry, { type SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { MessageSourceMap } from '@deepseek-ai/dsh-llm'

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
import { renderViaHost } from './helpers/render-via-host.ts'
import { MemoryStore } from '../src/store.ts'
import { PROMPT_LBRACE_VARIABLE, assembleSnapshot, overflowLevel } from '../src/snapshot.ts'
import { FileTable } from '../src/storage/file-table.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'
import type { AssembleContext, PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { cacheKey } from '../src/tools/scan.ts'
import {
  memorySnapshotSchema, pendingDecisionSchema, scanCacheSchema,
  type MemorySnapshot, type PendingDecision, type ScanCacheEntry,
} from '../src/governance/schema.ts'
import { baselineProjectionDefinition } from '../src/governance/baseline.ts'
import { EVIDENCE_GUIDANCE } from '../src/evidence-guidance.ts'
import {
  GUI_VIEW_DIR, GUI_VIEW_FILES, GUI_WORKSPACE_MAP_FILE, deletedViewSchema, healthViewSchema, libraryViewSchema, pendingViewSchema, sessionViewFile, sessionViewSchema,
  workspaceMapViewSchema, type LibraryView,
} from '../src/gui/contract.ts'
import { PendingDecisionsStore } from '../src/governance/decisions.ts'
import { defaultJiebaLoader } from '../src/search/jieba-segmenter.ts'

/** 宿主 storageDomain 表的替身（@deepseek-ai/dsh-storage-domain KvTable 的形状）：读同步、写异步。 */
class HostKvTable<T = unknown> {
  private map = new Map<string, T>()
  get(key: string) { return this.map.get(key) }
  entries() { return this.map.entries() }
  keys() { return this.map.keys() }
  async put(key: string, value: T) { this.map.set(key, value) }
  async delete(key: string) { return this.map.delete(key) }
}

/** 本文件建出的全部替身 ctx 的卸载入口：afterEach 先卸载插件、等它的写入收尾，再删临时目录。 */
const liveCtxs: Array<() => Promise<void>> = []

/**
 * projections：ctx.get('sessionProjections') 给出的注册表（缺省 = 服务缺席）。inject 仿 cordis 的
 * ctx.inject(deps, cb)：依赖齐了才同步回调、把服务放进 child；registerProjection=false 模拟回调始终没触发。
 * 回调返回的 disposer 记下来，dispose() 仿插件卸载逆序逐个 await。
 */
function mockCtx(opts: { projections?: SessionProjectionRegistry; registerProjection?: boolean; storageDomain?: boolean; commands?: { register(def: unknown): () => void } } = {}) {
  const registered: string[] = []
  const contexts: string[] = []
  // 完整的 context 注册对象（含 text provider）与提示词变量，供转义接线用例取用
  const contextDefs: Array<{ name: string; order: number; text: (assembleCtx?: AssembleContext) => string }> = []
  const variables = new Map<string, (assembleCtx: AssembleContext) => string | undefined>()
  const listeners = new Map<string, (...args: unknown[]) => unknown>()
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
    registered, contexts, contextDefs, variables, listeners, llmRequests, llmScript, tables, domain,
    tools: { register: (def: { name: string }) => { registered.push(def.name); return () => { registered.splice(registered.indexOf(def.name), 1) } } },
    systemPrompt: {
      context: (c: (typeof contextDefs)[number]) => { contexts.push(c.name); contextDefs.push(c); return () => {} },
      variable: (name: string, provider: (assembleCtx: AssembleContext) => string | undefined) => { variables.set(name, provider); return () => {} },
    },
    on: (event: string, fn: (...args: unknown[]) => unknown) => { listeners.set(event, fn); return () => {} },
    effect: (fn: () => unknown) => { fn() },
    // 按服务名分发：'llm' 给上面的假 llm，'sessionProjections' 给 opts.projections，'storageDomain'
    // 按 opts.storageDomain 给旧 KV 域；其余（如 resolveWorkspacePath 的 workspaceRegistry）一律
    // undefined，判为服务缺席——这里不模拟 cordis proxy 对未知服务名的抛错行为。
    get: (name: string) => (name === 'llm' ? llm
      : name === 'sessionProjections' ? opts.projections
        : name === 'storageDomain' && opts.storageDomain === true ? storageDomain
          : undefined),
    // 按依赖名分发，像 cordis 一样只在依赖的服务都在时才回调
    inject: (deps: string[], callback: (child: Record<string, unknown>) => unknown) => {
      const collect = (dispose: unknown) => { if (typeof dispose === 'function') disposers.push(dispose as () => unknown) }
      if (deps.includes('sessionProjections') && opts.projections !== undefined && opts.registerProjection !== false) {
        collect(callback({ sessionProjections: opts.projections }))
      }
      if (deps.includes('commands') && opts.commands !== undefined) collect(callback({ commands: opts.commands }))
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
  return new SidecarStore({ root: memoryRoot, schemas: { snapshots: memorySnapshotSchema, pending: pendingDecisionSchema, scanCache: scanCacheSchema } })
}

describe('apply', () => {
  it('治理默认开启：注册九个工具和一个 runtime context', async () => {
    const ctx = mockCtx()
    const memoryRoot = await makeTmpRoot()
    await apply(ctx as never, new Config({ memoryRoot } as never))
    expect(ctx.registered.sort()).toEqual([
      'memory_confirm', 'memory_forget', 'memory_health', 'memory_promote',
      'memory_save', 'memory_scan', 'memory_search', 'memory_snapshot', 'memory_source',
    ])
    expect(ctx.contexts).toEqual(['plastic-memory'])
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

  it('监听 session/created、session/event、system-prompt/assemble（首轮竞态等待）与 loader/volatile-update（配置热生效）', async () => {
    const ctx = mockCtx()
    const memoryRoot = await makeTmpRoot()
    await apply(ctx as never, new Config({ memoryRoot } as never))
    expect([...ctx.listeners.keys()].sort()).toEqual(['loader/volatile-update', 'session/created', 'session/event', 'system-prompt/assemble'])
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
    return { memoryRoot, defs, exec }
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
    expect(atDispose.map(([name]) => name).sort()).toEqual(Object.values(GUI_VIEW_FILES).sort())
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

  it('注册列表不含 storageDomain：只要求 tools 与 systemPrompt', () => {
    expect(inject).toEqual(['tools', 'systemPrompt'])
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

/**
 * 宿主对 context 文本做 {{变量}} 插值且没有关闭选项，记忆正文是用户可控内容：apply() 注册
 * 左花括号变量，快照出口把 {{ 转义成对它的引用。这里验证接线：变量注册了，且 assemble
 * 中间件覆写后的文本经宿主真实渲染还原为原文快照。
 */
describe('快照 {{ 转义接线', () => {
  it('apply 注册 plastic_memory_lbrace 变量，provider 返回 {{', async () => {
    const ctx = mockCtx()
    const memoryRoot = await makeTmpRoot()
    await apply(ctx as never, new Config({ memoryRoot } as never))
    const provider = ctx.variables.get(PROMPT_LBRACE_VARIABLE)
    expect(provider).toBeDefined()
    expect(provider!({})).toBe('{{')
  })

  it('system-prompt/assemble 中间件覆写的文本经宿主渲染还原为原文快照（含 {{ 的工作区记忆逐字保留）', async () => {
    const memoryRoot = await makeTmpRoot()
    const cwd = await makeTmpRoot() // resolveWorkspacePath 走 realpath，cwd 须真实存在
    const workspacePath = await realpath(cwd) // 无 workspaceRegistry 时规范化 cwd 即目录桶
    const content = 'Vue 模板写 {{ msg }}'
    const wsDir = join(memoryRoot, workspaceDirName(workspacePath))
    await mkdir(wsDir, { recursive: true })
    await writeFile(join(wsDir, WORKSPACE_MARKER), workspacePath, 'utf8')
    const now = Date.now()
    await writeFile(join(wsDir, 'vue.md'), encodeRecord(record({
      id: 'mem_vue', type: 'preference', scope: 'workspace', workspacePath, content,
      createdAt: now, updatedAt: now, lastConfirmedAt: now,
    }), {}), 'utf8')

    const ctx = mockCtx()
    const config = new Config({ memoryRoot } as never)
    await apply(ctx as never, config)

    const session = { header: { id: 'sess-1', cwd } }
    const assembleCtx = { scope: { session } } as unknown as AssembleContext
    const def = ctx.contextDefs.find(c => c.name === 'plastic-memory')!
    // 变量表只取 apply() 注册的 provider 求值结果：注册与渲染在同一用例里接上
    const variables = Object.fromEntries([...ctx.variables].map(([name, provider]) => [name, provider(assembleCtx)]))
    const assembly: PromptAssembly = {
      sections: [],
      contexts: [{ name: 'plastic-memory', text: def.text(assembleCtx) }],
      tools: [],
      variables,
    }
    const middleware = ctx.listeners.get('system-prompt/assemble')!
    await middleware(assembly, assembleCtx, async () => assembly)
    const text = assembly.contexts[0]!.text

    // 期望原文：同一份磁盘记忆、同一组参数独立组装一次快照
    const fileTable = new FileTable({ root: memoryRoot, stats: new InMemoryKvTable() })
    const expected = assembleSnapshot({
      records: await new MemoryStore(fileTable).query({ scope: { kind: 'visible', workspacePath } }),
      registry: buildTypeRegistry({ template: config.template.get(), customTypes: config.customTypes.get() }),
      workspacePath, budget: config.snapshotTokenBudget.get(), now: Date.now(),
      memoryRoot, evidenceLookup: config.evidenceLookup.get(),
    }).text
    expect(expected).toContain(content)
    expect(text.replaceAll(`{{${PROMPT_LBRACE_VARIABLE}}}`, '')).not.toContain('{{')
    const rendered = renderViaHost(text, assembly.variables)
    expect(rendered).toBe(expected)
    expect(rendered).toContain(content)
  })
})

/**
 * 注入链接线（spec「注入链」）：快照只在 system-prompt/assemble 中间件里构建；同步 provider 只回缓存、
 * 无缓存回空串；compaction/end 只标过期，provider 仍回旧快照，下一次中间件重建。
 */
describe('注入链接线', () => {
  it('provider 首轮空串 → 中间件冻结 → provider 回缓存；compaction/end 后 provider 回旧快照、下一次中间件回新快照', async () => {
    type ToolDef = { name: string; execute(args: unknown, exec: unknown): Promise<unknown> }
    const defs = new Map<string, ToolDef>()
    const ctx = { ...mockCtx(), tools: { register: (def: ToolDef) => { defs.set(def.name, def); return () => {} } } }
    const memoryRoot = await makeTmpRoot()
    await mkdir(join(memoryRoot, 'global'), { recursive: true })
    await writeFile(join(memoryRoot, 'global', 'old.md'),
      encodeRecord(record({ id: 'mem_old', type: 'preference', content: '压缩前就有的偏好' }), {}), 'utf8')
    await apply(ctx as never, new Config({ memoryRoot } as never))

    const session = { header: { id: 'sess-1' } } // 无 cwd：解析落定为"无工作目录"，走正常冻结路径
    const assembleCtx = { scope: { session } } as unknown as AssembleContext
    const def = ctx.contextDefs.find(c => c.name === 'plastic-memory')!
    const middleware = ctx.listeners.get('system-prompt/assemble')!
    const onEvent = ctx.listeners.get('session/event')!
    const assembleOnce = async () => {
      const assembly: PromptAssembly = { sections: [], contexts: [{ name: 'plastic-memory', text: def.text(assembleCtx) }], tools: [], variables: {} }
      await middleware(assembly, assembleCtx, async () => assembly)
      return assembly.contexts[0]!.text
    }

    expect(def.text(assembleCtx)).toBe('') // 中间件之前：空串，不是冷启动文案
    const first = await assembleOnce()
    expect(first).toContain('压缩前就有的偏好')
    expect(def.text(assembleCtx)).toBe(first)

    // 外部落盘一条新记忆，经工具入口刷新进内存（注入路径本身不刷新）
    await writeFile(join(memoryRoot, 'global', 'new.md'),
      encodeRecord(record({ id: 'mem_new', type: 'preference', content: '压缩后新增的偏好 zebra' }), {}), 'utf8')
    await defs.get('memory_search')!.execute({ query: 'zebra' }, fakeExec())
    expect(await assembleOnce()).toBe(first) // 未压缩：仍是冻结快照

    onEvent(session, { type: 'compaction/end' })
    expect(def.text(assembleCtx)).toBe(first) // admission refresh 只调 provider：拿到上一份快照
    const rebuilt = await assembleOnce()
    expect(rebuilt).toContain('压缩后新增的偏好 zebra')
    expect(def.text(assembleCtx)).toBe(rebuilt)
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
    const memoryRoot = await makeTmpRoot()
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
    const { user } = buildSemanticPrompt([], null)
    expect(msg).toEqual({ role: 'user', content: [{ type: 'text', text: user }] })
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
    const memoryRoot = await makeTmpRoot()
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
    const memoryRoot = await makeTmpRoot()
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
})

/**
 * 证据锚（设计 evidence-anchor §3）在宿主 0.1.5 上的读法：起点来自 agent-loop 注册的 turnBoundary
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
    await apply(ctx as never, new Config({ memoryRoot: await makeTmpRoot() } as never))
    const scan = async (session: object, args: object) => await defs.get('memory_scan')!.execute(args, fakeExec({
      agent: { session, options: { provider: 'deepseek', model: 'deepseek-chat' } } as unknown as ToolRunContext['agent'],
    })) as ScanOut
    return { scan, warnings }
  }
  const promptUser = (request: { messages: unknown[] } | undefined) =>
    (request?.messages[0] as { content: Array<{ text: string }> }).content[0]!.text

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
    expect(promptUser(base.llmRequests[0])).toBe(buildSemanticPrompt([], ['# AGENTS.md\n不要 mock 数据库']).user)
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
      buildSemanticPrompt([], ['项目甲：用 pnpm']).user,
      buildSemanticPrompt([], ['项目乙：用 npm']).user,
      buildSemanticPrompt([], ['项目甲：用 pnpm']).user,
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
    const session = { header: { id: 'sess-hot', cwd: workDir }, seq: 3 }
    ctx.listeners.get('session/created')!(session)
    await startupViews(memoryRoot)

    const assembleCtx = { scope: { session } } as unknown as AssembleContext
    const def = ctx.contextDefs.find(c => c.name === 'plastic-memory')!
    const assembleOnce = async () => {
      const assembly: PromptAssembly = { sections: [], contexts: [{ name: 'plastic-memory', text: def.text(assembleCtx) }], tools: [], variables: {} }
      await ctx.listeners.get('system-prompt/assemble')!(assembly, assembleCtx, async () => assembly)
      return assembly.contexts[0]!.text
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
    return { memoryRoot, defs, config, assembleOnce, update, tool, exec, save, command, sessionView, putGlobal }
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
      '/memory promote {"decisionId":"pd_x","target":"global"}', '/memory keep-local {"decisionId":"pd_x"}',
      '/memory scan',
    ]) {
      expect(await t.command(line)).toMatchObject({ kind: 'error', body: { ok: false, code: 'governance-disabled' } })
    }
    // 超限提醒在体检关闭时照样入账，忽略它不属于治理动作
    expect((await t.command('/memory dismiss-overflow {"decisionId":"pd_x"}')).body).toMatchObject({ ok: false, code: 'not-found' })
    expect((await t.command('/memory info')).body).toMatchObject({ ok: true, cmd: 'info' })
    expect((await t.command('/memory refresh-views')).body).toEqual({ ok: true, cmd: 'refresh-views' })
    expect((await t.command('/memory restore {"memoryId":"mem_keep"}')).body).toMatchObject({ ok: false, code: 'not-found' })

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
    await globalView(t, 'pending', pendingViewSchema, v => expect(v.items.map(i => i.kind)).toEqual(['conflict-horizontal']))
    await t.tool('memory_confirm').execute({ action: 'resolve', decisionId: entry.id, verdict: 'keep-both' }, t.exec)
    await globalView(t, 'pending', pendingViewSchema, v => expect(v.items).toEqual([]))
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
    expect((await readNow('health', healthViewSchema)).overflowOnlyLayers).toEqual([{ layer: { kind: 'workspace', workspacePath }, overflow: expected }])

    await t.update({ snapshotTokenBudget: usedTokens + 1000 })
    const pending = await readNow('pending', pendingViewSchema)
    expect([pending.items, pending.dot]).toEqual([[], 'none'])
    const health = await readNow('health', healthViewSchema)
    expect([health.layers.map(l => l.overflow).filter(o => o !== null), health.overflowOnlyLayers]).toEqual([[], []])
    expect(await new PendingDecisionsStore(sidecarAt(t.memoryRoot).pending).listOverflow()).toEqual([])
  })
})
