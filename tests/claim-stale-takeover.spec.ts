import { sidecarSchemas } from './helpers/sidecar-schemas.ts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SidecarStore } from '../src/storage/sidecar.ts'
import { createRootLock } from '../src/storage/root-lock.ts'
import type { SectionLock } from '../src/root-lock.ts'
import type { RefreshableClaim } from '../src/kv-table.ts'

// 清残留认领与持有者刷新交错：真侧表、真写锁、真临时目录。清残留先把认领改名挪开再核对，
// 改名留下的空档只能在进程边界（node:fs/promises 的 rename）插进去，其余照原实现走。

const hooks = vi.hoisted(() => ({ afterRename: undefined as ((from: string, to: string) => Promise<void>) | undefined }))

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    rename: async (from: Parameters<typeof actual.rename>[0], to: Parameters<typeof actual.rename>[1]) => {
      await actual.rename(from, to)
      const hook = hooks.afterRename
      if (hook !== undefined) await hook(String(from), String(to))
    },
  }
})

const schemas = sidecarSchemas
const quietLog = { info() {}, warn() {}, error() {} }
const T = 1_000_000

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pm-claim-takeover-'))
})
afterEach(async () => {
  hooks.afterRename = undefined
  await rm(root, { recursive: true, force: true })
})

/** 每次 run 先跑一次 beforeRun（只跑一次），再去拿真锁：固定「锁外判定之后、进锁之前」这段。 */
function hookedLock(inner: SectionLock) {
  let beforeRun: (() => Promise<void>) | undefined
  const lock: SectionLock = {
    runUnqueued: fn => inner.runUnqueued(fn),
    async run(fn) {
      const hook = beforeRun
      beforeRun = undefined
      if (hook !== undefined) await hook()
      return inner.run(fn)
    },
  }
  return { lock, setBeforeRun: (fn: () => Promise<void>) => { beforeRun = fn } }
}

describe('认领残留的清理与刷新交错', () => {
  it('锁外判为残留之后、进锁之前持有者刷新了认领：进锁后不动这份认领，同进程另一次认领拿不到，持有者仍能刷新', async () => {
    let holderNow = T
    const holder = new SidecarStore({ root, schemas, lock: createRootLock({ root, log: quietLog }), log: quietLog, now: () => holderNow })
    const held = await holder.checkups.claimRefreshable('scope')
    expect(held).toBeDefined()

    const hooked = hookedLock(createRootLock({ root, log: quietLog }))
    const taker = new SidecarStore({ root, schemas, lock: hooked.lock, log: quietLog, now: () => T + 61_000 })
    // 接手方锁外读到的是 T 时刻的认领，已超时；它去拿锁之前，持有者在锁内刷新
    hooked.setBeforeRun(async () => {
      holderNow = T + 61_000
      expect(await held!.refresh()).toBe(true)
    })
    // 认领文件若被改名挪开，同进程的另一次认领从快速路径趁空档建一份
    let sneaked: RefreshableClaim | undefined
    hooks.afterRename = async from => {
      if (!from.endsWith('.claim')) return
      hooks.afterRename = undefined
      sneaked = await taker.checkups.claimRefreshable('scope')
    }

    expect(await taker.checkups.claimRefreshable('scope')).toBeUndefined()
    expect(sneaked).toBeUndefined()
    expect(await held!.refresh()).toBe(true)
    const dir = join(root, '.state', 'checkups')
    const claims = (await readdir(dir)).filter(n => n.endsWith('.claim'))
    expect(claims).toHaveLength(1)
    expect(JSON.parse(await readFile(join(dir, claims[0]!), 'utf8'))).toMatchObject({ at: T + 61_000 })
    await held!.release()
  })
})
