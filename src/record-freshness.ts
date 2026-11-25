import type { MemoryRecord } from './record-schema.ts'

const DAY_MS = 86_400_000

/**
 * 陈旧度标注（注入侧与 search 结果共用）：超过类型衰退期未确认的记忆，行尾提示模型
 * 引用前存疑、必要时向用户确认。只在渲染时计算、不落 status——磁盘索引有意不带
 * （静态文件里的时间相对标注会随时间失真），因此不能进 formatIndexLine。
 */
/** 陈旧度标注文案模板；search/快照渲染与测试共用。 */
export const STALENESS_NOTE = (days: number): string => `（已 ${days} 天未确认，可能过时）`

export function stalenessNote(r: MemoryRecord, decayDays: number | null, now: number): string {
  if (decayDays === null) return ''
  const days = Math.floor((now - r.lastConfirmedAt) / DAY_MS)
  return days > decayDays ? STALENESS_NOTE(days) : ''
}

/** 已过期：有截止时间且不晚于现在。 */
export function isExpired(r: Pick<MemoryRecord, 'validTo'>, now: number): boolean {
  return r.validTo !== undefined && r.validTo <= now
}

/** 已生效：没有起始时间，或起始时间不晚于现在。 */
export function isInEffect(r: Pick<MemoryRecord, 'validFrom'>, now: number): boolean {
  return r.validFrom === undefined || r.validFrom <= now
}

/** 注入和检索仅使用已生效且未过期的记忆；规则体检只判断过期。 */
export function withinValidity(r: MemoryRecord, now: number): boolean {
  return isInEffect(r, now) && !isExpired(r, now)
}
