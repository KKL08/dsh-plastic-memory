import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { fakeExec } from './helpers/exec.ts'
import { record } from './helpers/record.ts'
import { NOW, DAY } from './helpers/clock.ts'
import { InMemoryTable } from './helpers/in-memory-table.ts'
import { InMemoryBatchKvTable } from './helpers/in-memory-kv.ts'
import { executeSearch, renderSearchResult, type SearchArgs, type SearchToolDeps } from '../src/tools/search.ts'
import { findMemoryCandidates } from '../src/search/memory-candidates.ts'
import { SnapshotCache } from '../src/runtime.ts'
import { MemoryStore } from '../src/store.ts'
import { GLOBAL_DIR } from '../src/storage/paths.ts'
import { defaultJiebaLoader, resetJieba } from '../src/search/jieba-segmenter.ts'
import { join } from 'node:path'
import { buildTypeRegistry } from '../src/type-registry.ts'
import type { RecallStats } from '../src/storage/schema.ts'
import type { MemoryRecord } from '../src/record-schema.ts'

const registry = buildTypeRegistry({ template: 'coding', customTypes: {} })
const WS = '/proj'

/** 数读盘次数的内存表：按范围读（readScope）和按 id 读（locate）都算。 */
class CountingTable extends InMemoryTable {
  reads = 0
  override async readScope(...args: Parameters<InMemoryTable['readScope']>) {
    this.reads++
    return super.readScope(...args)
  }
  override async locate(...args: Parameters<InMemoryTable['locate']>) {
    this.reads++
    return super.locate(...args)
  }
}

// 基准是真实分词组件切出来的；组件装不上时检索退回相邻两字切法，输出本来就不同
const hasRealJieba = await defaultJiebaLoader.importJieba().then(() => true, () => false)

function setup() {
  const table = new CountingTable()
  const stats = new InMemoryBatchKvTable<RecallStats>()
  const store = new MemoryStore(table, undefined, stats)
  const cache = new SnapshotCache({ store, registry, budget: 4000 })
  const deps = (handle?: object): SearchToolDeps => ({
    store, registry, sessionRecall: cache, now: () => NOW,
    host: { contextOf: async () => ({ workspacePath: WS, session: { id: 's', lastSeq: 1, ...(handle ? { handle } : {}) } }) },
  })
  const search = (args: SearchArgs, handle?: object) => executeSearch(args, fakeExec(), deps(handle))
  const recallCount = async (id: string) => (await stats.get(id))?.recallCount ?? 0
  return { table, store, cache, search, recallCount }
}

const mem = (id: string, partial: Partial<MemoryRecord>) =>
  record({ id, name: id, summary: `${id} 摘要`, confidence: 0.8, lastConfirmedAt: NOW - DAY, ...partial })

/** 对照用的记忆：全局与项目两层、几种类型、待确认、过期、长正文、带密钥。 */
const MEMORIES: MemoryRecord[] = [
  mem('mem_db_mock', { type: 'preference', content: '测试里不要 mock 数据库，集成测试连真实的 PostgreSQL。', tags: ['测试', '数据库'], confidence: 0.95 }),
  mem('mem_db_naming', { type: 'knowledge', content: '数据库表名用复数，字段用 snake_case。', tags: ['数据库'] }),
  mem('mem_deploy', { type: 'knowledge', scope: 'workspace', workspacePath: WS, content: '部署走 GitHub Actions，发布前先跑 pnpm build 和集成测试。', tags: ['部署'] }),
  mem('mem_long', { type: 'knowledge', scope: 'workspace', workspacePath: WS, content: `缓存策略说明。${'这一段讲缓存失效的细节，写得很长。'.repeat(120)}数据库连接池上限是二十。${'后面还有一大段无关内容。'.repeat(120)}` }),
  mem('mem_pending', { type: 'knowledge', content: '数据库迁移脚本放在 migrations 目录。', confidence: 0.99, delegation: { sessionId: 's-child', depth: 1, parentSessionId: 's-main' } }),
  mem('mem_expired', { type: 'knowledge', content: '数据库临时账号下周收回。', validTo: NOW - DAY }),
  mem('mem_secret', { type: 'knowledge', content: '数据库连接串里的口令是 sk-abcdefghijklmnopqrstuvwxyz0123456789ABCD，不要外传。' }),
  mem('mem_english', { type: 'knowledge', content: 'Use vitest for unit tests; playwright covers the login flow.', tags: ['testing'] }),
  mem('mem_cache_a', { type: 'knowledge', content: `缓存键的命名。${'键名带上租户和版本，避免串数据。'.repeat(150)}` }),
  mem('mem_cache_b', { type: 'knowledge', content: `缓存预热的做法。${'发布后先预热热点数据，再放流量。'.repeat(150)}` }),
  mem('mem_review', { type: 'preference', content: '代码评审先看测试，再看实现。', confidence: 0.7 }),
  mem('mem_old', { type: 'knowledge', content: '数据库备份每天凌晨三点跑。', lastConfirmedAt: NOW - 400 * DAY }),
  mem('mem_both', { type: 'knowledge', scope: 'workspace', workspacePath: WS, content: '项目这份：日志用 JSON 格式，并带上请求编号。' }),
  ...Array.from({ length: 14 }, (_, i) => mem(`mem_api_${String(i).padStart(2, '0')}`, { type: 'knowledge', content: `接口约定第 ${i} 条：返回值统一包一层 data 字段。`, confidence: 0.5 + i / 100 })),
]

/** 写入对照用的记忆。mem_both 在全局和项目各有一份：store.put 会清掉同 id 的另一份，全局那份直接落到表里。 */
async function seeded() {
  const env = setup()
  for (const m of MEMORIES) await env.store.put(m)
  env.table.seedFile({ dir: join('/in-memory', GLOBAL_DIR), fileName: 'mem_both.md', record: mem('mem_both', { type: 'knowledge', content: '全局这份：日志统一用 JSON 格式。' }) })
  return env
}

/** 对照用的查询，覆盖各说明码、截断、类型筛选、范围、id 直达、零词查询。 */
const QUERIES: SearchArgs[] = [
  { query: '数据库' },
  { query: '数据库 测试' },
  { query: '数据库 测试', match: 'all' },
  { query: '数据库 火星探测' },
  { query: '数据库 测试 火星探测' },
  { query: '数据库 集成测试 PostgreSQL 火星' },
  { query: '部署 火星 木星 土星 天王星' },
  { query: '火星探测', match: 'all' },
  { query: '数据库 火星探测', match: 'all' },
  { query: 'mem_db' },
  { query: 'mem_db_mock' },
  { query: 'mem_both' },
  { query: '' },
  { query: '接口约定' },
  { query: '接口约定', limit: 3 },
  { query: '接口约定', limit: 50 },
  { query: '连接池' },
  { query: '缓存' },
  { query: '缓存', limit: 2 },
  { query: '口令' },
  { query: 'vitest playwright' },
  { query: 'a 1' },
  { query: '数据库', types: ['preference'] },
  { query: '数据库', types: [] },
  { query: '数据库', types: ['decision'] },
  { query: '火星', types: ['preference'] },
  { query: '日志', scope: 'global' },
  { query: '日志', scope: 'workspace' },
  { query: '日志', scope: 'all-visible' },
  { query: '备份' },
  { query: '迁移脚本' },
  { query: '临时账号' },
]

async function goldenOutput(): Promise<string> {
  const { cache, search } = await seeded()
  const blocks: string[] = []
  const run = async (title: string, args: SearchArgs, session?: object) => {
    const result = await search(args, session)
    blocks.push([`### ${title}`, JSON.stringify(result, (key, value) => key === 'content' ? `${[...String(value)].length} 字符` : value, 1), '--- 渲染 ---', renderSearchResult(result)].join('\n'))
  }
  for (const args of QUERIES) await run(JSON.stringify(args), args)
  // 冻结了快照的会话：带入全文的 core 记忆换成一句说明
  const session = {}
  cache.setWorkspacePath(session, WS)
  await cache.assemble(session)
  for (const args of [{ query: '数据库' }, { query: '测试' }, { query: 'mem_db_mock' }] satisfies SearchArgs[]) await run(`冻结快照的会话 ${JSON.stringify(args)}`, args, session)
  return blocks.join('\n\n') + '\n'
}

describe('memory_search 的输出对照', () => {
  it.skipIf(!hasRealJieba)('同一批记忆、同一组查询的结构化结果和渲染文本与基准文件逐字节相同', async () => {
    resetJieba()
    // 基准文件由拆出取候选之前的实现生成；这里的输出变了就是检索行为变了
    const golden = await readFile(new URL('./fixtures/search-output-golden.txt', import.meta.url), 'utf8')
    expect(await goldenOutput()).toBe(golden)
  })
})

describe('取记忆候选', () => {
  it('只取候选不记召回，也不碰会话的快照与召回去重', async () => {
    const { store, cache, recallCount } = await seeded()
    const calls: string[] = []
    cache.markRecalled = async () => { calls.push('markRecalled') }
    cache.injectedCore = () => { calls.push('injectedCore'); return undefined }

    const found = await findMemoryCandidates({ query: '数据库', scope: { kind: 'visible', workspacePath: WS } }, { store, now: () => NOW })
    expect(found.candidates.length).toBeGreaterThan(3)
    expect(calls).toEqual([])
    for (const c of found.candidates) expect(await recallCount(c.record.id)).toBe(0)
  })

  it('候选是读盘原样、排好序的全部命中，没有按条数截断，也没有名次和版本字段', async () => {
    const { store, search } = await seeded()
    const found = await findMemoryCandidates({ query: '接口约定', scope: { kind: 'visible', workspacePath: WS } }, { store, now: () => NOW })
    expect(found.candidates).toHaveLength(14)
    expect(Object.keys(found.candidates[0]).sort()).toEqual(['filePath', 'record', 'tier', 'tokenHits'])
    expect(Object.keys(found).sort()).toEqual(['at', 'candidates', 'diagnostics', 'isDirectHit'])
    // 执行器的前几条就是候选的前几条
    const hits = (await search({ query: '接口约定', limit: 5 })).hits
    expect(hits.map(h => h.id)).toEqual(found.candidates.slice(0, 5).map(c => c.record.id))
    // 密钥在候选里没有遮盖，输出时由执行器遮
    const secret = await findMemoryCandidates({ query: '口令', scope: { kind: 'visible', workspacePath: WS } }, { store, now: () => NOW })
    expect(secret.candidates[0].record.content).toContain('sk-abcdefghijklmnopqrstuvwxyz0123456789ABCD')
    expect((await search({ query: '口令' })).hits[0].content).not.toContain('sk-abcdefghijklmnopqrstuvwxyz0123456789ABCD')
  })

  it('查询恰是某条记忆的 id：那一条在最前，并标出是 id 直达', async () => {
    const { store } = await seeded()
    const scope = { kind: 'visible', workspacePath: WS } as const
    const direct = await findMemoryCandidates({ query: ' mem_db_naming ', scope }, { store, now: () => NOW })
    expect(direct.isDirectHit).toBe(true)
    expect(direct.candidates[0].record.id).toBe('mem_db_naming')
    expect((await findMemoryCandidates({ query: 'mem_db', scope }, { store, now: () => NOW })).isDirectHit).toBe(false)
  })

  it('诊断带齐说明要用的词项、分组、逐词命中条数；类型缺失时带范围内各类型的条数', async () => {
    const { store } = await seeded()
    const scope = { kind: 'visible', workspacePath: WS } as const
    const found = await findMemoryCandidates({ query: '数据库 火星探测', scope }, { store, now: () => NOW })
    expect(found.diagnostics.tokens.length).toBeGreaterThan(0)
    const mentions = (r: MemoryRecord) => [r.name, r.summary, r.content, ...r.tags].some(x => x.includes('数据库'))
    expect(found.diagnostics.termHits.find(t => t.label === '数据库')!.count).toBe(found.candidates.filter(c => mentions(c.record)).length)
    expect(found.diagnostics.termHits.find(t => t.label === '数据库')!.count).toBeGreaterThan(3)
    expect(found.diagnostics.missingTypeCounts).toBeUndefined()

    const missing = await findMemoryCandidates({ query: '数据库', types: ['decision'], scope }, { store, now: () => NOW })
    expect(missing.candidates).toEqual([])
    const counts = new Map(missing.diagnostics.missingTypeCounts!.map(c => [c.type, c.count]))
    expect(counts.get('preference')).toBe(2)
    // 这几类有记忆、只是关键词没对上：不带条数
    const noHit = await findMemoryCandidates({ query: '火星', types: ['preference'], scope }, { store, now: () => NOW })
    expect(noHit.candidates).toEqual([])
    expect(noHit.diagnostics.missingTypeCounts).toBeUndefined()
  })
})

describe('取候选的时刻', () => {
  it.skipIf(!hasRealJieba)('判有效期的时刻在分词之后取，并随候选一起返回', async () => {
    const { store } = await seeded()
    await store.put(mem('mem_due', { type: 'knowledge', content: '火星探测计划本周截止。', validTo: NOW + 1 }))
    let now = NOW
    // 分词要等词典加载：加载期间时间走过了 validTo
    resetJieba({ ...defaultJiebaLoader, importJieba: async () => { now = NOW + 2; return defaultJiebaLoader.importJieba() } })
    try {
      const found = await findMemoryCandidates({ query: '火星探测', scope: { kind: 'visible', workspacePath: WS } }, { store, now: () => now })
      expect(found.at).toBe(NOW + 2)
      expect(found.candidates).toEqual([])
    } finally {
      resetJieba()
    }
  })
})

describe('memory_search 拿到候选之后', () => {
  it('不再读记忆文件：一次检索读一次，类型缺失时为分辨原因多读一次', async () => {
    const { table, store, search } = await seeded()
    const readsOf = async (run: () => Promise<unknown>) => {
      const before = table.reads
      await run()
      return table.reads - before
    }
    const scope = { kind: 'visible', workspacePath: WS } as const
    for (const args of [{ query: '数据库 火星探测' }, { query: '接口约定', limit: 3 }, { query: '数据库', types: ['decision'] }, { query: 'mem_db_mock' }] satisfies SearchArgs[]) {
      const candidatesOnly = await readsOf(() => findMemoryCandidates({ ...args, scope }, { store, now: () => NOW }))
      // 带会话与不带会话两条记账路径，读盘次数都和只取候选一样
      expect(await readsOf(() => search(args))).toBe(candidatesOnly)
      expect(await readsOf(() => search(args, {}))).toBe(candidatesOnly)
      expect(candidatesOnly).toBe(args.types ? 2 : 1)
    }
  })

  it('同一会话并行两次检索，每条记忆只计一次召回', async () => {
    const { search, recallCount } = await seeded()
    const session = {}
    const [a, b] = await Promise.all([search({ query: '数据库' }, session), search({ query: '数据库 测试' }, session)])
    expect(a.hits.length).toBeGreaterThan(0)
    expect(b.hits.length).toBeGreaterThan(0)
    for (const id of new Set([...a.hits, ...b.hits].map(h => h.id))) expect(await recallCount(id)).toBe(1)
    // 另一个会话再搜一次才再计
    await search({ query: '数据库' }, {})
    expect(await recallCount(a.hits[0].id)).toBe(2)
  })

  it('拿不到会话时每次检索都计召回，只计返回的那几条', async () => {
    const { search, recallCount } = await seeded()
    const first = await search({ query: '接口约定', limit: 3 })
    await search({ query: '接口约定', limit: 3 })
    for (const h of first.hits) expect(await recallCount(h.id)).toBe(2)
    expect(await recallCount('mem_api_00')).toBe(0)
  })
})
