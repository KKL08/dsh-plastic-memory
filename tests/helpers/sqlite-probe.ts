import * as sqlite from 'node:sqlite'
import type { SqliteModule } from '../../src/storage/root-lock.ts'

/**
 * 记下存储层执行过哪些 SQL 的 node:sqlite 替身：在加载 node:sqlite 这道进程边界上换进去（存储层的 loadSqlite 选项）。
 *
 * - 每条语句编译时用 SQLite 的授权回调记下它读哪些表的哪些列（`表.列`，全文索引表的 MATCH 记作 `segments_fts.segments_fts`）。
 * - 在 record 的回调里执行的语句逐条记下：SQL、读的列、取回几行。
 * - beforeExecute 给了的话，每条语句执行前先调它一次（判断要不要在这一刻插进别的连接的动作）。
 *
 * 只看存储层自己编译的语句：全文索引内部对影子表的读不记。
 */
export interface ExecutedStatement {
  sql: string
  reads: ReadonlySet<string>
  rows: number
}

export interface SqliteProbe {
  module: SqliteModule
  /** 跑 fn，返回它执行过的语句（按执行顺序）。 */
  record<T>(fn: () => T): { result: T; statements: ExecutedStatement[] }
  /** 每条语句执行前调；返回 undefined 的回调等于不设。 */
  beforeExecute: ((statement: Omit<ExecutedStatement, 'rows'>) => void) | undefined
}

type Statement = ReturnType<sqlite.DatabaseSync['prepare']>

export function sqliteProbe(): SqliteProbe {
  let compiling: Set<string> | undefined
  let executed: ExecutedStatement[] | undefined

  const probe: SqliteProbe = {
    module: undefined as unknown as SqliteModule,
    beforeExecute: undefined,
    record<T>(fn: () => T) {
      const statements: ExecutedStatement[] = []
      executed = statements
      try {
        return { result: fn(), statements }
      } finally {
        executed = undefined
      }
    },
  }

  const wrap = (statement: Statement, sql: string, reads: ReadonlySet<string>) => {
    const target = statement as unknown as Record<'all' | 'get' | 'iterate' | 'run', (...args: unknown[]) => unknown>
    const note = (rows: number) => { executed?.push({ sql, reads, rows }) }
    for (const method of ['all', 'get', 'iterate', 'run'] as const) {
      const original = target[method].bind(statement)
      target[method] = (...args: unknown[]) => {
        probe.beforeExecute?.({ sql, reads })
        const result = original(...args)
        if (method === 'all') note((result as unknown[]).length)
        else if (method === 'get') note(result === undefined ? 0 : 1)
        else if (method === 'run') note(0)
        else {
          // 逐行取的：取完一行记一行
          const entry: ExecutedStatement = { sql, reads, rows: 0 }
          executed?.push(entry)
          const iterator = result as Iterator<unknown>
          return {
            [Symbol.iterator]() { return this },
            next() {
              const step = iterator.next()
              if (step.done !== true) entry.rows += 1
              return step
            },
            return(value?: unknown) { return iterator.return?.(value) ?? { done: true, value } },
          }
        }
        return result
      }
    }
  }

  class ProbeDatabase extends sqlite.DatabaseSync {
    constructor(...args: ConstructorParameters<typeof sqlite.DatabaseSync>) {
      super(...args)
      this.setAuthorizer((action, table, column) => {
        if (action === sqlite.constants.SQLITE_READ && compiling !== undefined) compiling.add(`${table}.${column}`)
        return sqlite.constants.SQLITE_OK
      })
    }

    override prepare(...args: Parameters<sqlite.DatabaseSync['prepare']>): Statement {
      const reads = new Set<string>()
      compiling = reads
      let statement: Statement
      try {
        statement = super.prepare(...args)
      } finally {
        compiling = undefined
      }
      wrap(statement, args[0], reads)
      return statement
    }
  }

  probe.module = { DatabaseSync: ProbeDatabase } as unknown as SqliteModule
  return probe
}

/** 语句读了全文索引（MATCH 或取它的列）。 */
export const readsFullText = (s: Pick<ExecutedStatement, 'reads'>) => [...s.reads].some(r => r.startsWith('segments_fts.'))

/** 语句读了段的正文列。 */
export const readsSegmentText = (s: Pick<ExecutedStatement, 'reads'>) => s.reads.has('segments.text')
