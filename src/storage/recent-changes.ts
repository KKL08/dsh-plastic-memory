import { AsyncLocalStorage } from 'node:async_hooks'
import { scopeKey, scopeOfMemory } from '../scope.ts'
import type { MemoryRecord } from '../record-schema.ts'

/**
 * 最近改动记录：每个作用域一份定长的改动清单，记在操作日志库里，给长会话变化通知用。
 * 发送点按「作用域 + 序号」查「冻结之后别处改了哪几条」，成本只和这份清单的长度有关，不随注入条数涨。
 *
 * - 一行是一次写入对一条记忆做的、注入的人需要知道的改动（见 classifyChange），不存字段值和正文。
 * - 行在写入段里、记忆文件提交之后写；中断后由操作日志的补做补上，按操作 id 不重复。
 * - 序号全库递增，按提交先后；每个作用域只留最近 RECENT_CHANGES_PER_SCOPE 行，挤掉的最大序号另记一笔。
 */

/** 每个作用域留多少行。两个发送点之间同一作用域改动超过这么多条时，通知末尾说另有改动未列出。 */
export const RECENT_CHANGES_PER_SCOPE = 200

/** 提交后补记最近改动的那一步（文件表自己的步骤，进操作日志，中断后补做）。 */
export const RECENT_CHANGE_STEP = 'recent-change'

/**
 * 注入的人需要知道的四种改动：
 * content 内容改动（lastChange.op 变了，或名称、摘要变了）；superseded 被取代；deleted 软删或物理删除；
 * moved 移出这个作用域（提升为全局、换作用域）。
 */
export const RECENT_CHANGE_KINDS = ['content', 'superseded', 'deleted', 'moved'] as const
export type RecentChangeKind = (typeof RECENT_CHANGE_KINDS)[number]

/** 一次写入要记的一行。scope、movedTo 是作用域的标准键（scopeKey）。 */
export interface RecentChangeInput {
  /** 写入的操作 id：同一个操作只记一行，补做重复执行不多记。 */
  op: string
  scope: string
  memoryId: string
  change: RecentChangeKind
  /** 只有 moved 有：移到了哪个作用域。 */
  movedTo?: string
  /** 发起这次写入的会话 id；界面、后台的写入没有。 */
  session?: string
  at: number
}

/** 读出来的一行。change 按库里的原样给出：更新的版本可能写了这里不认识的取值，由读的一方决定怎么处理。 */
export interface RecentChangeRow {
  seq: number
  scope: string
  memoryId: string
  change: string
  movedTo?: string
  session?: string
}

/** 一次「之后改了什么」的读取结果。 */
export interface RecentChangeRead {
  /** 给定作用域里序号大于 after 的行，按序号升序。 */
  rows: RecentChangeRow[]
  /** 库里用到过的最大序号（含已挤掉的）；空库为 0。只增不减，中间可能有空号。小于调用方记的起点说明库被换成了新库。 */
  latestSeq: number
  /** 每个给定作用域因为定长被挤掉的最大序号；没挤掉过为 0。 */
  prunedThrough: Record<string, number>
}

/** 最近改动记录的读写口（操作日志库实现它）。库不可用、读写失败时读方法返回 undefined，写方法什么都不做（只记日志）。 */
export interface RecentChangeLog {
  /** 记一行；同一个 op 已经记过就什么都不做。记完把这个作用域裁到 RECENT_CHANGES_PER_SCOPE 行。 */
  recordChange(change: RecentChangeInput): void
  /** 库里用到过的最大序号（同 RecentChangeRead.latestSeq）；空库为 0，读不出为 undefined。 */
  latestChangeSeq(): number | undefined
  /** 这几个作用域里序号大于 after 的行；读不出为 undefined。 */
  changesSince(scopes: readonly string[], after: number): RecentChangeRead | undefined
}

/**
 * 一次写入对注入的人来说算哪种改动（只看改前、改后两份记录，纯函数）。before 缺省是新建，after 缺省是物理删除。
 * 只有离开在用、或在用时内容变了才算；调用方传进来的记录按位置算过（byPosition：.archive/ 里的一律不在用）。
 * 判定只在这里做，文件表的写入和彻底删除都用它，按下面的先后判：
 *  - 新建：不算。
 *  - 改前不在用（软删的、被取代的）：不算，物理删除、换作用域也不算（离开在用时已经算过）。
 *  - 物理删除：deleted，记在改前那份的作用域。
 *  - 作用域变了（提升、换作用域）：moved，记在改前那份的作用域，movedTo 是改后的。
 *  - 在用 → 被取代：superseded；在用 → 软删：deleted。
 *  - 两份都在用：lastChange.op 不同（含一边没有），或名称、摘要不同：content。
 *  - 其余（补证、只改元数据、正文变了但 lastChange.op 没变）：不算。
 * 作用域推不出来的记录（项目记忆缺 workspacePath）不算。
 */
export function classifyChange(
  before: MemoryRecord | undefined, after: MemoryRecord | undefined,
): { scope: string; change: RecentChangeKind; movedTo?: string } | undefined {
  if (before === undefined) return undefined
  const own = scopeOfMemory(before)
  const target = after === undefined ? undefined : scopeOfMemory(after)
  if (own === undefined || (after !== undefined && target === undefined) || before.status !== 'active') return undefined
  const scope = scopeKey(own)
  if (after === undefined) return { scope, change: 'deleted' }
  if (scope !== scopeKey(target!)) return { scope, change: 'moved', movedTo: scopeKey(target!) }
  if (after.status === 'superseded' || after.status === 'deleted') return { scope, change: after.status }
  if (before.lastChange?.op !== after.lastChange?.op || before.name !== after.name || before.summary !== after.summary) return { scope, change: 'content' }
  return undefined
}

const writeSession = new AsyncLocalStorage<string>()

/**
 * 在「这些写入由某个会话发起」的上下文里执行 fn：写入工具的入口用它包住整次调用，文件表记最近改动时从这里取会话 id。
 * sessionId 缺省时等于不包。上下文随异步调用链传下去，fn 里发起、没等的异步工作也算这个会话的。
 */
export function withWriteSession<T>(sessionId: string | undefined, fn: () => Promise<T>): Promise<T> {
  return sessionId === undefined ? fn() : writeSession.run(sessionId, fn)
}

/** 当前写入是哪个会话发起的；不在 withWriteSession 里（界面、后台）为 undefined。 */
export function currentWriteSession(): string | undefined {
  return writeSession.getStore()
}
