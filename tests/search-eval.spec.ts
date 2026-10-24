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
import { RANKING_FIELDS, TIER_ORDER, type SearchTier } from '../src/search/ranking.ts'
import { defaultJiebaLoader, resetJieba, tokenizerForQuery, type JiebaLoader } from '../src/search/jieba-segmenter.ts'
import { executeSearch, type SearchToolDeps } from '../src/tools/search.ts'
import type { SearchNoteCode } from '../src/contract-codes.ts'
import { fakeExec } from './helpers/exec.ts'
import { EVAL_CATEGORIES, EVAL_QUERIES, EVAL_RECORDS, type EvalQuery } from './fixtures/search-eval.ts'

// 评估集回归（语料与查询见 tests/fixtures/search-eval.ts，逐条对比与调参用 scripts/eval-search.ts）。
// 两层：① 与权重无关的不变量逐条断言；② bigram 与 jieba 两档的 top-1 / top-3 聚合下限，不逐条断言。
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

/** 用生产分词器（当前档）独立算出每条记录相对查询的档位；不在任何档返回 undefined。 */
async function tierOracle(query: string): Promise<(r: MemoryRecord) => SearchTier | undefined> {
  const tokenize = await tokenizerForQuery(query, { log: silent })
  const tokens = [...new Set(tokenize(query))].filter(t => !isNoiseTerm(t))
  const legacy = expandQueryTerms(query)
  return r => {
    const fieldTokens = RANKING_FIELDS.flatMap(f => tokenize(f === 'tags' ? r.tags.join(' ') : r[f]))
    const hit = tokens.filter(t => fieldTokens.includes(t)).length
    if (hit > 0) return hit === tokens.length ? 'all' : 'partial'
    return matchScore(r, legacy) > 0 ? 'substring' : undefined
  }
}

const expectedNote = (tiers: SearchTier[]): SearchNoteCode | undefined =>
  tiers.length === 0 || tiers.includes('all') ? undefined : tiers.includes('partial') ? 'or-fallback' : 'substring-fallback'

describe('评估语料本身', () => {
  it('60 到 100 条、四个字段齐全、正文一百到五百字；查询覆盖七类，预期 id 都在语料里', () => {
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
          expect(r.noteCode, q.query).toBe(expectedNote(tiers as SearchTier[]))
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

  it('三种说明码在评估语料上的触发：全命中无码；只有部分命中 or-fallback；只有子串 substring-fallback', async () => {
    useTier('bigram')
    expect((await search('pnpm lockfile')).noteCode).toBeUndefined()
    expect((await search('pnpm zzqqxx')).noteCode).toBe('or-fallback')
    const sub = await search('memor')
    expect(sub.hits.length).toBeGreaterThan(0)
    expect(sub.noteCode).toBe('substring-fallback')
  })
})

// ---- 聚合下限 ----
//
// 门槛 = 定稿参数下首次跑出的命中数减去余量（bigram 与 jieba 各一组）。48 条查询下，首次结果：
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

describe('聚合下限', { timeout: 60_000 }, () => {
  for (const tier of ['bigram', 'jieba'] as const) {
    it.skipIf(tier === 'jieba' && jiebaProbe !== undefined)(`${tier} 档 top-1 ≥ ${FLOORS[tier].top1}、top-3 ≥ ${FLOORS[tier].top3}（共 ${EVAL_QUERIES.length} 条）`, async () => {
      useTier(tier)
      let top1 = 0
      let top3 = 0
      for (const q of EVAL_QUERIES) {
        const r = rankOf(q, (await search(q.query)).hits.map(h => h.id))
        if (r === 1) top1++
        if (r <= 3) top3++
      }
      expect(top1).toBeGreaterThanOrEqual(FLOORS[tier].top1)
      expect(top3).toBeGreaterThanOrEqual(FLOORS[tier].top3)
    })
  }
})
