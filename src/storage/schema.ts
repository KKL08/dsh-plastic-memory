import { z } from 'zod'
import { CHECKUP_INITIATORS } from '../contract-codes.ts'

/** 易变召回统计的侧表行（`.state/recall-stats.json` 里的一条，见 storage/sidecar.ts）。
 *  文件永不承载这两个字段——否则每次 search 命中都产生文件 diff（git 噪音）。 */
export const recallStatsSchema = z.object({
  id: z.string(),
  recallCount: z.number(),
  lastRecalledAt: z.number().nullable(),
})
export type RecallStats = z.infer<typeof recallStatsSchema>

/** 旧宿主 KV 导入的完成标记 `.state/kv-import.json`。source = none 表示宿主没有 storageDomain，无可导。
 *  counts 是成功落成文件（新建或早已存在）的旧 KV 条目数。
 *  discarded 只对 source = kv 有意义：true = 旧 KV 行已删净；false 或缺失（早先版本写的标记）= 待清理，
 *  后续启动重试删除、不重导。 */
export const kvImportMarkerSchema = z.object({
  version: z.literal(1),
  importedAt: z.number(),
  source: z.enum(['kv', 'none']),
  counts: z.object({ snapshots: z.number(), pending: z.number() }),
  discarded: z.boolean().optional(),
})
export type KvImportMarker = z.infer<typeof kvImportMarkerSchema>

/**
 * 体检记录表的一行（`.state/checkups/<sha1(id)>.json`，见 storage/sidecar.ts），每个范围一条。id 是范围键：
 * `global` 或项目的绝对路径（见 governance/checkup-records.ts checkupKey）。
 * completed 是完成记录：这个范围最近一次做完的体检（规则检查和内容检查都写完：缓存、账本、提升候选），即「上次体检」。
 * 还没有做完过的范围没有它。
 */
export const checkupRecordSchema = z.object({
  id: z.string(),
  completed: z.object({
    startedAt: z.number(),
    completedAt: z.number(),
    by: z.enum(CHECKUP_INITIATORS),
  }).optional(),
})
export type CheckupRecord = z.infer<typeof checkupRecordSchema>
export type CheckupCompletion = NonNullable<CheckupRecord['completed']>
