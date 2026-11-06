import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SnapshotCache, resolveWorkspacePath, type FrozenSnapshotInfo, type SnapshotHost } from '../src/runtime.ts'
import { MemoryStore } from '../src/store.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'
import { COLD_START_TEXT, assembleSnapshot } from '../src/snapshot.ts'
import type { MemoryRecord } from '../src/record-schema.ts'
import { record as baseRecord } from './helpers/record.ts'
import { workspaceDirName } from '../src/storage/paths.ts'
import { InMemoryTable } from './helpers/in-memory-table.ts'
import { InMemoryBatchKvTable } from './helpers/in-memory-kv.ts'

const registry = buildTypeRegistry({ template: 'coding', customTypes: {} })

// 本文件默认时间戳为 0。
const record = (partial: Partial<MemoryRecord> = {}) => baseRecord({ createdAt: 0, updatedAt: 0, lastConfirmedAt: 0, ...partial })

function makeCache(store = new MemoryStore(new InMemoryTable(), undefined, new InMemoryBatchKvTable())) {
  return { store, cache: new SnapshotCache({ store, registry, budget: 4000 }) }
}

/** 冻结快照里带入全文的 core id（排序后）；没有冻结快照回 undefined。 */
const frozenCore = (cache: SnapshotCache, session: object) => {
  const core = cache.injectedCore(session)
  return core && [...core.keys()].sort()
}

/** 宿主会话替身：只给要用的方法，其余按没有项目、没有更早的轮、不是持久型子会话。 */
const snapshotHost = (partial: Partial<SnapshotHost>): SnapshotHost => ({
  workspaceOf: async () => undefined, hasEarlierTurns: () => false, ownSessionIdOf: () => undefined, ...partial,
})

describe('SnapshotCache', () => {
  it('首次组装才冻结，不先计召回；之后再组装命中缓存，不读盘，回同一份文本', async () => {
    const { store, cache } = makeCache()
    const recalled = vi.spyOn(store, 'markRecalled')
    await store.put(record({ id: 'mem_core', type: 'preference', content: '不要 mock 数据库' }))
    const session = {}
    cache.setWorkspacePath(session, undefined)
    expect(frozenCore(cache, session)).toBeUndefined()
    expect(recalled).not.toHaveBeenCalled()
    const injected = await cache.assemble(session)
    expect(injected).toContain('不要 mock 数据库')
    expect(frozenCore(cache, session)).toEqual(['mem_core'])
    const reads = vi.spyOn(store, 'readRaw')
    expect(await cache.assemble(session)).toBe(injected)
    expect(reads).not.toHaveBeenCalled()
  })

  it('workspacePath 未解析时，assemble 返回非空 global-only 临时文本（不含 workspace 记忆），不冻结不 markRecalled', async () => {
    const { store, cache } = makeCache()
    const spy = vi.spyOn(store, 'markRecalled')
    await store.put(record({ id: 'mem_global', type: 'preference', content: '不要 mock 数据库' }))
    await store.put(record({ id: 'mem_ws', type: 'preference', scope: 'workspace', workspacePath: '/repo', content: '仅本仓库生效的偏好' }))
    const session = {}

    const first = await cache.assemble(session) // 未注入 resolver、未显式喂：按未解析组装临时文本
    expect(first).toContain('不要 mock 数据库')
    expect(first).not.toContain('仅本仓库生效的偏好')
    expect(frozenCore(cache, session)).toBeUndefined() // 临时文本只给本次用，不进缓存
    expect(spy).not.toHaveBeenCalled()

    // 未冻结：workspace 解析完成后下一次组装拿到完整版
    cache.setWorkspacePath(session, '/repo')
    const second = await cache.assemble(session)
    expect(second).toContain('仅本仓库生效的偏好')
    expect(frozenCore(cache, session)).toEqual(['mem_global', 'mem_ws'])
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('setWorkspacePath 后 assemble 返回完整版并冻结，markRecalled 恰调用一次且参数为 core id', async () => {
    const NOW = 1_700_000_000_000
    const store = new MemoryStore(new InMemoryTable(), undefined, new InMemoryBatchKvTable())
    const cache = new SnapshotCache({ store, registry, budget: 4000, now: () => NOW })
    const spy = vi.spyOn(store, 'markRecalled')
    await store.put(record({ id: 'mem_core', type: 'preference', content: '不要 mock 数据库' }))
    const session = {}
    cache.setWorkspacePath(session, undefined)

    const text = await cache.assemble(session)
    expect(text).toContain('不要 mock 数据库')
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalledWith(['mem_core'], NOW)

    // 冻结：后续写入新记忆，同一 session 仍返回旧快照，不重新组装，也不再计召回
    await store.put(record({ id: 'mem_new', type: 'preference', content: '另一条偏好' }))
    expect(await cache.assemble(session)).toBe(text)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('markStale 只标过期不清空：下一次组装前冻结内容仍是上一份，组装后换成新快照', async () => {
    const { store, cache } = makeCache()
    await store.put(record({ id: 'mem_old', type: 'preference', content: '旧偏好' }))
    const session = {}
    cache.setWorkspacePath(session, undefined)
    await cache.assemble(session)

    await store.put(record({ id: 'mem_new', type: 'preference', content: '压缩后新增的偏好' }))
    cache.markStale(session)
    expect(frozenCore(cache, session)).toEqual(['mem_old'])

    const after = await cache.assemble(session)
    expect(after).toContain('压缩后新增的偏好')
    expect(frozenCore(cache, session)).toEqual(['mem_new', 'mem_old'])
  })

  it('同一会话多次压缩，召回只计一次', async () => {
    const { store, cache } = makeCache()
    const spy = vi.spyOn(store, 'markRecalled')
    await store.put(record({ id: 'mem_core', type: 'preference', content: '不要 mock 数据库' }))
    const session = {}
    cache.setWorkspacePath(session, undefined)

    await cache.assemble(session)
    for (let i = 0; i < 3; i++) {
      cache.markStale(session) // 模拟压缩
      const rebuilt = await cache.assemble(session) // 重建：内容重新组装但不重复计召回
      expect(rebuilt).toContain('不要 mock 数据库') // 确有重建产出，召回计数才有意义
    }
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('空库：冷启动文案由组装产出并冻结', async () => {
    const { cache } = makeCache()
    const session = {}
    cache.setWorkspacePath(session, undefined)
    expect(await cache.assemble(session)).toBe(COLD_START_TEXT)
    expect(frozenCore(cache, session)).toEqual([])
  })

  it('空库 + 未解析：global-only 临时文本是冷启动文案，不冻结', async () => {
    const { cache } = makeCache()
    const session = {}
    expect(await cache.assemble(session)).toBe(COLD_START_TEXT)
    expect(frozenCore(cache, session)).toBeUndefined()
  })

  it('markStale 后按最新状态重新组装', async () => {
    const { store, cache } = makeCache()
    const session = {}
    cache.setWorkspacePath(session, undefined)
    expect(await cache.assemble(session)).toBe(COLD_START_TEXT) // 冻结冷启动文案
    await store.put(record({ id: 'mem_new', type: 'preference', content: '不要 mock 数据库' }))
    cache.markStale(session)
    const text = await cache.assemble(session)
    expect(text).not.toBe(COLD_START_TEXT)
    expect(text).toContain('不要 mock 数据库')
  })

  it('构建竞态：预读挂起期间被标过期，失效前的文本作废，按新代次重建、冻结后返回', async () => {
    const { store, cache } = makeCache()
    const spy = vi.spyOn(store, 'markRecalled')
    await store.put(record({ id: 'mem_before', type: 'preference', content: '失效前的偏好' }))
    const session = {}
    cache.setWorkspacePath(session, undefined)

    // 可控的 store 替身：本次预读按调用时刻读出记录，然后挂起，直到测试放行
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const query = store.readRaw.bind(store)
    let entered!: () => void
    const inQuery = new Promise<void>(r => { entered = r })
    vi.spyOn(store, 'readRaw').mockImplementationOnce(async (...args) => {
      const result = await query(...args)
      entered()
      await gate
      return result
    })

    const pending = cache.assemble(session)
    await inQuery // 构建已开始，预读挂在 gate 上
    await store.put(record({ id: 'mem_after', type: 'preference', content: '压缩后的偏好' }))
    cache.markStale(session) // 构建期间碰上 compaction
    release()

    // 返回的就是冻结的那份：按最新状态重建，首次计召回
    const fresh = await pending
    expect(fresh).toContain('压缩后的偏好')
    expect(frozenCore(cache, session)).toEqual(['mem_after', 'mem_before'])
    expect(spy).toHaveBeenCalledTimes(1)
    expect(await cache.assemble(session)).toBe(fresh)
  })

  it('构建连续被标过期到重试上限：这次不给文本、不冻结、不计召回；下一次组装照常冻结', async () => {
    const { store, cache } = makeCache()
    const spy = vi.spyOn(store, 'markRecalled')
    await store.put(record({ id: 'mem_a', type: 'preference', content: '偏好' }))
    const session = {}
    cache.setWorkspacePath(session, undefined)
    const readRaw = store.readRaw.bind(store)
    let reads = 0
    const churn = vi.spyOn(store, 'readRaw').mockImplementation(async (...args) => {
      reads++
      cache.markAllStale() // 每次预读都碰上配置热更新
      return readRaw(...args)
    })

    expect(await cache.assemble(session)).toBeUndefined()
    expect(reads).toBe(3)
    expect(frozenCore(cache, session)).toBeUndefined()
    expect(spy).not.toHaveBeenCalled()

    churn.mockRestore()
    expect(await cache.assemble(session)).toContain('偏好')
    expect(frozenCore(cache, session)).toEqual(['mem_a'])
  })

  it('构建竞态：已冻结的会话重建期间再次被标过期，失效前的重建结果不冻结，返回的是按最新状态重建、冻结的那份', async () => {
    const { store, cache } = makeCache()
    await store.put(record({ id: 'mem_a', type: 'preference', content: '第一版偏好' }))
    const session = {}
    cache.setWorkspacePath(session, undefined)
    await cache.assemble(session)

    await store.put(record({ id: 'mem_b', type: 'preference', content: '第二版偏好' }))
    cache.markStale(session)

    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const query = store.readRaw.bind(store)
    let entered!: () => void
    const inQuery = new Promise<void>(r => { entered = r })
    vi.spyOn(store, 'readRaw').mockImplementationOnce(async (...args) => {
      const result = await query(...args)
      entered()
      await gate
      return result
    })

    const pending = cache.assemble(session)
    await inQuery
    await store.put(record({ id: 'mem_c', type: 'preference', content: '第三版偏好' }))
    cache.markStale(session)
    release()
    const latest = await pending
    expect(latest).toContain('第三版偏好')
    expect(frozenCore(cache, session)).toEqual(['mem_a', 'mem_b', 'mem_c'])
    expect(await cache.assemble(session)).toBe(latest)
  })

  it('构造 memoryRoot 时，临时文本与冻结快照都含磁盘路径行（⑧×D1）', async () => {
    const store = new MemoryStore(new InMemoryTable(), undefined, new InMemoryBatchKvTable())
    await store.put(record({ id: 'mem_g', type: 'preference', content: '不要 mock 数据库' }))
    const cache = new SnapshotCache({ store, registry, budget: 4000, memoryRoot: '/home/.dsh/memories' })
    const session = {}
    // 临时文本（workspace 未解析）
    expect(await cache.assemble(session)).toContain('/home/.dsh/memories/global/')
    // 冻结快照（解析完成后）
    cache.setWorkspacePath(session, undefined)
    expect(await cache.assemble(session)).toContain('/home/.dsh/memories/global/')
  })

  it('MEMORY.md 行与注入索引行末尾带文件名（同源格式，passive 不带 summary；磁盘侧不带陈旧度，注入侧带）：冻结快照的索引行以相对记忆根目录的实际文件路径收尾', async () => {
    const store = new MemoryStore(new InMemoryTable('/home/.dsh/memories'), undefined, new InMemoryBatchKvTable())
    await store.put(record({ id: 'mem_g', name: '网关限流', type: 'knowledge', summary: '阈值 80', lastConfirmedAt: Date.now() }))
    await store.put(record({ id: 'mem_w', name: '发布节奏', type: 'knowledge', summary: '周四发布', scope: 'workspace', workspacePath: '/repo', lastConfirmedAt: Date.now() }))
    const cache = new SnapshotCache({ store, registry, budget: 4000, memoryRoot: '/home/.dsh/memories' })
    const session = {}
    cache.setWorkspacePath(session, '/repo')
    const lines = (await cache.assemble(session))!.split('\n')
    expect(lines).toContain('- [mem_g] 网关限流（阈值 80） · global/网关限流.md')
    expect(lines).toContain(`- [mem_w] 发布节奏（周四发布） · ${workspaceDirName('/repo')}/发布节奏.md`)
  })

  it('HMR 已知窗口：新建缓存实例对存量 session 首次组装触发解析；没落定先给临时文本，落定后冻结完整版', async () => {
    const store = new MemoryStore(new InMemoryTable(), undefined, new InMemoryBatchKvTable())
    const spy = vi.spyOn(store, 'markRecalled')
    await store.put(record({ id: 'mem_global', type: 'preference', content: '不要 mock 数据库' }))
    await store.put(record({ id: 'mem_ws', type: 'preference', scope: 'workspace', workspacePath: '/repo', content: '仅本仓库生效的偏好' }))

    // 模拟热重载后的新实例：没经过任何 session/created，靠组装入口自愈解析 workspace
    let calls = 0
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const cache = new SnapshotCache({
      store, registry, budget: 4000,
      host: snapshotHost({ workspaceOf: async (s: object) => { calls++; await gate; return (s as { header?: { cwd?: string } }).header?.cwd } }),
    })
    const session = { header: { cwd: '/repo' } }

    // 首次组装触发解析；解析未落定（超时放行），global-only 临时文本补上，不含 workspace 记忆、不计召回
    const first = await cache.assemble(session, 0)
    expect(first).toContain('不要 mock 数据库')
    expect(first).not.toContain('仅本仓库生效的偏好')
    expect(spy).not.toHaveBeenCalled()

    // 等待 fire-and-forget 解析落定
    release()
    await new Promise(r => setTimeout(r))
    expect(calls).toBe(1)

    // 解析完成后组装：完整版含 workspace 记忆，冻结并计召回一次
    const second = await cache.assemble(session)
    expect(second).toContain('仅本仓库生效的偏好')
    expect(spy).toHaveBeenCalledTimes(1)
    // 冻结：后续组装返回同一快照，不再计召回
    expect(await cache.assemble(session)).toBe(second)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('assemble：首轮组装显式等待解析——等待后的首次组装即完整版（不赌宿主时序）', async () => {
    const store = new MemoryStore(new InMemoryTable(), undefined, new InMemoryBatchKvTable())
    await store.put(record({ content: '全局条目', type: 'preference' }))
    await store.put(record({ content: '仅本仓库生效的偏好', type: 'preference', scope: 'workspace', workspacePath: '/repo' }))
    // 慢解析：挂在闸门上，首轮组装开始之后才放行
    let entered!: () => void
    const inResolve = new Promise<void>(r => { entered = r })
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const cache = new SnapshotCache({
      store, registry, budget: 4000,
      host: snapshotHost({
        workspaceOf: async (s: object) => {
          entered()
          await gate
          return (s as { header?: { cwd?: string } }).header?.cwd
        },
      }),
    })
    const session = { header: { cwd: '/repo' } }
    const assembled = cache.assemble(session)
    await inResolve // 首轮组装已开始，解析挂在闸门上
    release()
    expect(await assembled).toContain('仅本仓库生效的偏好')
  })

  it('awaitResolved 只等解析：落定后不组装、不冻结', async () => {
    const { store } = makeCache()
    const spy = vi.spyOn(store, 'readRaw')
    const cache = new SnapshotCache({ store, registry, budget: 4000, host: snapshotHost({ workspaceOf: async () => '/repo' }) })
    const session = { header: { cwd: '/repo' } }
    await cache.awaitResolved(session)
    expect(spy).not.toHaveBeenCalled()
    expect(frozenCore(cache, session)).toBeUndefined()
  })

  it('assemble：解析悬挂时超时放行，走 global-only 临时文本，不冻结、不计召回', async () => {
    const store = new MemoryStore(new InMemoryTable(), undefined, new InMemoryBatchKvTable())
    const spy = vi.spyOn(store, 'markRecalled')
    await store.put(record({ content: '全局条目', type: 'preference' }))
    await store.put(record({ content: '仅本仓库生效的偏好', type: 'preference', scope: 'workspace', workspacePath: '/repo' }))
    const cache = new SnapshotCache({
      store, registry, budget: 4000,
      host: snapshotHost({ workspaceOf: () => new Promise<string | undefined>(() => {}) }), // 永不落定
    })
    const session = { header: { cwd: '/repo' } }
    const text = await cache.assemble(session, 30)
    expect(text).toContain('全局条目')
    expect(text).not.toContain('仅本仓库生效的偏好')
    expect(frozenCore(cache, session)).toBeUndefined()
    expect(spy).not.toHaveBeenCalled()
  })

  it('组装失败只记日志、回 undefined，不抛；已冻结的旧快照留着不动', async () => {
    const { store } = makeCache()
    await store.put(record({ id: 'mem_core', type: 'preference', content: '不要 mock 数据库' }))
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const cache = new SnapshotCache({ store, registry, budget: 4000, log })
    const session = {}
    cache.setWorkspacePath(session, undefined)
    vi.spyOn(store, 'readRaw').mockRejectedValueOnce(new Error('boom'))
    expect(await cache.assemble(session)).toBeUndefined()
    expect(log.error).toHaveBeenCalledTimes(1)

    await cache.assemble(session)
    cache.markStale(session)
    vi.spyOn(store, 'readRaw').mockRejectedValueOnce(new Error('boom'))
    expect(await cache.assemble(session)).toBeUndefined()
    expect(log.error).toHaveBeenCalledTimes(2)
    expect(frozenCore(cache, session)).toEqual(['mem_core'])
  })

  it('在途解析去重：同一 session 连续两次预热只问一次所属项目', () => {
    const { store } = makeCache()
    let calls = 0
    const cache = new SnapshotCache({
      store, registry, budget: 4000,
      host: snapshotHost({ workspaceOf: async () => { calls++; return '/repo' } }),
    })
    const session = { header: { cwd: '/repo' } }
    cache.prewarm(session)
    cache.prewarm(session)
    expect(calls).toBe(1)
  })

  it('快照冻结是维护点：冻结后对 global + 当前 workspace 调一次 store.maintain；缓存命中与未解析的临时文本不调', async () => {
    const { store, cache } = makeCache()
    const spy = vi.spyOn(store, 'maintain')
    await store.put(record({ id: 'mem_core', type: 'preference', content: '不要 mock 数据库' }))
    const session = {}
    await cache.assemble(session)                     // 未解析：临时文本，不冻结、不维护
    expect(spy).not.toHaveBeenCalled()
    cache.setWorkspacePath(session, '/repo')
    await cache.assemble(session)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalledWith({ kind: 'visible', workspacePath: '/repo' })
    await cache.assemble(session)                     // 缓存命中
    expect(spy).toHaveBeenCalledTimes(1)
    cache.markStale(session)
    await cache.assemble(session)                     // 重建再冻结：再维护一次
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('缓存按 session 隔离', async () => {
    const { cache } = makeCache()
    const a = {}
    const b = {}
    cache.setWorkspacePath(a, undefined)
    expect(await cache.assemble(a)).toBe(COLD_START_TEXT)
    // b 没组装过，不受 a 的缓存影响
    expect(frozenCore(cache, b)).toBeUndefined()
  })
})

// 子 agent 写入的待确认记录：持久型子会话的注入带上自己创建的，生效时机同主会话自存的记录（下一次重建）；一次性子会话与主会话不带
describe('SnapshotCache × 待确认记录', () => {
  const pending = (sessionId: string, partial: Partial<MemoryRecord>) =>
    record({ type: 'preference', delegation: { sessionId, depth: 1, parentSessionId: 'main' }, ...partial })
  // 宿主会话的最小形状：header.id 是会话 id；哪个会话是持久型子会话由宿主会话的 ownSessionIdOf 决定
  const session = (id: string) => ({ header: { id } })
  function makeDelegatingCache(continuable: ReadonlySet<string>) {
    const store = new MemoryStore(new InMemoryTable(), undefined, new InMemoryBatchKvTable())
    const cache = new SnapshotCache({
      store, registry, budget: 4000,
      host: snapshotHost({
        ownSessionIdOf: s => {
          const id = (s as { header: { id: string } }).header.id
          return continuable.has(id) ? id : undefined
        },
      }),
    })
    return { store, cache }
  }

  it('持久型子会话：已冻结的快照不因保存刷新，标过期重建后带上自己的待确认记录，不带兄弟子会话的', async () => {
    const { store, cache } = makeDelegatingCache(new Set(['sub-a', 'sub-b']))
    await store.put(record({ id: 'mem_main', type: 'preference', content: '主会话的偏好' }))
    const sub = session('sub-a')
    cache.setWorkspacePath(sub, undefined)
    const frozen = await cache.assemble(sub)
    expect(frozen).toContain('主会话的偏好')

    await store.put(pending('sub-a', { id: 'mem_mine', content: '自己存的偏好' }))
    await store.put(pending('sub-b', { id: 'mem_sib', content: '兄弟存的偏好' }))
    expect(await cache.assemble(sub)).toBe(frozen)

    cache.markStale(sub)
    const rebuilt = await cache.assemble(sub)
    expect(rebuilt).toContain('自己存的偏好')
    expect(rebuilt).not.toContain('兄弟存的偏好')
    expect(frozenCore(cache, sub)).toEqual(['mem_main', 'mem_mine'])
  })

  it('一次性子会话与主会话：重建后也不带任何待确认记录', async () => {
    const { store, cache } = makeDelegatingCache(new Set())
    await store.put(record({ id: 'mem_main', type: 'preference', content: '主会话的偏好' }))
    await store.put(pending('sub-once', { id: 'mem_once', content: '一次性子级存的偏好' }))
    for (const s of [session('sub-once'), session('main')]) {
      cache.setWorkspacePath(s, undefined)
      cache.markStale(s)
      const text = await cache.assemble(s)
      expect(text).toContain('主会话的偏好')
      expect(text).not.toContain('一次性子级存的偏好')
    }
  })
})

// 快照来历（会话视图的 origin）：首次冻结是对话开始时；成功压缩后的下一次冻结是压缩后重新带入；
// 其他重建（失败的压缩、配置热更新）文本变了（会补发）是对话中重新带入，没变就沿用上一次的来历。
describe('SnapshotCache 快照来历', () => {
  function makeTracked(hasEarlierTurns?: (session: object) => boolean) {
    const store = new MemoryStore(new InMemoryTable(), undefined, new InMemoryBatchKvTable())
    const frozen: FrozenSnapshotInfo[] = []
    const cache = new SnapshotCache({
      store, registry, budget: 4000, onFrozen: (_s, info) => { frozen.push(info) },
      ...(hasEarlierTurns === undefined ? {} : { host: snapshotHost({ hasEarlierTurns }) }),
    })
    const session = {}
    cache.setWorkspacePath(session, undefined)
    return { store, cache, session, frozen, last: () => frozen.at(-1)! }
  }

  it('首次冻结的来历是对话开始时，带出带入全文的 core id 与只带标题的 id', async () => {
    const { store, cache, session, last } = makeTracked()
    await store.put(record({ id: 'mem_core', type: 'preference', content: '不要 mock 数据库' }))
    await store.put(record({ id: 'mem_idx', type: 'knowledge', content: '报销截止每月 25 日' }))
    await store.put(record({ id: 'mem_ref', type: 'reference', content: '看板在 Linear' }))
    await cache.assemble(session)
    expect(last()).toMatchObject({ origin: 'start', coreIds: ['mem_core'], titleOnlyIds: ['mem_ref'] })
    expect(last().compactedAt).toBeUndefined()
    expect(last().injectedIds).toEqual(['mem_core', 'mem_idx', 'mem_ref'])
  })

  it('成功压缩后下一次冻结的来历是压缩后，带压缩时刻；再之后的其他重建沿用', async () => {
    const { cache, session, frozen, last } = makeTracked()
    await cache.assemble(session)
    cache.markCompacted(session, 5_000)
    await cache.assemble(session)
    expect(frozen).toHaveLength(2)
    expect(last()).toMatchObject({ origin: 'compacted', compactedAt: 5_000 })
    cache.markAllStale() // 配置热更新
    await cache.assemble(session)
    expect(frozen).toHaveLength(3)
    expect(last()).toMatchObject({ origin: 'compacted', compactedAt: 5_000 })
  })

  it('失败的压缩（只标过期）与配置热更新都不改来历', async () => {
    const { cache, session, frozen, last } = makeTracked()
    await cache.assemble(session)
    cache.markStale(session)
    await cache.assemble(session)
    cache.markAllStale()
    await cache.assemble(session)
    expect(frozen).toHaveLength(3)
    expect(frozen.map(f => f.origin)).toEqual(['start', 'start', 'start'])
    expect(last().compactedAt).toBeUndefined()
  })

  it('非压缩的重建补发了新快照（文本变了）：来历是对话中重新带入；之后文本不变的重建沿用，成功压缩照旧改成压缩后', async () => {
    const { store, cache, session, frozen, last } = makeTracked(() => true)
    await cache.assemble(session)
    expect(last().origin).toBe('resumed')
    await store.put(record({ id: 'mem_new', type: 'preference', content: '提交前跑测试' }))
    cache.markAllStale() // 配置热更新：记忆也变了，新文本会补发
    await cache.assemble(session)
    expect(last().origin).toBe('refreshed')
    expect(last().compactedAt).toBeUndefined()
    cache.markAllStale()
    await cache.assemble(session)
    expect(last().origin).toBe('refreshed')
    cache.markCompacted(session, 9_000)
    await cache.assemble(session)
    expect(last()).toMatchObject({ origin: 'compacted', compactedAt: 9_000 })
    expect(frozen).toHaveLength(4)
  })

  it('构建期间碰上成功压缩：作废这次结果，重建冻结时认领压缩，来历是压缩后', async () => {
    const { store, cache, session, frozen, last } = makeTracked()
    await cache.assemble(session)
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    let entered!: () => void
    const inQuery = new Promise<void>(r => { entered = r })
    const readRaw = store.readRaw.bind(store)
    vi.spyOn(store, 'readRaw').mockImplementationOnce(async (...args) => { entered(); await gate; return readRaw(...args) })
    cache.markStale(session)
    const building = cache.assemble(session)
    await inQuery // 构建已开始，预读挂在 gate 上
    cache.markCompacted(session, 7_000)
    release()
    await building
    expect(frozen).toHaveLength(2)
    expect(last()).toMatchObject({ origin: 'compacted', compactedAt: 7_000 })
  })

  it('构建被之后的 markStale / markAllStale 作废：重建冻结时认领之前没认领的压缩', async () => {
    for (const invalidate of [(c: SnapshotCache, s: object) => { c.markStale(s) }, (c: SnapshotCache) => { c.markAllStale() }]) {
      const { store, cache, session, frozen, last } = makeTracked()
      await cache.assemble(session)
      cache.markCompacted(session, 8_000)
      let release!: () => void
      const gate = new Promise<void>(r => { release = r })
      let entered!: () => void
      const inQuery = new Promise<void>(r => { entered = r })
      const readRaw = store.readRaw.bind(store)
      vi.spyOn(store, 'readRaw').mockImplementationOnce(async (...args) => { entered(); await gate; return readRaw(...args) })
      const building = cache.assemble(session)
      await inQuery
      invalidate(cache, session) // 压缩之后的重建还没落定，又被标过期
      release()
      await building
      expect(frozen).toHaveLength(2)
      expect(last()).toMatchObject({ origin: 'compacted', compactedAt: 8_000 })
    }
  })

  it('本实例第一次冻结时会话已有更早的轮（重启后续上、插件重载）：来历是重新带入，之后的其他重建沿用', async () => {
    const { cache, session, frozen, last } = makeTracked(() => true)
    await cache.assemble(session)
    expect(last().origin).toBe('resumed')
    cache.markAllStale()
    await cache.assemble(session)
    expect(last().origin).toBe('resumed')
    cache.markCompacted(session, 6_000)
    await cache.assemble(session)
    expect(last()).toMatchObject({ origin: 'compacted', compactedAt: 6_000 })
    expect(frozen).toHaveLength(3)
  })

  it('只在第一次冻结时问有没有更早的轮：之后再有新轮也不改成重新带入', async () => {
    let earlier = false
    const { cache, session, last } = makeTracked(() => earlier)
    await cache.assemble(session)
    earlier = true
    cache.markAllStale()
    await cache.assemble(session)
    expect(last().origin).toBe('start')
  })

  it('压缩后这次对话里新写入的记忆进了新快照', async () => {
    const { store, cache, session, last } = makeTracked()
    await cache.assemble(session)
    await store.put(record({ id: 'mem_saved', type: 'knowledge', content: '对话中新写入的' }))
    cache.markCompacted(session, 9_000)
    await cache.assemble(session)
    expect(last().injectedIds).toContain('mem_saved')
  })
})

// 快照走自有消息，不经宿主模板插值：临时文本、完整组装、缓存命中、过期重建四条路径都回 assembleSnapshot 的原文，`{{` 原样保留。
describe('SnapshotCache 出口是原文', () => {
  it('临时文本 → 完整 → 命中 → 过期重建，四步都逐字等于原文，召回只计一次', async () => {
    const { store, cache } = makeCache()
    const spy = vi.spyOn(store, 'markRecalled')
    await store.put(record({ id: 'mem_vue', type: 'preference', content: 'Vue 模板写 {{ msg }}' }))
    await store.put(record({ id: 'mem_ci', type: 'preference', scope: 'workspace', workspacePath: '/repo', content: 'CI 用 ${{ secrets.NPM_TOKEN }}' }))
    const raw = async (workspacePath: string | undefined) => assembleSnapshot({
      records: await store.query({ scope: { kind: 'visible', workspacePath } }),
      registry, budget: 4000, workspacePath, now: Date.now(),
    }).text
    const session = {}

    // ① workspace 未解析：global-only 临时文本
    const fallbackRaw = await raw(undefined)
    expect(fallbackRaw).toContain('{{ msg }}')
    expect(await cache.assemble(session)).toBe(fallbackRaw)

    // ② 解析落定：完整组装并写缓存
    cache.setWorkspacePath(session, '/repo')
    const fullRaw = await raw('/repo')
    expect(fullRaw).toContain('${{ secrets.NPM_TOKEN }}')
    expect(await cache.assemble(session)).toBe(fullRaw)

    // ③ 缓存命中
    expect(await cache.assemble(session)).toBe(fullRaw)

    // ④ 过期重建
    cache.markStale(session)
    expect(await cache.assemble(session)).toBe(fullRaw)

    expect(spy).toHaveBeenCalledTimes(1)
  })
})

describe('resolveWorkspacePath', () => {
  // 真实临时目录：realpath 规范化是解析的第一步，凭空路径直接走"目录不存在"分支
  let tmpRoot: string
  let tmpReal: string
  beforeAll(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'pm-ws-'))
    tmpReal = await realpath(tmpRoot)
    await mkdir(join(tmpRoot, 'sub', 'deep'), { recursive: true })
  })
  afterAll(async () => {
    await rm(tmpRoot, { recursive: true, force: true })
  })

  it('cwd 为 undefined 返回 undefined', async () => {
    const ctx = { get: () => undefined }
    expect(await resolveWorkspacePath(ctx, undefined)).toBeUndefined()
  })

  it('cwd 目录不存在返回 undefined（等同无工作目录，save 会拒存）', async () => {
    const ctx = { get: () => undefined }
    expect(await resolveWorkspacePath(ctx, '/definitely/not/a/real/dir')).toBeUndefined()
  })

  it('workspaceRegistry 缺席时退用规范化 cwd 当目录作用域（Ungrouped 会话不落 global）', async () => {
    const ctx = { get: () => undefined }
    expect(await resolveWorkspacePath(ctx, tmpRoot)).toBe(tmpReal)
  })

  it('registry 精确命中时返回 workspace path', async () => {
    const ctx = { get: () => ({ resolveByPath: async (p: string) => (p === tmpReal ? { path: tmpReal } : undefined) }) }
    expect(await resolveWorkspacePath(ctx, tmpRoot)).toBe(tmpReal)
  })

  it('子目录会话经祖先探测归属所在 workspace（resolveByPath 只做精确匹配）', async () => {
    const ctx = { get: () => ({ resolveByPath: async (p: string) => (p === tmpReal ? { path: tmpReal } : undefined) }) }
    expect(await resolveWorkspacePath(ctx, join(tmpRoot, 'sub', 'deep'))).toBe(tmpReal)
  })

  it('resolveByPath 抛错时落到兜底的目录作用域而非 undefined', async () => {
    const ctx = { get: () => ({ resolveByPath: async () => { throw new Error('boom') } }) }
    expect(await resolveWorkspacePath(ctx, tmpRoot)).toBe(tmpReal)
  })
})
