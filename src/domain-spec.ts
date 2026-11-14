import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import {
  pendingDecisionSchema, memorySnapshotSchema, scanCacheSchema,
  type PendingDecision, type MemorySnapshot, type ScanCacheEntry,
} from './governance/schema.ts'
import { recallStatsSchema, type RecallStats } from './storage/schema.ts'
import type { z } from 'zod'

/** 宿主的 `domainTable` 参数类型绑定宿主自带的 zod 小版本（0.2.2-rc.1 是 4.4，rc.3 起是 4.6），
 *  插件的 zod 与之不同时类型对不上。宿主运行时只调 `parse` / `safeParse`，zod 4 各版本都有，
 *  所以在这里换成宿主要的类型，不随宿主的 zod 版本变化。 */
const hostTable = <V>(schema: z.ZodType<V>) =>
  domainTable<string, V>(schema as unknown as Parameters<typeof domainTable<string, V>>[0])

/** 旧宿主 KV 域（0.1.x）。0.2.0 起侧表住 <memoryRoot>/.state/（storage/sidecar.ts），本定义只用于首次
 *  侧表访问时打开旧域、导入 snapshots 与 pending_decisions；0.3.0 随导入代码删除。 */
export const memoryDomainSpec = defineDomain({
  name: 'plastic_memory', // 域名正则不允许连字符（UNIT_NAME_RE），用下划线
  version: 1, // 同版本加表（加载器把缺表初始化为空，向后兼容），不动版本号
  tables: {
    // 声明与 0.1.x 保持一致，导入只读其中 snapshots 与 pending_decisions 两张
    recall_stats: hostTable<RecallStats>(recallStatsSchema),
    pending_decisions: hostTable<PendingDecision>(pendingDecisionSchema),
    snapshots: hostTable<MemorySnapshot>(memorySnapshotSchema),
    scan_cache: hostTable<ScanCacheEntry>(scanCacheSchema),
  },
})
