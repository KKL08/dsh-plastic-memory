import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileTable } from '../src/storage/file-table.ts'
import { OpJournal } from '../src/storage/op-journal.ts'
import { createRootLock } from '../src/storage/root-lock.ts'
import { GLOBAL_DIR, workspaceDirName } from '../src/storage/paths.ts'
import { byPosition, newWriteOp, type TopicIntent, type WriteOp } from '../src/storage/table.ts'
import type { RecallStats } from '../src/storage/schema.ts'
import { UNSORTED_TITLE } from '../src/topic-index.ts'
import { InMemoryKvTable } from './helpers/in-memory-kv.ts'
import { record } from './helpers/record.ts'
import { indexTree } from './helpers/topic-index.ts'
import { applied, entryOf, placement } from './helpers/topic-placement.ts'

// 写入提交之后、索引行改完之前进程退出：在进程边界（node:fs/promises 的写调用）注入「进程没了」，
// 换一个新实例进一次写入段补做，看索引是不是和写成的那份记忆对得上。

const fault = vi.hoisted(() => ({ remaining: Number.POSITIVE_INFINITY, isDead: false, calls: 0 }))
class Crash extends Error {}

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const writes = new Set(['appendFile', 'copyFile', 'cp', 'link', 'mkdir', 'rename', 'rm', 'rmdir', 'symlink', 'truncate', 'unlink', 'utimes', 'writeFile'])
  return Object.fromEntries(Object.entries(actual).map(([key, value]) => [key, typeof value === 'function' && writes.has(key)
    ? async (...args: unknown[]) => {
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

const quiet = { info() {}, warn() {}, error() {} }
const G = { kind: 'global' } as const
const WS = '/tmp/pm-topic-recovery-ws'

let root: string
let journalDir: string
const journals: OpJournal[] = []
async function fresh() {
  for (const journal of journals.splice(0)) journal.close()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  if (journalDir !== undefined) await rm(journalDir, { recursive: true, force: true })
  root = await mkdtemp(join(tmpdir(), 'pm-topic-recovery-'))
  journalDir = await mkdtemp(join(tmpdir(), 'pm-topic-recovery-journal-'))
}
beforeEach(async () => {
  fault.remaining = Number.POSITIVE_INFINITY
  fault.isDead = false
  await fresh()
})
afterEach(async () => {
  fault.remaining = Number.POSITIVE_INFINITY
  fault.isDead = false
  for (const journal of journals.splice(0)) journal.close()
  await rm(root, { recursive: true, force: true })
  await rm(journalDir, { recursive: true, force: true })
})

function open() {
  const journal = new OpJournal({ path: join(journalDir, 'op-journal.sqlite'), log: quiet })
  journals.push(journal)
  return { table: new FileTable({ root, stats: new InMemoryKvTable<RecallStats>(), log: quiet, lock: createRootLock({ root, log: quiet }), journal }), journal }
}
const gdir = () => join(root, GLOBAL_DIR)
const wdir = () => join(root, workspaceDirName(WS))

/** 全局：mem_a 在「上线」，mem_b 在「未整理」。项目：mem_w 在「上线」。 */
async function seed() {
  const { table } = open()
  await table.create(record({ id: 'mem_a', name: '发版步骤', summary: '发版步骤的摘要', content: '发版步骤的正文' }))
  await table.create(record({ id: 'mem_b', name: '回复语言', summary: '回复语言的摘要', content: '回复语言的正文' }))
  await table.create(record({ id: 'mem_w', scope: 'workspace', workspacePath: WS }))
  await table.maintain([gdir(), wdir()])
  await applied(table, gdir(), { kind: 'assign', memoryIds: ['mem_a'], from: UNSORTED_TITLE, to: '上线', about: '上线的说明。' })
  await applied(table, wdir(), { kind: 'assign', memoryIds: ['mem_w'], from: UNSORTED_TITLE, to: '上线' })
}
const where = async () => ({ global: await placement(gdir()), workspace: await placement(wdir()) })
const BEFORE = { global: { mem_a: ['上线'], mem_b: [UNSORTED_TITLE] }, workspace: { mem_w: ['上线'] } }

interface Scenario {
  name: string
  run: (table: FileTable) => Promise<unknown>
  /** 这次写入提交了没有（按磁盘上的记忆文件判）。 */
  isCommitted: (table: FileTable) => Promise<boolean>
  after: Awaited<ReturnType<typeof where>>
}

async function finish(table: FileTable, op: WriteOp, written: Promise<unknown>) {
  await written
  await table.finishOp(op)
}
const create = (topic: TopicIntent) => async (table: FileTable) => {
  const op = newWriteOp({ topic })
  await finish(table, op, table.create(record({ id: 'mem_n', name: '新记忆', summary: '新记忆的摘要', content: '新记忆的正文' }), op))
}

// 原子写在改名前退出，会在索引目录留下 <文件名>.tmp-<pid>-<随机>：读索引只认 .md，没有读者会读到它；
// 维护按 pid 和存在时长清掉（换了进程的残留要过 60 秒才清），补做不管它。这里只比正式文件，每个正式文件仍逐字比。
const ATOMIC_TMP_RE = /\.tmp-\d+-[a-z0-9]+$/
const settled = (tree: Record<string, string> | undefined) =>
  tree === undefined ? undefined : Object.fromEntries(Object.entries(tree).filter(([rel]) => !ATOMIC_TMP_RE.test(rel)))

const scenarios: Scenario[] = [
  {
    name: '新建，归进现有主题',
    run: create({ kind: 'choose', name: '上线', maxTopics: 30 }),
    isCommitted: async t => (await t.locate('mem_n', G)) !== undefined,
    after: { ...BEFORE, global: { ...BEFORE.global, mem_n: ['上线'] } },
  },
  {
    name: '新建，同时建主题',
    run: create({ kind: 'choose', name: '写锁', about: '写锁的说明。', maxTopics: 30 }),
    isCommitted: async t => (await t.locate('mem_n', G)) !== undefined,
    after: { ...BEFORE, global: { ...BEFORE.global, mem_n: ['写锁'] } },
  },
  {
    name: '软删',
    run: async table => { await table.update('mem_a', G, r => ({ ...r, status: 'deleted' })) },
    isCommitted: async t => { const found = await t.locate('mem_a', G); return found === undefined || byPosition(found).status === 'deleted' },
    after: { ...BEFORE, global: { mem_b: [UNSORTED_TITLE] } },
  },
  {
    name: '彻底删除',
    run: async table => { await table.delete('mem_a', G) },
    isCommitted: async t => (await t.locate('mem_a', G)) === undefined,
    after: { ...BEFORE, global: { mem_b: [UNSORTED_TITLE] } },
  },
  {
    name: '带着主题换到项目',
    run: async table => {
      const op = newWriteOp({ topic: { kind: 'carry' } })
      await finish(table, op, table.update('mem_a', G, r => ({ ...r, scope: 'workspace', workspacePath: WS }), op))
    },
    isCommitted: async t => (await t.locate('mem_a', { kind: 'workspace', workspacePath: WS }))?.record.scope === 'workspace',
    after: { global: { mem_b: [UNSORTED_TITLE] }, workspace: { mem_a: ['上线'], mem_w: ['上线'] } },
  },
]

describe('写入提交后、索引行改完前进程退出', () => {
  for (const s of scenarios) {
    it(`${s.name}：每一个写调用之前退出，补做后索引和写成的那份对得上，再维护一遍不变`, async () => {
      await seed()
      const dry = open()
      fault.calls = 0
      await s.run(dry.table)
      const total = fault.calls
      expect(total).toBeGreaterThan(1)
      expect(await where()).toEqual(s.after)
      const doneEntry = await entryOf(gdir())

      for (let k = 0; k < total; k++) {
        await fresh()
        await seed()
        const crashed = open()
        fault.remaining = k
        await s.run(crashed.table).catch(() => {})
        fault.remaining = Number.POSITIVE_INFINITY
        fault.isDead = false
        // 留在日志里的行不带记忆的名称、摘要、正文
        expect(JSON.stringify(crashed.journal.pending()), `第 ${k} 次写之前退出`).not.toMatch(/的摘要|的正文|发版步骤|回复语言|新记忆/)
        const next = open()
        await next.table.update('mem_b', G, r => ({ ...r, content: `${r.content}。` }))
        const label = `第 ${k} 次写之前退出`
        if (await s.isCommitted(next.table)) {
          expect(await where(), label).toEqual(s.after)
          expect(await entryOf(gdir()), label).toEqual(doneEntry)
        } else {
          expect(await where(), label).toEqual(BEFORE)
        }
        expect(next.journal.hasPending(), label).toBe(false)
        const trees = [settled(await indexTree(gdir())), settled(await indexTree(wdir()))]
        await next.table.maintain([gdir(), wdir()])
        expect([settled(await indexTree(gdir())), settled(await indexTree(wdir()))], label).toEqual(trees)
      }
    })
  }
})
