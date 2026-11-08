import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import fc from 'fast-check'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore } from '../src/store.ts'
import { FileTable } from '../src/storage/file-table.ts'
import { encodeRecord } from '../src/storage/frontmatter.ts'
import { GLOBAL_DIR, deriveFileId } from '../src/storage/paths.ts'
import { expandQueryTerms, matchScore } from '../src/text.ts'
import {
  executeSearch, renderSearchResult, termHitNote, truncationNote, ALL_NO_HIT_NOTE, ANY_MATCH_HINT, MATCH_ALL_HINT, type SearchToolDeps,
} from '../src/tools/search.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'
import { WEAK_SEARCH_NOTE_CODES, type SearchNoteCode } from '../src/contract-codes.ts'
import type { RecallStats } from '../src/storage/schema.ts'
import { record } from './helpers/record.ts'
import { fakeExec } from './helpers/exec.ts'
import { InMemoryTable } from './helpers/in-memory-table.ts'
import { InMemoryKvTable, InMemoryBatchKvTable } from './helpers/in-memory-kv.ts'

// 多词查询先 AND，零命中回退 OR 并按命中数排序；原文预筛随模式切换。

const registry = buildTypeRegistry({ template: 'coding', customTypes: {} })
const LOW_COVERAGE: SearchNoteCode = 'low-coverage'
const ALL_NO_HIT: SearchNoteCode = 'all-no-hit'

const searchDeps = (store: MemoryStore): SearchToolDeps => ({
  store, registry,
  host: { contextOf: async () => ({ workspacePath: undefined, session: { id: 's', lastSeq: 1 } }) },
})

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'pm-and-or-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
const globalDir = () => join(root, GLOBAL_DIR)
const fileStore = () => new MemoryStore(new FileTable({ root, stats: new InMemoryKvTable<RecallStats>() }), undefined, new InMemoryBatchKvTable())

describe('AND 命中集 ⊆ OR 命中集（性质测试）；零 AND 命中时回退并附说明码', () => {
  // 小词池让记录与查询大量重叠；混入中文（走 bigram）、id 片段与查不到的词
  const word = fc.constantFrom('pnpm', 'deploy', 'hook', '部署流程', '缓存', 'mem_p1', 'zzz')

  it('AND 命中集 ⊆ OR 命中集（性质测试）', async () => {
    await fc.assert(fc.asyncProperty(
      fc.array(fc.array(word, { maxLength: 4 }), { minLength: 1, maxLength: 6 }),
      fc.array(word, { minLength: 1, maxLength: 3 }),
      async (contents, queryWords) => {
        const dir = await mkdtemp(join(root, 'prop-'))
        await mkdir(join(dir, GLOBAL_DIR))
        await Promise.all(contents.map((ws, i) => writeFile(join(dir, GLOBAL_DIR, `r${i}.md`),
          encodeRecord(record({ id: `mem_p${i}`, name: `条目${i}`, summary: '', content: ws.join(' ') || '空' }), {}))))
        const table = new FileTable({ root: dir, stats: new InMemoryKvTable<RecallStats>() })
        const store = new MemoryStore(table, undefined, new InMemoryBatchKvTable())
        const keyword = queryWords.join(' ')
        const ids = async (keywordMatch: 'all' | 'any') =>
          (await store.query({ keyword, keywordMatch, scope: { kind: 'global' } })).map(r => r.id).sort()
        const and = await ids('all')
        const or = await ids('any')
        for (const id of and) expect(or).toContain(id)
        // 两种模式都等于不预筛时按 matchScore 算出的真值：预筛只是超集，不改变匹配结果
        const terms = expandQueryTerms(keyword)
        const all = (await table.readScope([join(dir, GLOBAL_DIR)])).records.map(l => l.record)
        expect(and).toEqual(all.filter(r => matchScore(r, terms) === terms.length).map(r => r.id).sort())
        expect(or).toEqual(all.filter(r => matchScore(r, terms) > 0).map(r => r.id).sort())
        await rm(dir, { recursive: true, force: true })
      },
    ), { numRuns: 30 })
  })

  it('零 AND 命中时回退并附说明码', async () => {
    const store = new MemoryStore(new InMemoryTable(), undefined, new InMemoryBatchKvTable())
    await store.put(record({ id: 'mem_two', content: 'deploy hook 都齐了' }))
    await store.put(record({ id: 'mem_one', content: '只提到 deploy' }))
    await store.put(record({ id: 'mem_none', content: '无关内容' }))

    // 有全命中：全命中排第一、不带说明码；部分命中不再被排除，排在后面（三档一张表）
    const and = await executeSearch({ query: 'deploy hook' }, fakeExec(), searchDeps(store))
    expect(and.hits.map(h => h.id)).toEqual(['mem_two', 'mem_one'])
    expect(and.noteCode).toBeUndefined()

    // 没有全命中：都是部分命中，按相关性排序，带说明码（排第一的缺 rollback，点名但不判弱），渲染里先说明再列结果
    const or = await executeSearch({ query: 'deploy hook rollback' }, fakeExec(), searchDeps(store))
    expect(or.hits.map(h => h.id)).toEqual(['mem_two', 'mem_one'])
    expect(or.noteCode).toBe('or-fallback')
    const text = renderSearchResult(or)
    expect(text.startsWith(or.note!)).toBe(true)
    expect(text).toContain('[mem_two]')
    expect(text).toContain('[mem_one]')

    // OR 也零命中：不说回退，照常说没有匹配
    const none = await executeSearch({ query: 'golang rust' }, fakeExec(), searchDeps(store))
    expect(none.hits).toEqual([])
    expect(none.noteCode).toBeUndefined()
    expect(renderSearchResult(none)).toBe('没有匹配的记忆。')
  })
})

it('排序：命中分 → confidence 降序 → lastConfirmedAt 降序；recallCount 不参与', async () => {
  const store = new MemoryStore(new InMemoryTable(), undefined, new InMemoryBatchKvTable())
  // 回退 OR 时命中分最高者排第一，即使 confidence 最低
  await store.put(record({ id: 'mem_score', content: 'alpha beta', confidence: 0.1, lastConfirmedAt: 1 }))
  await store.put(record({ id: 'mem_lowconf', content: 'alpha', confidence: 0.5, lastConfirmedAt: 900, recallCount: 500 }))
  // confidence 相同：lastConfirmedAt 新者在前；recallCount 再高也不翻转
  await store.put(record({ id: 'mem_old_popular', content: 'alpha', confidence: 0.9, lastConfirmedAt: 100, recallCount: 99 }))
  await store.put(record({ id: 'mem_recent', content: 'alpha', confidence: 0.9, lastConfirmedAt: 200, recallCount: 0 }))

  const { hits, noteCode } = await executeSearch({ query: 'alpha beta gamma' }, fakeExec(), searchDeps(store))
  expect(noteCode).toBe('or-fallback')
  expect(hits.map(h => h.id)).toEqual(['mem_score', 'mem_recent', 'mem_old_popular', 'mem_lowconf'])
})

describe('原文预筛随模式切换：AND 按全部词项、OR 按任一', () => {
  // 预筛对外不可见的唯一痕迹：被预筛跳过的文件不解析，所以坏文件也不进 quarantined
  it('坏文件只在通过预筛时才被解析、进 quarantined', async () => {
    await mkdir(globalDir(), { recursive: true })
    await writeFile(join(globalDir(), 'good.md'), encodeRecord(record({ id: 'mem_good', content: 'alpha beta' }), {}))
    const bad = (text: string) => `---\nname: [${text}\ntype: knowledge\n---\n\n正文\n`   // 未闭合的 flow 序列：YAML 解析失败
    await writeFile(join(globalDir(), 'bad-both.md'), bad('alpha beta'))
    await writeFile(join(globalDir(), 'bad-one.md'), bad('alpha'))
    await writeFile(join(globalDir(), 'bad-none.md'), bad('nothing'))
    const store = fileStore()
    const quarantined = async (filter: Parameters<MemoryStore['queryScope']>[0]) =>
      (await store.queryScope({ scope: { kind: 'global' }, ...filter })).quarantined.map(q => q.path).sort()

    expect(await quarantined({ keyword: 'alpha beta', keywordMatch: 'all' })).toEqual([join(globalDir(), 'bad-both.md')])
    expect(await quarantined({ keyword: 'alpha beta', keywordMatch: 'any' }))
      .toEqual([join(globalDir(), 'bad-both.md'), join(globalDir(), 'bad-one.md')])
    expect(await quarantined({})).toHaveLength(3)   // 无关键词不预筛
    // 缺省是 AND
    expect(await quarantined({ keyword: 'alpha beta' })).toEqual([join(globalDir(), 'bad-both.md')])
  })

  it('缺 id 行的手建文件按派生 id 检索：派生 id 不在原文里，预筛不排除', async () => {
    await mkdir(globalDir(), { recursive: true })
    await writeFile(join(globalDir(), 'hand.md'), '---\nname: 手建\ntype: knowledge\n---\n\n正文 alpha\n')
    const id = deriveFileId(join(GLOBAL_DIR, 'hand.md'))
    const store = fileStore()
    expect((await store.query({ keyword: id, scope: { kind: 'global' } })).map(r => r.id)).toEqual([id])
    expect((await store.query({ keyword: `${id} alpha`, scope: { kind: 'global' } })).map(r => r.id)).toEqual([id])
    expect((await store.query({ keyword: `${id} 缺这个`, keywordMatch: 'any', scope: { kind: 'global' } })).map(r => r.id)).toEqual([id])
  })
})

it('说明码进 contract-codes', async () => {
  // LOW_COVERAGE 以 SearchNoteCode 声明：码不在 contract-codes 的联合里则类型检查不过
  const store = new MemoryStore(new InMemoryTable(), undefined, new InMemoryBatchKvTable())
  await store.put(record({ id: 'mem_a', content: 'alpha' }))
  const result = await executeSearch({ query: 'alpha missing absent' }, fakeExec(), searchDeps(store))
  expect(result.noteCode).toBe(LOW_COVERAGE)
  expect(result.hits.map(h => h.id)).toEqual(['mem_a'])
})

// match: all 在排序之后、截断之前滤掉非全命中档；逐词命中条数仍按全部候选算
describe('匹配模式 match', () => {
  const memStore = async (records: Parameters<typeof record>[0][]) => {
    const store = new MemoryStore(new InMemoryTable(), undefined, new InMemoryBatchKvTable())
    for (const r of records) await store.put(record(r))
    return store
  }
  const run = (store: MemoryStore, query: string, extra: Partial<Parameters<typeof executeSearch>[0]> = {}) =>
    executeSearch({ query, ...extra }, fakeExec(), searchDeps(store))
  const pending = (depth: number) => ({ delegation: { sessionId: `sub-${depth}`, depth, parentSessionId: 'main' } })

  it('all 只返回同时含全部关键词的记忆，不带说明码；不填与填 any 结果相同', async () => {
    const store = await memStore([
      { id: 'mem_full', content: 'alpha beta', lastConfirmedAt: 3 },
      { id: 'mem_part', content: 'alpha', lastConfirmedAt: 2 },
      { id: 'mem_sub', content: 'alphabet', lastConfirmedAt: 1 },
    ])
    const all = await run(store, 'alpha beta', { match: 'all' })
    expect(all.hits.map(h => h.id)).toEqual(['mem_full'])
    expect(all.noteCode).toBeUndefined()
    expect(all.note).toBeUndefined()
    const dflt = await run(store, 'alpha beta')
    expect(dflt.hits.map(h => h.id)).toEqual(['mem_full', 'mem_part', 'mem_sub'])
    expect(await run(store, 'alpha beta', { match: 'any' })).toEqual(dflt)
  })

  it('all 搜空：说明码 all-no-hit，文案接逐词命中条数（按全部候选算）与换 any 的提示；any 同样查询照旧', async () => {
    const store = await memStore([
      { id: 'mem_a', content: 'alpha' },
      { id: 'mem_g', content: 'gamma 与 alpha' },
      { id: 'mem_b', content: 'beta' },
    ])
    const r = await run(store, 'alpha beta', { match: 'all' })
    expect(r.hits).toEqual([])
    expect(r.noteCode).toBe(ALL_NO_HIT)
    expect(r.note).toBe([ALL_NO_HIT_NOTE, termHitNote([{ label: 'alpha', count: 2 }, { label: 'beta', count: 1 }]), ANY_MATCH_HINT].join('\n'))
    expect(r.note).toContain('各关键词命中的记忆条数：alpha 2、beta 1。')
    expect(r.moreNote).toBeUndefined()
    // 判弱看的是 any 下的排序结果，评估脚本按这组码数「命中弱」：all 搜空不算在内
    expect(WEAK_SEARCH_NOTE_CODES).not.toContain(r.noteCode)
    // 渲染出说明而不是「没有匹配的记忆」
    expect(renderSearchResult(r)).toBe(r.note)
    expect((await run(store, 'alpha beta')).noteCode).toBe('or-fallback')

    // 范围内一条都没命中：换 any 也是空，all 不出 all-no-hit，和 any 一样是不带码的空结果
    const anyNone = await run(store, 'zeta omega')
    expect(anyNone.hits).toEqual([])
    expect(anyNone.noteCode).toBeUndefined()
    expect(renderSearchResult(anyNone)).toBe('没有匹配的记忆。')
    expect(await run(store, 'zeta omega', { match: 'all' })).toEqual(anyNone)
  })

  it('id 直达在过滤之前置顶且不滤，两种模式结果相同', async () => {
    const store = await memStore([
      { id: 'mem_target', content: '正文与查询无关' },
      { id: 'mem_mention', content: 'mem_target 被提到' },
    ])
    const any = await run(store, 'mem_target')
    expect(any.hits.map(h => h.id)).toEqual(['mem_target', 'mem_mention'])
    expect(await run(store, 'mem_target', { match: 'all' })).toEqual(any)

    const alone = await memStore([{ id: 'mem_only', content: '正文与查询无关' }])
    const r = await run(alone, 'mem_only', { match: 'all' })
    expect(r.hits.map(h => h.id)).toEqual(['mem_only'])
    expect(r.noteCode).toBeUndefined()
  })

  it('all 模式下待确认记录仍排在主档之后，limit 照常生效', async () => {
    const store = await memStore([
      { id: 'mem_pend', content: '部署流程 回滚 部署流程', confidence: 0.9, ...pending(1) },
      { id: 'mem_main', content: '部署流程 回滚', confidence: 0.3 },
      { id: 'mem_part', content: '部署流程', confidence: 0.9 },
    ])
    expect((await run(store, '部署流程 回滚', { match: 'all' })).hits.map(h => h.id)).toEqual(['mem_main', 'mem_pend'])
    expect((await run(store, '部署流程 回滚', { match: 'all', limit: 1 })).hits.map(h => h.id)).toEqual(['mem_main'])
  })

  it('截断说明：any 且全部结果里有非全命中才提 all；全是全命中或 all 模式不提', async () => {
    const mixed = await memStore([
      { id: 'mem_f1', content: 'alpha beta' },
      { id: 'mem_f2', content: 'alpha beta' },
      { id: 'mem_p', content: 'alpha' },
    ])
    const anyMixed = await run(mixed, 'alpha beta', { limit: 1 })
    expect(anyMixed.moreNote).toBe(`${truncationNote(3, 1, false)}${MATCH_ALL_HINT}`)
    expect(anyMixed.moreNote!.endsWith(MATCH_ALL_HINT)).toBe(true)
    // all 模式：只数全命中，不提 all
    expect((await run(mixed, 'alpha beta', { match: 'all', limit: 1 })).moreNote).toBe(truncationNote(2, 1, false))

    const allFull = await memStore([
      { id: 'mem_f1', content: 'alpha beta' },
      { id: 'mem_f2', content: 'alpha beta' },
    ])
    expect((await run(allFull, 'alpha beta', { limit: 1 })).moreNote).toBe(truncationNote(2, 1, false))
    expect((await run(allFull, 'alpha beta', { match: 'all', limit: 1 })).moreNote).toBe(truncationNote(2, 1, false))
  })

  it('查询没有可打分的词（留空、纯数字、单字母）时 match 不起作用，两种模式结果相同，截断说明不提 all', async () => {
    const store = await memStore([
      { id: 'mem_1', content: '发布于 2024 年 x 号', lastConfirmedAt: 2 },
      { id: 'mem_2', content: '2024 x 版本', lastConfirmedAt: 1 },
    ])
    for (const query of ['', '2024', 'x']) {
      const any = await run(store, query, { limit: 1 })
      expect(any.hits).toHaveLength(1)
      expect(any.moreNote).toBe(truncationNote(2, 1, false))
      expect(await run(store, query, { match: 'all', limit: 1 })).toEqual(any)
    }
    // 没命中时也一样：不出 all-no-hit，是不带码的空结果
    for (const query of ['9999', 'q']) {
      const any = await run(store, query)
      expect(any.hits).toEqual([])
      expect(any.noteCode).toBeUndefined()
      expect(await run(store, query, { match: 'all' })).toEqual(any)
    }
  })
})
