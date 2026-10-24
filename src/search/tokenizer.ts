/** 连续 CJK 文本的切分器。默认 bigram；可换成词典分词器（如 jieba），只接管 CJK 段。 */
export interface CjkSegmenter {
  segment(run: string): string[]
}

/** 无词典时对 CJK 的标准做法：二字滑窗让非连续短语也能按局部命中；单字段无从切分，保留单字。
 * 按码点而非 UTF-16 单元切，扩展区汉字（代理对）不会被劈成两半。 */
export const bigramSegmenter: CjkSegmenter = {
  segment(run) {
    const chars = [...run]
    if (chars.length < 2) return chars
    const out: string[] = []
    for (let i = 0; i < chars.length - 1; i++) out.push(chars[i]! + chars[i + 1]!)
    return out
  },
}

// CJK 取汉字、假名、谚文：三者都不靠空格分词，同样需要滑窗或词典切分。
const CJK = String.raw`\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}`
// 按脚本分段：CJK 连续段，或由「字母、数字、组合附加符、_、-」组成的整词（排除 CJK 字符，否则 abc中文 会粘成一段）。
// 其余字符（空白、标点、符号）都是分隔符，自然丢弃。
const SEGMENT = new RegExp(String.raw`([${CJK}]+)|((?:(?![${CJK}])[\p{L}\p{M}\p{N}_-])+)`, 'gu')

/** 整词里没有字母数字（如孤立的 - 或 __）算纯标点，丢弃。 */
const HAS_ALNUM = /[\p{L}\p{N}]/u

/** 在小写之前按驼峰、连续大写收尾、字母数字边界插入断点，再按 _ - 断点切开。
 * HTTPServer → HTTP | Server；HTTP2Server → HTTP | 2 | Server。 */
function splitSubwords(word: string): string[] {
  return word
    .replace(/(\p{Ll})(\p{Lu})/gu, '$1\0$2')
    .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, '$1\0$2')
    .replace(/(\p{L})(\p{N})/gu, '$1\0$2')
    .replace(/(\p{N})(\p{L})/gu, '$1\0$2')
    .split(/[\0_-]+/)
    .filter(Boolean)
}

/** 单个字母、纯数字的子词只制造噪声（mem_7f 的 f、7 会命中大量无关记录），不作为检索 token。 */
function isNoiseSubword(sub: string): boolean {
  return [...sub].length === 1 || /^\p{N}+$/u.test(sub)
}

/** 整词在前、子词随后，都小写。拆不开的整词只出一次，不让同一个词计两次词频。 */
function tokenizeWord(word: string, out: string[]): void {
  if (!HAS_ALNUM.test(word)) return
  out.push(word.toLowerCase())
  const subs = splitSubwords(word)
  if (subs.length === 1 && subs[0] === word) return
  for (const sub of subs) if (!isNoiseSubword(sub)) out.push(sub.toLowerCase())
}

/**
 * 检索分词：查询与记录两侧共用同一个实例，保证切法一致。
 * 按出现顺序返回、不去重——排序要用词频。CJK 段交给注入的切分器，缺省 bigram。
 */
export function createTokenizer(opts?: { cjk?: CjkSegmenter }): (text: string) => string[] {
  const cjk = opts?.cjk ?? bigramSegmenter
  return text => {
    const out: string[] = []
    for (const [, cjkRun, word] of text.matchAll(SEGMENT)) {
      // 逐项追加：正文没有长度上限，push(...arr) 遇到十几万个 token 会超出参数个数上限而抛 RangeError
      if (cjkRun !== undefined) for (const tok of cjk.segment(cjkRun)) out.push(tok)
      else if (word !== undefined) tokenizeWord(word, out)
    }
    return out
  }
}
