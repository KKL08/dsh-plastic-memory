import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import fc from 'fast-check'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileTable } from '../src/storage/file-table.ts'
import { encodeRecord } from '../src/storage/frontmatter.ts'
import { ARCHIVE_DIR, GLOBAL_DIR } from '../src/storage/paths.ts'
import { InMemoryKvTable } from '../src/kv-table.ts'
import { expandQueryTerms, matchScore } from '../src/text.ts'
import { createTokenizer } from '../src/search/tokenizer.ts'
import type { RecallStats } from '../src/storage/schema.ts'
import { record } from './helpers/record.ts'

// 读取层 prefactor：any 模式预筛接任意一组子串词项（检索会传新 token ∪ 旧词项），列出文件数与预筛无关。

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'pm-prefilter-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

const tokenize = createTokenizer()

describe('any 模式预筛接新 token ∪ 旧词项：预筛是超集，不改变按词项匹配的结果（性质测试）', () => {
  // 记录侧词池：驼峰 / 连续大写 / 下划线标识符（出 Latin 子词）、CJK 短语（出 bigram）、普通整词
  const recordWord = fc.constantFrom(
    'pnpm', 'deploy', 'HTTPServer', 'getUserName', 'snake_case_id', 'mem_7f', 'v2',
    '部署流程', '新鲜度', '缓存失效', 'カタカナ', 'React',
  )
  // 查询侧多几个查不到的词与只命中局部的子串（鲜度、userName、server）
  const queryWord = fc.oneof(recordWord, fc.constantFrom('zzz', '鲜度', 'userName', 'server', '查不到', 'Kubernetes', 'case'))
  const rec = fc.record({
    name: fc.array(recordWord, { minLength: 1, maxLength: 2 }).map(ws => ws.join(' ')),
    summary: fc.array(recordWord, { maxLength: 2 }).map(ws => ws.join(' ')),
    content: fc.array(recordWord, { maxLength: 4 }).map(ws => ws.join(' ') || '空'),
    tags: fc.array(recordWord, { maxLength: 2 }),
  })

  it('预筛后按「任一词项是原文小写子串」过滤 = 不预筛时同样过滤；listedCount 不随预筛变', async () => {
    await fc.assert(fc.asyncProperty(
      fc.array(rec, { minLength: 1, maxLength: 6 }),
      fc.array(queryWord, { minLength: 1, maxLength: 3 }),
      async (recs, queryWords) => {
        const dir = await mkdtemp(join(root, 'prop-'))
        const gdir = join(dir, GLOBAL_DIR)
        await mkdir(gdir)
        await Promise.all(recs.map((r, i) => writeFile(join(gdir, `r${i}.md`), encodeRecord(record({ id: `mem_p${i}`, ...r }), {}))))
        const t = new FileTable({ root: dir, stats: new InMemoryKvTable<RecallStats>() })
        const query = queryWords.join(' ')
        const terms = [...new Set([...tokenize(query), ...expandQueryTerms(query)])]
        const hit = (rs: Awaited<ReturnType<FileTable['readScope']>>['records']) =>
          rs.filter(l => matchScore(l.record, terms) > 0).map(l => l.record.id).sort()

        const full = await t.readScope([gdir])
        const pre = await t.readScope([gdir], { prefilterTerms: terms, prefilterMatch: 'any' })
        expect(full.records).toHaveLength(recs.length)
        expect(hit(pre.records)).toEqual(hit(full.records))
        expect(pre.listedCount).toBe(recs.length)
        expect(full.listedCount).toBe(recs.length)
        await rm(dir, { recursive: true, force: true })
      },
    ), { numRuns: 60 })
  })
})

describe('FileTable 的 listedCount 口径', () => {
  it('数顶层列出的记忆文件：含预筛跳过的、解析失败进隔离区的、被 types 滤掉的；不含 .archive/ 与非记忆文件', async () => {
    const gdir = join(root, GLOBAL_DIR)
    await mkdir(join(gdir, ARCHIVE_DIR), { recursive: true })
    await writeFile(join(gdir, 'hit.md'), encodeRecord(record({ id: 'mem_hit', type: 'knowledge', content: 'alpha' }), {}))
    await writeFile(join(gdir, 'skip.md'), encodeRecord(record({ id: 'mem_skip', type: 'knowledge', content: '无关' }), {}))
    await writeFile(join(gdir, 'proj.md'), encodeRecord(record({ id: 'mem_proj', type: 'project', content: 'alpha' }), {}))
    await writeFile(join(gdir, 'bad.md'), '---\nname: [alpha\ntype: knowledge\n---\n\n正文\n')   // YAML 解析失败
    await writeFile(join(gdir, 'notes.txt'), 'alpha')
    await writeFile(join(gdir, ARCHIVE_DIR, 'old.md'), encodeRecord(record({ id: 'mem_old', status: 'deleted', deletedAt: 1, content: 'alpha' }), {}))
    const t = new FileTable({ root, stats: new InMemoryKvTable<RecallStats>() })

    const r = await t.readScope([gdir], { prefilterTerms: ['alpha'], prefilterMatch: 'any', types: ['knowledge'], includeArchive: true })
    expect(r.records.map(l => l.record.id).sort()).toEqual(['mem_hit', 'mem_old'])
    expect(r.quarantined.map(q => q.path)).toEqual([join(gdir, 'bad.md')])
    expect(r.listedCount).toBe(4)   // hit / skip / proj / bad
    expect((await t.readScope([gdir])).listedCount).toBe(4)
  })
})
