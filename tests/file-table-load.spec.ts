import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm, stat, chmod, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileTable, DELETED_RETENTION_MS } from '../src/storage/file-table.ts'
import { encodeRecord } from '../src/storage/frontmatter.ts'
import { workspaceDirName, WORKSPACE_MARKER, GLOBAL_DIR } from '../src/storage/paths.ts'
import { InMemoryKvTable } from '../src/kv-table.ts'
import type { RecallStats } from '../src/storage/schema.ts'
import type { MemoryRecord } from '../src/record-schema.ts'
import { record as baseRecord } from './helpers/record.ts'

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
async function seedWorkspace(wsPath: string, name: string, r: MemoryRecord) {
  const dir = join(root, workspaceDirName(wsPath))
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, WORKSPACE_MARKER), wsPath + '\n')
  await writeFile(join(dir, name), encodeRecord(r, {}))
}
async function load() {
  const t = new FileTable({ root, stats: new InMemoryKvTable<RecallStats>() })
  await t.load()
  return t
}

it('加载 global 与 workspace，含连字符的路径经 .workspace 无损还原', async () => {
  await seedGlobal('a.md', record({ id: 'mem_g' }))
  await seedWorkspace('/home/dev/example-project', 'b.md',
    record({ id: 'mem_w', scope: 'workspace', workspacePath: '/home/dev/example-project' }))
  const t = await load()
  expect(t.get('mem_g')!.scope).toBe('global')
  expect(t.get('mem_w')!.workspacePath).toBe('/home/dev/example-project') // Critical #1 回归钉
})

it('MEMORY.md 被跳过不算 malformed；坏文件隔离且不影响其余', async () => {
  await seedGlobal('a.md', record({ id: 'mem_ok' }))
  await mkdir(join(root, GLOBAL_DIR), { recursive: true })
  await writeFile(join(root, GLOBAL_DIR, 'MEMORY.md'), '# 索引\n')
  await writeFile(join(root, GLOBAL_DIR, 'bad.md'), '没有 frontmatter')
  const t = await load()
  expect(t.get('mem_ok')!.status).toBe('active')
  expect(t.quarantined()).toHaveLength(1)
  expect(t.quarantined()[0].path).toContain('bad.md')
})

it('同 id 两处 → 取 updatedAt 新者，旧文件被删除', async () => {
  await seedGlobal('old.md', record({ id: 'mem_dup', updatedAt: 100 }))
  await seedGlobal('new.md', record({ id: 'mem_dup', updatedAt: 200, content: '新版' }))
  const t = await load()
  expect(t.get('mem_dup')!.content).toBe('新版')
  await expect(stat(join(root, GLOBAL_DIR, 'old.md'))).rejects.toThrow()
})

it('sidecar 合并：有行取行值，无行注入默认', async () => {
  await seedGlobal('a.md', record({ id: 'mem_a' }))
  await seedGlobal('b.md', record({ id: 'mem_b' }))
  const stats = new InMemoryKvTable<RecallStats>()
  await stats.put('mem_a', { id: 'mem_a', recallCount: 7, lastRecalledAt: 999 })
  const t = new FileTable({ root, stats }); await t.load()
  expect(t.get('mem_a')!.recallCount).toBe(7)
  expect(t.get('mem_a')!.lastRecalledAt).toBe(999)
  // mem_b 在 sidecar 里无行 → decode 阶段注入默认值，合并循环不应改动
  expect(t.get('mem_b')!.recallCount).toBe(0)
  expect(t.get('mem_b')!.lastRecalledAt).toBeNull()
})

it('清扫：deleted 且超 14 天 → 物理删除；未超期保留', async () => {
  const now = 100 * 86_400_000
  await seedGlobal('old.md', record({ id: 'mem_old', status: 'deleted', updatedAt: now - DELETED_RETENTION_MS - 1 }))
  await seedGlobal('fresh.md', record({ id: 'mem_fresh', status: 'deleted', updatedAt: now - 1000 }))
  const t = new FileTable({ root, stats: new InMemoryKvTable<RecallStats>(), now: () => now })
  await t.load()
  expect(t.get('mem_old')).toBeUndefined()
  expect(t.get('mem_fresh')!.status).toBe('deleted')
})

it('外部就地追加写被指纹感知（目录 mtime 抓不到的场景）', async () => {
  await seedGlobal('a.md', record({ id: 'mem_a' }))
  const t = await load()
  await new Promise(r => setTimeout(r, 10))
  await writeFile(join(root, GLOBAL_DIR, 'a.md'), encodeRecord(record({ id: 'mem_a', content: '外部改过' }), {}))
  await t.refreshIfChanged()
  expect(t.get('mem_a')!.content).toBe('外部改过')
})

it('refreshIfChanged 无节流：紧邻的外部编辑也立即被感知（入口校准是无条件硬保证）', async () => {
  await seedGlobal('a.md', record({ id: 'mem_a', content: '原始' }))
  const t = new FileTable({ root, stats: new InMemoryKvTable<RecallStats>(), now: () => 1_000_000 })
  await t.load()
  await t.refreshIfChanged()

  await writeFile(join(root, GLOBAL_DIR, 'a.md'), encodeRecord(record({ id: 'mem_a', content: '改动1' }), {}))
  await t.refreshIfChanged() // 与上一次 refresh 零间隔，也必须看到外部编辑
  expect(t.get('mem_a')!.content).toBe('改动1')
})

it('重载失败不丢内存态：root 变得不可读后 refreshIfChanged 保留原记录', async () => {
  await seedGlobal('a.md', record({ id: 'mem_a' }))
  const t = await load()
  expect(t.get('mem_a')).toBeDefined()
  await chmod(root, 0o000)
  try {
    // 指纹计算得到 '' ≠ 原指纹 → 触发重载 → 重载因权限失败 → 必须保留旧 map
    await t.refreshIfChanged()
    expect(t.get('mem_a')).toBeDefined()
    expect(t.get('mem_a')!.id).toBe('mem_a')
  } finally {
    await chmod(root, 0o755)  // 恢复权限，否则 afterEach 的 rm 会失败
  }
})

it('整目录不可读 → 警告计空不抛；root 不存在 → 自动建（apply 不得抛）', async () => {
  const t = new FileTable({ root: join(root, '不存在的子层'), stats: new InMemoryKvTable<RecallStats>() })
  await expect(t.load()).resolves.toBeUndefined()
})

it('单个 workspace 目录不可读 → 该目录记录缺失，其余目录记录不受影响', async () => {
  await seedGlobal('a.md', record({ id: 'mem_g' }))
  await seedWorkspace('/home/dev/unreadable-ws', 'b.md',
    record({ id: 'mem_w', scope: 'workspace', workspacePath: '/home/dev/unreadable-ws' }))
  const wsDir = join(root, workspaceDirName('/home/dev/unreadable-ws'))
  await chmod(wsDir, 0o000)
  try {
    const t = await load()
    expect(t.get('mem_g')!.scope).toBe('global')
    expect(t.get('mem_w')).toBeUndefined()
  } finally {
    await chmod(wsDir, 0o755)  // 恢复权限，否则 afterEach 的 rm 会失败
  }
})

it('本进程 pid 的 tmp 残留在 load 时被删（自家崩溃残留）', async () => {
  await seedGlobal('a.md', record({ id: 'mem_a' }))
  const tmp = join(root, GLOBAL_DIR, `a.md.tmp-${process.pid}-abc123`)
  await writeFile(tmp, '残留')
  await load()
  await expect(stat(tmp)).rejects.toThrow()
})

it('他进程 pid 的新鲜 tmp 不被删（并发在途文件不能误删）', async () => {
  await seedGlobal('a.md', record({ id: 'mem_a' }))
  const tmp = join(root, GLOBAL_DIR, `a.md.tmp-${process.pid + 1}-abc123`)
  await writeFile(tmp, '别的进程在途')
  await load()
  expect((await stat(tmp)).isFile()).toBe(true)
})

it('超龄 tmp 残留被删（mtime 超 60 秒，不论出自哪个进程）', async () => {
  await seedGlobal('a.md', record({ id: 'mem_a' }))
  const tmp = join(root, GLOBAL_DIR, `a.md.tmp-${process.pid + 1}-abc123`)
  await writeFile(tmp, '陈旧残留')
  const mtime = (await stat(tmp)).mtimeMs
  const t = new FileTable({ root, stats: new InMemoryKvTable<RecallStats>(), now: () => mtime + 61_000 })
  await t.load()
  await expect(stat(tmp)).rejects.toThrow()
})

it('MEMORY.md 内容未变时 load 不改其 mtime（refresh 不得空转写盘）', async () => {
  await seedGlobal('a.md', record({ id: 'mem_a' }))
  await load()
  const before = await stat(join(root, GLOBAL_DIR, 'MEMORY.md'))
  await new Promise(r => setTimeout(r, 10))
  await load()
  const after = await stat(join(root, GLOBAL_DIR, 'MEMORY.md'))
  expect(after.mtimeMs).toBe(before.mtimeMs)
})

it('合法名称含 .tmp- 不是原子写残留：新实例重载、推进 61 秒后记录与文件都还在', async () => {
  // 原子写残留形如 <file>.tmp-<pid>-<rand>（结尾无 .md）；正式记忆文件以 .md 结尾。
  // 只看子串会把 cache.tmp-notes.md 当残留：先在内存里消失，再被当陈旧文件物理删除。
  let clock = 1_000_000
  const mk = () => new FileTable({ root, stats: new InMemoryKvTable<RecallStats>(), now: () => clock })
  const t1 = mk(); await t1.load()
  await t1.put('mem_tmp', record({ id: 'mem_tmp', name: 'cache.tmp-notes' }))
  const t2 = mk(); await t2.load()
  expect(t2.get('mem_tmp')?.name).toBe('cache.tmp-notes')
  clock += 61_000
  const t3 = mk(); await t3.load()
  expect(t3.get('mem_tmp')?.name).toBe('cache.tmp-notes')
  expect(await readdir(join(root, GLOBAL_DIR))).toContain('cache.tmp-notes.md')
})
