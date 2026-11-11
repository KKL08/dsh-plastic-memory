import type { MemoryRecord } from '../record-schema.ts'
import { GLOBAL_SCOPE_KEY, scopeKey, scopeOfMemory } from '../scope.ts'
import { maskSecrets } from '../secrets.ts'
import { sourceWindow, type RawEvent, type ReadEventFn } from '../tools/source.ts'

/**
 * 处理建议的出处回查：给每条记忆读它的出处锚所在的那段对话，只取用户和助手的文字，遮盖疑似密钥后截断，交给生成器放进提示词。
 * 能读哪些按冲突所属的作用域定：条目记下的作用域（项目内的冲突是那个项目，全局与项目之间的是这两个）加全局；
 * 此刻不在这些作用域里的记忆一律不读。memory_source 按当前会话的项目判断，没有会话的体检用不了它的规则。
 * 宿主的读事件接口不看调用方在哪个项目，范围只由这里把住；会话的锚由记忆自己给，读不到任意会话。
 * 读不到（没有锚、手改过、会话不在了、没有服务）时那一条没有出处，不报错。
 */

export interface SourceLine {
  role: 'user' | 'assistant'
  text: string
}

/** 一条记忆的出处节选，至少一行；读不到为 undefined。 */
export type SourceExcerpt = readonly SourceLine[]

/** 每句的上限（同 memory_source）和每条出处的总上限：控制每次生成的 token。待实机看过用量和质量再定。 */
const LINE_CAP = 400
const EXCERPT_CAP = 2000

type Message = { id?: string; role?: string; content?: Array<{ type?: string; text?: string }>; source?: { kind?: string } }

/**
 * 事件里带的消息：用户消息、助手消息。工具调用、工具结果和结构事件没有。收件箱里排队的消息不取：被当轮认领的随后会作为
 * 用户消息出现，只在收件箱出现过的是还没轮到、或用户撤回改写掉的。
 */
function messagesOf(event: RawEvent): Message[] {
  const data = event.data as { message?: Message } & Message | undefined
  if (data === undefined) return []
  if (event.type === 'user/message') return [data]
  if (event.type === 'assistant/message') return data.message !== undefined ? [data.message] : []
  return []
}

/**
 * 窗口里用户和助手说的话：用户消息只认用户自己发的（注入的指令文件、通知这类上下文不算），助手只取文字块（不含推理和工具调用）。
 * 同一个 id 的消息只取一次。逐句遮疑似密钥再截断，免得截断留下识别不出的半截密钥。
 */
function conversationOf(events: readonly RawEvent[]): SourceLine[] {
  const seen = new Set<string>()
  const lines: SourceLine[] = []
  let total = 0
  for (const event of events) {
    for (const m of messagesOf(event)) {
      const role = m.role === 'user' && (m.source?.kind === undefined || m.source.kind === 'user') ? 'user' : m.role === 'assistant' ? 'assistant' : undefined
      if (role === undefined) continue
      if (m.id !== undefined) {
        if (seen.has(m.id)) continue
        seen.add(m.id)
      }
      const raw = (m.content ?? []).filter(b => b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('').trim()
      if (raw.length === 0) continue
      const masked = maskSecrets(raw, { severity: 'suspected' })
      const text = masked.length > LINE_CAP ? `${masked.slice(0, LINE_CAP)}…` : masked
      if (total + text.length > EXCERPT_CAP) return lines
      total += text.length
      lines.push({ role, text })
    }
  }
  return lines
}

async function readOne(r: MemoryRecord, allowed: ReadonlySet<string>, readEvent: ReadEventFn): Promise<SourceExcerpt | undefined> {
  const own = scopeOfMemory(r)
  if (own === undefined || !allowed.has(scopeKey(own))) return undefined
  // 手编的没有锚；手改过的，锚上的对话可能已不是现在内容的来源
  if (r.source === undefined || r.handEdited === true) return undefined
  try {
    const win = await readEvent(sourceWindow({ ...r, source: r.source }))
    const lines = conversationOf(win.events ?? [])
    return lines.length > 0 ? lines : undefined
  } catch {
    return undefined
  }
}

/** 按记忆的顺序给出各自的出处节选。workspaces 是条目记下的每条所属作用域（没记就不知道冲突属于哪里，一条都不读）。 */
export async function readSuggestionSources(
  input: { workspaces: readonly string[] | undefined; records: readonly MemoryRecord[] },
  readEvent: ReadEventFn | null,
): Promise<Array<SourceExcerpt | undefined>> {
  if (readEvent === null || input.workspaces === undefined) return input.records.map(() => undefined)
  const allowed = new Set([...input.workspaces, GLOBAL_SCOPE_KEY])
  return Promise.all(input.records.map(r => readOne(r, allowed, readEvent)))
}
