import { currentJieba } from './jieba-segmenter.ts'
import type { QueryTokenizerOptions } from './jieba-segmenter.ts'
import { bigramSegmenter, CJK } from './tokenizer.ts'

/** 分词器版本：切法加归一化规则。三列的内容会变的改动都要加一。 */
export const DIALOGUE_TOKENIZER_VERSION = 1

/** bm25 的列权重，顺序 w、b、c。先用保守值，评测后再调。 */
export const DIALOGUE_BM25_WEIGHTS = [4, 2, 1] as const

/** 一行文本的三列，以空格分隔 token，供 unicode61 索引。 */
export interface DialogueColumns {
  /** 搜索模式的词；词典不可用时为空串。 */
  w: string
  /** 汉字段、假名谚文段各自的二元组，及原样保留的其他段（由 unicode61 再按符号拆开）。 */
  b: string
  /** 每个汉字各占一个 token。 */
  c: string
}

/** 同一批查询词的两种组合，all 不足时可退回 any。 */
export interface DialogueMatch {
  /** 各查询词之间 AND。 */
  all: string
  /** 各查询词之间 OR；单词时与 all 相同。 */
  any: string
}

/** 一次加载的分词器快照；索引和查询共用归一化及词典。 */
export interface DialogueTokenizer {
  tokenizerVersion: number
  /** 实际加载的主词典及用户词典内容 hash；降级时无值。 */
  dictionaryVersion: string | undefined
  /** 降级时只使用 b、c，查询不引用 w。 */
  degraded: boolean
  columns(text: string): DialogueColumns
  /** 没有可检索文字时返回 undefined；仅含停用词时保留原词。 */
  match(query: string): DialogueMatch | undefined
}

const HAS_ALNUM = /[\p{L}\p{N}]/u
// CJK 里除汉字以外的文字：jieba 只会把它们逐字切，所以不交给词典，两侧都走二字滑窗。
// 长音符 ー 的文字属性是通用，不算假名，单列进来：否则它会把片假名词切成几段，丢了字序。
const KANA_HANGUL = String.raw`\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u30FC`
// 汉字段、假名谚文段、其他段（不含 CJK、不含空白的连续串），按出现顺序。
const SEGMENT = new RegExp(String.raw`(\p{Script=Han}+)|([${KANA_HANGUL}]+)|[^${CJK}\u30FC\s]+`, 'gu')
// 只去少量高频虚词，避免扩充词表后误删技术词；全被去掉时保留原词。
const STOP_WORDS = new Set(['的', '了', '是', '在', '和', '吗', '呢', '吧', '啊', '呀', '哦', '也', '都', '就', '又', '与', '及', '或', '而', '着'])

interface Segment {
  text: string
  kind: 'han' | 'kanaHangul' | 'other'
}

// 控制字符（含 NUL）会截断传给 SQLite 的字符串，双引号会打断短语；两侧都先换成空格，不依赖分词器碰巧切开它们。
function normalize(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/[\p{Cc}"]/gu, ' ')
}

/**
 * 索引和查询共用这一个分段，jieba 只收到纯汉字段，两侧切法才不会分叉。
 * 其他段整段保留：路径、文件名、标识符的分隔符交给 unicode61 拆，词序靠短语查询保住。
 * 代价：混排的词典词（如 4s店）不作为一个词，查它等于各段都要命中。
 */
function segments(text: string): Segment[] {
  const out: Segment[] = []
  for (const [seg, han, kanaHangul] of text.matchAll(SEGMENT)) {
    if (han !== undefined) out.push({ text: seg, kind: 'han' })
    else if (kanaHangul !== undefined) out.push({ text: seg, kind: 'kanaHangul' })
    else if (HAS_ALNUM.test(seg)) out.push({ text: seg, kind: 'other' })
  }
  return out
}

// 逐项追加：正文没有长度上限，展开成参数遇到超多 token 会抛 RangeError
function append(out: string[], tokens: string[]): void {
  for (const tok of tokens) out.push(tok)
}

function quote(token: string): string {
  return `"${token.replaceAll('"', '""')}"`
}

function withoutStopWords<T>(terms: [string, T][]): [string, T][] {
  const filtered = terms.filter(([word]) => !STOP_WORDS.has(word))
  return filtered.length === 0 ? terms : filtered
}

/** 用户词典路径现读，加载与告警复用记忆检索的单例；不读写正文文件。 */
export async function dialogueTokenizer(opts?: QueryTokenizerOptions): Promise<DialogueTokenizer> {
  const loaded = await currentJieba(opts)
  const jieba = loaded.jieba
  return {
    tokenizerVersion: DIALOGUE_TOKENIZER_VERSION,
    dictionaryVersion: loaded.dictionaryVersion,
    degraded: jieba === undefined,
    columns(text) {
      const normalized = normalize(text)
      const w: string[] = []
      const b: string[] = []
      // 每段各自切，不跨文字连成二元组；整词和子词都是单个 unicode61 token，不会首尾相接造出假短语
      for (const { text: seg, kind } of segments(normalized)) {
        if (kind === 'other') {
          w.push(seg)
          b.push(seg)
          continue
        }
        const bigrams = bigramSegmenter.segment(seg)
        append(b, bigrams)
        if (jieba !== undefined) append(w, kind === 'han' ? jieba.cutForSearch(seg, true) : bigrams)
      }
      return {
        w: jieba === undefined ? '' : w.join(' '),
        b: b.join(' '),
        c: (normalized.match(/\p{Script=Han}/gu) ?? []).join(' '),
      }
    },
    match(query) {
      // 每项是「查询词, 表达式」，查询词只用来去停用词
      const terms: [string, string][] = []
      for (const { text: seg, kind } of segments(normalize(query))) {
        if (kind !== 'han') {
          // 假名谚文段在 w、b 两列都是同样的二元组，查 w 不改变命中集合，只让正常写入的行多得 w 列权重，和其他段一致
          const phrase = quote(kind === 'other' ? seg : bigramSegmenter.segment(seg).join(' '))
          terms.push([seg, jieba === undefined ? `(b : ${phrase})` : `(w : ${phrase} OR b : ${phrase})`])
          continue
        }
        // 降级时汉字段的每个二元组各成一组（组间 AND）
        for (const word of jieba === undefined ? bigramSegmenter.segment(seg) : jieba.cut(seg, true)) {
          // 单字在 b 列会和邻字连成二元组，只能查 c 列
          if ([...word].length === 1) terms.push([word, `c : ${quote(word)}`])
          else if (jieba === undefined) terms.push([word, `(b : ${quote(word)})`])
          else terms.push([word, `(w : ${quote(word)} OR b : ${quote(bigramSegmenter.segment(word).join(' '))})`])
        }
      }
      const groups = withoutStopWords(terms).map(([, expression]) => expression)
      if (groups.length === 0) return undefined
      return { all: groups.join(' AND '), any: groups.join(' OR ') }
    },
  }
}
