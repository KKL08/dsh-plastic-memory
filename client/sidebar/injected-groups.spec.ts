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

const ids = (groups: ReturnType<typeof groupInjected>['groups']) => groups.map(g => [g.type, g.memories.map(m => m.id)])

describe('groupInjected', () => {
  it('按类型分组，组按首次出现排，组内是带入的每条记忆；视图里找不到的 id 跳过', () => {
    const { groups, decisions, inline } = groupInjected({ ...base, injectedIds: ['f1', 'p1', 'gone', 'p2'] })
    expect(ids(groups)).toEqual([['fact', ['f1']], ['preference', ['p1', 'p2']]])
    expect(decisions).toEqual([])
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

  it('待决横向冲突单独列进待裁决，双方照常留在各自的类型组；decisionId 进 inline', () => {
    const { groups, decisions, inline } = groupInjected({ ...base, injectedIds: ['p1', 'f1', 'p2'], conflicts: [conflict(pref, fact)] })
    expect(ids(groups)).toEqual([['preference', ['p1', 'p2']], ['fact', ['f1']]])
    expect(decisions).toEqual([{ kind: 'conflict', item: conflict(pref, fact) }])
    expect([...inline]).toEqual(['pd_1'])
  })

  it('双方都没带入的冲突不列；同一条冲突双方都带入只列一次', () => {
    const outside = conflict(memory({ id: 'x1', type: 'fact' }), memory({ id: 'x2', type: 'fact' }), 'pd_x')
    const { decisions, inline } = groupInjected({ ...base, injectedIds: ['p1', 'p2'], conflicts: [conflict(pref, pref2), outside] })
    expect(decisions).toEqual([{ kind: 'conflict', item: conflict(pref, pref2) }])
    expect([...inline]).toEqual(['pd_1'])
  })

  it('待裁决按涉及的记忆首次带入的顺序排；同一条记忆既有横向又有基线冲突时两条都列，横向在前', () => {
    const { decisions, inline } = groupInjected({
      ...base, injectedIds: ['f1', 'p1'], conflicts: [conflict(pref, null)], verticals: [vertical(pref), vertical(fact, 'pv_2')],
    })
    expect(decisions).toEqual([
      { kind: 'vertical', item: vertical(fact, 'pv_2') },
      { kind: 'conflict', item: conflict(pref, null) },
      { kind: 'vertical', item: vertical(pref) },
    ])
    expect([...inline]).toEqual(['pv_2', 'pd_1', 'pv_1'])
  })

  it('刚裁决的冲突：列成裁决结果，留在原来的位置；记忆删掉后组里按留下的快照画；同一 decisionId 的待决项不再列、不进 inline', () => {
    const ruled: Ruled = { kind: 'horizontal', decisionId: 'pd_1', verdict: 'keep-left', left: pref, right: pref2 }
    const { groups, decisions, inline } = groupInjected({
      ...base, injectedIds: ['p1', 'p2', 'f1'], byId: new Map([[pref.id, pref], [fact.id, fact]]), ruled: [ruled],
      conflicts: [conflict(pref, pref2)], verticals: [vertical(fact)],
    })
    expect(ids(groups)).toEqual([['preference', ['p1', 'p2']], ['fact', ['f1']]])
    expect(groups[0]?.memories[1]).toBe(pref2)
    expect(decisions).toEqual([{ kind: 'ruled', ruled }, { kind: 'vertical', item: vertical(fact) }])
    expect([...inline]).toEqual(['pv_1'])
  })

  it('裁决过的 decisionId 不再列，同一条记忆的其他待决冲突照列', () => {
    const ruled: Ruled = { kind: 'vertical', decisionId: 'pv_1', verdict: 'keep-right', memory: pref }
    const { decisions, inline } = groupInjected({
      ...base, injectedIds: ['p1'], ruled: [ruled], conflicts: [conflict(pref, null, 'pd_2')], verticals: [vertical(pref, 'pv_1')],
    })
    expect(decisions).toEqual([{ kind: 'conflict', item: conflict(pref, null, 'pd_2') }, { kind: 'ruled', ruled }])
    expect([...inline]).toEqual(['pd_2'])
  })
})
