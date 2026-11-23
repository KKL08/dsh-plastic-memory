import { mkdirSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { isSqliteBusy, loadSqliteQuietly, type SqliteModule } from './root-lock.ts'
import { describeError } from './state-files.ts'
import type { MemoryLogger, OpStep } from './table.ts'

/**
 * 操作日志库：记每次写入提交之后还要补做的事，中断后由下一个拿到写锁的人补完（见 FileTable.recoverPending）。
 * 一个 SQLite 库，放在记忆根之外、每台机器一份：崩溃恢复只和本机有关，也不让网盘同步一个活的数据库文件。
 *
 * - 行只在写锁内增删，所以没有并发写；几个进程各开各的连接。
 * - 行里不存字段值和正文：目标只记记忆 id、目录和文件名的摘要，改动只记字段名和指纹。
 * - 做完就删行，平时库里一行都没有，查一次很便宜。
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
}

export interface OpJournalOptions {
  /** 库文件的路径（接线层给 localStateDir 下的那个）。 */
  path: string
  log: MemoryLogger
  /** 只为测试注入：加载 node:sqlite。返回 undefined 或抛错按不可用处理。 */
  loadSqlite?: () => SqliteModule | undefined
}

export class OpJournal {
  private readonly path: string
  private readonly log: MemoryLogger
  private readonly loadSqlite: () => SqliteModule | undefined
  private db: DatabaseSync | undefined
  /** 打开失败过：本实例此后什么都不记。 */
  private isBroken = false

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
