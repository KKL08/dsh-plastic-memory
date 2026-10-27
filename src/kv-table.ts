/** 最小 KV 接口，供存储侧车表与治理各表共用。与 storage/table.ts 的 MemoryTable 同构，但泛型化以承载不同记录类型。
 *  读写全部异步；`list()` 返回 [key, value] 快照。文件实现见 storage/sidecar.ts（`.state/`）。 */
export interface KvTable<T> {
  get(key: string): Promise<T | undefined>
  list(): Promise<Array<[string, T]>>
  put(key: string, value: T): Promise<void>
  delete(key: string): Promise<boolean>
}

/** 带排他认领的 KV：待决账本用，同一条目同时只许一次裁决改它。文件实现跨进程有效（见 storage/sidecar.ts）。 */
export interface ClaimKvTable<T> extends KvTable<T> {
  /** 认领 key：拿到返回释放函数；已被别人持有返回 undefined，不等待。认领与条目是否存在无关。 */
  claim(key: string): Promise<(() => Promise<void>) | undefined>
}

/** 带条件写删的 KV：建议忽略表的清理、扫描缓存与体检记录的「不回退」写入用。在表的写锁内重读，按当前值决定写不写、删不删——
 *  判定之后本进程别处刚写入的新值不会被盖掉或删掉。 */
export interface CasKvTable<T> extends KvTable<T> {
  /** 删掉 key，前提是此刻它还在、且 isStill(当前值) 为真；删了返回 true。 */
  deleteIf(key: string, isStill: (current: T) => boolean): Promise<boolean>
  /** 读改写：对此刻的值（没有为 undefined）求 fn，返回值写回（其 id 须等于 key）；fn 返回 undefined 就不写。写了返回 true。 */
  update(key: string, fn: (current: T | undefined) => T | undefined): Promise<boolean>
}

export class InMemoryKvTable<T> implements ClaimKvTable<T>, CasKvTable<T> {
  private map = new Map<string, T>()
  private claimed = new Set<string>()
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
    if (this.claimed.has(key)) return undefined
    this.claimed.add(key)
    return async () => { this.claimed.delete(key) }
  }
}

/** 带批量写的 KV：只给召回统计用（单文件表，一次 markRecalled 只该换一次文件）。KvTable 本身不加批量。 */
export interface BatchKvTable<T> extends KvTable<T> {
  /** 一次写入多条，与已有条目合并（同键覆盖）。 */
  putMany(entries: ReadonlyArray<[string, T]>): Promise<void>
}

export class InMemoryBatchKvTable<T> extends InMemoryKvTable<T> implements BatchKvTable<T> {
  async putMany(entries: ReadonlyArray<[string, T]>) { for (const [key, value] of entries) await super.put(key, value) }
}
