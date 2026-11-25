import { anchorsOf, isPendingDelegated, type MemoryRecord } from './record-schema.ts'
import { isUserInitiator } from './session-log.ts'

/** 低置信（模型推断）标注，索引行 / 快照 / search 结果共用同一份文案。 */
export const INFERENCE_NOTE = '（模型推断，未经确认）'

/** 待确认标注：子 agent 写入、还没有主会话或用户升档。 */
export const DELEGATED_PENDING_NOTE = '（子 agent 写入，未确认）'

/** 两种标注只出一个：待确认 → 模型推断。 */
export function sourceNote(r: MemoryRecord): string {
  // 待确认压过推断：子 agent 的推断本来就未确认，一条标注说清楚是谁写的、还没确认
  if (isPendingDelegated(r)) return DELEGATED_PENDING_NOTE
  // 判据是 sourceMode 而非 confidence：任何来源都可被下调，user-explicit 存 0.7 会被阈值误标
  // 无 source = 手编/无出处：不带推断标注
  return r.source?.sourceMode === 'agent-inferred' ? INFERENCE_NOTE : ''
}

/** 无人值守标注：内容是在不是用户本人开的轮里写下的（定时任务、别的 agent）。 */
export const UNATTENDED_NOTE = '（无人值守时写入）'

/**
 * 注入侧的无人值守标注：看最近一次写下内容的锚（补证不改内容，不算）。
 * 没记发起方的锚（旧版本写的、宿主给不出的）不标：说不清的不当成无人值守。
 */
export function unattendedNote(r: MemoryRecord): string {
  const initiator = anchorsOf(r).find(a => a.change !== 'corroborate')?.initiator
  return initiator !== undefined && !isUserInitiator(initiator) ? UNATTENDED_NOTE : ''
}

/**
 * 用户或模型写的文字（主题名、主题说明，成员行的名称、摘要、标签）进注入前的处理：换行和连着的空白折成一个空格，尖括号换成全角。
 * 折成一行后标题行、代码围栏、行首角色名都落在注入自己写的行中间，不再成结构；尖括号换掉，开闭标签就不成标签。
 */
export function injectionText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().replace(/[<>]/g, c => (c === '<' ? '＜' : '＞'))
}

/**
 * 索引行：MEMORY.md 与注入索引同一个格式器，两处写法保持一致。名称、摘要、标签按 injectionText 折成一行：
 * 保存不限制摘要单行，多行摘要原样拼进来会在注入里多出标题行之类的结构。
 * file：行末的文件引用，MEMORY.md 给同目录文件名，注入给相对记忆根目录的路径（注入混排 global 与本项目两个目录）。
 * note：注入侧的附加标注（成员行上是无人值守的说明，陈旧度只在主题行上计数），放在文件名之前，让文件名始终在行末；磁盘索引不传。
 */
export function formatIndexLine(r: MemoryRecord, opts: { passive: boolean; file?: string; note?: string }): string {
  const name = injectionText(r.name)
  const tags = r.tags.length > 0 ? ` — ${r.tags.map(injectionText).join(', ')}` : ''
  const tail = `${sourceNote(r)}${opts.note ?? ''}${opts.file === undefined ? '' : ` · ${opts.file}`}`
  if (opts.passive) return `- [${r.id}] ${name}${tags}${tail}`  // passive 同样带低置信标注
  return `- [${r.id}] ${name}（${injectionText(r.summary)}）${tags}${tail}`
}
