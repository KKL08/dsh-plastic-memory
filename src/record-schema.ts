import { z } from 'zod'
import { isLosslessJson } from './output.ts'
import type { MemoryTypeDefinition } from './types.ts'

const sourceModeSchema = z.enum(['user-explicit', 'user-behavior', 'environment-observed', 'agent-inferred', 'agent-action-confirmed'])

/**
 * 新键里开放的部分（不认识的子字段、开放取值的键）只收无损 JSON 值。YAML 写得出 .nan、.inf、循环别名，
 * 这些值进了记录，快照和写回会出错或悄悄改值，所以在读文件时就把这条送进隔离。
 */
const openValue = z.unknown().refine(isLosslessJson, '取值不是无损 JSON（如 .nan、.inf、循环别名）')

/**
 * 出处锚：这条记忆当前版本的一次依据。时间、发起方、证据类别、改动性质、写下它的一方都放在锚上，不放进 source：
 * 0.2.0 会丢掉 source 里它不认识的子字段，顶层键则原样保留。
 * 新增的嵌套对象（锚、证据类别、最近一次内容改动、前提）都保留不认识的子字段，以后的版本给它们加字段时，这一版读写不会丢。
 */
export const sourceAnchorSchema = z.object({
  sessionId: z.string(),
  eventRange: z.tuple([z.number(), z.number()]),
  /** 开放取值：以后的版本可能加新的来源方式。读取用 anchorSourceMode */
  sourceMode: z.string(),
  /** 锚起点的事件时间 */
  at: z.number(),
  /**
   * 当轮起点那条用户消息的宿主来源标记，原样记下；开放取值，宿主给不出时缺省。
   * 委派给子 agent 的任务宿主也标成 user：判断是不是用户本人，要连 by 一起看（by 是 subagent 时不是）。
   */
  initiator: z.string().optional(),
  /** user：锚范围内有用户本人发起的消息；tool：有工具结果（本插件的工具、读记忆根下文件的结果不算）。缺的一项按不知道处理 */
  evidence: z.object({ user: z.boolean().optional(), tool: z.boolean().optional() }).catchall(openValue).optional(),
  /** 这个锚对应哪种改动；开放取值 */
  change: z.string().optional(),
  /** 谁写下这个锚，取值同操作日志的发起方；开放取值 */
  by: z.string().optional(),
}).catchall(openValue)
export type SourceAnchor = z.infer<typeof sourceAnchorSchema>

/** 事实时间按用户说的精度存：年、年月、日期，或带时刻的 ISO 8601。 */
const FACT_TIME_RE = /^(\d{4})(?:-(\d{2})(?:-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-](\d{2}):?(\d{2}))?)?)?)?$/
export function isFactTime(text: string): boolean {
  const m = FACT_TIME_RE.exec(text)
  if (!m) return false
  const month = m[2] === undefined ? 1 : Number(m[2])
  if (month < 1 || month > 12) return false
  if (m[3] === undefined) return true
  const day = Number(m[3])
  const date = new Date(0)
  date.setUTCFullYear(Number(m[1]), month - 1, day)   // Date.UTC 会把 0–99 年当成 1900 年代
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return false
  // 时刻和偏移只校验范围，原文照存（精度和时区都是用户说的）
  const inRange = (part: string | undefined, max: number) => part === undefined || Number(part) <= max
  return inRange(m[4], 23) && inRange(m[5], 59) && inRange(m[6], 59) && inRange(m[7], 23) && inRange(m[8], 59)
}

export const memoryRecordSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  type: z.string(),
  scope: z.enum(['global', 'workspace']),
  workspacePath: z.string().optional(),
  tags: z.array(z.string()),
  content: z.string(),
  summary: z.string(),
  /** 缺省 = 手编/无出处（手建文件）：不带「模型推断」标注，memory_source 回「无出处」。 */
  source: z.object({
    sessionId: z.string(),
    eventRange: z.tuple([z.number(), z.number()]),
    sourceMode: sourceModeSchema,
  }).optional(),
  /** 当前版本的历次锚，新的在前；写入方封顶 8 个。读取用 anchorsOf，它会把旧版本写下的 source 补进来。 */
  sourceTrail: z.array(sourceAnchorSchema).optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  lastConfirmedAt: z.number(),
  lastRecalledAt: z.number().nullable(),
  recallCount: z.number(),
  validFrom: z.number().optional(),
  validTo: z.number().optional(),
  status: z.enum(['active', 'superseded', 'deleted']),
  confidence: z.number().min(0).max(1),
  supersedes: z.array(z.string()).optional(),
  /** 模型自主判断"该全局"但无权直写 global：落 workspace 时打此标记，治理时作为提升候选。 */
  globalCandidate: z.boolean().optional(),
  /**
   * 子 agent 写入的委派信息（宿主填）。缺省 = 主会话或手建。顶层键：旧版插件把它当未知键原样保留，嵌进 source 会在维护回写时丢掉。
   * 创建者四个字段写入后不再改，升档只加 reviewed。
   */
  delegation: z.object({
    /** 创建这条记录的子会话；主会话改写后 source.sessionId 变成主会话，这里不变 */
    sessionId: z.string(),
    depth: z.number().int().min(1),
    parentSessionId: z.string(),
    /** 解析不到根会话时缺省，不阻塞保存 */
    rootSessionId: z.string().optional(),
    /** 谁把它升成主档；缺省 = 待确认 */
    reviewed: z.object({ by: z.enum(['user', 'main']), at: z.number() }).optional(),
  }).optional(),
  /** 软删时刻（清扫按它计窗口）。 */
  deletedAt: z.number().optional(),
  /** 当前这个状态从什么时候起成为当前版（记录时间，只由插件写）；留档时抄进历史版本。缺省时按上一版的结束时间或 createdAt 推。 */
  stateSince: z.number().optional(),
  /** 事实时间：事情什么时候发生、这个状态从什么时候起成立，按用户说的精度存。和有效期、记录时间都分开。 */
  factTime: z.string().refine(isFactTime, '事实时间的写法不认识（接受 YYYY、YYYY-MM、YYYY-MM-DD、带时刻的 ISO 8601）').optional(),
  /** 最近一次内容改动：性质（开放取值，读取用 readChangeKind）、时间、操作 id、发起方、原因。只改元数据的操作和补证不动它。 */
  lastChange: z.object({ kind: z.string(), at: z.number(), op: z.string(), by: z.string().optional(), reason: z.string().optional() }).catchall(openValue).optional(),
  /** 提交标记：最近一次写这个文件的操作 id，每次写入都更新；只用来判断中断前那次写入落盘了没有。 */
  lastWriteOp: z.string().optional(),
  /** 相关记忆的 id；写入方去重追加、限条数、按作用域校验，读取不限。 */
  related: z.array(z.string()).optional(),
  /** 决定记录依赖的前提：被依据记忆的 id 和当时的内容摘要。 */
  premises: z.array(z.object({ id: z.string(), digest: z.string() }).catchall(openValue)).optional(),
  /** 单条注入档位；开放取值，读取用 recallOverride，不认识的跟随类型。 */
  recall: openValue.optional(),
  /** 锁：缺省或 false 算没锁，其余任何取值都算锁定（以后加档位时，旧读取方按最严处理）。读取用 isLocked。 */
  locked: openValue.optional(),
  /**
   * 锁到期时刻（毫秒），已过算没锁。写坏的（不是时间）原样保留、按不过期读，不进隔离：锁只管写，不能让记忆读不到。
   */
  lockedUntil: openValue.optional(),
})
export type MemoryRecord = z.infer<typeof memoryRecordSchema>
/** 待确认 = 子 agent 写入且还没有主会话或用户升档。只看这两个字段，状态（在用、已删除、过期）由调用处按各自口径过滤。 */
export function isPendingDelegated(record: Pick<MemoryRecord, 'delegation'>): boolean {
  return record.delegation !== undefined && record.delegation.reviewed === undefined
}
/** 记录不是待确认的两种原因：子 agent 改写（pipeline.ts）、主会话接受（tools/confirm.ts）的拒绝原因共用。 */
export const NOT_DELEGATED_REASON = '是主会话写的或用户手建的'
export const ALREADY_REVIEWED_REASON = '已经被接受了'
export type SourceMode = NonNullable<MemoryRecord['source']>['sourceMode']

export const CONFIDENCE_BY_SOURCE = {
  'user-explicit': 0.9,
  'agent-action-confirmed': 0.9,
  'user-behavior': 0.8,
  'environment-observed': 0.8,
  'agent-inferred': 0.5,
} as const satisfies Record<SourceMode, number>

/** 四种改动性质。 */
export const CHANGE_KINDS = ['corroborate', 'refine', 'correct', 'state-change'] as const
export type ChangeKind = (typeof CHANGE_KINDS)[number]
/** 读最近一次内容改动的性质：缺省是没改过（undefined），不认识的取值按细化处理。 */
export function readChangeKind(kind: string | undefined): ChangeKind | undefined {
  if (kind === undefined) return undefined
  return (CHANGE_KINDS as readonly string[]).includes(kind) ? kind as ChangeKind : 'refine'
}

/** 单条注入档位：类型定义的三档，再加一档不列入（unlisted）：不进注入的索引区，只能搜到。 */
export type RecallTier = MemoryTypeDefinition['recall'] | 'unlisted'
export const RECALL_TIERS = ['core', 'search', 'passive', 'unlisted'] as const satisfies readonly RecallTier[]
/** 单条设过、认得的档位；没设或不认识时返回 undefined，由调用方取类型的档位。 */
export function recallOverride(record: Pick<MemoryRecord, 'recall'>): RecallTier | undefined {
  const v = record.recall
  return typeof v === 'string' && (RECALL_TIERS as readonly string[]).includes(v) ? v as RecallTier : undefined
}

/** 锚的来源方式。以后的版本加的、这一版不认识的，按模型推断读（最弱的一档）。 */
export function anchorSourceMode(anchor: Pick<SourceAnchor, 'sourceMode'>): SourceMode {
  return Object.hasOwn(CONFIDENCE_BY_SOURCE, anchor.sourceMode) ? anchor.sourceMode as SourceMode : 'agent-inferred'
}

/** Date 能表示的毫秒数（ECMAScript 规定 ±8.64e15 以内）。 */
export function isDateMs(v: unknown): v is number {
  return typeof v === 'number' && Math.abs(v) <= 8.64e15
}

/** 这条记忆现在是否锁定。 */
export function isLocked(record: Pick<MemoryRecord, 'locked' | 'lockedUntil'>, now: number): boolean {
  if (record.locked === undefined || record.locked === false) return false
  // 到期时刻缺省或写坏（不是能表示的日期）都按不过期
  return !isDateMs(record.lockedUntil) || record.lockedUntil > now
}

/**
 * 出处锚清单。旧版本只认 source：没有 sourceTrail 时 source 就是唯一的锚；source 和清单头一个对不上，
 * 说明旧版本之后写过，把 source 当成一个没有发起方信息的新锚补在最前（时间取 updatedAt）。
 */
export function anchorsOf(record: Pick<MemoryRecord, 'source' | 'sourceTrail' | 'updatedAt'>): readonly SourceAnchor[] {
  const trail = record.sourceTrail ?? []
  const s = record.source
  if (s === undefined) return trail
  const head = trail[0]
  const same = head !== undefined && head.sessionId === s.sessionId && anchorSourceMode(head) === s.sourceMode
    && head.eventRange[0] === s.eventRange[0] && head.eventRange[1] === s.eventRange[1]
  if (same) return trail
  return [{ sessionId: s.sessionId, eventRange: s.eventRange, sourceMode: s.sourceMode, at: record.updatedAt }, ...trail]
}
