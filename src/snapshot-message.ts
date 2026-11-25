import { maskSecretSurface } from './secrets.ts'
import { injectionText } from './index-line.ts'
import type { ContextFormed, Message, UserMessage } from '@deepseek-ai/dsh-llm'
import type { MemoryRecord } from './record-schema.ts'

/** 快照消息的来源 kind，也是 sections 里唯一一节的名字。 */
export const SNAPSHOT_SOURCE_KIND = 'plastic-memory'

/** 插件自有的 notice 形态消息用插件字段 notice 区分用途；change 是长期记忆的变化通知。 */
export const CHANGE_NOTICE_KIND = 'change'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /**
     * 本插件的消息，两种形态：
     *  - snapshot：长期记忆快照，同一来源的新快照取代旧的；唯一一节的正文就是快照文本。
     *  - notice：变化通知（插件字段 notice 为 change），summary 是宿主限 120 字的一句概括。快照比对不认它。
     */
    'plastic-memory': { kind: 'plastic-memory' } & (
      | Extract<ContextFormed, { form: 'snapshot' }>
      | (Extract<ContextFormed, { form: 'notice' }> & { notice: typeof CHANGE_NOTICE_KIND })
    )
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

/** 一条变化通知最多逐条列几条记忆；超出的只给条数。暂定值，收尾复核时按实际长度再定。 */
export const NOTICE_ITEM_LIMIT = 10

/** 通知开头的说明句。 */
export const CHANGE_NOTICE_HEADING = '下面这些长期记忆在别的会话或后台改过，以这里为准：'

/** 超过逐条上限时末尾的一句。 */
export const moreChangesLine = (n: number) => `另有 ${n} 条有变化。`

/** 记录里有没列出的改动（定长记录挤掉了、库换了新的、读到不认识的行）时末尾的一句。 */
export const UNLISTED_CHANGES_LINE = '另有改动未列出，要用时请检索。'

/** 变化通知：text 是消息正文，summary 是给宿主显示的一句概括（不含记忆内容）。 */
export interface ChangeNotice { text: string; summary: string }

/**
 * 通知里的一条：内容改动带这条记忆现在的样子（名称、摘要；遮盖在格式器里做）；读不到、删除、取代、移走只带 id。
 * moved 的去向只分三种，不写别的项目的路径。
 */
export type ChangeNoticeItem =
  | { kind: 'content'; record: Pick<MemoryRecord, 'id' | 'name' | 'summary' | 'content' | 'tags'> }
  | { kind: 'unreadable' | 'deleted' | 'superseded'; id: string }
  | { kind: 'moved'; id: string; to: 'global' | 'this-project' | 'other-project' }

/**
 * 变化通知的正文和概括。items 是要逐条列出的（调用方已排好序、截到 NOTICE_ITEM_LIMIT 条），more 是没列出的变化条数，
 * hasUnlisted 为真时末尾加 UNLISTED_CHANGES_LINE。items 为空、more 为 0、hasUnlisted 为假时回 undefined（不发）。
 *
 * 正文：CHANGE_NOTICE_HEADING，然后每条一行：
 *  - content：`- [id] 名称（摘要）`，名称、摘要先按整条记录遮盖密钥（maskSecretSurface），再折成一行（injectionText）；
 *  - unreadable：`- [id] 有改动，这次读不到现在的内容`；deleted：`- [id] 已删除`；superseded：`- [id] 已被取代`；
 *  - moved：`- [id] 已移到全局记忆` / `- [id] 已移到本项目记忆` / `- [id] 已移到别的项目`；
 * 再按需接 moreChangesLine(more)、UNLISTED_CHANGES_LINE，各占一行。
 * 概括：有变化条数（items.length + more）时是 `N 条记忆有变化`，只有 hasUnlisted 时是 `记忆可能有变化`。不放记忆的名称和摘要。
 */
export function formatChangeNotice(items: readonly ChangeNoticeItem[], opts: { more: number; hasUnlisted: boolean }): ChangeNotice | undefined {
  const count = items.length + opts.more
  if (count === 0 && !opts.hasUnlisted) return undefined
  const lines = items.map(item => {
    if (item.kind === 'content') {
      const record = maskSecretSurface(item.record)
      return `- [${record.id}] ${injectionText(record.name)}（${injectionText(record.summary)}）`
    }
    const text = item.kind === 'moved'
      ? { global: '已移到全局记忆', 'this-project': '已移到本项目记忆', 'other-project': '已移到别的项目' }[item.to]
      : { unreadable: '有改动，这次读不到现在的内容', deleted: '已删除', superseded: '已被取代' }[item.kind]
    return `- [${item.id}] ${text}`
  })
  return {
    text: [CHANGE_NOTICE_HEADING, ...lines, ...(opts.more > 0 ? [moreChangesLine(opts.more)] : []), ...(opts.hasUnlisted ? [UNLISTED_CHANGES_LINE] : [])].join('\n'),
    summary: count > 0 ? `${count} 条记忆有变化` : '记忆可能有变化',
  }
}

/** 变化通知消息的 content 与 source（交给 createUserMessage）：notice 形态，插件字段 notice 为 change，正文不加前缀。 */
export function changeNoticeMessageBody(notice: ChangeNotice): Pick<UserMessage, 'content' | 'source'> {
  return {
    content: [{ type: 'text', text: notice.text }],
    source: { kind: SNAPSHOT_SOURCE_KIND, form: 'notice', summary: notice.summary, notice: CHANGE_NOTICE_KIND },
  }
}
