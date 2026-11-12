import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { breakStaleLock, isStaleLock } from '../src/storage/state-files.ts'

// .state/ 锁文件的残留判定与清理：真实临时目录，时间由参数给定，不依赖真实时钟。
// 持有者用本进程的 pid，保证「进程还活着」这一前提确定成立。

const NOW = 1_000_000
const STALE_MS = 60_000

let dir: string
let lockPath: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pm-state-files-'))
  lockPath = join(dir, 'store.lock')
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const lockText = (lock: object) => JSON.stringify(lock)

describe('isStaleLock：锁文件内容读不懂按残留', () => {
  it('持有进程还在、时间戳没过期：不是残留', () => {
    expect(isStaleLock(lockText({ pid: process.pid, at: NOW }), NOW, STALE_MS)).toBe(false)
  })

  it.each([
    ['写到一半的半截内容', `{"pid":${process.pid},"at":`],
    ['不是合法 JSON', 'not a lock'],
  ])('%s：判为残留', (_label, text) => {
    expect(isStaleLock(text, NOW, STALE_MS)).toBe(true)
  })

  it.each([
    ['缺时间戳', { pid: process.pid }],
    ['时间戳不是数字', { pid: process.pid, at: String(NOW) }],
  ])('%s：即使持有进程还在，也判为残留', (_label, lock) => {
    expect(isStaleLock(lockText(lock), NOW, STALE_MS)).toBe(true)
  })
})

describe('breakStaleLock：清残留前核对锁有没有换主', () => {
  const held = lockText({ pid: process.pid, at: NOW - STALE_MS - 1, id: 'old' })

  it('锁还是判定时读到的那份：清掉，不留改名用的中间文件', async () => {
    await writeFile(lockPath, held, 'utf8')
    await breakStaleLock(lockPath, held)
    expect(await readdir(dir)).toEqual([])
  })

  it('判定之后、动手之前锁已换主（内容变了）：新主的锁原样放回，不误删，也不留中间文件', async () => {
    const fresh = lockText({ pid: process.pid, at: NOW, id: 'new' })
    await writeFile(lockPath, fresh, 'utf8')
    await breakStaleLock(lockPath, held)
    expect(await readFile(lockPath, 'utf8')).toBe(fresh)
    expect(await readdir(dir)).toEqual(['store.lock'])
  })

  it('别人已经先清掉了：直接返回、不报错，目录里什么都不多', async () => {
    await expect(breakStaleLock(lockPath, held)).resolves.toBeUndefined()
    expect(await readdir(dir)).toEqual([])
  })
})
