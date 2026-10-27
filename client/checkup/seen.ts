/**
 * 「新」和结果行「看过」的本地记录，存在浏览器本地（localStorage）：桌面版和 web 版各存各的，同一条新条目两边各标一次。
 * 按体检标识存：这次体检新增的条目里显示过的（条目身份 pendingItemKey）、看过这次结果行的范围（范围键 scopeKey）。
 * 只留体检视图里还在的那几次体检（各范围最近一次结果和「全部」那条），每次写入时清掉别的。
 * 读写都包 try/catch：存储不可用时当作什么都没看过、什么都记不下，页面照常显示（「新」和结果行每次进来都在）。
 * 「离开再回来」：进入一个范围（换范围、重开记忆页）时读一份快照（useVisitSeen），停在这个范围期间按快照显示，
 * 处理、记忆查看、最近删除之间来回切换不算新的一次；显示过的随即写进记录，下次进入这个范围再读就不标了。
 */
import { useState } from 'react'
import { z } from 'zod'
import { scopeKey, SCOPE_KEYS, type CheckupResult, type CheckupView } from '../../src/gui/contract.ts'

export const SEEN_STORAGE_KEY = 'dsh-plastic-memory.gui.checkupSeen'

const seenSchema = z.object({
  checkups: z.array(z.object({ id: z.string(), keys: z.array(z.string()), scopes: z.array(z.string()) })),
})
export type Seen = z.infer<typeof seenSchema>

const EMPTY: Seen = { checkups: [] }

export function readSeen(): Seen {
  try {
    const raw = localStorage.getItem(SEEN_STORAGE_KEY)
    if (raw === null) return EMPTY
    const parsed = seenSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : EMPTY
  } catch {
    return EMPTY
  }
}

/** 一条记录：这次体检里显示过的条目，和 / 或看过结果行的范围。 */
export interface SeenMark { checkupId: string; keys?: readonly string[]; scope?: string }

/** 记下 marks；只留 view 里还在的体检。内容没变不写。 */
export function markSeen(view: CheckupView, marks: readonly SeenMark[]): void {
  if (marks.length === 0) return
  const live = new Set(checkupResults(view).map(r => r.result.checkupId))
  const before = readSeen()
  const byId = new Map(before.checkups.filter(c => live.has(c.id)).map(c => [c.id, { ...c }]))
  for (const mark of marks) {
    if (!live.has(mark.checkupId)) continue
    const entry = byId.get(mark.checkupId) ?? { id: mark.checkupId, keys: [], scopes: [] }
    entry.keys = [...new Set([...entry.keys, ...mark.keys ?? []])]
    if (mark.scope !== undefined && !entry.scopes.includes(mark.scope)) entry.scopes = [...entry.scopes, mark.scope]
    byId.set(mark.checkupId, entry)
  }
  const next: Seen = { checkups: [...byId.values()] }
  const text = JSON.stringify(next)
  if (text === JSON.stringify(before)) return
  try { localStorage.setItem(SEEN_STORAGE_KEY, text) } catch { /* 记不下：下次进来照旧标 */ }
}

/** hook：这次停留进入时读的记录；visitKey（范围键）变了就重读。 */
export function useVisitSeen(visitKey: string): Seen {
  const [visit, setVisit] = useState(() => ({ key: visitKey, seen: readSeen() }))
  if (visit.key === visitKey) return visit.seen
  const next = { key: visitKey, seen: readSeen() }
  setVisit(next)
  return next.seen
}

export function isResultSeen(seen: Seen, checkupId: string, scope: string): boolean {
  return seen.checkups.some(c => c.id === checkupId && c.scopes.includes(scope))
}

/** 体检视图里的全部结果：「全部」那条（范围键 all）和各范围最近一次的。 */
export function checkupResults(view: CheckupView | undefined): Array<{ scope: string; result: CheckupResult }> {
  if (view === undefined) return []
  const out: Array<{ scope: string; result: CheckupResult }> = []
  if (view.allResult !== null) out.push({ scope: SCOPE_KEYS.all, result: view.allResult })
  for (const s of view.scopes) {
    if (s.lastResult !== null) out.push({ scope: scopeKey(s.scope), result: s.lastResult })
  }
  return out
}

/** 条目身份 → 把它算作新增的那几次体检（项目体检顺带发现的全局新增也算）。 */
export function newItemIndex(view: CheckupView | undefined): Map<string, string[]> {
  const index = new Map<string, string[]>()
  for (const { result } of checkupResults(view)) {
    for (const key of [...result.added.keys, ...result.globalAdded?.keys ?? []]) {
      const ids = index.get(key) ?? []
      if (!ids.includes(result.checkupId)) index.set(key, [...ids, result.checkupId])
    }
  }
  return index
}

/** 这一趟里条目算不算「新」：有哪次体检把它算作新增、而进入时的记录里它在那次体检下还没显示过。 */
export function isNewItem(index: ReadonlyMap<string, readonly string[]>, seen: Seen, key: string): boolean {
  return (index.get(key) ?? []).some(id => !seen.checkups.some(c => c.id === id && c.keys.includes(key)))
}
