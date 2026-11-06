import { basename, dirname, join, relative } from 'node:path'
import type { MemoryRecord } from '../../src/record-schema.ts'
import { RecordNotFoundError } from '../../src/errors.ts'
import {
  byPosition, pickLiveFirst, isScopeTarget, scopesOf,
  type MemoryTable, type LocatedFile, type LocateTarget, type ScopeReadOptions, type ScopeReadResult,
  type WorkspaceDirListing, type DirectoryNote,
} from '../../src/storage/table.ts'
import { ARCHIVE_DIR, GLOBAL_DIR, deriveFileId, isReservedFileName, slugifyName, workspaceDirName } from '../../src/storage/paths.ts'
import { RETENTION_MS } from '../../src/retention.ts'
import type { Scope } from '../../src/scope.ts'

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
  private readonly now: () => number

  /** now：补 deletedAt、维护点判过期用的时钟（同 FileTable 的 now），缺省取当前时间。 */
  constructor(root = '/in-memory', now: () => number = Date.now) {
    this.root = root
    this.globalDir = join(root, GLOBAL_DIR)
    this.now = now
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
    const inScope = [...this.slots.values()].filter(s => want.has(s.dir))
    const records = inScope
      .filter(s => opts.includeArchive || dirname(s.filePath) === s.dir)
      .filter(s => opts.types === undefined || opts.types.includes(s.record.type))
      .map(({ record, filePath, dir }) => ({ record, filePath, dir }))
    // 与 FileTable 同口径：只数顶层，在 types 过滤之前
    const listedCount = inScope.filter(s => dirname(s.filePath) === s.dir).length
    return { records, listedCount, quarantined: [], directoryNotes: [] }
  }

  async locate(id: string, target: LocateTarget): Promise<LocatedFile | undefined> {
    const all = [...this.slots.values()].filter(s => s.record.id === id)
    if (isScopeTarget(target)) {
      const ownDir = target.kind === 'global' ? this.globalDir : join(this.root, workspaceDirName(target.workspacePath))
      return pickLiveFirst(all.filter(s => s.dir === ownDir))
    }
    const firstLevel = all.filter(s => s.dir === this.globalDir
      || (target.workspacePath !== undefined && s.record.scope === 'workspace' && s.record.workspacePath === target.workspacePath))
    return pickLiveFirst(firstLevel.length > 0 ? firstLevel : all, target)
  }

  async copiesOf(id: string): Promise<Scope[]> {
    return scopesOf([...this.slots.values()].filter(s => s.record.id === id).map(s => s.record))
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
   *  就留在原路径，否则在目标层重新取名；落下后清掉可见集合（global + 该记录的目录）里同 id 的其余副本，给作用域时只清该目录。返回实际落下的记录。 */
  private place(prev: LocatedFile | undefined, value: MemoryRecord, isOwnDirOnly = false): MemoryRecord {
    const next = value.status === 'deleted' && value.deletedAt === undefined ? { ...value, deletedAt: this.now() } : value
    if (prev) this.slots.delete(prev.filePath)
    const sameLocation = prev !== undefined && prev.record.scope === next.scope && prev.record.workspacePath === next.workspacePath
    const dir = sameLocation ? prev.dir : this.dirOf(next)
    const level = next.status === 'active' ? dir : join(dir, ARCHIVE_DIR)
    const renamed = prev !== undefined && slugifyName(next.name).toLowerCase() !== slugifyName(prev.record.name).toLowerCase()
    const inPlace = prev !== undefined && sameLocation && !renamed && dirname(prev.filePath) === level
    const filePath = inPlace ? prev.filePath : this.pathFor(next, level)
    for (const s of this.slots.values()) {
      if (s.record.id === next.id && s.filePath !== filePath && ((!isOwnDirOnly && s.dir === this.globalDir) || s.dir === dir)) this.slots.delete(s.filePath)
    }
    this.slots.set(filePath, { record: next, extras: prev?.extras ?? {}, filePath, dir })
    return next
  }

  /** 维护点的内存对应：顶层非 active 搬 .archive/（deleted 补 deletedAt）；.archive/ 里 active 按位置归一成 deleted；
   *  .archive/ 里 deletedAt 超保留期的删掉。索引、digest、tmp 在内存里没有对应物。 */
  async maintain(dirs: string[]) {
    const want = new Set(dirs)
    const now = this.now()
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
  async put(value: MemoryRecord, from: LocateTarget, skipIf?: (current: MemoryRecord | undefined) => boolean) {
    // 与 FileTable 同语义：put 不承载召回统计（召回统计住侧表，由 MemoryStore.markRecalled 写）
    const prev = await this.locate(value.id, from)
    if (skipIf?.(prev && byPosition(prev))) return undefined
    return this.place(prev, prev ? { ...value, recallCount: prev.record.recallCount, lastRecalledAt: prev.record.lastRecalledAt } : value, isScopeTarget(from))
  }
  async update(id: string, from: LocateTarget, fn: (c: MemoryRecord) => MemoryRecord) {
    const current = await this.locate(id, from)
    if (!current) throw new RecordNotFoundError(id)
    return this.place(current, fn(current.record), isScopeTarget(from))
  }
  async delete(id: string, at: LocateTarget, skipIf?: (current: LocatedFile) => boolean) {
    const current = await this.locate(id, at)
    if (!current || skipIf?.(current)) return false
    // 与 FileTable 同语义：可见集合（global + 该记录目录）里同 id 的其余副本一并删除；给作用域时只删该目录里的
    for (const s of this.slots.values()) {
      if (s.record.id === id && ((!isScopeTarget(at) && s.dir === this.globalDir) || s.dir === current.dir)) this.slots.delete(s.filePath)
    }
    return true
  }
}
