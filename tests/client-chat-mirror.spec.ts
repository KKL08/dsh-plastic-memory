// 对话卡只拿得到工具结果的渲染文本（宿主 tool/result 事件里只有 render 出来的 content block），
// 所以客户端按 renderSaveResult / renderSearchResult / forget 的 message 格式解析。
// 这里把渲染器和解析器对着跑一遍，改任一侧格式都会在这里失败。
import { describe, expect, it } from 'vitest'
import { parseSaveResult, countSearchHits, toolSummary } from '../client/chat/tool-summary.ts'
import { renderSaveResult } from '../src/tools/save.ts'
import { renderSearchResult } from '../src/tools/search.ts'
import { record } from './helpers/record.ts'
import { readFileSync } from 'node:fs'

describe('对话卡解析的文本格式与服务端渲染器一致', () => {
  it('memory_save：已保存（id / type / scope）与已更新', () => {
    const saved = record({ id: 'mem_abc', type: 'preference', scope: 'workspace' })
    expect(parseSaveResult(renderSaveResult({ kind: 'saved', record: saved }))).toEqual({ kind: 'saved', id: 'mem_abc', type: 'preference', scope: 'workspace' })
    expect(parseSaveResult(renderSaveResult({ kind: 'updated', record: saved }))).toEqual({ kind: 'updated', id: 'mem_abc' })
    expect(parseSaveResult(renderSaveResult({ kind: 'rejected', code: 'unknown-type', reason: '未知类型' }))).toBeUndefined()
    expect(parseSaveResult(renderSaveResult({ kind: 'duplicate-suspected', existing: [saved] }))).toBeUndefined()
  })

  it('memory_search：命中数按段计', () => {
    const hit = (id: string) => ({ id, type: 'fact', summary: `摘要 ${id}`, content: '正文\n第二行', sourceNote: '', stalenessNote: '（可能过时）', path: `/m/global/${id}.md` })
    expect(countSearchHits(renderSearchResult({ hits: [hit('a'), hit('b'), hit('c')] }))).toBe(3)
    expect(countSearchHits(renderSearchResult({ hits: [], note: '没有命中。' }))).toBe(0)
  })

  it('memory_search：头行末尾带绝对路径后命中计数不变', () => {
    const hit = (id: string, path: string) => ({ id, type: 'fact', summary: `摘要 ${id}`, content: '正文\n第二行', sourceNote: '', stalenessNote: '', path })
    const hits = [hit('a', '/m/global/a.md'), hit('b', '/m/my proj-1234abcd/带 空格｜竖线.md'), hit('c', 'C:\\m\\global\\c.md')]
    const text = renderSearchResult({ hits, note: '没有同时命中全部关键词的记忆，以下按相关性排序。' })
    expect(text).toContain('[a] fact｜摘要 a · /m/global/a.md\n')
    expect(countSearchHits(text)).toBe(3)
  })

  it('memory_forget：从 message 里读「已遗忘 N 条」', () => {
    // forget 的 message 在 executeForget 里拼装（要真实 store 才能跑），这里直接核对源码里的模板开头
    const source = readFileSync(new URL('../src/tools/forget.ts', import.meta.url), 'utf8')
    expect(source).toContain('`已遗忘 ${forgotten.length} 条记忆${missingNote}。')
    const message = `已遗忘 2 条记忆；未找到：mem_x。已自动快照（snap_1），14 天内可用 memory_snapshot 恢复。`
    expect(toolSummary('memory_forget', { ids: ['a', 'b', 'x'] }, message)).toEqual({ key: 'chat.tool.forget.done', params: { count: 2 } })
    expect(toolSummary('memory_forget', { ids: ['x'] }, '没有找到可遗忘的记忆（mem_x），可能 id 有误或已删除。')).toEqual({ key: 'chat.tool.forget.none' })
  })
})
