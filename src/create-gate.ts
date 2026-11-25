import { isExpired } from './record-freshness.ts'
import type { MemoryStore } from './store.ts'
import { isPendingDelegated, type MemoryRecord } from './record-schema.ts'
import { maskSecretSurface } from './secrets.ts'
import { charSimilarity, normalizeForDuplicate } from './text.ts'
import { clipText } from './save-signals.ts'
import { findMemoryCandidates } from './search/memory-candidates.ts'
import type { QueryTokenizerOptions } from './search/jieba-segmenter.ts'

/** 只拦接近逐字重复的内容，留出少量字词变化。 */
export const NEAR_DUPLICATE_THRESHOLD = 0.9
/** 取检索前十条，给罕见词过滤后留下五条的余量。 */
export const GATE_CANDIDATE_WINDOW = 10
/** 限制保存回复的篇幅。 */
export const SIMILAR_LIMIT = 5
/** 小库不因共享词太多而过滤相近记忆。 */
export const COMMON_TERM_MIN_DF = 5
/** 大库中覆盖至少十分之一记录的词算常见词。 */
export const COMMON_TERM_RATIO = 0.1
/** 摘要只用于提示关联，不在保存回复里展开全文。 */
export const SIMILAR_SUMMARY_LIMIT = 120

/** 返回给模型的一条相近记忆：名称、摘要已遮盖并截取。 */
export interface SimilarMemory { id: string; name: string; summary: string; scope: 'global' | 'workspace' }
/** 闸只拒绝近乎逐字重复；通过时附相近列表。 */
export type CreateGateOutcome =
  | { kind: 'duplicate'; existing: SimilarMemory }
  | { kind: 'pass'; similar: SimilarMemory[] }

function shown(record: MemoryRecord): SimilarMemory {
  const masked = maskSecretSurface(record, { severity: 'suspected' })
  return { id: record.id, name: masked.name.replace(/\s+/g, ' ').trim(), summary: clipText(masked.summary, SIMILAR_SUMMARY_LIMIT), scope: record.scope }
}

const comparison = (record: { content: string; summary: string }) => normalizeForDuplicate(record.content) + normalizeForDuplicate(record.summary)

/** 只读检索近邻；调用方在写入段之外执行，避免词典加载占住写锁。 */
export async function runCreateGate(
  input: {
    name: string; summary: string; content: string
    workspacePath: string
    /** 带 force：不判重，只列相近。 */
    skipDuplicate: boolean
    /** 这次要替代的旧记忆，判重和列相近都不算。 */
    excludeIds: ReadonlySet<string>
    /** 子 agent 判重只看主档；相近列表还保留本会话的待确认记录。 */
    subagentSessionId?: string
    /**
     * 新记忆要归的现有主题里的成员 id（保存时给了现有主题才有，子 agent 不给）。按新记忆落的那个作用域逐条读，口径同检索候选：
     * 在用的主档、没过期的才算，excludeIds 里的不算。它们不过罕见词否决：排在检索候选之后、按和新记忆的字符相似度
     * （比较文字同判重）降序补进相近列表，按 id 去重，合计仍封顶 SIMILAR_LIMIT；接近逐字重复的判定同样对它们做。
     */
    topicMemberIds?: readonly string[]
  },
  deps: { store: Pick<MemoryStore, 'readRaw' | 'get'>; tokenizer?: QueryTokenizerOptions; now: () => number },
): Promise<CreateGateOutcome> {
  const { candidates, diagnostics } = await findMemoryCandidates({
    query: `${input.name}\n${input.summary}\n${input.content}`,
    scope: { kind: 'visible', workspacePath: input.workspacePath },
    includesNotYetInEffect: true,
  }, deps)
  // 检索把待确认记录排在全部主档之后，两段各取前十，免得主档一多待确认记录就进不了窗口
  const settled = candidates.filter(c => !isPendingDelegated(c.record))
  const pending = candidates.filter(c => isPendingDelegated(c.record))
  const neighbors = [...settled.slice(0, GATE_CANDIDATE_WINDOW), ...pending.slice(0, GATE_CANDIDATE_WINDOW)].filter(c => !input.excludeIds.has(c.record.id))
  const members: MemoryRecord[] = []
  for (const id of input.topicMemberIds ?? []) {
    if (input.excludeIds.has(id)) continue
    const record = await deps.store.get(id, { kind: 'workspace', workspacePath: input.workspacePath })
    if (record && record.status === 'active' && !isPendingDelegated(record) && !isExpired(record, deps.now())) members.push(record)
  }
  members.sort((a, b) => charSimilarity(comparison(input), comparison(b)) - charSimilarity(comparison(input), comparison(a)))
  if (!input.skipDuplicate) {
    const text = comparison(input)
    let highest = 0
    let existing: MemoryRecord | undefined
    for (const record of [...neighbors.map(c => c.record), ...members]) {
      if (input.subagentSessionId !== undefined && isPendingDelegated(record)) continue
      const similarity = charSimilarity(text, comparison(record), NEAR_DUPLICATE_THRESHOLD)
      if (similarity >= NEAR_DUPLICATE_THRESHOLD && similarity > highest) {
        highest = similarity
        existing = record
      }
    }
    if (existing !== undefined) return { kind: 'duplicate', existing: shown(existing) }
  }
  const commonAt = Math.max(COMMON_TERM_MIN_DF, Math.ceil(COMMON_TERM_RATIO * Math.max(diagnostics.listedCount, candidates.length)))
  const df = diagnostics.tokens.map((_, i) => candidates.reduce((n, c) => n + Number(c.tokenHits[i]), 0))
  const similar = neighbors.filter(c => {
    if (input.subagentSessionId !== undefined && isPendingDelegated(c.record) && c.record.delegation?.sessionId !== input.subagentSessionId) return false
    return c.tokenHits.some((hit, i) => hit && df[i]! < commonAt)
  }).slice(0, SIMILAR_LIMIT).map(c => shown(c.record))
  for (const record of members) if (similar.length < SIMILAR_LIMIT && !similar.some(s => s.id === record.id)) similar.push(shown(record))
  return { kind: 'pass', similar }
}

/** 相近列表最后一句集中维护，子 agent 把归并决定交给委派方。 */
export function similarGuide(isFromSubagent: boolean): string {
  return isFromSubagent
    ? '和其中某条是同一件事时，在回复里向委派方说明（带上 id）。'
    : '和其中某条是同一件事的新情况时，对那条用 action=update 并声明 change；是相关的另一件事（比如这条决定改变了某个项目的现状），对新记忆再调一次 update，只传 id 和 related；无关的不用处理。'
}
