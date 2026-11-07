import { dirname } from 'node:path'
import type { MemoryRecord } from './record-schema.ts'
import { RecordNotFoundError } from './errors.ts'
import { expandQueryTerms, matchScore } from './text.ts'
import {
  byPosition, resolveLiveFirst,
  type MemoryLogger, type MemoryTable, type LocateTarget, type ScopeReadOptions, type ScopeReadResult, type KeywordMatch,
  type DirectoryNote, type QuarantineEntry,
} from './storage/table.ts'
import type { BatchKvTable } from './kv-table.ts'
import type { RecallStats } from './storage/schema.ts'
import { hasSecret } from './secrets.ts'
import type { Scope } from './scope.ts'

export type { MemoryLogger, MemoryTable, KeywordMatch, LocateTarget, SessionTarget } from './storage/table.ts'

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
  private recallChain: Promise<unknown> = Promise.resolve() // markRecalled 的读改写在进程内串行

  /** log 缺省回退 console；stats：召回统计侧表（接线层传 .state/recall-stats.json）。 */
  constructor(table: MemoryTable, log: MemoryLogger | undefined, stats: BatchKvTable<RecallStats>) {
    this.table = table
    this.log = log ?? console
    this.stats = stats
  }

  /** 按 id 定位（含非 active）；缺省是不带当前项目的会话视角，目标规则见 LocateTarget。
   *  位置即作用域（同 readRaw）：.archive/ 里 status 仍写着 active 的按 deleted 返回。 */
  async get(id: string, target: LocateTarget = {}): Promise<MemoryRecord | undefined> {
    const found = await this.table.locate(id, target)
    return found === undefined ? undefined : byPosition(found)
  }
  locate(id: string, target: LocateTarget = {}) { return this.table.locate(id, target) }
  /** 这个 id 在哪些作用域有副本（任何状态，含只在 .archive/ 里的）：全局在前，项目按路径排序。 */
  copiesOf(id: string): Promise<Scope[]> { return this.table.copiesOf(id) }
  listWorkspaceDirs() { return this.table.listWorkspaceDirs() }
  /** 新记录：不定位，排他占名（save create 用）。 */
  create(record: MemoryRecord) { return this.table.create(record) }
  /** 整条替换。from：跨 scope 搬家时传原记录的作用域，让定位到的是门放行的那份；缺省按 record 自己的 workspace 做会话视角定位。
   *  skipIf 见 MemoryTable.put：锁内按最新内容判定为真就不写，返回 undefined；写了返回实际写出的记录。 */
  put(record: MemoryRecord, from: LocateTarget = { workspacePath: record.workspacePath }, skipIf?: (current: MemoryRecord | undefined) => boolean) {
    return this.table.put(record, from, skipIf)
  }
  /** 读改写：锁内按调用方读到的那条记录定位（定位约定同 put），对磁盘上的当前内容套 fn；
   *  调用方读到之后被别处改过的字段不丢。只改几个字段的写回都该走这里，整条替换才用 put。 */
  update(record: Pick<MemoryRecord, 'id' | 'workspacePath'>, fn: (current: MemoryRecord) => MemoryRecord, from: LocateTarget = { workspacePath: record.workspacePath }) {
    return this.table.update(record.id, from, fn)
  }
  /** 同 update，但锁内发现记录已不存在或已软删就不写、返回 undefined（工具据此报「不存在或已删除」，不抛错）。
   *  from 同 update：调用方按作用域读到的（locateCopy），给同一个作用域写回，别的作用域里同 id 的副本不动。 */
  async updateIfLive(record: Pick<MemoryRecord, 'id' | 'workspacePath'>, fn: (current: MemoryRecord) => MemoryRecord, from?: LocateTarget): Promise<MemoryRecord | undefined> {
    try {
      return await this.update(record, r => {
        if (r.status === 'deleted') throw new RecordNotFoundError(r.id)
        return fn(r)
      }, from)
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
    return this.table.delete(record.id, deleteTarget(record, opts), skipIf && (found => skipIf(byPosition(found))))
  }

  async softDelete(record: Pick<MemoryRecord, 'id' | 'workspacePath'>, opts: DeleteOptions = {}): Promise<boolean> {
    const target = deleteTarget(record, opts)
    if (!(await this.table.locate(record.id, target))) return false
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
   * 归档文件本身就是完整内容；updatedAt 记为恢复时刻（opts.now，缺省当前时间），手工放进 .archive/ 仍写 active 的文件也因此会被写回顶层。定位同 softDelete。
   */
  async restoreArchived(record: Pick<MemoryRecord, 'id' | 'workspacePath'>, opts: DeleteOptions = {}): Promise<boolean> {
    try {
      await this.table.update(record.id, deleteTarget(record, opts), ({ deletedAt: _, ...r }) => ({ ...r, status: 'active', updatedAt: opts.now ?? Date.now() }))
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
    opts: DeleteOptions & { isChanged?: (current: MemoryRecord) => boolean; isSecret?: (current: MemoryRecord) => boolean } = {},
  ): Promise<'deleted' | 'has-secret' | 'changed' | 'missing'> {
    const target = deleteTarget(record, opts)
    if (!(await this.table.locate(record.id, target))) return 'missing'
    try {
      // 走 update 的读改写：写盘前又被改就在新内容上重判，判密钥看的始终是将被覆盖的那份
      let outcome: 'deleted' | 'has-secret' | 'changed' = 'deleted'
      await this.update(record, (r) => {
        outcome = opts.isChanged?.(r) === true ? 'changed' : (opts.isSecret ?? hasSecret)(r) ? 'has-secret' : 'deleted'
        return outcome === 'deleted' ? markDeleted(r, opts.now) : r
      }, target)
      return outcome
    } catch (err) {
      if (err instanceof RecordNotFoundError) return 'missing'   // 定位之后被别处删掉
      throw err
    }
  }

  /** scope → 目录。缺省读全部目录（global + 全部有标记的 workspace 目录）。 */
  private async dirsOf(scope: QueryScope | undefined): Promise<string[]> {
    if (scope === undefined) return [this.table.globalDir, ...(await this.table.listWorkspaceDirs()).entries.map(e => e.dir)]
    if (scope.kind === 'global') return [this.table.globalDir]
    if (scope.kind === 'workspace') return this.table.workspaceDirs(scope.workspacePath)
    return [this.table.globalDir, ...(scope.workspacePath === undefined ? [] : await this.table.workspaceDirs(scope.workspacePath))]
  }

  /** 按范围原样读目录：记录含非 active、同 id 不取舍。health / scan 按作用域预读用它。
   *  位置即作用域：.archive/ 里 status 仍写着 active 的文件（手工搬进去的）按 deleted 看待，维护点会把它归一落盘。 */
  async readRaw(scope: QueryScope | undefined, opts: ScopeReadOptions = {}): Promise<ScopeReadResult> {
    const read = await this.table.readScope(await this.dirsOf(scope), opts)
    const records = read.records.map(l =>
      l.record.status === 'active' && dirname(l.filePath) !== l.dir ? { ...l, record: { ...l.record, status: 'deleted' as const } } : l)
    return { ...read, records }
  }

  /** 维护点入口（快照冻结时调用）：scope 决定维护哪些目录；未解析 workspace 时只有 global。 */
  async maintain(scope: QueryScope): Promise<void> {
    await this.table.maintain(await this.dirsOf(scope))
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

  /** 召回统计只读改写侧表，不经 table.update——记忆文件不因召回而重写。一次调用一次读、内存合并、
   *  一次批量写（单文件表只换一次文件）。跨进程单文件 LWW（参考字段）。
   *  ids 取自调用方同一次读取的结果（search 命中、快照 core 区），存活由那次读保证，这里不再逐 id 定位。 */
  markRecalled(ids: string[], now = Date.now()): Promise<void> {
    const run = () => this.markRecalledInner(ids, now)
    const next = this.recallChain.then(run, run)
    this.recallChain = next.catch(() => {})
    return next
  }

  private async markRecalledInner(ids: string[], now: number): Promise<void> {
    try {
      const current = new Map(await this.stats.list())
      const next = new Map<string, RecallStats>()
      for (const id of ids) {
        // 同一次调用里重复出现的 id 累加（与逐条 put 时的旧行为一致）
        const row = next.get(id) ?? current.get(id)
        next.set(id, { id, recallCount: (row?.recallCount ?? 0) + 1, lastRecalledAt: now })
      }
      await this.stats.putMany([...next])
    } catch (err) {
      this.log.error('[plastic-memory] 召回统计更新失败:', err)
    }
  }
}
