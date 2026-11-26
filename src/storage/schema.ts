import { z } from 'zod'
import { CHECKUP_INITIATORS } from '../contract-codes.ts'
import { autoCheckupFrequencySchema, checkupCauseSchema, checkupCoverageSchema, checkupResultSchema, modelSelectionSchema, modelUnavailableCauseSchema } from '../gui/contract.ts'

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
 * `global` 或项目的绝对路径（见 gui/contract.ts checkupKey）；另有键 `all` 的一条，只有 lastResult。
 * completed 是完成记录：这个范围最近一次做完的体检（规则检查和内容检查都写完：缓存、账本、提升候选），即「上次体检」。
 * 还没有做完过的范围没有它。
 * failure 是自动体检的连续失败（次数、下次重试时间、最近一次的原因），modelUnavailable 是最近一次自动体检的尝试碰上模型用不了的原因；
 * 都由调度器写，这个范围写完成记录时一并清掉（见 governance/checkup-records.ts）。
 * lastResult 是最近一次界面手动或自动体检的结果（见 gui/contract.ts checkupResultSchema），写完成记录、记失败都不动它。
 */
export const checkupRecordSchema = z.object({
  id: z.string(),
  completed: z.object({
    startedAt: z.number(),
    completedAt: z.number(),
    by: z.enum(CHECKUP_INITIATORS),
    /** 这次的内容检查覆盖（见 gui/contract.ts checkupCoverageSchema）；上一个发布版写的没有，写回时也会丢掉。 */
    coverage: checkupCoverageSchema.optional(),
  }).optional(),
  /**
   * 一次没查完的体检约的下次自动体检时间：到了上限停下（完成后一天），或有没命中的批但一批都没轮到（那时起一天）。
   * 晚于上次体检时，下次自动体检取它和按周期算的较早的那个；之后写完成记录时随之换掉或清掉。
   */
  continueAt: z.number().optional(),
  /** 自动体检连续没做完：次数、最近一次失败的时刻、原因。重试时间不存，生成体检视图时按当时的有效频率现算（见 gui/views.ts）。 */
  failure: z.object({
    count: z.number().int().positive(),
    failedAt: z.number(),
    cause: checkupCauseSchema,
  }).optional(),
  modelUnavailable: modelUnavailableCauseSchema.optional(),
  lastResult: checkupResultSchema.optional(),
  /** 这个范围上次整理索引做完的时刻。 */
  organizedAt: z.number().optional(),
})
export type CheckupRecord = z.infer<typeof checkupRecordSchema>
export type CheckupCompletion = NonNullable<CheckupRecord['completed']>

/**
 * 自动体检设置表的一行（`.state/auto-checkups/<sha1(id)>.json`，见 storage/sidecar.ts），一个范围一条。id 是范围键：
 * `all`（「全部」的默认值）、`global` 或项目的绝对路径（见 gui/contract.ts checkupKey）。frequency 是 manual 或 1–90 天。
 * 没有某个范围的条目 = 跟随 `all`；没有 `all` = 仅手动，所以表空着就是全部仅手动。
 */
export const autoCheckupSettingSchema = z.object({
  id: z.string(),
  frequency: autoCheckupFrequencySchema,
})
export type AutoCheckupSetting = z.infer<typeof autoCheckupSettingSchema>

/**
 * 模型选择表的一行（`.state/model-selections/<sha1(id)>.json`，见 storage/sidecar.ts），一个选择键一条。id 是选择键
 * （`checkup`、`dreams`、`expansion`，见 gui/contract.ts MODEL_SELECTION_KEYS），其余字段是那份选择（提供方、模型、可选的推理强度）。
 * 没有某个键的条目 = 跟随。几个宿主进程共用，开跑时现读。
 */
export const modelSelectionRowSchema = modelSelectionSchema.extend({ id: z.string() })
export type ModelSelectionRow = z.infer<typeof modelSelectionRowSchema>

/**
 * 记忆梦境的开关和运行记录（`.state/dreams/<sha1(id)>.json`，见 storage/sidecar.ts）。id 是范围键（`global` 或项目的绝对路径），
 * 另有两个特殊的键：`all` 只放默认开关（管没单独设过的范围），`usage` 只放用量。
 * - enabled：这个范围单独设的开关；没有这个键 = 跟随 `all`，`all` 也没有 = 关。
 * - completed：最近一次做完的运行。间隔从它算，没做完的运行不动它。
 * - unfinished：最近一次没做完的运行；运行一开始就写上（原因先记成 lost），做完才清。reason 开放取值
 *   （yielded 让路、failed 出错、lost 认领被接手或进程中途退出、model-unavailable），不认识的按 failed 待。
 *   entryIds 是还要收尾的账本条目。quotaUsed 是没做完的几次运行合起来已经用掉的改动量名额：续跑从这个数接着扣，做完清掉；
 *   没有这一项（上一版写的）按 0 算。
 * - failure：连续出错的次数和最近一次的时刻；让路、认领被接手不计，做完一次清零。
 * - lastResult：最近一次运行的结果（做完没做完都记），给界面显示。skipped 是这次跳过没做的操作（依据变了、目标锁定、不在用、
 *   超出改动量上限等），items 只留前若干条（tools/dreams-run.ts 的 DREAMS_SKIPPED_MAX），total 是总数；kind、reason 开放取值。
 * - runs：只在 `usage` 那条上，一次运行一行、逐次累加，只留最近七天的。
 */
const dreamsStepSchema = z.object({ name: z.string(), state: z.string() })
export const dreamsRecordSchema = z.object({
  id: z.string(),
  enabled: z.boolean().optional(),
  completed: z.object({ runId: z.string(), startedAt: z.number(), endedAt: z.number() }).optional(),
  unfinished: z.object({
    runId: z.string(), startedAt: z.number(), stoppedAt: z.number(), reason: z.string(), entryIds: z.array(z.string()).optional(),
    quotaUsed: z.number().int().nonnegative().optional(),
  }).optional(),
  failure: z.object({ count: z.number().int().positive(), failedAt: z.number() }).optional(),
  lastResult: z.object({
    runId: z.string(),
    kind: z.string(),
    by: z.string(),
    endedAt: z.number(),
    steps: z.array(dreamsStepSchema),
    usageTokens: z.number(),
    modelFallback: z.object({ to: z.string(), reason: z.string() }).optional(),
    entryId: z.string().optional(),
    skipped: z.object({
      items: z.array(z.object({ step: z.string(), kind: z.string(), target: z.string(), reason: z.string() })),
      total: z.number(),
    }).optional(),
  }).optional(),
  runs: z.array(z.object({ runId: z.string(), at: z.number(), tokens: z.number() })).optional(),
  /** 用户撤销过的梦境合并结论（governance/dreams-merge.ts mergeConclusion），按记下的先后，只留最近的若干个。 */
  undoneMerges: z.array(z.object({ key: z.string(), at: z.number() })).optional(),
})
export type DreamsRecord = z.infer<typeof dreamsRecordSchema>

/**
 * 记忆梦境的变化基线（`.state/dream-marks/<sha1(id)>.json`），一个范围一条：runId 那次运行开始时读到的在用记忆，
 * 记忆 id → 内容指纹（governance/dreams-gate.ts dreamContentFingerprint）。只有 runId 等于这个范围 completed.runId 时才算数：
 * 基线先写、完成记录后写，两次写之间断了就对不上，按基线不可用处理。
 */
export const dreamMarksSchema = z.object({
  id: z.string(),
  runId: z.string(),
  takenAt: z.number(),
  marks: z.record(z.string(), z.string()),
})
export type DreamMarks = z.infer<typeof dreamMarksSchema>

/**
 * 活动表的一行（`.state/activity/<sha1(id)>.json`），一个宿主进程一条，id 是进程启动时生成的。at 是最近一次写入（有会话在跑期间定时刷新）；
 * workspaces 的键是工作目录键（项目的绝对路径，没有工作目录的会话用 `global`，还没解析出来的用 `?`）：
 * isRunning 这个进程里它有没有会话在跑，lastActiveAt 最近一次开始或停下的时刻，lastStartedAt 最近一次开始跑的时刻。
 */
export const activityEntrySchema = z.object({
  id: z.string(),
  at: z.number(),
  workspaces: z.record(z.string(), z.object({ isRunning: z.boolean(), lastActiveAt: z.number(), lastStartedAt: z.number().optional() })),
})
export type ActivityEntry = z.infer<typeof activityEntrySchema>
