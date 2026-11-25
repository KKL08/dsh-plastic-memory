import type { CasKvTable, CheckedListKvTable } from '../kv-table.ts'
import type { DreamMarks, DreamsRecord } from '../storage/schema.ts'
import { scopeKey, type Scope } from '../scope.ts'
import { DREAMS_ALL_KEY, type UsageRun } from './dreams-gate.ts'

/**
 * 记忆梦境的侧表读写：范围开关、每个范围的运行记录（含用户撤销过的合并结论）、变化基线、用量。表由接线层注入（storage/sidecar.ts 的 dreams、dreamMarks）。
 *
 * 读一律带完整性（listChecked）：有条目读不出时不知道它是不是单独关掉的开关、是不是别的进程刚写的运行记录，
 * 调用方这一轮不跑。写都是单条的读改写（update），收尾的写入核对运行 id，认领过期后被别的进程接着跑时旧的那次不改记录。
 */

/** 用量记在这个键下（不是范围）。 */
export const DREAMS_USAGE_KEY = 'usage'
/** 每个范围最多记这么多个撤销过的合并结论，多了丢最早的（丢掉的那个结论以后可能再被提一次）。 */
export const UNDONE_MERGES_MAX = 500
const DAY_MS = 86_400_000

export type DreamsUnfinished = NonNullable<DreamsRecord['unfinished']>
export type DreamsLastResult = NonNullable<DreamsRecord['lastResult']>

export interface DreamsState {
  /** 为假：有条目读不出，开关和运行记录都不能当真。 */
  isComplete: boolean
  /** 范围键 → 单独设的开关（含 all 的默认值）。 */
  settings: Map<string, boolean>
  /** 范围键 → 运行记录。 */
  records: Map<string, DreamsRecord>
  usageRuns: UsageRun[]
}

/** 变化基线的三种情形。unavailable：做完过，但基线读不出或对不上那次运行。 */
export type DreamsBaseline = { kind: 'none' } | { kind: 'unavailable' } | { kind: 'ok'; marks: Record<string, string> }

export class DreamsStore {
  private readonly records: CasKvTable<DreamsRecord> & CheckedListKvTable<DreamsRecord>
  private readonly marks: CasKvTable<DreamMarks> & CheckedListKvTable<DreamMarks>

  constructor(records: CasKvTable<DreamsRecord> & CheckedListKvTable<DreamsRecord>, marks: CasKvTable<DreamMarks> & CheckedListKvTable<DreamMarks>) {
    this.records = records
    this.marks = marks
  }

  async read(): Promise<DreamsState> {
    const { entries, isComplete } = await this.records.listChecked()
    const settings = new Map<string, boolean>()
    const records = new Map<string, DreamsRecord>()
    let usageRuns: UsageRun[] = []
    for (const [key, record] of entries) {
      if (key === DREAMS_USAGE_KEY) { usageRuns = record.runs ?? []; continue }
      if (record.enabled !== undefined) settings.set(key, record.enabled)
      if (key !== DREAMS_ALL_KEY) records.set(key, record)
    }
    return { isComplete, settings, records, usageRuns }
  }

  /** 写一个范围的开关（scope 给 'all' 是默认值）；follow 去掉单独设置。记录里的其他内容不动。 */
  async setEnabled(scope: Scope | typeof DREAMS_ALL_KEY, value: boolean | 'follow'): Promise<void> {
    const key = scope === DREAMS_ALL_KEY ? DREAMS_ALL_KEY : scopeKey(scope)
    await this.records.update(key, (cur) => {
      const { enabled: _enabled, ...rest } = cur ?? { id: key }
      return value === 'follow' ? rest : { ...rest, enabled: value }
    })
  }

  /**
   * 一次运行开始：记成没做完（原因先写 lost，进程之后任何时候退出，下次都按上次没做完处理）。
   * 运行 id 就是它在账本里的批次条目 id（用不用得上都先记下）；上一次留下还没收尾的条目 id 接着带在这条记录里，
   * 收尾成了才由 stop / complete 去掉。上一次留下的已用名额（quotaUsed）同样接着带，做完才清。
   * 返回上一次留下的没做完的运行（没有为 undefined）。持有这个范围的认领时调用。
   */
  async begin(scope: Scope, runId: string, startedAt: number): Promise<DreamsUnfinished | undefined> {
    const key = scopeKey(scope)
    let previous: DreamsUnfinished | undefined
    await this.records.update(key, (cur) => {
      previous = cur?.unfinished
      const quota = previous?.quotaUsed !== undefined ? { quotaUsed: previous.quotaUsed } : {}
      return { ...cur, id: key, unfinished: { runId, startedAt, stoppedAt: startedAt, reason: 'lost', entryIds: [...(previous?.entryIds ?? []), runId], ...quota } }
    })
    return previous
  }

  /**
   * 一次运行做完：先写基线（带运行 id），再在一次写入里记完成、清掉没做完和连续出错。记录里的没做完已经不是这次运行的
   * （认领过期后别的进程开始了新的一次）就什么都不写，返回 false。
   */
  async complete(scope: Scope, run: { runId: string; startedAt: number; endedAt: number }, marks: Record<string, string>, lastResult: DreamsLastResult): Promise<boolean> {
    const key = scopeKey(scope)
    if ((await this.records.get(key))?.unfinished?.runId !== run.runId) return false
    await this.marks.put(key, { id: key, runId: run.runId, takenAt: run.startedAt, marks })
    return this.records.update(key, (cur) => {
      if (cur?.unfinished?.runId !== run.runId) return undefined
      const { unfinished: _unfinished, failure: _failure, ...rest } = cur
      return { ...rest, completed: run, lastResult }
    })
  }

  /**
   * 一次运行没做完：记下停在什么时候、为什么；出错的连续出错次数加一。同样核对运行 id。
   * entryIds：下次还要收尾的账本条目（这次的，加上这次没能收掉的以前的）。quotaUsed：到这次为止没做完的几次合起来用掉的名额，不给就不改。
   */
  async stop(scope: Scope, runId: string, stopped: { stoppedAt: number; reason: string; entryIds: string[]; quotaUsed?: number }, lastResult: DreamsLastResult): Promise<boolean> {
    const key = scopeKey(scope)
    return this.records.update(key, (cur) => {
      if (cur?.unfinished?.runId !== runId) return undefined
      const failure = stopped.reason === 'failed' ? { failure: { count: (cur.failure?.count ?? 0) + 1, failedAt: stopped.stoppedAt } } : {}
      return { ...cur, ...failure, lastResult, unfinished: { ...cur.unfinished, ...stopped } }
    })
  }

  /** 这个范围的变化基线。completedRunId 是它最近一次做完的运行；没做完过就没有基线。 */
  async baseline(scope: Scope, completedRunId: string | undefined): Promise<DreamsBaseline> {
    if (completedRunId === undefined) return { kind: 'none' }
    const stored = await this.marks.get(scopeKey(scope))
    return stored?.runId === completedRunId ? { kind: 'ok', marks: stored.marks } : { kind: 'unavailable' }
  }

  /**
   * 这个范围里用户撤销过的合并结论。侧表有条目读不出时返回 undefined：不知道撤销过哪些，这一轮不合并。
   */
  async undoneMerges(scope: Scope): Promise<ReadonlySet<string> | undefined> {
    const { entries, isComplete } = await this.records.listChecked()
    if (!isComplete) return undefined
    const record = entries.find(([key]) => key === scopeKey(scope))?.[1]
    return new Set((record?.undoneMerges ?? []).map(m => m.key))
  }

  /** 记下用户撤销了这几个梦境合并结论（同一个记过的挪到最后），只留最近的 UNDONE_MERGES_MAX 个。记录里的其他内容不动。 */
  async noteUndoneMerges(scope: Scope, keys: readonly string[], at: number): Promise<void> {
    if (keys.length === 0) return
    const key = scopeKey(scope)
    await this.records.update(key, (cur) => {
      const kept = (cur?.undoneMerges ?? []).filter(m => !keys.includes(m.key))
      return { ...cur, id: key, undoneMerges: [...kept, ...[...new Set(keys)].map(k => ({ key: k, at }))].slice(-UNDONE_MERGES_MAX) }
    })
  }

  /** 这次运行又用了这么多：累加到它那一行，顺手丢掉七天前的。 */
  async addUsage(runId: string, at: number, tokens: number): Promise<void> {
    if (!(tokens > 0)) return
    await this.records.update(DREAMS_USAGE_KEY, (cur) => {
      const runs = (cur?.runs ?? []).filter(run => run.at > at - 7 * DAY_MS)
      const mine = runs.find(run => run.runId === runId)
      const next = mine === undefined ? [...runs, { runId, at, tokens }] : runs.map(run => (run === mine ? { ...run, at, tokens: run.tokens + tokens } : run))
      return { id: DREAMS_USAGE_KEY, runs: next }
    })
  }
}
