import { mkdir, readdir, readFile, writeFile, rename, rm, stat } from 'node:fs/promises'
import { ConcurrentModificationError, RecordNotFoundError } from '../errors.ts'
import { basename, dirname, join, relative } from 'node:path'
import type { MemoryRecord } from '../record-schema.ts'
import {
  resolveDuplicates, pickLiveFirst,
  type MemoryTable, type MemoryLogger, type DirectoryNote, type QuarantineEntry, type LocatedFile, type LocatedRecord,
  type LocateHint, type ScopeReadOptions, type ScopeReadResult, type WorkspaceDirListing, type KeywordMatch,
} from './table.ts'
import type { KvTable } from '../kv-table.ts'
import type { RecallStats } from './schema.ts'
import { decodeFile, digestMismatch, encodeRecord, type FileLocation } from './frontmatter.ts'
import {
  WORKSPACE_MARKER, INDEX_FILE, GLOBAL_DIR, ARCHIVE_DIR, workspaceDirName, slugifyName, isReservedFileName,
  isMemoryFileName, isCompanionLikeFileName, isWorkspaceDirName, deriveFileId, isDerivedFileId,
} from './paths.ts'
import { linkExclusive } from './exclusive-link.ts'
import { formatIndexLine } from '../index-line.ts'
import { maskDiagnostic } from '../secrets.ts'
import { withinValidity } from '../record-freshness.ts'
import { RETENTION_MS } from '../retention.ts'

/** 软删记录清扫窗口：与快照保留共用 retention.ts 的单一来源（两者必须一致）。 */
export const DELETED_RETENTION_MS = RETENTION_MS

/** tmp 残留清理的陈旧阈值：写入-rename 窗口是毫秒级，60 秒足够排除任何在途文件。 */
const TMP_STALE_MS = 60_000

/** 原子写临时文件的完整后缀（与 atomicWrite 生成规则一致，锚定结尾）。合法记忆名可以含 ".tmp-"
 *  子串（如 cache.tmp-notes.md），只看子串会把正式 .md 当残留删掉；正式文件永远以 .md 结尾。 */
const TMP_SUFFIX_RE = /\.tmp-(\d+)-[a-z0-9]+$/

/** 写路径 locate 到写盘之间文件被别处改动时，重读重算的总次数上限；到上限仍在变就报错不写。 */
const WRITE_ATTEMPTS = 3

/** 维护点写索引后发现目录变了、按新清单重写的总次数上限（含第一次写）。 */
const INDEX_ROUNDS = 3

/** 写前复核发现 locate 之后文件被改：本轮写作废，由 update / put 重新 locate 再来（只在本文件内流转）。 */
class StaleReadError extends Error {}

/** frontmatter 里的 id 行：允许引号与两侧空白，行尾的 \r（CRLF 文件）被 \s* 吃掉。 */
const ID_LINE_RE = /^id:\s*["']?([^"'\s]+)["']?\s*$/m
/** frontmatter 里的 digest 行（维护点判手编：认识且不匹配才把时间戳取 mtime）；形态同 id 行。 */
const DIGEST_LINE_RE = /^digest:\s*["']?([^"'\s]+)["']?\s*$/m

/**
 * 原文与解码值可能不同的 frontmatter 形态，这类文件一律不预筛（预筛必须是超集）：
 *  - 带反斜杠的双引号标量（"a\"b"、"café"、长串用 \ 续行）。允许跨行：双引号标量可以折成多行，
 *    续行符可能落在没有引号的那一行，所以不按行界定。
 *  - 单引号标量里的 '' 转义（'it''s' 解码成 it's）。
 * 其余折行（纯量在空格处折行、块标量）只改变空白，词项不含空白，子串匹配不受影响。
 */
const ESCAPED_SCALAR_RE = /"[^"]*\\|'[^']*''/

/** 原文预筛：小写词项与模式（all = 全部命中才解析，any = 任一命中即解析）。词项为空即不预筛。 */
interface Prefilter { terms: readonly string[]; match: KeywordMatch }
const NO_PREFILTER: Prefilter = { terms: [], match: 'all' }

export interface FileTableOptions {
  root: string
  stats: KvTable<RecallStats>
  /** 索引行格式器由接线层注入（storage 层不依赖 registry）；缺省用无陈旧度的简版。fileName 是同目录的文件名。 */
  formatIndexLine?: (r: MemoryRecord, fileName: string) => string
  now?: () => number
  /** 日志注入口，缺省回退 console（见 store.ts MemoryLogger）。 */
  log?: MemoryLogger
}

/** 读取结果的内部形态：带 extras、磁盘原文与 mtime（维护点逐字节比较与取 mtime 用）；对外的 LocatedRecord / LocatedFile 不带后两者。 */
interface Slot extends LocatedFile { raw: string; mtimeMs: number }
/** 写路径的定位结果：取舍出的那份，外加这次定位读到的该 id 全部副本（含它自己）。写盘时只覆盖、只删这些副本里此后没变过的。 */
interface LocatedSlot extends Slot { copies: readonly Slot[] }
/** 占名结果：落到的路径，与本轮写下的那个文件的 inode（硬链接或 rename 过去的就是 tmp 的 inode；退回复制时对不上，按别人的文件看）。 */
interface Claim { path: string; ino: number }

interface ScopeDir { dir: string; loc: FileLocation }

function errnoCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code
}

/** 单个文件在目录签名里的一项：名字、大小、mtime。 */
function statSignature(name: string, s: { size: number; mtimeMs: number }): string {
  return `${name}\u0000${s.size}\u0000${s.mtimeMs}`
}

/** 目录签名：各项排序后拼接，与 readdir 顺序无关。 */
function signatureOf(seen: ReadonlyMap<string, string>): string {
  return [...seen.values()].sort().join('\n')
}

/** readMemoryFile 的结果是解析成功的记录（不是被跳过或隔离）。 */
function isSlot(r: { slot: Slot } | { quarantined: QuarantineEntry } | undefined): r is { slot: Slot; notes: DirectoryNote[] } {
  return r !== undefined && 'slot' in r
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
 * 读路径不加锁、不写盘；写路径经一条 Promise 链串行，锁内先 locate 重读磁盘再应用修改（外部编辑不丢）；create 是例外：新 id 不定位，排他占名。
 * 锁只管本进程：写盘前复核文件原文仍是 locate 读到的那份，被别的进程或用户改过就重新 locate、重算后再写。
 * 记忆目录的维护只有两处入口：写路径末尾（被写的目录）与 maintain（快照冻结时由调用方对 global + 当前 workspace 调用），都走同一把锁。
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

  private passesPrefilter(raw: string, filePath: string, { terms, match }: Prefilter): boolean {
    if (terms.length === 0) return true
    if (ESCAPED_SCALAR_RE.test(frontmatterOf(raw))) return true   // 解码后才出现的子串：不敢排除
    // 缺 id 行的手建文件，id 由相对路径派生、原文里没有：一并算进去（索引里列出派生 id，模型会拿它来搜）。
    // 词项不含空白，不会跨过拼接处的换行。
    const text = `${raw.toLowerCase()}\n${deriveFileId(relative(this.opts.root, filePath))}`
    return match === 'any' ? terms.some(t => text.includes(t)) : terms.every(t => text.includes(t))
  }

  /** 读单个记忆文件。返回 undefined = 被预筛跳过 / 竞态消失 / 不是普通文件。 */
  private async readMemoryFile(
    filePath: string, dir: string, loc: FileLocation, prefilter: Prefilter, statsRows: ReadonlyMap<string, RecallStats>,
    seen?: Map<string, string>,
  ): Promise<{ slot: Slot; notes: DirectoryNote[] } | { quarantined: QuarantineEntry } | undefined> {
    let mtimeMs: number
    let raw: string
    try {
      const s = await stat(filePath)
      if (!s.isFile()) return undefined
      seen?.set(basename(filePath), statSignature(basename(filePath), s))   // 在读内容之前取：签名不会比读到的内容新
      mtimeMs = s.mtimeMs
      raw = await readFile(filePath, 'utf8')
    } catch (err) {
      if (errnoCode(err) === 'ENOENT') return undefined   // readdir 之后被删：竞态
      if (isCompanionLikeFileName(basename(filePath))) return undefined
      return { quarantined: { path: filePath, error: maskDiagnostic(err instanceof Error ? err.message : String(err)) } }
    }
    if (!this.passesPrefilter(raw, filePath, prefilter)) return undefined
    const outcome = decodeFile(raw, { path: filePath, loc, relPath: relative(this.opts.root, filePath), mtimeMs })
    if (!outcome.ok) {
      // 伴生文件 / 锁文件形态的名字解析不出就不是记忆（伴生文件是二进制），静默跳过
      if (isCompanionLikeFileName(basename(filePath))) return undefined
      // 解析报错可能带出文件里的原值（时间戳、字段校验），进视图、体检结果之前先遮密钥
      return { quarantined: { path: outcome.path, error: maskDiagnostic(outcome.error) } }
    }
    const row = statsRows.get(outcome.record.id)
    const record = row ? { ...outcome.record, recallCount: row.recallCount, lastRecalledAt: row.lastRecalledAt } : outcome.record
    return {
      slot: { record, extras: outcome.extras, filePath, dir, raw, mtimeMs },
      notes: outcome.notes.map(n => ({ ...n, path: filePath })),
    }
  }

  private toLocated({ record, extras, filePath, dir }: Slot): LocatedFile {
    return { record, extras, filePath, dir }
  }

  /** 读一组已解析位置的目录（顶层，可选含 .archive/），带 extras 的内部形态。 */
  /** topLevel：给了就记下各目录顶层记忆文件的签名（读文件时顺手取的 stat，见 topLevelSignature）。 */
  private async readDirs(
    dirs: readonly ScopeDir[], opts: ScopeReadOptions, topLevel?: Map<string, string>,
  ): Promise<{ slots: Slot[]; listedCount: number; quarantined: QuarantineEntry[]; directoryNotes: DirectoryNote[] }> {
    const slots: Slot[] = []
    let listedCount = 0
    const quarantined: QuarantineEntry[] = []
    const directoryNotes: DirectoryNote[] = []
    const prefilter: Prefilter = {
      terms: (opts.prefilterTerms ?? []).map(t => t.toLowerCase()).filter(t => t !== ''),
      match: opts.prefilterMatch ?? 'all',
    }
    const statsRows = new Map(await this.opts.stats.list())
    for (const { dir, loc } of dirs) {
      const levels = opts.includeArchive ? [dir, join(dir, ARCHIVE_DIR)] : [dir]
      for (const level of levels) {
        const listed = await this.listMemoryFiles(level)
        if ('note' in listed) { directoryNotes.push(listed.note); continue }
        // 伴生文件形态的名字不走预筛、一律解析：它算不算记忆文件要看解析结果，列出文件数才与预筛开关无关
        const names = listed.names.sort()
        const results = await Promise.all(names.map(name =>
          this.readMemoryFile(join(level, name), dir, loc, isCompanionLikeFileName(name) ? NO_PREFILTER : prefilter, statsRows,
            level === dir ? topLevel : undefined)))
        // 只数顶层，预筛、types 之前；伴生文件形态的名字解析成记忆才数（非原生卷上每个文件都配一个伴生文件）
        if (level === dir) listedCount += names.filter((n, i) => !isCompanionLikeFileName(n) || isSlot(results[i])).length
        for (const r of results) {
          if (r === undefined) continue
          if ('quarantined' in r) { quarantined.push(r.quarantined); continue }
          if (opts.types !== undefined && !opts.types.includes(r.slot.record.type)) continue
          slots.push(r.slot)
          directoryNotes.push(...r.notes)
        }
      }
    }
    return { slots, listedCount, quarantined, directoryNotes }
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
      records: read.slots.map(({ record, filePath, dir }) => ({ record, filePath, dir })),   // 原文与 mtime 不出内部
      listedCount: read.listedCount,
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
      if ('note' in loc) {
        // 点开头又没有标记的目录（.git 之类）不是插件建的，不报缺标记
        if (!(name.startsWith('.') && loc.note.code === 'marker-missing')) directoryNotes.push(loc.note)
        continue
      }
      if (loc.loc.scope !== 'workspace') continue   // 只有 global 目录会落到这支，已被 isWorkspaceDirName 排除
      const listed = await this.listMemoryFiles(dir)
      if ('note' in listed) { directoryNotes.push(listed.note); continue }
      // 只看文件名；只剩伴生文件形态的名字时才逐个解析，解析成记忆的才算
      const hasActiveTopLevel = listed.names.some(n => !isCompanionLikeFileName(n))
        || (await Promise.all(listed.names.map(n => this.readMemoryFile(join(dir, n), dir, loc.loc, NO_PREFILTER, new Map())))).some(isSlot)
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
          const r = await this.readMemoryFile(filePath, dir, loc, NO_PREFILTER, statsRows)
          if (r !== undefined && 'slot' in r && r.slot.record.id === id) found.push(r.slot)
        }
      }
    }
    return found
  }

  async locate(id: string, hint?: LocateHint): Promise<LocatedFile | undefined> {
    const slot = await this.locateSlot(id, hint)
    return slot && this.toLocated(slot)
  }

  /** locate 的内部形态：带磁盘原文与读到的全部副本，写路径据此在写盘前复核。 */
  private async locateSlot(id: string, hint?: LocateHint): Promise<LocatedSlot | undefined> {
    // 先挑在用副本：别层更新的已删副本不遮住它，遗忘、刷新改的才是读路径上看得到的那份
    const pick = (copies: Slot[]) => copies.length > 0 ? { ...pickLiveFirst(copies, hint)!, copies } : undefined
    const global: ScopeDir = { dir: this.globalDir, loc: { scope: 'global' } }
    const hinted = hint?.workspacePath === undefined ? [] : await this.hintDirs(hint.workspacePath)
    if (hint?.isExactLayer === true) return pick(await this.scanForId(id, hint.workspacePath === undefined ? [global] : hinted))
    const first = await this.scanForId(id, [global, ...hinted])
    if (first.length > 0) return pick(first)
    const scanned = new Set([this.globalDir, ...hinted.map(d => d.dir)])
    const rest = (await this.listWorkspaceDirs()).entries
      .filter(e => !scanned.has(e.dir))
      .map(e => ({ dir: e.dir, loc: { scope: 'workspace', workspacePath: e.workspacePath } as FileLocation }))
    return pick(await this.scanForId(id, rest))
  }

  // —— 写侧（锁内）——

  async maintain(dirs: string[]): Promise<void> {
    await this.locked(() => this.maintainDirs(dirs))
  }

  /**
   * 维护点（设计稿 §5；锁内，只动给定目录，幂等）。每个目录读顶层 + .archive/ 一遍，逐文件：
   *  - .archive/ 里 status 仍为 active 的按位置归一成 deleted（位置即作用域，不搬回顶层）；deleted 缺 deletedAt 用 mtime 补
   *  - ③ .archive/ 里 deletedAt 超保留期的物理删除并清召回统计行（superseded 不清）
   *  - ④ 手建 / 手编回写：digest 认识且不匹配 → handEdited、updatedAt 与 lastConfirmedAt 取 mtime；缺 id / 缺 digest / 时间戳形态 /
   *    缺省字段由重新 encode 补齐；判「有变化」= 重新 encode 后与磁盘原文逐字节比较，不同才写
   *  - ② 顶层非 active 的搬进 .archive/（撞名追加 id 片段）；已过期的 active 文件不动
   *  - ① 再生 MEMORY.md：顶层 active 且未过期，同 id 取一份，name 再 id 排序，内容不变不写
   *  - ⑤ 陈旧 tmp 清理
   * 同 id 副本不在这里删（只在写该 id 时清理，见 persist）。
   * 锁只管本进程：回写、搬家、过期删除动手前都复核磁盘原文，读后被别的进程或用户改过的文件本轮跳过，下次维护再处理。
   */
  private async maintainDirs(dirs: readonly string[]): Promise<void> {
    const { scopeDirs } = await this.resolveDirs([...new Set(dirs)])
    const now = this.now()
    const cutoff = now - DELETED_RETENTION_MS
    for (const sd of scopeDirs) {
      const archive = join(sd.dir, ARCHIVE_DIR)
      const seen = new Map<string, string>()
      const { slots } = await this.readDirs([sd], { includeArchive: true }, seen)
      const kept: LocatedRecord[] = []
      for (const slot of slots) {
        const inArchive = dirname(slot.filePath) === archive
        let record = slot.record
        if (inArchive && record.status === 'active') record = { ...record, status: 'deleted' }
        if (record.status === 'deleted' && record.deletedAt === undefined) record = { ...record, deletedAt: slot.mtimeMs }
        if (inArchive && record.status === 'deleted' && record.deletedAt! < cutoff) {
          if (!(await this.unchangedSince(slot))) continue
          await rm(slot.filePath, { force: true })
          await this.opts.stats.delete(record.id)
          continue
        }
        if (digestMismatch(DIGEST_LINE_RE.exec(frontmatterOf(slot.raw))?.[1], record)) {
          record = { ...record, handEdited: true, updatedAt: slot.mtimeMs, lastConfirmedAt: slot.mtimeMs }
        }
        const text = encodeRecord(record, slot.extras)
        if (!inArchive && record.status !== 'active') {
          // 搬家不改文件名（spec：文件名不变；手编文件的名字由用户起），撞名由占名追加 id 片段
          if (!(await this.unchangedSince(slot))) continue
          await mkdir(archive, { recursive: true })
          let claim: Claim
          try {
            claim = await this.claimAndWrite(record, archive, text, slots.filter(s => s.record.id === record.id), basename(slot.filePath, '.md'))
          } catch (err) {
            if (err instanceof StaleReadError) continue   // 归档名被别的进程刚写的同 id 文件占着：本轮跳过，下次维护再处理
            throw err
          }
          if (claim.path.toLowerCase() !== slot.filePath.toLowerCase()) {
            // 占名期间源文件被改：撤回刚写的归档副本，源文件留给下次维护
            if (await this.unchangedSince(slot)) await rm(slot.filePath, { force: true })
            else await this.withdrawClaim(slot.filePath, claim, text)
          }
          continue
        }
        if (text !== slot.raw && await this.unchangedSince(slot)) await this.atomicWrite(slot.filePath, text)
        if (!inArchive) kept.push({ record, filePath: slot.filePath, dir: slot.dir })
      }
      // kept 只剩顶层 active（非 active 已搬走）：同 id 取一份，再过滤已过期的
      const indexable = (located: readonly LocatedRecord[]) => resolveDuplicates(located).filter(s => withinValidity(s.record, now))
      let text = this.indexText(indexable(kept))
      // 别的进程可能在本轮读目录之后写进同一目录，并先一步写好了全的索引，本轮按旧清单写会盖掉它：写了就比一次顶层签名
      // （只 readdir + stat），变了才重读顶层、按新清单再写，最多 INDEX_ROUNDS 次。插件的写都经 tmp + rename 落盘，
      // 别处增删改都会改变名字、大小或 mtime；手编也改 mtime。最后写索引的进程以写后的目录为准，索引收敛到全的那份
      let signature = signatureOf(seen)
      for (let round = 1; await this.writeIndex(sd.dir, text) && round < INDEX_ROUNDS; round++) {
        if (await this.topLevelSignature(sd.dir) === signature) break
        const fresh = new Map<string, string>()
        const { slots } = await this.readDirs([sd], {}, fresh)
        signature = signatureOf(fresh)
        const next = this.indexText(indexable(slots.filter(s => s.record.status === 'active')))
        if (next === text) break
        text = next
      }
      for (const level of [sd.dir, archive]) await this.cleanStaleTmp(level)
    }
  }

  /** 动手前的复核（维护点与写路径共用）：磁盘原文仍等于读到的那份。读不出（已删、不可读）也算变了。 */
  private async unchangedSince(slot: Slot): Promise<boolean> {
    try { return (await readFile(slot.filePath, 'utf8')) === slot.raw } catch { return false }
  }

  /**
   * 写该 id 之后清掉可见集合（global + 该记录所在目录，含各自 .archive/）里的其余副本；其他项目的副本不动（ARCHITECTURE.md ⑥-6d）；只认层的写只清该目录。
   * 给了 known（写路径传 locate 读到的副本）就只删其中此后没变过的：读之后才出现或被改过的是别的进程刚写的，两边都删对方的副本会一份不剩，
   * 留下的同 id 副本由读路径取舍、下一次写清掉。不给（删除路径）就当场扫、全删。
   */
  private async removeOtherCopies(id: string, keepPath: string, dir: string, isExactLayer: boolean, known?: readonly Slot[]): Promise<void> {
    const dirs = new Set(isExactLayer ? [dir] : [this.globalDir, dir])
    const copies = known ?? await this.scanForId(id, (await this.resolveDirs([...dirs])).scopeDirs)
    for (const copy of copies) {
      if (!dirs.has(copy.dir) || copy.filePath.toLowerCase() === keepPath.toLowerCase()) continue
      if (known === undefined || await this.unchangedSince(copy)) await rm(copy.filePath, { force: true })
    }
  }

  /** 占名后发现源文件变了：撤回刚写的新文件，只在它仍是本轮写的原文时撤回；已被改过是别人的写入，留着交给重来的那轮。
   *  源文件已不在时还要认 inode：别的进程把同一份内容搬到同一个名字上（rename 覆盖，换了 inode），新文件可能是这个 id
   *  仅存的一份，留着；仍是本轮写下的那个文件，说明源文件是被删掉的（或搬去了别处，重来的那轮会找到），撤回，
   *  否则就把刚彻底删除的内容又写了回来。 */
  private async withdrawClaim(source: string, claim: Claim, text: string): Promise<void> {
    const sourceGone = await stat(source).then(() => false, () => true)
    if (sourceGone && (await stat(claim.path).catch(() => undefined))?.ino !== claim.ino) return
    if ((await readFile(claim.path, 'utf8').catch(() => undefined)) === text) await rm(claim.path, { force: true })
  }

  /** 目录顶层记忆文件的签名：每个文件的名字、大小、mtime，不含索引；只 readdir + stat，不读内容。口径同 readDirs 顺手记下的那份。 */
  private async topLevelSignature(dir: string): Promise<string> {
    const listed = await this.listMemoryFiles(dir)
    const seen = new Map<string, string>()
    if ('names' in listed) {
      await Promise.all(listed.names.map(async name => {
        try {
          const s = await stat(join(dir, name))
          if (s.isFile()) seen.set(name, statSignature(name, s))
        } catch { /* 竞态消失：不计 */ }
      }))
    }
    return signatureOf(seen)
  }

  /** 索引全文：只由传入的 active 记录决定。 */
  private indexText(active: readonly LocatedRecord[]): string {
    // 缺省格式器与注入侧同源（src/index-line.ts）。磁盘索引不带陈旧度：静态文件里的
    // 时间相对标注会随时间失真（设计稿 §6 登记的有意偏离）。
    // 行末带同目录的实际文件名（设计稿 §11），模型拿到即可 Read，不用再 grep id。
    const fmt = this.opts.formatIndexLine ?? ((r: MemoryRecord, file: string) => formatIndexLine(r, { passive: false, file }))
    // 索引行序必须确定：readdir 序跨设备不确定，多设备同步下会造成索引文件 churn。
    // 按 name 排序（不用 localeCompare——locale 依赖环境），name 相同用 id 决胜。
    const located = active.slice().sort(({ record: a }, { record: b }) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    const lines = located.map(l => fmt(l.record, basename(l.filePath)))
    return `# Memory Index\n\n${lines.join('\n')}${lines.length ? '\n' : ''}`
  }

  /** 写索引，内容不变不写；返回是否写了。 */
  private async writeIndex(dir: string, text: string): Promise<boolean> {
    try {
      const prev = await readFile(join(dir, INDEX_FILE), 'utf8').catch(() => '')
      if (prev === text) return false
      await this.atomicWrite(join(dir, INDEX_FILE), text)
      return true
    } catch { return false /* 索引是生成物，失败不致命 */ }
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

  /** 盘上已有文件的 frontmatter id 与原文。null=不存在（可写）；id 为 'unreadable'=读不出 id（一律视为占用）。 */
  private async readIdOnDisk(path: string): Promise<{ id: string; raw: string } | null> {
    let raw: string
    try {
      raw = await readFile(path, 'utf8')
    } catch (err) {
      if (errnoCode(err) === 'ENOENT') return null
      return { id: 'unreadable', raw: '' }
    }
    return { id: ID_LINE_RE.exec(frontmatterOf(raw))?.[1] ?? 'unreadable', raw }
  }

  /**
   * 排他占名并写入（设计稿 §5；ARCHITECTURE.md ⑥-2 撞名追加 id 片段）。完整内容先进 tmp，再 link 到候选名：目标名原子出现
   * 且内容完整，没有"先建空文件再填"的窗口，崩溃最多留下 tmp（维护点清）。卷不支持硬链接时 linkExclusive 退回排他复制，
   * 排他不变，只是不再原子。EEXIST 表示名被占——占着的是同一记录自己的
   * 文件（崩溃残留、同 id 副本）才允许 rename 覆盖，否则换下一个候选：基础名 → id 片段名 → 全 id 名（按构造只属于本记录，
   * 被别的 id 占着也覆盖）。两个进程写同名异 id 的记录因此两条都存活；隔离文件、缺标记目录里的文件也不会被同 slug 写入静默覆盖。
   * 同 id 的文件也只覆盖 known 里读到、此后没变过的那份：读之后才出现或被改过的是别的进程刚落的盘，覆盖会丢掉对方的修改，
   * 抛 StaleReadError 让调用方重读再来。
   */
  private async claimAndWrite(record: MemoryRecord, level: string, text: string, known: readonly Slot[], base = slugifyName(record.name)): Promise<Claim> {
    const tmp = join(level, `${base}.md.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`)
    await writeFile(tmp, text, 'utf8')
    const { ino } = await stat(tmp)
    const fullIdName = `${base}-${record.id}.md`
    try {
      for (const name of [`${base}.md`, `${base}-${record.id.slice(-6)}.md`, fullIdName]) {
        if (isReservedFileName(name)) continue // memory.md ≈ MEMORY.md，索引再生会覆盖它
        const path = join(level, name)
        try {
          await linkExclusive(tmp, path)
          return { path, ino }
        } catch (err) {
          if (errnoCode(err) !== 'EEXIST') throw err
        }
        const onDisk = await this.readIdOnDisk(path)
        if (onDisk?.id === record.id) {
          if (!known.some(k => k.filePath.toLowerCase() === path.toLowerCase() && k.raw === onDisk.raw)) throw new StaleReadError()
        } else if (name !== fullIdName) continue
        await rename(tmp, path)
        return { path, ino }
      }
      throw new Error(`unreachable: ${fullIdName}`)   // 全 id 名不会是保留名，循环必在它那里返回
    } finally {
      await rm(tmp, { force: true })   // 占名成功后 tmp 仍在（link 多出的名字或复制的源）；rename 过的已不存在
    }
  }

  /**
   * 写路径（锁内，设计稿 §5）：选目录（scope；workspace 目录不存在则 mkdir + 写标记）→ 选层（status 离开 active 进
   * .archive/，deleted 缺 deletedAt 补 now；回到 active 搬回顶层）→ 编码 → 已定位到自己文件且目录、层、slug 都没变就原地
   * tmp + rename 覆盖，否则排他占名 → 搬家删旧 → 清可见集合里该 id 的其余副本 → 本目录（搬家时两个）维护点。返回实际写出的记录。
   * 覆盖、占名、删旧之前都复核 prev 的原文，变了抛 StaleReadError（占名后才发现的先撤回新文件），由调用方重来。
   */
  private async persist(key: string, prev: LocatedSlot | undefined, value: MemoryRecord, isExactLayer = false): Promise<MemoryRecord> {
    const next = value.status === 'deleted' && value.deletedAt === undefined ? { ...value, deletedAt: this.now() } : value
    const volatileChanged = !prev || !this.volatileEqual(prev.record, next)
    const stableChanged = !prev || !this.stableEqual(prev.record, next)
    if (stableChanged) {
      // 位置没变就留在原目录（覆盖手工改名的 workspace 目录），变了才按 scope 选目录
      const sameLocation = prev !== undefined && prev.record.scope === next.scope && prev.record.workspacePath === next.workspacePath
      const dir = sameLocation ? prev.dir : await this.dirFor(next)
      const level = next.status === 'active' ? dir : join(dir, ARCHIVE_DIR)
      const moved = prev !== undefined && prev.dir !== dir
      // 改名后文件名要跟着变，否则磁盘文件仍叫旧 slug，用户浏览/grep 被误导。比较 slug 而非
      // name（空白等变化不折腾文件），且忽略大小写：APFS 等大小写不敏感文件系统上，仅大小写
      // 不同的新旧路径是同一个文件——若触发重命名，"先写新后删旧"会把刚写的文件删掉，丢数据。
      const renamed = prev !== undefined
        && slugifyName(next.name).toLowerCase() !== slugifyName(prev.record.name).toLowerCase()
      const text = encodeRecord(next, prev?.extras ?? {})   // 易变字段由 encodeRecord 剔除
      let filePath: string
      if (prev !== undefined && !moved && !renamed && dirname(prev.filePath) === level) {
        filePath = prev.filePath
        if (!(await this.unchangedSince(prev))) throw new StaleReadError()
        await this.atomicWrite(filePath, text)   // 自己的文件：rename 只覆盖同一记录自己的文件
      } else {
        if (prev !== undefined && !(await this.unchangedSince(prev))) throw new StaleReadError()
        await mkdir(level, { recursive: true })
        const claim = await this.claimAndWrite(next, level, text, prev?.copies ?? [])
        filePath = claim.path
        // 先写新后删旧；崩溃窗口由读路径的同 id 取舍兜底。占名可能落回原路径（候选名正被自己占着），
        // 路径比较忽略大小写：大小写不敏感文件系统上不能删掉刚写的自己。
        if (prev !== undefined && prev.filePath.toLowerCase() !== filePath.toLowerCase()) {
          if (!(await this.unchangedSince(prev))) {
            await this.withdrawClaim(prev.filePath, claim, text)   // 占名期间旧文件被改或不见了：按规则撤回新文件，重来
            throw new StaleReadError()
          }
          await rm(prev.filePath, { force: true })
        }
      }
      await this.removeOtherCopies(key, filePath, dir, isExactLayer, prev?.copies ?? [])
      await this.maintainDirs(moved ? [dir, prev!.dir] : [dir])
    }
    if (volatileChanged) {
      await this.opts.stats.put(key, { id: key, recallCount: next.recallCount, lastRecalledAt: next.lastRecalledAt })
    }
    return next
  }

  /** 锁内 locate → attempt；attempt 因复核失败作废就重新 locate 再来，总共 WRITE_ATTEMPTS 次。 */
  private async withFreshLocate<T>(key: string, hint: LocateHint | undefined, attempt: (current: LocatedSlot | undefined) => Promise<T>): Promise<T> {
    for (let i = 0; i < WRITE_ATTEMPTS; i++) {
      try {
        return await attempt(await this.locateSlot(key, hint))
      } catch (err) {
        if (!(err instanceof StaleReadError)) throw err
      }
    }
    throw new ConcurrentModificationError(key, WRITE_ATTEMPTS)
  }

  async create(record: MemoryRecord): Promise<void> {
    await this.locked(async () => { await this.persist(record.id, undefined, record) })
  }

  async put(key: string, value: MemoryRecord, hint: LocateHint = { workspacePath: value.workspacePath }, skipIf?: (current: MemoryRecord) => boolean): Promise<boolean> {
    // put 是整条替换：值由调用方给定，重来时只换新的位置、附加字段与召回统计，不重算内容；skipIf 每轮按新读数重判
    return this.locked(() => this.withFreshLocate(key, hint, async prev => {
      if (prev !== undefined && skipIf?.(prev.record)) return false
      // put 不承载召回统计（设计稿 §2：召回统计只住 .state/recall-stats.json，快照恢复不恢复它）。召回统计
      // 由 MemoryStore.markRecalled 直写侧表；prev 在时以侧表现值为准，restore 旧记录不回退 sidecar。
      const next = prev
        ? { ...value, recallCount: prev.record.recallCount, lastRecalledAt: prev.record.lastRecalledAt }
        : value
      await this.persist(key, prev, next, hint.isExactLayer === true)
      return true
    }))
  }

  async update(key: string, fn: (current: MemoryRecord) => MemoryRecord, hint?: LocateHint): Promise<MemoryRecord> {
    // 锁内重读磁盘：外部编辑不丢；写盘前又被改就在新内容上重算 fn
    return this.locked(() => this.withFreshLocate(key, hint, async current => {
      if (!current) throw new RecordNotFoundError(key)
      return this.persist(key, current, fn(current.record), hint?.isExactLayer === true)
    }))
  }

  async delete(key: string, hint?: LocateHint, skipIf?: (current: LocatedFile) => boolean): Promise<boolean> {
    return this.locked(async () => {
      const slot = await this.locate(key, hint)
      if (!slot || skipIf?.(slot)) return false
      await rm(slot.filePath, { force: true })
      // 彻底删除（密钥硬删、最近删除里的彻底删除）的承诺是「可见集合里再没有它」：global 与该记录目录里同 id 的其余副本
      // （含 .archive/）一并物理删除；只认层时只删该目录里的，别层的同 id 副本是另一张卡
      await this.removeOtherCopies(key, slot.filePath, slot.dir, hint?.isExactLayer === true)
      // 召回统计按 id 一行，别层还有副本时是它的，留着
      if ((await this.locateSlot(key)) === undefined) await this.opts.stats.delete(key)
      await this.maintainDirs([...new Set([slot.dir, this.globalDir])])
      return true
    })
  }
}
