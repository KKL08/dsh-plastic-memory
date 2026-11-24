import { describe, expect, it } from 'vitest'
import { applyChange, initialProvenance, SOURCE_TRAIL_CAP, stateStartOf, type Change } from '../src/change.ts'
import { anchorsOf, memoryRecordSchema, type MemoryRecord } from '../src/record-schema.ts'
import { record } from './helpers/record.ts'

// 改动性质的落盘行为表：纯函数，不碰存储

const T0 = 1_700_000_000_000
const NOW = T0 + 5_000
const anchor = (n: number, sourceMode = 'agent-inferred') => ({ sessionId: `s${n}`, eventRange: [n, n + 1] as [number, number], sourceMode })

function base(extra: Partial<MemoryRecord> = {}): MemoryRecord {
  return record({
    id: 'mem_a', name: '发版流程', content: '旧正文', summary: '旧摘要', tags: ['x'], confidence: 0.5,
    createdAt: T0, updatedAt: T0 + 10, lastConfirmedAt: T0 + 20,
    ...initialProvenance(anchor(0), 'main', T0),
    ...extra,
  })
}

const change = (kind: Change['kind'], extra: Partial<Change> = {}): Change => ({
  kind, fields: { content: '新正文', summary: '新摘要' }, anchor: anchor(1), by: 'main', op: 'op_1', at: NOW, ...extra,
})

describe('新建时的出处', () => {
  it('一个锚，带时间、来源方式、谁写的；状态起点等于创建时刻；source 等于这个锚的三项', () => {
    const r = base()
    expect(r.sourceTrail).toEqual([{ ...anchor(0), at: T0, change: 'create', by: 'main' }])
    expect(r.source).toEqual(anchor(0))
    expect(r.stateSince).toBe(T0)
    expect(r.lastChange).toBeUndefined()
    expect(memoryRecordSchema.safeParse(r).success).toBe(true)
  })
})

describe('补证', () => {
  it('正文参数不生效；确认时间刷新；清单最前多一个锚；最近一次内容改动和修改时间不动', () => {
    const before = base({ lastChange: { kind: 'refine', at: T0 + 10, op: 'op_0', by: 'main' } })
    const after = applyChange(before, change('corroborate'))
    expect(after).toEqual({
      ...before,
      source: anchor(1),
      sourceTrail: [{ ...anchor(1), at: NOW, change: 'corroborate', by: 'main' }, ...before.sourceTrail!],
      lastConfirmedAt: NOW,
    })
  })

  it('把握只升不降', () => {
    expect(applyChange(base(), change('corroborate', { fields: { confidence: 0.9 } })).confidence).toBe(0.9)
    expect(applyChange(base({ confidence: 0.9 }), change('corroborate', { fields: { confidence: 0.5 } })).confidence).toBe(0.9)
  })
})

describe.each(['refine', 'correct'] as const)('%s', (kind) => {
  it('按给的字段改；加锚；记下这一次内容改动；没给的字段保留', () => {
    const before = base()
    const after = applyChange(before, change(kind))
    expect(after).toEqual({
      ...before,
      content: '新正文', summary: '新摘要',
      source: anchor(1),
      sourceTrail: [{ ...anchor(1), at: NOW, change: kind, by: 'main' }, ...before.sourceTrail!],
      updatedAt: NOW,
      lastChange: { kind, at: NOW, op: 'op_1', by: 'main' },
    })
    expect(after.tags).toEqual(['x'])
    expect(after.stateSince).toBe(T0)
  })

  it('确认时间只在来源是用户明说时刷新', () => {
    expect(applyChange(base(), change(kind)).lastConfirmedAt).toBe(T0 + 20)
    expect(applyChange(base(), change(kind, { anchor: anchor(1, 'user-explicit') })).lastConfirmedAt).toBe(NOW)
  })
})

describe('状态变化', () => {
  it('替换正文；确认时间刷新；状态起点改成这一刻；清单只剩这次的锚', () => {
    const before = applyChange(applyChange(base(), change('corroborate')), change('corroborate', { anchor: anchor(2) }))
    expect(before.sourceTrail).toHaveLength(3)
    const after = applyChange(before, change('state-change', { anchor: anchor(3) }))
    expect(after.content).toBe('新正文')
    expect(after.sourceTrail).toEqual([{ ...anchor(3), at: NOW, change: 'state-change', by: 'main' }])
    expect(after.source).toEqual(anchor(3))
    expect(after.lastConfirmedAt).toBe(NOW)
    expect(after.stateSince).toBe(NOW)
    expect(after.lastChange).toEqual({ kind: 'state-change', at: NOW, op: 'op_1', by: 'main' })
  })

  it('并进上一次留的历史版本时，旧锚留在清单里', () => {
    const after = applyChange(base(), change('state-change', { isMergedIntoLastVersion: true }))
    expect(after.sourceTrail!.map(a => a.sessionId)).toEqual(['s1', 's0'])
    expect(after.stateSince).toBe(NOW)
  })
})

describe('出处清单', () => {
  it('封顶：新的在前，最旧的补证锚丢掉，新建那个写下内容的锚留在末位', () => {
    let r = base()
    for (let i = 1; i <= SOURCE_TRAIL_CAP + 2; i++) r = applyChange(r, change('corroborate', { anchor: anchor(i), at: NOW + i }))
    expect(r.sourceTrail).toHaveLength(SOURCE_TRAIL_CAP)
    expect(r.sourceTrail![0]!.sessionId).toBe(`s${SOURCE_TRAIL_CAP + 2}`)
    expect(r.sourceTrail!.at(-2)!.sessionId).toBe('s4')
    expect(r.sourceTrail!.at(-1)).toMatchObject({ sessionId: 's0', change: 'create' })
  })

  it('封顶：留下的锚里已有写下内容的，最旧的照常丢掉', () => {
    let r = applyChange(base(), change('refine', { anchor: anchor(1), at: NOW + 1 }))
    for (let i = 2; i <= SOURCE_TRAIL_CAP; i++) r = applyChange(r, change('corroborate', { anchor: anchor(i), at: NOW + i }))
    expect(r.sourceTrail!.map(a => a.sessionId)).toEqual(Array.from({ length: SOURCE_TRAIL_CAP }, (_, i) => `s${SOURCE_TRAIL_CAP - i}`))
  })

  it('旧文件只有 source 没有清单：source 当成第一个锚，再加上这次的', () => {
    const old = record({ id: 'mem_old', updatedAt: T0, source: { sessionId: 'legacy', eventRange: [3, 9], sourceMode: 'user-explicit' } })
    const after = applyChange(old, change('corroborate'))
    expect(after.sourceTrail).toEqual([
      { ...anchor(1), at: NOW, change: 'corroborate', by: 'main' },
      { sessionId: 'legacy', eventRange: [3, 9], sourceMode: 'user-explicit', at: T0 },
    ])
  })

  it('锚的来源方式是这一版不认识的：锚里原样留着，顶层 source 写最弱的一档', () => {
    const after = applyChange(base(), change('refine', { anchor: anchor(1, 'future-mode') }))
    expect(after.sourceTrail![0]!.sourceMode).toBe('future-mode')
    expect(after.source!.sourceMode).toBe('agent-inferred')
    expect(memoryRecordSchema.safeParse(after).success).toBe(true)
  })

  it('不给锚：source 和清单原样不动，内容照改', () => {
    const before = base()
    const after = applyChange(before, change('correct', { anchor: undefined, by: 'dreams' }))
    expect(after.sourceTrail).toEqual(before.sourceTrail)
    expect(after.source).toEqual(before.source)
    expect(after.lastChange).toEqual({ kind: 'correct', at: NOW, op: 'op_1', by: 'dreams' })
  })
})

describe('这一版从什么时候起成为当前版', () => {
  it('有状态起点用它；没有时取上一版的结束时间；也没有上一版取创建时间', () => {
    expect(stateStartOf({ stateSince: 30, createdAt: 10 }, 20)).toBe(30)
    expect(stateStartOf({ stateSince: undefined, createdAt: 10 }, 20)).toBe(20)
    expect(stateStartOf({ stateSince: undefined, createdAt: 10 }, undefined)).toBe(10)
  })
})

describe('来源方式是这一版不认识的', () => {
  it('读出处清单时不多出一个锚：顶层 source 按最弱一档写，和清单里第一个锚仍算同一个', () => {
    const r = applyChange(base(), change('corroborate', { anchor: anchor(1, 'future-mode') }))
    expect(r.source!.sourceMode).toBe('agent-inferred')
    expect(anchorsOf(r).map(a => a.sourceMode)).toEqual(['future-mode', 'agent-inferred'])
  })
})
