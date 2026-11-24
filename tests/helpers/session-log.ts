import type { Session } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { RawEvent, SessionLog } from '../../src/session-log.ts'
import type { SaveContext } from '../../src/tools/save.ts'

/** 一条带来源标记的 user/message。 */
export function messageFrom(kind: string, seq: number, text = '记一下', time?: number): RawEvent {
  return { type: 'user/message', seq, ...(time === undefined ? {} : { time }), data: { id: `m${seq}`, role: 'user', content: [{ type: 'text', text }], source: { kind } } }
}

/** 普通会话里的一轮：seq 0 是 turn/start，seq 1 是来源为 kind 的起点消息，后面接 more。 */
export function turnOpenedBy(kind: string, more: RawEvent[] = []): SessionLog {
  return {
    header: { isSeeded: false },
    inheritedEventCount: 0,
    events: [{ type: 'turn/start', seq: 0, time: 1 }, messageFrom(kind, 1), ...more],
  }
}

/** 保存工具的宿主替身：会话上下文固定，日志是用户本人开的一轮（写入照旧能填用户明说）。 */
export function saveHost(context: SaveContext, log: SessionLog | null = turnOpenedBy('user')) {
  return { saveContextOf: async () => context, readSessionLog: async () => log }
}

/** 宿主替身的 readSessionLog：用户本人开的一轮。 */
export const userTurnLog = async (): Promise<SessionLog> => turnOpenedBy('user')

/**
 * 宿主 sessionQuery.readSession 的替身（宿主返回的形状）：每个会话都读成用户本人开的一轮，
 * seq 0 是 turn/start，seq 1 是用户的消息。宿主会话的 seq 要走到 2 以后（保存点 lastSeq ≥ 1），起点消息才在当轮范围里。
 */
export async function readUserTurn() {
  return { session: { isSeeded: false }, inheritedEventCount: 0, events: [{ type: 'turn/start', seq: 0, time: 1 }, messageFrom('user', 1)] }
}

/** 宿主 turnBoundary 投影的替身状态：当轮起点是 seq 0 的 turn/start，同 readUserTurn 读回的日志。 */
export const USER_TURN_BOUNDARY = { openTurnStartSeq: 0, lastTurn: 1 }

/** 让宿主真 Session 和 readUserTurn 读回的日志对上：seq 0 开一轮，seq 1 是用户本人的消息。返回同一个会话。 */
export function openUserTurn(session: Session): Session {
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: '记一下' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  return session
}
