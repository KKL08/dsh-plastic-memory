import { describe, expect, it } from 'vitest'
import { fakeExec } from './helpers/exec.ts'
import { executeScan, type ScanToolDeps, type SingleScanResult } from '../src/tools/scan.ts'
import { executeConfirm } from '../src/tools/confirm.ts'
import { MemoryStore, InMemoryTable } from '../src/store.ts'
import { PendingDecisionsStore } from '../src/governance/decisions.ts'
import { SnapshotStore } from '../src/governance/snapshots.ts'
import { InMemoryKvTable } from '../src/kv-table.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'
import type { MemorySnapshot, PendingDecision, ScanCacheEntry } from '../src/governance/schema.ts'
import { record } from './helpers/record.ts'

/** 裁决「两条都留」后，体检记住这个结论：两边内容（垂直冲突含基线）都没变就不再报。 */

const horizontalLlm = {
  complete: async () => JSON.stringify({
    findings: [{ type: 'conflict', memoryIds: ['mem_a', 'mem_b'], summary: '互相矛盾', suggestedAction: '请裁决' }],
  }),
}

/** 每次扫描换一种 baselineRef 措辞：LLM 自由填写，不能拿它当身份。 */
function verticalLlm() {
  let n = 0
  return {
    complete: async () => JSON.stringify({
      findings: [{ type: 'conflict', memoryIds: ['mem_v'], baselineRef: `AGENTS.md：包管理（第 ${++n} 次措辞）`, summary: '与基线矛盾', suggestedAction: '裁决' }],
    }),
  }
}

function makeEnv(overrides?: Partial<ScanToolDeps>) {
  const store = new MemoryStore(new InMemoryTable())
  const decisions = new PendingDecisionsStore(new InMemoryKvTable<PendingDecision>())
  const snapshots = new SnapshotStore(new InMemoryKvTable<MemorySnapshot>())
  const scanDeps: ScanToolDeps = {
    store, decisions,
    registry: buildTypeRegistry({ template: 'coding', customTypes: {} }),
    cache: new InMemoryKvTable<ScanCacheEntry>(),
    getBaseline: () => null,
    getLlm: (_exec: unknown) => horizontalLlm,
    resolveContext: async () => ({ workspacePath: undefined }),
    now: () => 9000,
    ...overrides,
  }
  const scan = async (): Promise<SingleScanResult> => {
    const r = await executeScan({}, scanDeps, fakeExec())
    if (r.kind !== 'single') throw new Error(`expected single, got ${r.kind}`)
    return r
  }
  const resolve = (decisionId: string, verdict: 'keep-left' | 'keep-right' | 'keep-both' | 'dismiss') =>
    executeConfirm({ action: 'resolve', decisionId, verdict }, { workspacePath: undefined }, { store, decisions, snapshots, now: () => 9500 })
  return { store, decisions, scan, resolve }
}

const conflicts = (r: SingleScanResult) => r.findings.filter(f => f.type === 'conflict')

describe('裁决过的冲突不再重报', () => {
  for (const verdict of ['keep-both', 'dismiss'] as const) {
    it(`${verdict} 后重扫：两条都没改，不进待决、不出现在 findings，留 note`, async () => {
      const env = makeEnv()
      await env.store.put(record({ id: 'mem_a', content: '用 pnpm' }))
      await env.store.put(record({ id: 'mem_b', content: '用 npm' }))
      const first = await env.scan()
      const r = await env.resolve(first.pendingDecisions.items[0].id, verdict)
      expect(r.kind).toBe('resolved')
      if (r.kind === 'resolved') expect(r.message).toContain('不再报')

      const again = await env.scan()
      expect(again.pendingDecisions.items).toHaveLength(0)
      expect(again.pendingDecisions.created).toBe(0)
      expect(conflicts(again)).toHaveLength(0)
      expect(await env.decisions.list()).toHaveLength(0)
      expect(again.notes.map(n => n.code)).toContain('conflicts-settled')
    })
  }

  it('其中一条改写后重扫：重新报为新冲突', async () => {
    const env = makeEnv()
    await env.store.put(record({ id: 'mem_a', content: '用 pnpm' }))
    await env.store.put(record({ id: 'mem_b', content: '用 npm' }))
    const first = await env.scan()
    await env.resolve(first.pendingDecisions.items[0].id, 'keep-both')

    await env.store.put(record({ id: 'mem_b', content: '新项目用 npm，老项目照旧' }))
    const again = await env.scan()
    expect(again.pendingDecisions.created).toBe(1)
    expect(again.pendingDecisions.items[0].isNew).toBe(true)
    expect(conflicts(again)).toHaveLength(1)
    expect(await env.decisions.list()).toHaveLength(1)
  })

  it('垂直冲突 keep-left 后：baselineRef 措辞变了也不再报；基线改了才重新报', async () => {
    let baseline = ['# AGENTS.md\n用 pnpm']
    const env = makeEnv({ getLlm: (_exec: unknown) => llm, getBaseline: () => baseline })
    const llm = verticalLlm()
    await env.store.put(record({ id: 'mem_v', content: '这个项目用 npm' }))
    const first = await env.scan()
    await env.resolve(first.pendingDecisions.items[0].id, 'keep-left')

    const again = await env.scan()
    expect(again.pendingDecisions.items).toHaveLength(0)
    expect(conflicts(again)).toHaveLength(0)

    baseline = ['# AGENTS.md\n用 pnpm，禁止 npm']
    const changed = await env.scan()
    expect(changed.pendingDecisions.created).toBe(1)
  })

  it('删掉一方的裁决（keep-left 横向）照旧：败方已删，不留记录', async () => {
    const env = makeEnv()
    await env.store.put(record({ id: 'mem_a', content: '用 pnpm' }))
    await env.store.put(record({ id: 'mem_b', content: '用 npm' }))
    const first = await env.scan()
    await env.resolve(first.pendingDecisions.items[0].id, 'keep-left')
    expect((await env.store.get('mem_b'))!.status).toBe('deleted')
    expect(await env.decisions.list()).toHaveLength(0)
  })
})

describe('PendingDecisionsStore 的已裁决条目', () => {
  it('已裁决条目对 get / list 不可见；removeByMemoryIds 一并清掉但只计未决条目', async () => {
    const s = new PendingDecisionsStore(new InMemoryKvTable<PendingDecision>())
    const { entry } = await s.upsert({ memoryIds: ['mem_a', 'mem_b'], summary: '1', fingerprint: 'fp1' }, 1)
    expect(await s.settle(entry.id, 'keep-both', 2)).toBe(true)
    await s.upsert({ memoryIds: ['mem_a', 'mem_c'], summary: '2', fingerprint: 'fp2' }, 3)
    expect(await s.get(entry.id)).toBeUndefined()
    expect((await s.list()).map(e => e.summary)).toEqual(['2'])
    expect(await s.removeByMemoryIds(['mem_a'])).toBe(1)
    const again = await s.upsert({ memoryIds: ['mem_a', 'mem_b'], summary: '1', fingerprint: 'fp1' }, 4)
    expect(again.created).toBe(true)
  })

  it('旧条目没有指纹：settle 退回直接移除，返回 false', async () => {
    const s = new PendingDecisionsStore(new InMemoryKvTable<PendingDecision>())
    const { entry } = await s.upsert({ memoryIds: ['mem_a', 'mem_b'], summary: '旧' }, 1)
    expect(await s.settle(entry.id, 'dismiss', 2)).toBe(false)
    const again = await s.upsert({ memoryIds: ['mem_a', 'mem_b'], summary: '旧' }, 3)
    expect(again.created).toBe(true)
  })
})
