import { describe, expect, it } from 'vitest'
import { createTokenizer } from '../src/search/tokenizer.ts'
import {
  KEYWORD_MAX_CJK_CHARS, contentSegments, groupQueryTerms, judgeTopHit, matchedTerms, termHitCounts, type TermGroup,
} from '../src/search/coverage.ts'

// 「命中弱」按首条覆盖度判断：查询切成词（CJK 去掉虚词后的内容段），覆盖的内容不到一半才算弱；
// 整组没出现的关键词另外列出，不单独决定判弱。
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

const groupsFor = (query: string) => groupQueryTerms(query, tokensOf(query), tokenize)

/** 首条的原文是 text。 */
function judge(query: string, text: string) {
  const tokens = tokensOf(query)
  return judgeTopHit(groupQueryTerms(query, tokens, tokenize), tokens, hitsIn(text, tokens))
}

describe('查询切词', () => {
  it('虚词（疑问词、语气词、助词）不算内容，把句子切成内容段', () => {
    expect(contentSegments('前端埋点数据怎么上报到服务端')).toEqual(['前端埋点数据', '上报到服务端'])
    expect(contentSegments('周报模板应该放在哪个目录')).toEqual(['周报模板', '放', '目录'])
    expect(contentSegments('是不是')).toEqual([])
  })

  it('去掉虚词后 2 到 4 字的中文词是关键词；分出多段或更长的按句子看，各段只计入覆盖度（问的那段除外）', () => {
    const g1 = groupsFor('缓存击穿 互斥锁')
    expect(labels(g1)).toEqual(['缓存击穿', '互斥锁'])
    expect(keywords(g1)).toEqual([true, true])
    const g2 = groupsFor('Node 生态装库用哪家')
    expect(labels(g2)).toEqual(['Node', '生态装库用哪家'])
    expect(keywords(g2)).toEqual([true, false])
    const g3 = groupsFor('定时任务的执行时间怎么配置')
    expect(labels(g3)).toEqual(['定时任务', '执行时间', '配置'])
    expect(keywords(g3)).toEqual([false, false, false])
    // 分出多段时，紧跟着疑问词（可带「是」）的那段是问的东西，长度合适就是关键词
    const g5 = groupsFor('数据库连接池的密码是什么')
    expect(labels(g5)).toEqual(['数据库连接池', '密码'])
    expect(keywords(g5)).toEqual([false, true])
    expect(keywords(groupsFor('部署脚本的超时是多少'))).toEqual([false, true])
    expect(keywords(groupsFor('登录会话多久会过期'))).toEqual([true, false])
    // 剥掉虚词后只剩一段、长度合适，照样是关键词；只有虚词的段整个略过
    const g4 = groupsFor('模板 怎么热生效 吗')
    expect(labels(g4)).toEqual(['模板', '热生效'])
    expect(keywords(g4)).toEqual([true, true])
    expect(KEYWORD_MAX_CJK_CHARS).toBe(4)
  })

  it('英文虚词（冠词、介词、助动词、疑问词）同中文虚词：不算关键词，也不计入覆盖度', () => {
    expect(labels(groupsFor('cache invalidation with Redis'))).toEqual(['cache', 'invalidation', 'Redis'])
    expect(labels(groupsFor('How do I deploy to the staging server?'))).toEqual(['deploy', 'staging', 'server'])
  })

  it('英文词的标签去掉首尾标点；不产生 token 的词（纯数字、标点）跳过', () => {
    expect(labels(groupsFor('deploy（部署）'))).toEqual(['deploy', '部署'])
    expect(labels(groupsFor('偶发 502 负载均衡'))).toEqual(['偶发', '负载均衡'])
  })
})

describe('斜杠词', () => {
  it('不是别名组：中英斜杠连写按文字种类切成两个关键词；同一文字的斜杠词（路径等）是一个词', () => {
    const g = groupsFor('部署/deploy')
    expect(labels(g)).toEqual(['部署', 'deploy'])
    expect(keywords(g)).toEqual([true, true])
    expect(labels(groupsFor('src/gui/contract.ts'))).toEqual(['src/gui/contract.ts'])
    expect(labels(groupsFor('/opt/x/y'))).toEqual(['opt/x/y'])   // 标签去掉首尾标点
    expect(labels(groupsFor('a/b/c'))).toEqual([])   // 单字母不是 token
    expect(keywords(groupsFor('src/gui/contract.ts'))).toEqual([true])
  })

  it('首条只写了中文，查询里的英文写法也算一个关键词：缺了照样列出', () => {
    const v = judge('防抖/debounce', '前端搜索输入框防抖 300 毫秒')
    expect(v.missingKeywords.map(labelOf)).toEqual(['debounce'])
  })
})

describe('首条覆盖度判弱', () => {
  it('中英两种写法空格分开：各是一个关键词，首条缺了英文写法只列出来，覆盖过半不判弱', () => {
    const v = judge('防抖 debounce', '前端搜索输入框防抖 300 毫秒')
    expect(v.missingKeywords.map(labelOf)).toEqual(['debounce'])
    expect(v.weak).toBe(false)
  })

  it('长句中文：疑问词不算内容，首条盖住了几乎全部内容字，不判弱', () => {
    // 内容段「记忆文件手编后出处对不上」12 字，只缺「后」
    const v = judge('记忆文件手编后出处对不上怎么办', '记忆文件被手编过时，出处可能对不上，读取时加标注')
    expect(v.coverage).toBe(11 / 12)
    expect(v.missingKeywords).toEqual([])
    expect(v.weak).toBe(false)
  })

  it('长句中文：虚词和跨过虚词的二字碎片不算覆盖；刚好一半不判弱，不到一半判弱', () => {
    // 记录里有「是什么」「么格」，但只有「日志」是内容字
    const v = judge('日志是什么格式', '问是什么么格的都记进日志')
    expect(v.coverage).toBe(0.5)
    expect(v.weak).toBe(false)
    // 内容段「日志格式规范」6 字，首条只有「日志」
    const v2 = judge('日志格式规范是什么', '问是什么么格的都记进日志')
    expect(v2.coverage).toBeLessThan(0.5)
    expect(v2.weak).toBe(true)
  })

  it('长句中文：首条盖住了大半内容字，即使缺了话题词也不判弱（库里有没有答案，词面分不出来）', () => {
    const v = judge('定时任务的执行时间怎么配置', '任务的执行时间在配置中心里改')
    expect(v.coverage).toBe(0.8)
    expect(v.weak).toBe(false)
  })

  it('「X 的 Y 是什么」：问的那个词 Y 是关键词，首条话题对上、缺了 Y 就列出来', () => {
    const v1 = judge('数据库连接池的密码是什么', '数据库连接池使用固定上限，最大连接数为 20。')
    expect(v1.missingKeywords.map(labelOf)).toEqual(['密码'])
    expect(v1.weak).toBe(false)
    const v2 = judge('部署脚本的超时是多少', '部署脚本在 CI 里运行，失败时自动重试一次。')
    expect(v2.missingKeywords.map(labelOf)).toEqual(['超时'])
    // 首条写着 Y：没有缺的
    expect(judge('数据库连接池的密码是什么', '数据库连接池的密码放在密钥管理里，不写进配置').missingKeywords).toEqual([])
  })

  it('关键词整个没在首条出现、其余都在：列出缺的词，不判弱', () => {
    const v = judge('证书 过期 续期', '登录会话七天过期，活跃时自动续期')
    expect(v.missingKeywords.map(labelOf)).toEqual(['证书'])
    expect(v.weak).toBe(false)
  })

  it('英文查询里的介词、冠词没在首条出现，实词都在：没有缺的词', () => {
    expect(judge('cache invalidation with Redis', 'Cache invalidation: Redis keys are deleted after each write').missingKeywords).toEqual([])
    expect(judge('deploy to staging', 'Deploy staging builds from the release branch').missingKeywords).toEqual([])
    // 实词缺了照样列出
    expect(judge('deploy to staging', 'Deploy production builds from the release branch').missingKeywords.map(labelOf)).toEqual(['staging'])
  })

  it('两个关键词首条只对上中文那个：内容字过半，列出缺的词、不判弱', () => {
    const v = judge('Redis 缓存', '更新数据后先写库再删缓存')
    expect(v.missingKeywords.map(labelOf)).toEqual(['Redis'])
    expect(v.weak).toBe(false)
  })

  it('中英混写的查询：两个汉字约等于一个英文词，判定不随首条用哪种语言写而变', () => {
    expect(judge('防抖 debounce', '前端搜索输入框防抖 300 毫秒').weak).toBe(false)
    expect(judge('防抖 debounce', 'search input debounce 300ms').weak).toBe(false)
    expect(judge('Redis 哨兵', '哨兵模式三节点').weak).toBe(false)
    expect(judge('Redis 哨兵', 'Redis 单机部署').weak).toBe(false)
  })

  it('三个关键词首条只对上一个：不到一半，判弱', () => {
    const v = judge('Redis 缓存 哨兵', '更新数据后先写库再删缓存')
    expect(v.missingKeywords.map(labelOf)).toEqual(['Redis', '哨兵'])
    expect(v.weak).toBe(true)
  })

  it('什么都没命中（只有子串档）覆盖度为 0，判弱', () => {
    const v = judge('周报 模板', '无关内容')
    expect(v.coverage).toBe(0)
    expect(v.weak).toBe(true)
  })
})

describe('逐词命中条数', () => {
  it('每个关键词各算一条：完整出现在记录里才算', () => {
    const records = ['配置中心', '定时任务每天跑', '用 cron 定时清理', '无关']
    const q = '定时任务 cron 配置'
    const tokens = tokensOf(q)
    const rows = records.map(t => hitsIn(t, tokens))
    expect(termHitCounts(groupQueryTerms(q, tokens, tokenize), tokens, rows)).toEqual([
      { label: '定时任务', count: 1 },
      { label: 'cron', count: 1 },
      { label: '配置', count: 1 },
    ])
  })

  it('只列整词和词长的内容段，不列二字碎片、单字和长短语；同名的只列一次', () => {
    const q = '模板 怎么热生效 模板'
    const tokens = tokensOf(q)
    const rows = ['模板改了立即生效'].map(t => hitsIn(t, tokens))
    expect(termHitCounts(groupQueryTerms(q, tokens, tokenize), tokens, rows)).toEqual([
      { label: '模板', count: 1 },
      { label: '热生效', count: 0 },
    ])
    const q2 = '前端埋点数据怎么上报到服务端'
    const t2 = tokensOf(q2)
    const r2 = ['前端数据上报'].map(t => hitsIn(t, t2))
    expect(termHitCounts(groupQueryTerms(q2, t2, tokenize), t2, r2)).toEqual([])
    const q3 = '周报模板应该放在哪个目录'
    const t3 = tokensOf(q3)
    const r3 = ['邮件模板放在 templates 目录'].map(t => hitsIn(t, t3))
    expect(termHitCounts(groupQueryTerms(q3, t3, tokenize), t3, r3)).toEqual([
      { label: '周报模板', count: 0 },
      { label: '目录', count: 1 },
    ])
  })
})

describe('逐条对上的词', () => {
  /** 一条记录（原文 text）完整对上了查询里的哪些词。 */
  const matched = (query: string, text: string) => {
    const tokens = tokensOf(query)
    return matchedTerms(groupQueryTerms(query, tokens, tokenize), tokens, hitsIn(text, tokens))
  }

  it('中文句子按内容段算：对上的是整段，不是二字碎片', () => {
    expect(matched('周报模板怎么归档', '周报模板放在 docs 下')).toEqual(['周报模板'])
    expect(matched('周报模板怎么归档', '周报模板按月归档')).toEqual(['周报模板', '归档'])
  })

  it('英文词按它切出的 token 全命中才算；中英混写各算一个词', () => {
    expect(matched('cron deploy', 'cron job runs nightly')).toEqual(['cron'])
    expect(matched('定时任务 cron', '定时任务每天跑')).toEqual(['定时任务'])
    expect(matched('定时任务 cron', '用 cron 跑定时任务')).toEqual(['定时任务', 'cron'])
  })

  it('只盖住一个词的一部分不算对上：中文段缺字、记录一个 token 都没命中', () => {
    expect(matched('模板 热生效', '改完立即生效')).toEqual([])
    expect(matched('模板 热生效', 'id 前缀子串')).toEqual([])
  })

  it('虚词不列', () => {
    expect(matched('how to configure cron', 'how to configure cron')).toEqual(['configure', 'cron'])
    expect(matched('模板 怎么热生效 吗', '模板热生效吗')).toEqual(['模板', '热生效'])
  })

  it('命中了 token 但没有完整的词时返回空：foo-bar 只含 foo；长句段被筛词规则滤掉', () => {
    expect(matched('foo-bar', 'foo only')).toEqual([])
    expect(matched('数据库连接池 zebra', '数据库连接池的上限是 20')).toEqual([])
  })

  it('和逐词命中条数同一口径：标注里的词在计数行里都有，且这条记录算进了它的条数', () => {
    const cases: [string, string[]][] = [
      ['周报模板怎么归档 docs', ['周报模板放在 docs 下', '按月归档', '无关']],
      ['数据库连接池 zebra 密码', ['数据库连接池的密码', 'zebra 斑马']],
      ['foo-bar cron 定时任务', ['foo only', 'cron 定时任务', 'foo-bar']],
    ]
    for (const [q, records] of cases) {
      const tokens = tokensOf(q)
      const groups = groupQueryTerms(q, tokens, tokenize)
      for (const text of records) {
        const hits = hitsIn(text, tokens)
        const counts = termHitCounts(groups, tokens, [hits])
        for (const label of matchedTerms(groups, tokens, hits)) {
          expect(counts.find(c => c.label === label)?.count, `${q} / ${text} / ${label}`).toBe(1)
        }
        // 反过来也成立：这条记录在计数里算命中的词，标注里都列了
        expect(matchedTerms(groups, tokens, hits)).toEqual(counts.filter(c => c.count === 1).map(c => c.label))
      }
    }
  })
})
