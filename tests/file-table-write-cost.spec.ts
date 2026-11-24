import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rename, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { FileTable, type FileTableOptions } from '../src/storage/file-table.ts'
import { DerivedIndex } from '../src/storage/derived-index.ts'
import { encodeRecord } from '../src/storage/frontmatter.ts'
import { ARCHIVE_DIR, GLOBAL_DIR, INDEX_FILE, WORKSPACE_MARKER, workspaceDirName } from '../src/storage/paths.ts'
import type { RecallStats } from '../src/storage/schema.ts'
import type { MemoryRecord } from '../src/record-schema.ts'
import { record as baseRecord } from './helpers/record.ts'
import { InMemoryKvTable } from './helpers/in-memory-kv.ts'
import { writesDuring } from './helpers/fs-writes.ts'
import { indexText, indexTree, indexedIds, indexedIdsMatchDisk, isIndexPath, projectedCount } from './helpers/topic-index.ts'
import { INDEX_DIR, INDEX_TOPICS_DIR } from '../src/storage/index-store.ts'
import { UNSORTED_PAGE } from '../src/topic-index.ts'

// 写入路径的开销：写完不做整目录维护，也不碰主题索引和 MEMORY.md（留到维护点）；按 id 找文件先看派生库的提示。
// 真文件系统、真 node:sqlite。reads：tracing 期间记下 readFile 读过的路径（看定位读了哪些文件的内容）。
const { reads, hooks } = vi.hoisted(() => ({
  reads: { tracing: false, paths: [] as string[], listed: [] as string[] },
  // afterRename：插件把一个文件改名落盘之后、接着往下做之前插进来的「别人的改动」（只触发一次）
  hooks: { afterRename: undefined as undefined | ((to: string) => Promise<void>) },
}))
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const readFile = vi.fn(async (...args: Parameters<typeof actual.readFile>) => {
    if (reads.tracing) reads.paths.push(String(args[0]))
    return actual.readFile(...args)
  })
  const readdir = vi.fn(async (...args: Parameters<typeof actual.readdir>) => {
    if (reads.tracing) reads.listed.push(String(args[0]))
    return (actual.readdir as (...a: unknown[]) => Promise<unknown>)(...args)
  })
  const rename = vi.fn(async (...args: Parameters<typeof actual.rename>) => {
    await actual.rename(...args)
    const hook = hooks.afterRename
    if (hook !== undefined && !String(args[1]).endsWith('.sqlite')) {
      hooks.afterRename = undefined
      await hook(String(args[1]))
    }
  })
  return (await import('./helpers/fs-writes.ts')).recordWrites({ ...actual, readFile, readdir, rename })
})

const NOW = 1_800_000_000_000
const record = (partial: Partial<MemoryRecord> = {}) => baseRecord({ createdAt: NOW, updatedAt: NOW, lastConfirmedAt: NOW, ...partial })

let root: string
let stateDir: string
let indexes: DerivedIndex[] = []
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pm-write-cost-'))
  stateDir = await mkdtemp(join(tmpdir(), 'pm-write-cost-state-'))
})
afterEach(async () => {
  reads.tracing = false
  reads.paths = []
  reads.listed = []
  hooks.afterRename = undefined
  for (const index of indexes.splice(0)) index.close()
  await rm(root, { recursive: true, force: true })
  await rm(stateDir, { recursive: true, force: true })
})

const quietLog = { info: () => {}, warn: () => {}, error: () => {} }
const indexPath = () => join(stateDir, 'derived-index.sqlite')
const globalDir = () => join(root, GLOBAL_DIR)
const WS = '/tmp/proj-cost'
const wsDir = () => join(root, workspaceDirName(WS))

function newIndex(loadSqlite?: () => undefined) {
  const index = new DerivedIndex({ path: indexPath(), log: quietLog, ...(loadSqlite !== undefined ? { loadSqlite } : {}) })
  indexes.push(index)
  return index
}
/** 带派生库的文件表。hintRacyMs 取负数：测试里刚建的目录也直接用提示（正式环境要等过时间戳粒度）。 */
function withIndex(extra: Partial<FileTableOptions> = {}) {
  return new FileTable({ root, stats: new InMemoryKvTable<RecallStats>(), now: () => NOW, log: quietLog, index: newIndex(), hintRacyMs: -60_000, ...extra })
}
function withoutIndex() {
  return new FileTable({ root, stats: new InMemoryKvTable<RecallStats>(), now: () => NOW, log: quietLog })
}

async function seed(dir: string, name: string, r: MemoryRecord | string) {
  await mkdir(dir, { recursive: true })
  if (dir !== globalDir() && !dir.endsWith(ARCHIVE_DIR)) await writeFile(join(dir, WORKSPACE_MARKER), WS + '\n')
  await writeFile(join(dir, name), typeof r === 'string' ? r : encodeRecord(r, {}))
}
/** 读 fn 期间读过内容的记忆文件名（不含索引和标记）。 */
async function contentReads(fn: () => Promise<unknown>): Promise<string[]> {
  reads.paths = []
  reads.listed = []
  reads.tracing = true
  try { await fn() } finally { reads.tracing = false }
  return reads.paths.filter(p => p.endsWith('.md') && !p.endsWith(INDEX_FILE)).map(p => p.slice(root.length + 1)).sort()
}

const callPath = (call: string) => call.replace(/^\w+\(/, '').replace(/\)$/, '')

describe('写入只处理自己动到的文件', () => {
  it('写一条记忆不碰同目录的别的文件：手改过的不回写、不在用的不搬进归档、过期的不清，都留到维护点', async () => {
    await seed(globalDir(), 'a.md', record({ id: 'mem_a', name: '甲' }))
    await seed(globalDir(), 'b.md', record({ id: 'mem_b', name: '乙' }))
    const t = withIndex()
    await t.maintain([globalDir()])
    // 手改正文（摘要对不上）、顶层放一条已删除的、归档里放一条过了保留期的
    const handEdited = (await readFile(join(globalDir(), 'b.md'), 'utf8')).replace('内容', '手改的内容')
    await writeFile(join(globalDir(), 'b.md'), handEdited)
    await seed(globalDir(), 'gone.md', record({ id: 'mem_gone', name: '丙', status: 'deleted', deletedAt: NOW - 1000 }))
    await seed(join(globalDir(), ARCHIVE_DIR), 'old.md', record({ id: 'mem_old', name: '丁', status: 'deleted', deletedAt: NOW - 400 * 86_400_000 }))

    const writes = await writesDuring(() => t.update('mem_a', {}, r => ({ ...r, content: '新内容', updatedAt: NOW })))
    const touched = new Set(writes.map(w => w.replace(/^\w+\(/, '').replace(/\)$/, '').replace(/\.tmp-\d+-[a-z0-9]+$/, '').slice(globalDir().length + 1)))
    expect([...touched]).toEqual(['a.md'])   // 名字和摘要没变，索引里它的行也不用动
    expect(await readFile(join(globalDir(), 'b.md'), 'utf8')).toBe(handEdited)
    expect(existsSync(join(globalDir(), 'gone.md'))).toBe(true)
    expect(existsSync(join(globalDir(), ARCHIVE_DIR, 'old.md'))).toBe(true)

    await t.maintain([globalDir()])
    expect(await readFile(join(globalDir(), 'b.md'), 'utf8')).not.toBe(handEdited)   // 回写了时间
    expect(existsSync(join(globalDir(), 'gone.md'))).toBe(false)
    expect(existsSync(join(globalDir(), ARCHIVE_DIR, 'gone.md'))).toBe(true)
    expect(existsSync(join(globalDir(), ARCHIVE_DIR, 'old.md'))).toBe(false)
  })

  it('同一个目录里的写入不读不写主题索引和 MEMORY.md，换作用域只动来源目录的索引把那一行去掉；之后维护一次索引就跟上磁盘', async () => {
    for (const [name, id] of [['部署流程', 'mem_1'], ['包管理', 'mem_2'], ['测试约定', 'mem_3']] as const) {
      await seed(globalDir(), `${name}.md`, record({ id, name }))
    }
    await seed(wsDir(), '项目备注.md', record({ id: 'mem_w', name: '项目备注', scope: 'workspace', workspacePath: WS }))
    const t = withIndex()
    const dirs = [globalDir(), wsDir()]
    await t.maintain(dirs)
    const steps: Array<[string, () => Promise<unknown>, movedFrom?: { dir: string; id: string }]> = [
      ['新建', () => t.create(record({ id: 'mem_4', name: '代码风格', summary: '缩进与命名' }))],
      ['新建排在最前', () => t.create(record({ id: 'mem_5', name: 'API 约定' }))],
      ['改名', () => t.update('mem_2', {}, r => ({ ...r, name: '依赖管理', updatedAt: NOW }))],
      ['改摘要', () => t.update('mem_3', {}, r => ({ ...r, summary: '新的摘要', updatedAt: NOW }))],
      ['遗忘', () => t.update('mem_1', {}, r => ({ ...r, status: 'deleted', deletedAt: NOW }))],
      ['恢复', () => t.update('mem_1', {}, ({ deletedAt: _, ...r }) => ({ ...r, status: 'active' }))],
      ['过期', () => t.update('mem_4', {}, r => ({ ...r, validTo: NOW - 1 }))],
      ['全局搬到项目', () => t.update('mem_3', {}, r => ({ ...r, scope: 'workspace', workspacePath: WS, updatedAt: NOW })), { dir: globalDir(), id: 'mem_3' }],
      ['项目搬到全局', () => t.update('mem_w', { workspacePath: WS }, ({ workspacePath: _, ...r }) => ({ ...r, scope: 'global', updatedAt: NOW })), { dir: wsDir(), id: 'mem_w' }],
    ]
    for (const [what, step, movedFrom] of steps) {
      reads.paths = []
      reads.tracing = true
      let writes: string[]
      try { writes = await writesDuring(step) } finally { reads.tracing = false }
      // 搬走的那条当场从来源目录的索引里去掉；目的目录的索引和两边的 MEMORY.md 不碰
      const inSource = (path: string) => movedFrom !== undefined && path.startsWith(join(movedFrom.dir, INDEX_DIR))
      expect(writes.map(callPath).filter(p => isIndexPath(p) && !inSource(p)), `${what}：写调用`).toEqual([])
      expect(reads.paths.filter(p => isIndexPath(p) && !inSource(p)), `${what}：读调用`).toEqual([])
      if (movedFrom !== undefined) expect(await indexedIds(movedFrom.dir), `${what}：来源目录的索引`).not.toContain(movedFrom.id)
      await t.maintain(dirs)
      for (const dir of dirs) await indexedIdsMatchDisk(t, dir).catch(err => { throw new Error(`${what}：${String(err)}`) })
    }
    expect(await indexedIds(globalDir())).toContain('mem_w')
    expect(await indexedIds(globalDir())).toContain('mem_4')   // 过期的照样有一行
    expect(await indexedIds(wsDir())).toEqual(['mem_3'])
    expect(await projectedCount(globalDir())).toBe(5)
  })

  it('彻底删除后索引里当场没有它的名字和摘要', async () => {
    await seed(globalDir(), 'a.md', record({ id: 'mem_a', name: '甲' }))
    await seed(globalDir(), 's.md', record({ id: 'mem_s', name: '机密的名字', summary: '机密的摘要' }))
    const t = withIndex()
    await t.maintain([globalDir()])
    expect(await indexText(globalDir())).toContain('机密的名字')
    await t.delete('mem_s', {})
    expect(await indexText(globalDir())).not.toContain('机密')
    expect(await indexedIds(globalDir())).toEqual(['mem_a'])
  })

  it('目录里还没有索引：写入不建索引，维护时整份生成，手建的文件也列进去', async () => {
    await seed(globalDir(), 'hand.md', record({ id: 'mem_hand', name: '手建的' }))
    const t = withIndex()
    await t.create(record({ id: 'mem_new', name: '新写的' }))
    expect(await indexTree(globalDir())).toBeUndefined()
    expect(existsSync(join(globalDir(), INDEX_FILE))).toBe(false)
    await t.maintain([globalDir()])
    expect((await indexedIds(globalDir())).sort()).toEqual(['mem_hand', 'mem_new'])
    expect(await projectedCount(globalDir())).toBe(2)
  })
})

describe('按 id 找文件先看派生库的提示', () => {
  async function seedMany(n: number) {
    for (let i = 0; i < n; i++) await seed(globalDir(), `m${i}.md`, record({ id: `mem_${i}`, name: `条目${i}` }))
  }

  it('扫过一遍之后，再找只读命中的那一个文件；没有库时每次都逐个读', async () => {
    await seedMany(6)
    const t = withIndex()
    expect(await contentReads(() => t.locate('mem_3', {}))).toHaveLength(7)   // 第一次：逐个读一遍记提示，命中的再读一次解析
    expect(await contentReads(() => t.locate('mem_3', {}))).toEqual([`${GLOBAL_DIR}/m3.md`])
    expect(await contentReads(() => t.locate('mem_5', {}))).toEqual([`${GLOBAL_DIR}/m5.md`])
    expect((await contentReads(() => withoutIndex().locate('mem_3', {}))).length).toBeGreaterThanOrEqual(6)
  })

  it('目录没变时找一条记忆不列目录；自己刚写过之后再找也不用列', async () => {
    await seedMany(6)
    const t = withIndex()
    await t.maintain([globalDir()])
    await t.locate('mem_0', {})
    await contentReads(() => t.locate('mem_3', {}))
    expect(reads.listed.filter(d => d === globalDir())).toEqual([])
    await t.update('mem_1', {}, r => ({ ...r, name: '改了名', updatedAt: NOW }))
    await t.create(record({ id: 'mem_new', name: '新建的' }))
    await contentReads(() => t.locate('mem_4', {}))
    expect(reads.listed.filter(d => d === globalDir())).toEqual([])
  })

  it('提示是另一个进程记下的也能用', async () => {
    await seedMany(4)
    await withIndex().locate('mem_1', {})
    expect(await contentReads(() => withIndex().locate('mem_2', {}))).toEqual([`${GLOBAL_DIR}/m2.md`])
  })

  it('改一条记忆之后再找别的：只列一次目录，不重读没动过的文件', async () => {
    await seedMany(6)
    const t = withIndex()
    await t.maintain([globalDir()])
    await t.update('mem_1', {}, r => ({ ...r, content: '改过', updatedAt: NOW }))
    expect(await contentReads(() => t.locate('mem_4', {}))).toEqual([`${GLOBAL_DIR}/m4.md`])
  })

  it('手工新建、从别的机器同步来的文件，下一次查找就能找到', async () => {
    await seedMany(3)
    const t = withIndex()
    await t.locate('mem_0', {})
    await seed(globalDir(), 'synced.md', record({ id: 'mem_synced', name: '同步来的', content: '别的机器写的' }))
    expect((await t.locate('mem_synced', {}))?.record.content).toBe('别的机器写的')
    // 新文件只读它自己（记提示一次、解析一次）
    await seed(globalDir(), 'hand.md', record({ id: 'mem_hand', name: '手建的' }))
    expect(await contentReads(() => t.locate('mem_hand', {}))).toEqual([`${GLOBAL_DIR}/hand.md`, `${GLOBAL_DIR}/hand.md`])
  })

  it('文件在外面被改名：按新名字找到；被删掉：找不到', async () => {
    await seedMany(3)
    const t = withIndex()
    await t.locate('mem_0', {})
    await rename(join(globalDir(), 'm1.md'), join(globalDir(), '改了名.md'))
    expect((await t.locate('mem_1', {}))?.filePath).toBe(join(globalDir(), '改了名.md'))
    await rm(join(globalDir(), 'm2.md'))
    expect(await t.locate('mem_2', {})).toBeUndefined()
  })

  it('文件名没变、里面的 id 被原地改掉：旧 id 找不到了，新 id 找得到', async () => {
    await seedMany(3)
    const t = withIndex()
    await t.locate('mem_0', {})
    const path = join(globalDir(), 'm1.md')
    await writeFile(path, (await readFile(path, 'utf8')).replace('mem_1', 'mem_changed'))
    expect(await t.locate('mem_1', {})).toBeUndefined()
    expect((await t.locate('mem_changed', {}))?.filePath).toBe(path)
  })

  it('名字没变、内容被换成另一条记忆（网盘把同名文件换掉）：两个 id 都按文件里的为准', async () => {
    await seedMany(3)
    const t = withIndex()
    await t.locate('mem_0', {})
    const tmp = join(globalDir(), 'incoming.tmp')
    await writeFile(tmp, encodeRecord(record({ id: 'mem_other', name: '别的记忆' }), {}))
    await rename(tmp, join(globalDir(), 'm2.md'))
    expect((await t.locate('mem_other', {}))?.record.name).toBe('别的记忆')
    expect(await t.locate('mem_2', {})).toBeUndefined()
  })

  it('同一个 id 有两份副本时取哪一份，有库没库一样', async () => {
    await seed(globalDir(), 'dup.md', record({ id: 'mem_dup', name: '全局那份', updatedAt: NOW - 5 }))
    await seed(wsDir(), 'dup.md', record({ id: 'mem_dup', name: '项目那份', scope: 'workspace', workspacePath: WS, updatedAt: NOW }))
    await seed(join(globalDir(), ARCHIVE_DIR), 'dup-old.md', record({ id: 'mem_dup', name: '归档那份', status: 'deleted', deletedAt: NOW }))
    const targets = [{}, { workspacePath: WS }, { kind: 'global' as const }, { kind: 'workspace' as const, workspacePath: WS }]
    const plain = withoutIndex()
    const indexed = withIndex()
    for (const round of [1, 2]) {
      for (const target of targets) {
        const want = await plain.locate('mem_dup', target)
        const got = await indexed.locate('mem_dup', target)
        expect(got?.filePath, `第 ${round} 轮 ${JSON.stringify(target)}`).toBe(want?.filePath)
        expect(got?.record).toEqual(want?.record)
      }
    }
    expect((await indexed.copiesOf('mem_dup'))).toEqual(await plain.copiesOf('mem_dup'))
  })

  it('写入时照常清掉可见范围里同 id 的其余副本', async () => {
    await seed(globalDir(), 'dup.md', record({ id: 'mem_dup', name: '全局那份' }))
    await seed(wsDir(), 'dup.md', record({ id: 'mem_dup', name: '项目那份', scope: 'workspace', workspacePath: WS, updatedAt: NOW + 5 }))
    const t = withIndex()
    await t.locate('mem_dup', { workspacePath: WS })
    await t.update('mem_dup', { workspacePath: WS }, r => ({ ...r, content: '改过', updatedAt: NOW + 9 }))
    expect(existsSync(join(globalDir(), 'dup.md'))).toBe(false)
    expect(await readFile(join(wsDir(), 'dup.md'), 'utf8')).toContain('改过')
  })

  it('删掉派生库：结果和有库时一样，库重新建起来', async () => {
    await seedMany(4)
    const t = withIndex()
    await t.update('mem_1', {}, r => ({ ...r, content: '第一次改', updatedAt: NOW }))
    for (const index of indexes) index.close()
    for (const suffix of ['', '-wal', '-shm']) await rm(indexPath() + suffix, { force: true })
    expect((await t.locate('mem_1', {}))?.record.content).toBe('第一次改')
    await t.update('mem_2', {}, r => ({ ...r, content: '第二次改', updatedAt: NOW }))
    expect((await t.locate('mem_2', {}))?.record.content).toBe('第二次改')
    expect(await t.locate('mem_none', {})).toBeUndefined()
    expect(existsSync(indexPath())).toBe(true)
    expect(await contentReads(() => t.locate('mem_3', {}))).toEqual([`${GLOBAL_DIR}/m3.md`])
  })

  it('node:sqlite 加载不到：照常找、照常写', async () => {
    await seedMany(3)
    const t = new FileTable({ root, stats: new InMemoryKvTable<RecallStats>(), now: () => NOW, log: quietLog, index: newIndex(() => undefined) })
    await t.update('mem_1', {}, r => ({ ...r, content: '改过', updatedAt: NOW }))
    expect((await t.locate('mem_1', {}))?.record.content).toBe('改过')
    expect(await t.locate('mem_none', {})).toBeUndefined()
  })

  it('目录的修改时间还在时间戳粒度之内：不直接用提示，列一次目录核对', async () => {
    await seedMany(3)
    const t = withIndex({ hintRacyMs: 3_600_000 })
    await t.locate('mem_0', {})
    await seed(globalDir(), 'late.md', record({ id: 'mem_late', name: '刚写的' }))
    expect((await t.locate('mem_late', {}))?.record.name).toBe('刚写的')
    expect(await contentReads(() => t.locate('mem_1', {}))).toEqual([`${GLOBAL_DIR}/m1.md`])
  })

  it('维护点读完目录顺手重记提示：之后找文件不用再逐个读', async () => {
    await seedMany(5)
    const t = withIndex()
    await t.maintain([globalDir()])
    expect(await contentReads(() => t.locate('mem_2', {}))).toEqual([`${GLOBAL_DIR}/m2.md`])
  })
})

describe('有库没库结果一样：别人改了目录之后', () => {
  /** 全局一份旧的 mem_dup，另有一条不相干的记忆；两张表各自查过一遍。 */
  async function warmed() {
    await seed(globalDir(), 'dup.md', record({ id: 'mem_dup', name: '旧的那份', content: 'v10', updatedAt: NOW }))
    await seed(globalDir(), 'other.md', record({ id: 'mem_other', name: '不相干的' }))
    const indexed = withIndex()
    await indexed.locate('mem_dup', {})
    await indexed.locate('mem_other', {})
    return { indexed, plain: withoutIndex() }
  }
  const newer = () => encodeRecord(record({ id: 'mem_dup', name: '新的那份', content: 'v20', updatedAt: NOW + 20 }), {})
  async function sameAsPlain(indexed: FileTable, plain: FileTable) {
    const want = await plain.locate('mem_dup', {})
    const got = await indexed.locate('mem_dup', {})
    expect(got?.filePath).toBe(want?.filePath)
    expect(got?.record.content).toBe(want?.record.content)
    expect(await indexed.copiesOf('mem_dup')).toEqual(await plain.copiesOf('mem_dup'))
    return got
  }

  it('同名文件被换成这个 id 更新的一份（网盘同步）：找到的是新的那份', async () => {
    const { indexed, plain } = await warmed()
    const tmp = join(globalDir(), 'incoming.tmp')
    await writeFile(tmp, newer())
    await rename(tmp, join(globalDir(), 'other.md'))
    expect((await sameAsPlain(indexed, plain))?.record.content).toBe('v20')
  })

  it('同名文件被原地改写成这个 id 更新的一份（大小变了）：目录有别的变化时一并发现', async () => {
    const { indexed, plain } = await warmed()
    await writeFile(join(globalDir(), 'other.md'), newer())
    await seed(globalDir(), 'unrelated.md', record({ id: 'mem_unrelated', name: '又一条' }))
    expect((await sameAsPlain(indexed, plain))?.record.content).toBe('v20')
  })

  it('整个目录被换成一组同名文件：按新目录里的为准', async () => {
    const { indexed, plain } = await warmed()
    const fresh = join(root, 'incoming-global')
    await mkdir(fresh)
    await writeFile(join(fresh, 'dup.md'), encodeRecord(record({ id: 'mem_other', name: '不相干的' }), {}))
    await writeFile(join(fresh, 'other.md'), newer())
    await rename(globalDir(), join(root, 'old-global'))
    await rename(fresh, globalDir())
    expect((await sameAsPlain(indexed, plain))?.record.content).toBe('v20')
    expect((await indexed.locate('mem_other', {}))?.filePath).toBe(join(globalDir(), 'dup.md'))
  })

  it('这边写一条不相干的记忆的当口，别人放进来这个 id 更新的一份：不会被这次写入记成「目录没变」', async () => {
    const { indexed, plain } = await warmed()
    hooks.afterRename = async () => { await writeFile(join(globalDir(), 'cloud-copy.md'), newer()) }
    await indexed.update('mem_other', {}, r => ({ ...r, content: '改一下', updatedAt: NOW }))
    expect(existsSync(join(globalDir(), 'cloud-copy.md'))).toBe(true)
    expect((await sameAsPlain(indexed, plain))?.record.content).toBe('v20')
  })

  it('写这个 id 时，换了名字出现的另一份照常被清掉', async () => {
    const { indexed } = await warmed()
    const tmp = join(globalDir(), 'incoming.tmp')
    await writeFile(tmp, newer())
    await rename(tmp, join(globalDir(), 'other.md'))
    await indexed.update('mem_dup', {}, r => ({ ...r, content: 'v30', updatedAt: NOW + 30 }))
    const left = await withoutIndex().readScope([globalDir()], { includeArchive: true })
    expect(left.records.filter(l => l.record.id === 'mem_dup').map(l => l.record.content)).toEqual(['v30'])
  })

  it('彻底删除不看提示：原地改出来的同 id 副本（目录修改时间没变）也一并删掉', async () => {
    const { indexed } = await warmed()
    const path = join(globalDir(), 'other.md')
    await writeFile(path, (await readFile(path, 'utf8')).replace('mem_other', 'mem_dup'))
    expect(await indexed.delete('mem_dup', {})).toBe(true)
    const left = await withoutIndex().readScope([globalDir()], { includeArchive: true })
    expect(left.records.map(l => l.record.id)).toEqual([])
  })

  it('id 带空格的记忆：冷库、热库、没有库都找得到', async () => {
    await seed(globalDir(), 'spaced.md', record({ id: 'my memory', name: '带空格的 id' }))
    const indexed = withIndex()
    expect((await indexed.locate('my memory', {}))?.record.id).toBe('my memory')
    expect((await indexed.locate('my memory', {}))?.record.id).toBe('my memory')
    expect((await withoutIndex().locate('my memory', {}))?.record.id).toBe('my memory')
    await indexed.update('my memory', {}, r => ({ ...r, content: '改过', updatedAt: NOW }))
    expect((await indexed.locate('my memory', {}))?.record.content).toBe('改过')
  })

  it('默认的时间刻度设置下，连着写、连着找，结果都对', async () => {
    for (let i = 0; i < 4; i++) await seed(globalDir(), `m${i}.md`, record({ id: `mem_${i}`, name: `条目${i}` }))
    const t = new FileTable({ root, stats: new InMemoryKvTable<RecallStats>(), now: () => NOW, log: quietLog, index: newIndex() })
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 4; i++) {
        await t.update(`mem_${i}`, {}, r => ({ ...r, content: `第 ${round} 轮`, updatedAt: NOW }))
        expect((await t.locate(`mem_${(i + 1) % 4}`, {}))?.record.id).toBe(`mem_${(i + 1) % 4}`)
      }
      await t.create(record({ id: `mem_new_${round}`, name: `新建 ${round}` }))
      expect((await t.locate(`mem_new_${round}`, {}))?.record.name).toBe(`新建 ${round}`)
    }
    expect((await t.locate('mem_2', {}))?.record.content).toBe('第 2 轮')
  })
})

describe('索引里的文字跟着记忆走，彻底删除后不留', () => {
  it('摘要带换行的记忆：索引里压成一行；改摘要、彻底删除之后旧文字一点不剩', async () => {
    await seed(globalDir(), 'a.md', record({ id: 'mem_a', name: '甲' }))
    const t = withIndex()
    await t.maintain([globalDir()])
    await t.create(record({ id: 'mem_multi', name: '多行的', summary: '第一行\n机密的第二行' }))
    await t.maintain([globalDir()])
    expect(await indexText(globalDir())).toContain('第一行 机密的第二行')
    await t.update('mem_multi', {}, r => ({ ...r, summary: '改过的第一行\n改过的第二行', updatedAt: NOW }))
    await t.maintain([globalDir()])
    expect(await indexText(globalDir())).not.toContain('机密的第二行')
    await t.delete('mem_multi', {})
    expect(await indexText(globalDir())).not.toContain('改过的')
    expect(await indexedIds(globalDir())).toEqual(['mem_a'])
  })

  it('摘要的第二行长得像另一条记忆的成员行：不被认成别的记忆，彻底删除后这段文字也不剩', async () => {
    await seed(globalDir(), 'a.md', record({ id: 'mem_a', name: '甲' }))
    const t = withIndex()
    await t.maintain([globalDir()])
    await t.create(record({ id: 'mem_multi', name: '多行的', summary: '第一行\n- [别的](../../x.md "mem_fake") — 机密的尾巴' }))
    await t.maintain([globalDir()])
    expect(await indexText(globalDir())).toContain('机密的尾巴')
    expect((await indexedIds(globalDir())).sort()).toEqual(['mem_a', 'mem_multi'])
    await t.delete('mem_multi', {})
    expect(await indexText(globalDir())).not.toContain('机密的尾巴')
    expect(await indexedIds(globalDir())).toEqual(['mem_a'])
  })

  it('彻底删除的当口另一边正在整层扫描：删掉的文件名不会被写回派生库', async () => {
    await seed(globalDir(), 'a.md', record({ id: 'mem_a', name: '甲' }))
    const t = withIndex()
    await t.create(record({ id: 'mem_s', name: '口令 hunter2-prod' }))
    const file = (await t.locate('mem_s', {}))!.filePath
    // 另一个进程：删之前读到「这一层还没有记录」或旧版本号，删完才提交它那份带着旧文件名的扫描
    const other = newIndex()
    const revBefore = other.levelScan(globalDir())?.rev
    await t.delete('mem_s', {})
    expect(other.replaceLevel(globalDir(), { mtimeMs: 1, ino: 1, scannedAt: 1, listing: '' }, [[basename(file), 'mem_s', 'sig']], revBefore)).toBe(false)
    expect(other.hasName(globalDir(), basename(file))).toBe(false)
  })

  it('索引里留着磁盘上已经没有的记忆（别的进程拿旧索引写回来）：维护后这一行连同名字摘要一起去掉', async () => {
    await seed(globalDir(), 'a.md', record({ id: 'mem_a', name: '甲' }))
    const t = withIndex()
    await t.maintain([globalDir()])
    const unsorted = join(globalDir(), INDEX_DIR, INDEX_TOPICS_DIR, UNSORTED_PAGE)
    await writeFile(unsorted, (await readFile(unsorted, 'utf8')) + '- [删掉的](../../old.md "mem_secret") — 机密的摘要\n')
    await t.create(record({ id: 'mem_b', name: '乙' }))
    await t.maintain([globalDir()])
    expect(await indexText(globalDir())).not.toContain('mem_secret')
    expect(await indexText(globalDir())).not.toContain('机密的摘要')
    expect((await indexedIds(globalDir())).sort()).toEqual(['mem_a', 'mem_b'])
  })

  it('彻底删除后派生库里也不留这个文件名', async () => {
    await seed(globalDir(), 'a.md', record({ id: 'mem_a', name: '甲' }))
    const t = withIndex()
    await t.create(record({ id: 'mem_s', name: '口令 hunter2-prod' }))
    await t.locate('mem_s', {})
    await t.delete('mem_s', {})
    await t.locate('mem_a', {})
    for (const index of indexes) index.close()
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      const bytes = await readFile(indexPath() + suffix).catch(() => Buffer.alloc(0))
      expect(bytes.includes('hunter2'), `derived-index.sqlite${suffix}`).toBe(false)
    }
  })
})

describe('写入读的文件数不随目录大小增长', () => {
  async function filesReadPerWrite(n: number): Promise<string[]> {
    const ws = `/tmp/proj-size-${n}`
    const dir = join(root, workspaceDirName(ws))
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, WORKSPACE_MARKER), ws + '\n')
    const lines: string[] = []
    for (let i = 0; i < n; i++) {
      const r = record({ id: `mem_${n}_${i}`, name: `条目 ${String(i).padStart(5, '0')}`, scope: 'workspace', workspacePath: ws })
      await writeFile(join(dir, `m${i}.md`), encodeRecord(r, {}))
      lines.push(`- [${r.id}] ${r.name}（${r.summary}） · m${i}.md`)
    }
    await writeFile(join(dir, INDEX_FILE), `# Memory Index\n\n${lines.join('\n')}\n`)
    const t = new FileTable({ root, stats: new InMemoryKvTable<RecallStats>(), now: () => NOW, log: quietLog, index: newIndex() })
    const target = { workspacePath: ws }
    await t.update(`mem_${n}_0`, target, r => ({ ...r, content: '预热', updatedAt: NOW }))   // 第一次：逐个读一遍记提示
    const read = await contentReads(async () => {
      await t.update(`mem_${n}_1`, target, r => ({ ...r, content: '改一次', updatedAt: NOW }))
      await t.create(record({ id: `mem_${n}_new`, name: '新条目', scope: 'workspace', workspacePath: ws }))
    })
    expect((await readdir(dir)).filter(f => f.endsWith('.md')).length).toBe(n + 1 + 1)
    return read.map(p => p.slice(p.indexOf('/') + 1))
  }

  it('300 条的目录里改一条加建一条，读的记忆文件和 30 条的目录一样，只有自己动到的', async () => {
    const small = await filesReadPerWrite(30)
    const large = await filesReadPerWrite(300)
    // 耗时受机器抖动影响，这里数读了哪些文件：逐个读时会跟着条数涨
    expect(large).toEqual(small)
    expect(new Set(large)).toEqual(new Set(['m1.md']))
  })
})
