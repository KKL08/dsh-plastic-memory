/** 最小 KV 接口，供存储侧车表与治理各表共用。与 storage/table.ts 的 MemoryTable 同构，但泛型化以承载不同记录类型。
 *  读写全部异步；`list()` 返回 [key, value] 快照（PR1 先改签名，侧表文件实现另票）。 */
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

/** 宿主 storageDomain 表的形状（@deepseek-ai/dsh-storage-domain KvTable）：读同步取内存，写排队落盘。
 *  只声明本插件用到的四个成员，结构兼容即可，不 import 框架类型。 */
export interface SyncKvTable<T> {
  get(key: string): T | undefined
  entries(): IterableIterator<[string, T]>
  put(key: string, value: T): Promise<void>
  delete(key: string): Promise<boolean>
}

/** 把宿主的同步读表包成异步 KvTable：get/list 包 Promise，put/delete 透传。 */
export function wrapSyncKvTable<T>(table: SyncKvTable<T>): KvTable<T> {
  return {
    async get(key) { return table.get(key) },
    async list() { return [...table.entries()] },
    put(key, value) { return table.put(key, value) },
    delete(key) { return table.delete(key) },
  }
}
