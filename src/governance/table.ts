/** 治理表的最小 KV 接口。与 store.ts 的 MemoryTable 同构，但泛型化以承载不同记录类型。 */
export interface KvTable<T> {
  get(key: string): T | undefined
  put(key: string, value: T): Promise<void>
  delete(key: string): Promise<boolean>
  entries(): IterableIterator<[string, T]>
}

export class InMemoryKvTable<T> implements KvTable<T> {
  private map = new Map<string, T>()
  get(key: string) { return this.map.get(key) }
  async put(key: string, value: T) { this.map.set(key, value) }
  async delete(key: string) { return this.map.delete(key) }
  entries() { return this.map.entries() }
}
