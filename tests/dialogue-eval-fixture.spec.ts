import { describe, expect, it } from 'vitest'
import { isSameAsMemory } from '../src/search/memory-quotes.ts'
import { intakeOf } from '../src/search/dialogue-intake.ts'
import { isOwnEvent, messageText, sourceKindOf, turnOf } from '../src/session-log.ts'
import { estimateTokens } from '../src/snapshot.ts'
import * as fixture from './fixtures/dialogue-eval.ts'

const { DIALOGUE_EVAL_SESSIONS: sessions, DIALOGUE_EVAL_MEMORIES: memories,
  DIALOGUE_EVAL_QUERIES: queries, DIALOGUE_EVAL_CATEGORIES: categories } = fixture
const collected = () => sessions.flatMap(({ log }) => {
  const result = intakeOf(log, -1)
  expect(result.kind).toBe('rows')
  return result.kind === 'rows' ? result.rows : []
})
const sessionOf = (id: string) => sessions.find(({ log }) => log.header.id === id)!.log

describe('中文原话评测夹具', () => {
  it('每份会话轮次完整且时间序号递增，收录总量在规定范围内', () => {
    expect(sessions.length).toBeGreaterThanOrEqual(12)
    expect(new Set(sessions.map(({ log }) => log.header.id)).size).toBe(sessions.length)
    for (const { log } of sessions) {
      expect(log.header.isSeeded).toBe(false)
      expect(log.inheritedEventCount).toBe(0)
      let inTurn = false
      let count = 0
      for (const [index, event] of log.events.entries()) {
        expect(Number.isSafeInteger(event.seq)).toBe(true)
        expect(Number.isFinite(event.time)).toBe(true)
        if (index > 0) {
          expect(event.seq!).toBeGreaterThan(log.events[index - 1].seq!)
          expect(event.time!).toBeGreaterThan(log.events[index - 1].time!)
        }
        if (event.type === 'turn/start') {
          expect(inTurn).toBe(false)
          inTurn = true
          count++
        } else {
          expect(inTurn).toBe(true)
          if (event.type === 'turn/end') inTurn = false
        }
      }
      expect(inTurn).toBe(false)
      expect(count).toBeGreaterThanOrEqual(6)
      expect(count).toBeLessThanOrEqual(20)
    }
    const rows = collected()
    expect(rows.length).toBeGreaterThanOrEqual(600)
    expect(rows.length).toBeLessThanOrEqual(1200)
    for (const values of [sessions, queries]) {
      const ratio = values.filter(value => value.scene === 'work').length / values.length
      expect(ratio).toBeGreaterThanOrEqual(0.5)
      expect(ratio).toBeLessThanOrEqual(0.7)
    }
  })

  it('每类至少五题且总量合规，答案和干扰项都指向收录消息', () => {
    const rows = collected()
    expect(queries.length).toBe(68)
    expect(queries.length).toBeLessThanOrEqual(80)
    expect(new Set(queries.map(query => query.id)).size).toBe(queries.length)
    for (const category of categories) expect(queries.filter(query => query.category === category).length).toBeGreaterThanOrEqual(5)
    for (const query of queries) {
      expect(categories).toContain(query.category)
      expect(query.query.trim().length).toBeGreaterThan(0)
      if (query.category === 'no-answer') expect(query.answers).toEqual([])
      else expect(query.answers.length).toBeGreaterThan(0)
      if (query.category === 'cross-word') expect(query.distractors!.length).toBeGreaterThan(0)
      for (const ref of [...query.answers, ...query.distractors ?? []]) {
        expect(rows.some(row => row.sessionId === ref.sessionId && row.seq === ref.seq)).toBe(true)
        expect(sessions.find(({ log }) => log.header.id === ref.sessionId)!.scene).toBe(query.scene)
      }
    }
  })

  it('记忆出处属于自己的事件，补找答案位于锚前一到四轮', () => {
    expect(new Set(memories.map(memory => memory.id)).size).toBe(memories.length)
    for (const memory of memories) {
      const log = sessionOf(memory.sessionId)
      expect(log).toBeDefined()
      expect(memory.eventRange[0]).toBeLessThanOrEqual(memory.eventRange[1])
      for (const seq of memory.eventRange) expect(log.events.some(event => event.seq === seq && isOwnEvent(log, event) === true)).toBe(true)
    }
    for (const query of queries.filter(query => ['before-anchor', 'near-verbatim'].includes(query.category))) {
      const memory = memories.find(memory => memory.id === query.anchorMemoryId)!
      expect(memory).toBeDefined()
      const log = sessionOf(memory.sessionId)
      const turns = log.events.filter(event => event.type === 'turn/start').map(event => event.seq!)
      for (const answer of query.answers) {
        expect(answer.sessionId).toBe(memory.sessionId)
        if (query.category === 'before-anchor') {
          expect(answer.seq).toBeLessThan(memory.eventRange[0])
          const distance = turnOf(memory.eventRange[0], turns)! - turnOf(answer.seq, turns)!
          expect(distance).toBeGreaterThanOrEqual(1)
          expect(distance).toBeLessThanOrEqual(4)
        } else if (!query.id.startsWith('near-verbatim-boundary-')) {
          const text = messageText(log.events.find(event => event.seq === answer.seq)!)!.text
          const normalize = (value: string) => value.replace(/[，。！、；\s]/gu, '')
          expect(normalize(text)).toBe(normalize(memory.body))
        }
      }
    }
  })

  it('四道临界负例只差指定值或独有句，原话不能判成重复', () => {
    const cases = [
      ['120', '121'], ['林舟', '林周'], ['staging', 'production'], ['另须保留纸质签收单。', ''],
    ]
    const boundary = queries.filter(q => q.id.startsWith('near-verbatim-boundary-'))
    expect(boundary).toHaveLength(4)
    expect(memories).toHaveLength(14)
    expect(queries.filter(q => q.category === 'near-verbatim')).toHaveLength(9)
    for (const [i, query] of boundary.entries()) {
      const ref = query.answers[0]!
      const text = messageText(sessionOf(ref.sessionId).events.find(e => e.seq === ref.seq)!)!.text
      const memory = memories.find(m => m.id === query.anchorMemoryId)!
      expect(text).toContain(cases[i]![0])
      expect(text.replace(cases[i]![0], cases[i]![1])).toBe(memory.body)
      expect(isSameAsMemory(text, memory.body)).toBe(false)
    }
  })

  it('注入上下文、委派任务和正常长工具结果存在且全部排除', () => {
    const rows = collected()
    const counts = { context: 0, delegation: 0, longTool: 0 }
    for (const { log } of sessions) {
      const delegated = log.header.delegationDepth === 1
        ? log.events.find(event => sourceKindOf(event) === 'user') : undefined
      for (const event of log.events) {
        const context = sourceKindOf(event) === 'runtime-context'
        const message = messageText(event)
        const longTool = event.type === 'tool/result' && estimateTokens(message!.text) > 300
          && (event.data as { message: { isError: boolean } }).message.isError === false
        if (context) counts.context++
        if (event === delegated) counts.delegation++
        if (longTool) counts.longTool++
        if (context || event === delegated || longTool) {
          expect(rows.some(row => row.sessionId === log.header.id && row.seq === event.seq)).toBe(false)
        }
      }
    }
    for (const count of Object.values(counts)) expect(count).toBeGreaterThan(0)
  })

  it('长消息题覆盖后半段和非末条正文，工具题覆盖长报错与短结果', () => {
    const allEvents = sessions.flatMap(({ log }) => log.events)
    expect(allEvents.filter(event => event.type === 'assistant/message' && estimateTokens(messageText(event)!.text) > 300).length).toBeGreaterThanOrEqual(4)
    let tailCount = 0
    let middleCount = 0
    const toolKinds = new Set<string>()
    for (const query of queries) {
      if (!['long-message', 'tool-result'].includes(query.category)) continue
      for (const answer of query.answers) {
        const log = sessionOf(answer.sessionId)
        const event = log.events.find(event => event.seq === answer.seq)!
        const text = messageText(event)!.text
        if (query.category === 'long-message') {
          expect(event.type).toBe('assistant/message')
          if (estimateTokens(text) > 300 && text.indexOf(query.query) > text.length / 2) tailCount++
          const nextEnd = log.events.find(e => e.seq! > answer.seq && e.type === 'turn/end')!.seq!
          if (log.events.some(e => e.seq! > answer.seq && e.seq! < nextEnd && e.type === 'assistant/message')) middleCount++
        } else {
          expect(event.type).toBe('tool/result')
          if (estimateTokens(text) > 300) {
            expect((event.data as { message: { isError: boolean } }).message.isError).toBe(true)
            toolKinds.add('long-error')
          } else toolKinds.add('short')
        }
      }
    }
    expect(tailCount).toBeGreaterThanOrEqual(2)
    expect(middleCount).toBeGreaterThan(0)
    expect([...toolKinds].sort()).toEqual(['long-error', 'short'])
  })

  it('全角题规范化后能对上原文，跨词题同时包含真答案和字面干扰', () => {
    const textOf = (ref: { sessionId: string; seq: number }) =>
      messageText(sessionOf(ref.sessionId).events.find(event => event.seq === ref.seq)!)!.text
    for (const query of queries) {
      if (query.category === 'fullwidth') {
        const text = textOf(query.answers[0])
        expect(text).not.toContain(query.query)
        expect(text.normalize('NFKC')).toContain(query.query.normalize('NFKC'))
      }
      if (query.category === 'cross-word') {
        for (const ref of [...query.answers, ...query.distractors!]) expect(textOf(ref)).toContain(query.query)
        for (const ref of query.distractors!) expect(query.answers).not.toContainEqual(ref)
      }
    }
  })

  it('无答案题中的排除材料确实存在，但其关键文字不进入检索库', () => {
    const rows = collected()
    for (const phrase of ['宿主注入的环境标记', '委派任务验收编号', '露营清点暗格编号']) {
      expect(queries.some(query => query.category === 'no-answer' && query.query === phrase)).toBe(true)
      expect(JSON.stringify(sessions)).toContain(phrase)
      expect(rows.some(row => row.text.includes(phrase))).toBe(false)
    }
  })

  it('全部导出字符串不含本机路径或密钥前缀', () => {
    const strings = (value: unknown): string[] => typeof value === 'string' ? [value]
      : value !== null && typeof value === 'object' ? Object.entries(value).flatMap(([key, item]) => [key, ...strings(item)]) : []
    const forbidden = new RegExp(['/' + 'Users/', '/' + 'home/', 's' + 'k-'].join('|'))
    for (const value of strings(fixture)) expect(value).not.toMatch(forbidden)
  })
})
