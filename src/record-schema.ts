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
  /**
   * 子 agent 写入的委派信息（宿主填）。缺省 = 主会话或手建。顶层键：旧版插件把它当未知键原样保留，嵌进 source 会在维护回写时丢掉。
   * 创建者四个字段写入后不再改，升档只加 reviewed。
   */
  delegation: z.object({
    /** 创建这条记录的子会话；主会话改写后 source.sessionId 变成主会话，这里不变 */
    sessionId: z.string(),
    depth: z.number().int().min(1),
    parentSessionId: z.string(),
    /** 解析不到根会话时缺省，不阻塞保存 */
    rootSessionId: z.string().optional(),
    /** 谁把它升成主档；缺省 = 待确认 */
    reviewed: z.object({ by: z.enum(['user', 'main']), at: z.number() }).optional(),
  }).optional(),
  /** 软删时刻（清扫按它计窗口）。 */
  deletedAt: z.number().optional(),
})
export type MemoryRecord = z.infer<typeof memoryRecordSchema>
/** 待确认 = 子 agent 写入且还没有主会话或用户升档。只看这两个字段，状态（在用、已删除、过期）由调用处按各自口径过滤。 */
export function isPendingDelegated(record: Pick<MemoryRecord, 'delegation'>): boolean {
  return record.delegation !== undefined && record.delegation.reviewed === undefined
}
export type SourceMode = NonNullable<MemoryRecord['source']>['sourceMode']

export const CONFIDENCE_BY_SOURCE = {
  'user-explicit': 0.9,
  'agent-action-confirmed': 0.9,
  'user-behavior': 0.8,
  'environment-observed': 0.8,
  'agent-inferred': 0.5,
} as const satisfies Record<SourceMode, number>
