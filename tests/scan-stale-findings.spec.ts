import { afterEach, describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { bigRecord, checkupEnv, stubModel, CHECKUP_NOW, DAY_MS, type CheckupEnv } from './helpers/checkup-env.ts'
import { record } from './helpers/record.ts'
import { instructionsOf, noInstructions } from './helpers/instructions.ts'
import { InMemoryKvTable } from './helpers/in-memory-kv.ts'
import { executeConfirm } from '../src/tools/confirm.ts'
import { SnapshotStore } from '../src/governance/snapshots.ts'
import type { MemorySnapshot } from '../src/governance/schema.ts'
import type { MemoryRecord } from '../src/record-schema.ts'
import { GLOBAL_DIR } from '../src/storage/paths.ts'
import { encodeRecord } from '../src/storage/frontmatter.ts'
import { premiseDigest } from '../src/links.ts'
import { PendingDecisionsStore } from '../src/governance/decisions.ts'
import type { SemanticLlm } from '../src/governance/semantic-scan.ts'
import { depthLock } from './helpers/depth-lock.ts'
import { CROSS_WS_ROUND } from '../src/governance/checkup-plan.ts'
import { SidecarStore } from '../src/storage/sidecar.ts'
import { sidecarSchemas } from './helpers/plugin-env.ts'
import { CheckupRecordStore } from '../src/governance/checkup-records.ts'
import { runCheckup, type CheckupRunDeps, type CheckupRunInput } from '../src/gui/checkup-run.ts'
import { STATE_DIR } from '../src/storage/paths.ts'
import { scopeCacheKey, type Scope } from '../src/scope.ts'
import type { CheckupRecord } from '../src/storage/schema.ts'
import type { ScanCacheEntry } from '../src/governance/schema.ts'

// 体检挂账、清库与别处的写入交错（测试切入点：体检核心 runScan）。记忆是真文件、体检结果库是真的 SQLite；
// 交错靠屏障：把体检停在某个调用之前，插入用户的改动或另一次扫描，再放行。开始时刻固定，不 sleep。

const envs: CheckupEnv[] = []
afterEach(async () => { for (const e of envs.splice(0)) await e.close() })

async function env(): Promise<CheckupEnv> {
  const e = await checkupEnv()
  envs.push(e)
  return e
}

/** 一道屏障：reached 在被拦的调用到达时兑现，open 之后被拦的调用才往下走。 */
function barrier() {
  let open!: () => void
  const opened = new Promise<void>(resolve => { open = resolve })
  let onReached!: () => void
  const reached = new Promise<void>(resolve => { onReached = resolve })
  return { opened, reached, open, arrive: onReached }
}

/** 拦下账本的第一次挂账（扫描已经读完记忆和结果库、挂账前的预检也做完了）：放行前先插入别处的动作。 */
function pauseFirstUpsert(e: CheckupEnv) {
  const b = barrier()
  const upsert = e.decisions.upsert.bind(e.decisions)
  let isPaused = false
  e.decisions.upsert = async (...args) => {
    if (!isPaused) {
      isPaused = true
      b.arrive()
      await b.opened
    }
    return upsert(...args)
  }
  return b
}

const resolve = (e: CheckupEnv, decisionId: string, verdict: 'keep-both' | 'dismiss') =>
  executeConfirm({ action: 'resolve', decisionId, verdict }, { workspacePath: undefined }, {
    store: e.store, decisions: e.decisions, snapshots: new SnapshotStore(new InMemoryKvTable<MemorySnapshot>()), instructions: noInstructions, now: () => e.clock.now,
  })

const PAIR = [{ type: 'conflict' as const, ids: ['mem_x', 'mem_y'] }]

async function seedPair(e: CheckupEnv): Promise<void> {
  await e.store.put(record({ id: 'mem_x', name: 'x', content: '用 pnpm' }))
  await e.store.put(record({ id: 'mem_y', name: 'y', content: '用 npm' }))
}

/** 体检记录按接线层的样子带上视图核对（视图是环境里的内存表，写锁用记深度的替身）。 */
function guardStates(e: CheckupEnv): void {
  e.checkups = new CheckupRecordStore(new InMemoryKvTable<CheckupRecord>(), { views: e.views, lock: depthLock(), log: e.deps.log! })
  e.deps.checkups = e.checkups
}

/** 改一条记忆（用户在记忆页改了正文）。 */
async function edit(e: CheckupEnv, id: string, change: Partial<MemoryRecord>): Promise<void> {
  const r = (await e.store.get(id))!
  await e.store.put({ ...r, ...change })
}

/**
 * 随机交错的调度：扫描 A 每到一个调度点（现读记忆、调模型、写视图、挂账，结果库的同步读写记进调度但不停）就编号；
 * 到第 pauseAt 个时停住，跑别处的动作（interfere），再放行。调度点从 A 读完记忆之后才开始编号（第一次读指令文件时）：
 * 在那之前插进来的改动 A 读得到，不是要测的交错。账本写锁内的调用不算调度点：真实写锁让别处的裁决排在锁段之后，
 * 和停在锁段之后的调度点一样，所以用只记深度、不互斥的写锁替身，只在锁外停。
 */
function interleaver(e: CheckupEnv, pauseAt: number) {
  const lock = depthLock()
  const decisions = new PendingDecisionsStore(e.pending, lock)
  e.decisions = decisions
  e.deps.decisions = decisions
  const trace: string[] = []
  let count = 0
  let isWatching = false
  let isArmed = false
  let isInterfering = false
  const b = barrier()
  const point = async (label: string) => {
    if (!isWatching || isInterfering) return
    if (label === 'instructions') isArmed = true
    if (!isArmed || lock.depth > 0) return
    const i = count++
    trace.push(`${i}:${label}`)
    if (i === pauseAt) {
      b.arrive()
      await b.opened
    }
  }
  const note = (label: string) => { if (isWatching && !isInterfering && isArmed) trace.push(label) }
  const wrap = <A extends unknown[], R>(label: string, fn: (...args: A) => Promise<R>) => async (...args: A) => {
    await point(label)
    return fn(...args)
  }
  e.store.get = wrap('get', e.store.get.bind(e.store))
  e.views.update = wrap('view', e.views.update.bind(e.views))
  decisions.upsert = wrap('upsert', decisions.upsert.bind(decisions))
  e.deps.instructions = wrap('instructions', e.deps.instructions)
  const db = e.db
  const readRound = db.readRound.bind(db)
  const write = db.write.bind(db)
  const prune = db.prune.bind(db)
  const written: string[] = []
  db.readRound = (round) => { note(`db-read ${round}`); return readRound(round) }
  db.write = (round, row) => {
    note(`db-write ${row.key.slice(0, 8)}`)
    if (isInterfering) written.push(row.key)
    return write(round, row)
  }
  db.prune = (...args) => { note('db-prune'); return prune(...args) }
  return {
    trace,
    /** 别处写进结果库的批键。 */
    written,
    llm: (m: SemanticLlm): SemanticLlm => ({ ...m, complete: wrap('llm', m.complete) }),
    /** 跑 A：停在第 pauseAt 个调度点时插入 interfere；A 没走到那么多调度点就在它跑完之后插入。 */
    async run(start: () => Promise<unknown>, interfere: () => Promise<void>) {
      isWatching = true
      const scan = start().finally(() => { isWatching = false })
      const reached = await Promise.race([b.reached.then(() => true), scan.then(() => false)])
      trace.push(reached ? '⇢别处' : '⇢A 已跑完，别处')
      isInterfering = true
      try {
        await interfere()
      } finally {
        isInterfering = false
        b.open()
      }
      await scan
    },
  }
}

/** A 读完记忆之后的调度点有多少个（同样的起点和选择下先跑一遍数出来），随机停点在 [0, 个数] 里取，取到个数就是不交错。 */
type Interleaver = ReturnType<typeof interleaver>
async function countPoints(setup: (e: CheckupEnv, il: Interleaver) => Promise<() => Promise<unknown>>): Promise<number> {
  const e = await env()
  const il = interleaver(e, -1)
  await il.run(await setup(e, il), async () => {})
  return il.trace.filter(t => /^\d+:/.test(t)).length
}

/** 每一轮在新的记忆根里跑，跑完就关掉；失败时报出种子、第几轮、这轮的选择和调度。 */
async function eachRound<T>(seed: number, cases: readonly T[], run: (e: CheckupEnv, c: T, check: (cond: boolean, what: string) => void) => Promise<Interleaver>): Promise<void> {
  for (const [round, c] of cases.entries()) {
    const e = await checkupEnv()
    let il: Interleaver | undefined
    const failures: string[] = []
    try {
      il = await run(e, c, (cond, what) => { if (!cond) failures.push(what) })
    } finally {
      await e.close()
    }
    if (failures.length > 0) {
      throw new Error(`种子 ${seed} 第 ${round} 轮 ${JSON.stringify(c)}：${failures.join('；')}\n调度：${il?.trace.join(' → ') ?? ''}`)
    }
  }
}

describe('旧发现不再顶掉用户刚做的裁决', () => {
  it('扫描读到旧的批缓存之后、挂账之前，用户改了一方并裁决两条都留：裁决原样留着，没有新挂的待处理；下一次扫描按新内容重查', async () => {
    const e = await env()
    await seedPair(e)
    const m = stubModel({ findings: PAIR })
    await e.scan({ llm: m })
    const [entry] = await e.decisions.list()

    e.clock.now += 1000
    const gate = pauseFirstUpsert(e)
    const scanning = e.scan({ llm: m })
    await gate.reached
    // 这次扫描命中了上次的结论，没调模型
    expect(m.calls).toHaveLength(1)
    await edit(e, 'mem_x', { content: '用 pnpm 9' })
    expect((await resolve(e, entry!.id, 'keep-both')).kind).toBe('resolved')
    const settled = (await e.pending.get(entry!.id))!
    gate.open()
    await scanning

    expect(await e.decisions.list()).toEqual([])
    expect(await e.pending.get(entry!.id)).toEqual(settled)

    e.clock.now += 1000
    await e.scan({ llm: m })
    expect(m.calls.slice(1).flat()).toContain('mem_x')
  })
})

describe('随机交错：旧发现与用户裁决', () => {
  it('用户在扫描途中改一方并裁决：裁决原样留着、不新挂待处理；下一次扫描按新内容重查（种子 101，60 轮）', async () => {
    const SEED = 101
    const ROUNDS = 60
    const cases = fc.sample(fc.record({
      isCacheHit: fc.boolean(),
      target: fc.constantFrom('mem_x', 'mem_y'),
      change: fc.constantFrom<Partial<MemoryRecord>>({ content: '改过的正文' }, { factTime: '2025-03' }),
      verdict: fc.constantFrom('keep-both' as const, 'dismiss' as const),
      at: fc.nat(),
    }), { seed: SEED, numRuns: ROUNDS })
    /** 起点：上一次扫描挂了这一对；A 命中上次的结论，或换了模型重发这一批。 */
    const prepare = (isCacheHit: boolean) => async (e: CheckupEnv, il: Interleaver) => {
      await seedPair(e)
      const m = stubModel({ findings: PAIR })
      await e.scan({ llm: m })
      e.clock.now += 1000
      const a = il.llm(isCacheHit ? m : stubModel({ model: 'model-b', findings: PAIR }))
      return { m, start: () => e.scan({ llm: a }) }
    }
    const points = new Map<boolean, number>()
    for (const isCacheHit of [true, false]) {
      points.set(isCacheHit, await countPoints(async (e, il) => (await prepare(isCacheHit)(e, il)).start))
    }
    expect(Math.min(...points.values())).toBeGreaterThan(2)

    await eachRound(SEED, cases, async (e, c, check) => {
      const pauseAt = c.at % (points.get(c.isCacheHit)! + 1)
      const il = interleaver(e, pauseAt)
      const { m, start } = await prepare(c.isCacheHit)(e, il)
      const [entry] = await e.decisions.list()
      let settled: unknown
      let verdict: string | undefined
      await il.run(start, async () => {
        await edit(e, c.target, c.change)
        verdict = (await resolve(e, entry!.id, c.verdict)).kind
        settled = await e.pending.get(entry!.id)
      })
      check(verdict === 'resolved', `裁决没做成（${verdict}）`)
      check(isDeepStrictEqual(await e.pending.get(entry!.id), settled), '裁决被改掉了')
      check((await e.decisions.list()).length === 0, '新挂了待处理')
      const from = m.calls.length
      e.clock.now += 1000
      await e.scan({ llm: m })
      check(m.calls.slice(from).flat().includes(c.target), '下一次扫描没有重查改过的那条')
      return il
    })
  }, 60_000)
})

describe('旧发现不删别处刚挂的新发现', () => {
  it('两条都留之后用户改了一方、另一次扫描挂出了例外：裁决前读到的旧冲突发现不删这条例外', async () => {
    const e = await env()
    await seedPair(e)
    const m = stubModel({ findings: PAIR })
    await e.scan({ llm: m })
    const [entry] = await e.decisions.list()
    expect((await resolve(e, entry!.id, 'keep-both')).kind).toBe('resolved')

    e.clock.now += 1000
    const gate = pauseFirstUpsert(e)
    const stale = e.scan({ llm: m })
    await gate.reached
    await edit(e, 'mem_x', { content: '平时用 pnpm，发版脚本例外用 npm' })
    e.clock.now += 1000
    // 模型桩的类型只列了常用几种，例外照样按原样回给扫描
    await e.scan({ llm: stubModel({ model: 'model-b', findings: [{ type: 'exception' as 'conflict', ids: ['mem_x', 'mem_y'] }] }) })
    const exception = (await e.decisions.list()).find(d => d.kind === 'exception')
    expect(exception).toBeDefined()
    gate.open()
    await stale

    expect(await e.decisions.list()).toEqual([exception])
    expect((await e.decisions.listSettled()).map(d => d.id)).toEqual([entry!.id])
  })
})

describe('垂直冲突的旧发现按指令文件复核', () => {
  it('扫描途中指令文件改了、另一次扫描按新指令更新了这条冲突、用户裁决了：按旧指令读到的发现不作废这次裁决、不重新挂出', async () => {
    const e = await env()
    await seedPair(e)
    let agents = '用 npm'
    e.deps.instructions = instructionsOf({ global: () => agents })
    const m = stubModel({ findings: [{ type: 'conflict', ids: ['mem_x'], baselineRef: 'AGENTS.md' }] })
    await e.scan({ llm: m })
    const [entry] = await e.decisions.list()
    expect(entry?.baselineRef).toBe('AGENTS.md')

    e.clock.now += 1000
    const gate = pauseFirstUpsert(e)
    const stale = e.scan({ llm: m })
    await gate.reached
    agents = '用 yarn'
    e.clock.now += 1000
    await e.scan({ llm: m })
    const verdict = await executeConfirm({ action: 'resolve', decisionId: entry!.id, verdict: 'keep-left' }, { workspacePath: undefined }, {
      store: e.store, decisions: e.decisions, snapshots: new SnapshotStore(new InMemoryKvTable<MemorySnapshot>()), instructions: e.deps.instructions, now: () => e.clock.now,
    })
    expect(verdict.kind).toBe('resolved')
    const settled = await e.pending.get(entry!.id)
    gate.open()
    await stale

    expect(await e.pending.get(entry!.id)).toEqual(settled)
    expect(await e.decisions.list()).toEqual([])
  })
})

describe('跨项目重复的旧发现', () => {
  it('全库体检途中用户改了一方、另一次全库体检更新了这条重复、用户忽略了：之前读到的旧比较结论不重开这条', async () => {
    const e = await env()
    const P1 = '/work/one'
    const P2 = '/work/two'
    await e.store.put(record({ id: 'mem_p1', name: '一', summary: '用 pnpm', scope: 'workspace', workspacePath: P1 }))
    await e.store.put(record({ id: 'mem_p2', name: '二', summary: '用 pnpm', scope: 'workspace', workspacePath: P2 }))
    const all = { kind: 'checkup' as const, workspaces: [P1, P2] }
    const m = stubModel()
    m.crossReply = JSON.stringify({ duplicates: [{ topic: '包管理器', workspaces: [P1, P2], suggestion: '提一条全局', memoryIds: ['mem_p1', 'mem_p2'] }] })
    await e.scan({ llm: m, target: all })
    const entry = (await e.decisions.list()).find(d => d.kind === 'cross-duplicate')
    expect(entry).toBeDefined()

    e.clock.now += 1000
    const gate = pauseFirstUpsert(e)
    const stale = e.scan({ llm: m, target: all })
    await gate.reached
    await edit(e, 'mem_p1', { content: '用 pnpm 9', summary: '用 pnpm 9' })
    e.clock.now += 1000
    await e.scan({ llm: m, target: all })
    expect((await e.decisions.get(entry!.id))?.fingerprint).not.toBe(entry!.fingerprint)
    const verdict = await executeConfirm({ action: 'resolve', decisionId: entry!.id, verdict: 'dismiss', allowCrossWorkspace: true }, { workspacePath: P1 }, {
      store: e.store, decisions: e.decisions, snapshots: new SnapshotStore(new InMemoryKvTable<MemorySnapshot>()), instructions: noInstructions, now: () => e.clock.now,
    })
    expect(verdict.kind).toBe('resolved')
    const settled = await e.pending.get(entry!.id)
    gate.open()
    await stale

    expect(await e.pending.get(entry!.id)).toEqual(settled)
    expect(await e.decisions.list()).toEqual([])
  })
})

describe('依据已变的旧发现', () => {
  /** 决定 mem_d 依据 mem_p；mem_p 之后改过一次（依据已变）。 */
  async function seedPremise(e: CheckupEnv): Promise<void> {
    const premise = record({ id: 'mem_p', name: '容量', content: '容量 10' })
    await e.store.put(premise)
    await e.store.put(record({ id: 'mem_d', name: '暂停扩容', content: '容量够用，暂停扩容', premises: [{ id: premise.id, digest: premiseDigest(premise) }] }))
    await edit(e, 'mem_p', { content: '容量 100' })
  }
  const premiseOpen = async (e: CheckupEnv) => (await e.decisions.list()).filter(d => d.kind === 'premise-changed')

  it('用户忽略依据已变之后，裁决前读到的旧扫描不重新挂出', async () => {
    const e = await env()
    await seedPremise(e)
    await e.scan({ llm: null })
    const [entry] = await premiseOpen(e)
    expect(entry).toBeDefined()

    e.clock.now += 1000
    const gate = pauseFirstUpsert(e)
    const stale = e.scan({ llm: null })
    await gate.reached
    // 前提又改了一次，另一次扫描把条目更新成现在的样子，用户看过后忽略
    await edit(e, 'mem_p', { content: '容量 1000' })
    e.clock.now += 1000
    await e.scan({ llm: null })
    expect((await resolve(e, entry!.id, 'dismiss')).kind).toBe('resolved')
    const settled = (await e.pending.get(entry!.id))!
    gate.open()
    await stale

    expect(await premiseOpen(e)).toEqual([])
    expect(await e.pending.get(entry!.id)).toEqual(settled)
  })

  it('前提修好之后（决定按新前提重记），之前读到的旧扫描不挂出依据已变', async () => {
    const e = await env()
    await seedPremise(e)
    const gate = pauseFirstUpsert(e)
    const stale = e.scan({ llm: null })
    await gate.reached
    const premise = (await e.store.get('mem_p'))!
    await edit(e, 'mem_d', { premises: [{ id: premise.id, digest: premiseDigest(premise) }] })
    gate.open()
    await stale
    expect(await premiseOpen(e)).toEqual([])
  })

  it('挂账前的预检之后前提被删进最近删除、账本里还没有这一条：不挂出', async () => {
    const e = await env()
    await seedPremise(e)
    const gate = pauseFirstUpsert(e)
    const stale = e.scan({ llm: null })
    await gate.reached
    expect(await e.store.softDelete({ id: 'mem_p' }, { now: e.clock.now })).toBe(true)
    gate.open()
    await stale
    expect(await premiseOpen(e)).toEqual([])
  })
})

describe('挂账按预读到的那份副本复核', () => {
  const P = '/work/app'
  const PROJECT = { kind: 'scope' as const, scope: { kind: 'workspace' as const, workspacePath: P } }

  it('同 id 的全局、项目两份副本都在用：连续两次扫描都能挂账', async () => {
    const e = await env()
    await e.store.put(record({ id: 'mem_x', name: 'x', content: '用 pnpm', scope: 'workspace', workspacePath: P }))
    // 同 id 的全局那份直接写文件（写入路径会把同 id 当成同一条）
    await mkdir(join(e.memoryRoot, GLOBAL_DIR), { recursive: true })
    await writeFile(join(e.memoryRoot, GLOBAL_DIR, 'mem-x.md'), encodeRecord(record({ id: 'mem_x', name: 'x 全局', content: '全局：用 npm' }), {}), 'utf8')
    await e.store.put(record({ id: 'mem_y', name: 'y', content: '用 npm', scope: 'workspace', workspacePath: P }))
    const m = stubModel({ findings: PAIR })
    const first = await e.scan({ llm: m, target: PROJECT })
    e.clock.now += 1000
    const second = await e.scan({ llm: m, target: PROJECT })
    expect(first.kind === 'single' && first.pendingDecisions).toMatchObject({ created: 1, existing: 0 })
    expect(second.kind === 'single' && second.pendingDecisions).toMatchObject({ created: 0, existing: 1 })
    expect((await e.decisions.list()).map(d => d.workspaces)).toEqual([[P, P]])
  })
})

/** 拦下模型的第一次调用（扫描已经读完记忆和结果库、正在查没命中的那一批）。 */
function pauseFirstCall(m: SemanticLlm) {
  const b = barrier()
  let isPaused = false
  const llm: SemanticLlm = {
    ...m,
    complete: async (...args) => {
      if (!isPaused) {
        isPaused = true
        b.arrive()
        await b.opened
      }
      return m.complete(...args)
    },
  }
  return { ...b, llm }
}

const keysOf = (e: CheckupEnv, round: string) => e.db.readRound(round)!.rows.map(r => r.key).sort()

describe('随机交错：旧扫描与别处的新扫描', () => {
  it('别处在旧扫描途中改了记忆并做完一次新扫描：新扫描写的批缓存都还在，下一次扫描全部命中、不调模型（种子 102，60 轮）', async () => {
    const SEED = 102
    const ROUNDS = 60
    const cases = fc.sample(fc.record({
      isOtherModel: fc.boolean(),
      target: fc.constantFrom('mem_x', 'mem_y'),
      at: fc.nat(),
    }), { seed: SEED, numRuns: ROUNDS })
    /** 起点：上一次扫描查过这一对，之后 mem_x 改过；A 用同一个模型或换个模型重查这一批。 */
    const prepare = (isOtherModel: boolean) => async (e: CheckupEnv, il: Interleaver) => {
      await seedPair(e)
      const m = stubModel({ findings: PAIR })
      await e.scan({ llm: m })
      await edit(e, 'mem_x', { content: '用 pnpm 8' })
      e.clock.now += 1000
      const a = il.llm(isOtherModel ? stubModel({ model: 'model-b', findings: PAIR }) : m)
      return { m, start: () => e.scan({ llm: a }) }
    }
    const points = new Map<boolean, number>()
    for (const isOtherModel of [true, false]) {
      points.set(isOtherModel, await countPoints(async (e, il) => (await prepare(isOtherModel)(e, il)).start))
    }
    expect(Math.min(...points.values())).toBeGreaterThan(2)

    await eachRound(SEED, cases, async (e, c, check) => {
      const il = interleaver(e, c.at % (points.get(c.isOtherModel)! + 1))
      const { m, start } = await prepare(c.isOtherModel)(e, il)
      await il.run(start, async () => {
        await edit(e, c.target, { content: `${c.target} 后来又改了` })
        e.clock.now += 1000
        await e.scan({ llm: m })
      })
      check(il.written.length > 0, '新扫描没写结果库')
      const left = new Set(keysOf(e, 'global'))
      check(il.written.every(key => left.has(key)), '新扫描写的批缓存被清掉了')
      const from = m.calls.length
      e.clock.now += 1000
      await e.scan({ llm: m })
      check(m.calls.length === from, '下一次扫描又调了模型')
      return il
    })
  }, 60_000)
})

describe('旧扫描不再清掉新缓存、不覆盖失败状态', () => {
  it('旧扫描和别处的新扫描并发、新扫描先发布：旧扫描结束后新扫描写的批缓存都在，下一次扫描命中、不调模型', async () => {
    const e = await env()
    await seedPair(e)
    const m = stubModel({ findings: PAIR })
    await e.scan({ llm: m })
    await edit(e, 'mem_x', { content: '用 pnpm 8' })
    e.clock.now += 1000
    const slow = pauseFirstCall(m)
    const stale = e.scan({ llm: slow.llm })
    await slow.reached
    await edit(e, 'mem_x', { content: '用 pnpm 9' })
    e.clock.now += 1000
    await e.scan({ llm: m })
    const fresh = keysOf(e, 'global')
    const view = await e.view({ kind: 'global' })
    slow.open()
    await stale

    expect(keysOf(e, 'global')).toEqual(expect.arrayContaining(fresh))
    expect(await e.view({ kind: 'global' })).toEqual(view)
    const from = m.calls.length
    e.clock.now += 1000
    await e.scan({ llm: m })
    expect(m.calls.length).toBe(from)
  })

  it('旧扫描全部查成、发布被拒（更新的扫描已发布部分结果并记了失败）：不写完成记录、不清库，失败、模型用不了、约好的接着查都原样', async () => {
    const e = await env()
    guardStates(e)
    for (const [id, createdAt] of [['mem_b1', 1], ['mem_b2', 2]] as const) await e.store.put(bigRecord({ id, createdAt }))
    const m = stubModel()
    await e.scan({ llm: m })
    await edit(e, 'mem_b1', { content: `mem_b1：${'改'.repeat(27_000)}` })
    e.clock.now += 1000
    const slow = pauseFirstCall(m)
    const stale = e.scan({ llm: slow.llm })
    await slow.reached

    // 更新的一次：两批（两条长记忆各成一批）都要重查，第二批没做成；结果发布了一部分，体检执行器给这个范围记了失败等
    await edit(e, 'mem_b1', { content: `mem_b1：${'又'.repeat(27_000)}` })
    await edit(e, 'mem_b2', { content: `mem_b2：${'也'.repeat(27_000)}` })
    e.clock.now += 1000
    const newer = e.clock.now
    const failing = stubModel()
    failing.fail = (_ids, call) => (call >= 2 ? new Error('模型出错') : undefined)
    const partial = await e.scan({ llm: failing })
    expect(partial.kind === 'single' && partial.rounds![0]!.closing).toBe('failed')
    expect((await e.view({ kind: 'global' }))?.scannedAt).toBe(newer)
    await e.checkups.recordFailure({ kind: 'global' }, { kind: 'model-error', message: '模型出错' }, newer, newer)
    await e.checkups.recordModelUnavailable({ kind: 'global' }, { kind: 'no-default-model' }, newer)
    await e.checkups.recordContinue({ kind: 'global' }, newer + DAY_MS, newer)
    const record = await e.checkups.list()
    const rows = keysOf(e, 'global')
    slow.open()
    const r = await stale

    expect(r.kind === 'single' && r.rounds![0]!.closing).toBe('complete')
    expect(await e.checkups.list()).toEqual(record)
    expect(keysOf(e, 'global')).toEqual(expect.arrayContaining(rows))
  })

  it('旧扫描发布之后、清库之前，别处改了记忆并做完一次新扫描：旧扫描清库时留着新扫描写的批缓存，下一次扫描命中、不调模型', async () => {
    const e = await env()
    await seedPair(e)
    const m = stubModel({ findings: PAIR })
    await e.scan({ llm: m })
    await edit(e, 'mem_x', { content: '用 pnpm 8' })
    e.clock.now += 1000
    const gate = barrier()
    const update = e.views.update.bind(e.views)
    let isPaused = false
    e.views.update = async (...args) => {
      const isWritten = await update(...args)
      if (isWritten && !isPaused) {
        isPaused = true
        gate.arrive()
        await gate.opened
      }
      return isWritten
    }
    const stale = e.scan({ llm: m })
    await gate.reached
    expect((await e.view({ kind: 'global' }))?.scannedAt).toBe(e.clock.now)
    await edit(e, 'mem_x', { content: '用 pnpm 9' })
    e.clock.now += 1000
    await e.scan({ llm: m })
    const fresh = keysOf(e, 'global')
    gate.open()
    await stale

    expect(keysOf(e, 'global')).toEqual(expect.arrayContaining(fresh))
    const from = m.calls.length
    e.clock.now += 1000
    await e.scan({ llm: m })
    expect(m.calls.length).toBe(from)
  })

  it('全库体检：旧的一次发布被拒（别处更新的全库体检先发布了）：各项目、全局的轮和跨项目比较都不清库', async () => {
    const e = await env()
    const P1 = '/work/one'
    const P2 = '/work/two'
    await e.store.put(record({ id: 'mem_g', name: '全局' }))
    await e.store.put(record({ id: 'mem_p1', name: '一', summary: '用 pnpm', scope: 'workspace', workspacePath: P1 }))
    await e.store.put(record({ id: 'mem_p2', name: '二', summary: '用 pnpm', scope: 'workspace', workspacePath: P2 }))
    const all = { kind: 'checkup' as const, workspaces: [P1, P2] }
    const m = stubModel()
    m.crossReply = JSON.stringify({ duplicates: [{ topic: '包管理器', workspaces: [P1, P2], suggestion: '提一条全局' }] })
    await e.scan({ llm: m, target: all })
    await edit(e, 'mem_p1', { summary: '用 pnpm 8' })
    e.clock.now += 1000
    const slow = pauseFirstCall(m)
    const stale = e.scan({ llm: slow.llm, target: all })
    await slow.reached
    await edit(e, 'mem_p1', { summary: '用 pnpm 9' })
    e.clock.now += 1000
    await e.scan({ llm: m, target: all })
    const newer = e.clock.now
    const pruned: string[] = []
    const prune = e.db.prune.bind(e.db)
    e.db.prune = (...args) => {
      pruned.push(args[0])
      return prune(...args)
    }
    slow.open()
    await stale

    const scopes: Scope[] = [{ kind: 'global' }, { kind: 'workspace', workspacePath: P1 }, { kind: 'workspace', workspacePath: P2 }]
    expect(await Promise.all(scopes.map(async scope => (await e.view(scope))?.scannedAt))).toEqual([newer, newer, newer])
    expect(m.crossCalls).toBeGreaterThan(0)
    expect(pruned).toEqual([])
  })

  /** 旧扫描发布之后、写完成记录之前停住。 */
  function pauseBeforeComplete(e: CheckupEnv) {
    const b = barrier()
    const complete = e.checkups.complete.bind(e.checkups)
    let isPaused = false
    e.checkups.complete = async (...args) => {
      if (!isPaused) {
        isPaused = true
        b.arrive()
        await b.opened
      }
      return complete(...args)
    }
    return b
  }

  it('旧扫描发布之后、写完成记录之前，更新的扫描发布了部分结果并记了失败：旧扫描不写完成记录，失败、模型用不了、约好的接着查都原样', async () => {
    const e = await env()
    guardStates(e)
    for (const [id, createdAt] of [['mem_b1', 1], ['mem_b2', 2]] as const) await e.store.put(bigRecord({ id, createdAt }))
    const paused = pauseBeforeComplete(e)
    const stale = e.scan({ llm: stubModel() })
    await paused.reached
    expect((await e.view({ kind: 'global' }))?.scannedAt).toBe(CHECKUP_NOW)
    expect(await e.checkups.list()).toEqual([])

    await edit(e, 'mem_b1', { content: `mem_b1：${'又'.repeat(27_000)}` })
    await edit(e, 'mem_b2', { content: `mem_b2：${'也'.repeat(27_000)}` })
    e.clock.now += 1000
    const newer = e.clock.now
    const failing = stubModel()
    failing.fail = (_ids, call) => (call >= 2 ? new Error('模型出错') : undefined)
    const partial = await e.scan({ llm: failing })
    expect(partial.kind === 'single' && partial.rounds![0]!.closing).toBe('failed')
    expect((await e.view({ kind: 'global' }))?.scannedAt).toBe(newer)
    await e.checkups.recordFailure({ kind: 'global' }, { kind: 'model-error', message: '模型出错' }, newer, newer)
    await e.checkups.recordModelUnavailable({ kind: 'global' }, { kind: 'no-default-model' }, newer)
    await e.checkups.recordContinue({ kind: 'global' }, newer + DAY_MS, newer)
    const record = await e.checkups.list()
    paused.open()
    const r = await stale

    expect(r.kind === 'single' && r.rounds![0]!.closing).toBe('complete')
    expect(await e.checkups.list()).toEqual(record)
  })

  it('全库体检：旧的一次在别处更新的全库体检先发布之后才做完，新体检写的跨项目比较结论还在，下一次不再比', async () => {
    const e = await env()
    const P1 = '/work/one'
    const P2 = '/work/two'
    await e.store.put(record({ id: 'mem_g', name: '全局' }))
    await e.store.put(record({ id: 'mem_p1', name: '一', summary: '用 pnpm', scope: 'workspace', workspacePath: P1 }))
    await e.store.put(record({ id: 'mem_p2', name: '二', summary: '用 pnpm', scope: 'workspace', workspacePath: P2 }))
    const all = { kind: 'checkup' as const, workspaces: [P1, P2] }
    const m = stubModel()
    m.crossReply = JSON.stringify({ duplicates: [{ topic: '包管理器', workspaces: [P1, P2], suggestion: '提一条全局' }] })
    await e.scan({ llm: m, target: all })
    await edit(e, 'mem_p1', { summary: '用 pnpm 8' })
    e.clock.now += 1000
    const slow = pauseFirstCall(m)
    const stale = e.scan({ llm: slow.llm, target: all })
    await slow.reached
    await edit(e, 'mem_p1', { summary: '用 pnpm 9' })
    e.clock.now += 1000
    await e.scan({ llm: m, target: all })
    const cross = keysOf(e, CROSS_WS_ROUND)
    const rounds = keysOf(e, P1)
    slow.open()
    await stale

    expect(keysOf(e, CROSS_WS_ROUND)).toEqual(expect.arrayContaining(cross))
    expect(keysOf(e, P1)).toEqual(expect.arrayContaining(rounds))
    const [calls, crossCalls] = [m.calls.length, m.crossCalls]
    e.clock.now += 1000
    await e.scan({ llm: m, target: all })
    expect([m.calls.length, m.crossCalls]).toEqual([calls, crossCalls])
  })
})

describe('体检状态在写锁里核对视图之后才写', () => {
  const GLOBAL = { kind: 'global' as const }

  /** 换上真实侧表：视图和体检记录都在记忆根的 .state 下、同一把记忆根写锁，体检记录按接线层的样子带上视图核对。 */
  function sidecars(e: CheckupEnv) {
    const sidecar = new SidecarStore({ root: e.memoryRoot, schemas: sidecarSchemas, now: () => e.clock.now, log: e.deps.log })
    e.deps.cache = sidecar.scanCache
    e.checkups = new CheckupRecordStore(sidecar.checkups, { views: sidecar.scanCache, lock: sidecar.lock, log: e.deps.log! })
    e.deps.checkups = e.checkups
    const viewPath = (scope: Scope) => join(e.memoryRoot, STATE_DIR, 'scan-cache', `${createHash('sha1').update(scopeCacheKey(scope)).digest('hex')}.json`)
    return {
      sidecar,
      viewOf: (scope: Scope) => sidecar.scanCache.get(scopeCacheKey(scope)),
      /** 让这个范围的视图读不出（同名路径换成目录，读的时候报错），返回恢复的函数。 */
      breakView: async (scope: Scope) => {
        const path = viewPath(scope)
        await rename(path, `${path}.saved`)
        await mkdir(path)
        return async () => {
          await rm(path, { recursive: true })
          await rename(`${path}.saved`, path)
        }
      },
    }
  }

  /** 界面手动体检、自动体检的执行器；rewriteAll 是体检核心返回之后重写视图那一步（在记失败、模型用不了之前）。 */
  function checkupRun(e: CheckupEnv, input: Pick<CheckupRunInput, 'target' | 'by' | 'llm'>, rewriteAll: () => Promise<void> = async () => {}) {
    return runCheckup(input, {
      scan: e.deps, checkups: e.checkups, now: () => e.clock.now,
      views: { collectViews: async () => { throw new Error('测试不收集界面视图') }, rewriteAll: async () => { await rewriteAll() } } as unknown as CheckupRunDeps['views'],
      interval: () => () => {}, log: e.deps.log!,
    })
  }

  const hostError = (code: string): SemanticLlm => ({ complete: async () => { throw Object.assign(new Error(code), { code }) } })

  it.each(['RATE_LIMIT', 'ACCOUNT_SIGN_IN_REQUIRED'])('自动体检的核心已经返回、还没记失败（%s）时，更新的语义扫描发布了：失败、模型用不了都不记', async code => {
    const e = await env()
    const { viewOf } = sidecars(e)
    await seedPair(e)
    const gate = barrier()
    let isPaused = false
    const run = checkupRun(e, { target: GLOBAL, by: 'auto', llm: hostError(code) }, async () => {
      if (isPaused) return
      isPaused = true
      gate.arrive()
      await gate.opened
    })
    await gate.reached
    e.clock.now += 1000
    await e.scan({ llm: stubModel(), layers: 'semantic' })
    expect((await viewOf(GLOBAL))?.scannedAt).toBe(e.clock.now)
    gate.open()
    await run

    const [rec] = await e.checkups.list()
    expect([rec?.failure, rec?.modelUnavailable, rec?.completed]).toEqual([undefined, undefined, undefined])
  })

  it('旧体检发布之后、写完成记录之前，更新的一次第一批就失败、没有可发布的结果，只记了失败：旧体检照写完成记录，但不清掉这条失败', async () => {
    const e = await env()
    sidecars(e)
    await seedPair(e)
    const gate = barrier()
    const complete = e.checkups.complete.bind(e.checkups)
    let isPaused = false
    e.checkups.complete = async (...args) => {
      if (!isPaused) {
        isPaused = true
        gate.arrive()
        await gate.opened
      }
      return complete(...args)
    }
    const stale = e.scan({ llm: stubModel() }, { by: 'agent' })
    await gate.reached
    e.clock.now += 1000
    await edit(e, 'mem_x', { content: '用 pnpm 9' })
    const failed = await checkupRun(e, { target: GLOBAL, by: 'auto', llm: hostError('RATE_LIMIT') })
    expect(failed.kind).toBe('failed')
    const [before] = await e.checkups.list()
    expect(before?.failure?.failedAt).toBe(e.clock.now)
    gate.open()
    await stale

    const [after] = await e.checkups.list()
    expect(after?.completed?.startedAt).toBe(CHECKUP_NOW)
    expect(after?.failure).toEqual(before?.failure)
  })

  it('旧体检核对视图之后、写完成记录之前，又一次扫描要发布：等旧体检写完才发布；更新的那次记下的失败仍不被清掉', async () => {
    const e = await env()
    const { sidecar, viewOf } = sidecars(e)
    await seedPair(e)
    const beforeComplete = barrier()
    const complete = e.checkups.complete.bind(e.checkups)
    let isCompletePaused = false
    e.checkups.complete = async (...args) => {
      if (!isCompletePaused) {
        isCompletePaused = true
        beforeComplete.arrive()
        await beforeComplete.opened
      }
      return complete(...args)
    }
    const stale = e.scan({ llm: stubModel() }, { by: 'agent' })
    await beforeComplete.reached
    e.clock.now += 1000
    await edit(e, 'mem_x', { content: '用 pnpm 9' })
    await checkupRun(e, { target: GLOBAL, by: 'auto', llm: hostError('RATE_LIMIT') })
    const [before] = await e.checkups.list()
    expect(before?.failure).toBeDefined()

    // 下一次读视图就是旧体检写完成记录前的核对：核对完停住
    const afterCheck = barrier()
    const getChecked = sidecar.scanCache.getChecked.bind(sidecar.scanCache)
    let isCheckPaused = false
    sidecar.scanCache.getChecked = async (...args) => {
      const read = await getChecked(...args)
      if (!isCheckPaused) {
        isCheckPaused = true
        afterCheck.arrive()
        await afterCheck.opened
      }
      return read
    }
    beforeComplete.open()
    await afterCheck.reached
    e.clock.now += 1000
    const newer = e.clock.now
    const semantic = e.scan({ llm: stubModel(), layers: 'semantic' })
    afterCheck.open()
    await Promise.all([stale, semantic])

    const [after] = await e.checkups.list()
    expect(after?.completed?.startedAt).toBe(CHECKUP_NOW)
    expect(after?.failure).toEqual(before?.failure)
    expect((await viewOf(GLOBAL))?.scannedAt).toBe(newer)
  })

  it('视图读不出时完成记录、续查时间不写，失败、模型用不了照写，都记日志；视图恢复后下一次体检照常写完成记录', async () => {
    const e = await env()
    const { breakView } = sidecars(e)
    await seedPair(e)
    await e.scan({ llm: stubModel() })
    const record = await e.checkups.list()
    expect(record[0]?.completed?.startedAt).toBe(CHECKUP_NOW)
    const restore = await breakView(GLOBAL)
    e.clock.now += 1000
    const at = e.clock.now
    const logged = e.logs.length

    await e.checkups.complete([GLOBAL], { startedAt: at, completedAt: at, by: 'agent' })
    await e.checkups.recordContinue(GLOBAL, at + DAY_MS, at)
    expect(await e.checkups.list()).toEqual(record)
    await e.checkups.recordFailure(GLOBAL, { kind: 'model-error', message: '模型出错' }, at, at)
    await e.checkups.recordModelUnavailable(GLOBAL, { kind: 'no-default-model' }, at)
    expect(await e.checkups.list()).toEqual([{
      ...record[0],
      failure: { count: 1, failedAt: at, cause: { kind: 'model-error', message: '模型出错' } },
      modelUnavailable: { kind: 'no-default-model' },
    }])
    expect(e.logs.slice(logged).filter(line => line.includes('读不出 global 的体检视图'))).toHaveLength(4)

    await restore()
    e.clock.now += 1000
    await e.scan({ llm: stubModel() })
    expect((await e.checkups.list())[0]?.completed?.startedAt).toBe(e.clock.now)
  })

  it('全库体检的认领过期、被别的体检接手：旧的那次停在约「接着查」之前，恢复后不改接手那次约的时间', async () => {
    const e = await env()
    const { viewOf } = sidecars(e)
    const P = '/work/app'
    const project = { kind: 'workspace' as const, workspacePath: P }
    await e.store.put(bigRecord({ id: 'mem_g' }))
    await e.store.put(bigRecord({ id: 'mem_p', scope: 'workspace', workspacePath: P }))
    await e.scan({ target: { kind: 'scope', scope: project }, layers: 'semantic', llm: stubModel({ model: 'seed', findings: [{ type: 'unclear', ids: ['mem_p'] }] }) })
    e.clock.now += 1000
    // 上限只够一批：全局那批用完，项目这一轮一批都没轮到
    e.tokenCap.value = 1
    const gate = barrier()
    const recordContinue = e.checkups.recordContinue.bind(e.checkups)
    let isPaused = false
    e.checkups.recordContinue = async (...args) => {
      if (!isPaused && args[0].kind === 'workspace') {
        isPaused = true
        gate.arrive()
        await gate.opened
      }
      return recordContinue(...args)
    }
    const stale = checkupRun(e, { target: { kind: 'all' }, by: 'manual', llm: stubModel() })
    await gate.reached
    // 旧的那次停住期间没有心跳：认领过期，下一次全库体检接手
    e.clock.now += 61_000
    await edit(e, 'mem_g', { content: `改过 ${'记'.repeat(27_000)}` })
    const newer = await checkupRun(e, { target: { kind: 'all' }, by: 'manual', llm: stubModel() })
    expect(newer.kind).not.toBe('busy')
    expect((await viewOf(project))?.scannedAt).toBe(e.clock.now)
    const before = (await e.checkups.list()).find(r => r.id === P)
    expect(before?.continueAt).toBe(e.clock.now + DAY_MS)
    gate.open()
    await stale

    expect((await e.checkups.list()).find(r => r.id === P)?.continueAt).toBe(before?.continueAt)
  })

  it('体检核心和执行器写四类状态时，核对和写入在同一个写锁段里：读视图时已持锁，写入是同一段', async () => {
    let entered = 0
    let section: number | undefined
    const seen: Array<[string, number | undefined]> = []
    const lock = {
      run: async <T>(fn: () => Promise<T>): Promise<T> => {
        if (section !== undefined) return fn()
        section = ++entered
        try {
          return await fn()
        } finally {
          section = undefined
        }
      },
    }
    const views = new InMemoryKvTable<ScanCacheEntry>()
    const getChecked = views.getChecked.bind(views)
    views.getChecked = async key => {
      seen.push(['核对', section])
      return getChecked(key)
    }
    const table = new InMemoryKvTable<CheckupRecord>()
    const update = table.update.bind(table)
    table.update = async (key, fn) => {
      seen.push(['写', section])
      return update(key, fn)
    }
    const checkups = new CheckupRecordStore(table, { views, lock, log: { info() {}, warn() {}, error() {} } })
    const at = CHECKUP_NOW
    await checkups.complete([GLOBAL], { startedAt: at, completedAt: at, by: 'agent' })
    await checkups.recordContinue(GLOBAL, at + DAY_MS, at)
    await checkups.recordFailure(GLOBAL, { kind: 'model-error', message: '模型出错' }, at, at)
    await checkups.recordModelUnavailable(GLOBAL, { kind: 'no-default-model' }, at)

    expect(seen).toEqual([1, 2, 3, 4].flatMap(n => [['核对', n], ['写', n]]))
  })
})
