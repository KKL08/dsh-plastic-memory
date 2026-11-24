import { extractFacts } from './text.ts'
import type { Fact, FactKind } from './text.ts'

/** 清单最多列二十项，避免长更新的提示盖过保存结果。 */
export const LOST_FACTS_LIMIT = 20
/** 单项保留八十字符，长路径和引号内容另用省略号提示截断。 */
export const LOST_FACT_TEXT_LIMIT = 80
/** 至少删掉一百字符才提示细化缩水，短句调整不打扰。 */
export const REFINE_REMOVED_MIN_CHARS = 100
/** 同时要求删掉改前正文三成，避免长正文的小修触发。 */
export const REFINE_REMOVED_RATIO = 0.3
/** 同一轮新建第三条时提醒粒度，每轮只提示一次。 */
export const TURN_CREATE_HINT_AT = 3
/** 正文超过两千字符时建议检查主题粒度，按字符串长度计。 */
export const CONTENT_LENGTH_HINT = 2000

/** 截取已遮盖的文字；超长时按码点保留 limit 个字符并加省略号，不把 emoji 截成半个。 */
export function clipText(text: string, limit: number): string {
  const chars = [...text]
  return chars.length > limit ? `${chars.slice(0, limit).join('')}…` : text
}

/** before、after 是遮盖过的整段正文；数字日期按完整事实比，名称路径允许仍出现在正文里。 */
export function lostFacts(before: string, after: string): Fact[] {
  const remaining = new Set(extractFacts(after).map(fact => fact.text))
  return extractFacts(before).filter(fact => !remaining.has(fact.text) && !((fact.kind === 'path' || fact.kind === 'name') && after.includes(fact.text)))
}

/** 细化删掉的原句字符数；未到绝对值和比例两条提示线时返回 undefined。两段正文须先遮盖。 */
export function refineRemoval(before: string, after: string): { removed: number; ratio: number } | undefined {
  const removed = before.split(/[。！？!?；;\n]+/).map(sentence => sentence.trim())
    .filter(sentence => sentence.length >= 4 && !after.includes(sentence)).reduce((sum, sentence) => sum + sentence.length, 0)
  return removed >= Math.max(REFINE_REMOVED_MIN_CHARS, Math.ceil(REFINE_REMOVED_RATIO * before.length))
    ? { removed, ratio: removed / before.length } : undefined
}

/** 按日期、数字、专名、路径列出消失的事实，先限制总项数，再截取各项。 */
export function factsDroppedText(lost: readonly Fact[]): string {
  const kinds: Array<[FactKind, string]> = [['date', '日期'], ['number', '数字'], ['name', '专名'], ['path', '路径']]
  let remaining = LOST_FACTS_LIMIT
  const groups = kinds.flatMap(([kind, label]) => {
    const facts = lost.filter(fact => fact.kind === kind).slice(0, remaining)
    remaining -= facts.length
    return facts.length ? [`${label} ${facts.map(fact => clipText(fact.text, LOST_FACT_TEXT_LIMIT)).join('、')}`] : []
  })
  const extra = lost.length > LOST_FACTS_LIMIT ? `等另 ${lost.length - LOST_FACTS_LIMIT} 项` : ''
  return `更新后正文里不再有：${groups.join('；')}${extra}。是有意去掉的就不用处理；要留下的用 edits 补回正文。`
}

/** 说明细化删句的规模；有改前快照时给出恢复入口。 */
export function refineShrankText(removal: { removed: number; ratio: number }, snapshotId: string | undefined): string {
  return `声明的是细化（只增不删），这次正文去掉了约 ${removal.removed} 个字符的原句（改前正文的 ${Math.round(removal.ratio * 100)}%）。${snapshotId ? `改前的全文在快照 ${snapshotId} 里，要恢复用 memory_snapshot 恢复这份快照。` : ''}`
}

/** 第三次新建成功后提醒按同一件事合并，并先检索已有记录。 */
export function turnThirdSaveText(): string {
  return '这一轮已新建 3 条记忆。讲同一件事前因后果的内容并成一条；新建前先用 memory_search 找已有的，能并进去的用 action=update。'
}

/** 长正文提示按会独立变化的状态或事件拆分。 */
export function contentLongText(length: number): string {
  return `正文有 ${length} 个字符。一条记忆写一个主题下的一个状态或一件事；会各自变化、在不同场景下用到的部分，分成几条存更好找、更好改。`
}

/** 本会话里保存提示的记账：进程内存，接线层按会话建，不落盘。 */
export interface SaveHints {
  /** 记下这一轮（按当轮起点的事件序号）新建成功了一条，返回这一轮至今新建的条数。 */
  noteCreate(turnStartSeq: number): number
  /** 这条记忆的长度提示在本会话里还没给过：记下并返回 true；给过返回 false。 */
  claimLengthHint(memoryId: string): boolean
}

/** 为一个会话创建独立提示记账；成功写入后同步调用，避免并行写入领到相同序号。 */
export function createSaveHints(): SaveHints {
  const creates = new Map<number, number>()
  const lengthHints = new Set<string>()
  return {
    noteCreate(turnStartSeq) {
      const count = (creates.get(turnStartSeq) ?? 0) + 1
      creates.set(turnStartSeq, count)
      return count
    },
    claimLengthHint(memoryId) {
      if (lengthHints.has(memoryId)) return false
      lengthHints.add(memoryId)
      return true
    },
  }
}
