import { locateLinkTarget, reachableScopes } from '../links.ts'
import { historyWithMerged, readHistoryVersion } from '../merged-history.ts'
import { isPendingDelegated, type MemoryRecord } from '../record-schema.ts'
import { sameScope, scopeAt, scopeOfMemory, type Scope } from '../scope.ts'
import { maskSecrets, maskSecretSurface } from '../secrets.ts'
import { byVersionEnd, versionReason, type HistoryVersion } from '../storage/history.ts'
import { byPosition, isIncompleteNote, outgoingLinks, type LinkRef, type LocatedFile } from '../storage/table.ts'
import type { MemoryStore } from '../store.ts'
import type { HistoryEntry, LinkEdge, LinkNode, MemoryDetail, VersionDetail } from './contract.ts'
import { toMemoryCard } from './views.ts'

/**
 * 记忆详情（memory-detail、read-version）：按精确作用域读一条记忆的历史版本和一层链接，打开时现取。
 * 只读：不进写入段、不写视图和派生数据。展示给界面的文字（变化原因、版本内容、邻居名称）都先遮盖密钥。
 */

type DetailStore = Pick<MemoryStore, 'locate' | 'history' | 'readRaw' | 'get' | 'linksTo' | 'listWorkspaceDirs'>

/** 找不到这一条时：这个作用域读全了是 missing（确实不在），没读全是 unreadable（可能就是读不出的那个文件）。 */
export type CenterMiss = 'missing' | 'unreadable'

const centerMiss = async (store: DetailStore, layer: Scope): Promise<CenterMiss> => ((await isFullyRead(store, [layer])) ? 'missing' : 'unreadable')

/** 这一条的详情；在这个作用域里找不到时说是确实不在还是没读全。 */
export async function readMemoryDetail(store: DetailStore, layer: Scope, memoryId: string): Promise<MemoryDetail | CenterMiss> {
  const found = await store.locate(memoryId, layer)
  if (found === undefined) return centerMiss(store, layer)
  const record = byPosition(found)
  const listing = await historyWithMerged(store, found)
  return {
    memory: toMemoryCard(record, found.filePath),
    status: record.status,
    history: { versions: [...listing.versions].sort((a, b) => byVersionEnd(b, a)).map(entryOf), isComplete: listing.isComplete },
    links: await linksOf(store, record, layer),
  }
}

/** 读这一条的一版历史；这一条在这个作用域里找不到时同 readMemoryDetail。versionId 由调用方先校验过写法。 */
export async function readVersionDetail(store: DetailStore, layer: Scope, memoryId: string, versionId: string): Promise<VersionDetail | CenterMiss> {
  const found = await store.locate(memoryId, layer)
  if (found === undefined) return centerMiss(store, layer)
  const read = await readHistoryVersion(store, found, versionId)
  if (read.kind !== 'found') return read.kind === 'unreadable' ? { status: 'unreadable' } : { status: 'missing', isComplete: read.isComplete }
  const masked = maskSecretSurface(read.version.record)
  return { status: 'found', versionId: read.version.versionId, name: masked.name, summary: masked.summary, content: masked.content, tags: masked.tags }
}

/** 文件里可手改的文字（原因、出处会话、找不到的链接 id）先遮盖再折行（跨行的密钥也认得出），每项一行。 */
const maskedLine = (text: string) => maskSecrets(text).replace(/\s*[\r\n]+\s*/g, ' ').trim()

function entryOf(version: HistoryVersion): HistoryEntry {
  const { record } = version
  return {
    versionId: version.versionId, startedAt: version.startedAt, endedAt: version.endedAt,
    reason: maskedLine(versionReason(version)),
    ...(record.factTime !== undefined ? { factTime: record.factTime } : {}),
    ...(record.source !== undefined ? { sourceSessionId: maskedLine(record.source.sessionId) } : {}),
    ...(version.mergedFrom !== undefined ? { mergedFrom: { id: version.mergedFrom, name: maskSecretSurface(record).name } } : {}),
  }
}

function nodeOf(found: LocatedFile): LinkNode {
  const record = byPosition(found)
  return { id: record.id, ...withScope(scopeOfMemory(record)), state: record.status, name: maskSecretSurface(record).name }
}

const withScope = (scope: Scope | undefined) => (scope === undefined ? {} : { scope })

/**
 * 一层链接：先是中心指出去的（按前提、相关、取代的顺序），再是指向中心的（按反向查询的顺序）。
 * 子 agent 的待确认记录被接受之前，它挂的链接不列：中心是待确认的就不列出去的，来源是待确认的那条不列。
 * 指出去的按 locateLinkTarget 认是哪一份；找不到时，够得着的作用域都读全了才算 missing，否则算 unreadable。
 * 读不到、已不在的节点只是显示用，id 给遮盖后的写法（文件里可手改）。
 * 指向中心的按来源目录认作用域，并且只列从来源的视角实际指向这一份的（pointsHere）。
 */
async function linksOf(store: DetailStore, center: MemoryRecord, layer: Scope): Promise<MemoryDetail['links']> {
  const edges: LinkEdge[] = []
  const seen = new Set<string>()
  const add = (edge: LinkEdge) => {
    const key = `${edge.direction}\u0000${edge.kind}\u0000${edge.node.scope === undefined ? '' : JSON.stringify(edge.node.scope)}\u0000${edge.node.id}`
    if (seen.has(key)) return
    seen.add(key)
    edges.push(edge)
  }
  let reachableRead: Promise<boolean> | undefined
  if (!isPendingDelegated(center)) {
    for (const link of outgoingLinks(center)) {
      const target = await locateLinkTarget(store, layer, link.targetId)
      if (target !== undefined) { add({ kind: link.kind, direction: 'out', node: nodeOf(target) }); continue }
      reachableRead ??= isFullyRead(store, reachableScopes(layer))
      add({ kind: link.kind, direction: 'out', node: { id: maskedLine(link.targetId), state: (await reachableRead) ? 'missing' : 'unreadable' } })
    }
  }
  const incoming = await store.linksTo(center.id, layer)
  const scopeOfDir = await sourceScopes(store, layer)
  for (const ref of incoming.refs) {
    const source = await store.locate(ref.sourceId, scopeOfDir(ref))
    if (source !== undefined && isPendingDelegated(source.record)) continue
    if (source !== undefined && !(await pointsHere(store, source.record, center.id, layer))) continue
    add({ kind: ref.kind, direction: 'in', node: source === undefined ? { id: maskedLine(ref.sourceId), state: 'unreadable' } : nodeOf(source) })
  }
  return { edges, isComplete: incoming.isComplete }
}

/** 来源的链接从它的视角（locateLinkTarget）实际指向的是不是这一份：同 id 在全局和项目各有一份时，指向另一份的不算。 */
async function pointsHere(store: DetailStore, source: MemoryRecord, id: string, layer: Scope): Promise<boolean> {
  const from = scopeOfMemory(source)
  const target = from === undefined ? undefined : await locateLinkTarget(store, from, id)
  const at = target === undefined ? undefined : scopeOfMemory(target.record)
  return at !== undefined && sameScope(at, layer)
}

/**
 * 指向中心的来源在哪个作用域：反向查询看的目录（见 MemoryStore.linksTo）里，项目记忆只看本项目的；全局记忆看全局和各项目的，
 * 来源目录是哪个项目的目录就是哪个项目，其余是全局。
 */
async function sourceScopes(store: DetailStore, layer: Scope): Promise<(ref: LinkRef) => Scope> {
  if (layer.kind === 'workspace') return () => layer
  const projects = new Map((await store.listWorkspaceDirs()).entries.map(e => [e.dir, e.workspacePath]))
  return (ref) => {
    const workspacePath = ref.sourceDir === undefined ? undefined : projects.get(ref.sourceDir)
    return workspacePath === undefined ? layer : scopeAt(workspacePath)
  }
}

/** 这几个作用域（含归档）都读全了：没有读不出的文件、没有读不全的目录（读不了、缺标记）。项目作用域连带读全局目录，全局读不全也算没读全。 */
async function isFullyRead(store: DetailStore, scopes: readonly Scope[]): Promise<boolean> {
  for (const scope of scopes) {
    const read = await store.readRaw(scope, { includeArchive: true })
    if (read.quarantined.length > 0 || read.directoryNotes.some(isIncompleteNote)) return false
  }
  return true
}
