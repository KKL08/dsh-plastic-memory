import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileTable } from '../src/storage/file-table.ts'
import { DerivedIndex } from '../src/storage/derived-index.ts'
import { ARCHIVE_DIR, GLOBAL_DIR, workspaceDirName } from '../src/storage/paths.ts'
import type { RecallStats } from '../src/storage/schema.ts'
import { MemoryStore } from '../src/store.ts'
import { scopeAt, type Scope } from '../src/scope.ts'
import type { MemoryRecord } from '../src/record-schema.ts'
import { record as baseRecord } from './helpers/record.ts'
import { InMemoryBatchKvTable } from './helpers/in-memory-kv.ts'
import { sidecarSchemas } from './helpers/sidecar-schemas.ts'
import { encodeRecord } from '../src/storage/frontmatter.ts'
import { layerOf } from '../src/storage/history.ts'
import { SidecarStore } from '../src/storage/sidecar.ts'
import { SnapshotStore } from '../src/governance/snapshots.ts'
import { commitChange } from '../src/commit-change.ts'
import { isCurrentPremise, premiseDigest } from '../src/links.ts'

// 链接反向索引：派生库记下谁经前提、相关、取代指向谁。真文件系统、真 node:sqlite。

const NOW = 1_800_000_000_000
const WS = '/tmp/pm-link-index'
const quietLog = { info: () => {}, warn: () => {}, error: () => {} }
const record = (partial: Partial<MemoryRecord> = {}) => baseRecord({ createdAt: NOW, updatedAt: NOW, lastConfirmedAt: NOW, scope: 'workspace', workspacePath: WS, ...partial })

let root: string
let stateDir: string
let indexes: DerivedIndex[] = []
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pm-link-index-'))
  stateDir = await mkdtemp(join(tmpdir(), 'pm-link-index-state-'))
})
afterEach(async () => {
  for (const index of indexes.splice(0)) index.close()
  await rm(root, { recursive: true, force: true })
  await rm(stateDir, { recursive: true, force: true })
})

const indexPath = () => join(stateDir, 'derived-index.sqlite')
const wsDir = () => join(root, workspaceDirName(WS))
const levels = () => [wsDir(), join(wsDir(), ARCHIVE_DIR), join(root, GLOBAL_DIR), join(root, GLOBAL_DIR, ARCHIVE_DIR)]

/** 写完一个文件、记链接之前在这里插一手（进程边界：别的程序改文件）。 */
class EditableTable extends FileTable {
  afterWrite: ((filePath: string) => Promise<void>) | undefined
  protected override async atomicWrite(filePath: string, text: string): Promise<void> {
    await super.atomicWrite(filePath, text)
    const edit = this.afterWrite
    this.afterWrite = undefined
    await edit?.(filePath)
  }
}

function open() {
  const index = new DerivedIndex({ path: indexPath(), log: quietLog })
  indexes.push(index)
  const stats = new InMemoryBatchKvTable<RecallStats>()
  const table = new EditableTable({ root, stats, now: () => NOW, log: quietLog, index, hintRacyMs: -60_000 })
  const store = new MemoryStore(table, quietLog, stats)
  return { index, store, table }
}
/** 派生库里各层记着的链接，按层、文件、种类、目标排好：比的是库的内容，不经过用时核对。 */
const dump = (index: DerivedIndex) => levels().flatMap(level => index.linkRows(level).map(row => ({ level: level.slice(root.length), ...row })))
const linksOf = (index: DerivedIndex) => dump(index).flatMap(r => r.links.map(l => `${r.sourceId}→${l.kind}:${l.targetId}`)).sort()

/** 项目目录的第一次列目录之后停住，等 resume 再往下走（进程边界：查询读完名单、还没写回时别的写入插进来）。 */
function pauseAfterListing(table: FileTable) {
  const probe = table as unknown as { listMemoryFiles: (level: string) => Promise<unknown> }
  const list = probe.listMemoryFiles.bind(table)
  let listed!: () => void
  let resume!: () => void
  const isListed = new Promise<void>((r) => { listed = r })
  const gate = new Promise<void>((r) => { resume = r })
  let isPaused = false
  probe.listMemoryFiles = async (level) => {
    const result = await list(level)
    if (level === wsDir() && !isPaused) {
      isPaused = true
      listed()
      await gate
    }
    return result
  }
  return { isListed, resume: () => resume() }
}

async function seedLinked(store: MemoryStore) {
  await store.create(record({ id: 'mem_page', name: '状态页' }))
  await store.create(record({ id: 'mem_global', name: '全局事实', scope: 'global', workspacePath: undefined }))
  await store.create(record({ id: 'mem_fact', name: '事实', related: ['mem_page', 'mem_global'] }))
  await store.create(record({ id: 'mem_decision', name: '决定', type: 'decision', premises: [{ id: 'mem_page', digest: 'dg_1' }] }))
  // 被取代的旧决定搬进归档，它的前提照样算
  await store.create(record({ id: 'mem_old', name: '旧决定', type: 'decision', premises: [{ id: 'mem_page', digest: 'dg_0' }] }))
  await store.create(record({ id: 'mem_new', name: '新决定', type: 'decision', supersedes: ['mem_old'] }))
  await store.update({ id: 'mem_old', workspacePath: WS }, r => ({ ...r, status: 'superseded' }), scopeAt(WS))
}

describe('链接反向索引', () => {
  it('写入时增量记下：不等整份核对，库里就有这次写的链接；归档里被取代的也在', async () => {
    const { index, store } = open()
    await seedLinked(store)
    expect(linksOf(index)).toEqual([
      'mem_decision→premise:mem_page', 'mem_fact→related:mem_global', 'mem_fact→related:mem_page',
      'mem_new→supersedes:mem_old', 'mem_old→premise:mem_page',
    ])
    const toPage = (await store.linksTo('mem_page', scopeAt(WS))).refs
    expect(toPage).toEqual([
      { sourceId: 'mem_decision', kind: 'premise', digest: 'dg_1' },
      { sourceId: 'mem_fact', kind: 'related' },
      { sourceId: 'mem_old', kind: 'premise', digest: 'dg_0' },
    ])
    expect((await store.linksTo('mem_old', scopeAt(WS))).refs).toEqual([{ sourceId: 'mem_new', kind: 'supersedes' }])
    // 全局记忆能被全局和各项目的记忆指向
    expect((await store.linksTo('mem_global', { kind: 'global' })).refs).toEqual([{ sourceId: 'mem_fact', kind: 'related' }])
  })

  it('改掉、删掉关联也增量记下', async () => {
    const { index, store } = open()
    await seedLinked(store)
    await store.update({ id: 'mem_fact', workspacePath: WS }, r => ({ ...r, related: ['mem_global'] }), scopeAt(WS))
    await store.hardDelete({ id: 'mem_decision', workspacePath: WS }, { at: scopeAt(WS) })
    expect(linksOf(index)).toEqual(['mem_fact→related:mem_global', 'mem_new→supersedes:mem_old', 'mem_old→premise:mem_page'])
  })

  it('手改文件加的关联：整份核对后补进库里', async () => {
    const { index, store } = open()
    await store.create(record({ id: 'mem_page', name: '状态页' }))
    await store.create(record({ id: 'mem_fact', name: '事实' }))
    const file = (await store.locate('mem_fact', scopeAt(WS)))!.filePath
    const text = await readFile(file, 'utf8')
    await writeFile(file, text.replace(/^id: (.*)$/m, 'id: $1\nrelated:\n  - mem_page'))
    expect(linksOf(index)).toEqual([])
    await store.maintain(scopeAt(WS))
    expect(linksOf(index)).toEqual(['mem_fact→related:mem_page'])
  })

  it('用的时候按文件签名核对：手改了、还没整份核对，查到的也以文件为准', async () => {
    const { store } = open()
    await store.create(record({ id: 'mem_page', name: '状态页' }))
    await store.create(record({ id: 'mem_fact', name: '事实', related: ['mem_page'] }))
    expect((await store.linksTo('mem_page', scopeAt(WS))).refs).toEqual([{ sourceId: 'mem_fact', kind: 'related' }])
    const file = (await store.locate('mem_fact', scopeAt(WS)))!.filePath
    await writeFile(file, (await readFile(file, 'utf8')).replace(/^related:\n  - mem_page\n/m, ''))
    expect((await store.linksTo('mem_page', scopeAt(WS))).refs).toEqual([])
  })

  it('删库后重建结果相同', async () => {
    const first = open()
    await seedLinked(first.store)
    const scopes: Scope[] = [scopeAt(WS), { kind: 'global' }]
    const ids = ['mem_page', 'mem_global', 'mem_old']
    const answer = async (store: MemoryStore) => Promise.all(ids.flatMap(id => scopes.map(s => store.linksTo(id, s))))
    await first.store.maintain({ kind: 'global' })
    await first.store.maintain(scopeAt(WS))
    const before = { rows: dump(first.index), answers: await answer(first.store) }
    first.index.close()
    await rm(indexPath(), { force: true })

    const second = open()
    expect(dump(second.index)).toEqual([])
    await second.store.maintain({ kind: 'global' })
    await second.store.maintain(scopeAt(WS))
    expect(dump(second.index)).toEqual(before.rows)
    expect(await answer(second.store)).toEqual(before.answers)
  })

  it('没有派生库（node:sqlite 不可用）时查到的一样', async () => {
    const { store } = open()
    await seedLinked(store)
    const stats = new InMemoryBatchKvTable<RecallStats>()
    const bare = new MemoryStore(new FileTable({ root, stats, now: () => NOW, log: quietLog }), quietLog, stats)
    for (const id of ['mem_page', 'mem_old']) expect((await bare.linksTo(id, scopeAt(WS))).refs).toEqual((await store.linksTo(id, scopeAt(WS))).refs)
  })

  it('提交之后、记链接之前文件被手改：库里记的是手改后的链接，带签名的查询和不带库的一样', async () => {
    const { store, table } = open()
    const fact = record({ id: 'mem_fact', name: '事实', related: ['mem_a'] })
    await store.create(fact)
    table.afterWrite = async (filePath) => { await writeFile(filePath, encodeRecord({ ...fact, related: ['mem_c'] }, {})) }
    await store.update(fact, r => ({ ...r, related: ['mem_b'] }), scopeAt(WS))
    expect((await store.get('mem_fact', scopeAt(WS)))!.related).toEqual(['mem_c'])
    expect((await store.linksTo('mem_c', scopeAt(WS))).refs).toEqual([{ sourceId: 'mem_fact', kind: 'related' }])
    expect((await store.linksTo('mem_b', scopeAt(WS))).refs).toEqual([])
  })

  it('同 id 的两份决定各引了这条记忆的不同版本：两份前提都查得到', async () => {
    const { store } = open()
    await store.create(record({ id: 'mem_decision', name: '全局决定', scope: 'global', workspacePath: undefined, premises: [{ id: 'mem_page', digest: 'dg_v1' }] }))
    await store.create(record({ id: 'mem_decision', name: '项目决定', premises: [{ id: 'mem_page', digest: 'dg_v2' }] }))
    for (const query of [store.linksTo.bind(store), store.indexedLinksTo.bind(store)]) {
      expect((await query('mem_page', { kind: 'global' })).refs).toEqual([
        { sourceId: 'mem_decision', kind: 'premise', digest: 'dg_v1' },
        { sourceId: 'mem_decision', kind: 'premise', digest: 'dg_v2' },
      ])
    }
  })

  it('同 id 的两份决定各引一版：合并窗口里接着做状态变化，被引的那一版留档', async () => {
    const { store } = open()
    const snapshots = new SnapshotStore(new SidecarStore({ root, log: quietLog, schemas: sidecarSchemas }).snapshots)
    const page = record({ id: 'mem_page', name: '状态页', scope: 'global', workspacePath: undefined })
    await store.create(page)
    await store.maintain({ kind: 'global' })
    await store.maintain(scopeAt(WS))
    const change = (target: MemoryRecord, content: string, at: number) =>
      commitChange({ target, kind: 'state-change', fields: { content }, by: 'main', sessionId: 's1', at }, { store, snapshots })
    expect((await change(page, '第二版', NOW + 1000)).kind).toBe('written')
    const second = (await store.get('mem_page', { kind: 'global' }))!
    await store.create(record({ id: 'mem_decision', name: '全局决定', scope: 'global', workspacePath: undefined, premises: [{ id: 'mem_page', digest: premiseDigest(page) }] }))
    await store.create(record({ id: 'mem_decision', name: '项目决定', premises: [{ id: 'mem_page', digest: premiseDigest(second) }] }))
    expect((await change(second, '第三版', NOW + 2000)).kind).toBe('written')
    const found = (await store.locate('mem_page', { kind: 'global' }))!
    expect((await store.history.list(layerOf(found), 'mem_page')).map(v => v.record.content)).toEqual([page.content, '第二版'])
  })
})

describe('写锁内的按目标查', () => {
  it('只看库：手改加的前提到整份核对之后才算进来；带签名的完整查询当场就看得到', async () => {
    const { store } = open()
    await store.create(record({ id: 'mem_page', name: '状态页' }))
    await store.create(record({ id: 'mem_decision', name: '决定' }))
    await store.maintain(scopeAt(WS))
    const file = (await store.locate('mem_decision', scopeAt(WS)))!.filePath
    await writeFile(file, (await readFile(file, 'utf8')).replace(/^id: (.*)$/m, 'id: $1\npremises:\n  - id: mem_page\n    digest: dg_hand'))
    const expected = [{ sourceId: 'mem_decision', kind: 'premise', digest: 'dg_hand' }]
    expect(await store.indexedLinksTo('mem_page', scopeAt(WS))).toEqual({ refs: [], isComplete: true })
    expect((await store.linksTo('mem_page', scopeAt(WS))).refs).toEqual(expected)
    await store.maintain(scopeAt(WS))
    expect(await store.indexedLinksTo('mem_page', scopeAt(WS))).toEqual({ refs: expected, isComplete: true })
  })

  it('还没核对过的层：这一次按文件签名核对一遍、记下核对过，以后只查库', async () => {
    const { index, store } = open()
    await store.create(record({ id: 'mem_page', name: '状态页' }))
    await store.create(record({ id: 'mem_decision', name: '决定', premises: [{ id: 'mem_page', digest: 'dg_1' }] }))
    expect(index.isLinkLevelReconciled(wsDir())).toBe(false)
    const expected = { refs: [{ sourceId: 'mem_decision', kind: 'premise', digest: 'dg_1' }], isComplete: true }
    expect(await store.indexedLinksTo('mem_page', scopeAt(WS))).toEqual(expected)
    expect(index.isLinkLevelReconciled(wsDir())).toBe(true)
    expect(index.isLinkLevelReconciled(join(wsDir(), ARCHIVE_DIR))).toBe(true)
    expect(await store.indexedLinksTo('mem_page', scopeAt(WS))).toEqual(expected)
  })

  it('有文件读不出：两种查询都报不完整，按被引用算', async () => {
    const { store } = open()
    const page = record({ id: 'mem_page', name: '状态页' })
    await store.create(page)
    await writeFile(join(wsDir(), '坏掉的.md'), '---\nid: [没有闭合\n---\n正文\n')
    expect((await store.linksTo('mem_page', scopeAt(WS))).isComplete).toBe(false)
    expect((await store.indexedLinksTo('mem_page', scopeAt(WS))).isComplete).toBe(false)
    expect(await isCurrentPremise(store, page)).toBe(true)
  })

  it('库忙、写入时没记上链接：这一层不再算核对过，按目标查改走文件核对，按被引用算', async () => {
    const { index, store } = open()
    const page = record({ id: 'mem_page', name: '状态页' })
    await store.create(page)
    await store.indexedLinksTo(page.id, scopeAt(WS))
    expect(index.isLinkLevelReconciled(wsDir())).toBe(true)
    // 另一个连接占着库：这次写入记链接失败
    const busy = new DatabaseSync(indexPath())
    busy.exec('BEGIN IMMEDIATE')
    try {
      await store.create(record({ id: 'mem_decision', name: '决定', premises: [{ id: page.id, digest: premiseDigest(page) }] }))
    } finally {
      busy.exec('ROLLBACK')
      busy.close()
    }
    expect(index.isLinkLevelReconciled(wsDir())).toBe(false)
    expect(await isCurrentPremise(store, page)).toBe(true)
    // 这一次按文件核对过、补上了：之后照常只查库
    expect(index.isLinkLevelReconciled(wsDir())).toBe(true)
    expect((await store.indexedLinksTo(page.id, scopeAt(WS))).refs).toEqual([{ sourceId: 'mem_decision', kind: 'premise', digest: premiseDigest(page) }])
  })

  it('整份核对时有文件读不出：不记核对过，原来记着的也作废，按被引用算', async () => {
    const { index, store } = open()
    const page = record({ id: 'mem_page', name: '状态页' })
    await store.create(page)
    await store.create(record({ id: 'mem_decision', name: '决定', premises: [{ id: page.id, digest: premiseDigest(page) }] }))
    await store.indexedLinksTo(page.id, scopeAt(WS))
    expect(index.isLinkLevelReconciled(wsDir())).toBe(true)
    const file = (await store.locate('mem_decision', scopeAt(WS)))!.filePath
    await chmod(file, 0o000)
    try {
      await store.maintain(scopeAt(WS))
      expect(index.isLinkLevelReconciled(wsDir())).toBe(false)
      // 读不出的那份文件签名没变：按库里记着的、签名对得上的行算，它的前提照样查得到
      expect((await store.indexedLinksTo(page.id, scopeAt(WS))).refs).toEqual([{ sourceId: 'mem_decision', kind: 'premise', digest: premiseDigest(page) }])
    } finally {
      await chmod(file, 0o600)   // 恢复权限，否则 afterEach 的 rm 会失败
    }
    expect(await isCurrentPremise(store, page)).toBe(true)
  })

  it('归档目录里的文件取不到签名（目录没有进入权限）：这一层不算读全，按被引用算', async () => {
    const { index, store } = open()
    const page = record({ id: 'mem_page', name: '状态页' })
    await store.create(page)
    await store.create(record({ id: 'mem_decision', name: '决定', status: 'superseded', premises: [{ id: page.id, digest: premiseDigest(page) }] }))
    // 换一个空库：归档这一层还没核对过
    index.close()
    await rm(indexPath())
    const archive = join(wsDir(), ARCHIVE_DIR)
    await chmod(archive, 0o400)
    try {
      expect((await store.indexedLinksTo(page.id, scopeAt(WS))).isComplete).toBe(false)
      expect(index.isLinkLevelReconciled(archive)).toBe(false)
    } finally {
      await chmod(archive, 0o700)   // 恢复权限，否则 afterEach 的 rm 会失败
    }
    expect(await isCurrentPremise(store, page)).toBe(true)
  })

  it('完整查询列完目录之后才写下的文件：写回核对结果时不删它的链接', async () => {
    const { store, table } = open()
    const page = record({ id: 'mem_page', name: '状态页' })
    await store.create(page)
    await store.maintain(scopeAt(WS))
    const pause = pauseAfterListing(table)
    const reader = store.linksTo(page.id, scopeAt(WS))
    await pause.isListed
    try {
      await store.create(record({ id: 'mem_decision', name: '决定', premises: [{ id: page.id, digest: premiseDigest(page) }] }))
    } finally {
      pause.resume()
    }
    await reader
    expect(await isCurrentPremise(store, page)).toBe(true)
  })

  it('不在写锁里的完整查询列完目录后，期间写入记链接失败：查询结束后这一层仍不算核对过，按被引用算', async () => {
    const { index, store, table } = open()
    const page = record({ id: 'mem_page', name: '状态页' })
    await store.create(page)
    await store.indexedLinksTo(page.id, scopeAt(WS))
    const pause = pauseAfterListing(table)
    const reader = store.linksTo(page.id, scopeAt(WS))
    await pause.isListed
    // 另一个连接占着库：这次写入记链接失败
    const busy = new DatabaseSync(indexPath())
    busy.exec('BEGIN IMMEDIATE')
    try {
      await store.create(record({ id: 'mem_decision', name: '决定', premises: [{ id: page.id, digest: premiseDigest(page) }] }))
    } finally {
      busy.exec('ROLLBACK')
      busy.close()
      pause.resume()
    }
    await reader
    expect(index.isLinkLevelReconciled(wsDir())).toBe(false)
    expect(await isCurrentPremise(store, page)).toBe(true)
  })

  it('不在写锁里的完整查询列完目录后，名单里没有的文件期间被重新写下：查询结束后它的链接还在', async () => {
    const { store, table } = open()
    const page = record({ id: 'mem_page', name: '状态页' })
    const decision = record({ id: 'mem_decision', name: '决定', premises: [{ id: page.id, digest: premiseDigest(page) }] })
    await store.create(page)
    await store.create(decision)
    await store.indexedLinksTo(page.id, scopeAt(WS))
    // 决定文件先被删掉（库里还记着它的行），查询列目录时它不在名单里
    await rm((await store.locate(decision.id, scopeAt(WS)))!.filePath)
    const pause = pauseAfterListing(table)
    const reader = store.linksTo(page.id, scopeAt(WS))
    await pause.isListed
    try {
      await store.create(decision)
    } finally {
      pause.resume()
    }
    await reader
    expect(await isCurrentPremise(store, page)).toBe(true)
  })

  it('旧结构版本（2）的库：删库重建，链接照常记、照常查', async () => {
    await mkdir(stateDir, { recursive: true })
    const old = new DatabaseSync(indexPath())
    old.exec('CREATE TABLE level_scans(level TEXT PRIMARY KEY, mtime_ms REAL NOT NULL, ino REAL NOT NULL, scanned_at REAL NOT NULL, listing TEXT NOT NULL, rev REAL NOT NULL)')
    old.exec('CREATE TABLE id_hints(level TEXT NOT NULL, name TEXT NOT NULL, id TEXT, sig TEXT NOT NULL, PRIMARY KEY(level, name))')
    old.exec('PRAGMA user_version = 2')
    old.close()
    const { index, store } = open()
    await seedLinked(store)
    await store.maintain(scopeAt(WS))
    expect(linksOf(index)).toContain('mem_decision→premise:mem_page')
    expect((await store.indexedLinksTo('mem_old', scopeAt(WS))).refs).toEqual([{ sourceId: 'mem_new', kind: 'supersedes' }])
    const check = new DatabaseSync(indexPath())
    expect((check.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(3)
    check.close()
  })
})
