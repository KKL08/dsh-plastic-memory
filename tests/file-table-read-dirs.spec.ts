import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm, stat, chmod, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileTable, DELETED_RETENTION_MS } from '../src/storage/file-table.ts'
import { encodeRecord } from '../src/storage/frontmatter.ts'
import { workspaceDirName, WORKSPACE_MARKER, GLOBAL_DIR, STATE_DIR, ARCHIVE_DIR } from '../src/storage/paths.ts'
import { InMemoryKvTable } from '../src/kv-table.ts'
import type { RecallStats } from '../src/storage/schema.ts'
import type { MemoryRecord } from '../src/record-schema.ts'
import { record as baseRecord } from './helpers/record.ts'

// 从磁盘读记忆目录的行为（0.2.0 起没有加载期：每个读方法直接读目录；清扫、索引再生、tmp 清理只在写路径末尾）。
// 本文件默认造那条"包管理用 pnpm"的 global preference（编解码/去重断言的固定样本）。
const record = (partial: Partial<MemoryRecord> = {}) => baseRecord({
  id: 'mem_abc', name: '包管理用 pnpm', type: 'preference',
  tags: ['pnpm', 'npm'], content: '这个项目的包管理一律用 pnpm', summary: '包管理选型',
  source: { sessionId: 's1', eventRange: [0, 42], sourceMode: 'user-explicit' },
  createdAt: 1787166413362, updatedAt: 1787166413362, lastConfirmedAt: 1787166413362, ...partial,
})

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'pm15-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

async function seedGlobal(name: string, r: MemoryRecord, extras = {}) {
  await mkdir(join(root, GLOBAL_DIR), { recursive: true })
  await writeFile(join(root, GLOBAL_DIR, name), encodeRecord(r, extras))
}
async function seedArchived(name: string, r: MemoryRecord) {
  await mkdir(join(root, GLOBAL_DIR, ARCHIVE_DIR), { recursive: true })
  await writeFile(join(root, GLOBAL_DIR, ARCHIVE_DIR, name), encodeRecord(r, {}))
}
async function seedWorkspace(wsPath: string, name: string, r: MemoryRecord) {
  const dir = join(root, workspaceDirName(wsPath))
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, WORKSPACE_MARKER), wsPath + '\n')
  await writeFile(join(dir, name), encodeRecord(r, {}))
}
function open(opts: Partial<ConstructorParameters<typeof FileTable>[0]> = {}) {
  return new FileTable({ root, stats: new InMemoryKvTable<RecallStats>(), ...opts })
}
const globalDir = () => join(root, GLOBAL_DIR)

it('读 global 与 workspace，含连字符的路径经 .workspace 无损还原', async () => {
  await seedGlobal('a.md', record({ id: 'mem_g' }))
  await seedWorkspace('/home/dev/example-project', 'b.md',
    record({ id: 'mem_w', scope: 'workspace', workspacePath: '/home/dev/example-project' }))
  const t = open()
  expect(((await t.locate('mem_g'))?.record)!.scope).toBe('global')
  expect(((await t.locate('mem_w'))?.record)!.workspacePath).toBe('/home/dev/example-project') // Critical #1 回归钉
})

it('MEMORY.md 被跳过不算 malformed；坏文件随读取返回隔离条目且不影响其余', async () => {
  await seedGlobal('a.md', record({ id: 'mem_ok' }))
  await mkdir(join(root, GLOBAL_DIR), { recursive: true })
  await writeFile(join(root, GLOBAL_DIR, 'MEMORY.md'), '# 索引\n')
  await writeFile(join(root, GLOBAL_DIR, 'bad.md'), '没有 frontmatter')
  const t = open()
  expect(((await t.locate('mem_ok'))?.record)!.status).toBe('active')
  const { quarantined } = await t.readScope([globalDir()])
  expect(quarantined).toHaveLength(1)
  expect(quarantined[0].path).toContain('bad.md')
})

it('同 id 两处 → 读到 updatedAt 新者，旧文件保留（读路径零写入；物理清理留给写路径）', async () => {
  await seedGlobal('old.md', record({ id: 'mem_dup', updatedAt: 100 }))
  await seedGlobal('new.md', record({ id: 'mem_dup', updatedAt: 200, content: '新版' }))
  const t = open()
  expect(((await t.locate('mem_dup'))?.record)!.content).toBe('新版')
  expect((await stat(join(root, GLOBAL_DIR, 'old.md'))).isFile()).toBe(true)
})

it('.state/（侧表目录）不当 workspace 目录：不告警、不进清单、不进说明、不建索引', async () => {
  await mkdir(join(root, STATE_DIR, 'snapshots'), { recursive: true })
  const warns: string[] = []
  const t = open({ log: { info() {}, warn: m => { warns.push(m) }, error() {} } })
  expect(await t.listWorkspaceDirs()).toEqual({ entries: [], directoryNotes: [] })
  expect((await t.readScope([t.globalDir], { includeArchive: true })).directoryNotes).toEqual([])
  expect(warns).toEqual([])
  expect(await readdir(join(root, STATE_DIR))).toEqual(['snapshots'])
})

it('sidecar 合并：有行取行值，无行注入默认', async () => {
  await seedGlobal('a.md', record({ id: 'mem_a' }))
  await seedGlobal('b.md', record({ id: 'mem_b' }))
  const stats = new InMemoryKvTable<RecallStats>()
  await stats.put('mem_a', { id: 'mem_a', recallCount: 7, lastRecalledAt: 999 })
  const t = open({ stats })
  expect(((await t.locate('mem_a'))?.record)!.recallCount).toBe(7)
  expect(((await t.locate('mem_a'))?.record)!.lastRecalledAt).toBe(999)
  // mem_b 在 sidecar 里无行 → decode 阶段注入默认值，合并不应改动
  expect(((await t.locate('mem_b'))?.record)!.recallCount).toBe(0)
  expect(((await t.locate('mem_b'))?.record)!.lastRecalledAt).toBeNull()
  // readScope 同样合并
  const byId = new Map((await t.readScope([globalDir()])).records.map(r => [r.record.id, r.record]))
  expect(byId.get('mem_a')!.recallCount).toBe(7)
  expect(byId.get('mem_b')!.recallCount).toBe(0)
})

it('清扫在写路径末尾：.archive/ 里 deletedAt 超 14 天 → 物理删除；未超期保留；纯读不清', async () => {
  const now = 100 * 86_400_000
  await seedArchived('old.md', record({ id: 'mem_old', status: 'deleted', updatedAt: now, deletedAt: now - DELETED_RETENTION_MS - 1 }))
  await seedArchived('fresh.md', record({ id: 'mem_fresh', status: 'deleted', updatedAt: now - 30 * 86_400_000, deletedAt: now - 1000 }))
  const t = open({ now: () => now })
  expect(((await t.locate('mem_old'))?.record)!.status).toBe('deleted')   // 读路径不清
  await t.put('mem_x', record({ id: 'mem_x', name: 'x', updatedAt: now }))   // 写该目录触发维护
  expect((await t.locate('mem_old'))?.record).toBeUndefined()
  await expect(stat(join(root, GLOBAL_DIR, ARCHIVE_DIR, 'old.md'))).rejects.toThrow()
  expect(((await t.locate('mem_fresh'))?.record)!.status).toBe('deleted')
})

it('外部就地覆盖写无需任何刷新调用：下一次读就是新内容', async () => {
  await seedGlobal('a.md', record({ id: 'mem_a' }))
  const t = open()
  expect(((await t.locate('mem_a'))?.record)!.content).toBe('这个项目的包管理一律用 pnpm')
  await writeFile(join(root, GLOBAL_DIR, 'a.md'), encodeRecord(record({ id: 'mem_a', content: '外部改过' }), {}))
  expect(((await t.locate('mem_a'))?.record)!.content).toBe('外部改过')
})

it('紧邻的外部编辑也立即可见（没有节流、没有指纹）', async () => {
  await seedGlobal('a.md', record({ id: 'mem_a', content: '原始' }))
  const t = open({ now: () => 1_000_000 })
  expect(((await t.locate('mem_a'))?.record)!.content).toBe('原始')
  await writeFile(join(root, GLOBAL_DIR, 'a.md'), encodeRecord(record({ id: 'mem_a', content: '改动1' }), {}))
  expect(((await t.locate('mem_a'))?.record)!.content).toBe('改动1')
})

it('root 变得不可读：读方法不抛，按空返回并带 dir-unreadable 说明', async () => {
  await seedGlobal('a.md', record({ id: 'mem_a' }))
  const t = open()
  expect((await t.locate('mem_a'))?.record).toBeDefined()
  await chmod(root, 0o000)
  try {
    expect((await t.locate('mem_a'))?.record).toBeUndefined()
    const listing = await t.listWorkspaceDirs()
    expect(listing.entries).toEqual([])
    expect(listing.directoryNotes.map(n => n.code)).toEqual(['dir-unreadable'])
    expect((await t.readScope([globalDir()])).directoryNotes.map(n => n.code)).toEqual(['dir-unreadable'])
  } finally {
    await chmod(root, 0o755)  // 恢复权限，否则 afterEach 的 rm 会失败
  }
})

it('root 不存在：构造与读都不抛、不建目录（加载期零 I/O）', async () => {
  const missing = join(root, '不存在的子层')
  const t = new FileTable({ root: missing, stats: new InMemoryKvTable<RecallStats>() })
  await expect(t.readScope([t.globalDir])).resolves.toMatchObject({ records: [] })
  await expect(stat(missing)).rejects.toThrow()
})

it('单个 workspace 目录不可读 → 该目录记录缺失，其余目录记录不受影响', async () => {
  await seedGlobal('a.md', record({ id: 'mem_g' }))
  await seedWorkspace('/home/dev/unreadable-ws', 'b.md',
    record({ id: 'mem_w', scope: 'workspace', workspacePath: '/home/dev/unreadable-ws' }))
  const wsDir = join(root, workspaceDirName('/home/dev/unreadable-ws'))
  await chmod(wsDir, 0o000)
  try {
    const t = open()
    expect(((await t.locate('mem_g'))?.record)!.scope).toBe('global')
    expect((await t.locate('mem_w'))?.record).toBeUndefined()
    expect((await t.readScope([t.globalDir, wsDir])).records.map(r => r.record.id)).toEqual(['mem_g'])
  } finally {
    await chmod(wsDir, 0o755)  // 恢复权限，否则 afterEach 的 rm 会失败
  }
})

describe('tmp 残留只在写路径末尾清理', () => {
  it('本进程 pid 的 tmp 残留在写该目录后被删（自家崩溃残留）', async () => {
    await seedGlobal('a.md', record({ id: 'mem_a' }))
    const tmp = join(root, GLOBAL_DIR, `a.md.tmp-${process.pid}-abc123`)
    await writeFile(tmp, '残留')
    const t = open()
    await t.locate('mem_a')
    expect((await stat(tmp)).isFile()).toBe(true)   // 纯读不清
    await t.put('mem_b', record({ id: 'mem_b', name: 'b' }))
    await expect(stat(tmp)).rejects.toThrow()
  })

  it('他进程 pid 的新鲜 tmp 不被删（并发在途文件不能误删）', async () => {
    await seedGlobal('a.md', record({ id: 'mem_a' }))
    const tmp = join(root, GLOBAL_DIR, `a.md.tmp-${process.pid + 1}-abc123`)
    await writeFile(tmp, '别的进程在途')
    const t = open()
    await t.put('mem_b', record({ id: 'mem_b', name: 'b' }))
    expect((await stat(tmp)).isFile()).toBe(true)
  })

  it('超龄 tmp 残留被删（mtime 超 60 秒，不论出自哪个进程）', async () => {
    await seedGlobal('a.md', record({ id: 'mem_a' }))
    const tmp = join(root, GLOBAL_DIR, `a.md.tmp-${process.pid + 1}-abc123`)
    await writeFile(tmp, '陈旧残留')
    const mtime = (await stat(tmp)).mtimeMs
    const t = open({ now: () => mtime + 61_000 })
    await t.put('mem_b', record({ id: 'mem_b', name: 'b', updatedAt: mtime }))
    await expect(stat(tmp)).rejects.toThrow()
  })
})

it('MEMORY.md 内容未变时写路径末尾的再生不改其 mtime（不空转写盘）', async () => {
  const t = open()
  await t.put('mem_a', record({ id: 'mem_a', name: 'a' }))
  const before = await stat(join(root, GLOBAL_DIR, 'MEMORY.md'))
  await new Promise(r => setTimeout(r, 10))
  await t.put('mem_d', record({ id: 'mem_d', name: 'd', status: 'deleted', updatedAt: Date.now() }))   // 不进索引：索引内容不变
  const after = await stat(join(root, GLOBAL_DIR, 'MEMORY.md'))
  expect(after.mtimeMs).toBe(before.mtimeMs)
})

it('合法名称含 .tmp- 不是原子写残留：新实例、推进 61 秒后再写，记录与文件都还在', async () => {
  // 原子写残留形如 <file>.tmp-<pid>-<rand>（结尾无 .md）；正式记忆文件以 .md 结尾。
  // 只看子串会把 cache.tmp-notes.md 当残留物理删除。
  let clock = 1_000_000
  const mk = () => open({ now: () => clock })
  const t1 = mk()
  await t1.put('mem_tmp', record({ id: 'mem_tmp', name: 'cache.tmp-notes' }))
  const t2 = mk()
  expect((await t2.locate('mem_tmp'))?.record.name).toBe('cache.tmp-notes')
  clock += 61_000
  const t3 = mk()
  await t3.put('mem_other', record({ id: 'mem_other', name: 'other' }))
  expect((await t3.locate('mem_tmp'))?.record.name).toBe('cache.tmp-notes')
  expect(await readdir(join(root, GLOBAL_DIR))).toContain('cache.tmp-notes.md')
})
