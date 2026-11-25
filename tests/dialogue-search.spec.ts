import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DialogueRecordStore } from '../src/storage/dialogue-records.ts'
import { dialogueTokenizer } from '../src/search/dialogue-tokenizer.ts'
import { DialogueCatchup } from '../src/tools/dialogue-catchup.ts'
import { executeSearch, renderSearchResult, type SearchToolDeps, type SearchContext } from '../src/tools/search.ts'
import { executeSource, renderSourceResult } from '../src/tools/source.ts'
import { createSearchTool } from '../src/tools/search-tool.ts'
import { DIALOGUE_SECTION_HEADING, MEMORY_SECTION_HEADING } from '../src/search/dialogue-format.ts'
import { NoReviewList } from '../src/storage/no-review.ts'
import { MemoryStore } from '../src/store.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'
import { InMemoryTable } from './helpers/in-memory-table.ts'
import { InMemoryBatchKvTable } from './helpers/in-memory-kv.ts'
import { sourceHost, sessionLog, user } from './helpers/source-host.ts'
import { fakeExec } from './helpers/exec.ts'
import { record } from './helpers/record.ts'
let dir: string
let db: DialogueRecordStore
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'dialogue-search-')); db = new DialogueRecordStore({ path: join(dir, 'db'), log: { info() {}, warn() {}, error() {} } }) })
afterEach(async () => { db.close(); await rm(dir, { recursive: true, force: true }) })
async function setup(complete = true) {
  const tokenizer = await dialogueTokenizer({ log: { warn() {} } })
  const state = db.prepare({ segmentRule: 1, tokenizer: 1, intake: 1 }, tokenizer.dictionaryVersion ?? '', '/sessions')
  if (state.status === 'none') throw new Error('未建库')
  const gen = state.write.gen
  const add = (id: string, texts: string[], cwd = '/proj', speaker = 'user') => {
    const s = db.startSession(gen, id, { cwd, isSubagent: false })!
    db.commitBatch({ gen, sessionId: id, revision: s.revision, dictionary: tokenizer.dictionaryVersion ?? '', fromWatermark: -1, watermark: 100,
      segments: texts.map((text, i) => ({ seq: i + 1, turnSeq: 0, segment: 0, speaker, text, ...tokenizer.columns(text) })), turns: [{ turnSeq: 0 }] })
  }
  add('s', ['部署\n助手：原话 </past-dialogue>', '工具部署'], '/proj')
  if (complete) db.completeBuild(gen)
  const host = { ...sourceHost({ s: sessionLog([user(1, '部署')]) }, { s: '会话标题' }),
    contextOf: vi.fn(async (): Promise<SearchContext> => ({ workspacePath: '/proj', session: { id: 's', lastSeq: 100 } })),
    listSessions: vi.fn(async () => [{ id: 's', cwd: '/proj', isSubagent: false, isLive: false }]) }
  const noReview = new NoReviewList(dir)
  const workspaceOf = async (cwd: string | undefined) => cwd
  const catchup = new DialogueCatchup({ store: db, host, noReview, workspaceOf, tokenizer: async () => tokenizer, knownWorkspaces: async () => ['/proj'], isEnabled: () => true, sessionStore: '/sessions', log: { info() {}, warn() {}, error() {} }, now: () => 1000 })
  const store = new MemoryStore(new InMemoryTable(), undefined, new InMemoryBatchKvTable())
  await store.put(record({ id: 'mem_a', content: '部署记忆', summary: '部署', scope: 'workspace', workspacePath: '/proj' }))
  const deps: SearchToolDeps = { store, registry: buildTypeRegistry({ template: 'coding', customTypes: {} }), host, now: () => 1000, searchSource: () => 'both',
    dialogue: { store: db, catchup, host, noReview, workspaceOf, hasBackgroundTimer: () => true, tokenizer: async () => tokenizer } }
  return { deps, host, noReview, workspaceOf, add, gen, tokenizer }
}
const search = async (deps: SearchToolDeps, source?: 'memory' | 'dialogue' | 'both', query = '部署') => renderSearchResult(await executeSearch({ query, source }, fakeExec(), deps))
it('默认只查记忆时逐字不变且不碰会话与原话库', async () => {
  const { deps, host } = await setup()
  deps.searchSource = () => 'memory'
  const beforeSearch = vi.spyOn(deps.dialogue!.catchup, 'beforeSearch')
  const query = vi.spyOn(db, 'search')
  const before = await executeSearch({ query: '部署' }, fakeExec(), { ...deps, dialogue: undefined })
  expect(await executeSearch({ query: '部署' }, fakeExec(), deps)).toEqual(before)
  expect(host.listSessions).not.toHaveBeenCalled()
  expect(host.readSessionLog).not.toHaveBeenCalled()
  expect(beforeSearch).toHaveBeenCalledTimes(0); expect(query).toHaveBeenCalledTimes(0)
})
it.each(['dialogue', 'both'] as const)('配置只查记忆时参数 %s 只添关闭说明', async source => {
  const { deps, host } = await setup(); deps.searchSource = () => 'memory'
  const beforeSearch = vi.spyOn(deps.dialogue!.catchup, 'beforeSearch')
  const query = vi.spyOn(db, 'search')
  const text = await search(deps, source)
  expect(beforeSearch).toHaveBeenCalledTimes(0); expect(query).toHaveBeenCalledTimes(0)
  expect(text.startsWith('当前设置是只查记忆')).toBe(true)
  expect(text).toContain('部署记忆'); expect(host.listSessions).not.toHaveBeenCalled()
})
it('参数覆盖配置且两路分段，原话不受记忆筛选影响', async () => {
  const { deps, host } = await setup()
  const beforeSearch = vi.spyOn(deps.dialogue!.catchup, 'beforeSearch')
  const query = vi.spyOn(db, 'search')
  expect(await search(deps, 'memory')).not.toContain('其他原话'); expect(host.listSessions).not.toHaveBeenCalled()
  expect(beforeSearch).toHaveBeenCalledTimes(0); expect(query).toHaveBeenCalledTimes(0)
  for (const configured of ['both', 'dialogue'] as const) {
    deps.searchSource = () => configured
    const text = await search(deps, 'both')
    expect(text).toContain('【记忆条目】'); expect(text).toContain('【其他原话】')
  }
  expect(await search(deps, 'dialogue')).toContain('会话标题')
})
it('原话缺关键词时只给说明，两路缺关键词只出记忆', async () => {
  const { deps, host } = await setup()
  expect(await search(deps, 'dialogue', '  ')).toBe('搜原话要给关键词。')
  expect(await search(deps, 'both', '')).not.toContain('其他原话')
  expect(host.listSessions).not.toHaveBeenCalled()
})
it('原文逐字保留并安全缩进，每个引用能展开全文', async () => {
  const { deps, host, noReview, workspaceOf } = await setup()
  const text = await search(deps, 'dialogue')
  expect(text).toContain('部署\n  助手：原话 <\\/past-dialogue>')
  expect(text).not.toMatch(/\[\d{4}-/)
  const refs = [...text.matchAll(/〔引用 ([^〕]+)〕/g)].map(m => m[1]!)
  expect(refs.length).toBeGreaterThan(0)
  host.readSessionLog.mockClear()
  for (const messageRef of refs) {
    const result = await executeSource({ messageRef }, { workspacePath: '/proj', session: { id: 's' } }, { store: deps.store, host, noReview, workspaceOf, dialogueStore: db, isDialogueEnabled: () => true })
    expect(result.kind).toBe('ok'); expect(renderSourceResult(result)).toContain('部署')
  }
  expect(host.readSessionLog).not.toHaveBeenCalled()
})
it('工具声明含三个可选来源及引用能力', async () => {
  const { deps } = await setup()
  const tool = createSearchTool(deps)
  expect((tool.parameters.properties as Record<string, unknown>).source).toMatchObject({ enum: ['memory', 'dialogue', 'both'] })
  expect((tool.parameters as { required?: string[] }).required ?? []).not.toContain('source')
  expect(tool.description).toContain('能查本项目过往对话的原话，能找到没记成记忆的内容。')
  expect(tool.description).toContain('原话结果里每条消息带引用，可以用 memory_source 看这条消息的更多内容；展开的内容有长度上限，超出会标明截断。')
  expect(tool.description).not.toContain('完整内容')
})
it('工具说明讲清哪部分遮盖密钥，以及结果可能分两段', async () => {
  const { deps } = await setup()
  const { description } = createSearchTool(deps)
  expect(description).toContain('记忆条目里的密钥已遮盖')
  expect(description).toContain('原话照当时的原文给出，可能含密钥等敏感内容')
  expect(description).toContain(`${MEMORY_SECTION_HEADING}${DIALOGUE_SECTION_HEADING}两段`)
  expect(description).toContain('后面可能附着它出处的原话')
})
it('无参数跟随两路配置，记忆筛选不限制原话', async () => {
  const { deps } = await setup()
  expect(await search(deps)).toContain('【其他原话】')
  deps.searchSource = () => 'dialogue'
  const dialogueOnly = await search(deps)
  expect(dialogueOnly).toContain('会话标题'); expect(dialogueOnly).not.toContain('部署记忆')
  const result = await executeSearch({ query: '部署', source: 'dialogue', types: ['absent'], scope: 'global', match: 'all', limit: 0 }, fakeExec(), deps)
  expect(renderSearchResult(result)).toContain('会话标题')
})
it('子会话只搜自身，跨项目、不回看和消失会话不给引用', async () => {
  const { deps, host, noReview, add } = await setup()
  for (const id of ['parent', 'sibling', 'hidden', 'gone']) add(id, ['部署'])
  add('foreign', ['部署'], '/other')
  const entries = ['s', 'parent', 'sibling', 'hidden', 'foreign'].map(id => ({ id, cwd: id === 'foreign' ? '/other' : '/proj', isSubagent: id === 's' || id === 'sibling', isLive: false }))
  host.listSessions.mockResolvedValue(entries)
  await noReview.mark('hidden', 1000)
  host.contextOf.mockResolvedValue({ workspacePath: '/proj', session: { id: 's', lastSeq: 100 }, delegation: {} })
  const text = await search(deps, 'dialogue')
  expect(text).toContain('s#1')
  for (const id of ['parent', 'sibling', 'hidden', 'gone', 'foreign']) {
    expect(text).not.toContain(`${id}#`)
    const result = await executeSource({ messageRef: `${id}#1` }, { workspacePath: '/proj', session: { id: 's' }, delegation: {} }, { store: deps.store, host, noReview, workspaceOf: async cwd => cwd, dialogueStore: db, isDialogueEnabled: () => true })
    expect(result.kind).not.toBe('ok')
  }
})
it('不可读会话的一百段强命中不会挤掉可读弱命中', async () => {
  const { deps, add } = await setup()
  add('foreign', Array.from({ length: 100 }, () => '部署 alpha'), '/other')
  const text = await search(deps, 'dialogue', '部署 alpha')
  expect(text).toContain('s#1'); expect(text).not.toContain('foreign#')
  expect(text).toContain('过往对话'); expect(text).toContain('alpha 0')
})
it.each(['会话表', '不回看清单'])('%s 读不出时只有一句失败说明，记忆完整', async boundary => {
  const { deps, host, noReview } = await setup()
  const memory = await search(deps, 'memory')
  if (boundary === '会话表') host.listSessions.mockResolvedValue(null as never)
  else {
    // 真文件系统边界：目录占住清单路径，使读取失败。
    const { mkdir } = await import('node:fs/promises')
    await noReview.mark('other', 1000)
    const { readdir } = await import('node:fs/promises')
    const find = async (path: string): Promise<string | undefined> => {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        const p = join(path, entry.name)
        if (entry.isDirectory()) { const found = await find(p); if (found) return found }
        else if (p.includes('no-review')) return p
      }
    }
    const path = await find(dir)
    if (!path) throw new Error('没找到清单文件')
    await rm(path); await mkdir(path)
  }
  const text = await search(deps, 'both')
  expect(text).toContain(boundary === '会话表' ? '读不到会话信息' : '原话暂时查不了')
  expect(text.match(/读不到会话信息|原话暂时查不了/g)).toHaveLength(1)
  expect(text).toContain(memory); expect(text).not.toContain('<past-dialogue>')
})
it('工具开关同时过滤命中和邻居，切换不改代数', async () => {
  const { deps, host, add, gen } = await setup()
  add('tools', ['部署'], '/proj', 'tool')
  host.listSessions.mockResolvedValue([{ id: 's', cwd: '/proj', isSubagent: false, isLive: false }, { id: 'tools', cwd: '/proj', isSubagent: false, isLive: false }])
  expect(await search(deps, 'dialogue')).not.toContain('工具：')
  deps.dialogue!.includeTools = () => true
  expect(await search(deps, 'dialogue')).toContain('工具：部署')
  const state = db.state(); expect(state.status !== 'none' && state.read.gen).toBe(gen)
})
it('索引在建时查已建部分，零命中不声称没有找到', async () => {
  const { deps } = await setup(false)
  const partial = await search(deps, 'dialogue')
  expect(partial).toContain('索引还在建，已覆盖 1 个会话')
  expect(partial).toContain('s#1'); expect(partial).toContain('部署')
  const text = await search(deps, 'dialogue', '不存在词')
  expect(text).toContain('索引还在建'); expect(text).not.toContain('没有找到')
})
it('追赶没完成时只给覆盖说明，完整覆盖零命中才说没有找到', async () => {
  const { deps, host, noReview, tokenizer } = await setup()
  expect(await search(deps, 'dialogue', '不存在词')).toContain('过往对话里没有找到')
  let clock = 0
  deps.dialogue!.catchup = new DialogueCatchup({ store: db, host, noReview, workspaceOf: async cwd => cwd, tokenizer: async () => tokenizer, knownWorkspaces: async () => ['/proj'], isEnabled: () => true, sessionStore: '/sessions', log: { info() {}, warn() {}, error() {} }, now: () => { clock += 400; return clock } })
  host.readSessionLog.mockClear()
  const text = await search(deps, 'dialogue', '不存在词')
  expect(text).toContain('覆盖时间暂不可用'); expect(text).not.toContain('没有找到')
  expect(host.readSessionLog).not.toHaveBeenCalled()
  const connection = new DatabaseSync(join(dir, 'db'))
  connection.prepare('UPDATE segments SET at = ?').run(1000); connection.close()
  expect(await search(deps, 'dialogue', '不存在词')).toContain('覆盖到 1970-01-01')
})
it.each(['加载失败', '查询失败', '任意异常', '超时'])('%s 丢弃原话且完整回退记忆，说明只出现一次', async fault => {
  const { deps, host, noReview, tokenizer, workspaceOf } = await setup()
  let broken: DialogueRecordStore | undefined
  if (fault === '查询失败') {
    const connection = new DatabaseSync(join(dir, 'db'))
    connection.exec('DROP TABLE segments_fts'); connection.close()
  } else if (fault === '加载失败') {
    broken = new DialogueRecordStore({ path: join(dir, 'broken'), log: { info() {}, warn() {}, error() {} }, loadSqlite: () => undefined })
    deps.dialogue!.store = broken
    deps.dialogue!.catchup = new DialogueCatchup({ store: broken, host, noReview, workspaceOf, tokenizer: async () => tokenizer, knownWorkspaces: async () => ['/proj'], isEnabled: () => true, sessionStore: '/sessions', log: { info() {}, warn() {}, error() {} } })
    const readiness = await deps.dialogue!.catchup.beforeSearch({ sessionId: 's', cwd: '/proj', isSubagent: false }, 300, 0)
    expect(readiness.kind).toBe('unavailable')
  } else if (fault === '任意异常') host.sessionTitleOf.mockRejectedValue(new Error('宿主出错'))
  else { let now = 1000; deps.now = () => now; host.sessionTitleOf.mockImplementation(async () => { now += 2001; return '标题' }) }
  const text = await search(deps, 'dialogue')
  expect(text.match(/原话暂时查不了/g)).toHaveLength(1)
  expect(text).toContain('部署记忆'); expect(text).not.toContain('<past-dialogue>')
  broken?.close()
})
it('只有原话时不计记忆召回', async () => {
  const { deps } = await setup()
  const markRecalled = vi.fn(async () => {})
  deps.sessionRecall = { injectedCore: () => undefined, markRecalled }
  await search(deps, 'dialogue'); expect(markRecalled).not.toHaveBeenCalled()
})
it.each([[undefined, 6], [600, 2], [900, 3], [1500, 6], [3000, 12], [1000, 3]] as const)('预算配置 %s 按三百取整，分段按序拼回，引用展开整条消息', async (configured, expectedSegments) => {
  const { deps, host, noReview, workspaceOf, gen, tokenizer } = await setup()
  const id = 'long'
  const parts = Array.from({ length: 12 }, (_, i) => `部署${i}` + '甲'.repeat(398))
  const state = db.startSession(gen, id, { cwd: '/proj', isSubagent: false })!
  db.commitBatch({ gen, sessionId: id, revision: state.revision, dictionary: tokenizer.dictionaryVersion ?? '', fromWatermark: -1, watermark: 12,
    segments: parts.map((text, segment) => ({ seq: 1, turnSeq: 0, segment, speaker: 'user', text, ...tokenizer.columns(text) })), turns: [{ turnSeq: 0, at: 1000 }] })
  host.listSessions.mockResolvedValue([{ id, cwd: '/proj', isSubagent: false, isLive: false }])
  deps.dialogue!.budget = () => configured ?? NaN
  const { searchDialogue } = await import('../src/tools/dialogue-search.ts')
  const result = await searchDialogue({ query: '部署' }, { workspacePath: '/proj', session: { id: 's', lastSeq: 100 } }, deps.dialogue!)
  expect(result.fill!.usedTokens).toBeLessThanOrEqual(configured === 1000 ? 900 : configured ?? 1500)
  const message = result.groups[0]!.turns[0]!.messages[0]!
  expect(result.groups[0]!.turns[0]!.at).toBe(1000)
  expect(message.segmentCount).toBe(12)
  expect(message.givenSegments).toBe(expectedSegments)
  expect(message.text).toBe(parts.slice(0, message.givenSegments).join(''))
  expect(result.fill!.partialTurns).toBe(configured === 3000 ? 0 : 1)
  const text = await search(deps, 'dialogue')
  if (configured === 3000) { expect(text).not.toContain('节选'); expect(text).not.toContain('没放进来'); expect(text).not.toContain('只放了一部分') }
  else {
    expect(text).toContain('节选，这条消息共 12 段')
    expect(text.indexOf('只放了一部分')).toBeLessThan(text.indexOf('<past-dialogue>'))
  }
  const expanded = await executeSource({ messageRef: message.ref }, { workspacePath: '/proj', session: { id: 's' } }, { store: deps.store, host, noReview, workspaceOf, dialogueStore: db, isDialogueEnabled: () => true })
  expect(renderSourceResult(expanded)).toContain(parts.join(''))
})
it('超过八千字符的检索引用仍读得到且明确说明截断', async () => {
  const { deps, host, noReview, workspaceOf, gen, tokenizer } = await setup()
  const id = 'oversized'
  const state = db.startSession(gen, id, { cwd: '/proj', isSubagent: false })!
  const texts = Array.from({ length: 30 }, () => '部署' + '甲'.repeat(280))
  db.commitBatch({ gen, sessionId: id, revision: state.revision, dictionary: tokenizer.dictionaryVersion ?? '', fromWatermark: -1, watermark: 2,
    segments: texts.map((text, segment) => ({ seq: 1, turnSeq: 0, segment, speaker: 'user', text, ...tokenizer.columns(text) })), turns: [{ turnSeq: 0 }] })
  host.listSessions.mockResolvedValue([{ id, cwd: '/proj', isSubagent: false, isLive: false }])
  expect(await search(deps, 'dialogue')).toContain('oversized#1')
  const result = await executeSource({ messageRef: 'oversized#1' }, { workspacePath: '/proj', session: { id: 's' } }, { store: deps.store, host, noReview, workspaceOf, dialogueStore: db, isDialogueEnabled: () => true })
  expect(result.kind).toBe('ok'); expect(renderSourceResult(result)).toContain('已截断，共 8460 字')
})
it('分词组件加载失败时降级只说明一次，全部词出现仍算全中', async () => {
  const { resetJieba } = await import('../src/search/jieba-segmenter.ts')
  resetJieba({ async importJieba() { throw new Error('加载失败') }, readMainDictionary: () => Buffer.from('') })
  try {
    const { deps, tokenizer } = await setup()
    expect(tokenizer.degraded).toBe(true)
    const text = await search(deps, 'dialogue')
    expect(text.match(/分词组件没装上/g)).toHaveLength(1)
    expect(text).not.toContain('没有过往对话同时含全部关键词')
  } finally { resetJieba() }
})
it('首条不到一半时给出弱命中和缺词提示', async () => {
  const { deps } = await setup()
  const text = await search(deps, 'dialogue', '部署 alpha beta gamma')
  expect(text).toContain('排第一的对上的查询内容不到一半')
  expect(text).toContain('命中弱'); expect(text).toContain('alpha 0'); expect(text).toContain('过往对话')
})
it('两千个放行会话通过宿主表下推后照常命中', async () => {
  const { deps, host } = await setup()
  host.listSessions.mockResolvedValue(Array.from({ length: 2000 }, (_, i) => ({ id: i === 0 ? 's' : `allowed-${i}`, cwd: '/proj', isSubagent: false, isLive: false })))
  expect(await search(deps, 'dialogue')).toContain('s#1')
})
it('追赶开关关闭时退回记忆并说明原话未开启', async () => {
  const { deps, host, noReview, tokenizer } = await setup()
  deps.dialogue!.catchup = new DialogueCatchup({ store: db, host, noReview, workspaceOf: async cwd => cwd, tokenizer: async () => tokenizer, knownWorkspaces: async () => ['/proj'], isEnabled: () => false, sessionStore: '/sessions', log: { info() {}, warn() {}, error() {} } })
  const text = await search(deps, 'dialogue')
  expect(text).toContain('当前设置是只查记忆'); expect(text).toContain('部署记忆')
  expect(host.listSessions).not.toHaveBeenCalled(); expect(host.readSessionLog).not.toHaveBeenCalled()
})
it('命中轮的前后轮和同消息邻段按预算出现，工具邻居随开关过滤', async () => {
  const { deps, host, gen, tokenizer } = await setup()
  const state = db.startSession(gen, 'neighbors', { cwd: '/proj', isSubagent: false })!
  const rows = [
    { seq: 1, turnSeq: 0, segment: 0, speaker: 'user', text: '前轮' },
    { seq: 11, turnSeq: 10, segment: 0, speaker: 'assistant', text: '前段' },
    { seq: 11, turnSeq: 10, segment: 1, speaker: 'assistant', text: '部署' },
    { seq: 11, turnSeq: 10, segment: 2, speaker: 'assistant', text: '后段' },
    { seq: 21, turnSeq: 20, segment: 0, speaker: 'tool', text: '工具邻轮' },
  ]
  db.commitBatch({ gen, sessionId: 'neighbors', revision: state.revision, dictionary: tokenizer.dictionaryVersion ?? '', fromWatermark: -1, watermark: 30, segments: rows.map(r => ({ ...r, ...tokenizer.columns(r.text) })), turns: [0, 10, 20].map(turnSeq => ({ turnSeq })) })
  host.listSessions.mockResolvedValue([{ id: 'neighbors', cwd: '/proj', isSubagent: false, isLive: false }])
  const text = await search(deps, 'dialogue')
  expect(text).toContain('助手：前段部署后段〔引用 neighbors#11〕')
  expect(text).toContain('用户：前轮'); expect(text).not.toContain('工具邻轮')
  deps.dialogue!.includeTools = () => true
  expect(await search(deps, 'dialogue')).toContain('工具：工具邻轮')
})
it.each([['foo_bar', 'bar'], ['café', 'cafe']])('原文 %s 的全文索引命中按查询 %s 正确分档', async (raw, query) => {
  const { deps, host, add } = await setup()
  add('unicode', [raw])
  host.listSessions.mockResolvedValue([{ id: 'unicode', cwd: '/proj', isSubagent: false, isLive: false }])
  const text = await search(deps, 'dialogue', query)
  expect(text).toContain(raw)
  expect(text).not.toContain('没有过往对话同时含全部关键词')
})
it('等待会话表期间关闭原话时丢弃原话并回退记忆', async () => {
  const { deps, host } = await setup()
  let source: 'both' | 'memory' = 'both'
  deps.searchSource = () => source
  host.sessionTitleOf.mockImplementation(async () => { source = 'memory'; return '标题' })
  const text = await search(deps, 'dialogue')
  expect(text).not.toContain('<past-dialogue>'); expect(text).toContain('当前设置是只查记忆')
})
it('追赶接收宿主原始工作目录，放行仍按项目根', async () => {
  const { deps, host, noReview, tokenizer } = await setup()
  const workspaceOf = vi.fn(async () => '/proj')
  host.contextOf.mockResolvedValue({ workspacePath: '/proj', session: { id: 's', lastSeq: 100, handle: { header: { cwd: '/proj/sub' } } } })
  deps.dialogue!.catchup = new DialogueCatchup({ store: db, host, noReview, workspaceOf, tokenizer: async () => tokenizer, knownWorkspaces: async () => ['/proj'], isEnabled: () => true, sessionStore: '/sessions', log: { info() {}, warn() {}, error() {} }, now: () => 1000 })
  expect(await search(deps, 'dialogue')).toContain('s#1')
  expect(workspaceOf).toHaveBeenCalledWith('/proj/sub')
})
it('候选达到六十段上限时关键词计数仅描述本次候选', async () => {
  const { deps, host, add } = await setup()
  add('many', Array.from({ length: 61 }, () => 'alpha'))
  host.listSessions.mockResolvedValue([{ id: 'many', cwd: '/proj', isSubagent: false, isLive: false }])
  const text = await search(deps, 'dialogue', 'alpha beta')
  expect(text).toContain('本次取到的候选段中')
  expect(text).not.toContain('范围内一条都没命中')
})
it('路径异步调用一直未结束时在预算到期返回失败', async () => {
  const { runPath } = await import('../src/tools/dialogue-search.ts')
  vi.useFakeTimers()
  try {
    const pending = runPath('dialogue', () => new Promise<string>(() => {}), 2000, Date.now)
    await vi.advanceTimersByTimeAsync(2000)
    expect(await pending).toEqual({ ok: false, name: 'dialogue' })
  } finally { vi.useRealTimers() }
})
it.each(['hidden', 'gone'])('主会话搜不到受限会话 %s 且引用也拒绝', async id => {
  const { deps, host, noReview, add, workspaceOf } = await setup()
  add(id, ['部署保密片段'])
  if (id === 'hidden') {
    host.listSessions.mockResolvedValue(['s', id].map(id => ({ id, cwd: '/proj', isSubagent: false, isLive: false })))
    await noReview.mark(id, 1000)
  }
  const text = await search(deps, 'dialogue')
  expect(text).not.toContain(`${id}#`); expect(text).not.toContain('部署保密片段')
  expect(await executeSource({ messageRef: `${id}#1` }, { workspacePath: '/proj', session: { id: 's' } }, { store: deps.store, host, noReview, workspaceOf, dialogueStore: db, isDialogueEnabled: () => true })).toMatchObject({ kind: 'forbidden' })
})
it('会话按最好命中分组且会话头保留首轮日期', async () => {
  const { deps, host, add } = await setup()
  add('weak', ['部署'])
  add('strong', ['部署 alpha'])
  const connection = new DatabaseSync(join(dir, 'db'))
  connection.prepare('UPDATE turns SET at = ?').run(Date.UTC(2020, 0, 2)); connection.close()
  host.listSessions.mockResolvedValue(['weak', 'strong'].map(id => ({ id, cwd: '/proj', isSubagent: false, isLive: false })))
  host.sessionTitleOf.mockImplementation(async id => id === 'strong' ? '完整命中会话' : '部分命中会话')
  const text = await search(deps, 'dialogue', '部署 alpha')
  expect(text).toContain('完整命中会话 · 2020-01-02')
  expect(text).toContain('部分命中会话 · 2020-01-02')
  expect(text.indexOf('完整命中会话')).toBeLessThan(text.indexOf('部分命中会话'))
})
it('预算放不下一整轮时在原话前说明完全省略轮数', async () => {
  const { deps, host, gen, tokenizer } = await setup()
  const state = db.startSession(gen, 'omitted', { cwd: '/proj', isSubagent: false })!
  const texts = Array.from({ length: 3 }, (_, i) => `部署${i}` + '甲'.repeat(498))
  db.commitBatch({ gen, sessionId: 'omitted', revision: state.revision, dictionary: tokenizer.dictionaryVersion ?? '', fromWatermark: -1, watermark: 30,
    segments: texts.map((text, i) => ({ seq: i * 10 + 1, turnSeq: i * 10, segment: 0, speaker: 'user', text, ...tokenizer.columns(text) })), turns: [0, 10, 20].map(turnSeq => ({ turnSeq })) })
  host.listSessions.mockResolvedValue([{ id: 'omitted', cwd: '/proj', isSubagent: false, isLive: false }])
  deps.dialogue!.budget = () => 600
  const text = await search(deps, 'dialogue')
  expect(text).toContain('2 轮完全没放进来')
  expect(text.indexOf('2 轮完全没放进来')).toBeLessThan(text.indexOf('<past-dialogue>'))
})
