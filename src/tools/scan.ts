import type { MemoryStore } from '../store.ts'
import type { CodedNote, ScanNoteCode } from '../contract-codes.ts'
import type { TypeRegistry } from '../type-registry.ts'
import type { MemoryRecord } from '../record-schema.ts'
import type { PendingDecisionsStore } from '../governance/decisions.ts'
import type { KvTable } from '../kv-table.ts'
import type { Finding, ScanCacheEntry } from '../governance/schema.ts'
import { runRuleScan, buildMalformedFindings } from '../governance/rule-scan.ts'
import { runSemanticScan, SEMANTIC_SCAN_MAX_RECORDS, type SemanticLlm } from '../governance/semantic-scan.ts'
import { scoreLayer, listWorkspaces, validateScopePaths, crossLayerConflicts, checkupRowBase, GLOBAL_CACHE_KEY, type LayerRef } from '../governance/layer-health.ts'
import { join, sep } from 'node:path'
import { workspaceDirName, GLOBAL_DIR } from '../storage/paths.ts'
import { runCrossWsScan, findEntityDuplicates, type CrossWsDuplicate } from '../governance/cross-ws.ts'

export function cacheKey(scope: string | undefined): string {
  return scope ? `cache_${scope}` : GLOBAL_CACHE_KEY
}

export interface ScanToolDeps {
  store: MemoryStore
  registry: TypeRegistry
  decisions: PendingDecisionsStore
  cache: KvTable<ScanCacheEntry>
  /** 存储层隔离的不可解析记忆文件（FileTable.quarantined）；缺省视为无。 */
  getQuarantined?: () => readonly { path: string; error: string }[]
  /** malformed 按文件路径归层需要根目录；缺省不归层。 */
  memoryRoot?: string
  /** 按触发调用的 session 取该会话的 AGENTS.md/CLAUDE.md 基线（BaselineCache 按 session 隔离）。 */
  getBaseline: (exec: unknown) => string | null
  /** 按调用解析（而非加载时一次性解析）——provider/model 只能从触发调用的 exec 上下文里的
   *  agent 拿到，插件加载时不存在。null = 当前环境拿不到 LLM 或解析不出 provider/model
   *  （语义层跳过并说明） */
  getLlm: (exec: unknown) => SemanticLlm | null
  /** 当前会话的 workspace（默认口径"当前项目"的来源）。 */
  resolveContext: (exec: unknown) => Promise<{ workspacePath: string | undefined }>
  now?: () => number
}

export interface ScanArgs {
  /** 缺省=当前 workspace；'all'=全库体检（调用前须经 ask_user_question 确认范围）；具体路径=该 workspace。 */
  scope?: string
  /** 用户勾选的体检范围（workspace 路径列表）；给出时忽略 scope。 */
  scopes?: string[]
  layers?: 'rule' | 'semantic' | 'full'
}

export interface SingleScanResult {
  kind: 'single'
  layer: 'workspace' | 'global'
  workspacePath?: string
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
  notes: ScanNote[]
  message: string
}

export interface CheckupScanResult {
  kind: 'checkup'
  rows: Array<{
    layer: 'workspace' | 'global'
    workspacePath?: string
    totalMemories: number
    score: number
    tier: 'green' | 'amber' | 'red'
    gate: { secret: boolean }
    issues: number
    issueSummary: string
  }>
  pendingDecisions: {
    created: number
    existing: number
    items: Array<{ id: string; memoryIds: string[]; summary: string; isNew: boolean }>
  }
  /** 同一条 global 记忆与 ≥2 个 workspace 的待决冲突：被多数项目反对，优先裁定。 */
  crossLayerConflicts: Array<{ globalId: string; workspaces: string[]; decisionIds: string[] }>
  promoteCandidates: { total: number; byWorkspace: Array<{ workspacePath: string; items: Array<{ id: string; summary: string }> }> }
  /** 跨项目重复主题（global 缺口）：语义层主力，LLM 不可用时实体聚类保底（疑似级）。 */
  duplicates: { items: CrossWsDuplicate[]; via: 'semantic' | 'entity' | 'none' }
  notes: ScanNote[]
  message: string
}

/** scope/scopes 里出现无法识别的 workspace 时快速失败——静默扫错层比报错危险得多。 */
export interface ScanErrorResult {
  kind: 'error'
  message: string
}

export type ScanToolResult = SingleScanResult | CheckupScanResult | ScanErrorResult

/** 提升候选一次最多列这些，其余折叠——不让治理报告被候选淹没。 */
const PROMOTE_LIMIT = 5

/** 把扫描结果渲染成给模型看的一段文本。纯函数。 */
export function renderScanResult(result: ScanToolResult): string {
  if (result.kind === 'error') return result.message
  if (result.kind === 'checkup') {
    const lines = [result.message]
    const tierLabel = { green: '绿色', amber: '黄色', red: '红色' } as const
    for (const row of result.rows) {
      const name = row.layer === 'global' ? 'global' : row.workspacePath!
      const gateNote = row.gate.secret ? '｜⚠️ 检出密钥' : ''
      lines.push(`- ${name}：${Math.floor(row.score)}/100（${tierLabel[row.tier]}）｜${row.totalMemories} 条｜${row.issueSummary}${gateNote}`)
    }
    for (const c of result.crossLayerConflicts) {
      lines.push(`⚠️ 跨层冲突：global ${c.globalId} 与 ${c.workspaces.length} 个项目存在待决冲突（${c.workspaces.join('、')}）——被多数项目反对的全局规则建议优先裁定（memory_confirm resolve：${c.decisionIds.join('、')}）`)
    }
    if (result.pendingDecisions.items.length > 0) {
      lines.push('待裁决冲突（用 memory_confirm resolve 裁决，需 decisionId）：')
      for (const item of result.pendingDecisions.items) {
        lines.push(`- [${item.id}] ${item.summary}`)
      }
    }
    if (result.promoteCandidates.total > 0) {
      lines.push(`建议提升全局（共 ${result.promoteCandidates.total} 条，需用户确认后 memory_promote；用户拒绝的用 dismiss 清除标记）：`)
      for (const ws of result.promoteCandidates.byWorkspace) {
        for (const c of ws.items) lines.push(`- [${c.id}] ${c.summary}（${ws.workspacePath}）`)
      }
    }
    if (result.duplicates.items.length > 0) {
      const via = result.duplicates.via === 'entity' ? '（实体聚类保底，疑似级线索）' : ''
      lines.push(`global 缺口${via}——多个项目重复记录、global 缺位的主题：`)
      for (const d of result.duplicates.items) {
        lines.push(`- ${d.topic}（${d.workspaces.join('、')}）：${d.suggestion}`)
      }
      lines.push('确认确属通用后，可提炼一条 global 记忆经用户确认提升。')
    }
    if (result.notes.length > 0) lines.push(`（${result.notes.map(n => n.text).join('；')}）`)
    return lines.join('\n')
  }

  const lines = [result.message]
  for (const f of result.findings) {
    lines.push(`- [${f.severity}] ${f.type} ${f.memoryIds.join('+')}：${f.summary} → ${f.suggestedAction}`)
  }
  // 证据下钻提示：治理裁决是高赌注不可逆动作，下钻引导不低于 strict
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
    lines.push('建议提升全局（模型标记，需你确认后用 memory_promote 提升；用户拒绝的用 dismiss 清除标记）：')
    for (const c of result.promoteCandidates.items) {
      lines.push(`- [${c.id}] ${c.summary}`)
    }
    if (result.promoteCandidates.more > 0) lines.push(`  …另有 ${result.promoteCandidates.more} 条提升候选未列出`)
    lines.push('提升前可用 memory_source 回查候选的出生语境，确认当时确实是跨项目通用的表述、不是项目绑定的顺口一句。')
  }
  return lines.join('\n')
}

/** 扫描过程的说明条目：code 稳定供程序判断，text 给人/模型看。 */
export type ScanNote = CodedNote<ScanNoteCode>

interface ScanPass {
  findings: Finding[]
  scanned: number
  semanticCachedAt: number | null
  notes: ScanNote[]
  decisionItems: Array<{ id: string; memoryIds: string[]; summary: string; isNew: boolean }>
  created: number
  existing: number
}

/** 一次记录集的完整扫描（规则 + 语义 + 冲突挂账）。单层模式与体检的每层循环共用。 */
async function scanPass(
  deps: ScanToolDeps,
  records: MemoryRecord[],
  bucket: string,
  scopeLabel: string,
  quarantined: readonly { path: string; error: string }[],
  layers: 'rule' | 'semantic' | 'full',
  llm: SemanticLlm | null,
  baseline: string | null,
  now: number,
  signal?: AbortSignal,
): Promise<ScanPass> {
  const notes: ScanNote[] = []
  const findings: Finding[] = []
  if (layers === 'rule' || layers === 'full') {
    findings.push(...runRuleScan(records, id => deps.store.get(id), now))
    findings.push(...buildMalformedFindings(quarantined))
  }

  let semanticCachedAt: number | null = deps.cache.get(bucket)?.scannedAt ?? null
  if (layers === 'semantic' || layers === 'full') {
    if (!llm) {
      notes.push(layers === 'semantic'
        ? { code: 'no-layer-executed', text: '语义层不可用（当前环境拿不到 LLM），且 layers=semantic 不含规则层，本次未执行任何检测' }
        : { code: 'semantic-unavailable', text: '语义层不可用（当前环境拿不到 LLM），只返回规则层结果' })
    } else {
      // 截断前按治理优先级 + 新近度排序：库超上限时先分析重要且新的，而不是任意文件序的前 N 条
      const priorityOrder = { high: 0, medium: 1, low: 2 } as const
      const ordered = [...records].sort((a, b) =>
        priorityOrder[deps.registry.get(a.type).governancePriority] - priorityOrder[deps.registry.get(b.type).governancePriority]
        || b.updatedAt - a.updatedAt)
      const semantic = await runSemanticScan(ordered, baseline, llm, signal)
      if (semantic.truncated) {
        notes.push({ code: 'semantic-truncated', text: `记忆过多，本次语义层只分析了前 ${SEMANTIC_SCAN_MAX_RECORDS} 条（按治理优先级与新近度挑选），另有 ${semantic.truncated} 条未分析` })
      }
      if (semantic.failed) {
        notes.push({ code: 'semantic-failed', text: '语义分析失败（LLM 输出无法解析，已重试一次），本次未更新语义缓存' })
      } else {
        findings.push(...semantic.findings)
        // 写缓存前设检查点：取消后不留下半截的语义结果。
        signal?.throwIfAborted()
        await deps.cache.put(bucket, { id: bucket, scannedAt: now, scope: scopeLabel, findings: semantic.findings })
        semanticCachedAt = now
      }
    }
  }

  // conflict → 待决账本（不自动裁决）
  let created = 0
  let existing = 0
  const decisionItems: ScanPass['decisionItems'] = []
  // 挂账前设检查点：取消后不再往 pending_decisions 写新冲突。
  signal?.throwIfAborted()
  for (const f of findings) {
    if (f.type !== 'conflict') continue
    const r = await deps.decisions.upsert({
      memoryIds: f.memoryIds,
      ...(f.baselineRef !== undefined ? { baselineRef: f.baselineRef } : {}),
      summary: f.summary,
    }, now)
    if (r.created) created++
    else existing++
    decisionItems.push({ id: r.entry.id, memoryIds: r.entry.memoryIds, summary: r.entry.summary, isNew: r.created })
  }

  return { findings, scanned: records.length, semanticCachedAt, notes, decisionItems, created, existing }
}

/**
 * memory_scan：只读+报告。副作用仅两个——语义结果写 scan_cache、conflict 进 pending_decisions。
 * 清理动作由模型经用户确认后调 forget/save 执行。
 * 默认口径=当前 workspace 的可见集合（global + 本项目）；scope='all' 或 scopes 列表进入
 * 全库体检：逐 workspace 独立扫描计分 + global 层专项（缺口检测、跨层冲突聚合）。
 */
export async function executeScan(rawArgs: ScanArgs, deps: ScanToolDeps, exec?: unknown): Promise<ScanToolResult> {
  const args = rawArgs
  const layers = args.layers ?? 'full'
  // 用户取消信号（宿主 exec.signal 契约）：每个语义调用透传，各写入前设检查点。
  const signal = (exec as { signal?: AbortSignal } | undefined)?.signal
  const now = deps.now?.() ?? Date.now()
  const quarantined = deps.getQuarantined?.() ?? []
  const llm = deps.getLlm(exec)
  const baseline = deps.getBaseline(exec)
  const currentWs = exec !== undefined ? (await deps.resolveContext(exec)).workspacePath : undefined
  // malformed 按扫描层归属（与 memory_health 的 scoreLayer 同口径），无 memoryRoot 时不归层
  const layerQuarantined = (ws: string | undefined) => {
    if (deps.memoryRoot === undefined) return quarantined
    const dir = join(deps.memoryRoot, ws === undefined ? GLOBAL_DIR : workspaceDirName(ws))
    return quarantined.filter(q => q.path.startsWith(dir + sep))
  }

  const checkup = args.scope === 'all' || (args.scopes !== undefined && args.scopes.length > 0)
  {
    const requested = checkup
      ? args.scopes ?? []
      : args.scope !== undefined ? [args.scope] : []
    const invalid = validateScopePaths(deps.store, currentWs, requested)
    if (invalid !== null) return { kind: 'error', message: invalid }
  }
  if (checkup) {
    const wsList = args.scopes && args.scopes.length > 0 ? args.scopes : listWorkspaces(deps.store)
    const notes: ScanNote[] = []
    if (baseline === null) notes.push({ code: 'baseline-missing', text: '未检测到 AGENTS.md 基线，垂直冲突检测未执行' })

    const decisionItems: ScanPass['decisionItems'] = []
    const seenDecisions = new Set<string>()
    const collect = (pass: ScanPass) => {
      for (const item of pass.decisionItems) {
        if (seenDecisions.has(item.id)) continue // 同一冲突可能在多层被复扫，呈现去重
        seenDecisions.add(item.id)
        decisionItems.push(item)
      }
      notes.push(...pass.notes.filter(n => !notes.some(m => m.code === n.code && m.text === n.text)))
    }

    // 每个 workspace 独立扫描：输入是该 ws 的可见集合（含 global，跨层冲突要在同一 prompt 里才可判），
    // 缓存写各自桶；分数由 scoreLayer 按归属规则计算（纯 global 噪音不进 ws 层分数）
    // 基线是当前会话的指令内容（含本项目 CLAUDE.md），拿它去判其他 workspace 的垂直冲突
    // 会误判——只对当前会话所属 ws 和 global 层生效，其余 ws 跳过垂直检测并如实说明
    const byWorkspace = new Map<string, MemoryRecord[]>()
    let baselineSkipped = 0
    for (const ws of wsList) {
      signal?.throwIfAborted()
      const visible = deps.store.query({ status: ['active'], scope: { kind: 'visible', workspacePath: ws } })
      const wsBaseline = ws === currentWs ? baseline : null
      if (baseline !== null && wsBaseline === null) baselineSkipped++
      collect(await scanPass(deps, visible, cacheKey(ws), ws, layerQuarantined(ws), layers, llm, wsBaseline, now, signal))
      byWorkspace.set(ws, deps.store.query({ status: ['active'], scope: { kind: 'workspace', path: ws } }))
    }
    // global 层：global-only 输入，独立桶
    signal?.throwIfAborted()
    const globalRecords = deps.store.query({ status: ['active'], scope: { kind: 'global' } })
    collect(await scanPass(deps, globalRecords, GLOBAL_CACHE_KEY, 'global', layerQuarantined(undefined), layers, llm, baseline, now, signal))
    if (baselineSkipped > 0 && llm && layers !== 'rule') {
      notes.push({ code: 'baseline-session-scoped', text: `基线随当前会话，${baselineSkipped} 个其他 workspace 的垂直冲突检测已跳过` })
    }
    const created = decisionItems.filter(i => i.isNew).length
    const existing = decisionItems.length - created

    // 分层计分（与 memory_health 共用 scoreLayer，两个工具对同一层永远同分）
    const layerRefs: LayerRef[] = [{ kind: 'global' }, ...wsList.map(path => ({ kind: 'workspace' as const, path }))]
    const rows = layerRefs.map(ref => {
      const r = scoreLayer(deps, ref, now)
      return {
        ...checkupRowBase(r),
        issues: r.ruleFindings.length + r.semanticFindings.length,
      }
    })

    // global 视角一：缺口检测——已标记候选聚合 + 跨项目重复主题
    const byWorkspaceCandidates = [...byWorkspace.entries()]
      .map(([workspacePath, records]) => ({
        workspacePath,
        items: records.filter(r => r.globalCandidate).map(r => ({ id: r.id, summary: r.summary })).slice(0, PROMOTE_LIMIT),
      }))
      .filter(w => w.items.length > 0)
    const promoteCandidates = {
      total: [...byWorkspace.values()].reduce((s, rs) => s + rs.filter(r => r.globalCandidate).length, 0),
      byWorkspace: byWorkspaceCandidates,
    }

    let duplicates: CheckupScanResult['duplicates'] = { items: [], via: 'none' }
    if (byWorkspace.size >= 2) {
      // layers=rule 承诺不碰 LLM——此时跨项目重复也只走实体聚类保底，不发语义调用。
      if (llm && layers !== 'rule') {
        const cross = await runCrossWsScan(byWorkspace, globalRecords, llm, signal)
        if (!cross.failed) duplicates = { items: cross.items, via: 'semantic' }
        else {
          notes.push({ code: 'cross-ws-failed', text: '跨项目重复分析失败（LLM 输出无法解析），退用实体聚类保底' })
          duplicates = { items: findEntityDuplicates(byWorkspace, globalRecords), via: 'entity' }
        }
      } else {
        duplicates = { items: findEntityDuplicates(byWorkspace, globalRecords), via: 'entity' }
      }
    }

    // 体检收尾：清理孤儿语义缓存桶（废弃 workspace 的、历史遗留键）——体检本就是全库视角，
    // 天然的清扫时机；合法桶按"库里现存的全部 workspace"算，不受本次 scopes 子集影响
    signal?.throwIfAborted()
    const validKeys = new Set([GLOBAL_CACHE_KEY, ...listWorkspaces(deps.store).map(ws => cacheKey(ws))])
    for (const [key] of [...deps.cache.entries()]) {
      if (!validKeys.has(key)) await deps.cache.delete(key)
    }

    signal?.throwIfAborted()
    return {
      kind: 'checkup', rows,
      pendingDecisions: { created, existing, items: decisionItems },
      crossLayerConflicts: crossLayerConflicts(deps.store, deps.decisions),
      promoteCandidates, duplicates, notes,
      message: `全库体检完成：global + ${wsList.length} 个 workspace 各自独立扫描计分${created > 0 ? `，新增 ${created} 个待决冲突` : ''}。清理需用户确认后执行：删除用 memory_forget，冲突裁决用 memory_confirm，提升全局用 memory_promote。`,
    }
  }

  // 单层模式：显式路径 > 当前会话 workspace > global 层（无 workspace 会话）。
  // 输入用可见集合（global + 本项目）——global 里的问题（含最高危的 secret）对本会话同样生效，
  // 跨层冲突也要双方同在 prompt 里才可判；分数归属的拆分在 memory_health（scoreLayer）做。
  const wsPath = args.scope ?? currentWs
  const records = deps.store.query({
    status: ['active'],
    ...(wsPath !== undefined
      ? { scope: { kind: 'visible' as const, workspacePath: wsPath } }
      : { scope: { kind: 'global' as const } }),
  })
  // 显式扫别的 workspace 时基线不适用（基线随当前会话）；扫自己或 global 层照用
  const passBaseline = wsPath === undefined || wsPath === currentWs ? baseline : null
  signal?.throwIfAborted()
  const pass = await scanPass(deps, records, cacheKey(wsPath), wsPath ?? 'global', layerQuarantined(wsPath), layers, llm, passBaseline, now, signal)
  const notes = [...pass.notes]
  if ((layers === 'semantic' || layers === 'full') && llm) {
    if (baseline === null) notes.push({ code: 'baseline-missing', text: '未检测到 AGENTS.md 基线，垂直冲突检测未执行' })
    else if (passBaseline === null) notes.push({ code: 'baseline-session-scoped', text: '基线随当前会话，扫描其他 workspace 时垂直冲突检测已跳过' })
  }

  const problemIds = new Set(pass.findings.flatMap(f => f.memoryIds))
  const byType: Record<string, number> = {}
  for (const f of pass.findings) byType[f.type] = (byType[f.type] ?? 0) + 1
  const stats = {
    scanned: records.length,
    clean: records.filter(r => !problemIds.has(r.id)).length,
    issues: pass.findings.length,
    byType,
  }

  // global 提升候选：只吃模型主动标的 globalCandidate（不掺 misplaced——它双向，该降级的会被误列）。限流。
  const allCandidates = records.filter(r => r.globalCandidate).map(r => ({ id: r.id, summary: r.summary }))
  const promoteCandidates = {
    items: allCandidates.slice(0, PROMOTE_LIMIT),
    more: Math.max(0, allCandidates.length - PROMOTE_LIMIT),
  }

  const noteSuffix = notes.length > 0 ? `（${notes.map(n => n.text).join('；')}）` : ''
  const scopeLabel = wsPath === undefined ? 'global 记忆'
    : wsPath === currentWs ? '本项目可见记忆'
    : `workspace ${wsPath} 可见记忆`
  signal?.throwIfAborted()
  return {
    kind: 'single',
    layer: wsPath !== undefined ? 'workspace' : 'global',
    ...(wsPath !== undefined ? { workspacePath: wsPath } : {}),
    findings: pass.findings,
    pendingDecisions: { created: pass.created, existing: pass.existing, items: pass.decisionItems },
    stats, promoteCandidates,
    semanticCachedAt: pass.semanticCachedAt,
    notes,
    message: `扫描${scopeLabel} ${stats.scanned} 条，发现 ${stats.issues} 个问题${pass.created > 0 ? `，新增 ${pass.created} 个待决冲突` : ''}${promoteCandidates.items.length > 0 ? `，${allCandidates.length} 条建议提升全局` : ''}${noteSuffix}。清理需用户确认后执行：删除用 memory_forget，冲突裁决用 memory_confirm，提升全局用 memory_promote。`,
  }
}
