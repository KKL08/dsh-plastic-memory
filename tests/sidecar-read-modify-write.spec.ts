import { sidecarSchemas } from './helpers/sidecar-schemas.ts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FileTable } from '../src/storage/file-table.ts'
import { SidecarStore } from '../src/storage/sidecar.ts'
import { createRootLock } from '../src/storage/root-lock.ts'
import { STATE_DIR } from '../src/storage/paths.ts'
import { MemoryStore } from '../src/store.ts'
import { SnapshotStore } from '../src/governance/snapshots.ts'
import { PendingDecisionsStore } from '../src/governance/decisions.ts'
import { type MemorySnapshot } from '../src/governance/schema.ts'
import { executeConfirm } from '../src/tools/confirm.ts'
import { goneCopies } from '../src/tools/workspace-gate.ts'
import type { RootLock } from '../src/root-lock.ts'
import { record } from './helpers/record.ts'
import { FAKE_SECRET } from './helpers/secrets.ts'
import { noInstructions } from './helpers/instructions.ts'
import { signal, waitForSignal } from './helpers/signal-files.ts'
import { spawnWorker, type LineWorker } from './helpers/spawn-worker.ts'

// 侧表读改写进写锁之后的外部行为：快照脱敏、清除，召回计数。两个真子进程，各自一把真写锁，
// 写锁外面套屏障装饰器固定交错：先到的一方拿到锁、停在屏障上，另一方读完、到达锁前，再放先到的一方走。不靠 sleep。

const WORKER = fileURLToPath(new URL('./helpers/sidecar-rmw-worker.ts', import.meta.url))
const schemas = sidecarSchemas
const quietLog = { info() {}, warn() {}, error() {} }
const SECRET = FAKE_SECRET.sk

let root: string
let signals: string
let workers: LineWorker[] = []
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pm-sidecar-rmw-'))
  signals = await mkdtemp(join(tmpdir(), 'pm-sidecar-rmw-signals-'))
})
afterEach(async () => {
  await Promise.all(workers.splice(0).map(w => w.kill()))
  await rm(root, { recursive: true, force: true })
  await rm(signals, { recursive: true, force: true })
})

/** 本进程这边按接线层搭一套（布置数据、读结果用），写锁是另一个实例，与子进程互斥。 */
function wired(lock: RootLock = createRootLock({ root, log: quietLog })) {
  const sidecar = new SidecarStore({ root, schemas, lock, log: quietLog })
  const store = new MemoryStore(new FileTable({ root, lock, stats: sidecar.recallStats, log: quietLog }), quietLog, sidecar.recallStats)
  const snapshots = new SnapshotStore(sidecar.snapshots, { findGone: goneCopies(store) })
  const decisions = new PendingDecisionsStore(sidecar.pending, lock)
  return { sidecar, store, snapshots, decisions }
}

async function startWorkers(): Promise<[LineWorker, LineWorker]> {
  const started = (['a', 'b'] as const).map(tag => {
    const w = spawnWorker(WORKER, [root, signals, tag])
    workers.push(w)
    return w
  })
  for (const w of started) expect(await w.nextLine()).toBe('ready')
  return started as [LineWorker, LineWorker]
}

async function ask(w: LineWorker, line: string): Promise<string> {
  w.send(line)
  return w.nextLine()
}

/**
 * 固定交错：first 的第一次 run 拿到锁后停住；second 发起操作、到达写锁；再放 first 走。返回两边的回复（各一行）。
 * 屏障只停 first 被 arm 的那一次 run，之后的 run（含嵌套）照常。
 */
async function interleave(first: { w: LineWorker; tag: string; cmd: string }, second: { w: LineWorker; tag: string; cmd: string }): Promise<[string, string]> {
  const n = Number((await ask(first.w, 'arm')).split(' ')[1])
  const m = Number((await ask(second.w, 'peek')).split(' ')[1])
  first.w.send(first.cmd)
  await waitForSignal(signals, `${first.tag}.${n}.held`)
  second.w.send(second.cmd)
  await waitForSignal(signals, `${second.tag}.${m}.arrived`)
  await signal(signals, `${first.tag}.${n}.go`)
  return [await first.w.nextLine(), await second.w.nextLine()]
}

async function snapshotFiles(): Promise<string[]> {
  const dir = join(root, STATE_DIR, 'snapshots')
  const names = (await readdir(dir).catch(() => [] as string[])).filter(n => n.endsWith('.json'))
  return Promise.all(names.map(n => readFile(join(dir, n), 'utf8')))
}

describe('RL-09 两个进程同时记召回', () => {
  it('RL-09 屏障下 B 在 A 持锁时发起：同一条的召回次数是两次之和', async () => {
    const [a, b] = await startWorkers()
    expect(await interleave({ w: a, tag: 'a', cmd: 'recall mem_x 1' }, { w: b, tag: 'b', cmd: 'recall mem_x 1' })).toEqual(['recalled', 'recalled'])
    expect((await wired().sidecar.recallStats.get('mem_x'))?.recallCount).toBe(2)
  }, 30_000)

  it('RL-09 不加屏障，两个进程各记 N 轮：总数 2N', async () => {
    const N = 30
    const [a, b] = await startWorkers()
    a.send(`recall mem_y ${N}`)
    b.send(`recall mem_y ${N}`)
    expect(await Promise.all([a.nextLine(), b.nextLine()])).toEqual(['recalled', 'recalled'])
    expect((await wired().sidecar.recallStats.get('mem_y'))?.recallCount).toBe(2 * N)
  }, 30_000)
})

describe('RL-18 两个进程改写同一份快照里的不同条目', () => {
  // 不给 findGone：这几条记录不在盘上，拍照时的复核会把它们当成已删除、先行脱敏
  const seed = async (ids: string[]): Promise<MemorySnapshot> => new SnapshotStore(wired().sidecar.snapshots).capture({
    operation: 'manual', description: '共处一份',
    records: ids.map(id => record({ id, name: `名 ${id}`, content: `${id} 的令牌 ${SECRET}` })),
  }, Date.now())
  const at = async (id: string) => (await wired().snapshots.get(id))!.data

  it('RL-18 A、B 各脱敏其中一条（A 先拿锁、B 读完再到锁）：两条都已脱敏，没有明文', async () => {
    const snap = await seed(['mem_x', 'mem_y'])
    const [a, b] = await startWorkers()
    expect(await interleave({ w: a, tag: 'a', cmd: 'redact mem_x' }, { w: b, tag: 'b', cmd: 'redact mem_y' })).toEqual(['redacted', 'redacted'])
    expect((await at(snap.id)).map(r => [r.id, r.redacted])).toEqual([['mem_x', true], ['mem_y', true]])
    for (const text of await snapshotFiles()) expect(text).not.toContain(SECRET)
  }, 30_000)

  it('RL-18 清除先拿锁、脱敏读完再到锁：被清除的条目不回来，被脱敏的不变回明文', async () => {
    const snap = await seed(['mem_x', 'mem_y', 'mem_z'])
    const [a, b] = await startWorkers()
    expect(await interleave({ w: a, tag: 'a', cmd: 'purge mem_x' }, { w: b, tag: 'b', cmd: 'redact mem_y' })).toEqual(['purged', 'redacted'])
    const data = await at(snap.id)
    expect(data.map(r => [r.id, r.redacted])).toEqual([['mem_y', true], ['mem_z', undefined]])
    expect((await wired().snapshots.get(snap.id))!.memoryIds).toEqual(['mem_y', 'mem_z'])
  }, 30_000)

  it('RL-18 脱敏先拿锁、清除读完再到锁：被脱敏的不变回明文，被清除的条目不回来', async () => {
    const snap = await seed(['mem_x', 'mem_y', 'mem_z'])
    const [a, b] = await startWorkers()
    expect(await interleave({ w: a, tag: 'a', cmd: 'redact mem_y' }, { w: b, tag: 'b', cmd: 'purge mem_x' })).toEqual(['redacted', 'purged'])
    const data = await at(snap.id)
    expect(data.map(r => [r.id, r.redacted])).toEqual([['mem_y', true], ['mem_z', undefined]])
    expect((await wired().snapshots.get(snap.id))!.memoryIds).toEqual(['mem_y', 'mem_z'])
  }, 30_000)
})

describe('RL-10 裁决冲突（败方含高危密钥）与改写败方交错', () => {
  it('RL-10 多轮交错：B 先写完则 A 的快照里有 B 的版本，A 先裁决完则 B 拿到 not-found；所有快照里都没有明文', async () => {
    const [a, b] = await startWorkers()
    const ROUNDS = 4
    for (let k = 0; k < ROUNDS; k++) {
      const isUpdateFirst = k % 2 === 0
      const local = wired()
      const winner = record({ id: `mem_w${k}`, name: `保留方 ${k}`, content: `第 ${k} 轮保留的做法` })
      const loser = record({ id: `mem_l${k}`, name: `败方 ${k}`, content: `第 ${k} 轮的令牌 ${SECRET}` })
      await local.store.create(winner)
      await local.store.create(loser)
      // 败方的旧版本早先进过一份快照：裁决要把它脱敏
      await local.snapshots.capture({ operation: 'manual', description: `第 ${k} 轮之前`, records: [winner, loser] }, Date.now())
      const { entry } = await local.decisions.upsert({ memoryIds: [winner.id, loser.id], summary: `第 ${k} 轮`, fingerprint: `f${k}` }, Date.now())

      const resolve = `resolve ${entry.id} keep-left`
      const update = `update ${loser.id} B版-${k}`
      const [updated, resolved] = isUpdateFirst
        ? await interleave({ w: b, tag: 'b', cmd: update }, { w: a, tag: 'a', cmd: resolve })
        : (await interleave({ w: a, tag: 'a', cmd: resolve }, { w: b, tag: 'b', cmd: update })).reverse() as [string, string]
      expect(JSON.parse(resolved), `第 ${k} 轮`).toEqual({ kind: 'resolved', isHardDeleted: true })
      expect(updated, `第 ${k} 轮`).toBe(isUpdateFirst ? 'updated' : 'not-found')

      const preResolve = (await local.snapshots.list()).filter(s => s.operation === 'pre-resolve' && s.memoryIds.includes(loser.id))
      expect(preResolve, `第 ${k} 轮`).toHaveLength(1)
      const captured = preResolve[0]!.data.find(r => r.id === loser.id)!
      expect(captured.redacted).toBe(true)
      expect(captured.name, `第 ${k} 轮`).toBe(isUpdateFirst ? `B版-${k}` : `败方 ${k}`)
      expect(await local.store.get(loser.id)).toBeUndefined()
    }
    const texts = await snapshotFiles()
    // 平移时钟只作用在本进程：子进程按真实时间拍的快照在这边看是三年前的，下一轮拍快照时随过期清理删掉，数量不作数
    if (process.env.PM_SHIFT_CLOCK !== '1') expect(texts.length).toBeGreaterThanOrEqual(2 * ROUNDS)
    for (const text of texts) expect(text).not.toContain(SECRET)
  }, 60_000)
})

// RL-13 是测量：一千份快照下裁决败方含高危密钥的冲突，整段持锁多久。默认跳过，PM_RL13=1 开启，结果打到日志。
describe.skipIf(process.env.PM_RL13 !== '1')('RL-13 裁决段持锁时长', () => {
  /** 量持锁时长的写锁：同一实例里最外层 run 从拿到锁到放开算一段。 */
  function timedLock(inner: RootLock) {
    const heldMs: number[] = []
    let depth = 0
    let start = 0
    const lock: RootLock = {
      run: fn => inner.run(async () => {
        if (depth++ === 0) start = performance.now()
        try {
          return await fn()
        } finally {
          if (--depth === 0) heldMs.push(performance.now() - start)
        }
      }),
    }
    return { lock, heldMs }
  }

  it.each([
    ['一千份快照都含败方（最坏）', 1000],
    ['一千份快照里十份含败方', 10],
  ])('RL-13 %s：记录整段持锁时长', async (label, withLoser) => {
    const seeding = wired()
    const winner = record({ id: 'mem_win', name: '保留方', content: '保留的做法' })
    const loser = record({ id: 'mem_lose', name: '败方', content: `令牌 ${SECRET}` })
    await seeding.store.create(winner)
    await seeding.store.create(loser)
    const other = record({ id: 'mem_other', name: '别的', content: '无关' })
    const now = Date.now()
    for (let i = 0; i < 1000; i++) {
      const records = i < withLoser ? [loser, other] : [other]
      await seeding.sidecar.snapshots.put(`snap_${i}`, { id: `snap_${i}`, createdAt: now, operation: 'manual', description: `第 ${i} 份`, memoryIds: records.map(r => r.id), data: records })
    }
    const { entry } = await seeding.decisions.upsert({ memoryIds: [winner.id, loser.id], summary: '测量', fingerprint: 'f' }, now)

    const timed = timedLock(createRootLock({ root, log: quietLog }))
    const deps = wired(timed.lock)
    await deps.snapshots.list() // 先过导入屏障
    timed.heldMs.length = 0
    const startedAt = performance.now()
    const r = await executeConfirm({ action: 'resolve', decisionId: entry.id, verdict: 'keep-left' }, { workspacePath: undefined },
      { ...deps, log: quietLog, instructions: noInstructions })
    const totalMs = performance.now() - startedAt
    expect(r).toMatchObject({ kind: 'resolved', isHardDeleted: true })
    for (const text of await snapshotFiles()) expect(text).not.toContain(SECRET)
    const longest = Math.max(...timed.heldMs)
    console.info(`RL-13 ${label}：裁决共 ${totalMs.toFixed(0)} ms，最长一段持锁 ${longest.toFixed(0)} ms，持锁 ${timed.heldMs.length} 段`)
  }, 120_000)
})
