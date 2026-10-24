import { describe, expect, it } from 'vitest'
import { maskSecrets, maskSecretSurface, SECRET_MASK, hasSecret } from '../src/secrets.ts'
import { FAKE_SECRET } from './helpers/secrets.ts'

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
