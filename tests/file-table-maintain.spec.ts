import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { FileTable, DELETED_RETENTION_MS } from '../src/storage/file-table.ts'
import { SidecarStore } from '../src/storage/sidecar.ts'
import { computeDigest, encodeRecord, splitFrontmatter } from '../src/storage/frontmatter.ts'
import { ARCHIVE_DIR, GLOBAL_DIR, INDEX_FILE, STATE_DIR, WORKSPACE_MARKER, deriveFileId, workspaceDirName } from '../src/storage/paths.ts'
import { InMemoryKvTable } from '../src/kv-table.ts'
import { MemoryStore } from '../src/store.ts'
import { SnapshotCache } from '../src/runtime.ts'
import { executeHealth } from '../src/tools/health.ts'
import { prereadLayers } from '../src/tools/layer-preread.ts'
import { crossLayerConflicts } from '../src/governance/layer-health.ts'
import { PendingDecisionsStore } from '../src/governance/decisions.ts'
import { memorySnapshotSchema, pendingDecisionSchema, scanCacheSchema } from '../src/governance/schema.ts'
import { resolveHealthThresholds } from '../src/governance/health-presets.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'
import type { RecallStats } from '../src/storage/schema.ts'
import type { MemoryRecord } from '../src/record-schema.ts'
import { record as baseRecord } from './helpers/record.ts'
import { fakeExec } from './helpers/exec.ts'
import { formatIndexLine } from '../src/index-line.ts'

// 票 11：维护点（docs/design-storage-file-is-memory.md §5）。只测 FileTable 专属的磁盘效应；
// 双后端一致的语义在 table-conformance.spec.ts。全部用真实目录，不 mock 自己的模块。

const DAY = 86_400_000
const WS = '/home/dev/proj-m'
const OTHER = '/home/dev/proj-o'
const registry = buildTypeRegistry({ template: 'coding', customTypes: {} })

const record = (partial: Partial<MemoryRecord> = {}) => baseRecord({
  type: 'preference', createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000, lastConfirmedAt: 1_700_000_000_000, ...partial,
})
const wsRecord = (partial: Partial<MemoryRecord> = {}, ws = WS) => record({ scope: 'workspace', workspacePath: ws, ...partial })

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'pm-maint-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

const globalDir = () => join(root, GLOBAL_DIR)
const wsDir = (p = WS) => join(root, workspaceDirName(p))
const archiveOf = (dir: string) => join(dir, ARCHIVE_DIR)

async function ensureDir(dir: string, ws?: string) {
  await mkdir(dir, { recursive: true })
  if (ws !== undefined) await writeFile(join(dir, WORKSPACE_MARKER), ws + '\n')
}
async function writeRaw(dir: string, fileName: string, text: string, ws?: string): Promise<string> {
  await ensureDir(dir, ws)
  const path = join(dir, fileName)
  await writeFile(path, text)
  return path
}
const writeMem = (dir: string, fileName: string, r: MemoryRecord, ws?: string) => writeRaw(dir, fileName, encodeRecord(r, {}), ws)
/** 把文件 mtime 拨到指定时刻（手编时间的来源），返回文件系统实际记下的 mtime（精度随文件系统）。 */
async function touch(path: string, atMs: number): Promise<number> {
  await utimes(path, atMs / 1000, atMs / 1000)
  return (await stat(path)).mtimeMs
}
/** 写出的时间戳形态：UTC 毫秒 ISO（Date 把 mtime 的小数毫秒截掉）。 */
const iso = (ms: number) => new Date(ms).toISOString()

const mds = async (dir: string) => (await readdir(dir).catch(() => [] as string[])).filter(n => n.endsWith('.md') && n !== INDEX_FILE).sort()
const frontmatter = async (path: string) => splitFrontmatter(await readFile(path, 'utf8')).data

/** 递归快照：相对路径 → mtime（目录与文件都计）；.state/ 不计。 */
async function treeSnapshot(dir: string, prefix = ''): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix + entry.name
    if (rel === STATE_DIR) continue
    out[rel] = (await stat(join(dir, entry.name))).mtimeMs
    if (entry.isDirectory()) Object.assign(out, await treeSnapshot(join(dir, entry.name), `${rel}/`))
  }
  return out
}

function open(opts: Partial<ConstructorParameters<typeof FileTable>[0]> = {}) {
  const stats = new InMemoryKvTable<RecallStats>()
  return { table: new FileTable({ root, stats, ...opts }), stats }
}

describe('维护点动作 ①：再生 MEMORY.md', () => {
  it('只列顶层 active 且未过期的记录，按 name 再 id 排序；内容不变不写（mtime 不变）', async () => {
    const now = Date.now()
    await writeMem(globalDir(), 'b.md', record({ id: 'mem_b', name: 'beta' }))
    await writeMem(globalDir(), 'a2.md', record({ id: 'mem_a2', name: 'alpha' }))
    await writeMem(globalDir(), 'a1.md', record({ id: 'mem_a1', name: 'alpha' }))
    await writeMem(globalDir(), 'exp.md', record({ id: 'mem_exp', name: '过期', validTo: now - DAY }))
    await writeMem(archiveOf(globalDir()), 'arch.md', record({ id: 'mem_arch', name: '归档', status: 'deleted', deletedAt: now }))
    const { table } = open()
    await table.maintain([globalDir()])
    const idx = await readFile(join(globalDir(), INDEX_FILE), 'utf8')
    const ids = [...idx.matchAll(/\[(mem_\w+)\]/g)].map(m => m[1])
    expect(ids).toEqual(['mem_a1', 'mem_a2', 'mem_b'])
    const mtime = (await stat(join(globalDir(), INDEX_FILE))).mtimeMs
    await new Promise(r => setTimeout(r, 5))
    await table.maintain([globalDir()])
    expect((await stat(join(globalDir(), INDEX_FILE))).mtimeMs).toBe(mtime)
  })
})

describe('MEMORY.md 行与注入索引行末尾带文件名（同源格式，passive 不带 summary；磁盘侧不带陈旧度，注入侧带）', () => {
  it('MEMORY.md 行以 · 磁盘上的实际文件名收尾；超过衰减期也不带陈旧度', async () => {
    // project 衰减 7 天，lastConfirmedAt 远在过去；手起的文件名与 slug(name) 不同，索引照实写磁盘文件名
    const r = record({ id: 'mem_gw', name: '网关路由表', type: 'project', summary: '路由表', tags: ['gateway'] })
    await writeMem(globalDir(), '网关路由表-手写.md', r)
    const { table } = open()
    await table.maintain([globalDir()])
    const idx = await readFile(join(globalDir(), INDEX_FILE), 'utf8')
    const line = idx.split('\n').find(l => l.includes('[mem_gw]'))!
    expect(line).toBe(formatIndexLine(r, { passive: false, file: '网关路由表-手写.md' }))
    expect(line).toBe('- [mem_gw] 网关路由表（路由表） — gateway · 网关路由表-手写.md')
    expect(line).not.toContain('未确认')
  })
})

describe('维护点动作 ②：顶层非 active 文件搬 .archive/', () => {
  it('手改成 deleted 的文件搬进 .archive/，缺 deletedAt 用文件 mtime 补；superseded 同样搬但不补 deletedAt', async () => {
    const del = await writeMem(globalDir(), 'del.md', record({ id: 'mem_del', name: 'del', status: 'deleted' }))
    const edited = await touch(del, Date.now() - 2 * DAY)
    await writeMem(globalDir(), 'sup.md', record({ id: 'mem_sup', name: 'sup', status: 'superseded' }))
    await writeMem(globalDir(), 'live.md', record({ id: 'mem_live', name: 'live' }))
    const { table } = open()
    await table.maintain([globalDir()])
    expect(await mds(globalDir())).toEqual(['live.md'])
    expect(await mds(archiveOf(globalDir()))).toEqual(['del.md', 'sup.md'])
    const delFm = await frontmatter(join(archiveOf(globalDir()), 'del.md'))
    expect(delFm.deletedAt).toBe(iso(edited))
    expect(await frontmatter(join(archiveOf(globalDir()), 'sup.md'))).not.toHaveProperty('deletedAt')
    expect((await table.locate('mem_del'))!.record.deletedAt).toBe(Date.parse(iso(edited)))
  })

  it('.archive/ 里已有同名异 id 文件：追加 id 片段，两份都保留', async () => {
    const now = Date.now()
    await writeMem(archiveOf(globalDir()), '同名.md', record({ id: 'mem_old', name: '同名', content: '早先归档的', status: 'deleted', deletedAt: now }))
    await writeMem(globalDir(), '同名.md', record({ id: 'mem_new', name: '同名', content: '后来手改的', status: 'superseded' }))
    const { table } = open()
    await table.maintain([globalDir()])
    expect(await mds(globalDir())).toEqual([])
    expect(await mds(archiveOf(globalDir()))).toEqual([`同名-${'mem_new'.slice(-6)}.md`, '同名.md'].sort())
    expect(await readFile(join(archiveOf(globalDir()), '同名.md'), 'utf8')).toContain('早先归档的')
    expect((await table.locate('mem_new'))!.record.content).toBe('后来手改的')
  })
})

describe('维护点动作 ③：.archive/ 里 deletedAt 超 14 天的物理删除', () => {
  it('判据是 deletedAt 不是 updatedAt：deletedAt 超期删并清召回统计行；updatedAt 很旧但 deletedAt 新的保留；superseded 不清', async () => {
    const now = Date.now()
    const old = now - DELETED_RETENTION_MS - DAY
    await writeMem(archiveOf(globalDir()), 'gone.md', record({ id: 'mem_gone', status: 'deleted', updatedAt: now, deletedAt: old }))
    await writeMem(archiveOf(globalDir()), 'fresh.md', record({ id: 'mem_fresh', status: 'deleted', updatedAt: old - 100 * DAY, deletedAt: now - DAY }))
    await writeMem(archiveOf(globalDir()), 'sup.md', record({ id: 'mem_sup', status: 'superseded', updatedAt: old - 100 * DAY }))
    const { table, stats } = open()
    await stats.put('mem_gone', { id: 'mem_gone', recallCount: 3, lastRecalledAt: now })
    await stats.put('mem_fresh', { id: 'mem_fresh', recallCount: 1, lastRecalledAt: now })
    await table.maintain([globalDir()])
    expect(await mds(archiveOf(globalDir()))).toEqual(['fresh.md', 'sup.md'])
    expect(await stats.get('mem_gone')).toBeUndefined()
    expect(await stats.get('mem_fresh')).toMatchObject({ recallCount: 1 })
  })

  it('过期清除时别层还有同 id 的在用副本：只删过期文件，召回统计行按 id 一行，留给在用那份', async () => {
    const now = Date.now()
    await writeMem(globalDir(), 'live.md', record({ id: 'mem_dup', name: '全局那份' }))
    await ensureDir(wsDir(), WS)
    await writeMem(archiveOf(wsDir()), 'old.md', wsRecord({ id: 'mem_dup', name: '项目那份', status: 'deleted', deletedAt: now - DELETED_RETENTION_MS - DAY }))
    const { table, stats } = open()
    await stats.put('mem_dup', { id: 'mem_dup', recallCount: 3, lastRecalledAt: now })
    await table.maintain([wsDir()])
    expect(await mds(archiveOf(wsDir()))).toEqual([])
    expect(await mds(globalDir())).toEqual(['live.md'])
    expect(await stats.get('mem_dup')).toMatchObject({ recallCount: 3 })
  })

  it('顶层的 deleted 文件不直接清：先搬进 .archive/（deletedAt 取 mtime），下次维护才按 deletedAt 计窗口', async () => {
    const now = Date.now()
    const path = await writeMem(globalDir(), 'top.md', record({ id: 'mem_top', status: 'deleted', updatedAt: now - 100 * DAY }))
    await touch(path, now - DELETED_RETENTION_MS - DAY)
    const { table } = open()
    await table.maintain([globalDir()])
    expect(await mds(globalDir())).toEqual([])
    expect(await mds(archiveOf(globalDir()))).toEqual(['top.md'])   // 本轮只搬家
    await table.maintain([globalDir()])
    expect(await mds(archiveOf(globalDir()))).toEqual([])            // mtime 补的 deletedAt 已超窗
  })
})

describe('维护点动作 ④：手建 / 手编文件回写', () => {
  it('缺 id 补派生 id、缺 digest 只补基线不标手编、时间戳归一、缺省字段补齐；第二次维护零写入', async () => {
    const path = await writeRaw(wsDir(), 'hand.md', '---\nname: 手建\ntype: preference\ncreatedAt: 2026-07-01\n---\n\n手写正文\n', WS)
    const derived = deriveFileId(relative(root, path))
    const { table } = open()
    await table.maintain([wsDir()])
    const fm = await frontmatter(path)
    expect(fm.id).toBe(derived)
    expect(fm.digest).toBe(computeDigest('手建', '', '手写正文'))
    expect(fm).not.toHaveProperty('handEdited')
    expect(fm.createdAt).toBe('2026-07-01T00:00:00.000Z')
    expect(fm).toMatchObject({ tags: [], summary: '', status: 'active', confidence: 0.9 })
    expect(typeof fm.updatedAt).toBe('string')
    expect(typeof fm.lastConfirmedAt).toBe('string')
    await new Promise(r => setTimeout(r, 5))
    const before = await treeSnapshot(root)
    await table.maintain([wsDir()])
    expect(await treeSnapshot(root)).toEqual(before)
  })

  it('digest 存在且不匹配（正文被手改）→ 重算 digest、handEdited: true、updatedAt 与 lastConfirmedAt 取 mtime；再维护不再动', async () => {
    const original = record({ id: 'mem_e', name: '手编', content: '原文', summary: '摘要' })
    const path = await writeMem(globalDir(), 'e.md', original)
    await writeFile(path, (await readFile(path, 'utf8')).replace('原文', '用户改过的正文'))
    const edited = await touch(path, Date.now() - 3 * DAY)
    const { table } = open()
    await table.maintain([globalDir()])
    const fm = await frontmatter(path)
    expect(fm.handEdited).toBe(true)
    expect(fm.digest).toBe(computeDigest('手编', '摘要', '用户改过的正文'))
    expect(fm.updatedAt).toBe(iso(edited))
    expect(fm.lastConfirmedAt).toBe(iso(edited))
    expect(fm.createdAt).toBe(iso(original.createdAt))   // createdAt 不动
    const hit = (await table.locate('mem_e'))!.record
    expect(hit.handEdited).toBe(true)
    expect(hit.updatedAt).toBe(Date.parse(iso(edited)))
    await new Promise(r => setTimeout(r, 5))
    const before = await treeSnapshot(root)
    await table.maintain([globalDir()])
    expect(await treeSnapshot(root)).toEqual(before)
  })

  it('插件自己写出的文件在稳态下零写入：维护点前后目录项与 mtime 逐项相等', async () => {
    const { table } = open()
    await table.create(wsRecord({ id: 'mem_w1', name: '一', tags: ['a', 'b'], summary: '摘要', content: '多行\n正文' }))
    await table.create(record({ id: 'mem_g1', name: '二', validTo: Date.now() + DAY, supersedes: ['mem_x'], globalCandidate: true }))
    await table.update('mem_w1', r => ({ ...r, status: 'deleted', updatedAt: Date.now() }))
    await new Promise(r => setTimeout(r, 5))
    const before = await treeSnapshot(root)
    await table.maintain([globalDir(), wsDir()])
    expect(await treeSnapshot(root)).toEqual(before)
  })
})

describe('维护点动作 ⑤：陈旧 tmp 清理', () => {
  it('本进程 pid 的残留与超 60 秒的残留被删，他进程的新鲜残留不动', async () => {
    await writeMem(globalDir(), 'a.md', record({ id: 'mem_a' }))
    await writeRaw(globalDir(), `a.md.tmp-${process.pid}-mine`, '自家残留')
    await writeRaw(archiveOf(globalDir()), `b.md.tmp-${process.pid + 1}-fresh`, '他人在途')
    const stale = await writeRaw(globalDir(), `c.md.tmp-${process.pid + 1}-stale`, '他人陈旧')
    await touch(stale, Date.now() - 120_000)
    const { table } = open()
    await table.maintain([globalDir()])
    expect((await readdir(globalDir())).filter(n => n.includes('.tmp-'))).toEqual([])
    expect((await readdir(archiveOf(globalDir()))).filter(n => n.includes('.tmp-'))).toEqual([`b.md.tmp-${process.pid + 1}-fresh`])
  })
})

describe('维护点的边界', () => {
  it('过期（validTo 已过）的 active 文件不搬家：留在顶层、mtime 不变，只不进 MEMORY.md', async () => {
    const path = await writeMem(globalDir(), 'exp.md', record({ id: 'mem_exp', name: '过期', validTo: Date.now() - DAY }))
    await writeMem(globalDir(), 'live.md', record({ id: 'mem_live', name: '有效' }))
    const mtime = (await stat(path)).mtimeMs
    const { table } = open()
    await table.maintain([globalDir()])
    expect(await mds(globalDir())).toEqual(['exp.md', 'live.md'])
    expect((await stat(path)).mtimeMs).toBe(mtime)
    const idx = await readFile(join(globalDir(), INDEX_FILE), 'utf8')
    expect(idx).toContain('mem_live')
    expect(idx).not.toContain('mem_exp')
  })

  it('只动给定目录：维护 global 时 workspace 目录一字不动', async () => {
    await writeMem(globalDir(), 'd.md', record({ id: 'mem_d', status: 'deleted' }))
    await writeMem(wsDir(), 'wd.md', wsRecord({ id: 'mem_wd', status: 'deleted' }), WS)
    await writeRaw(wsDir(), INDEX_FILE, '# 手改\n')
    await new Promise(r => setTimeout(r, 5))
    const before = await treeSnapshot(wsDir())
    const { table } = open()
    await table.maintain([globalDir()])
    expect(await mds(archiveOf(globalDir()))).toEqual(['d.md'])
    expect(await treeSnapshot(wsDir())).toEqual(before)
  })

  it('.archive/ 里 status 仍为 active 的文件按位置归一成 deleted（deletedAt 取 mtime），不搬回顶层', async () => {
    const path = await writeMem(archiveOf(globalDir()), 'x.md', record({ id: 'mem_x', name: 'x' }))
    const moved = await touch(path, Date.now() - DAY)
    const { table } = open()
    await table.maintain([globalDir()])
    expect(await mds(globalDir())).toEqual([])
    expect(await mds(archiveOf(globalDir()))).toEqual(['x.md'])
    expect(await frontmatter(path)).toMatchObject({ status: 'deleted', deletedAt: iso(moved) })
    expect((await readFile(join(globalDir(), INDEX_FILE), 'utf8'))).not.toContain('mem_x')
  })

  it('维护点本身不删同 id 副本：两份都在，MEMORY.md 只列一次', async () => {
    await writeMem(globalDir(), 'dup-a.md', record({ id: 'mem_dup', name: '重复', updatedAt: 100 }))
    await writeMem(globalDir(), 'dup-b.md', record({ id: 'mem_dup', name: '重复', updatedAt: 200 }))
    const { table } = open()
    await table.maintain([globalDir()])
    expect(await mds(globalDir())).toEqual(['dup-a.md', 'dup-b.md'])
    const idx = await readFile(join(globalDir(), INDEX_FILE), 'utf8')
    expect(idx.match(/mem_dup/g)).toHaveLength(1)
  })
})

describe('同 id 重复副本只在写该 id 时清理', () => {
  it('put 后可见集合（global + 该记录的 workspace 目录，含 .archive/）内的其余副本被删，其他项目的副本不动', async () => {
    const now = Date.now()
    await writeMem(wsDir(), 'cur.md', wsRecord({ id: 'mem_c', content: '当前', updatedAt: now - 1 }), WS)
    await writeMem(globalDir(), 'cur-g.md', record({ id: 'mem_c', content: 'global 副本', updatedAt: now - 2 }))
    await writeMem(archiveOf(wsDir()), 'cur-old.md', wsRecord({ id: 'mem_c', content: '归档副本', status: 'deleted', updatedAt: now - 3, deletedAt: now }))
    const other = await writeMem(wsDir(OTHER), 'cur.md', wsRecord({ id: 'mem_c', content: '别的项目', updatedAt: now - 4 }, OTHER), OTHER)
    await writeMem(globalDir(), 'bystander.md', record({ id: 'mem_by', updatedAt: 100 }))
    await writeMem(globalDir(), 'bystander-2.md', record({ id: 'mem_by', updatedAt: 200 }))
    const { table } = open()
    // put 带 workspacePath：一级定位 global + 本项目目录，取舍到 updatedAt 最新的本项目那份
    await table.put('mem_c', wsRecord({ id: 'mem_c', content: '改过', updatedAt: now }))
    expect(await mds(wsDir())).toEqual(['cur.md'])
    expect(await mds(archiveOf(wsDir()))).toEqual([])
    expect(await mds(globalDir())).toEqual(['bystander-2.md', 'bystander.md'])   // 别的 id 的副本不动
    expect(await readFile(other, 'utf8')).toContain('别的项目')
    expect((await table.locate('mem_c', { workspacePath: WS }))!.record.content).toBe('改过')
  })
})

describe('快照冻结是维护点', () => {
  function harness() {
    const sidecar = new SidecarStore({ root, schemas: { snapshots: memorySnapshotSchema, pending: pendingDecisionSchema, scanCache: scanCacheSchema } })
    const table = new FileTable({ root, stats: sidecar.recallStats })
    const store = new MemoryStore(table, undefined, sidecar.recallStats)
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const cache = new SnapshotCache({ store, registry, budget: 4000, memoryRoot: root, log })
    const assemble = async (ws: string | undefined) => {
      const s = {}
      cache.setWorkspacePath(s, ws)
      return cache.assemble(s)
    }
    return { table, store, cache, log, assemble }
  }

  it('手改 status 为 deleted 的文件在冻结后进 .archive/ 且带 deletedAt；手改的 MEMORY.md 被覆盖', async () => {
    await writeMem(wsDir(), 'gone.md', wsRecord({ id: 'mem_gone', name: '手删', status: 'deleted' }), WS)
    await writeMem(wsDir(), 'live.md', wsRecord({ id: 'mem_live', name: '有效', content: '有效 正文' }))
    await writeRaw(wsDir(), INDEX_FILE, '# 我手动改过的索引，别动\n私货\n')
    await writeRaw(globalDir(), INDEX_FILE, '# 另一个手改索引\n')
    const h = harness()
    const text = await h.assemble(WS)
    expect(text).toContain('有效 正文')
    expect(await mds(wsDir())).toEqual(['live.md'])
    expect(await mds(archiveOf(wsDir()))).toEqual(['gone.md'])
    expect(await frontmatter(join(archiveOf(wsDir()), 'gone.md'))).toHaveProperty('deletedAt')
    const idx = await readFile(join(wsDir(), INDEX_FILE), 'utf8')
    expect(idx).not.toContain('私货')
    expect(idx).toContain('mem_live')
    expect(await readFile(join(globalDir(), INDEX_FILE), 'utf8')).toBe('# Memory Index\n\n')
  })

  it('会话没有 workspace（解析为 undefined）时只维护 global，workspace 目录不动', async () => {
    await writeMem(globalDir(), 'gd.md', record({ id: 'mem_gd', status: 'deleted' }))
    await writeMem(wsDir(), 'wd.md', wsRecord({ id: 'mem_wd', status: 'deleted' }), WS)
    await new Promise(r => setTimeout(r, 5))
    const before = await treeSnapshot(wsDir())
    const h = harness()
    await h.assemble(undefined)
    expect(await mds(archiveOf(globalDir()))).toEqual(['gd.md'])
    expect(await treeSnapshot(wsDir())).toEqual(before)
  })

  it('维护失败只记日志，注入文本照常返回并冻结', async () => {
    await writeMem(wsDir(), 'live.md', wsRecord({ id: 'mem_live', name: '有效', content: '有效 正文' }), WS)
    const h = harness()
    vi.spyOn(h.store, 'maintain').mockRejectedValueOnce(new Error('boom'))
    const s = {}
    h.cache.setWorkspacePath(s, WS)
    const text = await h.cache.assemble(s)
    expect(text).toContain('有效 正文')
    expect(h.cache.render(s)).toBe(text)
    expect(h.log.error).toHaveBeenCalledTimes(1)
  })
})

describe('memory_health 纯读', () => {
  it('真实目录里有待搬家的 deleted、手改的 MEMORY.md、手建文件：单层与全库体检后目录项与 mtime 逐项不变', async () => {
    await writeMem(wsDir(), 'gone.md', wsRecord({ id: 'mem_gone', status: 'deleted' }), WS)
    await writeRaw(wsDir(), 'hand.md', '---\nname: 手建\ntype: preference\n---\n\n手写\n')
    await writeRaw(wsDir(), INDEX_FILE, '# 手改\n')
    await writeMem(globalDir(), 'g.md', record({ id: 'mem_g' }))
    await writeRaw(globalDir(), INDEX_FILE, '# 手改\n')
    await new Promise(r => setTimeout(r, 5))
    const before = await treeSnapshot(root)
    const sidecar = new SidecarStore({ root, schemas: { snapshots: memorySnapshotSchema, pending: pendingDecisionSchema, scanCache: scanCacheSchema } })
    const store = new MemoryStore(new FileTable({ root, stats: sidecar.recallStats }), undefined, sidecar.recallStats)
    const deps = {
      store, registry, decisions: new PendingDecisionsStore(sidecar.pending), cache: sidecar.scanCache,
      thresholds: resolveHealthThresholds('normal'), resolveContext: async () => ({ workspacePath: WS }),
    }
    expect((await executeHealth({}, deps, fakeExec())).kind).toBe('single')
    expect((await executeHealth({ scope: 'all' }, deps, fakeExec())).kind).toBe('checkup')
    expect(await treeSnapshot(root)).toEqual(before)
  })
})

describe('待决账本成员只在仅剩归档的目录里', () => {
  it('prereadLayers 对 pending 的成员按 id 定位，crossLayerConflicts 不漏', async () => {
    const now = Date.now()
    await writeMem(globalDir(), 'g1.md', record({ id: 'mem_g1' }))
    await writeMem(wsDir(WS), 'a.md', wsRecord({ id: 'mem_a' }), WS)
    // proj-o 只剩归档：不进体检清单，但它的记录仍是待决条目的一方
    await writeMem(archiveOf(wsDir(OTHER)), 'b.md', wsRecord({ id: 'mem_b', status: 'deleted', deletedAt: now }, OTHER), OTHER)
    await writeFile(join(wsDir(OTHER), WORKSPACE_MARKER), OTHER + '\n')
    const sidecar = new SidecarStore({ root, schemas: { snapshots: memorySnapshotSchema, pending: pendingDecisionSchema, scanCache: scanCacheSchema } })
    const store = new MemoryStore(new FileTable({ root, stats: sidecar.recallStats }), undefined, sidecar.recallStats)
    const decisions = new PendingDecisionsStore(sidecar.pending)
    await decisions.upsert({ memoryIds: ['mem_g1', 'mem_a'], summary: '' }, now)
    await decisions.upsert({ memoryIds: ['mem_g1', 'mem_b'], summary: '' }, now)
    const data = await prereadLayers({ store, decisions, cache: sidecar.scanCache }, [{ kind: 'global' }, { kind: 'workspace', path: WS }])
    expect(data.byId.get('mem_b')?.status).toBe('deleted')
    const conflicts = crossLayerConflicts(data.byId, data.pending)
    expect(conflicts.map(c => [c.globalId, c.workspaces])).toEqual([['mem_g1', [WS, OTHER]]])
  })
})
