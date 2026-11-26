import type { MemoryRecord } from '../record-schema.ts'

/**
 * 使用信号（实验）：召回次数之外，记下一条记忆有没有被认真读过、确认过、用过之后很快被纠错。
 * 只交给记忆梦境当参考，代码不拿它排序或降级。存在操作日志库里单独一张表，每台机器一份：
 * 丢了只少统计参考，库不可用时不记、不读。
 *
 * - 一行是一次信号：作用域 + 记忆 id + 种类 + 去重键。同一行再记一次什么都不做（不重复计），不同的键各记一行（不丢）。
 * - 行里不存字段值和正文，只有 id、会话 id、操作 id 和时刻。
 * - 记和读都在写入段之外：记是一条插入，读是一次查询，都靠 SQLite 自己的锁，不拿记忆根写锁。
 */

/**
 * 三种信号：
 * full-read 会话里按 id 读了这条记忆的全文；confirm 确认这条记忆仍然准确；
 * quick-correction 用过之后很快被纠错（判定见 isQuickCorrection）。
 */
export const USAGE_SIGNAL_KINDS = ['full-read', 'confirm', 'quick-correction'] as const
export type UsageSignalKind = (typeof USAGE_SIGNAL_KINDS)[number]

/** 最后一次召回之后多久之内的纠错算「很快」：24 小时（暂定，梦境用起来以后再看）。 */
export const QUICK_CORRECTION_WINDOW_MS = 24 * 60 * 60 * 1000

/** 记一笔信号。scope 是作用域的标准键（scopeKey）。 */
export interface UsageSignalInput {
  scope: string
  memoryId: string
  kind: UsageSignalKind
  /** 去重键：同一作用域、同一条记忆、同一种类下键相同的只算一次。 */
  key: string
  at: number
}

/** 一条记忆的信号计数：每种是不同去重键的个数。 */
export interface UsageSignalCounts {
  fullReads: number
  confirms: number
  quickCorrections: number
}

/** 使用信号的读写口（操作日志库实现它）。库不可用、读写失败时：写什么都不做（只记日志），读返回 undefined。都不抛错。 */
export interface UsageSignalLog {
  /** 记一笔；同一个（scope, memoryId, kind, key）已经记过就什么都不做。 */
  recordUsage(signal: UsageSignalInput): void
  /**
   * 这个作用域里这几条记忆的计数。没有任何行的记忆不在结果里（等于三项都是 0）；库里不认识的种类跳过。
   * 读不出返回 undefined：不知道有没有信号，不能当成都是 0。
   */
  readUsage(scope: string, memoryIds: readonly string[]): ReadonlyMap<string, UsageSignalCounts> | undefined
}

/**
 * 一次已经落盘的纠错算不算「用过之后很快纠错」：改前那一版有召回时刻，且纠错时刻减去它不超过 QUICK_CORRECTION_WINDOW_MS
 * （召回时刻晚于纠错时刻也算）。从没召回过的不算。纯函数。
 */
export function isQuickCorrection(before: Pick<MemoryRecord, 'lastRecalledAt'>, at: number): boolean {
  return before.lastRecalledAt !== null && at - before.lastRecalledAt <= QUICK_CORRECTION_WINDOW_MS
}
