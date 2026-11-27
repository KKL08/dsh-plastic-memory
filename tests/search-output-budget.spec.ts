import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { readPrunerThreshold, searchBudgetOf } from '../src/tools/search-budget.ts'
import { executeSearch, renderSearchResult, IN_SNAPSHOT_NOTE, type SearchArgs, type SearchContext, type SearchHit, type SearchToolDeps } from '../src/tools/search.ts'
import { createSearchTool } from '../src/tools/search-tool.ts'
import { SnapshotCache } from '../src/runtime.ts'
import { MemoryStore } from '../src/store.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'
import type { MemoryRecord } from '../src/record-schema.ts'
import type { RecallStats } from '../src/storage/schema.ts'
import { InMemoryTable } from './helpers/in-memory-table.ts'
import { InMemoryBatchKvTable } from './helpers/in-memory-kv.ts'
import { fakeExec } from './helpers/exec.ts'
import { record } from './helpers/record.ts'
import { countSearchHits } from '../client/chat/tool-summary.ts'

// 检索输出预算：跟随宿主工具结果裁剪的阈值（码点），留 5% 余量、下限 3000；没有裁剪服务或读不出阈值时 8000。

const pruner = (thresholdChars: unknown) => ({ config: { thresholdChars } })
const budgetOf = (read: () => unknown) => searchBudgetOf(readPrunerThreshold(read))

describe('预算跟随宿主裁剪阈值', () => {
  it.each([
    ['阈值 8192', 7782, 8192],
    ['阈值 3000：到下限', 3000, 3000],
    ['阈值 6316：0.95 倍正好 6000', 6000, 6316],
    ['阈值 6315：向下取整到 5999', 5999, 6315],
    ['阈值 2000：低于下限仍取 3000', 3000, 2000],
  ])('%s → 预算 %s', (_label, budget, threshold) => {
    expect(budgetOf(() => pruner(threshold))).toBe(budget)
  })

  it('没有裁剪服务 → 8000，三态记为「没有」', () => {
    expect(readPrunerThreshold(() => undefined)).toEqual({ kind: 'none' })
    expect(budgetOf(() => undefined)).toBe(8000)
  })

  it('取服务抛错 → 8000，三态记为「未知」，检索不因此失败', () => {
    const read = () => { throw new Error('服务重启中') }
    expect(readPrunerThreshold(read)).toEqual({ kind: 'unknown' })
    expect(budgetOf(read)).toBe(8000)
  })

  it.each([['0', 0], ['1.5', 1.5], ['字符串', '8192'], ['负数', -1], ['缺 config', undefined]])('阈值是 %s → 「未知」，预算 8000', (_label, value) => {
    const read = () => value === undefined ? {} : pruner(value)
    expect(readPrunerThreshold(read)).toEqual({ kind: 'unknown' })
    expect(budgetOf(read)).toBe(8000)
  })

  it('已知阈值记下原值', () => {
    expect(readPrunerThreshold(() => pruner(8192))).toEqual({ kind: 'known', chars: 8192 })
  })
})

// ── 检索输出按预算收尾 ──

const registry = buildTypeRegistry({ template: 'coding', customTypes: {} })
/** 撑长度用的正文：不含测试里查的词，每句以全角句号结尾。 */
const SENTENCE = '这是一段用来撑长度的普通说明文字。'
const filler = (chars: number) => SENTENCE.repeat(Math.ceil(chars / SENTENCE.length)).slice(0, chars)
/** 码点数：测试自己数，不用被测的量长函数。 */
const points = (text: string) => [...text].length

type PrunerSetting = number | 'none' | 'throw'

function setup(initial: PrunerSetting = 8192) {
  const stats = new InMemoryBatchKvTable<RecallStats>()
  const store = new MemoryStore(new InMemoryTable(), undefined, stats)
  const cache = new SnapshotCache({ store, registry, budget: 100_000 })
  const setting = { value: initial }
  const host = {
    contextOf: async (): Promise<SearchContext> => ({ workspacePath: undefined, session: { id: 's', lastSeq: 1 } }),
    toolResultPrunerOf: () => {
      if (setting.value === 'throw') throw new Error('服务重启中')
      return setting.value === 'none' ? undefined : pruner(setting.value)
    },
  }
  const deps: SearchToolDeps = { store, registry, host, sessionRecall: cache }
  const plain: SearchToolDeps = { store, registry, host: { contextOf: host.contextOf }, sessionRecall: cache }
  const search = async (args: SearchArgs, d: SearchToolDeps = deps) => {
    const result = await executeSearch(args, fakeExec(), d)
    return { result, text: renderSearchResult(result) }
  }
  /** 依次存入；查询留空时按 lastConfirmedAt 降序排，存入顺序就是排名。 */
  const seed = async (lengths: readonly number[], patch: (i: number) => Partial<MemoryRecord> = () => ({})) => {
    const records = lengths.map((chars, i) =>
      record({ id: `mem_r${String(i).padStart(2, '0')}`, summary: `第 ${i} 条`, content: filler(chars), lastConfirmedAt: 10_000 - i, ...patch(i) }))
    for (const r of records) await store.put(r)
    return records
  }
  return { store, stats, cache, setting, deps, plain, search, seed }
}

type Shape = 'full' | 'excerpt' | 'note' | 'head'
const shapeOf = (h: SearchHit): Shape => h.isHeadOnly ? 'head' : h.content === IN_SNAPSHOT_NOTE ? 'note' : h.isExcerpt ? 'excerpt' : 'full'
const shapes = (hits: readonly SearchHit[]) => hits.map(shapeOf)
const times = (n: number, shape: Shape): Shape[] => new Array<Shape>(n).fill(shape)

describe('预算按每次检索现读', () => {
  it('两次检索之间换了裁剪服务实例（阈值变了）：第二次按新阈值', async () => {
    const { search, seed, setting } = setup(8192)
    await seed(times(12, 'full').map(() => 1500))
    const first = await search({ query: '', limit: 12 })
    expect(first.text).toContain('本次输出上限 7782 字')
    setting.value = 4000
    const second = await search({ query: '', limit: 12 })
    expect(second.text).toContain('本次输出上限 3800 字')
    expect(points(second.text)).toBeLessThanOrEqual(3800)
  })

  it('取服务抛错：按 8000 收尾，检索照常返回', async () => {
    const { search, seed } = setup('throw')
    await seed(times(12, 'full').map(() => 1500))
    const { text, result } = await search({ query: '', limit: 12 })
    expect(result.noteCode).toBeUndefined()
    expect(text).toContain('本次输出上限 8000 字')
    expect(points(text)).toBeLessThanOrEqual(8000)
  })
})

describe('量长度按码点', () => {
  it('增补平面字符：UTF-16 长度超过预算、码点数没超，不降级', async () => {
    const { search, store } = setup(3000)
    // 每条 760 个增补平面字符：UTF-16 各 1520，两条合计超过 3000；码点合计 1520 加头行，在 3000 以内
    const astral = '𝒜'.repeat(760)
    await store.put(record({ id: 'mem_a1', content: astral, lastConfirmedAt: 2 }))
    await store.put(record({ id: 'mem_a2', content: astral, lastConfirmedAt: 1 }))
    const { text, result } = await search({ query: '' })
    expect(text.length).toBeGreaterThan(3000)
    expect(points(text)).toBeLessThanOrEqual(3000)
    expect(shapes(result.hits)).toEqual(['full', 'full'])
    expect(text).not.toContain('本次输出上限')
  })
})

describe('没超预算时输出不变', () => {
  it('L ≤ B：带裁剪服务和不带时，结构化结果和渲染文字都逐字相同', async () => {
    const { search, seed, plain } = setup(8192)
    await seed([120, 250, 80, 300, 200, 150, 260, 90, 300, 40, 50, 60])
    for (const args of [{ query: '' }, { query: '', limit: 3 }, { query: '', limit: 3, offset: 3 }, { query: '普通' }] satisfies SearchArgs[]) {
      const budgeted = await search(args)
      const unlimited = await search(args, plain)
      expect(budgeted.result).toEqual(unlimited.result)
      expect(budgeted.text).toBe(unlimited.text)
      expect(points(budgeted.text)).toBeLessThanOrEqual(7782)
    }
  })
})

describe('降级顺序', () => {
  it('12 条各 1500 字、预算 7782：从最后一条往前降到头行，前 5 条最后才动，形态按预先写好的序列', async () => {
    const { search, seed } = setup(8192)
    await seed(times(12, 'full').map(() => 1500))
    const { result, text } = await search({ query: '', limit: 12 })
    // 旧规则：前 5 条全文、第 6 条起节选；收尾后第 6–12 条先全部只剩头行，第 5 条再降为节选就够了
    expect(shapes(result.hits)).toEqual([...times(4, 'full'), 'excerpt', ...times(7, 'head')])
    expect(points(text)).toBeLessThanOrEqual(7782)
    expect(text).toContain('本次输出上限 7782 字：1 条改为节选，7 条只给头行。要某条的全文，query 填它的 id，或读头行末尾的路径。')
  })

  it('预算 3000：第 6 条起全部只剩头行之后，前 5 条也从后往前降，降到第 2 条为节选时放得下', async () => {
    const { search, seed } = setup(3000)
    await seed(times(12, 'full').map(() => 1500))
    const { result, text } = await search({ query: '', limit: 12 })
    expect(shapes(result.hits)).toEqual(['full', 'excerpt', ...times(10, 'head')])
    expect(points(text)).toBeLessThanOrEqual(3000)
    expect(text).toContain('当前上限偏低')
  })
})

/** 下一页的 offset：说明里没有时为 undefined。 */
const nextOffsetOf = (result: { moreNote?: string }) => {
  const m = result.moreNote?.match(/下一页用 offset: (\d+)/)
  return m === null || m === undefined ? undefined : Number(m[1])
}
const longSummary = (i: number, chars: number) => `第 ${i} 条摘要${'长'.repeat(chars)}`

describe('截条数翻页', () => {
  it('50 条只剩头行仍超：截到 m 条、提示 offset: m，用它再搜第 1 条就是原第 m + 1 条', async () => {
    const { search, seed } = setup(3000)
    await seed(new Array(50).fill(40), i => ({ summary: longSummary(i, 120) }))
    const first = await search({ query: '', limit: 50 })
    const m = first.result.hits.length
    expect(m).toBeGreaterThan(0)
    expect(m).toBeLessThan(50)
    expect(points(first.text)).toBeLessThanOrEqual(3000)
    expect(first.result.hits.every(h => h.isHeadOnly)).toBe(true)
    expect(nextOffsetOf(first.result)).toBe(m)
    expect(first.result.moreNote).not.toContain('limit')
    expect(first.text).toContain(`${50 - m} 条移到下一页`)
    const second = await search({ query: '', limit: 50, offset: m })
    expect(second.result.hits[0]!.id).toBe(`mem_r${String(m).padStart(2, '0')}`)
  })

  it('翻到底：随机条数和长度，每条恰好出现一次，每页至少 1 条（固定种子 60 轮）', async () => {
    const SEED = 7
    await fc.assert(fc.asyncProperty(
      fc.record({
        count: fc.integer({ min: 1, max: 40 }),
        limit: fc.integer({ min: 1, max: 50 }),
        threshold: fc.constantFrom(3000, 4000, 8192),
        summaries: fc.array(fc.integer({ min: 0, max: 400 }), { minLength: 40, maxLength: 40 }),
        contents: fc.array(fc.integer({ min: 10, max: 2500 }), { minLength: 40, maxLength: 40 }),
      }),
      async ({ count, limit, threshold, summaries, contents }) => {
        const { search, seed } = setup(threshold)
        await seed(contents.slice(0, count), i => ({ summary: longSummary(i, summaries[i]!) }))
        const budget = Math.max(3000, Math.floor(threshold * 0.95))
        const seen: string[] = []
        let offset: number | undefined = 0
        for (let page = 0; offset !== undefined; page++) {
          expect(page).toBeLessThanOrEqual(count)
          const { result, text } = await search({ query: '', limit, ...(offset > 0 ? { offset } : {}) })
          expect(result.hits.length).toBeGreaterThanOrEqual(1)
          expect(points(text)).toBeLessThanOrEqual(budget)
          seen.push(...result.hits.map(h => h.id))
          offset = nextOffsetOf(result)
          if (offset !== undefined) expect(offset).toBe(seen.length)
        }
        expect(seen).toEqual(Array.from({ length: count }, (_, i) => `mem_r${String(i).padStart(2, '0')}`))
      },
    ), { seed: SEED, numRuns: 60 })
  })

  it('两页之间删掉一条已返回的记忆：下一页按新位置切，不报错', async () => {
    const { search, seed, store } = setup(8192)
    const records = await seed(new Array(6).fill(40))
    const first = await search({ query: '', limit: 3 })
    expect(first.result.hits.map(h => h.id)).toEqual(['mem_r00', 'mem_r01', 'mem_r02'])
    expect(await store.softDelete(records[0]!)).toBe(true)
    const second = await search({ query: '', limit: 3, offset: 3 })
    // 删掉第 1 条后原第 4 条前移到第 3 位，下一页从原第 5 条开始：原第 4 条这一轮漏掉，翻页不保证这种情况不漏
    expect(second.result.noteCode).toBeUndefined()
    expect(second.result.hits.map(h => h.id)).toEqual(['mem_r04', 'mem_r05'])
  })
})

describe('有界返回', () => {
  it('摘要 10000 字的一条：头行依次缩短后长度在预算以内，[id] 类型｜ 不截', async () => {
    const { search, store } = setup(8192)
    await store.put(record({ id: 'mem_long', type: 'knowledge', summary: '摘'.repeat(10_000), content: '短正文' }))
    const { result, text } = await search({ query: '' })
    expect(points(text)).toBeLessThanOrEqual(7782)
    expect(text).toContain('[mem_long] knowledge｜')
    expect(result.hits).toHaveLength(1)
    expect(result.hits[0]!.isHeadOnly).toBe(true)
    expect(result.hits[0]!.summary).toBe(`${'摘'.repeat(60)}…`)
    expect(text).toContain('1 条头行已缩短')
  })

  it('必留说明加一条 [id] 类型｜ 本身超过预算：照样返回最小形态，offset 仍前进', async () => {
    const { search, store } = setup(3000)
    // id 和类型不截：id 3000 字时一条头行本身就超
    const id = `mem_${'x'.repeat(3000)}`
    await store.put(record({ id, summary: '摘'.repeat(500), content: '正文'.repeat(500), lastConfirmedAt: 2 }))
    await store.put(record({ id: 'mem_next', summary: '下一条', content: '正文', lastConfirmedAt: 1 }))
    const { result, text } = await search({ query: '', limit: 2 })
    expect(result.hits.map(h => h.id)).toEqual([id])
    expect(text).toContain(`[${id}] knowledge｜\n`.slice(0, -1))
    expect(result.hits[0]!.summary).toBe('')
    expect(nextOffsetOf(result)).toBe(1)
    const next = await search({ query: '', limit: 2, offset: 1 })
    expect(next.result.hits.map(h => h.id)).toEqual(['mem_next'])
  })

  it('最小终态：必留说明 + 一条 [id] 类型｜，路径、出处、摘要都去掉', async () => {
    const { search, store } = setup(3000)
    const id = `mem_${'y'.repeat(2950)}`
    await store.put(record({ id, summary: '摘要', content: '正文' }))
    const { text } = await search({ query: '' })
    const lines = text.split('\n')
    expect(lines.at(-1)).toBe(`[${id}] knowledge｜`)
  })
})

describe('按 id 直达的全文例外', () => {
  it('9000 字的记忆按 id 查、预算 7782：全文照给，说明超出上限、可能被裁；同次其他命中照常降', async () => {
    const { search, store } = setup(8192)
    const big = filler(9000)
    await store.put(record({ id: 'mem_big', name: 'mem_big', content: big, lastConfirmedAt: 3 }))
    await store.put(record({ id: 'mem_big_other', name: 'mem_big 附近', content: `mem_big ${filler(1500)}`, lastConfirmedAt: 2 }))
    const { result, text } = await search({ query: 'mem_big' })
    expect(result.hits[0]!.id).toBe('mem_big')
    expect(result.hits[0]!.content).toBe(big)
    expect(text).toContain('按 id 查的这条全文照给，超出本次输出上限 7782 字')
    expect(text).toContain('可能被裁掉中间部分')
    expect(result.hits.slice(1).every(h => h.isHeadOnly)).toBe(true)
  })

  it('全文超出上限、整段输出仍在宿主阈值以内：说明超出上限，不说可能被裁', async () => {
    const { search, store } = setup(8192)
    await store.put(record({ id: 'mem_mid', name: 'mem_mid', content: filler(7900) }))
    const { result, text } = await search({ query: 'mem_mid' })
    expect(result.hits[0]!.content).toBe(filler(7900))
    expect(points(text)).toBeGreaterThan(7782)
    expect(points(text)).toBeLessThanOrEqual(8192)
    expect(text).toContain('按 id 查的这条全文照给，超出本次输出上限 7782 字。')
  })

  it('正文本身不到宿主阈值、加上头行和说明后超过：说可能被裁', async () => {
    const { search, store } = setup(8192)
    await store.put(record({ id: 'mem_edge', name: 'mem_edge', content: filler(8150) }))
    const { text } = await search({ query: 'mem_edge' })
    expect(points(text)).toBeGreaterThan(8192)
    expect(text).toContain('超出本次输出上限 7782 字，DeepSeek Harness 压缩上下文时可能被裁掉中间部分。')
  })

  it('正文 8080 码点、阈值 8192：头行和超出上限的说明加上去才超过阈值，也说可能被裁', async () => {
    const { search, store } = setup(8192)
    await store.put(record({ id: 'mem_edge2', name: 'mem_edge2', content: filler(8080) }))
    const { text } = await search({ query: 'mem_edge2' })
    expect(points(text)).toBeGreaterThan(8192)
    expect(text).toContain('超出本次输出上限 7782 字，DeepSeek Harness 压缩上下文时可能被裁掉中间部分。')
  })

  it('没有裁剪服务：照给全文，说明超出上限 8000，但不说可能被裁', async () => {
    const { search, store } = setup('none')
    await store.put(record({ id: 'mem_big', name: 'mem_big', content: filler(9000) }))
    const { text } = await search({ query: 'mem_big' })
    expect(text).toContain('超出本次输出上限 8000 字')
    expect(text).not.toContain('可能被裁')
  })

  it('offset: 1 时不享受例外：第 1 页之外的同 id 命中照常降级', async () => {
    const { search, store } = setup(3000)
    await store.put(record({ id: 'mem_big', name: 'mem_big', content: filler(9000), lastConfirmedAt: 3 }))
    await store.put(record({ id: 'mem_big2', name: 'mem_big 又一条', content: `mem_big ${filler(9000)}`, lastConfirmedAt: 2 }))
    const { result, text } = await search({ query: 'mem_big', offset: 1 })
    expect(result.hits[0]!.id).toBe('mem_big2')
    expect(result.hits[0]!.content).not.toBe(filler(9000))
    expect(points(text)).toBeLessThanOrEqual(3000)
    expect(text).not.toContain('全文照给')
  })
})

describe('低预算提示', () => {
  it('阈值 6000、有降级：说明里提上限偏低；阈值 6316 不提', async () => {
    for (const [threshold, isLow] of [[6000, true], [6316, false]] as const) {
      const { search, seed } = setup(threshold)
      await seed(times(12, 'full').map(() => 1500))
      const { text } = await search({ query: '', limit: 12 })
      expect(text).toContain('本次输出上限')
      expect(text.includes('当前上限偏低')).toBe(isLow)
    }
  })

  it('阈值 6000、没有降级：不加提示', async () => {
    const { search, seed } = setup(6000)
    await seed([100, 100])
    const { text } = await search({ query: '' })
    expect(text).not.toContain('上限偏低')
    expect(text).not.toContain('本次输出上限')
  })
})

describe('对话卡片按头行数条数', () => {
  it('降级、头行缩短之后数出的条数等于本页命中条数，相邻只剩头行的命中各算一条', async () => {
    const { search, seed } = setup(3000)
    await seed(new Array(30).fill(400), i => ({ summary: longSummary(i, 30) }))
    const { result, text } = await search({ query: '', limit: 30 })
    expect(result.hits.filter(h => h.isHeadOnly).length).toBeGreaterThan(1)
    expect(countSearchHits(text)).toBe(result.hits.length)
  })

  it('正文以换行结尾的命中后面跟着只剩头行的命中：条数仍对', async () => {
    const { search, store } = setup(3000)
    await store.put(record({ id: 'mem_nl', content: '第一行\n第二行\n', lastConfirmedAt: 100 }))
    for (let i = 0; i < 20; i++) await store.put(record({ id: `mem_h${i}`, summary: longSummary(i, 20), content: filler(600), lastConfirmedAt: 50 - i }))
    const { result, text } = await search({ query: '', limit: 21 })
    expect(result.hits[0]!.content).toBe('第一行\n第二行\n')
    expect(result.hits.slice(1).some(h => h.isHeadOnly)).toBe(true)
    expect(countSearchHits(text)).toBe(result.hits.length)
  })

  it('只剩一条、头行缩到最短：卡片仍数出 1 条', async () => {
    const { search, store } = setup(3000)
    await store.put(record({ id: `mem_${'z'.repeat(2950)}`, summary: '摘要', content: '正文' }))
    const { text } = await search({ query: '' })
    expect(countSearchHits(text)).toBe(1)
  })
})

describe('召回计数', () => {
  it('截条数截掉的命中仍计召回，和不限长度时一致', async () => {
    const limited = setup(3000)
    const unlimited = setup(3000)
    for (const env of [limited, unlimited]) await env.seed(new Array(20).fill(40), i => ({ summary: longSummary(i, 200) }))
    const a = await limited.search({ query: '', limit: 20 })
    await unlimited.search({ query: '', limit: 20 }, unlimited.plain)
    expect(a.result.hits.length).toBeLessThan(20)
    const counts = async (env: ReturnType<typeof setup>) => Promise.all(Array.from({ length: 20 }, async (_, i) => (await env.stats.get(`mem_r${String(i).padStart(2, '0')}`))?.recallCount ?? 0))
    expect(await counts(limited)).toEqual(await counts(unlimited))
    expect((await counts(limited)).every(n => n === 1)).toBe(true)
  })
})

describe('工具说明', () => {
  const tool = () => createSearchTool(setup().deps)
  const parameter = (name: string) => (tool().parameters as { properties: Record<string, { description?: string }> }).properties[name]!.description!

  it('说明讲清输出跟随 DeepSeek Harness 的裁剪阈值、调低后只给节选或头行、按结果里的 offset 翻页，不再让调大 limit', () => {
    const d = tool().description
    expect(d).toContain('输出长度跟随 DeepSeek Harness 的工具结果裁剪阈值')
    expect(d).toContain('阈值调得越低，越多条目只给节选或头行')
    expect(d).toContain('按结果里给的 offset 翻下一页')
    expect(d).toContain('memory_health')
    expect(d).not.toContain('调大 limit')
  })

  it('offset 参数用于关键词检索、按类型列和主题浏览；limit 参数是正整数', () => {
    expect(parameter('offset')).toContain('关键词检索、按类型列出和按主题浏览都可以翻页')
    expect(parameter('offset')).not.toContain('配 topic 翻页')
    expect(parameter('limit')).toContain('正整数')
  })
})
