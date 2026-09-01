import type { MemoryRecord } from './record-schema.ts'

export function sourceNote(r: MemoryRecord): string {
  // 判据是 sourceMode 而非 confidence：任何来源都可被下调，user-explicit 存 0.7 会被阈值误标
  return r.source.sourceMode === 'agent-inferred' ? '（模型推断，未经确认）' : ''
}

export function formatIndexLine(r: MemoryRecord, opts: { passive: boolean }): string {
  const tags = r.tags.length > 0 ? ` — ${r.tags.join(', ')}` : ''
  if (opts.passive) return `- [${r.id}] ${r.name}${tags}${sourceNote(r)}`  // passive 同样带低置信标注
  return `- [${r.id}] ${r.name}（${r.summary}）${tags}${sourceNote(r)}`
}
