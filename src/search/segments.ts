import { estimateTokens, tokenTenths } from '../snapshot.ts'

/** 一段的 token 上限，限制后续全文检索中单行消息的大小。 */
export const SEGMENT_MAX_TOKENS = 300
/** 切分规则版本：上限、切法、token 估算三样合起来的版本号。切分结果会变的改动都要加一。 */
export const SEGMENT_RULE_VERSION = 1

interface Block {
  text: string
  byLine: boolean
}

// 换行留在前一行，CRLF 作为一个分隔符；也保留文末没有换行的最后一行。
function lines(text: string): string[] {
  return text.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) ?? []
}

function blocks(text: string): Block[] {
  const out: Block[] = []
  let current = ''
  let kind: 'text' | 'code' | 'table' = 'text'
  let fence = ''
  let afterBlank = false
  const flush = () => {
    if (current !== '') out.push({ text: current, byLine: kind !== 'text' })
    current = ''
  }
  for (const line of lines(text)) {
    if (fence !== '') {
      current += line
      const closing = line.match(/^(`{3,}|~{3,})[\t ]*(?:\r\n|\r|\n)?$/)?.[1]
      if (closing !== undefined && closing[0] === fence[0] && closing.length >= fence.length) fence = ''
      continue
    }
    if (/^\s*$/.test(line)) {
      current += line
      afterBlank = true
      continue
    }
    // 反引号围栏的起始行后面不能再有反引号：行首的 ```foo``` 是行内代码，不是围栏
    const opening = line.match(/^(`{3,})[^`]*$|^(~{3,})/)?.slice(1).find(x => x !== undefined)
    const isTable = line.startsWith('|')
    const startsBlock = /^#{1,6} |^[\t ]*(?:[-*+]|\d+\.) /.test(line)
    if (afterBlank || opening !== undefined || startsBlock || kind === 'code' || (kind === 'table') !== isTable) flush()
    if (current === '') kind = opening !== undefined ? 'code' : isTable ? 'table' : 'text'
    current += line
    fence = opening ?? ''
    afterBlank = false
  }
  flush()
  return out
}

function sentences(text: string): string[] {
  const out: string[] = []
  let start = 0
  // 句末标点（连着的几个算一处）带上紧跟的闭合引号括号、行内空白和一个换行，归前一句；半角点后必须是空白或文末。
  // 单独的换行也是边界，一次只吞一个：下一行开头的引号、缩进留给下一句。
  const boundary = /(?:[。！？!?；;]+|\.(?=\s|$))[”’」』）】》〉〕］｝"')\]}]*[^\S\r\n]*(?:\r\n|\r|\n)?|\r\n|\r|\n/g
  for (const match of text.matchAll(boundary)) {
    const end = match.index + match[0].length
    out.push(text.slice(start, end))
    start = end
  }
  if (start < text.length) out.push(text.slice(start))
  return out
}

/** 硬切的最小单位：一个码点，CRLF 算一个，不把它劈到两段。 */
function atoms(text: string): string[] {
  return text.match(/\r\n|[\s\S]/gu) ?? []
}

/** 上限换成十分之一 token：累加值不超过它，和整段估算不超过上限是一回事。 */
const MAX_TENTHS = SEGMENT_MAX_TOKENS * 10

/** 按原文顺序贪心装段：加上下一份不超限就加，超了另起一段。用量逐份累加，不重算已装的部分。 */
function merge(parts: readonly string[]): string[] {
  const out: string[] = []
  let current = ''
  let used = 0
  for (const part of parts) {
    const cost = tokenTenths(part)
    if (current !== '' && used + cost > MAX_TENTHS) {
      out.push(current)
      current = ''
      used = 0
    }
    current += part
    used += cost
  }
  if (current !== '') out.push(current)
  return out
}

/**
 * 把一条消息无损切成有序的段，每段不超过上限；下标就是段序号，空字符串返回一段。
 * 超长的块先在块内切开，切出来的各份再和前后的块一起贪心装段：块尾剩下的零头并进相邻的段，不单独成一小段。
 */
export function splitIntoSegments(text: string): string[] {
  if (estimateTokens(text) <= SEGMENT_MAX_TOKENS) return [text]
  const parts: string[] = []
  for (const block of blocks(text)) {
    if (estimateTokens(block.text) <= SEGMENT_MAX_TOKENS) {
      parts.push(block.text)
      continue
    }
    const units = block.byLine ? lines(block.text) : sentences(block.text)
    const split = units.flatMap(unit => estimateTokens(unit) <= SEGMENT_MAX_TOKENS ? [unit] : merge(atoms(unit)))
    for (const part of merge(split)) parts.push(part)
  }
  return merge(parts)
}
