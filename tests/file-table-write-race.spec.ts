import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileTable } from '../src/storage/file-table.ts'
import { encodeRecord, splitFrontmatter } from '../src/storage/frontmatter.ts'
import { ARCHIVE_DIR, GLOBAL_DIR, INDEX_FILE } from '../src/storage/paths.ts'
import { MemoryStore } from '../src/store.ts'
import { scopeAt } from '../src/scope.ts'
import { ConcurrentModificationError } from '../src/errors.ts'
import { SnapshotStore } from '../src/governance/snapshots.ts'
import { PendingDecisionsStore } from '../src/governance/decisions.ts'
import { executeConfirm } from '../src/tools/confirm.ts'
import { executePromote } from '../src/tools/promote.ts'
import { runSavePipeline } from '../src/pipeline.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'
import type { MemorySnapshot, PendingDecision } from '../src/governance/schema.ts'
import type { RecallStats } from '../src/storage/schema.ts'
import type { MemoryRecord } from '../src/record-schema.ts'
import type { LocatedFile } from '../src/storage/table.ts'
import type { RejectCode } from '../src/contract-codes.ts'
import { executeSnapshotTool } from '../src/tools/snapshot.ts'
import { record as baseRecord, candidate } from './helpers/record.ts'
import { captureRejection } from './helpers/errors.ts'
import { InMemoryKvTable, InMemoryBatchKvTable } from './helpers/in-memory-kv.ts'

// 写路径锁内 locate 之后、写盘之前，别的宿主进程或用户改了这个文件：update 要在新内容上重算，put 要基于新的
// 位置与附加字段重写，都不能拿旧读数盖掉新内容。fs 是进程边界：只给 readFile 套一层，在指定路径第 n 次读完
// 之后用真实 writeFile 换掉内容（与 file-table-maintain-race.spec.ts 同法）。
// writeGate：让一次写临时文件停在半路直到放行，用来把写锁占住。
const { triggers, writeGate } = vi.hoisted(() => ({
  triggers: new Map<string, { afterRead: number; reads: number; text: string | undefined }>(),
  writeGate: { current: undefined as { match: (path: string) => boolean; entered: () => void; release: Promise<void> } | undefined },
}))
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const readFile = vi.fn(async (...args: Parameters<typeof actual.readFile>) => {
    const out = await actual.readFile(...args)
    const t = triggers.get(String(args[0]))
    if (t !== undefined && ++t.reads === t.afterRead) {
      triggers.delete(String(args[0]))
      if (t.text === undefined) await actual.rm(String(args[0]))
      else await actual.writeFile(String(args[0]), t.text, 'utf8')
    }
    return out
  })
  const writeFile = vi.fn(async (...args: Parameters<typeof actual.writeFile>) => {
    const g = writeGate.current
    if (g !== undefined && g.match(String(args[0]))) {
      writeGate.current = undefined
      g.entered()
      await g.release
    }
    return actual.writeFile(...args)
  })
  return { ...actual, readFile, writeFile }
})

/** 让 path 在第 afterRead 次被读完之后换成 text（只触发一次）；text 缺省时删掉这个文件。 */
function changeAfterRead(path: string, text: string | undefined, afterRead: number) {
  triggers.set(path, { afterRead, reads: 0, text })
}

const record = (partial: Partial<MemoryRecord> = {}) => baseRecord({
  id: 'mem_race', name: '竞态', type: 'preference', content: '旧正文',
  createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000, lastConfirmedAt: 1_700_000_000_000, ...partial,
})

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'pm-write-race-')) })
afterEach(async () => {
  triggers.clear()
  writeGate.current = undefined
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})

const globalDir = () => join(root, GLOBAL_DIR)
const mds = async (dir: string) => (await readdir(dir).catch(() => [] as string[])).filter(n => n.endsWith('.md') && n !== INDEX_FILE).sort()
const newTable = () => new FileTable({ root, stats: new InMemoryKvTable<RecallStats>() })

async function seed(fileName: string, r: MemoryRecord, extras: Record<string, unknown> = {}): Promise<string> {
  await mkdir(globalDir(), { recursive: true })
  const path = join(globalDir(), fileName)
  await writeFile(path, encodeRecord(r, extras), 'utf8')
  return path
}

// 一次 locate 对目标文件读两次：扫 id 行一次、完整解析一次。第 2 次读完即「locate 刚结束」。
const AFTER_LOCATE = 2

describe('update：locate 之后文件被改，在新内容上重算再写', () => {
  it('并发修改不丢；fn 先后见到旧内容与新内容', async () => {
    const path = await seed('竞态.md', record())
    changeAfterRead(path, encodeRecord(record({ content: '并发改的' }), {}), AFTER_LOCATE)
    const seen: string[] = []
    const t = newTable()
    await t.update('mem_race', {}, r => { seen.push(r.content); return { ...r, summary: 'fn 改的摘要' } })
    expect(seen).toEqual(['旧正文', '并发改的'])
    const fm = splitFrontmatter(await readFile(path, 'utf8'))
    expect(fm.body).toContain('并发改的')
    expect(fm.data.summary).toBe('fn 改的摘要')
  })

  it('等锁期间文件被外部改了：update 拿到锁之后才读，fn 只被调一次、见到的就是外部改过的内容', async () => {
    const path = await seed('竞态.md', record())
    await seed('占锁.md', record({ id: 'mem_hold', name: '占锁' }))
    const t = newTable()
    let entered!: () => void
    const isEntered = new Promise<void>(resolve => { entered = resolve })
    let release!: () => void
    writeGate.current = { match: p => p.startsWith(join(globalDir(), '占锁.md.tmp-')), entered, release: new Promise<void>(resolve => { release = resolve }) }
    const holding = t.update('mem_hold', {}, r => ({ ...r, content: '占锁的写' }))
    await isEntered // 写锁被占着

    const seen: string[] = []
    const waiting = t.update('mem_race', {}, r => { seen.push(r.content); return { ...r, summary: 'fn 改的摘要' } })
    await writeFile(path, encodeRecord(record({ content: '等锁时外部改的' }), {}), 'utf8')
    release()
    await holding
    await waiting

    expect(seen).toEqual(['等锁时外部改的'])
    const fm = splitFrontmatter(await readFile(path, 'utf8'))
    expect(fm.body).toContain('等锁时外部改的')
    expect(fm.data.summary).toBe('fn 改的摘要')
  })

  it('每次重读都又被改：到上限报错，不覆盖别人的内容', async () => {
    const path = await seed('竞态.md', record())
    let calls = 0
    const t = newTable()
    // fn 运行时正处于 locate 与写盘之间：在这里同步写盘，等于每一轮都有别的进程抢先改了文件
    const err = await captureRejection(t.update('mem_race', {}, r => {
      calls++
      writeFileSync(path, encodeRecord(record({ content: `第 ${calls} 次并发` }), {}), 'utf8')
      return { ...r, summary: '不该落盘' }
    }))
    expect(err).toBeInstanceOf(ConcurrentModificationError)
    expect(calls).toBe(3)
    const text = await readFile(path, 'utf8')
    expect(text).toContain('第 3 次并发')
    expect(text).not.toContain('不该落盘')
  })

  it.each([
    ['占名之前', AFTER_LOCATE],
    ['占名之后、删旧文件之前', AFTER_LOCATE + 1],
  ])('改名（文件搬家）时%s源文件被改：源文件的新内容保留，重算后才搬', async (_label, afterRead) => {
    const path = await seed('竞态.md', record())
    changeAfterRead(path, encodeRecord(record({ content: '并发改的' }), {}), afterRead)
    const t = newTable()
    await t.update('mem_race', {}, r => ({ ...r, name: '改名后' }))
    expect(await mds(globalDir())).toEqual(['改名后.md'])
    const text = await readFile(join(globalDir(), '改名后.md'), 'utf8')
    expect(text).toContain('并发改的')
    expect(text).toContain('name: 改名后')
  })
})

describe('put：locate 之后文件被改，按新的位置与附加字段重写', () => {
  it('并发加上的未知 frontmatter 字段不丢，正文以 put 的值为准', async () => {
    const path = await seed('竞态.md', record())
    changeAfterRead(path, encodeRecord(record({ content: '并发改的' }), { owner: 'me' }), AFTER_LOCATE)
    await newTable().put(record({ content: 'put 的正文' }), {})
    const fm = splitFrontmatter(await readFile(path, 'utf8'))
    expect(fm.data.owner).toBe('me')
    expect(fm.body).toContain('put 的正文')
  })
})

/** 工具读到目标之后、写回之前，别处动了这条记忆（经工具自己那次 get 的时机注入，动作走真实文件）。 */
function afterGet(store: MemoryStore, id: string, act: (loc: LocatedFile) => Promise<void>) {
  const get = store.get.bind(store)
  let fired = false
  vi.spyOn(store, 'get').mockImplementation(async (gid, hint) => {
    const r = await get(gid, hint)
    if (gid === id && !fired && r !== undefined) {
      fired = true
      await act((await store.locate(gid, hint))!)
    }
    return r
  })
}
function changeContentAfterGet(store: MemoryStore, id: string, content: string) {
  afterGet(store, id, loc => writeFile(loc.filePath, encodeRecord({ ...loc.record, content }, loc.extras), 'utf8'))
}
/** 别处把它删了：硬删 = 文件没了；软删 = 文件里 status 改成 deleted（随后维护点才搬进 .archive/）。 */
const removals = {
  硬删: (loc: LocatedFile) => rm(loc.filePath),
  软删: (loc: LocatedFile) => writeFile(loc.filePath, encodeRecord({ ...loc.record, status: 'deleted', deletedAt: Date.now() }, loc.extras), 'utf8'),
}

describe('读改写的工具调用：读到之后被别处改过的正文不丢', () => {
  const newStore = () => new MemoryStore(newTable(), undefined, new InMemoryBatchKvTable())
  const bodyOf = async (store: MemoryStore, id: string) => (await store.get(id))!.content

  it('memory_confirm refresh 只改 lastConfirmedAt', async () => {
    const store = newStore()
    await store.put(record())
    changeContentAfterGet(store, 'mem_race', '并发改的')
    const deps = {
      store, now: () => 5000,
      decisions: new PendingDecisionsStore(new InMemoryKvTable<PendingDecision>()),
      snapshots: new SnapshotStore(new InMemoryKvTable<MemorySnapshot>()),
    }
    expect((await executeConfirm({ action: 'refresh', memoryId: 'mem_race' }, { workspacePath: '/proj' }, deps)).kind).toBe('refreshed')
    vi.restoreAllMocks()
    expect(await bodyOf(store, 'mem_race')).toBe('并发改的')
    expect((await store.get('mem_race'))!.lastConfirmedAt).toBe(5000)
  })

  const wsRecord = () => record({ scope: 'workspace', workspacePath: '/proj', globalCandidate: true })
  const promoteDeps = (store: MemoryStore) => ({
    store, agentsMd: { append: async () => {} }, snapshots: new SnapshotStore(new InMemoryKvTable<MemorySnapshot>()),
  })

  it('memory_promote dismiss 只清候选标记', async () => {
    const store = newStore()
    await store.put(wsRecord())
    changeContentAfterGet(store, 'mem_race', '并发改的')
    const r = await executePromote({ confirmedIds: ['mem_race'], target: 'global', dismiss: true }, { workspacePath: '/proj' }, promoteDeps(store))
    expect(r.dismissed).toEqual(['mem_race'])
    vi.restoreAllMocks()
    const after = (await store.get('mem_race', { workspacePath: '/proj' }))!
    expect(after.content).toBe('并发改的')
    expect(after.globalCandidate).toBeUndefined()
  })

  it('memory_promote 提升到 global 搬的是最新内容', async () => {
    const store = newStore()
    await store.put(wsRecord())
    changeContentAfterGet(store, 'mem_race', '并发改的')
    const r = await executePromote({ confirmedIds: ['mem_race'], target: 'global' }, { workspacePath: '/proj' }, promoteDeps(store))
    expect(r.promoted).toEqual([{ id: 'mem_race', target: 'global' }])
    vi.restoreAllMocks()
    const after = (await store.get('mem_race'))!
    expect(after.scope).toBe('global')
    expect(after.content).toBe('并发改的')
  })

  it('memory_save 的 supersedes 只改旧记忆的 status', async () => {
    const store = newStore()
    const registry = buildTypeRegistry({ template: 'coding', customTypes: {} })
    const deps = { store, registry, snapshots: new SnapshotStore(new InMemoryKvTable<MemorySnapshot>()), workspacePath: '/proj' as string | undefined, session: { id: 's1', lastSeq: 42 } }
    const old = await runSavePipeline(candidate({ content: '旧说法' }), deps)
    if (old.kind !== 'saved') throw new Error(old.kind)
    changeContentAfterGet(store, old.record.id, '并发改的')
    await runSavePipeline(candidate({ content: '完全不同的新说法', force: true, supersedes: [old.record.id] }), deps)
    vi.restoreAllMocks()
    const after = (await store.get(old.record.id, { workspacePath: '/proj' }))!
    expect(after.status).toBe('superseded')
    expect(after.content).toBe('并发改的')
  })
})

describe('memory_snapshot restore：预读之后被改的记录按「快照后被修改」跳过', () => {
  async function setup() {
    const store = new MemoryStore(newTable(), undefined, new InMemoryBatchKvTable())
    await store.put(record({ content: '快照时' }))
    const snapshots = new SnapshotStore(new InMemoryKvTable<MemorySnapshot>())
    const snap = await snapshots.capture({ operation: 'manual', description: 'd', records: [(await store.get('mem_race'))!] }, Date.now())
    changeContentAfterGet(store, 'mem_race', '并发改的')
    return { store, deps: { store, snapshots }, snap }
  }

  it('overwriteChanged=false：不覆盖并发修改，计入 skipped，提示里给出 overwriteChanged 参数', async () => {
    const { store, deps, snap } = await setup()
    const r = await executeSnapshotTool({ action: 'restore', snapshotId: snap.id }, { workspacePath: '/proj' }, deps)
    vi.restoreAllMocks()
    if (r.kind !== 'restored') throw new Error(r.kind)
    expect(r.restored).toEqual([])
    expect(r.skipped).toEqual(['mem_race'])
    expect(r.message).toContain('overwriteChanged: true')
    expect((await store.get('mem_race'))!.content).toBe('并发改的')
  })

  it('overwriteChanged=true：照常覆盖', async () => {
    const { store, deps, snap } = await setup()
    const r = await executeSnapshotTool({ action: 'restore', snapshotId: snap.id, overwriteChanged: true }, { workspacePath: '/proj' }, deps)
    vi.restoreAllMocks()
    if (r.kind !== 'restored') throw new Error(r.kind)
    expect(r.restored).toEqual(['mem_race'])
    expect((await store.get('mem_race'))!.content).toBe('快照时')
  })
})

describe('读改写的工具调用：读到之后记录被别处删掉，返回可读结果而不是抛错', () => {
  const newStore = () => new MemoryStore(newTable(), undefined, new InMemoryBatchKvTable())
  const confirmDeps = (store: MemoryStore) => ({
    store, now: () => 5000,
    decisions: new PendingDecisionsStore(new InMemoryKvTable<PendingDecision>()),
    snapshots: new SnapshotStore(new InMemoryKvTable<MemorySnapshot>()),
  })
  const wsRecord = () => record({ scope: 'workspace', workspacePath: '/proj', globalCandidate: true })
  const promoteDeps = (store: MemoryStore) => ({
    store, agentsMd: { append: async () => {} }, snapshots: new SnapshotStore(new InMemoryKvTable<MemorySnapshot>()),
  })

  it.each(Object.keys(removals) as Array<keyof typeof removals>)('memory_confirm refresh（%s）：返回 error「记忆不存在或已删除」', async how => {
    const store = newStore()
    await store.put(record())
    afterGet(store, 'mem_race', removals[how])
    const r = await executeConfirm({ action: 'refresh', memoryId: 'mem_race' }, { workspacePath: '/proj' }, confirmDeps(store))
    expect(r).toMatchObject({ kind: 'error', message: '记忆不存在或已删除：mem_race' })
  })

  it.each(Object.keys(removals) as Array<keyof typeof removals>)('memory_promote dismiss（%s）：计入 skipped', async how => {
    const store = newStore()
    await store.put(wsRecord())
    afterGet(store, 'mem_race', removals[how])
    const r = await executePromote({ confirmedIds: ['mem_race'], target: 'global', dismiss: true }, { workspacePath: '/proj' }, promoteDeps(store))
    expect(r.dismissed).toEqual([])
    expect(r.skipped).toEqual(['mem_race'])
    expect(r.message).toContain('不存在或已删除')
  })

  it.each(Object.keys(removals) as Array<keyof typeof removals>)('memory_promote 提升到 global（%s）：计入 skipped，不报已提升', async how => {
    const store = newStore()
    await store.put(wsRecord())
    afterGet(store, 'mem_race', removals[how])
    const r = await executePromote({ confirmedIds: ['mem_race'], target: 'global' }, { workspacePath: '/proj' }, promoteDeps(store))
    expect(r.promoted).toEqual([])
    expect(r.skipped).toEqual(['mem_race'])
    vi.restoreAllMocks()
    const after = await store.get('mem_race', { workspacePath: '/proj' })
    expect(after === undefined || after.scope === 'workspace').toBe(true)
  })

  it.each(Object.keys(removals) as Array<keyof typeof removals>)('memory_promote 写入 AGENTS.md（%s）：计入 skipped，不写 AGENTS.md', async how => {
    const store = newStore()
    await store.put(wsRecord())
    afterGet(store, 'mem_race', removals[how])
    const lines: string[] = []
    const deps = { ...promoteDeps(store), agentsMd: { append: async (l: string) => { lines.push(l) } } }
    const r = await executePromote({ confirmedIds: ['mem_race'], target: 'agents-md' }, { workspacePath: '/proj' }, deps)
    expect(r.promoted).toEqual([])
    expect(r.skipped).toEqual(['mem_race'])
    expect(lines).toEqual([])
  })

  it('memory_save 的 supersedes 目标被硬删：照常保存新记忆，静默跳过（同目标本就不存在时）', async () => {
    const store = newStore()
    const registry = buildTypeRegistry({ template: 'coding', customTypes: {} })
    const deps = { store, registry, snapshots: new SnapshotStore(new InMemoryKvTable<MemorySnapshot>()), workspacePath: '/proj' as string | undefined, session: { id: 's1', lastSeq: 42 } }
    const old = await runSavePipeline(candidate({ content: '旧说法' }), deps)
    if (old.kind !== 'saved') throw new Error(old.kind)
    afterGet(store, old.record.id, removals.硬删)
    const r = await runSavePipeline(candidate({ content: '完全不同的新说法', force: true, supersedes: [old.record.id] }), deps)
    expect(r.kind).toBe('saved')
    vi.restoreAllMocks()
    expect(await store.get(old.record.id, { workspacePath: '/proj' })).toBeUndefined()
  })
})

describe('memory_save supersedes：读到旧记忆之后、置 superseded 之前它被改过，不动', () => {
  const registry = buildTypeRegistry({ template: 'coding', customTypes: {} })
  const later = 1_700_000_005_000
  const changes: Array<[string, (store: MemoryStore, loc: LocatedFile) => Promise<unknown>]> = [
    ['被别的会话改写过', (store, loc) => store.update(loc.record, r => ({ ...r, content: '别的会话改的', updatedAt: later }))],
    ['被提升为全局、时间戳没变', (store, loc) => store.update(loc.record, ({ workspacePath: _, ...r }) => ({ ...r, scope: 'global' }))],
  ]

  it.each(changes)('PA-02：%s：新记忆照常保存，旧记忆保持在用', async (_label, change) => {
    const store = new MemoryStore(newTable(), undefined, new InMemoryBatchKvTable())
    const deps = { store, registry, snapshots: new SnapshotStore(new InMemoryKvTable<MemorySnapshot>()), workspacePath: '/proj' as string | undefined, session: { id: 's1', lastSeq: 42 } }
    const old = await runSavePipeline(candidate({ content: '旧说法' }), deps)
    if (old.kind !== 'saved') throw new Error(old.kind)
    afterGet(store, old.record.id, async loc => { await change(store, loc) })
    const r = await runSavePipeline(candidate({ content: '完全不同的新说法', force: true, supersedes: [old.record.id] }), deps)
    expect(r.kind).toBe('saved')
    vi.restoreAllMocks()
    expect((await store.get(old.record.id, { workspacePath: '/proj' }))!.status).toBe('active')
  })
})

describe('memory_save update：读到目标之后、写入之前目标被改过，不写', () => {
  const registry = buildTypeRegistry({ template: 'coding', customTypes: {} })
  const saveDeps = (store: MemoryStore) => ({
    store, registry, workspacePath: '/proj' as string | undefined, session: { id: 's1', lastSeq: 42 },
    snapshots: new SnapshotStore(new InMemoryKvTable<MemorySnapshot>()),
  })
  const later = 1_700_000_005_000
  // 管线读目标那一次 locate 读完即改：之后的去重、密钥检测、拍快照都在旧读数上做，写入那一刻才看到新内容
  const changes: Array<[string, string | undefined, RejectCode]> = [
    ['界面直接改过，带手改标记', encodeRecord(record({ content: '用户改的', handEdited: true, updatedAt: later }), {}), 'hand-edited'],
    ['别的会话改写过', encodeRecord(record({ content: '别的会话改的', updatedAt: later }), {}), 'target-missing'],
    ['软删了', encodeRecord(record({ status: 'deleted', deletedAt: later, updatedAt: later }), {}), 'target-missing'],
    ['硬删了', undefined, 'target-missing'],
  ]

  it.each(changes)('PA-02：%s：回拒绝，记录保持改过之后那一版', async (_label, text, code) => {
    const path = await seed('mem_race.md', record())
    changeAfterRead(path, text, AFTER_LOCATE)
    const r = await runSavePipeline(candidate({ action: 'update', id: 'mem_race', name: '竞态', type: 'preference', content: '模型想改成这样' }), saveDeps(new MemoryStore(newTable(), undefined, new InMemoryBatchKvTable())))
    expect(r).toMatchObject({ kind: 'rejected', code, subcode: 'changed-after-read' })
    expect(await readFile(path, 'utf8').catch(() => undefined)).toBe(text)
  })

  it('PA-02：界面改过：拒绝原因带用户那一版的内容', async () => {
    const path = await seed('mem_race.md', record())
    changeAfterRead(path, encodeRecord(record({ content: '用户改的', handEdited: true, updatedAt: later }), {}), AFTER_LOCATE)
    const r = await runSavePipeline(candidate({ action: 'update', id: 'mem_race', name: '竞态', type: 'preference', content: '模型想改成这样' }), saveDeps(new MemoryStore(newTable(), undefined, new InMemoryBatchKvTable())))
    if (r.kind !== 'rejected') throw new Error(r.kind)
    expect(r.reason).toContain('用户改的')
  })

  const update = () => candidate({ action: 'update', id: 'mem_race', name: '竞态', type: 'preference', content: '模型想改成这样' })

  it('PA-02：候选标记被清掉、updatedAt 没变：回拒绝，标记不被盖回', async () => {
    const store = new MemoryStore(newTable(), undefined, new InMemoryBatchKvTable())
    await store.put(record({ scope: 'workspace', workspacePath: '/proj', globalCandidate: true }))
    afterGet(store, 'mem_race', async loc => { await store.update(loc.record, r => ({ ...r, globalCandidate: false })) })
    const r = await runSavePipeline(update(), saveDeps(store))
    expect(r).toMatchObject({ kind: 'rejected', code: 'target-missing', subcode: 'changed-after-read' })
    vi.restoreAllMocks()
    expect(await store.get('mem_race', { workspacePath: '/proj' })).toMatchObject({ content: '旧正文', globalCandidate: false })
  })

  it('PA-02：文件原样移进 .archive/（frontmatter 没改）：按已删除回拒绝，不搬回顶层', async () => {
    const path = await seed('mem_race.md', record())
    const archived = join(globalDir(), ARCHIVE_DIR, 'mem_race.md')
    const store = new MemoryStore(newTable(), undefined, new InMemoryBatchKvTable())
    afterGet(store, 'mem_race', async () => {
      await mkdir(join(globalDir(), ARCHIVE_DIR), { recursive: true })
      await rename(path, archived)
    })
    const r = await runSavePipeline(update(), saveDeps(store))
    expect(r).toMatchObject({ kind: 'rejected', code: 'target-missing', subcode: 'changed-after-read' })
    expect(await mds(globalDir())).toEqual([])
    expect(await readFile(archived, 'utf8')).toBe(encodeRecord(record(), {}))
  })

  it('PA-02：本项目那份被只删这一层、global 有同 id 同时间戳的副本：回拒绝，global 那份不动、不被搬走', async () => {
    const store = new MemoryStore(newTable(), undefined, new InMemoryBatchKvTable())
    await store.put(record({ content: '全局那份' }))
    await store.put(record({ scope: 'workspace', workspacePath: '/proj', content: '项目那份' }), { kind: 'workspace', workspacePath: '/proj' })
    afterGet(store, 'mem_race', async loc => {
      expect(loc.record.content).toBe('项目那份')
      expect(await store.hardDelete(loc.record, { at: scopeAt(loc.record.workspacePath) })).toBe(true)
    })
    const r = await runSavePipeline(update(), saveDeps(store))
    expect(r).toMatchObject({ kind: 'rejected', code: 'target-missing', subcode: 'changed-after-read' })
    vi.restoreAllMocks()
    expect(await store.get('mem_race', { workspacePath: '/proj' })).toMatchObject({ scope: 'global', content: '全局那份' })
  })

  it('读到之后没人动过：照常写入', async () => {
    await seed('mem_race.md', record())
    const store = new MemoryStore(newTable(), undefined, new InMemoryBatchKvTable())
    const r = await runSavePipeline(candidate({ action: 'update', id: 'mem_race', name: '竞态', type: 'preference', content: '模型想改成这样' }), saveDeps(store))
    expect(r.kind).toBe('updated')
    expect((await store.get('mem_race'))!.content).toBe('模型想改成这样')
  })
})
