import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RootLockTimeoutError } from '../src/errors.ts'
import type { RootLock } from '../src/root-lock.ts'
import { createRootLock } from '../src/storage/root-lock.ts'
import { WriteSection } from '../src/storage/write-section.ts'
import { SidecarStore } from '../src/storage/sidecar.ts'
import type { LegacyKvTables } from '../src/storage/legacy-kv-import.ts'
import { sidecarSchemas } from './helpers/sidecar-schemas.ts'
import { FileTable } from '../src/storage/file-table.ts'
import type { MemoryRecord } from '../src/record-schema.ts'
import { candidate, record } from './helpers/record.ts'
import { MemoryStore } from '../src/store.ts'
import { SnapshotStore } from '../src/governance/snapshots.ts'
import { goneCopies } from '../src/tools/workspace-gate.ts'
import { PendingDecisionsStore } from '../src/governance/decisions.ts'
import { runSavePipeline } from '../src/pipeline.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'

const registry = buildTypeRegistry({ template: 'coding', customTypes: {} })

const quiet = { info() {}, warn() {}, error() {}, debug() {} }

/** 记录跨进程锁的拿与放；fail 里放进去的错误按次序在拿锁时抛出（fn 不执行）。 */
function recordingLock() {
  const events: string[] = []
  const fail: unknown[] = []
  const lock: RootLock = {
    async run(fn) {
      const err = fail.shift()
      if (err !== undefined) throw err
      events.push('拿锁')
      try { return await fn() } finally { events.push('放锁') }
    },
  }
  return { lock, events, fail }
}

function gate() {
  let open!: () => void
  const opened = new Promise<void>(resolve => { open = resolve })
  return { open, opened }
}

/** 让已排好的回调都跑完：几轮宏任务。 */
async function settle(rounds = 5) {
  for (let i = 0; i < rounds; i++) await new Promise<void>(resolve => setImmediate(resolve))
}

describe('写入段', () => {
  it('同一进程的两个写入段不重叠：后到的等先到的走完', async () => {
    const { lock } = recordingLock()
    const section = new WriteSection(lock)
    const order: string[] = []
    const g = gate()
    const first = section.run(async () => { order.push('甲进'); await g.opened; order.push('甲出') })
    const second = section.run(async () => { order.push('乙进'); order.push('乙出') })
    await settle()
    expect(order).toEqual(['甲进'])
    g.open()
    await Promise.all([first, second])
    expect(order).toEqual(['甲进', '甲出', '乙进', '乙出'])
  })

  it('段内再进不等自己，也不再拿一次跨进程锁', async () => {
    const { lock, events } = recordingLock()
    const section = new WriteSection(lock)
    const value = await section.run(() => section.run(() => section.run(async () => 7)))
    expect(value).toBe(7)
    expect(events).toEqual(['拿锁', '放锁'])
  })

  it('段内同时发起的几次再进按调用顺序一个个来，不交错', async () => {
    const { lock } = recordingLock()
    const section = new WriteSection(lock)
    const order: string[] = []
    const g = gate()
    await section.run(async () => {
      const a = section.run(async () => { order.push('子一进'); await g.opened; order.push('子一出') })
      const b = section.run(async () => { order.push('子二进'); order.push('子二出') })
      await settle()
      expect(order).toEqual(['子一进'])
      g.open()
      await Promise.all([a, b])
    })
    expect(order).toEqual(['子一进', '子一出', '子二进', '子二出'])
  })

  it('段里发起、没等的再进：它做完这一段才算走完、才放锁，下一段不和它重叠', async () => {
    const { lock, events } = recordingLock()
    const section = new WriteSection(lock)
    const order: string[] = []
    const g = gate()
    let child: Promise<void> | undefined
    const first = section.run(async () => {
      child = section.run(async () => { order.push('子进'); await g.opened; order.push('子出') })
    })
    const second = section.run(async () => { order.push('下一段') })
    await settle()
    expect(order).toEqual(['子进'])
    expect(events).toEqual(['拿锁'])
    g.open()
    await Promise.all([first, second, child])
    expect(order).toEqual(['子进', '子出', '下一段'])
    expect(events).toEqual(['拿锁', '放锁', '拿锁', '放锁'])
  })

  it('段走完后，段里留下的回调再进要重新排队、重新拿锁，不算重入', async () => {
    const { lock, events } = recordingLock()
    const section = new WriteSection(lock)
    const order: string[] = []
    let leaked: Promise<void> | undefined
    await section.run(async () => {
      // 回调继承了这一段的异步上下文，但在段走完之后才跑
      setImmediate(() => { leaked = section.run(async () => { order.push('遗留回调') }) })
    })
    const g = gate()
    const other = section.run(async () => { order.push('另一段进'); await g.opened; order.push('另一段出') })
    await settle()
    expect(leaked).toBeDefined()
    expect(order).toEqual(['另一段进'])
    g.open()
    await Promise.all([other, leaked])
    expect(order).toEqual(['另一段进', '另一段出', '遗留回调'])
    expect(events).toEqual(['拿锁', '放锁', '拿锁', '放锁', '拿锁', '放锁'])
  })

  it('子段走完、外层段还在跑：子段里留下的回调再进算外层段的再进，外层段等它不会互相等，也不再拿锁', async () => {
    const { lock, events } = recordingLock()
    const section = new WriteSection(lock)
    const trigger = gate()
    let continuation!: Promise<string>
    const outer = section.run(async () => {
      await section.run(async () => {
        // 回调继承了子段的异步上下文，子段走完后才跑
        continuation = trigger.opened.then(() => section.run(async () => '完成'))
      })
      trigger.open()
      return await continuation
    })
    const stuck = new Promise<string>(resolve => { setTimeout(() => resolve('互相等'), 500).unref() })
    await expect(Promise.race([outer, stuck])).resolves.toBe('完成')
    expect(events).toEqual(['拿锁', '放锁'])
  })

  it('子段里留下的回调没人等：外层段等它做完才放锁，下一段不和它重叠', async () => {
    const { lock, events } = recordingLock()
    const section = new WriteSection(lock)
    const order: string[] = []
    const trigger = gate()
    const outer = section.run(async () => {
      await section.run(async () => {
        void trigger.opened.then(() => section.run(async () => { await settle(2); order.push('遗留回调') }))
      })
      trigger.open()
    })
    const next = section.run(async () => { order.push('下一段') })
    await Promise.all([outer, next])
    expect(order).toEqual(['遗留回调', '下一段'])
    expect(events).toEqual(['拿锁', '放锁', '拿锁', '放锁'])
  })

  it('一段抛错：调用方收到这个错，后面的段照常进', async () => {
    const { lock } = recordingLock()
    const section = new WriteSection(lock)
    const failed = section.run(async () => { throw new Error('写坏了') })
    const next = section.run(async () => '照常')
    await expect(failed).rejects.toThrow('写坏了')
    await expect(next).resolves.toBe('照常')
  })

  it('拿跨进程锁超时：这一段和当时排着的段一起按超时失败、fn 都不跑，只等一轮；之后新来的段照常拿锁', async () => {
    const { lock, events, fail } = recordingLock()
    fail.push(new RootLockTimeoutError(10_000))
    const section = new WriteSection(lock)
    let runs = 0
    const timedOut = section.run(async () => { runs++ })
    const queued = section.run(async () => { runs++ })
    await expect(timedOut).rejects.toBeInstanceOf(RootLockTimeoutError)
    await expect(queued).rejects.toBeInstanceOf(RootLockTimeoutError)
    expect(runs).toBe(0)
    expect(events).toEqual([])
    await expect(section.run(async () => '照常')).resolves.toBe('照常')
    expect(events).toEqual(['拿锁', '放锁'])
  })

  it('段里自己抛出的超时（不是拿锁超时）不连累排着的段', async () => {
    const { lock } = recordingLock()
    const section = new WriteSection(lock)
    const failed = section.run(async () => { throw new RootLockTimeoutError(10_000) })
    const next = section.run(async () => '照常')
    await expect(failed).rejects.toBeInstanceOf(RootLockTimeoutError)
    await expect(next).resolves.toBe('照常')
  })

  it('顶层段各拿各的跨进程锁，段与段之间放锁，别的进程有机会插进来', async () => {
    const { lock, events } = recordingLock()
    const section = new WriteSection(lock)
    await Promise.all([section.run(async () => {}), section.run(async () => {}), section.run(async () => {})])
    expect(events).toEqual(['拿锁', '放锁', '拿锁', '放锁', '拿锁', '放锁'])
  })

  it('不排队的执行（侧表的初始化屏障用）：段内等一个段外发起的它，不会互相等', async () => {
    const { lock } = recordingLock()
    const section = new WriteSection(lock)
    const g = gate()
    let unqueued: Promise<string> | undefined
    const held = section.run(async () => {
      await g.opened
      return unqueued!
    })
    unqueued = section.runUnqueued(async () => '屏障完成')
    g.open()
    await expect(held).resolves.toBe('屏障完成')
  })

  it('不排队的执行在段内发起：照样直接跑', async () => {
    const { lock } = recordingLock()
    const section = new WriteSection(lock)
    await expect(section.run(() => section.runUnqueued(async () => 1))).resolves.toBe(1)
  })
})

describe('写入段 × 真实的记忆根写锁', () => {
  const roots: string[] = []
  afterEach(async () => { for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true }) })

  it('锁库用不了（node:sqlite 加载不到）时退回进程内保护：同一进程的写入段照样不重叠', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pm-section-'))
    roots.push(root)
    const lock = createRootLock({ root, log: quiet, loadSqlite: () => undefined })
    const order: string[] = []
    const g = gate()
    const first = lock.run(async () => { order.push('甲进'); await g.opened; order.push('甲出') })
    const second = lock.run(async () => { order.push('乙进') })
    await settle()
    expect(order).toEqual(['甲进'])
    g.open()
    await Promise.all([first, second])
    expect(order).toEqual(['甲进', '甲出', '乙进'])
  })

  it('旧 KV 导入在段外先被触发、段内又等它：不互相等，导入完成，两边都拿到导进来的条目', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pm-section-'))
    roots.push(root)
    const lock = createRootLock({ root, log: quiet })
    const legacy: LegacyKvTables = {
      snapshots: [['snap_a', { id: 'snap_a', createdAt: 1, operation: 'manual', description: 'snap_a', memoryIds: [], data: [] }]],
      pending: [['pd_a', { id: 'pd_a', memoryIds: ['mem_a', 'mem_b'], summary: 'pd_a', firstSeenAt: 1 }]],
      discard: async () => {},
    }
    const sidecar = new SidecarStore({ root, schemas: sidecarSchemas, lock, log: quiet, openLegacyKv: async () => legacy })
    const g = gate()
    // 一段先进写入段，在段里等闸门；随后段外的读取触发导入（memoize），再放开闸门让段里也去读
    const held = lock.run(async () => { await g.opened; return sidecar.pending.list() })
    const outside = sidecar.snapshots.list()
    await settle(20)
    g.open()
    const timedOut = new Promise<'超时'>(resolve => { setTimeout(() => resolve('超时'), 3_000).unref() })
    const done = Promise.all([held, outside]).then(([pending, snapshots]) => ({ pending: pending.map(([k]) => k), snapshots: snapshots.map(([k]) => k) }))
    await expect(Promise.race([done, timedOut])).resolves.toEqual({ pending: ['pd_a'], snapshots: ['snap_a'] })
  })

  it('保存里调核对（保存整段在写入段里，快照、写文件的锁内复核、记账本都是段内再进）与别的写入交错：都走得完，一次不丢', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pm-section-'))
    roots.push(root)
    // 接线层同款：一把写入段注入文件表、侧表、账本
    const lock = createRootLock({ root, log: quiet })
    const sidecar = new SidecarStore({ root, schemas: sidecarSchemas, lock, log: quiet })
    const store = new MemoryStore(new FileTable({ root, lock, stats: sidecar.recallStats, log: quiet }), quiet, sidecar.recallStats)
    const snapshots = new SnapshotStore(sidecar.snapshots, { findGone: goneCopies(store) })
    const decisions = new PendingDecisionsStore(sidecar.pending, lock)
    const W = '/home/dev/proj'
    const targets = Array.from({ length: 10 }, (_, i) => record({ id: `mem_s${i}`, name: `保存${i}`, scope: 'workspace', workspacePath: W }))
    const tagged = record({ id: 'mem_tags', name: '别的写入', scope: 'workspace', workspacePath: W, tags: [] })
    for (const r of [...targets, tagged]) await store.create(r)
    const save = (r: MemoryRecord, i: number) => runSavePipeline(
      candidate({ action: 'update', id: r.id, name: r.name, scope: 'workspace', content: `改写 ${i}`, summary: `改写 ${i}`, force: true }),
      { store, registry, workspacePath: W, snapshots, decisions, session: { id: `会话${i}`, lastSeq: i + 1 }, now: () => 1_000 + i },
    )
    const addTag = (i: number) => store.update(tagged, r => ({ ...r, tags: [...r.tags, `t${i}`] }), { kind: 'workspace', workspacePath: W })
    const all = Promise.all(targets.flatMap((r, i) => [save(r, i), addTag(i)]))
    const timedOut = new Promise<'超时'>(resolve => { setTimeout(() => resolve('超时'), 5_000).unref() })
    expect(await Promise.race([all.then(() => '完成'), timedOut])).toBe('完成')
    for (const [i, r] of targets.entries()) expect((await store.get(r.id, { workspacePath: W }))?.content).toBe(`改写 ${i}`)
    expect([...(await store.get(tagged.id, { workspacePath: W }))!.tags].sort()).toEqual(Array.from({ length: 10 }, (_, i) => `t${i}`).sort())
    expect(await snapshots.list()).toHaveLength(10)
    expect((await decisions.listSettled()).filter(d => d.memoryIds.some(id => id.startsWith('mem_s')))).toHaveLength(10)
  })

  it('同一实例并发进入要排队，嵌套进入不等待', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pm-section-'))
    roots.push(root)
    const lock = createRootLock({ root, log: quiet })
    const order: string[] = []
    const g = gate()
    const first = lock.run(async () => {
      order.push('甲进')
      await lock.run(async () => { order.push('甲里嵌套') })
      await g.opened
      order.push('甲出')
    })
    const second = lock.run(async () => { order.push('乙进') })
    await settle(20)
    expect(order).toEqual(['甲进', '甲里嵌套'])
    g.open()
    await Promise.all([first, second])
    expect(order).toEqual(['甲进', '甲里嵌套', '甲出', '乙进'])
  })
})
