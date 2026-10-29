import { describe, expect, it } from 'vitest'
import { formatIndexLine, INFERENCE_NOTE } from '../src/index-line.ts'
import { STALENESS_NOTE } from '../src/record-freshness.ts'
import { record } from './helpers/record.ts'

// 索引行末尾带文件名，MEMORY.md 与注入同一个格式器。
describe('MEMORY.md 行与注入索引行末尾带文件名（同源格式，passive 不带 summary；磁盘侧不带陈旧度，注入侧带）', () => {
  const inferred = { sessionId: 's', eventRange: [0, 1] as [number, number], sourceMode: 'agent-inferred' as const }

  it('非 passive：summary、tags、来源标注之后以 · 文件名收尾', () => {
    const r = record({ id: 'mem_p', name: '项目状态', tags: ['freeze'], summary: '冻结到三月', source: inferred })
    expect(formatIndexLine(r, { passive: false, file: '项目状态.md' }))
      .toBe(`- [mem_p] 项目状态（冻结到三月） — freeze${INFERENCE_NOTE} · 项目状态.md`)
  })

  it('passive：不带 summary，仍以 · 文件名收尾', () => {
    const r = record({ id: 'mem_ref', name: '看板', tags: ['linear'], summary: '团队看板的地址' })
    expect(formatIndexLine(r, { passive: true, file: 'global/看板.md' })).toBe('- [mem_ref] 看板 — linear · global/看板.md')
  })

  it('注入侧的陈旧度标注落在文件名之前，文件名始终在行末', () => {
    const r = record({ id: 'mem_old', name: '旧决定', summary: '摘要' })
    expect(formatIndexLine(r, { passive: false, file: 'global/旧决定.md', note: STALENESS_NOTE(30) }))
      .toBe(`- [mem_old] 旧决定（摘要）${STALENESS_NOTE(30)} · global/旧决定.md`)
  })
})
