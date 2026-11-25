import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { dialogueTerms, rankSegments } from '../src/search/dialogue-rank.ts'
import { dialogueTokenizer, identifierForms, DIALOGUE_TOKENIZER_VERSION } from '../src/search/dialogue-tokenizer.ts'
import type { DialogueColumns, DialogueTokenizer, IdentifierForms } from '../src/search/dialogue-tokenizer.ts'
import { resetJieba } from '../src/search/jieba-segmenter.ts'
import type { JiebaLoader } from '../src/search/jieba-segmenter.ts'

const main = Buffer.from('词典')
// 词典替身只会收到纯汉字段：整段当一个词，搜索模式按表出子词。标识符的拆分不经过它。
const SEARCH_CUTS: Record<string, string[]> = { 加上写锁: ['加上', '写锁'] }
const fakeLoader: JiebaLoader = {
  async importJieba() {
    return { withDict: () => ({ loadDict() {}, cut: (text: string) => [text], cutForSearch: (text: string) => SEARCH_CUTS[text] ?? [text] }) }
  },
  readMainDictionary: () => main,
}
const missingLoader: JiebaLoader = {
  async importJieba() { throw Object.assign(new Error('未安装'), { code: 'MODULE_NOT_FOUND' }) },
  readMainDictionary: () => main,
}
const quiet = { log: { warn() {} } }
const modes = [{ mode: '有词典', loader: fakeLoader }, { mode: '缺 jieba', loader: missingLoader }] as const

const databases: DatabaseSync[] = []
beforeEach(() => { resetJieba(fakeLoader) })
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
  resetJieba()
})

async function tokenizerOf(loader: JiebaLoader): Promise<DialogueTokenizer> {
  resetJieba(loader)
  return dialogueTokenizer(quiet)
}

/** 按给定的三列建一张内存 FTS5 表，返回「按表达式查出原文」的函数；列内容由调用方决定，用来模拟旧代写下的行。 */
function table(rows: ReadonlyArray<{ raw: string; columns: DialogueColumns }>) {
  const db = new DatabaseSync(':memory:')
  databases.push(db)
  db.exec("CREATE VIRTUAL TABLE t USING fts5(w, b, c, raw UNINDEXED, tokenize = 'unicode61')")
  for (const { raw, columns } of rows) db.prepare('INSERT INTO t VALUES (?, ?, ?, ?)').run(columns.w, columns.b, columns.c, raw)
  return (match: string) => db.prepare('SELECT raw FROM t WHERE t MATCH ? ORDER BY rowid').all(match).map(row => row.raw)
}

const index = (tokenizer: DialogueTokenizer, raws: readonly string[]) => table(raws.map(raw => ({ raw, columns: tokenizer.columns(raw) })))

// 哈希现算，夹具里不放字面值；sha256 的十六进制串字母数字交替远超 8 段。
const HASH = createHash('sha256').update('x').digest('hex')
const NINE_PARTS = 'packages/app/src/lib/search/raw/dialogue/tokenizer.ts'
const EIGHT_PARTS = 'app/src/lib/search/raw/dialogue/tokenizer.ts'
const LEN_64 = `${'a'.repeat(31)}_${'b'.repeat(32)}`
const LEN_65 = `${'a'.repeat(32)}_${'b'.repeat(32)}`
const forms = (...parts: string[]): IdentifierForms => ({ parts, joined: parts.join('') })

/**
 * 固定样例：输入、拆分结果、w 和 b 列的完整输出（两列相同）。
 * 列的顺序是「原样、拼合、拆开各段」：拼合夹在中间，原样拆出的词和拆开各段首尾不相接，顺序轮换的写法不会造出假短语。
 * 期望值变了说明三列内容变了，必须同时把 DIALOGUE_TOKENIZER_VERSION 加一。
 */
const SAMPLES: ReadonlyArray<readonly [string, IdentifierForms | undefined, string]> = [
  ['getUserName', forms('get', 'user', 'name'), 'getusername getusername get user name'],
  ['GetUserName', forms('get', 'user', 'name'), 'getusername getusername get user name'],
  ['get_user_name', forms('get', 'user', 'name'), 'get_user_name getusername get user name'],
  ['get-user-name', forms('get', 'user', 'name'), 'get-user-name getusername get user name'],
  ['src/search/jieba.ts', forms('src', 'search', 'jieba', 'ts'), 'src/search/jieba.ts srcsearchjiebats src search jieba ts'],
  ['HTTPServer', forms('http', 'server'), 'httpserver httpserver http server'],
  ['parseURL', forms('parse', 'url'), 'parseurl parseurl parse url'],
  ['sha256', forms('sha', '256'), 'sha256 sha256 sha 256'],
  ['utf8Decode', forms('utf', '8', 'decode'), 'utf8decode utf8decode utf 8 decode'],
  ['node:sqlite', forms('node', 'sqlite'), 'node:sqlite nodesqlite node sqlite'],
  ['foo→bar', forms('foo', 'bar'), 'foo→bar foobar foo bar'],
  ['jieba', undefined, 'jieba'],
  ['done.', undefined, 'done.'],
  ['0.2.1', undefined, '0.2.1'],
  [HASH, undefined, HASH],
  [NINE_PARTS, undefined, NINE_PARTS],
  [EIGHT_PARTS, forms('app', 'src', 'lib', 'search', 'raw', 'dialogue', 'tokenizer', 'ts'), `${EIGHT_PARTS} appsrclibsearchrawdialoguetokenizerts app src lib search raw dialogue tokenizer ts`],
  [LEN_64, forms('a'.repeat(31), 'b'.repeat(32)), `${LEN_64} ${'a'.repeat(31)}${'b'.repeat(32)} ${'a'.repeat(31)} ${'b'.repeat(32)}`],
  [LEN_65, undefined, LEN_65],
]

describe('标识符的拆分形式和拼合形式', () => {
  it.each(SAMPLES)('固定样例 %s 的拆分结果和 w、b 两列保持一致，缺 jieba 时 b 列照样追加', async (input, expected, column) => {
    expect(DIALOGUE_TOKENIZER_VERSION).toBe(2)
    expect(identifierForms(input)).toEqual(expected)
    const normal = await tokenizerOf(fakeLoader)
    expect(normal.tokenizerVersion).toBe(DIALOGUE_TOKENIZER_VERSION)
    expect(normal.columns(input)).toEqual({ w: column, b: column, c: '' })
    const degraded = await tokenizerOf(missingLoader)
    expect(degraded.columns(input)).toEqual({ w: '', b: column, c: '' })
  })

  it.each(['+++', '__', '-./:'])('全是符号的段 %s 拆不出一段，不追加', input => {
    expect(identifierForms(input)).toBeUndefined()
  })

  it('查询里追加的一组先写拆开各段的短语再写拼合形式，原话的查询词取拆开的短语', async () => {
    expect(identifierForms('getUserName')).toEqual(forms('get', 'user', 'name'))
    const normal = await tokenizerOf(fakeLoader)
    expect(normal.match('getUserName')!.all).toBe('(w : "get user name" OR w : "getusername" OR b : "get user name" OR b : "getusername")')
    expect(dialogueTerms('getUserName', normal)).toEqual(['get user name'])
    const degraded = await tokenizerOf(missingLoader)
    expect(degraded.match('getUserName')!.all).toBe('(b : "get user name" OR b : "getusername")')
    expect(dialogueTerms('getUserName', degraded)).toEqual(['get user name'])
  })

  it('引号和控制字符照旧换成空白，切开的两边各自判定是否追加', async () => {
    expect(identifierForms('UserName')).toEqual(forms('user', 'name'))
    const tokenizer = await tokenizerOf(fakeLoader)
    expect(tokenizer.columns('get"User\u0000Name')).toEqual({ w: 'get user name', b: 'get user name', c: '' })
    expect(tokenizer.columns('get"UserName')).toEqual({ w: 'get username username user name', b: 'get username username user name', c: '' })
    expect(tokenizer.match('get"UserName')!.all).toBe('(w : "get" OR b : "get") AND (w : "user name" OR w : "username" OR b : "user name" OR b : "username")')
  })

  it('标识符里夹着检索语法的字样只按文字查询，不报错', async () => {
    expect(identifierForms('NEAR_OR*AND')).toEqual(forms('near', 'or', 'and'))
    const tokenizer = await tokenizerOf(fakeLoader)
    const search = index(tokenizer, ['near_or_and', 'near', 'and', 'or'])
    expect(search(tokenizer.match('NEAR_OR*AND')!.all)).toEqual(['near_or_and'])
  })
})

// [查询, 原文]：同一个标识符换一种写法也要互相命中。
const CROSS: ReadonlyArray<readonly [string, string]> = [
  ['getUserName', 'get_user_name'], ['get_user_name', 'getUserName'],
  ['getUserName', 'GetUserName'], ['GetUserName', 'getUserName'],
  ['get_user_name', 'GetUserName'], ['GetUserName', 'get_user_name'],
  ['user name', 'getUserName'], ['jieba.ts', 'src/search/jieba.ts'], ['getusername', 'get_user_name'],
  ['ｇｅｔＵｓｅｒＮａｍｅ', 'get_user_name'], ['get_user_name', '中文getUserName混写'],
]

for (const { mode, loader } of modes) {
  describe(`${mode}：跨写法互搜`, () => {
    it.each(CROSS)('查询 %s 命中原文 %s', async (query, raw) => {
      expect(identifierForms('getUserName')).toEqual(forms('get', 'user', 'name'))
      const tokenizer = await tokenizerOf(loader)
      const match = tokenizer.match(query)!.all
      if (tokenizer.degraded) {
        expect(match).not.toContain('w :')
        expect(tokenizer.columns(raw).w).toBe('')
      }
      expect(index(tokenizer, [raw, 'nameUserGet', 'jieba'])(match)).toContain(raw)
    })

    it.each(CROSS)('查询 %s 对原文 %s 的命中在段排序里算全中', async (query, raw) => {
      expect(identifierForms('getUserName')).toEqual(forms('get', 'user', 'name'))
      const tokenizer = await tokenizerOf(loader)
      expect(rankSegments([{ text: raw }], query, tokenizer).map(r => r.tier)).toEqual(['all'])
    })

    it('各段顺序轮换的写法不互相命中', async () => {
      expect(identifierForms('tableFile')).toEqual(forms('table', 'file'))
      const tokenizer = await tokenizerOf(loader)
      const search = index(tokenizer, ['nameUserGet', 'name_user_get', 'get_name_user', 'tableFile', 'table-file'])
      expect(search(tokenizer.match('getUserName')!.all)).toEqual([])
      expect(search(tokenizer.match('file_table')!.all)).toEqual([])
      expect(search(tokenizer.match('fileTable')!.all)).toEqual([])
    })

    it('不含字母的段不追加，版本号倒过来写不会命中', async () => {
      expect(identifierForms('0.2.1')).toBeUndefined()
      expect(identifierForms('2026-01-02')).toBeUndefined()
      const tokenizer = await tokenizerOf(loader)
      const search = index(tokenizer, ['0.2.1'])
      expect(search(tokenizer.match('1.0')!.all)).toEqual([])
      expect(search(tokenizer.match('2.1.0')!.all)).toEqual([])
      expect(search(tokenizer.match('0.2.1')!.all)).toEqual(['0.2.1'])
    })
  })
}

// 不追加时三列和查询表达式和上一版分词器逐字节相同；期望值取自上一版的实际输出。
const UNCHANGED: ReadonlyArray<{ text: string; isIdentifier: boolean; normal: [DialogueColumns, string]; degraded: [DialogueColumns, string] }> = [
  {
    text: '加上写锁', isIdentifier: false,
    normal: [{ w: '加上 写锁', b: '加上 上写 写锁', c: '加 上 写 锁' }, '(w : "加上写锁" OR b : "加上 上写 写锁")'],
    degraded: [{ w: '', b: '加上 上写 写锁', c: '加 上 写 锁' }, '(b : "加上") AND (b : "上写") AND (b : "写锁")'],
  },
  {
    text: 'jieba', isIdentifier: true,
    normal: [{ w: 'jieba', b: 'jieba', c: '' }, '(w : "jieba" OR b : "jieba")'],
    degraded: [{ w: '', b: 'jieba', c: '' }, '(b : "jieba")'],
  },
  {
    text: '300', isIdentifier: true,
    normal: [{ w: '300', b: '300', c: '' }, '(w : "300" OR b : "300")'],
    degraded: [{ w: '', b: '300', c: '' }, '(b : "300")'],
  },
  {
    text: HASH, isIdentifier: true,
    normal: [{ w: HASH, b: HASH, c: '' }, `(w : "${HASH}" OR b : "${HASH}")`],
    degraded: [{ w: '', b: HASH, c: '' }, `(b : "${HASH}")`],
  },
]

it('不追加的段（中文、单词、数字、超长哈希）三列和查询表达式和上一版逐字节相同', async () => {
  for (const { text, isIdentifier, normal, degraded } of UNCHANGED) {
    if (isIdentifier) expect(identifierForms(text)).toBeUndefined()
    for (const [loader, [columns, match]] of [[fakeLoader, normal], [missingLoader, degraded]] as const) {
      const tokenizer = await tokenizerOf(loader)
      expect(tokenizer.columns(text)).toEqual(columns)
      expect(tokenizer.match(text)!.all).toBe(match)
    }
  }
})

/**
 * 重建期间读的是上一版分词器建的旧代：拿新查询去查，上一版能命中的都还命中，蛇形旧行还能被驼峰查询命中。
 * 旧代的三列取自上一版的实际输出：非 CJK 段只有转小写后的原样。
 */
const OLD_ROWS: ReadonlyArray<{ raw: string; w: string; b: string; c: string }> = [
  { raw: 'getUserName', w: 'getusername', b: 'getusername', c: '' },
  { raw: 'get_user_name', w: 'get_user_name', b: 'get_user_name', c: '' },
  { raw: 'GetUserName', w: 'getusername', b: 'getusername', c: '' },
  { raw: 'src/search/jieba.ts', w: 'src/search/jieba.ts', b: 'src/search/jieba.ts', c: '' },
  { raw: '加上写锁', w: '加上 写锁', b: '加上 上写 写锁', c: '加 上 写 锁' },
  { raw: 'HTTPServer', w: 'httpserver', b: 'httpserver', c: '' },
]
// [查询, 上一版查询在旧代的命中, 新查询在旧代的命中]
const OLD_GENERATION: ReadonlyArray<readonly [string, string[], string[]]> = [
  ['getUserName', ['getUserName', 'GetUserName'], ['getUserName', 'get_user_name', 'GetUserName']],
  ['get_user_name', ['get_user_name'], ['getUserName', 'get_user_name', 'GetUserName']],
  ['getusername', ['getUserName', 'GetUserName'], ['getUserName', 'GetUserName']],
  ['HTTPServer', ['HTTPServer'], ['HTTPServer']],
  ['jieba.ts', ['src/search/jieba.ts'], ['src/search/jieba.ts']],
  ['src/search/jieba.ts', ['src/search/jieba.ts'], ['src/search/jieba.ts']],
  ['写锁', ['加上写锁'], ['加上写锁']],
]

for (const { mode, loader } of modes) {
  it(`${mode}：新查询查上一版建的旧代（标识符、路径、中文），命中只多不少`, async () => {
    expect(identifierForms('get_user_name')).toEqual(forms('get', 'user', 'name'))
    const tokenizer = await tokenizerOf(loader)
    const search = table(OLD_ROWS.map(({ raw, w, b, c }) => ({ raw, columns: { w: tokenizer.degraded ? '' : w, b, c } })))
    const hits = Object.fromEntries(OLD_GENERATION.map(([query]) => [query, search(tokenizer.match(query)!.all)]))
    for (const [query, before] of OLD_GENERATION) expect(hits[query]).toEqual(expect.arrayContaining(before))
    expect(hits).toEqual(Object.fromEntries(OLD_GENERATION.map(([query, , after]) => [query, after])))
  })
}
