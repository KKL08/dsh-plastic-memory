import { describe, expect, it } from 'vitest'
import { scoreScope, listWorkspaces, GLOBAL_CACHE_KEY, type ScopeHealthDeps } from '../src/governance/scope-health.ts'
import { prereadScopes } from '../src/tools/scope-preread.ts'
import { scopeCacheKey, type Scope } from '../src/scope.ts'
import { MemoryStore, InMemoryTable } from '../src/store.ts'
import { InMemoryKvTable } from '../src/kv-table.ts'
import { FileTable } from '../src/storage/file-table.ts'
import type { RecallStats } from '../src/storage/schema.ts'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PendingDecisionsStore } from '../src/governance/decisions.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'
import { workspaceDirName, GLOBAL_DIR, WORKSPACE_MARKER } from '../src/storage/paths.ts'
import type { PendingDecision, ScanCacheEntry, Finding } from '../src/governance/schema.ts'
import { record } from './helpers/record.ts'

function semantic(type: Finding['type'], memoryIds: string[]): Finding {
  return { type, layer: 'semantic', severity: 'info', memoryIds, summary: '', suggestedAction: '' }
}

/** 评分只吃预读数据；夹具保留存储，score() 经执行器同款预读后再评分。 */
interface Fixture extends ScopeHealthDeps {
  store: MemoryStore
  decisions: PendingDecisionsStore
  cache: InMemoryKvTable<ScanCacheEntry>
}

function makeDeps(): Fixture {
  return {
    store: new MemoryStore(new InMemoryTable()),
    registry: buildTypeRegistry({ template: 'coding', customTypes: {} }),
    decisions: new PendingDecisionsStore(new InMemoryKvTable<PendingDecision>()),
    cache: new InMemoryKvTable<ScanCacheEntry>(),
  }
}

/** 与 memory_health 单个作用域同一预读范围：项目连同 global 一起读，全局只读自己。 */
async function score(deps: Fixture, scope: Scope, now: number) {
  const scopes: Scope[] = scope.kind === 'workspace' ? [scope, { kind: 'global' }] : [scope]
  return scoreScope(deps, await prereadScopes(deps, scopes, scope.kind === 'workspace' ? scope.workspacePath : undefined), scope, now)
}

describe('listWorkspaces', () => {
  it('枚举库里实际存在记忆的 workspace（去重排序），global 与 deleted 不算', async () => {
    const deps = makeDeps()
    await deps.store.put(record({ scope: 'workspace', workspacePath: '/b' }))
    await deps.store.put(record({ scope: 'workspace', workspacePath: '/a' }))
    await deps.store.put(record({ scope: 'workspace', workspacePath: '/a' }))
    await deps.store.put(record({ scope: 'global' }))
    await deps.store.put(record({ scope: 'workspace', workspacePath: '/c', status: 'deleted' }))
    expect(listWorkspaces(await deps.store.query({ status: ['active', 'superseded', 'deleted'] }))).toEqual(['/a', '/b'])
  })
})

describe('scopeCacheKey', () => {
  it('workspace 按路径取缓存键，全局单独一个', () => {
    expect(scopeCacheKey({ kind: 'workspace', workspacePath: '/p' })).toBe('cache_/p')
    expect(scopeCacheKey({ kind: 'global' })).toBe(GLOBAL_CACHE_KEY)
  })
})

describe('scoreScope 归属规则', () => {
  it('语义 finding 计"全员存活且任一方属本作用域"——纯 global 不进 ws，跨作用域的条目归 ws', async () => {
    const deps = makeDeps()
    await deps.store.put(record({ id: 'mem_w1', scope: 'workspace', workspacePath: '/p' }))
    await deps.store.put(record({ id: 'mem_w2', scope: 'workspace', workspacePath: '/p' }))
    await deps.store.put(record({ id: 'mem_g1' }))
    await deps.store.put(record({ id: 'mem_g2' }))
    // ws 的语义输入是 visible（含 global），缓存里混着三类发现
    await deps.cache.put('cache_/p', {
      id: 'cache_/p', scannedAt: 100, scope: '/p',
      findings: [
        semantic('redundancy', ['mem_w1', 'mem_w2']),   // 纯 ws → 计
        semantic('redundancy', ['mem_g1', 'mem_g2']),   // 纯 global → 不计（全局自己算）
        semantic('unclear', ['mem_w1', 'mem_g1']),      // 跨作用域 → 归 ws（全局看不到 ws 侧，此处不计则两边失明）
        semantic('unclear', ['mem_w2', 'mem_gone']),    // 引用已消失记忆 → 不计（全员存活不满足）
      ],
    })
    const r = await score(deps, { kind: 'workspace', workspacePath: '/p' }, 200)
    expect(r.health.counts.redundancy).toBe(1)
    expect(r.health.counts.unclear).toBe(1)
    expect(r.records.map(x => x.id).sort()).toEqual(['mem_w1', 'mem_w2'])
  })

  it('conflict 计"任一方属于本作用域"，且必须仍在待决账本（裁决后即时回血）', async () => {
    const deps = makeDeps()
    await deps.store.put(record({ id: 'mem_w', scope: 'workspace', workspacePath: '/p' }))
    await deps.store.put(record({ id: 'mem_g' }))
    await deps.cache.put('cache_/p', {
      id: 'cache_/p', scannedAt: 100, scope: '/p',
      findings: [semantic('conflict', ['mem_w', 'mem_g'])],
    })
    // 未挂账（已被裁决 keep-both/dismiss）：不计
    expect((await score(deps, { kind: 'workspace', workspacePath: '/p' }, 200)).health.counts.conflict).toBe(0)
    // 挂账中：跨作用域的冲突归 ws（污染的是该 ws 的会话）
    await deps.decisions.upsert({ memoryIds: ['mem_w', 'mem_g'], summary: '' }, 100)
    expect((await score(deps, { kind: 'workspace', workspacePath: '/p' }, 200)).health.counts.conflict).toBe(1)
  })

  it('全局用 global-only 集合与单独的缓存键，misplaced 走重 cap', async () => {
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
    const r = await score(deps, { kind: 'global' }, 200)
    expect(r.records).toHaveLength(3)
    // 3 条且 100% 占比 → 进度满格 → 全局 misplaced cap 10（ws 是 6）
    expect(r.health.semanticPenalty).toBeCloseTo(10)
  })

  it('malformed 按所在目录归作用域：只算本作用域目录下的隔离文件', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pm-scope-'))
    try {
      await mkdir(join(root, GLOBAL_DIR), { recursive: true })
      await writeFile(join(root, GLOBAL_DIR, 'bad1.md'), '没有 frontmatter\n')
      const wsDir = join(root, workspaceDirName('/p'))
      await mkdir(wsDir, { recursive: true })
      await writeFile(join(wsDir, WORKSPACE_MARKER), '/p\n')
      await writeFile(join(wsDir, 'bad2.md'), '没有 frontmatter\n')
      const deps: Fixture = { ...makeDeps(), store: new MemoryStore(new FileTable({ root, stats: new InMemoryKvTable<RecallStats>() })) }
      expect((await score(deps, { kind: 'global' }, 200)).health.counts.malformed).toBe(1)
      // 项目的预读同时读了 global，global 的坏文件不算进本项目（不跨作用域重复扣分）
      expect((await score(deps, { kind: 'workspace', workspacePath: '/p' }, 200)).health.counts.malformed).toBe(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('提升候选只在项目里计数', async () => {
    const deps = makeDeps()
    await deps.store.put(record({ id: 'mem_c', scope: 'workspace', workspacePath: '/p', globalCandidate: true }))
    await deps.store.put(record({ id: 'mem_n', scope: 'workspace', workspacePath: '/p' }))
    expect((await score(deps, { kind: 'workspace', workspacePath: '/p' }, 200)).promoteCandidates).toBe(1)
    expect((await score(deps, { kind: 'global' }, 200)).promoteCandidates).toBe(0)
  })
})

// 子 agent 写入的待确认记录在健康分里和普通记录一样可见：计入总数、规则发现与语义发现
describe('scoreScope × 待确认记录', () => {
  const delegation = { sessionId: 'sub', depth: 1, parentSessionId: 'main' }

  it('待确认记录计入本作用域记录、规则发现与语义发现', async () => {
    const deps = makeDeps()
    await deps.store.put(record({ id: 'mem_p1', scope: 'workspace', workspacePath: '/p', delegation, validTo: 100 }))
    await deps.store.put(record({ id: 'mem_p2', scope: 'workspace', workspacePath: '/p', delegation }))
    await deps.cache.put('cache_/p', {
      id: 'cache_/p', scannedAt: 100, scope: '/p',
      findings: [semantic('redundancy', ['mem_p1', 'mem_p2'])],
    })
    const r = await score(deps, { kind: 'workspace', workspacePath: '/p' }, 200)
    expect(r.records.map(x => x.id).sort()).toEqual(['mem_p1', 'mem_p2'])
    expect(r.health.counts.expired).toBe(1)
    expect(r.health.counts.redundancy).toBe(1)
  })
})

describe('scoreScope 体检后改过的记忆', () => {
  it('旧缓存（没有记忆指纹）：仍按 updatedAt 是否晚于体检时间判断', async () => {
    const deps = makeDeps()
    await deps.store.put(record({ id: 'mem_a', updatedAt: 50 }))
    await deps.store.put(record({ id: 'mem_b', updatedAt: 150 }))
    await deps.cache.put(GLOBAL_CACHE_KEY, {
      id: GLOBAL_CACHE_KEY, scannedAt: 100, scope: 'global',
      findings: [semantic('unclear', ['mem_a']), semantic('unclear', ['mem_b'])],
    })
    expect((await score(deps, { kind: 'global' }, 200)).semanticFindings.map(f => f.memoryIds)).toEqual([['mem_a']])
  })
})
