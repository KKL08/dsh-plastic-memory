import { describe, expect, it } from 'vitest'
import {
  genId, pendingDecisionSchema, memorySnapshotSchema, findingSchema,
  scanCacheSchema, SEVERITY_BY_TYPE, FINDING_TYPES,
} from '../src/governance/schema.ts'
import { InMemoryKvTable, wrapSyncKvTable } from '../src/kv-table.ts'

describe('genId', () => {
  it('生成带前缀的短 id，同前缀两次不重复', () => {
    const a = genId('pd')
    const b = genId('pd')
    expect(a).toMatch(/^pd_[a-z0-9]+$/)
    expect(a).not.toBe(b)
  })
})

describe('governance schemas', () => {
  it('pendingDecision 校验通过且拒绝缺字段', () => {
    const ok = pendingDecisionSchema.safeParse({
      id: 'pd_x', memoryIds: ['mem_a', 'mem_b'], summary: '冲突', firstSeenAt: 1,
    })
    expect(ok.success).toBe(true)
    expect(pendingDecisionSchema.safeParse({ id: 'pd_x' }).success).toBe(false)
  })

  it('snapshot 的 operation 接受四个枚举值、拒绝未知值', () => {
    const base = { id: 'snap_x', createdAt: 1, description: 'd', memoryIds: [], data: [] }
    expect(memorySnapshotSchema.safeParse({ ...base, operation: 'pre-forget' }).success).toBe(true)
    expect(memorySnapshotSchema.safeParse({ ...base, operation: 'pre-promote' }).success).toBe(true)
    expect(memorySnapshotSchema.safeParse({ ...base, operation: 'pre-cleanup' }).success).toBe(false)
  })

  it('finding 类型枚举共 9 个且 severity 映射完整', () => {
    expect(FINDING_TYPES).toHaveLength(9)
    for (const t of FINDING_TYPES) {
      expect(['critical', 'warning', 'info']).toContain(SEVERITY_BY_TYPE[t])
    }
    expect(SEVERITY_BY_TYPE.secret).toBe('critical')
    expect(SEVERITY_BY_TYPE.conflict).toBe('critical')
    expect(SEVERITY_BY_TYPE.expired).toBe('warning')
    expect(SEVERITY_BY_TYPE.redundancy).toBe('info')
    expect(SEVERITY_BY_TYPE.malformed).toBe('warning')
  })

  it('scanCache 校验 findings 数组内部结构', () => {
    const ok = scanCacheSchema.safeParse({
      id: 'cache_all', scannedAt: 1, scope: 'all',
      findings: [{ type: 'conflict', layer: 'semantic', severity: 'critical', memoryIds: ['mem_a'], summary: 's', suggestedAction: 'a' }],
    })
    expect(ok.success).toBe(true)
    const bad = scanCacheSchema.safeParse({
      id: 'cache_all', scannedAt: 1, scope: 'all', findings: [{ type: '不存在' }],
    })
    expect(bad.success).toBe(false)
  })
})

describe('InMemoryKvTable', () => {
  it('put/get/delete/list 基本行为', async () => {
    const t = new InMemoryKvTable<{ v: number }>()
    await t.put('a', { v: 1 })
    expect(await t.get('a')).toEqual({ v: 1 })
    expect(await t.list()).toEqual([['a', { v: 1 }]])
    expect(await t.delete('a')).toBe(true)
    expect(await t.delete('a')).toBe(false)
    expect(await t.get('a')).toBeUndefined()
  })
})

describe('wrapSyncKvTable（宿主 storageDomain 表的同步读形状 → 异步 KvTable）', () => {
  it('get/list 包成 Promise，put/delete 透传，不复制也不改写值', async () => {
    const map = new Map<string, { v: number }>()
    const host = {
      get: (key: string) => map.get(key),
      entries: () => map.entries(),
      put: async (key: string, value: { v: number }) => { map.set(key, value) },
      delete: async (key: string) => map.delete(key),
    }
    const t = wrapSyncKvTable(host)
    const value = { v: 1 }
    await t.put('a', value)
    expect(map.get('a')).toBe(value)
    expect(await t.get('a')).toBe(value)
    expect(await t.list()).toEqual([['a', value]])
    expect(await t.delete('a')).toBe(true)
    expect(await t.delete('a')).toBe(false)
    expect(await t.get('a')).toBeUndefined()
    expect(await t.list()).toEqual([])
  })
})
