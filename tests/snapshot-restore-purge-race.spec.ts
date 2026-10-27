import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { FileTable } from '../src/storage/file-table.ts'
import { SidecarStore } from '../src/storage/sidecar.ts'
import { STATE_DIR } from '../src/storage/paths.ts'
import { MemoryStore } from '../src/store.ts'
import { PendingDecisionsStore } from '../src/governance/decisions.ts'
import { SnapshotStore } from '../src/governance/snapshots.ts'
import { memorySnapshotSchema, pendingDecisionSchema, scanCacheSchema, adviceIgnoreSchema } from '../src/governance/schema.ts'
import { executeForget } from '../src/tools/forget.ts'
import { executeSnapshotTool } from '../src/tools/snapshot.ts'
import type { MemoryRecord } from '../src/record-schema.ts'
import { record as baseRecord } from './helpers/record.ts'
import { FAKE_SECRET } from './helpers/secrets.ts'

// 恢复进行到一半，另一个会话把含密钥的记忆彻底删除（先脱敏快照、再删文件）：恢复不能把明文写回来。
// 全部用真实目录（FileTable + .state 侧表），两个会话共用同一个记忆根目录。

const WS = '/home/dev/proj-race'
const ctx = { workspacePath: WS }

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'pm-restore-race-')) })
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})

const wsRec = (partial: Partial<MemoryRecord> = {}) => baseRecord({
  type: 'preference', scope: 'workspace', workspacePath: WS,
  createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000, lastConfirmedAt: 1_700_000_000_000,
  ...partial,
})

/** 一个会话的执行器：各自的 store / 快照实例，盘上共用 root。 */
function session() {
  const sidecar = new SidecarStore({ root, schemas: { snapshots: memorySnapshotSchema, pending: pendingDecisionSchema, scanCache: scanCacheSchema, adviceIgnores: adviceIgnoreSchema } })
  const store = new MemoryStore(new FileTable({ root, stats: sidecar.recallStats }), undefined, sidecar.recallStats)
  const snapshots = new SnapshotStore(sidecar.snapshots)
  const decisions = new PendingDecisionsStore(sidecar.pending)
  return {
    store, snapshots,
    forget: (ids: string[]) => executeForget({ ids, reason: '含密钥' }, ctx, { store, snapshots, decisions }),
    snapshot: (args: Parameters<typeof executeSnapshotTool>[0]) => executeSnapshotTool(args, ctx, { store, snapshots }),
  }
}

/** 记忆目录（.state/ 除外）里所有文件文本拼起来，查明文残留用。 */
async function allMemoryText(dir = root): Promise<string> {
  const texts: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (relative(root, path) === STATE_DIR) continue
    if (entry.isDirectory()) texts.push(await allMemoryText(path))
    else if ((await stat(path)).isFile()) texts.push(await readFile(path, 'utf8'))
  }
  return texts.join('\n')
}

async function seed() {
  const a = session()
  await a.store.create(wsRec({ id: 'mem_k', name: '部署凭证', content: `token 是 ${FAKE_SECRET.sk}` }))
  await a.store.create(wsRec({ id: 'mem_o', name: '包管理', content: '用 pnpm' }))
  const created = await a.snapshot({ action: 'create', memoryIds: ['mem_k', 'mem_o'] })
  if (created.kind !== 'created') throw new Error(created.kind)
  return created.snapshotId
}

describe('恢复与密钥硬删交错', () => {
  it('读出快照之后、写入之前另一会话硬删：恢复跳过该条并计入 redacted，盘上没有明文', async () => {
    const snapshotId = await seed()
    const a = session()
    const b = session()
    const load = a.snapshots.get.bind(a.snapshots)
    vi.spyOn(a.snapshots, 'get').mockImplementationOnce(async id => {
      const loaded = await load(id)   // 恢复手里拿的是脱敏前的副本
      const purged = await b.forget(['mem_k'])
      expect(purged.hardDeleted).toEqual(['mem_k'])
      return loaded
    })

    const r = await a.snapshot({ action: 'restore', snapshotId })

    if (r.kind !== 'restored') throw new Error(r.kind)
    expect(r.restored).toEqual(['mem_o'])
    expect(r.skipped).toEqual(['mem_k'])
    expect(r.redacted).toEqual(['mem_k'])
    expect(await a.store.get('mem_k', ctx)).toBeUndefined()
    expect(await allMemoryText()).not.toContain(FAKE_SECRET.sk)
  })

  it('写入那一刻才发生硬删（对方已脱敏并删完文件，本会话随即写入）：写后复核发现脱敏，删掉刚写的文件，计入 redacted', async () => {
    const snapshotId = await seed()
    const a = session()
    const b = session()
    const put = a.store.put.bind(a.store)
    vi.spyOn(a.store, 'put').mockImplementation(async (rec, hint, skipIf) => {
      if (rec.id === 'mem_k') {
        const purged = await b.forget(['mem_k'])
        expect(purged.hardDeleted).toEqual(['mem_k'])
      }
      return put(rec, hint, skipIf)
    })

    const r = await a.snapshot({ action: 'restore', snapshotId })

    if (r.kind !== 'restored') throw new Error(r.kind)
    expect(r.restored).toEqual(['mem_o'])
    expect(r.skipped).toEqual(['mem_k'])
    expect(r.redacted).toEqual(['mem_k'])
    expect(await a.store.get('mem_k', ctx)).toBeUndefined()
    expect(await allMemoryText()).not.toContain(FAKE_SECRET.sk)
  })
})
