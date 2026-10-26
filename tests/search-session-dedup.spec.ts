import { describe, expect, it } from 'vitest'
import { fakeExec } from './helpers/exec.ts'
import { record } from './helpers/record.ts'
import { executeSearch, renderSearchResult, IN_SNAPSHOT_NOTE, type SearchToolDeps } from '../src/tools/search.ts'
import { SnapshotCache } from '../src/runtime.ts'
import { MemoryStore, InMemoryTable } from '../src/store.ts'
import { InMemoryBatchKvTable } from '../src/kv-table.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'
import type { RecallStats } from '../src/storage/schema.ts'
import type { OverflowMode } from '../src/snapshot.ts'

const registry = buildTypeRegistry({ template: 'coding', customTypes: {} })

/** 真实的快照缓存 + 记忆存储 + 召回侧表（内存版），检索经同一个缓存认会话。 */
function setup(opts: { budget?: number; overflow?: OverflowMode } = {}) {
  const stats = new InMemoryBatchKvTable<RecallStats>()
  const store = new MemoryStore(new InMemoryTable(), undefined, stats)
  const cache = new SnapshotCache({ store, registry, budget: opts.budget ?? 4000, ...(opts.overflow ? { overflow: opts.overflow } : {}) })
  /** handle 是宿主的 session 对象；不给表示拿不到 session（如 exec 上没有 agent）。 */
  const deps = (handle?: object): SearchToolDeps => ({
    store, registry, sessionRecall: cache,
    resolveContext: async () => ({ workspacePath: undefined, session: { id: 's', lastSeq: 1, ...(handle ? { handle } : {}) } }),
  })
  const search = (query: string, handle?: object) => executeSearch({ query }, fakeExec(), deps(handle))
  /** 模拟宿主首轮组装：workspace 解析落定后冻结快照。 */
  const freeze = async (session: object) => {
    cache.setWorkspacePath(session, undefined)
    return cache.assemble(session)
  }
  const recallCount = async (id: string) => (await stats.get(id))?.recallCount ?? 0
  return { store, cache, search, freeze, recallCount }
}

const core = (id: string, content: string, confidence = 0.9) =>
  record({ id, type: 'preference', name: id, summary: `${id} 摘要`, content, confidence })

describe('memory_search：已带入全文的 core 记忆不重复贴正文', () => {
  it('同一会话命中冻结快照里带入全文的 core 记忆：id、摘要、排序照常，正文换成一句说明', async () => {
    const { store, search, freeze } = setup()
    await store.put(core('mem_core', '测试里不要 mock 数据库', 0.9))
    await store.put(record({ id: 'mem_k', type: 'knowledge', summary: '库表约定', content: '数据库表名用复数', confidence: 0.8 }))
    const session = {}
    await freeze(session)

    const plain = await search('数据库')
    const result = await search('数据库', session)
    expect(result.hits.map(h => h.id)).toEqual(plain.hits.map(h => h.id))
    const hit = result.hits.find(h => h.id === 'mem_core')!
    expect(hit.summary).toBe('mem_core 摘要')
    expect(hit.content).toBe(IN_SNAPSHOT_NOTE)
    const text = renderSearchResult(result)
    expect(text).toContain(`[mem_core] preference｜mem_core 摘要`)
    expect(text).not.toContain('测试里不要 mock 数据库')
    // 非 core 类型不在快照全文里，照常给全文
    expect(result.hits.find(h => h.id === 'mem_k')!.content).toBe('数据库表名用复数')
  })

  it('别的会话、还没冻结快照的会话、拿不到 session 的调用照常给全文', async () => {
    const { store, search, freeze } = setup()
    await store.put(core('mem_core', '测试里不要 mock 数据库'))
    await freeze({})

    expect((await search('数据库', {})).hits[0].content).toBe('测试里不要 mock 数据库')
    expect((await search('数据库')).hits[0].content).toBe('测试里不要 mock 数据库')
  })

  it('严格模式下被截掉、没带入全文的 core 记忆照常给全文', async () => {
    // core 区占上限一半：每条约 120 token，上限 400 时只装得下置信度高的那条
    const { store, search, freeze } = setup({ budget: 400, overflow: 'strict' })
    await store.put(core('mem_in', `数据库约定甲${'甲'.repeat(200)}`, 0.95))
    await store.put(core('mem_out', `数据库约定乙${'乙'.repeat(200)}`, 0.5))
    const session = {}
    const snapshot = await freeze(session)
    expect(snapshot).toContain('数据库约定甲')
    expect(snapshot).not.toContain('数据库约定乙')

    const hits = (await search('数据库约定', session)).hits
    expect(hits.find(h => h.id === 'mem_in')!.content).toBe(IN_SNAPSHOT_NOTE)
    expect(hits.find(h => h.id === 'mem_out')!.content).toContain('数据库约定乙')
  })

  it('冻结之后正文又改过的记忆照常给新全文（开头那份已经旧了）', async () => {
    const { store, search, freeze } = setup()
    await store.put(core('mem_core', '测试里不要 mock 数据库'))
    const session = {}
    await freeze(session)
    await store.put(core('mem_core', '测试里不要 mock 数据库，集成测试连真库'))

    expect((await search('数据库', session)).hits[0].content).toBe('测试里不要 mock 数据库，集成测试连真库')
  })

  it('压缩重建后按新快照判断：新带入的 core 记忆也换成说明', async () => {
    const { store, cache, search, freeze } = setup()
    await store.put(core('mem_old', '旧偏好 数据库'))
    const session = {}
    await freeze(session)
    await store.put(core('mem_new', '新偏好 数据库'))
    expect((await search('新偏好', session)).hits[0].content).toBe('新偏好 数据库')

    cache.markStale(session) // 压缩结束
    await cache.assemble(session) // 下一次中间件重建
    expect((await search('新偏好', session)).hits[0].content).toBe(IN_SNAPSHOT_NOTE)
  })
})

describe('召回统计：同一会话每条记忆只计一次', () => {
  it('快照冻结计过的 core 记忆，同一会话再检索命中不再累加', async () => {
    const { store, search, freeze, recallCount } = setup()
    await store.put(core('mem_core', '测试里不要 mock 数据库'))
    const session = {}
    await freeze(session)
    expect(await recallCount('mem_core')).toBe(1)

    await search('数据库', session)
    await search('mock', session)
    expect(await recallCount('mem_core')).toBe(1)
  })

  it('同一会话多次检索命中同一条只计一次，不同会话各计一次', async () => {
    const { store, search, freeze, recallCount } = setup()
    await store.put(record({ id: 'mem_k', type: 'knowledge', content: '数据库表名用复数' }))
    const a = {}
    const b = {}
    await freeze(a)
    await freeze(b)

    await search('数据库', a)
    await search('表名', a)
    expect(await recallCount('mem_k')).toBe(1)
    await search('数据库', b)
    expect(await recallCount('mem_k')).toBe(2)
  })

  it('先检索命中、后冻结快照带入，同一会话也只计一次', async () => {
    const { store, cache, search, recallCount } = setup()
    await store.put(core('mem_core', '测试里不要 mock 数据库'))
    const session = {}
    await search('数据库', session) // 冻结前（如 workspace 解析超时）就检索
    cache.setWorkspacePath(session, undefined)
    await cache.assemble(session)
    expect(await recallCount('mem_core')).toBe(1)
  })

  it('压缩重建：已计过的不重复计，新带入的 core 记忆补计一次', async () => {
    const { store, cache, freeze, recallCount } = setup()
    await store.put(core('mem_old', '旧偏好'))
    const session = {}
    await freeze(session)
    await store.put(core('mem_new', '新偏好'))
    cache.markStale(session)
    await cache.assemble(session)

    expect(await recallCount('mem_old')).toBe(1)
    expect(await recallCount('mem_new')).toBe(1)
  })
})
