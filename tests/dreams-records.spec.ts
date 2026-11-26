import { describe, expect, it } from 'vitest'
import { DreamsStore, DREAMS_USAGE_KEY } from '../src/governance/dreams-records.ts'
import { dreamsRecordSchema, type DreamMarks, type DreamsRecord } from '../src/storage/schema.ts'
import { InMemoryKvTable } from './helpers/in-memory-kv.ts'

// 记忆梦境的侧表读写：范围开关、运行记录、变化基线、用量

const DAY = 86_400_000
const NOW = 1_800_000_000_000
const WS = { kind: 'workspace', workspacePath: '/proj/a' } as const
const GLOBAL = { kind: 'global' } as const
const STEPS = [{ name: 'maintain', state: 'done' }]
const last = (runId: string, kind: string) => ({ runId, kind, by: 'auto', endedAt: NOW + 5, steps: STEPS, usageTokens: 0 })

function world() {
  const records = new InMemoryKvTable<DreamsRecord>()
  const marks = new InMemoryKvTable<DreamMarks>()
  return { records, marks, store: new DreamsStore(records, marks) }
}

describe('开关', () => {
  it('默认值和单独设置各存各的；改回跟随只去掉单独设置，运行记录留着', async () => {
    const w = world()
    await w.store.setEnabled('all', true)
    await w.store.setEnabled(WS, false)
    await w.store.begin(WS, 'r1', NOW)
    let state = await w.store.read()
    expect(Object.fromEntries(state.settings)).toEqual({ all: true, '/proj/a': false })
    expect([...state.records.keys()]).toEqual(['/proj/a'])
    await w.store.setEnabled(WS, 'follow')
    state = await w.store.read()
    expect(Object.fromEntries(state.settings)).toEqual({ all: true })
    expect(state.records.get('/proj/a')?.unfinished?.runId).toBe('r1')
  })

  it('有条目读不出：读出来的标成不完整', async () => {
    const w = world()
    await w.store.setEnabled('all', true)
    w.records.isComplete = false
    expect((await w.store.read()).isComplete).toBe(false)
  })
})

describe('一次运行的记录', () => {
  it('开始记成没做完（原因 lost），运行 id 记作这次的账本条目；上一次留下的条目接着带着，并交回上一次的没做完', async () => {
    const w = world()
    expect(await w.store.begin(GLOBAL, 'r1', NOW)).toBeUndefined()
    expect((await w.records.get('global'))?.unfinished).toEqual({ runId: 'r1', startedAt: NOW, stoppedAt: NOW, reason: 'lost', entryIds: ['r1'] })
    expect(await w.store.begin(GLOBAL, 'r2', NOW + 10)).toMatchObject({ runId: 'r1', entryIds: ['r1'] })
    expect((await w.records.get('global'))?.unfinished).toEqual({ runId: 'r2', startedAt: NOW + 10, stoppedAt: NOW + 10, reason: 'lost', entryIds: ['r1', 'r2'] })
  })

  it('做完：基线带运行 id 写下，记录里记完成、清掉没做完和连续出错，开关不动', async () => {
    const w = world()
    await w.store.setEnabled(WS, true)
    await w.store.begin(WS, 'r1', NOW)
    expect(await w.store.stop(WS, 'r1', { stoppedAt: NOW + 1, reason: 'failed', entryIds: [] }, last('r1', 'failed'))).toBe(true)
    expect((await w.records.get('/proj/a'))?.failure).toEqual({ count: 1, failedAt: NOW + 1 })
    await w.store.begin(WS, 'r2', NOW + 2)
    expect(await w.store.complete(WS, { runId: 'r2', startedAt: NOW + 2, endedAt: NOW + 5 }, { mem_a: 'f1' }, last('r2', 'completed'))).toBe(true)
    const rec = await w.records.get('/proj/a')
    expect(rec).toEqual({ id: '/proj/a', enabled: true, completed: { runId: 'r2', startedAt: NOW + 2, endedAt: NOW + 5 }, lastResult: last('r2', 'completed') })
    expect(await w.store.baseline(WS, 'r2')).toEqual({ kind: 'ok', marks: { mem_a: 'f1' } })
  })

  it('没做完：让路不计连续出错，出错的每次加一；用过的账本条目记下', async () => {
    const w = world()
    await w.store.begin(GLOBAL, 'r1', NOW)
    await w.store.stop(GLOBAL, 'r1', { stoppedAt: NOW + 1, reason: 'yielded', entryIds: ['pd_1'] }, last('r1', 'yielded'))
    let rec = await w.records.get('global')
    expect(rec?.failure).toBeUndefined()
    expect(rec?.unfinished).toEqual({ runId: 'r1', startedAt: NOW, stoppedAt: NOW + 1, reason: 'yielded', entryIds: ['pd_1'] })
    for (const [i, runId] of ['r2', 'r3'].entries()) {
      await w.store.begin(GLOBAL, runId, NOW + 10 * (i + 1))
      await w.store.stop(GLOBAL, runId, { stoppedAt: NOW + 10 * (i + 1) + 1, reason: 'failed', entryIds: [] }, last(runId, 'failed'))
    }
    rec = await w.records.get('global')
    expect(rec?.failure).toEqual({ count: 2, failedAt: NOW + 21 })
  })

  it('别的进程已经开始了新的一次：旧的那次做完、没做完都不改记录，也不写基线', async () => {
    const w = world()
    await w.store.begin(GLOBAL, 'r1', NOW)
    await w.store.begin(GLOBAL, 'r2', NOW + 100)
    const before = await w.records.get('global')
    expect(await w.store.complete(GLOBAL, { runId: 'r1', startedAt: NOW, endedAt: NOW + 200 }, { mem_a: 'f' }, last('r1', 'completed'))).toBe(false)
    expect(await w.store.stop(GLOBAL, 'r1', { stoppedAt: NOW + 200, reason: 'failed', entryIds: [] }, last('r1', 'failed'))).toBe(false)
    expect(await w.records.get('global')).toEqual(before)
    expect(await w.marks.get('global')).toBeUndefined()
  })
})

describe('变化基线', () => {
  it('从没做完过：没有基线；做完过但基线不在、对不上那次运行：不可用', async () => {
    const w = world()
    expect(await w.store.baseline(GLOBAL, undefined)).toEqual({ kind: 'none' })
    expect(await w.store.baseline(GLOBAL, 'r1')).toEqual({ kind: 'unavailable' })
    await w.marks.put('global', { id: 'global', runId: 'r0', takenAt: NOW, marks: { mem_a: 'f' } })
    expect(await w.store.baseline(GLOBAL, 'r1')).toEqual({ kind: 'unavailable' })
    expect(await w.store.baseline(GLOBAL, 'r0')).toEqual({ kind: 'ok', marks: { mem_a: 'f' } })
  })
})

describe('用量', () => {
  it('同一次运行累加在一行，七天前的顺手丢掉；零和负数不记', async () => {
    const w = world()
    await w.records.put(DREAMS_USAGE_KEY, { id: DREAMS_USAGE_KEY, runs: [{ runId: 'old', at: NOW - 8 * DAY, tokens: 9 }, { runId: 'r0', at: NOW - DAY, tokens: 5 }] })
    await w.store.addUsage('r1', NOW, 100)
    await w.store.addUsage('r1', NOW + 10, 20)
    await w.store.addUsage('r1', NOW + 20, 0)
    expect((await w.store.read()).usageRuns).toEqual([{ runId: 'r0', at: NOW - DAY, tokens: 5 }, { runId: 'r1', at: NOW + 10, tokens: 120 }])
  })
})

describe('处理矛盾的续读位置', () => {
  const cursor = { firstSeenAt: NOW, id: 'pd_a' }

  it('认领被别的进程接手、那边开始了新的一次：旧的运行写不进续读位置，新的运行写得进', async () => {
    const w = world()
    await w.store.begin(GLOBAL, 'r1', NOW)
    await w.store.begin(GLOBAL, 'r2', NOW + 10)
    expect(await w.store.saveResolveCursor(GLOBAL, 'r1', cursor)).toBe(false)
    expect(await w.store.resolveCursor(GLOBAL)).toBeUndefined()
    expect(await w.store.saveResolveCursor(GLOBAL, 'r2', cursor)).toBe(true)
    expect(await w.store.resolveCursor(GLOBAL)).toEqual(cursor)
  })

  it('这个范围没有在跑的运行：不写', async () => {
    const w = world()
    expect(await w.store.saveResolveCursor(WS, 'r1', cursor)).toBe(false)
    expect(await w.records.get('/proj/a')).toBeUndefined()
  })

  it('续读位置跟着运行记录走：做完、没做完、下一次开始都留着，别的范围不受影响', async () => {
    const w = world()
    await w.store.begin(GLOBAL, 'r1', NOW)
    await w.store.saveResolveCursor(GLOBAL, 'r1', cursor)
    await w.store.stop(GLOBAL, 'r1', { stoppedAt: NOW + 5, reason: 'yielded', entryIds: [] }, last('r1', 'yielded'))
    expect(await w.store.resolveCursor(GLOBAL)).toEqual(cursor)
    await w.store.begin(GLOBAL, 'r2', NOW + 10)
    expect(await w.store.resolveCursor(GLOBAL)).toEqual(cursor)
    await w.store.complete(GLOBAL, { runId: 'r2', startedAt: NOW + 10, endedAt: NOW + 20 }, {}, last('r2', 'completed'))
    expect(await w.store.resolveCursor(GLOBAL)).toEqual(cursor)
    expect(await w.store.resolveCursor(WS)).toBeUndefined()
  })

  it('落盘格式：续读位置是可选字段，没有它的旧记录照常读出', () => {
    expect(dreamsRecordSchema.parse({ id: 'global', resolveCursor: cursor }).resolveCursor).toEqual(cursor)
    expect(dreamsRecordSchema.parse({ id: 'global' }).resolveCursor).toBeUndefined()
  })
})
