import { createHash } from 'node:crypto'
import type { MemoryRecord } from '../record-schema.ts'
import { scopeKey, type Scope } from '../scope.ts'
import { autoCheckupRetryAt } from './auto-checkups.ts'

/**
 * 记忆梦境什么时候可以开始：范围开关的取值、四道门槛、变化计数、七天用量。纯函数，不碰磁盘、不读时钟。
 *
 * 四道门槛（同时满足才开始）：① 距上次做完满设定的天数，并且期间内容变了的记忆够多、没回看的用户消息够多或上次没做完；
 * ② 这个范围空闲；③ 没有别的梦境、体检、整理占着这个范围（就是认领，由调用方做）；④ 最近七天的用量没到上限。
 * 这里按 ①、④、② 的顺序判：前两道只用侧表里的数，② 要调用方另外去查，没查时不给 isIdle。
 */

const DAY_MS = 86_400_000

export interface DreamsConfig {
  minIntervalDays: number
  minChanges: number
  minNewMessages: number
  idleMinutes: number
  /** 最近七天后台用量的上限（token）；0 为不限。 */
  weeklyTokenCap: number
  /** 一次运行最多改动本范围在用记忆的比例，取 (0, 1]。 */
  maxChangeRatio: number
}

export const DREAMS_DEFAULTS: DreamsConfig = { minIntervalDays: 7, minChanges: 30, minNewMessages: 50, idleMinutes: 30, weeklyTokenCap: 2_000_000, maxChangeRatio: 0.2 }

/**
 * 配置里读到的值整理成可用的：间隔、阈值、空闲分钟数要是正数，用量上限要不小于 0，改动比例在 (0, 1] 里；不是的那一项用默认值。
 * badKeys 是用了默认值的键（调用方记日志）。
 */
export function resolveDreamsConfig(raw: Partial<Record<keyof DreamsConfig, unknown>>): { config: DreamsConfig; badKeys: Array<keyof DreamsConfig> } {
  const config = { ...DREAMS_DEFAULTS }
  const badKeys: Array<keyof DreamsConfig> = []
  for (const key of Object.keys(DREAMS_DEFAULTS) as Array<keyof DreamsConfig>) {
    const value = raw[key]
    if (value === undefined) continue
    const isOk = typeof value === 'number' && Number.isFinite(value)
      && (key === 'weeklyTokenCap' ? value >= 0 : key === 'maxChangeRatio' ? value > 0 && value <= 1 : value > 0)
    if (isOk) config[key] = value
    else badKeys.push(key)
  }
  return { config, badKeys }
}

/** 开关表里「全部」的键：它的值是默认值，管没单独设过的范围。 */
export const DREAMS_ALL_KEY = 'all'

/** 范围开关的取值：settings 是开关表的内容（范围键 → 设了的值）。单独设过的用自己的，没设过的跟随默认值，默认值没设是关。 */
export function resolveDreamsEnabled(settings: ReadonlyMap<string, boolean>, scope: Scope): { isEnabled: boolean; isOwn: boolean } {
  const own = settings.get(scopeKey(scope))
  return own === undefined ? { isEnabled: settings.get(DREAMS_ALL_KEY) ?? false, isOwn: false } : { isEnabled: own, isOwn: true }
}

/**
 * 内容指纹：名称、摘要、正文、事实时间、有效期、取代关系。只用来数「内容变了的记忆」：
 * 补证改的来源方式和确认时间、召回统计、标签都不算内容变化。
 */
export function dreamContentFingerprint(r: Pick<MemoryRecord, 'name' | 'summary' | 'content' | 'factTime' | 'validFrom' | 'validTo' | 'supersedes'>): string {
  const parts = [r.name, r.summary, r.content, r.factTime ?? null, r.validFrom ?? null, r.validTo ?? null, r.supersedes ?? []]
  return createHash('sha1').update(JSON.stringify(parts)).digest('hex').slice(0, 16)
}

/**
 * 变化数：现在有而基线没有的、基线有而现在没有的、两边都有而指纹不同的，各算一条。
 * 没有基线（从没做完过）时每条在用记忆算一条。
 */
export function countChanges(marks: Readonly<Record<string, string>> | undefined, current: Readonly<Record<string, string>>): number {
  if (marks === undefined) return Object.keys(current).length
  let changed = 0
  for (const [id, fingerprint] of Object.entries(current)) if (marks[id] !== fingerprint) changed++
  for (const id of Object.keys(marks)) if (!(id in current)) changed++
  return changed
}

/**
 * 一次运行最多改动几条记忆：本范围在用条数乘比例取整，至少 1（小库不算成 0）。同一次运行里各步共用这一份，
 * 同一条记忆做几个操作只算一条。
 */
export function changeQuota(activeCount: number, ratio: number): number {
  return Math.max(1, Math.floor(activeCount * ratio))
}

export interface UsageRun { at: number; tokens: number }

/** 最近 7×24 小时内各次运行的用量之和。按滚动的七天算，不按自然周。 */
export function usageWithin(runs: readonly UsageRun[], now: number): number {
  return runs.reduce((sum, run) => (run.at > now - 7 * DAY_MS ? sum + run.tokens : sum), 0)
}

/** 门槛要看的那部分运行记录。 */
export interface DreamsRunState {
  completed?: { runId: string; startedAt: number; endedAt: number }
  unfinished?: { runId: string; startedAt: number; stoppedAt: number; reason: string }
  failure?: { count: number; failedAt: number }
}

export interface DreamsGateInput {
  now: number
  config: DreamsConfig
  /** 这个范围的运行记录；从没跑过为 undefined。 */
  record: DreamsRunState | undefined
  /**
   * 上次做完之后内容变了的记忆数（countChanges）。'unknown'：做完过但基线不可用，不知道变了多少，按够数算；
   * 不给：调用方还没读记忆，这一条先不判（只在间隔、重试、用量上能否决）。
   */
  changes?: number | 'unknown'
  /** 没回看的用户消息数；回看补记没开、不可用时不给。 */
  unreviewedMessages?: number
  usageRuns: readonly UsageRun[]
  /** 这个范围现在空闲；调用方还没查时不给（只判第 1、4 道）。 */
  isIdle?: boolean
  /** 用户手动要跑：不看间隔、变化和空闲。 */
  isManual?: boolean
}

export type DreamsGateResult =
  | { pass: true }
  | { pass: false; gate: 1; reason: 'too-soon' | 'no-changes' | 'retry-later' }
  | { pass: false; gate: 2; reason: 'busy' }
  | { pass: false; gate: 4; reason: 'over-budget' }

export function dreamsGate(input: DreamsGateInput): DreamsGateResult {
  const { now, config, record } = input
  if (input.isManual !== true) {
    const hasUnfinished = record?.unfinished !== undefined
    // 间隔只按做完的那次算；有没做完的运行时不看间隔，空闲了就接着做
    const completedAt = record?.completed?.endedAt
    if (!hasUnfinished && completedAt !== undefined && now - completedAt < config.minIntervalDays * DAY_MS) return { pass: false, gate: 1, reason: 'too-soon' }
    // 连续出错的另有重试时间（和自动体检同一个算法）
    const failure = record?.failure
    if (failure !== undefined && failure.count > 0 && now < autoCheckupRetryAt(failure.count, failure.failedAt, config.minIntervalDays)) {
      return { pass: false, gate: 1, reason: 'retry-later' }
    }
    const { changes } = input
    const hasEnough = hasUnfinished || changes === 'unknown' || (changes ?? 0) >= config.minChanges || (input.unreviewedMessages ?? 0) >= config.minNewMessages
    if (changes !== undefined && !hasEnough) return { pass: false, gate: 1, reason: 'no-changes' }
  }
  if (config.weeklyTokenCap > 0 && usageWithin(input.usageRuns, now) >= config.weeklyTokenCap) return { pass: false, gate: 4, reason: 'over-budget' }
  if (input.isManual !== true && input.isIdle === false) return { pass: false, gate: 2, reason: 'busy' }
  return { pass: true }
}
