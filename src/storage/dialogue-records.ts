import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { inTransaction, isSqliteBusy, isSqliteCorrupt, loadSqliteQuietly, type SqliteModule } from './root-lock.ts'
import { describeError } from './state-files.ts'
import type { MemoryLogger } from './table.ts'

/**
 * 对话记录库：从会话日志算出来的原话段，供原话检索用。一个 SQLite 库，放在记忆根之外、每台机器一份，删了能从会话日志整份重建。
 * 这里只管库：收已经算好的行，记水位，查询。读会话、判断哪些消息该收、分词都在调用方。
 *
 * - 代（generation）：库里的行都属于某一代，一代对应一组规则版本（切段、分词、收录）。规则变了开新的一代从头建，
 *   建好之前查询继续读旧的一代，建好再切过去、删掉旧的。读的一代和写的一代是同一个时，就是普通的边建边用。
 * - 会话修订号：每个会话在每一代里有一个修订号。会话被移出库（会话没了、用户不让回看）时行删掉、换修订号、留下记号；
 *   手里拿着旧修订号的批次提交不进来，删掉的不会被写回。
 * - 批次：一批里的段、全文索引行、轮次边界和水位在同一个事务里；提交时核对这一代还在、修订号没变、水位就是这一批起算的那个，
 *   对不上整批不要。水位因此只往前走，两个进程同时追同一个会话也不会写出重复的段。
 * - 库里是对话原文：删掉的行当场抹掉（secure_delete），不用 WAL，免得删掉的对话留在日志文件里。
 * - 库打不开、被占着、坏了、盘满了，都抛 DialogueStoreUnavailable，调用方这一次只查记忆。坏了或结构不对的库删掉，下次重建；
 *   被占着的不删。
 */

const SCHEMA_VERSION = 1

/** 库忙时最多等这么久：调用是同步的，等的时候整个进程都停着。调用方拿到「忙」自己隔一会儿再试。 */
const BUSY_TIMEOUT_MS = 200

/** 决定库里的行长什么样的三样规则版本：任何一样变了，已有的行都要重算。 */
export interface DialogueVersions {
  segmentRule: number
  tokenizer: number
  intake: number
}

/** 库的一代。dictionary 是建 w 列时用的词典内容标识，没有词典时为空串。 */
export interface DialogueGeneration {
  gen: number
  versions: DialogueVersions
  dictionary: string
  /** 待建的会话都建完过一次。之后新出现的会话照常补，不会变回 false。 */
  isComplete: boolean
  /** 有段的整词列要按 dictionary 重算：行号在它之后的还没算；没有要重算的为 undefined。 */
  wRewriteAfter: number | undefined
}

/**
 * 库的状态：none 还没建；building 第一次在建，建好的部分可以查；ready 可用；rebuilding 规则变了在重建，查询读旧的一代。
 * read 是查询读的一代，write 是新行写进的一代；不在重建时两者是同一个。
 */
export type DialogueStoreState =
  | { status: 'none' }
  | { status: 'building' | 'ready' | 'rebuilding'; read: DialogueGeneration; write: DialogueGeneration }

/** 一段原话和它的三列索引词。 */
export interface DialogueSegmentInput {
  turnSeq: number
  seq: number
  segment: number
  at?: number
  speaker: string
  text: string
  w: string
  b: string
  c: string
}

/** 一个会话的一批：从 fromWatermark 起算、算到 watermark 为止的全部段和轮次边界。 */
export interface DialogueBatch {
  gen: number
  sessionId: string
  /** 开始追这个会话时拿到的修订号。 */
  revision: number
  /** 算这一批的整词列用的词典；分词器降级、整词列是空的时给空串。和这一代记的不一样（别人换了词典）整批不要。 */
  dictionary: string
  /** 这一批起算时的水位：库里的水位不是它，说明别人已经提交过，这一批不要。 */
  fromWatermark: number
  watermark: number
  segments: readonly DialogueSegmentInput[]
  turns: ReadonlyArray<{ turnSeq: number; at?: number }>
}

/** 会话在库里的进度。isRemoved：已移出库（会话没了或不让回看），要重新收得先 startSession。 */
export interface DialogueSessionState {
  watermark: number
  revision: number
  isRemoved: boolean
}

/** 会话自己的两样属性，查询时用来筛。 */
export interface DialogueSessionInfo {
  cwd: string | undefined
  isSubagent: boolean
}

export interface DialogueHit extends DialogueSessionInfo {
  sessionId: string
  turnSeq: number
  seq: number
  segment: number
  at: number | undefined
  speaker: string
  text: string
  /** bm25 分，越小越相关。 */
  score: number
}

export interface DialogueSearchOptions {
  limit: number
  /** w、b、c 三列的权重。 */
  weights: readonly [number, number, number]
  /** 只要这些说话人的段；不给就都要。 */
  speakers?: readonly string[]
  /** 只要工作目录在这里面的会话；不给就都要。 */
  cwds?: readonly string[]
  /** 不要这些会话的段。 */
  excludeSessionIds?: readonly string[]
}

/** 已收了多少：sessions 是收过且不在待建队列里的会话数，queued 是还在排队的，coveredUntil 是库里最晚一段的时刻。 */
export interface DialogueCoverage {
  sessions: number
  queued: number
  coveredUntil: number | undefined
}

/** 原话这一路这一次用不了。busy：库正被别的连接占着，过一会儿再试；其余：库打不开或读写失败。 */
export class DialogueStoreUnavailable extends Error {
  readonly isBusy: boolean
  constructor(reason: string, isBusy = false) {
    super(`对话记录库这一次用不了：${reason}`)
    this.name = 'DialogueStoreUnavailable'
    this.isBusy = isBusy
  }
}

export interface DialogueRecordStoreOptions {
  /** 库文件的路径（接线层给 localStateDir 下的那个）。 */
  path: string
  log: MemoryLogger
  /** 只为测试注入：加载 node:sqlite。返回 undefined 或抛错按不可用处理。 */
  loadSqlite?: () => SqliteModule | undefined
}

interface GenRow { gen: number; segment_rule: number; tokenizer: number; intake: number; dictionary: string; is_read: number; is_complete: number; w_rewrite_after: number | null }

const toGeneration = (r: GenRow): DialogueGeneration => ({
  gen: r.gen, versions: { segmentRule: r.segment_rule, tokenizer: r.tokenizer, intake: r.intake }, dictionary: r.dictionary, isComplete: r.is_complete === 1,
  wRewriteAfter: r.w_rewrite_after ?? undefined,
})
const isSameVersions = (a: DialogueVersions, b: DialogueVersions) => a.segmentRule === b.segmentRule && a.tokenizer === b.tokenizer && a.intake === b.intake

/** 按代存行的几张表：删一代、删一个会话都照这个顺序走，全文索引行要在段还在的时候先删。 */
const SESSION_TABLES = ['turns', 'queue'] as const

export class DialogueRecordStore {
  private readonly path: string
  private readonly log: MemoryLogger
  private readonly loadSqlite: () => SqliteModule | undefined
  private db: DatabaseSync | undefined

  constructor(opts: DialogueRecordStoreOptions) {
    // 懒打开：构造不做 I/O
    this.path = opts.path
    this.log = opts.log
    this.loadSqlite = opts.loadSqlite ?? loadSqliteQuietly
  }

  /** 库现在的状态。库文件还不存在时不建它。 */
  state(): DialogueStoreState {
    if (this.db === undefined && !existsSync(this.path)) return { status: 'none' }
    return this.run(db => stateOf(db))
  }

  /**
   * 准备好按这组规则写：没有库就建，规则和正在写的那一代不一样就开新的一代。sessionStore 是会话日志所在的位置，
   * 和库里记的不一样说明这是别处的会话建的库，整库清掉从头来。返回准备好之后的状态。
   */
  prepare(versions: DialogueVersions, dictionary: string, sessionStore: string): DialogueStoreState {
    return this.run(db => inTransaction(db, () => {
      const recorded = (db.prepare("SELECT value FROM meta WHERE key = 'session_store'").get() as { value: string } | undefined)?.value
      if (recorded !== sessionStore) {
        if (recorded !== undefined) for (const g of generations(db)) dropGeneration(db, g.gen)
        db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('session_store', ?)").run(sessionStore)
      }
      const before = stateOf(db)
      if (before.status !== 'none' && isSameVersions(before.write.versions, versions)) return before
      const insert = db.prepare('INSERT INTO generations(gen, segment_rule, tokenizer, intake, dictionary, is_read, is_complete) VALUES (?, ?, ?, ?, ?, ?, 0)')
      // 代号不复用（清空换库之后也接着往上数）：手里还拿着旧代号的人提交不进来
      const last = Number((db.prepare("SELECT value FROM meta WHERE key = 'last_gen'").get() as { value: string } | undefined)?.value ?? 0)
      const nextGen = Math.max(last, ...generations(db).map(g => g.gen)) + 1
      db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('last_gen', ?)").run(String(nextGen))
      if (before.status === 'none') {
        insert.run(nextGen, versions.segmentRule, versions.tokenizer, versions.intake, dictionary, 1)
        return stateOf(db)
      }
      // 重建到一半规则又变了：那半代没用了
      if (before.status === 'rebuilding') dropGeneration(db, before.write.gen)
      // 第一次还没建完规则就变了：建好的那部分是旧规则算的，留着也要整份重算，直接换掉
      const isReplacingRead = !before.read.isComplete
      if (isReplacingRead) dropGeneration(db, before.read.gen)
      insert.run(nextGen, versions.segmentRule, versions.tokenizer, versions.intake, dictionary, isReplacingRead ? 1 : 0)
      return stateOf(db)
    }))
  }

  /**
   * 这一代待建的会话都建完了。它是重建出来的新一代时，查询从此读它，旧的一代连行一起删掉。
   * 队里还有 stillQueued 之外的会话（别人刚排进来的），或这一代已经不是正在写的那一代，什么都不做，返回 false。
   * 队列在同一个事务里看：看完到切换之间别人排不进来。
   */
  completeBuild(gen: number, stillQueued: readonly string[] = []): boolean {
    return this.run(db => inTransaction(db, () => {
      const state = stateOf(db)
      if (state.status === 'none' || state.write.gen !== gen) return false
      const allowed = new Set(stillQueued)
      const queued = db.prepare('SELECT session_id FROM queue WHERE gen = ?').all(gen) as Array<{ session_id: string }>
      if (queued.some(q => !allowed.has(q.session_id))) return false
      db.prepare('UPDATE generations SET is_complete = 1, is_read = 1 WHERE gen = ?').run(gen)
      for (const g of generations(db)) if (g.gen !== gen) dropGeneration(db, g.gen)
      return true
    }))
  }

  /**
   * 换词典：记下新词典，这一代已有的段从头重算整词列。之后只收按新词典算的批。
   * 已经是这个词典返回 true 不动；这一代不在了返回 false。
   */
  beginDictionary(gen: number, dictionary: string): boolean {
    return this.run(db => inTransaction(db, () => {
      const row = db.prepare('SELECT dictionary FROM generations WHERE gen = ?').get(gen) as { dictionary: string } | undefined
      if (row === undefined) return false
      if (row.dictionary !== dictionary) db.prepare('UPDATE generations SET dictionary = ?, w_rewrite_after = 0 WHERE gen = ?').run(dictionary, gen)
      return true
    }))
  }

  /** 会话在这一代里的进度；没收过返回 undefined。 */
  session(gen: number, sessionId: string): DialogueSessionState | undefined {
    return this.run(db => sessionOf(db, gen, sessionId))
  }

  /**
   * 开始（或接着）收一个会话，返回它的水位和修订号。isOpen 记下这个会话此刻是不是开着。没收过的从 -1 起；移出过的换一个修订号从头收。
   * 这一代不在了返回 undefined。
   */
  startSession(gen: number, sessionId: string, info: DialogueSessionInfo & { isOpen?: boolean }): DialogueSessionState | undefined {
    return this.run(db => inTransaction(db, () => {
      if (!hasGeneration(db, gen)) return undefined
      const existing = sessionOf(db, gen, sessionId)
      const cwd = info.cwd ?? null
      const isSubagent = info.isSubagent ? 1 : 0
      const isOpen = info.isOpen === true ? 1 : 0
      if (existing !== undefined && !existing.isRemoved) {
        db.prepare('UPDATE sessions SET cwd = ?, is_subagent = ?, is_open = ? WHERE gen = ? AND session_id = ?').run(cwd, isSubagent, isOpen, gen, sessionId)
        return existing
      }
      const revision = newRevision()
      db.prepare('INSERT OR REPLACE INTO sessions(gen, session_id, watermark, revision, cwd, is_subagent, is_open, is_removed) VALUES (?, ?, -1, ?, ?, ?, ?, 0)')
        .run(gen, sessionId, revision, cwd, isSubagent, isOpen)
      return { watermark: -1, revision, isRemoved: false }
    }))
  }

  /**
   * 把一个会话移出库（会话没了，或用户不让回看）：各代里它的段、全文索引行、轮次边界、排队记录都删掉，
   * 换修订号并留下记号。正在追它的批次因此提交不进来。
   */
  removeSession(sessionId: string): void {
    this.run(db => inTransaction(db, () => {
      deleteSessionRows(db, sessionId)
      const mark = db.prepare('UPDATE sessions SET watermark = -1, revision = ?, is_removed = 1 WHERE gen = ? AND session_id = ?')
      for (const g of generations(db)) mark.run(newRevision(), g.gen, sessionId)
    }))
  }

  /** 这一代里收过、没被移出的会话 id。对账时拿它和现有的会话比。 */
  sessionIds(gen: number): string[] {
    return this.run(db => (db.prepare('SELECT session_id FROM sessions WHERE gen = ? AND is_removed = 0 ORDER BY session_id').all(gen) as Array<{ session_id: string }>).map(r => r.session_id))
  }

  /**
   * 提交一批。这一代不在了、会话被移出过或换了修订号、库里的水位不是这一批起算的那个，都整批不要，返回 false。
   * 一条消息的全部段要在同一批里：水位推过去之后，这条消息不会再被处理。
   */
  commitBatch(batch: DialogueBatch): boolean {
    return this.run(db => inTransaction(db, () => {
      const generation = db.prepare('SELECT dictionary, w_rewrite_after FROM generations WHERE gen = ?').get(batch.gen) as { dictionary: string; w_rewrite_after: number | null } | undefined
      if (generation === undefined) return false
      const isWithoutWords = batch.dictionary === '' && generation.dictionary !== ''
      if (batch.dictionary !== generation.dictionary && !isWithoutWords) return false
      const session = sessionOf(db, batch.gen, batch.sessionId)
      if (session === undefined || session.isRemoved || session.revision !== batch.revision) return false
      if (session.watermark !== batch.fromWatermark || batch.watermark < batch.fromWatermark) return false
      const segment = db.prepare('INSERT INTO segments(gen, session_id, turn_seq, seq, segment, at, speaker, text) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      const fts = db.prepare('INSERT INTO segments_fts(rowid, w, b, c) VALUES (?, ?, ?, ?)')
      let firstId: number | undefined
      for (const s of batch.segments) {
        const { lastInsertRowid } = segment.run(batch.gen, batch.sessionId, s.turnSeq, s.seq, s.segment, s.at ?? null, s.speaker, s.text)
        firstId ??= Number(lastInsertRowid)
        fts.run(lastInsertRowid, s.w, s.b, s.c)
      }
      // 分词器降级时收的段没有整词列：记下从哪开始要补算，词典加载得起来的进程会接着补
      if (isWithoutWords && firstId !== undefined) {
        db.prepare('UPDATE generations SET w_rewrite_after = ? WHERE gen = ?').run(Math.min(generation.w_rewrite_after ?? firstId - 1, firstId - 1), batch.gen)
      }
      const turn = db.prepare('INSERT OR IGNORE INTO turns(gen, session_id, turn_seq, at) VALUES (?, ?, ?, ?)')
      for (const t of batch.turns) turn.run(batch.gen, batch.sessionId, t.turnSeq, t.at ?? null)
      db.prepare('UPDATE sessions SET watermark = ? WHERE gen = ? AND session_id = ?').run(batch.watermark, batch.gen, batch.sessionId)
      return true
    }))
  }

  /** 上次收的时候还开着的会话：开着的会话后面还会有新消息，关了之后要再收一次尾巴。 */
  openSessionIds(gen: number): string[] {
    return this.run(db => (db.prepare('SELECT session_id FROM sessions WHERE gen = ? AND is_removed = 0 AND is_open = 1 ORDER BY session_id').all(gen) as Array<{ session_id: string }>).map(r => r.session_id))
  }

  /** 把会话排进这一代的待建队列，已经在队里的不重复排。 */
  enqueue(gen: number, sessionIds: readonly string[]): void {
    this.run(db => inTransaction(db, () => {
      if (!hasGeneration(db, gen)) return
      const insert = db.prepare('INSERT OR IGNORE INTO queue(gen, session_id) VALUES (?, ?)')
      for (const id of sessionIds) insert.run(gen, id)
    }))
  }

  /** 待建队列最前面的几个会话，按排进来的先后。 */
  queued(gen: number, limit: number): string[] {
    return this.run(db => (db.prepare('SELECT session_id FROM queue WHERE gen = ? ORDER BY position LIMIT ?').all(gen, limit) as Array<{ session_id: string }>).map(r => r.session_id))
  }

  /** 待建队列里排在 afterPosition 之后的几个会话，带上各自的位置：一个个往后翻用。 */
  queuedAfter(gen: number, afterPosition: number, limit: number): Array<{ position: number; sessionId: string }> {
    return this.run(db => (db.prepare('SELECT position, session_id FROM queue WHERE gen = ? AND position > ? ORDER BY position LIMIT ?').all(gen, afterPosition, limit) as Array<{ position: number; session_id: string }>)
      .map(r => ({ position: r.position, sessionId: r.session_id })))
  }

  /** 这个会话建完了（或不用建了），从待建队列里拿掉。 */
  dequeue(gen: number, sessionId: string): void {
    this.run(db => { db.prepare('DELETE FROM queue WHERE gen = ? AND session_id = ?').run(gen, sessionId) })
  }

  coverage(gen: number): DialogueCoverage {
    return this.run(db => {
      const count = (sql: string) => (db.prepare(sql).get(gen) as { n: number }).n
      const sessions = count('SELECT COUNT(*) AS n FROM sessions s WHERE s.gen = ? AND s.is_removed = 0 AND NOT EXISTS (SELECT 1 FROM queue q WHERE q.gen = s.gen AND q.session_id = s.session_id)')
      const queued = count('SELECT COUNT(*) AS n FROM queue WHERE gen = ?')
      const until = (db.prepare('SELECT MAX(at) AS at FROM segments WHERE gen = ?').get(gen) as { at: number | null }).at
      return { sessions, queued, coveredUntil: until ?? undefined }
    })
  }

  /** 全文检索：match 是调用方用同一套分词拼好的查询式。按相关度从高到低。 */
  search(gen: number, match: string, opts: DialogueSearchOptions): DialogueHit[] {
    return this.run(db => {
      const where: string[] = ['segments_fts MATCH ?', 's.gen = ?']
      const args: Array<string | number> = [match, gen]
      const among = (column: string, values: readonly string[], negate = false) => {
        where.push(`${column} ${negate ? 'NOT ' : ''}IN (${values.map(() => '?').join(', ')})`)
        args.push(...values)
      }
      if (opts.speakers !== undefined) among('s.speaker', opts.speakers)
      if (opts.cwds !== undefined) among('se.cwd', opts.cwds)
      if (opts.excludeSessionIds !== undefined && opts.excludeSessionIds.length > 0) among('s.session_id', opts.excludeSessionIds, true)
      const rows = db.prepare(`SELECT s.session_id, s.turn_seq, s.seq, s.segment, s.at, s.speaker, CAST(s.text AS BLOB) AS text, se.cwd, se.is_subagent,
          bm25(segments_fts, ?, ?, ?) AS score
        FROM segments_fts JOIN segments s ON s.id = segments_fts.rowid
        JOIN sessions se ON se.gen = s.gen AND se.session_id = s.session_id
        WHERE ${where.join(' AND ')} ORDER BY score, s.id LIMIT ?`).all(...opts.weights, ...args, opts.limit) as unknown as HitRow[]
      return rows.map(r => ({ ...toSegment(r), cwd: r.cwd ?? undefined, isSubagent: r.is_subagent === 1, score: r.score }))
    })
  }

  /** 一个会话里序号在 [fromSeq, toSeq] 的段，按序号、段序号排。拼前后文、按引用展开时用。 */
  segmentsOf(gen: number, sessionId: string, fromSeq: number, toSeq: number): Array<Omit<DialogueHit, 'score' | 'cwd' | 'isSubagent'>> {
    return this.run(db => (db.prepare('SELECT session_id, turn_seq, seq, segment, at, speaker, CAST(text AS BLOB) AS text FROM segments WHERE gen = ? AND session_id = ? AND seq >= ? AND seq <= ? ORDER BY seq, segment')
      .all(gen, sessionId, fromSeq, toSeq) as unknown as SegmentRow[]).map(toSegment))
  }

  /** 一个会话的轮次边界，按先后；没有文本的空轮也在。 */
  turnsOf(gen: number, sessionId: string): Array<{ turnSeq: number; at: number | undefined }> {
    return this.run(db => (db.prepare('SELECT turn_seq, at FROM turns WHERE gen = ? AND session_id = ? ORDER BY turn_seq').all(gen, sessionId) as Array<{ turn_seq: number; at: number | null }>)
      .map(r => ({ turnSeq: r.turn_seq, at: r.at ?? undefined })))
  }

  /** 换词典后重算 w 列用：这一代里行号在 afterId 之后的一批段，按行号排。 */
  segmentsAfter(gen: number, afterId: number, limit: number): Array<{ id: number; text: string }> {
    return this.run(db => (db.prepare('SELECT id, CAST(text AS BLOB) AS text FROM segments WHERE gen = ? AND id > ? ORDER BY id LIMIT ?').all(gen, afterId, limit) as Array<{ id: number; text: Uint8Array }>)
      .map(r => ({ id: r.id, text: textOf(r.text) })))
  }

  /**
   * 换掉这些段的整词列，并记下算到了哪（upTo 是这一批最后一个行号）。不给 upTo 表示后面没有段了：
   * 在同一个事务里再看一眼，确实没有才记成算完（别的进程可能刚好又收了没有整词列的段）。
   * 这一代不在了、或它记的词典已经不是 dictionary（别人又换了），什么都不做，返回 false。期间被删掉的段跳过。
   */
  rewriteW(gen: number, dictionary: string, rows: ReadonlyArray<{ id: number; w: string }>, upTo?: number): boolean {
    return this.run(db => inTransaction(db, () => {
      const row = db.prepare('SELECT dictionary FROM generations WHERE gen = ?').get(gen) as { dictionary: string } | undefined
      if (row === undefined || row.dictionary !== dictionary) return false
      const update = db.prepare('UPDATE segments_fts SET w = ? WHERE rowid = (SELECT id FROM segments WHERE id = ? AND gen = ?)')
      for (const r of rows) update.run(r.w, r.id, gen)
      if (upTo !== undefined) db.prepare('UPDATE generations SET w_rewrite_after = ? WHERE gen = ?').run(upTo, gen)
      else db.prepare('UPDATE generations SET w_rewrite_after = NULL WHERE gen = ? AND NOT EXISTS (SELECT 1 FROM segments WHERE gen = ? AND id > w_rewrite_after)').run(gen, gen)
      return true
    }))
  }

  /** 关连接、删库文件。之后再用会从空库开始。删不掉会抛：用户要删的东西不能悄悄留着。 */
  destroy(): void {
    this.close()
    for (const suffix of FILE_SUFFIXES) rmSync(this.path + suffix, { force: true })
  }

  close(): void {
    const db = this.db
    this.db = undefined
    if (db !== undefined) closeQuietly(db)
  }

  /** 在库上执行。出任何错都关掉连接、抛「这一次用不了」；是库坏了就删掉，下次从空库重建。 */
  private run<T>(fn: (db: DatabaseSync) => T): T {
    const db = this.open()
    try {
      return fn(db)
    } catch (err) {
      this.close()
      if (isSqliteCorrupt(err)) this.removeFiles()
      throw this.unavailable(err)
    }
  }

  private open(): DatabaseSync {
    if (this.db !== undefined) return this.db
    let sqlite: SqliteModule | undefined
    try {
      sqlite = this.loadSqlite()
    } catch {
      sqlite = undefined
    }
    if (sqlite === undefined) throw new DialogueStoreUnavailable('node:sqlite 不可用')
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      try {
        this.db = openStore(sqlite, this.path)
      } catch (err) {
        // 结构版本不同、库文件损坏：库里的东西都能从会话日志重算，换新库。被占着或别的原因（权限、磁盘）不删
        if (!(err instanceof SchemaMismatchError) && !isSqliteCorrupt(err)) throw err
        // 结构不对的库可能正被用它的那一版插件写着：拿得到写锁才换，拿不到这一次不用
        if (err instanceof SchemaMismatchError) assertNotInUse(sqlite, this.path)
        this.removeFiles()
        this.db = openStore(sqlite, this.path)
      }
    } catch (err) {
      throw this.unavailable(err)
    }
    return this.db
  }

  private unavailable(err: unknown): DialogueStoreUnavailable {
    if (err instanceof DialogueStoreUnavailable) return err
    if (isSqliteBusy(err)) return new DialogueStoreUnavailable('正被别的连接占着', true)
    this.log.warn(`[plastic-memory] 对话记录库读写失败，这一次只查记忆：${this.path}（${describeError(err)}）`)
    return new DialogueStoreUnavailable(describeError(err))
  }

  private removeFiles(): void {
    for (const suffix of FILE_SUFFIXES) {
      try { rmSync(this.path + suffix, { force: true }) } catch { /* 删不掉：下次打开再试 */ }
    }
  }
}

interface SegmentRow { session_id: string; turn_seq: number; seq: number; segment: number; at: number | null; speaker: string; text: Uint8Array }

/** 正文按字节取回再解码：按文本取的话，遇到正文里的 NUL 字符会被截断。 */
const textOf = (bytes: Uint8Array) => Buffer.from(bytes).toString('utf8')
interface HitRow extends SegmentRow { cwd: string | null; is_subagent: number; score: number }

const toSegment = (r: SegmentRow) => ({ sessionId: r.session_id, turnSeq: r.turn_seq, seq: r.seq, segment: r.segment, at: r.at ?? undefined, speaker: r.speaker, text: textOf(r.text) })

const FILE_SUFFIXES = ['', '-journal', '-wal', '-shm'] as const

/** 修订号每次换一个随机数：会话移出再收回来之后，不会和别人手里的旧修订号撞上。 */
const newRevision = () => Math.floor(Math.random() * 2 ** 52) + 1

class SchemaMismatchError extends Error {
  constructor(version: number) {
    super(`库的结构版本是 ${version}，本插件用 ${SCHEMA_VERSION}`)
  }
}

function generations(db: DatabaseSync): GenRow[] {
  return db.prepare('SELECT gen, segment_rule, tokenizer, intake, dictionary, is_read, is_complete, w_rewrite_after FROM generations ORDER BY gen').all() as unknown as GenRow[]
}

function hasGeneration(db: DatabaseSync, gen: number): boolean {
  return db.prepare('SELECT 1 FROM generations WHERE gen = ?').get(gen) !== undefined
}

function stateOf(db: DatabaseSync): DialogueStoreState {
  const all = generations(db)
  const read = all.find(g => g.is_read === 1)
  const write = all.at(-1)
  if (read === undefined || write === undefined) return { status: 'none' }
  const status = read.gen !== write.gen ? 'rebuilding' : read.is_complete === 1 ? 'ready' : 'building'
  return { status, read: toGeneration(read), write: toGeneration(write) }
}

function sessionOf(db: DatabaseSync, gen: number, sessionId: string): DialogueSessionState | undefined {
  const row = db.prepare('SELECT watermark, revision, is_removed FROM sessions WHERE gen = ? AND session_id = ?').get(gen, sessionId) as
    { watermark: number; revision: number; is_removed: number } | undefined
  return row === undefined ? undefined : { watermark: row.watermark, revision: row.revision, isRemoved: row.is_removed === 1 }
}

/** 删一个会话在各代里的行（会话表那一行留给调用方处理）。 */
function deleteSessionRows(db: DatabaseSync, sessionId: string): void {
  db.prepare('DELETE FROM segments_fts WHERE rowid IN (SELECT id FROM segments WHERE session_id = ?)').run(sessionId)
  db.prepare('DELETE FROM segments WHERE session_id = ?').run(sessionId)
  for (const table of SESSION_TABLES) db.prepare(`DELETE FROM ${table} WHERE session_id = ?`).run(sessionId)
}

function dropGeneration(db: DatabaseSync, gen: number): void {
  db.prepare('DELETE FROM segments_fts WHERE rowid IN (SELECT id FROM segments WHERE gen = ?)').run(gen)
  for (const table of ['segments', ...SESSION_TABLES, 'sessions', 'generations']) db.prepare(`DELETE FROM ${table} WHERE gen = ?`).run(gen)
}

function openStore(sqlite: SqliteModule, path: string): DatabaseSync {
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
        db.exec('CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)')
        db.exec('CREATE TABLE IF NOT EXISTS generations(gen INTEGER PRIMARY KEY, segment_rule INTEGER NOT NULL, tokenizer INTEGER NOT NULL, intake INTEGER NOT NULL, dictionary TEXT NOT NULL, is_read INTEGER NOT NULL, is_complete INTEGER NOT NULL, w_rewrite_after INTEGER)')
        db.exec('CREATE TABLE IF NOT EXISTS sessions(gen INTEGER NOT NULL, session_id TEXT NOT NULL, watermark INTEGER NOT NULL, revision INTEGER NOT NULL, cwd TEXT, is_subagent INTEGER NOT NULL, is_open INTEGER NOT NULL DEFAULT 0, is_removed INTEGER NOT NULL, PRIMARY KEY(gen, session_id))')
        db.exec('CREATE TABLE IF NOT EXISTS segments(id INTEGER PRIMARY KEY AUTOINCREMENT, gen INTEGER NOT NULL, session_id TEXT NOT NULL, turn_seq INTEGER NOT NULL, seq INTEGER NOT NULL, segment INTEGER NOT NULL, at REAL, speaker TEXT NOT NULL, text TEXT NOT NULL, UNIQUE(gen, session_id, seq, segment))')
        db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS segments_fts USING fts5(w, b, c, tokenize = 'unicode61')")
        db.exec('CREATE TABLE IF NOT EXISTS turns(gen INTEGER NOT NULL, session_id TEXT NOT NULL, turn_seq INTEGER NOT NULL, at REAL, PRIMARY KEY(gen, session_id, turn_seq))')
        db.exec('CREATE TABLE IF NOT EXISTS queue(position INTEGER PRIMARY KEY, gen INTEGER NOT NULL, session_id TEXT NOT NULL, UNIQUE(gen, session_id))')
        db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
      })
    }
    try {
      db.prepare('SELECT gen, segment_rule, tokenizer, intake, dictionary, is_read, is_complete, w_rewrite_after FROM generations LIMIT 1').get()
      db.prepare('SELECT gen, session_id, watermark, revision, cwd, is_subagent, is_open, is_removed FROM sessions LIMIT 1').get()
      db.prepare('SELECT id, gen, session_id, turn_seq, seq, segment, at, speaker, text FROM segments LIMIT 1').get()
      db.prepare('SELECT rowid, w, b, c FROM segments_fts LIMIT 1').get()
      db.prepare('SELECT gen, session_id, turn_seq, at FROM turns LIMIT 1').get()
      db.prepare('SELECT position, gen, session_id FROM queue LIMIT 1').get()
      db.prepare('SELECT key, value FROM meta LIMIT 1').get()
    } catch (err) {
      // 版本号对、表的样子不对（开发中的旧库）：同样换新库。只认「没有这张表、这一列」；读写出错、盘满这些不是结构问题，库不动
      if (!/no such (table|column)/i.test(describeError(err))) throw err
      throw new SchemaMismatchError(version)
    }
    // 全文索引自己的删除也当场抹掉词。设不上（库忙、SQLite 太老）这一次就不用：不能在删掉的词还留在文件里的状态下收对话
    db.exec("INSERT INTO segments_fts(segments_fts, rank) VALUES ('secure-delete', 1)")
    return db
  } catch (err) {
    closeQuietly(db)
    throw err
  }
}

function assertNotInUse(sqlite: SqliteModule, path: string): void {
  const db = new sqlite.DatabaseSync(path)
  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`)
    db.exec('BEGIN IMMEDIATE')
    db.exec('ROLLBACK')
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
