import { describe, expect, it, vi } from 'vitest'
import { executeSource, renderSourceResult, extractEventText, type ReadEventFn } from '../src/tools/source.ts'
import { MemoryStore, InMemoryTable } from '../src/store.ts'
import type { MemoryRecord } from '../src/record-schema.ts'
import { record as baseRecord } from './helpers/record.ts'

// 本文件默认造一条 mem_a 的 workspace preference，源自固定会话 session-x（区间供开窗断言）。
const record = (partial: Partial<MemoryRecord> = {}) => baseRecord({
  id: 'mem_a', name: 'mock 禁令', type: 'preference', scope: 'workspace', workspacePath: '/proj',
  content: '不要 mock 数据库', summary: '不 mock',
  source: { sessionId: 'session-x', eventRange: [37, 42], sourceMode: 'user-explicit' },
  createdAt: 0, updatedAt: 0, lastConfirmedAt: 0, ...partial,
})

async function storeWith(...records: MemoryRecord[]): Promise<MemoryStore> {
  const store = new MemoryStore(new InMemoryTable())
  for (const r of records) await store.put(r)
  return store
}

const userEvent = (seq: number, text: string) => ({
  type: 'agent/inbox/spliced', seq,
  data: { inserted: [{ role: 'user', content: [{ type: 'text', text }] }] },
})

/** 宿主 tool/result 事件的真实形状：agent-loop 把 createToolResultMessage 的结果放进 data.message（对齐宿主）。 */
const toolResultEvent = (seq: number, text: string) => ({
  type: 'tool/result', seq, time: 0,
  data: {
    turn: 1, step: 2,
    message: {
      id: `msg-${seq}`, role: 'tool', source: { kind: 'tool', callId: `call-${seq}` }, toolCallId: `call-${seq}`,
      content: [{ type: 'text', text }], isError: false,
    },
  },
})

describe('executeSource', () => {
  const ctx = { workspacePath: '/proj' as string | undefined }

  it('命中：入口=当轮 turn/start 向后开窗（触发保存的用户原话必在窗内），渲染可读行并计结构事件', async () => {
    // 真机教训（2026-08-28）：入口若设在 end 向前开窗，长 turn（宽度 >> cap）只会读到
    // turn 尾部的结构事件，用户原话永远够不着——本断言钉住"入口在 start"这个方向。
    const store = await storeWith(record({}))
    const readEvent: ReadEventFn = vi.fn().mockResolvedValue({
      session: { id: 'session-x' },
      events: [{ type: 'turn/start', seq: 37, data: { turn: 3 } }, userEvent(38, '以后测试别 mock 数据库')],
      startSeq: 35, endSeq: 42,
    })
    const result = await executeSource({ memoryId: 'mem_a' }, ctx, { store, getReadEvent: () => readEvent })
    if (result.kind !== 'ok') throw new Error(result.kind)
    expect(readEvent).toHaveBeenCalledWith({ sessionId: 'session-x', seq: 37, before: 2, after: 5 })
    expect(result.lines).toEqual(['- [38] user: 以后测试别 mock 数据库'])
    expect(result.skipped).toBe(1)
    expect(result.range).toEqual([35, 42])
  })

  it('window 参数覆盖默认宽度并封顶 24', async () => {
    const store = await storeWith(record({}))
    const readEvent: ReadEventFn = vi.fn().mockResolvedValue({ events: [], startSeq: 0, endSeq: 42 })
    await executeSource({ memoryId: 'mem_a', window: 99 }, ctx, { store, getReadEvent: () => readEvent })
    expect(readEvent).toHaveBeenCalledWith(expect.objectContaining({ after: 24 }))
  })

  it('无 source（手编/手建文件）→ no-source，不调 readEvent；渲染说明无出处', async () => {
    const { source: _s, ...handWritten } = record({})
    const store = await storeWith(handWritten)
    const readEvent: ReadEventFn = vi.fn()
    const result = await executeSource({ memoryId: 'mem_a' }, ctx, { store, getReadEvent: () => readEvent })
    expect(result).toEqual({ kind: 'no-source', memoryId: 'mem_a' })
    expect(readEvent).not.toHaveBeenCalled()
    expect(renderSourceResult(result)).toContain('无出处')
  })

  it('记忆不存在或已删除 → not-found', async () => {
    const store = await storeWith(record({ id: 'mem_del', status: 'deleted' }))
    const deps = { store, getReadEvent: () => null }
    expect((await executeSource({ memoryId: 'mem_ghost' }, ctx, deps)).kind).toBe('not-found')
    expect((await executeSource({ memoryId: 'mem_del' }, ctx, deps)).kind).toBe('not-found')
  })

  it('⑧ 其他项目的 workspace 记忆 → forbidden（global 不受限）', async () => {
    const store = await storeWith(
      record({ id: 'mem_other', workspacePath: '/other' }),
      record({ id: 'mem_glob', scope: 'global', workspacePath: undefined }),
    )
    const readEvent: ReadEventFn = vi.fn().mockResolvedValue({ events: [] })
    const deps = { store, getReadEvent: () => readEvent }
    expect((await executeSource({ memoryId: 'mem_other' }, ctx, deps)).kind).toBe('forbidden')
    expect((await executeSource({ memoryId: 'mem_glob' }, ctx, deps)).kind).toBe('ok')
  })

  it('sessionQuery 缺席 → unavailable（优雅降级，不抛）', async () => {
    const store = await storeWith(record({}))
    const result = await executeSource({ memoryId: 'mem_a' }, ctx, { store, getReadEvent: () => null })
    expect(result.kind).toBe('unavailable')
  })

  it('readEvent 抛错（会话被清理）→ unavailable 带原因', async () => {
    const store = await storeWith(record({}))
    const readEvent: ReadEventFn = vi.fn().mockRejectedValue(new Error('session "session-x" not found'))
    const result = await executeSource({ memoryId: 'mem_a' }, ctx, { store, getReadEvent: () => readEvent })
    if (result.kind !== 'unavailable') throw new Error(result.kind)
    expect(result.reason).toContain('session "session-x" not found')
  })
})

describe('executeSource 在子 agent 会话里', () => {
  // 子会话 sess-child（深度 1，父为 sess-main）；context.delegation 来自宿主 header，存在即子会话
  const child = {
    workspacePath: '/proj' as string | undefined,
    session: { id: 'sess-child' },
    delegation: { depth: 1, parentSessionId: 'sess-main', mode: 'one-shot' as const },
  }

  it('出处在别的会话（含主会话）的记录 → subagent-restricted，不读事件；原因让模型带回主会话查', async () => {
    const store = await storeWith(
      record({ id: 'mem_main' }),
      record({ id: 'mem_sibling', source: { sessionId: 'sess-sibling', eventRange: [3, 8], sourceMode: 'agent-inferred' } }),
    )
    const readEvent: ReadEventFn = vi.fn()
    for (const memoryId of ['mem_main', 'mem_sibling']) {
      const result = await executeSource({ memoryId }, child, { store, getReadEvent: () => readEvent })
      expect(result, memoryId).toEqual({
        kind: 'rejected', memoryId, code: 'subagent-restricted', reason: '这条记忆的出处在别的会话，带回主会话查',
      })
      expect(renderSourceResult(result)).toContain('这条记忆的出处在别的会话，带回主会话查')
    }
    expect(readEvent).not.toHaveBeenCalled()
  })

  it('没有出处的手写记录同样不在本会话 → subagent-restricted', async () => {
    const { source: _s, ...handWritten } = record({})
    const store = await storeWith(handWritten)
    const result = await executeSource({ memoryId: 'mem_a' }, child, { store, getReadEvent: () => null })
    expect(result).toMatchObject({ kind: 'rejected', code: 'subagent-restricted' })
  })

  it('出处是本会话的记录照常回查', async () => {
    const store = await storeWith(record({ source: { sessionId: 'sess-child', eventRange: [37, 42], sourceMode: 'agent-inferred' } }))
    const readEvent: ReadEventFn = vi.fn().mockResolvedValue({ events: [], startSeq: 37, endSeq: 42 })
    const result = await executeSource({ memoryId: 'mem_a' }, child, { store, getReadEvent: () => readEvent })
    expect(result.kind).toBe('ok')
  })

  it('主会话（无 delegation）查别的会话的记录不受限', async () => {
    const store = await storeWith(record({}))
    const readEvent: ReadEventFn = vi.fn().mockResolvedValue({ events: [], startSeq: 35, endSeq: 42 })
    const main = { workspacePath: '/proj', session: { id: 'sess-main' } }
    expect((await executeSource({ memoryId: 'mem_a' }, main, { store, getReadEvent: () => readEvent })).kind).toBe('ok')
  })
})

/**
 * 假 sessionQuery.readEvent：按宿主的开窗规则从一段日志里切窗口——[seq - before, seq + after] 闭区间、含目标事件、
 * 两端夹在日志范围内（对齐宿主 session-query）。调用参数照常记录。
 */
function logReader(log: Array<{ type: string; seq: number; data?: unknown }>) {
  return vi.fn<ReadEventFn>(async ({ seq, before = 0, after = 0 }) => {
    const startSeq = Math.max(0, seq - before)
    const endSeq = Math.min(log.length - 1, seq + after)
    return { target: log[seq], events: log.slice(startSeq, endSeq + 1), startSeq, endSeq }
  })
}

describe('executeSource 的开窗方向', () => {
  const child = {
    workspacePath: '/proj' as string | undefined,
    session: { id: 'sess-child' },
    delegation: { depth: 1, parentSessionId: 'sess-main', mode: 'one-shot' as const },
  }
  const delegation = (sessionId: string) => ({ sessionId, depth: 1, parentSessionId: 'sess-main' })

  /**
   * fork 型子会话的日志：seq 0–5 是继承来的父会话前缀，子级本轮从 seq 6 的 turn/start 开始——
   * 委派指令、读文件的工具调用与结果，seq 10 是 memory_save 的调用（保存点）。
   */
  const forkLog = [
    { type: 'turn/start', seq: 0, data: { turn: 1 } },
    userEvent(1, '父会话：用户说的私事，子级不该读到'),
    { type: 'tool/call', seq: 2, data: { turn: 1, step: 1, callId: 'c0', name: 'read', arguments: {} } },
    toolResultEvent(3, '父会话的工具结果'),
    { type: 'turn/end', seq: 4, data: { turn: 1 } },
    userEvent(5, '父会话：去查一下测试框架'),
    { type: 'turn/start', seq: 6, data: { turn: 2 } },
    userEvent(7, '委派指令：查测试框架版本'),
    { type: 'tool/call', seq: 8, data: { turn: 2, step: 1, callId: 'c1', name: 'read', arguments: { path: 'package.json' } } },
    toolResultEvent(9, 'devDependencies: vitest 3.2.7'),
    { type: 'tool/call', seq: 10, data: { turn: 2, step: 2, callId: 'c2', name: 'memory_save', arguments: {} } },
    toolResultEvent(11, '已存入，待主会话确认'),
  ]
  const childRecord = (partial: Partial<MemoryRecord> = {}) => record({
    id: 'mem_child', type: 'knowledge',
    source: { sessionId: 'sess-child', eventRange: [6, 10], sourceMode: 'environment-observed' },
    delegation: delegation('sess-child'), ...partial,
  })

  it('子会话创建的记录：从保存点往前开到本轮起点、往后一条，输出含工具结果文本', async () => {
    const store = await storeWith(childRecord())
    const readEvent = logReader(forkLog)
    const result = await executeSource({ memoryId: 'mem_child' }, child, { store, getReadEvent: () => readEvent })
    if (result.kind !== 'ok') throw new Error(result.kind)
    expect(readEvent).toHaveBeenCalledWith({ sessionId: 'sess-child', seq: 10, before: 4, after: 1 })
    expect(result.lines).toContain('- [9] tool: devDependencies: vitest 3.2.7')
    expect(result.lines).toContain('- [7] user: 委派指令：查测试框架版本')
    expect(result.range).toEqual([6, 11])
  })

  it('fork 型子会话：窗口不越过本轮起点，读不到继承的父会话事件', async () => {
    const store = await storeWith(childRecord())
    for (const window of [undefined, 24]) {
      const result = await executeSource({ memoryId: 'mem_child', window }, child, { store, getReadEvent: () => logReader(forkLog) })
      if (result.kind !== 'ok') throw new Error(result.kind)
      const text = renderSourceResult(result)
      expect(text, String(window)).not.toContain('父会话')
      expect(result.range[0], String(window)).toBe(6)
    }
  })

  it('window 收窄往前开的条数；本轮再长也封顶 24', async () => {
    const store = await storeWith(childRecord({ source: { sessionId: 'sess-child', eventRange: [6, 90], sourceMode: 'agent-inferred' } }))
    const readEvent: ReadEventFn = vi.fn().mockResolvedValue({ events: [] })
    const deps = { store, getReadEvent: () => readEvent }
    await executeSource({ memoryId: 'mem_child', window: 5 }, child, deps)
    await executeSource({ memoryId: 'mem_child' }, child, deps)
    await executeSource({ memoryId: 'mem_child', window: 99 }, child, deps)
    expect(vi.mocked(readEvent).mock.calls.map(([req]) => req.before)).toEqual([5, 24, 24])
    expect(vi.mocked(readEvent).mock.calls.every(([req]) => req.seq === 90 && req.after === 1)).toBe(true)
  })

  it('主会话查子会话创建的记录同样往前开（方向看记录，不看谁在查）', async () => {
    const store = await storeWith(childRecord())
    const readEvent = logReader(forkLog)
    const main = { workspacePath: '/proj', session: { id: 'sess-main' } }
    await executeSource({ memoryId: 'mem_child' }, main, { store, getReadEvent: () => readEvent })
    expect(readEvent).toHaveBeenCalledWith({ sessionId: 'sess-child', seq: 10, before: 4, after: 1 })
  })

  it('主会话改写过的子会话记录：锚已换成主会话的，照旧从本轮起点往后开', async () => {
    const store = await storeWith(childRecord({ source: { sessionId: 'sess-main', eventRange: [37, 42], sourceMode: 'user-explicit' } }))
    const readEvent: ReadEventFn = vi.fn().mockResolvedValue({ events: [], startSeq: 35, endSeq: 42 })
    const main = { workspacePath: '/proj', session: { id: 'sess-main' } }
    await executeSource({ memoryId: 'mem_child' }, main, { store, getReadEvent: () => readEvent })
    expect(readEvent).toHaveBeenCalledWith({ sessionId: 'sess-main', seq: 37, before: 2, after: 5 })
  })
})

describe('extractEventText', () => {
  it('inbox 事件提取角色与文本；结构事件返回 null', () => {
    expect(extractEventText(userEvent(3, 'hi'))).toEqual({ role: 'user', text: 'hi' })
    expect(extractEventText({ type: 'turn/start', seq: 4, data: { turn: 1 } })).toBeNull()
    expect(extractEventText({ type: 'sandbox/mode', seq: 1 })).toBeNull()
  })

  it('宿主 tool/result 事件：取 data.message.content 的文本块，角色标 tool', () => {
    expect(extractEventText(toolResultEvent(9, '读到 package.json：vitest 3.2.7'))).toEqual({ role: 'tool', text: '读到 package.json：vitest 3.2.7' })
    // 只有非文本块的工具结果算结构事件
    const imageOnly = toolResultEvent(10, '')
    ;(imageOnly.data.message as { content: unknown[] }).content = [{ type: 'image', mediaType: 'image/png', data: 'AAAA' }]
    expect(extractEventText(imageOnly)).toBeNull()
  })
})

describe('renderSourceResult', () => {
  it('ok 含记忆 id、会话 id、区间与正文行', async () => {
    const text = renderSourceResult({
      kind: 'ok', memoryId: 'mem_a', sessionId: 'session-x', range: [37, 42],
      lines: ['- [37] user: 以后测试别 mock 数据库'], skipped: 2,
    }, 'mock 禁令')
    expect(text).toContain('mem_a')
    expect(text).toContain('mock 禁令')
    expect(text).toContain('session-x')
    expect(text).toContain('37–42')
    expect(text).toContain('以后测试别 mock 数据库')
    expect(text).toContain('另有 2 个结构事件')
  })

  it('unavailable 文案按设计降级：当先验使用并标注不确定', () => {
    const text = renderSourceResult({ kind: 'unavailable', memoryId: 'mem_a', reason: '会话查询服务未挂载' })
    expect(text).toContain('先验')
    expect(text).toContain('不确定')
  })

  it('forbidden 文案点明跨项目限制', () => {
    expect(renderSourceResult({ kind: 'forbidden', memoryId: 'mem_a' })).toContain('其他项目')
  })
})
