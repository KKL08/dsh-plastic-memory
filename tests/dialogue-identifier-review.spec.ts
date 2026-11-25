import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { dialogueTerms, rankSegments } from '../src/search/dialogue-rank.ts'
import type { DialogueSegment } from '../src/search/dialogue-rank.ts'
import { dialogueTokenizer, identifierForms } from '../src/search/dialogue-tokenizer.ts'
import type { DialogueColumns } from '../src/search/dialogue-tokenizer.ts'
import { defaultJiebaLoader, resetJieba } from '../src/search/jieba-segmenter.ts'
import type { JiebaLoader } from '../src/search/jieba-segmenter.ts'
import { keywordRanker } from '../src/search/memory-quotes.ts'

const hasRealJieba = await defaultJiebaLoader.importJieba().then(() => true, () => false)
const main = Buffer.from('词典')
const fakeLoader: JiebaLoader = {
  async importJieba() {
    return { withDict: () => ({ loadDict() {}, cut: (text: string) => [text], cutForSearch: (text: string) => [text] }) }
  },
  readMainDictionary: () => main,
}
const missingLoader: JiebaLoader = {
  async importJieba() { throw Object.assign(new Error('未安装'), { code: 'MODULE_NOT_FOUND' }) },
  readMainDictionary: () => main,
}
const databases: DatabaseSync[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
  resetJieba()
})

function table(columns: DialogueColumns) {
  const db = new DatabaseSync(':memory:')
  databases.push(db)
  db.exec("CREATE VIRTUAL TABLE t USING fts5(w, b, c, tokenize = 'unicode61')")
  db.prepare('INSERT INTO t VALUES (?, ?, ?)').run(columns.w, columns.b, columns.c)
  return (match: string) => db.prepare('SELECT rowid FROM t WHERE t MATCH ?').all(match)
}

const OLD = [
  'base64_encode', 'utf8_decode', 'get_UserName', 'src/getUserName.ts',
  's3_bucket', 'oauth2_token', 'k8s_pod', 'file_v2.ts', 'node:http2', '@babel/core2',
  'v1.2.3', 'v2.0.0-beta.1', '0.2.1-rc1', '2026-11-25T01:15:22Z', '2.5gb',
  'Привет_Мир2', 'foo\uE000bar', 'foo_q\u0301bar',
].map(raw => [raw, raw] as const)
const OLD_PATHS = [
  ['getUserName.ts', 'src/getUserName.ts'],
  ['localhost:3000/api/v2', 'http://localhost:3000/api/v2'],
] as const
const LONG_PATHS = [
  ['api/v2/users', 'https://example.com/api/v2/users#section-1'],
  ['base64_encode', 'https://example.com/api/v1/org/repo/base64_encode'],
  ['getUserName.ts', 'packages/app/src/lib/search/raw/dialogue/getUserName.ts'],
  ['file_v2.ts', 'https://docs.example.com/very/long/documentation/path/for/file_v2.ts'],
] as const
const RANK = [
  ['getUserName', 'getusername'], ['get_user_name', 'getusername'],
  ['userName', 'username'], ['file_name', 'filename'],
  ['get_urls', 'getURLs'], ['getURLs', 'get_urls'],
  ['parse_ids', 'parseIDs'], ['parseIDs', 'parse_ids'], ['user_ids', 'userIDs'],
  ['oauth2_client', 'OAuth2Client'], ['ios_app', 'iOSApp'],
  ['修改 userName', '修改 username'],
  ['getUserName', 'https://example.com/api/v1/org/repo/getUserName'],
  ['getUserName', 'a/b/c/d/e/f/g/h/getUserName'],
  ['sha256', 'a/b/c/d/e/f/g/h/sha256'],
  ...LONG_PATHS,
] as const

for (const { mode, loader } of [{ mode: '有词典', loader: fakeLoader }, { mode: '缺 jieba', loader: missingLoader }]) {
  describe(mode, () => {
    async function tokenizerOf() {
      resetJieba(loader)
      return dialogueTokenizer({ log: { warn() {} } })
    }

    it('驼峰原样等于拼合词时，每列的短语只出现一次且拆分在前', async () => {
      const tokenizer = await tokenizerOf()
      const expression = tokenizer.degraded
        ? '(b : "get user name" OR b : "getusername")'
        : '(w : "get user name" OR w : "getusername" OR b : "get user name" OR b : "getusername")'
      expect(tokenizer.match('getUserName')).toEqual({ all: expression, any: expression })
    })

    it('原样不同于拼合词时保留三种写法且拆分在前', async () => {
      const tokenizer = await tokenizerOf()
      const expression = tokenizer.degraded
        ? '(b : "base 64 encode" OR b : "base64encode" OR b : "base64_encode")'
        : '(w : "base 64 encode" OR w : "base64encode" OR w : "base64_encode" OR b : "base 64 encode" OR b : "base64encode" OR b : "base64_encode")'
      expect(tokenizer.match('base64_encode')).toEqual({ all: expression, any: expression })
    })

    it.each([...OLD, ...OLD_PATHS])('旧代查询 %s 命中 %s 时，新查询也命中', async (query, raw) => {
      const tokenizer = await tokenizerOf()
      // 旧代 other 段只存 NFKC 后的小写原样，不借用新版本的列生成逻辑。
      const original = raw.normalize('NFKC').toLowerCase()
      const search = table({ w: tokenizer.degraded ? '' : original, b: original, c: '' })
      const phrase = '"' + query.normalize('NFKC').toLowerCase() + '"'
      const oldMatch = tokenizer.degraded ? `(b : ${phrase})` : `(w : ${phrase} OR b : ${phrase})`
      const before = search(oldMatch)
      expect(before).toHaveLength(1)
      expect(search(tokenizer.match(query)!.all)).toEqual(expect.arrayContaining(before))
    })

    it.each(LONG_PATHS)('新库查询 %s 命中不追加的长路径 %s', async (query, raw) => {
      const tokenizer = await tokenizerOf()
      expect(identifierForms(raw)).toBeUndefined()
      expect(table(tokenizer.columns(raw))(tokenizer.match(query)!.all)).toHaveLength(1)
    })

    it.each(RANK)('查询 %s 命中 %s 后分为全中并保留代表词', async (query, raw) => {
      const tokenizer = await tokenizerOf()
      expect(table(tokenizer.columns(raw))(tokenizer.match(query)!.all)).toHaveLength(1)
      const [ranked] = rankSegments([{ text: raw }], query, tokenizer)
      expect(ranked!.tier).toBe('all')
      expect(ranked!.matched).toEqual(dialogueTerms(query, tokenizer))
      if (query === '修改 userName') expect(ranked!.matched).toEqual(['修改', 'user name'])
    })

    it('单个驼峰查询命中全小写原文时，原话带出算作对上', async () => {
      const tokenizer = await tokenizerOf()
      const segment: DialogueSegment = { sessionId: 's', seq: 1, turnSeq: 1, segment: 0, at: undefined, speaker: 'user', text: 'getusername' }
      expect(table(tokenizer.columns(segment.text))(tokenizer.match('getUserName')!.all)).toHaveLength(1)
      expect(keywordRanker('getUserName', tokenizer)([segment])).toEqual([{ segment, isMatched: true }])
    })
  })
}

it.each([
  ['数据库', '数据，据库'],
  ['共和国', '共和 和国'],
  ['写锁定', '写锁 锁定'],
])('有词典时查询 %s 对上 %s 的二元组仍分为子串命中', async (query, raw) => {
  resetJieba(fakeLoader)
  const tokenizer = await dialogueTokenizer()
  expect(table(tokenizer.columns(raw))(tokenizer.match(query)!.all)).toHaveLength(1)
  expect(rankSegments([{ text: raw }], query, tokenizer)[0]!.tier).toBe('substring')
})

it('有词典时数据库整词命中仍分为全中', async () => {
  resetJieba(fakeLoader)
  const tokenizer = await dialogueTokenizer()
  expect(rankSegments([{ text: '数据库' }], '数据库', tokenizer)[0]!.tier).toBe('all')
})

it('有词典时查询里的单字在 w 列单独成词，和别的词一起整词命中仍分为全中', async () => {
  resetJieba(fakeLoader)
  const tokenizer = await dialogueTokenizer()
  expect(tokenizer.match('他 上海')!.all).toBe('c : "他" AND (w : "上海" OR b : "上海")')
  expect(rankSegments([{ text: '他 上海' }], '他 上海', tokenizer)[0]!.tier).toBe('all')
})

it.skipIf(!hasRealJieba)('真实词典下查询带单字、原文整词都在时分为全中', async () => {
  resetJieba()
  const tokenizer = await dialogueTokenizer()
  const raw = '他在上海交通大学读计算机科学'
  expect(table(tokenizer.columns(raw))(tokenizer.match('他在上海')!.all)).toHaveLength(1)
  expect(rankSegments([{ text: raw }], '他在上海', tokenizer)[0]!.tier).toBe('all')
})

it.skipIf(!hasRealJieba)('真实词典下中华人民只命中长句的二元组时分为子串命中', async () => {
  resetJieba()
  const tokenizer = await dialogueTokenizer()
  const raw = '中华人民共和国成立了'
  expect(table(tokenizer.columns(raw))(tokenizer.match('中华人民')!.all)).toHaveLength(1)
  expect(rankSegments([{ text: raw }], '中华人民', tokenizer)[0]!.tier).toBe('substring')
})
