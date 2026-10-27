import type { ContextFormed, Message, UserMessage } from '@deepseek-ai/dsh-llm'

/** 快照消息的来源 kind，也是 sections 里唯一一节的名字。 */
export const SNAPSHOT_SOURCE_KIND = 'plastic-memory'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** 本插件的长期记忆快照：snapshot 形态，同一来源的新快照取代旧的；唯一一节的正文就是快照文本。 */
    'plastic-memory': { kind: 'plastic-memory' } & Extract<ContextFormed, { form: 'snapshot' }>
  }
}

/** 快照消息开头的取代句：对话里可能留着更早的快照（压缩没覆盖到的、上一轮发的），告诉模型以最新这份为准。 */
export const SNAPSHOT_SUPERSEDE_NOTE = '本快照取代更早的长期记忆快照。'

/** 取代句连同它后面的空行：消息正文 = 前缀 + 快照文本。用量估算把它计进固定说明。 */
export const SNAPSHOT_MESSAGE_PREFIX = `${SNAPSHOT_SUPERSEDE_NOTE}\n\n`

/** 快照消息的 content 与 source（交给 createUserMessage）。content 给模型看，sections 存原文，比对只读 sections。 */
export function snapshotMessageBody(text: string): Pick<UserMessage, 'content' | 'source'> {
  return {
    content: [{ type: 'text', text: `${SNAPSHOT_MESSAGE_PREFIX}${text}` }],
    source: { kind: SNAPSHOT_SOURCE_KIND, form: 'snapshot', sections: [{ name: SNAPSHOT_SOURCE_KIND, text }] },
  }
}

/** 本插件快照消息里的快照文本；别的消息、或 sections 不成形（日志被手改、旧版本写的）回 undefined。 */
export function snapshotTextOf(message: Pick<Message, 'source'>): string | undefined {
  const source = message.source as { kind?: unknown; form?: unknown; sections?: unknown }
  if (source.kind !== SNAPSHOT_SOURCE_KIND || source.form !== 'snapshot' || !Array.isArray(source.sections)) return undefined
  const text: unknown = (source.sections[0] as { text?: unknown } | undefined)?.text
  return typeof text === 'string' ? text : undefined
}

/** 模型眼下能看到的最后一份快照（从尾部往前找）；没有回 undefined。 */
export function lastVisibleSnapshot(messages: readonly Pick<Message, 'source'>[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const text = snapshotTextOf(messages[i]!)
    if (text !== undefined) return text
  }
  return undefined
}

/**
 * 这次要不要发：组装失败（undefined）或空串不发——空串会发出一条只有取代句的消息，等于宣布记忆全部作废；
 * 与最后一份可见快照逐字相同也不发，前缀缓存不动。
 */
export function shouldSendSnapshot(text: string | undefined, visible: string | undefined): text is string {
  return text !== undefined && text !== '' && text !== visible
}
