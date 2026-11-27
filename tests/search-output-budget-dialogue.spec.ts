import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DialogueRecordStore } from '../src/storage/dialogue-records.ts'
import { dialogueTokenizer } from '../src/search/dialogue-tokenizer.ts'
import { DialogueCatchup } from '../src/tools/dialogue-catchup.ts'
import { executeSearch, renderSearchResult, IN_SNAPSHOT_NOTE, type SearchArgs, type SearchContext, type SearchHit, type SearchToolDeps } from '../src/tools/search.ts'
import { SnapshotCache } from '../src/runtime.ts'
import { NoReviewList } from '../src/storage/no-review.ts'
import { MemoryStore } from '../src/store.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'
import type { MemoryRecord, SourceAnchor } from '../src/record-schema.ts'
import type { RawEvent, SessionLog } from '../src/session-log.ts'
import { SAME_AS_MEMORY_NOTE } from '../src/search/dialogue-format.ts'
import { InMemoryTable } from './helpers/in-memory-table.ts'
import { InMemoryBatchKvTable } from './helpers/in-memory-kv.ts'
import { SOURCE_TIME, event, user } from './helpers/source-host.ts'
import { fakeExec } from './helpers/exec.ts'
import { record } from './helpers/record.ts'

// 记忆和原话一起检索时的输出预算：先省其他原话段，再动记忆命中；附原话的「从略」「出处同」按最终给出的内容判。

const LOG = { info() {}, warn() {}, error() {} }
const points = (text: string) => [...text].length
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
const SAME_TEXT = `写锁 ${'卯'.repeat(440)}`

function logs(): Record<string, SessionLog> {
  return {
    // 八轮各约 450 字的命中，都不是记忆的出处
    many: logOf('many', [10, 20, 30, 40, 50, 60, 70, 80].flatMap(n => [turn(n), user(n + 1, `写锁${'丙'.repeat(450)}`)])),
    // 第 10 轮是两条记忆共同的出处，约 900 字
    src: logOf('src', [turn(10), user(11, `写锁要在提交前拿${'丁'.repeat(900)}`)]),
    // 第 10 轮的提问和一条记忆的正文一字不差
    same: logOf('same', [turn(10), user(11, SAME_TEXT)]),
  }
}

let dir: string
let db: DialogueRecordStore
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'search-budget-dialogue-')); db = new DialogueRecordStore({ path: join(dir, 'db'), log: LOG }) })
afterEach(async () => { db.close(); await rm(dir, { recursive: true, force: true }) })

async function setup(records: MemoryRecord[], sessions: string[], opts: { threshold?: number; quotes?: boolean } = {}) {
  const tokenizer = await dialogueTokenizer({ log: { warn() {} } })
  const all = logs()
  const handle = {}
  const setting = { threshold: opts.threshold }
  const base = {
    readSessionLog: async (id: string) => all[id] ?? null,
    sessionTitleOf: async (id: string) => `会话${id}`,
    listSessions: async () => sessions.map(id => ({ id, cwd: '/proj', isSubagent: false, isLive: false })),
    contextOf: async (): Promise<SearchContext> => ({ workspacePath: '/proj', session: { id: 'cur', lastSeq: 0, handle } }),
  }
  const host = { ...base, toolResultPrunerOf: () => setting.threshold === undefined ? undefined : { config: { thresholdChars: setting.threshold } } }
  const noReview = new NoReviewList(dir)
  const workspaceOf = async (cwd: string | undefined) => cwd
  const catchup = new DialogueCatchup({
    store: db, host: base, noReview, workspaceOf, tokenizer: async () => tokenizer, knownWorkspaces: async () => ['/proj'],
    isEnabled: () => true, sessionStore: '/sessions', log: LOG, now: () => 1000,
  })
  await catchup.advance(60_000)
  const store = new MemoryStore(new InMemoryTable(), undefined, new InMemoryBatchKvTable())
  for (const r of records) await store.put(r)
  const registry = buildTypeRegistry({ template: 'coding', customTypes: {} })
  const cache = new SnapshotCache({ store, registry, budget: 100_000 })
  const deps: SearchToolDeps = {
    store, registry, host, now: () => 1000, sessionRecall: cache,
    searchSource: () => 'both', memoryQuotes: () => opts.quotes ?? true,
    dialogue: { store: db, catchup, host: base, noReview, workspaceOf, hasBackgroundTimer: () => true, tokenizer: async () => tokenizer },
  }
  const search = async (args: SearchArgs) => {
    const result = await executeSearch(args, fakeExec(), deps)
    return { result, text: renderSearchResult(result) }
  }
  const inject = async () => { cache.setWorkspacePath(handle, '/proj'); await cache.assemble(handle) }
  return { search, setting, inject }
}

type Shape = 'full' | 'excerpt' | 'note' | 'head'
const shapeOf = (h: SearchHit): Shape => h.isHeadOnly ? 'head' : h.content === IN_SNAPSHOT_NOTE ? 'note' : h.isExcerpt ? 'excerpt' : 'full'
/** 一个命中的形态加上有没有附原话。 */
const formsOf = (hits: readonly SearchHit[]) => hits.map(h => `${shapeOf(h)}${h.quote === undefined ? '' : '+quote'}`)
const dialogueRounds = (text: string | undefined) => (text?.match(/^(?:\[[^\]]+\] )?用户：/gm) ?? []).length

describe('记忆和原话一起检索', () => {
  it('其他原话段全部省完之前，记忆命中一条都没降级', async () => {
    const memories = [0, 1, 2].map(i => record({ id: `mem_w${i}`, scope: 'workspace', workspacePath: '/proj', name: `写锁${i}`, content: `写锁 ${'正'.repeat(1200)}`, lastConfirmedAt: 100 - i }))
    const { search, setting } = await setup(memories, ['many'], { quotes: false })
    const plain = await search({ query: '写锁' })
    expect(dialogueRounds(plain.result.dialogueText)).toBeGreaterThan(1)
    const outcomes = []
    for (const threshold of [8192, 6000, 5000, 4000, 3500, 3000]) {
      setting.threshold = threshold
      const { result, text } = await search({ query: '写锁' })
      expect(points(text)).toBeLessThanOrEqual(Math.max(3000, Math.floor(threshold * 0.95)))
      const isMemoryTouched = formsOf(result.hits).join() !== formsOf(plain.result.hits).join()
      const rounds = dialogueRounds(result.dialogueText)
      if (isMemoryTouched) expect(rounds).toBe(0)
      outcomes.push(isMemoryTouched ? 'memory' : rounds < dialogueRounds(plain.result.dialogueText) ? 'dialogue' : 'none')
    }
    // 这组阈值既走到了只省原话、也走到了动记忆
    expect(outcomes).toContain('dialogue')
    expect(outcomes).toContain('memory')
  })

  it('省掉的原话段：说明里写省了几段、原话不翻页、怎么取回', async () => {
    const memories = [record({ id: 'mem_w', scope: 'workspace', workspacePath: '/proj', name: '写锁', content: `写锁 ${'正'.repeat(1500)}` })]
    const { search } = await setup(memories, ['many'], { threshold: 3000, quotes: false })
    const { result, text } = await search({ query: '写锁' })
    expect(points(text)).toBeLessThanOrEqual(3000)
    expect(result.dialogueText).toMatch(/因输出长度另省掉 \d+ 段原话；原话不支持 offset 翻页，可以换更具体的关键词再搜，或用 memory_source 带上引用看某条消息。/)
  })

  it('offset > 0：这一页只翻记忆，不出其他原话，说明里写一句', async () => {
    const memories = [0, 1, 2].map(i => record({ id: `mem_w${i}`, scope: 'workspace', workspacePath: '/proj', name: `写锁${i}`, content: '写锁 短', lastConfirmedAt: 100 - i }))
    const { search } = await setup(memories, ['many'], { threshold: 8192 })
    const { result, text } = await search({ query: '写锁', limit: 1, offset: 1 })
    expect(result.hits.map(h => h.id)).toEqual(['mem_w1'])
    expect(result.dialogueText).toBeUndefined()
    expect(text).toContain('翻页只翻记忆条目，其他原话只在第一页给出。')
    expect(text).not.toContain('丙丙丙')
  })
})

describe('附原话和降级一致', () => {
  it('附原话省掉后：没有指向已省原话的「出处同」，有一句用 memory_source 回查的说明', async () => {
    const memories = [
      // 两条出处记忆短、同时含两个词，排在前面；十条撑长度的只含一个词、摘要长，排在后面，先被降级，只剩头行也放不下。
      // 出处记忆的正文要和出处轮逐段比对，写长了这一步很慢，所以写短
      anchored('src', [10, 11], { id: 'mem_a', name: '写锁时机', content: `写锁 提交前拿 ${'甲'.repeat(100)}`, lastConfirmedAt: 100 }),
      anchored('src', [10, 11], { id: 'mem_b', name: '写锁', content: `写锁 提交前 ${'乙'.repeat(100)}`, lastConfirmedAt: 99 }),
      ...Array.from({ length: 10 }, (_, i) => record({ id: `mem_p${i}`, scope: 'workspace', workspacePath: '/proj', name: `写锁${i}`, summary: `摘要${'摘'.repeat(150)}`, content: `写锁 ${'丙'.repeat(300)}`, lastConfirmedAt: 50 - i })),
    ]
    const { search, setting } = await setup(memories, ['src'])
    const plain = await search({ query: '写锁 提交前', limit: 12 })
    // 两条锚着同一轮：排在后面的那条写「出处同」指向前一条
    const [first, second] = plain.result.hits.filter(h => h.id === 'mem_a' || h.id === 'mem_b')
    const sameSource = `出处同「${first!.id === 'mem_a' ? '写锁时机' : '写锁'}」`
    expect(second!.quote).toBe(sameSource)
    expect(first!.quote).toContain('写锁要在提交前拿')
    setting.threshold = 3000
    const { result, text } = await search({ query: '写锁 提交前', limit: 12 })
    expect(points(text)).toBeLessThanOrEqual(3000)
    // 原文和出处同都省了；读不到出处这类状态说明留着
    expect(result.hits.every(h => h.quote === undefined || h.quote.startsWith('出处原话：'))).toBe(true)
    expect(text).not.toContain('出处同')
    expect(text).not.toContain('写锁要在提交前拿')
    // 两条都看不到出处那一轮了：写「出处同」的那条也算一条
    expect(text).toContain('2 条记忆附的出处原话已省略，可用 memory_source 传记忆 id 回查')
  })

  it('附原话省掉后又移到下一页的那条：省略计数只算本页留下的', async () => {
    const memories = [
      anchored('src', [10, 11], { id: 'mem_q0', name: '写锁时机', summary: `摘要${'甲'.repeat(1600)}`, content: '写锁 提交前拿', lastConfirmedAt: 100 }),
      anchored('src', [10, 11], { id: 'mem_q1', name: '写锁', summary: `摘要${'乙'.repeat(1600)}`, content: '写锁 提交前', lastConfirmedAt: 99 }),
    ]
    const { search } = await setup(memories, ['src'], { threshold: 3000 })
    const { result, text } = await search({ query: '写锁 提交前' })
    expect(result.hits).toHaveLength(1)
    expect(text).toContain('1 条移到下一页')
    expect(text).toContain('1 条记忆附的出处原话已省略，可用 memory_source 传记忆 id 回查')
  })

  it('原话段省完仍超、记忆一路没有可省的说明：不说「部分说明已省略」', async () => {
    // 三条都同时含两个词：记忆一路没有逐词命中计数；原话只含一个词，原话一路有逐词计数
    const memories = [0, 1, 2].map(i => record({ id: `mem_f${i}`, scope: 'workspace', workspacePath: '/proj', name: `写锁 提交前 ${i}`, content: `写锁 提交前 ${'正'.repeat(1000)}`, lastConfirmedAt: 100 - i }))
    const { search } = await setup(memories, ['many'], { threshold: 3000, quotes: false })
    const { result, text } = await search({ query: '写锁 提交前' })
    expect(result.catalog).toBeUndefined()
    expect(result.matchedTopics).toBeUndefined()
    expect(text).toMatch(/本次输出上限 3000 字：\d+ 条改为节选.*\d+ 段其他原话已省略/)
    expect(text).not.toContain('部分说明已省略')
  })

  it('已注入的记忆按关键词命中只给说明句：附原话里和它正文相同的一段给原文，不写从略', async () => {
    const core = anchored('same', [10, 11], { id: 'mem_core', type: 'preference', name: '长写锁', content: SAME_TEXT })
    const { search, inject } = await setup([core], ['same'], { threshold: 8192 })
    await inject()
    const { result, text } = await search({ query: '写锁' })
    expect(result.hits[0]!.content).toBe(IN_SNAPSHOT_NOTE)
    expect(text).not.toContain(SAME_AS_MEMORY_NOTE)
    expect(text).toContain('卯'.repeat(440))
  })

  it('同一条按 id 直达：全文照给，附原话里那段照旧从略', async () => {
    const core = anchored('same', [10, 11], { id: 'mem_core', type: 'preference', name: '长写锁', content: SAME_TEXT })
    const { search, inject } = await setup([core], ['same'], { threshold: 8192 })
    await inject()
    const { result, text } = await search({ query: 'mem_core' })
    expect(result.hits[0]!.content).toBe(SAME_TEXT)
    expect(text).toContain(SAME_AS_MEMORY_NOTE)
  })
})
