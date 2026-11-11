import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PendingDecisionsStore, dedupKey } from '../src/governance/decisions.ts'
import { adviceIgnoreSchema, memorySnapshotSchema, pendingDecisionSchema, scanCacheSchema, type PendingDecision } from '../src/governance/schema.ts'
import type { KvTable } from '../src/kv-table.ts'
import { SidecarStore } from '../src/storage/sidecar.ts'
import { InMemoryKvTable } from './helpers/in-memory-kv.ts'
import { record } from './helpers/record.ts'

function makeStore() {
  return new PendingDecisionsStore(new InMemoryKvTable<PendingDecision>())
}

/**
 * 让 table 的第一次 list 读完后停住，等 open() 再返回：模拟一次挂账在「list 之后、put 之前」被另一次挂账插进来。
 * listed 在第一次 list 读完时兑现。之后的 list 照常返回。
 */
function pauseFirstList<T>(table: KvTable<T>) {
  const list = table.list.bind(table)
  let open!: () => void
  const gate = new Promise<void>(resolve => { open = resolve })
  let onListed!: () => void
  const listed = new Promise<void>(resolve => { onListed = resolve })
  let isPaused = false
  table.list = async () => {
    const rows = await list()
    if (!isPaused) {
      isPaused = true
      onListed()
      await gate
    }
    return rows
  }
  return { listed, open }
}

/** 同一对冲突的三种报法：横向、垂直（每次措辞不同）、提升候选。 */
const SAME_PAIR_INPUTS = [
  { label: '横向冲突', first: { memoryIds: ['mem_a', 'mem_b'], summary: '一', fingerprint: 'fp' }, second: { memoryIds: ['mem_b', 'mem_a'], summary: '二', fingerprint: 'fp' } },
  {
    label: '垂直冲突（baselineRef 措辞不同）',
    first: { memoryIds: ['mem_v'], baselineRef: 'AGENTS.md：用 pnpm', summary: '一', fingerprint: 'fp' },
    second: { memoryIds: ['mem_v'], baselineRef: 'AGENTS.md 里「统一用 pnpm」', summary: '二', fingerprint: 'fp' },
  },
  {
    label: '提升候选',
    first: { kind: 'promote-candidate' as const, memoryIds: ['mem_c'], summary: '一', workspaces: ['/w/app'], fingerprint: 'fp' },
    second: { kind: 'promote-candidate' as const, memoryIds: ['mem_c'], summary: '二', workspaces: ['/w/app'], fingerprint: 'fp' },
  },
]

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
    expect(await s.list()).toHaveLength(1)
  })

  it('垂直冲突（带 baselineRef）与横向冲突不互相去重', async () => {
    const s = makeStore()
    await s.upsert({ memoryIds: ['mem_a', 'mem_b'], baselineRef: 'AGENTS.md：X', summary: 'v' }, 1)
    await s.upsert({ memoryIds: ['mem_a', 'mem_b'], summary: 'h' }, 2)
    expect(await s.list()).toHaveLength(2)
  })

  it('未决的垂直冲突再报时 baselineRef 换了措辞：仍是同一条，沿用 id，措辞与 summary 换成最新的', async () => {
    const s = makeStore()
    const r1 = await s.upsert({ memoryIds: ['mem_a'], baselineRef: 'AGENTS.md：包管理用 pnpm', summary: '第一次', fingerprint: 'fp' }, 1)
    const r2 = await s.upsert({ memoryIds: ['mem_a'], baselineRef: 'AGENTS.md 里「统一用 pnpm」那条', summary: '第二次', fingerprint: 'fp' }, 2)
    expect(r2.created).toBe(false)
    expect(r2.entry.id).toBe(r1.entry.id)
    expect(await s.list()).toEqual([{ ...r1.entry, baselineRef: 'AGENTS.md 里「统一用 pnpm」那条', summary: '第二次' }])
  })

  it('removeByMemoryIds 删除引用任一 id 的条目并返回数量', async () => {
    const s = makeStore()
    await s.upsert({ memoryIds: ['mem_a', 'mem_b'], summary: '1' }, 1)
    await s.upsert({ memoryIds: ['mem_c'], baselineRef: 'AGENTS.md：X', summary: '2' }, 2)
    await s.upsert({ memoryIds: ['mem_d', 'mem_e'], summary: '3' }, 3)
    const n = await s.removeByMemoryIds(['mem_b', 'mem_c'])
    expect(n).toBe(2)
    expect((await s.list()).map(e => e.summary)).toEqual(['3'])
  })

  it('list 按 firstSeenAt 升序；remove 幂等', async () => {
    const s = makeStore()
    const { entry } = await s.upsert({ memoryIds: ['mem_x', 'mem_y'], summary: '后' }, 200)
    await s.upsert({ memoryIds: ['mem_p', 'mem_q'], summary: '先' }, 100)
    expect((await s.list()).map(e => e.summary)).toEqual(['先', '后'])
    expect(await s.remove(entry.id)).toBe(true)
    expect(await s.remove(entry.id)).toBe(false)
  })
})

describe('同一对冲突并发挂账', () => {
  for (const { label, first, second } of SAME_PAIR_INPUTS) {
    it(`${label}：一次挂账读完账本、还没写入时另一次挂账同一对，账本里只有一条；后到的这次跳过`, async () => {
      const table = new InMemoryKvTable<PendingDecision>()
      const s = new PendingDecisionsStore(table)
      const paused = pauseFirstList(table)
      const p1 = s.upsert(first, 1)
      await paused.listed
      const r2 = await s.upsert(second, 2)
      paused.open()
      const r1 = await p1

      expect(r1.created).toBe(true)
      expect(r2).toMatchObject({ created: false, isSkipped: true })
      expect(await s.list()).toEqual([r1.entry])
    })
  }

  describe('两个实例共用一个侧表目录（两个宿主进程）', () => {
    let root: string
    beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'pm-decisions-')) })
    afterEach(async () => { await rm(root, { recursive: true, force: true }) })
    const openPending = () => new SidecarStore({
      root, schemas: { snapshots: memorySnapshotSchema, pending: pendingDecisionSchema, scanCache: scanCacheSchema, adviceIgnores: adviceIgnoreSchema },
    }).pending

    for (const { label, first, second } of SAME_PAIR_INPUTS) {
      it(`${label}：A 读完账本、还没写入时 B 挂账同一对，账本里只有一条`, async () => {
        const tableA = openPending()
        const a = new PendingDecisionsStore(tableA)
        const b = new PendingDecisionsStore(openPending())
        const paused = pauseFirstList(tableA)
        const pA = a.upsert(first, 1)
        await paused.listed
        const rB = await b.upsert(second, 2)
        paused.open()
        const rA = await pA

        expect(rA.created).toBe(true)
        expect(rB).toMatchObject({ created: false, isSkipped: true })
        expect(await new PendingDecisionsStore(openPending()).list()).toEqual([rA.entry])
        // 挂完账认领随之释放：再报同一对照常更新那一条
        expect(await b.upsert(second, 3)).toMatchObject({ created: false, entry: { id: rA.entry.id, summary: '二' } })
      })
    }
  })
})

describe('收拢修复前留下的重复条目', () => {
  const pair = (over: Partial<PendingDecision>): PendingDecision => ({ id: 'pd_x', memoryIds: ['mem_a', 'mem_b'], summary: '旧', firstSeenAt: 1, fingerprint: 'fp', ...over })
  const active = async (id: string) => record({ id })

  it('两条未决的同一对：留最早出现的那条并更新它，另一条移除', async () => {
    const table = new InMemoryKvTable<PendingDecision>()
    await table.put('pd_late', pair({ id: 'pd_late', firstSeenAt: 20 }))
    await table.put('pd_early', pair({ id: 'pd_early', firstSeenAt: 10 }))
    const s = new PendingDecisionsStore(table)

    const r = await s.upsert({ memoryIds: ['mem_b', 'mem_a'], summary: '新', fingerprint: 'fp' }, 30, active)

    expect(r).toMatchObject({ created: false, entry: { id: 'pd_early', summary: '新', firstSeenAt: 10 } })
    expect((await table.list()).map(([key]) => key)).toEqual(['pd_early'])
  })

  it('两边都留的结论仍成立（指纹没变）且另有一条未决的同一对：返回结论，未决的那条移除，结论留着', async () => {
    const table = new InMemoryKvTable<PendingDecision>()
    await table.put('pd_kept', pair({ id: 'pd_kept', settled: { verdict: 'keep-both', at: 5 } }))
    await table.put('pd_open', pair({ id: 'pd_open', firstSeenAt: 6 }))
    const s = new PendingDecisionsStore(table)

    const r = await s.upsert({ memoryIds: ['mem_a', 'mem_b'], summary: '新', fingerprint: 'fp' }, 30, active)

    expect(r).toMatchObject({ created: false, settled: true, entry: { id: 'pd_kept' } })
    expect(await s.list()).toEqual([])
    expect((await s.listSettled()).map(e => e.id)).toEqual(['pd_kept'])
  })

  it('删一方的裁决（留作撤销）与一条未决的同一对并存、败方此刻不在：跳过，两条都不动', async () => {
    const table = new InMemoryKvTable<PendingDecision>()
    const undo = pair({ id: 'pd_undo', settled: { verdict: 'keep-left', at: 5, snapshotId: 'snap_1' } })
    const open = pair({ id: 'pd_open', firstSeenAt: 6 })
    await table.put(undo.id, undo)
    await table.put(open.id, open)
    const s = new PendingDecisionsStore(table)
    const read = async (id: string) => record({ id, status: id === 'mem_b' ? 'deleted' : 'active' })

    const r = await s.upsert({ memoryIds: ['mem_a', 'mem_b'], summary: '新', fingerprint: 'fp' }, 30, read)

    expect(r.isSkipped).toBe(true)
    expect(Object.fromEntries(await table.list())).toEqual({ pd_undo: undo, pd_open: open })
  })

  it('删一方的裁决与一条未决的同一对并存、败方回来了：裁决那条回到待处理，另一条未决的移除', async () => {
    const table = new InMemoryKvTable<PendingDecision>()
    await table.put('pd_undo', pair({ id: 'pd_undo', settled: { verdict: 'keep-left', at: 5, snapshotId: 'snap_1' } }))
    await table.put('pd_open', pair({ id: 'pd_open', firstSeenAt: 6 }))
    const s = new PendingDecisionsStore(table)

    const r = await s.upsert({ memoryIds: ['mem_a', 'mem_b'], summary: '新', fingerprint: 'fp' }, 30, active)

    expect(r).toMatchObject({ created: false, entry: { id: 'pd_undo', summary: '新' } })
    expect((await s.list()).map(e => e.id)).toEqual(['pd_undo'])
    expect(await s.listSettled()).toEqual([])
  })

  it('多出来的那条正被裁决认领着：不动它，只更新留下的那条', async () => {
    const table = new InMemoryKvTable<PendingDecision>()
    await table.put('pd_early', pair({ id: 'pd_early', firstSeenAt: 10 }))
    await table.put('pd_late', pair({ id: 'pd_late', firstSeenAt: 20 }))
    const s = new PendingDecisionsStore(table)

    const claimed = await s.withClaim('pd_late', () => s.upsert({ memoryIds: ['mem_a', 'mem_b'], summary: '新', fingerprint: 'fp' }, 30, active))

    expect(claimed).toMatchObject({ isClaimed: true, value: { created: false, entry: { id: 'pd_early', summary: '新' } } })
    expect((await s.list()).map(e => e.id)).toEqual(['pd_early', 'pd_late'])
  })
})

describe('syncOverflow 与「忽略」交错', () => {
  it('读完账本之后、写回说明之前用户点了忽略：只改说明，忽略保留', async () => {
    const table = new InMemoryKvTable<PendingDecision>()
    const s = new PendingDecisionsStore(table)
    const level = { mode: 'relax', tier: 1 } as const
    await s.syncOverflow('/w/app', level, 1, '用量 4100')
    const [entry] = await s.listOverflow()
    // 同步读完账本之后，另一个标签页忽略了这条提醒
    const list = table.list.bind(table)
    let isRaced = false
    table.list = async () => {
      const rows = await list()
      if (!isRaced) {
        isRaced = true
        await new PendingDecisionsStore(table).settle(entry!.id, 'dismiss', 2)
      }
      return rows
    }
    expect(await s.syncOverflow('/w/app', level, 3, '用量 4200')).toBe(true)
    const [after] = await s.listOverflow()
    expect(after).toMatchObject({ id: entry!.id, summary: '用量 4200', settled: { verdict: 'dismiss', at: 2 } })
  })
})

describe('dropDependingOn（彻底删除前清依赖条目）', () => {
  it('指向被抹快照、涉及这条记忆的条目清掉；同一份快照只涉及别的记忆的、指向别的快照的、未决的都留着', async () => {
    const s = makeStore()
    const verdict = await s.addSettled({ kind: 'conflict', memoryIds: ['mem_a', 'mem_b'], summary: '裁决', workspaces: ['global', 'global'], fingerprint: 'fp' }, 'keep-left', 1, { snapshotId: 'snap_lost' })
    const merge = await s.addSettled({ kind: 'edit', memoryIds: ['mem_c', 'mem_b'], summary: '合并', workspaces: ['global', 'global'], fingerprint: 'fp' }, 'merged', 1, { snapshotId: 'snap_other' })
    const sameSnapshot = await s.addSettled({ kind: 'edit', memoryIds: ['mem_c'], summary: '同快照别的记忆', workspaces: ['global'], fingerprint: 'fp' }, 'edited', 1, { snapshotId: 'snap_lost' })
    const open = (await s.upsert({ memoryIds: ['mem_b', 'mem_d'], summary: '未决' }, 1)).entry

    await s.dropDependingOn(new Set(['snap_lost']), 'mem_b')

    const left = [...await s.list(), ...await s.listSettled()].map(e => e.id).sort()
    expect(left).toEqual([merge.id, sameSnapshot.id, open.id].sort())
    expect(left).not.toContain(verdict.id)
  })
})
