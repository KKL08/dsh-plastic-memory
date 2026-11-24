import { anchorSourceMode, anchorsOf, type ChangeKind, type MemoryRecord, type SourceAnchor } from './record-schema.ts'

/** 出处清单最多留几个锚：新的在前，超出的从最旧的丢。 */
export const SOURCE_TRAIL_CAP = 8

/** 这次写入的出处：出自哪个会话的哪段事件、依据是什么来源方式。时间、改动性质、谁写的由落盘时补上。 */
export interface ChangeAnchor {
  sessionId: string
  eventRange: [number, number]
  sourceMode: string
  /** 当轮起点那条消息的宿主来源标记；读不到时缺省。 */
  initiator?: string
  /** 锚范围里有没有用户本人的话、有没有算数的工具结果；读不到日志时缺省。 */
  evidence?: { user: boolean; tool: boolean }
  /** 锚起点事件的时间；读不到时取写入时刻。 */
  at?: number
}

/** 一次内容改动可以带的字段。补证时都不生效。 */
export type ChangeFields = Partial<Pick<MemoryRecord,
  'name' | 'type' | 'tags' | 'content' | 'summary' | 'confidence' | 'validFrom' | 'validTo' | 'supersedes' | 'globalCandidate' | 'delegation'>>

export interface Change {
  kind: ChangeKind
  /** 要改的字段和新值；键在就改（值是 undefined 即清掉），键不在的保留原值。 */
  fields: ChangeFields
  /** 不给时出处清单和 source 原样不动（没有会话可指的后台写入）。 */
  anchor?: ChangeAnchor
  /** 谁写的：前台主会话、子 agent、界面、记忆梦境。取值和操作日志的发起方同一套。 */
  by: string
  /** 这次写入的操作 id：记进最近一次内容改动，撤销时据此认「现在的内容是哪一次写下的」。 */
  op: string
  at: number
  /** 这次改动的原因（一句话）：记进最近一次内容改动，状态变化留历史版本时从那里取。 */
  reason?: string
  /** 状态变化并进了上一次留的历史版本（没有新留档）：旧锚没有历史版本可跟，留在清单里。 */
  isMergedIntoLastVersion?: boolean
}

function stampAnchor(anchor: ChangeAnchor, change: string, by: string, at: number): SourceAnchor {
  return {
    sessionId: anchor.sessionId, eventRange: anchor.eventRange, sourceMode: anchor.sourceMode, at: anchor.at ?? at,
    ...(anchor.initiator !== undefined ? { initiator: anchor.initiator } : {}),
    ...(anchor.evidence !== undefined ? { evidence: anchor.evidence } : {}),
    change, by,
  }
}

/**
 * 出处清单封顶（新的在前）。截掉的部分里有写下内容的锚（不是补证）、留下的部分里却一个都没有时，
 * 把截掉的里面最近的那个放回末位、挤掉最旧的补证锚：注入的无人值守标注看的就是最近一次写下内容的锚，补证多了不能把它挤没。
 */
function cappedTrail(trail: readonly SourceAnchor[]): SourceAnchor[] {
  const kept = trail.slice(0, SOURCE_TRAIL_CAP)
  const isContent = (a: SourceAnchor) => a.change !== 'corroborate'
  if (kept.some(isContent)) return kept
  const lastContent = trail.slice(SOURCE_TRAIL_CAP).find(isContent)
  return lastContent === undefined ? kept : [...kept.slice(0, SOURCE_TRAIL_CAP - 1), lastContent]
}

/** 记录顶层的 source：旧版本只认它，来源方式只能是旧版本认得的那几种，认不出的按最弱一档写。 */
function sourceOf(anchor: SourceAnchor): NonNullable<MemoryRecord['source']> {
  return { sessionId: anchor.sessionId, eventRange: anchor.eventRange, sourceMode: anchorSourceMode(anchor) }
}

/**
 * 改动性质的落盘行为表：按声明的性质，在当前这一版上拼出新记录。纯函数，不查门禁、不碰存储。
 *
 * | 性质     | 正文等字段 | 确认时间               | 出处清单                 | 最近一次内容改动 |
 * | 补证     | 不动       | 刷新                   | 加锚                     | 不动             |
 * | 细化     | 按 fields  | 来源是用户明说才刷新   | 加锚                     | 记这一次         |
 * | 纠错     | 按 fields  | 同上                   | 加锚                     | 记这一次         |
 * | 状态变化 | 按 fields  | 刷新                   | 只留这次的锚（旧锚随历史版本走） | 记这一次，状态起点改成这一刻 |
 *
 * source 始终等于最新一个锚的会话、事件范围、来源方式。
 */
export function applyChange(current: MemoryRecord, change: Change): MemoryRecord {
  const { kind, at } = change
  const anchor = change.anchor === undefined ? undefined : stampAnchor(change.anchor, kind, change.by, at)
  const isFreshTrail = kind === 'state-change' && change.isMergedIntoLastVersion !== true
  const provenance = anchor === undefined
    ? {}
    : { source: sourceOf(anchor), sourceTrail: isFreshTrail ? [anchor] : cappedTrail([anchor, ...anchorsOf(current)]) }

  if (kind === 'corroborate') {
    // 多了一处佐证：把握只升不降
    const given = change.fields.confidence
    const confidence = given === undefined ? current.confidence : Math.max(current.confidence, given)
    return { ...current, ...provenance, confidence, lastConfirmedAt: at }
  }
  const isUserStated = change.anchor?.sourceMode === 'user-explicit'
  return {
    ...current,
    ...change.fields,
    ...provenance,
    updatedAt: at,
    lastConfirmedAt: kind === 'state-change' || isUserStated ? at : current.lastConfirmedAt,
    lastChange: { kind, at, op: change.op, by: change.by, ...(change.reason !== undefined ? { reason: change.reason } : {}) },
    ...(kind === 'state-change' ? { stateSince: at } : {}),
  }
}

/** 新建时的出处：一个锚，状态起点等于创建时刻。新建不算内容改动，不写最近一次内容改动。 */
export function initialProvenance(anchor: ChangeAnchor, by: string, at: number): Pick<MemoryRecord, 'source' | 'sourceTrail' | 'stateSince'> {
  const stamped = stampAnchor(anchor, 'create', by, at)
  return { source: sourceOf(stamped), sourceTrail: [stamped], stateSince: at }
}

/**
 * 这一版从什么时候起成为当前版。旧文件没有状态起点时，取这张状态页自己上一版的结束时间，没有上一版取创建时间。
 */
export function stateStartOf(record: Pick<MemoryRecord, 'stateSince' | 'createdAt'>, lastVersionEndedAt: number | undefined): number {
  return record.stateSince ?? lastVersionEndedAt ?? record.createdAt
}
