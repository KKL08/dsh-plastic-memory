import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileTable } from '../src/storage/file-table.ts'
import { encodeRecord } from '../src/storage/frontmatter.ts'
import { GLOBAL_DIR, WORKSPACE_MARKER, workspaceDirName } from '../src/storage/paths.ts'
import type { RecallStats } from '../src/storage/schema.ts'
import { MemoryStore } from '../src/store.ts'
import { prereadSnapshot } from '../src/runtime.ts'
import { assembleSnapshot } from '../src/snapshot.ts'
import { stalenessNote } from '../src/record-freshness.ts'
import { findTopicCandidates, topicGroupOf } from '../src/search/topic-context.ts'
import { dialogueNote, renderSearchSections } from '../src/search/dialogue-format.ts'
import { executeSearch, renderSearchResult, MATCH_BASIS, type SearchArgs, type SearchToolDeps } from '../src/tools/search.ts'
import { createSearchTool } from '../src/tools/search-tool.ts'
import { DialogueCallCap } from '../src/tools/dialogue-call-cap.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'
import { WEAK_SEARCH_NOTE_CODES, type SearchNoteCode } from '../src/contract-codes.ts'
import { SECRET_MASK } from '../src/secrets.ts'
import type { MemoryRecord } from '../src/record-schema.ts'
import { record } from './helpers/record.ts'
import { fakeExec } from './helpers/exec.ts'
import { InMemoryBatchKvTable } from './helpers/in-memory-kv.ts'
import { indexTree } from './helpers/topic-index.ts'
import { FAKE_SECRET } from './helpers/secrets.ts'
import { breakTopicIndex, removeTopicIndex, writeTopicIndex } from './helpers/topic-fixture.ts'

// memory_search 的主题检索：只给主题按索引顺序列出成员行并翻页；关键词检索的每条结果带所属主题和「同主题还有 N 条」，
// 关键词命中主题名、曾用名或说明时先给「匹配的主题」，零命中或命中弱时附主题目录；条数和注入同口径。
// 走工具执行器 executeSearch 和渲染 renderSearchResult；真实临时目录上的文件表，主题索引像用户手改那样直接写文件。

const T0 = 1_700_000_000_000
const DAY = 86_400_000
const WS = '/tmp/pm-search-topics-project'
const registry = buildTypeRegistry({ template: 'coding', customTypes: {} })

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'pm-search-topics-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

const globalDir = () => join(root, GLOBAL_DIR)
const wsDir = () => join(root, workspaceDirName(WS))

function env(extra: Partial<SearchToolDeps> = {}) {
  const stats = new InMemoryBatchKvTable<RecallStats>()
  const store = new MemoryStore(new FileTable({ root, stats, now: () => T0 }), undefined, stats)
  const deps: SearchToolDeps = {
    store, registry, now: () => T0,
    host: { contextOf: async () => ({ workspacePath: WS, session: { id: 's', lastSeq: 1 } }) },
    ...extra,
  }
  const search = (args: SearchArgs) => executeSearch(args, fakeExec(), deps)
  const recallCount = async (id: string) => (await stats.get(id))?.recallCount ?? 0
  return { store, deps, search, recallCount }
}

const mem = (id: string, partial: Partial<MemoryRecord> = {}) =>
  record({ id, name: `${id} 名称`, summary: `${id} 摘要`, content: `${id} 正文`, createdAt: T0 - DAY, updatedAt: T0 - DAY, lastConfirmedAt: T0 - DAY, ...partial })
const wsMem = (id: string, partial: Partial<MemoryRecord> = {}) => mem(id, { scope: 'workspace', workspacePath: WS, ...partial })

/** 按文件格式直接写进各自的目录（文件名就是 id），项目目录带标记。 */
async function seed(records: readonly MemoryRecord[]) {
  await mkdir(globalDir(), { recursive: true })
  if (records.some(r => r.scope !== 'global')) {
    await mkdir(wsDir(), { recursive: true })
    await writeFile(join(wsDir(), WORKSPACE_MARKER), WS, 'utf8')
  }
  for (const r of records) await writeFile(join(r.scope === 'global' ? globalDir() : wsDir(), `${r.id}.md`), encodeRecord(r, {}), 'utf8')
}

const ids = (hits: ReadonlyArray<{ id: string }>) => hits.map(h => h.id)
const rowIds = (r: Awaited<ReturnType<typeof executeSearch>>) => r.browse?.sections.flatMap(s => s.rows.map(row => row.id)) ?? []
const isWeakOrEmpty = (r: Awaited<ReturnType<typeof executeSearch>>) =>
  r.hits.length === 0 || (WEAK_SEARCH_NOTE_CODES as readonly (SearchNoteCode | undefined)[]).includes(r.noteCode)

/** 常用的一套：全局「发版流程」三条、「排查」一条、未整理一条；项目「发版流程」两条、未整理一条。 */
async function standard() {
  await seed([
    mem('g_rel1', { content: 'zebra 发版前先跑构建' }), mem('g_rel2', { content: '发版后写发布说明' }), mem('g_rel3', { type: 'preference', content: '发版用 pnpm publish' }),
    mem('g_dbg1', { content: '排查时先看日志 yak' }), mem('g_loose', { content: '零散的一条 zebra' }),
    wsMem('w_rel1', { content: '项目里的发版 zebra 走流水线' }), wsMem('w_rel2', { content: '项目发版要通知测试' }), wsMem('w_loose', { content: '项目零散 quokka' }),
  ])
  await writeTopicIndex(globalDir(), [
    { name: '发版流程', about: '发版、钉版与发布说明', aliases: ['驿站'], members: ['g_rel1', 'g_rel2', 'g_rel3'] },
    { name: '排查', about: '', members: ['g_dbg1'] },
  ], ['g_loose'])
  await writeTopicIndex(wsDir(), [{ name: '发版流程', about: '项目自己的发版约定', members: ['w_rel1', 'w_rel2'] }], ['w_loose'])
}

describe('只给主题：按索引顺序列出成员行', () => {
  it('只给 topic：按主题页里的先后列出成员行，带作用域、主题名、说明和条数；只有名称和摘要，不计召回', async () => {
    await standard()
    const e = env()
    const r = await e.search({ topic: '排查' })
    expect(r.noteCode).toBeUndefined()
    expect(r.hits).toEqual([])
    expect(r.browse?.total).toBe(1)
    expect(r.browse?.offset).toBe(0)
    expect(r.browse?.sections).toEqual([{
      topic: { scope: 'global', name: '排查', about: '', count: 1 },
      rows: [{ id: 'g_dbg1', line: expect.stringContaining('- [g_dbg1] g_dbg1 名称（g_dbg1 摘要）'), basis: MATCH_BASIS.topic }],
    }])
    expect(r.browse!.sections[0]!.rows[0]!.line).toContain(join(globalDir(), 'g_dbg1.md'))
    expect(r.browse!.sections[0]!.rows[0]!.line).not.toContain('排查时先看日志')
    expect(await e.recallCount('g_dbg1')).toBe(0)
    const text = renderSearchResult(r)
    expect(text).toContain('全局「排查」（1 条）')
    expect(text).toContain('- [g_dbg1] g_dbg1 名称（g_dbg1 摘要）')
    // 对照：同一条按关键词查到时照常计召回
    expect(ids((await e.search({ query: 'yak' })).hits)).toEqual(['g_dbg1'])
    expect(await e.recallCount('g_dbg1')).toBe(1)
  })

  it('主题页里的先后就是列出的先后，不按置信度或时间重排', async () => {
    await seed([mem('m_low', { confidence: 0.1 }), mem('m_high', { confidence: 0.99, lastConfirmedAt: T0 }), mem('m_mid', { confidence: 0.5 })])
    await writeTopicIndex(globalDir(), [{ name: '顺序', members: ['m_low', 'm_high', 'm_mid'] }])
    expect(rowIds(await env().search({ topic: '顺序' }))).toEqual(['m_low', 'm_high', 'm_mid'])
  })

  it('翻页：limit 控制每页条数，结果说明总数和下一页的 offset；最后一页不给下一页；offset 超过总数时说之后没有了', async () => {
    await standard()
    const e = env()
    const first = await e.search({ topic: '发版流程', scope: 'global', limit: 2 })
    expect(rowIds(first)).toEqual(['g_rel1', 'g_rel2'])
    expect(first.browse?.total).toBe(3)
    expect(first.moreNote).toBe('共 3 条，这次列出第 1–2 条。下一页用 offset: 2。')
    const last = await e.search({ topic: '发版流程', scope: 'global', limit: 2, offset: 2 })
    expect(rowIds(last)).toEqual(['g_rel3'])
    expect(last.browse?.offset).toBe(2)
    expect(last.moreNote).toBe('共 3 条，这次列出第 3 条。')
    const beyond = await e.search({ topic: '发版流程', scope: 'global', offset: 5 })
    expect(rowIds(beyond)).toEqual([])
    expect(beyond.moreNote).toBe('共 3 条，offset 5 之后没有了。')
    expect(renderSearchResult(first)).toContain('共 3 条，这次列出第 1–2 条。下一页用 offset: 2。')
  })

  it('不给 limit 时每页沿用检索的缺省条数 10', async () => {
    await seed(Array.from({ length: 12 }, (_, i) => mem(`m_${String(i).padStart(2, '0')}`)))
    await writeTopicIndex(globalDir(), [{ name: '多', members: Array.from({ length: 12 }, (_, i) => `m_${String(i).padStart(2, '0')}`) }])
    const r = await env().search({ topic: '多' })
    expect(rowIds(r)).toHaveLength(10)
    expect(r.moreNote).toBe('共 12 条，这次列出第 1–10 条。下一页用 offset: 10。')
  })

  it('曾用名也对得上；主题名去首尾空白、不分大小写', async () => {
    await standard()
    await writeTopicIndex(globalDir(), [{ name: 'Deploy 手册', aliases: ['发布'], members: ['g_rel1'] }], ['g_rel2', 'g_rel3', 'g_dbg1', 'g_loose'])
    const e = env()
    expect(rowIds(await e.search({ topic: '发布', scope: 'global' }))).toEqual(['g_rel1'])
    expect(rowIds(await e.search({ topic: '  deploy 手册 ', scope: 'global' }))).toEqual(['g_rel1'])
    expect((await e.search({ topic: '发布', scope: 'global' })).browse?.sections[0]?.topic.name).toBe('Deploy 手册')
  })

  it('「未整理」也能按名字列出：索引里的先后在前，索引里还没有行的接在后面', async () => {
    await seed([mem('u_b', { name: '乙' }), mem('u_a', { name: '甲' }), mem('u_new', { name: '丙' })])
    await writeTopicIndex(globalDir(), [], ['u_b', 'u_a'])
    const r = await env().search({ topic: '未整理', scope: 'global' })
    expect(rowIds(r)).toEqual(['u_b', 'u_a', 'u_new'])
    expect(r.browse?.sections[0]?.topic).toEqual({ scope: 'global', name: '未整理', about: '', count: 3 })
  })

  it('两个作用域有同名主题：分别列出，项目的在前、全局的在后，翻页按两段连起来算', async () => {
    await standard()
    const e = env()
    const r = await e.search({ topic: '发版流程' })
    expect(r.browse?.sections.map(s => s.topic)).toEqual([
      { scope: 'workspace', name: '发版流程', about: '项目自己的发版约定', count: 2 },
      { scope: 'global', name: '发版流程', about: '发版、钉版与发布说明', count: 3 },
    ])
    expect(rowIds(r)).toEqual(['w_rel1', 'w_rel2', 'g_rel1', 'g_rel2', 'g_rel3'])
    expect(r.browse?.total).toBe(5)
    const page = await e.search({ topic: '发版流程', limit: 2, offset: 1 })
    expect(page.browse?.sections.map(s => s.rows.map(row => row.id))).toEqual([['w_rel2'], ['g_rel1']])
    const text = renderSearchResult(r)
    expect(text.indexOf('本项目「发版流程」（2 条）：项目自己的发版约定')).toBeGreaterThanOrEqual(0)
    expect(text.indexOf('本项目「发版流程」（2 条）')).toBeLessThan(text.indexOf('全局「发版流程」（3 条）：发版、钉版与发布说明'))
  })

  it('scope 照现有语义限定看哪个作用域的主题', async () => {
    await standard()
    const e = env()
    expect(rowIds(await e.search({ topic: '发版流程', scope: 'global' }))).toEqual(['g_rel1', 'g_rel2', 'g_rel3'])
    expect(rowIds(await e.search({ topic: '发版流程', scope: 'workspace' }))).toEqual(['w_rel1', 'w_rel2'])
  })

  it('topic 配 types：只列这个主题里这几类的成员，总数按过滤之后算，分段标题的条数仍是整个主题的', async () => {
    await standard()
    const r = await env().search({ topic: '发版流程', scope: 'global', types: ['preference'] })
    expect(rowIds(r)).toEqual(['g_rel3'])
    expect(r.browse?.total).toBe(1)
    expect(r.browse?.sections[0]?.topic.count).toBe(3)
  })

  it('topic 配 query：在这个主题的成员里按关键词检索，排序照常、可以翻页；主题外的命中不出，照常计召回', async () => {
    await seed([
      mem('t_one', { content: 'zebra 一次' }), mem('t_three', { name: 'zebra', content: 'zebra zebra zebra' }), mem('t_none', { content: '没有那个词' }),
      mem('o_zebra', { content: 'zebra zebra 主题外' }),
    ])
    await writeTopicIndex(globalDir(), [{ name: '动物', members: ['t_one', 't_none', 't_three'] }], ['o_zebra'])
    const e = env()
    const r = await e.search({ topic: '动物', query: 'zebra' })
    expect(ids(r.hits)).toEqual(['t_three', 't_one'])
    expect(r.hits.every(h => h.basis === MATCH_BASIS.keyword)).toBe(true)
    expect(r.hits[0]?.topic).toEqual({ scope: 'global', name: '动物', others: 2 })
    expect(r.moreNote).toBe('共 2 条，这次列出第 1–2 条。')
    expect(r.matchedTopics).toBeUndefined()
    expect(r.catalog).toBeUndefined()
    expect(await e.recallCount('t_three')).toBe(1)
    const page = await e.search({ topic: '动物', query: 'zebra', limit: 1, offset: 1 })
    expect(ids(page.hits)).toEqual(['t_one'])
    expect(page.moreNote).toBe('共 2 条，这次列出第 2 条。')
  })

  it('范围内没有这个主题：说没有，附当下的主题目录', async () => {
    await standard()
    const r = await env().search({ topic: '不存在的主题' })
    expect(r.noteCode).toBe('topic-not-found')
    expect(r.note).toBe('范围内没有叫「不存在的主题」的主题（主题名和曾用名都比过）。')
    expect(r.browse).toBeUndefined()
    expect(r.catalog?.map(t => `${t.scope}/${t.name}`)).toEqual(['workspace/发版流程', 'workspace/未整理', 'global/发版流程', 'global/排查', 'global/未整理'])
  })

  it('只给主题走记忆这一路：设置是两者也不查原话、不占原话的连续调用名额', async () => {
    await standard()
    const callCap = new DialogueCallCap()
    const claim = vi.spyOn(callCap, 'claim')
    const e = env({ searchSource: () => 'both', callCap })
    // 对照：同样的设置下不给 topic 的关键词检索走两路，占一次名额（原话依赖没接，原话段说用不了）
    const plain = await e.search({ query: 'yak' })
    expect(plain.dialogueText).toBe(dialogueNote('dialogue-unavailable'))
    expect(claim).toHaveBeenCalledTimes(1)
    const browse = await e.search({ topic: '排查' })
    expect(rowIds(browse)).toEqual(['g_dbg1'])
    const inTopic = await e.search({ topic: '排查', query: 'yak' })
    expect(ids(inTopic.hits)).toEqual(['g_dbg1'])
    for (const r of [browse, inTopic]) {
      expect(r.dialogueText).toBeUndefined()
      expect(r.pathNote).toBeUndefined()
    }
    expect(claim).toHaveBeenCalledTimes(1)
  })
})

describe('关键词检索带主题信息', () => {
  it('每条结果带所属主题（含作用域）和「同主题还有 N 条」；头行写出来；「未整理」里的标「未整理」', async () => {
    await standard()
    const r = await env().search({ query: 'zebra' })
    const byId = new Map(r.hits.map(h => [h.id, h]))
    expect(byId.get('g_rel1')?.topic).toEqual({ scope: 'global', name: '发版流程', others: 2 })
    expect(byId.get('w_rel1')?.topic).toEqual({ scope: 'workspace', name: '发版流程', others: 1 })
    expect(byId.get('g_loose')?.topic).toEqual({ scope: 'global', name: '未整理', others: 0 })
    expect(r.hits.every(h => h.basis === MATCH_BASIS.keyword)).toBe(true)
    const head = renderSearchResult(r).split('\n').find(line => line.startsWith('[g_rel1]'))!
    expect(head).toContain(' · 主题：全局「发版流程」，同主题还有 2 条')
    expect(head.endsWith(join(globalDir(), 'g_rel1.md'))).toBe(true)
  })

  it('关键词命中主题名、曾用名或说明时，结果第一行给「匹配的主题」（带作用域和条数）；首版不因此给成员加分', async () => {
    await standard()
    const e = env()
    const byAlias = await e.search({ query: '驿站' })
    expect(byAlias.matchedTopics).toEqual([{ scope: 'global', name: '发版流程', about: '发版、钉版与发布说明', count: 3 }])
    expect(renderSearchResult(byAlias).split('\n')[0]).toBe('匹配的主题：全局「发版流程」（3 条）。')

    await seed([mem('k_member', { content: 'kiwi' }), mem('k_other', { name: 'kiwi', content: 'kiwi kiwi kiwi' })])
    await writeTopicIndex(globalDir(), [{ name: '水果', about: '和 kiwi 有关的约定', members: ['k_member'] }], ['k_other', 'g_rel1', 'g_rel2', 'g_rel3', 'g_dbg1', 'g_loose'])
    const withIndex = await e.search({ query: 'kiwi', scope: 'global' })
    expect(withIndex.matchedTopics?.map(t => t.name)).toEqual(['水果'])
    await removeTopicIndex(globalDir())
    const without = await e.search({ query: 'kiwi', scope: 'global' })
    expect(ids(withIndex.hits)).toEqual(ids(without.hits))
    expect(ids(withIndex.hits)[0]).toBe('k_other')
  })

  it('主题命中用记忆检索同一套 token 命中：查询里至少一个 token 对上就算，token 级子串也算（deploy 对上 Deployment）', async () => {
    await seed([mem('d1', { content: '无关' })])
    await writeTopicIndex(globalDir(), [{ name: 'Deployment 手册', members: ['d1'] }, { name: '别的', about: 'nothing here', members: [] }])
    const e = env()
    expect((await e.search({ query: 'deploy', scope: 'global' })).matchedTopics?.map(t => t.name)).toEqual(['Deployment 手册'])
    expect((await e.search({ query: 'deploy quasar', scope: 'global' })).matchedTopics?.map(t => t.name)).toEqual(['Deployment 手册'])
    expect((await e.search({ query: 'quasar', scope: 'global' })).matchedTopics).toEqual([])
  })

  it('「未整理」不参与主题命中', async () => {
    await seed([mem('n1')])
    await writeTopicIndex(globalDir(), [], ['n1'])
    expect((await env().search({ query: '未整理', scope: 'global' })).matchedTopics).toEqual([])
  })

  it('零命中时附当下的主题目录：项目在前、全局在后，每个作用域「未整理」最后，带条数和说明；渲染在最后', async () => {
    await standard()
    const r = await env().search({ query: 'nothingmatcheshere' })
    expect(r.hits).toEqual([])
    expect(r.catalog).toEqual([
      { scope: 'workspace', name: '发版流程', about: '项目自己的发版约定', count: 2 },
      { scope: 'workspace', name: '未整理', about: '', count: 1 },
      { scope: 'global', name: '发版流程', about: '发版、钉版与发布说明', count: 3 },
      { scope: 'global', name: '排查', about: '', count: 1 },
      { scope: 'global', name: '未整理', about: '', count: 1 },
    ])
    expect(renderSearchResult(r)).toBe([
      '没有匹配的记忆。',
      [
        '当下的主题目录（用 topic 参数传主题名可以列出某个主题下的全部记忆）：',
        '- 本项目「发版流程」（2 条）：项目自己的发版约定',
        '- 本项目「未整理」（1 条）',
        '- 全局「发版流程」（3 条）：发版、钉版与发布说明',
        '- 全局「排查」（1 条）',
        '- 全局「未整理」（1 条）',
      ].join('\n'),
    ].join('\n\n'))
  })

  it('命中弱（排第一的对上不到一半、只有子串命中）时附目录；有全命中、覆盖过半时不附', async () => {
    await seed([
      mem('w_full', { content: 'alpha beta' }), mem('w_alpha', { content: 'alpha only' }),
      mem('mem_prefix_target', { name: '前缀目标', summary: '摘要', content: '只能靠 id 子串找到' }),
    ])
    await writeTopicIndex(globalDir(), [{ name: '弱命中', members: ['w_full', 'w_alpha'] }], ['mem_prefix_target'])
    const e = env()
    const cases: SearchArgs[] = [
      { query: 'alpha beta', scope: 'global' },                 // 有全命中
      { query: 'alpha gamma', scope: 'global' },                // 首条覆盖一半，不算弱
      { query: 'alpha gamma delta epsilon', scope: 'global' },  // 首条覆盖不到一半
      { query: 'mem_prefix', scope: 'global' },                 // 只有子串命中
      { query: 'zzzz', scope: 'global' },                       // 零命中
    ]
    const results = await Promise.all(cases.map(args => e.search(args)))
    for (const r of results) expect(r.catalog !== undefined).toBe(isWeakOrEmpty(r))
    expect(results.map(r => r.catalog !== undefined)).toEqual([false, false, true, true, true])
    expect(results[2]!.noteCode).toBe('low-coverage')
    expect(results[3]!.noteCode).toBe('substring-fallback')
  })

  it('只给类型的现有用法不变：选出的记忆、先后、说明和没有索引时一样，不出匹配的主题和目录', async () => {
    await standard()
    const e = env()
    const cases: SearchArgs[] = [{ types: ['preference'] }, { query: '', types: ['knowledge'], limit: 2 }, { types: ['decision'] }]
    const withIndex = await Promise.all(cases.map(args => e.search(args)))
    await removeTopicIndex(globalDir())
    await removeTopicIndex(wsDir())
    const without = await Promise.all(cases.map(args => e.search(args)))
    for (const [i, r] of withIndex.entries()) {
      expect(ids(r.hits)).toEqual(ids(without[i]!.hits))
      expect([r.noteCode, r.note, r.moreNote]).toEqual([without[i]!.noteCode, without[i]!.note, without[i]!.moreNote])
      expect(r.hits.map(h => h.content)).toEqual(without[i]!.hits.map(h => h.content))
      expect(r.matchedTopics).toBeUndefined()
      expect(r.catalog).toBeUndefined()
    }
    expect(withIndex[2]!.noteCode).toBe('types-no-records')
    // 每条结果带所属主题这一条对只给类型的列出同样成立
    expect(withIndex[0]!.hits.length).toBeGreaterThan(0)
    expect(withIndex[0]!.hits.every(h => h.topic !== undefined && h.basis === MATCH_BASIS.keyword)).toBe(true)
  })

  it('范围内一个主题索引文件都没有、又没给 topic 时，结果和没有主题功能时一样：不带所属主题、命中依据，不出匹配的主题和目录', async () => {
    await standard()
    await removeTopicIndex(globalDir())
    await removeTopicIndex(wsDir())
    const e = env()
    const results = await Promise.all(([{ query: 'zebra' }, { query: 'nothingmatcheshere' }, { query: '发版流程' }] satisfies SearchArgs[]).map(args => e.search(args)))
    expect(ids(results[0]!.hits).sort()).toEqual(['g_loose', 'g_rel1', 'w_rel1'])
    for (const r of results) {
      for (const h of r.hits) expect(Object.keys(h).filter(k => k === 'topic' || k === 'basis')).toEqual([])
      expect(Object.keys(r).filter(k => ['matchedTopics', 'catalog', 'topicNote', 'browse'].includes(k))).toEqual([])
    }
    // 给了 topic 时照常读盘分组：没有索引文件的作用域全部算在「未整理」里，目录照样附上
    const browse = await e.search({ topic: '发版流程' })
    expect(browse.noteCode).toBe('topic-not-found')
    expect(browse.catalog).toEqual([
      { scope: 'workspace', name: '未整理', about: '', count: 3 },
      { scope: 'global', name: '未整理', about: '', count: 5 },
    ])
  })
})

describe('条数和注入同口径', () => {
  it('「同主题还有 N 条」、按主题列出的条数、匹配的主题和目录里的条数，都和注入的主题条数一样：只数已生效且没过期的，含单条设成不列入的', async () => {
    await seed([
      mem('c_a', { content: 'zebra 甲' }), mem('c_b'), mem('c_unlisted', { recall: 'unlisted' }), mem('c_core', { recall: 'core' }),
      mem('c_expired', { validTo: T0 - DAY }), mem('c_future', { validFrom: T0 + DAY }),
      // 同 id 两份：全局这份更新，按会话视角取全局，算在全局的主题里；项目「未整理」那一行跳过、不计数
      mem('c_dup', { updatedAt: T0 - 1000 }), wsMem('c_dup', { updatedAt: T0 - DAY }),
      mem('u_ok'), mem('u_expired', { validTo: T0 - DAY }), wsMem('w_one'),
    ])
    await writeTopicIndex(globalDir(), [{ name: '口径', about: '和 zebra 有关', members: ['c_a', 'c_b', 'c_unlisted', 'c_core', 'c_expired', 'c_future', 'c_dup'] }], ['u_ok', 'u_expired'])
    await writeTopicIndex(wsDir(), [], ['c_dup', 'w_one'])
    const e = env()

    const pre = await prereadSnapshot(e.store, WS)
    const injected = assembleSnapshot({ records: pre.records, files: pre.files, indexes: pre.indexes, registry, workspacePath: WS, budget: 100_000, now: T0 }).text
    const [wsPart, globalPart] = injected.split('## 全局记忆 · 主题目录')
    const countIn = (text: string, name: string) => Number(new RegExp(`### ${name}（(\\d+) 条`).exec(text)![1])
    expect(countIn(globalPart!, '口径')).toBe(5)
    expect(countIn(globalPart!, '未整理')).toBe(1)
    expect(countIn(wsPart!, '未整理')).toBe(1)

    const hit = (await e.search({ query: 'zebra' })).hits.find(h => h.id === 'c_a')
    expect(hit?.topic?.others).toBe(countIn(globalPart!, '口径') - 1)
    const browse = await e.search({ topic: '口径' })
    expect(browse.browse?.total).toBe(countIn(globalPart!, '口径'))
    expect(browse.browse?.sections[0]?.topic.count).toBe(countIn(globalPart!, '口径'))
    expect(rowIds(browse)).toEqual(['c_a', 'c_b', 'c_unlisted', 'c_core', 'c_dup'])
    // 过期、还没生效的成员跳过、不计数，也不算「读不到」
    expect(browse.topicNote).toBeUndefined()
    // 两层都读时，项目「未整理」页里的 c_dup 那一行被全局那份取走：跳过、不计数，同样不算「读不到」
    const visibleUnsorted = await e.search({ topic: '未整理' })
    const wsSection = visibleUnsorted.browse?.sections.find(s => s.topic.scope === 'workspace')
    expect(wsSection?.rows.map(row => row.id)).toEqual(['w_one'])
    expect(wsSection?.topic.count).toBe(countIn(wsPart!, '未整理'))
    expect(visibleUnsorted.topicNote).toBeUndefined()
    // 只读项目这一层时没有全局那份可取走，项目的 c_dup 照常在
    const wsUnsorted = await e.search({ topic: '未整理', scope: 'workspace' })
    expect(rowIds(wsUnsorted)).toEqual(['c_dup', 'w_one'])
    expect(wsUnsorted.browse?.sections[0]?.topic.count).toBe(2)
    expect(wsUnsorted.topicNote).toBeUndefined()
    expect((await e.search({ query: 'zebra' })).matchedTopics?.[0]?.count).toBe(countIn(globalPart!, '口径'))
    const catalog = (await e.search({ query: 'nothingmatcheshere' })).catalog!
    expect(catalog.find(t => t.scope === 'global' && t.name === '口径')?.count).toBe(countIn(globalPart!, '口径'))
    expect(catalog.find(t => t.scope === 'global' && t.name === '未整理')?.count).toBe(countIn(globalPart!, '未整理'))
    expect(catalog.find(t => t.scope === 'workspace' && t.name === '未整理')?.count).toBe(countIn(wsPart!, '未整理'))
  })
})

describe('索引读不全', () => {
  it('某个作用域的主题索引读不出：只给主题时说读不到，不说没有这个主题', async () => {
    await standard()
    await breakTopicIndex(globalDir())
    const e = env()
    const r = await e.search({ topic: '排查' })
    expect(r.noteCode).toBe('topic-index-unreadable')
    expect(r.note).toBe('这次读不到全局的主题索引，没法确定有没有叫「排查」的主题。可以改用关键词检索。')
    expect(r.note).not.toContain('没有叫「排查」的主题（')
  })

  it('一个作用域读不出、另一个读得到：读得到的照常列出，另说一句读不到哪个作用域', async () => {
    await standard()
    await breakTopicIndex(globalDir())
    const r = await env().search({ topic: '发版流程' })
    expect(r.noteCode).toBeUndefined()
    expect(rowIds(r)).toEqual(['w_rel1', 'w_rel2'])
    expect(r.topicNote).toBe('这次读不到全局的主题索引，这部分记忆不带主题信息。')
  })

  it('关键词检索照常返回命中：读不出的那个作用域不出所属主题、匹配的主题、目录，说明读不到；另一个作用域照常', async () => {
    await standard()
    await breakTopicIndex(globalDir())
    const r = await env().search({ query: 'zebra' })
    expect(ids(r.hits).sort()).toEqual(['g_loose', 'g_rel1', 'w_rel1'])
    expect(r.hits.find(h => h.id === 'g_rel1')?.topic).toBeUndefined()
    expect(r.hits.find(h => h.id === 'w_rel1')?.topic).toEqual({ scope: 'workspace', name: '发版流程', others: 1 })
    expect(r.topicNote).toBe('这次读不到全局的主题索引，这部分记忆不带主题信息。')
    expect(renderSearchResult(r)).toContain('这次读不到全局的主题索引，这部分记忆不带主题信息。')
    const empty = await env().search({ query: 'nothingmatcheshere' })
    expect(empty.catalog?.map(t => t.scope)).toEqual(['workspace', 'workspace'])
    expect((await env().search({ query: '驿站' })).matchedTopics).toEqual([])
  })

  it('主题页里有行指向的记忆不在或读不出：跳过这几行，写「有 N 行读不到」；全读到时不写', async () => {
    await seed([mem('ok_1'), mem('ok_2')])
    await writeFile(join(globalDir(), 'broken.md'), '这不是记忆文件\n', 'utf8')
    // gone 在页里出现两次：按去重后的 id 数
    await writeTopicIndex(globalDir(), [{ name: '缺行', members: ['ok_1', 'gone', 'broken', 'gone', 'ok_2'] }, { name: '完整', members: [] }])
    const e = env()
    const r = await e.search({ topic: '缺行' })
    expect(rowIds(r)).toEqual(['ok_1', 'ok_2'])
    expect(r.browse?.total).toBe(2)
    expect(r.topicNote).toBe('有 2 行读不到，已跳过。')
    expect(renderSearchResult(r)).toContain('有 2 行读不到，已跳过。')
    // 主题内关键词检索也写
    const inTopic = await e.search({ topic: '缺行', query: 'ok_1', match: 'all' })
    expect(ids(inTopic.hits)).toEqual(['ok_1'])
    expect(inTopic.topicNote).toBe('有 2 行读不到，已跳过。')
    const whole = await e.search({ topic: '完整' })
    expect(whole.browse?.sections.map(s => s.topic.name)).toEqual(['完整'])
    expect(whole.topicNote).toBeUndefined()
  })

  it('检索只读：前后两层的主题索引文件逐字节不变', async () => {
    await standard()
    const before = [await indexTree(globalDir()), await indexTree(wsDir())]
    const e = env()
    expect(rowIds(await e.search({ topic: '发版流程' }))).toHaveLength(5)
    for (const args of [{ topic: '发版流程' }, { query: 'zebra' }, { query: 'nothingmatcheshere' }, { topic: '未整理', limit: 1, offset: 1 }, { topic: '发版流程', query: 'zebra' }] satisfies SearchArgs[]) await e.search(args)
    expect([await indexTree(globalDir()), await indexTree(wsDir())]).toEqual(before)
  })
})

describe('外部写进来的主题文字', () => {
  it('主题名、说明里的密钥遮盖，尖括号换成全角、折成一行再进结果', async () => {
    await seed([mem('s1', { content: 'zebra' })])
    await writeTopicIndex(globalDir(), [{ name: '令牌 <b>', about: `存着 ${FAKE_SECRET.github} 的说明`, members: ['s1'] }])
    const e = env()
    const hit = (await e.search({ query: 'zebra', scope: 'global' })).hits[0]!
    expect(hit.topic?.name).toBe('令牌 ＜b＞')
    const catalog = (await e.search({ query: 'nothingmatcheshere', scope: 'global' })).catalog!
    expect(catalog[0]!.about).toContain(SECRET_MASK)
    expect(catalog[0]!.about).not.toContain(FAKE_SECRET.github)
    const browse = await e.search({ topic: '令牌 <b>', scope: 'global' })
    expect(renderSearchResult(browse)).not.toContain(FAKE_SECRET.github)
    expect(renderSearchResult(browse)).toContain('全局「令牌 ＜b＞」（1 条）')
  })

  it('成员行的名称和摘要照检索同一口径遮盖密钥', async () => {
    await seed([mem('s2', { summary: `摘要里有 ${FAKE_SECRET.github}` })])
    await writeTopicIndex(globalDir(), [{ name: '遮盖', members: ['s2'] }])
    const r = await env().search({ topic: '遮盖', scope: 'global' })
    expect(rowIds(r)).toEqual(['s2'])
    expect(r.browse!.sections[0]!.rows[0]!.line).not.toContain(FAKE_SECRET.github)
    expect(r.browse!.sections[0]!.rows[0]!.line).toContain(SECRET_MASK)
  })

  it('topic 只用来比名字：写成路径也不去读别的文件，照常说没有这个主题', async () => {
    await standard()
    const r = await env().search({ topic: '../../global/_index/topics/t0' })
    expect(r.noteCode).toBe('topic-not-found')
    expect(r.browse).toBeUndefined()
  })
})

describe('参数校验', () => {
  it('topic 也算「至少给一个」：只给 topic 合法；什么都不给时说明里列上 topic', async () => {
    await standard()
    const e = env()
    const r = await e.search({ topic: '排查' })
    expect(rowIds(r)).toEqual(['g_dbg1'])
    expect(r.noteCode).not.toBe('invalid-args')
    expect(await e.search({})).toMatchObject({ noteCode: 'invalid-args', note: '请填写 query、非空 types 或 topic，或用 id 配 history: true 或 version 查历史。' })
  })

  it('id 配 topic：参数错误，点出 id 和 topic', async () => {
    await standard()
    const e = env()
    expect(await e.search({ id: 'g_rel1', history: true, topic: '发版流程' })).toMatchObject({ noteCode: 'invalid-args', note: 'id 和 topic 对应历史与按主题浏览两种查询，请选择其中一种。' })
    // topic 是空串也算给了：先报 id 和 topic 冲突（同 query 的处理）
    expect(await e.search({ id: 'g_rel1', history: true, topic: '' })).toMatchObject({ noteCode: 'invalid-args', note: 'id 和 topic 对应历史与按主题浏览两种查询，请选择其中一种。' })
  })

  it('id 配 offset：参数错误，点出 id 和 offset', async () => {
    await standard()
    expect(await env().search({ id: 'g_rel1', history: true, offset: 1 })).toMatchObject({ noteCode: 'invalid-args', note: 'id 和 offset 不能一起用：offset 只用于配 topic 翻页。' })
  })

  it('offset 不带 topic：参数错误（关键词检索不翻页）', async () => {
    await standard()
    const e = env()
    expect(await e.search({ query: 'zebra', offset: 2 })).toMatchObject({ noteCode: 'invalid-args', note: '使用 offset 翻页时请同时填写 topic；关键词检索用 limit 控制条数。' })
    expect(await e.search({ types: ['knowledge'], offset: 0 })).toMatchObject({ noteCode: 'invalid-args' })
  })

  it('offset 不是不小于 0 的整数、topic 是空串或只有空白：参数错误', async () => {
    await standard()
    const e = env()
    for (const offset of [-1, 1.5, Number.NaN]) {
      expect(await e.search({ topic: '排查', offset })).toMatchObject({ noteCode: 'invalid-args', note: 'offset 请填写不小于 0 的整数。' })
    }
    for (const topic of ['', '   ']) {
      expect(await e.search({ topic })).toMatchObject({ noteCode: 'invalid-args', note: '请在 topic 中填写主题名。' })
    }
  })

  it('topic 配 source 是 dialogue 或 both：参数错误；配 memory 合法', async () => {
    await standard()
    const e = env()
    for (const source of ['dialogue', 'both'] as const) {
      expect(await e.search({ topic: '排查', source })).toMatchObject({ noteCode: 'invalid-args', note: 'topic 只查记忆，source 请设为 memory 或不传。' })
    }
    expect(rowIds(await e.search({ topic: '排查', source: 'memory' }))).toEqual(['g_dbg1'])
  })
})

describe('工具形状', () => {
  it('memory_search 的参数里有 topic（字符串）和 offset（数字），都不必填；工具说明里讲了 topic 的用法', async () => {
    const e = env()
    const tool = createSearchTool(e.deps)
    const parameters = tool.parameters as { properties: Record<string, { type?: string; description?: string }>; required?: string[] }
    expect(parameters.properties.topic?.type).toBe('string')
    expect(parameters.properties.offset?.type).toBe('number')
    expect(parameters.required ?? []).not.toContain('topic')
    expect(parameters.required ?? []).not.toContain('offset')
    expect(tool.description).toContain('topic')
  })
})

/** 主题内关键词检索用的一套（全局）：「甲」一条全命中、一条只有 alpha；「乙」一条只有 alpha；主题外两条各带 beta、gamma。 */
async function inTopicSeed() {
  await seed([
    mem('t_full', { content: 'alpha beta' }), mem('t_part', { content: 'alpha 二' }), mem('p_only', { content: 'alpha 三' }),
    mem('o_beta', { content: 'beta 外' }), mem('o_gamma', { content: 'gamma 外' }),
  ])
  await writeTopicIndex(globalDir(), [{ name: '甲', members: ['t_full', 't_part'] }, { name: '乙', members: ['p_only'] }], ['o_beta', 'o_gamma'])
}

describe('主题内关键词检索的说明和翻页', () => {
  it('offset 越过尾页且 match: all：不报 all-no-hit，只说之后没有了；主题内一条全命中都没有时才报 all-no-hit，逐词条数只数主题内', async () => {
    await inTopicSeed()
    const e = env()
    const all = await e.search({ topic: '甲', query: 'alpha beta', match: 'all', scope: 'global' })
    expect(ids(all.hits)).toEqual(['t_full'])
    expect(all.moreNote).toBe('共 1 条，这次列出第 1 条。')
    const beyond = await e.search({ topic: '甲', query: 'alpha beta', match: 'all', scope: 'global', offset: 5 })
    expect(beyond.hits).toEqual([])
    expect(beyond.noteCode).toBeUndefined()
    expect(beyond.note).toBeUndefined()
    expect(beyond.moreNote).toBe('共 1 条，offset 5 之后没有了。')
    // 「乙」里只有 alpha：主题外的 o_beta 含 beta，但逐词条数只数主题内
    const none = await e.search({ topic: '乙', query: 'alpha beta', match: 'all', scope: 'global' })
    expect(none.hits).toEqual([])
    expect(none.noteCode).toBe('all-no-hit')
    expect(none.note).toBe('没有记忆同时含全部关键词。\n各关键词命中的记忆条数：alpha 1、beta 0。范围内一条都没命中的：beta。\n改用 match: "any" 可以看部分命中的结果。')
    expect(none.moreNote).toBeUndefined()
  })

  it('id 直达只认整个列表的第一条：第二页的第一条照常标命中情况，不出说明码', async () => {
    await seed([mem('mem_direct', { name: '直达', summary: '直达摘要', content: '直达正文' }), mem('mem_direct_b', { name: '乙', summary: '乙摘要', content: '乙正文' })])
    await writeTopicIndex(globalDir(), [{ name: '直达主题', members: ['mem_direct', 'mem_direct_b'] }])
    const e = env()
    const first = await e.search({ topic: '直达主题', query: 'mem_direct', scope: 'global', limit: 1 })
    expect(ids(first.hits)).toEqual(['mem_direct'])
    expect(first.hits[0]!.matchNote).toBe('')
    expect(first.noteCode).toBeUndefined()
    expect(first.moreNote).toBe('共 2 条，这次列出第 1 条。下一页用 offset: 1。')
    const second = await e.search({ topic: '直达主题', query: 'mem_direct', scope: 'global', limit: 1, offset: 1 })
    expect(ids(second.hits)).toEqual(['mem_direct_b'])
    expect(second.hits[0]!.matchNote).toBe(' · 仅子串命中')
    expect(second.noteCode).toBeUndefined()
    expect(second.note).toBeUndefined()
    expect(second.moreNote).toBe('共 2 条，这次列出第 2 条。')
  })

  it('说明码按第一页定：第一页有全命中时，第二页只剩部分命中也不出 or-fallback', async () => {
    await inTopicSeed()
    const e = env()
    const first = await e.search({ topic: '甲', query: 'alpha beta', scope: 'global', limit: 1 })
    expect(ids(first.hits)).toEqual(['t_full'])
    expect(first.noteCode).toBeUndefined()
    const second = await e.search({ topic: '甲', query: 'alpha beta', scope: 'global', limit: 1, offset: 1 })
    expect(ids(second.hits)).toEqual(['t_part'])
    expect(second.hits[0]!.matchNote).toBe(' · 匹配：alpha')
    expect(second.noteCode).toBeUndefined()
    expect(second.note).toBeUndefined()
    expect(second.moreNote).toBe('共 2 条，这次列出第 2 条。')
  })

  it('主题内零命中：不出翻页说明，照关键词检索写「没有匹配的记忆。」；有读不到的说明时它在前', async () => {
    await inTopicSeed()
    const e = env()
    expect(ids((await e.search({ query: 'gamma', scope: 'global' })).hits)).toEqual(['o_gamma'])
    expect(ids((await e.search({ topic: '乙', query: 'alpha', scope: 'global' })).hits)).toEqual(['p_only'])
    const r = await e.search({ topic: '乙', query: 'gamma', scope: 'global' })
    expect(r.hits).toEqual([])
    expect([r.noteCode, r.note, r.moreNote, r.topicNote, r.matchedTopics, r.catalog]).toEqual([undefined, undefined, undefined, undefined, undefined, undefined])
    expect(renderSearchResult(r)).toBe('没有匹配的记忆。')
    // 项目这一层的索引读不出
    await mkdir(wsDir(), { recursive: true })
    await writeFile(join(wsDir(), WORKSPACE_MARKER), WS, 'utf8')
    await breakTopicIndex(wsDir())
    const withNote = await e.search({ topic: '乙', query: 'gamma' })
    expect(withNote.hits).toEqual([])
    expect(withNote.topicNote).toBe('这次读不到本项目的主题索引，这部分记忆不带主题信息。')
    expect(withNote.moreNote).toBeUndefined()
    expect(renderSearchResult(withNote)).toBe('这次读不到本项目的主题索引，这部分记忆不带主题信息。\n\n没有匹配的记忆。')
  })

  it('逐词命中条数只数主题内的候选：主题外有命中而主题内没有的词记 0', async () => {
    await inTopicSeed()
    const r = await env().search({ topic: '乙', query: 'alpha gamma delta epsilon', scope: 'global' })
    expect(ids(r.hits)).toEqual(['p_only'])
    expect(r.noteCode).toBe('low-coverage')
    expect(r.note).toBe('没有记忆同时含全部关键词，排第一的对上的查询内容不到一半，以下按相关性排序。命中弱，可以换同义词、换成另一种语言的写法、减少词数或换个角度再搜一次。\n各关键词命中的记忆条数：alpha 1、gamma 0、delta 0、epsilon 0。范围内一条都没命中的：gamma、delta、epsilon。')
  })
})

/** 匹配的主题、读不到项目索引的说明、全局的主题目录同时出现时，记忆这一段该渲染成的样子。 */
const ALL_THREE = [
  '匹配的主题：全局「发版流程」（3 条）。\n这次读不到本项目的主题索引，这部分记忆不带主题信息。',
  '没有匹配的记忆。',
  [
    '当下的主题目录（用 topic 参数传主题名可以列出某个主题下的全部记忆）：',
    '- 全局「发版流程」（3 条）：发版、钉版与发布说明',
    '- 全局「排查」（1 条）',
    '- 全局「未整理」（1 条）',
  ].join('\n'),
].join('\n\n')

describe('渲染的块结构', () => {
  it('零命中时依次是：匹配的主题和读不到的说明、「没有匹配的记忆。」、主题目录', async () => {
    await standard()
    await breakTopicIndex(wsDir())
    const r = await env().search({ query: '驿站' })
    expect(r.hits).toEqual([])
    expect(r.matchedTopics?.map(t => t.name)).toEqual(['发版流程'])
    expect(r.topicNote).toBeDefined()
    expect(r.catalog).toHaveLength(3)
    expect(renderSearchResult(r)).toBe(ALL_THREE)
  })

  it('两路都查时（原话这一路用不了），记忆段照样带匹配的主题、读不到的说明和目录', async () => {
    await standard()
    await breakTopicIndex(wsDir())
    const r = await env({ searchSource: () => 'both' }).search({ query: '驿站' })
    expect(r.dialogueText).toBe(dialogueNote('dialogue-unavailable'))
    expect(r.onlyDialogue).not.toBe(true)
    expect(renderSearchResult(r)).toBe(renderSearchSections({ memories: ALL_THREE, dialogue: r.dialogueText }))
  })

  it('设置只查记忆而参数要两者时（结果带 pathNote），记忆段照样带三样', async () => {
    await standard()
    await breakTopicIndex(wsDir())
    const r = await env({ searchSource: () => 'memory' }).search({ query: '驿站', source: 'both' })
    expect(r.pathNote).toBe(dialogueNote('dialogue-source-off'))
    expect(renderSearchResult(r)).toBe(`${dialogueNote('dialogue-source-off')}\n${ALL_THREE}`)
  })
})

describe('组合与翻页边界', () => {
  it('topic 配空串或只有空白的 query：按主题列出', async () => {
    await standard()
    const e = env()
    for (const query of ['', '  \t ']) {
      const r = await e.search({ topic: '排查', query })
      expect(r.hits).toEqual([])
      expect(rowIds(r)).toEqual(['g_dbg1'])
      expect(r.moreNote).toBe('共 1 条，这次列出第 1 条。')
    }
  })

  it('topic 配 history 或 version 而不带 id：仍是现有的缺 id 错误', async () => {
    await standard()
    const e = env()
    expect(await e.search({ topic: '排查', history: true })).toMatchObject({ noteCode: 'invalid-args', note: '使用 history: true 时请同时填写 id。' })
    expect(await e.search({ topic: '排查', version: 'v1' })).toMatchObject({ noteCode: 'invalid-args', note: '使用 version 时请同时填写 id。' })
  })

  it('topic 配 match: all：按主题列出不受影响，主题内关键词检索只留全命中', async () => {
    await inTopicSeed()
    const e = env()
    expect(rowIds(await e.search({ topic: '甲', scope: 'global' }))).toEqual(['t_full', 't_part'])
    expect(rowIds(await e.search({ topic: '甲', scope: 'global', match: 'all' }))).toEqual(['t_full', 't_part'])
    expect(ids((await e.search({ topic: '甲', query: 'alpha beta', scope: 'global' })).hits)).toEqual(['t_full', 't_part'])
    expect(ids((await e.search({ topic: '甲', query: 'alpha beta', scope: 'global', match: 'all' })).hits)).toEqual(['t_full'])
  })

  it('topic 配 types 一条都对不上：列出 0 条、分段标题照出，不出 types-no-records；成员全不可用时同样写「共 0 条。」', async () => {
    await standard()
    await seed([mem('g_exp', { validTo: T0 - DAY })])
    await writeTopicIndex(globalDir(), [
      { name: '发版流程', about: '发版、钉版与发布说明', aliases: ['驿站'], members: ['g_rel1', 'g_rel2', 'g_rel3'] },
      { name: '排查', about: '', members: ['g_dbg1'] },
      { name: '过期', members: ['g_exp'] },
    ], ['g_loose'])
    const e = env()
    expect((await e.search({ types: ['decision'], scope: 'global' })).noteCode).toBe('types-no-records')
    const r = await e.search({ topic: '发版流程', scope: 'global', types: ['decision'] })
    expect(r.noteCode).toBeUndefined()
    expect(r.browse).toEqual({ sections: [{ topic: { scope: 'global', name: '发版流程', about: '发版、钉版与发布说明', count: 3 }, rows: [] }], total: 0, offset: 0 })
    expect(r.moreNote).toBe('共 0 条。')
    expect(renderSearchResult(r)).toBe('共 0 条。\n\n全局「发版流程」（3 条）：发版、钉版与发布说明')
    const expired = await e.search({ topic: '过期', scope: 'global' })
    expect(expired.noteCode).toBeUndefined()
    expect(expired.browse).toEqual({ sections: [{ topic: { scope: 'global', name: '过期', about: '', count: 0 }, rows: [] }], total: 0, offset: 0 })
    expect(expired.moreNote).toBe('共 0 条。')
  })

  it('limit 超过上限按 50 条一页', async () => {
    const many = Array.from({ length: 55 }, (_, i) => `m_${String(i).padStart(2, '0')}`)
    await seed(many.map(id => mem(id)))
    await writeTopicIndex(globalDir(), [{ name: '大', members: many }])
    const r = await env().search({ topic: '大', scope: 'global', limit: 100 })
    expect(rowIds(r)).toEqual(many.slice(0, 50))
    expect(r.moreNote).toBe('共 55 条，这次列出第 1–50 条。下一页用 offset: 50。')
  })

  it('offset 正好等于总数：说之后没有了，分段照样在', async () => {
    await standard()
    const r = await env().search({ topic: '发版流程', scope: 'global', offset: 3 })
    expect(rowIds(r)).toEqual([])
    expect(r.browse?.total).toBe(3)
    expect(r.browse?.sections.map(s => s.topic.name)).toEqual(['发版流程'])
    expect(r.moreNote).toBe('共 3 条，offset 3 之后没有了。')
  })

  it('跨作用域翻页：这一页没有行的分段照样在', async () => {
    await standard()
    const e = env()
    const first = await e.search({ topic: '发版流程', limit: 2 })
    expect(first.browse?.sections.map(s => [s.topic.scope, s.rows.map(row => row.id)])).toEqual([['workspace', ['w_rel1', 'w_rel2']], ['global', []]])
    expect(first.moreNote).toBe('共 5 条，这次列出第 1–2 条。下一页用 offset: 2。')
    const second = await e.search({ topic: '发版流程', limit: 2, offset: 2 })
    expect(second.browse?.sections.map(s => [s.topic.scope, s.rows.map(row => row.id)])).toEqual([['workspace', []], ['global', ['g_rel1', 'g_rel2']]])
  })
})

describe('没有索引文件的作用域', () => {
  it('一个作用域有索引、另一个没有：没有的那个的记录算在它的「未整理」里，命中带主题，目录里也有它', async () => {
    await standard()
    await removeTopicIndex(wsDir())
    const e = env()
    const r = await e.search({ query: 'zebra' })
    expect(r.hits.find(h => h.id === 'w_rel1')?.topic).toEqual({ scope: 'workspace', name: '未整理', others: 2 })
    expect(r.hits.find(h => h.id === 'g_rel1')?.topic).toEqual({ scope: 'global', name: '发版流程', others: 2 })
    expect((await e.search({ query: 'nothingmatcheshere' })).catalog).toEqual([
      { scope: 'workspace', name: '未整理', about: '', count: 3 },
      { scope: 'global', name: '发版流程', about: '发版、钉版与发布说明', count: 3 },
      { scope: 'global', name: '排查', about: '', count: 1 },
      { scope: 'global', name: '未整理', about: '', count: 1 },
    ])
    // 没有索引的「未整理」按名称排
    expect(rowIds(await e.search({ topic: '未整理', scope: 'workspace' }))).toEqual(['w_loose', 'w_rel1', 'w_rel2'])
  })

  it('范围内一个索引文件都没有、给了 topic：照常读盘，两个作用域的「未整理」都能列出来', async () => {
    await standard()
    await removeTopicIndex(globalDir())
    await removeTopicIndex(wsDir())
    const r = await env().search({ topic: '未整理' })
    expect(r.noteCode).toBeUndefined()
    expect(r.browse?.sections.map(s => s.topic)).toEqual([
      { scope: 'workspace', name: '未整理', about: '', count: 3 },
      { scope: 'global', name: '未整理', about: '', count: 5 },
    ])
    expect(rowIds(r)).toEqual(['w_loose', 'w_rel1', 'w_rel2', 'g_dbg1', 'g_loose', 'g_rel1', 'g_rel2', 'g_rel3'])
    expect(r.topicNote).toBeUndefined()
  })

  it('项目还没有目录：目录里照注入写本项目「未整理」（0 条）', async () => {
    await seed([mem('g_one', { content: 'zebra' })])
    await writeTopicIndex(globalDir(), [{ name: '一个', members: ['g_one'] }])
    const e = env()
    const pre = await prereadSnapshot(e.store, WS)
    const injected = assembleSnapshot({ records: pre.records, files: pre.files, indexes: pre.indexes, registry, workspacePath: WS, budget: 100_000, now: T0 }).text
    expect(injected.split('## 全局记忆 · 主题目录')[0]).toContain('### 未整理（0 条）')
    expect((await e.search({ query: 'nothingmatcheshere' })).catalog).toEqual([
      { scope: 'workspace', name: '未整理', about: '', count: 0 },
      { scope: 'global', name: '一个', about: '', count: 1 },
      { scope: 'global', name: '未整理', about: '', count: 0 },
    ])
  })
})

describe('索引读不全（补充）', () => {
  it('项目目录读不出：只给主题时说读不到本项目的主题索引，不说没有；全局照常列出并说明', async () => {
    await standard()
    const e = env()
    expect(rowIds(await e.search({ topic: '发版流程', scope: 'workspace' }))).toEqual(['w_rel1', 'w_rel2'])
    await chmod(wsDir(), 0o000)
    try {
      const r = await e.search({ topic: '发版流程', scope: 'workspace' })
      expect(r.noteCode).toBe('topic-index-unreadable')
      expect(r.note).toBe('这次读不到本项目的主题索引，没法确定有没有叫「发版流程」的主题。可以改用关键词检索。')
      const visible = await e.search({ topic: '发版流程' })
      expect(rowIds(visible)).toEqual(['g_rel1', 'g_rel2', 'g_rel3'])
      expect(visible.topicNote).toBe('这次读不到本项目的主题索引，这部分记忆不带主题信息。')
    } finally {
      await chmod(wsDir(), 0o755)  // 恢复权限，否则 afterEach 的 rm 会失败
    }
  })

  it('读不到的作用域和读不到的行同时有：读不到作用域那句在前，换行接行数那句；主题内关键词检索同样', async () => {
    await standard()
    await breakTopicIndex(globalDir())
    await writeTopicIndex(wsDir(), [{ name: '发版流程', about: '项目自己的发版约定', members: ['w_rel1', 'gone_ws', 'w_rel2'] }], ['w_loose'])
    const e = env()
    const r = await e.search({ topic: '发版流程' })
    expect(rowIds(r)).toEqual(['w_rel1', 'w_rel2'])
    expect(r.topicNote).toBe('这次读不到全局的主题索引，这部分记忆不带主题信息。\n有 1 行读不到，已跳过。')
    expect(renderSearchResult(r).startsWith('这次读不到全局的主题索引，这部分记忆不带主题信息。\n有 1 行读不到，已跳过。\n共 2 条，这次列出第 1–2 条。\n\n本项目「发版流程」（2 条）：项目自己的发版约定\n')).toBe(true)
    const inTopic = await e.search({ topic: '发版流程', query: 'zebra' })
    expect(ids(inTopic.hits)).toEqual(['w_rel1'])
    expect(inTopic.topicNote).toBe('这次读不到全局的主题索引，这部分记忆不带主题信息。\n有 1 行读不到，已跳过。')
  })
})

describe('外部写进来的文字（补充）', () => {
  it('topic 参数带密钥、换行、尖括号：没找到和读不到两种说明里回显遮盖、折行、换全角后的写法', async () => {
    await standard()
    const e = env()
    const topic = `a\n<b> ${FAKE_SECRET.github}`
    const missing = await e.search({ topic })
    expect(missing.noteCode).toBe('topic-not-found')
    expect(missing.note).toBe(`范围内没有叫「a ＜b＞ ${SECRET_MASK}」的主题（主题名和曾用名都比过）。`)
    await breakTopicIndex(globalDir())
    const unreadable = await e.search({ topic, scope: 'global' })
    expect(unreadable.noteCode).toBe('topic-index-unreadable')
    expect(unreadable.note).toBe(`这次读不到全局的主题索引，没法确定有没有叫「a ＜b＞ ${SECRET_MASK}」的主题。可以改用关键词检索。`)
    for (const r of [missing, unreadable]) expect(renderSearchResult(r)).not.toContain(FAKE_SECRET.github)
  })

  it('成员名称带密钥：成员行不给文件路径', async () => {
    await seed([mem('s3', { name: `名称带 ${FAKE_SECRET.github}` }), mem('s4')])
    await writeTopicIndex(globalDir(), [{ name: '遮盖路径', members: ['s3', 's4'] }])
    const rows = (await env().search({ topic: '遮盖路径', scope: 'global' })).browse!.sections[0]!.rows
    expect(rows.map(row => row.id)).toEqual(['s3', 's4'])
    expect(rows[1]!.line).toContain(join(globalDir(), 's4.md'))
    expect(rows[0]!.line).toContain(SECRET_MASK)
    expect(rows[0]!.line).not.toContain(FAKE_SECRET.github)
    expect(rows[0]!.line).not.toContain(join(globalDir(), 's3.md'))
  })

  it('主题名和说明都带密钥和尖括号：匹配的主题、目录、按主题列出都遮盖；原样填入遮盖后的显示名也能列出', async () => {
    await seed([mem('s5', { content: 'zebra' })])
    await writeTopicIndex(globalDir(), [{ name: `令牌 <b> ${FAKE_SECRET.github}`, about: `存着 ${FAKE_SECRET.github} 的 <i>说明</i>`, members: ['s5'] }])
    const e = env()
    const shown = { scope: 'global', name: `令牌 ＜b＞ ${SECRET_MASK}`, about: `存着 ${SECRET_MASK} 的 ＜i＞说明＜/i＞`, count: 1 }
    const r = await e.search({ query: '令牌', scope: 'global' })
    expect(r.hits).toEqual([])
    expect(r.matchedTopics).toEqual([shown])
    expect(r.catalog).toEqual([shown, { scope: 'global', name: '未整理', about: '', count: 0 }])
    const text = renderSearchResult(r)
    for (const raw of [FAKE_SECRET.github, '<b>', '<i>']) expect(text).not.toContain(raw)
    const browse = await e.search({ topic: shown.name, scope: 'global' })
    expect(rowIds(browse)).toEqual(['s5'])
    expect(browse.browse?.sections[0]?.topic).toEqual(shown)
    expect(renderSearchResult(browse)).not.toContain(FAKE_SECRET.github)
  })

  it('按主题列出的行带陈旧标注', async () => {
    const stale = mem('st_old', { type: 'knowledge', lastConfirmedAt: T0 - 200 * DAY })
    await seed([stale, mem('st_new', { type: 'knowledge' })])
    await writeTopicIndex(globalDir(), [{ name: '陈旧', members: ['st_old', 'st_new'] }])
    const note = stalenessNote(stale, registry.get('knowledge').decayDays, T0)
    expect(note).not.toBe('')
    const rows = (await env().search({ topic: '陈旧', scope: 'global' })).browse!.sections[0]!.rows
    expect(rows.map(row => row.id)).toEqual(['st_old', 'st_new'])
    expect(rows[0]!.line).toContain(note)
    expect(rows[1]!.line).not.toContain(note)
  })

  it('手改的主题页也叫「未整理」：带区分的显示名只列这一页，「未整理」两组都列', async () => {
    await seed([mem('x1'), mem('x2')])
    await writeTopicIndex(globalDir(), [{ name: '未整理', members: ['x1'] }], ['x2'])
    const e = env()
    const marked = await e.search({ topic: '未整理（同名主题）', scope: 'global' })
    expect(rowIds(marked)).toEqual(['x1'])
    expect(marked.browse?.sections.map(s => s.topic.name)).toEqual(['未整理（同名主题）'])
    const both = await e.search({ topic: '未整理', scope: 'global' })
    expect(both.browse?.sections.map(s => s.topic.name)).toEqual(['未整理（同名主题）', '未整理'])
    expect(rowIds(both)).toEqual(['x1', 'x2'])
  })
})

describe('带主题的取候选（findTopicCandidates、topicGroupOf）', () => {
  const visible = { kind: 'visible' as const, workspacePath: WS }
  const deps = () => ({ store: env().store, now: () => T0 })
  const keys = (groups: ReadonlyArray<{ scope: string; name: string }>) => groups.map(g => `${g.scope}/${g.name}`)

  it('候选为空时主题信息照样填好：两个作用域各自成组，项目在前，「未整理」各在本作用域最后', async () => {
    await standard()
    const found = await findTopicCandidates({ query: 'nothingmatcheshere', scope: visible }, deps())
    expect(found.candidates).toEqual([])
    expect(keys(found.topics.groups)).toEqual(['workspace/发版流程', 'workspace/未整理', 'global/发版流程', 'global/排查', 'global/未整理'])
    expect(found.topics.groups.map(g => g.members.map(r => r.id))).toEqual([['w_rel1', 'w_rel2'], ['w_loose'], ['g_rel1', 'g_rel2', 'g_rel3'], ['g_dbg1'], ['g_loose']])
    expect(found.topics.groups.map(g => g.unreadableRows)).toEqual([0, 0, 0, 0, 0])
    expect(found.topics.unreadable).toEqual([])
    expect(found.topics.matched).toEqual([])
    expect(found.topics.browsed).toBeUndefined()
    expect(found.at).toBe(T0)
  })

  it('读不出的作用域进 unreadable、没有组；关键词命中主题说明的组进 matched', async () => {
    await standard()
    await breakTopicIndex(globalDir())
    const found = await findTopicCandidates({ query: '项目自己的发版约定', scope: visible }, deps())
    expect(found.topics.unreadable).toEqual(['global'])
    expect(keys(found.topics.groups)).toEqual(['workspace/发版流程', 'workspace/未整理'])
    expect(keys(found.topics.matched)).toEqual(['workspace/发版流程'])
  })

  it('browsed 认主题名和曾用名（去首尾空白、不分大小写）；只给主题时候选是可用成员，tier 为 all', async () => {
    await standard()
    const byAlias = await findTopicCandidates({ query: '', scope: visible, topic: '驿站' }, deps())
    expect(keys(byAlias.topics.browsed!)).toEqual(['global/发版流程'])
    const byName = await findTopicCandidates({ query: '', scope: visible, topic: '  发版流程 ' }, deps())
    expect(keys(byName.topics.browsed!)).toEqual(['workspace/发版流程', 'global/发版流程'])
    expect(byName.candidates.map(c => [c.record.id, c.tier, c.tokenHits])).toEqual(
      ['w_rel1', 'w_rel2', 'g_rel1', 'g_rel2', 'g_rel3'].map(id => [id, 'all', []]))
    expect(byName.candidates[2]!.filePath).toBe(join(globalDir(), 'g_rel1.md'))
    expect(byName.isDirectHit).toBe(false)
    expect(byName.topics.matched).toEqual([])
  })

  it('topicGroupOf 按作用域加 id 找组：同 id 换个作用域找不到', async () => {
    await standard()
    const { topics } = await findTopicCandidates({ query: '', scope: visible }, deps())
    const g = topics.groups.find(x => x.scope === 'global' && x.name === '发版流程')!
    const rec = g.members[0]!
    expect(topicGroupOf(topics, rec)).toBe(g)
    expect(topicGroupOf(topics, { ...rec, scope: 'workspace', workspacePath: WS })).toBeUndefined()
    expect(topicGroupOf(topics, mem('nowhere'))).toBeUndefined()
  })
})
