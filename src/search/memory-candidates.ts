import type { MemoryRecord } from '../record-schema.ts'
import type { MemoryStore, QueryScope } from '../store.ts'
import { expandQueryTerms } from '../text.ts'
import { resolveLiveFirst, type LocatedRecord } from '../storage/table.ts'
import { withinValidity } from '../record-freshness.ts'
import { tokenizerForQuery, type QueryTokenizerOptions } from './jieba-segmenter.ts'
import { CJK } from './tokenizer.ts'
import { anchorTerms, compareRanked, pendingLast, rankRecords, type RankedRecord, type SearchTier } from './ranking.ts'
import { groupQueryTerms, termHitCounts, type TermGroup, type TermHitCount } from './coverage.ts'

/**
 * 记忆检索的取候选：范围读取、同 id 取舍、有效期过滤、分档打分、排序、id 直达置顶。
 * 只读，不记召回、不看会话快照、不遮盖、不截断；这些都在调用方拿到候选之后做。
 * 一次调用只读一次盘（填了类型而候选为空时为分辨原因再读一次），调用方全程用这一份，不再按 id 重读。
 */

/** 一条候选。record 是读盘原样，名称、摘要、正文都还没遮盖密钥，输出前由调用方遮。 */
export interface MemoryCandidate {
  record: MemoryRecord
  /** 记忆文件的绝对路径。文件名来自记忆名称，同样可能带密钥，输出前由调用方处理。 */
  filePath: string
  tier: SearchTier
  /** 与 diagnostics.tokens 逐项对应：这条记录有没有命中该 token。节选位置、逐条命中说明、逐词命中条数都从它算。 */
  tokenHits: readonly boolean[]
}

/** 说明要用的查询侧信息，和候选出自同一次分词、同一次读盘。只描述记忆这一路的切词。 */
export interface MemorySearchDiagnostics {
  /** 参与打分的查询 token（去重、去掉单字母和纯数字）。 */
  tokens: readonly string[]
  /** 旧的子串词项：只给第三档用，兜住 id 这类不打分字段的子串命中。 */
  legacyTerms: readonly string[]
  /** 查询分组：判弱、逐词命中条数、逐条命中说明共用。 */
  groups: readonly TermGroup[]
  /** 逐词命中条数，按全部候选算（不受调用方截断、过滤影响）。 */
  termHits: readonly TermHitCount[]
  /**
   * 填了类型而候选为空、并且这几类在范围内确实没有有效记忆时才有：范围内不限类型能查到的有效记忆按类型的条数。
   * 这几类有记忆（只是关键词没对上）时为 undefined。
   */
  missingTypeCounts?: ReadonlyArray<{ type: string; count: number }>
}

export interface MemoryCandidateSet {
  /** 排好序的全部候选，名次就是下标；没有按条数截断。 */
  candidates: readonly MemoryCandidate[]
  /** 查询恰等于某条可见记忆的 id：那一条在下标 0。 */
  isDirectHit: boolean
  /** 这次检索判有效期用的时刻：分词完成后、读盘前取的。调用方算陈旧提示、记召回都用它，不另取一次。 */
  at: number
  diagnostics: MemorySearchDiagnostics
}

export interface MemoryCandidateQuery {
  query: string
  /** 空数组当没填：模型传 [] 表达的是不筛，按字面过滤会把全部记忆滤掉。 */
  types?: readonly string[]
  scope: QueryScope
}

export interface MemoryCandidateDeps {
  /** 只用到读取。 */
  store: Pick<MemoryStore, 'readRaw'>
  /** 分词器选项：用户词典路径（现读）与降级告警的日志器。 */
  tokenizer?: QueryTokenizerOptions
  /** 时钟，缺省取当前时间。 */
  now?: () => number
}

const CJK_CHAR = new RegExp(`[${CJK}]`, 'u')

/** 单个字母、纯数字几乎在每个文件里出现：既不作为打分 token，也不能进 any 模式预筛。单个 CJK 字是实词，保留。 */
function isNoiseTerm(term: string): boolean {
  return /^\p{N}+$/u.test(term) || ([...term].length === 1 && !CJK_CHAR.test(term))
}

/**
 * 填的类型在范围内有没有有效记忆：按同一范围再读一次原始记录（不带预筛、不带类型过滤），分两路算。
 * 存在性按搜索路径同序——先按请求类型过滤再取舍、过滤：同 id 跨作用域两份类型不同时，搜旧类型能搜到旧的那份，
 * 先取舍再看类型会把它漏掉。条数另算——不按类型过滤、直接取舍过滤后按类型计数，是「不限类型时能查到的有效记忆」视图，
 * 同 id 两份只计一份。类型存在时返回 undefined。
 */
async function missingTypeCounts(
  types: readonly string[],
  scope: QueryScope,
  liveOf: (records: readonly LocatedRecord[]) => LocatedRecord[],
  store: MemoryCandidateDeps['store'],
): Promise<Array<{ type: string; count: number }> | undefined> {
  const read = await store.readRaw(scope)
  if (liveOf(read.records.filter(l => types.includes(l.record.type))).length > 0) return undefined
  const counts = new Map<string, number>()
  for (const l of liveOf(read.records)) counts.set(l.record.type, (counts.get(l.record.type) ?? 0) + 1)
  return [...counts].map(([type, count]) => ({ type, count }))
}

export async function findMemoryCandidates(q: MemoryCandidateQuery, deps: MemoryCandidateDeps): Promise<MemoryCandidateSet> {
  const hint = q.scope.kind === 'global' ? undefined : q.scope.workspacePath
  // 查询与记录两侧共用这一个分词器：查询含汉字时是 jieba 档（首次搜索才加载），否则 bigram
  const tokenize = await tokenizerForQuery(q.query, deps.tokenizer)
  // 两套词项：新 token 定前两档并打分（分词命中计词频，字段子串命中只计命中）；旧词项（expandQueryTerms）给第三档，
  // 兜住 id 这类不打分字段的子串命中，保证今天靠子串能命中的查询仍命中
  const tokens = [...new Set(tokenize(q.query))].filter(t => !isNoiseTerm(t))
  const legacyTerms = expandQueryTerms(q.query)
  // 预筛词 = token ∪ 旧词项，any 模式；两侧同一分词器，记录侧 token 必是原文连续子串，字段子串命中按定义也是，所以预筛是超集。
  // 并集里出现噪声词项（单字母、纯数字）时不预筛：剔掉它会漏掉只靠它命中的记录，留着它预筛也几乎不跳过任何文件。
  const unionTerms = [...new Set([...tokens, ...legacyTerms])]
  const prefilter = unionTerms.length > 0 && !unionTerms.some(isNoiseTerm)
    ? { prefilterTerms: unionTerms, prefilterMatch: 'any' as const }
    : {}
  // 分词可能要等词典加载，时刻在它之后取：加载期间到期的记忆不进候选
  const now = deps.now?.() ?? Date.now()
  // 与快照预读同一条路：按范围读取 → 同 id 取舍 → active → validTo（过期的不进检索，治理扫描仍可见）
  const hasTypes = q.types !== undefined && q.types.length > 0
  const typeFilter = hasTypes ? { types: [...q.types!] } : {}
  const read = await deps.store.readRaw(q.scope, { ...typeFilter, ...prefilter })
  const liveOf = (records: readonly LocatedRecord[]) => resolveLiveFirst(records, { workspacePath: hint })
    .filter(l => l.record.status === 'active' && withinValidity(l.record, now))
  const located = liveOf(read.records)
  const records = located.map(l => l.record)
  // 类型缺失：填了 types 而候选为空，才按同一范围再读一次（不带预筛、不带类型过滤）分辨是这几类没有、还是关键词没对上。
  // 首次候选非空就证明这几类有记忆，二次读不推翻它：预筛改变参与取舍的副本，二次读可能选中另一份已过期的副本。
  const typeCounts = hasTypes && records.length === 0
    ? await missingTypeCounts(q.types!, q.scope, liveOf, deps.store)
    : undefined
  // 取舍后同 id 只留一份，命中按 id 取回它的文件绝对路径
  const filePathOf = new Map(located.map(l => [l.record.id, l.filePath]))

  let ranked: RankedRecord[]
  if (tokens.length === 0 && legacyTerms.length === 0) {
    // 零 token 查询：不做关键词过滤，范围内全部按 confidence、lastConfirmedAt 排
    ranked = records.map(record => ({ record, tier: 'all' as const, coverage: 0, anchorHits: 0, score: 0, tokenHits: [] }))
  } else {
    ranked = rankRecords({ tokens, legacyTerms, anchors: anchorTerms(q.query), records, listedCount: read.listedCount, tokenize })
  }
  // 主档在前、待确认在后（深度浅的在前）：主档命中不足时待确认才露出
  ranked = pendingLast(ranked.sort(compareRanked))
  // id 直达：查询恰等于某条可见记忆的 id，该条排第一
  const directId = q.query.trim()
  const direct = ranked.findIndex(e => e.record.id === directId)
  if (direct > 0) ranked.unshift(...ranked.splice(direct, 1))

  const groups = groupQueryTerms(q.query, tokens, tokenize)
  return {
    candidates: ranked.map(e => ({ record: e.record, filePath: filePathOf.get(e.record.id)!, tier: e.tier, tokenHits: e.tokenHits })),
    isDirectHit: direct >= 0,
    at: now,
    diagnostics: {
      tokens,
      legacyTerms,
      groups,
      termHits: termHitCounts(groups, tokens, ranked.map(e => e.tokenHits)),
      ...(typeCounts !== undefined ? { missingTypeCounts: typeCounts } : {}),
    },
  }
}
