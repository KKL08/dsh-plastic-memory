import { describe, expect, it, vi } from 'vitest'
import { MemoryStore } from '../src/store.ts'
import { SnapshotStore } from '../src/governance/snapshots.ts'
import { PendingDecisionsStore } from '../src/governance/decisions.ts'
import type { MemorySnapshot, PendingDecision } from '../src/governance/schema.ts'
import { DREAMS_DEFAULTS, resolveDreamsConfig, type DreamsConfig } from '../src/governance/dreams-gate.ts'
import { DreamsStore } from '../src/governance/dreams-records.ts'
import type { DreamsRunDeps, DreamsStep } from '../src/tools/dreams-run.ts'
import { DreamsScheduler } from '../src/tools/dreams-scheduler.ts'
import { scheduledScopes } from '../src/governance/scope-health.ts'
import type { ActivityView, WorkspaceActivity } from '../src/governance/session-activity.ts'
import type { DreamMarks, DreamsRecord } from '../src/storage/schema.ts'
import { record } from './helpers/record.ts'
import { InMemoryTable } from './helpers/in-memory-table.ts'
import { InMemoryKvTable, InMemoryBatchKvTable } from './helpers/in-memory-kv.ts'

// 记忆梦境的调度：一轮检查查哪些范围、按什么顺序过门槛、什么时候再查

const DAY = 86_400_000
const MINUTE = 60_000
const T0 = 1_800_000_000_000
const A = '/proj/a'
const B = '/proj/b'
const quiet = { info() {}, warn() {}, error() {}, debug() {} }
const config: DreamsConfig = { ...DREAMS_DEFAULTS, minChanges: 2 }

function world(opts: { plan?: (ran: string[]) => DreamsStep[] } = {}) {
  const store = new MemoryStore(new InMemoryTable(), undefined, new InMemoryBatchKvTable())
  const records = new InMemoryKvTable<DreamsRecord>()
  const dreams = new DreamsStore(records, new InMemoryKvTable<DreamMarks>())
  const claims = new InMemoryKvTable<{ id: string }>()
  const ran: string[] = []
  const state = {
    now: T0, isEnabled: true, activity: new Map<string, WorkspaceActivity>(), isActivityComplete: true, runSeq: 0,
    quietListeners: [] as Array<() => void>, timeouts: [] as Array<{ fn: () => void; ms: number }>, viewReads: 0,
  }
  const run: DreamsRunDeps = {
    store, snapshots: new SnapshotStore(new InMemoryKvTable<MemorySnapshot>()), decisions: new PendingDecisionsStore(new InMemoryKvTable<PendingDecision>()), dreams, log: quiet,
    claimScope: async (scope) => {
      const release = await claims.claim(scope.kind === 'global' ? 'global' : scope.workspacePath)
      return release === undefined ? { busy: scope } : { release }
    },
    activity: async (): Promise<ActivityView> => ({ isComplete: state.isActivityComplete, workspaces: state.activity }),
    resolveLlm: async () => ({ llm: null, isSelected: false, fellBack: false }),
    config: () => config,
    isGovernanceEnabled: () => state.isEnabled,
    plan: opts.plan?.(ran) ?? [{ name: 'mark', needsChanges: false, run: async (ctx) => { ran.push(ctx.scope.kind === 'global' ? 'global' : ctx.scope.workspacePath) } }],
    interval: () => () => {},
    now: () => state.now++,
    newRunId: () => `run_${++state.runSeq}`,
  }
  const scheduler = new DreamsScheduler({
    run, store, log: quiet,
    board: {
      view: async () => { state.viewReads++; return { isComplete: state.isActivityComplete, workspaces: state.activity } },
      onQuiet: (listener) => { state.quietListeners.push(listener); return () => { state.quietListeners.splice(state.quietListeners.indexOf(listener), 1) } },
    },
    timeout: (fn, ms) => {
      const entry = { fn, ms }
      state.timeouts.push(entry)
      return () => { const i = state.timeouts.indexOf(entry); if (i >= 0) state.timeouts.splice(i, 1) }
    },
  })
  return { store, records, dreams, claims, ran, state, run, scheduler }
}
type World = ReturnType<typeof world>

/** 给一个范围放够数的记忆（变化数达到阈值）。 */
async function fill(w: World, workspacePath?: string, count = config.minChanges) {
  for (let i = 0; i < count; i++) {
    await w.store.create(record(workspacePath === undefined ? { content: `全局 ${i}` } : { scope: 'workspace', workspacePath, content: `${workspacePath} ${i}` }))
  }
}
const stopped = (lastActiveAt: number): WorkspaceActivity => ({ isRunning: false, lastActiveAt })
const running = (at: number): WorkspaceActivity => ({ isRunning: true, lastActiveAt: at, lastStartedAt: at })

describe('范围清单', () => {
  it('全局在前，项目按路径排序；没有自己的记忆、单独设了开关的项目也列出来，all、global 这类键不算项目', () => {
    expect(scheduledScopes([B, A], ['all', 'global', '/proj/c', A])).toEqual([
      { kind: 'global' }, { kind: 'workspace', workspacePath: A }, { kind: 'workspace', workspacePath: B }, { kind: 'workspace', workspacePath: '/proj/c' },
    ])
  })
})

describe('一轮检查', () => {
  it('默认值开着：跟随默认值的项目也查，全局先、项目按路径；单独关掉的不查', async () => {
    const w = world()
    await fill(w)
    await fill(w, B)
    await fill(w, A)
    await fill(w, '/proj/off')
    await w.dreams.setEnabled('all', true)
    await w.dreams.setEnabled({ kind: 'workspace', workspacePath: '/proj/off' }, false)
    await w.scheduler.recheck()
    expect(w.ran).toEqual(['global', A, B])
  })

  it('默认值关着、只有一个项目单独开了：只查它', async () => {
    const w = world()
    await fill(w)
    await fill(w, A)
    await w.dreams.setEnabled({ kind: 'workspace', workspacePath: A }, true)
    await w.scheduler.recheck()
    expect(w.ran).toEqual([A])
  })

  it('治理总开关关着：什么都不读', async () => {
    const w = world()
    await fill(w)
    await w.dreams.setEnabled('all', true)
    w.state.isEnabled = false
    const read = vi.spyOn(w.dreams, 'read')
    await w.scheduler.recheck()
    expect(read).not.toHaveBeenCalled()
    expect(w.ran).toEqual([])
  })

  it('一个开着的范围都没有：不列目录、不读记忆', async () => {
    const w = world()
    await fill(w)
    const list = vi.spyOn(w.store, 'listWorkspaceDirs')
    await w.scheduler.recheck()
    expect(list).not.toHaveBeenCalled()
  })

  it('记录表读不全：这一轮不运行', async () => {
    const w = world()
    await fill(w)
    await w.dreams.setEnabled('all', true)
    w.records.isComplete = false
    await w.scheduler.recheck()
    expect(w.ran).toEqual([])
  })

  it('按成本从低到高：没到间隔的不读记忆；变化不够的不读活动表', async () => {
    const w = world()
    await fill(w)
    await w.dreams.setEnabled('all', true)
    await w.scheduler.recheck()
    expect(w.ran).toEqual(['global'])
    const readRaw = vi.spyOn(w.store, 'readRaw')
    // 刚做完：间隔没到
    await w.scheduler.recheck()
    expect(readRaw).not.toHaveBeenCalled()
    // 间隔到了、没有新变化：读了记忆，没读活动表
    w.state.now += 8 * DAY
    w.state.viewReads = 0
    await w.scheduler.recheck()
    expect(readRaw).toHaveBeenCalled()
    expect(w.state.viewReads).toBe(0)
    expect(w.ran).toEqual(['global'])
    // 又有够多的变化：跑
    await fill(w)
    await w.scheduler.recheck()
    expect(w.ran).toEqual(['global', 'global'])
  })

  it('空闲：项目只看自己的工作目录，全局要所有工作目录都空闲；未满空闲时间不跑', async () => {
    const w = world()
    await fill(w)
    await fill(w, A)
    await fill(w, B)
    await w.dreams.setEnabled('all', true)
    w.state.activity.set(B, running(T0 - 5))
    await w.scheduler.recheck()
    expect(w.ran).toEqual([A])
    // B 停了但没满空闲时间
    w.state.activity.set(B, stopped(w.state.now))
    await w.scheduler.recheck()
    expect(w.ran).toEqual([A])
    w.state.now += config.idleMinutes * MINUTE
    await w.scheduler.recheck()
    expect(w.ran).toEqual([A, 'global', B])
  })

  it('活动表读不全：不算空闲，都不跑', async () => {
    const w = world()
    await fill(w)
    await w.dreams.setEnabled('all', true)
    w.state.isActivityComplete = false
    await w.scheduler.recheck()
    expect(w.ran).toEqual([])
  })

  it('一个范围让路停下只停它自己：后面的范围照常跑', async () => {
    let w!: World
    w = world({
      plan: ran => [{
        name: 'mark', needsChanges: false,
        run: async (ctx) => {
          if (ctx.scope.kind === 'workspace' && ctx.scope.workspacePath === A) {
            // A 的会话这时开始跑：A 让路
            w.state.activity.set(A, running(w.state.now))
            ctx.shouldStop()
            return
          }
          ran.push(ctx.scope.kind === 'global' ? 'global' : ctx.scope.workspacePath)
        },
      }, { name: 'after', needsChanges: false, run: async () => {} }],
    })
    await fill(w, A)
    await fill(w, B)
    await w.dreams.setEnabled('all', true)
    await w.scheduler.recheck()
    expect(w.ran).toEqual([B])
    expect((await w.records.get(A))?.unfinished?.reason).toBe('yielded')
    expect((await w.records.get(B))?.completed).toBeDefined()
  })

  it('被体检或整理索引占着的范围跳过，别的照常', async () => {
    const w = world()
    await fill(w)
    await fill(w, A)
    await w.dreams.setEnabled('all', true)
    await w.claims.claim('global')
    await w.scheduler.recheck()
    expect(w.ran).toEqual([A])
  })

  it('这个范围的记忆读不全：照样交给运行，按出错记下（之后按出错的间隔重试）', async () => {
    const w = world()
    await fill(w)
    await w.dreams.setEnabled('all', true)
    const read = w.store.readRaw.bind(w.store)
    vi.spyOn(w.store, 'readRaw').mockImplementation(async (scope, o) => ({ ...(await read(scope, o)), quarantined: [{ path: '/x.md' }] as never }))
    await w.scheduler.recheck()
    expect(w.ran).toEqual([])
    expect((await w.records.get('global'))?.failure?.count).toBe(1)
    // 没到重试时间：这一轮不再试
    await w.scheduler.recheck()
    expect((await w.records.get('global'))?.failure?.count).toBe(1)
  })

  it('正在查的时候又叫查：不另起一轮，这一轮做完再查一遍', async () => {
    const w = world()
    await fill(w)
    await w.dreams.setEnabled('all', true)
    const read = vi.spyOn(w.dreams, 'read')
    const first = w.scheduler.recheck()
    const second = w.scheduler.recheck()
    await Promise.all([first, second])
    expect(read.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(w.ran).toEqual(['global'])
  })
})

describe('什么时候再查', () => {
  it('本进程转安静：过了空闲时间再查一遍；期间又转安静就重新计时', async () => {
    const w = world()
    w.scheduler.start()
    w.state.quietListeners[0]!()
    w.state.quietListeners[0]!()
    expect(w.state.timeouts.map(t => t.ms)).toEqual([config.idleMinutes * MINUTE + 1000])
    await fill(w)
    await w.dreams.setEnabled('all', true)
    w.state.timeouts[0]!.fn()
    await w.scheduler.whenIdle()
    expect(w.ran).toEqual(['global'])
  })

  it('治理关着时转安静不排检查', () => {
    const w = world()
    w.state.isEnabled = false
    w.scheduler.start()
    w.state.quietListeners[0]!()
    expect(w.state.timeouts).toEqual([])
  })

  it('卸载：退订、取消排着的检查，之后不再查；正在跑的运行在下一个检查点停，不写记录', async () => {
    let w!: World
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    w = world({ plan: ran => [
      { name: 'one', needsChanges: false, run: async () => { ran.push('one'); await gate } },
      { name: 'two', needsChanges: false, run: async () => { ran.push('two') } },
    ] })
    await fill(w)
    await w.dreams.setEnabled('all', true)
    w.scheduler.start()
    w.state.quietListeners[0]!()
    const round = w.scheduler.recheck()
    await vi.waitFor(() => expect(w.ran).toEqual(['one']))
    const disposing = w.scheduler.dispose()
    release()
    await disposing
    await round
    expect(w.ran).toEqual(['one'])
    expect(w.state.quietListeners).toEqual([])
    expect(w.state.timeouts).toEqual([])
    const saved = await w.records.get('global')
    expect(saved?.unfinished).toMatchObject({ reason: 'lost' })
    expect(saved?.lastResult).toBeUndefined()
    expect(await w.claims.isClaimed('global')).toBe(false)
    await w.scheduler.recheck()
    expect(w.ran).toEqual(['one'])
  })
})

describe('立即运行', () => {
  it('不看间隔、变化、空闲和范围开关；排在进行中的那一轮之后', async () => {
    const w = world()
    w.state.activity.set(A, stopped(T0 - 1))
    const r = await w.scheduler.runNow({ kind: 'workspace', workspacePath: A })
    expect(r.kind).toBe('completed')
    expect(w.ran).toEqual([A])
    expect((await w.records.get(A))?.lastResult?.by).toBe('manual')
  })

  it('有会话在跑时坚持要跑：只对之后新开的会话让路', async () => {
    const w = world()
    w.state.activity.set(A, running(T0 - 60_000))
    expect((await w.scheduler.runNow({ kind: 'workspace', workspacePath: A })).kind).toBe('yielded')
    expect((await w.scheduler.runNow({ kind: 'workspace', workspacePath: A }, { yieldOnlyToNew: true })).kind).toBe('completed')
  })

  it('治理总开关关着：不跑', async () => {
    const w = world()
    w.state.isEnabled = false
    expect((await w.scheduler.runNow({ kind: 'global' })).kind).toBe('disabled')
  })
})

describe('配置取值', () => {
  it('坏值用默认值并报出是哪几项；用量上限可以是 0', () => {
    expect(resolveDreamsConfig({ minIntervalDays: 3, weeklyTokenCap: 0 })).toEqual({ config: { ...DREAMS_DEFAULTS, minIntervalDays: 3, weeklyTokenCap: 0 }, badKeys: [] })
    expect(resolveDreamsConfig({ minIntervalDays: 0, minChanges: -1, idleMinutes: Number.NaN, minNewMessages: '5', weeklyTokenCap: -1 })).toEqual({
      config: DREAMS_DEFAULTS, badKeys: ['minIntervalDays', 'minChanges', 'minNewMessages', 'idleMinutes', 'weeklyTokenCap'],
    })
  })
})
