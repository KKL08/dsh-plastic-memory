import { describe, expect, it } from 'vitest'
import { executeHealth, renderHealthResult, type HealthToolDeps, type HealthArgs, type SingleHealthResult, TIER_LABEL } from '../src/tools/health.ts'
import { MemoryStore, InMemoryTable } from '../src/store.ts'
import { PendingDecisionsStore } from '../src/governance/decisions.ts'
import { InMemoryKvTable } from '../src/kv-table.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'
import type { PendingDecision, ScanCacheEntry, Finding } from '../src/governance/schema.ts'
import { record } from './helpers/record.ts'
import { DAY } from './helpers/clock.ts'

function semantic(type: Finding['type'], memoryIds: string[], summary = ''): Finding {
  return { type, layer: 'semantic', severity: 'info', memoryIds, summary, suggestedAction: '' }
}

// 内置 decayDays（src/type-registry.ts）：knowledge=90, project=7, procedure=90；
// profile / preference / reference = null（不参与新鲜度）。
function makeDeps(now: number, workspacePath?: string): HealthToolDeps {
  return {
    store: new MemoryStore(new InMemoryTable()),
    registry: buildTypeRegistry({ template: 'coding', customTypes: {} }),
    decisions: new PendingDecisionsStore(new InMemoryKvTable<PendingDecision>()),
    cache: new InMemoryKvTable<ScanCacheEntry>(),
    thresholds: { actionScoreThreshold: 70, pendingOverdueDays: 7, scanStaleDays: 7 },
    resolveContext: async () => ({ workspacePath }),
    now: () => now,
  }
}

/** 单层视图断言助手：结果必须是 single 形态。 */
async function runSingle(args: HealthArgs, deps: HealthToolDeps, exec: unknown = {}): Promise<SingleHealthResult> {
  const r = await executeHealth(args, deps, exec)
  if (r.kind !== 'single') throw new Error(`expected single, got ${r.kind}`)
  return r
}

describe('executeHealth 单层视图', () => {
  it('空库满分绿色；无 workspace 会话默认落 global 层', async () => {
    const deps = makeDeps(1000)
    const r = await runSingle({}, deps)
    expect(r.score).toBe(100)
    expect(r.tier).toBe('green')
    expect(r.layer).toBe('global')
    expect(r.totalMemories).toBe(0)
  })

  it('默认口径=当前 workspace：分母是本项目自身规模，global 记忆不掺进来', async () => {
    const deps = makeDeps(1000, '/proj')
    await deps.store.put(record({ id: 'mem_ws', scope: 'workspace', workspacePath: '/proj' }))
    await deps.store.put(record({ id: 'mem_g1' }))
    await deps.store.put(record({ id: 'mem_g2' }))
    const r = await runSingle({}, deps)
    expect(r.layer).toBe('workspace')
    expect(r.workspacePath).toBe('/proj')
    expect(r.totalMemories).toBe(1)
  })

  it('从未 scan：semanticLayer.cachedAt 为 null，recommendation 建议首扫', async () => {
    const deps = makeDeps(1000)
    await deps.store.put(record({ id: 'mem_a' }))
    const r = await runSingle({}, deps)
    expect(r.breakdown.semanticLayer.cachedAt).toBeNull()
    expect(r.recommendationKinds).toContain('semantic-never-scanned')
  })

  it('红线门：本层 secret 直接判死——tier 强制红、score 压进红区', async () => {
    const deps = makeDeps(1000)
    await deps.store.put(record({ id: 'mem_s', content: 'key: sk-TESTONLYaaaaaaaaaaaaaaaa' }))
    const r = await runSingle({}, deps)
    expect(r.gate.secret).toBe(true)
    expect(r.tier).toBe('red')
    expect(r.score).toBe(40)
    expect(r.recommendationKinds).toEqual(['secret'])
  })

  it('workspace 视图兜住 global 层密钥：报警置顶但不计本层分数', async () => {
    const deps = makeDeps(1000, '/proj')
    await deps.store.put(record({ id: 'mem_ws', scope: 'workspace', workspacePath: '/proj' }))
    await deps.store.put(record({ id: 'mem_gs', content: 'key: sk-TESTONLYaaaaaaaaaaaaaaaa' })) // global
    const r = await runSingle({}, deps)
    expect(r.gate.secret).toBe(false)   // 本层干净
    expect(r.score).toBe(100)           // global 密钥不扣本层分
    expect(r.globalSecretAlert).toBe(1)
    expect(r.recommendationKinds).toEqual(['global-secret'])
  })

  it('语义层读缓存计数；conflict 须仍在待决账本（裁决后即时回血）', async () => {
    const deps = makeDeps(1000)
    await deps.store.put(record({ id: 'mem_a' }))
    await deps.store.put(record({ id: 'mem_b' }))
    await deps.cache.put('cache_global', {
      id: 'cache_global', scannedAt: 500, scope: 'global',
      findings: [semantic('conflict', ['mem_a', 'mem_b']), semantic('redundancy', ['mem_a'])],
    })
    // 无对应待决项（已被裁决 keep-both/dismiss）：conflict 不再计分
    const resolved = await runSingle({}, deps)
    expect(resolved.breakdown.semanticLayer.conflict).toBe(0)
    expect(resolved.breakdown.semanticLayer.redundancy).toBe(1)
    // 账本里有对应条目：正常计分
    await deps.decisions.upsert({ memoryIds: ['mem_a', 'mem_b'], summary: '' }, 500)
    const pending = await runSingle({}, deps)
    expect(pending.breakdown.semanticLayer.conflict).toBe(1)
    expect(pending.breakdown.semanticLayer.cachedAt).toBe(500)
  })

  it('缓存里引用已删除记忆的噪音 finding 不再计入（清理后分数回升）', async () => {
    const deps = makeDeps(1000)
    await deps.store.put(record({ id: 'mem_live' }))
    await deps.cache.put('cache_global', {
      id: 'cache_global', scannedAt: 500, scope: 'global',
      findings: [semantic('unclear', ['mem_gone']), semantic('unclear', ['mem_live'])],
    })
    const r = await runSingle({}, deps)
    expect(r.breakdown.semanticLayer.unclear).toBe(1)
  })

  it('新鲜度当第八类：超期条数走双轴进度，不再单条打满', async () => {
    const now = 200 * DAY
    const deps = makeDeps(now)
    // knowledge decayDays=90：(200−20)/90 = 2.0 超期；profile decayDays=null 不参与
    await deps.store.put(record({ id: 'mem_k', type: 'knowledge', lastConfirmedAt: 20 * DAY }))
    await deps.store.put(record({ id: 'mem_p', type: 'profile', lastConfirmedAt: 1 }))
    const r = await runSingle({}, deps)
    expect(r.totalMemories).toBe(2)
    expect(r.breakdown.freshness.avgRatio).toBe(2)
    expect(r.breakdown.freshness.staleCount).toBe(1)
    // 进度 min(1, 1/3, (1/1)/10%) = 1/3 → 15 × 1/3 = 5
    expect(r.breakdown.freshness.penalty).toBe(5)
    expect(r.score).toBe(95)
  })

  it('quarantined 文件按路径归层计 malformed；无 memoryRoot 时不归层', async () => {
    const base = makeDeps(1000)
    const quarantined = [
      { path: '/root/global/a.md', error: 'frontmatter 缺失' },
      { path: '/root/global/b.md', error: 'yaml 解析失败' },
      { path: '/root/other-ws-x1y2z3/c.md', error: '别的 workspace 的坏文件' },
    ]
    const withRoot: HealthToolDeps = { ...base, getQuarantined: () => quarantined, memoryRoot: '/root' }
    const r = await runSingle({}, withRoot)
    expect(r.breakdown.ruleLayer.malformed).toBe(2) // 只算 global 目录下的
    // total=0 时占比轴缺席：进度 2/3 → 6×2/3=4 → 96
    expect(r.score).toBe(96)
    const noRoot: HealthToolDeps = { ...base, getQuarantined: () => quarantined }
    expect((await runSingle({}, noRoot)).breakdown.ruleLayer.malformed).toBe(0)
  })

  it('待决项 ≥7 天标 overdue 并进 recommendation', async () => {
    const now = 10 * DAY
    const deps = makeDeps(now)
    await deps.store.put(record({ id: 'mem_a' }))
    await deps.store.put(record({ id: 'mem_b' }))
    await deps.decisions.upsert({ memoryIds: ['mem_a', 'mem_b'], summary: '老冲突' }, now - 7 * DAY - 1)
    const r = await runSingle({}, deps)
    expect(r.pendingDecisions.total).toBe(1)
    expect(r.pendingDecisions.overdue).toBe(1)
    expect(r.recommendationKinds).toContain('pending-overdue')
  })

  it('workspace 视图的待决项含跨层冲突（global vs 本项目），不含别的项目的', async () => {
    const deps = makeDeps(1000, '/proj-a')
    await deps.store.put(record({ id: 'mem_a', scope: 'workspace', workspacePath: '/proj-a' }))
    await deps.store.put(record({ id: 'mem_b', scope: 'workspace', workspacePath: '/proj-b' }))
    await deps.store.put(record({ id: 'mem_g' }))
    await deps.decisions.upsert({ memoryIds: ['mem_a', 'mem_g'], summary: '跨层冲突' }, 500)
    await deps.decisions.upsert({ memoryIds: ['mem_b', 'mem_g'], summary: '别家的冲突' }, 500)
    const r = await runSingle({}, deps)
    expect(r.pendingDecisions.items.map(i => i.summary)).toEqual(['跨层冲突'])
  })

  it('提升候选是闲时事务：库健康时才进 recommendation，有行动项时让位', async () => {
    const now = 1000
    const deps = makeDeps(now, '/proj')
    await deps.store.put(record({ id: 'mem_c', scope: 'workspace', workspacePath: '/proj', globalCandidate: true }))
    await deps.cache.put('cache_/proj', { id: 'cache_/proj', scannedAt: now, scope: '/proj', findings: [] })
    const idle = await runSingle({}, deps)
    expect(idle.promoteCandidates).toBe(1)
    expect(idle.recommendationKinds).toEqual(['promote-candidates'])
    // 有更高优先级行动项（从未扫描）时候选让位，但字段常在
    const busy = makeDeps(now, '/proj')
    await busy.store.put(record({ id: 'mem_c', scope: 'workspace', workspacePath: '/proj', globalCandidate: true }))
    const r2 = await runSingle({}, busy)
    expect(r2.promoteCandidates).toBe(1)
    expect(r2.recommendationKinds).not.toContain('promote-candidates')
  })

  it('message 用中文 tier 文案，结构化 tier 仍是枚举；conflict 计条压黄', async () => {
    const green = await runSingle({}, makeDeps(1000))
    expect(green.message).toContain(`（${TIER_LABEL.green}）`)
    expect(green.tier).toBe('green')
    // 3 条待决 conflict → −30 → 70 黄
    const deps = makeDeps(1000)
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) await deps.store.put(record({ id: `mem_${id}` }))
    const pairs = [['mem_a', 'mem_b'], ['mem_c', 'mem_d'], ['mem_e', 'mem_f']]
    await deps.cache.put('cache_global', {
      id: 'cache_global', scannedAt: 1000, scope: 'global',
      findings: pairs.map(ids => semantic('conflict', ids)),
    })
    for (const ids of pairs) await deps.decisions.upsert({ memoryIds: ids, summary: '' }, 999)
    const amber = await runSingle({}, deps)
    expect(amber.score).toBe(70)
    expect(amber.tier).toBe('amber')
    expect(amber.message).toContain(`（${TIER_LABEL.amber}）`)
  })

  it('④：有 findings 但分数 ≥ 阈值时，recommendation 说"有 N 类问题"而非"无需操作"', async () => {
    const now = 1000
    const deps = makeDeps(now)
    await deps.store.put(record({ id: 'mem_a' }))
    await deps.cache.put('cache_global', {
      id: 'cache_global', scannedAt: now, scope: 'global',
      findings: [semantic('redundancy', ['mem_a'])],
    })
    const r = await runSingle({}, deps)
    expect(r.score).toBe(98) // 6 × min(1, 1/3, 10) = 2
    expect(r.recommendationKinds).toContain('issues-below-threshold')
  })

  it('行动项并列：陈旧提示不再埋没档位早提示——proactive 两句并列，conservative 无早提示', async () => {
    // 6 条 workspace knowledge 全陈旧（freshness 15）+ 其中 3 条已过 validTo（expired 6）→ 79 分。
    // 旧单选链在 staleCount>0 时永远停在衰退期句，sensitivity 差异不可观察——此测钉住并列行为。
    const mk = async (threshold: number) => {
      const deps = makeDeps(200 * DAY, '/proj')
      deps.thresholds = { actionScoreThreshold: threshold, pendingOverdueDays: 7, scanStaleDays: 30 }
      for (let i = 0; i < 3; i++) {
        await deps.store.put(record({ id: `mem_stale_${i}`, scope: 'workspace', workspacePath: '/proj', lastConfirmedAt: 1 }))
        await deps.store.put(record({ id: `mem_exp_${i}`, scope: 'workspace', workspacePath: '/proj', lastConfirmedAt: 1, validTo: 100 * DAY }))
      }
      return runSingle({}, deps)
    }
    const proactive = await mk(80)
    expect(proactive.score).toBe(79)
    expect(proactive.recommendationKinds).toContain('freshness-stale')
    expect(proactive.recommendationKinds).toContain('score-below-threshold')
    const conservative = await mk(60)
    expect(conservative.recommendationKinds).toContain('freshness-stale')
    expect(conservative.recommendationKinds).not.toContain('score-below-threshold')
  })

  it('sensitivity：同一库（70 分），proactive(80) 提示待清理、normal(70) 只软提', async () => {
    const now = 1000
    const make = async () => {
      const deps = makeDeps(now)
      for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) await deps.store.put(record({ id: `mem_${id}` }))
      const pairs = [['mem_a', 'mem_b'], ['mem_c', 'mem_d'], ['mem_e', 'mem_f']]
      await deps.cache.put('cache_global', {
        id: 'cache_global', scannedAt: now, scope: 'global',
        findings: pairs.map(ids => semantic('conflict', ids)),
      })
      for (const ids of pairs) await deps.decisions.upsert({ memoryIds: ids, summary: '' }, now - 1)
      return deps
    }
    const proactive = await runSingle({}, { ...(await make()), thresholds: { actionScoreThreshold: 80, pendingOverdueDays: 3, scanStaleDays: 3 } })
    expect(proactive.recommendationKinds).toContain('score-below-threshold')
    const normal = await runSingle({}, await make())
    expect(normal.recommendationKinds).toContain('issues-below-threshold')
    expect(normal.recommendationKinds).not.toContain('score-below-threshold')
  })

  it('overdue 跟随 pendingOverdueDays：10 天挂起在 normal(7) overdue、conservative(14) 不 overdue', async () => {
    const now = 20 * DAY
    const make = async () => {
      const deps = makeDeps(now)
      await deps.store.put(record({ id: 'mem_a' }))
      await deps.store.put(record({ id: 'mem_b' }))
      await deps.decisions.upsert({ memoryIds: ['mem_a', 'mem_b'], summary: '挂 10 天' }, now - 10 * DAY)
      return deps
    }
    const normal = await runSingle({}, await make())
    expect(normal.pendingDecisions.overdue).toBe(1)
    expect(normal.pendingDecisions.items[0].overdue).toBe(true)
    const conservative = await runSingle({}, { ...(await make()), thresholds: { actionScoreThreshold: 60, pendingOverdueDays: 14, scanStaleDays: 30 } })
    expect(conservative.pendingDecisions.overdue).toBe(0)
    expect(conservative.pendingDecisions.items[0].overdue).toBe(false)
  })
})

describe('executeHealth 全库体检（scope=all）', () => {
  it('输出 global + 各 workspace 行，各层独立分母计分', async () => {
    const deps = makeDeps(1000)
    await deps.store.put(record({ id: 'mem_g' }))
    await deps.store.put(record({ id: 'mem_a1', scope: 'workspace', workspacePath: '/proj-a' }))
    await deps.store.put(record({ id: 'mem_a2', scope: 'workspace', workspacePath: '/proj-a' }))
    await deps.store.put(record({ id: 'mem_b1', scope: 'workspace', workspacePath: '/proj-b' }))
    const r = await executeHealth({ scope: 'all' }, deps, {})
    if (r.kind !== 'checkup') throw new Error(r.kind)
    expect(r.rows.map(row => row.layer === 'global' ? 'global' : row.workspacePath)).toEqual(['global', '/proj-a', '/proj-b'])
    expect(r.rows[0].totalMemories).toBe(1)
    expect(r.rows[1].totalMemories).toBe(2)
    expect(r.rows[2].totalMemories).toBe(1)
  })

  it('跨层冲突聚合：同一 global 记忆被 ≥2 个项目反对才高亮，单项目不聚合', async () => {
    const deps = makeDeps(1000)
    await deps.store.put(record({ id: 'mem_g1' }))
    await deps.store.put(record({ id: 'mem_g2' }))
    await deps.store.put(record({ id: 'mem_a', scope: 'workspace', workspacePath: '/proj-a' }))
    await deps.store.put(record({ id: 'mem_b', scope: 'workspace', workspacePath: '/proj-b' }))
    await deps.decisions.upsert({ memoryIds: ['mem_g1', 'mem_a'], summary: '' }, 500)
    await deps.decisions.upsert({ memoryIds: ['mem_g1', 'mem_b'], summary: '' }, 500)
    await deps.decisions.upsert({ memoryIds: ['mem_g2', 'mem_a'], summary: '' }, 500)
    const r = await executeHealth({ scope: 'all' }, deps, {})
    if (r.kind !== 'checkup') throw new Error(r.kind)
    expect(r.crossLayerConflicts).toHaveLength(1)
    expect(r.crossLayerConflicts[0].globalId).toBe('mem_g1')
    expect(r.crossLayerConflicts[0].workspaces).toEqual(['/proj-a', '/proj-b'])
    expect(r.crossLayerConflicts[0].decisionIds).toHaveLength(2)
  })

  it('提升候选按 workspace 聚合', async () => {
    const deps = makeDeps(1000)
    await deps.store.put(record({ id: 'mem_c1', scope: 'workspace', workspacePath: '/proj-a', globalCandidate: true }))
    await deps.store.put(record({ id: 'mem_c2', scope: 'workspace', workspacePath: '/proj-a', globalCandidate: true }))
    await deps.store.put(record({ id: 'mem_c3', scope: 'workspace', workspacePath: '/proj-b', globalCandidate: true }))
    await deps.store.put(record({ id: 'mem_n', scope: 'workspace', workspacePath: '/proj-b' }))
    const r = await executeHealth({ scope: 'all' }, deps, {})
    if (r.kind !== 'checkup') throw new Error(r.kind)
    expect(r.promoteCandidates.total).toBe(3)
    expect(r.promoteCandidates.byWorkspace).toEqual([
      { workspacePath: '/proj-a', count: 2 },
      { workspacePath: '/proj-b', count: 1 },
    ])
  })
})

describe('renderHealthResult', () => {
  it('单层：含三层扣分摘要，有待决项时含 pd_ id', async () => {
    const now = 10 * DAY
    const deps = makeDeps(now)
    await deps.store.put(record({ id: 'mem_s' }))
    await deps.store.put(record({ id: 'mem_b' }))
    await deps.decisions.upsert({ memoryIds: ['mem_s', 'mem_b'], summary: '待裁决冲突摘要' }, now - 7 * DAY - 1)
    const result = await runSingle({}, deps)
    const text = renderHealthResult(result)
    expect(text).toContain('规则层扣分')
    expect(text).toContain('语义层扣分')
    expect(text).toContain('新鲜度扣分')
    expect(text).toContain(result.pendingDecisions.items[0].id)
    expect(text).toContain('待裁决冲突摘要')
  })

  it('overdue 文案跟随 pendingOverdueDays：proactive(3) 显示"挂起超 3 天"而非硬编码 7 天', async () => {
    const now = 10 * DAY
    const deps: HealthToolDeps = { ...makeDeps(now), thresholds: { actionScoreThreshold: 80, pendingOverdueDays: 3, scanStaleDays: 3 } }
    await deps.store.put(record({ id: 'mem_a' }))
    await deps.store.put(record({ id: 'mem_b' }))
    await deps.decisions.upsert({ memoryIds: ['mem_a', 'mem_b'], summary: '挂 4 天的冲突' }, now - 4 * DAY)
    const text = renderHealthResult(await runSingle({}, deps))
    expect(text).toContain(`挂起超 ${deps.thresholds.pendingOverdueDays} 天`) // 天数取自结构化阈值
    expect(text).not.toContain('超 7 天')                                    // 不回退到硬编码默认
  })

  it('体检表：每层一行分数，跨层冲突与候选聚合各有段落', async () => {
    const deps = makeDeps(1000)
    await deps.store.put(record({ id: 'mem_g1' }))
    await deps.store.put(record({ id: 'mem_a', scope: 'workspace', workspacePath: '/proj-a', globalCandidate: true }))
    await deps.store.put(record({ id: 'mem_b', scope: 'workspace', workspacePath: '/proj-b' }))
    await deps.decisions.upsert({ memoryIds: ['mem_g1', 'mem_a'], summary: '' }, 500)
    await deps.decisions.upsert({ memoryIds: ['mem_g1', 'mem_b'], summary: '' }, 500)
    const r = await executeHealth({ scope: 'all' }, deps, {})
    if (r.kind !== 'checkup') throw new Error(r.kind)
    // 结构化事实：跨层冲突的 global id 与提升候选合计如实计算
    expect(r.crossLayerConflicts[0].globalId).toBe('mem_g1')
    expect(r.crossLayerConflicts[0].workspaces).toHaveLength(2)
    expect(r.promoteCandidates.total).toBe(1)
    const text = renderHealthResult(r)
    // 一条渲染冒烟：分层成行、冲突段落带上结构化 global id，而非锁定手写整句
    expect(text).toContain('- global：')
    expect(text).toContain('- /proj-a：')
    expect(text).toContain(r.crossLayerConflicts[0].globalId)
  })

  it('scope 传未知 workspace 值：报错列出合法路径，不静默算错层', async () => {
    const deps = makeDeps(1000, '/proj')
    await deps.store.put(record({ id: 'mem_w', scope: 'workspace', workspacePath: '/proj' }))
    const r = await executeHealth({ scope: 'proj-8641b727' }, deps, {})
    expect(r.kind).toBe('error')
    const text = renderHealthResult(r)
    expect(text).toContain('proj-8641b727')
    expect(text).toContain('/proj')
  })

  it('显式看别的 workspace：文案标注该路径而非「本项目」', async () => {
    const deps = makeDeps(1000, '/proj')
    await deps.store.put(record({ id: 'mem_w', scope: 'workspace', workspacePath: '/proj' }))
    await deps.store.put(record({ id: 'mem_o', scope: 'workspace', workspacePath: '/other' }))
    const r = await runSingle({ scope: '/other' }, deps)
    expect(r.workspacePath).toBe('/other')
    expect(r.message).toContain('/other')
  })
})
