import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import type { AssembleContext, PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import type { MemoryTypeDefinition } from './types.ts'
import { buildTypeRegistry } from './type-registry.ts'
import { memoryDomainSpec } from './domain-spec.ts'
import { MemoryStore } from './store.ts'
import { FileTable } from './storage/file-table.ts'
import { SidecarStore, type LegacyKvTables } from './storage/sidecar.ts'
import { resolveMemoryRoot } from './storage/paths.ts'
import { formatIndexLine } from './index-line.ts'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { Session } from '@deepseek-ai/dsh-session'
// dsh-agent 的类型增广把 turnBoundary 键登记进投影状态表；stateOf(session, 'turnBoundary') 因此按宿主真实键表校验。
import type {} from '@deepseek-ai/dsh-agent'
import type { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
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
import { delegationDepthOf, gateSubagentWrites } from './tools/subagent-gate.ts'
import type { ReadEventFn } from './tools/source.ts'
import { SnapshotCache, resolveWorkspacePath } from './runtime.ts'
import { PROMPT_LBRACE_VARIABLE } from './snapshot.ts'
import { OVERFLOW_MODES, type OverflowMode } from './contract-codes.ts'
import { resolveHealthThresholds, type HealthSensitivity } from './governance/health-presets.ts'
import { PendingDecisionsStore } from './governance/decisions.ts'
import { SnapshotStore } from './governance/snapshots.ts'
import { memorySnapshotSchema, pendingDecisionSchema, scanCacheSchema } from './governance/schema.ts'
import type { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { baselineProjectionDefinition, readBaseline } from './governance/baseline.ts'
import type { SemanticLlm } from './governance/semantic-scan.ts'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { createMemoryCommand, type MemoryCommandDefinition } from './gui/commands.ts'
import { ViewWriter, collectGlobalViews } from './gui/view-writer.ts'

export interface Config {
  // reflective（会话结束/空闲时批量提取）是规划中的第二写入模式；实现时再回 schema 加回该取值
  // 及其参数（reflectModel 等）——配置面只声明当前真实生效的字段。
  writeMode: 'proactive'
  snapshotTokenBudget: number
  /** 带入量超过 snapshotTokenBudget 时：relax 自动放宽（需要多少带多少，每进一档 25% 提醒一次）、strict 严格按上限（截断，95% 提醒）。 */
  snapshotOverflow: OverflowMode
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
  snapshotOverflow: z.union(OVERFLOW_MODES).default('relax'),
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
export const inject = ['tools', 'systemPrompt']

/** session/created 回调里用得到的最小 session 结构（真实类型是 dsh-session 的 Session）。 */
type SessionLike = object & { header?: { cwd?: string } }

export async function apply(ctx: Context, config: Config) {
  const registry = buildTypeRegistry(config) // 重名内置类型在这里抛错，加载即失败

  const memoryRoot = resolveMemoryRoot(config.memoryRoot)
  // 侧表（快照、待决账本、扫描缓存、召回统计）住 <memoryRoot>/.state/，构造不做 I/O。
  // storageDomain 不再是必需注入：只为首次侧表访问时导入旧 KV 的快照与待决账本（0.3.0 移除）。
  // 按 llm / sessionQuery 同款惯例经 ctx.get 探测，且推迟到导入真正发生时——apply 期间宿主的
  // storageDomain 未必已挂上，此刻探测落空会写下 source: none 的标记，旧数据就再也不导了。
  const sidecar = new SidecarStore({
    root: memoryRoot,
    schemas: { snapshots: memorySnapshotSchema, pending: pendingDecisionSchema, scanCache: scanCacheSchema },
    openLegacyKv: async (): Promise<LegacyKvTables | undefined> => {
      let facility: DomainFacility | undefined
      try {
        facility = ctx.get('storageDomain') as DomainFacility | undefined
      } catch {
        return undefined // ctx.get 按 cordis 现契约不抛；防御宿主行为变化，按服务缺席处理
      }
      if (facility === undefined) return undefined
      const domain = await facility.open(memoryDomainSpec)
      try {
        return {
          snapshots: [...domain.table('snapshots').entries()],
          pending: [...domain.table('pending_decisions').entries()],
        }
      } finally {
        await domain.close()
      }
    },
    log: ctx.logger,
  })
  // 纯逻辑层（file-table/store/forget）不 import 框架包，日志经 MemoryLogger 注入；
  // ctx.logger 结构上满足该形状（info/warn/error），直接注入，宿主按插件名归因。
  const fileTable = new FileTable({
    root: memoryRoot,
    stats: sidecar.recallStats,
    // 磁盘索引不带陈旧度（静态文件里的时间相对标注会随时间失真），注入侧的陈旧度由 snapshot.ts 计算
    formatIndexLine: (r, file) => formatIndexLine(r, { passive: registry.get(r.type).recall === 'passive', file }),
    log: ctx.logger,
  })
  // 加载期零 I/O：FileTable 构造不碰磁盘，每个操作读它涉及的目录（设计稿 §0）
  const store = new MemoryStore(fileTable, ctx.logger, sidecar.recallStats)
  // forget 的快照先行与待决账本清理需要这两个存储，治理关闭时也接线
  const decisions = new PendingDecisionsStore(sidecar.pending)
  const snapshots = new SnapshotStore(sidecar.snapshots)
  const scanCache = sidecar.scanCache
  // AGENTS.md 基线投影走可选注册：插件的 inject 不列 sessionProjections（精简 profile 可能没有这个服务），
  // 改在 ctx.inject(['sessionProjections'], …) 里注册，这是宿主 registry 文档（dsh-session-projection README）
  // 给出的保留可选注册的写法。disposer 随 child fiber 走，插件卸载键即消失。服务缺席时插件照常挂载，
  // 只是不注册投影：垂直冲突检测跳过，memory_scan 打 baseline-missing。
  ctx.inject(['sessionProjections'], child => void child.sessionProjections.register(baselineProjectionDefinition))
  // cwd → workspace 归属的单一解析路径：SnapshotCache 的 lazy 自愈与 session/created 的 eager 预热共用，
  // 避免两处各写一份 resolveWorkspacePath 调用。
  const resolveWorkspace = (session: object) => resolveWorkspacePath(ctx, (session as SessionLike).header?.cwd)
  // 超限提醒进待决账本（治理关闭时也记：它是待处理里的提醒，不是体检结果）；会话视图的 onFrozen 接线在视图写入那张票
  const snapshotCache = new SnapshotCache({
    store, registry, budget: config.snapshotTokenBudget, overflow: config.snapshotOverflow, overflowLedger: decisions,
    memoryRoot, evidenceLookup: config.evidenceLookup, resolveWorkspace, log: ctx.logger,
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
  //      只累加 type === 'text-delta' 的 chunk。每条流以 finish chunk 收尾：适配器中途抛错会被宿主
  //      折成 finish.reason.kind === 'error'（或 'aborted'），此时即使已收到可解析的文本也按失败处理。
  //   3) 只发一次、不进会话的辅助请求用宿主的 RequestUserInput：只有 role 与 content（ContentBlock[]），
  //      没有 id/source——宿主 0.1.7 起 Auto Review 与 compaction 摘要器同款。请求对象标注为
  //      GenerateOptions，形状由编译器校验。
  const makeSemanticLlm = (input: {
    session?: { requestHeader?: () => { config?: { provider?: string; model?: string } } | undefined }
    agentOptions?: { provider?: string; model?: string }
  }): SemanticLlm | null => {
    // 三层解析本体只看 session/agentOptions 两个形状，exec 形状知识留在调用点的小 helper 里。
    const routed = input.session?.requestHeader?.()?.config
    const provider = routed?.provider ?? input.agentOptions?.provider
    const model = routed?.model ?? input.agentOptions?.model
    if (!provider || !model) return null

    let llm: { stream?: (req: GenerateOptions) => AsyncIterable<StreamChunk> } | undefined
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
        const request: GenerateOptions = {
          provider,
          model,
          system,
          signal,
          messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
        }
        for await (const chunk of llm.stream!(request)) {
          if (chunk.type === 'text-delta') out += chunk.text
          else if (chunk.type === 'finish') {
            // error/aborted 带 failure，照 compaction-basic summarizer 的 finishError 一律拒绝；
            // stop、max-tokens 及未来新增的 kind 不算错误，保留已收文本交给解析判定
            // （与 summarizer 不同，截断的 JSON 解析不过会自然走重试）。
            const reason = chunk.reason
            if (reason.kind === 'error') {
              throw Object.assign(new Error(reason.failure.message), { code: reason.failure.code })
            }
            if (reason.kind === 'aborted') {
              // 宿主报 aborted 时 signal 未必已触发：仍以 AbortError 拒绝，不当成功，也不进重试。
              throw signal?.reason ?? new DOMException(reason.failure.message, 'AbortError')
            }
          }
        }
        // 宿主可能在取消时正常结束迭代而不抛——循环收尾再判一次，取消一律抛 AbortError。
        if (signal?.aborted) throw signal.reason ?? new DOMException('memory_scan cancelled', 'AbortError')
        return out
      },
    }
  }

  // 工具执行上下文：从 exec.agent.session 取 session、workspace 与子 agent 深度（header.delegationDepth）。证据锚的两个数都走宿主
  // 0.1.5 起的明码标价读法（Session 不再暴露整份事件数组）：终点 = session.seq - 1（seq 是下一条
  // 事件的位置，O(1)）；起点 = agent-loop 注册的 turnBoundary 投影里的 openTurnStartSeq
  // （当轮 turn/start 的 seq，宿主按事件增量折叠，不重扫日志）。
  async function resolveContext(exec: ToolRunContext) {
    const session = exec.agent?.session
    return {
      workspacePath: await resolveWorkspacePath(ctx, session?.header.cwd),
      delegationDepth: delegationDepthOf(session),
      session: {
        id: session?.header.id ?? 'unknown',
        lastSeq: session ? Math.max(session.seq - 1, 0) : 0,
        turnStartSeq: session ? openTurnStartSeq(session) : 0,
      },
    }
  }

  /** 当轮 turn/start 的 seq；拿不到一律 0（整会话锚）。sessionProjections 按调用经 ctx.get 探测
   *  （与 llm、sessionQuery 同款惯例，不进 inject）。服务缺席（如 sdk-minimal 这类不带 agent-loop 的
   *  profile）、投影未注册、工具执行时却没有开着的轮、投影读取抛错，都退回整会话锚——但退化不能悄无声息：
   *  每个 session 第一次退化时打 warn 留痕（之后同一 session 不再重复）。 */
  const anchorFallbackWarned = new WeakSet<Session>()
  function openTurnStartSeq(session: Session): number {
    let reason: string
    try {
      const projections = ctx.get('sessionProjections') as SessionProjectionRegistry | undefined
      if (projections === undefined) {
        reason = 'sessionProjections service is absent'
      } else {
        const turn = projections.stateOf(session, 'turnBoundary')
        if (turn === undefined) reason = 'turnBoundary projection is not registered'
        else if (typeof turn.openTurnStartSeq === 'number') return turn.openTurnStartSeq
        else reason = `openTurnStartSeq is ${String(turn.openTurnStartSeq)} (no open turn)`
      }
    } catch (error) {
      reason = `projection read threw: ${String(error)}`
    }
    if (!anchorFallbackWarned.has(session)) {
      anchorFallbackWarned.add(session)
      ctx.logger.warn(`turnBoundary projection unavailable for session "${session.header.id}", anchoring the whole session: ${reason}`)
    }
    return 0
  }

  /** 该 session 当前生效的指令正文（按事件顺序）；null = 没有生效指令，或服务缺席、键未注册、读取抛错
   *  （垂直冲突检测跳过，扫描打 baseline-missing）。探测惯例同 openTurnStartSeq。
   *  状态里的形状漂移按 session 对象、每个 seq 只 warn 一次（插件重载后对历史漂移会再 warn 一次）；
   *  读取抛错每个 session 也只 warn 一次。 */
  const baselineDriftWarned = new WeakMap<Session, Set<number>>()
  const baselineReadWarned = new WeakSet<Session>()
  function sessionBaseline(session: Session | undefined): readonly string[] | null {
    if (session === undefined) return null
    let projections: SessionProjectionRegistry | undefined
    try {
      projections = ctx.get('sessionProjections') as SessionProjectionRegistry | undefined
    } catch {
      return null
    }
    let state
    try {
      state = projections?.stateOf(session, 'plasticMemoryBaseline')
    } catch (error) {
      if (!baselineReadWarned.has(session)) {
        baselineReadWarned.add(session)
        ctx.logger.warn(`plasticMemoryBaseline projection read threw for session "${session.header.id}", skipping the AGENTS.md baseline: ${String(error)}`)
      }
      return null
    }
    if (state === undefined) return null
    let warned = baselineDriftWarned.get(session)
    if (warned === undefined) baselineDriftWarned.set(session, warned = new Set())
    const { texts, warnings } = readBaseline(state, warned)
    for (const message of warnings) ctx.logger.warn(message)
    return texts.length === 0 ? null : texts
  }

  // 语义层模型与基线都按触发调用的 agent 取：memory_scan 与 /memory scan（借来的会话）共用
  const getLlm = (exec: ToolRunContext) => makeSemanticLlm({ session: exec.agent?.session, agentOptions: exec.agent?.options })
  const getBaseline = (exec: ToolRunContext) => sessionBaseline(exec.agent?.session)
  // AGENTS.md 位置从 DSH_HOME 独立解析（不从 memoryRoot 反推——自定义 root 时会指向 dsh 不读的文件）；
  // memory_promote 与 /memory promote 共用一个写入器（进程内串行）
  const agentsMd = createAgentsMdWriter(agentsMdPath())

  // 子 agent 只读门：写入与治理工具在注册处统一套门，子 agent 会话（delegationDepth ≥ 1）调用即拒
  const registerWrite = (tool: ToolDefinition) => ctx.tools.register(gateSubagentWrites(tool, resolveContext))
  registerWrite(createSaveTool({ store, registry, resolveContext, snapshots }))
  ctx.tools.register(createSearchTool({ store, registry, resolveContext }))
  registerWrite(createForgetTool({ store, snapshots, decisions, log: ctx.logger, resolveContext }))
  // 快照的写入与恢复必须成对——治理关闭时 forget 仍会拍快照，若没有恢复入口，
  // 14 天的快照就是死存储。故 memory_snapshot 放在治理开关之外，与 forget 一起常驻。
  registerWrite(createSnapshotTool({ store, snapshots, resolveContext }))
  // memory_source：证据下钻（日常 + 治理都用，常驻）。sessionQuery 是 base bundle 默认服务，
  // 但按 llm 同款惯例 per-call 探测 + try/catch——某些 profile 缺席时工具内优雅降级，不挂载失败。
  ctx.tools.register(createSourceTool({
    store, resolveContext,
    getReadEvent: () => {
      try {
        const sq = ctx.get('sessionQuery') as { readEvent?: ReadEventFn } | undefined
        return sq?.readEvent ? sq.readEvent.bind(sq) as ReadEventFn : null
      } catch {
        return null
      }
    },
  }))
  if (config.governance.enabled) {
    registerWrite(createConfirmTool({ store, decisions, snapshots, resolveContext }))
    // 基线按触发调用的 session 取（宿主投影 cell 按 session 隔离，防多会话串台）。
    // 扫描会写语义缓存、登记待决冲突，归写工具；health 纯读，不套门
    registerWrite(createScanTool({
      store, registry, decisions, cache: scanCache,
      getBaseline,
      getLlm,
      resolveContext,
    }))
    ctx.tools.register(createHealthTool({
      store, registry, decisions, cache: scanCache,
      thresholds: resolveHealthThresholds(config.governance.health.sensitivity),
      resolveContext,
    }))
    // memory_promote：把用户确认的候选提升 global。确认由模型先调 ask_user_question 完成
    // （工具内部弹 userQuestions 会被 web 会话拒绝 "requires agent-owned session"），本工具纯执行。
    const defaultTarget: PromoteTarget = config.governance.globalPromoteTarget === 'agents-md' ? 'agents-md' : 'global'
    registerWrite(createPromoteTool({ store, agentsMd, snapshots, defaultTarget, resolveContext }))
  }

  // GUI（浏览器半侧）的动作通道：/memory 命令走可选注册，旧宿主没有 commands 服务时插件照常挂载、不注册、不报错。
  // 加载期不写视图：视图在命令落盘后、refresh-views / scan 时重写（浏览器半侧首次进入发 info 拿路径）。
  ctx.inject(['commands'], child => {
    const commands = (child as unknown as { commands: { register(def: MemoryCommandDefinition): () => void } }).commands
    const views = new ViewWriter({
      memoryRoot, log: ctx.logger,
      collect: () => collectGlobalViews({ store, decisions, cache: scanCache, registry, memoryRoot }),
    })
    commands.register(createMemoryCommand({
      memoryRoot, store, decisions, snapshots, cache: scanCache, registry, agentsMd, views,
      resolveContext, getLlm, getBaseline, log: ctx.logger,
    }))
  })

  // frozen snapshot：按 session 隔离缓存，session/created 异步解析 workspace，compaction 结束标过期、下一次中间件重建。
  // session/* 事件由常驻的 @deepseek-ai/dsh-session 提供，但其 cordis Events 增广不在本插件的
  // 类型图内（该包非直接依赖），故按最小结构签名订阅；运行时事件名只是字符串，行为不受影响。
  const lifecycle = ctx as unknown as {
    on(name: 'session/created', fn: (session: SessionLike) => void): () => void
    on(name: 'session/event', fn: (session: object, event: { type: string }) => void): () => void
  }
  lifecycle.on('session/created', session => {
    // eager 预热：新 session 不必等首次组装才解析 workspace（HMR 后存量 session 走 render 侧自愈）。
    // 与 assemble 中间件的解析等待同一份 memoize，不重复解析；只解析不组装，快照仍在首次中间件组装时冻结。
    snapshotCache.prewarm(session)
  })
  lifecycle.on('session/event', (session, event) => {
    // 基线由宿主投影随事件折叠（plasticMemoryBaseline），不在这里观察；
    // 本监听只留 compaction 过期标记——快照按 session 冻结，压缩结束后由下一次中间件重建；
    // 不清空，宿主只调同步 provider 的 admission refresh 仍拿到上一份快照。
    if (event.type === 'compaction/end') snapshotCache.markStale(session)
  })
  // 快照只在 assemble waterfall（异步）里构建：宿主在跑 waterfall【之前】就已物化全部 provider 文本，
  // 而同步 provider 只回缓存（首轮为空串）。中间件等 workspace 解析落定后组装或复用冻结快照，
  // 把本插件那条 context 的文本原位替换；解析超时走 global-only 临时文本（不冻结），不阻塞宿主。
  ctx.on('system-prompt/assemble', async (assembly: PromptAssembly, assembleCtx: AssembleContext, next: () => Promise<PromptAssembly>) => {
    const session = (assembleCtx?.scope as { session?: object } | undefined)?.session
    if (session) {
      const text = await snapshotCache.assemble(session)
      for (const entry of assembly.contexts) {
        if (entry.name === 'plastic-memory') entry.text = text
      }
    }
    return next()
  })
  // 宿主对 context 文本做 {{变量}} 插值、没有关闭选项，记忆正文又是用户可控内容：
  // 快照出口把 {{ 转义成对这个变量的引用，由宿主插值还原（见 snapshot.ts escapePromptBraces）。
  ctx.systemPrompt.variable(PROMPT_LBRACE_VARIABLE, () => '{{')
  ctx.systemPrompt.context({
    name: 'plastic-memory',
    order: 50,
    // AssembleContext.scope 是发起组装的 Agent，从它拿到所属 session，只回该 session 的冻结快照（无则空串）
    text: (assembleCtx?: AssembleContext) => {
      const session = (assembleCtx?.scope as { session?: object } | undefined)?.session
      return session ? snapshotCache.render(session) : ''
    },
  })
}
