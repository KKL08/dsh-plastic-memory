import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileTable } from '../src/storage/file-table.ts'
import { MemoryStore } from '../src/store.ts'
import { editFingerprint } from '../src/governance/snapshots.ts'
import type { BatchReceipt, PendingDecision, PendingKind, SettledVerdict } from '../src/governance/schema.ts'
import { asUndoable, expectedFingerprints, isStillOwnWrite, isUndoable, undoRuleOf, undoStateOf, undoStateOfAll, type UndoableEntry } from '../src/governance/undo-rules.ts'
import { RETENTION_MS } from '../src/retention.ts'
import type { MemoryRecord } from '../src/record-schema.ts'
import { scopeAt } from '../src/scope.ts'
import { record } from './helpers/record.ts'
import { InMemoryBatchKvTable, InMemoryKvTable } from './helpers/in-memory-kv.ts'
import type { RecallStats } from '../src/storage/schema.ts'

// 撤销规则：种类 × 现状的表格测试。记忆走真实文件表写下再读回，条目按账本的形状手造（规则是纯函数，不经账本）。

const WS = '/ws/a'
const NOW = 1_800_000_000_000
let root: string
let store: MemoryStore

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pm-undo-rules-'))
  store = new MemoryStore(new FileTable({ root, stats: new InMemoryKvTable<RecallStats>(), now: () => NOW }), undefined, new InMemoryBatchKvTable())
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

const VERDICT_OF: Record<string, SettledVerdict> = { edit: 'edited', move: 'moved', rewrite: 'rewritten', supersede: 'superseded' }

/** 写下一条记忆再读回（真实文件表上的样子），之后的现状都从它改。 */
async function written(partial: Partial<MemoryRecord>): Promise<MemoryRecord> {
  const r = record({ scope: 'workspace', workspacePath: WS, ...partial })
  await store.create(r)
  return (await store.get(r.id, scopeAt(WS)))!
}
const reread = async (id: string) => store.get(id, scopeAt(WS))

function settled(kind: PendingKind, memoryIds: string[], extra: Partial<PendingDecision> & { verdict?: SettledVerdict; isUndone?: boolean; isBornSettled?: boolean } = {}): UndoableEntry {
  const { verdict, isUndone, isBornSettled, ...rest } = extra
  const entry: PendingDecision = {
    id: `pd_${kind}`, kind, memoryIds, summary: 's', firstSeenAt: NOW, workspaces: [WS],
    settled: {
      verdict: verdict ?? VERDICT_OF[kind] ?? 'keep-both', at: NOW, snapshotId: 'snap_1',
      ...(isUndone === true ? { isUndone } : {}), ...(isBornSettled === true ? { isBornSettled } : {}),
    },
    ...rest,
  }
  return asUndoable(entry)!
}

describe('undoStateOf：按指纹判的种类（直接改 / 移到项目 / 模型改写 / 模型替代）', () => {
  const kinds = [
    { kind: 'edit', status: 'active' },
    { kind: 'move', status: 'active' },
    { kind: 'rewrite', status: 'active' },
    { kind: 'supersede', status: 'superseded' },
  ] as const

  it.each(kinds)('$kind：原样可撤；被改、被删进最近删除、彻底删除都算已改过', async ({ kind, status }) => {
    const after = await written({ content: '那次写下的', status })
    const before = { ...after, content: '改前的' }
    const entry = settled(kind, [after.id], { fingerprint: editFingerprint(after) })
    expect(undoStateOf(entry, before, await reread(after.id))).toBe('undoable')

    await store.update(after, r => ({ ...r, content: '之后又改的' }), scopeAt(WS))
    expect(undoStateOf(entry, before, await reread(after.id))).toBe('changed')

    await store.update(after, r => ({ ...r, content: '那次写下的', status: 'deleted', deletedAt: NOW }), scopeAt(WS))
    expect(undoStateOf(entry, before, await reread(after.id))).toBe('changed')

    await store.hardDelete(after, { at: scopeAt(WS) })
    expect(undoStateOf(entry, before, await reread(after.id))).toBe('changed')
  })

  it('内容没变但状态不是期望的：改写的那条成了已取代、替代的那条回到在用，都算已改过', async () => {
    const rewritten = await written({ content: '改写后', status: 'superseded' })
    expect(undoStateOf(settled('rewrite', [rewritten.id], { fingerprint: editFingerprint(rewritten) }), rewritten, rewritten)).toBe('changed')
    const superseded = await written({ content: '被替代的', status: 'active' })
    expect(undoStateOf(settled('supersede', [superseded.id], { fingerprint: editFingerprint(superseded) }), superseded, superseded)).toBe('changed')
  })

  it.each(['edit', 'rewrite', 'supersede'] as const)('%s：改前快照已清（before 缺）算过期', async (kind) => {
    const after = await written({ status: kind === 'supersede' ? 'superseded' : 'active' })
    expect(undoStateOf(settled(kind, [after.id], { fingerprint: editFingerprint(after) }), undefined, after)).toBe('expired')
  })

  it('移到项目不靠快照：快照已清也照现状判；全局被占不归状态管（动手时回 target-taken）', async () => {
    const moved = await written({ content: '移过去的' })
    await store.create({ ...moved, scope: 'global', workspacePath: undefined, content: '全局另一份' })
    expect(undoStateOf(settled('move', [moved.id], { fingerprint: editFingerprint(moved) }), undefined, moved)).toBe('undoable')
  })

  it.each(['rewrite', 'supersede'] as const)('%s 已撤销：不论现状都是 undone', async (kind) => {
    const after = await written({ status: kind === 'rewrite' ? 'active' : 'superseded' })
    const entry = settled(kind, [after.id], { fingerprint: editFingerprint(after), isUndone: true })
    expect(undoStateOf(entry, after, after)).toBe('undone')
    expect(undoStateOf(entry, undefined, undefined)).toBe('undone')
  })

  it('没记指纹的旧条目：怎么都对不上，算已改过', async () => {
    const after = await written({})
    expect(undoStateOf(settled('edit', [after.id], {}), after, after)).toBe('changed')
  })
})

describe('undoStateOf：按快照恢复、不比指纹的种类', () => {
  it('删一方的裁决、提升为全局：快照在就可撤，快照清了算过期', async () => {
    const loser = await written({ status: 'deleted' })
    const conflict = settled('conflict', ['mem_left', loser.id], { verdict: 'keep-left' })
    expect(undoStateOf(conflict, loser, loser)).toBe('undoable')
    expect(undoStateOf(conflict, undefined, loser)).toBe('expired')
    const promoted = settled('promote-candidate', [loser.id], { verdict: 'promoted' })
    expect(undoStateOf(promoted, loser, undefined)).toBe('undoable')
    expect(undoStateOf(promoted, undefined, undefined)).toBe('expired')
  })

  it('留在本项目、两边都留：不靠快照，总是可撤', async () => {
    expect(undoStateOf(settled('promote-candidate', ['mem_x'], { verdict: 'keep-local' }), undefined, undefined)).toBe('undoable')
    expect(undoStateOf(settled('conflict', ['mem_a', 'mem_b'], { verdict: 'keep-both' }), undefined, undefined)).toBe('undoable')
  })
})

describe('isStillOwnWrite', () => {
  it('状态是种类期望的、指纹对得上才算；不按指纹判的种类一律不算', async () => {
    const after = await written({ content: '那次写下的' })
    expect(isStillOwnWrite(settled('edit', [after.id], { fingerprint: editFingerprint(after) }), after)).toBe(true)
    expect(isStillOwnWrite(settled('edit', [after.id], { fingerprint: editFingerprint(after) }), undefined)).toBe(false)
    expect(isStillOwnWrite(settled('supersede', [after.id], { fingerprint: editFingerprint(after) }), after)).toBe(false)
    expect(isStillOwnWrite(settled('conflict', ['a', 'b'], { verdict: 'keep-left', fingerprint: editFingerprint(after) }), after)).toBe(false)
  })
})

describe('expectedFingerprints', () => {
  it('合并：保留的那条期望那次写下的指纹，合并删掉的那条期望快照里的', async () => {
    const kept = record({ id: 'mem_k', content: '保留前' })
    const removed = record({ id: 'mem_r', content: '删掉的' })
    const entry = settled('edit', ['mem_k', 'mem_r'], { verdict: 'merged', fingerprint: 'fp-merged' })
    expect(expectedFingerprints(entry, [kept, removed])).toEqual(new Map([['mem_k', 'fp-merged'], ['mem_r', editFingerprint(removed)]]))
  })
})

describe('undoRuleOf：按种类的表', () => {
  it.each([
    ['删一方的裁决', settled('conflict', ['mem_a', 'mem_b'], { verdict: 'keep-right' }), { targets: ['mem_a'], mechanism: 'restore-snapshot', fate: 'reopen' }],
    ['两边都留', settled('conflict', ['mem_a', 'mem_b'], { verdict: 'keep-both' }), { targets: [], mechanism: 'restore-snapshot', fate: 'reopen' }],
    ['提升为全局', settled('promote-candidate', ['mem_p'], { verdict: 'promoted' }), { targets: ['mem_p'], mechanism: 'restore-snapshot', fate: 'reopen' }],
    ['就地提升（生来已结清）', settled('promote-candidate', ['mem_p'], { verdict: 'promoted', isBornSettled: true }), { targets: ['mem_p'], mechanism: 'restore-snapshot', fate: 'remove' }],
    ['留在本项目', settled('promote-candidate', ['mem_p'], { verdict: 'keep-local' }), { targets: ['mem_p'], mechanism: 'reflag', fate: 'reopen' }],
    ['直接合并', settled('edit', ['mem_k', 'mem_r'], { verdict: 'merged' }), { targets: ['mem_k', 'mem_r'], expectedStatus: 'active', mechanism: 'restore-snapshot', fate: 'remove' }],
    ['移到项目', settled('move', ['mem_m']), { targets: ['mem_m'], expectedStatus: 'active', mechanism: 'relocate', fate: 'remove' }],
    ['模型改写', settled('rewrite', ['mem_w']), { targets: ['mem_w'], expectedStatus: 'active', mechanism: 'restore-snapshot', fate: 'mark-undone' }],
    ['模型替代', settled('supersede', ['mem_s']), { targets: ['mem_s'], expectedStatus: 'superseded', mechanism: 'restore-snapshot', fate: 'mark-undone' }],
    ['超限提醒的忽略', settled('overflow', [], { verdict: 'dismiss' }), { targets: [], mechanism: 'restore-snapshot', fate: 'reopen' }],
  ] as const)('%s', (_label, entry, rule) => {
    expect(undoRuleOf(entry)).toEqual(rule)
  })
})

describe('asUndoable 与 isUndoable', () => {
  it('只有已结清的条目可撤；种类缺省按冲突收窄', () => {
    const open: PendingDecision = { id: 'pd_o', memoryIds: ['a', 'b'], summary: 's', firstSeenAt: NOW }
    expect(asUndoable(open)).toBeUndefined()
    expect(asUndoable({ ...open, settled: { verdict: 'keep-left', at: NOW } })?.kind).toBe('conflict')
  })

  it('留作撤销、随快照过期清掉的：删一方、提升为全局、直接改、移到项目、模型改写与替代；两边都留与留在本项目不算', () => {
    const at = (kind: PendingKind, verdict: SettledVerdict, memoryIds = ['a', 'b']) =>
      isUndoable({ id: 'x', kind, memoryIds, summary: 's', firstSeenAt: NOW, settled: { verdict, at: NOW - RETENTION_MS } })
    expect([at('conflict', 'keep-left'), at('promote-candidate', 'promoted'), at('edit', 'edited'), at('move', 'moved'), at('rewrite', 'rewritten'), at('supersede', 'superseded')])
      .toEqual([true, true, true, true, true, true])
    expect([at('conflict', 'keep-both'), at('promote-candidate', 'keep-local'), at('overflow', 'dismiss')]).toEqual([false, false, false])
  })
})

describe('整理所选（batch-edited）：按回执逐项比', () => {
  const receipt = (r: MemoryRecord, op: 'edit' | 'forget'): BatchReceipt =>
    ({ memoryId: r.id, op, fingerprint: editFingerprint(r), expectedStatus: op === 'edit' ? 'active' : 'deleted' })
  const batch = (receipts: BatchReceipt[]) => settled('edit', receipts.map(r => r.memoryId), { verdict: 'batch-edited', receipts })

  it('undoRuleOf：目标是全部回执项，按改前快照恢复，撤后移出账本', () => {
    const receipts: BatchReceipt[] = [
      { memoryId: 'mem_d', op: 'forget', fingerprint: 'fp-d', expectedStatus: 'deleted' },
      { memoryId: 'mem_e', op: 'edit', fingerprint: 'fp-e', expectedStatus: 'active' },
    ]
    expect(undoRuleOf(batch(receipts))).toEqual({ targets: ['mem_d', 'mem_e'], mechanism: 'restore-snapshot', fate: 'remove', receipts })
  })

  it('isStillOwnWrite / undoStateOf：每项按自己的回执比状态和指纹；改写项被改、删除项被单独恢复或彻底删除都算已改过', async () => {
    const edited = await written({ id: 'mem_e', content: '改写后' })
    const deleted = await written({ id: 'mem_d', content: '删掉的', status: 'deleted', deletedAt: NOW })
    const entry = batch([receipt(deleted, 'forget'), receipt(edited, 'edit')])
    const before = (r: MemoryRecord) => ({ ...r, content: '改前', status: 'active' as const })
    expect([isStillOwnWrite(entry, edited), isStillOwnWrite(entry, deleted)]).toEqual([true, true])
    expect([undoStateOf(entry, before(edited), edited), undoStateOf(entry, before(deleted), deleted)]).toEqual(['undoable', 'undoable'])
    // 回执里没有的记忆、此刻哪都没有：都不算那次写下的
    expect(isStillOwnWrite(entry, await written({ id: 'mem_x' }))).toBe(false)
    expect(undoStateOf(entry, before(edited), undefined)).toBe('changed')

    await store.update(edited, r => ({ ...r, content: '之后又改的' }), scopeAt(WS))
    expect(undoStateOf(entry, before(edited), await reread('mem_e'))).toBe('changed')
    // 删掉的那条在最近删除里单独恢复了：内容没变，状态不是期望的
    await store.update(deleted, r => ({ ...r, status: 'active' }), scopeAt(WS))
    expect(undoStateOf(entry, before(deleted), await reread('mem_d'))).toBe('changed')
    await store.hardDelete(deleted, { at: scopeAt(WS) })
    expect(undoStateOf(entry, before(deleted), await reread('mem_d'))).toBe('changed')
  })

  it('undoStateOfAll：逐项都可撤才可撤；任一项快照缺了是 expired，任一项对不上是 changed；已撤销的是 undone', async () => {
    const edited = await written({ id: 'mem_e', content: '改写后' })
    const deleted = await written({ id: 'mem_d', content: '删掉的', status: 'deleted', deletedAt: NOW })
    const entry = batch([receipt(deleted, 'forget'), receipt(edited, 'edit')])
    const copies = (patch: Partial<Record<string, { before?: MemoryRecord; current?: MemoryRecord }>> = {}) => new Map([
      ['mem_d', { before: deleted, current: deleted, ...patch.mem_d }],
      ['mem_e', { before: edited, current: edited, ...patch.mem_e }],
    ])
    expect(undoStateOfAll(entry, copies())).toBe('undoable')
    expect(undoStateOfAll(entry, copies({ mem_e: { current: { ...edited, content: '又改了' } } }))).toBe('changed')
    expect(undoStateOfAll(entry, copies({ mem_d: { before: undefined } }))).toBe('expired')
    expect(undoStateOfAll(entry, new Map([['mem_e', { before: edited, current: edited }]]))).toBe('expired')
    expect(undoStateOfAll({ ...entry, settled: { ...entry.settled, isUndone: true } }, copies())).toBe('undone')
  })

  it('undoStateOfAll：没有回执的种类只看主条（同 undoStateOf）', async () => {
    const after = await written({ content: '那次写下的' })
    const entry = settled('edit', [after.id, 'mem_r'], { verdict: 'merged', fingerprint: editFingerprint(after) })
    expect(undoStateOfAll(entry, new Map([[after.id, { before: after, current: after }]]))).toBe('undoable')
    expect(undoStateOfAll(entry, new Map([[after.id, { before: undefined, current: after }]]))).toBe('expired')
  })

  it('expectedFingerprints：有回执时每项按回执取', () => {
    const entry = batch([
      { memoryId: 'mem_d', op: 'forget', fingerprint: 'fp-d', expectedStatus: 'deleted' },
      { memoryId: 'mem_e', op: 'edit', fingerprint: 'fp-e', expectedStatus: 'active' },
    ])
    expect(expectedFingerprints(entry, [record({ id: 'mem_d' }), record({ id: 'mem_e' })])).toEqual(new Map([['mem_d', 'fp-d'], ['mem_e', 'fp-e']]))
  })

  it('isUndoable：留作撤销，随快照过期清掉', () => {
    const entry = batch([{ memoryId: 'mem_e', op: 'edit', fingerprint: 'fp-e', expectedStatus: 'active' }])
    expect(isUndoable(entry)).toBe(true)
  })
})

describe('冲突按处理方案落盘（plan-applied）：回执在结清信息里，按回执逐项比', () => {
  const receipts: BatchReceipt[] = [
    { memoryId: 'mem_a', op: 'edit', fingerprint: 'fp-a', expectedStatus: 'active' },
    { memoryId: 'mem_b', op: 'forget', fingerprint: 'fp-b', expectedStatus: 'deleted' },
  ]
  const applied = (rs: BatchReceipt[], memoryIds = ['mem_a', 'mem_b']) => {
    const entry = settled('conflict', memoryIds, { verdict: 'plan-applied' })
    return { ...entry, settled: { ...entry.settled, receipts: rs } }
  }

  it('undoRuleOf：目标是全部回执项（不只败方），按改前快照恢复，撤后回到待处理', () => {
    expect(undoRuleOf(applied(receipts))).toEqual({ targets: ['mem_a', 'mem_b'], mechanism: 'restore-snapshot', fate: 'reopen', receipts })
  })

  it('isStillOwnWrite / undoStateOfAll：每项按自己的回执比；融合稿之后又被改过、败方被单独恢复都算已改过', async () => {
    const a = await written({ id: 'mem_a', content: '融合稿' })
    const b = await written({ id: 'mem_b', content: '并入的', status: 'deleted', deletedAt: NOW })
    const own: BatchReceipt[] = [
      { memoryId: 'mem_a', op: 'edit', fingerprint: editFingerprint(a), expectedStatus: 'active' },
      { memoryId: 'mem_b', op: 'forget', fingerprint: editFingerprint(b), expectedStatus: 'deleted' },
    ]
    const entry = applied(own)
    expect([isStillOwnWrite(entry, a), isStillOwnWrite(entry, b)]).toEqual([true, true])
    const copies = (patch: Partial<Record<string, MemoryRecord>> = {}) => new Map([
      ['mem_a', { before: a, current: patch.mem_a ?? a }],
      ['mem_b', { before: b, current: patch.mem_b ?? b }],
    ])
    expect(undoStateOfAll(entry, copies())).toBe('undoable')
    expect(undoStateOfAll(entry, copies({ mem_a: { ...a, content: '又改了' } }))).toBe('changed')
    expect(undoStateOfAll(entry, copies({ mem_b: { ...b, status: 'active' } }))).toBe('changed')
    expect(undoStateOfAll(entry, new Map([['mem_a', { before: a, current: a }]]))).toBe('expired')
  })

  it('isUndoable：有删除项的、没有删除项的（垂直改写）都留作撤销，随快照过期清掉', () => {
    expect(isUndoable(applied(receipts))).toBe(true)
    expect(isUndoable(applied(receipts.slice(0, 1), ['mem_a']))).toBe(true)
  })
})
