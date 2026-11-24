import { SECRET_MASK } from './secrets.ts'
import type { MemoryRecord } from './record-schema.ts'

/** 把查询串展开成匹配项：空白分词后，每个词内的 CJK 段切 2 字滑窗 bigram（单字 CJK 段保留），
 * 非 CJK 段整体保留。无分词器时对 CJK 语料的标准做法——让"部署流程配置"这类非连续短语也能命中。 */
export function expandQueryTerms(keyword: string): string[] {
  const out = new Set<string>()
  for (const term of keyword.toLowerCase().split(/\s+/).filter(Boolean)) {
    for (const seg of term.match(/[一-鿿]+|[^一-鿿]+/g) ?? []) {
      if (/[一-鿿]/.test(seg)) {
        const chars = [...seg]
        if (chars.length >= 2) for (let i = 0; i < chars.length - 1; i++) out.add(chars[i] + chars[i + 1])
        else out.add(seg)
      } else if (seg) out.add(seg)
    }
  }
  return [...out]
}

/** 记录对一组匹配项的命中数（各项子串命中计 1）。haystack 覆盖 id/name/content/summary/tags。 */
export function matchScore(record: MemoryRecord, terms: string[]): number {
  const haystack = `${record.id}\n${record.name}\n${record.content}\n${record.summary}\n${record.tags.join(' ')}`.toLowerCase()
  let n = 0
  for (const t of terms) if (haystack.includes(t)) n++
  return n
}

/** 超常见技术缩写不当实体——两条无关记忆只因都提到 API 就判重复是纯误报。 */
const ENTITY_STOPWORDS = new Set(['API', 'URL', 'URI', 'TODO', 'README', 'HTTP', 'HTTPS', 'JSON', 'YAML', 'HTML', 'CSS', 'SQL', 'GET', 'POST', 'CLI', 'SDK', 'IDE'])

/** 从文本提取用于结构去重的关键实体。 */
export function extractEntities(text: string): string[] {
  const out = new Set<string>()
  for (const m of text.matchAll(/`([^`]+)`/g)) out.add(m[1])
  for (const m of text.matchAll(/https?:\/\/[^\s，。」）)]+/g)) out.add(m[0])
  for (const m of text.matchAll(/(?<![\w/])((?:[\w.-]+\/)+[\w.-]+)/g)) out.add(m[1])
  for (const m of text.matchAll(/[「"']([^「」"']{2,24})[」"']/g)) out.add(m[1])
  for (const m of text.matchAll(/\b[A-Z]{3,8}\b/g)) {
    if (!ENTITY_STOPWORDS.has(m[0])) out.add(m[0])
  }
  return [...out]
}

/** 判「接近逐字重复」前的规范化：NFKC 后删掉全部空白和标点；大小写和符号保留。 */
export function normalizeForDuplicate(text: string): string {
  return text.normalize('NFKC').replace(/[\p{White_Space}\p{P}]/gu, '')
}

/**
 * 字符相似度：1 − 编辑距离 / 较长一段的码点数。都为空为 1，只有一边为空为 0。
 * 给阈值时只保证达标结果精确；确定不达标就返回 0，避免长正文做全矩阵比较。
 */
export function charSimilarity(a: string, b: string, threshold?: number): number {
  const left = [...a]
  const right = [...b]
  const max = Math.max(left.length, right.length)
  if (max === 0) return 1
  if (Math.min(left.length, right.length) === 0) return 0
  if (threshold !== undefined && Math.min(left.length, right.length) / max < threshold) return 0
  // 浮点误差不能把恰好达标的一个编辑距离排除在带外。
  const width = threshold === undefined ? max : Math.floor((1 - threshold) * max + Number.EPSILON * max)
  let previous = Array.from({ length: right.length + 1 }, (_, i) => i <= width ? i : Infinity)
  let current = new Array<number>(right.length + 1).fill(Infinity)
  for (let i = 1; i <= left.length; i++) {
    const start = Math.max(1, i - width)
    const end = Math.min(right.length, i + width)
    current[0] = i <= width ? i : Infinity
    if (start > 1) current[start - 1] = Infinity
    let min = current[0]
    for (let j = start; j <= end; j++) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1))
      min = Math.min(min, current[j])
    }
    if (end < right.length) current[end + 1] = Infinity
    if (min > width) return 0
    ;[previous, current] = [current, previous]
  }
  const distance = previous[right.length]
  return distance > width ? 0 : 1 - distance / max
}

/** 丢失信号支持的事实类别；抽取优先级由路径到数字逐级下降。 */
export type FactKind = 'date' | 'number' | 'name' | 'path'
/** 一项正文事实，text 保留原文写法，名称不含包围它的引号。 */
export interface Fact { kind: FactKind; text: string }

/** 正文里的数字、日期、专名、路径；高优先级占用的片段不重复归类。输入应先整段遮盖密钥。 */
export function extractFacts(text: string): Fact[] {
  const hits: Array<Fact & { start: number; end: number }> = []
  const take = (kind: FactKind, regex: RegExp, select: (match: RegExpExecArray) => string | undefined = match => match[0]) => {
    for (const match of text.matchAll(regex)) {
      const value = select(match)
      if (!value || value.includes(SECRET_MASK)) continue
      const start = match.index
      const end = start + match[0].length
      if (hits.some(hit => start < hit.end && end > hit.start)) continue
      hits.push({ kind, text: value, start, end })
    }
  }
  take('path', /https?:\/\/[^\s，。！？；「」『』“”`]+/g, match => match[0].replace(/[.,;:)]+$/, ''))
  take('path', /(?<![\w/])(?:~\/|\.\.?\/|\/)?(?:[\w.@-]+\/)+[\w.@-]*|(?<![\w/])(?:~\/|\.\.?\/|\/)[\w.@-]+/g, match => {
    const value = match[0].replace(/[.,;:)]+$/, '')
    // 数字组成的斜杠日期归日期类，避免路径优先级吞掉日期。
    return /^\d{4}\/\d{1,2}\/\d{1,2}$/.test(value) ? undefined : value
  })
  take('date', /(?<!\d)(?:\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{4}年(?:\d{1,2}月(?:\d{1,2}[日号])?)?|\d{1,2}月\d{1,2}[日号])(?:[ \t]*\d{1,2}:\d{2}(?::\d{2})?)?|(?<!\d)\d{1,2}:\d{2}(?::\d{2})?/g)
  take('name', /`([^`]+)`|「([^「」]{2,40})」|『([^『』]{2,40})』|“([^“”]{2,40})”/g, match => match.slice(1).find(value => value !== undefined))
  take('name', /(?<![\w.+-])[A-Za-z][A-Za-z0-9_.+-]*/g, match => {
    const value = match[0].replace(/[.]+$/, '')
    // 英文句子句首只有首字母大写的是普通单词（When、Use），不算专名；PostgreSQL、S3 这类在句首仍算。
    // 后面紧跟汉字（「Redis 备份每天执行」）的不是英文句子，照常算
    const isSentenceStart = /(?:^|[.!?。！？\n])[ \t]*$/.test(text.slice(0, match.index))
    const isBeforeHan = /^[ \t]*\p{Script=Han}/u.test(text.slice(match.index + match[0].length))
    if (isSentenceStart && !isBeforeHan && /^[A-Z][^A-Z\d]*$/.test(value)) return undefined
    return !ENTITY_STOPWORDS.has(value) && (/[A-Z]/.test(value) || /\d/.test(value)) ? value : undefined
  })
  take('number', /\d+(?:,\d{3})*(?:\.\d+)*(?:-[A-Za-z][A-Za-z0-9]*(?:\.\d+)*)?%?/g, match => {
    const prefix = text.slice(text.lastIndexOf('\n', match.index - 1) + 1, match.index)
    const tail = text.slice(match.index + match[0].length)
    return /^\s*$/.test(prefix) && /^\d+$/.test(match[0]) && /^[.、)]\s/.test(tail) ? undefined : match[0]
  })
  const seen = new Set<string>()
  return hits.sort((a, b) => a.start - b.start).flatMap(({ kind, text: value }) => {
    const key = `${kind}:${value}`
    if (seen.has(key)) return []
    seen.add(key)
    return [{ kind, text: value }]
  })
}
