import type { MemoryRecord } from '../record-schema.ts'
import { GLOBAL_SCOPE_KEY, scopeKey, scopeOfMemory } from '../scope.ts'
import { conversationOf, type SourceExcerpt } from '../tools/finding-sources.ts'
import { sourceWindow, type ReadEventFn } from '../tools/source.ts'

export type { SourceLine, SourceExcerpt } from '../tools/finding-sources.ts'

/**
 * 处理建议的出处回查：给每条记忆读它的出处锚所在的那段对话，只取用户和助手的文字，遮盖疑似密钥后截断，交给生成器放进提示词。
 * 能读哪些按冲突所属的作用域定：条目记下的作用域（项目内的冲突是那个项目，全局与项目之间的是这两个）加全局；
 * 此刻不在这些作用域里的记忆一律不读。memory_source 按当前会话的项目判断，没有会话的体检用不了它的规则。
 * 宿主的读事件接口不看调用方在哪个项目，范围只由这里把住；会话的锚由记忆自己给，读不到任意会话。
 * 读不到（没有锚、会话不在了、没有服务）时那一条没有出处，不报错。
 */

async function readOne(r: MemoryRecord, allowed: ReadonlySet<string>, readEvent: ReadEventFn): Promise<SourceExcerpt | undefined> {
  const own = scopeOfMemory(r)
  if (own === undefined || !allowed.has(scopeKey(own))) return undefined
  // 手编的没有锚
  if (r.source === undefined) return undefined
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
