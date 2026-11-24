import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DerivedIndex, type DerivedIndexOptions, type LevelStamp } from '../src/storage/derived-index.ts'

// 派生索引库：真 node:sqlite、临时目录。「另一个进程」用同一路径上的第二个实例模拟（各有自己的连接）。

let dir: string
let opened: DerivedIndex[] = []
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'pm-derived-index-')) })
afterEach(async () => {
  for (const index of opened.splice(0)) index.close()
  await rm(dir, { recursive: true, force: true })
})

const indexPath = () => join(dir, 'nested', 'derived-index.sqlite')

function open(extra: Partial<DerivedIndexOptions> = {}) {
  const warnings: string[] = []
  const log = { info: () => {}, warn: (m: string) => { warnings.push(m) }, error: (m: string) => { warnings.push(m) } }
  const index = new DerivedIndex({ path: indexPath(), log, ...extra })
  opened.push(index)
  return { index, warnings }
}

const stamp = (extra: Partial<LevelStamp> = {}): LevelStamp => ({ mtimeMs: 1000.5, ino: 77, scannedAt: 5000, listing: 'abc', ...extra })
const G = '/root/global'
/** 整层重记，带上此刻的版本号。 */
const replace = (index: DerivedIndex, level: string, rows: ReadonlyArray<readonly [string, string | null]>, extra: Partial<LevelStamp> = {}) =>
  index.replaceLevel(level, stamp(extra), rows.map(([name, id]) => [name, id, `sig-${name}`] as const), index.levelScan(level)?.rev)

describe('派生索引库', () => {
  it('没用过时不建库；没核对过的目录查不到扫描记录，也没有提示', () => {
    const { index } = open()
    expect(existsSync(indexPath())).toBe(false)
    expect(index.levelScan(G)).toBeUndefined()
    expect(index.namesOf(G, 'mem_a')).toEqual([])
    expect(index.hints(G).size).toBe(0)
    expect(index.hasName(G, 'a.md')).toBe(false)
  })

  it('整层重记：扫描记录、每个文件的 id 和签名都能查回来；同一个 id 的几个文件都给', () => {
    const { index } = open()
    expect(replace(index, G, [['a.md', 'mem_a'], ['b.md', 'mem_b'], ['a-copy.md', 'mem_a'], ['broken.md', null]])).toBe(true)
    expect(index.levelScan(G)).toMatchObject(stamp())
    expect(index.namesOf(G, 'mem_a')).toEqual(['a-copy.md', 'a.md'])
    expect(index.namesOf(G, 'mem_missing')).toEqual([])
    expect(index.hasName(G, 'broken.md')).toBe(true)
    expect(index.hints(G).get('b.md')).toEqual({ id: 'mem_b', sig: 'sig-b.md' })
    expect(index.hints(G).get('broken.md')).toEqual({ id: null, sig: 'sig-broken.md' })
  })

  it('各层互不相干：同名文件在两层各记各的，重记一层不动另一层', () => {
    const { index } = open()
    replace(index, G, [['a.md', 'mem_a']])
    replace(index, `${G}/.archive`, [['a.md', 'mem_old']], { mtimeMs: 7 })
    replace(index, G, [['c.md', 'mem_c']], { mtimeMs: 8 })
    expect(index.namesOf(G, 'mem_a')).toEqual([])
    expect(index.namesOf(G, 'mem_c')).toEqual(['c.md'])
    expect(index.namesOf(`${G}/.archive`, 'mem_old')).toEqual(['a.md'])
    expect(index.levelScan(`${G}/.archive`)?.mtimeMs).toBe(7)
  })

  it('补记：去掉不在了的文件、加上新文件、改写同名文件的 id，扫描记录换成新的', () => {
    const { index } = open()
    replace(index, G, [['a.md', 'mem_a'], ['b.md', 'mem_b'], ['c.md', 'mem_c']])
    const rev = index.levelScan(G)!.rev
    expect(index.patchLevel(G, stamp({ mtimeMs: 2000 }), ['a.md'], [['d.md', 'mem_d', 's1'], ['c.md', 'mem_c2', 's2']], rev)).toBe(true)
    expect([...index.hints(G)].map(([name, h]) => [name, h.id]).sort()).toEqual([['b.md', 'mem_b'], ['c.md', 'mem_c2'], ['d.md', 'mem_d']])
    expect(index.levelScan(G)).toMatchObject(stamp({ mtimeMs: 2000 }))
  })

  describe('每次写都带着自己读到的版本号，这期间别人写过就不记', () => {
    it('每次写换一个版本号', () => {
      const { index } = open()
      replace(index, G, [['a.md', 'mem_a']])
      const first = index.levelScan(G)!.rev
      index.patchLevel(G, stamp(), [], [], first)
      expect(index.levelScan(G)!.rev).not.toBe(first)
    })

    it('补记：拿着旧版本号的那一方记不上，库里还是别人后写的那份', () => {
      const a = open().index
      const b = open().index
      replace(a, G, [['a.md', 'mem_a'], ['b.md', 'mem_b']])
      const seenByA = a.levelScan(G)!.rev
      replace(b, G, [['a.md', 'mem_a'], ['b.md', 'mem_b'], ['x.md', 'mem_a']], { listing: 'abx' })   // 别的进程后来整层重记过
      expect(a.patchLevel(G, stamp({ listing: 'abxy' }), [], [['y.md', 'mem_y', 's']], seenByA)).toBe(false)
      expect(a.namesOf(G, 'mem_a')).toEqual(['a.md', 'x.md'])
      expect(a.hasName(G, 'y.md')).toBe(false)
      expect(a.levelScan(G)!.listing).toBe('abx')
    })

    it('整层重记：动手前没有记录、写的时候别人已经记了，就不盖掉；动手前读到的版本号过时了也不盖', () => {
      const a = open().index
      const b = open().index
      replace(b, G, [['new.md', 'mem_new']])
      expect(a.replaceLevel(G, stamp(), [['old.md', 'mem_old', 's']], undefined)).toBe(false)
      const stale = a.levelScan(G)!.rev
      replace(b, G, [['newer.md', 'mem_newer']])
      expect(a.replaceLevel(G, stamp(), [['old.md', 'mem_old', 's']], stale)).toBe(false)
      expect([...a.hints(G).keys()]).toEqual(['newer.md'])
    })

    it('这一层被丢掉再重记之后，丢掉之前读到的版本号也记不上', () => {
      const { index } = open()
      replace(index, G, [['a.md', 'mem_a']])
      const before = index.levelScan(G)!.rev
      index.dropLevel(G)
      replace(index, G, [['b.md', 'mem_b']])
      expect(index.patchLevel(G, stamp(), [], [['z.md', 'mem_z', 's']], before)).toBe(false)
    })
  })

  it('丢掉一层：扫描记录和提示都没了，别的层还在', () => {
    const { index } = open()
    replace(index, G, [['a.md', 'mem_a']])
    replace(index, '/root/ws', [['b.md', 'mem_b']])
    index.dropLevel(G)
    expect(index.levelScan(G)).toBeUndefined()
    expect(index.namesOf(G, 'mem_a')).toEqual([])
    expect(index.namesOf('/root/ws', 'mem_b')).toEqual(['b.md'])
  })

  it('彻底删掉的文件名当场从库里去掉：库文件和它旁边的日志文件里都找不到这个名字', async () => {
    const { index } = open()
    replace(index, G, [['keep.md', 'mem_keep'], ['口令-hunter2-prod.md', 'mem_secret']])
    index.forgetNames(G, ['口令-hunter2-prod.md'])
    expect(index.hasName(G, '口令-hunter2-prod.md')).toBe(false)
    // 这一层下次用到重新核对：留下的扫描记录对不上任何目录
    expect(index.levelScan(G)).toMatchObject({ mtimeMs: -1, ino: -1 })
    expect(index.hasName(G, 'keep.md')).toBe(true)
    index.close()
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      const bytes = await readFile(indexPath() + suffix).catch(() => Buffer.alloc(0))
      expect(bytes.includes('hunter2'), `derived-index.sqlite${suffix}`).toBe(false)
    }
  })

  it('删之前就开始的整层扫描（当时这一层有记录或还没有记录）之后提交不进来，删掉的名字回不来', () => {
    for (const hadScan of [true, false]) {
      const level = `/root/${hadScan ? 'scanned' : 'cold'}`
      const scanner = open().index
      const deleter = open().index
      if (hadScan) replace(deleter, level, [['keep.md', 'mem_keep'], ['secret.md', 'mem_secret']])
      const revBefore = scanner.levelScan(level)?.rev
      deleter.forgetNames(level, ['secret.md'])
      const rows = [['keep.md', 'mem_keep', 's1'], ['secret.md', 'mem_secret', 's2']] as const
      expect(scanner.replaceLevel(level, stamp(), rows, revBefore), `hadScan=${hadScan}`).toBe(false)
      expect(deleter.hasName(level, 'secret.md')).toBe(false)
      // 删之后开始的扫描照常记得上
      expect(scanner.replaceLevel(level, stamp(), [['keep.md', 'mem_keep', 's1']], scanner.levelScan(level)?.rev)).toBe(true)
    }
  })

  describe('主题索引的成员表', () => {
    const pages = [
      { page: '_unsorted.md', title: '未整理', aliases: [], memberIds: ['mem_c'], sig: 's0' },
      { page: 'release.md', title: '发版', aliases: ['上线', '发布'], memberIds: ['mem_b', 'mem_a'], sig: 's1' },
      { page: 'style.md', title: '写法', aliases: [], memberIds: ['mem_a'], sig: 's2' },
    ]

    it('整份重记后查得回来：各页的主题名、曾用名、成员保持给的顺序，一条记忆列在哪几页也查得到', () => {
      const { index } = open()
      expect(index.topicPages(G)).toEqual([])
      index.replaceTopicPages(G, pages)
      expect(index.topicPages(G)).toEqual(pages)
      expect(index.pagesOf(G, 'mem_a')).toEqual(['release.md', 'style.md'])
      expect(index.pagesOf(G, 'mem_x')).toEqual([])
    })

    it('重记是整份替换：没再给的页、曾用名、成员都不留；别的层不动', () => {
      const { index } = open()
      index.replaceTopicPages(G, pages)
      index.replaceTopicPages('/root/ws', pages)
      index.replaceTopicPages(G, [{ page: 'style.md', title: '文风', aliases: ['写法'], memberIds: ['mem_b'], sig: 's3' }])
      expect(index.topicPages(G)).toEqual([{ page: 'style.md', title: '文风', aliases: ['写法'], memberIds: ['mem_b'], sig: 's3' }])
      expect(index.pagesOf(G, 'mem_a')).toEqual([])
      expect(index.topicPages('/root/ws')).toEqual(pages)
    })

    it('丢掉一层时成员表一起丢', () => {
      const { index } = open()
      index.replaceTopicPages(G, pages)
      index.dropLevel(G)
      expect(index.topicPages(G)).toEqual([])
      expect(index.pagesOf(G, 'mem_a')).toEqual([])
    })
  })

  it('另一个进程记下的，这个进程查得到', () => {
    replace(open().index, G, [['a.md', 'mem_a']])
    expect(open().index.namesOf(G, 'mem_a')).toEqual(['a.md'])
  })

  it('关掉再用会重新打开，记过的还在', () => {
    const { index } = open()
    replace(index, G, [['a.md', 'mem_a']])
    index.close()
    expect(index.namesOf(G, 'mem_a')).toEqual(['a.md'])
  })

  describe('库的结构版本和本插件的不一样就删库重建', () => {
    for (const [what, version] of [['更新的版本建的', 99], ['更旧的版本建的', -3]] as const) {
      it(`${what}：原来的内容丢掉，换成能用的新库`, async () => {
        await mkdir(dirname(indexPath()), { recursive: true })
        const other = new DatabaseSync(indexPath())
        other.exec('CREATE TABLE something_else(x TEXT)')
        other.exec(`PRAGMA user_version = ${version}`)
        other.close()
        const { index, warnings } = open()
        expect(replace(index, G, [['a.md', 'mem_a']])).toBe(true)
        expect(index.namesOf(G, 'mem_a')).toEqual(['a.md'])
        expect(warnings).toEqual([])
        const check = new DatabaseSync(indexPath())
        expect(check.prepare("SELECT name FROM sqlite_master WHERE name = 'something_else'").get()).toBeUndefined()
        check.close()
      })
    }
  })

  it('版本号一样、表的样子不一样：同样换成能用的新库', async () => {
    await mkdir(dirname(indexPath()), { recursive: true })
    const other = new DatabaseSync(indexPath())
    other.exec('CREATE TABLE level_scans(level TEXT PRIMARY KEY, mtime_ms REAL NOT NULL, scanned_at REAL NOT NULL, listing TEXT NOT NULL)')
    other.exec('CREATE TABLE id_hints(level TEXT NOT NULL, name TEXT NOT NULL, id TEXT, PRIMARY KEY(level, name))')
    other.exec('PRAGMA user_version = 1')
    other.close()
    const { index, warnings } = open()
    expect(replace(index, G, [['a.md', 'mem_a']])).toBe(true)
    expect(index.hints(G).get('a.md')).toEqual({ id: 'mem_a', sig: 'sig-a.md' })
    expect(warnings).toEqual([])
  })

  it('库文件是坏的：换新库，照常能记', async () => {
    await mkdir(dirname(indexPath()), { recursive: true })
    await writeFile(indexPath(), 'not a database, just some text that is long enough to not look like an empty file')
    const { index } = open()
    expect(replace(index, G, [['a.md', 'mem_a']])).toBe(true)
    expect(index.namesOf(G, 'mem_a')).toEqual(['a.md'])
  })

  it('用着的时候库文件被写坏：删掉重建，之后照常能记，只提醒一次', async () => {
    const { index, warnings } = open()
    replace(index, G, [['a.md', 'mem_a']])
    index.close()
    await writeFile(indexPath(), Buffer.concat([(await readFile(indexPath())).subarray(0, 100), Buffer.alloc(4096, 0x5a)]))
    index.namesOf(G, 'mem_a')
    index.levelScan(G)
    expect(replace(index, G, [['b.md', 'mem_b']])).toBe(true)
    expect(index.namesOf(G, 'mem_b')).toEqual(['b.md'])
    expect(warnings.length).toBeLessThanOrEqual(1)
  })

  describe('库正被别的连接占着', () => {
    it('建库时被占着：这一次不用它，不删库；对方放开后照常能用', async () => {
      await mkdir(dirname(indexPath()), { recursive: true })
      const holder = new DatabaseSync(indexPath())
      holder.exec('BEGIN EXCLUSIVE')
      holder.exec('CREATE TABLE held(x TEXT)')
      const { index, warnings } = open()
      expect(index.levelScan(G)).toBeUndefined()
      expect(replace(index, G, [['a.md', 'mem_a']])).toBe(false)
      expect(warnings).toEqual([])
      holder.exec('COMMIT')
      expect(holder.prepare("SELECT name FROM sqlite_master WHERE name = 'held'").get()).toBeDefined()   // 库没被删掉重建
      holder.close()
      expect(replace(index, G, [['a.md', 'mem_a']])).toBe(true)
      expect(index.namesOf(G, 'mem_a')).toEqual(['a.md'])
    })

    it('用着的时候被占着：这一次读不到、写不进，库里的东西不丢', () => {
      const { index } = open()
      replace(index, G, [['a.md', 'mem_a']])
      const holder = new DatabaseSync(indexPath())
      holder.exec('BEGIN EXCLUSIVE')
      expect(replace(index, G, [['b.md', 'mem_b']])).toBe(false)
      holder.exec('COMMIT')
      holder.close()
      expect(index.namesOf(G, 'mem_a')).toEqual(['a.md'])
    })
  })

  it('node:sqlite 加载不到：什么都不记，查什么都是空，只提醒一次', () => {
    const { index, warnings } = open({ loadSqlite: () => undefined })
    expect(index.replaceLevel(G, stamp(), [['a.md', 'mem_a', 's']], undefined)).toBe(false)
    expect(index.patchLevel(G, stamp(), [], [], 1)).toBe(false)
    expect(index.levelScan(G)).toBeUndefined()
    expect(index.namesOf(G, 'mem_a')).toEqual([])
    expect(warnings).toHaveLength(1)
    expect(existsSync(indexPath())).toBe(false)
  })

  it('库文件被删了：下一次重新建库，从空的开始', async () => {
    const { index } = open()
    replace(index, G, [['a.md', 'mem_a']])
    index.close()
    for (const suffix of ['', '-journal']) await rm(indexPath() + suffix, { force: true })
    expect(index.levelScan(G)).toBeUndefined()
    expect(replace(index, G, [['b.md', 'mem_b']])).toBe(true)
    expect(index.namesOf(G, 'mem_b')).toEqual(['b.md'])
  })
})
