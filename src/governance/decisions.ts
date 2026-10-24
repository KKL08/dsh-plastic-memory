import { createHash } from 'node:crypto'
import type { KvTable } from '../kv-table.ts'
import type { MemoryRecord } from '../record-schema.ts'
import { RETENTION_MS } from '../retention.ts'
import type { OverflowLevel } from '../contract-codes.ts'
import { genId, type PendingDecision, type PendingKind, type SettledVerdict } from './schema.ts'

/** 去重 key：memoryIds 排序拼接 + baselineRef（垂直冲突与横向冲突互不干扰）。 */
export function dedupKey(memoryIds: string[], baselineRef?: string): string {
  return [...memoryIds].sort().join('|') + (baselineRef ? `#${baselineRef}` : '')
}

/**
 * 冲突双方的内容指纹：按 id 排序取 name + content；垂直冲突再加整份基线。任一方改写或基线变了，指纹就变。
 * 垂直冲突不看 baselineRef：它是 LLM 自由填写的出处描述，每次扫描措辞都可能不同。
 */
export function conflictFingerprint(records: ReadonlyArray<Pick<MemoryRecord, 'id' | 'name' | 'content'>>, baseline?: readonly string[]): string {
  const parts = [...records].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map(r => [r.id, r.name, r.content])
  return createHash('sha1').update(JSON.stringify({ parts, baseline: baseline ?? null })).digest('hex')
}

/** 提升候选的内容指纹：单条记忆的 id + name + content。内容改了，「留在本项目」的旧结论作废。 */
export function candidateFingerprint(record: Pick<MemoryRecord, 'id' | 'name' | 'content'>): string {
  return conflictFingerprint([record])
}

type KindKeyed ={ kind?: PendingKind; memoryIds: string[]; baselineRef?: string }

/** 条目种类，缺省即冲突（旧条目）。 */
export function kindOf(entry: { kind?: PendingKind }): PendingKind {
  return entry.kind ?? 'conflict'
}

/** 两个条目是否同一种类、指同一组记忆、同一类冲突（横向 / 垂直），不看 baselineRef 措辞。 */
function samePair(a: KindKeyed, b: KindKeyed): boolean {
  return kindOf(a) === kindOf(b) && dedupKey(a.memoryIds) === dedupKey(b.memoryIds) && (a.baselineRef !== undefined) === (b.baselineRef !== undefined)
}

/**
 * 裁决要删掉的一方（败方）；两边都留、或不是冲突条目时为 undefined。
 * 横向：left=memoryIds[0]、right=memoryIds[1]；垂直（有 baselineRef）：left=记忆、right=基线，基线不可删，keep-right 意为记忆删除。
 */
export function verdictLoser(entry: KindKeyed, verdict: SettledVerdict): string | undefined {
  if (kindOf(entry) !== 'conflict') return undefined
  if (entry.baselineRef !== undefined) return verdict === 'keep-right' ? entry.memoryIds[0] : undefined
  return verdict === 'keep-left' ? entry.memoryIds[1] : verdict === 'keep-right' ? entry.memoryIds[0] : undefined
}

/** 已裁决且裁决删掉了一方的条目。 */
function isDeletionSettled(entry: PendingDecision): boolean {
  return entry.settled !== undefined && verdictLoser(entry, entry.settled.verdict) !== undefined
}

/** 留作撤销的已裁决条目（删一方、提升为全局）：快照过了保留窗口就无从撤销，由 sweep 清掉。 */
function isUndoable(entry: PendingDecision): boolean {
  return isDeletionSettled(entry) || entry.settled?.verdict === 'promoted'
}

/** 超限条目的指纹：relax 为档位号（'1'、'2'…），strict 只有一档。 */
const STRICT_OVERFLOW_FINGERPRINT = 'strict-95'

export function overflowFingerprint(level: OverflowLevel): string {
  return level.mode === 'strict' ? STRICT_OVERFLOW_FINGERPRINT : String(level.tier)
}

/** 超限条目的档位（由指纹还原）。 */
export function overflowLevelOf(entry: Pick<PendingDecision, 'fingerprint'>): OverflowLevel {
  return entry.fingerprint === STRICT_OVERFLOW_FINGERPRINT
    ? { mode: 'strict', tier: 0 }
    : { mode: 'relax', tier: Number.parseInt(entry.fingerprint ?? '', 10) || 0 }
}

/** 超限条目所属的项目（workspace 路径，无项目的会话为 'global'），存在 workspaces[0]。 */
export function overflowScopeOf(entry: Pick<PendingDecision, 'workspaces'>): string | undefined {
  return entry.workspaces?.[0]
}

type UpsertInput = { kind?: PendingKind; memoryIds: string[]; baselineRef?: string; summary: string; workspaces?: string[]; fingerprint?: string }

/** 同键再报：更新 summary / workspaces / 指纹，保留 id 与 firstSeenAt。workspaces 与 memoryIds 一一对应，按已有条目的 id 顺序重排。 */
function mergeReport(existing: PendingDecision, input: UpsertInput): PendingDecision {
  const wsById = new Map(input.memoryIds.map((id, i) => [id, input.workspaces?.[i]]))
  const workspaces = input.workspaces !== undefined ? existing.memoryIds.map(id => wsById.get(id) ?? '(未知)') : undefined
  return {
    ...existing, summary: input.summary,
    ...(workspaces !== undefined ? { workspaces } : {}),
    ...(input.fingerprint !== undefined ? { fingerprint: input.fingerprint } : {}),
  }
}

/**
 * pending-decisions 待决账本（docs/p1-governance-health-design.md §4）。种类见 kind：冲突（缺省）、提升候选、超限提醒。
 * 裁决一律标 settled 留在账本里：两边都留的（含提升候选「留在本项目」、超限「忽略」），指纹不变时不再挂账，
 * 指纹变了（任一方改写、基线变了、换了档位）旧结论作废、按新条目重报；删掉一方的记下快照 id 供撤销，
 * 同一对再被扫到（败方回来了）就回到待处理，败方超出保留窗口后由 sweep 清掉。
 * settled 条目对 get / list 不可见，只有 listSettled、upsert、removeByMemoryIds、sweep 会看到它。
 */
export class PendingDecisionsStore {
  private table: KvTable<PendingDecision>

  constructor(table: KvTable<PendingDecision>) {
    this.table = table
  }

  async list(): Promise<PendingDecision[]> {
    return (await this.table.list()).map(([, e]) => e).filter(e => !e.settled).sort((a, b) => a.firstSeenAt - b.firstSeenAt)
  }

  async get(id: string): Promise<PendingDecision | undefined> {
    const entry = await this.table.get(id)
    return entry?.settled ? undefined : entry
  }

  /** 已裁决条目（含删一方留作撤销的），按裁决时间升序。 */
  async listSettled(): Promise<PendingDecision[]> {
    return (await this.table.list()).map(([, e]) => e).filter(e => e.settled).sort((a, b) => a.settled!.at - b.settled!.at)
  }

  /** settled：命中已裁决条目且指纹没变，没有挂账，entry 是那条已裁决条目。 */
  async upsert(input: UpsertInput, now: number): Promise<{ created: boolean; settled?: true; entry: PendingDecision }> {
    const entries = await this.table.list()
    for (const [key, existing] of entries) {
      if (!existing.settled || !samePair(existing, input)) continue
      if (isDeletionSettled(existing)) {
        // 删一方的裁决：同一对又被扫到，说明败方回来了（快照恢复等），回到待处理，沿用原条目
        const { settled: _settled, ...open } = existing
        const reopened = mergeReport(open, input)
        await this.table.put(reopened.id, reopened)
        return { created: false, entry: reopened }
      }
      if (input.fingerprint !== undefined && existing.fingerprint === input.fingerprint) return { created: false, settled: true, entry: existing }
      await this.table.delete(key) // 指纹变了：旧结论作废
    }
    const key = dedupKey(input.memoryIds, input.baselineRef)
    for (const [, existing] of entries) {
      if (existing.settled || kindOf(existing) !== kindOf(input)) continue
      if (dedupKey(existing.memoryIds, existing.baselineRef) === key) {
        const updated = mergeReport(existing, input)
        await this.table.put(updated.id, updated)
        return { created: false, entry: updated }
      }
    }
    const entry: PendingDecision = {
      id: genId('pd'),
      ...(input.kind !== undefined && input.kind !== 'conflict' ? { kind: input.kind } : {}),
      memoryIds: input.memoryIds,
      ...(input.baselineRef !== undefined ? { baselineRef: input.baselineRef } : {}),
      summary: input.summary,
      firstSeenAt: now,
      ...(input.workspaces !== undefined ? { workspaces: input.workspaces } : {}),
      ...(input.fingerprint !== undefined ? { fingerprint: input.fingerprint } : {}),
    }
    await this.table.put(entry.id, entry)
    return { created: true, entry }
  }

  /**
   * 记下裁决。两边都留的靠指纹判断以后变没变：没有指纹的旧条目无从判断，退回直接移除，返回 false。
   * 删一方的留账是为了撤销，不看指纹；snapshotId 是删败方前的快照。顺手清扫超出保留窗口的条目。
   */
  async settle(id: string, verdict: SettledVerdict, now: number, opts: { snapshotId?: string } = {}): Promise<boolean> {
    const entry = await this.table.get(id)
    if (!entry) return false
    if (entry.fingerprint === undefined && verdictLoser(entry, verdict) === undefined) {
      await this.table.delete(id)
      return false
    }
    await this.table.put(id, { ...entry, settled: { verdict, at: now, ...(opts.snapshotId !== undefined ? { snapshotId: opts.snapshotId } : {}) } })
    await this.sweep(now)
    return true
  }

  /**
   * 连带清理：删一方的已裁决条目，败方软删时刻就是裁决时刻，超出保留窗口后败方已被维护点物理删除、
   * 快照也已过期，撤销无从谈起，条目一起清掉（提升为全局的同理：快照过期即不可撤销）（与 storage 维护点、SnapshotStore.sweep 同一个 RETENTION_MS 截止线）。
   */
  async sweep(now: number): Promise<void> {
    const cutoff = now - RETENTION_MS
    for (const [key, e] of await this.table.list()) {
      if (isUndoable(e) && e.settled!.at < cutoff) await this.table.delete(key)
    }
  }

  /** 撤销裁决：去掉 settled，条目回到待处理（沿用原 id 与 firstSeenAt）。条目不存在或未裁决返回 false。 */
  async unsettle(id: string): Promise<boolean> {
    const entry = await this.table.get(id)
    if (!entry?.settled) return false
    const { settled: _settled, ...open } = entry
    await this.table.put(id, open)
    return true
  }

  /** 全部超限条目（含已忽略的）：已忽略只是不再提醒，超限的事实仍在，健康把它列为问题。 */
  async listOverflow(): Promise<PendingDecision[]> {
    return (await this.table.list()).map(([, e]) => e).filter(e => kindOf(e) === 'overflow')
  }

  /**
   * 快照冻结时同步一个项目的超限提醒（scope：workspace 路径，无项目为 'global'）。每个项目同时只留一条，指纹 = 当前档位：
   * 同档不动（已忽略的保持忽略，不重报）；进入更高档换一条新的未决条目；回落到没超限删掉，下次超限重新提醒；
   * 从高档降到低档时高档条目删掉、换成低档条目，高档已忽略的低档也算忽略（回落不打扰），再升回高档重新提醒。
   * 换模式（relax ↔ strict）旧条目作废。返回账本是否有变化。
   */
  async syncOverflow(scope: string, level: OverflowLevel | undefined, now: number, summary: string): Promise<boolean> {
    const mine = (await this.table.list()).filter(([, e]) => kindOf(e) === 'overflow' && overflowScopeOf(e) === scope)
    const fingerprint = level === undefined ? undefined : overflowFingerprint(level)
    const current = mine.find(([, e]) => e.fingerprint === fingerprint)
    const stale = mine.filter(entry => entry !== current)
    for (const [key] of stale) await this.table.delete(key)
    if (level === undefined || current !== undefined) return stale.length > 0
    const dismissedAbove = stale.some(([, e]) => e.settled !== undefined && overflowLevelOf(e).mode === level.mode && overflowLevelOf(e).tier > level.tier)
    const entry: PendingDecision = {
      id: genId('pd'), kind: 'overflow', memoryIds: [], summary, firstSeenAt: now, workspaces: [scope], fingerprint: fingerprint!,
      ...(dismissedAbove ? { settled: { verdict: 'dismiss' as const, at: now } } : {}),
    }
    await this.table.put(entry.id, entry)
    return true
  }

  /**
   * 扫描时同步一个项目的提升候选（scope：workspace 路径）。candidates：该项目 active 且带 globalCandidate 的记忆；
   * liveIds：该项目全部 active 记忆。每条候选一条 promote-candidate 条目，指纹 = 记忆内容指纹（candidateFingerprint）：
   * 「留在本项目」过的指纹不变不再提示，内容改了旧结论作废、重新提示；已提升（promoted）的又成了本项目候选
   * （被快照恢复回来）回到待处理。未决条目的记忆不再是候选（已提升、标记被清、记忆没了）就移除；
   * 「留在本项目」的条目在记忆不再 active 时移除；promoted 留给撤销，由 sweep 按保留窗口清。
   */
  async syncPromoteCandidates(
    scope: string,
    candidates: ReadonlyArray<{ id: string; summary: string; fingerprint: string }>,
    liveIds: ReadonlySet<string>,
    now: number,
  ): Promise<void> {
    const candidateIds = new Set(candidates.map(c => c.id))
    for (const [key, e] of await this.table.list()) {
      if (kindOf(e) !== 'promote-candidate' || e.workspaces?.[0] !== scope) continue
      const id = e.memoryIds[0]!
      if (e.settled?.verdict === 'promoted') {
        if (candidateIds.has(id)) await this.unsettle(key)
      } else if (e.settled === undefined ? !candidateIds.has(id) : !liveIds.has(id)) {
        await this.table.delete(key)
      }
    }
    for (const c of candidates) {
      await this.upsert({ kind: 'promote-candidate', memoryIds: [c.id], summary: c.summary, workspaces: [scope], fingerprint: c.fingerprint }, now)
    }
  }

  async remove(id: string): Promise<boolean> {
    return this.table.delete(id)
  }

  /** 悬空引用清理：任一被删记忆出现在条目里，整条移除（含已裁决条目，keepId 那条除外）。返回移除的未决条目数。 */
  async removeByMemoryIds(memoryIds: string[], keepId?: string): Promise<number> {
    const hit = (await this.table.list()).filter(([key, e]) => key !== keepId && e.memoryIds.some(id => memoryIds.includes(id)))
    for (const [key] of hit) await this.table.delete(key)
    return hit.filter(([, e]) => !e.settled).length
  }
}
