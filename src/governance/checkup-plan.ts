import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { MemoryRecord } from '../record-schema.ts'
import type { CheckupCacheRow } from '../storage/checkup-cache.ts'
import { scopeKey, type Scope } from '../scope.ts'
import { uncheckedCount, type CheckupCoverage } from '../gui/contract.ts'
import type { InstructionFiles } from './instructions.ts'
import type { SemanticLlm } from './semantic-scan.ts'
import type { CrossWsDuplicate } from './cross-ws.ts'
import { findingSchema, type Finding } from './schema.ts'
import { copyKey, parseCopyKey, scanContentFingerprint, scanLineFingerprint, scopeKeyOf } from './changeset.ts'

/**
 * 增量体检的纯函数：判断上下文、批的键、库里一行算不算命中、发哪些批（顺序、上限、刷新）、覆盖、发布的发现、收尾表。不碰磁盘、不调模型。
 *
 * 体检照现在的方式把记忆分批交给模型（planSemanticBatches 不变）。成员和判断上下文都没变的批不再发，用上次存下的结论。
 * 一批由它的成员（每条记忆的副本身份和扫描指纹）和判断上下文认出来，和批内顺序无关。
 */

const sha1 = (value: unknown) => createHash('sha1').update(JSON.stringify(value)).digest('hex')

/** 判断上下文里指令文件的状态，四种互斥：没有、取不到、读到了（带摘要）、读到了但被截断（带摘要）。 */
export type InstructionState = 'none' | 'unavailable' | `read:${string}` | `truncated:${string}`

export function instructionState(files: InstructionFiles): InstructionState {
  if (files.kind === 'none') return 'none'
  if (files.kind === 'unavailable') return 'unavailable'
  return `${files.isTruncated ? 'truncated' : 'read'}:${sha1(files.texts)}`
}

/**
 * 判断上下文：提示词版本、提供方、模型、推理强度（拿不到取空串）、指令文件状态。任一项变了，按旧上下文查出的结论不再直接用。
 * 跨项目比较不看指令文件，instructions 给 null。
 */
export function checkContext(promptVersion: number, llm: Pick<SemanticLlm, 'provider' | 'model' | 'reasoningEffort'>, instructions: InstructionState | null): string {
  return JSON.stringify([promptVersion, llm.provider ?? '', llm.model ?? '', llm.reasoningEffort ?? '', ...(instructions === null ? [] : [instructions])])
}

/** 批的一个成员：副本身份（changeset.ts copyKey，作用域取预读实际选中的那份）和它的记忆行指纹（changeset.ts scanLineFingerprint）。 */
export type BatchMember = readonly [copy: string, fingerprint: string]

/** 一批的成员，按副本身份排序：批内顺序不影响批的键。 */
export function batchMembers(records: readonly MemoryRecord[]): BatchMember[] {
  return records
    .map((r): BatchMember => [memberCopyKey(r), scanLineFingerprint(r)])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
}

/**
 * 一个冲突的各成员此刻的内容指纹（副本身份 → 指纹，同批的成员）：挂账和结清（两条都留、标记误报、纵向的保留记忆、按方案改写）时记在待决条目上，
 * 再报同一冲突时它和冲突指纹都没变才算裁决过（见 governance/decisions.ts upsert）。只换出处、改动性质的补证不算变。
 */
export function memberScanFingerprints(records: readonly MemoryRecord[]): Record<string, string> {
  return Object.fromEntries(records.map(r => [memberCopyKey(r), scanContentFingerprint(r)]))
}

/** 一条记忆的副本身份。 */
export function memberCopyKey(r: Pick<MemoryRecord, 'id' | 'scope' | 'workspacePath'>): string {
  return copyKey({ scopeKey: scopeKeyOf(r), memoryId: r.id })
}

/** 副本身份里的记忆 id；认不出（不是这里写的形状）为 undefined。 */
export function memberIdOf(copy: string): string | undefined {
  return parseCopyKey(copy)?.memoryId
}

/** 批的键：判断上下文加排好序的成员。 */
export function batchKey(ctx: string, members: readonly BatchMember[]): string {
  return sha1([ctx, [...members].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))])
}

// —— 库里的行 ——

/** 跨项目比较那一轮的键。 */
export const CROSS_WS_ROUND = 'cross-ws'

/** 一轮的键：范围的标准键（全局 `global`，项目为路径）。 */
export function roundOf(scope: Scope): string {
  return scopeKey(scope)
}

/** 普通轮一行的结论：这一批的发现。 */
export type FindingsRow = CheckupCacheRow & { result: Finding[] }
/** 跨项目比较一行的结论：它自己的结果结构。 */
export type CrossWsRow = CheckupCacheRow & { result: CrossWsDuplicate[] }

const crossWsDuplicatesSchema = z.array(z.object({ topic: z.string(), workspaces: z.array(z.string()), suggestion: z.string(), memoryIds: z.array(z.string()).optional(), promote: z.string().optional() }))

/** 普通轮的行过结构校验：结论是发现的数组，每条发现引用的记忆 id 都在这一行的成员里。过不了的不要。 */
export function findingsRows(rows: readonly CheckupCacheRow[]): FindingsRow[] {
  return rows.flatMap((row) => {
    const parsed = z.array(findingSchema).safeParse(row.result)
    if (!parsed.success) return []
    const ids = new Set(row.members.map(([copy]) => memberIdOf(copy)))
    return parsed.data.every(f => f.memoryIds.length > 0 && f.memoryIds.every(id => ids.has(id))) ? [{ ...row, result: parsed.data }] : []
  })
}

/** 跨项目比较的行过结构校验：结论是它自己的结果结构，每条主题非空、涉及至少两个项目，且都在这一行的成员里。过不了的不要。 */
export function crossWsRows(rows: readonly CheckupCacheRow[]): CrossWsRow[] {
  return rows.flatMap((row) => {
    const parsed = crossWsDuplicatesSchema.safeParse(row.result)
    if (!parsed.success) return []
    const scopes = new Set(row.members.map(([scope]) => scope))
    const isValid = parsed.data.every(d => d.topic.length > 0 && d.workspaces.length >= 2 && d.workspaces.every(w => scopes.has(w)))
    return isValid ? [{ ...row, result: parsed.data }] : []
  })
}

/** 成员一样（都按副本身份排好序）。 */
function sameMembers(a: readonly BatchMember[], b: readonly BatchMember[]): boolean {
  return a.length === b.length && a.every(([copy, fp], i) => b[i]![0] === copy && b[i]![1] === fp)
}

/** 一行算不算这一批的命中：键相等、成员和这一批一致（结构校验已过）、检查时刻不早于这一轮的全部重查时刻（没有当 0）。 */
export function isHit(row: CheckupCacheRow | undefined, batch: { key: string; members: readonly BatchMember[] }, recheckBefore: number): boolean {
  return row !== undefined && row.key === batch.key && sameMembers(row.members, batch.members) && row.checkedAt >= recheckBefore
}

// —— 计划 ——

/** 整次体检的 token 上限暂定值（配置 governance.scan.tokenCap）。 */
export const SCAN_TOKEN_CAP_DEFAULT = 200_000

/** 命中但查得早于这么久的批，预算有余时刷新一次。 */
export const REFRESH_AFTER_MS = 30 * 86_400_000

/** 配置的上限：正的有限数才用；否则用默认值，isInvalid 告诉调用方记日志。 */
export function resolveTokenCap(raw: unknown): { cap: number; isInvalid: boolean } {
  if (raw === undefined) return { cap: SCAN_TOKEN_CAP_DEFAULT, isInvalid: false }
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? { cap: raw, isInvalid: false } : { cap: SCAN_TOKEN_CAP_DEFAULT, isInvalid: true }
}

/** 计划里的一批：发给模型的估算 token（系统提示加用户消息）、命中的那一行（没命中为 undefined）。 */
export interface PlannedBatch {
  cost: number
  hit: CheckupCacheRow | undefined
}

/** 计划里的一轮：轮的顺序按上次写完成记录的时间（没有为 null），相同时全局在前、项目按路径。 */
export interface PlannedRound {
  round: string
  scope: Scope
  lastCompletedAt: number | null
  batches: readonly PlannedBatch[]
}

export type PlanStep =
  | { kind: 'batch'; round: string; index: number; isRefresh: boolean }
  | { kind: 'cross-ws' }

/**
 * 一次体检发哪些批、按什么顺序（各轮和跨项目比较共用一个上限）：
 * 1. 各轮没命中的批轮流取：轮按上次写完成记录的时间从旧到新（没有的最前；相同时全局在前、项目按路径），一轮取一批再到下一轮；轮内按分批的顺序。
 * 2. 跨项目比较（给了且没命中时）。
 * 3. 刷新：命中但查得早于 REFRESH_AFTER_MS 的批，按检查时间从旧到新，只用剩下的预算。
 * 上限按每批的估算累计：累计超过上限的那一批及之后的都不发（isCapped）。整次发出的第一批不受上限限制（只这一批），刷新批不享受。
 * 刷新放不下就停，不保证进度。
 */
export function planCheckup(input: { rounds: readonly PlannedRound[]; crossWs?: { cost: number; isHit: boolean }; cap: number; now: number }): { steps: PlanStep[]; isCapped: boolean } {
  const rounds = [...input.rounds].sort(compareRounds)
  const queues = rounds.map(r => r.batches.flatMap((b, index) => (b.hit === undefined ? [{ kind: 'batch' as const, round: r.round, index, isRefresh: false, cost: b.cost }] : [])))
  const primary: Array<PlanStep & { cost: number }> = []
  for (let i = 0; queues.some(q => q.length > i); i++) for (const q of queues) if (q[i] !== undefined) primary.push(q[i]!)
  if (input.crossWs !== undefined && !input.crossWs.isHit) primary.push({ kind: 'cross-ws', cost: input.crossWs.cost })

  const steps: PlanStep[] = []
  let spent = 0
  for (const { cost, ...step } of primary) {
    if (steps.length > 0 && spent + cost > input.cap) return { steps, isCapped: true }
    steps.push(step)
    spent += cost
  }
  const due = rounds.flatMap(r => r.batches.flatMap((b, index) => (b.hit !== undefined && b.hit.checkedAt < input.now - REFRESH_AFTER_MS
    ? [{ round: r.round, index, cost: b.cost, checkedAt: b.hit.checkedAt }]
    : [])))
  // 稳定排序：检查时间相同的按轮的顺序、轮内顺序
  due.sort((a, b) => a.checkedAt - b.checkedAt)
  for (const { round, index, cost } of due) {
    if (spent + cost > input.cap) break
    steps.push({ kind: 'batch', round, index, isRefresh: true })
    spent += cost
  }
  return { steps, isCapped: false }
}

function compareRounds(a: PlannedRound, b: PlannedRound): number {
  const at = (r: PlannedRound) => r.lastCompletedAt ?? -Infinity
  if (at(a) !== at(b)) return at(a) - at(b)
  if (a.scope.kind !== b.scope.kind) return a.scope.kind === 'global' ? -1 : 1
  const pa = scopeKey(a.scope)
  const pb = scopeKey(b.scope)
  return pa < pb ? -1 : pa > pb ? 1 : 0
}

// —— 一轮的结果：覆盖、发布、收尾 ——

/** 整次体检停在哪（这一轮是否被它影响见 coverageOf）。 */
export type RunStop = 'done' | 'cap' | 'batch-failed' | 'model-unavailable'

/** 一轮里的一批这次的情况：成员、命中的行（isHit 为真的才给）、这次发了没有和成没成。 */
export interface BatchOutcome {
  members: readonly BatchMember[]
  hit: CheckupCacheRow | undefined
  sent?: 'ok' | 'failed'
}

/** 这一批这次有有效结果：命中，或这次查成功。 */
export function isBatchValid(b: BatchOutcome): boolean {
  return b.sent === 'ok' || b.hit !== undefined
}

/**
 * 一轮的覆盖（口径见 gui/contract.ts checkupCoverageSchema）。history 是库里这一轮全部过了结构校验的行，库这次读不了为 undefined。
 * 停在哪：没有缺结果的批是 done；整次停在模型用不了时照它；这一轮没命中的批一批都没发过是 not-reached；其余照整次停下的原因。
 */
export function coverageOf(input: {
  isReadComplete: boolean
  baseline: CheckupCoverage['baseline']
  total: number
  globalTotal?: number
  batches: readonly BatchOutcome[]
  history: readonly CheckupCacheRow[] | undefined
  runStop: RunStop
}): CheckupCoverage {
  const { batches, history } = input
  const unresolved = new Map<string, string>()
  for (const b of batches) if (!isBatchValid(b)) for (const [copy, fp] of b.members) unresolved.set(copy, fp)
  const checked = new Set(batches.flatMap(b => (b.sent === 'ok' ? b.members.map(([copy]) => copy) : [])))
  let never = 0
  let changed = 0
  let awaiting = 0
  for (const [copy, fp] of unresolved) {
    const seen = history?.flatMap(row => row.members.filter(([c]) => c === copy).map(([, f]) => f)) ?? []
    if (seen.includes(fp)) awaiting++
    else if (seen.length > 0) changed++
    else never++
  }
  const kept = batches.flatMap(b => (b.hit !== undefined && b.sent !== 'ok' ? [b.hit.checkedAt] : []))
  const isAttempted = batches.some(b => b.hit === undefined && b.sent !== undefined)
  const stopped: CheckupCoverage['stopped'] = unresolved.size === 0 ? 'done'
    : input.runStop === 'model-unavailable' ? input.runStop
      : !isAttempted ? 'not-reached'
        : input.runStop === 'done' ? 'cap' : input.runStop
  return {
    isReadComplete: input.isReadComplete,
    baseline: input.baseline,
    total: input.total,
    ...(input.globalTotal !== undefined ? { globalTotal: input.globalTotal } : {}),
    checkedNow: checked.size,
    ...(history === undefined ? { never: never + changed + awaiting, changed: 0, awaiting: 0, isHistoryUnknown: true as const } : { never, changed, awaiting }),
    oldestCheckedAt: kept.length > 0 ? Math.min(...kept) : null,
    stopped,
  }
}

/**
 * 沿用的发现：库里这一轮过时的行（键对不上当前任何一批）或被全部重查作废的行里的发现，它引用的每条记忆现在的扫描指纹
 * 等于那一行记的（currentOf 返回 'unread' 的是范围读不全时读不到的，算相等），并且至少有一条这次没有有效结果
 * （在没有有效结果的批里，或读不到）；查得更晚的行已经查过这组记忆（成员指纹和现在一致）的，旧行里的发现不再沿用。
 * 沿用的只进视图，不重新挂账。
 */
export function carriedFindings(input: {
  rows: readonly FindingsRow[]
  currentKeys: ReadonlySet<string>
  recheckBefore: number
  /** 一份副本现在的扫描指纹（过了语义检查准入的）；读不全时读不到的为 'unread'；没有了（删了、过期了）为 undefined。 */
  currentOf: (copy: string) => string | 'unread' | undefined
  /** 这次没有有效结果的批里的副本。 */
  unresolved: ReadonlySet<string>
}): Finding[] {
  const out: Finding[] = []
  const isCurrent = (copy: string, fp: string) => {
    const now = input.currentOf(copy)
    return now === 'unread' || now === fp
  }
  // 更新的行查过同一组记忆（成员指纹和现在一致）：更旧的行里关于它们的发现已被那次检查取代
  const isSuperseded = (row: FindingsRow, copies: readonly string[]) => input.rows.some(newer => newer.checkedAt > row.checkedAt
    && copies.every(copy => newer.members.some(([c, fp]) => c === copy && isCurrent(c, fp))))
  for (const row of input.rows) {
    if (input.currentKeys.has(row.key) && row.checkedAt >= input.recheckBefore) continue
    const copyOf = new Map<string, readonly [string, string]>()
    for (const member of row.members) {
      const id = memberIdOf(member[0])
      if (id !== undefined && !copyOf.has(id)) copyOf.set(id, member)
    }
    for (const f of row.result) {
      const refs = f.memoryIds.map(id => copyOf.get(id)!)
      const isSame = refs.every(([copy, fp]) => isCurrent(copy, fp))
      const isPending = refs.some(([copy]) => input.unresolved.has(copy) || input.currentOf(copy) === 'unread')
      if (isSame && isPending && !isSuperseded(row, refs.map(([copy]) => copy))) out.push(f)
    }
  }
  return out
}

/** 视图里的发现：各批有效结果的发现在前，沿用的在后，同一发现（类型、涉及的记忆、基线出处）只留一条。 */
export function publishedFindings(valid: readonly (readonly Finding[])[], carried: readonly Finding[]): Finding[] {
  const seen = new Set<string>()
  const out: Finding[] = []
  for (const f of [...valid.flat(), ...carried]) {
    const key = `${f.type}|${[...f.memoryIds].sort().join('+')}|${f.baselineRef ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(f)
  }
  return out
}

/**
 * 收尾表（界面手动和自动体检；完成记录由体检核心按它写）。从上到下取第一条命中的：
 * model-unavailable 模型用不了；failed 有批失败或提交前的存储步骤失败；read-incomplete 范围读不全；
 * not-reached 有没命中的批但一批都没轮到；capped 到上限停下、还有没有效结果的批；complete 其余（全覆盖、本来没有要查的、
 * 只因指令文件取不到或被截断不算全覆盖、只剩刷新没轮到）。
 */
export type ClosingRow = 'model-unavailable' | 'failed' | 'read-incomplete' | 'not-reached' | 'capped' | 'complete'

export function closingRow(c: CheckupCoverage, isStorageFailed: boolean): ClosingRow {
  if (c.stopped === 'model-unavailable') return 'model-unavailable'
  if (c.stopped === 'batch-failed' || isStorageFailed) return 'failed'
  if (!c.isReadComplete) return 'read-incomplete'
  if (c.stopped === 'not-reached') return 'not-reached'
  return uncheckedCount(c) > 0 ? 'capped' : 'complete'
}

/** 这一行写不写完成记录。 */
export function isCompletionRow(row: ClosingRow): boolean {
  return row === 'capped' || row === 'complete'
}
