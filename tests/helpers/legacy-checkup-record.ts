import { z } from 'zod'

/**
 * 上一个发布版（0.2.0）读体检记录的 schema，原样抄下来作「旧版读法」：同一个记忆根上可能还开着旧版的进程，
 * 新版写进共享体检记录的东西，旧版要能读、不能让它跳过整条记录。说明码在旧版是严格枚举，对象对不认识的键是丢弃。
 * 只在旧版的读法真的变了时才改这份，平时不跟着新版的 schema 走。
 */
const SCAN_NOTE_CODES = [
  'semantic-unavailable', 'no-layer-executed', 'semantic-batched', 'semantic-failed', 'model-unavailable',
  'baseline-missing', 'baseline-truncated', 'cross-ws-failed', 'conflicts-settled',
] as const
const RETIRED_SCAN_NOTE_CODES = ['baseline-session-scoped'] as const
const CHECKUP_INITIATORS = ['manual', 'auto', 'agent'] as const
const CHECKUP_CAUSE_KINDS = ['no-default-model', 'model-error', 'unparseable', 'error'] as const

const scopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('global') }),
  z.object({ kind: z.literal('workspace'), workspacePath: z.string() }),
])

const checkupCauseSchema = z.object({
  kind: z.enum(CHECKUP_CAUSE_KINDS),
  hostCode: z.string().optional(),
  message: z.string().optional(),
})

const checkupAddedSchema = z.object({
  keys: z.array(z.string()),
  pending: z.number().int().nonnegative(),
  advice: z.number().int().nonnegative(),
})

const checkupResultSchema = z.object({
  checkupId: z.string(),
  by: z.enum(CHECKUP_INITIATORS).exclude(['agent']),
  completedAt: z.number(),
  added: checkupAddedSchema,
  globalAdded: checkupAddedSchema.optional(),
  byScope: z.array(z.object({ scope: scopeSchema, keys: z.array(z.string()) })).optional(),
  usageTokens: z.number().int().nonnegative().optional(),
  notes: z.preprocess(
    notes => (Array.isArray(notes) ? notes.filter(n => !(RETIRED_SCAN_NOTE_CODES as readonly unknown[]).includes((n as { code?: unknown } | null)?.code)) : notes),
    z.array(z.object({ code: z.enum(SCAN_NOTE_CODES), cause: checkupCauseSchema.optional() })),
  ),
})

export const legacyCheckupRecordSchema = z.object({
  id: z.string(),
  completed: z.object({
    startedAt: z.number(),
    completedAt: z.number(),
    by: z.enum(CHECKUP_INITIATORS),
  }).optional(),
  failure: z.object({
    count: z.number().int().positive(),
    failedAt: z.number(),
    cause: checkupCauseSchema,
  }).optional(),
  modelUnavailable: checkupCauseSchema.optional(),
  lastResult: checkupResultSchema.optional(),
})
