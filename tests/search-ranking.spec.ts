import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import fc from 'fast-check'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore, InMemoryTable } from '../src/store.ts'
import type { MemoryTable, ScopeReadOptions } from '../src/storage/table.ts'
import { FileTable } from '../src/storage/file-table.ts'
import { GLOBAL_DIR } from '../src/storage/paths.ts'
import { InMemoryKvTable } from '../src/kv-table.ts'
import { expandQueryTerms, matchScore } from '../src/text.ts'
import { createTokenizer } from '../src/search/tokenizer.ts'
import { RANKING_FIELDS } from '../src/search/ranking.ts'
import { executeSearch, OR_FALLBACK_NOTE, SUBSTRING_FALLBACK_NOTE, type SearchToolDeps } from '../src/tools/search.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'
import type { SearchNoteCode } from '../src/contract-codes.ts'
import type { MemoryRecord } from '../src/record-schema.ts'
import type { RecallStats } from '../src/storage/schema.ts'
import { record } from './helpers/record.ts'
import { fakeExec } from './helpers/exec.ts'

// memory_search 内核换成分词 + BM25 + 字段加权，三档一张表；跑在 FileTable 临时目录上，与生产一致。

const registry = buildTypeRegistry({ template: 'coding', customTypes: {} })
const OR_FALLBACK: SearchNoteCode = 'or-fallback'
const SUBSTRING_FALLBACK: SearchNoteCode = 'substring-fallback'
const NO_WORKSPACE: SearchNoteCode = 'no-workspace'
const tokenize = createTokenizer()

const deps = (store: MemoryStore, workspacePath?: string): SearchToolDeps => ({
  store, registry,
  resolveContext: async () => ({ workspacePath, session: { id: 's', lastSeq: 1 } }),
})

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'pm-ranking-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

const fileTable = (dir = root) => new FileTable({ root: dir, stats: new InMemoryKvTable<RecallStats>() })

async function seeded(records: MemoryRecord[], table: MemoryTable = fileTable()): Promise<MemoryStore> {
  const store = new MemoryStore(table)
  for (const r of records) await store.put(r)
  return store
}

const search = (store: MemoryStore, query: string, extra: Partial<Parameters<typeof executeSearch>[0]> = {}) =>
  executeSearch({ query, ...extra }, fakeExec(), deps(store))
const ids = async (store: MemoryStore, query: string, extra: Partial<Parameters<typeof executeSearch>[0]> = {}) =>
  (await search(store, query, extra)).hits.map(h => h.id)

describe('三档一张表', () => {
  it('全命中 → 部分命中 → 只有子串命中；部分命中不被排除，全不命中不出现', async () => {
    const store = await seeded([
      record({ id: 'mem_sub', name: '子串条目', content: 'deployment 流水线' }),        // deployment 含 deploy，token 不等
      record({ id: 'mem_none', name: '无关条目', content: '与查询完全无关' }),
      record({ id: 'mem_partial', name: '部分条目', content: '只提到 deploy' }),
      record({ id: 'mem_full', name: '全命中条目', content: 'deploy 之后跑 hook 再 rollback' }),
    ])
    expect(await ids(store, 'deploy hook rollback')).toEqual(['mem_full', 'mem_partial', 'mem_sub'])
  })

  it('子串档内按旧命中词数降序，再按 confidence、lastConfirmedAt', async () => {
    const store = await seeded([
      record({ id: 'mem_one_low', content: 'deployment', confidence: 0.5, lastConfirmedAt: 1 }),
      record({ id: 'mem_one_high', content: 'deployment', confidence: 0.9, lastConfirmedAt: 1 }),
      record({ id: 'mem_one_recent', content: 'deployment', confidence: 0.9, lastConfirmedAt: 2 }),
      record({ id: 'mem_two', content: 'deployment hooks', confidence: 0.1, lastConfirmedAt: 1 }),
    ])
    expect(await ids(store, 'deploy hook')).toEqual(['mem_two', 'mem_one_recent', 'mem_one_high', 'mem_one_low'])
  })
})

describe('字段权重', () => {
  it('name 命中优先于仅 content 命中', async () => {
    const store = await seeded([
      record({ id: 'mem_content', name: '普通条目', summary: '普通摘要', content: 'rollback rollback rollback 的正文' }),
      record({ id: 'mem_name', name: 'rollback 流程', summary: '普通摘要', content: '正文与查询无关' }),
    ])
    expect(await ids(store, 'rollback')).toEqual(['mem_name', 'mem_content'])
  })

  it('name 平淡但 content 大段命中（全部词都在）不被 name 碰巧含一个词、内容不相干的记录压下去', async () => {
    const store = await seeded([
      record({ id: 'mem_name_only', name: 'deploy 脚本位置', summary: '脚本放哪', content: '放在 scripts 目录下，与其他事无关' }),
      record({
        id: 'mem_body', name: '上线说明', summary: '上线前后要做的事',
        content: 'deploy 之前先跑 hook；deploy 失败就 rollback，rollback 之后再查 hook 日志；deploy 成功也要看 hook 输出',
      }),
    ])
    expect(await ids(store, 'deploy hook rollback')).toEqual(['mem_body', 'mem_name_only'])
  })

  it('同档内：summary 与 content 都命中的记录胜过只在 name 含词的记录（权重保守）', async () => {
    const store = await seeded([
      record({ id: 'mem_name_only', name: 'deploy 脚本', summary: '脚本位置', content: '放在 scripts 目录下' }),
      record({
        id: 'mem_body', name: '部署说明', summary: 'deploy 流程与注意事项',
        content: 'deploy 分三步：先 deploy 到预发，再 deploy 到灰度，最后 deploy 到全量；每一步都要确认健康检查通过',
      }),
    ])
    expect(await ids(store, 'deploy')).toEqual(['mem_body', 'mem_name_only'])
  })
})

describe('今天靠子串能命中的查询升级后仍命中', () => {
  it('「scope」命中 readScope（驼峰子词）、「memory source」命中 memory_source（下划线子词），都不走子串档', async () => {
    const store = await seeded([
      record({ id: 'mem_camel', content: 'readScope 一次读一个范围' }),
      record({ id: 'mem_snake', content: 'memory_source 工具查出处' }),
    ])
    const scope = await search(store, 'scope')
    expect(scope.hits.map(h => h.id)).toEqual(['mem_camel'])
    expect(scope.noteCode).toBeUndefined()
    const source = await search(store, 'memory source')
    expect(source.hits.map(h => h.id)).toEqual(['mem_snake'])
    expect(source.noteCode).toBeUndefined()
  })

  it('「memor」命中 memory、id 前缀命中整 id：走子串档并说明', async () => {
    const store = await seeded([
      record({ id: 'mem_memory', content: 'memory 插件' }),
      record({ id: 'mem_abc123', content: '正文里没有 id' }),
    ])
    const partial = await search(store, 'memor')
    expect(partial.hits.map(h => h.id)).toEqual(['mem_memory'])
    expect(partial.noteCode).toBe(SUBSTRING_FALLBACK)
    expect(partial.note).toBe(SUBSTRING_FALLBACK_NOTE)
    expect((await search(store, 'mem_abc')).hits.map(h => h.id)).toEqual(['mem_abc123'])
  })
})

describe('id 直达与零 token', () => {
  it('查询 trim 后恰等于某条可见记忆的 id → 该条第一，其余照常；说明码仍按档位算', async () => {
    const store = await seeded([
      record({ id: 'mem_target', name: '目标', content: '正文里没有自己的 id', confidence: 0.1 }),
      record({ id: 'mem_mention', name: '提到者', content: 'mem_target 被提到，mem_target 很重要', confidence: 0.9 }),
    ])
    const r = await search(store, '  mem_target ')
    expect(r.hits.map(h => h.id)).toEqual(['mem_target', 'mem_mention'])
    expect(r.noteCode).toBeUndefined()   // 列表里有全命中记录（mem_mention）
    // 只有直达那条：它在子串档，说明码照常附上
    const only = await search(await seeded([record({ id: 'mem_solo', content: '正文' })], fileTable(await mkdtemp(join(root, 'solo-')))), 'mem_solo')
    expect(only.hits.map(h => h.id)).toEqual(['mem_solo'])
    expect(only.noteCode).toBe(SUBSTRING_FALLBACK)
  })

  it('零 token 查询：不做关键词过滤，按 confidence、lastConfirmedAt 排并受 limit', async () => {
    const store = await seeded([
      record({ id: 'mem_low', confidence: 0.3, lastConfirmedAt: 9 }),
      record({ id: 'mem_old', confidence: 0.9, lastConfirmedAt: 1 }),
      record({ id: 'mem_new', confidence: 0.9, lastConfirmedAt: 2 }),
    ])
    for (const q of ['', '   ']) {
      const r = await search(store, q)
      expect(r.hits.map(h => h.id)).toEqual(['mem_new', 'mem_old', 'mem_low'])
      expect(r.noteCode).toBeUndefined()
    }
    expect(await ids(store, '', { limit: 2 })).toEqual(['mem_new', 'mem_old'])
  })
})

describe('说明码：三种触发，互斥、substring 优先', () => {
  it('有全命中 → 无码；只有部分命中（或部分 + 子串）→ or-fallback；只有子串 → substring-fallback；空 → 无码', async () => {
    // lastConfirmedAt 递减：全部落在子串档时三条平分，靠它定顺序
    const store = await seeded([
      record({ id: 'mem_full', content: 'alpha beta', lastConfirmedAt: 3 }),
      record({ id: 'mem_part', content: 'alpha', lastConfirmedAt: 2 }),
      record({ id: 'mem_sub', content: 'alphabet', lastConfirmedAt: 1 }),
    ])
    const full = await search(store, 'alpha beta')
    expect(full.hits.map(h => h.id)).toEqual(['mem_full', 'mem_part', 'mem_sub'])
    expect(full.noteCode).toBeUndefined()
    expect(full.note).toBeUndefined()

    const partial = await search(store, 'alpha beta gamma')
    expect(partial.hits.map(h => h.id)).toEqual(['mem_full', 'mem_part', 'mem_sub'])
    expect(partial.noteCode).toBe(OR_FALLBACK)
    expect(partial.note).toBe(OR_FALLBACK_NOTE)
    expect(OR_FALLBACK_NOTE).toBe('没有同时命中全部关键词的记忆，以下按相关性排序。')

    const sub = await search(store, 'alph')
    expect(sub.hits.map(h => h.id)).toEqual(['mem_full', 'mem_part', 'mem_sub'])
    expect(sub.noteCode).toBe(SUBSTRING_FALLBACK)

    const none = await search(store, 'zeta')
    expect(none.hits).toEqual([])
    expect(none.noteCode).toBeUndefined()
  })

  it('说明码看的是返回列表：limit 截掉子串档后仍按留下的档位算', async () => {
    const store = await seeded([
      record({ id: 'mem_part', content: 'alpha' }),
      record({ id: 'mem_sub', content: 'alphabet' }),
    ])
    expect((await search(store, 'alpha beta', { limit: 1 })).noteCode).toBe(OR_FALLBACK)
  })
})

describe('不变的行为', () => {
  it('validTo 已过期的不进结果；types、limit 上限 50 照旧', async () => {
    const now = Date.now()
    const store = await seeded([
      record({ id: 'mem_dead', content: 'magicword 过期', validTo: now - 1000 }),
      record({ id: 'mem_ok', content: 'magicword 有效' }),
      record({ id: 'mem_pref', type: 'preference', content: 'magicword 偏好' }),
    ])
    expect((await ids(store, 'magicword')).sort()).toEqual(['mem_ok', 'mem_pref'])
    expect(await ids(store, 'magicword', { types: ['preference'] })).toEqual(['mem_pref'])
    const many = await seeded(Array.from({ length: 60 }, (_, i) => record({ id: `mem_${i}`, name: `条目${i}`, content: 'magicword' })))
    expect(await ids(many, 'magicword', { limit: 100 })).toHaveLength(50)
  })

  it('scope=workspace 无工作目录：空结果 + no-workspace 说明', async () => {
    const store = await seeded([record({ id: 'mem_g', content: 'magicword' })])
    const r = await executeSearch({ query: 'magicword', scope: 'workspace' }, fakeExec(), deps(store, undefined))
    expect(r.hits).toEqual([])
    expect(r.noteCode).toBe(NO_WORKSPACE)
  })
})

// ---- 性质测试 ----

// 记录侧词池：整词、驼峰、下划线标识符、CJK 短语；查询侧多几个只命中局部的子词 / 子串与查不到的词
const recordWord = fc.constantFrom('pnpm', 'deploy', 'readScope', 'memory_source', '部署流程', '缓存失效', 'hook', 'zzz')
const queryWord = fc.oneof(recordWord, fc.constantFrom('scope', 'memory', 'memor', '部署', '失效流程', 'mem_p1', '查不到'))
const corpus = fc.array(fc.record({
  name: fc.array(recordWord, { minLength: 1, maxLength: 2 }).map(ws => ws.join(' ')),
  summary: fc.array(recordWord, { maxLength: 2 }).map(ws => ws.join(' ')),
  content: fc.array(recordWord, { maxLength: 4 }).map(ws => ws.join(' ') || '空'),
  tags: fc.array(recordWord, { maxLength: 2 }),
}), { minLength: 1, maxLength: 8 })
const query = fc.array(queryWord, { minLength: 1, maxLength: 3 }).map(ws => ws.join(' '))

/** lastConfirmedAt 各不相同：完全平局时排序才与读取顺序无关，两次运行才可比。 */
const toRecords = (rows: { name: string; summary: string; content: string; tags: string[] }[]) =>
  rows.map((row, i) => record({ id: `mem_p${i}`, ...row, lastConfirmedAt: i + 1 }))

/** 包一层 MemoryTable：readScope 丢掉预筛词项（= 不预筛），其余原样转发；同时记下原表收到的预筛词项。 */
function tapTable(t: MemoryTable, mode: 'strip' | 'spy', seen: ScopeReadOptions[]): MemoryTable {
  return {
    globalDir: t.globalDir,
    workspaceDirs: p => t.workspaceDirs(p),
    readScope: (dirs, opts = {}) => {
      seen.push(opts)
      if (mode === 'spy') return t.readScope(dirs, opts)
      const { prefilterTerms: _t, prefilterMatch: _m, ...rest } = opts
      return t.readScope(dirs, rest)
    },
    locate: (id, h) => t.locate(id, h),
    listWorkspaceDirs: () => t.listWorkspaceDirs(),
    create: r => t.create(r),
    put: (k, v, h) => t.put(k, v, h),
    update: (k, f, h) => t.update(k, f, h),
    delete: (k, h) => t.delete(k, h),
    maintain: d => t.maintain(d),
  }
}

describe('性质测试', () => {
  it('预筛开关不改变三档成员与顺序', async () => {
    await fc.assert(fc.asyncProperty(corpus, query, async (rows, q) => {
      const dir = await mkdtemp(join(root, 'prop-'))
      const table = fileTable(dir)
      await seeded(toRecords(rows), table)
      const withSeen: ScopeReadOptions[] = []
      const withoutSeen: ScopeReadOptions[] = []
      const withPrefilter = new MemoryStore(tapTable(table, 'spy', withSeen))
      const withoutPrefilter = new MemoryStore(tapTable(table, 'strip', withoutSeen))
      const a = await search(withPrefilter, q, { limit: 50 })
      const b = await search(withoutPrefilter, q, { limit: 50 })
      expect(a.hits.map(h => h.id)).toEqual(b.hits.map(h => h.id))
      expect(a.noteCode).toBe(b.noteCode)
      // 对比有意义：正常路径确实把预筛词项传给了读取层
      expect(withSeen.some(o => (o.prefilterTerms?.length ?? 0) > 0 && o.prefilterMatch === 'any')).toBe(true)
      await rm(dir, { recursive: true, force: true })
    }), { numRuns: 40 })
  })

  it('子串档成员 = token 零命中且旧 matchScore > 0 的记录，且都排在 token 命中记录之后', async () => {
    await fc.assert(fc.asyncProperty(corpus, query, async (rows, q) => {
      const dir = await mkdtemp(join(root, 'prop-'))
      const table = fileTable(dir)
      const store = await seeded(toRecords(rows), table)
      const all = (await table.readScope([join(dir, GLOBAL_DIR)])).records.map(l => l.record)
      const tokens = [...new Set(tokenize(q))]
      const legacy = expandQueryTerms(q)
      const tokenHit = (r: MemoryRecord) => tokens.some(tok =>
        RANKING_FIELDS.some(f => tokenize(f === 'tags' ? r.tags.join(' ') : r[f]).includes(tok)))
      const tokenHitIds = all.filter(tokenHit).map(r => r.id)
      const substringIds = all.filter(r => !tokenHit(r) && matchScore(r, legacy) > 0).map(r => r.id)

      const hits = await ids(store, q, { limit: 50 })
      expect([...hits].sort()).toEqual([...tokenHitIds, ...substringIds].sort())
      const firstSubstring = hits.findIndex(id => substringIds.includes(id))
      const lastTokenHit = hits.length - 1 - [...hits].reverse().findIndex(id => tokenHitIds.includes(id))
      if (firstSubstring !== -1 && tokenHitIds.length > 0) expect(lastTokenHit).toBeLessThan(firstSubstring)
      await rm(dir, { recursive: true, force: true })
    }), { numRuns: 40 })
  })

  it('FileTable 与 InMemoryTable 对同一组记录给出同一排序与说明码', async () => {
    await fc.assert(fc.asyncProperty(corpus, query, async (rows, q) => {
      const dir = await mkdtemp(join(root, 'prop-'))
      const onDisk = await seeded(toRecords(rows), fileTable(dir))
      const inMemory = await seeded(toRecords(rows), new InMemoryTable())
      const a = await search(onDisk, q, { limit: 50 })
      const b = await search(inMemory, q, { limit: 50 })
      expect(a.hits.map(h => h.id)).toEqual(b.hits.map(h => h.id))
      expect(a.noteCode).toBe(b.noteCode)
      await rm(dir, { recursive: true, force: true })
    }), { numRuns: 40 })
  })
})
