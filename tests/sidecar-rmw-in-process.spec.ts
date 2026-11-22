import { sidecarSchemas } from './helpers/sidecar-schemas.ts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileTable } from '../src/storage/file-table.ts'
import { SidecarStore } from '../src/storage/sidecar.ts'
import { createRootLock } from '../src/storage/root-lock.ts'
import { STATE_DIR } from '../src/storage/paths.ts'
import { MemoryStore } from '../src/store.ts'
import { SnapshotStore } from '../src/governance/snapshots.ts'
import { PendingDecisionsStore } from '../src/governance/decisions.ts'
import { type MemorySnapshot } from '../src/governance/schema.ts'
import { executeForget } from '../src/tools/forget.ts'
import { goneCopies } from '../src/tools/workspace-gate.ts'
import type { RootLock } from '../src/root-lock.ts'
import { record } from './helpers/record.ts'
import { FAKE_SECRET } from './helpers/secrets.ts'

// 同一进程里的侧表读改写：快照的脱敏、清除、拍后复核与召回计数。快照存储和召回统计自己不再排队，
// 每份快照、整张召回表的读改写都是侧表的条件写（进程内链 + 写锁内重读再改）。全部用真实目录。
// fs 是进程边界：MI-03 给 writeFile 套一层闸门，让一次快照写回停在「已读、未写」处。

const { writeGate } = vi.hoisted(() => ({
  writeGate: { current: undefined as { match: (path: string) => boolean; skip: number; entered: () => void; release: Promise<void> } | undefined },
}))
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const writeFile = vi.fn(async (...args: Parameters<typeof actual.writeFile>) => {
    const g = writeGate.current
    if (g !== undefined && g.match(String(args[0])) && g.skip-- === 0) {
      writeGate.current = undefined
      g.entered()
      await g.release
    }
    return actual.writeFile(...args)
  })
  return { ...actual, writeFile }
})

const schemas = sidecarSchemas
const quietLog = { info() {}, warn() {}, error() {} }
const SECRET = FAKE_SECRET.sk

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'pm-sidecar-rmw-local-')) })
afterEach(async () => {
  writeGate.current = undefined
  await rm(root, { recursive: true, force: true })
})

/** 按接线层搭一套：一个侧表实例、一把写锁，快照落盘后按副本复核。 */
function wired(lock: RootLock = createRootLock({ root, log: quietLog })) {
  const sidecar = new SidecarStore({ root, schemas, lock, log: quietLog })
  const store = new MemoryStore(new FileTable({ root, lock, stats: sidecar.recallStats, log: quietLog }), quietLog, sidecar.recallStats)
  const snapshots = new SnapshotStore(sidecar.snapshots, { findGone: goneCopies(store) })
  const decisions = new PendingDecisionsStore(sidecar.pending, lock)
  return { sidecar, store, snapshots, decisions }
}

/** 写锁不可用（node:sqlite 加载不到）的一套：只剩本实例的进程内链。 */
const unlocked = () => wired(createRootLock({ root, log: quietLog, loadSqlite: () => undefined }))

async function snapshotTexts(): Promise<string[]> {
  const dir = join(root, STATE_DIR, 'snapshots')
  const names = (await readdir(dir).catch(() => [] as string[])).filter(n => n.endsWith('.json'))
  return Promise.all(names.map(n => readFile(join(dir, n), 'utf8')))
}

describe('MI-01 同一进程里并发的脱敏与清除（同一份快照、不同记录）', () => {
  /** 直接放进侧表，不经 capture：这几条不在盘上，拍后复核会先把它们脱敏。 */
  async function seed(e: ReturnType<typeof wired>): Promise<MemorySnapshot> {
    const data = ['mem_x', 'mem_y', 'mem_z'].map(id => record({ id, name: `名 ${id}`, content: `${id} 的令牌 ${SECRET}` }))
    const snap: MemorySnapshot = { id: 'snap_shared', createdAt: 1, operation: 'manual', description: '共处一份', memoryIds: data.map(r => r.id), data }
    await e.sidecar.snapshots.put(snap.id, snap)
    return snap
  }

  it.each([
    ['脱敏先发起', true],
    ['清除先发起', false],
  ])('MI-01 %s：脱敏的那条不变回明文，清除的那条不回来，第三条原样', async (_label, isRedactFirst) => {
    const e = wired()
    const snap = await seed(e)
    const redact = () => e.snapshots.redact(new Set(['mem_y']))
    const purge = () => e.snapshots.purge(r => r.id === 'mem_x')
    await Promise.all(isRedactFirst ? [redact(), purge()] : [purge(), redact()])

    const after = (await e.snapshots.get(snap.id))!
    expect(after.data.map(r => [r.id, r.redacted])).toEqual([['mem_y', true], ['mem_z', undefined]])
    expect(after.memoryIds).toEqual(['mem_y', 'mem_z'])
    expect(after.data[0]!.content).not.toContain(SECRET)
    expect(after.data[1]!.content).toBe(`mem_z 的令牌 ${SECRET}`)
  })
})

describe('MI-03 写锁不可用时两个实例交错：拍后复核的写回不把别处刚脱敏的密钥盖回明文', () => {
  it('MI-03 A 的复核读到 Y 的明文后停住，B 硬删 Y（脱敏、删文件、再扫一遍）后放 A 走：这份快照里 Y 最终不是明文', async () => {
    // 两个 SidecarStore 实例各有自己的进程内链、写锁都不可用：相当于无锁退化下的两个进程
    const a = unlocked()
    const b = unlocked()
    const y = record({ id: 'mem_y', name: '部署令牌', content: `部署用 ${SECRET}` })
    await b.store.create(y)
    // X 不在盘上：A 拍完照的复核要脱敏它，于是有一次写回，写回的内容里带着此刻 Y 的明文
    const x = record({ id: 'mem_x', name: '早已删掉', content: '无关' })

    let entered!: () => void
    let release!: () => void
    const reached = new Promise<void>(resolve => { entered = resolve })
    // 快照目录里第一次写是 capture 落盘，第二次是复核的写回：停在它写临时文件之前
    writeGate.current = {
      match: p => /[\\/]snapshots[\\/]snap_[^\\/]+\.json\.tmp-/.test(p),
      skip: 1,
      entered,
      release: new Promise(resolve => { release = resolve }),
    }
    const capturing = a.snapshots.capture({ operation: 'manual', description: 'A 的快照', records: [x, y] }, Date.now())
    await reached

    const forgot = await executeForget({ ids: ['mem_y'], reason: '含密钥' }, { workspacePath: undefined }, { store: b.store, snapshots: b.snapshots, decisions: b.decisions, log: quietLog })
    expect(forgot.hardDeleted).toEqual(['mem_y'])
    release()
    const snap = await capturing

    const settled = (await a.snapshots.get(snap.id))!
    expect(settled.data.map(r => [r.id, r.redacted])).toEqual([['mem_x', true], ['mem_y', true]])
    expect(await b.store.get('mem_y')).toBeUndefined()
    for (const text of await snapshotTexts()) expect(text).not.toContain(SECRET)
  })
})

describe('MI-04 同一进程里并发记召回', () => {
  it('MI-04 两次 markRecalled 同时发起：每条的次数是两次之和', async () => {
    const e = wired()
    for (const id of ['mem_a', 'mem_b']) await e.store.create(record({ id, name: `名 ${id}` }))
    await Promise.all([e.store.markRecalled(['mem_a', 'mem_b'], 10), e.store.markRecalled(['mem_a'], 20)])
    const counts = (await e.sidecar.recallStats.list()).map(([id, s]) => [id, s.recallCount]).sort()
    expect(counts).toEqual([['mem_a', 2], ['mem_b', 1]])
  })
})
