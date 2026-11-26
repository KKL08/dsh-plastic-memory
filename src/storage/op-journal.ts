import { mkdirSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { inTransaction, isSqliteBusy, loadSqliteQuietly, type SqliteModule } from './root-lock.ts'
import { describeError } from './state-files.ts'
import type { MemoryLogger, OpStep } from './table.ts'
import { RECENT_CHANGES_PER_SCOPE } from './recent-changes.ts'
import type { RecentChangeRow, RecentChangeInput, RecentChangeLog, RecentChangeRead } from './recent-changes.ts'
import { USAGE_SIGNAL_KINDS, type UsageSignalCounts, type UsageSignalInput, type UsageSignalKind, type UsageSignalLog } from './usage-signals.ts'

/**
 * 操作日志库：记每次写入提交之后还要补做的事，中断后由下一个拿到写锁的人补完（见 FileTable.recoverPending）。
 * 一个 SQLite 库，放在记忆根之外、每台机器一份：崩溃恢复只和本机有关，也不让网盘同步一个活的数据库文件。
 *
 * - 写在写锁内；最近改动的两个读方法在锁外，只读、不删库。建库由 SQLite 的锁保护。
 * - 行里不存字段值和正文：目标只记记忆 id、目录和文件名的摘要，改动只记字段名和指纹。
 * - 待完成操作做完就删行；最近改动按作用域定长保留。
 * - 使用信号（见 usage-signals.ts）单独一张表 usage_signals，锁外记、锁外读，打开方式同最近改动的读（不删库、不换新库）。
 * - 库丢了、损坏、是更新的版本建的，或 node:sqlite 加载不到：什么都不记，写入照常进行，只剩顺序保护。
 *   只承诺进程中途退出时能恢复，不承诺断电。
 */

const SCHEMA_VERSION = 1

/** 这次写入动哪个文件、恢复时怎么判它提交了没有。 */
export type OpTarget =
  | {
    /** 写记忆文件（新建、原地改、搬到别的目录或换名字）：提交点是 dir 里出现一个提交标记等于操作 id 的文件。 */
    kind: 'write'
    memoryId: string
    /** 写完的文件所在的目录（顶层或 .archive/）。 */
    dir: string
    /** 这次改了哪些字段（只有字段名）。 */
    fields: string[]
    /** 改前、改后文件原文的指纹；新建没有改前。 */
    before?: string
    after: string
    /** 文件位置会变时原来那份在哪：提交后删掉它，除非它的原文已不是 before。 */
    source?: { dir: string; nameHash: string }
  }
  | {
    /** 彻底删除：提交点是这个文件不在了。 */
    kind: 'delete'
    memoryId: string
    /** 被删的文件所在的目录（顶层或 .archive/）。 */
    dir: string
    nameHash: string
    before: string
    /** 这条记忆所在的记忆目录；删完后同 id 的其余副本清哪些目录。 */
    scopeDir: string
    isOwnDirOnly: boolean
  }
  | {
    /** 改主题索引：提交点是 file（'entry' 或主题页的文件名）页头里的提交标记等于操作 id。其余的页由步骤补。 */
    kind: 'index'
    /** 记忆目录。 */
    dir: string
    file: string
  }


export interface PendingOp {
  /** 操作 id，也是写进记忆文件的提交标记。 */
  op: string
  at: number
  /** 谁发起的（前台主会话、子 agent、界面……）。 */
  initiator?: string
  /** 同一批操作共用的批次 id。 */
  batch?: string
  target: OpTarget
  steps: OpStep[]
  /**
   * 已经看到这次操作提交了。提交之后要改好几个文件的操作，写下第一个文件就记上这一笔：之后补做不再按文件里的
   * 提交标记判（那个文件可能已经被后来的操作写上新的标记）。
   */
  isCommitted?: boolean
}

export interface OpJournalOptions {
  /** 库文件的路径（接线层给 localStateDir 下的那个）。 */
  path: string
  log: MemoryLogger
  /** 只为测试注入：加载 node:sqlite。返回 undefined 或抛错按不可用处理。 */
  loadSqlite?: () => SqliteModule | undefined
}

export class OpJournal implements RecentChangeLog, UsageSignalLog {
  private readonly path: string
  private readonly log: MemoryLogger
  private readonly loadSqlite: () => SqliteModule | undefined
  private db: DatabaseSync | undefined
  /** 打开失败过：本实例此后什么都不记。 */
  private isBroken = false
  private readonly readOpenFailures = new Set<string>()

  constructor(opts: OpJournalOptions) {
    // 懒打开：构造不做 I/O
    this.path = opts.path
    this.log = opts.log
    this.loadSqlite = opts.loadSqlite ?? loadSqliteQuietly
  }

  /** 日志此刻能不能记（会触发打开）。 */
  isAvailable(): boolean {
    return this.open() !== undefined
  }

  /** 插一行待完成；同一个操作再插是替换（写入重来的那一轮目标可能变了）。 */
  begin(op: PendingOp): void {
    const { op: id, at, ...body } = op
    this.exec(db => { db.prepare('INSERT OR REPLACE INTO ops(op, at, body) VALUES (?, ?, ?)').run(id, at, JSON.stringify(body)) })
  }

  /** 记下这个操作已经提交（行的先后不变）。行不在就什么都不做。 */
  markCommitted(opId: string): void {
    this.exec(db => {
      const row = db.prepare('SELECT body FROM ops WHERE op = ?').get(opId) as { body: string } | undefined
      if (row === undefined) return
      db.prepare('UPDATE ops SET body = ? WHERE op = ?').run(JSON.stringify({ ...(JSON.parse(row.body) as object), isCommitted: true }), opId)
    })
  }

  /** 这个操作做完了（或作废了）：删掉它的行。 */
  done(opId: string): void {
    this.exec(db => { db.prepare('DELETE FROM ops WHERE op = ?').run(opId) })
  }

  hasPending(): boolean {
    return this.exec(db => db.prepare('SELECT 1 FROM ops LIMIT 1').get() !== undefined) ?? false
  }

  /** 待完成的行，按插入先后。读不懂的行（更新的版本写的）跳过、留着。 */
  pending(): PendingOp[] {
    const rows = this.exec(db => db.prepare('SELECT op, at, body FROM ops ORDER BY seq').all() as Array<{ op: string; at: number; body: string }>) ?? []
    return rows.flatMap((row) => {
      try {
        return [{ op: row.op, at: row.at, ...(JSON.parse(row.body) as Omit<PendingOp, 'op' | 'at'>) }]
      } catch {
        return []
      }
    })
  }

  /**
   * 最近改动记录（见 recent-changes.ts）：记一行；同一个 op 已经记过就什么都不做；记完把这个作用域裁到
   * RECENT_CHANGES_PER_SCOPE 行，挤掉的最大序号记进这个作用域的那一笔。插入、裁行、记序号必须在一个写事务里
   * （inTransaction），中途失败整段不留。库不可用或写失败只记日志。只在写锁内调用，打开失败时照现有规则换新库。
   */
  recordChange(change: RecentChangeInput): void {
    this.exec(db => inTransaction(db, () => {
      const inserted = db.prepare('INSERT OR IGNORE INTO recent_changes(op, scope, memory_id, change, moved_to, session, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(change.op, change.scope, change.memoryId, change.change, change.movedTo ?? null, change.session ?? null, change.at)
      if (inserted.changes === 0) return
      const pruned = db.prepare('SELECT MAX(seq) AS seq FROM (SELECT seq FROM recent_changes WHERE scope = ? ORDER BY seq DESC LIMIT -1 OFFSET ?)').get(change.scope, RECENT_CHANGES_PER_SCOPE) as { seq: number | null }
      if (pruned.seq === null) return
      db.prepare('DELETE FROM recent_changes WHERE scope = ? AND seq <= ?').run(change.scope, pruned.seq)
      db.prepare('INSERT INTO recent_change_floors(scope, pruned_through) VALUES (?, ?) ON CONFLICT(scope) DO UPDATE SET pruned_through = MAX(pruned_through, excluded.pruned_through)').run(change.scope, pruned.seq)
    }))
  }

  /**
   * 库里用到过的最大改动序号（含已挤掉的，只增不减）；空库为 0，读不出为 undefined。
   * 锁外读（发送点、冻结时调用）：打开失败不删库、不换新库、不放弃这个实例，这一次回 undefined；库文件不存在时照常建。
   */
  latestChangeSeq(): number | undefined {
    return this.read(db => this.latestSeq(db))
  }

  /**
   * 这几个作用域里序号大于 after 的行（升序）、库里最大序号、各作用域挤掉的最大序号；读不出为 undefined。
   * 几次查询必须在一个读事务里（BEGIN … COMMIT，延迟式，不占写锁），读回的是同一刻的样子。打开方式同 latestChangeSeq（锁外读）。
   */
  changesSince(scopes: readonly string[], after: number): RecentChangeRead | undefined {
    return this.read(db => {
      const rows: RecentChangeRow[] = []
      const prunedThrough: Record<string, number> = {}
      for (const scope of scopes) {
        const found = db.prepare('SELECT seq, scope, memory_id AS memoryId, change, moved_to AS movedTo, session FROM recent_changes WHERE scope = ? AND seq > ? ORDER BY seq').all(scope, after)
        for (const row of found) rows.push({ seq: row.seq as number, scope: row.scope as string, memoryId: row.memoryId as string, change: row.change as string, ...(row.movedTo === null ? {} : { movedTo: row.movedTo as string }), ...(row.session === null ? {} : { session: row.session as string }) })
        const floor = db.prepare('SELECT pruned_through FROM recent_change_floors WHERE scope = ?').get(scope) as { pruned_through: number } | undefined
        prunedThrough[scope] = floor?.pruned_through ?? 0
      }
      return { rows: rows.sort((a, b) => a.seq - b.seq), latestSeq: this.latestSeq(db), prunedThrough }
    })
  }

  /**
   * 记一笔使用信号（见 UsageSignalLog.recordUsage）：一条插入，键重复就什么都不做。锁外调用：打开失败不删库、不换新库、
   * 不放弃这个实例，这一笔不记；库忙只丢这一笔，不记日志、不关连接；其余执行出错只记日志、关掉连接，下一笔重新打开。不抛错。
   */
  recordUsage(signal: UsageSignalInput): void {
    const db = this.openOutsideWriteLock()
    if (db === undefined) return
    try {
      // 信号只作参考，库忙就丢这一笔；同步插入结束后恢复共享连接的等待，写锁内的路径仍等 1 秒。
      db.exec('PRAGMA busy_timeout = 0')
      try {
        db.prepare('INSERT OR IGNORE INTO usage_signals(scope, memory_id, kind, key, at) VALUES (?, ?, ?, ?, ?)')
          .run(signal.scope, signal.memoryId, signal.kind, signal.key, signal.at)
      } finally {
        db.exec('PRAGMA busy_timeout = 1000')
      }
      this.readOpenFailures.clear()
    } catch (err) {
      // 库忙只说明别的进程正占着写锁，连接没坏，不必告警也不必重开
      if (isSqliteBusy(err)) return
      this.log.warn(`[plastic-memory] 使用信号写入失败，这一次不记：${describeError(err)}`)
      this.close()
    }
  }

  /** 读使用信号计数（见 UsageSignalLog.readUsage）：一次查询，库里不认识的种类跳过。打开方式同 recordUsage。读不出为 undefined。 */
  readUsage(scope: string, memoryIds: readonly string[]): ReadonlyMap<string, UsageSignalCounts> | undefined {
    return this.read(db => {
      const rows = db.prepare(`SELECT memory_id, kind, COUNT(*) AS count FROM usage_signals WHERE scope = ? AND memory_id IN (${memoryIds.map(() => '?').join(',')}) AND kind IN (${USAGE_SIGNAL_KINDS.map(() => '?').join(',')}) GROUP BY memory_id, kind`)
        .all(scope, ...memoryIds, ...USAGE_SIGNAL_KINDS) as Array<{ memory_id: string; kind: UsageSignalKind; count: number }>
      const fields = { 'full-read': 'fullReads', confirm: 'confirms', 'quick-correction': 'quickCorrections' } as const
      const counts = new Map<string, UsageSignalCounts>()
      for (const row of rows) {
        const entry = counts.get(row.memory_id) ?? { fullReads: 0, confirms: 0, quickCorrections: 0 }
        entry[fields[row.kind]] = row.count
        counts.set(row.memory_id, entry)
      }
      return counts
    })
  }

  private latestSeq(db: DatabaseSync): number {
    const row = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'recent_changes'").get() as { seq: number } | undefined
    return row?.seq ?? 0
  }

  /** 锁外读写共用连接；打开失败只告警，不走写锁内的换库逻辑。 */
  private openOutsideWriteLock(): DatabaseSync | undefined {
    if (this.isBroken) return undefined
    if (this.db === undefined) {
      let sqlite: SqliteModule | undefined
      try { sqlite = this.loadSqlite() } catch { sqlite = undefined }
      if (sqlite === undefined) return this.giveUp('node:sqlite 不可用')
      try {
        mkdirSync(dirname(this.path), { recursive: true })
        this.db = openJournal(sqlite, this.path)
      } catch (err) {
        const reason = describeError(err)
        if (!this.readOpenFailures.has(reason)) {
          this.readOpenFailures.add(reason)
          this.log.warn(`[plastic-memory] 操作日志库读取失败：${reason}`)
        }
        return undefined
      }
    }
    return this.db
  }

  /** 延迟式事务保持几次查询一致；打开失败不走写路径的换库逻辑。 */
  private read<T>(fn: (db: DatabaseSync) => T): T | undefined {
    const db = this.openOutsideWriteLock()
    if (db === undefined) return undefined
    try {
      db.exec('BEGIN')
      try {
        const result = fn(db)
        db.exec('COMMIT')
        this.readOpenFailures.clear()
        return result
      } catch (err) {
        try { db.exec('ROLLBACK') } catch { /* 事务已不在 */ }
        throw err
      }
    } catch (err) {
      this.log.warn(`[plastic-memory] 操作日志库读取失败：${describeError(err)}`)
      this.close()
      return undefined
    }
  }

  close(): void {
    const db = this.db
    this.db = undefined
    if (db !== undefined) closeQuietly(db)
  }

  /** 在库上执行；库不可用返回 undefined。执行中出错（库被删、损坏）关掉连接，下次重新打开。 */
  private exec<T>(fn: (db: DatabaseSync) => T): T | undefined {
    const db = this.open()
    if (db === undefined) return undefined
    try {
      return fn(db)
    } catch (err) {
      this.log.warn(`[plastic-memory] 操作日志库读写失败，这一次不记：${this.path}（${describeError(err)}）`)
      this.close()
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
        this.db = openJournal(sqlite, this.path)
      } catch (err) {
        if (err instanceof NewerSchemaError) throw err
        // 库正被别的连接占着：不是坏了，里面的待完成行还要用。这一次不记，下次再开
        if (isSqliteBusy(err)) {
          this.log.warn(`[plastic-memory] 操作日志库正忙，这一次不记：${this.path}（${describeError(err)}）`)
          return undefined
        }
        // 损坏的库换一个新的：丢掉的只是原来的待完成行
        this.log.warn(`[plastic-memory] 操作日志库打不开，已换新库，被打断的写入不再补做：${this.path}（${describeError(err)}）`)
        for (const suffix of ['', '-wal', '-shm']) rmSync(this.path + suffix, { force: true })
        this.db = openJournal(sqlite, this.path)
      }
    } catch (err) {
      return this.giveUp(describeError(err))
    }
    return this.db
  }

  private giveUp(reason: string): undefined {
    this.isBroken = true
    this.log.warn(`[plastic-memory] 操作日志库不可用，写入被打断时不再补做记账：${this.path}（${reason}）`)
    return undefined
  }
}

class NewerSchemaError extends Error {
  constructor(version: number) {
    super(`库的版本是 ${version}，本插件只认到 ${SCHEMA_VERSION}`)
  }
}

function openJournal(sqlite: SqliteModule, path: string): DatabaseSync {
  const db = new sqlite.DatabaseSync(path)
  try {
    db.exec('PRAGMA busy_timeout = 1000')
    const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    if (version > SCHEMA_VERSION) throw new NewerSchemaError(version)
    // 追加式日志、不逐次刷盘：进程中途退出不丢已提交的行，断电不保证
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA synchronous = NORMAL')
    if (version === 0) {
      db.exec('CREATE TABLE IF NOT EXISTS ops(seq INTEGER PRIMARY KEY AUTOINCREMENT, op TEXT NOT NULL UNIQUE, at INTEGER NOT NULL, body TEXT NOT NULL)')
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
    }
    db.exec('CREATE TABLE IF NOT EXISTS recent_changes(seq INTEGER PRIMARY KEY AUTOINCREMENT, op TEXT NOT NULL UNIQUE, scope TEXT NOT NULL, memory_id TEXT NOT NULL, change TEXT NOT NULL, moved_to TEXT, session TEXT, at INTEGER NOT NULL)')
    db.exec('CREATE TABLE IF NOT EXISTS recent_change_floors(scope TEXT PRIMARY KEY, pruned_through INTEGER NOT NULL)')
    db.exec('CREATE TABLE IF NOT EXISTS usage_signals(scope TEXT NOT NULL, memory_id TEXT NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(scope, memory_id, kind, key)) WITHOUT ROWID')
    db.prepare('SELECT 1 FROM ops LIMIT 1').get()
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
