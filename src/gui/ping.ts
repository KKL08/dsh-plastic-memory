import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// walking skeleton 的服务端半侧（GUI 层）：一条 `/memory` 人类命令，只认 `ping` 子命令；
// 它把 <memoryRoot>/.state/gui/ping.json 重写一遍并以 JSON 文本返回。浏览器半侧订阅这个文件看版本变化。
// 不 import 框架包：命令定义按宿主 CommandDefinition 的结构给出，由接线层交给 ctx.commands.register。

/** ping.json 的内容。 */
export interface PingFile {
  /** 写入时刻，ISO 8601。 */
  at: string
  /** 谁触发的这次写入。 */
  source: 'startup' | 'command'
}

/** writePing 的返回：文件内容加它的绝对路径（浏览器半侧要用绝对路径订阅文件资源）。 */
export interface PingRecord extends PingFile {
  path: string
}

/** 宿主命令处理器结果的子集（dsh-commands 的 CommandResult）。 */
export type MemoryCommandResult = { kind: 'success'; text: string } | { kind: 'error'; text: string }

/** 宿主 CommandDefinition 的结构子集。 */
export interface MemoryCommand {
  name: string
  description: string
  handler: (invocation: { rawInput: string }) => Promise<MemoryCommandResult>
}

export function pingPath(memoryRoot: string): string {
  return join(memoryRoot, '.state', 'gui', 'ping.json')
}

/** 原子重写 ping.json（tmp + rename，订阅方不会读到半个文件）。 */
export async function writePing(memoryRoot: string, source: PingFile['source'], now = Date.now()): Promise<PingRecord> {
  const path = pingPath(memoryRoot)
  const body: PingFile = { at: new Date(now).toISOString(), source }
  await mkdir(join(memoryRoot, '.state', 'gui'), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(body) + '\n', 'utf8')
  await rename(tmp, path)
  return { ...body, path }
}

export function createMemoryCommand(memoryRoot: string): MemoryCommand {
  return {
    name: 'memory',
    description: 'Plastic Memory GUI actions',
    handler: async ({ rawInput }) => {
      const sub = rawInput.trim()
      if (sub !== 'ping') return { kind: 'error', text: JSON.stringify({ error: 'unknown-subcommand', subcommand: sub }) }
      return { kind: 'success', text: JSON.stringify(await writePing(memoryRoot, 'command')) }
    },
  }
}
