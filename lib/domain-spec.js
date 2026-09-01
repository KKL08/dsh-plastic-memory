import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
import { pendingDecisionSchema, memorySnapshotSchema, scanCacheSchema, } from "./governance/schema.js";
import { recallStatsSchema } from "./storage/schema.js";
export const memoryDomainSpec = defineDomain({
    name: 'plastic_memory', // 域名正则不允许连字符（UNIT_NAME_RE），用下划线
    version: 1, // 同版本加表（加载器把缺表初始化为空，向后兼容），不动版本号
    tables: {
        // 正文住文件存储（FileTable），KV 只放易变的召回统计 sidecar
        recall_stats: domainTable(recallStatsSchema),
        pending_decisions: domainTable(pendingDecisionSchema),
        snapshots: domainTable(memorySnapshotSchema),
        scan_cache: domainTable(scanCacheSchema),
    },
});
