import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { matchWindow } from '../src/search/window.ts'
import { SECRET_MASK } from '../src/secrets.ts'

// 命中窗口：从一条长记忆里取命中词附近的一段，由完整的行或句子组成。
// 这里用很小的目标长度和硬上限，让例子一眼能数清；生产取值在检索执行器旁的常量里。

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

/** 窗口首尾不落在占位文字中间：去掉完整的占位后，不剩任何属于占位的字符（生成正文的其余片段都不含这些字符）。 */
const maskRemnants = (text: string) => [...text.split(SECRET_MASK).join('')].filter(ch => SECRET_MASK.includes(ch))

describe('不超过硬上限', () => {
  it('原样返回，两侧都无省略', () => {
    const content = '短记忆。\n\n第二行'
    expect(matchWindow(content, ['第二'], 5, 30)).toEqual({ text: content, hasBefore: false, hasAfter: false })
  })
})

describe('切单元', () => {
  it('窗口首尾落在句子边界上，全角、半角句末标点都切', () => {
    const content = 'Alpha one. Bravo two。Charlie needle. Delta four！Echo five; Foxtrot six.'
    expect(matchWindow(content, ['needle'], 30, 40)).toEqual({ text: 'Charlie needle. Delta four！', hasBefore: true, hasAfter: true })
  })

  it('版本号、文件名、网址里的半角点不切开句子', () => {
    const first = 'Upgrade to v1.2.3 then edit config.yaml at https://example.com/a.b now.'
    const content = `${first} Other stuff here that is long enough to matter for the hard limit.`
    expect(matchWindow(content, ['config'], 20, 100).text).toBe(first)
  })

  it('中英文标点混排', () => {
    const content = '先跑 pnpm test。Then run lint. 最后推送！Done and dusted with everything here.'
    expect(matchWindow(content, ['lint'], 5, 50).text).toBe('Then run lint.')
  })

  it('兼容 CRLF，只有空白的行不成单元，节选不含空行', () => {
    const content = 'aaaa1\r\n\r\n   \r\nneedle\r\n\t\r\nbbbb2\r\n\r\ncccc3\r\ndddd4\r\neeee5'
    const w = matchWindow(content, ['needle'], 20, 30)
    expect(w.text).toBe('aaaa1\nneedle\nbbbb2')
    expect(w.text).not.toMatch(/\r|\n\s*\n/)
  })

  it('列表项按行成单元，保留项目符号', () => {
    const content = '- first item\n- second needle item\n- third item\n- fourth item'
    expect(matchWindow(content, ['needle'], 20, 30)).toEqual({ text: '- second needle item', hasBefore: true, hasAfter: true })
  })
})

describe('选中心单元', () => {
  it('命中词分散时，中心落在覆盖不同命中词最多的单元', () => {
    const content = 'alpha only here\nbeta and gamma together\nalpha beta gamma all three\ngamma alone'
    expect(matchWindow(content, ['alpha', 'beta', 'gamma'], 10, 30).text).toBe('alpha beta gamma all three')
  })

  it('并列时偏向本条正文里出现最少的命中词，而不是最靠前的', () => {
    const content = 'log line one\nlog line two\ncrash happened\nlog line three\nlog again'
    expect(matchWindow(content, ['log', 'crash'], 10, 30).text).toBe('crash happened')
  })

  it('覆盖与稀有度都并列时取最靠前的', () => {
    const content = 'first needle here\nsecond needle here\nthird line here'
    expect(matchWindow(content, ['needle'], 10, 30).text).toBe('first needle here')
  })

  it('正文里找不到命中词时取第一个单元', () => {
    const content = 'opening line\nmiddle line\nclosing line here'
    expect(matchWindow(content, ['absent'], 5, 30)).toEqual({ text: 'opening line', hasBefore: false, hasAfter: true })
    expect(matchWindow(content, [], 5, 30).text).toBe('opening line')
  })

  it('命中词定位不区分大小写', () => {
    const content = 'opening line\nRun Deploy Now\nclosing line here'
    expect(matchWindow(content, ['deploy'], 5, 30).text).toBe('Run Deploy Now')
  })
})

describe('向两边扩展', () => {
  const content = 'aaaa1\nbbbb2\ncccc3\ndddd4\neeee5\nffff6'

  it('先后再前，加进去超过目标长度就停', () => {
    expect(matchWindow(content, ['cccc'], 14, 30)).toEqual({ text: 'cccc3\ndddd4', hasBefore: true, hasAfter: true })
    expect(matchWindow(content, ['cccc'], 20, 30).text).toBe('bbbb2\ncccc3\ndddd4')
  })

  it('一侧到头时另一侧继续', () => {
    expect(matchWindow(content, ['ffff'], 20, 30)).toEqual({ text: 'dddd4\neeee5\nffff6', hasBefore: true, hasAfter: false })
    expect(matchWindow(content, ['aaaa'], 20, 30)).toEqual({ text: 'aaaa1\nbbbb2\ncccc3', hasBefore: false, hasAfter: true })
  })

  it('中心单元在目标长度和硬上限之间时整个保留、不扩展', () => {
    const long = 'needle sits in this long line'
    const w = matchWindow(`aa\n${long}\nbb\ncc`, ['needle'], 20, 30)
    expect(long.length).toBeGreaterThan(20)
    expect(w.text).toBe(long)
  })
})

describe('硬上限兜底', () => {
  it('没有标点的长段按字符硬切，窗口对着命中词居中，长度不超过硬上限', () => {
    const content = `${'x'.repeat(60)}needle${'y'.repeat(34)}`
    expect(matchWindow(content, ['needle'], 20, 30))
      .toEqual({ text: `${'x'.repeat(12)}needle${'y'.repeat(12)}`, hasBefore: true, hasAfter: true })
  })

  it('取不同命中词最多的一段，对着其中的命中段居中', () => {
    const content = `${'a'.repeat(10)}foo${'b'.repeat(40)}foo-bar${'c'.repeat(50)}`
    // 命中段是 foo-bar（7 字），两边各留 11 或 12 字上下文
    expect(matchWindow(content, ['foo', 'bar'], 20, 30).text).toBe(`${'b'.repeat(12)}foo-bar${'c'.repeat(11)}`)
  })

  it('居中时夹在单元范围内：命中词靠近单元末尾时窗口贴着末尾', () => {
    const content = `${'x'.repeat(60)}needle${'y'.repeat(4)}`
    expect(matchWindow(content, ['needle'], 20, 30)).toEqual({ text: content.slice(-30), hasBefore: true, hasAfter: false })
  })

  it('没有命中词时从单元开头取', () => {
    const content = 'z'.repeat(100)
    expect(matchWindow(content, ['absent'], 20, 30)).toEqual({ text: 'z'.repeat(30), hasBefore: false, hasAfter: true })
  })

  it('不切开代理对', () => {
    const content = `a${'😀'.repeat(50)}`
    const w = matchWindow(content, [], 20, 30)
    expect(w.text.length).toBeLessThanOrEqual(30)
    expect(w.text).not.toMatch(LONE_SURROGATE)
  })

  it('不切开密钥遮盖的占位文字（末端）', () => {
    const content = `${'a'.repeat(26)}${SECRET_MASK}${'b'.repeat(70)}`
    expect(matchWindow(content, [], 20, 30).text).toBe('a'.repeat(26))
  })

  it('不切开密钥遮盖的占位文字（始端）', () => {
    // 居中后起点在 needle 前 12 字处；占位与 needle 之间隔 gap 字，让这一点正好落在占位文字中间，起点向内退到占位之后
    const gap = 12 - Math.ceil(SECRET_MASK.length / 2)
    const content = `${'x'.repeat(40)}${SECRET_MASK}${'z'.repeat(gap)}needle${'y'.repeat(50)}`
    expect(matchWindow(content, ['needle'], 20, 30).text).toBe(`${'z'.repeat(gap)}needle${'y'.repeat(12)}`)
  })
})

describe('任意正文', () => {
  it('节选不超过硬上限、不含空行、不切开代理对，原文不超过硬上限时原样返回', () => {
    const piece = fc.constantFrom('needle', 'Needle', '。', '. ', '\r\n', '\n', '  ', '😀', SECRET_MASK, 'v1.2', '文字', 'word ', '；', '! ')
    fc.assert(fc.property(fc.array(piece, { maxLength: 80 }), fc.integer({ min: 5, max: 40 }), fc.integer({ min: 0, max: 40 }), (parts, target, extra) => {
      const content = parts.join('')
      const max = target + extra
      const w = matchWindow(content, ['needle', 'word'], target, max)
      if (content.length <= max) {
        expect(w).toEqual({ text: content, hasBefore: false, hasAfter: false })
        return
      }
      expect(w.text.length).toBeLessThanOrEqual(max)
      expect(w.text).not.toMatch(/\n\s*\n|\r/)
      expect(w.text).not.toMatch(LONE_SURROGATE)
      expect(maskRemnants(w.text)).toEqual([])
    }))
  })

  it('单行无标点正文上，硬切选中的不同命中词数等于逐个起点枚举的最优值，且不切开占位文字', () => {
    // 命中词都没有自身首尾重叠（如 aa），逐个位置找和按不重叠匹配找到的出现是同一批。
    // 占位文字与命中词不重叠，切点退出占位只会让窗口变短，不会丢掉命中段
    const terms = ['foo', 'bar', 'baz']
    const piece = fc.constantFrom('foo', 'FOO', 'fo', 'o', 'ba', 'r', 'bar', 'baz', 'z', 'x', '-', SECRET_MASK)
    const distinctIn = (text: string) => terms.filter(t => text.toLowerCase().includes(t)).length
    fc.assert(fc.property(fc.array(piece, { maxLength: 60 }), fc.integer({ min: 5, max: 20 }), fc.integer({ min: 0, max: 20 }), (parts, target, extra) => {
      const content = parts.join('')
      const max = target + extra
      if (content.length <= max) return
      let best = 0
      for (let s = 0; s + max <= content.length; s++) best = Math.max(best, distinctIn(content.slice(s, s + max)))
      const w = matchWindow(content, terms, target, max)
      expect(w.text.length).toBeLessThanOrEqual(max)
      expect(distinctIn(w.text)).toBe(best)
      expect(maskRemnants(w.text)).toEqual([])
    }))
  })
})
