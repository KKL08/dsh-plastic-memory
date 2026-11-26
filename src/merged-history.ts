import { mergedIntoOf, type MergedInto } from './record-schema.ts'
import { GLOBAL_SCOPE_KEY, scopeOfLedger } from './scope.ts'
import { byVersionEnd, freeVersionId, layerOf, versionOfMerged, type HistoryVersion, type VersionListing } from './storage/history.ts'
import type { LocatedRecord } from './storage/table.ts'
import type { MemoryStore } from './store.ts'


/**
 * 一条记忆的历史版本，连同并进它的那些记忆的。并进来的在被合并方物理删除之前留在它自己的目录里（软删期间历史不动），
 * 之后搬到这条名下；两个阶段从这里读出来是同一份。并进来的版本带 mergedFrom（原记忆 id）：列表里标「并入自」，时间线不画成这条自己的段。
 * 并成版本的那条本身也算一版。读历史的地方（历史模式、历史界面、时间线）都用它。
 * 版本号和物理删除之后一样：物理删除把并进来的版本搬过来时按实际文件名占名，撞了就加序号（FileVersionHistory.transfer）。
 * 这里按同一规则编号：这条自己的版本先占号，并进来的按清扫的先后（被合并方删除得早的先清；同一时刻删的按作用域键、id）依次占，
 * 每一条先占它自己并成的那一版（carryMergedHistory 先 place 再 absorb），再按版本号的先后占它的历史版本。
 * 不承诺删除前后号一样的情形：几条在同一次清扫里一起到期、实际清扫先后和上面的排法不同而又撞了号；一条被合并方自己的版本号里
 * 已经带序号、和别处撞号（搬的先后跟着目录列出的顺序）；这条自己的历史里有读不出的版本文件（它也占着名字，这里不知道）。
 * isComplete：自己这份和每个并进来的那条的历史都读全、且找待删记录那次读目录没有解析不了的记忆文件或读不了的目录时才为真。
 */
export async function historyWithMerged(store: Pick<MemoryStore, 'history' | 'readRaw' | 'get'>, found: Pick<LocatedRecord, 'dir' | 'record'>): Promise<VersionListing> {
  const own = await store.history.list(layerOf(found), found.record.id)
  const ownKey = found.record.scope === 'global' ? GLOBAL_SCOPE_KEY : found.record.workspacePath ?? ''
  // 还在最近删除里、去向是这条的：全局和各项目都看（项目记忆可以并进全局的）。找法和物理删除时搬历史的一样：
  // 按记下的作用域认；这条在全局、记下的作用域里已经没有这个 id（并进来之后被提升了）也算
  const isHere = async (into: MergedInto) => into.id === found.record.id && (into.scopeKey === ownKey
    || (ownKey === GLOBAL_SCOPE_KEY && (await store.get(into.id, scopeOfLedger(into.scopeKey))) === undefined))
  const pending: LocatedRecord[] = []
  const read = await store.readRaw(undefined, { includeArchive: true })
  let isComplete = own.isComplete && read.quarantined.length === 0 && !read.directoryNotes.some(n => n.code === 'dir-unreadable')
  for (const r of read.records) {
    const into = r.record.status === 'deleted' ? mergedIntoOf(r.record) : undefined
    if (into !== undefined && await isHere(into)) pending.push(r)
  }
  const taken = new Set(own.versions.map(v => v.versionId))
  const claimed = (version: HistoryVersion): HistoryVersion => ({ ...version, versionId: claimVersionId(version.versionId, taken) })
  const merged: HistoryVersion[] = []
  pending.sort((a, b) => (a.record.deletedAt ?? 0) - (b.record.deletedAt ?? 0) || scopeKeyOf(a).localeCompare(scopeKeyOf(b)) || a.record.id.localeCompare(b.record.id))
  for (const from of pending) {
    if (mergedIntoOf(from.record)?.as === 'version') merged.push(claimed(versionOfMerged(from.record)))
    const listing = await store.history.list(layerOf(from), from.record.id)
    isComplete = isComplete && listing.isComplete
    const byId = [...listing.versions].sort((a, b) => (a.versionId < b.versionId ? -1 : a.versionId > b.versionId ? 1 : 0))
    for (const version of byId) merged.push(claimed(version.mergedFrom !== undefined ? version : { ...version, mergedFrom: from.record.id, mergedFromScope: scopeKeyOf(from) }))
  }
  return { versions: [...own.versions, ...merged].sort(byVersionEnd), isComplete }
}

const scopeKeyOf = (found: Pick<LocatedRecord, 'record'>) => (found.record.scope === 'global' ? GLOBAL_SCOPE_KEY : found.record.workspacePath ?? '')

/** 物理删除搬版本时的占名（FileVersionHistory.transfer）：想要的号被占了，按 freeVersionId 往后找，试过的都算占着。 */
function claimVersionId(wanted: string, taken: Set<string>): string {
  const tried: string[] = []
  let candidate = wanted
  while (taken.has(candidate)) {
    tried.push(candidate)
    candidate = freeVersionId(wanted, tried)
  }
  taken.add(candidate)
  return candidate
}

/**
 * 按版本标识读一版：先读这条自己目录里的那一版，没有再到并进来的版本里找（并进来的在被合并方物理删除前还在它自己的目录里），
 * 并进来的按 historyWithMerged 编的号认（撞号的带序号，和物理删除之后搬过来的文件名相同）。
 * found 读到了；unreadable 文件在、读不出或解析不了；missing 没找到，isComplete 为假时历史还有读不出的部分，不能断定它已经不在。
 * versionId 由调用方先按 VERSION_ID_PATTERN 校验过。
 */
export async function readHistoryVersion(
  store: Pick<MemoryStore, 'history' | 'readRaw' | 'get'>, found: Pick<LocatedRecord, 'dir' | 'record'>, versionId: string,
): Promise<{ kind: 'found'; version: HistoryVersion } | { kind: 'unreadable' } | { kind: 'missing'; isComplete: boolean }> {
  const read = await store.history.read(layerOf(found), found.record.id, versionId)
  if (read.kind !== 'missing') return read
  const listing = await historyWithMerged(store, found)
  const merged = listing.versions.find(v => v.versionId === versionId && v.mergedFrom !== undefined)
  return merged !== undefined ? { kind: 'found', version: merged } : { kind: 'missing', isComplete: listing.isComplete }
}
