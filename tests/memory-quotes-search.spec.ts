import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DialogueRecordStore } from '../src/storage/dialogue-records.ts'
import { dialogueTokenizer } from '../src/search/dialogue-tokenizer.ts'
import { DialogueCatchup } from '../src/tools/dialogue-catchup.ts'
import { executeSearch, renderSearchResult, type SearchContext, type SearchToolDeps } from '../src/tools/search.ts'
import { executeSource, renderSourceResult } from '../src/tools/source.ts'
import { checkAnchor, quoteReadPolicy, type CheckedAnchor, type SessionTable } from '../src/tools/session-access.ts'
import { NoReviewList } from '../src/storage/no-review.ts'
import { MemoryStore } from '../src/store.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'
import { toToolOutput } from '../src/output.ts'
import { estimateTokens } from '../src/snapshot.ts'
import type { MemoryRecord, SourceAnchor } from '../src/record-schema.ts'
import type { RawEvent, SessionLog } from '../src/session-log.ts'
import { MEMORY_QUOTE_BUDGET_TOKENS } from '../src/search/memory-quotes.ts'
import {
  DIALOGUE_QUOTE_TAG, MEMORY_QUOTES_UNAVAILABLE, dialogueNote, QUOTE_NOT_COLLECTED, QUOTE_NO_REVIEW, QUOTE_PENDING, QUOTE_SESSIONS_UNAVAILABLE,
  QUOTE_SESSION_GONE, QUOTE_UNLOCATED, TURN_NOT_INDEXED_NOTE,
} from '../src/search/dialogue-format.ts'
import { InMemoryTable } from './helpers/in-memory-table.ts'
import { InMemoryBatchKvTable } from './helpers/in-memory-kv.ts'
import { SOURCE_TIME, assistant, event, user } from './helpers/source-host.ts'
import { fakeExec } from './helpers/exec.ts'
import { record } from './helpers/record.ts'

const LOG = { info() {}, warn() {}, error() {} }
const at = (seq: number) => SOURCE_TIME + seq
const turn = (seq: number) => event(seq, 'turn/start')
const logOf = (id: string, events: RawEvent[]): SessionLog => ({ header: { id, isSeeded: false }, inheritedEventCount: 0, events })
/** 前台保存的锚：起点是这一轮的 turn/start，时间是它的时间。 */
const anchor = (sessionId: string, range: [number, number], extra: Partial<SourceAnchor> = {}): SourceAnchor =>
  ({ sessionId, eventRange: range, sourceMode: 'user-explicit', at: at(range[0]), change: 'create', ...extra })
/** 当前版本的锚清单：最新的在前，source 和清单头一致。 */
const withAnchors = (anchors: SourceAnchor[], partial: Partial<MemoryRecord> = {}): MemoryRecord => record({
  scope: 'workspace', workspacePath: '/proj', ...partial,
  source: anchors[0] && { sessionId: anchors[0].sessionId, eventRange: anchors[0].eventRange, sourceMode: 'user-explicit' },
  sourceTrail: anchors,
})

const SECRET = 'sk-abcdefghijklmnopqrstuvwx1234'
const LONG_USER = Array.from({ length: 4 }, (_, i) => `第${i + 1}段：${'背景说明'.repeat(90)}。`).join('\n\n') + '\n\n最后一段讲写锁'

function logs(): Record<string, SessionLog> {
  return {
    s1: logOf('s1', [
      turn(10), user(11, `写锁要在提交前拿，key 是 ${SECRET}`), assistant(12, '我先看一下代码'), event(13, 'tool/call', { callId: 'c', name: 'read', arguments: '{}' }),
      assistant(14, '好的，写锁放在提交前，已经改好'),
      turn(20), user(21, '别的话题'), assistant(22, '收到'),
      turn(30), event(31, 'tool/call', { callId: 'd', name: 'read', arguments: '{}' }),
      turn(40), user(41, LONG_USER), assistant(42, '写锁的长消息看过了'),
      turn(50), user(51, '读锁也要处理'), assistant(52, '读锁照写锁的办法'),
    ]),
    foreign: logOf('foreign', [turn(10), user(11, '全局约定：写锁统一叫 write lock'), assistant(12, '记下了')]),
    hidden: logOf('hidden', [turn(10), user(11, '写锁藏起来的话'), assistant(12, '好')]),
    gone: logOf('gone', [turn(10), user(11, '写锁删掉的会话'), assistant(12, '好')]),
    late: logOf('late', [turn(10), user(11, '写锁晚到的会话'), assistant(12, '好')]),
    outside: logOf('outside', [turn(10), user(11, '写锁范围外'), assistant(12, '好')]),
    // 拿不到继承边界的会话：分不清哪些消息是它自己的，整个不收
    seeded: { header: { id: 'seeded', isSeeded: true }, inheritedEventCount: undefined, events: [turn(10), user(11, '写锁接着说'), assistant(12, '好')] },
    // 每轮一问一答合计约 400 token：三轮合起来超过附原话的预算
    big: logOf('big', [10, 20, 30].flatMap(n => [turn(n), user(n + 1, `写锁${'甲'.repeat(450)}`), assistant(n + 2, `写锁${'乙'.repeat(200)}`)])),
  }
}

let dir: string
let db: DialogueRecordStore
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'memory-quotes-')); db = new DialogueRecordStore({ path: join(dir, 'db'), log: LOG }) })
afterEach(async () => { db.close(); await rm(dir, { recursive: true, force: true }) })

async function setup(records: MemoryRecord[], opts: { context?: Partial<SearchContext>; quotes?: boolean; source?: 'memory' | 'both'; isBuilt?: boolean; hasTimer?: boolean; isBroken?: boolean } = {}) {
  const tokenizer = await dialogueTokenizer({ log: { warn() {} } })
  const all = logs()
  const cwdOf: Record<string, string> = { foreign: '/other', outside: '/elsewhere' }
  const entry = (id: string) => ({ id, cwd: cwdOf[id] ?? '/proj', isSubagent: false, isLive: false })
  const listed = ['s1', 'foreign', 'hidden', 'gone', 'late', 'outside', 'big', 'seeded']
  const host = {
    readSessionLog: vi.fn(async (id: string): Promise<SessionLog | null> => all[id] ?? null),
    sessionTitleOf: vi.fn(async () => undefined),
    listSessions: vi.fn(async () => listed.map(entry)),
    contextOf: vi.fn(async (): Promise<SearchContext> => ({ workspacePath: '/proj', session: { id: 's1', lastSeq: 100 }, ...opts.context })),
  }
  const noReview = new NoReviewList(dir)
  const workspaceOf = async (cwd: string | undefined) => cwd
  const clock = { t: 1000 }
  // 库打不开：拿不到 node:sqlite
  const library = opts.isBroken ? new DialogueRecordStore({ path: join(dir, 'broken'), log: LOG, loadSqlite: () => undefined }) : db
  const catchup = new DialogueCatchup({
    store: library, host, noReview, workspaceOf, tokenizer: async () => tokenizer, knownWorkspaces: async () => ['/proj', '/other'],
    isEnabled: () => true, sessionStore: '/sessions', log: LOG, now: () => clock.t,
  })
  // 建库：late 不在会话清单里，第一次建库时没收；outside 在清单里但不在收录范围
  if (opts.isBuilt !== false && !opts.isBroken) {
    host.listSessions.mockResolvedValueOnce(listed.filter(id => id !== 'late').map(entry))
    await catchup.advance(60_000)
  }
  const store = new MemoryStore(new InMemoryTable(), undefined, new InMemoryBatchKvTable())
  for (const r of records) await store.put(r)
  const deps: SearchToolDeps = {
    store, registry: buildTypeRegistry({ template: 'coding', customTypes: {} }), host, now: () => 1000,
    searchSource: () => opts.source ?? 'memory', memoryQuotes: () => opts.quotes ?? true,
    dialogue: { store: library, catchup, host, noReview, workspaceOf, hasBackgroundTimer: () => opts.hasTimer ?? true, tokenizer: async () => tokenizer },
  }
  host.readSessionLog.mockClear(); host.listSessions.mockClear()
  return { deps, host, noReview, catchup, store, clock }
}
const run = async (deps: SearchToolDeps, query = '写锁') => {
  const result = await executeSearch({ query }, fakeExec(), deps)
  return { result, text: renderSearchResult(result) }
}
/** 检索前的追库会读当前会话的日志；除此之外读过的会话日志（取原话这一步不该读任何日志）。 */
const CURRENT = { session: { id: 'cur', lastSeq: 0 } }
const logReadsBesides = (host: { readSessionLog: { mock: { calls: unknown[][] } } }, current: string) =>
  host.readSessionLog.mock.calls.map(c => c[0]).filter(id => id !== current)
/** 每条命中的记忆后面附的文字（头行和正文之后的部分）。 */
const quoteOf = (result: { hits: Array<{ id: string; quote?: string }> }, id: string) => result.hits.find(h => h.id === id)?.quote ?? ''

describe('开关', () => {
  it('关着时 memory_search 的输出逐字节不变，不查会话、不读库、不读会话日志', async () => {
    const r = withAnchors([anchor('s1', [10, 14])], { id: 'mem_a', name: '写锁时机', content: '写锁在提交前拿' })
    const { deps, host, catchup } = await setup([r], { quotes: false })
    const state = vi.spyOn(db, 'state'); const turns = vi.spyOn(db, 'turnsOf'); const segments = vi.spyOn(db, 'segmentsOf')
    const beforeSearch = vi.spyOn(catchup, 'beforeSearch')
    const baseline = await executeSearch({ query: '写锁' }, fakeExec(), { ...deps, memoryQuotes: undefined, dialogue: undefined })
    const off = await executeSearch({ query: '写锁' }, fakeExec(), deps)
    expect(JSON.stringify(toToolOutput(off))).toBe(JSON.stringify(toToolOutput(baseline)))
    expect(renderSearchResult(off)).toBe(renderSearchResult(baseline))
    expect(host.listSessions).not.toHaveBeenCalled(); expect(host.readSessionLog).not.toHaveBeenCalled()
    expect(state).not.toHaveBeenCalled(); expect(turns).not.toHaveBeenCalled(); expect(segments).not.toHaveBeenCalled()
    expect(beforeSearch).not.toHaveBeenCalled()
  })

  it('开着：命中的记忆后面附出处那一轮的用户原话和助手正文，和会话日志逐字一致，密钥不遮盖；取原话不读会话日志', async () => {
    const r = withAnchors([anchor('s1', [10, 14])], { id: 'mem_a', name: '写锁时机', content: '写锁在提交前拿' })
    const { deps, host } = await setup([r], { context: CURRENT })
    const { result } = await run(deps)
    const block = quoteOf(result, 'mem_a')
    expect(block).toContain(`<${DIALOGUE_QUOTE_TAG}>`)
    expect(block).toContain(`[${new Date(at(11)).getFullYear()}`)
    expect(block).toContain(`用户：写锁要在提交前拿，key 是 ${SECRET}〔引用 s1#11〕`)
    expect(block).toContain('助手：好的，写锁放在提交前，已经改好〔引用 s1#14〕')
    expect(block).not.toContain('我先看一下代码')
    expect(logReadsBesides(host, 'cur')).toEqual([])
  })

  it('开着、库还没建过、只查记忆：检索前追库把当前会话收进库，这次就带上原话', async () => {
    const r = withAnchors([anchor('s1', [10, 14])], { id: 'mem_a', content: '写锁在提交前拿' })
    const { deps } = await setup([r], { isBuilt: false })
    expect(db.state().status).toBe('none')
    expect(quoteOf((await run(deps)).result, 'mem_a')).toContain('助手：好的，写锁放在提交前，已经改好')
  })

  it('开着、没有后台计时器：检索前追库顺带推进待建队列，别的会话也能带上原话', async () => {
    const r = withAnchors([anchor('late', [10, 12])], { id: 'mem_l', content: '写锁晚到' })
    const { deps } = await setup([r], { isBuilt: false, hasTimer: false, context: CURRENT })
    expect(quoteOf((await run(deps)).result, 'mem_l')).toContain('用户：写锁晚到的会话')
  })

  it('只作用在带关键词的检索上：只给类型列出时不带原话，也不查会话', async () => {
    const r = withAnchors([anchor('s1', [10, 14])], { id: 'mem_a', type: 'knowledge', content: '写锁在提交前拿' })
    const { deps, host } = await setup([r])
    const result = await executeSearch({ query: '', types: ['knowledge'] }, fakeExec(), deps)
    expect(renderSearchResult(result)).not.toContain(DIALOGUE_QUOTE_TAG)
    expect(host.listSessions).not.toHaveBeenCalled()
  })

  it('查询直接给记忆 id 也是检索：照常带出处原话', async () => {
    const r = withAnchors([anchor('s1', [10, 14])], { id: 'mem_a', content: '写锁在提交前拿' })
    const { deps } = await setup([r])
    expect(quoteOf((await run(deps, 'mem_a')).result, 'mem_a')).toContain('助手：好的，写锁放在提交前')
  })
})

describe('三种锚', () => {
  it('回看补记的锚是消息序号、跨几轮：按各自所属的轮取，从和记忆最相关的一轮开始', async () => {
    const r = withAnchors([anchor('s1', [41, 52], { at: at(41) })], { id: 'mem_r', content: '读锁照写锁的办法' })
    const { deps } = await setup([r])
    const block = quoteOf((await run(deps, '读锁')).result, 'mem_r')
    expect(block).toContain('用户：读锁也要处理')
    expect(block.indexOf('读锁也要处理')).toBeLessThan(block.indexOf('写锁的长消息看过了'))
  })

  it('起点是 0 的整会话兜底锚：覆盖范围里也找不到像的轮时，如实写定位不到轮', async () => {
    const r = withAnchors([anchor('s1', [0, 14], { at: at(0) })], { id: 'mem_z', name: '写锁', content: '苍穹碧海群鹭翱翔' })
    const { deps } = await setup([r])
    const block = quoteOf((await run(deps)).result, 'mem_z')
    expect(block).toContain(QUOTE_UNLOCATED); expect(block).not.toContain(DIALOGUE_QUOTE_TAG)
  })

  it('带改动性质的锚时间和序号对不上：按时间找回那一轮；0.2.0 的旧锚不重新定位', async () => {
    const moved = withAnchors([anchor('s1', [10, 14], { at: at(50) })], { id: 'mem_m', content: '写锁在提交前拿' })
    const old = record({ id: 'mem_o', scope: 'workspace', workspacePath: '/proj', content: '写锁在提交前拿', updatedAt: at(50), source: { sessionId: 's1', eventRange: [10, 14], sourceMode: 'user-explicit' } })
    const { deps } = await setup([moved, old])
    const { result } = await run(deps)
    expect(quoteOf(result, 'mem_m')).toContain('读锁也要处理')
    expect(quoteOf(result, 'mem_o')).toContain('写锁要在提交前拿')
  })
})

describe('预算和多锚', () => {
  it('附在记忆下面的原话合计不超过 1000 token：超出时从排名靠后的记忆开始不带', async () => {
    const records = [10, 20, 30].map((seq, i) => withAnchors([anchor('big', [seq, seq + 2])], { id: `mem_${i + 1}`, content: `写锁 第${i + 1}条` }))
    const { deps } = await setup(records)
    const { result } = await run(deps)
    // 三条记忆要附的原话合计超出预算
    expect(3 * (estimateTokens(`写锁${'甲'.repeat(450)}`) + estimateTokens(`写锁${'乙'.repeat(200)}`))).toBeGreaterThan(MEMORY_QUOTE_BUDGET_TOKENS)
    const quoted = result.hits.filter(h => h.quote?.includes(DIALOGUE_QUOTE_TAG))
    const bodies = quoted.flatMap(h => [...h.quote!.matchAll(/(?:用户|助手)：([\s\S]*?)(?:〔|（节选|\n\[|\n<\/)/g)].map(m => m[1]!))
    expect(bodies.reduce((n, t) => n + estimateTokens(t), 0)).toBeLessThanOrEqual(MEMORY_QUOTE_BUDGET_TOKENS)
    expect(result.hits).toHaveLength(3)
    expect(result.hits.map(h => h.quote?.includes(DIALOGUE_QUOTE_TAG) ?? false)).toEqual([true, true, false])
  })

  it('一个版本有几个锚：最新的先带，预算有余再加旧的', async () => {
    const r = withAnchors([anchor('s1', [50, 52]), anchor('s1', [10, 14])], { id: 'mem_m', content: '锁' })
    const { deps } = await setup([r])
    const block = quoteOf((await run(deps, '锁')).result, 'mem_m')
    expect(block.indexOf('读锁也要处理')).toBeGreaterThan(-1)
    expect(block.indexOf('读锁也要处理')).toBeLessThan(block.indexOf('写锁要在提交前拿'))
  })
})

describe('长消息和引用', () => {
  it('用户消息切过时给最相关的一段并标节选；拿引用调 memory_source 能读到这条消息的全文', async () => {
    const r = withAnchors([anchor('s1', [40, 42])], { id: 'mem_l', content: '写锁' })
    const { deps, host, noReview } = await setup([r])
    const block = quoteOf((await run(deps)).result, 'mem_l')
    expect(block).toContain('最后一段讲写锁（节选，这条消息共')
    expect(block).toContain('可用 memory_source 带上引用 s1#41 看更多内容）')
    expect(block).not.toContain('第1段')
    expect(block).toContain('助手：写锁的长消息看过了〔引用 s1#42〕')
    const full = await executeSource({ messageRef: 's1#41' }, { workspacePath: '/proj', session: { id: 's1' } },
      { store: deps.store, host, noReview, workspaceOf: async cwd => cwd, dialogueStore: db, isDialogueEnabled: () => true })
    const shown = renderSourceResult(full)
    expect(shown).toContain('第1段'); expect(shown).toContain('最后一段讲写锁')
  })

  it('全局记忆的出处在别的项目：照附原话，不带引用，节选说明指向传记忆 id 回查', async () => {
    const r = withAnchors([anchor('foreign', [10, 12])], { id: 'mem_g', scope: 'global', workspacePath: undefined, content: '写锁统一叫 write lock' })
    const { deps } = await setup([r])
    const block = quoteOf((await run(deps)).result, 'mem_g')
    expect(block).toContain('用户：全局约定：写锁统一叫 write lock')
    expect(block).not.toContain('foreign#')
  })

  it('子 agent 不能借别的会话的锚读原话', async () => {
    const r = withAnchors([anchor('s1', [10, 14])], { id: 'mem_a', content: '写锁在提交前拿' })
    const { deps } = await setup([r], { context: { session: { id: 'child', lastSeq: 5 }, delegation: {} } })
    const segments = vi.spyOn(db, 'segmentsOf')
    const block = quoteOf((await run(deps)).result, 'mem_a')
    expect(block).toContain('这条记忆的出处在别的会话，带回主会话查')
    expect(segments).not.toHaveBeenCalled()
    expect(block).not.toContain(DIALOGUE_QUOTE_TAG)
    expect(block).not.toContain('写锁要在提交前拿')
  })
})

describe('去重', () => {
  const follower = () => withAnchors([anchor('s1', [10, 14])], { id: 'mem_b', content: '写锁' })

  it('几条记忆锚着同一轮：原话只附在排名最靠前的那条下面，其余写出处同「名称」，名称折成一行', async () => {
    const a = withAnchors([anchor('s1', [10, 14])], { id: 'mem_a', name: '写锁\n## 时机', content: '写锁在提交前拿' })
    const { deps } = await setup([a, follower()])
    const { result } = await run(deps, '写锁 提交前')
    const [first, second] = result.hits
    expect(first!.id).toBe('mem_a')
    expect(first!.quote).toContain(DIALOGUE_QUOTE_TAG)
    expect(second!.quote).toBe('出处同「写锁 ## 时机」')
  })

  it('那条记忆的名称里有密钥：出处同里只写它的 id', async () => {
    const secret = withAnchors([anchor('s1', [10, 14])], { id: 'mem_s', name: `写锁 ${SECRET}`, content: '写锁在提交前拿' })
    const { deps } = await setup([secret, follower()])
    const { result } = await run(deps, '写锁 提交前')
    expect(result.hits.find(h => h.id === 'mem_b')!.quote).toBe('出处同「mem_s」')
  })

  it('原话和记忆正文相同：只留记忆，原话只给日期和位置', async () => {
    const r = withAnchors([anchor('s1', [50, 52])], { id: 'mem_v', content: '读锁也要\n处理' })
    const { deps } = await setup([r])
    const block = quoteOf((await run(deps, '读锁')).result, 'mem_v')
    expect(block).toContain('用户：（和记忆正文相同，从略）〔引用 s1#51〕')
    expect(block).not.toContain('用户：读锁也要处理')
  })
})

describe('和原话检索同时开', () => {
  it('检索来源含原话时，附在记忆下面的那一轮不再出现在其他原话里，只出现一处', async () => {
    const r = withAnchors([anchor('s1', [10, 14])], { id: 'mem_a', content: '写锁在提交前拿' })
    const { deps } = await setup([r], { source: 'both' })
    const { result, text } = await run(deps)
    expect(quoteOf(result, 'mem_a')).toContain('用户：写锁要在提交前拿')
    expect(result.dialogueText).not.toContain('写锁要在提交前拿')
    expect(text.split('用户：写锁要在提交前拿')).toHaveLength(2)
  })
})

describe('取不到', () => {
  it('这一轮在库里但没有可展示的内容：写这一轮暂无原话，不落到上一轮', async () => {
    const r = withAnchors([anchor('s1', [30, 31])], { id: 'mem_e', content: '写锁' })
    const { deps } = await setup([r])
    const block = quoteOf((await run(deps)).result, 'mem_e')
    expect(block).toContain(TURN_NOT_INDEXED_NOTE); expect(block).not.toContain('收到')
  })

  it('锚时间早于这个会话的每一轮：写定位不到出处是哪一轮，不按旧序号给原话', async () => {
    const r = withAnchors([anchor('s1', [20, 22], { at: SOURCE_TIME - 1000 })], { id: 'mem_t', content: '写锁' })
    const { deps } = await setup([r])
    const block = quoteOf((await run(deps)).result, 'mem_t')
    expect(block).toContain(QUOTE_UNLOCATED); expect(block).not.toContain('别的话题')
  })

  it('锚区间写坏：写定位不到出处是哪一轮，一段都不读', async () => {
    const ranges: Array<[number, number]> = [[25, 20], [Number.NaN, 20], [-1, 20], [1.5, 3], [10, Number.POSITIVE_INFINITY]]
    const words = ['bravo', 'charlie', 'delta', 'echo', 'foxtrot']
    const records = ranges.map((range, i) => withAnchors([anchor('s1', range, { at: SOURCE_TIME })], { id: `mem_bad${i}`, content: `写锁 ${words[i]}` }))
    const { deps } = await setup(records)
    const segments = vi.spyOn(db, 'segmentsOf'); const session = vi.spyOn(db, 'session')
    for (const [i, r] of records.entries()) expect(quoteOf((await run(deps, words[i])).result, r.id)).toContain(QUOTE_UNLOCATED)
    expect(segments).not.toHaveBeenCalled(); expect(session).not.toHaveBeenCalled()
  })

  it('会话已删、标了不回看各写各的说明；新开、还没对过账的会话按还在整理，不在收录范围的写没有收录；取原话都不读会话日志', async () => {
    const records = [
      withAnchors([anchor('gone', [10, 12])], { id: 'mem_gone', content: '写锁一' }),
      withAnchors([anchor('hidden', [10, 12])], { id: 'mem_hidden', content: '写锁二' }),
      withAnchors([anchor('late', [10, 12])], { id: 'mem_late', content: '写锁三' }),
    ]
    const { deps, host, noReview } = await setup(records, { context: CURRENT })
    await noReview.mark('hidden', 1000)
    host.listSessions.mockResolvedValue(['s1', 'hidden', 'late', 'outside', 'foreign'].map(id => ({ id, cwd: id === 'outside' ? '/elsewhere' : '/proj', isSubagent: false, isLive: false })))
    const { result } = await run(deps)
    expect(quoteOf(result, 'mem_gone')).toContain(QUOTE_SESSION_GONE)
    expect(quoteOf(result, 'mem_hidden')).toContain(QUOTE_NO_REVIEW)
    expect(quoteOf(result, 'mem_late')).toContain(QUOTE_PENDING)
    expect(logReadsBesides(host, 'cur')).toEqual([])

    const outside = withAnchors([anchor('outside', [10, 12])], { id: 'mem_out', content: '写锁四' })
    await deps.store.put(outside)
    expect(quoteOf((await run(deps, '写锁四')).result, 'mem_out')).toContain(QUOTE_NOT_COLLECTED)
  })

  it('分不清哪些消息是它自己的会话（建库时整个跳过）：写这个会话的原话没有收录；之后对账不再重读它的日志', async () => {
    const r = withAnchors([anchor('seeded', [10, 12])], { id: 'mem_sd', content: '写锁' })
    const { deps, host, catchup, clock } = await setup([r], { context: CURRENT })
    expect(quoteOf((await run(deps)).result, 'mem_sd')).toContain(QUOTE_NOT_COLLECTED)
    clock.t += 10 * 60_000
    host.readSessionLog.mockClear()
    await catchup.advance(60_000)
    expect(host.listSessions).toHaveBeenCalled()
    expect(host.readSessionLog.mock.calls.map(c => c[0])).not.toContain('seeded')
  })

  it('会话的行标了移出库、对账又把它排回待建队列（标过不回看、后来取消）：写还在整理，取原话不读会话日志', async () => {
    const r = withAnchors([anchor('gone', [10, 12])], { id: 'mem_x', content: '写锁' })
    const { deps, host, catchup } = await setup([r], { context: CURRENT })
    catchup.dropSession('gone')
    expect(quoteOf((await run(deps)).result, 'mem_x')).toContain(QUOTE_PENDING)
    expect(logReadsBesides(host, 'cur')).toEqual([])
  })

  it('稳态下新开的当前会话这次读不到日志：库里只有它还没收到东西的行，写还在整理', async () => {
    const r = withAnchors([anchor('cur2', [10, 12])], { id: 'mem_c2', content: '写锁' })
    const { deps, host } = await setup([r], { context: CURRENT })
    // 先检索一次进入稳态：当前项目已在范围里，下次对账还没到
    await run(deps)
    host.listSessions.mockResolvedValue(['s1', 'cur2'].map(id => ({ id, cwd: '/proj', isSubagent: false, isLive: true })))
    host.contextOf.mockResolvedValue({ workspacePath: '/proj', session: { id: 'cur2', lastSeq: 100 } })
    expect(quoteOf((await run(deps)).result, 'mem_c2')).toContain(QUOTE_PENDING)
  })

  it('开着的空会话收过一次、出了队，后来有了新消息，这次检索没来得及追它：写还在整理', async () => {
    const r = withAnchors([anchor('fresh', [10, 12])], { id: 'mem_f', content: '写锁' })
    const { deps, host, catchup, clock } = await setup([r], { context: CURRENT })
    await run(deps)
    host.listSessions.mockResolvedValue([{ id: 'fresh', cwd: '/proj', isSubagent: false, isLive: true }])
    host.readSessionLog.mockImplementation(async (id: string) => id === 'fresh' ? logOf('fresh', []) : null)
    // 下次对账：空会话排进队、收了一次（还没有自己的事件），出队
    clock.t += 10 * 60_000
    await catchup.advance(60_000)
    host.readSessionLog.mockImplementation(async (id: string) => {
      // 追当前会话就用完了这次的时限
      if (id === 'cur') { clock.t += 10_000; return null }
      return id === 'fresh' ? logOf('fresh', [turn(10), user(11, '写锁新话'), assistant(12, '好')]) : null
    })
    expect(quoteOf((await run(deps)).result, 'mem_f')).toContain(QUOTE_PENDING)
  })

  it('库还在追这个会话：写原话还在整理，取原话不读会话日志', async () => {
    const r = withAnchors([anchor('s1', [60, 62])], { id: 'mem_p', content: '写锁' })
    const { deps, host } = await setup([r], { context: CURRENT })
    expect(quoteOf((await run(deps)).result, 'mem_p')).toContain(QUOTE_PENDING)
    expect(logReadsBesides(host, 'cur')).toEqual([])
  })

  it('会话清单这次读不到：说明一次读不到会话信息，不说会话没了', async () => {
    const r = withAnchors([anchor('s1', [10, 14])], { id: 'mem_a', content: '写锁' })
    const { deps, host } = await setup([r])
    host.listSessions.mockResolvedValue(null as never)
    const { text } = await run(deps)
    expect(text).toContain(QUOTE_SESSIONS_UNAVAILABLE); expect(text).not.toContain(QUOTE_SESSION_GONE)
    expect(text).toContain('写锁')
  })

  it('原话这一路出故障：记忆照常返回，开头说明一次原话这次取不到', async () => {
    const r = withAnchors([anchor('s1', [10, 14])], { id: 'mem_a', content: '写锁在提交前拿' })
    const { deps } = await setup([r])
    vi.spyOn(db, 'turnsOf').mockImplementation(() => { throw new Error('disk') })
    const { text, result } = await run(deps)
    expect(text.split(MEMORY_QUOTES_UNAVAILABLE)).toHaveLength(2)
    expect(result.hits.map(h => h.id)).toEqual(['mem_a'])
    expect(result.hits[0]!.quote).toBeUndefined()
  })

  it('等分词器期间库被删：不重建库文件，按还在整理说，不说这一轮暂无原话', async () => {
    const r = withAnchors([anchor('s1', [10, 14])], { id: 'mem_a', content: '写锁在提交前拿' })
    const { deps, catchup } = await setup([r], { context: CURRENT })
    const dialogue = deps.dialogue!
    const removing = { ...deps, dialogue: { ...dialogue, tokenizer: async () => { catchup.destroy(); return dialogue.tokenizer() } } }
    const block = quoteOf((await run(removing)).result, 'mem_a')
    expect(existsSync(join(dir, 'db'))).toBe(false)
    expect(block).toContain(QUOTE_PENDING); expect(block).not.toContain(TURN_NOT_INDEXED_NOTE)
  })
})

describe('时限', () => {
  /** 两路都开、只有会话表花时间：用注入的时钟把每次查会话表记成 cost 毫秒。 */
  async function timedSearch(cost: number, query = '写锁') {
    const r = withAnchors([anchor('s1', [10, 14])], { id: 'mem_a', content: '写锁在提交前拿' })
    const { deps, host } = await setup([r], { source: 'both', context: CURRENT })
    // 先查一次：追库把当前项目登记好、对账做完，下面这次的会话表只剩检索自己查的那一次
    await run(deps)
    const original = host.listSessions.getMockImplementation()!
    let t = 1000
    host.listSessions.mockClear()
    host.listSessions.mockImplementation(async () => { t += cost; return original() })
    const started = t
    const result = await executeSearch({ query }, fakeExec(), { ...deps, now: () => t })
    return { result, elapsed: t - started, tableCalls: host.listSessions.mock.calls.length }
  }

  it('原话检索用掉大半时限：附原话用剩下的时间，总耗时不超过两秒，会话表只查一次', async () => {
    const { result, elapsed, tableCalls } = await timedSearch(1500)
    expect(elapsed).toBeLessThanOrEqual(2000)
    expect(tableCalls).toBe(1)
    expect(result.dialogueText).toContain(DIALOGUE_QUOTE_TAG)
    expect(quoteOf(result, 'mem_a')).toContain('助手：好的，写锁放在提交前，已经改好')
  })

  it('原话检索超时退回只查记忆：不再另拿两秒取原话，只在原话段说明一次，会话表只查一次', async () => {
    const { result, tableCalls } = await timedSearch(2100)
    expect(tableCalls).toBe(1)
    expect(result.quoteNote).toBeUndefined()
    expect(result.dialogueText).toBe(dialogueNote('dialogue-unavailable'))
    expect(quoteOf(result, 'mem_a')).toBe('')
    expect(result.hits.map(h => h.id)).toEqual(['mem_a'])
  })

  it('记忆一条都没命中、原话一路超时：照常说没有匹配的记忆，不说出处原话取不到', async () => {
    const { result } = await timedSearch(2100, '完全对不上的词')
    const text = renderSearchResult(result)
    expect(result.hits).toEqual([])
    expect(text).toContain('没有匹配的记忆。'); expect(text).not.toContain(MEMORY_QUOTES_UNAVAILABLE)
  })
})

describe('库这次用不了', () => {
  it('记忆一条都没命中、追库抛错：照常说没有匹配的记忆，不说出处原话取不到', async () => {
    const r = withAnchors([anchor('s1', [10, 14])], { id: 'mem_a', content: '写锁在提交前拿' })
    const { deps, catchup } = await setup([r])
    vi.spyOn(catchup, 'beforeSearch').mockRejectedValue(new Error('disk'))
    const { text } = await run(deps, '完全对不上的词')
    expect(text).toContain('没有匹配的记忆。'); expect(text).not.toContain(MEMORY_QUOTES_UNAVAILABLE)
  })

  it('库打不开、只查记忆：开头说明一次出处原话取不到，不说还在整理，也不为附原话查会话表', async () => {
    const r = withAnchors([anchor('s1', [10, 14])], { id: 'mem_a', content: '写锁在提交前拿' })
    const { deps, host } = await setup([r], { isBroken: true })
    const { result, text } = await run(deps)
    expect(result.quoteNote).toBe(MEMORY_QUOTES_UNAVAILABLE)
    expect(text.split(MEMORY_QUOTES_UNAVAILABLE)).toHaveLength(2)
    expect(text).not.toContain(QUOTE_PENDING)
    expect(quoteOf(result, 'mem_a')).toBe('')
    expect(host.listSessions).not.toHaveBeenCalled()
  })

  it('库打不开、两路都查：退回只查记忆，只说一次原话暂时查不了，没有还在整理', async () => {
    const r = withAnchors([anchor('s1', [10, 14])], { id: 'mem_a', content: '写锁在提交前拿' })
    const { deps, host } = await setup([r], { isBroken: true, source: 'both' })
    const { result, text } = await run(deps)
    expect(result.quoteNote).toBeUndefined()
    expect(text.split(dialogueNote('dialogue-unavailable'))).toHaveLength(2)
    expect(text).not.toContain(MEMORY_QUOTES_UNAVAILABLE)
    expect(text).not.toContain(QUOTE_PENDING)
    expect(host.listSessions).not.toHaveBeenCalled()
  })

  it('追库回来说功能关了：不附原话，也不加说明，不查会话表', async () => {
    const r = withAnchors([anchor('s1', [10, 14])], { id: 'mem_a', content: '写锁在提交前拿' })
    const { deps, catchup, host } = await setup([r])
    vi.spyOn(catchup, 'beforeSearch').mockResolvedValue({ kind: 'off' })
    const { result } = await run(deps)
    expect(result.quoteNote).toBeUndefined(); expect(quoteOf(result, 'mem_a')).toBe('')
    expect(host.listSessions).not.toHaveBeenCalled()
  })
})

describe('放行', () => {
  const table = (over: Partial<SessionTable> = {}): SessionTable => ({ isComplete: true, get: () => ({ workspacePath: '/proj', isSubagent: false }), isMarkedNoReview: () => false, ...over })

  it('只收过了记忆规则的锚，传不进一个随手的放行', () => {
    // @ts-expect-error 普通对象不是 CheckedAnchor
    quoteReadPolicy({ sessionId: 's1', record: { id: 'mem_a' } }, table())
    // @ts-expect-error 布尔开关不是 CheckedAnchor
    quoteReadPolicy(true, table())
    const checked = checkAnchor({ id: 'mem_a', scope: 'workspace', workspacePath: '/other' }, 's1', { workspacePath: '/proj' })
    expect(checked.ok).toBe(false)
  })

  it('项目记忆没有项目路径时不放行，当前会话没有工作目录也一样', () => {
    expect(checkAnchor({ id: 'mem_a', scope: 'workspace' }, 's1', { workspacePath: undefined }).ok).toBe(false)
    expect(checkAnchor({ id: 'mem_a', scope: 'workspace' }, 's1', { workspacePath: '/proj' }).ok).toBe(false)
    expect(checkAnchor({ id: 'mem_a', scope: 'workspace', workspacePath: '/proj' }, 's1', { workspacePath: '/proj' }).ok).toBe(true)
  })

  it('记忆规则过了还要看会话事实：读不全、没了、不回看各自拒绝', () => {
    const checked = checkAnchor({ id: 'mem_g', scope: 'global' }, 'foreign', { workspacePath: '/proj' })
    if (!checked.ok) throw new Error('全局记忆的锚应放行')
    const anchorOk: CheckedAnchor = checked.anchor
    expect(quoteReadPolicy(anchorOk, table())).toEqual({ ok: true })
    expect(quoteReadPolicy(anchorOk, table({ isComplete: false }))).toEqual({ ok: false, kind: 'unavailable' })
    expect(quoteReadPolicy(anchorOk, table({ get: () => undefined }))).toEqual({ ok: false, kind: 'gone' })
    expect(quoteReadPolicy(anchorOk, table({ isMarkedNoReview: () => true }))).toEqual({ ok: false, kind: 'no-review' })
  })

  it('同一会话：按记忆 id 回查照常放行，带原话因不回看拒绝', async () => {
    const r = withAnchors([anchor('s1', [10, 14])], { id: 'mem_a', content: '写锁在提交前拿' })
    const { deps, host, noReview } = await setup([r])
    await noReview.mark('s1', 1000)
    expect(quoteOf((await run(deps)).result, 'mem_a')).toContain(QUOTE_NO_REVIEW)
    const source = await executeSource({ memoryId: 'mem_a' }, { workspacePath: '/proj', session: { id: 's1' } }, { store: deps.store, host, noReview })
    expect(source.kind).toBe('ok')
  })
})
