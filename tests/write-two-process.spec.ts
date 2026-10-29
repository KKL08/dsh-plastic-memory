import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ARCHIVE_DIR, GLOBAL_DIR } from '../src/storage/paths.ts'
import { FileTable } from '../src/storage/file-table.ts'
import { InMemoryKvTable } from '../src/kv-table.ts'
import type { RecallStats } from '../src/storage/schema.ts'

// 测试第 5 层：两个真实 Node 进程同时写同一个记忆目录（rename 只覆盖同一记录自己的文件，
// 所以两个进程写同名异 id 的记录两条都存活）。子进程用 Node 内置类型剥离直接跑 .ts，起跑靠 stdin 握手同步。

const WORKER = fileURLToPath(new URL('./helpers/write-worker.ts', import.meta.url))

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'pm-write-two-proc-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

function startWorker(tag: string, steps: string) {
  const child = spawn(process.execPath, [WORKER, root, tag, steps], { stdio: ['pipe', 'pipe', 'inherit'] })
  const lines = createInterface({ input: child.stdout! })[Symbol.asyncIterator]()
  const exited = once(child, 'exit') as Promise<[number | null, NodeJS.Signals | null]>
  const nextLine = async () => {
    const { value, done } = await lines.next()
    if (done) throw new Error(`worker ${tag} closed stdout early (exit ${(await exited)[0]})`)
    return value as string
  }
  return { child, nextLine, exited }
}

async function race(steps: string) {
  const workers = [startWorker('a', steps), startWorker('b', steps)]
  expect(await Promise.all(workers.map(w => w.nextLine()))).toEqual(['ready', 'ready'])
  for (const w of workers) w.child.stdin!.end('go\n')
  const results = await Promise.all(workers.map(async w => JSON.parse(await w.nextLine()) as { id: string; content: string }))
  expect((await Promise.all(workers.map(w => w.exited))).map(([code]) => code)).toEqual([0, 0])
  return results
}

const mds = async (dir: string) => (await readdir(dir).catch(() => [] as string[])).filter(n => n.endsWith('.md') && n !== 'MEMORY.md').sort()
const tmps = async (dir: string) => (await readdir(dir).catch(() => [] as string[])).filter(n => n.includes('.tmp-'))

describe('双进程写路径', () => {
  it('两个进程同时 save 同名异 id：两条正文都在磁盘上、文件名不同、无 tmp 残留，新实例按 id 都能定位', async () => {
    const results = await race('create')
    const dir = join(root, GLOBAL_DIR)
    const files = await mds(dir)
    expect(files).toHaveLength(2)
    expect(await tmps(dir)).toEqual([])
    const bodies = await Promise.all(files.map(f => readFile(join(dir, f), 'utf8')))
    for (const r of results) expect(bodies.some(b => b.includes(r.content))).toBe(true)
    const t = new FileTable({ root, stats: new InMemoryKvTable<RecallStats>() })
    for (const r of results) expect((await t.locate(r.id))!.record.content).toBe(r.content)
    const idx = await readFile(join(dir, 'MEMORY.md'), 'utf8')
    for (const r of results) expect(idx).toContain(r.id)
  }, 30_000)

  it('两个进程各自 save 同名异 id 再 forget：归档时 .archive/ 里同名异 id 两份都保留，顶层清空', async () => {
    const results = await race('create,forget')
    const dir = join(root, GLOBAL_DIR)
    expect(await mds(dir)).toEqual([])
    const archived = await mds(join(dir, ARCHIVE_DIR))
    expect(archived).toHaveLength(2)
    expect(await tmps(join(dir, ARCHIVE_DIR))).toEqual([])
    const bodies = await Promise.all(archived.map(f => readFile(join(dir, ARCHIVE_DIR, f), 'utf8')))
    for (const r of results) expect(bodies.some(b => b.includes(r.content))).toBe(true)
    const t = new FileTable({ root, stats: new InMemoryKvTable<RecallStats>() })
    for (const r of results) expect((await t.locate(r.id))!.record.status).toBe('deleted')
  }, 30_000)
})
