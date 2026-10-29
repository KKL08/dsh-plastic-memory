import type { RejectCode } from './contract-codes.ts'

/**
 * 有效期（validFrom / validTo）给人和模型看的唯一写法：本机时间 YYYY-MM-DD HH:mm。内部存储仍是 epoch 毫秒。
 * memory_save 入参另收只有日期的 YYYY-MM-DD，时分补写入时刻的（模型不一定知道现在几点）。
 */
export const VALIDITY_FORMAT = 'YYYY-MM-DD HH:mm'
/** memory_save 入参的只有日期写法：用户没说具体时刻时用。 */
export const VALIDITY_DATE_FORMAT = 'YYYY-MM-DD'

const INPUT_RE = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2}))?$/

export type ValidityParse =
  | { ok: true; ms: number }
  | { ok: false; code: Extract<RejectCode, 'validity-format' | 'validity-nonexistent'> }

/** 本机时间的年月日时分 → 毫秒；日历上不存在的日期返回 undefined（Date 会把 2 月 30 日静默滚成 3 月）。 */
export function localDateAt(y: number, mo: number, d: number, h: number, mi: number): number | undefined {
  const at = new Date(y, mo - 1, d, h, mi)
  return at.getFullYear() === y && at.getMonth() === mo - 1 && at.getDate() === d ? at.getTime() : undefined
}

/** memory_save 的有效期入参：YYYY-MM-DD HH:mm，或 YYYY-MM-DD（补上 now 的本机时分）。其余一律算格式不对。 */
export function parseValidityInput(value: unknown, now: number): ValidityParse {
  const m = typeof value === 'string' ? INPUT_RE.exec(value) : null
  if (!m) return { ok: false, code: 'validity-format' }
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const at = new Date(now)
  const [h, mi] = m[4] === undefined ? [at.getHours(), at.getMinutes()] : [Number(m[4]), Number(m[5])]
  if (h > 23 || mi > 59) return { ok: false, code: 'validity-nonexistent' }
  const ms = localDateAt(y, mo, d, h, mi)
  return ms === undefined ? { ok: false, code: 'validity-nonexistent' } : { ok: true, ms }
}

const MINUTE_MS = 60_000
/** 文件里读得回来的最晚时刻：再往后的 ISO 写法是 +010000 年，读取不认。 */
const LAST_READABLE_MS = Date.parse('9999-12-31T23:59:59.999Z')

/**
 * 有效期按分钟存（文件里写到分钟）：不在整分钟上的毫秒向外取整，validFrom 退到本分钟、validTo 进到下一分钟，
 * 有效期只会变长、不会提前过期。旧版本写的毫秒在读取、写回、快照比对时都按这条规则取整，几处看到的值一致。
 * validTo 进位会越过 9999 年末时保留原值。结果再取整不变。
 */
export function roundValidity(key: 'validFrom' | 'validTo', ms: number): number {
  if (key === 'validFrom') return Math.floor(ms / MINUTE_MS) * MINUTE_MS
  const up = Math.ceil(ms / MINUTE_MS) * MINUTE_MS
  return up > LAST_READABLE_MS ? ms : up
}

/** 毫秒 → 本机时间 YYYY-MM-DD HH:mm（秒以下舍去）。 */
export function formatValidity(ms: number): string {
  const at = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`
}
