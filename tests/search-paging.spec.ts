import { describe, expect, it } from 'vitest'
import { executeSearch, type SearchArgs, type SearchContext, type SearchToolDeps } from '../src/tools/search.ts'
import { MemoryStore } from '../src/store.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'
import type { RecallStats } from '../src/storage/schema.ts'
import { InMemoryTable } from './helpers/in-memory-table.ts'
import { InMemoryBatchKvTable } from './helpers/in-memory-kv.ts'
import { fakeExec } from './helpers/exec.ts'
import { record } from './helpers/record.ts'

// memory_search 的关键词检索和按类型列出用 offset 翻页：结果给下一页的 offset，翻到底每条恰好一次；limit 只收正整数，原话不翻页。

function setup(count: number) {
  const store = new MemoryStore(new InMemoryTable(), undefined, new InMemoryBatchKvTable<RecallStats>())
  const deps: SearchToolDeps = {
    store, registry: buildTypeRegistry({ template: 'coding', customTypes: {} }),
    host: { contextOf: async (): Promise<SearchContext> => ({ workspacePath: undefined, session: { id: 's', lastSeq: 1 } }) },
  }
  const seeded = (async () => {
    // 查询留空时按 lastConfirmedAt 降序排，存入顺序就是排名
    for (let i = 0; i < count; i++) await store.put(record({ id: `mem_p${String(i).padStart(2, '0')}`, content: `部署 第 ${i} 条`, lastConfirmedAt: 1000 - i }))
  })()
  return { search: async (args: SearchArgs) => { await seeded; return executeSearch(args, fakeExec(), deps) } }
}
const nextOffsetOf = (moreNote: string | undefined) => {
  const m = moreNote?.match(/下一页用 offset: (\d+)/)
  return m ? Number(m[1]) : undefined
}

describe('关键词检索和按类型列出翻页', () => {
  it.each([
    ['关键词检索', { query: '部署' }],
    ['只填 types', { query: '', types: ['knowledge'] }],
  ] satisfies Array<[string, SearchArgs]>)('%s：按结果给的 offset 一页页翻到底，每条恰好一次，最后一页不给下一页', async (_label, base) => {
    const { search } = setup(7)
    const seen: string[] = []
    const notes: Array<string | undefined> = []
    let offset: number | undefined = 0
    while (offset !== undefined) {
      const r = await search({ ...base, limit: 3, ...(offset > 0 ? { offset } : {}) })
      seen.push(...r.hits.map(h => h.id))
      notes.push(r.moreNote)
      offset = nextOffsetOf(r.moreNote)
    }
    expect(seen).toEqual(['mem_p00', 'mem_p01', 'mem_p02', 'mem_p03', 'mem_p04', 'mem_p05', 'mem_p06'])
    expect(notes).toEqual([
      '共命中 7 条，这次列出第 1–3 条。下一页用 offset: 3，想缩小范围可以换更具体的关键词。',
      '共命中 7 条，这次列出第 4–6 条。下一页用 offset: 6，想缩小范围可以换更具体的关键词。',
      '共命中 7 条，这次列出第 7 条。',
    ])
  })

  it('第一页就全列完：没有翻页说明', async () => {
    const { search } = setup(3)
    expect((await search({ query: '部署' })).moreNote).toBeUndefined()
  })

  it('offset 到了末尾：零条，说后面没有了，不给下一页', async () => {
    const { search } = setup(3)
    const r = await search({ query: '部署', offset: 3 })
    expect(r.hits).toEqual([])
    expect(r.moreNote).toBe('共命中 3 条，offset 3 之后没有了。')
  })

  it.each([[0], [-1], [1.5]])('limit 是 %s：参数错误', async limit => {
    const { search } = setup(1)
    expect(await search({ query: '部署', limit })).toMatchObject({ noteCode: 'invalid-args', note: 'limit 请填写正整数，最大 50。' })
  })

  it('source: dialogue 配 offset：参数错误，原话不翻页', async () => {
    const { search } = setup(1)
    expect(await search({ query: '部署', source: 'dialogue', offset: 1 })).toMatchObject({
      noteCode: 'invalid-args', note: '原话检索不翻页，请去掉 offset；要看更多原话，换更具体的关键词再搜。',
    })
  })

  it('设置是只查记忆、传 source: both 翻第二页：照常说明这次没查原话，不说翻页只翻记忆', async () => {
    const store = new MemoryStore(new InMemoryTable(), undefined, new InMemoryBatchKvTable<RecallStats>())
    for (let i = 0; i < 4; i++) await store.put(record({ id: `mem_m${i}`, content: `部署 第 ${i} 条`, lastConfirmedAt: 1000 - i }))
    const deps: SearchToolDeps = {
      store, registry: buildTypeRegistry({ template: 'coding', customTypes: {} }), searchSource: () => 'memory',
      host: { contextOf: async (): Promise<SearchContext> => ({ workspacePath: undefined, session: { id: 's', lastSeq: 1 } }) },
    }
    const r = await executeSearch({ query: '部署', source: 'both', limit: 2, offset: 2 }, fakeExec(), deps)
    expect(r.hits.map(h => h.id)).toEqual(['mem_m2', 'mem_m3'])
    expect(r).toMatchObject({ pathNote: '当前设置是只查记忆，这次没有查过往对话的原话。', moreNote: '共命中 4 条，这次列出第 3–4 条。' })
  })

  it('设置是两者都查、只填 types 翻第二页：第一页本来就不查原话，不说翻页只翻记忆', async () => {
    const store = new MemoryStore(new InMemoryTable(), undefined, new InMemoryBatchKvTable<RecallStats>())
    for (let i = 0; i < 4; i++) await store.put(record({ id: `mem_t${i}`, content: `部署 第 ${i} 条`, lastConfirmedAt: 1000 - i }))
    const deps: SearchToolDeps = {
      store, registry: buildTypeRegistry({ template: 'coding', customTypes: {} }), searchSource: () => 'both',
      host: { contextOf: async (): Promise<SearchContext> => ({ workspacePath: undefined, session: { id: 's', lastSeq: 1 } }) },
    }
    const r = await executeSearch({ query: '', types: ['knowledge'], limit: 2, offset: 2 }, fakeExec(), deps)
    expect(r.hits.map(h => h.id)).toEqual(['mem_t2', 'mem_t3'])
    expect(r.moreNote).toBe('共命中 4 条，这次列出第 3–4 条。')
  })

  it('设置是只查原话、没传 source 时配 offset：同样拒绝', async () => {
    const store = new MemoryStore(new InMemoryTable(), undefined, new InMemoryBatchKvTable<RecallStats>())
    const deps: SearchToolDeps = {
      store, registry: buildTypeRegistry({ template: 'coding', customTypes: {} }), searchSource: () => 'dialogue',
      host: { contextOf: async (): Promise<SearchContext> => ({ workspacePath: undefined, session: { id: 's', lastSeq: 1 } }) },
    }
    expect(await executeSearch({ query: '部署', offset: 1 }, fakeExec(), deps)).toMatchObject({ noteCode: 'invalid-args' })
  })
})
