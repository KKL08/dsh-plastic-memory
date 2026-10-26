import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SnapshotCache, resolveWorkspacePath, type FrozenSnapshotInfo } from '../src/runtime.ts'
import { MemoryStore, InMemoryTable } from '../src/store.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'
import { COLD_START_TEXT, PROMPT_LBRACE_VARIABLE, assembleSnapshot } from '../src/snapshot.ts'
import type { MemoryRecord } from '../src/record-schema.ts'
import { record as baseRecord } from './helpers/record.ts'
import { renderViaHost } from './helpers/render-via-host.ts'
import { workspaceDirName } from '../src/storage/paths.ts'

const registry = buildTypeRegistry({ template: 'coding', customTypes: {} })

// 本文件默认时间戳为 0。
const record = (partial: Partial<MemoryRecord> = {}) => baseRecord({ createdAt: 0, updatedAt: 0, lastConfirmedAt: 0, ...partial })

function makeCache(store = new MemoryStore(new InMemoryTable())) {
  return { store, cache: new SnapshotCache({ store, registry, budget: 4000 }) }
}

describe('SnapshotCache', () => {
  it('中间件组装前 provider 返回空串（不是冷启动文案），不 markRecalled', () => {
    const { store, cache } = makeCache()
    const spy = vi.spyOn(store, 'markRecalled')
    const session = {}
    expect(cache.render(session)).toBe('')
    expect(spy).not.toHaveBeenCalled()
  })

  it('中间件首次组装后 provider 返回缓存文本（与中间件写入的文本逐字相同）', async () => {
    const { store, cache } = makeCache()
    await store.put(record({ id: 'mem_core', type: 'preference', content: '不要 mock 数据库' }))
    const session = {}
    cache.setWorkspacePath(session, undefined)
    expect(cache.render(session)).toBe('')
    const injected = await cache.assemble(session)
    expect(injected).toContain('不要 mock 数据库')
    expect(cache.render(session)).toBe(injected)
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
    expect(cache.render(session)).toBe('') // 临时文本只进本次 entry，不进缓存
    expect(spy).not.toHaveBeenCalled()

    // 未冻结：workspace 解析完成后下一次中间件拿到完整版
    cache.setWorkspacePath(session, '/repo')
    const second = await cache.assemble(session)
    expect(second).toContain('仅本仓库生效的偏好')
    expect(cache.render(session)).toBe(second)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('setWorkspacePath 后 assemble 返回完整版并冻结，markRecalled 恰调用一次且参数为 core id', async () => {
    const { store, cache } = makeCache()
    const spy = vi.spyOn(store, 'markRecalled')
    await store.put(record({ id: 'mem_core', type: 'preference', content: '不要 mock 数据库' }))
    const session = {}
    cache.setWorkspacePath(session, undefined)

    const text = await cache.assemble(session)
    expect(text).toContain('不要 mock 数据库')
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalledWith(['mem_core'])

    // 冻结：后续写入新记忆，同一 session 仍返回旧快照，不重新组装，也不再计召回
    await store.put(record({ id: 'mem_new', type: 'preference', content: '另一条偏好' }))
    expect(await cache.assemble(session)).toBe(text)
    expect(cache.render(session)).toBe(text)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('两次组装之间的刷新拿到上一份：markStale 后 provider 仍返回旧快照，下一次组装返回新快照', async () => {
    const { store, cache } = makeCache()
    await store.put(record({ id: 'mem_old', type: 'preference', content: '旧偏好' }))
    const session = {}
    cache.setWorkspacePath(session, undefined)
    const before = await cache.assemble(session)

    await store.put(record({ id: 'mem_new', type: 'preference', content: '压缩后新增的偏好' }))
    cache.markStale(session)
    // 两次组装之间只调同步 provider 的刷新：拿到上一份快照，不是空串
    expect(cache.render(session)).toBe(before)

    const after = await cache.assemble(session)
    expect(after).toContain('压缩后新增的偏好')
    expect(cache.render(session)).toBe(after)
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

  it('空库：冷启动文案由组装产出并进缓存（provider 不兜底）', async () => {
    const { cache } = makeCache()
    const session = {}
    expect(cache.render(session)).toBe('')
    cache.setWorkspacePath(session, undefined)
    expect(await cache.assemble(session)).toBe(COLD_START_TEXT)
    expect(cache.render(session)).toBe(COLD_START_TEXT)
  })

  it('空库 + 未解析：global-only 临时文本是冷启动文案，provider 仍为空串', async () => {
    const { cache } = makeCache()
    const session = {}
    expect(await cache.assemble(session)).toBe(COLD_START_TEXT)
    expect(cache.render(session)).toBe('')
  })

  it('markStale 后按最新状态重新组装', async () => {
    const { store, cache } = makeCache()
    const session = {}
    cache.setWorkspacePath(session, undefined)
    expect(await cache.assemble(session)).toBe(COLD_START_TEXT) // 冻结冷启动文案
    await store.put(record({ id: 'mem_new', type: 'preference', content: '不要 mock 数据库' }))
    cache.markStale(session)
    expect(cache.render(session)).toBe(COLD_START_TEXT) // 过期不清空
    const text = await cache.assemble(session)
    expect(text).not.toBe(COLD_START_TEXT)
    expect(text).toContain('不要 mock 数据库')
  })

  it('构建竞态：预读挂起期间被标过期，失效前组装的文本不写进缓存，下一次中间件重建并冻结', async () => {
    const { store, cache } = makeCache()
    const spy = vi.spyOn(store, 'markRecalled')
    await store.put(record({ id: 'mem_before', type: 'preference', content: '失效前的偏好' }))
    const session = {}
    cache.setWorkspacePath(session, undefined)

    // 可控的 store 替身：本次预读按调用时刻读出记录，然后挂起，直到测试放行
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const query = store.readLayer.bind(store)
    let entered!: () => void
    const inQuery = new Promise<void>(r => { entered = r })
    vi.spyOn(store, 'readLayer').mockImplementationOnce(async (...args) => {
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
    const stale = await pending

    // 本次 entry 可以用这份文本，但它不得进缓存，也不计召回
    expect(stale).toContain('失效前的偏好')
    expect(stale).not.toContain('压缩后的偏好')
    expect(cache.render(session)).toBe('')
    expect(spy).not.toHaveBeenCalled()

    // 下一次中间件按最新状态重建、冻结、首次计召回
    const fresh = await cache.assemble(session)
    expect(fresh).toContain('压缩后的偏好')
    expect(cache.render(session)).toBe(fresh)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('构建竞态：已冻结的会话重建期间再次被标过期，provider 继续回上一份快照而非失效前的重建结果', async () => {
    const { store, cache } = makeCache()
    await store.put(record({ id: 'mem_a', type: 'preference', content: '第一版偏好' }))
    const session = {}
    cache.setWorkspacePath(session, undefined)
    const first = await cache.assemble(session)

    await store.put(record({ id: 'mem_b', type: 'preference', content: '第二版偏好' }))
    cache.markStale(session)

    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const query = store.readLayer.bind(store)
    let entered!: () => void
    const inQuery = new Promise<void>(r => { entered = r })
    vi.spyOn(store, 'readLayer').mockImplementationOnce(async (...args) => {
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
    const discarded = await pending
    expect(discarded).toContain('第二版偏好')
    expect(cache.render(session)).toBe(first) // 被丢弃的重建结果没覆盖缓存

    const latest = await cache.assemble(session)
    expect(latest).toContain('第三版偏好')
    expect(cache.render(session)).toBe(latest)
  })

  it('构造 memoryRoot 时，临时文本与冻结快照都含磁盘路径行（⑧×D1）', async () => {
    const store = new MemoryStore(new InMemoryTable())
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
    const store = new MemoryStore(new InMemoryTable('/home/.dsh/memories'))
    await store.put(record({ id: 'mem_g', name: '网关限流', type: 'knowledge', summary: '阈值 80', lastConfirmedAt: Date.now() }))
    await store.put(record({ id: 'mem_w', name: '发布节奏', type: 'knowledge', summary: '周四发布', scope: 'workspace', workspacePath: '/repo', lastConfirmedAt: Date.now() }))
    const cache = new SnapshotCache({ store, registry, budget: 4000, memoryRoot: '/home/.dsh/memories' })
    const session = {}
    cache.setWorkspacePath(session, '/repo')
    const lines = (await cache.assemble(session)).split('\n')
    expect(lines).toContain('- [mem_g] 网关限流（阈值 80） · global/网关限流.md')
    expect(lines).toContain(`- [mem_w] 发布节奏（周四发布） · ${workspaceDirName('/repo')}/发布节奏.md`)
  })

  it('HMR 已知窗口：新建缓存实例对存量 session 首次 provider 为空串并触发解析；首次中间件补上，解析落定后冻结完整版', async () => {
    const store = new MemoryStore(new InMemoryTable())
    const spy = vi.spyOn(store, 'markRecalled')
    await store.put(record({ id: 'mem_global', type: 'preference', content: '不要 mock 数据库' }))
    await store.put(record({ id: 'mem_ws', type: 'preference', scope: 'workspace', workspacePath: '/repo', content: '仅本仓库生效的偏好' }))

    // 模拟热重载后的新实例：没经过任何 session/created，仅靠 provider 侧自愈解析 workspace
    let calls = 0
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const cache = new SnapshotCache({
      store, registry, budget: 4000,
      resolveWorkspace: async (s: object) => { calls++; await gate; return (s as { header?: { cwd?: string } }).header?.cwd },
    })
    const session = { header: { cwd: '/repo' } }

    // 已知窗口：缓存为空，首次同步 provider 回空串（同时触发自愈解析）
    expect(cache.render(session)).toBe('')
    // 首次中间件：解析未落定（超时放行），global-only 临时文本补上，不含 workspace 记忆、不计召回
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
    expect(cache.render(session)).toBe(second)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('assemble：首轮组装显式等待解析——等待后的首次组装即完整版（不赌宿主时序）', async () => {
    const store = new MemoryStore(new InMemoryTable())
    await store.put(record({ content: '全局条目', type: 'preference' }))
    await store.put(record({ content: '仅本仓库生效的偏好', type: 'preference', scope: 'workspace', workspacePath: '/repo' }))
    const cache = new SnapshotCache({
      store, registry, budget: 4000,
      resolveWorkspace: async (s: object) => {
        await new Promise(r => setTimeout(r, 20)) // 模拟慢解析：必然晚于同步首轮组装
        return (s as { header?: { cwd?: string } }).header?.cwd
      },
    })
    const session = { header: { cwd: '/repo' } }
    expect(await cache.assemble(session)).toContain('仅本仓库生效的偏好')
  })

  it('awaitResolved 只等解析：落定后不组装，provider 仍为空串', async () => {
    const { store } = makeCache()
    const spy = vi.spyOn(store, 'readLayer')
    const cache = new SnapshotCache({ store, registry, budget: 4000, resolveWorkspace: async () => '/repo' })
    const session = { header: { cwd: '/repo' } }
    await cache.awaitResolved(session)
    expect(spy).not.toHaveBeenCalled()
    expect(cache.render(session)).toBe('')
  })

  it('assemble：解析悬挂时超时放行，走 global-only 临时文本，不冻结、不计召回', async () => {
    const store = new MemoryStore(new InMemoryTable())
    const spy = vi.spyOn(store, 'markRecalled')
    await store.put(record({ content: '全局条目', type: 'preference' }))
    await store.put(record({ content: '仅本仓库生效的偏好', type: 'preference', scope: 'workspace', workspacePath: '/repo' }))
    const cache = new SnapshotCache({
      store, registry, budget: 4000,
      resolveWorkspace: () => new Promise<string | undefined>(() => {}), // 永不落定
    })
    const session = { header: { cwd: '/repo' } }
    const text = await cache.assemble(session, 30)
    expect(text).toContain('全局条目')
    expect(text).not.toContain('仅本仓库生效的偏好')
    expect(cache.render(session)).toBe('')
    expect(spy).not.toHaveBeenCalled()
  })

  it('组装失败只记日志：有旧快照回旧快照，没有回空串，不抛', async () => {
    const { store } = makeCache()
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const cache = new SnapshotCache({ store, registry, budget: 4000, log })
    const session = {}
    cache.setWorkspacePath(session, undefined)
    vi.spyOn(store, 'readLayer').mockRejectedValueOnce(new Error('boom'))
    expect(await cache.assemble(session)).toBe('')
    expect(log.error).toHaveBeenCalledTimes(1)

    const frozen = await cache.assemble(session)
    cache.markStale(session)
    vi.spyOn(store, 'readLayer').mockRejectedValueOnce(new Error('boom'))
    expect(await cache.assemble(session)).toBe(frozen)
    expect(log.error).toHaveBeenCalledTimes(2)
  })

  it('在途解析去重：同一 session 连续两次 render 只触发一次 resolveWorkspace', () => {
    const { store } = makeCache()
    let calls = 0
    const cache = new SnapshotCache({
      store, registry, budget: 4000,
      resolveWorkspace: async () => { calls++; return '/repo' },
    })
    const session = { header: { cwd: '/repo' } }
    cache.render(session)
    cache.render(session)
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
    // b 未经中间件组装，provider 不受 a 的缓存影响
    expect(cache.render(b)).toBe('')
  })
})

// 快照来历（会话视图的 origin）：首次冻结是对话开始时；成功压缩后的下一次冻结是压缩后重新带入；
// 其他重建（失败的压缩、配置热更新）沿用上一次的来历。
describe('SnapshotCache 快照来历', () => {
  function makeTracked() {
    const store = new MemoryStore(new InMemoryTable())
    const frozen: FrozenSnapshotInfo[] = []
    const cache = new SnapshotCache({ store, registry, budget: 4000, onFrozen: (_s, info) => { frozen.push(info) } })
    const session = {}
    cache.setWorkspacePath(session, undefined)
    return { store, cache, session, frozen, last: () => frozen.at(-1)! }
  }

  it('首次冻结的来历是对话开始时，带出带入全文的 core id', async () => {
    const { store, cache, session, last } = makeTracked()
    await store.put(record({ id: 'mem_core', type: 'preference', content: '不要 mock 数据库' }))
    await store.put(record({ id: 'mem_idx', type: 'knowledge', content: '报销截止每月 25 日' }))
    await cache.assemble(session)
    expect(last()).toMatchObject({ origin: 'start', coreIds: ['mem_core'] })
    expect(last().compactedAt).toBeUndefined()
    expect(last().injectedIds).toEqual(['mem_core', 'mem_idx'])
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

  it('构建期间碰上成功压缩：这次的结果不冻结，压缩记到下一次冻结', async () => {
    const { store, cache, session, frozen, last } = makeTracked()
    await cache.assemble(session)
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    let entered!: () => void
    const inQuery = new Promise<void>(r => { entered = r })
    const readLayer = store.readLayer.bind(store)
    vi.spyOn(store, 'readLayer').mockImplementationOnce(async (...args) => { entered(); await gate; return readLayer(...args) })
    cache.markStale(session)
    const building = cache.assemble(session)
    await inQuery // 构建已开始，预读挂在 gate 上
    cache.markCompacted(session, 7_000)
    release()
    await building
    expect(frozen).toHaveLength(1)
    await cache.assemble(session)
    expect(last()).toMatchObject({ origin: 'compacted', compactedAt: 7_000 })
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

// 快照的两个出口（中间件写入的 assemble 返回值、同步 provider 的 render）在临时文本、完整组装、缓存命中、
// 过期重建四条路径上都要转义且只转义一次。判据用宿主真实渲染往返：转义文本经宿主插值还原后逐字等于 assembleSnapshot 的原文。
describe('SnapshotCache 出口转义 {{', () => {
  it('临时文本 → 完整 → 命中 → 过期重建，四步都经宿主还原为原文，召回只计一次', async () => {
    const { store, cache } = makeCache()
    const spy = vi.spyOn(store, 'markRecalled')
    await store.put(record({ id: 'mem_vue', type: 'preference', content: 'Vue 模板写 {{ msg }}' }))
    await store.put(record({ id: 'mem_lit', type: 'preference', content: `字面 {{${PROMPT_LBRACE_VARIABLE}}} 探测二次转义` }))
    await store.put(record({ id: 'mem_ci', type: 'preference', scope: 'workspace', workspacePath: '/repo', content: 'CI 用 ${{ secrets.NPM_TOKEN }}' }))
    const raw = async (workspacePath: string | undefined) => assembleSnapshot({
      records: await store.query({ scope: { kind: 'visible', workspacePath } }),
      registry, budget: 4000, workspacePath, now: Date.now(),
    }).text
    const session = {}

    // ① workspace 未解析：global-only 临时文本
    const fallback = await cache.assemble(session)
    const fallbackRaw = await raw(undefined)
    expect(fallbackRaw).toContain('{{ msg }}')
    expect(fallback).not.toBe(fallbackRaw)
    expect(renderViaHost(fallback)).toBe(fallbackRaw)

    // ② 解析落定：完整组装并写缓存
    cache.setWorkspacePath(session, '/repo')
    const full = await cache.assemble(session)
    const fullRaw = await raw('/repo')
    expect(fullRaw).toContain('${{ secrets.NPM_TOKEN }}')
    expect(renderViaHost(full)).toBe(fullRaw)

    // ③ 缓存命中：中间件与 provider 都与 ② 逐字相同（仍是转义后的文本，不是缓存里的原文）
    expect(await cache.assemble(session)).toBe(full)
    expect(cache.render(session)).toBe(full)

    // ④ 过期重建：provider 回旧快照，重建结果仍经宿主还原为原文
    cache.markStale(session)
    expect(renderViaHost(cache.render(session))).toBe(fullRaw)
    expect(renderViaHost(await cache.assemble(session))).toBe(fullRaw)

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

  it('workspaceRegistry 缺席时退用规范化 cwd 当目录桶（Ungrouped 会话不落 global）', async () => {
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

  it('resolveByPath 抛错时落到目录兜底桶而非 undefined', async () => {
    const ctx = { get: () => ({ resolveByPath: async () => { throw new Error('boom') } }) }
    expect(await resolveWorkspacePath(ctx, tmpRoot)).toBe(tmpReal)
  })
})
