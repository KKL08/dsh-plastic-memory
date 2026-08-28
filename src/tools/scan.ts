import type { MemoryStore } from '../store.ts'
import type { PendingDecisionsStore } from '../governance/decisions.ts'
import type { KvTable } from '../governance/table.ts'
import type { Finding, ScanCacheEntry } from '../governance/schema.ts'
import { runRuleScan, buildMalformedFindings } from '../governance/rule-scan.ts'
import { runSemanticScan, SEMANTIC_SCAN_MAX_RECORDS, type SemanticLlm } from '../governance/semantic-scan.ts'

export function cacheKey(scope: string | undefined): string {
  return scope ? `cache_${scope}` : 'cache_all'
}

export interface ScanToolDeps {
  store: MemoryStore
  decisions: PendingDecisionsStore
  cache: KvTable<ScanCacheEntry>
  /** 存储层隔离的不可解析记忆文件（FileTable.quarantined）；缺省视为无。 */
  getQuarantined?: () => readonly { path: string; error: string }[]
  getBaseline: () => string | null
  /** 按调用解析（而非加载时一次性解析）——provider/model 只能从触发调用的 exec 上下文里的
   *  agent 拿到，插件加载时不存在。null = 当前环境拿不到 LLM 或解析不出 provider/model
   *  （语义层跳过并说明） */
  getLlm: (exec: unknown) => SemanticLlm | null
  now?: () => number
}

export interface ScanArgs {
  scope?: string
  layers?: 'rule' | 'semantic' | 'full'
}

export interface ScanToolResult {
  findings: Finding[]
  pendingDecisions: {
    created: number
    existing: number
    items: Array<{ id: string; memoryIds: string[]; summary: string; isNew: boolean }>
  }
  stats: { scanned: number; clean: number; issues: number; byType: Record<string, number> }
  /** global 提升候选：模型存时标了 globalCandidate 的 workspace 记忆，待用户确认后 memory_promote。 */
  promoteCandidates: { items: Array<{ id: string; summary: string }>; more: number }
  semanticCachedAt: number | null
  notes: string[]
  message: string
}

/** 提升候选一次最多列这些，其余折叠——不让治理报告被候选淹没。 */
const PROMOTE_LIMIT = 5

/** 把扫描结果渲染成给模型看的一段文本。纯函数。 */
export function renderScanResult(result: ScanToolResult): string {
  const lines = [result.message]
  for (const f of result.findings) {
    lines.push(`- [${f.severity}] ${f.type} ${f.memoryIds.join('+')}：${f.summary} → ${f.suggestedAction}`)
  }
  // 证据下钻提示（设计 evidence-anchor §6）：治理裁决是高赌注不可逆动作，下钻引导不低于 strict
  if (result.findings.some(f => f.type === 'expired')) {
    lines.push('过期候选可先用 memory_source 回查出处，向用户复述当时语境，再决定 refresh 还是 forget。')
  }
  if (result.pendingDecisions.items.length > 0) {
    lines.push('待裁决冲突（用 memory_confirm resolve 裁决，需 decisionId）：')
    for (const item of result.pendingDecisions.items) {
      lines.push(`- [${item.id}] ${item.summary}`)
    }
    lines.push('裁决前可用 memory_source 回查双方记忆的原始出处（当时谁说的、什么语境）；与 AGENTS.md 基线的垂直冲突请核对当前基线内容，不必回查旧会话。')
  }
  if (result.promoteCandidates.items.length > 0) {
    lines.push('建议提升全局（模型标记，需你确认后用 memory_promote 提升；不确认就留在项目内）：')
    for (const c of result.promoteCandidates.items) {
      lines.push(`- [${c.id}] ${c.summary}`)
    }
    if (result.promoteCandidates.more > 0) lines.push(`  …另有 ${result.promoteCandidates.more} 条提升候选未列出`)
    lines.push('提升前可用 memory_source 回查候选的出生语境，确认当时确实是跨项目通用的表述、不是项目绑定的顺口一句。')
  }
  return lines.join('\n')
}

/**
 * memory_scan（设计稿 §7.2）：只读+报告。副作用仅两个——语义结果写 scan_cache、
 * conflict 进 pending_decisions。清理动作由模型经用户确认后调 forget/save 执行。
 */
export async function executeScan(rawArgs: unknown, deps: ScanToolDeps, exec?: unknown): Promise<ScanToolResult> {
  const args = (rawArgs ?? {}) as ScanArgs
  const layers = args.layers ?? 'full'
  const now = deps.now?.() ?? Date.now()
  const notes: string[] = []

  // 治理要覆盖"在该 workspace 实际生效"的记忆集合——即模型能看到的集合（P0 注入语境用的同一套 visible 语义）。
  // 用比它窄的 workspace-only 过滤会让 global 里的问题（含最高危的 secret）对所有限定 scope 的扫描隐身。
  const records = deps.store.query({
    status: ['active', 'stale'],
    ...(args.scope ? { scope: { kind: 'visible' as const, workspacePath: args.scope } } : {}),
  })

  const findings: Finding[] = []
  if (layers === 'rule' || layers === 'full') {
    findings.push(...runRuleScan(records, id => deps.store.get(id), now))
    findings.push(...buildMalformedFindings(deps.getQuarantined?.() ?? []))
  }

  const key = cacheKey(args.scope)
  let semanticCachedAt: number | null = deps.cache.get(key)?.scannedAt ?? null
  if (layers === 'semantic' || layers === 'full') {
    const llm = deps.getLlm(exec)
    if (!llm) {
      notes.push(layers === 'semantic'
        ? '语义层不可用（当前环境拿不到 LLM），且 layers=semantic 不含规则层，本次未执行任何检测'
        : '语义层不可用（当前环境拿不到 LLM），只返回规则层结果')
    } else {
      const baseline = deps.getBaseline()
      if (baseline === null) notes.push('未检测到 AGENTS.md 基线，垂直冲突检测未执行')
      const semantic = await runSemanticScan(records, baseline, llm)
      if (semantic.truncated) {
        notes.push(`记忆过多，本次语义层只分析了前 ${SEMANTIC_SCAN_MAX_RECORDS} 条，另有 ${semantic.truncated} 条未分析`)
      }
      if (semantic.failed) {
        notes.push('语义分析失败（LLM 输出无法解析，已重试一次），本次未更新语义缓存')
      } else {
        findings.push(...semantic.findings)
        await deps.cache.put(key, { id: key, scannedAt: now, scope: args.scope ?? 'all', findings: semantic.findings })
        semanticCachedAt = now
      }
    }
  }

  // conflict → 待决账本（不自动裁决）
  let created = 0
  let existing = 0
  const items: ScanToolResult['pendingDecisions']['items'] = []
  for (const f of findings) {
    if (f.type !== 'conflict') continue
    const r = await deps.decisions.upsert({
      memoryIds: f.memoryIds,
      ...(f.baselineRef !== undefined ? { baselineRef: f.baselineRef } : {}),
      summary: f.summary,
    }, now)
    if (r.created) created++
    else existing++
    items.push({ id: r.entry.id, memoryIds: r.entry.memoryIds, summary: r.entry.summary, isNew: r.created })
  }

  const problemIds = new Set(findings.flatMap(f => f.memoryIds))
  const byType: Record<string, number> = {}
  for (const f of findings) byType[f.type] = (byType[f.type] ?? 0) + 1
  const stats = {
    scanned: records.length,
    clean: records.filter(r => !problemIds.has(r.id)).length,
    issues: findings.length,
    byType,
  }

  // global 提升候选：只吃模型主动标的 globalCandidate（不掺 misplaced——它双向，该降级的会被误列）。限流。
  const allCandidates = records.filter(r => r.globalCandidate).map(r => ({ id: r.id, summary: r.summary }))
  const promoteCandidates = {
    items: allCandidates.slice(0, PROMOTE_LIMIT),
    more: Math.max(0, allCandidates.length - PROMOTE_LIMIT),
  }

  const noteSuffix = notes.length > 0 ? `（${notes.join('；')}）` : ''
  return {
    findings, pendingDecisions: { created, existing, items }, stats, promoteCandidates, semanticCachedAt, notes,
    message: `扫描 ${stats.scanned} 条记忆，发现 ${stats.issues} 个问题${created > 0 ? `，新增 ${created} 个待决冲突` : ''}${promoteCandidates.items.length > 0 ? `，${allCandidates.length} 条建议提升全局` : ''}${noteSuffix}。清理需用户确认后执行：删除用 memory_forget，冲突裁决用 memory_confirm，提升全局用 memory_promote。`,
  }
}
