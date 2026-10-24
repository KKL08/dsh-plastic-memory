import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join } from 'node:path'
import { bigramSegmenter, createTokenizer, type CjkSegmenter } from './tokenizer.ts'

/**
 * 本模块用到的 @node-rs/jieba 最小接口。不引用包的 .d.ts：这个可选依赖装与不装，类型检查结果一样。
 * hmm 参数在包里缺省 false，这里一律显式传 true（新词识别）。
 */
export interface JiebaInstance {
  loadDict(dict: Uint8Array): void
  cutForSearch(text: string, hmm: boolean): string[]
}
export interface JiebaClass {
  withDict(dict: Uint8Array): JiebaInstance
}

/** 进程边界：加载包、读主词典。测试注入假实现，模拟缺包、平台二进制缺失、词典损坏。 */
export interface JiebaLoader {
  importJieba(): Promise<JiebaClass>
  readMainDictionary(): Uint8Array
}

export interface SegmenterLog {
  warn(message: string, detail?: unknown): void
}

export interface QueryTokenizerOptions {
  /** 用户词典的绝对路径，每次搜索现读；变了下一次搜索就重建实例，空值只用主词典。 */
  userDictionaryPath?: () => string | undefined
  log?: SegmenterLog
}

// specifier 放在变量里：类型检查与打包都不把它当静态依赖，没装这个包时编译照常通过。
const JIEBA_PACKAGE: string = '@node-rs/jieba'

export const defaultJiebaLoader: JiebaLoader = {
  async importJieba() {
    const mod = await import(JIEBA_PACKAGE) as { Jieba?: JiebaClass; default?: { Jieba?: JiebaClass } }
    const Jieba = mod.Jieba ?? mod.default?.Jieba
    if (Jieba === undefined) throw new Error(`${JIEBA_PACKAGE} 没有导出 Jieba`)
    return Jieba
  },
  // 只读 dict.txt：包自带的 dict 模块会把 idf.txt 也一并读成常驻 Buffer，而检索用不到 idf。
  readMainDictionary() {
    const manifest = createRequire(import.meta.url).resolve(`${JIEBA_PACKAGE}/package.json`)
    return readFileSync(join(dirname(manifest), 'dict.txt'))
  },
}

// 模块级单例：包每进程只 import 一次；实例按用户词典路径建，路径变了才重建。
let loader: JiebaLoader = defaultJiebaLoader
let jiebaClass: Promise<JiebaClass | undefined> | undefined
let current: { dictionaryPath: string | undefined; jieba: Promise<JiebaInstance | undefined> } | undefined
const warned = new Set<string>()

/** 换加载器并清空单例与告警记录。测试用；不传参数回到真实加载器。 */
export function resetJieba(next: JiebaLoader = defaultJiebaLoader): void {
  loader = next
  jiebaClass = undefined
  current = undefined
  warned.clear()
}

function warnOnce(log: SegmenterLog, key: string, message: string, detail: unknown): void {
  if (warned.has(key)) return
  warned.add(key)
  log.warn(message, detail)
}

function isModuleNotFound(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code
  return code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND'
}

function loadJiebaClass(log: SegmenterLog): Promise<JiebaClass | undefined> {
  jiebaClass ??= loader.importJieba().catch((err: unknown) => {
    if (isModuleNotFound(err)) {
      warnOnce(log, 'package-missing', `[plastic-memory] 未安装可选依赖 ${JIEBA_PACKAGE}，中文检索退回二字切分`, err)
    } else {
      warnOnce(log, 'native-binding', `[plastic-memory] ${JIEBA_PACKAGE} 加载失败（当前平台可能缺预编译二进制），中文检索退回二字切分`, err)
    }
    return undefined
  })
  return jiebaClass
}

function withMainDictionary(Jieba: JiebaClass, log: SegmenterLog): JiebaInstance | undefined {
  try {
    return Jieba.withDict(loader.readMainDictionary())
  } catch (err) {
    warnOnce(log, 'main-dictionary', '[plastic-memory] jieba 主词典加载失败，中文检索退回二字切分', err)
    return undefined
  }
}

/** 退化链：主词典 + 用户词典 → 只用主词典 → undefined（调用方退回 bigram）。不抛出。 */
async function buildJieba(dictionaryPath: string | undefined, log: SegmenterLog): Promise<JiebaInstance | undefined> {
  const Jieba = await loadJiebaClass(log)
  if (Jieba === undefined) return undefined
  const jieba = withMainDictionary(Jieba, log)
  if (jieba === undefined || dictionaryPath === undefined) return jieba
  const key = `user-dictionary:${dictionaryPath}`
  if (!isAbsolute(dictionaryPath)) {
    warnOnce(log, key, `[plastic-memory] 用户词典路径必须是绝对路径（${dictionaryPath}），只用主词典`, undefined)
    return jieba
  }
  let dict: Uint8Array
  try {
    dict = readFileSync(dictionaryPath)
  } catch (err) {
    warnOnce(log, key, `[plastic-memory] 用户词典 ${dictionaryPath} 读取失败，只用主词典`, err)
    return jieba
  }
  try {
    jieba.loadDict(dict)
    return jieba
  } catch (err) {
    warnOnce(log, key, `[plastic-memory] 用户词典 ${dictionaryPath} 解析失败（每行「词 词频 词性」），只用主词典`, err)
    // 解析到一半失败时实例可能已收进部分词条，换一个干净的只用主词典的实例
    return withMainDictionary(Jieba, log)
  }
}

const HAN = /\p{Script=Han}/u
// 汉字段交给词典；假名、谚文 jieba 只会逐字切，仍走二字滑窗。
const HAN_OR_OTHER = /\p{Script=Han}+|[^\p{Script=Han}]+/gu

/**
 * 切分用 cutForSearch：长词之外再出子词（「新鲜度」→ 新鲜 / 鲜度 / 新鲜度），查询只写了词的一部分也能按 token 命中。
 * 评估集上它比只出一种切法的 cut 多对两条「部分词」查询，其余持平。
 */
function jiebaSegmenter(jieba: JiebaInstance): CjkSegmenter {
  return {
    segment(run) {
      const out: string[] = []
      for (const [part] of run.matchAll(HAN_OR_OTHER)) {
        if (!HAN.test(part)) out.push(...bigramSegmenter.segment(part))
        else out.push(...jieba.cutForSearch(part, true))
      }
      return out
    },
  }
}

const bigramTokenizer = createTokenizer()

/**
 * 按查询选分词器，查询与记录两侧共用返回的这一个。查询不含汉字时直接用 bigram、不加载词典：
 * 纯 Latin 的查询 token 不会出现在记录的汉字段里，切法不影响结果。jieba 不可用时同样退回 bigram。
 */
export async function tokenizerForQuery(query: string, opts: QueryTokenizerOptions = {}): Promise<(text: string) => string[]> {
  if (!HAN.test(query)) return bigramTokenizer
  const log = opts.log ?? console
  const dictionaryPath = opts.userDictionaryPath?.()?.trim() || undefined
  if (current === undefined || current.dictionaryPath !== dictionaryPath) {
    current = { dictionaryPath, jieba: buildJieba(dictionaryPath, log) }
  }
  const jieba = await current.jieba
  return jieba === undefined ? bigramTokenizer : createTokenizer({ cjk: jiebaSegmenter(jieba) })
}
