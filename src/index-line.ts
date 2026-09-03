import type { MemoryRecord } from './record-schema.ts'

/** 低置信（模型推断）标注，索引行 / 快照 / search 结果共用同一份文案。 */
export const INFERENCE_NOTE = '（模型推断，未经确认）'

export function sourceNote(r: MemoryRecord): string {
  // 判据是 sourceMode 而非 confidence：任何来源都可被下调，user-explicit 存 0.7 会被阈值误标
  return r.source.sourceMode === 'agent-inferred' ? INFERENCE_NOTE : ''
}

export function formatIndexLine(r: MemoryRecord, opts: { passive: boolean }): string {
  const tags = r.tags.length > 0 ? ` — ${r.tags.join(', ')}` : ''
  if (opts.passive) return `- [${r.id}] ${r.name}${tags}${sourceNote(r)}`  // passive 同样带低置信标注
  return `- [${r.id}] ${r.name}（${r.summary}）${tags}${sourceNote(r)}`
}
