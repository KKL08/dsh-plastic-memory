import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RecallStats } from '../src/storage/schema.ts'
import { FileTable } from '../src/storage/file-table.ts'
import { GLOBAL_DIR, INDEX_FILE, WORKSPACE_MARKER, workspaceDirName } from '../src/storage/paths.ts'
import { SidecarStore } from '../src/storage/sidecar.ts'
import { PendingDecisionsStore } from '../src/governance/decisions.ts'
import { MemoryStore } from '../src/store.ts'
import { SnapshotCache } from '../src/runtime.ts'
import { ledgerLabel } from '../src/scope.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'
import { COLD_START_TEXT, UNREADABLE_MEMORY_TEXT, PARTIAL_MEMORY_TEXT } from '../src/snapshot.ts'
import { InMemoryBatchKvTable } from './helpers/in-memory-kv.ts'
import { record } from './helpers/record.ts'
import { FAKE_SECRET } from './helpers/secrets.ts'
import { sidecarSchemas } from './helpers/sidecar-schemas.ts'
import { indexTree, indexedIds } from './helpers/topic-index.ts'

// 进程边界的故障注入：readdir 列某个目录（prefix 为真时含其下全部路径）、readFile 读某个文件时抛权限错误
const fault = vi.hoisted(() => ({ dir: '', prefix: true, file: '', reason: '权限不足' }))
vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  const denied = () => Object.assign(new Error(fault.reason), { code: 'EACCES' })
  return {
    ...fs,
    readdir: async (...args: Parameters<typeof fs.readdir>) => {
      const path = String(args[0])
      if (fault.dir && (fault.prefix ? path.startsWith(fault.dir) : path === fault.dir)) throw denied()
      return fs.readdir(...args)
    },
    readFile: async (...args: Parameters<typeof fs.readFile>) => {
      if (fault.file && String(args[0]) === fault.file) throw denied()
      return fs.readFile(...args)
    },
  }
})

const WS = '/项目'
const registry = buildTypeRegistry({ template: 'coding', customTypes: {} })
let root = ''
let sidecarRoot = ''
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), '记忆读取-'))
  sidecarRoot = await mkdtemp(join(tmpdir(), '记忆读取侧表-'))
})
afterEach(async () => {
  Object.assign(fault, { dir: '', prefix: true, file: '', reason: '权限不足' })
  await rm(root, { recursive: true, force: true })
  await rm(sidecarRoot, { recursive: true, force: true })
})

const globalDir = () => join(root, GLOBAL_DIR)
const wsDir = () => join(root, workspaceDirName(WS))
/** 一个目录的索引现状：MEMORY.md 全文和 _index/ 下的全部目录项与内容。 */
const indexOf = async (dir: string) => ({ projection: await readFile(join(dir, INDEX_FILE), 'utf8'), tree: await indexTree(dir) })
const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })
/** 只看快照缓存记的目录读取日志（失败与恢复）。 */
const dirLogs = (log: ReturnType<typeof logger>) => [
  ...log.warn.mock.calls.filter(c => String(c[0]).includes('记忆目录读取失败')).map(() => 'warn'),
  ...log.info.mock.calls.filter(c => String(c[0]).includes('记忆目录恢复可读')).map(() => 'info'),
]

function world(opts: { budget?: number; ledger?: PendingDecisionsStore; log?: ReturnType<typeof logger> } = {}) {
  const stats = new InMemoryBatchKvTable<RecallStats>()
  const store = new MemoryStore(new FileTable({ root, stats, now: () => 0 }), undefined, stats)
  const cache = new SnapshotCache({
    store, registry, budget: opts.budget ?? 4000, memoryRoot: root, now: () => 0,
    ...(opts.log ? { log: opts.log } : {}), ...(opts.ledger ? { overflowLedger: opts.ledger } : {}),
  })
  /** 新开一个会话（项目缺省为无项目）组装一次。 */
  const assembleIn = async (workspacePath?: string) => {
    const session = {}
    cache.setWorkspacePath(session, workspacePath)
    return (await cache.assemble(session))!
  }
  return { stats, store, cache, assembleIn }
}

const globalMemory = (id: string, content: string) =>
  record({ id, type: 'preference', content, createdAt: 0, updatedAt: 0, lastConfirmedAt: 0 })
const projectMemory = (id: string, content: string) =>
  record({ id, scope: 'workspace', workspacePath: WS, type: 'preference', content, createdAt: 0, updatedAt: 0, lastConfirmedAt: 0 })

describe('快照目录读取', () => {
  it('全局目录读不出时仍带入可读的项目记忆，并说明读取范围', async () => {
    const log = logger()
    const { store, assembleIn } = world({ log })
    await store.create(projectMemory('mem_p', '项目回答约定'))
    fault.dir = globalDir()
    const text = await assembleIn(WS)
    expect(text.split('\n')).toContain(PARTIAL_MEMORY_TEXT)
    expect(text).toContain('项目回答约定')
    expect(text).not.toContain(COLD_START_TEXT)
    expect(dirLogs(log)).toEqual(['warn'])
  })

  it('目录可读时注入文本逐字节保持一致', async () => {
    const { store } = world()
    await store.create(record({ id: 'mem_1', name: '回答偏好', summary: '先给结论', content: '回答先给结论，再说明依据。', type: 'preference', createdAt: 0, updatedAt: 0, lastConfirmedAt: 0 }))
    // 夹具按不带记忆根路径的组装录下
    const plain = new SnapshotCache({ store, registry, budget: 4000, now: () => 0 })
    expect(Buffer.from((await plain.assemble({}))!)).toEqual(await readFile(new URL('./fixtures/readable-memory-snapshot.txt', import.meta.url)))
  })

  it('全局目录读不出时说明本次读取失败、日志遮盖密钥；故障解除后不用标过期，下一次组装就读到记忆', async () => {
    await mkdir(globalDir(), { recursive: true })
    const log = logger()
    const { store, cache } = world({ log })
    await store.create(globalMemory('mem_g', '全局回答约定'))
    fault.dir = globalDir()
    fault.reason = `权限不足 ${FAKE_SECRET.sk}`
    const session = {}
    cache.setWorkspacePath(session, undefined)
    const text = await cache.assemble(session)
    expect(text).toBe(UNREADABLE_MEMORY_TEXT)
    expect(dirLogs(log)).toEqual(['warn'])
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain(FAKE_SECRET.sk)
    fault.dir = ''
    expect(await cache.assemble(session)).toContain('全局回答约定')
  })

  it('记忆根本身列不出、项目目录又不在默认位置时，说明有目录读不出', async () => {
    const log = logger()
    const { store, assembleIn } = world({ log })
    await store.create(globalMemory('mem_g', '全局回答约定'))
    // 手工改名的项目目录：默认位置没有它，只能靠列记忆根找到
    const renamed = join(root, 'ws-改过名')
    await mkdir(renamed, { recursive: true })
    await writeFile(join(renamed, WORKSPACE_MARKER), WS)
    Object.assign(fault, { dir: root, prefix: false })
    const text = await assembleIn(WS)
    expect(text.split('\n')).toContain(PARTIAL_MEMORY_TEXT)
    expect(text).toContain('全局回答约定')
    expect(dirLogs(log)).toEqual(['warn'])
  })

  it('项目目录的标记读不出时，说明有目录读不出，不当成项目没有记忆', async () => {
    const log = logger()
    const { store, assembleIn } = world({ log })
    await store.create(globalMemory('mem_g', '全局回答约定'))
    await store.create(projectMemory('mem_p', '项目回答约定'))
    fault.file = join(wsDir(), WORKSPACE_MARKER)
    const text = await assembleIn(WS)
    expect(text.split('\n')).toContain(PARTIAL_MEMORY_TEXT)
    expect(text).toContain('全局回答约定')
    expect(text).not.toContain('项目回答约定')
    expect(dirLogs(log)).toEqual(['warn'])
  })
})

describe('有目录读不出时不冻结、不写盘', () => {
  it.each([['无项目会话（全部读不出）', undefined], ['项目会话（部分读不出）', WS]] as const)('%s：主题索引和 MEMORY.md 原样不动', async (_label, workspacePath) => {
    const { store, assembleIn } = world()
    await store.create(globalMemory('mem_g', '全局回答约定'))
    await store.create(projectMemory('mem_p', '项目回答约定'))
    // 先正常冻结一次，维护点写出两个目录的索引
    await assembleIn(WS)
    const before = { global: await indexOf(globalDir()), ws: await indexOf(wsDir()) }
    expect(await indexedIds(globalDir())).toEqual(['mem_g'])
    expect(await indexedIds(wsDir())).toEqual(['mem_p'])
    fault.dir = globalDir()
    await assembleIn(workspacePath)
    fault.dir = ''   // 故障撤掉再看盘面，否则列不出索引目录
    expect({ global: await indexOf(globalDir()), ws: await indexOf(wsDir()) }).toEqual(before)
  })

  it('读不出时不计召回；恢复后正常计', async () => {
    const { store, stats, assembleIn } = world()
    await store.create(projectMemory('mem_p', '项目回答约定'))
    fault.dir = globalDir()
    expect(await assembleIn(WS)).toContain('项目回答约定')
    expect((await stats.get('mem_p'))?.recallCount ?? 0).toBe(0)
    fault.dir = ''
    await assembleIn(WS)
    expect((await stats.get('mem_p'))?.recallCount).toBe(1)
  })

  it('超限提醒（含用户忽略过的）原样不动，恢复后忽略过的不再冒出来', async () => {
    const ledger = new PendingDecisionsStore(...(s => [s.pending, s.lock] as const)(new SidecarStore({ root: sidecarRoot, schemas: sidecarSchemas })))
    const { store, cache, assembleIn } = world({ budget: 1, ledger })
    for (let i = 0; i < 5; i++) await store.create(globalMemory(`mem_g${i}`, `全局占预算的约定 ${i}`))
    for (let i = 0; i < 5; i++) await store.create(projectMemory(`mem_p${i}`, `项目占预算的约定 ${i}`))
    await assembleIn(undefined)
    await assembleIn(WS)
    const globalEntry = (await ledger.list()).find(e => e.kind === 'overflow' && e.workspaces?.[0] === ledgerLabel({ kind: 'global' }))!
    await ledger.settle(globalEntry.id, 'dismiss', 1)
    const before = { open: await ledger.list(), settled: await ledger.listSettled() }
    expect(before.open.map(e => e.kind)).toEqual(['overflow'])
    expect(before.settled.map(e => e.id)).toEqual([globalEntry.id])

    fault.dir = globalDir()
    await assembleIn(undefined)
    await assembleIn(WS)
    await cache.resyncOverflow([ledgerLabel({ kind: 'global' }), ledgerLabel({ kind: 'workspace', workspacePath: WS })])
    expect({ open: await ledger.list(), settled: await ledger.listSettled() }).toEqual(before)

    fault.dir = ''
    await assembleIn(undefined)
    expect({ open: await ledger.list(), settled: await ledger.listSettled() }).toEqual(before)
  })
})

describe('目录读取日志', () => {
  it('同一故障只记一行，原因变了再记；恢复记一行，恢复后再坏才再记', async () => {
    const log = logger()
    const ledger = new PendingDecisionsStore(...(s => [s.pending, s.lock] as const)(new SidecarStore({ root: sidecarRoot, schemas: sidecarSchemas })))
    const { store, cache, assembleIn } = world({ log, ledger })
    await store.create(globalMemory('mem_g', '全局回答约定'))
    fault.dir = globalDir()
    // 新会话、同一会话重建、另一个项目、超限重算：都是同一个目录同一个原因
    const session = {}
    cache.setWorkspacePath(session, undefined)
    await cache.assemble(session)
    await cache.assemble(session)
    await assembleIn(undefined)
    await assembleIn(WS)
    await cache.resyncOverflow([ledgerLabel({ kind: 'global' })])
    expect(dirLogs(log)).toEqual(['warn'])

    fault.reason = '设备读写错误'
    await assembleIn(undefined)
    expect(dirLogs(log)).toEqual(['warn', 'warn'])

    fault.dir = ''
    await assembleIn(undefined)
    await assembleIn(WS)
    expect(dirLogs(log)).toEqual(['warn', 'warn', 'info'])

    fault.dir = globalDir()
    await assembleIn(undefined)
    expect(dirLogs(log)).toEqual(['warn', 'warn', 'warn', 'info'])
  })
})
