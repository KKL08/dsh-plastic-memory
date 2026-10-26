import { describe, expect, it } from 'vitest'
import { createTokenizer } from '../src/search/tokenizer.ts'
import {
  KEYWORD_MAX_CJK_CHARS, WEAK_COVERAGE_BELOW, groupQueryTerms, judgeTopHit, termHitCounts, type TermGroup,
} from '../src/search/coverage.ts'

// 「命中弱」按首条覆盖度判断：查询切成词、中英双写成对，关键词整组缺失或覆盖的查询文字不到阈值才算弱。
// 这里用 bigram 分词器（与 jieba 是否安装无关）；生产两档在评估集上的表现见 tests/search-eval.spec.ts。

const tokenize = createTokenizer()
const tokensOf = (query: string) => [...new Set(tokenize(query))].filter(t => !(/^\p{N}+$/u.test(t) || ([...t].length === 1 && !/\p{Script=Han}/u.test(t))))
const labels = (groups: TermGroup[]) => groups.map(g => g.terms.map(t => t.text).join('/'))
const keywords = (groups: TermGroup[]) => groups.map(g => g.keyword)

/** 记录对查询 token 的命中：记录原文以子串含该 token 即算（与排序侧对单测足够等价）。 */
function hitsIn(text: string, tokens: readonly string[]): boolean[] {
  const lower = text.toLowerCase()
  return tokens.map(t => lower.includes(t))
}

function judge(query: string, recordText: string) {
  const tokens = tokensOf(query)
  return judgeTopHit(groupQueryTerms(query, tokens, tokenize), tokens, hitsIn(recordText, tokens))
}

describe('查询切词与中英成对', () => {
  it('2 到 4 字的中文词与相邻的英文词成对，英文写在前或后都行，连写的几个英文词算一边', () => {
    const g = (q: string) => labels(groupQueryTerms(q, tokensOf(q), tokenize))
    expect(g('部署 deploy')).toEqual(['部署/deploy'])
    expect(g('deploy 部署 rollback 回滚')).toEqual(['部署/deploy', '回滚/rollback'])
    expect(g('部署 deploy 回滚 rollback')).toEqual(['部署/deploy', '回滚/rollback'])
    expect(g('内存泄漏 memory leak')).toEqual(['内存泄漏/memory leak'])
    expect(g('轮换 rotation 密钥')).toEqual(['轮换/rotation', '密钥'])
  })

  it('两个中文词不成对；单字和长于四字的中文段不成对，按句子处理（不算关键词）', () => {
    const q1 = '缓存击穿 互斥锁'
    const g1 = groupQueryTerms(q1, tokensOf(q1), tokenize)
    expect(labels(g1)).toEqual(['缓存击穿', '互斥锁'])
    expect(keywords(g1)).toEqual([true, true])
    const q2 = 'Node 生态装库用哪家'
    const g2 = groupQueryTerms(q2, tokensOf(q2), tokenize)
    expect(labels(g2)).toEqual(['Node', '生态装库用哪家'])
    expect(keywords(g2)).toEqual([true, false])
    const q3 = 'Redis 的 key 何时作废'
    const g3 = groupQueryTerms(q3, tokensOf(q3), tokenize)
    expect(labels(g3)).toEqual(['Redis', '的', '何时作废/key'])
    expect(keywords(g3)).toEqual([true, false, true])
    expect(KEYWORD_MAX_CJK_CHARS).toBe(4)
  })

  it('首字母大写或大小写混写的英文词（产品名、库名、标识符）不成对，全大写缩写照常成对', () => {
    const g = (q: string) => labels(groupQueryTerms(q, tokensOf(q), tokenize))
    expect(g('接口 GraphQL')).toEqual(['接口', 'GraphQL'])
    expect(g('Redis 缓存')).toEqual(['Redis', '缓存'])
    expect(g('readScope 读取范围')).toEqual(['readScope', '读取范围'])
    expect(g('持续集成 CI')).toEqual(['持续集成/CI'])
    // 连写的英文词只取紧挨着、能成对的那几个
    expect(g('MySQL dump 保存期限')).toEqual(['MySQL', '保存期限/dump'])
  })

  it('不产生 token 的词（纯数字、标点）跳过，不阻断两侧成对', () => {
    const q = '偶发 502 负载均衡 load balancer'
    expect(labels(groupQueryTerms(q, tokensOf(q), tokenize))).toEqual(['偶发', '负载均衡/load balancer'])
  })
})

describe('首条覆盖度判弱', () => {
  it('中英双写：首条只含中文写法，覆盖度按命中多的一边算，不判弱', () => {
    for (const [q, text] of [
      ['防抖 debounce', '前端搜索输入框防抖 300 毫秒'],
      ['内存泄漏 memory leak', '内存泄漏排查：用堆快照对比找泄漏对象'],
      ['部署 deploy', '改邮件模板后要重新部署才生效'],
    ] as const) {
      const v = judge(q, text)
      expect(v.coverage, q).toBe(1)
      expect(v.missingKeywords, q).toEqual([])
      expect(v.weak, q).toBe(false)
    }
  })

  it('长句中文：首条覆盖了大部分文字、只缺疑问词这类，不判弱', () => {
    const v = judge('记忆文件手编后出处对不上怎么办', '记忆文件被手编过时，出处可能对不上，读取时加标注')
    expect(v.coverage).toBeGreaterThanOrEqual(WEAK_COVERAGE_BELOW)
    expect(v.missingKeywords).toEqual([])
    expect(v.weak).toBe(false)
  })

  it('长句中文：首条只覆盖零星几个字，判弱', () => {
    const v = judge('访问别家仓库的内容需要授权吗', '读其他项目的记忆要过门禁：用户确认后只读')
    expect(v.coverage).toBeLessThan(WEAK_COVERAGE_BELOW)
    expect(v.weak).toBe(true)
  })

  it('关键词整个没在首条出现，即使其余都在也判弱：库里没有答案的查询', () => {
    const v = judge('证书 过期 续期', '登录会话七天过期，活跃时自动续期')
    expect(v.coverage).toBeGreaterThanOrEqual(WEAK_COVERAGE_BELOW)
    expect(v.missingKeywords.map(g => g.terms.map(t => t.text).join('/'))).toEqual(['证书'])
    expect(v.weak).toBe(true)
  })

  it('中文通用词加英文产品名：不当成中英双写，产品名没出现就判弱', () => {
    const v = judge('Redis 缓存', '更新数据后先写库再删缓存')
    expect(v.missingKeywords.map(g => g.terms.map(t => t.text).join('/'))).toEqual(['Redis'])
    expect(v.weak).toBe(true)
  })

  it('成对的两边都没完整出现（中文词只命中一半），判弱', () => {
    const v = judge('定时任务 cron 配置', '配置中心里的任务开关')
    expect(v.missingKeywords.map(g => g.terms.map(t => t.text).join('/'))).toEqual(['定时任务/cron'])
    expect(v.weak).toBe(true)
  })

  it('什么都没命中（只有子串档）覆盖度为 0，判弱', () => {
    const v = judge('周报 模板', '无关内容')
    expect(v.coverage).toBe(0)
    expect(v.weak).toBe(true)
  })
})

describe('逐词命中条数', () => {
  it('关键词组按组计（成对的任一写法完整出现即算），长句段按其中的 token 计、单字略过', () => {
    const q = '定时任务 cron 配置'
    const tokens = tokensOf(q)
    const groups = groupQueryTerms(q, tokens, tokenize)
    const rows = ['配置中心', '定时任务每天跑', '用 cron 定时清理', '无关'].map(t => hitsIn(t, tokens))
    expect(termHitCounts(groups, tokens, rows)).toEqual([
      { label: '定时任务/cron', count: 2 },
      { label: '配置', count: 1 },
    ])
    const q2 = '模板 怎么热生效'
    const t2 = tokensOf(q2)
    const g2 = groupQueryTerms(q2, t2, tokenize)
    expect(termHitCounts(g2, t2, ['模板改了立即生效'].map(t => hitsIn(t, t2)))).toEqual([
      { label: '模板', count: 1 },
      { label: '怎么', count: 0 },
      { label: '么热', count: 0 },
      { label: '热生', count: 0 },
      { label: '生效', count: 1 },
    ])
  })
})
