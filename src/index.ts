import z from '@deepseek-ai/schemastery'
import type { Context, Volatile } from '@deepseek-ai/cordis'
import type { MemoryTypeDefinition } from './types.ts'
import { buildTypeRegistry, type TypeRegistry } from './type-registry.ts'
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
import { lastVisibleSnapshot, shouldSendSnapshot, snapshotMessageBody } from './snapshot-message.ts'
import { OVERFLOW_MODES, type OverflowMode } from './contract-codes.ts'
import { resolveHealthThresholds, type HealthSensitivity } from './governance/health-presets.ts'
import { PendingDecisionsStore, overflowScopeOf } from './governance/decisions.ts'
import { SnapshotStore } from './governance/snapshots.ts'
import { AdviceIgnoreStore } from './governance/advice-ignores.ts'
import { CheckupRecordStore } from './governance/checkup-records.ts'
import { AutoCheckupSettingStore } from './governance/auto-checkups.ts'
import { adviceIgnoreSchema, memorySnapshotSchema, pendingDecisionSchema, scanCacheSchema } from './governance/schema.ts'
import type { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { baselineProjectionDefinition, readBaseline } from './governance/baseline.ts'
import type { SemanticLlm } from './governance/semantic-scan.ts'
import { hostSemanticLlm, type HostLlmService, type HostModelRoute } from './governance/host-llm.ts'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { createMemoryCommand, type MemoryCommandDefinition } from './gui/commands.ts'
import { ViewWriter, collectCheckupView, collectGlobalViews } from './gui/view-writer.ts'
import { AutoCheckupScheduler, type AutoCheckupTimer } from './gui/auto-checkup.ts'
import { buildSessionView } from './gui/views.ts'
import type { SessionView } from './gui/contract.ts'

/**
 * 进 GUI 的字段标 `.volatile()`：插件页或 yaml 改了它们，宿主 Loader 把新值写进运行中的引用、发 `loader/volatile-update`，
 * 不重挂插件。这些字段一律用时 `.get()`，不把值留到下一次操作。writeMode、memoryRoot 不进 GUI，改了照旧重挂。
 */
export interface Config {
  // reflective（会话结束/空闲时批量提取）是规划中的第二写入模式；实现时再回 schema 加回该取值
  // 及其参数（reflectModel 等）——配置面只声明当前真实生效的字段。
  writeMode: 'proactive'
  snapshotTokenBudget: Volatile<number>
  /** 带入量超过 snapshotTokenBudget 时：relax 自动放宽（需要多少带多少，每进一档 25% 提醒一次）、strict 严格按上限（截断，95% 提醒）。 */
  snapshotOverflow: Volatile<OverflowMode>
  /** 证据下钻档位（docs/design-evidence-anchor.md §4）：off 不鼓励回查原始轨迹、strict 仅硬信号、active 开放路标式引导。 */
  evidenceLookup: Volatile<'off' | 'strict' | 'active'>
  template: Volatile<'coding' | 'office' | 'custom'>
  customTypes: Volatile<Record<string, Omit<MemoryTypeDefinition, 'name'>>>
  governance: {
    enabled: Volatile<boolean>
    health: { sensitivity: Volatile<HealthSensitivity> }
    globalPromoteTarget: Volatile<'plugin-global' | 'agents-md'>
  }
  search: {
    /** jieba 用户词典（每行「词 词频 词性」）的绝对路径，追加在主词典之上；不设只用主词典。改了下一次搜索生效。 */
    userDictionaryPath: Volatile<string | undefined>
  }
  /** 记忆文件根目录，缺省解析到 ${DSH_HOME:-~/.dsh}/memories（storage/paths.ts） */
  memoryRoot: string
}

export const Config = z.object({
  writeMode: z.const('proactive').default('proactive'),
  snapshotTokenBudget: z.number().default(4000).volatile(),
  snapshotOverflow: z.union(OVERFLOW_MODES).default('relax').volatile(),
  evidenceLookup: z.union(['off', 'strict', 'active'] as const).default('strict').volatile(),
  template: z.union(['coding', 'office', 'custom'] as const).default('coding').volatile(),
  customTypes: z.dict(z.object({
    label: z.string().required(),
    description: z.string().required(),
    whenToSave: z.string().required(),
    recall: z.union(['core', 'search', 'passive'] as const).required(),
    decayDays: z.union([z.number(), z.const(null)]).default(null),
    governancePriority: z.union(['high', 'medium', 'low'] as const).required(),
  })).default({}).volatile(),
  governance: z.object({
    enabled: z.boolean().default(true).volatile(),
    health: z.object({
      sensitivity: z.union(['conservative', 'normal', 'proactive'] as const).default('normal').volatile(),
    }).default({ sensitivity: 'normal' }),
    globalPromoteTarget: z.union(['plugin-global', 'agents-md'] as const).default('plugin-global').volatile(),
  }),
  search: z.object({
    userDictionaryPath: z.string().volatile(),
  }),
  memoryRoot: z.string().default(''),
})

export const name = 'dsh-plastic-memory'
export const inject = ['tools']

/** session/created 回调里用得到的最小 session 结构（真实类型是 dsh-session 的 Session）。 */
type SessionLike = object & { header?: { id?: string; cwd?: string } }

export async function apply(ctx: Context, config: Config) {
  // 插件本次加载的时刻：健康视图带给浏览器半侧，判断冻结快照是否早于这次启动
  const bootedAt = Date.now()
  // 类型表随 template / customTypes 热更新重建；各处拿到的是转发到当前表的同一个对象
  const buildRegistry = () => buildTypeRegistry({ template: config.template.get(), customTypes: config.customTypes.get() })
  let currentRegistry = buildRegistry() // 重名内置类型在这里抛错，加载即失败
  const registry: TypeRegistry = {
    get: name => currentRegistry.get(name),
    has: name => currentRegistry.has(name),
    all: () => currentRegistry.all(),
    renderSaveDescription: () => currentRegistry.renderSaveDescription(),
  }

  const memoryRoot = resolveMemoryRoot(config.memoryRoot)
  // 侧表（快照、待决账本、扫描缓存、召回统计）住 <memoryRoot>/.state/，构造不做 I/O。
  // storageDomain 不再是必需注入：只为首次侧表访问时导入旧 KV 的快照与待决账本（0.3.0 移除）。
  // 按 llm / sessionQuery 同款惯例经 ctx.get 探测，且推迟到导入真正发生时——apply 期间宿主的
  // storageDomain 未必已挂上。探测落空返回 undefined：不写标记，本进程不再探，下次启动重探。
  const sidecar = new SidecarStore({
    root: memoryRoot,
    schemas: { snapshots: memorySnapshotSchema, pending: pendingDecisionSchema, scanCache: scanCacheSchema, adviceIgnores: adviceIgnoreSchema },
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
          // 导入完成后重新打开域，删掉这两张表的全部行
          discard: async () => {
            const again = await facility.open(memoryDomainSpec)
            try {
              for (const name of ['snapshots', 'pending_decisions'] as const) {
                const table = again.table(name)
                for (const key of [...table.keys()]) await table.delete(key)
              }
            } finally {
              await again.close()
            }
          },
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
  // 建议忽略表：健康分、体检、GUI 视图同一份剔除口径
  const ignores = new AdviceIgnoreStore(sidecar.adviceIgnores)
  // 体检记录表：体检做完写完成记录（上次体检），健康分、GUI 视图从它读
  const checkups = new CheckupRecordStore(sidecar.checkups)
  // 自动体检设置表：记忆页经 /memory set-auto-checkup 改，几个宿主进程共用一份
  const autoCheckups = new AutoCheckupSettingStore(sidecar.autoCheckups)
  // AGENTS.md 基线投影走可选注册：插件的 inject 不列 sessionProjections（精简 profile 可能没有这个服务），
  // 改在 ctx.inject(['sessionProjections'], …) 里注册，这是宿主 registry 文档（dsh-session-projection README）
  // 给出的保留可选注册的写法。disposer 随 child fiber 走，插件卸载键即消失。服务缺席时插件照常挂载，
  // 只是不注册投影：垂直冲突检测跳过，memory_scan 打 baseline-missing。
  ctx.inject(['sessionProjections'], child => void child.sessionProjections.register(baselineProjectionDefinition))
  // GUI 视图写入器：宿主有 commands 服务（GUI 半侧可用）时才有，见下方 ctx.inject(['commands'], …)
  let views: ViewWriter | undefined
  // 自动体检调度器：宿主有计时服务时才有，见下方 ctx.inject(['timer'], …)
  let scheduler: AutoCheckupScheduler | undefined
  // 会话归属对照（契约 GUI_WORKSPACE_MAP_FILE）：每次解析都记一笔原始 cwd → 项目；写入器就位前解析到的先留着，就位时补记
  const earlyWorkspaces = new Map<string, string>()
  const resolveCwd = async (cwd: string | undefined) => {
    const workspacePath = await resolveWorkspacePath(ctx, cwd)
    if (cwd && workspacePath !== undefined) {
      if (views) void views.requestWorkspace(cwd, workspacePath)
      else earlyWorkspaces.set(cwd, workspacePath)
    }
    return workspacePath
  }
  // cwd → workspace 归属的单一解析路径：SnapshotCache 的 lazy 自愈与 session/created 的 eager 预热共用，
  // 避免两处各写一份 resolveWorkspacePath 调用。
  const resolveWorkspace = (session: object) => resolveCwd((session as SessionLike).header?.cwd)
  // 会话视图（进程内存）：每个会话最近一次冻结的视图，与这次对话新记的 id（可能早于首次冻结）
  const frozenViews = new Map<string, SessionView>()
  const savedIds = new Map<string, string[]>()
  const onSaved = (sessionId: string, memoryId: string) => {
    if (sessionId === 'unknown') return
    const ids = [...(savedIds.get(sessionId) ?? []), memoryId]
    savedIds.set(sessionId, ids)
    const last = frozenViews.get(sessionId)
    if (last === undefined) return
    const view = { ...last, savedIds: ids }
    frozenViews.set(sessionId, view)
    void views?.requestSession(view)
  }
  // 超限提醒进待决账本（治理关闭时也记：它是待处理里的提醒，不是体检结果）。
  // 上限、超限处理、溯源档位是 getter：每次构建快照时现读配置（SnapshotCache 一次构建只取一次）。
  const snapshotCache = new SnapshotCache({
    store, registry, overflowLedger: decisions, memoryRoot, resolveWorkspace, hasEarlierTurns, log: ctx.logger,
    get budget() { return config.snapshotTokenBudget.get() },
    get overflow() { return config.snapshotOverflow.get() },
    get evidenceLookup() { return config.evidenceLookup.get() },
    onFrozen: (session, { overflowChanged, ...info }) => {
      const sessionId = (session as SessionLike).header?.id
      if (views === undefined || sessionId === undefined) return
      const view = buildSessionView({ sessionId, ...info, savedIds: savedIds.get(sessionId) ?? [] })
      frozenViews.set(sessionId, view)
      // 旁路写入：不拖住快照组装（写失败由写入器记日志）
      void views.requestSession(view)
      if (overflowChanged) void views.request(['pending', 'health'])
    },
  })

  // 语义层模型：按调用构建（provider/model 只能在调用时解析，插件加载时没有），模型调用本身由 governance/host-llm.ts 适配宿主流。
  // 服务一律经 ctx.get 探测而非属性访问——cordis 的 Context 是 proxy，未 inject 的服务名走属性访问会抛错
  // （cannot get property "llm" without inject）；ctx.get 是安全查找，未注册老实返回 undefined
  // （cordis reflect.ts _getImpl），下面的 try/catch 只是对宿主行为变化的防御。
  const probe = <T>(name: string): T | undefined => {
    try {
      return ctx.get(name) as T | undefined
    } catch {
      return undefined
    }
  }
  // 有会话（memory_scan、借用会话的 /memory 命令）：用这个会话的模型。解析顺序对齐宿主 compaction 摘要器：
  // session.requestHeader()?.config（最近一次路由请求的配置）→ agent.options.provider/model；拿不到就是 null，
  // 体检和「让模型改」回 llm-unavailable，不改用默认模型——用户在那个会话里选的模型才是这次该用的。
  const makeSemanticLlm = (input: {
    session?: { requestHeader?: () => { config?: { provider?: string; model?: string } } | undefined }
    agentOptions?: { provider?: string; model?: string }
  }): SemanticLlm | null => {
    const routed = input.session?.requestHeader?.()?.config
    return hostSemanticLlm(probe<HostLlmService>('llm'), {
      provider: routed?.provider ?? input.agentOptions?.provider,
      model: routed?.model ?? input.agentOptions?.model,
    })
  }
  // 无会话（自动体检）：没有会话可借，用宿主的默认模型选择（agentDefaultModel 的当前选择：新建 agent 用它，
  // 用户在对话里换模型时它通常跟着变）。可选依赖，每次开跑现读、不缓存；服务缺席或读取抛错就是 null，自动体检不跑、记「模型用不了」。
  const getDefaultLlm = (): SemanticLlm | null => {
    let route: HostModelRoute | undefined
    try {
      route = probe<{ currentSelection(): HostModelRoute }>('agentDefaultModel')?.currentSelection()
    } catch {
      return null
    }
    return hostSemanticLlm(probe<HostLlmService>('llm'), route)
  }

  // 工具执行上下文：从 exec.agent.session 取 session、workspace 与子 agent 深度（header.delegationDepth）。证据锚的两个数都走宿主
  // 0.1.5 起的明码标价读法（Session 不再暴露整份事件数组）：终点 = session.seq - 1（seq 是下一条
  // 事件的位置，O(1)）；起点 = agent-loop 注册的 turnBoundary 投影里的 openTurnStartSeq
  // （当轮 turn/start 的 seq，宿主按事件增量折叠，不重扫日志）。
  async function resolveContext(exec: ToolRunContext) {
    const session = exec.agent?.session
    return {
      workspacePath: await resolveCwd(session?.header.cwd),
      delegationDepth: delegationDepthOf(session),
      session: {
        id: session?.header.id ?? 'unknown',
        lastSeq: session ? Math.max(session.seq - 1, 0) : 0,
        turnStartSeq: session ? openTurnStartSeq(session) : 0,
        // 宿主 session 对象本身：检索按它找本会话的冻结快照、做召回去重
        ...(session ? { handle: session } : {}),
      },
    }
  }

  /** 会话是否已过了第 1 轮：快照本该在第 1 轮冻结，本实例第一次冻结时已是之后的轮，说明是重启后续上或插件重载。
   *  读 turnBoundary 投影的 lastTurn（宿主按事件增量折叠，不读日志）；服务缺席、投影未注册、读取抛错都按没有。 */
  function hasEarlierTurns(session: object): boolean {
    try {
      const projections = ctx.get('sessionProjections') as SessionProjectionRegistry | undefined
      return (projections?.stateOf(session as Session, 'turnBoundary')?.lastTurn ?? 0) > 1
    } catch {
      return false
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

  // 子 agent 只读门：写入与治理工具在注册处统一套门，子 agent 会话（delegationDepth ≥ 1）调用即拒。
  // 门内的执行结束后（成功、失败都算，失败前可能已写了一部分）请求重写全局视图：模型改了记忆或账本，记忆页跟着变
  const registerWrite = (tool: ToolDefinition) => ctx.tools.register(gateSubagentWrites({
    ...tool,
    execute: async (args, exec) => {
      try {
        return await tool.execute(args, exec)
      } finally {
        void views?.request()
      }
    },
  }, resolveContext))
  // memory_save 的类型枚举与说明在注册时从类型表生成：模板或自定义类型热更新后注销重注册
  const registerSave = () => registerWrite(createSaveTool({ store, registry, resolveContext, snapshots, decisions, onSaved }))
  let disposeSave = registerSave()
  ctx.tools.register(createSearchTool({
    store, registry, resolveContext, sessionRecall: snapshotCache,
    tokenizer: { userDictionaryPath: () => config.search.userDictionaryPath.get(), log: ctx.logger },
  }))
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
  // 体检、健康分、裁决、提升四个工具随体检开关注册 / 注销（开关热更新时再同步一次）。
  // 灵敏度与提升目标不必重注册：工具执行时经 getter 现读配置。
  let governanceTools: Array<() => void> = []
  const syncGovernanceTools = () => {
    for (const dispose of governanceTools.splice(0)) dispose()
    if (!config.governance.enabled.get()) return
    governanceTools = [
      registerWrite(createConfirmTool({ store, decisions, snapshots, resolveContext })),
      // 基线按触发调用的 session 取（宿主投影 cell 按 session 隔离，防多会话串台）。
      // 扫描会写语义缓存、登记待决冲突，归写工具；health 纯读，不套门
      registerWrite(createScanTool({
        store, registry, decisions, cache: scanCache, ignores, checkups,
        getBaseline,
        getLlm,
        resolveContext,
      })),
      ctx.tools.register(createHealthTool({
        store, registry, decisions, cache: scanCache, ignores, checkups, autoCheckups,
        get thresholds() { return resolveHealthThresholds(config.governance.health.sensitivity.get()) },
        resolveContext,
      })),
      // memory_promote：把用户确认的候选提升 global。确认由模型先调 ask_user_question 完成
      // （工具内部弹 userQuestions 会被 web 会话拒绝 "requires agent-owned session"），本工具纯执行。
      registerWrite(createPromoteTool({
        store, agentsMd, snapshots, resolveContext,
        get defaultTarget(): PromoteTarget { return config.governance.globalPromoteTarget.get() === 'agents-md' ? 'agents-md' : 'global' },
      })),
    ]
  }
  syncGovernanceTools()

  // GUI（浏览器半侧）的动作通道：/memory 命令走可选注册，旧宿主没有 commands 服务时插件照常挂载、不注册、不报错。
  // 首次视图写入推迟到第一个 session/created（见下方）：apply 期间读账本会触发旧 KV 导入探测，
  // 那时 storageDomain 未必挂上；而没有任何会话时浏览器半侧也读不到视图，早写没有意义。
  // 体检视图与自动体检调度共用的读法：设置表、完成记录、目录清单，不读记忆文件
  const checkupSource = { store, checkups, autoCheckups, cache: scanCache, isGovernanceEnabled: () => config.governance.enabled.get() }
  ctx.inject(['commands'], child => {
    const commands = (child as unknown as { commands: { register(def: MemoryCommandDefinition): () => void } }).commands
    const writer = new ViewWriter({
      memoryRoot, log: ctx.logger,
      collect: () => collectGlobalViews({
        store, decisions, snapshots, cache: scanCache, ignores, checkups, autoCheckups, registry, memoryRoot, isGovernanceEnabled: () => config.governance.enabled.get(), bootedAt, log: ctx.logger,
      }),
      collectCheckups: () => collectCheckupView(checkupSource),
    })
    views = writer
    for (const [cwd, workspacePath] of earlyWorkspaces) void writer.requestWorkspace(cwd, workspacePath)
    earlyWorkspaces.clear()
    commands.register(createMemoryCommand({
      memoryRoot, store, decisions, snapshots, cache: scanCache, checkups, autoCheckups, ignores, registry, agentsMd, views: writer,
      onAutoCheckupChanged: () => void scheduler?.recheck(),
      resolveContext, getLlm, getBaseline, log: ctx.logger,
      isGovernanceEnabled: () => config.governance.enabled.get(),
    }))
    // 卸载时（插件重载、commands 服务撤下）停写视图：cordis 卸载会 await 这个 disposer，
    // 进行中的写入落完才轮到新实例加载，旧实例的迟到写入不会盖掉新视图
    return async () => {
      if (views === writer) views = undefined
      await writer.dispose()
    }
  })
  let startupViewsPending = true

  // 自动体检调度：宿主有计时服务时才有（可选注册，同 commands）。计时器挂在 child 上，插件卸载时宿主停掉它们；
  // disposer 再取消正在跑的体检并等它收尾。无会话，用宿主默认模型（getDefaultLlm）。
  ctx.inject(['timer'], child => {
    const timer = child as unknown as AutoCheckupTimer
    const created = new AutoCheckupScheduler({
      scan: { store, registry, decisions, cache: scanCache, ignores },
      checkups,
      status: () => collectCheckupView(checkupSource),
      getDefaultLlm,
      isGovernanceEnabled: () => config.governance.enabled.get(),
      timer: { timeout: (callback, delayMs) => timer.timeout(callback, delayMs), interval: (callback, delayMs) => timer.interval(callback, delayMs) },
      onChecked: async () => { await views?.requestCheckups() },
      onClaimChanged: async () => { await views?.requestCheckups() },
      // 自动体检挂了账、写了完成记录：待处理、健康和体检视图都重写
      onScanned: async () => { await views?.request() },
      now: () => Date.now(),
      log: ctx.logger,
    })
    scheduler = created
    created.start()
    return async () => {
      if (scheduler === created) scheduler = undefined
      await created.dispose()
    }
  })

  // 配置热生效：宿主只在 volatile 字段变化时发本事件（载荷是变化路径，如 [['governance', 'enabled']]），已提交的新值经 .get() 读到。
  // 所有会话的快照标过期（宿主每一步都组装，同一轮的下一步就按新配置重建），按变化项重注册工具，最后重写视图。
  // 事件的 Events 增广在 @deepseek-ai/cordis-plugin-loader（非直接依赖），按最小结构签名订阅，同下方 session/* 事件。
  const loaderEvents = ctx as unknown as {
    on(name: 'loader/volatile-update', fn: (paths: readonly (readonly string[])[]) => Promise<void>): () => void
  }
  loaderEvents.on('loader/volatile-update', async paths => {
    const changed = (...keys: string[]) => paths.some(path => keys.includes(path.join('.')))
    if (changed('template', 'customTypes')) {
      try {
        currentRegistry = buildRegistry()
        disposeSave()
        disposeSave = registerSave()
      } catch (err) {
        // 自定义类型与内置重名：保留原类型表与 memory_save，等配置改对
        ctx.logger.error('[plastic-memory] 类型配置热更新失败，沿用原类型表:', err)
      }
    }
    if (changed('governance.enabled')) syncGovernanceTools()
    // search.userDictionaryPath 不用在这里处理：memory_search 每次现读路径，变了下一次搜索就重建分词实例
    snapshotCache.markAllStale()
    // 改了上限或超限处理：已有的超限提醒按新配置当场重算（调高上限后不再提醒，档位按新上限算），重写视图时就是新结果
    if (changed('snapshotTokenBudget', 'snapshotOverflow')) {
      try {
        const scopes = (await decisions.listOverflow()).map(overflowScopeOf).filter(s => s !== undefined)
        await snapshotCache.resyncOverflow(scopes)
      } catch (err) {
        ctx.logger.error('[plastic-memory] 按新上限重算超限提醒失败:', err)
      }
    }
    await views?.rewriteAll()
    // 体检开关变了：自动体检立刻重算（打开时到期的范围马上开始查）
    if (changed('governance.enabled')) void scheduler?.recheck()
  })

  // frozen snapshot：按 session 隔离缓存，session/created 异步解析 workspace，compaction 结束标过期、下一次组装重建。
  // session/* 事件由常驻的 @deepseek-ai/dsh-session 提供，但其 cordis Events 增广不在本插件的
  // 类型图内（该包非直接依赖），故按最小结构签名订阅；运行时事件名只是字符串，行为不受影响。
  const lifecycle = ctx as unknown as {
    on(name: 'session/created', fn: (session: SessionLike) => void): () => void
    on(name: 'session/event', fn: (session: object, event: { type: string; time?: number; data?: unknown }) => void): () => void
  }
  lifecycle.on('session/created', session => {
    // eager 预热：新 session 不必等首次组装才解析 workspace（HMR 后存量 session 由组装入口自愈）。
    // 与组装入口的解析等待同一份 memoize，不重复解析；只解析不组装，快照仍在首个发送点冻结。
    snapshotCache.prewarm(session)
    // 第一个会话出现时写一遍全局视图（不 await）：浏览器半侧首次打开记忆页要有内容；此时宿主已挂好 storageDomain。
    if (startupViewsPending && views) {
      startupViewsPending = false
      void views.request()
    }
  })
  lifecycle.on('session/event', (session, event) => {
    // 基线由宿主投影随事件折叠（plasticMemoryBaseline），不在这里观察；
    // 本监听只留 compaction 过期标记——快照按 session 冻结，压缩结束后由下一个发送点重建。
    // 带 error 的结束是失败的压缩（如摘要不比被遮蔽内容小），什么都没遮蔽：旧快照还在可见面上，
    // 这时重建会让下一个发送点再发一份；阈值附近它几乎每步失败一次，所以只在成功时标过期。
    // error 在事件的 data 里（compaction-basic 以 `{ ...lifecycle, error }` 作为 payload append）。
    // 成功的压缩记下压缩时刻（markCompacted），下一次冻结记为压缩后重新带入。
    if (event.type !== 'compaction/end') return
    if ((event.data as { error?: unknown } | undefined)?.error !== undefined) return
    snapshotCache.markCompacted(session, typeof event.time === 'number' ? event.time : Date.now())
  })
  // 快照走本插件自己的 user 消息（source 为 plastic-memory 的 snapshot 形态），不经宿主的运行时上下文：
  // 那里各插件的段落拼成一条消息，任何一段变了就整条再发一次，本插件没变的快照也跟着多一份；极简模式还会把它整段压掉。
  // 发送点只有下面两处，组装（冻结、计召回、会话视图）也只在这里发生，所以冻结即模型可见。
  // 发不发看会话里模型最后能看到的那份快照：组装出的文本与它逐字相同就不发，前缀不动；
  // 压缩遮蔽了旧快照、记忆改过、配置热更新后，文本不同才补发一份，取代句告诉模型以最新这份为准。
  const snapshotMessage = async (session: Session): Promise<UserMessage | undefined> => {
    const text = await snapshotCache.assemble(session)
    return shouldSendSnapshot(text, lastVisibleSnapshot(session.deriveMessages())) ? createUserMessage(snapshotMessageBody(text)) : undefined
  }
  const appendSnapshot = (session: Session, message: UserMessage) => {
    try {
      session.append('user/message', message, { surfaceOp: 'append' })
    } catch (err) {
      ctx.logger.error('[plastic-memory] 快照消息写入会话失败:', err)
    }
  }
  // pre-step：等 next() 返回（compaction-basic 在里面压缩）再判断，补发的就排在 checkpoint 之后。
  // 快照必须排在系统提示词之后：宿主的压缩起点、node 0 保护、请求序列化都认定 node 0 是系统提示词，
  // 而新会话的系统提示词要到 step 里才写，晚于 pre-step。所以分三路：
  // decision 带消息：快照放进 decision 最前，宿主在 step 里先写系统提示词、再写 decision，快照落在两者之间；
  // 第 1 步且 decision 为空：宿主这一步本来就不调模型，塞快照会凭空发起一次只有快照的调用，不组装也不发；
  // 之后的空 decision：系统提示词已在 node 0，直接追加到会话尾部。
  // prepend 让本监听排在最外层，不依赖插件加载顺序。
  ctx.on('agent/pre-step', async ({ agent, step, signal }, next) => {
    const decision = await next()
    if (decision.kind !== 'enter' || signal.aborted) return decision
    if (decision.messages.length === 0 && step === 1) return decision
    const message = await snapshotMessage(agent.session)
    if (message === undefined) return decision
    if (decision.messages.length > 0) return { ...decision, messages: [message, ...decision.messages] }
    appendSnapshot(agent.session, message)
    return decision
  }, { prepend: true })
  // 溢出恢复：compaction-basic 压缩后返回 retry，同一步重试前不再经过 pre-step；只在重试时补发。
  // 也要 prepend：compaction-basic 恢复时直接返回 retry、不调 next()，排在它里层就看不到这次重试。
  ctx.on('agent/request-error', async ({ agent, signal }, next) => {
    const action = await next()
    if (action?.kind === 'retry' && !signal.aborted) {
      const message = await snapshotMessage(agent.session)
      if (message !== undefined) appendSnapshot(agent.session, message)
    }
    return action
  }, { prepend: true })
}
