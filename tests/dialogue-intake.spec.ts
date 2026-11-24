import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import type { RawEvent, SessionLog } from '../src/session-log.ts'
import { messageText } from '../src/session-log.ts'
import { DIALOGUE_INTAKE_VERSION, intakeOf } from '../src/search/dialogue-intake.ts'
import { SEGMENT_MAX_TOKENS } from '../src/search/segments.ts'
import { estimateTokens } from '../src/snapshot.ts'

const T0 = 1_000
const at = (seq: number, type: string, data: unknown = {}): RawEvent => ({ seq, type, time: T0 + seq * 10, data })
const text = (value: string) => [{ type: 'text', text: value }]
const user = (seq: number, value: string, kind = 'user') =>
  at(seq, 'user/message', { id: `u${seq}`, role: 'user', content: text(value), source: { kind } })
const assistant = (seq: number, value: string) =>
  at(seq, 'assistant/message', { turn: 1, step: 1, message: { id: `a${seq}`, role: 'assistant', content: text(value) }, stream: [] })
const tool = (seq: number, value: string, isError = false) =>
  at(seq, 'tool/result', { message: { role: 'tool', toolCallId: `c${seq}`, content: text(value), isError } })
const log = (events: RawEvent[], header: SessionLog['header'] = { id: 's1', isSeeded: false }, inheritedEventCount: number | undefined = 0): SessionLog =>
  ({ header, inheritedEventCount, events })
const rowsOf = (value: SessionLog, watermark = -1) => {
  const result = intakeOf(value, watermark)
  if (result.kind !== 'rows') throw new Error('预期返回收录行')
  return result
}
const longText = ` \n${'正文。\n'.repeat(300)} 尾部\n `

const mixedLog = () => log([
  at(0, 'turn/start'), user(1, '运行环境', 'runtime-context'), user(2, '巡检', 'schedule'),
  user(3, '委派任务'), user(4, '用户补充'), assistant(5, '保存前正文'),
  at(6, 'tool/call', { callId: 'save', name: 'memory_save', arguments: '{}' }),
  assistant(7, '保存后正文'), assistant(8, longText), user(9, '', 'retry'),
  tool(10, longText, true), tool(11, '短结果'), tool(12, longText),
  user(13, '另一位代理的消息', 'agent'), user(14, '插件投递', 'plugin'),
  at(15, 'assistant/message', { message: { content: [{ type: 'reasoning', text: '推理' }] } }),
  user(16, '有效重试', 'retry'), at(17, 'turn/end'),
], { id: 's1', delegationDepth: 1 })

describe('对话记录收录', () => {
  it('按来源和工具结果长度逐类收录正文，保存点前后都保留', () => {
    const result = rowsOf(mixedLog())
    expect(DIALOGUE_INTAKE_VERSION).toBe(1)
    expect(estimateTokens(longText)).toBeGreaterThan(SEGMENT_MAX_TOKENS)
    for (const seq of [1, 2, 3, 6, 9, 12, 13, 14, 15, 17]) expect(result.rows.filter(row => row.seq === seq)).toEqual([])
    for (const [seq, speaker] of [[4, 'user'], [5, 'assistant'], [7, 'assistant'], [8, 'assistant'], [10, 'tool'], [11, 'tool'], [16, 'user']] as const) {
      const rows = result.rows.filter(row => row.seq === seq)
      expect(rows.length).toBeGreaterThan(0)
      expect(rows.every(row => row.speaker === speaker && row.turnSeq === 0 && row.sessionId === 's1' && row.at === T0 + seq * 10)).toBe(true)
    }
    for (const seq of [8, 10]) expect(result.rows.filter(row => row.seq === seq).length).toBeGreaterThan(1)
    expect(result.watermark).toBe(17)
  })

  it('继承前缀不出行和轮边界，自己的首轮之前也不收消息', () => {
    const result = rowsOf(log([
      at(0, 'turn/start'), user(1, '父用户'), assistant(2, '父助手'),
      assistant(3, '子会话首轮前'), at(4, 'turn/start'), user(5, '子用户'),
    ], { id: 'child', isSeeded: true }, 3))
    expect(result.turns).toEqual([{ sessionId: 'child', turnSeq: 4, at: T0 + 40 }])
    expect(result.rows).toEqual([{ sessionId: 'child', turnSeq: 4, seq: 5, segment: 0, at: T0 + 50, speaker: 'user', text: '子用户' }])
    expect(rowsOf(log([at(0, 'turn/start'), user(1, '继承消息')], { id: 'child' }, 2)).watermark).toBe(-1)
  })

  it('带序号的事件归属不明时整份跳过，即使事件在水位之前', () => {
    for (const header of [{ id: 's1', isSeeded: true }, { id: 's1' }]) {
      const value = { ...log([at(0, 'turn/start'), assistant(1, '正文')], header), inheritedEventCount: undefined }
      expect(intakeOf(value, 9)).toEqual({ kind: 'skipped', reason: 'unknown-boundary' })
    }
  })

  it('从助手消息的嵌套正文取文本，忽略推理块', () => {
    const result = rowsOf(log([at(0, 'turn/start'), at(1, 'assistant/message', {
      message: { content: [{ type: 'reasoning', text: '隐藏推理' }, ...text('可见正文')] },
    })]))
    expect(result.rows.map(row => row.text)).toEqual(['可见正文'])
  })

  it('没有正文的空轮仍返回边界，缺少时间就省略时间字段', () => {
    const result = rowsOf(log([{ seq: 0, type: 'turn/start' }, { ...assistant(1, '正文'), time: undefined }, at(2, 'turn/start')]))
    expect(result.turns).toEqual([{ sessionId: 's1', turnSeq: 0 }, { sessionId: 's1', turnSeq: 2, at: T0 + 20 }])
    expect(result.turns[0]).not.toHaveProperty('at')
    expect(result.rows[0]).not.toHaveProperty('at')
  })

  for (const [cut, label] of [[4, '轮次中间'], [8, '多段消息之后']] as const) {
    it(`水位落在${label}时分两次收录与整份收录相同`, () => {
      const value = mixedLog()
      value.events.push(at(18, 'turn/start'), assistant(19, '下一轮'))
      const whole = rowsOf(value)
      const first = rowsOf({ ...value, events: value.events.filter(event => event.seq! <= cut) })
      const second = rowsOf(value, first.watermark)
      expect(first.watermark).toBe(cut)
      expect([...first.rows, ...second.rows]).toEqual(whole.rows)
      expect([...first.turns, ...second.turns]).toEqual(whole.turns)
      expect(second.watermark).toBe(whole.watermark)
    })
  }

  it('所有收录消息逐段拼回原文，保留首尾空白和换行且按序输出', () => {
    const value = mixedLog()
    const result = rowsOf(value)
    for (const seq of new Set(result.rows.map(row => row.seq))) {
      const rows = result.rows.filter(row => row.seq === seq)
      expect(rows.map(row => row.segment)).toEqual(rows.map((_, index) => index))
      expect(rows.map(row => row.text).join('')).toBe(messageText(value.events.find(event => event.seq === seq)!)!.text)
    }
    expect(result.rows).toEqual([...result.rows].sort((a, b) => a.seq - b.seq || a.segment - b.segment))
    expect(result.turns).toEqual([...result.turns].sort((a, b) => a.turnSeq - b.turnSeq))
  })

  it('会话标识缺失或不是非空字符串时跳过', () => {
    for (const id of [undefined, '', 12, null]) {
      expect(intakeOf(log([], { id } as SessionLog['header']), -1)).toEqual({ kind: 'skipped', reason: 'no-session-id' })
    }
  })

  it('正常工具结果恰好达到上限时收录，超过上限则整条跳过', () => {
    const exact = 'a'.repeat(1_000)
    expect(estimateTokens(exact)).toBe(SEGMENT_MAX_TOKENS)
    const result = rowsOf(log([at(0, 'turn/start'), tool(1, exact), tool(2, exact + 'a')]))
    expect(result.rows.map(row => [row.seq, row.text])).toEqual([[1, exact]])
    expect(result.watermark).toBe(2)
  })

  it('跳过无序号事件并保持水位单调，没有新事件时返回原水位', () => {
    const value = { ...log([
      { type: 'turn/start' }, assistant(0, '没有自己的轮起点'),
      at(1, 'turn/start'), { ...assistant(2, '无序号'), seq: undefined }, at(3, 'turn/end'),
    ]), inheritedEventCount: undefined }
    expect(rowsOf(value)).toEqual({ kind: 'rows', rows: [], turns: [{ sessionId: 's1', turnSeq: 1, at: T0 + 10 }], watermark: 3 })
    expect(rowsOf(value, 20)).toEqual({ kind: 'rows', rows: [], turns: [], watermark: 20 })
    expect(rowsOf(log([]), 20).watermark).toBe(20)
    expect(rowsOf({ ...log([{ type: 'turn/start' }], { id: 's1' }), inheritedEventCount: undefined }).watermark).toBe(-1)
  })

  it('序号或时间不是正常数字的事件不进水位和时间字段', () => {
    const value = log([
      at(0, 'turn/start'), { ...assistant(1, '序号无效'), seq: Number.NaN }, { ...assistant(1, '序号无穷'), seq: Number.POSITIVE_INFINITY },
      { ...assistant(2, '时间缺值'), time: null as unknown as number }, { ...assistant(3, '时间无效'), time: Number.NaN },
    ])
    const result = rowsOf(value)
    expect(result.watermark).toBe(3)
    expect(result.rows.map(row => [row.seq, 'at' in row])).toEqual([[2, false], [3, false]])
    expect(rowsOf(value, result.watermark).rows).toEqual([])
  })

  it('工具结果的出错标记只认布尔真，其余按长度上限处理', () => {
    const marked = (seq: number, isError: unknown) => at(seq, 'tool/result', { message: { role: 'tool', toolCallId: `c${seq}`, content: text(longText), ...(isError === undefined ? {} : { isError }) } })
    const result = rowsOf(log([at(0, 'turn/start'), marked(1, undefined), marked(2, 1), marked(3, 'true'), marked(4, true)]))
    expect([...new Set(result.rows.map(row => row.seq))]).toEqual([4])
  })

  it('派生出来的子会话：继承的用户消息和委派任务都不收，之后用户说的话才收', () => {
    const result = rowsOf(log([
      at(0, 'turn/start'), user(1, '父会话里用户说的'), assistant(2, '父助手'),
      at(3, 'turn/start'), user(4, '委派任务'), user(5, '   \n\t'), user(6, '用户接着说'),
    ], { id: 'child', isSeeded: true, delegationDepth: 1 }, 3))
    expect(result.rows.map(row => [row.seq, row.text])).toEqual([[6, '用户接着说']])
  })

  it('模块不导入存储、数据库或宿主模块', async () => {
    const source = await readFile(new URL('../src/search/dialogue-intake.ts', import.meta.url), 'utf8')
    const imports = [...source.matchAll(/(?:from\s*|import\s*\(\s*|import\s*)['"]([^'"]+)['"]/g)].map(match => match[1]!)
    expect(imports.filter(path => /stor|sqlite|node:|@deepseek-ai/.test(path))).toEqual([])
  })
})
