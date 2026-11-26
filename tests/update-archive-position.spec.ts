import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, renameSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { MemoryStore, type MemoryTable } from '../src/store.ts'
import { FileTable } from '../src/storage/file-table.ts'
import { encodeRecord } from '../src/storage/frontmatter.ts'
import { ARCHIVE_DIR, GLOBAL_DIR, WORKSPACE_MARKER, workspaceDirName } from '../src/storage/paths.ts'
import { OpJournal } from '../src/storage/op-journal.ts'
import { createRootLock } from '../src/storage/root-lock.ts'
import { readIndexFiles } from '../src/storage/index-store.ts'
import { newWriteOp, type TopicIntent } from '../src/storage/table.ts'
import { UNSORTED_TITLE } from '../src/topic-index.ts'
import { prereadScopes } from '../src/tools/scope-preread.ts'
import { SidecarStore } from '../src/storage/sidecar.ts'
import type { RecallStats } from '../src/storage/schema.ts'
import { executeConfirm, type ConfirmToolDeps, type GroupAcceptResult } from '../src/tools/confirm.ts'
import { PendingDecisionsStore } from '../src/governance/decisions.ts'
import { SnapshotStore } from '../src/governance/snapshots.ts'
import type { MemorySnapshot, PendingDecision } from '../src/governance/schema.ts'
import { isPendingDelegated, type MemoryRecord } from '../src/record-schema.ts'
import type { BatchKvTable } from '../src/kv-table.ts'
import { record } from './helpers/record.ts'
import { InMemoryTable } from './helpers/in-memory-table.ts'
import { InMemoryKvTable, InMemoryBatchKvTable } from './helpers/in-memory-kv.ts'
import { noInstructions } from './helpers/instructions.ts'
import { sidecarSchemas } from './helpers/sidecar-schemas.ts'
import { env, ok, root as guiRoot } from './helpers/gui-command-env.ts'
import { applied, membersOf } from './helpers/topic-placement.ts'

// 位置即作用域：.archive/ 里 frontmatter 仍写 status: active 的文件（手工挪进去的）按已删看。
// 写入段里的读改写（MemoryStore.update 及经它的软删、恢复）交给回调的那一份，要和 get 读到的一致。

const T0 = 1_700_000_000_000
const WS = '/proj'
const DELEGATION = { sessionId: 'sess-child', depth: 1, parentSessionId: 'sess-main', rootSessionId: 'sess-main' }
/** 夹具文件的修改时间拨到这一刻：之后被重写过（哪怕同字节）mtime 就不是它。 */
const PAST = new Date(T0 - 86_400_000)
const quietLog = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }

/** 子 agent 存的、还没被接受的项目记忆；文件被手工挪进了 .archive/，frontmatter 没改。 */
const pending = (partial: Partial<MemoryRecord> = {}) => record({
  id: 'mem_p', name: 'stray', type: 'knowledge', scope: 'workspace', workspacePath: WS, content: '子观察', summary: '子观察摘要',
  source: { sessionId: 'sess-child', eventRange: [4, 9], sourceMode: 'environment-observed' },
  createdAt: T0 - 300, updatedAt: T0 - 200, lastConfirmedAt: T0 - 100, confidence: 0.7,
  delegation: DELEGATION,
  ...partial,
})

/** 文件此刻的样子：字节、inode、修改时间。同字节覆盖（tmp + rename）也会换 inode。 */
async function fileState(path: string) {
  const s = await stat(path)
  return { bytes: await readFile(path, 'utf8'), ino: s.ino, mtimeMs: s.mtimeMs }
}

/** 往 FileTable 的项目目录 .archive/ 里放一个文件（手工挪进去的），修改时间拨到 PAST；返回路径。 */
async function seedArchivedFile(wsDir: string, r: MemoryRecord, fileName = 'stray.md'): Promise<string> {
  await mkdir(join(wsDir, ARCHIVE_DIR), { recursive: true })
  await writeFile(join(wsDir, WORKSPACE_MARKER), `${WS}\n`)
  const filePath = join(wsDir, ARCHIVE_DIR, fileName)
  await writeFile(filePath, encodeRecord(r, {}))
  await utimes(filePath, PAST, PAST)
  return filePath
}

interface Handle {
  table: MemoryTable
  stats: BatchKvTable<RecallStats>
  wsDir: string
  /** 直接往 .archive/ 放一个文件（对应用户手工挪进去），frontmatter 原样。 */
  seedArchived(r: MemoryRecord, fileName: string): Promise<void>
  cleanup(): Promise<void>
}
interface Backend { name: string; make(): Promise<Handle> }

const backends: Backend[] = [
  {
    name: 'InMemoryTable',
    make: async () => {
      const t = new InMemoryTable('/in-memory', () => T0)
      const wsDir = join('/in-memory', workspaceDirName(WS))
      return {
        table: t, stats: new InMemoryBatchKvTable<RecallStats>(), wsDir,
        seedArchived: async (r, fileName) => { t.seedFile({ dir: wsDir, fileName, record: r, archived: true }) },
        cleanup: async () => {},
      }
    },
  },
  {
    name: 'FileTable',
    make: async () => {
      const root = await mkdtemp(join(tmpdir(), 'pm-archive-pos-'))
      const { recallStats: stats } = new SidecarStore({ root, schemas: sidecarSchemas })
      const wsDir = join(root, workspaceDirName(WS))
      return {
        table: new FileTable({ root, stats, now: () => T0 }), stats, wsDir,
        seedArchived: async (r, fileName) => {
          await mkdir(join(wsDir, ARCHIVE_DIR), { recursive: true })
          await writeFile(join(wsDir, WORKSPACE_MARKER), `${WS}\n`)
          await writeFile(join(wsDir, ARCHIVE_DIR, fileName), encodeRecord(r, {}))
        },
        cleanup: () => rm(root, { recursive: true, force: true }),
      }
    },
  },
]

describe.each(backends)('写入段按位置认归档的记录：$name', ({ make }) => {
  let h: Handle
  let store: MemoryStore
  const at = { workspacePath: WS }

  beforeEach(async () => {
    h = await make()
    store = new MemoryStore(h.table, undefined, h.stats)
  })
  afterEach(() => h.cleanup())

  /** 前提：文件在 .archive/、frontmatter 写着 active，get 按位置读成 deleted。 */
  async function seedStray(r = pending()) {
    await h.seedArchived(r, 'stray.md')
    const raw = (await store.locate('mem_p', at))!
    expect(raw.record.status).toBe('active')
    expect(dirname(raw.filePath)).toBe(join(h.wsDir, ARCHIVE_DIR))
    expect((await store.get('mem_p', at))!.status).toBe('deleted')
    return raw
  }

  it('update 的回调看到的和 get 读到的是同一份（status 为 deleted）；回调原样返回时不写盘，返回值也是这一份', async () => {
    const raw = await seedStray()
    const viaGet = (await store.get('mem_p', at))!
    const seen: MemoryRecord[] = []
    const written = await store.update({ id: 'mem_p', workspacePath: WS }, (cur) => { seen.push(cur); return cur })
    expect(seen).toEqual([viaGet])
    expect(written).toEqual(viaGet)
    // 没写：文件还在原处，frontmatter 原样（没补 status、deletedAt）
    const after = (await store.locate('mem_p', at))!
    expect(after.filePath).toBe(raw.filePath)
    expect(after.record).toEqual(raw.record)
  })

  it('回调在已删的那一份上改了字段：写回留在 .archive/，frontmatter 改写成 deleted 并补 deletedAt，不搬回顶层', async () => {
    const raw = await seedStray()
    const seen: string[] = []
    const written = await store.update({ id: 'mem_p', workspacePath: WS }, (cur) => { seen.push(cur.status); return { ...cur, type: 'project' } })
    expect(seen).toEqual(['deleted'])
    expect(written).toMatchObject({ status: 'deleted', type: 'project', deletedAt: T0 })
    const after = (await store.locate('mem_p', at))!
    expect(dirname(after.filePath)).toBe(join(h.wsDir, ARCHIVE_DIR))
    expect(after.record).toEqual({ ...raw.record, status: 'deleted', type: 'project', deletedAt: T0 })
    expect((await h.table.readScope([h.wsDir])).records).toEqual([])   // 顶层没有它
  })

  it('软删的锁内核对也按位置看：isChanged 看到 deleted，判成被改过，不写', async () => {
    const raw = await seedStray()
    const seen: string[] = []
    const outcome = await store.softDeleteUnlessSecret({ id: 'mem_p', workspacePath: WS }, {
      now: T0, isChanged: (cur) => { seen.push(cur.status); return cur.status !== 'active' },
    })
    expect(seen).toEqual(['deleted'])
    expect(outcome).toBe('changed')
    const after = (await store.locate('mem_p', at))!
    expect(after.filePath).toBe(raw.filePath)
    expect(after.record).toEqual(raw.record)
  })

  it('现有行为不变：restoreArchived 仍把它改回 active、搬回顶层', async () => {
    await seedStray()
    expect(await store.restoreArchived({ id: 'mem_p', workspacePath: WS }, { now: T0 })).toBe(true)
    const after = (await store.locate('mem_p', at))!
    expect(dirname(after.filePath)).toBe(h.wsDir)
    expect(after.record).toMatchObject({ status: 'active', updatedAt: T0 })
    expect(after.record.deletedAt).toBeUndefined()
  })

  it('单条接受 accept-subagent：手工归档、frontmatter 仍写 active 的待确认记录回 not-subagent-pending（已删除），不复活、文件不动', async () => {
    const seeded = pending()
    expect(isPendingDelegated(seeded)).toBe(true)
    const raw = await seedStray(seeded)
    const deps: ConfirmToolDeps = {
      instructions: noInstructions, store,
      decisions: new PendingDecisionsStore(new InMemoryKvTable<PendingDecision>()),
      snapshots: new SnapshotStore(new InMemoryKvTable<MemorySnapshot>()),
      now: () => T0,
    }
    const r = await executeConfirm({ action: 'accept-subagent', memoryId: 'mem_p' }, { workspacePath: WS }, deps)
    expect(r).toMatchObject({ kind: 'error', code: 'not-subagent-pending' })
    expect((r as { message: string }).message).toContain('已删除')
    expect((await store.get('mem_p', at))!.status).toBe('deleted')
    const after = (await store.locate('mem_p', at))!
    expect(after.filePath).toBe(raw.filePath)
    expect(after.record).toEqual(seeded)
  })
  it('回调返回值相同的浅克隆（{ ...cur }）也算原样返回：不写，返回归一后的这一份', async () => {
    const raw = await seedStray()
    const viaGet = (await store.get('mem_p', at))!
    const seen: string[] = []
    const written = await store.update({ id: 'mem_p', workspacePath: WS }, (cur) => { seen.push(cur.status); return { ...cur } })
    expect(seen).toEqual(['deleted'])
    expect(written).toEqual(viaGet)
    const after = (await store.locate('mem_p', at))!
    expect(after.filePath).toBe(raw.filePath)
    expect(after.record).toEqual(raw.record)
  })

  it('.archive/ 里本来就写着 deleted、缺 deletedAt 的：回调原样返回时不补 deletedAt、不写；改了字段才补写', async () => {
    await h.seedArchived(pending({ status: 'deleted' }), 'stray.md')
    const raw = (await store.locate('mem_p', at))!
    expect(raw.record).toMatchObject({ status: 'deleted' })
    expect(raw.record.deletedAt).toBeUndefined()
    let calls = 0
    const unchanged = await store.update({ id: 'mem_p', workspacePath: WS }, (cur) => { calls++; return cur })
    expect(calls).toBe(1)
    expect(unchanged).toEqual(raw.record)
    expect((await store.locate('mem_p', at))!.record).toEqual(raw.record)
    // 再走一步：真改了字段，才按现有规则补 deletedAt、原地写回
    const written = await store.update({ id: 'mem_p', workspacePath: WS }, (cur) => ({ ...cur, type: 'project' }))
    expect(written).toMatchObject({ status: 'deleted', type: 'project', deletedAt: T0 })
    const after = (await store.locate('mem_p', at))!
    expect(after.filePath).toBe(raw.filePath)
    expect(after.record).toEqual({ ...raw.record, type: 'project', deletedAt: T0 })
  })

  it('归档记录只改召回统计：统计照常更新，记录其余部分不动（仍写 active、不补 deletedAt、不搬家）', async () => {
    const raw = await seedStray()
    const written = await store.update({ id: 'mem_p', workspacePath: WS }, (cur) => ({ ...cur, recallCount: 3, lastRecalledAt: T0 }))
    expect(written).toMatchObject({ status: 'deleted', recallCount: 3, lastRecalledAt: T0 })
    expect((await store.get('mem_p', at))!).toMatchObject({ status: 'deleted', recallCount: 3, lastRecalledAt: T0 })
    const after = (await store.locate('mem_p', at))!
    expect(after.filePath).toBe(raw.filePath)
    expect(after.record).toEqual({ ...raw.record, recallCount: 3, lastRecalledAt: T0 })
  })

  it('restoreArchived 的恢复时刻恰好等于 updatedAt：照样改回 active、搬回顶层', async () => {
    const seeded = pending()
    await seedStray(seeded)
    expect(await store.restoreArchived({ id: 'mem_p', workspacePath: WS }, { now: seeded.updatedAt })).toBe(true)
    const after = (await store.locate('mem_p', at))!
    expect(dirname(after.filePath)).toBe(h.wsDir)
    expect(after.record).toMatchObject({ status: 'active', updatedAt: seeded.updatedAt })
    expect((await store.get('mem_p', at))!.status).toBe('active')
  })

  it('回调只把 status 改回 active、其余不动：搬回顶层，返回值和磁盘一致', async () => {
    const raw = await seedStray()
    const written = await store.update({ id: 'mem_p', workspacePath: WS }, (cur) => ({ ...cur, status: 'active' }))
    expect(written.status).toBe('active')
    const after = (await store.locate('mem_p', at))!
    expect(dirname(after.filePath)).toBe(h.wsDir)
    expect(after.record).toEqual(raw.record)
    expect((await store.get('mem_p', at))!.status).toBe('active')
    expect((await h.table.readScope([h.wsDir])).records.map(l => l.record.id)).toEqual(['mem_p'])
  })

  it('从最近删除按快照恢复：快照里在用的那一版写回顶层，不因为归档文件里也写着 active 就当成已经在那', async () => {
    const raw = await seedStray()
    // 快照里是它在用时的那一版：内容和手工挪走的这个文件逐字段相同
    const snapshots = new SnapshotStore(new InMemoryKvTable<MemorySnapshot>())
    const snap = await snapshots.capture({ operation: 'pre-forget', description: '删除前', records: [raw.record] }, T0)
    const r = await snapshots.restore(snap, ['mem_p'], store, { target: 'exact', overwrite: cur => cur?.status === 'deleted', now: () => T0 })
    expect(r.restored).toEqual(['mem_p'])
    const after = (await store.locate('mem_p', at))!
    expect(dirname(after.filePath)).toBe(h.wsDir)
    expect(after.record).toMatchObject({ status: 'active' })
    expect((await store.get('mem_p', at))!.status).toBe('active')
  })

  it('成组接受 accept-subagent（memoryIds）：手工归档、frontmatter 仍写 active 的那条记 not-subagent-pending（已删除）、不复活，同组正常的照常接受', async () => {
    const seeded = pending()
    const raw = await seedStray(seeded)
    await store.create(pending({ id: 'mem_q', name: '另一条', content: '另一条子观察', summary: '另一条摘要' }))
    expect(isPendingDelegated((await store.get('mem_q', at))!)).toBe(true)   // 前提：同组那条是在用的待确认记录
    const deps: ConfirmToolDeps = {
      instructions: noInstructions, store,
      decisions: new PendingDecisionsStore(new InMemoryKvTable<PendingDecision>()),
      snapshots: new SnapshotStore(new InMemoryKvTable<MemorySnapshot>()),
      now: () => T0,
    }
    const r = await executeConfirm({ action: 'accept-subagent', memoryIds: ['mem_p', 'mem_q'] }, { workspacePath: WS }, deps)
    expect(r.kind).toBe('group-accepted')
    const result = r as GroupAcceptResult
    expect(result.acceptedIds).toEqual(['mem_q'])
    expect((await store.get('mem_q', at))!.delegation?.reviewed?.by).toBe('main')
    const item = result.groups.flatMap(g => g.items).find(i => i.memoryId === 'mem_p')
    expect(item?.outcome).toEqual({ kind: 'skipped', code: 'not-subagent-pending', reason: '已删除' })
    expect((await store.get('mem_p', at))!.status).toBe('deleted')
    const after = (await store.locate('mem_p', at))!
    expect(after.filePath).toBe(raw.filePath)
    expect(after.record).toEqual(seeded)
  })
})

describe('写入段按位置认归档的记录：FileTable 专有', () => {
  let root: string
  let store: MemoryStore
  const at = { workspacePath: WS }
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'pm-archive-pos-ft-'))
    const { recallStats: stats } = new SidecarStore({ root, schemas: sidecarSchemas })
    store = new MemoryStore(new FileTable({ root, stats, now: () => T0 }), undefined, stats)
  })
  afterEach(() => rm(root, { recursive: true, force: true }))

  it.each([
    { label: '原样返回', seed: pending(), fn: (cur: MemoryRecord) => cur, check: (w: MemoryRecord) => expect(w.status).toBe('deleted') },
    { label: '返回浅克隆', seed: pending(), fn: (cur: MemoryRecord) => ({ ...cur }), check: (w: MemoryRecord) => expect(w.status).toBe('deleted') },
    { label: '本来写着 deleted、缺 deletedAt，原样返回', seed: pending({ status: 'deleted' }), fn: (cur: MemoryRecord) => cur, check: (w: MemoryRecord) => expect(w.deletedAt).toBeUndefined() },
    { label: '只改召回统计', seed: pending(), fn: (cur: MemoryRecord) => ({ ...cur, recallCount: 3, lastRecalledAt: T0 }), check: (w: MemoryRecord) => expect(w.recallCount).toBe(3) },
  ])('回调$label：.archive/ 里的文件没被重写（字节、inode、修改时间都不变）', async ({ seed, fn, check }) => {
    const wsDir = join(root, workspaceDirName(WS))
    const filePath = await seedArchivedFile(wsDir, seed)
    const before = await fileState(filePath)
    let calls = 0
    const written = await store.update({ id: 'mem_p', workspacePath: WS }, (cur) => { calls++; return fn(cur) })
    expect(calls).toBe(1)
    check(written)
    expect(await fileState(filePath)).toEqual(before)
    expect(await readdir(wsDir)).toEqual(expect.not.arrayContaining(['stray.md']))
  })

  it('确定性交错：回调第一次跑时文件被手工挪进 .archive/（frontmatter 不改），写入段重来时回调看到 deleted，不写、不复活', async () => {
    await store.create(pending())
    const first = (await store.locate('mem_p', at))!
    expect(dirname(first.filePath)).toBe(join(root, workspaceDirName(WS)))   // 前提：起初在顶层、在用
    const archived = join(dirname(first.filePath), ARCHIVE_DIR, basename(first.filePath))
    const seen: string[] = []
    // 回调第一次跑完、落盘之前，用户把文件挪进 .archive/（不拿锁的手改）：挪动放在回调里做，时序是确定的
    const accept = store.update({ id: 'mem_p', workspacePath: WS }, (cur) => {
      seen.push(cur.status)
      if (seen.length === 1) {
        mkdirSync(dirname(archived), { recursive: true })
        renameSync(first.filePath, archived)
      }
      if (cur.status !== 'active') throw new Error('不是在用的待确认记录')
      return { ...cur, lastConfirmedAt: T0, delegation: { ...cur.delegation!, reviewed: { by: 'main', at: T0 } } }
    })
    await expect(accept).rejects.toThrow('不是在用的待确认记录')
    expect(seen).toEqual(['active', 'deleted'])
    const after = (await store.locate('mem_p', at))!
    expect(after.filePath).toBe(archived)
    expect(after.record.status).toBe('active')
    expect(after.record.delegation?.reviewed).toBeUndefined()
    expect((await store.get('mem_p', at))!.status).toBe('deleted')
  })
})

describe('经 store.update 的调用方：设置页改类型名', () => {
  it('retype 碰到手工归档、frontmatter 仍写 active 的记忆：改了类型，仍留在 .archive/、按已删写回，不复活', async () => {
    const e = env()
    const wsDir = join(guiRoot, workspaceDirName(WS))
    await mkdir(join(wsDir, ARCHIVE_DIR), { recursive: true })
    await writeFile(join(wsDir, WORKSPACE_MARKER), `${WS}\n`)
    await writeFile(join(wsDir, ARCHIVE_DIR, 'stray.md'), encodeRecord(pending({ type: 'domain-term', delegation: undefined }), {}))
    expect((await e.store.get('mem_p', { workspacePath: WS }))!.status).toBe('deleted')   // 前提

    const body = ok(await e.run({ cmd: 'migrate-type', from: 'domain-term', action: 'retype', to: 'glossary' }))
    expect(body.migrated).toBe(1)
    const after = (await e.store.locate('mem_p', { workspacePath: WS }))!
    expect(after.filePath).toBe(join(wsDir, ARCHIVE_DIR, 'stray.md'))
    expect(after.record).toMatchObject({ type: 'glossary', status: 'deleted' })
    expect(await readdir(wsDir)).toEqual(expect.not.arrayContaining(['stray.md']))
  })
})

describe('写入段按位置认归档的记录：FileTable 带操作日志', () => {
  let root: string
  let journal: OpJournal
  let table: FileTable
  let store: MemoryStore
  const at = { workspacePath: WS }
  const wsDir = () => join(root, workspaceDirName(WS))
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'pm-archive-pos-op-'))
    journal = new OpJournal({ path: join(root, '.state', 'op-journal.sqlite'), log: quietLog })
    const lock = createRootLock({ root, log: quietLog })
    const { recallStats: stats } = new SidecarStore({ root, log: quietLog, schemas: sidecarSchemas, lock })
    table = new FileTable({ root, stats, log: quietLog, now: () => T0, journal, lock })
    store = new MemoryStore(table, quietLog, stats)
  })
  afterEach(async () => {
    journal.close()
    await rm(root, { recursive: true, force: true })
  })

  /** 前提：这张表确实在记操作日志（日志里有一行时 isOpPending 认得出来）。 */
  function expectJournaling() {
    journal.begin({ op: 'op_probe', at: T0, target: { kind: 'index', dir: wsDir(), file: 'entry' }, steps: [] })
    expect(table.isOpPending('op_probe')).toBe(true)
    journal.done('op_probe')
    expect(journal.hasPending()).toBe(false)
  }

  const keepAsIs = (cur: MemoryRecord) => cur
  const refuse = (): MemoryRecord => { throw new Error('不是在用的待确认记录') }
  it.each([
    { path: '原地覆盖', rename: false, label: '原样返回', second: keepAsIs },
    { path: '原地覆盖', rename: false, label: '抛错退出', second: refuse },
    { path: '改名另占文件名', rename: true, label: '原样返回', second: keepAsIs },
    { path: '改名另占文件名', rename: true, label: '抛错退出', second: refuse },
  ])('确定性交错（第一轮走$path），重来那一轮$label：第一轮记下的操作日志行撤掉，不留未提交行', async ({ rename, label, second }) => {
    await store.create(pending())
    expectJournaling()
    const first = (await store.locate('mem_p', at))!
    const archived = join(dirname(first.filePath), ARCHIVE_DIR, basename(first.filePath))
    const op = newWriteOp()
    const seen: string[] = []
    const run = store.update({ id: 'mem_p', workspacePath: WS }, (cur) => {
      seen.push(cur.status)
      if (seen.length > 1) return second(cur)
      mkdirSync(dirname(archived), { recursive: true })
      renameSync(first.filePath, archived)   // 第一轮回调跑完、落盘之前，文件被手工挪进 .archive/
      return { ...cur, ...(rename ? { name: '改了名' } : {}), lastConfirmedAt: T0, delegation: { ...cur.delegation!, reviewed: { by: 'main', at: T0 } } }
    }, { workspacePath: WS }, op)
    if (label === '抛错退出') await expect(run).rejects.toThrow('不是在用的待确认记录')
    else expect((await run).status).toBe('deleted')
    expect(seen).toEqual(['active', 'deleted'])   // 前提：第一轮确实走到了复核失败、重来了一轮
    expect(table.isOpPending(op.id)).toBe(false)
    expect(journal.hasPending()).toBe(false)
    const after = (await store.locate('mem_p', at))!
    expect(after.filePath).toBe(archived)
    expect(after.record).toEqual(first.record)
  })

  it('带主题的写入：在用的记录原样返回照旧挪到那个主题；归档的原样返回什么都不做（不记日志、不改索引、不写文件）', async () => {
    const choose = (name: string): TopicIntent => ({ kind: 'choose', name, maxTopics: 30 })
    await table.create(record({ id: 'mem_a', name: '发版步骤', scope: 'workspace', workspacePath: WS }))
    await table.create(record({ id: 'mem_b', name: '回复用中文', scope: 'workspace', workspacePath: WS }))
    await table.maintain([wsDir()])
    await applied(table, wsDir(), { kind: 'assign', memoryIds: ['mem_a'], from: UNSORTED_TITLE, to: '上线' })
    expectJournaling()
    // 在用的：内容没变、只带了主题，照旧挪过去
    const liveOp = newWriteOp({ topic: choose('上线') })
    const live = await table.update('mem_b', at, r => r, liveOp)
    await table.finishOp(liveOp, live)
    expect(await membersOf(wsDir(), '上线')).toEqual(['mem_b', 'mem_a'])
    expect(journal.hasPending()).toBe(false)
    // 归档的：同样带主题、原样返回
    const filePath = await seedArchivedFile(wsDir(), pending())
    const fileBefore = await fileState(filePath)
    const indexBefore = await readIndexFiles(wsDir())
    const op = newWriteOp({ topic: choose('上线') })
    let calls = 0
    const written = await table.update('mem_p', at, (cur) => { calls++; return cur }, op)
    expect(calls).toBe(1)
    expect(written.status).toBe('deleted')
    expect(table.isOpPending(op.id)).toBe(false)
    expect(journal.hasPending()).toBe(false)
    expect(await readIndexFiles(wsDir())).toEqual(indexBefore)
    expect(await fileState(filePath)).toEqual(fileBefore)
    expect(await membersOf(wsDir(), '上线')).toEqual(['mem_b', 'mem_a'])
  })
})

describe('体检预读：作用域外按 id 定位到的引用也按位置看', () => {
  let root: string
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'pm-archive-pos-pre-')) })
  afterEach(() => rm(root, { recursive: true, force: true }))

  it('待决冲突的另一方只剩手工归档、frontmatter 仍写 active 的文件：定位到它，按已删读进预读结果', async () => {
    const OTHER = '/other'
    const now = T0
    const globalDir = join(root, GLOBAL_DIR)
    await mkdir(globalDir, { recursive: true })
    await writeFile(join(globalDir, 'g1.md'), encodeRecord(record({ id: 'mem_g1' }), {}))
    const otherDir = join(root, workspaceDirName(OTHER))
    await mkdir(join(otherDir, ARCHIVE_DIR), { recursive: true })
    await writeFile(join(otherDir, WORKSPACE_MARKER), `${OTHER}\n`)
    const strayPath = join(otherDir, ARCHIVE_DIR, 'b.md')
    await writeFile(strayPath, encodeRecord(record({ id: 'mem_b', scope: 'workspace', workspacePath: OTHER }), {}))
    const sidecar = new SidecarStore({ root, schemas: sidecarSchemas })
    const store = new MemoryStore(new FileTable({ root, stats: sidecar.recallStats, now: () => now }), undefined, sidecar.recallStats)
    expect((await store.locate('mem_b'))!.record.status).toBe('active')   // 前提：文件里写的是 active
    const decisions = new PendingDecisionsStore(sidecar.pending, sidecar.lock)
    await decisions.upsert({ memoryIds: ['mem_g1', 'mem_b'], summary: '' }, now)
    const data = await prereadScopes({ store, decisions, cache: sidecar.scanCache }, [{ kind: 'global' }])
    expect(data.filePaths.get('mem_b')).toBe(strayPath)   // 前提：确实按 id 定位到了作用域外的这一份
    expect(data.byId.get('mem_b')?.status).toBe('deleted')
    expect(data.byId.get('mem_g1')?.status).toBe('active')
  })
})
