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

/** 判重阈值（Dice 系数）：初值，真实使用数据回流后可调。 */
export const DUPLICATE_SIMILARITY_THRESHOLD = 0.55

/**
 * bigram Dice 相似度，补实体重叠在中文散文上的盲区——纯中文陈述往往提不出任何实体，
 * 实体轴对它完全失明。词项集合复用检索层的 expandQueryTerms（CJK 二字滑窗）。
 */
export function textSimilarity(a: string, b: string): number {
  const sa = new Set(expandQueryTerms(a))
  const sb = new Set(expandQueryTerms(b))
  if (sa.size === 0 || sb.size === 0) return 0
  let inter = 0
  for (const t of sa) if (sb.has(t)) inter++
  return (2 * inter) / (sa.size + sb.size)
}
