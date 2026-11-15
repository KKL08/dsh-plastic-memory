import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { RootLock } from '../root-lock.ts'
import { RootLockTimeoutError } from '../errors.ts'
import { STATE_DIR } from './paths.ts'
import { describeError } from './state-files.ts'
import type { MemoryLogger } from './table.ts'

/**
 * 记忆根写锁的实现：`<memoryRoot>/.state/lock/write-lock.sqlite` 是一个不存数据的 SQLite 库，
 * 在它上面 `BEGIN IMMEDIATE` 当跨进程互斥锁、`ROLLBACK` 释放；持锁进程崩溃时操作系统立即释放。
 * 锁库路径、加锁方式与 `user_version = 1` 是跨版本契约：新旧版本同开时要锁同一个文件、用同一种方式才互斥。
 *
 * 连接按批开关：持有计数从 0 变 1 时打开并加锁，回到 0 时回滚并关闭，两批之间不占任何资源，所以没有关闭步骤。
 * 运行中锁库被删，只有当时持有的这一批失去互斥，下一批按路径重开新库。
 * 插件代码任何地方都不要用 fs 打开、读取或 stat 锁库，`.state/lock/` 里也不放别的东西：
 * POSIX 记录锁按进程计，同进程任何一次 close 都会把它释放掉。
 */

const LOCK_DIR = 'lock'
const LOCK_FILE = 'write-lock.sqlite'
const WAIT_LIMIT_MS = 10_000
const BACKOFF_MIN_MS = 10
const BACKOFF_MAX_MS = 200

type SqliteModule = { DatabaseSync: typeof DatabaseSync }

/** 退避等待用的计时器。 */
export interface RootLockTimers {
  setTimeout(fn: () => void, ms: number): unknown
}

export interface RootLockOptions {
  /** 记忆根。 */
  root: string
  log: MemoryLogger
  /** 只为测试注入：退避等待用的计时器。 */
  timers?: RootLockTimers
  /** 只为测试注入：加载 node:sqlite。返回 undefined 或抛错按不可用处理。 */
  loadSqlite?: () => SqliteModule | undefined
}

/** SQLite 报「忙」：别的连接正持有锁。主错误码 SQLITE_BUSY 是 5，扩展码取低 8 位。
 *  state-files 的 errnoCode 只读 `.code`（这里恒为 ERR_SQLITE_ERROR），判别不了。 */
export function isSqliteBusy(err: unknown): boolean {
  const e = err as { code?: unknown; errcode?: unknown } | null | undefined
  return e?.code === 'ERR_SQLITE_ERROR' && typeof e.errcode === 'number' && (e.errcode & 0xff) === 5
}

export function createRootLock(opts: RootLockOptions): RootLock {
  return new SqliteRootLock(opts)
}

const defaultLocks = new Map<string, RootLock>()

/**
 * 文件表、侧表没注入写锁时用的缺省锁：同一进程里同一个记忆根共用一个实例，文件表在锁内写侧表时按计数嵌套，不会自己等自己。
 * 插件接线层不用它：每个插件实例自己建一个注入各写入点，热重载时新旧实例才互斥。
 */
export function defaultRootLock(root: string, log: MemoryLogger): RootLock {
  let lock = defaultLocks.get(root)
  if (lock === undefined) defaultLocks.set(root, lock = createRootLock({ root, log }))
  return lock
}

/**
 * 同步加载 node:sqlite，只吞掉它第一次加载时那条 SQLite 实验特性警告（Node 24.15 之前会打到 stderr），
 * 其余警告照常转发。替换与还原在同一个同步块里，中间不会跑别的代码。
 * Node 哪天不再经 process.emitWarning 发这条，结果只是警告重新出现。
 */
function loadSqliteQuietly(): SqliteModule | undefined {
  const original = process.emitWarning
  process.emitWarning = function (this: unknown, warning: string | Error, ...rest: unknown[]) {
    const type = typeof rest[0] === 'string' ? rest[0] : (rest[0] as { type?: unknown } | undefined)?.type
    const message = typeof warning === 'string' ? warning : warning.message
    if (type === 'ExperimentalWarning' && /^SQLite\b/.test(message)) return
    return Reflect.apply(original, this, [warning, ...rest]) as void
  } as typeof process.emitWarning
  try {
    return process.getBuiltinModule('node:sqlite')
  } finally {
    process.emitWarning = original
  }
}

/** 一批持有者：同一实例里同时处在 run 内的写者共用一次获取、一条连接。ready 为 undefined 表示退回了无锁。 */
interface Batch {
  holders: number
  ready: Promise<DatabaseSync | undefined>
}

class SqliteRootLock implements RootLock {
  private readonly dir: string
  private readonly path: string
  private readonly log: MemoryLogger
  private readonly timers: RootLockTimers
  private readonly loadSqlite: () => SqliteModule | undefined
  private sqlite: SqliteModule | undefined
  private batch: Batch | undefined
  /** 加载、打开或初始化报了「忙」以外的错（node:sqlite 不可用、锁库损坏、目录不可写）：本实例此后不再拿锁。 */
  private unavailable = false

  constructor(opts: RootLockOptions) {
    // 懒打开：构造不做 I/O，第一次 run 才加载 node:sqlite、建锁目录
    this.dir = join(opts.root, STATE_DIR, LOCK_DIR)
    this.path = join(this.dir, LOCK_FILE)
    this.log = opts.log
    this.timers = opts.timers ?? { setTimeout: (fn, ms) => setTimeout(fn, ms) }
    this.loadSqlite = opts.loadSqlite ?? loadSqliteQuietly
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.unavailable) return fn()
    const batch = this.batch ?? this.startBatch()
    batch.holders++
    const db = await batch.ready
    try {
      return await fn()
    } finally {
      if (--batch.holders === 0) {
        this.batch = undefined
        if (db !== undefined) release(db)
      }
    }
  }

  private startBatch(): Batch {
    const batch: Batch = { holders: 0, ready: Promise.resolve(undefined) }
    batch.ready = this.acquire().catch((err: unknown) => {
      // 这次获取失败：等它的写者一起收到错误，下一次 run 重新获取
      if (this.batch === batch) this.batch = undefined
      throw err
    })
    this.batch = batch
    return batch
  }

  /** 拿到锁返回连接；退回无锁返回 undefined；忙到上限抛 RootLockTimeoutError。忙永远不退回无锁。 */
  private async acquire(): Promise<DatabaseSync | undefined> {
    const sqlite = this.load()
    if (sqlite === undefined) return undefined
    let waitedMs = 0
    let backoffMs = BACKOFF_MIN_MS
    for (;;) {
      try {
        await mkdir(this.dir, { recursive: true })
        return openLocked(sqlite, this.path)
      } catch (err) {
        if (!isSqliteBusy(err)) return this.giveUp(err)
      }
      if (waitedMs >= WAIT_LIMIT_MS) throw new RootLockTimeoutError(WAIT_LIMIT_MS)
      // 加抖动：几个进程同时撞忙时错开重试
      const delayMs = Math.min(Math.round(backoffMs / 2 + Math.random() * (backoffMs / 2)), WAIT_LIMIT_MS - waitedMs)
      await new Promise<void>(resolve => { this.timers.setTimeout(resolve, delayMs) })
      waitedMs += delayMs
      backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS)
    }
  }

  private load(): SqliteModule | undefined {
    if (this.sqlite !== undefined) return this.sqlite
    try {
      this.sqlite = this.loadSqlite()
    } catch (err) {
      return this.giveUp(err)
    }
    return this.sqlite ?? this.giveUp(new Error('node:sqlite 不可用'))
  }

  /** 不删锁库：别的进程可能正持有它。 */
  private giveUp(err: unknown): undefined {
    this.unavailable = true
    this.log.warn(`[plastic-memory] 记忆根写锁不可用，本进程退回进程内保护，与其他进程同开时写入不互斥：${this.path}（${describeError(err)}）`)
    return undefined
  }
}

/** 打开锁库、必要时初始化，再 BEGIN IMMEDIATE。任何一步出错都先关连接再抛，「忙」由调用方退避重试。 */
function openLocked(sqlite: SqliteModule, path: string): DatabaseSync {
  const db = new sqlite.DatabaseSync(path)
  try {
    db.exec('PRAGMA busy_timeout = 0') // 等待全在 setTimeout 里，同步 API 不卡事件循环
    if (userVersion(db) === 0) initialize(db)
    db.exec('PRAGMA journal_mode = MEMORY') // 加解锁不再产生任何文件改动
    db.exec('BEGIN IMMEDIATE')
    return db
  } catch (err) {
    closeQuietly(db)
    throw err
  }
}

function userVersion(db: DatabaseSync): number {
  return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
}

/** 每个记忆根一次，跨进程安全。用默认的回滚日志：中途崩溃库也不坏。BEGIN 之后出错先回滚，由调用方整段重试。 */
function initialize(db: DatabaseSync): void {
  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec('CREATE TABLE IF NOT EXISTS lock_marker(x)')
    db.exec('PRAGMA user_version = 1')
    db.exec('COMMIT')
  } catch (err) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // 事务可能已被 SQLite 自行回滚；连接随后关闭
    }
    throw err
  }
}

/** ROLLBACK 抛错也照样关闭连接。 */
function release(db: DatabaseSync): void {
  try {
    db.exec('ROLLBACK')
  } catch {
    // 关闭连接同样释放锁
  } finally {
    closeQuietly(db)
  }
}

function closeQuietly(db: DatabaseSync): void {
  try {
    db.close()
  } catch {
    // 已关闭
  }
}
