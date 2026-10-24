import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileTable } from '../src/storage/file-table.ts'
import { encodeRecord, splitFrontmatter } from '../src/storage/frontmatter.ts'
import { GLOBAL_DIR, INDEX_FILE } from '../src/storage/paths.ts'
import { InMemoryKvTable } from '../src/kv-table.ts'
import { MemoryStore } from '../src/store.ts'
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
import { record as baseRecord, candidate } from './helpers/record.ts'
import { captureRejection } from './helpers/errors.ts'

// 写路径锁内 locate 之后、写盘之前，别的宿主进程或用户改了这个文件：update 要在新内容上重算，put 要基于新的
// 位置与附加字段重写，都不能拿旧读数盖掉新内容。fs 是进程边界：只给 readFile 套一层，在指定路径第 n 次读完
// 之后用真实 writeFile 换掉内容（与 file-table-maintain-race.spec.ts 同法）。
const { triggers } = vi.hoisted(() => ({ triggers: new Map<string, { afterRead: number; reads: number; text: string }>() }))
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const readFile = vi.fn(async (...args: Parameters<typeof actual.readFile>) => {
    const out = await actual.readFile(...args)
    const t = triggers.get(String(args[0]))
    if (t !== undefined && ++t.reads === t.afterRead) {
      triggers.delete(String(args[0]))
      await actual.writeFile(String(args[0]), t.text, 'utf8')
    }
    return out
  })
  return { ...actual, readFile }
})

/** 让 path 在第 afterRead 次被读完之后换成 text（只触发一次）。 */
function changeAfterRead(path: string, text: string, afterRead: number) {
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
    await t.update('mem_race', r => { seen.push(r.content); return { ...r, summary: 'fn 改的摘要' } })
    expect(seen).toEqual(['旧正文', '并发改的'])
    const fm = splitFrontmatter(await readFile(path, 'utf8'))
    expect(fm.body).toContain('并发改的')
    expect(fm.data.summary).toBe('fn 改的摘要')
  })

  it('每次重读都又被改：到上限报错，不覆盖别人的内容', async () => {
    const path = await seed('竞态.md', record())
    let calls = 0
    const t = newTable()
    // fn 运行时正处于 locate 与写盘之间：在这里同步写盘，等于每一轮都有别的进程抢先改了文件
    const err = await captureRejection(t.update('mem_race', r => {
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
    await t.update('mem_race', r => ({ ...r, name: '改名后' }))
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
    await newTable().put('mem_race', record({ content: 'put 的正文' }))
    const fm = splitFrontmatter(await readFile(path, 'utf8'))
    expect(fm.data.owner).toBe('me')
    expect(fm.body).toContain('put 的正文')
  })
})

/** 工具读到目标之后、写回之前，别处改了这条记忆的正文（经工具自己那次 get 的时机注入）。 */
function changeContentAfterGet(store: MemoryStore, id: string, content: string) {
  const get = store.get.bind(store)
  let fired = false
  vi.spyOn(store, 'get').mockImplementation(async (gid, hint) => {
    const r = await get(gid, hint)
    if (gid === id && !fired && r !== undefined) {
      fired = true
      const loc = (await store.locate(gid, hint))!
      await writeFile(loc.filePath, encodeRecord({ ...loc.record, content }, loc.extras), 'utf8')
    }
    return r
  })
}

describe('读改写的工具调用：读到之后被别处改过的正文不丢', () => {
  const newStore = () => new MemoryStore(newTable())
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
    const deps = { store, registry, workspacePath: '/proj' as string | undefined, session: { id: 's1', lastSeq: 42 } }
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
