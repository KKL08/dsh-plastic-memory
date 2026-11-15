import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FileTable } from '../src/storage/file-table.ts'
import { SidecarStore } from '../src/storage/sidecar.ts'
import { createRootLock } from '../src/storage/root-lock.ts'
import { encodeRecord } from '../src/storage/frontmatter.ts'
import { GLOBAL_DIR, INDEX_FILE, STATE_DIR, slugifyName } from '../src/storage/paths.ts'
import { MemoryStore } from '../src/store.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'
import { executeSearch } from '../src/tools/search.ts'
import { PendingDecisionsStore } from '../src/governance/decisions.ts'
import { memorySnapshotSchema, pendingDecisionSchema, scanCacheSchema, adviceIgnoreSchema } from '../src/governance/schema.ts'
import { RootLockTimeoutError } from '../src/errors.ts'
import { collectGlobalViews } from '../src/gui/view-writer.ts'
import { GUI_VIEW_DIR, GUI_VIEW_FILES, GUI_WORKSPACE_MAP_FILE } from '../src/gui/contract.ts'
import type { RootLock } from '../src/root-lock.ts'
import type { RecallStats } from '../src/storage/schema.ts'
import { record } from './helpers/record.ts'
import { fakeExec } from './helpers/exec.ts'
import { InMemoryKvTable } from './helpers/in-memory-kv.ts'
import { fireUntilSettled, manualTimers, type ManualTimers } from './helpers/manual-timers.ts'
import { signal, waitForSignal } from './helpers/signal-files.ts'
import { spawnWorker, type LineWorker } from './helpers/spawn-worker.ts'

// 写锁接进文件表、侧表、认领与 withClaim 之后的外部行为：真 node:sqlite、真临时目录；
// 另一个进程用真子进程，同进程里的另一个实例用另一个 RootLock（两个实例互斥，同 RL-03）。退避计时注入手动计时器，不真等。

const LOCK_WORKER = fileURLToPath(new URL('./helpers/root-lock-worker.ts', import.meta.url))
const WRITE_WORKER = fileURLToPath(new URL('./helpers/lock-write-worker.ts', import.meta.url))
const VIEW_WORKER = fileURLToPath(new URL('./helpers/view-writer-worker.ts', import.meta.url))
const schemas = { snapshots: memorySnapshotSchema, pending: pendingDecisionSchema, scanCache: scanCacheSchema, adviceIgnores: adviceIgnoreSchema }
const quietLog = { info() {}, warn() {}, error() {} }
const registry = buildTypeRegistry({ template: 'coding', customTypes: {} })

let root: string
let signals: string
let workers: LineWorker[] = []
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pm-lock-wiring-'))
  signals = await mkdtemp(join(tmpdir(), 'pm-lock-wiring-signals-'))
})
afterEach(async () => {
  await Promise.all(workers.splice(0).map(w => w.kill()))
  await rm(root, { recursive: true, force: true })
  await rm(signals, { recursive: true, force: true })
})

const lockDir = () => join(root, STATE_DIR, 'lock')

/** 一把真写锁（手动计时器）。 */
function realLock(extra: { loadSqlite?: () => { DatabaseSync: typeof import('node:sqlite').DatabaseSync } | undefined } = {}): { lock: RootLock; timers: ManualTimers } {
  const timers = manualTimers()
  return { lock: createRootLock({ root, log: quietLog, timers, ...extra }), timers }
}

/** 接线层同款：一把锁注入侧表、文件表、待决账本。 */
function wired(lock: RootLock, now = () => Date.now()) {
  const sidecar = new SidecarStore({ root, schemas, lock, log: quietLog, now })
  const table = new FileTable({ root, lock, stats: sidecar.recallStats, log: quietLog, now })
  const store = new MemoryStore(table, quietLog, sidecar.recallStats)
  const decisions = new PendingDecisionsStore(sidecar.pending, lock)
  return { sidecar, table, store, decisions }
}

/** 同进程里占住写锁的另一个实例：hold() 拿到锁后返回，release() 放开。 */
async function holdElsewhere() {
  const other = createRootLock({ root, log: quietLog })
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let held!: () => void
  const isHeld = new Promise<void>(resolve => { held = resolve })
  const done = other.run(async () => { held(); await gate })
  await isHeld
  return { release: async () => { release(); await done } }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(r => { resolve = r })
  return { promise, resolve }
}

async function startWorker(script: string, args: string[]): Promise<LineWorker> {
  const w = spawnWorker(script, args)
  workers.push(w)
  expect(await w.nextLine()).toBe('ready')
  return w
}

describe('RL-04 懒打开：只读入口不碰锁库', () => {
  it('RL-04 第一次 run 之前、readScope 与没有命中的检索之后，不加载 node:sqlite、不建 .state/lock/；第一次写入才加载', async () => {
    let loads = 0
    const { lock } = realLock({ loadSqlite: () => { loads++; return process.getBuiltinModule('node:sqlite') } })
    const { table, store } = wired(lock)
    await mkdir(join(root, GLOBAL_DIR), { recursive: true })
    await writeFile(join(root, GLOBAL_DIR, 'a.md'), encodeRecord(record({ id: 'mem_a', name: '甲', content: '用 pnpm' }), {}), 'utf8')

    expect((await table.readScope([join(root, GLOBAL_DIR)])).records.map(r => r.record.id)).toEqual(['mem_a'])
    const miss = await executeSearch({ query: '完全不相干的词' }, fakeExec(), { store, registry, host: { contextOf: async () => ({ workspacePath: undefined, session: { id: 's', lastSeq: 0 } }) } })
    expect(miss).toMatchObject({ hits: [] })
    expect(loads).toBe(0)
    expect(existsSync(lockDir())).toBe(false)

    await store.create(record({ id: 'mem_b', name: '乙' }))
    expect(loads).toBe(1)
    expect(await readdir(lockDir())).toEqual(['write-lock.sqlite'])
  })

  it('RL-04 边界：有命中的检索要计召回（写侧表），这一步进锁', async () => {
    let loads = 0
    const { lock } = realLock({ loadSqlite: () => { loads++; return process.getBuiltinModule('node:sqlite') } })
    const { store } = wired(lock)
    await mkdir(join(root, GLOBAL_DIR), { recursive: true })
    await writeFile(join(root, GLOBAL_DIR, 'a.md'), encodeRecord(record({ id: 'mem_a', name: '甲', content: '用 pnpm' }), {}), 'utf8')
    const hit = await executeSearch({ query: 'pnpm' }, fakeExec(), { store, registry, host: { contextOf: async () => ({ workspacePath: undefined, session: { id: 's', lastSeq: 0 } }) } })
    expect(hit).toMatchObject({ hits: [{ id: 'mem_a' }] })
    expect(loads).toBe(1)
  })
})

describe('RL-16 同一把锁：文件表在锁内写侧表按计数嵌套', () => {
  it('RL-16 会写召回统计的文件表写入（新建、改易变字段、彻底删除）不推进计时器就完成', async () => {
    const { lock, timers } = realLock()
    const { table, store, sidecar } = wired(lock)
    const created = store.create(record({ id: 'mem_a', name: '甲' }))
    expect(await Promise.race([created.then(() => 'done'), timers.scheduled().then(() => 'waited')])).toBe('done')
    await store.markRecalled(['mem_a'], 5)
    const updated = table.update('mem_a', {}, r => ({ ...r, recallCount: r.recallCount + 1, lastRecalledAt: 9 }))
    expect(await Promise.race([updated.then(() => 'done'), timers.scheduled().then(() => 'waited')])).toBe('done')
    expect((await sidecar.recallStats.get('mem_a'))?.recallCount).toBe(2)
    const deleted = table.delete('mem_a', {})
    expect(await Promise.race([deleted, timers.scheduled().then(() => 'waited')])).toBe(true)
    expect(await sidecar.recallStats.get('mem_a')).toBeUndefined()
    expect(timers.fired + timers.pending).toBe(0)
  })

  it('RL-16 对照：文件表和侧表各用一把锁时，嵌套写侧表要等自己，等满上限报 root-lock-timeout', async () => {
    const fileLock = realLock()
    const sideLock = realLock()
    const sidecar = new SidecarStore({ root, schemas, lock: sideLock.lock, log: quietLog })
    const table = new FileTable({ root, lock: fileLock.lock, stats: sidecar.recallStats, log: quietLog })
    const created = table.create(record({ id: 'mem_a', name: '甲' }))
    await sideLock.timers.scheduled()
    await fireUntilSettled(created, sideLock.timers)
    await expect(created).rejects.toBeInstanceOf(RootLockTimeoutError)
  })
})

describe('RL-19 认领：先认领、再进锁', () => {
  const NOW = 1_000_000

  it('RL-19 先到的一方正持锁跑裁决段：后到的一方立即拿到 { isClaimed: false }，不等写锁；先到的一方整段在锁内', async () => {
    const a = realLock()
    const b = realLock()
    const first = wired(a.lock, () => NOW).decisions
    const second = wired(b.lock, () => NOW).decisions
    // 两边都已过了侧表的旧 KV 导入屏障（每个实例第一次访问侧表时进一次写锁，常态下启动时就过了）
    await first.list()
    await second.list()
    const inSegment = deferred()
    const leave = deferred()
    const firstRun = first.withClaim('pd_x', async () => {
      inSegment.resolve()
      await leave.promise
      return 'first'
    })
    await inSegment.promise

    // 先到的一方此刻持着写锁：另一个实例要等
    const probe = realLock()
    const probed = probe.lock.run(async () => 'probe')
    await probe.timers.scheduled()

    expect(await second.withClaim('pd_x', async () => 'second')).toEqual({ isClaimed: false })
    expect(b.timers.fired + b.timers.pending).toBe(0)

    leave.resolve()
    expect(await firstRun).toEqual({ isClaimed: true, value: 'first' })
    await fireUntilSettled(probed, probe.timers)
    expect(await probed).toBe('probe')
    // 认领已放掉：后到的一方这回拿得到
    expect(await second.withClaim('pd_x', async () => 'second')).toEqual({ isClaimed: true, value: 'second' })
  })

  it('RL-19 认领文件已超时（残留）：后到的一方进写锁清掉再拿到认领，用完放掉', async () => {
    const b = realLock()
    const second = wired(b.lock, () => NOW).decisions
    const claimPath = join(root, STATE_DIR, 'pending', 'pd_x.claim')
    await mkdir(join(root, STATE_DIR, 'pending'), { recursive: true })
    await writeFile(claimPath, JSON.stringify({ pid: process.pid, at: NOW - 61_000, id: 'stale' }))
    await second.list() // 先过导入屏障，下面等锁的只会是清残留

    // 写锁正被别处持有：清残留要等锁，说明清理走的是写锁
    const other = await holdElsewhere()
    const claimed = second.withClaim('pd_x', async () => JSON.parse(await readFile(claimPath, 'utf8')) as { id: string })
    await b.timers.scheduled()
    expect(JSON.parse(await readFile(claimPath, 'utf8'))).toMatchObject({ id: 'stale' })
    await other.release()
    await fireUntilSettled(claimed, b.timers)
    const result = await claimed
    expect(result.isClaimed).toBe(true)
    expect(result.isClaimed && result.value.id).not.toBe('stale')
    expect(existsSync(claimPath)).toBe(false)
  })

  it('RL-19 裁决段做完、另一实例紧接着要锁：认领在原来那段持锁里放掉，不再争锁，结果照常返回', async () => {
    const a = realLock()
    const gated = gateLock(a.lock)
    const { decisions } = wired(gated.lock, () => NOW)
    const claimPath = join(root, STATE_DIR, 'pending', 'pd_x.claim')
    await decisions.list() // 先过导入屏障
    const other = realLock()
    const otherHeld = deferred()
    const leaveOther = deferred()
    let otherRun: Promise<void> | undefined
    const claimed = decisions.withClaim('pd_x', async () => {
      // 裁决段的写入做完；此后这把锁再有 run 到来，先让另一实例去拿写锁（拿到就占着）
      gated.beforeNextRun(async () => {
        otherRun = other.lock.run(async () => { otherHeld.resolve(); await leaveOther.promise })
        await Promise.race([otherHeld.promise, other.timers.scheduled()])
      })
      return 'done'
    })
    await fireUntilSettled(claimed, a.timers)
    leaveOther.resolve()
    if (otherRun !== undefined) await fireUntilSettled(otherRun, other.timers)
    expect(await claimed).toEqual({ isClaimed: true, value: 'done' })
    expect(a.timers.fired).toBe(0)
    expect(existsSync(claimPath)).toBe(false)
  })

  it('RL-19 第一次拿锁就超时：fn 不执行，单独清理认领；清理也拿不到锁时，抛出的仍是第一次的 root-lock-timeout', async () => {
    const a = realLock()
    const errors: unknown[] = []
    const recording: RootLock = { run: fn => a.lock.run(fn).catch((err: unknown) => { errors.push(err); throw err }) }
    const { decisions } = wired(recording, () => NOW)
    await decisions.list() // 先过导入屏障
    const other = await holdElsewhere()
    let isRun = false
    const claimed = decisions.withClaim('pd_x', async () => { isRun = true })
    await fireUntilSettled(claimed, a.timers)
    expect(errors).toHaveLength(2) // 进裁决段、清理认领各超时一次
    expect(errors[0]).toBeInstanceOf(RootLockTimeoutError)
    await expect(claimed).rejects.toBe(errors[0])
    expect(isRun).toBe(false)
    await other.release()
  })

  it('RL-19 第一次拿锁就超时、清理时锁已放开：认领清掉，抛第一次的 root-lock-timeout', async () => {
    const a = realLock()
    const { decisions } = wired(a.lock, () => NOW)
    const claimPath = join(root, STATE_DIR, 'pending', 'pd_x.claim')
    await decisions.list() // 先过导入屏障
    const other = await holdElsewhere()
    const claimed = decisions.withClaim('pd_x', async () => 'never')
    while (a.timers.elapsed < 10_000) {
      await a.timers.scheduled()
      a.timers.fire()
    }
    await Promise.race([claimed.then(() => {}, () => {}), a.timers.scheduled()])
    await other.release()
    await fireUntilSettled(claimed, a.timers)
    await expect(claimed).rejects.toBeInstanceOf(RootLockTimeoutError)
    expect(existsSync(claimPath)).toBe(false)
    expect(await decisions.withClaim('pd_x', async () => 'again')).toEqual({ isClaimed: true, value: 'again' })
  })
})

/** 拿锁之前插一步的写锁：beforeNextRun 登记的动作在下一次 run 到来、还没去拿锁时跑一次。 */
function gateLock(inner: RootLock) {
  let pending: (() => Promise<void>) | undefined
  const lock: RootLock = {
    async run(fn) {
      const hook = pending
      pending = undefined
      if (hook !== undefined) await hook()
      return inner.run(fn)
    },
  }
  return { lock, beforeNextRun: (hook: () => Promise<void>) => { pending = hook } }
}

/** 进锁后先停住的写锁：每次 run 拿到锁就记一次到达、等测试放行，再跑写入本身。 */
function pausingLock(inner: RootLock) {
  const arrivals: Array<() => void> = []
  let onArrive: (() => void) | undefined
  const lock: RootLock = {
    run: fn => inner.run(async () => {
      const gate = deferred()
      arrivals.push(gate.resolve)
      onArrive?.()
      await gate.promise
      return fn()
    }),
  }
  const arrived = async (n: number) => {
    while (arrivals.length < n) await new Promise<void>(resolve => { onArrive = resolve })
  }
  return { lock, arrivals, arrived }
}

/** 写锁此刻被占：另起一个实例去拿，它排进了退避等待。返回它的结果，放到最后再推计时器收尾。 */
async function expectLockBusy() {
  const probe = realLock()
  const probed = probe.lock.run(async () => 'probe')
  await probe.timers.scheduled()
  return async () => {
    await fireUntilSettled(probed, probe.timers)
    expect(await probed).toBe('probe')
  }
}

describe('RL-15 热重载：旧实例的迟到写入与新实例互斥', () => {
  it('RL-15 旧实例文件表链里还有排队的写入，新实例同时写入：每次写入都在写锁内，新实例要等，结果和串行一致', async () => {
    const paused = pausingLock(createRootLock({ root, log: quietLog }))
    const old = new FileTable({ root, lock: paused.lock, stats: new InMemoryKvTable<RecallStats>(), log: quietLog })
    const x = old.create(record({ id: 'mem_x', name: '旧甲' }))
    const y = old.create(record({ id: 'mem_y', name: '旧乙' })) // 排在旧实例的链里，还没进锁
    await paused.arrived(1)
    const settleProbes = [await expectLockBusy()]

    const fresh = realLock()
    const z = new FileTable({ root, lock: fresh.lock, stats: new InMemoryKvTable<RecallStats>(), log: quietLog }).create(record({ id: 'mem_z', name: '新丙' }))
    await fresh.timers.scheduled()
    expect(paused.arrivals).toHaveLength(1)

    paused.arrivals[0]!()
    await x
    await paused.arrived(2)
    settleProbes.push(await expectLockBusy())
    paused.arrivals[1]!()
    await y

    await fireUntilSettled(z, fresh.timers)
    await z
    for (const settle of settleProbes) await settle()

    const table = new FileTable({ root, stats: new InMemoryKvTable<RecallStats>() })
    for (const [id, name] of [['mem_x', '旧甲'], ['mem_y', '旧乙'], ['mem_z', '新丙']] as const) {
      expect((await table.locate(id, {}))?.record.name, id).toBe(name)
    }
    const index = await readFile(join(root, GLOBAL_DIR, INDEX_FILE), 'utf8')
    for (const id of ['mem_x', 'mem_y', 'mem_z']) expect(index).toContain(id)
    expect((await readdir(join(root, GLOBAL_DIR))).filter(n => n.includes('.tmp-'))).toEqual([])
  })
})

describe('RL-08 两个进程同名 create', () => {
  it('RL-08 两个进程各 50 次在 global/ 里 create 同名记忆：每条都在、文件名按撞名规则、没有残留临时文件', async () => {
    const [a, b] = await Promise.all([startWorker(WRITE_WORKER, [root, 'a']), startWorker(WRITE_WORKER, [root, 'b'])])
    a.send('create 50')
    b.send('create 50')
    expect(await Promise.all([a.nextLine(), b.nextLine()])).toEqual(['created', 'created'])

    const dir = join(root, GLOBAL_DIR)
    const names = await readdir(dir)
    expect(names.filter(n => n.includes('.tmp-'))).toEqual([])
    const base = slugifyName('抢名')
    const table = new FileTable({ root, stats: new InMemoryKvTable<RecallStats>() })
    const ids = ['a', 'b'].flatMap(tag => Array.from({ length: 50 }, (_, i) => `mem_${tag}${String(i).padStart(5, '0')}`))
    const fileNames: string[] = []
    for (const id of ids) {
      const located = await table.locate(id, {})
      expect(located?.record.id, id).toBe(id)
      const name = located!.filePath.slice(dir.length + 1)
      expect([`${base}.md`, `${base}-${id.slice(-6)}.md`], id).toContain(name)
      fileNames.push(name)
    }
    expect(fileNames.filter(n => n === `${base}.md`)).toHaveLength(1)
    expect(new Set(fileNames).size).toBe(100)
    const index = await readFile(join(dir, INDEX_FILE), 'utf8')
    for (const id of ids) expect(index).toContain(id)
  }, 30_000)
})

describe('RL-17 一个进程写个不停，另一个进程照样写得进去', () => {
  it('RL-17 另一进程持锁不放：本进程的写入等满上限报 root-lock-timeout，盘上没有半截写入；放开后重试成功', async () => {
    const holder = await startWorker(LOCK_WORKER, [root, signals, 'h', 'pause'])
    holder.send('run')
    await waitForSignal(signals, 'h.1.held')
    const { lock, timers } = realLock()
    const { store } = wired(lock)
    const own = record({ id: 'mem_late', name: '迟到' })
    const first = store.create(own)
    await fireUntilSettled(first, timers)
    await expect(first).rejects.toBeInstanceOf(RootLockTimeoutError)
    expect(timers.elapsed).toBe(10_000)
    expect(await readdir(join(root, GLOBAL_DIR)).catch(() => [])).toEqual([])

    await signal(signals, 'h.1.go')
    expect(await holder.nextLine()).toBe('ran 1')
    await store.create(own)
    expect((await store.get('mem_late'))?.name).toBe('迟到')
  }, 30_000)

  it('RL-17 一个进程不停改写，另一进程的每次写入要么拿到锁、要么超时且无半截写入后重试成功；等待分布见日志', async () => {
    const soakMs = Number(process.env.PM_RL17_SOAK_MS ?? 0)
    const [hammer, prober] = await Promise.all([startWorker(WRITE_WORKER, [root, 'h']), startWorker(WRITE_WORKER, [root, 'p'])])
    hammer.send('hammer')
    prober.send(soakMs > 0 ? `soak ${soakMs}` : 'probe 15')
    const report = JSON.parse(await prober.nextLine()) as { waitsMs: number[]; timeouts: number; partials: string[] }
    hammer.send('stop')
    const hammered = JSON.parse(await hammer.nextLine()) as { count: number; timeouts: number; maxWaitMs: number }

    expect(report.partials).toEqual([])
    const table = new FileTable({ root, stats: new InMemoryKvTable<RecallStats>() })
    const written = report.waitsMs.length
    for (let i = 0; i < written; i++) expect(await table.locate(`mem_p${String(i).padStart(5, '0')}`, {}), String(i)).toBeDefined()
    expect((await table.locate('mem_h_hot', {}))?.record.content).toBe(String(hammered.count))
    expect((await readdir(join(root, GLOBAL_DIR))).filter(n => n.includes('.tmp-'))).toEqual([])
    if (soakMs > 0) {
      const sorted = [...report.waitsMs].sort((x, y) => x - y)
      const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!.toFixed(1)
      console.info(`RL-17 等待分布（${soakMs} ms）：写入方写入 ${written} 次、超时 ${report.timeouts} 次，` +
        `p50 ${at(0.5)} ms，p90 ${at(0.9)} ms，p99 ${at(0.99)} ms，最长 ${sorted.at(-1)!.toFixed(1)} ms；` +
        `改写方改写 ${hammered.count} 次、超时 ${hammered.timeouts} 次，最长等待 ${hammered.maxWaitMs.toFixed(1)} ms`)
    }
  }, 120_000)
})

describe('RL-11 两个进程交错写同一个全局视图', () => {
  it('RL-11 早收集的一方等锁时，晚收集的一方先写完：盘上是晚收集那份的内容；两边各记的会话归属都在', async () => {
    const T0 = 1_763_164_800_000
    const { store, decisions, sidecar } = wired(createRootLock({ root, log: quietLog }))
    await store.create(record({ id: 'mem_old', name: '旧的', content: '用 pnpm' }))
    // a 晚收集，视图写入的第 1、2 次 run 都停在屏障；b 早收集，从不停
    const [a, b] = await Promise.all([
      startWorker(VIEW_WORKER, [root, signals, 'a', String(T0 + 10), '1,2']),
      startWorker(VIEW_WORKER, [root, signals, 'b', String(T0), '-']),
    ])

    // b 先收集（只有 mem_old），收集完先停住；随后盘上多了 mem_new，a 再收集（两条都有）并拿到锁停住
    b.send('library')
    await waitForSignal(signals, 'b.collect.1.done')
    await store.create(record({ id: 'mem_new', name: '新的', content: '用 npm' }))
    a.send('library')
    await waitForSignal(signals, 'a.collect.1.done')
    await signal(signals, 'a.collect.1.go')
    await waitForSignal(signals, 'a.1.held')
    // b 带着早收集的视图去写，到了锁前；a 放行
    await signal(signals, 'b.collect.1.go')
    await waitForSignal(signals, 'b.1.arrived')
    await signal(signals, 'a.1.go')
    expect(await Promise.all([a.nextLine(), b.nextLine()])).toEqual(['wrote library', 'wrote library'])

    const late = await collectGlobalViews({ store, decisions, cache: sidecar.scanCache, registry, memoryRoot: root, now: () => T0 + 10 })
    const onDisk = JSON.parse(await readFile(join(root, GUI_VIEW_DIR, GUI_VIEW_FILES.library), 'utf8')) as unknown
    expect(onDisk).toEqual(JSON.parse(JSON.stringify(late.library)))
    expect(JSON.stringify(onDisk)).toContain('mem_new')

    // 会话归属：a 持锁停住时 b 来记另一条，b 到了锁前再放行 a
    a.send('workspace /w/a')
    await waitForSignal(signals, 'a.2.held')
    b.send('workspace /w/b')
    await waitForSignal(signals, 'b.2.arrived')
    await signal(signals, 'a.2.go')
    expect((await Promise.all([a.nextLine(), b.nextLine()])).sort()).toEqual(['wrote workspace /w/a', 'wrote workspace /w/b'])
    const map = JSON.parse(await readFile(join(root, GUI_VIEW_DIR, GUI_WORKSPACE_MAP_FILE), 'utf8')) as { cwds: Record<string, string> }
    expect(map.cwds).toEqual({ '/w/a': '/w/a', '/w/b': '/w/b' })
    expect((await readdir(join(root, GUI_VIEW_DIR))).filter(n => n.includes('.tmp-'))).toEqual([])
    expect(a.stderr() + b.stderr()).toBe('')
  }, 30_000)
})
