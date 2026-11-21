/**
 * 面板动作的通道（宿主那一半）：把 `run` 交给 `/memory` 命令的处理器，换的只是入口。
 * 命令由宿主按会话执行、每条都记进会话日志；这里按调用方给的会话 id 找到同一个 agent 再调同一个处理器，日志里不留记录。
 * 不 import 框架包运行时：处理函数按宿主 ConnectionRpcHandler 的结构给出，由接线层交给 ctx.connection.rpc.handle。
 */
import { MEMORY_RPC_PING, MEMORY_RPC_RUN } from './contract.ts'
import type { HostCommandResult, MemoryCommandDefinition } from './commands.ts'

/** 宿主 PeerScope 的结构子集：只看调用方身份。 */
export interface MemoryRpcPeer {
  principal?: { kind?: string } | undefined
}

/** 宿主 ConnectionRpcHandlerResult 的结构子集。 */
export type MemoryRpcResult =
  | { ok: true; value: { ok: true } | { result: HostCommandResult } }
  | { ok: false; error: { code: string; message: string; details: object } }

export type MemoryRpcHandler = (endpoint: string, payload: unknown, signal: AbortSignal, peer: MemoryRpcPeer | undefined) => Promise<MemoryRpcResult>

export interface MemoryRpcDeps {
  /** `/memory` 命令的处理器；命令服务还没就位（或已撤下）时为 undefined。 */
  command: () => MemoryCommandDefinition['handler'] | undefined
  /** 会话 id → agent，用宿主执行命令时的同一个解析器（会话还没恢复就先恢复，子 agent 的会话拒绝）；解析不到为 undefined 或抛错（宿主的错带 code）。 */
  agentOf: (sessionId: string) => Promise<unknown>
}

const fail = (code: string, message: string): MemoryRpcResult => ({ ok: false, error: { code: `plastic-memory/${code}`, message, details: {} } })

function runArgs(payload: unknown): { sessionId: string; input: string } | undefined {
  if (payload === null || typeof payload !== 'object') return undefined
  const { sessionId, input } = payload as { sessionId?: unknown; input?: unknown }
  return typeof sessionId === 'string' && typeof input === 'string' ? { sessionId, input } : undefined
}

export function createMemoryRpcHandler(deps: MemoryRpcDeps): MemoryRpcHandler {
  return async (endpoint, payload, _signal, peer) => {
    // 宿主的通道只核对来源和登录，不看身份；记忆只让本机 owner 读写
    if (peer?.principal?.kind !== 'owner') return fail('forbidden', 'owner only')
    if (endpoint === MEMORY_RPC_PING) return { ok: true, value: { ok: true } }
    if (endpoint !== MEMORY_RPC_RUN) return fail('bad-request', `unknown endpoint ${endpoint}`)
    const args = runArgs(payload)
    if (args === undefined) return fail('bad-request', 'expected { sessionId, input }')
    const command = deps.command()
    if (command === undefined) return fail('unavailable', 'memory command is not ready')
    let agent: unknown
    try {
      agent = await deps.agentOf(args.sessionId)
    } catch (err) {
      // 宿主的解析器带错误码拒绝（会话被别处占用、agent 正忙）时原样报出，面板才说得出原因
      const { code, message } = (err ?? {}) as { code?: unknown; message?: unknown }
      if (typeof code === 'string' && typeof message === 'string') return { ok: false, error: { code, message, details: {} } }
      return fail('no-session', `session ${args.sessionId} cannot run commands: ${String(err)}`)
    }
    if (agent === undefined) return fail('no-session', `session ${args.sessionId} cannot run commands`)
    return { ok: true, value: { result: await command({ rawInput: args.input, agent }) } }
  }
}
