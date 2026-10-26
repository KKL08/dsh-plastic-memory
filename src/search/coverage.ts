import { CJK } from './tokenizer.ts'

/**
 * 「命中弱」的判断：没有记录同时命中全部查询 token 时，看排第一的那条对上了查询的多少。
 * 查询先按空白和文字种类切成词：CJK 连续段去掉虚词后剩下的内容段，其他文字每个空白分隔的词；
 * 中英双写的同一个术语，只有范围内有记录两种写法都出现过才配成一对。逐词命中条数也按这套分组数。
 * 纯函数，不碰存储与分词器状态。拿不准时偏向判弱：误判弱只多搜一轮，漏判弱会让模型把错的结果当答案。
 */

/**
 * 首条覆盖的查询内容低于这个比例算弱。取值由评估集（tests/fixtures/search-eval.ts）定：库里没有答案的长句，
 * 首条最多盖住约六成内容字（两档分词器都是），取刚好高过它的值；有答案的长句因此会有几条误判弱，只多搜一轮。
 * 依据见 scripts/eval-search.ts「命中弱」一节；改之前先跑它。
 */
export const WEAK_COVERAGE_BELOW = 0.65

/** 去掉虚词后 2 到这个字数的 CJK 词按关键词看（术语多在四字以内）；更长的按句子看，各内容段只计入覆盖度。 */
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

/** 查询里的一个词：一个非 CJK 词，或 CJK 词去掉虚词后的一个内容段。 */
export interface QueryUnit {
  /** 显示用：非 CJK 词去掉首尾标点，CJK 内容段原样。 */
  label: string
  isCjk: boolean
  /** 非 CJK 词切出的查询 token 下标；CJK 内容段不用它，按字算覆盖。 */
  tokens: number[]
}

export interface TermGroup {
  /** 一个词；或中英双写的一对（CJK 在前）。 */
  units: QueryUnit[]
  /** 关键词组：非 CJK 词、去掉虚词后 2 到 KEYWORD_MAX_CJK_CHARS 字的 CJK 词、成对的。整组没在首条出现就判弱；其余只计入覆盖度。 */
  keyword: boolean
}

const SCRIPT_RUN = new RegExp(`[${CJK}]+|[^${CJK}]+`, 'gu')
const IS_CJK = new RegExp(`[${CJK}]`, 'u')
const EDGE_PUNCT = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu
/**
 * 能和中文词成对的英文词：单个全小写词（deploy、rate-limit）或全大写缩写（CI、API）。首字母大写或大小写混写的
 * 多是产品名、标识符（Redis、readScope），带数字、斜杠、点的（v2、node22、路径）是字面值，都不配对。
 */
const PAIRABLE_LATIN = /^(?:[a-z]+(?:-[a-z]+)*|[A-Z]{2,})$/

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
  if (!unit.isCjk) return { covered: unit.tokens.filter(i => hits[i]).length, total: unit.tokens.length }
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
 * 查询切词与中英成对。tokens 是执行器清洗后的查询 token（去重、剔除噪声），tokenize 是查询与记录共用的分词器，
 * rows 是范围内各条记录对 tokens 的命中（成对的证据）。
 * 成对：关键词长度的 CJK 词与紧挨着的一个英文词（先看前面再看后面，见 PAIRABLE_LATIN），且范围内至少一条记录两种写法都完整出现。
 * 没有这样的记录，就是两个独立的关键词。不产生 token 的词（纯数字、标点）和只有虚词的 CJK 段先剔掉。
 */
export function groupQueryTerms(
  query: string, tokens: readonly string[], tokenize: (text: string) => string[], rows: readonly (readonly boolean[])[],
): TermGroup[] {
  const index = new Map(tokens.map((t, i) => [t, i] as const))
  // 词：CJK 段带上它的内容段，非 CJK 词带上 token
  const terms: { unit: QueryUnit; keyword: boolean; segments?: QueryUnit[] }[] = []
  for (const word of query.split(/\s+/)) {
    for (const [part] of word.matchAll(SCRIPT_RUN)) {
      if (IS_CJK.test(part)) {
        const segments = contentSegments(part).map(label => ({ label, isCjk: true, tokens: [] as number[] }))
        if (segments.length === 0) continue
        const n = [...segments[0]!.label].length
        if (segments.length === 1 && n >= 2 && n <= KEYWORD_MAX_CJK_CHARS) terms.push({ unit: segments[0]!, keyword: true })
        else terms.push({ unit: segments[0]!, keyword: false, segments })
        continue
      }
      const toks = [...new Set(tokenize(part).map(t => index.get(t)).filter((i): i is number => i !== undefined))]
      if (toks.length > 0) terms.push({ unit: { label: part.replace(EDGE_PUNCT, ''), isCjk: false, tokens: toks }, keyword: true })
    }
  }
  const paired = new Map<number, number>()
  const used = new Set<number>()
  const canPair = (i: number, j: number) => j >= 0 && j < terms.length && !used.has(j) && terms[j]!.unit.isCjk === false
    && PAIRABLE_LATIN.test(terms[j]!.unit.label)
    && rows.some(hits => isFull(terms[i]!.unit, tokens, hits) && isFull(terms[j]!.unit, tokens, hits))
  terms.forEach((t, i) => {
    if (!t.unit.isCjk || !t.keyword || used.has(i)) return
    const j = canPair(i, i - 1) ? i - 1 : canPair(i, i + 1) ? i + 1 : undefined
    if (j === undefined) return
    used.add(i)
    used.add(j)
    paired.set(i, j)
  })
  const groups: TermGroup[] = []
  terms.forEach((t, i) => {
    const j = paired.get(i)
    if (j !== undefined) groups.push({ units: [t.unit, terms[j]!.unit], keyword: true })
    else if (!used.has(i)) {
      if (t.segments !== undefined) for (const s of t.segments) groups.push({ units: [s], keyword: false })
      else groups.push({ units: [t.unit], keyword: t.keyword })
    }
  })
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
 * 逐词命中条数，按查询里的顺序、同名去重：每组算一个词（成对的显示成「中文/英文」，任一写法完整出现即算）。
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
