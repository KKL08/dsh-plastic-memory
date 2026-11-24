import { mkdirSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { inTransaction, isSqliteBusy, isSqliteCorrupt, loadSqliteQuietly, type SqliteModule } from './root-lock.ts'
import { describeError } from './state-files.ts'
import { LINK_KINDS, type LinkKind, type MemoryLogger, type OutgoingLink } from './table.ts'

/**
 * 派生索引库：只存能从记忆文件重新算出来的东西，丢了只多花时间。一个 SQLite 库，放在记忆根之外、每台机器一份。
 * 第一张表是「记忆 id 在哪个文件里」的提示，按目录层（一个记忆目录的顶层或它的 .archive/）记：
 *  - level_scans：这一层上次核对时目录自己的修改时间和 inode、核对的时刻、文件名列表的摘要，外加一个版本号。
 *  - id_hints：这一层每个文件一行，记文件名、文件里的 id（读不出的记空）、文件的 stat 签名。
 * 提示只是线索：用之前核对目录，用之后核对文件里的 id；按提示没找到不算没有（见 FileTable.scanForId）。
 *
 * - 几个进程各开各的连接，读提示、读文件、再写回之间别人可能已经改过这一层。每次写都带着自己读到的版本号：
 *   对不上就不写（返回 false），调用方当作没有提示。这样提示和扫描记录总是出自同一次核对。
 * - 库的结构版本和本插件的不一样（更旧或更新）、库文件损坏：删库重建，不迁移。
 * - 库正被别的连接占着：这一次不用它，不删。node:sqlite 加载不到：什么都不记。调用方都按没有提示处理。
 * - 文件名由记忆名生成，可能带用户写进去的东西：删掉的行当场抹掉（secure_delete），不用 WAL，免得删掉的名字留在日志文件里。
 *
 * 第三张表是链接反向索引：每个记忆文件指出去的前提、相关、取代（含 .archive/ 里的），按层、文件名记，带记下时文件的 stat 签名。
 * 写入时按这次动到的文件增量记，整份核对时整层重记并在 link_levels 里记下这一层核对过。两种用法：
 *  - 完整查询拿签名和文件现在的比，对不上的以文件为准重读（见 FileTable.linksTo）。
 *  - 按目标查只看 links_by_target，不碰文件；没在 link_levels 里的层算查不全（见 FileTable.indexedLinksTo）。
 * 只存 id 和前提的内容摘要，不存正文。
 */

const SCHEMA_VERSION = 3

/** 库忙时最多等这么久：查找记忆在锁外的读路径上也会用到这个库，不能让它卡住。 */
const BUSY_TIMEOUT_MS = 50

export interface LevelStamp {
  /** 核对之前取的目录修改时间。 */
  mtimeMs: number
  /** 目录的 inode：整个目录被换掉时会变。 */
  ino: number
  /** 核对的时刻（取目录修改时间之前）。 */
  scannedAt: number
  /** 这一层文件名列表的摘要；不知道（没列过目录）记空串。 */
  listing: string
}

export interface LevelScan extends LevelStamp {
  /** 这一层提示的版本号：每次写都换一个。 */
  rev: number
}

/** 一个文件的提示：文件名、文件里的 id（读不出记 null）、stat 签名（不知道记空串）。 */
export type HintRow = readonly [name: string, id: string | null, sig: string]

/** 一个记忆文件记下的链接：文件名、读它时的 stat 签名、文件里的记忆 id（读不出、不是记忆为 null）、指出去的链接。 */
export interface LinkFileRow {
  name: string
  sig: string
  sourceId: string | null
  links: readonly OutgoingLink[]
}

/** 主题索引的一页：文件名、主题名、曾用名、列在这页的记忆 id，以及记下时这页文件的 stat 签名。 */
export interface TopicPageRow {
  page: string
  title: string
  aliases: readonly string[]
  memberIds: readonly string[]
  /** 用的人拿它和文件现在的签名比：对不上就是这页在别处改过，这一行不能信。 */
  sig: string
}

export interface DerivedIndexOptions {
  /** 库文件的路径（接线层给 localStateDir 下的那个）。 */
  path: string
  log: MemoryLogger
  /** 只为测试注入：加载 node:sqlite。返回 undefined 或抛错按不可用处理。 */
  loadSqlite?: () => SqliteModule | undefined
}

export class DerivedIndex {
  private readonly path: string
  private readonly log: MemoryLogger
  private readonly loadSqlite: () => SqliteModule | undefined
  private db: DatabaseSync | undefined
  /** node:sqlite 加载不到或库建不起来：本实例此后什么都不记。 */
  private isBroken = false
  /** 读写失败提醒过了：同一个实例只提醒一次，免得每次查找都刷一行。 */
  private hasWarned = false
  /**
   * 这个进程里不再信「核对过」标记的层：增量记链接没记上（库忙、出错），或核对时这一层没读全。
   * 库里的标记可能删不掉（库正忙），所以在进程里也记一份；之后这一层整份核对成功才重新算数。
   */
  private readonly doubtedLinkLevels = new Set<string>()

  constructor(opts: DerivedIndexOptions) {
    // 懒打开：构造不做 I/O
    this.path = opts.path
    this.log = opts.log
    this.loadSqlite = opts.loadSqlite ?? loadSqliteQuietly
  }

  /** 这一层上次核对的记录；没核对过或库不可用返回 undefined。 */
  levelScan(level: string): LevelScan | undefined {
    const row = this.exec(db => db.prepare('SELECT mtime_ms, ino, scanned_at, listing, rev FROM level_scans WHERE level = ?').get(level) as
      { mtime_ms: number; ino: number; scanned_at: number; listing: string; rev: number } | undefined)
    return row === undefined ? undefined : { mtimeMs: row.mtime_ms, ino: row.ino, scannedAt: row.scanned_at, listing: row.listing, rev: row.rev }
  }

  /** 这一层记着的全部文件：文件名到 id 和 stat 签名。 */
  hints(level: string): Map<string, { id: string | null; sig: string }> {
    const rows = this.exec(db => db.prepare('SELECT name, id, sig FROM id_hints WHERE level = ?').all(level) as Array<{ name: string; id: string | null; sig: string }>) ?? []
    return new Map(rows.map(r => [r.name, { id: r.id, sig: r.sig }]))
  }

  /** 这一层里记着这个 id 的文件名。 */
  namesOf(level: string, id: string): string[] {
    const rows = this.exec(db => db.prepare('SELECT name FROM id_hints WHERE level = ? AND id = ?').all(level, id) as Array<{ name: string }>) ?? []
    return rows.map(r => r.name).sort()
  }

  /** 这一层的提示里有没有这个文件名。 */
  hasName(level: string, name: string): boolean {
    return this.exec(db => db.prepare('SELECT 1 FROM id_hints WHERE level = ? AND name = ?').get(level, name) !== undefined) ?? false
  }

  /**
   * 整层重记：这一层原来的行全部换成给的这些。expectedRev 是调用方动手前读到的版本号（当时没有记录就是 undefined）；
   * 这期间别人写过就不记，返回 false。
   */
  replaceLevel(level: string, stamp: LevelStamp, rows: readonly HintRow[], expectedRev: number | undefined): boolean {
    return this.exec(db => inTransaction(db, () => {
      if (currentRev(db, level) !== expectedRev) return false
      db.prepare('DELETE FROM id_hints WHERE level = ?').run(level)
      insertRows(db, level, rows)
      upsertScan(db, level, stamp)
      return true
    })) ?? false
  }

  /** 补记：去掉不在了的文件名，加上（或改写）新读的文件，换上新的扫描记录。版本号对不上就不记，返回 false。 */
  patchLevel(level: string, stamp: LevelStamp, removed: readonly string[], added: readonly HintRow[], expectedRev: number): boolean {
    return this.exec(db => inTransaction(db, () => {
      if (currentRev(db, level) !== expectedRev) return false
      const remove = db.prepare('DELETE FROM id_hints WHERE level = ? AND name = ?')
      for (const name of removed) remove.run(level, name)
      insertRows(db, level, added)
      upsertScan(db, level, stamp)
      return true
    })) ?? false
  }

  /**
   * 这几个文件彻底删掉了：当场去掉它们的行，库里不留名字。这一层的扫描记录换成一条对不上任何目录的（原来没有也补一条），
   * 版本号换新：下次用到重新核对，删之前就开始的扫描（手里的版本号是旧的，或是「还没有记录」）也提交不进来、带不回这些名字。
   */
  forgetNames(level: string, names: readonly string[]): void {
    this.exec(db => inTransaction(db, () => {
      const remove = db.prepare('DELETE FROM id_hints WHERE level = ? AND name = ?')
      for (const name of names) remove.run(level, name)
      for (const name of names) deleteLinkFile(db, level, name)
      upsertScan(db, level, UNVERIFIED_STAMP)
    }))
  }

  /** 这一层不在了，或它的提示信不过了：下次用到重新扫。主题索引的成员表一起丢，下次维护重记。 */
  dropLevel(level: string): void {
    this.exec(db => inTransaction(db, () => {
      db.prepare('DELETE FROM id_hints WHERE level = ?').run(level)
      db.prepare('DELETE FROM level_scans WHERE level = ?').run(level)
      deleteTopicPages(db, level)
      // 链接也信不过了：这一层回到没核对过，按目标查时算查不全
      deleteLinkLevel(db, level)
    }))
  }

  /** 这一层主题索引记着的各页，按文件名排；没记过或库不可用为空。 */
  topicPages(level: string): TopicPageRow[] {
    return this.exec(db => {
      const pages = db.prepare('SELECT page, title, sig FROM topic_pages WHERE level = ? ORDER BY page').all(level) as Array<{ page: string; title: string; sig: string }>
      const aliases = db.prepare('SELECT page, alias FROM topic_aliases WHERE level = ? ORDER BY ord').all(level) as Array<{ page: string; alias: string }>
      const members = db.prepare('SELECT page, id FROM topic_members WHERE level = ? ORDER BY ord').all(level) as Array<{ page: string; id: string }>
      const byPage = new Map(pages.map(p => [p.page, { page: p.page, title: p.title, aliases: [] as string[], memberIds: [] as string[], sig: p.sig }]))
      for (const a of aliases) byPage.get(a.page)?.aliases.push(a.alias)
      for (const m of members) byPage.get(m.page)?.memberIds.push(m.id)
      return [...byPage.values()]
    }) ?? []
  }

  /** 这条记忆列在这一层的哪几页（文件名，按名排）。 */
  pagesOf(level: string, id: string): string[] {
    const rows = this.exec(db => db.prepare('SELECT page FROM topic_members WHERE level = ? AND id = ? ORDER BY page').all(level, id) as Array<{ page: string }>) ?? []
    return rows.map(r => r.page)
  }

  /** 这一层的主题索引整份重记：原来的页、曾用名、成员全部换成给的这些。主题索引每次维护整份核对，不做补记。 */
  replaceTopicPages(level: string, pages: readonly TopicPageRow[]): void {
    this.exec(db => inTransaction(db, () => {
      deleteTopicPages(db, level)
      const page = db.prepare('INSERT INTO topic_pages(level, page, title, sig) VALUES (?, ?, ?, ?)')
      const alias = db.prepare('INSERT OR IGNORE INTO topic_aliases(level, page, alias, ord) VALUES (?, ?, ?, ?)')
      const member = db.prepare('INSERT OR IGNORE INTO topic_members(level, page, id, ord) VALUES (?, ?, ?, ?)')
      for (const p of pages) {
        page.run(level, p.page, p.title, p.sig)
        for (const [ord, a] of p.aliases.entries()) alias.run(level, p.page, a, ord)
        for (const [ord, id] of p.memberIds.entries()) member.run(level, p.page, id, ord)
      }
    }))
  }

  /** 这一层记着的链接，按文件名排；每个文件里的链接按记下的先后。没记过或库不可用为空。 */
  linkRows(level: string): LinkFileRow[] {
    return this.exec(db => {
      const files = db.prepare('SELECT name, sig, source FROM link_files WHERE level = ? ORDER BY name').all(level) as Array<{ name: string; sig: string; source: string | null }>
      const links = db.prepare('SELECT name, kind, target, digest FROM links WHERE level = ? ORDER BY name, ord').all(level) as Array<{ name: string; kind: string; target: string; digest: string | null }>
      const byName = new Map(files.map(f => [f.name, { name: f.name, sig: f.sig, sourceId: f.source, links: [] as OutgoingLink[] }]))
      for (const l of links) {
        // 不认识的种类（更新的版本记的）不交出去
        if (!(LINK_KINDS as readonly string[]).includes(l.kind)) continue
        byName.get(l.name)?.links.push({ kind: l.kind as LinkKind, targetId: l.target, ...(l.digest !== null ? { digest: l.digest } : {}) })
      }
      return [...byName.values()]
    }) ?? []
  }

  /**
   * 补记链接：去掉不在了的文件，换上（或新加）给的这些文件的行。isWholeLevel：调用方刚把这一层每个文件都按签名核对过，
   * 补完之后库里就是整层的样子，记下这一层核对过（同整份核对）。
   */
  patchLinks(level: string, removed: readonly string[], rows: readonly LinkFileRow[], isWholeLevel = false): void {
    const isDone = this.exec((db) => {
      inTransaction(db, () => {
        for (const name of [...removed, ...rows.map(r => r.name)]) deleteLinkFile(db, level, name)
        insertLinkRows(db, level, rows)
        if (isWholeLevel) db.prepare('INSERT OR REPLACE INTO link_levels(level) VALUES (?)').run(level)
      })
      return true
    }) === true
    this.noteLinkWrite(level, isDone, isWholeLevel)
  }

  /** 这一层的链接整份核对过没有；库不可用返回 undefined。 */
  isLinkLevelReconciled(level: string): boolean | undefined {
    const isMarked = this.exec(db => db.prepare('SELECT 1 FROM link_levels WHERE level = ?').get(level) !== undefined)
    return isMarked === undefined ? undefined : isMarked && !this.doubtedLinkLevels.has(level)
  }

  /** 整份核对后整层重记链接：原来的行全部换成给的这些，并记下这一层核对过。 */
  replaceLinks(level: string, rows: readonly LinkFileRow[]): void {
    const isDone = this.exec((db) => {
      inTransaction(db, () => {
        deleteLinkLevel(db, level)
        insertLinkRows(db, level, rows)
        db.prepare('INSERT OR REPLACE INTO link_levels(level) VALUES (?)').run(level)
      })
      return true
    }) === true
    this.noteLinkWrite(level, isDone, true)
  }

  /** 这一层没读全：「核对过」标记作废（库里删掉；删不掉也在这个进程里不再信它），下次按目标查时整层按文件核对。 */
  doubtLinkLevel(level: string): void {
    this.doubtedLinkLevels.add(level)
    this.exec(db => db.prepare('DELETE FROM link_levels WHERE level = ?').run(level))
  }

  /** 记链接写没写成：没写成，这一层的库已经和文件对不上，不再信它的标记；整层核对写成了，重新信。 */
  private noteLinkWrite(level: string, isDone: boolean, isWholeLevel: boolean): void {
    if (!isDone) this.doubtedLinkLevels.add(level)
    else if (isWholeLevel) this.doubtedLinkLevels.delete(level)
  }

  /**
   * 按目标查：这几层里指向 target 的链接（来源 id、种类、摘要），只走目标索引。unreconciled 是还没整份核对过的层（这几层的答案不全）。
   * 库不可用返回 undefined。
   */
  linksToTarget(target: string, levels: readonly string[]): { refs: Array<{ level: string; sourceId: string; kind: LinkKind; digest?: string }>; unreconciled: string[] } | undefined {
    return this.exec(db => {
      const wanted = new Set(levels)
      const rows = db.prepare('SELECT l.level AS level, l.kind AS kind, l.digest AS digest, f.source AS source FROM links l JOIN link_files f ON f.level = l.level AND f.name = l.name WHERE l.target = ?')
        .all(target) as Array<{ level: string; kind: string; digest: string | null; source: string | null }>
      const reconciled = new Set((db.prepare('SELECT level FROM link_levels').all() as Array<{ level: string }>).map(r => r.level))
      const refs = rows
        .filter(r => wanted.has(r.level) && r.source !== null && (LINK_KINDS as readonly string[]).includes(r.kind))
        .map(r => ({ level: r.level, sourceId: r.source!, kind: r.kind as LinkKind, ...(r.digest !== null ? { digest: r.digest } : {}) }))
      return { refs, unreconciled: levels.filter(level => !reconciled.has(level) || this.doubtedLinkLevels.has(level)) }
    })
  }

  close(): void {
    const db = this.db
    this.db = undefined
    if (db !== undefined) closeQuietly(db)
  }

  /** 在库上执行；库不可用返回 undefined。执行中出错关掉连接，下次重新打开；是库坏了就删掉，下次重建。 */
  private exec<T>(fn: (db: DatabaseSync) => T): T | undefined {
    const db = this.open()
    if (db === undefined) return undefined
    try {
      return fn(db)
    } catch (err) {
      this.close()
      if (isSqliteCorrupt(err)) this.removeFiles()
      this.warnOnce(err)
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
        this.db = openIndex(sqlite, this.path)
      } catch (err) {
        // 别的连接正占着：这一次不用，不删库，下次再开
        if (isSqliteBusy(err)) return undefined
        // 结构版本不同、库文件损坏：库里的东西都能重算，换新库。别的原因（权限、磁盘）不删
        if (!(err instanceof SchemaMismatchError) && !isSqliteCorrupt(err)) throw err
        this.removeFiles()
        this.db = openIndex(sqlite, this.path)
      }
    } catch (err) {
      if (isSqliteBusy(err)) return undefined
      return this.giveUp(describeError(err))
    }
    return this.db
  }

  private removeFiles(): void {
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      try { rmSync(this.path + suffix, { force: true }) } catch { /* 删不掉：下次打开再试 */ }
    }
  }

  private warnOnce(err: unknown): void {
    if (this.hasWarned || isSqliteBusy(err)) return
    this.hasWarned = true
    this.log.warn(`[plastic-memory] 派生索引库读写失败，这一次不用它：${this.path}（${describeError(err)}）`)
  }

  private giveUp(reason: string): undefined {
    this.isBroken = true
    this.log.warn(`[plastic-memory] 派生索引库不可用，查找记忆改回逐个读文件：${this.path}（${reason}）`)
    return undefined
  }
}

/** 对不上任何目录的扫描记录：修改时间、目录身份都取不可能的值，用到时一定重新核对。 */
const UNVERIFIED_STAMP: LevelStamp = { mtimeMs: -1, ino: -1, scannedAt: 0, listing: '' }

class SchemaMismatchError extends Error {
  constructor(version: number) {
    super(`库的结构版本是 ${version}，本插件用 ${SCHEMA_VERSION}`)
  }
}

function openIndex(sqlite: SqliteModule, path: string): DatabaseSync {
  const db = new sqlite.DatabaseSync(path)
  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`)
    const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    if (version !== 0 && version !== SCHEMA_VERSION) throw new SchemaMismatchError(version)
    // 丢了能重算：不逐次刷盘。回滚日志提交后截成空文件，删掉的行当场抹掉
    db.exec('PRAGMA journal_mode = TRUNCATE')
    db.exec('PRAGMA synchronous = OFF')
    db.exec('PRAGMA secure_delete = ON')
    if (version === 0) {
      inTransaction(db, () => {
        db.exec('CREATE TABLE IF NOT EXISTS level_scans(level TEXT PRIMARY KEY, mtime_ms REAL NOT NULL, ino REAL NOT NULL, scanned_at REAL NOT NULL, listing TEXT NOT NULL, rev REAL NOT NULL)')
        db.exec('CREATE TABLE IF NOT EXISTS id_hints(level TEXT NOT NULL, name TEXT NOT NULL, id TEXT, sig TEXT NOT NULL, PRIMARY KEY(level, name))')
        db.exec('CREATE INDEX IF NOT EXISTS id_hints_by_id ON id_hints(level, id)')
        db.exec('CREATE TABLE IF NOT EXISTS topic_pages(level TEXT NOT NULL, page TEXT NOT NULL, title TEXT NOT NULL, sig TEXT NOT NULL, PRIMARY KEY(level, page))')
        db.exec('CREATE TABLE IF NOT EXISTS topic_aliases(level TEXT NOT NULL, page TEXT NOT NULL, alias TEXT NOT NULL, ord INTEGER NOT NULL, PRIMARY KEY(level, page, alias))')
        db.exec('CREATE TABLE IF NOT EXISTS topic_members(level TEXT NOT NULL, page TEXT NOT NULL, id TEXT NOT NULL, ord INTEGER NOT NULL, PRIMARY KEY(level, page, id))')
        db.exec('CREATE INDEX IF NOT EXISTS topic_members_by_id ON topic_members(level, id)')
        db.exec('CREATE TABLE IF NOT EXISTS link_files(level TEXT NOT NULL, name TEXT NOT NULL, sig TEXT NOT NULL, source TEXT, PRIMARY KEY(level, name))')
        db.exec('CREATE TABLE IF NOT EXISTS links(level TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, target TEXT NOT NULL, digest TEXT, ord INTEGER NOT NULL, PRIMARY KEY(level, name, kind, target))')
        db.exec('CREATE INDEX IF NOT EXISTS links_by_target ON links(target)')
        db.exec('CREATE TABLE IF NOT EXISTS link_levels(level TEXT PRIMARY KEY)')
        db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
      })
    }
    try {
      db.prepare('SELECT level, mtime_ms, ino, scanned_at, listing, rev FROM level_scans LIMIT 1').get()
      db.prepare('SELECT level, name, id, sig FROM id_hints LIMIT 1').get()
      db.prepare('SELECT level, page, title, sig FROM topic_pages LIMIT 1').get()
      db.prepare('SELECT level, page, alias, ord FROM topic_aliases LIMIT 1').get()
      db.prepare('SELECT level, page, id, ord FROM topic_members LIMIT 1').get()
      db.prepare('SELECT level, name, sig, source FROM link_files LIMIT 1').get()
      db.prepare('SELECT level, name, kind, target, digest, ord FROM links LIMIT 1').get()
      db.prepare('SELECT level FROM link_levels LIMIT 1').get()
    } catch (err) {
      // 版本号对、表的样子不对（开发中的旧库）：同样换新库
      if (isSqliteBusy(err) || isSqliteCorrupt(err)) throw err
      throw new SchemaMismatchError(version)
    }
    return db
  } catch (err) {
    closeQuietly(db)
    throw err
  }
}

function currentRev(db: DatabaseSync, level: string): number | undefined {
  return (db.prepare('SELECT rev FROM level_scans WHERE level = ?').get(level) as { rev: number } | undefined)?.rev
}

function deleteTopicPages(db: DatabaseSync, level: string): void {
  for (const table of ['topic_pages', 'topic_aliases', 'topic_members']) db.prepare(`DELETE FROM ${table} WHERE level = ?`).run(level)
}

function deleteLinkFile(db: DatabaseSync, level: string, name: string): void {
  db.prepare('DELETE FROM link_files WHERE level = ? AND name = ?').run(level, name)
  db.prepare('DELETE FROM links WHERE level = ? AND name = ?').run(level, name)
}

/** 这一层的链接全部去掉，回到没核对过。 */
function deleteLinkLevel(db: DatabaseSync, level: string): void {
  db.prepare('DELETE FROM link_files WHERE level = ?').run(level)
  db.prepare('DELETE FROM links WHERE level = ?').run(level)
  db.prepare('DELETE FROM link_levels WHERE level = ?').run(level)
}

function insertLinkRows(db: DatabaseSync, level: string, rows: readonly LinkFileRow[]): void {
  const file = db.prepare('INSERT OR REPLACE INTO link_files(level, name, sig, source) VALUES (?, ?, ?, ?)')
  const link = db.prepare('INSERT OR IGNORE INTO links(level, name, kind, target, digest, ord) VALUES (?, ?, ?, ?, ?, ?)')
  for (const row of rows) {
    file.run(level, row.name, row.sig, row.sourceId)
    for (const [ord, l] of row.links.entries()) link.run(level, row.name, l.kind, l.targetId, l.digest ?? null, ord)
  }
}

function insertRows(db: DatabaseSync, level: string, rows: readonly HintRow[]): void {
  const insert = db.prepare('INSERT OR REPLACE INTO id_hints(level, name, id, sig) VALUES (?, ?, ?, ?)')
  for (const [name, id, sig] of rows) insert.run(level, name, id, sig)
}

function upsertScan(db: DatabaseSync, level: string, stamp: LevelStamp): void {
  // 版本号每次换一个随机数：删掉重记之后也不会和别人手里的旧版本号撞上
  const rev = Math.floor(Math.random() * 2 ** 52) + 1
  db.prepare('INSERT OR REPLACE INTO level_scans(level, mtime_ms, ino, scanned_at, listing, rev) VALUES (?, ?, ?, ?, ?, ?)')
    .run(level, stamp.mtimeMs, stamp.ino, stamp.scannedAt, stamp.listing, rev)
}

function closeQuietly(db: DatabaseSync): void {
  try {
    db.close()
  } catch {
    // 已关闭
  }
}
