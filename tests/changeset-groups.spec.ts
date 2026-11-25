import { describe, expect, it } from 'vitest'
import { MemoryStore } from '../src/store.ts'
import { SnapshotStore } from '../src/governance/snapshots.ts'
import { PendingDecisionsStore } from '../src/governance/decisions.ts'
import type { MemorySnapshot, PendingDecision } from '../src/governance/schema.ts'
import { basisOf, scopeKeyOf, type ChangeOp } from '../src/governance/changeset.ts'
import { mergePlan, splitPlan, versionPlan } from '../src/governance/changeset-plans.ts'
import { DREAMS_INITIATOR, writeGate } from '../src/governance/write-gate.ts'
import { applyChangeset, receiptsOfEntry, settleOpenGroups, type ChangesetDeps } from '../src/tools/changeset.ts'
import { executeUndo } from '../src/tools/undo.ts'
import { historyWithMerged } from '../src/merged-history.ts'
import { mergedIntoOf, type MemoryRecord } from '../src/record-schema.ts'
import { RETENTION_MS } from '../src/retention.ts'
import { STATE_CHANGE_VERSION, layerOf } from '../src/storage/history.ts'
import { record } from './helpers/record.ts'
import { InMemoryTable } from './helpers/in-memory-table.ts'
import { InMemoryKvTable, InMemoryBatchKvTable } from './helpers/in-memory-kv.ts'

// 成组的方案（合并、并成版本、拆分）：一组全做成才算成，一步不成就把已做的撤回；中断留下的半个组下次先撤

const T0 = 1_700_000_000_000
const ENTRY = 'pd_run'
const WS = '/proj/a'

function world() {
  const clock = { now: T0 + 5000 }
  const store = new MemoryStore(new InMemoryTable('/in-memory', () => clock.now), undefined, new InMemoryBatchKvTable())
  const snapshots = new SnapshotStore(new InMemoryKvTable<MemorySnapshot>())
  const decisions = new PendingDecisionsStore(new InMemoryKvTable<PendingDecision>())
  const deps: ChangesetDeps = { store, snapshots, decisions }
  return { store, snapshots, decisions, deps, clock }
}
type World = ReturnType<typeof world>

async function seed(w: World, id: string, partial: Partial<MemoryRecord> = {}): Promise<MemoryRecord> {
  const rec = record({ id, name: `记忆 ${id}`, content: `${id} 的正文`, summary: `${id} 的摘要`, tags: ['x'], createdAt: T0, updatedAt: T0, lastConfirmedAt: T0, ...partial })
  await w.store.create(rec)
  return (await w.store.get(rec.id, { workspacePath: rec.workspacePath }))!
}
const at = (r: Pick<MemoryRecord, 'workspacePath'>) => (r.workspacePath === undefined ? { kind: 'global' as const } : { kind: 'workspace' as const, workspacePath: r.workspacePath })
const now = async (w: World, r: Pick<MemoryRecord, 'id' | 'workspacePath'>) => (await w.store.get(r.id, at(r)))!

async function run(w: World, ops: ChangeOp[], extra: { by?: string; entryId?: string; isAllOrNothing?: boolean; isSecretChecked?: boolean } = {}) {
  const entryId = extra.entryId ?? ENTRY
  await w.decisions.addChangeRun(entryId, { kind: 'edit', summary: '测试', workspaces: ['global'], memoryIds: [] }, 'batch-edited', T0 + 1)
  return applyChangeset(ops, { entryId, by: extra.by ?? 'gui', at: T0 + 1000, isSecretChecked: extra.isSecretChecked ?? false, ...(extra.isAllOrNothing === true ? { isAllOrNothing: true } : {}) }, w.deps)
}

/** 整条撤销。时钟给固定的：改前快照是按测试里的时刻拍的，按真实时间算早过期了。 */
const undo = (w: World) => executeUndo({ decisionId: ENTRY }, { workspacePath: undefined }, { ...w.deps, ignores: { unignoreIfSame: async () => false }, now: () => T0 + 2000 })

const fused = { name: '合起来的', summary: '合起来的摘要', content: '合起来的正文', tags: ['x'] }
/** 召回统计、提交标记之外的内容。 */
const stable = ({ lastWriteOp: _op, recallCount: _c, lastRecalledAt: _a, ...rest }: MemoryRecord) => rest
const openGroups = async (w: World, entryId = ENTRY) => (await w.decisions.withOpenGroups()).find(e => e.id === entryId)?.openGroups ?? []

describe('写入许可', () => {
  it('只有一条规则：记忆梦境不改锁定的记忆；锁的取值、到期照现有的判法', () => {
    const cases: Array<[string, Pick<MemoryRecord, 'locked' | 'lockedUntil'>, 'locked' | undefined]> = [
      [DREAMS_INITIATOR, {}, undefined],
      [DREAMS_INITIATOR, { locked: false }, undefined],
      [DREAMS_INITIATOR, { locked: true }, 'locked'],
      [DREAMS_INITIATOR, { locked: 'strict' }, 'locked'],
      [DREAMS_INITIATOR, { locked: true, lockedUntil: T0 - 1 }, undefined],
      [DREAMS_INITIATOR, { locked: true, lockedUntil: T0 + 1 }, 'locked'],
      [DREAMS_INITIATOR, { locked: true, lockedUntil: '写坏了' }, 'locked'],
      [DREAMS_INITIATOR, { locked: false, lockedUntil: T0 + 1 }, undefined],
      ['gui', { locked: true }, undefined],
      ['checkup', { locked: true }, undefined],
    ]
    for (const [by, rec, expected] of cases) expect(writeGate(by, rec, T0), JSON.stringify([by, rec])).toBe(expected)
  })
})

describe('方案的展开', () => {
  const a = record({ id: 'mem_a' })
  const b = record({ id: 'mem_b' })
  it('合并：存活方一条改写，被合并方各一条带去向的删除，都在一组里', () => {
    const ops = mergePlan({ group: 'g1', keeper: a, merged: [b], fused })
    expect(ops.map(o => [o.kind, o.memoryId, o.group, o.into?.memoryId ?? null])).toEqual([['edit', 'mem_a', 'g1', null], ['forget', 'mem_b', 'g1', 'mem_a']])
  })
  it('形状不对的方案不展开', () => {
    expect(() => mergePlan({ group: 'g', keeper: a, merged: [], fused })).toThrow()
    expect(() => mergePlan({ group: 'g', keeper: a, merged: [a], fused })).toThrow()
    expect(() => mergePlan({ group: 'g', keeper: a, merged: [b, b], fused })).toThrow()
    expect(() => versionPlan({ id: 'v', current: a, old: a })).toThrow()
    expect(() => splitPlan({ group: 'g', original: a, drafts: [fused], newId: () => 'n' })).toThrow()
  })
})

describe('合并', () => {
  it('存活方改成融合稿，被合并方软删并记下去向；整条撤销后两条都回到原样', async () => {
    const w = world()
    const s = await seed(w, 'mem_s')
    const l = await seed(w, 'mem_l')
    const r = await run(w, mergePlan({ group: 'g1', keeper: s, merged: [l], fused }))
    expect(r.groups).toEqual([{ group: 'g1', state: 'applied' }])
    expect(await now(w, s)).toMatchObject({ content: '合起来的正文', status: 'active' })
    expect(mergedIntoOf(await now(w, l))).toEqual({ id: 'mem_s', scopeKey: 'global', as: 'merge' })
    expect((await receiptsOfEntry(w.decisions, ENTRY)).map(c => [c.kind, c.memoryId, c.group])).toEqual([['edit', 'mem_s', 'g1'], ['forget', 'mem_l', 'g1']])
    expect(await openGroups(w)).toEqual([])

    await w.decisions.finishChangeRun(ENTRY, { writes: [] })
    expect((await undo(w)).kind).toBe('undone')
    expect(stable(await now(w, s))).toEqual(stable(s))
    expect(stable(await now(w, l))).toEqual(stable(l))
  })

  it('融合稿和存活方现在的内容一样：没有可写的那一步算做成，被合并方照删', async () => {
    const w = world()
    const s = await seed(w, 'mem_s', fused)
    const l = await seed(w, 'mem_l')
    const r = await run(w, mergePlan({ group: 'g1', keeper: s, merged: [l], fused }))
    expect(r.groups).toEqual([{ group: 'g1', state: 'applied' }])
    expect((await now(w, l)).status).toBe('deleted')
  })

  it('同一个 id 在全局和项目里各有一份：项目那份并进全局那份，各动各的', async () => {
    const w = world()
    const l = await seed(w, 'mem_same', { scope: 'workspace', workspacePath: WS })
    const s = await seed(w, 'mem_same')
    const r = await run(w, mergePlan({ group: 'g1', keeper: s, merged: [l], fused }))
    expect(r.groups).toEqual([{ group: 'g1', state: 'applied' }])
    expect(await now(w, s)).toMatchObject({ content: '合起来的正文', status: 'active' })
    expect(await now(w, l)).toMatchObject({ status: 'deleted', mergedInto: { id: 'mem_same', scopeKey: 'global', as: 'merge' } })
  })

  it('被合并方里有一条被记忆梦境碰不得（锁着）：第一步之前就查出来，整组什么都不写；界面发起的不受锁管', async () => {
    const w = world()
    const s = await seed(w, 'mem_s')
    const l1 = await seed(w, 'mem_l1')
    const l2 = await seed(w, 'mem_l2', { locked: true })
    const ops = mergePlan({ group: 'g1', keeper: s, merged: [l1, l2], fused })
    const r = await run(w, ops, { by: DREAMS_INITIATOR })
    expect(r.groups).toEqual([{ group: 'g1', state: 'skipped' }])
    expect(r.outcomes.map(o => (o.kind === 'skipped' ? o.reason : o.kind))).toEqual(['group', 'group', 'locked'])
    expect(stable(await now(w, s))).toEqual(stable(s))
    expect(await receiptsOfEntry(w.decisions, ENTRY)).toEqual([])

    expect((await run(w, ops, { entryId: 'pd_gui' })).groups).toEqual([{ group: 'g1', state: 'applied' }])
  })

  it('核对过了之后用户才上的锁：第二步被锁挡下，第一步撤回，后面同一批的操作照常做', async () => {
    const w = world()
    const s = await seed(w, 'mem_s')
    const l = await seed(w, 'mem_l')
    const other = await seed(w, 'mem_o')
    // 组开始的那一刻（第一步之前的核对已经过了）用户给被合并方上锁
    const openGroup = w.decisions.openGroup.bind(w.decisions)
    w.decisions.openGroup = async (id, group) => {
      await w.store.update(l, cur => ({ ...cur, locked: true }))
      return openGroup(id, group)
    }
    const r = await run(w, [
      ...mergePlan({ group: 'g1', keeper: s, merged: [l], fused }),
      { id: 'after', kind: 'edit', memoryId: s.id, scopeKey: scopeKeyOf(s), basis: [basisOf(s)], patch: { summary: '后面的操作改的' }, expect: { summary: s.summary } },
      { id: 'other', kind: 'forget', memoryId: other.id, scopeKey: 'global', basis: [basisOf(other)] },
    ], { by: DREAMS_INITIATOR })
    expect(r.groups).toEqual([{ group: 'g1', state: 'rolled-back' }])
    // 组撤回之后，后面改存活方的操作按组开始之前的样子核对：对得上
    expect(await now(w, s)).toMatchObject({ content: s.content, summary: '后面的操作改的' })
    expect(await now(w, l)).toMatchObject({ status: 'active', locked: true })
    expect((await now(w, other)).status).toBe('deleted')
    expect((await receiptsOfEntry(w.decisions, ENTRY)).map(c => c.id)).toEqual(['after', 'other'])
    expect(await openGroups(w)).toEqual([])
  })

  it('整批退的那一批不另分组：组里一步不成，组外已做的也一起退', async () => {
    const w = world()
    const s = await seed(w, 'mem_s')
    const l = await seed(w, 'mem_l', { content: 'token: sk-abcdefghijklmnopqrstuvwxyz012345' })
    const other = await seed(w, 'mem_o')
    const r = await run(w, [
      { id: 'other', kind: 'forget', memoryId: other.id, scopeKey: 'global', basis: [basisOf(other)] },
      ...mergePlan({ group: 'g1', keeper: s, merged: [l], fused }),
    ], { isAllOrNothing: true })
    expect(r.isRolledBack).toBe(true)
    expect(r.groups).toBeUndefined()
    expect((await now(w, other)).status).toBe('active')
    expect(stable(await now(w, s))).toEqual(stable(s))
  })

  it('同一个组的操作被别的操作隔开：整组不做', async () => {
    const w = world()
    const s = await seed(w, 'mem_s')
    const l = await seed(w, 'mem_l')
    const other = await seed(w, 'mem_o')
    const [edit, forget] = mergePlan({ group: 'g1', keeper: s, merged: [l], fused })
    const r = await run(w, [edit!, { id: 'other', kind: 'keep', memoryId: other.id, scopeKey: 'global', basis: [basisOf(other)] }, forget!])
    expect(r.outcomes.map(o => (o.kind === 'skipped' ? o.reason : o.kind))).toEqual(['unsupported', 'checked', 'unsupported'])
    expect(stable(await now(w, s))).toEqual(stable(s))
  })
})

describe('调用方中途叫停', () => {
  const edit = (r: MemoryRecord, id: string, extra: Partial<ChangeOp> = {}): ChangeOp =>
    ({ id, kind: 'edit', memoryId: r.id, scopeKey: 'global', basis: [basisOf(r)], patch: { content: `${id} 改的` }, expect: { content: r.content }, ...extra })
  async function stoppedRun(w: World, ops: ChangeOp[], stopAfter: number, extra: { isAllOrNothing?: boolean } = {}) {
    await w.decisions.addChangeRun(ENTRY, { kind: 'edit', summary: '测试', workspaces: ['global'], memoryIds: [] }, 'batch-edited', T0 + 1)
    let asked = 0
    return applyChangeset(ops, { entryId: ENTRY, by: 'dreams', at: T0 + 1000, isSecretChecked: true, shouldStop: () => asked++ >= stopAfter, ...extra }, w.deps)
  }

  it('每个操作之前问一次：叫停之后的都不做，各记一条 stopped；已做的留着、有回执', async () => {
    const w = world()
    const [a, b, c] = [await seed(w, 'mem_a'), await seed(w, 'mem_b'), await seed(w, 'mem_c')]
    const r = await stoppedRun(w, [edit(a, 'o1'), edit(b, 'o2'), edit(c, 'o3')], 1)
    expect(r.isStopped).toBe(true)
    expect(r.outcomes.map(o => (o.kind === 'skipped' ? o.reason : o.kind))).toEqual(['applied', 'stopped', 'stopped'])
    expect((await now(w, a)).content).toBe('o1 改的')
    expect((await now(w, b)).content).toBe(b.content)
    expect((await receiptsOfEntry(w.decisions, ENTRY)).map(x => x.id)).toEqual(['o1'])
  })

  it('一组算一个整体：开始了的组做完，叫停只拦在组与组之间', async () => {
    const w = world()
    const [a, b, c] = [await seed(w, 'mem_a'), await seed(w, 'mem_b'), await seed(w, 'mem_c')]
    // 第一次问（组之前）放行，第二次问（第三个操作之前）叫停
    const r = await stoppedRun(w, [edit(a, 'o1', { group: 'g1' }), edit(b, 'o2', { group: 'g1' }), edit(c, 'o3')], 1)
    expect(r.groups).toEqual([{ group: 'g1', state: 'applied' }])
    expect(r.outcomes.map(o => (o.kind === 'skipped' ? o.reason : o.kind))).toEqual(['applied', 'applied', 'stopped'])
    expect(await openGroups(w)).toEqual([])
  })

  it('一开始就叫停：什么都不做；整批退的那一批不看它', async () => {
    const w = world()
    const [a, b] = [await seed(w, 'mem_a'), await seed(w, 'mem_b')]
    const none = await stoppedRun(w, [edit(a, 'o1')], 0)
    expect(none).toMatchObject({ isStopped: true, outcomes: [{ kind: 'skipped', reason: 'stopped' }] })
    const all = await stoppedRun(w, [edit(a, 'o2'), edit(b, 'o3')], 0, { isAllOrNothing: true })
    expect(all.isStopped).toBeUndefined()
    expect(all.outcomes.map(o => o.kind)).toEqual(['applied', 'applied'])
  })
})

describe('中断与收尾', () => {
  /** 做完第一步就断了：组的标记和第一步的回执留在条目上。 */
  async function interrupted(w: World) {
    const s = await seed(w, 'mem_s')
    const l = await seed(w, 'mem_l')
    const [edit] = mergePlan({ group: 'g1', keeper: s, merged: [l], fused })
    const closeGroup = w.decisions.closeGroup.bind(w.decisions)
    w.decisions.closeGroup = async () => {}
    await run(w, [edit!])
    w.decisions.closeGroup = closeGroup
    expect(await openGroups(w)).toEqual(['g1'])
    expect((await now(w, s)).content).toBe('合起来的正文')
    return { s, l }
  }

  it('两步之间断了：下一次应用别的变更集之前先把做了的那一步撤干净，一条回执都没剩的条目移出账本', async () => {
    const w = world()
    const { s } = await interrupted(w)
    const other = await seed(w, 'mem_o')
    await run(w, [{ id: 'o1', kind: 'forget', memoryId: other.id, scopeKey: 'global', basis: [basisOf(other)] }], { entryId: 'pd_next' })
    expect(stable(await now(w, s))).toEqual(stable(s))
    expect(await w.decisions.withOpenGroups()).toEqual([])
    expect((await w.decisions.listSettled()).map(e => e.id)).toEqual(['pd_next'])
  })

  it('半个组所在的条目正被别人占着：不碰它', async () => {
    const w = world()
    await interrupted(w)
    const release = await w.decisions.hold(ENTRY)
    await settleOpenGroups(w.deps, { by: 'gui' })
    expect(await openGroups(w)).toEqual(['g1'])
    await release!()
    await settleOpenGroups(w.deps, { by: 'gui' })
    expect(await openGroups(w)).toEqual([])
  })

  it('用户撤销带着半个组的条目：先撤掉那半个组，再按剩下的回执撤', async () => {
    const w = world()
    const { s } = await interrupted(w)
    expect((await undo(w)).kind).toBe('undone')
    expect(stable(await now(w, s))).toEqual(stable(s))
  })

  it('撤回时写不进去：回执留着、组仍记作没做完，结果里列出；之后收尾时再撤，撤干净', async () => {
    const w = world()
    const s = await seed(w, 'mem_s')
    const l = await seed(w, 'mem_l')
    // 核对过了之后被合并方才上了锁：第二步被挡下，要撤回第一步，这时磁盘又写不进
    const openGroup = w.decisions.openGroup.bind(w.decisions)
    w.decisions.openGroup = async (id, group) => {
      await w.store.update(l, cur => ({ ...cur, locked: true }))
      return openGroup(id, group)
    }
    const put = w.store.put.bind(w.store)
    let isDiskBroken = true
    // 撤回走的是整条写回：只让这一种写入失败
    w.store.put = ((...args: Parameters<typeof put>) => (isDiskBroken && args[0].content === s.content ? Promise.reject(new Error('磁盘写不进')) : put(...args))) as typeof put
    const r = await run(w, mergePlan({ group: 'g1', keeper: s, merged: [l], fused }), { by: DREAMS_INITIATOR })
    expect(r.groups).toEqual([{ group: 'g1', state: 'rolled-back', kept: ['mem_s'] }])
    expect((await now(w, s)).content).toBe('合起来的正文')
    expect(await openGroups(w)).toEqual(['g1'])
    expect((await receiptsOfEntry(w.decisions, ENTRY)).map(c => c.memoryId)).toEqual(['mem_s'])
    isDiskBroken = false
    await settleOpenGroups(w.deps, { by: 'gui' })
    expect(stable(await now(w, s))).toEqual(stable(s))
    expect(await w.decisions.withOpenGroups()).toEqual([])
  })

  it('回执还没补上、组没做完的条目，收尾不把它移出账本', async () => {
    const w = world()
    await w.decisions.addChangeRun(ENTRY, { kind: 'edit', summary: '测试', workspaces: ['global'], memoryIds: [] }, 'batch-edited', T0)
    await w.decisions.openGroup(ENTRY, 'g1')
    expect(await w.decisions.finishChangeRun(ENTRY, { writes: [] })).toMatchObject({ id: ENTRY, openGroups: ['g1'] })
  })
})

describe('并成版本', () => {
  async function versioned(w: World) {
    const current = await seed(w, 'mem_c', { stateSince: T0 + 500, content: '现在用方案 B' })
    const old = await seed(w, 'mem_o', { content: '以前用方案 A', createdAt: T0 - 9000 })
    // 旧状态那条自己还有一版更早的历史
    const located = (await w.store.locate(old.id, at(old)))!
    await w.store.history.write(layerOf(located), { versionId: 'v-early', record: { ...old, content: '更早的方案' }, extras: {}, startedAt: T0 - 20000, endedAt: T0 - 9000, kind: STATE_CHANGE_VERSION, writes: [] })
    const r = await run(w, versionPlan({ id: 'v1', current, old }))
    expect(r.outcomes.map(o => o.kind)).toEqual(['applied'])
    return { current, old }
  }
  const shape = (versions: Awaited<ReturnType<typeof historyWithMerged>>) => versions.map(v => [v.kind, v.mergedFrom ?? null, v.record.content, v.endedAt])

  it('旧状态那条软删并记下去向，当前页不写；读当前页的历史能看到它和它自己的历史，标着并入自它', async () => {
    const w = world()
    const { current, old } = await versioned(w)
    expect(stable(await now(w, current))).toEqual(stable(current))
    expect(mergedIntoOf(await now(w, old))).toEqual({ id: 'mem_c', scopeKey: 'global', as: 'version', endedAt: T0 + 500 })
    const history = await historyWithMerged(w.store, (await w.store.locate(current.id, at(current)))!)
    expect(shape(history)).toEqual([
      [STATE_CHANGE_VERSION, 'mem_o', '更早的方案', T0 - 9000],
      ['merged', 'mem_o', '以前用方案 A', T0 + 500],
    ])
  })

  it('旧状态那条到期清掉之后，历史搬到当前页名下，读出来和清之前一样；再清一遍不多出版本', async () => {
    const w = world()
    const { current, old } = await versioned(w)
    const before = shape(await historyWithMerged(w.store, (await w.store.locate(current.id, at(current)))!))
    w.clock.now = T0 + RETENTION_MS + 60_000
    await w.store.maintain({ kind: 'global' })
    expect(await w.store.get(old.id, at(old))).toBeUndefined()
    const located = (await w.store.locate(current.id, at(current)))!
    expect(shape(await historyWithMerged(w.store, located))).toEqual(before)
    expect(shape(await w.store.history.list(layerOf(located), current.id))).toEqual(before)
    await w.store.maintain({ kind: 'global' })
    expect(shape(await w.store.history.list(layerOf(located), current.id))).toEqual(before)
  })

  it('去向那条已经不在：历史随旧状态那条一起清掉', async () => {
    const w = world()
    const { current, old } = await versioned(w)
    await w.store.hardDelete(current, { at: at(current) })
    w.clock.now = T0 + RETENTION_MS + 60_000
    await w.store.maintain({ kind: 'global' })
    expect(await w.store.history.memoryIds('/in-memory/global')).toEqual([])
    expect(await w.store.get(old.id, at(old))).toBeUndefined()
  })

  it('从最近删除里把旧状态那条恢复：去向去掉，当前页的历史里不再有它', async () => {
    const w = world()
    const { current, old } = await versioned(w)
    expect(await w.store.restoreArchived(old, { at: at(old), now: T0 + 6000 })).toBe(true)
    expect((await now(w, old)).mergedInto).toBeUndefined()
    expect(await historyWithMerged(w.store, (await w.store.locate(current.id, at(current)))!)).toEqual([])
  })

  it('当前页在判断之后变了：不并', async () => {
    const w = world()
    const current = await seed(w, 'mem_c')
    const old = await seed(w, 'mem_o')
    await w.store.update(current, cur => ({ ...cur, content: '别处改过' }))
    const r = await run(w, versionPlan({ id: 'v1', current, old }))
    expect(r.outcomes).toMatchObject([{ kind: 'skipped', reason: 'basis-changed', memoryId: 'mem_c' }])
    expect((await now(w, old)).status).toBe('active')
  })
})

describe('拆分', () => {
  const drafts = [
    { name: '第一半', summary: '第一半的摘要', content: '第一半的正文', tags: ['a'] },
    { name: '第二半', summary: '第二半的摘要', content: '第二半的正文', tags: ['b'] },
  ]
  const ids = () => {
    let n = 0
    return () => `mem_new_${++n}`
  }

  it('逐条新建、原件软删；新的那几条继承原件的类型、作用域、出处、有效期，不继承锁和关联', async () => {
    const w = world()
    const x = await seed(w, 'mem_x', { scope: 'workspace', workspacePath: WS, type: 'decision', validTo: T0 + 86_400_000, factTime: '2026-10', locked: true, related: ['mem_z'], confidence: 0.6 })
    const r = await run(w, splitPlan({ group: 'g1', original: x, drafts, newId: ids() }))
    expect(r.groups).toEqual([{ group: 'g1', state: 'applied' }])
    expect((await now(w, x)).status).toBe('deleted')
    const n1 = (await w.store.get('mem_new_1', at(x)))!
    expect(n1).toMatchObject({ ...drafts[0], type: 'decision', scope: 'workspace', workspacePath: WS, validTo: x.validTo, factTime: '2026-10', confidence: 0.6, source: x.source, status: 'active', createdAt: T0 + 1000 })
    expect(n1.locked).toBeUndefined()
    expect(n1.related).toBeUndefined()
    expect((await receiptsOfEntry(w.decisions, ENTRY)).map(c => [c.kind, c.memoryId])).toEqual([['create', 'mem_new_1'], ['create', 'mem_new_2'], ['forget', 'mem_x']])
  })

  it('整条撤销：原件回来，新建的那几条进最近删除；之后重新拆一次（新的 id）照常做成', async () => {
    const w = world()
    const x = await seed(w, 'mem_x')
    const newId = ids()
    await run(w, splitPlan({ group: 'g1', original: x, drafts, newId }))
    await w.decisions.finishChangeRun(ENTRY, { writes: [] })
    expect((await undo(w)).kind).toBe('undone')
    expect(stable(await now(w, x))).toEqual(stable(x))
    expect((await w.store.get('mem_new_1', at(x)))!.status).toBe('deleted')
    const again = await run(w, splitPlan({ group: 'g2', original: await now(w, x), drafts, newId }), { entryId: 'pd_again' })
    expect(again.groups).toEqual([{ group: 'g2', state: 'applied' }])
    expect((await w.store.get('mem_new_3', at(x)))!.status).toBe('active')
  })

  it('新建的那条之后被人改过：撤销时不删它，整条撤销不动', async () => {
    const w = world()
    const x = await seed(w, 'mem_x')
    await run(w, splitPlan({ group: 'g1', original: x, drafts, newId: ids() }))
    await w.decisions.finishChangeRun(ENTRY, { writes: [] })
    await w.store.update({ id: 'mem_new_2', workspacePath: undefined }, cur => ({ ...cur, content: '用户接着写的' }))
    const undone = await undo(w)
    expect(undone.kind).toBe('error')
    expect((await w.store.get('mem_new_2', { kind: 'global' }))!.status).toBe('active')
    expect((await now(w, x)).status).toBe('deleted')
  })

  it('要用的 id 已经有了：整组不做', async () => {
    const w = world()
    const x = await seed(w, 'mem_x')
    await seed(w, 'mem_new_2')
    const r = await run(w, splitPlan({ group: 'g1', original: x, drafts, newId: ids() }))
    expect(r.groups).toEqual([{ group: 'g1', state: 'skipped' }])
    expect(r.outcomes.find(o => o.kind === 'skipped' && o.reason !== 'group')).toMatchObject({ reason: 'id-taken', memoryId: 'mem_new_2' })
    expect(await w.store.get('mem_new_1', { kind: 'global' })).toBeUndefined()
    expect((await now(w, x)).status).toBe('active')
  })

  it('后台拆分的稿里带进了原件没有的疑似密钥：整组不做；原件里本来就有的照常', async () => {
    const w = world()
    const secret = 'password: hunter2hunter2'
    const x = await seed(w, 'mem_x', { content: `部署说明 ${secret}` })
    const leaked = [{ ...drafts[0]!, content: 'password: somethingelse99' }, drafts[1]!]
    const bad = await run(w, splitPlan({ group: 'g1', original: x, drafts: leaked, newId: ids() }), { isSecretChecked: true })
    expect(bad.outcomes.find(o => o.kind === 'skipped' && o.reason !== 'group')).toMatchObject({ reason: 'foreign-secret' })
    expect((await now(w, x)).status).toBe('active')
  })

  it('稿过不了格式校验（空名称）：新建那一步不做，已建的撤回', async () => {
    const w = world()
    const x = await seed(w, 'mem_x')
    const ops = splitPlan({ group: 'g1', original: x, drafts, newId: ids() })
    const broken = ops.map(o => (o.id === 'g1-new-2' ? { ...o, draft: { ...o.draft!, tags: [1] as unknown as string[] } } : o))
    const r = await run(w, broken)
    expect(r.groups).toEqual([{ group: 'g1', state: 'rolled-back' }])
    expect((await w.store.get('mem_new_1', { kind: 'global' }))!.status).toBe('deleted')
    expect((await now(w, x)).status).toBe('active')
  })

  it('新建的稿带进别的依据里的疑似密钥：不放行，只有继承的那条里已有的才算', async () => {
    const w = world()
    const from = await seed(w, 'mem_from')
    const other = await seed(w, 'mem_other', { content: 'password: hunter2hunter2' })
    const op: ChangeOp = { id: 'c', kind: 'create', memoryId: 'mem_new', scopeKey: 'global', basis: [basisOf(from), basisOf(other)], from: { memoryId: from.id, scopeKey: 'global' }, draft: { ...drafts[0]!, content: other.content } }
    const r = await run(w, [op], { isSecretChecked: true })
    expect(r.outcomes[0]).toMatchObject({ kind: 'skipped', reason: 'foreign-secret' })
    expect(await w.store.get('mem_new', { kind: 'global' })).toBeUndefined()
  })

  it('新建的那条落在继承那条的作用域：写了别的作用域的不收，那个作用域里同 id 的记忆不动', async () => {
    const w = world()
    const from = await seed(w, 'mem_from', { scope: 'workspace', workspacePath: WS })
    const taken = await seed(w, 'mem_new', { scope: 'workspace', workspacePath: WS, content: '原来就有的' })
    const op: ChangeOp = { id: 'c', kind: 'create', memoryId: 'mem_new', scopeKey: 'global', basis: [basisOf(from)], from: { memoryId: from.id, scopeKey: WS }, draft: drafts[0]! }
    const r = await run(w, [op])
    expect(r.outcomes[0]).toMatchObject({ kind: 'skipped', reason: 'unsupported' })
    expect((await now(w, taken)).content).toBe('原来就有的')
    expect(await w.store.get('mem_new', { kind: 'global' })).toBeUndefined()
  })

  it('这一批前面已经删掉的记忆：不能再拿来继承，也不能再当并进去的那条', async () => {
    const w = world()
    const from = await seed(w, 'mem_from')
    const basis = [basisOf(from)]
    const inherit = await run(w, [
      { group: 'g', id: 'f', kind: 'forget', memoryId: from.id, scopeKey: 'global', basis },
      { group: 'g', id: 'c', kind: 'create', memoryId: 'mem_new', scopeKey: 'global', basis, from: { memoryId: from.id, scopeKey: 'global' }, draft: drafts[0]! },
    ])
    // 做到那一步才查得出来：前面删掉的那步撤回
    expect(inherit.groups).toEqual([{ group: 'g', state: 'rolled-back' }])
    expect(await w.store.get('mem_new', { kind: 'global' })).toBeUndefined()
    expect((await now(w, from)).status).toBe('active')

    const target = await seed(w, 'mem_target')
    const old = await seed(w, 'mem_old')
    const into = await run(w, [
      { group: 'h', id: 'f1', kind: 'forget', memoryId: target.id, scopeKey: 'global', basis: [basisOf(target)] },
      { group: 'h', id: 'f2', kind: 'forget', memoryId: old.id, scopeKey: 'global', basis: [basisOf(old), basisOf(target)], into: { memoryId: target.id, scopeKey: 'global', as: 'version' } },
    ], { entryId: 'pd_second' })
    expect(into.groups).toEqual([{ group: 'h', state: 'rolled-back' }])
    expect([(await now(w, target)).status, (await now(w, old)).status]).toEqual(['active', 'active'])
  })
})
