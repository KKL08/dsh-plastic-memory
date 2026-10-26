/**
 * memory_search 评估：用 tests/fixtures/search-eval.ts 的语料与查询，打印 bigram 与 jieba 两档的
 * top-1 / top-3 / MRR、逐条差异，以及调参用的对照（切分模式、单字 token、字段权重、字段平均长度、BM25 对 BM25F）。
 * 手动运行，不进 CI：
 *
 *   node scripts/eval-search.ts            全部输出
 *   node scripts/eval-search.ts --brief    只打印两档指标与逐条差异
 *   node scripts/eval-search.ts --all      权重网格列出全部组合（缺省每种加权方式只列前 10）
 *
 * 两档的主结果走生产同一条路：语料写进 FileTable 临时目录，逐条调 executeSearch。
 * bigram 档靠注入一个「包不存在」的 jieba 加载器得到，与可选依赖没装上时的生产行为一致。
 * 对照部分在内存里跑 rankRecords + 真实分词器（换参数、换切分模式），开头先自检：生产参数下它与 executeSearch 逐条同序。
 * 生产用 BM25F；按字段分别饱和再加权的 BM25 与 jieba 的 cut 模式只在本脚本里实现，留作对照，不进 src。
 * 只记基线的类别（换说法）单独成行，不计入总数、逐条差异与调参对照；全部输出的末尾逐条列出它们的名次。
 * 逐条设门槛的类别（锚点）单独成行，不计入总数，但列进逐条差异与未进第一名。
 * 只评判弱的类别（中英双写、库里没有答案）单独成行，不计入总数与调参对照；「命中弱」一节按类别统计判弱条数。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { FileTable } from '../src/storage/file-table.ts'
import { InMemoryKvTable } from '../src/kv-table.ts'
import { MemoryStore } from '../src/store.ts'
import type { RecallStats } from '../src/storage/schema.ts'
import type { MemoryRecord } from '../src/record-schema.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'
import { executeSearch } from '../src/tools/search.ts'
import { expandQueryTerms, matchScore } from '../src/text.ts'
import { bigramSegmenter, createTokenizer, type CjkSegmenter } from '../src/search/tokenizer.ts'
import { defaultJiebaLoader, resetJieba, type JiebaInstance } from '../src/search/jieba-segmenter.ts'
import {
  RANKING_FIELDS, RANKING_PARAMS, anchorTerms, compareRanked, countAnchorHits, isFullMatch, queryAliasGroups, rankRecords, substringEligible,
  type RankedRecord, type RankingField, type RankingParams, type SearchTier,
} from '../src/search/ranking.ts'
import { WEAK_SEARCH_NOTE_CODES, type SearchNoteCode } from '../src/contract-codes.ts'
import {
  BASELINE_ONLY_CATEGORIES, EVAL_CATEGORIES, EVAL_QUERIES, EVAL_RECORDS, NOTE_ONLY_CATEGORIES, STRICT_CATEGORIES, type EvalQuery,
} from '../tests/fixtures/search-eval.ts'

const { values: argv } = parseArgs({ options: { brief: { type: 'boolean', default: false }, all: { type: 'boolean', default: false } } })

const LIMIT = 10
type Ranking = string[]
type Results = Map<EvalQuery, Ranking>
/** 生产路径每条查询的说明码（判弱统计用）。 */
type NoteCodes = Map<EvalQuery, SearchNoteCode | undefined>

// ---------------- 指标 ----------------

/** 第一条相关记录的名次（1 起）；前 LIMIT 名里没有为 Infinity。 */
function rankOf(q: EvalQuery, ids: Ranking): number {
  const i = ids.findIndex(id => q.relevant.includes(id))
  return i < 0 ? Infinity : i + 1
}

interface Metrics { top1: number; top3: number; mrr: number; n: number }

/** 计入聚合门槛的查询；只记基线、逐条设门槛、只评判弱的类别都不算进总数和调参对照。 */
const isGated = (q: EvalQuery) => ![...BASELINE_ONLY_CATEGORIES, ...STRICT_CATEGORIES, ...NOTE_ONLY_CATEGORIES].includes(q.category)
const GATED_QUERIES = EVAL_QUERIES.filter(isGated)
/** 列进逐条差异与未进第一名的查询：聚合门槛的加上逐条设门槛的。 */
const LISTED_QUERIES = EVAL_QUERIES.filter(q => !BASELINE_ONLY_CATEGORIES.includes(q.category) && !NOTE_ONLY_CATEGORIES.includes(q.category))

function metrics(results: Results, filter: (q: EvalQuery) => boolean = isGated): Metrics {
  let top1 = 0, top3 = 0, mrr = 0, n = 0
  for (const [q, ids] of results) {
    if (!filter(q)) continue
    const r = rankOf(q, ids)
    n++
    if (r === 1) top1++
    if (r <= 3) top3++
    mrr += Number.isFinite(r) ? 1 / r : 0
  }
  return { top1, top3, mrr: n === 0 ? 0 : mrr / n, n }
}

const fmt = (m: Metrics) => `top-1 ${m.top1}/${m.n}  top-3 ${m.top3}/${m.n}  MRR ${m.mrr.toFixed(3)}`

// ---------------- 生产路径：FileTable + executeSearch ----------------

const registry = buildTypeRegistry({ template: 'coding', customTypes: {} })
const exec = { signal: new AbortController().signal } as ToolRunContext
const silent = { warn() {} }

/** 让 jieba 加载失败（包不存在）：查询分词退回 bigram，与可选依赖缺失时一致。 */
const missingJieba = {
  async importJieba(): Promise<never> { throw Object.assign(new Error('eval: bigram 档'), { code: 'ERR_MODULE_NOT_FOUND' }) },
  readMainDictionary(): Uint8Array { throw new Error('unreachable') },
}

async function productionRun(store: MemoryStore, tier: 'bigram' | 'jieba'): Promise<{ results: Results; notes: NoteCodes }> {
  resetJieba(tier === 'bigram' ? missingJieba : undefined)
  const deps = {
    store, registry, tokenizer: { log: silent },
    resolveContext: async () => ({ workspacePath: undefined, session: { id: 'eval', lastSeq: 1 } }),
  }
  const results: Results = new Map()
  const notes: NoteCodes = new Map()
  for (const q of EVAL_QUERIES) {
    const r = await executeSearch({ query: q.query, limit: LIMIT }, exec, deps)
    results.set(q, r.hits.map(h => h.id))
    notes.set(q, r.noteCode)
  }
  resetJieba()
  return { results, notes }
}

// ---------------- 对照路径：内存里的 rankRecords + 真实分词器 ----------------

const HAN = /\p{Script=Han}/u
const HAN_OR_OTHER = /\p{Script=Han}+|[^\p{Script=Han}]+/gu
const CJK_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u

type SegmentMode = 'cut' | 'cutForSearch'
/** 生产只用 cutForSearch，最小接口里没有 cut；真实实例两种都有，对照时补上类型。 */
type JiebaBothModes = JiebaInstance & { cut(text: string, hmm: boolean): string[] }

function jiebaTokenizer(jieba: JiebaBothModes, mode: SegmentMode): (text: string) => string[] {
  const cjk: CjkSegmenter = {
    segment(run) {
      const out: string[] = []
      for (const [part] of run.matchAll(HAN_OR_OTHER)) {
        if (!HAN.test(part)) out.push(...bigramSegmenter.segment(part))
        else out.push(...(mode === 'cut' ? jieba.cut(part, true) : jieba.cutForSearch(part, true)))
      }
      return out
    },
  }
  return createTokenizer({ cjk })
}

interface Variant {
  /** 'bigram'，或 jieba 的某种切分模式。 */
  segmenter: 'bigram' | SegmentMode
  /** 查询 token 清洗时是否剔除单个 CJK 字（生产：保留）。 */
  dropSingleCjk: boolean
  params: RankingParams
  scoring: Scoring
}

const bigramTok = createTokenizer()
let jiebaInstance: JiebaBothModes | undefined

function tokenizerFor(v: Variant, query: string): (text: string) => string[] {
  // 与生产一致：查询不含汉字时两侧都用 bigram
  if (v.segmenter === 'bigram' || !HAN.test(query) || jiebaInstance === undefined) return bigramTok
  return jiebaTokenizer(jiebaInstance, v.segmenter)
}

function isNoiseTerm(term: string, dropSingleCjk: boolean): boolean {
  return /^\p{N}+$/u.test(term) || ([...term].length === 1 && (dropSingleCjk || !CJK_CHAR.test(term)))
}

const fieldText = (r: MemoryRecord, f: RankingField) => (f === 'tags' ? r.tags.join(' ') : r[f])

type Scoring = 'bm25' | 'bm25f'

/**
 * 两种加权方式的本地实现（档位、df、idf 与 rankRecords 同口径）：
 * - bm25：每个字段各自做长度归一与词频饱和，字段分乘权重后相加；
 * - bm25f：每个字段的词频先按该字段长度归一、乘字段权重，跨字段相加后统一做一次饱和。
 * 生产用其中一种（PRODUCTION_SCORING），对照路径对它走 rankRecords；本地实现留给另一种，并参与自检。
 */
function rankLocal(scoring: Scoring, query: string, tokens: readonly string[], legacyTerms: readonly string[], anchors: readonly string[], records: readonly MemoryRecord[], tokenize: (t: string) => string[], p: RankingParams): RankedRecord[] {
  const aliasGroups = queryAliasGroups(query, tokens, tokenize)
  const index = new Map(tokens.map((t, i) => [t, i] as const))
  const eligible = substringEligible(tokens)
  const docs = records.map(record => {
    const tf = RANKING_FIELDS.map(() => new Array<number>(tokens.length).fill(0))
    const texts = RANKING_FIELDS.map(f => fieldText(record, f))
    const len = texts.map(t => t.length)
    RANKING_FIELDS.forEach((f, fi) => {
      for (const tok of tokenize(texts[fi]!)) {
        const i = index.get(tok)
        if (i !== undefined) tf[fi]![i]!++
      }
    })
    // 与 rankRecords 同一条命中规则：有词频，或（可做子串检查的 token）字段小写原文以子串含它
    const lower = texts.map(t => t.toLowerCase())
    const hit = tokens.map((tok, i) => tf.some(row => row[i]! > 0) || (eligible[i]! && lower.some(t => t.includes(tok))))
    // df 只数有词频的文档，与生产一致
    return { record, tf, len, hit }
  })
  const df = tokens.map((_, i) => docs.filter(d => d.tf.some(row => row[i]! > 0)).length)
  const N = records.length
  const idf = df.map(d => Math.log(1 + (N - d + 0.5) / (d + 0.5)))
  const lengthNorm = (fi: number, len: number) => 1 - p.b + p.b * len / p.fields[RANKING_FIELDS[fi]!].avgLength
  const out: RankedRecord[] = []
  for (const d of docs) {
    const hitCount = d.hit.filter(Boolean).length
    if (tokens.length > 0 && hitCount > 0) {
      let score = 0
      tokens.forEach((_, i) => {
        if (scoring === 'bm25') {
          RANKING_FIELDS.forEach((f, fi) => {
            const tf = d.tf[fi]![i]!
            if (tf > 0) score += p.fields[f].weight * idf[i]! * tf * (p.k1 + 1) / (tf + p.k1 * lengthNorm(fi, d.len[fi]!))
          })
        } else {
          let wtf = 0
          RANKING_FIELDS.forEach((f, fi) => { wtf += p.fields[f].weight * d.tf[fi]![i]! / lengthNorm(fi, d.len[fi]!) })
          if (wtf > 0) score += idf[i]! * wtf * (p.k1 + 1) / (wtf + p.k1)
        }
      })
      out.push({ record: d.record, tier: isFullMatch(d.hit, aliasGroups) ? 'all' : 'partial', anchorHits: countAnchorHits(d.record, anchors), score, tokenHits: d.hit })
      continue
    }
    const legacy = legacyTerms.length > 0 ? matchScore(d.record, legacyTerms as string[]) : 0
    if (legacy > 0) out.push({ record: d.record, tier: 'substring', anchorHits: countAnchorHits(d.record, anchors), score: legacy, tokenHits: d.hit })
  }
  return out
}

/** 与 executeSearch 同序：清洗 token → 分档打分 → 排序 → id 直达 → 截断。 */
function runVariant(v: Variant, queries: readonly EvalQuery[] = EVAL_QUERIES, records: readonly MemoryRecord[] = EVAL_RECORDS): Results {
  const out: Results = new Map()
  for (const q of queries) {
    const tokenize = tokenizerFor(v, q.query)
    const tokens = [...new Set(tokenize(q.query))].filter(t => !isNoiseTerm(t, v.dropSingleCjk))
    const legacyTerms = expandQueryTerms(q.query)
    const anchors = anchorTerms(q.query)
    let ranked: RankedRecord[]
    if (tokens.length === 0 && legacyTerms.length === 0) {
      ranked = records.map(record => ({ record, tier: 'all' as SearchTier, anchorHits: 0, score: 0, tokenHits: [] }))
    } else if (v.scoring === PRODUCTION_SCORING) {
      ranked = rankRecords({ tokens, legacyTerms, anchors, aliasGroups: queryAliasGroups(q.query, tokens, tokenize), records, listedCount: records.length, tokenize, params: v.params })
    } else {
      ranked = rankLocal(v.scoring, q.query, tokens, legacyTerms, anchors, records, tokenize, v.params)
    }
    ranked.sort(compareRanked)
    const direct = ranked.findIndex(e => e.record.id === q.query.trim())
    if (direct > 0) ranked.unshift(...ranked.splice(direct, 1))
    out.set(q, ranked.slice(0, LIMIT).map(e => e.record.id))
  }
  return out
}

/** 与 runVariant 相同，但两种加权方式都走本地实现：自检本地实现与 rankRecords 是否一致。 */
function runVariantLocal(v: Variant): Results {
  const out: Results = new Map()
  for (const q of EVAL_QUERIES) {
    const tokenize = tokenizerFor(v, q.query)
    const tokens = [...new Set(tokenize(q.query))].filter(t => !isNoiseTerm(t, v.dropSingleCjk))
    const legacyTerms = expandQueryTerms(q.query)
    if (tokens.length === 0 && legacyTerms.length === 0) { out.set(q, runVariant(v, [q]).get(q)!); continue }
    const ranked = rankLocal(v.scoring, q.query, tokens, legacyTerms, anchorTerms(q.query), EVAL_RECORDS, tokenize, v.params).sort(compareRanked)
    const direct = ranked.findIndex(e => e.record.id === q.query.trim())
    if (direct > 0) ranked.unshift(...ranked.splice(direct, 1))
    out.set(q, ranked.slice(0, LIMIT).map(e => e.record.id))
  }
  return out
}

/** 字段探针：tests/search-ranking.spec.ts「字段权重」的四条用例，同样的记录与查询，预期第一名。 */
const probeRecord = (id: string, name: string, summary: string, content: string): MemoryRecord => ({ ...EVAL_RECORDS[0]!, id, name, summary, content, tags: [] })
const ORDINARY_BODY = '上线前先在预发环境演练一遍，确认监控面板、告警规则、数据库连接池配置都正常；'
  + '值守的人要提前在频道里报到，出了问题按预案处理，处理完把时间线和原因补进复盘文档，'
  + '下次上线前再对照复盘文档检查一遍。必要时执行 rollback。'
const FIELD_PROBES: { query: string; records: MemoryRecord[]; first: string }[] = [
  {
    query: 'rollback', first: 'mem_name', records: [
      probeRecord('mem_content', '普通条目', '普通摘要', ORDINARY_BODY),
      probeRecord('mem_name', 'rollback 流程', '普通摘要', '正文与查询无关'),
    ],
  },
  {
    query: 'rollback', first: 'mem_content', records: [
      probeRecord('mem_content', '普通条目', '普通摘要', 'rollback rollback rollback 的正文'),
      probeRecord('mem_name', 'rollback 流程', '普通摘要', '正文与查询无关'),
    ],
  },
  {
    query: 'deploy hook rollback', first: 'mem_body', records: [
      probeRecord('mem_name_only', 'deploy 脚本位置', '脚本放哪', '放在 scripts 目录下，与其他事无关'),
      probeRecord('mem_body', '上线说明', '上线前后要做的事', 'deploy 之前先跑 hook；deploy 失败就 rollback，rollback 之后再查 hook 日志；deploy 成功也要看 hook 输出'),
    ],
  },
  {
    query: 'deploy', first: 'mem_body', records: [
      probeRecord('mem_name_only', 'deploy 脚本', '脚本位置', '放在 scripts 目录下'),
      probeRecord('mem_body', '部署说明', 'deploy 流程与注意事项', 'deploy 分三步：先 deploy 到预发，再 deploy 到灰度，最后 deploy 到全量；每一步都要确认健康检查通过'),
    ],
  },
]

function probePasses(v: Pick<Variant, 'scoring' | 'params'>): number {
  const variant: Variant = { segmenter: 'bigram', dropSingleCjk: false, ...v }
  return FIELD_PROBES.filter(p => {
    const q: EvalQuery = { query: p.query, category: 'plain-name', relevant: [p.first] }
    return runVariant(variant, [q], p.records).get(q)![0] === p.first
  }).length
}

// ---------------- 参数构造 ----------------

type Weights = Record<RankingField, number>
type Lengths = Record<RankingField, number>

function params(weights: Weights, lengths: Lengths, base: { k1: number; b: number } = RANKING_PARAMS): RankingParams {
  return {
    k1: base.k1, b: base.b,
    fields: Object.fromEntries(RANKING_FIELDS.map(f => [f, { weight: weights[f], avgLength: lengths[f] }])) as RankingParams['fields'],
  }
}

const currentWeights = Object.fromEntries(RANKING_FIELDS.map(f => [f, RANKING_PARAMS.fields[f].weight])) as Weights
const currentLengths = Object.fromEntries(RANKING_FIELDS.map(f => [f, RANKING_PARAMS.fields[f].avgLength])) as Lengths
/** 调参前按常识给的字段平均长度初值，留作对照。 */
const INITIAL_LENGTHS: Lengths = { name: 12, summary: 40, tags: 16, content: 300 }
const measuredLengths = Object.fromEntries(RANKING_FIELDS.map(f => [
  f, EVAL_RECORDS.reduce((s, r) => s + fieldText(r, f).length, 0) / EVAL_RECORDS.length,
])) as Lengths

// ---------------- 输出 ----------------

const name = (id: string) => EVAL_RECORDS.find(r => r.id === id)?.name ?? id
const top3 = (ids: Ranking) => ids.slice(0, 3).map(id => `${id}「${name(id)}」`).join('、') || '（空）'
const rankStr = (r: number) => (Number.isFinite(r) ? String(r) : '—')

function printTierMetrics(label: string, results: Results): void {
  console.log(`${label.padEnd(8)} ${fmt(metrics(results))}`)
  for (const c of EVAL_CATEGORIES) {
    const note = BASELINE_ONLY_CATEGORIES.includes(c) ? '  （只记基线，不计入上面的总数）'
      : STRICT_CATEGORIES.includes(c) ? '  （逐条要第一名，不计入上面的总数）'
        : NOTE_ONLY_CATEGORIES.includes(c) ? '  （只评判弱，不计入上面的总数）' : ''
    console.log(`  ${c.padEnd(13)} ${fmt(metrics(results, q => q.category === c))}${note}`)
  }
}

function printDiff(a: Results, b: Results, labelA: string, labelB: string, onlyChanged = true): void {
  for (const q of LISTED_QUERIES) {
    const ra = rankOf(q, a.get(q)!), rb = rankOf(q, b.get(q)!)
    const sameTop3 = a.get(q)!.slice(0, 3).join() === b.get(q)!.slice(0, 3).join()
    if (onlyChanged && ra === rb && sameTop3) continue
    console.log(`- [${q.category}] ${JSON.stringify(q.query)}  预期 ${q.relevant.join(' / ')}  名次 ${labelA} ${rankStr(ra)} → ${labelB} ${rankStr(rb)}`)
    console.log(`    ${labelA}: ${top3(a.get(q)!)}`)
    console.log(`    ${labelB}: ${top3(b.get(q)!)}`)
  }
}

function printMisses(label: string, results: Results): void {
  const misses = LISTED_QUERIES.filter(q => rankOf(q, results.get(q)!) !== 1)
  console.log(`${label} 未进第一名（${misses.length} 条）：`)
  for (const q of misses) {
    console.log(`- [${q.category}] ${JSON.stringify(q.query)}  预期 ${q.relevant.join(' / ')}  名次 ${rankStr(rankOf(q, results.get(q)!))}`)
    console.log(`    ${top3(results.get(q)!)}`)
  }
}

/** 只记基线的类别：逐条列出两档名次与前三名。 */
function printBaselineOnly(tiers: [string, Results][]): void {
  for (const q of EVAL_QUERIES.filter(q => BASELINE_ONLY_CATEGORIES.includes(q.category))) {
    const kind = q.paraphrase === undefined ? '' : `/${q.paraphrase}`
    console.log(`- [${q.category}${kind}] ${JSON.stringify(q.query)}  预期 ${q.relevant.join(' / ')}  名次 ${tiers.map(([l, r]) => `${l} ${rankStr(rankOf(q, r.get(q)!))}`).join('、')}`)
    for (const [l, r] of tiers) console.log(`    ${l}: ${top3(r.get(q)!)}`)
  }
}

const isWeak = (code: SearchNoteCode | undefined) => code !== undefined && (WEAK_SEARCH_NOTE_CODES as readonly string[]).includes(code)

/**
 * 判弱统计：各类别判弱几条、其中首条正确的几条；逐条列出首条正确却判弱的（白搜一轮，应尽量少）、
 * 首条不对却没判弱的（模型会把错的当答案）与库里没有答案却没判弱的（应为 0）。零 token 查询不出说明码，不计。
 */
function printWeak(label: string, run: { results: Results; notes: NoteCodes }): void {
  const counted = EVAL_QUERIES.filter(q => q.category !== 'zero-token')
  const correct = (q: EvalQuery) => rankOf(q, run.results.get(q)!) === 1
  const weak = (q: EvalQuery) => isWeak(run.notes.get(q))
  const row = (qs: EvalQuery[]) => `判弱 ${qs.filter(weak).length}/${qs.length}，其中首条正确 ${qs.filter(q => weak(q) && correct(q)).length}`
  console.log(`${label.padEnd(8)} ${row(counted)}`)
  for (const c of EVAL_CATEGORIES.filter(c => c !== 'zero-token')) console.log(`  ${c.padEnd(16)} ${row(counted.filter(q => q.category === c))}`)
  const answerable = counted.filter(q => q.relevant.length > 0)
  for (const q of answerable.filter(q => weak(q) && correct(q))) console.log(`  首条正确却判弱：[${q.category}] ${JSON.stringify(q.query)}  ${run.notes.get(q)}`)
  for (const q of answerable.filter(q => !weak(q) && !correct(q))) console.log(`  首条不对却没判弱：[${q.category}] ${JSON.stringify(q.query)}  ${run.notes.get(q) ?? '无说明码'}`)
  for (const q of counted.filter(q => q.relevant.length === 0 && !weak(q))) console.log(`  没有答案却没判弱：[${q.category}] ${JSON.stringify(q.query)}  ${run.notes.get(q) ?? '无说明码'}`)
}

function sameOrder(a: Results, b: Results): EvalQuery[] {
  return EVAL_QUERIES.filter(q => a.get(q)!.join() !== b.get(q)!.join())
}

async function main(): Promise<void> {
  const lens = EVAL_RECORDS.map(r => r.content.length)
  const strictCount = EVAL_QUERIES.filter(q => STRICT_CATEGORIES.includes(q.category)).length
  console.log(`# memory_search 评估：${EVAL_RECORDS.length} 条记忆、${EVAL_QUERIES.length} 条查询（进聚合门槛 ${GATED_QUERIES.length} 条，逐条第一名 ${strictCount} 条，只记基线 ${EVAL_QUERIES.length - GATED_QUERIES.length - strictCount} 条；limit ${LIMIT}）`)
  console.log(`正文长度 ${Math.min(...lens)}–${Math.max(...lens)} 字符；字段平均长度实测 ${RANKING_FIELDS.map(f => `${f} ${measuredLengths[f].toFixed(1)}`).join('、')}`)

  const hasJieba = await defaultJiebaLoader.importJieba().then(J => {
    jiebaInstance = J.withDict(defaultJiebaLoader.readMainDictionary()) as JiebaBothModes
    return true
  }, (err: unknown) => {
    console.log(`jieba 不可用，只跑 bigram 档：${err instanceof Error ? err.message : String(err)}`)
    return false
  })

  const root = await mkdtemp(join(tmpdir(), 'pm-eval-'))
  try {
    const store = new MemoryStore(new FileTable({ root, stats: new InMemoryKvTable<RecallStats>() }))
    for (const r of EVAL_RECORDS) await store.put(r)

    console.log('\n## 两档指标（FileTable + executeSearch）\n')
    const runBigram = await productionRun(store, 'bigram')
    const prodBigram = runBigram.results
    printTierMetrics('bigram', prodBigram)
    const runJieba = hasJieba ? await productionRun(store, 'jieba') : undefined
    const prodJieba = runJieba?.results
    if (prodJieba) printTierMetrics('jieba', prodJieba)

    if (prodJieba) {
      console.log('\n## 逐条差异：bigram → jieba（名次或前三名有变化的查询）\n')
      printDiff(prodBigram, prodJieba, 'bigram', 'jieba')
      console.log()
      printMisses('jieba', prodJieba)
    }
    console.log()
    printMisses('bigram', prodBigram)

    console.log(`\n## 命中弱（${WEAK_SEARCH_NOTE_CODES.join(' / ')}）\n`)
    printWeak('bigram', runBigram)
    if (runJieba) printWeak('jieba', runJieba)
    if (argv.brief) return

    // 自检：对照路径在生产参数下与 executeSearch 逐条同序；本地实现的生产加权方式与 rankRecords 同序
    const prodVariant = (segmenter: Variant['segmenter']): Variant => ({ segmenter, dropSingleCjk: false, params: RANKING_PARAMS, scoring: PRODUCTION_SCORING })
    const drift = [
      ...sameOrder(prodBigram, runVariant(prodVariant('bigram'))),
      ...(prodJieba ? sameOrder(prodJieba, runVariant(prodVariant(PRODUCTION_MODE))) : []),
    ]
    const localDrift = sameOrder(runVariant(prodVariant('bigram')), runVariantLocal(prodVariant('bigram')))
    console.log(`\n自检：对照路径与 executeSearch 不同序 ${drift.length} 条；本地 ${PRODUCTION_SCORING} 与 rankRecords 不同序 ${localDrift.length} 条`
      + (drift.length + localDrift.length > 0 ? '（对照结果不可信，先修脚本）' : ''))
    for (const q of [...drift, ...localDrift]) console.log(`  ${JSON.stringify(q.query)}`)

    const tiers: Variant['segmenter'][] = hasJieba ? ['bigram', PRODUCTION_MODE] : ['bigram']

    if (hasJieba) {
      console.log('\n## 切分模式：cutForSearch 对 cut（jieba 档，生产参数）\n')
      const vs = runVariant(prodVariant('cutForSearch'))
      const vc = runVariant(prodVariant('cut'))
      console.log(`cutForSearch  ${fmt(metrics(vs))}`)
      console.log(`cut           ${fmt(metrics(vc))}`)
      printDiff(vs, vc, 'cutForSearch', 'cut')
    }

    console.log('\n## 单字 CJK token：保留对剔除（生产参数）\n')
    for (const seg of tiers) {
      const keep = runVariant(prodVariant(seg))
      const drop = runVariant({ ...prodVariant(seg), dropSingleCjk: true })
      console.log(`${seg.padEnd(13)} 保留 ${fmt(metrics(keep))}`)
      console.log(`${''.padEnd(13)} 剔除 ${fmt(metrics(drop))}`)
      printDiff(keep, drop, '保留', '剔除')
    }

    console.log('\n## 加权方式 × 字段权重 × 平均长度\n')
    const roundedLengths = Object.fromEntries(RANKING_FIELDS.map(f => [f, Math.round(measuredLengths[f])])) as Lengths
    console.log(`平均长度：当前常量 ${JSON.stringify(currentLengths)}；调参前初值 ${JSON.stringify(INITIAL_LENGTHS)}；语料实测取整 ${JSON.stringify(roundedLengths)}`)
    console.log('字段探针：tests/search-ranking.spec.ts「字段权重」四条（词频相当时 name 优先；正文反复出现胜过 name 碰巧含一次；name 平淡 content 全命中不被压；summary + content 胜过只在 name）')
    console.log('列：加权 | 权重 n/s/t/c | 长度 | bigram top-1 top-3 MRR | jieba top-1 top-3 MRR | plain-name top-1 (b/j) | 探针\n')
    const weightGrid: Weights[] = []
    for (const n of [1, 1.5, 2, 2.5, 3, 4]) for (const st of [1, 1.5, 2]) weightGrid.push({ name: n, summary: st, tags: st, content: 1 })
    const rows: { label: string; key: number[]; line: string }[] = []
    for (const scoring of ['bm25', 'bm25f'] as const) {
      for (const w of weightGrid) {
        for (const [lenLabel, lengths] of [['当前', currentLengths], ['初值', INITIAL_LENGTHS]] as const) {
          const p = params(w, lengths)
          const res = tiers.map(seg => runVariant({ segmenter: seg, dropSingleCjk: false, params: p, scoring }))
          const ms = res.map(r => metrics(r))
          const plain = res.map(r => metrics(r, q => q.category === 'plain-name').top1)
          const probes = probePasses({ scoring, params: p })
          const label = `${scoring.padEnd(5)} ${RANKING_FIELDS.map(f => w[f]).join('/').padEnd(11)} ${lenLabel}`
          const line = `${label}  ${ms.map(m => `${m.top1} ${m.top3} ${m.mrr.toFixed(3)}`).join(' | ')} | ${plain.join('/')} | ${probes}/${FIELD_PROBES.length}`
          rows.push({ label, key: [ms.reduce((a, m) => a + m.top1, 0), ms.reduce((a, m) => a + m.mrr, 0)], line })
        }
      }
    }
    // 每种加权方式各列前 10 名：先比两档 top-1 之和，再比 MRR 之和
    rows.sort((x, y) => y.key[0]! - x.key[0]! || y.key[1]! - x.key[1]!)
    for (const scoring of ['bm25', 'bm25f']) for (const r of rows.filter(r => r.label.startsWith(`${scoring} `)).slice(0, argv.all ? Infinity : 10)) console.log(r.line)
    const curLabel = `${PRODUCTION_SCORING.padEnd(5)} ${RANKING_FIELDS.map(f => currentWeights[f]).join('/').padEnd(11)} 当前`
    console.log('…')
    console.log(`生产 ${rows.find(r => r.label === curLabel)?.line ?? '（不在网格内）'}`)

    console.log('\n## BM25 对 BM25F：逐条差异（生产权重与长度）\n')
    for (const seg of tiers) {
      const a = runVariant({ ...prodVariant(seg), scoring: 'bm25' })
      const b = runVariant({ ...prodVariant(seg), scoring: 'bm25f' })
      console.log(`${seg.padEnd(13)} BM25  ${fmt(metrics(a))}   plain-name ${fmt(metrics(a, q => q.category === 'plain-name'))}`)
      console.log(`${''.padEnd(13)} BM25F ${fmt(metrics(b))}   plain-name ${fmt(metrics(b, q => q.category === 'plain-name'))}`)
      console.log(`${''.padEnd(13)} 探针 BM25 ${probePasses({ scoring: 'bm25', params: RANKING_PARAMS })}/${FIELD_PROBES.length}、BM25F ${probePasses({ scoring: 'bm25f', params: RANKING_PARAMS })}/${FIELD_PROBES.length}`)
      printDiff(a, b, 'BM25', 'BM25F')
    }

    console.log(`\n## 只记基线的类别（${BASELINE_ONLY_CATEGORIES.join('、')}）：逐条名次\n`)
    printBaselineOnly(prodJieba ? [['bigram', prodBigram], ['jieba', prodJieba]] : [['bigram', prodBigram]])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

/** 生产所用的 jieba 切分模式与加权方式（对照路径据此自检）。 */
const PRODUCTION_MODE: SegmentMode = 'cutForSearch'
const PRODUCTION_SCORING: Scoring = 'bm25f'

await main()
