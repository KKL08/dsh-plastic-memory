import { SECRET_MASK } from '../secrets.ts'

/**
 * 命中窗口：节选条目只给正文的一段，有命中词时取命中词附近。纯函数，不碰存储、宿主与分词器。
 * 窗口由完整的行或句子（单元）拼成，不按固定字符数切：固定切会让首尾语句不全，模型读到半句话容易误解。
 * 只有单个单元本身超过硬上限（日志、代码、没有标点的长段）时才按字符硬切，保证节选长度总有上限。
 * 调用方传入已遮盖密钥的正文，位置也在它上面找，节选不会比全文多露出内容。
 */

export interface MatchWindow {
  /** 节选正文，不含省略标记（由调用方加）。 */
  text: string
  /** 节选之前还有正文。 */
  hasBefore: boolean
  /** 节选之后还有正文。 */
  hasAfter: boolean
}

/** 一个单元在正文里的位置 [start, end)，line 是所在行号，判断相邻单元按原文相接还是换行连接。 */
interface Unit {
  start: number
  end: number
  line: number
}

/** 全角句末标点总是切分点。 */
const FULL_WIDTH_END = new Set(['。', '？', '！', '；'])
/** 半角句末标点只在后接空白或行尾时切分，版本号、文件名、网址里的点不算。 */
const HALF_WIDTH_END = new Set(['.', '?', '!', ';'])
/** 紧跟在全角句末标点后的连续标点和后引号、后括号留在同一个单元，免得下一句以「」」「？」开头。 */
const TRAILING_CLOSERS = new Set([...FULL_WIDTH_END, '”', '’', '」', '』', '）'])
/**
 * 句末标点的候选位置；半角的算不算句末，由找到后看下一个字符决定。换行也算候选，让查找停在本行行尾：
 * 否则无标点的长行会一路扫到全文后面的标点，逐行累加成二次复杂度。
 */
const SENTENCE_END = new RegExp(`[${[...FULL_WIDTH_END, ...HALF_WIDTH_END].join('')}\\r\\n]`, 'g')

const isSpace = (c: string | undefined) => c !== undefined && /\s/.test(c)
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** 命中词定位不区分大小写；按原文匹配，位置不受小写化改变长度的影响。 */
const termRegExp = (term: string, flags: 'iu' | 'giu') => new RegExp(escapeRegExp(term), flags)

/**
 * 切单元：先按行（兼容 CRLF），空白行不成单元；一行超过目标长度时再按句末标点切，标点留在前一个单元末尾。
 * 单元去掉句间空白和行尾空白，行首缩进留在该行第一个单元上，多行代码节选不丢缩进。
 */
function splitUnits(content: string, targetChars: number): Unit[] {
  const units: Unit[] = []
  let line = 0
  for (const m of content.matchAll(/[^\r\n]*/g)) {
    const lineStart = m.index
    const trimmed = m[0].trim()
    if (trimmed === '') continue
    const trimmedEnd = lineStart + m[0].trimEnd().length
    if (trimmed.length <= targetChars) {
      units.push({ start: lineStart, end: trimmedEnd, line })
    } else {
      let start = lineStart
      // 用正则跳到下一个句末标点，不逐字取字符：逐个取出汉字每次都新建字符串，在长正文上是窗口计算的主要耗时
      SENTENCE_END.lastIndex = lineStart
      for (let m = SENTENCE_END.exec(content); m !== null && m.index < trimmedEnd; m = SENTENCE_END.exec(content)) {
        let cut = m.index + 1
        if (FULL_WIDTH_END.has(m[0])) {
          while (cut < trimmedEnd && TRAILING_CLOSERS.has(content[cut]!)) cut++
        } else if (cut < trimmedEnd && !isSpace(content[cut])) continue
        units.push({ start, end: cut, line })
        start = cut
        while (start < trimmedEnd && isSpace(content[start])) start++
        SENTENCE_END.lastIndex = start
      }
      if (start < trimmedEnd) units.push({ start, end: trimmedEnd, line })
    }
    line++
  }
  return units
}

/**
 * 中心单元：覆盖不同命中词最多的；并列时比各自所含命中词在全文里的最少出现次数，小的优先
 * （满篇都出现的常见词不把窗口带走），再取最靠前的。都没有命中词时取第一个。
 */
function pickCenter(content: string, units: readonly Unit[], terms: readonly string[]): number {
  const totals = terms.map(t => content.match(termRegExp(t, 'giu'))?.length ?? 0)
  const tests = terms.map(t => termRegExp(t, 'iu'))
  let best = 0
  let bestCount = 0
  let bestRarest = Infinity
  units.forEach((u, i) => {
    const text = content.slice(u.start, u.end)
    let count = 0
    let rarest = Infinity
    tests.forEach((re, k) => {
      if (!re.test(text)) return
      count++
      rarest = Math.min(rarest, totals[k]!)
    })
    if (count > bestCount || (count === bestCount && count > 0 && rarest < bestRarest)) {
      best = i
      bestCount = count
      bestRarest = rarest
    }
  })
  return best
}

/**
 * 硬切：在 [from, to) 里找长度 maxChars、完整含不同命中词最多的一段，再把窗口对着其中的命中段
 * （最左命中起点到最右命中终点）居中、夹在 [from, to) 内：命中词前后都留上下文，不贴在窗口一端。
 * 命中段整个留在居中后的窗口里，不同命中词数不变。没有命中词时从开头取。
 * 起点逐字右移、按出入窗口增减命中计数，整段一遍扫完，不逐起点重扫。
 * 切点落在代理对或遮盖占位文字中间时向内退到它之外，宁可短一点也不出半个字或半个占位。
 */
function hardCut(content: string, from: number, to: number, terms: readonly string[], maxChars: number): [number, number] {
  const occ = terms.flatMap((t, k) =>
    [...content.slice(from, to).matchAll(termRegExp(t, 'giu'))].map(m => ({ start: from + m.index, end: from + m.index + m[0].length, term: k })))
  const byStart = [...occ].sort((a, b) => a.start - b.start)
  const byEnd = [...occ].sort((a, b) => a.end - b.end)
  const inWindow = new Array<number>(terms.length).fill(0)
  let distinct = 0
  let added = 0
  let removed = 0
  let bestStart = from
  let bestDistinct = -1
  for (let s = from; s + maxChars <= to; s++) {
    while (added < byEnd.length && byEnd[added]!.end <= s + maxChars) {
      const o = byEnd[added++]!
      if (o.start >= s && inWindow[o.term]++ === 0) distinct++
    }
    while (removed < byStart.length && byStart[removed]!.start < s) {
      const o = byStart[removed++]!
      // 起点刚移出窗口；只有上一步已整段落在窗口内的才计入过，要撤掉
      if (o.end <= s - 1 + maxChars && --inWindow[o.term]! === 0) distinct--
    }
    if (distinct > bestDistinct) {
      bestDistinct = distinct
      bestStart = s
    }
  }
  let spanStart = Infinity
  let spanEnd = -Infinity
  for (const o of occ) {
    if (o.start < bestStart || o.end > bestStart + maxChars) continue
    spanStart = Math.min(spanStart, o.start)
    spanEnd = Math.max(spanEnd, o.end)
  }
  let start = spanStart === Infinity
    ? bestStart
    : Math.min(Math.max(from, Math.floor((spanStart + spanEnd - maxChars) / 2)), to - maxChars)
  let end = Math.min(to, start + maxChars)
  if (start > from && /[\uDC00-\uDFFF]/.test(content[start]!)) start++
  if (end < to && /[\uD800-\uDBFF]/.test(content[end - 1]!)) end--
  for (const m of content.slice(from, to).matchAll(new RegExp(escapeRegExp(SECRET_MASK), 'g'))) {
    const a = from + m.index
    const b = a + SECRET_MASK.length
    if (a < start && start < b) start = b
    if (a < end && end < b) end = a
  }
  return [start, end]
}

/**
 * 从正文里取命中窗口。terms 是小写的命中词，可以为空；targetChars 约束向两边扩展，maxChars 约束单个单元。
 * 正文不超过 maxChars 时原样返回。窗口长度指拼接结果的字符串长度：同一行的相邻单元按原文相接，跨行用单个换行。
 */
export function matchWindow(content: string, terms: readonly string[], targetChars: number, maxChars: number): MatchWindow {
  if (content.length <= maxChars) return { text: content, hasBefore: false, hasAfter: false }
  const words = terms.filter(t => t !== '')
  const units = splitUnits(content, targetChars)
  if (units.length === 0) return { text: '', hasBefore: false, hasAfter: false }
  const center = pickCenter(content, units, words)
  const c = units[center]!
  const result = (start: number, end: number, text: string): MatchWindow => ({
    text,
    hasBefore: /\S/.test(content.slice(0, start)),
    hasAfter: /\S/.test(content.slice(end)),
  })

  if (c.end - c.start > maxChars) {
    const [start, end] = hardCut(content, c.start, c.end, words, maxChars)
    return result(start, end, content.slice(start, end))
  }

  // 两个单元之间的连接长度：同一行按原文相接，跨行用一个换行
  const gap = (a: Unit, b: Unit) => (a.line === b.line ? b.start - a.end : 1)
  let lo = center
  let hi = center
  let length = c.end - c.start
  let canAfter = length <= targetChars
  let canBefore = canAfter
  while (canAfter || canBefore) {
    if (canAfter) {
      const next = units[hi + 1]
      const grown = next === undefined ? Infinity : length + gap(units[hi]!, next) + next.end - next.start
      if (grown <= targetChars) {
        hi++
        length = grown
      } else canAfter = false
    }
    if (canBefore) {
      const prev = units[lo - 1]
      const grown = prev === undefined ? Infinity : length + gap(prev, units[lo]!) + prev.end - prev.start
      if (grown <= targetChars) {
        lo--
        length = grown
      } else canBefore = false
    }
  }

  let text = content.slice(units[lo]!.start, units[lo]!.end)
  for (let i = lo + 1; i <= hi; i++) {
    const u = units[i]!
    text += units[i - 1]!.line === u.line ? content.slice(units[i - 1]!.end, u.end) : `\n${content.slice(u.start, u.end)}`
  }
  return result(units[lo]!.start, units[hi]!.end, text)
}
