/** 每次任务独占进程，内存峰值不混入其他档；重建由父进程采样磁盘。 */
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { setImmediate as yieldLoop } from 'node:timers/promises'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { DialogueRecordStore } from '../src/storage/dialogue-records.ts'
import { DialogueCatchup, CATCHUP_BACKGROUND_BUDGET_MS, CATCHUP_FOCUS_BUDGET_MS } from '../src/tools/dialogue-catchup.ts'
import { dialogueTokenizer } from '../src/search/dialogue-tokenizer.ts'
import { searchDialogue } from '../src/tools/dialogue-search.ts'
import { executeSearch } from '../src/tools/search.ts'
import { FileTable } from '../src/storage/file-table.ts'
import { MemoryStore } from '../src/store.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'
import { InMemoryKvTable, InMemoryBatchKvTable } from '../tests/helpers/in-memory-kv.ts'
import { record } from '../tests/helpers/record.ts'
import { syntheticSessionLog, FOCUS_LIVE_SESSIONS, FOCUS_NEW_TURNS, FOREGROUND_INTERVAL_MS, BENCH_SKIPPED } from './bench-dialogue.ts'

interface Job { mode: string; root: string; logs: string; db: string; count: number; turns: number; rounds: number }
const log = { warn() {}, info() {}, error() {} }

class MeasuredStore extends DialogueRecordStore {
  commits = 0
  searches = 0
  superseded = 0
  measuring = false
  sessionStart: number | undefined
  sessionMax = 0
  tailStart = 0
  finishSession() {
    if (this.sessionStart !== undefined) this.sessionMax = Math.max(this.sessionMax, performance.now() - this.sessionStart)
    this.sessionStart = undefined
  }
  override startSession(...args: Parameters<DialogueRecordStore['startSession']>) {
    if (this.measuring) { this.finishSession(); this.sessionStart = performance.now() }
    return super.startSession(...args)
  }
  override commitBatch(...args: Parameters<DialogueRecordStore['commitBatch']>) {
    const result = super.commitBatch(...args)
    if (result) this.commits++
    else this.superseded++
    if (this.measuring) this.finishSession()
    return result
  }
  override coverage(...args: Parameters<DialogueRecordStore['coverage']>) {
    if (this.measuring) { this.finishSession(); this.tailStart = performance.now() }
    return super.coverage(...args)
  }
  override search(...args: Parameters<DialogueRecordStore['search']>) {
    this.searches++
    return super.search(...args)
  }
}

async function run(job: Job) {
  let item = '准备分词器'
  const db = new MeasuredStore({ path: job.db, log })
  try {
    let tokenizer = await dialogueTokenizer({ log })
    if (job.mode === 'rebuild' || job.mode === 'measure') tokenizer = { ...tokenizer, tokenizerVersion: tokenizer.tokenizerVersion + 1 }
    let readMs = 0, readMax = 0, reads = 0
    const live = job.mode === 'huge' ? 0 : Math.min(job.count, FOCUS_LIVE_SESSIONS)
    const context = { workspacePath: job.root, session: { id: 's0', lastSeq: 0 } }
    const current = { sessionId: 's0', cwd: job.root, isSubagent: false }
    const host = {
      contextOf: async () => context,
      sessionTitleOf: async (id: string) => id,
      listSessions: async () => Array.from({ length: job.count }, (_, i) => ({ id: `s${i}`, cwd: job.root, isLive: i < live, isSubagent: false })),
      readSessionLog: async (id: string) => {
        const start = performance.now()
        const events = (await readFile(join(job.logs, `${id}.jsonl`), 'utf8')).split('\n').map(line => JSON.parse(line))
        const ms = performance.now() - start
        readMs += ms; readMax = Math.max(readMax, ms); reads++
        return { header: { id, isSeeded: false }, inheritedEventCount: 0, events }
      },
    }
    const noReview = { sessionIds: async () => new Set<string>(), isMarkedNoReview: async () => false }
    const workspaceOf = async (cwd: string | undefined) => cwd
    const newCatchup = () => new DialogueCatchup({ store: db, host, noReview, workspaceOf, tokenizer: async () => tokenizer,
      knownWorkspaces: async () => [job.root], isEnabled: () => true, sessionStore: job.logs, log })
    let catchup = newCatchup()
    const dialogue = { store: db, catchup, host, noReview, workspaceOf, tokenizer: async () => tokenizer, includeTools: () => true, hasBackgroundTimer: () => true }
    const ready = (r: Awaited<ReturnType<DialogueCatchup['advance']>>) => {
      if (r.kind === 'unavailable' && r.isBusy && job.mode === 'concurrent') return false
      assert.equal(r.kind, 'ready', '追赶应可用')
      return r.kind === 'ready' && r.status === 'ready' && r.coverage.queued === 0
    }
    if (job.mode === 'concurrent') {
      await new Promise<void>(resolve => {
        process.once('message', () => resolve())
        process.send!('ready')
      })
    }
    let advances = 0, idleAdvances = 0
    const build = async () => {
      let done: boolean
      do {
        const commits = db.commits
        const r = await catchup.advance(CATCHUP_BACKGROUND_BUDGET_MS)
        if (job.mode !== 'huge' || db.commits > commits) advances++
        else idleAdvances++
        done = ready(r)
        await yieldLoop()
      } while (!done)
    }
    const values: Record<string, number | string> = {}
    if (job.mode === 'huge') {
      item = '巨大日志建库及前台检索'
      const delays = monitorEventLoopDelay({ resolution: 1 })
      delays.enable()
      const latencies: number[] = []
      let running = true
      const foreground = async () => {
        let planned = performance.now()
        while (running) {
          // 只命中小的当前会话，单独观察后台建库对前台的影响。
          const result = await searchDialogue({ query: 'foregroundprobe' }, context, dialogue)
          assert.equal(result.kind, 'ready')
          latencies.push(performance.now() - planned)
          planned = performance.now() + FOREGROUND_INTERVAL_MS
          await new Promise(resolve => setTimeout(resolve, Math.max(0, planned - performance.now())))
        }
      }
      const start = performance.now()
      const pending = foreground()
      try { await build(); values.hugeBuild = performance.now() - start }
      finally { running = false; await pending; delays.disable() }
      latencies.sort((a, b) => a - b)
      Object.assign(values, { hugeAdvances: advances, hugeIdleAdvances: idleAdvances, hugeLogRead: readMax, hugeRss: process.resourceUsage().maxRSS / 1024,
        hugeForegroundMax: latencies.at(-1)!, hugeForegroundP95: latencies[Math.ceil(latencies.length * .95) - 1], hugeLoopDelayMax: delays.max / 1e6 })
    } else if (job.mode !== 'measure') {
      item = job.mode === 'rebuild' ? '整份重建' : '首次建库'
      const start = performance.now()
      await build()
      const elapsed = performance.now() - start
      if (job.mode === 'rebuild') values.rebuild = elapsed
      else if (job.mode === 'concurrent') Object.assign(values, { superseded: db.superseded, reads })
      else {
        const size = statSync(job.db).size + (statSync(`${job.db}-journal`, { throwIfNoEntry: false })?.size ?? 0)
        Object.assign(values, { build: elapsed, buildAdvances: advances, buildLogRead: readMs, logReadMax: readMax, dbSize: size / 1024 ** 2, buildRss: process.resourceUsage().maxRSS / 1024 })
      }
    } else {
      const before = async (budget: number) => {
        const r = await catchup.beforeSearch(current, budget, 0)
        assert.equal(r.kind, 'ready')
        return r
      }
      const append = async (extra: number) => {
        for (let i = 0; i < live; i++) {
          const session = syntheticSessionLog({ sessionId: `s${i}`, turns: job.turns + extra, seed: i + 1 })
          await writeFile(join(job.logs, `s${i}.jsonl`), session.events.map(e => JSON.stringify(e)).join('\n'))
        }
      }
      let start: number
      await before(Infinity)
      const measure = async (key: string, fn: () => Promise<boolean | void>) => {
        item = key
        const samples: number[] = []
        for (let i = 0; i < job.rounds; i++) { const t = performance.now(); const included = await fn(); if (included !== false) samples.push(performance.now() - t) }
        if (samples.length === 0) {
          values[`${key}P50`] = '无成功样本'
          values[`${key}P95`] = '无成功样本'
          return
        }
        samples.sort((a, b) => a - b)
        const middle = Math.floor(samples.length / 2)
        values[`${key}P50`] = samples.length % 2 ? samples[middle] : (samples[middle - 1] + samples[middle]) / 2
        values[`${key}P95`] = samples[Math.ceil(samples.length * .95) - 1]
      }
      for (const [key, query, calls] of [['queryAll', 'alpha beta', 1], ['queryAny', 'alpha absentword', 2]] as const) {
        await measure(key, async () => {
          db.searches = 0
          const result = await searchDialogue({ query }, context, dialogue)
          assert.equal(result.kind, 'ready')
          assert.equal(db.searches, calls, '应走指定的 AND 或 OR 路径')
        })
      }
      item = '准备记忆'
      const store = new MemoryStore(new FileTable({ root: join(job.root, 'memories'), stats: new InMemoryKvTable() }), undefined, new InMemoryBatchKvTable())
      for (let i = 0; i < 200; i++) await store.put(record({ id: `bench-${i}`, name: `索引配置 ${i}`, summary: 'alpha beta', content: 'alpha beta 缓存 队列', scope: 'workspace', workspacePath: job.root,
        ...(i % 2 === 0 ? { source: { sessionId: `s${i % job.count}`, eventRange: [1, 2] as [number, number], sourceMode: 'user-explicit' as const } } : {}) }))
      values.bothDegraded = 0
      await measure('both', async () => {
        const result = await executeSearch({ query: 'alpha beta', source: 'both' }, { signal: new AbortController().signal } as ToolRunContext,
          { store, host, registry: buildTypeRegistry({ template: 'coding', customTypes: {} }), tokenizer: { log }, dialogue, searchSource: () => 'both', memoryQuotes: () => true })
        const included = result.dialogueText?.includes('<past-dialogue>') === true && result.quoteNote === undefined
        if (!included) values.bothDegraded = Number(values.bothDegraded) + 1
        return included
      })
      item = '换词典后只重算整词列'
      if (tokenizer.degraded) values.wRewrite = BENCH_SKIPPED
      else {
        const dictionary = join(job.root, 'dictionary.txt')
        await writeFile(dictionary, '索引配置 100000 n\n')
        catchup = newCatchup()
        await before(Infinity)
        const changed = await dialogueTokenizer({ log, userDictionaryPath: () => dictionary })
        start = performance.now()
        tokenizer = { ...changed, tokenizerVersion: tokenizer.tokenizerVersion }
        let rewriting = true
        do {
          ready(await catchup.advance(CATCHUP_BACKGROUND_BUDGET_MS))
          const state = db.state()
          assert(state.status !== 'none')
          rewriting = state.write.wRewriteAfter !== undefined
        } while (rewriting)
        values.wRewrite = performance.now() - start
      }
      item = '增量追赶'
      await before(Infinity)
      await append(FOCUS_NEW_TURNS)
      start = performance.now()
      const incremental = await before(Infinity)
      assert(incremental.kind === 'ready' && incremental.isCaughtUp)
      values.incremental = performance.now() - start
      item = '检索前追赶'
      await before(Infinity)
      await append(FOCUS_NEW_TURNS * 2)
      // 新实例先对账但不追消息，追加日志的耗时不会把对账推入计时窗口。
      catchup = newCatchup()
      await before(0)
      db.measuring = true
      start = performance.now()
      await before(CATCHUP_FOCUS_BUDGET_MS)
      const end = performance.now()
      db.measuring = false
      Object.assign(values, { focus: end - start, focusSessionMax: db.sessionMax, focusTail: end - db.tailStart })
    }
    return values
  } catch (error) { throw new Error(`${item}：${String(error)}`) }
  finally { db.close() }
}

process.once('message', async (job: Job) => {
  try { process.send!(await run(job)) }
  catch (error) { console.error(String(error)); process.exitCode = 1 }
  finally { process.disconnect!() }
})
