import { vi } from 'vitest'
import type { RawEvent, SessionLog } from '../../src/session-log.ts'
import { messageFrom } from './session-log.ts'

/** 固定时钟让锚和日志可以逐事件对齐。 */
export const SOURCE_TIME = 1_000_000
/** 宿主真实事件形状，时间只由序号决定。 */
export const event = (seq: number, type: string, data: unknown = {}): RawEvent => ({ seq, type, data, time: SOURCE_TIME + seq })
/** 用户消息复用公共夹具，保留宿主来源。 */
export const user = (seq: number, text: string, kind = 'user') => messageFrom(kind, seq, text, SOURCE_TIME + seq)
/** 助手正文在宿主的 message 包装内。 */
export const assistant = (seq: number, text: string) => event(seq, 'assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text }] } })
/** 日志缺省是没有继承前缀的会话。 */
export const sessionLog = (events: RawEvent[], inheritedEventCount: number | undefined = 0): SessionLog => ({ header: { isSeeded: true }, inheritedEventCount, events })
/** 按会话保存日志与标题，同时记录两个宿主接口的调用。 */
export function sourceHost(logs: Record<string, SessionLog> = {}, titles: Record<string, string> = {}) {
  return {
    readSessionLog: vi.fn(async (sessionId: string) => logs[sessionId] ?? null),
    sessionTitleOf: vi.fn(async (sessionId: string) => titles[sessionId]),
  }
}
