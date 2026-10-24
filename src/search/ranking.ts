import type { MemoryRecord } from '../record-schema.ts'
import { matchScore } from '../text.ts'

/**
 * 检索排序：查询时现算、不留状态。给定查询 token、候选记录与范围内列出的文件数 N，
 * 给每条候选定档位与分数；调用方（memory_search 执行器）负责排序、截断与说明码。
 */

/** 参与 BM25 的字段，按加权顺序。id 不在其中：id 直达与子串档（matchScore）另行覆盖。 */
export const RANKING_FIELDS = ['name', 'summary', 'tags', 'content'] as const
export type RankingField = (typeof RANKING_FIELDS)[number]

/**
 * BM25 参数与字段权重。全部是初值（按常识取，评估集上调参后会改），改这里即可、别处不散落数字。
 * - k1：词频饱和速度；b：文档长度归一的强度。
 * - weight：字段权重。name 最高、summary 与 tags 次之、content 最低；保守取值，让 summary + content 都命中
 *   的记录能胜过只在 name 碰巧含一个词的记录。
 * - avgLength：字段平均长度（UTF-16 单元数）。用常量而不从语料算：被预筛跳过的文件不解析、拿不到分字段长度，
 *   从语料算会让「开不开预筛」改变排序。
 */
export const RANKING_PARAMS = {
  k1: 1.2,
  b: 0.75,
  fields: {
    name: { weight: 3, avgLength: 12 },
    summary: { weight: 2, avgLength: 40 },
    tags: { weight: 2, avgLength: 16 },
    content: { weight: 1, avgLength: 300 },
  },
} as const satisfies { k1: number; b: number; fields: Record<RankingField, { weight: number; avgLength: number }> }

/** 三档：全部查询 token 命中 → 部分命中 → token 零命中但旧子串匹配命中。 */
export type SearchTier = 'all' | 'partial' | 'substring'
/** 档位的排序序号，小的在前。 */
export const TIER_ORDER: Record<SearchTier, number> = { all: 0, partial: 1, substring: 2 }

export interface RankedRecord {
  record: MemoryRecord
  tier: SearchTier
  /** all / partial 档是 BM25 加权分；substring 档是旧词项的命中词数。只在同档内可比。 */
  score: number
}

export interface RankInput {
  /** 查询 token（已去重、已剔除噪声 token）。 */
  tokens: readonly string[]
  /** 旧词项（expandQueryTerms），只用于子串档。 */
  legacyTerms: readonly string[]
  /** 解析后的候选（已过 scope / 状态 / types / validTo）。 */
  records: readonly MemoryRecord[]
  /** 范围内顶层列出的记忆文件数（ScopeReadResult.listedCount），作 BM25 的 N。 */
  listedCount: number
  /** 查询与记录两侧共用的分词器。 */
  tokenize: (text: string) => string[]
}

/** 每条候选只保留「各字段里查询 token 的词频 + 各字段长度」；分词结果用完即弃，不建倒排。 */
interface DocStats {
  record: MemoryRecord
  /** tf[fieldIdx][tokenIdx] */
  tf: number[][]
  /** 各字段长度（UTF-16 单元数） */
  len: number[]
  /** 命中的查询 token 数（任一字段含该 token 即计 1） */
  hitCount: number
}

function fieldText(record: MemoryRecord, field: RankingField): string {
  return field === 'tags' ? record.tags.join(' ') : record[field]
}

function collectStats(record: MemoryRecord, tokenIndex: ReadonlyMap<string, number>, tokenize: (text: string) => string[]): DocStats {
  const tf = RANKING_FIELDS.map(() => new Array<number>(tokenIndex.size).fill(0))
  const len: number[] = []
  const hit = new Array<boolean>(tokenIndex.size).fill(false)
  RANKING_FIELDS.forEach((field, f) => {
    const text = fieldText(record, field)
    len.push(text.length)
    for (const tok of tokenize(text)) {
      const i = tokenIndex.get(tok)
      if (i === undefined) continue
      tf[f]![i]!++
      hit[i] = true
    }
  })
  return { record, tf, len, hitCount: hit.filter(Boolean).length }
}

/** 恒正 idf：小语料下常见词不会取负、不会把命中它的记录往下压。 */
function idf(N: number, df: number): number {
  return Math.log(1 + (N - df + 0.5) / (df + 0.5))
}

function bm25(doc: DocStats, idfs: readonly number[]): number {
  const { k1, b, fields } = RANKING_PARAMS
  let total = 0
  RANKING_FIELDS.forEach((field, f) => {
    const { weight, avgLength } = fields[field]
    const norm = k1 * (1 - b + b * (doc.len[f]! / avgLength))
    let fieldScore = 0
    doc.tf[f]!.forEach((tf, i) => {
      if (tf > 0) fieldScore += idfs[i]! * (tf * (k1 + 1)) / (tf + norm)
    })
    total += weight * fieldScore
  })
  return total
}

/**
 * 给每条候选定档位与分数；不在任何档的候选不返回。顺序与输入一致，不排序。
 * df 按文档粒度在候选集上数：token 是记录原文的子串，被预筛跳过的文件对 df 贡献为零，候选集上数就是精确值。
 */
export function rankRecords({ tokens, legacyTerms, records, listedCount, tokenize }: RankInput): RankedRecord[] {
  const tokenIndex = new Map(tokens.map((t, i) => [t, i] as const))
  const docs = records.map(r => collectStats(r, tokenIndex, tokenize))
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
      out.push({ record: doc.record, tier: doc.hitCount === tokens.length ? 'all' : 'partial', score: bm25(doc, idfs) })
      continue
    }
    const legacy = legacyTerms.length > 0 ? matchScore(doc.record, legacyTerms as string[]) : 0
    if (legacy > 0) out.push({ record: doc.record, tier: 'substring', score: legacy })
  }
  return out
}
