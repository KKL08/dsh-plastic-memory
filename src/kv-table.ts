/** 最小 KV 接口，供存储侧车表与治理各表共用。与 storage/table.ts 的 MemoryTable 同构，但泛型化以承载不同记录类型。
 *  读写全部异步；`list()` 返回 [key, value] 快照。文件实现见 storage/sidecar.ts（`.state/`）。 */
export interface KvTable<T> {
  get(key: string): Promise<T | undefined>
  list(): Promise<Array<[string, T]>>
  put(key: string, value: T): Promise<void>
  delete(key: string): Promise<boolean>
}

export class InMemoryKvTable<T> implements KvTable<T> {
  private map = new Map<string, T>()
  async get(key: string) { return this.map.get(key) }
  async list() { return [...this.map.entries()] }
  async put(key: string, value: T) { this.map.set(key, value) }
  async delete(key: string) { return this.map.delete(key) }
}

/** 带批量写的 KV：只给召回统计用（单文件表，一次 markRecalled 只该换一次文件）。KvTable 本身不加批量。 */
export interface BatchKvTable<T> extends KvTable<T> {
  /** 一次写入多条，与已有条目合并（同键覆盖）。 */
  putMany(entries: ReadonlyArray<[string, T]>): Promise<void>
}

export class InMemoryBatchKvTable<T> extends InMemoryKvTable<T> implements BatchKvTable<T> {
  async putMany(entries: ReadonlyArray<[string, T]>) { for (const [key, value] of entries) await super.put(key, value) }
}
