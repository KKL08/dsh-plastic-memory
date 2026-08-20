import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import {
  pendingDecisionSchema, memorySnapshotSchema, scanCacheSchema,
  type PendingDecision, type MemorySnapshot, type ScanCacheEntry,
} from './governance/schema.ts'
import { recallStatsSchema, type RecallStats } from './storage/schema.ts'

export const memoryDomainSpec = defineDomain({
  name: 'plastic_memory', // 域名正则不允许连字符（UNIT_NAME_RE），用下划线
  version: 1, // 同版本加表（加载器把缺表初始化为空，向后兼容），不动版本号
  tables: {
    // P1.5：正文迁到文件存储（FileTable），KV 只留易变的召回统计 sidecar
    recall_stats: domainTable<string, RecallStats>(recallStatsSchema),
    pending_decisions: domainTable<string, PendingDecision>(pendingDecisionSchema),
    snapshots: domainTable<string, MemorySnapshot>(memorySnapshotSchema),
    scan_cache: domainTable<string, ScanCacheEntry>(scanCacheSchema),
  },
})
