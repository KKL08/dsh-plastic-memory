import { describe, expect, it } from 'vitest'
import { executeScan, cacheKey, renderScanResult, type ScanToolDeps, type ScanArgs, type SingleScanResult } from '../src/tools/scan.ts'
import { GLOBAL_CACHE_KEY } from '../src/governance/layer-health.ts'
import { MemoryStore, InMemoryTable } from '../src/store.ts'
import { PendingDecisionsStore } from '../src/governance/decisions.ts'
import { InMemoryKvTable } from '../src/kv-table.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'
import type { PendingDecision, ScanCacheEntry } from '../src/governance/schema.ts'
import { record } from './helpers/record.ts'

function makeDeps(overrides?: Partial<ScanToolDeps>): ScanToolDeps {
  return {
    store: new MemoryStore(new InMemoryTable()),
    registry: buildTypeRegistry({ template: 'coding', customTypes: {} }),
    decisions: new PendingDecisionsStore(new InMemoryKvTable<PendingDecision>()),
    cache: new InMemoryKvTable<ScanCacheEntry>(),
    getBaseline: () => null,
    getLlm: (_exec: unknown) => null,
    resolveContext: async () => ({ workspacePath: undefined }),
    now: () => 9000,
    ...overrides,
  }
}

/** 单层扫描断言助手：结果必须是 single 形态。 */
async function scanSingle(args: ScanArgs, deps: ScanToolDeps): Promise<SingleScanResult> {
  const r = await executeScan(args, deps, {})
  if (r.kind !== 'single') throw new Error(`expected single, got ${r.kind}`)
  return r
}

const conflictLlm = {
  complete: async () => JSON.stringify({
    findings: [{ type: 'conflict', memoryIds: ['mem_a', 'mem_b'], summary: '互相矛盾', suggestedAction: '请裁决' }],
  }),
}

describe('executeScan 单层模式', () => {
  it('layers=rule：只跑规则层，不碰 LLM、不写缓存', async () => {
    const deps = makeDeps({ getLlm: (_exec: unknown) => ({ complete: async () => { throw new Error('不该被调') } }) })
    await deps.store.put(record({ id: 'mem_exp', validTo: 100 }))
    const r = await scanSingle({ layers: 'rule' }, deps)
    expect(r.findings.map(f => f.type)).toEqual(['expired'])
    expect(r.semanticCachedAt).toBeNull()
    expect(r.stats.scanned).toBe(1)
    expect(r.stats.issues).toBe(1)
  })

  it('默认口径=当前 workspace 的可见集合（resolveContext），无 workspace 会话退到 global 层', async () => {
    const deps = makeDeps({ resolveContext: async () => ({ workspacePath: '/proj' }) })
    await deps.store.put(record({ id: 'mem_ws', scope: 'workspace', workspacePath: '/proj' }))
    await deps.store.put(record({ id: 'mem_g' }))
    await deps.store.put(record({ id: 'mem_other', scope: 'workspace', workspacePath: '/elsewhere' }))
    const r = await scanSingle({ layers: 'rule' }, deps)
    expect(r.layer).toBe('workspace')
    expect(r.workspacePath).toBe('/proj')
    expect(r.stats.scanned).toBe(2) // visible = 本项目 + global，不含别的项目

    const globalDeps = makeDeps()
    await globalDeps.store.put(record({ id: 'mem_g' }))
    await globalDeps.store.put(record({ id: 'mem_other', scope: 'workspace', workspacePath: '/elsewhere' }))
    const g = await scanSingle({ layers: 'rule' }, globalDeps)
    expect(g.layer).toBe('global')
    expect(g.stats.scanned).toBe(1) // 无 cwd 会话只看 global 层
  })

  it('LLM 抛异常时 layers=full 仍返回规则层结果', async () => {
    const deps = makeDeps({ getLlm: (_exec: unknown) => ({ complete: async () => { throw new Error('boom') } }) })
    await deps.store.put(record({ id: 'mem_exp', validTo: 100 }))
    const r = await scanSingle({}, deps)
    expect(r.findings.map(f => f.type)).toContain('expired')
    expect(r.notes.map(n => n.code)).toContain('semantic-failed')
  })

  it('layers=full：语义层结果写缓存（global 层桶）、conflict 进待决账本', async () => {
    const deps = makeDeps({ getLlm: (_exec: unknown) => conflictLlm })
    await deps.store.put(record({ id: 'mem_a', content: '用 pnpm' }))
    await deps.store.put(record({ id: 'mem_b', content: '用 npm' }))
    const r = await scanSingle({}, deps)
    expect(r.findings.some(f => f.type === 'conflict')).toBe(true)
    expect(r.pendingDecisions.created).toBe(1)
    expect(deps.decisions.list()).toHaveLength(1)
    const cached = deps.cache.get(GLOBAL_CACHE_KEY)!
    expect(cached.scannedAt).toBe(9000)
    expect(cached.findings).toHaveLength(1)
    expect(r.semanticCachedAt).toBe(9000)
    // D2：待决项 id 必须透出，否则 memory_confirm resolve 无法定位（decisionId 不可达）
    expect(r.pendingDecisions.items).toHaveLength(1)
    const item = r.pendingDecisions.items[0]
    expect(item.id).toMatch(/^pd_/)
    expect(item.memoryIds.sort()).toEqual(['mem_a', 'mem_b'])
    expect(item.summary).toBe('互相矛盾')
    expect(item.isNew).toBe(true)
  })

  it('同一冲突再次 scan 不重复建待决项（existing 计数），items 仍带该 id 但 isNew=false', async () => {
    const deps = makeDeps({ getLlm: (_exec: unknown) => conflictLlm })
    await deps.store.put(record({ id: 'mem_a' }))
    await deps.store.put(record({ id: 'mem_b' }))
    const r1 = await scanSingle({}, deps)
    const firstId = r1.pendingDecisions.items[0].id
    const r2 = await scanSingle({}, deps)
    expect(r2.pendingDecisions.created).toBe(0)
    expect(r2.pendingDecisions.existing).toBe(1)
    expect(deps.decisions.list()).toHaveLength(1)
    expect(r2.pendingDecisions.items).toHaveLength(1)
    expect(r2.pendingDecisions.items[0].id).toBe(firstId)
    expect(r2.pendingDecisions.items[0].isNew).toBe(false)
  })

  it('llm 为 null 时语义层跳过并留 note', async () => {
    const deps = makeDeps()
    await deps.store.put(record({ id: 'mem_a' }))
    const r = await scanSingle({}, deps)
    expect(r.notes.map(n => n.code)).toContain('semantic-unavailable')
  })

  it('语义分析两次解析失败：failed note，缓存不写', async () => {
    const deps = makeDeps({ getLlm: (_exec: unknown) => ({ complete: async () => '不是 JSON' }) })
    await deps.store.put(record({ id: 'mem_a' }))
    const r = await scanSingle({}, deps)
    expect(r.notes.map(n => n.code)).toContain('semantic-failed')
    expect(deps.cache.get(GLOBAL_CACHE_KEY)).toBeUndefined()
  })

  it('scope 限定时按 visible 语义扫描（global + 该 workspace），stats.clean 为无问题记忆数', async () => {
    const deps = makeDeps()
    await deps.store.put(record({ id: 'mem_w', scope: 'workspace', workspacePath: '/a', validTo: 1 }))
    await deps.store.put(record({ id: 'mem_g', scope: 'global', validTo: 1 }))
    await deps.store.put(record({ id: 'mem_other', scope: 'workspace', workspacePath: '/b', validTo: 1 }))
    await deps.store.put(record({ id: 'mem_ok', scope: 'workspace', workspacePath: '/a' }))
    const r = await scanSingle({ scope: '/a', layers: 'rule' }, deps)
    // global 记忆在该 workspace 同样生效，必须纳入；别的 workspace 的不纳入
    expect(r.stats.scanned).toBe(3)
    expect(r.findings.map(f => f.memoryIds[0]).sort()).toEqual(['mem_g', 'mem_w'])
    expect(r.stats.clean).toBe(1)
  })

  it('规则层扫描输出包含 malformed finding；空 memoryIds 不影响 stats.clean', async () => {
    const deps = makeDeps({
      getQuarantined: () => [{ path: '/mem/broken.md', error: 'frontmatter 缺失 name 字段' }],
    })
    await deps.store.put(record({ id: 'mem_ok' }))
    const r = await scanSingle({ layers: 'rule' }, deps)
    const malformed = r.findings.find(f => f.type === 'malformed')
    expect(malformed).toBeDefined()
    expect(malformed!.memoryIds).toEqual([])
    expect(malformed!.summary).toContain('/mem/broken.md')
    // malformed 无对应记录，memoryIds 为空，不进 problemIds——mem_ok 仍算 clean
    expect(r.stats.clean).toBe(1)
    expect(r.stats.issues).toBe(1)
  })

  it('layers=semantic 且无 llm 时如实说明未执行任何检测', async () => {
    const deps = makeDeps()
    await deps.store.put(record({ id: 'mem_a' }))
    const r = await scanSingle({ layers: 'semantic' }, deps)
    expect(r.findings).toEqual([])
    expect(r.notes.map(n => n.code)).toContain('no-layer-executed')
  })

  it('语义分析失败时不覆盖已有的好缓存', async () => {
    const deps = makeDeps({ getLlm: (_exec: unknown) => ({ complete: async () => '不是 JSON' }) })
    await deps.store.put(record({ id: 'mem_a' }))
    await deps.cache.put(GLOBAL_CACHE_KEY, {
      id: GLOBAL_CACHE_KEY, scannedAt: 500, scope: 'global',
      findings: [{ type: 'unclear', layer: 'semantic', severity: 'info', memoryIds: ['mem_a'], summary: '旧发现', suggestedAction: 'a' }],
    })
    const r = await scanSingle({}, deps)
    expect(r.notes.map(n => n.code)).toContain('semantic-failed')
    const cached = deps.cache.get(GLOBAL_CACHE_KEY)!
    expect(cached.scannedAt).toBe(500)
    expect(cached.findings[0].summary).toBe('旧发现')
    expect(r.semanticCachedAt).toBe(500)
  })

  it('垂直冲突把 baselineRef 带进待决账本；横向冲突则该键完全不存在', async () => {
    const verticalLlm = {
      complete: async () => JSON.stringify({
        findings: [{ type: 'conflict', memoryIds: ['mem_a'], baselineRef: 'AGENTS.md：包管理', summary: '与基线矛盾', suggestedAction: '裁决' }],
      }),
    }
    const deps = makeDeps({ getLlm: (_exec: unknown) => verticalLlm })
    await deps.store.put(record({ id: 'mem_a' }))
    await scanSingle({}, deps)
    const entry = deps.decisions.list()[0]
    expect(entry.baselineRef).toBe('AGENTS.md：包管理')

    // 横向冲突：baselineRef 键必须整个不存在，不能是值为 undefined 的键
    const deps2 = makeDeps({ getLlm: (_exec: unknown) => conflictLlm })
    await deps2.store.put(record({ id: 'mem_a' }))
    await deps2.store.put(record({ id: 'mem_b' }))
    await scanSingle({}, deps2)
    expect(Object.keys(deps2.decisions.list()[0])).not.toContain('baselineRef')
  })

  it('cacheKey：workspace 路径分桶，缺省落 global 层桶', () => {
    expect(cacheKey('/proj')).toBe('cache_/proj')
    expect(cacheKey(undefined)).toBe(GLOBAL_CACHE_KEY)
  })
})

describe('executeScan 全库体检', () => {
  /** 语义扫描与跨项目重复分析共用一个 llm：按 prompt 特征分流。 */
  const checkupLlm = {
    complete: async ({ system }: { system: string; user: string }) =>
      system.includes('global 缺位')
        ? JSON.stringify({ duplicates: [{ topic: '包管理用 pnpm', workspaces: ['/proj-a', '/proj-b'], suggestion: '提炼一条 global 偏好' }] })
        : JSON.stringify({ findings: [] }),
  }

  async function seedTwoWs(deps: ScanToolDeps) {
    await deps.store.put(record({ id: 'mem_a1', scope: 'workspace', workspacePath: '/proj-a', content: '包管理用 `pnpm`', globalCandidate: true }))
    await deps.store.put(record({ id: 'mem_b1', scope: 'workspace', workspacePath: '/proj-b', content: '这里也用 `pnpm`' }))
    await deps.store.put(record({ id: 'mem_g1' }))
  }

  it('scopes 列表：逐 workspace + global 各自扫描计分，语义缓存写各自桶', async () => {
    const deps = makeDeps({ getLlm: (_exec: unknown) => checkupLlm })
    await seedTwoWs(deps)
    const r = await executeScan({ scopes: ['/proj-a', '/proj-b'] }, deps, {})
    if (r.kind !== 'checkup') throw new Error(r.kind)
    expect(r.rows.map(row => row.layer === 'global' ? 'global' : row.workspacePath)).toEqual(['global', '/proj-a', '/proj-b'])
    expect(r.rows.every(row => row.tier === 'green')).toBe(true)
    expect(deps.cache.get('cache_/proj-a')?.scannedAt).toBe(9000)
    expect(deps.cache.get('cache_/proj-b')?.scannedAt).toBe(9000)
    expect(deps.cache.get(GLOBAL_CACHE_KEY)?.scannedAt).toBe(9000)
  })

  it('scope=all 自动枚举库里的全部 workspace', async () => {
    const deps = makeDeps()
    await seedTwoWs(deps)
    const r = await executeScan({ scope: 'all', layers: 'rule' }, deps, {})
    if (r.kind !== 'checkup') throw new Error(r.kind)
    expect(r.rows).toHaveLength(3)
  })

  it('global 视角一：候选按 workspace 聚合 + 跨项目重复主题（语义层）', async () => {
    const deps = makeDeps({ getLlm: (_exec: unknown) => checkupLlm })
    await seedTwoWs(deps)
    const r = await executeScan({ scope: 'all' }, deps, {})
    if (r.kind !== 'checkup') throw new Error(r.kind)
    expect(r.promoteCandidates.total).toBe(1)
    expect(r.promoteCandidates.byWorkspace[0].workspacePath).toBe('/proj-a')
    expect(r.duplicates.via).toBe('semantic')
    expect(r.duplicates.items[0].topic).toBe('包管理用 pnpm')
    expect(r.duplicates.items[0].workspaces).toEqual(['/proj-a', '/proj-b'])
  })

  it('无 LLM 时跨项目重复退用实体聚类保底（疑似级）', async () => {
    const deps = makeDeps()
    await seedTwoWs(deps)
    const r = await executeScan({ scope: 'all', layers: 'rule' }, deps, {})
    if (r.kind !== 'checkup') throw new Error(r.kind)
    expect(r.duplicates.via).toBe('entity')
    expect(r.duplicates.items[0].topic).toBe('pnpm')  // 反引号实体在两个 ws 出现且 global 缺位
  })

  it('基线只用于当前会话所属 workspace 与 global 层：其他 ws 跳过垂直检测并留 note', async () => {
    const deps = makeDeps({
      getLlm: (_exec: unknown) => ({ complete: async () => JSON.stringify({ findings: [] }) }),
      getBaseline: () => '# CLAUDE.md\n用 pnpm',
      resolveContext: async () => ({ workspacePath: '/proj-a' }),
    })
    await seedTwoWs(deps)
    const r = await executeScan({ scopes: ['/proj-a', '/proj-b'] }, deps, {})
    if (r.kind !== 'checkup') throw new Error(r.kind)
    expect(r.notes.map(n => n.code)).toContain('baseline-session-scoped')
  })

  it('单层显式扫别的 workspace：基线不适用并留 note；扫自己不留', async () => {
    const deps = makeDeps({
      getLlm: (_exec: unknown) => ({ complete: async () => JSON.stringify({ findings: [] }) }),
      getBaseline: () => '基线内容',
      resolveContext: async () => ({ workspacePath: '/proj-a' }),
    })
    await seedTwoWs(deps)
    const other = await scanSingle({ scope: '/proj-b' }, deps)
    expect(other.notes.map(n => n.code)).toContain('baseline-session-scoped')
    const own = await scanSingle({ scope: '/proj-a' }, deps)
    expect(own.notes.map(n => n.code)).not.toContain('baseline-session-scoped')
  })

  it('单层 malformed 按目录归层（有 memoryRoot 时），与 memory_health 同口径', async () => {
    const { workspaceDirName } = await import('../src/storage/paths.ts')
    const deps = makeDeps({
      memoryRoot: '/root',
      resolveContext: async () => ({ workspacePath: '/proj-a' }),
      getQuarantined: () => [
        { path: `/root/${workspaceDirName('/proj-a')}/bad.md`, error: 'x' },
        { path: '/root/global/gbad.md', error: 'x' },
        { path: `/root/${workspaceDirName('/elsewhere')}/other.md`, error: 'x' },
      ],
    })
    await deps.store.put(record({ id: 'mem_a', scope: 'workspace', workspacePath: '/proj-a' }))
    const r = await scanSingle({ layers: 'rule' }, deps)
    expect(r.findings.filter(f => f.type === 'malformed')).toHaveLength(1)
    expect(r.findings.find(f => f.type === 'malformed')!.summary).toContain('bad.md')
  })

  it('体检的 created/existing 从去重后的待决项派生：同一垂直冲突多桶复扫不虚增', async () => {
    const verticalLlm = {
      complete: async ({ user }: { system: string; user: string }) =>
        user.includes('mem_g1')
          ? JSON.stringify({ findings: [{ type: 'conflict', memoryIds: ['mem_g1'], baselineRef: 'AGENTS.md：规则', summary: '与基线矛盾', suggestedAction: '裁决' }] })
          : JSON.stringify({ findings: [] }),
    }
    const deps = makeDeps({ getLlm: (_exec: unknown) => verticalLlm, getBaseline: () => '基线' })
    await seedTwoWs(deps)
    const first = await executeScan({ scope: 'all' }, deps, {})
    if (first.kind !== 'checkup') throw new Error(first.kind)
    // mem_g1 在两个 ws 的 visible 桶与 global 桶各被发现一次，dedupKey 收敛为一条
    expect(first.pendingDecisions.items).toHaveLength(1)
    expect(first.pendingDecisions.created).toBe(1)
    expect(first.pendingDecisions.existing).toBe(0)
    const second = await executeScan({ scope: 'all' }, deps, {})
    if (second.kind !== 'checkup') throw new Error(second.kind)
    expect(second.pendingDecisions.created).toBe(0)
    expect(second.pendingDecisions.existing).toBe(1)
  })

  it('体检收尾清理孤儿语义缓存桶：废弃 workspace 与历史遗留键被删，现存桶保留', async () => {
    const deps = makeDeps()
    await seedTwoWs(deps)
    await deps.cache.put('cache_/gone-ws', { id: 'cache_/gone-ws', scannedAt: 1, scope: '/gone-ws', findings: [] })
    await deps.cache.put('cache_all', { id: 'cache_all', scannedAt: 1, scope: 'all', findings: [] })
    await deps.cache.put('cache_/proj-a', { id: 'cache_/proj-a', scannedAt: 1, scope: '/proj-a', findings: [] })
    await executeScan({ scope: 'all', layers: 'rule' }, deps, {})
    expect(deps.cache.get('cache_/gone-ws')).toBeUndefined()
    expect(deps.cache.get('cache_all')).toBeUndefined()
    expect(deps.cache.get('cache_/proj-a')).toBeDefined()
  })

  it('global 视角二：同一 global 记忆被 ≥2 个项目反对时聚合高亮', async () => {
    const deps = makeDeps()
    await seedTwoWs(deps)
    await deps.decisions.upsert({ memoryIds: ['mem_g1', 'mem_a1'], summary: '' }, 500)
    await deps.decisions.upsert({ memoryIds: ['mem_g1', 'mem_b1'], summary: '' }, 500)
    const r = await executeScan({ scope: 'all', layers: 'rule' }, deps, {})
    if (r.kind !== 'checkup') throw new Error(r.kind)
    expect(r.crossLayerConflicts).toHaveLength(1)
    expect(r.crossLayerConflicts[0].globalId).toBe('mem_g1')
    expect(r.crossLayerConflicts[0].workspaces).toEqual(['/proj-a', '/proj-b'])
    const text = renderScanResult(r)
    expect(text).toContain(r.crossLayerConflicts[0].globalId) // 冲突段落带真实 global id，而非锁定整句
  })

  it('用户在首个 workspace 语义扫描期间取消：抛 AbortError，剩余 workspace 不再调 LLM，无新缓存/待决', async () => {
    const controller = new AbortController()
    const calls: string[] = []
    const abortingLlm = {
      complete: async ({ user }: { system: string; user: string }): Promise<string> => {
        calls.push(user)
        controller.abort()
        throw new DOMException('memory_scan cancelled', 'AbortError')
      },
    }
    const deps = makeDeps({ getLlm: (_exec: unknown) => abortingLlm })
    await seedTwoWs(deps)
    await expect(executeScan({ scopes: ['/proj-a', '/proj-b'] }, deps, { signal: controller.signal }))
      .rejects.toThrow(/cancel|abort/i)
    // 首个 workspace 之外不再调用 LLM（语义 + 跨项目重复都未触及）
    expect(calls).toHaveLength(1)
    // 取消发生在写入前：scan_cache 与 pending_decisions 无新增
    expect([...deps.cache.entries()]).toHaveLength(0)
    expect(deps.decisions.list()).toHaveLength(0)
  })

  it('layers=rule 体检不发跨项目重复的 LLM 调用，退用实体聚类保底', async () => {
    let calls = 0
    const countingLlm = { complete: async (): Promise<string> => { calls++; return '{"duplicates":[]}' } }
    const deps = makeDeps({ getLlm: (_exec: unknown) => countingLlm })
    await seedTwoWs(deps)
    const r = await executeScan({ scope: 'all', layers: 'rule' }, deps, {})
    if (r.kind !== 'checkup') throw new Error(r.kind)
    expect(calls).toBe(0)
    expect(r.duplicates.via).toBe('entity')
  })

  it('never-aborted signal 与不传 signal 结果一致', async () => {
    const emptyLlm = { complete: async (): Promise<string> => '{"findings":[]}' }
    const seed = async (deps: ScanToolDeps) => {
      await deps.store.put(record({ id: 'mem_a', scope: 'workspace', workspacePath: '/proj', content: '用 pnpm' }))
    }
    const depsNoSignal = makeDeps({ getLlm: (_exec: unknown) => emptyLlm })
    await seed(depsNoSignal)
    const withoutSignal = await executeScan({ scope: '/proj' }, depsNoSignal, {})

    const depsSignal = makeDeps({ getLlm: (_exec: unknown) => emptyLlm })
    await seed(depsSignal)
    const withSignal = await executeScan({ scope: '/proj' }, depsSignal, { signal: new AbortController().signal })

    expect(withSignal).toEqual(withoutSignal)
  })
})

describe('renderScanResult', () => {
  it('待决冲突存在时，render 文本含 pd_ id 与 memory_confirm resolve 提示', async () => {
    const deps = makeDeps({ getLlm: (_exec: unknown) => conflictLlm })
    await deps.store.put(record({ id: 'mem_a', content: '用 pnpm' }))
    await deps.store.put(record({ id: 'mem_b', content: '用 npm' }))
    const result = await scanSingle({}, deps)
    const text = renderScanResult(result)
    expect(text).toContain(result.pendingDecisions.items[0].id)
    expect(text).toContain('memory_confirm resolve')
    expect(text).toContain(result.pendingDecisions.items[0].summary)
    // 证据下钻提示：裁决前引导回查双方出处，垂直冲突核对基线不回查
    expect(text).toContain('memory_source')
    expect(text).toMatch(/垂直冲突.*基线/)
  })

  it('无待决冲突时，render 不追加待裁决段落', async () => {
    const deps = makeDeps()
    await deps.store.put(record({ id: 'mem_a' }))
    const result = await scanSingle({ layers: 'rule' }, deps)
    const text = renderScanResult(result)
    expect(text).not.toContain('待裁决冲突')
  })

  it('globalCandidate 记忆进 promoteCandidates + 渲染建议段（限流折叠）', async () => {
    const store = new MemoryStore(new InMemoryTable())
    for (let i = 0; i < 6; i++) {
      await store.put(record({ id: `mem_c${i}`, scope: 'workspace', workspacePath: '/a', globalCandidate: true, summary: `候选${i}` }))
    }
    await store.put(record({ id: 'mem_plain', scope: 'workspace', workspacePath: '/a', summary: '普通' }))
    const r = await scanSingle({ scope: '/a', layers: 'rule' }, makeDeps({ store }))
    expect(r.promoteCandidates.items.length).toBe(5)  // PROMOTE_LIMIT 限流
    expect(r.promoteCandidates.more).toBe(1)
    expect(r.promoteCandidates.items.every(c => c.id.startsWith('mem_c'))).toBe(true)
    const text = renderScanResult(r)
    expect(text).toContain('建议提升全局')
    expect(text).toContain('memory_promote')
    expect(text).toContain(`另有 ${r.promoteCandidates.more} 条`) // 折叠计数取自结构化 more
    expect(text).toMatch(/memory_source.*出生语境|出生语境.*memory_source/)  // 提升前核验提示
  })

  it('无 globalCandidate 时 promoteCandidates 为空、不渲染建议段', async () => {
    const store = new MemoryStore(new InMemoryTable())
    await store.put(record({ id: 'mem_x', scope: 'workspace', workspacePath: '/a', summary: '普通' }))
    const r = await scanSingle({ scope: '/a', layers: 'rule' }, makeDeps({ store }))
    expect(r.promoteCandidates.items).toEqual([])
    expect(renderScanResult(r)).not.toContain('建议提升全局')
  })
})

describe('executeScan scope 校验', () => {
  it('scope 传记忆目录名等未知值：报错并列出已知 workspace 路径，不静默扫错层', async () => {
    const deps = makeDeps({ resolveContext: async () => ({ workspacePath: '/proj' }) })
    await deps.store.put(record({ id: 'mem_w', scope: 'workspace', workspacePath: '/proj' }))
    await deps.store.put(record({ id: 'mem_o', scope: 'workspace', workspacePath: '/other' }))
    const r = await executeScan({ scope: 'proj-alpha-8641b727' }, deps, {})
    expect(r.kind).toBe('error')
    const text = renderScanResult(r)
    expect(text).toContain('proj-alpha-8641b727')
    expect(text).toContain('/proj')
    expect(text).toContain('/other')
  })

  it('体检 scopes 含未知值：整体报错（不部分扫描），"all" 字面量也不属于 scopes', async () => {
    const deps = makeDeps()
    await deps.store.put(record({ id: 'mem_w', scope: 'workspace', workspacePath: '/proj' }))
    const bad = await executeScan({ scopes: ['/proj', 'proj-beta-3fb46caf'] }, deps, {})
    expect(bad.kind).toBe('error')
    const asAll = await executeScan({ scopes: ['all'] }, deps, {})
    expect(asAll.kind).toBe('error')
  })

  it('当前会话 workspace 即使还没有记忆也算合法 scope', async () => {
    const deps = makeDeps({ resolveContext: async () => ({ workspacePath: '/fresh' }) })
    await deps.store.put(record({ id: 'mem_g' }))
    const r = await scanSingle({ scope: '/fresh', layers: 'rule' }, deps)
    expect(r.workspacePath).toBe('/fresh')
  })

  it('显式扫别的 workspace：文案标注该路径而非「本项目」', async () => {
    const deps = makeDeps({ resolveContext: async () => ({ workspacePath: '/proj' }) })
    await deps.store.put(record({ id: 'mem_w', scope: 'workspace', workspacePath: '/proj' }))
    await deps.store.put(record({ id: 'mem_o', scope: 'workspace', workspacePath: '/other' }))
    const r = await scanSingle({ scope: '/other', layers: 'rule' }, deps)
    expect(r.workspacePath).toBe('/other')
    expect(r.message).toContain('/other')
    const self = await scanSingle({ scope: '/proj', layers: 'rule' }, deps)
    expect(self.workspacePath).toBe('/proj')
    expect(self.message).not.toContain('/proj') // 自己的 workspace 走「本项目」标签，不带路径
  })
})
