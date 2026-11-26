import { afterEach, describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { checkupEnv, stubModel, type CheckupEnv } from './helpers/checkup-env.ts'
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
