import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore, InMemoryTable, type MemoryTable, type SeedRecord } from '../src/store.ts'
import { FileTable } from '../src/storage/file-table.ts'
import { encodeRecord } from '../src/storage/frontmatter.ts'
import { ARCHIVE_DIR, GLOBAL_DIR, WORKSPACE_MARKER, deriveFileId, workspaceDirName } from '../src/storage/paths.ts'
import { InMemoryKvTable, InMemoryBatchKvTable, type BatchKvTable } from '../src/kv-table.ts'
import { SidecarStore } from '../src/storage/sidecar.ts'
import { runSavePipeline } from '../src/pipeline.ts'
import { executeForget } from '../src/tools/forget.ts'
import { SnapshotStore } from '../src/governance/snapshots.ts'
import { PendingDecisionsStore } from '../src/governance/decisions.ts'
import type { RecallStats } from '../src/storage/schema.ts'
import type { MemoryRecord } from '../src/record-schema.ts'
import {
  memorySnapshotSchema, pendingDecisionSchema, scanCacheSchema,
  type MemorySnapshot, type PendingDecision,
} from '../src/governance/schema.ts'
import { record } from './helpers/record.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'
import { RecordNotFoundError } from '../src/errors.ts'
import { RETENTION_MS } from '../src/retention.ts'
import { captureRejection } from './helpers/errors.ts'

/** 与 P0/P1 既有测试同一约定：只声明必填字段，可选字段（validTo/supersedes/workspacePath）
 *  只在 partial 里显式传入时才出现——不写成 `key: undefined`，否则 encode/decode 往返后
 *  "键缺失" vs "键存在但值 undefined" 会制造假的不等。 */

/** 往一个目录直接放文件（对应手写 / 外部落盘 / 备份复制出的文件），绕过 put：两个后端各自实现。 */
interface SeedFile { dir: string; fileName: string; record: SeedRecord; archived?: boolean }

interface BackendHandle {
  table: MemoryTable
  /** 召回统计侧表：FileTable 用真实的 .state/recall-stats.json，InMemoryTable 用内存表。 */
  stats: BatchKvTable<RecallStats>
  cleanup(): Promise<void>
  /** 仅 FileTable 提供（现为空操作）：没有常驻表之后每次读都走 encode→disk→decode，保留调用点让断言照跑。 */
  reload?: () => Promise<void>
  /** 仅 FileTable 提供：记忆根目录，供 markRecalled 的 mtime 断言直接 stat 文件。 */
  root?: string
  /** 两个后端共用的目录名（storage/paths 同源）：readScope 的 dirs 用它表达。 */
  globalDir: string
  wsDir(workspacePath: string): string
  seedFile(file: SeedFile): Promise<void>
}
interface Backend { name: string; make(): Promise<BackendHandle> }

/** 手写文件：只写有的键；缺 id 就不写 id 行（FileTable 据相对路径派生）。 */
function handWritten(r: SeedRecord): string {
  if (r.id !== undefined) return encodeRecord(r as MemoryRecord, {})
  const { content, ...rest } = r
  const lines = ['---', `name: ${rest.name}`, `type: ${rest.type}`]
  if (rest.summary) lines.push(`summary: ${rest.summary}`)
  return `${lines.join('\n')}\n---\n\n${content}\n`
}

const backends: Backend[] = [
  {
    name: 'InMemoryTable',
    make: async () => {
      const root = '/in-memory'
      const t = new InMemoryTable(root)
      return {
        table: t, stats: new InMemoryBatchKvTable<RecallStats>(), cleanup: async () => {},
        globalDir: join(root, GLOBAL_DIR), wsDir: p => join(root, workspaceDirName(p)),
        seedFile: async f => { t.seedFile(f) },
      }
    },
  },
  {
    name: 'FileTable',
    make: async () => {
      const root = await mkdtemp(join(tmpdir(), 'pm-conf-'))
      const { recallStats: stats } = new SidecarStore({
        root, schemas: { snapshots: memorySnapshotSchema, pending: pendingDecisionSchema, scanCache: scanCacheSchema },
      })
      const t = new FileTable({ root, stats })
      return {
        table: t, stats, cleanup: () => rm(root, { recursive: true, force: true }), reload: async () => {}, root,
        globalDir: join(root, GLOBAL_DIR), wsDir: p => join(root, workspaceDirName(p)),
        seedFile: async f => {
          const dir = f.archived ? join(f.dir, ARCHIVE_DIR) : f.dir
          await mkdir(dir, { recursive: true })
          if (f.record.scope === 'workspace') await writeFile(join(f.dir, WORKSPACE_MARKER), `${f.record.workspacePath}\n`)
          await writeFile(join(dir, f.fileName), handWritten(f.record))
        },
      }
    },
  },
]

describe.each(backends)('后端一致性：$name', ({ make }) => {
  let table: MemoryTable
  let cleanup: () => Promise<void>
  let reload: (() => Promise<void>) | undefined
  let root: string | undefined
  let stats: BatchKvTable<RecallStats>
  let store: MemoryStore
  let h: BackendHandle

  beforeEach(async () => {
    h = await make()
    const handle = h
    table = handle.table; stats = handle.stats; cleanup = handle.cleanup; reload = handle.reload; root = handle.root
    store = new MemoryStore(table, undefined, stats)
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
      createdAt: NOW, updatedAt: NOW, lastConfirmedAt: NOW, deletedAt: NOW,   // 缺 deletedAt 时写路径会补 now，显式给定保证逐字段相等
    })

    for (const r of [recGlobal, recA, recB, recADeleted]) await table.put(r.id, r)
    if (reload) await reload()

    // put→get 逐字段相等（FileTable 场景下强制先过 encode→disk→decode）
    expect((await table.locate(recGlobal.id))?.record).toEqual(recGlobal)
    expect((await table.locate(recA.id))?.record).toEqual(recA)
    expect((await table.locate(recB.id))?.record).toEqual(recB)
    expect((await table.locate(recADeleted.id))?.record).toEqual(recADeleted)

    const s = new MemoryStore(table)

    // visible(/repo-with-hyphens/sub-dir) → global + ws=/a，ws=/b 因 scope 不匹配被排除
    const visibleA = await s.query({ scope: { kind: 'visible', workspacePath: '/home/dev/repo-with-hyphens/sub-dir' } })
    expect(visibleA.map(r => r.id).sort()).toEqual([recA.id, recGlobal.id].sort())

    // 缺省 status 过滤排除 deleted（即便 scope 命中 visible 范围）
    expect(visibleA.some(r => r.id === recADeleted.id)).toBe(false)
    const deletedOnly = await s.query({ status: ['deleted'] })
    expect(deletedOnly.map(r => r.id)).toEqual([recADeleted.id])

    // 多词 keyword：Task 6 起 store.query 是多词 AND（词序无关）。"pnpm 环境" 两词都命中
    // recGlobal（连续子串）与 recA（词序相反但两词都在），recB 不含这两个词故不命中。
    const kwHits = await s.query({ keyword: 'pnpm 环境', status: ['active'] })
    expect(kwHits.map(r => r.id).sort()).toEqual([recA.id, recGlobal.id].sort())
  })

  it('update 语义与错误信息一致；softDelete → status=deleted', async () => {
    const rec = record({ id: 'mem_update_1', name: '待更新记忆', content: '原始内容', updatedAt: 1 })
    await table.put(rec.id, rec)

    const updated = await table.update(rec.id, r => ({ ...r, content: '更新后内容', updatedAt: 2 }))
    expect(updated.content).toBe('更新后内容')
    expect(((await table.locate(rec.id))?.record)!.content).toBe('更新后内容')

    const err = await captureRejection(table.update('ghost', r => r))
    expect(err).toBeInstanceOf(RecordNotFoundError)
    expect(err).toMatchObject({ id: 'ghost' })

    const ok = await store.softDelete(rec.id)
    expect(ok).toBe(true)
    expect(((await table.locate(rec.id))?.record)!.status).toBe('deleted')
    expect(await store.softDelete('ghost2')).toBe(false)
  })

  it('markRecalled 只写召回统计侧表：统计 +1，不经 table.update、不逐 id 定位，记忆文件 mtime 不变', async () => {
    const rec = record({ id: 'mem_recall_1', name: 'markrecalled-test', content: '待召回内容', updatedAt: 1 })
    await store.put(rec)

    const filePath = root ? join(root, GLOBAL_DIR, 'markrecalled-test.md') : undefined
    const before = filePath ? (await stat(filePath)).mtimeMs : undefined
    const update = vi.spyOn(table, 'update')
    const locate = vi.spyOn(table, 'locate')
    const putMany = vi.spyOn(stats, 'putMany')

    await store.markRecalled([rec.id])
    await store.markRecalled([rec.id, rec.id])

    expect(update).not.toHaveBeenCalled()
    // ids 来自调用方同一次读取的结果（search 命中、快照 core 区），存活由那次读保证，不再逐 id 两级定位
    expect(locate).not.toHaveBeenCalled()
    expect(putMany).toHaveBeenCalledTimes(2) // 每次 markRecalled 只批量写一次，不论几个 id
    const row = await stats.get(rec.id)
    expect(row).toMatchObject({ id: rec.id, recallCount: 3 })
    expect(row!.lastRecalledAt).not.toBeNull()

    // 设计稿 §7 核心命题：召回统计只走侧表，文件本体不重写——mtime 不变
    if (filePath) {
      const after = (await stat(filePath)).mtimeMs
      expect(after).toBe(before)
    }
    // FileTable 的合并读法不变：重载后记录带上侧表里的统计
    if (reload) {
      await reload()
      expect(((await table.locate(rec.id))?.record)!.recallCount).toBe(3)
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
    expect(await store.get(created.record.id)).toEqual(created.record)

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
    expect((await store.get(other.record.id))!.status).toBe('superseded')

    if (reload) await reload()
    expect(((await table.locate(updated.record.id))?.record)!.content).toBe('流程A 的内容 v2')
    expect(((await table.locate(updated.record.id))?.record)!.createdAt).toBe(created.record.createdAt)
    expect(((await table.locate(other.record.id))?.record)!.status).toBe('superseded')
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
    expect((await store.get(rec.id))!.status).toBe('deleted')

    const snap = (await snapshots.get(result.snapshotId!))!
    expect(snap.data).toHaveLength(1)
    expect(snap.data[0].id).toBe(rec.id)
    expect(snap.data[0].status).toBe('active') // 快照记的是删除前的状态

    const byId = new Map((await store.query({ status: ['active', 'superseded', 'deleted'] })).map(r => [r.id, r]))
    const { restored } = await snapshots.restore(
      snap, undefined, r => store.put(r), byId, false,
    )
    expect(restored).toEqual([rec.id])
    expect((await store.get(rec.id))!.status).toBe('active')

    if (reload) await reload()
    expect(((await table.locate(rec.id))?.record)!.status).toBe('active') // FileTable：重载后复活仍成立
  })

  it('put 不承载召回统计：restore 旧记录不回退 recallCount/lastRecalledAt（设计稿 §3 登记语义）', async () => {
    const r = record({ id: 'mem_vol', name: '统计保持' })
    await table.put('mem_vol', r)
    await table.update('mem_vol', c => ({ ...c, recallCount: 7, lastRecalledAt: 1787200000000 }))
    // 模拟 snapshots.restore：把快照时点的旧记录（recallCount=0）整条 put 回来
    await table.put('mem_vol', { ...r, summary: '恢复后的摘要' })
    const after = ((await table.locate('mem_vol'))?.record)!
    expect(after.summary).toBe('恢复后的摘要')  // 稳定字段照常恢复
    expect(after.recallCount).toBe(7)           // 召回统计不回退
    expect(after.lastRecalledAt).toBe(1787200000000)
    if (reload) {
      await reload()
      const reloaded = ((await table.locate('mem_vol'))?.record)!
      expect(reloaded.recallCount).toBe(7)      // sidecar 一致：重载前后同值
      expect(reloaded.lastRecalledAt).toBe(1787200000000)
    }
  })


  // —— 票 08：按范围读取、两级定位、取舍（docs/design-storage-file-is-memory.md §3 §4）——

  const WS_A = '/home/dev/proj-a'
  const WS_B = '/home/dev/proj-b'
  const ws = (workspacePath: string, partial: Partial<MemoryRecord> = {}) =>
    record({ scope: 'workspace', workspacePath, ...partial })

  it('两级定位：提示目录命中即止（别的项目里更新的副本看不到）；提示目录无命中才扫全部 workspace 目录', async () => {
    await h.seedFile({ dir: h.wsDir(WS_A), fileName: 'dup.md', record: ws(WS_A, { id: 'mem_dup', content: 'A 的旧副本', updatedAt: 100 }) })
    await h.seedFile({ dir: h.wsDir(WS_B), fileName: 'dup.md', record: ws(WS_B, { id: 'mem_dup', content: 'B 的新副本', updatedAt: 200 }) })

    const hitA = await table.locate('mem_dup', { workspacePath: WS_A })
    expect(hitA!.record.content).toBe('A 的旧副本')             // 一级命中即止，B 的更新副本不参与
    expect(hitA!.dir).toBe(h.wsDir(WS_A))
    expect(hitA!.filePath).toBe(join(h.wsDir(WS_A), 'dup.md'))

    const fromElsewhere = await table.locate('mem_dup', { workspacePath: '/home/dev/proj-c' })
    expect(fromElsewhere!.record.content).toBe('B 的新副本')     // 落到二级：全部 workspace 目录，updatedAt 新者
    expect((await table.locate('mem_dup'))!.record.content).toBe('B 的新副本')  // 无提示同样落到二级
    expect(await table.locate('mem_ghost', { workspacePath: WS_A })).toBeUndefined()
  })

  it('同 id 取舍①：updatedAt 新者优先，压过目录偏好', async () => {
    await h.seedFile({ dir: h.globalDir, fileName: 'g.md', record: record({ id: 'mem_r1', content: 'global 较新', updatedAt: 200 }) })
    await h.seedFile({ dir: h.wsDir(WS_A), fileName: 'w.md', record: ws(WS_A, { id: 'mem_r1', content: '提示目录较旧', updatedAt: 100 }) })
    expect((await table.locate('mem_r1', { workspacePath: WS_A }))!.record.content).toBe('global 较新')
  })

  it('同 id 取舍②：updatedAt 相同时提示的 workspace 目录优先于 global', async () => {
    await h.seedFile({ dir: h.globalDir, fileName: 'g.md', record: record({ id: 'mem_r2', content: 'global', updatedAt: 100 }) })
    await h.seedFile({ dir: h.wsDir(WS_A), fileName: 'w.md', record: ws(WS_A, { id: 'mem_r2', content: '提示目录', updatedAt: 100 }) })
    expect((await table.locate('mem_r2', { workspacePath: WS_A }))!.record.content).toBe('提示目录')
  })

  it('同 id 取舍③：global 优先于其他项目（不带范围的 query 无提示取舍）', async () => {
    await h.seedFile({ dir: h.globalDir, fileName: 'g.md', record: record({ id: 'mem_r3', content: 'global', updatedAt: 100 }) })
    await h.seedFile({ dir: h.wsDir(WS_B), fileName: 'w.md', record: ws(WS_B, { id: 'mem_r3', content: '其他项目', updatedAt: 100 }) })
    const all = await store.query({})
    expect(all.filter(r => r.id === 'mem_r3').map(r => r.content)).toEqual(['global'])
    expect(((await table.locate('mem_r3'))?.record)!.content).toBe('global')
  })

  it('query 按范围读：可见集合 = global + 当前 workspace 目录，同 id 多文件只返回一条（新者优先，相等时当前 workspace 优先）', async () => {
    await h.seedFile({ dir: h.globalDir, fileName: 'n.md', record: record({ id: 'mem_q1', content: 'global 较新', updatedAt: 200 }) })
    await h.seedFile({ dir: h.wsDir(WS_A), fileName: 'n.md', record: ws(WS_A, { id: 'mem_q1', content: '本项目较旧', updatedAt: 100 }) })
    await h.seedFile({ dir: h.globalDir, fileName: 't.md', record: record({ id: 'mem_q2', content: 'global 同时', updatedAt: 100 }) })
    await h.seedFile({ dir: h.wsDir(WS_A), fileName: 't.md', record: ws(WS_A, { id: 'mem_q2', content: '本项目同时', updatedAt: 100 }) })
    await h.seedFile({ dir: h.wsDir(WS_B), fileName: 'b.md', record: ws(WS_B, { id: 'mem_q3', content: '别的项目' }) })
    const visible = await store.query({ scope: { kind: 'visible', workspacePath: WS_A } })
    expect(visible.map(r => [r.id, r.content]).sort()).toEqual([['mem_q1', 'global 较新'], ['mem_q2', '本项目同时']])
    expect(await table.workspaceDirs(WS_A)).toEqual([h.wsDir(WS_A)])
  })

  it('同 id 取舍④：提示的 workspace 目录优先于其他项目，⑤ 都是其他项目时按文件路径字典序', async () => {
    await h.seedFile({ dir: h.wsDir(WS_A), fileName: 'a.md', record: ws(WS_A, { id: 'mem_r4', content: '提示目录', updatedAt: 100 }) })
    await h.seedFile({ dir: h.wsDir(WS_B), fileName: 'b.md', record: ws(WS_B, { id: 'mem_r4', content: '其他项目', updatedAt: 100 }) })
    expect((await table.locate('mem_r4', { workspacePath: WS_A }))!.record.content).toBe('提示目录')

    await h.seedFile({ dir: h.wsDir(WS_B), fileName: 'z.md', record: ws(WS_B, { id: 'mem_r5', content: 'z 文件', updatedAt: 100 }) })
    await h.seedFile({ dir: h.wsDir(WS_B), fileName: 'b.md', record: ws(WS_B, { id: 'mem_r5', content: 'b 文件', updatedAt: 100 }) })
    const picked = await table.locate('mem_r5', { workspacePath: WS_A })   // 二级：两份都在其他项目
    expect(picked!.record.content).toBe('b 文件')
    expect(picked!.filePath).toBe(join(h.wsDir(WS_B), 'b.md'))
  })

  it('派生 id：只有 name/type/正文的文件 readScope 返回派生 id，locate 能按它找到（不读内容）', async () => {
    const { id: _id, ...noId } = record({ name: '手建', type: 'knowledge', content: '手写的正文' })
    await h.seedFile({ dir: h.globalDir, fileName: '手建.md', record: noId })
    const expected = deriveFileId(`${GLOBAL_DIR}/手建.md`)
    const read = await table.readScope([h.globalDir])
    expect(read.records.map(r => r.record.id)).toEqual([expected])
    expect(read.records[0].record).toMatchObject({ name: '手建', content: '手写的正文', scope: 'global' })
    const hit = await table.locate(expected)
    expect(hit!.filePath).toBe(join(h.globalDir, '手建.md'))
    expect(hit!.record.name).toBe('手建')
    expect(await table.locate(deriveFileId(`${GLOBAL_DIR}/不存在.md`))).toBeUndefined()
  })

  it('派生 id 写回后跟着记录走：改名让文件换了路径，仍能按原派生 id 定位', async () => {
    const { id: _id, ...noId } = record({ name: '手建', type: 'knowledge', content: '手写的正文' })
    await h.seedFile({ dir: h.globalDir, fileName: '手建.md', record: noId })
    const derived = deriveFileId(`${GLOBAL_DIR}/手建.md`)
    await table.update(derived, r => ({ ...r, name: '改过名', updatedAt: r.updatedAt + 1 }))
    const hit = await table.locate(derived)
    expect(hit).toBeDefined()
    expect(hit!.record.name).toBe('改过名')
    expect(hit!.filePath).toBe(join(h.globalDir, '改过名.md'))
    expect(await table.locate(deriveFileId(`${GLOBAL_DIR}/改过名.md`))).toBeUndefined()   // 新路径的哈希不是它的 id
  })

  it('update 锁内重读：fn 看到的是磁盘当前内容，外部修改不丢', async () => {
    await table.put('mem_ext', record({ id: 'mem_ext', name: 'ext', content: '原始', updatedAt: 1 }))
    // 外部覆盖同一个文件（put 落的文件名是 slug(name).md）
    await h.seedFile({ dir: h.globalDir, fileName: 'ext.md', record: record({ id: 'mem_ext', name: 'ext', content: '外部改过', updatedAt: 2 }) })
    const next = await table.update('mem_ext', r => ({ ...r, content: `${r.content}+追加`, updatedAt: 3 }))
    expect(next.content).toBe('外部改过+追加')
    expect(((await table.locate('mem_ext'))?.record)!.content).toBe('外部改过+追加')
  })

  it('readScope：缺省只读顶层，includeArchive 连 .archive/ 一起读；types 在解析后过滤；记录含非 active', async () => {
    await h.seedFile({ dir: h.wsDir(WS_A), fileName: 'k.md', record: ws(WS_A, { id: 'mem_k', type: 'knowledge' }) })
    await h.seedFile({ dir: h.wsDir(WS_A), fileName: 'p.md', record: ws(WS_A, { id: 'mem_p', type: 'project', status: 'superseded' }) })
    await h.seedFile({ dir: h.wsDir(WS_A), fileName: 'd.md', record: ws(WS_A, { id: 'mem_d', type: 'project', status: 'deleted' }), archived: true })
    await h.seedFile({ dir: h.globalDir, fileName: 'g.md', record: record({ id: 'mem_g', type: 'project' }) })
    const ids = (r: { records: Array<{ record: MemoryRecord }> }) => r.records.map(x => x.record.id).sort()

    expect(ids(await table.readScope([h.wsDir(WS_A)]))).toEqual(['mem_k', 'mem_p'])
    expect(ids(await table.readScope([h.wsDir(WS_A)], { includeArchive: true }))).toEqual(['mem_d', 'mem_k', 'mem_p'])
    expect(ids(await table.readScope([h.wsDir(WS_A), h.globalDir], { includeArchive: true, types: ['project'] }))).toEqual(['mem_d', 'mem_g', 'mem_p'])
    expect(ids(await table.readScope([h.globalDir]))).toEqual(['mem_g'])
    const archived = (await table.readScope([h.wsDir(WS_A)], { includeArchive: true })).records.find(r => r.record.id === 'mem_d')!
    expect(archived.dir).toBe(h.wsDir(WS_A))
    expect(archived.filePath).toBe(join(h.wsDir(WS_A), ARCHIVE_DIR, 'd.md'))
  })

  it('listWorkspaceDirs：顶层有记忆文件的 hasActiveTopLevel 为真；只剩归档的为假并带 dir-empty 说明', async () => {
    await h.seedFile({ dir: h.wsDir(WS_A), fileName: 'a.md', record: ws(WS_A, { id: 'mem_a' }) })
    await h.seedFile({ dir: h.wsDir(WS_B), fileName: 'b.md', record: ws(WS_B, { id: 'mem_b', status: 'deleted' }), archived: true })
    await h.seedFile({ dir: h.globalDir, fileName: 'g.md', record: record({ id: 'mem_g' }) })
    const listing = await table.listWorkspaceDirs()
    expect(listing.entries.sort((x, y) => (x.dir < y.dir ? -1 : 1))).toEqual([
      { workspacePath: WS_A, dir: h.wsDir(WS_A), hasActiveTopLevel: true },
      { workspacePath: WS_B, dir: h.wsDir(WS_B), hasActiveTopLevel: false },
    ].sort((x, y) => (x.dir < y.dir ? -1 : 1)))
    expect(listing.directoryNotes.map(n => [n.code, n.path])).toEqual([['dir-empty', h.wsDir(WS_B)]])
    // 定位用全部目录：只剩归档的目录也能按 id 找到
    expect((await table.locate('mem_b'))!.record.status).toBe('deleted')
  })

  // —— 票 10：写路径内核（docs/design-storage-file-is-memory.md §3 §5）——

  const topLevel = async (dir: string) =>
    (await table.readScope([dir], { includeArchive: true })).records.map(r => [r.record.id, r.filePath] as const)

  it('create 不定位：不调用 locate 直接占名落盘；同名异 id 两条都在、文件名不同', async () => {
    const locate = vi.spyOn(table, 'locate')
    await table.create(ws(WS_A, { id: 'mem_c1', name: '同名', content: '第一条' }))
    await table.create(ws(WS_A, { id: 'mem_c2', name: '同名', content: '第二条' }))
    expect(locate).not.toHaveBeenCalled()
    const rows = await topLevel(h.wsDir(WS_A))
    expect(rows.map(([id]) => id).sort()).toEqual(['mem_c1', 'mem_c2'])
    expect(new Set(rows.map(([, p]) => p)).size).toBe(2)
    expect((await table.locate('mem_c2', { workspacePath: WS_A }))!.record.content).toBe('第二条')
  })

  it('put 跨目录定位旧文件：global put 不带 workspacePath 也找到 workspace 里的旧文件并搬家，旧目录无、新目录有', async () => {
    await h.seedFile({ dir: h.wsDir(WS_A), fileName: 'mv.md', record: ws(WS_A, { id: 'mem_mv', name: 'mv', content: '搬家前', updatedAt: 1 }) })
    const { workspacePath: _w, ...rest } = ws(WS_A, { id: 'mem_mv', name: 'mv', content: '搬家后', updatedAt: 2 })
    await table.put('mem_mv', { ...rest, scope: 'global' })
    expect(await topLevel(h.wsDir(WS_A))).toEqual([])
    const inGlobal = await topLevel(h.globalDir)
    expect(inGlobal.map(([id]) => id)).toEqual(['mem_mv'])
    expect((await table.locate('mem_mv'))!.record).toMatchObject({ scope: 'global', content: '搬家后' })
  })

  it('status 变为 deleted / superseded 时文件移入同目录 .archive/，deleted 补 deletedAt；回到 active 搬回顶层', async () => {
    const NOW = Date.now()   // deleted 的 updatedAt 要落在 14 天保留窗口内，否则写路径末尾的清扫会顺手删掉它
    await table.create(ws(WS_A, { id: 'mem_del', name: 'del', updatedAt: NOW - 3 }))
    await table.create(ws(WS_A, { id: 'mem_sup', name: 'sup', updatedAt: NOW - 3 }))
    const dir = h.wsDir(WS_A)
    await table.update('mem_del', r => ({ ...r, status: 'deleted', updatedAt: NOW - 2 }))
    await table.update('mem_sup', r => ({ ...r, status: 'superseded', updatedAt: NOW - 2 }))
    const rows = new Map(await topLevel(dir))
    expect(rows.get('mem_del')).toBe(join(dir, ARCHIVE_DIR, 'del.md'))
    expect(rows.get('mem_sup')).toBe(join(dir, ARCHIVE_DIR, 'sup.md'))
    expect((await table.readScope([dir])).records).toEqual([])                      // 顶层已空
    const deleted = (await table.locate('mem_del', { workspacePath: WS_A }))!.record
    expect(typeof deleted.deletedAt).toBe('number')
    expect((await table.locate('mem_sup', { workspacePath: WS_A }))!.record.deletedAt).toBeUndefined()

    // 显式给的 deletedAt 不被覆盖（取窗口内的值：清扫按 deletedAt 计 14 天）
    await table.update('mem_sup', r => ({ ...r, status: 'deleted', deletedAt: NOW - 777, updatedAt: NOW - 1 }))
    expect((await table.locate('mem_sup', { workspacePath: WS_A }))!.record.deletedAt).toBe(NOW - 777)

    // restore：整条 put 回 active（无 deletedAt）→ 从 .archive/ 搬回顶层，归档文件消失
    await table.put('mem_del', ws(WS_A, { id: 'mem_del', name: 'del', updatedAt: NOW }))
    const after = await topLevel(dir)
    expect(after.find(([id]) => id === 'mem_del')![1]).toBe(join(dir, 'del.md'))
    expect(after.filter(([id]) => id === 'mem_del')).toHaveLength(1)
    expect((await table.locate('mem_del', { workspacePath: WS_A }))!.record.deletedAt).toBeUndefined()
  })

  it('delete 物理删除，含 .archive/ 里的文件', async () => {
    await table.create(record({ id: 'mem_gone', name: 'gone', updatedAt: Date.now() - 1 }))
    await table.update('mem_gone', r => ({ ...r, status: 'deleted', updatedAt: Date.now() }))   // 保留窗口内，不被清扫
    expect((await topLevel(h.globalDir)).map(([, p]) => p)).toEqual([join(h.globalDir, ARCHIVE_DIR, 'gone.md')])
    expect(await table.delete('mem_gone')).toBe(true)
    expect(await table.locate('mem_gone')).toBeUndefined()
    expect(await topLevel(h.globalDir)).toEqual([])
    expect(await table.delete('mem_gone')).toBe(false)
  })

  // —— 票 11：维护点（docs/design-storage-file-is-memory.md §5）——

  it('maintain：顶层非 active 文件搬进 .archive/（deleted 补 deletedAt，superseded 不补）；active 留在顶层', async () => {
    const dir = h.wsDir(WS_A)
    await h.seedFile({ dir, fileName: 'del.md', record: ws(WS_A, { id: 'mem_del', status: 'deleted' }) })
    await h.seedFile({ dir, fileName: 'sup.md', record: ws(WS_A, { id: 'mem_sup', status: 'superseded' }) })
    await h.seedFile({ dir, fileName: 'live.md', record: ws(WS_A, { id: 'mem_live' }) })
    await table.maintain([dir])
    expect((await table.readScope([dir])).records.map(r => r.record.id)).toEqual(['mem_live'])
    const rows = new Map(await topLevel(dir))
    expect(rows.get('mem_del')).toBe(join(dir, ARCHIVE_DIR, 'del.md'))
    expect(rows.get('mem_sup')).toBe(join(dir, ARCHIVE_DIR, 'sup.md'))
    expect(typeof (await table.locate('mem_del', { workspacePath: WS_A }))!.record.deletedAt).toBe('number')
    expect((await table.locate('mem_sup', { workspacePath: WS_A }))!.record.deletedAt).toBeUndefined()
  })

  it('.archive/ 里 status 仍为 active 的文件按位置视为无效：readLayer / query 不把它当 active；maintain 把它归一成 deleted', async () => {
    const dir = h.wsDir(WS_A)
    await h.seedFile({ dir, fileName: 'stray.md', record: ws(WS_A, { id: 'mem_stray' }), archived: true })
    await h.seedFile({ dir, fileName: 'live.md', record: ws(WS_A, { id: 'mem_live' }) })
    const layer = await store.readLayer({ kind: 'workspace', path: WS_A }, { includeArchive: true })
    expect(layer.records.find(r => r.record.id === 'mem_stray')!.record.status).toBe('deleted')
    expect((await store.query({ scope: { kind: 'workspace', path: WS_A }, status: ['active', 'superseded', 'deleted'] }))
      .map(r => [r.id, r.status]).sort()).toEqual([['mem_live', 'active'], ['mem_stray', 'deleted']])
    await table.maintain([dir])
    const hit = (await table.locate('mem_stray', { workspacePath: WS_A }))!
    expect(hit.record.status).toBe('deleted')
    expect(typeof hit.record.deletedAt).toBe('number')
    expect(hit.filePath).toBe(join(dir, ARCHIVE_DIR, 'stray.md'))   // 不搬回顶层
  })

  it('maintain：.archive/ 里 deletedAt 超 14 天的物理删除（判据是 deletedAt）；superseded 与窗口内的 deleted 保留', async () => {
    const now = Date.now()
    const old = now - RETENTION_MS - 86_400_000
    await h.seedFile({ dir: h.globalDir, fileName: 'gone.md', record: record({ id: 'mem_gone', status: 'deleted', updatedAt: now, deletedAt: old }), archived: true })
    await h.seedFile({ dir: h.globalDir, fileName: 'fresh.md', record: record({ id: 'mem_fresh', status: 'deleted', updatedAt: old, deletedAt: now }), archived: true })
    await h.seedFile({ dir: h.globalDir, fileName: 'sup.md', record: record({ id: 'mem_sup', status: 'superseded', updatedAt: old }), archived: true })
    await table.maintain([h.globalDir])
    expect((await topLevel(h.globalDir)).map(([id]) => id).sort()).toEqual(['mem_fresh', 'mem_sup'])
    expect(await table.locate('mem_gone')).toBeUndefined()
  })

  it('同 id 副本只在写该 id 时清理，且只删可见集合（global + 该记录的 workspace 目录，含 .archive/）内的其余副本', async () => {
    const now = Date.now()
    await h.seedFile({ dir: h.wsDir(WS_A), fileName: 'cur.md', record: ws(WS_A, { id: 'mem_c', content: '当前', updatedAt: now - 1 }) })
    await h.seedFile({ dir: h.globalDir, fileName: 'cur-g.md', record: record({ id: 'mem_c', content: 'global 副本', updatedAt: now - 2 }) })
    await h.seedFile({ dir: h.wsDir(WS_A), fileName: 'cur-old.md', record: ws(WS_A, { id: 'mem_c', content: '归档副本', status: 'deleted', updatedAt: now - 3, deletedAt: now }), archived: true })
    await h.seedFile({ dir: h.wsDir(WS_B), fileName: 'cur.md', record: ws(WS_B, { id: 'mem_c', content: '别的项目', updatedAt: now - 4 }) })
    await h.seedFile({ dir: h.globalDir, fileName: 'by-1.md', record: record({ id: 'mem_by', updatedAt: 100 }) })
    await h.seedFile({ dir: h.globalDir, fileName: 'by-2.md', record: record({ id: 'mem_by', updatedAt: 200 }) })
    // 维护点本身不删副本
    await table.maintain([h.globalDir, h.wsDir(WS_A)])
    expect((await topLevel(h.globalDir)).filter(([id]) => id === 'mem_by')).toHaveLength(2)
    expect((await table.readScope([h.globalDir, h.wsDir(WS_A)], { includeArchive: true })).records.filter(r => r.record.id === 'mem_c')).toHaveLength(3)

    // put 带 workspacePath：一级定位 global + 本项目目录，取舍到 updatedAt 最新的本项目那份
    await table.put('mem_c', ws(WS_A, { id: 'mem_c', content: '改过', updatedAt: now }))
    const visible = (await table.readScope([h.globalDir, h.wsDir(WS_A)], { includeArchive: true })).records
    expect(visible.filter(r => r.record.id === 'mem_c').map(r => r.filePath)).toEqual([join(h.wsDir(WS_A), 'cur.md')])
    expect(visible.filter(r => r.record.id === 'mem_by')).toHaveLength(2)                        // 别的 id 的副本不动
    expect((await topLevel(h.wsDir(WS_B))).map(([id, p]) => [id, p])).toEqual([['mem_c', join(h.wsDir(WS_B), 'cur.md')]])   // 其他项目不动
    expect((await table.locate('mem_c', { workspacePath: WS_A }))!.record.content).toBe('改过')
  })

})
