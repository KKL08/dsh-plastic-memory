import { describe, expect, it } from 'vitest'
import { memoryRecordSchema, CONFIDENCE_BY_SOURCE } from '../src/record-schema.ts'

const valid = {
  id: 'mem_abc', name: 'mock 禁令', type: 'preference', scope: 'global', tags: [],
  content: '测试里不要 mock 数据库', summary: '不 mock 数据库',
  source: { sessionId: 's1', eventRange: [0, 10], sourceMode: 'user-explicit' },
  createdAt: 1, updatedAt: 1, lastConfirmedAt: 1, lastRecalledAt: null,
  recallCount: 0, status: 'active', confidence: 0.9,
}

describe('memoryRecordSchema', () => {
  it('合法记录通过', () => {
    expect(memoryRecordSchema.parse(valid)).toEqual(valid)
  })
  it('confidence 超出 0-1 拒绝', () => {
    expect(() => memoryRecordSchema.parse({ ...valid, confidence: 1.5 })).toThrow()
  })
  it('缺 summary 拒绝', () => {
    const { summary, ...rest } = valid
    expect(() => memoryRecordSchema.parse(rest)).toThrow()
  })
})

describe('CONFIDENCE_BY_SOURCE', () => {
  it('五种 sourceMode 全覆盖且与 Spec 一致', () => {
    expect(CONFIDENCE_BY_SOURCE['user-explicit']).toBe(0.9)
    expect(CONFIDENCE_BY_SOURCE['agent-inferred']).toBe(0.5)
    expect(Object.keys(CONFIDENCE_BY_SOURCE)).toHaveLength(5)
  })
})

describe('status 枚举收敛', () => {
  it("只接受 active/superseded/deleted；stale/expired 已删除（渲染时计算取代状态流转）", () => {
    const base = {
      id: 'mem_x', name: 'n', type: 'knowledge', scope: 'global' as const, tags: [],
      content: 'c', summary: 's',
      source: { sessionId: 's', eventRange: [0, 1] as [number, number], sourceMode: 'user-explicit' as const },
      createdAt: 1, updatedAt: 1, lastConfirmedAt: 1, lastRecalledAt: null,
      recallCount: 0, confidence: 0.9,
    }
    for (const ok of ['active', 'superseded', 'deleted']) {
      expect(memoryRecordSchema.safeParse({ ...base, status: ok }).success).toBe(true)
    }
    for (const gone of ['stale', 'expired']) {
      expect(memoryRecordSchema.safeParse({ ...base, status: gone }).success).toBe(false)
    }
  })
})
