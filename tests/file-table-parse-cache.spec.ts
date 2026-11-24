import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { access, mkdir, mkdtemp, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileTable } from '../src/storage/file-table.ts'
import { ParseCache } from '../src/storage/parse-cache.ts'
import { decodeFile, encodeRecord, type FileLocation } from '../src/storage/frontmatter.ts'
import { ARCHIVE_DIR, GLOBAL_DIR, WORKSPACE_MARKER, workspaceDirName } from '../src/storage/paths.ts'
import { MemoryStore } from '../src/store.ts'
import { executeSearch } from '../src/tools/search.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'
import type { RecallStats } from '../src/storage/schema.ts'
import type { MemoryRecord } from '../src/record-schema.ts'
import { record } from './helpers/record.ts'
import { fakeExec } from './helpers/exec.ts'
import { InMemoryKvTable, InMemoryBatchKvTable } from './helpers/in-memory-kv.ts'
import { indexText, indexedIds } from './helpers/topic-index.ts'

// 解析缓存接进 FileTable 的读取路径（readScope、检索）：在文件系统边界看读了哪些记忆文件的内容，
// 外部改写用真实的 utimes / rename；粗时间戳与「读取中途卡住」在 stat / readFile 上模拟。
const fsHooks = vi.hoisted(() => ({
  reads: [] as string[],
  /** 给了就把记忆文件 stat 的 mtime、ctime 都换成这个值：模拟时间戳粒度粗到两次写落在同一格。 */
  coarseTime: undefined as number | undefined,
  /** 内容读完、交回调用方之前等它：模拟读取进行到一半。 */
  afterRead: undefined as ((path: string) => Promise<void>) | undefined,
}))
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const isMemoryFile = (p: unknown) => String(p).endsWith('.md')
  return {
    ...actual,
    stat: (async (...args: Parameters<typeof actual.stat>) => {
      const s = await actual.stat(...args)
      if (fsHooks.coarseTime === undefined || !isMemoryFile(args[0])) return s
      return Object.assign(Object.create(Object.getPrototypeOf(s)), s, { mtimeMs: fsHooks.coarseTime, ctimeMs: fsHooks.coarseTime })
    }) as typeof actual.stat,
    readFile: (async (...args: Parameters<typeof actual.readFile>) => {
      if (!isMemoryFile(args[0])) return actual.readFile(...args)
      fsHooks.reads.push(String(args[0]))
      const content = await actual.readFile(...args)
      await fsHooks.afterRead?.(String(args[0]))
      return content
    }) as typeof actual.readFile,
  }
})

let root: string
let clock: number
let stats: InMemoryKvTable<RecallStats>
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pm-parse-cache-'))
  clock = Date.now() + 10_000   // 刚写下的文件也已过了 racy 窗口；要看窗口的用例自己拨回
  stats = new InMemoryKvTable<RecallStats>()
  fsHooks.reads = []
  fsHooks.coarseTime = undefined
  fsHooks.afterRead = undefined
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

const globalDir = () => join(root, GLOBAL_DIR)
/** 外部改写后把 mtime 设回的那个值（整秒）。 */
const OLD_SECONDS = 1_700_000_000
const newTable = (parseCache = new ParseCache<never>()) =>
  new FileTable({ root, stats, now: () => clock, parseCache: parseCache as ParseCache<never> })

async function seed(name: string, partial: Partial<MemoryRecord>, dir = globalDir()): Promise<string> {
  await mkdir(dir, { recursive: true })
  const path = join(dir, `${name}.md`)
  await writeFile(path, encodeRecord(record({ name, ...partial }), {}))
  return path
}

/** 跑 fn，返回期间读过内容的记忆文件。 */
async function contentReads(fn: () => Promise<unknown>): Promise<string[]> {
  fsHooks.reads = []
  await fn()
  return [...fsHooks.reads]
}

describe('解析缓存：FileTable 读取路径', () => {
  it('PC-01：文件没变时第二次 readScope 不读文件内容，结果逐字段相同；召回统计每次现合并', async () => {
    await seed('a', { id: 'mem_a', tags: ['x'] })
    await seed('b', { id: 'mem_b' })
    const t = newTable()
    const first = await t.readScope([globalDir()])
    let second!: typeof first
    expect(await contentReads(async () => { second = await t.readScope([globalDir()]) })).toEqual([])
    expect(second).toEqual(first)

    await stats.put('mem_a', { id: 'mem_a', recallCount: 3, lastRecalledAt: 42 })
    const third = await t.readScope([globalDir()])
    expect(third.records.find(l => l.record.id === 'mem_a')!.record).toMatchObject({ recallCount: 3, lastRecalledAt: 42 })
  })

  it('PC-02：改了内容、大小变了，下一次读拿到新内容', async () => {
    const path = await seed('a', { id: 'mem_a', content: 'old' })
    const t = newTable()
    await t.readScope([globalDir()])
    await writeFile(path, encodeRecord(record({ id: 'mem_a', name: 'a', content: 'new and longer' }), {}))
    expect((await t.readScope([globalDir()])).records[0]!.record.content).toBe('new and longer')
  })

  it('PC-03：同大小改写后把 mtime 设回原值，ctime 变了，下一次读拿到新内容', async () => {
    const path = await seed('a', { id: 'mem_a', content: 'aaaa' })
    await utimes(path, OLD_SECONDS, OLD_SECONDS)   // 整秒：设回去之后逐位相同
    const before = await stat(path)
    const t = newTable()
    await t.readScope([globalDir()])
    await writeFile(path, (await readFile(path, 'utf8')).replace('aaaa', 'bbbb'))
    await utimes(path, OLD_SECONDS, OLD_SECONDS)
    const after = await stat(path)
    expect([after.size, after.mtimeMs]).toEqual([before.size, before.mtimeMs])
    expect((await t.readScope([globalDir()])).records[0]!.record.content).toBe('bbbb')
  })

  it('PC-04：写临时文件再 rename 盖过去，同大小、mtime 设回原值，inode 变了，下一次读拿到新内容', async () => {
    const path = await seed('a', { id: 'mem_a', content: 'aaaa' })
    await utimes(path, OLD_SECONDS, OLD_SECONDS)
    const t = newTable()
    await t.readScope([globalDir()])
    const tmp = `${path}.swap`
    await writeFile(tmp, (await readFile(path, 'utf8')).replace('aaaa', 'cccc'))
    await utimes(tmp, OLD_SECONDS, OLD_SECONDS)
    await rename(tmp, path)
    expect((await t.readScope([globalDir()])).records[0]!.record.content).toBe('cccc')
  })

  it('PC-05：改动距读前时刻不到 3 s 的文件不进缓存，时钟前进 3 s 后再读才进', async () => {
    const path = await seed('a', { id: 'mem_a' })
    const s = await stat(path)
    const t = newTable()
    clock = Math.max(s.mtimeMs, s.ctimeMs) + 2_999
    await t.readScope([globalDir()])
    expect(await contentReads(() => t.readScope([globalDir()]))).toEqual([path])
    clock += 1
    await t.readScope([globalDir()])
    expect(await contentReads(() => t.readScope([globalDir()]))).toEqual([])
  })

  it('PC-05：mtime 在读前时刻之后的文件不进缓存', async () => {
    const path = await seed('a', { id: 'mem_a' })
    const future = new Date(Date.now() + 3_600_000)
    await utimes(path, future, future)
    const t = newTable()
    await t.readScope([globalDir()])
    expect(await contentReads(() => t.readScope([globalDir()]))).toEqual([path])
  })

  it('PC-05：粗时间戳下读取中途被同大小改写、签名不变，读取拖到窗口之外才收尾，这次结果也不进缓存', async () => {
    await seed('a', { id: 'mem_a', content: 'aaaa' })
    const T = 1_800_000_000_000
    fsHooks.coarseTime = T   // 改写前后 stat 给出同一个签名（同 inode、同大小、同一格时间戳）
    const t = newTable()
    clock = T + 1_000
    fsHooks.afterRead = async p => {
      fsHooks.afterRead = undefined
      await writeFile(p, (await readFile(p, 'utf8')).replace('aaaa', 'bbbb'))   // 旧内容已读到，收尾之前被改写
      clock = T + 5_000                                                          // 读取拖到 T + 5 s 才收尾
    }
    expect((await t.readScope([globalDir()])).records[0]!.record.content).toBe('aaaa')
    clock = T + 6_000
    expect((await t.readScope([globalDir()])).records[0]!.record.content).toBe('bbbb')
  })

  it('PC-06：.workspace 标记改成另一个项目路径，同一文件按新位置解析', async () => {
    const dir = join(root, workspaceDirName('/p/a'))
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, WORKSPACE_MARKER), '/p/a\n')
    await seed('a', { id: 'mem_a', scope: 'workspace', workspacePath: '/p/a' }, dir)
    const t = newTable()
    expect((await t.readScope([dir])).records[0]!.record.workspacePath).toBe('/p/a')
    await writeFile(join(dir, WORKSPACE_MARKER), '/p/b\n')
    expect((await t.readScope([dir])).records[0]!.record.workspacePath).toBe('/p/b')
  })

  it('PC-09：命中缓存时改返回记录的嵌套字段抛错，改顶层字段不影响缓存', async () => {
    await seed('a', { id: 'mem_a', tags: ['x'] })
    const t = newTable()
    await t.readScope([globalDir()])
    const hit = (await t.readScope([globalDir()])).records[0]!.record
    expect(() => { hit.tags.push('y') }).toThrow(TypeError)
    hit.name = '改了'   // 读出的是浅拷贝
    expect((await t.readScope([globalDir()])).records[0]!.record.name).toBe('a')
  })

  it('扩展字段里有 YAML 自引用的文件照常读出，读第二次也命中', async () => {
    await mkdir(globalDir(), { recursive: true })
    const path = join(globalDir(), 'cyclic.md')
    await writeFile(path, encodeRecord(record({ id: 'mem_c', name: 'cyclic' }), {}).replace('---\n\n', 'custom: &a { self: *a }\n---\n\n'))
    const t = newTable()
    expect((await t.readScope([globalDir()])).records.map(l => l.record.id)).toEqual(['mem_c'])
    expect(await contentReads(() => t.readScope([globalDir()]))).toEqual([])
  })

  it('readdir 已经列不出的文件从缓存里逐出', async () => {
    const path = await seed('a', { id: 'mem_a' })
    await seed('b', { id: 'mem_b' })
    const cache = new ParseCache<never>()
    const t = newTable(cache)
    await t.readScope([globalDir()])
    expect(cache.size).toBe(2)
    await rm(path)
    await t.readScope([globalDir()])
    expect(cache.size).toBe(1)
  })

  it('解析失败的文件也缓存诊断，诊断里的密钥已遮盖', async () => {
    const path = join(globalDir(), 'broken.md')
    await mkdir(globalDir(), { recursive: true })
    await writeFile(path, '---\nid: mem_x\nname: n\ntype: knowledge\ncreatedAt: sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n---\n\nbody\n')
    const t = newTable()
    const first = await t.readScope([globalDir()])
    let second!: typeof first
    expect(await contentReads(async () => { second = await t.readScope([globalDir()]) })).toEqual([])
    expect(second.quarantined).toEqual(first.quarantined)
    expect(second.quarantined).toHaveLength(1)
    expect(second.quarantined[0]!.error).not.toContain('AAAAAAAAAAAAAAAAAAAA')
  })

  it('PC-12：同一组检索查询，开缓存和关缓存结果完全一致（全部命中、部分命中、零命中预筛）', async () => {
    await seed('deploy', { id: 'mem_d', content: 'deploy hook 部署流程', tags: ['ci'] })
    await seed('cache', { id: 'mem_c', content: '缓存失效 deploy' })
    await seed('misc', { id: 'mem_m', content: '无关内容' })
    const registry = buildTypeRegistry({ template: 'coding', customTypes: {} })
    const searcher = (cache: ParseCache<never>) => {
      const store = new MemoryStore(newTable(cache), undefined, new InMemoryBatchKvTable())
      const deps = { store, registry, host: { contextOf: async () => ({ workspacePath: undefined, session: { id: 's', lastSeq: 1 } }) } }
      return (query: string) => executeSearch({ query }, fakeExec(), deps)
    }
    // 开缓存的一侧四条查询共用一个缓存：前一条预筛没过、只存了原文的文件，后一条命中时才补解析
    const cached = searcher(new ParseCache())
    const uncached = searcher(new ParseCache({ maxEntries: 0 }))
    for (const round of [1, 2]) {
      for (const query of ['zzz 查不到', 'deploy rollback', 'deploy 缓存', 'deploy hook']) {
        expect(await cached(query), `第 ${round} 轮：${query}`).toEqual(await uncached(query))
      }
    }
  })
})

const GLOBAL: FileLocation = { scope: 'global' }
const SECRET = `sk-ant-api03-${'S'.repeat(40)}`
const exists = (path: string) => access(path).then(() => true, () => false)
async function signatureOf(path: string) {
  const s = await stat(path)
  return { ino: s.ino, size: s.size, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs }
}

describe('解析缓存：写路径逐出与维护点', () => {
  const searchOf = (t: FileTable) => {
    const store = new MemoryStore(t, undefined, new InMemoryBatchKvTable())
    const registry = buildTypeRegistry({ template: 'coding', customTypes: {} })
    return (query: string) => executeSearch({ query }, fakeExec(), {
      store, registry, host: { contextOf: async () => ({ workspacePath: undefined, session: { id: 's', lastSeq: 1 } }) },
    })
  }

  it('PC-07：彻底删除含密钥的记忆后，readScope 与检索都不交出它的原文，缓存当场逐出', async () => {
    const path = await seed('secret', { id: 'mem_s', content: `token ${SECRET}` })
    await seed('other', { id: 'mem_o', content: 'token 无关' })
    const cache = new ParseCache<never>()
    const t = newTable(cache)
    await t.readScope([globalDir()])
    const sig = await signatureOf(path)
    expect(cache.lookup(path, sig, GLOBAL)).toBeDefined()

    expect(await t.delete('mem_s', { kind: 'global' })).toBe(true)
    expect(cache.lookup(path, sig, GLOBAL)).toBeUndefined()
    expect(JSON.stringify(await t.readScope([globalDir()]))).not.toContain(SECRET)
    expect(JSON.stringify(await searchOf(t)('token'))).not.toContain(SECRET)
  })

  it('PC-07：读取进行到一半时被彻底删除、旧条目被回填，之后的读取也不交出它；下一次读这个目录后缓存里没有它', async () => {
    const path = await seed('secret', { id: 'mem_s', content: `token ${SECRET}` })
    await seed('other', { id: 'mem_o', content: 'token 无关' })
    const sig = await signatureOf(path)
    const cache = new ParseCache<never>()
    const t = newTable(cache)
    fsHooks.afterRead = async p => {
      if (p !== path) return
      fsHooks.afterRead = undefined
      await t.delete('mem_s', { kind: 'global' })   // 内容已读到，删除在它存进缓存之前发生
    }
    await t.readScope([globalDir()])
    expect(await exists(path)).toBe(false)
    expect(cache.lookup(path, sig, GLOBAL)).toBeDefined()   // 回填：只在内存里，交不出去

    expect(JSON.stringify(await t.readScope([globalDir()]))).not.toContain(SECRET)
    expect(cache.lookup(path, sig, GLOBAL)).toBeUndefined()
    expect(JSON.stringify(await searchOf(t)('token'))).not.toContain(SECRET)
  })

  it('PC-07：软删搬进 .archive/ 后，原路径的条目没了', async () => {
    const path = await seed('a', { id: 'mem_a' })
    const cache = new ParseCache<never>()
    const t = newTable(cache)
    await t.readScope([globalDir()])
    const sig = await signatureOf(path)
    await t.update('mem_a', { kind: 'global' }, r => ({ ...r, status: 'deleted' }))
    expect(await exists(path)).toBe(false)
    expect(cache.lookup(path, sig, GLOBAL)).toBeUndefined()
  })

  /** 往缓存里塞一份和磁盘对不上、签名却相同的条目：模拟缓存陈旧。 */
  async function plantStale(cache: ParseCache<never>, path: string, stale: MemoryRecord, raw = encodeRecord(stale, {})) {
    const decoded = decodeFile(raw, { path, loc: GLOBAL, relPath: path.slice(root.length + 1) })
    cache.store(path, await signatureOf(path), GLOBAL, Number.MAX_SAFE_INTEGER, { raw, decoded } as never)
  }

  it('PC-08：缓存说顶层这条已删、磁盘上仍在用：不搬 .archive/，路径逐出，下一次维护照常', async () => {
    const path = await seed('a', { id: 'mem_a', name: 'a' })
    const cache = new ParseCache<never>()
    const t = newTable(cache)
    await plantStale(cache, path, record({ id: 'mem_a', name: 'a', status: 'deleted', deletedAt: clock }))
    await t.maintain([globalDir()])
    expect(await exists(path)).toBe(true)
    expect(await exists(join(globalDir(), ARCHIVE_DIR, 'a.md'))).toBe(false)
    await t.maintain([globalDir()])
    expect(await indexedIds(globalDir())).toEqual(['mem_a'])
  })

  it('PC-08：缓存原文需要重新编码、磁盘上其实不同：不回写', async () => {
    const path = await seed('a', { id: 'mem_a', name: 'a' })
    const before = await readFile(path, 'utf8')
    const cache = new ParseCache<never>()
    const t = newTable(cache)
    const stale = record({ id: 'mem_a', name: 'a', content: '陈旧的正文' })
    await plantStale(cache, path, stale, encodeRecord(stale, {}).replace(/^digest:.*\n/m, ''))   // 缺 digest：维护点会想补上
    await t.maintain([globalDir()])
    expect(await readFile(path, 'utf8')).toBe(before)
    expect(cache.lookup(path, await signatureOf(path), GLOBAL)).toBeUndefined()
  })

  it('PC-08：缓存说 .archive/ 里这条已超保留期、磁盘上刚删不久：不物理删除', async () => {
    const archive = join(globalDir(), ARCHIVE_DIR)
    const path = await seed('a', { id: 'mem_a', name: 'a', status: 'deleted', deletedAt: clock }, archive)
    const cache = new ParseCache<never>()
    const t = newTable(cache)
    await plantStale(cache, path, record({ id: 'mem_a', name: 'a', status: 'deleted', deletedAt: 1 }))
    await t.maintain([globalDir()])
    expect(await exists(path)).toBe(true)
    expect(cache.lookup(path, await signatureOf(path), GLOBAL)).toBeUndefined()
  })

  it('PC-08：racy 窗口内被同大小改写的在用记录，维护点写出的主题索引反映新内容', async () => {
    const path = await seed('a', { id: 'mem_a', name: 'aaaa', summary: '旧摘要xx' })
    const T = 1_800_000_000_000
    fsHooks.coarseTime = T   // 改写前后签名相同
    const t = newTable()
    clock = T + 1_000
    await t.maintain([globalDir()])
    expect(await indexText(globalDir())).toContain('旧摘要xx')
    await writeFile(path, (await readFile(path, 'utf8')).replace('旧摘要xx', '新摘要yy'))
    clock = T + 6_000
    await t.maintain([globalDir()])
    const index = await indexText(globalDir())
    expect(index).toContain('新摘要yy')
    expect(index).not.toContain('旧摘要xx')
  })
})
