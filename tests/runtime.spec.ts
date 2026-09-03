import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SnapshotCache, resolveWorkspacePath } from '../src/runtime.ts'
import { MemoryStore, InMemoryTable } from '../src/store.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'
import { COLD_START_TEXT } from '../src/snapshot.ts'
import type { MemoryRecord } from '../src/record-schema.ts'
import { record as baseRecord } from './helpers/record.ts'

const registry = buildTypeRegistry({ template: 'coding', customTypes: {} })

// 本文件默认时间戳为 0。
const record = (partial: Partial<MemoryRecord> = {}) => baseRecord({ createdAt: 0, updatedAt: 0, lastConfirmedAt: 0, ...partial })

function makeCache(store = new MemoryStore(new InMemoryTable())) {
  return { store, cache: new SnapshotCache({ store, registry, budget: 4000 }) }
}

describe('SnapshotCache', () => {
  it('workspacePath 未解析且空库时，render 走兜底返回 COLD_START_TEXT，且不 markRecalled', () => {
    const { store, cache } = makeCache()
    const spy = vi.spyOn(store, 'markRecalled')
    const session = {}
    expect(cache.render(session)).toBe(COLD_START_TEXT)
    expect(spy).not.toHaveBeenCalled()
  })

  it('workspacePath 未解析时，render 返回非空 global-only 兜底（不含 workspace 记忆），不缓存不 markRecalled', async () => {
    const { store, cache } = makeCache()
    const spy = vi.spyOn(store, 'markRecalled')
    await store.put(record({ id: 'mem_global', type: 'preference', content: '不要 mock 数据库' }))
    await store.put(record({ id: 'mem_ws', type: 'preference', scope: 'workspace', workspacePath: '/repo', content: '仅本仓库生效的偏好' }))
    const session = {}

    const first = cache.render(session)
    expect(first).toContain('不要 mock 数据库')
    expect(first).not.toContain('仅本仓库生效的偏好')
    expect(spy).not.toHaveBeenCalled()

    // 未冻结：workspace 解析完成后仍能拿到完整版，证明兜底路径没把内容缓存住
    cache.setWorkspacePath(session, '/repo')
    const second = cache.render(session)
    expect(second).toContain('仅本仓库生效的偏好')
  })

  it('setWorkspacePath 后 render 返回完整版并冻结，markRecalled 恰调用一次且参数为 core id', async () => {
    const { store, cache } = makeCache()
    const spy = vi.spyOn(store, 'markRecalled')
    await store.put(record({ id: 'mem_core', type: 'preference', content: '不要 mock 数据库' }))
    const session = {}
    cache.setWorkspacePath(session, undefined)

    const text = cache.render(session)
    expect(text).toContain('不要 mock 数据库')
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalledWith(['mem_core'])

    // 冻结：后续写入新记忆，同一 session 仍返回旧快照，不重新组装，也不再计召回
    await store.put(record({ id: 'mem_new', type: 'preference', content: '另一条偏好' }))
    expect(cache.render(session)).toBe(text)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('同一 session render → invalidate → render，召回只计一次', async () => {
    const { store, cache } = makeCache()
    const spy = vi.spyOn(store, 'markRecalled')
    await store.put(record({ id: 'mem_core', type: 'preference', content: '不要 mock 数据库' }))
    const session = {}
    cache.setWorkspacePath(session, undefined)

    cache.render(session)
    cache.invalidate(session)      // 模拟压缩失效
    const rebuilt = cache.render(session)          // 重建：内容重新组装但不重复计召回
    expect(rebuilt).toContain('不要 mock 数据库')  // 确有重建产出（非空、非兜底），召回计数才有意义
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('空库 + 未解析 → 兜底返回 COLD_START_TEXT', () => {
    const { cache } = makeCache()
    const session = {}
    expect(cache.render(session)).toBe(COLD_START_TEXT)
  })

  it('invalidate 后按最新状态重新组装', async () => {
    const { store, cache } = makeCache()
    const session = {}
    cache.setWorkspacePath(session, undefined)
    cache.render(session) // 冻结冷启动文案
    await store.put(record({ id: 'mem_new', type: 'preference', content: '不要 mock 数据库' }))
    cache.invalidate(session)
    const text = cache.render(session)
    expect(text).not.toBe(COLD_START_TEXT)
    expect(text).toContain('不要 mock 数据库')
  })

  it('构造 memoryRoot 时，兜底路径与完整路径的快照都含磁盘路径行（⑧×D1）', async () => {
    const store = new MemoryStore(new InMemoryTable())
    await store.put(record({ id: 'mem_g', type: 'preference', content: '不要 mock 数据库' }))
    const cache = new SnapshotCache({ store, registry, budget: 4000, memoryRoot: '/home/.dsh/memories' })
    const session = {}
    // 兜底路径（workspace 未解析）
    expect(cache.render(session)).toContain('/home/.dsh/memories/global/')
    // 完整路径（解析完成后冻结）
    cache.setWorkspacePath(session, undefined)
    expect(cache.render(session)).toContain('/home/.dsh/memories/global/')
  })

  it('HMR 自愈：新建缓存实例对存量 session 首次 render 走兜底并触发解析，解析落定后组装完整版并冻结', async () => {
    const store = new MemoryStore(new InMemoryTable())
    const spy = vi.spyOn(store, 'markRecalled')
    await store.put(record({ id: 'mem_global', type: 'preference', content: '不要 mock 数据库' }))
    await store.put(record({ id: 'mem_ws', type: 'preference', scope: 'workspace', workspacePath: '/repo', content: '仅本仓库生效的偏好' }))

    // 模拟热重载后的新实例：没经过任何 session/created，仅靠 render 侧自愈解析 workspace
    let calls = 0
    const cache = new SnapshotCache({
      store, registry, budget: 4000,
      resolveWorkspace: async (s: object) => { calls++; return (s as { header?: { cwd?: string } }).header?.cwd },
    })
    const session = { header: { cwd: '/repo' } }

    // 首次 render：workspace 未解析，global-only 兜底，不含 workspace 记忆、不计召回
    const first = cache.render(session)
    expect(first).toContain('不要 mock 数据库')
    expect(first).not.toContain('仅本仓库生效的偏好')
    expect(spy).not.toHaveBeenCalled()

    // 等待 fire-and-forget 解析落定
    await new Promise(r => setTimeout(r))
    expect(calls).toBe(1)

    // 解析完成后 render：完整版含 workspace 记忆，冻结并计召回一次
    const second = cache.render(session)
    expect(second).toContain('仅本仓库生效的偏好')
    expect(spy).toHaveBeenCalledTimes(1)
    // 冻结：后续 render 返回同一快照，不再计召回
    expect(cache.render(session)).toBe(second)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('awaitResolved：首轮组装显式等待解析——等待后的首次 render 即完整版（不赌宿主时序）', async () => {
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
    await cache.awaitResolved(session)
    expect(cache.render(session)).toContain('仅本仓库生效的偏好')
  })

  it('awaitResolved：解析悬挂时超时放行，render 走 global-only 兜底（降级语义不变）', async () => {
    const store = new MemoryStore(new InMemoryTable())
    await store.put(record({ content: '全局条目', type: 'preference' }))
    await store.put(record({ content: '仅本仓库生效的偏好', type: 'preference', scope: 'workspace', workspacePath: '/repo' }))
    const cache = new SnapshotCache({
      store, registry, budget: 4000,
      resolveWorkspace: () => new Promise<string | undefined>(() => {}), // 永不落定
    })
    const session = { header: { cwd: '/repo' } }
    await cache.awaitResolved(session, 30)
    const text = cache.render(session)
    expect(text).toContain('全局条目')
    expect(text).not.toContain('仅本仓库生效的偏好')
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

  it('缓存按 session 隔离', () => {
    const { cache } = makeCache()
    const a = {}
    const b = {}
    cache.setWorkspacePath(a, undefined)
    expect(cache.render(a)).toBe(COLD_START_TEXT)
    // b 未解析 workspace，独立走兜底，不受 a 影响
    expect(cache.render(b)).toBe(COLD_START_TEXT)
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
