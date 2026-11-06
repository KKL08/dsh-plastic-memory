import type { BatchKvTable, CasKvTable, ClaimKvTable, RefreshableClaimKvTable } from '../../src/kv-table.ts'

/** 内存 KV：侧表与治理各表的测试替身，不进发布包。认领只在本进程内排他。 */
export class InMemoryKvTable<T> implements ClaimKvTable<T>, CasKvTable<T>, RefreshableClaimKvTable<T> {
  private map = new Map<string, T>()
  private claimed = new Map<string, symbol>()
  async get(key: string) { return this.map.get(key) }
  async list() { return [...this.map.entries()] }
  async put(key: string, value: T) { this.map.set(key, value) }
  async delete(key: string) { return this.map.delete(key) }
  async deleteIf(key: string, isStill: (current: T) => boolean) {
    const cur = this.map.get(key)
    return cur !== undefined && isStill(cur) && this.map.delete(key)
  }
  async update(key: string, fn: (current: T | undefined) => T | undefined) {
    const next = fn(this.map.get(key))
    if (next === undefined) return false
    this.map.set(key, next)
    return true
  }
  async claim(key: string) {
    return (await this.claimRefreshable(key))?.release
  }
  async claimRefreshable(key: string) {
    if (this.claimed.has(key)) return undefined
    const token = Symbol(key)
    this.claimed.set(key, token)
    return {
      refresh: async () => this.claimed.get(key) === token,
      release: async () => { if (this.claimed.get(key) === token) this.claimed.delete(key) },
    }
  }
  async isClaimed(key: string) { return this.claimed.has(key) }
}

export class InMemoryBatchKvTable<T> extends InMemoryKvTable<T> implements BatchKvTable<T> {
  async putMany(entries: ReadonlyArray<[string, T]>) { for (const [key, value] of entries) await super.put(key, value) }
}
