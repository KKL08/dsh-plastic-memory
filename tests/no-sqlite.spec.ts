import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRootLock } from '../src/storage/root-lock.ts'
import { STATE_DIR } from '../src/storage/paths.ts'

// 只在 node-no-sqlite 项目里跑（见 vitest.config.ts）：核对这一档的写锁确实退回了进程内保护，
// 否则同一批用例在这一档全绿也说明不了什么。

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'pm-no-sqlite-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('MI-02 写锁不可用的一档', () => {
  it('MI-02 缺省加载器拿不到 node:sqlite：写锁照常执行写入，记一条「退回进程内保护」的警告，不建锁库', async () => {
    const warnings: string[] = []
    const lock = createRootLock({ root, log: { info() {}, warn: (m: string) => { warnings.push(m) }, error() {} } })
    expect(await lock.run(async () => 'ran')).toBe('ran')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('退回进程内保护')
    expect(existsSync(join(root, STATE_DIR, 'lock'))).toBe(false)
  })
})
