import { describe, expect, it } from 'vitest'
import { runRuleScan, BLOAT_THRESHOLD } from '../src/governance/rule-scan.ts'
import { detectSecrets } from '../src/secrets.ts'
import type { MemoryRecord } from '../src/record-schema.ts'
import { record } from './helpers/record.ts'
import { FAKE_SECRET } from './helpers/secrets.ts'

describe('detectSecrets', () => {
  it.each([
    ['sk- 密钥', `key 是 ${FAKE_SECRET.sk}`],
    ['GitHub token', `用 ${FAKE_SECRET.github} 拉取`],
    ['AWS AKIA', `账号 ${FAKE_SECRET.aws}`],
    ['JWT', '带上 eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'],
    ['私钥块', FAKE_SECRET.pem],
    ['Slack token', FAKE_SECRET.slack],
    ['硬编码密码', 'password = TESTONLYpassw0rd'],
    ['Google API Key', `config: ${FAKE_SECRET.google} 用于访问`],
    ['Bearer token', 'Authorization: Bearer TESTONLY.00000000000000000000'],
    ['通用 api_key 赋值（无引号）', 'api_key: 1234567890abcdef'],
    ['中文密码（有把握的凭证）', '密码: TESTONLYpassw0rd'],
  ])('识别 %s', (_name, text) => {
    expect(detectSecrets(text).length).toBeGreaterThan(0)
  })

  it('普通文本不误报', () => {
    expect(detectSecrets('用户偏好 pnpm，测试框架用 vitest，密码管理走 1Password')).toEqual([])
  })

  it('中文密码字段的普通描述不误报（\\S{6,} 对无空格中文过于宽松的回归）', () => {
    expect(detectSecrets('密码:公司统一走单点登录')).toEqual([])
  })

  it('高危模式标 critical、宽泛模式标 suspected（D6 分级）', () => {
    expect(detectSecrets(`key 是 ${FAKE_SECRET.sk}`)[0].severity).toBe('critical')
    expect(detectSecrets(`账号 ${FAKE_SECRET.aws}`)[0].severity).toBe('critical')
    expect(detectSecrets('password = TESTONLYpassw0rd')[0].severity).toBe('suspected')
    expect(detectSecrets('api_key: 1234567890abcdef')[0].severity).toBe('suspected')
  })
})

describe('runRuleScan', () => {
  const lookup = (map: Map<string, MemoryRecord>) => (id: string) => map.get(id)

  it('expired：validTo 早于 now 才报', () => {
    const a = record({ id: 'mem_a', validTo: 100 })
    const b = record({ id: 'mem_b', validTo: 300 })
    const c = record({ id: 'mem_c' }) // 无 validTo 永不过期
    const findings = runRuleScan([a, b, c], () => undefined, 200)
    const expired = findings.filter(f => f.type === 'expired')
    expect(expired.map(f => f.memoryIds[0])).toEqual(['mem_a'])
    expect(expired[0].layer).toBe('rule')
    expect(expired[0].severity).toBe('warning')
  })

  it('bloat：content 超过阈值才报', () => {
    const fat = record({ id: 'mem_fat', content: 'x'.repeat(BLOAT_THRESHOLD + 1) })
    const slim = record({ id: 'mem_slim', content: 'x'.repeat(BLOAT_THRESHOLD) })
    const types = runRuleScan([fat, slim], () => undefined, 1).filter(f => f.type === 'bloat')
    expect(types.map(f => f.memoryIds[0])).toEqual(['mem_fat'])
  })

  it('orphan：supersedes 指向不存在或已删除的记录', () => {
    const deleted = record({ id: 'mem_dead', status: 'deleted' })
    const alive = record({ id: 'mem_alive' })
    const map = new Map([[deleted.id, deleted], [alive.id, alive]])
    const o1 = record({ id: 'mem_o1', supersedes: ['mem_ghost'] })   // 不存在
    const o2 = record({ id: 'mem_o2', supersedes: ['mem_dead'] })    // 已删除
    const okRef = record({ id: 'mem_ok', supersedes: ['mem_alive'] }) // 正常引用
    const findings = runRuleScan([o1, o2, okRef], lookup(map), 1)
    const orphan = findings.filter(f => f.type === 'orphan')
    expect(orphan.map(f => f.memoryIds[0]).sort()).toEqual(['mem_o1', 'mem_o2'])
  })

  it('secret 藏在 summary/name/tags 也检出（content 干净不影响检出）', () => {
    const inSummary = record({ id: 'mem_sum', content: '干净内容', summary: `联系方式 ${FAKE_SECRET.sk}` })
    const inName = record({ id: 'mem_name', content: '干净', name: FAKE_SECRET.github, summary: '干净' })
    const inTags = record({ id: 'mem_tag', content: '干净', tags: [FAKE_SECRET.aws], summary: '干净' })
    const clean = record({ id: 'mem_clean', content: '完全干净的内容', name: '普通条目', tags: ['note'], summary: '干净摘要' })
    const findings = runRuleScan([inSummary, inName, inTags, clean], () => undefined, 1)
    const secrets = findings.filter(f => f.type === 'secret')
    expect(secrets.map(f => f.memoryIds[0]).sort()).toEqual(['mem_name', 'mem_sum', 'mem_tag'])
  })

  it('secret finding 的 summary 带 pattern 名', () => {
    const r = record({ id: 'mem_s', content: `密钥 ${FAKE_SECRET.sk}` })
    const findings = runRuleScan([r], () => undefined, 1)
    const secret = findings.find(f => f.type === 'secret')!
    expect(secret.severity).toBe('critical')
    expect(secret.summary).toContain('sk-')
  })
})
