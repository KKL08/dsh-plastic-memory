import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { MemoryStore } from '../store.ts'
import type { HealthRecommendationKind } from '../contract-codes.ts'
import type { TypeRegistry } from '../type-registry.ts'
import { overflowLevelOf, overflowScopeOf, type PendingDecisionsStore } from '../governance/decisions.ts'
import type { KvTable } from '../kv-table.ts'
import type { ScanCacheEntry } from '../governance/schema.ts'
import { FINDING_TYPES } from '../governance/schema.ts'
import type { HealthThresholds } from '../governance/health-presets.ts'
import { runRuleScan } from '../governance/rule-scan.ts'
import { scoreLayer, listWorkspaces, validateScopePaths, crossLayerConflicts, checkupRowBase, ignoredNote, type LayerRef, TIER_LABEL } from '../governance/layer-health.ts'
import type { AdviceIgnoreStore } from '../governance/advice-ignores.ts'
import type { CheckupRecordStore } from '../governance/checkup-records.ts'
import type { DirectoryNote } from '../storage/table.ts'
import { prereadLayers, listingNotes, checkupWorkspaces, renderDirectoryNotes } from './layer-preread.ts'
import { decisionWorkspaces, decisionWorkspacesNote } from './workspace-gate.ts'

const DAY = 86_400_000

/** tier 枚举 → 用户面中文文案（结构化 tier 字段仍保留 green/amber/red 供程序用）。 */
export { TIER_LABEL }

export interface HealthToolDeps {
  store: MemoryStore
  registry: TypeRegistry
  decisions: PendingDecisionsStore
  cache: KvTable<ScanCacheEntry>
  /** 建议忽略表：被用户忽略的建议不扣分（与记忆页同口径）。缺省按没有忽略算。 */
  ignores?: Pick<AdviceIgnoreStore, 'list'>
  /** 体检记录表：上次体检取它的完成记录。缺省按没有完成记录算（取语义缓存的时间）。 */
  checkups?: Pick<CheckupRecordStore, 'list'>
  /** 触发阈值（由 index.ts 从 sensitivity 预设解析后注入）。 */
  thresholds: HealthThresholds
  /** 当前会话的 workspace（默认口径"当前项目"的来源）。 */
  resolveContext: (exec: ToolRunContext) => Promise<{ workspacePath: string | undefined }>
  now?: () => number
}

export interface HealthArgs {
  /** 缺省=当前 workspace（无 workspace 会话退到 global 层）；'all'=全库分层体检；具体路径=该 workspace。 */
  scope?: string
}

export interface SingleHealthResult {
  kind: 'single'
  layer: 'workspace' | 'global'
  workspacePath?: string
  score: number
  tier: 'green' | 'amber' | 'red'
  /** 红线门：secret 存在即判死（tier 强制 red）。 */
  gate: { secret: boolean }
  breakdown: {
    ruleLayer: { secret: number; expired: number; bloat: number; orphan: number; malformed: number; penalty: number }
    semanticLayer: { conflict: number; redundancy: number; misplaced: number; unclear: number; penalty: number; cachedAt: number | null }
    freshness: { avgRatio: number; staleCount: number; penalty: number }
  }
  pendingDecisions: {
    total: number
    overdue: number
    /** overdue 判定用的阈值天数（随 sensitivity 档位变化），渲染文案据此显示"超 N 天"。 */
    overdueDays: number
    items: Array<{ id: string; memoryIds: string[]; workspaces: string[]; summary: string; overdue: boolean }>
  }
  totalMemories: number
  /** 用户在记忆页忽略、没有计分的建议条数。 */
  ignoredCount: number
  /** 本层的全局提升候选数（闲时才进 recommendation 文本，字段常在）。 */
  promoteCandidates: number
  /** workspace 视图下 global 层检出的疑似密钥条数——不计本层分数，但必须报警。 */
  globalSecretAlert: number
  /** 本层会话带入的记忆超出上限（含已忽略的）：列为问题、不扣分。没超为 null。summary 是账本里的说明。 */
  overflow: { mode: 'relax' | 'strict'; tier: number; summary: string } | null
  recommendation: string
  /** recommendation 的结构化对应：独占层单元素、行动项层多元素（按代码顺序）、无事为空数组。 */
  recommendationKinds: HealthRecommendationKind[]
  /** 本次读取的目录级说明：缺标记 / 不可读目录、含保留键的文件、同 id 副本。 */
  directoryNotes: DirectoryNote[]
  message: string
}

export interface CheckupRow {
  layer: 'workspace' | 'global'
  workspacePath?: string
  totalMemories: number
  score: number
  tier: 'green' | 'amber' | 'red'
  gate: { secret: boolean }
  /** 上次体检（完成记录；升级前体检过、还没有完成记录的取语义缓存时间）。 */
  semanticCachedAt: number | null
  promoteCandidates: number
  /** 供表格"主要问题"列：非零的问题类计数。 */
  issueSummary: string
  /** 用户忽略、没有计分的建议条数。 */
  ignoredCount: number
}

export interface CheckupHealthResult {
  kind: 'checkup'
  rows: CheckupRow[]
  /** 同一条 global 记忆与 ≥2 个 workspace 存在待决冲突：被多数项目反对，优先裁定。 */
  crossLayerConflicts: Array<{ globalId: string; workspaces: string[]; decisionIds: string[] }>
  promoteCandidates: { total: number; byWorkspace: Array<{ workspacePath: string; count: number }> }
  pendingTotal: number
  /** 全库目录级说明：缺标记 / 不可读 / 只剩归档的目录、含保留键的文件、同 id 副本（含跨项目副本）。 */
  directoryNotes: DirectoryNote[]
  message: string
}

/** scope 里出现无法识别的 workspace 时快速失败——静默算错层比报错危险得多。 */
export interface HealthErrorResult {
  kind: 'error'
  message: string
}

export type HealthToolResult = SingleHealthResult | CheckupHealthResult | HealthErrorResult

/** 把健康检查结果渲染成给模型看的一段文本。纯函数。 */
export function renderHealthResult(result: HealthToolResult): string {
  if (result.kind === 'error') return result.message
  if (result.kind === 'checkup') {
    const lines = [result.message]
    for (const row of result.rows) {
      const name = row.layer === 'global' ? 'global' : row.workspacePath!
      const gateNote = row.gate.secret ? '｜⚠️ 检出密钥' : ''
      lines.push(`- ${name}：${Math.floor(row.score)}/100（${TIER_LABEL[row.tier]}）｜${row.totalMemories} 条｜${row.issueSummary}${gateNote}`)
    }
    const ignored = ignoredNote(result.rows.reduce((n, row) => n + row.ignoredCount, 0))
    if (ignored !== undefined) lines.push(ignored)
    for (const c of result.crossLayerConflicts) {
      lines.push(`⚠️ 跨层冲突：global ${c.globalId} 与 ${c.workspaces.length} 个项目存在待决冲突（${c.workspaces.join('、')}）——被多数项目反对的全局规则建议优先裁定（memory_confirm resolve：${c.decisionIds.join('、')}）`)
    }
    if (result.promoteCandidates.total > 0) {
      const detail = result.promoteCandidates.byWorkspace.map(w => `${w.workspacePath} ${w.count} 条`).join('、')
      lines.push(`提升候选合计 ${result.promoteCandidates.total} 条（${detail}），经用户确认后用 memory_promote 提升；用户拒绝的用 dismiss 清除标记。`)
    }
    lines.push(...renderDirectoryNotes(result.directoryNotes))
    return lines.join('\n')
  }

  const { breakdown } = result
  const lines = [result.message]
  lines.push(
    `规则层扣分 ${breakdown.ruleLayer.penalty}（secret ${breakdown.ruleLayer.secret} / expired ${breakdown.ruleLayer.expired} / bloat ${breakdown.ruleLayer.bloat} / orphan ${breakdown.ruleLayer.orphan} / malformed ${breakdown.ruleLayer.malformed}）；`
    + `语义层扣分 ${breakdown.semanticLayer.penalty}（conflict ${breakdown.semanticLayer.conflict} / redundancy ${breakdown.semanticLayer.redundancy} / misplaced ${breakdown.semanticLayer.misplaced} / unclear ${breakdown.semanticLayer.unclear}）；`
    + `新鲜度扣分 ${breakdown.freshness.penalty}（${breakdown.freshness.staleCount} 条超期）`,
  )
  const ignored = ignoredNote(result.ignoredCount)
  if (ignored !== undefined) lines.push(ignored)
  if (result.overflow !== null) lines.push(`超出上限（不扣分）：${result.overflow.summary}`)
  if (result.pendingDecisions.items.length > 0) {
    lines.push('待裁决冲突（memory_confirm resolve）：')
    for (const item of result.pendingDecisions.items) {
      lines.push(`- [${item.id}] ${item.summary}${decisionWorkspacesNote(item.workspaces)}${item.overdue ? `（挂起超 ${result.pendingDecisions.overdueDays} 天）` : ''}`)
    }
  }
  lines.push(...renderDirectoryNotes(result.directoryNotes))
  return lines.join('\n')
}

/**
 * memory_health：纯读取。规则层实时算 + 语义层读 scan_cache + 新鲜度轴。
 * 从未 scan 时语义计 0，不因缺语义数据压分。
 * 默认口径=当前 workspace（占比分母是本项目规模，不被跨项目聚合稀释）；
 * scope='all' 输出各 workspace 分数表 + global 层（零成本，无需用户确认）。
 */
export async function executeHealth(rawArgs: HealthArgs, deps: HealthToolDeps, exec: ToolRunContext): Promise<HealthToolResult> {
  const args = rawArgs
  const now = deps.now?.() ?? Date.now()
  const th = deps.thresholds
  const overdueMs = th.pendingOverdueDays * DAY
  // 预读范围：与 memory_scan 共用 prereadLayers——目标层（含 .archive/）的全部状态记录、层外引用按 id 定位、
  // 待决账本、语义缓存、按层归档的隔离文件；之后的评分与聚合都是同步纯计算。
  // 目录枚举只读标记与文件名：体检清单、scope 校验、缺标记 / 不可读目录的说明都出自它
  const listing = await deps.store.listWorkspaceDirs()

  if (args.scope === 'all') {
    // 全库：global + 体检清单里的全部 workspace 目录
    const data = await prereadLayers(deps, [{ kind: 'global' }, ...checkupWorkspaces(listing).map(path => ({ kind: 'workspace' as const, path }))])
    const layers: LayerRef[] = [{ kind: 'global' }, ...listWorkspaces(data.byId.values()).map(path => ({ kind: 'workspace' as const, path }))]
    const scored = layers.map(l => scoreLayer(deps, data, l, now))
    const rows: CheckupRow[] = scored.map(r => ({
      ...checkupRowBase(r),
      semanticCachedAt: r.lastCheckupAt,
      promoteCandidates: r.promoteCandidates,
    }))

    const byWorkspace = rows
      .filter(r => r.layer === 'workspace' && r.promoteCandidates > 0)
      .map(r => ({ workspacePath: r.workspacePath!, count: r.promoteCandidates }))
    const promoteCandidates = { total: byWorkspace.reduce((s, w) => s + w.count, 0), byWorkspace }

    const wsCount = rows.length - 1
    return {
      kind: 'checkup', rows,
      crossLayerConflicts: crossLayerConflicts(data.byId, data.pending),
      promoteCandidates,
      pendingTotal: data.pending.length,
      directoryNotes: [...listingNotes(listing, { includeEmpty: true }), ...data.directoryNotes],
      message: `全库健康体检：global + ${wsCount} 个 workspace，各层独立计分（分母为该层自身规模）。`,
    }
  }

  // 单层视图：显式路径 > 当前会话 workspace > global 层（无 workspace 会话）
  const currentWs = exec !== undefined ? (await deps.resolveContext(exec)).workspacePath : undefined
  if (args.scope !== undefined) {
    const invalid = validateScopePaths(checkupWorkspaces(listing), currentWs, [args.scope])
    if (invalid !== null) return { kind: 'error', message: invalid }
  }
  const wsPath = args.scope ?? currentWs
  const layer: LayerRef = wsPath !== undefined ? { kind: 'workspace', path: wsPath } : { kind: 'global' }
  // 单层：目标层 + global（workspace 视图要兜住 global 层的密钥，待决项也看 global 一侧）
  const data = await prereadLayers(deps, layer.kind === 'workspace' ? [layer, { kind: 'global' }] : [layer], wsPath)
  const scored = scoreLayer(deps, data, layer, now)
  const { health, records } = scored
  const globalActive = [...data.byId.values()].filter(r => r.status === 'active' && r.scope === 'global')
  // 语义部分的时间按上次体检算（完成记录），不按缓存
  const cachedAt = scored.lastCheckupAt

  // workspace 视图必须兜住 global 层的密钥——它在本会话同样生效，但归属（与修复责任）在 global 层，
  // 不计本层分数，走报警 + recommendation 置顶
  let globalSecretAlert = 0
  if (layer.kind === 'workspace') {
    globalSecretAlert = runRuleScan(globalActive, id => data.byId.get(id), now).filter(f => f.type === 'secret').length
  }

  // 待决项列可见集合（本层 + global——跨层冲突影响本 workspace 的会话）内的
  const visibleIds = new Set([
    ...records.map(r => r.id),
    ...(layer.kind === 'workspace' ? globalActive.map(r => r.id) : []),
  ])
  const pending = data.pending.filter(e => e.memoryIds.every(id => visibleIds.has(id)))
  const overdue = pending.filter(e => now - e.firstSeenAt >= overdueMs)
  // 超限按会话所属项目记账（无项目的会话记在 global）：列为问题，不进评分
  const overflowEntry = (await deps.decisions.listOverflow()).find(e => overflowScopeOf(e) === (layer.kind === 'global' ? 'global' : layer.path))
  const overflow = overflowEntry === undefined ? null : { ...overflowLevelOf(overflowEntry), summary: overflowEntry.summary }

  // recommendation 分层并列。独占层：密钥（本层红线或 global 报警）永远最高、不受档位
  // 影响，出现时不并列其他建议（避免稀释警报）。行动项层：条件独立成立的全部列出——
  // 单选链会让先命中的分支埋没档位早提示，sensitivity 差异在输出上失明。
  // 闲时层：提升候选是唯一的"闲时事务"——只在没有任何行动项时露出，避免粘性候选反复打扰
  let recommendation: string
  const recommendationKinds: HealthRecommendationKind[] = []
  if (health.gate.secret) {
    recommendationKinds.push('secret')
    recommendation = `发现 ${health.counts.secret} 条疑似密钥泄漏，建议立即确认并用 memory_forget 删除、轮换凭证`
  } else if (globalSecretAlert > 0) {
    recommendationKinds.push('global-secret')
    recommendation = `global 层检出 ${globalSecretAlert} 条疑似密钥泄漏（不计本项目分数），建议立即确认并用 memory_forget 删除、轮换凭证`
  } else {
    const actions: string[] = []
    if (overdue.length > 0) recommendationKinds.push('pending-overdue')
    if (overdue.length > 0) actions.push(`${overdue.length} 条冲突挂起超 ${th.pendingOverdueDays} 天，建议用 memory_confirm 裁决`)
    if (overflow !== null) recommendationKinds.push('budget-overflow')
    if (overflow !== null) actions.push(`${overflow.summary}（不扣分），建议整理记忆或调高 snapshotTokenBudget`)
    if (cachedAt === null) recommendationKinds.push('semantic-never-scanned')
    else if (now - cachedAt > th.scanStaleDays * DAY) recommendationKinds.push('semantic-stale')
    if (cachedAt === null) actions.push('尚未做过语义扫描，建议首次运行 memory_scan')
    else if (now - cachedAt > th.scanStaleDays * DAY) actions.push(`语义扫描已是 ${Math.floor((now - cachedAt) / DAY)} 天前，建议重新运行 memory_scan`)
    if (health.freshness.staleCount > 0) recommendationKinds.push('freshness-stale')
    if (health.freshness.staleCount > 0) actions.push(`${health.freshness.staleCount} 条记忆超过衰退期，建议用 memory_confirm 确认或更新`)
    if (health.score < th.actionScoreThreshold) recommendationKinds.push('score-below-threshold')
    else if (health.rulePenalty + health.semanticPenalty > 0) recommendationKinds.push('issues-below-threshold')
    if (health.score < th.actionScoreThreshold) actions.push('存在待清理问题，建议运行 memory_scan 查看明细')
    else if (health.rulePenalty + health.semanticPenalty > 0) {
      const kinds = FINDING_TYPES.filter(t => health.counts[t] > 0).length
      actions.push(`有 ${kinds} 类问题（未达提示阈值），可运行 memory_scan 查看`)
    }
    if (actions.length === 0 && scored.promoteCandidates > 0) recommendationKinds.push('promote-candidates')
    recommendation = actions.length > 0 ? actions.join('；')
      : scored.promoteCandidates > 0
        ? `本项目有 ${scored.promoteCandidates} 条全局提升候选待确认——可发起确认后用 memory_promote 提升；用户拒绝的用 dismiss 清除标记，之后不再提示`
        : '记忆库健康，无需操作'
  }

  const semanticNote = cachedAt !== null
    ? `（语义部分基于 ${Math.floor((now - cachedAt) / DAY)} 天前的扫描）`
    : '（从未做过语义扫描，语义问题按 0 计）'
  const layerLabel = layer.kind === 'global' ? 'global 记忆'
    : wsPath === currentWs ? '本项目记忆'
    : `workspace ${wsPath} 记忆`
  const gateNote = health.gate.secret ? '（检出密钥，红线判定）' : ''

  return {
    kind: 'single',
    layer: layer.kind,
    ...(layer.kind === 'workspace' ? { workspacePath: layer.path } : {}),
    score: Math.round(health.score * 100) / 100,
    tier: health.tier,
    gate: health.gate,
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
        cachedAt,
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
      overdueDays: th.pendingOverdueDays,
      items: pending.map(e => ({
        id: e.id, memoryIds: e.memoryIds, workspaces: decisionWorkspaces(e, id => data.byId.get(id)),
        summary: e.summary, overdue: now - e.firstSeenAt >= overdueMs,
      })),
    },
    totalMemories: records.length,
    ignoredCount: scored.ignored.length,
    promoteCandidates: scored.promoteCandidates,
    globalSecretAlert,
    overflow,
    recommendation,
    recommendationKinds,
    directoryNotes: [...listingNotes(listing, { includeEmpty: false }), ...data.directoryNotes],
    message: `${layerLabel}健康分 ${Math.floor(health.score)}/100（${TIER_LABEL[health.tier]}）${gateNote}${semanticNote}。${recommendation}。`,
  }
}
