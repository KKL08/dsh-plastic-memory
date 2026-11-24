import { describe, expect, it } from 'vitest'
import { MemoryStore } from '../src/store.ts'
import { SnapshotStore } from '../src/governance/snapshots.ts'
import { PendingDecisionsStore } from '../src/governance/decisions.ts'
import type { MemorySnapshot, PendingDecision } from '../src/governance/schema.ts'
import { basisOf, type ChangeOp } from '../src/governance/changeset.ts'
import { applyChangeset, receiptsOfEntry, revertChange, type ChangesetDeps } from '../src/tools/changeset.ts'
import { layerOf } from '../src/storage/history.ts'
import type { MemoryRecord } from '../src/record-schema.ts'
import { record } from './helpers/record.ts'
import { InMemoryTable } from './helpers/in-memory-table.ts'
import { InMemoryKvTable, InMemoryBatchKvTable } from './helpers/in-memory-kv.ts'

// 变更集的应用与撤销：逐个操作各占一次写入段、各记一条回执，按回执逆序还原

const T0 = 1_700_000_000_000
const ENTRY = 'pd_run'

function world() {
  const store = new MemoryStore(new InMemoryTable(), undefined, new InMemoryBatchKvTable())
  const snapshots = new SnapshotStore(new InMemoryKvTable<MemorySnapshot>())
  const decisions = new PendingDecisionsStore(new InMemoryKvTable<PendingDecision>())
  const deps: ChangesetDeps = { store, snapshots, decisions }
  return { store, snapshots, decisions, deps }
}
type World = ReturnType<typeof world>

async function seed(w: World, partial: Partial<MemoryRecord> = {}): Promise<MemoryRecord> {
  const rec = record({ id: 'mem_a', name: '发版流程', content: '旧正文', summary: '旧摘要', tags: ['x'], createdAt: T0, updatedAt: T0, lastConfirmedAt: T0, ...partial })
  await w.store.create(rec)
  return (await w.store.get(rec.id, { workspacePath: rec.workspacePath }))!
}
const now = async (w: World, id = 'mem_a') => (await w.store.get(id, {}))!

async function run(w: World, ops: ChangeOp[], extra: { isAllOrNothing?: boolean; isSecretChecked?: boolean } = {}) {
  await w.decisions.addChangeRun(ENTRY, { kind: 'edit', summary: '测试', workspaces: ['global'], memoryIds: [] }, 'batch-edited', T0 + 1)
  return applyChangeset(ops, { entryId: ENTRY, by: 'gui', at: T0 + 1000, isSecretChecked: extra.isSecretChecked ?? false, ...extra }, w.deps)
}

async function undoAll(w: World) {
  const results = []
  for (const receipt of [...(await receiptsOfEntry(w.decisions, ENTRY))].reverse()) results.push(await revertChange(ENTRY, receipt, { by: 'gui' }, w.deps))
  return results
}

const op = (read: MemoryRecord, id: string, extra: Partial<ChangeOp> & Pick<ChangeOp, 'kind'>): ChangeOp => ({ id, memoryId: read.id, basis: [basisOf(read)], ...extra })
/** 召回统计、提交标记之外的内容。 */
const stable = ({ lastWriteOp: _op, recallCount: _c, lastRecalledAt: _a, ...rest }: MemoryRecord) => rest

describe('应用', () => {
  it('同一批对一条记忆连做三个操作（内容改动夹着元数据改动），再逆序整批撤销，回到原样', async () => {
    const w = world()
    const read = await seed(w)
    const r = await run(w, [
      op(read, 'o1', { kind: 'edit', patch: { content: '第二版' }, expect: { content: '旧正文' } }),
      op(read, 'o2', { kind: 'set-recall', patch: { recall: 'never' }, expect: { recall: null } }),
      op(read, 'o3', { kind: 'edit', patch: { content: '第三版', summary: '新摘要' }, expect: { content: '旧正文', summary: '旧摘要' } }),
    ])
    expect(r.outcomes.map(o => o.kind)).toEqual(['applied', 'applied', 'applied'])
    expect(await now(w)).toMatchObject({ content: '第三版', summary: '新摘要', recall: 'never' })
    expect((await receiptsOfEntry(w.decisions, ENTRY)).map(c => [c.id, c.fields])).toEqual([['o1', ['content']], ['o2', ['recall']], ['o3', ['summary', 'content']]])

    expect((await undoAll(w)).map(x => x.kind)).toEqual(['reverted', 'reverted', 'reverted'])
    expect(stable(await now(w))).toEqual(stable(read))
    expect(await receiptsOfEntry(w.decisions, ENTRY)).toEqual([])
  })

  it('元数据操作不动修改时间和最近一次内容改动；内容操作记这一次', async () => {
    const w = world()
    const read = await seed(w)
    await run(w, [op(read, 'o1', { kind: 'set-recall', patch: { recall: 'never' }, expect: { recall: null } })])
    expect(await now(w)).toMatchObject({ recall: 'never', updatedAt: T0 })
    expect((await now(w)).lastChange).toBeUndefined()
    const again = await now(w)
    await applyChangeset([op(again, 'o2', { kind: 'edit', patch: { content: '新正文' }, expect: { content: '旧正文' }, change: 'correct' })],
      { entryId: ENTRY, by: 'dreams', at: T0 + 2000, isSecretChecked: true }, w.deps)
    expect((await now(w)).lastChange).toMatchObject({ kind: 'correct', by: 'dreams' })
  })

  it('一个操作改注入档位、期间别处追加了关联，后一个建关联操作落盘后两边的关联都在', async () => {
    const w = world()
    const read = await seed(w)
    await seed(w, { id: 'mem_b', name: '乙' })
    await seed(w, { id: 'mem_c', name: '丙' })
    await run(w, [op(read, 'o1', { kind: 'set-recall', patch: { recall: 'never' }, expect: { recall: null } })])
    // 别处（另一个会话）这时追加了一条关联
    await w.store.update(read, cur => ({ ...cur, related: [...(cur.related ?? []), 'mem_b'] }))
    const r = await applyChangeset([op(read, 'o2', { kind: 'link', links: { add: { related: ['mem_c'] } } })], { entryId: ENTRY, by: 'gui', at: T0 + 2000, isSecretChecked: false }, w.deps)
    expect(r.outcomes[0]).toMatchObject({ kind: 'applied' })
    expect(await now(w)).toMatchObject({ related: ['mem_b', 'mem_c'], recall: 'never' })
    // 撤掉建关联的那一个：只去掉它加的
    const link = (await receiptsOfEntry(w.decisions, ENTRY)).find(c => c.id === 'o2')!
    expect(link.links).toEqual({ added: { related: ['mem_c'], premises: [] }, removed: { related: [], premises: [] } })
    expect((await revertChange(ENTRY, link, { by: 'gui' }, w.deps)).kind).toBe('reverted')
    expect((await now(w)).related).toEqual(['mem_b'])
  })

  it('按旧正文做的决定，期间正文被纠正了：这个操作跳过，后面的照做', async () => {
    const w = world()
    const read = await seed(w)
    const other = await seed(w, { id: 'mem_b', name: '乙' })
    await w.store.update(read, cur => ({ ...cur, content: '纠正后的正文' }))
    const r = await run(w, [
      op(read, 'o1', { kind: 'set-recall', patch: { recall: 'never' }, expect: { recall: null } }),
      op(other, 'o2', { kind: 'set-recall', patch: { recall: 'never' }, expect: { recall: null } }),
    ])
    expect(r.outcomes).toMatchObject([{ kind: 'skipped', reason: 'basis-changed', memoryId: 'mem_a' }, { kind: 'applied' }])
    expect((await now(w)).recall).toBeUndefined()
    expect((await now(w, 'mem_b')).recall).toBe('never')
    // 跳过的操作不拍快照
    expect((await w.snapshots.list()).map(s => s.memoryIds)).toEqual([['mem_b']])
  })

  it('改写带疑似密钥的记忆：原有的疑似值放行，模型新带进来的被拦', async () => {
    const w = world()
    const read = await seed(w, { content: '连接串 password=Abc12345xyz' })
    const blocked = await run(w, [op(read, 'o1', { kind: 'edit', patch: { content: '连接串 password=Zzz98765qwe' }, expect: { content: read.content } })], { isSecretChecked: true })
    expect(blocked.outcomes[0]).toMatchObject({ kind: 'skipped', reason: 'foreign-secret' })
    const kept = await run(w, [op(read, 'o2', { kind: 'edit', patch: { content: '测试库连接串 password=Abc12345xyz' }, expect: { content: read.content } })], { isSecretChecked: true })
    expect(kept.outcomes[0]).toMatchObject({ kind: 'applied' })
  })

  it('要挂的 id 不合规：跳过，原因给出来；补证刷新确认时间、可撤', async () => {
    const w = world()
    const read = await seed(w)
    const r = await run(w, [
      op(read, 'o1', { kind: 'link', links: { add: { related: ['mem_missing'] } } }),
      op(read, 'o2', { kind: 'corroborate' }),
    ])
    expect(r.outcomes[0]).toMatchObject({ kind: 'skipped', reason: 'link-invalid' })
    expect(r.outcomes[1]).toMatchObject({ kind: 'applied' })
    expect((await now(w)).lastConfirmedAt).toBe(T0 + 1000)
    expect((await undoAll(w)).map(x => x.kind)).toEqual(['reverted'])
    expect((await now(w)).lastConfirmedAt).toBe(T0)
  })

  it('删除：进最近删除；含密钥的不删；撤销放回在用，内容和修改时间都是删之前的', async () => {
    const w = world()
    const read = await seed(w)
    const secret = await seed(w, { id: 'mem_s', content: 'password=Abc12345xyz' })
    const r = await run(w, [op(read, 'o1', { kind: 'forget' }), op(secret, 'o2', { kind: 'forget' })])
    expect(r.outcomes).toMatchObject([{ kind: 'applied' }, { kind: 'skipped', reason: 'has-secret' }])
    expect((await now(w)).status).toBe('deleted')
    expect((await undoAll(w)).map(x => x.kind)).toEqual(['reverted'])
    expect(stable(await now(w))).toEqual(stable(read))
  })

  it('整批退：第二项对不上，第一项按回执撤回，记忆回到原样，回执清空', async () => {
    const w = world()
    const a = await seed(w)
    const b = await seed(w, { id: 'mem_b', name: '乙' })
    await w.store.update(b, cur => ({ ...cur, content: '别处改过' }))
    const r = await run(w, [
      op(a, 'o1', { kind: 'edit', patch: { content: '新' }, expect: { content: '旧正文' } }),
      op(b, 'o2', { kind: 'edit', patch: { content: '新' }, expect: { content: b.content } }),
    ], { isAllOrNothing: true })
    expect(r).toMatchObject({ isRolledBack: true, outcomes: [{ kind: 'applied' }, { kind: 'skipped', reason: 'basis-changed' }] })
    expect(r.unreverted).toBeUndefined()
    expect(stable(await now(w))).toEqual(stable(a))
    expect(await receiptsOfEntry(w.decisions, ENTRY)).toEqual([])
  })
})

describe('撤销的资格', () => {
  async function edited(w: World) {
    const read = await seed(w)
    await run(w, [op(read, 'o1', { kind: 'edit', patch: { content: '新正文' }, expect: { content: '旧正文' } })])
    return { read, receipt: (await receiptsOfEntry(w.decisions, ENTRY))[0]! }
  }

  it('期间被软删的不撤', async () => {
    const w = world()
    const { receipt } = await edited(w)
    await w.store.softDelete(await now(w))
    expect(await revertChange(ENTRY, receipt, { by: 'gui' }, w.deps)).toEqual({ kind: 'blocked', block: 'status' })
    expect((await now(w)).content).toBe('新正文')
  })

  it('只刷新过确认时间的照常能撤', async () => {
    const w = world()
    const { receipt } = await edited(w)
    await w.store.update(await now(w), cur => ({ ...cur, lastConfirmedAt: T0 + 5000 }))
    expect((await revertChange(ENTRY, receipt, { by: 'gui' }, w.deps)).kind).toBe('reverted')
    expect(await now(w)).toMatchObject({ content: '旧正文', lastConfirmedAt: T0 + 5000 })
  })

  it('期间被补证过的不能撤', async () => {
    const w = world()
    const { receipt } = await edited(w)
    const anchor = { sessionId: 's9', eventRange: [3, 4] as [number, number], sourceMode: 'user-explicit' }
    await applyChangeset([op(await now(w), 'o9', { kind: 'corroborate' })], { entryId: 'pd_other', by: 'main', at: T0 + 3000, isSecretChecked: false, anchor }, w.deps)
    expect(await revertChange(ENTRY, receipt, { by: 'gui' }, w.deps)).toEqual({ kind: 'blocked', block: 'corroborated' })
  })

  it('状态变化的撤销连它留的历史版本一起撤', async () => {
    const w = world()
    const read = await seed(w)
    await run(w, [op(read, 'o1', { kind: 'edit', patch: { content: '新状态' }, expect: { content: '旧正文' }, change: 'state-change', reason: '换了方案' })])
    const layer = layerOf((await w.store.locate('mem_a', {}))!)
    expect(await w.store.history.list(layer, 'mem_a')).toHaveLength(1)
    expect((await undoAll(w)).map(x => x.kind)).toEqual(['reverted'])
    expect(await w.store.history.list(layer, 'mem_a')).toEqual([])
    expect(stable(await now(w))).toEqual(stable(read))
  })
})
