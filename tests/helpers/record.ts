import type { MemoryRecord } from '../../src/record-schema.ts'
import { nextId } from './ids.ts'

/**
 * Canonical MemoryRecord fixture with neutral defaults and a deterministic id.
 * `partial` is spread last, so any field can be overridden. Files that relied on
 * non-neutral defaults keep a one-line local wrapper around this (see specs).
 *
 * Timestamps default to `1` (not `clock.ts` NOW) purely to preserve the data the
 * migrated specs already used: most local fixtures set `1`, and changing the base
 * would silently alter what those tests exercise. Specs that care about freshness
 * set `lastConfirmedAt` explicitly, so the base value never decides a verdict.
 */
export function record(partial: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: nextId(),
    name: '条目',
    type: 'knowledge',
    scope: 'global',
    tags: [],
    content: '内容',
    summary: '摘要',
    source: { sessionId: 's', eventRange: [0, 1], sourceMode: 'user-explicit' },
    createdAt: 1,
    updatedAt: 1,
    lastConfirmedAt: 1,
    lastRecalledAt: null,
    recallCount: 0,
    status: 'active',
    confidence: 0.9,
    ...partial,
  }
}

/** SaveCandidate fixture (moved verbatim from pipeline.spec), same create defaults. */
export function candidate(partial: object = {}) {
  return {
    action: 'create' as const,
    name: 'mock 禁令',
    type: 'preference',
    scope: 'global' as const,
    content: '测试里不要 mock 数据库',
    summary: '不 mock 数据库',
    tags: [],
    sourceMode: 'user-explicit' as const,
    ...partial,
  }
}
