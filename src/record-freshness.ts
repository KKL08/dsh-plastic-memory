import type { MemoryRecord } from './record-schema.ts'

const DAY_MS = 86_400_000

/**
 * 陈旧度标注（注入侧与 search 结果共用）：超过类型衰减期未确认的记忆，行尾提示模型
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

/** validTo 是模型显式声明的失效时间：过了就不该再进注入和检索——治理扫描仍可见（按 status 查询），由 expired finding 引导清理。 */
export function withinValidity(r: MemoryRecord, now: number): boolean {
  return r.validTo === undefined || r.validTo >= now
}
