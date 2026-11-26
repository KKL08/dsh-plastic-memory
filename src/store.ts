import { dirname } from 'node:path'
import type { MemoryRecord, MergedInto } from './record-schema.ts'
import { RecordNotFoundError } from './errors.ts'
import { expandQueryTerms, matchScore } from './text.ts'
import {
  byPosition, newWriteOp, outgoingLinks, resolveLiveFirst, sortLinkRefs,
  type LinkQuery, type MemoryLogger, type MemoryTable, type LocateTarget, type LocateOptions, type ScopeReadOptions, type ScopeReadResult, type KeywordMatch,
  type DirectoryNote, type QuarantineEntry, type OpStep, type OpStepHandler, type WriteOp, type IndexOpOptions, type IndexOpOutcome, type IndexUndoOutcome,
} from './storage/table.ts'
import type { BatchKvTable } from './kv-table.ts'
import type { RecallStats } from './storage/schema.ts'
import { hasSecret } from './secrets.ts'
import type { Scope } from './scope.ts'
import type { IndexFiles } from './topic-index.ts'
import type { IndexOp, IndexPlan } from './topic-ops.ts'
import { RETENTION_MS } from './retention.ts'

export type { MemoryLogger, MemoryTable, KeywordMatch, LocateTarget, LocateOptions, SessionTarget } from './storage/table.ts'

/** 查询范围：一个作用域（全局或某个项目），或当前会话的可见集合（global + 当前 workspace）。缺省读全部目录。 */
export type QueryScope = Scope | { kind: 'visible'; workspacePath: string | undefined }

export interface QueryFilter {
  scope?: QueryScope
  types?: string[]
  tags?: string[]
  status?: MemoryRecord['status'][]
  keyword?: string
  /** keyword 展开后的多个词项怎么算命中：all（缺省）= 全部命中，any = 任一命中。 */
  keywordMatch?: KeywordMatch
}

/** 一次查询的完整结果：记录之外带上同一次读取里的隔离文件与目录级说明（冷启动文案要分辨「空」与「全坏」）。 */
export interface QueryResult {
  records: MemoryRecord[]
  quarantined: QuarantineEntry[]
  directoryNotes: DirectoryNote[]
}

/** 删除类方法的选项。 */
export interface DeleteOptions {
  /** 只认这个作用域里的那一份（见 LocateTarget）；缺省按记录自己的 workspace 做会话视角定位。 */
  at?: Scope
  /** 软删的时刻（updatedAt、deletedAt）：调用方有注入的时钟时传它，缺省取当前时间。 */
  now?: number
  /** 物理删除带去向的记忆时，历史先并到去向那条名下（最近删除里的彻底删除）。密钥硬删不给。 */
  isHistoryCarried?: boolean
}

/**
 * 软删。给了 now 时 deletedAt 也记成它（已有的不动，保留期从第一次删除算起）；
 * 缺省时 deletedAt 照旧由表在落盘时补上。
 */
export function markDeleted(r: MemoryRecord, now: number | undefined): MemoryRecord {
  if (now === undefined) return { ...r, status: 'deleted', updatedAt: Date.now() }
  return { ...r, status: 'deleted', updatedAt: now, deletedAt: r.deletedAt ?? now }
}

function deleteTarget(record: Pick<MemoryRecord, 'workspacePath'>, opts: DeleteOptions): LocateTarget {
  return opts.at ?? { workspacePath: record.workspacePath }
}

export class MemoryStore {
  private table: MemoryTable
  private readonly log: MemoryLogger
  private stats: BatchKvTable<RecallStats>
  private readonly stepHandlers = new Map<string, OpStepHandler>()

  /** log 缺省回退 console；stats：召回统计侧表（接线层传 .state/recall-stats.json）。 */
  constructor(table: MemoryTable, log: MemoryLogger | undefined, stats: BatchKvTable<RecallStats>) {
    this.table = table
    this.log = log ?? console
    this.stats = stats
  }

  /** 历史版本（见 MemoryTable.history）。 */
  get history() { return this.table.history }

  /** 按 id 定位（含非 active）；缺省是不带当前项目的会话视角，目标规则见 LocateTarget。
   *  位置即作用域（同 readRaw）：.archive/ 里 status 仍写着 active 的按 deleted 返回。 */
  async get(id: string, target: LocateTarget = {}, opts?: LocateOptions): Promise<MemoryRecord | undefined> {
    const found = await this.table.locate(id, target, opts)
    return found === undefined ? undefined : byPosition(found)
  }
  locate(id: string, target: LocateTarget = {}, opts?: LocateOptions) { return this.table.locate(id, target, opts) }
  /** 这个 id 在哪些作用域有副本（任何状态，含只在 .archive/ 里的）：全局在前，项目按路径排序。 */
  copiesOf(id: string): Promise<Scope[]> { return this.table.copiesOf(id) }
  listWorkspaceDirs() { return this.table.listWorkspaceDirs() }
  /** 一条记忆的一次改动整段在一个写入段里：中途拿锁超时不会只做一半，同进程别的写入也插不进中间。 */
  writeSection<T>(fn: () => Promise<T>): Promise<T> { return this.table.inSection !== undefined ? this.table.inSection(fn) : fn() }
  /** 新记录：不定位，排他占名（save create 用）。 */
  create(record: MemoryRecord, op?: WriteOp) { return this.table.create(record, op) }
  /** 整条替换。from：跨 scope 搬家时传原记录的作用域，让定位到的是门放行的那份；缺省按 record 自己的 workspace 做会话视角定位。
   *  skipIf 见 MemoryTable.put：锁内按最新内容判定为真就不写，返回 undefined；写了返回实际写出的记录。 */
  put(record: MemoryRecord, from: LocateTarget = { workspacePath: record.workspacePath }, skipIf?: (current: MemoryRecord | undefined) => boolean, op?: WriteOp) {
    return this.table.put(record, from, skipIf, op)
  }
  /** 读改写：锁内按调用方读到的那条记录定位（定位约定同 put），对磁盘上的当前内容套 fn；
   *  调用方读到之后被别处改过的字段不丢。只改几个字段的写回都该走这里，整条替换才用 put。 */
  update(record: Pick<MemoryRecord, 'id' | 'workspacePath'>, fn: (current: MemoryRecord) => MemoryRecord, from: LocateTarget = { workspacePath: record.workspacePath }, op?: WriteOp) {
    return this.table.update(record.id, from, fn, op)
  }

  /** 这次写入落没落盘：作用域里有没有提交标记等于 op 的那一份（见 MemoryTable.locateWrittenBy）。 */
  async locateWrittenBy(id: string, scope: Scope, op: WriteOp) {
    if (this.table.locateWrittenBy !== undefined) return this.table.locateWrittenBy(id, scope, op.id)
    const current = await this.table.locate(id, scope)
    return current?.writeOp === op.id ? current : undefined
  }

  /** 登记提交后步骤的处理器（见 MemoryTable.registerStep）。写入点动手前登记自己要用的那几种，接线层启动时也登记一遍，中断后才补得上。 */
  registerSteps(handlers: Readonly<Record<string, OpStepHandler>>): void {
    for (const [kind, handler] of Object.entries(handlers)) {
      this.stepHandlers.set(kind, handler)
      this.table.registerStep?.(kind, handler)
    }
  }

  hasStep(kind: string): boolean {
    return this.stepHandlers.has(kind)
  }

  /** 起一个写入操作（id 现生成）：要把操作 id 写进记录里、又不直接碰存储层的调用方用。 */
  newOp(init: { initiator?: string } = {}): WriteOp { return newWriteOp(init) }

  /** 带着 op 的那次写入落盘了：做掉它提交后的步骤（见 MemoryTable.finishOp）。没有操作日志的表在这里直接做。 */
  async finishOp(op: WriteOp, written?: MemoryRecord): Promise<void> {
    if (this.table.finishOp !== undefined) return this.table.finishOp(op, written)
    for (const step of op.steps) await this.stepHandlers.get(step.kind)?.(step, { op: op.id, record: written, isIntact: true })
  }
  /** 同 update，但锁内发现记录已不存在或已软删就不写、返回 undefined（工具据此报「不存在或已删除」，不抛错）。
   *  from 同 update：调用方按作用域读到的（locateCopy），给同一个作用域写回，别的作用域里同 id 的副本不动。
   *  isChanged：锁内看到的当前内容过了它（调用方读到之后又被改过）也不写、返回 undefined。 */
  async updateIfLive(
    record: Pick<MemoryRecord, 'id' | 'workspacePath'>, fn: (current: MemoryRecord) => MemoryRecord, from?: LocateTarget,
    opts: { isChanged?: (current: MemoryRecord) => boolean; op?: WriteOp } = {},
  ): Promise<MemoryRecord | undefined> {
    try {
      return await this.update(record, r => {
        if (r.status === 'deleted' || opts.isChanged?.(r) === true) throw new RecordNotFoundError(r.id)
        return fn(r)
      }, from, opts.op)
    } catch (err) {
      if (err instanceof RecordNotFoundError) return undefined
      throw err
    }
  }

  /**
   * 删除按记录定位：调用方传入它读到并过了门的那条记录，按该记录自己的 workspace 定位（与 put 同约定），
   * 同 id 多副本时改的就是门检查过的那份，不会落到 global 或别的项目的副本上。
   * hardDelete 物理删除文件（不进 .archive/，不可恢复）：给密钥硬删（tools/forget.ts）和最近删除里的彻底删除（gui/commands.ts）用。
   * opts.at：只认这个作用域里的那一份（见 LocateTarget），可见集合里别的作用域的副本更新也不改到它头上。
   * skipIf：锁内对将被删的那份求值（位置即作用域，同 get），为真就不删、返回 false。
   */
  hardDelete(record: Pick<MemoryRecord, 'id' | 'workspacePath'>, opts: DeleteOptions = {}, skipIf?: (current: MemoryRecord) => boolean): Promise<boolean> {
    return this.table.delete(record.id, deleteTarget(record, opts), skipIf && (found => skipIf(byPosition(found))), undefined, opts.isHistoryCarried === true ? { isHistoryCarried: true } : undefined)
  }

  async softDelete(record: Pick<MemoryRecord, 'id' | 'workspacePath'>, opts: DeleteOptions = {}): Promise<boolean> {
    const target = deleteTarget(record, opts)
    // 没找到要在锁内确认：调用方读到过它，锁外这一眼可能正夹在别的写入挪它的中间（见 LocateOptions）
    if (!(await this.table.locate(record.id, target, { isMissRechecked: true }))) return false
    try {
      await this.table.update(record.id, target, r => markDeleted(r, opts.now))
    } catch (err) {
      if (err instanceof RecordNotFoundError) return false   // 定位之后被别处删掉
      throw err
    }
    return true
  }

  /**
   * 归档记忆原样复活（没有快照覆盖时的恢复）：改回 active、去掉 deletedAt，经写路径搬回层顶层。
   * 删除时间过了保留期的不复活（返回 false）。归档文件本身就是完整内容；updatedAt 记为恢复时刻（opts.now，缺省当前时间），手工放进 .archive/ 仍写 active 的文件也因此会被写回顶层。定位同 softDelete。
   */
  async restoreArchived(record: Pick<MemoryRecord, 'id' | 'workspacePath'>, opts: DeleteOptions = {}): Promise<boolean> {
    try {
      const now = opts.now ?? Date.now()
      await this.table.update(record.id, deleteTarget(record, opts), ({ deletedAt, mergedInto: _mergedInto, ...r }) => {
        // 过了保留期的归档文件等维护点来清，清之前也不能复活：恢复的资格不看文件清没清
        if (deletedAt !== undefined && deletedAt < now - RETENTION_MS) throw new RecordNotFoundError(r.id)
        return { ...r, status: 'active', updatedAt: now }
      })
    } catch (err) {
      if (err instanceof RecordNotFoundError) return false   // 定位之后被别处删掉
      throw err
    }
    return true
  }

  /**
   * 只软删（GUI 的 forget）：锁内看到的当前内容含密钥就不动它、回 has-secret，由调用方先问用户；
   * 调用方读过之后另一个会话才写进的密钥也拦得住。定位同 softDelete。
   * isChanged：锁内看到的当前内容过了它（调用方核对过的版本之后又被改过）就不动它、回 changed。
   * isSecret：含密钥的口径，缺省两级都算。
   */
  async softDeleteUnlessSecret(
    record: Pick<MemoryRecord, 'id' | 'workspacePath'>,
    opts: DeleteOptions & { isChanged?: (current: MemoryRecord) => boolean; isSecret?: (current: MemoryRecord) => boolean; op?: WriteOp; /** 并进了哪条：记在软删的这一版上。 */ mergedInto?: MergedInto } = {},
  ): Promise<'deleted' | 'has-secret' | 'changed' | 'missing'> {
    const target = deleteTarget(record, opts)
    if (!(await this.table.locate(record.id, target, { isMissRechecked: true }))) return 'missing'
    try {
      // 走 update 的读改写：写盘前又被改就在新内容上重判，判密钥看的始终是将被覆盖的那份
      let outcome: 'deleted' | 'has-secret' | 'changed' = 'deleted'
      await this.update(record, (r) => {
        outcome = opts.isChanged?.(r) === true ? 'changed' : (opts.isSecret ?? hasSecret)(r) ? 'has-secret' : 'deleted'
        return outcome === 'deleted' ? { ...markDeleted(r, opts.now), ...(opts.mergedInto !== undefined ? { mergedInto: opts.mergedInto } : {}) } : r
      }, target, opts.op)
      return outcome
    } catch (err) {
      if (err instanceof RecordNotFoundError) return 'missing'   // 定位之后被别处删掉
      throw err
    }
  }

  /** scope → 目录，外加找项目目录时读不出的目录说明（见 MemoryTable.workspaceDirs）。缺省读全部目录（global + 全部有标记的 workspace 目录）。 */
  private async dirsOf(scope: QueryScope | undefined): Promise<{ dirs: string[]; directoryNotes: DirectoryNote[] }> {
    if (scope === undefined) {
      const listing = await this.table.listWorkspaceDirs()
      return { dirs: [this.table.globalDir, ...listing.entries.map(e => e.dir)], directoryNotes: listing.directoryNotes }
    }
    if (scope.kind === 'global') return { dirs: [this.table.globalDir], directoryNotes: [] }
    if (scope.kind === 'workspace') return this.table.workspaceDirs(scope.workspacePath)
    const own = scope.workspacePath === undefined ? { dirs: [], directoryNotes: [] } : await this.table.workspaceDirs(scope.workspacePath)
    return { dirs: [this.table.globalDir, ...own.dirs], directoryNotes: own.directoryNotes }
  }

  /** 按范围原样读目录：记录含非 active、同 id 不取舍。health / scan 按作用域预读用它。
   *  位置即作用域：.archive/ 里 status 仍写着 active 的文件（手工搬进去的）按 deleted 看待，维护点会把它归一落盘。 */
  async readRaw(scope: QueryScope | undefined, opts: ScopeReadOptions = {}): Promise<ScopeReadResult> {
    const { dirs, directoryNotes } = await this.dirsOf(scope)
    const read = await this.table.readScope(dirs, opts)
    const records = read.records.map(l =>
      l.record.status === 'active' && dirname(l.filePath) !== l.dir ? { ...l, record: { ...l.record, status: 'deleted' as const } } : l)
    return { ...read, records, directoryNotes: [...directoryNotes, ...read.directoryNotes] }
  }

  /** 一个作用域的记忆目录（主题索引就在它下面）：全局是全局目录；项目还没有目录、或这个实现没有主题索引时为空。 */
  private async indexDirOf(scope: Scope): Promise<string | undefined> {
    if (this.table.applyIndexOp === undefined) return undefined
    return scope.kind === 'global' ? this.table.globalDir : (await this.table.workspaceDirs(scope.workspacePath)).dirs[0]
  }

  /** 一个作用域的主题索引文件，masked 为真时遮盖手写文字中的密钥；还没有时为空。 */
  async readIndex(scope: Scope, masked = false): Promise<IndexFiles | undefined> {
    const dir = await this.indexDirOf(scope)
    return dir === undefined ? undefined : this.table.readIndex?.(dir, masked)
  }

  /** 对一个作用域的主题索引做一个操作（见 MemoryTable.applyIndexOp）。 */
  async applyIndexOp(scope: Scope, op: IndexOp, opts: IndexOpOptions): Promise<IndexOpOutcome> {
    const dir = await this.indexDirOf(scope)
    if (dir === undefined) return { kind: 'skipped', reason: '这个范围还没有主题索引' }
    return this.table.applyIndexOp!(dir, op, opts)
  }

  /** 撤销一个做过的索引操作（见 MemoryTable.undoIndexPlan）。 */
  async undoIndexPlan(scope: Scope, plan: IndexPlan, opts?: { steps?: (op: string) => readonly OpStep[] }): Promise<IndexUndoOutcome> {
    const dir = await this.indexDirOf(scope)
    if (dir === undefined || this.table.undoIndexPlan === undefined) return { kind: 'stale', reason: '这个范围的主题索引不在了' }
    return this.table.undoIndexPlan(dir, plan, opts)
  }

  /** 一个索引操作是不是提交了、还有步骤等着补做（见 MemoryTable.isOpPending）。 */
  isOpPending(op: string): boolean {
    return this.table.isOpPending?.(op) ?? false
  }

  /** 操作日志里还等着补做的步骤有没有一个对得上 match（见 MemoryTable.hasPendingStep）。 */
  hasPendingStep(match: (step: OpStep) => boolean): boolean {
    return this.table.hasPendingStep?.(match) ?? false
  }

  /** 这次写入里文件表自己的 kind 那一步当场没做成（见 MemoryTable.hasUnfinishedOwnStep）；表不支持时为否。 */
  hasUnfinishedOwnStep(op: string, kind: string): boolean {
    return this.table.hasUnfinishedOwnStep?.(op, kind) ?? false
  }

  /**
   * 指向这条记忆的链接（前提、相关、取代，含归档里被取代、删除的记忆指过来的）。看的范围是能指向它的全部目录：
   * 项目记忆看本项目；全局记忆看全局和所有项目（项目记忆的关联和前提可以指向全局）。
   * 完整查询：按文件签名核对，手改了还没整份核对的也算进来；给界面和要看全貌的功能用。查不全时 isComplete 为假。
   */
  async linksTo(id: string, scope: Scope): Promise<LinkQuery> {
    const { dirs, isListed } = await this.linkDirsOf(scope)
    const found = this.table.linksTo !== undefined ? await this.table.linksTo(id, dirs) : await this.readLinksTo(id, dirs)
    return isListed ? found : { ...found, isComplete: false }
  }

  /**
   * 同 linksTo 的范围，只按派生库的目标索引查，不逐层列目录、不逐个文件取签名：写锁内要快的判断用它（被前提引用的版本一律留档）。
   * 插件自己写入的链接写完就在；手改文件加的要到下次整份核对才算进来。没核对过的层、库用不了又读不全时 isComplete 为假。
   */
  async indexedLinksTo(id: string, scope: Scope): Promise<LinkQuery> {
    if (this.table.indexedLinksTo === undefined) return this.linksTo(id, scope)
    const { dirs, isListed } = await this.linkDirsOf(scope)
    const found = await this.table.indexedLinksTo(id, dirs)
    return isListed ? found : { ...found, isComplete: false }
  }

  /** 反向查询看的目录：全局记忆看全局和所有项目，项目记忆看本项目。列项目目录失败时 isListed 为假。 */
  private async linkDirsOf(scope: Scope): Promise<{ dirs: string[]; isListed: boolean }> {
    if (scope.kind === 'global') {
      const listing = await this.table.listWorkspaceDirs()
      return { dirs: [this.table.globalDir, ...listing.entries.map(e => e.dir)], isListed: !listing.directoryNotes.some(n => n.code === 'dir-unreadable') }
    }
    const own = await this.table.workspaceDirs(scope.workspacePath)
    return { dirs: own.dirs, isListed: own.directoryNotes.length === 0 }
  }

  /** 表不提供反向查询时逐个读目录算。 */
  private async readLinksTo(id: string, dirs: string[]): Promise<LinkQuery> {
    const read = await this.table.readScope(dirs, { includeArchive: true })
    const refs = sortLinkRefs(read.records.flatMap(({ record }) => outgoingLinks(record)
      .filter(link => link.targetId === id)
      .map(link => ({ sourceId: record.id, kind: link.kind, ...(link.digest !== undefined ? { digest: link.digest } : {}) }))))
    return { refs, isComplete: read.quarantined.length === 0 && !read.directoryNotes.some(n => n.code === 'dir-unreadable') }
  }

  /** 维护点入口（快照冻结时调用）：scope 决定维护哪些目录；未解析 workspace 时只有 global。 */
  async maintain(scope: QueryScope): Promise<void> {
    await this.table.maintain((await this.dirsOf(scope)).dirs)
  }

  /**
   * 执行器的统一查询入口：scope 决定读哪些目录（只读 active 时不读 .archive/），同 id 多文件按取舍规则留一份，
   * 再按 status / types / tags / keyword 过滤。validTo 过期的过滤留给调用方（注入与检索过滤，治理仍可见）。
   */
  async queryScope(filter: QueryFilter): Promise<QueryResult> {
    const statuses = filter.status ?? ['active']
    const scope = filter.scope
    const workspacePath = scope?.kind === 'workspace' || scope?.kind === 'visible' ? scope.workspacePath : undefined
    // keyword 按 keywordMatch 取全部或任一词项命中（AND 零命中回退 OR 由调用方 executeSearch 决定）。
    // 原文预筛用同一组词项、同一模式：expandQueryTerms 只做小写、按空白切分、CJK 段切 bigram，不扩同义词，
    // 每个词项都是查询原文的子串，命中记录的原文里必然以子串出现（缺 id 行文件的派生 id 由 FileTable 预筛一并算入），
    // 所以预筛是超集。
    const terms = filter.keyword ? expandQueryTerms(filter.keyword.toLowerCase()) : []
    const keywordMatch = filter.keywordMatch ?? 'all'
    const read = await this.readRaw(scope, {
      ...(filter.types ? { types: filter.types } : {}),
      ...(terms.length > 0 ? { prefilterTerms: terms, prefilterMatch: keywordMatch } : {}),
      includeArchive: statuses.some(s => s !== 'active'),
    })
    const records = resolveLiveFirst(read.records, { workspacePath }).map(l => l.record).filter(r =>
      statuses.includes(r.status)
      && (!filter.tags || filter.tags.some(t => r.tags.includes(t)))
      && (terms.length === 0 || (keywordMatch === 'any' ? matchScore(r, terms) > 0 : matchScore(r, terms) === terms.length)))
    return { records, quarantined: read.quarantined, directoryNotes: read.directoryNotes }
  }

  async query(filter: QueryFilter): Promise<MemoryRecord[]> {
    return (await this.queryScope(filter)).records
  }

  /** 召回统计只读改写侧表，不经 table.update——记忆文件不因召回而重写。一次调用是侧表的一次读改写（mergeMany：
   *  在写入段里一次读、内存合并、一次写，单文件表只换一次文件），同一进程并发、跨进程都不少计（写锁不可用时只保证同一进程）。
   *  ids 取自调用方同一次读取的结果（search 命中、快照 core 区），存活由那次读保证，这里不再逐 id 定位。 */
  async markRecalled(ids: string[], now = Date.now()): Promise<void> {
    try {
      // 读当前行、加一、写回整段在侧表的读改写里。同一次调用里重复出现的 id 依次累加
      await this.stats.mergeMany(ids, (row, id) => ({ id, recallCount: (row?.recallCount ?? 0) + 1, lastRecalledAt: now }))
    } catch (err) {
      this.log.error('[plastic-memory] 召回统计更新失败:', err)
    }
  }
}
