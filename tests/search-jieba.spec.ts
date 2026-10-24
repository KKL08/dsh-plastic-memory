import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fakeExec } from './helpers/exec.ts'
import { record } from './helpers/record.ts'
import { InMemoryTable, MemoryStore } from '../src/store.ts'
import { executeSearch, type SearchToolDeps } from '../src/tools/search.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'
import { createTokenizer } from '../src/search/tokenizer.ts'
import {
  defaultJiebaLoader, resetJieba, tokenizerForQuery,
  type JiebaClass, type JiebaInstance, type JiebaLoader,
} from '../src/search/jieba-segmenter.ts'

// jieba 加载器是进程边界：退化链用注入的假加载器模拟缺包、二进制缺失、坏词典；
// 真实包的用例在 @node-rs/jieba 可解析、平台二进制可加载时才跑（可选依赖没装上时 skip）。
const hasRealJieba = await defaultJiebaLoader.importJieba().then(() => true, () => false)

const bigram = createTokenizer()
const registry = buildTypeRegistry({ template: 'coding', customTypes: {} })

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pm-jieba-'))
  resetJieba()
})
afterEach(async () => {
  resetJieba()
  await rm(root, { recursive: true, force: true })
})

/** 收集告警，断言每种失败只告一次。 */
function captureLog() {
  const warnings: string[] = []
  return { warnings, log: { warn: (message: string) => { warnings.push(message) } } }
}

/** 词典按 jieba 格式（每行「词 [词频] [词性]」）解析；格式不对时像真包一样抛错。 */
function parseDict(dict: Uint8Array): string[] {
  const lines = Buffer.from(dict).toString('utf8').split('\n').filter(l => l.trim() !== '')
  for (const line of lines) if (!/^\S+(?: \d+)?(?: \S+)?$/.test(line.trim())) throw new Error('Load dict failed')
  return lines.map(l => l.trim().split(' ')[0]!)
}

/** 正向最大匹配：词典外的字逐字输出。足以观察「造词从碎片变整词」。 */
function maxMatch(text: string, words: ReadonlySet<string>): string[] {
  const chars = [...text]
  const out: string[] = []
  for (let i = 0; i < chars.length;) {
    let len = Math.min(4, chars.length - i)
    while (len > 1 && !words.has(chars.slice(i, i + len).join(''))) len--
    out.push(chars.slice(i, i + len).join(''))
    i += len
  }
  return out
}

const FakeJieba: JiebaClass = {
  withDict(dict) {
    const words = new Set(parseDict(dict))
    const instance: JiebaInstance = {
      // 逐行收词、遇坏行才抛：模拟解析中途失败时实例已收进一部分词条
      loadDict(more) {
        for (const line of Buffer.from(more).toString('utf8').split('\n')) if (line.trim() !== '') words.add(parseDict(Buffer.from(line))[0]!)
      },
      cutForSearch: text => maxMatch(text, words),
    }
    return instance
  },
}

/** 可注入的假加载器，计数 import 与主词典读取次数。 */
function fakeLoader(opts: { importError?: Error; mainDictionaryError?: Error } = {}) {
  const calls = { importJieba: 0, readMainDictionary: 0 }
  const loader: JiebaLoader = {
    async importJieba() {
      calls.importJieba++
      if (opts.importError) throw opts.importError
      return FakeJieba
    },
    readMainDictionary() {
      calls.readMainDictionary++
      if (opts.mainDictionaryError) throw opts.mainDictionaryError
      return Buffer.from('宿主 3 n\n插件 3 n\n配置 3 n\n表单 3 n\n')
    },
  }
  return { loader, calls }
}

function codedError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code })
}

describe.skipIf(!hasRealJieba)('jieba 档：真实 @node-rs/jieba', () => {
  it('「宿主插件页的配置表单」切出 宿主 / 插件 / 配置 / 表单 等整词；Latin 段「readScope」仍拆出 read、scope', async () => {
    const { warnings, log } = captureLog()
    const tokenize = await tokenizerForQuery('宿主插件页的配置表单 readScope', { log })
    const tokens = tokenize('宿主插件页的配置表单 readScope')

    expect(tokens).toEqual(expect.arrayContaining(['宿主', '插件', '配置', '表单', 'readscope', 'read', 'scope']))
    // 不再有跨词碎片
    expect(tokens).not.toContain('主插')
    expect(tokens).not.toContain('置表')
    expect(warnings).toEqual([])
  })

  it('用户词典追加：只含一个造词的词典让该词从碎片变整词，同时主词典的通用词切法不变；改路径后下一次搜索生效；清空回到只用主词典', async () => {
    const coined = join(root, 'coined.dict.txt')
    const other = join(root, 'other.dict.txt')
    await writeFile(coined, '插件记忆 10 n\n')
    await writeFile(other, '宿主记忆 10 n\n')
    const { warnings, log } = captureLog()
    let path: string | undefined
    const opts = { log, userDictionaryPath: () => path }
    const cut = async (text: string) => (await tokenizerForQuery(text, opts))(text)

    const mainOnly = await cut('插件记忆 宿主记忆 宿主插件页的配置表单')
    expect(mainOnly).not.toContain('插件记忆')
    expect(mainOnly).toEqual(expect.arrayContaining(['插件', '记忆']))

    path = coined
    const withCoined = await cut('插件记忆 宿主记忆 宿主插件页的配置表单')
    expect(withCoined).toContain('插件记忆')
    expect(withCoined).not.toContain('宿主记忆')
    // 追加而非替换：通用词照旧
    expect(await cut('宿主插件页的配置表单')).toEqual((await tokenizerForQuery('宿主', {}))('宿主插件页的配置表单'))
    expect(await cut('宿主插件页的配置表单')).toEqual(expect.arrayContaining(['宿主', '插件', '配置', '表单']))

    path = other
    const withOther = await cut('插件记忆 宿主记忆')
    expect(withOther).toContain('宿主记忆')
    expect(withOther).not.toContain('插件记忆')

    path = undefined
    expect(await cut('插件记忆 宿主记忆 宿主插件页的配置表单')).toEqual(mainOnly)
    path = ''
    expect(await cut('插件记忆 宿主记忆 宿主插件页的配置表单')).toEqual(mainOnly)
    expect(warnings).toEqual([])
  })
})

describe('jieba 档：懒加载与单例（注入加载器）', () => {
  it('纯 Latin 查询不触发加载；同进程第二次搜索不再加载', async () => {
    const { loader, calls } = fakeLoader()
    resetJieba(loader)
    const store = new MemoryStore(new InMemoryTable())
    await store.put(record({ id: 'mem_host', content: '宿主插件页的配置表单 readScope' }))
    const deps: SearchToolDeps = {
      store, registry,
      resolveContext: async () => ({ workspacePath: undefined, session: { id: 's', lastSeq: 1 } }),
    }

    const latin = await executeSearch({ query: 'readScope' }, fakeExec(), deps)
    expect(latin.hits.map(h => h.id)).toEqual(['mem_host'])
    expect(calls).toEqual({ importJieba: 0, readMainDictionary: 0 })

    const first = await executeSearch({ query: '配置表单' }, fakeExec(), deps)
    const second = await executeSearch({ query: '宿主插件' }, fakeExec(), deps)
    expect(first.hits.map(h => h.id)).toEqual(['mem_host'])
    expect(second.hits.map(h => h.id)).toEqual(['mem_host'])
    expect(calls).toEqual({ importJieba: 1, readMainDictionary: 1 })
  })

  it('CJK 段由 jieba 切、Latin 段仍走默认切法；假名与谚文不交给词典', async () => {
    resetJieba(fakeLoader().loader)
    const tokenize = await tokenizerForQuery('宿主', {})

    expect(tokenize('宿主插件readScope配置表单')).toEqual(['宿主', '插件', 'readscope', 'read', 'scope', '配置', '表单'])
    expect(tokenize('カタカナ')).toEqual(bigram('カタカナ'))
  })

  it('不含汉字的查询不加载词典（假名、谚文照旧二字切分）', async () => {
    const { loader, calls } = fakeLoader()
    resetJieba(loader)
    const tokenize = await tokenizerForQuery('カタカナ 한국어', {})

    expect(tokenize('カタカナ 한국어')).toEqual(bigram('カタカナ 한국어'))
    expect(calls.importJieba).toBe(0)
  })
})

describe('退化链（注入加载器）：jieba + 用户词典 → 只用主词典 → bigram，每种失败只告警一次', () => {
  const text = '宿主插件页的配置表单 readScope'

  it('缺包：import 报 ERR_MODULE_NOT_FOUND，退到 bigram，只告警一次', async () => {
    const { loader, calls } = fakeLoader({ importError: codedError("Cannot find package '@node-rs/jieba'", 'ERR_MODULE_NOT_FOUND') })
    resetJieba(loader)
    const { warnings, log } = captureLog()

    expect((await tokenizerForQuery(text, { log }))(text)).toEqual(bigram(text))
    expect((await tokenizerForQuery(text, { log }))(text)).toEqual(bigram(text))
    expect(calls.importJieba).toBe(1)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/@node-rs\/jieba/)
    expect(warnings[0]).toMatch(/二字切分/)
  })

  it('平台二进制缺失：import 抛错，退到 bigram，只告警一次', async () => {
    const { loader, calls } = fakeLoader({ importError: new Error('Cannot find native binding.') })
    resetJieba(loader)
    const { warnings, log } = captureLog()

    expect((await tokenizerForQuery(text, { log }))(text)).toEqual(bigram(text))
    expect((await tokenizerForQuery(text, { log }))(text)).toEqual(bigram(text))
    expect(calls.importJieba).toBe(1)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/二进制/)
  })

  it('主词典加载失败：退到 bigram，只告警一次', async () => {
    const { loader, calls } = fakeLoader({ mainDictionaryError: codedError('ENOENT: dict.txt', 'ENOENT') })
    resetJieba(loader)
    const { warnings, log } = captureLog()

    expect((await tokenizerForQuery(text, { log }))(text)).toEqual(bigram(text))
    expect((await tokenizerForQuery(text, { log }))(text)).toEqual(bigram(text))
    expect(calls.readMainDictionary).toBe(1)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/主词典/)
  })

  it('用户词典无效（不存在、相对路径）或损坏：降到只用主词典，同一路径只告警一次', async () => {
    resetJieba(fakeLoader().loader)
    const mainOnly = (await tokenizerForQuery(text, {}))(text)
    expect(mainOnly).toContain('配置')
    expect(mainOnly).not.toEqual(bigram(text))

    const corrupt = join(root, 'corrupt.dict.txt')
    await writeFile(corrupt, '可塑性记忆 abc n\n这一行 有 太多 字段 了\n')
    const { warnings, log } = captureLog()
    for (const path of [join(root, 'missing.dict.txt'), 'relative/dict.txt', corrupt]) {
      const opts = { log, userDictionaryPath: () => path }
      expect((await tokenizerForQuery(text, opts))(text)).toEqual(mainOnly)
      expect((await tokenizerForQuery(text, opts))(text)).toEqual(mainOnly)
    }
    expect(warnings).toHaveLength(3)
    expect(warnings[0]).toMatch(/读取失败/)
    expect(warnings[1]).toMatch(/绝对路径/)
    expect(warnings[2]).toMatch(/解析失败/)
  })

  it('用户词典损坏时不留下半份词条：降级后的实例与只用主词典一致', async () => {
    resetJieba(fakeLoader().loader)
    const half = join(root, 'half.dict.txt')
    await writeFile(half, '插件配置 10 n\n坏 行 多 字段\n')
    const plain = (await tokenizerForQuery('插件配置', {}))('插件配置')
    const { log } = captureLog()

    expect((await tokenizerForQuery('插件配置', { log, userDictionaryPath: () => half }))('插件配置')).toEqual(plain)
  })
})
