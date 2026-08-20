import type { KvTable } from './table.ts'
import { genId, type PendingDecision } from './schema.ts'

/** 去重 key：memoryIds 排序拼接 + baselineRef（垂直冲突与横向冲突互不干扰）。 */
export function dedupKey(memoryIds: string[], baselineRef?: string): string {
  return [...memoryIds].sort().join('|') + (baselineRef ? `#${baselineRef}` : '')
}

/**
 * pending-decisions 待决账本（设计稿 §4）。只放 conflict；resolved 直接删（审计走 dsh trace）。
 */
export class PendingDecisionsStore {
  constructor(private table: KvTable<PendingDecision>) {}

  list(): PendingDecision[] {
    return [...this.table.entries()].map(([, e]) => e).sort((a, b) => a.firstSeenAt - b.firstSeenAt)
  }

  get(id: string): PendingDecision | undefined {
    return this.table.get(id)
  }

  async upsert(
    input: { memoryIds: string[]; baselineRef?: string; summary: string },
    now: number,
  ): Promise<{ created: boolean; entry: PendingDecision }> {
    const key = dedupKey(input.memoryIds, input.baselineRef)
    for (const [, existing] of this.table.entries()) {
      if (dedupKey(existing.memoryIds, existing.baselineRef) === key) {
        const updated: PendingDecision = { ...existing, summary: input.summary }
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
    }
    await this.table.put(entry.id, entry)
    return { created: true, entry }
  }

  async remove(id: string): Promise<boolean> {
    return this.table.delete(id)
  }

  /** 悬空引用清理：任一被删记忆出现在条目里，整条移除。 */
  async removeByMemoryIds(memoryIds: string[]): Promise<number> {
    const hit = [...this.table.entries()]
      .filter(([, e]) => e.memoryIds.some(id => memoryIds.includes(id)))
      .map(([key]) => key)
    for (const key of hit) await this.table.delete(key)
    return hit.length
  }
}
