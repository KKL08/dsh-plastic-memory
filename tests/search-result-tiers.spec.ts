import { describe, expect, it } from 'vitest'
import { fakeExec } from './helpers/exec.ts'
import { record } from './helpers/record.ts'
import { FAKE_SECRET } from './helpers/secrets.ts'
import { InMemoryTable } from './helpers/in-memory-table.ts'
import { InMemoryBatchKvTable } from './helpers/in-memory-kv.ts'
import {
  executeSearch, renderSearchResult, EXCERPT_ABOVE_CHARS, EXCERPT_NOTE, FULL_TEXT_BUDGET_CHARS, FULL_TEXT_GUARANTEED_HITS,
  IN_SNAPSHOT_NOTE, WINDOW_MAX_CHARS, WINDOW_TARGET_CHARS, type SearchArgs, type SearchHit, type SearchToolDeps,
} from '../src/tools/search.ts'
import { createSearchTool } from '../src/tools/search-tool.ts'
import { countSearchHits } from '../client/chat/tool-summary.ts'
import { SnapshotCache } from '../src/runtime.ts'
import { MemoryStore } from '../src/store.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'
import { SECRET_MASK } from '../src/secrets.ts'
import type { MemoryRecord } from '../src/record-schema.ts'
import type { RecallStats } from '../src/storage/schema.ts'

// 检索结果分级：前几条保底全文，单条很长或全文总量到了预算之后给节选；节选条目头行标字数，开头多一段说明。

const registry = buildTypeRegistry({ template: 'coding', customTypes: {} })

/** 撑长度用的正文：不含任何测试里查的词，每句以全角句号结尾，切得出单元。 */
const SENTENCE = '这是一段用来撑长度的普通说明文字。'
const filler = (chars: number) => SENTENCE.repeat(Math.ceil(chars / SENTENCE.length)).slice(0, chars)

function setup() {
  const store = new MemoryStore(new InMemoryTable(), undefined, new InMemoryBatchKvTable<RecallStats>())
  // 注入预算放宽，长的 core 记忆也能整条带入快照
  const cache = new SnapshotCache({ store, registry, budget: 100_000 })
  const deps = (handle?: object): SearchToolDeps => ({
    store, registry, sessionRecall: cache,
    host: { contextOf: async () => ({ workspacePath: undefined, session: { id: 's', lastSeq: 1, ...(handle ? { handle } : {}) } }) },
  })
  const search = (args: SearchArgs, handle?: object) => executeSearch(args, fakeExec(), deps(handle))
  const freeze = async (session: object) => {
    cache.setWorkspacePath(session, undefined)
    return cache.assemble(session)
  }
  /** 按给定正文长度依次存入；查询留空时按 lastConfirmedAt 降序排，存入顺序就是排名。 */
  const seed = async (lengths: readonly number[], patch: (i: number) => Partial<MemoryRecord> = () => ({})) => {
    const records = lengths.map((chars, i) =>
      record({ id: `mem_r${String(i).padStart(2, '0')}`, summary: `第 ${i} 条`, content: filler(chars), lastConfirmedAt: 10_000 - i, ...patch(i) }))
    for (const r of records) await store.put(r)
    return records
  }
  return { store, search, freeze, seed, deps }
}

type Shape = 'full' | 'excerpt' | 'note'
const shapeOf = (h: SearchHit): Shape => h.content === IN_SNAPSHOT_NOTE ? 'note' : h.isExcerpt ? 'excerpt' : 'full'
const shapes = (hits: readonly SearchHit[]) => hits.map(shapeOf)
const times = (n: number, shape: Shape): Shape[] => new Array<Shape>(n).fill(shape)

/** 去掉省略标记行后的节选正文。 */
const windowText = (h: SearchHit) => h.content.split('\n').filter(l => l !== '[前文省略]' && l !== '[后文省略]').join('\n')

/** 改动前的渲染格式：头行 + 正文，开头说明在前。全部是全文条目时新渲染必须与它逐字一致。 */
function renderBefore(result: { hits: SearchHit[]; note?: string; moreNote?: string }): string {
  const blocks = result.hits.map(h => `[${h.id}] ${h.type}｜${h.summary}${h.sourceNote}${h.stalenessNote}${h.matchNote}${h.path !== undefined ? ` · ${h.path}` : ''}\n${h.content}`)
  const head = [result.note, result.moreNote].filter((x): x is string => x !== undefined).join('\n')
  if (head !== '') blocks.unshift(head)
  return blocks.length === 0 ? '没有匹配的记忆。' : blocks.join('\n\n')
}

describe('具名常量', () => {
  it('五个门槛按定好的数值定义', () => {
    expect([FULL_TEXT_GUARANTEED_HITS, EXCERPT_ABOVE_CHARS, FULL_TEXT_BUDGET_CHARS, WINDOW_TARGET_CHARS, WINDOW_MAX_CHARS])
      .toEqual([5, 2000, 8000, 200, 300])
  })
})

describe('全文与节选的判定', () => {
  it('全部是短记忆、10 条：每条全文，渲染与改动前逐字一致，没有节选说明', async () => {
    const { search, seed } = setup()
    const records = await seed([120, 250, 80, 300, 200, 150, 260, 90, 300, 40])
    const result = await search({ query: '' })
    expect(result.hits.map(h => h.content)).toEqual(records.map(r => r.content))
    for (const h of result.hits) {
      expect(h).not.toHaveProperty('isExcerpt')
      expect(h).not.toHaveProperty('contentChars')
    }
    const text = renderSearchResult(result)
    expect(text).toBe(renderBefore(result))
    expect(text).not.toContain('节选')
  })

  it('总量恰好等于全文预算时仍全部全文：「不超过」含等于', async () => {
    const { search, seed } = setup()
    await seed(times(10, 'full').map(() => 800))
    const result = await search({ query: '' })
    expect(shapes(result.hits)).toEqual(times(10, 'full'))
    expect(renderSearchResult(result)).toBe(renderBefore(result))
  })

  it('前五条里有一条超过单条门槛：这一条节选，其余四条全文', async () => {
    const { search, seed } = setup()
    const records = await seed([500, 2500, 500, 500, 500])
    const { hits } = await search({ query: '' })
    expect(shapes(hits)).toEqual(['full', 'excerpt', 'full', 'full', 'full'])
    expect(hits[1]).toMatchObject({ isExcerpt: true, contentChars: 2500 })
    expect(hits[0].content).toBe(records[0].content)
  })

  it('第六条起累计超过全文预算：撞线的那条和之后全部节选，之前的全文', async () => {
    const { search, seed } = setup()
    // 累计：5000 → 6500 → 8000（恰好用满）→ 第八条撞线
    await seed([1000, 1000, 1000, 1000, 1000, 1500, 1500, 1000, 500, 1000])
    const { hits } = await search({ query: '' })
    expect(shapes(hits)).toEqual([...times(7, 'full'), ...times(3, 'excerpt')])
  })

  it('级联开始后不再结束：撞线之后本来放得下的条目也给节选', async () => {
    const { search, seed } = setup()
    // 累计：5000 → 6500；第七条 2000（不超过单条门槛）加进去 8500 放不下，开始级联；
    // 第八条 600 加进去 7100 本来放得下，级联不结束，仍给节选
    await seed([1000, 1000, 1000, 1000, 1000, 1500, 2000, 600])
    const { hits } = await search({ query: '' })
    expect(shapes(hits)).toEqual([...times(6, 'full'), 'excerpt', 'excerpt'])
  })

  it('前五条累计已超过全文预算：前五条仍全文，第六条起全部节选', async () => {
    const { search, seed } = setup()
    await seed([1900, 1900, 1900, 1900, 1900, 400, 1000])
    const { hits } = await search({ query: '' })
    expect(shapes(hits)).toEqual([...times(5, 'full'), 'excerpt', 'excerpt'])
  })

  it('第六条以后有一条超过单条门槛而预算未满：这一条节选、不占预算，之后的条目仍全文', async () => {
    const { search, seed } = setup()
    // 前五条 5000；第六条 2500 节选不计入，第七、八条累计到 7000 仍在预算内
    await seed([1000, 1000, 1000, 1000, 1000, 2500, 1000, 1000])
    const { hits } = await search({ query: '' })
    expect(shapes(hits)).toEqual([...times(5, 'full'), 'excerpt', 'full', 'full'])
  })

  it('落到节选位的短条目给完整正文、不标节选；级联开始后短条目仍全文，其后的长条目仍是节选', async () => {
    const { search, seed } = setup()
    // 前五条 9500 已超预算：第六条短（≤ 窗口硬上限）给全文，第七条开始级联，第八条短仍全文，第九条长仍节选
    const records = await seed([1900, 1900, 1900, 1900, 1900, WINDOW_MAX_CHARS, 1000, 200, 1000])
    const { hits } = await search({ query: '' })
    expect(shapes(hits)).toEqual([...times(5, 'full'), 'full', 'excerpt', 'full', 'excerpt'])
    expect(hits[5].content).toBe(records[5].content)
    expect(hits[5]).not.toHaveProperty('isExcerpt')
    expect(hits[7].content).toBe(records[7].content)
  })

  it('limit 小于保底条数：全部在保底范围内，只受单条门槛约束', async () => {
    const { search, seed } = setup()
    await seed([1900, 1900, 2500, 1900])
    const result = await search({ query: '', limit: 3 })
    expect(shapes(result.hits)).toEqual(['full', 'full', 'excerpt'])
    expect(result.moreNote).toBeDefined()
  })

  it('limit 调到 50：返回条数不变，每条节选不超过窗口硬上限加省略标记，对话卡片计数等于条数', async () => {
    const { search, seed } = setup()
    const cycle = [3000, 1200, 250, 2000, 800]
    await seed(Array.from({ length: 60 }, (_, i) => cycle[i % cycle.length]!))
    const result = await search({ query: '', limit: 50 })
    expect(result.hits).toHaveLength(50)
    const excerpts = result.hits.filter(h => h.isExcerpt)
    expect(excerpts.length).toBeGreaterThan(0)
    for (const h of excerpts) expect(windowText(h).length).toBeLessThanOrEqual(WINDOW_MAX_CHARS)
    // 超过窗口硬上限的全文条目，正文总量停在全文预算以内（这组数据前五条没超预算）
    const longFull = result.hits.filter(h => !h.isExcerpt && h.content.length > WINDOW_MAX_CHARS)
    expect(longFull.reduce((n, h) => n + h.content.length, 0)).toBeLessThanOrEqual(FULL_TEXT_BUDGET_CHARS)
    expect(countSearchHits(renderSearchResult(result))).toBe(50)
  })
})

describe('按 id 查与注入快照', () => {
  it('按 id 查一条超过单条门槛、原本不在第一的记忆：置顶、全文，没有节选说明', async () => {
    const { store, search } = setup()
    const target = record({ id: 'mem_long', content: filler(2500), lastConfirmedAt: 1 })
    await store.put(target)
    // 这几条正文里提到 id，按关键词排在只靠 id 子串命中的目标之前
    for (let i = 0; i < 3; i++) await store.put(record({ id: `mem_ref${i}`, content: `详情见 mem_long 那条记录。`, lastConfirmedAt: 100 - i }))
    const result = await search({ query: 'mem_long' })
    expect(result.hits[0].id).toBe('mem_long')
    expect(result.hits[0].content).toBe(target.content)
    expect(result.hits[0]).not.toHaveProperty('isExcerpt')
    expect(renderSearchResult(result)).not.toContain(EXCERPT_NOTE)
  })

  it('按 id 直达的那条计入全文累计', async () => {
    const { store, search } = setup()
    await store.put(record({ id: 'mem_long', content: filler(2500), lastConfirmedAt: 1 }))
    // 六条正文提到 id，每条正好 1000 字符
    const lead = '详情见 mem_long 那条记录。'
    for (let i = 0; i < 6; i++) await store.put(record({ id: `mem_ref${i}`, content: lead + filler(1000 - lead.length), lastConfirmedAt: 100 - i }))
    const { hits } = await search({ query: 'mem_long' })
    expect(hits[0].id).toBe('mem_long')
    // 累计：2500 → 6500（保底到第五条）→ 7500 → 第七条 8500 放不下；直达那条不计入的话第七条会是 6000 仍全文
    expect(shapes(hits)).toEqual([...times(6, 'full'), 'excerpt'])
  })

  it('按 id 查、目标全文已在注入快照里：仍是那句说明', async () => {
    const { store, search, freeze } = setup()
    await store.put(record({ id: 'mem_core', type: 'preference', name: 'mem_core', content: filler(2500) }))
    const session = {}
    await freeze(session)
    const { hits } = await search({ query: 'mem_core' }, session)
    expect(hits[0].id).toBe('mem_core')
    expect(hits[0].content).toBe(IN_SNAPSHOT_NOTE)
    expect(hits[0]).not.toHaveProperty('isExcerpt')
  })

  it('全文已在注入快照里的 core 记忆：仍是那句说明，不占全文预算', async () => {
    const { store, search, freeze, seed } = setup()
    // 前五条 7500；第六条是已带入全文的 core 记忆，计 0；第七条 500 让累计恰好到预算，仍全文
    await seed([1500, 1500, 1500, 1500, 1500])
    await store.put(record({ id: 'mem_core', type: 'preference', name: 'mem_core', content: filler(1500), lastConfirmedAt: 10_000 - 5 }))
    await store.put(record({ id: 'mem_after', content: filler(500), lastConfirmedAt: 10_000 - 6 }))
    const session = {}
    await freeze(session)
    const { hits } = await search({ query: '' }, session)
    expect(hits.map(h => h.id).slice(5)).toEqual(['mem_core', 'mem_after'])
    expect(shapes(hits)).toEqual([...times(5, 'full'), 'note', 'full'])
  })
})

describe('命中窗口落在哪', () => {
  it('查询留空只填 types：节选取正文开头，只有后文省略', async () => {
    const { store, search } = setup()
    await store.put(record({ id: 'mem_t', content: `开头这一句是正文的第一句。${filler(2500)}` }))
    const { hits } = await search({ query: '', types: ['knowledge'] })
    expect(hits[0].isExcerpt).toBe(true)
    expect(hits[0].content.startsWith('开头这一句是正文的第一句。')).toBe(true)
    expect(hits[0].content.endsWith('\n[后文省略]')).toBe(true)
    expect(hits[0].content).not.toContain('[前文省略]')
  })

  it('有命中词时节选落在命中词附近，两侧有省略标记，各占一行', async () => {
    const { store, search } = setup()
    await store.put(record({ id: 'mem_w', content: `${filler(1000)}灯塔的维护记录在这一句里。${filler(1500)}` }))
    const { hits } = await search({ query: '灯塔' })
    const lines = hits[0].content.split('\n')
    expect(lines[0]).toBe('[前文省略]')
    expect(lines.at(-1)).toBe('[后文省略]')
    expect(windowText(hits[0])).toContain('灯塔的维护记录在这一句里。')
  })

  it('子串档命中的条目：窗口落在旧词项处', async () => {
    const { store, search } = setup()
    // x、7 都是噪声词项，不参与打分，记录只能靠旧词项进子串档
    await store.put(record({ id: 'mem_sub', content: `${filler(1000)}第 7 版的说明在这一句里。${filler(1500)}` }))
    const { hits } = await search({ query: 'x 7' })
    expect(hits[0].matchNote).toBe(' · 仅子串命中')
    expect(hits[0].isExcerpt).toBe(true)
    expect(windowText(hits[0])).toContain('第 7 版的说明在这一句里。')
  })

  it('命中词取命中的全部查询 token：是另一个查询词子串的词也用来定位', async () => {
    const { store, search } = setup()
    await store.put(record({ id: 'mem_dep', content: `开头一句。${filler(1000)}这里提到 deploy 一次。${filler(1500)}` }))
    // 单独查 deploy：窗口落在它所在的句子
    expect(windowText((await search({ query: 'deploy' })).hits[0])).toContain('这里提到 deploy 一次。')
    // 同时查 deployment：deploy 是它的子串，记录只靠分词命中 deploy，窗口仍落在这一句
    const both = (await search({ query: 'deploy deployment' })).hits[0]
    expect(both.isExcerpt).toBe(true)
    expect(windowText(both)).toContain('这里提到 deploy 一次。')
  })

  it('中文查询分出嵌套 token 时，只命中较短 token 的记录窗口落在它附近', async () => {
    const { store, search } = setup()
    // 「新鲜度」分出「新鲜」「鲜度」「新鲜度」；记录里只有「新鲜」
    await store.put(record({ id: 'mem_fresh', content: `开头一句。${filler(1000)}这条记忆是否新鲜要看确认时间。${filler(1500)}` }))
    const hit = (await search({ query: '新鲜度' })).hits[0]
    expect(hit.matchNote).not.toBe(' · 仅子串命中')
    expect(hit.isExcerpt).toBe(true)
    expect(windowText(hit)).toContain('这条记忆是否新鲜要看确认时间。')
  })
})

describe('节选条目的渲染', () => {
  async function weakTruncated() {
    const { store, search } = setup()
    const body = `${filler(1200)}alpha 出现在这一句。${filler(1200)}`
    await store.put(record({ id: 'mem_a', content: body, lastConfirmedAt: 2 }))
    await store.put(record({ id: 'mem_b', content: body, lastConfirmedAt: 1 }))
    return search({ query: 'alpha gamma delta', limit: 1 })
  }

  it('节选说明与命中弱说明、截断说明同时出现：顺序固定，节选说明在最后', async () => {
    const result = await weakTruncated()
    expect(result.noteCode).toBe('low-coverage')
    expect(result.moreNote).toBeDefined()
    expect(renderSearchResult(result).startsWith(`${result.note}\n${result.moreNote}\n${EXCERPT_NOTE}\n\n[`)).toBe(true)
  })

  it('节选说明讲清取全文的两条路和更新前读全文的引导', () => {
    expect(EXCERPT_NOTE).toContain('节选')
    expect(EXCERPT_NOTE).toContain('按 id 查')
    expect(EXCERPT_NOTE).toContain('读头行末尾路径指向的文件')
    expect(EXCERPT_NOTE).toContain('更新记忆会替换整条正文，更新前先确认已读过它的全文。')
  })

  it('头行里「节选，正文共 N 字符」在逐条命中说明之后、路径之前，路径仍在行末', async () => {
    const result = await weakTruncated()
    const hit = result.hits[0]
    const head = renderSearchResult(result).split('\n\n')[1]!.split('\n')[0]!
    expect(hit.path).toBeDefined()
    expect(head).toBe(`[mem_a] knowledge｜摘要${hit.sourceNote}${hit.stalenessNote} · 匹配：alpha · 节选，正文共 ${hit.contentChars} 字符 · ${hit.path}`)
  })

  it('节选块里没有空行，对话卡片计数等于条目数', async () => {
    const { store, search } = setup()
    // 正文是空行隔开的多段短行，节选要跨好几行，拼接时空行不能带进来
    const paragraphs = Array.from({ length: 200 }, (_, i) => `第 ${i} 段，只有一句话。`).join('\n\n')
    expect(paragraphs.length).toBeGreaterThan(EXCERPT_ABOVE_CHARS)
    await store.put(record({ id: 'mem_p0', content: paragraphs, lastConfirmedAt: 3 }))
    await store.put(record({ id: 'mem_p1', content: paragraphs, lastConfirmedAt: 2 }))
    await store.put(record({ id: 'mem_p2', content: filler(400), lastConfirmedAt: 1 }))
    const result = await search({ query: '' })
    expect(shapes(result.hits)).toEqual(['excerpt', 'excerpt', 'full'])
    for (const h of result.hits.slice(0, 2)) expect(windowText(h).split('\n').length).toBeGreaterThan(1)
    const text = renderSearchResult(result)
    expect(text.split('\n\n')).toHaveLength(1 + 3)
    expect(countSearchHits(text)).toBe(3)
  })
})

describe('密钥', () => {
  it('含密钥的长记忆给节选：密钥已遮盖，字数按遮盖后的正文计', async () => {
    const { store, search } = setup()
    const raw = `${filler(1200)}密钥是 ${FAKE_SECRET.github} 别外传。${filler(1500)}`
    await store.put(record({ id: 'mem_key', content: raw }))
    const result = await search({ query: '密钥' })
    const hit = result.hits[0]
    expect(hit.isExcerpt).toBe(true)
    expect(hit.contentChars).toBe(raw.length - FAKE_SECRET.github.length + SECRET_MASK.length)
    expect(hit.content).toContain(SECRET_MASK)
    expect(renderSearchResult(result)).not.toContain(FAKE_SECRET.github)
  })

  it('名称含密钥的记忆给节选：不给路径，节选说明照常', async () => {
    const { store, search } = setup()
    await store.put(record({ id: 'mem_gw', name: `网关 ${FAKE_SECRET.github}`, content: filler(2500) }))
    const result = await search({ query: '' })
    expect(result.hits[0].isExcerpt).toBe(true)
    expect(result.hits[0].path).toBeUndefined()
    const text = renderSearchResult(result)
    expect(text.startsWith(`${EXCERPT_NOTE}\n\n`)).toBe(true)
    expect(text.split('\n\n')[1]!.split('\n')[0]).toMatch(/ · 节选，正文共 2500 字符$/)
    expect(text).not.toContain(FAKE_SECRET.github)
  })
})

describe('工具描述', () => {
  it('检索工具描述讲清全文和节选两种形态、怎么取全文，不写具体数值', () => {
    const { deps } = setup()
    const d = createSearchTool(deps()).description
    expect(d).toContain('节选')
    expect(d).toContain('正文总字符数')
    expect(d).toContain('按 id 查')
    expect(d).toContain('要看原文就直接读这个文件；正文给全文或其中一段（节选）。')
    expect(d).toContain('很长的记忆和排在后面的条目可能只给正文的一段')
    expect(d).not.toMatch(/\d/)
  })

  it('保存工具描述含更新前读全文的引导', () => {
    expect(registry.renderSaveDescription()).toContain('更新会替换整条正文，更新前先确认已读过目标记忆的全文。')
  })
})
