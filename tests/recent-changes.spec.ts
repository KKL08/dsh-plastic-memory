import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { FileTable } from '../src/storage/file-table.ts'
import { OpJournal } from '../src/storage/op-journal.ts'
import { createRootLock, type SqliteModule } from '../src/storage/root-lock.ts'
import { ARCHIVE_DIR } from '../src/storage/paths.ts'
import { encodeRecord } from '../src/storage/frontmatter.ts'
import { newWriteOp } from '../src/storage/table.ts'
import {
  RECENT_CHANGES_PER_SCOPE, RECENT_CHANGE_STEP, classifyChange, currentWriteSession, withWriteSession, type RecentChangeInput,
} from '../src/storage/recent-changes.ts'
import type { RecallStats } from '../src/storage/schema.ts'
import type { MemoryRecord } from '../src/record-schema.ts'
import { InMemoryKvTable } from './helpers/in-memory-kv.ts'
import { record } from './helpers/record.ts'

// 最近改动记录：判定（纯函数）、操作日志库里的那张表、文件表写入时记下的行，以及写入中途进程退出后的补记。
// 进程退出在进程边界（node:fs/promises 的写调用）注入，写法同操作日志的补做测试：第 k 次写调用之前「进程没了」。

const fault = vi.hoisted(() => ({ remaining: Number.POSITIVE_INFINITY, isDead: false, calls: 0 }))
class Crash extends Error {}

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const writes = new Set(['appendFile', 'copyFile', 'cp', 'link', 'mkdir', 'rename', 'rm', 'rmdir', 'symlink', 'truncate', 'unlink', 'utimes', 'writeFile'])
  return Object.fromEntries(Object.entries(actual).map(([key, value]) => [key, typeof value === 'function' && writes.has(key)
    ? async (...args: unknown[]) => {
        // 建锁库目录不算：在这里失败会被当成「写锁不可用」，那是另一条路
        if (key === 'mkdir' && /[\\/]\.state[\\/]lock$/.test(String(args[0]))) return (value as (...a: unknown[]) => Promise<unknown>)(...args)
        if (fault.isDead || fault.remaining <= 0) {
          fault.isDead = true
          throw new Crash(`进程在 ${key} 之前退出`)
        }
        fault.remaining--
        fault.calls++
        return (value as (...a: unknown[]) => Promise<unknown>)(...args)
      }
    : value]))
})

/**
 * 只为测试注入的 node:sqlite（在 node:sqlite 边界动手）：SQL 匹配 failOn 的语句在执行时失败（prepare 出的语句和 db.exec 都算），
 * 每失败一次 failures 加一；after 是一次性钩子，匹配的语句执行完之后调一次。
 */
const sqlHook: { failOn?: RegExp; failures: number; after?: { on: RegExp; run(): void } } = { failures: 0 }
function hookedSqlite(): SqliteModule {
  const check = (sql: string) => {
    if (sqlHook.failOn?.test(sql) === true) {
      sqlHook.failures++
      throw new Error('disk I/O error')
    }
  }
  const after = (sql: string) => {
    const hook = sqlHook.after
    if (hook === undefined || !hook.on.test(sql)) return
    sqlHook.after = undefined
    hook.run()
  }
  class HookedDatabase extends DatabaseSync {
    override exec(sql: string): void {
      check(sql)
      super.exec(sql)
      after(sql)
    }
    override prepare(sql: string) {
      const statement = super.prepare(sql)
      return new Proxy(statement, {
        get(target, key) {
          const value: unknown = Reflect.get(target, key, target)
          if (typeof value !== 'function') return value
          return (...args: unknown[]) => {
            if (key !== 'run' && key !== 'get' && key !== 'all' && key !== 'iterate') return (value as (...a: unknown[]) => unknown).apply(target, args)
            check(sql)
            const result = (value as (...a: unknown[]) => unknown).apply(target, args)
            after(sql)
            return result
          }
        },
      })
    }
  }
  return { DatabaseSync: HookedDatabase }
}
/** 记一行的那一句插入。 */
const INSERT_CHANGE_SQL = /\b(insert|replace)\b[^;]*\brecent_changes\b/i
/** 插入之后的几步：裁掉多出的行、记挤掉的最大序号。 */
const PRUNE_SQL = /\bdelete\s+from\s+recent_changes\b|\b(insert|replace)\b[^;]*\brecent_change_floors\b|\bupdate\s+recent_change_floors\b/i
/** 读最近改动的查询（行、挤掉的序号、最大序号）。 */
const READ_CHANGES_SQL = /^\s*select\b[\s\S]*\bfrom\s+(recent_changes|recent_change_floors|sqlite_sequence)\b/i

const quiet = { info() {}, warn() {}, error() {} }
const GLOBAL = { kind: 'global' } as const
const WS = '/projects/demo'
const WS_SCOPE = { kind: 'workspace', workspacePath: WS } as const
const OTHER_WS = '/projects/other'

let root: string
let journalDir: string
const journals: OpJournal[] = []
beforeEach(async () => {
  fault.remaining = Number.POSITIVE_INFINITY
  fault.isDead = false
  sqlHook.failOn = undefined
  sqlHook.failures = 0
  sqlHook.after = undefined
  root = await mkdtemp(join(tmpdir(), 'pm-recent-root-'))
  journalDir = await mkdtemp(join(tmpdir(), 'pm-recent-journal-'))
})
afterEach(async () => {
  fault.remaining = Number.POSITIVE_INFINITY
  fault.isDead = false
  for (const journal of journals.splice(0)) journal.close()
  await rm(root, { recursive: true, force: true })
  await rm(journalDir, { recursive: true, force: true })
})

const journalPath = () => join(journalDir, 'op-journal.sqlite')

function openJournal(opts: Partial<ConstructorParameters<typeof OpJournal>[0]> = {}): OpJournal {
  const journal = new OpJournal({ path: journalPath(), log: quiet, ...opts })
  journals.push(journal)
  return journal
}

/** 一个「进程」：自己的锁、自己的日志连接。 */
function open() {
  const journal = openJournal()
  const table = new FileTable({ root, stats: new InMemoryKvTable<RecallStats>(), log: quiet, lock: createRootLock({ root, log: quiet }), journal })
  return { table, journal }
}

/** 某几个作用域里从头到现在的行，只留判断要看的几项。 */
const rowsOf = (journal: OpJournal, scopes: readonly string[] = ['global']) =>
  journal.changesSince(scopes, 0)!.rows.map(r => ({ scope: r.scope, memoryId: r.memoryId, change: r.change, movedTo: r.movedTo, session: r.session }))

const change = (op: string, partial: Partial<RecentChangeInput> = {}): RecentChangeInput =>
  ({ op, scope: 'global', memoryId: 'mem_a', change: 'content', at: 1, ...partial })

const lastChange = (op: string) => ({ kind: 'refine', at: 2, op, by: 'main' })

describe('哪些改动算数（判定）', () => {
  const base = record({ id: 'mem_a', name: '甲', summary: '甲的摘要', content: '第一版', lastChange: { kind: 'refine', at: 1, op: 'op_1', by: 'main' } })
  const ws = record({ id: 'mem_w', scope: 'workspace', workspacePath: WS })

  it('新建不算；物理删除算删除，记在改前那份的作用域', () => {
    expect(classifyChange(undefined, base)).toBeUndefined()
    expect(classifyChange(base, undefined)).toEqual({ scope: 'global', change: 'deleted' })
    expect(classifyChange(ws, undefined)).toEqual({ scope: WS, change: 'deleted' })
  })

  it('最近一次内容改动的操作 id 变了（含一边没有）、名称或摘要变了：算内容改动', () => {
    expect(classifyChange(base, { ...base, content: '第二版', lastChange: { kind: 'refine', at: 2, op: 'op_2', by: 'main' } })).toEqual({ scope: 'global', change: 'content' })
    const { lastChange: _dropped, ...withoutLastChange } = base
    expect(classifyChange(withoutLastChange as MemoryRecord, base)).toEqual({ scope: 'global', change: 'content' })
    expect(classifyChange(base, { ...base, name: '乙' })).toEqual({ scope: 'global', change: 'content' })
    expect(classifyChange(base, { ...base, summary: '新摘要' })).toEqual({ scope: 'global', change: 'content' })
  })

  it('补证、只改元数据（档位、关联、锁、确认时间）、正文变了但最近一次内容改动没变：不算', () => {
    // 前提：同一条记录改了名称是算的
    expect(classifyChange(base, { ...base, name: '乙' })).toEqual({ scope: 'global', change: 'content' })
    expect(classifyChange(base, { ...base, lastConfirmedAt: 99, sourceTrail: [] })).toBeUndefined()
    expect(classifyChange(base, { ...base, recall: 'core', related: ['mem_x'], locked: true })).toBeUndefined()
    expect(classifyChange(base, { ...base, content: '旧版本或手改写的正文' })).toBeUndefined()
  })

  it('在用变成被取代、软删：分别算被取代、删除；从最近删除恢复、非在用之间的变化不算', () => {
    expect(classifyChange(base, { ...base, status: 'superseded' })).toEqual({ scope: 'global', change: 'superseded' })
    expect(classifyChange(base, { ...base, status: 'deleted', deletedAt: 5 })).toEqual({ scope: 'global', change: 'deleted' })
    expect(classifyChange({ ...base, status: 'deleted', deletedAt: 5 }, base)).toBeUndefined()
    expect(classifyChange({ ...base, status: 'deleted', deletedAt: 5 }, { ...base, status: 'superseded' })).toBeUndefined()
  })

  it('作用域变了（提升为全局、移到项目、项目之间搬）：算移走，记在改前的作用域，带上去向；同时改了内容也只算移走', () => {
    expect(classifyChange(ws, { ...ws, scope: 'global', workspacePath: undefined })).toEqual({ scope: WS, change: 'moved', movedTo: 'global' })
    expect(classifyChange(base, { ...base, scope: 'workspace', workspacePath: WS })).toEqual({ scope: 'global', change: 'moved', movedTo: WS })
    expect(classifyChange(ws, { ...ws, workspacePath: OTHER_WS, content: '改了', lastChange: lastChange('op_9') })).toEqual({ scope: WS, change: 'moved', movedTo: OTHER_WS })
  })

  it('改前已不在用（软删的、被取代的）：彻底删除、换作用域都不算（离开在用时已经算过）', () => {
    const deleted = { ...base, status: 'deleted' as const, deletedAt: 5 }
    const superseded = { ...base, status: 'superseded' as const }
    // 前提：在用的同样两种改动是算的
    expect(classifyChange(base, undefined)).toEqual({ scope: 'global', change: 'deleted' })
    expect(classifyChange(base, { ...base, scope: 'workspace', workspacePath: WS })).toEqual({ scope: 'global', change: 'moved', movedTo: WS })
    expect(classifyChange(deleted, undefined)).toBeUndefined()
    expect(classifyChange(superseded, undefined)).toBeUndefined()
    expect(classifyChange(deleted, { ...deleted, scope: 'workspace', workspacePath: WS })).toBeUndefined()
    expect(classifyChange(superseded, { ...superseded, scope: 'workspace', workspacePath: WS })).toBeUndefined()
  })

  it('作用域推不出来的记录（项目记忆缺项目路径）不算', () => {
    const broken = { ...ws, workspacePath: undefined }
    // 前提：推得出作用域时同样的改动是算的
    expect(classifyChange(ws, { ...ws, name: '改了名' })).toEqual({ scope: WS, change: 'content' })
    expect(classifyChange(ws, undefined)).toEqual({ scope: WS, change: 'deleted' })
    expect(classifyChange(broken, { ...broken, name: '改了名' })).toBeUndefined()
    expect(classifyChange(broken, undefined)).toBeUndefined()
  })
})

describe('发起写入的会话', () => {
  it('包在 withWriteSession 里的调用链（含等待之后）读得到会话 id，包外读不到；不给会话 id 等于不包', async () => {
    expect(currentWriteSession()).toBeUndefined()
    const seen = await withWriteSession('sess-a', async () => {
      const first = currentWriteSession()
      await new Promise(resolve => setImmediate(resolve))
      return [first, currentWriteSession()]
    })
    expect(seen).toEqual(['sess-a', 'sess-a'])
    expect(currentWriteSession()).toBeUndefined()
    expect(await withWriteSession(undefined, async () => currentWriteSession())).toBeUndefined()
    expect(await withWriteSession('sess-a', () => withWriteSession('sess-b', async () => currentWriteSession()))).toBe('sess-b')
  })
})

describe('操作日志库里的最近改动记录', () => {
  it('按作用域和起点查之后的行（升序）；同一个操作只记一行；最大序号随记录增长，空库为 0', () => {
    const journal = openJournal()
    expect(journal.latestChangeSeq()).toBe(0)
    journal.recordChange(change('op_1', { session: 'sess-a' }))
    journal.recordChange(change('op_2', { scope: WS, memoryId: 'mem_w', change: 'moved', movedTo: 'global' }))
    journal.recordChange(change('op_3', { memoryId: 'mem_b', change: 'deleted' }))
    journal.recordChange(change('op_1', { memoryId: 'mem_dup' }))
    const all = journal.changesSince(['global', WS], 0)!
    expect(all.rows.map(r => [r.memoryId, r.change, r.movedTo, r.session])).toEqual([
      ['mem_a', 'content', undefined, 'sess-a'], ['mem_w', 'moved', 'global', undefined], ['mem_b', 'deleted', undefined, undefined],
    ])
    expect(all.rows.map(r => r.seq)).toEqual([...all.rows.map(r => r.seq)].sort((a, b) => a - b))
    // 序号只增不减，可能有空号（被忽略的重复插入也可能占掉一个）
    expect(all.latestSeq).toBeGreaterThanOrEqual(all.rows.at(-1)!.seq)
    expect(journal.latestChangeSeq()).toBe(all.latestSeq)
    const after = journal.changesSince(['global'], all.rows[0]!.seq)!
    expect(after.rows.map(r => r.memoryId)).toEqual(['mem_b'])
    expect(journal.changesSince([OTHER_WS], 0)!.rows).toEqual([])
  })

  it(`每个作用域只留最近 ${RECENT_CHANGES_PER_SCOPE} 行，挤掉的最大序号记下来；别的作用域不受影响`, () => {
    const journal = openJournal()
    journal.recordChange(change('op_ws', { scope: WS }))
    for (let i = 0; i < RECENT_CHANGES_PER_SCOPE + 5; i++) journal.recordChange(change(`op_g${i}`, { memoryId: `mem_${i}` }))
    const read = journal.changesSince(['global', WS], 0)!
    const global = read.rows.filter(r => r.scope === 'global')
    expect(global).toHaveLength(RECENT_CHANGES_PER_SCOPE)
    expect(global[0]!.memoryId).toBe('mem_5')
    expect(read.rows.filter(r => r.scope === WS).map(r => r.memoryId)).toEqual(['mem_a'])
    // 挤掉的是 mem_0 到 mem_4 那五行：最大序号比留下的第一行小
    expect(read.prunedThrough.global).toBe(global[0]!.seq - 1)
    expect(read.prunedThrough[WS]).toBe(0)
    expect(read.latestSeq).toBe(global.at(-1)!.seq)
  })

  it('新表加在原来的库里，库的版本号不变：上一个开发版建的库（只有待完成表、版本 1）照常打开，待完成行还在', () => {
    const old = new DatabaseSync(journalPath())
    old.exec('CREATE TABLE ops(seq INTEGER PRIMARY KEY AUTOINCREMENT, op TEXT NOT NULL UNIQUE, at INTEGER NOT NULL, body TEXT NOT NULL)')
    old.exec('PRAGMA user_version = 1')
    old.prepare('INSERT INTO ops(op, at, body) VALUES (?, ?, ?)').run('op_left', 1, JSON.stringify({ target: { kind: 'index', dir: '/x', file: 'entry' }, steps: [] }))
    old.close()
    const journal = openJournal()
    journal.recordChange(change('op_1'))
    expect(rowsOf(journal)).toEqual([{ scope: 'global', memoryId: 'mem_a', change: 'content', movedTo: undefined, session: undefined }])
    expect(journal.pending().map(row => row.op)).toEqual(['op_left'])
    journal.close()
    const check = new DatabaseSync(journalPath())
    expect((check.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(1)
    check.close()
  })

  it('记一行的几步（插入、裁到定长、记挤掉的序号）在一个事务里：后面一步失败时读回和记之前一样；之后照常记', () => {
    const journal = openJournal({ loadSqlite: hookedSqlite })
    for (let i = 0; i < RECENT_CHANGES_PER_SCOPE; i++) journal.recordChange(change(`op_${i}`, { memoryId: `mem_${i}` }))
    const before = journal.changesSince(['global'], 0)!
    expect(before.rows).toHaveLength(RECENT_CHANGES_PER_SCOPE)
    expect(before.prunedThrough.global).toBe(0)
    sqlHook.failOn = PRUNE_SQL
    journal.recordChange(change('op_over', { memoryId: 'mem_over' }))
    sqlHook.failOn = undefined
    // 前提：插入之后的那一步确实执行过、失败了
    expect(sqlHook.failures).toBeGreaterThan(0)
    expect(journal.changesSince(['global'], 0)).toEqual(before)
    // 多走一步：再记一行，照常裁到定长、记下挤掉的序号
    journal.recordChange(change('op_next', { memoryId: 'mem_next' }))
    const after = journal.changesSince(['global'], 0)!
    expect(after.rows).toHaveLength(RECENT_CHANGES_PER_SCOPE)
    expect(after.rows.map(r => r.memoryId)).toEqual([...before.rows.slice(1).map(r => r.memoryId), 'mem_next'])
    expect(after.prunedThrough.global).toBe(before.rows[0]!.seq)
    expect(after.latestSeq).toBe(after.rows.at(-1)!.seq)
  })

  it('读「之后改了什么」的几次查询在一个读事务里：读到一半别的连接记了一行，读回的行、最大序号是同一刻的', () => {
    const journal = openJournal({ loadSqlite: hookedSqlite })
    const other = openJournal()
    journal.recordChange(change('op_1'))
    other.recordChange(change('op_2', { memoryId: 'mem_b' }))
    let isFired = false
    sqlHook.after = { on: READ_CHANGES_SQL, run: () => { isFired = true; other.recordChange(change('op_mid', { memoryId: 'mem_mid' })) } }
    const read = journal.changesSince(['global'], 0)!
    // 前提：读到一半时另一个连接确实记下了一行
    expect(isFired).toBe(true)
    const now = journal.changesSince(['global'], 0)!
    expect(now.rows.map(r => r.memoryId)).toEqual(['mem_a', 'mem_b', 'mem_mid'])
    // 这次读回的是同一刻：行恰好是那一刻库里序号不超过最大序号的全部行
    expect(read.rows.every(r => r.seq <= read.latestSeq)).toBe(true)
    expect(read.rows).toEqual(now.rows.filter(r => r.seq <= read.latestSeq))
  })

  it('锁外的两个读方法打不开库：读回 undefined，不删库、不换新库；写入路径照旧换新库，之后读得出', () => {
    const garbage = Buffer.alloc(8192, 'x')
    mkdirSync(journalDir, { recursive: true })
    writeFileSync(journalPath(), garbage)
    const journal = openJournal()
    expect(journal.latestChangeSeq()).toBeUndefined()
    expect(journal.changesSince(['global'], 0)).toBeUndefined()
    expect(readFileSync(journalPath()).equals(garbage)).toBe(true)
    // 写锁内的写入路径照旧：打不开就换新库（这个实例没有因为读失败而放弃）
    journal.recordChange(change('op_1'))
    expect(readFileSync(journalPath()).equals(garbage)).toBe(false)
    expect(rowsOf(journal)).toEqual([{ scope: 'global', memoryId: 'mem_a', change: 'content', movedTo: undefined, session: undefined }])
    expect(journal.latestChangeSeq()).toBe(journal.changesSince(['global'], 0)!.rows[0]!.seq)
  })

  it('node:sqlite 加载不到：记不下、读不出（回 undefined），不抛错', () => {
    const journal = openJournal({ loadSqlite: () => undefined })
    expect(() => journal.recordChange(change('op_1'))).not.toThrow()
    expect(journal.latestChangeSeq()).toBeUndefined()
    expect(journal.changesSince(['global'], 0)).toBeUndefined()
  })
})

describe('文件表写入时记下的行', () => {
  const seed = (partial: Partial<MemoryRecord> = {}) => record({ id: 'mem_a', name: '甲', summary: '甲的摘要', content: '第一版', ...partial })

  it('新建、补证、只改元数据、恢复不记；内容改动、改名改摘要、被取代、软删、彻底删除各记一行', async () => {
    const { table, journal } = open()
    await table.create(seed())
    await table.create(seed({ id: 'mem_b', name: '乙' }))
    await table.update('mem_a', GLOBAL, r => ({ ...r, lastConfirmedAt: 50 }))
    await table.update('mem_a', GLOBAL, r => ({ ...r, recall: 'core', related: ['mem_b'] }))
    expect(rowsOf(journal)).toEqual([])

    await table.update('mem_a', GLOBAL, r => ({ ...r, content: '第二版', lastChange: lastChange('op_c') }))
    await table.update('mem_a', GLOBAL, r => ({ ...r, summary: '新摘要' }))
    await table.update('mem_b', GLOBAL, r => ({ ...r, status: 'superseded' }))
    await table.update('mem_a', GLOBAL, r => ({ ...r, status: 'deleted' }))
    await table.update('mem_a', GLOBAL, r => ({ ...r, status: 'active', deletedAt: undefined }))
    await table.delete('mem_a', GLOBAL)
    expect(rowsOf(journal).map(r => [r.memoryId, r.change])).toEqual([
      ['mem_a', 'content'], ['mem_a', 'content'], ['mem_b', 'superseded'], ['mem_a', 'deleted'], ['mem_a', 'deleted'],
    ])
  })

  it('已不在用的记忆被彻底删除、换作用域：不再记行；按位置算，放在最近删除里的文件一律不在用', async () => {
    const { table, journal } = open()
    await table.create(seed())
    await table.create(seed({ id: 'mem_b', name: '乙' }))
    await table.update('mem_a', GLOBAL, r => ({ ...r, status: 'deleted' }))
    await table.update('mem_b', GLOBAL, r => ({ ...r, status: 'superseded' }))
    // 手放进最近删除的文件，文件头仍写着在用
    const globalDir = (await table.locate('mem_a', GLOBAL))!.dir
    mkdirSync(join(globalDir, ARCHIVE_DIR), { recursive: true })
    writeFileSync(join(globalDir, ARCHIVE_DIR, 'hand.md'), encodeRecord(seed({ id: 'mem_hand', name: '手放的' }), {}))
    expect((await table.locate('mem_hand', GLOBAL))!.record.status).toBe('active')
    const atStart = rowsOf(journal, ['global', WS]).map(r => [r.memoryId, r.change])
    expect(atStart).toEqual([['mem_a', 'deleted'], ['mem_b', 'superseded']])

    expect(await table.delete('mem_a', GLOBAL)).toBe(true)
    await table.update('mem_b', GLOBAL, r => ({ ...r, scope: 'workspace', workspacePath: WS }))
    expect(await table.delete('mem_hand', GLOBAL)).toBe(true)
    // 前提：确实删掉、搬走了
    expect(await table.locate('mem_a', GLOBAL)).toBeUndefined()
    expect(await table.locate('mem_hand', GLOBAL)).toBeUndefined()
    expect((await table.locate('mem_b', WS_SCOPE))!.record).toMatchObject({ status: 'superseded', workspacePath: WS })
    expect(rowsOf(journal, ['global', WS]).map(r => [r.memoryId, r.change])).toEqual(atStart)
  })

  it('提升为全局、移到项目：在原来的作用域记一行移走，带上去向', async () => {
    const { table, journal } = open()
    await table.create(seed({ scope: 'workspace', workspacePath: WS }))
    await table.put({ ...seed(), scope: 'global', workspacePath: undefined }, WS_SCOPE)
    await table.update('mem_a', GLOBAL, r => ({ ...r, scope: 'workspace', workspacePath: OTHER_WS }))
    expect(rowsOf(journal, ['global', WS, OTHER_WS]).map(r => [r.scope, r.change, r.movedTo])).toEqual([[WS, 'moved', 'global'], ['global', 'moved', OTHER_WS]])
  })

  it('写入时在 withWriteSession 里：行记着发起的会话；包外（界面、后台）的写入不带会话；并发的两个会话各记各的', async () => {
    const { table, journal } = open()
    await table.create(seed())
    await table.create(seed({ id: 'mem_b', name: '乙' }))
    await withWriteSession('sess-a', () => table.update('mem_a', GLOBAL, r => ({ ...r, summary: 'a 改的' })))
    await table.update('mem_b', GLOBAL, r => ({ ...r, summary: '界面改的' }))
    await Promise.all([
      withWriteSession('sess-x', () => table.update('mem_a', GLOBAL, r => ({ ...r, summary: 'x 改的' }))),
      withWriteSession('sess-y', () => table.update('mem_b', GLOBAL, r => ({ ...r, summary: 'y 改的' }))),
    ])
    const rows = rowsOf(journal)
    expect(rows.slice(0, 2).map(r => [r.memoryId, r.session])).toEqual([['mem_a', 'sess-a'], ['mem_b', undefined]])
    expect(Object.fromEntries(rows.slice(2).map(r => [r.memoryId, r.session]))).toEqual({ mem_a: 'sess-x', mem_b: 'sess-y' })
  })

  it('调用方自带操作的写入：最近改动在提交后就记下，不等调用方结这次操作', async () => {
    const { table, journal } = open()
    await table.create(seed())
    const op = newWriteOp({ steps: [] })
    const written = await table.update('mem_a', GLOBAL, r => ({ ...r, summary: '改了' }), op)
    expect(rowsOf(journal).map(r => r.memoryId)).toEqual(['mem_a'])
    await table.finishOp(op, written)
    expect(rowsOf(journal)).toHaveLength(1)
    expect(journal.pending()).toEqual([])
  })

  it('补记这一步记在操作日志的待完成行里（中断后补做靠它）', async () => {
    const { table, journal } = open()
    await table.create(seed())
    const op = newWriteOp({ steps: [] })
    await withWriteSession('sess-a', () => table.update('mem_a', GLOBAL, r => ({ ...r, summary: '改了' }), op))
    const [row] = journal.pending()
    expect(row!.op).toBe(op.id)
    expect(row!.steps).toEqual([expect.objectContaining({ kind: RECENT_CHANGE_STEP, memoryId: 'mem_a', change: 'content', session: 'sess-a' })])
  })

  it('最近改动记不下（node:sqlite 不可用、记行的那一句失败）：写入照常成功；之后记得下时照常记', async () => {
    const unavailable = openJournal({ loadSqlite: () => undefined })
    const bare = new FileTable({ root, stats: new InMemoryKvTable<RecallStats>(), log: quiet, lock: createRootLock({ root, log: quiet }), journal: unavailable })
    await bare.create(seed())
    await bare.update('mem_a', GLOBAL, r => ({ ...r, summary: '改了' }))
    expect((await bare.locate('mem_a', GLOBAL))!.record.summary).toBe('改了')

    const journal = openJournal({ loadSqlite: hookedSqlite })
    const table = new FileTable({ root, stats: new InMemoryKvTable<RecallStats>(), log: quiet, lock: createRootLock({ root, log: quiet }), journal })
    sqlHook.failOn = INSERT_CHANGE_SQL
    await table.update('mem_a', GLOBAL, r => ({ ...r, summary: '又改了' }))
    sqlHook.failOn = undefined
    // 前提：这次写入确实去记了这一行，记的时候失败了
    expect(sqlHook.failures).toBeGreaterThan(0)
    expect((await table.locate('mem_a', GLOBAL))!.record.summary).toBe('又改了')
    expect(rowsOf(journal)).toEqual([])
    // 多走一步：库恢复后下一次写入照常记
    await table.update('mem_a', GLOBAL, r => ({ ...r, summary: '第三次改' }))
    expect(rowsOf(journal).map(r => [r.memoryId, r.change])).toEqual([['mem_a', 'content']])
  })

  it('改动提交前后每一个写调用之前进程退出：重启后进一次写入段，写成了的恰好补记一行（带着会话），没写成的不记', async () => {
    const prepare = async () => {
      const setup = open()
      await setup.table.create(seed())
      await setup.table.create(record({ id: 'mem_other', name: '旁观' }))
    }
    const run = (table: FileTable) => withWriteSession('sess-b', () => table.update('mem_a', GLOBAL, r => ({ ...r, name: '乙', summary: '改过的摘要' })))
    await prepare()
    const dry = open()
    fault.calls = 0
    await run(dry.table)
    const total = fault.calls
    expect(total).toBeGreaterThan(0)
    const outcomes = new Set<string>()
    for (let k = 0; k <= total; k++) {
      for (const journal of journals.splice(0)) journal.close()
      await rm(root, { recursive: true, force: true })
      await rm(journalDir, { recursive: true, force: true })
      root = await mkdtemp(join(tmpdir(), 'pm-recent-root-'))
      journalDir = await mkdtemp(join(tmpdir(), 'pm-recent-journal-'))
      await prepare()
      const dying = open()
      fault.remaining = k
      await run(dying.table).then(() => { fault.isDead = true }, (err: unknown) => { if (!(err instanceof Crash) && !fault.isDead) throw err })
      fault.remaining = Number.POSITIVE_INFINITY
      fault.isDead = false
      const next = open()
      await next.table.update('mem_other', GLOBAL, r => ({ ...r, lastConfirmedAt: r.lastConfirmedAt + 1 }))
      await next.table.update('mem_other', GLOBAL, r => ({ ...r, lastConfirmedAt: r.lastConfirmedAt + 1 }))
      const isWritten = (await next.table.locate('mem_a', GLOBAL))!.record.summary === '改过的摘要'
      const rows = rowsOf(next.journal).filter(r => r.memoryId === 'mem_a')
      expect(rows, `第 ${k} 次之前退出`).toEqual(isWritten ? [{ scope: 'global', memoryId: 'mem_a', change: 'content', movedTo: undefined, session: 'sess-b' }] : [])
      outcomes.add(isWritten ? 'after' : 'before')
    }
    expect([...outcomes].sort()).toEqual(['after', 'before'])
  })

  it('最近改动的行不存正文和摘要：库文件里找不到写进去的文字', async () => {
    const { table, journal } = open()
    await table.create(seed())
    await table.update('mem_a', GLOBAL, r => ({ ...r, summary: '独一无二的摘要文字', content: '独一无二的正文', lastChange: lastChange('op_x') }))
    // 前提：这次改动确实记下了一行
    expect(rowsOf(journal).map(r => [r.memoryId, r.change])).toEqual([['mem_a', 'content']])
    journal.close()
    const raw = await readFile(journalPath()).catch(() => Buffer.alloc(0))
    const wal = await readFile(`${journalPath()}-wal`).catch(() => Buffer.alloc(0))
    expect(Buffer.concat([raw, wal]).includes(Buffer.from('独一无二'))).toBe(false)
  })
})
