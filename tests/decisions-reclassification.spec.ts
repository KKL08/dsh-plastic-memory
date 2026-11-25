import { describe, expect, it } from 'vitest'
import { PendingDecisionsStore, suggestionBasis } from '../src/governance/decisions.ts'
import { kindOf, type PendingDecision, type StoredSuggestion } from '../src/governance/schema.ts'
import { InMemoryKvTable } from './helpers/in-memory-kv.ts'
import { record } from './helpers/record.ts'

const input = { memoryIds: ['mem_a', 'mem_b'], summary: '原冲突', fingerprint: 'same', workspaces: ['global', 'global'] }
function env() {
  const table = new InMemoryKvTable<PendingDecision>()
  return { table, decisions: new PendingDecisionsStore(table) }
}

describe('未决配对发现原地改判', () => {
  it('未决冲突改成漏记的变化，沿用条目并换成这次方案和依据', async () => {
    const { decisions } = env()
    const first = await decisions.upsert(input, 100)
    const next = await decisions.upsert({ ...input, kind: 'missed-change', summary: '前后状态', fingerprint: 'new',
      memberScanFingerprints: { a: 'new-a' }, plan: { kind: 'as-versions', current: 'mem_b' }, sourceCheck: 'checked' }, 200)
    expect(next.created).toBe(false)
    expect(await decisions.list()).toEqual([{ ...first.entry, kind: 'missed-change', summary: '前后状态', fingerprint: 'new',
      memberScanFingerprints: { a: 'new-a' }, plan: { kind: 'as-versions', current: 'mem_b' }, sourceCheck: 'checked' }])
  })

  it('漏记的变化改回冲突，沿用条目并去掉旧方案和回查标记', async () => {
    const { decisions } = env()
    const first = await decisions.upsert({ ...input, kind: 'missed-change', plan: { kind: 'as-versions', current: 'mem_b' }, sourceCheck: 'checked' }, 100)
    const next = await decisions.upsert({ ...input, summary: '确实矛盾' }, 200)
    expect(next.created).toBe(false)
    expect(next.entry.id).toBe(first.entry.id)
    expect(kindOf(next.entry)).toBe('conflict')
    expect(next.entry).not.toHaveProperty('plan')
    expect(next.entry).not.toHaveProperty('sourceCheck')
    expect(await decisions.list()).toEqual([next.entry])
  })

  it('冲突改判时清掉模型建议、失败原因和尝试次数，改回也不恢复旧建议', async () => {
    const { table, decisions } = env()
    const first = await decisions.upsert(input, 100)
    const basis = { conflictFingerprint: 'same', memories: [] }
    await table.put(first.entry.id, { ...first.entry,
      suggestion: { id: 's', action: 'keep-a', reason: '旧建议', ops: [], basis, isSourced: false, generatedAt: 100 },
      suggestionFailure: { basis, cause: { kind: 'undecided' }, at: 100 }, suggestionAttempts: { fingerprint: 'same', count: 2 } })
    const next = await decisions.upsert({ ...input, kind: 'exception' }, 200)
    expect(next.entry.id).toBe(first.entry.id)
    expect(kindOf(next.entry)).toBe('exception')
    for (const key of ['suggestion', 'suggestionFailure', 'suggestionAttempts']) expect(await decisions.get(first.entry.id)).not.toHaveProperty(key)
    const back = await decisions.upsert(input, 300)
    expect(back.entry.id).toBe(first.entry.id)
    expect(back.entry).not.toHaveProperty('suggestion')
  })

  it('改判期间生成的旧冲突建议返回后不再写入条目', async () => {
    const { decisions } = env()
    const first = await decisions.upsert(input, 100)
    const records = [record({ id: 'mem_a' }), record({ id: 'mem_b' })]
    const suggestion: StoredSuggestion = { id: 's', action: 'keep-a', reason: '旧建议', ops: [],
      basis: suggestionBasis(first.entry, records), isSourced: false, generatedAt: 100 }
    await decisions.upsert({ ...input, kind: 'missed-change' }, 200)
    expect(await decisions.writeSuggestion(first.entry.id, { suggestion }, async id => records.find(r => r.id === id))).toBe('gone')
    expect(await decisions.get(first.entry.id)).not.toHaveProperty('suggestion')
  })

  it('三种排除裁决结清的配对照旧抑制跨种类重报', async () => {
    for (const verdict of ['not-conflict', 'exception', 'keep-both'] as const) {
      const { decisions } = env()
      const first = await decisions.upsert(input, 100)
      await decisions.settle(first.entry.id, verdict, 200)
      for (const kind of ['conflict', 'missed-change', 'exception'] as const) {
        expect(await decisions.upsert({ ...input, kind }, 300)).toMatchObject({ created: false, settled: true, entry: { id: first.entry.id } })
        expect(await decisions.list()).toEqual([])
      }
    }
  })

  it('已有多种未决副本时保留最早一条，依据已变与跨项目重复保持独立', async () => {
    const { table, decisions } = env()
    const first = await decisions.upsert(input, 100)
    await table.put('pd_other', { ...first.entry, id: 'pd_other', kind: 'exception', firstSeenAt: 101 })
    const premise = await decisions.upsert({ ...input, kind: 'premise-changed' }, 100)
    const cross = await decisions.upsert({ ...input, kind: 'cross-duplicate' }, 100)
    const next = await decisions.upsert({ ...input, kind: 'missed-change' }, 200)
    expect(next.entry.id).toBe(first.entry.id)
    expect((await decisions.list()).map(e => e.id).sort()).toEqual([first.entry.id, premise.entry.id, cross.entry.id].sort())
  })
})
