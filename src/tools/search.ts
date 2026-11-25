import type { SearchSource } from '../contract-codes.ts'
import { retrieveDialogue, finishDialogue, renderDialogueSearch, runPath, catchUpFor, listSessionTable, shareDialogueReads, DIALOGUE_PATH_BUDGET_MS, type DialogueSearchDeps, type FinishedDialogue } from './dialogue-search.ts'
import { dialogueNote, renderSearchSections, DIALOGUE_QUERY_REQUIRED, MEMORY_QUOTES_UNAVAILABLE } from '../search/dialogue-format.ts'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { MemoryStore, QueryScope } from '../store.ts'
import type { SearchNoteCode } from '../contract-codes.ts'
import type { QueryTokenizerOptions } from '../search/jieba-segmenter.ts'
import type { SearchTier } from '../search/ranking.ts'
import { findMemoryCandidates, type MemoryCandidate } from '../search/memory-candidates.ts'
import { memoryLane, quoteMemories, renderQuoteBlock, withDialogueSegments, type MemoryQuotes } from './memory-quotes.ts'
import { segmentKey } from '../search/dialogue-rank.ts'
import { memoryLabelOf } from '../search/memory-quotes.ts'
import { matchWindow } from '../search/window.ts'
import { judgeTopHit, matchedTerms, type TermHitCount } from '../search/coverage.ts'
import type { TypeRegistry } from '../type-registry.ts'
import type { ContextHost } from './host-session.ts'
import { sourceNote } from '../index-line.ts'
import { stalenessNote } from '../record-freshness.ts'
import { exposedPath, maskSecretSurface } from '../secrets.ts'

/** memory_search 运行时需要的会话上下文，由宿主会话适配器的 contextOf 提供。 */
export interface SearchContext {
  /** 宿主委派信息；子 agent 只读自己的会话。 */
  delegation?: object
  workspacePath: string | undefined
  /** handle：宿主的 session 对象，快照缓存与召回去重按它分会话；拿不到 session 时缺省。 */
  session: { id: string; lastSeq: number; handle?: object }
}

/** 会话的快照与召回去重（SnapshotCache 满足它）。 */
export interface SessionRecall {
  /** 该会话当前冻结快照里带入全文的 core 记忆：id → 带入时的正文；没有冻结快照回 undefined。 */
  injectedCore(session: object): ReadonlyMap<string, string> | undefined
  /** 计召回：同一会话里每条记忆只计一次。 */
  markRecalled(session: object, ids: readonly string[]): Promise<void>
}

/** memory_search 工具的依赖，纯逻辑层与框架绑定层共用。 */
export interface SearchToolDeps {
  /** 没传时按只查记忆（配置的缺省是两者）；配置热更新每次现读。 */
  searchSource?: () => SearchSource
  dialogue?: DialogueSearchDeps
  /** 记忆带原话：开着时带关键词的检索给排名靠前的记忆附出处那一轮的一问一答。没传时按关；每次现读。 */
  memoryQuotes?: () => boolean
  store: MemoryStore
  registry: TypeRegistry
  host: ContextHost<SearchContext>
  /** 分词器选项：用户词典路径（现读）与降级告警的日志器。缺省只用主词典、告警走 console。 */
  tokenizer?: QueryTokenizerOptions
  /** 缺省（纯测试场景）或拿不到 session 时：正文照常给全文，每次检索都计召回。 */
  sessionRecall?: SessionRecall
  /** 有效期判定、计召回用的时钟，缺省取当前时间。 */
  now?: () => number
}

export interface SearchArgs {
  source?: SearchSource
  query: string
  types?: string[]
  scope?: 'global' | 'workspace' | 'all-visible'
  limit?: number
  /** 缺省 any：按档位排好的全部命中；all：只返回全命中档（同时含全部关键词）。 */
  match?: 'any' | 'all'
}

export interface SearchHit {
  id: string
  type: string
  summary: string
  content: string
  sourceNote: string
  stalenessNote: string
  /** 命中说明（见 matchNoteOf），全命中为空串。 */
  matchNote: string
  /** 完整对上的查询词，只在部分命中档出现（可能为空）；口径同逐词命中条数。 */
  matchedTerms?: string[]
  /** 记忆文件的绝对路径（记忆根目录 + 目录名 + 文件名）；模型要全文或上下文时直接 Read。name 含明确密钥时不给（见 exposedPath）。 */
  path?: string
  /** 节选条目才有：content 装的是命中窗口加省略标记，不是完整正文。 */
  isExcerpt?: boolean
  /** 节选条目才有：遮盖密钥后的正文总字符数，头行据此标「正文共 N 字符」。 */
  contentChars?: number
  /** 记忆带原话开着时才有：接在正文后面的出处原话或说明（原话不遮盖）。 */
  quote?: string
}

// 结果分级的门槛（字符数按遮盖密钥后的正文取字符串长度）。一次检索往上下文里放的正文要有个可预期的上限：
// 排在前面的保底给全文，单条很长的、以及全文总量到了预算之后的条目，只给正文的一段。

/** 排名在这个数以内的条目保底给全文（单条超过节选门槛的除外）。 */
export const FULL_TEXT_GUARANTEED_HITS = 5
/** 单条正文超过这个长度就给节选，保底范围内的也一样。 */
export const EXCERPT_ABOVE_CHARS = 2000
/** 全文正文的累计预算：保底范围内的全文也计入，但只约束保底范围之后的条目；节选、头行、说明都不计入。 */
export const FULL_TEXT_BUDGET_CHARS = 8000
/** 命中窗口向两边扩展到这个长度为止。 */
export const WINDOW_TARGET_CHARS = 200
/** 命中窗口的硬上限；正文不超过它的条目落到节选位时直接给全文，节选不会比它更省。 */
export const WINDOW_MAX_CHARS = 300

/**
 * 结果里有节选条目时接在开头说明最后：讲清节选是什么、取全文的两条路，并提醒更新是整条替换。
 * 不带说明码，渲染时由命中里有没有节选条目推出。
 */
export const EXCERPT_NOTE = '下面头行标「节选」的条目只给出正文的一段（有命中词时取它附近）。要全文，用 memory_search 按 id 查，或读头行末尾路径指向的文件。更新记忆会替换整条正文，更新前先确认已读过它的全文。'

/** 节选正文：窗口前后还有正文时各加一行省略标记；标记不以头行格式开头，对话卡片按头行计数不受影响。 */
function excerptOf(content: string, terms: readonly string[]): string {
  const w = matchWindow(content, terms, WINDOW_TARGET_CHARS, WINDOW_MAX_CHARS)
  return [w.hasBefore ? '[前文省略]' : undefined, w.text, w.hasAfter ? '[后文省略]' : undefined]
    .filter((x): x is string => x !== undefined).join('\n')
}

/** 命中的 core 记忆全文已在本会话快照里时，正文换成这句：同一段全文不在上下文里贴两遍。 */
export const IN_SNAPSHOT_NOTE = '全文已在本会话带入的长期记忆里。'

/** 命中弱时附在说明末尾：排第一的连一半都没对上，提示模型可以换词再搜，而不是把弱结果当定论。 */
export const RETRY_HINT = '命中弱，可以换同义词、换成另一种语言的写法、减少词数或换个角度再搜一次。'
/**
 * 说明文案（码在 contract-codes）：返回列表里没有全命中记录、首条覆盖过半 / 首条覆盖不到一半（见 search/coverage.ts）/
 * 只有旧子串匹配命中的记录（第三档）。覆盖过半的只如实说明，不劝重搜：首条缺个词往往只是换了说法，要不要再搜由模型看结果判断。
 */
export const OR_FALLBACK_NOTE = '没有记忆同时含全部关键词，以下按相关性排序。'
export const LOW_COVERAGE_NOTE = `没有记忆同时含全部关键词，排第一的对上的查询内容不到一半，以下按相关性排序。${RETRY_HINT}`
export const SUBSTRING_FALLBACK_NOTE = `没有命中关键词的记忆，以下只是关键词以子串出现的结果。${RETRY_HINT}`

/**
 * 逐条命中说明，接在头行陈旧说明之后：每条各对上了什么，扫头行就能比较各条的成色。全命中不加。
 * 部分命中但列不出完整词（只盖住了词的一部分，或对上的只是长句段）单独一种，不和子串命中混在一起。
 */
export function matchNoteOf(tier: SearchTier, terms: readonly string[]): string {
  if (tier === 'all') return ''
  if (tier === 'substring') return ' · 仅子串命中'
  return terms.length > 0 ? ` · 匹配：${terms.join('、')}` : ' · 部分命中，没有可列出的完整关键词'
}

/**
 * match: all 搜空时的说明（码 all-no-hit）：先说没有全命中，接逐词命中条数，再说换 any 能看到什么。
 * 不带码的「没有匹配的记忆」只在 any 下出现：all 搜空时部分命中的记忆可能就在范围里，要让模型知道还有这条路。
 */
export const ALL_NO_HIT_NOTE = '没有记忆同时含全部关键词。'
export const ANY_MATCH_HINT = '改用 match: "any" 可以看部分命中的结果。'

/** any 模式截断、且全部结果里有非全命中时接在截断说明末尾：all 会改变结果时才提。 */
export const MATCH_ALL_HINT = '用 match: "all" 可以只看同时含全部关键词的记忆。'

/** 类型缺失说明里条数表的一行：类型名、类型表给的标签（与名字相同时不带）、不限类型时能查到的有效记忆条数。 */
export interface TypeCount { type: string; label?: string; count: number }

/**
 * 填的类型在范围内没有有效记忆时的说明（码 types-no-records）：先列缺的类型，再给不限类型时范围内各类型几条，
 * 让模型分得清是这几类没有、还是关键词没对上。条数表为空只说不限类型也没有查到有效记忆：表是取舍过滤后的视图，
 * 不等于范围内没有记忆（取舍可能选中过期的新副本、丢掉有效的旧副本）。
 */
export function typesNoRecordsNote(missing: readonly string[], counts: readonly TypeCount[]): string {
  const head = `范围内没有 ${missing.join('、')} 类型的记忆`
  if (counts.length === 0) return `${head}，不限类型也没有查到有效记忆。`
  const rows = counts.map(c => `${c.type}${c.label !== undefined ? `（${c.label}）` : ' '}${c.count} 条`)
  return `${head}。不限类型时范围内的记忆：${rows.join('、')}。`
}

/** 逐词命中那行的开头。 */
export const TERM_HITS_LEAD = '各关键词命中的记忆条数：'

/** 逐词命中一行最多列几个词，多的写「等 N 个」。 */
export const TERM_NOTE_MAX = 8

/**
 * 命中弱或首条缺关键词时接在说明后的一行：各关键词在范围内命中几条，一条都没命中的单独点名，让模型知道是哪个词没对上。
 * 没有可列的词（如纯数字查询）时返回 undefined，不出这一行。
 */
export function termHitNote(counts: readonly TermHitCount[]): string | undefined {
  if (counts.length === 0) return undefined
  const list = (items: readonly string[]) =>
    items.length > TERM_NOTE_MAX ? `${items.slice(0, TERM_NOTE_MAX).join('、')} 等 ${items.length} 个` : items.join('、')
  const head = `${TERM_HITS_LEAD}${list(counts.map(c => `${c.label} ${c.count}`))}。`
  const zero = counts.filter(c => c.count === 0).map(c => c.label)
  return zero.length === 0 ? head : `${head}范围内一条都没命中的：${list(zero)}。`
}

/** 返回条数上限的缺省值与硬上限。 */
export const DEFAULT_SEARCH_LIMIT = 10
export const MAX_SEARCH_LIMIT = 50

/**
 * 命中多于返回条数时附在开头：不说的话模型以为结果就这么多。两条路都摆出来，由模型按需要选——
 * 要更全就调大 limit，结果太杂就换更具体的词缩小范围；limit 已到上限时只剩后一条。
 */
export function truncationNote(total: number, shown: number, atCap: boolean): string {
  const head = `共命中 ${total} 条，只列出前 ${shown} 条。`
  return atCap
    ? `${head}limit 已是上限 ${MAX_SEARCH_LIMIT}，想缩小范围可以换更具体的关键词。`
    : `${head}要看更多可以调大 limit（最多 ${MAX_SEARCH_LIMIT}），想缩小范围可以换更具体的关键词。`
}

/**
 * 把命中结果渲染成给模型看的一段文本：有说明先写说明，再列命中（头行末尾带文件绝对路径）。纯函数。
 * 节选条目在头行路径前标字数，路径保持在行末；有节选条目时开头说明最后接节选说明。
 */
export function renderSearchResult(result: { hits: SearchHit[]; note?: string; moreNote?: string; quoteNote?: string; dialogueText?: string; onlyDialogue?: boolean; pathNote?: string }): string {
  if (result.dialogueText !== undefined) {
    const memories = result.onlyDialogue ? undefined : renderSearchResult({ hits: result.hits, note: result.note, moreNote: result.moreNote, quoteNote: result.quoteNote })
    return result.onlyDialogue ? result.dialogueText : renderSearchSections({ memories, dialogue: result.dialogueText })
  }
  if (result.pathNote) return result.pathNote + '\n' + renderSearchResult({ hits: result.hits, note: result.note, moreNote: result.moreNote, quoteNote: result.quoteNote })
  const blocks = result.hits.map(h => `[${h.id}] ${h.type}｜${h.summary}${h.sourceNote}${h.stalenessNote}${h.matchNote}${h.isExcerpt ? ` · 节选，正文共 ${h.contentChars} 字符` : ''}${h.path !== undefined ? ` · ${h.path}` : ''}\n${h.content}${h.quote !== undefined ? `\n${h.quote}` : ''}`)
  const excerptNote = result.hits.some(h => h.isExcerpt) ? EXCERPT_NOTE : undefined
  const head = [result.note, result.moreNote, excerptNote, result.quoteNote].filter((x): x is string => x !== undefined).join('\n')
  if (head !== '') blocks.unshift(head)
  return blocks.length === 0 ? '没有匹配的记忆。' : blocks.join('\n\n')
}

/** 类型缺失说明：条数降序，同数按类型名；类型名来自读盘，旧场景的类型也会出现，类型表给得出标签才附。只有条数，不带任何记录字段。 */
function missingTypesNote(types: readonly string[], counts: ReadonlyArray<{ type: string; count: number }>, registry: TypeRegistry): string {
  const table = counts.map(({ type, count }) => {
    const label = registry.get(type).label
    return { type, count, ...(label !== type ? { label } : {}) }
  }).sort((x, y) => y.count - x.count || (x.type < y.type ? -1 : x.type > y.type ? 1 : 0))
  return typesNoRecordsNote(types, table)
}

/**
 * memory_search 工具的真正执行逻辑：解析上下文和范围，取记忆候选（search/memory-candidates），再截断、把已带入快照的正文换成说明、
 * 定节选和说明码；结果定了以后才记召回。
 * 不依赖任何 dsh 框架包，测试直接调它。
 */
async function executeMemorySearch(
  args: SearchArgs,
  exec: ToolRunContext,
  deps: SearchToolDeps,
  onListed?: (listed: MemoryListing) => void,
): Promise<{ hits: SearchHit[]; note?: string; noteCode?: SearchNoteCode; moreNote?: string }> {
  const a = args
  const context = await deps.host.contextOf(exec)
  const { workspacePath, session } = context
  // 明确要"只看本项目"而当前会话没有工作目录：显式说明而非静默落回 global-only——
  // 用户要项目范围时给他全局结果是误导
  if (a.scope === 'workspace' && workspacePath === undefined) {
    return { hits: [], noteCode: 'no-workspace', note: '当前会话没有工作目录，无法限定项目范围；查全局记忆请用 scope: "global"。' }
  }
  const limit = Math.min(a.limit ?? DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT)
  const scopeFilter: QueryScope = a.scope === 'global'
    ? { kind: 'global' }
    : a.scope === 'workspace' && workspacePath
      ? { kind: 'workspace', workspacePath }
      : { kind: 'visible', workspacePath }
  const found = await findMemoryCandidates({ query: a.query, types: a.types, scope: scopeFilter }, deps)
  const now = found.at
  const ranked = found.candidates
  const isDirect = found.isDirectHit
  const { tokens, legacyTerms, groups } = found.diagnostics
  const typesNote = found.diagnostics.missingTypeCounts === undefined ? undefined : missingTypesNote(a.types!, found.diagnostics.missingTypeCounts, deps.registry)
  // 全命中档（置顶的 id 直达不滤）。没有可打分 token 时 match 不起作用：留空时全在全命中档，
  // 只有噪声词项时记忆靠旧词项进子串档，没有东西可以「全部命中」，照滤会平白搜空
  const allOnly = tokens.length > 0 ? ranked.filter((e, i) => e.tier === 'all' || (isDirect && i === 0)) : ranked
  const matchAll = a.match === 'all' && tokens.length > 0
  // 过滤放在排序之后：逐词命中条数仍按全部候选（ranked）算
  const listed = matchAll ? allOnly : ranked
  const top = listed.slice(0, limit)
  const { sessionRecall } = deps
  const handle = session.handle
  // 快照带入时的正文与现在一致才省略：冻结后改过的、同 id 取到别层副本的，快照里那份不是这一版
  const injected = sessionRecall && handle ? sessionRecall.injectedCore(handle) : undefined

  // 说明码只看返回列表：没有全命中时，排第一的部分命中记录覆盖过半 → or-fallback，不到一半 → low-coverage；
  // 连部分命中也没有、只剩第三档 → substring-fallback（三者互斥、substring 优先）。判弱的两种、以及首条缺关键词的 or-fallback
  // 附逐词命中条数（范围内全部候选）；缺的是哪些词由逐条命中说明给出。
  // 查询恰是某条记忆的 id：它已置顶，就是要找的那条，不出说明码
  const hasTier = (tier: SearchTier) => top.some(e => e.tier === tier)
  // match: all 搜空 → all-no-hit（返回列表为空，与上面三码互斥）；all 有结果时列表只剩全命中档，三码自然不出。
  // 范围内没有任何命中时换 any 也是空，不出此码，和 any 一样是不带码的空结果
  const allNoHit = matchAll && top.length === 0 && ranked.length > 0
  // 优先级（结果只带一个码）：no-workspace（上面已返回）→ types-no-records → all-no-hit → 三码；类型缺失时候选为空，后面几码本就不成立
  let note: { noteCode: SearchNoteCode; note: string } | undefined =
    typesNote === undefined ? undefined : { noteCode: 'types-no-records', note: typesNote }
  if (note === undefined && (allNoHit || (top.length > 0 && !hasTier('all') && !isDirect))) {
    const withCounts = (text: string) => [text, termHitNote(found.diagnostics.termHits)].filter(x => x !== undefined).join('\n')
    const first = top.find(e => e.tier === 'partial')
    const verdict = first === undefined ? undefined : judgeTopHit(groups, tokens, first.tokenHits)
    if (allNoHit) note = { noteCode: 'all-no-hit', note: [withCounts(ALL_NO_HIT_NOTE), ANY_MATCH_HINT].join('\n') }
    else if (verdict === undefined) note = { noteCode: 'substring-fallback', note: withCounts(SUBSTRING_FALLBACK_NOTE) }
    else if (verdict.weak) note = { noteCode: 'low-coverage', note: withCounts(LOW_COVERAGE_NOTE) }
    else if (verdict.missingKeywords.length > 0) note = { noteCode: 'or-fallback', note: withCounts(OR_FALLBACK_NOTE) }
    else note = { noteCode: 'or-fallback', note: OR_FALLBACK_NOTE }
  }
  // 形态判定按排名逐条做，状态只有两个：已计入的全文字数、级联是否已开始（开始后不再结束）
  let fullChars = 0
  let cascading = false
  const result = {
    ...note,
    ...(listed.length > top.length
      ? { moreNote: truncationNote(listed.length, top.length, limit === MAX_SEARCH_LIMIT) + (listed.length > allOnly.length && allOnly.some(e => e.tier === 'all') ? MATCH_ALL_HINT : '') }
      : {}),
    // 与注入同口径：只遮明确密钥（疑似级写入时用户已确认）；文件路径同注入，name 被遮的不给，其余遮一遍
    hits: top.map(({ record: h, tier: rankedTier, tokenHits, filePath }, i) => {
      const masked = maskSecretSurface(h)
      const path = exposedPath(h, filePath)
      // id 直达置顶的那条就是模型按 id 要的，不标命中情况（同它不出说明码）
      const tier = isDirect && i === 0 ? 'all' : rankedTier
      const terms = tier === 'partial' ? matchedTerms(groups, tokens, tokenHits) : []
      // 形态：全文已在注入快照里的仍给说明句，计 0；按 id 要的那条全文；单条超门槛的节选、不计入；
      // 保底范围内全文；之后按预算累计，某条放不下就开始级联，它和之后走到这一步的都给节选
      let content = masked.content
      let isExcerpt = false
      if (injected?.get(h.id) === h.content) content = IN_SNAPSHOT_NOTE
      else {
        const chars = masked.content.length
        if (isDirect && i === 0) fullChars += chars
        else if (chars > EXCERPT_ABOVE_CHARS) isExcerpt = true
        else if (i < FULL_TEXT_GUARANTEED_HITS) fullChars += chars
        else if (!cascading && fullChars + chars <= FULL_TEXT_BUDGET_CHARS) fullChars += chars
        // 节选不会比窗口硬上限更省，短条目直接给全文，不计入、也不开始级联
        else if (chars > WINDOW_MAX_CHARS) {
          cascading = true
          isExcerpt = true
        }
        if (isExcerpt) {
          // 命中词取这条命中的全部查询 token：分词会产出嵌套 token（「新鲜度」拆出「新鲜」），只取可按子串定位的会让
          // 只命中短 token 的记录窗口落到开头。记录已确定命中，这里只挑位置。只在子串档命中的用旧词项
          const words = rankedTier === 'substring' ? legacyTerms : tokens.filter((_, k) => tokenHits[k])
          content = excerptOf(masked.content, words)
        }
      }
      return {
        id: h.id, type: h.type, summary: masked.summary,
        content,
        sourceNote: sourceNote(h),
        stalenessNote: stalenessNote(h, deps.registry.get(h.type).decayDays, now),
        matchNote: matchNoteOf(tier, terms),
        ...(tier === 'partial' ? { matchedTerms: terms } : {}),
        ...(path !== undefined ? { path } : {}),
        ...(isExcerpt ? { isExcerpt, contentChars: masked.content.length } : {}),
      }
    }),
  }
  // 输出定了才记召回：拿得到会话时同一会话每条只计一次，拿不到时每次都计
  const topIds = top.map(e => e.record.id)
  if (sessionRecall && handle) await sessionRecall.markRecalled(handle, topIds)
  else await deps.store.markRecalled(topIds, now)
  onListed?.({ top, context })
  return result
}

/** 记忆一路这次返回的候选（和 hits 逐条对应）和会话上下文：记忆带原话从这里取锚，不再按 id 读记忆。 */
interface MemoryListing { top: readonly MemoryCandidate[]; context: SearchContext }

type SearchOutcome = Awaited<ReturnType<typeof executeMemorySearch>> & { dialogueText?: string; onlyDialogue?: boolean; pathNote?: string; quoteNote?: string }

/**
 * 记忆带原话：先走和原话检索同一个追库入口，再给排名靠前的记忆接上出处原话。用检索开头定下的截止时间剩下的部分，
 * 库这次用不了、这一路超时或出故障都只说明一次，记忆照常返回。
 * 带原话开不开在检索开头读一次，整次检索照它给；追库回来说功能关了，就当没开过。只查记忆时走这里；两者都查时附原话和原话检索一起做。
 */
async function withMemoryQuotes(outcome: SearchOutcome, listing: MemoryListing, query: string, deps: SearchToolDeps & { dialogue: DialogueSearchDeps }, deadline: number): Promise<SearchOutcome> {
  const now = deps.now ?? Date.now
  const { dialogue } = deps
  const remaining = deadline - now()
  const path = remaining <= 0 ? { ok: false as const } : await runPath('memory-quotes', async () => {
    const readiness = await catchUpFor(listing.context, dialogue)
    // 库这次用不了或功能关了：不查会话表、不加载分词器、不读库
    if (readiness.kind !== 'ready') return { kind: readiness.kind }
    return { kind: 'ready' as const, ...await quoteMemories(shownOf(listing.top, outcome.hits), query, listing.context, quoteDepsOf(dialogue)) }
  }, remaining, now)
  if (!path.ok) return { ...outcome, quoteNote: MEMORY_QUOTES_UNAVAILABLE }
  if (path.value.kind !== 'ready') return path.value.kind === 'off' ? outcome : { ...outcome, quoteNote: MEMORY_QUOTES_UNAVAILABLE }
  return withQuoteBlocks(outcome, path.value, [], listing.top)
}

/** 候选连同这次给出的形态：只给了节选的，判「和记忆正文相同」时不拿它的正文比。 */
function shownOf(top: readonly MemoryCandidate[], hits: readonly SearchHit[]): Array<MemoryCandidate & { isExcerpt: boolean }> {
  return top.map((c, i) => ({ ...c, isExcerpt: hits[i]?.isExcerpt === true }))
}

/** 取原话要用的边界：会话表和原话检索共用这次检索查到的那一份。 */
function quoteDepsOf(dialogue: DialogueSearchDeps) {
  const sessionTable = async () => (await (dialogue.sessions?.() ?? listSessionTable(dialogue))).table
  return { store: dialogue.store, tokenizer: dialogue.tokenizer, sessionTable, isOutOfScope: (id: string) => dialogue.catchup.isOutOfScope(id) }
}

/** 给记忆条目接上附的原话：原话检索装进来、落在已附那几轮里的段先并进去，再渲染。 */
function withQuoteBlocks(outcome: SearchOutcome, quotes: MemoryQuotes, merged: FinishedDialogue['merged'], top: readonly MemoryCandidate[]): SearchOutcome {
  return {
    ...outcome,
    hits: outcome.hits.map((hit, i) => {
      const block = quotes.quotes[i]
      const quote = renderQuoteBlock(block === undefined ? undefined : withDialogueSegments(block, merged, hit.isExcerpt ? undefined : top[i]!.record.content))
      return quote === undefined ? hit : { ...hit, quote }
    }),
    ...(quotes.note !== undefined ? { quoteNote: quotes.note } : {}),
  }
}

/**
 * 解析来源、分路检索。开头定一个截止时间，原话检索和附原话都用它剩下的部分；追库和会话表各路共用、各只做一次。
 */
export async function executeSearch(args: SearchArgs, exec: ToolRunContext, deps: SearchToolDeps): Promise<SearchOutcome> {
  const deadline = (deps.now ?? Date.now)() + DIALOGUE_PATH_BUDGET_MS
  return searchSources(args, exec, deps.dialogue === undefined ? deps : { ...deps, dialogue: shareDialogueReads(deps.dialogue) }, deadline)
}

/**
 * 只查记忆时保留记忆执行器的行为（带原话开着就在结果定了以后附原话）。含原话时原话这一路隔离故障：出任何故障、超时都退回只查记忆，
 * 记忆段和不开这些功能时一样，说明一次。两者都查时，记忆一路照常算；附原话、记忆按名次记到出处轮、和原话检索融合、按预算装填都在原话这一路里做。
 */
async function searchSources(args: SearchArgs, exec: ToolRunContext, deps: SearchToolDeps, deadline: number): Promise<SearchOutcome> {
  const now = deps.now ?? Date.now
  const configured = deps.searchSource?.() ?? 'memory'
  const source = args.source ?? configured
  const hasQuery = args.query.trim() !== ''
  // 带原话开不开只在开头读一次：检索中途改了设置，下次检索才生效
  const isQuoting = deps.memoryQuotes?.() === true && deps.dialogue !== undefined && hasQuery
  if (configured === 'memory' || source === 'memory') {
    let listing: MemoryListing | undefined
    const memories = await executeMemorySearch(args, exec, deps, isQuoting ? listed => { listing = listed } : undefined)
    const outcome = configured === 'memory' && source !== 'memory' ? { ...memories, pathNote: dialogueNote('dialogue-source-off') } : memories
    // 记忆一条都没命中：没有要附原话的，结果照常（含「没有匹配的记忆。」）
    return listing === undefined || listing.top.length === 0 ? outcome : withMemoryQuotes(outcome, listing, args.query, deps as SearchToolDeps & { dialogue: DialogueSearchDeps }, deadline)
  }
  if (!hasQuery) return source === 'dialogue' ? { hits: [], dialogueText: DIALOGUE_QUERY_REQUIRED, onlyDialogue: true } : executeMemorySearch(args, exec, deps)
  // 两路共享同一次宿主快照；记忆执行器仍按原来的接口读取上下文。
  let context: Promise<SearchContext> | undefined
  const contextOf = () => context ??= deps.host.contextOf(exec)
  const sharedDeps = { ...deps, host: { contextOf } }
  let listing: MemoryListing | undefined
  let memoryTask: ReturnType<typeof executeMemorySearch> | undefined
  const memories = () => memoryTask ??= executeMemorySearch(args, exec, sharedDeps, listed => { listing = listed })
  const wantsQuotes = source === 'both' && isQuoting
  const dialogueTask = runPath('dialogue', async () => {
    if (!deps.dialogue) throw new Error('缺少原话依赖')
    const dialogue = { ...deps.dialogue, isEnabled: () => deps.searchSource?.() !== 'memory' }
    const ctx = await contextOf()
    const retrieval = await retrieveDialogue(args, ctx, dialogue)
    if (retrieval.kind !== 'ready' || source !== 'both') return { result: retrieval.kind === 'ready' ? await finishDialogue(retrieval, dialogue) : retrieval }
    // 两路候选都出自这一次检索：记忆取自这次读盘，原话取自这次追到的库；融合时不再读记忆
    const memoryHits = (await memories()).hits
    const top = listing?.top ?? []
    const shown = shownOf(top, memoryHits)
    const quotes = wantsQuotes && top.length > 0 ? await quoteMemories(shown, args.query, ctx, quoteDepsOf(dialogue), retrieval.gen) : undefined
    const blocks = quotes?.quotes ?? []
    const { lane, related } = memoryLane(top, args.query, { store: dialogue.store, gen: retrieval.gen, tokenizer: await dialogue.tokenizer(), allowed: retrieval.allowed })
    // 已附在记忆下面的轮对应附它的那条记忆
    for (const [i, block] of blocks.entries()) for (const t of block?.turns ?? []) related.set(t.key, top[i]!.record)
    const result = await finishDialogue(retrieval, dialogue, {
      lanes: [lane],
      attached: new Set(blocks.flatMap(b => b?.turns.map(t => t.key) ?? [])),
      given: new Set(blocks.flatMap(b => b?.turns.flatMap(t => t.view.messages.map(m => segmentKey({ sessionId: t.view.sessionId, seq: m.seq, segment: m.segment }))) ?? [])),
      related: new Map([...related].map(([turn, record]) => [turn, { label: memoryLabelOf(record), content: shown.some(c => c.record === record && c.isExcerpt) ? undefined : record.content }])),
    })
    return { result, quotes }
  }, deadline - now(), now)
  // 只查原话时不提前召回记忆；两路同时查时也立即接住记忆的失败。
  const [path] = await Promise.all([dialogueTask, source === 'both' ? memories() : undefined])
  if (deps.searchSource?.() === 'memory') return { ...await memories(), pathNote: dialogueNote('dialogue-source-off') }
  if (!path.ok || path.value.result.kind !== 'ready') {
    const code = path.ok && path.value.result.kind === 'off' ? 'dialogue-source-off' : 'dialogue-unavailable'
    const note = path.ok && path.value.result.notes.length > 0 ? path.value.result.notes.join('\n') : dialogueNote(code)
    return { ...await memories(), ...(source === 'both' ? { dialogueText: note } : { pathNote: note }) }
  }
  const dialogueText = renderDialogueSearch(path.value.result)
  if (source === 'dialogue') return { hits: [], dialogueText, onlyDialogue: true }
  const memoryOutcome = await memories()
  const { quotes } = path.value
  const withQuotes = quotes !== undefined ? withQuoteBlocks(memoryOutcome, quotes, path.value.result.merged, listing!.top) : memoryOutcome
  return { ...withQuotes, dialogueText, onlyDialogue: false }
}
