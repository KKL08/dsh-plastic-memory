import { describe, expect, it, vi } from 'vitest'
import { SnapshotStore, SNAPSHOT_RETENTION_MS } from '../src/governance/snapshots.ts'
import { InMemoryKvTable } from '../src/kv-table.ts'
import type { MemorySnapshot } from '../src/governance/schema.ts'
import type { MemoryRecord } from '../src/record-schema.ts'
import { record } from './helpers/record.ts'

function makeStore() {
  return new SnapshotStore(new InMemoryKvTable<MemorySnapshot>())
}
/** 这些用例不涉及密钥硬删，写后复核不会要求撤回。 */
const noDiscard = async () => {}

describe('SnapshotStore.capture', () => {
  it('capture 只存受影响记录，list 按 createdAt 倒序', async () => {
    const s = makeStore()
    await s.capture({ operation: 'pre-forget', description: '早', records: [record({ id: 'mem_a' })] }, 100)
    await s.capture({ operation: 'manual', description: '晚', records: [record({ id: 'mem_b' }), record({ id: 'mem_c' })] }, 200)
    const list = await s.list()
    expect(list.map(x => x.description)).toEqual(['晚', '早'])
    expect(list[0].memoryIds.sort()).toEqual(['mem_b', 'mem_c'])
    expect(list[0].data).toHaveLength(2)
  })

  it('capture 顺手清理超过 14 天的旧快照', async () => {
    const s = makeStore()
    await s.capture({ operation: 'manual', description: '老', records: [] }, 0)
    await s.capture({ operation: 'manual', description: '新', records: [] }, SNAPSHOT_RETENTION_MS + 1)
    expect((await s.list()).map(x => x.description)).toEqual(['新'])
  })
})

describe('SnapshotStore.diff / restore', () => {
  it('diff 标出快照后被修改过的记录', async () => {
    const s = makeStore()
    const snap = await s.capture({ operation: 'pre-forget', description: 'd', records: [record({ id: 'mem_a', updatedAt: 50 })] }, 100)
    const changed = record({ id: 'mem_a', content: '改过', updatedAt: 150 })
    const entries = s.diff(snap, new Map([['mem_a', changed]]))
    expect(entries).toHaveLength(1)
    expect(entries[0].changedAfterSnapshot).toBe(true)
  })

  it('restore 默认跳过快照后被修改的记录，overwriteChanged 时覆盖', async () => {
    const s = makeStore()
    const original = record({ id: 'mem_a', content: '原文', updatedAt: 50 })
    const snap = await s.capture({ operation: 'pre-forget', description: 'd', records: [original] }, 100)
    const changed = record({ id: 'mem_a', content: '改过', updatedAt: 150 })

    const written: MemoryRecord[] = []
    const put = async (r: MemoryRecord) => { written.push(r) }

    const r1 = await s.restore(snap, undefined, put, new Map([['mem_a', changed]]), false, noDiscard)
    expect(r1.skipped).toEqual(['mem_a'])
    expect(written).toHaveLength(0)

    const r2 = await s.restore(snap, undefined, put, new Map([['mem_a', changed]]), true, noDiscard)
    expect(r2.restored).toEqual(['mem_a'])
    expect(written[0].content).toBe('原文')
  })

  it('restore 可指定 ids 只恢复部分；已消失的记录直接恢复', async () => {
    const s = makeStore()
    const a = record({ id: 'mem_a', content: 'A' })
    const b = record({ id: 'mem_b', content: 'B' })
    const snap = await s.capture({ operation: 'pre-forget', description: 'd', records: [a, b] }, 100)
    const written: MemoryRecord[] = []
    const r = await s.restore(snap, ['mem_b'], async rec => { written.push(rec) }, new Map(), false, noDiscard)
    expect(r.restored).toEqual(['mem_b'])
    expect(written.map(x => x.id)).toEqual(['mem_b'])
  })

  it('当前记录是软删除状态时不算冲突，默认即可恢复', async () => {
    const s = makeStore()
    const original = record({ id: 'mem_a', content: '原文', updatedAt: 50 })
    const snap = await s.capture({ operation: 'pre-forget', description: 'd', records: [original] }, 100)
    // softDelete 后记录仍在库里：status='deleted' 且 updatedAt 晚于快照
    const softDeleted = record({ id: 'mem_a', content: '原文', status: 'deleted', updatedAt: 150 })

    const written: MemoryRecord[] = []
    const r = await s.restore(snap, undefined, async rec => { written.push(rec) }, new Map([['mem_a', softDeleted]]), false, noDiscard)
    expect(r.restored).toEqual(['mem_a'])
    expect(r.skipped).toEqual([])
    expect(written[0].status).toBe('active')

    // diff 也不应把它标成“快照后被修改过”
    expect(s.diff(snap, new Map([['mem_a', softDeleted]]))[0].changedAfterSnapshot).toBe(false)
  })
})

describe('SnapshotStore.restore：盘上快照只在写前、写后各读一次', () => {
  it('恢复多少条都只读两次快照；写后才脱敏的记录统一撤回，计入 redacted，顺序同快照', async () => {
    const kv = new InMemoryKvTable<MemorySnapshot>()
    const s = new SnapshotStore(kv)
    const records = Array.from({ length: 20 }, (_, i) => record({ id: `mem_${String(i).padStart(2, '0')}` }))
    const snap = await s.capture({ operation: 'manual', description: '大快照', records }, 100)
    const reads = vi.spyOn(kv, 'get')
    const discarded: string[] = []
    const r = await s.restore(snap, undefined, async rec => {
      if (rec.id === 'mem_03' || rec.id === 'mem_11') await s.redact(new Set([rec.id]))   // 写入的同时别的会话把它彻底删除
    }, new Map(), false, async rec => { discarded.push(rec.id) })
    expect(reads).toHaveBeenCalledTimes(2)
    expect(discarded).toEqual(['mem_03', 'mem_11'])
    expect(r.redacted).toEqual(['mem_03', 'mem_11'])
    expect(r.skipped).toEqual(['mem_03', 'mem_11'])
    expect(r.restored).toEqual(records.map(x => x.id).filter(id => id !== 'mem_03' && id !== 'mem_11'))
  })
})
