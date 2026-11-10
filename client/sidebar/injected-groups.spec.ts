import { describe, expect, it } from 'vitest'
import { groupInjected, type Conflict, type Ruled, type VerticalConflict } from './injected-groups.ts'
import { memory } from '../test-utils.tsx'

const pref = memory({ id: 'p1', type: 'preference' })
const pref2 = memory({ id: 'p2', type: 'preference' })
const fact = memory({ id: 'f1', type: 'fact' })
const byId = new Map([pref, pref2, fact].map(m => [m.id, m]))
const base = { injectedIds: [] as string[], coreIds: [], titleOnlyIds: [], byId, ruled: [], conflicts: [], verticals: [] }

const conflict = (left: typeof pref | null, right: typeof pref | null, decisionId = 'pd_1'): Conflict =>
  ({ kind: 'conflict-horizontal', level: 'your-call', decisionId, firstSeenAt: 1, summary: '', left, right })
const vertical = (m: typeof pref, decisionId = 'pv_1'): VerticalConflict =>
  ({ kind: 'conflict-vertical', level: 'your-call', decisionId, firstSeenAt: 1, summary: '', memory: m, baselineRef: 'AGENTS.md' })

describe('groupInjected', () => {
  it('按类型分组，组按首次出现排，计数含组内每条；视图里找不到的 id 跳过', () => {
    const { groups, inline } = groupInjected({ ...base, injectedIds: ['f1', 'p1', 'gone', 'p2'] })
    expect(groups.map(g => [g.type, g.count, g.entries.map(e => e.kind === 'memory' ? e.memory.id : e.kind)])).toEqual([
      ['fact', 1, ['f1']],
      ['preference', 2, ['p1', 'p2']],
    ])
    expect(inline.size).toBe(0)
  })

  it('组的带入方式：全是 core 标全文、全是只带标题标只带标题、都不是标只带摘要、混着的不标', () => {
    const depthOf = (coreIds: string[], titleOnlyIds: string[]) =>
      groupInjected({ ...base, injectedIds: ['p1', 'p2'], coreIds, titleOnlyIds }).groups[0]?.depth
    expect(depthOf(['p1', 'p2'], [])).toBe('full')
    expect(depthOf([], ['p1', 'p2'])).toBe('titleOnly')
    expect(depthOf([], [])).toBe('summary')
    expect(depthOf(['p1'], [])).toBeUndefined()
    expect(depthOf(['p1'], ['p2'])).toBeUndefined()
  })

  it('待决横向冲突占先出现那方的位置，另一方不再单独列但照样计数；decisionId 进 inline', () => {
    const { groups, inline } = groupInjected({ ...base, injectedIds: ['p1', 'p2'], conflicts: [conflict(pref, pref2)] })
    expect(groups).toHaveLength(1)
    expect(groups[0]?.count).toBe(2)
    expect(groups[0]?.entries).toEqual([{ kind: 'conflict', item: conflict(pref, pref2) }])
    expect([...inline]).toEqual(['pd_1'])
  })

  it('冲突另一方是别的类型：那一类照样计数，但没有条目就不成组', () => {
    const { groups } = groupInjected({ ...base, injectedIds: ['p1', 'f1'], conflicts: [conflict(pref, fact)] })
    expect(groups.map(g => [g.type, g.count, g.entries.length])).toEqual([['preference', 1, 1]])
  })

  it('待决基线冲突占那条记忆的位置；同一条也在横向冲突里时挂横向冲突', () => {
    expect(groupInjected({ ...base, injectedIds: ['p1'], verticals: [vertical(pref)] })).toEqual({
      groups: [{ type: 'preference', count: 1, depth: 'summary', entries: [{ kind: 'vertical', item: vertical(pref) }] }],
      inline: new Set(['pv_1']),
    })
    const both = groupInjected({ ...base, injectedIds: ['p1'], conflicts: [conflict(pref, pref2)], verticals: [vertical(pref)] })
    expect(both.groups[0]?.entries.map(e => e.kind)).toEqual(['conflict'])
    expect([...both.inline]).toEqual(['pd_1'])
  })

  it('刚裁决的冲突：画成裁决结果，记忆删掉后按留下的快照画；同一 decisionId 的待决项不再挂、不进 inline', () => {
    const ruled: Ruled = { kind: 'horizontal', decisionId: 'pd_1', verdict: 'keep-left', left: pref, right: pref2 }
    const { groups, inline } = groupInjected({
      ...base, injectedIds: ['p1', 'p2'], byId: new Map([[pref.id, pref]]), ruled: [ruled], conflicts: [conflict(pref, pref2)],
    })
    expect(groups).toEqual([{ type: 'preference', count: 2, depth: 'summary', entries: [{ kind: 'ruled', ruled }] }])
    expect(inline.size).toBe(0)
  })

  it('裁决过的 decisionId 不再挂出，即使这条记忆还在别的待决冲突里也按那条挂', () => {
    const ruled: Ruled = { kind: 'vertical', decisionId: 'pv_1', verdict: 'keep-right', memory: fact }
    const { groups, inline } = groupInjected({
      ...base, injectedIds: ['p1'], ruled: [ruled], conflicts: [conflict(pref, null, 'pd_2')], verticals: [vertical(pref, 'pv_1')],
    })
    expect(groups[0]?.entries).toEqual([{ kind: 'conflict', item: conflict(pref, null, 'pd_2') }])
    expect([...inline]).toEqual(['pd_2'])
  })
})
