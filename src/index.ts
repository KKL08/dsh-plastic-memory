import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import type { AssembleContext, PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import type { MemoryTypeDefinition } from './types.ts'
import { buildTypeRegistry } from './type-registry.ts'
import { memoryDomainSpec } from './domain-spec.ts'
import { MemoryStore } from './store.ts'
import { FileTable } from './storage/file-table.ts'
import { resolveMemoryRoot } from './storage/paths.ts'
import { formatIndexLine } from './index-line.ts'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { createSaveTool } from './tools/save-tool.ts'
import { createSearchTool } from './tools/search-tool.ts'
import { createForgetTool } from './tools/forget-tool.ts'
import { createConfirmTool } from './tools/confirm-tool.ts'
import { createScanTool } from './tools/scan-tool.ts'
import { createHealthTool } from './tools/health-tool.ts'
import { createPromoteTool } from './tools/promote-tool.ts'
import type { PromoteTarget } from './tools/promote.ts'
import { createAgentsMdWriter, agentsMdPath } from './storage/agents-md.ts'
import { createSnapshotTool } from './tools/snapshot-tool.ts'
import { createSourceTool } from './tools/source-tool.ts'
import type { ReadEventFn } from './tools/source.ts'
import { SnapshotCache, resolveWorkspacePath } from './runtime.ts'
import { resolveHealthThresholds, type HealthSensitivity } from './governance/health-presets.ts'
import { PendingDecisionsStore } from './governance/decisions.ts'
import { SnapshotStore } from './governance/snapshots.ts'
import { BaselineCache } from './governance/baseline.ts'
import type { SemanticLlm } from './governance/semantic-scan.ts'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

export interface Config {
  // reflective（会话结束/空闲时批量提取）是规划中的第二写入模式；实现时再回 schema 加回该取值
  // 及其参数（reflectModel 等）——配置面只声明当前真实生效的字段。
  writeMode: 'proactive'
  snapshotTokenBudget: number
  /** 证据下钻档位（docs/design-evidence-anchor.md §4）：off 不鼓励回查原始轨迹、strict 仅硬信号、active 开放路标式引导。 */
  evidenceLookup: 'off' | 'strict' | 'active'
  template: 'coding' | 'office' | 'custom'
  customTypes: Record<string, Omit<MemoryTypeDefinition, 'name'>>
  governance: { enabled: boolean; health: { sensitivity: HealthSensitivity }; globalPromoteTarget: 'plugin-global' | 'agents-md' }
  /** 记忆文件根目录，缺省解析到 ${DSH_HOME:-~/.dsh}/memories（storage/paths.ts） */
  memoryRoot: string
}

export const Config: z<Config> = z.object({
  writeMode: z.const('proactive').default('proactive'),
  snapshotTokenBudget: z.number().default(4000),
  evidenceLookup: z.union(['off', 'strict', 'active'] as const).default('strict'),
  template: z.union(['coding', 'office', 'custom'] as const).default('coding'),
  customTypes: z.dict(z.object({
    label: z.string().required(),
    description: z.string().required(),
    whenToSave: z.string().required(),
    recall: z.union(['core', 'search', 'passive'] as const).required(),
    decayDays: z.union([z.number(), z.const(null)]).default(null),
    governancePriority: z.union(['high', 'medium', 'low'] as const).required(),
  })).default({}),
  governance: z.object({
    enabled: z.boolean().default(true),
    health: z.object({
      sensitivity: z.union(['conservative', 'normal', 'proactive'] as const).default('normal'),
    }).default({ sensitivity: 'normal' }),
    globalPromoteTarget: z.union(['plugin-global', 'agents-md'] as const).default('plugin-global'),
  }),
  memoryRoot: z.string().default(''),
})

export const name = 'dsh-plastic-memory'
export const inject = ['tools', 'systemPrompt', 'storageDomain']

/** session/created 回调里用得到的最小 session 结构（真实类型是 dsh-session 的 Session）。 */
type SessionLike = object & { header?: { cwd?: string } }

export async function apply(ctx: Context, config: Config) {
  const registry = buildTypeRegistry(config) // 重名内置类型在这里抛错，加载即失败

  const domain = await ctx.storageDomain.open(memoryDomainSpec)
  ctx.effect(() => () => void domain.close())
  // 正文住 FileTable（磁盘 markdown），KV 只放易变的召回统计 sidecar（recall_stats）
  const statsTable = domain.table('recall_stats')
  const memoryRoot = resolveMemoryRoot(config.memoryRoot)
  // 纯逻辑层（file-table/store/forget）不 import 框架包，日志经 MemoryLogger 注入；
  // ctx.logger 结构上满足该形状（info/warn/error），直接注入，宿主按插件名归因。
  const fileTable = new FileTable({
    root: memoryRoot,
    stats: statsTable,
    // 磁盘索引不带陈旧度（静态文件里的时间相对标注会随时间失真），注入侧的陈旧度由 snapshot.ts 计算
    formatIndexLine: r => formatIndexLine(r, { passive: registry.get(r.type).recall === 'passive' }),
    log: ctx.logger,
  })
  await fileTable.load() // 契约：绝不 throw——记忆坏文件不能拖垮插件加载
  const store = new MemoryStore(fileTable, ctx.logger)
  // forget 的快照先行与待决账本清理需要这两个存储，治理关闭时也接线
  const decisions = new PendingDecisionsStore(domain.table('pending_decisions'))
  const snapshots = new SnapshotStore(domain.table('snapshots'))
  const scanCache = domain.table('scan_cache')
  const baseline = new BaselineCache()
  // cwd → workspace 归属的单一解析路径：SnapshotCache 的 lazy 自愈与 session/created 的 eager 预热共用，
  // 避免两处各写一份 resolveWorkspacePath 调用。
  const resolveWorkspace = (session: object) => resolveWorkspacePath(ctx, (session as SessionLike).header?.cwd)
  const snapshotCache = new SnapshotCache({ store, registry, budget: config.snapshotTokenBudget, memoryRoot, evidenceLookup: config.evidenceLookup, resolveWorkspace })

  /** 工具执行前感知外部文件修改；对 ToolDefinition 做统一包装，避免逐个改 -tool.ts。
   *  systemPrompt 注入路径不经这层：同步组装，永远服务最近一次加载的 Map（docs/p15-storage-search-redesign.md §7 已登记）。 */
  const withRefresh = (def: ToolDefinition): ToolDefinition => ({
    ...def,
    execute: async (args, exec) => {
      await fileTable.refreshIfChanged()
      return def.execute(args, exec)
    },
  })

  // 语义层 LLM：per-call 构建（provider/model 只能从触发调用的 agent 上拿到，插件加载时没有）。
  // 用 ctx.get 而非属性访问——cordis 的 Context 是 proxy，未 inject 的服务名走属性访问会抛错
  // （cannot get property "llm" without inject）；ctx.get 是安全查找，未注册老实返回 undefined
  // （cordis reflect.ts _getImpl），下面的 try/catch 只是对宿主行为变化的防御。
  // ⚠️ 真机验证确认的 dsh llm 契约（packages/llm/llm）：
  //   1) LlmRuntime.stream(options: GenerateOptions) 的 provider/model 是必填 string，没有"用会话当前模型"的默认值；
  //      三层解析顺序抄自 packages/compaction/compaction-basic/src/summarizer.ts：
  //      session.requestHeader()?.config（最近一次路由请求的配置）→ agent.options.provider/model；
  //      两者都拿不到（provider 或 model 缺失）就返回 null，语义层降级，绝不猜默认模型。
  //   2) StreamChunk 是判别联合，text-delta 和 reasoning-delta 都带 .text——开启推理时
  //      （本环境 DeepSeek-V4-Flash High effort）若不按 type 过滤会把思维链拼进输出，导致 JSON 解析失败。
  //      只累加 type === 'text-delta' 的 chunk。
  //   3) Message 需要 id/role/content/source 四个字段，content 是 ContentBlock[] 而非字符串，
  //      用真实构造函数 createUserMessage 生成，避免手搭形状不符的假消息。
  const makeSemanticLlm = (input: {
    session?: { requestHeader?: () => { config?: { provider?: string; model?: string } } | undefined }
    agentOptions?: { provider?: string; model?: string }
  }): SemanticLlm | null => {
    // 三层解析本体只看 session/agentOptions 两个形状，exec 形状知识留在调用点的小 helper 里。
    const routed = input.session?.requestHeader?.()?.config
    const provider = routed?.provider ?? input.agentOptions?.provider
    const model = routed?.model ?? input.agentOptions?.model
    if (!provider || !model) return null

    let llm: { stream?: (req: object) => AsyncIterable<{ type: string; text?: string }> } | undefined
    try {
      llm = ctx.get('llm') as typeof llm
    } catch {
      // ctx.get 按 cordis 现契约不抛（安全查找）；防御宿主行为变化，异常一律按"拿不到 LLM"降级
      return null
    }
    if (!llm?.stream) return null
    return {
      async complete({ system, user }, signal) {
        // 起步前先看取消：已取消就不发请求，直接抛（signal.reason 通常是 AbortError）。
        signal?.throwIfAborted()
        let out = ''
        // stream 建立或迭代过程中抛出的错误按 rejected promise 向上传播，
        // 由 runSemanticScan 的调用点捕获降级，这里不吞掉。
        // signal 透传给宿主 GenerateOptions，让在途请求随取消中断。
        for await (const chunk of llm.stream!({
          provider,
          model,
          system,
          signal,
          messages: [createUserMessage({
            content: [{ type: 'text', text: user }],
            source: { kind: 'plugin', plugin: 'dsh-plastic-memory' },
          })],
        })) {
          if (chunk.type === 'text-delta' && typeof chunk.text === 'string') out += chunk.text
        }
        // 宿主可能在取消时正常结束迭代而不抛——循环收尾再判一次，取消一律抛 AbortError。
        if (signal?.aborted) throw signal.reason ?? new DOMException('memory_scan cancelled', 'AbortError')
        return out
      },
    }
  }

  // 工具执行上下文：从 exec.agent.session 取 session 与 workspace（session.log 私有，用 events）
  async function resolveContext(exec: unknown) {
    const agent = (exec as { agent?: { session?: { header?: { id?: string; cwd?: string }; events?: unknown[] } } }).agent
    const session = agent?.session
    const events = (session?.events ?? []) as Array<{ type?: string; seq?: number }>
    // 真锚 start：尾部回找最后一个 turn/start（触发本次保存的当轮），找不到兜底 0（整会话）
    let turnStartSeq = 0
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i]?.type === 'turn/start') {
        turnStartSeq = typeof events[i].seq === 'number' ? events[i].seq! : i
        break
      }
    }
    return {
      workspacePath: await resolveWorkspacePath(ctx, session?.header?.cwd),
      session: {
        id: session?.header?.id ?? 'unknown',
        // 与 turnStartSeq 同口径优先取末事件的 seq，防宿主 seq 契约变化（现契约 seq === 下标）
        lastSeq: typeof events[events.length - 1]?.seq === 'number' ? events[events.length - 1]!.seq! : Math.max(events.length - 1, 0),
        turnStartSeq,
      },
    }
  }

  ctx.tools.register(withRefresh(createSaveTool({ store, registry, resolveContext, snapshots })))
  ctx.tools.register(withRefresh(createSearchTool({ store, registry, resolveContext })))
  ctx.tools.register(withRefresh(createForgetTool({ store, snapshots, decisions, log: ctx.logger })))
  // 快照的写入与恢复必须成对——治理关闭时 forget 仍会拍快照，若没有恢复入口，
  // 14 天的快照就是死存储。故 memory_snapshot 放在治理开关之外，与 forget 一起常驻。
  ctx.tools.register(withRefresh(createSnapshotTool({ store, snapshots })))
  // memory_source：证据下钻（日常 + 治理都用，常驻）。sessionQuery 是 base bundle 默认服务，
  // 但按 llm 同款惯例 per-call 探测 + try/catch——某些 profile 缺席时工具内优雅降级，不挂载失败。
  ctx.tools.register(withRefresh(createSourceTool({
    store, resolveContext,
    getReadEvent: () => {
      try {
        const sq = ctx.get('sessionQuery') as { readEvent?: ReadEventFn } | undefined
        return sq?.readEvent ? sq.readEvent.bind(sq) as ReadEventFn : null
      } catch {
        return null
      }
    },
  })))
  if (config.governance.enabled) {
    ctx.tools.register(withRefresh(createConfirmTool({ store, decisions, snapshots })))
    // 基线按触发调用的 session 取（BaselineCache 按 session 隔离，防多会话串台）
    const sessionOf = (exec: unknown): object | undefined =>
      (exec as { agent?: { session?: object } } | undefined)?.agent?.session
    ctx.tools.register(withRefresh(createScanTool({
      store, registry, decisions, cache: scanCache,
      getBaseline: exec => baseline.get(sessionOf(exec) as (object & { events?: unknown[] }) | undefined),
      // exec → { session, agentOptions } 的小 helper：makeSemanticLlm 本体不再触碰 exec 形状。
      getLlm: exec => {
        const agent = (exec as {
          agent?: {
            session?: { requestHeader?: () => { config?: { provider?: string; model?: string } } | undefined }
            options?: { provider?: string; model?: string }
          }
        }).agent
        return makeSemanticLlm({ session: agent?.session, agentOptions: agent?.options })
      },
      getQuarantined: () => fileTable.quarantined(),
      memoryRoot,
      resolveContext,
    })))
    ctx.tools.register(withRefresh(createHealthTool({
      store, registry, decisions, cache: scanCache,
      thresholds: resolveHealthThresholds(config.governance.health.sensitivity),
      getQuarantined: () => fileTable.quarantined(),
      memoryRoot,
      resolveContext,
    })))
    // memory_promote：把用户确认的候选提升 global。确认由模型先调 ask_user_question 完成
    // （工具内部弹 userQuestions 会被 web 会话拒绝 "requires agent-owned session"），本工具纯执行。
    // AGENTS.md 位置从 DSH_HOME 独立解析（不从 memoryRoot 反推——自定义 root 时会指向 dsh 不读的文件）
    const agentsMd = createAgentsMdWriter(agentsMdPath())
    const defaultTarget: PromoteTarget = config.governance.globalPromoteTarget === 'agents-md' ? 'agents-md' : 'global'
    ctx.tools.register(withRefresh(createPromoteTool({ store, agentsMd, snapshots, defaultTarget })))
  }

  // frozen snapshot：按 session 隔离缓存，session/created 异步解析 workspace，compaction 结束失效重建。
  // session/* 事件由常驻的 @deepseek-ai/dsh-session 提供，但其 cordis Events 增广不在本插件的
  // 类型图内（该包非直接依赖），故按最小结构签名订阅；运行时事件名只是字符串，行为不受影响。
  const lifecycle = ctx as unknown as {
    on(name: 'session/created', fn: (session: SessionLike) => void): () => void
    on(name: 'session/event', fn: (session: object, event: { type: string }) => void): () => void
  }
  lifecycle.on('session/created', session => {
    // eager 预热：新 session 不必等首次 render 才解析 workspace（HMR 后存量 session 走 render 侧自愈）。
    // 走 awaitResolved 的共享入口，与 assemble 中间件同一份 memoize，不重复解析。
    void snapshotCache.awaitResolved(session)
  })
  lifecycle.on('session/event', (session, event) => {
    // 基线已改按需从 session.events 推导（BaselineCache.get），不再观察 session/event；
    // 本监听只留 compaction 失效——快照按 session 冻结，压缩结束后须重建。
    if (event.type === 'compaction/end') snapshotCache.invalidate(session)
  })
  // 首轮竞态根治：workspace 解析是异步 I/O，text provider 是同步回调，且宿主在跑
  // assemble waterfall【之前】就已物化全部 provider 文本——解析没赶上时冷快照已经
  // 在 assembly 里了。故在 waterfall（异步）中等解析落定后，把本插件那条 context
  // 的文本原位替换为热渲染；超时按原冷文本放行（降级语义不变），不阻塞宿主。
  ctx.on('system-prompt/assemble', async (assembly: PromptAssembly, assembleCtx: AssembleContext, next: () => Promise<PromptAssembly>) => {
    const session = (assembleCtx?.scope as { session?: object } | undefined)?.session
    if (session) {
      await snapshotCache.awaitResolved(session)
      for (const entry of assembly.contexts) {
        if (entry.name === 'plastic-memory') entry.text = snapshotCache.render(session)
      }
    }
    return next()
  })
  ctx.systemPrompt.context({
    name: 'plastic-memory',
    order: 50,
    // AssembleContext.scope 是发起组装的 Agent，从它拿到所属 session，按 session 渲染各自的冻结快照
    text: (assembleCtx?: AssembleContext) => {
      const session = (assembleCtx?.scope as { session?: object } | undefined)?.session
      return session ? snapshotCache.render(session) : ''
    },
  })
}
