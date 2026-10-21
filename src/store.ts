import { dirname, join, relative } from 'node:path'
import type { MemoryRecord } from './record-schema.ts'
import { RecordNotFoundError } from './errors.ts'
import { expandQueryTerms, matchScore } from './text.ts'
import {
  resolveDuplicates,
  type MemoryLogger, type MemoryTable, type LocatedFile, type LocateHint, type ScopeReadOptions, type ScopeReadResult,
  type WorkspaceDirListing, type DirectoryNote,
} from './storage/table.ts'
import { ARCHIVE_DIR, GLOBAL_DIR, deriveFileId, isReservedFileName, slugifyName, workspaceDirName } from './storage/paths.ts'
import { InMemoryBatchKvTable, type BatchKvTable } from './kv-table.ts'
import type { RecallStats } from './storage/schema.ts'

export type { MemoryLogger, MemoryTable } from './storage/table.ts'

/** 双后端套件往虚拟目录放文件用的记录：缺 id 时按相对路径派生（对应 FileTable 读手建文件）。 */
export type SeedRecord = Omit<MemoryRecord, 'id'> & { id?: string }

/**
 * MemoryTable 的内存参考实现：一棵虚拟文件树（filePath → 槽位），目录名与 FileTable 同源（storage/paths），
 * 所以 readScope 的 `dirs` 用同样的绝对路径表达。同 id 可以多槽位（seedFile 放的），取舍规则与 FileTable 共用。
 * 预筛是超集，内存实现不预筛。
 */
export class InMemoryTable implements MemoryTable {
  private readonly root: string
  private readonly globalDir: string
  private slots = new Map<string, LocatedFile>()   // filePath → 槽位

  constructor(root = '/in-memory') {
    this.root = root
    this.globalDir = join(root, GLOBAL_DIR)
  }

  private dirOf(record: MemoryRecord): string {
    return record.scope === 'global' ? this.globalDir : join(this.root, workspaceDirName(record.workspacePath!))
  }

  /** 与 FileTable.filePathFor 同规则：基础名 → id 片段名 → 全 id 名，被别的 id 占着就换下一个。 */
  private pathFor(record: MemoryRecord, dir: string): string {
    const base = slugifyName(record.name)
    for (const name of [`${base}.md`, `${base}-${record.id.slice(-6)}.md`]) {
      if (isReservedFileName(name)) continue
      const path = join(dir, name)
      const taken = this.slots.get(path)
      if (taken === undefined || taken.record.id === record.id) return path
    }
    return join(dir, `${base}-${record.id}.md`)
  }

  /** 供双后端套件直接往虚拟目录放一个文件（对应 FileTable 的手写 / 外部落盘文件）。archived 放进 .archive/。 */
  seedFile(opts: { dir: string; fileName: string; record: SeedRecord; archived?: boolean; extras?: Record<string, unknown> }): LocatedFile {
    const filePath = join(opts.archived ? join(opts.dir, ARCHIVE_DIR) : opts.dir, opts.fileName)
    const id = opts.record.id ?? deriveFileId(relative(this.root, filePath))
    const slot: LocatedFile = { record: { ...opts.record, id }, extras: opts.extras ?? {}, filePath, dir: opts.dir }
    this.slots.set(filePath, slot)
    return slot
  }

  async readScope(dirs: string[], opts: ScopeReadOptions = {}): Promise<ScopeReadResult> {
    const want = new Set(dirs)
    const records = [...this.slots.values()]
      .filter(s => want.has(s.dir))
      .filter(s => opts.includeArchive || dirname(s.filePath) === s.dir)
      .filter(s => opts.types === undefined || opts.types.includes(s.record.type))
      .map(({ record, filePath, dir }) => ({ record, filePath, dir }))
    return { records, quarantined: [], directoryNotes: [] }
  }

  async locate(id: string, hint?: LocateHint): Promise<LocatedFile | undefined> {
    const all = [...this.slots.values()].filter(s => s.record.id === id)
    const firstLevel = all.filter(s => s.dir === this.globalDir
      || (hint?.workspacePath !== undefined && s.record.scope === 'workspace' && s.record.workspacePath === hint.workspacePath))
    return resolveDuplicates(firstLevel.length > 0 ? firstLevel : all, hint)[0]
  }

  async listWorkspaceDirs(): Promise<WorkspaceDirListing> {
    const byDir = new Map<string, { workspacePath: string; hasActiveTopLevel: boolean }>()
    for (const s of this.slots.values()) {
      if (s.dir === this.globalDir) continue
      const entry = byDir.get(s.dir) ?? { workspacePath: s.record.workspacePath!, hasActiveTopLevel: false }
      if (dirname(s.filePath) === s.dir) entry.hasActiveTopLevel = true
      byDir.set(s.dir, entry)
    }
    const directoryNotes: DirectoryNote[] = []
    const entries = [...byDir].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([dir, e]) => {
      if (!e.hasActiveTopLevel) directoryNotes.push({ level: 'info', code: 'dir-empty', path: dir, text: `workspace 目录顶层没有记忆文件（只剩归档或全空），不进体检清单：${dir}` })
      return { dir, ...e }
    })
    return { entries, directoryNotes }
  }

  async readAll() {
    return { records: resolveDuplicates([...this.slots.values()]).map(s => s.record), quarantined: [], directoryNotes: [] }
  }

  async get(key: string) { return (await this.locate(key))?.record }
  async list() { return (await this.readAll()).records }

  /** 落槽位：位置没变且 slug 没变就留在原路径，否则按 scope 目录重新取名（与 FileTable.persist 同规则）。 */
  private place(prev: LocatedFile | undefined, next: MemoryRecord): void {
    if (prev) this.slots.delete(prev.filePath)
    const sameLocation = prev !== undefined && prev.record.scope === next.scope && prev.record.workspacePath === next.workspacePath
    const dir = sameLocation ? prev.dir : this.dirOf(next)
    const renamed = prev !== undefined && slugifyName(next.name).toLowerCase() !== slugifyName(prev.record.name).toLowerCase()
    const filePath = prev !== undefined && sameLocation && !renamed ? prev.filePath : this.pathFor(next, dir)
    this.slots.set(filePath, { record: next, extras: prev?.extras ?? {}, filePath, dir })
  }

  async put(key: string, value: MemoryRecord) {
    // 与 FileTable 同语义：put 不承载召回统计（召回统计住侧表，由 MemoryStore.markRecalled 写）
    const prev = await this.locate(key, { workspacePath: value.workspacePath })
    this.place(prev, prev ? { ...value, recallCount: prev.record.recallCount, lastRecalledAt: prev.record.lastRecalledAt } : value)
  }
  async update(key: string, fn: (c: MemoryRecord) => MemoryRecord) {
    const current = await this.locate(key)
    if (!current) throw new RecordNotFoundError(key)
    const next = fn(current.record)
    this.place(current, next)
    return next
  }
  async delete(key: string) {
    const current = await this.locate(key)
    if (!current) return false
    this.slots.delete(current.filePath)
    return true
  }
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
  /** 过渡：全部目录一次读出（记录含全部状态、隔离条目、目录级说明），票 09 换成按范围读取。 */
  readAll() { return this.table.readAll() }

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
