import type { MemoryStore } from '../store.ts'
import type { TypeRegistry } from '../type-registry.ts'
import type { PendingDecisionsStore } from '../governance/decisions.ts'
import type { KvTable } from '../governance/table.ts'
import type { ScanCacheEntry } from '../governance/schema.ts'
import { FINDING_TYPES } from '../governance/schema.ts'
import type { HealthThresholds } from '../governance/health-presets.ts'
import { runRuleScan, buildMalformedFindings } from '../governance/rule-scan.ts'
import { computeHealth } from '../governance/scoring.ts'
import { cacheKey } from './scan.ts'

const DAY = 86_400_000

/** tier 枚举 → 用户面中文文案（结构化 tier 字段仍保留 green/amber/red 供程序用）。 */
const TIER_LABEL = { green: '绿色', amber: '黄色', red: '红色' } as const

export interface HealthToolDeps {
  store: MemoryStore
  registry: TypeRegistry
  decisions: PendingDecisionsStore
  cache: KvTable<ScanCacheEntry>
  /** 触发阈值（由 index.ts 从 sensitivity 预设解析后注入）。 */
  thresholds: HealthThresholds
  /** 存储层隔离的不可解析记忆文件（FileTable.quarantined）；缺省视为无。 */
  getQuarantined?: () => readonly { path: string; error: string }[]
  now?: () => number
}

export interface HealthArgs {
  scope?: string
}

export interface HealthToolResult {
  score: number
  tier: 'green' | 'amber' | 'red'
  breakdown: {
    ruleLayer: { secret: number; expired: number; bloat: number; orphan: number; malformed: number; penalty: number }
    semanticLayer: { conflict: number; redundancy: number; misplaced: number; unclear: number; penalty: number; cachedAt: number | null }
    freshness: { avgRatio: number; staleCount: number; penalty: number }
  }
  pendingDecisions: {
    total: number
    overdue: number
    items: Array<{ id: string; summary: string; overdue: boolean }>
  }
  totalMemories: number
  recommendation: string
  message: string
}

/** 把健康检查结果渲染成给模型看的一段文本。纯函数。 */
export function renderHealthResult(result: HealthToolResult): string {
  const { breakdown } = result
  const lines = [result.message]
  lines.push(
    `规则层扣分 ${breakdown.ruleLayer.penalty}（secret ${breakdown.ruleLayer.secret} / expired ${breakdown.ruleLayer.expired} / bloat ${breakdown.ruleLayer.bloat} / orphan ${breakdown.ruleLayer.orphan} / malformed ${breakdown.ruleLayer.malformed}）；`
    + `语义层扣分 ${breakdown.semanticLayer.penalty}（conflict ${breakdown.semanticLayer.conflict} / redundancy ${breakdown.semanticLayer.redundancy} / misplaced ${breakdown.semanticLayer.misplaced} / unclear ${breakdown.semanticLayer.unclear}）；`
    + `新鲜度扣分 ${breakdown.freshness.penalty}（${breakdown.freshness.staleCount} 条超期）`,
  )
  if (result.pendingDecisions.items.length > 0) {
    lines.push('待裁决冲突（memory_confirm resolve）：')
    for (const item of result.pendingDecisions.items) {
      lines.push(`- [${item.id}] ${item.summary}${item.overdue ? '（挂起超 7 天）' : ''}`)
    }
  }
  return lines.join('\n')
}

/**
 * memory_health（设计稿 §7.3）：纯读取。规则层实时算 + 语义层读 scan_cache + 新鲜度轴。
 * 从未 scan 时语义计 0，不因缺语义数据压分。
 */
export async function executeHealth(rawArgs: unknown, deps: HealthToolDeps): Promise<HealthToolResult> {
  const args = (rawArgs ?? {}) as HealthArgs
  const now = deps.now?.() ?? Date.now()
  const th = deps.thresholds
  const overdueMs = th.pendingOverdueDays * DAY

  // 与 memory_scan 一致：scope 限定用 visible 语义（global + 该 workspace），
  // 否则健康分与扫描口径不一致，同一个 workspace 会算出两套结论。
  const records = deps.store.query({
    status: ['active', 'stale'],
    ...(args.scope ? { scope: { kind: 'visible' as const, workspacePath: args.scope } } : {}),
  })

  const ruleFindings = [
    ...runRuleScan(records, id => deps.store.get(id), now),
    ...buildMalformedFindings(deps.getQuarantined?.() ?? []),
  ]
  const cached = deps.cache.get(cacheKey(args.scope))
  // 缓存的语义 finding 可能引用已被清理的记忆；读时过滤，否则清理完成后健康分仍在
  // 为已消失的问题扣分，且会与 pendingDecisions 的计数自相矛盾。
  const liveIds = new Set(records.map(r => r.id))
  const semanticFindings = (cached?.findings ?? []).filter(f => f.memoryIds.every(id => liveIds.has(id)))

  const freshnessRatios = records.flatMap(r => {
    const decayDays = deps.registry.get(r.type).decayDays
    return decayDays === null ? [] : [(now - r.lastConfirmedAt) / (decayDays * DAY)]
  })

  const health = computeHealth({
    totalMemories: records.length, ruleFindings, semanticFindings, freshnessRatios,
  })

  const pending = deps.decisions.list()
  const overdue = pending.filter(e => now - e.firstSeenAt >= overdueMs)

  // recommendation 优先级链。secret 永远最高优先、不受档位影响；其余判据用可调阈值。
  let recommendation: string
  if (health.counts.secret > 0) {
    recommendation = `发现 ${health.counts.secret} 条疑似密钥泄漏，建议立即确认并用 memory_forget 删除、轮换凭证`
  } else if (overdue.length > 0) {
    recommendation = `${overdue.length} 条冲突挂起超 ${th.pendingOverdueDays} 天，建议用 memory_confirm 裁决`
  } else if (!cached) {
    recommendation = '尚未做过语义扫描，建议首次运行 memory_scan'
  } else if (now - cached.scannedAt > th.scanStaleDays * DAY) {
    recommendation = `语义扫描已是 ${Math.floor((now - cached.scannedAt) / DAY)} 天前，建议重新运行 memory_scan`
  } else if (health.freshness.staleCount > 0) {
    recommendation = `${health.freshness.staleCount} 条记忆超过衰退期，建议用 memory_confirm 确认或更新`
  } else if (health.score < th.actionScoreThreshold) {
    recommendation = '存在待清理问题，建议运行 memory_scan 查看明细'
  } else if (health.rulePenalty + health.semanticPenalty > 0) {
    // ④：有 findings 但未达提示阈值——不说"无需操作"，软提一句
    const kinds = FINDING_TYPES.filter(t => health.counts[t] > 0).length
    recommendation = `有 ${kinds} 类问题（未达提示阈值），可运行 memory_scan 查看`
  } else {
    recommendation = '记忆库健康，无需操作'
  }

  const semanticNote = cached
    ? `（语义部分基于 ${Math.floor((now - cached.scannedAt) / DAY)} 天前的扫描）`
    : '（从未做过语义扫描，语义问题按 0 计）'

  return {
    score: Math.round(health.score * 100) / 100,
    tier: health.tier,
    breakdown: {
      ruleLayer: {
        secret: health.counts.secret, expired: health.counts.expired,
        bloat: health.counts.bloat, orphan: health.counts.orphan, malformed: health.counts.malformed,
        penalty: Math.round(health.rulePenalty * 100) / 100,
      },
      semanticLayer: {
        conflict: health.counts.conflict, redundancy: health.counts.redundancy,
        misplaced: health.counts.misplaced, unclear: health.counts.unclear,
        penalty: Math.round(health.semanticPenalty * 100) / 100,
        cachedAt: cached?.scannedAt ?? null,
      },
      freshness: {
        avgRatio: Math.round(health.freshness.avgRatio * 100) / 100,
        staleCount: health.freshness.staleCount,
        penalty: Math.round(health.freshness.penalty * 100) / 100,
      },
    },
    pendingDecisions: {
      total: pending.length,
      overdue: overdue.length,
      items: pending.map(e => ({ id: e.id, summary: e.summary, overdue: now - e.firstSeenAt >= overdueMs })),
    },
    totalMemories: records.length,
    recommendation,
    message: `记忆库健康分 ${Math.round(health.score)}/100（${TIER_LABEL[health.tier]}）${semanticNote}。${recommendation}。`,
  }
}
