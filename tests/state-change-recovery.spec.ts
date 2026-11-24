import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileTable } from '../src/storage/file-table.ts'
import { OpJournal } from '../src/storage/op-journal.ts'
import { createRootLock } from '../src/storage/root-lock.ts'
import { layerOf, STATE_CHANGE_VERSION } from '../src/storage/history.ts'
import { GLOBAL_DIR, HISTORY_DIR, INDEX_FILE, workspaceDirName } from '../src/storage/paths.ts'
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
const exists = (path: string) => stat(path).then(() => true, () => false)

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
  // 进程没了，日志里的行也销不了账：注入的失败有的被写路径吞掉、接着往下走，不能让它把行结掉
  const done = journal.done.bind(journal)
  journal.done = (opId: string) => { if (!fault.isDead) done(opId) }
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

describe('历史版本跟着记忆走，中途进程退出', () => {
  const WS = '/tmp/pm-history-recovery-ws'
  const inWs = { kind: 'workspace', workspacePath: WS } as const
  const layers = () => [join(root, GLOBAL_DIR), join(root, workspaceDirName(WS))]
  const moveToWs = (w: ReturnType<typeof open>) =>
    w.store.update({ id: 'mem_a', workspacePath: undefined }, r => ({ ...r, scope: 'workspace', workspacePath: WS }), global)

  /** 先完整做一次状态变化（全局那层留下「第一版」），返回下一步要中断的那个「进程」。 */
  async function withVersion() {
    const prepared = await prepare()
    expect((await stateChange(prepared.first)).kind).toBe('written')
    return prepared
  }
  /** 各层（全局、项目）里：这一层有没有这条记忆、这一层的历史版本。 */
  async function whereabouts(w: ReturnType<typeof open>) {
    const [globalLayer, wsLayer] = layers()
    return Promise.all([[globalLayer!, global], [wsLayer!, inWs]] as const).then(pairs => Promise.all(pairs.map(async ([dir, scope]) => [
      (await w.store.locate('mem_a', scope)) !== undefined,
      (await w.store.history.list({ dir, loc: { scope: 'global' } }, 'mem_a')).map(v => v.record.content),
    ] as const)))
  }
  async function fresh() {
    alive()
    for (const journal of journals.splice(0)) journal.close()
    await rm(root, { recursive: true, force: true })
    await rm(journalDir, { recursive: true, force: true })
    root = await mkdtemp(join(tmpdir(), 'pm-history-recovery-'))
    journalDir = await mkdtemp(join(tmpdir(), 'pm-history-journal-'))
  }
  /** 完整跑一遍，数出这一步一共有几次写调用。 */
  async function countWrites(run: (w: ReturnType<typeof open>) => Promise<unknown>) {
    const { first } = await withVersion()
    fault.calls = 0
    await run(first)
    const total = fault.calls
    await fresh()
    return total
  }
  /** 各层（全局、项目）的 MEMORY.md 里有没有这条记忆的行。 */
  const indexed = () => Promise.all(layers().map(async dir => (await readFile(join(dir, INDEX_FILE), 'utf8').catch(() => '')).includes('[mem_a]')))
  /** 在记忆现在所在的那一层接着改它一次。 */
  const editAgain = (w: ReturnType<typeof open>, isInProject: boolean) =>
    w.store.update({ id: 'mem_a', workspacePath: isInProject ? WS : undefined }, r => ({ ...r, summary: '接着改' }), isInProject ? inWs : global)
  /** 新实例进一次写入段（改一条不相干的记忆），触发按操作日志补做。 */
  const touchOther = (w: ReturnType<typeof open>) =>
    w.store.update({ id: 'mem_other', workspacePath: undefined }, r => ({ ...r, summary: `${r.summary}。` }), global)

  it('移到项目时在哪一次写调用之前退出，按操作日志补做之后，历史版本都在记忆所在的那一层，另一层没有', async () => {
    const total = await countWrites(moveToWs)
    expect(total).toBeGreaterThan(2)
    const outcomes = new Set<string>()
    for (let k = 0; k < total; k++) {
      const { snapshotTable, first } = await withVersion()
      fault.remaining = k
      await moveToWs(first).catch(() => undefined)
      alive()
      const next = open(snapshotTable)
      await touchOther(next)
      const [inGlobal, inProject] = await whereabouts(next)
      const expected = inProject[0] ? [[false, []], [true, ['第一版']]] : [[true, ['第一版']], [false, []]]
      expect([inGlobal, inProject], `第 ${k} 次写调用之前退出`).toEqual(expected)
      // 索引只在记忆所在的那一层列它；之后还能接着改
      expect(await indexed(), `第 ${k} 次写调用之前退出`).toEqual([inGlobal[0], inProject[0]])
      expect((await editAgain(next, inProject[0])).summary, `第 ${k} 次写调用之前退出`).toBe('接着改')
      outcomes.add(inProject[0] ? '已搬' : '没搬')
      await fresh()
    }
    expect([...outcomes].sort()).toEqual(['已搬', '没搬'])
  })

  it('移到项目中途退出、操作日志库又被删掉：整份核对把历史目录迁到记忆所在的那一层，不清掉', async () => {
    const total = await countWrites(moveToWs)
    for (let k = 0; k < total; k++) {
      const { snapshotTable, first } = await withVersion()
      fault.remaining = k
      await moveToWs(first).catch(() => undefined)
      alive()
      for (const journal of journals.splice(0)) journal.close()
      await rm(journalDir, { recursive: true, force: true })
      journalDir = await mkdtemp(join(tmpdir(), 'pm-history-journal-'))
      const next = open(snapshotTable)
      await next.store.maintain(global)
      await next.store.maintain(inWs)
      const places = await whereabouts(next)
      // 历史版本只有一份「第一版」，而且有历史目录的那一层就有这条记忆
      expect(places.flatMap(([, versions]) => versions), `第 ${k} 次写调用之前退出`).toEqual(['第一版'])
      for (const [hasMemory, versions] of places) if (versions.length > 0) expect(hasMemory, `第 ${k} 次写调用之前退出`).toBe(true)
      expect(await indexed(), `第 ${k} 次写调用之前退出`).toEqual(places.map(([hasMemory]) => hasMemory))
      await fresh()
    }
  })

  it('移到项目时项目那层的历史目录被挡住：写入照样成功，两层索引当场就对；挡住的东西拿掉后补做把历史搬过去，还能接着改', async () => {
    const { snapshotTable, first } = await withVersion()
    const wsLayer = layers()[1]!
    await first.store.create(record({ id: 'mem_ws', name: '项目里的', scope: 'workspace', workspacePath: WS }))
    await writeFile(join(wsLayer, HISTORY_DIR), '挡路')
    expect((await moveToWs(first)).scope).toBe('workspace')
    expect(await indexed()).toEqual([false, true])
    await rm(join(wsLayer, HISTORY_DIR))
    alive()
    const next = open(snapshotTable)
    await touchOther(next)
    expect(await whereabouts(next)).toEqual([[false, []], [true, ['第一版']]])
    expect(await indexed()).toEqual([false, true])
    expect((await editAgain(next, true)).summary).toBe('接着改')
  })

  it('补做之前源头那层又有了同 id 的另一条：不把那一层的历史搬走', async () => {
    const { snapshotTable, first } = await withVersion()
    const [globalLayer, wsLayer] = layers() as [string, string]
    await first.store.create(record({ id: 'mem_ws', name: '项目里的', scope: 'workspace', workspacePath: WS }))
    await writeFile(join(wsLayer, HISTORY_DIR), '挡路')
    await moveToWs(first)
    // 不记操作日志的写者（例如旧版本）在全局另建了同 id 的一条，它也有了自己的历史
    const bystander = new FileTable({ root, stats: new InMemoryKvTable<RecallStats>(), log: quiet })
    await bystander.create(record({ id: 'mem_a', name: '全局的另一条', content: '全局另一条的正文' }))
    await bystander.history.write({ dir: globalLayer, loc: { scope: 'global' } }, {
      versionId: '20261125T000000000Z', record: record({ id: 'mem_a', content: '全局另一条的旧版' }), extras: {}, startedAt: 1, endedAt: 2, kind: STATE_CHANGE_VERSION, writes: [],
    })
    await rm(join(wsLayer, HISTORY_DIR))
    alive()
    const next = open(snapshotTable)
    await touchOther(next)
    expect((await next.store.history.list({ dir: globalLayer, loc: { scope: 'global' } }, 'mem_a')).map(v => v.record.content)).toContain('全局另一条的旧版')
    expect(await next.store.history.list({ dir: wsLayer, loc: { scope: 'global' } }, 'mem_a')).toEqual([])
  })

  it('彻底删除时在哪一次写调用之前退出，恢复后只要记忆已经不在，历史目录也不在', async () => {
    const purge = (w: ReturnType<typeof open>) => w.store.hardDelete({ id: 'mem_a', workspacePath: undefined }, { at: global })
    const total = await countWrites(purge)
    const outcomes = new Set<string>()
    for (let k = 0; k < total; k++) {
      const { snapshotTable, first } = await withVersion()
      fault.remaining = k
      await purge(first).catch(() => undefined)
      alive()
      const next = open(snapshotTable)
      await touchOther(next)
      const [[hasMemory, versions]] = await whereabouts(next)
      if (!hasMemory) expect(await exists(join(root, GLOBAL_DIR, HISTORY_DIR, 'mem_a')), `第 ${k} 次写调用之前退出`).toBe(false)
      else expect([[], ['第一版']], `第 ${k} 次写调用之前退出`).toContainEqual(versions)
      outcomes.add(hasMemory ? '还在' : '删了')
      await fresh()
    }
    expect([...outcomes].sort()).toEqual(['删了', '还在'])
  })
})
