import { describe, expect, it } from 'vitest'
import { PendingDecisionsStore, dedupKey } from '../src/governance/decisions.ts'
import { InMemoryKvTable } from '../src/kv-table.ts'
import type { PendingDecision } from '../src/governance/schema.ts'

function makeStore() {
  return new PendingDecisionsStore(new InMemoryKvTable<PendingDecision>())
}

describe('dedupKey', () => {
  it('memoryIds 排序后无关顺序，baselineRef 参与区分', () => {
    expect(dedupKey(['b', 'a'])).toBe(dedupKey(['a', 'b']))
    expect(dedupKey(['a', 'b'])).not.toBe(dedupKey(['a', 'b'], 'AGENTS.md：某规则'))
  })
})

describe('PendingDecisionsStore', () => {
  it('upsert 新冲突创建条目，同 key 再报只更新 summary 保留 firstSeenAt', async () => {
    const s = makeStore()
    const r1 = await s.upsert({ memoryIds: ['mem_a', 'mem_b'], summary: '第一次措辞' }, 100)
    expect(r1.created).toBe(true)
    expect(r1.entry.firstSeenAt).toBe(100)
    expect(Object.keys(r1.entry)).not.toContain('baselineRef')

    const r2 = await s.upsert({ memoryIds: ['mem_b', 'mem_a'], summary: '第二次措辞' }, 200)
    expect(r2.created).toBe(false)
    expect(r2.entry.id).toBe(r1.entry.id)
    expect(r2.entry.firstSeenAt).toBe(100)
    expect(r2.entry.summary).toBe('第二次措辞')
    expect(s.list()).toHaveLength(1)
  })

  it('垂直冲突（带 baselineRef）与横向冲突不互相去重', async () => {
    const s = makeStore()
    await s.upsert({ memoryIds: ['mem_a'], baselineRef: 'AGENTS.md：X', summary: 'v' }, 1)
    await s.upsert({ memoryIds: ['mem_a'], baselineRef: 'AGENTS.md：Y', summary: 'v2' }, 2)
    expect(s.list()).toHaveLength(2)
  })

  it('removeByMemoryIds 删除引用任一 id 的条目并返回数量', async () => {
    const s = makeStore()
    await s.upsert({ memoryIds: ['mem_a', 'mem_b'], summary: '1' }, 1)
    await s.upsert({ memoryIds: ['mem_c'], baselineRef: 'AGENTS.md：X', summary: '2' }, 2)
    await s.upsert({ memoryIds: ['mem_d', 'mem_e'], summary: '3' }, 3)
    const n = await s.removeByMemoryIds(['mem_b', 'mem_c'])
    expect(n).toBe(2)
    expect(s.list().map(e => e.summary)).toEqual(['3'])
  })

  it('list 按 firstSeenAt 升序；remove 幂等', async () => {
    const s = makeStore()
    const { entry } = await s.upsert({ memoryIds: ['mem_x', 'mem_y'], summary: '后' }, 200)
    await s.upsert({ memoryIds: ['mem_p', 'mem_q'], summary: '先' }, 100)
    expect(s.list().map(e => e.summary)).toEqual(['先', '后'])
    expect(await s.remove(entry.id)).toBe(true)
    expect(await s.remove(entry.id)).toBe(false)
  })
})
