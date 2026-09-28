import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { fakeExec } from './helpers/exec.ts'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { TurnBoundaryProjection } from '@deepseek-ai/dsh-agent'
import { Context } from '@deepseek-ai/cordis'
import Registry, { type SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { MessageSourceMap } from '@deepseek-ai/dsh-llm'

// 真实 dsh-tools / dsh-storage-domain 包已从 npm 装好，此处不 mock 任何框架包。
import { apply, Config } from '../src/index.ts'
import { InMemoryTable, MemoryStore } from '../src/store.ts'
import { INDEX_FILE, WORKSPACE_MARKER, workspaceDirName } from '../src/storage/paths.ts'
import { encodeRecord } from '../src/storage/frontmatter.ts'
import { TypeRegistryError } from '../src/errors.ts'
import { buildSemanticPrompt } from '../src/governance/semantic-scan.ts'
import { record } from './helpers/record.ts'
import { renderViaHost } from './helpers/render-via-host.ts'
import { PROMPT_LBRACE_VARIABLE, assembleSnapshot } from '../src/snapshot.ts'
import { FileTable } from '../src/storage/file-table.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'
import type { AssembleContext, PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { cacheKey } from '../src/tools/scan.ts'
import type { ScanCacheEntry } from '../src/governance/schema.ts'
import { baselineProjectionDefinition } from '../src/governance/baseline.ts'

/**
 * projections：ctx.get('sessionProjections') 给出的注册表（缺省 = 服务缺席）。inject 仿 cordis 的
 * ctx.inject(deps, cb)：依赖齐了才同步回调、把服务放进 child；registerProjection=false 模拟回调始终没触发。
 */
function mockCtx(opts: { projections?: SessionProjectionRegistry; registerProjection?: boolean } = {}) {
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
  // 按表名复用同一张表：用例可以在 apply() 前预置、事后读回插件打开的那张表。
  const tables = new Map<string, InMemoryTable>()
  return {
    registered, contexts, contextDefs, variables, listeners, llmRequests, llmScript, tables,
    tools: { register: (def: { name: string }) => { registered.push(def.name); return () => {} } },
    systemPrompt: {
      context: (c: (typeof contextDefs)[number]) => { contexts.push(c.name); contextDefs.push(c); return () => {} },
      variable: (name: string, provider: (assembleCtx: AssembleContext) => string | undefined) => { variables.set(name, provider); return () => {} },
    },
    storageDomain: {
      open: async () => ({
        table: (name: string) => {
          let table = tables.get(name)
          if (!table) tables.set(name, table = new InMemoryTable())
          return table
        },
        global: {}, name: 'plastic_memory', close: async () => {},
      }),
    },
    on: (event: string, fn: (...args: unknown[]) => unknown) => { listeners.set(event, fn); return () => {} },
    effect: (fn: () => unknown) => { fn() },
    // 按服务名分发：'llm' 给上面的假 llm，'sessionProjections' 给 opts.projections；其余（如
    // resolveWorkspacePath 的 workspaceRegistry）一律 undefined，判为服务缺席——这里不模拟 cordis
    // proxy 对未知服务名的抛错行为。
    get: (name: string) => (name === 'llm' ? llm : name === 'sessionProjections' ? opts.projections : undefined),
    inject: (_deps: string[], callback: (child: { sessionProjections: SessionProjectionRegistry }) => void) => {
      if (opts.projections !== undefined && opts.registerProjection !== false) callback({ sessionProjections: opts.projections })
      return () => {}
    },
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

// FileTable 是纯 fs 类，vitest 下用 mkdtemp 真实落盘跑；afterEach 统一清理，
// 避免任何用例（包括抛错用例）碰到缺省 memoryRoot 从而落到真实 ~/.dsh/memories。
const tmpDirs: string[] = []
async function makeTmpRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'plastic-memory-apply-'))
  tmpDirs.push(dir)
  return dir
}
afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map(d => rm(d, { recursive: true, force: true })))
})

describe('apply', () => {
  it('治理默认开启：注册九个工具和一个 runtime context', async () => {
    const ctx = mockCtx()
    const memoryRoot = await makeTmpRoot()
    await apply(ctx as never, new Config({ memoryRoot } as unknown as Config))
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
    const config = new Config({ memoryRoot, governance: { enabled: false, onWrite: false } } as unknown as Config)
    await apply(ctx as never, config)
    expect(ctx.registered.sort()).toEqual(['memory_forget', 'memory_save', 'memory_search', 'memory_snapshot', 'memory_source'])
  })

  it('监听 session/created、session/event 与 system-prompt/assemble（首轮竞态等待）', async () => {
    const ctx = mockCtx()
    const memoryRoot = await makeTmpRoot()
    await apply(ctx as never, new Config({ memoryRoot } as unknown as Config))
    expect([...ctx.listeners.keys()].sort()).toEqual(['session/created', 'session/event', 'system-prompt/assemble'])
  })

  it('Fix 1 回归：ctx.get 对任意服务名抛错也不拖垮插件加载，九个工具照常注册', async () => {
    // 真实 cordis 的 Context 是 proxy：对未 inject 的服务名走属性访问会抛错，且不会退化为
    // undefined。mockCtx() 的 get() 对未知服务名返回 undefined，测不出这种抛错——这里用会抛错的
    // get() 逼近 cordis 行为，钉住"服务解析失败/抛错不能让 apply() 整体失败"这条回归。
    const ctx = mockCtxWithThrowingGet()
    const memoryRoot = await makeTmpRoot()
    await apply(ctx as never, new Config({ memoryRoot } as unknown as Config))
    expect(ctx.registered.sort()).toEqual([
      'memory_confirm', 'memory_forget', 'memory_health', 'memory_promote',
      'memory_save', 'memory_scan', 'memory_search', 'memory_snapshot', 'memory_source',
    ])
  })

  it('接线集成：apply 注册后的 memory_search 能看见加载之后外部新写入的文件（入口刷新真的接上了）', async () => {
    // 只保存名称的 stub 守不住 withRefresh 这段接线：移除 refreshIfChanged 调用，全套单测照样绿。
    // 这里留住真实 ToolDefinition，经注册后的 execute 走一遍：加载后外部落盘的记忆必须能被检索到。
    type ToolDef = { name: string; execute(args: unknown, exec: unknown): Promise<unknown> }
    const defs = new Map<string, ToolDef>()
    const ctx = { ...mockCtx(), tools: { register: (def: ToolDef) => { defs.set(def.name, def); return () => {} } } }
    const memoryRoot = await makeTmpRoot()
    await apply(ctx as never, new Config({ memoryRoot } as unknown as Config))
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
    } as unknown as Config)
    // 该用例在 buildTypeRegistry 阶段就抛错，FileTable 根本没构造——传 memoryRoot 只是
    // 确保就算未来实现顺序调整，也不会有路径意外落到默认值指向的真实 ~/.dsh/memories。
    await expect(apply(mockCtx() as never, config)).rejects.toThrow(TypeRegistryError)
  })

  it('磁盘上有坏 md（无 frontmatter）时 apply 仍正常完成（load 不抛，插件加载不受记忆坏文件影响）', async () => {
    const memoryRoot = await makeTmpRoot()
    await mkdir(join(memoryRoot, 'global'), { recursive: true })
    await writeFile(join(memoryRoot, 'global', 'broken.md'), '这是一段没有 frontmatter 的纯文本\n', 'utf8')
    const ctx = mockCtx()
    await apply(ctx as never, new Config({ memoryRoot } as unknown as Config))
    expect(ctx.registered.sort()).toEqual([
      'memory_confirm', 'memory_forget', 'memory_health', 'memory_promote',
      'memory_save', 'memory_scan', 'memory_search', 'memory_snapshot', 'memory_source',
    ])
    // 钉住 root 真的来自 config 且 load 跑到了 regenerateIndexes：空库也会落出
    // global/MEMORY.md。若 resolveMemoryRoot 漏传 config 落到默认值，这里 stat 必抛。
    expect((await stat(join(memoryRoot, 'global', INDEX_FILE))).isFile()).toBe(true)
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
    await apply(ctx as never, new Config({ memoryRoot } as unknown as Config))
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
    const config = new Config({ memoryRoot } as unknown as Config)
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
    const fileTable = new FileTable({ root: memoryRoot, stats: new InMemoryTable() })
    await fileTable.load()
    const expected = assembleSnapshot({
      store: new MemoryStore(fileTable), registry: buildTypeRegistry(config),
      workspacePath, budget: config.snapshotTokenBudget, now: Date.now(),
      memoryRoot, evidenceLookup: config.evidenceLookup,
    }).text
    expect(expected).toContain(content)
    expect(text.replaceAll(`{{${PROMPT_LBRACE_VARIABLE}}}`, '')).not.toContain('{{')
    const rendered = renderViaHost(text, assembly.variables)
    expect(rendered).toBe(expected)
    expect(rendered).toContain(content)
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
    await apply(ctx as never, new Config({ memoryRoot } as unknown as Config))
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
    const cache = new InMemoryTable()
    await cache.put(bucket, prior as never)
    base.tables.set('scan_cache', cache)
    // 首次与重试都是：先吐完整 JSON，再以 error 终止（DeepSeek 适配器在 message_stop 前断流）
    const brokenStream = (): StreamChunk[] => [
      { type: 'text-delta', index: 0, text: '{"findings":[]}' },
      { type: 'finish', reason: { kind: 'error', failure: { code: 'STREAM_CLOSED', message: 'stream ended before message_stop' } } },
    ]
    base.llmScript.push(brokenStream(), brokenStream())

    await apply(ctx as never, new Config({ memoryRoot } as unknown as Config))
    const session = { header: { id: 'sess-1', cwd }, seq: 0, requestHeader: () => undefined }
    const exec = fakeExec({
      agent: { session, options: { provider: 'deepseek', model: 'deepseek-chat' } } as unknown as ToolRunContext['agent'],
    })
    const out = await defs.get('memory_scan')!.execute({ layers: 'semantic' }, exec) as { notes?: Array<{ code: string }> }

    expect(base.llmRequests).toHaveLength(2)
    expect(out.notes?.map(n => n.code)).toContain('semantic-failed')
    expect(cache.get(bucket)).toEqual(prior)
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
    await apply(ctx as never, new Config({ memoryRoot } as unknown as Config))
    const cwd = await makeTmpRoot()
    const session = { header: { id: 'sess-1', cwd }, seq: 0, requestHeader: () => undefined }
    const exec = fakeExec({
      agent: { session, options: { provider: 'deepseek', model: 'deepseek-chat' } } as unknown as ToolRunContext['agent'],
    })
    await expect(defs.get('memory_scan')!.execute({ layers: 'semantic' }, exec)).rejects.toMatchObject({ name: 'AbortError' })
    expect(base.llmRequests).toHaveLength(1)
    expect(base.tables.get('scan_cache')!.get(cacheKey(await realpath(cwd)))).toBeUndefined()
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
    await apply(ctx as never, new Config({ memoryRoot } as unknown as Config))
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
    await apply(ctx as never, new Config({ memoryRoot: await makeTmpRoot() } as unknown as Config))
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
