import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { DialogueRecordStore } from '../src/storage/dialogue-records.ts'
import { dialogueTokenizer } from '../src/search/dialogue-tokenizer.ts'
import { DialogueCatchup } from '../src/tools/dialogue-catchup.ts'
import { executeSearch, renderSearchResult, type SearchToolDeps, type SearchContext } from '../src/tools/search.ts'
import { NoReviewList } from '../src/storage/no-review.ts'
import { MemoryStore } from '../src/store.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'
import { createCordisHostSession } from '../src/cordis-host-session.ts'
import { ModelSelectionStore } from '../src/governance/background-llm.ts'
import type { MemoryRecord } from '../src/record-schema.ts'
import type { SessionLog } from '../src/session-log.ts'
import { DIALOGUE_NO_HIT, dialogueNote } from '../src/search/dialogue-format.ts'
import { EXPANSION_FAILED_NOTE, EXPANSION_MODEL_FALLBACK_NOTE, EXPANSION_MEMORIES_LEAD, EXPANSION_TIMEOUT_MS, type ExpansionDeps } from '../src/tools/query-expansion.ts'
import { InMemoryTable } from './helpers/in-memory-table.ts'
import { InMemoryBatchKvTable, InMemoryKvTable } from './helpers/in-memory-kv.ts'
import { event, user } from './helpers/source-host.ts'
import { fakeExec } from './helpers/exec.ts'
import { record } from './helpers/record.ts'

const LOG = { info() {}, warn() {}, error() {} }
const WEAK = '写锁 部署'
const EXPANDED = '限流 阈值 每秒五十次'
const logOf = (id: string, text: string): SessionLog => ({ header: { id, isSeeded: false }, inheritedEventCount: 0, events: [event(10, 'turn/start'), user(11, text)] })
type Reply = (req: GenerateOptions) => AsyncIterable<StreamChunk>
const textReply: Reply = async function* () {
  yield { type: 'text-delta', index: 0, text: '限流 阈值' }
  yield { type: 'finish', reason: { kind: 'stop' } }
}
const neverWait = () => new Promise<void>(() => {})
function gate() {
  let open!: () => void
  const promise = new Promise<void>(resolve => { open = resolve })
  return { promise, open }
}
/** 只推进微任务，用宿主返回与调用方恢复之间的窗口触发取消。 */
function afterMicrotasks(count: number, fn: () => void): void {
  queueMicrotask(() => { if (count === 0) fn(); else afterMicrotasks(count - 1, fn) })
}

let dir: string
let db: DialogueRecordStore
beforeEach(async () => {
  vi.useFakeTimers({ now: 1000 })
  dir = await mkdtemp(join(tmpdir(), 'query-expansion-review-'))
  db = new DialogueRecordStore({ path: join(dir, 'db'), log: LOG })
})
afterEach(async () => { vi.restoreAllMocks(); vi.useRealTimers(); db.close(); await rm(dir, { recursive: true, force: true }) })

async function setup(opts: { source?: 'both' | 'dialogue'; fallback?: boolean; large?: boolean; budget?: number; records?: MemoryRecord[]; reply?: Reply; wait?: ExpansionDeps['wait'] } = {}) {
  const tokenizer = await dialogueTokenizer({ log: LOG })
  const all = Object.fromEntries(Object.entries({
    a: '写锁', b: '部署', d: EXPANDED, ...(opts.large ? { y: '限流 阈值', z: '限流 阈值 每秒' } : {}), cur: '帮我找上次的约定',
  }).map(([id, text]) => [id, logOf(id, text + (opts.large && id !== 'cur' ? '甲'.repeat(400) : ''))]))
  const context: SearchContext = { workspacePath: '/proj', session: { id: 'cur', lastSeq: 11, turnStartSeq: 10 } }
  const host = {
    readSessionLog: vi.fn(async (id: string) => all[id] ?? null),
    sessionTitleOf: vi.fn(async (id: string) => `会话${id}`),
    listSessions: async () => Object.keys(all).map(id => ({ id, cwd: '/proj', isSubagent: false, isLive: false })),
    contextOf: async () => context,
  }
  const noReview = new NoReviewList(dir)
  const workspaceOf = async (cwd: string | undefined) => cwd
  const catchup = new DialogueCatchup({ store: db, host, noReview, workspaceOf, tokenizer: async () => tokenizer, knownWorkspaces: async () => ['/proj'], isEnabled: () => true, sessionStore: '/sessions', log: LOG, now: () => 1000 })
  await catchup.advance(60_000)
  const table = new InMemoryTable('/in-memory', () => 1000)
  const store = new MemoryStore(table, undefined, new InMemoryBatchKvTable())
  for (const r of opts.records ?? []) await store.put(r)
  const calls: GenerateOptions[] = []
  const service = {
    listProviders: () => [{ id: 'p1', name: 'P1' }],
    listModels: async () => [{ id: 'm1', name: 'M1' }],
    resolveModelInfo: async () => ({}),
    stream: (req: GenerateOptions) => { calls.push(req); return (opts.reply ?? textReply)(req) },
  }
  const cordis = createCordisHostSession({ lookup: name => name === 'llm' ? service : undefined, logger: LOG, resolveCwd: async cwd => cwd })
  const selections = new ModelSelectionStore(new InMemoryKvTable())
  if (opts.fallback) await selections.set('expansion', { provider: 'p1', model: 'gone' })
  const expansion: ExpansionDeps = { isEnabled: () => true, host: { llmOf: cordis.llmOf, llmForRoute: cordis.llmForRoute, modelCatalog: cordis.modelCatalog, readSessionLog: host.readSessionLog }, selections, wait: opts.wait ?? neverWait }
  const deps: SearchToolDeps = {
    store, registry: buildTypeRegistry({ template: 'coding', customTypes: {} }), host, now: () => 1000, searchSource: () => opts.source ?? 'both',
    dialogue: { store: db, catchup, host, noReview, workspaceOf, hasBackgroundTimer: () => true, tokenizer: async () => tokenizer, ...(opts.budget === undefined ? {} : { budget: () => opts.budget! }) }, expansion,
  }
  host.readSessionLog.mockClear()
  return { deps, expansion, host, calls, table, selections }
}
const exec = (signal?: AbortSignal) => fakeExec({ agent: { session: { header: { id: 'cur' }, requestHeader: () => ({ config: { provider: 'p1', model: 'm1' } }) }, options: {} } as never, ...(signal ? { signal } : {}) })
const run = (deps: SearchToolDeps, query = WEAK, signal?: AbortSignal) => executeSearch({ query }, exec(signal), deps)
const withoutFallback = (text: string) => text.split('\n').filter(line => line !== EXPANSION_MODEL_FALLBACK_NOTE).join('\n')
const omitted = (text: string) => Number(/还有 (\d+) 轮完全没放进来/.exec(text)?.[1] ?? 0)
const bridgeRecord = () => record({ id: 'mem_bridge', name: '写锁 部署', content: '写锁的记忆', scope: 'workspace', workspacePath: '/proj', source: { sessionId: 'a', eventRange: [10, 11], sourceMode: 'user-explicit' } })

describe('扩查的说明、取消与语义桥边界', () => {
  it('回退主模型且扩查补到原话时移除第一轮的零命中说明', async () => {
    const { deps, calls } = await setup({ fallback: true })
    expect(renderSearchResult(await run({ ...deps, expansion: undefined }, '令牌桶'))).toContain(DIALOGUE_NO_HIT)
    const text = renderSearchResult(await run(deps, '令牌桶'))
    expect(calls).toHaveLength(1)
    expect(text).toContain(EXPANDED)
    expect(text).toContain(EXPANSION_MODEL_FALLBACK_NOTE)
    expect(text).not.toContain(DIALOGUE_NO_HIT)
  })

  it('回退主模型且扩查改变省略轮数时保留新的说明并在末尾追加回退说明', async () => {
    const { deps, selections } = await setup({ large: true, budget: 300 })
    const first = renderSearchResult(await run({ ...deps, expansion: undefined }))
    const normal = renderSearchResult(await run(deps))
    expect(omitted(normal)).toBeGreaterThan(omitted(first))
    await selections.set('expansion', { provider: 'p1', model: 'gone' })
    const text = renderSearchResult(await run(deps))
    expect(withoutFallback(text)).toBe(normal)
    expect(text.indexOf(EXPANSION_MODEL_FALLBACK_NOTE)).toBeGreaterThan(text.indexOf('轮完全没放进来'))
  })

  it('超时前宿主已经报出用量时失败结果仍带实际用量', async () => {
    const timeout = gate()
    const reply: Reply = async function* (req) {
      yield { type: 'usage', usage: { inputTokens: 800, outputTokens: 0 } }
      const aborted = new Promise<never>((_, reject) => req.signal!.addEventListener('abort', () => reject(req.signal!.reason), { once: true }))
      timeout.open()
      await aborted
    }
    const { deps } = await setup({ reply, wait: () => timeout.promise })
    const result = await run(deps)
    expect(renderSearchResult(result)).toContain(EXPANSION_FAILED_NOTE)
    expect(result.usageTokens).toBe(800)
  })

  it('模型选择完成与恢复执行之间取消时不再读日志或调用模型', async () => {
    const abort = new AbortController()
    const { deps, expansion, calls, host } = await setup()
    const llmOf = expansion.host.llmOf
    expansion.host.llmOf = context => {
      const llm = llmOf(context)
      host.readSessionLog.mockClear()
      afterMicrotasks(0, () => abort.abort(new DOMException('取消', 'AbortError')))
      return llm
    }
    host.readSessionLog.mockImplementation(async id => {
      return logOf(id, '当前问题')
    })
    await expect(run(deps, WEAK, abort.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(host.readSessionLog).not.toHaveBeenCalled()
    expect(calls).toHaveLength(0)
  })

  it('模型完成与恢复执行之间取消时不再碰库或读取标题', async () => {
    const violations: string[] = []
    // 覆盖宿主流收尾的微任务窗口，不替换模型适配器或检索模块。
    for (let ticks = 0; ticks <= 6; ticks++) {
      const abort = new AbortController()
      const cancelled = gate()
      const reply: Reply = () => ({
        [Symbol.asyncIterator]() {
          let sent = false
          return { next: () => {
            if (!sent) { sent = true; return Promise.resolve({ done: false as const, value: { type: 'text-delta' as const, index: 0, text: '限流 阈值' } }) }
            afterMicrotasks(ticks, () => { abort.abort(new DOMException('取消', 'AbortError')); cancelled.open() })
            return Promise.resolve({ done: true as const, value: undefined })
          } }
        },
      })
      const { deps, host, calls } = await setup({ reply })
      const prepare = DatabaseSync.prototype.prepare
      const spy = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (this: DatabaseSync, sql: string) {
        if (abort.signal.aborted) violations.push(`微任务 ${ticks}：${sql}`)
        return prepare.call(this, sql)
      })
      host.sessionTitleOf.mockImplementation(async id => {
        if (abort.signal.aborted) violations.push(`标题 ${id}`)
        if (calls.length > 0) await cancelled.promise
        return id
      })
      await expect(run(deps, WEAK, abort.signal)).rejects.toMatchObject({ name: 'AbortError' })
      spy.mockRestore()
    }
    expect(violations).toEqual([])
  })

  it('只查原话时语义桥投影抛错仍返回原话并照常扩查', async () => {
    const { deps, table, calls } = await setup({ source: 'dialogue', records: [bridgeRecord()] })
    let bridgeReading = false
    const readScope = table.readScope.bind(table)
    table.readScope = async (...args) => { bridgeReading = true; return readScope(...args) }
    let failures = 0
    const prepare = DatabaseSync.prototype.prepare
    vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (this: DatabaseSync, sql: string) {
      if (bridgeReading && sql.includes('SELECT watermark, revision, is_removed FROM sessions')) {
        failures++
        throw Object.assign(new Error('database is busy'), { code: 'ERR_SQLITE_ERROR', errcode: 5 })
      }
      return prepare.call(this, sql)
    })
    const result = await run(deps)
    expect(failures).toBe(1)
    expect(result.onlyDialogue).toBe(true)
    expect(renderSearchResult(result)).toContain('用户：写锁')
    expect(renderSearchResult(result)).toContain(EXPANDED)
    expect(calls).toHaveLength(1)
    expect((calls[0]!.messages[0]!.content[0] as { text: string }).text).not.toContain(EXPANSION_MEMORIES_LEAD)
  })

  it('语义桥等待期间删库时返回原有不可用结果且不重建空库', async () => {
    const { deps, table, calls } = await setup({ source: 'dialogue', records: [bridgeRecord()] })
    const readScope = table.readScope.bind(table)
    let deleted = false
    table.readScope = async (...args) => {
      if (!deleted) { deleted = true; db.destroy(); expect(existsSync(join(dir, 'db'))).toBe(false) }
      return readScope(...args)
    }
    const result = await run(deps)
    expect(existsSync(join(dir, 'db'))).toBe(false)
    expect(result.pathNote).toBe(dialogueNote('dialogue-unavailable'))
    expect(result.dialogueText).toBeUndefined()
    expect(calls).toHaveLength(0)
  })

  it('模型返回后装填跨过时限时请求信号不取消且扩查结果保留', async () => {
    const { deps, calls, host } = await setup({ wait: (ms, signal) => new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms)
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason) }, { once: true })
    }) })
    let checked = false
    let abortedDuringFill: boolean | undefined
    host.sessionTitleOf.mockImplementation(async id => {
      if (calls.length > 0 && !checked) {
        checked = true
        await vi.advanceTimersByTimeAsync(EXPANSION_TIMEOUT_MS + 1)
        abortedDuringFill = calls[0]!.signal!.aborted
      }
      return id
    })
    const result = await run(deps)
    expect(checked).toBe(true)
    expect(abortedDuringFill).toBe(false)
    expect(renderSearchResult(result)).toContain(EXPANDED)
    expect(renderSearchResult(result)).not.toContain(EXPANSION_FAILED_NOTE)
    expect(calls[0]!.signal!.aborted).toBe(false)
  })

  it('扩查装填对同一消息只读一次段表', async () => {
    const { deps, calls } = await setup()
    const prepare = DatabaseSync.prototype.prepare
    const reads: unknown[][] = []
    vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (this: DatabaseSync, sql: string) {
      const statement = prepare.call(this, sql)
      if (calls.length > 0 && sql.includes('FROM segments WHERE gen = ? AND session_id = ? AND seq >= ? AND seq <= ?')) {
        const all = statement.all.bind(statement)
        statement.all = (...args) => { reads.push(args); return Reflect.apply(all, undefined, args) }
      }
      return statement
    })
    expect(renderSearchResult(await run(deps))).toContain(EXPANDED)
    const messageReads = reads.filter(args => args[2] === 11 && args[3] === 11)
    expect(messageReads.length).toBeGreaterThan(0)
    expect(messageReads.map(args => JSON.stringify(args))).toEqual([...new Set(messageReads.map(args => JSON.stringify(args)))])
  })
})
