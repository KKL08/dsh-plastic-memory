import { z } from 'zod'

export const memoryRecordSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  type: z.string(),
  scope: z.enum(['global', 'workspace']),
  workspacePath: z.string().optional(),
  tags: z.array(z.string()),
  content: z.string(),
  summary: z.string(),
  /** 缺省 = 手编/无出处（手建文件）：不带「模型推断」标注，memory_source 回「无出处」。 */
  source: z.object({
    sessionId: z.string(),
    eventRange: z.tuple([z.number(), z.number()]),
    sourceMode: z.enum(['user-explicit', 'user-behavior', 'environment-observed', 'agent-inferred', 'agent-action-confirmed']),
  }).optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  lastConfirmedAt: z.number(),
  lastRecalledAt: z.number().nullable(),
  recallCount: z.number(),
  validFrom: z.number().optional(),
  validTo: z.number().optional(),
  status: z.enum(['active', 'superseded', 'deleted']),
  confidence: z.number().min(0).max(1),
  supersedes: z.array(z.string()).optional(),
  /** 模型自主判断"该全局"但无权直写 global：落 workspace 时打此标记，治理时作为提升候选。 */
  globalCandidate: z.boolean().optional(),
  /** 文件内容与 digest 不符（被手改过）：出处可能不对应。memory_save update 重写时清除。 */
  handEdited: z.boolean().optional(),
  /** 软删时刻（清扫按它计窗口）。 */
  deletedAt: z.number().optional(),
})
export type MemoryRecord = z.infer<typeof memoryRecordSchema>
export type SourceMode = NonNullable<MemoryRecord['source']>['sourceMode']

export const CONFIDENCE_BY_SOURCE = {
  'user-explicit': 0.9,
  'agent-action-confirmed': 0.9,
  'user-behavior': 0.8,
  'environment-observed': 0.8,
  'agent-inferred': 0.5,
} as const satisfies Record<SourceMode, number>
