import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { MemoryStore, QueryScope } from '../store.ts'
import type { SearchNoteCode } from '../contract-codes.ts'
import { expandQueryTerms } from '../text.ts'
import { resolveLiveFirst } from '../storage/table.ts'
import { tokenizerForQuery, type QueryTokenizerOptions } from '../search/jieba-segmenter.ts'
import { CJK } from '../search/tokenizer.ts'
import { anchorTerms, compareRanked, rankRecords, type RankedRecord, type SearchTier } from '../search/ranking.ts'
import type { TypeRegistry } from '../type-registry.ts'
import { sourceNote } from '../index-line.ts'
import { stalenessNote, withinValidity } from '../record-freshness.ts'
import { exposedPath, maskSecretSurface } from '../secrets.ts'

/** memory_search 运行时需要的会话上下文，由框架绑定层的 resolveContext 提供。 */
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
  resolveContext(exec: ToolRunContext): Promise<SearchContext>
  /** 分词器选项：用户词典路径（现读）与降级告警的日志器。缺省只用主词典、告警走 console。 */
  tokenizer?: QueryTokenizerOptions
  /** 缺省（纯测试场景）或拿不到 session 时：正文照常给全文，每次检索都计召回。 */
  sessionRecall?: SessionRecall
}

export interface SearchArgs {
  query: string
  types?: string[]
  scope?: 'global' | 'workspace' | 'all-visible'
  limit?: number
}

export interface SearchHit {
  id: string
  type: string
  summary: string
  content: string
  sourceNote: string
  stalenessNote: string
  /** 记忆文件的绝对路径（记忆根目录 + 目录名 + 文件名）；模型要全文或上下文时直接 Read。name 含明确密钥时不给（见 exposedPath）。 */
  path?: string
}

/** 命中的 core 记忆全文已在本会话快照里时，正文换成这句：同一段全文不在上下文里贴两遍。 */
export const IN_SNAPSHOT_NOTE = '全文已在开头的长期记忆里。'

/** 命中弱时附在说明末尾：说明码本身就是「相关度弱」的信号，提示模型换词再搜一次，而不是把弱结果当定论。 */
export const RETRY_HINT = '命中弱，可以换同义词、减少词数或换个角度再搜一次。'
/** 说明文案（码在 contract-codes）：返回列表里没有全命中记录 / 只有旧子串匹配命中的记录（第三档）。 */
export const OR_FALLBACK_NOTE = `没有同时命中全部关键词的记忆，以下按相关性排序。${RETRY_HINT}`
export const SUBSTRING_FALLBACK_NOTE = `没有命中关键词的记忆，以下只是关键词以子串出现的结果。${RETRY_HINT}`

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
  const blocks = result.hits.map(h => `[${h.id}] ${h.type}｜${h.summary}${h.sourceNote}${h.stalenessNote}${h.path !== undefined ? ` · ${h.path}` : ''}\n${h.content}`)
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
  const { workspacePath, session } = await deps.resolveContext(exec)
  // 明确要"只看本项目"而当前会话没有工作目录：显式说明而非静默落回 global-only——
  // 用户要项目范围时给他全局结果是误导
  if (a.scope === 'workspace' && workspacePath === undefined) {
    return { hits: [], noteCode: 'no-workspace', note: '当前会话没有工作目录，无法限定项目范围；查全局记忆请用 scope: "global"。' }
  }
  const limit = Math.min(a.limit ?? DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT)
  const scopeFilter: QueryScope = a.scope === 'global'
    ? { kind: 'global' }
    : a.scope === 'workspace' && workspacePath
      ? { kind: 'workspace', path: workspacePath }
      : { kind: 'visible', workspacePath }
  const hint = scopeFilter.kind === 'workspace' ? scopeFilter.path : scopeFilter.kind === 'visible' ? scopeFilter.workspacePath : undefined
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
  const now = Date.now()
  // 与快照预读同一条路：按范围读取 → 同 id 取舍 → active → validTo（过期的不进检索，治理扫描仍可见）
  const read = await deps.store.readLayer(scopeFilter, { ...(a.types ? { types: a.types } : {}), ...prefilter })
  const located = resolveLiveFirst(read.records, { workspacePath: hint })
    .filter(l => l.record.status === 'active' && withinValidity(l.record, now))
  const candidates = located.map(l => l.record)
  // 取舍后同 id 只留一份，命中按 id 取回它的文件绝对路径
  const filePathOf = new Map(located.map(l => [l.record.id, l.filePath]))

  let ranked: RankedRecord[]
  if (tokens.length === 0 && legacyTerms.length === 0) {
    // 零 token 查询：不做关键词过滤，范围内全部按 confidence、lastConfirmedAt 排
    ranked = candidates.map(record => ({ record, tier: 'all' as const, anchorHits: 0, score: 0 }))
  } else {
    ranked = rankRecords({ tokens, legacyTerms, anchors: anchorTerms(a.query), records: candidates, listedCount: read.listedCount, tokenize })
  }
  ranked.sort(compareRanked)
  // id 直达：查询恰等于某条可见记忆的 id，该条排第一
  const directId = a.query.trim()
  const direct = ranked.findIndex(e => e.record.id === directId)
  if (direct > 0) ranked.unshift(...ranked.splice(direct, 1))
  const top = ranked.slice(0, limit)
  const topIds = top.map(e => e.record.id)
  const { sessionRecall } = deps
  const handle = session.handle
  // 拿得到会话时同一会话每条只计一次召回，拿不到时每次都计
  if (sessionRecall && handle) await sessionRecall.markRecalled(handle, topIds)
  else await deps.store.markRecalled(topIds)
  // 快照带入时的正文与现在一致才省略：冻结后改过的、同 id 取到别层副本的，开头那份不是这一版
  const injected = sessionRecall && handle ? sessionRecall.injectedCore(handle) : undefined

  // 说明码只看返回列表：没有全命中 → or-fallback；连部分命中也没有、只剩第三档 → substring-fallback（互斥、substring 优先）
  const hasTier = (tier: SearchTier) => top.some(e => e.tier === tier)
  const note = top.length === 0 || hasTier('all') ? undefined
    : hasTier('partial') ? { noteCode: 'or-fallback' as const, note: OR_FALLBACK_NOTE }
      : { noteCode: 'substring-fallback' as const, note: SUBSTRING_FALLBACK_NOTE }
  return {
    ...note,
    ...(ranked.length > top.length ? { moreNote: truncationNote(ranked.length, top.length, limit === MAX_SEARCH_LIMIT) } : {}),
    // 与注入同口径：只遮明确密钥（疑似级写入时用户已确认）；文件路径同注入，name 被遮的不给，其余遮一遍
    hits: top.map(({ record: h }) => {
      const masked = maskSecretSurface(h)
      const path = exposedPath(h, filePathOf.get(h.id)!)
      return {
        id: h.id, type: h.type, summary: masked.summary,
        content: injected?.get(h.id) === h.content ? IN_SNAPSHOT_NOTE : masked.content,
        sourceNote: sourceNote(h),
        stalenessNote: stalenessNote(h, deps.registry.get(h.type).decayDays, now),
        ...(path !== undefined ? { path } : {}),
      }
    }),
  }
}
