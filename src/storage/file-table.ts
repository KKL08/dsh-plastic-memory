import { mkdir, readdir, readFile, writeFile, rename, rm, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { classifyChange, currentWriteSession, RECENT_CHANGE_STEP, type RecentChangeInput } from './recent-changes.ts'
import { ConcurrentModificationError, RecordNotFoundError } from '../errors.ts'
import { basename, dirname, join, relative } from 'node:path'
import type { MemoryRecord } from '../record-schema.ts'
import type { Scope } from '../scope.ts'
import {
  byPosition, resolveDuplicates, pickLiveFirst, isScopeTarget, scopesOf, newWriteOp, outgoingLinks, sortLinkRefs,
  type LinkQuery, type LinkRef, type MemoryTable, type WriteOp, type TopicIntent, type OpStep, type OpStepHandler, type MemoryLogger, type DirectoryNote, type QuarantineEntry, type LocatedFile, type LocatedRecord,
  type LocateTarget, type LocateOptions, type ScopeReadOptions, type ScopeReadResult, type WorkspaceDirListing, type KeywordMatch,
} from './table.ts'
import type { KvTable } from '../kv-table.ts'
import type { RecallStats } from './schema.ts'
import { decodeFile, digestMismatch, encodeRecord, type DecodeOutcome, type FileLocation } from './frontmatter.ts'
import { ParseCache, type CachedFile, type FileSignature } from './parse-cache.ts'
import type { RootLock } from '../root-lock.ts'
import type { OpJournal, PendingOp } from './op-journal.ts'
import type { DerivedIndex, HintRow, LevelScan, LinkFileRow, TopicPageRow } from './derived-index.ts'
import { defaultRootLock } from './root-lock.ts'
import { describeError } from './state-files.ts'
import {
  WORKSPACE_MARKER, INDEX_FILE, GLOBAL_DIR, ARCHIVE_DIR, workspaceDirName, slugifyName, isReservedFileName,
  isMemoryFileName, isCompanionLikeFileName, isWorkspaceDirName, deriveFileId,
} from './paths.ts'
import { linkExclusive } from './exclusive-link.ts'
import { FileVersionHistory, carryMergedHistory, layerOf, type VersionHistory } from './history.ts'
import { maskDiagnostic, maskSecrets } from '../secrets.ts'
import { isPendingDelegated } from '../record-schema.ts'
import { UNSORTED_PAGE, UNSORTED_TITLE, resolveTopic, scan, MEMBER_RE, memberKey, memberLine, orderedPages, maskIndexText, memberKeys, memberLines, placeholderIds, readIndex, reconcileIndex, renderProjection, stampOf, withMemberLinesAppended, withMemberText, withStamp, withoutMember, withoutMemberKeys, withoutMemberText, type IndexFiles, type IndexedMemory } from '../topic-index.ts'
import { applyPlan, ensureTopicPage, insertMembers, isAbout, planForReplay, planIndexOp, targetOf, undoPlan, type IndexOp, type IndexPlan } from '../topic-ops.ts'
import { INDEX_DIR, INDEX_TOPICS_DIR, IndexChangedError, indexFilePath, readIndexFile, readIndexFiles, replaceIndexFile, writeIndexFiles } from './index-store.ts'
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

/** 换作用域提交之后把历史版本目录搬过去：文件表自己记进操作日志的一步，中断后按日志补做。 */
export const HISTORY_MOVE_STEP = 'history-move'
interface RecentChangeStep extends OpStep, Omit<RecentChangeInput, 'op'> { kind: typeof RECENT_CHANGE_STEP }
interface HistoryMoveStep extends OpStep { kind: typeof HISTORY_MOVE_STEP; memoryId: string; from: string; to: string }

/**
 * 文件表自己的提交后步骤：这次写入动到的几个记忆目录里，按记忆文件现在的样子改它在主题索引里的那一行
 * （补行、去行、同步名称摘要文件名、按 WriteOp.topic 归主题）。重复做结果不变；读不出索引就抛错，行留在日志里下次补。
 */
export const INDEX_ROW_STEP = 'index-row'

/**
 * 索引行这一步记进日志的样子。dirs 是要改索引的记忆目录（顶层目录，不是 .archive）：写入落在的那个排第一，
 * 换了作用域时原来那个跟在后面；彻底删除给作用域时只有记录所在的目录，按会话定位时再加全局目录（去重）。
 * topic 原样沿用 WriteOp.topic（调用方已遮过密钥）；没给就不带。
 * isPurge：彻底删除记的，当场和补做都核对 dirs 里有 _index/ 或 MEMORY.md 的目录，核对不成就抛错。
 */
export interface IndexRowStep extends OpStep {
  kind: typeof INDEX_ROW_STEP
  memoryId: string
  dirs: string[]
  topic?: TopicIntent
  isPurge?: true
}

/** 索引操作提交之后的一步：把计划在这个目录的索引上套完（重复做结果不变）。 */
const INDEX_PLAN_STEP = 'index-plan'
interface IndexPlanStep extends OpStep { kind: typeof INDEX_PLAN_STEP; dir: string; plan: IndexPlan }
/**
 * 撤销索引操作提交之后的一步：把算好的几个文件写下去、删掉该删的页。每个文件还是算的时候那份（按指纹比）就整份写，
 * 已经是要写的内容就跳过；被别人改过的不盖，只把成员挪对：该在这页的补上，这一步里去了别的页的拿掉。
 */
const INDEX_WRITE_STEP = 'index-write'
interface IndexWriteStep extends OpStep {
  kind: typeof INDEX_WRITE_STEP
  dir: string
  /** text 里的成员行是只带 id 的占位（见 topic-index.ts withoutMemberText）。 */
  writes: Array<{ file: string; before: string | null; text: string }>
  deletes: Array<{ file: string; before: string }>
}

export type { IndexOpOutcome, IndexUndoOutcome, IndexOpOptions } from './table.ts'
import type { IndexOpOutcome, IndexUndoOutcome, IndexOpOptions } from './table.ts'

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
  if (t.kind === 'index') return isText('dir') && isText('file')
  return false
}

/** 模型交来的主题名和说明遮一遍密钥再用。 */
function maskOp(op: IndexOp): IndexOp {
  switch (op.kind) {
    case 'assign': return { ...op, to: maskSecrets(op.to), ...(op.about === undefined ? {} : { about: maskSecrets(op.about) }) }
    case 'rename': return { ...op, name: maskSecrets(op.name) }
    case 'merge': return { ...op, ...(op.about === undefined ? {} : { about: maskSecrets(op.about) }) }
    case 'describe': return { ...op, about: maskSecrets(op.about) }
    default: return op
  }
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
  /** 一条记忆算不算久未确认，由接线层注入（storage 层不依赖 registry）；只用来在 MEMORY.md 里数数，缺省都不算。 */
  isStale?: (r: MemoryRecord, now: number) => boolean
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
/** 按 id 找副本的这一轮里，要看的各层是不是都列出来了：给了就由查找记下，有一层列不出就置 false。 */
interface ListingCheck { isListed: boolean }

function errnoCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code
}

/** 读得不全的目录说明：目录读不了、项目目录缺标记，里面的记忆没读到。 */
function isIncompleteNote(note: DirectoryNote): boolean {
  return note.code === 'dir-unreadable' || note.code === 'marker-missing'
}

/**
 * 读到的这些目录都列出来了（说明里没有读得不全的）。列不出的目录里有什么不知道：在那里定位不到不等于没有。
 * 维护里清归档、删召回统计、核对主题索引和重写 MEMORY.md 之前都看它，列不全就不做。
 */
function isListed(notes: readonly DirectoryNote[]): boolean {
  return !notes.some(isIncompleteNote)
}

/** 一层（顶层或 .archive/）所属的记忆目录。 */
function layerDirOf(level: string): string {
  return basename(level) === ARCHIVE_DIR ? dirname(level) : level
}

/** 单个文件在目录签名里的一项：名字、大小、mtime。 */
function statSignature(name: string, s: { size: number; mtimeMs: number }): string {
  return `${name}\u0000${s.size}\u0000${s.mtimeMs}`
}

/** 记提示时读文件里的 id 行：值照原样取（可以带空格），两头的引号去掉。只是线索，命中后按完整解析的结果核对。 */
const HINT_ID_RE = /^id:[ \t]*["']?(.*?)["']?[ \t]*$/m

/** 一个文件的 stat 签名：inode、大小、修改时间。同名文件被换掉、被改过都会变。 */
function sigOf(s: { ino: number; size: number; mtimeMs: number }): string {
  return `${s.ino}:${s.size}:${s.mtimeMs}`
}

/** 一个记忆文件在链接反向索引里的一行。 */
function linkRowOf(name: string, sig: string, record: MemoryRecord | undefined): LinkFileRow {
  return { name, sig, sourceId: record?.id ?? null, links: record === undefined ? [] : outgoingLinks(record) }
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
  /** 调用方给的操作里没做成的文件表自己的步骤：结操作时再试一次，还不成就把行留给补做。 */
  private readonly unfinishedOwn = new Map<string, OpStep[]>()
  /** 整份核对时拿不准归属的历史目录（层目录 + 记忆 id）：这个进程里不再为它扫各个作用域。 */
  private readonly unresolvedOrphans = new Set<string>()
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
    this.stepHandlers.set(RECENT_CHANGE_STEP, async (raw, ctx) => {
      const { kind: _kind, ...change } = raw as RecentChangeStep
      this.journal?.recordChange({ op: ctx.op, ...change })
    })
    this.stepHandlers.set(HISTORY_MOVE_STEP, raw => this.followMove(raw as HistoryMoveStep))
    this.stepHandlers.set(INDEX_ROW_STEP, raw => this.placeIndexRow(raw as IndexRowStep))
    this.stepHandlers.set(INDEX_PLAN_STEP, raw => this.finishIndexPlan(raw as IndexPlanStep))
    this.stepHandlers.set(INDEX_WRITE_STEP, raw => this.finishIndexWrites(raw as IndexWriteStep))
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
    const unreadable: NonNullable<WorkspaceDirListing['unreadable']> = []
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
      if ('note' in listed) {
        // 标记读得到、目录列不出：是项目，只是不知道顶层有没有记忆，单列给体检按没读全查
        directoryNotes.push(listed.note)
        unreadable.push({ workspacePath: loc.loc.workspacePath, dir })
        continue
      }
      // 只看文件名；只剩伴生文件形态的名字时才逐个解析，解析成记忆的才算
      const hasActiveTopLevel = listed.names.some(n => !isCompanionLikeFileName(n))
        || (await Promise.all(listed.names.map(n => this.readMemoryFile(join(dir, n), dir, loc.loc, NO_PREFILTER, new Map())))).some(isSlot)
      if (!hasActiveTopLevel) directoryNotes.push(this.note('dir-empty', dir, `workspace 目录顶层没有记忆文件（只剩归档或全空），不进体检清单：${dir}`))
      entries.push({ workspacePath: loc.loc.workspacePath, dir, hasActiveTopLevel })
    }
    return { entries, directoryNotes, ...(unreadable.length > 0 ? { unreadable } : {}) }
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
   * listing：给了就记下这一轮有没有哪一层列不出（列不出的那层里可能就有这个 id）。
   * 按提示找到了就不再逐个读：同 id 的另一份副本若是原地改出来的（文件签名恰好没变），要等快照冻结时的维护点重记提示才看得到。
   */
  private async scanForId(id: string, dirs: readonly ScopeDir[], isExhaustive = false, listing?: ListingCheck): Promise<Slot[]> {
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
    const rescan = async (level: string, dir: string, loc: FileLocation) => {
      const names = await this.scanLevel(level, id)
      if (names === undefined && listing !== undefined) listing.isListed = false
      return read(level, dir, loc, names ?? [])
    }
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

  /** locate 的内部形态：带磁盘原文与读到的全部副本，写路径据此在写盘前复核。缺省目标即不带当前项目的会话视角。
   *  listing：给了就记下这一轮要看的各层是不是都列出来了（只用在缺省目标的全盘查找）。 */
  private async locateSlot(id: string, target: LocateTarget = {}, listing?: ListingCheck): Promise<LocatedSlot | undefined> {
    const global: ScopeDir = { dir: this.globalDir, loc: { scope: 'global' } }
    if (isScopeTarget(target)) {
      const own = target.kind === 'global' ? [global] : await this.hintDirs(target.workspacePath)
      const copies = await this.scanForId(id, own)
      return copies.length > 0 ? { ...pickLiveFirst(copies)!, copies } : undefined
    }
    // 先挑在用副本：别的作用域里更新的已删副本不遮住它，遗忘、刷新改的才是读路径上看得到的那份
    const pick = (copies: Slot[]) => copies.length > 0 ? { ...pickLiveFirst(copies, target)!, copies } : undefined
    const hinted = target.workspacePath === undefined ? [] : await this.hintDirs(target.workspacePath)
    const first = await this.scanForId(id, [global, ...hinted], false, listing)
    if (first.length > 0) return pick(first)
    const scanned = new Set([this.globalDir, ...hinted.map(d => d.dir)])
    const dirListing = await this.listWorkspaceDirs()
    if (listing !== undefined && !isListed(dirListing.directoryNotes)) listing.isListed = false
    const rest = dirListing.entries
      .filter(e => !scanned.has(e.dir))
      .map(e => ({ dir: e.dir, loc: { scope: 'workspace', workspacePath: e.workspacePath } as FileLocation }))
    return pick(await this.scanForId(id, rest, false, listing))
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

  /**
   * 指向 id 的链接（见 MemoryTable.linksTo）。每一层列目录、逐个文件取 stat 签名，和派生库记着的比：新出现的、签名变了的重读，
   * 不在了的去掉，再按核对过的行回答。没有派生库（或库不可用）时每个文件都读，结果相同。
   * 目录读不了、有文件读不出的，结果标成不完整。不加锁：读到的是这一刻的文件。
   * 不在写锁里，核对结果不写回库（写回会拿列目录时的旧名单盖掉并发写入刚记下的）；只在发现读不全时让这一层的核对标记作废。
   */
  async linksTo(id: string, dirs: readonly string[]): Promise<LinkQuery> {
    const { scopeDirs, directoryNotes } = await this.resolveDirs([...new Set(dirs)])
    const refs: LinkRef[] = []
    let isComplete = !directoryNotes.some(isIncompleteNote)
    for (const { dir, loc } of scopeDirs) {
      for (const level of [dir, join(dir, ARCHIVE_DIR)]) {
        const verified = await this.verifiedRefsTo(id, level, dir, loc, false)
        if (!verified.isComplete) isComplete = false
        refs.push(...verified.refs)
      }
    }
    return { refs: sortLinkRefs(refs), isComplete }
  }

  /** 一层里指向 id 的链接，按文件签名核对过（见 verifiedLinkRows）。 */
  private async verifiedRefsTo(id: string, level: string, dir: string, loc: FileLocation, isLocked: boolean): Promise<{ refs: LinkRef[]; isComplete: boolean }> {
    const verified = await this.verifiedLinkRows(level, dir, loc, isLocked)
    const refs: LinkRef[] = []
    for (const row of verified.rows) {
      if (row.sourceId === null) continue
      for (const link of row.links) {
        if (link.targetId === id) refs.push({ sourceId: row.sourceId, kind: link.kind, ...(link.digest !== undefined ? { digest: link.digest } : {}) })
      }
    }
    return { refs, isComplete: verified.isComplete }
  }

  /**
   * 指向 id 的链接，只按派生库的目标索引查（见 MemoryTable.indexedLinksTo）：核对过的层不列目录、不取文件签名。
   * 还没核对过的层（新机器、删库之后、整份核对还没轮到的项目）这一次按签名核对一遍，顺带记下核对过，以后就只查索引。
   * 没有派生库、库这一次用不了时退回 linksTo。目录、文件读不全时结果标成不完整。
   * 在写入段里跑（调用方已在段里就是段内再进）：核对结果写回库时，不会有并发的写入在列目录和写回之间插进来。
   */
  indexedLinksTo(id: string, dirs: readonly string[]): Promise<LinkQuery> {
    return this.lock.run(() => this.indexedLinksToLocked(id, dirs))
  }

  private async indexedLinksToLocked(id: string, dirs: readonly string[]): Promise<LinkQuery> {
    if (this.index === undefined) return this.linksTo(id, dirs)
    const { scopeDirs, directoryNotes } = await this.resolveDirs([...new Set(dirs)])
    const levels = scopeDirs.flatMap(({ dir, loc }) => [dir, join(dir, ARCHIVE_DIR)].map(level => ({ level, dir, loc })))
    const found = this.index.linksToTarget(id, levels.map(l => l.level))
    if (found === undefined) return this.linksTo(id, dirs)
    const unreconciled = new Set(found.unreconciled)
    const refs: LinkRef[] = found.refs.filter(r => !unreconciled.has(r.level)).map(({ level: _level, ...ref }) => ref)
    let isComplete = !directoryNotes.some(isIncompleteNote)
    for (const { level, dir, loc } of levels.filter(l => unreconciled.has(l.level))) {
      const verified = await this.verifiedRefsTo(id, level, dir, loc, true)
      if (!verified.isComplete) isComplete = false
      refs.push(...verified.refs)
    }
    return { refs: sortLinkRefs(refs), isComplete }
  }

  /**
   * 一层里每个记忆文件的链接行，按文件签名核对过：记着的签名和文件现在的一样才用，其余重读。目录读不了、有文件读不出时 isComplete 为假。
   * isLocked：调用方在写锁里，才把核对结果写回库、记下核对过；不在锁里只读（读不全时让核对标记作废，只往保守方向走）。
   */
  private async verifiedLinkRows(level: string, dir: string, loc: FileLocation, isLocked: boolean): Promise<{ rows: LinkFileRow[]; isComplete: boolean }> {
    const listed = await this.listMemoryFiles(level)
    if ('note' in listed) {
      // 目录读不了：库里这一层记着的不再算核对过
      this.index?.doubtLinkLevel(level)
      return { rows: [], isComplete: false }
    }
    const names = listed.names.sort()
    // 刚被删、不是普通文件的记空串；别的错（没有权限）记 undefined，这一层不算读全
    const sigs = await Promise.all(names.map(name => stat(join(level, name)).then(
      st => (st.isFile() ? sigOf(st) : ''), (err: unknown) => (errnoCode(err) === 'ENOENT' ? '' : undefined),
    )))
    const known = new Map((this.index?.linkRows(level) ?? []).map(r => [r.name, r]))
    const rows: LinkFileRow[] = []
    const fresh: LinkFileRow[] = []
    let isComplete = true
    for (const [i, name] of names.entries()) {
      const sig = sigs[i]
      if (sig === undefined) { isComplete = false; continue }
      if (sig === '') continue   // 刚被删、不是普通文件
      const kept = known.get(name)
      if (kept !== undefined && kept.sig === sig) { rows.push(kept); continue }
      const read = await this.readMemoryFile(join(level, name), dir, loc, NO_PREFILTER, new Map())
      // 读不出、解析不了的文件里可能有链接：不当成没有
      if (read !== undefined && 'quarantined' in read) { isComplete = false; continue }
      // 签名取在读内容之前：读的途中又被改过，下次核对签名对不上再重读
      const row = linkRowOf(name, read !== undefined ? read.slot.statSig : sig, read?.slot.record)
      rows.push(row)
      fresh.push(row)
    }
    // 没读全：原来记着的核对作废
    if (!isComplete) this.index?.doubtLinkLevel(level)
    if (!isLocked) return { rows, isComplete }
    const present = new Set(names)
    const removed = [...known.keys()].filter(name => !present.has(name))
    // 整层都核对到了：库里补完就是整层的样子，没记过核对的这次记上
    const isNewlyWhole = isComplete && this.index?.isLinkLevelReconciled(level) === false
    if (fresh.length > 0 || removed.length > 0 || isNewlyWhole) this.index?.patchLinks(level, removed, fresh, isComplete)
    return { rows, isComplete }
  }

  /**
   * 写入方把自己动到的文件的链接直接记进派生库：删掉、搬走的去掉；写下的文件重读一遍，签名和链接出自读到的同一份内容
   * （提交之后、记链接之前文件被手改过，记下的就是手改后的样子，不会把新签名配上提交时的链接）。读不出的这一条不记，留给查询时按签名核对。
   */
  private async noteLinks(changes: ReadonlyArray<{ path: string; id?: string }>, key: string, loc: FileLocation): Promise<void> {
    const index = this.index
    if (index === undefined) return
    for (const change of changes) {
      const level = dirname(change.path)
      const name = basename(change.path)
      if (change.id === undefined) { index.patchLinks(level, [name], []); continue }
      if (change.id !== key) continue
      const read = await this.readMemoryFile(change.path, layerDirOf(level), loc, NO_PREFILTER, new Map())
      if (read === undefined || 'quarantined' in read) {
        index.patchLinks(level, [name], [])
        // 刚写下的文件读不出：它的链接不知道，这一层不再算核对过
        if (read !== undefined) index.doubtLinkLevel(level)
        continue
      }
      index.patchLinks(level, [], [linkRowOf(name, read.slot.statSig, read.slot.record)])
    }
  }

  // —— 写侧（锁内）——

  async maintain(dirs: string[]): Promise<void> {
    await this.locked(() => this.maintainDirs(dirs))
  }

  /**
   * 维护点（快照冻结时调用；锁内，只动给定目录，幂等）。写路径末尾不做：它的开销和目录大小成正比，写入只处理自己动到的文件
   * （见 persist）。每个目录读顶层 + .archive/ 一遍，逐文件：
   *  - .archive/ 里 status 仍为 active 的按位置归一成 deleted（位置即作用域，不搬回顶层）；deleted 缺 deletedAt 用 mtime 补
   *  - ③ .archive/ 里 deletedAt 超保留期的物理删除，哪层都没有这个 id 了才清召回统计行（superseded 不清）
   *  - ④ 手建 / 手编回写：digest 认识且不匹配 → updatedAt 与 lastConfirmedAt 取 mtime；缺 id / 缺 digest / 时间戳形态 /
   *    缺省字段由重新 encode 补齐；判「有变化」= 重新 encode 后与磁盘原文逐字节比较，不同才写；顶层含保留键的文件不回写
   *  - ② 顶层非 active 的搬进 .archive/（撞名追加 id 片段）；已过期的 active 文件不动
   *  - ① 核对主题索引（_index/）：没进索引的在用记忆补进「未整理」，已不在的条目去掉，名称和摘要按记忆同步；
   *    再按索引重写 MEMORY.md。已过期的在用记忆照列。内容不变不写；写之前文件被别人改过就重读重算
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
      const { slots, quarantined, directoryNotes } = await this.readDirs([sd], { includeArchive: true }, seen)
      // 这一层（顶层和 .archive/）列不出来时，清归档、删召回统计、核对索引都不做：没读到的不能当没有
      const isLayerListed = isListed(directoryNotes)
      // 这一层每个文件都读出来了：没读到某个 id 才能说明这一层没有它
      const isLayerComplete = isLayerListed && quarantined.length === 0
      const isExpired = (slot: Slot) => dirname(slot.filePath) === archive && slot.record.status !== 'superseded'
        && (slot.record.deletedAt ?? slot.mtimeMs) < cutoff
      // 到期清扫之后这一层还留着的 id：同 id 还有别的副本，历史是那一份的
      const staying = new Set(slots.filter(s => !isExpired(s)).map(s => s.record.id))
      for (const [i, level] of [sd.dir, archive].entries()) {
        const at = levelStats[i]
        // 列不出目录的那一层没读到文件，不能记成「这一层没有文件」：原有的提示不动
        if (at === undefined || directoryNotes.some(n => isIncompleteNote(n) && n.path === level)) continue
        const rows = slots.filter(s => dirname(s.filePath) === level).map(s => [basename(s.filePath), s.record.id, s.statSig] as const)
        // 文件名列表的摘要不知道（读目录时不留名单）：记空串，下次目录有变时逐个核对一遍再补上
        this.index?.replaceLevel(level, { ...at, scannedAt, listing: '' }, rows, priorRevs[i])
      }
      // 链接反向索引整层重记：手改文件加的关联、旧版本写下的都按这次读到的补进来。
      // 没读全（有文件读不出、目录读不了）时不整层重记，原来记着的核对作废，按目标查时再按文件核对
      for (const level of [sd.dir, archive]) {
        if (isLayerComplete) this.index?.replaceLinks(level, slots.filter(s => dirname(s.filePath) === level).map(s => linkRowOf(basename(s.filePath), s.statSig, s.record)))
        else this.index?.doubtLinkLevel(level)
      }
      const kept: LocatedRecord[] = []
      const purged = new Set<Slot>()
      for (const slot of slots) {
        const inArchive = dirname(slot.filePath) === archive
        let record = slot.record
        if (inArchive && record.status === 'active') record = { ...record, status: 'deleted' }
        if (record.status === 'deleted' && record.deletedAt === undefined) record = { ...record, deletedAt: slot.mtimeMs }
        if (isExpired(slot)) {
          if (!isLayerListed || !(await this.unchangedSince(slot))) continue
          // 历史先删、删干净了才删记忆文件，不留记忆没了、历史还在的样子；删不掉或拿不准就这条这次不清，下次维护再试
          // 并进了另一条的：历史先搬到那条名下，搬不成这条这次不清
          // 这一层读不全、又有它的历史时两样都不做：坏掉的可能就是同 id 还在用的那份，历史是那份的
          if (!staying.has(record.id) && !(await this.isHistoryOwnerKnown(record.id, sd.dir, isLayerComplete))) continue
          if (!staying.has(record.id) && !(await this.carryHistory(record, sd.dir))) continue
          if (!staying.has(record.id) && !(await this.removeExpiredHistory(record.id, sd.dir, isLayerComplete))) continue
          await this.removeFile(slot.filePath)
          purged.add(slot)
          // 同 delete：别层还有这个 id 时统计行是它的。只在真删过期文件时全盘找一次，平常的维护不多读；
          // 找的这一轮有哪一层列不出来时找不到也不算没有，统计行留着
          const lookup: ListingCheck = { isListed: true }
          if ((await this.locateSlot(record.id, {}, lookup)) === undefined && lookup.isListed) await this.opts.stats.delete(record.id)
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
      // 核对这一层其余的历史目录
      await this.reconcileHistory(sd, new Set(slots.filter(s => !purged.has(s)).map(s => s.record.id)))
      // kept 只剩顶层 active（非 active 已搬走）。整份核对主题索引，再从索引生成 MEMORY.md。
      // 别的进程可能在本轮读目录之后写进同一目录，按旧清单核对会把它刚加的记忆漏在索引外：写了就比一次顶层签名
      // （只 readdir + stat），变了才重读顶层、按新清单再核对，最多 INDEX_ROUNDS 次。插件的写都经 tmp + rename 落盘，
      // 别处增删改都会改变名字、大小或 mtime；手编也改 mtime。核对结果只由索引和清单决定，最后一轮以写后的目录为准
      let signature = signatureOf(seen)
      let located: readonly LocatedRecord[] = kept
      // 这一层有读不出来的文件时，索引里对不上清单的行先留着（见 reconcileIndex）
      let isComplete = isLayerComplete
      // 顶层列不出来时读到的在用记忆是空的：按它核对会把索引和 MEMORY.md 写成缺了的样子，这一层不核对
      let isTopListed = isLayerListed
      for (let round = 1; isTopListed && round <= INDEX_ROUNDS; round++) {
        const outcome = await this.syncTopicIndex(sd.dir, located, now, isComplete)
        if (outcome === 'unchanged' || round === INDEX_ROUNDS) break
        // 索引文件在核对期间被改过的那一轮什么都没写，直接按现在的内容重来
        if (outcome === 'written' && await this.topLevelSignature(sd.dir) === signature) break
        const fresh = new Map<string, string>()
        const reread = await this.readDirs([sd], {}, fresh)
        signature = signatureOf(fresh)
        located = reread.slots.filter(s => s.record.status === 'active')
        isTopListed = isListed(reread.directoryNotes)
        isComplete = isTopListed && reread.quarantined.length === 0
      }
      for (const level of [sd.dir, archive, join(sd.dir, INDEX_DIR), join(sd.dir, INDEX_DIR, INDEX_TOPICS_DIR)]) await this.cleanStaleTmp(level)
    }
  }

  /**
   * 整份核对历史版本：这一层里有历史目录、记忆却已不在这一层（顶层和 .archive/ 都没有）的，按解析出的 id 到各个作用域（含 .archive/）找：
   * 只在另一层找到就把目录迁过去，哪里都找不到才清掉。旧版本删了记忆、旧版本搬家只搬了记忆文件、换作用域中途断掉又没有操作日志，
   * 都靠这里收拾。拿不准的时候不动：有目录读不了、缺标记，有记忆文件读不出、解析不了（可能就是这条），或几层都有这个 id；
   * 写锁不跨进程互斥时也不动（另一个进程可能正把这条记忆搬进搬出，两次读目录都看不到它）。
   * 拿不准的这个进程里记下不再查，一个目录出错只跳过它。present：这一层此刻有的记忆 id。
   */
  private async reconcileHistory(own: ScopeDir, present: ReadonlySet<string>): Promise<void> {
    if (this.lock.isExclusive?.() === false) return
    const { dir } = own
    const memo = (id: string) => `${dir}\n${id}`
    try {
      const orphans = (await this.history.memoryIds(dir)).filter(id => !present.has(id) && !this.unresolvedOrphans.has(memo(id)))
      if (orphans.length === 0) return
      const layers = await this.idLayers(own)
      for (const id of orphans) {
        try {
          const homes = layers?.get(id)
          if (layers === undefined || homes?.has(dir) === true || (homes?.size ?? 0) > 1) this.unresolvedOrphans.add(memo(id))
          else if (homes === undefined) await this.history.removeAll(dir, id)
          else await this.history.move(dir, [...homes][0]!, id)
        } catch (err) {
          this.unresolvedOrphans.add(memo(id))
          this.log.warn(`[plastic-memory] 核对历史版本时 ${dir} 里的一个历史目录没处理成，这个进程里先不管它（${describeError(err)}）`)
        }
      }
    } catch (err) {
      this.log.warn(`[plastic-memory] 核对 ${dir} 的历史版本失败，下次维护再说（${describeError(err)}）`)
    }
  }

  /**
   * 各作用域（global、各项目目录和 own，各含 .archive/）里每个 id 在哪几层，按解析出的 id 认。
   * 读不全返回 undefined：有目录读不了、缺标记，或有记忆文件读不出、解析不了，缺的那份可能就是要找的。
   */
  private async idLayers(own: ScopeDir): Promise<Map<string, Set<string>> | undefined> {
    const listing = await this.listWorkspaceDirs()
    if (listing.directoryNotes.some(isIncompleteNote)) return undefined
    const dirs = new Map<string, ScopeDir>([[own.dir, own], [this.globalDir, { dir: this.globalDir, loc: { scope: 'global' } }]])
    for (const e of listing.entries) dirs.set(e.dir, { dir: e.dir, loc: { scope: 'workspace', workspacePath: e.workspacePath } })
    const read = await this.readDirs([...dirs.values()], { includeArchive: true })
    if (read.quarantined.length > 0 || read.directoryNotes.some(isIncompleteNote)) return undefined
    const layers = new Map<string, Set<string>>()
    for (const slot of read.slots) layers.set(slot.record.id, (layers.get(slot.record.id) ?? new Set<string>()).add(slot.dir))
    return layers
  }

  /** 这一层（顶层和 .archive/）有没有这个 id 的记忆，按解析出的 id 认。读不全返回 undefined。 */
  private async holdsCopy(dir: string, id: string): Promise<boolean | undefined> {
    const { scopeDirs, directoryNotes } = await this.resolveDirs([dir])
    if (directoryNotes.length > 0) return undefined
    if (scopeDirs.length === 0) return false   // 目录已经不在
    const read = await this.readDirs(scopeDirs, { includeArchive: true })
    if (read.quarantined.length > 0 || read.directoryNotes.some(isIncompleteNote)) return undefined
    return read.slots.some(slot => slot.record.id === id)
  }

  /** 物理删除前把带去向的记忆的历史并过去（见 carryMergedHistory）。搬不成记一笔、返回 false。 */
  private async carryHistory(record: MemoryRecord, dir: string): Promise<boolean> {
    try {
      await carryMergedHistory(this.history, record, dir, async (id, scope) => {
        const slot = await this.locateSlot(id, scope)
        if (slot !== undefined) return layerOf(this.toLocated(slot))
        // 没找到：确认那一层读得全才算没有。读不全时去向那条可能就是读不出的那个文件，不能当它不在把历史删了
        const layer = scope.kind === 'global' ? this.globalDir : (await this.hintDirs(scope.workspacePath))[0]?.dir
        if (layer !== undefined && (await this.holdsCopy(layer, id)) !== false) throw new Error(`${layer} 读不全，分不出记忆 ${id} 还在不在`)
        return undefined
      })
      return true
    } catch (err) {
      this.log.warn(`[plastic-memory] 一条并进别的记忆的历史版本没搬成，这条这次先不清（${describeError(err)}）`)
      return false
    }
  }

  /** 这一层的历史确实归这条到期的记忆：层读得全，或者这一层根本没有它的历史。拿不准记一笔、返回 false。 */
  private async isHistoryOwnerKnown(id: string, dir: string, isLayerComplete: boolean): Promise<boolean> {
    if (isLayerComplete || !(await this.history.memoryIds(dir).catch(() => [id])).includes(id)) return true
    this.log.warn(`[plastic-memory] ${dir} 里有读不出的记忆文件，到期的一条记忆和它的历史这次先不清`)
    return false
  }

  /**
   * 到期清扫一条记忆前先删它的历史（这一层已没有同 id 的别的副本）。这一层有读不出、解析不了的文件时，坏掉的可能就是同 id 还在用的那份：
   * 这一层有它的历史就不删，返回 false，记忆文件也先留着。返回历史是否都删干净了。
   */
  private async removeExpiredHistory(id: string, dir: string, isLayerComplete: boolean): Promise<boolean> {
    if (!(await this.isHistoryOwnerKnown(id, dir, isLayerComplete))) return false
    return this.removeOwnedHistory(id, new Set(isLayerComplete ? [dir] : []), false)
  }

  /**
   * 删掉一条物理删除了的记忆在各层的历史，含它以前住过的层（旧版本搬家只搬了记忆文件）。cleared：这次删除清空了这个 id 的层，直接删。
   * 别的层里还有这个 id 的在用或已删副本时，那里的历史是那一份的，不动。
   * 拿不准（记忆根目录列不出来、某层读不全）或删不掉时：isStrict 就抛错，彻底删除要在删记忆文件之前知道；否则记一笔，返回 false。
   */
  private async removeOwnedHistory(id: string, cleared: ReadonlySet<string>, isStrict: boolean): Promise<boolean> {
    if (id === '') return true   // 空 id 的记忆不留历史
    let isClean = true
    const fail = (err: unknown) => {
      if (isStrict) throw err
      isClean = false
      this.log.warn(`[plastic-memory] 一条记忆的历史版本没删干净，下次维护再说（${describeError(err)}）`)
    }
    const listing = await this.listWorkspaceDirs()
    if (listing.directoryNotes.some(n => n.path === this.opts.root)) {
      fail(new Error(`记忆根目录列不出来，分不出这条记忆以前住过哪些层：${this.opts.root}`))
      return false
    }
    // 读不了、缺标记的项目目录也看：它的 .history/ 里可能有
    const layers = new Set([this.globalDir, ...cleared, ...listing.entries.map(e => e.dir), ...listing.directoryNotes.filter(isIncompleteNote).map(n => n.path)])
    for (const layer of layers) {
      try {
        if (!(await this.history.memoryIds(layer)).includes(id)) continue
        if (!cleared.has(layer)) {
          const holds = await this.holdsCopy(layer, id)
          if (holds === true) continue
          if (holds === undefined) throw new Error(`${layer} 读不全，分不出那里的历史版本是不是这条记忆的`)
        }
        await this.history.removeAll(layer, id)
      } catch (err) {
        fail(err)
      }
    }
    return isClean
  }

  /**
   * 换作用域后把历史版本跟过去（写入当场和中断后补做共用）。源头那一层又有了这个 id 的在用或已删副本（补做前那里另建了同 id 的一条），
   * 或读不全分不出来时不搬：那里的历史可能已经是那一条的，留给整份核对。
   */
  private async followMove(step: HistoryMoveStep): Promise<void> {
    if (!(await this.history.memoryIds(step.from)).includes(step.memoryId)) return
    if ((await this.holdsCopy(step.from, step.memoryId)) !== false) {
      this.log.warn(`[plastic-memory] ${step.from} 里还有同 id 的记忆，历史版本先不搬，留给整份核对`)
      return
    }
    await this.history.move(step.from, step.to, step.memoryId)
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

  /**
   * 整份核对这个目录的主题索引，再从索引生成 MEMORY.md；返回有没有写文件。失败不致命：索引和投影下次维护再补。
   * 有一行的是顶层在用、已进主档的记忆（同 id 取一份）：已过期的、还没生效的照样有；子 agent 存下、还没接受的没有。
   * 主题名、主题说明这些手写的文字落盘前遮一遍密钥；成员行出自记忆自己的名称和摘要，不在这里遮。
   */
  /** 把核对好的主题索引记进派生库：哪条记忆在哪一页、各页的主题名和曾用名，带各页文件此刻的签名。和记着的一样就不写。 */
  private async recordTopicPages(dir: string, files: IndexFiles): Promise<void> {
    const index = this.index
    if (index === undefined) return
    const { topics, unsorted } = readIndex(files)
    const listed = topics.map(t => ({ page: t.fileName, title: t.name, aliases: [...new Set(t.aliases)], memberIds: [...new Set(t.memberIds)] }))
    if (files.pages[UNSORTED_PAGE] !== undefined) listed.push({ page: UNSORTED_PAGE, title: UNSORTED_TITLE, aliases: [], memberIds: [...new Set(unsorted)] })
    // 签名要和记下的内容出自同一份文件：取签名、读内容、再取一次签名，内容不是要记的那份或前后签名不同就记空签名
    // （空签名和任何文件都对不上，用的人会当这一行不可信）
    const rows: TopicPageRow[] = await Promise.all(listed.map(async p => {
      const filePath = join(dir, INDEX_DIR, INDEX_TOPICS_DIR, p.page)
      const sigNow = () => stat(filePath).then(s => sigOf(s), () => '')
      const sig = await sigNow()
      const text = await readFile(filePath, 'utf8').catch(() => undefined)
      return { ...p, sig: text === files.pages[p.page] && sig === await sigNow() ? sig : '' }
    }))
    // 两边各自排好再比：库按字节序给，这里按码元序，直接比会在少数页名上总是不等
    const shape = (list: readonly TopicPageRow[]) => JSON.stringify(list.map(p => [p.page, p.title, p.sig, p.aliases, p.memberIds]).sort((a, b) => (a[0]! < b[0]! ? -1 : 1)))
    if (shape(index.topicPages(dir)) !== shape(rows)) index.replaceTopicPages(dir, rows)
  }

  /**
   * 核对一个目录的主题索引并再生 MEMORY.md。返回 written（写了东西）、unchanged（一点没变）、
   * retry（索引文件在核对期间被改过，或这次没核对成：什么都没盖，下一轮按现在的内容重来）。
   */
  /**
   * 一条记忆搬出了这个目录（换了作用域，或这里的重复副本被清掉）：当场把它的行从这里的索引去掉，不等这个目录下次维护。
   * 之后彻底删除它时，别的目录里就不会还留着它的名称和摘要。
   */
  private async dropIndexMember(dir: string, id: string): Promise<void> {
    try {
      const before = await readIndexFiles(dir)
      if (before === undefined) return
      const next = withoutMember(before, id)
      const written = await writeIndexFiles(dir, before, next, (filePath, text) => this.atomicWrite(filePath, text))
      if (written.length > 0) await this.recordTopicPages(dir, next)
    } catch (err) {
      this.log.warn(`[plastic-memory] 没能把搬走的记忆从原目录的主题索引里去掉，等这个目录下次维护（${describeError(err)}）`)
    }
  }

  /** 落盘前遮一遍手写的文字：入口整份遮，主题页留着成员行。 */
  private maskIndex(files: IndexFiles): IndexFiles {
    return { entry: maskSecrets(files.entry), pages: Object.fromEntries(Object.entries(files.pages).map(([name, text]) => [name, maskIndexText(text, maskSecrets)])) }
  }

  /** 这个记忆目录里在索引中该有一行的记忆 id。目录读不了（没有标记、不存在）返回 undefined。 */
  private async indexedIds(dir: string): Promise<Set<string> | undefined> {
    const { scopeDirs } = await this.resolveDirs([dir])
    if (scopeDirs.length === 0) return undefined
    const read = await this.readDirs(scopeDirs, {})
    return new Set(resolveDuplicates(read.slots.filter(s => this.hasIndexRow(s))).map(l => l.record.id))
  }

  /** 读索引；masked 为真时和写入路径共用手写文字的密钥遮盖规则。 */
  async readIndex(dir: string, masked = false): Promise<IndexFiles | undefined> {
    const files = await readIndexFiles(dir)
    return masked && files !== undefined ? this.maskIndex(files) : files
  }

  /**
   * 对一个记忆目录的主题索引做一个操作（归主题、改名、合并、调顺序、改说明）。在写入段里按当下的索引和记忆重新核对：
   * 对不上的跳过。先写计划里的第一个文件（带提交标记），写下就算提交；其余的页接着改，中途断了由下一个拿到写锁的人补完。
   * 模型交来的主题名和说明落盘前遮密钥。
   */
  async applyIndexOp(dir: string, op: IndexOp, opts: IndexOpOptions): Promise<IndexOpOutcome> {
    return this.locked(async () => {
      const safe = maskOp(op)
      for (let round = 1; round <= INDEX_ROUNDS; round++) {
        const raw = await readIndexFiles(dir)
        const activeIds = await this.indexedIds(dir)
        if (raw === undefined || activeIds === undefined) return { kind: 'skipped', reason: '这个目录还没有主题索引' }
        // 按遮过密钥的索引定计划：计划里带的改前文字（曾用名、说明、整页）会存进回执
        const before = this.maskIndex(raw)
        const planned = planIndexOp(before, safe, { maxTopics: opts.maxTopics, activeIds, now: this.now() })
        if (planned.kind === 'skipped') return planned
        const { plan } = planned
        const target = targetOf(plan)
        const next = this.maskIndex(applyPlan(before, plan).files)
        const id = newWriteOp().id
        const steps = [...(await opts.prepare?.(id, plan) ?? [])]
        // 日志里的计划只够再套一次：撤销用的改前全文不进日志
        const planStep: IndexPlanStep = { kind: INDEX_PLAN_STEP, dir, plan: planForReplay(plan) }
        if (this.isJournaling()) this.journal!.begin({ op: id, at: this.now(), target: { kind: 'index', dir, file: target }, steps: [planStep, ...steps] })
        try {
          const text = target === 'entry' ? next.entry : next.pages[target]!
          await replaceIndexFile(dir, target, target === 'entry' ? raw.entry : raw.pages[target], withStamp(text, id), (filePath, body) => this.atomicWrite(filePath, body))
        } catch (err) {
          this.endOp(id)
          if (err instanceof IndexChangedError) continue
          throw err
        }
        if (this.isJournaling()) this.journal!.markCommitted(id)
        // 提交之后的步骤没做成：行留在日志里，下一个进写入段的人补
        try {
          await this.finishIndexPlan(planStep)
          await this.runSteps(id, steps, undefined)
          this.endOp(id)
        } catch (err) {
          this.log.warn(`[plastic-memory] 索引操作 ${id} 提交后有一步没做成，留在日志里下次补做（${describeError(err)}）`)
        }
        return { kind: 'applied', op: id, plan }
      }
      return { kind: 'skipped', reason: '索引文件一直在被改，这一次没做' }
    })
  }

  /** 把计划在索引上套完：重读、再套一次、写下还没改的页、删掉该删的页，记进派生库。索引文件期间被改过就按新内容重来。 */
  private async finishIndexPlan(step: IndexPlanStep): Promise<void> {
    for (let round = 1; ; round++) {
      const raw = await readIndexFiles(step.dir)
      if (raw === undefined) return
      const applied = applyPlan(this.maskIndex(raw), step.plan)
      const next = this.maskIndex(applied.files)
      try {
        await writeIndexFiles(step.dir, raw, next, (filePath, text) => this.atomicWrite(filePath, text), applied.deleted)
        await this.recordTopicPages(step.dir, next)
        return
      } catch (err) {
        if (!(err instanceof IndexChangedError) || round === INDEX_ROUNDS) throw err
      }
    }
  }

  /**
   * 撤销一个做过的索引操作。按效果判：这一步写下的效果还在才撤（见 undoPlan），不在了返回 stale，什么都不动。
   * 和做的时候一样先写一个文件算提交，其余的文件按算的时候的样子补写。
   */
  async undoIndexPlan(dir: string, plan: IndexPlan, opts: { steps?: (op: string) => readonly OpStep[] } = {}): Promise<IndexUndoOutcome> {
    return this.locked(async () => {
      for (let round = 1; round <= INDEX_ROUNDS; round++) {
        const before = await readIndexFiles(dir)
        if (before === undefined) return { kind: 'stale', reason: '这个目录的主题索引不在了' }
        const result = undoPlan(this.maskIndex(before), plan)
        if (result.kind === 'stale') return result
        const id = newWriteOp().id
        const next = this.maskIndex(result.files)
        // 先写多出成员的页（和新放回来的页），再写别的页，入口最后：中途断在哪，记忆都至少在一页里
        const changed = Object.keys(next.pages).filter(name => next.pages[name] !== before.pages[name])
        const count = (name: string, text: string | undefined) => {
          if (text === undefined) return 0
          const read = readIndex({ entry: '', pages: { [name]: text } })
          return name === UNSORTED_PAGE ? read.unsorted.length : read.topics[0]?.memberIds.length ?? 0
        }
        const gained = (name: string) => count(name, next.pages[name]) - count(name, before.pages[name])
        const files = [...changed.sort((a, b) => gained(b) - gained(a)), ...(next.entry !== before.entry ? ['entry'] : [])]
        const writes = files.map((file, i) => {
          const was = file === 'entry' ? before.entry : before.pages[file]
          const text = file === 'entry' ? next.entry : next.pages[file]!
          return { file, before: was === undefined ? null : fingerprintOf(was), text: i === 0 ? withStamp(text, id) : text }
        })
        const deletes = result.deleted.map(file => ({ file, before: fingerprintOf(before.pages[file]!) }))
        if (writes.length === 0) return { kind: 'stale', reason: '没有可撤的改动' }
        // 日志里的页面文字不带成员行（只留记忆 id），补写时按那时索引里的成员行填回去
        const step: IndexWriteStep = { kind: INDEX_WRITE_STEP, dir, writes: writes.map(w => ({ ...w, text: withoutMemberText(w.text) })), deletes }
        const steps = [...(opts.steps?.(id) ?? [])]
        const first = writes[0]!
        if (this.isJournaling()) this.journal!.begin({ op: id, at: this.now(), target: { kind: 'index', dir, file: first.file }, steps: [step, ...steps] })
        try {
          await replaceIndexFile(dir, first.file, first.file === 'entry' ? before.entry : before.pages[first.file], first.text, (filePath, body) => this.atomicWrite(filePath, body))
        } catch (err) {
          this.endOp(id)
          if (err instanceof IndexChangedError) continue
          throw err
        }
        if (this.isJournaling()) this.journal!.markCommitted(id)
        try {
          await this.finishIndexWrites(step)
          await this.runSteps(id, steps, undefined)
          this.endOp(id)
        } catch (err) {
          this.log.warn(`[plastic-memory] 撤销索引操作 ${id} 提交后有一步没做成，留在日志里下次补做（${describeError(err)}）`)
        }
        return { kind: 'undone', op: id }
      }
      return { kind: 'stale', reason: '索引文件一直在被改，这一次没撤' }
    })
  }

  private async finishIndexWrites(step: IndexWriteStep): Promise<void> {
    await mkdir(join(step.dir, INDEX_DIR, INDEX_TOPICS_DIR), { recursive: true })
    const now = await readIndexFiles(step.dir)
    const lines = now === undefined ? new Map<string, string>() : memberLines(now)
    // 这一步里每条记忆该在哪个文件。一条记忆确实成了那个文件的成员，才从别的文件拿掉：
    // 那个文件算完之后被改过（成员行落进了代码块、页被删了）时，它留在原处，等整份核对安排
    const homes = new Map(step.writes.map(w => [w.file, new Set(placeholderIds(w.text))]))
    const homeOf = new Map([...homes].flatMap(([file, ids]) => [...ids].map(id => [id, file] as const)))
    const hasArrived = async (id: string) => memberKeys(await readIndexFile(step.dir, homeOf.get(id)!) ?? '').includes(id)
    /** 这个文件里现在的成员中，按这一步该去别的文件、而且确实已经到了的。 */
    const departed = async (file: string, current: string) => {
      const gone = new Set<string>()
      for (const id of memberKeys(current)) if (homeOf.has(id) && homeOf.get(id) !== file && await hasArrived(id)) gone.add(id)
      return gone
    }
    const leaving = (file: string, current: string) => memberKeys(current).filter(id => homeOf.has(id) && homeOf.get(id) !== file)
    for (const stored of step.writes) {
      const w = { ...stored, text: withMemberText(stored.text, id => lines.get(id)) }
      const current = await readIndexFile(step.dir, w.file)
      if (current === w.text) continue
      const isAsComputed = w.before === null ? current === undefined || (w.file === 'entry' && current === '') : current !== undefined && fingerprintOf(current) === w.before
      const gone = current === undefined ? new Set<string>() : await departed(w.file, current)
      if (isAsComputed && gone.size === leaving(w.file, current ?? '').length) {
        await this.atomicWrite(indexFilePath(step.dir, w.file), w.text)
        continue
      }
      if (w.file === 'entry' || current === undefined) {
        this.log.warn(`[plastic-memory] 撤销索引操作时有一个文件已经被改过，没有盖它：${w.file}`)
        continue
      }
      // 这一页、或者它的成员要去的页算完之后被改过：留着现在的内容，只把成员挪对
      const kept = withoutMemberKeys(current, gone)
      const present = new Set(memberKeys(kept))
      const next = withMemberLinesAppended(kept, [...homes.get(w.file)!].filter(id => !present.has(id)).flatMap(id => lines.get(id) ?? []))
      if (next !== current) await this.atomicWrite(indexFilePath(step.dir, w.file), next)
    }
    for (const d of step.deletes) {
      const current = await readIndexFile(step.dir, d.file)
      if (current === undefined) continue
      const gone = await departed(d.file, current)
      if (fingerprintOf(current) === d.before && gone.size === leaving(d.file, current).length) {
        await rm(indexFilePath(step.dir, d.file), { force: true })
        continue
      }
      // 要删的页被改过、或者它的成员没都到别处：页留着，只拿掉确实到了别处的成员
      const next = withoutMemberKeys(current, gone)
      if (next !== current) await this.atomicWrite(indexFilePath(step.dir, d.file), next)
    }
    const after = await readIndexFiles(step.dir)
    if (after !== undefined) await this.recordTopicPages(step.dir, after)
  }

  /** 这个操作是不是还在操作日志里等着补做（提交了、后面的步骤没走完）。没有操作日志时没有补做，一律为否。 */
  isOpPending(op: string): boolean {
    return this.isJournaling() && this.journal!.pending().some(row => row.op === op)
  }

  /** 操作日志里还等着补做的步骤有没有一个对得上 match。没有操作日志时没有补做，一律为否。 */
  hasPendingStep(match: (step: OpStep) => boolean): boolean {
    return this.isJournaling() && this.journal!.pending().some(row => Array.isArray(row.steps) && row.steps.some(match))
  }

  /** 带着 op 的那次写入里，自己的 kind 那一步当场没做成（见 MemoryTable.hasUnfinishedOwnStep）。 */
  hasUnfinishedOwnStep(op: string, kind: string): boolean {
    return this.unfinishedOwn.get(op)?.some(step => step.kind === kind) ?? false
  }

  /** 单条写入只读自己的记录；重放按磁盘现状归行，不使用日志中的旧内容。 */
  private async placeIndexRow(step: IndexRowStep): Promise<void> {
    let carried: string | undefined
    if (step.topic?.kind === 'carry' && step.dirs[1] !== undefined) {
      const source = await readIndexFiles(step.dirs[1])
      if (source) carried = orderedPages(this.maskIndex(source)).find(t => t.memberIds.includes(step.memoryId))?.name
    }
    for (const [position, dir] of step.dirs.entries()) {
      let raw = await readIndexFiles(dir)
      const intent = position === 0 ? step.topic : undefined
      if (step.isPurge && raw === undefined) {
        try { await stat(join(dir, INDEX_FILE)) } catch (err) { if (errnoCode(err) === 'ENOENT') continue; throw err }
      }
      if (!step.isPurge && raw === undefined && !(intent?.kind === 'choose'
        && resolveTopic({ entry: '# 记忆索引\n', pages: {} }, intent.name, intent.maxTopics).kind === 'new')) continue
      const { scopeDirs } = await this.resolveDirs([dir])
      const sd = scopeDirs[0]
      if (sd === undefined) throw new Error(`记忆目录无法解析：${dir}`)
      let done = false
      for (let round = 0; round < INDEX_ROUNDS; round++) {
        if (round > 0) raw = await readIndexFiles(dir)
        if (step.isPurge) {
          const read = await this.readDirs([sd], {})
          if (!isListed(read.directoryNotes)) throw new Error('记忆目录读不出')
          const result = await this.syncTopicIndex(
            dir, read.slots.filter(s => s.record.status === 'active'),
            this.now(), read.quarantined.length === 0, step.memoryId,
          )
          if (result !== 'retry') { done = true; break }
          continue
        }
        const scope: Scope = sd.loc.scope === 'global'
          ? { kind: 'global' } : { kind: 'workspace', workspacePath: sd.loc.workspacePath! }
        const slot = await this.locateSlot(step.memoryId, scope)
        const live = slot !== undefined && slot.dir === dir && this.hasIndexRow(slot)
        let files = raw === undefined ? { entry: '# 记忆索引\n', pages: {} } : this.maskIndex(raw)
        if (files.entry.trim() === '') files = { ...files, entry: '# 记忆索引\n' }
        const target = intent?.kind === 'choose' ? resolveTopic(files, intent.name, intent.maxTopics)
          : carried !== undefined && position === 0 ? resolveTopic(files, carried, Infinity) : undefined
        if (raw === undefined && !(live && intent?.kind === 'choose' && target?.kind === 'new')) {
          done = true
          break
        }
        if (!live) files = withoutMember(files, step.memoryId)
        else if (position === 0) {
          const line = memberLine({
            id: step.memoryId, name: maskSecrets(slot.record.name),
            summary: maskSecrets(slot.record.summary), fileName: basename(slot.filePath),
          })
          const key = memberKey(step.memoryId)
          let placed: IndexFiles | undefined
          if (target?.kind === 'existing' || (target?.kind === 'new' && intent?.kind === 'choose')) {
            const proposed = this.insertIndexRow(
              files, target.fileName, target.name, line, step.memoryId,
              intent?.kind === 'choose' ? intent.about : undefined,
            )
            // 插入候选已去掉其他页的旧行，认得到就说明目标页放得进去。
            if (memberLines(proposed).has(key)) placed = proposed
          }
          if (placed !== undefined) files = placed
          else {
            const existing = memberLines(files)
            if (existing.has(key)) {
              const pages = { ...files.pages }
              for (const [page, text] of Object.entries(pages)) {
                if (!memberKeys(text).includes(key)) continue
                pages[page] = scan(text).map(row => !row.isCode && MEMBER_RE.exec(row.line)?.[2] === key
                  ? line + (row.line.endsWith('\r') ? '\r' : '') : row.line).join('\n')
              }
              files = { ...files, pages }
            } else {
              const proposed = this.insertIndexRow(files, UNSORTED_PAGE, UNSORTED_TITLE, line, step.memoryId)
              if (memberLines(proposed).has(key)) files = proposed
            }
          }
        }
        try {
          const written = await writeIndexFiles(dir, raw, files, (path, text) => this.atomicWrite(path, text))
          if (written.length > 0) await this.recordTopicPages(dir, files)
          done = true
          break
        } catch (err) { if (!(err instanceof IndexChangedError)) throw err }
      }
      if (!done) throw new Error('主题索引持续变化，稍后补做')
    }
  }

  /** 去掉旧行后共用建页和入口格式，把现算的成员行放到最前；调用方确认它没有落进代码围栏才采用。 */
  private insertIndexRow(files: IndexFiles, page: string, name: string, line: string, id: string, about?: string): IndexFiles {
    const stripped = withoutMember(files, id)
    const next = ensureTopicPage(stripped, {
      page, name, about: isAbout(about ?? '') ? about : '',
      ...(page === UNSORTED_PAGE ? {} : { createdAt: this.now() }),
    })
    if (page === UNSORTED_PAGE) next.entry = files.entry
    next.pages[page] = insertMembers(next.pages[page]!, [line], 0)
    return next
  }

  private hasIndexRow(slot: LocatedFile): boolean {
    const record = byPosition(slot)
    return dirname(slot.filePath) === slot.dir && record.status === 'active' && !isPendingDelegated(record)
  }

  private async syncTopicIndex(dir: string, active: readonly LocatedRecord[], now: number, isComplete: boolean, purgedId?: string): Promise<'written' | 'unchanged' | 'retry'> {
    try {
      const listed = resolveDuplicates(active).filter(l => !isPendingDelegated(l.record))
      // 手建的记忆文件名称、摘要里可能带着密钥：进索引的这一份先遮
      const members = listed.map((l): IndexedMemory => ({ id: l.record.id, name: maskSecrets(l.record.name), summary: maskSecrets(l.record.summary), fileName: basename(l.filePath) }))
      const before = await readIndexFiles(dir)
      // 清单读不全时仍清掉明确删除的成员；同层还有在用副本时保留主题归属。
      const remaining = before !== undefined && purgedId !== undefined && !members.some(m => m.id === purgedId) ? withoutMember(before, purgedId) : before
      const { files } = reconcileIndex(remaining, members, isComplete)
      const next = {
        entry: maskSecrets(files.entry),
        pages: Object.fromEntries(Object.entries(files.pages).map(([name, text]) => [name, maskIndexText(text, maskSecrets)])),
      }
      const written = await writeIndexFiles(dir, before, next, (filePath, text) => this.atomicWrite(filePath, text))
      const isStale = this.opts.isStale
      const staleIds = new Set(isStale === undefined ? [] : listed.filter(l => isStale(l.record, now)).map(l => l.record.id))
      const projection = renderProjection(next, staleIds)
      const prev = await readFile(join(dir, INDEX_FILE), 'utf8').catch(() => '')
      if (prev !== projection) await this.atomicWrite(join(dir, INDEX_FILE), projection)
      await this.recordTopicPages(dir, next)
      return written.length > 0 || prev !== projection ? 'written' : 'unchanged'
    } catch (err) {
      if (!(err instanceof IndexChangedError)) this.log.warn(`[plastic-memory] 主题索引这次没核对成，下次维护再补（${describeError(err)}）`)
      return 'retry'
    }
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
      // 占名成功后 tmp 仍在（link 多出的名字或复制的源）；rename 过的已不存在。清不掉不算写入失败：新文件已经落下，残留的临时文件由维护清
      await rm(tmp, { force: true }).catch(() => {})
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
      const previous = prev && byPosition(prev)
      const rowBefore = prev && this.hasIndexRow(prev) ? [prev.dir, maskSecrets(previous!.name), maskSecrets(previous!.summary), basename(prev.filePath)] : undefined
      const rowAfter = next.status === 'active' && !isPendingDelegated(next) ? [dir, maskSecrets(next.name), maskSecrets(next.summary), renamed ? '' : prev ? basename(prev.filePath) : ''] : undefined
      const indexRow: IndexRowStep | undefined = op.topic !== undefined || JSON.stringify(rowBefore) !== JSON.stringify(rowAfter)
        ? { kind: INDEX_ROW_STEP, memoryId: key, dirs: moved ? [dir, prev.dir] : [dir], topic: op.topic } : undefined
      const classified = classifyChange(previous, next)
      const recent: RecentChangeStep | undefined = classified && { kind: RECENT_CHANGE_STEP, ...classified, memoryId: key, session: currentWriteSession(), at: this.now() }
      const historyMove: HistoryMoveStep | undefined = moved ? { kind: HISTORY_MOVE_STEP, memoryId: key, from: prev.dir, to: dir } : undefined
      this.beginOp(op, {
        kind: 'write', memoryId: key, dir: level, fields: changedFields(prev?.record, next),
        ...(prev !== undefined ? { before: fingerprintOf(prev.raw) } : {}), after: fingerprintOf(text),
        ...(prev !== undefined && !isInPlace ? { source: { dir: dirname(prev.filePath), nameHash: fingerprintOf(basename(prev.filePath)) } } : {}),
      }, [...(historyMove === undefined ? [] : [historyMove]), ...(recent === undefined ? [] : [recent]), ...(indexRow === undefined ? [] : [indexRow])])
      let filePath: string
      // 文件已经带着提交标记落在目标目录里、不会再被撤回：在日志行上记一笔。之后文件被不拿锁的写（手改）换掉、标记没了，补做也认这次写成了
      const markCommitted = () => { if (this.isJournaling()) this.journal!.markCommitted(op.id) }
      if (prev !== undefined && isInPlace) {
        filePath = prev.filePath
        if (!(await this.unchangedSince(prev))) throw new StaleReadError()
        await this.atomicWrite(filePath, text)   // 自己的文件：rename 只覆盖同一记录自己的文件
        markCommitted()
      } else {
        if (prev !== undefined && !(await this.unchangedSince(prev))) throw new StaleReadError()
        await mkdir(level, { recursive: true })
        const claim = await this.claimAndWrite(next, level, text, prev?.copies ?? [])
        filePath = claim.path
        // 先写新后删旧；崩溃窗口由读路径的同 id 取舍兜底。占名可能落回原路径（候选名正被自己占着），
        // 路径比较忽略大小写：大小写不敏感文件系统上不能删掉刚写的自己。
        const isSourceLeft = prev !== undefined && prev.filePath.toLowerCase() !== filePath.toLowerCase()
        if (isSourceLeft && !(await this.unchangedSince(prev))) {
          await this.withdrawClaim(prev.filePath, claim, text)   // 占名期间旧文件被改或不见了：按规则撤回新文件，重来
          throw new StaleReadError()
        }
        // 记在删旧文件之前：旧文件一时删不掉，这次写入也已经成了，剩下的那份由补做清
        markCommitted()
        if (isSourceLeft) {
          await this.removeFile(prev.filePath)
          changes.push({ path: prev.filePath })
        }
      }
      // 两条分支都已写完目标并清掉旧文件，才让锁外发送点看到改动。
      if (recent !== undefined && this.isJournaling()) {
        const { kind: _kind, ...change } = recent
        this.journal!.recordChange({ op: op.id, ...change })
      }
      changes.push({ path: filePath, id: key })
      const removedFrom = await this.removeOtherCopies(key, filePath, dir, isOwnDirOnly, prev?.copies ?? [], changes)
      // 换了作用域：历史版本跟过去。写入已经提交，这一步没做成不算写入失败：行留在日志里，下一次进写入段补搬；
      // 没有日志时整份核对按 id 找过去
      const unfinished: OpStep[] = []
      if (historyMove !== undefined) {
        try {
          await this.followMove(historyMove)
        } catch (err) {
          unfinished.push(historyMove)
          this.log.warn(`[plastic-memory] 历史版本没跟到新的作用域，稍后补做（${describeError(err)}）`)
        }
      }
      if (indexRow !== undefined) {
        try { await this.placeIndexRow(indexRow) }
        catch (err) { unfinished.push(indexRow); this.log.warn(`[plastic-memory] 主题索引稍后补做（${describeError(err)}）`) }
      }
      if (moved) removedFrom.delete(prev.dir)
      removedFrom.delete(dir)
      for (const other of removedFrom) await this.dropIndexMember(other, key)
      await this.settleHints(current, changes)
      await this.noteLinks(changes, key, next.scope === 'global' ? { scope: 'global' } : { scope: 'workspace', workspacePath: next.workspacePath! })
      // 调用方给的操作还有账要记，由它做完再结（finishOp）；自己建的到这里就做完了
      if (unfinished.length > 0 && given !== undefined) this.unfinishedOwn.set(op.id, unfinished)
      if (given === undefined && unfinished.length === 0) this.endOp(op.id)
    } else if (given?.topic !== undefined && prev !== undefined) {
      const step: IndexRowStep = { kind: INDEX_ROW_STEP, memoryId: key, dirs: [prev.dir], topic: given.topic }
      this.beginOp(given, { kind: 'write', memoryId: key, dir: dirname(prev.filePath), fields: [], before: fingerprintOf(prev.raw), after: fingerprintOf(prev.raw) }, [step])
      if (this.isJournaling()) this.journal!.markCommitted(given.id)
      try { await this.placeIndexRow(step) }
      catch (err) { this.unfinishedOwn.set(given.id, [step]); this.log.warn(`[plastic-memory] 主题索引稍后补做（${describeError(err)}）`) }
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

  /** own：文件表自己要补做的步骤，排在调用方的步骤后面；只进日志，正常写完时由文件表当场做掉。 */
  private beginOp(op: WriteOp, target: PendingOp['target'], own: readonly OpStep[] = []): void {
    if (!this.isJournaling()) return
    this.journal!.begin({
      op: op.id, at: this.now(), target, steps: [...op.steps, ...own],
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
      const own = this.unfinishedOwn.get(op.id)
      this.unfinishedOwn.delete(op.id)
      if (this.settledOnEnter.delete(op.id)) return
      // 有一步没人会做（处理器没登记）：行留着，等登记了的进程来补，不做一半就销账
      if (!this.knowsSteps(op.steps)) {
        this.log.warn(`[plastic-memory] 操作 ${op.id} 有一步不认识，提交后的步骤没做，留在日志里`)
        return
      }
      await this.runSteps(op.id, op.steps, written)
      if (own !== undefined) {
        try {
          await this.runSteps(op.id, own.filter(step => step.kind !== INDEX_ROW_STEP), written)
          if (own.some(step => step.kind === INDEX_ROW_STEP)) return
        } catch (err) {
          this.log.warn(`[plastic-memory] 操作 ${op.id} 有一步没做成，留在日志里下次补做（${describeError(err)}）`)
          return
        }
      }
      this.endOp(op.id)
    })
  }

  /**
   * 补做被打断的操作（每次顶层的段拿到写锁先跑）。写入整段都在锁里，这时看到的待完成行一定来自没走完的上一段：
   * 进程中途退出，或那一段抛了错。按行里记的目标判提交了没有：
   *  - 写文件：目标目录里有这个 id、提交标记等于操作 id 的文件算已提交。原来那份（文件位置会变的写入先写新、后删旧）
   *    原文还是改前的样子才删；被改过就两份都留，读路径照常取舍，体检报同 id 多份。文件上找不到标记、日志行上记着
   *    写成了的（写成之后被手改换掉或删了）也算已提交。
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
          } else if (row.isCommitted === true) {
            // 日志行上记着写成了，文件上却找不到这次的提交标记：写成之后被不拿锁的写换掉或删了。步骤照补，按不是原样算，
            // 拿目标目录里这个 id 现在的那份（没有就不给）；原来那份不动，分不出它和现在这份的关系
            const current = await this.findStamped(target.dir, target.memoryId, undefined)
            await this.runSteps(row.op, row.steps, current?.located.record, false)
          }
        } else if (target.kind === 'index') {
          // 读不出（不是不存在）会抛：不能当成没提交而作废
          const text = row.isCommitted === true ? undefined : await readIndexFile(target.dir, target.file)
          if (row.isCommitted === true || (text !== undefined && stampOf(text) === row.op)) await this.runSteps(row.op, row.steps, undefined)
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
      // 日志行上记着已提交、文件上却找不到：读不出，或之后被手改换掉了。不能答「没写」，调用方会把它的改前快照当没用的删掉
      if (written === undefined && this.isJournaling() && this.journal!.pending().some(row => row.op === opId && row.isCommitted === true)) {
        throw new Error(`操作 ${opId} 已经提交，但这一刻在文件上认不出它`)
      }
      return written && this.toLocated(written)
    })
  }

  /**
   * 目录里这个 id、提交标记等于 opId 的文件（opId 不给时只按 id 找）。每个文件只读一次，指纹和记录出自同一份原文；原文里没有这个操作 id 的不解析。
   * 有文件读不出（权限、占用）又没找到时抛错：不能当成「没有」，否则这一行会被当成没提交而作废。
   */
  private async findStamped(level: string, id: string, opId: string | undefined): Promise<{ located: LocatedFile; raw: string } | undefined> {
    const listed = await this.listMemoryFiles(level)
    if ('note' in listed) throw new Error(listed.note.text)
    const dir = layerDirOf(level)
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
      if (!frontmatterOf(raw).includes(opId ?? id)) continue
      const decoded = decodeFile(raw, { path: filePath, loc: loc.loc, relPath: relative(this.opts.root, filePath), mtimeMs })
      if (!decoded.ok || decoded.record.id !== id || (opId !== undefined && decoded.record.lastWriteOp !== opId)) continue
      const { lastWriteOp: writeOp, ...record } = decoded.record
      return { located: { record, extras: decoded.extras, filePath, dir, ...(writeOp !== undefined ? { writeOp } : {}) }, raw }
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

  async delete(id: string, at: LocateTarget, skipIf?: (current: LocatedFile) => boolean, given?: WriteOp, opts: { isHistoryCarried?: boolean } = {}): Promise<boolean> {
    return this.locked(async () => {
      const found = await this.locateSlot(id, at)
      const slot = found && this.toLocated(found)
      if (!slot || skipIf?.(slot)) return false
      const op = given ?? newWriteOp()
      const classified = classifyChange(byPosition(slot), undefined)
      const recent: RecentChangeStep | undefined = classified && { kind: RECENT_CHANGE_STEP, ...classified, memoryId: id, session: currentWriteSession(), at: this.now() }
      const indexRow: IndexRowStep = { kind: INDEX_ROW_STEP, memoryId: id, dirs: [...new Set(isScopeTarget(at) ? [slot.dir] : [slot.dir, this.globalDir])], isPurge: true }
      this.beginOp(op, {
        kind: 'delete', memoryId: id, dir: dirname(slot.filePath), nameHash: fingerprintOf(basename(slot.filePath)),
        before: fingerprintOf(found.raw), scopeDir: slot.dir, isOwnDirOnly: isScopeTarget(at),
      }, [...(recent === undefined ? [] : [recent]), indexRow])
      // 历史版本先于记忆文件删：中途断掉最多是记忆还在、历史没了，不会留下记忆已删、旧内容（可能带密钥）还在的历史。
      // 要删的是这一层和（按会话定位时）全局里这个 id 的全部副本，这几层的历史直接删；它以前住过的层也删。
      // 有哪一层删不掉或拿不准就在这里报错，记忆文件不动
      if (opts.isHistoryCarried === true && !(await this.carryHistory(slot.record, slot.dir))) throw new Error(`记忆 ${id} 的历史版本没能并到它并入的那条名下，未删除`)
      await this.removeOwnedHistory(id, new Set(isScopeTarget(at) ? [slot.dir] : [slot.dir, this.globalDir]), true)
      await this.removeFile(slot.filePath)
      if (recent !== undefined && this.isJournaling()) {
        const { kind: _kind, ...change } = recent
        this.journal!.recordChange({ op: op.id, ...change })
      }
      // 彻底删除（密钥硬删、最近删除里的彻底删除）的承诺是「可见集合里再没有它」：global 与该记录目录里同 id 的其余副本
      // （含 .archive/）一并物理删除；给作用域时只删该目录里的，别的作用域里的同 id 副本是另一张卡
      const removed: Array<{ path: string }> = [{ path: slot.filePath }]
      await this.removeOtherCopies(id, slot.filePath, slot.dir, isScopeTarget(at), undefined, removed)
      // 派生库里不留彻底删掉的文件名
      for (const level of new Set(removed.map(c => dirname(c.path)))) {
        this.index?.forgetNames(level, removed.filter(c => dirname(c.path) === level).map(c => basename(c.path)))
      }
      // 召回统计按 id 一行，别的作用域还有副本时是它的，留着
      if ((await this.locateSlot(id)) === undefined) await this.opts.stats.delete(id)
      // 彻底删除后索引里不留它的名字和摘要：当场整份重写，不等冻结。不按行改：它的摘要带换行时占了几行，
      // 后面几行可以长得像别的记忆的行，按行认不出来
      try { await this.placeIndexRow(indexRow); if (given === undefined) this.endOp(op.id) }
      catch (err) { if (given !== undefined) this.unfinishedOwn.set(op.id, [indexRow]); this.log.warn(`[plastic-memory] 主题索引稍后补做（${describeError(err)}）`) }
      return true
    })
  }
}
