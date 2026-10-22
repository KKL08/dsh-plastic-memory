import { basename, dirname, join, relative } from 'node:path'
import type { MemoryRecord } from './record-schema.ts'
import { RecordNotFoundError } from './errors.ts'
import { expandQueryTerms, matchScore } from './text.ts'
import {
  resolveDuplicates,
  type MemoryLogger, type MemoryTable, type LocatedFile, type LocateHint, type ScopeReadOptions, type ScopeReadResult, type KeywordMatch,
  type WorkspaceDirListing, type DirectoryNote, type QuarantineEntry,
} from './storage/table.ts'
import { ARCHIVE_DIR, GLOBAL_DIR, deriveFileId, isReservedFileName, slugifyName, workspaceDirName } from './storage/paths.ts'
import { InMemoryBatchKvTable, type BatchKvTable } from './kv-table.ts'
import type { RecallStats } from './storage/schema.ts'
import { RETENTION_MS } from './retention.ts'

export type { MemoryLogger, MemoryTable, KeywordMatch } from './storage/table.ts'

/** 双后端套件往虚拟目录放文件用的记录：缺 id 时按相对路径派生（对应 FileTable 读手建文件）。 */
export type SeedRecord = Omit<MemoryRecord, 'id'> & { id?: string }

/**
 * MemoryTable 的内存参考实现：一棵虚拟文件树（filePath → 槽位），目录名与 FileTable 同源（storage/paths），
 * 所以 readScope 的 `dirs` 用同样的绝对路径表达。同 id 可以多槽位（seedFile 放的），取舍规则与 FileTable 共用。
 * 预筛是超集，内存实现不预筛。
 */
export class InMemoryTable implements MemoryTable {
  private readonly root: string
  readonly globalDir: string
  private slots = new Map<string, LocatedFile>()   // filePath → 槽位

  constructor(root = '/in-memory') {
    this.root = root
    this.globalDir = join(root, GLOBAL_DIR)
  }

  private dirOf(record: MemoryRecord): string {
    return record.scope === 'global' ? this.globalDir : join(this.root, workspaceDirName(record.workspacePath!))
  }

  /** 与 FileTable.claimAndWrite 同规则：基础名 → id 片段名 → 全 id 名，被别的 id 占着就换下一个（level 是顶层或 .archive/）。 */
  private pathFor(record: MemoryRecord, level: string, base = slugifyName(record.name)): string {
    for (const name of [`${base}.md`, `${base}-${record.id.slice(-6)}.md`]) {
      if (isReservedFileName(name)) continue
      const path = join(level, name)
      const taken = this.slots.get(path)
      if (taken === undefined || taken.record.id === record.id) return path
    }
    return join(level, `${base}-${record.id}.md`)
  }

  /** 供双后端套件直接往虚拟目录放一个文件（对应 FileTable 的手写 / 外部落盘文件）。archived 放进 .archive/。 */
  seedFile(opts: { dir: string; fileName: string; record: SeedRecord; archived?: boolean; extras?: Record<string, unknown> }): LocatedFile {
    const filePath = join(opts.archived ? join(opts.dir, ARCHIVE_DIR) : opts.dir, opts.fileName)
    const id = opts.record.id ?? deriveFileId(relative(this.root, filePath))
    const slot: LocatedFile = { record: { ...opts.record, id }, extras: opts.extras ?? {}, filePath, dir: opts.dir }
    this.slots.set(filePath, slot)
    return slot
  }

  async workspaceDirs(workspacePath: string): Promise<string[]> {
    return [join(this.root, workspaceDirName(workspacePath))]
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

  /** 落槽位（与 FileTable.persist 同规则）：status 离开 active 进 .archive/（deleted 缺 deletedAt 补 now）；目录、层、slug 都没变
   *  就留在原路径，否则在目标层重新取名；落下后清掉可见集合（global + 该记录的目录）里同 id 的其余副本。返回实际落下的记录。 */
  private place(prev: LocatedFile | undefined, value: MemoryRecord): MemoryRecord {
    const next = value.status === 'deleted' && value.deletedAt === undefined ? { ...value, deletedAt: Date.now() } : value
    if (prev) this.slots.delete(prev.filePath)
    const sameLocation = prev !== undefined && prev.record.scope === next.scope && prev.record.workspacePath === next.workspacePath
    const dir = sameLocation ? prev.dir : this.dirOf(next)
    const level = next.status === 'active' ? dir : join(dir, ARCHIVE_DIR)
    const renamed = prev !== undefined && slugifyName(next.name).toLowerCase() !== slugifyName(prev.record.name).toLowerCase()
    const inPlace = prev !== undefined && sameLocation && !renamed && dirname(prev.filePath) === level
    const filePath = inPlace ? prev.filePath : this.pathFor(next, level)
    for (const s of this.slots.values()) {
      if (s.record.id === next.id && s.filePath !== filePath && (s.dir === this.globalDir || s.dir === dir)) this.slots.delete(s.filePath)
    }
    this.slots.set(filePath, { record: next, extras: prev?.extras ?? {}, filePath, dir })
    return next
  }

  /** 维护点的内存对应：顶层非 active 搬 .archive/（deleted 补 deletedAt）；.archive/ 里 active 按位置归一成 deleted；
   *  .archive/ 里 deletedAt 超保留期的删掉。索引、digest、tmp 在内存里没有对应物。 */
  async maintain(dirs: string[]) {
    const want = new Set(dirs)
    const now = Date.now()
    for (const s of [...this.slots.values()].filter(s => want.has(s.dir))) {
      const archive = join(s.dir, ARCHIVE_DIR)
      const inArchive = dirname(s.filePath) === archive
      let record = s.record
      if (inArchive && record.status === 'active') record = { ...record, status: 'deleted' }
      if (record.status === 'deleted' && record.deletedAt === undefined) record = { ...record, deletedAt: now }
      if (inArchive && record.status === 'deleted' && record.deletedAt! < now - RETENTION_MS) { this.slots.delete(s.filePath); continue }
      if (!inArchive && record.status !== 'active') {
        this.slots.delete(s.filePath)
        const filePath = this.pathFor(record, archive, basename(s.filePath, '.md'))   // 搬家不改文件名
        this.slots.set(filePath, { ...s, record, filePath })
      } else if (record !== s.record) this.slots.set(s.filePath, { ...s, record })
    }
  }

  async create(record: MemoryRecord) {
    this.place(undefined, record)   // 不定位：新 id 直接占名
  }
  async put(key: string, value: MemoryRecord) {
    // 与 FileTable 同语义：put 不承载召回统计（召回统计住侧表，由 MemoryStore.markRecalled 写）
    const prev = await this.locate(key, { workspacePath: value.workspacePath })
    this.place(prev, prev ? { ...value, recallCount: prev.record.recallCount, lastRecalledAt: prev.record.lastRecalledAt } : value)
  }
  async update(key: string, fn: (c: MemoryRecord) => MemoryRecord, hint?: LocateHint) {
    const current = await this.locate(key, hint)
    if (!current) throw new RecordNotFoundError(key)
    return this.place(current, fn(current.record))
  }
  async delete(key: string, hint?: LocateHint) {
    const current = await this.locate(key, hint)
    if (!current) return false
    this.slots.delete(current.filePath)
    return true
  }
}

/** 查询范围：global 层、某个 workspace 层、或当前会话的可见集合（global + 当前 workspace）。缺省读全部目录。 */
export type QueryScope =
  | { kind: 'global' }
  | { kind: 'workspace'; path: string }
  | { kind: 'visible'; workspacePath: string | undefined }

export interface QueryFilter {
  scope?: QueryScope
  types?: string[]
  tags?: string[]
  status?: MemoryRecord['status'][]
  keyword?: string
  /** keyword 展开后的多个词项怎么算命中：all（缺省）= 全部命中，any = 任一命中。 */
  keywordMatch?: KeywordMatch
}

/** 一次查询的完整结果：记录之外带上同一次读取里的隔离文件与目录级说明（冷启动文案要分辨「空」与「全坏」）。 */
export interface QueryResult {
  records: MemoryRecord[]
  quarantined: QuarantineEntry[]
  directoryNotes: DirectoryNote[]
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

  /** 按 id 两级定位（含非 active）；hint 是当前 workspace，一级先看它的目录。 */
  async get(id: string, hint?: LocateHint): Promise<MemoryRecord | undefined> {
    return (await this.table.locate(id, hint))?.record
  }
  locate(id: string, hint?: LocateHint) { return this.table.locate(id, hint) }
  listWorkspaceDirs() { return this.table.listWorkspaceDirs() }
  /** 新记录：不定位，排他占名（save create 用）。 */
  create(record: MemoryRecord) { return this.table.create(record) }
  put(record: MemoryRecord) { return this.table.put(record.id, record) }

  /**
   * 删除按记录定位：调用方传入它读到并过了门的那条记录，按该记录自己的 workspace 定位（与 put 同约定），
   * 同 id 多副本时改的就是门检查过的那份，不会落到 global 或别的项目的副本上。
   * hardDelete 物理删除文件（不进 .archive/，不可恢复）：只给密钥硬删用（tools/forget.ts）。
   */
  hardDelete(record: Pick<MemoryRecord, 'id' | 'workspacePath'>): Promise<boolean> {
    return this.table.delete(record.id, { workspacePath: record.workspacePath })
  }

  async softDelete(record: Pick<MemoryRecord, 'id' | 'workspacePath'>): Promise<boolean> {
    const hint = { workspacePath: record.workspacePath }
    if (!(await this.table.locate(record.id, hint))) return false
    await this.table.update(record.id, r => ({ ...r, status: 'deleted', updatedAt: Date.now() }), hint)
    return true
  }

  /** scope → 目录。缺省读全部目录（global + 全部有标记的 workspace 目录）。 */
  private async dirsOf(scope: QueryScope | undefined): Promise<string[]> {
    if (scope === undefined) return [this.table.globalDir, ...(await this.table.listWorkspaceDirs()).entries.map(e => e.dir)]
    if (scope.kind === 'global') return [this.table.globalDir]
    if (scope.kind === 'workspace') return this.table.workspaceDirs(scope.path)
    return [this.table.globalDir, ...(scope.workspacePath === undefined ? [] : await this.table.workspaceDirs(scope.workspacePath))]
  }

  /** 按范围原样读目录：记录含非 active、同 id 不取舍。health / scan 的层预读用它。
   *  位置即作用域：.archive/ 里 status 仍写着 active 的文件（手工搬进去的）按 deleted 看待，维护点会把它归一落盘。 */
  async readLayer(scope: QueryScope | undefined, opts: ScopeReadOptions = {}): Promise<ScopeReadResult> {
    const read = await this.table.readScope(await this.dirsOf(scope), opts)
    const records = read.records.map(l =>
      l.record.status === 'active' && dirname(l.filePath) !== l.dir ? { ...l, record: { ...l.record, status: 'deleted' as const } } : l)
    return { ...read, records }
  }

  /** 维护点入口（快照冻结时调用）：scope 决定维护哪些目录；未解析 workspace 时只有 global。 */
  async maintain(scope: QueryScope): Promise<void> {
    await this.table.maintain(await this.dirsOf(scope))
  }

  /**
   * 执行器的统一查询入口：scope 决定读哪些目录（只读 active 时不读 .archive/），同 id 多文件按取舍规则留一份，
   * 再按 status / types / tags / keyword 过滤。validTo 过期的过滤留给调用方（注入与检索过滤，治理仍可见）。
   */
  async queryScope(filter: QueryFilter): Promise<QueryResult> {
    const statuses = filter.status ?? ['active']
    const scope = filter.scope
    const hint = scope?.kind === 'workspace' ? scope.path : scope?.kind === 'visible' ? scope.workspacePath : undefined
    // keyword 按 keywordMatch 取全部或任一词项命中（AND 零命中回退 OR 由调用方 executeSearch 决定）。
    // 原文预筛用同一组词项、同一模式：expandQueryTerms 只做小写、按空白切分、CJK 段切 bigram，不扩同义词，
    // 每个词项都是查询原文的子串，命中记录的原文里必然以子串出现（缺 id 行文件的派生 id 由 FileTable 预筛一并算入），
    // 所以预筛是超集。
    const terms = filter.keyword ? expandQueryTerms(filter.keyword.toLowerCase()) : []
    const keywordMatch = filter.keywordMatch ?? 'all'
    const read = await this.readLayer(scope, {
      ...(filter.types ? { types: filter.types } : {}),
      ...(terms.length > 0 ? { prefilterTerms: terms, prefilterMatch: keywordMatch } : {}),
      includeArchive: statuses.some(s => s !== 'active'),
    })
    const records = resolveDuplicates(read.records, { workspacePath: hint }).map(l => l.record).filter(r =>
      statuses.includes(r.status)
      && (!filter.tags || filter.tags.some(t => r.tags.includes(t)))
      && (terms.length === 0 || (keywordMatch === 'any' ? matchScore(r, terms) > 0 : matchScore(r, terms) === terms.length)))
    return { records, quarantined: read.quarantined, directoryNotes: read.directoryNotes }
  }

  async query(filter: QueryFilter): Promise<MemoryRecord[]> {
    return (await this.queryScope(filter)).records
  }

  /** 召回统计只读改写侧表，不经 table.update——记忆文件不因召回而重写。一次调用一次读、内存合并、
   *  一次批量写（单文件表只换一次文件）。跨进程单文件 LWW（参考字段）。
   *  ids 取自调用方同一次读取的结果（search 命中、快照 core 区），存活由那次读保证，这里不再逐 id 定位。 */
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
