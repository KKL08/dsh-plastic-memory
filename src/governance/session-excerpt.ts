import type { DialogueSpeaker } from '../contract-codes.ts'
import { renderDialogueLine } from '../search/dialogue-format.ts'
import { messageText, type RawEvent } from '../session-log.ts'

/**
 * 给交给模型的会话原文编号：插件给读到的每条消息一个编号，模型只引用编号，代码按编号核对「这次运行实际读到了」。
 * 核实矛盾和回看补记共用这一份。正文不遮盖（交给模型的会话原文不遮盖）；只按调用方给的 clipped 截短，截短的标出来。
 */

/**
 * 一段要编号的会话原文：会话 id 和读到的那一段事件（按日志顺序，调用方已挑好要给的那几条）。缺省整段原样给出。
 * omitted：窗口截掉的消息在哪。before、after：这一段前面、后面还有同一轮的消息没给，块的第一行、最后一行相应写一行
 * DIALOGUE_OMITTED_BEFORE、DIALOGUE_OMITTED_AFTER；gapBefore：这几个序号的消息和它前一条给出的消息之间截掉了一段，
 * 在这条消息那一行前面单写一行 DIALOGUE_OMITTED_BETWEEN（序号是 events 里的；不是这一段第一条写出的消息）。
 * clipped：只给出前一部分的消息，序号 → 给出的字数；这条正文截到这么多字，后面接 DIALOGUE_CLIPPED_MARK。
 */
export interface DialogueSource {
  sessionId: string
  events: readonly RawEvent[]
  omitted?: { before?: boolean; after?: boolean; gapBefore?: readonly number[] }
  clipped?: ReadonlyMap<number, number>
}

/** 截断标记：单独一行，不编号，不以编号的写法开头。 */
export const DIALOGUE_OMITTED_BEFORE = '（前面还有同一轮的消息，没有给出）'
export const DIALOGUE_OMITTED_AFTER = '（后面还有同一轮的消息，没有给出）'
export const DIALOGUE_OMITTED_BETWEEN = '（中间还有同一轮的消息，没有给出）'
/** 截短标记：接在截短的正文后面（同一行或正文最后一行的末尾）。 */
export const DIALOGUE_CLIPPED_MARK = '（这条后面还有，没有给出）'

export interface NumberDialogueOptions {
  /**
   * 给哪些说话方的消息编号；缺省三种都编。不在里面的消息照样按顺序写进块里作上下文，只是不带编号、不进 refs，
   * 这一行直接是 renderDialogueLine 的写法（以时间或说话方开头，不会以编号的写法开头）。核实矛盾只给用户的话和工具结果编号。
   */
  numberSpeakers?: readonly DialogueSpeaker[]
}

/** 一个编号指向的事件。 */
export interface DialogueRef {
  sessionId: string
  seq: number
  speaker: DialogueSpeaker
  /** 这条消息给模型看到的原文（messageText 取出的，未遮盖；截短的是截短后那部分，不带截短标记）。 */
  text: string
  /** 事件时刻（毫秒）；宿主没给时缺省。 */
  at?: number
}

export interface NumberedDialogue {
  /**
   * 每段一块，块里一行一条消息：`[#编号] ` 加 renderDialogueLine 的写法（多行正文从第二行起缩进）；不编号的说话方没有前缀。
   * 截断的段在头尾、中间截掉的地方各加一行截断标记。没有可写的消息的段给空串（不加截断标记）。
   */
  blocks: string[]
  /** 编号 → 事件。编号从 startAt 起连续，跨段接着数。 */
  refs: ReadonlyMap<number, DialogueRef>
  /** 下一个可用的编号（接着编别的段时用）。 */
  next: number
}

/** 编号的写法：`[#3] `。 */
export const DIALOGUE_REF_PREFIX = '[#'

/**
 * 按段、按日志顺序给消息编号。只编 messageText 取得出文字、角色是用户、助手、工具结果的事件；推理、注入的上下文、
 * 别的来源开的消息、结构事件、没有数字序号的事件不编号、不出现在块里。
 * 同一会话的同一个序号在几段里都出现（两条记忆的出处是同一段对话）时只在第一次出现处编号，后面的段跳过它：编号到事件一一对应。
 */
export function numberDialogue(sources: readonly DialogueSource[], startAt = 1, opts: NumberDialogueOptions = {}): NumberedDialogue {
  const seen = new Set<string>()
  const refs = new Map<number, DialogueRef>()
  let next = startAt
  const blocks = sources.map(({ sessionId, events, omitted, clipped }) => {
    const lines: string[] = []
    for (const event of events) {
      const seq = event.seq
      if (typeof seq !== 'number') continue
      const message = messageText(event)
      if (!message || (message.role !== 'user' && message.role !== 'assistant' && message.role !== 'tool')) continue
      // 其他来源也能开启 user/message；只有真正的助手消息和工具结果能以这两种身份出现。
      if (event.type === 'user/message' && message.role !== 'user') continue
      const key = JSON.stringify([sessionId, seq])
      if (seen.has(key)) continue
      seen.add(key)

      const limit = clipped?.get(seq)
      const text = message.text.slice(0, limit)
      const ref: DialogueRef = { sessionId, seq, speaker: message.role, text, ...(event.time !== undefined ? { at: event.time } : {}) }
      let line = renderDialogueLine({ ...ref, text: limit === undefined ? text : text + DIALOGUE_CLIPPED_MARK })
      if (!opts.numberSpeakers || opts.numberSpeakers.includes(ref.speaker)) {
        refs.set(next, ref)
        line = `${DIALOGUE_REF_PREFIX}${next++}] ${line}`
      }
      if (lines.length && omitted?.gapBefore?.includes(seq)) lines.push(DIALOGUE_OMITTED_BETWEEN)
      lines.push(line)
    }
    if (lines.length === 0) return ''
    if (omitted?.before) lines.unshift(DIALOGUE_OMITTED_BEFORE)
    if (omitted?.after) lines.push(DIALOGUE_OMITTED_AFTER)
    return lines.join('\n')
  })
  return { blocks, refs, next }
}
