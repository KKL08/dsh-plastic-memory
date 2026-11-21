import { describe, expect, it, vi } from 'vitest'
import { MEMORY_RPC_PING, MEMORY_RPC_RUN } from '../src/gui/contract.ts'
import { createMemoryRpcHandler, type MemoryRpcPeer } from '../src/gui/rpc.ts'

const owner: MemoryRpcPeer = { principal: { kind: 'owner' } }
const signal = new AbortController().signal

function subject(options: { hasCommand?: boolean; agents?: Record<string, unknown> } = {}) {
  const run = vi.fn(async (invocation: { rawInput: string; agent?: unknown }) => ({ kind: 'success' as const, text: `ran ${invocation.rawInput}` }))
  const handler = createMemoryRpcHandler({
    command: () => options.hasCommand === false ? undefined : run,
    agentOf: async (id) => {
      if (id === 'session-sub') throw new Error('boom')
      if (id === 'session-held') throw Object.assign(new Error('session is open in another window'), { code: 'session/writer-held' })
      return (options.agents ?? { 'session-1': { id: 'agent-1' } })[id]
    },
  })
  return { run, handler }
}

describe('记忆面板的 RPC 通道', () => {
  it('run：按会话 id 找到 agent，交给命令处理器，结果按命令执行结果的形状返回', async () => {
    const { run, handler } = subject()
    const result = await handler(MEMORY_RPC_RUN, { sessionId: 'session-1', input: 'info' }, signal, owner)
    expect(run).toHaveBeenCalledWith({ rawInput: 'info', agent: { id: 'agent-1' } })
    expect(result).toEqual({ ok: true, value: { result: { kind: 'success', text: 'ran info' } } })
  })

  it('ping：不碰命令处理器', async () => {
    const { run, handler } = subject()
    expect(await handler(MEMORY_RPC_PING, undefined, signal, owner)).toEqual({ ok: true, value: { ok: true } })
    expect(run).not.toHaveBeenCalled()
  })

  it('调用方不是 owner：拒绝，ping 也不放行', async () => {
    const { run, handler } = subject()
    for (const peer of [{ principal: { kind: 'viewer' } }, {}, undefined]) {
      for (const endpoint of [MEMORY_RPC_RUN, MEMORY_RPC_PING]) {
        const result = await handler(endpoint, { sessionId: 'session-1', input: 'forget {}' }, signal, peer as MemoryRpcPeer)
        expect(result).toMatchObject({ ok: false, error: { code: 'plastic-memory/forbidden' } })
      }
    }
    expect(run).not.toHaveBeenCalled()
  })

  it('会话解析不到、或解析器抛的错不带错误码：返回 no-session，不执行', async () => {
    const { run, handler } = subject()
    for (const sessionId of ['session-gone', 'session-sub']) {
      const result = await handler(MEMORY_RPC_RUN, { sessionId, input: 'info' }, signal, owner)
      expect(result).toMatchObject({ ok: false, error: { code: 'plastic-memory/no-session' } })
    }
    expect(await handler(MEMORY_RPC_RUN, { sessionId: 'session-sub', input: 'info' }, signal, owner)).toMatchObject({ error: { message: expect.stringContaining('boom') } })
    expect(run).not.toHaveBeenCalled()
  })

  it('解析器带错误码拒绝（会话被别处占用、agent 正忙）：原样报出错误码和消息，不执行', async () => {
    const { run, handler } = subject()
    expect(await handler(MEMORY_RPC_RUN, { sessionId: 'session-held', input: 'info' }, signal, owner))
      .toEqual({ ok: false, error: { code: 'session/writer-held', message: 'session is open in another window', details: {} } })
    expect(run).not.toHaveBeenCalled()
  })

  it('参数不对、端点不认识：bad-request', async () => {
    const { run, handler } = subject()
    for (const payload of [undefined, null, 'x', {}, { sessionId: 1, input: 'info' }, { sessionId: 'session-1' }]) {
      expect(await handler(MEMORY_RPC_RUN, payload, signal, owner)).toMatchObject({ ok: false, error: { code: 'plastic-memory/bad-request' } })
    }
    expect(await handler('nope', {}, signal, owner)).toMatchObject({ ok: false, error: { code: 'plastic-memory/bad-request' } })
    expect(run).not.toHaveBeenCalled()
  })

  it('命令处理器还没就位：unavailable', async () => {
    const { handler } = subject({ hasCommand: false })
    expect(await handler(MEMORY_RPC_RUN, { sessionId: 'session-1', input: 'info' }, signal, owner)).toMatchObject({ ok: false, error: { code: 'plastic-memory/unavailable' } })
  })
})
