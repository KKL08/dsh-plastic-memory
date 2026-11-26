import { mkdirSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { inTransaction, isSqliteBusy, isSqliteCorrupt, loadSqliteQuietly, type SqliteModule } from './root-lock.ts'
import { describeError } from './state-files.ts'
import type { MemoryLogger } from './table.ts'

/**
 * 体检结果库：增量体检按批存下的结论。一个 SQLite 库，放在记忆根之外、每台机器一份，和派生索引库分开（有自己的版本号）。
 *  - checks：一轮（一个范围，或跨项目比较）里一批的结论。键是批的键（成员和判断上下文的摘要），带检查时刻、成员（副本身份和扫描指纹）、结论原文。
 *  - meta：一轮的「全部重查」时刻：早于它查的结论不再直接用。
 *
 * 这个库可丢：丢了、坏了、读不了只多花 token。
 * - 打不开、正忙、读不了：这一次按库里什么都没有处理（readRound 返回 undefined），不删库。打不开（不是忙）的，这次体检里不再试，
 *   下一次体检开始时（retryOpen）再试。
 * - 写不进去：write 返回 false，记一条日志；结论留在调用方的内存里照常用，下次重查。
 * - 结构版本和本插件的不一样、库文件损坏：只删这个库自己的文件，重建。
 * 读出的行先过结构校验（成员是字符串对、检查时刻是合法时间、结论是合法 JSON），过不了的当没有这一行。
 * 行里不存记忆正文，只存副本身份、指纹和模型给的结论（已遮过密钥）。几个进程各开各的连接；同键的行后写的覆盖先写的。
 */

const SCHEMA_VERSION = 1

/** 一批的结论（结构校验过的）。result 是结论原文解析出的值，形状由调用方按轮校验。 */
export interface CheckupCacheRow {
  key: string
  checkedAt: number
  members: Array<readonly [string, string]>
  result: unknown
}

/** 一轮读到的内容：结构校验过的行、全部重查的时刻（没有为 0）。 */
export interface CheckupRound {
  rows: CheckupCacheRow[]
  recheckBefore: number
}

export interface CheckupCacheOptions {
  /** 库文件的路径（接线层给 localStateDir 下的那个）。 */
  path: string
  log: MemoryLogger
  /** 只为测试注入：加载 node:sqlite。返回 undefined 或抛错按不可用处理。 */
  loadSqlite?: () => SqliteModule | undefined
}

export class CheckupCache {
  private readonly path: string
  private readonly log: MemoryLogger
  private readonly loadSqlite: () => SqliteModule | undefined
  private db: DatabaseSync | undefined
  /** 这次体检里打开失败过（不是忙）：到下一次体检开始（retryOpen）之前不再试。 */
  private isBroken = false

  constructor(opts: CheckupCacheOptions) {
    // 懒打开：构造不做 I/O
    this.path = opts.path
    this.log = opts.log
    this.loadSqlite = opts.loadSqlite ?? loadSqliteQuietly
  }

  /** 读一轮：结构校验过的全部行和全部重查的时刻。库这次读不了为 undefined。 */
  readRound(round: string): CheckupRound | undefined {
    return this.exec('读', (db) => {
      const raw = db.prepare('SELECT key, checked_at, members_json, result_json FROM checks WHERE round = ?').all(round) as Array<Record<string, unknown>>
      const meta = db.prepare('SELECT recheck_before FROM meta WHERE round = ?').get(round) as { recheck_before: unknown } | undefined
      const recheckBefore = typeof meta?.recheck_before === 'number' && Number.isFinite(meta.recheck_before) ? meta.recheck_before : 0
      return { rows: raw.flatMap(row => parseRow(row) ?? []), recheckBefore }
    })
  }

  /** 写一批的结论（同轮同键的替换掉）。写不进去返回 false 并记日志。 */
  write(round: string, row: CheckupCacheRow): boolean {
    return this.exec('写', (db) => {
      db.prepare('INSERT OR REPLACE INTO checks(round, key, checked_at, members_json, result_json) VALUES (?, ?, ?, ?, ?)')
        .run(round, row.key, row.checkedAt, JSON.stringify(row.members), JSON.stringify(row.result))
      return true
    }) ?? false
  }

  /**
   * 全部重查：这几轮此刻之前查的结论不再直接用。记的时刻不早于 at，也晚于库里这一轮最晚查的那一行（同一毫秒里先查、再点全部重查，
   * 旧行也作废）；已经记了更晚的时刻的不往回改。写不进去返回 false 并记日志。
   */
  markRecheck(rounds: readonly string[], at: number): boolean {
    return this.exec('写', (db) => {
      inTransaction(db, () => {
        const latest = db.prepare('SELECT MAX(checked_at) AS latest FROM checks WHERE round = ?')
        const put = db.prepare('INSERT INTO meta(round, recheck_before) VALUES (?, ?) ON CONFLICT(round) DO UPDATE SET recheck_before = MAX(recheck_before, excluded.recheck_before)')
        for (const round of rounds) {
          const checked = (latest.get(round) as { latest: unknown } | undefined)?.latest
          put.run(round, typeof checked === 'number' && Number.isFinite(checked) ? Math.max(at, checked + 1) : at)
        }
      })
      return true
    }) ?? false
  }

  /**
   * 一轮查全了之后清理：删掉键不在 keep 里的行和早于 recheckBefore 查的行，再删掉不晚于 recheckBefore 的全部重查时刻
   * （这之后别处又点了全部重查的，留着它的）。删不掉记日志。
   * startedAt：清理的扫描开始的时刻。检查时刻是整数且晚于它的行不删：那是这次扫描开始之后别处写的，不在这次读到的范围里，
   * 按这次的键清会把别处刚写的新结论删掉。不给时不按时刻留行。
   */
  prune(round: string, keep: ReadonlySet<string>, recheckBefore: number, startedAt?: number): void {
    this.exec('清理', (db) => {
      inTransaction(db, () => {
        const rows = db.prepare('SELECT key, checked_at FROM checks WHERE round = ?').all(round) as Array<{ key: string; checked_at: unknown }>
        const drop = db.prepare('DELETE FROM checks WHERE round = ? AND key = ?')
        for (const row of rows) {
          if (startedAt !== undefined && Number.isSafeInteger(row.checked_at) && (row.checked_at as number) > startedAt) continue
          const isOld = typeof row.checked_at !== 'number' || row.checked_at < recheckBefore
          if (!keep.has(row.key) || isOld) drop.run(round, row.key)
        }
        db.prepare('DELETE FROM meta WHERE round = ? AND recheck_before <= ?').run(round, recheckBefore)
      })
    })
  }

  /** 删掉一轮的全部行和全部重查时刻（项目已经不在了）。删不掉记日志。 */
  dropRound(round: string): void {
    this.exec('清理', (db) => {
      inTransaction(db, () => {
        db.prepare('DELETE FROM checks WHERE round = ?').run(round)
        db.prepare('DELETE FROM meta WHERE round = ?').run(round)
      })
    })
  }

  /** 库里有记录的轮。读不了为 undefined。 */
  rounds(): string[] | undefined {
    return this.exec('读', db => (db.prepare('SELECT round FROM checks UNION SELECT round FROM meta').all() as Array<{ round: unknown }>)
      .flatMap(r => (typeof r.round === 'string' ? [r.round] : [])))
  }

  /** 一次体检开始时调：上一次体检里打不开（不是忙）的库再试一次。 */
  retryOpen(): void {
    this.isBroken = false
  }

  close(): void {
    const db = this.db
    this.db = undefined
    if (db !== undefined) closeQuietly(db)
  }

  /** 在库上执行；库不可用返回 undefined。执行中出错关掉连接，下次重新打开；是库坏了就删掉，下次重建。 */
  private exec<T>(what: string, fn: (db: DatabaseSync) => T): T | undefined {
    const db = this.open()
    if (db === undefined) return undefined
    try {
      return fn(db)
    } catch (err) {
      this.close()
      if (isSqliteCorrupt(err)) this.removeFiles()
      this.log.warn(`[plastic-memory] 体检结果库${what}失败，这一次不用它，下次体检重查：${this.path}（${describeError(err)}）`)
      return undefined
    }
  }

  private open(): DatabaseSync | undefined {
    if (this.db !== undefined || this.isBroken) return this.db
    let sqlite: SqliteModule | undefined
    try {
      sqlite = this.loadSqlite()
    } catch {
      sqlite = undefined
    }
    if (sqlite === undefined) return this.giveUp('node:sqlite 不可用')
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      try {
        this.db = openCache(sqlite, this.path)
      } catch (err) {
        if (isSqliteBusy(err)) return this.busy(err)
        // 结构版本不同、库文件损坏：库里的东西丢了只多花 token，换新库。别的原因（权限、磁盘）不删
        if (!(err instanceof SchemaMismatchError) && !isSqliteCorrupt(err)) throw err
        this.removeFiles()
        this.db = openCache(sqlite, this.path)
      }
    } catch (err) {
      if (isSqliteBusy(err)) return this.busy(err)
      return this.giveUp(describeError(err))
    }
    return this.db
  }

  private busy(err: unknown): undefined {
    this.log.warn(`[plastic-memory] 体检结果库正忙，这一次不用它：${this.path}（${describeError(err)}）`)
    return undefined
  }

  private removeFiles(): void {
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      try { rmSync(this.path + suffix, { force: true }) } catch { /* 删不掉：下次打开再试 */ }
    }
  }

  private giveUp(reason: string): undefined {
    this.isBroken = true
    this.log.warn(`[plastic-memory] 体检结果库不可用，这次体检整批重查，下次体检再试：${this.path}（${reason}）`)
    return undefined
  }
}

/** 一行的结构校验：成员是字符串对的数组、检查时刻是非负的有限整数、结论是合法 JSON。过不了为 undefined。 */
function parseRow(row: Record<string, unknown>): CheckupCacheRow | undefined {
  const { key, checked_at: checkedAt, members_json: membersJson, result_json: resultJson } = row
  if (typeof key !== 'string' || typeof checkedAt !== 'number' || !Number.isSafeInteger(checkedAt) || checkedAt < 0) return undefined
  if (typeof membersJson !== 'string' || typeof resultJson !== 'string') return undefined
  let members: unknown
  let result: unknown
  try {
    members = JSON.parse(membersJson)
    result = JSON.parse(resultJson)
  } catch {
    return undefined
  }
  const isPair = (m: unknown): m is [string, string] => Array.isArray(m) && m.length === 2 && typeof m[0] === 'string' && typeof m[1] === 'string'
  if (!Array.isArray(members) || !members.every(isPair)) return undefined
  return { key, checkedAt, members, result }
}

class SchemaMismatchError extends Error {
  constructor(version: number) {
    super(`库的结构版本是 ${version}，本插件用 ${SCHEMA_VERSION}`)
  }
}

function openCache(sqlite: SqliteModule, path: string): DatabaseSync {
  const db = new sqlite.DatabaseSync(path)
  try {
    db.exec('PRAGMA busy_timeout = 1000')
    const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    if (version !== 0 && version !== SCHEMA_VERSION) throw new SchemaMismatchError(version)
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA synchronous = NORMAL')
    if (version === 0) {
      inTransaction(db, () => {
        db.exec('CREATE TABLE IF NOT EXISTS checks(round TEXT NOT NULL, key TEXT NOT NULL, checked_at INTEGER, members_json TEXT, result_json TEXT, PRIMARY KEY (round, key))')
        db.exec('CREATE TABLE IF NOT EXISTS meta(round TEXT PRIMARY KEY, recheck_before INTEGER NOT NULL)')
        db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
      })
    }
    try {
      db.prepare('SELECT round, key, checked_at, members_json, result_json FROM checks LIMIT 1').get()
      db.prepare('SELECT round, recheck_before FROM meta LIMIT 1').get()
    } catch (err) {
      // 版本号对、表的样子不对：同样换新库
      if (isSqliteBusy(err) || isSqliteCorrupt(err)) throw err
      throw new SchemaMismatchError(version)
    }
    return db
  } catch (err) {
    closeQuietly(db)
    throw err
  }
}

function closeQuietly(db: DatabaseSync): void {
  try {
    db.close()
  } catch {
    // 已关闭
  }
}
