import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DialogueRecordStore } from '../src/storage/dialogue-records.ts'
import { dialogueTokenizer } from '../src/search/dialogue-tokenizer.ts'
import { DialogueCatchup } from '../src/tools/dialogue-catchup.ts'
import { executeSearch, renderSearchResult, type SearchArgs, type SearchContext, type SearchToolDeps } from '../src/tools/search.ts'
import { createSearchTool } from '../src/tools/search-tool.ts'
import { DIALOGUE_CALL_LIMIT, DialogueCallCap, type CallCapEvent } from '../src/tools/dialogue-call-cap.ts'
import { DIALOGUE_SECTION_HEADING, MEMORY_SECTION_HEADING, dialogueNote } from '../src/search/dialogue-format.ts'
import type { SearchSource } from '../src/contract-codes.ts'
import { NoReviewList } from '../src/storage/no-review.ts'
import { MemoryStore } from '../src/store.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'
import { InMemoryTable } from './helpers/in-memory-table.ts'
import { InMemoryBatchKvTable } from './helpers/in-memory-kv.ts'
import { sourceHost, sessionLog, user } from './helpers/source-host.ts'
import { fakeExec } from './helpers/exec.ts'
import { record } from './helpers/record.ts'
import { interleaveParams } from './helpers/interleave.ts'

/** 用完名额时工具给的说明（原话检索说明码 dialogue-search-limit 的文案）。 */
const LIMIT = dialogueNote('dialogue-search-limit')
const LOG = { info() {}, warn() {}, error() {} }

// —— 宿主会话事件，形状同宿主日志里的事件 ——
const turnStart = (turn = 1): CallCapEvent => ({ type: 'turn/start', data: { turn } })
const toolCall = (name: string): CallCapEvent => ({ type: 'tool/call', data: { turn: 1, step: 1, callId: `call-${name}`, name, arguments: '{}' } })
const programCall = (name: string): CallCapEvent => ({ type: 'tool/ptc-dispatch-start', data: { rootCallId: 'root', parentCallId: 'run', subCallId: 'run:ptc:1', name, arguments: {} } })
/** 不该清零的事件：助手输出文字、工具结果、步的边界、用户消息、一轮结束、压缩。 */
const QUIET_EVENTS: CallCapEvent[] = [
  { type: 'assistant/attempt', data: { turn: 1, step: 1 } },
  { type: 'assistant/message', data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '我先想一下' }] } } },
  { type: 'tool/result', data: { turn: 1, step: 1, message: { role: 'tool', content: [] } } },
  { type: 'step/start', data: { turn: 1, step: 2 } },
  { type: 'step/end', data: { turn: 1, step: 2 } },
  { type: 'user/message', data: { message: { role: 'user', content: [] } } },
  { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  { type: 'compaction/end', data: { compactionId: 'cmp', turn: 1 } },
]

/** 连着 claim n 次，回每次拿没拿到。 */
const claims = (cap: DialogueCallCap, session: object | undefined, n: number) => Array.from({ length: n }, () => cap.claim(session))
const granted = (n: number) => Array.from({ length: n }, () => true)

describe('计数与清零', () => {
  it('新一轮开始后连续拿三次，第四次拿不到，之后再调也拿不到', () => {
    const cap = new DialogueCallCap()
    const session = {}
    cap.observe(session, turnStart())
    expect(DIALOGUE_CALL_LIMIT).toBe(3)
    expect(claims(cap, session, 6)).toEqual([true, true, true, false, false, false])
  })

  it('用完以后新一轮开始：清零，又能连拿三次', () => {
    const cap = new DialogueCallCap()
    const session = {}
    cap.observe(session, turnStart(1))
    claims(cap, session, 4)
    cap.observe(session, turnStart(2))
    expect(claims(cap, session, 4)).toEqual([true, true, true, false])
  })

  it.each(['bash', 'memory_save', 'read', 'subagent'])('中间调了别的工具（%s）：清零一次', name => {
    const cap = new DialogueCallCap()
    const session = {}
    cap.observe(session, turnStart())
    expect(claims(cap, session, 4)).toEqual([true, true, true, false])
    cap.observe(session, toolCall(name))
    expect(claims(cap, session, 4)).toEqual([true, true, true, false])
  })

  it('中间只调了 memory_search、memory_source 或只输出了文字：不清零', () => {
    const cap = new DialogueCallCap()
    const session = {}
    cap.observe(session, turnStart())
    expect(claims(cap, session, 3)).toEqual(granted(3))
    cap.observe(session, toolCall('memory_search'))
    cap.observe(session, toolCall('memory_source'))
    for (const event of QUIET_EVENTS) cap.observe(session, event)
    expect(cap.claim(session)).toBe(false)
  })

  it('程序工具：run_code 本身不清零，程序里调记忆检索不清零，程序里调别的工具清零', () => {
    const cap = new DialogueCallCap()
    const session = {}
    cap.observe(session, turnStart())
    claims(cap, session, 3)
    cap.observe(session, toolCall('run_code'))
    cap.observe(session, programCall('memory_search'))
    cap.observe(session, programCall('memory_source'))
    expect(cap.claim(session)).toBe(false)
    cap.observe(session, programCall('bash'))
    expect(claims(cap, session, 4)).toEqual([true, true, true, false])
  })

  it.each([
    ['没有载荷', { type: 'tool/call' }],
    ['工具名不是字符串', { type: 'tool/call', data: { name: 42 } }],
    ['程序里的调用没有工具名', { type: 'tool/ptc-dispatch-start', data: {} }],
  ] as const)('工具调用事件认不出工具名（%s）：按别的工具清零', (_label, event) => {
    const cap = new DialogueCallCap()
    const session = {}
    cap.observe(session, turnStart())
    claims(cap, session, 4)
    cap.observe(session, event)
    expect(claims(cap, session, 4)).toEqual([true, true, true, false])
  })

  it('会话还没见过清零事件：照给名额、不计数；见到第一条清零事件后开始计', () => {
    const cap = new DialogueCallCap()
    const session = {}
    for (const event of QUIET_EVENTS) cap.observe(session, event)
    expect(claims(cap, session, 10)).toEqual(granted(10))
    cap.observe(session, toolCall('bash'))
    expect(claims(cap, session, 4)).toEqual([true, true, true, false])
  })

  it('拿不到会话：照给名额，不影响别的会话', () => {
    const cap = new DialogueCallCap()
    const session = {}
    cap.observe(session, turnStart())
    expect(claims(cap, undefined, 10)).toEqual(granted(10))
    expect(claims(cap, session, 4)).toEqual([true, true, true, false])
  })

  it('子 agent 会话和主会话各算各的：一边用完、一边清零都不影响另一边', () => {
    const cap = new DialogueCallCap()
    const main = {}
    const child = {}
    cap.observe(main, turnStart())
    cap.observe(child, turnStart())
    expect(claims(cap, child, 4)).toEqual([true, true, true, false])
    expect(claims(cap, main, 2)).toEqual([true, true])
    cap.observe(child, toolCall('bash'))
    expect(claims(cap, main, 2)).toEqual([true, false])
    expect(claims(cap, child, 1)).toEqual([true])
  })

  it('计数只在内存里：换一个实例（进程重启）就从头计', () => {
    const session = {}
    const before = new DialogueCallCap()
    before.observe(session, turnStart())
    expect(claims(before, session, 4)).toEqual([true, true, true, false])
    const after = new DialogueCallCap()
    after.observe(session, toolCall('memory_search'))
    expect(after.claim(session)).toBe(true)
    after.observe(session, turnStart())
    expect(claims(after, session, 4)).toEqual([true, true, true, false])
  })

  // 种子：缺省固定（helpers/interleave.ts），PM_INTERLEAVE_SEED 覆盖；轮数缺省 60，PM_INTERLEAVE_RUNS 覆盖
  it('随机交错的检索开始和会话事件：每次拿没拿到，等于「这个会话上次清零之后第几次」不超过上限', () => {
    type Op = { kind: 'claim'; session: number } | { kind: 'event'; session: number; event: CallCapEvent }
    const events: CallCapEvent[] = [
      turnStart(), toolCall('bash'), toolCall('memory_save'), programCall('read'), { type: 'tool/call', data: {} },
      toolCall('memory_search'), toolCall('memory_source'), toolCall('run_code'), programCall('memory_search'), ...QUIET_EVENTS,
    ]
    const resets = new Set(events.slice(0, 5))
    const op: fc.Arbitrary<Op> = fc.oneof(
      { weight: 3, arbitrary: fc.record({ kind: fc.constant('claim' as const), session: fc.integer({ min: 0, max: 2 }) }) },
      { weight: 1, arbitrary: fc.record({ kind: fc.constant('event' as const), session: fc.integer({ min: 0, max: 2 }), event: fc.constantFrom(...events) }) },
    )
    fc.assert(fc.property(fc.array(op, { maxLength: 40 }), ops => {
      const cap = new DialogueCallCap()
      const sessions = [{}, {}, {}]
      // 参照：会话没见过清零事件时不计数；见过之后数上次清零以来拿了几次
      const since: Array<number | undefined> = [undefined, undefined, undefined]
      for (const o of ops) {
        if (o.kind === 'event') {
          cap.observe(sessions[o.session]!, o.event)
          if (resets.has(o.event)) since[o.session] = 0
          continue
        }
        const count = since[o.session]
        const expected = count === undefined || count < DIALOGUE_CALL_LIMIT
        if (count !== undefined && expected) since[o.session] = count + 1
        expect(cap.claim(sessions[o.session]!)).toBe(expected)
      }
    }), interleaveParams(60))
  })
})

// —— 经 memory_search 的执行器：真对话记录库、真记忆库，宿主会话和时钟是替身 ——

let dir: string
let db: DialogueRecordStore
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'dialogue-call-cap-')); db = new DialogueRecordStore({ path: join(dir, 'db'), log: LOG }) })
afterEach(async () => { db.close(); await rm(dir, { recursive: true, force: true }) })

async function world(opts: { source?: SearchSource; quotes?: boolean; isBroken?: boolean } = {}) {
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
  // 库打不开：拿不到 node:sqlite
  const library = opts.isBroken ? new DialogueRecordStore({ path: join(dir, 'broken'), log: LOG, loadSqlite: () => undefined }) : db
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
  let configured: SearchSource = opts.source ?? 'both'
  const deps: SearchToolDeps = {
    store, registry: buildTypeRegistry({ template: 'coding', customTypes: {} }), host, now: () => 1000,
    searchSource: () => configured, memoryQuotes: () => opts.quotes ?? false, callCap: cap,
    dialogue: { store: library, catchup, host, noReview, workspaceOf, hasBackgroundTimer: () => true, tokenizer: async () => tokenizer },
  }
  const setConfigured = (source: SearchSource) => { configured = source }
  return { deps, host, cap, library, setConfigured }
}

/** 宿主给工具的执行上下文：会话对象就是 session/event 里的那一个。 */
const execOf = (session: object) => fakeExec({ agent: { session } } as never)
const start = (deps: SearchToolDeps, session: object, args: Partial<SearchArgs> = {}) =>
  executeSearch({ query: '部署', source: 'dialogue', ...args }, execOf(session), deps)
const text = async (pending: ReturnType<typeof start>) => renderSearchResult(await pending)
/** 一次开好一轮的会话：宿主在第一次工具调用前一定发过 turn/start。 */
const openSession = (cap: DialogueCallCap) => { const session = {}; cap.observe(session, turnStart()); return session }

describe('memory_search 的连续调用上限', () => {
  it('连续第四次原话检索：只回用完的说明，不查原话、不查记忆、不报错；做了别的事或新一轮开始后又能搜', async () => {
    const { deps, cap, host } = await world()
    const session = openSession(cap)
    for (let i = 0; i < 3; i++) {
      const got = await text(start(deps, session))
      expect(got).toContain('部署前先跑一遍测试'); expect(got).not.toContain(LIMIT)
    }
    const query = vi.spyOn(db, 'search')
    host.contextOf.mockClear()
    const fourth = await start(deps, session)
    expect(renderSearchResult(fourth)).toBe(LIMIT)
    expect(fourth.hits).toEqual([])
    expect(query).not.toHaveBeenCalled(); expect(host.contextOf).not.toHaveBeenCalled()
    cap.observe(session, toolCall('bash'))
    expect(await text(start(deps, session))).toContain('部署前先跑一遍测试')
    claims(cap, session, 2)
    expect(await text(start(deps, session))).toBe(LIMIT)
    cap.observe(session, turnStart(2))
    expect(await text(start(deps, session))).toContain('部署前先跑一遍测试')
  })

  it('并行发起四次：前三次拿到，按开始的先后第四次只回说明', async () => {
    const { deps, cap } = await world()
    const session = openSession(cap)
    const results = await Promise.all([0, 1, 2, 3].map(() => text(start(deps, session))))
    expect(results.slice(0, 3).every(r => r.includes('部署前先跑一遍测试'))).toBe(true)
    expect(results[3]).toBe(LIMIT)
  })

  it('清零按开始的先后：用完后、清零事件之前开始的那次拿不到；清零之后开始的拿到，不管谁先结束', async () => {
    const { deps, cap } = await world()
    const session = openSession(cap)
    const first = [start(deps, session), start(deps, session), start(deps, session)]
    const before = start(deps, session)
    cap.observe(session, toolCall('bash'))
    const after = start(deps, session)
    const [b, a] = await Promise.all([text(before), text(after), ...first.map(text)])
    expect(b).toBe(LIMIT)
    expect(a).toContain('部署前先跑一遍测试')
  })

  it('中间只调了 memory_source：不清零；中间调了别的工具：清零', async () => {
    const { deps, cap } = await world()
    const session = openSession(cap)
    for (let i = 0; i < 3; i++) await start(deps, session)
    cap.observe(session, toolCall('memory_source'))
    cap.observe(session, QUIET_EVENTS[1]!)
    expect(await text(start(deps, session))).toBe(LIMIT)
    cap.observe(session, toolCall('read'))
    expect(await text(start(deps, session))).toContain('部署前先跑一遍测试')
  })

  it('原话这一路出故障（库打不开）的调用也占名额：三次故障之后第四次只回说明', async () => {
    const { deps, cap } = await world({ isBroken: true })
    const session = openSession(cap)
    for (let i = 0; i < 3; i++) expect(await text(start(deps, session))).toContain(dialogueNote('dialogue-unavailable'))
    expect(await text(start(deps, session))).toBe(LIMIT)
  })

  it('整次调用抛错也占名额：宿主读不出会话上下文的三次之后，第四次只回说明', async () => {
    const { deps, cap, host } = await world()
    const session = openSession(cap)
    for (let i = 0; i < 3; i++) host.contextOf.mockRejectedValueOnce(new Error('宿主读不出会话'))
    for (let i = 0; i < 3; i++) await expect(start(deps, session)).rejects.toThrow('宿主读不出会话')
    expect(await text(start(deps, session))).toBe(LIMIT)
  })

  it('只查记忆不计数：参数只查记忆、配置收窄成只查记忆时传了原话，都不占名额', async () => {
    const { deps, cap, setConfigured } = await world()
    const session = openSession(cap)
    for (let i = 0; i < 5; i++) expect(await text(start(deps, session, { source: 'memory' }))).not.toContain(LIMIT)
    setConfigured('memory')
    for (let i = 0; i < 5; i++) expect(await text(start(deps, session, { source: 'dialogue' }))).toContain(dialogueNote('dialogue-source-off'))
    setConfigured('both')
    for (let i = 0; i < 3; i++) expect(await text(start(deps, session))).toContain('部署前先跑一遍测试')
    expect(await text(start(deps, session))).toBe(LIMIT)
  })

  it('不给参数时跟随配置：配置是两者时计数', async () => {
    const { deps, cap } = await world({ source: 'both' })
    const session = openSession(cap)
    for (let i = 0; i < 3; i++) await start(deps, session, { source: undefined })
    expect(await text(start(deps, session, { source: undefined }))).toContain(LIMIT)
  })

  it('缺关键词的原话检索不查原话，也不占名额', async () => {
    const { deps, cap } = await world()
    const session = openSession(cap)
    for (let i = 0; i < 5; i++) expect(await text(start(deps, session, { query: '  ' }))).toBe('搜原话要给关键词。')
    for (let i = 0; i < 3; i++) expect(await text(start(deps, session))).toContain('部署前先跑一遍测试')
    expect(await text(start(deps, session))).toBe(LIMIT)
  })

  it('两者都查时用完：照查记忆，记忆带原话照常附；其他原话一段只写说明，不查原话', async () => {
    const { deps, cap } = await world({ quotes: true })
    const session = openSession(cap)
    const memoryOnly = await start(deps, session, { source: 'memory' })
    expect(memoryOnly.hits.map(h => h.id)).toEqual(['mem_a'])
    expect(memoryOnly.hits[0]!.quote).toContain('部署前先跑一遍测试')
    for (let i = 0; i < 3; i++) await start(deps, session, { source: 'both' })
    const query = vi.spyOn(db, 'search')
    const over = await start(deps, session, { source: 'both' })
    expect(query).not.toHaveBeenCalled()
    expect(over.hits).toEqual(memoryOnly.hits)
    const rendered = renderSearchResult(over)
    expect(rendered.startsWith(MEMORY_SECTION_HEADING)).toBe(true)
    expect(rendered.endsWith(`${DIALOGUE_SECTION_HEADING}\n${LIMIT}`)).toBe(true)
  })

  it('一次调用里查几轮原话都只占一个名额', async () => {
    const { deps, cap } = await world()
    const session = openSession(cap)
    const query = vi.spyOn(db, 'search')
    // 没有一轮同时含两个词：每次调用先查全中、再查部分命中，至少两轮
    for (let i = 0; i < 3; i++) expect(await text(start(deps, session, { query: '部署 不存在词' }))).toContain('部署前先跑一遍测试')
    expect(query.mock.calls.length).toBeGreaterThan(3)
    expect(await text(start(deps, session, { query: '部署 不存在词' }))).toBe(LIMIT)
  })

  it('子 agent 会话和主会话各算各的', async () => {
    const { deps, cap } = await world()
    const main = openSession(cap)
    const child = openSession(cap)
    for (let i = 0; i < 3; i++) await start(deps, child)
    expect(await text(start(deps, child))).toBe(LIMIT)
    for (let i = 0; i < 3; i++) expect(await text(start(deps, main))).toContain('部署前先跑一遍测试')
    expect(await text(start(deps, main))).toBe(LIMIT)
  })

  it('经工具绑定层调用：用完时照常返回说明，不报错', async () => {
    const { deps, cap } = await world()
    const session = openSession(cap)
    const tool = createSearchTool(deps)
    const run = async () => {
      const value = await tool.execute({ query: '部署', source: 'dialogue' } as never, execOf(session))
      return tool.output.render!({} as never, value as never).map(b => (b as { text: string }).text).join('')
    }
    for (let i = 0; i < 3; i++) expect(await run()).toContain('部署前先跑一遍测试')
    expect(await run()).toBe(LIMIT)
  })
})
