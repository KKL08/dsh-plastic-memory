import { isAbsolute } from 'node:path'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { MemoryLogger, MemoryStore } from '../store.ts'
import type { CheckupInitiator, CodedNote, ScanNoteCode } from '../contract-codes.ts'
import type { TypeRegistry } from '../type-registry.ts'
import type { MemoryRecord } from '../record-schema.ts'
import { maskDiagnostic, maskSecretSurface } from '../secrets.ts'
import { candidateFingerprint, conflictFingerprint, isConflictOpen, type PendingDecisionsStore } from '../governance/decisions.ts'
import { parseCopyKey, scanContentFingerprint } from '../governance/changeset.ts'
import { estimateTokens } from '../snapshot.ts'
import type { CasKvTable } from '../kv-table.ts'
import type { Finding, ScanCacheEntry } from '../governance/schema.ts'
import { runRuleScan, buildMalformedFindings } from '../governance/rule-scan.ts'
import {
  buildSemanticPrompt, isAbort, isSemanticAdmitted, planSemanticBatches, scanBatch, SEMANTIC_PROMPT_VERSION,
  type SemanticFailure, type SemanticLlm,
} from '../governance/semantic-scan.ts'
import {
  batchKey, batchMembers, carriedFindings, checkContext, closingRow, coverageOf, crossWsRows, findingsRows, instructionState, isBatchValid,
  isCompletionRow, isHit, memberCopyKey, memberIdOf, memberScanFingerprints, planCheckup, publishedFindings, resolveTokenCap, roundOf, CROSS_WS_ROUND,
  type BatchMember, type ClosingRow, type CrossWsRow, type FindingsRow, type RunStop,
} from '../governance/checkup-plan.ts'
import type { CheckupCache } from '../storage/checkup-cache.ts'
import { isModelUnavailableCode } from '../governance/host-llm.ts'
import { cacheInstructions, instructionTexts, type InstructionFiles, type ReadInstructions } from '../governance/instructions.ts'
import type { ContextHost, HostSession } from './host-session.ts'
import { checkupKey, isCoverageClear, isFullyCovered, uncheckedCount, type CheckupCause, type CheckupCoverage } from '../gui/contract.ts'
import { scoreScope, validateScopePaths, crossScopeConflicts, checkupRowBase, coverageText, ignoredNote, findingFingerprints, GLOBAL_CACHE_KEY, TIER_LABEL } from '../governance/scope-health.ts'
import { applyIgnores, type AdviceIgnoreStore } from '../governance/advice-ignores.ts'
import type { CheckupRecordStore } from '../governance/checkup-records.ts'
import { prereadScopes, listingNotes, checkupWorkspaces, renderDirectoryNotes } from './scope-preread.ts'
import type { DirectoryNote } from '../storage/table.ts'
import { isWorkspaceGone } from '../storage/project-folder.ts'
import { buildCrossWsPrompt, runCrossWsScan, findEntityDuplicates, summaryLine, CROSS_WS_PROMPT_VERSION, type CrossWsDuplicate } from '../governance/cross-ws.ts'
import { decisionWorkspaces, decisionWorkspacesNote, workspaceLabel } from './workspace-gate.ts'
import { scopeCacheKey, scopeKey, GLOBAL_SCOPE_KEY, type Scope } from '../scope.ts'

export interface ScanToolDeps {
  store: MemoryStore
  registry: TypeRegistry
  decisions: PendingDecisionsStore
  /** 语义缓存：按开始时间「不回退」写，开始得早、结束得晚的扫描盖不掉更新的结果。 */
  cache: CasKvTable<ScanCacheEntry>
  /** 建议忽略表：被用户忽略的建议不列为发现、不扣分（与记忆页同口径）。缺省按没有忽略算。 */
  ignores?: Pick<AdviceIgnoreStore, 'list'>
  /** 体检记录表：一次体检全部写完后给覆盖到的范围写完成记录（提交点）。缺省不写。 */
  checkups?: Pick<CheckupRecordStore, 'list' | 'complete' | 'recordContinue'>
  /** 按作用域取指令文件（AGENTS.md / CLAUDE.md）：垂直冲突对照它，项目记忆对它所在项目的，全局记忆对全局层。一次扫描内每个作用域只读一次。 */
  instructions: ReadInstructions
  /** 宿主会话，都按触发调用的会话取：llmOf 按调用解析——provider/model 只能从触发调用的 agent 拿到，插件加载时不存在，
   *  null = 拿不到 LLM（语义层跳过并说明）；contextOf 给当前会话的 workspace（默认口径"当前项目"的来源）。 */
  host: ContextHost<{ workspacePath: string | undefined }> & Pick<HostSession, 'llmOf'>
  /** 体检结果库：内容检查按批存的结论（见 storage/checkup-cache.ts）。缺省按库里什么都没有处理，每次整批重查。 */
  checkupCache?: Pick<CheckupCache, 'readRound' | 'write' | 'markRecheck' | 'prune' | 'dropRound' | 'rounds' | 'retryOpen'>
  /** 一次体检内容检查的 token 上限（配置 governance.scan.tokenCap，每次现读）；缺省或不是正的有限数用默认值。 */
  tokenCap?: () => unknown
  /** 提交之后的步骤出错、上限配置不对时记日志；缺省用 console。 */
  log?: MemoryLogger
  now?: () => number
}

/** 扫描核心的依赖：工具依赖去掉宿主会话（模型、当前项目由调用方解析好传进 ScanInput）。 */
export type ScanCoreDeps = Omit<ScanToolDeps, 'host'>

export interface ScanArgs {
  /** 缺省=当前 workspace；'all'=全库体检（调用前须经 ask_user_question 确认范围）；具体路径=该 workspace。 */
  scope?: string
  /** 用户勾选的体检范围（workspace 路径列表）；给出时忽略 scope。 */
  scopes?: string[]
  layers?: 'rule' | 'semantic' | 'full'
}

/** 不来自工具参数的调用方式：谁发起的（写进完成记录），以及「只查全局」。缺省是 agent 调 memory_scan。 */
export interface ScanRun {
  by?: CheckupInitiator
  /** 只查全局：只读写全局记忆，只写全局的缓存与完成记录；给出时忽略 scope / scopes。 */
  isGlobalOnly?: boolean
  /**
   * 全库体检每扫完一个作用域，交出它自己的说明：指令文件取不到或被截断、它的语义层分批 / 没做成等。
   * 只关乎整次的（跨项目重复没做成）不在里面，只在结果的 notes 里。
   */
  onScopeNotes?: (scope: Scope, notes: readonly ScanNote[]) => void
  /** 提交点之后调用：至少一个范围提交成了（只有规则层的范围没有要提交的，算提交了）。之后再被取消，体检已经算做完。 */
  onCommitted?: () => void
}

export interface SingleScanResult {
  kind: 'single'
  layer: 'workspace' | 'global'
  workspacePath?: string
  findings: Finding[]
  pendingDecisions: {
    created: number
    existing: number
    items: Array<{ id: string; memoryIds: string[]; workspaces: string[]; summary: string; isNew: boolean }>
  }
  stats: { scanned: number; clean: number; issues: number; byType: Record<string, number> }
  /** 用户在记忆页忽略、这次没有列出的建议条数。 */
  ignoredCount: number
  /** global 提升候选：模型存时标了 globalCandidate 的 workspace 记忆，待用户确认后 memory_promote。 */
  promoteCandidates: { items: Array<{ id: string; summary: string }>; more: number }
  semanticCachedAt: number | null
  notes: ScanNote[]
  /** 本次读取的目录级说明：缺标记 / 不可读目录、含保留键的文件、同 id 副本。 */
  directoryNotes: DirectoryNote[]
  message: string
  /** 语义层分了批时的批数（与说明码 semantic-batched 同时出现），不分批时缺省。 */
  semanticBatches?: number
  /** 宿主流 usage 块报的实际用量合计（含重试）；宿主一次都没报时缺省。只给界面，不写进给模型看的文字。 */
  usageTokens?: number
  /** 跑了内容检查的轮：覆盖和收尾表的那一行。没跑内容检查（layers=rule、拿不到模型、范围没有自己的记忆）时没有这一项。 */
  rounds?: ScanRoundResult[]
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
    /** 用户忽略、没有计分的建议条数。 */
    ignoredCount: number
    /** 这个范围的内容检查覆盖：这次跑了内容检查的取这次的，否则取上次体检的；都没有（上一个发布版写的、没有自己的记忆）时没有。 */
    coverage?: CheckupCoverage
    /** coverage 是上次体检的（这次这个范围没跑内容检查，比如 layers=rule）：文字写明「上次」。 */
    isCoverageFromLastCheckup?: true
  }>
  pendingDecisions: {
    created: number
    existing: number
    items: Array<{ id: string; memoryIds: string[]; workspaces: string[]; summary: string; isNew: boolean }>
  }
  /** 同一条 global 记忆与 ≥2 个 workspace 的待决冲突：被多数项目反对，优先裁定。 */
  crossLayerConflicts: Array<{ globalId: string; workspaces: string[]; decisionIds: string[] }>
  promoteCandidates: { total: number; byWorkspace: Array<{ workspacePath: string; items: Array<{ id: string; summary: string }> }> }
  /** 跨项目重复主题（global 缺口）：语义层主力，LLM 不可用时实体聚类保底（疑似级）。 */
  duplicates: { items: CrossWsDuplicate[]; via: 'semantic' | 'entity' | 'none' }
  notes: ScanNote[]
  /** 全库目录级说明：缺标记 / 不可读 / 只剩归档的目录、含保留键的文件、同 id 副本（含跨项目副本）。 */
  directoryNotes: DirectoryNote[]
  message: string
  /** 分了批的各作用域批数之和（与说明码 semantic-batched 同时出现），没有作用域分批时缺省。 */
  semanticBatches?: number
  /** 宿主流 usage 块报的实际用量合计（各作用域的语义检查、跨项目重复检查，含重试）；宿主一次都没报时缺省。只给界面。 */
  usageTokens?: number
  /** 跨项目重复这次没比（排不进这次的 token 上限，或前面的内容检查停下了），下次体检再比。 */
  isCrossWsSkipped?: true
  /** 跑了内容检查的轮：覆盖和收尾表的那一行（同 SingleScanResult.rounds）。 */
  rounds?: ScanRoundResult[]
}

/** scope/scopes 里出现无法识别的 workspace 时快速失败——静默扫错作用域比报错危险得多。 */
export interface ScanErrorResult {
  kind: 'error'
  message: string
}

export type ScanToolResult = SingleScanResult | CheckupScanResult | ScanErrorResult

/** 提升候选一次最多列这些，其余折叠——不让治理报告被候选淹没。 */
const PROMOTE_LIMIT = 5
/** 一次没查完的体检约多久之后接着查（到上限停下、这次没轮到）。 */
const CONTINUE_AFTER_MS = 86_400_000

/** 把扫描结果渲染成给模型看的一段文本。纯函数。 */
export function renderScanResult(result: ScanToolResult): string {
  if (result.kind === 'error') return result.message
  if (result.kind === 'checkup') {
    const lines = [result.message]
    for (const row of result.rows) {
      const name = row.layer === 'global' ? 'global' : row.workspacePath!
      const gateNote = row.gate.secret ? '｜⚠️ 检出密钥' : ''
      const coverage = row.coverage !== undefined ? `｜${coverageText(row.coverage, { isLastCheckup: row.isCoverageFromLastCheckup === true })}` : ''
      lines.push(`- ${name}：${Math.floor(row.score)}/100（${TIER_LABEL[row.tier]}）｜${row.totalMemories} 条｜${row.issueSummary}${gateNote}${coverage}`)
    }
    const ignored = ignoredNote(result.rows.reduce((n, row) => n + row.ignoredCount, 0))
    if (ignored !== undefined) lines.push(ignored)
    for (const c of result.crossLayerConflicts) {
      lines.push(`⚠️ 跨层冲突：global ${c.globalId} 与 ${c.workspaces.length} 个项目存在待决冲突（${c.workspaces.join('、')}）——被多数项目反对的全局规则建议优先裁定（memory_confirm resolve：${c.decisionIds.join('、')}）`)
    }
    if (result.pendingDecisions.items.length > 0) {
      lines.push('待裁决冲突（用 memory_confirm resolve 裁决，需 decisionId）：')
      for (const item of result.pendingDecisions.items) {
        lines.push(`- [${item.id}] ${item.summary}${decisionWorkspacesNote(item.workspaces)}`)
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
    if (result.isCrossWsSkipped === true) lines.push('跨项目重复这次没比，下次体检再比。')
    if (result.notes.length > 0) lines.push(`（${result.notes.map(n => n.text).join('；')}）`)
    lines.push(...renderDirectoryNotes(result.directoryNotes))
    return lines.join('\n')
  }

  const lines = [result.message]
  for (const r of result.rounds ?? []) lines.push(coverageText(r.coverage))
  for (const f of result.findings) {
    lines.push(`- [${f.severity}] ${f.type} ${f.memoryIds.join('+')}：${f.summary} → ${f.suggestedAction}`)
  }
  const ignored = ignoredNote(result.ignoredCount)
  if (ignored !== undefined) lines.push(ignored)
  // 证据下钻提示：治理裁决是高赌注不可逆动作，下钻引导不低于 strict
  if (result.findings.some(f => f.type === 'expired')) {
    lines.push('过期候选可先用 memory_source 回查出处，向用户复述当时语境，再决定 refresh 还是 forget。')
  }
  if (result.pendingDecisions.items.length > 0) {
    lines.push('待裁决冲突（用 memory_confirm resolve 裁决，需 decisionId）：')
    for (const item of result.pendingDecisions.items) {
      lines.push(`- [${item.id}] ${item.summary}${decisionWorkspacesNote(item.workspaces)}`)
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
  lines.push(...renderDirectoryNotes(result.directoryNotes))
  return lines.join('\n')
}

/**
 * 扫描过程的说明条目：code 稳定供程序判断，text 给人/模型看。
 * semantic-failed、model-unavailable 带 cause：没做成的原因（宿主错误码一路带到这里），自动体检据它记失败或「模型用不了」。
 */
export type ScanNote = CodedNote<ScanNoteCode> & { cause?: CheckupCause }

/** 一轮里的一批：成员、键、发给模型的估算 token、命中的那一行，以及这次发了没有、查出的发现。 */
interface RoundBatch {
  records: MemoryRecord[]
  members: BatchMember[]
  key: string
  cost: number
  hit: FindingsRow | undefined
  sent?: 'ok' | 'failed'
  findings?: Finding[]
}

/** 一轮内容检查（一个范围）：查前定好的输入和这次的结果。 */
interface SemanticRound {
  scope: Scope
  round: string
  isReadComplete: boolean
  files: InstructionFiles
  /** 这一轮对照的指令文件文本：项目是全局层加本项目，全局只有全局层；没有或取不到为 null。 */
  baseline: readonly string[] | null
  total: number
  globalTotal?: number
  batches: RoundBatch[]
  /** 库里这一轮过了结构校验的行；库这次读不了为 undefined。 */
  history: FindingsRow[] | undefined
  recheckBefore: number
  /** 过了准入的记忆现在的扫描指纹，按副本身份。 */
  current: ReadonlyMap<string, string>
  /** 这一轮没查成的那一批的原因。 */
  failure?: SemanticFailure
  /** 这次有一批的结论写不进库（结论留在内存里照常用）：全覆盖也不清库，免得删掉还要沿用的旧行。 */
  isDbWriteFailed?: boolean
}

/** 一轮的提交状态：提交之后的步骤（清库、清遗留垂直条目、报已提交）只看它。 */
interface RoundCommit {
  /** 挂账、写视图都没出错（提交点）。 */
  isCommitted: boolean
  /** 这次查成的批都写进了库。 */
  isDbWritten: boolean
}

/**
 * 一轮内容检查做完之后：覆盖和收尾表的那一行（界面手动体检、自动体检据它收尾）。
 * cause：这一轮没做成的原因——模型用不了、有批没做成（这一轮自己的，或整次停在别的轮的那一批）、提交前的存储步骤出错（kind 为 error）。
 */
export interface ScanRoundResult {
  scope: Scope
  coverage: CheckupCoverage
  closing: ClosingRow
  cause?: CheckupCause
}

/** 一个作用域的规则检查和说明（不跑内容检查的作用域只有这些）。 */
interface RoundLedger {
  findings: Finding[]
  decisionItems: Array<{ id: string; memoryIds: string[]; workspaces: string[]; summary: string; isNew: boolean }>
  created: number
  existing: number
  settled: number
}

/** 一轮的输入：过了准入的可见记忆，按治理优先级 + 新近度排（一批装得下时就按这个顺序发；分批时由 planSemanticBatches 按稳定键重排）。 */
function orderForPrompt(records: readonly MemoryRecord[], registry: TypeRegistry): MemoryRecord[] {
  const priorityOrder = { high: 0, medium: 1, low: 2 } as const
  return [...records].sort((a, b) =>
    priorityOrder[registry.get(a.type).governancePriority] - priorityOrder[registry.get(b.type).governancePriority]
    || b.updatedAt - a.updatedAt)
}

/** 查前定好一轮：读指令文件、分批、算每批的键和估算、查库。 */
async function prepareRound(input: {
  scope: Scope
  records: readonly MemoryRecord[]
  isReadComplete: boolean
  llm: SemanticLlm
  instructions: ReadInstructions
  registry: TypeRegistry
  resultsDb: ScanCoreDeps['checkupCache']
  /** 全部重查的时刻：早于它查的结论这次都不命中（库里记没记下都一样）。 */
  recheckAt?: number
}): Promise<SemanticRound> {
  const { scope } = input
  const round = roundOf(scope)
  const files = await input.instructions(scope)
  const baseline = instructionTexts(files)
  const ctx = checkContext(SEMANTIC_PROMPT_VERSION, input.llm, instructionState(files))
  const read = input.resultsDb?.readRound(round)
  const history = read === undefined ? undefined : findingsRows(read.rows)
  const recheckBefore = Math.max(read?.recheckBefore ?? 0, input.recheckAt ?? 0)
  const rows = new Map(history?.map(row => [row.key, row]))
  const batches = planSemanticBatches(orderForPrompt(input.records, input.registry)).map((records): RoundBatch => {
    const members = batchMembers(records)
    const key = batchKey(ctx, members)
    const prompt = buildSemanticPrompt(records, baseline)
    const row = rows.get(key)
    return {
      records, members, key,
      cost: estimateTokens(prompt.system) + estimateTokens(prompt.user),
      hit: isHit(row, { key, members }, recheckBefore) ? row : undefined,
    }
  })
  const globalTotal = scope.kind === 'workspace' ? input.records.filter(r => r.scope === 'global').length : undefined
  return {
    scope, round, isReadComplete: input.isReadComplete, files, baseline,
    total: input.records.length, ...(globalTotal !== undefined ? { globalTotal } : {}),
    batches, history, recheckBefore,
    current: new Map(input.records.map(r => [memberCopyKey(r), scanContentFingerprint(r)])),
  }
}

/** 跨项目比较这次的输入、键、估算和命中的那一行。 */
interface CrossWsCheck {
  byWorkspace: ReadonlyMap<string, MemoryRecord[]>
  global: MemoryRecord[]
  members: BatchMember[]
  key: string
  cost: number
  hit: CrossWsRow | undefined
  recheckBefore: number
}

/**
 * 查前定好跨项目比较：输入是过了语义检查准入的各项目自己的记忆和全局记忆；
 * 键 = 提示词版本 + 模型标识 + 各项目和全局的摘要指纹（每个范围一份，不含指令文件）。
 */
function prepareCrossWs(
  byWorkspace: ReadonlyMap<string, readonly MemoryRecord[]>,
  globalRecords: readonly MemoryRecord[],
  llm: SemanticLlm,
  now: number,
  resultsDb: ScanCoreDeps['checkupCache'],
  recheckAt = 0,
): CrossWsCheck {
  const admitted = new Map([...byWorkspace].map(([ws, records]) => [ws, records.filter(r => isSemanticAdmitted(r, now))]))
  const global = globalRecords.filter(r => isSemanticAdmitted(r, now))
  const digest = (records: readonly MemoryRecord[]) => batchKey('', records.map((r): BatchMember => [memberCopyKey(r), summaryLine(r)]))
  const members = [...[...admitted].map(([ws, records]): BatchMember => [ws, digest(records)]), [GLOBAL_SCOPE_KEY, digest(global)] as const]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  const key = batchKey(checkContext(CROSS_WS_PROMPT_VERSION, llm, null), members)
  const prompt = buildCrossWsPrompt(admitted, global)
  const read = resultsDb?.readRound(CROSS_WS_ROUND)
  const recheckBefore = Math.max(read?.recheckBefore ?? 0, recheckAt)
  const row = crossWsRows(read?.rows ?? []).find(r => r.key === key)
  return {
    byWorkspace: admitted, global, members, key,
    cost: estimateTokens(prompt.system) + estimateTokens(prompt.user),
    hit: isHit(row, { key, members }, recheckBefore) ? row : undefined, recheckBefore,
  }
}

/** 指令文件状态 → 覆盖里的写法。 */
function baselineOf(files: InstructionFiles): CheckupCoverage['baseline'] {
  return files.kind === 'found' ? (files.isTruncated ? 'truncated' : 'read') : files.kind
}

/** 这一轮没有有效结果的批里的副本。 */
function unresolvedOf(round: SemanticRound): Set<string> {
  return new Set(round.batches.filter(b => !isBatchValid(b)).flatMap(b => b.members.map(([copy]) => copy)))
}

/**
 * conflict → 待决账本（不自动裁决）。用户裁决过两边都留、双方内容（垂直含基线）都没变的，不挂账也不进返回的发现。
 * 返回挂账之后还留着的发现（挂账跳过的、裁决过的去掉）。
 */
async function recordConflicts(
  deps: Pick<ScanCoreDeps, 'store' | 'decisions'>,
  semantic: readonly Finding[],
  byId: ReadonlyMap<string, MemoryRecord>,
  baseline: readonly string[] | null,
  now: number,
): Promise<RoundLedger> {
  const findings = [...semantic]
  let created = 0
  let existing = 0
  let settled = 0
  const decisionItems: RoundLedger['decisionItems'] = []
  for (const f of semantic) {
    if (f.type !== 'conflict') continue
    // 语义层跑的这几十秒里用户可能已经裁决（败方软删、条目 settled 记了快照）：按预读数据挂账会把那条裁决
    // 当成「败方回来了」反撤。挂账前重读成员，任一方已不是 active 就跳过这条发现。
    const live = await Promise.all(f.memoryIds.map(id => deps.store.get(id)))
    if (live.some(r => r === undefined || r.status !== 'active')) {
      findings.splice(findings.indexOf(f), 1)
      continue
    }
    const members = f.memoryIds.map(id => byId.get(id))
    const fingerprint = members.every(m => m !== undefined)
      ? conflictFingerprint(members, f.baselineRef !== undefined ? baseline ?? [] : undefined)
      : undefined
    const r = await deps.decisions.upsert({
      memoryIds: f.memoryIds,
      ...(f.baselineRef !== undefined ? { baselineRef: f.baselineRef } : {}),
      summary: f.summary,
      workspaces: f.memoryIds.map(id => workspaceLabel(byId.get(id))),
      ...(fingerprint !== undefined ? { fingerprint } : {}),
      ...(members.every(m => m !== undefined) ? { memberScanFingerprints: memberScanFingerprints(members as MemoryRecord[]) } : {}),
    }, now, id => deps.store.get(id))
    // 条目正被裁决、或刚被裁决（败方已删）：不挂账也不进返回的发现
    if (r.isSkipped) {
      findings.splice(findings.indexOf(f), 1)
      continue
    }
    if (r.settled) {
      settled++
      findings.splice(findings.indexOf(f), 1)
      continue
    }
    if (r.created) created++
    else existing++
    decisionItems.push({
      id: r.entry.id, memoryIds: r.entry.memoryIds, workspaces: decisionWorkspaces(r.entry, id => byId.get(id)),
      summary: r.entry.summary, isNew: r.created,
    })
  }
  return { findings, decisionItems, created, existing, settled }
}

/** 指令文件的说明：取不到时垂直冲突没查，被截断时只对照了一部分；没有指令文件是常态，不说明。 */
function instructionNotes(files: InstructionFiles): ScanNote[] {
  if (files.kind === 'unavailable') {
    // 原因是读取时的报错原话，同其他诊断文字先遮密钥
    const reason = maskDiagnostic(files.reason)
    return [{ code: 'baseline-missing', text: `取不到 AGENTS.md / CLAUDE.md（${reason}），垂直冲突检测未执行`, cause: { kind: 'error', message: reason } }]
  }
  if (files.kind === 'found' && files.isTruncated) return [{ code: 'baseline-truncated', text: 'AGENTS.md / CLAUDE.md 超过长度上限，垂直冲突只对照了其中一部分' }]
  return []
}

/**
 * 提升候选入账：扫到的每个项目，把带 globalCandidate 的 active 记忆同步成 promote-candidate 条目（GUI 待处理读它）。
 * 只看规则数据、不调模型，所以 layers=rule 也做；只动本次扫到的项目，别的项目的条目等扫到它再说。
 * 语义层可能跑几十秒，期间用户可能在 GUI 里点了「提升」或撤销，所以不用扫描开头预读的数据，写账本前按项目重读一次。
 * 一个项目读不出或写不进：记日志，接着同步后面的项目。
 */
async function syncPromoteCandidates(
  deps: Pick<ScanCoreDeps, 'store' | 'decisions'>,
  workspaces: readonly string[],
  now: number,
  log: MemoryLogger,
): Promise<void> {
  for (const ws of workspaces) {
    try {
      const fresh = await deps.store.readRaw({ kind: 'workspace', workspacePath: ws })
      const own = new Map<string, MemoryRecord>()
      for (const { record: r } of fresh.records) {
        if (r.status === 'active' && r.scope === 'workspace' && r.workspacePath === ws && !own.has(r.id)) own.set(r.id, r)
      }
      const candidates = [...own.values()].filter(r => r.globalCandidate).map(r => ({ id: r.id, summary: r.summary, fingerprint: candidateFingerprint(r) }))
      await deps.decisions.syncPromoteCandidates(ws, candidates, new Set(own.keys()), now, id => deps.store.get(id, { workspacePath: ws }))
    } catch (err) {
      log.warn(`[plastic-memory] 同步 ${ws} 的提升候选失败，下次体检再补`, err)
    }
  }
}

/**
 * 扫描核心的输入：模型、当前项目都已解析好，不认识工具调用上下文。
 * target 是单个作用域（扫它的可见集合）或全库体检（各项目独立扫 + 全局专项，workspaces 缺省 = 库里全部项目）。
 */
export interface ScanInput {
  target: { kind: 'scope'; scope: Scope } | { kind: 'checkup'; workspaces?: readonly string[] }
  layers?: 'rule' | 'semantic' | 'full'
  /** null = 拿不到 LLM（语义层跳过并说明）。 */
  llm: SemanticLlm | null
  /** 当前会话的 workspace；缺省 = 没有当前项目（全局会话、无会话的自动体检）。 */
  currentWorkspace?: string
  /** 用户取消信号：每个语义调用透传，各写入前设检查点。 */
  signal?: AbortSignal
  /** 这次扫描开始的时刻（完成记录的开始时间、缓存不回退的比较点）；缺省 = 进核心时现读。 */
  startedAt?: number
  /**
   * 全部重查（只有界面体检给）：开始时给要查的每一轮（全库体检含跨项目比较）记下「此刻之前查的都不算」，之后这些轮的旧结论都不命中，
   * 被上限打断后普通体检接着查，直到查完。记不下来时这次在内存里照样按全没命中跑，记日志（续不上）。
   */
  isFullRecheck?: boolean
}

/**
 * memory_scan 的工具壳：从调用上下文解析模型、当前项目，把参数翻成扫描目标，交给 runScan。
 * 默认口径=当前 workspace 的可见集合（global + 本项目）；scope='all' 或 scopes 列表进入全库体检；
 * run.isGlobalOnly 只查全局（记忆页的全局体检），给出时忽略 scope / scopes。
 */
export async function executeScan(args: ScanArgs, deps: ScanToolDeps, exec: ToolRunContext, run: ScanRun = {}): Promise<ScanToolResult> {
  // 开始时间、模型在调用进来时就定，不等解析会话
  const startedAt = deps.now?.() ?? Date.now()
  const llm = deps.host.llmOf(exec)
  const currentWorkspace = exec !== undefined ? (await deps.host.contextOf(exec)).workspacePath : undefined
  const isCheckup = !run.isGlobalOnly && (args.scope === 'all' || (args.scopes !== undefined && args.scopes.length > 0))
  // 单个作用域的目标：只查全局 > 显式路径 > 当前会话 workspace > 全局（无 workspace 会话）
  const wsPath = run.isGlobalOnly ? undefined : args.scope ?? currentWorkspace
  const target: ScanInput['target'] = isCheckup
    ? { kind: 'checkup', ...(args.scopes !== undefined && args.scopes.length > 0 ? { workspaces: args.scopes } : {}) }
    : { kind: 'scope', scope: wsPath !== undefined ? { kind: 'workspace', workspacePath: wsPath } : { kind: 'global' } }
  return runScan({
    target,
    ...(args.layers !== undefined ? { layers: args.layers } : {}),
    llm,
    ...(currentWorkspace !== undefined ? { currentWorkspace } : {}),
    ...(exec?.signal !== undefined ? { signal: exec.signal } : {}),
    startedAt,
  }, deps, run)
}

/**
 * 扫描核心：只读+报告。副作用：内容检查的结论按批写进体检结果库、语义结果发布到 scan_cache；conflict 与提升候选进 pending_decisions。
 * 清理动作由模型经用户确认后调 forget/save 执行。
 *
 * 内容检查是增量的（见 governance/checkup-plan.ts）：照现在的方式分批，成员和判断上下文都没变的批不再发，用库里上次的结论；
 * 各轮没命中的批、跨项目比较、到期的刷新按一个计划、一个整次上限排，一批失败、模型用不了、取消就停，已成功的都留着。
 * 各轮的批（没命中的、刷新）先发；每一轮再挂账、写视图（提交点）。视图 = 有有效结果的批的发现 + 沿用的旧发现（只进视图，不重新挂账）。
 * 提交之后：清库、清全局记忆的遗留垂直条目、同步提升候选、按收尾表（closingRow）给全覆盖或到上限停下的轮写完成记录，再做跨项目比较；
 * 这些步骤出错只记日志，结果按已提交的算。
 * 指令文件按作用域现读（项目：全局层加本项目；全局：只有全局层），这次扫描内每个作用域只读一次。
 */
export async function runScan(input: ScanInput, deps: ScanCoreDeps, run: Pick<ScanRun, 'by' | 'onScopeNotes' | 'onCommitted'> = {}): Promise<ScanToolResult> {
  const { llm, signal, currentWorkspace: currentWs } = input
  const layers = input.layers ?? 'full'
  const instructions = cacheInstructions(deps.instructions)
  const now = input.startedAt ?? deps.now?.() ?? Date.now()
  const clock = () => deps.now?.() ?? Date.now()
  const log = deps.log ?? console
  // 本次扫描各次模型调用的实际用量合计；宿主一次都没报时保持 undefined，不拿估算顶替
  let usageTokens: number | undefined
  const onUsage = (tokens: number) => { usageTokens = (usageTokens ?? 0) + tokens }
  const extras = (semanticBatches: number) => ({
    ...(semanticBatches > 0 ? { semanticBatches } : {}),
    ...(usageTokens !== undefined ? { usageTokens } : {}),
  })
  /** 提交之后的一步：出错只记日志，结果按已提交的算。 */
  const afterCommit = async (what: string, fn: () => Promise<void> | void) => {
    try {
      await fn()
    } catch (err) {
      if (isAbort(err, signal)) throw err
      log.warn(`[plastic-memory] 体检已提交，${what}失败，下次体检再补`, err)
    }
  }
  // 目录枚举只读标记与文件名：体检清单、scope 校验、缺标记 / 不可读目录的说明都出自它
  const listing = await deps.store.listWorkspaceDirs()
  const checkup = input.target.kind === 'checkup'
  const requestedWs = input.target.kind === 'checkup' ? input.target.workspaces : undefined
  const target: Scope = input.target.kind === 'scope' ? input.target.scope : { kind: 'global' }
  const wsPath = target.kind === 'workspace' ? target.workspacePath : undefined
  {
    // 当前项目本来就算认得，所以单个作用域落到它时校验总能过
    const requested = checkup ? requestedWs ?? [] : wsPath !== undefined ? [wsPath] : []
    const invalid = validateScopePaths(checkupWorkspaces(listing), currentWs, requested)
    if (invalid !== null) return { kind: 'error', message: invalid }
  }
  // 预读范围：与 memory_health 共用 prereadScopes——目标作用域（含 .archive/）的全部状态记录、作用域外引用按 id 定位、
  // 待决账本、语义缓存、按作用域归档的隔离文件。体检读 global + 所选 workspace；单个作用域读可见集合（global + 本项目）。
  // 一个作用域读取抛错时记成没读全，照常查读得到的
  // 全库体检的项目清单：指定的，或目录清单里顶层有记忆文件的（含读取抛错、只有坏文件的项目，和界面的全库体检同一份）
  const checkupWs = checkup ? requestedWs ?? checkupWorkspaces(listing) : []
  const readScopes: Scope[] = checkup
    ? [{ kind: 'global' }, ...checkupWs.map(workspacePath => ({ kind: 'workspace' as const, workspacePath }))]
    : wsPath !== undefined ? [target, { kind: 'global' }] : [target]
  const data = await prereadScopes(deps, readScopes, checkup ? undefined : wsPath, { isReadErrorTolerated: true })
  const active = (pred: (r: MemoryRecord) => boolean) =>
    [...data.byId.values()].filter(r => r.status === 'active' && pred(r))
  const visibleTo = (ws: string | undefined) => (r: MemoryRecord) =>
    r.scope === 'global' || (ws !== undefined && r.workspacePath === ws)
  const isGlobal = (r: MemoryRecord) => r.scope === 'global'
  // malformed 按扫描的作用域归属（与 memory_health 的 scoreScope 同口径）：隔离文件按读到它的目录归作用域
  const quarantinedIn = (scope: Scope) => data.quarantined.get(scopeCacheKey(scope)) ?? []
  /** 这个作用域自己这次没读全（项目不算带进来的全局）。 */
  const isScopeUnread = (scope: Scope): boolean => data.unreadScopes?.has(scopeCacheKey(scope)) ?? false
  // 项目这一轮的可见集合含全局记忆：全局没读全，项目这一轮也没读全
  const isReadCompleteFor = (scope: Scope): boolean => !isScopeUnread(scope)
    && (scope.kind === 'global' || isReadCompleteFor({ kind: 'global' }))
  /**
   * 一份成员暂时读不到：这次读到的记录里没有这份副本，且它所在的作用域这次没读全（按副本身份里的作用域判，不按整轮）。
   * 所在作用域读全了还没有，就是删了。
   */
  const isMemberUnread = (copy: string): boolean => {
    if (isRead(copy, data.byId)) return false
    const at = parseCopyKey(copy)!
    return isScopeUnread(at.scopeKey === GLOBAL_SCOPE_KEY ? { kind: 'global' } : { kind: 'workspace', workspacePath: at.scopeKey })
  }
  /**
   * 这个范围算有自己的记忆（全局总算有）：项目要么这次读到它在用的记忆或坏文件（列完目录才写进的第一条记忆也算），
   * 要么扫描开头的目录清单里它顶层有记忆文件（和调度认的可体检范围一致，顶层只剩手改成非在用的记录也算）。
   * 都没有的（记忆删光、全在最近删除、还没写过）没有可体检的内容：不查内容、不占上限、不写完成记录、不覆盖语义缓存。
   */
  const hasOwnMemories = (scope: Scope) => scope.kind === 'global'
    || [...data.byId.values()].some(r => r.status === 'active' && r.scope === 'workspace' && r.workspacePath === scope.workspacePath)
    || quarantinedIn(scope).length > 0
    || listing.entries.some(e => e.workspacePath === scope.workspacePath && e.hasActiveTopLevel)

  // 这次要查的范围：全库是各项目再全局（读不出的项目照样在，按没读全处理），单个作用域是它自己
  const wsList = checkupWs
  const scopes: Scope[] = checkup ? [...wsList.map(workspacePath => ({ kind: 'workspace' as const, workspacePath })), { kind: 'global' }] : [target]
  // 每个范围的输入：项目是它的可见集合（含全局，跨作用域的冲突要在同一 prompt 里才可判），全局只有全局记忆
  const inputOf = (scope: Scope) => active(scope.kind === 'workspace' ? visibleTo(scope.workspacePath) : isGlobal)
  const notesByScope = new Map<string, ScanNote[]>(scopes.map(scope => [scopeKey(scope), []]))
  const notesOf = (scope: Scope) => notesByScope.get(scopeKey(scope))!
  if (llm === null && layers !== 'rule') {
    for (const scope of scopes) {
      notesOf(scope).push(layers === 'semantic'
        ? { code: 'no-layer-executed', text: '语义层不可用（当前环境拿不到 LLM），且 layers=semantic 不含规则层，本次未执行任何检测' }
        : { code: 'semantic-unavailable', text: '语义层不可用（当前环境拿不到 LLM），只返回规则层结果' })
    }
  }
  // 跑内容检查的模型：layers=rule 承诺不碰 LLM
  const semanticLlm = layers !== 'rule' ? llm : null

  // —— 查前：各轮分批查库、跨项目比较的键 ——
  const resultsDb = deps.checkupCache
  resultsDb?.retryOpen()
  const byWorkspace = new Map(wsList.map(ws => [ws, active(r => r.scope === 'workspace' && r.workspacePath === ws)]))
  const globalRecords = active(isGlobal)
  const checkable = scopes.filter(hasOwnMemories)
  // 全部重查：给要查的每一轮（全库体检含跨项目比较）记下此刻，记不下来这次照样按全没命中跑
  const recheckAt = input.isFullRecheck === true && semanticLlm !== null ? now : undefined
  if (recheckAt !== undefined && resultsDb !== undefined) {
    const marked = resultsDb.markRecheck([...checkable.map(roundOf), ...(checkup && byWorkspace.size >= 2 ? [CROSS_WS_ROUND] : [])], recheckAt)
    if (!marked) log.warn('[plastic-memory] 全部重查记不下来，这次照样全部重查；被上限打断的话，下次体检不会接着重查')
  }
  const rounds: SemanticRound[] = []
  if (semanticLlm !== null) {
    for (const scope of checkable) {
      signal?.throwIfAborted()
      rounds.push(await prepareRound({
        scope, records: inputOf(scope).filter(r => isSemanticAdmitted(r, now)), isReadComplete: isReadCompleteFor(scope),
        llm: semanticLlm, instructions, registry: deps.registry, resultsDb, ...(recheckAt !== undefined ? { recheckAt } : {}),
      }))
    }
  }
  const roundByKey = new Map(rounds.map(r => [r.round, r]))
  const cross = semanticLlm !== null && checkup && byWorkspace.size >= 2
    ? prepareCrossWs(byWorkspace, globalRecords, semanticLlm, now, resultsDb, recheckAt)
    : undefined

  // —— 按计划发各轮的批（没命中的、刷新）；跨项目比较排进同一个上限，放到提交之后做 ——
  const tokenCap = resolveTokenCap(deps.tokenCap?.())
  if (tokenCap.isInvalid) log.warn(`[plastic-memory] 体检的 token 上限配置不是正数，这次用默认值 ${tokenCap.cap}`)
  const plan = planCheckup({
    rounds: rounds.map(r => ({ round: r.round, scope: r.scope, lastCompletedAt: data.checkups.get(checkupKey(r.scope))?.completed?.completedAt ?? null, batches: r.batches })),
    ...(cross !== undefined ? { crossWs: { cost: cross.cost, isHit: cross.hit !== undefined } } : {}),
    cap: tokenCap.cap, now,
  })
  let runStop: RunStop = plan.isCapped ? 'cap' : 'done'
  /** 整次停下的那一批没做成的原因。 */
  let runFailure: SemanticFailure | undefined
  /** 刷新时碰上模型用不了：剩下的刷新这次不再试。 */
  let isRefreshStopped = false
  for (const step of plan.steps) {
    if (step.kind === 'cross-ws' || semanticLlm === null || (step.isRefresh && isRefreshStopped)) continue
    signal?.throwIfAborted()
    const round = roundByKey.get(step.round)!
    const batch = round.batches[step.index]!
    const found = await scanBatch(batch.records, round.baseline, semanticLlm, signal, onUsage)
    // 刷新是顺带做的：这一批的旧结论照常有效，没做成（不管什么原因）只记日志，不算这次体检停下；
    // 模型用不了时剩下的刷新也做不成，不再试，别的原因接着试下一批
    if (!Array.isArray(found) && step.isRefresh) {
      log.warn(`[plastic-memory] 体检刷新 ${round.round} 的一批没做成，沿用上次的结论`, found)
      if (found.kind === 'model-error' && isModelUnavailableCode(found.hostCode)) isRefreshStopped = true
      continue
    }
    if (!Array.isArray(found)) {
      batch.sent = 'failed'
      round.failure = found
      runFailure = found
      runStop = found.kind === 'model-error' && isModelUnavailableCode(found.hostCode) ? 'model-unavailable' : 'batch-failed'
      break
    }
    // 项目这一轮的可见集合含全局记忆：全局记忆对指令文件的冲突只在全局这一轮查（对全局层），这里报出的丢掉
    const findings = round.scope.kind === 'workspace'
      ? found.filter(f => f.baselineRef === undefined || data.byId.get(f.memoryIds[0]!)?.scope === 'workspace')
      : found
    batch.sent = 'ok'
    batch.findings = findings
    // 写不进去：这一批的结论留在内存里照常用（库自己记日志），下次重查
    // 检查时刻不早于这一轮的全部重查时刻：同一毫秒里点的全部重查，这次查的照样算数
    const checkedAt = Math.max(clock(), round.recheckBefore)
    if (resultsDb !== undefined && !resultsDb.write(round.round, { key: batch.key, checkedAt, members: batch.members, result: findings })) round.isDbWriteFailed = true
  }

  // —— 每一轮：覆盖、挂账、写视图（提交点） ——
  signal?.throwIfAborted()
  const ledgers = new Map<string, RoundLedger>()
  const results = new Map<string, ScanRoundResult>()
  const commits = new Map<string, RoundCommit>()
  let semanticBatches = 0
  for (const scope of scopes) {
    const notes = notesOf(scope)
    const round = roundByKey.get(scopeKey(scope))
    const ruleFindings = layers === 'rule' || layers === 'full'
      ? [...runRuleScan(inputOf(scope), id => data.byId.get(id), now), ...buildMalformedFindings(quarantinedIn(scope))]
      : []
    if (round === undefined) {
      ledgers.set(scopeKey(scope), { findings: ruleFindings, decisionItems: [], created: 0, existing: 0, settled: 0 })
      continue
    }
    notes.push(...instructionNotes(round.files))
    if (round.batches.length > 1 && round.failure === undefined) {
      semanticBatches += round.batches.length
      notes.push({ code: 'semantic-batched', text: `${scopeKey(scope)} 记忆较多，语义层分 ${round.batches.length} 批检查，不同批之间的冲突和重复可能查不出` })
    }
    if (round.failure !== undefined) {
      const failure = round.failure
      // 宿主报未登录、缺凭据：模型用不了，要用户去登录或补凭据，不算内容检查失败
      notes.push(failure.kind === 'model-error' && isModelUnavailableCode(failure.hostCode)
        ? { code: 'model-unavailable', text: `模型现在用不了（${failure.message ?? failure.hostCode}），没查到的记忆下次体检再查`, cause: failure }
        : { code: 'semantic-failed', text: '语义分析有一批没做成（LLM 调用出错或输出无法解析，已重试一次），没查到的记忆下次体检再查', cause: failure })
    }
    const coverage = coverageOf({
      isReadComplete: round.isReadComplete, baseline: baselineOf(round.files), total: round.total,
      ...(round.globalTotal !== undefined ? { globalTotal: round.globalTotal } : {}),
      batches: round.batches, history: round.history, runStop,
    })
    const valid = round.batches.filter(isBatchValid).map(b => (b.sent === 'ok' ? b.findings! : b.hit!.result))
    const carried = round.history === undefined ? [] : carriedFindings({
      rows: round.history, currentKeys: new Set(round.batches.map(b => b.key)), recheckBefore: round.recheckBefore,
      currentOf: copy => round.current.get(copy) ?? (isMemberUnread(copy) ? 'unread' : undefined),
      unresolved: unresolvedOf(round),
    })
    let storageFailure: CheckupCause | undefined
    // 先挂账（只挂有有效结果的批里的冲突；沿用的不重新挂账），再写视图：视图写成是这一轮的提交点
    let ledger: RoundLedger = { findings: [], decisionItems: [], created: 0, existing: 0, settled: 0 }
    try {
      ledger = await recordConflicts(deps, publishedFindings(valid, []), data.byId, round.baseline, now)
      // 挂账期间收到取消（插件卸载、认领被接手）：还没到提交点，视图、完成记录都不写；已挂的账留着，同中途退出
      signal?.throwIfAborted()
      // 一批有效结果都没有、也没有沿用的：留着上次的视图（读的时候按记忆现在的样子核对）；本来就没有要查的批照写空视图
      if (valid.length > 0 || carried.length > 0 || (round.batches.length === 0 && round.isReadComplete)) {
        const cacheId = scopeCacheKey(scope)
        const published = publishedFindings(valid, carried)
        const entry = { id: cacheId, scannedAt: now, scope: scopeKey(scope), findings: published, fingerprints: findingFingerprints(published, data.byId), isTrackedByCheckups: true }
        // 不回退：别的扫描开始得比这次晚、已经写过的，留着它的
        await deps.cache.update(cacheId, cur => (cur !== undefined && cur.scannedAt > now ? undefined : entry))
      }
      // 返回里的沿用发现同读侧口径：冲突只留账本里仍未决的（裁决过的照旧进视图，读的时候按账本核对）
      ledger = { ...ledger, findings: publishedFindings([ledger.findings], carried.filter(isConflictOpen(data.pending))) }
    } catch (err) {
      // 取消不是存储出错：往上抛，按提交前取消收
      if (isAbort(err, signal)) throw err
      // 原话进体检记录和视图：先遮掉疑似密钥
      storageFailure = { kind: 'error', message: maskDiagnostic(err instanceof Error ? err.message : String(err)) }
      log.warn(`[plastic-memory] 体检记不下 ${scopeKey(scope)} 的结果（挂账或写视图出错），这一轮按没做成算`, err)
      notes.push({ code: 'semantic-failed', text: `体检记不下这一轮的结果（${storageFailure.message}），这一轮按没做成算，下次体检再查`, cause: storageFailure })
    }
    ledgers.set(scopeKey(scope), { ...ledger, findings: [...ruleFindings, ...ledger.findings] })
    if (ledger.settled > 0) notes.push({ code: 'conflicts-settled', text: `${ledger.settled} 处冲突你之前裁决过两条都留，双方都没改，本次不再列出` })
    const closing = closingRow(coverage, storageFailure !== undefined)
    const cause = storageFailure ?? (closing === 'failed' || closing === 'model-unavailable' ? round.failure ?? runFailure : undefined)
    results.set(scopeKey(scope), { scope, coverage, closing, ...(cause !== undefined ? { cause } : {}) })
    commits.set(round.round, { isCommitted: storageFailure === undefined, isDbWritten: round.isDbWriteFailed !== true })
  }
  // 没有内容检查的范围（只有规则层）没有要提交的，算提交了；有内容检查的范围至少一轮提交成了才报
  if (scopes.some(scope => commits.get(scopeKey(scope))?.isCommitted ?? true)) run.onCommitted?.()

  // —— 提交之后：清库、清遗留垂直条目、提升候选、完成记录 ——
  const isSettledFully = (round: SemanticRound) => {
    const commit = commits.get(round.round)
    return commit !== undefined && commit.isCommitted && isFullyCovered(results.get(round.round)!.coverage)
  }
  for (const round of rounds) {
    if (round.history === undefined || !isSettledFully(round) || !commits.get(round.round)!.isDbWritten) continue
    resultsDb?.prune(round.round, new Set(round.batches.map(b => b.key)), round.recheckBefore)
  }
  const globalRound = roundByKey.get(GLOBAL_SCOPE_KEY)
  if (globalRound !== undefined && isSettledFully(globalRound)) {
    await afterCommit('清理全局记忆的遗留垂直条目', () => deps.decisions.dropStaleGlobalVertical(globalRound.baseline, id => data.byId.get(id)))
  }
  await afterCommit('同步提升候选', () => syncPromoteCandidates(deps, checkup ? wsList : wsPath !== undefined ? [wsPath] : [], now, log))
  if (deps.checkups !== undefined && layers === 'full') {
    const checkups = deps.checkups
    // 约下次接着查只给界面手动体检、自动体检（它们按约的时间排自动体检）；memory_scan 不约
    const isScheduling = run.by === 'manual' || run.by === 'auto'
    for (const { scope, closing, coverage } of results.values()) {
      // 有没命中的批但一批都没轮到：完成记录不写（上次的留着），约一天后接着查，免得自动体检每轮都来
      if (closing === 'not-reached' && isScheduling) await afterCommit('写体检记录', () => checkups.recordContinue(scope, now + CONTINUE_AFTER_MS, now))
      if (!isCompletionRow(closing)) continue
      // 到了上限停下、还有没查到的：完成记录照写（覆盖如实），约完成后一天接着查
      const completedAt = clock()
      await afterCommit('写体检记录', () => checkups.complete([scope], { startedAt: now, completedAt, by: run.by ?? 'agent', coverage },
        closing === 'capped' && isScheduling ? completedAt + CONTINUE_AFTER_MS : undefined))
    }
  }
  for (const scope of scopes) run.onScopeNotes?.(scope, notesOf(scope))

  if (checkup) {
    const notes: ScanNote[] = []
    for (const n of scopes.flatMap(notesOf)) if (!notes.some(m => m.code === n.code && m.text === n.text)) notes.push(n)
    const decisionItems: RoundLedger['decisionItems'] = []
    const seenDecisions = new Set<string>()
    for (const ledger of ledgers.values()) {
      for (const item of ledger.decisionItems) {
        if (seenDecisions.has(item.id)) continue // 同一冲突可能在多个作用域被复扫，呈现去重
        seenDecisions.add(item.id)
        decisionItems.push(item)
      }
    }
    const created = decisionItems.filter(i => i.isNew).length
    const existing = decisionItems.length - created

    // 跨项目重复（global 缺口）：命中用库里的结论；没命中、排进了计划、前面没停下的才调模型；排不进的这次没比。
    // layers=rule 或拿不到模型时只走实体聚类保底，不发语义调用
    let duplicates: CheckupScanResult['duplicates'] = { items: [], via: 'none' }
    let isCrossWsSkipped = false
    // 这次重算的结论写不进库：旧行不清（同各轮的 isDbWritten）
    let isCrossDbWritten = true
    if (byWorkspace.size >= 2) {
      if (cross === undefined || semanticLlm === null) duplicates = { items: findEntityDuplicates(byWorkspace, globalRecords), via: 'entity' }
      else if (cross.hit !== undefined) duplicates = { items: cross.hit.result, via: 'semantic' }
      else if (plan.steps.some(s => s.kind === 'cross-ws') && (runStop === 'done' || runStop === 'cap')) {
        signal?.throwIfAborted()
        const found = await runCrossWsScan(cross.byWorkspace, cross.global, semanticLlm, signal, onUsage)
        if (!found.failed) {
          duplicates = { items: found.items, via: 'semantic' }
          cross.hit = { key: cross.key, checkedAt: Math.max(clock(), cross.recheckBefore), members: cross.members, result: found.items }
          isCrossDbWritten = resultsDb?.write(CROSS_WS_ROUND, cross.hit) ?? true
        } else {
          notes.push({ code: 'cross-ws-failed', text: '跨项目重复分析失败（LLM 输出无法解析），退用实体聚类保底' })
          duplicates = { items: findEntityDuplicates(byWorkspace, globalRecords), via: 'entity' }
        }
      } else {
        isCrossWsSkipped = true
      }
      if (cross?.hit !== undefined && isCrossDbWritten && rounds.every(r => r.isReadComplete)) resultsDb?.prune(CROSS_WS_ROUND, new Set([cross.key]), cross.recheckBefore)
    }

    // 按作用域计分（与 memory_health 共用 prereadScopes + scoreScope，两个工具对同一作用域永远同分）。
    // 上面的扫描写了语义缓存与待决账本，计分前重读一份，口径与 health 读到的现状一致；读取抛错的范围同预读，记成没读全、照常计分
    const scored = await prereadScopes(deps, readScopes, undefined, { isReadErrorTolerated: true })
    const scoredScopes: Scope[] = [{ kind: 'global' }, ...wsList.map(workspacePath => ({ kind: 'workspace' as const, workspacePath }))]
    const rows = scoredScopes.map((scope) => {
      const r = scoreScope(deps, scored, scope, now)
      // 这次这个范围没跑内容检查（layers=rule、拿不到模型、没有自己的记忆）：给的是上次体检的覆盖，标明出处
      const thisRun = results.get(scopeKey(scope))?.coverage
      const coverage = thisRun ?? r.coverage
      return {
        ...checkupRowBase(r),
        ...(coverage !== undefined ? { coverage } : {}),
        ...(thisRun === undefined && coverage !== undefined ? { isCoverageFromLastCheckup: true as const } : {}),
        issues: r.ruleFindings.length + r.semanticFindings.length,
      }
    })

    // global 视角一：缺口检测——已标记候选聚合 + 跨项目重复主题
    const byWorkspaceCandidates = [...byWorkspace.entries()]
      .map(([workspacePath, records]) => ({
        workspacePath,
        items: records.filter(r => r.globalCandidate).map(r => ({ id: r.id, summary: maskSecretSurface(r).summary })).slice(0, PROMOTE_LIMIT),
      }))
      .filter(w => w.items.length > 0)
    const promoteCandidates = {
      total: [...byWorkspace.values()].reduce((s, rs) => s + rs.filter(r => r.globalCandidate).length, 0),
      byWorkspace: byWorkspaceCandidates,
    }

    // 体检收尾：清理孤儿语义缓存条目和体检结果库里的轮（真正删掉的项目的、历史遗留键）——体检本就是全库视角，天然的清扫时机，
    // 不受本次 scopes 子集影响。项目键按「真正删掉」判断（同体检记录、自动体检设置的清理口径）：在这次目录清单里、或项目文件夹判为还在，就留——
    // 记忆全在最近删除、还没有自己记忆、列完目录才建的项目都留着；不是项目路径的历史遗留键照旧清
    signal?.throwIfAborted()
    const listed = new Set(listing.entries.map(e => e.workspacePath))
    for (const key of scored.cache.keys()) {
      if (key === GLOBAL_CACHE_KEY) continue
      const workspacePath = key.slice(scopeCacheKey({ kind: 'workspace', workspacePath: '' }).length)
      const isProjectKey = isAbsolute(workspacePath) && scopeCacheKey({ kind: 'workspace', workspacePath }) === key
      if (!isProjectKey || await isWorkspaceGone(listed, workspacePath)) await deps.cache.delete(key)
    }
    // layers=rule 不碰体检结果库（同单个作用域）
    for (const round of (layers !== 'rule' ? resultsDb?.rounds() : undefined) ?? []) {
      if (round === GLOBAL_SCOPE_KEY || round === CROSS_WS_ROUND) continue
      if (!isAbsolute(round) || await isWorkspaceGone(listed, round)) resultsDb?.dropRound(round)
    }

    signal?.throwIfAborted()
    return {
      kind: 'checkup', rows,
      pendingDecisions: { created, existing, items: decisionItems },
      crossLayerConflicts: crossScopeConflicts(scored.byId, scored.pending),
      promoteCandidates, duplicates, notes,
      ...(isCrossWsSkipped ? { isCrossWsSkipped: true as const } : {}),
      ...(results.size > 0 ? { rounds: [...results.values()] } : {}),
      directoryNotes: [...listingNotes(listing, { includeEmpty: true }), ...data.directoryNotes],
      message: `全库体检完成：global + ${wsList.length} 个 workspace 各自独立扫描计分${created > 0 ? `，新增 ${created} 个待决冲突` : ''}${partialNote(results.values())}。清理需用户确认后执行：删除用 memory_forget，冲突裁决用 memory_confirm，提升全局用 memory_promote。`,
      ...extras(semanticBatches),
    }
  }

  // 单个作用域：输入用可见集合（global + 本项目）——global 里的问题（含最高危的 secret）对本会话同样生效，
  // 跨作用域的冲突也要双方同在 prompt 里才可判；分数归属的拆分在 memory_health（scoreScope）做。
  const records = inputOf(target)
  const ledger = ledgers.get(scopeKey(target))!
  const notes = notesOf(target)

  // 用户忽略的建议不列为发现（语义缓存仍存完整结果：取消忽略后不用重扫就能回来）
  const { kept: findings, ignored } = applyIgnores(ledger.findings, data.ignores, data.byId)
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
  const allCandidates = records.filter(r => r.globalCandidate).map(r => ({ id: r.id, summary: maskSecretSurface(r).summary }))
  const promoteCandidates = {
    items: allCandidates.slice(0, PROMOTE_LIMIT),
    more: Math.max(0, allCandidates.length - PROMOTE_LIMIT),
  }

  const noteSuffix = notes.length > 0 ? `（${notes.map(n => n.text).join('；')}）` : ''
  const scopeLabel = wsPath === undefined ? 'global 记忆'
    : wsPath === currentWs ? '本项目可见记忆'
    : `workspace ${wsPath} 可见记忆`
  const semanticCachedAt = (await deps.cache.get(scopeCacheKey(target)))?.scannedAt ?? null
  signal?.throwIfAborted()
  return {
    kind: 'single',
    layer: wsPath !== undefined ? 'workspace' : 'global',
    ...(wsPath !== undefined ? { workspacePath: wsPath } : {}),
    findings,
    pendingDecisions: { created: ledger.created, existing: ledger.existing, items: ledger.decisionItems },
    stats, ignoredCount: ignored.length, promoteCandidates,
    semanticCachedAt,
    notes,
    directoryNotes: [...listingNotes(listing, { includeEmpty: false }), ...data.directoryNotes],
    message: `扫描${scopeLabel} ${stats.scanned} 条，${issuesText(stats.issues, results.get(scopeKey(target))?.coverage)}${ledger.created > 0 ? `，新增 ${ledger.created} 个待决冲突` : ''}${promoteCandidates.items.length > 0 ? `，${allCandidates.length} 条建议提升全局` : ''}${noteSuffix}。清理需用户确认后执行：删除用 memory_forget，冲突裁决用 memory_confirm，提升全局用 memory_promote。`,
    ...(results.size > 0 ? { rounds: [...results.values()] } : {}),
    ...extras(semanticBatches),
  }
}

/** 单个作用域的「发现几个问题」：内容检查没覆盖全时不说「发现 0 个问题」，说查到的部分怎样、还有几条没查。 */
function issuesText(issues: number, coverage: CheckupCoverage | undefined): string {
  if (isCoverageClear(coverage)) return `发现 ${issues} 个问题`
  const unchecked = uncheckedCount(coverage!)
  const rest = unchecked > 0 ? `内容检查还有 ${unchecked} 条没查到` : '内容检查没覆盖全'
  return issues > 0 ? `查到的部分发现 ${issues} 个问题，${rest}` : `查到的部分没有发现问题，${rest}`
}

/** 全库报告里「有几个范围没覆盖全」：都覆盖全了为空串。 */
function partialNote(results: Iterable<ScanRoundResult>): string {
  const partial = [...results].filter(r => !isFullyCovered(r.coverage)).length
  return partial > 0 ? `，其中 ${partial} 个范围的内容检查没覆盖全（见各行）` : ''
}

/** 这份副本这次读到了（任何状态）：同 id 读到的是别的作用域里的那份，不算。 */
function isRead(copy: string, byId: ReadonlyMap<string, MemoryRecord>): boolean {
  const id = memberIdOf(copy)
  const r = id === undefined ? undefined : byId.get(id)
  return r !== undefined && memberCopyKey(r) === copy
}
