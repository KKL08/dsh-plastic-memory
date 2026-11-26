import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import fc from 'fast-check'
import { OpJournal } from '../src/storage/op-journal.ts'
import { loadSqliteQuietly, type SqliteModule } from '../src/storage/root-lock.ts'
import {
  QUICK_CORRECTION_WINDOW_MS, USAGE_SIGNAL_KINDS, isQuickCorrection, type UsageSignalInput, type UsageSignalKind,
} from '../src/storage/usage-signals.ts'
import { MemoryStore } from '../src/store.ts'
import type { RecallStats } from '../src/storage/schema.ts'
import { InMemoryTable } from './helpers/in-memory-table.ts'
import { InMemoryBatchKvTable } from './helpers/in-memory-kv.ts'
import { interleaveParams, interleaveRuns } from './helpers/interleave.ts'
import { executeSearch } from '../src/tools/search.ts'
import { executeConfirm } from '../src/tools/confirm.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'
import { PendingDecisionsStore } from '../src/governance/decisions.ts'
import { SnapshotStore } from '../src/governance/snapshots.ts'
import type { MemorySnapshot, PendingDecision } from '../src/governance/schema.ts'
import { InMemoryKvTable } from './helpers/in-memory-kv.ts'
import { noInstructions } from './helpers/instructions.ts'
import { fakeExec } from './helpers/exec.ts'
import { record } from './helpers/record.ts'

// 使用信号的存储：操作日志库里单独一张表。记、读、去重、作用域隔离，库不可用、损坏、更新版本建的、执行出错时不记不读，
// 也不删库换库；两个连接（相当于两个进程）交错着记时不丢、不重复计。node:sqlite 在进程边界注入：
// 「可用」显式给真模块（有无 SQLite 两档都跑），「不可用」给 undefined；缺省加载器的那一档按这一档实际能不能加载分开断言。

const NOW = 1_800_000_000_000
const WS = '/proj/alpha'
const real: SqliteModule = { DatabaseSync }

let root: string
let path: string
let warnings: string[]
const log = { info() {}, warn: (m: string) => { warnings.push(m) }, error() {} }
const opened: OpJournal[] = []
function journal(loadSqlite: () => SqliteModule | undefined = () => real): OpJournal {
  const j = new OpJournal({ path, log, loadSqlite })
  opened.push(j)
  return j
}
const signal = (memoryId: string, kind: UsageSignalKind, key: string, scope = 'global'): UsageSignalInput => ({ scope, memoryId, kind, key, at: NOW })

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pm-usage-signals-'))
  path = join(root, 'local', 'op-journal.sqlite')
  warnings = []
})
afterEach(async () => {
  for (const j of opened.splice(0)) j.close()
  await rm(root, { recursive: true, force: true })
})

describe('记和读', () => {
  it('三种信号各自计数：每种是不同去重键的个数，没有行的记忆不在结果里', () => {
    const j = journal()
    j.recordUsage(signal('mem_a', 'full-read', 's1'))
    j.recordUsage(signal('mem_a', 'full-read', 's2'))
    j.recordUsage(signal('mem_a', 'confirm', 'c1'))
    j.recordUsage(signal('mem_a', 'quick-correction', 'op_1'))
    j.recordUsage(signal('mem_b', 'confirm', 'c2'))
    const read = j.readUsage('global', ['mem_a', 'mem_b', 'mem_none'])!
    expect(read.get('mem_a')).toEqual({ fullReads: 2, confirms: 1, quickCorrections: 1 })
    expect(read.get('mem_b')).toEqual({ fullReads: 0, confirms: 1, quickCorrections: 0 })
    expect(read.has('mem_none')).toBe(false)
  })

  it('同一个键再记一次不重复计，换个键照常加一；换种类的同一个键各算各的', () => {
    const j = journal()
    j.recordUsage(signal('mem_a', 'full-read', 's1'))
    j.recordUsage({ ...signal('mem_a', 'full-read', 's1'), at: NOW + 5 })
    expect(j.readUsage('global', ['mem_a'])!.get('mem_a')).toEqual({ fullReads: 1, confirms: 0, quickCorrections: 0 })
    j.recordUsage(signal('mem_a', 'full-read', 's2'))
    j.recordUsage(signal('mem_a', 'confirm', 's1'))
    expect(j.readUsage('global', ['mem_a'])!.get('mem_a')).toEqual({ fullReads: 2, confirms: 1, quickCorrections: 0 })
  })

  it('按作用域 + id 认：同一个 id 在全局和项目里各记各的，读一个作用域只看到它自己的', () => {
    const j = journal()
    j.recordUsage(signal('mem_a', 'confirm', 'k1', 'global'))
    j.recordUsage(signal('mem_a', 'confirm', 'k2', WS))
    j.recordUsage(signal('mem_a', 'confirm', 'k3', WS))
    expect(j.readUsage('global', ['mem_a'])!.get('mem_a')!.confirms).toBe(1)
    expect(j.readUsage(WS, ['mem_a'])!.get('mem_a')!.confirms).toBe(2)
    expect(j.readUsage('/proj/other', ['mem_a'])!.has('mem_a')).toBe(false)
  })

  it('只读问到的那几条：没问的记忆不在结果里；不问任何记忆时结果为空', () => {
    const j = journal()
    j.recordUsage(signal('mem_a', 'confirm', 'k1'))
    j.recordUsage(signal('mem_b', 'confirm', 'k1'))
    expect([...j.readUsage('global', ['mem_b'])!.keys()]).toEqual(['mem_b'])
    expect(j.readUsage('global', [])!.size).toBe(0)
  })

  it('库里有不认识的种类（更新的版本写的）：读的时候跳过，认得的照常计数，那一行留着', () => {
    const j = journal()
    j.recordUsage(signal('mem_a', 'confirm', 'k1'))
    const raw = new DatabaseSync(path)
    raw.prepare('INSERT INTO usage_signals(scope, memory_id, kind, key, at) VALUES (?, ?, ?, ?, ?)').run('global', 'mem_a', 'future-kind', 'x', NOW)
    raw.close()
    expect(j.readUsage('global', ['mem_a'])!.get('mem_a')).toEqual({ fullReads: 0, confirms: 1, quickCorrections: 0 })
    const check = new DatabaseSync(path)
    expect((check.prepare("SELECT COUNT(*) AS n FROM usage_signals WHERE kind = 'future-kind'").get() as { n: number }).n).toBe(1)
    check.close()
  })

  it('换一个实例（像进程重启）读到的是同一份：信号落在库文件里', () => {
    journal().recordUsage(signal('mem_a', 'quick-correction', 'op_1'))
    expect(journal().readUsage('global', ['mem_a'])!.get('mem_a')!.quickCorrections).toBe(1)
  })

  it('种类清单就是这三种', () => {
    expect([...USAGE_SIGNAL_KINDS]).toEqual(['full-read', 'confirm', 'quick-correction'])
  })
})

describe('库不可用、损坏、出错时不记不读', () => {
  it('node:sqlite 加载不到：记不抛错、什么都不写，读回 undefined（不是空结果）', () => {
    const j = journal(() => undefined)
    expect(() => j.recordUsage(signal('mem_a', 'confirm', 'k1'))).not.toThrow()
    expect(j.readUsage('global', ['mem_a'])).toBeUndefined()
    expect(existsSync(path)).toBe(false)
  })

  it('库文件损坏：记、读都不抛错，读回 undefined；库文件原样留着，不删、不换新库', () => {
    mkdirSync(dirname(path), { recursive: true })
    const garbage = Buffer.from('这不是一个 SQLite 库'.repeat(64))
    writeFileSync(path, garbage)
    const j = journal()
    expect(() => j.recordUsage(signal('mem_a', 'confirm', 'k1'))).not.toThrow()
    expect(j.readUsage('global', ['mem_a'])).toBeUndefined()
    expect(readFileSync(path).equals(garbage)).toBe(true)
    expect(warnings.length).toBeGreaterThan(0)
  })

  it('库是更新的版本建的：不记、读回 undefined，库里原有的东西不动', () => {
    mkdirSync(dirname(path), { recursive: true })
    const raw = new DatabaseSync(path)
    raw.exec('PRAGMA user_version = 99; CREATE TABLE ops(seq INTEGER PRIMARY KEY, op TEXT, at INTEGER, body TEXT); INSERT INTO ops(op, at, body) VALUES (\'op_x\', 1, \'{}\')')
    raw.close()
    const j = journal()
    j.recordUsage(signal('mem_a', 'confirm', 'k1'))
    expect(j.readUsage('global', ['mem_a'])).toBeUndefined()
    const check = new DatabaseSync(path)
    expect((check.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(99)
    expect(check.prepare("SELECT op FROM ops").all()).toEqual([{ op: 'op_x' }])
    expect(check.prepare("SELECT name FROM sqlite_master WHERE name = 'usage_signals'").get()).toBeUndefined()
    check.close()
  })

  it('锁外记信号不删别人的待完成行：库里有一行待补做的操作，记完信号它还在', () => {
    const j = journal()
    j.begin({ op: 'op_pending', at: NOW, target: { kind: 'index', dir: '/x', file: 'entry' }, steps: [] })
    const other = journal()
    other.recordUsage(signal('mem_a', 'confirm', 'k1'))
    expect(other.readUsage('global', ['mem_a'])!.get('mem_a')!.confirms).toBe(1)
    expect(j.pending().map(p => p.op)).toEqual(['op_pending'])
  })

  it('插入那一句执行出错：这一笔丢掉、记一条日志、不抛错；下一笔照常记上', () => {
    let failures = 1
    class FailingOnce extends DatabaseSync {
      override prepare(sql: string) {
        const statement = super.prepare(sql)
        if (!/\binsert\b[^;]*\busage_signals\b/i.test(sql)) return statement
        return new Proxy(statement, {
          get(target, key) {
            const value: unknown = Reflect.get(target, key, target)
            if (key !== 'run' || typeof value !== 'function') return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value
            return (...args: unknown[]) => {
              if (failures-- > 0) throw new Error('disk I/O error')
              return (value as (...a: unknown[]) => unknown).apply(target, args)
            }
          },
        })
      }
    }
    const j = journal(() => ({ DatabaseSync: FailingOnce }))
    expect(() => j.recordUsage(signal('mem_a', 'confirm', 'k1'))).not.toThrow()
    expect(warnings.some(w => w.includes('disk I/O error'))).toBe(true)
    j.recordUsage(signal('mem_a', 'confirm', 'k2'))
    expect(j.readUsage('global', ['mem_a'])!.get('mem_a')!.confirms).toBe(1)
  })

  it('查询执行出错：读回 undefined、不抛错；下一次读照常', () => {
    let failures = 1
    class FailingSelect extends DatabaseSync {
      override prepare(sql: string) {
        if (/\bselect\b[^;]*\busage_signals\b/i.test(sql) && failures-- > 0) throw new Error('disk I/O error')
        return super.prepare(sql)
      }
    }
    const j = journal(() => ({ DatabaseSync: FailingSelect }))
    j.recordUsage(signal('mem_a', 'confirm', 'k1'))
    expect(j.readUsage('global', ['mem_a'])).toBeUndefined()
    expect(j.readUsage('global', ['mem_a'])!.get('mem_a')!.confirms).toBe(1)
  })
})

describe('库忙时记信号不等锁', () => {
  /** 另一个连接拿着库的写锁（像别的进程正在写日志），直到 release。 */
  function holdWriteLock(): { release(): void } {
    const holder = new DatabaseSync(path)
    holder.exec('BEGIN IMMEDIATE')
    return { release() { holder.exec('ROLLBACK'); holder.close() } }
  }

  it('库被另一个连接占着写锁：记信号的那句插入执行时不等锁（忙等待为 0），这一笔丢掉、不抛错；放开后下一笔照常记上，别的路径的等待设置不变', () => {
    // 在 node:sqlite 边界探查：每句插入真正执行的那一刻，这个连接的忙等待是多少
    const waits: Array<{ table: string; timeout: number }> = []
    class Probe extends DatabaseSync {
      override prepare(sql: string) {
        const statement = super.prepare(sql)
        const table = /\binsert\b[^;]*\b(usage_signals|recent_changes)\b/i.exec(sql)?.[1]
        if (table === undefined) return statement
        const probe = () => (super.prepare('PRAGMA busy_timeout').get() as { timeout: number }).timeout
        return new Proxy(statement, {
          get(target, key) {
            const value: unknown = Reflect.get(target, key, target)
            if (typeof value !== 'function') return value
            if (key !== 'run') return (value as (...a: unknown[]) => unknown).bind(target)
            return (...args: unknown[]) => {
              waits.push({ table, timeout: probe() })
              return (value as (...a: unknown[]) => unknown).apply(target, args)
            }
          },
        })
      }
    }
    const j = journal(() => ({ DatabaseSync: Probe }))
    j.recordUsage(signal('mem_a', 'confirm', 'k0'))
    expect(j.readUsage('global', ['mem_a'])!.get('mem_a')!.confirms).toBe(1)
    const lock = holdWriteLock()
    expect(() => j.recordUsage(signal('mem_a', 'confirm', 'k1'))).not.toThrow()
    lock.release()
    j.recordUsage(signal('mem_a', 'confirm', 'k2'))
    expect(j.readUsage('global', ['mem_a'])!.get('mem_a')!.confirms).toBe(2)
    expect(waits.filter(w => w.table === 'usage_signals').map(w => w.timeout)).toEqual([0, 0, 0])
    // 写锁内的那条路（最近改动）照旧等锁
    j.recordChange({ op: 'op_1', scope: 'global', memoryId: 'mem_a', change: 'content', at: NOW })
    expect(waits.filter(w => w.table === 'recent_changes').map(w => w.timeout)).toEqual([1000])
  })

  it('库被另一个连接占着写锁时连记三笔：都悄悄丢掉、不告警、不重开连接；放开后再记一笔照常记上', () => {
    let opens = 0
    class Counting extends DatabaseSync {
      constructor(...args: ConstructorParameters<typeof DatabaseSync>) {
        super(...args)
        opens++
      }
    }
    const j = journal(() => ({ DatabaseSync: Counting }))
    j.recordUsage(signal('mem_a', 'confirm', 'k0'))
    const lock = holdWriteLock()
    for (const key of ['k1', 'k2', 'k3']) j.recordUsage(signal('mem_a', 'confirm', key))
    lock.release()
    expect(warnings).toEqual([])
    expect(j.readUsage('global', ['mem_a'])!.get('mem_a')!.confirms).toBe(1)
    j.recordUsage(signal('mem_a', 'confirm', 'k4'))
    expect(j.readUsage('global', ['mem_a'])!.get('mem_a')!.confirms).toBe(2)
    expect(opens).toBe(1)
  })

  it('库忙丢掉一笔、紧接着写最近改动（中间没有成功记过信号）：写锁内那条路的忙等待仍是 1000', () => {
    // 在 node:sqlite 边界探查：最近改动那句插入真正执行的那一刻，这个连接的忙等待是多少
    const waits: number[] = []
    class Probe extends DatabaseSync {
      override prepare(sql: string) {
        const statement = super.prepare(sql)
        if (!/\binsert\b[^;]*\brecent_changes\b/i.test(sql)) return statement
        const probe = () => (super.prepare('PRAGMA busy_timeout').get() as { timeout: number }).timeout
        return new Proxy(statement, {
          get(target, key) {
            const value: unknown = Reflect.get(target, key, target)
            if (typeof value !== 'function') return value
            if (key !== 'run') return (value as (...a: unknown[]) => unknown).bind(target)
            return (...args: unknown[]) => {
              waits.push(probe())
              return (value as (...a: unknown[]) => unknown).apply(target, args)
            }
          },
        })
      }
    }
    const j = journal(() => ({ DatabaseSync: Probe }))
    j.recordUsage(signal('mem_a', 'confirm', 'k0'))
    const lock = holdWriteLock()
    j.recordUsage(signal('mem_a', 'confirm', 'k1'))
    lock.release()
    j.recordChange({ op: 'op_1', scope: 'global', memoryId: 'mem_a', change: 'content', at: NOW })
    expect(waits).toEqual([1000])
  })

  it('库被另一个连接占着写锁时按 id 直达检索、确认刷新：结果照常返回，这两笔没记上；放开后再查照常记', async () => {
    const j = journal()
    const stats = new InMemoryBatchKvTable<RecallStats>()
    const store = new MemoryStore(new InMemoryTable(), log, stats, j)
    await store.put(record({ id: 'mem_a', name: '部署方式', summary: '部署', content: '部署用 docker compose。' }))
    const registry = buildTypeRegistry({ template: 'coding', customTypes: {} })
    const search = (sessionId: string) => executeSearch({ query: 'mem_a' }, fakeExec(), {
      store, registry, now: () => NOW, host: { contextOf: async () => ({ workspacePath: undefined, session: { id: sessionId, lastSeq: 1 } }) },
    })
    const confirmDeps = { store, decisions: new PendingDecisionsStore(new InMemoryKvTable<PendingDecision>()), snapshots: new SnapshotStore(new InMemoryKvTable<MemorySnapshot>()), instructions: noInstructions, now: () => NOW }
    // 库此刻可用：先记一笔，建好库和表
    store.noteUsage({ id: 'mem_seed', scope: 'global', workspacePath: undefined }, { kind: 'confirm', key: 'k0', at: NOW })
    expect(store.readUsage({ kind: 'global' }, ['mem_seed'])!.get('mem_seed')!.confirms).toBe(1)
    const lock = holdWriteLock()
    let hits
    let confirmed
    try {
      hits = (await search('s1')).hits
      confirmed = await executeConfirm({ action: 'refresh', memoryId: 'mem_a' }, { workspacePath: undefined }, confirmDeps)
    } finally {
      lock.release()
    }
    expect(hits[0]).toMatchObject({ id: 'mem_a', content: '部署用 docker compose。' })
    expect(confirmed.kind).toBe('refreshed')
    expect(store.readUsage({ kind: 'global' }, ['mem_a'])!.has('mem_a')).toBe(false)
    await search('s2')
    expect(store.readUsage({ kind: 'global' }, ['mem_a'])!.get('mem_a')).toEqual({ fullReads: 1, confirms: 0, quickCorrections: 0 })
  })
})

describe.runIf(loadSqliteQuietly() === undefined)('缺省加载器拿不到 node:sqlite 的一档', () => {
  it('缺省加载器：记不抛错、读回 undefined，不建库文件', () => {
    const j = new OpJournal({ path, log })
    opened.push(j)
    j.recordUsage(signal('mem_a', 'confirm', 'k1'))
    expect(j.readUsage('global', ['mem_a'])).toBeUndefined()
    expect(existsSync(path)).toBe(false)
  })
})

describe.runIf(loadSqliteQuietly() !== undefined)('缺省加载器拿得到 node:sqlite 的一档', () => {
  it('缺省加载器：记下的信号读得回来', () => {
    const j = new OpJournal({ path, log })
    opened.push(j)
    j.recordUsage(signal('mem_a', 'confirm', 'k1'))
    expect(j.readUsage('global', ['mem_a'])!.get('mem_a')!.confirms).toBe(1)
  })
})

describe('记忆存储上的入口', () => {
  const stats = () => new InMemoryBatchKvTable<RecallStats>()
  const project = { id: 'mem_p', scope: 'workspace' as const, workspacePath: WS }
  const global = { id: 'mem_g', scope: 'global' as const, workspacePath: undefined }

  it('记在这条记忆自己的作用域下：项目记忆按项目路径、全局记忆按全局', () => {
    const store = new MemoryStore(new InMemoryTable(), log, stats(), journal())
    store.noteUsage(project, { kind: 'full-read', key: 's1', at: NOW })
    store.noteUsage(global, { kind: 'full-read', key: 's1', at: NOW })
    expect(store.readUsage({ kind: 'workspace', workspacePath: WS }, ['mem_p'])!.get('mem_p')!.fullReads).toBe(1)
    expect(store.readUsage({ kind: 'global' }, ['mem_g'])!.get('mem_g')!.fullReads).toBe(1)
    expect(store.readUsage({ kind: 'global' }, ['mem_p'])!.has('mem_p')).toBe(false)
  })

  it('项目记忆缺项目路径（作用域推不出来）：不记，也不抛错；同一次里别的记忆照常记', () => {
    const store = new MemoryStore(new InMemoryTable(), log, stats(), journal())
    expect(() => store.noteUsage({ id: 'mem_x', scope: 'workspace', workspacePath: undefined }, { kind: 'confirm', key: 'k1', at: NOW })).not.toThrow()
    store.noteUsage(global, { kind: 'confirm', key: 'k1', at: NOW })
    expect(store.readUsage({ kind: 'global' }, ['mem_g', 'mem_x'])!.get('mem_g')!.confirms).toBe(1)
    const raw = new DatabaseSync(path)
    expect((raw.prepare('SELECT COUNT(*) AS n FROM usage_signals').get() as { n: number }).n).toBe(1)
    raw.close()
  })

  it('没接信号库：记什么都不做、不抛错，读回 undefined', () => {
    const store = new MemoryStore(new InMemoryTable(), log, stats())
    expect(() => store.noteUsage(global, { kind: 'confirm', key: 'k1', at: NOW })).not.toThrow()
    expect(store.readUsage({ kind: 'global' }, ['mem_g'])).toBeUndefined()
  })
})

describe('「用过之后很快纠错」的判定', () => {
  const at = NOW
  it('最后一次召回在窗口之内（含正好等于窗口）算', () => {
    expect(isQuickCorrection({ lastRecalledAt: at - 60_000 }, at)).toBe(true)
    expect(isQuickCorrection({ lastRecalledAt: at - QUICK_CORRECTION_WINDOW_MS }, at)).toBe(true)
  })
  it('最后一次召回早于窗口不算；从没召回过不算', () => {
    expect(isQuickCorrection({ lastRecalledAt: at - QUICK_CORRECTION_WINDOW_MS - 1 }, at)).toBe(false)
    expect(isQuickCorrection({ lastRecalledAt: null }, at)).toBe(false)
  })
  it('召回时刻晚于纠错时刻（别的会话刚召回过）也算', () => {
    expect(isQuickCorrection({ lastRecalledAt: at + 1_000 }, at)).toBe(true)
  })
  it('窗口是 24 小时', () => {
    expect(QUICK_CORRECTION_WINDOW_MS).toBe(24 * 60 * 60 * 1000)
  })
})

// 两个连接（像两个进程）各开各的，交错着记一批信号（含重复的键）。之后读出的每一格等于这一格里不同键的个数：不丢、不重复计。
// 中途插一次读：读到的每一格不超过最后的值。默认种子、60 轮；PM_INTERLEAVE_SEED / PM_INTERLEAVE_RUNS 覆盖。
const RUNS = 60
describe.runIf(loadSqliteQuietly() !== undefined)('并发记信号', () => {
  it('两个连接交错着记（含同一个键记几次）：每条记忆每种信号的计数等于不同键的个数', async () => {
    const scopeArb = fc.constantFrom('global', WS)
    const idArb = fc.constantFrom('mem_a', 'mem_b')
    const kindArb = fc.constantFrom<UsageSignalKind>(...USAGE_SIGNAL_KINDS)
    const keyArb = fc.constantFrom('k1', 'k2', 'k3')
    const opArb = fc.record({ via: fc.constantFrom(0, 1), scope: scopeArb, memoryId: idArb, kind: kindArb, key: keyArb })
    let round = 0
    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { minLength: 2, maxLength: 10 }), fc.nat({ max: 10 }), fc.scheduler(), async (ops, readAt, s) => {
        path = join(root, `round-${++round}`, 'op-journal.sqlite')
        const conns = [journal(), journal()]
        const stores = conns.map(c => new MemoryStore(new InMemoryTable(), log, new InMemoryBatchKvTable<RecallStats>(), c))
        const field = { 'full-read': 'fullReads', confirm: 'confirms', 'quick-correction': 'quickCorrections' } as const
        const midReads: Array<ReadonlyMap<string, unknown> | undefined> = []
        const tasks = ops.map((op, i) => s.schedule(Promise.resolve(i)).then(() => {
          const memory = op.scope === 'global' ? { id: op.memoryId, scope: 'global' as const, workspacePath: undefined } : { id: op.memoryId, scope: 'workspace' as const, workspacePath: op.scope }
          stores[op.via]!.noteUsage(memory, { kind: op.kind, key: op.key, at: NOW + i })
          if (i === readAt) midReads.push(conns[1 - op.via]!.readUsage('global', ['mem_a', 'mem_b']))
        }))
        await s.waitFor(Promise.all(tasks))
        for (const scope of ['global', WS]) {
          const read = conns[0]!.readUsage(scope, ['mem_a', 'mem_b'])
          expect(read, s.report().toString()).toBeDefined()
          for (const id of ['mem_a', 'mem_b']) {
            for (const kind of USAGE_SIGNAL_KINDS) {
              const expected = new Set(ops.filter(o => o.scope === scope && o.memoryId === id && o.kind === kind).map(o => o.key)).size
              expect(read!.get(id)?.[field[kind]] ?? 0, `${scope} ${id} ${kind}\n${s.report().toString()}`).toBe(expected)
            }
          }
        }
        const finalGlobal = conns[0]!.readUsage('global', ['mem_a', 'mem_b'])!
        for (const mid of midReads) {
          expect(mid).toBeDefined()
          for (const [id, counts] of mid! as ReadonlyMap<string, Record<string, number>>) {
            for (const [k, v] of Object.entries(counts)) expect(v).toBeLessThanOrEqual((finalGlobal.get(id) as unknown as Record<string, number>)[k]!)
          }
        }
        for (const c of conns) c.close()
      }),
      interleaveParams(RUNS),
    )
  }, Math.max(20_000, interleaveRuns(RUNS) * 400))
})
