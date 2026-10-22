import { describe, expect, it, vi } from 'vitest'
import { MemoryStore, InMemoryTable } from '../src/store.ts'
import { InMemoryBatchKvTable } from '../src/kv-table.ts'
import type { RecallStats } from '../src/storage/schema.ts'
import { record } from './helpers/record.ts'

describe('MemoryStore.query', () => {
  it('visible 过滤：global + 匹配 workspace，排除其他 workspace', async () => {
    const store = new MemoryStore(new InMemoryTable())
    await store.put(record({ id: 'g', scope: 'global' }))
    await store.put(record({ id: 'w1', scope: 'workspace', workspacePath: '/a' }))
    await store.put(record({ id: 'w2', scope: 'workspace', workspacePath: '/b' }))
    const ids = (await store.query({ scope: { kind: 'visible', workspacePath: '/a' } })).map(r => r.id)
    expect(ids.sort()).toEqual(['g', 'w1'])
  })

  it('workspacePath 为 undefined 时只见 global', async () => {
    const store = new MemoryStore(new InMemoryTable())
    await store.put(record({ id: 'g', scope: 'global' }))
    await store.put(record({ id: 'w', scope: 'workspace', workspacePath: '/a' }))
    expect((await store.query({ scope: { kind: 'visible', workspacePath: undefined } })).map(r => r.id)).toEqual(['g'])
  })

  it('status 缺省只返回 active（superseded/deleted 排除）', async () => {
    const store = new MemoryStore(new InMemoryTable())
    await store.put(record({ id: 'a', status: 'active' }))
    await store.put(record({ id: 'd', status: 'deleted' }))
    await store.put(record({ id: 'p', status: 'superseded' }))
    expect((await store.query({})).map(r => r.id)).toEqual(['a'])
  })

  it('keyword 对 content/summary/tags 小写子串匹配', async () => {
    const store = new MemoryStore(new InMemoryTable())
    await store.put(record({ id: 'hit', content: '用 PostgreSQL 存储' }))
    await store.put(record({ id: 'miss', content: '无关内容', summary: '无关' }))
    expect((await store.query({ keyword: 'postgresql' })).map(r => r.id)).toEqual(['hit'])
  })
})

describe('MemoryStore 变更', () => {
  it('softDelete 置 status 为 deleted', async () => {
    const store = new MemoryStore(new InMemoryTable())
    await store.put(record({ id: 'x' }))
    expect(await store.softDelete({ id: 'x', workspacePath: undefined })).toBe(true)
    expect((await store.get('x'))!.status).toBe('deleted')
    expect(await store.softDelete({ id: 'ghost', workspacePath: undefined })).toBe(false)
  })

  it('markRecalled 读改写召回统计侧表，不改记录', async () => {
    const stats = new InMemoryBatchKvTable<RecallStats>()
    const store = new MemoryStore(new InMemoryTable(), undefined, stats)
    await store.put(record({ id: 'x' }))
    await store.markRecalled(['x'])
    expect(await stats.get('x')).toMatchObject({ id: 'x', recallCount: 1 })
    expect((await stats.get('x'))!.lastRecalledAt).not.toBeNull()
    expect((await store.get('x'))!.recallCount).toBe(0)
  })

  it('markRecalled 并发调用不丢计数（进程内读改写串行）', async () => {
    const stats = new InMemoryBatchKvTable<RecallStats>()
    const store = new MemoryStore(new InMemoryTable(), undefined, stats)
    await store.put(record({ id: 'x' }))
    await Promise.all([store.markRecalled(['x']), store.markRecalled(['x']), store.markRecalled(['x'])])
    expect((await stats.get('x'))!.recallCount).toBe(3)
  })

  it('markRecalled 召回 N 个 id：一次读、内存合并、一次批量写（不逐条 put）', async () => {
    const stats = new InMemoryBatchKvTable<RecallStats>()
    const store = new MemoryStore(new InMemoryTable(), undefined, stats)
    for (const id of ['a', 'b', 'c']) await store.put(record({ id }))
    await stats.put('b', { id: 'b', recallCount: 4, lastRecalledAt: 1 })
    const put = vi.spyOn(stats, 'put')
    const putMany = vi.spyOn(stats, 'putMany')
    await store.markRecalled(['a', 'b', 'c', 'a'])
    expect(put).not.toHaveBeenCalled()
    expect(putMany).toHaveBeenCalledTimes(1)
    // 'a' 出现两次按两次计（与改批量前逐条累加的行为一致）。ids 来自调用方同一次读取，这里不再逐 id 核对存活
    expect((await stats.list()).map(([k, v]) => [k, v.recallCount]).sort()).toEqual([['a', 2], ['b', 5], ['c', 1]])
  })
})
