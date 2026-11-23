import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OpJournal, type OpJournalOptions, type PendingOp } from '../src/storage/op-journal.ts'

// 操作日志库：真 node:sqlite、临时目录。「另一个进程」用同一路径上的第二个实例模拟（各有自己的连接）。

let dir: string
let journals: OpJournal[] = []
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'pm-op-journal-')) })
afterEach(async () => {
  for (const journal of journals.splice(0)) journal.close()
  await rm(dir, { recursive: true, force: true })
})

const journalPath = () => join(dir, 'nested', 'op-journal.sqlite')

function open(extra: Partial<OpJournalOptions> = {}) {
  const warnings: string[] = []
  const log = { info: () => {}, warn: (m: string) => { warnings.push(m) }, error: (m: string) => { warnings.push(m) } }
  const journal = new OpJournal({ path: journalPath(), log, ...extra })
  journals.push(journal)
  return { journal, warnings }
}

function op(id: string, extra: Partial<PendingOp> = {}): PendingOp {
  return {
    op: id, at: 1_700_000_000_000,
    target: { kind: 'write', memoryId: 'mem_a', dir: '/root/global', fields: ['content'], after: 'f2' },
    steps: [],
    ...extra,
  }
}

describe('操作日志库', () => {
  it('没写过时不建库：查待完成是空的', () => {
    const { journal } = open()
    expect(journal.hasPending()).toBe(false)
    expect(journal.pending()).toEqual([])
  })

  it('插一行待完成后查得到，标完成后查不到', () => {
    const { journal } = open()
    const row = op('op_1', { initiator: 'main', batch: 'batch_1', steps: [{ kind: 'ledger-settled', entryId: 'pd_1' }] })
    journal.begin(row)
    expect(journal.hasPending()).toBe(true)
    expect(journal.pending()).toEqual([row])
    journal.done('op_1')
    expect(journal.hasPending()).toBe(false)
    expect(journal.pending()).toEqual([])
  })

  it('待完成的行按插入先后返回', () => {
    const { journal } = open()
    journal.begin(op('op_b'))
    journal.begin(op('op_a'))
    expect(journal.pending().map(row => row.op)).toEqual(['op_b', 'op_a'])
  })

  it('同一个操作再插一次是替换：重来的那一轮换了目标位置', () => {
    const { journal } = open()
    journal.begin(op('op_1'))
    const retried = op('op_1', { target: { kind: 'write', memoryId: 'mem_a', dir: '/root/global/.archive', fields: ['status'], after: 'f3' } })
    journal.begin(retried)
    expect(journal.pending()).toEqual([retried])
  })

  it('进程退出后行还在：另一个实例看得到，也能替它标完成', () => {
    const { journal: crashed } = open()
    crashed.begin(op('op_1'))
    const { journal: next } = open()
    expect(next.pending().map(row => row.op)).toEqual(['op_1'])
    next.done('op_1')
    expect(crashed.hasPending()).toBe(false)
  })

  it('标完成一个不存在的操作不报错', () => {
    const { journal } = open()
    expect(() => { journal.done('op_missing') }).not.toThrow()
  })

  describe('不可用时退化', () => {
    it('node:sqlite 加载不到：写入照常不报错，什么都不记，只警告一次', () => {
      const { journal, warnings } = open({ loadSqlite: () => undefined })
      journal.begin(op('op_1'))
      journal.begin(op('op_2'))
      expect(journal.isAvailable()).toBe(false)
      expect(journal.hasPending()).toBe(false)
      expect(journal.pending()).toEqual([])
      expect(() => { journal.done('op_1') }).not.toThrow()
      expect(warnings).toHaveLength(1)
      expect(existsSync(journalPath())).toBe(false)
    })

    it('库正被别的连接占着：不删库，这一次不记，下次打开照常，原来的待完成行还在', async () => {
      const { journal: first } = open()
      first.begin(op('op_1'))
      first.close()
      const sqlite = await import('node:sqlite')
      let isBusy = true
      class BusyOnce extends sqlite.DatabaseSync {
        constructor(path: string) {
          super(path)
          if (!isBusy) return
          this.close()
          throw Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR', errcode: 5 })
        }
      }
      const { journal, warnings } = open({ loadSqlite: () => ({ ...sqlite, DatabaseSync: BusyOnce }) })
      journal.begin(op('op_2'))
      expect(warnings).toHaveLength(1)
      isBusy = false
      expect(journal.pending().map(p => p.op)).toEqual(['op_1'])
      journal.begin(op('op_3'))
      expect(journal.pending().map(p => p.op)).toEqual(['op_1', 'op_3'])
    })

    it('库文件损坏：换一个新库接着用，丢掉的只是原来的待完成行', async () => {
      const { journal: first } = open()
      first.begin(op('op_1'))
      first.close()
      await writeFile(journalPath(), 'not a database, not even close '.repeat(200))
      await rm(`${journalPath()}-wal`, { force: true })
      await rm(`${journalPath()}-shm`, { force: true })

      const { journal, warnings } = open()
      expect(journal.pending()).toEqual([])
      journal.begin(op('op_2'))
      expect(journal.pending().map(row => row.op)).toEqual(['op_2'])
      expect(journal.isAvailable()).toBe(true)
      expect(warnings).toHaveLength(1)
    })

    it('库是更新的版本建的：不用也不动它', async () => {
      const { journal: first } = open()
      first.begin(op('op_1'))
      first.close()
      const { DatabaseSync } = await import('node:sqlite')
      const db = new DatabaseSync(journalPath())
      db.exec('PRAGMA user_version = 99')
      db.close()
      const before = await readFile(journalPath())

      const { journal, warnings } = open()
      journal.begin(op('op_2'))
      expect(journal.isAvailable()).toBe(false)
      expect(journal.pending()).toEqual([])
      expect(warnings).toHaveLength(1)
      journal.close()
      expect((await readFile(journalPath())).equals(before)).toBe(true)
    })

    it('一行读不懂（更新的版本写的）：跳过它，别的行照常返回', async () => {
      const { journal } = open()
      journal.begin(op('op_1'))
      journal.begin(op('op_2'))
      const { DatabaseSync } = await import('node:sqlite')
      const db = new DatabaseSync(journalPath())
      db.prepare('UPDATE ops SET body = ? WHERE op = ?').run('{broken', 'op_1')
      db.close()
      expect(journal.pending().map(row => row.op)).toEqual(['op_2'])
    })
  })
})
