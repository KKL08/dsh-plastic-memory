import type { MemoryRecord } from './record-schema.ts'
import { RecordNotFoundError } from './errors.ts'
import { expandQueryTerms, matchScore } from './text.ts'
import type { MemoryLogger, MemoryTable } from './storage/table.ts'

export type { MemoryLogger, MemoryTable } from './storage/table.ts'

export class InMemoryTable implements MemoryTable {
  private map = new Map<string, MemoryRecord>()
  async get(key: string) { return this.map.get(key) }
  async list() { return [...this.map.values()] }
  async put(key: string, value: MemoryRecord) {
    // 与 FileTable 同语义：put 不承载召回统计，唯一写入方是 markRecalled 走的 update 路径
    const prev = this.map.get(key)
    this.map.set(key, prev ? { ...value, recallCount: prev.recallCount, lastRecalledAt: prev.lastRecalledAt } : value)
  }
  async update(key: string, fn: (c: MemoryRecord) => MemoryRecord) {
    const current = this.map.get(key)
    if (!current) throw new RecordNotFoundError(key)
    const next = fn(current)
    this.map.set(key, next)
    return next
  }
  async delete(key: string) { return this.map.delete(key) }
}

export interface QueryFilter {
  scope?: { kind: 'global' } | { kind: 'workspace'; path: string } | { kind: 'visible'; workspacePath: string | undefined }
  types?: string[]
  tags?: string[]
  status?: MemoryRecord['status'][]
  keyword?: string
}

export class MemoryStore {
  private table: MemoryTable
  private log?: MemoryLogger

  constructor(table: MemoryTable, log?: MemoryLogger) {
    this.table = table
    this.log = log
  }

  get(id: string) { return this.table.get(id) }
  put(record: MemoryRecord) { return this.table.put(record.id, record) }

  async softDelete(id: string): Promise<boolean> {
    if (!(await this.table.get(id))) return false
    await this.table.update(id, r => ({ ...r, status: 'deleted', updatedAt: Date.now() }))
    return true
  }

  async query(filter: QueryFilter): Promise<MemoryRecord[]> {
    const statuses = filter.status ?? ['active']
    const keyword = filter.keyword?.toLowerCase()
    // 排序 OR：命中任一匹配项即入选（硬 AND 会让"多一个不相关词"整组落空）。中文经 bigram 切分
    // 也参与匹配。命中数排序与 limit 由调用方（executeSearch）用同一 matchScore 收敛。
    const terms = keyword ? expandQueryTerms(keyword) : []
    const out: MemoryRecord[] = []
    for (const r of await this.table.list()) {
      if (!statuses.includes(r.status)) continue
      if (filter.types && !filter.types.includes(r.type)) continue
      if (filter.tags && !filter.tags.some(t => r.tags.includes(t))) continue
      if (filter.scope) {
        const s = filter.scope
        if (s.kind === 'global' && r.scope !== 'global') continue
        if (s.kind === 'workspace' && (r.scope !== 'workspace' || r.workspacePath !== s.path)) continue
        if (s.kind === 'visible' && !(r.scope === 'global' || (s.workspacePath !== undefined && r.workspacePath === s.workspacePath))) continue
      }
      if (terms.length > 0 && matchScore(r, terms) === 0) continue
      out.push(r)
    }
    return out
  }

  async markRecalled(ids: string[]): Promise<void> {
    const now = Date.now()
    for (const id of ids) {
      if (!(await this.table.get(id))) continue
      await this.table
        .update(id, r => ({ ...r, lastRecalledAt: now, recallCount: r.recallCount + 1 }))
        .catch((err: unknown) => {
          ;(this.log ?? console).error('[plastic-memory] 召回统计更新失败:', err)
        })
    }
  }
}
