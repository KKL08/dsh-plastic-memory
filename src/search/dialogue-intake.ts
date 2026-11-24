import type { DialogueSpeaker } from '../contract-codes.ts'
import type { SessionLog } from '../session-log.ts'
import { isOwnEvent, isRealUserMessage, messageText } from '../session-log.ts'
import { estimateTokens } from '../snapshot.ts'
import { SEGMENT_MAX_TOKENS, splitIntoSegments } from './segments.ts'

/** 收录规则的版本：口径变了就加一，写库的一方据此整份重建。 */
export const DIALOGUE_INTAKE_VERSION = 1

/** 待写入的一行：一条消息的一段，正文保留原文。 */
export interface DialogueRow {
  sessionId: string
  /** 所属轮的 turn/start 序号。 */
  turnSeq: number
  /** 这条消息的序号。 */
  seq: number
  /** 段序号，没切的是 0。 */
  segment: number
  /** 这条消息的时刻（毫秒）；宿主没给时缺省。 */
  at?: number
  speaker: DialogueSpeaker
  text: string
}

/** 一轮的边界：没有文本行的空轮也有。 */
export interface DialogueTurn {
  sessionId: string
  turnSeq: number
  /** 轮起点的时刻（毫秒）；宿主没给时缺省。 */
  at?: number
}

/** 收录结果；无法确定会话标识或事件归属时整份跳过，不返回部分行。 */
export type DialogueIntake =
  | { kind: 'rows'; rows: DialogueRow[]; turns: DialogueTurn[]; watermark: number }
  | { kind: 'skipped'; reason: 'unknown-boundary' | 'no-session-id' }

/** 水位之后该收的行；日志按事件顺序传入、序号递增，watermark 首次传 -1，之后传上次处理到的序号。 */
export function intakeOf(log: SessionLog, watermark: number): DialogueIntake {
  const sessionId = log.header.id
  if (typeof sessionId !== 'string' || sessionId === '') return { kind: 'skipped', reason: 'no-session-id' }
  const rows: DialogueRow[] = []
  const turns: DialogueTurn[] = []
  let turnSeq: number | undefined
  let nextWatermark = watermark
  for (const event of log.events) {
    const seq = event.seq
    if (typeof seq !== 'number' || !Number.isSafeInteger(seq)) continue
    const own = isOwnEvent(log, event)
    if (own === 'unknown') return { kind: 'skipped', reason: 'unknown-boundary' }
    if (!own) continue
    nextWatermark = Math.max(nextWatermark, seq)
    const time = Number.isFinite(event.time) ? { at: event.time } : {}
    // 水位之前的轮起点也要保留，后半轮的新消息仍归到这一轮。
    if (event.type === 'turn/start') {
      turnSeq = seq
      if (seq > watermark) turns.push({ sessionId, turnSeq, ...time })
      continue
    }
    if (seq <= watermark || turnSeq === undefined) continue
    const message = messageText(event)
    if (message === null) continue
    let speaker: DialogueSpeaker
    if (event.type === 'user/message') {
      if (!isRealUserMessage(log, event)) continue
      speaker = 'user'
    } else if (event.type === 'assistant/message') {
      speaker = 'assistant'
    } else if (event.type === 'tool/result') {
      const data = event.data as { message?: { isError?: unknown } }
      if (data.message?.isError !== true && estimateTokens(message.text) > SEGMENT_MAX_TOKENS) continue
      speaker = 'tool'
    } else {
      continue
    }
    for (const [segment, text] of splitIntoSegments(message.text).entries()) {
      rows.push({ sessionId, turnSeq, seq, segment, ...time, speaker, text })
    }
  }
  return { kind: 'rows', rows, turns, watermark: nextWatermark }
}
