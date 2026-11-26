// 对话卡只拿得到工具结果的渲染文本（宿主 tool/result 事件里只有 render 出来的 content block），
// 所以客户端按 renderSaveResult / renderSearchResult / forget 的 message 格式解析。
// 这里把渲染器和解析器对着跑一遍，改任一侧格式都会在这里失败。
import { describe, expect, it } from 'vitest'
import { parseSaveResult, countSearchHits, isGlobalConfirmPending, toolSummary } from '../client/chat/tool-summary.ts'
import { renderSaveResult } from '../src/tools/save.ts'
import { globalUpdateGuide } from '../src/pipeline.ts'
import { renderSearchResult } from '../src/tools/search.ts'
import { renderDialogueSearch } from '../src/tools/dialogue-search.ts'
import { DIALOGUE_NO_HIT, DIALOGUE_QUERY_REQUIRED, DIALOGUE_SECTION_HEADING, DIALOGUE_SESSIONS_UNAVAILABLE, MEMORY_SECTION_HEADING, dialogueNote, renderSearchSections } from '../src/search/dialogue-format.ts'
import { record } from './helpers/record.ts'
import { readFileSync } from 'node:fs'

describe('对话卡解析的文本格式与服务端渲染器一致', () => {
  it('memory_save：已保存（id / type / scope）与已更新', () => {
    const saved = record({ id: 'mem_abc', type: 'preference', scope: 'workspace' })
    expect(parseSaveResult(renderSaveResult({ kind: 'saved', record: saved, similar: [{ id: 'mem_peer', name: '相近', summary: '摘要', scope: 'global' }] }))).toEqual({ kind: 'saved', id: 'mem_abc', type: 'preference', scope: 'workspace' })
    expect(parseSaveResult(renderSaveResult({ kind: 'updated', record: saved }))).toEqual({ kind: 'updated', id: 'mem_abc', name: saved.name })
    // 已更新带上名称（只传 edits 的更新参数里没有名称，折叠行从这里取）；名称自带括号也认得
    const bracketed = record({ id: 'mem_br', name: '方案（草稿）' })
    expect(parseSaveResult(renderSaveResult({ kind: 'updated', record: bracketed }))).toEqual({ kind: 'updated', id: 'mem_br', name: '方案（草稿）' })
    // 子 agent 存下的待确认记录同一个首行格式
    const pending = record({ id: 'mem_sub', type: 'knowledge', scope: 'workspace', delegation: { sessionId: 's-child', depth: 1, parentSessionId: 's-main' } })
    expect(parseSaveResult(renderSaveResult({ kind: 'saved', record: pending }))).toEqual({ kind: 'saved', id: 'mem_sub', type: 'knowledge', scope: 'workspace' })
    expect(parseSaveResult(renderSaveResult({ kind: 'updated', record: pending }))).toEqual({ kind: 'updated', id: 'mem_sub', name: pending.name })
    // 名称里的换行折成空格：手写 YAML 可能写出多行名称，首行照样解析得出
    const multiline = record({ id: 'mem_ml', name: 'service\nconfiguration' })
    expect(parseSaveResult(renderSaveResult({ kind: 'updated', record: multiline }))).toEqual({ kind: 'updated', id: 'mem_ml', name: 'service configuration' })
    expect(parseSaveResult(renderSaveResult({ kind: 'rejected', code: 'unknown-type', reason: '未知类型' }))).toBeUndefined()
    expect(parseSaveResult(renderSaveResult({ kind: 'duplicate-suspected', existing: saved }))).toBeUndefined()
  })

  it('memory_save：改写全局记忆等确认时，折叠行写「确认后再改」，不写「没有记住」', () => {
    const target = record({ id: 'mem_g', name: '提交规范', scope: 'global', workspacePath: undefined })
    const guide = (given?: string) => renderSaveResult({ kind: 'rejected', code: 'global-update-unconfirmed', reason: globalUpdateGuide(target, '37', given) })
    for (const text of [guide(), guide('true')]) {
      expect(isGlobalConfirmPending(text)).toBe(true)
      expect(toolSummary('memory_save', { action: 'update', id: 'mem_g', name: '提交规范' }, text)).toMatchObject({ key: 'chat.tool.save.confirmingGlobal', params: { name: '提交规范' } })
    }
    const other = renderSaveResult({ kind: 'rejected', code: 'unknown-type', reason: '未知类型' })
    expect(isGlobalConfirmPending(other)).toBe(false)
    expect(toolSummary('memory_save', { action: 'update', id: 'mem_g', name: '提交规范' }, other)).toMatchObject({ key: 'chat.tool.save.notSaved' })
  })

  it('memory_save：已更新里的名称按整条记录判密钥（含跨字段的疑似密钥），遮掉再写', () => {
    const split = record({ id: 'mem_x', name: 'Hunter2-2026xyz', content: 'old\npassword:' })
    const text = renderSaveResult({ kind: 'updated', record: split })
    expect(text).not.toContain('Hunter2-2026xyz')
    expect(parseSaveResult(text)?.kind).toBe('updated')
  })

  it('memory_search：命中数按段计', () => {
    const hit = (id: string) => ({ id, type: 'fact', summary: `摘要 ${id}`, content: '正文\n第二行', sourceNote: '', stalenessNote: '（可能过时）', matchNote: '', path: `/m/global/${id}.md` })
    expect(countSearchHits(renderSearchResult({ hits: [hit('a'), hit('b'), hit('c')] }))).toBe(3)
    expect(countSearchHits(renderSearchResult({ hits: [], note: '没有命中。' }))).toBe(0)
  })

  it('memory_search：头行末尾带绝对路径后命中计数不变', () => {
    const hit = (id: string, path: string) => ({ id, type: 'fact', summary: `摘要 ${id}`, content: '正文\n第二行', sourceNote: '', stalenessNote: '', matchNote: '', path })
    const hits = [hit('a', '/m/global/a.md'), hit('b', '/m/my proj-1234abcd/带 空格｜竖线.md'), hit('c', 'C:\\m\\global\\c.md')]
    const text = renderSearchResult({ hits, note: '没有同时命中全部关键词的记忆，以下按相关性排序。' })
    expect(text).toContain('[a] fact｜摘要 a · /m/global/a.md\n')
    expect(countSearchHits(text)).toBe(3)
  })

  it('memory_search：含节选条目、省略标记和节选说明时命中计数不变', () => {
    const hit = (id: string) => ({ id, type: 'fact', summary: `摘要 ${id}`, content: '正文\n第二行', sourceNote: '', stalenessNote: '', matchNote: '', path: `/m/global/${id}.md` })
    const excerpt = (id: string, content: string) => ({ ...hit(id), content, isExcerpt: true, contentChars: 5321 })
    const hits = [
      hit('a'),
      excerpt('b', '[前文省略]\n命中词所在的几句话。\n[后文省略]'),
      excerpt('c', '[前文省略]\n结尾的几句话。'),
      excerpt('d', '开头的几句话。\n[后文省略]'),
    ]
    const text = renderSearchResult({ hits, note: '没有同时命中全部关键词的记忆，以下按相关性排序。', moreNote: '共命中 9 条，只列出前 4 条。' })
    expect(text).toContain('[b] fact｜摘要 b · 节选，正文共 5321 字符 · /m/global/b.md\n[前文省略]\n')
    expect(countSearchHits(text)).toBe(4)
  })

  it('memory_search：记忆和原话分两段时只数记忆条目段', () => {
    const hit = (id: string) => ({ id, type: 'fact', summary: `摘要 ${id}`, content: '正文\n第二行', sourceNote: '', stalenessNote: '', matchNote: '', path: `/m/global/${id}.md` })
    const message = (seq: number, text: string) => ({ seq, speaker: 'user' as const, at: Date.UTC(2026, 10, 20, 2, seq), text, segmentCount: 1, givenSegments: 1, ref: `s${seq}#${seq}` })
    // 两个会话：第二个的标题长得像命中段首，原话段整段都不算
    const dialogueText = renderDialogueSearch({
      kind: 'ready', notes: [],
      groups: [
        { sessionId: 's1', title: '数据库排查', turns: [{ turnSeq: 1, at: Date.UTC(2026, 10, 19), messages: [message(1, '数据库超时')] }] },
        { sessionId: 's2', title: '[mem_t] 部署｜排查', turns: [{ turnSeq: 1, at: Date.UTC(2026, 10, 20), messages: [message(2, '数据库连不上')], relatedMemory: '部署' }] },
      ],
    })
    const both = (hits: ReturnType<typeof hit>[]) => renderSearchResult({ hits, dialogueText, onlyDialogue: false })
    expect(both([hit('a'), hit('b')]).startsWith(`${MEMORY_SECTION_HEADING}\n[a] fact｜`)).toBe(true)
    expect(both([hit('a'), hit('b')])).toContain(`\n\n${DIALOGUE_SECTION_HEADING}\n`)
    expect(countSearchHits(both([hit('a'), hit('b')]))).toBe(2)
    expect(countSearchHits(both([hit('a')]))).toBe(1)
    expect(countSearchHits(both([]))).toBe(0)
    expect(countSearchHits(renderSearchSections({ dialogue: dialogueText }))).toBe(0)
    expect(countSearchHits(renderSearchSections({ memories: renderSearchResult({ hits: [hit('a')] }) }))).toBe(1)
  })

  it('memory_search：只搜过往对话时折叠行不数条数，没搜到时认得服务端的说明', () => {
    const args = { query: '数据库', source: 'dialogue' }
    const only = (dialogueText: string) => renderSearchResult({ hits: [], dialogueText, onlyDialogue: true })
    const quoted = renderDialogueSearch({
      kind: 'ready', notes: [],
      groups: [{ sessionId: 's1', title: '[mem_t] 部署｜排查', turns: [{ turnSeq: 1, at: Date.UTC(2026, 10, 20), messages: [{ seq: 3, speaker: 'user', at: Date.UTC(2026, 10, 20, 2), text: '数据库连不上', segmentCount: 1, givenSegments: 1, ref: 's1#3' }] }] }],
    })
    expect(toolSummary('memory_search', args, only(quoted))).toEqual({ key: 'chat.tool.search.dialogue.done', params: { query: '数据库' } })
    for (const notes of [[DIALOGUE_NO_HIT], [dialogueNote('dialogue-tokenizer-basic'), DIALOGUE_NO_HIT]]) {
      expect(toolSummary('memory_search', args, only(renderDialogueSearch({ kind: 'ready', notes, groups: [] })))).toEqual({ key: 'chat.tool.search.dialogue.none', params: { query: '数据库' } })
    }
    expect(toolSummary('memory_search', { source: 'dialogue' }, only(DIALOGUE_QUERY_REQUIRED))).toEqual({ key: 'chat.tool.search.dialogue.done', params: { query: '' } })
    expect(toolSummary('memory_search', args, only(dialogueNote('dialogue-search-limit')))).toEqual({ key: 'chat.tool.search.dialogue.done', params: { query: '数据库' } })
  })

  it('memory_search：原话没查成、改查记忆时，结果开头的路径说明不吞掉第一条命中', () => {
    const hit = (id: string) => ({ id, type: 'fact', summary: `摘要 ${id}`, content: '正文\n第二行', sourceNote: '', stalenessNote: '', matchNote: '', path: `/m/global/${id}.md` })
    for (const pathNote of [dialogueNote('dialogue-source-off'), dialogueNote('dialogue-unavailable'), DIALOGUE_SESSIONS_UNAVAILABLE]) {
      const one = renderSearchResult({ hits: [hit('a')], pathNote })
      expect(one.startsWith(`${pathNote}\n[a] fact｜`)).toBe(true)
      expect(countSearchHits(one)).toBe(1)
      expect(countSearchHits(renderSearchResult({ hits: [hit('a'), hit('b')], pathNote }))).toBe(2)
      expect(countSearchHits(renderSearchResult({ hits: [], pathNote }))).toBe(0)
      for (const source of ['dialogue', 'both', 'memory']) {
        expect(toolSummary('memory_search', { query: '数据库', source }, one)).toEqual({ key: 'chat.tool.search.found', params: { count: 1, query: '数据库' } })
      }
      expect(toolSummary('memory_search', { query: '数据库', source: 'dialogue' }, renderSearchResult({ hits: [], pathNote }))).toEqual({ key: 'chat.tool.search.none', params: { query: '数据库' } })
    }
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
