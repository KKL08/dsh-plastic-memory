import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import fc from 'fast-check'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore, InMemoryTable } from '../src/store.ts'
import { FileTable } from '../src/storage/file-table.ts'
import { encodeRecord } from '../src/storage/frontmatter.ts'
import { GLOBAL_DIR, deriveFileId } from '../src/storage/paths.ts'
import { InMemoryKvTable } from '../src/kv-table.ts'
import { expandQueryTerms, matchScore } from '../src/text.ts'
import { executeSearch, renderSearchResult, type SearchToolDeps } from '../src/tools/search.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'
import type { SearchNoteCode } from '../src/contract-codes.ts'
import type { RecallStats } from '../src/storage/schema.ts'
import { record } from './helpers/record.ts'
import { fakeExec } from './helpers/exec.ts'

// 票 16（设计稿 §11）：多词查询先 AND，零命中回退 OR 并按命中数排序；原文预筛随模式切换。

const registry = buildTypeRegistry({ template: 'coding', customTypes: {} })
const OR_FALLBACK: SearchNoteCode = 'or-fallback'

const searchDeps = (store: MemoryStore): SearchToolDeps => ({
  store, registry,
  resolveContext: async () => ({ workspacePath: undefined, session: { id: 's', lastSeq: 1 } }),
})

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'pm-and-or-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
const globalDir = () => join(root, GLOBAL_DIR)
const fileStore = () => new MemoryStore(new FileTable({ root, stats: new InMemoryKvTable<RecallStats>() }))

describe('AND 命中集 ⊆ OR 命中集（性质测试）；零 AND 命中时回退并附 or-fallback 说明码', () => {
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
        const store = new MemoryStore(table)
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

  it('零 AND 命中时回退并附 or-fallback 说明码', async () => {
    const store = new MemoryStore(new InMemoryTable())
    await store.put(record({ id: 'mem_two', content: 'deploy hook 都齐了' }))
    await store.put(record({ id: 'mem_one', content: '只提到 deploy' }))
    await store.put(record({ id: 'mem_none', content: '无关内容' }))

    // 有全命中：全命中排第一、不带说明码；部分命中不再被排除，排在后面（三档一张表）
    const and = await executeSearch({ query: 'deploy hook' }, fakeExec(), searchDeps(store))
    expect(and.hits.map(h => h.id)).toEqual(['mem_two', 'mem_one'])
    expect(and.noteCode).toBeUndefined()

    // 没有全命中：都是部分命中，按相关性排序，带说明码，渲染里先说明再列结果
    const or = await executeSearch({ query: 'deploy hook rollback' }, fakeExec(), searchDeps(store))
    expect(or.hits.map(h => h.id)).toEqual(['mem_two', 'mem_one'])
    expect(or.noteCode).toBe(OR_FALLBACK)
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
  const store = new MemoryStore(new InMemoryTable())
  // 回退 OR 时命中分最高者排第一，即使 confidence 最低
  await store.put(record({ id: 'mem_score', content: 'alpha beta', confidence: 0.1, lastConfirmedAt: 1 }))
  await store.put(record({ id: 'mem_lowconf', content: 'alpha', confidence: 0.5, lastConfirmedAt: 900, recallCount: 500 }))
  // confidence 相同：lastConfirmedAt 新者在前；recallCount 再高也不翻转
  await store.put(record({ id: 'mem_old_popular', content: 'alpha', confidence: 0.9, lastConfirmedAt: 100, recallCount: 99 }))
  await store.put(record({ id: 'mem_recent', content: 'alpha', confidence: 0.9, lastConfirmedAt: 200, recallCount: 0 }))

  const { hits, noteCode } = await executeSearch({ query: 'alpha beta gamma' }, fakeExec(), searchDeps(store))
  expect(noteCode).toBe(OR_FALLBACK)
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
  // OR_FALLBACK 以 SearchNoteCode 声明：码不在 contract-codes 的联合里则类型检查不过
  const store = new MemoryStore(new InMemoryTable())
  await store.put(record({ id: 'mem_a', content: 'alpha' }))
  const result = await executeSearch({ query: 'alpha missing' }, fakeExec(), searchDeps(store))
  expect(result.noteCode).toBe(OR_FALLBACK)
  expect(result.hits.map(h => h.id)).toEqual(['mem_a'])
})
