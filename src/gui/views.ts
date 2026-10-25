import { relative, sep } from 'node:path'
import type { MemoryRecord } from '../record-schema.ts'
import type { TypeRegistry } from '../type-registry.ts'
import type { DirectoryNote } from '../storage/table.ts'
import { RETENTION_MS } from '../retention.ts'
import { maskSecretSurface } from '../secrets.ts'
import { FINDING_TYPES, type PendingDecision } from '../governance/schema.ts'
import { kindOf, overflowLevelOf, overflowScopeOf, verdictLoser } from '../governance/decisions.ts'
import { runRuleScan } from '../governance/rule-scan.ts'
import { byConfidenceThenConfirmed } from '../snapshot.ts'
import { layerCacheKey, scoreLayer, type LayerPreread, type LayerRef } from '../governance/layer-health.ts'
import {
  GUI_VIEW_VERSION, PENDING_ITEM_KINDS,
  type DeletedView, type GlobalViewName, type GuiLayerRef, type HealthView, type LibraryView, type MemoryCard,
  type PendingItem, type PendingView, type SessionView,
} from './contract.ts'

/**
 * 视图生成（纯函数）：预读数据 + 账本 → 界面要读的视图 JSON（契约见 contract.ts）。不读存储、不写盘。
 * 预读由 view-writer.ts 的 collectGlobalViews 做（复用 memory_health / memory_scan 的 prereadLayers）。
 */
export interface ViewInput {
  now: number
  memoryRoot: string
  registry: TypeRegistry
  /** prereadLayers 读 readLayers 的结果。 */
  data: LayerPreread
  /** 读了哪些层：global + 全部 workspace 目录（含只剩归档的，最近删除要用）。 */
  readLayers: readonly LayerRef[]
  /** 健康视图列哪些层：global + 体检清单。 */
  healthLayers: readonly LayerRef[]
  /** 账本里的未决条目（全部种类）与已裁决条目。 */
  open: readonly PendingDecision[]
  settled: readonly PendingDecision[]
  /** 目录枚举的说明（缺标记、不可读目录）。 */
  listingNotes: readonly DirectoryNote[]
  /** 体检开关的当前值。 */
  governanceEnabled: boolean
  /** 插件本次加载的时刻；缺省不写进视图。 */
  bootedAt?: number
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

function toGuiLayer(layer: LayerRef): GuiLayerRef {
  return layer.kind === 'global' ? { kind: 'global' } : { kind: 'workspace', workspacePath: layer.path }
}

function inLayer(r: MemoryRecord, layer: LayerRef): boolean {
  return layer.kind === 'global' ? r.scope === 'global' : r.scope === 'workspace' && r.workspacePath === layer.path
}

const byNameThenId = (a: MemoryRecord, b: MemoryRecord) =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0

/** 记忆卡：四个文字面遮盖密钥片段，路径原样。 */
function card(r: MemoryRecord, data: LayerPreread, filePath = data.filePaths.get(r.id) ?? ''): MemoryCard {
  const m = maskSecretSurface(r)
  return {
    id: r.id, name: m.name, type: r.type, scope: r.scope,
    ...(r.workspacePath !== undefined ? { workspacePath: r.workspacePath } : {}),
    summary: m.summary, content: m.content, tags: m.tags,
    ...(r.source !== undefined ? { sourceMode: r.source.sourceMode, sourceSessionId: r.source.sessionId } : {}),
    createdAt: r.createdAt, updatedAt: r.updatedAt, lastConfirmedAt: r.lastConfirmedAt,
    ...(r.validTo !== undefined ? { validTo: r.validTo } : {}),
    ...(r.handEdited ? { handEdited: true } : {}),
    filePath,
  }
}

function cardOf(id: string | undefined, data: LayerPreread): MemoryCard | null {
  const r = id === undefined ? undefined : data.byId.get(id)
  return r === undefined ? null : card(r, data)
}

function activeRecords(data: LayerPreread): MemoryRecord[] {
  return [...data.byId.values()].filter(r => r.status === 'active').sort(byNameThenId)
}

/** 待处理：密钥（规则扫描实时判，与健康分同口径）、账本未决条目（体检开时）、读不出的文件。 */
export function buildPendingView(input: ViewInput): PendingView {
  const { data } = input
  const items: PendingItem[] = []
  const active = activeRecords(data)
  for (const f of runRuleScan(active, id => data.byId.get(id), input.now)) {
    if (f.type === 'secret') items.push({ kind: 'secret', memory: card(data.byId.get(f.memoryIds[0])!, data) })
  }
  // 体检关闭（spec 35）：只剩不靠模型的条目——规则检查出的密钥、读不出的文件、超限提醒；冲突与提升候选照留在账本里，打开后回来
  const ledger = input.governanceEnabled ? input.open : input.open.filter(e => kindOf(e) === 'overflow')
  for (const e of [...ledger].sort((a, b) => a.firstSeenAt - b.firstSeenAt)) {
    const base = { decisionId: e.id, firstSeenAt: e.firstSeenAt }
    const kind = kindOf(e)
    if (kind === 'promote-candidate') {
      // 记忆已不是本项目候选（模型直接 memory_promote、标记被清、记忆没了）：旧条目不显示，下次体检清掉
      const r = data.byId.get(e.memoryIds[0] ?? '')
      if (r?.status === 'active' && r.scope === 'workspace' && r.globalCandidate) items.push({ kind, ...base, memory: card(r, data) })
    }
    else if (kind === 'overflow') {
      const scope = overflowScopeOf(e)
      items.push({ kind, ...base, ...overflowLevelOf(e), ...(scope !== undefined && scope !== 'global' ? { workspacePath: scope } : {}) })
    }
    else if (e.baselineRef !== undefined) {
      items.push({ kind: 'conflict-vertical', ...base, summary: e.summary, memory: cardOf(e.memoryIds[0], data), baselineRef: e.baselineRef })
    } else {
      const preferred = e.memoryIds.slice(0, 2).map(id => data.byId.get(id)).filter(r => r !== undefined).sort(byConfidenceThenConfirmed)[0]
      items.push({
        kind: 'conflict-horizontal', ...base, summary: e.summary, left: cardOf(e.memoryIds[0], data), right: cardOf(e.memoryIds[1], data),
        ...(preferred !== undefined ? { preferredId: preferred.id } : {}),
      })
    }
  }
  for (const layer of input.readLayers) {
    for (const q of data.quarantined.get(layerCacheKey(layer)) ?? []) {
      items.push({
        kind: 'unreadable-file', layer: toGuiLayer(layer), filePath: q.path,
        relativePath: relative(input.memoryRoot, q.path).split(sep).join('/'), error: q.error,
      })
    }
  }
  // 稳定排序：同类保持上面的先后（账本按 firstSeenAt）
  const rank = (i: PendingItem) => PENDING_ITEM_KINDS.indexOf(i.kind)
  items.sort((a, b) => rank(a) - rank(b))
  const dot = items.some(i => i.kind === 'secret') ? 'red'
    : items.some(i => i.kind !== 'unreadable-file') ? 'amber' : 'none'
  const cards = items.flatMap(i => i.kind === 'conflict-horizontal' ? [i.left, i.right] : 'memory' in i ? [i.memory] : [])
  return { version: GUI_VIEW_VERSION, dot, items, typeLabels: typeLabels(input.registry, cards.map(m => m?.type)) }
}

/** 注册表里的类型加上视图里出现的类型（切模板后旧模板的、认不出的），读时 get 给显示名。 */
function typeLabels(registry: TypeRegistry, present: Iterable<string | undefined>): Record<string, string> {
  const types = new Set(registry.all().map(t => t.name))
  for (const type of present) if (type !== undefined) types.add(type)
  return Object.fromEntries([...types].map(name => [name, registry.get(name).label]))
}

/** 健康：每层复用 scoreLayer（与 memory_health / memory_scan 同分）；有密钥的层不打分。超限另列（不扣分）。 */
export function buildHealthView(input: ViewInput): HealthView {
  const overflow = [...input.open, ...input.settled].filter(e => kindOf(e) === 'overflow')
  return {
    version: GUI_VIEW_VERSION,
    governanceEnabled: input.governanceEnabled,
    ...(input.bootedAt !== undefined ? { bootedAt: input.bootedAt } : {}),
    layers: input.healthLayers.map(layer => {
      const r = scoreLayer({ registry: input.registry }, input.data, layer, input.now)
      return {
        layer: toGuiLayer(layer),
        totalMemories: r.records.length,
        score: r.health.gate.secret ? null : Math.round(r.health.score * 100) / 100,
        tier: r.health.tier,
        gate: r.health.gate,
        issues: FINDING_TYPES.filter(t => r.health.counts[t] > 0).map(type => ({ type, count: r.health.counts[type] })),
        staleCount: r.health.freshness.staleCount,
        semanticCachedAt: r.semanticCachedAt,
        overflow: overflowOfLayer(overflow, layer),
      }
    }),
  }
}

/** 超限按会话所属项目记账（无项目的会话记在 global），与健康分层同口径。 */
function overflowOfLayer(entries: readonly PendingDecision[], layer: LayerRef): HealthView['layers'][number]['overflow'] {
  const e = entries.find(o => overflowScopeOf(o) === (layer.kind === 'global' ? 'global' : layer.path))
  return e === undefined ? null : overflowLevelOf(e)
}

/** 全部记忆：按层列 active 记忆；空的项目层不列，global 总在。目录问题不含 dir-empty（那不是问题）。 */
export function buildLibraryView(input: ViewInput): LibraryView {
  const active = activeRecords(input.data)
  const layers = input.readLayers
    .map(layer => ({ layer: toGuiLayer(layer), items: active.filter(r => inLayer(r, layer)).map(r => card(r, input.data)) }))
    .filter(l => l.layer.kind === 'global' || l.items.length > 0)
  const directoryIssues = [...input.listingNotes, ...input.data.directoryNotes]
    .filter(n => n.code !== 'dir-empty')
    .map(n => ({ code: n.code, path: n.path, ...(n.keys !== undefined ? { keys: n.keys } : {}) }))
  const typeLabelsOfView = typeLabels(input.registry, layers.flatMap(l => l.items.map(m => m.type)))
  return { version: GUI_VIEW_VERSION, memoryRoot: input.memoryRoot, layers, directoryIssues, typeLabels: typeLabelsOfView }
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
  // 别层同 id 副本还在用时，删掉的这份不在 byId 里，从 shadowedDeleted 补上（带它自己的文件路径）
  const deletedCopies = [
    ...[...input.data.byId.values()].filter(r => r.status === 'deleted').map(r => ({ r, filePath: input.data.filePaths.get(r.id) ?? '' })),
    ...input.data.shadowedDeleted.map(l => ({ r: l.record, filePath: l.filePath })),
  ]
  const items = deletedCopies
    .filter(({ r }) => input.readLayers.some(l => inLayer(r, l)))
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
  return { version: GUI_VIEW_VERSION, items, typeLabels: typeLabels(input.registry, [...items.map(i => i.memory.type), ...counterparts]) }
}

/** 会话视图：快照冻结时由调用方给出带入的记忆与三段用量。 */
export function buildSessionView(input: Omit<SessionView, 'version'>): SessionView {
  return { version: GUI_VIEW_VERSION, ...input }
}
