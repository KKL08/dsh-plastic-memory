import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileTable } from '../src/storage/file-table.ts'
import { encodeRecord, splitFrontmatter } from '../src/storage/frontmatter.ts'
import { ARCHIVE_DIR, GLOBAL_DIR, INDEX_FILE } from '../src/storage/paths.ts'
import { InMemoryKvTable } from '../src/kv-table.ts'
import type { RecallStats } from '../src/storage/schema.ts'
import type { MemoryRecord } from '../src/record-schema.ts'
import { record as baseRecord } from './helpers/record.ts'
import { RecordNotFoundError } from '../src/errors.ts'
import { captureRejection } from './helpers/errors.ts'

// 两个宿主进程同时搬同一个 id 的文件：两个 FileTable 实例共用一个记忆根目录，各有各的进程内锁，互不排队。
// fs 是进程边界：给 link / rm / rename 套一层，在指定路径的调用之前或之后插进另一个实例的整次写入，交错时机确定，不靠 sleep。
// 不管怎么交错，写之前存在的 id 写完至少还剩一个文件；索引最后列全目录里的记忆。
type Op = 'link' | 'rm' | 'rename' | 'copyFile'
const { hooks, reads, volume } = vi.hoisted(() => ({
  hooks: [] as Array<{ op: string; path: string; when: 'before' | 'after'; run: () => Promise<unknown> }>,
  reads: [] as string[],   // readFile 读过的路径，按调用顺序
  volume: { isNoHardlink: false },   // 为真时 link 报 ENOTSUP（exFAT/FAT 这类卷），占名退回复制
}))
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const fire = async (op: string, path: string, when: 'before' | 'after') => {
    const i = hooks.findIndex(h => h.op === op && h.path === path && h.when === when)
    if (i < 0) return
    const [h] = hooks.splice(i, 1)   // 只触发一次：插进去的那次写入自己调到同一路径时不再触发
    await h!.run()
  }
  const link = vi.fn(async (...args: Parameters<typeof actual.link>) => {
    await fire('link', String(args[1]), 'before')
    if (volume.isNoHardlink) throw Object.assign(new Error('ENOTSUP: operation not supported, link'), { code: 'ENOTSUP' })
    await actual.link(...args)
    await fire('link', String(args[1]), 'after')
  })
  const rm = vi.fn(async (...args: Parameters<typeof actual.rm>) => {
    await fire('rm', String(args[0]), 'before')
    await actual.rm(...args)
    await fire('rm', String(args[0]), 'after')
  })
  const rename = vi.fn(async (...args: Parameters<typeof actual.rename>) => {   // 目标是第二个参数
    await fire('rename', String(args[1]), 'before')
    await actual.rename(...args)
    await fire('rename', String(args[1]), 'after')
  })
  const copyFile = vi.fn(async (...args: Parameters<typeof actual.copyFile>) => {
    await fire('copyFile', String(args[1]), 'before')
    await actual.copyFile(...args)
    await fire('copyFile', String(args[1]), 'after')
  })
  const readFile = vi.fn(async (...args: Parameters<typeof actual.readFile>) => {
    reads.push(String(args[0]))
    return actual.readFile(...args)
  })
  return { ...actual, link, rm, rename, copyFile, readFile }
})

/** 在 op 作用到 path 的那次调用之前 / 之后跑一次 run（只触发一次）。 */
function at(when: 'before' | 'after', op: Op, path: string, run: () => Promise<unknown>) {
  hooks.push({ op, path, when, run })
}

/** 整次跑完另一个进程的写入：跑的期间换一个 pid，否则它的维护点会把本进程在途的 tmp 当成自家崩溃残留删掉
 *  （真实的两个进程 pid 不同，不会这样）。 */
async function asOtherProcess(run: () => Promise<unknown>) {
  const pid = Object.getOwnPropertyDescriptor(process, 'pid')!
  Object.defineProperty(process, 'pid', { ...pid, value: pid.value + 1 })
  try { return await run() } finally { Object.defineProperty(process, 'pid', pid) }
}

const T0 = 1_700_000_000_000
const record = (partial: Partial<MemoryRecord> = {}) => baseRecord({
  id: 'mem_race', name: '竞态', type: 'preference', content: '旧正文',
  createdAt: T0, updatedAt: T0, lastConfirmedAt: T0, ...partial,
})

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'pm-cross-move-')) })
afterEach(async () => {
  hooks.length = 0
  reads.length = 0
  volume.isNoHardlink = false
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})

const globalDir = () => join(root, GLOBAL_DIR)
const mds = async (dir: string) => (await readdir(dir).catch(() => [] as string[])).filter(n => n.endsWith('.md') && n !== INDEX_FILE).sort()
/** 每个实例一份召回统计侧表，模拟两个进程。 */
const newTable = () => new FileTable({ root, stats: new InMemoryKvTable<RecallStats>() })

async function seed(r: MemoryRecord = record(), fileName = '竞态.md', dir = globalDir()): Promise<string> {
  await mkdir(dir, { recursive: true })
  const path = join(dir, fileName)
  await writeFile(path, encodeRecord(r, {}), 'utf8')
  return path
}

// A 改名并改摘要（并把 updatedAt 推后），B 改名并改正文：两边的修改最终都应该在磁盘上
const renameByA = (r: MemoryRecord): MemoryRecord => ({ ...r, name: '改名后', summary: 'A 改的摘要', updatedAt: r.updatedAt + 1000 })
const renameByB = (r: MemoryRecord): MemoryRecord => ({ ...r, name: '改名后', content: 'B 改的正文' })

async function readMoved() {
  const fm = splitFrontmatter(await readFile(join(globalDir(), '改名后.md'), 'utf8'))
  return { summary: fm.data.summary, body: fm.body }
}

describe('两个进程把同一个 id 改成同一个名字', () => {
  it('A 占到新名、还没删旧文件时 B 整次跑完：B 不覆盖 A 的新文件，A 随后也不删掉仅存的一份', async () => {
    await seed()
    const a = newTable()
    const b = newTable()
    at('after', 'link', join(globalDir(), '改名后.md'), () => asOtherProcess(() => b.update('mem_race', renameByB)))
    await a.update('mem_race', renameByA)
    expect(await mds(globalDir())).toEqual(['改名后.md'])
    expect(await readMoved()).toEqual({ summary: 'A 改的摘要', body: 'B 改的正文' })
  })

  it('B 复核过旧文件、占名之前 A 整次跑完：B 不覆盖 A 已落盘的新文件，在 A 的内容上重算', async () => {
    await seed()
    const a = newTable()
    const b = newTable()
    at('before', 'link', join(globalDir(), '改名后.md'), () => asOtherProcess(() => a.update('mem_race', renameByA)))
    await b.update('mem_race', renameByB)
    expect(await mds(globalDir())).toEqual(['改名后.md'])
    expect(await readMoved()).toEqual({ summary: 'A 改的摘要', body: 'B 改的正文' })
  })
})

describe('占名之后、删旧文件之前源文件不见了', () => {
  it('源文件被别处删掉、新文件仍是本轮写下的那个：删除算数，撤回新文件，重来时报不存在', async () => {
    const source = await seed()
    const b = newTable()
    at('after', 'link', join(globalDir(), '改名后.md'), () => rm(source))
    expect(await captureRejection(b.update('mem_race', renameByB))).toBeInstanceOf(RecordNotFoundError)
    expect(await mds(globalDir())).toEqual([])
  })

  it('卷不支持硬链接、占名退回复制时同样撤回：新文件是复制出来的另一个文件，仍认得出是本轮写的', async () => {
    volume.isNoHardlink = true
    const source = await seed()
    const b = newTable()
    at('after', 'copyFile', join(globalDir(), '改名后.md'), () => rm(source))
    expect(await captureRejection(b.update('mem_race', renameByB))).toBeInstanceOf(RecordNotFoundError)
    expect(await mds(globalDir())).toEqual([])
  })

  it('两个进程改成不同名字、都复核过旧文件后才删：两份都留着，下一次写收成一份', async () => {
    // 交错：A 定位、准备占「甲」→ B 定位（只见旧文件）、占「乙」、复核旧文件，停在删旧文件前 → A 占名、复核、删旧、清副本、
    // 跑完 → B 删旧、清副本。两边定位时都没见过对方的新文件，各自清副本时都不能删它。
    const source = await seed()
    const a = newTable()
    const b = newTable()
    let bRun: Promise<unknown> | undefined
    let bAtRm!: () => void
    const bReachedRm = new Promise<void>(r => { bAtRm = r })
    let releaseB!: () => void
    const aDone = new Promise<void>(r => { releaseB = r })
    at('before', 'link', join(globalDir(), '甲.md'), async () => {
      bRun = b.update('mem_race', r => ({ ...r, name: '乙' }))
      await bReachedRm
    })
    at('before', 'rm', source, async () => { bAtRm(); await aDone })
    await a.update('mem_race', r => ({ ...r, name: '甲' }))
    releaseB()
    await bRun
    expect(await mds(globalDir())).toEqual(['乙.md', '甲.md'])
    await newTable().update('mem_race', r => ({ ...r, summary: '再写一次' }))
    expect(await mds(globalDir())).toHaveLength(1)
  })
})

describe('搬家与彻底删除交错：删除方扫完之后搬家方才占名', () => {
  // 时序：A 定位、复核过源文件 → B 整次删完（删源文件、扫一遍同 id 副本，这时还没有 A 的新文件）→ A 占名写新文件，
  // 复核时发现源文件已不在。A 的新文件没人动过，留着就把刚删掉的内容（可能是密钥）又写回来了
  it('软删进 .archive/：撤回刚写的归档副本，重来时报不存在，盘上一份不剩', async () => {
    await seed(record({ content: '含密钥的正文' }))
    const a = newTable()
    const b = newTable()
    at('before', 'link', join(globalDir(), ARCHIVE_DIR, '竞态.md'), () => asOtherProcess(() => b.delete('mem_race')))
    expect(await captureRejection(a.update('mem_race', r => ({ ...r, status: 'deleted' })))).toBeInstanceOf(RecordNotFoundError)
    expect(await mds(globalDir())).toEqual([])
    expect(await mds(join(globalDir(), ARCHIVE_DIR))).toEqual([])
  })

  it('维护点把非 active 文件搬进 .archive/：同样撤回，不留归档副本', async () => {
    await seed(record({ status: 'deleted', deletedAt: Date.now() }))
    const a = newTable()
    const b = newTable()
    at('before', 'link', join(globalDir(), ARCHIVE_DIR, '竞态.md'), () => asOtherProcess(() => b.delete('mem_race')))
    await a.maintain([globalDir()])
    expect(await mds(globalDir())).toEqual([])
    expect(await mds(join(globalDir(), ARCHIVE_DIR))).toEqual([])
  })
})

describe('两个进程同时维护同一个目录', () => {
  it('同一个非 active 文件被两边同时搬进 .archive/：归档副本不被撤回，搬完还剩一份', async () => {
    await seed(record({ status: 'deleted', deletedAt: Date.now() }))
    const a = newTable()
    const b = newTable()
    at('after', 'link', join(globalDir(), ARCHIVE_DIR, '竞态.md'), () => asOtherProcess(() => b.maintain([globalDir()])))
    await a.maintain([globalDir()])
    expect(await mds(globalDir())).toEqual([])
    expect(await mds(join(globalDir(), ARCHIVE_DIR))).toEqual(['竞态.md'])
  })
})

describe('两个进程各自写完再生同一个目录的索引', () => {
  it('B 按旧清单写索引之前 A 已写全：B 写完重读目录发现清单变了，再写一次，索引两条都有', async () => {
    const a = newTable()
    const b = newTable()
    // B 落盘、读完目录（只有自己）之后、索引换上去之前，A 整次写完（它的索引已含两条）；B 随后用旧清单盖掉
    at('before', 'rename', join(globalDir(), INDEX_FILE), () => asOtherProcess(() => a.create(record({ id: 'mem_a', name: '抢名' }))))
    await b.create(record({ id: 'mem_b', name: '抢名' }))
    const index = await readFile(join(globalDir(), INDEX_FILE), 'utf8')
    expect(index).toContain('mem_a')
    expect(index).toContain('mem_b')
  })

  it('没有别的进程同时写：写完索引只比一次签名，不重读目录里的记忆文件', async () => {
    for (const n of ['甲', '乙', '丙']) await seed(record({ id: `mem_${n}`, name: n }), `${n}.md`)
    const t = newTable()
    reads.length = 0
    await t.create(record({ id: 'mem_new', name: '新' }))   // 索引从无到有，必写
    const memoryReads = reads.filter(p => p.endsWith('.md') && !p.endsWith(INDEX_FILE))
    // 维护点读目录时每个文件读一次；签名没变就不再读第二遍
    expect(memoryReads.sort()).toEqual(['丙.md', '乙.md', '新.md', '甲.md'].map(n => join(globalDir(), n)).sort())
  })

  it('目录没变：索引内容不变就不再写（不空转写盘）', async () => {
    const t = newTable()
    await t.create(record({ id: 'mem_a', name: '甲' }))
    const { rename } = await import('node:fs/promises')
    vi.mocked(rename).mockClear()
    await t.maintain([globalDir()])
    expect(vi.mocked(rename).mock.calls.filter(c => String(c[1]) === join(globalDir(), INDEX_FILE))).toEqual([])
  })
})
