import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileTable } from '../src/storage/file-table.ts'
import { encodeRecord } from '../src/storage/frontmatter.ts'
import { workspaceDirName, WORKSPACE_MARKER, GLOBAL_DIR, ARCHIVE_DIR } from '../src/storage/paths.ts'
import { InMemoryKvTable } from '../src/kv-table.ts'
import { SnapshotStore } from '../src/governance/snapshots.ts'
import { PendingDecisionsStore } from '../src/governance/decisions.ts'
import type { MemorySnapshot, PendingDecision } from '../src/governance/schema.ts'
import type { RecallStats } from '../src/storage/schema.ts'
import type { MemoryRecord } from '../src/record-schema.ts'
import { MemoryStore } from '../src/store.ts'
import { runSavePipeline } from '../src/pipeline.ts'
import { executeForget } from '../src/tools/forget.ts'
import { executePromote } from '../src/tools/promote.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'
import { record as baseRecord } from './helpers/record.ts'
import { RecordNotFoundError } from '../src/errors.ts'
import { captureRejection } from './helpers/errors.ts'

// 本文件默认造那条"包管理用 pnpm"的 global preference（编解码/去重断言的固定样本）。
const record = (partial: Partial<MemoryRecord> = {}) => baseRecord({
  id: 'mem_abc', name: '包管理用 pnpm', type: 'preference',
  tags: ['pnpm', 'npm'], content: '这个项目的包管理一律用 pnpm', summary: '包管理选型',
  source: { sessionId: 's1', eventRange: [0, 42], sourceMode: 'user-explicit' },
  createdAt: 1787166413362, updatedAt: 1787166413362, lastConfirmedAt: 1787166413362, ...partial,
})

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'pm15-write-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

async function seedGlobal(name: string, r: MemoryRecord, extras = {}) {
  await mkdir(join(root, GLOBAL_DIR), { recursive: true })
  await writeFile(join(root, GLOBAL_DIR, name), encodeRecord(r, extras))
}
async function load() {
  return new FileTable({ root, stats: new InMemoryKvTable<RecallStats>() })   // 构造零 I/O：没有加载期
}
const quarantined = (t: FileTable) => t.readScope([join(root, GLOBAL_DIR)]).then(r => r.quarantined)

describe('FileTable 写侧', () => {
  it('markRecalled 型更新（只动易变字段）不触碰文件——mtime 不变', async () => {
    await seedGlobal('a.md', record({ id: 'mem_a' }))
    const t = await load()
    const before = (await stat(join(root, GLOBAL_DIR, 'a.md'))).mtimeMs
    await t.update('mem_a', r => ({ ...r, recallCount: r.recallCount + 1, lastRecalledAt: 123 }))
    const after = (await stat(join(root, GLOBAL_DIR, 'a.md'))).mtimeMs
    expect(after).toBe(before)                       // §4 核心命题
    expect(((await t.locate('mem_a'))?.record)!.recallCount).toBe(1)      // 内存与 sidecar 已更新
  })

  it('内容更新重写文件，且文件里不出现易变字段（旧统计不被 spread 带进文件）', async () => {
    await seedGlobal('a.md', record({ id: 'mem_a' }))
    const t = await load()
    await t.update('mem_a', r => ({ ...r, recallCount: 5, content: '新内容', updatedAt: 999 }))
    const raw = await readFile(join(root, GLOBAL_DIR, 'a.md'), 'utf8')
    expect(raw).toContain('新内容')
    expect(raw).not.toContain('recallCount')
  })

  it('scope 变更 = 移动：新目录有、旧目录无、.workspace 正确', async () => {
    await seedGlobal('a.md', record({ id: 'mem_a' }))
    const t = await load()
    await t.update('mem_a', r => ({ ...r, scope: 'workspace', workspacePath: '/tmp/proj-x', updatedAt: 2 }))
    const wsDir = join(root, workspaceDirName('/tmp/proj-x'))
    expect((await readFile(join(wsDir, WORKSPACE_MARKER), 'utf8')).trim()).toBe('/tmp/proj-x')
    expect((await readdir(wsDir)).some(n => n.endsWith('.md') && n !== 'MEMORY.md')).toBe(true)
    const globalMds = (await readdir(join(root, GLOBAL_DIR))).filter(n => n.endsWith('.md') && n !== 'MEMORY.md')
    expect(globalMds).toHaveLength(0)
  })

  it('workspace → global 也是移动：旧 workspace 目录文件消失', async () => {
    await mkdir(join(root, workspaceDirName('/tmp/proj-y')), { recursive: true })
    await writeFile(join(root, workspaceDirName('/tmp/proj-y'), WORKSPACE_MARKER), '/tmp/proj-y\n')
    await writeFile(join(root, workspaceDirName('/tmp/proj-y'), 'a.md'),
      encodeRecord(record({ id: 'mem_w', scope: 'workspace', workspacePath: '/tmp/proj-y' }), {}))
    const t = await load()
    expect((await t.locate('mem_w'))?.record).toBeDefined()
    await t.update('mem_w', r => ({ ...r, scope: 'global', workspacePath: undefined, updatedAt: 3 }))
    const wsDir = join(root, workspaceDirName('/tmp/proj-y'))
    const wsMds = (await readdir(wsDir)).filter(n => n.endsWith('.md') && n !== 'MEMORY.md')
    expect(wsMds).toHaveLength(0)
    const globalMds = (await readdir(join(root, GLOBAL_DIR))).filter(n => n.endsWith('.md') && n !== 'MEMORY.md')
    expect(globalMds).toHaveLength(1)
  })

  it('workspace → 另一个 workspace 也是移动', async () => {
    await mkdir(join(root, workspaceDirName('/tmp/proj-a')), { recursive: true })
    await writeFile(join(root, workspaceDirName('/tmp/proj-a'), WORKSPACE_MARKER), '/tmp/proj-a\n')
    await writeFile(join(root, workspaceDirName('/tmp/proj-a'), 'a.md'),
      encodeRecord(record({ id: 'mem_w', scope: 'workspace', workspacePath: '/tmp/proj-a' }), {}))
    const t = await load()
    await t.update('mem_w', r => ({ ...r, workspacePath: '/tmp/proj-b', updatedAt: 4 }))
    const oldDir = join(root, workspaceDirName('/tmp/proj-a'))
    const newDir = join(root, workspaceDirName('/tmp/proj-b'))
    expect((await readdir(oldDir)).filter(n => n.endsWith('.md') && n !== 'MEMORY.md')).toHaveLength(0)
    expect((await readdir(newDir)).filter(n => n.endsWith('.md') && n !== 'MEMORY.md')).toHaveLength(1)
  })

  it('改 name（slug 变）：旧文件消失、新文件名含新 slug、内容正确', async () => {
    await seedGlobal('a.md', record({ id: 'mem_a', name: '旧名' }))
    const t = await load()
    await t.update('mem_a', r => ({ ...r, name: '新名', updatedAt: 2 }))
    await expect(stat(join(root, GLOBAL_DIR, 'a.md'))).rejects.toThrow()  // 旧 slug 文件消失
    const mds = (await readdir(join(root, GLOBAL_DIR))).filter(n => n.endsWith('.md') && n !== 'MEMORY.md')
    expect(mds).toHaveLength(1)
    expect(mds[0]).toContain('新名')
    const raw = await readFile(join(root, GLOBAL_DIR, mds[0]), 'utf8')
    expect(raw).toContain('name: 新名')
  })

  it('name 变但 slug 不变（仅加空格）：文件不动', async () => {
    await seedGlobal('a.md', record({ id: 'mem_a', name: '包管理' }))
    const t = await load()
    await t.update('mem_a', r => ({ ...r, name: '包管理 ', updatedAt: 2 }))  // 尾随空格，slug 相同
    const mds = (await readdir(join(root, GLOBAL_DIR))).filter(n => n.endsWith('.md') && n !== 'MEMORY.md')
    expect(mds).toEqual(['a.md'])  // 文件名不折腾
  })

  it('仅大小写变化不触发重命名：大小写不敏感文件系统上新旧路径是同一文件，重命名会删掉刚写的自己', async () => {
    await seedGlobal('Mock-rule.md', record({ id: 'mem_a', name: 'Mock Rule' }))
    const t = await load()
    await t.update('mem_a', r => ({ ...r, name: 'mock rule', updatedAt: 2 }))
    const mds = (await readdir(join(root, GLOBAL_DIR))).filter(n => n.endsWith('.md') && n !== 'MEMORY.md')
    expect(mds).toHaveLength(1)                    // 文件仍在（丢数据回归钉子）
    const raw = await readFile(join(root, GLOBAL_DIR, mds[0]), 'utf8')
    expect(raw).toContain('name: mock rule')       // 内容已更新
    expect(((await t.locate('mem_a'))?.record)!.name).toBe('mock rule')
  })

  it('put 全新 id：建文件；slug 冲突缀 id 片段', async () => {
    const t = await load()
    await t.put('mem_1', record({ id: 'mem_1', name: '同名' }))
    await t.put('mem_2', record({ id: 'mem_2', name: '同名' }))
    const names = (await readdir(join(root, GLOBAL_DIR))).filter(n => n.endsWith('.md') && n !== 'MEMORY.md')
    expect(names).toHaveLength(2)
  })

  it('put 全新 id 后内存可读（冒烟）', async () => {
    const t = await load()
    await t.put('mem_r', record({ id: 'mem_r', content: '复活' }))
    expect(((await t.locate('mem_r'))?.record)!.content).toBe('复活')
  })

  it('真实恢复链：快照 → 物理删除（文件不在） → SnapshotStore.restore → 新实例重载仍可见', async () => {
    const t = await load()
    const rec = record({ id: 'mem_r', content: '删掉再复活' })
    await t.put('mem_r', rec)
    const snapshots = new SnapshotStore(new InMemoryKvTable<MemorySnapshot>())
    const snap = await snapshots.capture({ operation: 'manual', description: '恢复链测试', records: [rec] }, 10)
    await t.delete('mem_r')
    const mdFiles = async () => (await readdir(join(root, GLOBAL_DIR))).filter(n => n.endsWith('.md') && n !== 'MEMORY.md')
    expect(await mdFiles()).toHaveLength(0)
    const byId = new Map((await t.readScope([t.globalDir], { includeArchive: true })).records.map(r => [r.record.id, r.record]))
    const { restored } = await snapshots.restore(snap, undefined, r => t.put(r.id, r), byId, false)
    expect(restored).toEqual(['mem_r'])
    expect(await mdFiles()).toHaveLength(1)
    const reloaded = await load()
    expect(((await reloaded.locate('mem_r'))?.record)!.content).toBe('删掉再复活')
  })

  it('unknown extras 经 update 往返仍在文件里', async () => {
    await seedGlobal('a.md', record({ id: 'mem_a' }), { customField: '手加的' })
    const t = await load()
    await t.update('mem_a', r => ({ ...r, content: '改了', updatedAt: 2 }))
    expect(await readFile(join(root, GLOBAL_DIR, 'a.md'), 'utf8')).toContain('customField')
  })

  it('MEMORY.md 在写路径末尾再生且只列 active+stale', async () => {
    const t = await load()
    await t.put('mem_a', record({ id: 'mem_a', name: '活着' }))
    await t.put('mem_d', record({ id: 'mem_d', name: '已删', status: 'deleted' }))
    const idx = await readFile(join(root, GLOBAL_DIR, 'MEMORY.md'), 'utf8')
    expect(idx).toContain('mem_a')
    expect(idx).not.toContain('mem_d')
  })

  it('并发 update 串行化（进程内互斥）：两个并发自增最终计数为 2', async () => {
    await seedGlobal('a.md', record({ id: 'mem_a' }))
    const t = await load()
    await Promise.all([
      t.update('mem_a', r => ({ ...r, recallCount: r.recallCount + 1 })),
      t.update('mem_a', r => ({ ...r, recallCount: r.recallCount + 1 })),
    ])
    expect(((await t.locate('mem_a'))?.record)!.recallCount).toBe(2)
  })

  it('update 缺 key 抛 RecordNotFoundError（与 InMemoryTable 同一错误类）', async () => {
    const t = await load()
    const err = await captureRejection(t.update('ghost', r => r))
    expect(err).toBeInstanceOf(RecordNotFoundError)
    expect(err).toMatchObject({ id: 'ghost' })
  })

  it('delete：物理删文件 + sidecar 行 + map；返回是否存在', async () => {
    await seedGlobal('a.md', record({ id: 'mem_a' }))
    const t = await load()
    expect(await t.delete('mem_a')).toBe(true)
    expect((await t.locate('mem_a'))?.record).toBeUndefined()
    await expect(stat(join(root, GLOBAL_DIR, 'a.md'))).rejects.toThrow()
    expect(await t.delete('mem_a')).toBe(false)
  })

  it('status→deleted 触发保留期清扫钩子（未超期不删除文件，但走清扫流程不报错）', async () => {
    const t = await load()
    await t.put('mem_a', record({ id: 'mem_a' }))
    await expect(t.update('mem_a', r => ({ ...r, status: 'deleted', updatedAt: Date.now() }))).resolves.toBeDefined()
    expect(((await t.locate('mem_a'))?.record)!.status).toBe('deleted')
  })
})

describe('FileTable 保留名避让（评审 M4：APFS 大小写不敏感，memory.md 会与 MEMORY.md 相互覆盖）', () => {
  it('put 名为 memory 的记录：文件走 id 兜底名，索引再生后重载不丢、不进隔离区', async () => {
    const t = await load()
    await t.put('mem_rsv', record({ id: 'mem_rsv', name: 'memory' }))
    const files = await readdir(join(root, GLOBAL_DIR))
    expect(files).not.toContain('memory.md')
    expect(files).toContain(`memory-${'mem_rsv'.slice(-6)}.md`)

    const t2 = await load() // 全新实例：记录仍在、隔离区为空
    expect(((await t2.locate('mem_rsv'))?.record)!.name).toBe('memory')
    expect(await quarantined(t2)).toEqual([])
  })
})

describe('FileTable 撞名检查看得见磁盘（终审 I1：隔离文件不可被同 slug 写入静默覆盖）', () => {
  it('隔离中的坏文件与新写入同名：新记录走 id 兜底名，坏文件原样保留、重载后仍在隔离区', async () => {
    await mkdir(join(root, GLOBAL_DIR), { recursive: true })
    await writeFile(join(root, GLOBAL_DIR, 'pnpm.md'), '用户手写的一段没有 frontmatter 的内容\n', 'utf8')
    const t = await load()
    expect(await quarantined(t)).toHaveLength(1)

    await t.put('mem_new', record({ id: 'mem_new', name: 'pnpm' }))
    // 用户手写内容必须原样保留
    expect(await readFile(join(root, GLOBAL_DIR, 'pnpm.md'), 'utf8')).toContain('用户手写')
    const files = await readdir(join(root, GLOBAL_DIR))
    expect(files).toContain(`pnpm-${'mem_new'.slice(-6)}.md`)

    const t2 = await load() // 新实例：新记录在、坏文件仍被隔离（malformed finding 不消失）
    expect(((await t2.locate('mem_new'))?.record)!.name).toBe('pnpm')
    expect(await quarantined(t2)).toHaveLength(1)
  })
})

describe('票 10：写路径内核（锁内定位、排他占名、搬家与归档）', () => {
  const mds = async (dir: string) => (await readdir(dir).catch(() => [] as string[])).filter(n => n.endsWith('.md') && n !== 'MEMORY.md').sort()
  const tmps = async (dir: string) => (await readdir(dir).catch(() => [] as string[])).filter(n => n.includes('.tmp-'))
  const globalDir = () => join(root, GLOBAL_DIR)
  const WS = '/tmp/proj-k'
  const wsDir = () => join(root, workspaceDirName(WS))
  const wsRecord = (partial: Partial<MemoryRecord> = {}) => record({ scope: 'workspace', workspacePath: WS, ...partial })

  it('create 不定位：排他创建占名，被别的 id 占着就追加 id 片段，再撞走全 id 名；已有文件一字不动', async () => {
    await seedGlobal('同名.md', record({ id: 'mem_other1', name: '同名', content: '别人的 ①' }))
    await seedGlobal(`同名-${'mem_new'.slice(-6)}.md`, record({ id: 'mem_other2', name: '同名', content: '别人的 ②' }))
    const t = await load()
    await t.create(record({ id: 'mem_new', name: '同名', content: '新来的' }))
    expect(await mds(globalDir())).toEqual(['同名-mem_new.md', `同名-${'mem_new'.slice(-6)}.md`, '同名.md'].sort())
    expect(await readFile(join(globalDir(), '同名.md'), 'utf8')).toContain('别人的 ①')
    expect(await readFile(join(globalDir(), `同名-${'mem_new'.slice(-6)}.md`), 'utf8')).toContain('别人的 ②')
    expect(await readFile(join(globalDir(), '同名-mem_new.md'), 'utf8')).toContain('新来的')
    expect(await tmps(globalDir())).toEqual([])
  })

  it('create 之后 locate 能按 id 找到，内容逐字段相等', async () => {
    const t = await load()
    const r = wsRecord({ id: 'mem_cr', name: '新建', content: '新建正文', updatedAt: 5 })
    await t.create(r)
    expect((await t.locate('mem_cr', { workspacePath: WS }))!.record).toEqual(r)
    expect((await readFile(join(wsDir(), WORKSPACE_MARKER), 'utf8')).trim()).toBe(WS)   // workspace 目录不存在则 mkdir + 写标记
  })

  it('rename 只允许覆盖同一记录自己的文件：改 slug 撞上别的记录的文件名时走 id 片段名，别人的文件不动', async () => {
    await seedGlobal('a.md', record({ id: 'mem_a', name: 'A', content: '我是 A' }))
    await seedGlobal('b.md', record({ id: 'mem_b', name: 'b', content: '我是 B' }))
    const t = await load()
    await t.update('mem_a', r => ({ ...r, name: 'b', updatedAt: 2 }))
    expect(await mds(globalDir())).toEqual([`b-${'mem_a'.slice(-6)}.md`, 'b.md'].sort())
    expect(await readFile(join(globalDir(), 'b.md'), 'utf8')).toContain('我是 B')
    expect(await readFile(join(globalDir(), `b-${'mem_a'.slice(-6)}.md`), 'utf8')).toContain('我是 A')
  })

  it('status→deleted：文件移入同目录 .archive/、顶层消失、补 deletedAt（取 now）、MEMORY.md 不再列它', async () => {
    const NOW = 1_800_000_000_000
    const t = new FileTable({ root, stats: new InMemoryKvTable<RecallStats>(), now: () => NOW })
    await t.create(record({ id: 'mem_a', name: '活着', updatedAt: NOW - 10 }))
    await t.create(record({ id: 'mem_d', name: '要删', updatedAt: NOW - 10 }))
    const next = await t.update('mem_d', r => ({ ...r, status: 'deleted', updatedAt: NOW }))
    expect(next.deletedAt).toBe(NOW)
    expect(await mds(globalDir())).toEqual(['活着.md'])
    expect(await mds(join(globalDir(), ARCHIVE_DIR))).toEqual(['要删.md'])
    expect(await readFile(join(globalDir(), ARCHIVE_DIR, '要删.md'), 'utf8')).toContain('deletedAt:')
    const idx = await readFile(join(globalDir(), 'MEMORY.md'), 'utf8')
    expect(idx).toContain('mem_a')
    expect(idx).not.toContain('mem_d')
    expect((await t.locate('mem_d'))!.record.deletedAt).toBe(NOW)
  })

  it('归档时 .archive/ 已有同名异 id 文件：追加 id 片段，两份都保留', async () => {
    await mkdir(join(globalDir(), ARCHIVE_DIR), { recursive: true })
    const NOW = Date.now()   // 归档里的 deleted 要落在保留窗口内，否则维护点先把它清掉、撞名就不成立
    await writeFile(join(globalDir(), ARCHIVE_DIR, '同名.md'),
      encodeRecord(record({ id: 'mem_old', name: '同名', status: 'deleted', content: '早先归档的', updatedAt: NOW, deletedAt: NOW }), {}))
    const t = await load()
    await t.create(record({ id: 'mem_cur', name: '同名', content: '后来归档的' }))
    await t.update('mem_cur', r => ({ ...r, status: 'superseded', updatedAt: Date.now() }))
    expect(await mds(globalDir())).toEqual([])
    expect(await mds(join(globalDir(), ARCHIVE_DIR))).toEqual([`同名-${'mem_cur'.slice(-6)}.md`, '同名.md'].sort())
    expect(await readFile(join(globalDir(), ARCHIVE_DIR, '同名.md'), 'utf8')).toContain('早先归档的')
    expect((await t.locate('mem_old'))!.record.content).toBe('早先归档的')
    expect((await t.locate('mem_cur'))!.record.content).toBe('后来归档的')
  })

  it('回到 active（restore）：从 .archive/ 搬回顶层并占名，.archive/ 里的文件消失', async () => {
    const t = await load()
    const r = record({ id: 'mem_r', name: '复活', content: '复活正文', updatedAt: 10 })
    await t.create(r)
    await t.update('mem_r', c => ({ ...c, status: 'deleted', updatedAt: Date.now() }))
    expect(await mds(globalDir())).toEqual([])
    await t.put('mem_r', r)   // 快照恢复：整条旧记录 put 回来
    expect(await mds(globalDir())).toEqual(['复活.md'])
    expect(await mds(join(globalDir(), ARCHIVE_DIR))).toEqual([])
    expect((await t.locate('mem_r'))!.record).toEqual(r)
  })

  it('delete 物理删除 .archive/ 里的文件（供 S1 使用）', async () => {
    const t = await load()
    await t.create(record({ id: 'mem_s', name: '密钥' }))
    await t.update('mem_s', r => ({ ...r, status: 'deleted', updatedAt: Date.now() }))
    expect(await mds(join(globalDir(), ARCHIVE_DIR))).toEqual(['密钥.md'])
    expect(await t.delete('mem_s')).toBe(true)
    expect(await mds(join(globalDir(), ARCHIVE_DIR))).toEqual([])
    expect(await t.locate('mem_s')).toBeUndefined()
  })

  it('顶层 deleted 文件搬进 .archive/ 后 listWorkspaceDirs 的 hasActiveTopLevel 自然收敛（票 09 转来）', async () => {
    const t = await load()
    await t.create(wsRecord({ id: 'mem_only', name: '唯一' }))
    expect((await t.listWorkspaceDirs()).entries).toEqual([{ workspacePath: WS, dir: wsDir(), hasActiveTopLevel: true }])
    await t.update('mem_only', r => ({ ...r, status: 'deleted', updatedAt: Date.now() }))
    expect((await t.listWorkspaceDirs()).entries).toEqual([{ workspacePath: WS, dir: wsDir(), hasActiveTopLevel: false }])
  })

  it('同进程并发：两个会话对象 Promise.all 同时 save 与 forget，结束后文件齐全、无 tmp 残留', async () => {
    const t = await load()
    const store = new MemoryStore(t)
    const snapshots = new SnapshotStore(new InMemoryKvTable<MemorySnapshot>())
    const decisions = new PendingDecisionsStore(new InMemoryKvTable<PendingDecision>())
    const registry = buildTypeRegistry({ template: 'coding', customTypes: {} })
    const victim = wsRecord({ id: 'mem_victim', name: '待遗忘', content: '会被遗忘' })
    await t.create(victim)
    const saveDeps = (id: string) => ({ store, registry, workspacePath: WS, session: { id, lastSeq: 3 } })
    const save = (sessionId: string, i: number) => runSavePipeline({
      action: 'create', name: `并发-${sessionId}`, type: 'knowledge', scope: 'workspace',
      content: `会话 ${sessionId} 第 ${i} 条`, summary: `${sessionId}-${i}`, tags: [], sourceMode: 'user-explicit', force: true,
    }, saveDeps(sessionId))
    const results = await Promise.all([
      save('s1', 1), save('s2', 1),
      executeForget({ ids: [victim.id], reason: '并发测试' }, { workspacePath: WS }, { store, snapshots, decisions }),
      save('s1', 2), save('s2', 2),
    ])
    const saved = results.filter((r): r is Extract<typeof r, { kind: 'saved' }> => 'kind' in r && r.kind === 'saved')
    expect(saved).toHaveLength(4)
    expect((results[2] as Awaited<ReturnType<typeof executeForget>>).forgotten).toEqual([victim.id])
    expect(await mds(wsDir())).toHaveLength(4)                               // 四条新记忆各占一个文件
    expect(await mds(join(wsDir(), ARCHIVE_DIR))).toEqual(['待遗忘.md'])        // 被遗忘的进了归档
    expect(await tmps(wsDir())).toEqual([])
    expect(await tmps(join(wsDir(), ARCHIVE_DIR))).toEqual([])
    for (const s of saved) expect((await t.locate(s.record.id, { workspacePath: WS }))!.record.content).toBe(s.record.content)
    const idx = await readFile(join(wsDir(), 'MEMORY.md'), 'utf8')
    for (const s of saved) expect(idx).toContain(s.record.id)
    expect(idx).not.toContain(victim.id)
  })

  it('promote 到 global 后旧 workspace 文件消失、新实例只看到 global 那份；pre-promote 快照 restore 后 global 消失、workspace 回来（无双文件）', async () => {
    const t = await load()
    const store = new MemoryStore(t)
    const snapshots = new SnapshotStore(new InMemoryKvTable<MemorySnapshot>())
    const r = wsRecord({ id: 'mem_p', name: '提升', content: '要提升的', globalCandidate: true, updatedAt: 100 })
    await t.create(r)
    const promoted = await executePromote({ confirmedIds: ['mem_p'], target: 'global' }, { workspacePath: WS }, {
      store, snapshots, agentsMd: { append: async () => {} }, now: () => 200,
    })
    expect(promoted.promoted).toEqual([{ id: 'mem_p', target: 'global' }])
    expect(await mds(wsDir())).toEqual([])
    expect(await mds(globalDir())).toEqual(['提升.md'])
    const fresh = await load()
    expect((await fresh.readScope([fresh.globalDir, wsDir()], { includeArchive: true })).records.map(x => [x.record.id, x.record.scope]))
      .toEqual([['mem_p', 'global']])

    const snap = (await snapshots.list()).find(s => s.operation === 'pre-promote')!
    const current = new Map([['mem_p', (await store.get('mem_p'))!]])
    const { restored } = await snapshots.restore(snap, undefined, rec => store.put(rec), current, false)
    expect(restored).toEqual(['mem_p'])
    expect(await mds(globalDir())).toEqual([])
    expect(await mds(wsDir())).toEqual(['提升.md'])
    const again = await load()
    expect((await again.readScope([again.globalDir, wsDir()], { includeArchive: true })).records.map(x => [x.record.id, x.record.scope]))
      .toEqual([['mem_p', 'workspace']])
    expect((await again.locate('mem_p'))!.record).toEqual(r)
  })
})

describe('写路径与外部编辑交错', () => {
  it('写 A 期间外部改了 B：之后读 B 看到外部编辑，再写 B 也不会把旧 B 写回磁盘（锁内重读）', async () => {
    await seedGlobal('a.md', record({ id: 'mem_a', name: 'A' }))
    await seedGlobal('b.md', record({ id: 'mem_b', name: 'B', content: '旧 B' }))
    const externalB = '外部改过的 B，长度和原来不一样'
    // 用子类在 A 的原子写之前安排 B 的外部编辑，确定性地制造"写 A 与改 B 交错"。
    class Interleaved extends FileTable {
      armed = false
      protected override async atomicWrite(filePath: string, text: string): Promise<void> {
        if (this.armed && filePath.endsWith('a.md')) {
          this.armed = false
          await writeFile(join(root, GLOBAL_DIR, 'b.md'), encodeRecord(record({ id: 'mem_b', name: 'B', content: externalB }), {}))
        }
        return super.atomicWrite(filePath, text)
      }
    }
    const t = new Interleaved({ root, stats: new InMemoryKvTable<RecallStats>() })
    t.armed = true
    await t.update('mem_a', r => ({ ...r, content: '改 A', updatedAt: 2 }))
    expect(((await t.locate('mem_b'))?.record)!.content).toBe(externalB)
    await t.update('mem_b', r => ({ ...r, lastConfirmedAt: 99 }))
    expect(await readFile(join(root, GLOBAL_DIR, 'b.md'), 'utf8')).toContain(externalB)
  })
})
