import { memorySnapshotSchema, pendingDecisionSchema, scanCacheSchema, adviceIgnoreSchema } from '../../src/governance/schema.ts'

export const sidecarSchemas = { snapshots: memorySnapshotSchema, pending: pendingDecisionSchema, scanCache: scanCacheSchema, adviceIgnores: adviceIgnoreSchema }
