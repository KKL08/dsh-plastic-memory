/**
 * 右侧栏「带入的记忆」怎么分组：按类型分组，每组数出带入几条、按哪种方式带入；
 * 记忆有待决冲突（或刚裁决完）时，那张冲突卡占它的位置，另一方不再单独列。
 */
import type { MemoryCard, PendingItem } from '../../src/gui/contract.ts'

export type Conflict = Extract<PendingItem, { kind: 'conflict-horizontal' }>
export type VerticalConflict = Extract<PendingItem, { kind: 'conflict-vertical' }>
export type Verdict = 'keep-left' | 'keep-right' | 'keep-both'

/**
 * 刚裁决的冲突：记忆的快照留着，被删后仍能原位显示。isUnrecorded：两边都留但结论没记下（见命令结果 isUnrecorded），
 * 没有可撤销的条目。isHardDeleted：败方含密钥、已彻底删除，同样没有撤销。
 */
export type Outcome = { isUnrecorded?: true; isHardDeleted?: true }
export type Ruled =
  | { kind: 'horizontal'; decisionId: string; verdict: Verdict; left: MemoryCard; right: MemoryCard } & Outcome
  | { kind: 'vertical'; decisionId: string; verdict: Verdict; memory: MemoryCard } & Outcome

export type Entry =
  | { kind: 'memory'; memory: MemoryCard }
  | { kind: 'conflict'; item: Conflict }
  | { kind: 'vertical'; item: VerticalConflict }
  | { kind: 'ruled'; ruled: Ruled }

/** 一组的带入方式：快照按类型决定全文（core 区）、带摘要的索引行还是只带名称和标签的索引行。混着几种的组不标（undefined）。 */
export type GroupDepth = 'full' | 'summary' | 'titleOnly'

export interface InjectedGroup {
  type: string
  /** 这一类带入了几条（含挂在别组冲突卡里的）。 */
  count: number
  depth: GroupDepth | undefined
  entries: Entry[]
}

const ruledMemories = (r: Ruled): MemoryCard[] => r.kind === 'horizontal' ? [r.left, r.right] : [r.memory]

/**
 * 按快照带入的顺序分组（组按首次出现排）。找不到的 id 跳过；刚裁决的冲突，记忆即使已从视图里删掉也按留下的快照画。
 * inline：就地挂出来的待决冲突（decisionId），底部「其余待处理」不再算它们。
 */
export function groupInjected({ injectedIds, coreIds, titleOnlyIds, byId, ruled, conflicts, verticals }: {
  injectedIds: readonly string[]
  coreIds: readonly string[]
  titleOnlyIds: readonly string[]
  byId: ReadonlyMap<string, MemoryCard>
  ruled: readonly Ruled[]
  conflicts: readonly Conflict[]
  verticals: readonly VerticalConflict[]
}): { groups: InjectedGroup[]; inline: Set<string> } {
  const ruledIds = new Set(ruled.map(r => r.decisionId))
  const core = new Set(coreIds)
  const titleOnly = new Set(titleOnlyIds)
  const tallies = new Map<string, { total: number; full: number; titleOnly: number }>()
  const entries = new Map<string, Entry[]>()
  const inline = new Set<string>()
  const shown = new Set<string>()
  const push = (type: string, entry: Entry) => { entries.set(type, [...entries.get(type) ?? [], entry]) }
  for (const id of injectedIds) {
    const done = ruled.find(r => ruledMemories(r).some(m => m.id === id))
    const memory = byId.get(id) ?? (done === undefined ? undefined : ruledMemories(done).find(m => m.id === id))
    if (memory === undefined) continue
    const tally = tallies.get(memory.type) ?? { total: 0, full: 0, titleOnly: 0 }
    tallies.set(memory.type, {
      total: tally.total + 1,
      full: tally.full + (core.has(id) ? 1 : 0),
      titleOnly: tally.titleOnly + (titleOnly.has(id) ? 1 : 0),
    })
    if (shown.has(id)) continue
    const open = done === undefined
      ? conflicts.find(c => !ruledIds.has(c.decisionId) && (c.left?.id === id || c.right?.id === id))
      : undefined
    const openVertical = done === undefined && open === undefined
      ? verticals.find(c => !ruledIds.has(c.decisionId) && c.memory?.id === id)
      : undefined
    if (done !== undefined) {
      push(memory.type, { kind: 'ruled', ruled: done })
      for (const m of ruledMemories(done)) shown.add(m.id)
    } else if (openVertical !== undefined) {
      push(memory.type, { kind: 'vertical', item: openVertical })
      inline.add(openVertical.decisionId)
      shown.add(id)
    } else if (open !== undefined) {
      push(memory.type, { kind: 'conflict', item: open })
      inline.add(open.decisionId)
      for (const side of [open.left, open.right]) if (side !== null) shown.add(side.id)
    } else {
      push(memory.type, { kind: 'memory', memory })
      shown.add(id)
    }
  }
  const groups = [...entries].map(([type, list]): InjectedGroup => {
    const { total, full, titleOnly: titles } = tallies.get(type) ?? { total: 0, full: 0, titleOnly: 0 }
    const depth = full === total ? 'full' : titles === total ? 'titleOnly' : full === 0 && titles === 0 ? 'summary' : undefined
    return { type, count: total, depth, entries: list }
  })
  return { groups, inline }
}
