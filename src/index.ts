import { withWriteSession } from './storage/recent-changes.ts'
import { createSaveHints, type SaveHints } from './save-signals.ts'
import { join } from 'node:path'
import { homedir } from 'node:os'
import z from '@deepseek-ai/schemastery'
import type { Context, Volatile } from '@deepseek-ai/cordis'
import type { MemoryTypeDefinition } from './types.ts'
import { buildTypeRegistry, PRESET_SCENES, type SceneConfig, type TypeRegistry } from './type-registry.ts'
import { memoryDomainSpec } from './domain-spec.ts'
import { MemoryStore } from './store.ts'
import { FileTable } from './storage/file-table.ts'
import { SidecarStore } from './storage/sidecar.ts'
import { createRootLock } from './storage/root-lock.ts'
import type { LegacyKvTables } from './storage/legacy-kv-import.ts'
import { localStateDir, OP_JOURNAL_FILE, DERIVED_INDEX_FILE, DIALOGUE_RECORDS_FILE, CHECKUP_CACHE_FILE, resolveMemoryRoot } from './storage/paths.ts'
import { DialogueRecordStore } from './storage/dialogue-records.ts'
import { CATCHUP_BACKGROUND_BUDGET_MS, CATCHUP_BACKGROUND_INTERVAL_MS, DialogueCatchup } from './tools/dialogue-catchup.ts'
import { NoReviewList } from './storage/no-review.ts'
import { dialogueTokenizer } from './search/dialogue-tokenizer.ts'
import { OpJournal } from './storage/op-journal.ts'
import { DerivedIndex } from './storage/derived-index.ts'
import { CheckupCache } from './storage/checkup-cache.ts'
import { SCAN_TOKEN_CAP_DEFAULT } from './governance/checkup-plan.ts'
import { stalenessNote } from './record-freshness.ts'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { Session } from '@deepseek-ai/dsh-session'
import { SUBAGENT_MAX_SAVES_DEFAULT } from './pipeline.ts'
import { createSaveTool } from './tools/save-tool.ts'
import { relatedRecheckHook } from './tools/related-recheck.ts'
import { createSearchTool } from './tools/search-tool.ts'
import { DialogueCallCap } from './tools/dialogue-call-cap.ts'
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
import { changeNoticeMessageBody, lastVisibleSnapshot, shouldSendSnapshot, snapshotMessageBody } from './snapshot-message.ts'
import { OVERFLOW_MODES, type OverflowMode } from './contract-codes.ts'
import { resolveHealthThresholds, type HealthSensitivity } from './governance/health-presets.ts'
import { PendingDecisionsStore, overflowScopeOf } from './governance/decisions.ts'
import { ledgerSteps } from './governance/op-steps.ts'
import { MERGE_WINDOW_MINUTES_DEFAULT, historySteps } from './commit-change.ts'
import { INDEX_MAX_TOPICS_DEFAULT } from './topic-index.ts'
import { SnapshotStore } from './governance/snapshots.ts'
import { AdviceIgnoreStore } from './governance/advice-ignores.ts'
import { CheckupRecordStore } from './governance/checkup-records.ts'
import { AutoCheckupSettingStore } from './governance/auto-checkups.ts'
import { ModelSelectionStore, createBackgroundLlmResolver } from './governance/background-llm.ts'
import { DREAMS_DEFAULTS, resolveDreamsConfig } from './governance/dreams-gate.ts'
import { FOCUS_TYPES_DEFAULT, isKnownTier } from './governance/dreams-tiers.ts'
import { DRILL_MAX_DEFAULT, isKnownMaxDrillDowns } from './governance/drill-down.ts'
import { DreamsStore } from './governance/dreams-records.ts'
import { dreamsPlan } from './tools/dreams-plan.ts'
import { DreamsScheduler } from './tools/dreams-scheduler.ts'
import { ActivityBoard } from './governance/session-activity.ts'
import { adviceIgnoreSchema, genId, memorySnapshotSchema, pendingDecisionSchema, scanCacheSchema } from './governance/schema.ts'
import type { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { createInstructionReader } from './governance/instructions.ts'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { createMemoryCommand, type MemoryCommandDefinition } from './gui/commands.ts'
import { MEMORY_RPC_CHANNEL } from './gui/contract.ts'
import { createMemoryRpcHandler, type MemoryRpcHandler } from './gui/rpc.ts'
import { ViewWriter, collectCheckupView, collectGlobalViews } from './gui/view-writer.ts'
import { AutoCheckupScheduler, type AutoCheckupTimer } from './gui/auto-checkup.ts'
import { holdCheckups } from './gui/checkup-run.ts'
import { GLOBAL_SCOPE_KEY } from './scope.ts'
import { CheckupSuggestions } from './gui/checkup-suggestions.ts'
import { buildSessionView } from './gui/views.ts'
import { ACCENTS, type Accent, type SessionView } from './gui/contract.ts'
import { SEARCH_SOURCES, type SearchSource } from './contract-codes.ts'
import { DIALOGUE_BUDGET_DEFAULT } from './search/dialogue-format.ts'

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
  /** 通用五类改过的确认周期（天），按类型名；没写的按出厂周期。 */
  builtinDecayDays: Volatile<Record<string, number>>
  governance: {
    enabled: Volatile<boolean>
    health: { sensitivity: Volatile<HealthSensitivity> }
    globalPromoteTarget: Volatile<'plugin-global' | 'agents-md'>
    /** 一次体检交给模型的 token 上限（按发出去的提示词估算，重试不算），到了就停，下次接着查。设置页不露，配置文件可改；改了下一次体检生效。 */
    scan: { tokenCap: Volatile<number> }
    /**
     * 沿关联发复查信号（实验，缺省关）：一条记忆做了状态变化或纠错，related 里挂着它的决定进待处理，标「依据已变」。
     * 设置页不露，配置文件可改；改了下一次保存生效，关掉之后下一次体检清掉还没处理的这类条目。
     */
    relatedRecheck: Volatile<boolean>
  }
  search: {
    /** jieba 用户词典（每行「词 词频 词性」）的绝对路径，追加在主词典之上；不设只用主词典。改了下一次搜索生效。 */
    userDictionaryPath: Volatile<string | undefined>
    /** memory_search 查哪里：memory 只查记忆，dialogue 只查过往对话的原话，both 两者（缺省）。 */
    source: Volatile<SearchSource>
    /** 一次检索里「其他原话」这一部分最多占多少 token（总量，不是单条上限）。按 300 一步取整，见 dialogueBudgetOf。 */
    dialogueTokenBudget: Volatile<number>
    /** 命中的记忆是否带上出处那一轮的一问一答。缺省开。 */
    memoryQuotes: Volatile<boolean>
    /** 原话第一轮结果弱时，是否让模型从原话里挑词再搜一次。只在 source 含原话时起作用。 */
    queryExpansion: Volatile<boolean>
    /** 原话检索是否包含工具结果（库里只收报错和短输出）。只在查询时过滤，切换不重建对话记录库。 */
    dialogueToolResults: Volatile<boolean>
  }
  history: {
    /** 同一会话在这么多分钟里接连对同一条记忆做的状态变化只留一次历史版本，后面的原因追加进去。设置页不露，配置文件可改；改了下一次保存生效。 */
    mergeWindowMinutes: Volatile<number>
  }
  brewingDreams: {
    /** 记忆梦境（实验）的启动条件，设置页不露，配置文件可改；改了下一轮检查生效。范围开关不在这里，在记忆根的侧表里（几个进程共用）。 */
    /** 距上次做完至少隔这么多天。 */
    minIntervalDays: Volatile<number>
    /** 上次做完之后内容变了的记忆不少于这么多条才再做。 */
    minChanges: Volatile<number>
    /** 上次做完之后没回看的用户消息不少于这么多条也算有内容可做。 */
    minNewMessages: Volatile<number>
    /** 涉及的工作目录都没有会话在跑、并且安静了这么多分钟才开始。 */
    idleMinutes: Volatile<number>
    /** 最近七天后台用量的上限（token）：到了就不再开始新的一次；0 为不限。 */
    weeklyTokenCap: Volatile<number>
    /** 一次运行最多改动本范围在用记忆的比例（0 到 1）；整理的各步共用这一份，同一条记忆做几个操作只算一条。 */
    maxChangeRatio: Volatile<number>
    /** 处理矛盾的档位：gatekeep（把关，缺省）或 trust（信任）。开放取值：不认识的值按把关档跑，并记一条告警。 */
    tier: Volatile<string>
    /** 「这些类型的记忆有矛盾时由我来定」：把关档下改到这些类型的用户明说记忆时先问用户。全局一份。 */
    focusTypes: Volatile<string[]>
    /** 一次运行最多回原对话下钻几处（读到会话日志的才算）；0 是不下钻。坏值按缺省跑，并记一条告警。 */
    maxDrillDowns: Volatile<number>
  }
  index: {
    /** 一个作用域（全局、每个项目各算）里主题数的上限；到了上限不再新建主题。设置页不露，配置文件可改；改了下一次整理生效。 */
    maxTopics: Volatile<number>
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
  template: z.string().default('custom').volatile(),
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
  // 天数范围、类型名由类型表校验（不对的忽略并警告）；值的类型在这里校验
  builtinDecayDays: z.dict(z.number()).default({}).volatile(),
  governance: z.object({
    enabled: z.boolean().default(true).volatile(),
    health: z.object({
      sensitivity: z.union(['conservative', 'normal', 'proactive'] as const).default('normal').volatile(),
    }).default({ sensitivity: 'normal' }),
    globalPromoteTarget: z.union(['plugin-global', 'agents-md'] as const).default('plugin-global').volatile(),
    // 0、负数：体检回落默认值并记日志（governance/checkup-plan.ts resolveTokenCap）；类型不对、非有限数（.inf、.nan）由配置校验报错
    scan: z.object({
      tokenCap: z.number().default(SCAN_TOKEN_CAP_DEFAULT).volatile(),
    }),
    relatedRecheck: z.boolean().default(false).volatile(),
  }),
  search: z.object({
    userDictionaryPath: z.string().volatile(),
    source: z.union(SEARCH_SOURCES).default('both').volatile(),
    dialogueTokenBudget: z.number().default(DIALOGUE_BUDGET_DEFAULT).volatile(),
    memoryQuotes: z.boolean().default(true).volatile(),
    queryExpansion: z.boolean().default(true).volatile(),
    dialogueToolResults: z.boolean().default(true).volatile(),
  }),
  history: z.object({
    mergeWindowMinutes: z.number().default(MERGE_WINDOW_MINUTES_DEFAULT).volatile(),
  }),
  // 取值范围不在这里拦：坏值在用的时候换成默认值并记日志（resolveDreamsConfig），不让整份配置加载失败
  brewingDreams: z.object({
    minIntervalDays: z.number().default(DREAMS_DEFAULTS.minIntervalDays).volatile(),
    minChanges: z.number().default(DREAMS_DEFAULTS.minChanges).volatile(),
    minNewMessages: z.number().default(DREAMS_DEFAULTS.minNewMessages).volatile(),
    idleMinutes: z.number().default(DREAMS_DEFAULTS.idleMinutes).volatile(),
    weeklyTokenCap: z.number().default(DREAMS_DEFAULTS.weeklyTokenCap).volatile(),
    maxChangeRatio: z.number().default(DREAMS_DEFAULTS.maxChangeRatio).volatile(),
    tier: z.string().default('gatekeep').volatile(),
    focusTypes: z.array(z.string()).default([...FOCUS_TYPES_DEFAULT]).volatile(),
    // 一次运行最多回原对话下钻几处；坏值在用的时候换成默认值（resolveMaxDrillDowns）
    maxDrillDowns: z.number().default(DRILL_MAX_DEFAULT).volatile(),
  }),
  index: z.object({
    maxTopics: z.natural().min(1).default(INDEX_MAX_TOPICS_DEFAULT).volatile(),
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
  // 类型表随 template / customTypes / scenes / removedPresetTypes / builtinDecayDays 热更新重建；各处拿到的是转发到当前表的同一个对象。
  // 场景配置写错只警告（按通用或截断运行），不让插件加载失败
  const buildRegistry = () => {
    const built = buildTypeRegistry({
      template: config.template.get(), customTypes: config.customTypes.get(), scenes: config.scenes.get(),
      removedPresetTypes: config.removedPresetTypes.get(), builtinDecayDays: config.builtinDecayDays.get(),
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
  // 记忆根写锁（写入段）：一个插件实例一把，注入文件表、侧表、待决账本、视图写入器、指令文件写入器（进程内也互斥，段内再进不等待）。
  // 懒打开，没有关闭步骤，卸载不用处理它：卸载后迟到的写入照样拿锁，和热重载后的新实例互斥
  const rootLock = createRootLock({ root: memoryRoot, log: ctx.logger })
  // 侧表（快照、待决账本、扫描缓存、召回统计）住 <memoryRoot>/.state/，构造不做 I/O。
  // storageDomain 不再是必需注入：只为首次侧表访问时导入旧 KV 的快照与待决账本（0.3.0 移除）。
  // 按 llm / sessionQuery 同款惯例经 ctx.get 探测，且推迟到导入真正发生时——apply 期间宿主的
  // storageDomain 未必已挂上。探测落空返回 undefined：不写标记，本进程不再探，下次启动重探。
  const sidecar = new SidecarStore({
    root: memoryRoot,
    lock: rootLock,
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
  // 操作日志库在记忆根之外、每台机器一份：懒打开，不可用时写入照常进行。卸载时关连接，迟到的写入会重新打开
  const journal = new OpJournal({ path: join(localStateDir(memoryRoot), OP_JOURNAL_FILE), log: ctx.logger })
  ctx.effect(() => () => { journal.close() }, 'plastic-memory: op journal')
  // 派生索引库同样在记忆根之外、每台机器一份：存的都能从记忆文件重算，不可用时查找改回逐个读文件
  const derivedIndex = new DerivedIndex({ path: join(localStateDir(memoryRoot), DERIVED_INDEX_FILE), log: ctx.logger })
  ctx.effect(() => () => { derivedIndex.close() }, 'plastic-memory: derived index')
  // 体检结果库也在记忆根之外、每台机器一份：存内容检查按批的结论，丢了只多花 token。token 上限每次体检现读配置
  const checkupCache = new CheckupCache({ path: join(localStateDir(memoryRoot), CHECKUP_CACHE_FILE), log: ctx.logger })
  ctx.effect(() => () => { checkupCache.close() }, 'plastic-memory: checkup cache')
  const fileTable = new FileTable({
    root: memoryRoot,
    lock: rootLock,
    journal,
    index: derivedIndex,
    stats: sidecar.recallStats,
    // MEMORY.md 和注入的主题行只数久未确认的条数；逐条的陈旧度标注只出在注入的必读全文和检索结果上
    isStale: (r, now) => stalenessNote(r, registry.get(r.type).decayDays, now) !== '',
    log: ctx.logger,
  })
  // 加载期零 I/O：FileTable 构造不碰磁盘，每个操作读它涉及的目录（磁盘是唯一真相，外部改动下次操作就能看到）
  const store = new MemoryStore(fileTable, ctx.logger, sidecar.recallStats, journal)
  // forget 的快照先行与待决账本清理需要这两个存储，治理关闭时也接线
  const decisions = new PendingDecisionsStore(sidecar.pending, rootLock)
  const relatedRecheck = relatedRecheckHook({
    decisions, isEnabled: () => config.governance.enabled.get() && config.governance.relatedRecheck.get(), log: ctx.logger,
  })
  // 写成之后要补的账：启动时登记，上一个进程写到一半退出的，这里的第一次写入就能补上
  store.registerSteps(ledgerSteps(decisions, ctx.logger))
  // 拍完快照落盘后复核：读完记录之后被彻底删除的那份在快照里脱敏
  const snapshots = new SnapshotStore(sidecar.snapshots, { findGone: goneCopies(store) })
  // 状态变化写成之后留历史版本：同样启动时登记，中断后按改前快照补上
  store.registerSteps(historySteps(store, snapshots, ctx.logger))
  const scanCache = sidecar.scanCache
  // 建议忽略表：健康分、体检、GUI 视图同一份剔除口径
  const ignores = new AdviceIgnoreStore(sidecar.adviceIgnores)
  // 体检记录表：体检做完写完成记录（上次体检），健康分、GUI 视图从它读；写体检状态前在同一把写锁里核对视图
  const checkups = new CheckupRecordStore(sidecar.checkups, { views: scanCache, lock: sidecar.lock, log: ctx.logger })
  // 自动体检设置表：记忆页经 /memory set-auto-checkup 改，几个宿主进程共用一份
  const autoCheckups = new AutoCheckupSettingStore(sidecar.autoCheckups)
  // 记忆梦境的侧表：范围开关、每个范围的运行记录、变化基线、七天用量，几个宿主进程共用一份
  const dreams = new DreamsStore(sidecar.dreams, sidecar.dreamMarks)
  const dreamsConfig = () => resolveDreamsConfig({
    minIntervalDays: config.brewingDreams.minIntervalDays.get(), minChanges: config.brewingDreams.minChanges.get(), minNewMessages: config.brewingDreams.minNewMessages.get(),
    idleMinutes: config.brewingDreams.idleMinutes.get(), weeklyTokenCap: config.brewingDreams.weeklyTokenCap.get(),
    maxChangeRatio: config.brewingDreams.maxChangeRatio.get(),
  })
  // 后台模型的选择表：自动体检、梦境各一个键，设置页经 /memory set-model-selection 改，几个宿主进程共用一份
  const selections = new ModelSelectionStore(sidecar.modelSelections)
  // 指令文件（AGENTS.md / CLAUDE.md）按作用域现读，用宿主自己的指令文件包（用到时才加载，解析到宿主那份）：
  // 体检、垂直冲突的建议与采纳都按记忆对应的那份，不随会话。加载不了时垂直冲突检测跳过，体检打 baseline-missing。
  const instructions = createInstructionReader(() => import('@deepseek-ai/dsh-agent-instructions'))
  // GUI 视图写入器：宿主有 commands 服务（GUI 半侧可用）时才有，见下方 ctx.inject(['commands'], …)
  let views: ViewWriter | undefined
  // 自动体检调度器：宿主有计时服务时才有，见下方 ctx.inject(['timer'], …)
  let scheduler: AutoCheckupScheduler | undefined
  // 记忆梦境调度器：同上
  let dreamsScheduler: DreamsScheduler | undefined
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
  // 对话记录库：过往对话的本地副本，在记忆根之外、每台机器一份，能从会话日志整份重建。检索来源含原话或记忆带原话时才建、才读会话日志。
  // 「不回看」清单在记忆根里，几个进程同一份；标上之后把这个会话已经收进本机的对话记录清掉
  const noReview = new NoReviewList(memoryRoot, sessionId => dialogueCatchup.dropSession(sessionId))
  const isDialogueEnabled = () => config.search.source.get() !== 'memory' || config.search.memoryQuotes.get()
  const dialogueCatchup = new DialogueCatchup({
    store: new DialogueRecordStore({ path: join(localStateDir(memoryRoot), DIALOGUE_RECORDS_FILE), log: ctx.logger }),
    host,
    noReview,
    tokenizer: () => dialogueTokenizer({ userDictionaryPath: () => config.search.userDictionaryPath.get(), log: ctx.logger }),
    // 不经 resolveCwd：那里会把解析结果记进会话归属对照，建库列到的会话不该进那张表
    workspaceOf: cwd => resolveWorkspacePath(ctx, cwd),
    knownWorkspaces: async () => [...new Set((await fileTable.listWorkspaceDirs()).entries.map(e => e.workspacePath))],
    isEnabled: isDialogueEnabled,
    sessionStore: process.env.DSH_HOME ?? join(homedir(), '.dsh'),
    log: ctx.logger,
  })
  ctx.effect(() => () => { dialogueCatchup.stop() }, 'plastic-memory: dialogue records')
  // 会话视图（进程内存）：每个会话最近一次冻结的视图，与这次对话新记的 id（可能早于首次冻结）
  const frozenViews = new Map<string, SessionView>()
  const savedIds = new Map<string, string[]>()
  // 每个会话里已经回过缺改动性质引导的记忆：只在进程内存里，引导过一次后同一条再缺就按状态变化写。
  // 认不出会话的调用共用一份：宁可少引导一次，也不让它们每次都被拒
  const saveHints = new Map<string, SaveHints>()
  const saveHintsIn = (sessionId: string) => {
    let hints = saveHints.get(sessionId)
    if (hints === undefined) saveHints.set(sessionId, hints = createSaveHints())
    return hints
  }
  const guidedIds = new Map<string, Set<string>>()
  const guidedIn = (sessionId: string) => {
    let ids = guidedIds.get(sessionId)
    if (ids === undefined) guidedIds.set(sessionId, ids = new Set())
    return ids
  }
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
    recentChanges: journal,
    store, registry, overflowLedger: decisions, snapshots, memoryRoot, host, log: ctx.logger,
    get budget() { return config.snapshotTokenBudget.get() },
    get overflow() { return config.snapshotOverflow.get() },
    get evidenceLookup() { return config.evidenceLookup.get() },
    get memoryQuotes() { return config.search.memoryQuotes.get() },
    get searchSource() { return config.search.source.get() },
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
  const agentsMd = createAgentsMdWriter(agentsMdPath(), rootLock)

  // 子 agent 只读门：写入与治理工具在注册处统一套门，子 agent 会话（delegationDepth ≥ 1）调用即拒；allowSubagent 给出放行条件的才放行。
  // 门内的执行结束后（成功、失败都算，失败前可能已写了一部分）请求重写全局视图：模型改了记忆或账本，记忆页跟着变
  const registerWrite = (tool: ToolDefinition, allowSubagent?: () => boolean) => ctx.tools.register(gateSubagentWrites({
    ...tool,
    execute: async (args, exec) => {
      try {
        return await withWriteSession(exec.agent?.session.header.id, () => tool.execute(args, exec))
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
    maxTopics: () => config.index.maxTopics.get(),
      store, registry, host, snapshots, decisions, relatedRecheck, onSaved, memoryRoot, homeDir: homedir(),
      maxSubagentSaves: () => config.subagent.maxSavesPerSession.get(),
      saveHintsIn, tokenizer: { userDictionaryPath: () => config.search.userDictionaryPath.get(), log: ctx.logger },
      guidedIn, mergeWindowMinutes: () => config.history.mergeWindowMinutes.get(),
    }, { allowSubagent: allowSubagentSave() }),
    allowSubagentSave,
  )
  let disposeSave = registerSave()
  const callCap = new DialogueCallCap()
  // memory_search 的 types 说明同样从类型表生成，类型配置热更新时随 memory_save 一起重注册；执行时仍经转发对象现读类型表
  const registerSearch = () => ctx.tools.register(createSearchTool({
    store, registry, host, sessionRecall: snapshotCache, callCap,
    expansion: { isEnabled: () => config.search.queryExpansion.get(), host, selections },
    searchSource: () => config.search.source.get(),
    memoryQuotes: () => config.search.memoryQuotes.get(),
    dialogue: {
      store: dialogueCatchup.readStore, catchup: dialogueCatchup, host, noReview,
      workspaceOf: cwd => resolveWorkspacePath(ctx, cwd),
      tokenizer: () => dialogueTokenizer({ userDictionaryPath: () => config.search.userDictionaryPath.get(), log: ctx.logger }),
      hasBackgroundTimer: () => scheduler !== undefined,
      budget: () => config.search.dialogueTokenBudget.get(), includeTools: () => config.search.dialogueToolResults.get(),
    },
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
  const findingSources = { readEvent: getReadEvent, noReview }
  const incremental = {
    checkupCache, tokenCap: () => config.governance.scan.tokenCap.get(), sources: findingSources,
    isRelatedRecheckEnabled: () => config.governance.relatedRecheck.get(),
  }
  ctx.tools.register(createSourceTool({ store, host, noReview, workspaceOf: cwd => resolveWorkspacePath(ctx, cwd),
    dialogueStore: dialogueCatchup.readStore, isDialogueEnabled, dialogueToolResults: () => config.search.dialogueToolResults.get() }))
  // 体检、健康分、裁决、提升四个工具随体检开关注册 / 注销（开关热更新时再同步一次）。
  // 灵敏度与提升目标不必重注册：工具执行时经 getter 现读配置。
  let governanceTools: Array<() => void> = []
  const syncGovernanceTools = () => {
    for (const dispose of governanceTools.splice(0)) dispose()
    if (!config.governance.enabled.get()) return
    governanceTools = [
      registerWrite(createConfirmTool({
        store, decisions, snapshots, log: ctx.logger, host, instructions,
        tokenizer: { userDictionaryPath: () => config.search.userDictionaryPath.get(), log: ctx.logger },
      })),
      // 垂直冲突对照每条记忆所在项目的指令文件，和触发调用的会话无关。
      // 扫描会写语义缓存、登记待决冲突，归写工具；health 纯读，不套门
      registerWrite(createScanTool({
        store, registry, decisions, cache: scanCache, ignores, checkups, instructions, ...incremental, log: ctx.logger,
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
  const checkupSource = { store, checkups, autoCheckups, selections, cache: scanCache, isGovernanceEnabled: () => config.governance.enabled.get() }
  // 体检之后的后续段：给冲突逐条生成处理建议。手动体检、自动体检共用一份，进程内的「正在生成」标记随待处理视图写出
  const checkupSuggestions = new CheckupSuggestions({
    store, decisions, checkups, getReadEvent, instructions,
    views: { request: async names => { await views?.request(names) }, requestCheckups: async () => { await views?.requestCheckups() } },
    now: () => Date.now(), log: ctx.logger,
  })
  // 四个全局视图的收集：视图写入器与自动体检（体检前后比出新增）共用
  const collectViews = () => collectGlobalViews({
    store, decisions, snapshots, cache: scanCache, ignores, checkups, autoCheckups, registry, memoryRoot, isGovernanceEnabled: () => config.governance.enabled.get(), bootedAt, log: ctx.logger,
    generatingSuggestions: () => checkupSuggestions.generatingIds(),
  })
  // 面板动作的通道：宿主有连接服务（挂在 web 服务上）时才有。面板经它调命令处理器，不借会话执行命令，会话日志里不留记录
  let guiCommand: MemoryCommandDefinition['handler'] | undefined
  ctx.inject(['connection', 'webServer', 'typert'], child => {
    // 连接服务把通道挂到「读它的那个上下文」的 web 服务上，而可选注入的子上下文读不到 webServer（宿主报 without inject）：
    // 派生一个自带 webServer 的上下文再读 connection。通道随这个子上下文释放
    const scoped = (child as unknown as {
      get(name: string): unknown
      extend(members: object): { connection: { rpc: { handle(channel: string, handler: MemoryRpcHandler): unknown } } }
      typert: { lookups: { get(key: string): { resolve(value: string): Promise<unknown> } | undefined } }
    })
    const { lookups } = scoped.typert
    scoped.extend({ webServer: scoped.get('webServer') }).connection.rpc.handle(MEMORY_RPC_CHANNEL, createMemoryRpcHandler({
      command: () => guiCommand,
      agentOf: async id => await lookups.get('agent')?.resolve(id),
    }))
  })
  // 体检（手动、自动）和梦境用的模型：设置里选的，没选或选的用不了时用宿主默认模型（host.defaultLlm），不借会话的模型
  const resolveBackgroundLlm = createBackgroundLlmResolver({
    selections, catalog: host.modelCatalog, llmFor: selection => host.llmForRoute(selection), defaultLlm: host.defaultLlm,
  })
  ctx.inject(['commands'], child => {
    const commands = (child as unknown as { commands: { register(def: MemoryCommandDefinition): () => void } }).commands
    const writer = new ViewWriter({
      memoryRoot, log: ctx.logger, lock: rootLock,
      collect: collectViews,
      collectCheckups: () => collectCheckupView(checkupSource),
    })
    views = writer
    for (const [cwd, workspacePath] of earlyWorkspaces) void writer.requestWorkspace(cwd, workspacePath)
    earlyWorkspaces.clear()
    // 卸载时取消手动体检之后还在跑的后续段（不等在途的模型调用）
    const unload = new AbortController()
    const command = createMemoryCommand({
      memoryRoot, store, decisions, snapshots, relatedRecheck, cache: scanCache, checkups, autoCheckups, selections, ignores, registry, agentsMd, views: writer, instructions, dreams, incremental,
      resolveCheckupLlm: () => resolveBackgroundLlm('checkup'),
      onAutoCheckupChanged: () => void scheduler?.recheck(),
      deleteDialogueRecords: () => dialogueCatchup.destroy(),
      suggestions: checkupSuggestions, signal: unload.signal,
      host, log: ctx.logger,
      isGovernanceEnabled: () => config.governance.enabled.get(),
      isLegacyImportSettled: () => sidecar.isLegacyImportSettled(),
      getReadEvent,
      maxTopics: () => config.index.maxTopics.get(),
    })
    commands.register(command)
    guiCommand = command.handler
    // 卸载时（插件重载、commands 服务撤下）停写视图：cordis 卸载会 await 这个 disposer，
    // 进行中的写入落完才轮到新实例加载，旧实例的迟到写入不会盖掉新视图
    return async () => {
      if (guiCommand === command.handler) guiCommand = undefined
      unload.abort(new DOMException('plugin unloaded', 'AbortError'))
      // 被取消的后续段要到之后的微任务才收尾，那时写入器已撤下：这里先清标记、重写一次待处理视图，文件里不留「正在生成」
      checkupSuggestions.clearMarks()
      await writer.request(['pending']).catch(() => {})
      if (views === writer) views = undefined
      await writer.dispose()
    }
  })
  let startupViewsPending = true

  // 自动体检调度：宿主有计时服务时才有（可选注册，同 commands）。计时器挂在 child 上，插件卸载时宿主停掉它们；
  // disposer 再取消正在跑的体检并等它收尾。无会话，用体检选的模型（见 resolveBackgroundLlm）。
  ctx.inject(['timer'], child => {
    const timer = child as unknown as AutoCheckupTimer
    const created = new AutoCheckupScheduler({
      scan: { store, registry, decisions, cache: scanCache, ignores, instructions, ...incremental },
      checkups,
      // 体检前只收集；体检后立刻重写全部视图（没有视图写入器时一次体检改为现收一份）
      views: { collectViews, rewriteAll: async () => views?.rewriteAll() },
      status: () => collectCheckupView(checkupSource),
      resolveLlm: () => resolveBackgroundLlm('checkup'),
      isGovernanceEnabled: () => config.governance.enabled.get(),
      timer: { timeout: (callback, delayMs) => timer.timeout(callback, delayMs), interval: (callback, delayMs) => timer.interval(callback, delayMs) },
      onChecked: async () => { await views?.requestCheckups() },
      onClaimChanged: async () => { await views?.requestCheckups() },
      suggestions: checkupSuggestions,
      onRoundDone: () => void dreamsScheduler?.recheck(),
      now: () => Date.now(),
      log: ctx.logger,
    })
    scheduler = created
    // 活动表：本进程里哪些工作目录有会话在跑，写到侧表给别的进程看；记忆梦境据此判空闲、让路
    const board = new ActivityBoard({
      table: sidecar.activity, processId: genId('proc'), log: ctx.logger, now: () => Date.now(),
      interval: (callback, delayMs) => timer.interval(callback, delayMs),
      source: {
        onStatus: listener => ctx.on('agent/status', ({ agent, status }) => { listener(agent, status) }),
        list: () => {
          const agents = ctx.get('agents') as { list?(): Array<{ status: string }> } | undefined
          return agents?.list?.().map(agent => ({ agent, status: agent.status }))
        },
        // 不经 resolveCwd：这里只为判空闲，不往会话归属对照里记
        workspaceKeyOf: async agent => (await resolveWorkspacePath(ctx, (agent as { session?: { header?: { cwd?: string } } }).session?.header?.cwd)) ?? GLOBAL_SCOPE_KEY,
      },
    })
    void board.start().catch((err: unknown) => { ctx.logger.warn('[plastic-memory] 活动表启动失败，记忆梦境不会自动运行', err) })
    // 记忆梦境：在自动体检每一轮之后查门槛
    const dreamsCreated = new DreamsScheduler({
      run: {
        store, snapshots, decisions, relatedRecheck, dreams, log: ctx.logger,
        // 认领和放掉时重写体检状态；放掉时另外重写待处理视图：梦境里的体检和处理矛盾改过账本
        claimScope: async (scope, onLost) => {
          const held = await holdCheckups(checkups, [scope], {
            interval: (callback, delayMs) => timer.interval(callback, delayMs), onLost, onChange: async () => { await views?.requestCheckups() }, log: ctx.logger,
          })
          return 'busy' in held ? held : { release: async () => { await held.release(); await views?.request(['pending']) } }
        },
        activity: maxAgeMs => board.view(maxAgeMs),
        resolveLlm: () => resolveBackgroundLlm('dreams'),
        config: () => dreamsConfig().config,
        isGovernanceEnabled: () => config.governance.enabled.get(),
        plan: dreamsPlan({
          tidy: { store, maxTopics: () => config.index.maxTopics.get(), now: () => Date.now(), typeRecall: type => registry.get(type).recall },
          merge: { store, dreams },
          // 梦境里的体检用体检选的模型，不写体检完成记录（不传 checkups）
          checkup: { scan: { store, registry, decisions, cache: scanCache, ignores, instructions, ...incremental, log: ctx.logger }, resolveLlm: () => resolveBackgroundLlm('checkup') },
          drill: { store, decisions, host, noReview, maxDrillDowns: () => config.brewingDreams.maxDrillDowns.get(), now: () => Date.now() },
          resolve: {
            store, decisions, dreams, host, noReview, memoryRoot, homeDir: homedir(),
            tier: () => config.brewingDreams.tier.get(), focusTypes: () => config.brewingDreams.focusTypes.get(), now: () => Date.now(),
          },
        }),
        interval: (callback, delayMs) => timer.interval(callback, delayMs),
        now: () => Date.now(),
        // 运行 id 同时是这次运行在账本里的条目 id，和别的条目同一种写法
        newRunId: () => genId('pd'),
      },
      store, board,
      timeout: (callback, delayMs) => timer.timeout(callback, delayMs),
      badConfigKeys: () => [
        ...dreamsConfig().badKeys,
        ...(isKnownTier(config.brewingDreams.tier.get()) ? [] : ['tier']),
        ...(isKnownMaxDrillDowns(config.brewingDreams.maxDrillDowns.get()) ? [] : ['maxDrillDowns']),
      ],
      log: ctx.logger,
    })
    dreamsScheduler = dreamsCreated
    dreamsCreated.start()
    created.start()
    // 对话记录库的后台推进：一次只跑一段，上一段没跑完这一拍就跳过；功能关着时什么都不做
    let isAdvancing = false
    const stopAdvancing = timer.interval(() => {
      if (isAdvancing || !isDialogueEnabled()) return
      isAdvancing = true
      void dialogueCatchup.advance(CATCHUP_BACKGROUND_BUDGET_MS).finally(() => { isAdvancing = false })
    }, CATCHUP_BACKGROUND_INTERVAL_MS)
    return async () => {
      stopAdvancing()
      if (scheduler === created) scheduler = undefined
      if (dreamsScheduler === dreamsCreated) dreamsScheduler = undefined
      await created.dispose()
      await dreamsCreated.dispose()
      await board.dispose()
    }
  })

  // 配置热生效：宿主只在 volatile 字段变化时发本事件（载荷是变化路径，如 [['governance', 'enabled']]），已提交的新值经 .get() 读到。
  // 所有会话的快照标过期（宿主每一步都组装，同一轮的下一步就按新配置重建），按变化项重注册工具，最后重写视图。
  // 事件的 Events 增广在 @deepseek-ai/cordis-plugin-loader（非直接依赖），按最小结构签名订阅，同下方 session/* 事件。
  const loaderEvents = ctx as unknown as {
    on(name: 'loader/volatile-update', fn: (paths: readonly (readonly string[])[]) => Promise<void>): () => void
  }
  const onVolatileUpdate = async (paths: readonly (readonly string[])[]) => {
    const changed = (...keys: string[]) => paths.some(path => keys.includes(path.join('.')))
    // 决定类型表的配置：变了重建类型表，冻结快照也过期
    const typeKeys = ['template', 'customTypes', 'scenes', 'removedPresetTypes', 'builtinDecayDays']
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
    // 原话功能关掉：在途的建库停下、关连接；库文件留着，要删走 delete-dialogue-records
    if (changed('search.source', 'search.memoryQuotes') && !isDialogueEnabled()) dialogueCatchup.stop()
    // search.userDictionaryPath 不用在这里处理：memory_search 每次现读路径，变了下一次搜索就重建分词实例
    // 只有组装快照时读的字段变了才让冻结快照过期；主题色、提升路径、体检灵敏度这类改了不重建
    if (changed(...typeKeys, 'snapshotTokenBudget', 'snapshotOverflow', 'evidenceLookup', 'search.source', 'search.memoryQuotes')) {
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
    if (changed('governance.enabled') || changed('brewingDreams.minIntervalDays', 'brewingDreams.minChanges', 'brewingDreams.minNewMessages', 'brewingDreams.idleMinutes', 'brewingDreams.weeklyTokenCap')) void dreamsScheduler?.recheck()
  }
  // 宿主发这个事件不等监听器返回的 promise：它 reject 就成了未处理的 rejection，宿主会整个退出。在这里接住，只记日志
  loaderEvents.on('loader/volatile-update', paths => onVolatileUpdate(paths).catch((err: unknown) => { ctx.logger.error('[plastic-memory] 处理配置热更新出错:', err) }))

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
    callCap.observe(session, event)
    // 快照按 session 冻结，压缩结束后由下一个发送点重建。
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
  const snapshotMessages = async (session: Session): Promise<UserMessage[]> => {
    const text = await snapshotCache.assemble(session)
    const messages = shouldSendSnapshot(text, lastVisibleSnapshot(session.deriveMessages())) ? [createUserMessage(snapshotMessageBody(text))] : []
    try {
      const notice = await snapshotCache.changeNotice(session, session.header.id)
      if (notice !== undefined) messages.push(createUserMessage(changeNoticeMessageBody(notice)))
    } catch (err) {
      ctx.logger.error('[plastic-memory] 变化通知组装失败:', err)
    }
    return messages
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
    const messages = await snapshotMessages(agent.session)
    if (messages.length === 0) return decision
    if (decision.messages.length > 0) return { ...decision, messages: [...messages, ...decision.messages] }
    for (const message of messages) appendSnapshot(agent.session, message)
    return decision
  }, { prepend: true })
  // 溢出恢复：compaction-basic 压缩后返回 retry，同一步重试前不再经过 pre-step；只在重试时补发。
  // 也要 prepend：compaction-basic 恢复时直接返回 retry、不调 next()，排在它里层就看不到这次重试。
  ctx.on('agent/request-error', async ({ agent, signal }, next) => {
    const action = await next()
    if (action?.kind === 'retry' && !signal.aborted) {
      for (const message of await snapshotMessages(agent.session)) appendSnapshot(agent.session, message)
    }
    return action
  }, { prepend: true })
}
