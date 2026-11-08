import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { MemoryStore, QueryScope } from '../store.ts'
import type { SearchNoteCode } from '../contract-codes.ts'
import { expandQueryTerms } from '../text.ts'
import { resolveLiveFirst } from '../storage/table.ts'
import { tokenizerForQuery, type QueryTokenizerOptions } from '../search/jieba-segmenter.ts'
import { CJK } from '../search/tokenizer.ts'
import { anchorTerms, compareRanked, pendingLast, rankRecords, type RankedRecord, type SearchTier } from '../search/ranking.ts'
import { groupQueryTerms, judgeTopHit, matchedTerms, termHitCounts, type TermHitCount } from '../search/coverage.ts'
import type { TypeRegistry } from '../type-registry.ts'
import type { ContextHost } from './host-session.ts'
import { sourceNote } from '../index-line.ts'
import { stalenessNote, withinValidity } from '../record-freshness.ts'
import { exposedPath, maskSecretSurface } from '../secrets.ts'

/** memory_search 运行时需要的会话上下文，由宿主会话适配器的 contextOf 提供。 */
export interface SearchContext {
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

/** 把命中结果渲染成给模型看的一段文本：有说明先写说明，再列命中（头行末尾带文件绝对路径）。纯函数。 */
export function renderSearchResult(result: { hits: SearchHit[]; note?: string; moreNote?: string }): string {
  const blocks = result.hits.map(h => `[${h.id}] ${h.type}｜${h.summary}${h.sourceNote}${h.stalenessNote}${h.matchNote}${h.path !== undefined ? ` · ${h.path}` : ''}\n${h.content}`)
  const head = [result.note, result.moreNote].filter((x): x is string => x !== undefined).join('\n')
  if (head !== '') blocks.unshift(head)
  return blocks.length === 0 ? '没有匹配的记忆。' : blocks.join('\n\n')
}

const CJK_CHAR = new RegExp(`[${CJK}]`, 'u')

/** 单个字母、纯数字几乎在每个文件里出现：既不作为打分 token，也不能进 any 模式预筛。单个 CJK 字是实词，保留。 */
function isNoiseTerm(term: string): boolean {
  return /^\p{N}+$/u.test(term) || ([...term].length === 1 && !CJK_CHAR.test(term))
}

/**
 * memory_search 工具的真正执行逻辑：解析上下文、按范围读取、取舍过滤、分档打分、排序截断、标记召回。
 * 不依赖任何 dsh 框架包，测试直接调它。
 */
export async function executeSearch(
  args: SearchArgs,
  exec: ToolRunContext,
  deps: SearchToolDeps,
): Promise<{ hits: SearchHit[]; note?: string; noteCode?: SearchNoteCode; moreNote?: string }> {
  const a = args
  const { workspacePath, session } = await deps.host.contextOf(exec)
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
  const hint = scopeFilter.kind === 'global' ? undefined : scopeFilter.workspacePath
  // 查询与记录两侧共用这一个分词器：查询含汉字时是 jieba 档（首次搜索才加载），否则 bigram
  const tokenize = await tokenizerForQuery(a.query, deps.tokenizer)
  // 两套词项：新 token 定前两档并打分（分词命中计词频，字段子串命中只计命中）；旧词项（expandQueryTerms）给第三档，
  // 兜住 id 这类不打分字段的子串命中，保证今天靠子串能命中的查询仍命中
  const tokens = [...new Set(tokenize(a.query))].filter(t => !isNoiseTerm(t))
  const legacyTerms = expandQueryTerms(a.query)
  // 预筛词 = token ∪ 旧词项，any 模式；两侧同一分词器，记录侧 token 必是原文连续子串，字段子串命中按定义也是，所以预筛是超集。
  // 并集里出现噪声词项（单字母、纯数字）时不预筛：剔掉它会漏掉只靠它命中的记录，留着它预筛也几乎不跳过任何文件。
  const unionTerms = [...new Set([...tokens, ...legacyTerms])]
  const prefilter = unionTerms.length > 0 && !unionTerms.some(isNoiseTerm)
    ? { prefilterTerms: unionTerms, prefilterMatch: 'any' as const }
    : {}
  const now = deps.now?.() ?? Date.now()
  // 与快照预读同一条路：按范围读取 → 同 id 取舍 → active → validTo（过期的不进检索，治理扫描仍可见）
  const read = await deps.store.readRaw(scopeFilter, { ...(a.types ? { types: a.types } : {}), ...prefilter })
  const located = resolveLiveFirst(read.records, { workspacePath: hint })
    .filter(l => l.record.status === 'active' && withinValidity(l.record, now))
  const candidates = located.map(l => l.record)
  // 取舍后同 id 只留一份，命中按 id 取回它的文件绝对路径
  const filePathOf = new Map(located.map(l => [l.record.id, l.filePath]))

  let ranked: RankedRecord[]
  if (tokens.length === 0 && legacyTerms.length === 0) {
    // 零 token 查询：不做关键词过滤，范围内全部按 confidence、lastConfirmedAt 排
    ranked = candidates.map(record => ({ record, tier: 'all' as const, coverage: 0, anchorHits: 0, score: 0, tokenHits: [] }))
  } else {
    ranked = rankRecords({ tokens, legacyTerms, anchors: anchorTerms(a.query), records: candidates, listedCount: read.listedCount, tokenize })
  }
  // 主档在前、待确认在后（深度浅的在前），再截断：主档命中不足 limit 时待确认才露出
  ranked = pendingLast(ranked.sort(compareRanked))
  // id 直达：查询恰等于某条可见记忆的 id，该条排第一
  const directId = a.query.trim()
  const direct = ranked.findIndex(e => e.record.id === directId)
  if (direct > 0) ranked.unshift(...ranked.splice(direct, 1))
  const isDirect = direct >= 0
  // 全命中档（置顶的 id 直达不滤）。没有可打分 token 时 match 不起作用：留空时全在全命中档，
  // 只有噪声词项时记忆靠旧词项进子串档，没有东西可以「全部命中」，照滤会平白搜空
  const allOnly = tokens.length > 0 ? ranked.filter((e, i) => e.tier === 'all' || (isDirect && i === 0)) : ranked
  const matchAll = a.match === 'all' && tokens.length > 0
  // 过滤放在排序之后：逐词命中条数仍按全部候选（ranked）算
  const listed = matchAll ? allOnly : ranked
  const top = listed.slice(0, limit)
  const topIds = top.map(e => e.record.id)
  const { sessionRecall } = deps
  const handle = session.handle
  // 拿得到会话时同一会话每条只计一次召回，拿不到时每次都计
  if (sessionRecall && handle) await sessionRecall.markRecalled(handle, topIds)
  else await deps.store.markRecalled(topIds, now)
  // 快照带入时的正文与现在一致才省略：冻结后改过的、同 id 取到别层副本的，快照里那份不是这一版
  const injected = sessionRecall && handle ? sessionRecall.injectedCore(handle) : undefined

  // 查询分组：开头说明的判弱、逐词命中条数与逐条命中说明共用
  const groups = groupQueryTerms(a.query, tokens, tokenize)

  // 说明码只看返回列表：没有全命中时，排第一的部分命中记录覆盖过半 → or-fallback，不到一半 → low-coverage；
  // 连部分命中也没有、只剩第三档 → substring-fallback（三者互斥、substring 优先）。判弱的两种、以及首条缺关键词的 or-fallback
  // 附逐词命中条数（范围内全部候选）；缺的是哪些词由逐条命中说明给出。
  // 查询恰是某条记忆的 id：它已置顶，就是要找的那条，不出说明码
  const hasTier = (tier: SearchTier) => top.some(e => e.tier === tier)
  // match: all 搜空 → all-no-hit（返回列表为空，与上面三码互斥）；all 有结果时列表只剩全命中档，三码自然不出。
  // 范围内没有任何命中时换 any 也是空，不出此码，和 any 一样是不带码的空结果
  const allNoHit = matchAll && top.length === 0 && ranked.length > 0
  let note: { noteCode: SearchNoteCode; note: string } | undefined
  if (allNoHit || (top.length > 0 && !hasTier('all') && !isDirect)) {
    const rows = ranked.map(e => e.tokenHits)
    const withCounts = (text: string) => [text, termHitNote(termHitCounts(groups, tokens, rows))].filter(x => x !== undefined).join('\n')
    const first = top.find(e => e.tier === 'partial')
    const verdict = first === undefined ? undefined : judgeTopHit(groups, tokens, first.tokenHits)
    if (allNoHit) note = { noteCode: 'all-no-hit', note: [withCounts(ALL_NO_HIT_NOTE), ANY_MATCH_HINT].join('\n') }
    else if (verdict === undefined) note = { noteCode: 'substring-fallback', note: withCounts(SUBSTRING_FALLBACK_NOTE) }
    else if (verdict.weak) note = { noteCode: 'low-coverage', note: withCounts(LOW_COVERAGE_NOTE) }
    else if (verdict.missingKeywords.length > 0) note = { noteCode: 'or-fallback', note: withCounts(OR_FALLBACK_NOTE) }
    else note = { noteCode: 'or-fallback', note: OR_FALLBACK_NOTE }
  }
  return {
    ...note,
    ...(listed.length > top.length
      ? { moreNote: truncationNote(listed.length, top.length, limit === MAX_SEARCH_LIMIT) + (listed.length > allOnly.length && allOnly.some(e => e.tier === 'all') ? MATCH_ALL_HINT : '') }
      : {}),
    // 与注入同口径：只遮明确密钥（疑似级写入时用户已确认）；文件路径同注入，name 被遮的不给，其余遮一遍
    hits: top.map(({ record: h, tier: rankedTier, tokenHits }, i) => {
      const masked = maskSecretSurface(h)
      const path = exposedPath(h, filePathOf.get(h.id)!)
      // id 直达置顶的那条就是模型按 id 要的，不标命中情况（同它不出说明码）
      const tier = isDirect && i === 0 ? 'all' : rankedTier
      const terms = tier === 'partial' ? matchedTerms(groups, tokens, tokenHits) : []
      return {
        id: h.id, type: h.type, summary: masked.summary,
        content: injected?.get(h.id) === h.content ? IN_SNAPSHOT_NOTE : masked.content,
        sourceNote: sourceNote(h),
        stalenessNote: stalenessNote(h, deps.registry.get(h.type).decayDays, now),
        matchNote: matchNoteOf(tier, terms),
        ...(tier === 'partial' ? { matchedTerms: terms } : {}),
        ...(path !== undefined ? { path } : {}),
      }
    }),
  }
}
