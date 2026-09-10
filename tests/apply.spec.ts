import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { fakeExec } from './helpers/exec.ts'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { TurnBoundaryProjection } from '@deepseek-ai/dsh-agent'

// 真实 dsh-tools / dsh-storage-domain 包已从 npm 装好，此处不 mock 任何框架包。
import { apply, Config } from '../src/index.ts'
import { InMemoryTable } from '../src/store.ts'
import { INDEX_FILE } from '../src/storage/paths.ts'
import { encodeRecord } from '../src/storage/frontmatter.ts'
import { TypeRegistryError } from '../src/errors.ts'
import { record } from './helpers/record.ts'

function mockCtx() {
  const registered: string[] = []
  const contexts: string[] = []
  const listeners = new Map<string, (...args: unknown[]) => unknown>()
  return {
    registered, contexts, listeners,
    tools: { register: (def: { name: string }) => { registered.push(def.name); return () => {} } },
    systemPrompt: { context: (c: { name: string }) => { contexts.push(c.name); return () => {} } },
    storageDomain: {
      open: async () => ({
        table: () => new InMemoryTable(),
        global: {}, name: 'plastic_memory', close: async () => {},
      }),
    },
    on: (event: string, fn: (...args: unknown[]) => unknown) => { listeners.set(event, fn); return () => {} },
    effect: (fn: () => unknown) => { fn() },
    // resolveWorkspacePath 的 ctx.get('workspaceRegistry') 和 makeSemanticLlm 的
    // ctx.get('llm') 共用这个 stub：两者都拿 undefined，前者判无 workspace 插件，
    // 后者判语义层不可用——这里不模拟 cordis proxy 对未知服务名的抛错行为。
    get: () => undefined,
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
    // undefined。mockCtx() 的 get() 简单返回 undefined，测不出这种抛错——这里用会抛错的
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
