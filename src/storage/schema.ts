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
 * 建议忽略表的一行（`.state/advice-ignores/<sha1(id)>.json`，见 storage/sidecar.ts）：用户对一条建议整理项点了「忽略」。
 * id 即身份：问题类型 + 排序后的记忆 id（见 governance/advice-ignores.ts adviceIdentity），同一项只有一个文件，
 * 并发忽略同一项落到同一个文件上。fingerprints 与 memoryIds 一一对应，是忽略时每条记忆的内容指纹；对不上就不算已忽略。
 * type 存成字符串（取值见 contract-codes.ts IGNORABLE_ADVICE_TYPES）：新版本加的类型旧版本读得出，只是不匹配。
 */
export const adviceIgnoreSchema = z.object({
  id: z.string(),
  type: z.string(),
  memoryIds: z.array(z.string()).min(1),
  fingerprints: z.array(z.string()),
  ignoredAt: z.number(),
})
export type AdviceIgnore = z.infer<typeof adviceIgnoreSchema>
