import { z } from 'zod';
import { memoryRecordSchema } from "../record-schema.js";
/** 与 mem_ id 同模式（pipeline.ts），不引入 nanoid。 */
export function genId(prefix) {
    return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
export const pendingDecisionSchema = z.object({
    id: z.string(),
    memoryIds: z.array(z.string()),
    baselineRef: z.string().optional(),
    summary: z.string(),
    firstSeenAt: z.number(),
});
export const memorySnapshotSchema = z.object({
    id: z.string(),
    createdAt: z.number(),
    operation: z.enum(['pre-forget', 'pre-resolve', 'manual', 'pre-promote', 'pre-update']),
    description: z.string(),
    memoryIds: z.array(z.string()),
    data: z.array(memoryRecordSchema),
});
export const FINDING_TYPES = [
    'secret', 'expired', 'bloat', 'orphan', 'malformed', // 规则层
    'conflict', 'redundancy', 'misplaced', 'unclear', // 语义层
];
export const SEVERITY_BY_TYPE = {
    secret: 'critical', conflict: 'critical',
    expired: 'warning', misplaced: 'warning', bloat: 'warning', malformed: 'warning',
    redundancy: 'info', unclear: 'info', orphan: 'info',
};
export const findingSchema = z.object({
    type: z.enum(FINDING_TYPES),
    layer: z.enum(['rule', 'semantic']),
    severity: z.enum(['critical', 'warning', 'info']),
    memoryIds: z.array(z.string()),
    summary: z.string(),
    suggestedAction: z.string(),
    baselineRef: z.string().optional(),
});
export const scanCacheSchema = z.object({
    id: z.string(),
    scannedAt: z.number(),
    scope: z.string(), // workspacePath 或 'all'
    findings: z.array(findingSchema),
});
