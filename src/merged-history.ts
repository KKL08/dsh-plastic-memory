import { mergedIntoOf, type MergedInto } from './record-schema.ts'
import { GLOBAL_SCOPE_KEY, scopeOfLedger } from './scope.ts'
import { byVersionEnd, layerOf, versionOfMerged, type HistoryVersion } from './storage/history.ts'
import type { LocatedRecord } from './storage/table.ts'
import type { MemoryStore } from './store.ts'


/**
 * 一条记忆的历史版本，连同并进它的那些记忆的。并进来的在被合并方物理删除之前留在它自己的目录里（软删期间历史不动），
 * 之后搬到这条名下；两个阶段从这里读出来是同一份。并进来的版本带 mergedFrom（原记忆 id）：列表里标「并入自」，时间线不画成这条自己的段。
 * 并成版本的那条本身也算一版。读历史的地方（历史模式、历史界面、时间线）都用它。
 */
export async function historyWithMerged(store: Pick<MemoryStore, 'history' | 'readRaw' | 'get'>, found: Pick<LocatedRecord, 'dir' | 'record'>): Promise<HistoryVersion[]> {
  const own = await store.history.list(layerOf(found), found.record.id)
  const ownKey = found.record.scope === 'global' ? GLOBAL_SCOPE_KEY : found.record.workspacePath ?? ''
  // 还在最近删除里、去向是这条的：全局和各项目都看（项目记忆可以并进全局的）。找法和物理删除时搬历史的一样：
  // 按记下的作用域认；这条在全局、记下的作用域里已经没有这个 id（并进来之后被提升了）也算
  const isHere = async (into: MergedInto) => into.id === found.record.id && (into.scopeKey === ownKey
    || (ownKey === GLOBAL_SCOPE_KEY && (await store.get(into.id, scopeOfLedger(into.scopeKey))) === undefined))
  const pending: LocatedRecord[] = []
  for (const r of (await store.readRaw(undefined, { includeArchive: true })).records) {
    const into = r.record.status === 'deleted' ? mergedIntoOf(r.record) : undefined
    if (into !== undefined && await isHere(into)) pending.push(r)
  }
  const merged: HistoryVersion[] = []
  for (const from of pending) {
    if (mergedIntoOf(from.record)?.as === 'version') merged.push(versionOfMerged(from.record))
    for (const version of await store.history.list(layerOf(from), from.record.id)) merged.push(version.mergedFrom !== undefined ? version : { ...version, mergedFrom: from.record.id, mergedFromScope: from.record.scope === 'global' ? GLOBAL_SCOPE_KEY : from.record.workspacePath ?? '' })
  }
  return [...own, ...merged].sort(byVersionEnd)
}
