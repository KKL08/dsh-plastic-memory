import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { MemoryRecord } from '../record-schema.ts'
import { formatIndexLine } from '../index-line.ts'
import { memoryQuoteStatus } from '../search/dialogue-format.ts'
import { finalQuoteBlock, renderQuoteBlock, type MemoryQuoteBlock } from './memory-quotes.ts'
import { renderDialogueSearch, type FinishedDialogue } from './dialogue-search.ts'
import type { HistoryListing, HistoryVersionInfo } from './search-history.ts'
import { memoryPageNote, pageNote, type SearchHit, type TopicBrowse, type TopicRef } from './search.ts'

/**
 * memory_search 的输出预算：宿主在上下文压力下会把超过阈值的旧工具结果裁成头尾两段，
 * 检索把自己的输出压在阈值以下，模型拿到的就是完整的结果。量长度按宿主的口径（文字的 Unicode 码点数）。
 */

/** 宿主工具结果裁剪服务的阈值：没有这个服务、阈值已知、读不出来（取服务抛错或值不合法）。 */
export type PrunerThreshold = { kind: 'none' } | { kind: 'known'; chars: number } | { kind: 'unknown' }

/** 预算下限：宿主阈值再低也不跟着降，低于它时一次检索连三四条节选都放不下。 */
const SEARCH_BUDGET_FLOOR_CHARS = 3000
/** 预算比宿主阈值少留的比例，给说明行、换行这些量不准的部分留余地。 */
const SEARCH_BUDGET_MARGIN = 0.05
/** 没有裁剪服务或阈值读不出时的预算：宿主缺省阈值 8192 留余量后的整数。 */
const SEARCH_BUDGET_FALLBACK_CHARS = 8000

/**
 * 读一次宿主裁剪服务的阈值。read 返回服务对象（没有时 undefined），可能抛错（配置重启的瞬间）；
 * 抛错和阈值不是正整数都按读不出，检索照常进行。
 */
export function readPrunerThreshold(read: () => unknown): PrunerThreshold {
  let service: unknown
  try {
    service = read()
  } catch {
    return { kind: 'unknown' }
  }
  if (service === undefined) return { kind: 'none' }
  const chars = (service as { config?: { thresholdChars?: unknown } } | null)?.config?.thresholdChars
  return typeof chars === 'number' && Number.isInteger(chars) && chars > 0 ? { kind: 'known', chars } : { kind: 'unknown' }
}

/** 这次检索输出的上限（码点）。检索和健康报告共用这一个算法。 */
export function searchBudgetOf(threshold: PrunerThreshold): number {
  return threshold.kind === 'known'
    ? Math.max(SEARCH_BUDGET_FLOOR_CHARS, Math.floor((1 - SEARCH_BUDGET_MARGIN) * threshold.chars))
    : SEARCH_BUDGET_FALLBACK_CHARS
}

/** 预算低于它时，降级说明里提一句上限偏低：放不下三条 2000 字左右的全文。 */
const LOW_BUDGET_CHARS = 6000
/** 健康报告建议的阈值下限：预算按它算正好是低预算线。 */
export const SUGGESTED_THRESHOLD_CHARS = 6316
/** 宿主裁剪时换进中间的标记有多少码点；建议配置时头尾保留量加上它不能超过阈值。 */
export const PRUNE_MARKER_CHARS = 39
/** 阈值已知、算出的检索输出上限低于低预算线时给健康报告的那一条；其余情况（含没有服务、读不出）为 undefined。 */
export function lowSearchBudgetOf(threshold: PrunerThreshold): { thresholdChars: number; budgetChars: number } | undefined {
  if (threshold.kind !== 'known') return undefined
  const budgetChars = searchBudgetOf(threshold)
  return budgetChars < LOW_BUDGET_CHARS ? { thresholdChars: threshold.chars, budgetChars } : undefined
}

/** 头行里的摘要、主题浏览里的名称和摘要、无命中说明缩短到这么多码点。 */
const SHORTENED_TEXT_CHARS = 60
/** 零条结果时说明最多留这么多码点：外部可写的主题名、类型名可能很长。 */
const ZERO_RESULT_NOTE_CHARS = 300

/** 文字的长度，口径同宿主裁剪：Unicode 码点数。 */
function codePointLength(text: string): number {
  let n = 0
  for (const _ of text) n++
  return n
}

/** 超过 max 码点时截到 max 个、末尾加省略号。 */
function clipped(text: string, max: number): string {
  const points = Array.from(text)
  return points.length > max ? `${points.slice(0, max).join('')}…` : text
}

/** 宿主会话里读裁剪服务的入口：返回这次工具调用所在 agent 用的那个服务，没有时 undefined；可能抛错。 */
export interface PrunerSource {
  toolResultPrunerOf(exec: ToolRunContext): unknown
}

/** 一条命中正文的形态：全文、节选、说明句（全文已在上下文里）、只给头行。 */
export type BodyForm = 'full' | 'excerpt' | 'note' | 'head'

/** 执行器交给收尾的一条命中：几种形态的正文都备好，收尾只往下降。 */
export interface HitDraft {
  form: BodyForm
  /** 遮盖后的全文。 */
  full: string
  /** 遮盖后的节选（带省略标记）。 */
  excerpt: string
  /** 说明句形态的正文。 */
  note: string
  /** 按 id 直达的那条：正文给全文，不受输出上限影响。 */
  isPinned: boolean
  /** 检索取到的那份记录（未遮盖）：判附原话里哪段和正文相同、独立原话从略都按它。 */
  record: MemoryRecord
  /** 这条记忆在「出处同」里的名称。 */
  label: string
  /** 附的原话，渲染留到收尾。 */
  quote?: MemoryQuoteBlock
}

/** 主题浏览一行的原料：遮盖后的记录、文件路径、陈旧标注。 */
export interface BrowseRowDraft { record: MemoryRecord; file?: string; note: string }

/** 记忆一路这一页的位置：翻页说明按本页实际给出的条数重算。 */
export interface MemoryPage {
  total: number
  offset: number
  isTopic: boolean
  /** 结果里有非全命中、换 match: all 会少一些。 */
  hasAllHint: boolean
  /** 两者都查、翻到第二页及以后：只翻记忆。 */
  isMemoriesOnly?: boolean
}

/** 执行器挂在结果上、只给收尾用的部分。 */
export interface SearchDraft {
  page?: MemoryPage
  /** note 里逐词命中计数那一行。 */
  termLine?: string
  /** 结构化的原话检索结果：收尾按保留的段重新组装。 */
  dialogue?: FinishedDialogue
}

/** 收尾处理的结果外形（memory_search 各入口共用）。 */
export type DraftOutcome = SearchDraft & {
  hits: SearchHit[]
  note?: string
  moreNote?: string
  budgetNote?: string
  quoteNote?: string
  dialogueText?: string
  onlyDialogue?: boolean
  matchedTopics?: TopicRef[]
  catalog?: TopicRef[]
  browse?: TopicBrowse
  history?: HistoryListing
  version?: HistoryVersionInfo
}

/** 这次检索的输出上限和读到的阈值。 */
export interface SearchBudget { chars: number; threshold: PrunerThreshold }

/** 降级走到哪一步：每一步只改这里的标记，最终文字按标记重新生成。 */
interface FitState {
  forms: BodyForm[]
  quoteDropped: boolean[]
  /** 本页留下的命中条数（从前往后）。 */
  shown: number
  /** 只剩一条时头行缩短到第几级。 */
  headLevel: number
  catalogKept: number
  isTermDropped: boolean
  isMatchedDropped: boolean
  dialogueKept: number
  isNoteClipped: boolean
  reasonDropped: Set<number>
  historyKept: number
  isHistoryIdOnly: boolean
  browseKept: number
  isAboutDropped: boolean
  isEmptySectionDropped: boolean
  rowLevel: number
  isTopicNameClipped: boolean
  isChanged: boolean
  /** 降级做完仍超上限：例外目标照给时说明里写明。 */
  isOver: boolean
  /** 降级做完仍长过宿主阈值（会被裁）。 */
  isOverThreshold: boolean
}

const isQuoteDroppable = (block: MemoryQuoteBlock | undefined) => block !== undefined && (block.turns.length > 0 || block.sameSource.length > 0)
/** 头行缩短的级数：匹配词、主题段、历史版本数、摘要截短、路径、出处和陈旧标注、摘要。 */
const HEAD_LEVELS = 7
/** 浏览行缩短的级数：标签、摘要截短、路径、名称截短、摘要、名称和标注。 */
const ROW_LEVELS = 6

/**
 * 输出收尾：检索各入口都经这里。按最终结构渲染、量长度，超过上限时按规定的顺序一步步降级，每步后重量，够了就停；
 * 步数有限，一定终止。没有上限（纯逻辑测试）时只把形态和附原话落成文字。返回的结果不带收尾用的草稿字段。
 */
export function finalizeSearch<T extends DraftOutcome>(outcome: T, budget: SearchBudget | undefined, render: (result: DraftOutcome) => string): Omit<T, keyof SearchDraft> {
  const state: FitState = {
    forms: outcome.hits.map(h => h.draft?.form ?? 'full'),
    quoteDropped: outcome.hits.map(() => false),
    shown: outcome.hits.length, headLevel: 0,
    catalogKept: outcome.catalog?.length ?? 0,
    isTermDropped: false, isMatchedDropped: false,
    dialogueKept: outcome.dialogue?.refit?.segments ?? 0,
    isNoteClipped: false,
    reasonDropped: new Set(), historyKept: outcome.history?.versions.length ?? 0, isHistoryIdOnly: false,
    browseKept: outcome.browse?.sections.reduce((n, s) => n + s.rows.length, 0) ?? 0,
    isAboutDropped: false, isEmptySectionDropped: false, rowLevel: 0, isTopicNameClipped: false,
    isChanged: false, isOver: false, isOverThreshold: false,
  }
  if (budget !== undefined) {
    const measure = () => codePointLength(render(materialize(outcome, state, budget)))
    if (measure() > budget.chars) {
      for (const _ of ladder(outcome, state)) {
        state.isChanged = true
        if (measure() <= budget.chars) break
      }
      state.isOver = measure() > budget.chars
      // 超出上限的说明这时才加进去：按带着它的最终文字判会不会被裁
      state.isOverThreshold = budget.threshold.kind === 'known' && measure() > budget.threshold.chars
    }
  }
  return materialize(outcome, state, budget)
}

/** 降级的各步，按这个顺序：独立原话 → 可省的说明 → 记忆命中降级 → 截条数 → 缩短头行。每 yield 一次是一步。 */
function* ladder(o: DraftOutcome, st: FitState): Generator<void> {
  while (st.dialogueKept > 0) {
    st.dialogueKept--
    yield
  }
  while (st.catalogKept > 0) {
    st.catalogKept--
    yield
  }
  if (o.termLine !== undefined) {
    st.isTermDropped = true
    yield
  }
  if ((o.matchedTopics?.length ?? 0) > 0) {
    st.isMatchedDropped = true
    yield
  }
  const isZeroResult = o.hits.length === 0 && o.browse === undefined && o.history === undefined
  if (isZeroResult && o.note !== undefined && codePointLength(o.note) > ZERO_RESULT_NOTE_CHARS) {
    st.isNoteClipped = true
    yield
  }
  if (o.history !== undefined) {
    const versions = o.history.versions
    for (let i = versions.length - 1; i >= 0; i--) {
      if (versions[i]!.reason === '') continue
      st.reasonDropped.add(i)
      yield
    }
    while (st.historyKept > 1) {
      st.historyKept--
      yield
    }
    if (st.historyKept === 1) {
      st.isHistoryIdOnly = true
      yield
    }
  }
  // 记忆命中：从本页最后一条往前，一条降到只剩头行再动前一条，排在前面、保底给全文的几条最后才动
  for (const i of range(o.hits.length - 1, 0)) while (stepDown(o.hits[i]!, st, i)) yield
  while (st.shown > 1 && o.hits[st.shown - 1]!.draft?.isPinned !== true) {
    st.shown--
    yield
  }
  while (st.browseKept > 1) {
    st.browseKept--
    yield
  }
  if (st.shown === 1 && o.hits[0]!.draft !== undefined && !o.hits[0]!.draft.isPinned) {
    while (st.headLevel < HEAD_LEVELS) {
      st.headLevel++
      yield
    }
  }
  if (o.browse !== undefined) {
    st.isAboutDropped = true
    yield
    st.isEmptySectionDropped = true
    yield
    while (st.rowLevel < ROW_LEVELS) {
      st.rowLevel++
      yield
    }
    st.isTopicNameClipped = true
    yield
  }
}

/** from 到 to（含两端）逐个往下数；from < to 时为空。 */
function range(from: number, to: number): number[] {
  const out: number[] = []
  for (let i = from; i >= to; i--) out.push(i)
  return out
}

/** 一条命中降一级：有可省的附原话先省附原话，否则全文 → 节选（节选不更短时直接到头行）→ 头行，说明句 → 头行。降不动时返回 false。 */
function stepDown(hit: SearchHit, st: FitState, i: number): boolean {
  const d = hit.draft
  if (d === undefined) return false
  if (isQuoteDroppable(d.quote) && !st.quoteDropped[i]) {
    st.quoteDropped[i] = true
    return true
  }
  if (d.isPinned) return false
  const form = st.forms[i]!
  if (form === 'head') return false
  st.forms[i] = form === 'full' && codePointLength(d.excerpt) < codePointLength(d.full) ? 'excerpt' : 'head'
  return true
}

/** 按降级标记生成这一次的结果：附原话的从略、「出处同」、独立原话的从略都按这里的最终形态判。 */
function materialize<T extends DraftOutcome>(o: T, st: FitState, budget: SearchBudget | undefined): Omit<T, keyof SearchDraft> {
  const { page, termLine, dialogue, ...rest } = o
  const kept = o.hits.slice(0, st.shown)
  const isShown = (i: number) => i < st.shown
  // 附原话还在输出里、带着原话轮的那些记忆：「出处同」只指向它们
  const keptLabels = new Set(kept.flatMap((h, i) => h.draft?.quote !== undefined && !st.quoteDropped[i] && h.draft.quote.turns.length > 0 ? [h.draft.label] : []))
  const hits = kept.map((h, i) => hitOut(h, st, i, keptLabels))
  // 被截掉的命中附的状态说明（读不到、读不全）带着 id 挪到说明区
  const moved = o.hits.flatMap((h, i) => !isShown(i) && h.draft?.quote?.status !== undefined ? [`${h.id} ${memoryQuoteStatus(h.draft.quote.status)}`] : [])
  const quoteNote = [o.quoteNote, ...moved].filter(x => x !== undefined).join('\n')
  const isFullShown = (memory: { content: string }) => kept.some((h, i) => h.draft?.record === memory && st.forms[i] === 'full')
  let note = o.note
  if (note !== undefined && st.isTermDropped && termLine !== undefined) note = note.split('\n').filter(line => line !== termLine).join('\n')
  if (note !== undefined && st.isNoteClipped) note = clipped(note, ZERO_RESULT_NOTE_CHARS)
  const result: DraftOutcome = {
    ...rest,
    hits,
    ...(note !== undefined ? { note } : {}),
    ...(page !== undefined && st.shown < o.hits.length ? optional('moreNote', memoryPageNote(page, st.shown)) : {}),
    ...(quoteNote !== '' ? { quoteNote } : {}),
    ...(st.isMatchedDropped ? { matchedTopics: undefined } : {}),
    ...(o.catalog !== undefined ? { catalog: st.catalogKept > 0 ? o.catalog.slice(0, st.catalogKept) : undefined } : {}),
    ...(dialogue !== undefined ? { dialogueText: dialogueTextOf(dialogue, st, isFullShown) } : {}),
    ...(o.history !== undefined ? { history: historyOut(o.history, st) } : {}),
    // 因长度省掉了行：原来的 limit 说明（只列出最新几版、可以调大 limit）对不上了，改成只交代 limit 没选入的那几版
    ...(o.history !== undefined && st.historyKept < o.history.versions.length
      ? optional('moreNote', o.history.total > o.history.versions.length ? `limit 选入了最新的 ${o.history.versions.length} 版，更早的 ${o.history.total - o.history.versions.length} 版没选入。` : undefined) : {}),
    ...(o.browse !== undefined ? browseOut(o.browse, st) : {}),
  }
  const line = budget === undefined ? undefined : budgetLine(o, st, budget, hits)
  if (line !== undefined) result.budgetNote = line
  // 删掉值为 undefined 的键：结果按 JSON 交给宿主，没有的字段不出现
  for (const key of Object.keys(result) as Array<keyof DraftOutcome>) if (result[key] === undefined) delete result[key]
  return result as Omit<T, keyof SearchDraft>
}

const optional = <K extends string>(key: K, value: string | undefined) => (value === undefined ? { [key]: undefined } : { [key]: value }) as Partial<Record<K, string>>

/** 一条命中按最终形态落成文字。 */
function hitOut(h: SearchHit, st: FitState, i: number, keptLabels: ReadonlySet<string>): SearchHit {
  const { draft: d, ...base } = h
  if (d === undefined) return base
  const form = st.forms[i]!
  const { isExcerpt: _e, contentChars: _c, ...plain } = base
  const out: SearchHit = { ...plain, content: form === 'full' ? d.full : form === 'excerpt' ? d.excerpt : form === 'note' ? d.note : '' }
  if (form === 'excerpt') Object.assign(out, { isExcerpt: true, contentChars: d.full.length })
  if (form === 'head') out.isHeadOnly = true
  const quote = d.quote === undefined || st.quoteDropped[i] ? undefined : renderQuoteBlock(finalQuoteBlock(d.quote, form === 'full' ? d.record.content : undefined, keptLabels))
  if (quote !== undefined) out.quote = quote
  else delete out.quote
  if (st.shown === 1 && i === 0) shortenHead(out, st.headLevel)
  return out
}

/** 只剩一条仍超上限时依次去掉：匹配词 → 主题段 → 历史版本数 → 摘要截短 → 路径 → 出处和陈旧标注 → 摘要。`[id] 类型｜` 不动。 */
function shortenHead(hit: SearchHit, level: number): void {
  if (level >= 1) hit.matchNote = ''
  if (level >= 2) delete hit.topic
  if (level >= 3) delete hit.versionCount
  if (level >= 4) hit.summary = clipped(hit.summary, SHORTENED_TEXT_CHARS)
  if (level >= 5) delete hit.path
  if (level >= 6) {
    hit.sourceNote = ''
    hit.stalenessNote = ''
  }
  if (level >= 7) hit.summary = ''
}

/** 独立原话按保留的段重新组装、重渲染；一段都没留时排序提示和逐词计数跟着不出。 */
function dialogueTextOf(dialogue: FinishedDialogue, st: FitState, isFullShown: (memory: { content: string }) => boolean): string {
  const refit = dialogue.refit
  if (refit === undefined) return renderDialogueSearch(dialogue)
  const { groups, omitted } = refit.reassemble(st.dialogueKept, isFullShown)
  const notes = [...dialogue.notes]
  notes.splice(refit.omittedAt, refit.hasOmitted ? 1 : 0, ...(omitted !== undefined ? [omitted] : []))
  return renderDialogueSearch({ ...dialogue, notes, groups })
}

/** 历史列表：省掉原因的行、只留版本标识的最后一行、留下的行数。 */
function historyOut(history: HistoryListing, st: FitState): HistoryListing {
  const versions = history.versions.slice(0, st.historyKept).map((v, i) => {
    const entry = st.reasonDropped.has(i) ? { ...v, reason: '' } : v
    return st.isHistoryIdOnly && i === st.historyKept - 1 ? { ...entry, isIdOnly: true } : entry
  })
  return { ...history, versions }
}

/** 主题浏览：保留前几行、缩短行和主题段。 */
function browseOut(browse: TopicBrowse, st: FitState): { browse: TopicBrowse; moreNote?: string } {
  let left = st.browseKept
  const sections = browse.sections.map(s => {
    const rows = s.rows.slice(0, Math.max(0, left)).map(({ draft, ...row }) => draft === undefined || st.rowLevel === 0 ? row : { ...row, line: browseLine(row.id, draft, st.rowLevel) })
    left -= s.rows.length
    const topic = { ...s.topic, ...(st.isAboutDropped ? { about: '' } : {}), ...(st.isTopicNameClipped ? { name: clipped(s.topic.name, SHORTENED_TEXT_CHARS) } : {}) }
    return { topic, rows }
  }).filter(s => !st.isEmptySectionDropped || s.rows.length > 0)
  const total = browse.sections.reduce((n, s) => n + s.rows.length, 0)
  return { browse: { ...browse, sections }, ...(st.browseKept < total ? { moreNote: pageNote(browse.total, browse.offset, st.browseKept) } : {}) }
}

/** 缩短后的浏览行：标签 → 摘要截短 → 路径 → 名称截短 → 摘要 → 名称和标注，最后只剩 `- [id]`。 */
function browseLine(id: string, d: BrowseRowDraft, level: number): string {
  if (level >= 6) return `- [${id}]`
  const record = {
    ...d.record,
    ...(level >= 1 ? { tags: [] } : {}),
    ...(level >= 2 ? { summary: clipped(d.record.summary, SHORTENED_TEXT_CHARS) } : {}),
    ...(level >= 4 ? { name: clipped(d.record.name, SHORTENED_TEXT_CHARS) } : {}),
  }
  return formatIndexLine(record, { passive: level >= 5, ...(level < 3 && d.file !== undefined ? { file: d.file } : {}), note: d.note })
}

/** 降级生效时开头说明区的一行：缩短、省略了什么，怎么取全文；例外目标照给时写明超出上限。 */
function budgetLine(o: DraftOutcome, st: FitState, budget: SearchBudget, hits: readonly SearchHit[]): string | undefined {
  const pinned = o.version !== undefined || o.hits.some(h => h.draft?.isPinned === true)
  if (!st.isChanged && !(st.isOver && pinned)) return undefined
  const initial = o.hits.map(h => h.draft?.form)
  const excerpted = hits.filter((h, i) => h.isExcerpt === true && initial[i] !== 'excerpt').length
  const headOnly = hits.filter((h, i) => h.isHeadOnly === true && initial[i] !== 'head').length
  // 移到下一页的那几条不算：本页看不到它们的 id
  const quotes = st.quoteDropped.slice(0, st.shown).filter(Boolean).length
  const moved = o.hits.length - st.shown
  const browseTotal = o.browse?.sections.reduce((n, s) => n + s.rows.length, 0) ?? 0
  const omittedVersions = (o.history?.versions.length ?? 0) - st.historyKept
  const isNotesDropped = st.isTermDropped || st.isMatchedDropped || st.catalogKept < (o.catalog?.length ?? 0) || st.isAboutDropped || st.isEmptySectionDropped
  const reasonsDropped = [...st.reasonDropped].filter(i => i < st.historyKept).length
  const parts = [
    excerpted > 0 ? `${excerpted} 条改为节选` : undefined,
    headOnly > 0 ? `${headOnly} 条只给头行` : undefined,
    st.headLevel > 0 || st.rowLevel > 0 ? '1 条头行已缩短' : undefined,
    moved > 0 ? `${moved} 条移到下一页` : undefined,
    browseTotal - st.browseKept > 0 ? `${browseTotal - st.browseKept} 条移到下一页` : undefined,
    quotes > 0 ? `${quotes} 条记忆附的出处原话已省略，可用 memory_source 传记忆 id 回查` : undefined,
    st.dialogueKept < (o.dialogue?.refit?.segments ?? 0) ? `${(o.dialogue?.refit?.segments ?? 0) - st.dialogueKept} 段其他原话已省略` : undefined,
    reasonsDropped > 0 ? `${reasonsDropped} 个版本的原因已省略，要看原因用 id 配 version 读那一版` : undefined,
    omittedVersions > 0 ? `最早的 ${omittedVersions} 个版本因输出长度没列出，历史列表不支持 offset 翻页` : undefined,
    st.isHistoryIdOnly ? '1 个版本只留版本标识' : undefined,
    st.isTopicNameClipped ? '主题名已缩短' : undefined,
    isNotesDropped || st.isNoteClipped ? '部分说明已省略' : undefined,
  ].filter(x => x !== undefined)
  const sentences = [
    parts.length > 0 ? `${parts.join('，')}。` : undefined,
    excerpted + headOnly > 0 || st.headLevel > 0 ? '要某条的全文，query 填它的 id，或读头行末尾的路径。' : undefined,
    st.isOver && pinned ? `按 id 查的这条全文照给，超出本次输出上限 ${budget.chars} 字${st.isOverThreshold ? '，DeepSeek Harness 压缩上下文时可能被裁掉中间部分' : ''}。` : undefined,
    st.isChanged && budget.chars < LOW_BUDGET_CHARS ? '当前上限偏低，更多条目可能只给节选。' : undefined,
  ].filter(x => x !== undefined)
  return `本次输出上限 ${budget.chars} 字：${sentences.join('')}`
}
