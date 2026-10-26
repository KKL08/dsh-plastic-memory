import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore } from '../src/store.ts'
import { FileTable } from '../src/storage/file-table.ts'
import { InMemoryKvTable } from '../src/kv-table.ts'
import { encodeRecord } from '../src/storage/frontmatter.ts'
import { GLOBAL_DIR } from '../src/storage/paths.ts'
import type { RecallStats } from '../src/storage/schema.ts'
import type { MemoryRecord } from '../src/record-schema.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'
import { expandQueryTerms, matchScore } from '../src/text.ts'
import { RANKING_FIELDS, TIER_ORDER, isFullMatch, queryAliasGroups, substringEligible, type SearchTier } from '../src/search/ranking.ts'
import { defaultJiebaLoader, resetJieba, tokenizerForQuery, type JiebaLoader } from '../src/search/jieba-segmenter.ts'
import { executeSearch, type SearchToolDeps } from '../src/tools/search.ts'
import { WEAK_SEARCH_NOTE_CODES, type SearchNoteCode } from '../src/contract-codes.ts'
import { fakeExec } from './helpers/exec.ts'
import {
  BASELINE_ONLY_CATEGORIES, EVAL_CATEGORIES, EVAL_QUERIES, EVAL_RECORDS, NOTE_ONLY_CATEGORIES, PARAPHRASE_KINDS, STRICT_CATEGORIES,
  type EvalQuery,
} from './fixtures/search-eval.ts'

// 评估集回归（语料与查询见 tests/fixtures/search-eval.ts，逐条对比与调参用 scripts/eval-search.ts）。
// 两层：① 与权重无关的不变量逐条断言；② bigram 与 jieba 两档的 top-1 / top-3 聚合下限，不逐条断言。
// 锚点类（带标点的字面值）例外：逐条断言第一名，不计入聚合下限。
// 换说法类（paraphrase）只记基线：断言查询本身没写成字面能命中、两档都能跑出合法指标，不设分数线。
// 中英双写（bilingual）、长句（long-answerable）与库里没有答案（no-answer、long-no-answer）只评「命中弱」：
// 有答案的看首条对不对、判弱的有几条，没有答案的必须全部判弱。
// 跑在 FileTable 临时目录上走 executeSearch，与生产同一条路。

const jiebaProbe = await defaultJiebaLoader.importJieba().then(() => undefined, (err: unknown) => err instanceof Error ? err.message : String(err))
if (jiebaProbe !== undefined) console.log(`[search-eval] @node-rs/jieba 不可解析，跳过 jieba 档：${jiebaProbe}`)

/** bigram 档：让 jieba 加载失败（包不存在），查询分词退回二字切分，与可选依赖没装上时一致。 */
const missingJieba: JiebaLoader = {
  async importJieba() { throw Object.assign(new Error('search-eval: bigram 档'), { code: 'ERR_MODULE_NOT_FOUND' }) },
  readMainDictionary() { throw new Error('unreachable') },
}
const useTier = (tier: 'bigram' | 'jieba') => resetJieba(tier === 'bigram' ? missingJieba : undefined)

const registry = buildTypeRegistry({ template: 'coding', customTypes: {} })
const silent = { warn() {} }
let root: string
let deps: SearchToolDeps

// 语料直接按文件格式写进 global 目录（逐条 store.put 会每次重写索引，全量并行跑时超出钩子时限）；读取仍走 FileTable
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'pm-eval-'))
  await mkdir(join(root, GLOBAL_DIR))
  await Promise.all(EVAL_RECORDS.map(r => writeFile(join(root, GLOBAL_DIR, `${r.id}.md`), encodeRecord(r, {}), 'utf8')))
  const store = new MemoryStore(new FileTable({ root, stats: new InMemoryKvTable<RecallStats>() }))
  deps = { store, registry, tokenizer: { log: silent }, resolveContext: async () => ({ workspacePath: undefined, session: { id: 's', lastSeq: 1 } }) }
})
afterAll(async () => {
  resetJieba()
  await rm(root, { recursive: true, force: true })
})

const search = (query: string, limit = 10) => executeSearch({ query, limit }, fakeExec(), deps)

/** 与执行器同一条清洗规则（纯数字、单个非 CJK 字符不作 token），用来独立判定每条命中的档位。 */
const CJK_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u
const isNoiseTerm = (t: string) => /^\p{N}+$/u.test(t) || ([...t].length === 1 && !CJK_CHAR.test(t))
const byId = new Map(EVAL_RECORDS.map(r => [r.id, r]))

/** 用生产分词器（当前档）独立算出每条记录相对查询的档位；不在任何档返回 undefined。
 * token 命中 = 某字段分词含它，或某字段小写原文以子串含它；全命中按别名组算（组内任一写法全命中即可）。 */
async function tierOracle(query: string): Promise<(r: MemoryRecord) => SearchTier | undefined> {
  const tokenize = await tokenizerForQuery(query, { log: silent })
  const tokens = [...new Set(tokenize(query))].filter(t => !isNoiseTerm(t))
  const eligible = substringEligible(tokens)
  const legacy = expandQueryTerms(query)
  const aliasGroups = queryAliasGroups(query, tokens, tokenize)
  return r => {
    const texts = RANKING_FIELDS.map(f => f === 'tags' ? r.tags.join(' ') : r[f])
    const fieldTokens = texts.flatMap(t => tokenize(t))
    const hits = tokens.map((t, i) => fieldTokens.includes(t) || (eligible[i]! && texts.some(x => x.toLowerCase().includes(t))))
    if (hits.some(Boolean)) return isFullMatch(hits, aliasGroups) ? 'all' : 'partial'
    return matchScore(r, legacy) > 0 ? 'substring' : undefined
  }
}

/** 档位决定说明码属于哪一类：有全命中无码；只有子串档 substring-fallback；有部分命中时按首条覆盖度二选一。 */
const expectedNotes = (tiers: SearchTier[]): readonly (SearchNoteCode | undefined)[] =>
  tiers.length === 0 || tiers.includes('all') ? [undefined] : tiers.includes('partial') ? ['or-fallback', 'low-coverage'] : ['substring-fallback']

describe('评估语料本身', () => {
  it('60 到 100 条、四个字段齐全、正文一百到五百字；查询覆盖全部类别，预期 id 都在语料里', () => {
    expect(EVAL_RECORDS.length).toBeGreaterThanOrEqual(60)
    expect(EVAL_RECORDS.length).toBeLessThanOrEqual(100)
    expect(new Set(EVAL_RECORDS.map(r => r.id)).size).toBe(EVAL_RECORDS.length)
    for (const r of EVAL_RECORDS) {
      expect(r.name.length).toBeGreaterThan(0)
      expect(r.summary.length).toBeGreaterThan(0)
      expect(r.content.length).toBeGreaterThanOrEqual(100)
      expect(r.content.length).toBeLessThanOrEqual(500)
    }
    expect(EVAL_RECORDS.filter(r => r.tags.length > 0).length).toBeGreaterThan(EVAL_RECORDS.length * 0.9)
    expect(new Set(EVAL_QUERIES.map(q => q.category))).toEqual(new Set(EVAL_CATEGORIES))
    for (const q of EVAL_QUERIES) for (const id of q.relevant) expect(byId.has(id)).toBe(true)
  })
})

describe('不变量（与权重无关）', { timeout: 60_000 }, () => {
  it('id 直达：以任一条记忆的 id（前后带空白也行）为查询，该条排第一', async () => {
    useTier('bigram')   // id 不含汉字，两档同一分词器
    for (const r of EVAL_RECORDS) {
      expect((await search(` ${r.id} `, 3)).hits[0]?.id).toBe(r.id)
    }
  })

  it('零 token 查询：不做关键词过滤，按 confidence、lastConfirmedAt 降序，受 limit，不附说明码', async () => {
    useTier('bigram')
    const expected = [...EVAL_RECORDS]
      .sort((a, b) => b.confidence - a.confidence || b.lastConfirmedAt - a.lastConfirmedAt)
      .map(r => r.id)
    for (const q of ['', '   ', '\t\n']) {
      const r = await search(q, 50)
      expect(r.hits.map(h => h.id)).toEqual(expected.slice(0, 50))
      expect(r.noteCode).toBeUndefined()
    }
    expect((await search('', 5)).hits.map(h => h.id)).toEqual(expected.slice(0, 5))
  })

  for (const tier of ['bigram', 'jieba'] as const) {
    describe.skipIf(tier === 'jieba' && jiebaProbe !== undefined)(`${tier} 档`, () => {
      it('每条评估查询：全命中档在部分命中档之前、子串档在最后，说明码与返回列表的档位一致', async () => {
        useTier(tier)
        for (const q of EVAL_QUERIES.filter(q => q.category !== 'zero-token' && q.category !== 'id-direct')) {
          const oracle = await tierOracle(q.query)
          const r = await search(q.query, 50)
          const tiers = r.hits.map(h => oracle(byId.get(h.id)!))
          expect(tiers, q.query).not.toContain(undefined)
          const order = (tiers as SearchTier[]).map(t => TIER_ORDER[t])
          expect(order, q.query).toEqual([...order].sort((a, b) => a - b))
          expect(expectedNotes(tiers as SearchTier[]), q.query).toContain(r.noteCode)
        }
      })

      it('今天靠子串能命中的仍命中：旧逻辑全部词项命中的记录都在结果里（候选不超过 limit 的查询）', async () => {
        useTier(tier)
        let checked = 0
        for (const q of EVAL_QUERIES.filter(q => q.category !== 'zero-token')) {
          const oracle = await tierOracle(q.query)
          const candidates = EVAL_RECORDS.filter(r => oracle(r) !== undefined)
          if (candidates.length > 50) continue
          const legacy = expandQueryTerms(q.query)
          const legacyAll = EVAL_RECORDS.filter(r => matchScore(r, legacy) === legacy.length).map(r => r.id)
          const hits = (await search(q.query, 50)).hits.map(h => h.id)
          expect(hits, q.query).toEqual(expect.arrayContaining(legacyAll))
          checked++
        }
        expect(checked).toBeGreaterThan(EVAL_QUERIES.length / 2)   // 不是空过
      })
    })
  }

  it('四种说明码在评估语料上的触发：全命中无码；部分命中按首条覆盖度 or-fallback / low-coverage；只有 id 子串 substring-fallback', async () => {
    useTier('bigram')
    expect((await search('pnpm lockfile')).noteCode).toBeUndefined()
    expect((await search('pnpm zzqqxx')).noteCode).toBe('low-coverage')
    expect((await search('记忆文件手编后出处对不上怎么办')).noteCode).toBe('or-fallback')
    // memor 以子串出现在 memory 里，算全命中
    const fieldSub = await search('memor')
    expect(fieldSub.hits.length).toBeGreaterThan(0)
    expect(fieldSub.noteCode).toBeUndefined()
    // k7q2 只出现在 id 里
    const sub = await search('k7q2')
    expect(sub.hits.map(h => h.id)).toEqual(['mem_k7q2a1'])
    expect(sub.noteCode).toBe('substring-fallback')
  })
})

// ---- 聚合下限 ----
//
// 门槛 = 定稿参数下首次跑出的命中数减去余量（bigram 与 jieba 各一组）。只算进门槛的类别（48 条查询），首次结果：
//   bigram top-1 43、top-3 48；jieba top-1 45、top-3 48。
// 余量 top-1 留 2 条、top-3 留 1 条：调参或换分词器时允许个别查询换名次，掉得更多说明整体变差，先跑脚本看逐条差异。

interface Floor { top1: number; top3: number }
const FLOORS: Record<'bigram' | 'jieba', Floor> = {
  bigram: { top1: 41, top3: 47 },
  jieba: { top1: 43, top3: 47 },
}

function rankOf(q: EvalQuery, ids: string[]): number {
  const i = ids.findIndex(id => q.relevant.includes(id))
  return i < 0 ? Infinity : i + 1
}

const GATED_QUERIES = EVAL_QUERIES.filter(q => ![...BASELINE_ONLY_CATEGORIES, ...STRICT_CATEGORIES, ...NOTE_ONLY_CATEGORIES].includes(q.category))

describe('聚合下限', { timeout: 60_000 }, () => {
  for (const tier of ['bigram', 'jieba'] as const) {
    it.skipIf(tier === 'jieba' && jiebaProbe !== undefined)(`${tier} 档 top-1 ≥ ${FLOORS[tier].top1}、top-3 ≥ ${FLOORS[tier].top3}（共 ${GATED_QUERIES.length} 条）`, async () => {
      useTier(tier)
      let top1 = 0
      let top3 = 0
      for (const q of GATED_QUERIES) {
        const r = rankOf(q, (await search(q.query)).hits.map(h => h.id))
        if (r === 1) top1++
        if (r <= 3) top3++
      }
      expect(top1).toBeGreaterThanOrEqual(FLOORS[tier].top1)
      expect(top3).toBeGreaterThanOrEqual(FLOORS[tier].top3)
    })
  }
})

// ---- 锚点类：逐条第一名 ----
//
// 版本号、路径、带冒号的标识符被分词打散后，只差一个版本号的几条记录同分或分数相近，名次只看确认时间。
// 字面整词命中排序键让字面含该值的记录在同档内排前，所以每条都要第一名，不留余量。

const ANCHOR_QUERIES = EVAL_QUERIES.filter(q => STRICT_CATEGORIES.includes(q.category))

describe('锚点类（逐条第一名）', { timeout: 60_000 }, () => {
  it('版本号、路径、带冒号的标识符各有几条，含只差一个版本号的情形', () => {
    expect(ANCHOR_QUERIES.length).toBeGreaterThanOrEqual(9)
    expect(ANCHOR_QUERIES.some(q => /\d+\.\d+\.\d+-rc\.\d+/.test(q.query))).toBe(true)
    expect(ANCHOR_QUERIES.some(q => q.query.includes('/'))).toBe(true)
    expect(ANCHOR_QUERIES.some(q => q.query.includes(':'))).toBe(true)
  })

  for (const tier of ['bigram', 'jieba'] as const) {
    it.skipIf(tier === 'jieba' && jiebaProbe !== undefined)(`${tier} 档：每条锚点查询的第一名都是字面含该值的记录`, async () => {
      useTier(tier)
      const misses: string[] = []
      for (const q of ANCHOR_QUERIES) {
        const first = (await search(q.query)).hits[0]?.id
        if (first === undefined || !q.relevant.includes(first)) misses.push(`${q.query} → ${first ?? '（空）'}`)
      }
      expect(misses).toEqual([])
    })
  }
})

// ---- 换说法类：只记基线 ----
//
// 查询先只看记忆的 name 列表写，再对照全文标注相关集合。为了不写成「恰好能命中」，机械检查每条查询的主要实词
// 都不出现在相关记忆的 name、summary、tags、content 里。
// 主要实词 = 生产查询分词器（jieba 档，cutForSearch，含它切出的子词）切出的 token，去掉不足两个字符的，
// 再去掉下面这份疑问、语气、指代类虚词。出现 = 字段分词结果含它，或字段小写原文以子串含它。

const FUNCTION_WORDS = new Set([
  '怎么', '怎么办', '怎样', '什么', '哪个', '哪些', '多久', '多少', '是否', '要不要', '能不能', '可以',
  '应该', '一般', '还是', '时候', '我们', '自己', '有没有', '为什么', '如何', '一下',
])

const PARAPHRASES = EVAL_QUERIES.filter(q => q.category === 'paraphrase')

describe('换说法类（只记基线，不设分数线）', { timeout: 60_000 }, () => {
  it('15 到 20 条，四种换说法都有；相关记忆分散在不同类型，不挤在几条上', () => {
    expect(PARAPHRASES.length).toBeGreaterThanOrEqual(15)
    expect(PARAPHRASES.length).toBeLessThanOrEqual(20)
    for (const q of PARAPHRASES) {
      expect(q.paraphrase, q.query).toBeDefined()
      expect(q.relevant.length, q.query).toBeGreaterThan(0)
    }
    expect(new Set(PARAPHRASES.map(q => q.paraphrase))).toEqual(new Set(PARAPHRASE_KINDS))
    for (const kind of PARAPHRASE_KINDS) expect(PARAPHRASES.filter(q => q.paraphrase === kind).length, kind).toBeGreaterThanOrEqual(3)
    const relevantIds = PARAPHRASES.flatMap(q => q.relevant)
    expect(new Set(relevantIds.map(id => byId.get(id)!.type)).size).toBeGreaterThanOrEqual(5)
    for (const id of new Set(relevantIds)) expect(relevantIds.filter(x => x === id).length, id).toBeLessThanOrEqual(2)
  })

  it.skipIf(jiebaProbe !== undefined)('每条查询的主要实词都不出现在相关记忆的四个字段里', async () => {
    useTier('jieba')
    expect(PARAPHRASES.length).toBeGreaterThan(0)   // 不是空过
    for (const q of PARAPHRASES) {
      const tokenize = await tokenizerForQuery(q.query, { log: silent })
      const content = [...new Set(tokenize(q.query))].filter(t => [...t].length >= 2 && !FUNCTION_WORDS.has(t))
      expect(content.length, q.query).toBeGreaterThan(0)
      for (const id of q.relevant) {
        const r = byId.get(id)!
        for (const f of RANKING_FIELDS) {
          const text = f === 'tags' ? r.tags.join(' ') : r[f]
          const fieldTokens = new Set(tokenize(text))
          const lower = text.toLowerCase()
          const leaked = content.filter(t => fieldTokens.has(t) || lower.includes(t))
          expect(leaked, `${q.query} → ${id}.${f}`).toEqual([])
        }
      }
    }
  })

  for (const tier of ['bigram', 'jieba'] as const) {
    it.skipIf(tier === 'jieba' && jiebaProbe !== undefined)(`${tier} 档能跑通，top-1、top-3、MRR 是合法数值`, async () => {
      useTier(tier)
      let top1 = 0
      let top3 = 0
      let mrr = 0
      for (const q of PARAPHRASES) {
        const r = rankOf(q, (await search(q.query)).hits.map(h => h.id))
        if (r === 1) top1++
        if (r <= 3) top3++
        mrr += Number.isFinite(r) ? 1 / r : 0
      }
      mrr /= PARAPHRASES.length
      expect(top1).toBeGreaterThanOrEqual(0)
      expect(top3).toBeGreaterThanOrEqual(top1)
      expect(top3).toBeLessThanOrEqual(PARAPHRASES.length)
      expect(Number.isFinite(mrr)).toBe(true)
      expect(mrr).toBeGreaterThanOrEqual(0)
      expect(mrr).toBeLessThanOrEqual(1)
    })
  }
})

// ---- 命中弱 ----
//
// 判弱的说明码劝模型换词再搜。拿不准时偏向判弱：误判弱只多搜一轮，漏判弱会让模型把错的结果当答案。
// 所以库里没有答案的必须判弱；首条已经正确却判弱的只设上限。
// 改判弱口径前（只要没有全命中就判弱）的基线：评估集 93 条非零 token 查询里，bigram 判弱 61 条、其中首条正确 33 条；
// jieba 判弱 50 条、其中首条正确 24 条。加长句两类后（114 条），按覆盖查询文字四成判弱时：没有答案的长句 bigram 漏判 6 条、
// jieba 漏判 7 条。改成只数内容字、阈值 0.65 后：两档都不漏判；中英双写以外首条正确却判弱 bigram 5 条（长句）、
// jieba 3 条（长句 2、换说法 1）。中英双写改用 / 连成别名组后，8 条里 bigram 判弱 1 条（断线重连/reconnect：
// 记忆写的是「断线后的重连」，二字切分下中文写法不算完整出现）、jieba 0 条；空格分开的 2 条对照两档都判弱。

const WEAK_CORRECT_CEILING = 5
const NO_ANSWER_QUERIES = EVAL_QUERIES.filter(q => q.category !== 'zero-token' && q.relevant.length === 0)
const isWeak = (code: SearchNoteCode | undefined) => code !== undefined && (WEAK_SEARCH_NOTE_CODES as readonly string[]).includes(code)

describe('命中弱', { timeout: 60_000 }, () => {
  it('评估集有中英双写、库里没有答案、有答案的长句、没有答案的长句四类查询；没有答案的 relevant 为空', () => {
    expect(EVAL_QUERIES.filter(q => q.category === 'bilingual').length).toBeGreaterThanOrEqual(6)
    expect(EVAL_QUERIES.filter(q => q.category === 'no-answer').length).toBeGreaterThanOrEqual(6)
    expect(EVAL_QUERIES.filter(q => q.category === 'long-answerable').length).toBeGreaterThanOrEqual(8)
    expect(EVAL_QUERIES.filter(q => q.category === 'long-no-answer').length).toBeGreaterThanOrEqual(8)
    for (const q of EVAL_QUERIES.filter(q => q.category === 'no-answer' || q.category === 'long-no-answer')) expect(q.relevant).toEqual([])
  })

  for (const tier of ['bigram', 'jieba'] as const) {
    describe.skipIf(tier === 'jieba' && jiebaProbe !== undefined)(`${tier} 档`, () => {
      it('库里没有答案的查询（短词与长句）全部判弱', async () => {
        useTier(tier)
        const notWeak: string[] = []
        for (const q of NO_ANSWER_QUERIES) {
          const r = await search(q.query)
          expect(r.hits.length, q.query).toBeGreaterThan(0)   // 有常见词能部分命中，不是空结果
          if (!isWeak(r.noteCode)) notWeak.push(`${q.query} → ${r.noteCode ?? '无说明码'}`)
        }
        expect(notWeak).toEqual([])
      })

      it('中英双写、记忆只写了一种写法：首条都正确；用 / 连成别名组的至多 1 条判弱，空格分开的对照按两个关键词算、判弱', async () => {
        useTier(tier)
        const wrong: string[] = []
        const aliasWeak: string[] = []
        const controlNotWeak: string[] = []
        for (const q of EVAL_QUERIES.filter(q => q.category === 'bilingual')) {
          const r = await search(q.query)
          const first = r.hits[0]?.id
          if (first === undefined || !q.relevant.includes(first)) wrong.push(`${q.query} → ${first ?? '（空）'}`)
          if (q.query.includes('/') && isWeak(r.noteCode)) aliasWeak.push(q.query)
          if (!q.query.includes('/') && !isWeak(r.noteCode)) controlNotWeak.push(q.query)
        }
        expect(wrong).toEqual([])
        expect(aliasWeak.length, aliasWeak.join('、')).toBeLessThanOrEqual(1)
        expect(controlNotWeak).toEqual([])
      })

      it(`首条正确却判弱的查询不超过 ${WEAK_CORRECT_CEILING} 条（中英双写与库里没有答案的除外）`, async () => {
        useTier(tier)
        const weakCorrect: string[] = []
        for (const q of EVAL_QUERIES.filter(q => q.category !== 'zero-token' && q.category !== 'bilingual' && q.relevant.length > 0)) {
          const r = await search(q.query)
          if (isWeak(r.noteCode) && rankOf(q, r.hits.map(h => h.id)) === 1) weakCorrect.push(q.query)
        }
        expect(weakCorrect.length, weakCorrect.join('、')).toBeLessThanOrEqual(WEAK_CORRECT_CEILING)
      })
    })
  }
})
