import { describe, expect, it } from 'vitest'
import { detectSecrets, maskSecrets, maskSecretSurface, SECRET_MASK, hasSecret } from '../src/secrets.ts'
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
})

describe('私钥块正则：行尾带空白的头字段、没有 END 行时不回溯爆炸', () => {
  const pgpBegin = ['-----BEGIN', 'PGP PRIVATE KEY BLOCK-----'].join(' ')
  const headers = (trailing: string) => `Note: something here${trailing}\n`.repeat(30)

  for (const [label, begin] of [['PEM', FAKE_SECRET.pem], ['PGP', pgpBegin]] as const) {
    for (const [desc, trailing] of [['一个空格', ' '], ['两个空格', '  ']] as const) {
      it(`${label}：BEGIN 后 30 行头字段、行尾${desc}，检测在 50ms 内完成，头字段照样遮住`, () => {
        const text = `前文\n${begin}\n${headers(trailing)}（后面省略）`
        const t = performance.now()
        expect(detectSecrets(text)).toEqual([{ name: `${label} 私钥块`, severity: 'critical' }])
        expect(performance.now() - t).toBeLessThan(50)
        expect(maskSecrets(text)).toBe(`前文\n${SECRET_MASK}\n（后面省略）`)
      })
    }
  }
})
