import { mkdir, readdir, readFile, writeFile, rename, rm, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { ConcurrentModificationError, RecordNotFoundError } from '../errors.ts'
import { basename, dirname, join, relative } from 'node:path'
import type { MemoryRecord } from '../record-schema.ts'
import type { Scope } from '../scope.ts'
import {
  byPosition, resolveDuplicates, pickLiveFirst, isScopeTarget, scopesOf, newWriteOp,
  type MemoryTable, type WriteOp, type OpStep, type OpStepHandler, type MemoryLogger, type DirectoryNote, type QuarantineEntry, type LocatedFile, type LocatedRecord,
  type LocateTarget, type LocateOptions, type ScopeReadOptions, type ScopeReadResult, type WorkspaceDirListing, type KeywordMatch,
} from './table.ts'
import type { KvTable } from '../kv-table.ts'
import type { RecallStats } from './schema.ts'
import { decodeFile, digestMismatch, encodeRecord, type DecodeOutcome, type FileLocation } from './frontmatter.ts'
import { ParseCache, type CachedFile, type FileSignature } from './parse-cache.ts'
import type { RootLock } from '../root-lock.ts'
import type { OpJournal, PendingOp } from './op-journal.ts'
import type { DerivedIndex, HintRow, LevelScan } from './derived-index.ts'
import { defaultRootLock } from './root-lock.ts'
import {
  WORKSPACE_MARKER, INDEX_FILE, GLOBAL_DIR, ARCHIVE_DIR, workspaceDirName, slugifyName, isReservedFileName,
  isMemoryFileName, isCompanionLikeFileName, isWorkspaceDirName, deriveFileId,
} from './paths.ts'
import { linkExclusive } from './exclusive-link.ts'
import { FileVersionHistory, type VersionHistory } from './history.ts'
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
/** 同一行在一个进程里最多补做几次。 */
const RECOVERY_ATTEMPTS = 3

/** 维护点写索引后发现目录变了、按新清单重写的总次数上限（含第一次写）。 */
const INDEX_ROUNDS = 3

/** 写前复核发现 locate 之后文件被改：本轮写作废，由 update / put 重新 locate 再来（只在本文件内流转）。 */
class StaleReadError extends Error {}

/** 日志行的目标是这个版本认识的形状。 */
function isKnownTarget(target: unknown): target is PendingOp['target'] {
  if (typeof target !== 'object' || target === null) return false
  const t = target as Record<string, unknown>
  const isText = (key: string) => typeof t[key] === 'string'
  if (t.kind === 'write') return isText('memoryId') && isText('dir') && isText('after') && Array.isArray(t.fields)
  if (t.kind === 'delete') return isText('memoryId') && isText('dir') && isText('nameHash')
  return false
}

/** 候选文件名都被别的 id 占着：不覆盖。写路径原样抛给调用方；维护点搬家时跳过这一个文件。 */
class NameTakenError extends Error {}

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
  /** 解析缓存，缺省每个文件表新建一个；只在本文件内部用（readDirs）。 */
  parseCache?: ParseCache<DecodeOutcome>
  /** 记忆根写锁，写路径与维护点都在锁内。接线层注入插件实例的那一把；缺省用同一进程同一记忆根共用的那把（root-lock.ts）。 */
  lock?: RootLock
  /** 操作日志库：每次写入先记一行待完成，被打断的由下一次进写入段时补完。不给就只打提交标记、不能补做。 */
  journal?: OpJournal
  /** 派生索引库：按 id 找文件时先看它记的提示，不用逐个读文件。不给（或库不可用）就逐个读，结果相同。 */
  index?: DerivedIndex
  /** 目录的修改时间距扫的时刻至少这么久，提示才直接用（同一个时间刻度里的后续改动看不出来）。缺省：时间戳只到整秒的文件系统 3 s，带小数的 20 ms。只有测试会给。 */
  hintRacyMs?: number
}

/** 文件原文、文件名的指纹：操作日志里只记它，不记原文和名字（名字由记忆名生成）。 */
function fingerprintOf(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 32)
}

/** 这次改了哪些字段（只有字段名）：召回统计不算。 */
function changedFields(prev: MemoryRecord | undefined, next: MemoryRecord): string[] {
  const skip = new Set(['recallCount', 'lastRecalledAt'])
  const before = (prev ?? {}) as Record<string, unknown>
  const after = next as Record<string, unknown>
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter(key => !skip.has(key) && JSON.stringify(before[key]) !== JSON.stringify(after[key])).sort()
}

/**
 * 读取结果的内部形态：带 extras、磁盘原文与 mtime（维护点逐字节比较与取 mtime 用）；对外的 LocatedRecord / LocatedFile 不带后两者。
 * hasReservedKeys：frontmatter 写了保留键（见 frontmatter.ts），维护点不就地回写这份文件。
 */
/** statSig：读这个文件时取的 stat 签名（见 sigOf），维护点拿它重记派生库的提示。 */
interface Slot extends LocatedFile { raw: string; mtimeMs: number; statSig: string; hasReservedKeys: boolean }
/** 写路径的定位结果：取舍出的那份，外加这次定位读到的该 id 全部副本（含它自己）。写盘时只覆盖、只删这些副本里此后没变过的。 */
interface LocatedSlot extends Slot { copies: readonly Slot[] }
/** 占名结果：落到的路径，与本轮写下的那个文件的 inode（硬链接或 rename 过去的就是 tmp 的 inode；退回复制时是复制出的目标自己的）。 */
interface Claim { path: string; ino: number }

interface ScopeDir { dir: string; loc: FileLocation }

function errnoCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code
}

/** 单个文件在目录签名里的一项：名字、大小、mtime。 */
function statSignature(name: string, s: { size: number; mtimeMs: number }): string {
  return `${name}\u0000${s.size}\u0000${s.mtimeMs}`
}

const INDEX_HEADER = '# Memory Index\n\n'

/** 索引里一条记忆的行：以「- [id] 」开头、以「 · 文件名」结尾。占几行的条目（名字或摘要带换行）第一行就对不上。 */
const INDEX_LINE_RE = /^- \[[^\]]+\] .* · [^/]+\.md$/

/** 记提示时读文件里的 id 行：值照原样取（可以带空格），两头的引号去掉。只是线索，命中后按完整解析的结果核对。 */
const HINT_ID_RE = /^id:[ \t]*["']?(.*?)["']?[ \t]*$/m

/** 一个文件的 stat 签名：inode、大小、修改时间。同名文件被换掉、被改过都会变。 */
function sigOf(s: { ino: number; size: number; mtimeMs: number }): string {
  return `${s.ino}:${s.size}:${s.mtimeMs}`
}

/** 一个文件名的两个 32 位哈希（FNV-1a，两个种子）。 */
function nameHash(name: string): [number, number] {
  let a = 0x811c9dc5
  let b = 0x01000193
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i)
    a = Math.imul(a ^ c, 0x01000193)
    b = Math.imul(b ^ c, 0x85ebca6b)
  }
  return [a >>> 0, b >>> 0]
}

/**
 * 一层目录文件名列表的摘要：各个名字的哈希异或起来，再带上个数。和顺序无关，所以加一个名字、去一个名字可以直接在摘要上算
 * （见 listingWith），不用重列目录。只用来发现「名字有没有变」，不防人为构造。
 */
function listingOf(names: readonly string[]): string {
  return listingWith('0:0:0', [], names)!
}

/** 在一份摘要上去掉、加上几个名字；摘要不是这个格式（没列过目录时记的空串）返回 undefined。 */
function listingWith(listing: string, removed: readonly string[], added: readonly string[]): string | undefined {
  const m = /^([0-9a-f]+):([0-9a-f]+):(\d+)$/.exec(listing)
  if (m === null) return undefined
  let a = Number.parseInt(m[1]!, 16)
  let b = Number.parseInt(m[2]!, 16)
  for (const name of [...removed, ...added]) {
    const [x, y] = nameHash(name)
    a = (a ^ x) >>> 0
    b = (b ^ y) >>> 0
  }
  return `${a.toString(16)}:${b.toString(16)}:${Number(m[3]) - removed.length + added.length}`
}

/** 目录签名：各项排序后拼接，与 readdir 顺序无关。 */
function signatureOf(seen: ReadonlyMap<string, string>): string {
  return [...seen.values()].sort().join('\n')
}

/** readMemoryFile 的结果是解析成功的记录（不是被跳过或隔离）。 */
function isSlot(r: { slot: Slot } | { quarantined: QuarantineEntry } | undefined): r is { slot: Slot; notes: DirectoryNote[] } {
  return r !== undefined && 'slot' in r
}

/** 原文的 frontmatter 段（到闭围栏前）：预筛的转义检查与 id 行匹配只看这一段，正文里的 "id:" 行不算。 */
function frontmatterOf(raw: string): string {
  const closeAt = raw.indexOf('\n---', 3)
  return closeAt < 0 ? raw : raw.slice(0, closeAt)
}

/**
 * 文件表：磁盘是唯一真相，进程里不常驻记忆表。构造不做 I/O；每个操作读它涉及的目录。
 * 读目录时每个文件都 stat，签名没变才用解析缓存里的结果（parse-cache.ts），外部改动下一次读就能看到。
 * 读路径不加锁、不写盘；写路径在写入段里（进程内串行、跨进程持记忆根写锁），锁内先 locate 重读磁盘再应用修改（外部编辑不丢）；create 是例外：新 id 不定位，排他占名。
 * 写锁让插件进程之间的写入互斥；用户手编、git 这类外部写者不认锁：写盘前复核文件原文仍是 locate 读到的那份，被改过就重新 locate、重算后再写。
 * 记忆目录的维护只有两处入口：写路径末尾（被写的目录）与 maintain（快照冻结时由调用方对 global + 当前 workspace 调用），都走同一把锁。
 */
export class FileTable implements MemoryTable {
  /** 锁内段进入的次数与正在跑的个数：锁外定位据此判断扫描期间有没有写入（见 locate）。 */
  private writeEpoch = 0
  private writesRunning = 0
  private readonly log: MemoryLogger
  private readonly opts: FileTableOptions
  private readonly parseCache: ParseCache<DecodeOutcome>
  private readonly lock: RootLock
  private readonly journal: OpJournal | undefined
  private readonly index: DerivedIndex | undefined
  private readonly hintRacyMs: number | undefined
  private readonly stepHandlers = new Map<string, OpStepHandler>()
  /** 进写入段时已经替调用方补完的操作：它随后来结这次操作时不再做一遍。 */
  private readonly settledOnEnter = new Set<string>()
  /** 每一行在这个进程里补做失败了几次：到上限就不再试，免得一行补不上、此后每次进写入段都扫一遍目录。 */
  private readonly recoveryFailures = new Map<string, number>()
  readonly globalDir: string
  readonly history: VersionHistory = new FileVersionHistory()

  constructor(opts: FileTableOptions) {
    this.opts = opts
    this.log = opts.log ?? console
    this.parseCache = opts.parseCache ?? new ParseCache()
    this.lock = opts.lock ?? defaultRootLock(opts.root, this.log)
    this.journal = opts.journal
    this.index = opts.index
    this.hintRacyMs = opts.hintRacyMs
    // 每次拿到写锁先看有没有被打断的操作：平时一行都没有
    if (this.journal !== undefined) this.lock.onEnter?.(() => this.recoverPending())
    this.globalDir = join(opts.root, GLOBAL_DIR)
  }

  inSection<T>(fn: () => Promise<T>): Promise<T> {
    return this.lock.run(fn)
  }

  /** 互斥执行：所有写路径与维护点都经过这里，在写入段里（进程内一段一段来、轮到了再拿写锁，排队期间不占写锁）。 */
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    return this.lock.run(async () => {
      this.writeEpoch++
      this.writesRunning++
      try { return await fn() } finally { this.writesRunning-- }
    })
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
      return { note: this.note('dir-unreadable', dir, `目录读取失败：${dir}（${err instanceof Error ? err.message : String(err)}）`) }
    }
  }

  /** 列目录里的记忆文件名；ENOENT 计空（目录还没建）；其他错误返回 note。 */
  private async listMemoryFiles(dir: string): Promise<{ names: string[] } | { note: DirectoryNote }> {
    try {
      return { names: (await readdir(dir)).filter(isMemoryFileName) }
    } catch (err) {
      if (errnoCode(err) === 'ENOENT') return { names: [] }
      return { note: this.note('dir-unreadable', dir, `目录读取失败：${dir}（${err instanceof Error ? err.message : String(err)}）`) }
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

  /**
   * 读单个记忆文件。返回 undefined = 被预筛跳过 / 竞态消失 / 不是普通文件。
   * useCache：只有 readDirs 走解析缓存。命中就用缓存的原文与解析结果、不读内容；不命中读完按读前时刻决定存不存（见 parse-cache.ts）。
   */
  private async readMemoryFile(
    filePath: string, dir: string, loc: FileLocation, prefilter: Prefilter, statsRows: ReadonlyMap<string, RecallStats>,
    seen?: Map<string, string>, useCache = false,
  ): Promise<{ slot: Slot; notes: DirectoryNote[] } | { quarantined: QuarantineEntry } | undefined> {
    const cache = useCache ? this.parseCache : undefined
    const readStartedAt = this.now()
    let sig: FileSignature
    let raw: string
    let cached: CachedFile<DecodeOutcome> | undefined
    try {
      const s = await stat(filePath)
      if (!s.isFile()) return undefined
      seen?.set(basename(filePath), statSignature(basename(filePath), s))   // 在读内容之前取：签名不会比读到的内容新
      sig = { ino: s.ino, size: s.size, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs }
      cached = cache?.lookup(filePath, sig, loc)
      raw = cached?.raw ?? await readFile(filePath, 'utf8')
    } catch (err) {
      cache?.evict(filePath)
      if (errnoCode(err) === 'ENOENT') return undefined   // readdir 之后被删：竞态
      if (isCompanionLikeFileName(basename(filePath))) return undefined
      return { quarantined: { path: filePath, error: maskDiagnostic(err instanceof Error ? err.message : String(err)) } }
    }
    if (!this.passesPrefilter(raw, filePath, prefilter)) {
      if (cached === undefined) cache?.store(filePath, sig, loc, readStartedAt, { raw })
      return undefined
    }
    let outcome = cached?.decoded
    if (outcome === undefined) {
      const decoded = decodeFile(raw, { path: filePath, loc, relPath: relative(this.opts.root, filePath), mtimeMs: sig.mtimeMs })
      // 解析报错可能带出文件里的原值（时间戳、字段校验），进缓存、视图、体检结果之前先遮密钥
      outcome = decoded.ok ? decoded : { ...decoded, error: maskDiagnostic(decoded.error) }
      cache?.store(filePath, sig, loc, readStartedAt, { raw, decoded: outcome })
    }
    if (!outcome.ok) {
      // 伴生文件 / 锁文件形态的名字解析不出就不是记忆（伴生文件是二进制），静默跳过
      if (isCompanionLikeFileName(basename(filePath))) return undefined
      return { quarantined: { path: outcome.path, error: outcome.error } }
    }
    const mtimeMs = sig.mtimeMs
    const row = statsRows.get(outcome.record.id)
    // 浅拷贝：缓存里的解析结果是冻结的，调用方拿到的顶层可以改。提交标记不随记录出去，单独带在槽位上
    const { lastWriteOp: writeOp, ...decoded } = outcome.record
    const record = row ? { ...decoded, recallCount: row.recallCount, lastRecalledAt: row.lastRecalledAt } : decoded
    return {
      slot: {
        record, extras: outcome.extras, filePath, dir, raw, mtimeMs, statSig: sigOf(sig), hasReservedKeys: outcome.notes.some(n => n.code === 'reserved-keys'),
        ...(writeOp !== undefined ? { writeOp } : {}),
      },
      notes: outcome.notes.map(n => ({ ...n, path: filePath })),
    }
  }

  private toLocated({ record, extras, filePath, dir, writeOp }: Slot): LocatedFile {
    return { record, extras, filePath, dir, ...(writeOp !== undefined ? { writeOp } : {}) }
  }

  /**
   * 读一组已解析位置的目录（顶层，可选含 .archive/），带 extras 的内部形态。
   * topLevel：给了就记下各目录顶层记忆文件的签名（读文件时顺手取的 stat，见 topLevelSignature）。
   */
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
        this.parseCache.retain(level, new Set(names))
        const results = await Promise.all(names.map(name =>
          this.readMemoryFile(join(level, name), dir, loc, isCompanionLikeFileName(name) ? NO_PREFILTER : prefilter, statsRows,
            level === dir ? topLevel : undefined, true)))
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
      if (errnoCode(err) !== 'ENOENT') directoryNotes.push(this.note('dir-unreadable', this.opts.root, `记忆根目录读取失败：${this.opts.root}`))
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

  /** 提示 workspace 的目录：先算确定性目录名并校验标记；算不出或标记不符时经清单找（覆盖手工改名的目录）。
   *  listing：调用方已读过的清单，给了就不再重读。onListing：这次自己读了清单时交给调用方（要看清单里的目录说明）。 */
  private async hintDirs(workspacePath: string, listing?: WorkspaceDirListing, onListing?: (read: WorkspaceDirListing) => void): Promise<ScopeDir[]> {
    const loc: FileLocation = { scope: 'workspace', workspacePath }
    const dir = join(this.opts.root, workspaceDirName(workspacePath))
    try {
      if ((await this.readMarker(dir)) === workspacePath) return [{ dir, loc }]
    } catch { /* 不可读：走清单 */ }
    const read = listing ?? await this.listWorkspaceDirs()
    if (listing === undefined) onListing?.(read)
    return read.entries.filter(e => e.workspacePath === workspacePath).map(e => ({ dir: e.dir, loc }))
  }

  async workspaceDirs(workspacePath: string): Promise<{ dirs: string[]; directoryNotes: DirectoryNote[] }> {
    let listing: WorkspaceDirListing | undefined
    const dirs = await this.hintDirs(workspacePath, undefined, read => { listing = read })
    return { dirs: dirs.map(d => d.dir), directoryNotes: listing?.directoryNotes.filter(n => n.code === 'dir-unreadable') ?? [] }
  }

  /** 文件里的 id：frontmatter 的 id 行；没有 id 行的手建文件按路径派生。读不出返回 null。 */
  private async idInFile(filePath: string): Promise<string | null> {
    try {
      const written = HINT_ID_RE.exec(frontmatterOf(await readFile(filePath, 'utf8')))?.[1]
      return written !== undefined && written !== '' ? written : deriveFileId(relative(this.opts.root, filePath))
    } catch {
      return null
    }
  }

  /** 一层里这些文件各自的 stat 签名；取不到（刚被删、不是普通文件）记空串。 */
  private fileSigs(level: string, names: readonly string[]): Promise<string[]> {
    return Promise.all(names.map(name => stat(join(level, name)).then(s => (s.isFile() ? sigOf(s) : ''), () => '')))
  }

  /** 给这些文件各读一条提示。签名在读内容之前取：签名不会比读到的内容新。 */
  private readHints(level: string, names: readonly string[]): Promise<HintRow[]> {
    return Promise.all(names.map(async (name) => {
      const filePath = join(level, name)
      const sig = await stat(filePath).then(s => (s.isFile() ? sigOf(s) : ''), () => '')
      return [name, sig === '' ? null : await this.idInFile(filePath), sig] as const
    }))
  }

  /**
   * 这一层里哪些文件记着这个 id，逐个文件读出来；有派生库就顺手把整层的提示重记一遍。目录读不了返回 undefined。
   * 目录的修改时间在列目录之前取：之后才发生的改动会让它和记下的不一样，下次再补。
   */
  private async scanLevel(level: string, id: string): Promise<string[] | undefined> {
    const prior = this.index?.levelScan(level)
    const scannedAt = Date.now()
    const at = await stat(level).catch(() => undefined)
    const listed = await this.listMemoryFiles(level)
    if ('note' in listed) return undefined
    const names = listed.names.sort()
    const rows = await this.readHints(level, names)
    if (at !== undefined) {
      this.index?.replaceLevel(level, { mtimeMs: at.mtimeMs, ino: at.ino, scannedAt, listing: listingOf(names) }, rows, prior?.rev)
    }
    return rows.filter(([, fileId]) => fileId === id).map(([name]) => name)
  }

  /**
   * 目录的修改时间距核对的时刻多久才算稳妥。时间戳只到整秒的文件系统（修改时间正好是整秒）等 3 秒；
   * 带小数的说明粒度细，等过内核打时间戳的刻度（毫秒级）就够。测试给了 hintRacyMs 就按给的。
   */
  private racyWindowMs(mtimeMs: number): number {
    return this.hintRacyMs ?? (Number.isInteger(mtimeMs / 1000) ? 3000 : 20)
  }

  /**
   * 按派生库的提示找这一层里记着这个 id 的文件名。
   * 返回 undefined：没有可用的提示（没有库、这一层没核对过、目录被整个换掉、库写不进去、目录读不了），调用方逐个读。
   *  - 目录的修改时间和上次核对时一样，而且那次核对离这个修改时间够久：直接用。
   *  - 修改时间一样、但离得太近（同一个时间刻度里的后续改动看不出来）：列一次目录，文件名都没变就用。
   *  - 其余（目录变过）：列目录，每个文件取一次 stat。新出现的、签名变了的（同名文件被换掉、被改过）重读 id，不在了的去掉。
   * 提示只是线索：原地改了 id 而签名恰好没变、或同一个时间刻度里被换掉的同名文件，这里看不出来（见 scanForId 怎么兜）。
   */
  private async hintedNames(level: string, id: string): Promise<string[] | undefined> {
    const index = this.index
    if (index === undefined) return undefined
    const scan = index.levelScan(level)
    if (scan === undefined) return undefined
    const scannedAt = Date.now()
    let at: { mtimeMs: number; ino: number }
    try {
      at = await stat(level)
    } catch (err) {
      if (errnoCode(err) !== 'ENOENT') return undefined
      index.dropLevel(level)
      return []
    }
    if (at.ino !== scan.ino) return undefined
    const isSameTime = scan.mtimeMs === at.mtimeMs
    if (isSameTime && scan.scannedAt - at.mtimeMs >= this.racyWindowMs(at.mtimeMs)) return index.namesOf(level, id)
    const listed = await this.listMemoryFiles(level)
    if ('note' in listed) return undefined
    const names = listed.names.sort()
    const stamp = { mtimeMs: at.mtimeMs, ino: at.ino, scannedAt, listing: listingOf(names) }
    if (isSameTime && stamp.listing === scan.listing) {
      // 把核对的时刻往后记，过了时间刻度之后就能直接用；记不上（别人刚写过）不要紧
      index.patchLevel(level, stamp, [], [], scan.rev)
      return index.namesOf(level, id)
    }
    const known = index.hints(level)
    const sigs = await this.fileSigs(level, names)
    const current = new Set(names)
    const removed = [...known.keys()].filter(name => !current.has(name))
    const changed = names.filter((name, i) => sigs[i] === '' || known.get(name)?.sig !== sigs[i])
    const added = await this.readHints(level, changed)
    if (!index.patchLevel(level, stamp, removed, added, scan.rev)) return undefined
    return index.namesOf(level, id)
  }

  /** 这几层里，派生库的提示此刻和目录对得上（目录的修改时间和 inode 没变）的那些，连同当时的扫描记录。写入动手前问一次（见 settleHints）。 */
  private async currentLevels(levels: Iterable<string>): Promise<Map<string, LevelScan>> {
    const current = new Map<string, LevelScan>()
    const index = this.index
    if (index === undefined) return current
    for (const level of new Set(levels)) {
      const scan = index.levelScan(level)
      if (scan === undefined) continue
      const at = await stat(level).catch(() => undefined)
      if (at !== undefined && at.mtimeMs === scan.mtimeMs && at.ino === scan.ino) current.set(level, scan)
    }
    return current
  }

  /**
   * 写入方把自己的改动直接记进派生库，下一次查找不用为自己刚做的改动逐个核对文件。changes 里给了 id 的是写下的文件，没给的是删掉的。
   * 只在能证明「这一层的变化全是自己这次写入造成的」时才记：动手前提示和目录对得上（currentLevels），写完重列一次目录，
   * 文件名列表正好等于原来的加上自己增减的。对不上（别人也动过这一层）、原来的列表摘要不知道、或这期间别人改过提示（版本号变了），
   * 就什么都不记，留给下一次查找逐个核对。
   */
  private async settleHints(current: ReadonlyMap<string, LevelScan>, changes: ReadonlyArray<{ path: string; id?: string }>): Promise<void> {
    const index = this.index
    if (index === undefined) return
    for (const [level, scan] of current) {
      const own = changes.filter(c => dirname(c.path) === level && isMemoryFileName(basename(c.path)))
      const added = own.filter(c => c.id !== undefined)
      const addedNames = new Set(added.map(c => basename(c.path)))
      const removed = own.filter(c => c.id === undefined && !addedNames.has(basename(c.path))).map(c => basename(c.path))
      // 摘要只按提示里实际增减的名字算：写下的文件原来就在（原地覆盖）不算新增，删掉的文件提示里本来没有不算减少
      const fresh = [...addedNames].filter(name => !index.hasName(level, name))
      const gone = removed.filter(name => index.hasName(level, name))
      const expected = listingWith(scan.listing, gone, fresh)
      if (expected === undefined) continue
      const scannedAt = Date.now()
      const at = await stat(level).catch(() => undefined)
      const listed = await this.listMemoryFiles(level)
      if (at === undefined || at.ino !== scan.ino || 'note' in listed || listingOf(listed.names) !== expected) continue
      const sigs = await this.fileSigs(level, [...addedNames])
      const rows = [...addedNames].map((name, i) => [name, added.find(c => basename(c.path) === name)!.id!, sigs[i]!] as const)
      index.patchLevel(level, { mtimeMs: at.mtimeMs, ino: at.ino, scannedAt, listing: expected }, removed, rows, scan.rev)
    }
  }

  /**
   * 在一组目录（顶层 + .archive/）里找 id 的全部候选，只解析命中的文件并核对 id。没写回 id 的手建文件按路径派生的 id 找；
   * 写回过 id 的文件改名或搬家后，frontmatter 里的 id 才是它的身份。
   * 有派生库时先按提示找（见 hintedNames），找到的文件少读很多：
   *  - 提示指的文件对不上（不在了、id 变了）：那一层逐个读一遍。
   *  - 按提示哪一层都没找到：不算没有，这几层都逐个读一遍。找不到的情形（给错 id、彻底删除后的确认）开销和没有库时一样。
   * isExhaustive：不看提示，每一层都逐个读。要「这个 id 的全部副本」、漏一份就会做错决定的调用方用它（列副本所在的作用域、彻底删除时清副本）。
   * 按提示找到了就不再逐个读：同 id 的另一份副本若是原地改出来的（文件签名恰好没变），要等快照冻结时的维护点重记提示才看得到。
   */
  private async scanForId(id: string, dirs: readonly ScopeDir[], isExhaustive = false): Promise<Slot[]> {
    const found: Slot[] = []
    const statsRows = new Map(await this.opts.stats.list())
    const hintedOnly: Array<{ level: string; dir: string; loc: FileLocation }> = []
    const read = async (level: string, dir: string, loc: FileLocation, names: readonly string[]) => {
      const slots: Slot[] = []
      for (const name of names) {
        const r = await this.readMemoryFile(join(level, name), dir, loc, NO_PREFILTER, statsRows)
        if (r !== undefined && 'slot' in r && r.slot.record.id === id) slots.push(r.slot)
      }
      return slots
    }
    const rescan = async (level: string, dir: string, loc: FileLocation) => read(level, dir, loc, await this.scanLevel(level, id) ?? [])
    for (const { dir, loc } of dirs) {
      for (const level of [dir, join(dir, ARCHIVE_DIR)]) {
        const hinted = isExhaustive ? undefined : await this.hintedNames(level, id)
        if (hinted === undefined) { found.push(...await rescan(level, dir, loc)); continue }
        const slots = await read(level, dir, loc, hinted)
        if (slots.length !== hinted.length) { found.push(...await rescan(level, dir, loc)); continue }
        found.push(...slots)
        hintedOnly.push({ level, dir, loc })
      }
    }
    if (found.length === 0) {
      for (const { level, dir, loc } of hintedOnly) found.push(...await rescan(level, dir, loc))
    }
    return found
  }

  /**
   * 挪文件（改名、归档、恢复：先 link 新位置再删旧位置）都在锁内；锁外的扫描先列目录、后读文件，夹在一次挪动中间时
   * 新旧两处都可能看不到。所以锁外没找到、而扫描期间本表有写入在跑时，到锁内再找一次才算没有；
   * opts.isMissRechecked 时没找到一律到锁内再找（也挡住别的进程的挪动）。找到了、或没撞上写入的不进锁，只读入口照旧不碰锁库。
   */
  async locate(id: string, target: LocateTarget, opts: LocateOptions = {}): Promise<LocatedFile | undefined> {
    const epoch = this.writeEpoch
    const wasIdle = this.writesRunning === 0
    let slot = await this.locateSlot(id, target)
    if (slot === undefined && (opts.isMissRechecked === true || !wasIdle || this.writeEpoch !== epoch)) {
      slot = await this.locked(() => this.locateSlot(id, target))
    }
    return slot && this.toLocated(slot)
  }

  /** locate 的内部形态：带磁盘原文与读到的全部副本，写路径据此在写盘前复核。缺省目标即不带当前项目的会话视角。 */
  private async locateSlot(id: string, target: LocateTarget = {}): Promise<LocatedSlot | undefined> {
    const global: ScopeDir = { dir: this.globalDir, loc: { scope: 'global' } }
    if (isScopeTarget(target)) {
      const own = target.kind === 'global' ? [global] : await this.hintDirs(target.workspacePath)
      const copies = await this.scanForId(id, own)
      return copies.length > 0 ? { ...pickLiveFirst(copies)!, copies } : undefined
    }
    // 先挑在用副本：别的作用域里更新的已删副本不遮住它，遗忘、刷新改的才是读路径上看得到的那份
    const pick = (copies: Slot[]) => copies.length > 0 ? { ...pickLiveFirst(copies, target)!, copies } : undefined
    const hinted = target.workspacePath === undefined ? [] : await this.hintDirs(target.workspacePath)
    const first = await this.scanForId(id, [global, ...hinted])
    if (first.length > 0) return pick(first)
    const scanned = new Set([this.globalDir, ...hinted.map(d => d.dir)])
    const rest = (await this.listWorkspaceDirs()).entries
      .filter(e => !scanned.has(e.dir))
      .map(e => ({ dir: e.dir, loc: { scope: 'workspace', workspacePath: e.workspacePath } as FileLocation }))
    return pick(await this.scanForId(id, rest))
  }

  async copiesOf(id: string): Promise<Scope[]> {
    // 在锁内扫（理由同 locate）：少了哪一份从结果上看不出来，调用方却据此决定提升会不会撞上全局那份、别的副本要不要一并处理
    return this.locked(async () => {
      // 每个项目看的目录与给作用域定位时相同（hintDirs）：标准目录在就不看同一项目的改名目录，按这里返回的作用域定位才找得到
      const listing = await this.listWorkspaceDirs()
      const workspaces = await Promise.all([...new Set(listing.entries.map(e => e.workspacePath))].map(p => this.hintDirs(p, listing)))
      const copies = await this.scanForId(id, [{ dir: this.globalDir, loc: { scope: 'global' } }, ...workspaces.flat()], true)
      return scopesOf(copies.map(c => c.record))
    })
  }

  // —— 写侧（锁内）——

  async maintain(dirs: string[]): Promise<void> {
    await this.locked(() => this.maintainDirs(dirs))
  }

  /**
   * 维护点（快照冻结时调用；锁内，只动给定目录，幂等）。写路径末尾不做：它的开销和目录大小成正比，写入只处理自己动到的文件
   * （见 persist、patchIndexLine）。每个目录读顶层 + .archive/ 一遍，逐文件：
   *  - .archive/ 里 status 仍为 active 的按位置归一成 deleted（位置即作用域，不搬回顶层）；deleted 缺 deletedAt 用 mtime 补
   *  - ③ .archive/ 里 deletedAt 超保留期的物理删除，哪层都没有这个 id 了才清召回统计行（superseded 不清）
   *  - ④ 手建 / 手编回写：digest 认识且不匹配 → updatedAt 与 lastConfirmedAt 取 mtime；缺 id / 缺 digest / 时间戳形态 /
   *    缺省字段由重新 encode 补齐；判「有变化」= 重新 encode 后与磁盘原文逐字节比较，不同才写；顶层含保留键的文件不回写
   *  - ② 顶层非 active 的搬进 .archive/（撞名追加 id 片段）；已过期的 active 文件不动
   *  - ① 再生 MEMORY.md：顶层 active 且未过期，同 id 取一份，name 再 id 排序，内容不变不写
   *  - ⑤ 陈旧 tmp 清理
   * 同 id 副本不在这里删（只在写该 id 时清理，见 persist）。
   * 读完顺手把派生库里这两层的提示按读到的记录重记一遍：没改目录修改时间的手编（原地改了 id）靠这里补上。
   * 写锁挡不住用户手编、git，写锁不可用时也挡不住别的进程：回写、搬家、过期删除动手前都复核磁盘原文，读后被改过的文件本轮跳过，下次维护再处理。
   */
  private async maintainDirs(dirs: readonly string[]): Promise<void> {
    const { scopeDirs } = await this.resolveDirs([...new Set(dirs)])
    const now = this.now()
    const cutoff = now - DELETED_RETENTION_MS
    for (const sd of scopeDirs) {
      const archive = join(sd.dir, ARCHIVE_DIR)
      const seen = new Map<string, string>()
      const scannedAt = Date.now()
      const priorRevs = [sd.dir, archive].map(level => this.index?.levelScan(level)?.rev)
      const levelStats = await Promise.all([sd.dir, archive].map(level => stat(level).then(s => ({ mtimeMs: s.mtimeMs, ino: s.ino }), () => undefined)))
      const { slots } = await this.readDirs([sd], { includeArchive: true }, seen)
      for (const [i, level] of [sd.dir, archive].entries()) {
        const at = levelStats[i]
        if (at === undefined) continue
        const rows = slots.filter(s => dirname(s.filePath) === level).map(s => [basename(s.filePath), s.record.id, s.statSig] as const)
        // 文件名列表的摘要不知道（读目录时不留名单）：记空串，下次目录有变时逐个核对一遍再补上
        this.index?.replaceLevel(level, { ...at, scannedAt, listing: '' }, rows, priorRevs[i])
      }
      const kept: LocatedRecord[] = []
      for (const slot of slots) {
        const inArchive = dirname(slot.filePath) === archive
        let record = slot.record
        if (inArchive && record.status === 'active') record = { ...record, status: 'deleted' }
        if (record.status === 'deleted' && record.deletedAt === undefined) record = { ...record, deletedAt: slot.mtimeMs }
        if (inArchive && record.status === 'deleted' && record.deletedAt! < cutoff) {
          if (!(await this.unchangedSince(slot))) continue
          await this.removeFile(slot.filePath)
          // 同 delete：别层还有这个 id 时统计行是它的。只在真删过期文件时全盘找一次，平常的维护不多读
          if ((await this.locateSlot(record.id)) === undefined) await this.opts.stats.delete(record.id)
          continue
        }
        if (digestMismatch(DIGEST_LINE_RE.exec(frontmatterOf(slot.raw))?.[1], record)) {
          record = { ...record, updatedAt: slot.mtimeMs, lastConfirmedAt: slot.mtimeMs }
        }
        // 维护点的回写不是一次操作：提交标记原样留着
        const text = encodeRecord(slot.writeOp === undefined ? record : { ...record, lastWriteOp: slot.writeOp }, slot.extras)
        if (!inArchive && record.status !== 'active') {
          // 搬家不改文件名（spec：文件名不变；手编文件的名字由用户起），撞名由占名追加 id 片段
          if (!(await this.unchangedSince(slot))) continue
          await mkdir(archive, { recursive: true })
          let claim: Claim
          try {
            claim = await this.claimAndWrite(record, archive, text, slots.filter(s => s.record.id === record.id), basename(slot.filePath, '.md'))
          } catch (err) {
            if (err instanceof StaleReadError) continue   // 归档名被别的进程刚写的同 id 文件占着：本轮跳过，下次维护再处理
            if (err instanceof NameTakenError) continue   // 归档名都被别的 id 占着：留在顶层（非 active 不进索引），等用户腾出名字
            throw err
          }
          if (claim.path.toLowerCase() !== slot.filePath.toLowerCase()) {
            // 占名期间源文件被改：撤回刚写的归档副本，源文件留给下次维护
            if (await this.unchangedSince(slot)) await this.removeFile(slot.filePath)
            else await this.withdrawClaim(slot.filePath, claim, text)
          }
          continue
        }
        // 顶层含保留键的文件原样留着：回写会删掉这些键（content 键的值随之丢失），目录问题里的提醒也跟着消失，等用户自己改
        const keepAsIs = !inArchive && slot.hasReservedKeys
        if (!keepAsIs && text !== slot.raw && await this.unchangedSince(slot)) await this.atomicWrite(slot.filePath, text)
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

  /** 动手前的复核（维护点与写路径共用）：磁盘原文仍等于读到的那份。读不出（已删、不可读）也算变了。
   *  变了就逐出解析缓存：读到的可能是缓存里的陈旧原文，重算时不能再拿到同一份。 */
  private async unchangedSince(slot: Slot): Promise<boolean> {
    let unchanged: boolean
    try { unchanged = (await readFile(slot.filePath, 'utf8')) === slot.raw } catch { unchanged = false }
    if (!unchanged) this.parseCache.evict(slot.filePath)
    return unchanged
  }

  /** 删一个记忆文件，同时逐出解析缓存（彻底删除后缓存不再留它的原文）。 */
  private async removeFile(filePath: string): Promise<void> {
    await rm(filePath, { force: true })
    this.parseCache.evict(filePath)
  }

  /**
   * 写该 id 之后清掉可见集合（global + 该记录所在目录，含各自 .archive/）里的其余副本；其他项目的副本不动；给作用域的写只清该目录。
   * 给了 known（写路径传 locate 读到的副本）就只删其中此后没变过的：读之后才出现或被改过的是别的进程刚写的，两边都删对方的副本会一份不剩，
   * 留下的同 id 副本由读路径取舍、下一次写清掉。不给（删除路径）就当场扫、全删。返回删过副本的记忆目录。
   */
  private async removeOtherCopies(
    id: string, keepPath: string, dir: string, isOwnDirOnly: boolean, known?: readonly Slot[], changes?: Array<{ path: string; id?: string }>,
  ): Promise<Set<string>> {
    const dirs = new Set(isOwnDirOnly ? [dir] : [this.globalDir, dir])
    const copies = known ?? await this.scanForId(id, (await this.resolveDirs([...dirs])).scopeDirs, true)
    const removedFrom = new Set<string>()
    for (const copy of copies) {
      if (!dirs.has(copy.dir) || copy.filePath.toLowerCase() === keepPath.toLowerCase()) continue
      if (known === undefined || await this.unchangedSince(copy)) {
        await this.removeFile(copy.filePath)
        changes?.push({ path: copy.filePath })
        removedFrom.add(copy.dir)
      }
    }
    return removedFrom
  }

  /** 占名后发现源文件变了：撤回刚写的新文件，只在它仍是本轮写的原文时撤回；已被改过是别人的写入，留着交给重来的那轮。
   *  源文件已不在时还要认 inode：别的进程把同一份内容搬到同一个名字上（rename 覆盖，换了 inode），新文件可能是这个 id
   *  仅存的一份，留着；仍是本轮写下的那个文件，说明源文件是被删掉的（或搬去了别处，重来的那轮会找到），撤回，
   *  否则就把刚彻底删除的内容又写了回来。 */
  private async withdrawClaim(source: string, claim: Claim, text: string): Promise<void> {
    const sourceGone = await stat(source).then(() => false, () => true)
    if (sourceGone && (await stat(claim.path).catch(() => undefined))?.ino !== claim.ino) return
    if ((await readFile(claim.path, 'utf8').catch(() => undefined)) === text) await this.removeFile(claim.path)
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
    // 时间相对标注会随时间失真，所以这里有意和注入侧不同。
    // 行末带同目录的实际文件名，模型拿到即可 Read，不用再 grep id。
    const fmt = this.opts.formatIndexLine ?? ((r: MemoryRecord, file: string) => formatIndexLine(r, { passive: false, file }))
    // 索引行序必须确定：readdir 序跨设备不确定，多设备同步下会造成索引文件 churn。
    // 按 name 排序（不用 localeCompare——locale 依赖环境），name 相同用 id 决胜。
    const located = active.slice().sort(({ record: a }, { record: b }) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    const lines = located.map(l => fmt(l.record, basename(l.filePath)))
    return `${INDEX_HEADER}${lines.join('\n')}${lines.length ? '\n' : ''}`
  }

  /**
   * 写入结束时只改这条记忆在 MEMORY.md 里的那一行，不重读目录：去掉这个 id 原来的行，entry 给了（顶层、在用、没过期）就按名字插回去。
   * 行的位置按行文字比，和整份重新生成的顺序只在名字相同、或一个名字是另一个名字的开头时可能不同；快照冻结时的维护点会按确定的顺序重写。
   * 按行改不了的时候对这个目录做一次完整维护（它写完会复核目录、收敛到全的那份）：
   *  - 索引还不存在，或不是「开头加一行一条记忆」的样子（手改过、名字或摘要里带换行的记忆占了几行）；
   *  - 写锁此刻不是跨进程互斥的：另一个进程可能正拿着旧索引往回写，按行改会把它刚删的行带回来。
   * 索引是生成物，失败不致命。
   */
  private async patchIndexLine(dir: string, id: string, entry?: LocatedRecord): Promise<void> {
    const path = join(dir, INDEX_FILE)
    const fmt = this.opts.formatIndexLine ?? ((r: MemoryRecord, file: string) => formatIndexLine(r, { passive: false, file }))
    const line = entry === undefined ? undefined : fmt(entry.record, basename(entry.filePath))
    const prev = await readFile(path, 'utf8').catch(() => undefined)
    const lines = prev?.startsWith(INDEX_HEADER) ? prev.slice(INDEX_HEADER.length).split('\n').filter(l => l !== '') : undefined
    const isLineWise = lines !== undefined && lines.every(l => INDEX_LINE_RE.test(l)) && (line === undefined || (!line.includes('\n') && INDEX_LINE_RE.test(line)))
    if (prev === undefined || lines === undefined || !isLineWise || this.lock.isExclusive?.() === false) {
      await this.maintainDirs([dir])
      return
    }
    try {
      const own = `- [${id}] `
      const kept = lines.filter(l => !l.startsWith(own))
      if (line !== undefined) {
        const at = kept.findIndex(l => l.slice(l.indexOf('] ') + 2) > entry!.record.name)
        kept.splice(at === -1 ? kept.length : at, 0, line)
      }
      const text = `${INDEX_HEADER}${kept.join('\n')}${kept.length ? '\n' : ''}`
      if (text !== prev) await this.atomicWrite(path, text)
    } catch { /* 冻结时的维护点会重写 */ }
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
    this.parseCache.evict(filePath)
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
   * 排他占名并写入（撞名时追加 id 片段）。完整内容先进 tmp，再 link 到候选名：目标名原子出现
   * 且内容完整，没有"先建空文件再填"的窗口，崩溃最多留下 tmp（维护点清）。卷不支持硬链接时，持着跨进程写锁就确认目标
   * 不存在后把 tmp 改名过去（同样原子）；写锁不可用才退回排他复制，排他不变，只是不再原子。EEXIST 表示名被占——占着的是同一记录自己的
   * 文件（崩溃残留、同 id 副本）才允许 rename 覆盖，否则换下一个候选：基础名 → id 片段名 → 全 id 名。全 id 名也被别的 id
   * 占着（手建、改过 id 的文件）就抛错，不覆盖。两个进程写同名异 id 的记录因此两条都存活；隔离文件、缺标记目录里的文件也不会被同 slug 写入静默覆盖。
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
          // 退回复制时目标是另一个文件，按目标本身记；硬链接时就是 tmp，不再 stat（此刻目标名可能已被别人 rename 覆盖）
          const isCopy = await linkExclusive(tmp, path, this.lock.isExclusive?.() === true)
          this.parseCache.evict(path)
          return { path, ino: isCopy ? (await stat(path)).ino : ino }
        } catch (err) {
          if (errnoCode(err) !== 'EEXIST') throw err
        }
        const onDisk = await this.readIdOnDisk(path)
        if (onDisk?.id === record.id) {
          if (!known.some(k => k.filePath.toLowerCase() === path.toLowerCase() && k.raw === onDisk.raw)) throw new StaleReadError()
        } else if (name !== fullIdName) continue
        // 文件名由 name 派生、可能带密钥，报错只给目录和占着的 id
        else if (onDisk !== null) throw new NameTakenError(`候选文件名都被别的记忆占着，没有写入：${dirname(path)}（占着的 id：${onDisk.id}）`)
        await rename(tmp, path)
        this.parseCache.evict(path)
        return { path, ino }
      }
      throw new Error(`unreachable: ${fullIdName}`)   // 全 id 名不会是保留名，循环必在它那里返回或抛错
    } finally {
      await rm(tmp, { force: true })   // 占名成功后 tmp 仍在（link 多出的名字或复制的源）；rename 过的已不存在
    }
  }

  /**
   * 写路径（锁内）：选目录（scope；workspace 目录不存在则 mkdir + 写标记）→ 选层（status 离开 active 进
   * .archive/，deleted 缺 deletedAt 补 now；回到 active 搬回顶层）→ 编码 → 已定位到自己文件且目录、层、slug 都没变就原地
   * tmp + rename 覆盖，否则排他占名 → 搬家删旧 → 清可见集合里该 id 的其余副本 → 改这条在索引里的行（搬走、清掉副本的目录去掉它的行）。
   * 不做整目录维护：别的文件的手编回写、归档搬家、过期清扫等快照冻结时的维护点。返回实际写出的记录。
   * 覆盖、占名、删旧之前都复核 prev 的原文，变了抛 StaleReadError（占名后才发现的先撤回新文件），由调用方重来。
   */
  private async persist(key: string, prev: LocatedSlot | undefined, value: MemoryRecord, isOwnDirOnly = false, given?: WriteOp): Promise<MemoryRecord> {
    const { lastWriteOp: _stale, ...stripped } = value
    const next: MemoryRecord = stripped.status === 'deleted' && stripped.deletedAt === undefined ? { ...stripped, deletedAt: this.now() } : stripped
    const volatileChanged = !prev || !this.volatileEqual(prev.record, next)
    const stableChanged = !prev || !this.stableEqual(prev.record, next)
    if (stableChanged) {
      // 提交标记：这个文件带着这次的操作 id 出现在目标目录里，这次写入就算提交了
      const op = given ?? newWriteOp()
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
      const text = encodeRecord({ ...next, lastWriteOp: op.id }, prev?.extras ?? {})   // 易变字段由 encodeRecord 剔除
      const isInPlace = prev !== undefined && !moved && !renamed && dirname(prev.filePath) === level
      // 这次会动到的几层：新文件那层、原文件那层、要清的副本那几层，还有改索引的顶层
      const current = await this.currentLevels([level, dir, ...(prev === undefined ? [] : [dirname(prev.filePath), prev.dir, ...prev.copies.map(c => dirname(c.filePath))])])
      const changes: Array<{ path: string; id?: string }> = []
      this.beginOp(op, {
        kind: 'write', memoryId: key, dir: level, fields: changedFields(prev?.record, next),
        ...(prev !== undefined ? { before: fingerprintOf(prev.raw) } : {}), after: fingerprintOf(text),
        ...(prev !== undefined && !isInPlace ? { source: { dir: dirname(prev.filePath), nameHash: fingerprintOf(basename(prev.filePath)) } } : {}),
      })
      let filePath: string
      if (prev !== undefined && isInPlace) {
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
          await this.removeFile(prev.filePath)
          changes.push({ path: prev.filePath })
        }
      }
      changes.push({ path: filePath, id: key })
      const removedFrom = await this.removeOtherCopies(key, filePath, dir, isOwnDirOnly, prev?.copies ?? [], changes)
      const isIndexed = next.status === 'active' && withinValidity(next, this.now())
      await this.patchIndexLine(dir, key, isIndexed ? { record: next, filePath, dir } : undefined)
      if (moved) removedFrom.add(prev.dir)
      removedFrom.delete(dir)
      for (const other of removedFrom) await this.patchIndexLine(other, key)
      await this.settleHints(current, changes)
      // 调用方给的操作还有账要记，由它做完再结（finishOp）；自己建的到这里就做完了
      if (given === undefined) this.endOp(op.id)
    }
    if (volatileChanged) {
      await this.opts.stats.put(key, { id: key, recallCount: next.recallCount, lastRecalledAt: next.lastRecalledAt })
    }
    return next
  }

  // —— 操作日志（锁内）——

  /** 这把锁此刻跨进程互斥才记日志：退回进程内保护时，看到的待完成行可能属于另一个正在写的进程，分不出来。 */
  private isJournaling(): boolean {
    return this.journal !== undefined && this.lock.isExclusive?.() !== false
  }

  private beginOp(op: WriteOp, target: PendingOp['target']): void {
    if (!this.isJournaling()) return
    this.journal!.begin({
      op: op.id, at: this.now(), target, steps: [...op.steps],
      ...(op.initiator !== undefined ? { initiator: op.initiator } : {}), ...(op.batch !== undefined ? { batch: op.batch } : {}),
    })
  }

  private endOp(opId: string): void {
    if (this.isJournaling()) this.journal!.done(opId)
  }

  /** 登记提交后某一种步骤的处理器（接线层做）：正常写完和中断后补做走同一个处理器。 */
  registerStep(kind: string, handler: OpStepHandler): void {
    this.stepHandlers.set(kind, handler)
  }

  private async runSteps(opId: string, steps: readonly OpStep[], record: MemoryRecord | undefined, isIntact = true): Promise<void> {
    for (const step of steps) {
      const handler = this.stepHandlers.get(step.kind)
      // 不认识的步骤（更新的版本记的）做不了，跳过
      if (handler === undefined) this.log.warn(`[plastic-memory] 操作 ${opId} 有一步不认识（${step.kind}），已跳过`)
      else await handler(step, { op: opId, record, isIntact })
    }
  }

  private knowsSteps(steps: unknown): steps is OpStep[] {
    return Array.isArray(steps) && steps.every(step => typeof step?.kind === 'string' && this.stepHandlers.has(step.kind))
  }

  async finishOp(op: WriteOp, written?: MemoryRecord): Promise<void> {
    await this.locked(async () => {
      // 结操作自己也是进一次写入段：这一行还待完成的话，进段时已经按同一套步骤补完了
      if (this.settledOnEnter.delete(op.id)) return
      // 有一步没人会做（处理器没登记）：行留着，等登记了的进程来补，不做一半就销账
      if (!this.knowsSteps(op.steps)) {
        this.log.warn(`[plastic-memory] 操作 ${op.id} 有一步不认识，提交后的步骤没做，留在日志里`)
        return
      }
      await this.runSteps(op.id, op.steps, written)
      this.endOp(op.id)
    })
  }

  /**
   * 补做被打断的操作（每次顶层的段拿到写锁先跑）。写入整段都在锁里，这时看到的待完成行一定来自没走完的上一段：
   * 进程中途退出，或那一段抛了错。按行里记的目标判提交了没有：
   *  - 写文件：目标目录里有这个 id、提交标记等于操作 id 的文件算已提交。原来那份（文件位置会变的写入先写新、后删旧）
   *    原文还是改前的样子才删；被改过就两份都留，读路径照常取舍，体检报同 id 多份。
   *  - 彻底删除：那个文件不在了算已提交，哪里都没有这个 id 了就清召回统计。补做不删文件：同 id 的其余副本留着，体检报。
   * 已提交的把提交后的步骤补完；没提交的作废，改前快照留着无害。一行补做失败留到下一次，不挡别的行；
   * 同一行在这个进程里连着失败几次就不再试。更新的版本记的行（目标种类或步骤不认识）不动。
   */
  private async recoverPending(): Promise<void> {
    if (!this.isJournaling() || !this.journal!.hasPending()) return
    for (const row of this.journal!.pending()) {
      if ((this.recoveryFailures.get(row.op) ?? 0) >= RECOVERY_ATTEMPTS) continue
      const { target } = row
      // 更新的版本记的行（形状、目标种类或步骤不认识）原样留着，等认识它的版本来补
      if (!isKnownTarget(target) || !this.knowsSteps(row.steps)) {
        this.recoveryFailures.set(row.op, RECOVERY_ATTEMPTS)
        this.log.warn(`[plastic-memory] 被打断的操作 ${row.op} 是更新的版本记的，这个版本补不了，留给它`)
        continue
      }
      try {
        if (target.kind === 'write') {
          const committed = await this.findStamped(target.dir, target.memoryId, row.op)
          if (committed !== undefined) {
            if (target.source !== undefined && target.before !== undefined) await this.removeSourceIfUnchanged(target.source, target.before, committed.located.filePath)
            await this.runSteps(row.op, row.steps, committed.located.record, fingerprintOf(committed.raw) === target.after)
          }
        } else if (!(await this.hasFileNamed(target.dir, target.nameHash))) {
          // 补做不删文件：名字不在了可能是删成了，也可能是中断后被人改了名，分不出来。同 id 还剩着的副本留给体检报
          if ((await this.locateSlot(target.memoryId)) === undefined) await this.opts.stats.delete(target.memoryId)
          await this.runSteps(row.op, row.steps, undefined)
        }
        this.journal!.done(row.op)
        this.recoveryFailures.delete(row.op)
        this.settledOnEnter.add(row.op)
      } catch (err) {
        const failures = (this.recoveryFailures.get(row.op) ?? 0) + 1
        this.recoveryFailures.set(row.op, failures)
        const next = failures >= RECOVERY_ATTEMPTS ? '这个进程不再试，重启后再补' : '下次写入时再试'
        this.log.warn(`[plastic-memory] 补做被打断的操作 ${row.op} 失败，${next}（${err instanceof Error ? err.message : String(err)}）`)
      }
    }
  }

  async locateWrittenBy(id: string, target: Scope, opId: string): Promise<LocatedFile | undefined> {
    return this.locked(async () => {
      const own = target.kind === 'global' ? [{ dir: this.globalDir, loc: { scope: 'global' } as FileLocation }] : await this.hintDirs(target.workspacePath)
      const written = (await this.scanForId(id, own)).find(copy => copy.writeOp === opId)
      return written && this.toLocated(written)
    })
  }

  /**
   * 目录里这个 id、提交标记等于 opId 的文件。每个文件只读一次，指纹和记录出自同一份原文；原文里没有这个操作 id 的不解析。
   * 有文件读不出（权限、占用）又没找到时抛错：不能当成「没有」，否则这一行会被当成没提交而作废。
   */
  private async findStamped(level: string, id: string, opId: string): Promise<{ located: LocatedFile; raw: string } | undefined> {
    const listed = await this.listMemoryFiles(level)
    if ('note' in listed) throw new Error(listed.note.text)
    const dir = basename(level) === ARCHIVE_DIR ? dirname(level) : level
    const loc = await this.locationOf(dir)
    if (loc === undefined || 'note' in loc) return undefined
    let unreadable: string | undefined
    for (const name of listed.names.sort()) {
      const filePath = join(level, name)
      let raw: string
      let mtimeMs: number
      try {
        mtimeMs = (await stat(filePath)).mtimeMs
        raw = await readFile(filePath, 'utf8')
      } catch (err) {
        if (errnoCode(err) !== 'ENOENT') unreadable = name
        continue
      }
      if (!frontmatterOf(raw).includes(opId)) continue
      const decoded = decodeFile(raw, { path: filePath, loc: loc.loc, relPath: relative(this.opts.root, filePath), mtimeMs })
      if (!decoded.ok || decoded.record.id !== id || decoded.record.lastWriteOp !== opId) continue
      const { lastWriteOp: writeOp, ...record } = decoded.record
      return { located: { record, extras: decoded.extras, filePath, dir, writeOp }, raw }
    }
    if (unreadable !== undefined) throw new Error(`${level} 里有文件读不出（${unreadable}），分不出这次写入提交了没有`)
    return undefined
  }

  private async fileNamed(level: string, nameHash: string): Promise<string | undefined> {
    const listed = await this.listMemoryFiles(level)
    if ('note' in listed) throw new Error(listed.note.text)
    const name = listed.names.find(n => fingerprintOf(n) === nameHash)
    return name === undefined ? undefined : join(level, name)
  }

  private async hasFileNamed(level: string, nameHash: string): Promise<boolean> {
    return (await this.fileNamed(level, nameHash)) !== undefined
  }

  private async removeSourceIfUnchanged(source: { dir: string; nameHash: string }, before: string, committedPath: string): Promise<void> {
    const path = await this.fileNamed(source.dir, source.nameHash)
    if (path === undefined || path.toLowerCase() === committedPath.toLowerCase()) return
    const raw = await readFile(path, 'utf8').catch(() => undefined)
    if (raw !== undefined && fingerprintOf(raw) === before) await this.removeFile(path)
  }

  /** 锁内 locate → attempt；attempt 因复核失败作废就重新 locate 再来，总共 WRITE_ATTEMPTS 次。 */
  private async withFreshLocate<T>(key: string, target: LocateTarget, attempt: (current: LocatedSlot | undefined) => Promise<T>): Promise<T> {
    for (let i = 0; i < WRITE_ATTEMPTS; i++) {
      try {
        return await attempt(await this.locateSlot(key, target))
      } catch (err) {
        if (!(err instanceof StaleReadError)) throw err
      }
    }
    throw new ConcurrentModificationError(key, WRITE_ATTEMPTS)
  }

  async create(record: MemoryRecord, op?: WriteOp): Promise<void> {
    await this.locked(async () => { await this.persist(record.id, undefined, record, false, op) })
  }

  async put(value: MemoryRecord, from: LocateTarget, skipIf?: (current: MemoryRecord | undefined) => boolean, op?: WriteOp): Promise<MemoryRecord | undefined> {
    // put 是整条替换：值由调用方给定，重来时只换新的位置、附加字段与召回统计，不重算内容；skipIf 每轮按新读数重判
    return this.locked(() => this.withFreshLocate(value.id, from, async prev => {
      if (skipIf?.(prev && byPosition(prev))) return undefined
      // put 不承载召回统计（召回统计只住 .state/recall-stats.json，快照恢复不恢复它）。召回统计
      // 由 MemoryStore.markRecalled 直写侧表；prev 在时以侧表现值为准，restore 旧记录不回退 sidecar。
      const next = prev
        ? { ...value, recallCount: prev.record.recallCount, lastRecalledAt: prev.record.lastRecalledAt }
        : value
      return this.persist(value.id, prev, next, isScopeTarget(from), op)
    }))
  }

  async update(id: string, from: LocateTarget, fn: (current: MemoryRecord) => MemoryRecord, op?: WriteOp): Promise<MemoryRecord> {
    // 锁内重读磁盘：外部编辑不丢；写盘前又被改就在新内容上重算 fn
    return this.locked(() => this.withFreshLocate(id, from, async current => {
      if (!current) throw new RecordNotFoundError(id)
      return this.persist(id, current, fn(current.record), isScopeTarget(from), op)
    }))
  }

  async delete(id: string, at: LocateTarget, skipIf?: (current: LocatedFile) => boolean, given?: WriteOp): Promise<boolean> {
    return this.locked(async () => {
      const found = await this.locateSlot(id, at)
      const slot = found && this.toLocated(found)
      if (!slot || skipIf?.(slot)) return false
      const op = given ?? newWriteOp()
      this.beginOp(op, {
        kind: 'delete', memoryId: id, dir: dirname(slot.filePath), nameHash: fingerprintOf(basename(slot.filePath)),
        before: fingerprintOf(found.raw), scopeDir: slot.dir, isOwnDirOnly: isScopeTarget(at),
      })
      await this.removeFile(slot.filePath)
      // 彻底删除（密钥硬删、最近删除里的彻底删除）的承诺是「可见集合里再没有它」：global 与该记录目录里同 id 的其余副本
      // （含 .archive/）一并物理删除；给作用域时只删该目录里的，别的作用域里的同 id 副本是另一张卡
      const removed: Array<{ path: string }> = [{ path: slot.filePath }]
      const removedFrom = await this.removeOtherCopies(id, slot.filePath, slot.dir, isScopeTarget(at), undefined, removed)
      // 派生库里不留彻底删掉的文件名
      for (const level of new Set(removed.map(c => dirname(c.path)))) {
        this.index?.forgetNames(level, removed.filter(c => dirname(c.path) === level).map(c => basename(c.path)))
      }
      // 召回统计按 id 一行，别的作用域还有副本时是它的，留着
      if ((await this.locateSlot(id)) === undefined) await this.opts.stats.delete(id)
      // 彻底删除后索引里不留它的名字和摘要：当场整份重写，不等冻结。不按行改：它的摘要带换行时占了几行，
      // 后面几行可以长得像别的记忆的行，按行认不出来
      await this.maintainDirs([...removedFrom.add(slot.dir)])
      if (given === undefined) this.endOp(op.id)
      return true
    })
  }
}
