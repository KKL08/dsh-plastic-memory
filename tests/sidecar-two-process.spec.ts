import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { STATE_DIR, RECALL_STATS_FILE } from '../src/storage/sidecar.ts'
import { recallStatsSchema } from '../src/storage/schema.ts'
import { memorySnapshotSchema } from '../src/governance/schema.ts'

// 测试第 5 层：两个真实 Node 进程同时写同一个 .state/。子进程用 Node 内置的类型剥离直接跑 .ts
// （engines 要求的 Node ^22.19 / >=24 默认开启），不引 tsx。起跑靠 stdin 握手同步，不用 sleep。

const WORKER = fileURLToPath(new URL('./helpers/sidecar-worker.ts', import.meta.url))
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
