import { mkdir, readdir, readFile, writeFile, rename, rm, stat } from 'node:fs/promises'
import { RecordNotFoundError } from '../errors.ts'
import { dirname, join, relative } from 'node:path'
import type { MemoryRecord } from '../record-schema.ts'
import {
  resolveDuplicates,
  type MemoryTable, type MemoryLogger, type DirectoryNote, type QuarantineEntry, type LocatedFile, type LocatedRecord,
  type LocateHint, type ScopeReadOptions, type ScopeReadResult, type WorkspaceDirListing,
} from './table.ts'
import type { KvTable } from '../kv-table.ts'
import type { RecallStats } from './schema.ts'
import { decodeFile, encodeRecord, type FileLocation } from './frontmatter.ts'
import {
  WORKSPACE_MARKER, INDEX_FILE, GLOBAL_DIR, ARCHIVE_DIR, workspaceDirName, slugifyName, isReservedFileName,
  isMemoryFileName, isWorkspaceDirName, deriveFileId, isDerivedFileId,
} from './paths.ts'
import { formatIndexLine } from '../index-line.ts'
import { RETENTION_MS } from '../retention.ts'

/** 软删记录清扫窗口：与快照保留共用 retention.ts 的单一来源（两者必须一致）。 */
export const DELETED_RETENTION_MS = RETENTION_MS

/** tmp 残留清理的陈旧阈值：写入-rename 窗口是毫秒级，60 秒足够排除任何在途文件。 */
const TMP_STALE_MS = 60_000

/** 原子写临时文件的完整后缀（与 atomicWrite 生成规则一致，锚定结尾）。合法记忆名可以含 ".tmp-"
 *  子串（如 cache.tmp-notes.md），只看子串会把正式 .md 当残留删掉；正式文件永远以 .md 结尾。 */
const TMP_SUFFIX_RE = /\.tmp-(\d+)-[a-z0-9]+$/

/** frontmatter 里的 id 行：允许引号与两侧空白，行尾的 \r（CRLF 文件）被 \s* 吃掉。 */
const ID_LINE_RE = /^id:\s*["']?([^"'\s]+)["']?\s*$/m

/**
 * 原文与解码值可能不同的 frontmatter 形态，这类文件一律不预筛（预筛必须是超集）：
 *  - 带反斜杠的双引号标量（"a\"b"、"café"、长串用 \ 续行）。允许跨行：双引号标量可以折成多行，
 *    续行符可能落在没有引号的那一行，所以不按行界定。
 *  - 单引号标量里的 '' 转义（'it''s' 解码成 it's）。
 * 其余折行（纯量在空格处折行、块标量）只改变空白，词项不含空白，子串匹配不受影响。
 */
const ESCAPED_SCALAR_RE = /"[^"]*\\|'[^']*''/

export interface FileTableOptions {
  root: string
  stats: KvTable<RecallStats>
  /** 索引行格式器由接线层注入（storage 层不依赖 registry）；缺省用无陈旧度的简版。 */
  formatIndexLine?: (r: MemoryRecord) => string
  now?: () => number
  /** 日志注入口，缺省回退 console（见 store.ts MemoryLogger）。 */
  log?: MemoryLogger
}

/** 带 extras 的读取结果（readScope 内部形态；对外的 LocatedRecord 不带 extras）。 */
type Slot = LocatedFile

interface ScopeDir { dir: string; loc: FileLocation }

function errnoCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 原文的 frontmatter 段（到闭围栏前）：预筛的转义检查与 id 行匹配只看这一段，正文里的 "id:" 行不算。 */
function frontmatterOf(raw: string): string {
  const closeAt = raw.indexOf('\n---', 3)
  return closeAt < 0 ? raw : raw.slice(0, closeAt)
}

/**
 * 文件表：磁盘是唯一真相，进程里不常驻记忆表（设计稿 §0）。构造不做 I/O；每个操作读它涉及的目录。
 * 读路径不加锁、不写盘；写路径经一条 Promise 链串行，锁内先 locate 重读磁盘再应用修改（外部编辑不丢）。
 */
export class FileTable implements MemoryTable {
  private chain: Promise<unknown> = Promise.resolve()  // 进程内互斥：写路径与维护点串行化
  private readonly log: MemoryLogger
  private readonly opts: FileTableOptions
  readonly globalDir: string

  constructor(opts: FileTableOptions) {
    this.opts = opts
    this.log = opts.log ?? console
    this.globalDir = join(opts.root, GLOBAL_DIR)
  }

  /** 互斥执行：所有写路径都经过这里串行。 */
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn)
    this.chain = next.catch(() => {})
    return next
  }

  private now() { return this.opts.now?.() ?? Date.now() }

  // —— 读侧（不加锁、不写盘）——

  /** 读 .workspace 标记：返回路径；ENOENT / 空标记 → undefined；其他错误抛出（调用方记 dir-unreadable）。 */
  private async readMarker(dir: string): Promise<string | undefined> {
    try {
      const text = (await readFile(join(dir, WORKSPACE_MARKER), 'utf8')).trim()
      return text === '' ? undefined : text
    } catch (err) {
      if (errnoCode(err) === 'ENOENT') return undefined
      throw err
    }
  }

  private note(code: DirectoryNote['code'], path: string, text: string): DirectoryNote {
    return { level: 'info', code, path, text }
  }

  /** 把 dir 解析成 FileLocation：global 目录直接给；其余读标记。缺标记返回 note；目录根本不存在返回 undefined（计空，不是问题）。 */
  private async locationOf(dir: string): Promise<{ loc: FileLocation } | { note: DirectoryNote } | undefined> {
    if (dir === this.globalDir) return { loc: { scope: 'global' } }
    try {
      const workspacePath = await this.readMarker(dir)
      if (workspacePath !== undefined) return { loc: { scope: 'workspace', workspacePath } }
      try { await stat(dir) } catch (err) { if (errnoCode(err) === 'ENOENT') return undefined; throw err }
      return { note: this.note('marker-missing', dir, `目录缺少有效的 ${WORKSPACE_MARKER} 标记，其中的记忆文件未读取：${dir}`) }
    } catch (err) {
      return { note: this.note('dir-unreadable', dir, `目录不可读，计空：${dir}（${err instanceof Error ? err.message : String(err)}）`) }
    }
  }

  /** 列目录里的记忆文件名；ENOENT 计空（目录还没建）；其他错误返回 note。 */
  private async listMemoryFiles(dir: string): Promise<{ names: string[] } | { note: DirectoryNote }> {
    try {
      return { names: (await readdir(dir)).filter(isMemoryFileName) }
    } catch (err) {
      if (errnoCode(err) === 'ENOENT') return { names: [] }
      return { note: this.note('dir-unreadable', dir, `目录不可读，计空：${dir}（${err instanceof Error ? err.message : String(err)}）`) }
    }
  }

  private passesPrefilter(raw: string, terms: readonly string[]): boolean {
    if (terms.length === 0) return true
    if (ESCAPED_SCALAR_RE.test(frontmatterOf(raw))) return true   // 解码后才出现的子串：不敢排除
    const lower = raw.toLowerCase()
    return terms.every(t => lower.includes(t))
  }

  /** 读单个记忆文件。返回 undefined = 被预筛跳过 / 竞态消失 / 不是普通文件。 */
  private async readMemoryFile(
    filePath: string, dir: string, loc: FileLocation, terms: readonly string[], statsRows: ReadonlyMap<string, RecallStats>,
  ): Promise<{ slot: Slot; notes: DirectoryNote[] } | { quarantined: QuarantineEntry } | undefined> {
    let mtimeMs: number
    let raw: string
    try {
      const s = await stat(filePath)
      if (!s.isFile()) return undefined
      mtimeMs = s.mtimeMs
      raw = await readFile(filePath, 'utf8')
    } catch (err) {
      if (errnoCode(err) === 'ENOENT') return undefined   // readdir 之后被删：竞态
      return { quarantined: { path: filePath, error: err instanceof Error ? err.message : String(err) } }
    }
    if (!this.passesPrefilter(raw, terms)) return undefined
    const outcome = decodeFile(raw, { path: filePath, loc, relPath: relative(this.opts.root, filePath), mtimeMs })
    if (!outcome.ok) return { quarantined: { path: outcome.path, error: outcome.error } }
    const row = statsRows.get(outcome.record.id)
    const record = row ? { ...outcome.record, recallCount: row.recallCount, lastRecalledAt: row.lastRecalledAt } : outcome.record
    return {
      slot: { record, extras: outcome.extras, filePath, dir },
      notes: outcome.notes.map(n => ({ ...n, path: filePath })),
    }
  }

  /** 读一组已解析位置的目录（顶层，可选含 .archive/），带 extras 的内部形态。 */
  private async readDirs(dirs: readonly ScopeDir[], opts: ScopeReadOptions): Promise<{ slots: Slot[]; quarantined: QuarantineEntry[]; directoryNotes: DirectoryNote[] }> {
    const slots: Slot[] = []
    const quarantined: QuarantineEntry[] = []
    const directoryNotes: DirectoryNote[] = []
    const terms = (opts.prefilterTerms ?? []).map(t => t.toLowerCase()).filter(t => t !== '')
    const statsRows = new Map(await this.opts.stats.list())
    for (const { dir, loc } of dirs) {
      const levels = opts.includeArchive ? [dir, join(dir, ARCHIVE_DIR)] : [dir]
      for (const level of levels) {
        const listed = await this.listMemoryFiles(level)
        if ('note' in listed) { directoryNotes.push(listed.note); continue }
        const results = await Promise.all(listed.names.sort().map(name =>
          this.readMemoryFile(join(level, name), dir, loc, terms, statsRows)))
        for (const r of results) {
          if (r === undefined) continue
          if ('quarantined' in r) { quarantined.push(r.quarantined); continue }
          if (opts.types !== undefined && !opts.types.includes(r.slot.record.type)) continue
          slots.push(r.slot)
          directoryNotes.push(...r.notes)
        }
      }
    }
    return { slots, quarantined, directoryNotes }
  }

  /** 把调用方给的目录解析成带 FileLocation 的列表；缺标记 / 不可读的目录产 note、不读文件。 */
  private async resolveDirs(dirs: readonly string[]): Promise<{ scopeDirs: ScopeDir[]; directoryNotes: DirectoryNote[] }> {
    const scopeDirs: ScopeDir[] = []
    const directoryNotes: DirectoryNote[] = []
    for (const dir of dirs) {
      const r = await this.locationOf(dir)
      if (r === undefined) continue
      if ('note' in r) directoryNotes.push(r.note)
      else scopeDirs.push({ dir, loc: r.loc })
    }
    return { scopeDirs, directoryNotes }
  }

  async readScope(dirs: string[], opts: ScopeReadOptions = {}): Promise<ScopeReadResult> {
    const { scopeDirs, directoryNotes } = await this.resolveDirs(dirs)
    const read = await this.readDirs(scopeDirs, opts)
    return {
      records: read.slots.map(({ record, filePath, dir }) => ({ record, filePath, dir })),
      quarantined: read.quarantined,
      directoryNotes: [...directoryNotes, ...read.directoryNotes],
    }
  }

  async listWorkspaceDirs(): Promise<WorkspaceDirListing> {
    const entries: WorkspaceDirListing['entries'] = []
    const directoryNotes: DirectoryNote[] = []
    let names: string[]
    try {
      names = (await readdir(this.opts.root, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name)
    } catch (err) {
      if (errnoCode(err) !== 'ENOENT') directoryNotes.push(this.note('dir-unreadable', this.opts.root, `记忆根目录不可读，计空：${this.opts.root}`))
      return { entries, directoryNotes }
    }
    for (const name of names.filter(isWorkspaceDirName).sort()) {
      const dir = join(this.opts.root, name)
      const loc = await this.locationOf(dir)
      if (loc === undefined) continue   // readdir 之后被删：竞态
      if ('note' in loc) { directoryNotes.push(loc.note); continue }
      if (loc.loc.scope !== 'workspace') continue   // 只有 global 目录会落到这支，已被 isWorkspaceDirName 排除
      const listed = await this.listMemoryFiles(dir)
      if ('note' in listed) { directoryNotes.push(listed.note); continue }
      const hasActiveTopLevel = listed.names.length > 0
      if (!hasActiveTopLevel) directoryNotes.push(this.note('dir-empty', dir, `workspace 目录顶层没有记忆文件（只剩归档或全空），不进体检清单：${dir}`))
      entries.push({ workspacePath: loc.loc.workspacePath, dir, hasActiveTopLevel })
    }
    return { entries, directoryNotes }
  }

  /** 提示 workspace 的目录：先算确定性目录名并校验标记；算不出或标记不符时经清单找（覆盖手工改名的目录）。 */
  private async hintDirs(workspacePath: string): Promise<ScopeDir[]> {
    const loc: FileLocation = { scope: 'workspace', workspacePath }
    const dir = join(this.opts.root, workspaceDirName(workspacePath))
    try {
      if ((await this.readMarker(dir)) === workspacePath) return [{ dir, loc }]
    } catch { /* 不可读：走清单 */ }
    const listing = await this.listWorkspaceDirs()
    return listing.entries.filter(e => e.workspacePath === workspacePath).map(e => ({ dir: e.dir, loc }))
  }

  async workspaceDirs(workspacePath: string): Promise<string[]> {
    return (await this.hintDirs(workspacePath)).map(d => d.dir)
  }

  /** 在一组目录（顶层 + .archive/）里找 id 的全部候选：看原文 id 行，只解析命中文件。派生 id 先按文件路径重算哈希（不读内容，
   *  覆盖还没写回 id 的手建文件）；路径没命中再看 id 行——写回过 id 的文件改名或搬家后路径哈希已变，frontmatter 里的 id 才是它的身份。 */
  private async scanForId(id: string, dirs: readonly ScopeDir[]): Promise<Slot[]> {
    const derived = isDerivedFileId(id)
    const idLine = new RegExp(`^id:\\s*["']?${escapeRegExp(id)}["']?\\s*$`, 'm')
    const found: Slot[] = []
    const statsRows = new Map(await this.opts.stats.list())
    for (const { dir, loc } of dirs) {
      for (const level of [dir, join(dir, ARCHIVE_DIR)]) {
        const listed = await this.listMemoryFiles(level)
        if ('note' in listed) continue
        // 非命中文件只读原文做正则，不解析；命中的再走完整解析并核对 id
        const hits = await Promise.all(listed.names.sort().map(async name => {
          const filePath = join(level, name)
          if (derived && deriveFileId(relative(this.opts.root, filePath)) === id) return filePath
          try { return idLine.test(frontmatterOf(await readFile(filePath, 'utf8'))) ? filePath : undefined } catch { return undefined }
        }))
        for (const filePath of hits) {
          if (filePath === undefined) continue
          const r = await this.readMemoryFile(filePath, dir, loc, [], statsRows)
          if (r !== undefined && 'slot' in r && r.slot.record.id === id) found.push(r.slot)
        }
      }
    }
    return found
  }

  async locate(id: string, hint?: LocateHint): Promise<LocatedFile | undefined> {
    const global: ScopeDir = { dir: this.globalDir, loc: { scope: 'global' } }
    const hinted = hint?.workspacePath === undefined ? [] : await this.hintDirs(hint.workspacePath)
    const first = await this.scanForId(id, [global, ...hinted])
    if (first.length > 0) return resolveDuplicates(first, hint)[0]
    const scanned = new Set([this.globalDir, ...hinted.map(d => d.dir)])
    const rest = (await this.listWorkspaceDirs()).entries
      .filter(e => !scanned.has(e.dir))
      .map(e => ({ dir: e.dir, loc: { scope: 'workspace', workspacePath: e.workspacePath } as FileLocation }))
    const second = await this.scanForId(id, rest)
    return second.length > 0 ? resolveDuplicates(second, hint)[0] : undefined
  }

  // —— 写侧（锁内）——

  /**
   * 写路径末尾的维护动作（只动给定目录，幂等）：① deleted 且超保留期的物理删除并清召回统计行
   * ② 再生 MEMORY.md（只列 active，内容不变不写）③ 清陈旧 tmp 残留。维护点的正式化是票 11。
   */
  private async maintainDirs(dirs: readonly string[]): Promise<void> {
    const { scopeDirs } = await this.resolveDirs([...new Set(dirs)])
    const cutoff = this.now() - DELETED_RETENTION_MS
    for (const sd of scopeDirs) {
      const { slots } = await this.readDirs([sd], { includeArchive: true })
      const kept: LocatedRecord[] = []
      for (const slot of resolveDuplicates(slots)) {
        if (slot.record.status === 'deleted' && slot.record.updatedAt < cutoff) {
          await rm(slot.filePath, { force: true })
          await this.opts.stats.delete(slot.record.id)
        } else kept.push(slot)
      }
      // 索引只列顶层 active：.archive/ 里的文件按位置即"不再有效"，哪怕 status 写着 active
      const topLevelActive = kept.filter(s => s.record.status === 'active' && dirname(s.filePath) === sd.dir).map(s => s.record)
      await this.regenerateIndex(sd.dir, topLevelActive)
      for (const level of [sd.dir, join(sd.dir, ARCHIVE_DIR)]) await this.cleanStaleTmp(level)
    }
  }

  private async regenerateIndex(dir: string, active: readonly MemoryRecord[]): Promise<void> {
    // 缺省格式器与注入侧同源（src/index-line.ts）。磁盘索引不带陈旧度：静态文件里的
    // 时间相对标注会随时间失真——这是对 docs/p15-storage-search-redesign.md §6"同源同格式"的有意偏离，已回写设计稿登记。
    const fmt = this.opts.formatIndexLine ?? ((r: MemoryRecord) => formatIndexLine(r, { passive: false }))
    // 索引行序必须确定：readdir 序跨设备不确定，多设备同步下会造成索引文件 churn。
    // 按 name 排序（不用 localeCompare——locale 依赖环境），name 相同用 id 决胜。
    const records = active.slice().sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    const lines = records.map(fmt)
    const text = `# Memory Index\n\n${lines.join('\n')}${lines.length ? '\n' : ''}`
    try {
      const prev = await readFile(join(dir, INDEX_FILE), 'utf8').catch(() => '')
      if (prev !== text) await this.atomicWrite(join(dir, INDEX_FILE), text) // 内容不变不写
    } catch { /* 索引是生成物，失败不致命 */ }
  }

  /** 只删两类原子写残留：① pid 段是本进程（自家崩溃）② mtime 超 60 秒的陈旧文件。多进程共用 memoryRoot 时，
   *  别的进程在途 tmp（毫秒级窗口）绝不能碰，否则会让对方 rename 落空。stat 失败＝竞态已消失，静默跳过。 */
  private async cleanStaleTmp(dir: string): Promise<void> {
    let names: string[]
    try { names = await readdir(dir) } catch { return }
    for (const name of names) {
      const m = TMP_SUFFIX_RE.exec(name)
      if (!m) continue
      const path = join(dir, name)
      try {
        if (Number(m[1]) === process.pid || this.now() - (await stat(path)).mtimeMs > TMP_STALE_MS) await rm(path, { force: true })
      } catch { /* 竞态消失 */ }
    }
  }

  protected async atomicWrite(filePath: string, text: string): Promise<void> {
    const tmp = `${filePath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
    await writeFile(tmp, text, 'utf8')
    await rename(tmp, filePath)
  }

  private volatileEqual(a: MemoryRecord, b: MemoryRecord): boolean {
    return a.recallCount === b.recallCount && a.lastRecalledAt === b.lastRecalledAt
  }
  /** 非易变投影相等性（含 scope/workspacePath——不等即触发移动）。字段有限且纯数据，JSON 比较足够——
   * 前提是键序稳定：写路径都经 zod 归一或 spread 保序，若引入键序不定的构造需改深比较。 */
  private stableEqual(a: MemoryRecord, b: MemoryRecord): boolean {
    const proj = (r: MemoryRecord) => { const { recallCount, lastRecalledAt, ...rest } = r; return rest }
    return JSON.stringify(proj(a)) === JSON.stringify(proj(b))
  }

  /** 记录该落的目录。workspace 目录：确定性目录名的标记匹配就用它；缺标记则建目录写标记；标记不符（手工改名的目录）走清单找。 */
  private async dirFor(record: MemoryRecord): Promise<string> {
    if (record.scope === 'global') {
      await mkdir(this.globalDir, { recursive: true })
      return this.globalDir
    }
    const wsPath = record.workspacePath!
    const dir = join(this.opts.root, workspaceDirName(wsPath))
    let marker: string | undefined
    try { marker = await this.readMarker(dir) } catch { marker = undefined }
    if (marker === wsPath) return dir
    const existing = (await this.listWorkspaceDirs()).entries.find(e => e.workspacePath === wsPath)
    if (existing) return existing.dir
    if (marker !== undefined) {
      this.log.warn(`[plastic-memory] 目录 ${dir} 的 ${WORKSPACE_MARKER} 标记指向别的路径（${marker}），仍写入该目录`)
      return dir
    }
    await mkdir(dir, { recursive: true })
    await this.atomicWrite(join(dir, WORKSPACE_MARKER), wsPath + '\n')
    return dir
  }

  /** 盘上已有文件的 frontmatter id。null=不存在（可写）；'unreadable'=读不出 id（一律视为占用）。 */
  private async readIdOnDisk(path: string): Promise<string | null> {
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch (err) {
      if (errnoCode(err) === 'ENOENT') return null
      return 'unreadable'
    }
    const m = ID_LINE_RE.exec(frontmatterOf(text))
    return m ? m[1] : 'unreadable'
  }

  /** 撞名检查看磁盘：隔离文件、缺标记目录里的文件都看得见，不会被同 slug 写入静默覆盖。占名原子化是票 10。 */
  private async filePathFor(record: MemoryRecord, dir: string): Promise<string> {
    const base = slugifyName(record.name)
    const idFrag = record.id.slice(-6)
    // 依次尝试：基础名 → id 片段名 → 全 id 名（全 id 全局唯一，兜底必然可用）
    for (const name of [`${base}.md`, `${base}-${idFrag}.md`]) {
      if (isReservedFileName(name)) continue // memory.md ≈ MEMORY.md，索引再生会覆盖它
      const path = join(dir, name)
      const onDisk = await this.readIdOnDisk(path)
      if (onDisk !== null && onDisk !== record.id) continue
      return path
    }
    return join(dir, `${base}-${record.id}.md`)
  }

  private async persist(key: string, prev: LocatedFile | undefined, next: MemoryRecord): Promise<void> {
    const volatileChanged = !prev || !this.volatileEqual(prev.record, next)
    const stableChanged = !prev || !this.stableEqual(prev.record, next)
    if (stableChanged) {
      // 位置没变就留在原目录（覆盖手工改名的 workspace 目录），变了才按 scope 选目录
      const sameLocation = prev !== undefined && prev.record.scope === next.scope && prev.record.workspacePath === next.workspacePath
      const dir = sameLocation ? prev.dir : await this.dirFor(next)
      const moved = prev !== undefined && prev.dir !== dir
      // 改名后文件名要跟着变，否则磁盘文件仍叫旧 slug，用户浏览/grep 被误导。比较 slug 而非
      // name（空白等变化不折腾文件），且忽略大小写：APFS 等大小写不敏感文件系统上，仅大小写
      // 不同的新旧路径是同一个文件——若触发重命名，"先写新后删旧"会把刚写的文件删掉，丢数据。
      const renamed = prev !== undefined
        && slugifyName(next.name).toLowerCase() !== slugifyName(prev.record.name).toLowerCase()
      const filePath = moved || renamed || !prev ? await this.filePathFor(next, dir) : prev.filePath
      await this.atomicWrite(filePath, encodeRecord(next, prev?.extras ?? {}))   // 易变字段由 encodeRecord 剔除
      // 先写新后删旧；崩溃窗口由读路径的同 id 取舍兜底。filePathFor 撞名回退可能落回原路径，故加
      // prev.filePath !== filePath 保护，不能删掉刚写的自己。
      if ((moved || renamed) && prev!.filePath !== filePath) await rm(prev!.filePath, { force: true })
      await this.maintainDirs(moved ? [dir, prev!.dir] : [dir])
    }
    if (volatileChanged) {
      await this.opts.stats.put(key, { id: key, recallCount: next.recallCount, lastRecalledAt: next.lastRecalledAt })
    }
  }

  async put(key: string, value: MemoryRecord): Promise<void> {
    await this.locked(async () => {
      // put 不承载召回统计（docs/p15-storage-search-redesign.md §3 登记：快照恢复不恢复召回统计）。召回统计
      // 由 MemoryStore.markRecalled 直写侧表；prev 在时以侧表现值为准，restore 旧记录不回退 sidecar。
      const prev = await this.locate(key, { workspacePath: value.workspacePath })
      const next = prev
        ? { ...value, recallCount: prev.record.recallCount, lastRecalledAt: prev.record.lastRecalledAt }
        : value
      await this.persist(key, prev, next)
    })
  }

  async update(key: string, fn: (current: MemoryRecord) => MemoryRecord): Promise<MemoryRecord> {
    return this.locked(async () => {
      const current = await this.locate(key)   // 锁内重读磁盘：外部编辑不丢
      if (!current) throw new RecordNotFoundError(key)
      const next = fn(current.record)
      await this.persist(key, current, next)
      return next
    })
  }

  async delete(key: string): Promise<boolean> {
    return this.locked(async () => {
      const slot = await this.locate(key)
      if (!slot) return false
      await rm(slot.filePath, { force: true })
      await this.opts.stats.delete(key)
      await this.maintainDirs([slot.dir])
      return true
    })
  }
}
