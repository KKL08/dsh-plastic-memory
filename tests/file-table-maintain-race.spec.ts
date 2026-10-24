import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileTable, DELETED_RETENTION_MS } from '../src/storage/file-table.ts'
import { encodeRecord } from '../src/storage/frontmatter.ts'
import { ARCHIVE_DIR, GLOBAL_DIR, INDEX_FILE } from '../src/storage/paths.ts'
import { InMemoryKvTable } from '../src/kv-table.ts'
import type { RecallStats } from '../src/storage/schema.ts'
import type { MemoryRecord } from '../src/record-schema.ts'
import { record as baseRecord } from './helpers/record.ts'

// 维护点读到文件之后、动手之前，别的宿主进程或用户改了这个文件：基于旧读数的改写、搬家、删除都不能盖掉新内容。
// 文件系统是进程边界：只给 readFile 套一层，在指定路径第 n 次读完之后用真实 writeFile 换掉文件内容，模拟并发修改。
const { triggers } = vi.hoisted(() => ({ triggers: new Map<string, { afterRead: number; reads: number; text: string }>() }))
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const readFile = vi.fn(async (...args: Parameters<typeof actual.readFile>) => {
    const out = await actual.readFile(...args)
    const t = triggers.get(String(args[0]))
    if (t !== undefined && ++t.reads === t.afterRead) {
      triggers.delete(String(args[0]))
      await actual.writeFile(String(args[0]), t.text, 'utf8')
    }
    return out
  })
  return { ...actual, readFile }
})

/** 让 path 在第 afterRead 次被读完之后换成 text（只触发一次）。 */
function changeAfterRead(path: string, text: string, afterRead = 1) {
  triggers.set(path, { afterRead, reads: 0, text })
}

const DAY = 86_400_000
const record = (partial: Partial<MemoryRecord> = {}) => baseRecord({
  type: 'preference', createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000, lastConfirmedAt: 1_700_000_000_000, ...partial,
})

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'pm-maint-race-')) })
afterEach(async () => {
  triggers.clear()
  await rm(root, { recursive: true, force: true })
})

const globalDir = () => join(root, GLOBAL_DIR)
const archiveDir = () => join(globalDir(), ARCHIVE_DIR)
const mds = async (dir: string) => (await readdir(dir).catch(() => [] as string[])).filter(n => n.endsWith('.md') && n !== INDEX_FILE).sort()

async function writeAt(dir: string, fileName: string, text: string): Promise<string> {
  await mkdir(dir, { recursive: true })
  const path = join(dir, fileName)
  await writeFile(path, text, 'utf8')
  return path
}

function open() {
  const stats = new InMemoryKvTable<RecallStats>()
  return { table: new FileTable({ root, stats }), stats }
}

describe('维护点动手前复核磁盘原文：读后被改的文件本轮不动', () => {
  it('回写：读到之后文件被改，新内容原样保留；下一轮维护再归一', async () => {
    // 缺 digest 的文件，维护点要回写补基线
    const path = await writeAt(globalDir(), 'hand.md', '---\nid: mem_hand\nname: 手建\ntype: preference\ncreatedAt: 2026-07-01\n---\n\n旧正文\n')
    const newer = '---\nid: mem_hand\nname: 手建\ntype: preference\ncreatedAt: 2026-07-01\n---\n\n刚改的正文\n'
    changeAfterRead(path, newer)
    const { table } = open()
    await table.maintain([globalDir()])
    expect(await readFile(path, 'utf8')).toBe(newer)

    await table.maintain([globalDir()])
    const text = await readFile(path, 'utf8')
    expect(text).toContain('刚改的正文')
    expect(text).toMatch(/^digest:/m)
  })

  it('搬进 .archive/：读到之后文件被改回 active，不占名、不删源文件', async () => {
    const r = record({ id: 'mem_mv', name: '待搬', status: 'deleted', deletedAt: Date.now() })
    const path = await writeAt(globalDir(), '待搬.md', encodeRecord(r, {}))
    const newer = encodeRecord({ ...r, status: 'active', deletedAt: undefined, content: '改回来了' }, {})
    changeAfterRead(path, newer)
    const { table } = open()
    await table.maintain([globalDir()])
    expect(await readFile(path, 'utf8')).toBe(newer)
    expect(await mds(archiveDir())).toEqual([])
  })

  it('搬进 .archive/：占名之后、删源文件之前被改，源文件保留，撤回刚写的归档副本', async () => {
    const r = record({ id: 'mem_mv2', name: '待搬二', status: 'deleted', deletedAt: Date.now() })
    const path = await writeAt(globalDir(), '待搬二.md', encodeRecord(r, {}))
    const newer = encodeRecord({ ...r, status: 'active', deletedAt: undefined, content: '占名后改回来' }, {})
    changeAfterRead(path, newer, 2)   // 第 1 次是目录读，第 2 次是占名前的复核
    const { table } = open()
    await table.maintain([globalDir()])
    expect(await readFile(path, 'utf8')).toBe(newer)
    expect(await mds(archiveDir())).toEqual([])
  })

  it('过期归档物理删除：读到之后文件被改，文件与召回统计行都保留', async () => {
    const r = record({ id: 'mem_old', name: '过期', status: 'deleted', deletedAt: Date.now() - DELETED_RETENTION_MS - DAY })
    const path = await writeAt(archiveDir(), '过期.md', encodeRecord(r, {}))
    const newer = encodeRecord({ ...r, deletedAt: Date.now(), content: '刚恢复过' }, {})
    changeAfterRead(path, newer)
    const { table, stats } = open()
    await stats.put('mem_old', { id: 'mem_old', recallCount: 2, lastRecalledAt: 1 })
    await table.maintain([globalDir()])
    expect(await readFile(path, 'utf8')).toBe(newer)
    expect(await stats.get('mem_old')).toMatchObject({ recallCount: 2 })
  })
})
