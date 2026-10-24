import { createHash } from 'node:crypto'
import type { KvTable } from '../kv-table.ts'
import type { MemoryRecord } from '../record-schema.ts'
import { genId, type PendingDecision } from './schema.ts'

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

/** 两个条目是否指同一对记忆、同一类冲突（横向 / 垂直），不看 baselineRef 措辞。 */
function samePair(a: { memoryIds: string[]; baselineRef?: string }, b: { memoryIds: string[]; baselineRef?: string }): boolean {
  return dedupKey(a.memoryIds) === dedupKey(b.memoryIds) && (a.baselineRef !== undefined) === (b.baselineRef !== undefined)
}

/**
 * pending-decisions 待决账本（docs/p1-governance-health-design.md §4）。只放 conflict。
 * 删掉一方的裁决直接删条目（审计走 dsh trace）；两边都留的裁决标 settled 留在账本里，
 * 指纹不变时扫描不再挂账，指纹变了（任一方改写、基线变了）旧结论作废、按新冲突重报。
 * settled 条目对 get / list 不可见，只有 upsert 和 removeByMemoryIds 会看到它。
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

  /** settled：命中已裁决条目且指纹没变，没有挂账，entry 是那条已裁决条目。 */
  async upsert(
    input: { memoryIds: string[]; baselineRef?: string; summary: string; workspaces?: string[]; fingerprint?: string },
    now: number,
  ): Promise<{ created: boolean; settled?: true; entry: PendingDecision }> {
    const entries = await this.table.list()
    for (const [key, existing] of entries) {
      if (!existing.settled || !samePair(existing, input)) continue
      if (input.fingerprint !== undefined && existing.fingerprint === input.fingerprint) return { created: false, settled: true, entry: existing }
      await this.table.delete(key) // 指纹变了：旧结论作废
    }
    const key = dedupKey(input.memoryIds, input.baselineRef)
    for (const [, existing] of entries) {
      if (existing.settled) continue
      if (dedupKey(existing.memoryIds, existing.baselineRef) === key) {
        // workspaces 与 memoryIds 一一对应：去重键不看顺序，按已有条目的 id 顺序重排
        const wsById = new Map(input.memoryIds.map((id, i) => [id, input.workspaces?.[i]]))
        const workspaces = input.workspaces !== undefined ? existing.memoryIds.map(id => wsById.get(id) ?? '(未知)') : undefined
        const updated: PendingDecision = {
          ...existing, summary: input.summary,
          ...(workspaces !== undefined ? { workspaces } : {}),
          ...(input.fingerprint !== undefined ? { fingerprint: input.fingerprint } : {}),
        }
        await this.table.put(updated.id, updated)
        return { created: false, entry: updated }
      }
    }
    const entry: PendingDecision = {
      id: genId('pd'),
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

  /** 记下两边都留的裁决。没有指纹的旧条目无从判断以后变没变，退回直接移除，返回 false。 */
  async settle(id: string, verdict: NonNullable<PendingDecision['settled']>['verdict'], now: number): Promise<boolean> {
    const entry = await this.table.get(id)
    if (!entry) return false
    if (entry.fingerprint === undefined) {
      await this.table.delete(id)
      return false
    }
    await this.table.put(id, { ...entry, settled: { verdict, at: now } })
    return true
  }

  async remove(id: string): Promise<boolean> {
    return this.table.delete(id)
  }

  /** 悬空引用清理：任一被删记忆出现在条目里，整条移除（含已裁决条目）。返回移除的未决条目数。 */
  async removeByMemoryIds(memoryIds: string[]): Promise<number> {
    const hit = (await this.table.list()).filter(([, e]) => e.memoryIds.some(id => memoryIds.includes(id)))
    for (const [key] of hit) await this.table.delete(key)
    return hit.filter(([, e]) => !e.settled).length
  }
}
