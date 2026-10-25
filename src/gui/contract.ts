import { z } from 'zod'
import { memoryRecordSchema } from '../record-schema.ts'
import { OVERFLOW_MODES, type DirectoryNoteCode, type ScanNoteCode } from '../contract-codes.ts'

/** 密钥遮盖（缺省与注入、视图同一套规则），浏览器半侧给对话卡里来自工具参数的文字用（带 severity: 'suspected'）。 */
export { maskSecrets, maskSecretSurface, type MaskOptions } from '../secrets.ts'

/**
 * GUI 契约（命名契约：视图与命令的标识符只在这一处定义）。服务端 GUI 层与浏览器半侧共用，是叶子：
 * 只 import zod 与其他叶子，且必须能在浏览器里运行（不碰 node:*）。
 * 只有结构和稳定码，没有界面文案；时间一律是毫秒时间戳，「3 天前」「已过期」由客户端按当前时间算。
 * 记忆文字（名称、正文、摘要、标签）进视图前已遮盖密钥片段；文件路径保留原样，供「打开文件」。
 */

/** 视图 schema 的版本号：视图是派生缓存，形状变了就换号，客户端读到不认识的号按「需要刷新」处理。 */
export const GUI_VIEW_VERSION = 3

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

// —— 共用片段 ——

export const layerRefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('global') }),
  z.object({ kind: z.literal('workspace'), workspacePath: z.string() }),
])
export type GuiLayerRef = z.infer<typeof layerRefSchema>

const sourceModeSchema = memoryRecordSchema.shape.source.unwrap().shape.sourceMode

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
  /** 记忆文件的绝对路径。 */
  filePath: z.string(),
})
export type MemoryCard = z.infer<typeof memoryCardSchema>

/** 记忆卡所在的层：同 id 在几个层里各有一份时，命令带上它指明页面上的那一份。项目记忆缺 workspacePath 时为 undefined（服务端按借来的会话定位）。 */
export function layerOfMemory(memory: Pick<MemoryCard, 'scope' | 'workspacePath'>): GuiLayerRef | undefined {
  if (memory.scope === 'global') return { kind: 'global' }
  return memory.workspacePath === undefined ? undefined : { kind: 'workspace', workspacePath: memory.workspacePath }
}

// —— 待处理 ——

export const PENDING_ITEM_KINDS = ['secret', 'conflict-horizontal', 'conflict-vertical', 'promote-candidate', 'overflow', 'unreadable-file'] as const
export type PendingItemKind = (typeof PENDING_ITEM_KINDS)[number]

/** 待处理条目。冲突、提升候选、超限来自待决账本（带 decisionId）；密钥与读不出的文件从预读数据派生，不入账本。
 *  冲突一方定位不到时为 null（账本悬空引用，裁决会报错）。 */
export const pendingItemSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('secret'), memory: memoryCardSchema }),
  z.object({
    kind: z.literal('conflict-horizontal'), decisionId: z.string(), firstSeenAt: z.number(), summary: z.string(),
    left: memoryCardSchema.nullable(), right: memoryCardSchema.nullable(),
    /** 决定前 agent 按哪条来：快照注入的排序（confidence 降序 → lastConfirmedAt 降序）排在前的一方；两方都找不到时缺省。 */
    preferredId: z.string().optional(),
  }),
  z.object({
    kind: z.literal('conflict-vertical'), decisionId: z.string(), firstSeenAt: z.number(), summary: z.string(),
    memory: memoryCardSchema.nullable(), baselineRef: z.string(),
  }),
  z.object({ kind: z.literal('promote-candidate'), decisionId: z.string(), firstSeenAt: z.number(), memory: memoryCardSchema.nullable() }),
  /** 超出上限：relax 第 tier 档（放宽到上限 × (1 + 0.25 × tier)）；strict 用到 95%（tier 为 0）。workspacePath 缺省 = 无项目的会话。 */
  z.object({
    kind: z.literal('overflow'), decisionId: z.string(), firstSeenAt: z.number(),
    mode: z.enum(OVERFLOW_MODES), tier: z.number().int().nonnegative(), workspacePath: z.string().optional(),
  }),
  z.object({
    kind: z.literal('unreadable-file'), layer: layerRefSchema,
    filePath: z.string(), relativePath: z.string(),
    /** 解析器原话。 */
    error: z.string(),
  }),
])
export type PendingItem = z.infer<typeof pendingItemSchema>

/** 左栏图标圆点：密钥红点盖过琥珀点；读不出的文件不亮点。 */
export const PENDING_DOTS = ['none', 'amber', 'red'] as const

/** 待处理（全部层），按 PENDING_ITEM_KINDS 顺序、同类按 firstSeenAt 升序。 */
export const pendingViewSchema = z.object({
  version,
  dot: z.enum(PENDING_DOTS),
  items: z.array(pendingItemSchema),
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

export const healthLayerSchema = z.object({
  layer: layerRefSchema,
  totalMemories: z.number().int().nonnegative(),
  /** 有密钥时该层不打分：null。 */
  score: z.number().nullable(),
  tier: z.enum(['green', 'amber', 'red']),
  gate: z.object({ secret: z.boolean() }),
  /** 非零的问题类计数（规则检查实时 + 内容检查取上次体检），type 取值见 governance/schema.ts FINDING_TYPES，按其顺序。 */
  issues: z.array(z.object({ type: z.string(), count: z.number().int().positive() })),
  /** 超过衰退期未确认的条数。 */
  staleCount: z.number().int().nonnegative(),
  /** 内容检查（语义层）上次时间；从没做过为 null。 */
  semanticCachedAt: z.number().nullable(),
  /** 本层会话带入的记忆超出上限（已忽略的也算，忽略只是不再提醒）；列为问题、不扣分。没超为 null。 */
  overflow: z.object({ mode: z.enum(OVERFLOW_MODES), tier: z.number().int().nonnegative() }).nullable(),
})
export const healthViewSchema = z.object({
  version,
  /** 体检开关（governance.enabled）：关闭时界面置灰健康内容、「体检当前项目」不可用。 */
  governanceEnabled: z.boolean(),
  /** 插件本次加载的时刻（epoch ms）：会话快照的 frozenAt 早于它就是「重启后未重新带入」；浏览器半侧拿不到宿主进程时间，从这里读。 */
  bootedAt: z.number().optional(),
  layers: z.array(healthLayerSchema),
})
export type HealthView = z.infer<typeof healthViewSchema>

// —— 全部记忆 ——

export const directoryIssueSchema = z.object({
  code: z.custom<DirectoryNoteCode>(v => typeof v === 'string'),
  /** 涉及的文件或目录的绝对路径。 */
  path: z.string(),
  /** reserved-keys：被忽略的键。 */
  keys: z.array(z.string()).optional(),
  /** duplicate-id：读取时用的那份（path 是没用上的副本）。 */
  keptPath: z.string().optional(),
})
export const libraryViewSchema = z.object({
  version,
  /** 存储目录（绝对路径）。 */
  memoryRoot: z.string(),
  /** global 在前，项目按路径排序；每层只列 active 记忆，按 name 再 id 排序。 */
  layers: z.array(z.object({ layer: layerRefSchema, items: z.array(memoryCardSchema) })),
  /** 目录问题：同 id 多份副本、被忽略的字段、缺标记 / 不可读目录。 */
  directoryIssues: z.array(directoryIssueSchema),
  /** 类型 id → 显示名（同待处理视图的 typeLabels），覆盖注册表与本视图出现的类型。可缺省：升级前写的视图文件没有，下次写视图补上。 */
  typeLabels: z.record(z.string(), z.string()).optional(),
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
  items: z.array(deletedItemSchema),
  /** 类型 id → 显示名（同全部记忆视图的 typeLabels），另含裁决对方的类型。可缺省，理由同上。 */
  typeLabels: z.record(z.string(), z.string()).optional(),
})
export type DeletedView = z.infer<typeof deletedViewSchema>

// —— 这次对话 ——

/** 一个会话冻结快照时带入的记忆与用量。token 是插件估算（estimateTokens），界面带「约」。 */
export const sessionViewSchema = z.object({
  version,
  sessionId: z.string(),
  workspacePath: z.string().optional(),
  /** 快照冻结时刻；早于宿主启动时间说明重启后还没重新带入。 */
  frozenAt: z.number(),
  budget: z.number().nonnegative(),
  overflowMode: z.enum(OVERFLOW_MODES),
  /** 三段之和即总用量：本项目、全局、固定说明（标题、导航图、固定尾注）。 */
  tokens: z.object({ workspace: z.number(), global: z.number(), fixed: z.number() }),
  /** 计入上限的部分（固定尾注与导航图不计）：relax 下超过 budget 即已放宽，strict 下不超过 budget。 */
  usedTokens: z.number().int().nonnegative(),
  injectedIds: z.array(z.string()),
  /** 没带入的条数（只有 strict 会截）：「已到上限，N 条没带入」。 */
  omittedCount: z.number().int().nonnegative(),
  /** 这次对话新记的。 */
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

// —— 命令 ——

const allowCrossWorkspace = z.boolean().optional()
/** 目标记忆所在的层（见 layerOfMemory）：服务端只动这一份，跨项目门仍按借来的会话判定；缺省按借来的会话定位。 */
const layer = layerRefSchema.optional()

/** 宿主命令名（不带斜杠）。 */
export const MEMORY_COMMAND_NAME = 'memory'

/**
 * `/memory` 子命令的参数。文本编码：`/memory <cmd> <其余字段的 JSON 对象>`，没有其余字段时只写子命令，
 * 如 `/memory info`、`/memory resolve {"decisionId":"pd_x","verdict":"keep-left"}`（见 encodeMemoryCommand）。
 */
export const memoryCommandSchema = z.discriminatedUnion('cmd', [
  z.object({ cmd: z.literal('info') }),
  z.object({ cmd: z.literal('resolve'), decisionId: z.string(), verdict: z.enum(RESOLVE_VERDICTS), allowCrossWorkspace }),
  /** 撤销一条已裁决条目：去掉 settled，记了快照的按它恢复败方（提升为全局则恢复原位）。 */
  z.object({ cmd: z.literal('undo'), decisionId: z.string(), allowCrossWorkspace }),
  z.object({ cmd: z.literal('promote'), decisionId: z.string(), target: z.enum(['global', 'agents-md']), allowCrossWorkspace }),
  z.object({ cmd: z.literal('keep-local'), decisionId: z.string(), allowCrossWorkspace }),
  z.object({ cmd: z.literal('forget'), memoryId: z.string(), layer, allowCrossWorkspace }),
  z.object({ cmd: z.literal('restore'), memoryId: z.string(), layer, allowCrossWorkspace }),
  z.object({ cmd: z.literal('hard-delete'), memoryId: z.string(), layer, allowCrossWorkspace }),
  z.object({ cmd: z.literal('dismiss-overflow'), decisionId: z.string() }),
  z.object({ cmd: z.literal('scan'), workspacePath: z.string().optional() }),
  z.object({ cmd: z.literal('refresh-views') }),
])
export type MemoryCommand = z.infer<typeof memoryCommandSchema>
export type MemoryCommandName = MemoryCommand['cmd']

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
  'llm-unavailable',    // 体检拿不到模型
  'subagent-readonly',  // 借的会话是子 agent，不可写
  'governance-disabled', // 体检已关闭：裁决、撤销、提升、留在本项目、体检、忽略超限不可用
  'has-secret',         // forget 的目标含密钥（任一级），只能彻底删除：什么都没动，界面确认后改发 hard-delete
  'failed',             // 执行器报错，detail 带原话
] as const
export type GuiErrorCode = (typeof GUI_ERROR_CODES)[number]

export const memoryCommandResultSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    cmd: z.string(),
    decisionId: z.string().optional(),
    memoryIds: z.array(z.string()).optional(),
    snapshotId: z.string().optional(),
    /** scan：体检的说明码（如 baseline-session-scoped）。 */
    notes: z.array(z.custom<ScanNoteCode>(v => typeof v === 'string')).optional(),
    /** info：记忆根目录、视图目录与各视图文件的绝对路径（session 是发命令的这个会话的视图）、视图版本。 */
    info: z.object({
      memoryRoot: z.string(),
      viewDir: z.string(),
      views: z.object({ pending: z.string(), health: z.string(), library: z.string(), deleted: z.string(), session: z.string().optional() }),
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
  }),
])
export type MemoryCommandResult = z.infer<typeof memoryCommandResultSchema>
