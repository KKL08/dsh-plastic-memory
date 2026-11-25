/**
 * 体检覆盖的界面写法（状态条、左栏、设置页状态卡、待处理空态共用）。覆盖的口径见 src/gui/contract.ts checkupCoverageSchema；
 * 没覆盖全时这些地方都不说「没有发现问题」「良好」「状态良好」，改说还有几条没查到。上一个发布版写的记录没有覆盖，照旧。
 */
import { isCoverageClear, uncheckedCount, type CheckupCoverage } from '../../src/gui/contract.ts'
import { formatDay, formatNumber, type Translate } from '../i18n.tsx'

/** 覆盖的那一行：共几条（项目写明含全局几条）· 这次查了几条 · 三种没查到的（为 0 的省略）· 最久一次检查 · 指令文件、没读全。 */
export function coverageParts(c: CheckupCoverage, now: number, t: Translate): string[] {
  const parts = [
    c.globalTotal !== undefined
      ? t(c.total === 1 ? 'checkup.status.coverage.totalGlobal.one' : 'checkup.status.coverage.totalGlobal', { n: formatNumber(c.total), global: formatNumber(c.globalTotal) })
      : t(c.total === 1 ? 'checkup.status.coverage.total.one' : 'checkup.status.coverage.total', { n: formatNumber(c.total) }),
    t('checkup.status.coverage.checked', { n: formatNumber(c.checkedNow) }),
  ]
  if (c.isHistoryUnknown === true) {
    if (c.never > 0) parts.push(t('checkup.status.coverage.unknown', { n: formatNumber(c.never) }))
  } else {
    if (c.never > 0) parts.push(t('checkup.status.coverage.never', { n: formatNumber(c.never) }))
    if (c.changed > 0) parts.push(t('checkup.status.coverage.changed', { n: formatNumber(c.changed) }))
    if (c.awaiting > 0) parts.push(t('checkup.status.coverage.awaiting', { n: formatNumber(c.awaiting) }))
  }
  if (c.oldestCheckedAt !== null) parts.push(t('checkup.status.coverage.oldest', { date: formatDay(c.oldestCheckedAt, now, t) }))
  if (c.baseline === 'unavailable') parts.push(t('checkup.status.coverage.baselineUnavailable'))
  if (c.baseline === 'truncated') parts.push(t('checkup.status.coverage.baselineTruncated'))
  if (!c.isReadComplete) parts.push(t('checkup.status.coverage.readIncomplete'))
  return parts
}

/**
 * 几个范围合起来：有几个范围没查全、还有几条没查。上次体检没覆盖全的算没查全，有记忆却从没体检过的也算（别的范围查过时，
 * 不能因此说「状态良好」）。条数只在恰好一个范围没查全时给（从没体检过的给 0）：项目的条数含全局记忆，几个范围相加会重复。
 */
export function partialOf(scopes: ReadonlyArray<{ totalMemories: number; lastCheckupAt: number | null; coverage?: CheckupCoverage | undefined }>): { scopes: number; unchecked: number } {
  const partial = scopes.filter(s => (s.lastCheckupAt === null ? s.totalMemories > 0 : !isCoverageClear(s.coverage)))
  const only = partial.length === 1 ? partial[0]!.coverage : undefined
  return { scopes: partial.length, unchecked: only !== undefined ? uncheckedCount(only) : 0 }
}
