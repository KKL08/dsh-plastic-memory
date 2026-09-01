import { z } from 'zod';
/** 易变召回统计的 KV sidecar 行（storageDomain 表 recall_stats）。
 *  文件永不承载这两个字段——否则每次 search 命中都产生文件 diff（git 噪音）。 */
export const recallStatsSchema = z.object({
    id: z.string(),
    recallCount: z.number(),
    lastRecalledAt: z.number().nullable(),
});
