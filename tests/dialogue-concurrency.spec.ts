import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DialogueRecordStore } from '../src/storage/dialogue-records.ts'
import { dialogueTokenizer } from '../src/search/dialogue-tokenizer.ts'
import { DialogueCatchup } from '../src/tools/dialogue-catchup.ts'
import { executeSearch, renderSearchResult, type SearchToolDeps } from '../src/tools/search.ts'
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
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dialogue-concurrency-'))
  db = new DialogueRecordStore({ path: join(dir, 'db'), log: { info() {}, warn() {}, error() {} } })
})
afterEach(async () => { vi.useRealTimers(); db.close(); await rm(dir, { recursive: true, force: true }) })
async function setup() {
  const tokenizer = await dialogueTokenizer({ log: { warn() {} } })
  const host = { ...sourceHost({ s: sessionLog([user(1, 'needle')]) }, { s: '会话标题' }),
    contextOf: vi.fn(async () => ({ workspacePath: '/proj', session: { id: 's', lastSeq: 100 } })),
    listSessions: vi.fn(async () => [{ id: 's', cwd: '/proj', isSubagent: false, isLive: false }]) }
  const noReview = new NoReviewList(dir)
  const workspaceOf = async (cwd: string | undefined) => cwd
  const catchup = new DialogueCatchup({ store: db, host, noReview, workspaceOf, tokenizer: async () => tokenizer, knownWorkspaces: async () => ['/proj'], isEnabled: () => true, sessionStore: '/sessions', log: { info() {}, warn() {}, error() {} }, now: () => 1000 })
  const state = db.prepare({ segmentRule: 1, tokenizer: 1, intake: 1 }, tokenizer.dictionaryVersion ?? '', '/sessions')
  if (state.status === 'none') throw new Error('未建库')
  const gen = state.write.gen
  const session = db.startSession(gen, 's', { cwd: '/proj', isSubagent: false })!
  db.commitBatch({ gen, sessionId: 's', revision: session.revision, dictionary: tokenizer.dictionaryVersion ?? '', fromWatermark: -1, watermark: 100,
    segments: [{ seq: 1, turnSeq: 0, segment: 0, speaker: 'user', text: 'needle', ...tokenizer.columns('needle') }], turns: [{ turnSeq: 0 }] })
  db.completeBuild(gen)
  const table = new InMemoryTable()
  const store = new MemoryStore(table, undefined, new InMemoryBatchKvTable())
  await store.put(record({ id: 'mem_a', content: 'needle 记忆全文', summary: 'needle', scope: 'workspace', workspacePath: '/proj' }))
  const readScope = vi.spyOn(table, 'readScope')
  const deps: SearchToolDeps = { store, registry: buildTypeRegistry({ template: 'coding', customTypes: {} }), host, now: () => 1000, searchSource: () => 'both',
    dialogue: { store: db, catchup, host, noReview, workspaceOf, hasBackgroundTimer: () => true, tokenizer: async () => tokenizer } }
  return { deps, host, readScope }
}

it('原话等待宿主时记忆查询已启动，两秒后返回记忆和一句说明', async () => {
  const { deps, host, readScope } = await setup()
  let reached!: () => void
  const entered = new Promise<void>(resolve => { reached = resolve })
  host.sessionTitleOf.mockImplementation(() => { reached(); return new Promise(() => {}) })
  vi.useFakeTimers()
  const pending = executeSearch({ query: 'needle', source: 'both' }, fakeExec(), deps)
  await entered
  expect(readScope).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(2000)
  const text = renderSearchResult(await pending)
  expect(text).toContain('needle 记忆全文')
  expect(text.match(/暂时查不了/g)).toHaveLength(1)
  expect(text).toContain('【记忆条目】')
  expect(text).toContain('【其他原话】')
  expect(host.contextOf).toHaveBeenCalledTimes(1)
})

it('两路成功共享一次宿主上下文且记忆只查一次', async () => {
  const { deps, host, readScope } = await setup()
  const text = renderSearchResult(await executeSearch({ query: 'needle', source: 'both' }, fakeExec(), deps))
  expect(text).toContain('needle 记忆全文')
  expect(text).toContain('s#1')
  expect(readScope).toHaveBeenCalledTimes(1)
  expect(host.contextOf).toHaveBeenCalledTimes(1)
})

it('只查原话成功时为语义桥取一次记忆候选，不计记忆召回', async () => {
  const { deps, host, readScope } = await setup()
  const text = renderSearchResult(await executeSearch({ query: 'needle', source: 'dialogue' }, fakeExec(), deps))
  expect(text).toContain('s#1')
  expect(readScope).toHaveBeenCalledTimes(1)
  expect(host.contextOf).toHaveBeenCalledTimes(1)
  expect((await deps.store.get('mem_a', { workspacePath: '/proj' }))?.recallCount).toBe(0)
})

it('会话表读不到时两路仍分段且只给一句具体说明', async () => {
  const { deps, host } = await setup()
  host.listSessions.mockResolvedValue(null as never)
  const text = renderSearchResult(await executeSearch({ query: 'needle', source: 'both' }, fakeExec(), deps))
  expect(text).toContain('【记忆条目】')
  expect(text).toContain('【其他原话】')
  expect(text).toContain('needle 记忆全文')
  expect(text.match(/读不到会话信息/g)).toHaveLength(1)
  expect(text).not.toContain('暂时查不了')
})
