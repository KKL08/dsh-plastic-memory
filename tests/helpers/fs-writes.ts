/**
 * 进程边界的观察：记下对 node:fs/promises 写类函数的成功调用（函数名 + 第一个参数），平时原样透传。
 * 证明「没写盘」时直接断言没有写调用，不比 mtime：mtime 精度粗的文件系统上，写了也可能读到同一个 mtime。
 * 失败的调用（如往不存在的目录写临时文件）没动磁盘，不记。
 *
 * 测试文件里挂上（vi.mock 会提升到文件顶部）：
 *   vi.mock('node:fs/promises', async importOriginal => (await import('./helpers/fs-writes.ts')).recordWrites(await importOriginal()))
 * 已有自己的 node:fs/promises 替身时，把替身返回的对象再交给 recordWrites。
 */

/** node:fs/promises 里会改动文件系统的函数。 */
const WRITE_FUNCTIONS = new Set([
  'appendFile', 'chmod', 'chown', 'copyFile', 'cp', 'lchown', 'link', 'lutimes', 'mkdir', 'mkdtemp',
  'rename', 'rm', 'rmdir', 'symlink', 'truncate', 'unlink', 'utimes', 'writeFile',
])

const state = { recording: false, calls: [] as string[] }

/** 包一层：写类函数照调原实现，记录期间成功返回的记下 `函数名(第一个参数)`。 */
export function recordWrites<T extends object>(actual: T): T {
  return Object.fromEntries(Object.entries(actual).map(([key, value]) => [key, typeof value === 'function' && WRITE_FUNCTIONS.has(key)
    ? async (...args: unknown[]) => {
        const result = await (value as (...a: unknown[]) => Promise<unknown>)(...args)
        if (state.recording) state.calls.push(`${key}(${String(args[0])})`)
        return result
      }
    : value])) as T
}

/** 跑 fn，返回期间的写调用，形如 `rename(/abs/path.tmp-…)`。 */
export async function writesDuring(fn: () => Promise<unknown>): Promise<string[]> {
  state.calls = []
  state.recording = true
  try {
    await fn()
  } finally {
    state.recording = false
  }
  return [...state.calls]
}
