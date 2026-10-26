import { CJK } from './tokenizer.ts'

/**
 * 「命中弱」的判断：没有记录同时命中全部查询 token 时，看排第一的那条对上了查询的多少。
 * 查询先按空白和文字种类切成词（汉字等 CJK 连续段一个词，其他文字每个空白分隔的词一个词），
 * 再把中英双写的同一个术语配成一对；逐词命中条数也按这套分组数。纯函数，不碰存储与分词器状态。
 */

/**
 * 首条覆盖的查询文字低于这个比例算弱。取值由评估集（tests/fixtures/search-eval.ts）定：
 * 两档分词下首条正确的长句查询最低约 0.46（二字切分）与 0.60（jieba），换说法查询的首条大多在 0.4 以下。
 * 改之前先跑 scripts/eval-search.ts 看「命中弱」一节。
 */
export const WEAK_COVERAGE_BELOW = 0.4

/** 2 到这个字数的 CJK 词按关键词看（术语多在四字以内）；更长的按句子看，只计入覆盖度。 */
export const KEYWORD_MAX_CJK_CHARS = 4

export interface QueryTerm {
  /** 查询原文里的这个词；成对时连写的几个非 CJK 词用空格连起来。 */
  text: string
  isCjk: boolean
  /** 这个词切出的查询 token 在 tokens 里的下标，去重。 */
  tokens: number[]
}

export interface TermGroup {
  /** 一个词；或中英双写的一对（CJK 词在前，相邻的连写非 CJK 词在后）。 */
  terms: QueryTerm[]
  /** 关键词组：成对的、非 CJK 词、2 到 KEYWORD_MAX_CJK_CHARS 字的 CJK 词。整组没在首条出现就判弱；其余只计入覆盖度。 */
  keyword: boolean
}

const SCRIPT_RUN = new RegExp(`[${CJK}]+|[^${CJK}]+`, 'gu')
const IS_CJK = new RegExp(`[${CJK}]`, 'u')

const isKeywordCjk = (t: QueryTerm) => t.isCjk && [...t.text].length >= 2 && [...t.text].length <= KEYWORD_MAX_CJK_CHARS
/**
 * 能和中文词成对的英文词：全小写（deploy、memory leak）或全大写缩写（CI、API）。首字母大写或大小写混写的
 * 多是产品名、库名、标识符（Redis、GraphQL、readScope），没有对应的中文写法，「Redis 缓存」是两个关键词，不是一对。
 */
const isPairableLatin = (t: QueryTerm) => !t.isCjk && (t.text === t.text.toLowerCase() || t.text === t.text.toUpperCase())

/**
 * 查询切词与中英成对。tokens 是执行器清洗后的查询 token（去重、剔除噪声），tokenize 是查询与记录共用的分词器。
 * 成对：关键词长度的 CJK 词先找紧挨在它前面、还没配对的连写英文词（见 isPairableLatin），没有再找紧挨在后面的。
 * 不产生 token 的词（纯数字、标点）先剔掉，不阻断两侧成对。
 */
export function groupQueryTerms(query: string, tokens: readonly string[], tokenize: (text: string) => string[]): TermGroup[] {
  const index = new Map(tokens.map((t, i) => [t, i] as const))
  const terms: QueryTerm[] = []
  for (const word of query.split(/\s+/)) {
    for (const [part] of word.matchAll(SCRIPT_RUN)) {
      const toks = [...new Set(tokenize(part).map(t => index.get(t)).filter((i): i is number => i !== undefined))]
      if (toks.length > 0) terms.push({ text: part, isCjk: IS_CJK.test(part), tokens: toks })
    }
  }
  const used = new Array<boolean>(terms.length).fill(false)
  const latinRun = (from: number, step: 1 | -1): number[] => {
    const run: number[] = []
    for (let j = from; j >= 0 && j < terms.length && isPairableLatin(terms[j]!) && !used[j]; j += step) run.push(j)
    return step === 1 ? run : run.reverse()
  }
  const pairOf = new Map<number, number[]>()
  terms.forEach((t, i) => {
    if (!isKeywordCjk(t) || used[i]) return
    const run = latinRun(i - 1, -1).length > 0 ? latinRun(i - 1, -1) : latinRun(i + 1, 1)
    if (run.length === 0) return
    used[i] = true
    for (const j of run) used[j] = true
    pairOf.set(i, run)
  })
  const inRun = new Set([...pairOf.values()].flat())
  const groups: TermGroup[] = []
  terms.forEach((t, i) => {
    const run = pairOf.get(i)
    if (run !== undefined) {
      const latin = run.map(j => terms[j]!)
      groups.push({
        terms: [t, { text: latin.map(l => l.text).join(' '), isCjk: false, tokens: [...new Set(latin.flatMap(l => l.tokens))] }],
        keyword: true,
      })
    } else if (!inRun.has(i)) {
      groups.push({ terms: [t], keyword: !t.isCjk || isKeywordCjk(t) })
    }
  })
  return groups
}

/** 一个词在某条记录里对上了多少：CJK 词逐字算（被命中 token 盖住的字），其他词按 token 算。 */
function termCover(term: QueryTerm, tokens: readonly string[], hits: readonly boolean[]): { covered: number; total: number } {
  if (!term.isCjk) return { covered: term.tokens.filter(i => hits[i]).length, total: term.tokens.length }
  const chars = [...term.text]
  const covered = new Array<boolean>(chars.length).fill(false)
  for (const i of term.tokens) {
    if (!hits[i]) continue
    const tok = [...tokens[i]!]
    for (let s = 0; s + tok.length <= chars.length; s++) {
      if (tok.every((c, k) => chars[s + k] === c)) for (let k = 0; k < tok.length; k++) covered[s + k] = true
    }
  }
  return { covered: covered.filter(Boolean).length, total: chars.length }
}

const isFull = (c: { covered: number; total: number }) => c.covered === c.total

/** 一组里取对上比例高的那个写法（成对时另一种写法没出现不扣分）。 */
function bestCover(group: TermGroup, tokens: readonly string[], hits: readonly boolean[]): { covered: number; total: number } {
  return group.terms.map(t => termCover(t, tokens, hits))
    .reduce((a, b) => (b.covered * a.total > a.covered * b.total ? b : a))
}

export interface CoverageVerdict {
  /** 首条覆盖的查询文字比例：各组取对上比例高的写法，CJK 逐字、其他按 token 合计。 */
  coverage: number
  /** 首条里一个写法都没完整出现的关键词组。 */
  missingKeywords: TermGroup[]
  /** 有关键词组缺失，或覆盖度低于 WEAK_COVERAGE_BELOW。 */
  weak: boolean
}

/** 判首条：hits 是这条记录对各查询 token 的命中（下标同 tokens）。 */
export function judgeTopHit(groups: readonly TermGroup[], tokens: readonly string[], hits: readonly boolean[]): CoverageVerdict {
  let covered = 0
  let total = 0
  const missingKeywords: TermGroup[] = []
  for (const g of groups) {
    const best = bestCover(g, tokens, hits)
    covered += best.covered
    total += best.total
    if (g.keyword && !g.terms.some(t => isFull(termCover(t, tokens, hits)))) missingKeywords.push(g)
  }
  const coverage = total === 0 ? 0 : covered / total
  return { coverage, missingKeywords, weak: missingKeywords.length > 0 || coverage < WEAK_COVERAGE_BELOW }
}

export interface TermHitCount {
  label: string
  count: number
}

/**
 * 逐词命中条数，按查询里的顺序：关键词组按组数（任一写法完整出现即算，成对的显示成「中文/英文」）；
 * 句子段按它切出的 token 数（单个 CJK 字略过）。rows 是范围内各条记录对查询 token 的命中。
 */
export function termHitCounts(groups: readonly TermGroup[], tokens: readonly string[], rows: readonly (readonly boolean[])[]): TermHitCount[] {
  const out: TermHitCount[] = []
  for (const g of groups) {
    if (g.keyword) {
      out.push({
        label: g.terms.map(t => t.text).join('/'),
        count: rows.filter(hits => g.terms.some(t => isFull(termCover(t, tokens, hits)))).length,
      })
      continue
    }
    for (const i of g.terms[0]!.tokens) {
      if ([...tokens[i]!].length === 1) continue
      out.push({ label: tokens[i]!, count: rows.filter(hits => hits[i]).length })
    }
  }
  return out
}
