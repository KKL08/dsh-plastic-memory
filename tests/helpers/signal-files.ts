import { access, writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { join } from 'node:path'

/**
 * 跨进程信号文件：一个文件名就是一个一次性事件，测试进程和子进程都能发、都能等。
 * 和子进程的 stdin/stdout 协议无关，所以能插进任何子进程脚本（见 lock-barrier.ts）。
 * 信号目录用测试自己建的临时目录，别放进被测的记忆根。
 */

/** 发信号：建一个空文件。重复发同一个信号无害。 */
export async function signal(dir: string, name: string): Promise<void> {
  await writeFile(join(dir, name), '')
}

/** 等信号：轮询到文件出现为止。等的是条件，不是时长，信号永远不来时由用例超时兜底。 */
export async function waitForSignal(dir: string, name: string): Promise<void> {
  const path = join(dir, name)
  for (;;) {
    try {
      await access(path)
      return
    } catch {
      await delay(5)
    }
  }
}
