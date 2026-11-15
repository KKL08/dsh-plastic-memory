import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { createInterface } from 'node:readline'

/** 按行通信的子进程。 */
export interface LineWorker {
  child: ChildProcess
  /** stdout 的下一行；子进程提前关闭 stdout 时抛错，错误里带退出码和 stderr。 */
  nextLine(): Promise<string>
  /** 往 stdin 写一行。 */
  send(line: string): void
  /** 到目前为止收到的 stderr 全文。要断言完整 stderr，先关 stdin、等 exited。 */
  stderr(): string
  exited: Promise<[number | null, NodeJS.Signals | null]>
  /** 还没退出就 kill -9 并等它退出；用例收尾时调用。 */
  kill(): Promise<void>
}

/** 用当前 Node 直接跑一个 .ts 子进程脚本（Node 内置类型剥离，不经 tsx）。 */
export function spawnWorker(script: string, args: readonly string[]): LineWorker {
  const child = spawn(process.execPath, [script, ...args], { stdio: ['pipe', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr!.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
  const lines = createInterface({ input: child.stdout! })[Symbol.asyncIterator]()
  const exited = once(child, 'exit') as Promise<[number | null, NodeJS.Signals | null]>
  return {
    child,
    async nextLine() {
      const { value, done } = await lines.next()
      if (done) throw new Error(`子进程提前关闭了 stdout（退出码 ${(await exited)[0]}）：${stderr}`)
      return value as string
    },
    send(line) {
      child.stdin!.write(`${line}\n`)
    },
    stderr: () => stderr,
    exited,
    async kill() {
      if (child.exitCode !== null || child.signalCode !== null) return
      child.kill('SIGKILL')
      await exited
    },
  }
}
