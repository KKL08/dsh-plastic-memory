import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RecallStats } from '../src/storage/schema.ts'
import { FileTable } from '../src/storage/file-table.ts'
import { GLOBAL_DIR, workspaceDirName } from '../src/storage/paths.ts'
import { INDEX_DIR, INDEX_ENTRY_FILE, INDEX_TOPICS_DIR } from '../src/storage/index-store.ts'
import { MemoryStore } from '../src/store.ts'
import { SnapshotCache } from '../src/runtime.ts'
import { ledgerLabel } from '../src/scope.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'
import { INDEX_UNREADABLE_TEXT } from '../src/snapshot.ts'
import { memberLine, UNSORTED_PAGE } from '../src/topic-index.ts'
import { InMemoryBatchKvTable } from './helpers/in-memory-kv.ts'
import { InMemoryTable } from './helpers/in-memory-table.ts'
import { record } from './helpers/record.ts'
import { FAKE_SECRET } from './helpers/secrets.ts'
import type { OverflowLedger } from '../src/runtime.ts'

// 列目录时抛 EACCES 的目录（精确到这一层）
const unlistable = vi.hoisted(() => new Set<string>())
vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...fs,
    readdir: async (...args: Parameters<typeof fs.readdir>) => {
      if (unlistable.has(String(args[0]))) throw Object.assign(new Error('权限不足'), { code: 'EACCES' })
      return fs.readdir(...args)
    },
  }
})

const WS = '/项目'
const registry = buildTypeRegistry({ template: 'coding', customTypes: {} })
let root = ''
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), '注入索引-')) })
afterEach(async () => { unlistable.clear(); await rm(root, { recursive: true, force: true }) })

const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })
function world(opts: { log?: ReturnType<typeof logger>; overflowLedger?: OverflowLedger; budget?: number } = {}) {
  const stats = new InMemoryBatchKvTable<RecallStats>()
  const store = new MemoryStore(new FileTable({ root, stats, now: () => 0 }), undefined, stats)
  const cache = new SnapshotCache({ store, registry, budget: opts.budget ?? 4000, now: () => 0, ...opts })
  const assembleIn = async (workspacePath?: string) => {
    const session = {}
    cache.setWorkspacePath(session, workspacePath)
    return (await cache.assemble(session))!
  }
  return { store, cache, assembleIn }
}
const memory = (id: string, partial: Parameters<typeof record>[0] = {}) =>
  record({ id, name: id, summary: `${id} 的摘要`, createdAt: 0, updatedAt: 0, lastConfirmedAt: 0, ...partial })

/** 像用户手改那样写一个目录的主题索引：topics 按先后，每个 [名称, 说明, 成员 id]。 */
async function writeIndex(dir: string, topics: Array<[string, string, string[]]>) {
  await mkdir(join(dir, INDEX_DIR, INDEX_TOPICS_DIR), { recursive: true })
  let entry = '# 记忆索引\n'
  for (const [i, [name, about, ids]] of topics.entries()) {
    entry += `\n## [${name}](topics/t${i}.md)\n${about}\n`
    await writeFile(join(dir, INDEX_DIR, INDEX_TOPICS_DIR, `t${i}.md`), `# ${name}\n\n${ids.map(id => memberLine({ id, name: id, summary: '', fileName: `${id}.md` })).join('\n')}\n`)
  }
  await writeFile(join(dir, INDEX_DIR, INDEX_ENTRY_FILE), entry)
}

describe('快照冻结：先维护再读索引', () => {
  it('维护在读索引之前：刚存的记忆在第一次冻结就出现在「未整理」里，手改的主题顺序就是注入顺序', async () => {
    const { store, assembleIn } = world()
    await store.create(memory('m_a', { scope: 'workspace', workspacePath: WS }))
    await store.create(memory('m_b', { scope: 'workspace', workspacePath: WS }))
    await store.create(memory('m_c', { scope: 'workspace', workspacePath: WS }))
    // 用户手改：乙在前、甲在后；m_c 不在任何主题里
    await writeIndex(join(root, workspaceDirName(WS)), [['乙', '后建的主题放前面', ['m_b']], ['甲', '', ['m_a']]])
    const text = await assembleIn(WS)
    expect(text.indexOf('### 乙（1 条）：后建的主题放前面')).toBeLessThan(text.indexOf('### 甲（1 条）'))
    expect(text).toContain('### 未整理（1 条）')
    expect(text.indexOf('[m_b]')).toBeLessThan(text.indexOf('[m_a]'))
    expect(text.indexOf('[m_a]')).toBeLessThan(text.indexOf('[m_c]'))
    // 维护把 m_c 补进了磁盘上的「未整理」
    expect(await readFile(join(root, workspaceDirName(WS), INDEX_DIR, INDEX_TOPICS_DIR, UNSORTED_PAGE), 'utf8')).toContain('"m_c"')
  })

  it('调用顺序：先 maintain，再读两层索引，最后组装', async () => {
    const { store, assembleIn } = world()
    const calls: string[] = []
    const maintain = store.maintain.bind(store)
    const readIndex = store.readIndex.bind(store)
    vi.spyOn(store, 'maintain').mockImplementation(async (scope) => { calls.push('maintain'); await maintain(scope) })
    vi.spyOn(store, 'readIndex').mockImplementation(async (scope) => { calls.push(`readIndex:${scope.kind}`); return readIndex(scope) })
    await store.create(memory('m_g'))
    await assembleIn(WS)
    expect(calls).toEqual(['maintain', 'readIndex:global', 'readIndex:workspace'])
  })

  it('维护失败只记日志，照常读索引组装、冻结', async () => {
    const log = logger()
    const { store, cache } = world({ log })
    await store.create(memory('m_g'))
    vi.spyOn(store, 'maintain').mockRejectedValue(new Error('维护炸了'))
    const session = {}
    cache.setWorkspacePath(session, WS)
    const text = await cache.assemble(session)
    expect(text).toContain('### 未整理（1 条）')
    expect(text).toContain('[m_g]')
    expect(log.error).toHaveBeenCalledWith('[plastic-memory] 记忆目录维护失败:', expect.any(Error))
    // 冻结了：再组装命中缓存，不再维护
    expect(await cache.assemble(session)).toBe(text)
    expect(store.maintain).toHaveBeenCalledTimes(1)
  })

  it('某一层的主题索引读不出：这一层平铺、写明没按主题分组，另一层照常；日志遮盖密钥', async () => {
    const log = logger()
    const { store, assembleIn } = world({ log })
    await store.create(memory('m_w', { scope: 'workspace', workspacePath: WS }))
    await store.create(memory('m_g'))
    await writeIndex(join(root, GLOBAL_DIR), [['全局主题', '', ['m_g']]])
    const readIndex = store.readIndex.bind(store)
    vi.spyOn(store, 'readIndex').mockImplementation(async (scope) => {
      if (scope.kind === 'workspace') throw new Error(`读不出 ${FAKE_SECRET.sk}`)
      return readIndex(scope)
    })
    const text = await assembleIn(WS)
    expect(text).toContain(`### ${INDEX_UNREADABLE_TEXT}（1 条）`)
    expect(text).toContain('[m_w]')
    expect(text).toContain('### 全局主题（1 条）')
    expect(log.warn).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain(FAKE_SECRET.sk)
  })

  it('目录读不出时不冻结、每个发送点重读，但同一个冻结点只维护一次；压缩后的冻结点再维护一次', async () => {
    const { store, cache } = world({ log: logger() })
    await store.create(memory('m_w', { scope: 'workspace', workspacePath: WS }))
    await store.create(memory('m_g'))
    const maintain = vi.spyOn(store, 'maintain')
    unlistable.add(join(root, GLOBAL_DIR))
    const session = {}
    cache.setWorkspacePath(session, WS)
    for (let i = 0; i < 3; i++) expect(await cache.assemble(session)).toContain('[m_w]')
    expect(maintain).toHaveBeenCalledTimes(1)
    cache.markCompacted(session, 1)
    await cache.assemble(session)
    await cache.assemble(session)
    expect(maintain).toHaveBeenCalledTimes(2)
  })

  it('同一会话并发组装：后来的等进行中的维护做完才读索引，维护只跑一次，两次拿到同一份', async () => {
    const { store, cache } = world()
    await store.create(memory('m_g'))
    const calls: string[] = []
    let release!: () => void
    const gate = new Promise<void>(done => { release = done })
    let started!: () => void
    const isStarted = new Promise<void>(done => { started = done })
    const maintain = store.maintain.bind(store)
    const readIndex = store.readIndex.bind(store)
    const spy = vi.spyOn(store, 'maintain').mockImplementation(async (scope) => {
      started()
      await gate
      await maintain(scope)
      calls.push('维护完成')
    })
    vi.spyOn(store, 'readIndex').mockImplementation(async (scope) => { calls.push('读索引'); return readIndex(scope) })
    const session = {}
    cache.setWorkspacePath(session, undefined)
    const first = cache.assemble(session)
    await isStarted
    const second = cache.assemble(session)
    release()
    const [a, b] = await Promise.all([first, second])
    expect(a).toBe(b)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(calls[0]).toBe('维护完成')
    expect(calls.filter(c => c === '维护完成')).toHaveLength(1)
  })

  it('维护失败不算维护过：同一个冻结点的下一次组装再试，成功之后不再维护', async () => {
    const { store, cache } = world({ log: logger() })
    await store.create(memory('m_g'))
    const maintain = store.maintain.bind(store)
    const spy = vi.spyOn(store, 'maintain').mockRejectedValueOnce(new Error('维护炸了')).mockImplementation(maintain)
    // 目录读不出：文本不冻结，每个发送点都重组，看得出这个冻结点还维护不维护
    unlistable.add(join(root, GLOBAL_DIR))
    const session = {}
    cache.setWorkspacePath(session, undefined)
    for (let i = 0; i < 3; i++) await cache.assemble(session)
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('构建中途标了过期：旧代的重建不另起维护，但等新代已经在跑的那次维护做完才冻结，维护写的内容进这份注入', async () => {
    const store = new MemoryStore(new InMemoryTable(), undefined, new InMemoryBatchKvTable<RecallStats>())
    const cache = new SnapshotCache({ store, registry, budget: 4000, now: () => 0 })
    const deferred = () => {
      let resolve!: () => void
      const promise = new Promise<void>(done => { resolve = done })
      return { promise, resolve }
    }
    const gates = [deferred(), deferred()]
    const starts = [deferred(), deferred()]
    let calls = 0
    vi.spyOn(store, 'maintain').mockImplementation(async () => {
      const i = calls++
      starts[i]!.resolve()
      await gates[i]!.promise
      // 新代的维护往库里写了一条（像手编回写、补进索引那样，维护写下的内容）
      if (i === 1) await store.create(memory('m_new'))
    })
    const session = {}
    cache.setWorkspacePath(session, undefined)
    const previous = cache.assemble(session)
    await starts[0]!.promise
    cache.markStale(session)
    const current = cache.assemble(session)
    await starts[1]!.promise
    gates[0]!.resolve()
    // 旧代的构建跑完它能跑的（全在内存里，排空一轮就够）：新代维护还挂着，不能冻结
    await new Promise(done => setImmediate(done))
    expect(cache.injectedCore(session)).toBeUndefined()
    gates[1]!.resolve()
    const [a, b] = await Promise.all([previous, current])
    expect(a).toContain('[m_new]')
    expect(b).toBe(a)
    expect(calls).toBe(2)
  })

  it('改了上限后重算用量：走同一套组装，读索引，不维护', async () => {
    const synced: Array<[string, number]> = []
    const ledger: OverflowLedger = { syncOverflow: async (scope, level) => { synced.push([scope, level?.tier ?? -1]); return true } }
    const { store, cache } = world({ overflowLedger: ledger, budget: 1 })
    await store.create(memory('m_g'))
    const maintain = vi.spyOn(store, 'maintain')
    const readIndex = vi.spyOn(store, 'readIndex')
    await cache.resyncOverflow([ledgerLabel({ kind: 'global' })])
    expect(maintain).not.toHaveBeenCalled()
    expect(readIndex).toHaveBeenCalledWith({ kind: 'global' })
    expect(synced).toHaveLength(1)
  })
})
