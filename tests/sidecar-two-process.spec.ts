import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { STATE_DIR, RECALL_STATS_FILE, SidecarStore } from '../src/storage/sidecar.ts'
import { recallStatsSchema } from '../src/storage/schema.ts'
import { memorySnapshotSchema, pendingDecisionSchema, scanCacheSchema, adviceIgnoreSchema } from '../src/governance/schema.ts'
import { FileTable } from '../src/storage/file-table.ts'
import { MemoryStore } from '../src/store.ts'
import { ARCHIVE_DIR, INDEX_FILE, workspaceDirName } from '../src/storage/paths.ts'
import type { ForgetResult } from '../src/tools/forget.ts'
import type { SearchHit } from '../src/tools/search.ts'
import { record } from './helpers/record.ts'

// 测试第 5 层：两个真实 Node 进程同时写同一个 .state/。子进程用 Node 内置的类型剥离直接跑 .ts
// （engines 要求的 Node ^22.19 / >=24 默认开启），不引 tsx。起跑靠 stdin 握手同步，不用 sleep。

const WORKER = fileURLToPath(new URL('./helpers/sidecar-worker.ts', import.meta.url))
const TOOL_WORKER = fileURLToPath(new URL('./helpers/tool-worker.ts', import.meta.url))
const SNAPSHOTS_PER_PROCESS = 8

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'pm-two-proc-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

function startWorker(tag: string) {
  const child = spawn(process.execPath, [WORKER, root, String(SNAPSHOTS_PER_PROCESS), tag], { stdio: ['pipe', 'pipe', 'inherit'] })
  const lines = createInterface({ input: child.stdout! })[Symbol.asyncIterator]()
  const exited = once(child, 'exit') as Promise<[number | null, NodeJS.Signals | null]>
  const nextLine = async () => {
    const { value, done } = await lines.next()
    if (done) throw new Error(`worker ${tag} closed stdout early (exit ${(await exited)[0]})`)
    return value as string
  }
  return { child, nextLine, exited }
}

describe('双进程侧表', () => {
  it('两个进程同时各拍快照并写召回统计：两边快照文件齐全、都能解析，recall-stats.json 可解析', async () => {
    const workers = [startWorker('a'), startWorker('b')]
    expect(await Promise.all(workers.map(w => w.nextLine()))).toEqual(['ready', 'ready'])
    for (const w of workers) w.child.stdin!.end('go\n')
    const results = await Promise.all(workers.map(async w => JSON.parse(await w.nextLine()) as { ids: string[] }))
    expect((await Promise.all(workers.map(w => w.exited))).map(([code]) => code)).toEqual([0, 0])

    const expected = results.flatMap(r => r.ids)
    expect(expected).toHaveLength(2 * SNAPSHOTS_PER_PROCESS)
    const dir = join(root, STATE_DIR, 'snapshots')
    const files = await readdir(dir)
    expect(files.filter(f => f.includes('.tmp-'))).toEqual([])
    expect(files.sort()).toEqual(expected.map(id => `${id}.json`).sort())
    for (const f of files) {
      const snap = memorySnapshotSchema.parse(JSON.parse(await readFile(join(dir, f), 'utf8')))
      expect(`${snap.id}.json`).toBe(f)
    }

    // 召回统计单文件跨进程 LWW：只要求可解析、每条合 schema、键都来自两个进程写过的记忆
    const stats = JSON.parse(await readFile(join(root, STATE_DIR, RECALL_STATS_FILE), 'utf8')) as Record<string, unknown>
    const keys = Object.keys(stats)
    expect(keys.length).toBeGreaterThan(0)
    for (const key of keys) {
      expect(['mem_shared', 'mem_a', 'mem_b']).toContain(key)
      expect(recallStatsSchema.parse(stats[key]).id).toBe(key)
    }
  }, 30_000)
})

describe('双进程工具调用', () => {
  const WS = '/home/dev/proj-two'
  const wsDir = () => join(root, workspaceDirName(WS))
  const openStore = () => {
    const sidecar = new SidecarStore({ root, schemas: { snapshots: memorySnapshotSchema, pending: pendingDecisionSchema, scanCache: scanCacheSchema, adviceIgnores: adviceIgnoreSchema } })
    return new MemoryStore(new FileTable({ root, stats: sidecar.recallStats }), undefined, sidecar.recallStats)
  }

  /** 起一个常驻的工具进程；call 发一条命令、等它回一行结果。 */
  function startToolWorker(tag: string) {
    const child = spawn(process.execPath, [TOOL_WORKER, root, WS, tag], { stdio: ['pipe', 'pipe', 'inherit'] })
    const lines = createInterface({ input: child.stdout! })[Symbol.asyncIterator]()
    const exited = once(child, 'exit') as Promise<[number | null, NodeJS.Signals | null]>
    const nextLine = async () => {
      const { value, done } = await lines.next()
      if (done) throw new Error(`worker ${tag} closed stdout early (exit ${(await exited)[0]})`)
      return value as string
    }
    const call = async <T,>(cmd: object): Promise<T> => {
      child.stdin!.write(`${JSON.stringify(cmd)}\n`)
      return JSON.parse(await nextLine()) as T
    }
    return { child, nextLine, call, exited }
  }

  it('进程 A 用 memory_forget 遗忘两条后，进程 B 的 memory_search 不覆盖 A 的快照：快照文件逐字节、逐字段不变，B 再从它恢复，两条回到原位', async () => {
    const seeded = [
      record({ id: 'mem_x', name: '测试框架', scope: 'workspace', workspacePath: WS, content: '单测用 vitest 跑', summary: '测试框架选型', tags: ['单测'] }),
      record({ id: 'mem_y', name: '提交语言', scope: 'workspace', workspacePath: WS, content: 'commit 用英文写', summary: '提交信息的语言', tags: ['提交'] }),
      record({ id: 'mem_o', name: 'vitest 配置', scope: 'workspace', workspacePath: WS, content: 'vitest 配置放在仓库根目录', summary: '配置文件位置' }),
    ]
    const seedStore = openStore()
    for (const r of seeded) await seedStore.create(r)

    const a = startToolWorker('a')
    const b = startToolWorker('b')
    expect(await Promise.all([a.nextLine(), b.nextLine()])).toEqual(['ready', 'ready'])

    // B 先搜一次：已经读过这批记录、写过召回统计
    const before = await b.call<{ hits: SearchHit[] }>({ op: 'search', query: 'vitest' })
    expect(before.hits.map(h => h.id).sort()).toEqual(['mem_o', 'mem_x'])

    const forgot = await a.call<ForgetResult>({ op: 'forget', ids: ['mem_x', 'mem_y'], reason: '用户说不用了' })
    expect(forgot).toMatchObject({ ok: true, forgotten: ['mem_x', 'mem_y'], hardDeleted: [] })
    const snapFile = join(root, STATE_DIR, 'snapshots', `${forgot.snapshotId}.json`)
    const textBefore = await readFile(snapFile, 'utf8')
    const snapBefore = memorySnapshotSchema.parse(JSON.parse(textBefore))
    expect(snapBefore.operation).toBe('pre-forget')
    expect(snapBefore.memoryIds).toEqual(['mem_x', 'mem_y'])
    for (const [i, r] of seeded.slice(0, 2).entries()) {
      expect(snapBefore.data[i]).toMatchObject({ id: r.id, name: r.name, content: r.content, summary: r.summary, tags: r.tags, status: 'active' })
    }

    // B 再搜一次：看得到 A 的遗忘，照常写召回统计，不碰 A 的快照
    const after = await b.call<{ hits: SearchHit[] }>({ op: 'search', query: 'vitest' })
    expect(after.hits.map(h => h.id)).toEqual(['mem_o'])
    expect(await readFile(snapFile, 'utf8')).toBe(textBefore)
    expect(memorySnapshotSchema.parse(JSON.parse(await readFile(snapFile, 'utf8')))).toEqual(snapBefore)

    // 从 A 的快照恢复（由 B 发起）：两条写回；新的存储实例读到原正文、在用，文件回到 workspace 顶层
    const restored = await b.call<{ kind: string; restored: string[]; skipped: string[] }>({ op: 'restore', snapshotId: forgot.snapshotId })
    expect(restored).toMatchObject({ kind: 'restored', restored: ['mem_x', 'mem_y'], skipped: [] })
    const fresh = openStore()
    for (const r of seeded) {
      expect(await fresh.get(r.id, { workspacePath: WS })).toMatchObject({ name: r.name, content: r.content, summary: r.summary, tags: r.tags, status: 'active' })
    }
    const files = (await readdir(wsDir(), { recursive: true })).filter(f => f.endsWith('.md') && f !== INDEX_FILE)
    expect(files.filter(f => f.startsWith(ARCHIVE_DIR))).toEqual([])
    expect(files.sort()).toEqual(['vitest-配置.md', '提交语言.md', '测试框架.md'].sort())

    for (const w of [a, b]) w.child.stdin!.end()
    expect((await Promise.all([a.exited, b.exited])).map(([code]) => code)).toEqual([0, 0])
  }, 30_000)
})
