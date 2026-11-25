import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DialogueRecordStore } from '../src/storage/dialogue-records.ts'
import { dialogueTokenizer } from '../src/search/dialogue-tokenizer.ts'
import { DIALOGUE_QUOTE_TAG } from '../src/search/dialogue-format.ts'
import { DialogueCatchup } from '../src/tools/dialogue-catchup.ts'
import { DialogueCallCap } from '../src/tools/dialogue-call-cap.ts'
import { executeSearch, type SearchArgs, type SearchContext, type SearchToolDeps } from '../src/tools/search.ts'
import { NoReviewList } from '../src/storage/no-review.ts'
import { MemoryStore } from '../src/store.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'
import { InMemoryTable } from './helpers/in-memory-table.ts'
import { InMemoryBatchKvTable } from './helpers/in-memory-kv.ts'
import { sourceHost, sessionLog, user } from './helpers/source-host.ts'
import { fakeExec } from './helpers/exec.ts'
import { record } from './helpers/record.ts'

// 给了 topic 的调用只走记忆这一路（source 定为 memory）：记忆带原话照设置走，按主题列出没有查询词、自然不带；
// 两种都不进原话检索、不占原话的连续调用名额。记忆表是内存表（没有主题索引），记录都在「未整理」里。

const LOG = { info() {}, warn() {}, error() {} }

let dir: string
let db: DialogueRecordStore
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'topic-quotes-')); db = new DialogueRecordStore({ path: join(dir, 'db'), log: LOG }) })
afterEach(async () => { db.close(); await rm(dir, { recursive: true, force: true }) })

/** 对话库里有会话 s 的第一轮；记忆 mem_a 的出处就是这一轮。设置是两者都查、记忆带原话开着。 */
async function world() {
  const tokenizer = await dialogueTokenizer({ log: { warn() {} } })
  const state = db.prepare({ segmentRule: 1, tokenizer: 1, intake: 1 }, tokenizer.dictionaryVersion ?? '', '/sessions')
  if (state.status === 'none') throw new Error('未建库')
  const gen = state.write.gen
  const s = db.startSession(gen, 's', { cwd: '/proj', isSubagent: false })!
  db.commitBatch({ gen, sessionId: 's', revision: s.revision, dictionary: tokenizer.dictionaryVersion ?? '', fromWatermark: -1, watermark: 100,
    segments: [
      { seq: 2, turnSeq: 1, segment: 0, speaker: 'user', text: '部署前先跑一遍测试', ...tokenizer.columns('部署前先跑一遍测试') },
      { seq: 3, turnSeq: 1, segment: 0, speaker: 'assistant', text: '好的，部署脚本已经改好', ...tokenizer.columns('好的，部署脚本已经改好') },
    ], turns: [{ turnSeq: 1 }] })
  db.completeBuild(gen)
  const host = { ...sourceHost({ s: sessionLog([user(2, '部署前先跑一遍测试')]) }, { s: '会话标题' }),
    contextOf: vi.fn(async (): Promise<SearchContext> => ({ workspacePath: '/proj', session: { id: 'cur', lastSeq: 100 } })),
    listSessions: vi.fn(async () => [{ id: 's', cwd: '/proj', isSubagent: false, isLive: false }]) }
  const noReview = new NoReviewList(dir)
  const workspaceOf = async (cwd: string | undefined) => cwd
  const catchup = new DialogueCatchup({ store: db, host, noReview, workspaceOf, tokenizer: async () => tokenizer, knownWorkspaces: async () => ['/proj'], isEnabled: () => true, sessionStore: '/sessions', log: LOG, now: () => 1000 })
  const store = new MemoryStore(new InMemoryTable(), undefined, new InMemoryBatchKvTable())
  await store.put(record({ id: 'mem_a', name: '部署规矩', content: '部署前先跑测试', summary: '部署', scope: 'workspace', workspacePath: '/proj',
    source: { sessionId: 's', eventRange: [1, 3], sourceMode: 'user-explicit' } }))
  const callCap = new DialogueCallCap()
  const deps: SearchToolDeps = {
    store, registry: buildTypeRegistry({ template: 'coding', customTypes: {} }), host, now: () => 1000,
    searchSource: () => 'both', memoryQuotes: () => true, callCap,
    dialogue: { store: db, catchup, host, noReview, workspaceOf, hasBackgroundTimer: () => true, tokenizer: async () => tokenizer },
  }
  return { deps, catchup, callCap }
}

describe('给了 topic 的调用只走记忆这一路', () => {
  it('按主题列出不追原话库、不带原话；主题内关键词检索照常给命中带原话；两种都不进原话检索、不占名额', async () => {
    const { deps, catchup, callCap } = await world()
    const beforeSearch = vi.spyOn(catchup, 'beforeSearch')
    const claim = vi.spyOn(callCap, 'claim')
    const search = (args: SearchArgs) => executeSearch(args, fakeExec(), deps)

    // 对照：不给 topic 时走两路，占一次名额，记忆照常带原话
    const plain = await search({ query: '部署' })
    expect(plain.dialogueText).toBeDefined()
    expect(plain.hits.find(h => h.id === 'mem_a')?.quote).toContain(DIALOGUE_QUOTE_TAG)
    expect(claim).toHaveBeenCalledTimes(1)
    expect(beforeSearch).toHaveBeenCalled()
    beforeSearch.mockClear()

    const browse = await search({ topic: '未整理' })
    expect(browse.browse?.sections.flatMap(s => s.rows.map(row => row.id))).toEqual(['mem_a'])
    expect(browse.quoteNote).toBeUndefined()
    expect(beforeSearch).not.toHaveBeenCalled()

    const inTopic = await search({ topic: '未整理', query: '部署' })
    expect(inTopic.hits.map(h => h.id)).toEqual(['mem_a'])
    expect(inTopic.hits[0]!.quote).toContain(DIALOGUE_QUOTE_TAG)
    expect(beforeSearch).toHaveBeenCalledTimes(1)

    for (const r of [browse, inTopic]) {
      expect(r.dialogueText).toBeUndefined()
      expect(r.pathNote).toBeUndefined()
    }
    expect(claim).toHaveBeenCalledTimes(1)
  })
})
