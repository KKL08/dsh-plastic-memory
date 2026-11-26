import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { FileTable } from '../src/storage/file-table.ts'
import { OpJournal } from '../src/storage/op-journal.ts'
import { createRootLock, type SqliteModule } from '../src/storage/root-lock.ts'
import { GLOBAL_DIR } from '../src/storage/paths.ts'
import { QUICK_CORRECTION_WINDOW_MS } from '../src/storage/usage-signals.ts'
import type { RecallStats } from '../src/storage/schema.ts'
import { MemoryStore } from '../src/store.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'
import { executeSearch, type SearchToolDeps } from '../src/tools/search.ts'
import { executeConfirm } from '../src/tools/confirm.ts'
import { UNKNOWN_SESSION_ID } from '../src/tools/host-session.ts'
import { runSavePipeline } from '../src/pipeline.ts'
import { PendingDecisionsStore } from '../src/governance/decisions.ts'
import { SnapshotStore } from '../src/governance/snapshots.ts'
import type { MemorySnapshot, PendingDecision } from '../src/governance/schema.ts'
import type { MemoryRecord } from '../src/record-schema.ts'
import type { Scope } from '../src/scope.ts'
import { InMemoryBatchKvTable, InMemoryKvTable } from './helpers/in-memory-kv.ts'
import { noInstructions } from './helpers/instructions.ts'
import { fakeExec } from './helpers/exec.ts'
import { candidate, record } from './helpers/record.ts'
import { writeTopicIndex } from './helpers/topic-fixture.ts'

// 三个记信号的入口：memory_search 按 id 读全文、memory_confirm 确认仍然准确、memory_save 用过之后很快纠错。
// 真文件、真操作日志库、真写锁；时钟在进程边界注入。node:sqlite 不可用的一档在进程边界给 undefined。

const NOW = 1_800_000_000_000
const HOUR = 60 * 60 * 1000
const WS = '/proj/alpha'
const GLOBAL: Scope = { kind: 'global' }
const PROJECT: Scope = { kind: 'workspace', workspacePath: WS }
const quiet = { info() {}, warn() {}, error() {} }
const registry = buildTypeRegistry({ template: 'coding', customTypes: {} })

let root: string
let clock: number
let journal: OpJournal
let store: MemoryStore
let snapshots: SnapshotStore
let decisions: PendingDecisionsStore

function open(loadSqlite: () => SqliteModule | undefined = () => ({ DatabaseSync })) {
  journal?.close()
  journal = new OpJournal({ path: join(root, 'local', 'op-journal.sqlite'), log: quiet, loadSqlite })
  const lock = createRootLock({ root, log: quiet })
  const stats = new InMemoryBatchKvTable<RecallStats>()
  store = new MemoryStore(new FileTable({ root, stats, log: quiet, lock, journal, now: () => clock }), quiet, stats, journal)
  snapshots = new SnapshotStore(new InMemoryKvTable<MemorySnapshot>())
  decisions = new PendingDecisionsStore(new InMemoryKvTable<PendingDecision>(), lock)
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pm-usage-entries-'))
  clock = NOW
  open()
})
afterEach(async () => {
  journal.close()
  await rm(root, { recursive: true, force: true })
})

const mem = (partial: Partial<MemoryRecord>) => record({ type: 'knowledge', createdAt: NOW - HOUR, updatedAt: NOW - HOUR, lastConfirmedAt: NOW - HOUR, ...partial })
const project = (id: string, name: string, content: string) => mem({ id, name, summary: `${name}的摘要`, content, scope: 'workspace', workspacePath: WS })
const global = (id: string, name: string, content: string) => mem({ id, name, summary: `${name}的摘要`, content })

function searchDeps(sessionId: string, workspacePath: string | undefined = WS): SearchToolDeps {
  return {
    store, registry, now: () => clock,
    host: { contextOf: async () => ({ workspacePath, session: { id: sessionId, lastSeq: 1 } }) },
  }
}
const search = (args: Parameters<typeof executeSearch>[0], sessionId: string, workspacePath?: string) => executeSearch(args, fakeExec(), searchDeps(sessionId, workspacePath))
const confirmDeps = () => ({ store, decisions, snapshots, instructions: noInstructions, now: () => clock })
const save = (partial: object, sessionId = 's1') =>
  runSavePipeline(candidate({ action: 'update', type: 'knowledge', scope: 'workspace', ...partial }), { store, registry, workspacePath: WS, session: { id: sessionId, lastSeq: 9 }, snapshots, now: () => clock })
const usage = (scope: Scope, id: string) => store.readUsage(scope, [id])?.get(id)

describe('读过全文：memory_search 按 id 直达', () => {
  it('查询恰是记忆 id：这条记一次「读过全文」；同一会话再查不重复计，另一个会话再加一', async () => {
    await store.create(project('mem_a', '部署方式', '部署用 docker compose，先拉镜像再起服务。'))
    const first = await search({ query: 'mem_a' }, 's1')
    expect(first.hits[0]!.id).toBe('mem_a')
    expect(usage(PROJECT, 'mem_a')).toEqual({ fullReads: 1, confirms: 0, quickCorrections: 0 })
    await search({ query: 'mem_a' }, 's1')
    expect(usage(PROJECT, 'mem_a')!.fullReads).toBe(1)
    await search({ query: 'mem_a' }, 's2')
    expect(usage(PROJECT, 'mem_a')!.fullReads).toBe(2)
  })

  it('关键词命中、结果里给了全文：不算读过全文（召回照常计）', async () => {
    await store.create(project('mem_a', '部署方式', '部署用 docker compose，先拉镜像再起服务。'))
    await store.create(project('mem_b', '发版', '发版先跑全套测试。'))
    const r = await search({ query: '部署' }, 's1')
    expect(r.hits[0]).toMatchObject({ id: 'mem_a', content: '部署用 docker compose，先拉镜像再起服务。' })
    expect((await store.get('mem_a', PROJECT))!.recallCount).toBe(1)
    // 直达另一条，证明信号库此刻可用、记得进去
    await search({ query: 'mem_b' }, 's1')
    expect(usage(PROJECT, 'mem_b')!.fullReads).toBe(1)
    expect(usage(PROJECT, 'mem_a')).toBeUndefined()
  })

  it('配 id 列历史版本：不算读过全文', async () => {
    await store.create(project('mem_a', '部署方式', '部署用 docker compose。'))
    const r = await search({ id: 'mem_a', history: true }, 's1')
    expect(r.noteCode).not.toBe('invalid-args')
    await search({ query: 'mem_a' }, 's2')
    expect(usage(PROJECT, 'mem_a')!.fullReads).toBe(1)
  })

  it('认不出是哪个会话：照常返回这条，但不记读过全文', async () => {
    await store.create(project('mem_a', '部署方式', '部署用 docker compose。'))
    const r = await search({ query: 'mem_a' }, UNKNOWN_SESSION_ID)
    expect(r.hits[0]!.id).toBe('mem_a')
    await search({ query: 'mem_a' }, 's1')
    expect(usage(PROJECT, 'mem_a')!.fullReads).toBe(1)
  })

  it('同一个 id 在全局和本项目各有一份：直达的是本项目那份，信号只记在本项目下', async () => {
    await store.create(project('mem_a', '部署方式', '本项目的部署方式。'))
    await store.create(global('mem_a', '部署方式', '全局的部署方式。'))
    const r = await search({ query: 'mem_a' }, 's1')
    expect(r.hits[0]).toMatchObject({ id: 'mem_a', content: '本项目的部署方式。' })
    expect(usage(PROJECT, 'mem_a')!.fullReads).toBe(1)
    expect(store.readUsage(GLOBAL, ['mem_a'])).toBeDefined()
    expect(usage(GLOBAL, 'mem_a')).toBeUndefined()
  })

  it('配主题翻到第二页（offset 大于 0）：直达的那条不在这页，这页的第一条也不算读过全文', async () => {
    await store.create(global('mem_direct', '直达', '直达正文'))
    await store.create(global('mem_direct_b', '乙', '乙正文'))
    await writeTopicIndex(join(root, GLOBAL_DIR), [{ name: '直达主题', members: ['mem_direct', 'mem_direct_b'] }])
    const second = await search({ topic: '直达主题', query: 'mem_direct', scope: 'global', limit: 1, offset: 1 }, 's1')
    expect(second.hits.map(h => h.id)).toEqual(['mem_direct_b'])
    expect(store.readUsage(GLOBAL, ['mem_direct', 'mem_direct_b'])!.size).toBe(0)
    // 第一页照常记上，证明信号库此刻可用、记得进去
    await search({ topic: '直达主题', query: 'mem_direct', scope: 'global', limit: 1 }, 's1')
    expect(usage(GLOBAL, 'mem_direct')!.fullReads).toBe(1)
    expect(usage(GLOBAL, 'mem_direct_b')).toBeUndefined()
  })
})

describe('经确认：memory_confirm 刷新', () => {
  it('刷新成功一次记一次确认；同一条再确认一次再加一', async () => {
    await store.create(project('mem_a', '部署方式', '部署用 docker compose。'))
    const r = await executeConfirm({ action: 'refresh', memoryId: 'mem_a' }, { workspacePath: WS }, confirmDeps())
    expect(r.kind).toBe('refreshed')
    expect(usage(PROJECT, 'mem_a')).toEqual({ fullReads: 0, confirms: 1, quickCorrections: 0 })
    clock += 1000
    await executeConfirm({ action: 'refresh', memoryId: 'mem_a' }, { workspacePath: WS }, confirmDeps())
    expect(usage(PROJECT, 'mem_a')!.confirms).toBe(2)
  })

  it('刷新没成功（记忆已删除）：不记确认', async () => {
    await store.create(project('mem_a', '部署方式', '部署用 docker compose。'))
    await store.create(mem({ id: 'mem_gone', scope: 'workspace', workspacePath: WS, status: 'deleted', deletedAt: NOW - HOUR }))
    const r = await executeConfirm({ action: 'refresh', memoryId: 'mem_gone' }, { workspacePath: WS }, confirmDeps())
    expect(r.kind).toBe('error')
    await executeConfirm({ action: 'refresh', memoryId: 'mem_a' }, { workspacePath: WS }, confirmDeps())
    expect(usage(PROJECT, 'mem_a')!.confirms).toBe(1)
    expect(usage(PROJECT, 'mem_gone')).toBeUndefined()
  })

  it('接受子 agent 的待确认记录：不算确认', async () => {
    await store.create(mem({ id: 'mem_sub', name: '子任务记下的', scope: 'workspace', workspacePath: WS, delegation: { sessionId: 'sub', parentSessionId: 's1', depth: 1 } }))
    const r = await executeConfirm({ action: 'accept-subagent', memoryId: 'mem_sub' }, { workspacePath: WS }, confirmDeps())
    expect(r.kind).toBe('accepted')
    expect(store.readUsage(PROJECT, ['mem_sub'])).toBeDefined()
    expect(usage(PROJECT, 'mem_sub')).toBeUndefined()
  })
})

describe('用过之后很快纠错：memory_save 的纠错', () => {
  it('检索带出过这条、一小时后用纠错改了它：记一次很快纠错', async () => {
    await store.create(project('mem_a', '部署方式', '部署用 docker compose。'))
    await search({ query: '部署' }, 's1')
    clock = NOW + HOUR
    const r = await save({ id: 'mem_a', change: 'correct', name: '部署方式', summary: '部署方式的摘要', content: '部署用 k8s。' })
    expect(r).toMatchObject({ kind: 'updated', record: { lastChange: { kind: 'correct' } } })
    expect(usage(PROJECT, 'mem_a')).toEqual({ fullReads: 0, confirms: 0, quickCorrections: 1 })
  })

  it('最后一次召回已经过了窗口：纠错照常落盘，不记很快纠错', async () => {
    await store.create(project('mem_a', '部署方式', '部署用 docker compose。'))
    await store.create(project('mem_b', '发版', '发版先跑全套测试。'))
    await search({ query: '部署' }, 's1')
    clock = NOW + QUICK_CORRECTION_WINDOW_MS + 1
    const r = await save({ id: 'mem_a', change: 'correct', name: '部署方式', summary: '部署方式的摘要', content: '部署用 k8s。' })
    expect(r).toMatchObject({ kind: 'updated', record: { lastChange: { kind: 'correct' } } })
    // 同一时刻另一条记得进去：信号库可用
    await search({ query: 'mem_b' }, 's1')
    expect(usage(PROJECT, 'mem_b')!.fullReads).toBe(1)
    expect(usage(PROJECT, 'mem_a')).toBeUndefined()
  })

  it('从没被召回过的记忆被纠错：不记很快纠错', async () => {
    await store.create(project('mem_a', '部署方式', '部署用 docker compose。'))
    const r = await save({ id: 'mem_a', change: 'correct', name: '部署方式', summary: '部署方式的摘要', content: '部署用 k8s。' })
    expect(r).toMatchObject({ kind: 'updated', record: { lastChange: { kind: 'correct' } } })
    expect(store.readUsage(PROJECT, ['mem_a'])).toBeDefined()
    expect(usage(PROJECT, 'mem_a')).toBeUndefined()
  })

  it('召回过之后做的是细化、状态变化、补证：都不算纠错', async () => {
    await store.create(project('mem_a', '部署方式', '部署用 docker compose。'))
    await search({ query: '部署' }, 's1')
    clock = NOW + HOUR
    expect(await save({ id: 'mem_a', change: 'refine', name: '部署方式', summary: '部署方式的摘要', content: '部署用 docker compose，先拉镜像。' })).toMatchObject({ kind: 'updated' })
    clock += 1000
    expect(await save({ id: 'mem_a', change: 'state-change', changeReason: '换了部署方式', name: '部署方式', summary: '部署方式的摘要', content: '部署改用 k8s。' })).toMatchObject({ kind: 'updated' })
    clock += 1000
    expect(await save({ id: 'mem_a', change: 'corroborate', name: undefined, type: undefined, scope: undefined, content: undefined, summary: undefined, tags: undefined })).toMatchObject({ kind: 'updated' })
    expect(store.readUsage(PROJECT, ['mem_a'])).toBeDefined()
    expect(usage(PROJECT, 'mem_a')).toBeUndefined()
  })

  it('纠错没落盘（目标不存在被拒）：不记', async () => {
    await store.create(project('mem_a', '部署方式', '部署用 docker compose。'))
    await search({ query: '部署' }, 's1')
    clock = NOW + HOUR
    const r = await save({ id: 'mem_missing', change: 'correct', name: '部署方式', summary: '摘要', content: '部署用 k8s。' })
    expect(r.kind).toBe('rejected')
    expect(store.readUsage(PROJECT, ['mem_missing'])).toBeDefined()
    expect(usage(PROJECT, 'mem_missing')).toBeUndefined()
  })
})

describe('信号只当参考：不改检索排序', () => {
  it('后一名攒了很多信号：同一个查询的排序和攒之前一样', async () => {
    await store.create(project('mem_a', '部署方式', '部署用 docker compose，部署前先拉镜像。'))
    await store.create(project('mem_b', '部署检查', '部署后检查服务。'))
    const before = (await search({ query: '部署' }, 's1')).hits.map(h => h.id)
    expect(before).toHaveLength(2)
    const last = { id: before[1]!, scope: 'workspace' as const, workspacePath: WS }
    for (const key of ['k1', 'k2', 'k3', 'k4']) {
      store.noteUsage(last, { kind: 'full-read', key, at: clock })
      store.noteUsage(last, { kind: 'confirm', key, at: clock })
    }
    store.noteUsage({ id: before[0]!, scope: 'workspace', workspacePath: WS }, { kind: 'quick-correction', key: 'op_x', at: clock })
    expect(usage(PROJECT, before[1]!)).toEqual({ fullReads: 4, confirms: 4, quickCorrections: 0 })
    const after = (await search({ query: '部署' }, 's2')).hits.map(h => h.id)
    expect(after).toEqual(before)
  })
})

describe('并发', () => {
  it('几个会话同时按 id 读、同时确认：读过全文按会话数计，确认按次数计，不丢不重复', async () => {
    await store.create(project('mem_a', '部署方式', '部署用 docker compose。'))
    await Promise.all([
      search({ query: 'mem_a' }, 's1'),
      search({ query: 'mem_a' }, 's2'),
      search({ query: 'mem_a' }, 's1'),
      search({ query: 'mem_a' }, 's3'),
      executeConfirm({ action: 'refresh', memoryId: 'mem_a' }, { workspacePath: WS }, confirmDeps()),
      executeConfirm({ action: 'refresh', memoryId: 'mem_a' }, { workspacePath: WS }, confirmDeps()),
    ])
    expect(usage(PROJECT, 'mem_a')).toEqual({ fullReads: 3, confirms: 2, quickCorrections: 0 })
  })
})

describe('信号库不可用', () => {
  it('node:sqlite 加载不到：检索、确认、纠错照常，结果和平时一样；什么都不记，读回 undefined', async () => {
    open(() => undefined)
    await store.create(project('mem_a', '部署方式', '部署用 docker compose。'))
    const r = await search({ query: 'mem_a' }, 's1')
    expect(r.hits[0]).toMatchObject({ id: 'mem_a', content: '部署用 docker compose。' })
    expect((await executeConfirm({ action: 'refresh', memoryId: 'mem_a' }, { workspacePath: WS }, confirmDeps())).kind).toBe('refreshed')
    clock = NOW + HOUR
    expect(await save({ id: 'mem_a', change: 'correct', name: '部署方式', summary: '部署方式的摘要', content: '部署用 k8s。' })).toMatchObject({ kind: 'updated' })
    expect(store.readUsage(PROJECT, ['mem_a'])).toBeUndefined()
  })
})
