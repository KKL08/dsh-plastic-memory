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

/** 把查询串展开成匹配项：空白分词后，每个词内的 CJK 段切 2 字滑窗 bigram（单字 CJK 段保留），
 * 非 CJK 段整体保留。无分词器时对 CJK 语料的标准做法——让"部署流程配置"这类非连续短语也能命中。 */
export function expandQueryTerms(keyword: string): string[] {
  const out = new Set<string>()
  for (const term of keyword.toLowerCase().split(/\s+/).filter(Boolean)) {
    for (const seg of term.match(/[一-鿿]+|[^一-鿿]+/g) ?? []) {
      if (/[一-鿿]/.test(seg)) {
        const chars = [...seg]
        if (chars.length >= 2) for (let i = 0; i < chars.length - 1; i++) out.add(chars[i] + chars[i + 1])
        else out.add(seg)
      } else if (seg) out.add(seg)
    }
  }
  return [...out]
}

/** 记录对一组匹配项的命中数（各项子串命中计 1）。haystack 覆盖 id/name/content/summary/tags。 */
export function matchScore(record: MemoryRecord, terms: string[]): number {
  const haystack = `${record.id}\n${record.name}\n${record.content}\n${record.summary}\n${record.tags.join(' ')}`.toLowerCase()
  let n = 0
  for (const t of terms) if (haystack.includes(t)) n++
  return n
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
          console.error('[plastic-memory] 召回统计更新失败:', err)
        })
    }
  }
}
