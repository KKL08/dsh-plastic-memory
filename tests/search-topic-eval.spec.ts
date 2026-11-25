import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore } from '../src/store.ts'
import { FileTable } from '../src/storage/file-table.ts'
import { encodeRecord } from '../src/storage/frontmatter.ts'
import { GLOBAL_DIR } from '../src/storage/paths.ts'
import type { RecallStats } from '../src/storage/schema.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'
import { RANKING_FIELDS, tokenHitsIn } from '../src/search/ranking.ts'
import { tokenizerForQuery } from '../src/search/jieba-segmenter.ts'
import { findMemoryCandidates } from '../src/search/memory-candidates.ts'
import { executeSearch, type SearchToolDeps } from '../src/tools/search.ts'
import { fakeExec } from './helpers/exec.ts'
import { InMemoryKvTable, InMemoryBatchKvTable } from './helpers/in-memory-kv.ts'
import { InMemoryTable } from './helpers/in-memory-table.ts'
import { writeTopicIndex } from './helpers/topic-fixture.ts'
import { EVAL_QUERIES, EVAL_RECORDS, EVAL_TOPIC_QUERIES, EVAL_TOPICS } from './fixtures/search-eval.ts'

// 评估集的主题题：查询词在记忆里一个都对不上，只出现在主题名、曾用名或主题说明里。
// 语料和主题索引写进 FileTable 临时目录，走 executeSearch，与生产同一条路。

const registry = buildTypeRegistry({ template: 'coding', customTypes: {} })
const silent = { warn() {} }
let root: string
let deps: SearchToolDeps

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'pm-topic-eval-'))
  await mkdir(join(root, GLOBAL_DIR))
  await Promise.all(EVAL_RECORDS.map(r => writeFile(join(root, GLOBAL_DIR, `${r.id}.md`), encodeRecord(r, {}), 'utf8')))
  await writeTopicIndex(join(root, GLOBAL_DIR), EVAL_TOPICS)
  const store = new MemoryStore(new FileTable({ root, stats: new InMemoryKvTable<RecallStats>() }), undefined, new InMemoryBatchKvTable())
  deps = { store, registry, tokenizer: { log: silent }, host: { contextOf: async () => ({ workspacePath: undefined, session: { id: 's', lastSeq: 1 } }) } }
}, 60_000)
afterAll(async () => { await rm(root, { recursive: true, force: true }) })

describe('评估集：查询词只出现在主题名或主题说明里', () => {
  it('主题名、曾用名、说明三处都有题；每题记忆一条都命中不了，结果先给预期的匹配主题，并附上主题目录', async () => {
    expect(EVAL_TOPIC_QUERIES.length).toBeGreaterThanOrEqual(6)
    expect(new Set(EVAL_TOPIC_QUERIES.map(q => q.where))).toEqual(new Set(['name', 'alias', 'about']))
    const names = EVAL_TOPICS.map(t => t.name)
    for (const q of EVAL_TOPIC_QUERIES) {
      for (const topic of q.topics) expect(names).toContain(topic)
      const r = await executeSearch({ query: q.query }, fakeExec(), deps)
      expect(r.hits, q.query).toEqual([])
      expect(r.matchedTopics?.map(t => t.name), q.query).toEqual(expect.arrayContaining([...q.topics]))
      expect(r.catalog?.map(t => t.name), q.query).toEqual([...names, '未整理'])
    }
  })

  it('主题命中和记忆命中同一个口径：评估集每条查询，对记忆四个字段算的逐 token 命中都等于记忆检索给的命中', async () => {
    const store = new MemoryStore(new InMemoryTable(), undefined, new InMemoryBatchKvTable())
    for (const r of EVAL_RECORDS) await store.put(r)
    for (const q of EVAL_QUERIES) {
      const found = await findMemoryCandidates({ query: q.query, scope: { kind: 'global' } }, { store, tokenizer: { log: silent } })
      const tokenize = await tokenizerForQuery(q.query, { log: silent })
      const hitsOf = new Map(found.candidates.map(c => [c.record.id, c.tokenHits]))
      for (const record of EVAL_RECORDS) {
        const fields = RANKING_FIELDS.map(f => (f === 'tags' ? record.tags.join(' ') : record[f]))
        // 不在候选里的记录一个 token 都没命中；只在子串档的候选逐 token 命中也全为假
        const expected = hitsOf.get(record.id) ?? found.diagnostics.tokens.map(() => false)
        expect(tokenHitsIn(fields, found.diagnostics.tokens, tokenize), `${q.query} / ${record.id}`).toEqual(expected)
      }
    }
  }, 60_000)
})
