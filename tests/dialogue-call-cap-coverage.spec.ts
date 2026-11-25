import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DialogueRecordStore } from '../src/storage/dialogue-records.ts'
import { dialogueTokenizer } from '../src/search/dialogue-tokenizer.ts'
import { DialogueCatchup } from '../src/tools/dialogue-catchup.ts'
import { executeSearch, renderSearchResult } from '../src/tools/search.ts'
import { DialogueCallCap } from '../src/tools/dialogue-call-cap.ts'
import { DIALOGUE_SESSIONS_UNAVAILABLE, dialogueNote } from '../src/search/dialogue-format.ts'
import type { SearchSource } from '../src/contract-codes.ts'
import { NoReviewList } from '../src/storage/no-review.ts'
import { MemoryStore } from '../src/store.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'
import { InMemoryTable } from './helpers/in-memory-table.ts'
import { InMemoryBatchKvTable } from './helpers/in-memory-kv.ts'
import { sourceHost, sessionLog, user } from './helpers/source-host.ts'
import { fakeExec } from './helpers/exec.ts'
import { record } from './helpers/record.ts'
import type { SearchArgs, SearchContext, SearchToolDeps } from '../src/tools/search.ts'
import { apply, Config } from '../src/index.ts'
import { Session, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session'

const LIMIT = dialogueNote('dialogue-search-limit')
const LOG = { info() {}, warn() {}, error() {} }

let dir: string
let db: DialogueRecordStore
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'dialogue-call-cap-')); db = new DialogueRecordStore({ path: join(dir, 'db'), log: LOG }) })
afterEach(async () => { db.close(); await rm(dir, { recursive: true, force: true }) })

async function world(opts: { source?: SearchSource } = {}) {
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
  const library = db
  const host = { ...sourceHost({ s: sessionLog([user(2, '部署前先跑一遍测试')]) }, { s: '会话标题' }),
    contextOf: vi.fn(async (): Promise<SearchContext> => ({ workspacePath: '/proj', session: { id: 'cur', lastSeq: 100 } })),
    listSessions: vi.fn(async () => [{ id: 's', cwd: '/proj', isSubagent: false, isLive: false }]) }
  const noReview = new NoReviewList(dir)
  const workspaceOf = async (cwd: string | undefined) => cwd
  const catchup = new DialogueCatchup({ store: library, host, noReview, workspaceOf, tokenizer: async () => tokenizer, knownWorkspaces: async () => ['/proj'], isEnabled: () => true, sessionStore: '/sessions', log: LOG, now: () => 1000 })
  const store = new MemoryStore(new InMemoryTable(), undefined, new InMemoryBatchKvTable())
  await store.put(record({ id: 'mem_a', name: '部署规矩', content: '部署前先跑测试', summary: '部署', scope: 'workspace', workspacePath: '/proj',
    // 出处是会话 s 的第一轮（turn/start 在 1，一问一答在 2、3），记忆带原话时能附上
    source: { sessionId: 's', eventRange: [1, 3], sourceMode: 'user-explicit' } }))
  const cap = new DialogueCallCap()
  const configured = opts.source ?? 'both'
  const deps: SearchToolDeps = {
    store, registry: buildTypeRegistry({ template: 'coding', customTypes: {} }), host, now: () => 1000,
    searchSource: () => configured, memoryQuotes: () => false, callCap: cap,
    dialogue: { store: library, catchup, host, noReview, workspaceOf, hasBackgroundTimer: () => true, tokenizer: async () => tokenizer },
  }
  return { deps, cap, store }
}

/** 宿主给工具的执行上下文：会话对象就是 session/event 里的那一个。 */
const execOf = (session: object) => fakeExec({ agent: { session } } as never)
const start = (deps: SearchToolDeps, session: object, args: Partial<SearchArgs> = {}) =>
  executeSearch({ query: '部署', source: 'dialogue', ...args }, execOf(session), deps)
const text = async (pending: ReturnType<typeof start>) => renderSearchResult(await pending)
/** 一次开好一轮的会话：宿主在第一次工具调用前一定发过 turn/start。 */
const openSession = (cap: DialogueCallCap) => { const session = {}; cap.observe(session, { type: 'turn/start', data: { turn: 1 } }); return session }

describe('连续调用上限的补充验收', () => {
  it.each([undefined, 'dialogue', 'both'] as const)('配置只查原话、参数为 %s 时第四次用完，参数只查记忆不占名额', async source => {
    const { deps, cap } = await world({ source: 'dialogue' })
    const session = openSession(cap)
    for (let i = 0; i < 3; i++) {
      const memory = await start(deps, session, { source: 'memory' })
      expect(memory.hits.map(hit => hit.id)).toEqual(['mem_a'])
      expect(memory.dialogueText).toBeUndefined()
    }
    // 组合表中缺省和 dialogue 只查原话，both 仍走两路，但三者都占名额。
    for (let i = 0; i < 3; i++) {
      const got = await text(start(deps, session, { source }))
      expect(got).toContain('部署前先跑一遍测试')
      expect(got).not.toContain(LIMIT)
    }
    const fourth = await start(deps, session, { source })
    expect(fourth.dialogueText).toBe(LIMIT)
    expect(fourth.onlyDialogue).toBe(source !== 'both')
    expect(fourth.hits.map(hit => hit.id)).toEqual(source === 'both' ? ['mem_a'] : [])
  })

  it('配置两者时三次空白查询不占名额，第四次正常查询才用完', async () => {
    const { deps, cap } = await world()
    const session = openSession(cap)
    for (let i = 0; i < 3; i++) {
      const empty = await start(deps, session, { source: 'both', query: ' \t\n ' })
      expect(empty.dialogueText).toBeUndefined()
    }
    for (let i = 0; i < 3; i++) {
      const got = await text(start(deps, session, { source: 'both' }))
      expect(got).toContain('部署前先跑一遍测试')
      expect(got).not.toContain(LIMIT)
    }
    expect((await start(deps, session, { source: 'both' })).dialogueText).toBe(LIMIT)
  })

  it('两者用完后记忆结果与只查记忆整体相等，保留部分命中和截断说明', async () => {
    const { deps, cap, store } = await world()
    await store.put(record({ id: 'mem_b', name: '部署检查', content: '部署检查', summary: '部署', scope: 'workspace', workspacePath: '/proj' }))
    const session = openSession(cap)
    const args = { query: '部署 不存在词', limit: 1 }
    const memory = await start(deps, session, { ...args, source: 'memory' })
    expect(memory.hits).toHaveLength(1)
    expect(memory.noteCode).toBeDefined()
    expect(memory.note).toEqual(expect.any(String))
    expect(memory.moreNote).toEqual(expect.any(String))
    for (let i = 0; i < 3; i++) await start(deps, session, { ...args, source: 'both' })
    const { dialogueText, onlyDialogue, ...memories } = await start(deps, session, { ...args, source: 'both' })
    expect(dialogueText).toBe(LIMIT)
    expect(onlyDialogue).toBe(false)
    expect(memories).toEqual(memory)
  })

  it('类型配置热更新重注册检索工具后沿用计数，第四次只回用完说明', async () => {
    type ToolDef = { name: string; execute(args: unknown, exec: unknown): Promise<unknown> }
    const defs = new Map<string, ToolDef>()
    const listeners = new Map<string, (...args: unknown[]) => unknown>()
    const disposers: Array<() => unknown> = []
    const ctx = {
      logger: LOG,
      tools: { register: (def: ToolDef) => {
        if (defs.has(def.name)) throw new Error(`tool "${def.name}" already registered`)
        defs.set(def.name, def)
        return () => { defs.delete(def.name) }
      } },
      on: (event: string, fn: (...args: unknown[]) => unknown) => { listeners.set(event, fn); return () => {} },
      effect: (fn: () => () => unknown) => { disposers.push(fn()) },
      get: () => undefined,
      inject: () => () => {},
    }
    vi.stubEnv('DSH_HOME', join(dir, 'home'))
    vi.stubEnv('DSH_AGENTS_HOME', join(dir, 'agents'))
    try {
      const config = new Config({ memoryRoot: join(dir, 'memories'), search: { source: 'dialogue', memoryQuotes: false } })
      await apply(ctx as never, config)
      const id = 'hot-session' as SessionId
      const session = Session.create(id, [], { version: SESSION_FORMAT_VERSION, id, createdAt: 0, isSeeded: false }, 0 as never)
      await listeners.get('session/event')!(session, { type: 'turn/start', data: { turn: 1 } })
      const exec = execOf(session)
      const before = defs.get('memory_search')!
      const run = async (tool: ToolDef) => tool.execute({ query: '部署', source: 'dialogue' }, exec) as Promise<Awaited<ReturnType<typeof executeSearch>>>
      // 宿主不提供会话查询服务，原话路径返回会话信息不可用；这类调用照契约也占名额。
      for (let i = 0; i < 2; i++) expect(renderSearchResult(await run(before))).toContain(DIALOGUE_SESSIONS_UNAVAILABLE)
      const write = Symbol.for('cosmokit.volatile.write')
      const next = new Config({ template: 'office' })
      ;(config.template as unknown as { [write](value: unknown): void })[write](next.template.get())
      await listeners.get('loader/volatile-update')!([['template']])
      const after = defs.get('memory_search')!
      expect(after).not.toBe(before)
      expect(renderSearchResult(await run(after))).toContain(DIALOGUE_SESSIONS_UNAVAILABLE)
      expect(renderSearchResult(await run(after))).toBe(LIMIT)
    } finally {
      for (const dispose of disposers.reverse()) await dispose()
      vi.unstubAllEnvs()
    }
  })
})
