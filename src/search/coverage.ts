import { CJK } from './tokenizer.ts'

/**
 * 「命中弱」的判断：没有记录同时命中全部查询 token 时，看排第一的那条对上了查询的多少。
 * 查询先按空白切成词，再按文字种类切开：CJK 连续段去掉虚词后剩下的内容段，其他文字的整词。逐词命中条数也按这套分组数。
 * 纯函数，不碰存储与分词器状态。拿不准时偏向判弱：误判弱只多搜一轮，漏判弱会让模型把错的结果当答案。
 */

/**
 * 首条覆盖的查询内容低于这个比例算弱。取值由评估集（tests/fixtures/search-eval.ts）定：库里没有答案的长句，
 * 首条最多盖住约六成内容字（两档分词器都是），取刚好高过它的值；有答案的长句因此会有几条误判弱，只多搜一轮。
 * 依据见 scripts/eval-search.ts「命中弱」一节；改之前先跑它。
 */
export const WEAK_COVERAGE_BELOW = 0.65

/**
 * 去掉虚词后 2 到这个字数的 CJK 词按关键词看（术语多在四字以内）；更长的按句子看，各内容段只计入覆盖度，
 * 紧跟疑问词的那段除外（见 ASKED_AFTER）。
 */
export const KEYWORD_MAX_CJK_CHARS = 4

/**
 * 查询里的虚词（疑问词、语气词、助词）：不算查询内容，不计入覆盖度，也把句子切成内容段——跨过虚词的二字碎片
 * （「怎么热生效」的「么热」）不算覆盖。按最长匹配从左到右剥，所以多字的放前面。单字只收几乎不出现在技术实词里的，
 * 「在」「是」偶尔会拆开「现在」这类词，只少算一两个字，不影响判断。
 */
export const FUNCTION_WORDS = [
  '什么时候', '为什么', '怎么办', '怎么样', '是不是', '要不要', '能不能', '有没有',
  '怎么', '怎样', '什么', '哪个', '哪些', '哪里', '哪儿', '如何', '应该', '需要', '是否', '可以', '一下', '一般', '还是', '多少', '多久',
  '的', '了', '吗', '呢', '吧', '啊', '呀', '么', '在', '是',
] as const

/** 英文虚词（冠词、介词、助动词、疑问词），同中文虚词：不算查询内容，也不计入覆盖度。按小写比较。 */
const ENGLISH_FUNCTION_WORDS: ReadonlySet<string> = new Set([
  'a', 'an', 'the',
  'about', 'after', 'at', 'before', 'between', 'by', 'for', 'from', 'in', 'into', 'of', 'on', 'onto', 'over', 'per', 'to', 'under', 'via', 'with', 'within', 'without',
  'am', 'are', 'be', 'been', 'being', 'can', 'could', 'did', 'do', 'does', 'had', 'has', 'have', 'is', 'may', 'might', 'must', 'shall', 'should', 'was', 'were', 'will', 'would',
  'how', 'what', 'when', 'where', 'which', 'who', 'whom', 'whose', 'why',
])

/**
 * 句子里紧跟着这些疑问词（前面可带「是」）的内容段是问的东西：「数据库连接池的密码是什么」的「密码」、「部署脚本的超时是多少」的「超时」。
 * 首条话题对上却没有它，多半没答到点子上，所以按关键词看。只认紧跟的，句中其余短段（「侧栏里」「算出来」）照旧只计入覆盖度。
 */
const ASKED_AFTER = /^是?(?:什么|多少|多久|哪个|哪些|哪里|哪儿)/

/** 查询里的一个词：一个非 CJK 词，或 CJK 词去掉虚词后的一个内容段。 */
export interface QueryUnit {
  /** 显示用：非 CJK 词去掉首尾标点，CJK 内容段原样。 */
  label: string
  /** CJK 内容段按字算覆盖（盖住了几个字）；其余按 tokens 算（命中了几个 token）。 */
  byChar: boolean
  /** 这个词切出的查询 token 下标；byChar 的不用。 */
  tokens: number[]
}

export interface TermGroup {
  /** 一个词。 */
  units: QueryUnit[]
  /** 关键词组：非 CJK 词、去掉虚词后 2 到 KEYWORD_MAX_CJK_CHARS 字的 CJK 词（句子里只算问的那段）。整组没在首条出现就判弱；其余只计入覆盖度。 */
  keyword: boolean
}

const SCRIPT_RUN = new RegExp(`[${CJK}]+|[^${CJK}]+`, 'gu')
const IS_CJK = new RegExp(`[${CJK}]`, 'u')
const EDGE_PUNCT = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu

/** CJK 段按虚词切成内容段。 */
export function contentSegments(run: string): string[] {
  const chars = [...run]
  const out: string[] = []
  let current = ''
  for (let i = 0; i < chars.length;) {
    const fw = FUNCTION_WORDS.find(w => chars.slice(i, i + [...w].length).join('') === w)
    if (fw !== undefined) {
      if (current !== '') out.push(current)
      current = ''
      i += [...fw].length
    } else {
      current += chars[i]
      i++
    }
  }
  if (current !== '') out.push(current)
  return out
}

/** 一个词在某条记录里对上了多少：CJK 内容段逐字算（整个落在段内、且命中的查询 token 盖住的字），非 CJK 词按 token 算。 */
function unitCover(unit: QueryUnit, tokens: readonly string[], hits: readonly boolean[]): { covered: number; total: number } {
  if (!unit.byChar) return { covered: unit.tokens.filter(i => hits[i]).length, total: unit.tokens.length }
  const chars = [...unit.label]
  const covered = new Array<boolean>(chars.length).fill(false)
  tokens.forEach((token, i) => {
    if (!hits[i]) return
    const tok = [...token]
    for (let s = 0; s + tok.length <= chars.length; s++) {
      if (tok.every((c, k) => chars[s + k] === c)) for (let k = 0; k < tok.length; k++) covered[s + k] = true
    }
  })
  return { covered: covered.filter(Boolean).length, total: chars.length }
}

const isFull = (unit: QueryUnit, tokens: readonly string[], hits: readonly boolean[]) => {
  const c = unitCover(unit, tokens, hits)
  return c.covered === c.total
}

/**
 * 查询切词。tokens 是执行器清洗后的查询 token（去重、剔除噪声），tokenize 是查询与记录共用的分词器。
 * 不产生 token 的词（纯数字、标点）、英文虚词和只有虚词的 CJK 段剔掉。
 */
export function groupQueryTerms(query: string, tokens: readonly string[], tokenize: (text: string) => string[]): TermGroup[] {
  const index = new Map(tokens.map((t, i) => [t, i] as const))
  const tokenIds = (text: string) => [...new Set(tokenize(text).map(t => index.get(t)).filter((i): i is number => i !== undefined))]
  const groups: TermGroup[] = []
  for (const word of query.split(/\s+/)) {
    for (const [part] of word.matchAll(SCRIPT_RUN)) {
      if (IS_CJK.test(part)) {
        const segments = contentSegments(part)
        let rest = part
        for (const label of segments) {
          rest = rest.slice(rest.indexOf(label) + label.length)
          const n = [...label].length
          const isAsked = ASKED_AFTER.test(rest)
          groups.push({ units: [{ label, byChar: true, tokens: [] }], keyword: n >= 2 && n <= KEYWORD_MAX_CJK_CHARS && (segments.length === 1 || isAsked) })
        }
        continue
      }
      const label = part.replace(EDGE_PUNCT, '')
      if (ENGLISH_FUNCTION_WORDS.has(label.toLowerCase())) continue
      const ids = tokenIds(part)
      if (ids.length > 0) groups.push({ units: [{ label, byChar: false, tokens: ids }], keyword: true })
    }
  }
  return groups
}

export interface CoverageVerdict {
  /** 首条覆盖的查询内容比例：各组取对上比例高的写法，CJK 内容段逐字、非 CJK 词按 token 合计。 */
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
    const best = g.units.map(u => unitCover(u, tokens, hits)).reduce((a, b) => (b.covered * a.total > a.covered * b.total ? b : a))
    covered += best.covered
    total += best.total
    if (g.keyword && !g.units.some(u => isFull(u, tokens, hits))) missingKeywords.push(g)
  }
  const coverage = total === 0 ? 0 : covered / total
  return { coverage, missingKeywords, weak: missingKeywords.length > 0 || coverage < WEAK_COVERAGE_BELOW }
}

export interface TermHitCount {
  label: string
  count: number
}

/**
 * 逐词命中条数，按查询里的顺序、同名去重：每组算一个词，完整出现才算。
 * 句子里的内容段只列词长的（2 到 KEYWORD_MAX_CJK_CHARS 字），单字和更长的短语不列，也不列二字碎片。
 * rows 是范围内各条记录对查询 token 的命中。
 */
export function termHitCounts(groups: readonly TermGroup[], tokens: readonly string[], rows: readonly (readonly boolean[])[]): TermHitCount[] {
  const out: TermHitCount[] = []
  const wordLike = (g: TermGroup) => {
    const n = [...g.units[0]!.label].length
    return g.keyword || (n >= 2 && n <= KEYWORD_MAX_CJK_CHARS)
  }
  for (const g of groups.filter(wordLike)) {
    const label = g.units.map(u => u.label).join('/')
    if (out.some(c => c.label === label)) continue
    out.push({ label, count: rows.filter(hits => g.units.some(u => isFull(u, tokens, hits))).length })
  }
  return out
}
