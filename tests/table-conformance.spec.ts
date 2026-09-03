import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore, InMemoryTable, type MemoryTable } from '../src/store.ts'
import { FileTable } from '../src/storage/file-table.ts'
import { GLOBAL_DIR } from '../src/storage/paths.ts'
import { InMemoryKvTable } from '../src/kv-table.ts'
import { runSavePipeline } from '../src/pipeline.ts'
import { executeForget } from '../src/tools/forget.ts'
import { SnapshotStore } from '../src/governance/snapshots.ts'
import { PendingDecisionsStore } from '../src/governance/decisions.ts'
import type { RecallStats } from '../src/storage/schema.ts'
import type { MemorySnapshot, PendingDecision } from '../src/governance/schema.ts'
import { record } from './helpers/record.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'
import { RecordNotFoundError } from '../src/errors.ts'
import { captureRejection } from './helpers/errors.ts'

/** 与 P0/P1 既有测试同一约定：只声明必填字段，可选字段（validTo/supersedes/workspacePath）
 *  只在 partial 里显式传入时才出现——不写成 `key: undefined`，否则 encode/decode 往返后
 *  "键缺失" vs "键存在但值 undefined" 会制造假的不等。 */

interface BackendHandle {
  table: MemoryTable
  cleanup(): Promise<void>
  /** 仅 FileTable 提供：强制重载一遍磁盘，逼真实走 encode→disk→decode。
   *  InMemoryTable 的 map 本来就没有序列化环节，省略此字段即跳过重载步骤。 */
  reload?: () => Promise<void>
  /** 仅 FileTable 提供：记忆根目录，供 markRecalled 的 mtime 断言直接 stat 文件。 */
  root?: string
}
interface Backend { name: string; make(): Promise<BackendHandle> }

const backends: Backend[] = [
  { name: 'InMemoryTable', make: async () => ({ table: new InMemoryTable(), cleanup: async () => {} }) },
  {
    name: 'FileTable',
    make: async () => {
      const root = await mkdtemp(join(tmpdir(), 'pm-conf-'))
      const t = new FileTable({ root, stats: new InMemoryKvTable<RecallStats>() })
      await t.load()
      return { table: t, cleanup: () => rm(root, { recursive: true, force: true }), reload: () => t.load(), root }
    },
  },
]

describe.each(backends)('后端一致性：$name', ({ make }) => {
  let table: MemoryTable
  let cleanup: () => Promise<void>
  let reload: (() => Promise<void>) | undefined
  let root: string | undefined
  let store: MemoryStore

  beforeEach(async () => {
    const handle = await make()
    table = handle.table; cleanup = handle.cleanup; reload = handle.reload; root = handle.root
    store = new MemoryStore(table)
  })
  afterEach(() => cleanup())

  it('put→get 逐字段相等；query 的 visible/status/多词 keyword 语义一致', async () => {
    // FileTable 对 status=deleted 的记录有 14 天保留窗口的顺手清扫（persist 内触发
    // sweepDeletedInner）——updatedAt 必须落在窗口内，否则 put 后文件立刻被清掉，
    // 这不是待证明的行为，用贴近当下的时间戳避免误触发。
    const NOW = Date.now()
    const recGlobal = record({
      id: 'mem_global_cjk', name: '全局记忆卡片', type: 'knowledge', scope: 'global',
      tags: ['pnpm', '环境'], content: '在 macOS 上配置 pnpm 环境变量的方法',
      summary: '全局 pnpm 环境配置摘要',
      createdAt: NOW, updatedAt: NOW, lastConfirmedAt: NOW,
      validTo: NOW + 86_400_000, supersedes: ['mem_old_placeholder'],
    })
    const recA = record({
      id: 'mem_ws_a', name: 'workspace-a-memory', type: 'project', scope: 'workspace',
      workspacePath: '/home/dev/repo-with-hyphens/sub-dir',
      content: '先设置环境变量，再装 pnpm', summary: 'ws-a 摘要',
      createdAt: NOW, updatedAt: NOW, lastConfirmedAt: NOW,
    })
    const recB = record({
      id: 'mem_ws_b', name: 'workspace-b-memory', type: 'project', scope: 'workspace',
      workspacePath: '/home/dev/other-repo',
      content: 'ws-b 的内容', summary: 'ws-b 摘要',
      createdAt: NOW, updatedAt: NOW, lastConfirmedAt: NOW,
    })
    const recADeleted = record({
      id: 'mem_ws_a_deleted', name: 'workspace-a-deleted-memory', type: 'project', scope: 'workspace',
      workspacePath: '/home/dev/repo-with-hyphens/sub-dir',
      content: '已被遗忘的 ws-a 记忆', summary: 'ws-a 已删除摘要', status: 'deleted',
      createdAt: NOW, updatedAt: NOW, lastConfirmedAt: NOW,
    })

    for (const r of [recGlobal, recA, recB, recADeleted]) await table.put(r.id, r)
    if (reload) await reload()

    // put→get 逐字段相等（FileTable 场景下强制先过 encode→disk→decode）
    expect(table.get(recGlobal.id)).toEqual(recGlobal)
    expect(table.get(recA.id)).toEqual(recA)
    expect(table.get(recB.id)).toEqual(recB)
    expect(table.get(recADeleted.id)).toEqual(recADeleted)

    const s = new MemoryStore(table)

    // visible(/repo-with-hyphens/sub-dir) → global + ws=/a，ws=/b 因 scope 不匹配被排除
    const visibleA = s.query({ scope: { kind: 'visible', workspacePath: '/home/dev/repo-with-hyphens/sub-dir' } })
    expect(visibleA.map(r => r.id).sort()).toEqual([recA.id, recGlobal.id].sort())

    // 缺省 status 过滤排除 deleted（即便 scope 命中 visible 范围）
    expect(visibleA.some(r => r.id === recADeleted.id)).toBe(false)
    const deletedOnly = s.query({ status: ['deleted'] })
    expect(deletedOnly.map(r => r.id)).toEqual([recADeleted.id])

    // 多词 keyword：Task 6 起 store.query 是多词 AND（词序无关）。"pnpm 环境" 两词都命中
    // recGlobal（连续子串）与 recA（词序相反但两词都在），recB 不含这两个词故不命中。
    const kwHits = s.query({ keyword: 'pnpm 环境', status: ['active'] })
    expect(kwHits.map(r => r.id).sort()).toEqual([recA.id, recGlobal.id].sort())
  })

  it('update 语义与错误信息一致；softDelete → status=deleted', async () => {
    const rec = record({ id: 'mem_update_1', name: '待更新记忆', content: '原始内容', updatedAt: 1 })
    await table.put(rec.id, rec)

    const updated = await table.update(rec.id, r => ({ ...r, content: '更新后内容', updatedAt: 2 }))
    expect(updated.content).toBe('更新后内容')
    expect(table.get(rec.id)!.content).toBe('更新后内容')

    const err = await captureRejection(table.update('ghost', r => r))
    expect(err).toBeInstanceOf(RecordNotFoundError)
    expect(err).toMatchObject({ id: 'ghost' })

    const ok = await store.softDelete(rec.id)
    expect(ok).toBe(true)
    expect(table.get(rec.id)!.status).toBe('deleted')
    expect(await store.softDelete('ghost2')).toBe(false)
  })

  it('markRecalled 更新统计（等待微任务后断言 recallCount+1）', async () => {
    const rec = record({ id: 'mem_recall_1', name: 'markrecalled-test', content: '待召回内容', updatedAt: 1 })
    await store.put(rec)

    const filePath = root ? join(root, GLOBAL_DIR, 'markrecalled-test.md') : undefined
    const before = filePath ? (await stat(filePath)).mtimeMs : undefined

    store.markRecalled([rec.id])
    await new Promise(setImmediate)

    expect(store.get(rec.id)!.recallCount).toBe(1)
    expect(store.get(rec.id)!.lastRecalledAt).not.toBeNull()

    // §4 核心命题：易变字段的更新只走 sidecar，文件本体不重写——mtime 不变
    if (filePath) {
      const after = (await stat(filePath)).mtimeMs
      expect(after).toBe(before)
    }
  })

  it('pipeline create/update/supersedes 全路径行为一致', async () => {
    const registry = buildTypeRegistry({ template: 'coding', customTypes: {} })
    const session = { id: 'sess-1', lastSeq: 5 }
    const deps = { store, registry, workspacePath: '/home/dev/conformance-proj' as string | undefined, session }

    const created = await runSavePipeline({
      action: 'create', name: '流程A', type: 'procedure', scope: 'global',
      content: '流程A 的内容', summary: '流程A 摘要', tags: ['流程'],
      sourceMode: 'user-explicit', force: true,
    }, deps)
    expect(created.kind).toBe('saved')
    if (created.kind !== 'saved') throw new Error('unreachable')
    expect(store.get(created.record.id)).toEqual(created.record)

    const updated = await runSavePipeline({
      action: 'update', id: created.record.id, name: '流程A-v2', type: 'procedure', scope: 'global',
      content: '流程A 的内容 v2', summary: '流程A 摘要 v2', tags: ['流程'],
      sourceMode: 'user-explicit',
    }, deps)
    expect(updated.kind).toBe('updated')
    if (updated.kind !== 'updated') throw new Error('unreachable')
    expect(updated.record.createdAt).toBe(created.record.createdAt) // update 保留旧 createdAt
    expect(updated.record.content).toBe('流程A 的内容 v2')

    const other = await runSavePipeline({
      action: 'create', name: '流程B（待被取代）', type: 'procedure', scope: 'global',
      content: '流程B 的内容', summary: '流程B 摘要', tags: [],
      sourceMode: 'user-explicit', force: true,
    }, deps)
    expect(other.kind).toBe('saved')
    if (other.kind !== 'saved') throw new Error('unreachable')

    const superseder = await runSavePipeline({
      action: 'create', name: '流程C（取代B）', type: 'procedure', scope: 'global',
      content: '流程C 的内容', summary: '流程C 摘要', tags: [],
      sourceMode: 'user-explicit', force: true, supersedes: [other.record.id],
    }, deps)
    expect(superseder.kind).toBe('saved')
    expect(store.get(other.record.id)!.status).toBe('superseded')

    if (reload) await reload()
    expect(table.get(updated.record.id)!.content).toBe('流程A 的内容 v2')
    expect(table.get(updated.record.id)!.createdAt).toBe(created.record.createdAt)
    expect(table.get(other.record.id)!.status).toBe('superseded')
  })

  it('forget 批量 + 快照先行 + restore 复活：端到端一致', async () => {
    const snapshots = new SnapshotStore(new InMemoryKvTable<MemorySnapshot>())
    const decisions = new PendingDecisionsStore(new InMemoryKvTable<PendingDecision>())
    const rec = record({ id: 'mem_forget_1', name: '待遗忘记忆', content: '要被遗忘的内容', updatedAt: 1 })
    await store.put(rec)

    const forgetDeps = { store, snapshots, decisions, now: () => 5000 }
    const result = await executeForget({ ids: [rec.id], reason: '测试遗忘' }, forgetDeps)
    expect(result.ok).toBe(true)
    expect(result.forgotten).toEqual([rec.id])
    expect(store.get(rec.id)!.status).toBe('deleted')

    const snap = snapshots.get(result.snapshotId!)!
    expect(snap.data).toHaveLength(1)
    expect(snap.data[0].id).toBe(rec.id)
    expect(snap.data[0].status).toBe('active') // 快照记的是删除前的状态

    const { restored } = await snapshots.restore(
      snap, undefined, r => store.put(r), id => store.get(id), false,
    )
    expect(restored).toEqual([rec.id])
    expect(store.get(rec.id)!.status).toBe('active')

    if (reload) await reload()
    expect(table.get(rec.id)!.status).toBe('active') // FileTable：重载后复活仍成立
  })

  it('put 不承载召回统计：restore 旧记录不回退 recallCount/lastRecalledAt（设计稿 §3 登记语义）', async () => {
    const r = record({ id: 'mem_vol', name: '统计保持' })
    await table.put('mem_vol', r)
    await table.update('mem_vol', c => ({ ...c, recallCount: 7, lastRecalledAt: 1787200000000 }))
    // 模拟 snapshots.restore：把快照时点的旧记录（recallCount=0）整条 put 回来
    await table.put('mem_vol', { ...r, summary: '恢复后的摘要' })
    const after = table.get('mem_vol')!
    expect(after.summary).toBe('恢复后的摘要')  // 稳定字段照常恢复
    expect(after.recallCount).toBe(7)           // 召回统计不回退
    expect(after.lastRecalledAt).toBe(1787200000000)
    if (reload) {
      await reload()
      const reloaded = table.get('mem_vol')!
      expect(reloaded.recallCount).toBe(7)      // sidecar 一致：重载前后同值
      expect(reloaded.lastRecalledAt).toBe(1787200000000)
    }
  })

})
