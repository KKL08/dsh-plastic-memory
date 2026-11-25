import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PendingDecisionsStore } from '../src/governance/decisions.ts'
import { SidecarStore } from '../src/storage/sidecar.ts'
import { SnapshotStore } from '../src/governance/snapshots.ts'
import type { MemorySnapshot, PendingDecision } from '../src/governance/schema.ts'
import { executeConfirm } from '../src/tools/confirm.ts'
import type { Scope } from '../src/scope.ts'
import { classify } from '../scripts/conflict-eval/scoring.ts'
import { checkupEnv, type CheckupEnv } from './helpers/checkup-env.ts'
import { findingModel } from './helpers/finding-model.ts'
import { InMemoryKvTable } from './helpers/in-memory-kv.ts'
import { noInstructions } from './helpers/instructions.ts'
import { record } from './helpers/record.ts'
import { loadRelease020Schemas, openRelease020Pending } from './helpers/release-020.ts'
import { sidecarSchemas } from './helpers/sidecar-schemas.ts'

// 和上一个发布版共用记忆根：新种类和新裁决值它解析不了（跳过并记日志，见兼容表），它认得的照读；体检视图它照常能读

const GLOBAL: Scope = { kind: 'global' }
const envs: CheckupEnv[] = []
afterEach(async () => { for (const e of envs.splice(0)) await e.close() })

async function scannedWorld(): Promise<CheckupEnv> {
  const e = await checkupEnv()
  envs.push(e)
  for (const id of ['mem_a', 'mem_b', 'mem_c', 'mem_d', 'mem_e', 'mem_f']) await e.store.put(record({ id, name: `${id} 的名称`, content: `${id} 的正文` }))
  await e.scan({
    llm: findingModel({ findings: [
      { type: 'missed-change', ids: ['mem_a', 'mem_b'], current: 'mem_b' },
      { type: 'exception', ids: ['mem_c', 'mem_d'] },
      { type: 'conflict', ids: ['mem_e', 'mem_f'] },
      { type: 'conflict', ids: ['mem_a', 'mem_e'] },
      { type: 'unclear', ids: ['mem_f'] },
    ] }),
  })
  return e
}
const deps = (e: CheckupEnv) => ({ store: e.store, decisions: e.decisions, snapshots: new SnapshotStore(new InMemoryKvTable<MemorySnapshot>()), instructions: noInstructions, now: () => e.clock.now })
const pairOf = (d: PendingDecision) => [...d.memoryIds].sort().join('+')

describe('上一个发布版读新版写的账本和视图', () => {
  it('新种类的条目、用新裁决值结清的条目它解析不了；两条都留、带新字段的冲突它照读', async () => {
    const e = await scannedWorld()
    const old = await loadRelease020Schemas()
    const open = await e.decisions.list()
    expect(open.map(d => d.kind ?? 'conflict').sort()).toEqual(['conflict', 'conflict', 'exception', 'missed-change'])
    for (const d of open.filter(x => x.kind !== undefined)) expect(old.pendingDecision.safeParse(d).success, d.kind).toBe(false)

    const conflicts = open.filter(d => d.kind === undefined)
    const byPair = new Map(conflicts.map(d => [pairOf(d), d]))
    expect(await executeConfirm({ action: 'resolve', decisionId: byPair.get('mem_e+mem_f')!.id, verdict: 'not-conflict' }, { workspacePath: undefined }, deps(e))).toMatchObject({ kind: 'resolved' })
    expect(await executeConfirm({ action: 'resolve', decisionId: byPair.get('mem_a+mem_e')!.id, verdict: 'keep-both' }, { workspacePath: undefined }, deps(e))).toMatchObject({ kind: 'resolved' })
    const settled = new Map((await e.decisions.listSettled()).map(d => [pairOf(d), d]))
    expect(old.pendingDecision.safeParse(settled.get('mem_e+mem_f')).success).toBe(false)
    expect(old.pendingDecision.safeParse(settled.get('mem_a+mem_e')).success).toBe(true)
    expect(old.pendingDecision.safeParse({ ...settled.get('mem_a+mem_e')!, settled: undefined, plan: { kind: 'as-versions', current: 'mem_a' }, sourceCheck: 'checked' }).success).toBe(true)
  })

  it('它按自己的读法读同一份账本：四种新条目、三个新裁决值结清的条目逐条跳过并记日志；带新字段的冲突、两条都留的照读', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pm-four-findings-compat-'))
    try {
      const quiet = { info() {}, warn() {}, error() {}, debug() {} }
      const decisions = new PendingDecisionsStore(new SidecarStore({ root, schemas: sidecarSchemas, log: quiet }).pending)
      const up = async (input: Parameters<PendingDecisionsStore['upsert']>[0]) => (await decisions.upsert(input, 1)).entry
      const fresh = await up({ memoryIds: ['mem_a', 'mem_b'], summary: '未决冲突', fingerprint: 'fp1', sourceCheck: 'unchecked' })
      const keptBoth = await up({ memoryIds: ['mem_c', 'mem_d'], summary: '两条都留', fingerprint: 'fp2' })
      expect(await decisions.settle(keptBoth.id, 'keep-both', 2)).toBe(true)
      for (const [pair, verdict] of [[['mem_e', 'mem_f'], 'not-conflict'], [['mem_g', 'mem_h'], 'exception'], [['mem_i', 'mem_j'], 'as-versions']] as const) {
        const entry = await up({ memoryIds: [...pair], summary: `用 ${verdict} 结清`, fingerprint: `fp-${verdict}` })
        expect(await decisions.settle(entry.id, verdict, 2), verdict).toBe(true)
      }
      await up({ kind: 'missed-change', memoryIds: ['mem_k', 'mem_l'], summary: '漏记的变化', fingerprint: 'fp3', plan: { kind: 'as-versions', current: 'mem_l' }, sourceCheck: 'checked' })
      await up({ kind: 'exception', memoryIds: ['mem_m', 'mem_n'], summary: '例外提示', fingerprint: 'fp4' })
      await up({ kind: 'premise-changed', memoryIds: ['mem_o', 'mem_p'], summary: '依据已变', fingerprint: 'fp5' })
      await up({ kind: 'cross-duplicate', memoryIds: ['mem_q', 'mem_r', 'mem_s'], summary: '跨项目重复', fingerprint: 'fp6', plan: { kind: 'promote', memoryId: 'mem_r' } })
      // 前提：新版自己全都读得到，新字段确实写下了
      const open = await decisions.list()
      expect(open.map(d => d.kind ?? 'conflict').sort()).toEqual(['conflict', 'cross-duplicate', 'exception', 'missed-change', 'premise-changed'])
      expect(open.find(d => d.id === fresh.id)).toMatchObject({ sourceCheck: 'unchecked' })
      expect(open.find(d => d.kind === 'missed-change')).toMatchObject({ plan: { kind: 'as-versions', current: 'mem_l' }, sourceCheck: 'checked' })
      expect(open.find(d => d.kind === 'cross-duplicate')).toMatchObject({ plan: { kind: 'promote', memoryId: 'mem_r' } })
      expect((await decisions.listSettled()).map(d => d.settled?.verdict).sort()).toEqual(['as-versions', 'exception', 'keep-both', 'not-conflict'])

      const warnings: string[] = []
      const old = await openRelease020Pending({ root, warnings })
      expect((await old.list()).map(([, e]) => e.id).sort()).toEqual([fresh.id, keptBoth.id].sort())
      expect(warnings).toHaveLength(7)
      // 它读过之后新版照读，条目原样留在盘上
      expect((await decisions.list()).length + (await decisions.listSettled()).length).toBe(9)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('体检视图它照常能读：只进账本的发现不写进视图', async () => {
    const e = await scannedWorld()
    expect((await e.decisions.list()).some(d => d.kind === 'missed-change')).toBe(true)
    const view = await e.view(GLOBAL)
    expect((await loadRelease020Schemas()).scanCache.safeParse(view).success).toBe(true)
    expect(view!.findings.map(f => f.type).sort()).toEqual(['conflict', 'conflict', 'unclear'])
  })
})

describe('题集计分', () => {
  it('漏记的变化计作变化，例外照旧计作例外', () => {
    expect(classify([{ type: 'missed-change' }])).toEqual(['change'])
    expect(classify([{ type: 'exception' }, { type: 'missed-change' }, { type: 'conflict' }])).toEqual(['exception', 'change', 'contradiction'])
  })
})
