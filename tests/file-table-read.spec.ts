import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import fc from 'fast-check'
import { chmod, mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileTable } from '../src/storage/file-table.ts'
import { encodeRecord } from '../src/storage/frontmatter.ts'
import { resolveDuplicates, type LocatedRecord } from '../src/storage/table.ts'
import { ARCHIVE_DIR, GLOBAL_DIR, STATE_DIR, WORKSPACE_MARKER, workspaceDirName } from '../src/storage/paths.ts'
import { InMemoryKvTable } from '../src/kv-table.ts'
import { matchScore } from '../src/text.ts'
import type { RecallStats } from '../src/storage/schema.ts'
import type { MemoryRecord } from '../src/record-schema.ts'
import { record as baseRecord } from './helpers/record.ts'

// 票 08 读侧内核（docs/design-storage-file-is-memory.md §0 §3 §4）：磁盘是唯一真相、读路径零写入、
// 预筛是超集、加载期零 I/O。只测 FileTable；双后端一致的语义在 table-conformance.spec.ts。

const record = (partial: Partial<MemoryRecord> = {}) => baseRecord({
  id: 'mem_abc', name: '包管理用 pnpm', type: 'preference',
  tags: ['pnpm', 'npm'], content: '这个项目的包管理一律用 pnpm', summary: '包管理选型',
  source: { sessionId: 's1', eventRange: [0, 42], sourceMode: 'user-explicit' },
  createdAt: 1787166413362, updatedAt: 1787166413362, lastConfirmedAt: 1787166413362, ...partial,
})

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'pm-read-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

const globalDir = () => join(root, GLOBAL_DIR)
const wsDir = (p: string) => join(root, workspaceDirName(p))
const open = (opts: Partial<ConstructorParameters<typeof FileTable>[0]> = {}) =>
  new FileTable({ root, stats: new InMemoryKvTable<RecallStats>(), ...opts })

async function seedGlobal(name: string, r: MemoryRecord) {
  await mkdir(globalDir(), { recursive: true })
  await writeFile(join(globalDir(), name), encodeRecord(r, {}))
}
async function seedWorkspace(wsPath: string, name: string, r: MemoryRecord, dir = wsDir(wsPath)) {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, WORKSPACE_MARKER), wsPath + '\n')
  await writeFile(join(dir, name), encodeRecord(r, {}))
}

describe('外部写入立即可见：没有任何刷新调用', () => {
  it('写文件 → readScope 看到；改文件 → 新内容；删文件 → 消失', async () => {
    const t = open()
    expect((await t.readScope([globalDir()])).records).toEqual([])
    await seedGlobal('a.md', record({ id: 'mem_a', content: '第一版' }))
    expect((await t.readScope([globalDir()])).records.map(r => r.record.content)).toEqual(['第一版'])
    expect(((await t.locate('mem_a'))?.record)!.content).toBe('第一版')
    await writeFile(join(globalDir(), 'a.md'), encodeRecord(record({ id: 'mem_a', content: '第二版' }), {}))
    expect((await t.readScope([globalDir()])).records.map(r => r.record.content)).toEqual(['第二版'])
    expect(((await t.locate('mem_a'))?.record)!.content).toBe('第二版')
    await rm(join(globalDir(), 'a.md'))
    expect((await t.readScope([globalDir()])).records).toEqual([])
    expect((await t.locate('mem_a'))?.record).toBeUndefined()
  })

  it('readScope 的记录带实际文件路径与所在目录；workspacePath 取自 .workspace 标记', async () => {
    await seedWorkspace('/home/dev/example-project', 'b.md',
      record({ id: 'mem_w', scope: 'workspace', workspacePath: '/home/dev/example-project' }))
    const t = open()
    const [hit] = (await t.readScope([wsDir('/home/dev/example-project')])).records
    expect(hit.record.workspacePath).toBe('/home/dev/example-project')
    expect(hit.dir).toBe(wsDir('/home/dev/example-project'))
    expect(hit.filePath).toBe(join(wsDir('/home/dev/example-project'), 'b.md'))
  })
})

/** 递归快照：相对路径 → mtime（目录与文件都计），读路径前后必须逐项相等。 */
async function treeSnapshot(dir: string, prefix = ''): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix + entry.name
    const s = await stat(join(dir, entry.name))
    out[rel] = s.mtimeMs
    if (entry.isDirectory()) Object.assign(out, await treeSnapshot(join(dir, entry.name), `${rel}/`))
  }
  return out
}

describe('读路径零写入', () => {
  it('readScope / locate / listWorkspaceDirs 前后目录项与 mtime 不变：含 tmp 残留、重复 id、缺标记目录、隔离文件', async () => {
    await seedGlobal('a.md', record({ id: 'mem_a' }))
    await seedGlobal('dup-old.md', record({ id: 'mem_dup', updatedAt: 100 }))
    await seedGlobal('dup-new.md', record({ id: 'mem_dup', updatedAt: 200 }))
    await writeFile(join(globalDir(), 'bad.md'), '没有 frontmatter\n')
    await writeFile(join(globalDir(), `a.md.tmp-${process.pid}-stale1`), '本进程的残留')
    await seedWorkspace('/home/dev/p', 'w.md', record({ id: 'mem_w', scope: 'workspace', workspacePath: '/home/dev/p' }))
    await mkdir(join(wsDir('/home/dev/p'), ARCHIVE_DIR), { recursive: true })
    await writeFile(join(wsDir('/home/dev/p'), ARCHIVE_DIR, 'old.md'),
      encodeRecord(record({ id: 'mem_old', scope: 'workspace', workspacePath: '/home/dev/p', status: 'deleted', updatedAt: 1 }), {}))
    await mkdir(join(root, 'stray-dir'), { recursive: true })   // 缺标记
    await writeFile(join(root, 'stray-dir', 'x.md'), encodeRecord(record({ id: 'mem_stray' }), {}))
    await new Promise(r => setTimeout(r, 5))
    const before = await treeSnapshot(root)

    const t = open({ now: () => Date.now() + 10 * 86_400_000 })   // 远超 tmp 陈旧阈值与保留期，读路径也不能清
    const read = await t.readScope([globalDir(), wsDir('/home/dev/p'), join(root, 'stray-dir')], { includeArchive: true })
    expect(read.records.map(r => r.record.id).sort()).toEqual(['mem_a', 'mem_dup', 'mem_dup', 'mem_old', 'mem_w'])  // 重复 id 不取舍、不删
    expect(read.quarantined.map(q => q.path)).toEqual([join(globalDir(), 'bad.md')])
    expect(read.directoryNotes.map(n => [n.code, n.path])).toEqual([['marker-missing', join(root, 'stray-dir')]])
    expect((await t.locate('mem_dup'))!.filePath).toBe(join(globalDir(), 'dup-new.md'))
    expect((await t.locate('mem_old', { workspacePath: '/home/dev/p' }))!.filePath).toBe(join(wsDir('/home/dev/p'), ARCHIVE_DIR, 'old.md'))
    expect(await t.locate('mem_nope', { workspacePath: '/home/dev/p' })).toBeUndefined()   // 两级都走一遍
    const listing = await t.listWorkspaceDirs()
    expect(listing.entries.map(e => e.workspacePath)).toEqual(['/home/dev/p'])
    expect(listing.directoryNotes.map(n => n.code)).toEqual(['marker-missing'])
    await t.readScope([t.globalDir, ...listing.entries.map(e => e.dir)], { includeArchive: true })

    expect(await treeSnapshot(root)).toEqual(before)
    expect(Object.keys(before)).not.toContain(STATE_DIR)
  })
})

describe('预筛是超集（性质测试）', () => {
  // 词项不含空白（expandQueryTerms 按空白切分），字段里混入引号、反斜杠、换行、中文与 ASCII。
  const piece = fc.stringMatching(/^[a-z0-9中文测试 "'\\\n]{0,24}$/)
  const term = fc.stringMatching(/^[a-z0-9中文测试"'\\]{1,3}$/)
  const rec = fc.record({
    name: piece.filter(s => s.trim() !== ''), summary: piece, content: piece,
    tags: fc.array(piece.filter(s => s.trim() !== ''), { maxLength: 2 }),
  })

  it('readScope(prefilterTerms) 的结果 ⊇ 真匹配（全部词项子串命中）的记录；encodeRecord 写出的文件', async () => {
    await fc.assert(fc.asyncProperty(fc.array(rec, { minLength: 1, maxLength: 6 }), fc.array(term, { minLength: 1, maxLength: 3 }), async (recs, terms) => {
      const dir = await mkdtemp(join(root, 'prop-'))
      const gdir = join(dir, GLOBAL_DIR)
      await mkdir(gdir)
      await Promise.all(recs.map((r, i) => writeFile(join(gdir, `r${i}.md`), encodeRecord(record({ id: `mem_p${i}`, ...r }), {}))))
      const t = new FileTable({ root: dir, stats: new InMemoryKvTable<RecallStats>() })
      const all = (await t.readScope([gdir])).records
      expect(all).toHaveLength(recs.length)
      const lower = terms.map(x => x.toLowerCase())
      const truth = all.filter(r => matchScore(r.record, lower) === lower.length).map(r => r.record.id).sort()
      const filtered = (await t.readScope([gdir], { prefilterTerms: terms })).records.map(r => r.record.id)
      for (const id of truth) expect(filtered).toContain(id)
      await rm(dir, { recursive: true, force: true })
    }), { numRuns: 40 })
  })

  it('readScope(prefilterTerms, prefilterMatch: any) 的结果 ⊇ 真匹配（任一词项子串命中）的记录', async () => {
    await fc.assert(fc.asyncProperty(fc.array(rec, { minLength: 1, maxLength: 6 }), fc.array(term, { minLength: 1, maxLength: 3 }), async (recs, terms) => {
      const dir = await mkdtemp(join(root, 'prop-'))
      const gdir = join(dir, GLOBAL_DIR)
      await mkdir(gdir)
      await Promise.all(recs.map((r, i) => writeFile(join(gdir, `r${i}.md`), encodeRecord(record({ id: `mem_p${i}`, ...r }), {}))))
      const t = new FileTable({ root: dir, stats: new InMemoryKvTable<RecallStats>() })
      const lower = terms.map(x => x.toLowerCase())
      const truth = (await t.readScope([gdir])).records.filter(r => matchScore(r.record, lower) > 0).map(r => r.record.id)
      const filtered = (await t.readScope([gdir], { prefilterTerms: terms, prefilterMatch: 'any' })).records.map(r => r.record.id)
      for (const id of truth) expect(filtered).toContain(id)
      await rm(dir, { recursive: true, force: true })
    }), { numRuns: 40 })
  })

  it('手写的转义标量（双引号反斜杠、单引号 \'\' 、折行续行）一律不预筛', async () => {
    await mkdir(globalDir(), { recursive: true })
    const files: Record<string, string> = {
      'dq.md': '---\nid: mem_dq\nname: "a\\"b"\ntype: knowledge\n---\n\n正文\n',
      'uni.md': '---\nid: mem_uni\nname: "caf\\u00e9"\ntype: knowledge\n---\n\n正文\n',
      'sq.md': "---\nid: mem_sq\nname: 'it''s'\ntype: knowledge\n---\n\n正文\n",
      'fold.md': '---\nid: mem_fold\nname: "abc\n  def\\\n  ghi"\ntype: knowledge\n---\n\n正文\n',
    }
    for (const [name, text] of Object.entries(files)) await writeFile(join(globalDir(), name), text)
    const t = open()
    const want: Array<[string, string]> = [['a"b', 'mem_dq'], ['café', 'mem_uni'], ["it's", 'mem_sq'], ['defghi', 'mem_fold']]
    for (const [q, id] of want) {
      const ids = (await t.readScope([globalDir()], { prefilterTerms: [q] })).records.map(r => r.record.id)
      expect(ids, q).toContain(id)
    }
    // 对照：普通文件按子串预筛确实会排除（转义文件照旧不排除），大小写不敏感
    await seedGlobal('plain.md', record({ id: 'mem_plain', name: 'plain', content: 'nothing here' }))
    const ids = async (terms: string[]) => (await t.readScope([globalDir()], { prefilterTerms: terms })).records.map(r => r.record.id).sort()
    expect(await ids(['绝不出现'])).toEqual(['mem_dq', 'mem_fold', 'mem_sq', 'mem_uni'])
    expect(await ids(['NOTHING', 'here'])).toEqual(['mem_dq', 'mem_fold', 'mem_plain', 'mem_sq', 'mem_uni'])
    expect(await ids(['nothing', '缺这个'])).toEqual(['mem_dq', 'mem_fold', 'mem_sq', 'mem_uni'])   // 全部词项都要命中
  })
})

describe('文件形态', () => {
  it('CRLF 文件可解析：围栏按 CRLF 识别，正文保留原样；locate 的 id 行匹配不受 \\r 影响', async () => {
    await mkdir(globalDir(), { recursive: true })
    await writeFile(join(globalDir(), 'crlf.md'), '---\r\nid: mem_crlf\r\nname: 手建\r\ntype: knowledge\r\n---\r\n\r\n第一行\r\n第二行\r\n')
    const t = open()
    const [hit] = (await t.readScope([globalDir()])).records
    expect(hit.record.id).toBe('mem_crlf')
    expect(hit.record.content).toBe('第一行\r\n第二行')
    expect((await t.locate('mem_crlf'))!.filePath).toBe(join(globalDir(), 'crlf.md'))
  })

  it('id 带引号与两侧空白（id: "mem_x" / id: \'mem_y\'  ）也能定位', async () => {
    await mkdir(globalDir(), { recursive: true })
    await writeFile(join(globalDir(), 'q.md'), '---\nid: "mem_x"\nname: n\ntype: knowledge\n---\n\nc\n')
    await writeFile(join(globalDir(), 's.md'), "---\nid:   'mem_y'   \nname: n\ntype: knowledge\n---\n\nc\n")
    const t = open()
    expect((await t.locate('mem_x'))!.filePath).toBe(join(globalDir(), 'q.md'))
    expect((await t.locate('mem_y'))!.filePath).toBe(join(globalDir(), 's.md'))
    expect(await t.locate('mem_')).toBeUndefined()   // 前缀不算命中
  })

  it('正文里的 "id: …" 行不算定位命中', async () => {
    await seedGlobal('a.md', record({ id: 'mem_real', content: 'id: mem_fake\n上面那行是正文' }))
    const t = open()
    expect(await t.locate('mem_fake')).toBeUndefined()
  })
})

describe('加载期零 I/O', () => {
  it('memoryRoot 不存在：构造不报错，读方法返回空且不建目录', async () => {
    const missing = join(root, '还不存在')
    const t = new FileTable({ root: missing, stats: new InMemoryKvTable<RecallStats>() })
    expect(await t.readScope([join(missing, GLOBAL_DIR), join(missing, 'any')])).toEqual({ records: [], quarantined: [], directoryNotes: [] })
    expect(await t.listWorkspaceDirs()).toEqual({ entries: [], directoryNotes: [] })
    expect(await t.locate('mem_a', { workspacePath: '/p' })).toBeUndefined()
    await expect(stat(missing)).rejects.toThrow()
    // 首次写才建目录
    await t.put('mem_a', record({ id: 'mem_a' }))
    expect(((await t.locate('mem_a'))?.record)!.id).toBe('mem_a')
  })
})

describe('目录级说明与目录名确定性', () => {
  it('缺标记 / 空标记 / 不可读目录进说明，不进清单；.state/ 与隐藏目录永远不当 workspace 目录', async () => {
    await mkdir(join(root, 'no-marker'), { recursive: true })
    await mkdir(join(root, 'empty-marker'), { recursive: true })
    await writeFile(join(root, 'empty-marker', WORKSPACE_MARKER), '\n')
    await mkdir(join(root, STATE_DIR, 'snapshots'), { recursive: true })
    await mkdir(join(root, '.hidden'), { recursive: true })
    await seedWorkspace('/home/dev/locked', 'a.md', record({ id: 'mem_l', scope: 'workspace', workspacePath: '/home/dev/locked' }))
    await chmod(wsDir('/home/dev/locked'), 0o000)
    try {
      const t = open()
      const listing = await t.listWorkspaceDirs()
      expect(listing.entries).toEqual([])
      expect(listing.directoryNotes.map(n => [n.code, n.path]).sort()).toEqual([
        ['dir-unreadable', wsDir('/home/dev/locked')],
        ['marker-missing', join(root, 'empty-marker')],
        ['marker-missing', join(root, 'no-marker')],
      ].sort())
      const read = await t.readScope([wsDir('/home/dev/locked')])
      expect(read.records).toEqual([])
      expect(read.directoryNotes.map(n => n.code)).toEqual(['dir-unreadable'])
    } finally {
      await chmod(wsDir('/home/dev/locked'), 0o755)
    }
  })

  it('手工改名的 workspace 目录：以标记内容为准，定位经清单找到，写入仍落回该目录', async () => {
    const renamed = join(root, 'my-renamed-project')
    await seedWorkspace('/home/dev/p', 'a.md', record({ id: 'mem_a', scope: 'workspace', workspacePath: '/home/dev/p' }), renamed)
    const t = open()
    expect((await t.listWorkspaceDirs()).entries).toEqual([{ workspacePath: '/home/dev/p', dir: renamed, hasActiveTopLevel: true }])
    expect((await t.locate('mem_a', { workspacePath: '/home/dev/p' }))!.dir).toBe(renamed)
    await t.update('mem_a', r => ({ ...r, content: '改过', updatedAt: 2 }))
    await t.put('mem_b', record({ id: 'mem_b', name: 'b', scope: 'workspace', workspacePath: '/home/dev/p' }))
    expect((await readdir(renamed)).filter(n => n.endsWith('.md')).sort()).toEqual(['MEMORY.md', 'a.md', 'b.md'])
    await expect(stat(wsDir('/home/dev/p'))).rejects.toThrow()   // 没有另建确定性目录
  })
})

describe('resolveDuplicates 的五级规则', () => {
  const at = (dir: string, file: string, r: Partial<MemoryRecord>): LocatedRecord =>
    ({ record: record({ id: 'mem_x', ...r }), dir, filePath: join(dir, file) })
  const hint = { workspacePath: '/cur' }
  const cur = (file: string, r: Partial<MemoryRecord> = {}) => at('/r/cur', file, { scope: 'workspace', workspacePath: '/cur', ...r })
  const glb = (file: string, r: Partial<MemoryRecord> = {}) => at('/r/global', file, { scope: 'global', ...r })
  const oth = (file: string, r: Partial<MemoryRecord> = {}) => at('/r/other', file, { scope: 'workspace', workspacePath: '/other', ...r })

  it('updatedAt → 当前 workspace → global → 其他项目 → 路径字典序；保持首次出现的顺序', () => {
    expect(resolveDuplicates([cur('a.md', { updatedAt: 1 }), oth('a.md', { updatedAt: 2 })], hint)[0].filePath).toBe('/r/other/a.md')
    expect(resolveDuplicates([glb('a.md', { updatedAt: 1 }), cur('a.md', { updatedAt: 1 })], hint)[0].filePath).toBe('/r/cur/a.md')
    expect(resolveDuplicates([oth('a.md', { updatedAt: 1 }), glb('a.md', { updatedAt: 1 })], hint)[0].filePath).toBe('/r/global/a.md')
    expect(resolveDuplicates([oth('a.md', { updatedAt: 1 }), cur('a.md', { updatedAt: 1 })], hint)[0].filePath).toBe('/r/cur/a.md')
    expect(resolveDuplicates([oth('z.md', { updatedAt: 1 }), oth('b.md', { updatedAt: 1 })], hint)[0].filePath).toBe('/r/other/b.md')
    // 无提示：没有"当前 workspace"这一级
    expect(resolveDuplicates([cur('a.md', { updatedAt: 1 }), glb('a.md', { updatedAt: 1 })])[0].filePath).toBe('/r/global/a.md')
    const kept = resolveDuplicates([glb('a.md', { id: 'mem_1', updatedAt: 1 }), glb('b.md', { id: 'mem_2' }), glb('c.md', { id: 'mem_1', updatedAt: 9 })])
    expect(kept.map(k => [k.record.id, k.filePath])).toEqual([['mem_1', '/r/global/c.md'], ['mem_2', '/r/global/b.md']])
  })
})
