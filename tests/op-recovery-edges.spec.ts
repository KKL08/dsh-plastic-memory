import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { FileTable } from '../src/storage/file-table.ts'
import { OpJournal } from '../src/storage/op-journal.ts'
import { createRootLock } from '../src/storage/root-lock.ts'
import { newWriteOp } from '../src/storage/table.ts'
import type { RecallStats } from '../src/storage/schema.ts'
import { InMemoryKvTable } from './helpers/in-memory-kv.ts'
import { record } from './helpers/record.ts'

// 补做遇到的边角：中断之后、补做之前，文件被人动过或一时读不出，以及日志里有读不懂的行。
// 在进程边界注入：指定路径的删除失败、指定路径读不出。

const fault = vi.hoisted(() => ({ failRemove: '', unreadable: '' }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...fs,
    rm: async (...args: Parameters<typeof fs.rm>) => {
      if (String(args[0]) === fault.failRemove) throw new Error('删不掉')
      return fs.rm(...args)
    },
    readFile: async (...args: Parameters<typeof fs.readFile>) => {
      if (String(args[0]) === fault.unreadable) throw Object.assign(new Error('读不出'), { code: 'EACCES' })
      return fs.readFile(...args)
    },
  }
})

const quiet = { info() {}, warn() {}, error() {} }
const global = { kind: 'global' } as const
const STEP = 'test-step'
let base: string
let root: string
const journals: OpJournal[] = []

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'pm-recovery-edges-'))
  root = join(base, 'memories')
})
afterEach(async () => {
  Object.assign(fault, { failRemove: '', unreadable: '' })
  for (const journal of journals.splice(0)) journal.close()
  await rm(base, { recursive: true, force: true })
})

/** 一个「进程」：自己的锁、自己的日志连接、自己的步骤记录。 */
function open() {
  const journal = new OpJournal({ path: join(base, 'op-journal.sqlite'), log: quiet })
  journals.push(journal)
  const table = new FileTable({ root, journal, log: quiet, stats: new InMemoryKvTable<RecallStats>(), lock: createRootLock({ root, log: quiet }) })
  const ran: Array<{ content: string | undefined; isIntact: boolean }> = []
  table.registerStep(STEP, async (_step, ctx) => { ran.push({ content: ctx.record?.content, isIntact: ctx.isIntact }) })
  /** 进一次写入段，触发补做。 */
  const enter = () => table.maintain([])
  return { table, journal, ran, enter }
}

async function seed() {
  const p = open()
  await p.table.create(record({ id: 'mem_a', name: '甲', content: '第一版' }))
  return { ...p, path: (await p.table.locate('mem_a', global))!.filePath }
}

/** 带一个步骤把正文改成第二版，不结这次操作：留下一行待完成。 */
async function seedCommitted() {
  const p = await seed()
  const op = newWriteOp({ steps: [{ kind: STEP }] })
  await p.table.update('mem_a', global, r => ({ ...r, content: '第二版' }), op)
  return { ...p, op }
}

it('彻底删除没删成、文件随后被人改了名又改了内容：补做不删它', async () => {
  const p = await seed()
  fault.failRemove = p.path
  await expect(p.table.delete('mem_a', global)).rejects.toThrow('删不掉')
  fault.failRemove = ''
  const renamed = join(dirname(p.path), '手改的名字.md')
  await rename(p.path, renamed)
  await writeFile(renamed, (await readFile(renamed, 'utf8')).replace('第一版', '用户改过的正文'))

  const next = open()
  await next.enter()
  expect((await next.table.locate('mem_a', global))?.record.content).toBe('用户改过的正文')
  expect(next.journal.pending()).toEqual([])
})

it('写成之后、补做之前文件被人改了：步骤拿到改后的内容，同时知道它不是这次写下的原样', async () => {
  const p = await seedCommitted()
  await writeFile(p.path, (await readFile(p.path, 'utf8')).replace('第二版', '用户改过的正文'))
  const next = open()
  await next.enter()
  expect(next.ran).toEqual([{ content: '用户改过的正文', isIntact: false }])
})

it('写成了的文件一时读不出：这一行留着，读得出之后再补做', async () => {
  const p = await seedCommitted()
  fault.unreadable = p.path
  const next = open()
  await next.enter()
  expect(next.ran).toEqual([])
  expect(next.journal.pending().map(row => row.op)).toEqual([p.op.id])
  fault.unreadable = ''
  await next.enter()
  expect(next.ran).toEqual([{ content: '第二版', isIntact: true }])
  expect(next.journal.pending()).toEqual([])
})

it('日志里有一行形状读不懂：留着它，后面的行照常补做', async () => {
  await seedCommitted()
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(join(base, 'op-journal.sqlite'))
  db.prepare('INSERT INTO ops(seq, op, at, body) VALUES (-1, ?, ?, ?)').run('op_unknown', 0, JSON.stringify({ steps: [], target: null }))
  db.close()
  const next = open()
  await next.enter()
  await next.enter()
  expect(next.ran).toEqual([{ content: '第二版', isIntact: true }])
  expect(next.journal.pending().map(row => row.op)).toEqual(['op_unknown'])
})

it('目录里另一个不相干的文件读不出：写成了的那份照样找得到、步骤补做', async () => {
  const p = await seedCommitted()
  const blocker = join(dirname(p.path), '0-读不出.md')
  await writeFile(blocker, '---\nid: mem_blocker\n---\n')
  fault.unreadable = blocker
  const next = open()
  await next.enter()
  expect(next.ran).toEqual([{ content: '第二版', isIntact: true }])
  expect(next.journal.pending()).toEqual([])
})

it('彻底删除删掉了选中的那份、同 id 还剩一份：算删成了，步骤补做，剩下那份不动', async () => {
  const p = await seed()
  const twin = join(dirname(p.path), '另一份.md')
  await writeFile(twin, await readFile(p.path, 'utf8'))
  fault.failRemove = twin
  const op = newWriteOp({ steps: [{ kind: STEP }] })
  await p.table.delete('mem_a', global, undefined, op).catch(() => {})
  fault.failRemove = ''
  const survivors = [p.path, twin].filter(path => path !== twin)
  const next = open()
  await next.enter()
  // 选中的那份没了才算提交；没删成（两份都在）时这一行作废
  const isGone = await readFile(survivors[0]!, 'utf8').then(() => false, () => true)
  expect(next.ran).toHaveLength(isGone ? 1 : 0)
  expect(await readFile(twin, 'utf8')).toContain('第一版')
  expect(next.journal.pending()).toEqual([])
})

it('日志里有一行目标种类认识、字段不全：留着它，不当成没提交作废', async () => {
  const p = await seedCommitted()
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(join(base, 'op-journal.sqlite'))
  db.prepare('INSERT INTO ops(seq, op, at, body) VALUES (-1, ?, ?, ?)').run('op_partial', 0, JSON.stringify({ steps: [], target: { kind: 'write', dir: dirname(p.path) } }))
  db.close()
  const next = open()
  await next.enter()
  expect(next.journal.pending().map(row => row.op)).toEqual(['op_partial'])
})

it('调用方结操作时有一步没人会做：这一行留在日志里，认识的步骤也不先做', async () => {
  const p = await seed()
  const op = newWriteOp({ steps: [{ kind: STEP }, { kind: 'step-nobody-registered' }] })
  const written = await p.table.update('mem_a', global, r => ({ ...r, content: '第二版' }), op)
  await p.table.finishOp(op, written)
  expect(p.ran).toEqual([])
  expect(p.journal.pending().map(row => row.op)).toEqual([op.id])
})
