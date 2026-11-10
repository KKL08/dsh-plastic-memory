/**
 * 右侧栏「带入的记忆」怎么分组：按类型分组，每组列出带入的记忆、标出按哪种方式带入；
 * 带入的记忆涉及的待决冲突（和刚裁决完的）另列一份，画在「等你决定」段里，冲突双方照常留在各自的类型组。
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

/** 「等你决定」里的一张卡：待决的横向、基线冲突，或刚裁决完的结果。 */
export type Decision =
  | { kind: 'conflict'; item: Conflict }
  | { kind: 'vertical'; item: VerticalConflict }
  | { kind: 'ruled'; ruled: Ruled }

/** 一组的带入方式：快照按类型决定全文（core 区）、带摘要的索引行还是只带名称和标签的索引行。混着几种的组不标（undefined）。 */
export type GroupDepth = 'full' | 'summary' | 'titleOnly'

export interface InjectedGroup {
  type: string
  depth: GroupDepth | undefined
  /** 这一类带入的记忆，按带入的顺序。 */
  memories: MemoryCard[]
}

const ruledMemories = (r: Ruled): MemoryCard[] => r.kind === 'horizontal' ? [r.left, r.right] : [r.memory]

/**
 * 按快照带入的顺序分组（组按首次出现排）。找不到的 id 跳过；刚裁决的冲突，记忆即使已从视图里删掉也按留下的快照画。
 * decisions：涉及带入记忆的冲突，按涉及的记忆首次带入的顺序排，同一条记忆先横向后基线；刚裁决的占它原来的位置，同一 decisionId 的待决项不再列。
 * inline：列出来的待决冲突（decisionId），底部「其余待处理」不再算它们。
 */
export function groupInjected({ injectedIds, coreIds, titleOnlyIds, byId, ruled, conflicts, verticals }: {
  injectedIds: readonly string[]
  coreIds: readonly string[]
  titleOnlyIds: readonly string[]
  byId: ReadonlyMap<string, MemoryCard>
  ruled: readonly Ruled[]
  conflicts: readonly Conflict[]
  verticals: readonly VerticalConflict[]
}): { groups: InjectedGroup[]; decisions: Decision[]; inline: Set<string> } {
  const ruledIds = new Set(ruled.map(r => r.decisionId))
  const sides = (...list: Array<MemoryCard | null>) => list.flatMap(m => m === null ? [] : [m.id])
  const candidates: Array<{ decision: Decision; ids: string[] }> = [
    ...ruled.filter(r => r.kind === 'horizontal').map(r => ({ decision: { kind: 'ruled' as const, ruled: r }, ids: sides(...ruledMemories(r)) })),
    ...conflicts.filter(c => !ruledIds.has(c.decisionId)).map(c => ({ decision: { kind: 'conflict' as const, item: c }, ids: sides(c.left, c.right) })),
    ...ruled.filter(r => r.kind === 'vertical').map(r => ({ decision: { kind: 'ruled' as const, ruled: r }, ids: sides(...ruledMemories(r)) })),
    ...verticals.filter(c => !ruledIds.has(c.decisionId)).map(c => ({ decision: { kind: 'vertical' as const, item: c }, ids: sides(c.memory) })),
  ]
  const core = new Set(coreIds)
  const titleOnly = new Set(titleOnlyIds)
  const groups = new Map<string, { memories: MemoryCard[]; full: number; titleOnly: number }>()
  const decisions: Decision[] = []
  const inline = new Set<string>()
  const listed = new Set<(typeof candidates)[number]>()
  for (const id of injectedIds) {
    for (const candidate of candidates) {
      if (listed.has(candidate) || !candidate.ids.includes(id)) continue
      listed.add(candidate)
      decisions.push(candidate.decision)
      if (candidate.decision.kind !== 'ruled') inline.add(candidate.decision.item.decisionId)
    }
    const done = ruled.find(r => ruledMemories(r).some(m => m.id === id))
    const memory = byId.get(id) ?? (done === undefined ? undefined : ruledMemories(done).find(m => m.id === id))
    if (memory === undefined) continue
    const group = groups.get(memory.type) ?? { memories: [], full: 0, titleOnly: 0 }
    groups.set(memory.type, {
      memories: [...group.memories, memory],
      full: group.full + (core.has(id) ? 1 : 0),
      titleOnly: group.titleOnly + (titleOnly.has(id) ? 1 : 0),
    })
  }
  return {
    groups: [...groups].map(([type, { memories, full, titleOnly: titles }]): InjectedGroup => {
      const total = memories.length
      const depth = full === total ? 'full' : titles === total ? 'titleOnly' : full === 0 && titles === 0 ? 'summary' : undefined
      return { type, depth, memories }
    }),
    decisions,
    inline,
  }
}
