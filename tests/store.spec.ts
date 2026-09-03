import { describe, expect, it } from 'vitest'
import { MemoryStore, InMemoryTable } from '../src/store.ts'
import { record } from './helpers/record.ts'

describe('MemoryStore.query', () => {
  it('visible 过滤：global + 匹配 workspace，排除其他 workspace', async () => {
    const store = new MemoryStore(new InMemoryTable())
    await store.put(record({ id: 'g', scope: 'global' }))
    await store.put(record({ id: 'w1', scope: 'workspace', workspacePath: '/a' }))
    await store.put(record({ id: 'w2', scope: 'workspace', workspacePath: '/b' }))
    const ids = store.query({ scope: { kind: 'visible', workspacePath: '/a' } }).map(r => r.id)
    expect(ids.sort()).toEqual(['g', 'w1'])
  })

  it('workspacePath 为 undefined 时只见 global', async () => {
    const store = new MemoryStore(new InMemoryTable())
    await store.put(record({ id: 'g', scope: 'global' }))
    await store.put(record({ id: 'w', scope: 'workspace', workspacePath: '/a' }))
    expect(store.query({ scope: { kind: 'visible', workspacePath: undefined } }).map(r => r.id)).toEqual(['g'])
  })

  it('status 缺省只返回 active（superseded/deleted 排除）', async () => {
    const store = new MemoryStore(new InMemoryTable())
    await store.put(record({ id: 'a', status: 'active' }))
    await store.put(record({ id: 'd', status: 'deleted' }))
    await store.put(record({ id: 'p', status: 'superseded' }))
    expect(store.query({}).map(r => r.id)).toEqual(['a'])
  })

  it('keyword 对 content/summary/tags 小写子串匹配', async () => {
    const store = new MemoryStore(new InMemoryTable())
    await store.put(record({ id: 'hit', content: '用 PostgreSQL 存储' }))
    await store.put(record({ id: 'miss', content: '无关内容', summary: '无关' }))
    expect(store.query({ keyword: 'postgresql' }).map(r => r.id)).toEqual(['hit'])
  })
})

describe('MemoryStore 变更', () => {
  it('softDelete 置 status 为 deleted', async () => {
    const store = new MemoryStore(new InMemoryTable())
    await store.put(record({ id: 'x' }))
    expect(await store.softDelete('x')).toBe(true)
    expect(store.get('x')!.status).toBe('deleted')
    expect(await store.softDelete('ghost')).toBe(false)
  })

  it('markRecalled 刷新统计', async () => {
    const store = new MemoryStore(new InMemoryTable())
    await store.put(record({ id: 'x' }))
    store.markRecalled(['x'])
    await new Promise(r => setTimeout(r, 0))
    expect(store.get('x')!.recallCount).toBe(1)
    expect(store.get('x')!.lastRecalledAt).not.toBeNull()
  })
})
