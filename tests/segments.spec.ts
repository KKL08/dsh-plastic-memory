import { describe, expect, it } from 'vitest'
import { SEGMENT_MAX_TOKENS, SEGMENT_RULE_VERSION, splitIntoSegments } from '../src/search/segments.ts'
import { estimateTokens } from '../src/snapshot.ts'

function check(text: string): string[] {
  const segments = splitIntoSegments(text)
  expect(segments.join('')).toBe(text)
  expect(segments.length).toBeGreaterThan(0)
  for (const segment of segments) {
    expect(estimateTokens(segment)).toBeLessThanOrEqual(SEGMENT_MAX_TOKENS)
    if (text !== '') expect(segment).not.toBe('')
  }
  return segments
}

const samples = [
  ['中文空行', ('这是一段中文。'.repeat(20) + '\n\n').repeat(10)],
  ['标题列表', ('# 标题\n' + '内容'.repeat(80) + '\n## 小标题\n- 第一项\n  * 第二项\n+ 第三项\n1. 第四项\n').repeat(8)],
  ['围栏代码', ('```ts\nconst x = 1\n\nconst y = 2\n```\n').repeat(40)],
  ['表格', ('| 第一列 | 第二列 |\n| --- | --- |\n| 内容 | 数值 |\n').repeat(40)],
  ['中英文混排', '中文 English v1.2.3! 下一句；done. '.repeat(100)],
  ['代理对', '😀𠮷中文'.repeat(800)],
  ['只有换行', '\n'.repeat(3000)],
  ['末尾空白', '文字。'.repeat(600) + ' \t\n\n  '],
  ['回车换行', ('段落。'.repeat(80) + '\r\n \t\r\n').repeat(10)],
] as const

describe('消息切段', () => {
  it('不超过上限的消息原样返回，空字符串也有一段', () => {
    for (const text of ['', '短消息。\n\n', '中'.repeat(500), 'a'.repeat(1000)]) {
      expect(check(text)).toEqual([text])
    }
  })

  it.each(samples)('%s长消息无损且每段不超过上限', (_name, text) => { check(text) })

  it('十个小段落按原文顺序贪心合并', () => {
    const paragraph = '中'.repeat(80) + '\n\n'
    expect(check(paragraph.repeat(10))).toEqual([paragraph.repeat(6), paragraph.repeat(4)])
  })

  it.each(['# 标题', '###### 标题', '- 项目', '  * 项目', '+ 项目', '12. 项目'])('在标题或列表项%s之前划出块边界', marker => {
    const first = '中'.repeat(300) + '\n'
    const second = marker + '\n' + '中'.repeat(300)
    expect(check(first + second)).toEqual([first, second])
  })

  it('混合计价在取整边缘仍尽量装满', () => {
    const full = '中'.repeat(499) + 'ab'
    expect(check(full + '中')).toEqual([full, '中'])
  })

  it('约九百 token 的段落只在完整句子之后切段', () => {
    // 每句 70 字，七句一段还剩 10 字的余量：按码点硬切会切在句子中间
    const sentence = '中'.repeat(69) + '。'
    expect(check(sentence.repeat(21))).toEqual([sentence.repeat(7), sentence.repeat(7), sentence.repeat(7)])
  })

  it('句末引号括号和空白归前句，版本号中的点不切句', () => {
    const sentence = '中'.repeat(240) + '。”） \t\r\n'
    expect(check(sentence.repeat(4))).toEqual([sentence.repeat(2), sentence.repeat(2)])
    // 版本号里的点后面不是空白：整串没有句界，只能按码点切，版本号完整留在第一段
    const head = 'a'.repeat(990) + ' v1.'
    expect(check(head + '2.3 ' + 'b'.repeat(500))).toEqual([head + '2.3 bb', 'b'.repeat(498)])
  })

  it('下一行开头的引号和缩进留给下一句，连着的句末标点归同一句，回车换行不劈开', () => {
    const line = '中'.repeat(300)
    expect(check(line + '\n"' + line + '"')).toEqual([line + '\n', '"' + line + '"'])
    expect(check(line + '\n   ' + line)).toEqual([line + '\n', '   ' + line])
    expect(check('中'.repeat(498) + '！？' + line)).toEqual(['中'.repeat(498) + '！？', line])
    for (const seg of check('a'.repeat(999) + '\r\n'.repeat(1000))) expect(seg).not.toMatch(/\r$|^\n/)
    for (const seg of check('a'.repeat(999) + '\r\n' + 'a'.repeat(999))) expect(seg).not.toMatch(/\r$|^\n/)
  })

  it('行首的三反引号行内代码不当成围栏，后面的正文照常按句切', () => {
    const sentence = '中'.repeat(69) + '。'
    const segments = check('```foo``` 是行内代码。\n\n' + sentence.repeat(21))
    for (const seg of segments.slice(0, -1)) expect(seg.endsWith('。') || seg.endsWith('\n')).toBe(true)
  })

  it.each(['。', '！', '？', '!', '?', '；', ';', '. ', '\n'])('在句末符号%s之后切段', end => {
    const sentence = '中'.repeat(300) + end
    expect(check(sentence.repeat(3))).toEqual(Array(3).fill(sentence))
  })

  it('无标点的三千汉字和超长单行代码按码点装满', () => {
    expect(check('中'.repeat(3000)).map(s => s.length)).toEqual(Array(6).fill(500))
    expect(check('```\n' + 'a'.repeat(10000) + '\n```').map(s => s.length)).toEqual([4, ...Array(10).fill(1000), 4])
    expect(check('a'.repeat(10000)).map(s => s.length)).toEqual(Array(10).fill(1000))
  })

  it('长串代理对在段首段尾都不被拆开', () => {
    for (const seg of check('😀𠮷'.repeat(3000))) {
      expect(seg).toBe(Array.from(seg).join(''))
      expect(seg).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/)
    }
  })

  it.each(['```\n代码\n\n代码\n```\n', '~~~ts\n代码\n~~~\n', '| 表头 |\n| --- |\n| 内容 |\n'])('不超长的代码或表格整体保留：%s', block => {
    // 前文留下的余量装不下整块：逐行装的话块的开头会被并进前一段
    const text = '中'.repeat(495) + '\n' + block + '中'.repeat(490)
    expect(check(text).some(s => s.includes(block))).toBe(true)
  })

  // 行中间有分号加空格：按句切会切在行内
  it.each(['```\n' + ('a'.repeat(48) + '; ' + 'b'.repeat(42) + '\n').repeat(40) + '```', ('| ' + 'a'.repeat(46) + '; ' + 'b'.repeat(40) + ' |\n').repeat(40)])('超长代码或表格只在行末切段', text => {
    const segments = check(text)
    expect(segments.length).toBeGreaterThan(1)
    for (const segment of segments.slice(0, -1)) expect(segment.endsWith('\n')).toBe(true)
  })

  it('未闭合围栏及围栏内的标题列表空行都无损保留', () => {
    check('```\n' + '# 标题\n- 列表\n\n~~~\n'.repeat(150))
    const block = '````ts\n```\n\n# 标题\n- 列表\n````\n'
    expect(check('中'.repeat(490) + '\n' + block + '中'.repeat(490)).some(s => s.includes(block))).toBe(true)
  })

  it('相同输入逐段返回相同结果', () => {
    for (const [, text] of samples) expect(splitIntoSegments(text)).toEqual(splitIntoSegments(text))
  })

  // 这里的期望值变了，说明切分结果变了，必须同时把 SEGMENT_RULE_VERSION 加一并更新期望值。
  it('固定输入的各段长度守住切分规则版本', () => {
    expect(SEGMENT_RULE_VERSION).toBe(1)
    const fixtures: [string, number[]][] = [
      ['', [0]],
      ['中'.repeat(500), [500]],
      ['a'.repeat(1001), [1000, 1]],
      ['😀'.repeat(1001), [2000, 2]],
      [('中'.repeat(80) + '\n\n').repeat(10), [492, 328]],
      [('中'.repeat(99) + '。').repeat(15), [500, 500, 500]],
      ['\r\n'.repeat(1001), [1000, 1000, 2]],
      ['# 一\n' + '中'.repeat(300) + '\n# 二\n' + '中'.repeat(300), [305, 304]],
    ]
    for (const [text, lengths] of fixtures) expect(check(text).map(s => s.length)).toEqual(lengths)
  })

  it('固定种子的两百条混合消息都无损、不超限且无空段', () => {
    let seed = 1729
    const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0)
    const parts = ['中文', 'abc', '😀', '𠮷', '\n\n', '\r\n', ' \t', '。', '!?', '。”）', 'v1.2', '# 标题\n', '- 项目\n', '```\n', '~~~\n', '| 单元 |\n', '\ud800', '\udc00']
    for (let i = 0; i < 200; i++) {
      let text = ''
      const count = next() % 1000
      for (let j = 0; j < count; j++) text += parts[next() % parts.length]
      check(text)
    }
  })
})
