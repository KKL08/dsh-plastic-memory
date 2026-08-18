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
  source: z.object({
    sessionId: z.string(),
    eventRange: z.tuple([z.number(), z.number()]),
    sourceMode: z.enum(['user-explicit', 'user-behavior', 'environment-observed', 'agent-inferred', 'agent-action-confirmed']),
  }),
  createdAt: z.number(),
  updatedAt: z.number(),
  lastConfirmedAt: z.number(),
  lastRecalledAt: z.number().nullable(),
  recallCount: z.number(),
  validFrom: z.number().optional(),
  validTo: z.number().optional(),
  status: z.enum(['active', 'stale', 'superseded', 'expired', 'deleted']),
  confidence: z.number().min(0).max(1),
  supersedes: z.array(z.string()).optional(),
  sensitivity: z.enum(['ordinary', 'private', 'sensitive', 'restricted']).optional(),
})
export type MemoryRecord = z.infer<typeof memoryRecordSchema>

export const CONFIDENCE_BY_SOURCE = {
  'user-explicit': 0.9,
  'agent-action-confirmed': 0.9,
  'user-behavior': 0.8,
  'environment-observed': 0.8,
  'agent-inferred': 0.5,
} as const satisfies Record<MemoryRecord['source']['sourceMode'], number>
