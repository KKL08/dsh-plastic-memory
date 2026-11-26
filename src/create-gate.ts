import { isExpired } from './record-freshness.ts'
import type { MemoryStore } from './store.ts'
import { isPendingDelegated, type MemoryRecord } from './record-schema.ts'
import { maskSecretSurface } from './secrets.ts'
import { charSimilarity, normalizeForDuplicate } from './text.ts'
import { clipText } from './save-signals.ts'
import { injectionText } from './index-line.ts'
import { findMemoryCandidates, type MemoryCandidateSet } from './search/memory-candidates.ts'
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
  return { id: record.id, name: injectionText(masked.name), summary: clipText(injectionText(masked.summary), SIMILAR_SUMMARY_LIMIT), scope: record.scope }
}

/** 判重和列相近时拿来比的那段文字：名称不参与。 */
export interface GateText { name: string; summary: string; content: string }

/** 判重、相近列表共用的选项：新建闸和成组接受（tools/confirm.ts）各自给。 */
export interface GateJudgeOptions {
  /** 判重和列相近都不算的 id：新建闸是这次要替代的旧记忆；成组接受是这一批自己和候选里其余的待确认记录。 */
  excludeIds: ReadonlySet<string>
  /** 子 agent 判重只看主档；相近列表还保留本会话的待确认记录。成组接受不给。 */
  subagentSessionId?: string
  /**
   * 新记忆要归的现有主题里的成员：调用方已按 runCreateGate 的口径读好、过滤好（在用的主档、没过期、不在 excludeIds 里）。
   * 不过罕见词否决，按和输入的比较文字相似度降序排在检索候选之后；判重同样对它们做。成组接受不给。
   */
  topicMembers?: readonly MemoryRecord[]
}

/**
 * 判重和列相近用的比较文字：正文和摘要各自 normalizeForDuplicate 后拼接。新建闸、成组接受组内两两比较都用它。
 */
export function duplicateComparison(record: { content: string; summary: string }): string {
  return normalizeForDuplicate(record.content) + normalizeForDuplicate(record.summary)
}

function candidateWindow(set: MemoryCandidateSet, excludeIds: ReadonlySet<string>) {
  // 两段各取前十再排除，保持新建闸的窗口边界。
  const settled = set.candidates.filter(c => !isPendingDelegated(c.record))
  const pending = set.candidates.filter(c => isPendingDelegated(c.record))
  return [...settled.slice(0, GATE_CANDIDATE_WINDOW), ...pending.slice(0, GATE_CANDIDATE_WINDOW)].filter(c => !excludeIds.has(c.record.id))
}

function sortedTopicMembers(input: GateText, opts: GateJudgeOptions): MemoryRecord[] {
  const text = duplicateComparison(input)
  return [...(opts.topicMembers ?? [])].sort((a, b) => charSimilarity(text, duplicateComparison(b)) - charSimilarity(text, duplicateComparison(a)))
}

/**
 * 新建闸的判重，吃一份已取好的候选集：主档、待确认两段各取前 GATE_CANDIDATE_WINDOW 条（去掉 excludeIds），再接 topicMembers；
 * 和输入的比较文字相似度 ≥ NEAR_DUPLICATE_THRESHOLD 的里取最高的一条（同分取先出现的），遮盖后返回；没有为 undefined。
 * 给了 subagentSessionId 时待确认记录不参与。
 */
export function findNearDuplicate(input: GateText, set: MemoryCandidateSet, opts: GateJudgeOptions): SimilarMemory | undefined {
  const neighbors = candidateWindow(set, opts.excludeIds)
  const text = duplicateComparison(input)
  let highest = 0
  let existing: MemoryRecord | undefined
  for (const record of [...neighbors.map(c => c.record), ...sortedTopicMembers(input, opts)]) {
    if (opts.subagentSessionId !== undefined && isPendingDelegated(record)) continue
    const similarity = charSimilarity(text, duplicateComparison(record), NEAR_DUPLICATE_THRESHOLD)
    if (similarity >= NEAR_DUPLICATE_THRESHOLD && similarity > highest) {
      highest = similarity
      existing = record
    }
  }
  return existing === undefined ? undefined : shown(existing)
}

/**
 * 新建闸的相近列表，吃一份已取好的候选集：上面那个窗口里过罕见词否决的（常见词门槛同 runCreateGate），按检索名次；
 * 给了 subagentSessionId 时别的会话的待确认记录不列；再按相似度降序补 topicMembers，按 id 去重，合计封顶 SIMILAR_LIMIT，遮盖后返回。
 */
export function listSimilar(input: GateText, set: MemoryCandidateSet, opts: GateJudgeOptions): SimilarMemory[] {
  const { candidates, diagnostics } = set
  const commonAt = Math.max(COMMON_TERM_MIN_DF, Math.ceil(COMMON_TERM_RATIO * Math.max(diagnostics.listedCount, candidates.length)))
  const df = diagnostics.tokens.map((_, i) => candidates.reduce((n, c) => n + Number(c.tokenHits[i]), 0))
  const similar = candidateWindow(set, opts.excludeIds).filter(c => {
    if (opts.subagentSessionId !== undefined && isPendingDelegated(c.record) && c.record.delegation?.sessionId !== opts.subagentSessionId) return false
    return c.tokenHits.some((hit, i) => hit && df[i]! < commonAt)
  }).slice(0, SIMILAR_LIMIT).map(c => shown(c.record))
  for (const record of sortedTopicMembers(input, opts)) if (similar.length < SIMILAR_LIMIT && !similar.some(s => s.id === record.id)) similar.push(shown(record))
  return similar
}

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
  const set = await findMemoryCandidates({
    query: `${input.name}\n${input.summary}\n${input.content}`,
    scope: { kind: 'visible', workspacePath: input.workspacePath },
    includesNotYetInEffect: true,
  }, deps)
  const members: MemoryRecord[] = []
  for (const id of input.topicMemberIds ?? []) {
    if (input.excludeIds.has(id)) continue
    const record = await deps.store.get(id, { kind: 'workspace', workspacePath: input.workspacePath })
    if (record && record.status === 'active' && !isPendingDelegated(record) && !isExpired(record, deps.now())) members.push(record)
  }
  const opts = { excludeIds: input.excludeIds, subagentSessionId: input.subagentSessionId, topicMembers: members }
  if (!input.skipDuplicate) {
    const existing = findNearDuplicate(input, set, opts)
    if (existing !== undefined) return { kind: 'duplicate', existing }
  }
  return { kind: 'pass', similar: listSimilar(input, set, opts) }
}

/** 相近列表最后一句集中维护，子 agent 把归并决定交给委派方。 */
export function similarGuide(isFromSubagent: boolean): string {
  return isFromSubagent
    ? '和其中某条是同一件事时，在回复里向委派方说明（带上 id）。'
    : '和其中某条是同一件事的新情况时，对那条用 action=update 并声明 change；是相关的另一件事（比如这条决定改变了某个项目的现状），对新记忆再调一次 update，只传 id 和 related；无关的不用处理。'
}
