import type { MemoryRecord } from '../record-schema.ts'
import { matchScore } from '../text.ts'

/**
 * 检索排序：查询时现算、不留状态。给定查询 token、候选记录与范围内列出的文件数 N，
 * 给每条候选定档位、字面锚点命中数与分数；调用方（memory_search 执行器）按 compareRanked 排序，再截断、出说明码。
 */

/** 参与打分的字段，按加权顺序。id 不在其中：id 直达与第三档（旧子串匹配 matchScore）另行覆盖。 */
export const RANKING_FIELDS = ['name', 'summary', 'tags', 'content'] as const
export type RankingField = (typeof RANKING_FIELDS)[number]

/**
 * BM25F 参数与字段权重，取值由评估集（tests/fixtures/search-eval.ts）定，改这里即可、别处不散落数字；
 * 调之前先跑 scripts/eval-search.ts 看两档指标。
 * - k1：词频饱和速度；b：字段长度归一的强度。两者取 BM25 的通用值，评估集上没有调。
 * - weight：字段权重，即「在这个字段出现一次，相当于在长度平均的正文里出现几次」。name 最高、summary 与 tags
 *   次之、content 最低。BM25F 下各字段共用一个饱和上限，评估集上 name 取 1 到 4、summary 与 tags 取 1 到 2
 *   的各种组合指标几乎不变，保留这组按字段信息密度给的值。
 * - avgLength：字段平均长度（UTF-16 单元数），取评估语料的实测均值取整。用常量而不从运行时语料算：
 *   被预筛跳过的文件不解析、拿不到分字段长度，从语料算会让「开不开预筛」改变排序。
 */
export const RANKING_PARAMS = {
  k1: 1.2,
  b: 0.75,
  fields: {
    name: { weight: 3, avgLength: 7 },
    summary: { weight: 2, avgLength: 22 },
    tags: { weight: 2, avgLength: 11 },
    content: { weight: 1, avgLength: 147 },
  },
} as const satisfies RankingParams

export interface RankingParams {
  k1: number
  b: number
  fields: Record<RankingField, { weight: number; avgLength: number }>
}

/**
 * 三档：全部查询 token 命中 → 部分命中 → 一个都没命中但旧子串匹配（matchScore）命中。
 * 「token 命中」= 某字段分词后含该 token，或某字段的小写原文以子串含该 token（如 deploy 之于 deployment；
 * 自身是别的查询 token 子串的子词除外，见 substringEligible）。
 * 第三档于是只剩 id 这类不打分字段的命中，以及全是噪声词项（单字母、纯数字）的查询。
 */
export type SearchTier = 'all' | 'partial' | 'substring'
/** 档位的排序序号，小的在前。 */
export const TIER_ORDER: Record<SearchTier, number> = { all: 0, partial: 1, substring: 2 }

export interface RankedRecord {
  record: MemoryRecord
  tier: SearchTier
  /** 字面命中的锚点词数（见 anchorTerms），同档内先比它、再比分数。 */
  anchorHits: number
  /** all / partial 档是 BM25F 分数（只以子串命中的 token 不贡献词频）；substring 档是旧词项的命中词数。只在同档内可比。 */
  score: number
  /** 各查询 token 是否命中（下标同 RankInput.tokens，命中口径同档位）；substring 档全为 false。判「命中弱」与逐词命中条数用。 */
  tokenHits: boolean[]
}

export interface RankInput {
  /** 查询 token（已去重、已剔除噪声 token）。 */
  tokens: readonly string[]
  /** 旧词项（expandQueryTerms），只用于第三档。 */
  legacyTerms: readonly string[]
  /** 锚点词（anchorTerms），缺省没有。 */
  anchors?: readonly string[]
  /** 解析后的候选（已过 scope / 状态 / types / validTo）。 */
  records: readonly MemoryRecord[]
  /** 范围内顶层列出的记忆文件数（ScopeReadResult.listedCount），作 BM25 的 N。 */
  listedCount: number
  /** 查询与记录两侧共用的分词器。 */
  tokenize: (text: string) => string[]
  /** 缺省 RANKING_PARAMS；评估脚本扫参时传入候选值。 */
  params?: RankingParams
}

/** 每条候选只保留「各字段里查询 token 的词频 + 各字段长度」；分词结果用完即弃，不建倒排。 */
interface DocStats {
  record: MemoryRecord
  /** tf[fieldIdx][tokenIdx] */
  tf: number[][]
  /** 各字段长度（UTF-16 单元数） */
  len: number[]
  /** 各查询 token 是否命中：任一字段分词含该 token，或任一字段小写原文以子串含它 */
  hit: boolean[]
  /** 命中的查询 token 数 */
  hitCount: number
}

function fieldText(record: MemoryRecord, field: RankingField): string {
  return field === 'tags' ? record.tags.join(' ') : record[field]
}

/**
 * 哪些查询 token 可以靠字段子串算命中：自身是另一个查询 token 子串的不行。分词器会把 mem_x8v4 拆出子词 mem，
 * 它只是整词的一部分，若也按子串命中，含 memory 的记录全都会算部分命中，把真正按 id 命中的目标挤出结果。
 */
export function substringEligible(tokens: readonly string[]): boolean[] {
  return tokens.map(tok => !tokens.some(other => other !== tok && other.includes(tok)))
}

function collectStats(
  record: MemoryRecord,
  tokenIndex: ReadonlyMap<string, number>,
  eligible: readonly boolean[],
  tokenize: (text: string) => string[],
): DocStats {
  const tf = RANKING_FIELDS.map(() => new Array<number>(tokenIndex.size).fill(0))
  const len: number[] = []
  const hit = new Array<boolean>(tokenIndex.size).fill(false)
  const texts = RANKING_FIELDS.map(field => fieldText(record, field))
  texts.forEach((text, f) => {
    len.push(text.length)
    for (const tok of tokenize(text)) {
      const i = tokenIndex.get(tok)
      if (i === undefined) continue
      tf[f]![i]!++
      hit[i] = true
    }
  })
  // 词频为零的 token 再查子串：只计命中、不计词频，所以同档内排在有词频的记录之后。小写原文按需算、每字段一次
  let lower: string[] | undefined
  for (const [tok, i] of tokenIndex) {
    if (hit[i] || !eligible[i]) continue
    lower ??= texts.map(t => t.toLowerCase())
    hit[i] = lower.some(t => t.includes(tok))
  }
  return { record, tf, len, hit, hitCount: hit.filter(Boolean).length }
}

// 与分词器的整词同一个字符集：字母、组合附加符、数字、_、-。整词里出现这之外的字符（. / : 等），分词就会把它打散
const WORD_CHARS_ONLY = /^[\p{L}\p{M}\p{N}_-]*$/u
const HAS_ALNUM = /[\p{L}\p{N}]/u
// 整词首尾的句读、括号、引号是行文带进来的，不属于字面值：「怎么办？」「（0.2.1-rc.2）」先剥掉再判断
const EDGE_PUNCT = /^[(（\[【「『"'“‘]+|[)）\]】」』"'”’.,;:!?。，、；：！？…]+$/gu

/**
 * 锚点词：查询按空白切出的整词（剥掉首尾句读和括号）里，含标点（上面字符集以外的字符）且带字母或数字的那些，小写、去重。
 * 版本号 0.2.1-rc.2、路径 .archive/、node:sqlite 这类字面值分词后只剩 1-rc、rc 之类的碎片，
 * 只差一个版本号的几条记录同分；按整词字面比较才分得出。不含标点的整词不算：它们的分词结果已经代表字面，
 * 再按字面排会让恰好含这串字的记录压过分数更高的记录。
 */
export function anchorTerms(query: string): string[] {
  const words = query.toLowerCase().split(/\s+/).map(w => w.replace(EDGE_PUNCT, '')).filter(w => w !== '' && !WORD_CHARS_ONLY.test(w) && HAS_ALNUM.test(w))
  return [...new Set(words)]
}

/** 记录字面含几个锚点词：id、name、summary、tags、content 的小写原文，子串即算。 */
export function countAnchorHits(record: MemoryRecord, anchors: readonly string[]): number {
  if (anchors.length === 0) return 0
  const haystack = [record.id, record.name, record.summary, record.tags.join(' '), record.content].join('\n').toLowerCase()
  return anchors.filter(a => haystack.includes(a)).length
}

/** 恒正 idf：小语料下常见词不会取负、不会把命中它的记录往下压。 */
function idf(N: number, df: number): number {
  return Math.log(1 + (N - df + 0.5) / (df + 0.5))
}

/**
 * BM25F：每个字段的词频先按该字段长度归一、乘字段权重，跨字段相加成一个合并词频，再统一做一次饱和。
 * 长度平均的 name 里出现一次，相当于长度平均的正文里出现 weight 次；各字段的贡献共用一个饱和上限，
 * 所以 name 碰巧含一个词的记录压不住正文大段命中的记录。
 */
function bm25f(doc: DocStats, idfs: readonly number[], { k1, b, fields }: RankingParams): number {
  const norms = RANKING_FIELDS.map((field, f) => 1 - b + b * (doc.len[f]! / fields[field].avgLength))
  let total = 0
  idfs.forEach((idf, i) => {
    let tf = 0
    RANKING_FIELDS.forEach((field, f) => { tf += fields[field].weight * doc.tf[f]![i]! / norms[f]! })
    if (tf > 0) total += idf * (tf * (k1 + 1)) / (tf + k1)
  })
  return total
}

/**
 * 给每条候选定档位与分数；不在任何档的候选不返回。顺序与输入一致，不排序。
 * df 按文档粒度在候选集上数：token 是记录原文的子串，被预筛跳过的文件对 df 贡献为零，候选集上数就是精确值。
 * df 只数有词频的文档：只以子串命中的 token 分数为 0，不参与 idf。
 */
export function rankRecords({ tokens, legacyTerms, anchors = [], records, listedCount, tokenize, params = RANKING_PARAMS }: RankInput): RankedRecord[] {
  const tokenIndex = new Map(tokens.map((t, i) => [t, i] as const))
  const eligible = substringEligible(tokens)
  const docs = records.map(r => collectStats(r, tokenIndex, eligible, tokenize))
  // df 按文档粒度：某 token 在该文档任一字段出现即计 1
  const df = new Array<number>(tokens.length).fill(0)
  for (const doc of docs) {
    for (let i = 0; i < tokens.length; i++) if (doc.tf.some(row => row[i]! > 0)) df[i]!++
  }
  const N = Math.max(listedCount, records.length)
  const idfs = df.map(d => idf(N, d))
  const out: RankedRecord[] = []
  for (const doc of docs) {
    if (tokens.length > 0 && doc.hitCount > 0) {
      out.push({
        record: doc.record, tier: doc.hitCount === tokens.length ? 'all' : 'partial',
        anchorHits: countAnchorHits(doc.record, anchors), score: bm25f(doc, idfs, params), tokenHits: doc.hit,
      })
      continue
    }
    const legacy = legacyTerms.length > 0 ? matchScore(doc.record, legacyTerms as string[]) : 0
    if (legacy > 0) out.push({ record: doc.record, tier: 'substring', anchorHits: countAnchorHits(doc.record, anchors), score: legacy, tokenHits: doc.hit })
  }
  return out
}

/** 档 → 字面锚点命中数 → 分数 → confidence → lastConfirmedAt；档位升序，其余降序。 */
export function compareRanked(x: RankedRecord, y: RankedRecord): number {
  return TIER_ORDER[x.tier] - TIER_ORDER[y.tier]
    || y.anchorHits - x.anchorHits
    || y.score - x.score
    || y.record.confidence - x.record.confidence
    || y.record.lastConfirmedAt - x.record.lastConfirmedAt
}
