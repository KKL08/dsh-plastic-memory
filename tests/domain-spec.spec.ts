import { describe, expect, it } from 'vitest'
import { memoryDomainSpec } from '../src/domain-spec.ts'

// memoryDomainSpec 是存储域的身份 + 布局 + 每表 schema 的单一来源。
// 边缘案例（每条一个 it）：
// 1. 域名恰为 'plastic_memory' 且不含连字符（UNIT_NAME_RE 不允许连字符，故用下划线）。
// 2. version === 1 且为非负整数（同版本加表，不动版本号）。
// 3. 恰好声明四张表，键集精确——防止某表被悄悄改名/增删。
// 4-7. 每张表的 valueSchema 绑定到其目标 schema：喂一条该表的合法记录必须通过；
//      若两表 schema 被接错，目标记录会被另一 schema 拒绝而使断言失败。

describe('memoryDomainSpec 身份与版本', () => {
  it('域名恰为 plastic_memory 且不含连字符', () => {
    expect(memoryDomainSpec.name).toBe('plastic_memory')
    expect(memoryDomainSpec.name).not.toContain('-')
  })

  it('version 为 1 且为非负整数', () => {
    expect(memoryDomainSpec.version).toBe(1)
    expect(Number.isInteger(memoryDomainSpec.version)).toBe(true)
  })
})

describe('memoryDomainSpec 表布局', () => {
  it('恰好声明 recall_stats/pending_decisions/snapshots/scan_cache 四张表', () => {
    expect(Object.keys(memoryDomainSpec.tables).sort()).toEqual(
      ['pending_decisions', 'recall_stats', 'scan_cache', 'snapshots'],
    )
  })
})

describe('memoryDomainSpec 表 schema 绑定', () => {
  it('recall_stats 接受其目标记录（recallStatsSchema）', () => {
    const rec = { id: 'mem_a', recallCount: 3, lastRecalledAt: null }
    expect(memoryDomainSpec.tables.recall_stats.valueSchema.safeParse(rec).success).toBe(true)
  })

  it('pending_decisions 接受其目标记录（pendingDecisionSchema）', () => {
    const rec = { id: 'pd_a', memoryIds: ['mem_a'], summary: '冲突', firstSeenAt: 1 }
    expect(memoryDomainSpec.tables.pending_decisions.valueSchema.safeParse(rec).success).toBe(true)
  })

  it('snapshots 接受其目标记录（memorySnapshotSchema）', () => {
    const rec = {
      id: 'snap_a', createdAt: 1, operation: 'manual', description: '手动',
      memoryIds: [], data: [],
    }
    expect(memoryDomainSpec.tables.snapshots.valueSchema.safeParse(rec).success).toBe(true)
  })

  it('scan_cache 接受其目标记录（scanCacheSchema）', () => {
    const rec = { id: 'sc_a', scannedAt: 1, scope: 'all', findings: [] }
    expect(memoryDomainSpec.tables.scan_cache.valueSchema.safeParse(rec).success).toBe(true)
  })
})
