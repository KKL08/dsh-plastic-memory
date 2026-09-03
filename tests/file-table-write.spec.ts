import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileTable } from '../src/storage/file-table.ts'
import { encodeRecord } from '../src/storage/frontmatter.ts'
import { workspaceDirName, WORKSPACE_MARKER, GLOBAL_DIR } from '../src/storage/paths.ts'
import { InMemoryKvTable } from '../src/kv-table.ts'
import type { RecallStats } from '../src/storage/schema.ts'
import type { MemoryRecord } from '../src/record-schema.ts'
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
  const t = new FileTable({ root, stats: new InMemoryKvTable<RecallStats>() })
  await t.load()
  return t
}

describe('FileTable 写侧', () => {
  it('markRecalled 型更新（只动易变字段）不触碰文件——mtime 不变', async () => {
    await seedGlobal('a.md', record({ id: 'mem_a' }))
    const t = await load()
    const before = (await stat(join(root, GLOBAL_DIR, 'a.md'))).mtimeMs
    await t.update('mem_a', r => ({ ...r, recallCount: r.recallCount + 1, lastRecalledAt: 123 }))
    const after = (await stat(join(root, GLOBAL_DIR, 'a.md'))).mtimeMs
    expect(after).toBe(before)                       // §4 核心命题
    expect(t.get('mem_a')!.recallCount).toBe(1)      // 内存与 sidecar 已更新
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
    expect(t.get('mem_w')).toBeDefined()
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
    expect(t.get('mem_a')!.name).toBe('mock rule')
  })

  it('put 全新 id：建文件；slug 冲突缀 id 片段', async () => {
    const t = await load()
    await t.put('mem_1', record({ id: 'mem_1', name: '同名' }))
    await t.put('mem_2', record({ id: 'mem_2', name: '同名' }))
    const names = (await readdir(join(root, GLOBAL_DIR))).filter(n => n.endsWith('.md') && n !== 'MEMORY.md')
    expect(names).toHaveLength(2)
  })

  it('物理清理后 restore（put 到已无文件的 id）重建文件', async () => {
    const t = await load()
    await t.put('mem_r', record({ id: 'mem_r', content: '复活' }))
    expect(t.get('mem_r')!.content).toBe('复活')
  })

  it('unknown extras 经 update 往返仍在文件里', async () => {
    await seedGlobal('a.md', record({ id: 'mem_a' }), { customField: '手加的' })
    const t = await load()
    await t.update('mem_a', r => ({ ...r, content: '改了', updatedAt: 2 }))
    expect(await readFile(join(root, GLOBAL_DIR, 'a.md'), 'utf8')).toContain('customField')
  })

  it('自写后指纹已刷新：refreshIfChanged 不触发假重载', async () => {
    const t = await load()
    await t.put('mem_x', record({ id: 'mem_x' }))
    const spy = vi.spyOn(t as unknown as { loadInner: () => Promise<void> }, 'loadInner')
    await t.refreshIfChanged()
    expect(spy).not.toHaveBeenCalled()
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
    expect(t.get('mem_a')!.recallCount).toBe(2)
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
    expect(t.get('mem_a')).toBeUndefined()
    await expect(stat(join(root, GLOBAL_DIR, 'a.md'))).rejects.toThrow()
    expect(await t.delete('mem_a')).toBe(false)
  })

  it('status→deleted 触发保留期清扫钩子（未超期不删除文件，但走清扫流程不报错）', async () => {
    const t = await load()
    await t.put('mem_a', record({ id: 'mem_a' }))
    await expect(t.update('mem_a', r => ({ ...r, status: 'deleted', updatedAt: Date.now() }))).resolves.toBeDefined()
    expect(t.get('mem_a')!.status).toBe('deleted')
  })
})

describe('FileTable 保留名避让（评审 M4：APFS 大小写不敏感，memory.md 会与 MEMORY.md 相互覆盖）', () => {
  it('put 名为 memory 的记录：文件走 id 兜底名，索引再生后重载不丢、不进隔离区', async () => {
    const t = await load()
    await t.put('mem_rsv', record({ id: 'mem_rsv', name: 'memory' }))
    const files = await readdir(join(root, GLOBAL_DIR))
    expect(files).not.toContain('memory.md')
    expect(files).toContain(`memory-${'mem_rsv'.slice(-6)}.md`)

    const t2 = await load() // 全新实例重载：记录仍在、隔离区为空
    expect(t2.get('mem_rsv')!.name).toBe('memory')
    expect(t2.quarantined()).toEqual([])
  })
})

describe('FileTable 撞名检查看得见磁盘（终审 I1：隔离文件不可被同 slug 写入静默覆盖）', () => {
  it('隔离中的坏文件与新写入同名：新记录走 id 兜底名，坏文件原样保留、重载后仍在隔离区', async () => {
    await mkdir(join(root, GLOBAL_DIR), { recursive: true })
    await writeFile(join(root, GLOBAL_DIR, 'pnpm.md'), '用户手写的一段没有 frontmatter 的内容\n', 'utf8')
    const t = await load()
    expect(t.quarantined()).toHaveLength(1)

    await t.put('mem_new', record({ id: 'mem_new', name: 'pnpm' }))
    // 用户手写内容必须原样保留
    expect(await readFile(join(root, GLOBAL_DIR, 'pnpm.md'), 'utf8')).toContain('用户手写')
    const files = await readdir(join(root, GLOBAL_DIR))
    expect(files).toContain(`pnpm-${'mem_new'.slice(-6)}.md`)

    const t2 = await load() // 重载：新记录在、坏文件仍被隔离（malformed finding 不消失）
    expect(t2.get('mem_new')!.name).toBe('pnpm')
    expect(t2.quarantined()).toHaveLength(1)
  })
})
