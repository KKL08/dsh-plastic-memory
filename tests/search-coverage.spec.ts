import { describe, expect, it } from 'vitest'
import { createTokenizer } from '../src/search/tokenizer.ts'
import {
  KEYWORD_MAX_CJK_CHARS, WEAK_COVERAGE_BELOW, contentSegments, groupQueryTerms, judgeTopHit, termHitCounts, type TermGroup,
} from '../src/search/coverage.ts'

// 「命中弱」按首条覆盖度判断：查询切成词（CJK 去掉虚词后的内容段）、有证据才把中英双写配成一对，
// 关键词整组缺失或覆盖的内容字不到阈值才算弱。
// 这里用 bigram 分词器（与 jieba 是否安装无关）；生产两档在评估集上的表现见 tests/search-eval.spec.ts。

const tokenize = createTokenizer()
const tokensOf = (query: string) => [...new Set(tokenize(query))].filter(t => !(/^\p{N}+$/u.test(t) || ([...t].length === 1 && !/\p{Script=Han}/u.test(t))))
const labelOf = (g: TermGroup) => g.units.map(u => u.label).join('/')
const labels = (groups: TermGroup[]) => groups.map(labelOf)
const keywords = (groups: TermGroup[]) => groups.map(g => g.keyword)

/** 记录对查询 token 的命中：记录原文以子串含该 token 即算（与排序侧对单测足够等价）。 */
function hitsIn(text: string, tokens: readonly string[]): boolean[] {
  const lower = text.toLowerCase()
  return tokens.map(t => lower.includes(t))
}

/** 按范围内这些记录切词：成对的证据从它们来。 */
function groupsFor(query: string, records: readonly string[] = []) {
  const tokens = tokensOf(query)
  return groupQueryTerms(query, tokens, tokenize, records.map(r => hitsIn(r, tokens)))
}

/** 首条是 records[0]，范围内是全部 records。 */
function judge(query: string, records: readonly string[]) {
  const tokens = tokensOf(query)
  const rows = records.map(r => hitsIn(r, tokens))
  return judgeTopHit(groupQueryTerms(query, tokens, tokenize, rows), tokens, rows[0]!)
}

describe('查询切词', () => {
  it('虚词（疑问词、语气词、助词）不算内容，把句子切成内容段', () => {
    expect(contentSegments('前端埋点数据怎么上报到服务端')).toEqual(['前端埋点数据', '上报到服务端'])
    expect(contentSegments('周报模板应该放在哪个目录')).toEqual(['周报模板', '放', '目录'])
    expect(contentSegments('是不是')).toEqual([])
  })

  it('去掉虚词后 2 到 4 字的中文词是关键词；分出多段或更长的按句子看，各段只计入覆盖度', () => {
    const g1 = groupsFor('缓存击穿 互斥锁')
    expect(labels(g1)).toEqual(['缓存击穿', '互斥锁'])
    expect(keywords(g1)).toEqual([true, true])
    const g2 = groupsFor('Node 生态装库用哪家')
    expect(labels(g2)).toEqual(['Node', '生态装库用哪家'])
    expect(keywords(g2)).toEqual([true, false])
    const g3 = groupsFor('定时任务的执行时间怎么配置')
    expect(labels(g3)).toEqual(['定时任务', '执行时间', '配置'])
    expect(keywords(g3)).toEqual([false, false, false])
    // 剥掉虚词后只剩一段、长度合适，照样是关键词；只有虚词的段整个略过
    const g4 = groupsFor('模板 怎么热生效 吗')
    expect(labels(g4)).toEqual(['模板', '热生效'])
    expect(keywords(g4)).toEqual([true, true])
    expect(KEYWORD_MAX_CJK_CHARS).toBe(4)
  })

  it('英文词的标签去掉首尾标点；不产生 token 的词（纯数字、标点）跳过', () => {
    expect(labels(groupsFor('deploy（部署）'))).toEqual(['deploy', '部署'])
    expect(labels(groupsFor('偶发 502 负载均衡'))).toEqual(['偶发', '负载均衡'])
  })
})

describe('中英成对要有证据', () => {
  it('范围内有记录两种写法都出现，才把中文词与紧挨着的英文词配成一对；英文在前在后都行', () => {
    const both = ['改邮件模板后要重新部署（deploy），回滚（rollback）走上一版']
    expect(labels(groupsFor('部署 deploy', both))).toEqual(['部署/deploy'])
    expect(labels(groupsFor('deploy 部署 rollback 回滚', both))).toEqual(['部署/deploy', '回滚/rollback'])
    expect(labels(groupsFor('deploy（部署）', both))).toEqual(['部署/deploy'])
  })

  it('没有记录两种写法都出现，就是两个独立的关键词', () => {
    const g = groupsFor('部署 deploy', ['改邮件模板后要重新部署才生效', 'deploy script'])
    expect(labels(g)).toEqual(['部署', 'deploy'])
    expect(keywords(g)).toEqual([true, true])
    expect(labels(groupsFor('Redis 的 key 何时作废', ['Redis 缓存过期时间'])))
      .toEqual(['Redis', 'key', '何时作废'])
    expect(labels(groupsFor('MySQL dump 保存期限', ['数据库备份保留 30 天']))).toEqual(['MySQL', 'dump', '保存期限'])
  })

  it('只配一个英文词，连写的几个英文词不会整串吞进去', () => {
    const rows = ['内存泄漏 memory leak 排查', '偶发 502 时看负载均衡 load balancer 日志']
    expect(labels(groupsFor('内存泄漏 memory leak', rows))).toEqual(['内存泄漏/memory', 'leak'])
    expect(labels(groupsFor('偶发 502 负载均衡 load balancer', rows))).toEqual(['偶发', '负载均衡/load', 'balancer'])
  })

  it('带数字、斜杠、点的词与首字母大写、大小写混写的词不成对，全大写缩写可以', () => {
    const rows = ['升级到 node22 和 v2 接口', 'src/store.ts 路径约定', 'Redis 缓存', 'readScope 读取范围', '持续集成 CI 跑三档']
    expect(labels(groupsFor('node22 升级', rows))).toEqual(['node22', '升级'])
    expect(labels(groupsFor('v2 接口', rows))).toEqual(['v2', '接口'])
    expect(labels(groupsFor('src/store.ts 路径', rows))).toEqual(['src/store.ts', '路径'])
    expect(labels(groupsFor('Redis 缓存', rows))).toEqual(['Redis', '缓存'])
    expect(labels(groupsFor('readScope 读取范围', rows))).toEqual(['readScope', '读取范围'])
    expect(labels(groupsFor('持续集成 CI', rows))).toEqual(['持续集成/CI'])
  })
})

describe('首条覆盖度判弱', () => {
  it('中英双写配成对时，首条只含中文写法也不判弱', () => {
    const v = judge('防抖 debounce', ['前端搜索输入框防抖 300 毫秒', '防抖（debounce）与节流的区别'])
    expect(v.coverage).toBe(1)
    expect(v.missingKeywords).toEqual([])
    expect(v.weak).toBe(false)
  })

  it('没有证据配对时，首条缺了英文写法就判弱', () => {
    const v = judge('防抖 debounce', ['前端搜索输入框防抖 300 毫秒'])
    expect(v.missingKeywords.map(labelOf)).toEqual(['debounce'])
    expect(v.weak).toBe(true)
  })

  it('长句中文：疑问词不算内容，首条盖住了几乎全部内容字，不判弱', () => {
    // 内容段「记忆文件手编后出处对不上」12 字，只缺「后」
    const v = judge('记忆文件手编后出处对不上怎么办', ['记忆文件被手编过时，出处可能对不上，读取时加标注'])
    expect(v.coverage).toBe(11 / 12)
    expect(v.missingKeywords).toEqual([])
    expect(v.weak).toBe(false)
  })

  it('长句中文：虚词和跨过虚词的二字碎片不算覆盖，首条只盖住一半内容字就判弱', () => {
    // 记录里有「是什么」「么格」，但只有「日志」是内容字
    const v = judge('日志是什么格式', ['问是什么么格的都记进日志'])
    expect(v.coverage).toBe(0.5)
    expect(v.coverage).toBeLessThan(WEAK_COVERAGE_BELOW)
    expect(v.weak).toBe(true)
  })

  it('长句中文：库里没有答案，首条只盖住后面几个词、缺了话题词，判弱', () => {
    const v = judge('定时任务的执行时间怎么配置', ['任务的执行时间在配置中心里改'])
    expect(v.coverage).toBe(0.8)
    expect(judge('周报模板应该放在哪个目录', ['邮件模板放在 templates 目录']).weak).toBe(true)
  })

  it('关键词整个没在首条出现，即使其余都在也判弱：库里没有答案的查询', () => {
    const v = judge('证书 过期 续期', ['登录会话七天过期，活跃时自动续期'])
    expect(v.coverage).toBeGreaterThanOrEqual(WEAK_COVERAGE_BELOW)
    expect(v.missingKeywords.map(labelOf)).toEqual(['证书'])
    expect(v.weak).toBe(true)
  })

  it('中文通用词加英文产品名：产品名没出现就判弱', () => {
    const v = judge('Redis 缓存', ['更新数据后先写库再删缓存'])
    expect(v.missingKeywords.map(labelOf)).toEqual(['Redis'])
    expect(v.weak).toBe(true)
  })

  it('什么都没命中（只有子串档）覆盖度为 0，判弱', () => {
    const v = judge('周报 模板', ['无关内容'])
    expect(v.coverage).toBe(0)
    expect(v.weak).toBe(true)
  })
})

describe('逐词命中条数', () => {
  it('按组计：成对的任一写法完整出现即算；没配对的中英各算一个', () => {
    const q = '定时任务 cron 配置'
    const tokens = tokensOf(q)
    const rows = ['配置中心', '定时任务每天跑', '用 cron 定时清理', '无关'].map(t => hitsIn(t, tokens))
    expect(termHitCounts(groupQueryTerms(q, tokens, tokenize, rows), tokens, rows)).toEqual([
      { label: '定时任务', count: 1 },
      { label: 'cron', count: 1 },
      { label: '配置', count: 1 },
    ])
    const paired = [...rows, hitsIn('定时任务（cron）', tokens)]
    expect(termHitCounts(groupQueryTerms(q, tokens, tokenize, paired), tokens, paired)).toEqual([
      { label: '定时任务/cron', count: 3 },
      { label: '配置', count: 1 },
    ])
  })

  it('只列整词和词长的内容段，不列二字碎片、单字和长短语；同名的只列一次', () => {
    const q = '模板 怎么热生效 模板'
    const tokens = tokensOf(q)
    const rows = ['模板改了立即生效'].map(t => hitsIn(t, tokens))
    expect(termHitCounts(groupQueryTerms(q, tokens, tokenize, rows), tokens, rows)).toEqual([
      { label: '模板', count: 1 },
      { label: '热生效', count: 0 },
    ])
    const q2 = '前端埋点数据怎么上报到服务端'
    const t2 = tokensOf(q2)
    const r2 = ['前端数据上报'].map(t => hitsIn(t, t2))
    expect(termHitCounts(groupQueryTerms(q2, t2, tokenize, r2), t2, r2)).toEqual([])
    const q3 = '周报模板应该放在哪个目录'
    const t3 = tokensOf(q3)
    const r3 = ['邮件模板放在 templates 目录'].map(t => hitsIn(t, t3))
    expect(termHitCounts(groupQueryTerms(q3, t3, tokenize, r3), t3, r3)).toEqual([
      { label: '周报模板', count: 0 },
      { label: '目录', count: 1 },
    ])
  })
})
