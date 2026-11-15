import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { ParseCache, type FileSignature } from '../src/storage/parse-cache.ts'
import type { FileLocation } from '../src/storage/frontmatter.ts'

const DIR = '/root/global'
const PATH = join(DIR, 'a.md')
const GLOBAL: FileLocation = { scope: 'global' }
const T0 = 1_700_000_000_000
const SIG: FileSignature = { ino: 7, size: 120, mtimeMs: T0, ctimeMs: T0 }
/** 读前时刻：离文件最后改动足够久，可以进缓存。 */
const SETTLED = T0 + 3_000

describe('解析缓存模块', () => {
  it('PC-01：路径、签名、位置都相同才命中，命中给回存进去的原文与解析结果', () => {
    const cache = new ParseCache<{ n: number }>()
    cache.store(PATH, SIG, GLOBAL, SETTLED, { raw: 'x', decoded: { n: 1 } })
    expect(cache.lookup(PATH, { ...SIG }, { scope: 'global' })).toEqual({ raw: 'x', decoded: { n: 1 } })
    expect(cache.lookup(join(DIR, 'b.md'), SIG, GLOBAL)).toBeUndefined()
  })

  it.each([
    ['大小（PC-02）', { size: 121 }],
    ['ctime（PC-03：mtime 被设回原值）', { ctimeMs: T0 + 1 }],
    ['inode（PC-04：rename 盖过去）', { ino: 8 }],
    ['mtime', { mtimeMs: T0 + 1 }],
  ])('签名里的%s变了：不命中，旧条目逐出', (_, change) => {
    const cache = new ParseCache<number>()
    cache.store(PATH, SIG, GLOBAL, SETTLED, { raw: 'x', decoded: 1 })
    expect(cache.lookup(PATH, { ...SIG, ...change }, GLOBAL)).toBeUndefined()
    expect(cache.size).toBe(0)
  })

  it('PC-06：位置不同（.workspace 标记改了项目路径）不命中', () => {
    const cache = new ParseCache<number>()
    const ws = (workspacePath: string): FileLocation => ({ scope: 'workspace', workspacePath })
    cache.store(PATH, SIG, ws('/p/a'), SETTLED, { raw: 'x', decoded: 1 })
    expect(cache.lookup(PATH, SIG, ws('/p/b'))).toBeUndefined()
    cache.store(PATH, SIG, ws('/p/a'), SETTLED, { raw: 'x', decoded: 1 })
    expect(cache.lookup(PATH, SIG, GLOBAL)).toBeUndefined()
  })

  it.each([
    ['mtime 距读前时刻不到 3 s', SIG, T0 + 2_999],
    ['ctime 距读前时刻不到 3 s（mtime 被设回很早）', { ...SIG, mtimeMs: T0 - 60_000 }, T0 + 2_999],
    ['mtime 在读前时刻之后（时钟不一致）', { ...SIG, mtimeMs: T0 + 10_000, ctimeMs: T0 - 60_000 }, T0 + 3_000],
  ])('PC-05：%s不存', (_, sig, readStartedAt) => {
    const cache = new ParseCache<number>()
    cache.store(PATH, sig, GLOBAL, readStartedAt, { raw: 'x', decoded: 1 })
    expect(cache.lookup(PATH, sig, GLOBAL)).toBeUndefined()
  })

  it('PC-05：恰好 3 s 时存', () => {
    const cache = new ParseCache<number>()
    cache.store(PATH, SIG, GLOBAL, T0 + 3_000, { raw: 'x', decoded: 1 })
    expect(cache.lookup(PATH, SIG, GLOBAL)?.decoded).toBe(1)
  })

  it('PC-05：不该存的那次读也会把同一路径上已经过时的条目清掉', () => {
    const cache = new ParseCache<number>()
    cache.store(PATH, SIG, GLOBAL, SETTLED, { raw: 'old', decoded: 1 })
    cache.store(PATH, { ...SIG, size: 9, mtimeMs: T0 + 5_000, ctimeMs: T0 + 5_000 }, GLOBAL, T0 + 5_001, { raw: 'new', decoded: 2 })
    expect(cache.lookup(PATH, SIG, GLOBAL)).toBeUndefined()
    expect(cache.size).toBe(0)
  })

  it('PC-09：存入时深冻结，改嵌套字段抛错', () => {
    const cache = new ParseCache<{ record: { tags: string[] } }>()
    const decoded = { record: { tags: ['a'] } }
    cache.store(PATH, SIG, GLOBAL, SETTLED, { raw: 'x', decoded })
    const hit = cache.lookup(PATH, SIG, GLOBAL)!
    expect(() => { hit.decoded!.record.tags.push('b') }).toThrow(TypeError)
    expect(() => { (hit.decoded!.record as { tags: string[] }).tags = [] }).toThrow(TypeError)
  })

  it('自引用的解析结果（YAML 锚点）也能存', () => {
    const cache = new ParseCache<{ self?: unknown }>()
    const decoded: { self?: unknown } = {}
    decoded.self = decoded
    cache.store(PATH, SIG, GLOBAL, SETTLED, { raw: 'x', decoded })
    expect(Object.isFrozen(cache.lookup(PATH, SIG, GLOBAL)!.decoded)).toBe(true)
  })

  it('不进缓存的那次（racy 窗口内）解析结果同样冻结', () => {
    const cache = new ParseCache<{ tags: string[] }>()
    const decoded = { tags: ['a'] }
    cache.store(PATH, SIG, GLOBAL, T0, { raw: 'x', decoded })
    expect(cache.lookup(PATH, SIG, GLOBAL)).toBeUndefined()
    expect(() => { decoded.tags.push('b') }).toThrow(TypeError)
  })

  it('只存原文（预筛没过、还没解析）也算命中，解析结果为空', () => {
    const cache = new ParseCache<number>()
    cache.store(PATH, SIG, GLOBAL, SETTLED, { raw: 'x' })
    expect(cache.lookup(PATH, SIG, GLOBAL)).toEqual({ raw: 'x' })
  })

  it('PC-10：超过上限按最久未用逐出', () => {
    const cache = new ParseCache<number>({ maxEntries: 2 })
    const p = (n: string) => join(DIR, `${n}.md`)
    cache.store(p('a'), SIG, GLOBAL, SETTLED, { raw: 'a', decoded: 1 })
    cache.store(p('b'), SIG, GLOBAL, SETTLED, { raw: 'b', decoded: 2 })
    expect(cache.lookup(p('a'), SIG, GLOBAL)).toBeDefined()   // a 刚用过，b 成了最久未用
    cache.store(p('c'), SIG, GLOBAL, SETTLED, { raw: 'c', decoded: 3 })
    expect(cache.lookup(p('b'), SIG, GLOBAL)).toBeUndefined()
    expect(cache.lookup(p('a'), SIG, GLOBAL)).toBeDefined()
    expect(cache.lookup(p('c'), SIG, GLOBAL)).toBeDefined()
  })

  it('上限为 0 等于关掉缓存', () => {
    const cache = new ParseCache<number>({ maxEntries: 0 })
    cache.store(PATH, SIG, GLOBAL, SETTLED, { raw: 'x', decoded: 1 })
    expect(cache.lookup(PATH, SIG, GLOBAL)).toBeUndefined()
  })

  it('evict 逐出一条；retain 只留目录里还列得出的名字，不碰子目录和别的目录', () => {
    const cache = new ParseCache<number>()
    const archived = join(DIR, '.archive', 'x.md')
    const other = join('/root/ws', 'a.md')
    for (const path of [PATH, join(DIR, 'gone.md'), archived, other]) cache.store(path, SIG, GLOBAL, SETTLED, { raw: path, decoded: 1 })
    cache.retain(DIR, new Set(['a.md']))
    expect(cache.lookup(join(DIR, 'gone.md'), SIG, GLOBAL)).toBeUndefined()
    expect(cache.lookup(PATH, SIG, GLOBAL)).toBeDefined()
    expect(cache.lookup(archived, SIG, GLOBAL)).toBeDefined()
    expect(cache.lookup(other, SIG, GLOBAL)).toBeDefined()
    cache.evict(PATH)
    expect(cache.lookup(PATH, SIG, GLOBAL)).toBeUndefined()
  })
})
