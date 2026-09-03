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

describe('extractEventText', () => {
  it('inbox 事件提取角色与文本；结构事件返回 null', () => {
    expect(extractEventText(userEvent(3, 'hi'))).toEqual({ role: 'user', text: 'hi' })
    expect(extractEventText({ type: 'turn/start', seq: 4, data: { turn: 1 } })).toBeNull()
    expect(extractEventText({ type: 'sandbox/mode', seq: 1 })).toBeNull()
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
