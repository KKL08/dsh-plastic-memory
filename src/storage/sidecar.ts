import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import type { ZodType } from 'zod'
import type { BatchKvTable, CasKvTable, ClaimKvTable, KvTable, RefreshableClaim, RefreshableClaimKvTable } from '../kv-table.ts'
import type { MemoryLogger } from './table.ts'
import { autoCheckupSettingSchema, checkupRecordSchema, recallStatsSchema, type AutoCheckupSetting, type CheckupRecord, type RecallStats } from './schema.ts'
import { STATE_DIR } from './paths.ts'
import { SAFE_KEY_RE, atomicWrite, breakStaleLock, createExclusive, describeError, errnoCode, isStaleLock, lockOwner } from './state-files.ts'
import { LegacyKvImport, type LegacyKvTables } from './legacy-kv-import.ts'

/**
 * 侧表文件存储：快照、待决账本、扫描缓存、
 * 召回统计住 `<memoryRoot>/.state/`，跨进程可见。
 *
 *   .state/snapshots/<id>.json      每条一文件
 *   .state/pending/<id>.json        每条一文件
 *   .state/pending/<id>.claim       裁决期间的认领（排他创建，裁决完即删）
 *   .state/pending/pair_<sha1>.claim  挂账期间按冲突身份的认领（同上，挂完即删）
 *   .state/scan-cache/<sha1(缓存键)>.json
 *   .state/advice-ignores/<sha1(身份)>.json  建议忽略表，每项一文件
 *   .state/checkups/<sha1(范围键)>.json       体检记录表，每个范围一文件
 *   .state/checkups/<sha1(范围键)>.claim      这个范围体检期间的认领（排他创建，持有者定时刷新，体检完即删）
 *   .state/auto-checkups/<sha1(范围键)>.json  自动体检设置表，每个范围一文件
 *   .state/recall-stats.json        整张表一个文件 { [id]: RecallStats }
 *
 * 写都是 tmp + rename 原子写，进程内经一条 Promise 链串行；读不加锁。侧表读写跨进程单条 LWW，
 * 旧 KV 导入用锁文件跨进程串行，裁决用条目旁的认领文件跨进程互斥（同一条待决项同时只许一次裁决），
 * 体检同样按范围认领（同一个范围同时只体检一次）。
 * 坏文件跳过并记日志，不抛。快照、账本、扫描缓存、建议忽略表的条目 schema 由接线层注入（storage 不 import governance）；
 * 体检记录表、自动体检设置表的 schema 是存储层自己的（storage/schema.ts），不经注入。
 *
 * 导入屏障：snapshots / pending / scan-cache 的每个读写方法先 await 一次旧 KV 导入（legacy-kv-import.ts）。
 * 召回统计不过屏障——导入不碰它，而 FileTable 加载时就要逐条读它，过屏障会把导入拖进 apply。建议忽略表、体检记录表、自动体检设置表是旧 KV 之后才有的，
 * 导入同样不碰它们，也不过屏障。
 * 0.3.0 删除导入：删掉 legacy-kv-import.ts，这里的 openLegacyKv、legacy 与屏障一并去掉。
 */

export { STATE_DIR }
export const RECALL_STATS_FILE = 'recall-stats.json'
const SNAPSHOTS_DIR = 'snapshots'
const PENDING_DIR = 'pending'
const SCAN_CACHE_DIR = 'scan-cache'
const ADVICE_IGNORES_DIR = 'advice-ignores'
const CHECKUPS_DIR = 'checkups'
const AUTO_CHECKUPS_DIR = 'auto-checkups'

/** 认领超过这么久没刷新按残留处理（持有进程崩溃后 pid 被复用）。待决项的认领不刷新：一次裁决远用不了这么久；
 *  体检的认领由持有者定时刷新（gui/auto-checkup.ts）。 */
const CLAIM_STALE_MS = 60_000

export interface SidecarOptions<S, P, C, I> {
  /** memoryRoot；侧表住其下 `.state/` */
  root: string
  schemas: { snapshots: ZodType<S>; pending: ZodType<P>; scanCache: ZodType<C>; adviceIgnores: ZodType<I> }
  /** 惰性读取旧宿主 KV（打开域、取两张表、关域）。只在标记缺失或旧行待清理时、持跨进程锁调用，
   *  每个实例（进程）至多一次。
   *  缺省 = 没有旧 KV 可导，写 source: none 的标记；返回 undefined = 宿主此刻没有 storageDomain（可能只是
   *  暂时没挂上），不写标记，下个实例再探；两张表都空同样写 source: none。 */
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
  now: () => number
}

/** 每条一个 JSON 文件的表。键从文件内容的 id 还原，所以 put 要求键等于值的 id。 */
class EntryFileTable<T extends { id: string }> implements ClaimKvTable<T>, CasKvTable<T>, RefreshableClaimKvTable<T> {
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

  /** 写锁内重读再删：与 put 同在进程内的写链上，判定之后本进程刚写入的新值不会被删；跨进程仍是单条 LWW（重读到删除之间别的进程写入的会被删）。 */
  async deleteIf(key: string, isStill: (current: T) => boolean): Promise<boolean> {
    const path = this.pathOf(key)
    await this.env.ready()
    if (path === undefined) return false
    return this.env.locked(async () => {
      const cur = await this.read(path)
      if (cur === undefined || !isStill(cur)) return false
      try {
        await rm(path)
        return true
      } catch (err) {
        if (errnoCode(err) === 'ENOENT') return false
        throw err
      }
    })
  }

  /** 写锁内重读再写：与 put 同在进程内的写链上，判定之后本进程刚写入的新值不会被旧值盖掉；跨进程仍是单条 LWW。 */
  async update(key: string, fn: (current: T | undefined) => T | undefined): Promise<boolean> {
    const path = this.pathOf(key)
    if (path === undefined) throw new Error(`侧表键不能当文件名：${key}`)
    await this.env.ready()
    return this.env.locked(async () => {
      const next = fn(await this.read(path))
      if (next === undefined) return false
      if (next.id !== key) throw new Error(`侧表键必须等于值的 id：key=${key} id=${next.id}`)
      await mkdir(this.dir, { recursive: true })
      await atomicWrite(path, JSON.stringify(next))
      return true
    })
  }

  /** 排他创建条目旁的 `<名>.claim`（list 只认 .json，不当条目）。已被占用且持有进程已退出或超时的按残留清掉，再试一次。
   *  释放只删自己的认领：被当成残留清掉、别人又认领了时不误删。不能当文件名的键不会有条目，不用认领，直接放行。 */
  async claim(key: string): Promise<(() => Promise<void>) | undefined> {
    return (await this.claimRefreshable(key))?.release
  }

  /** 同 claim，另给刷新：把认领时间改成此刻，持有者定时刷新就不会被当成残留。认领文件已不是自己的就不写、返回 false。 */
  async claimRefreshable(key: string): Promise<RefreshableClaim | undefined> {
    const path = this.claimPathOf(key)
    if (path === undefined) return { refresh: async () => true, release: async () => {} }
    await this.env.ready()
    await mkdir(this.dir, { recursive: true })
    const id = Math.random().toString(36).slice(2)
    const claimText = () => JSON.stringify({ pid: process.pid, at: this.env.now(), id })
    for (let attempt = 0; attempt < 2; attempt++) {
      if (await createExclusive(path, claimText())) {
        return {
          refresh: async () => {
            if (await lockOwner(path) !== id) return false
            await atomicWrite(path, claimText())
            return true
          },
          release: async () => { if (await lockOwner(path) === id) await rm(path, { force: true }) },
        }
      }
      let held: string
      try {
        held = await readFile(path, 'utf8')
      } catch (err) {
        if (errnoCode(err) === 'ENOENT') continue // 刚被释放
        throw err
      }
      if (!isStaleLock(held, this.env.now(), CLAIM_STALE_MS)) return undefined
      this.env.log.warn(`[plastic-memory] 认领残留（持有进程已退出或超时），清理后重试：${path}`)
      await breakStaleLock(path, held)
    }
    return undefined
  }

  /** 认领文件在、持有进程还在、也没超时不刷新。 */
  async isClaimed(key: string): Promise<boolean> {
    const path = this.claimPathOf(key)
    if (path === undefined) return false
    try {
      return !isStaleLock(await readFile(path, 'utf8'), this.env.now(), CLAIM_STALE_MS)
    } catch (err) {
      if (errnoCode(err) === 'ENOENT') return false
      throw err
    }
  }

  private claimPathOf(key: string): string | undefined {
    const name = this.fileNameOf(key)
    return name === undefined ? undefined : join(this.dir, `${name}.claim`)
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

export class SidecarStore<S extends { id: string }, P extends { id: string }, C extends { id: string }, I extends { id: string }> {
  readonly snapshots: KvTable<S>
  readonly pending: ClaimKvTable<P> & CasKvTable<P>
  readonly scanCache: CasKvTable<C>
  readonly recallStats: BatchKvTable<RecallStats>
  readonly adviceIgnores: CasKvTable<I>
  readonly checkups: CasKvTable<CheckupRecord> & RefreshableClaimKvTable<CheckupRecord>
  readonly autoCheckups: KvTable<AutoCheckupSetting>

  private readonly stateDir: string
  private readonly opts: SidecarOptions<S, P, C, I>
  private readonly log: MemoryLogger
  private chain: Promise<unknown> = Promise.resolve() // 进程内互斥：侧表写与导入串行化
  private readonly legacy: LegacyKvImport<S, P>

  /** 构造不做 I/O：目录按需在首次写入时建。 */
  constructor(opts: SidecarOptions<S, P, C, I>) {
    this.opts = opts
    this.log = opts.log ?? console
    this.stateDir = join(opts.root, STATE_DIR)
    const locked: Locked = fn => this.locked(fn)
    const now = () => this.now()
    this.legacy = new LegacyKvImport({
      stateDir: this.stateDir, dirs: { snapshots: SNAPSHOTS_DIR, pending: PENDING_DIR },
      schemas: { snapshots: opts.schemas.snapshots, pending: opts.schemas.pending }, openLegacyKv: opts.openLegacyKv, locked, log: this.log, now,
    })
    const gated: TableEnv = { locked, ready: () => this.legacy.ensureImported(), log: this.log, now }
    const ungated: TableEnv = { locked, ready: async () => {}, log: this.log, now }
    const safeKey = (key: string) => (SAFE_KEY_RE.test(key) ? key : undefined)
    const sha1 = (key: string) => createHash('sha1').update(key).digest('hex')
    this.snapshots = new EntryFileTable(join(this.stateDir, SNAPSHOTS_DIR), safeKey, opts.schemas.snapshots, gated)
    this.pending = new EntryFileTable(join(this.stateDir, PENDING_DIR), safeKey, opts.schemas.pending, gated)
    this.scanCache = new EntryFileTable(join(this.stateDir, SCAN_CACHE_DIR), sha1, opts.schemas.scanCache, gated)
    this.recallStats = new MapFileTable(join(this.stateDir, RECALL_STATS_FILE), recallStatsSchema, ungated)
    this.adviceIgnores = new EntryFileTable(join(this.stateDir, ADVICE_IGNORES_DIR), sha1, opts.schemas.adviceIgnores, ungated)
    this.checkups = new EntryFileTable(join(this.stateDir, CHECKUPS_DIR), sha1, checkupRecordSchema, ungated)
    this.autoCheckups = new EntryFileTable(join(this.stateDir, AUTO_CHECKUPS_DIR), sha1, autoCheckupSettingSchema, ungated)
  }

  /** 旧 KV 导入是否已结清（导完且旧行已删）；彻底删除据此拦（续传会把旧快照里的明文放回来）。 */
  isLegacyImportSettled(): Promise<boolean> {
    return this.legacy.isImportSettled()
  }

  private locked<R>(fn: () => Promise<R>): Promise<R> {
    const next = this.chain.then(fn, fn)
    this.chain = next.catch(() => {})
    return next
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now()
  }
}
