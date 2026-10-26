import type { TypeRegistry } from '../type-registry.ts'
import type { MemoryRecord } from '../record-schema.ts'
import { dedupKey } from './decisions.ts'
import type { Finding, PendingDecision, ScanCacheEntry } from './schema.ts'
import { FINDING_TYPES } from './schema.ts'
import { runRuleScan, buildMalformedFindings } from './rule-scan.ts'
import { computeHealth, type HealthScore } from './scoring.ts'
import type { DirectoryNote, LocatedRecord, QuarantineEntry } from '../storage/table.ts'

/** 健康档位的用户面标签（scan 体检行与 health message 共用一份，枚举值仍是 green/amber/red）。 */
export const TIER_LABEL = { green: '绿色', amber: '黄色', red: '红色' } as const

const DAY = 86_400_000

/** 评分层引用：workspace 层按项目目录桶，global 层单列。 */
export type LayerRef = { kind: 'workspace'; path: string } | { kind: 'global' }

/** global 层的语义缓存桶。workspace 桶沿用 cache_<路径>（路径是绝对路径，不会与字面量撞名）。 */
export const GLOBAL_CACHE_KEY = 'cache_global'

export function layerCacheKey(layer: LayerRef): string {
  return layer.kind === 'global' ? GLOBAL_CACHE_KEY : `cache_${layer.path}`
}

/** 库里实际存在活跃记忆的 workspace 清单，按路径排序。体检的枚举来源。records 可含非 active，这里只数 active。 */
export function listWorkspaces(records: Iterable<MemoryRecord>): string[] {
  const paths = new Set<string>()
  for (const r of records) {
    if (r.status === 'active' && r.scope === 'workspace' && r.workspacePath !== undefined) paths.add(r.workspacePath)
  }
  return [...paths].sort()
}

/**
 * 校验 scope/scopes 里的 workspace 标识：只接受已知 workspace 的绝对路径（或当前会话的
 * workspace）。合法返回 null，否则返回给模型看的报错文本。模型容易把记忆存储目录名
 * （如 proj-alpha-8641b727）当 scope 传——不校验就会静默扫成空集还给满分。
 * knownWorkspaces：体检清单（顶层有记忆文件的 workspace 目录）。
 */
export function validateScopePaths(
  knownWorkspaces: Iterable<string>,
  currentWs: string | undefined,
  requested: string[],
): string | null {
  const known = new Set(knownWorkspaces)
  if (currentWs !== undefined) known.add(currentWs)
  const invalid = requested.filter(s => !known.has(s))
  if (invalid.length === 0) return null
  const knownList = [...known].sort().map(p => `- ${p}`).join('\n')
  return `无法识别的 workspace：${invalid.join('、')}。`
    + `scope/scopes 只接受 workspace 绝对路径（记忆目录名不是合法值；当前项目缺省不用传）。\n`
    + (known.size > 0 ? `已知 workspace：\n${knownList}` : '当前记忆库还没有任何 workspace 层记忆。')
}

export interface LayerHealthDeps {
  registry: TypeRegistry
}

/**
 * health / scan 执行器预读好的评分输入（tools/layer-preread.ts 产出）。评分只吃它，不碰 store、
 * 账本表、缓存表——两个工具用同一份预读函数，对同一层永远同分。
 */
export interface LayerPreread {
  /** 预读各层的全部状态（active / superseded / deleted，含 .archive/）记录，加上按 id 定位到的层外引用，按 id 索引：
   *  orphan 检测要分辨取代链引用，缓存过滤要核对跨层记录是否存活。 */
  byId: ReadonlyMap<string, MemoryRecord>
  /** byId 里各记录实际读到的文件（绝对路径），评分不用，GUI 视图的「打开文件」用。 */
  filePaths: ReadonlyMap<string, string>
  /** 待决账本（按 firstSeenAt 升序）。 */
  pending: readonly PendingDecision[]
  /** 语义扫描缓存，键为缓存桶。 */
  cache: ReadonlyMap<string, ScanCacheEntry>
  /** 解析失败的记忆文件，按读到它的层归档（键为 layerCacheKey）。 */
  quarantined: ReadonlyMap<string, readonly QuarantineEntry[]>
  /** 本次读取的目录级说明（保留键、不可读目录、同 id 副本）。 */
  directoryNotes: readonly DirectoryNote[]
  /** 别层同 id 的 active 副本在用、因而没进 byId 的已删副本（每个 id 一份）；评分不用，GUI 的最近删除要列它。 */
  shadowedDeleted: readonly LocatedRecord[]
}

export interface LayerHealthResult {
  layer: LayerRef
  records: MemoryRecord[]
  health: HealthScore
  semanticCachedAt: number | null
  /** 归入本层计分的 findings（规则层实时 + 语义层缓存过滤后），供报告展示。 */
  ruleFindings: Finding[]
  semanticFindings: Finding[]
  /** 超过衰减期未确认的记忆 id（条数即 health.freshness.staleCount），GUI 待处理的「很久没确认」用。 */
  staleIds: string[]
  /** 本层的全局提升候选数（global 层恒 0）。 */
  promoteCandidates: number
}

/**
 * 分层健康评分的公共装配：health（单层/体检表）与 scan（体检行）共用，
 * 保证两个工具对同一层永远算出同一个分数。
 *
 * 归属规则：
 * - 语义 findings（噪音与 conflict 同一谓词）计"全员存活且任一方属于本层"的条目：
 *   纯 global 的发现不算进 ws 层分数（否则同一条 global 问题会在 N 个 workspace 重复扣分）；
 *   跨层条目（如提升到 global 后 ws 残留旧条构成的冗余、global vs ws 冲突）归 ws 层——
 *   它污染的是该 ws 的会话，而 global 桶的输入是 global-only、看不到 ws 侧，
 *   若 ws 层也不计就两层都失明；
 * - conflict 还须仍在待决账本里（dedupKey 匹配）——用户裁决 keep-both/dismiss 后双方记忆都在、
 *   缓存过滤不掉，不对账会出现"刚裁决完分数纹丝不动"的自相矛盾；
 * - 其余语义 findings 涉及的记忆在那次体检之后改过（updatedAt 晚于缓存时间）就不计。
 */
export function scoreLayer(deps: LayerHealthDeps, data: LayerPreread, layer: LayerRef, now: number): LayerHealthResult {
  const records = [...data.byId.values()].filter(r => r.status === 'active' && (layer.kind === 'global'
    ? r.scope === 'global'
    : r.scope === 'workspace' && r.workspacePath === layer.path))
  const liveIds = new Set(records.map(r => r.id))

  const ruleFindings = runRuleScan(records, id => data.byId.get(id), now)
  ruleFindings.push(...buildMalformedFindings(data.quarantined.get(layerCacheKey(layer)) ?? []))

  const cached = data.cache.get(layerCacheKey(layer))
  const pendingKeys = new Set(data.pending.map(e => dedupKey(e.memoryIds, e.baselineRef)))
  const alive = (id: string) => data.byId.get(id)?.status === 'active'
  // 体检之后改过的记忆，缓存里关于它的结论（重复、放错层、表述不清）已不作数，下次体检再说；冲突走账本指纹，不在此列
  const editedSinceScan = (id: string) => cached !== undefined && (data.byId.get(id)?.updatedAt ?? 0) > cached.scannedAt
  const semanticFindings = (cached?.findings ?? []).filter(f => {
    if (f.memoryIds.length === 0) return false
    if (!f.memoryIds.every(alive) || !f.memoryIds.some(id => liveIds.has(id))) return false
    if (f.type === 'conflict') return pendingKeys.has(dedupKey(f.memoryIds, f.baselineRef))
    return !f.memoryIds.some(editedSinceScan)
  })

  const freshness = records.flatMap(r => {
    const decayDays = deps.registry.get(r.type).decayDays
    return decayDays === null ? [] : [{ id: r.id, ratio: (now - r.lastConfirmedAt) / (decayDays * DAY) }]
  })
  const freshnessRatios = freshness.map(f => f.ratio)

  const health = computeHealth({
    totalMemories: records.length, ruleFindings, semanticFindings, freshnessRatios,
    layer: layer.kind,
  })
  return {
    layer, records, health,
    semanticCachedAt: cached?.scannedAt ?? null,
    ruleFindings, semanticFindings,
    // 与 computeHealth 的 staleCount 同一判据（ratio > 1）
    staleIds: freshness.filter(f => f.ratio > 1).map(f => f.id),
    promoteCandidates: layer.kind === 'workspace' ? records.filter(r => r.globalCandidate).length : 0,
  }
}

/**
 * 跨层冲突聚合：待决账本里 global 记忆 + workspace 记忆配对的条目，按 global id 分组，
 * 命中 ≥2 个不同 workspace 的说明该全局规则被多数项目反对，优先裁定。
 * memory_scan 体检与 memory_health 体检共用，两个工具对同一账本永远给出同一结果。
 */
export function crossLayerConflicts(
  byId: ReadonlyMap<string, MemoryRecord>,
  pending: readonly PendingDecision[],
): Array<{ globalId: string; workspaces: string[]; decisionIds: string[] }> {
  const byGlobalId = new Map<string, { workspaces: Set<string>; decisionIds: string[] }>()
  for (const e of pending) {
    const members = e.memoryIds.map(id => byId.get(id)).filter((r): r is MemoryRecord => r !== undefined)
    const globalSide = members.find(r => r.scope === 'global')
    const wsSide = members.find(r => r.scope === 'workspace' && r.workspacePath !== undefined)
    if (!globalSide || !wsSide) continue
    const entry = byGlobalId.get(globalSide.id) ?? { workspaces: new Set<string>(), decisionIds: [] }
    entry.workspaces.add(wsSide.workspacePath!)
    entry.decisionIds.push(e.id)
    byGlobalId.set(globalSide.id, entry)
  }
  return [...byGlobalId.entries()]
    .filter(([, v]) => v.workspaces.size >= 2)
    .map(([globalId, v]) => ({ globalId, workspaces: [...v.workspaces].sort(), decisionIds: v.decisionIds }))
}

/** 体检表"主要问题"列：非零的问题类计数按 FINDING_TYPES 顺序，超期计数殿后，空层显示破折号。 */
export function issueSummary(result: LayerHealthResult): string {
  const parts = FINDING_TYPES
    .map(t => [t, result.health.counts[t]] as const)
    .filter(([, n]) => n > 0)
    .map(([t, n]) => `${t} ${n}`)
  if (result.health.freshness.staleCount > 0) parts.push(`超期 ${result.health.freshness.staleCount}`)
  return parts.length > 0 ? parts.join('、') : '—'
}

/** 体检行里 scan 与 health 共有的字段。scan 另加 issues；health 另加 semanticCachedAt、promoteCandidates。 */
export function checkupRowBase(result: LayerHealthResult): {
  layer: 'workspace' | 'global'
  workspacePath?: string
  totalMemories: number
  score: number
  tier: 'green' | 'amber' | 'red'
  gate: { secret: boolean }
  issueSummary: string
} {
  return {
    layer: result.layer.kind,
    ...(result.layer.kind === 'workspace' ? { workspacePath: result.layer.path } : {}),
    totalMemories: result.records.length,
    score: Math.round(result.health.score * 100) / 100,
    tier: result.health.tier,
    gate: result.health.gate,
    issueSummary: issueSummary(result),
  }
}
