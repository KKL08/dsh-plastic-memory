import type { MemoryRecord } from './record-schema.ts'

export interface MemoryTable {
  get(key: string): MemoryRecord | undefined
  put(key: string, value: MemoryRecord): Promise<void>
  update(key: string, fn: (current: MemoryRecord) => MemoryRecord): Promise<MemoryRecord>
  delete(key: string): Promise<boolean>
  entries(): IterableIterator<[string, MemoryRecord]>
}

export class InMemoryTable implements MemoryTable {
  private map = new Map<string, MemoryRecord>()
  get(key: string) { return this.map.get(key) }
  async put(key: string, value: MemoryRecord) {
    // 与 FileTable 同语义：put 不承载召回统计，唯一写入方是 markRecalled 走的 update 路径
    const prev = this.map.get(key)
    this.map.set(key, prev ? { ...value, recallCount: prev.recallCount, lastRecalledAt: prev.lastRecalledAt } : value)
  }
  async update(key: string, fn: (c: MemoryRecord) => MemoryRecord) {
    const current = this.map.get(key)
    if (!current) throw new Error(`记录不存在：${key}`)
    const next = fn(current)
    this.map.set(key, next)
    return next
  }
  async delete(key: string) { return this.map.delete(key) }
  entries() { return this.map.entries() }
}

export interface QueryFilter {
  scope?: { kind: 'global' } | { kind: 'workspace'; path: string } | { kind: 'visible'; workspacePath: string | undefined }
  types?: string[]
  tags?: string[]
  status?: MemoryRecord['status'][]
  keyword?: string
}

export class MemoryStore {
  constructor(private table: MemoryTable) {}

  get(id: string) { return this.table.get(id) }
  put(record: MemoryRecord) { return this.table.put(record.id, record) }

  async softDelete(id: string): Promise<boolean> {
    if (!this.table.get(id)) return false
    await this.table.update(id, r => ({ ...r, status: 'deleted', updatedAt: Date.now() }))
    return true
  }

  query(filter: QueryFilter): MemoryRecord[] {
    const statuses = filter.status ?? ['active', 'stale']
    const keyword = filter.keyword?.toLowerCase()
    const out: MemoryRecord[] = []
    for (const [, r] of this.table.entries()) {
      if (!statuses.includes(r.status)) continue
      if (filter.types && !filter.types.includes(r.type)) continue
      if (filter.tags && !filter.tags.some(t => r.tags.includes(t))) continue
      if (filter.scope) {
        const s = filter.scope
        if (s.kind === 'global' && r.scope !== 'global') continue
        if (s.kind === 'workspace' && (r.scope !== 'workspace' || r.workspacePath !== s.path)) continue
        if (s.kind === 'visible' && !(r.scope === 'global' || (s.workspacePath !== undefined && r.workspacePath === s.workspacePath))) continue
      }
      if (keyword) {
        // 多词 AND：模型最自然的写法是给多个词。id/name 纳入 haystack——索引展示的两样必须可搜。
        // 连写中文切不出多词，单词项行为等同原子串匹配（中文检索改善靠 tags 与 grep 通道）。
        const haystack = `${r.id}\n${r.name}\n${r.content}\n${r.summary}\n${r.tags.join(' ')}`.toLowerCase()
        const terms = keyword.split(/\s+/).filter(Boolean)
        if (!terms.every(t => haystack.includes(t))) continue
      }
      out.push(r)
    }
    return out
  }

  markRecalled(ids: string[]): void {
    const now = Date.now()
    for (const id of ids) {
      if (!this.table.get(id)) continue
      void this.table
        .update(id, r => ({ ...r, lastRecalledAt: now, recallCount: r.recallCount + 1 }))
        .catch((err: unknown) => {
          console.error('[plastic-memory] 召回统计更新失败:', err)
        })
    }
  }
}
