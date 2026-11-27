import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileTable } from '../src/storage/file-table.ts'
import { encodeRecord } from '../src/storage/frontmatter.ts'
import { GLOBAL_DIR } from '../src/storage/paths.ts'
import type { RecallStats } from '../src/storage/schema.ts'
import { MemoryStore } from '../src/store.ts'
import { executeSearch, renderSearchResult, LOW_COVERAGE_NOTE, TERM_HITS_LEAD, type SearchArgs, type SearchToolDeps } from '../src/tools/search.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'
import type { MemoryRecord } from '../src/record-schema.ts'
import { record } from './helpers/record.ts'
import { fakeExec } from './helpers/exec.ts'
import { InMemoryBatchKvTable } from './helpers/in-memory-kv.ts'
import { writeTopicIndex } from './helpers/topic-fixture.ts'
import { toolSummary } from '../client/chat/tool-summary.ts'

// 主题相关的输出按预算收尾：可省的说明（主题目录、逐词命中计数、匹配的主题）按顺序省；按主题浏览截行翻页、缩短行；零条结果缩短说明。

const T0 = 1_700_000_000_000
const DAY = 86_400_000
const registry = buildTypeRegistry({ template: 'coding', customTypes: {} })
const points = (text: string) => [...text].length
const CATALOG_LEAD = '当下的主题目录（用 topic 参数传主题名可以列出某个主题下的全部记忆）：'

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'pm-search-budget-topics-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
const globalDir = () => join(root, GLOBAL_DIR)

function env(threshold: number) {
  const stats = new InMemoryBatchKvTable<RecallStats>()
  const store = new MemoryStore(new FileTable({ root, stats, now: () => T0 }), undefined, stats)
  const deps: SearchToolDeps = {
    store, registry, now: () => T0,
    host: { contextOf: async () => ({ workspacePath: undefined, session: { id: 's', lastSeq: 1 } }), toolResultPrunerOf: () => ({ config: { thresholdChars: threshold } }) },
  }
  return async (args: SearchArgs) => {
    const result = await executeSearch(args, fakeExec(), deps)
    return { result, text: renderSearchResult(result) }
  }
}

const mem = (id: string, partial: Partial<MemoryRecord> = {}) =>
  record({ id, name: `${id} 名称`, summary: `${id} 摘要`, content: `${id} 正文`, createdAt: T0 - DAY, updatedAt: T0 - DAY, lastConfirmedAt: T0 - DAY, ...partial })

async function seed(records: readonly MemoryRecord[]) {
  await mkdir(globalDir(), { recursive: true })
  for (const r of records) await writeFile(join(globalDir(), `${r.id}.md`), encodeRecord(r, {}), 'utf8')
}

describe('可省的说明按顺序省', () => {
  it('主题目录从后往前 → 逐词命中计数 → 匹配的主题；说明码那一句一直在，命中正文最后才动', async () => {
    // 命中弱：只对上「发版」、没对上另外三个词，出逐词计数和主题目录；「发版」也对上主题名，出匹配的主题。三条命中的正文逐步加长
    // 760 到 800 之间每次加 4 字：「匹配的主题」一行只有二十几个字，步子大了会跨过这一阶段
    const sizes = [100, 300, 500, 600, 700, ...Array.from({ length: 11 }, (_, i) => 760 + 4 * i), 900, 1000]
    const stages: string[] = []
    for (const size of sizes) {
      await rm(globalDir(), { recursive: true, force: true })
      const hits = ['g_rel0', 'g_rel1', 'g_rel2']
      await seed([...hits.map(id => mem(id, { content: `发版 ${'正'.repeat(size)}` })), ...Array.from({ length: 12 }, (_, i) => mem(`g_t${i}`))])
      await writeTopicIndex(globalDir(), [
        { name: '发版流程', about: '发版说明', members: hits },
        ...Array.from({ length: 12 }, (_, i) => ({ name: `主题${i}`, about: `说明${i}${'述'.repeat(60)}`, members: [`g_t${i}`] })),
      ])
      const { result, text } = await env(3000)({ query: '发版 火星 木星 土星', limit: 3 })
      expect(result.noteCode).toBe('low-coverage')
      expect(text).toContain(LOW_COVERAGE_NOTE)
      expect(points(text)).toBeLessThanOrEqual(3000)
      const isTrimmed = text.includes('本次输出上限')
      const hasCatalog = text.includes(CATALOG_LEAD)
      const hasTerm = text.includes(TERM_HITS_LEAD)
      const hasMatched = text.includes('匹配的主题：')
      const isBodyTouched = result.hits.some(h => h.isExcerpt === true || h.isHeadOnly === true)
      // 后一种在，前一种就没有省完：目录还有行 → 计数和匹配的主题都在；计数在 → 匹配的主题在；正文动过 → 三样都省完了
      if (hasCatalog) expect(hasTerm && hasMatched).toBe(true)
      if (hasTerm) expect(hasMatched).toBe(true)
      if (isBodyTouched) expect(hasCatalog || hasTerm || hasMatched).toBe(false)
      stages.push(!isTrimmed ? 'whole' : hasCatalog ? 'catalog-partial' : hasTerm ? 'term' : hasMatched ? 'matched' : isBodyTouched ? 'body' : 'notes-gone')
    }
    // 阶段只往后走，这组长度走过了每一个阶段
    const order = ['whole', 'catalog-partial', 'term', 'matched', 'notes-gone', 'body']
    expect(stages.map(st => order.indexOf(st))).toEqual([...stages.map(st => order.indexOf(st))].sort((a, b) => a - b))
    expect(new Set(stages)).toEqual(new Set(order))
  })
})

describe('按主题浏览', () => {
  it('行太多：截到放得下的行数、给下一页 offset；翻到底每条恰好一次、每页至少 1 条（固定种子 60 轮）', async () => {
    await fc.assert(fc.asyncProperty(
      fc.record({ count: fc.integer({ min: 1, max: 25 }), limit: fc.integer({ min: 1, max: 50 }), summaries: fc.array(fc.integer({ min: 0, max: 600 }), { minLength: 25, maxLength: 25 }) }),
      async ({ count, limit, summaries }) => {
        await rm(globalDir(), { recursive: true, force: true })
        const ids = Array.from({ length: count }, (_, i) => `g_b${String(i).padStart(2, '0')}`)
        await seed(ids.map((id, i) => mem(id, { summary: `摘要${'要'.repeat(summaries[i]!)}` })))
        await writeTopicIndex(globalDir(), [{ name: '长主题', about: '说明', members: ids }])
        const search = env(3000)
        const seen: string[] = []
        let offset: number | undefined = 0
        for (let page = 0; offset !== undefined; page++) {
          expect(page).toBeLessThanOrEqual(count)
          const { result, text } = await search({ topic: '长主题', limit, ...(offset > 0 ? { offset } : {}) })
          const rows = result.browse!.sections.flatMap(s => s.rows.map(r => r.id))
          expect(rows.length).toBeGreaterThanOrEqual(1)
          expect(points(text)).toBeLessThanOrEqual(3000)
          expect(toolSummary('memory_search', { topic: '长主题' }, text)).toMatchObject({ params: { count: rows.length } })
          seen.push(...rows)
          const m = result.moreNote?.match(/下一页用 offset: (\d+)/)
          offset = m ? Number(m[1]) : undefined
          if (offset !== undefined) expect(offset).toBe(seen.length)
        }
        expect(seen).toEqual(ids)
      },
    ), { seed: 7, numRuns: 60 })
  })

  it('最小终态：主题名缩到 60 码点 + 一行条目的 id', async () => {
    const name = `主题${'名'.repeat(3000)}`
    await seed([mem('g_only', { summary: '摘'.repeat(200), tags: ['标签'] })])
    await writeTopicIndex(globalDir(), [{ name, about: '说'.repeat(100), members: ['g_only'] }])
    const { result, text } = await env(3000)({ topic: '主题' + '名'.repeat(3000) })
    expect(result.browse!.sections).toHaveLength(1)
    expect(result.browse!.sections[0]!.topic.name).toBe(`${name.slice(0, 60)}…`)
    expect(result.browse!.sections[0]!.topic.about).toBe('')
    expect(text.split('\n').at(-1)).toBe('- [g_only]')
    expect(toolSummary('memory_search', { topic: '主题' }, text)).toMatchObject({ params: { count: 1 } })
  })

  it('只省了主题说明就放得下：说明里写出来，不留空的冒号', async () => {
    await seed([mem('g_about')])
    await writeTopicIndex(globalDir(), [{ name: '长说明主题', about: '说'.repeat(8000), members: ['g_about'] }])
    const { result } = await env(8192)({ topic: '长说明主题' })
    expect(result.browse!.sections[0]!.topic.about).toBe('')
    expect(result.budgetNote).toBe('本次输出上限 7782 字：部分说明已省略。')
  })
})

describe('零条结果', () => {
  it('找不到主题：说明缩到 300 码点，主题目录全省', async () => {
    await seed(Array.from({ length: 20 }, (_, i) => mem(`g_t${i}`)))
    await writeTopicIndex(globalDir(), Array.from({ length: 20 }, (_, i) => ({ name: `主题${i}`, about: '述'.repeat(200), members: [`g_t${i}`] })))
    const asked = '找'.repeat(4000)
    const { result, text } = await env(3000)({ topic: asked })
    expect(result.noteCode).toBe('topic-not-found')
    expect(result.catalog).toBeUndefined()
    expect(points(result.note!)).toBe(301)
    expect(result.note!.endsWith('…')).toBe(true)
    expect(points(text)).toBeLessThanOrEqual(3000)
  })
})
