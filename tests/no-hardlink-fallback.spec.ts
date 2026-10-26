import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat, link } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileTable } from '../src/storage/file-table.ts'
import { encodeRecord } from '../src/storage/frontmatter.ts'
import { GLOBAL_DIR } from '../src/storage/paths.ts'
import { SidecarStore, STATE_DIR, KV_IMPORT_MARKER } from '../src/storage/sidecar.ts'
import { InMemoryKvTable } from '../src/kv-table.ts'
import { memorySnapshotSchema, pendingDecisionSchema, scanCacheSchema, adviceIgnoreSchema, type MemorySnapshot } from '../src/governance/schema.ts'
import type { RecallStats } from '../src/storage/schema.ts'
import { record } from './helpers/record.ts'

// 文件系统是进程边界：只把 link 换成可控的桩，其余 fs 函数保持真实。
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, link: vi.fn(actual.link) }
})

/** exFAT/FAT、部分网络盘与 FUSE 挂载上 link 的报错形态。 */
function fsError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: operation failed, link`), { code })
}

const schemas = { snapshots: memorySnapshotSchema, pending: pendingDecisionSchema, scanCache: scanCacheSchema, adviceIgnores: adviceIgnoreSchema }
const snap = (id: string, description = id): MemorySnapshot =>
  ({ id, createdAt: 1, operation: 'manual', description, memoryIds: [], data: [] })

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'pm-nolink-')) })
afterEach(async () => {
  vi.mocked(link).mockReset()
  await rm(root, { recursive: true, force: true })
})

const globalDir = () => join(root, GLOBAL_DIR)
const stateDir = () => join(root, STATE_DIR)
const tmps = async (dir: string) => (await readdir(dir).catch(() => [] as string[])).filter(n => n.includes('.tmp-'))
const newTable = () => new FileTable({ root, stats: new InMemoryKvTable<RecallStats>() })

describe.each(['ENOTSUP', 'EPERM', 'ENOSYS'])('不支持硬链接的卷（link 报 %s）', code => {
  beforeEach(() => { vi.mocked(link).mockRejectedValue(fsError(code)) })

  it('FileTable 新建记忆成功，文件可读回，不留 tmp', async () => {
    const r = record({ id: 'mem_new', name: '新建', content: '新建正文' })
    await newTable().create(r)
    expect(await readFile(join(globalDir(), '新建.md'), 'utf8')).toContain('新建正文')
    expect((await newTable().locate('mem_new'))!.record).toEqual(r)
    expect(await tmps(globalDir())).toEqual([])
    expect(vi.mocked(link)).toHaveBeenCalled()
  })

  it('FileTable 撞名仍追加 id 片段，已有文件一字不动', async () => {
    await mkdir(globalDir(), { recursive: true })
    const other = encodeRecord(record({ id: 'mem_other', name: '同名', content: '别人的' }), {})
    await writeFile(join(globalDir(), '同名.md'), other, 'utf8')
    await newTable().create(record({ id: 'mem_new', name: '同名', content: '新来的' }))
    expect(await readFile(join(globalDir(), '同名.md'), 'utf8')).toBe(other)
    expect(await readFile(join(globalDir(), `同名-${'mem_new'.slice(-6)}.md`), 'utf8')).toContain('新来的')
    expect(await tmps(globalDir())).toEqual([])
  })

  it('SidecarStore 的 KV 导入成功，已存在的条目不被覆盖', async () => {
    await mkdir(join(stateDir(), 'snapshots'), { recursive: true })
    await writeFile(join(stateDir(), 'snapshots', 'snap_a.json'), JSON.stringify(snap('snap_a', '迁移后改过')), 'utf8')
    const s = new SidecarStore({
      root, schemas,
      openLegacyKv: async () => ({ snapshots: [['snap_a', snap('snap_a', 'KV 里的旧值')], ['snap_b', snap('snap_b')]], pending: [], discard: async () => {} }),
    })
    expect((await s.snapshots.get('snap_a'))?.description).toBe('迁移后改过')
    expect((await s.snapshots.get('snap_b'))?.id).toBe('snap_b')
    expect(JSON.parse(await readFile(join(stateDir(), KV_IMPORT_MARKER), 'utf8')).source).toBe('kv')
    expect(await tmps(join(stateDir(), 'snapshots'))).toEqual([])
  })
})

describe('link 的其他错误照常抛出', () => {
  beforeEach(() => { vi.mocked(link).mockRejectedValue(fsError('EACCES')) })

  it('FileTable 新建遇到 EACCES 失败，不回退成复制', async () => {
    await expect(newTable().create(record({ id: 'mem_new', name: '新建' }))).rejects.toMatchObject({ code: 'EACCES' })
    await expect(stat(join(globalDir(), '新建.md'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await tmps(globalDir())).toEqual([])
  })

  it('SidecarStore 导入遇到 EACCES 失败：记日志、不写标记、条目不落盘', async () => {
    const warns: string[] = []
    const s = new SidecarStore({
      root, schemas,
      log: { info() {}, warn: (m: string) => { warns.push(m) }, error() {} },
      openLegacyKv: async () => ({ snapshots: [['snap_a', snap('snap_a')]], pending: [], discard: async () => {} }),
    })
    expect(await s.snapshots.list()).toEqual([])
    expect(warns.some(w => w.includes('EACCES'))).toBe(true)
    await expect(stat(join(stateDir(), KV_IMPORT_MARKER))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
