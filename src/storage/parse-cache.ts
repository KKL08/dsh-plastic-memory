import { dirname } from 'node:path'
import type { FileLocation } from './frontmatter.ts'

/** 文件签名：stat 给的 inode、大小、mtime、ctime。ino 抓「写临时文件再 rename」，ctime 抓保留 mtime 的改写。 */
export interface FileSignature { ino: number; size: number; mtimeMs: number; ctimeMs: number }

/** 缓存的一项：磁盘原文，与它的解析结果（预筛没过、还没解析时为空）。 */
export interface CachedFile<D> { readonly raw: string; readonly decoded?: D }

export interface ParseCacheOptions {
  /** 条数上限，超过按最久未用逐出；0 即不缓存。缺省 20 000。 */
  maxEntries?: number
  /** 文件最后改动距读前时刻至少这么久才存（racy 规则）。缺省 3 s，大于任何文件系统的时间戳粒度；只有测试会改。 */
  settleMs?: number
}

interface Entry<D> { sig: FileSignature; loc: FileLocation; file: CachedFile<D> }

const DEFAULT_MAX_ENTRIES = 20_000
const DEFAULT_SETTLE_MS = 3_000

function sameSignature(a: FileSignature, b: FileSignature): boolean {
  return a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs
}

function sameLocation(a: FileLocation, b: FileLocation): boolean {
  return a.scope === b.scope && (a.scope === 'global' || a.workspacePath === (b as typeof a).workspacePath)
}

/** 先冻结自己再递归：YAML 锚点能造出自引用的对象，走到已冻结的就停。 */
function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const v of Object.values(value)) deepFreeze(v)
  return value
}

/**
 * 记忆文件的进程内解析缓存，按路径存，只在 FileTable 内部用。不持久化。
 * 命中要路径、签名、位置都相同；存不存按读前时刻判：读期间发生的任何改写，新 ctime 至少比签名里的新，下次 stat 必然不命中。
 * 存入的解析结果深冻结，调用方改了会直接抛错。
 */
export class ParseCache<D> {
  private readonly entries = new Map<string, Entry<D>>()   // 插入序即使用序：最久未用在最前
  private readonly maxEntries: number
  private readonly settleMs: number

  constructor(opts: ParseCacheOptions = {}) {
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES
    this.settleMs = opts.settleMs ?? DEFAULT_SETTLE_MS
  }

  get size(): number { return this.entries.size }

  /** 查一个文件：命中返回缓存的原文与解析结果；签名或位置对不上就逐出旧条目。 */
  lookup(path: string, sig: FileSignature, loc: FileLocation): CachedFile<D> | undefined {
    const entry = this.entries.get(path)
    if (entry === undefined) return undefined
    this.entries.delete(path)
    if (!sameSignature(entry.sig, sig) || !sameLocation(entry.loc, loc)) return undefined
    this.entries.set(path, entry)
    return entry.file
  }

  /** 读完一个文件后存：最后改动距读前时刻不到 settleMs（或在它之后）就不存，同一路径的旧条目照样清掉。
   *  解析结果不管存没存都冻结：调用方拿到的对象冻不冻结不该取决于文件新旧，改它的代码在测试里就会抛错。 */
  store(path: string, sig: FileSignature, loc: FileLocation, readStartedAt: number, file: CachedFile<D>): void {
    const frozen = deepFreeze({ ...file })
    this.entries.delete(path)
    if (readStartedAt - Math.max(sig.mtimeMs, sig.ctimeMs) < this.settleMs) return
    this.entries.set(path, { sig, loc, file: frozen })
    for (const oldest of this.entries.keys()) {
      if (this.entries.size <= this.maxEntries) break
      this.entries.delete(oldest)
    }
  }

  evict(path: string): void {
    this.entries.delete(path)
  }

  /** 目录 dir 顶层只留 names 里的文件：readdir 已经列不出的逐出。子目录与别的目录不动。 */
  retain(dir: string, names: ReadonlySet<string>): void {
    for (const path of this.entries.keys()) {
      if (dirname(path) === dir && !names.has(path.slice(dir.length + 1))) this.entries.delete(path)
    }
  }
}
