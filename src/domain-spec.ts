import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import {
  pendingDecisionSchema, memorySnapshotSchema, scanCacheSchema,
  type PendingDecision, type MemorySnapshot, type ScanCacheEntry,
} from './governance/schema.ts'
import { recallStatsSchema, type RecallStats } from './storage/schema.ts'

/** 旧宿主 KV 域（0.1.x）。0.2.0 起侧表住 <memoryRoot>/.state/（storage/sidecar.ts），本定义只用于首次
 *  侧表访问时打开旧域、导入 snapshots 与 pending_decisions；0.3.0 随导入代码删除。 */
export const memoryDomainSpec = defineDomain({
  name: 'plastic_memory', // 域名正则不允许连字符（UNIT_NAME_RE），用下划线
  version: 1, // 同版本加表（加载器把缺表初始化为空，向后兼容），不动版本号
  tables: {
    // 声明与 0.1.x 保持一致，导入只读其中 snapshots 与 pending_decisions 两张
    recall_stats: domainTable<string, RecallStats>(recallStatsSchema),
    pending_decisions: domainTable<string, PendingDecision>(pendingDecisionSchema),
    snapshots: domainTable<string, MemorySnapshot>(memorySnapshotSchema),
    scan_cache: domainTable<string, ScanCacheEntry>(scanCacheSchema),
  },
})
