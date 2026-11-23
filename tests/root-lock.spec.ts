import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCrossProcessLock, isSqliteBusy, type RootLockOptions } from '../src/storage/root-lock.ts'
import { RootLockTimeoutError } from '../src/errors.ts'
import { fireUntilSettled, manualTimers } from './helpers/manual-timers.ts'
import { signal, waitForSignal } from './helpers/signal-files.ts'
import { spawnWorker, type LineWorker } from './helpers/spawn-worker.ts'

// 记忆根写锁：真 node:sqlite、临时目录；另一个进程持锁用真子进程，kill -9 用真信号。
// 退避等待注入手动计时器，等锁超时不真等。

const WORKER = fileURLToPath(new URL('./helpers/root-lock-worker.ts', import.meta.url))
const BUSY = { code: 'ERR_SQLITE_ERROR', errcode: 5, errstr: 'database is locked' }

let root: string
let signals: string
let workers: LineWorker[] = []
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pm-root-lock-'))
  signals = await mkdtemp(join(tmpdir(), 'pm-root-lock-signals-'))
})
afterEach(async () => {
  await Promise.all(workers.splice(0).map(w => w.kill()))
  await rm(root, { recursive: true, force: true })
  await rm(signals, { recursive: true, force: true })
})

/** 锁协议的路径是跨版本契约，这里写死，不从实现取。 */
const lockPath = () => join(root, '.state', 'lock', 'write-lock.sqlite')

/** 这份测试测的是跨进程那一层（锁协议、持有计数）；外面套的写入段另见 write-section.spec.ts。 */
function newLock(extra: Partial<RootLockOptions> = {}) {
  const warnings: string[] = []
  const timers = manualTimers()
  const log = { info: () => {}, warn: (m: string) => { warnings.push(m) }, error: (m: string) => { warnings.push(m) } }
  return { lock: createCrossProcessLock({ root, log, timers, ...extra }), timers, warnings }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(r => { resolve = r })
  return { promise, resolve }
}

async function startWorker(tag: string, mode: 'pause' | 'nopause' = 'pause'): Promise<LineWorker> {
  const w = spawnWorker(WORKER, [root, signals, tag, mode])
  workers.push(w)
  expect(await w.nextLine()).toBe('ready')
  return w
}

/** 子进程拿到锁、停在屏障上（第 n 次 run）。 */
async function holdInChild(w: LineWorker, tag: string, n: number): Promise<void> {
  w.send('run')
  await waitForSignal(signals, `${tag}.${n}.held`)
}

async function releaseChild(w: LineWorker, tag: string, n: number): Promise<void> {
  await signal(signals, `${tag}.${n}.go`)
  expect(await w.nextLine()).toBe(`ran ${n}`)
}

function readUserVersion(): number {
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite')
  const db = new DatabaseSync(lockPath(), { readOnly: true })
  try {
    return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
  } finally {
    db.close()
  }
}

describe('写锁：跨进程互斥', () => {
  it('RL-01 子进程持锁时 run 等待，子进程释放后在下一次重试拿到', async () => {
    const holder = await startWorker('a')
    await holdInChild(holder, 'a', 1)

    const { lock, timers, warnings } = newLock()
    let entered = false
    const mine = lock.run(async () => { entered = true; return 'mine' })
    await timers.scheduled()
    timers.fire()
    await timers.scheduled() // 对方仍持有：继续退避
    expect(entered).toBe(false)

    await releaseChild(holder, 'a', 1)
    timers.fire()
    await expect(mine).resolves.toBe('mine')
    expect(timers.fired).toBe(2)
    expect(warnings).toEqual([])
  })

  it('RL-01 一直拿不到：累计 10 s 报 root-lock-timeout，计数归零，下一次 run 重新获取', async () => {
    const holder = await startWorker('a')
    await holdInChild(holder, 'a', 1)

    const { lock, timers, warnings } = newLock()
    let calls = 0
    const first = lock.run(async () => { calls++ })
    await fireUntilSettled(first, timers)
    const err = await first.catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RootLockTimeoutError)
    expect((err as RootLockTimeoutError).code).toBe('root-lock-timeout')
    expect(timers.elapsed).toBe(10_000)
    expect(calls).toBe(0)

    // 新的一次获取：对方仍持有，挂上新的退避；对方释放后拿到
    const second = lock.run(async () => 'again')
    await timers.scheduled()
    await releaseChild(holder, 'a', 1)
    timers.fire()
    await expect(second).resolves.toBe('again')
    expect(warnings).toEqual([])
  })

  it('RL-02 kill -9 持锁的子进程后，第一次重试就拿到', async () => {
    const holder = await startWorker('a')
    await holdInChild(holder, 'a', 1)

    const { lock, timers } = newLock()
    const mine = lock.run(async () => 'mine')
    await timers.scheduled()
    await holder.kill()
    timers.fire()
    await expect(mine).resolves.toBe('mine')
    expect(timers.fired).toBe(1)
  })

  it('RL-05 两个进程同时初始化同一个新记忆根：都成功，user_version 为 1', async () => {
    const [a, b] = await Promise.all([startWorker('a', 'nopause'), startWorker('b', 'nopause')])
    a.send('run')
    b.send('run')
    expect(await Promise.all([a.nextLine(), b.nextLine()])).toEqual(['ran 1', 'ran 1'])
    expect(a.stderr() + b.stderr()).not.toContain('[plastic-memory]')
    expect(readUserVersion()).toBe(1)
  })

  it('RL-07 子进程第一次加锁后 stderr 没有 SQLite 实验特性警告，其他 ExperimentalWarning 照常', async () => {
    const w = await startWorker('a', 'nopause')
    w.send('run')
    expect(await w.nextLine()).toBe('ran 1')
    w.send('warn')
    expect(await w.nextLine()).toBe('warned')
    w.child.stdin!.end()
    expect((await w.exited)[0]).toBe(0)

    const stderr = w.stderr()
    expect(stderr).not.toContain('[plastic-memory]') // 真拿了锁，没退回无锁
    expect(readUserVersion()).toBe(1)
    expect(stderr).not.toContain('ExperimentalWarning: SQLite')
    expect(stderr).toContain('ExperimentalWarning: 别的实验特性')
  })

  it('RL-21 持锁期间锁库被删：这一批照常完成，下一批在新锁库上与另一进程恢复互斥', async () => {
    const holder = await startWorker('a')
    await holdInChild(holder, 'a', 1)
    await rm(lockPath())
    await releaseChild(holder, 'a', 1)

    await holdInChild(holder, 'a', 2)
    expect(existsSync(lockPath())).toBe(true)
    const { lock, timers } = newLock()
    const mine = lock.run(async () => 'mine')
    await timers.scheduled() // 新锁库上撞忙：互斥恢复
    await releaseChild(holder, 'a', 2)
    timers.fire()
    await expect(mine).resolves.toBe('mine')
    expect(holder.stderr()).not.toContain('[plastic-memory]')
  })
})

describe('写锁：同进程', () => {
  it('RL-03 两个实例互斥；同一实例嵌套、并发进入都不等待，最后一个离开才释放', async () => {
    const a = newLock()
    const b = newLock()
    const order: string[] = []

    const outerIn = deferred()
    const releaseOuter = deferred()
    const outer = a.lock.run(async () => {
      order.push('outer')
      await a.lock.run(async () => { order.push('nested') })
      outerIn.resolve()
      await releaseOuter.promise
    })
    await outerIn.promise

    const other = b.lock.run(async () => { order.push('other-instance') })
    await b.timers.scheduled()

    const concurrentIn = deferred()
    const releaseConcurrent = deferred()
    const concurrent = a.lock.run(async () => {
      order.push('concurrent')
      concurrentIn.resolve()
      await releaseConcurrent.promise
    })
    await concurrentIn.promise
    expect(a.timers.fired + a.timers.pending).toBe(0)

    releaseOuter.resolve()
    await outer // 外层先离开，并发的还在里面
    b.timers.fire()
    await b.timers.scheduled()
    expect(order).not.toContain('other-instance')

    releaseConcurrent.resolve()
    await concurrent // 最后一个离开，释放
    b.timers.fire()
    await other
    expect(order).toEqual(['outer', 'nested', 'concurrent', 'other-instance'])
    expect(b.timers.fired).toBe(2)
    expect([...a.warnings, ...b.warnings]).toEqual([])
  })

  it('RL-05 初始化后加解锁 100 次：锁库 mtime、大小不变，锁目录里只有锁库', async () => {
    const { lock } = newLock()
    await lock.run(async () => {})
    const before = await stat(lockPath())
    for (let i = 0; i < 100; i++) {
      await lock.run(async () => {
        if (i === 0) expect(await readdir(dirname(lockPath()))).toEqual(['write-lock.sqlite'])
      })
    }
    const after = await stat(lockPath())
    expect(after.mtimeMs).toBe(before.mtimeMs)
    expect(after.size).toBe(before.size)
    expect(after.ino).toBe(before.ino)
    expect(await readdir(dirname(lockPath()))).toEqual(['write-lock.sqlite'])
    expect(readUserVersion()).toBe(1)
  })
})

describe('写锁：退回无锁', () => {
  it.each([
    ['加载器返回不可用', () => undefined],
    ['加载器抛错', () => { throw new Error('no sqlite') }],
  ])('RL-06 %s：照常执行，告警一次', async (_label, loadSqlite) => {
    const { lock, timers, warnings } = newLock({ loadSqlite })
    await expect(lock.run(async () => 1)).resolves.toBe(1)
    await expect(lock.run(async () => 2)).resolves.toBe(2)
    expect(warnings).toHaveLength(1)
    expect(timers.fired + timers.pending).toBe(0)
  })

  it('RL-06 锁库是一个损坏的文件：照常执行，告警一次，锁库不被删也不被改', async () => {
    await mkdir(dirname(lockPath()), { recursive: true })
    const garbage = Buffer.from('this is not a sqlite database\n'.repeat(200))
    await writeFile(lockPath(), garbage)

    const { lock, timers, warnings } = newLock()
    await expect(lock.run(async () => 1)).resolves.toBe(1)
    await expect(lock.run(async () => 2)).resolves.toBe(2)
    expect(warnings).toHaveLength(1)
    expect(timers.fired + timers.pending).toBe(0)
    expect(await readFile(lockPath())).toEqual(garbage)
  })

  // root 无视目录权限，造不出「不可写」
  it.skipIf(process.getuid?.() === 0)('RL-06 锁目录不可写：照常执行，告警一次', async () => {
    const dir = dirname(lockPath())
    await mkdir(dir, { recursive: true })
    await chmod(dir, 0o555)
    try {
      const { lock, timers, warnings } = newLock()
      await expect(lock.run(async () => 1)).resolves.toBe(1)
      await expect(lock.run(async () => 2)).resolves.toBe(2)
      expect(warnings).toHaveLength(1)
      expect(timers.fired + timers.pending).toBe(0)
      expect(await readdir(dir)).toEqual([])
    } finally {
      await chmod(dir, 0o755)
    }
  })
})

describe('写锁：忙', () => {
  it.each([
    ['主错误码 5', BUSY, true],
    ['扩展码 SQLITE_BUSY_SNAPSHOT（517）', { ...BUSY, errcode: 517 }, true],
    ['SQLITE_LOCKED（6）', { ...BUSY, errcode: 6 }, false],
    ['锁库损坏（26）', { ...BUSY, errcode: 26 }, false],
    ['code 不是 ERR_SQLITE_ERROR', { ...BUSY, code: 'EBUSY' }, false],
    ['没有 errcode', { code: 'ERR_SQLITE_ERROR' }, false],
    ['不是对象', 'database is locked', false],
    ['undefined', undefined, false],
  ])('RL-20 isSqliteBusy：%s', (_label, err, expected) => {
    expect(isSqliteBusy(err)).toBe(expected)
  })

  it('RL-20 初始化的 COMMIT 报忙：回滚后重试成功，user_version 为 1，期间不退回无锁', async () => {
    // 另一条连接在新锁库上开读事务、持共享锁：初始化的 BEGIN IMMEDIATE 能拿到，COMMIT 要排他锁，报忙
    await mkdir(dirname(lockPath()), { recursive: true })
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite')
    const reader = new DatabaseSync(lockPath())
    reader.exec('BEGIN')
    reader.prepare('SELECT count(*) FROM sqlite_master').get()

    const { lock, timers, warnings } = newLock()
    let ran = false
    const mine = lock.run(async () => { ran = true })
    await timers.scheduled()
    expect(ran).toBe(false)
    expect((reader.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(0)

    reader.exec('ROLLBACK')
    reader.close()
    timers.fire()
    await mine
    expect(ran).toBe(true)
    expect(readUserVersion()).toBe(1)
    expect(warnings).toEqual([])
  })

  it('RL-20 同一次获取的多个等待者一起超时，之后再获取成功；忙不退回无锁', async () => {
    const a = newLock()
    const aIn = deferred()
    const releaseA = deferred()
    const holding = a.lock.run(async () => { aIn.resolve(); await releaseA.promise })
    await aIn.promise

    const b = newLock()
    const ran: number[] = []
    const waiters = [b.lock.run(async () => { ran.push(1) }), b.lock.run(async () => { ran.push(2) })]
    const settled = Promise.allSettled(waiters)
    await fireUntilSettled(settled, b.timers)
    const results = await settled
    for (const r of results) {
      expect(r.status).toBe('rejected')
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(RootLockTimeoutError)
    }
    expect(b.timers.elapsed).toBe(10_000) // 两个等待者共用一次获取
    expect(ran).toEqual([])
    expect(b.warnings).toEqual([])

    releaseA.resolve()
    await holding
    await expect(b.lock.run(async () => 'ok')).resolves.toBe('ok')
  })
})
