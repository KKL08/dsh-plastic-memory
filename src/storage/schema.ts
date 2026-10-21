import { z } from 'zod'

/** 易变召回统计的侧表行（`.state/recall-stats.json` 里的一条，见 storage/sidecar.ts）。
 *  文件永不承载这两个字段——否则每次 search 命中都产生文件 diff（git 噪音）。 */
export const recallStatsSchema = z.object({
  id: z.string(),
  recallCount: z.number(),
  lastRecalledAt: z.number().nullable(),
})
export type RecallStats = z.infer<typeof recallStatsSchema>

/** 旧宿主 KV 导入的完成标记 `.state/kv-import.json`。source = none 表示宿主没有 storageDomain，无可导。
 *  counts 是成功落成文件（新建或早已存在）的旧 KV 条目数。 */
export const kvImportMarkerSchema = z.object({
  version: z.literal(1),
  importedAt: z.number(),
  source: z.enum(['kv', 'none']),
  counts: z.object({ snapshots: z.number(), pending: z.number() }),
})
export type KvImportMarker = z.infer<typeof kvImportMarkerSchema>
