import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as sqlite from 'node:sqlite'
import type { RawEvent, SessionLog } from '../src/session-log.ts'
import { dialogueTokenizer, type DialogueTokenizer } from '../src/search/dialogue-tokenizer.ts'
import { dialogueNote, MEMORY_QUOTES_UNAVAILABLE } from '../src/search/dialogue-format.ts'
import { DialogueRecordStore } from '../src/storage/dialogue-records.ts'
import type { SqliteModule } from '../src/storage/root-lock.ts'
import { DialogueCatchup } from '../src/tools/dialogue-catchup.ts'
import { executeSearch, renderSearchResult, type SearchContext, type SearchToolDeps } from '../src/tools/search.ts'
import type { HostSessionEntry } from '../src/tools/host-session.ts'
import { MemoryStore } from '../src/store.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'
import { InMemoryTable } from './helpers/in-memory-table.ts'
import { InMemoryBatchKvTable } from './helpers/in-memory-kv.ts'
import { fakeExec } from './helpers/exec.ts'
import { record } from './helpers/record.ts'

// 磁盘满时原话这一路的降级：库是真的（临时目录里的 node:sqlite），「盘满」在进程边界注入——
// 加载 node:sqlite 时换成一个打开后就把库封顶在当前大小的连接（PRAGMA max_page_count），之后要长大的写入都报 SQLITE_FULL。
// 记忆一路用内存表；对照组是同一份记忆、原话功能全关时的检索结果。

const PROJECT = '/proj'
const QUERY = '部署'

let dir: string
let opened: DialogueRecordStore[] = []
let tokenizer: DialogueTokenizer
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pm-dialogue-disk-full-'))
  tokenizer = await dialogueTokenizer({ log: { warn() {} } })
})
afterEach(async () => {
  for (const store of opened.splice(0)) store.close()
  await rm(dir, { recursive: true, force: true })
})

/** 打开后就封顶在当前大小的 node:sqlite：模拟磁盘满。 */
const fullDisk: SqliteModule = {
  DatabaseSync: class extends sqlite.DatabaseSync {
    constructor(path: string) {
      super(path)
      this.exec('PRAGMA max_page_count = 1')
    }
  },
} as unknown as SqliteModule

const event = (seq: number, type: string, data: unknown = {}): RawEvent => ({ seq, type, time: 1_000 + seq * 10, data })
const text = (value: string) => [{ type: 'text', text: value }]
/** n 轮对话；每句都带检索词和一大段填充，让每一批都要给库加页。 */
function logOf(id: string, n: number): SessionLog {
  const filler = '记下的排查过程很长'.repeat(60)
  const events = Array.from({ length: n }, (_, i) => [
    event(i * 4, 'turn/start'),
    event(i * 4 + 1, 'user/message', { role: 'user', content: text(`${id}第${i}轮：${QUERY}脚本放哪。${filler}`), source: { kind: 'user' } }),
    event(i * 4 + 2, 'assistant/message', { message: { role: 'assistant', content: text(`${id}第${i}轮回答：${QUERY}脚本在 scripts 下。${filler}`) } }),
    event(i * 4 + 3, 'turn/end'),
  ]).flat()
  return { header: { id, isSeeded: false }, inheritedEventCount: 0, events }
}

interface World {
  logs: Map<string, SessionLog>
  warnings: string[]
}

function world(): World {
  const logs = new Map<string, SessionLog>()
  logs.set('cur', logOf('cur', 3))
  logs.set('old', logOf('old', 3))
  return { logs, warnings: [] }
}

const storePath = (name = 'dialogue.sqlite') => join(dir, name)

/** 一套接好的检索依赖：原话这一路用 path 上的库，loadSqlite 决定是不是盘满。 */
function rig(w: World, opts: { path?: string; loadSqlite?: () => SqliteModule | undefined } = {}) {
  const log = { info() {}, warn: (m: string) => { w.warnings.push(m) }, error: (m: string) => { w.warnings.push(m) } }
  const store = new DialogueRecordStore({ path: opts.path ?? storePath(), log, ...(opts.loadSqlite ? { loadSqlite: opts.loadSqlite } : {}) })
  opened.push(store)
  const entries = (): HostSessionEntry[] => [...w.logs.keys()].map(id => ({ id, cwd: PROJECT, isSubagent: false, isLive: id === 'cur' }))
  const host = {
    readSessionLog: async (id: string) => w.logs.get(id) ?? null,
    listSessions: async () => entries(),
    sessionTitleOf: async () => undefined,
    contextOf: async (): Promise<SearchContext> => ({ workspacePath: PROJECT, session: { id: 'cur', lastSeq: 100 } }),
  }
  const noReview = { isMarkedNoReview: async () => false, sessionIds: async () => new Set<string>() }
  const workspaceOf = async (cwd: string | undefined) => cwd
  const catchup = new DialogueCatchup({
    store, host, noReview, workspaceOf, tokenizer: async () => tokenizer, knownWorkspaces: async () => [PROJECT],
    isEnabled: () => true, sessionStore: '/sessions', log, now: () => 1_000,
  })
  return { store, catchup, host, noReview, workspaceOf }
}

async function memories(): Promise<MemoryStore> {
  const store = new MemoryStore(new InMemoryTable(), undefined, new InMemoryBatchKvTable())
  await store.put(record({ id: 'mem_a', name: '部署脚本位置', content: `${QUERY}脚本放在 scripts/deploy 下面`, summary: `${QUERY}脚本`, scope: 'workspace', workspacePath: PROJECT }))
  await store.put(record({ id: 'mem_b', name: '部署前检查', content: `${QUERY}之前先跑一遍类型检查`, summary: `${QUERY}前检查`, scope: 'workspace', workspacePath: PROJECT }))
  return store
}

/** 对照组：同一份记忆，原话功能全关（只查记忆、不带原话、不接原话依赖）时的检索。 */
async function baseline() {
  const r = rig(world(), { path: storePath('unused.sqlite') })
  const deps: SearchToolDeps = { store: await memories(), registry: buildTypeRegistry({ template: 'coding', customTypes: {} }), host: r.host, now: () => 1_000, searchSource: () => 'memory', memoryQuotes: () => false }
  const result = await executeSearch({ query: QUERY }, fakeExec(), deps)
  return { result, text: renderSearchResult(result) }
}

async function depsOf(r: ReturnType<typeof rig>, opts: { source: 'memory' | 'both'; quotes: boolean }): Promise<SearchToolDeps> {
  return {
    store: await memories(), registry: buildTypeRegistry({ template: 'coding', customTypes: {} }), host: r.host, now: () => 1_000,
    searchSource: () => opts.source, memoryQuotes: () => opts.quotes,
    dialogue: { store: r.catchup.readStore, catchup: r.catchup, host: r.host, noReview: r.noReview, workspaceOf: r.workspaceOf, tokenizer: async () => tokenizer, hasBackgroundTimer: () => true },
  }
}

/** 先在没满的盘上把 old 收进库，再加几个新会话：之后在满盘上追它们，每一批都要加页。 */
async function partlyBuilt(w: World): Promise<void> {
  const first = rig(w)
  const ready = await first.catchup.advance(60_000)
  if (ready.kind !== 'ready' || ready.coverage.queued !== 0) throw new Error(`夹具：第一次建库没建完（${ready.kind}）`)
  first.store.close()
  for (const id of ['new1', 'new2', 'new3']) w.logs.set(id, logOf(id, 4))
  const cur = w.logs.get('cur')!
  w.logs.set('cur', { ...cur, events: [...cur.events, ...logOf('cur', 6).events.slice(cur.events.length)] })
}

const isDiskFullWarning = (m: string) => /disk is full/i.test(m)
/** 一个会话在库里的全部段，拼成可比的字符串。 */
function dump(store: DialogueRecordStore, sessionId: string): string[] {
  const state = store.state()
  if (state.status === 'none') throw new Error('库还没建')
  return store.segmentsOf(state.read.gen, sessionId, 0, Number.MAX_SAFE_INTEGER).map(s => `${s.turnSeq}/${s.seq}/${s.segment}/${s.speaker}/${s.text}`)
}

describe('建库途中磁盘满了', () => {
  it.each(['both', 'dialogue'] as const)('来源是 %s：原话这一路只说一次暂时查不了，记忆部分和原话功能全关时一样', async source => {
    const w = world()
    await partlyBuilt(w)
    const expected = await baseline()
    const full = rig(w, { loadSqlite: () => fullDisk })
    const result = await executeSearch({ query: QUERY, source }, fakeExec(), await depsOf(full, { source: 'both', quotes: false }))
    const text = renderSearchResult(result)
    // 前提：这一次确实去写了库，撞上的是盘满，不是别的原因让原话这一路没走
    expect(w.warnings.some(isDiskFullWarning)).toBe(true)
    expect(text.split(dialogueNote('dialogue-unavailable'))).toHaveLength(2)
    expect(result.hits).toEqual(expected.result.hits)
    expect(text).toContain(expected.text)
    expect(text).not.toContain('<past-dialogue>')
  })

  it('只查记忆、带原话开着：记忆照常返回，只说明一次原话这次没附', async () => {
    const w = world()
    await partlyBuilt(w)
    const expected = await baseline()
    const full = rig(w, { loadSqlite: () => fullDisk })
    const result = await executeSearch({ query: QUERY }, fakeExec(), await depsOf(full, { source: 'memory', quotes: true }))
    const text = renderSearchResult(result)
    expect(w.warnings.some(isDiskFullWarning)).toBe(true)
    expect(result.quoteNote).toBe(MEMORY_QUOTES_UNAVAILABLE)
    expect(text.split(MEMORY_QUOTES_UNAVAILABLE)).toHaveLength(2)
    expect(result.hits).toEqual(expected.result.hits)
    expect(text).toContain(expected.text)
  })

  it('盘满不当成坏库：库文件和已收的原话都留着，腾出空间后下一次检索接着追，追完和一次建完逐段相同', async () => {
    const w = world()
    await partlyBuilt(w)
    const full = rig(w, { loadSqlite: () => fullDisk })
    const readiness = await full.catchup.beforeSearch({ sessionId: 'cur', cwd: PROJECT, isSubagent: false }, 60_000, 60_000)
    expect(readiness.kind).toBe('unavailable')
    expect(w.warnings.some(isDiskFullWarning)).toBe(true)
    full.store.close()
    expect(existsSync(storePath())).toBe(true)

    // 腾出空间：同一个库文件、正常的 node:sqlite
    const freed = rig(w)
    expect(dump(freed.store, 'old').length).toBeGreaterThan(0)
    for (let i = 0; i < 10; i++) {
      const r = await freed.catchup.advance(60_000)
      if (r.kind === 'ready' && r.coverage.queued === 0) break
    }
    const text = renderSearchResult(await executeSearch({ query: 'new2第3轮', source: 'dialogue' }, fakeExec(), await depsOf(freed, { source: 'both', quotes: false })))
    expect(text).toContain('<past-dialogue>')
    expect(text).toContain('new2第3轮')

    const once = rig(w, { path: storePath('once.sqlite') })
    await once.catchup.advance(60_000)
    for (const id of w.logs.keys()) expect(dump(freed.store, id)).toEqual(dump(once.store, id))
  })

  it('一开始就盘满、库建不起来：退回只查记忆，说明只出现一次', async () => {
    const w = world()
    const expected = await baseline()
    const full = rig(w, { loadSqlite: () => fullDisk })
    const result = await executeSearch({ query: QUERY, source: 'both' }, fakeExec(), await depsOf(full, { source: 'both', quotes: false }))
    const text = renderSearchResult(result)
    expect(w.warnings.some(isDiskFullWarning)).toBe(true)
    expect(text.split(dialogueNote('dialogue-unavailable'))).toHaveLength(2)
    expect(result.hits).toEqual(expected.result.hits)
    expect(text).toContain(expected.text)
  })
})
