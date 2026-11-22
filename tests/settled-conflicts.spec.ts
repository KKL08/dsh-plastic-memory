import { describe, expect, it } from 'vitest'
import { fakeExec } from './helpers/exec.ts'
import { executeScan, type ScanToolDeps, type SingleScanResult } from '../src/tools/scan.ts'
import { executeConfirm } from '../src/tools/confirm.ts'
import { MemoryStore } from '../src/store.ts'
import { PendingDecisionsStore } from '../src/governance/decisions.ts'
import { SnapshotStore } from '../src/governance/snapshots.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'
import type { MemorySnapshot, PendingDecision, ScanCacheEntry } from '../src/governance/schema.ts'
import { record } from './helpers/record.ts'
import { InMemoryTable } from './helpers/in-memory-table.ts'
import { InMemoryKvTable, InMemoryBatchKvTable } from './helpers/in-memory-kv.ts'
import { instructionsOf, noInstructions } from './helpers/instructions.ts'

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

function makeEnv({ host, ...overrides }: Partial<Omit<ScanToolDeps, 'host'>> & { host?: Partial<ScanToolDeps['host']> } = {}) {
  const store = new MemoryStore(new InMemoryTable(), undefined, new InMemoryBatchKvTable())
  const decisions = new PendingDecisionsStore(new InMemoryKvTable<PendingDecision>())
  const snapshots = new SnapshotStore(new InMemoryKvTable<MemorySnapshot>())
  const scanDeps: ScanToolDeps = {
    store, decisions,
    registry: buildTypeRegistry({ template: 'coding', customTypes: {} }),
    cache: new InMemoryKvTable<ScanCacheEntry>(),
    instructions: noInstructions, host: { contextOf: async () => ({ workspacePath: undefined }), llmOf: () => horizontalLlm, ...host },
    now: () => 9000,
    ...overrides,
  }
  const scan = async (): Promise<SingleScanResult> => {
    const r = await executeScan({}, scanDeps, fakeExec())
    if (r.kind !== 'single') throw new Error(`expected single, got ${r.kind}`)
    return r
  }
  const resolve = (decisionId: string, verdict: 'keep-left' | 'keep-right' | 'keep-both' | 'dismiss') =>
    executeConfirm({ action: 'resolve', decisionId, verdict }, { workspacePath: undefined }, { instructions: noInstructions, store, decisions, snapshots, now: () => 9500 })
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
    // mem_v 是全局记忆，对照全局层的指令文件
    let baseline = '# AGENTS.md\n用 pnpm'
    const env = makeEnv({ host: { llmOf: (_exec: unknown) => llm }, instructions: instructionsOf({ global: () => baseline }) })
    const llm = verticalLlm()
    await env.store.put(record({ id: 'mem_v', content: '这个项目用 npm' }))
    const first = await env.scan()
    await env.resolve(first.pendingDecisions.items[0].id, 'keep-left')

    const again = await env.scan()
    expect(again.pendingDecisions.items).toHaveLength(0)
    expect(conflicts(again)).toHaveLength(0)

    baseline = '# AGENTS.md\n用 pnpm，禁止 npm'
    const changed = await env.scan()
    expect(changed.pendingDecisions.created).toBe(1)
  })
})
