import { describe, expect, it } from 'vitest'
import { scoreLayer, listWorkspaces, layerCacheKey, GLOBAL_CACHE_KEY, type LayerHealthDeps } from '../src/governance/layer-health.ts'
import { MemoryStore, InMemoryTable } from '../src/store.ts'
import { PendingDecisionsStore } from '../src/governance/decisions.ts'
import { InMemoryKvTable } from '../src/kv-table.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'
import { workspaceDirName } from '../src/storage/paths.ts'
import type { PendingDecision, ScanCacheEntry, Finding } from '../src/governance/schema.ts'
import { record } from './helpers/record.ts'

function semantic(type: Finding['type'], memoryIds: string[]): Finding {
  return { type, layer: 'semantic', severity: 'info', memoryIds, summary: '', suggestedAction: '' }
}

function makeDeps(): LayerHealthDeps {
  return {
    store: new MemoryStore(new InMemoryTable()),
    registry: buildTypeRegistry({ template: 'coding', customTypes: {} }),
    decisions: new PendingDecisionsStore(new InMemoryKvTable<PendingDecision>()),
    cache: new InMemoryKvTable<ScanCacheEntry>(),
  }
}

describe('listWorkspaces', () => {
  it('枚举库里实际存在记忆的 workspace（去重排序），global 与 deleted 不算', async () => {
    const deps = makeDeps()
    await deps.store.put(record({ scope: 'workspace', workspacePath: '/b' }))
    await deps.store.put(record({ scope: 'workspace', workspacePath: '/a' }))
    await deps.store.put(record({ scope: 'workspace', workspacePath: '/a' }))
    await deps.store.put(record({ scope: 'global' }))
    await deps.store.put(record({ scope: 'workspace', workspacePath: '/c', status: 'deleted' }))
    expect(listWorkspaces(deps.store)).toEqual(['/a', '/b'])
  })
})

describe('layerCacheKey', () => {
  it('workspace 桶按路径，global 层独立桶', () => {
    expect(layerCacheKey({ kind: 'workspace', path: '/p' })).toBe('cache_/p')
    expect(layerCacheKey({ kind: 'global' })).toBe(GLOBAL_CACHE_KEY)
  })
})

describe('scoreLayer 归属规则', () => {
  it('语义 finding 计"全员存活且任一方属本层"——纯 global 不进 ws 层，跨层条目归 ws 层', async () => {
    const deps = makeDeps()
    await deps.store.put(record({ id: 'mem_w1', scope: 'workspace', workspacePath: '/p' }))
    await deps.store.put(record({ id: 'mem_w2', scope: 'workspace', workspacePath: '/p' }))
    await deps.store.put(record({ id: 'mem_g1' }))
    await deps.store.put(record({ id: 'mem_g2' }))
    // ws 桶的语义输入是 visible（含 global），缓存里混着三类发现
    await deps.cache.put('cache_/p', {
      id: 'cache_/p', scannedAt: 100, scope: '/p',
      findings: [
        semantic('redundancy', ['mem_w1', 'mem_w2']),   // 纯 ws → 计
        semantic('redundancy', ['mem_g1', 'mem_g2']),   // 纯 global → 不计（global 层自己算）
        semantic('unclear', ['mem_w1', 'mem_g1']),      // 跨层 → 归 ws 层（global 桶看不到 ws 侧，此处不计则两层失明）
        semantic('unclear', ['mem_w2', 'mem_gone']),    // 引用已消失记忆 → 不计（全员存活不满足）
      ],
    })
    const r = scoreLayer(deps, { kind: 'workspace', path: '/p' }, 200)
    expect(r.health.counts.redundancy).toBe(1)
    expect(r.health.counts.unclear).toBe(1)
    expect(r.records.map(x => x.id).sort()).toEqual(['mem_w1', 'mem_w2'])
  })

  it('conflict 计"任一方属于本层"，且必须仍在待决账本（裁决后即时回血）', async () => {
    const deps = makeDeps()
    await deps.store.put(record({ id: 'mem_w', scope: 'workspace', workspacePath: '/p' }))
    await deps.store.put(record({ id: 'mem_g' }))
    await deps.cache.put('cache_/p', {
      id: 'cache_/p', scannedAt: 100, scope: '/p',
      findings: [semantic('conflict', ['mem_w', 'mem_g'])],
    })
    // 未挂账（已被裁决 keep-both/dismiss）：不计
    expect(scoreLayer(deps, { kind: 'workspace', path: '/p' }, 200).health.counts.conflict).toBe(0)
    // 挂账中：跨层冲突归 ws 层（污染的是该 ws 的会话）
    await deps.decisions.upsert({ memoryIds: ['mem_w', 'mem_g'], summary: '' }, 100)
    expect(scoreLayer(deps, { kind: 'workspace', path: '/p' }, 200).health.counts.conflict).toBe(1)
  })

  it('global 层用 global-only 集合与独立桶，misplaced 走重 cap', async () => {
    const deps = makeDeps()
    for (const id of ['mem_g1', 'mem_g2', 'mem_g3']) await deps.store.put(record({ id }))
    await deps.store.put(record({ id: 'mem_w', scope: 'workspace', workspacePath: '/p' }))
    await deps.cache.put(GLOBAL_CACHE_KEY, {
      id: GLOBAL_CACHE_KEY, scannedAt: 100, scope: 'global',
      findings: [
        semantic('misplaced', ['mem_g1']),
        semantic('misplaced', ['mem_g2']),
        semantic('misplaced', ['mem_g3']),
      ],
    })
    const r = scoreLayer(deps, { kind: 'global' }, 200)
    expect(r.records).toHaveLength(3)
    // 3 条且 100% 占比 → 进度满格 → global 层 misplaced cap 10（ws 层是 6）
    expect(r.health.semanticPenalty).toBeCloseTo(10)
  })

  it('malformed 按文件路径归层：只算本层目录下的隔离文件', async () => {
    const deps: LayerHealthDeps = {
      ...makeDeps(),
      memoryRoot: '/root',
      getQuarantined: () => [
        { path: `/root/global/bad1.md`, error: 'x' },
        { path: `/root/${workspaceDirName('/p')}/bad2.md`, error: 'x' },
      ],
    }
    expect(scoreLayer(deps, { kind: 'global' }, 200).health.counts.malformed).toBe(1)
    expect(scoreLayer(deps, { kind: 'workspace', path: '/p' }, 200).health.counts.malformed).toBe(1)
    // 无 memoryRoot 时不归层，两层都不计（避免同一文件跨层重复扣分）
    const noRoot = { ...makeDeps(), getQuarantined: deps.getQuarantined }
    expect(scoreLayer(noRoot, { kind: 'global' }, 200).health.counts.malformed).toBe(0)
  })

  it('提升候选只在 workspace 层计数', async () => {
    const deps = makeDeps()
    await deps.store.put(record({ id: 'mem_c', scope: 'workspace', workspacePath: '/p', globalCandidate: true }))
    await deps.store.put(record({ id: 'mem_n', scope: 'workspace', workspacePath: '/p' }))
    expect(scoreLayer(deps, { kind: 'workspace', path: '/p' }, 200).promoteCandidates).toBe(1)
    expect(scoreLayer(deps, { kind: 'global' }, 200).promoteCandidates).toBe(0)
  })
})
