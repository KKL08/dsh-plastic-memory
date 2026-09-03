import { describe, expect, it } from 'vitest'
import { executeScan, type ScanToolDeps } from '../src/tools/scan.ts'
import { executeHealth, type HealthToolDeps } from '../src/tools/health.ts'
import { GLOBAL_CACHE_KEY } from '../src/governance/layer-health.ts'
import { MemoryStore, InMemoryTable } from '../src/store.ts'
import { PendingDecisionsStore } from '../src/governance/decisions.ts'
import { InMemoryKvTable } from '../src/kv-table.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'
import type { PendingDecision, ScanCacheEntry, Finding } from '../src/governance/schema.ts'
import { record } from './helpers/record.ts'
import { DAY } from './helpers/clock.ts'

const NOW = 100 * DAY

function semantic(type: Finding['type'], memoryIds: string[]): Finding {
  return { type, layer: 'semantic', severity: 'info', memoryIds, summary: '', suggestedAction: '' }
}

/** 从同一套存储/账本/缓存构造两个工具的 deps，用来验证两者对同一层算出的聚合完全一致。 */
function sharedDeps(store: MemoryStore, decisions: PendingDecisionsStore, cache: InMemoryKvTable<ScanCacheEntry>) {
  const shared = { store, registry: buildTypeRegistry({ template: 'coding', customTypes: {} }), decisions, cache }
  const scanDeps: ScanToolDeps = {
    ...shared,
    getBaseline: () => null,
    getLlm: (_exec: unknown) => null,
    resolveContext: async () => ({ workspacePath: undefined }),
    now: () => NOW,
  }
  const healthDeps: HealthToolDeps = {
    ...shared,
    thresholds: { actionScoreThreshold: 70, pendingOverdueDays: 7, scanStaleDays: 7 },
    resolveContext: async () => ({ workspacePath: undefined }),
    now: () => NOW,
  }
  return { scanDeps, healthDeps }
}

describe('体检聚合：scan 与 health 对同一层同口径（提取前先钉住行为）', () => {
  it('issueSummary：非零计数按 FINDING_TYPES 顺序、超期后缀、空层显示破折号，两工具一致', async () => {
    const store = new MemoryStore(new InMemoryTable())
    const decisions = new PendingDecisionsStore(new InMemoryKvTable<PendingDecision>())
    const cache = new InMemoryKvTable<ScanCacheEntry>()

    // global 层：三条 preference（decayDays=null，不参与新鲜度）+ 一条超期 knowledge
    await store.put(record({ id: 'mem_g1', type: 'preference' }))
    await store.put(record({ id: 'mem_g2', type: 'preference' }))
    await store.put(record({ id: 'mem_g3', type: 'preference' }))
    await store.put(record({ id: 'mem_g4', type: 'knowledge', lastConfirmedAt: 1 })) // 超期
    // 缓存里的语义发现故意乱序放入，输出必须按 FINDING_TYPES 归位
    await cache.put(GLOBAL_CACHE_KEY, {
      id: GLOBAL_CACHE_KEY, scannedAt: 1, scope: 'global',
      findings: [
        semantic('unclear', ['mem_g1', 'mem_g2']),
        semantic('misplaced', ['mem_g2', 'mem_g3']),
        semantic('redundancy', ['mem_g1', 'mem_g3']),
        semantic('conflict', ['mem_g1', 'mem_g4']),
      ],
    })
    // conflict 须仍在待决账本才计分（纯 global 对，不会进跨层冲突）
    await decisions.upsert({ memoryIds: ['mem_g1', 'mem_g4'], summary: '' }, 1)

    // /p：仅一条超期记忆 → 只出超期后缀；/q：一条 preference → 空层破折号
    await store.put(record({ id: 'mem_wp', type: 'knowledge', scope: 'workspace', workspacePath: '/p', lastConfirmedAt: 1 }))
    await store.put(record({ id: 'mem_wq', type: 'preference', scope: 'workspace', workspacePath: '/q' }))

    const { scanDeps, healthDeps } = sharedDeps(store, decisions, cache)
    const h = await executeHealth({ scope: 'all' }, healthDeps, {})
    const s = await executeScan({ scope: 'all' }, scanDeps, {})
    if (h.kind !== 'checkup' || s.kind !== 'checkup') throw new Error('expected checkup')

    const expected = ['conflict 1、redundancy 1、misplaced 1、unclear 1、超期 1', '超期 1', '—']
    expect(h.rows.map(r => r.issueSummary)).toEqual(expected)
    expect(s.rows.map(r => r.issueSummary)).toEqual(expected)
    // 两工具行顺序一致（global, /p, /q）且 issueSummary 逐行相等
    expect(s.rows.map(r => r.issueSummary)).toEqual(h.rows.map(r => r.issueSummary))
  })

  it('跨层冲突聚合：首个 global/首个 workspace、workspaces 排序、decisionIds 按 firstSeenAt、忽略单侧，两工具一致', async () => {
    const store = new MemoryStore(new InMemoryTable())
    const decisions = new PendingDecisionsStore(new InMemoryKvTable<PendingDecision>())
    const cache = new InMemoryKvTable<ScanCacheEntry>()

    for (const id of ['mem_gX', 'mem_gY', 'mem_gZ']) await store.put(record({ id }))
    await store.put(record({ id: 'mem_wA', scope: 'workspace', workspacePath: '/a' }))
    await store.put(record({ id: 'mem_wB', scope: 'workspace', workspacePath: '/b' }))
    await store.put(record({ id: 'mem_wC', scope: 'workspace', workspacePath: '/c' }))
    await store.put(record({ id: 'mem_wD', scope: 'workspace', workspacePath: '/d' }))

    // memoryIds 多于两员：取首个 global(mem_gX，非 mem_gY)、首个 workspace(mem_wB，非 mem_wA)
    const dMulti = await decisions.upsert({ memoryIds: ['mem_gX', 'mem_gY', 'mem_wB', 'mem_wA'], summary: '' }, 300)
    // 同一 global 的第二个反对方(/c)，firstSeenAt 更早 → list() 排在前 → decisionIds 先于 dMulti
    const dSecond = await decisions.upsert({ memoryIds: ['mem_gX', 'mem_wC'], summary: '' }, 100)
    // 无 global 侧、无 workspace 侧 → 忽略
    await decisions.upsert({ memoryIds: ['mem_wA', 'mem_wD'], summary: '' }, 400)
    await decisions.upsert({ memoryIds: ['mem_gY', 'mem_gZ'], summary: '' }, 500)
    // 只被一个 workspace 反对 → 不上报（须 ≥2 个不同 workspace）
    await decisions.upsert({ memoryIds: ['mem_gZ', 'mem_wA'], summary: '' }, 600)

    const { scanDeps, healthDeps } = sharedDeps(store, decisions, cache)
    const h = await executeHealth({ scope: 'all' }, healthDeps, {})
    const s = await executeScan({ scope: 'all', layers: 'rule' }, scanDeps, {})
    if (h.kind !== 'checkup' || s.kind !== 'checkup') throw new Error('expected checkup')

    const expected = [{
      globalId: 'mem_gX',
      workspaces: ['/b', '/c'],
      decisionIds: [dSecond.entry.id, dMulti.entry.id],
    }]
    expect(h.crossLayerConflicts).toEqual(expected)
    expect(s.crossLayerConflicts).toEqual(expected)
  })
})
