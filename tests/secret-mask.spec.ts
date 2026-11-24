import vm from 'node:vm'
import { analyse } from 'scslre'
import { describe, expect, it, vi } from 'vitest'
import {
  detectSecrets, maskSecrets, maskSecretSurface, SECRET_MASK, hasSecret, secretFields, secretValues,
  SECRET_PATTERNS, PASSWORD_LABEL, PASSWORD_VALUE, NON_SPACE, JWT, JWT_START,
} from '../src/secrets.ts'
import { FAKE_SECRET, generatePrivateKeyPem } from './helpers/secrets.ts'

describe('maskSecrets：只换命中片段', () => {
  it('疑似密码不遮：写入时用户已确认不是密钥才放行', () => {
    expect(maskSecrets('服务器密码: Abc12345 周五前改')).toBe('服务器密码: Abc12345 周五前改')
  })

  it('sk- key：只遮 key 本身', () => {
    expect(maskSecrets(`测试用 key 是 ${FAKE_SECRET.sk}，别外传`)).toBe(`测试用 key 是 ${SECRET_MASK}，别外传`)
  })

  it('同一段文字里多处、多种命中全部遮住', () => {
    const text = `${FAKE_SECRET.sk} 和 ${FAKE_SECRET.github}，还有 ${FAKE_SECRET.skProj}`
    expect(maskSecrets(text)).toBe(`${SECRET_MASK} 和 ${SECRET_MASK}，还有 ${SECRET_MASK}`)
  })

  it('无命中原样返回', () => {
    const text = '密码:公司统一走单点登录；部署用 sk-short'
    expect(maskSecrets(text)).toBe(text)
  })
})

describe('maskSecretSurface：四个面按片段遮盖', () => {
  const surface = { content: '内容', name: '条目', summary: '摘要', tags: [] as string[] }

  it('各字段分别遮住自己的命中片段', () => {
    const masked = maskSecretSurface({ ...surface, content: `key ${FAKE_SECRET.sk} 在用`, tags: ['部署', FAKE_SECRET.github] })
    expect(masked.content).toBe(`key ${SECRET_MASK} 在用`)
    expect(masked.tags).toEqual(['部署', SECRET_MASK])
    expect(masked.name).toBe('条目')
  })

  it('跨字段拼接才命中：两边落在命中区间里的部分都遮住', () => {
    const r = { ...surface, summary: '认证头 Bearer', tags: ['TESTONLYabcdefghijklmnop', '运维'] }
    expect(hasSecret(r)).toBe(true)
    const masked = maskSecretSurface(r)
    expect(masked.summary).toBe(`认证头 ${SECRET_MASK}`)
    expect(masked.tags).toEqual([SECRET_MASK, '运维'])
    expect(hasSecret(masked)).toBe(false)
  })

  it('只命中疑似规则返回原对象', () => {
    const r = { ...surface, content: '预发库密码: Abc12345', summary: '数据库的 api_key: 1234567890abcdef' }
    expect(maskSecretSurface(r)).toBe(r)
  })

  it('无命中返回原对象', () => {
    const r = { ...surface, id: 'mem_x' }
    expect(maskSecretSurface(r)).toBe(r)
  })
})

describe('severity: suspected：疑似密钥也遮（对话卡用），缺省口径不变', () => {
  const text = '部署账号 password: Hunter2-2026，api_key=abcdef1234567890abcd 也在这'

  it('maskSecrets 遮住疑似密码与 api_key 赋值，critical 照遮', () => {
    const masked = maskSecrets(`${text}；${FAKE_SECRET.sk}`, { severity: 'suspected' })
    expect(masked).not.toContain('Hunter2-2026')
    expect(masked).not.toContain('abcdef1234567890abcd')
    expect(masked).not.toContain(FAKE_SECRET.sk)
    expect(masked).toContain('部署账号')
    expect(maskSecrets(text)).toBe(text)
    expect(maskSecrets(text, { severity: 'critical' })).toBe(text)
  })

  it('maskSecretSurface 同样按选项放宽；缺省时只命中疑似规则仍返回原对象', () => {
    const r = { content: '登录用 password: Hunter2-2026', name: '账号', summary: '', tags: [] as string[] }
    expect(maskSecretSurface(r, { severity: 'suspected' }).content).toBe(`登录用 ${SECRET_MASK}`)
    expect(maskSecretSurface(r)).toBe(r)
  })
})

describe('PEM 私钥块：从 BEGIN 到对应的 END 整块遮住', () => {
  const { pem, bodyLines } = generatePrivateKeyPem()

  it('整块换成一个占位，前后文字原样；两级口径一样', () => {
    const text = `部署机私钥：\n${pem}\n用完删掉`
    for (const severity of ['critical', 'suspected'] as const) {
      expect(maskSecrets(text, { severity })).toBe(`部署机私钥：\n${SECRET_MASK}\n用完删掉`)
    }
  })

  it('截断的粘贴（没有 END 行）遮到文本末尾', () => {
    const truncated = pem.split('\n').slice(0, 2).join('\n')
    expect(maskSecrets(`前文 ${truncated}`)).toBe(`前文 ${SECRET_MASK}`)
  })

  it('截断的粘贴：BEGIN 行之后紧跟的正文行（base64、头字段、其间的空行）都遮住，正文之后的文字原样', () => {
    const lines = pem.split('\n')
    const truncated = [lines[0], 'Proc-Type: 4,ENCRYPTED', '', ...lines.slice(1, -1)].join('\n')
    expect(maskSecrets(`前文\n${truncated}\n\n用完删掉`)).toBe(`前文\n${SECRET_MASK}\n\n用完删掉`)
  })

  it('散文里提到 BEGIN 头（没有 END 行）：只遮到这一行行尾，后面几行原样', () => {
    const text = `- 以 ${FAKE_SECRET.pem} 开头的文件不要提交\n- 包管理用 pnpm\n- 提交前跑测试`
    expect(maskSecrets(text)).toBe(`- 以 ${SECRET_MASK}\n- 包管理用 pnpm\n- 提交前跑测试`)
  })

  it('散文里提到 BEGIN 头、后文才有同类型的真实私钥：中间的文字原样，真实私钥整块遮住', () => {
    const begin = pem.split('\n')[0]
    const text = `- 以 ${begin} 开头的文件不要提交\n- 包管理用 pnpm\n- 提交前跑测试\n部署机私钥：\n${pem}\n用完删掉`
    expect(maskSecrets(text)).toBe(`- 以 ${SECRET_MASK}\n- 包管理用 pnpm\n- 提交前跑测试\n部署机私钥：\n${SECRET_MASK}\n用完删掉`)
  })

  it('整块缩进（列表、引用里的私钥）照样整块遮住', () => {
    const indented = pem.split('\n').map(line => `    ${line}`).join('\n')
    const masked = maskSecrets(`部署机私钥：\n${indented}\n用完删掉`)
    expect(masked).toBe(`部署机私钥：\n    ${SECRET_MASK}\n用完删掉`)
    for (const line of bodyLines) expect(masked).not.toContain(line)
  })

  it('正文行带行尾空白（空格、制表符、CRLF）照样整块遮住', () => {
    const { pem, bodyLines } = generatePrivateKeyPem('rsa')
    for (const eol of ['  \n', '\t\n', ' \r\n']) {
      const padded = pem.split('\n').join(eol)
      const masked = maskSecrets(`部署机私钥：\n${padded}${eol}用完删掉`)
      expect(masked).toBe(`部署机私钥：\n${SECRET_MASK}${eol}用完删掉`)
      for (const line of bodyLines) expect(masked).not.toContain(line)
    }
  })

  it('整块在 Markdown 引用里（> 、>> 前缀）照样整块遮住，引用之后的文字原样', () => {
    const { pem, bodyLines } = generatePrivateKeyPem('rsa')
    for (const quote of ['> ', '>> ', '>']) {
      const quoted = pem.split('\n').map(line => `${quote}${line}`).join('\n')
      const masked = maskSecrets(`部署机私钥：\n${quoted}\n用完删掉`)
      expect(masked).toBe(`部署机私钥：\n${quote}${SECRET_MASK}\n用完删掉`)
      for (const line of bodyLines) expect(masked).not.toContain(line)
    }
  })

  it('引用里截断的粘贴：紧跟的正文行（含引用里的空行）都遮住，后面的引用文字原样', () => {
    const lines = pem.split('\n')
    const truncated = [lines[0], 'Proc-Type: 4,ENCRYPTED', '', ...lines.slice(1, -1)].map(line => `> ${line}`.trimEnd()).join('\n')
    const masked = maskSecrets(`前文\n${truncated}\n> 用完删掉`)
    expect(masked).toBe(`前文\n> ${SECRET_MASK}\n> 用完删掉`)
  })

  it('引用里散文提到 BEGIN 头：只遮到这一行行尾，后面的引用文字原样', () => {
    const text = `> 以 ${FAKE_SECRET.pem} 开头的文件不要提交\n> 包管理用 pnpm\n> 提交前跑测试`
    expect(maskSecrets(text)).toBe(`> 以 ${SECRET_MASK}\n> 包管理用 pnpm\n> 提交前跑测试`)
  })

  it('两块私钥各遮各的，中间的文字保留', () => {
    expect(maskSecrets(`A：${pem}\n以及 B：${pem}`)).toBe(`A：${SECRET_MASK}\n以及 B：${SECRET_MASK}`)
  })

  it('检测口径不变：仍是 critical', () => {
    expect(detectSecrets(pem)).toEqual([{ name: 'PEM 私钥块', severity: 'critical' }])
  })

  it('maskSecretSurface：正文里截断的私钥只遮到正文末尾，name、summary、tags 不动', () => {
    const truncated = pem.split('\n').slice(0, 2).join('\n')
    const masked = maskSecretSurface({ content: `私钥 ${truncated}`, name: '部署机', summary: '部署机凭证', tags: ['ssh', '运维'] })
    expect(masked).toEqual({ content: `私钥 ${SECRET_MASK}`, name: '部署机', summary: '部署机凭证', tags: ['ssh', '运维'] })
  })

  it('maskSecretSurface：一个字段自己命中、另有跨字段拼接才命中的，两处都遮', () => {
    const truncated = pem.split('\n').slice(0, 2).join('\n')
    const r = { content: `私钥 ${truncated}`, name: '部署机', summary: '认证头 Bearer', tags: ['TESTONLYabcdefghijklmnop', '运维'] }
    expect(maskSecretSurface(r)).toEqual({ content: `私钥 ${SECRET_MASK}`, name: '部署机', summary: `认证头 ${SECRET_MASK}`, tags: [SECRET_MASK, '运维'] })
  })

  it('PA-12 BEGIN 行在 name、正文和 END 行在 summary：两处都遮，summary 里不剩私钥正文', () => {
    const [begin, ...rest] = pem.split('\n')
    const r = { content: '部署说明', name: begin, summary: rest.join('\n'), tags: ['ssh'] }
    const masked = maskSecretSurface(r)
    for (const line of bodyLines) expect(JSON.stringify(masked)).not.toContain(line)
    expect(masked).toMatchObject({ content: '部署说明', name: SECRET_MASK, tags: ['ssh'] })
    expect(secretFields(r)).toEqual(['name', 'summary'])
  })

  it('PA-12 secretFields：自身命中的字段加上跨字段区间覆盖到的字段，别的字段不算；疑似级也算', () => {
    const truncated = pem.split('\n').slice(0, 2).join('\n')
    expect(secretFields({ content: `私钥 ${truncated}`, name: '部署机', summary: '认证头 Bearer', tags: ['TESTONLYabcdefghijklmnop', '运维'] }))
      .toEqual(['content', 'summary', 'tags'])
    expect(secretFields({ content: '干净正文', name: '数据库', summary: '认证头 Bearer', tags: ['TESTONLYabcdefghijklmnop'] })).toEqual(['summary', 'tags'])
    expect(secretFields({ content: '干净正文', name: '数据库', summary: 'api_key: TESTONLY0000000000000', tags: [] })).toEqual(['summary'])
    expect(secretFields({ content: '干净正文', name: '数据库', summary: '没有密钥', tags: [] })).toEqual([])
  })

  it('maskSecretSurface：正文里的私钥整块遮住，其他字段不动', () => {
    const masked = maskSecretSurface({ content: `私钥\n${pem}\n别外传`, name: '部署机', summary: '部署机凭证', tags: ['ssh'] })
    expect(masked).toEqual({ content: `私钥\n${SECRET_MASK}\n别外传`, name: '部署机', summary: '部署机凭证', tags: ['ssh'] })
    for (const line of bodyLines) expect(JSON.stringify(masked)).not.toContain(line)
  })
})

describe('PGP 私钥块：同 PEM，从 BEGIN 到对应的 END 整块遮住', () => {
  const begin = ['-----BEGIN', 'PGP PRIVATE KEY BLOCK-----'].join(' ')
  const end = ['-----END', 'PGP PRIVATE KEY BLOCK-----'].join(' ')
  const body = ['Version: TESTONLY', '', 'lQOYBGTESTONLYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', '=TEST']

  it('整块换成一个占位，critical 级', () => {
    const block = [begin, ...body, end].join('\n')
    expect(detectSecrets(block)).toEqual([{ name: 'PGP 私钥块', severity: 'critical' }])
    expect(maskSecrets(`签名私钥：\n${block}\n用完删掉`)).toBe(`签名私钥：\n${SECRET_MASK}\n用完删掉`)
  })

  it('截断的粘贴（没有 END 行）遮到正文末尾', () => {
    expect(maskSecrets(`前文\n${[begin, ...body].join('\n')}\n后文`)).toBe(`前文\n${SECRET_MASK}\n后文`)
  })

  it('引用里、行尾带空格的整块照样整块遮住', () => {
    const block = [begin, ...body, end].map(line => `> ${line}  `).join('\n')
    expect(maskSecrets(`签名私钥：\n${block}\n用完删掉`)).toBe(`签名私钥：\n> ${SECRET_MASK}  \n用完删掉`)
  })

  for (const [desc, ws] of [['NBSP', '\u00A0'], ['全角空格', '\u3000']] as const) {
    it(`每行行首带${desc}（头字段行、base64 行都有）：照样整块遮住，正文不露`, () => {
      const block = [begin, ...body, end].map(line => `${ws}${line}`).join('\n')
      const masked = maskSecrets(`签名私钥：\n${block}\n用完删掉`)
      expect(masked).toBe(`签名私钥：\n${ws}${SECRET_MASK}\n用完删掉`)
      expect(masked).not.toContain(body[2])
    })

    it(`截断的粘贴、行首带${desc}：紧跟的头字段行和 base64 行都遮住`, () => {
      const lines = [begin, ...body].map(line => `${ws}${line}`)
      expect(maskSecrets(`前文\n${lines.join('\n')}\n后文`)).toBe(`前文\n${ws}${SECRET_MASK}\n后文`)
    })
  }

  // 网页、富文本复制来的 NBSP，中文输入法打出的全角空格，换页符
  for (const [desc, ws] of [['NBSP', '\u00A0'], ['全角空格', '\u3000'], ['换页符', '\f']] as const) {
    it(`头字段行尾带${desc}：照样整块遮住，正文不露`, () => {
      const block = [begin, `Version: TESTONLY${ws}`, ...body.slice(1), end].join('\n')
      const masked = maskSecrets(`签名私钥：\n${block}\n用完删掉`)
      expect(masked).toBe(`签名私钥：\n${SECRET_MASK}\n用完删掉`)
      expect(masked).not.toContain(body[2])
    })

    it(`base64 正文行行尾带${desc}：照样整块遮住，后面的正文不露`, () => {
      const block = [begin, body[0], body[1], `${body[2]}${ws}`, body[3], end].join('\n')
      const masked = maskSecrets(`签名私钥：\n${block}\n用完删掉`)
      expect(masked).toBe(`签名私钥：\n${SECRET_MASK}\n用完删掉`)
      expect(masked).not.toContain(body[3])
    })
  }
})

/** 防卡死的限时，不是性能阈值：正常几毫秒跑完，只有回溯失控才会碰到。 */
const TIME_LIMIT_MS = 2000

/** 在 vm 上下文里限时执行 fn：正则是同步的，回溯失控时由 vm 的 timeout 打断、用例报错，而不是整个测试进程卡住。 */
function withinTimeLimit<T>(fn: () => T): T {
  return vm.runInContext('run()', vm.createContext({ run: fn }), { timeout: TIME_LIMIT_MS }) as T
}

describe('私钥块正则：行尾带空白的头字段、没有 END 行时不回溯爆炸', () => {
  const pgpBegin = ['-----BEGIN', 'PGP PRIVATE KEY BLOCK-----'].join(' ')
  const headers = (trailing: string) => `Note: something here${trailing}\n`.repeat(30)

  for (const [label, begin] of [['PEM', FAKE_SECRET.pem], ['PGP', pgpBegin]] as const) {
    for (const [desc, trailing] of [['一个空格', ' '], ['两个空格', '  '], ['NBSP', '\u00A0'], ['全角空格', '\u3000 ']] as const) {
      it(`${label}：BEGIN 后 30 行头字段、行尾${desc}，检测和遮盖在限时内跑完，头字段照样遮住`, () => {
        const text = `前文\n${begin}\n${headers(trailing)}（后面省略）`
        expect(withinTimeLimit(() => detectSecrets(text))).toEqual([{ name: `${label} 私钥块`, severity: 'critical' }])
        expect(withinTimeLimit(() => maskSecrets(text))).toBe(`前文\n${SECRET_MASK}\n（后面省略）`)
      })
    }

    it(`${label}：BEGIN 后 30 行头字段、行首行尾都是 NBSP，检测和遮盖在限时内跑完，头字段照样遮住`, () => {
      const text = `前文\n${begin}\n${`\u00A0Note: something here\u00A0\n`.repeat(30)}（后面省略）`
      expect(withinTimeLimit(() => detectSecrets(text))).toEqual([{ name: `${label} 私钥块`, severity: 'critical' }])
      expect(withinTimeLimit(() => maskSecrets(text))).toBe(`前文\n${SECRET_MASK}\n（后面省略）`)
    })
  }
})

describe('密钥正则静态检查：没有超线性回溯', () => {
  // 只查得出单个字符重复构成的攻击串（如私钥块头字段的值和行尾空白抢同一批空格）；多字符重复（如标签连写）查不出，
  // 由下面逐字读取计数的用例兜着。规则正则在遮盖时会加 g 重建，不按「原样使用」推断能否构造出失败后缀，一律当可构造
  const regexes: Array<[name: string, re: RegExp]> = [
    ...SECRET_PATTERNS.flatMap((p): Array<[string, RegExp]> => ('re' in p ? [[p.name, p.re]] : [])),
    ['PASSWORD_LABEL', PASSWORD_LABEL],
    ['PASSWORD_VALUE', PASSWORD_VALUE],
    ['NON_SPACE', NON_SPACE],
    ['JWT', JWT],
    ['JWT_START', JWT_START],
  ]

  for (const [name, re] of regexes) {
    it(`${name}：静态分析不报超线性回溯`, () => {
      const { reports } = analyse(re, { assumeRejectingSuffix: true })
      expect(reports.map(r => ({ type: r.type, exponential: r.exponential, char: r.character.pick }))).toEqual([])
    })
  }
})

/** fn 执行期间逐字读取（charCodeAt）的次数。只计 JS 层的逐字读取，正则引擎内部的读取量不在内。 */
function countReads(fn: () => unknown): number {
  const spy = vi.spyOn(String.prototype, 'charCodeAt')
  try {
    fn()
    return spy.mock.calls.length
  } finally {
    spy.mockRestore()
  }
}

/** 固定种子的伪随机数，[0, 1)。 */
const seeded = (seed: number) => () => {
  seed = (seed + 0x6D2B79F5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), seed | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

describe('逐标签执行的正则：不带往后扫的断言', () => {
  // 取值正则每个标签跑一次：带上 (?=\S*…) 这类往后扫到段尾的断言，标签连写时就是平方级，逐字读取计数和静态分析都看不出
  for (const [name, re] of [['PASSWORD_VALUE', PASSWORD_VALUE], ['NON_SPACE', NON_SPACE]] as const) {
    it(`${name}：没有前瞻、后顾`, () => {
      expect(re.source).not.toMatch(/\(\?<?[=!]/)
    })
  }
})

describe('四个面一起遮盖：命中再多也在限时内跑完', () => {
  it('正文里十万处互不相接的命中：逐处遮住，其余字段不动', () => {
    const times = 100_000
    const r = { content: 'pwd=abc123 '.repeat(times), name: '名称', summary: '摘要', tags: ['标签'] }
    const masked = withinTimeLimit(() => maskSecretSurface(r, { severity: 'suspected' }))
    expect(masked).toEqual({ ...r, content: `${SECRET_MASK} `.repeat(times) })
    expect(withinTimeLimit(() => secretFields(r))).toEqual(secretFields({ ...r, content: 'pwd=abc123 ' }))
  })
})

describe('硬编码密码：标签再多，取值检查也只把每段字符读一遍', () => {
  const suspected = { severity: 'suspected' } as const

  for (const [label, sep] of [['密码', ':'], ['pwd', '='], ['PASSWORD', '：']] as const) {
    for (const times of [500, 2000]) {
      it(`${label}${sep} 连写 ${times} 遍、后面一长串没有数字：不命中，从第一个取值起点读到段尾恰好一遍`, () => {
        const prefix = `${label}${sep}`
        const text = prefix.repeat(times) + 'a'.repeat(times * 4)
        const once = text.length - prefix.length
        expect(countReads(() => expect(detectSecrets(text)).toEqual([]))).toBe(once)
        expect(countReads(() => expect(maskSecrets(text, suspected)).toBe(text))).toBe(once)
        expect(countReads(() => expect(secretValues(text, suspected)).toEqual([]))).toBe(once)
      })
    }
  }

  it('连写的标签后面有数字：整段只命中一处，取值是第一个标签之后的整段', () => {
    const text = `${'pwd='.repeat(2000)}${'a'.repeat(4000)}1`
    expect(countReads(() => expect(detectSecrets(text)).toEqual([{ name: '硬编码密码', severity: 'suspected' }]))).toBe(text.length - 4)
    expect(secretValues(text, suspected)).toEqual([text.slice(4)])
    expect(maskSecrets(text, suspected)).toBe(SECRET_MASK)
  })

  it('很多段、每段多个标签都不命中：每个字符至多读一遍', () => {
    const text = `${'pwd='.repeat(5)}${'b'.repeat(20)} `.repeat(1000)
    const reads = countReads(() => expect(maskSecrets(text, suspected)).toBe(text))
    expect(reads).toBeGreaterThan(0)
    expect(reads).toBeLessThanOrEqual(text.length)
  })

  it('取值太短（中日韩字符前不足 6 个）、数字远在段尾：每个标签都不命中，每个字符至多读一遍', () => {
    const text = `${'pwd=ab中'.repeat(2000)}1`
    const reads = countReads(() => expect(secretValues(text, suspected)).toEqual([]))
    expect(reads).toBeGreaterThan(0)
    expect(reads).toBeLessThanOrEqual(text.length)
  })
})

describe('硬编码密码：命中、取值、遮盖与逐处正则判定一致', () => {
  // 逐处判定的口径：标签和分隔符之后，取值所在那段连续非空白字符要同时有数字和字母，取值本身至少 6 个非空白、非中日韩字符
  const REFERENCE = /(?:password|passwd|pwd|密码)\s*[:=＝：]\s*(?<value>(?=\S*[0-9])(?=\S*[A-Za-z])[^\s㐀-鿿]{6,})/gi
  // 只会碰到「硬编码密码」这一条规则的字符：没有 -、_、g、e、y 等其余规则要的字符
  const PIECES = ['password', 'Passwd', 'PWD', 'pwd', '密码', ':', '=', '＝', '：', ' ', '\n', '\u00A0', '\u3000', '1', '7', 'a', 'Z', 'x', '中', '码', 'ア', '.', '!', '#']

  // 手写字符分类最容易和正则分歧的字符：形似 ASCII 字母或与大小写折叠相关的 ſ、开尔文符号、ı，全角数字和字母，
  // 中日韩范围两侧的边界，\s 认的其他空白，非 BMP 字符，孤立代理项
  const EDGE = ['ſ', '\u212A', 'ı', '１', 'Ａ', '\u33FF', '\u3400', '\u9FFF', '\uA000', '\t', '\r', '\u2028', '\uFEFF', '\u{1F600}', '\uD800']

  it('固定种子生成的 3000 段文字：检测、取值、遮盖都与逐处判定相同', () => {
    const random = seeded(1)
    let hits = 0
    let edgeHits = 0
    for (let n = 0; n < 3000; n++) {
      const text = Array.from({ length: 1 + Math.floor(random() * 40) }, () => {
        const from = random() < 0.15 ? EDGE : PIECES
        return from[Math.floor(random() * from.length)]
      }).join('')
      const expected = [...text.matchAll(REFERENCE)]
      if (expected.length > 0) hits++
      if (expected.some(m => EDGE.some(c => m[0].includes(c)))) edgeHits++
      const masked = text.replace(REFERENCE, SECRET_MASK).replace(/(?:\[已隐藏\])+/g, SECRET_MASK)
      expect(detectSecrets(text), text).toEqual(expected.length > 0 ? [{ name: '硬编码密码', severity: 'suspected' }] : [])
      expect(secretValues(text, { severity: 'suspected' }), text).toEqual(expected.map(m => m.groups?.value))
      expect(maskSecrets(text, { severity: 'suspected' }), text).toBe(masked)
    }
    // 生成器退化成几乎全是负例时这里会挂（当前种子下 171 段命中，其中 90 段的命中里带上面的边界字符）
    expect(hits).toBeGreaterThan(100)
    expect(edgeHits).toBeGreaterThan(50)
  })
})

describe('JWT：一处起点不命中，同一段字符里后面的起点直接跳过', () => {
  for (const times of [500, 2000]) {
    it(`eyJ- 连写 ${times} 遍、后面一长串字母：不命中，这段字符恰好读一遍`, () => {
      const text = 'eyJ-'.repeat(times) + 'A'.repeat(times * 4)
      expect(countReads(() => expect(detectSecrets(text)).toEqual([]))).toBe(text.length)
      expect(countReads(() => expect(maskSecrets(text)).toBe(text))).toBe(text.length)
    })
  }

  it('前两段齐了、缺第三段：不命中，每个字符至多读一遍', () => {
    const text = `${'eyJ-'.repeat(1000)}${'A'.repeat(2000)}.eyJ${'B'.repeat(2000)}`
    const reads = countReads(() => expect(maskSecrets(text)).toBe(text))
    expect(reads).toBeGreaterThan(0)
    expect(reads).toBeLessThanOrEqual(text.length)
  })

  it('连写的起点后面是完整的三段：从第一个起点整段命中，前后文字原样', () => {
    const jwt = `${'eyJ-'.repeat(1000)}abcdefgh.eyJabcdefgh.abcdefgh`
    expect(detectSecrets(jwt)).toEqual([{ name: 'JWT', severity: 'critical' }])
    expect(maskSecrets(`令牌 ${jwt} 过期了`)).toBe(`令牌 ${SECRET_MASK} 过期了`)
    expect(secretValues(`令牌 ${jwt}`)).toEqual([jwt])
  })

  it('一段里的起点不命中，后面另一段的 JWT 照样命中', () => {
    const jwt = 'eyJabcdefgh.eyJabcdefgh.abcdefgh'
    const text = `${'eyJ-'.repeat(100)}AAAA ${jwt}`
    expect(maskSecrets(text)).toBe(`${'eyJ-'.repeat(100)}AAAA ${SECRET_MASK}`)
  })
})

describe('JWT：命中、取值、遮盖与逐处正则判定一致', () => {
  const REFERENCE = /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g
  // 只会碰到 JWT 这一条规则的字符。每段多以 eyJ 开头、后接 6–10 个字符（不足 8 个的接不上），段前随机带 eyJ-、-、_ 噪声
  // （一段里多个起点、_ 后面没有词边界的起点）；段之间多数用 . 连成 a.b.c.d.e 这样的长链，少数用空格、..、中文字符断开
  const TOKEN = [...'aB9_-xZ0']
  const NOISE = ['eyJ-', '-', '_']
  const JOINS = ['.', '.', '.', '.', '.', '.', '.', ' ', '..', '中']

  it('固定种子生成的 3000 段文字：检测、取值、遮盖都与逐处判定相同', () => {
    const random = seeded(2)
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(random() * xs.length)]
    const part = () => {
      let s = ''
      while (random() < 0.25) s += pick(NOISE)
      if (random() < 0.85) s += 'eyJ'
      const length = 6 + Math.floor(random() * 5)
      for (let i = 0; i < length; i++) s += pick(TOKEN)
      return s
    }
    let hits = 0
    let multiHits = 0
    for (let n = 0; n < 3000; n++) {
      const text = Array.from({ length: 1 + Math.floor(random() * 9) }, part).reduce((s, p) => s + pick(JOINS) + p)
      const expected = [...text.matchAll(REFERENCE)]
      if (expected.length > 0) hits++
      if (expected.length > 1) multiHits++
      const masked = text.replace(REFERENCE, SECRET_MASK).replace(/(?:\[已隐藏\])+/g, SECRET_MASK)
      expect(detectSecrets(text), text).toEqual(expected.length > 0 ? [{ name: 'JWT', severity: 'critical' }] : [])
      expect(secretValues(text), text).toEqual(expected.map(m => m[0]))
      expect(maskSecrets(text), text).toBe(masked)
    }
    // 生成器退化成几乎全是负例时这里会挂（当前种子下 766 段命中，74 段命中多处）
    expect(hits).toBeGreaterThan(500)
    expect(multiHits).toBeGreaterThan(40)
  })
})
