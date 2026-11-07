import { z } from 'zod'
import { memoryRecordSchema } from '../record-schema.ts'
import { sameScope, scopeKey, scopeOfMemory, scopeSchema, type Scope } from '../scope.ts'
import { CHECKUP_CAUSE_KINDS, CHECKUP_INITIATORS, DIRECTORY_NOTE_CODES, IGNORABLE_ADVICE_TYPES, MODEL_CHANGE_KINDS, OVERFLOW_MODES, SCAN_NOTE_CODES } from '../contract-codes.ts'

/** 快照、最近删除的保留窗口（毫秒）：对话卡据此判断模型改写的改前版本是否已过期。 */
export { RETENTION_MS } from '../retention.ts'

/** 密钥遮盖（缺省与注入、视图同一套规则），浏览器半侧给对话卡里来自工具参数的文字用（带 severity: 'suspected'）。 */
export { maskSecrets, maskSecretSurface, type MaskOptions } from '../secrets.ts'

/** 密钥检测（与写入管线同一套规则）：浏览器半侧发命令前预检，命令文本会进借用会话的日志，高危密钥不能先发出去。 */
export { detectSecrets } from '../secrets.ts'

/**
 * GUI 契约（命名契约：视图与命令的标识符只在这一处定义）。服务端 GUI 层与浏览器半侧共用，是叶子：
 * 只 import zod 与其他叶子，且必须能在浏览器里运行（不碰 node:*）。
 * 只有结构和稳定码，没有界面文案；时间一律是毫秒时间戳，「3 天前」「已过期」由客户端按当前时间算。
 * 记忆文字（名称、正文、摘要、标签）进视图前已遮盖密钥片段；文件路径保留原样，供「打开文件」。
 */

/** 视图 schema 的版本号：视图是派生缓存，形状变了就换号，客户端读到不认识的号按「需要刷新」处理。 */
export const GUI_VIEW_VERSION = 14

/** 视图文件所在目录（相对记忆根目录，POSIX 分隔）。 */
export const GUI_VIEW_DIR = '.state/gui'

/** 四个全局视图的文件名。会话视图每个会话一份，见 sessionViewFile。 */
export const GUI_VIEW_FILES = {
  pending: 'pending.json',
  health: 'health.json',
  library: 'library.json',
  deleted: 'deleted.json',
} as const
export type GlobalViewName = keyof typeof GUI_VIEW_FILES

export function sessionViewFile(sessionId: string): string {
  return `session-${encodeURIComponent(sessionId)}.json`
}

const version = z.literal(GUI_VIEW_VERSION)

/**
 * 视图生成时刻（毫秒，写入方进程的时钟）：这次收集开始、读记忆文件之前取，四个全局视图和体检视图都带，同一次收集写出的相同。
 * 在它之前写下的记忆一定反映在视图里（对话卡按全部记忆与最近删除两份视图的这个时刻判彻底删除）。写入器替换文件前读盘上那份，
 * 盘上的更晚就不写，几个进程同开时早收集、晚写完的旧视图不盖掉新的；盘上缺它、或它晚于当前时刻（时钟往回调过）按 0 算。
 * 可缺省：升级前写的视图文件、界面测试手搭的视图没有它。
 */
const generatedAt = z.number().optional()

// —— 共用片段 ——

/** 作用域的身份（形状、判等、标准键、从记忆推作用域）定义在 scope.ts，经这里转出给浏览器半侧。 */
export { sameScope, scopeKey, scopeOfMemory, scopeSchema, type Scope } from '../scope.ts'

const sourceModeSchema = memoryRecordSchema.shape.source.unwrap().shape.sourceMode
const reviewedBySchema = memoryRecordSchema.shape.delegation.unwrap().shape.reviewed.unwrap().shape.by

/** 界面主题色：ella 艾拉主题色（银藤）、blue-whale 大肥鱼主题色（借宿主品牌蓝）。只影响界面强调色。 */
export const ACCENTS = ['ella', 'blue-whale'] as const
export type Accent = (typeof ACCENTS)[number]

/**
 * 项目记忆在「提升为全局」上的状态：candidate = 模型标了全局提升候选、还没处理（体检关闭时不标）；
 * kept-local = 用户选了「留在本项目」（账本里结清的那条还在）。已提升的就是全局记忆，不另标。
 */
export const MEMORY_PROMOTIONS = ['candidate', 'kept-local'] as const
export type MemoryPromotion = (typeof MEMORY_PROMOTIONS)[number]

/** 记忆卡：原文 + 类型 · 作用域 · 来源 · 时间。 */
export const memoryCardSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  scope: z.enum(['global', 'workspace']),
  workspacePath: z.string().optional(),
  summary: z.string(),
  content: z.string(),
  tags: z.array(z.string()),
  /** 缺省 = 手编 / 无出处。 */
  sourceMode: sourceModeSchema.optional(),
  sourceSessionId: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  lastConfirmedAt: z.number(),
  validTo: z.number().optional(),
  handEdited: z.boolean().optional(),
  /** 子 agent 写入的记忆：第几层子 agent 建的，谁升的档（缺省 = 待确认）。普通记忆不带。 */
  delegation: z.object({ depth: z.number().int().min(1), reviewed: reviewedBySchema.optional() }).optional(),
  /** 记忆文件的绝对路径。 */
  filePath: z.string(),
  /** 名称、摘要、正文的内容摘要（同文件里的 digest 算法）：直接改时连同 updatedAt 带回去，磁盘上对不上就是卡片加载后被改过。
   *  可缺省：对话卡从工具参数拼出来，没有它。 */
  digest: z.string().optional(),
  /** 四个面含高危密钥（只看高危，与界面遮盖同口径）：界面上的文字是遮盖后的，不给直接改、直接合并。 */
  hasSecret: z.literal(true).optional(),
  /** 提升为全局的状态（见 MEMORY_PROMOTIONS）。只在全部记忆视图里给：对话卡片和右侧栏「这次新写入的」据此就地提示。 */
  promotion: z.enum(MEMORY_PROMOTIONS).optional(),
})
export type MemoryCard = z.infer<typeof memoryCardSchema>

/**
 * 直接合并时保留哪条：一条全局一条项目时保留全局那条；同一作用域（或两个不同项目）保留创建较早的，同时创建按 id。
 * 服务端按它决定保留哪条，界面按它预填名称和摘要。
 */
export function mergeKeeperIndex(memories: readonly [MergeSide, MergeSide]): 0 | 1 {
  const [a, b] = memories
  if (a.scope !== b.scope) return a.scope === 'global' ? 0 : 1
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 0 : 1
  return a.id <= b.id ? 0 : 1
}
type MergeSide = Pick<MemoryCard, 'id' | 'scope' | 'createdAt'>

// —— 超出上限 ——

/** 自动放宽：用量超过上限后，每档把上限放宽 25%。 */
export const OVERFLOW_STEP = 0.25

/** 用量落在自动放宽的第几档：没超上限（或上限不是正数）为 0；超过上限 × (1 + 0.25(n-1)) 为第 n 档。 */
export function relaxedTier(usedTokens: number, budget: number): number {
  if (!(budget > 0) || usedTokens <= budget) return 0
  return Math.ceil(((usedTokens - budget) / OVERFLOW_STEP) / budget)
}

/** 第 tier 档放宽到的上限，取整；账本说明、超限卡、用量条都写这个数。 */
export function relaxedCap(budget: number, tier: number): number {
  return Math.round(budget * (1 + OVERFLOW_STEP * tier))
}

// —— 待处理 ——

/**
 * 待处理项的级别，按显示顺序：高优问题 must-fix（放着会泄露或丢数据）、待你处理 your-call（插件先按稳妥默认办，等你拍板）、
 * 建议整理 advice（不处理也不出错，整理后体检分更高；不亮左栏圆点、不算进 tab 主数）。
 * 每个待处理项属于且只属于一级；以后加级别时往这里追加。
 */
export const PENDING_LEVELS = ['must-fix', 'your-call', 'advice'] as const
export type PendingLevel = (typeof PENDING_LEVELS)[number]

/** 按级别排：同一级内的先后即视图里的先后。 */
export const PENDING_ITEM_KINDS = ['secret', 'unreadable-file', 'conflict-horizontal', 'conflict-vertical', 'promote-candidate', 'overflow', 'advice'] as const
export type PendingItemKind = (typeof PENDING_ITEM_KINDS)[number]

/** 每类待处理项归哪一级（写死，客户端不另行推导）。 */
export const PENDING_LEVEL_OF_KIND = {
  'secret': 'must-fix',
  'unreadable-file': 'must-fix',
  'conflict-horizontal': 'your-call',
  'conflict-vertical': 'your-call',
  'promote-candidate': 'your-call',
  'overflow': 'your-call',
  'advice': 'advice',
} as const satisfies Record<PendingItemKind, PendingLevel>

/**
 * 建议整理项的问题类型，按显示顺序。除 stale 外与体检发现（governance/schema.ts FINDING_TYPES）同名：
 * expired / bloat / orphan 由规则检查实时算；redundancy / misplaced / unclear 取该作用域上次语义体检的缓存（体检关闭时不出）；
 * stale = 超过类型衰退期没确认（健康分的新鲜度）。
 */
export const ADVICE_TYPES = ['expired', 'bloat', 'redundancy', 'orphan', 'misplaced', 'unclear', 'stale'] as const
export type AdviceType = (typeof ADVICE_TYPES)[number]

/** 能「忽略」的建议类型：除「很久没确认」外都能（它的出路是「仍然有效」或删除）。名字定义在 contract-codes（治理侧同用）。 */
export { IGNORABLE_ADVICE_TYPES, type IgnorableAdviceType } from '../contract-codes.ts'

/** 能「让模型改」（内容重复是「让模型合并」）的建议类型：服务端按它给默认要求，界面按它出按钮。放错层不在其中：改写不换作用域，它只问挪不挪。 */
export const MODEL_EDIT_ADVICE_TYPES = ['bloat', 'redundancy', 'unclear'] as const satisfies readonly AdviceType[]
export type ModelEditAdviceType = (typeof MODEL_EDIT_ADVICE_TYPES)[number]

/** 「等你决定」的口径（左栏圆点、设置页状态卡、健康页「待你决定」入口）：密钥与待你处理；读不出的文件、建议整理不算。 */
export function isAwaitingDecision(item: Pick<PendingItem, 'kind' | 'level'>): boolean {
  return item.kind === 'secret' || item.level === 'your-call'
}

const levelOf = <K extends PendingItemKind>(kind: K) => z.literal(PENDING_LEVEL_OF_KIND[kind])

/** 待处理项。冲突、提升候选、超限来自待决账本（带 decisionId）；密钥、读不出的文件与建议整理从预读数据派生，不入账本。
 *  冲突一方定位不到时为 null（账本悬空引用，裁决会报错）。 */
export const pendingItemSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('secret'), level: levelOf('secret'), memory: memoryCardSchema }),
  z.object({
    kind: z.literal('conflict-horizontal'), level: levelOf('conflict-horizontal'), decisionId: z.string(), firstSeenAt: z.number(), summary: z.string(),
    left: memoryCardSchema.nullable(), right: memoryCardSchema.nullable(),
    /** 决定前 agent 按哪条来：快照注入的排序（confidence 降序 → lastConfirmedAt 降序）排在前的一方；两方都找不到时缺省。 */
    preferredId: z.string().optional(),
  }),
  z.object({
    kind: z.literal('conflict-vertical'), level: levelOf('conflict-vertical'), decisionId: z.string(), firstSeenAt: z.number(), summary: z.string(),
    memory: memoryCardSchema.nullable(), baselineRef: z.string(),
  }),
  z.object({
    kind: z.literal('promote-candidate'), level: levelOf('promote-candidate'), decisionId: z.string(), firstSeenAt: z.number(),
    memory: memoryCardSchema.nullable(),
  }),
  /** 超出上限：relax 第 tier 档（放宽到上限 × (1 + 0.25 × tier)）；strict 用到 95%（tier 为 0）。workspacePath 缺省 = 无项目的会话。 */
  z.object({
    kind: z.literal('overflow'), level: levelOf('overflow'), decisionId: z.string(), firstSeenAt: z.number(),
    mode: z.enum(OVERFLOW_MODES), tier: z.number().int().nonnegative(), workspacePath: z.string().optional(),
  }),
  z.object({
    kind: z.literal('unreadable-file'), level: levelOf('unreadable-file'), layer: scopeSchema,
    filePath: z.string(), relativePath: z.string(),
    /** 解析器原话。 */
    error: z.string(),
  }),
  /**
   * 建议整理：每次生成视图时现算，不入账本。身份 = type + 涉及的记忆 id（memories 的 id，成对的按 id 排序）。
   * redundancy 一般是两条（互相重复）；只有一条时是和指令文件（AGENTS.md 等）重复。其余类型每项一条记忆。
   */
  z.object({
    kind: z.literal('advice'), level: levelOf('advice'), type: z.enum(ADVICE_TYPES),
    memories: z.array(memoryCardSchema).min(1),
  }),
])
export type PendingItem = z.infer<typeof pendingItemSchema>

/**
 * 待处理项的身份（判新增、「全部」里去重）：账本来的按条目 id；密钥按作用域 + 记忆 id；读不出的文件按路径；
 * 建议整理按类型 + 排序后的记忆 id。服务端和客户端共用。
 */
export function pendingItemKey(item: PendingItem): string {
  switch (item.kind) {
    case 'secret': return `secret:${item.memory.scope}:${item.memory.workspacePath ?? ''}:${item.memory.id}`
    case 'unreadable-file': return `unreadable-file:${item.filePath}`
    case 'advice': return `advice:${item.type}:${item.memories.map(m => m.id).sort().join(',')}`
    default: return `decision:${item.decisionId}`
  }
}

/**
 * 待处理项属于哪些范围（全局或某个项目；「全部」包含一切，不在返回里），不重复，按出现先后。服务端和客户端共用：
 * 记忆类条目和基线冲突按记忆所在作用域；冲突按双方各自的作用域（全局和项目之间的属于两个范围）；超限按它的作用域
 * （没有项目的会话归全局）；读不出的文件按所在目录；建议整理按涉及记忆各自的作用域。定位不到作用域的记忆不算。
 */
export function pendingItemScopes(item: PendingItem): Scope[] {
  const scopes = ((): Array<Scope | undefined> => {
    switch (item.kind) {
      case 'unreadable-file': return [item.layer]
      case 'overflow': return [item.workspacePath === undefined ? { kind: 'global' } : { kind: 'workspace', workspacePath: item.workspacePath }]
      case 'conflict-horizontal': return [item.left, item.right].map(m => m === null ? undefined : scopeOfMemory(m))
      case 'advice': return item.memories.map(scopeOfMemory)
      default: return [item.memory === null ? undefined : scopeOfMemory(item.memory)]
    }
  })()
  const out: Scope[] = []
  for (const scope of scopes) if (scope !== undefined && !out.some(s => sameScope(s, scope))) out.push(scope)
  return out
}

/** 左栏图标圆点：密钥红点盖过琥珀点；读不出的文件、建议整理不亮点。 */
export const PENDING_DOTS = ['none', 'amber', 'red'] as const

/** 待处理（全部作用域），按 PENDING_ITEM_KINDS 顺序（先按级别）、同类按 firstSeenAt 升序；建议整理按 ADVICE_TYPES、作用域（global 在前）、名称排。 */
export const pendingViewSchema = z.object({
  version,
  generatedAt,
  dot: z.enum(PENDING_DOTS),
  items: z.array(pendingItemSchema),
  /** 各级的条数（每一级都有，没有为 0）。 */
  levelCounts: z.record(z.enum(PENDING_LEVELS), z.number().int().nonnegative()),
  /** 类型 id → 显示名（注册表的 label），供记忆卡元信息；认不出的类型显示 id。 */
  typeLabels: z.record(z.string(), z.string()),
})
export type PendingView = z.infer<typeof pendingViewSchema>

/**
 * 冲突裁决按钮到 verdict 的映射（写死，客户端不另行推导）。横向：A = memoryIds[0]、B = memoryIds[1]；
 * 垂直：「以基线为准」删记忆，「保留这条记忆」两边都留。dismiss 不从界面发出。
 */
export const CONFLICT_ACTION_VERDICTS = {
  horizontal: { keepA: 'keep-left', keepB: 'keep-right', keepBoth: 'keep-both' },
  vertical: { keepBaseline: 'keep-right', keepMemory: 'keep-left' },
} as const
export const RESOLVE_VERDICTS = ['keep-left', 'keep-right', 'keep-both'] as const

// —— 健康 ——

/** 一项扣分：扣了多少分，包含哪些问题类型（扣 0 分时为空）。 */
const deductionSchema = z.object({ points: z.number().nonnegative(), types: z.array(z.string()) })

export const healthScopeSchema = z.object({
  layer: scopeSchema,
  totalMemories: z.number().int().nonnegative(),
  /** 有密钥时该作用域不打分：null。 */
  score: z.number().nullable(),
  tier: z.enum(['green', 'amber', 'red']),
  gate: z.object({ secret: z.boolean() }),
  /** 非零的扣分原因计数（规则检查实时 + 内容检查取上次体检），type 取值见 governance/schema.ts FINDING_TYPES，按其顺序。 */
  issues: z.array(z.object({ type: z.string(), count: z.number().int().positive() })),
  /**
   * 上次体检：本作用域最近一次体检完成记录的完成时间（规则检查和内容检查都写完才算）；还没有完成记录（升级前体检过）时
   * 暂取内容检查缓存的时间；从没体检过为 null。
   */
  lastCheckupAt: z.number().nullable(),
  /**
   * 本作用域被用户忽略、没有计分的建议（issues 里已不含它们），按问题类型、再按第一条记忆名排；条数即长度。
   * memories 是涉及的记忆（内容重复两条，按 id 排序），名称与摘要已遮盖密钥；取消忽略按 type + 这些 id 发 unignore-advice。
   */
  ignored: z.array(z.object({
    type: z.enum(IGNORABLE_ADVICE_TYPES),
    memories: z.array(z.object({ id: z.string(), name: z.string(), summary: z.string() })).min(1),
  })),
  /**
   * 扣分来源：评分模块分开算好的三项扣分（规则检查、内容检查、新鲜度，保留两位小数；评分公式不变，没有密钥时 100 减三项即分数），
   * 以及各项里此刻有的问题类型：规则检查、内容检查的取值见 governance/schema.ts FINDING_TYPES，按其顺序；新鲜度是 stale。
   * 密钥不扣分（走红线门），不在这里。
   */
  deductions: z.object({ rule: deductionSchema, content: deductionSchema, freshness: deductionSchema }),
})
export const healthViewSchema = z.object({
  version,
  generatedAt,
  /** 体检开关（governance.enabled）：关闭时界面置灰健康内容、「体检当前项目」不可用。 */
  governanceEnabled: z.boolean(),
  /** 插件本次加载的时刻（epoch ms）：会话快照的 frozenAt 早于它就是「重启后未重新带入」；浏览器半侧拿不到宿主进程时间，从这里读。 */
  bootedAt: z.number().optional(),
  layers: z.array(healthScopeSchema),
})
export type HealthView = z.infer<typeof healthViewSchema>

// —— 全部记忆 ——

export const directoryIssueSchema = z.object({
  code: z.enum(DIRECTORY_NOTE_CODES),
  /** 涉及的文件或目录的绝对路径。 */
  path: z.string(),
  /** reserved-keys：被忽略的键。 */
  keys: z.array(z.string()).optional(),
  /** duplicate-id：读取时用的那份（path 是没用上的副本）。 */
  keptPath: z.string().optional(),
})

export { MODEL_CHANGE_KINDS, type ModelChangeKind } from '../contract-codes.ts'

/** 场景：通用场景 id、每个场景的类型上限、通用以外的场景个数上限（设置页用）。 */
export { GENERAL_SCENE, MAX_SCENES, SCENE_MAX_TYPES } from '../contract-codes.ts'

/** 模型改写、替代此刻能不能撤：undoable 能；changed 之后又被改过（手改、模型再改、删除），不覆盖；undone 已撤销。 */
export const MODEL_CHANGE_STATES = ['undoable', 'changed', 'undone'] as const
export type ModelChangeState = (typeof MODEL_CHANGE_STATES)[number]

/**
 * 模型用 memory_save 改写已有记忆（rewrite）或把旧记忆标成已取代（supersede）的一次改动，撤销按 decisionId 发 undo。
 * 对话卡按 sessionId + callId 认领自己那次调用的，右侧栏「这次新写入的」按 sessionId 认领。
 */
export const modelChangeSchema = z.object({
  decisionId: z.string(),
  kind: z.enum(MODEL_CHANGE_KINDS),
  /** 改写：被改写的那条；替代：被替代的旧记忆。 */
  memoryId: z.string(),
  /** 替代：替代它的那条。 */
  by: z.string().optional(),
  /** 改前的那份（快照里的），文字已遮盖密钥。 */
  before: memoryCardSchema,
  sessionId: z.string(),
  callId: z.string(),
  at: z.number(),
  state: z.enum(MODEL_CHANGE_STATES),
})
export type ModelChange = z.infer<typeof modelChangeSchema>

export const libraryViewSchema = z.object({
  version,
  generatedAt,
  /** 存储目录（绝对路径）。 */
  memoryRoot: z.string(),
  /** global 在前，项目按路径排序；每个作用域只列 active 记忆，按 name 再 id 排序。 */
  layers: z.array(z.object({ layer: scopeSchema, items: z.array(memoryCardSchema) })),
  /** 目录问题：同 id 多份副本、被忽略的字段、缺标记 / 不可读目录。 */
  directoryIssues: z.array(directoryIssueSchema),
  /**
   * 判「彻底删除」的正面信号（对话卡用）：这次收集读到、但不在用的记忆 id（已取代、已删，含超出保留期还没清掉的），
   * 和有没有读不全的地方（读不出的文件、缺标记或不可读的目录，里面可能有任何 id）。一条记忆不在全部记忆、最近删除、
   * inactiveIds 里，且没有读不全的地方，才算从磁盘上没了。可缺省：升级前写的视图文件没有，缺省时不判彻底删除。
   */
  inactiveIds: z.array(z.string()).optional(),
  hasUnreadFiles: z.boolean().optional(),
  /** 类型 id → 显示名（同待处理视图的 typeLabels），覆盖注册表与本视图出现的类型。可缺省：升级前写的视图文件没有，下次写视图补上。 */
  typeLabels: z.record(z.string(), z.string()).optional(),
  /**
   * 记忆查看里类型组的顺序：当前场景的类型按注册表顺序在前，本视图出现的其他类型（退役、切场景前的、认不出的）按 id 在后。
   * 可缺省，理由同上；缺省时按显示名排。
   */
  typeOrder: z.array(z.string()).optional(),
  /**
   * 保留窗口内模型改写、替代已有记忆的改动，按时间先后。改前快照已清（过了 14 天、彻底删除）的不列：
   * 对话卡对不上自己那次调用时，按调用时刻判断是不是已超过保留窗口。可缺省，理由同上。
   */
  modelChanges: z.array(modelChangeSchema).optional(),
})
export type LibraryView = z.infer<typeof libraryViewSchema>

// —— 最近删除 ——

export const deletedItemSchema = z.object({
  memory: memoryCardSchema,
  deletedAt: z.number(),
  /** 到这个时刻被物理清掉，之后不可恢复。 */
  purgeAt: z.number(),
  /** 裁决时删掉的：哪条冲突、什么裁决、对方是谁（横向为对方记忆 id，垂直为基线出处）。 */
  cause: z.object({
    decisionId: z.string(),
    verdict: z.enum(['keep-left', 'keep-right']),
    counterpartId: z.string().optional(),
    baselineRef: z.string().optional(),
    snapshotId: z.string().optional(),
  }).optional(),
})
/** 14 天内软删的记忆，按删除时间倒序。密钥是物理删除，不在这里。 */
export const deletedViewSchema = z.object({
  version,
  generatedAt,
  items: z.array(deletedItemSchema),
  /** 类型 id → 显示名（同全部记忆视图的 typeLabels），另含裁决对方的类型。可缺省，理由同上。 */
  typeLabels: z.record(z.string(), z.string()).optional(),
})
export type DeletedView = z.infer<typeof deletedViewSchema>

// —— 这次对话 ——

/**
 * 快照的来历：对话开始时首次带入 / 续上已有轮次的会话时重新带入（宿主重启后续上、插件重载）/ 成功压缩后重新带入 /
 * 对话中其他重建（配置热更新、失败的压缩）补发了新快照。其他重建文本没变（不补发）时沿用上一次的来历。
 */
export const SNAPSHOT_ORIGINS = ['start', 'resumed', 'compacted', 'refreshed'] as const
export type SnapshotOrigin = typeof SNAPSHOT_ORIGINS[number]

/** 一个会话冻结快照时带入的记忆与用量。token 是插件估算（estimateTokens），界面带「约」。 */
export const sessionViewSchema = z.object({
  version,
  sessionId: z.string(),
  workspacePath: z.string().optional(),
  /** 快照冻结时刻；早于宿主启动时间说明重启后还没重新带入。 */
  frozenAt: z.number(),
  origin: z.enum(SNAPSHOT_ORIGINS),
  /** 最近一次成功压缩结束的时刻（宿主事件时间）；origin 为 compacted 时才有。 */
  compactedAt: z.number().optional(),
  budget: z.number().nonnegative(),
  overflowMode: z.enum(OVERFLOW_MODES),
  /** 三段之和即总用量：本项目、全局、固定说明（标题、附注、导航图、固定尾注）。 */
  tokens: z.object({ workspace: z.number(), global: z.number(), fixed: z.number() }),
  /** 计入上限的部分（附注、固定尾注与导航图不计）：relax 下超过 budget 即已放宽，strict 下不超过 budget。 */
  usedTokens: z.number().int().nonnegative(),
  injectedIds: z.array(z.string()),
  /** injectedIds 里带入全文的（core 区）；其余只带了索引行。 */
  coreIds: z.array(z.string()),
  /** injectedIds 里索引行只带名称和标签、不带摘要的（passive 类型）；不在这两组里的是带摘要的索引行。 */
  titleOnlyIds: z.array(z.string()),
  /** 没带入的条数（只有 strict 会截）：「已到上限，N 条没带入」。 */
  omittedCount: z.number().int().nonnegative(),
  /** 这次对话新记的（按写入先后）。冻结晚于写入的会同时出现在 injectedIds 里：界面只列在带入的记忆。 */
  savedIds: z.array(z.string()),
})
export type SessionView = z.infer<typeof sessionViewSchema>

// —— 会话归属 ——

/** 会话归属对照的文件名（在视图目录里，与全局视图并列，不随 refresh-views 重写）。 */
export const GUI_WORKSPACE_MAP_FILE = 'workspaces.json'

/**
 * 会话归属对照：服务端每次解析会话所属项目（会话出现、快照冻结、工具调用、/memory 命令）都记一笔，
 * 宿主给的原始 cwd → realpath 后最近的已注册项目目录（不在任何项目里时是 realpath 后的 cwd 本身）。
 * 浏览器半侧解析不了软链接，也不知道哪些目录注册成了项目，判断会话属于哪个项目时以它为准。
 */
export const workspaceMapViewSchema = z.object({
  version,
  cwds: z.record(z.string(), z.string()),
})
export type WorkspaceMapView = z.infer<typeof workspaceMapViewSchema>

// —— 自动体检 ——

/** 「全部」的体检键；全局和项目取标准键（见 checkupKey）。自动体检设置表、体检记录表按体检键存。 */
export const SCOPE_KEYS = { all: 'all' } as const

/** 范围：记忆页左栏选中的对象。「全部」是所有作用域的合称，本身不是作用域、不单独体检，自动体检的默认值记在它上面。 */
export const scopeOrAllSchema = z.discriminatedUnion('kind', [z.object({ kind: z.literal('all') }), ...scopeSchema.options])
export type ScopeOrAll = z.infer<typeof scopeOrAllSchema>

/** 体检键（自动体检设置表、体检记录表按它存）：「全部」取 `all`，作用域取标准键。 */
export function checkupKey(scope: ScopeOrAll): string {
  return scope.kind === 'all' ? SCOPE_KEYS.all : scopeKey(scope)
}

/** 自动体检「每 N 天」的上限。 */
export const AUTO_CHECKUP_MAX_DAYS = 90
/** 自动体检频率：manual = 仅手动；整数 N = 每 N 天（1 即每天），1–AUTO_CHECKUP_MAX_DAYS。 */
export const autoCheckupFrequencySchema = z.union([z.literal('manual'), z.number().int().min(1).max(AUTO_CHECKUP_MAX_DAYS)])
export type AutoCheckupFrequency = z.infer<typeof autoCheckupFrequencySchema>
/** set-auto-checkup 的「跟随」：删掉这个范围的设置，改回跟随「全部」。 */
export const AUTO_CHECKUP_FOLLOW = 'follow'

/**
 * 自动体检的继承解析：settings 是设置表的内容（范围键 → 设了的频率）。「全部」的值是默认值，没设就是仅手动；
 * 全局和项目没有条目时跟随它，有条目就是单独设置（值和默认值相同也算），之后改「全部」它不跟。
 */
export function resolveAutoCheckup(settings: ReadonlyMap<string, AutoCheckupFrequency>, scope: ScopeOrAll): { frequency: AutoCheckupFrequency; isOwn: boolean } {
  const fallback = settings.get(SCOPE_KEYS.all) ?? 'manual'
  if (scope.kind === 'all') return { frequency: fallback, isOwn: false }
  const own = settings.get(checkupKey(scope))
  return own === undefined ? { frequency: fallback, isOwn: false } : { frequency: own, isOwn: true }
}

/**
 * 自动体检这次没做完、或模型用不了的原因（体检记录表与体检视图共用）。kind 见 CHECKUP_CAUSE_KINDS；
 * hostCode 是宿主给的错误码（如 ACCOUNT_SIGN_IN_REQUIRED、RATE_LIMIT），宿主给了才有；message 是宿主或体检的原话，界面按 kind 和 hostCode 写说明，原话只作补充。
 */
export const checkupCauseSchema = z.object({
  kind: z.enum(CHECKUP_CAUSE_KINDS),
  hostCode: z.string().optional(),
  message: z.string().optional(),
})
export type CheckupCause = z.infer<typeof checkupCauseSchema>

/** 体检新增的一组：条目身份（pendingItemKey，按待处理视图里的先后）和条数，pending = 先处理 + 等你决定，advice = 可以整理。 */
export const checkupAddedSchema = z.object({
  keys: z.array(z.string()),
  pending: z.number().int().nonnegative(),
  advice: z.number().int().nonnegative(),
})
export type CheckupAdded = z.infer<typeof checkupAddedSchema>

/**
 * 一次界面手动体检或自动体检的最近一次结果（体检记录表与体检视图共用）。agent 的 memory_scan 不写。
 * 新增 = 体检后的待处理里有、体检前没有（只看这次体检覆盖的作用域，同 scan 命令的 added），按条目属于哪些范围（pendingItemScopes）记：
 * - 全局、项目的记录：added 是属于这个范围的新增。项目体检会读全局，顺带发现、只属于全局的新增（如两条全局记忆之间的冲突）
 *   不算进 added，记在 globalAdded（只有项目体检写的结果有）；全局和项目之间的冲突属于两个范围，算项目的。
 * - 键 all 的记录（「全部」手动体检，见 SCOPE_KEYS）：added 是全部新增，按身份去重；byScope 把新增按所属范围分组
 *   （跨两个范围的条目两组都有），全局在前、项目按路径，没有新增的范围不列。
 * 「全部」体检写的各范围结果不带用量：整次体检的用量分不到范围，只记在 all 上。说明码（notes）是这次体检的，各范围同记。
 */
export const checkupResultSchema = z.object({
  /** 体检标识：同一次体检写的各条结果相同。 */
  checkupId: z.string(),
  by: z.enum(CHECKUP_INITIATORS).exclude(['agent']),
  /** 体检做完（写结果）的时刻。 */
  completedAt: z.number(),
  added: checkupAddedSchema,
  globalAdded: checkupAddedSchema.optional(),
  byScope: z.array(z.object({ scope: scopeSchema, keys: z.array(z.string()) })).optional(),
  /** 宿主流 usage 块报的实际用量合计（同 scan 命令的 usageTokens）；宿主一次都没报时缺省。自动体检不经过会话，用量由插件自己记在这里。 */
  usageTokens: z.number().int().nonnegative().optional(),
  /** 说明码（如内容检查没做完 semantic-failed、分了批 semantic-batched、基线检查被跳过 baseline-missing），semantic-failed、model-unavailable 带原因。 */
  notes: z.array(z.object({ code: z.enum(SCAN_NOTE_CODES), cause: checkupCauseSchema.optional() })),
})
export type CheckupResult = z.infer<typeof checkupResultSchema>

/** 体检视图的文件名（在视图目录里，与全局视图并列）。 */
export const GUI_CHECKUP_VIEW_FILE = 'checkups.json'

/**
 * 体检视图：只写各进程共有的事实（共享的设置表和体检记录），所有窗口看到同一份。在设置改了、体检做完或没做成、
 * 调度检查发现状态变了（到期了、别的进程写了完成记录）、体检认领和释放时重写，内容没变不重写。
 */
export const checkupViewSchema = z.object({
  version,
  generatedAt,
  /** 体检开关（本进程的配置，几个进程不一致时以后写的为准）：关着时自动体检不跑。 */
  governanceEnabled: z.boolean(),
  /** 「全部」的频率，即默认值；没设过为 manual（仅手动）。 */
  defaultFrequency: autoCheckupFrequencySchema,
  /** 「全部」手动体检的最近一次结果（体检记录表键 all 的那条）；没做过为 null。 */
  allResult: checkupResultSchema.nullable(),
  /** 全局在前，项目按路径排序（与健康视图同一批作用域）。 */
  scopes: z.array(z.object({
    scope: scopeSchema,
    /** 有效频率（见 resolveAutoCheckup）。 */
    frequency: autoCheckupFrequencySchema,
    /** 单独设置；false = 跟随「全部」。 */
    isOwn: z.boolean(),
    /** 上次体检：最近一次体检完成记录的完成时间（升级前体检过、还没有完成记录的取内容检查缓存的时间）；从没体检过为 null。 */
    lastCheckupAt: z.number().nullable(),
    /** 下次自动体检：上次体检加有效频率的天数；仅手动、从没体检过为 null。 */
    nextCheckupAt: z.number().nullable(),
    /** 已到期：有效频率不是仅手动，且从没体检过或已到下次自动体检的时间。 */
    isDue: z.boolean(),
    /** 进行中：有体检（任一进程的手动或自动体检）认领着这个范围、认领没过期。agent 的 memory_scan 不认领，不算。 */
    isInProgress: z.boolean(),
    /**
     * 自动体检连续没做完（模型调用出错、输出解析不了、体检出错）：次数、下次重试时间、最近一次的原因。
     * 没到上限时 1 小时后再试；到了上限（isRetryLimitReached）等到下一个周期。到期了但还没到重试时间的不跑。
     * 这个范围做完一次体检（手动、自动、agent）就清掉；没有为 null。
     */
    failure: z.object({
      count: z.number().int().positive(),
      retryAt: z.number(),
      isRetryLimitReached: z.boolean(),
      cause: checkupCauseSchema,
    }).nullable(),
    /** 最近一次自动体检的尝试是「模型用不了」（宿主没有默认模型、未登录、缺凭据）：原因；不是为 null。不算失败，下一次调度检查再试。 */
    modelUnavailable: checkupCauseSchema.nullable(),
    /** 这个范围最近一次界面手动或自动体检的结果（「全部」体检也给每个被查的范围写一条）；没有为 null。 */
    lastResult: checkupResultSchema.nullable(),
  })),
})
export type CheckupView = z.infer<typeof checkupViewSchema>

// —— 命令 ——

const allowCrossWorkspace = z.boolean().optional()
/** 记忆类型的英文名：小写字母和连字符（同 types.ts 的类型标识约定、设置页的校验）。 */
const typeNameSchema = z.string().regex(/^[a-z]+(?:-[a-z]+)*$/)
/** 目标记忆所在的作用域（见 scopeOfMemory）：服务端只动这一份，跨项目门仍按借来的会话判定；缺省按借来的会话定位。 */
const targetScope = scopeSchema.optional()

/** 卡片加载时记忆的版本（MemoryCard 的 updatedAt 与 digest）。 */
const memoryBaseSchema = z.object({ updatedAt: z.number(), digest: z.string() })
const mergeRefSchema = z.object({ memoryId: z.string(), layer: targetScope, base: memoryBaseSchema })
/** 「整理所选」一次最多几条：记忆查看多选的上限，整理命令的条数上限也用它（暂定，真机测过计划质量再定）。 */
export const MAX_BATCH_EDIT = 20
const draftRefSchema = z.object({ memoryId: z.string(), layer: targetScope })

/** 「让模型改」的一稿：正文、摘要每次都有；名称、标签缺省 = 模型没改。只在界面和命令之间来回，不落盘。 */
export const memoryDraftSchema = z.object({
  content: z.string().min(1),
  summary: z.string(),
  name: z.string().min(1).optional(),
  tags: z.array(z.string()).optional(),
})
export type MemoryDraft = z.infer<typeof memoryDraftSchema>
/** 整理计划里模型给的提问：问题，和不回答时的默认处理（输入框的占位文字）。 */
const planQuestionSchema = z.object({ text: z.string(), placeholder: z.string() })
/** 「整理所选」里单项「再改改」带的这一项计划：用户确认过的理由、提问和回答（没回答 = 按默认处理）。 */
export const planNoteSchema = z.object({ reason: z.string(), question: planQuestionSchema.optional(), answer: z.string().optional() })
export type PlanNote = z.infer<typeof planNoteSchema>
/** 整理计划里每条记忆的动作：改写、删除、不动。 */
export const PLAN_ACTIONS = ['rewrite', 'delete', 'keep'] as const
export type PlanAction = (typeof PLAN_ACTIONS)[number]
/**
 * 整理计划（plan-edits 的结果）：understanding 一两句复述用户要什么；ops 每条选中的记忆恰好一项，按选中的顺序。
 * into 只在删除项上，指承接它内容的那条（本次选中的另一条，动作是改写或不动）；question 只在改写项上。只在界面和命令之间来回，不落盘。
 */
export const editPlanSchema = z.object({
  understanding: z.string(),
  ops: z.array(z.object({
    memoryId: z.string(),
    action: z.enum(PLAN_ACTIONS),
    reason: z.string(),
    into: z.string().optional(),
    question: planQuestionSchema.optional(),
  })),
})
export type EditPlan = z.infer<typeof editPlanSchema>
export type PlanOp = EditPlan['ops'][number]
/**
 * 按计划出稿（draft-plan）的一个改写项：用户确认过的理由、提问和回答（没回答 = 按默认处理），
 * absorbs 是计划里内容并进这一项、用户确认要删的记忆（into 指向这一项的删除项）。
 */
export const draftPlanOpSchema = z.object({
  memoryId: z.string(),
  reason: z.string(),
  question: planQuestionSchema.optional(),
  answer: z.string().optional(),
  absorbs: z.array(z.string()).optional(),
})
export type DraftPlanOp = z.infer<typeof draftPlanOpSchema>
/**
 * 「整理所选」应用的一项（apply-edits 的 ops）：改写带写进去的四个面（同直接改）；删除带 into，是计划里承接它内容的那条
 * （本批的某个改写项或 keep 里的一条）。都带卡片版本。
 */
export const applyEditOpSchema = z.discriminatedUnion('kind', [
  mergeRefSchema.extend({ kind: z.literal('edit'), content: z.string().min(1), name: z.string().min(1), summary: z.string(), tags: z.array(z.string()) }),
  mergeRefSchema.extend({ kind: z.literal('forget'), into: z.string().optional() }),
])
export type ApplyEditOp = z.infer<typeof applyEditOpSchema>
/** 直接改、直接合并写进去的四个字段；force：疑似密钥经用户确认后放行（高危密钥一律拦）。 */
const editFields = {
  content: z.string().min(1),
  name: z.string().min(1),
  summary: z.string(),
  tags: z.array(z.string()),
  force: z.boolean().optional(),
  allowCrossWorkspace,
}

/** 宿主命令名（不带斜杠）。 */
export const MEMORY_COMMAND_NAME = 'memory'

/**
 * `/memory` 子命令的参数。文本编码：`/memory <cmd> <其余字段的 JSON 对象>`，没有其余字段时只写子命令，
 * 如 `/memory info`、`/memory resolve {"decisionId":"pd_x","verdict":"keep-left"}`（见 encodeMemoryCommand）。
 */
export const memoryCommandSchema = z.discriminatedUnion('cmd', [
  z.object({ cmd: z.literal('info') }),
  z.object({ cmd: z.literal('resolve'), decisionId: z.string(), verdict: z.enum(RESOLVE_VERDICTS), allowCrossWorkspace }),
  /** 撤销一条已裁决条目：去掉 settled，记了快照的按它恢复败方（提升为全局则恢复原位）；直接改、移到项目的撤销后条目移出账本；
   *  模型改写、替代（全部记忆视图的 modelChanges）按改前快照恢复，撤销后条目标已撤销留着。
   *  六类撤销遇到目标之后又被改过（或已不在原处）一律回 stale、条目留着；合并的撤销不会只恢复一半：要么都不动，要么写回的那条中途被第三方改过、停在第三方的版本。 */
  z.object({ cmd: z.literal('undo'), decisionId: z.string(), allowCrossWorkspace }),
  z.object({ cmd: z.literal('promote'), decisionId: z.string(), target: z.enum(['global', 'agents-md']), allowCrossWorkspace }),
  z.object({ cmd: z.literal('keep-local'), decisionId: z.string(), allowCrossWorkspace }),
  /**
   * 按记忆 id 把一条项目记忆提升为全局（建议整理「放错层」）。同 promote：快照先行，在账本里留一条已结清的提升
   * （记忆已是提升候选时就结清那一条），结果的 decisionId 交给 undo 撤销。isCandidateRequired：就地提升（对话卡片、右侧栏
   * 「这次新写入的」）只认此刻仍是提升候选的那一份，别处已「留在本项目」的回 not-found。target 同 promote，缺省 global：
   * agents-md 写进 AGENTS.md、项目里那条软删，插件不再管理它，不留账、不可撤销（结果不带 decisionId）。
   */
  z.object({
    cmd: z.literal('promote-memory'), memoryId: z.string(), layer: targetScope, isCandidateRequired: z.boolean().optional(),
    target: z.enum(['global', 'agents-md']).optional(), allowCrossWorkspace,
  }),
  /**
   * 按记忆 id 把一条提升候选留在本项目（对话卡片、右侧栏「这次新写入的」）。同 keep-local：清掉候选标记，在账本里留一条
   * 已结清的 keep-local（记忆已在等你决定里时就结清那一条），以后体检不再提。不是候选（已提升、已留下、已删）回 not-found。
   */
  z.object({ cmd: z.literal('keep-local-memory'), memoryId: z.string(), layer: targetScope, allowCrossWorkspace }),
  /**
   * 把一条全局记忆移到 workspacePath 那个项目（建议整理「放错层」里全局那条，与 promote-memory 对称）：只认全局那一份，
   * 内容、id、出处、时间戳不动，全局那份不再存在。目标项目已有同 id 的记忆（在用的或最近删除里的）回 target-taken，什么都不动。
   * 跨项目门按目标项目判。快照先行，在账本里留一条已结清的移动，结果的 decisionId 交给 undo 撤销（搬回全局）。
   */
  z.object({ cmd: z.literal('move-memory'), memoryId: z.string(), workspacePath: z.string(), allowCrossWorkspace }),
  z.object({ cmd: z.literal('forget'), memoryId: z.string(), layer: targetScope, allowCrossWorkspace }),
  /** 从最近删除恢复一条记忆：它是某次裁决删掉的、那次裁决还能撤销时，等同撤销那次裁决（错误码与 undo 一致）；否则按快照或归档恢复。 */
  z.object({ cmd: z.literal('restore'), memoryId: z.string(), layer: targetScope, allowCrossWorkspace }),
  /** 彻底删除：在用的只收含密钥的；最近删除里的不等 14 天到期，连同快照里的副本现在就清掉。 */
  z.object({ cmd: z.literal('hard-delete'), memoryId: z.string(), layer: targetScope, allowCrossWorkspace }),
  /** 刷新一条记忆的确认时间（建议整理「很久没确认」的「仍然有效」），内容不动。不受体检开关影响。 */
  z.object({ cmd: z.literal('confirm'), memoryId: z.string(), layer: targetScope, allowCrossWorkspace }),
  /**
   * 建议整理的「直接改」：正文、名称、摘要、标签换成给定值，updatedAt、lastConfirmedAt 记为当前时间，标手改（模型改写、替代前要先问用户）；
   * 类型、作用域、出处、有效期、置信度、取代关系、召回统计不动。base 是卡片加载时的版本，磁盘上对不上回 stale，什么都不动。
   * 新内容含高危密钥回 secret-critical；疑似密钥回 secret-suspected，用户确认后带 force 重发。快照先行（项目记忆也拍），
   * 在账本里留一条已结清的条目，结果的 decisionId 交给 undo 撤销。
   */
  z.object({ cmd: z.literal('edit-memory'), memoryId: z.string(), layer: targetScope, base: memoryBaseSchema, ...editFields }),
  /**
   * 内容重复的「直接合并」：两条里按 mergeKeeperIndex 保留一条，按 edit-memory 的规则改成给定内容；另一条软删进最近删除。
   * 两条同拍一份快照，undo 把两条都恢复。
   */
  z.object({ cmd: z.literal('merge-memories'), memories: z.tuple([mergeRefSchema, mergeRefSchema]), ...editFields }),
  /** 借来的会话用哪个模型（「让模型改」的按钮与提示）：拿不到回 llm-unavailable；拿到了但不知道名字时 model 缺省。只读。 */
  z.object({ cmd: z.literal('model-info') }),
  /**
   * 「让模型改 / 让模型合并」的生成：一条（合并时两条）记忆按建议类型的默认要求、或用户写的 request，单次调用借来的会话的模型，
   * 回一稿改后的内容（结果的 draft）。只读：不写记忆、不拍快照、不入账本、不进会话记录；「应用」由界面改发 edit-memory / merge-memories。
   * adviceType 缺省（记忆查看里的修改，不是从建议来的）时 request 必填。
   * previous：「再改改」时的上一稿，模型在它的基础上接着改；priorRequests：此前每一轮的要求，按先后排列；
   * planNote：「整理所选」单项再改改时这一项的计划；absorbs：同时并进这一项、应用后会删除的记忆（计划里 into 指向这一项的删除项），
   * 要在用、与 memories 同一作用域、不与 memories 重复，否则回 not-found / invalid-args。含密钥的记忆（含 absorbs）回 has-secret，原文不发给模型；
   * request、priorRequests、planNote、previous 任一处含高危密钥回 secret-critical，同样不发。
   */
  z.object({
    cmd: z.literal('draft-edit'),
    adviceType: z.enum(MODEL_EDIT_ADVICE_TYPES).optional(),
    memories: z.union([z.tuple([draftRefSchema]), z.tuple([draftRefSchema, draftRefSchema])]),
    request: z.string().optional(),
    priorRequests: z.array(z.string()).optional(),
    planNote: planNoteSchema.optional(),
    absorbs: z.array(draftRefSchema).max(MAX_BATCH_EDIT).optional(),
    previous: memoryDraftSchema.optional(),
  }).refine(c => c.adviceType !== undefined || (c.request ?? '').trim() !== '', { message: '没有建议类型时要写 request', path: ['request'] }),
  /**
   * 「整理所选」的计划：选中的 2–20 条记忆（同一作用域，各带卡片版本）和用户的要求，单次调用借来的会话的模型，回一份整理计划（结果的 plan）。
   * 只读：不写记忆、不拍快照、不入账本，不过跨项目门（同 draft-edit）。目标 id 重复、不在同一作用域回 invalid-args；版本对不上回 stale；
   * 含密钥的记忆回 has-secret、要求含高危密钥回 secret-critical，都不发给模型；模型的计划漏条、多条、into / question 不合规则回 llm-invalid-output。
   */
  z.object({
    cmd: z.literal('plan-edits'),
    memories: z.array(mergeRefSchema).min(2).max(MAX_BATCH_EDIT),
    request: z.string().refine(s => s.trim() !== '', { message: '要写 request' }),
  }),
  /**
   * 「整理所选」按计划出稿：plan-edits 的选中记忆和要求，加上用户勾选的改写项（ops，1 项起，选中记忆的无重复子集），
   * 单次调用借来的会话的模型，每个改写项回一稿（结果的 drafts）。选中的全部记忆都作为上下文给模型；删除项不需要稿，不进这条命令。
   * 只读，不过跨项目门（同 plan-edits）。ops 不是子集、absorbs 不在选中里或落在 ops 上或被两项承接回 invalid-args；
   * 要求、理由、提问、回答任一处含高危密钥回 secret-critical；模型没给齐每项恰好一稿回 llm-invalid-output。其余同 plan-edits。
   */
  z.object({
    cmd: z.literal('draft-plan'),
    memories: z.array(mergeRefSchema).min(2).max(MAX_BATCH_EDIT),
    request: z.string().refine(s => s.trim() !== '', { message: '要写 request' }),
    ops: z.array(draftPlanOpSchema).min(1).max(MAX_BATCH_EDIT),
  }),
  /**
   * 「整理所选」的应用全部：ops 是对照后要写的 1–20 项（按计划顺序，改写或删除），keep 是删除依据涉及、这次不写的记忆，只核对版本。
   * 整批一份快照（pre-update），逐项写，全成后在账本里留一条已结清的 batch-edited（带逐项回执），结果的 decisionId 交给 undo 一次撤回。
   * 目标 id 重复（ops 之间、ops 与 keep 之间）、不在同一作用域、删除的 into 不指向本批的改写项或 keep 回 invalid-args；
   * 任一条不在用回 not-found；改写的目标含高危密钥、删除的目标含密钥（疑似也算）回 has-secret；版本对不上回 stale；
   * 改写项四个面含高危密钥回 secret-critical，疑似回 secret-suspected，确认后带 force 重发。以上都什么都不写。
   */
  z.object({
    cmd: z.literal('apply-edits'),
    ops: z.array(applyEditOpSchema).min(1).max(MAX_BATCH_EDIT),
    keep: z.array(mergeRefSchema).max(MAX_BATCH_EDIT).optional(),
    force: z.boolean().optional(),
    allowCrossWorkspace,
  }),
  z.object({ cmd: z.literal('dismiss-overflow'), decisionId: z.string() }),
  /**
   * 忽略一条建议整理项：记下这几条记忆的指纹，之后该项不再出现在待处理、不再扣分；建议依据的字段变了就不再算已忽略。
   * memories 是该项涉及的记忆（内容重复为一组，顺序不论；其余类型恰好一条），每条带卡片上那一份的作用域和卡片版本：
   * 只认那一份，版本对不上（卡片加载后被改过）回 stale，不在用回 not-found，都什么都不记。
   * 不改记忆，所以不过跨项目门、不受体检开关影响；同一项再忽略一次只是刷新记录。
   */
  z.object({ cmd: z.literal('ignore-advice'), type: z.enum(IGNORABLE_ADVICE_TYPES), memories: z.array(mergeRefSchema).min(1) }),
  /** 取消忽略（健康页「已忽略」里的一条，或刚忽略后的撤销）：本来就没忽略也算成功。 */
  z.object({ cmd: z.literal('unignore-advice'), type: z.enum(IGNORABLE_ADVICE_TYPES), memoryIds: z.array(z.string()).min(1) }),
  /**
   * 体检，目标三选一：不带参数 = 全部（逐个查每个项目，再单独查一遍全局）；workspacePath = 这个项目（读全局加本项目、
   * 只写本项目的缓存）；layer = 全局（只查全局、只写全局的缓存）。两者不能同时给。体检完给覆盖到的每个范围写完成记录（发起方界面手动）。
   */
  z.object({ cmd: z.literal('scan'), workspacePath: z.string().optional(), layer: z.object({ kind: z.literal('global') }).optional() })
    .refine(c => c.workspacePath === undefined || c.layer === undefined, { message: 'workspacePath 与 layer 只能给一个' }),
  /**
   * 改一个范围的自动体检频率：具体值（manual 或 1–90 天）写进自动体检设置表，和「全部」的值相同也写（算单独设置）；
   * follow 删掉这个范围的设置、改回跟随「全部」（「全部」没有可跟随的，不收 follow）。项目路径要是绝对路径。不受体检开关影响。
   */
  z.object({
    cmd: z.literal('set-auto-checkup'),
    scope: scopeOrAllSchema,
    frequency: z.union([autoCheckupFrequencySchema, z.literal(AUTO_CHECKUP_FOLLOW)]),
  }).refine(c => c.scope.kind !== 'all' || c.frequency !== AUTO_CHECKUP_FOLLOW, { message: '「全部」没有可跟随的范围' }),
  z.object({ cmd: z.literal('refresh-views') }),
  /**
   * 设置页改名或删除自建类型时处理已有记忆（全库：全局和所有项目，等同 allowCrossWorkspace）。retype 把这一类的记忆
   * （在用的和最近删除里的）改成 to，不刷新更新、确认时间；forget 把在用的这一类移到最近删除，含密钥的不动、计数返回。
   * 重复执行只处理还是 from 的记忆。from 不限格式：配置文件里手写的类型名也要能迁走。
   */
  z.object({ cmd: z.literal('migrate-type'), from: z.string().min(1), action: z.enum(['retype', 'forget']), to: typeNameSchema.optional() })
    .refine(c => (c.action === 'retype') === (c.to !== undefined), { message: 'retype 要带 to，forget 不带' }),
])
export type MemoryCommand = z.infer<typeof memoryCommandSchema>

/** 带 allowCrossWorkspace 字段的命令。 */
export type CrossWorkspaceCommand = Extract<MemoryCommand, { cmd: CrossWorkspaceCmd }>
type CrossWorkspaceCmd = MemoryCommand extends infer C ? C extends { cmd: infer K } ? 'allowCrossWorkspace' extends keyof C ? K : never : never : never

/**
 * 可带跨项目确认的命令：服务端回 cross-workspace（什么都没动）时，界面确认后带 allowCrossWorkspace 重发。
 * 从命令 schema 推出：schema 里有 allowCrossWorkspace 字段的就是。
 */
export const CROSS_WORKSPACE_COMMANDS: ReadonlySet<CrossWorkspaceCmd> = new Set(
  memoryCommandSchema.options.flatMap(o => 'allowCrossWorkspace' in o.shape ? [o.shape.cmd.value as CrossWorkspaceCmd] : []),
)

/**
 * 条目还开着才能做的命令，not-found 算别处已处理：处理待决项的，not-found 只可能是条目已出了待决；按记忆 id 提升为全局的，
 * 只可能是那条记忆已不在那个项目里（别处已提升或删掉）；按记忆 id 留在本项目的，是那条已不是候选（别处已处理）；
 * 移到项目的同理，是那条已不在全局；忽略建议的，只可能是涉及的记忆已在别处删掉。undo 的 not-found 还可能是快照过期，不在其中。
 */
export const OPEN_ITEM_COMMANDS: ReadonlySet<MemoryCommand['cmd']> = new Set([
  'resolve', 'promote', 'keep-local', 'dismiss-overflow', 'promote-memory', 'keep-local-memory', 'move-memory', 'ignore-advice',
] as const)

/** 命令 → 整行文本（客户端发给 `remote.commands.execute`）。 */
export function encodeMemoryCommand(command: MemoryCommand): string {
  const { cmd, ...rest } = command
  return `/${MEMORY_COMMAND_NAME} ${cmd}${Object.keys(rest).length > 0 ? ` ${JSON.stringify(rest)}` : ''}`
}

/** 命令名之后的原文（宿主 rawInput，含分隔空白）→ 命令；不合法时 detail 说明原因。 */
export function parseMemoryCommand(rawInput: string): { ok: true; command: MemoryCommand } | { ok: false; detail: string } {
  const text = rawInput.trim()
  const space = text.search(/\s/)
  const cmd = space === -1 ? text : text.slice(0, space)
  const argText = space === -1 ? '' : text.slice(space).trim()
  let args: object = {}
  if (argText !== '') {
    let value: unknown
    try {
      value = JSON.parse(argText)
    } catch {
      return { ok: false, detail: `参数不是合法 JSON：${argText}` }
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: false, detail: '参数必须是 JSON 对象' }
    args = value
  }
  const parsed = memoryCommandSchema.safeParse({ ...args, cmd })
  if (!parsed.success) return { ok: false, detail: parsed.error.issues.map(i => `${i.path.join('.') || 'cmd'}: ${i.message}`).join('; ') }
  return { ok: true, command: parsed.data }
}

/** 命令错误码。 */
export const GUI_ERROR_CODES = [
  'invalid-args',       // 参数不符合 memoryCommandSchema
  'not-found',          // 条目或记忆不存在（可能已处理）
  'cross-workspace',    // 涉及其他项目且未带 allowCrossWorkspace，什么都没动
  'llm-unavailable',    // 体检、让模型改拿不到模型
  'llm-failed',         // 让模型改：模型报错，detail 带原话
  'llm-invalid-output', // 让模型改：模型的输出不合要求的格式；整理计划：漏条、多条、承接或提问不合规则
  'subagent-readonly',  // 借的会话是子 agent，不可写
  'governance-disabled', // 体检已关闭：裁决、撤销、提升、移到项目、留在本项目、体检、忽略超限不可用
  'has-secret',         // forget 的目标含密钥（任一级），只能彻底删除：什么都没动，界面确认后改发 hard-delete；
                        // 直接改、直接合并、整理所选的应用的目标含密钥（界面上是遮盖后的正文）：什么都没动；让模型改、整理计划的目标含密钥：不发给模型
  'stale',              // 直接改、直接合并、整理计划与应用：记忆在卡片加载后被改过；任一类撤销（含等同撤销的恢复）：目标之后又被改过或已不在原处。什么都没动（合并撤销中途被第三方改过的停在第三方的版本）
  'secret-critical',    // 直接改、直接合并、整理所选的应用的新内容含高危密钥：什么都没动；让模型改、整理计划的要求、此前的要求、计划或上一稿含高危密钥：不发给模型
  'secret-suspected',   // 直接改、直接合并、整理所选的应用的新内容含疑似密钥：什么都没动，用户确认后带 force 重发
  'claimed',            // 待决项正被另一次操作（别的标签页、宿主进程或体检）认领：什么都没动
  'busy',               // 体检：范围正在体检（别的体检认领着、没过期；「全部」有一个范围认领不到也算），或体检中途认领被别的进程接手。
                        // 没认领到时什么都没动；中途被接手的这次不再提交。和待决项的 claimed 是两回事
  'target-taken',       // 移到项目：目标项目已有同 id 的记忆；撤销移到项目、提升为全局：全局已有同 id 的记忆（含最近删除）。什么都没动
  'failed',             // 真失败：执行器或读写报错，detail 带原话。撤销遇到「之后又被改过」不走这里，回 stale；最近删除的普通恢复（不等同撤销）快照后被改过仍回它
] as const
export type GuiErrorCode = (typeof GUI_ERROR_CODES)[number]

/** 说明界面落后于磁盘的失败码（卡片版本对不上、要动的已经不在）：什么都没动，但服务端会重写一次视图，客户端随之重读。 */
export const VIEW_BEHIND_CODES: ReadonlySet<GuiErrorCode> = new Set(['stale', 'not-found'])

export const memoryCommandResultSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    cmd: z.string(),
    decisionId: z.string().optional(),
    memoryIds: z.array(z.string()).optional(),
    snapshotId: z.string().optional(),
    /**
     * apply-edits：只应用了一部分（中途失败、已写的没能全部退回）。memoryIds 只列仍是这次写下、记进账本可撤销的；
     * 回退之前已被别处接着改过的停在别处的版本，不进账本、不可撤销，列在 unrecordedIds。两者之外的都已退回或没写。
     */
    isPartial: z.literal(true).optional(),
    unrecordedIds: z.array(z.string()).optional(),
    /** edit-memory / merge-memories：保留的那条写完后的文件（改了名称时文件名跟着变）；move-memory：移过去之后的文件。 */
    filePath: z.string().optional(),
    /**
     * resolve 两边都留：条目没有指纹（升级前导入的）、也现算不出（垂直冲突借来的会话拿不到基线），结论没记下、条目已移出账本，
     * 下次体检同一对还会报，也没有可撤销的条目。
     */
    isUnrecorded: z.literal(true).optional(),
    /** resolve 删一方：败方含高危密钥，已物理删除、不可恢复，条目已移出账本，没有可撤销的条目。 */
    isHardDeleted: z.literal(true).optional(),
    /** draft-edit：模型给的改后稿。 */
    draft: memoryDraftSchema.optional(),
    /** plan-edits：模型给的整理计划。 */
    plan: editPlanSchema.optional(),
    /** draft-plan：每个改写项一稿，按命令里 ops 的顺序。 */
    drafts: z.array(z.object({ memoryId: z.string(), draft: memoryDraftSchema })).optional(),
    /** model-info、draft-edit、plan-edits、draft-plan：借来的会话用的模型名；拿不到名字时缺省。 */
    model: z.string().optional(),
    /** scan：体检的说明码（如 baseline-session-scoped）。 */
    notes: z.array(z.enum(SCAN_NOTE_CODES)).optional(),
    /**
     * scan：本次新增的待处理项条数。新增 = 体检后有、体检前没有（按待处理项的身份比较，只看本次体检覆盖的作用域），
     * 不等于「体检查出来的」：体检期间别的会话写入引出的、时间推移刚越过「很久没确认」门槛的也算。
     * 用户忽略的建议不在待处理里，不算。pending = 高优问题 + 待你处理，advice = 建议整理。
     * pendingLevel：新增的待处理都在同一组时给出那一组（界面的链接定位到它），分在两组或没有新增时缺省。
     * 收集视图出错时缺省（体检照常完成）。
     */
    added: z.object({
      pending: z.number().int().nonnegative(), advice: z.number().int().nonnegative(),
      pendingLevel: z.enum(['must-fix', 'your-call']).optional(),
    }).optional(),
    /** scan：本次体检覆盖各作用域的健康分（与健康视图同值，有密钥的作用域为 null），按健康视图的顺序；与 added 同时缺省。 */
    scores: z.array(z.object({ layer: scopeSchema, score: z.number().nullable() })).optional(),
    /** scan：内容检查分了批时的批数（分批的各作用域相加），与说明码 semantic-batched 同时出现；不分批时缺省。 */
    semanticBatches: z.number().int().positive().optional(),
    /** scan：宿主流 usage 块报的实际用量合计（所有批次、重试、跨项目重复检查）；宿主一次都没报时缺省，不拿估算顶替。 */
    usageTokens: z.number().int().nonnegative().optional(),
    /** migrate-type：这次改了类型或移到最近删除的条数。 */
    migrated: z.number().int().nonnegative().optional(),
    /** migrate-type forget：含密钥、没有移动的条数。 */
    skippedSecrets: z.number().int().nonnegative().optional(),
    /** info：记忆根目录、视图目录与各视图文件的绝对路径（checkups 是体检视图，session 是发命令的这个会话的视图）、视图版本。 */
    info: z.object({
      memoryRoot: z.string(),
      viewDir: z.string(),
      views: z.object({ pending: z.string(), health: z.string(), library: z.string(), deleted: z.string(), checkups: z.string().optional(), session: z.string().optional() }),
      version: z.number(),
    }).optional(),
  }),
  z.object({
    ok: z.literal(false),
    cmd: z.string().optional(),
    code: z.enum(GUI_ERROR_CODES),
    /** cross-workspace：被拒的记录。 */
    rejected: z.array(z.object({ id: z.string(), workspacePath: z.string() })).optional(),
    /** 宿主或执行器的原话，界面原样显示。 */
    detail: z.string().optional(),
    /** stale、not-found：对不上或找不到的那几条（整理所选的三条命令、让模型改），界面据此等视图换成最新内容、移出清单。 */
    memoryIds: z.array(z.string()).optional(),
  }),
])
export type MemoryCommandResult = z.infer<typeof memoryCommandResultSchema>
