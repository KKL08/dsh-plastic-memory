import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PendingDecisionsStore, baselineBasisOf, baselineFingerprint, conflictFingerprint, dedupKey, isBaselineCurrent, isBasisCurrent, suggestionBasis } from '../src/governance/decisions.ts'
import { adviceIgnoreSchema, memorySnapshotSchema, pendingDecisionSchema, scanCacheSchema, verdictLoser, type PendingDecision, type StoredSuggestion } from '../src/governance/schema.ts'
import { editFingerprint } from '../src/governance/snapshots.ts'
import type { MemoryRecord } from '../src/record-schema.ts'
import type { CasKvTable, ClaimKvTable, KvTable } from '../src/kv-table.ts'
import { RETENTION_MS } from '../src/retention.ts'
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

describe('处理建议存在账本条目上', () => {
  const a = record({ id: 'mem_a', content: '用 pnpm' })
  const b = record({ id: 'mem_b', content: '用 npm' })
  const read = (rs: MemoryRecord[]) => async (id: string) => rs.find(r => r.id === id)

  async function seeded() {
    const s = makeStore()
    const { entry } = await s.upsert({ memoryIds: ['mem_a', 'mem_b'], summary: '包管理器', fingerprint: 'fp' }, 1)
    return { s, entry }
  }

  function suggestionOf(entry: PendingDecision, rs: MemoryRecord[], id = 'sg_1'): StoredSuggestion {
    return {
      id, action: 'keep-a', reason: '以 A 为准', ops: [{ kind: 'keep', memoryId: 'mem_a' }, { kind: 'forget', memoryId: 'mem_b' }],
      basis: suggestionBasis(entry, rs), isSourced: false, generatedAt: 5,
    }
  }

  it('旧条目没有新字段照常解析；带建议、失败、尝试次数的条目原样往返', () => {
    const old = { id: 'pd_1', memoryIds: ['mem_a', 'mem_b'], summary: 's', firstSeenAt: 1, fingerprint: 'fp' }
    expect(pendingDecisionSchema.parse(old)).toEqual(old)
    const full = {
      ...old,
      suggestion: {
        id: 'sg_1', action: 'merge', reason: 'r',
        ops: [{ kind: 'edit', memoryId: 'mem_a', content: 'c', name: 'n', summary: 's', tags: ['t'] }, { kind: 'forget', memoryId: 'mem_b' }],
        basis: { conflictFingerprint: 'fp', memories: [{ memoryId: 'mem_a', fingerprint: 'x', scopeKey: 'global' }, { memoryId: 'mem_b', fingerprint: 'y', scopeKey: '/w/app' }] },
        isSourced: false, generatedAt: 2,
      },
      suggestionFailure: { basis: { memories: [] }, cause: { kind: 'model-error', hostCode: 'AUTH' }, at: 3 },
      suggestionAttempts: { fingerprint: 'fp', count: 1 },
    }
    expect(pendingDecisionSchema.parse(full)).toEqual(full)
  })

  it('依据版本：冲突指纹或任一条的完整内容指纹（含摘要、标签）变了就不算数', async () => {
    const { entry } = await seeded()
    const basis = suggestionBasis(entry, [a, b])
    expect(isBasisCurrent(entry, basis, [a, b])).toBe(true)
    expect(isBasisCurrent({ ...entry, fingerprint: 'fp2' }, basis, [a, b])).toBe(false)
    expect(isBasisCurrent(entry, basis, [a, { ...b, summary: '改了摘要' }])).toBe(false)
    expect(isBasisCurrent(entry, basis, [a, { ...b, tags: ['新标签'] }])).toBe(false)
    expect(isBasisCurrent(entry, basis, [a, undefined])).toBe(false)
  })

  it('依据版本带每条的作用域：内容没变、一条被提升为全局或移到别的项目，也不算数', async () => {
    const { entry } = await seeded()
    const inProject = { ...b, scope: 'workspace' as const, workspacePath: '/w/app' }
    const basis = suggestionBasis(entry, [a, inProject])
    expect(isBasisCurrent(entry, basis, [a, inProject])).toBe(true)
    expect(isBasisCurrent(entry, basis, [a, { ...inProject, scope: 'global', workspacePath: undefined }])).toBe(false)
    expect(isBasisCurrent(entry, basis, [a, { ...inProject, workspacePath: '/w/other' }])).toBe(false)
    // 加作用域键之前写下的依据：照常解析，一律算对不上
    const legacy = { ...basis, memories: basis.memories.map(({ scopeKey: _scopeKey, ...m }) => m) }
    expect(pendingDecisionSchema.parse({ ...entry, suggestionFailure: { basis: legacy, cause: { kind: 'unparseable' }, at: 1 } }).suggestionFailure?.basis).toEqual(legacy)
    expect(isBasisCurrent(entry, legacy, [a, inProject])).toBe(false)
  })

  it('垂直冲突的依据另记指令文件所属和基线指纹：所属按记忆自己的作用域记（只作说明），核对只看指纹；视图侧的核对只看记忆那一半', async () => {
    const s = makeStore()
    const memory = record({ id: 'mem_v', content: '用 npm', scope: 'workspace', workspacePath: '/w/app' })
    const { entry } = await s.upsert({ memoryIds: ['mem_v'], baselineRef: 'AGENTS.md', summary: '包管理器', fingerprint: 'fp' }, 1)
    const baseline = ['用 pnpm']
    const sided = baselineBasisOf(memory, baseline, entry.fingerprint)
    expect(sided).toEqual({ workspace: '/w/app', fingerprint: baselineFingerprint(baseline) })
    // 缺基线：这条记忆对应的指令文件取不到或不存在
    expect(baselineBasisOf(memory, null, entry.fingerprint)).toBeUndefined()
    // 全局记忆对全局层：所属记 global
    const global = record({ id: 'mem_g' })
    expect(baselineBasisOf(global, baseline, conflictFingerprint([global], baseline))).toEqual({ workspace: 'global', fingerprint: baselineFingerprint(baseline) })

    const basis = suggestionBasis(entry, [memory], sided)
    expect(basis.baseline).toEqual(sided)
    expect(pendingDecisionSchema.parse({ ...entry, suggestionFailure: { basis, cause: { kind: 'no-baseline' }, at: 1 } }).suggestionFailure?.basis).toEqual(basis)
    // 视图侧只核对记忆那一半
    expect(isBasisCurrent(entry, basis, [memory])).toBe(true)
    // 采纳时按这条记忆此刻对应的指令文件核对：内容对得上才算数
    expect(isBaselineCurrent(basis, baseline)).toBe(true)
    expect(isBaselineCurrent(basis, ['用 pnpm，脚本仓用 npm'])).toBe(false)
    expect(isBaselineCurrent(basis, null)).toBe(false)
    expect(isBaselineCurrent(suggestionBasis(entry, [memory]), baseline)).toBe(false)
    // 升级前按会话所在项目记下的所属不影响核对：指纹一致就算数
    expect(isBaselineCurrent({ ...basis, baseline: { workspace: '/w/other', fingerprint: baselineFingerprint(baseline) } }, baseline)).toBe(true)
  })

  it('全局记忆的条目不是对着全局层扫出来的（升级前按某个项目的指令文件扫出、还没清理）：按缺基线算；项目记忆不比条目指纹', () => {
    const global = record({ id: 'mem_g', content: '注释用中文' })
    const globalLayer = ['全局：注释用英文']
    const projectText = ['全局：注释用英文\n项目：用 pnpm']
    expect(baselineBasisOf(global, globalLayer, conflictFingerprint([global], projectText))).toBeUndefined()
    expect(baselineBasisOf(global, globalLayer, undefined)).toBeUndefined()
    expect(baselineBasisOf(global, globalLayer, conflictFingerprint([global], globalLayer))).toEqual({ workspace: 'global', fingerprint: baselineFingerprint(globalLayer) })
    const project = record({ id: 'mem_p', scope: 'workspace', workspacePath: '/w/app' })
    expect(baselineBasisOf(project, projectText, undefined)).toEqual({ workspace: '/w/app', fingerprint: baselineFingerprint(projectText) })
  })

  it('写入：认领后重读核对，写上建议并清掉之前的失败', async () => {
    const { s, entry } = await seeded()
    const failure = { basis: suggestionBasis(entry, [a, b]), cause: { kind: 'unparseable' as const }, at: 2 }
    expect(await s.writeSuggestion(entry.id, { failure }, read([a, b]))).toBe('written')
    expect((await s.get(entry.id))?.suggestionFailure).toEqual(failure)
    expect(await s.writeSuggestion(entry.id, { suggestion: suggestionOf(entry, [a, b]) }, read([a, b]))).toBe('written')
    const saved = await s.get(entry.id)
    expect(saved?.suggestion?.id).toBe('sg_1')
    expect(saved).not.toHaveProperty('suggestionFailure')
  })

  it('已有当前依据的建议时不覆盖，失败也不记', async () => {
    const { s, entry } = await seeded()
    await s.writeSuggestion(entry.id, { suggestion: suggestionOf(entry, [a, b], 'sg_1') }, read([a, b]))
    expect(await s.writeSuggestion(entry.id, { suggestion: suggestionOf(entry, [a, b], 'sg_2') }, read([a, b]))).toBe('has-current')
    const failure = { basis: suggestionBasis(entry, [a, b]), cause: { kind: 'unparseable' as const }, at: 2 }
    expect(await s.writeSuggestion(entry.id, { failure }, read([a, b]))).toBe('has-current')
    const saved = await s.get(entry.id)
    expect(saved?.suggestion?.id).toBe('sg_1')
    expect(saved).not.toHaveProperty('suggestionFailure')
  })

  it('旧依据的建议可以被新依据的覆盖', async () => {
    const { s, entry } = await seeded()
    await s.writeSuggestion(entry.id, { suggestion: suggestionOf(entry, [a, b], 'sg_1') }, read([a, b]))
    const b2 = { ...b, content: '用 npm，CI 里也是' }
    expect(await s.writeSuggestion(entry.id, { suggestion: suggestionOf(entry, [a, b2], 'sg_2') }, read([a, b2]))).toBe('written')
    expect((await s.get(entry.id))?.suggestion?.id).toBe('sg_2')
  })

  it('生成期间记忆被改过、或一方不在用了：依据对不上，不写', async () => {
    const { s, entry } = await seeded()
    const suggestion = suggestionOf(entry, [a, b])
    expect(await s.writeSuggestion(entry.id, { suggestion }, read([a, { ...b, content: '改过' }]))).toBe('stale')
    expect(await s.writeSuggestion(entry.id, { suggestion }, read([a, { ...b, status: 'deleted' }]))).toBe('stale')
    expect((await s.get(entry.id))?.suggestion).toBeUndefined()
  })

  it('体检发起的生成记一次尝试（按冲突指纹计，指纹变了从头算）；不计尝试的写入（用户点「补上建议」）不动次数', async () => {
    const { s, entry } = await seeded()
    const failure = { basis: suggestionBasis(entry, [a, b]), cause: { kind: 'unparseable' as const }, at: 2 }
    expect(await s.writeSuggestion(entry.id, { failure }, read([a, b]), { isAttempt: true })).toBe('written')
    expect((await s.get(entry.id))?.suggestionAttempts).toEqual({ fingerprint: 'fp', count: 1 })
    expect(await s.writeSuggestion(entry.id, { failure }, read([a, b]))).toBe('written')
    expect((await s.get(entry.id))?.suggestionAttempts).toEqual({ fingerprint: 'fp', count: 1 })
    expect(await s.writeSuggestion(entry.id, { suggestion: suggestionOf(entry, [a, b]) }, read([a, b]), { isAttempt: true })).toBe('written')
    expect((await s.get(entry.id))?.suggestionAttempts).toEqual({ fingerprint: 'fp', count: 2 })
    // 同一对再被扫到、双方内容变了：条目换了冲突指纹，次数从头算
    const b2 = { ...b, content: '用 npm，CI 里也是' }
    const { entry: changed } = await s.upsert({ memoryIds: ['mem_a', 'mem_b'], summary: '包管理器', fingerprint: 'fp2' }, 3)
    const again = { basis: suggestionBasis(changed, [a, b2]), cause: { kind: 'unparseable' as const }, at: 4 }
    expect(await s.writeSuggestion(entry.id, { failure: again }, read([a, b2]), { isAttempt: true })).toBe('written')
    expect((await s.get(entry.id))?.suggestionAttempts).toEqual({ fingerprint: 'fp2', count: 1 })
  })

  it('没写成的（依据对不上、已有当前建议）不记尝试', async () => {
    const { s, entry } = await seeded()
    const suggestion = suggestionOf(entry, [a, b])
    expect(await s.writeSuggestion(entry.id, { suggestion }, read([a, { ...b, content: '改过' }]), { isAttempt: true })).toBe('stale')
    expect(await s.writeSuggestion(entry.id, { suggestion }, read([a, b]))).toBe('written')
    expect(await s.writeSuggestion(entry.id, { suggestion: suggestionOf(entry, [a, b], 'sg_2') }, read([a, b]), { isAttempt: true })).toBe('has-current')
    expect((await s.get(entry.id))?.suggestionAttempts).toBeUndefined()
  })

  it('条目已结清或不在了：不写；正被别处认领：丢掉这一份', async () => {
    const { s, entry } = await seeded()
    const suggestion = suggestionOf(entry, [a, b])
    expect(await s.writeSuggestion('pd_none', { suggestion }, read([a, b]))).toBe('gone')
    const held = await s.withClaim(entry.id, () => s.writeSuggestion(entry.id, { suggestion }, read([a, b])))
    expect(held).toEqual({ isClaimed: true, value: 'claimed' })
    await s.settle(entry.id, 'keep-both', 3)
    expect(await s.writeSuggestion(entry.id, { suggestion }, read([a, b]))).toBe('gone')
  })

  it('核对完、写入前，一条被删且条目被清掉：写入把条目写了回来，写后重读发现一方已不在用，撤回这一条、回 gone', async () => {
    const table = new InMemoryKvTable<PendingDecision>()
    const records = [a, b]
    let isArmed = false
    let s!: PendingDecisionsStore
    // 删除路径的次序：先删记忆，再清条目（removeByMemoryIds 不认领条目）
    const wrapped: ClaimKvTable<PendingDecision> & Pick<CasKvTable<PendingDecision>, 'deleteIf'> = {
      get: key => table.get(key),
      list: () => table.list(),
      delete: key => table.delete(key),
      deleteIf: (key, isStill) => table.deleteIf(key, isStill),
      claim: key => table.claim(key),
      put: async (key, value) => {
        if (isArmed) {
          isArmed = false
          records[1] = { ...b, status: 'deleted' }
          expect(await s.removeByMemoryIds(['mem_b'])).toBe(1)
          expect(await table.get(key)).toBeUndefined()
        }
        return table.put(key, value)
      },
    }
    s = new PendingDecisionsStore(wrapped)
    const { entry } = await s.upsert({ memoryIds: ['mem_a', 'mem_b'], summary: '包管理器', fingerprint: 'fp' }, 1)
    isArmed = true
    expect(await s.writeSuggestion(entry.id, { suggestion: suggestionOf(entry, [a, b]) }, read(records))).toBe('gone')
    expect(await table.list()).toEqual([])
  })
})

describe('应用处理方案（plan-applied）', () => {
  const kept = record({ id: 'mem_a', content: '前端用 pnpm，脚本仓用 npm' })
  const dropped = record({ id: 'mem_b', content: '用 npm', status: 'deleted', deletedAt: 5 })
  const writes = [{ memoryId: 'mem_a', op: 'edit' as const, written: kept }, { memoryId: 'mem_b', op: 'forget' as const, written: dropped }]
  const proposal = { source: 'suggestion' as const, action: 'merge' as const }

  async function merged() {
    const table = new InMemoryKvTable<PendingDecision>()
    const s = new PendingDecisionsStore(table)
    const { entry } = await s.upsert({ memoryIds: ['mem_a', 'mem_b'], summary: '包管理器', fingerprint: 'fp-before' }, 1)
    const suggestion: StoredSuggestion = {
      id: 'sg_1', action: 'merge', reason: 'r', ops: [{ kind: 'edit', memoryId: 'mem_a', content: kept.content, name: kept.name, summary: kept.summary, tags: [] }, { kind: 'forget', memoryId: 'mem_b' }],
      basis: { conflictFingerprint: 'fp-before', memories: [] }, isSourced: false, generatedAt: 1,
    }
    // 这里只验账本的记法：建议直接放到条目上
    await table.put(entry.id, { ...entry, suggestion })
    expect(await s.settlePlan(entry.id, { writes, proposal, snapshotId: 'snap_1', fingerprint: 'fp-after' }, 10)).toBe(true)
    return { s, entry, suggestion }
  }

  it('结清信息里记改前快照、逐项回执、依据和结论代码、改前指纹；条目指纹换成改后的；败方是回执里删除的那条', async () => {
    const { s, entry, suggestion } = await merged()
    const [saved] = await s.listSettled()
    expect(saved).toMatchObject({ id: entry.id, fingerprint: 'fp-after', suggestion })
    expect(saved!.settled).toEqual({
      verdict: 'plan-applied', at: 10, snapshotId: 'snap_1', proposal, priorFingerprint: 'fp-before',
      receipts: [
        { memoryId: 'mem_a', op: 'edit', fingerprint: editFingerprint(kept), expectedStatus: 'active' },
        { memoryId: 'mem_b', op: 'forget', fingerprint: editFingerprint(dropped), expectedStatus: 'deleted' },
      ],
    })
    expect(pendingDecisionSchema.parse(saved)).toEqual(saved)
    expect(verdictLoser(saved!, 'plan-applied')).toBe('mem_b')
    // 没有删除项（垂直改写）：没有败方
    expect(verdictLoser({ ...saved!, settled: { ...saved!.settled!, receipts: saved!.settled!.receipts!.slice(0, 1) } }, 'plan-applied')).toBeUndefined()
    expect(await s.list()).toEqual([])
  })

  it('撤销（unsettle）：条目回到待处理，指纹还原成改前的，结清信息整个去掉，建议原样还在', async () => {
    const { s, entry, suggestion } = await merged()
    expect(await s.unsettle(entry.id)).toBe(true)
    const open = await s.get(entry.id)
    expect(open).toMatchObject({ fingerprint: 'fp-before', suggestion })
    expect(open).not.toHaveProperty('settled')
  })

  it('结清后同一对不被重报：有删除项的，败方不在用时挂账跳过；没有删除项的（垂直改写），按改后指纹再报算已结清', async () => {
    const { s } = await merged()
    const read = async (id: string) => (id === 'mem_a' ? kept : dropped)
    expect((await s.upsert({ memoryIds: ['mem_a', 'mem_b'], summary: '再报', fingerprint: 'fp-after' }, 20, read)).isSkipped).toBe(true)
    expect((await s.listSettled()).map(e => e.settled?.verdict)).toEqual(['plan-applied'])

    const v = makeStore()
    const { entry } = await v.upsert({ memoryIds: ['mem_v'], baselineRef: 'AGENTS.md', summary: '垂直', fingerprint: 'fp-v-before' }, 1)
    await v.settlePlan(entry.id, { writes: [{ memoryId: 'mem_v', op: 'edit', written: record({ id: 'mem_v' }) }], proposal: { source: 'suggestion', action: 'merge' }, snapshotId: 'snap_v', fingerprint: 'fp-v-after' }, 10)
    expect((await v.upsert({ memoryIds: ['mem_v'], baselineRef: 'AGENTS.md 换了措辞', summary: '再报', fingerprint: 'fp-v-after' }, 20)).settled).toBe(true)
  })

  it('没有删除项的垂直改写：下次体检按另一个指纹重报（基线又改了）时不删已结清条目，另挂一条未决的；撤销留到保留窗口结束，撤销后多出的那条收拢掉', async () => {
    const v = makeStore()
    const { entry } = await v.upsert({ memoryIds: ['mem_v'], baselineRef: 'AGENTS.md', summary: '垂直', fingerprint: 'fp-v-before' }, 1)
    await v.settlePlan(entry.id, { writes: [{ memoryId: 'mem_v', op: 'edit', written: record({ id: 'mem_v' }) }], proposal: { source: 'suggestion', action: 'rewrite' }, snapshotId: 'snap_v', fingerprint: 'fp-v-after' }, 10)
    const reported = await v.upsert({ memoryIds: ['mem_v'], baselineRef: 'AGENTS.md', summary: '基线又改了', fingerprint: 'fp-v-new' }, 20)
    expect(reported.created).toBe(true)
    expect(reported.entry.id).not.toBe(entry.id)
    // 已结清的改写还在，撤销回执跟着在
    const [settled] = await v.listSettled()
    expect(settled).toMatchObject({ id: entry.id, settled: { verdict: 'plan-applied', snapshotId: 'snap_v' } })
    expect((await v.list()).map(e => e.id)).toEqual([reported.entry.id])
    // 再报一次同一个新指纹：沿用那条未决的，不再多建
    expect((await v.upsert({ memoryIds: ['mem_v'], baselineRef: 'AGENTS.md', summary: '又一次', fingerprint: 'fp-v-new' }, 30)).entry.id).toBe(reported.entry.id)
    // 撤销：改写那条回到待处理（指纹还原），按改写后内容另挂的那条收拢掉
    expect(await v.unsettle(entry.id)).toBe(true)
    expect((await v.list()).map(e => [e.id, e.fingerprint])).toEqual([[entry.id, 'fp-v-before']])
    // 保留窗口过了照常清掉
    const w = makeStore()
    const { entry: e2 } = await w.upsert({ memoryIds: ['mem_v'], baselineRef: 'AGENTS.md', summary: '垂直', fingerprint: 'fp-v-before' }, 1)
    await w.settlePlan(e2.id, { writes: [{ memoryId: 'mem_v', op: 'edit', written: record({ id: 'mem_v' }) }], proposal: { source: 'suggestion', action: 'rewrite' }, snapshotId: 'snap_v', fingerprint: 'fp-v-after' }, 10)
    await w.upsert({ memoryIds: ['mem_v'], baselineRef: 'AGENTS.md', summary: '基线又改了', fingerprint: 'fp-v-new' }, 20)
    await w.sweep(10 + RETENTION_MS + 1)
    expect(await w.listSettled()).toEqual([])
    expect(await w.list()).toHaveLength(1)
  })

  it('保留窗口过了：账本清理把它清掉（含没有删除项的垂直改写）', async () => {
    const { s } = await merged()
    const v = makeStore()
    const { entry } = await v.upsert({ memoryIds: ['mem_v'], baselineRef: 'AGENTS.md', summary: '垂直', fingerprint: 'fp-v' }, 1)
    await v.settlePlan(entry.id, { writes: [{ memoryId: 'mem_v', op: 'edit', written: record({ id: 'mem_v' }) }], proposal, snapshotId: 'snap_v', fingerprint: 'fp-v2' }, 10)
    for (const store of [s, v]) {
      await store.sweep(10 + RETENTION_MS - 1)
      expect(await store.listSettled()).toHaveLength(1)
      await store.sweep(10 + RETENTION_MS + 1)
      expect(await store.listSettled()).toEqual([])
    }
  })

  it('彻底删除前清依赖条目：快照 id 在结清信息里，找得到它', async () => {
    const { s } = await merged()
    await s.dropDependingOn(new Set(['snap_1']), 'mem_b')
    expect(await s.listSettled()).toEqual([])
  })

  it('条目不在、已结清：不记，返回 false', async () => {
    const { s, entry } = await merged()
    expect(await s.settlePlan(entry.id, { writes, proposal, snapshotId: 'snap_2', fingerprint: 'x' }, 11)).toBe(false)
    expect(await s.settlePlan('pd_none', { writes, proposal, snapshotId: 'snap_2', fingerprint: 'x' }, 11)).toBe(false)
    expect((await s.listSettled())[0]!.settled?.snapshotId).toBe('snap_1')
  })
})

describe('账本清理与条目重开交错', () => {
  it('清理读到过期的已裁决条目后，条目被重开：不删重开的条目', async () => {
    const table = new InMemoryKvTable<PendingDecision>()
    let reopen: (() => Promise<void>) | undefined
    const wrapped: ClaimKvTable<PendingDecision> & Pick<CasKvTable<PendingDecision>, 'deleteIf'> = {
      get: key => table.get(key),
      put: (key, value) => table.put(key, value),
      delete: key => table.delete(key),
      deleteIf: (key, isStill) => table.deleteIf(key, isStill),
      claim: key => table.claim(key),
      list: async () => {
        const snapshot = await table.list()
        const run = reopen
        reopen = undefined
        await run?.()
        return snapshot
      },
    }
    const s = new PendingDecisionsStore(wrapped)
    const { entry } = await s.upsert({ memoryIds: ['mem_a', 'mem_b'], summary: '包管理器', fingerprint: 'fp' }, 1)
    await s.settle(entry.id, 'keep-left', 2, { snapshotId: 'snap_1' })
    // 同一对再被扫到（败方回来了）：条目回到待处理
    reopen = async () => { expect(await s.unsettle(entry.id)).toBe(true) }
    await s.sweep(2 + RETENTION_MS + 1)
    expect(await s.get(entry.id)).toMatchObject({ id: entry.id, memoryIds: ['mem_a', 'mem_b'] })
  })
})
