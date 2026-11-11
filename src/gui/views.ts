import { relative, sep } from 'node:path'
import type { MemoryRecord } from '../record-schema.ts'
import type { TypeRegistry } from '../type-registry.ts'
import type { DirectoryNote, LocatedRecord } from '../storage/table.ts'
import { RETENTION_MS } from '../retention.ts'
import { hasCriticalSecret, maskSecretSurface, maskSecrets } from '../secrets.ts'
import { computeDigest } from '../storage/frontmatter.ts'
import { FINDING_TYPES, kindOf, verdictLoser, type FindingType, type MemorySnapshot, type PendingDecision } from '../governance/schema.ts'
import { candidateFingerprint, isBasisCurrent, overflowLevelOf, overflowScopeOf } from '../governance/decisions.ts'
import { asUndoable, isModelChange, undoStateOf } from '../governance/undo-rules.ts'
import { runRuleScan } from '../governance/rule-scan.ts'
import { byConfidenceThenConfirmed } from '../snapshot.ts'
import { scoreScope, type ScopePreread } from '../governance/scope-health.ts'
import type { IgnoredAdvice } from '../governance/advice-ignores.ts'
import { autoCheckupDue, autoCheckupRetryAt, isRetryLimitReached } from '../governance/auto-checkups.ts'
import { RULE_PENALTY_TYPES, SEMANTIC_NOISE_TYPES } from '../governance/scoring.ts'
import type { CheckupRecord } from '../storage/schema.ts'
import type { ScanNoteCode } from '../contract-codes.ts'
import {
  ADVICE_TYPES, GUI_VIEW_VERSION, PENDING_ITEM_KINDS, PENDING_LEVEL_OF_KIND, PENDING_LEVELS, SCOPE_KEYS, checkupKey, isAwaitingDecision, resolveAutoCheckup,
  pendingItemKey, pendingItemScopes,
  type AdviceType, type AutoCheckupFrequency, type CheckupAdded, type CheckupCause, type CheckupResult, type CheckupView, type DeletedView, type MemoryPromotion, type GlobalViewName, type HealthView, type LibraryView, type MemoryCard,
  type MemoryCommandResult, type ModelChange, type PendingItem, type PendingView, type SessionView,
} from './contract.ts'
import { isInScope, scopeCacheKey, scopeKey, scopeOfLedger, scopeOfMemory, type Scope } from '../scope.ts'
import { isCopyOf } from '../tools/workspace-gate.ts'

/**
 * 视图生成（纯函数）：预读数据 + 账本 → 界面要读的视图 JSON（契约见 contract.ts）。不读存储、不写盘。
 * 预读由 view-writer.ts 的 collectGlobalViews 做（复用 memory_health / memory_scan 的 prereadScopes）。
 */
export interface ViewInput {
  now: number
  memoryRoot: string
  registry: TypeRegistry
  /** prereadScopes 读 readScopes 的结果。 */
  data: ScopePreread
  /** 读了哪些作用域：global + 全部 workspace 目录（含只剩归档的，最近删除要用）。 */
  readScopes: readonly Scope[]
  /** 健康视图列哪些作用域：global + 体检清单。 */
  healthScopes: readonly Scope[]
  /** 账本里的未决条目（全部种类）与已裁决条目。 */
  open: readonly PendingDecision[]
  settled: readonly PendingDecision[]
  /** 目录枚举的说明（缺标记、不可读目录）。 */
  listingNotes: readonly DirectoryNote[]
  /** 体检开关的当前值。 */
  governanceEnabled: boolean
  /** 插件本次加载的时刻；缺省不写进视图。 */
  bootedAt?: number
  /** 模型改写、替代的改前快照（按快照 id）；缺省不列 modelChanges。 */
  modelChangeSnapshots?: ReadonlyMap<string, MemorySnapshot>
  /**
   * 条目所在作用域里的那一份（按条目 id）：提升候选取条目所在的项目，模型改写、替代取改前那份的作用域。
   * 只列 data.byId 取到的是别的作用域里那份的；那个作用域里已经没有的不列，按 byId 是否在那个作用域判。
   */
  entryCopies?: ReadonlyMap<string, LocatedRecord>
}

export type GlobalViews = { pending: PendingView; health: HealthView; library: LibraryView; deleted: DeletedView }

export function buildGlobalViews(input: ViewInput): GlobalViews {
  return {
    pending: buildPendingView(input),
    health: buildHealthView(input),
    library: buildLibraryView(input),
    deleted: buildDeletedView(input),
  }
}

export const GLOBAL_VIEW_NAMES: readonly GlobalViewName[] = ['pending', 'health', 'library', 'deleted']

const byNameThenId = (a: MemoryRecord, b: MemoryRecord) =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0

/** 记忆卡：四个文字面遮盖密钥片段，路径原样；digest 按原文算（直接改的版本核对用）。 */
function card(r: MemoryRecord, data: ScopePreread, filePath = data.filePaths.get(r.id) ?? ''): MemoryCard {
  const m = maskSecretSurface(r)
  return {
    id: r.id, name: m.name, type: r.type, scope: r.scope,
    ...(r.workspacePath !== undefined ? { workspacePath: r.workspacePath } : {}),
    summary: m.summary, content: m.content, tags: m.tags,
    ...(r.source !== undefined ? { sourceMode: r.source.sourceMode, sourceSessionId: r.source.sessionId } : {}),
    createdAt: r.createdAt, updatedAt: r.updatedAt, lastConfirmedAt: r.lastConfirmedAt,
    ...(r.validTo !== undefined ? { validTo: r.validTo } : {}),
    ...(r.handEdited ? { handEdited: true } : {}),
    ...(r.delegation !== undefined
      ? { delegation: { depth: r.delegation.depth, ...(r.delegation.reviewed !== undefined ? { reviewed: r.delegation.reviewed.by } : {}) } }
      : {}),
    filePath,
    digest: computeDigest(r.name, r.summary, r.content),
    // 与遮盖同口径只看高危：疑似的界面上是原文，照着改不会写回占位文字
    ...(hasCriticalSecret(r) ? { hasSecret: true as const } : {}),
  }
}

function cardOf(id: string | undefined, data: ScopePreread): MemoryCard | null {
  const r = id === undefined ? undefined : data.byId.get(id)
  return r === undefined ? null : card(r, data)
}

function activeRecords(data: ScopePreread): MemoryRecord[] {
  return [...data.byId.values()].filter(r => r.status === 'active').sort(byNameThenId)
}

/** 待处理：密钥（规则扫描实时判，与健康分同口径）、账本未决条目（体检开时）、读不出的文件、建议整理。 */
export function buildPendingView(input: ViewInput): PendingView {
  const { data } = input
  const items: PendingItem[] = []
  const active = activeRecords(data)
  for (const f of runRuleScan(active, id => data.byId.get(id), input.now)) {
    if (f.type === 'secret') items.push({ kind: 'secret', level: PENDING_LEVEL_OF_KIND.secret, memory: card(data.byId.get(f.memoryIds[0])!, data) })
  }
  // 体检关闭（spec 35）：只剩不靠模型的条目——规则检查出的密钥、读不出的文件、超限提醒；冲突与提升候选照留在账本里，打开后回来
  const ledger = input.governanceEnabled ? input.open : input.open.filter(e => kindOf(e) === 'overflow')
  for (const e of [...ledger].sort((a, b) => a.firstSeenAt - b.firstSeenAt)) {
    const base = { decisionId: e.id, firstSeenAt: e.firstSeenAt }
    const kind = kindOf(e)
    if (kind === 'promote-candidate') {
      // 记忆已不是本项目候选（模型直接 memory_promote、标记被清、记忆没了）：旧条目不显示，下次体检清掉。
      // 取条目所在项目的那一份（提升命令定位的就是它），同 id 别的项目那份不算
      const copy = input.entryCopies?.get(e.id)
      const r = copy?.record ?? data.byId.get(e.memoryIds[0] ?? '')
      const workspacePath = e.workspaces?.[0]
      const own = workspacePath === undefined ? undefined : scopeOfLedger(workspacePath)
      const isOwnCopy = own === undefined || own.kind === 'global' || r?.workspacePath === own.workspacePath
      if (r?.status === 'active' && r.scope === 'workspace' && r.globalCandidate && isOwnCopy) {
        items.push({ kind, level: PENDING_LEVEL_OF_KIND[kind], ...base, memory: card(r, data, copy?.filePath) })
      }
    }
    else if (kind === 'overflow') {
      const label = overflowScopeOf(e)
      const scope = label === undefined ? undefined : scopeOfLedger(label)
      items.push({ kind, level: PENDING_LEVEL_OF_KIND[kind], ...base, ...overflowLevelOf(e), ...(scope?.kind === 'workspace' ? { workspacePath: scope.workspacePath } : {}) })
    }
    else if (e.baselineRef !== undefined) {
      items.push({ kind: 'conflict-vertical', level: PENDING_LEVEL_OF_KIND['conflict-vertical'], ...base, summary: e.summary, memory: cardOf(e.memoryIds[0], data), baselineRef: e.baselineRef })
    } else {
      const preferred = e.memoryIds.slice(0, 2).map(id => data.byId.get(id)).filter(r => r !== undefined).sort(byConfidenceThenConfirmed)[0]
      items.push({
        kind: 'conflict-horizontal', level: PENDING_LEVEL_OF_KIND['conflict-horizontal'], ...base, summary: e.summary, left: cardOf(e.memoryIds[0], data), right: cardOf(e.memoryIds[1], data),
        ...(preferred !== undefined ? { preferredId: preferred.id } : {}),
        ...suggestionState(e, data),
      })
    }
  }
  for (const scope of input.readScopes) {
    for (const q of data.quarantined.get(scopeCacheKey(scope)) ?? []) {
      items.push({
        // 显示用的相对路径与体检说明同口径遮一遍（手起名的文件名可能带密钥）；filePath 是打开文件用的，照给
        kind: 'unreadable-file', level: PENDING_LEVEL_OF_KIND['unreadable-file'], layer: scope, filePath: q.path,
        relativePath: maskSecrets(relative(input.memoryRoot, q.path).split(sep).join('/')), error: q.error,
      })
    }
  }
  // 提升候选和放错层合并：已有提升卡的项目记忆，放错层（项目 → 全局）不另列，扣分照旧（健康分不经这里）
  const promoting = items.flatMap(i => i.kind === 'promote-candidate' && i.memory !== null ? [i.memory] : [])
  const isMergedIntoPromote = (i: PendingItem) => i.kind === 'advice' && i.type === 'misplaced'
    && i.memories.every(m => promoting.some(p => p.id === m.id && p.workspacePath === m.workspacePath && m.scope === 'workspace'))
  items.push(...adviceItems(input).filter(i => !isMergedIntoPromote(i)))
  // 稳定排序（PENDING_ITEM_KINDS 已按级别排）：同类保持上面的先后（账本按 firstSeenAt）
  const rank = (i: PendingItem) => PENDING_ITEM_KINDS.indexOf(i.kind)
  items.sort((a, b) => rank(a) - rank(b))
  const dot = items.some(i => i.kind === 'secret') ? 'red'
    : items.some(isAwaitingDecision) ? 'amber' : 'none'
  const cards = items.flatMap(i => i.kind === 'conflict-horizontal' ? [i.left, i.right] : i.kind === 'advice' ? i.memories : 'memory' in i ? [i.memory] : [])
  const levelCounts = Object.fromEntries(PENDING_LEVELS.map(level => [level, items.filter(i => i.level === level).length])) as PendingView['levelCounts']
  return { version: GUI_VIEW_VERSION, generatedAt: input.now, dot, items, levelCounts, typeLabels: typeLabels(input.registry, cards.map(m => m?.type)) }
}

/**
 * 冲突项的处理建议（账本存盘形状映射到契约）：条目未决（调用方只传未决条目）、冲突指纹和每条记忆此刻的完整内容指纹都和建议的依据一致，
 * 才给 suggestion；否则给没有建议的原因：任一条含高危密钥、最近一次模型判断不了或生成失败（依据同样要对得上）、还没生成。一方定位不到时两个都不给。
 * 改写稿按卡片口径遮高危密钥（存盘的稿保证没有高危，这里兜底）。
 */
function suggestionState(e: PendingDecision, data: ScopePreread): Pick<Extract<PendingItem, { kind: 'conflict-horizontal' }>, 'suggestion' | 'noSuggestion'> {
  const records = e.memoryIds.map(id => data.byId.get(id))
  if (records.some(r => r?.status !== 'active')) return {}
  const { suggestion, suggestionFailure } = e
  if (suggestion !== undefined && isBasisCurrent(e, suggestion.basis, records)) {
    const ops = suggestion.ops.map(op => (op.kind === 'edit' ? { ...op, ...maskSecretSurface(op) } : op))
    return { suggestion: { id: suggestion.id, action: suggestion.action, reason: suggestion.reason, ops, isSourced: suggestion.isSourced } }
  }
  if (records.some(r => hasCriticalSecret(r!))) return { noSuggestion: { code: 'has-secret' } }
  if (suggestionFailure !== undefined && isBasisCurrent(e, suggestionFailure.basis, records)) {
    const { kind, hostCode, message, reason } = suggestionFailure.cause
    if (kind === 'undecided') return { noSuggestion: { code: 'undecided', reason: reason ?? '' } }
    return { noSuggestion: { code: 'failed', cause: { kind, ...(hostCode !== undefined ? { hostCode } : {}), ...(message !== undefined ? { message } : {}) } } }
  }
  return { noSuggestion: { code: 'not-generated' } }
}

/** 语义体检来的建议类型：内容重复整组一项，放错层、表述不清每条记忆一项。 */
const SEMANTIC_ADVICE_TYPES: ReadonlySet<AdviceType> = new Set(['redundancy', 'misplaced', 'unclear'])

/**
 * 建议整理（现算、不入账本）：与健康分同一次评分（scoreScope）的规则发现、语义缓存发现和超期记忆，所以只出体检清单里各作用域的
 * active 记忆；语义缓存里指向已删、已取代或已不在这个作用域的记忆的发现、用户忽略的建议，评分已经滤掉。规则类与超期不靠模型，体检关闭时照常列出；
 * 语义类和冲突一样，体检关闭时不出（冲突走账本，不在这里）。同一身份（类型 + 排序后的记忆 id）只出一项。
 * 按问题类型排，同类按作用域（global 在前）、再按（第一条记忆的）名称。
 */
function adviceItems(input: ViewInput): PendingItem[] {
  const { data } = input
  const found = input.healthScopes.flatMap((scope, scopeIndex) => {
    const r = scoreScope({ registry: input.registry }, data, scope, input.now)
    const semantic = input.governanceEnabled ? r.semanticFindings : []
    const groups = (type: AdviceType): string[][] => {
      if (type === 'stale') return r.staleIds.map(id => [id])
      if (!SEMANTIC_ADVICE_TYPES.has(type)) return r.ruleFindings.filter(f => f.type === type).flatMap(f => f.memoryIds.map(id => [id]))
      const hits = semantic.filter(f => f.type === type)
      return type === 'redundancy' ? hits.map(f => [...f.memoryIds].sort()) : hits.flatMap(f => f.memoryIds.map(id => [id]))
    }
    return ADVICE_TYPES.flatMap(type => groups(type).map(ids => ({ type, scopeIndex, records: ids.map(id => data.byId.get(id)!) })))
  })
  const seen = new Set<string>()
  const unique = found.filter((f) => {
    const key = `${f.type}:${f.records.map(r => r.id).join(',')}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  unique.sort((a, b) => ADVICE_TYPES.indexOf(a.type) - ADVICE_TYPES.indexOf(b.type) || a.scopeIndex - b.scopeIndex || byNameThenId(a.records[0]!, b.records[0]!))
  return unique.map(({ type, records }) => ({ kind: 'advice', level: PENDING_LEVEL_OF_KIND.advice, type, memories: records.map(r => card(r, data)) }))
}

/**
 * 体检结果（`scan` 命令）：体检后的待处理里有、体检前没有的项按级别计数，以及体检后各作用域的健康分。
 * covered = 本次体检覆盖的作用域，'all' 是全库体检；只数、只列涉及这些作用域的。用户忽略的建议本就不在待处理里，不会算进来。
 */
export function scanOutcome(
  before: PendingView,
  after: Pick<GlobalViews, 'pending' | 'health'>,
  covered: readonly Scope[] | 'all',
): Required<Pick<Extract<MemoryCommandResult, { ok: true }>, 'added' | 'scores'>> {
  const isCovered = (scope: Scope) => covered === 'all' || covered.some(c => scopeKey(c) === scopeKey(scope))
  const added = addedItems(before, after.pending, covered)
  const pending = added.filter(i => i.level !== 'advice')
  const levels = [...new Set(pending.map(i => i.level))]
  return {
    added: {
      pending: pending.length, advice: added.length - pending.length,
      ...(levels.length === 1 ? { pendingLevel: levels[0] } : {}),
    },
    scores: after.health.layers.filter(l => isCovered(l.layer)).map(l => ({ layer: l.layer, score: l.score })),
  }
}

/** 体检新增的待处理项：体检后有、体检前没有（按身份比较），且属于本次体检覆盖的作用域（'all' 是全部作用域），按体检后视图里的先后。 */
function addedItems(before: PendingView, after: PendingView, covered: readonly Scope[] | 'all'): PendingItem[] {
  const seen = new Set(before.items.map(pendingItemKey))
  return after.items.filter(i => !seen.has(pendingItemKey(i)) && (covered === 'all' || pendingItemScopes(i).some(s => covered.some(c => scopeKey(c) === scopeKey(s)))))
}

function addedOf(items: readonly PendingItem[]): CheckupAdded {
  const pending = items.filter(i => i.level !== 'advice').length
  return { keys: items.map(pendingItemKey), pending, advice: items.length - pending }
}

/** 体检的目标：只查全局、某个项目，或全部（scopes 是这次被查的每个范围）。 */
export type CheckupTarget = Scope | { kind: 'all'; scopes: readonly Scope[] }

/**
 * 一次界面手动体检或自动体检的最近一次结果，按范围给出要写进体检记录表的各条（键 → 结果）；字段口径见 contract.ts checkupResultSchema。
 * 判新增的覆盖范围同 scan 命令：全局是全局，项目是全局加本项目，全部是所有作用域。说明只留说明码和原因（文字是给模型看的）。
 */
export function checkupResults(before: PendingView, after: PendingView, run: {
  target: CheckupTarget
  checkupId: string
  by: CheckupResult['by']
  completedAt: number
  usageTokens?: number
  notes: ReadonlyArray<{ code: ScanNoteCode; cause?: CheckupCause }>
  /** 「全部」体检时各范围自己的说明（键同体检记录表）；没给的范围用整次的 notes。 */
  scopeNotes?: ReadonlyMap<string, ReadonlyArray<{ code: ScanNoteCode; cause?: CheckupCause }>>
}): Array<{ key: string; result: CheckupResult }> {
  const { target } = run
  const toNotes = (notes: typeof run.notes) => notes.map(n => ({ code: n.code, ...(n.cause !== undefined ? { cause: n.cause } : {}) }))
  const base = { checkupId: run.checkupId, by: run.by, completedAt: run.completedAt, notes: toNotes(run.notes) }
  const usage = run.usageTokens !== undefined ? { usageTokens: run.usageTokens } : {}
  const belongsTo = (scope: Scope) => (i: PendingItem) => pendingItemScopes(i).some(s => scopeKey(s) === scopeKey(scope))
  if (target.kind === 'global') {
    const added = addedItems(before, after, [{ kind: 'global' }])
    return [{ key: checkupKey({ kind: 'global' }), result: { ...base, added: addedOf(added), ...usage } }]
  }
  if (target.kind === 'workspace') {
    const added = addedItems(before, after, [{ kind: 'global' }, target])
    // 项目体检读全局：顺带发现、只属于全局的新增记在全局名下，不算本项目的
    const result = { ...base, added: addedOf(added.filter(belongsTo(target))), globalAdded: addedOf(added.filter(i => !belongsTo(target)(i))), ...usage }
    return [{ key: checkupKey(target), result }]
  }
  const added = [...new Map(addedItems(before, after, 'all').map(i => [pendingItemKey(i), i])).values()]
  const groups = new Map<string, { scope: Scope; keys: string[] }>()
  for (const item of added) {
    for (const scope of pendingItemScopes(item)) {
      const id = scope.kind === 'global' ? '' : scope.workspacePath
      const group = groups.get(id) ?? { scope, keys: [] }
      group.keys.push(pendingItemKey(item))
      groups.set(id, group)
    }
  }
  // 全局（id 为空串）在前，项目按路径
  const byScope = [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, g]) => g)
  return [
    ...target.scopes.map(scope => {
      const own = run.scopeNotes?.get(checkupKey(scope))
      return { key: checkupKey(scope), result: { ...base, ...(own !== undefined ? { notes: toNotes(own) } : {}), added: addedOf(added.filter(belongsTo(scope))) } }
    }),
    { key: SCOPE_KEYS.all, result: { ...base, added: addedOf(added), byScope, ...usage } },
  ]
}

/** 注册表里的类型加上视图里出现的类型（切模板后旧模板的、认不出的），读时 get 给显示名。 */
function typeLabels(registry: TypeRegistry, present: Iterable<string | undefined>): Record<string, string> {
  const types = new Set(registry.all().map(t => t.name))
  for (const type of present) if (type !== undefined) types.add(type)
  return Object.fromEntries([...types].map(name => [name, registry.get(name).label]))
}

/** 类型组的顺序：当前场景按注册表顺序，视图里出现的其他类型按 id 排在后面。 */
function typeOrder(registry: TypeRegistry, present: Iterable<string>): string[] {
  const scene = registry.all().map(t => t.name)
  const others = [...new Set(present)].filter(name => !scene.includes(name)).sort()
  return [...scene, ...others]
}

/** 健康：每个作用域复用 scoreScope（与 memory_health / memory_scan 同分，同样剔除用户忽略的建议，另列在 ignored）；有密钥的作用域不打分。 */
export function buildHealthView(input: ViewInput): HealthView {
  return {
    version: GUI_VIEW_VERSION,
    generatedAt: input.now,
    governanceEnabled: input.governanceEnabled,
    ...(input.bootedAt !== undefined ? { bootedAt: input.bootedAt } : {}),
    layers: input.healthScopes.map(scope => {
      const r = scoreScope({ registry: input.registry }, input.data, scope, input.now)
      return {
        layer: scope,
        totalMemories: r.records.length,
        score: r.health.gate.secret ? null : Math.round(r.health.score * 100) / 100,
        tier: r.health.tier,
        gate: r.health.gate,
        issues: FINDING_TYPES.filter(t => r.health.counts[t] > 0).map(type => ({ type, count: r.health.counts[type] })),
        lastCheckupAt: r.lastCheckupAt,
        ignored: ignoredOfScope(r.ignored, input.data),
        deductions: deductionsOf(r.health),
      }
    }),
  }
}

/** 扣分来源：评分模块已分开算好的三项扣分，各带此刻有的问题类型（按 FINDING_TYPES 的顺序）。 */
function deductionsOf(health: ReturnType<typeof scoreScope>['health']): HealthView['layers'][number]['deductions'] {
  const round = (points: number) => Math.round(points * 100) / 100
  const present = (types: readonly FindingType[]) => FINDING_TYPES.filter(t => types.includes(t) && health.counts[t] > 0)
  return {
    rule: { points: round(health.rulePenalty), types: present(RULE_PENALTY_TYPES) },
    content: { points: round(health.semanticPenalty), types: present(['conflict', ...SEMANTIC_NOISE_TYPES]) },
    freshness: { points: round(health.freshness.penalty), types: health.freshness.staleCount > 0 ? ['stale'] : [] },
  }
}

/**
 * 体检视图：每个范围的有效频率（跟随还是单独设置）、上次体检、下次自动体检、是否到期、是否在体检、自动体检的连续失败和「模型用不了」，
 * 外加体检开关。scopes 是全局加体检清单（与健康视图同一批作用域、同一顺序）；lastCheckupAt 给出每个范围的上次体检，
 * isInProgress 给出它此刻有没有体检认领着，record 给出它在体检记录表里的那条（没有为 undefined）；allRecord 是键 all 的那条。
 */
export function buildCheckupView(input: {
  now: number
  governanceEnabled: boolean
  settings: ReadonlyMap<string, AutoCheckupFrequency>
  scopes: readonly Scope[]
  lastCheckupAt: (scope: Scope) => number | null
  isInProgress: (scope: Scope) => boolean
  record: (scope: Scope) => CheckupRecord | undefined
  allRecord: CheckupRecord | undefined
}): CheckupView {
  return {
    version: GUI_VIEW_VERSION,
    generatedAt: input.now,
    governanceEnabled: input.governanceEnabled,
    defaultFrequency: resolveAutoCheckup(input.settings, { kind: 'all' }).frequency,
    allResult: input.allRecord?.lastResult ?? null,
    scopes: input.scopes.map(scope => {
      const { frequency, isOwn } = resolveAutoCheckup(input.settings, scope)
      const lastCheckupAt = input.lastCheckupAt(scope)
      const { failure, modelUnavailable, lastResult } = input.record(scope) ?? {}
      return {
        scope, frequency, isOwn, lastCheckupAt, ...autoCheckupDue(frequency, lastCheckupAt, input.now), isInProgress: input.isInProgress(scope),
        // 重试时间按此刻的有效频率现算；仅手动时不会自动重试（不到期），按 0 天算，界面也不显示
        failure: failure === undefined ? null : {
          count: failure.count, retryAt: autoCheckupRetryAt(failure.count, failure.failedAt, frequency === 'manual' ? 0 : frequency),
          isRetryLimitReached: isRetryLimitReached(failure.count), cause: failure.cause,
        },
        modelUnavailable: modelUnavailable ?? null,
        lastResult: lastResult ?? null,
      }
    }),
  }
}

/** 本作用域「已忽略」：记忆名称与摘要遮盖密钥；按问题类型（建议整理的顺序）、再按第一条记忆的名称排。 */
function ignoredOfScope(ignored: readonly IgnoredAdvice[], data: ScopePreread): HealthView['layers'][number]['ignored'] {
  return ignored
    .map(({ type, memoryIds }) => ({
      type,
      memories: memoryIds.map(id => data.byId.get(id)!).map((r) => {
        const m = maskSecretSurface(r)
        return { id: r.id, name: m.name, summary: m.summary }
      }),
    }))
    .sort((a, b) => ADVICE_TYPES.indexOf(a.type) - ADVICE_TYPES.indexOf(b.type)
      || (a.memories[0]!.name < b.memories[0]!.name ? -1 : a.memories[0]!.name > b.memories[0]!.name ? 1 : 0))
}

/**
 * 项目记忆的提升状态：账本里有它「留在本项目」的已结清条目、且它没有候选标记或内容没变（同体检：指纹对得上不再提）的是留下了；
 * 其余带候选标记的是候选（体检关闭时不标，同待处理）。
 */
function promotionReader(input: ViewInput): (r: MemoryRecord) => MemoryPromotion | undefined {
  const keptLocal = new Map(input.settled
    .filter(e => kindOf(e) === 'promote-candidate' && e.settled?.verdict === 'keep-local')
    .map(e => [`${e.memoryIds[0]}\0${e.workspaces?.[0]}`, e.fingerprint]))
  return (r) => {
    if (r.scope !== 'workspace') return undefined
    const key = `${r.id}\0${r.workspacePath}`
    if (keptLocal.has(key) && (!r.globalCandidate || keptLocal.get(key) === candidateFingerprint(r))) return 'kept-local'
    return r.globalCandidate && input.governanceEnabled ? 'candidate' : undefined
  }
}

/** 全部记忆：按作用域列 active 记忆；空的项目不列，global 总在。目录问题不含 dir-empty（那不是问题）。 */
export function buildLibraryView(input: ViewInput): LibraryView {
  const active = activeRecords(input.data)
  const promotionOf = promotionReader(input)
  const scopeGroups = input.readScopes
    .map(scope => ({
      layer: scope,
      items: active.filter(r => isInScope(r, scope)).map((r) => {
        const promotion = promotionOf(r)
        return promotion === undefined ? card(r, input.data) : { ...card(r, input.data), promotion }
      }),
    }))
    .filter(l => l.layer.kind === 'global' || l.items.length > 0)
  const directoryIssues = [...input.listingNotes, ...input.data.directoryNotes]
    .filter(n => n.code !== 'dir-empty')
    .map(n => ({ code: n.code, path: n.path, ...(n.keys !== undefined ? { keys: n.keys } : {}), ...(n.keptPath !== undefined ? { keptPath: n.keptPath } : {}) }))
  const presentTypes = scopeGroups.flatMap(l => l.items.map(m => m.type))
  const typeLabelsOfView = typeLabels(input.registry, presentTypes)
  // byId 每个 id 一份（在用副本优先）：不在用的就是这个 id 没有在用副本
  const inactiveIds = [...input.data.byId.values()].filter(r => r.status !== 'active').map(r => r.id)
  const hasUnreadFiles = input.readScopes.some(s => (input.data.quarantined.get(scopeCacheKey(s)) ?? []).length > 0)
    || directoryIssues.some(i => i.code === 'marker-missing' || i.code === 'dir-unreadable')
  return {
    version: GUI_VIEW_VERSION, generatedAt: input.now, memoryRoot: input.memoryRoot, layers: scopeGroups, directoryIssues,
    inactiveIds, hasUnreadFiles, typeLabels: typeLabelsOfView, typeOrder: typeOrder(input.registry, presentTypes),
    ...(input.modelChangeSnapshots !== undefined ? { modelChanges: modelChangesOf(input, input.modelChangeSnapshots) } : {}),
  }
}

/**
 * 保留窗口内模型改写、替代的改动（对话卡、右侧栏「这次新写入的」）：改前那份取快照，快照已清或只剩脱敏副本的不列。
 * 能不能撤问撤销规则（undoStateOf），现状取改前那份所在作用域里的那一份：别的作用域里同 id 的副本不算，与撤销命令核对的是同一份。
 */
function modelChangesOf(input: ViewInput, snapshots: ReadonlyMap<string, MemorySnapshot>): ModelChange[] {
  const cutoff = input.now - RETENTION_MS
  return input.settled.flatMap((e): ModelChange[] => {
    const entry = asUndoable(e)!
    const { settled } = entry
    if (!isModelChange(entry) || entry.origin === undefined || settled.at < cutoff || settled.snapshotId === undefined) return []
    const memoryId = entry.memoryIds[0]!
    const before = snapshots.get(settled.snapshotId)?.data.find(r => r.id === memoryId)
    if (before === undefined || before.redacted === true) return []
    const at = scopeOfMemory(before)
    const state = undoStateOf(entry, before, at === undefined ? undefined : copyIn(input, entry.id, memoryId, at))
    if (state === 'expired') return []
    return [{
      decisionId: entry.id, kind: entry.kind === 'rewrite' ? 'rewrite' : 'supersede', memoryId,
      ...(entry.origin.by !== undefined ? { by: entry.origin.by } : {}),
      before: card(before, input.data),
      sessionId: entry.origin.sessionId, callId: entry.origin.callId, at: settled.at, state,
    }]
  })
}

/** 条目目标在 at 那个作用域里的那一份：预读留下的就在那里用它，否则取 entryCopies 补读的；都没有算那里已经没有。 */
function copyIn(input: ViewInput, entryId: string, memoryId: string, at: Scope): MemoryRecord | undefined {
  const r = input.data.byId.get(memoryId)
  return r !== undefined && isCopyOf(r, at) ? r : input.entryCopies?.get(entryId)?.record
}

/** 最近删除：保留窗口内软删的记忆；裁决删掉的从已裁决条目找来源（同一条记忆被多次裁决取最近的）。 */
export function buildDeletedView(input: ViewInput): DeletedView {
  const cutoff = input.now - RETENTION_MS
  const causeById = new Map<string, PendingDecision>()
  for (const e of input.settled) {
    const loser = verdictLoser(e, e.settled!.verdict)
    if (loser === undefined) continue
    const prev = causeById.get(loser)
    if (prev === undefined || prev.settled!.at <= e.settled!.at) causeById.set(loser, e)
  }
  // 别的作用域里同 id 副本还在用时，删掉的这份不在 byId 里，从 shadowedDeleted 补上（带它自己的文件路径）
  const deletedCopies = [
    ...[...input.data.byId.values()].filter(r => r.status === 'deleted').map(r => ({ r, filePath: input.data.filePaths.get(r.id) ?? '' })),
    ...input.data.shadowedDeleted.map(l => ({ r: l.record, filePath: l.filePath })),
  ]
  const items = deletedCopies
    .filter(({ r }) => input.readScopes.some(s => isInScope(r, s)))
    .map(({ r, filePath }) => ({ r, filePath, deletedAt: r.deletedAt ?? r.updatedAt }))
    .filter(({ deletedAt }) => deletedAt >= cutoff)
    .sort((a, b) => b.deletedAt - a.deletedAt || (a.r.id < b.r.id ? -1 : 1))
    .map(({ r, filePath, deletedAt }) => {
      const e = causeById.get(r.id)
      const verdict = e?.settled?.verdict
      const cause = e === undefined || (verdict !== 'keep-left' && verdict !== 'keep-right') ? undefined : {
        decisionId: e.id, verdict,
        ...(e.baselineRef !== undefined ? { baselineRef: e.baselineRef } : { counterpartId: e.memoryIds.find(id => id !== r.id) }),
        ...(e.settled!.snapshotId !== undefined ? { snapshotId: e.settled!.snapshotId } : {}),
      }
      return { memory: card(r, input.data, filePath), deletedAt, purgeAt: deletedAt + RETENTION_MS, ...(cause !== undefined ? { cause } : {}) }
    })
  // 裁决对方（横向冲突的胜方）也给显示名：界面会提到它
  const counterparts = items.map(i => i.cause !== undefined && 'counterpartId' in i.cause && i.cause.counterpartId !== undefined
    ? input.data.byId.get(i.cause.counterpartId)?.type : undefined)
  return { version: GUI_VIEW_VERSION, generatedAt: input.now, items, typeLabels: typeLabels(input.registry, [...items.map(i => i.memory.type), ...counterparts]) }
}

/** 会话视图：快照冻结时由调用方给出带入的记忆与三段用量。 */
export function buildSessionView(input: Omit<SessionView, 'version'>): SessionView {
  return { version: GUI_VIEW_VERSION, ...input }
}
