import { sidecarSchemas } from './helpers/sidecar-schemas.ts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SidecarStore } from '../src/storage/sidecar.ts'
import { createRootLock } from '../src/storage/root-lock.ts'
import { CheckupRecordStore } from '../src/governance/checkup-records.ts'
import { checkupKey } from '../src/gui/contract.ts'
import { holdCheckups, type IntervalTimer } from '../src/gui/checkup-run.ts'
import type { Scope } from '../src/scope.ts'
import type { RootLock } from '../src/root-lock.ts'
import { fireUntilSettled, manualTimers, type ManualTimers } from './helpers/manual-timers.ts'

// 体检认领放不掉时的去向：真侧表、真写锁（退避用手动计时器）、真临时目录。
// 删不掉某个认领文件只能在进程边界（node:fs/promises 的 rm）注入，其余照原实现走。

const faults = vi.hoisted(() => ({ rmFails: undefined as ((path: string) => boolean) | undefined }))

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    rm: async (path: Parameters<typeof actual.rm>[0], opts?: Parameters<typeof actual.rm>[1]) => {
      if (faults.rmFails?.(String(path))) throw Object.assign(new Error(`EACCES: permission denied, unlink '${String(path)}'`), { code: 'EACCES' })
      return actual.rm(path, opts)
    },
  }
})

const schemas = sidecarSchemas
const quietLog = { info() {}, warn() {}, error() {} }
const G: Scope = { kind: 'global' }
const A: Scope = { kind: 'workspace', workspacePath: '/w/a' }
const B: Scope = { kind: 'workspace', workspacePath: '/w/b' }

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pm-checkup-release-'))
})
afterEach(async () => {
  faults.rmFails = undefined
  await rm(root, { recursive: true, force: true })
})

const claimPath = (scope: Scope) => join(root, '.state', 'checkups', `${createHash('sha1').update(checkupKey(scope)).digest('hex')}.claim`)

/** 接线层同款：一把写锁注入侧表，体检记录表建在侧表上。 */
function wired(): { checkups: CheckupRecordStore; lock: RootLock; timers: ManualTimers } {
  const timers = manualTimers()
  const lock = createRootLock({ root, log: quietLog, timers })
  return { checkups: new CheckupRecordStore(new SidecarStore({ root, schemas, lock, log: quietLog }).checkups), lock, timers }
}

/** 另一个实例（另一把锁）先认领了 scope：它正在体检。 */
async function claimedElsewhere(scope: Scope) {
  const other = new SidecarStore({ root, schemas, lock: createRootLock({ root, log: quietLog }), log: quietLog })
  const held = await new CheckupRecordStore(other.checkups).claim([scope])
  expect('claims' in held).toBe(true)
}

/** 同进程里占住写锁的另一个实例：返回放开它的函数。 */
async function holdLockElsewhere() {
  const other = createRootLock({ root, log: quietLog })
  let leave!: () => void
  const gate = new Promise<void>(resolve => { leave = resolve })
  let held!: () => void
  const isHeld = new Promise<void>(resolve => { held = resolve })
  const done = other.run(async () => { held(); await gate })
  await isHeld
  return async () => { leave(); await done }
}

describe('认领不全时回滚已拿到的体检认领', () => {
  it('回滚时写锁被别处占满上限：仍返回正在体检的那个范围，不抛错', async () => {
    const { checkups, timers } = wired()
    await claimedElsewhere(B)
    const leave = await holdLockElsewhere()
    const claimed = checkups.claim([G, A, B])
    await fireUntilSettled(claimed, timers)
    expect(await claimed).toEqual({ busy: B })
    await leave()
  })

  it('回滚时一个认领删不掉：其余的照样放掉，仍返回正在体检的那个范围', async () => {
    const { checkups } = wired()
    await claimedElsewhere(B)
    faults.rmFails = path => path === claimPath(G)
    expect(await checkups.claim([G, A, B])).toEqual({ busy: B })
    expect(existsSync(claimPath(G))).toBe(true)
    expect(existsSync(claimPath(A))).toBe(false)
  })
})

/** 心跳不跑：这里只看放掉认领。 */
const noInterval: IntervalTimer = () => () => {}

describe('体检做完放掉认领', () => {
  it('放掉时写锁被别处占满上限：这次照常返回、不抛错，放完重写一次视图；没放掉的认领留着，按残留处理', async () => {
    const { checkups, timers } = wired()
    let changes = 0
    const held = await holdCheckups(checkups, [G, A], { interval: noInterval, onLost: () => {}, onChange: () => { changes++ }, log: quietLog })
    if ('busy' in held) throw new Error('应认领到')
    expect(changes).toBe(1)

    const leave = await holdLockElsewhere()
    const released = held.release()
    await fireUntilSettled(released, timers)
    await expect(released).resolves.toBeUndefined()
    expect(timers.elapsed).toBe(10_000) // 两个认领共用一次拿锁，只等一轮上限
    expect(changes).toBe(2)
    expect(existsSync(claimPath(G)) && existsSync(claimPath(A))).toBe(true)
    await leave()
  })

  it('放掉时一个认领删不掉：其余的照样放掉，不抛错，放完重写一次视图', async () => {
    const { checkups } = wired()
    let changes = 0
    const held = await holdCheckups(checkups, [G, A], { interval: noInterval, onLost: () => {}, onChange: () => { changes++ }, log: quietLog })
    if ('busy' in held) throw new Error('应认领到')

    faults.rmFails = path => path === claimPath(G)
    await expect(held.release()).resolves.toBeUndefined()
    expect(existsSync(claimPath(G))).toBe(true)
    expect(existsSync(claimPath(A))).toBe(false)
    expect(changes).toBe(2)
  })
})
