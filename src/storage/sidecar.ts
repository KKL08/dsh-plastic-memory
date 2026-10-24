import { link, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import type { ZodType } from 'zod'
import type { BatchKvTable, KvTable } from '../kv-table.ts'
import type { MemoryLogger } from './table.ts'
import { kvImportMarkerSchema, recallStatsSchema, type KvImportMarker, type RecallStats } from './schema.ts'
import { STATE_DIR } from './paths.ts'

/**
 * 侧表文件存储（设计稿 docs/design-storage-file-is-memory.md §1 §7 §8）：快照、待决账本、扫描缓存、
 * 召回统计住 `<memoryRoot>/.state/`，跨进程可见。
 *
 *   .state/snapshots/<id>.json      每条一文件
 *   .state/pending/<id>.json        每条一文件
 *   .state/scan-cache/<sha1(桶键)>.json
 *   .state/recall-stats.json        整张表一个文件 { [id]: RecallStats }
 *   .state/kv-import.json           旧宿主 KV 导入的完成标记
 *
 * 写都是 tmp + rename 原子写，进程内经一条 Promise 链串行；读不加锁。跨进程单条 LWW，不引入锁文件。
 * 坏文件跳过并记日志，不抛。条目 schema 由接线层注入（storage 不 import governance）。
 *
 * 导入屏障：snapshots / pending / scan-cache 的每个读写方法先 await 一次 memoize 的导入（锁内执行）。
 * 召回统计不过屏障——导入不碰它，而 FileTable 加载时就要逐条读它，过屏障会把导入拖进 apply。
 * 0.3.0 删除导入代码（openLegacyKv、标记、LegacyKvTables）。
 */

export { STATE_DIR }
export const KV_IMPORT_MARKER = 'kv-import.json'
export const RECALL_STATS_FILE = 'recall-stats.json'
const SNAPSHOTS_DIR = 'snapshots'
const PENDING_DIR = 'pending'
const SCAN_CACHE_DIR = 'scan-cache'

/** 能直接当文件名的键（genId 产出的 snap_ / pd_ id 都满足）；其余一律不落盘，防路径穿越。 */
const SAFE_KEY_RE = /^[A-Za-z0-9_-]+$/

/** 旧宿主 KV 里要导入的两张表的 [key, value] 全量；值未经校验，导入时逐条过 schema。 */
export interface LegacyKvTables {
  snapshots: Array<[string, unknown]>
  pending: Array<[string, unknown]>
  /** 删掉旧 KV 里这两张表的全部行。标记写下后调用一次：宿主不再留明文副本，标记丢失后重导也找不到旧行。 */
  discard: () => Promise<void>
}

export interface SidecarOptions<S, P, C> {
  /** memoryRoot；侧表住其下 `.state/` */
  root: string
  schemas: { snapshots: ZodType<S>; pending: ZodType<P>; scanCache: ZodType<C> }
  /** 惰性读取旧宿主 KV（打开域、取两张表、关域）。只在标记缺失时调用一次；
   *  缺省或返回 undefined = 宿主没有 storageDomain，写 source: none 的标记。 */
  openLegacyKv?: () => Promise<LegacyKvTables | undefined>
  log?: MemoryLogger
  now?: () => number
}

type Locked = <R>(fn: () => Promise<R>) => Promise<R>

interface TableEnv {
  locked: Locked
  /** 导入屏障；召回统计表不用 */
  ready: () => Promise<void>
  log: MemoryLogger
}

function errnoCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** tmp 命名带 pid，与 FileTable.atomicWrite 同规则。 */
function tmpPathFor(path: string): string {
  return `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
}

async function atomicWrite(path: string, text: string): Promise<void> {
  const tmp = tmpPathFor(path)
  await writeFile(tmp, text, 'utf8')
  await rename(tmp, path)
}

/** 原子排他创建：先写 tmp，再 link 到目标（目标已存在则 EEXIST，不覆盖），最后删 tmp。
 *  比直接 `wx` 写目标多一步，换来崩溃时不会留下半截文件——半截文件在续传时会被当成"已存在"跳过。
 *  返回 false = 目标已存在。 */
async function createExclusive(path: string, text: string): Promise<boolean> {
  const tmp = tmpPathFor(path)
  await writeFile(tmp, text, 'utf8')
  try {
    await link(tmp, path)
    return true
  } catch (err) {
    if (errnoCode(err) === 'EEXIST') return false
    throw err
  } finally {
    await rm(tmp, { force: true })
  }
}

/** 每条一个 JSON 文件的表。键从文件内容的 id 还原，所以 put 要求键等于值的 id。 */
class EntryFileTable<T extends { id: string }> implements KvTable<T> {
  private readonly dir: string
  private readonly fileNameOf: (key: string) => string | undefined
  private readonly schema: ZodType<T>
  private readonly env: TableEnv

  constructor(dir: string, fileNameOf: (key: string) => string | undefined, schema: ZodType<T>, env: TableEnv) {
    this.dir = dir
    this.fileNameOf = fileNameOf
    this.schema = schema
    this.env = env
  }

  private pathOf(key: string): string | undefined {
    const name = this.fileNameOf(key)
    return name === undefined ? undefined : join(this.dir, `${name}.json`)
  }

  private async read(path: string): Promise<T | undefined> {
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch (err) {
      if (errnoCode(err) !== 'ENOENT') this.env.log.warn(`[plastic-memory] 侧表文件不可读，跳过：${path}（${describeError(err)}）`)
      return undefined
    }
    try {
      return this.schema.parse(JSON.parse(text))
    } catch (err) {
      this.env.log.warn(`[plastic-memory] 侧表文件解析失败，跳过：${path}（${describeError(err)}）`)
      return undefined
    }
  }

  async get(key: string): Promise<T | undefined> {
    await this.env.ready()
    const path = this.pathOf(key)
    return path === undefined ? undefined : this.read(path)
  }

  async list(): Promise<Array<[string, T]>> {
    await this.env.ready()
    let names: string[]
    try {
      names = await readdir(this.dir)
    } catch (err) {
      if (errnoCode(err) !== 'ENOENT') this.env.log.warn(`[plastic-memory] 侧表目录不可读，按空读：${this.dir}（${describeError(err)}）`)
      return []
    }
    const out: Array<[string, T]> = []
    // 只认 .json 结尾：在途 tmp（<名>.json.tmp-<pid>-<rand>）不是条目
    for (const name of names.filter(n => n.endsWith('.json')).sort()) {
      const value = await this.read(join(this.dir, name))
      if (value !== undefined) out.push([value.id, value])
    }
    return out
  }

  async put(key: string, value: T): Promise<void> {
    if (value.id !== key) throw new Error(`侧表键必须等于值的 id：key=${key} id=${value.id}`)
    const path = this.pathOf(key)
    if (path === undefined) throw new Error(`侧表键不能当文件名：${key}`)
    await this.env.ready()
    await this.env.locked(async () => {
      await mkdir(this.dir, { recursive: true })
      await atomicWrite(path, JSON.stringify(value))
    })
  }

  async delete(key: string): Promise<boolean> {
    const path = this.pathOf(key)
    await this.env.ready()
    if (path === undefined) return false
    return this.env.locked(async () => {
      try {
        await rm(path)
        return true
      } catch (err) {
        if (errnoCode(err) === 'ENOENT') return false
        throw err
      }
    })
  }
}

/** 整张表一个 JSON 文件（召回统计）。写在锁内读改写；读按 inode/mtime/size 签名缓存解析结果——
 *  FileTable 加载时逐条 get，不缓存就是每条记录重读、重校验整个文件。rename 换文件必换 inode，
 *  别的进程写入后签名必变。 */
class MapFileTable<T> implements BatchKvTable<T> {
  private readonly path: string
  private readonly schema: ZodType<T>
  private readonly env: TableEnv
  private cache: { sig: string; entries: Map<string, T> } | undefined

  constructor(path: string, schema: ZodType<T>, env: TableEnv) {
    this.path = path
    this.schema = schema
    this.env = env
  }

  private async readAll(): Promise<ReadonlyMap<string, T>> {
    let sig: string
    try {
      const s = await stat(this.path)
      sig = `${s.ino}:${s.mtimeMs}:${s.size}`
    } catch (err) {
      if (errnoCode(err) !== 'ENOENT') this.env.log.warn(`[plastic-memory] 侧表文件不可读，按空表读：${this.path}（${describeError(err)}）`)
      return new Map()
    }
    if (this.cache?.sig === sig) return this.cache.entries
    const entries = new Map<string, T>()
    let raw: unknown
    try {
      raw = JSON.parse(await readFile(this.path, 'utf8'))
    } catch (err) {
      if (errnoCode(err) === 'ENOENT') return entries // stat 之后被换掉/删掉：竞态，不缓存
      this.env.log.warn(`[plastic-memory] 侧表文件解析失败，按空表读：${this.path}（${describeError(err)}）`)
      raw = {}
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      this.env.log.warn(`[plastic-memory] 侧表文件不是对象，按空表读：${this.path}`)
      raw = {}
    }
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      const parsed = this.schema.safeParse(value)
      if (parsed.success) entries.set(key, parsed.data)
      else this.env.log.warn(`[plastic-memory] 侧表条目不合 schema，跳过：${this.path} 的 ${key}`)
    }
    this.cache = { sig, entries }
    return entries
  }

  private async writeAll(entries: Map<string, T>): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    await atomicWrite(this.path, JSON.stringify(Object.fromEntries(entries)))
    this.cache = undefined
  }

  async get(key: string): Promise<T | undefined> {
    return (await this.readAll()).get(key)
  }

  async list(): Promise<Array<[string, T]>> {
    return [...(await this.readAll()).entries()]
  }

  async put(key: string, value: T): Promise<void> {
    await this.putMany([[key, value]])
  }

  /** 锁内一次读改写：多条合并后只换一次文件。 */
  async putMany(entries: ReadonlyArray<[string, T]>): Promise<void> {
    if (entries.length === 0) return
    await this.env.locked(async () => {
      const next = new Map(await this.readAll())
      for (const [key, value] of entries) next.set(key, value)
      await this.writeAll(next)
    })
  }

  async delete(key: string): Promise<boolean> {
    return this.env.locked(async () => {
      const current = await this.readAll()
      if (!current.has(key)) return false // 不存在不写盘：加载期的清扫不该建出 .state/
      const next = new Map(current)
      next.delete(key)
      await this.writeAll(next)
      return true
    })
  }
}

export class SidecarStore<S extends { id: string }, P extends { id: string }, C extends { id: string }> {
  readonly snapshots: KvTable<S>
  readonly pending: KvTable<P>
  readonly scanCache: KvTable<C>
  readonly recallStats: BatchKvTable<RecallStats>

  private readonly stateDir: string
  private readonly opts: SidecarOptions<S, P, C>
  private readonly log: MemoryLogger
  private chain: Promise<unknown> = Promise.resolve() // 进程内互斥：侧表写与导入串行化
  private imported: Promise<void> | undefined

  /** 构造不做 I/O：目录按需在首次写入时建。 */
  constructor(opts: SidecarOptions<S, P, C>) {
    this.opts = opts
    this.log = opts.log ?? console
    this.stateDir = join(opts.root, STATE_DIR)
    const locked: Locked = fn => this.locked(fn)
    const gated: TableEnv = { locked, ready: () => this.ensureImported(), log: this.log }
    const ungated: TableEnv = { locked, ready: async () => {}, log: this.log }
    const safeKey = (key: string) => (SAFE_KEY_RE.test(key) ? key : undefined)
    const sha1 = (key: string) => createHash('sha1').update(key).digest('hex')
    this.snapshots = new EntryFileTable(join(this.stateDir, SNAPSHOTS_DIR), safeKey, opts.schemas.snapshots, gated)
    this.pending = new EntryFileTable(join(this.stateDir, PENDING_DIR), safeKey, opts.schemas.pending, gated)
    this.scanCache = new EntryFileTable(join(this.stateDir, SCAN_CACHE_DIR), sha1, opts.schemas.scanCache, gated)
    this.recallStats = new MapFileTable(join(this.stateDir, RECALL_STATS_FILE), recallStatsSchema, ungated)
  }

  private locked<R>(fn: () => Promise<R>): Promise<R> {
    const next = this.chain.then(fn, fn)
    this.chain = next.catch(() => {})
    return next
  }

  /** 锁内初始化屏障，memoize 成一个 Promise。失败只记日志、不写标记：本进程不再重试，
   *  下次启动标记仍缺失，续传（排他创建保证已迁入的条目不被覆盖）。 */
  private ensureImported(): Promise<void> {
    this.imported ??= this.locked(() => this.importInner()).catch(err => {
      this.log.warn(`[plastic-memory] 旧 KV 侧表导入失败，下次启动续传：${describeError(err)}`)
    })
    return this.imported
  }

  private async importInner(): Promise<void> {
    const markerPath = join(this.stateDir, KV_IMPORT_MARKER)
    if (await this.hasMarker(markerPath)) return
    const legacy = await this.opts.openLegacyKv?.()
    const counts = { snapshots: 0, pending: 0 }
    if (legacy !== undefined) {
      counts.snapshots = await this.importTable(legacy.snapshots, SNAPSHOTS_DIR, this.opts.schemas.snapshots)
      counts.pending = await this.importTable(legacy.pending, PENDING_DIR, this.opts.schemas.pending)
    }
    const marker: KvImportMarker = {
      version: 1,
      importedAt: this.opts.now?.() ?? Date.now(),
      source: legacy === undefined ? 'none' : 'kv',
      counts,
    }
    await mkdir(this.stateDir, { recursive: true })
    await atomicWrite(markerPath, JSON.stringify(marker))
    if (legacy !== undefined) {
      this.log.info(`[plastic-memory] 旧 KV 侧表已导入：快照 ${counts.snapshots} 条，待决 ${counts.pending} 条`)
      // 标记已挡住重导，删旧行失败不影响本次操作，只留痕
      try {
        await legacy.discard()
      } catch (err) {
        this.log.warn(`[plastic-memory] 旧 KV 侧表已导入，但删除旧行失败：${describeError(err)}`)
      }
    }
  }

  private async hasMarker(path: string): Promise<boolean> {
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch (err) {
      if (errnoCode(err) === 'ENOENT') return false
      throw err
    }
    try {
      kvImportMarkerSchema.parse(JSON.parse(text))
      return true
    } catch (err) {
      this.log.warn(`[plastic-memory] 导入标记损坏，按缺失处理、重新导入：${path}（${describeError(err)}）`)
      return false
    }
  }

  /** 逐条排他创建；已存在不覆盖（中断后续传不会盖掉迁移后产生的新状态）。返回落成文件的条数。 */
  private async importTable<T extends { id: string }>(entries: Array<[string, unknown]>, dirName: string, schema: ZodType<T>): Promise<number> {
    const dir = join(this.stateDir, dirName)
    await mkdir(dir, { recursive: true })
    let count = 0
    for (const [key, value] of entries) {
      if (!SAFE_KEY_RE.test(key)) {
        this.log.warn(`[plastic-memory] 旧 KV 条目的键不能当文件名，跳过：${dirName}/${key}`)
        continue
      }
      const parsed = schema.safeParse(value)
      if (!parsed.success || parsed.data.id !== key) {
        this.log.warn(`[plastic-memory] 旧 KV 条目不合 schema，跳过：${dirName}/${key}`)
        continue
      }
      await createExclusive(join(dir, `${key}.json`), JSON.stringify(parsed.data))
      count++
    }
    return count
  }
}
