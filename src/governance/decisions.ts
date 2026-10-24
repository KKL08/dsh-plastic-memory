import { createHash } from 'node:crypto'
import type { KvTable } from '../kv-table.ts'
import type { MemoryRecord } from '../record-schema.ts'
import { RETENTION_MS } from '../retention.ts'
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

type KindKeyed = { kind?: PendingKind; memoryIds: string[]; baselineRef?: string }

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
   * 快照也已过期，撤销无从谈起，条目一起清掉（与 storage 维护点、SnapshotStore.sweep 同一个 RETENTION_MS 截止线）。
   */
  async sweep(now: number): Promise<void> {
    const cutoff = now - RETENTION_MS
    for (const [key, e] of await this.table.list()) {
      if (isDeletionSettled(e) && e.settled!.at < cutoff) await this.table.delete(key)
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
