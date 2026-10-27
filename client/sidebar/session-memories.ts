/**
 * 这次对话的记忆怎么取、哪些新写入还算数：右侧栏记忆 tab 与输入框记忆弹层共用，两处口径一致。
 */
import { layerOfMemory, type LibraryView, type MemoryCard, type SessionView } from '../../src/gui/contract.ts'
import { samePath, type Deletions } from '../gateway.ts'

/**
 * 只收会话看得见的层（global + 本项目）的记忆卡，按 id 取；同 id 两层都有时取服务端会取的那份：updatedAt 新者，相同时本项目优先。
 * 另数出两层各有几条。
 */
export function sessionCards(library: LibraryView, ws: string | undefined): {
  byId: Map<string, MemoryCard>; globalCount: number; projectCount: number
} {
  const byId = new Map<string, MemoryCard>()
  let globalCount = 0
  let projectCount = 0
  for (const { layer, items } of library.layers) {
    const isOwn = layer.kind === 'workspace' && ws !== undefined && samePath(layer.workspacePath, ws)
    if (layer.kind === 'global') globalCount += items.length
    else if (isOwn) projectCount += items.length
    if (layer.kind !== 'global' && !isOwn) continue
    for (const item of items) {
      const current = byId.get(item.id)
      if (current === undefined || item.updatedAt > current.updatedAt || (item.updatedAt === current.updatedAt && isOwn)) byId.set(item.id, item)
    }
  }
  return { byId, globalCount, projectCount }
}

/** 这次新写入、还没进快照的 id（按写入先后）：压缩后或配置热更新后重建的快照已经带入的，算在带入的记忆里。 */
export function writtenSinceSnapshot(view: SessionView): string[] {
  const injected = new Set(view.injectedIds)
  return view.savedIds.filter(id => !injected.has(id))
}

/**
 * 新写入的这条还在：全部记忆里还有（别处删掉的视图刷新后就没了），本网关也没记下删除（不等视图刷新）。
 * byId 缺省（全部记忆视图还没读到）时只看删除记录。
 */
export function isLiveWrite(id: string, byId: ReadonlyMap<string, MemoryCard> | undefined, deletions: Deletions): boolean {
  if (byId === undefined) return deletions.of(id) === undefined
  const memory = byId.get(id)
  return memory !== undefined && deletions.of(id, layerOfMemory(memory)) === undefined
}
