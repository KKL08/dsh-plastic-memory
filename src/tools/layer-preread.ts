import type { MemoryStore } from '../store.ts'
import type { PendingDecisionsStore } from '../governance/decisions.ts'
import type { KvTable } from '../kv-table.ts'
import type { ScanCacheEntry } from '../governance/schema.ts'
import { layerCacheKey, type LayerPreread, type LayerRef } from '../governance/layer-health.ts'
import type { MemoryRecord } from '../record-schema.ts'
import { resolveDuplicates, type DirectoryNote, type LocatedRecord, type QuarantineEntry, type WorkspaceDirListing } from '../storage/table.ts'

/**
 * memory_health 与 memory_scan 共用的预读：两个工具从同一个函数取评分输入，对同一层永远同分。
 * 预读范围：只读给定的层（每层的目录连同 .archive/，记录取全部状态）——规则扫描要分辨取代链引用，
 * 缓存过滤要核对记录是否存活。层外的引用（取代链与语义缓存里指向其他层的 id，如提升到 global 后
 * global 记录的 supersedes 指向 workspace 旧条）按 id 两级定位，不整库预读。
 * 隔离条目按读到它的层归档（malformed 按所在目录归层）；同 id 多文件按取舍规则留一份，其余副本报目录级说明、不删。
 * 另取待决账本全量、语义缓存全部条目。
 */
export async function prereadLayers(
  deps: { store: MemoryStore; decisions: PendingDecisionsStore; cache: KvTable<ScanCacheEntry> },
  layers: readonly LayerRef[],
  /** 当前 workspace：同 id 取舍与跨层定位的提示。 */
  workspacePath?: string,
): Promise<LayerPreread> {
  const read: LocatedRecord[] = []
  const quarantined = new Map<string, QuarantineEntry[]>()
  const directoryNotes: DirectoryNote[] = []
  for (const layer of layers) {
    const scope = layer.kind === 'global' ? layer : { kind: 'workspace' as const, path: layer.path }
    const r = await deps.store.readLayer(scope, { includeArchive: true })
    read.push(...r.records)
    quarantined.set(layerCacheKey(layer), r.quarantined)
    directoryNotes.push(...r.directoryNotes)
  }
  const hint = { workspacePath }
  const chosen = resolveDuplicates(read, hint)
  directoryNotes.push(...duplicateNotes(read, chosen))
  const byId = new Map<string, MemoryRecord>(chosen.map(l => [l.record.id, l.record]))
  const cache = new Map(await deps.cache.list())

  const refs = new Set<string>()
  for (const r of byId.values()) if (r.status === 'active') for (const id of r.supersedes ?? []) refs.add(id)
  for (const layer of layers) for (const f of cache.get(layerCacheKey(layer))?.findings ?? []) for (const id of f.memoryIds) refs.add(id)
  for (const id of refs) {
    if (byId.has(id)) continue
    const hit = await deps.store.locate(id, hint)
    if (hit) byId.set(id, hit.record)
  }

  return { byId, pending: await deps.decisions.list(), cache, quarantined, directoryNotes }
}

/** 同 id 的多余副本：每份一条说明（路径是副本，正文点出读取时用的那份）。 */
function duplicateNotes(read: readonly LocatedRecord[], chosen: readonly LocatedRecord[]): DirectoryNote[] {
  const kept = new Map(chosen.map(l => [l.record.id, l.filePath]))
  return read.filter(l => kept.get(l.record.id) !== l.filePath).map(l => ({
    level: 'info', code: 'duplicate-id', path: l.filePath,
    text: `记忆 ${l.record.id} 有多个文件：读取时用 ${kept.get(l.record.id)}，副本 ${l.filePath} 未自动删除；确认哪份有效后手工删掉多余的`,
  }))
}

/** 目录枚举的说明：缺标记与不可读目录总是列出；dir-empty 只在全库体检里有意义。 */
export function listingNotes(listing: WorkspaceDirListing, opts: { includeEmpty: boolean }): DirectoryNote[] {
  return listing.directoryNotes.filter(n => opts.includeEmpty || n.code !== 'dir-empty')
}

/** 体检清单：顶层有记忆文件的 workspace（按路径排序）。 */
export function checkupWorkspaces(listing: WorkspaceDirListing): string[] {
  return [...new Set(listing.entries.filter(e => e.hasActiveTopLevel).map(e => e.workspacePath))].sort()
}

/** 目录级说明的渲染：health / scan 共用。 */
export function renderDirectoryNotes(notes: readonly DirectoryNote[]): string[] {
  if (notes.length === 0) return []
  return ['目录说明：', ...notes.map(n => `- ${n.text.includes(n.path) ? n.text : `${n.text}：${n.path}`}`)]
}
