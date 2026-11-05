import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { linkExclusive } from './exclusive-link.ts'

/**
 * `.state/` 下文件的共用写法：tmp + rename 原子写、排他创建、锁文件（持有者、残留判定、清残留）。
 * 侧表（sidecar.ts）的条目与认领、旧 KV 导入（legacy-kv-import.ts）的锁与续传都用这一套。
 */

/** 能直接当文件名的键（genId 产出的 snap_ / pd_ id 都满足）；其余一律不落盘，防路径穿越。 */
export const SAFE_KEY_RE = /^[A-Za-z0-9_-]+$/

export function errnoCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code
}

export function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return errnoCode(err) === 'EPERM' // 进程在，只是不归我们管
  }
}

/** tmp 命名带 pid，与 FileTable.atomicWrite 同规则。 */
function tmpPathFor(path: string): string {
  return `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
}

export async function atomicWrite(path: string, text: string): Promise<void> {
  const tmp = tmpPathFor(path)
  await writeFile(tmp, text, 'utf8')
  await rename(tmp, path)
}

/** 原子排他创建：先写 tmp，再 link 到目标（目标已存在则 EEXIST，不覆盖），最后删 tmp。
 *  比直接 `wx` 写目标多一步，换来崩溃时不会留下半截文件——半截文件在续传时会被当成"已存在"跳过。
 *  卷不支持硬链接时 linkExclusive 退回排他复制，仍不覆盖，但崩溃可能留下半截文件。返回 false = 目标已存在。 */
export async function createExclusive(path: string, text: string): Promise<boolean> {
  const tmp = tmpPathFor(path)
  await writeFile(tmp, text, 'utf8')
  try {
    await linkExclusive(tmp, path)
    return true
  } catch (err) {
    if (errnoCode(err) === 'EEXIST') return false
    throw err
  } finally {
    await rm(tmp, { force: true })
  }
}

/** 锁文件里记的持有者 id；读不到或读不懂为 undefined。 */
export async function lockOwner(lockPath: string): Promise<unknown> {
  try {
    return (JSON.parse(await readFile(lockPath, 'utf8')) as { id?: unknown }).id
  } catch {
    return undefined
  }
}

/** 持有进程已退出或超过 staleMs 没刷新按残留。内容读不懂（半截文件）也按残留：走 link 时目标原子出现，
 *  读不懂只会是崩溃留下的；退回复制时可能正在写，由 breakStaleLock 的改名核对兜住。 */
export function isStaleLock(text: string, now: number, staleMs: number): boolean {
  let lock: { pid?: unknown; at?: unknown }
  try {
    lock = JSON.parse(text) as { pid?: unknown; at?: unknown }
  } catch {
    return true
  }
  if (typeof lock.pid !== 'number' || typeof lock.at !== 'number') return true
  return !isAlive(lock.pid) || now - lock.at > staleMs
}

/** 清掉判为残留的锁（held 是判定时读到的内容）：先改名再核对，判定之后锁可能已换主，内容变了就放回去，不误删新主的锁。 */
export async function breakStaleLock(lockPath: string, held: string): Promise<void> {
  const grave = tmpPathFor(lockPath)
  try {
    await rename(lockPath, grave)
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return // 别人先清掉了
    throw err
  }
  if (await readFile(grave, 'utf8') !== held) {
    await linkExclusive(grave, lockPath).catch(err => { if (errnoCode(err) !== 'EEXIST') throw err })
  }
  await rm(grave, { force: true })
}
