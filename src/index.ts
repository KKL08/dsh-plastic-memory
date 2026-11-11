import z from '@deepseek-ai/schemastery'
import type { Context, Volatile } from '@deepseek-ai/cordis'
import type { MemoryTypeDefinition } from './types.ts'
import { buildTypeRegistry, PRESET_SCENES, type SceneConfig, type TypeRegistry } from './type-registry.ts'
import { memoryDomainSpec } from './domain-spec.ts'
import { MemoryStore } from './store.ts'
import { FileTable } from './storage/file-table.ts'
import { SidecarStore } from './storage/sidecar.ts'
import type { LegacyKvTables } from './storage/legacy-kv-import.ts'
import { resolveMemoryRoot } from './storage/paths.ts'
import { formatIndexLine } from './index-line.ts'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { Session } from '@deepseek-ai/dsh-session'
import { SUBAGENT_MAX_SAVES_DEFAULT } from './pipeline.ts'
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
import { gateSubagentWrites } from './tools/subagent-gate.ts'
import { UNKNOWN_SESSION_ID } from './tools/host-session.ts'
import { createCordisHostSession } from './cordis-host-session.ts'
import { goneCopies } from './tools/workspace-gate.ts'
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
import { baselineProjectionDefinition } from './governance/baseline.ts'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { createMemoryCommand, type MemoryCommandDefinition } from './gui/commands.ts'
import { ViewWriter, collectCheckupView, collectGlobalViews } from './gui/view-writer.ts'
import { AutoCheckupScheduler, type AutoCheckupTimer } from './gui/auto-checkup.ts'
import { buildSessionView } from './gui/views.ts'
import { ACCENTS, type Accent, type SessionView } from './gui/contract.ts'

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
  /** 证据下钻档位（模型什么时候回查记忆出处的原始对话）：off 不鼓励回查原始轨迹、strict 仅硬信号、active 开放路标式引导。 */
  evidenceLookup: Volatile<'off' | 'strict' | 'active'>
  /** 当前场景 id：custom（通用，沿用旧模板值）/ coding / office / 自定义场景 id。 */
  template: Volatile<string>
  /** 类型池里的自建类型；勾进场景才会用来新增记忆。 */
  customTypes: Volatile<Record<string, Omit<MemoryTypeDefinition, 'name'>>>
  /** 编码、办公与自定义场景（通用场景固定内置五类，不在这里）。 */
  scenes: Volatile<Record<string, SceneConfig>>
  /** 删掉的预设类型：不进类型池，已有记忆按出厂定义读。改过的预设是 customTypes 里的同名一项。 */
  removedPresetTypes: Volatile<string[]>
  governance: {
    enabled: Volatile<boolean>
    health: { sensitivity: Volatile<HealthSensitivity> }
    globalPromoteTarget: Volatile<'plugin-global' | 'agents-md'>
  }
  search: {
    /** jieba 用户词典（每行「词 词频 词性」）的绝对路径，追加在主词典之上；不设只用主词典。改了下一次搜索生效。 */
    userDictionaryPath: Volatile<string | undefined>
  }
  subagent: {
    /** 每个子会话最多新建几条记忆（只拦 create，按本会话已存条数现数）。设置页不露，配置文件可改；改了下一次保存生效。 */
    maxSavesPerSession: Volatile<number>
  }
  /** 界面主题色（服务端不读，只供设置页写、各面板读）。 */
  accent: Volatile<Accent>
  /** 记忆文件根目录，缺省解析到 ${DSH_HOME:-~/.dsh}/memories（storage/paths.ts） */
  memoryRoot: string
}

export const Config = z.object({
  writeMode: z.const('proactive').default('proactive'),
  snapshotTokenBudget: z.number().default(4000).volatile(),
  snapshotOverflow: z.union(OVERFLOW_MODES).default('relax').volatile(),
  evidenceLookup: z.union(['off', 'strict', 'active'] as const).default('strict').volatile(),
  template: z.string().default('coding').volatile(),
  customTypes: z.dict(z.object({
    label: z.string().required(),
    description: z.string().required(),
    whenToSave: z.string().required(),
    howToUse: z.string(),
    recall: z.union(['core', 'search', 'passive'] as const).required(),
    decayDays: z.union([z.number(), z.const(null)]).default(null),
    governancePriority: z.union(['high', 'medium', 'low'] as const).required(),
  })).default({}).volatile(),
  scenes: z.dict(z.object({
    label: z.string().required(),
    types: z.array(z.string()).required(),
  })).default(PRESET_SCENES).volatile(),
  // 不用 union 校验名字：预设名单以后变了，老配置照样能加载（类型表忽略不认识的并警告）
  removedPresetTypes: z.array(z.string()).default([]).volatile(),
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
  subagent: z.object({
    maxSavesPerSession: z.number().default(SUBAGENT_MAX_SAVES_DEFAULT).volatile(),
  }),
  accent: z.union(ACCENTS).default('ella').volatile(),
  memoryRoot: z.string().default(''),
})

export const name = 'dsh-plastic-memory'
export const inject = ['tools']

/** session/created 回调里用得到的最小 session 结构（真实类型是 dsh-session 的 Session）。 */
type SessionLike = object & { header?: { id?: string; cwd?: string; delegationDepth?: number; parentSession?: string } }

export async function apply(ctx: Context, config: Config) {
  // 插件本次加载的时刻：健康视图带给右侧栏，判断冻结快照是否早于这次启动
  const bootedAt = Date.now()
  // 类型表随 template / customTypes / scenes / removedPresetTypes 热更新重建；各处拿到的是转发到当前表的同一个对象。
  // 场景配置写错只警告（按通用或截断运行），不让插件加载失败
  const buildRegistry = () => {
    const built = buildTypeRegistry({
      template: config.template.get(), customTypes: config.customTypes.get(), scenes: config.scenes.get(),
      removedPresetTypes: config.removedPresetTypes.get(),
    })
    for (const warning of built.warnings) ctx.logger.warn(`[plastic-memory] ${warning}`)
    return built
  }
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
  // 加载期零 I/O：FileTable 构造不碰磁盘，每个操作读它涉及的目录（磁盘是唯一真相，外部改动下次操作就能看到）
  const store = new MemoryStore(fileTable, ctx.logger, sidecar.recallStats)
  // forget 的快照先行与待决账本清理需要这两个存储，治理关闭时也接线
  const decisions = new PendingDecisionsStore(sidecar.pending)
  // 拍完快照落盘后复核：读完记录之后被彻底删除的那份在快照里脱敏
  const snapshots = new SnapshotStore(sidecar.snapshots, { findGone: goneCopies(store) })
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
  // 宿主会话的读取集中在适配器：探测、退化、同一会话只警告一次是它的内部规则
  const host = createCordisHostSession({ lookup: name => ctx.get(name), logger: ctx.logger, resolveCwd })
  // 会话视图（进程内存）：每个会话最近一次冻结的视图，与这次对话新记的 id（可能早于首次冻结）
  const frozenViews = new Map<string, SessionView>()
  const savedIds = new Map<string, string[]>()
  const onSaved = (sessionId: string, memoryId: string) => {
    if (sessionId === UNKNOWN_SESSION_ID) return
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
    store, registry, overflowLedger: decisions, memoryRoot, host, log: ctx.logger,
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

  // AGENTS.md 位置从 DSH_HOME 独立解析（不从 memoryRoot 反推——自定义 root 时会指向 dsh 不读的文件）；
  // memory_promote 与 /memory promote 共用一个写入器（进程内串行）
  const agentsMd = createAgentsMdWriter(agentsMdPath())

  // 子 agent 只读门：写入与治理工具在注册处统一套门，子 agent 会话（delegationDepth ≥ 1）调用即拒；allowSubagent 给出放行条件的才放行。
  // 门内的执行结束后（成功、失败都算，失败前可能已写了一部分）请求重写全局视图：模型改了记忆或账本，记忆页跟着变
  const registerWrite = (tool: ToolDefinition, allowSubagent?: () => boolean) => ctx.tools.register(gateSubagentWrites({
    ...tool,
    execute: async (args, exec) => {
      try {
        return await tool.execute(args, exec)
      } finally {
        void views?.request()
      }
    },
  }, host, allowSubagent))
  // memory_save 的类型枚举与说明在注册时从类型表生成：模板或自定义类型热更新后注销重注册。
  // 子 agent 写入随治理开关：待确认记录的接受入口 memory_confirm 随开关注册，关着时子 agent 照旧只读（每次调用现读）；
  // 说明里的子 agent 段按注册时的开关写，开关热更新时也重注册
  const allowSubagentSave = () => config.governance.enabled.get()
  const registerSave = () => registerWrite(
    createSaveTool({
      store, registry, host, snapshots, decisions, onSaved,
      maxSubagentSaves: () => config.subagent.maxSavesPerSession.get(),
    }, { allowSubagent: allowSubagentSave() }),
    allowSubagentSave,
  )
  let disposeSave = registerSave()
  // memory_search 的 types 说明同样从类型表生成，类型配置热更新时随 memory_save 一起重注册；执行时仍经转发对象现读类型表
  const registerSearch = () => ctx.tools.register(createSearchTool({
    store, registry, host, sessionRecall: snapshotCache,
    tokenizer: { userDictionaryPath: () => config.search.userDictionaryPath.get(), log: ctx.logger },
  }))
  let disposeSearch = registerSearch()
  registerWrite(createForgetTool({ store, snapshots, decisions, log: ctx.logger, host }))
  // 快照的写入与恢复必须成对——治理关闭时 forget 仍会拍快照，若没有恢复入口，
  // 14 天的快照就是死存储。故 memory_snapshot 放在治理开关之外，与 forget 一起常驻。
  registerWrite(createSnapshotTool({ store, snapshots, host }))
  // memory_source：证据下钻（日常 + 治理都用，常驻）。sessionQuery 是 base bundle 默认服务，
  // 但按 llm 同款惯例 per-call 探测 + try/catch——某些 profile 缺席时工具内优雅降级，不挂载失败。
  // 生成处理建议时回查出处也用它（经 /memory 命令注入），没有会话的进程里同样能读。
  const getReadEvent = (): ReadEventFn | null => {
    try {
      const sq = ctx.get('sessionQuery') as { readEvent?: ReadEventFn } | undefined
      return sq?.readEvent ? sq.readEvent.bind(sq) as ReadEventFn : null
    } catch {
      return null
    }
  }
  ctx.tools.register(createSourceTool({ store, host, getReadEvent }))
  // 体检、健康分、裁决、提升四个工具随体检开关注册 / 注销（开关热更新时再同步一次）。
  // 灵敏度与提升目标不必重注册：工具执行时经 getter 现读配置。
  let governanceTools: Array<() => void> = []
  const syncGovernanceTools = () => {
    for (const dispose of governanceTools.splice(0)) dispose()
    if (!config.governance.enabled.get()) return
    governanceTools = [
      registerWrite(createConfirmTool({ store, decisions, snapshots, log: ctx.logger, host })),
      // 基线按触发调用的 session 取（宿主投影 cell 按 session 隔离，防多会话串台）。
      // 扫描会写语义缓存、登记待决冲突，归写工具；health 纯读，不套门
      registerWrite(createScanTool({
        store, registry, decisions, cache: scanCache, ignores, checkups,
        host,
      })),
      ctx.tools.register(createHealthTool({
        store, registry, decisions, cache: scanCache, ignores, checkups, autoCheckups,
        get thresholds() { return resolveHealthThresholds(config.governance.health.sensitivity.get()) },
        host,
      })),
      // memory_promote：把用户确认的候选提升 global。确认由模型先调 ask_user_question 完成
      // （工具内部弹 userQuestions 会被 web 会话拒绝 "requires agent-owned session"），本工具纯执行。
      registerWrite(createPromoteTool({
        store, agentsMd, snapshots, host,
        get defaultTarget(): PromoteTarget { return config.governance.globalPromoteTarget.get() === 'agents-md' ? 'agents-md' : 'global' },
      })),
    ]
  }
  syncGovernanceTools()

  // GUI（浏览器半侧）的动作通道：/memory 命令随 commands 服务注册，服务撤下时一并停写视图。
  // 首次视图写入推迟到第一个 session/created（见下方）：apply 期间读账本会触发旧 KV 导入探测，
  // 那时 storageDomain 未必挂上；而没有任何会话时浏览器半侧也读不到视图，早写没有意义。
  // 体检视图与自动体检调度共用的读法：设置表、完成记录、目录清单，不读记忆文件
  const checkupSource = { store, checkups, autoCheckups, cache: scanCache, isGovernanceEnabled: () => config.governance.enabled.get() }
  // 四个全局视图的收集：视图写入器与自动体检（体检前后比出新增）共用
  const collectViews = () => collectGlobalViews({
    store, decisions, snapshots, cache: scanCache, ignores, checkups, autoCheckups, registry, memoryRoot, isGovernanceEnabled: () => config.governance.enabled.get(), bootedAt, log: ctx.logger,
  })
  ctx.inject(['commands'], child => {
    const commands = (child as unknown as { commands: { register(def: MemoryCommandDefinition): () => void } }).commands
    const writer = new ViewWriter({
      memoryRoot, log: ctx.logger,
      collect: collectViews,
      collectCheckups: () => collectCheckupView(checkupSource),
    })
    views = writer
    for (const [cwd, workspacePath] of earlyWorkspaces) void writer.requestWorkspace(cwd, workspacePath)
    earlyWorkspaces.clear()
    commands.register(createMemoryCommand({
      memoryRoot, store, decisions, snapshots, cache: scanCache, checkups, autoCheckups, ignores, registry, agentsMd, views: writer,
      onAutoCheckupChanged: () => void scheduler?.recheck(),
      host, log: ctx.logger,
      isGovernanceEnabled: () => config.governance.enabled.get(),
      isLegacyImportSettled: () => sidecar.isLegacyImportSettled(),
      getReadEvent,
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
  // disposer 再取消正在跑的体检并等它收尾。无会话，用宿主默认模型（host.defaultLlm）。
  ctx.inject(['timer'], child => {
    const timer = child as unknown as AutoCheckupTimer
    const created = new AutoCheckupScheduler({
      scan: { store, registry, decisions, cache: scanCache, ignores },
      checkups,
      // 体检前只收集；体检后立刻重写全部视图（没有视图写入器时一次体检改为现收一份）
      views: { collectViews, rewriteAll: async () => views?.rewriteAll() },
      status: () => collectCheckupView(checkupSource),
      host,
      isGovernanceEnabled: () => config.governance.enabled.get(),
      timer: { timeout: (callback, delayMs) => timer.timeout(callback, delayMs), interval: (callback, delayMs) => timer.interval(callback, delayMs) },
      onChecked: async () => { await views?.requestCheckups() },
      onClaimChanged: async () => { await views?.requestCheckups() },
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
    // 决定类型表的配置：变了重建类型表，冻结快照也过期
    const typeKeys = ['template', 'customTypes', 'scenes', 'removedPresetTypes']
    if (changed(...typeKeys)) {
      try {
        currentRegistry = buildRegistry()
        disposeSave()
        disposeSave = registerSave()
        disposeSearch()
        disposeSearch = registerSearch()
      } catch (err) {
        // 自定义类型与内置重名：保留原类型表、memory_save 与 memory_search，等配置改对
        ctx.logger.error('[plastic-memory] 类型配置热更新失败，沿用原类型表:', err)
      }
    }
    if (changed('governance.enabled')) {
      syncGovernanceTools()
      disposeSave()
      disposeSave = registerSave()
    }
    // search.userDictionaryPath 不用在这里处理：memory_search 每次现读路径，变了下一次搜索就重建分词实例
    // 只有组装快照时读的字段变了才让冻结快照过期；主题色、提升路径、体检灵敏度这类改了不重建
    if (changed(...typeKeys, 'snapshotTokenBudget', 'snapshotOverflow', 'evidenceLookup')) {
      snapshotCache.markAllStale()
    }
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
    host.remember(session.header)
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
