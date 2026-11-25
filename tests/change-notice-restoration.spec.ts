import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { FileTable } from '../src/storage/file-table.ts'
import { OpJournal } from '../src/storage/op-journal.ts'
import { createRootLock } from '../src/storage/root-lock.ts'
import { MemoryStore } from '../src/store.ts'
import { SnapshotCache } from '../src/runtime.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'
import type { RecallStats } from '../src/storage/schema.ts'
import { InMemoryBatchKvTable } from './helpers/in-memory-kv.ts'
import { record } from './helpers/record.ts'

const boundary = vi.hoisted(() => ({
  onStat: undefined as undefined | ((path: unknown) => Promise<void> | undefined),
  failClock: false,
  clockFailures: 0,
}))
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, stat: async (...args: Parameters<typeof actual.stat>) => {
    await boundary.onStat?.(args[0])
    return actual.stat(...args)
  } }
})

const quiet = { info() {}, warn() {}, error() {} }
const own = { kind: 'workspace', workspacePath: '/projects/notice-restore' } as const
const dirs: string[] = []
const journals: OpJournal[] = []
afterEach(async () => {
  boundary.onStat = undefined
  boundary.failClock = false
  boundary.clockFailures = 0
  for (const journal of journals.splice(0)) journal.close()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function rig() {
  const root = await mkdtemp(join(tmpdir(), 'pm-notice-restore-'))
  dirs.push(root)
  const journal = new OpJournal({ path: join(root, '.state', 'journal.sqlite'), log: quiet })
  journals.push(journal)
  const stats = new InMemoryBatchKvTable<RecallStats>()
  const store = new MemoryStore(new FileTable({ root, stats, log: quiet, journal, now: () => {
    if (boundary.failClock) { boundary.clockFailures++; throw new Error('时钟读取失败') }
    return 1
  }, lock: createRootLock({ root, log: quiet }) }), quiet, stats)
  const cache = new SnapshotCache({ store, registry: buildTypeRegistry({ template: 'coding', customTypes: {} }), budget: 1_000_000, log: quiet, recentChanges: journal })
  const session = {}
  cache.setWorkspacePath(session, own.workspacePath)
  const memory = record({ id: 'mem_restore', name: '原名称', summary: '原摘要', type: 'preference', scope: 'workspace', workspacePath: own.workspacePath })
  await store.create(memory)
  expect(await cache.assemble(session)).toContain(memory.id)
  return { root, journal, store, cache, session, memory }
}

it('注入后软删再恢复，通知用恢复后的名称和摘要', async () => {
  const r = await rig()
  await r.store.update(r.memory, cur => ({ ...cur, status: 'deleted' }), own)
  await r.store.put({ ...r.memory, name: '恢复名称', summary: '恢复摘要' }, own)
  expect((await r.cache.changeNotice(r.session, 'self'))?.text).toContain('- [mem_restore] 恢复名称（恢复摘要）')
  expect(await r.cache.changeNotice(r.session, 'self')).toBeUndefined()
})

it('注入后提升全局再移回项目，通知用项目里的当下内容', async () => {
  const r = await rig()
  const global = await r.store.update(r.memory, cur => ({ ...cur, scope: 'global', workspacePath: undefined }), own)
  await r.store.update(global, cur => ({ ...cur, scope: 'workspace', workspacePath: own.workspacePath, name: '移回名称', summary: '移回摘要' }), { kind: 'global' })
  expect((await r.cache.changeNotice(r.session, 'self'))?.text).toContain('- [mem_restore] 移回名称（移回摘要）')
  expect(await r.cache.changeNotice(r.session, 'self')).toBeUndefined()
})

it('先发删除通知再恢复，下个发送点更正一次，未恢复时不重复通知', async () => {
  const r = await rig()
  await r.store.update(r.memory, cur => ({ ...cur, status: 'deleted' }), own)
  expect((await r.cache.changeNotice(r.session, 'self'))?.text).toContain('- [mem_restore] 已删除')
  expect(await r.cache.changeNotice(r.session, 'self')).toBeUndefined()
  await r.store.put({ ...r.memory, name: '恢复名称', summary: '恢复摘要' }, own)
  expect((await r.cache.changeNotice(r.session, 'self'))?.text).toContain('- [mem_restore] 恢复名称（恢复摘要）')
  expect(await r.cache.changeNotice(r.session, 'self')).toBeUndefined()
})

it('锁外打开失败按原因去重，成功读一次后同一原因重新记日志', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pm-notice-open-'))
  dirs.push(dir)
  let reason: string | undefined = 'database is locked'
  class OpeningDatabase extends DatabaseSync {
    override exec(sql: string): void {
      if (reason !== undefined) throw new Error(reason)
      super.exec(sql)
    }
  }
  const warnings: string[] = []
  const journal = new OpJournal({ path: join(dir, 'journal.sqlite'), log: { ...quiet, warn: message => { warnings.push(String(message)) } }, loadSqlite: () => ({ DatabaseSync: OpeningDatabase }) })
  journals.push(journal)
  expect(journal.latestChangeSeq()).toBeUndefined()
  expect(journal.changesSince(['global'], 0)).toBeUndefined()
  expect(warnings).toHaveLength(1)
  reason = 'disk I/O error'
  expect(journal.latestChangeSeq()).toBeUndefined()
  expect(journal.latestChangeSeq()).toBeUndefined()
  expect(warnings).toHaveLength(2)
  reason = undefined
  expect(journal.latestChangeSeq()).toBe(0)
  journal.close()
  reason = 'disk I/O error'
  expect(journal.changesSince(['global'], 0)).toBeUndefined()
  expect(journal.latestChangeSeq()).toBeUndefined()
  expect(warnings).toHaveLength(3)
})

/** 在文件系统边界挂住一次读取；不替换存储或快照模块。 */
function holdRead(path: string) {
  let release!: () => void
  let entered!: () => void
  const waiting = new Promise<void>(resolve => { entered = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  boundary.onStat = target => {
    if (String(target) !== path) return undefined
    boundary.onStat = undefined
    entered()
    return gate
  }
  return { waiting, release }
}

async function edit(r: Awaited<ReturnType<typeof rig>>, summary: string) {
  await r.store.update(r.memory, cur => ({ ...cur, summary }), own)
}

async function replaceJournal(r: Awaited<ReturnType<typeof rig>>) {
  r.journal.close()
  for (const suffix of ['', '-wal', '-shm']) await rm(join(r.root, '.state', 'journal.sqlite') + suffix, { force: true })
}

it('换库后两个通知交错，较早读取晚返回不会倒退起点或重复通知', async () => {
  const r = await rig()
  for (let i = 0; i < 4; i++) await edit(r, `旧库${i}`)
  r.cache.markStale(r.session)
  await r.cache.assemble(r.session)
  expect(r.journal.latestChangeSeq()).toBe(4)
  await replaceJournal(r)
  await edit(r, '新库第一条')
  const hold = holdRead((await r.store.locate(r.memory.id, own))!.filePath)
  const first = r.cache.changeNotice(r.session, 'self')
  await hold.waiting
  try {
    await edit(r, '新库第二条')
    expect((await r.cache.changeNotice(r.session, 'self'))?.text).toContain('新库第二条')
  } finally { hold.release() }
  await first
  expect(await r.cache.changeNotice(r.session, 'self')).toBeUndefined()
})

it('旧库通知挂起期间换库，新库起点不会被旧调用的大序号覆盖', async () => {
  const r = await rig()
  for (let i = 0; i < 4; i++) await edit(r, `旧库${i}`)
  r.cache.markStale(r.session)
  await r.cache.assemble(r.session)
  await edit(r, '旧库第五条')
  expect(r.journal.latestChangeSeq()).toBe(5)
  const hold = holdRead((await r.store.locate(r.memory.id, own))!.filePath)
  const first = r.cache.changeNotice(r.session, 'self')
  await hold.waiting
  try {
    await replaceJournal(r)
    await edit(r, '新库第一条')
    expect(r.journal.latestChangeSeq()).toBe(1)
    expect((await r.cache.changeNotice(r.session, 'self'))?.text).toContain('新库第一条')
  } finally { hold.release() }
  await first
  expect(await r.cache.changeNotice(r.session, 'self')).toBeUndefined()
  await edit(r, '新库第二条')
  expect((await r.cache.changeNotice(r.session, 'self'))?.text).toContain('新库第二条')
})

it('读事务提交失败且事务已结束，日志保留提交的原错误', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pm-notice-commit-'))
  dirs.push(dir)
  let rollbacks = 0
  class CommitFailureDatabase extends DatabaseSync {
    override exec(sql: string): void {
      if (sql === 'ROLLBACK') rollbacks++
      super.exec(sql)
      if (sql === 'COMMIT') throw new Error('提交原错误')
    }
  }
  const warnings: string[] = []
  const journal = new OpJournal({ path: join(dir, 'journal.sqlite'), log: { ...quiet, warn: message => { warnings.push(String(message)) } }, loadSqlite: () => ({ DatabaseSync: CommitFailureDatabase }) })
  journals.push(journal)
  expect(journal.latestChangeSeq()).toBeUndefined()
  expect(rollbacks).toBe(1)
  expect(warnings).toEqual(['[plastic-memory] 操作日志库读取失败：提交原错误'])
})

it('离开条目首次读抛错会说明读不到，下一发送点复查抛错不重复说明', async () => {
  const r = await rig()
  await r.store.update(r.memory, cur => ({ ...cur, status: 'deleted' }), own)
  boundary.failClock = true
  expect((await r.cache.changeNotice(r.session, 'self'))?.text).toContain('有改动，这次读不到现在的内容')
  expect(boundary.clockFailures).toBe(1)
  expect(await r.cache.changeNotice(r.session, 'self')).toBeUndefined()
  expect(boundary.clockFailures).toBe(2)
  boundary.failClock = false
  await r.store.put({ ...r.memory, summary: '恢复后的内容' }, own)
  expect((await r.cache.changeNotice(r.session, 'self'))?.text).toContain('恢复后的内容')
  expect(await r.cache.changeNotice(r.session, 'self')).toBeUndefined()
})
