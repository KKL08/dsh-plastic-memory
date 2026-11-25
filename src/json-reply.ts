import type { SuggestionParseStage } from './contract-codes.ts'

/**
 * 模型回复里的 JSON 对象（容忍外面包了代码块或前后多了话）：先取第一个 { 到最后一个 }；解析不了时（前后的话里也带花括号），
 * 逐段试回复里配平的顶层 {…} 片段，恰好一段解析得了才用它。读不出时给卡在哪一步：没有花括号是 no-object；
 * 有花括号但一段都解析不了是 syntax；解析得了的片段不止一段记 shape：每段单独看都是合法 JSON，
 * 卡住的是回复整体不合「只有一个对象」的格式，记 syntax 会和截断混在一起。多段时不猜哪段是答案。
 * 回复里有一个 { 到结尾都没配平（多半是答案被截断）时一律读不出、记 syntax：前面配平的片段可能只是模型复述的格式示例，
 * 截断的答案里已经闭合的内层对象也不是答案。
 * 中文回复里模型偶尔把两个字段之间的逗号、键后面的冒号写成全角：每段照原样解析不了时，把字符串外面的全角逗号、冒号换成半角再试一次。
 * 字符串里面的内容一个字都不动（稿里的标点要逐字保留）。
 */
export function readJsonObject(raw: string): { ok: true; value: unknown } | { ok: false; stage: SuggestionParseStage } {
  const start = raw.indexOf('{')
  if (start < 0) return { ok: false, stage: 'no-object' }
  const end = raw.lastIndexOf('}')
  // 最后一个 } 后面还有 {：它到结尾都配不平
  if (raw.indexOf('{', end + 1) >= 0) return { ok: false, stage: 'syntax' }
  if (end > start) {
    const whole = parsedJson(raw.slice(start, end + 1))
    if (whole !== undefined) return { ok: true, value: whole.value }
  }
  const fragments = balancedFragments(raw)
  if (fragments === undefined) return { ok: false, stage: 'syntax' }
  const parsed = fragments.map(parsedJson).filter(p => p !== undefined)
  if (parsed.length === 1) return { ok: true, value: parsed[0]!.value }
  return { ok: false, stage: parsed.length === 0 ? 'syntax' : 'shape' }
}

/** 模型的回复不是要求的 JSON 对象时，重问一次附在后面的话（整理索引、记忆梦境共用）。 */
export const JSON_RETRY_HINT = '\n\n上一次的回复没有按输出格式给出 JSON 对象。这次只回复那个 JSON 对象。'

/** 同 readJsonObject，只要对象；读不出为 undefined。 */
export function jsonObjectIn(raw: string): unknown {
  const read = readJsonObject(raw)
  return read.ok ? read.value : undefined
}

/** 照原样解析，不行就换掉字符串外面的全角分隔符再试；都不行为 undefined。 */
function parsedJson(text: string): { value: unknown } | undefined {
  for (const candidate of [text, withHalfWidthSeparators(text)]) {
    try {
      return { value: JSON.parse(candidate) as unknown }
    } catch {
      // 换一种再试
    }
  }
  return undefined
}

/**
 * 回复里配平的顶层 {…} 片段：片段里面按引号和反斜杠转义认字符串，字符串里的花括号不算；片段外面的引号不管（前后的话里的引号不成对）。
 * 有一个 { 到回复结尾都没配平为 undefined。
 */
function balancedFragments(raw: string): string[] | undefined {
  const fragments: string[] = []
  let from = 0
  while (true) {
    const start = raw.indexOf('{', from)
    if (start < 0) return fragments
    const end = matchingBrace(raw, start)
    if (end === undefined) return undefined
    fragments.push(raw.slice(start, end + 1))
    from = end + 1
  }
}

/** start 处的 { 配平的 } 的位置；到结尾都没配平为 undefined。 */
function matchingBrace(raw: string, start: number): number | undefined {
  let depth = 0
  let isInString = false
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i]!
    if (isInString) {
      if (ch === '\\') i++
      else if (ch === '"') isInString = false
    } else if (ch === '"') {
      isInString = true
    } else if (ch === '{') {
      depth++
    } else if (ch === '}' && --depth === 0) {
      return i
    }
  }
  return undefined
}

/** 字符串外面的全角逗号、冒号换成半角；按引号和反斜杠转义判断在不在字符串里。 */
function withHalfWidthSeparators(text: string): string {
  let out = ''
  let isInString = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (isInString) {
      out += ch
      if (ch === '\\' && i + 1 < text.length) out += text[++i]!
      else if (ch === '"') isInString = false
    } else if (ch === '"') {
      isInString = true
      out += ch
    } else {
      out += ch === '，' ? ',' : ch === '：' ? ':' : ch
    }
  }
  return out
}
