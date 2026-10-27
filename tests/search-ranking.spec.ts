import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import fc from 'fast-check'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { MemoryStore, InMemoryTable } from '../src/store.ts'
import type { MemoryTable, ScopeReadOptions } from '../src/storage/table.ts'
import { FileTable } from '../src/storage/file-table.ts'
import { GLOBAL_DIR, workspaceDirName } from '../src/storage/paths.ts'
import { InMemoryKvTable } from '../src/kv-table.ts'
import { expandQueryTerms, matchScore } from '../src/text.ts'
import { createTokenizer } from '../src/search/tokenizer.ts'
import { RANKING_FIELDS, anchorTerms, substringEligible } from '../src/search/ranking.ts'
import {
  executeSearch, renderSearchResult, termHitNote, LOW_COVERAGE_NOTE, OR_FALLBACK_NOTE, RETRY_HINT, SUBSTRING_FALLBACK_NOTE,
  TERM_NOTE_MAX, type SearchToolDeps,
} from '../src/tools/search.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'
import type { SearchNoteCode } from '../src/contract-codes.ts'
import type { MemoryRecord } from '../src/record-schema.ts'
import type { RecallStats } from '../src/storage/schema.ts'
import { record } from './helpers/record.ts'
import { fakeExec } from './helpers/exec.ts'

// memory_search 内核换成分词 + BM25 + 字段加权，三档一张表；跑在 FileTable 临时目录上，与生产一致。

const registry = buildTypeRegistry({ template: 'coding', customTypes: {} })
const OR_FALLBACK: SearchNoteCode = 'or-fallback'
const SUBSTRING_FALLBACK: SearchNoteCode = 'substring-fallback'
const LOW_COVERAGE: SearchNoteCode = 'low-coverage'
const NO_WORKSPACE: SearchNoteCode = 'no-workspace'
const tokenize = createTokenizer()

const deps = (store: MemoryStore, workspacePath?: string): SearchToolDeps => ({
  store, registry,
  resolveContext: async () => ({ workspacePath, session: { id: 's', lastSeq: 1 } }),
})

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'pm-ranking-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

const fileTable = (dir = root) => new FileTable({ root: dir, stats: new InMemoryKvTable<RecallStats>() })

async function seeded(records: MemoryRecord[], table: MemoryTable = fileTable()): Promise<MemoryStore> {
  const store = new MemoryStore(table)
  for (const r of records) await store.put(r)
  return store
}

const search = (store: MemoryStore, query: string, extra: Partial<Parameters<typeof executeSearch>[0]> = {}) =>
  executeSearch({ query, ...extra }, fakeExec(), deps(store))
const ids = async (store: MemoryStore, query: string, extra: Partial<Parameters<typeof executeSearch>[0]> = {}) =>
  (await search(store, query, extra)).hits.map(h => h.id)

describe('三档一张表', () => {
  it('全命中 → 部分命中 → 只有 id 子串命中；字段子串命中算命中、无词频排在同档之后，全不命中不出现', async () => {
    const store = await seeded([
      record({ id: 'mem_fieldsub', name: '子串条目', content: 'deployment 流水线' }),   // deployment 含 deploy，token 不等
      record({ id: 'mem_rollback_x', name: '只有 id 相关', content: '正文与查询无关' }),  // 只有 id 含 rollback
      record({ id: 'mem_none', name: '无关条目', content: '与查询完全无关' }),
      record({ id: 'mem_partial', name: '部分条目', content: '只提到 deploy' }),
      record({ id: 'mem_full', name: '全命中条目', content: 'deploy 之后跑 hook 再 rollback' }),
    ])
    expect(await ids(store, 'deploy hook rollback')).toEqual(['mem_full', 'mem_partial', 'mem_fieldsub', 'mem_rollback_x'])
  })

  it('旧逻辑（全部词项子串命中）唯一会返回的记录：默认 limit 下仍返回，且排在只命中一个 token 的记录之前', async () => {
    const store = await seeded([
      ...Array.from({ length: 10 }, (_, i) => record({ id: `mem_deploy${i}`, name: `部署条目${i}`, content: `deploy 第 ${i} 次`, confidence: 0.9 })),
      record({ id: 'mem_hooks', name: '钩子条目', content: 'deployment hooks', confidence: 0.1 }),
    ])
    const r = await search(store, 'deploy hook')
    expect(r.hits).toHaveLength(10)
    expect(r.hits[0]!.id).toBe('mem_hooks')
    expect(r.noteCode).toBeUndefined()   // 两个 token 都以子串命中：全命中档
  })

  it('id 前缀查询：从整词拆出的子词（mem_x8v4 的 mem）不按字段子串算命中，含 memory 的记录不会挤掉按 id 命中的目标', async () => {
    const store = await seeded([
      ...Array.from({ length: 12 }, (_, i) => record({ id: `mem_other${i}`, name: `记录${i}`, content: `这条 memory 与查询无关 ${i}`, confidence: 0.9 })),
      record({ id: 'mem_x8v4f6', name: '目标', content: '正文里没有查询词', confidence: 0.1 }),
    ])
    const r = await search(store, 'mem_x8v4')
    expect(r.hits.map(h => h.id)).toEqual(['mem_x8v4f6'])
    expect(r.noteCode).toBe(SUBSTRING_FALLBACK)
  })

  it('子串档只剩 id 这类非打分字段的命中：档内按旧命中词数降序，再按 confidence、lastConfirmedAt', async () => {
    const store = await seeded([
      record({ id: 'mem_alpha_low', confidence: 0.5, lastConfirmedAt: 1 }),
      record({ id: 'mem_alpha_high', confidence: 0.9, lastConfirmedAt: 1 }),
      record({ id: 'mem_alpha_recent', confidence: 0.9, lastConfirmedAt: 2 }),
      record({ id: 'mem_alpha_beta', confidence: 0.1, lastConfirmedAt: 1 }),
    ])
    const r = await search(store, 'alpha beta')
    expect(r.hits.map(h => h.id)).toEqual(['mem_alpha_beta', 'mem_alpha_recent', 'mem_alpha_high', 'mem_alpha_low'])
    expect(r.noteCode).toBe(SUBSTRING_FALLBACK)
  })
})

describe('字段权重', () => {
  // 正文取常见长度（一百多字）：name 里出现一次相当于这样的正文里出现三次
  const ORDINARY_BODY = '上线前先在预发环境演练一遍，确认监控面板、告警规则、数据库连接池配置都正常；'
    + '值守的人要提前在频道里报到，出了问题按预案处理，处理完把时间线和原因补进复盘文档，'
    + '下次上线前再对照复盘文档检查一遍。必要时执行 rollback。'

  it('词频相当时 name 命中优先于仅 content 命中', async () => {
    const store = await seeded([
      record({ id: 'mem_content', name: '普通条目', summary: '普通摘要', content: ORDINARY_BODY }),
      record({ id: 'mem_name', name: 'rollback 流程', summary: '普通摘要', content: '正文与查询无关' }),
    ])
    expect(await ids(store, 'rollback')).toEqual(['mem_name', 'mem_content'])
  })

  it('正文反复出现的词可以胜过 name 碰巧含一次：各字段共用一个饱和上限（BM25F）', async () => {
    const store = await seeded([
      record({ id: 'mem_content', name: '普通条目', summary: '普通摘要', content: 'rollback rollback rollback 的正文' }),
      record({ id: 'mem_name', name: 'rollback 流程', summary: '普通摘要', content: '正文与查询无关' }),
    ])
    expect(await ids(store, 'rollback')).toEqual(['mem_content', 'mem_name'])
  })

  it('name 平淡但 content 大段命中（全部词都在）不被 name 碰巧含一个词、内容不相干的记录压下去', async () => {
    const store = await seeded([
      record({ id: 'mem_name_only', name: 'deploy 脚本位置', summary: '脚本放哪', content: '放在 scripts 目录下，与其他事无关' }),
      record({
        id: 'mem_body', name: '上线说明', summary: '上线前后要做的事',
        content: 'deploy 之前先跑 hook；deploy 失败就 rollback，rollback 之后再查 hook 日志；deploy 成功也要看 hook 输出',
      }),
    ])
    expect(await ids(store, 'deploy hook rollback')).toEqual(['mem_body', 'mem_name_only'])
  })

  it('同档内：summary 与 content 都命中的记录胜过只在 name 含词的记录（权重保守）', async () => {
    const store = await seeded([
      record({ id: 'mem_name_only', name: 'deploy 脚本', summary: '脚本位置', content: '放在 scripts 目录下' }),
      record({
        id: 'mem_body', name: '部署说明', summary: 'deploy 流程与注意事项',
        content: 'deploy 分三步：先 deploy 到预发，再 deploy 到灰度，最后 deploy 到全量；每一步都要确认健康检查通过',
      }),
    ])
    expect(await ids(store, 'deploy')).toEqual(['mem_body', 'mem_name_only'])
  })
})

describe('字面锚点：含标点的查询词整词命中排在同档前面', () => {
  const RELEASE_NOTE = (version: string) => `宿主 ${version} 的已知问题：插件页切换后滚动位置丢失，升级前先看这条。`

  it('只差一个版本号的几条记录：字面含查询版本号的排第一，哪怕它分数一样、确认时间最早', async () => {
    const store = await seeded([
      record({ id: 'mem_rc2', name: '已知问题', content: RELEASE_NOTE('0.2.1-rc.2'), lastConfirmedAt: 1 }),
      record({ id: 'mem_rc1', name: '已知问题', content: RELEASE_NOTE('0.2.1-rc.1'), lastConfirmedAt: 3 }),
      record({ id: 'mem_old', name: '已知问题', content: RELEASE_NOTE('0.1.1-rc.3'), lastConfirmedAt: 2 }),
    ])
    expect((await ids(store, '0.2.1-rc.2'))[0]).toBe('mem_rc2')
    expect((await ids(store, '0.2.1-rc.1'))[0]).toBe('mem_rc1')
  })

  it('字面比较不分大小写，tags、summary、正文里的都算；档位仍然优先，同档内锚点命中多的排前', async () => {
    const store = await seeded([
      record({ id: 'mem_tag', name: '契约测试', tags: ['host:contract'], content: '宿主契约 host contract 用例', lastConfirmedAt: 1 }),
      record({ id: 'mem_both', name: '发版检查', summary: '跑 HOST:CONTRACT 与 Host:Smoke', content: '发版前 host contract、host smoke 都要绿', lastConfirmedAt: 1 }),
      record({ id: 'mem_plain', name: '契约说明', content: 'host 与 contract 的约定，host contract 反复出现，host contract', lastConfirmedAt: 9 }),
      record({ id: 'mem_partial', name: '只提一半', content: '写着 HOST:Contract 但没有另一个词', lastConfirmedAt: 9 }),
    ])
    // smoke 只在 mem_both 出现：它全命中，其余部分命中；部分命中档里字面含 host:contract 的排在只靠分词命中的前面
    expect(await ids(store, 'host:contract host:smoke')).toEqual(['mem_both', 'mem_tag', 'mem_partial', 'mem_plain'])
  })

  it('不含标点的整词不参与字面排序：查询「分片上传」时，字面含这四个字但分数低的记录不会被提前', async () => {
    const store = await seeded([
      record({
        id: 'mem_literal', name: '杂记', summary: '一些零碎事项', lastConfirmedAt: 9,
        content: '周会提到几件事：日志保留三十天，告警阈值下调，分片上传的接口文档还没补，测试环境的证书快过期了。',
      }),
      record({
        id: 'mem_ranked', name: '大文件分片与上传', summary: '先分片，再逐片上传，断了只补缺的分片', lastConfirmedAt: 1,
        content: '大文件先在客户端分片，每片 5MB，逐片上传，服务端收齐后合并；上传中断时只重传缺的分片，上传进度按已收分片算。',
      }),
    ])
    expect(await ids(store, '分片上传')).toEqual(['mem_ranked', 'mem_literal'])
  })

  it('整词首尾的句读和括号不算标点：「分片上传？」仍按分数排，字面含这句的记录不会被提前', async () => {
    const store = await seeded([
      record({ id: 'mem_literal', name: '杂记', summary: '一些零碎事项', lastConfirmedAt: 9, content: '周会上有人问：分片上传？接口文档还没补。' }),
      record({
        id: 'mem_ranked', name: '大文件分片与上传', summary: '先分片，再逐片上传，断了只补缺的分片', lastConfirmedAt: 1,
        content: '大文件先在客户端分片，每片 5MB，逐片上传，服务端收齐后合并；上传中断时只重传缺的分片，上传进度按已收分片算。',
      }),
    ])
    expect(await ids(store, '分片上传？')).toEqual(['mem_ranked', 'mem_literal'])
  })

  it('书名号、全角方括号、反引号包着的普通词不算锚点：仍按分数排，字面引用这个写法的记录不会被提前', async () => {
    const guide = record({
      id: 'mem_ranked', name: '大文件分片与上传', summary: '先分片，再逐片上传，断了只补缺的分片', lastConfirmedAt: 1,
      content: '大文件先在客户端分片，每片 5MB，逐片上传，服务端收齐后合并；上传中断时只重传缺的分片，上传进度按已收分片算。',
    })
    for (const query of ['《分片上传》', '［分片上传］', '`分片上传`']) {
      const store = await seeded([
        record({ id: 'mem_literal', name: '杂记', summary: '一些零碎事项', lastConfirmedAt: 9, content: `周会上有人提到${query}，接口文档还没补。` }),
        guide,
      ], fileTable(await mkdtemp(join(root, 'q-'))))
      expect(await ids(store, query), query).toEqual(['mem_ranked', 'mem_literal'])
    }
  })

  it('包裹符号当分隔：剥掉后剩下的整词仍按有没有标点判断锚点', () => {
    expect(anchorTerms('《分片上传》 ［分片上传］ `分片上传` 【发版】 “回滚” {config}')).toEqual([])
    expect(anchorTerms('`node:sqlite` 《node:sqlite》的用法 【0.2.1-rc.2】')).toEqual(['node:sqlite', '0.2.1-rc.2'])
  })

  it('ASCII 标识符后紧跟的冒号是命名空间前缀，留在锚点里：「node:」把带前缀的引入指南排在泛讲 Node 的记录前面', async () => {
    const store = await seeded([
      record({ id: 'mem_runtime', name: 'Node 运行时', lastConfirmedAt: 9, content: 'node 运行时统一用 22；node 升级前先在 CI 跑一遍，node 版本写在 .nvmrc。' }),
      record({ id: 'mem_import', name: '内置模块引入', lastConfirmedAt: 1, content: '引入内置模块统一带 node: 前缀，例如 node:fs、node:path。' }),
    ])
    expect(await ids(store, 'node:')).toEqual(['mem_import', 'mem_runtime'])
  })

  it('冒号只在紧跟 ASCII 标识符时保留：中文后的冒号、全角冒号照旧剥掉', () => {
    expect(anchorTerms('node: npm: file: node:,')).toEqual(['node:', 'npm:', 'file:'])
    expect(anchorTerms('关于发版： 发版步骤: node：')).toEqual([])
  })

  it('部分命中档先比命中的查询词数：常见锚点不把覆盖面大得多的记录挤出前十', async () => {
    const catalogs = Array.from({ length: 11 }, (_, i) => record({
      id: `mem_cat${i}`, name: `模块清单 ${i}`, lastConfirmedAt: 9,
      content: `第 ${i} 组内置模块：node:sqlite、node:fs、node:path，按需引入。`,
    }))
    const store = await seeded([
      ...catalogs,
      record({
        id: 'mem_guide', name: '事务指南', lastConfirmedAt: 1,
        content: '在 node 里用 sqlite 时，写操作包进 transaction；出错就 rollback，整批放弃，不留半截数据。',
      }),
    ])
    expect((await ids(store, 'node:sqlite transaction rollback retry'))[0]).toBe('mem_guide')
  })

  it('括号包着的版本号：去掉首尾括号后按字面排', async () => {
    const store = await seeded([
      record({ id: 'mem_rc2', name: '已知问题', content: RELEASE_NOTE('0.2.1-rc.2'), lastConfirmedAt: 1 }),
      record({ id: 'mem_rc1', name: '已知问题', content: RELEASE_NOTE('0.2.1-rc.1'), lastConfirmedAt: 3 }),
    ])
    expect((await ids(store, '（0.2.1-rc.2）'))[0]).toBe('mem_rc2')
  })
})

describe('今天靠子串能命中的查询升级后仍命中', () => {
  it('「scope」命中 readScope（驼峰子词）、「memory source」命中 memory_source（下划线子词），都不走子串档', async () => {
    const store = await seeded([
      record({ id: 'mem_camel', content: 'readScope 一次读一个范围' }),
      record({ id: 'mem_snake', content: 'memory_source 工具查出处' }),
    ])
    const scope = await search(store, 'scope')
    expect(scope.hits.map(h => h.id)).toEqual(['mem_camel'])
    expect(scope.noteCode).toBeUndefined()
    const source = await search(store, 'memory source')
    expect(source.hits.map(h => h.id)).toEqual(['mem_snake'])
    expect(source.noteCode).toBeUndefined()
  })

  it('「memor」以子串命中 memory 算全命中、不附说明；id 前缀命中整 id 仍走子串档', async () => {
    const store = await seeded([
      record({ id: 'mem_memory', content: 'memory 插件' }),
      record({ id: 'mem_abc123', content: '正文里没有 id' }),
    ])
    const partial = await search(store, 'memor')
    expect(partial.hits.map(h => h.id)).toEqual(['mem_memory'])
    expect(partial.noteCode).toBeUndefined()
    // id 不是打分字段：mem_abc123 只靠旧词项命中 id，走子串档；子词 mem 是整词 mem_abc 的一部分，不按字段子串算命中，
    // 所以正文含 memory 的记录不进结果
    const prefix = await search(store, 'mem_abc')
    expect(prefix.hits.map(h => h.id)).toEqual(['mem_abc123'])
    expect(prefix.noteCode).toBe(SUBSTRING_FALLBACK)
    const only = await search(await seeded([record({ id: 'mem_xyz123', content: '正文里没有 id' })], fileTable(await mkdtemp(join(root, 'prefix-')))), 'mem_xyz')
    expect(only.hits.map(h => h.id)).toEqual(['mem_xyz123'])
    expect(only.noteCode).toBe(SUBSTRING_FALLBACK)
    expect(only.note).toBe(`${SUBSTRING_FALLBACK_NOTE}\n各关键词命中的记忆条数：mem_xyz 0。范围内一条都没命中的：mem_xyz。`)
  })
})

describe('id 直达与零 token', () => {
  it('查询 trim 后恰等于某条可见记忆的 id → 该条第一，其余照常；直达时不附说明', async () => {
    const store = await seeded([
      record({ id: 'mem_target', name: '目标', content: '正文里没有自己的 id', confidence: 0.1 }),
      record({ id: 'mem_mention', name: '提到者', content: 'mem_target 被提到，mem_target 很重要', confidence: 0.9 }),
    ])
    const r = await search(store, '  mem_target ')
    expect(r.hits.map(h => h.id)).toEqual(['mem_target', 'mem_mention'])
    expect(r.noteCode).toBeUndefined()   // 列表里有全命中记录（mem_mention）
    // 直达那条在子串档、其余只部分命中：要找的就是排第一的这条，不提示命中弱
    const only = await search(await seeded([
      record({ id: 'mem_solo', content: '正文' }),
      record({ id: 'mem_other', content: 'solo 演出安排' }),
    ], fileTable(await mkdtemp(join(root, 'solo-')))), 'mem_solo')
    expect(only.hits.map(h => h.id)).toEqual(['mem_solo', 'mem_other'])
    expect(only.noteCode).toBeUndefined()
    expect(only.note).toBeUndefined()
  })

  it('零 token 查询：不做关键词过滤，按 confidence、lastConfirmedAt 排并受 limit', async () => {
    const store = await seeded([
      record({ id: 'mem_low', confidence: 0.3, lastConfirmedAt: 9 }),
      record({ id: 'mem_old', confidence: 0.9, lastConfirmedAt: 1 }),
      record({ id: 'mem_new', confidence: 0.9, lastConfirmedAt: 2 }),
    ])
    for (const q of ['', '   ']) {
      const r = await search(store, q)
      expect(r.hits.map(h => h.id)).toEqual(['mem_new', 'mem_old', 'mem_low'])
      expect(r.noteCode).toBeUndefined()
    }
    expect(await ids(store, '', { limit: 2 })).toEqual(['mem_new', 'mem_old'])
  })
})

describe('说明码：四种触发，互斥、substring 优先', () => {
  it('有全命中 → 无码；只有部分命中（或部分 + 子串）→ 按首条覆盖度分 or-fallback / low-coverage；只有 id 子串 → substring-fallback；空 → 无码', async () => {
    // lastConfirmedAt 递减：全部落在子串档时三条平分，靠它定顺序
    const store = await seeded([
      record({ id: 'mem_full', content: 'alpha beta', lastConfirmedAt: 3 }),
      record({ id: 'mem_part', content: 'alpha', lastConfirmedAt: 2 }),
      record({ id: 'mem_sub', content: 'alphabet', lastConfirmedAt: 1 }),
    ])
    const full = await search(store, 'alpha beta')
    expect(full.hits.map(h => h.id)).toEqual(['mem_full', 'mem_part', 'mem_sub'])
    expect(full.noteCode).toBeUndefined()
    expect(full.note).toBeUndefined()

    // gamma 是关键词，排第一的也没有它：判弱
    const partial = await search(store, 'alpha beta gamma')
    expect(partial.hits.map(h => h.id)).toEqual(['mem_full', 'mem_part', 'mem_sub'])
    expect(partial.noteCode).toBe(LOW_COVERAGE)
    expect(partial.note!.startsWith(LOW_COVERAGE_NOTE)).toBe(true)

    // alph 以子串出现在三条记录的正文里：都算全命中，分数同为 0，按 lastConfirmedAt 排
    const fieldSub = await search(store, 'alph')
    expect(fieldSub.hits.map(h => h.id)).toEqual(['mem_full', 'mem_part', 'mem_sub'])
    expect(fieldSub.noteCode).toBeUndefined()

    const sub = await search(store, 'mem_su')
    expect(sub.hits.map(h => h.id)).toEqual(['mem_sub'])
    expect(sub.noteCode).toBe(SUBSTRING_FALLBACK)

    const none = await search(store, 'zeta')
    expect(none.hits).toEqual([])
    expect(none.noteCode).toBeUndefined()
  })

  it('说明码看的是返回列表：limit 截掉子串档后仍按留下的档位算', async () => {
    const store = await seeded([
      record({ id: 'mem_part', content: 'alpha' }),
      record({ id: 'mem_sub', content: 'alphabet' }),
    ])
    expect((await search(store, 'alpha beta', { limit: 1 })).noteCode).toBe(LOW_COVERAGE)
  })
})

describe('命中弱：按排第一的部分命中记录覆盖了多少查询判断', () => {
  it('斜杠连写不是一组别名：部署/deploy 的两个词都要命中，只含「部署」的记录不算全命中，提示命中弱', async () => {
    const store = await seeded([
      record({ id: 'mem_flow', name: '上线流程', content: '部署流程：先上预发再全量' }),
      record({ id: 'mem_other', name: '无关', content: '与查询无关的内容' }),
    ])
    const r = await search(store, '部署/deploy 流程')
    expect(r.hits.map(h => h.id)).toEqual(['mem_flow'])
    expect(r.noteCode).toBe(LOW_COVERAGE)
    expect(r.note!.split('\n')[1]).toBe('各关键词命中的记忆条数：部署 1、deploy 0、流程 1。范围内一条都没命中的：deploy。')
  })

  it('标签里存了英文别名的中文记忆，只用英文搜也全命中，不出说明', async () => {
    const store = await seeded([
      record({ id: 'mem_debounce', name: '搜索框防抖', content: '前端搜索输入框防抖 300 毫秒，回车立即搜', tags: ['frontend', 'debounce'] }),
      record({ id: 'mem_other', name: '无关', content: '与查询无关的内容' }),
    ])
    const r = await search(store, 'debounce')
    expect(r.hits.map(h => h.id)).toEqual(['mem_debounce'])
    expect(r.noteCode).toBeUndefined()
  })

  it('长句中文、首条只缺疑问词这类：or-fallback，如实说明没有全命中，不劝重搜、不列逐词命中', async () => {
    const store = await seeded([
      record({ id: 'mem_hand', name: '手编文件后的出处标注', content: '记忆文件被手编过时，出处可能对不上，读取时加标注' }),
    ])
    const r = await search(store, '记忆文件手编后出处对不上怎么办')
    expect(r.hits.map(h => h.id)).toEqual(['mem_hand'])
    expect(r.noteCode).toBe(OR_FALLBACK)
    expect(r.note).toBe(OR_FALLBACK_NOTE)
    expect(OR_FALLBACK_NOTE).toBe('没有记忆同时含全部关键词，以下按相关性排序。')
    expect(r.note).not.toContain(RETRY_HINT)
  })

  it('有关键词在范围内一条都没有：low-coverage，劝重搜，再列各关键词命中条数和一条都没命中的词', async () => {
    const store = await seeded([
      record({ id: 'mem_tpl', name: '切换模板后立即生效', content: '记忆模板改了不用重启' }),
      record({ id: 'mem_mail', name: '邮件模板修改', content: '改邮件模板后要重新部署才生效' }),
    ])
    const r = await search(store, '周报 模板')
    expect(r.noteCode).toBe(LOW_COVERAGE)
    expect(LOW_COVERAGE_NOTE.endsWith(RETRY_HINT)).toBe(true)
    expect(RETRY_HINT).toBe('命中弱，可以换同义词、换成另一种语言的写法、减少词数或换个角度再搜一次。')
    expect(r.note).toBe(`${LOW_COVERAGE_NOTE}\n各关键词命中的记忆条数：周报 0、模板 2。范围内一条都没命中的：周报。`)
    // 说明在命中列表之前
    expect(renderSearchResult(r).startsWith(r.note!)).toBe(true)
  })

  it('中英两种写法放进同一次查询：各算一个关键词，首条缺了英文写法就判弱', async () => {
    const store = await seeded([
      record({ id: 'mem_debounce', name: '搜索框防抖', content: '前端搜索输入框防抖 300 毫秒，回车立即搜' }),
    ])
    const r = await search(store, '防抖 debounce')
    expect(r.noteCode).toBe(LOW_COVERAGE)
    expect(r.note!.split('\n')[1]).toBe('各关键词命中的记忆条数：防抖 1、debounce 0。范围内一条都没命中的：debounce。')
    // 英文词的标签去掉紧挨着的标点
    const r2 = await search(store, 'debounce（防抖）')
    expect(r2.note!.split('\n')[1]).toBe('各关键词命中的记忆条数：debounce 0、防抖 1。范围内一条都没命中的：debounce。')
  })

  it('逐词命中只列整词，超过上限只列前几个再说共几个；一个可数的词都没有（纯数字）就不列这一行', async () => {
    expect(termHitNote([])).toBeUndefined()
    const counts = Array.from({ length: TERM_NOTE_MAX + 2 }, (_, i) => ({ label: `词${i}`, count: i % 2 }))
    const zero = counts.filter(c => c.count === 0).map(c => `${c.label}`)
    expect(termHitNote(counts)).toBe(
      `各关键词命中的记忆条数：${counts.slice(0, TERM_NOTE_MAX).map(c => `${c.label} ${c.count}`).join('、')} 等 ${counts.length} 个。`
      + `范围内一条都没命中的：${zero.join('、')}。`,
    )
    const store = await seeded([record({ id: 'mem_num', content: '防抖 300 毫秒' })])
    const r = await search(store, '300')
    expect(r.noteCode).toBe(SUBSTRING_FALLBACK)
    expect(r.note).toBe(SUBSTRING_FALLBACK_NOTE)
  })
})

// 这一例要逐条落盘 60 个文件，全量并行跑时偶尔越过默认 5 秒
describe('不变的行为', { timeout: 15_000 }, () => {
  it('validTo 已过期的不进结果；types、limit 上限 50 照旧', async () => {
    const now = Date.now()
    const store = await seeded([
      record({ id: 'mem_dead', content: 'magicword 过期', validTo: now - 1000 }),
      record({ id: 'mem_ok', content: 'magicword 有效' }),
      record({ id: 'mem_pref', type: 'preference', content: 'magicword 偏好' }),
    ])
    expect((await ids(store, 'magicword')).sort()).toEqual(['mem_ok', 'mem_pref'])
    expect(await ids(store, 'magicword', { types: ['preference'] })).toEqual(['mem_pref'])
    const many = await seeded(Array.from({ length: 60 }, (_, i) => record({ id: `mem_${i}`, name: `条目${i}`, content: 'magicword' })))
    expect(await ids(many, 'magicword', { limit: 100 })).toHaveLength(50)
  })

  it('超长正文（15 万汉字）不让整次检索抛错：它与其他命中照常返回', async () => {
    const store = await seeded([
      record({ id: 'mem_long', name: 'needle', content: '中'.repeat(150_000) }),
      record({ id: 'mem_short', name: '普通条目', content: '正文提到 needle' }),
    ])
    const r = await search(store, 'needle')
    expect(r.hits.map(h => h.id)).toEqual(['mem_long', 'mem_short'])
    expect(r.noteCode).toBeUndefined()
  })

  it('scope=workspace 无工作目录：空结果 + no-workspace 说明', async () => {
    const store = await seeded([record({ id: 'mem_g', content: 'magicword' })])
    const r = await executeSearch({ query: 'magicword', scope: 'workspace' }, fakeExec(), deps(store, undefined))
    expect(r.hits).toEqual([])
    expect(r.noteCode).toBe(NO_WORKSPACE)
  })
})

describe('结果形状：命中带文件绝对路径', () => {
  it('name 不含密钥时 SearchHit.path 恒有值且为绝对路径，指向真实存在的文件（global 与项目目录、关键词与零 token 查询都带）', async () => {
    const store = await seeded([
      record({ id: 'mem_g', name: '全局条目', content: 'magicword 全局' }),
      record({ id: 'mem_w', name: '项目条目', scope: 'workspace', workspacePath: '/w/proj', content: 'magicword 项目' }),
    ])
    for (const query of ['magicword', '']) {
      const r = await executeSearch({ query }, fakeExec(), deps(store, '/w/proj'))
      expect(r.hits.map(h => h.id).sort()).toEqual(['mem_g', 'mem_w'])
      for (const h of r.hits) {
        expect(isAbsolute(h.path!)).toBe(true)
        expect(await readFile(h.path!, 'utf8')).toContain(`id: ${h.id}`)
      }
      expect(dirname(r.hits.find(h => h.id === 'mem_g')!.path!)).toBe(join(root, GLOBAL_DIR))
      expect(dirname(r.hits.find(h => h.id === 'mem_w')!.path!)).toBe(join(root, workspaceDirName('/w/proj')))
    }
  })

  it('渲染头行末尾追加「 · 绝对路径」，其余格式不变', () => {
    const hit = { id: 'mem_x', type: 'knowledge', summary: '摘要', content: '正文\n第二行', sourceNote: '（推断）', stalenessNote: '（可能过时）', path: '/m/global/x.md' }
    expect(renderSearchResult({ hits: [hit] })).toBe('[mem_x] knowledge｜摘要（推断）（可能过时） · /m/global/x.md\n正文\n第二行')
    expect(renderSearchResult({ hits: [hit], note: '说明' })).toBe('说明\n\n[mem_x] knowledge｜摘要（推断）（可能过时） · /m/global/x.md\n正文\n第二行')
  })
})

// ---- 性质测试 ----

// 记录侧词池：整词、驼峰、下划线标识符、CJK 短语；查询侧多几个只命中局部的子词 / 子串与查不到的词
const recordWord = fc.constantFrom('pnpm', 'deploy', 'readScope', 'memory_source', '部署流程', '缓存失效', 'hook', 'zzz')
const queryWord = fc.oneof(recordWord, fc.constantFrom('scope', 'memory', 'memor', '部署', '失效流程', 'mem_p1', '查不到'))
const corpus = fc.array(fc.record({
  name: fc.array(recordWord, { minLength: 1, maxLength: 2 }).map(ws => ws.join(' ')),
  summary: fc.array(recordWord, { maxLength: 2 }).map(ws => ws.join(' ')),
  content: fc.array(recordWord, { maxLength: 4 }).map(ws => ws.join(' ') || '空'),
  tags: fc.array(recordWord, { maxLength: 2 }),
}), { minLength: 1, maxLength: 8 })
const query = fc.array(queryWord, { minLength: 1, maxLength: 3 }).map(ws => ws.join(' '))

/** lastConfirmedAt 各不相同：完全平局时排序才与读取顺序无关，两次运行才可比。 */
const toRecords = (rows: { name: string; summary: string; content: string; tags: string[] }[]) =>
  rows.map((row, i) => record({ id: `mem_p${i}`, ...row, lastConfirmedAt: i + 1 }))

/** 包一层 MemoryTable：readScope 丢掉预筛词项（= 不预筛），其余原样转发；同时记下原表收到的预筛词项。 */
function tapTable(t: MemoryTable, mode: 'strip' | 'spy', seen: ScopeReadOptions[]): MemoryTable {
  return {
    globalDir: t.globalDir,
    workspaceDirs: p => t.workspaceDirs(p),
    readScope: (dirs, opts = {}) => {
      seen.push(opts)
      if (mode === 'spy') return t.readScope(dirs, opts)
      const { prefilterTerms: _t, prefilterMatch: _m, ...rest } = opts
      return t.readScope(dirs, rest)
    },
    locate: (id, h) => t.locate(id, h),
    listWorkspaceDirs: () => t.listWorkspaceDirs(),
    create: r => t.create(r),
    put: (k, v, h) => t.put(k, v, h),
    update: (k, f, h) => t.update(k, f, h),
    delete: (k, h) => t.delete(k, h),
    maintain: d => t.maintain(d),
  }
}

// 每例 40 轮真实落盘，全量并行跑时单例要 3 秒上下；装了 jieba 时首个汉字查询还要加载词典，默认 5 秒上限偏紧
describe('性质测试', { timeout: 15_000 }, () => {
  it('预筛开关不改变三档成员与顺序', async () => {
    await fc.assert(fc.asyncProperty(corpus, query, async (rows, q) => {
      const dir = await mkdtemp(join(root, 'prop-'))
      const table = fileTable(dir)
      await seeded(toRecords(rows), table)
      const withSeen: ScopeReadOptions[] = []
      const withoutSeen: ScopeReadOptions[] = []
      const withPrefilter = new MemoryStore(tapTable(table, 'spy', withSeen))
      const withoutPrefilter = new MemoryStore(tapTable(table, 'strip', withoutSeen))
      const a = await search(withPrefilter, q, { limit: 50 })
      const b = await search(withoutPrefilter, q, { limit: 50 })
      expect(a.hits.map(h => h.id)).toEqual(b.hits.map(h => h.id))
      expect(a.noteCode).toBe(b.noteCode)
      // 对比有意义：正常路径确实把预筛词项传给了读取层
      expect(withSeen.some(o => (o.prefilterTerms?.length ?? 0) > 0 && o.prefilterMatch === 'any')).toBe(true)
      await rm(dir, { recursive: true, force: true })
    }), { numRuns: 40 })
  })

  it('子串档成员 = token 与字段子串都零命中、且旧 matchScore > 0 的记录，且都排在命中记录之后', async () => {
    await fc.assert(fc.asyncProperty(corpus, query, async (rows, q) => {
      const dir = await mkdtemp(join(root, 'prop-'))
      const table = fileTable(dir)
      const store = await seeded(toRecords(rows), table)
      const all = (await table.readScope([join(dir, GLOBAL_DIR)])).records.map(l => l.record)
      const tokens = [...new Set(tokenize(q))]
      const legacy = expandQueryTerms(q)
      const eligible = substringEligible(tokens)
      const fieldOf = (r: MemoryRecord, f: (typeof RANKING_FIELDS)[number]) => f === 'tags' ? r.tags.join(' ') : r[f]
      const tokenHit = (r: MemoryRecord) => tokens.some((tok, i) => RANKING_FIELDS.some(f =>
        tokenize(fieldOf(r, f)).includes(tok) || (eligible[i]! && fieldOf(r, f).toLowerCase().includes(tok))))
      const tokenHitIds = all.filter(tokenHit).map(r => r.id)
      const substringIds = all.filter(r => !tokenHit(r) && matchScore(r, legacy) > 0).map(r => r.id)

      const hits = await ids(store, q, { limit: 50 })
      expect([...hits].sort()).toEqual([...tokenHitIds, ...substringIds].sort())
      const firstSubstring = hits.findIndex(id => substringIds.includes(id))
      const lastTokenHit = hits.length - 1 - [...hits].reverse().findIndex(id => tokenHitIds.includes(id))
      if (firstSubstring !== -1 && tokenHitIds.length > 0) expect(lastTokenHit).toBeLessThan(firstSubstring)
      await rm(dir, { recursive: true, force: true })
    }), { numRuns: 40 })
  })

  it('FileTable 与 InMemoryTable 对同一组记录给出同一排序与说明码', async () => {
    await fc.assert(fc.asyncProperty(corpus, query, async (rows, q) => {
      const dir = await mkdtemp(join(root, 'prop-'))
      const onDisk = await seeded(toRecords(rows), fileTable(dir))
      const inMemory = await seeded(toRecords(rows), new InMemoryTable())
      const a = await search(onDisk, q, { limit: 50 })
      const b = await search(inMemory, q, { limit: 50 })
      expect(a.hits.map(h => h.id)).toEqual(b.hits.map(h => h.id))
      expect(a.noteCode).toBe(b.noteCode)
      await rm(dir, { recursive: true, force: true })
    }), { numRuns: 40 })
  })
})
