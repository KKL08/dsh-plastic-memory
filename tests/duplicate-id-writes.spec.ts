import { describe, expect, it } from 'vitest'
import { join } from 'node:path'

import { executeForget } from '../src/tools/forget.ts'
import { executePromote } from '../src/tools/promote.ts'
import { executeSnapshotTool } from '../src/tools/snapshot.ts'
import { MemoryStore, InMemoryTable } from '../src/store.ts'
import { workspaceDirName } from '../src/storage/paths.ts'
import type { MemoryLogger } from '../src/storage/table.ts'
import { PendingDecisionsStore } from '../src/governance/decisions.ts'
import { SnapshotStore } from '../src/governance/snapshots.ts'
import type { MemorySnapshot, PendingDecision } from '../src/governance/schema.ts'
import { InMemoryKvTable, type KvTable } from '../src/kv-table.ts'
import type { MemoryRecord } from '../src/record-schema.ts'
import { record } from './helpers/record.ts'
import { FAKE_SECRET } from './helpers/secrets.ts'

// 同 id 多副本时，执行器预读 / 过门用的那份记录与最终写入落到的那份
// 必须是同一个文件，否则会改到门没检查过的副本（其他项目的、或 global 上被修改过的）。
// 场景统一：会话在 ZETA；ALPHA 是另一个项目，目录名排在 ZETA 之前，让「按路径序取舍」更容易落到它。

const ZETA = '/home/dev/zeta'
const ALPHA = '/home/dev/alpha'
const IN_ZETA = { workspacePath: ZETA as string | undefined }
const quiet = { info() {}, warn() {}, error() {}, debug() {} } as unknown as MemoryLogger
const ws = (path: string, partial: Partial<MemoryRecord> = {}) => record({ scope: 'workspace', workspacePath: path, ...partial })
const glob = (partial: Partial<MemoryRecord> = {}) => record({ scope: 'global', ...partial })

function world() {
  const table = new InMemoryTable()
  const store = new MemoryStore(table)
  const snapshots = new SnapshotStore(new InMemoryKvTable<MemorySnapshot>())
  const decisions = new PendingDecisionsStore(new InMemoryKvTable<PendingDecision>())
  const agentsMd = { lines: [] as string[], append: async function (line: string) { this.lines.push(line) } }
  const deps = { store, snapshots, decisions, agentsMd, log: quiet, now: () => 5000 }
  const seed = (dir: string, fileName: string, rec: MemoryRecord) => table.seedFile({ dir, fileName, record: rec })
  const wsDir = (path: string) => join('/in-memory', workspaceDirName(path))
  const activeIn = async (scope: { kind: 'global' } | { kind: 'workspace'; path: string }) =>
    (await store.queryScope({ scope, status: ['active'] })).records
  return { table, store, snapshots, deps, seed, wsDir, activeIn }
}

describe('promote 到 global：搬家的是门放行的当前项目那份，其他项目的同 id 副本不动', () => {
  it('其他项目有同 id 且更新的副本 → 当前项目那份进 global，其他项目那份仍在原位', async () => {
    const w = world()
    w.seed(w.wsDir(ALPHA), 'dup.md', ws(ALPHA, { id: 'mem_dup', content: 'ALPHA 的副本', updatedAt: 200 }))
    w.seed(w.wsDir(ZETA), 'dup.md', ws(ZETA, { id: 'mem_dup', content: 'ZETA 的副本', updatedAt: 100, globalCandidate: true }))
    const r = await executePromote({ confirmedIds: ['mem_dup'], target: 'global' }, IN_ZETA, w.deps)
    expect(r.promoted).toEqual([{ id: 'mem_dup', target: 'global' }])
    expect((await w.activeIn({ kind: 'global' })).map(x => x.content)).toEqual(['ZETA 的副本'])
    expect(await w.activeIn({ kind: 'workspace', path: ZETA })).toEqual([])
    expect((await w.activeIn({ kind: 'workspace', path: ALPHA })).map(x => x.content)).toEqual(['ALPHA 的副本'])
  })
})

describe('snapshot restore：冲突判断看的是将被覆盖的那份文件', () => {
  it('快照里是 global 记录；global 副本快照后被改过、当前项目有同 id 更新的副本与快照一致 → 跳过，global 不被覆盖', async () => {
    const w = world()
    const snapshotted = glob({ id: 'mem_g', content: 'v1', updatedAt: 100 })
    const snap = await w.snapshots.capture({ operation: 'manual', description: '测试', records: [snapshotted] }, 1000)
    w.seed(w.table.globalDir, 'g.md', glob({ id: 'mem_g', content: 'v2（快照后的修改）', updatedAt: 300 }))
    w.seed(w.wsDir(ZETA), 'g.md', ws(ZETA, { id: 'mem_g', content: 'v1', updatedAt: 400 }))
    const r = await executeSnapshotTool({ action: 'restore', snapshotId: snap.id }, IN_ZETA, w.deps)
    expect(r.kind).toBe('restored')
    if (r.kind !== 'restored') throw new Error(r.kind)
    expect(r.restored).toEqual([])
    expect(r.skipped).toEqual(['mem_g'])
    expect((await w.activeIn({ kind: 'global' })).map(x => x.content)).toEqual(['v2（快照后的修改）'])
  })
})

describe('密钥硬删：可见集合（global + 当前项目）里该 id 的全部副本都物理删除', () => {
  it('global 有同 id 旧副本（同样含密钥）→ 两份都删', async () => {
    const w = world()
    w.seed(w.table.globalDir, 'dup.md', glob({ id: 'mem_dup', content: `token ${FAKE_SECRET.sk}`, updatedAt: 100 }))
    w.seed(w.wsDir(ZETA), 'dup.md', ws(ZETA, { id: 'mem_dup', content: `token ${FAKE_SECRET.sk}`, updatedAt: 200 }))
    const r = await executeForget({ ids: ['mem_dup'], reason: '泄漏' }, IN_ZETA, w.deps)
    expect(r.hardDeleted).toEqual(['mem_dup'])
    expect(await w.activeIn({ kind: 'workspace', path: ZETA })).toEqual([])
    expect(await w.activeIn({ kind: 'global' })).toEqual([])
    expect(await w.store.get('mem_dup')).toBeUndefined()
  })
})

describe('快照脱敏串行化：两次 redact 同时进行，互不把对方的明文写回', () => {
  /** list 之后让出一次事件循环再 put：模拟侧表文件读写之间的间隙，让两次读改写交错。 */
  class SlowKv<T> implements KvTable<T> {
    private inner = new InMemoryKvTable<T>()
    get(key: string) { return this.inner.get(key) }
    async list() { const r = await this.inner.list(); await new Promise(res => setTimeout(res, 0)); return r }
    put(key: string, value: T) { return this.inner.put(key, value) }
    delete(key: string) { return this.inner.delete(key) }
  }

  it('同一快照里 X、Y 各含一个密钥，并发 redact({X}) 与 redact({Y}) 后两条都是脱敏的', async () => {
    const snapshots = new SnapshotStore(new SlowKv<MemorySnapshot>())
    const x = glob({ id: 'mem_x', content: `x ${FAKE_SECRET.sk}` })
    const y = glob({ id: 'mem_y', content: `y ${FAKE_SECRET.github}` })
    const snap = await snapshots.capture({ operation: 'manual', description: '两条密钥', records: [x, y] }, 1000)
    await Promise.all([snapshots.redact(new Set(['mem_x'])), snapshots.redact(new Set(['mem_y']))])
    const after = (await snapshots.get(snap.id))!
    expect(after.data.map(r => r.redacted)).toEqual([true, true])
    expect(after.data.map(r => r.content)).not.toContain(x.content)
    expect(after.data.map(r => r.content)).not.toContain(y.content)
  })
})
