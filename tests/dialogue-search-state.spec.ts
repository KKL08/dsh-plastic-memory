import { existsSync } from 'node:fs'
import { searchDialogue } from '../src/tools/dialogue-search.ts'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DialogueRecordStore } from '../src/storage/dialogue-records.ts'
import { dialogueTokenizer } from '../src/search/dialogue-tokenizer.ts'
import { DialogueCatchup } from '../src/tools/dialogue-catchup.ts'
import { executeSearch, renderSearchResult, type SearchToolDeps, type SearchContext } from '../src/tools/search.ts'
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
    dialogue: { store: catchup.readStore, catchup, host, noReview, workspaceOf, hasBackgroundTimer: () => true, tokenizer: async () => tokenizer } }
  return { deps, host, noReview, workspaceOf, add, gen, tokenizer }
}
const search = async (deps: SearchToolDeps, source?: 'memory' | 'dialogue' | 'both', query = '部署') => renderSearchResult(await executeSearch({ query, source }, fakeExec(), deps))

it('库已建完但新会话排队时只说明覆盖不完整', async () => {
  const { deps, host } = await setup()
  host.readSessionLog.mockImplementation(async id => sessionLog([user(1, id === 'new' ? '独有队列词' : '部署')]))
  host.listSessions.mockResolvedValue([{ id: 's', cwd: '/proj', isSubagent: false, isLive: false }, { id: 'new', cwd: '/proj', isSubagent: false, isLive: false }])
  const text = await search(deps, 'dialogue', '独有队列词')
  expect(text).not.toContain('没有找到')
  expect(text).toMatch(/覆盖|还在整理/)
})
it('等待会话表期间删库时暂不可用且不重建文件', async () => {
  const { deps, host } = await setup()
  await deps.dialogue!.catchup.beforeSearch({ sessionId: 's', cwd: '/proj', isSubagent: false }, 300, 0)
  host.listSessions.mockImplementationOnce(async () => { db.destroy(); return [{ id: 's', cwd: '/proj', isSubagent: false, isLive: false }] })
  expect(await search(deps, 'dialogue')).toContain('暂时查不了')
  expect(existsSync(join(dir, 'db'))).toBe(false)
})
it('等待会话表期间换代时从新可读代查到原话', async () => {
  const { deps, host, tokenizer } = await setup()
  await deps.dialogue!.catchup.beforeSearch({ sessionId: 's', cwd: '/proj', isSubagent: false }, 300, 0)
  host.listSessions.mockImplementationOnce(async () => {
    const state = db.prepare({ segmentRule: 2, tokenizer: 1, intake: 1 }, tokenizer.dictionaryVersion ?? '', '/sessions')
    if (state.status === 'none') throw new Error('未建库')
    const gen = state.write.gen
    const row = db.startSession(gen, 's', { cwd: '/proj', isSubagent: false })!
    db.commitBatch({ gen, sessionId: 's', revision: row.revision, dictionary: tokenizer.dictionaryVersion ?? '', fromWatermark: -1, watermark: 100, segments: [{ seq: 1, turnSeq: 0, segment: 0, speaker: 'user', text: '换代独有词', ...tokenizer.columns('换代独有词') }], turns: [{ turnSeq: 0 }] })
    db.completeBuild(gen)
    return [{ id: 's', cwd: '/proj', isSubagent: false, isLive: false }]
  })
  expect(await search(deps, 'dialogue', '换代独有词')).toContain('用户：换代独有词')
})
it('库不可用时不再列会话且只留默认说明', async () => {
  const { deps, host } = await setup()
  deps.dialogue!.catchup = { beforeSearch: async () => ({ kind: 'unavailable', isBusy: false }), isOutOfScope: () => false }
  const result = await searchDialogue({ query: '部署' }, await host.contextOf(), deps.dialogue!)
  expect(host.listSessions).not.toHaveBeenCalled()
  expect(result).toEqual({ kind: 'unavailable', notes: [], groups: [] })
})
it('单个查询式只查询一次全文索引', async () => {
  const { deps } = await setup()
  const query = vi.spyOn(db, 'search')
  await search(deps, 'dialogue', '部署')
  expect(query).toHaveBeenCalledTimes(1)
})
it('只含非整词命中时提示承认关键词出现且不附缺词计数', async () => {
  const { deps, host, add } = await setup()
  add('substring', ['抄写锁定了部署'])
  host.listSessions.mockResolvedValue([{ id: 'substring', cwd: '/proj', isSubagent: false, isLive: false }])
  const text = await search(deps, 'dialogue', '写锁 部署')
  expect(text).toContain('关键词都出现了')
  expect(text).not.toContain('没有命中关键词')
  expect(text).not.toContain('命中弱')
  expect(text).not.toContain('「写锁」')
})
it('同消息不相邻的段只在缺口加省略标记', async () => {
  const { deps, host, gen, tokenizer } = await setup()
  const state = db.startSession(gen, 'gap', { cwd: '/proj', isSubagent: false })!
  const texts = ['部署甲', '中'.repeat(2000), '部署乙', '部署丙']
  db.commitBatch({ gen, sessionId: 'gap', revision: state.revision, dictionary: tokenizer.dictionaryVersion ?? '', fromWatermark: -1, watermark: 100,
    segments: texts.map((text, segment) => ({ seq: 1, turnSeq: 0, segment, speaker: 'user', text, ...tokenizer.columns(text) })), turns: [{ turnSeq: 0 }] })
  host.listSessions.mockResolvedValue([{ id: 'gap', cwd: '/proj', isSubagent: false, isLive: false }])
  deps.dialogue!.budget = () => 600
  const result = await searchDialogue({ query: '部署' }, await host.contextOf(), deps.dialogue!)
  expect(result.groups[0]?.turns[0]?.messages[0]?.text).toBe('部署甲\n……\n部署乙部署丙')
})
it('长句查询首段没有缺关键词时不附逐词计数', async () => {
  const { deps, host, add } = await setup()
  add('long', ['部署数据库连接失败排查'])
  host.listSessions.mockResolvedValue([{ id: 'long', cwd: '/proj', isSubagent: false, isLive: false }])
  const text = await search(deps, 'dialogue', '部署数据库连接失败排查详细过程')
  expect(text).toContain('部署数据库连接失败排查')
  expect(text).not.toContain('各关键词命中')
})
it('首段缺词但其他段分别命中时仍列逐词段数', async () => {
  const { deps, host, add } = await setup()
  add('terms', ['alpha', 'beta'])
  host.listSessions.mockResolvedValue([{ id: 'terms', cwd: '/proj', isSubagent: false, isLive: false }])
  const text = await search(deps, 'dialogue', 'alpha beta')
  expect(text).toContain('各关键词命中的原话段数')
})
