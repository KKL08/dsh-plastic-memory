import type { MemoryRecord } from './record-schema.ts'
import { RecordNotFoundError } from './errors.ts'
import { expandQueryTerms, matchScore } from './text.ts'
import type { MemoryLogger, MemoryTable } from './storage/table.ts'
import { InMemoryBatchKvTable, type BatchKvTable } from './kv-table.ts'
import type { RecallStats } from './storage/schema.ts'

export type { MemoryLogger, MemoryTable } from './storage/table.ts'

export class InMemoryTable implements MemoryTable {
  private map = new Map<string, MemoryRecord>()
  async get(key: string) { return this.map.get(key) }
  async list() { return [...this.map.values()] }
  async put(key: string, value: MemoryRecord) {
    // 与 FileTable 同语义：put 不承载召回统计（召回统计住侧表，由 MemoryStore.markRecalled 写）
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
  private stats: BatchKvTable<RecallStats>
  private recallChain: Promise<unknown> = Promise.resolve() // markRecalled 的读改写在进程内串行

  /** stats：召回统计侧表（接线层传 .state/recall-stats.json）；缺省内存表，供不关心召回统计的测试。 */
  constructor(table: MemoryTable, log?: MemoryLogger, stats: BatchKvTable<RecallStats> = new InMemoryBatchKvTable<RecallStats>()) {
    this.table = table
    this.log = log
    this.stats = stats
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

  /** 召回统计只读改写侧表，不经 table.update——记忆文件不因召回而重写。一次调用一次读、内存合并、
   *  一次批量写（单文件表只换一次文件）。跨进程单文件 LWW（参考字段）。 */
  markRecalled(ids: string[]): Promise<void> {
    const run = () => this.markRecalledInner(ids)
    const next = this.recallChain.then(run, run)
    this.recallChain = next.catch(() => {})
    return next
  }

  private async markRecalledInner(ids: string[]): Promise<void> {
    const now = Date.now()
    try {
      const current = new Map(await this.stats.list())
      const next = new Map<string, RecallStats>()
      for (const id of ids) {
        if (!(await this.table.get(id))) continue
        // 同一次调用里重复出现的 id 累加（与逐条 put 时的旧行为一致）
        const row = next.get(id) ?? current.get(id)
        next.set(id, { id, recallCount: (row?.recallCount ?? 0) + 1, lastRecalledAt: now })
      }
      await this.stats.putMany([...next])
    } catch (err) {
      ;(this.log ?? console).error('[plastic-memory] 召回统计更新失败:', err)
    }
  }
}
