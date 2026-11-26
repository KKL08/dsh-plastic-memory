import { describe, expect, it } from 'vitest'
import { executeConfirm, type ConfirmArgs, type ConfirmToolDeps } from '../src/tools/confirm.ts'
import { executeUndo } from '../src/tools/undo.ts'
import { MemoryStore } from '../src/store.ts'
import { PendingDecisionsStore, conflictFingerprint } from '../src/governance/decisions.ts'
import { SnapshotStore } from '../src/governance/snapshots.ts'
import { FINDING_LEDGER_KINDS, VERDICTS_BY_KIND, type FindingLedgerKind, type MemorySnapshot, type PendingDecision } from '../src/governance/schema.ts'
import { historyWithMerged } from '../src/merged-history.ts'
import { mergedIntoOf, type MemoryRecord } from '../src/record-schema.ts'
import { record } from './helpers/record.ts'
import { InMemoryTable } from './helpers/in-memory-table.ts'
import { InMemoryKvTable, InMemoryBatchKvTable } from './helpers/in-memory-kv.ts'
import { noInstructions } from './helpers/instructions.ts'
import { FAKE_SECRET } from './helpers/secrets.ts'

// 五种发现的裁决：每种只认自己那几个裁决；并成版本把旧状态那条并进当前页，可撤销；确实不冲突、记成例外记下结论

const T0 = 1_700_000_000_000
const GLOBAL = { kind: 'global' as const }
const ctx = { workspacePath: undefined }

function world() {
  const clock = { now: T0 + 5000 }
  const pending = new InMemoryKvTable<PendingDecision>()
  const deps: ConfirmToolDeps = {
    instructions: noInstructions,
    store: new MemoryStore(new InMemoryTable('/in-memory', () => clock.now), undefined, new InMemoryBatchKvTable()),
    decisions: new PendingDecisionsStore(pending),
    snapshots: new SnapshotStore(new InMemoryKvTable<MemorySnapshot>()),
    now: () => clock.now,
  }
  return { deps, pending, clock }
}
type World = ReturnType<typeof world>

async function seed(w: World, id: string, partial: Partial<MemoryRecord> = {}): Promise<MemoryRecord> {
  await w.deps.store.create(record({ id, name: `${id} 的名称`, content: `${id} 的正文`, createdAt: T0, updatedAt: T0, lastConfirmedAt: T0, ...partial }))
  return (await w.deps.store.get(id, GLOBAL))!
}
async function report(w: World, kind: FindingLedgerKind, records: MemoryRecord[], extra: Partial<PendingDecision> = {}): Promise<PendingDecision> {
  const { entry } = await w.deps.decisions.upsert({
    ...(kind !== 'conflict' ? { kind } : {}), memoryIds: records.map(r => r.id), summary: '体检报的', workspaces: records.map(() => 'global'),
    fingerprint: conflictFingerprint(records), ...(extra.baselineRef !== undefined ? { baselineRef: extra.baselineRef } : {}),
  }, T0)
  return entry
}
type Verdict = Extract<ConfirmArgs, { action: 'resolve' }>['verdict']
const resolve = (w: World, decisionId: string, verdict: Verdict, current?: string) =>
  executeConfirm({ action: 'resolve', decisionId, verdict, ...(current !== undefined ? { current } : {}) }, ctx, w.deps)
const ALL_VERDICTS = VERDICTS_BY_KIND.conflict

describe('裁决按种类', () => {
  it('每种发现只认自己那几个裁决：表外的组合回 invalid-args，列出能用的，条目和记忆都不动', async () => {
    let checked = 0
    for (const kind of FINDING_LEDGER_KINDS) {
      const w = world()
      const pair = [await seed(w, 'mem_a'), await seed(w, 'mem_b')]
      const entry = await report(w, kind, pair)
      const before = await w.pending.get(entry.id)
      const allowed: readonly string[] = VERDICTS_BY_KIND[kind]
      for (const verdict of ALL_VERDICTS.filter(v => !allowed.includes(v))) {
        const r = await resolve(w, entry.id, verdict, 'mem_b')
        expect(r, `${kind} / ${verdict}`).toMatchObject({ kind: 'error', code: 'invalid-args' })
        for (const ok of allowed) expect(r.kind === 'error' ? r.message : '', `${kind} / ${verdict}`).toContain(ok)
        expect(await w.pending.get(entry.id)).toEqual(before)
        expect((await w.deps.store.get('mem_a', GLOBAL))!.status).toBe('active')
        expect((await w.deps.store.get('mem_b', GLOBAL))!.status).toBe('active')
        checked++
      }
    }
    expect(checked).toBe(0 + 4 + 6 + 6 + 6)
  })

  it('漏记的变化、依据已变、例外提示、跨项目重复可以忽略：记下结论，记忆都不动', async () => {
    for (const kind of ['missed-change', 'premise-changed', 'exception', 'cross-duplicate'] as const) {
      const w = world()
      const pair = [await seed(w, 'mem_a'), await seed(w, 'mem_b')]
      const entry = await report(w, kind, pair)
      expect(await resolve(w, entry.id, 'dismiss'), kind).toMatchObject({ kind: 'resolved', verdict: 'dismiss' })
      expect(await w.deps.decisions.list()).toEqual([])
      expect((await w.deps.decisions.listSettled()).map(d => [d.kind, d.settled?.verdict, d.fingerprint])).toEqual([[kind, 'dismiss', entry.fingerprint]])
      expect(await w.deps.store.get('mem_a', GLOBAL)).toEqual(pair[0])
      expect(await w.deps.store.get('mem_b', GLOBAL)).toEqual(pair[1])
    }
  })

  it('确实不冲突、记成例外、两条都留：各自原样记下裁决值和双方此刻的扫描指纹，记忆都不动', async () => {
    const cases: Array<[FindingLedgerKind, Verdict]> = [['conflict', 'not-conflict'], ['conflict', 'exception'], ['conflict', 'keep-both'], ['missed-change', 'not-conflict']]
    for (const [kind, verdict] of cases) {
      const w = world()
      const pair = [await seed(w, 'mem_a'), await seed(w, 'mem_b')]
      const entry = await report(w, kind, pair)
      expect(await resolve(w, entry.id, verdict), `${kind} / ${verdict}`).toMatchObject({ kind: 'resolved', verdict })
      const [settled] = await w.deps.decisions.listSettled()
      expect(settled!.settled!.verdict).toBe(verdict)
      expect(Object.keys(settled!.memberScanFingerprints ?? {})).toHaveLength(2)
      expect([(await w.deps.store.get('mem_a', GLOBAL))!.status, (await w.deps.store.get('mem_b', GLOBAL))!.status]).toEqual(['active', 'active'])
    }
  })
})

describe('并成版本', () => {
  async function missed(w: World) {
    const old = await seed(w, 'mem_a', { content: '服务监听 8100', createdAt: T0 - 9000 })
    const current = await seed(w, 'mem_b', { content: '服务监听 8200', stateSince: T0 + 500 })
    const entry = await report(w, 'missed-change', [old, current])
    return { old, current, entry }
  }

  it('旧状态那条软删并记下去向，当前页不写；读当前页的历史能看到它；条目结清并留着回执；同样引用旧那条的条目一并清掉', async () => {
    const w = world()
    const { old, current, entry } = await missed(w)
    const c = await seed(w, 'mem_c')
    await report(w, 'conflict', [old, c])
    const r = await resolve(w, entry.id, 'as-versions', 'mem_b')
    expect(r).toMatchObject({ kind: 'resolved', verdict: 'as-versions', alsoCleared: 1 })
    const after = (await w.deps.store.get('mem_a', GLOBAL))!
    expect(after.status).toBe('deleted')
    expect(mergedIntoOf(after)).toMatchObject({ id: 'mem_b', as: 'version' })
    expect((await w.deps.store.get('mem_b', GLOBAL))!.content).toBe(current.content)
    const history = await historyWithMerged(w.deps.store, (await w.deps.store.locate('mem_b', GLOBAL))!)
    expect(history.versions.map(v => [v.mergedFrom ?? null, v.record.content])).toEqual([['mem_a', '服务监听 8100']])
    expect(await w.deps.decisions.list()).toEqual([])
    const [settled] = await w.deps.decisions.listSettled()
    expect(settled).toMatchObject({ id: entry.id, kind: 'missed-change', settled: { verdict: 'as-versions' } })
    expect(settled!.changes?.length ?? 0).toBeGreaterThan(0)
  })

  it('撤销：旧状态那条回来，条目回到待处理', async () => {
    const w = world()
    const { entry } = await missed(w)
    expect(await resolve(w, entry.id, 'as-versions', 'mem_b')).toMatchObject({ kind: 'resolved' })
    w.clock.now += 1000
    const undone = await executeUndo({ decisionId: entry.id }, ctx, { ...w.deps, ignores: { unignoreIfSame: async () => false }, now: () => w.clock.now })
    expect(undone).toMatchObject({ kind: 'undone' })
    const back = (await w.deps.store.get('mem_a', GLOBAL))!
    expect(back.status).toBe('active')
    expect(mergedIntoOf(back)).toBeUndefined()
    expect((await w.deps.decisions.get(entry.id))?.kind).toBe('missed-change')
  })

  it('并成版本之后旧状态那条被恢复成在用、内容没变：同一对再报时同一条目回到待处理，不带旧回执；之后能再裁一次', async () => {
    const w = world()
    const { old, current, entry } = await missed(w)
    expect(await resolve(w, entry.id, 'as-versions', 'mem_b')).toMatchObject({ kind: 'resolved', verdict: 'as-versions' })
    const firstReceipts = (await w.deps.decisions.listSettled())[0]!.changes!.length
    expect(firstReceipts).toBeGreaterThan(0)
    expect((await w.deps.store.get('mem_a', GLOBAL))!.status).toBe('deleted')
    // 不经撤销，用别的办法把旧那条放回在用，内容不变
    await w.deps.store.update((await w.deps.store.get('mem_a', GLOBAL))!, ({ mergedInto: _m, deletedAt: _d, ...cur }) => ({ ...cur, status: 'active' }))
    const back = (await w.deps.store.get('mem_a', GLOBAL))!
    expect([back.status, back.content]).toEqual(['active', old.content])
    w.clock.now += 1000
    const again = await w.deps.decisions.upsert({
      kind: 'missed-change', memoryIds: ['mem_a', 'mem_b'], summary: '体检又报了', workspaces: ['global', 'global'],
      fingerprint: conflictFingerprint([back, current]),
    }, w.clock.now, id => w.deps.store.get(id, GLOBAL))
    expect(again).toMatchObject({ created: false, entry: { id: entry.id } })
    expect(again.settled).toBeUndefined()
    const reopened = (await w.deps.decisions.get(entry.id))!
    expect(reopened).toMatchObject({ id: entry.id, kind: 'missed-change' })
    expect(reopened).not.toHaveProperty('settled')
    expect(reopened).not.toHaveProperty('changes')
    // 再走一步：回到待处理的条目照常能并成版本，回执只有这一次的
    expect(await resolve(w, entry.id, 'as-versions', 'mem_b')).toMatchObject({ kind: 'resolved', verdict: 'as-versions' })
    expect((await w.deps.store.get('mem_a', GLOBAL))!.status).toBe('deleted')
    expect((await w.deps.decisions.listSettled())[0]!.changes).toHaveLength(firstReceipts)
  })

  it('横向冲突也能并成版本，留作当前的可以是左边那条', async () => {
    const w = world()
    const pair = [await seed(w, 'mem_a'), await seed(w, 'mem_b')]
    const entry = await report(w, 'conflict', pair)
    expect(await resolve(w, entry.id, 'as-versions', 'mem_a')).toMatchObject({ kind: 'resolved', verdict: 'as-versions' })
    expect(mergedIntoOf((await w.deps.store.get('mem_b', GLOBAL))!)).toMatchObject({ id: 'mem_a', as: 'version' })
    expect((await w.deps.store.get('mem_a', GLOBAL))!.status).toBe('active')
  })

  it('没给留作当前的那条、给的不在这一对里、纵向冲突：回 invalid-args，什么都不动', async () => {
    const w = world()
    const { entry } = await missed(w)
    const vertical = await report(w, 'conflict', [await seed(w, 'mem_v')], { baselineRef: 'AGENTS.md：端口' })
    const before = [await w.pending.get(entry.id), await w.pending.get(vertical.id)]
    expect(await resolve(w, entry.id, 'as-versions')).toMatchObject({ kind: 'error', code: 'invalid-args' })
    expect(await resolve(w, entry.id, 'as-versions', 'mem_v')).toMatchObject({ kind: 'error', code: 'invalid-args' })
    expect(await resolve(w, vertical.id, 'as-versions', 'mem_v')).toMatchObject({ kind: 'error', code: 'invalid-args' })
    expect([await w.pending.get(entry.id), await w.pending.get(vertical.id)]).toEqual(before)
    expect((await w.deps.store.get('mem_a', GLOBAL))!.status).toBe('active')
    expect((await w.deps.store.get('mem_v', GLOBAL))!.status).toBe('active')
  })

  it('报出之后有一条被改过或不在用了：回 stale，什么都不动', async () => {
    const edited = world()
    const a = await missed(edited)
    await edited.deps.store.update(a.current, cur => ({ ...cur, content: '服务监听 8300' }))
    expect(await resolve(edited, a.entry.id, 'as-versions', 'mem_b')).toMatchObject({ kind: 'error', code: 'stale' })
    expect((await edited.deps.store.get('mem_a', GLOBAL))!.status).toBe('active')
    expect((await edited.deps.decisions.get(a.entry.id))).toBeDefined()

    const gone = world()
    const b = await missed(gone)
    await gone.deps.store.update(b.current, cur => ({ ...cur, status: 'deleted' }))
    expect(await resolve(gone, b.entry.id, 'as-versions', 'mem_b')).toMatchObject({ kind: 'error', code: 'stale' })
    expect((await gone.deps.store.get('mem_a', GLOBAL))!.status).toBe('active')
    expect((await gone.deps.decisions.get(b.entry.id))).toBeDefined()
  })

  it('旧状态那条含高危密钥：软删不了，回错误说明改用删除，什么都不动', async () => {
    const w = world()
    const old = await seed(w, 'mem_a', { content: `旧的 ${FAKE_SECRET.sk}` })
    const current = await seed(w, 'mem_b')
    const entry = await report(w, 'missed-change', [old, current])
    const r = await resolve(w, entry.id, 'as-versions', 'mem_b')
    expect(r.kind).toBe('error')
    expect(r.kind === 'error' ? r.message : '').toContain('密钥')
    expect(r.kind === 'error' ? r.message : '').toContain('memory_forget')
    expect((await w.deps.store.get('mem_a', GLOBAL))!.status).toBe('active')
    expect(await w.deps.decisions.get(entry.id)).toBeDefined()
  })

  it('这一对正被别处处理（认领着）：回 claimed，什么都不动', async () => {
    const w = world()
    const { entry } = await missed(w)
    const held = await w.deps.decisions.withPairClaim(entry, () => resolve(w, entry.id, 'as-versions', 'mem_b'))
    expect(held).toMatchObject({ isClaimed: true, value: { kind: 'error', code: 'claimed' } })
    expect((await w.deps.store.get('mem_a', GLOBAL))!.status).toBe('active')
    expect(await w.deps.decisions.get(entry.id)).toBeDefined()
  })
})
