import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileTable } from '../src/storage/file-table.ts'
import { OpJournal } from '../src/storage/op-journal.ts'
import { createRootLock } from '../src/storage/root-lock.ts'
import { layerOf } from '../src/storage/history.ts'
import type { RecallStats } from '../src/storage/schema.ts'
import type { MemorySnapshot } from '../src/governance/schema.ts'
import { SnapshotStore } from '../src/governance/snapshots.ts'
import { MemoryStore } from '../src/store.ts'
import { commitChange, historySteps } from '../src/commit-change.ts'
import { InMemoryKvTable, InMemoryBatchKvTable } from './helpers/in-memory-kv.ts'
import { record } from './helpers/record.ts'

// 状态变化写到一半进程退出：在进程边界（node:fs/promises 的写调用）注入，第 k 次写调用之前「进程没了」。
// 然后换一个新实例进一次写入段，看补做之后记忆和历史版本对不对得上。改前快照放在不受注入影响的表里：它在写文件之前就落盘了。

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
const T0 = 1_700_000_000_000
const global = { kind: 'global' } as const

let root: string
let journalDir: string
const journals: OpJournal[] = []
const alive = () => { fault.remaining = Number.POSITIVE_INFINITY; fault.isDead = false; fault.calls = 0 }
beforeEach(async () => {
  alive()
  root = await mkdtemp(join(tmpdir(), 'pm-history-recovery-'))
  journalDir = await mkdtemp(join(tmpdir(), 'pm-history-journal-'))
})
afterEach(async () => {
  alive()
  for (const journal of journals.splice(0)) journal.close()
  await rm(root, { recursive: true, force: true })
  await rm(journalDir, { recursive: true, force: true })
})

/** 一个「进程」：自己的锁和日志连接；启动时登记历史版本的步骤（同接线层）。快照表跨进程共用（代表磁盘上的那份）。 */
function open(snapshotTable: InMemoryKvTable<MemorySnapshot>) {
  const journal = new OpJournal({ path: join(journalDir, 'op-journal.sqlite'), log: quiet })
  journals.push(journal)
  const table = new FileTable({ root, stats: new InMemoryKvTable<RecallStats>(), log: quiet, lock: createRootLock({ root, log: quiet }), journal })
  const store = new MemoryStore(table, quiet, new InMemoryBatchKvTable())
  const snapshots = new SnapshotStore(snapshotTable)
  store.registerSteps(historySteps(store, snapshots, quiet))
  return { store, snapshots }
}

async function prepare() {
  const snapshotTable = new InMemoryKvTable<MemorySnapshot>()
  const first = open(snapshotTable)
  await first.store.create(record({ id: 'mem_a', name: '部署方式', content: '第一版', createdAt: T0, updatedAt: T0 }))
  await first.store.create(record({ id: 'mem_other', name: '旁观', content: '旁观的正文' }))
  return { snapshotTable, first }
}

const stateChange = async (w: ReturnType<typeof open>) => commitChange({
  target: (await w.store.get('mem_a', global))!, kind: 'state-change', fields: { content: '第二版' },
  by: 'main', sessionId: 's1', reason: '换了', at: T0 + 60_000,
}, w)

async function settled(snapshotTable: InMemoryKvTable<MemorySnapshot>) {
  alive()
  const next = open(snapshotTable)
  // 新实例进一次写入段（改一条不相干的记忆），触发补做
  await next.store.update({ id: 'mem_other', workspacePath: undefined }, r => ({ ...r, summary: `${r.summary}。` }), global)
  const found = (await next.store.locate('mem_a', global))!
  return { content: found.record.content, versions: (await next.store.history.list(layerOf(found), 'mem_a')).map(v => v.record.content) }
}

describe('状态变化中途进程退出', () => {
  it('在哪一次写调用之前退出，恢复后都不出现和当前页内容相同的历史版本：要么没改、没有版本，要么改了、改前那版留着', async () => {
    // 先完整跑一遍，数出这次状态变化一共有几次写调用
    const clean = await prepare()
    fault.calls = 0
    expect((await stateChange(clean.first)).kind).toBe('written')
    const total = fault.calls
    expect(total).toBeGreaterThan(3)
    expect(await settled(clean.snapshotTable)).toEqual({ content: '第二版', versions: ['第一版'] })

    const outcomes = new Set<string>()
    for (let k = 0; k < total; k++) {
      alive()
      for (const journal of journals.splice(0)) journal.close()
      await rm(root, { recursive: true, force: true })
      await rm(journalDir, { recursive: true, force: true })
      root = await mkdtemp(join(tmpdir(), 'pm-history-recovery-'))
      journalDir = await mkdtemp(join(tmpdir(), 'pm-history-journal-'))
      const { snapshotTable, first } = await prepare()
      fault.remaining = k
      await stateChange(first).catch(() => undefined)
      const after = await settled(snapshotTable)
      expect(after.versions, `第 ${k} 次写调用之前退出`).not.toContain(after.content)
      expect(after, `第 ${k} 次写调用之前退出`).toEqual(after.content === '第一版' ? { content: '第一版', versions: [] } : { content: '第二版', versions: ['第一版'] })
      outcomes.add(after.content)
    }
    // 两头都走到了：记忆文件写下之前退出的，和写下之后、历史版本落盘之前退出的
    expect([...outcomes].sort()).toEqual(['第一版', '第二版'])
  })

  it('变化原因不进操作日志：写完文件就退出，日志文件里没有这句话，补做出来的历史版本仍带着它', async () => {
    const { snapshotTable, first } = await prepare()
    const marker = '换成蓝绿发布之后的说明'
    // 从第 0 次写调用起逐个试，停在记忆文件刚写成、历史版本还没落盘的那一次
    const target = (await first.store.get('mem_a', global))!
    const run = (w: ReturnType<typeof open>) => commitChange({ target, kind: 'state-change', fields: { content: '第二版' }, by: 'main', sessionId: 's1', reason: marker, at: T0 + 60_000 }, w)
    let k = 0
    for (;; k++) {
      alive()
      fault.remaining = k
      const done = await run(first).then(() => true, () => false)
      if (done || (await first.store.get('mem_a', global))!.content === '第二版') break
    }
    const { readdir, readFile } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    for (const name of await readdir(journalDir)) expect((await readFile(join(journalDir, name))).includes(Buffer.from(marker)), name).toBe(false)
    alive()
    const next = open(snapshotTable)
    await next.store.update({ id: 'mem_other', workspacePath: undefined }, r => ({ ...r, summary: `${r.summary}。` }), global)
    const found = (await next.store.locate('mem_a', global))!
    expect((await next.store.history.list(layerOf(found), 'mem_a')).map(v => [v.record.content, v.writes.map(w => w.reason)])).toEqual([['第一版', [marker]]])
  })

  it('补做重复执行不会多留一版', async () => {
    const { snapshotTable, first } = await prepare()
    expect((await stateChange(first)).kind).toBe('written')
    await settled(snapshotTable)
    expect(await settled(snapshotTable)).toEqual({ content: '第二版', versions: ['第一版'] })
  })
})
