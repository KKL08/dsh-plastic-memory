import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { dialogueTokenizer, DIALOGUE_TOKENIZER_VERSION, DIALOGUE_BM25_WEIGHTS } from '../src/search/dialogue-tokenizer.ts'
import type { DialogueTokenizer } from '../src/search/dialogue-tokenizer.ts'
import { defaultJiebaLoader, resetJieba } from '../src/search/jieba-segmenter.ts'
import type { JiebaLoader } from '../src/search/jieba-segmenter.ts'

const hasRealJieba = await defaultJiebaLoader.importJieba().then(() => true, () => false)
const main = Buffer.from('词典')
// 分词器只会收到纯汉字段；替身整段当一个词，搜索模式按表再出子词。
const SEARCH_CUTS: Record<string, string[]> = {
  抄写锁定: ['抄写', '锁定'], 投票号码: ['投票', '号码'], 加上写锁: ['加上', '写锁'], 查询票号: ['查询', '票号'],
}
const loader: JiebaLoader = {
  async importJieba() {
    return { withDict: () => ({
      loadDict() {},
      cut(text: string, hmm: boolean) { expect(hmm).toBe(true); return [text] },
      cutForSearch(text: string, hmm: boolean) { expect(hmm).toBe(true); return SEARCH_CUTS[text] ?? [text] },
    }) }
  },
  readMainDictionary: () => main,
}
const missingLoader: JiebaLoader = {
  async importJieba() { throw Object.assign(new Error('未安装'), { code: 'MODULE_NOT_FOUND' }) },
  readMainDictionary: () => main,
}
const quiet = { log: { warn() {} } }
// 真实词典和降级两种模式各跑一遍，避免替身的切法掩盖真实行为。
const modes = [
  { mode: '真实词典', skip: !hasRealJieba, use: () => resetJieba() },
  { mode: '降级', skip: false, use: () => resetJieba(missingLoader) },
]
let root: string
const databases: DatabaseSync[] = []
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'dialogue-')); resetJieba(loader) })
afterEach(async () => {
  for (const db of databases.splice(0)) db.close()
  resetJieba()
  await rm(root, { recursive: true, force: true })
})

/** withoutW 模拟降级期写入的行：只有 b、c 两列有内容。 */
function index(tokenizer: DialogueTokenizer, rows: string[], opts: { withoutW?: boolean } = {}) {
  const db = new DatabaseSync(':memory:')
  databases.push(db)
  db.exec("CREATE VIRTUAL TABLE t USING fts5(w, b, c, raw UNINDEXED, tokenize = 'unicode61')")
  for (const raw of rows) {
    const { w, b, c } = tokenizer.columns(raw)
    db.prepare('INSERT INTO t VALUES (?, ?, ?, ?)').run(opts.withoutW ? '' : w, b, c, raw)
  }
  return (match: string) => db.prepare('SELECT raw FROM t WHERE t MATCH ? ORDER BY bm25(t, 4, 2, 1)').all(match).map(row => row.raw)
}

// 两行等长，排序只能靠 w 列权重，不能靠文档长度。
it.each([['写锁', '加上写锁', '抄写锁定'], ['票号', '查询票号', '投票号码']])('查询%s时整词命中的%s排在跨词命中的%s前', async (word, whole, across) => {
  const tokenizer = await dialogueTokenizer()
  const search = index(tokenizer, [across, whole])
  expect(search(tokenizer.match(word)!.all)).toEqual([whole, across])
})

it.each([
  ['写锁', '写'], ['中文executeSearch混写', 'executeSearch'],
  ['src/storage/file-table.ts', 'src/storage/file-table.ts'],
  ['snake_case_name', 'snake_case_name'], ['executeSearch', 'executeSearch'],
  ['ＡＢＣ１２３', 'abc123'], ['abc123', 'ＡＢＣ１２３'],
])('原文%s能被查询%s命中', async (raw, query) => {
  const tokenizer = await dialogueTokenizer()
  expect(index(tokenizer, [raw])(tokenizer.match(query)!.all)).toEqual([raw])
})

it('全部词零命中时任一词仍能命中', async () => {
  const tokenizer = await dialogueTokenizer()
  const search = index(tokenizer, ['写锁', '票号'])
  const match = tokenizer.match('写锁 票号')!
  expect(search(match.all)).toEqual([])
  expect(search(match.any)).toHaveLength(2)
})

it('引号、运算符、列过滤和括号只按文字查询', async () => {
  const tokenizer = await dialogueTokenizer()
  const raw = '"NEAR" * w: AND (OR) NOT ^'
  const search = index(tokenizer, [raw, 'near', 'and'])
  expect(search(tokenizer.match(raw)!.all)).toEqual([raw])
})

it.each(['missing', 'binding', 'dictionary'])('%s加载失败时降级且恢复后版本可用', async failure => {
  resetJieba({
    async importJieba() {
      if (failure !== 'dictionary') throw Object.assign(new Error('不可用'), { code: failure === 'missing' ? 'MODULE_NOT_FOUND' : 'BINDING' })
      return { withDict() { throw new Error('坏词典') } }
    },
    readMainDictionary: () => main,
  })
  const warnings: string[] = []
  const tokenizer = await dialogueTokenizer({ log: { warn: message => { warnings.push(message) } } })
  expect(tokenizer.degraded).toBe(true)
  expect(tokenizer.dictionaryVersion).toBeUndefined()
  expect(tokenizer.columns('写锁').w).toBe('')
  const search = index(tokenizer, ['写锁 src/storage/file-table.ts'])
  for (const query of ['写锁', '写', 'src/storage/file-table.ts']) {
    const match = tokenizer.match(query)!
    expect(match.all).not.toContain('w :')
    expect(search(match.all)).toHaveLength(1)
  }
  expect(warnings).toHaveLength(1)
  resetJieba(loader)
  expect((await dialogueTokenizer()).dictionaryVersion).toMatch(/^[a-f0-9]{16}$/)
})

it('词典按内容计算版本，路径切换才重建并缓存读取结果', async () => {
  const a = join(root, 'a')
  const b = join(root, 'b')
  await writeFile(a, '甲')
  await writeFile(b, '甲')
  let path = a
  const opts = { userDictionaryPath: () => path }
  const first = (await dialogueTokenizer(opts)).dictionaryVersion
  expect(first).toBe(createHash('sha256').update(main).update('甲').digest('hex').slice(0, 16))
  path = b
  expect((await dialogueTokenizer(opts)).dictionaryVersion).toBe(first)
  await writeFile(b, '乙')
  expect((await dialogueTokenizer(opts)).dictionaryVersion).toBe(first)
  path = a
  await dialogueTokenizer(opts)
  path = b
  expect((await dialogueTokenizer(opts)).dictionaryVersion).not.toBe(first)
})

it('空白和标点没有查询，停用词全被去掉时保留原词', async () => {
  const tokenizer = await dialogueTokenizer()
  for (const query of ['', '  ', '"*^():，。']) expect(tokenizer.match(query)).toBeUndefined()
  expect(tokenizer.match('的 了')!.all).toBe('c : "的" AND c : "了"')
  expect(tokenizer.match('的 写锁')).toEqual(tokenizer.match('写锁'))
})

// 期望值变了说明三列内容变了，必须同时把 DIALOGUE_TOKENIZER_VERSION 加一。
it.each([
  ['写锁', { w: '写锁', b: '写锁', c: '写 锁' }],
  ['抄写锁定', { w: '抄写 锁定', b: '抄写 写锁 锁定', c: '抄 写 锁 定' }],
  ['ＡＢＣ１２３', { w: 'abc123 abc123 abc 123', b: 'abc123 abc123 abc 123', c: '' }],
  ['snake_case_name', { w: 'snake_case_name snakecasename snake case name', b: 'snake_case_name snakecasename snake case name', c: '' }],
  ['Ａ"写！', { w: 'a 写', b: 'a 写', c: '写' }],
  ['a\u0000b', { w: 'a b', b: 'a b', c: '' }],
  ['カタカナ', { w: 'カタ タカ カナ', b: 'カタ タカ カナ', c: '' }],
  ['テーブル', { w: 'テー ーブ ブル', b: 'テー ーブ ブル', c: '' }],
  ['中文の写锁', { w: '中文 の 写锁', b: '中文 の 写锁', c: '中 文 写 锁' }],
  ['my4s店', { w: 'my4s my4s my 4 s 店', b: 'my4s my4s my 4 s 店', c: '店' }],
])('固定输入%s的三列与版本保持一致', async (text, columns) => {
  const tokenizer = await dialogueTokenizer()
  expect(tokenizer.tokenizerVersion).toBe(DIALOGUE_TOKENIZER_VERSION)
  expect(DIALOGUE_BM25_WEIGHTS).toEqual([4, 2, 1])
  expect(tokenizer.columns(text)).toEqual(columns)
})

// 真实词典的期望值变了也必须同时把 DIALOGUE_TOKENIZER_VERSION 加一。
it.skipIf(!hasRealJieba)('真实词典的固定输入保持三列稳定', async () => {
  resetJieba()
  const tokenizer = await dialogueTokenizer()
  expect(tokenizer.columns('中国')).toEqual({ w: '中国', b: '中国', c: '中 国' })
  expect(index(tokenizer, ['写锁 src/storage/file-table.ts'])(tokenizer.match('写锁')!.all)).toHaveLength(1)
})

for (const { mode, skip, use } of modes) {
  it.skipIf(skip)(`${mode}模式下连字符和下划线词不命中顺序轮换的行`, async () => {
    use()
    const tokenizer = await dialogueTokenizer(quiet)
    expect(index(tokenizer, ['file-table', 'table-file'])(tokenizer.match('file-table')!.all)).toEqual(['file-table'])
    expect(index(tokenizer, ['read_write', 'write_read'])(tokenizer.match('read_write')!.all)).toEqual(['read_write'])
  })

  it.skipIf(skip)(`${mode}模式下路径查询保持目录顺序，不命中打乱的路径片段`, async () => {
    use()
    const tokenizer = await dialogueTokenizer(quiet)
    const raw = 'src/storage/file-table.ts'
    const search = index(tokenizer, [raw, 'file-table.ts storage src', 'storage/src/file-table.ts'])
    expect(search(tokenizer.match(raw)!.all)).toEqual([raw])
  })

  it.skipIf(skip)(`${mode}模式下带数字后缀的文件名能查到自己，只有 b 列时也一样`, async () => {
    use()
    const tokenizer = await dialogueTokenizer(quiet)
    const match = tokenizer.match('file-1.ts')!.all
    // 两行经 unicode61 切出的 token 相同，分数相等；这里只锁「精确那行没有被漏掉」
    expect(index(tokenizer, ['file 1 ts', 'file-1.ts'])(match)).toContain('file-1.ts')
    expect(index(tokenizer, ['file-1.ts'], { withoutW: true })(match)).toEqual(['file-1.ts'])
  })
}

it.skipIf(!hasRealJieba)('混排的词典词按各段分别命中，w 列为空的行同样命中', async () => {
  resetJieba()
  const tokenizer = await dialogueTokenizer()
  const match = tokenizer.match('4s店')!.all
  expect(match).toBe('(w : "4 s" OR w : "4s" OR b : "4 s" OR b : "4s") AND c : "店"')
  expect(index(tokenizer, ['4s店在哪'])(match)).toEqual(['4s店在哪'])
  expect(index(tokenizer, ['4s店在哪'], { withoutW: true })(match)).toEqual(['4s店在哪'])
})

/**
 * 正常写入、降级写入（只有 b、c 列）各配正常查询、降级查询，四种组合的命中集合必须相同，
 * 查询切法和索引切法分叉时这里会出现某一种组合漏中或误中。
 */
async function fourModes(doc: string, query: string): Promise<boolean[]> {
  resetJieba()
  const normal = await dialogueTokenizer()
  resetJieba(missingLoader)
  const degraded = await dialogueTokenizer(quiet)
  const hits: boolean[] = []
  for (const writer of [normal, degraded]) {
    for (const reader of [normal, degraded]) hits.push(index(writer, [doc])(reader.match(query)!.all).length === 1)
  }
  return hits
}

it.skipIf(!hasRealJieba).each([
  ['カタカナ', 'カタカナ'], ['한국어', '한국어'], ['ありがとう', 'ありがとう'], ['日本語のテスト', 'テスト'], ['テーブルを拭く', 'テーブル'], ['日本語を食べる', '食べる'],
  ['中文の写锁', '写锁'], ['中文の写锁', '中文の写锁'], ['libc++', 'libc++'], ['résumé', 'résumé'], ['café', 'café'], ['привет', 'привет'],
  ['café4s店', 'café4s店'], ['my4s店', 'my4s店'], ['江南style123', '江南style123'], ['4s店在哪', '4s店'],
  ['src/storage/file-table.ts', 'src/storage/file-table.ts'], ['snake_case_name', 'snake_case_name'], ['file-1.ts', 'file-1.ts'],
  ['中国', '中国'], ['写锁', '写'], ['抄写锁定', '写锁'], ['加上写锁', '写锁'],
])('四种写入和查询组合下原文%s都能被查询%s命中', async (doc, query) => {
  expect(await fourModes(doc, query)).toEqual([true, true, true, true])
})

it.skipIf(!hasRealJieba).each([
  ['ナカタカ', 'カタカナ'], ['어국한', '한국어'], ['うとがりあ', 'ありがとう'], ['テーブルでスイカとトマト', 'テスト'], ['ブルテー', 'テーブル'],
  ['libc++', 'lib'], ['résumé', 'sum'], ['über', 'ber'], ['table-file', 'file-table'], ['write_read', 'read_write'],
  ['storage/src/file-table.ts', 'src/storage/file-table.ts'], ['file-table.ts storage src', 'src/storage/file-table.ts'], ['美国', '中国'],
])('四种写入和查询组合下原文%s都不被查询%s命中', async (doc, query) => {
  expect(await fourModes(doc, query)).toEqual([false, false, false, false])
})

it('查询里的控制字符不会让检索出错', async () => {
  const tokenizer = await dialogueTokenizer()
  const search = index(tokenizer, ['a b'])
  expect(() => search(tokenizer.match('a\u0000b')!.all)).not.toThrow()
  expect(search(tokenizer.match('a\u0000b')!.all)).toEqual(['a b'])
})

it('用户词典读取失败时版本只包含生效的主词典', async () => {
  const tokenizer = await dialogueTokenizer({
    userDictionaryPath: () => join(root, 'missing'),
    log: { warn() {} },
  })
  expect(tokenizer.degraded).toBe(false)
  expect(tokenizer.dictionaryVersion).toBe(createHash('sha256').update(main).digest('hex').slice(0, 16))
})

it('用户词典解析到一半失败时版本只含主词典，切词换用重建的干净实例', async () => {
  let built = 0
  resetJieba({
    async importJieba() {
      return { withDict: () => {
        built++
        let partial = false
        return {
          // 收进一部分词条后才抛错：坏实例切出的词和干净实例不同
          loadDict() { partial = true; throw new Error('第 2 行格式不对') },
          cut: (text: string) => partial ? ['坏'] : [text],
          cutForSearch: (text: string) => partial ? ['坏'] : [text],
        }
      } }
    },
    readMainDictionary: () => main,
  })
  const path = join(root, 'user')
  await writeFile(path, '甲 3 n\n坏行')
  const tokenizer = await dialogueTokenizer({ userDictionaryPath: () => path, log: { warn() {} } })
  expect(built).toBe(2)
  expect(tokenizer.dictionaryVersion).toBe(createHash('sha256').update(main).digest('hex').slice(0, 16))
  expect(tokenizer.columns('写锁').w).toBe('写锁')
})

it('并发创建共享词典读取，返回实例后切换词典不改旧版本', async () => {
  let reads = 0
  resetJieba({ ...loader, readMainDictionary() { reads++; return main } })
  const [a, b] = await Promise.all([dialogueTokenizer(), dialogueTokenizer()])
  expect(reads).toBe(1)
  expect(a.dictionaryVersion).toBe(b.dictionaryVersion)
  const path = join(root, 'user')
  await writeFile(path, '甲')
  const next = await dialogueTokenizer({ userDictionaryPath: () => path })
  expect(next.dictionaryVersion).not.toBe(a.dictionaryVersion)
  expect(a.dictionaryVersion).toBe(b.dictionaryVersion)
})
