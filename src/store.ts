import type { MemoryRecord } from './record-schema.ts'
import { expandQueryTerms, matchScore } from './text.ts'

/** 纯逻辑层的日志注入口：接线层（index.ts）传入 ctx.logger，缺省回退 console，
 *  保证测试与独立使用场景仍有输出。file-table.ts / forget.ts 复用此形状，保持三层注入风格一致。 */
export interface MemoryLogger {
  info(message: string, detail?: unknown): void
  warn(message: string, detail?: unknown): void
  error(message: string, detail?: unknown): void
}

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
  private table: MemoryTable
  private log?: MemoryLogger

  constructor(table: MemoryTable, log?: MemoryLogger) {
    this.table = table
    this.log = log
  }

  get(id: string) { return this.table.get(id) }
  put(record: MemoryRecord) { return this.table.put(record.id, record) }

  async softDelete(id: string): Promise<boolean> {
    if (!this.table.get(id)) return false
    await this.table.update(id, r => ({ ...r, status: 'deleted', updatedAt: Date.now() }))
    return true
  }

  query(filter: QueryFilter): MemoryRecord[] {
    const statuses = filter.status ?? ['active']
    const keyword = filter.keyword?.toLowerCase()
    // 排序 OR：命中任一匹配项即入选（硬 AND 会让"多一个不相关词"整组落空）。中文经 bigram 切分
    // 也参与匹配。命中数排序与 limit 由调用方（executeSearch）用同一 matchScore 收敛。
    const terms = keyword ? expandQueryTerms(keyword) : []
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
      if (terms.length > 0 && matchScore(r, terms) === 0) continue
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
          ;(this.log ?? console).error('[plastic-memory] 召回统计更新失败:', err)
        })
    }
  }
}
