import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DialogueRecordStore } from '../src/storage/dialogue-records.ts'
import { dialogueTokenizer, type DialogueTokenizer } from '../src/search/dialogue-tokenizer.ts'
import { DialogueCatchup } from '../src/tools/dialogue-catchup.ts'
import { executeSearch, renderSearchResult, type SearchContext, type SearchToolDeps } from '../src/tools/search.ts'
import { Config } from '../src/index.ts'
import { NoReviewList } from '../src/storage/no-review.ts'
import { MemoryStore } from '../src/store.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'
import { toToolOutput } from '../src/output.ts'
import { estimateTokens } from '../src/snapshot.ts'
import type { MemoryRecord, SourceAnchor } from '../src/record-schema.ts'
import type { RawEvent, SessionLog } from '../src/session-log.ts'
import { MEMORY_QUOTE_BUDGET_TOKENS } from '../src/search/memory-quotes.ts'
import {
  DIALOGUE_BUDGET_DEFAULT, DIALOGUE_QUOTE_TAG, QUOTE_PENDING, SAME_AS_MEMORY_NOTE, DIALOGUE_SECTION_HEADING, MEMORY_SECTION_HEADING, dialogueNote, memoryQuoteStatus,
} from '../src/search/dialogue-format.ts'
import { InMemoryTable } from './helpers/in-memory-table.ts'
import { InMemoryBatchKvTable } from './helpers/in-memory-kv.ts'
import { SOURCE_TIME, assistant, event, user } from './helpers/source-host.ts'
import { fakeExec } from './helpers/exec.ts'
import { record } from './helpers/record.ts'

// 检索来源是「两者」时记忆和原话在一次检索里融合：原话段按名次合并排序，同一轮只在一处输出，两份原话预算分开记账。

const LOG = { info() {}, warn() {}, error() {} }
const at = (seq: number) => SOURCE_TIME + seq
const turn = (seq: number) => event(seq, 'turn/start')
const logOf = (id: string, events: RawEvent[]): SessionLog => ({ header: { id, isSeeded: false }, inheritedEventCount: 0, events })
const anchor = (sessionId: string, range: [number, number]): SourceAnchor =>
  ({ sessionId, eventRange: range, sourceMode: 'user-explicit', at: at(range[0]), change: 'create' })
const anchored = (sessionId: string, range: [number, number], partial: Partial<MemoryRecord>): MemoryRecord => record({
  scope: 'workspace', workspacePath: '/proj', ...partial,
  source: { sessionId, eventRange: range, sourceMode: 'user-explicit' },
  sourceTrail: [anchor(sessionId, range)],
})

const PAD = '背景说明'.repeat(90)
/** 切成三段的长回答：甲段、乙段、丙段各约 220 token。 */
/** 只含一个关键词、比节选窗口长的记忆正文，尾句不在命中窗口里；会话 sd 里有一句和它一字不差。 */
const EXCERPTED_TEXT = `写锁 ${'未'.repeat(340)}关键尾句`
/** 和一条记忆的正文一字不差的提问。 */
const SAME_AS_NOTE_TEXT = `写锁 ${'卯'.repeat(440)}`
const LONG_ANSWER = [`甲段写锁${PAD}`, `乙段${PAD}`, `丙段写锁 提交前${PAD}`].join('\n\n')

function logs(): Record<string, SessionLog> {
  return {
    a: logOf('a', [
      turn(10), user(11, '写锁要在提交前拿'), assistant(12, '好的，写锁放在提交前'),
      turn(20), user(21, '讲讲写锁'), assistant(22, LONG_ANSWER),
      turn(30), user(31, '读锁也要处理'), assistant(32, '读锁照写锁的办法'),
      turn(40), user(41, '写锁的超时设多少'), assistant(42, '写锁超时设三十秒'),
    ]),
    b: logOf('b', [turn(10), user(11, '写锁 日志 写锁 日志 都要打'), assistant(12, '写锁日志已加')]),
    c: logOf('c', [turn(10), user(11, '收尾时写锁和日志一起看'), assistant(12, '收尾看过了')]),
    // 每轮一问一答合计约 400 token：三轮合起来超过附原话的预算
    big: logOf('big', [10, 20, 30].flatMap(n => [turn(n), user(n + 1, `写锁${'甲'.repeat(450)}`), assistant(n + 2, `写锁${'乙'.repeat(200)}`)])),
    // 八轮各约 270 token 的命中：合起来超过其他原话的预算
    many: logOf('many', [10, 20, 30, 40, 50, 60, 70, 80].flatMap(n => [turn(n), user(n + 1, `写锁${'丙'.repeat(450)}`)])),
    // 各约 270 token：第 10、20 轮两个词都有，第 40 轮只有「写锁」
    q: logOf('q', [turn(10), user(11, `写锁 事务 ${'丁'.repeat(440)}`), turn(20), user(21, `写锁 事务 ${'戊'.repeat(440)}`), turn(40), user(41, `写锁 ${'己'.repeat(440)}`)]),
    // 第 10 轮的回答切成强、弱两段，第 20 轮一段居中；三段各约 250 token
    r: logOf('r', [
      turn(10), user(11, '说说'), assistant(12, [`写锁 事务 写锁 事务 写锁 事务 ${'子'.repeat(400)}`, `写锁 事务 ${'丑'.repeat(410)}`].join('\n\n')),
      turn(20), user(21, `写锁 事务 写锁 事务 ${'寅'.repeat(405)}`),
    ]),
    // sa 的第 10 轮短、是记忆的出处，第 20 轮只提一次；sb 两轮都提两次。长的各约 270 token
    sa: logOf('sa', [turn(10), user(11, '写锁要拿'), assistant(12, '拿了'), turn(20), user(21, `写锁 ${'辛'.repeat(440)}`)]),
    sb: logOf('sb', [turn(10), user(11, `写锁 写锁 ${'壬'.repeat(440)}`), turn(20), user(21, `写锁 写锁 ${'癸'.repeat(440)}`)]),
    // 第 10 轮的提问和一条记忆的正文相同；三轮各约 270 token
    sd: logOf('sd', [turn(10), user(11, EXCERPTED_TEXT)]),
    se: logOf('se', [turn(10), user(11, '写锁要拿'), assistant(12, '拿了')]),
    sc: logOf('sc', [turn(10), user(11, SAME_AS_NOTE_TEXT), turn(20), user(21, `写锁 ${'辰'.repeat(440)}`), turn(30), user(31, `写锁 ${'巳'.repeat(440)}`)]),
  }
}

let dir: string
let db: DialogueRecordStore
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'search-fusion-')); db = new DialogueRecordStore({ path: join(dir, 'db'), log: LOG }) })
afterEach(async () => { db.close(); await rm(dir, { recursive: true, force: true }) })

interface SetupOptions { sessions?: string[]; quotes?: boolean; source?: 'memory' | 'dialogue' | 'both'; isBuilt?: boolean; isBroken?: boolean; budget?: number }

async function setup(records: MemoryRecord[], opts: SetupOptions = {}) {
  const tokenizer = await dialogueTokenizer({ log: { warn() {} } })
  const all = logs()
  const listed = opts.sessions ?? ['a', 'b', 'c']
  const entry = (id: string) => ({ id, cwd: '/proj', isSubagent: false, isLive: false })
  const host = {
    readSessionLog: vi.fn(async (id: string) => all[id] ?? null),
    sessionTitleOf: vi.fn(async (id: string) => `会话${id}`),
    listSessions: vi.fn(async () => listed.map(entry)),
    contextOf: vi.fn(async (): Promise<SearchContext> => ({ workspacePath: '/proj', session: { id: 'cur', lastSeq: 0 } })),
  }
  const noReview = new NoReviewList(dir)
  const workspaceOf = async (cwd: string | undefined) => cwd
  const library = opts.isBroken ? new DialogueRecordStore({ path: join(dir, 'broken'), log: LOG, loadSqlite: () => undefined }) : db
  const catchup = new DialogueCatchup({
    store: library, host, noReview, workspaceOf, tokenizer: async () => tokenizer, knownWorkspaces: async () => ['/proj'],
    isEnabled: () => true, sessionStore: '/sessions', log: LOG, now: () => 1000,
  })
  if (opts.isBuilt !== false && !opts.isBroken) await catchup.advance(60_000)
  const store = new MemoryStore(new InMemoryTable(), undefined, new InMemoryBatchKvTable())
  for (const r of records) await store.put(r)
  const deps: SearchToolDeps = {
    store, registry: buildTypeRegistry({ template: 'coding', customTypes: {} }), host, now: () => 1000,
    searchSource: () => opts.source ?? 'both', memoryQuotes: () => opts.quotes ?? true,
    dialogue: {
      store: library, catchup, host, noReview, workspaceOf, hasBackgroundTimer: () => true, tokenizer: async () => tokenizer,
      ...(opts.budget === undefined ? {} : { budget: () => opts.budget! }),
    },
  }
  host.readSessionLog.mockClear(); host.listSessions.mockClear()
  return { deps, host, catchup }
}

const run = async (deps: SearchToolDeps, query = '写锁') => {
  const result = await executeSearch({ query }, fakeExec(), deps)
  return { result, text: renderSearchResult(result) }
}
/** 关掉原话和带原话、也不给原话依赖时的结果：升级前的记忆检索。 */
const memoryOnly = (deps: SearchToolDeps, query = '写锁') =>
  executeSearch({ query }, fakeExec(), { ...deps, searchSource: () => 'memory', memoryQuotes: undefined, dialogue: undefined })
const occurrences = (text: string, needle: string) => text.split(needle).length - 1

/** 一段渲染好的原话里每条消息的正文：去掉时间、说话人、引用和节选说明、续行缩进，缺段标记处拆开。 */
function bodiesOf(text: string | undefined): string[] {
  if (text === undefined) return []
  return [...text.matchAll(/^(?:\[[^\]]+\] )?(?:用户|助手|工具)：(.*(?:\n {2}.*)*)/gm)]
    .map(m => m[1]!.replace(/\n {2}/g, '\n').replace(/(〔引用 [^〕]+〕|（节选，[^）]+）)$/, ''))
    .flatMap(body => body.split('\n……\n'))
}
const tokensOf = (bodies: readonly string[]) => bodies.reduce((n, body) => n + estimateTokens(body), 0)

describe('三个来源乘带原话开关', () => {
  const memory = () => anchored('a', [10, 12], { id: 'mem_a', name: '写锁时机', content: '写锁在提交前拿' })

  it('只查记忆、不带原话：和升级前逐字节一致，不建库、不查会话、不读会话日志', async () => {
    const { deps, host, catchup } = await setup([memory()], { source: 'memory', quotes: false, isBuilt: false })
    const beforeSearch = vi.spyOn(catchup, 'beforeSearch')
    const baseline = await memoryOnly(deps)
    const result = await executeSearch({ query: '写锁' }, fakeExec(), deps)
    expect(JSON.stringify(toToolOutput(result))).toBe(JSON.stringify(toToolOutput(baseline)))
    expect(renderSearchResult(result)).toBe(renderSearchResult(baseline))
    expect(beforeSearch).not.toHaveBeenCalled()
    expect(host.listSessions).not.toHaveBeenCalled(); expect(host.readSessionLog).not.toHaveBeenCalled()
    expect(existsSync(join(dir, 'db'))).toBe(false)
  })

  it('只查记忆、带原话：记忆附出处原话，没有其他原话段', async () => {
    const { deps } = await setup([memory()], { source: 'memory', quotes: true })
    const { result, text } = await run(deps)
    expect(result.hits[0]!.quote).toContain('用户：写锁要在提交前拿')
    expect(text).not.toContain(DIALOGUE_SECTION_HEADING)
  })

  it.each([false, true])('只查原话（带原话 %s）：只给原话，不给记忆条目', async quotes => {
    const { deps } = await setup([memory()], { source: 'dialogue', quotes })
    const { result, text } = await run(deps)
    expect(result.hits).toEqual([])
    expect(text).not.toContain(MEMORY_SECTION_HEADING); expect(text).not.toContain('写锁时机')
    expect(text).toContain('用户：写锁要在提交前拿')
    expect(text).not.toContain('对应记忆')
  })

  it('两者、不带原话：记忆条目不附原话；它的出处轮照常出现在其他原话里，带对应记忆', async () => {
    const { deps } = await setup([memory()], { source: 'both', quotes: false })
    const { result } = await run(deps)
    expect(result.hits[0]!.quote).toBeUndefined()
    expect(result.dialogueText).toContain('对应记忆：写锁时机')
    expect(result.dialogueText).toContain('用户：写锁要在提交前拿')
  })

  it('两者、带原话：出处轮附在记忆下面，其他原话里不再出现', async () => {
    const { deps } = await setup([memory()], { source: 'both', quotes: true })
    const { result, text } = await run(deps)
    expect(result.hits[0]!.quote).toContain('用户：写锁要在提交前拿')
    expect(result.dialogueText).not.toContain('写锁要在提交前拿')
    expect(occurrences(text, '写锁要在提交前拿')).toBe(1)
    expect(result.dialogueText).not.toContain('对应记忆')
  })
})

describe('默认设置', () => {
  it('配置文件没写这两个键：检索来源是两者、记忆带原话开', () => {
    const config = new Config({} as never)
    expect(config.search.source.get()).toBe('both')
    expect(config.search.memoryQuotes.get()).toBe(true)
  })

  it('记忆段和升级前一致：条目、顺序、说明都不变，只多出附在后面的原话', async () => {
    const records = [
      anchored('a', [10, 12], { id: 'mem_a', name: '写锁时机', content: '写锁在提交前拿' }),
      anchored('b', [10, 12], { id: 'mem_b', name: '写锁日志', content: '写锁要打日志' }),
    ]
    const config = new Config({} as never)
    const { deps: built } = await setup(records)
    const deps = { ...built, searchSource: () => config.search.source.get(), memoryQuotes: () => config.search.memoryQuotes.get() }
    const baseline = await memoryOnly(deps)
    const { result, text } = await run(deps)
    expect(result.hits.map(({ quote: _quote, ...hit }) => hit)).toEqual(baseline.hits)
    expect([result.note, result.moreNote]).toEqual([baseline.note, baseline.moreNote])
    expect(result.hits.every(h => h.quote?.includes(DIALOGUE_QUOTE_TAG))).toBe(true)
    expect(text.startsWith(`${MEMORY_SECTION_HEADING}\n`)).toBe(true)
    expect(text.indexOf(MEMORY_SECTION_HEADING)).toBeLessThan(text.indexOf(DIALOGUE_SECTION_HEADING))
  })
})

describe('每次检索前的追库', () => {
  it('开着的会话这次没有新事件：不写库、不动待建队列', async () => {
    const { deps, host } = await setup([])
    host.listSessions.mockResolvedValue(['a', 'b', 'c'].map(id => ({ id, cwd: '/proj', isSubagent: false, isLive: id === 'a' })))
    await run(deps)
    const commits = vi.spyOn(db, 'commitBatch'); const dequeues = vi.spyOn(db, 'dequeue')
    host.readSessionLog.mockClear()
    await run(deps)
    expect(host.readSessionLog.mock.calls.map(c => c[0])).toContain('a')
    expect(commits).not.toHaveBeenCalled()
    expect(dequeues).not.toHaveBeenCalled()
  })

  it('这次要对账时，对账和原话放行共用同一次会话清单', async () => {
    const { deps, host } = await setup([anchored('a', [10, 12], { id: 'mem_a', name: '写锁时机', content: '写锁在提交前拿' })])
    const { result } = await run(deps)
    expect(host.listSessions).toHaveBeenCalledTimes(1)
    expect(result.hits[0]!.quote).toContain('写锁要在提交前拿')
    expect(result.dialogueText).toContain('写锁超时设三十秒')
  })
})

describe('去重', () => {
  it('同一轮既是记忆的出处、又被原话直接命中：只出现一次，挂在那条记忆下面', async () => {
    const { deps } = await setup([anchored('a', [40, 42], { id: 'mem_t', name: '写锁超时', content: '写锁超时' })])
    const { result, text } = await run(deps)
    expect(result.hits[0]!.quote).toContain('助手：写锁超时设三十秒')
    expect(occurrences(text, '写锁超时设三十秒')).toBe(1)
    expect(occurrences(text, '写锁的超时设多少')).toBe(1)
  })

  it('已附在记忆下面的一轮被原话检索命中另一段：并到那条记忆下面、按原文顺序，同一段不重复', async () => {
    const { deps } = await setup([anchored('a', [20, 22], { id: 'mem_l', name: '写锁讲解', content: '写锁 提交前' })])
    const { result, text } = await run(deps)
    const quote = result.hits[0]!.quote!
    expect(quote).toContain('丙段写锁 提交前')
    expect(quote).toContain('甲段写锁')
    expect(quote.indexOf('甲段写锁')).toBeLessThan(quote.indexOf('丙段写锁'))
    expect(result.dialogueText).not.toContain('段写锁')
    for (const part of ['甲段写锁', '丙段写锁', '讲讲写锁']) expect(occurrences(text, part)).toBe(1)
  })

  it('带原话关着：原话检索命中的段照常给，包括某条记忆的出处轮', async () => {
    const { deps } = await setup([anchored('a', [20, 22], { id: 'mem_l', name: '写锁讲解', content: '写锁 提交前' })], { quotes: false })
    const { result } = await run(deps)
    expect(result.hits[0]!.quote).toBeUndefined()
    expect(result.dialogueText).toContain('对应记忆：写锁讲解')
    expect(result.dialogueText).toContain('甲段写锁')
  })

  it('对应记忆的名称折成一行；名称里有密钥只写 id', async () => {
    const secret = 'sk-abcdefghijklmnopqrstuvwx1234'
    const records = [
      anchored('a', [10, 12], { id: 'mem_s', name: `写锁 ${secret}`, content: '写锁在提交前拿' }),
      anchored('a', [40, 42], { id: 'mem_n', name: '写锁\n## 超时', content: '写锁超时' }),
    ]
    const { deps } = await setup(records, { quotes: false })
    const dialogue = (await run(deps)).result.dialogueText!
    expect(dialogue).toContain('对应记忆：mem_s\n')
    expect(dialogue).toContain('对应记忆：写锁 ## 超时\n')
    expect(dialogue).not.toContain(secret)
  })

  it('排在带原话名额之外的记忆，出处轮被原话直接命中：出现在其他原话里、带对应记忆、排在前面', async () => {
    const records = [
      anchored('big', [10, 12], { id: 'mem_1', name: '写锁一', content: '写锁 日志 一' }),
      anchored('big', [20, 22], { id: 'mem_2', name: '写锁二', content: '写锁 日志 二' }),
      anchored('big', [30, 32], { id: 'mem_3', name: '写锁三', content: '写锁 日志 三' }),
      anchored('c', [10, 12], { id: 'mem_4', name: '收尾', content: '收尾时看写锁' }),
    ]
    const { deps } = await setup(records, { sessions: ['big', 'b', 'c'], budget: 3000 })
    // 只查原话时 b 排在 c 前面
    const dialogueOnly = (await run({ ...deps, searchSource: () => 'dialogue' }, '写锁 日志')).text
    expect(dialogueOnly.indexOf('写锁 日志 写锁 日志')).toBeLessThan(dialogueOnly.indexOf('收尾时写锁和日志一起看'))
    const { result } = await run(deps, '写锁 日志')
    expect(result.hits.map(h => h.id)).toEqual(['mem_1', 'mem_2', 'mem_3', 'mem_4'])
    expect(result.hits[3]!.quote).toBeUndefined()
    const dialogue = result.dialogueText!
    expect(dialogue).toContain('对应记忆：收尾\n')
    expect(dialogue.indexOf('收尾时写锁和日志一起看')).toBeLessThan(dialogue.indexOf('写锁 日志 写锁 日志'))
  })

  it('多条记忆锚着同一轮：原话只出现一次，其余写出处同', async () => {
    const records = [
      anchored('a', [10, 12], { id: 'mem_a', name: '写锁时机', content: '写锁 提交前拿' }),
      anchored('a', [10, 12], { id: 'mem_b', name: '写锁', content: '写锁' }),
    ]
    const { deps } = await setup(records)
    const { result, text } = await run(deps, '写锁 提交前')
    expect(result.hits.map(h => h.id)).toEqual(['mem_a', 'mem_b'])
    expect(result.hits[1]!.quote).toBe('出处同「写锁时机」')
    expect(occurrences(text, '写锁要在提交前拿')).toBe(1)
  })

  it('检索中途关掉带原话：这次照开始时的设置给，命中的轮不丢，下次检索才生效', async () => {
    let quotes = true
    const { deps, host } = await setup([anchored('a', [10, 12], { id: 'mem_a', name: '写锁时机', content: '写锁在提交前拿' })])
    host.sessionTitleOf.mockImplementation(async (id: string) => { quotes = false; return `会话${id}` })
    const flipping = { ...deps, memoryQuotes: () => quotes }
    const first = await run(flipping)
    expect(first.result.hits[0]!.quote).toContain('写锁要在提交前拿')
    expect(occurrences(first.text, '写锁要在提交前拿')).toBe(1)
    const second = await run(flipping)
    expect(second.result.hits[0]!.quote).toBeUndefined()
    expect(occurrences(second.text, '写锁要在提交前拿')).toBe(1)
  })

  it('原话命中的轮全都附在记忆下面：其他原话这段不出排序提示和逐词计数', async () => {
    const { deps } = await setup([anchored('se', [10, 12], { id: 'mem_e', name: '写锁事务', content: '写锁 事务 要先拿' })], { sessions: ['se'] })
    const { result } = await run(deps, '写锁 事务')
    expect(result.hits[0]!.quote).toContain('用户：写锁要拿')
    expect(result.dialogueText).not.toContain('以下按相关性排序')
    expect(result.dialogueText).not.toContain('原话段数')
  })

  it('会话最相关的一轮已附在记忆下面：这个会话在其他原话里仍有首轮名额', async () => {
    const { deps } = await setup([anchored('sa', [10, 12], { id: 'mem_a', name: '写锁要拿', content: '写锁要先拿' })], { sessions: ['sa', 'sb'], budget: 600 })
    const { result } = await run(deps)
    expect(result.hits[0]!.quote).toContain('用户：写锁要拿')
    expect(result.dialogueText).toContain('辛辛辛')
  })

  it('会话之间的先后只看在其他原话里输出的轮，不看已附在记忆下面的那轮', async () => {
    const { deps } = await setup([anchored('sa', [10, 12], { id: 'mem_a', name: '写锁要拿', content: '写锁要先拿' })], { sessions: ['sa', 'sb'], budget: 3000 })
    const dialogue = (await run(deps)).result.dialogueText!
    expect(dialogue).toContain('辛辛辛')
    expect(dialogue.indexOf('壬壬壬')).toBeLessThan(dialogue.indexOf('辛辛辛'))
  })

  it.each([true, false])('一轮同时是邻居和命中、又是某条记忆的出处（带原话 %s）：只输出一次', async quotes => {
    // 第 30 轮被命中，它的前后轮 20、40 也都命中；第 40 轮是记忆的出处
    const { deps } = await setup([anchored('a', [40, 42], { id: 'mem_t', name: '写锁超时', content: '写锁超时' })], { quotes, budget: 3000 })
    const { text } = await run(deps)
    expect(occurrences(text, '写锁超时设三十秒')).toBe(1)
    expect(occurrences(text, '读锁照写锁的办法')).toBe(1)
  })
})

describe('记忆这一路', () => {
  it('锚跨几轮时记到和记忆正文最相关的那一轮，和带原话挑的是同一轮', async () => {
    const memory = anchored('a', [10, 42], { id: 'mem_t', name: '写锁超时', content: '写锁的超时设三十秒' })
    const { deps } = await setup([memory], { quotes: false, budget: 3000 })
    const dialogue = (await run(deps)).result.dialogueText!
    expect(dialogue).toMatch(/对应记忆：写锁超时\n[^\n]*写锁的超时设多少/)
    expect(dialogue).not.toMatch(/对应记忆：写锁超时\n[^\n]*写锁要在提交前拿/)
    const quoted = (await run({ ...deps, memoryQuotes: () => true })).result.hits[0]!.quote!
    expect(quoted).toContain('写锁的超时设多少')
  })

  it('出处会话这次不能读（标了不回看、还没对账）：记忆这一路不去库里读它，也不拿它排名', async () => {
    const { deps } = await setup([anchored('a', [10, 12], { id: 'mem_a', name: '写锁时机', content: '写锁在提交前拿' })], { quotes: false })
    // 先检索一次进入稳态：下次对账还没到，库里的会话状态是旧的
    await run(deps)
    await (deps.dialogue!.noReview as NoReviewList).mark('a', 1000)
    const turnsOf = vi.spyOn(db, 'turnsOf'); const segmentsOf = vi.spyOn(db, 'segmentsOf')
    const { result } = await run(deps)
    expect(turnsOf.mock.calls.filter(([, id]) => id === 'a')).toEqual([])
    expect(segmentsOf.mock.calls.filter(([, id]) => id === 'a')).toEqual([])
    expect(result.dialogueText).not.toContain('对应记忆')
  })
})

describe('两份预算', () => {
  const records = () => [
    anchored('big', [10, 12], { id: 'mem_1', name: '写锁一', content: '写锁 第一条' }),
    anchored('big', [20, 22], { id: 'mem_2', name: '写锁二', content: '写锁 第二条' }),
    anchored('big', [30, 32], { id: 'mem_3', name: '写锁三', content: '写锁 第三条' }),
  ]

  it.each([[undefined, DIALOGUE_BUDGET_DEFAULT], [600, 600]] as const)('上限 %s：记忆带出的不超过 1000，原话检索命中的不超过上限，合计不超过 2500', async (configured, limit) => {
    const { deps } = await setup(records(), { sessions: ['big', 'many'], ...(configured === undefined ? {} : { budget: configured }) })
    // 真的超限：三条记忆要附的原话超过 1000，八轮命中超过上限
    expect(3 * (estimateTokens(`写锁${'甲'.repeat(450)}`) + estimateTokens(`写锁${'乙'.repeat(200)}`))).toBeGreaterThan(MEMORY_QUOTE_BUDGET_TOKENS)
    expect(8 * estimateTokens(`写锁${'丙'.repeat(450)}`)).toBeGreaterThan(limit)
    const { result } = await run(deps)
    const quoted = tokensOf(result.hits.flatMap(h => bodiesOf(h.quote)))
    const dialogue = tokensOf(bodiesOf(result.dialogueText))
    expect(quoted).toBeGreaterThan(0); expect(dialogue).toBeGreaterThan(0)
    expect(quoted).toBeLessThanOrEqual(MEMORY_QUOTE_BUDGET_TOKENS)
    expect(dialogue).toBeLessThanOrEqual(limit)
    expect(quoted + dialogue).toBeLessThanOrEqual(2500)
    expect(result.dialogueText).toContain('轮完全没放进来')
  })

  it('并到记忆下面的命中段记在其他原话那份里', async () => {
    const { deps } = await setup([anchored('a', [20, 22], { id: 'mem_l', name: '写锁讲解', content: '写锁 提交前' })], { sessions: ['a', 'many'], budget: 600 })
    const { result } = await run(deps)
    const quoteBodies = bodiesOf(result.hits[0]!.quote)
    const merged = quoteBodies.filter(body => body.startsWith('甲段') || body.startsWith('乙段'))
    expect(merged.length).toBeGreaterThan(0)
    expect(tokensOf(merged) + tokensOf(bodiesOf(result.dialogueText))).toBeLessThanOrEqual(600)
    expect(tokensOf(quoteBodies.filter(body => !merged.includes(body)))).toBeLessThanOrEqual(MEMORY_QUOTE_BUDGET_TOKENS)
  })
})

describe('装填顺序', () => {
  it('两者：记忆印证、只含部分关键词的一轮按融合名次装进预算，排在只有原话命中的轮前面', async () => {
    const records = [
      anchored('q', [10, 11], { id: 'mem_top', name: '写锁事务起点', content: '写锁 事务 起点' }),
      anchored('q', [40, 41], { id: 'mem_bridge', name: '写锁事务桥', content: '写锁 桥' }),
    ]
    const { deps } = await setup(records, { sessions: ['q'], quotes: false, budget: 600 })
    const dialogue = (await run(deps, '写锁 事务')).result.dialogueText!
    expect(dialogue).toContain('己己己')
    expect(dialogue).not.toContain('戊戊戊')
  })

  it('只查原话：其余命中先比档位再比段分数，同一轮的弱段不抢别轮强段的预算', async () => {
    const { deps } = await setup([], { sessions: ['r'], source: 'dialogue', budget: 600 })
    const dialogue = (await run(deps, '写锁 事务')).result.dialogueText!
    expect(dialogue).toContain('子子子')
    expect(dialogue).toContain('寅寅寅')
    expect(dialogue).not.toContain('丑丑丑')
  })
})

describe('和记忆正文相同的原话段', () => {
  it('在其他原话里写成从略，按输出的长度记账：不挤掉后面真正命中的轮', async () => {
    const { deps } = await setup([anchored('sc', [10, 11], { id: 'mem_c', name: '长写锁', content: SAME_AS_NOTE_TEXT })], { sessions: ['sc'], quotes: false, budget: 600 })
    const dialogue = (await run(deps)).result.dialogueText!
    expect(dialogue).toContain(SAME_AS_MEMORY_NOTE)
    expect(dialogue).toContain('辰辰辰'); expect(dialogue).toContain('巳巳巳')
    expect(dialogue).not.toContain('轮完全没放进来')
  })

  it('这次记忆条目只给了节选：不拿它判从略，节选外的尾句至少出现一处', async () => {
    // 前五条全文合计超过全文预算，第六条只含一个关键词、排在最后，只给节选
    const full = [1, 2, 3, 4, 5].map(n => record({ id: `mem_${n}`, scope: 'workspace', workspacePath: '/proj', name: `长记忆${n}`, content: `写锁 事务 ${'午'.repeat(1700)}` }))
    const { deps } = await setup([...full, anchored('sd', [10, 11], { id: 'mem_6', name: '尾句', content: EXCERPTED_TEXT })], { sessions: ['sd'] })
    const { result, text } = await run(deps, '写锁 事务')
    expect(result.hits.map(h => h.id).at(-1)).toBe('mem_6')
    expect(result.hits.at(-1)!.isExcerpt).toBe(true)
    expect(text).toContain('关键尾句')
  })
})

describe('检索途中重建切代', () => {
  /** 按新的切段规则重建会话 a：第 22 条的第一段从中间切开、后面的段号顺延，原文拼回来不变；建好就切过去，旧的一代删掉。 */
  function rebuildSplitting(tokenizer: DialogueTokenizer) {
    const before = db.state()
    if (before.status === 'none') throw new Error('应当已有库')
    const { dictionary } = before.write
    const old = db.segmentsOf(before.read.gen, 'a', 21, 22)
    const next = db.prepare({ ...before.write.versions, segmentRule: before.write.versions.segmentRule + 1 }, dictionary, '/sessions')
    if (next.status === 'none') throw new Error('应当开了新的一代')
    const gen = next.write.gen
    const session = db.startSession(gen, 'a', { cwd: '/proj', isSubagent: false })!
    const segments = old.flatMap(({ turnSeq, seq, segment, at: time, speaker, text }) => {
      const parts = seq === 22 && segment === 0 ? [text.slice(0, 100), text.slice(100)] : [text]
      return parts.map((part, i) => ({
        turnSeq, seq, segment: seq !== 22 ? segment : segment === 0 ? i : segment + 1, ...(time === undefined ? {} : { at: time }), speaker, text: part,
        ...tokenizer.columns(part),
      }))
    })
    expect(segments.map(s => s.text).join('')).toBe(old.map(s => s.text).join(''))
    expect(db.commitBatch({ gen, sessionId: 'a', revision: session.revision, dictionary, fromWatermark: -1, watermark: 22, turns: [{ turnSeq: 20, at: at(20) }], segments })).toBe(true)
    expect(db.completeBuild(gen)).toBe(true)
    return { from: before.read.gen, to: gen }
  }

  it('原话命中取完、附原话之前新的一代建好切了过去：这次不附记忆原话、说明一次，同一段原文最多出现一次', async () => {
    const { deps } = await setup([anchored('a', [20, 22], { id: 'mem_l', name: '写锁讲解', content: '写锁 提交前' })], { sessions: ['a'] })
    const dialogue = deps.dialogue!
    const load = dialogue.tokenizer
    let calls = 0
    let switched: { from: number; to: number } | undefined
    // 第一次取分词器是原话检索，第二次是附原话：在两者之间重建、切代
    dialogue.tokenizer = async () => {
      const tokenizer = await load()
      if (++calls === 2) switched = rebuildSplitting(tokenizer)
      return tokenizer
    }
    const { result, text } = await run(deps)
    expect(switched).toBeDefined()
    expect(switched!.to).not.toBe(switched!.from)
    expect(result.hits[0]!.quote).toBeUndefined()
    expect(result.quoteNote).toBe(memoryQuoteStatus(QUOTE_PENDING))
    expect(occurrences(text, memoryQuoteStatus(QUOTE_PENDING))).toBe(1)
    for (const part of ['讲讲写锁', '甲段写锁', '乙段', '丙段写锁 提交前']) expect(occurrences(text, part)).toBeLessThanOrEqual(1)
  })
})

describe('原话这一路用不了', () => {
  it('对话记录库打不开：退回只查记忆，记忆段和不开这些功能时逐字一致，说明一次', async () => {
    const { deps } = await setup([anchored('a', [10, 12], { id: 'mem_a', name: '写锁时机', content: '写锁在提交前拿' })], { isBroken: true })
    const baseline = renderSearchResult(await memoryOnly(deps))
    const { text } = await run(deps)
    expect(text).toBe(`${MEMORY_SECTION_HEADING}\n${baseline}\n\n${DIALOGUE_SECTION_HEADING}\n${dialogueNote('dialogue-unavailable')}`)
  })

  it('原话这一路取段时出故障：同样退回只查记忆，说明一次', async () => {
    const { deps } = await setup([anchored('a', [10, 12], { id: 'mem_a', name: '写锁时机', content: '写锁在提交前拿' })])
    const baseline = renderSearchResult(await memoryOnly(deps))
    vi.spyOn(db, 'turnsOf').mockImplementation(() => { throw new Error('disk') })
    const { text } = await run(deps)
    expect(text).toBe(`${MEMORY_SECTION_HEADING}\n${baseline}\n\n${DIALOGUE_SECTION_HEADING}\n${dialogueNote('dialogue-unavailable')}`)
  })
})
