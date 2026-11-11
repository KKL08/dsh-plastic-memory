/**
 * 「记忆查看」里本页删掉的记忆留在原位：等删除结果、画结果行（可撤销）、撤销后等视图回来，这几段都按删时的位置画。
 */
import { useEffect, useState } from 'react'
import { scopeOfMemory, type MemoryCard } from '../../src/gui/contract.ts'
import { isInScope, type PageScope } from '../nav.ts'

/**
 * deleting 是删除发出、结果还没回来，照原样画（宿主可能先推来没有它的视图），命令不在进行中时不算；
 * deleted 画结果行；restored 是撤销了、视图还没刷新回来，照原样画。
 */
export type DeletedState = 'deleting' | 'deleted' | 'restored'

/** index 是删时在这个范围列表里的位置。 */
interface DeletedRow { memory: MemoryCard; index: number; state: DeletedState }

/**
 * hook：本页删掉的记忆。items 是视图里这个范围的记忆，插回本页删掉、视图里已经没有的那几条；
 * hasPlaceholders 说有没有要留在原位的（不分范围），空态据此不说「还没有记忆」。
 */
export function useDeletedPlaceholders(viewItems: readonly MemoryCard[], scope: PageScope, isBusy: (id: string) => boolean): {
  items: MemoryCard[]
  hasPlaceholders: boolean
  isDeleted: (id: string) => boolean
  mark: (memory: MemoryCard, state: DeletedState) => void
} {
  const [rows, setRows] = useState<ReadonlyMap<string, DeletedRow>>(new Map())
  const placeholders = [...rows.values()].filter(row => row.state !== 'deleting' || isBusy(row.memory.id))
  // 视图里已经没有的那几条留在原位（等结果、结果行或撤销后等视图回来）；分组的排序是稳定的，插回原位就落回原来的组和位置
  const items = [...viewItems]
  for (const row of placeholders) {
    const at = scopeOfMemory(row.memory)
    if (at === undefined || !isInScope([at], scope) || items.some(m => m.id === row.memory.id)) continue
    items.splice(Math.min(row.index, items.length), 0, row.memory)
  }
  const viewIds = viewItems.map(m => m.id).join('\n')
  // 撤销后视图里又有了：不用再替它占位
  useEffect(() => {
    const ids = new Set(viewIds.split('\n'))
    setRows((prev) => {
      const restored = [...prev.values()].filter(row => row.state === 'restored' && ids.has(row.memory.id))
      if (restored.length === 0) return prev
      const next = new Map(prev)
      for (const row of restored) next.delete(row.memory.id)
      return next
    })
  }, [viewIds])
  const mark = (memory: MemoryCard, state: DeletedState) => {
    setRows((prev) => {
      const index = (state === 'deleting' ? undefined : prev.get(memory.id)?.index) ?? Math.max(0, viewItems.findIndex(m => m.id === memory.id))
      return new Map(prev).set(memory.id, { memory, index, state })
    })
  }
  return {
    items,
    hasPlaceholders: placeholders.length > 0,
    isDeleted: id => rows.get(id)?.state === 'deleted',
    mark,
  }
}
