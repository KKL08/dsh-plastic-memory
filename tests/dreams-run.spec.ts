import { describe, expect, it, vi } from 'vitest'
import { MemoryStore } from '../src/store.ts'
import { SnapshotStore } from '../src/governance/snapshots.ts'
import { PendingDecisionsStore } from '../src/governance/decisions.ts'
import type { MemorySnapshot, PendingDecision } from '../src/governance/schema.ts'
import { basisOf, scopeKeyOf, type ChangeOp } from '../src/governance/changeset.ts'
import { receiptsOfEntry } from '../src/tools/changeset.ts'
import { DREAMS_DEFAULTS, dreamContentFingerprint } from '../src/governance/dreams-gate.ts'
import { DreamsStore } from '../src/governance/dreams-records.ts'
import { DreamsModelUnavailable, maintainStep, readDreamMarks, runDreams, type DreamsRunDeps, type DreamsRunOptions, type DreamsStep } from '../src/tools/dreams-run.ts'
import type { ActivityView, WorkspaceActivity } from '../src/governance/session-activity.ts'
import type { ResolvedLlm } from '../src/governance/background-llm.ts'
import type { DreamMarks, DreamsRecord } from '../src/storage/schema.ts'
import type { MemoryRecord } from '../src/record-schema.ts'
import type { Scope } from '../src/scope.ts'
import { record } from './helpers/record.ts'
import { InMemoryTable } from './helpers/in-memory-table.ts'
import { InMemoryKvTable, InMemoryBatchKvTable } from './helpers/in-memory-kv.ts'

// 记忆梦境的一次运行：认领、认领后确认、记开始、收尾上次的、读基线、逐步做、记结果、放认领

const DAY = 86_400_000
const T0 = 1_800_000_000_000
const GLOBAL: Scope = { kind: 'global' }
const WS: Scope = { kind: 'workspace', workspacePath: '/proj/a' }
const quiet = { info() {}, warn() {}, error() {}, debug() {} }

function world(plan?: (w: { store: MemoryStore }) => DreamsStep[]) {
  const store = new MemoryStore(new InMemoryTable(), undefined, new InMemoryBatchKvTable())
  const snapshots = new SnapshotStore(new InMemoryKvTable<MemorySnapshot>())
  const pending = new InMemoryKvTable<PendingDecision>()
  const decisions = new PendingDecisionsStore(pending)
  const records = new InMemoryKvTable<DreamsRecord>()
  const marks = new InMemoryKvTable<DreamMarks>()
  const dreams = new DreamsStore(records, marks)
  const claims = new InMemoryKvTable<{ id: string }>()
  const state = {
    now: T0,
    isEnabled: true,
    activity: new Map<string, WorkspaceActivity>(),
    isActivityComplete: true,
    lose: undefined as (() => void) | undefined,
    resolved: { llm: { complete: async () => 'ok' }, isSelected: true, fellBack: false } as ResolvedLlm,
    resolveCalls: 0,
    runSeq: 0,
    // 变化数的门槛在门槛的单测里验；这里缺省放开，专门验它的用例自己设
    minChanges: 0,
    polls: [] as Array<() => void>,
  }
  const deps: DreamsRunDeps = {
    store, snapshots, decisions, dreams, log: quiet,
    claimScope: async (scope, onLost) => {
      const release = await claims.claim(scope.kind === 'global' ? 'global' : scope.workspacePath)
      if (release === undefined) return { busy: scope }
      state.lose = onLost
      return { release }
    },
    activity: async (): Promise<ActivityView> => ({ isComplete: state.isActivityComplete, workspaces: state.activity }),
    resolveLlm: async () => { state.resolveCalls++; return state.resolved },
    config: () => ({ ...DREAMS_DEFAULTS, minChanges: state.minChanges }),
    isGovernanceEnabled: () => state.isEnabled,
    plan: plan?.({ store }) ?? [maintainStep(store)],
    interval: (callback) => { state.polls.push(callback); return () => { state.polls.splice(state.polls.indexOf(callback), 1) } },
    now: () => state.now++,
    newRunId: () => `run_${++state.runSeq}`,
  }
  return { store, snapshots, decisions, pending, records, marks, dreams, claims, state, deps }
}
type World = ReturnType<typeof world>

const auto: DreamsRunOptions = { by: 'auto' }
async function enable(w: World) { await w.dreams.setEnabled('all', true) }
async function seed(w: World, partial: Partial<MemoryRecord> = {}) {
  const rec = record({ id: 'mem_a', content: '旧正文', createdAt: T0, updatedAt: T0, lastConfirmedAt: T0, ...partial })
  await w.store.create(rec)
  return (await w.store.get(rec.id, { workspacePath: rec.workspacePath }))!
}
const editOp = (read: MemoryRecord, id: string, content: string, extra: Partial<ChangeOp> = {}): ChangeOp =>
  ({ id, memoryId: read.id, scopeKey: scopeKeyOf(read), basis: [basisOf(read)], kind: 'edit', patch: { content }, expect: { content: read.content }, ...extra })
const rec = async (w: World, key = 'global') => (await w.records.get(key))!
const running = (lastStartedAt: number): WorkspaceActivity => ({ isRunning: true, lastActiveAt: lastStartedAt, lastStartedAt })

describe('正常做完', () => {
  it('只做维护：记完成、写基线、清掉没做完；不调模型，账本里不留条目，认领放掉', async () => {
    const w = world()
    await enable(w)
    const a = await seed(w)
    const maintain = vi.spyOn(w.store, 'maintain')
    const r = await runDreams(GLOBAL, auto, w.deps)
    expect(r).toEqual({ kind: 'completed', runId: 'run_1', steps: [{ name: 'maintain', state: 'done' }], usageTokens: 0 })
    expect(maintain).toHaveBeenCalledWith(GLOBAL)
    const saved = await rec(w)
    expect(saved.completed?.runId).toBe('run_1')
    expect(saved.unfinished).toBeUndefined()
    expect(saved.lastResult).toMatchObject({ runId: 'run_1', kind: 'completed', by: 'auto' })
    expect(await w.marks.get('global')).toMatchObject({ runId: 'run_1', marks: { mem_a: dreamContentFingerprint(a) } })
    expect(w.state.resolveCalls).toBe(0)
    expect(await w.decisions.listSettled()).toEqual([])
    expect(await w.claims.isClaimed('global')).toBe(false)
  })

  it('项目范围只读自己这一层：全局记忆不进它的基线', async () => {
    const w = world()
    await enable(w)
    await seed(w)
    const own = await seed(w, { id: 'mem_p', scope: 'workspace', workspacePath: '/proj/a' })
    await runDreams(WS, auto, w.deps)
    expect((await w.marks.get('/proj/a'))?.marks).toEqual({ mem_p: dreamContentFingerprint(own) })
  })

  it('没有新变化、上次也做完了：要有变化才做的步骤跳过，维护照做', async () => {
    const ran: string[] = []
    const w = world(({ store }) => [maintainStep(store), { name: 'tidy', needsChanges: true, run: async () => { ran.push('tidy') } }])
    await enable(w)
    await seed(w)
    expect((await runDreams(GLOBAL, auto, w.deps)).steps).toEqual([{ name: 'maintain', state: 'done' }, { name: 'tidy', state: 'done' }])
    w.state.now += 8 * DAY
    const second = await runDreams(GLOBAL, { by: 'manual' }, w.deps)
    expect(second.steps).toEqual([{ name: 'maintain', state: 'done' }, { name: 'tidy', state: 'skipped' }])
    expect(second.kind).toBe('completed')
    expect(ran).toEqual(['tidy'])
  })
})

describe('不开始', () => {
  it('治理总开关关着：两个入口都不跑，什么都不写', async () => {
    const w = world()
    await enable(w)
    w.state.isEnabled = false
    expect((await runDreams(GLOBAL, auto, w.deps)).kind).toBe('disabled')
    expect((await runDreams(GLOBAL, { by: 'manual' }, w.deps)).kind).toBe('disabled')
    expect(await w.records.get('global')).toBeUndefined()
  })

  it('这个范围的开关关着：自动不跑，手动照样可以跑', async () => {
    const w = world()
    expect((await runDreams(GLOBAL, auto, w.deps)).kind).toBe('disabled')
    expect(await w.records.get('global')).toBeUndefined()
    expect((await runDreams(GLOBAL, { by: 'manual' }, w.deps)).kind).toBe('completed')
  })

  it('认领不到（体检、整理索引或别的梦境占着）：返回 busy，什么都不写', async () => {
    const w = world()
    await enable(w)
    await w.claims.claim('global')
    expect(await runDreams(GLOBAL, auto, w.deps)).toEqual({ kind: 'busy', steps: [], usageTokens: 0 })
    expect(await w.records.get('global')).toBeUndefined()
  })

  it('认领后确认：别的进程刚做完，不再跑，放掉认领；手动的不看间隔', async () => {
    const w = world()
    await enable(w)
    await runDreams(GLOBAL, auto, w.deps)
    const before = await rec(w)
    expect((await runDreams(GLOBAL, auto, w.deps)).kind).toBe('not-due')
    expect(await rec(w)).toEqual(before)
    expect(await w.claims.isClaimed('global')).toBe(false)
    expect((await runDreams(GLOBAL, { by: 'manual' }, w.deps)).kind).toBe('completed')
  })

  it('认领后确认再数一遍变化：调度预查之后前台删掉了一条，不够数了就不跑，也不记开始', async () => {
    const w = world()
    await enable(w)
    w.state.minChanges = 2
    await seed(w)
    await seed(w, { id: 'mem_b' })
    // 预查时两条都在；认领到之前前台删了一条
    await w.store.softDelete({ id: 'mem_b' }, { now: T0 })
    expect((await runDreams(GLOBAL, auto, w.deps)).kind).toBe('not-due')
    expect(await w.records.get('global')).toBeUndefined()
    expect((await runDreams(GLOBAL, { by: 'manual' }, w.deps)).kind).toBe('completed')
  })

  it('认领到的那一刻已经被别的进程接手：不记开始，接手那次的记录原样留着', async () => {
    const w = world()
    await enable(w)
    const claim = w.deps.claimScope
    w.deps.claimScope = async (scope, onLost) => {
      const held = await claim(scope, onLost)
      await w.dreams.begin(GLOBAL, 'successor', T0 + 100)
      onLost()
      return held
    }
    expect((await runDreams(GLOBAL, auto, w.deps)).kind).toBe('lost')
    expect((await rec(w)).unfinished?.runId).toBe('successor')
    expect(await w.claims.isClaimed('global')).toBe(false)
  })

  it('七天用量到了上限：自动和手动都不跑', async () => {
    const w = world()
    await enable(w)
    await w.dreams.addUsage('r0', T0 - DAY, DREAMS_DEFAULTS.weeklyTokenCap)
    expect((await runDreams(GLOBAL, auto, w.deps)).kind).toBe('not-due')
    expect((await runDreams(GLOBAL, { by: 'manual' }, w.deps)).kind).toBe('not-due')
  })

  it('记录表读不全：不跑、不写', async () => {
    const w = world()
    await enable(w)
    w.records.isComplete = false
    expect((await runDreams(GLOBAL, auto, w.deps)).kind).toBe('not-due')
    expect(await w.records.get('global')).toBeUndefined()
    expect(await w.claims.isClaimed('global')).toBe(false)
  })

  it('记开始写不进：返回出错，不往下做，放掉认领', async () => {
    const w = world()
    await enable(w)
    const maintain = vi.spyOn(w.store, 'maintain')
    vi.spyOn(w.dreams, 'begin').mockRejectedValue(new Error('disk'))
    expect((await runDreams(GLOBAL, auto, w.deps)).kind).toBe('failed')
    expect(maintain).not.toHaveBeenCalled()
    expect(await w.claims.isClaimed('global')).toBe(false)
  })
})

describe('没做完', () => {
  it('读记忆不全：按出错收，不写基线、不记完成，连续出错加一', async () => {
    const w = world()
    await enable(w)
    const read = w.store.readRaw.bind(w.store)
    vi.spyOn(w.store, 'readRaw').mockImplementation(async (scope, opts) => ({ ...(await read(scope, opts)), quarantined: [{ path: '/x.md', reason: 'bad' }] as never }))
    const r = await runDreams(GLOBAL, auto, w.deps)
    expect(r.kind).toBe('failed')
    const saved = await rec(w)
    expect(saved.completed).toBeUndefined()
    expect(saved.unfinished).toMatchObject({ runId: 'run_1', reason: 'failed' })
    expect(saved.failure?.count).toBe(1)
    expect(await w.marks.get('global')).toBeUndefined()
  })

  it('目录读不了、项目目录缺标记也算读不全', async () => {
    const w = world()
    for (const code of ['dir-unreadable', 'marker-missing']) {
      const spy = vi.spyOn(w.store, 'readRaw').mockResolvedValue({ records: [], listedCount: 0, quarantined: [], directoryNotes: [{ code, level: 'info', path: '/p' }] } as never)
      expect(await readDreamMarks(w.store, WS)).toBeUndefined()
      spy.mockRestore()
    }
  })

  it('步骤抛错：按出错收，后面的步骤不做；下一次重试成功后连续出错清零', async () => {
    let shouldThrow = true
    const w = world(({ store }) => [
      { name: 'boom', needsChanges: false, run: async () => { if (shouldThrow) throw new Error('x') } },
      maintainStep(store),
    ])
    await enable(w)
    const r = await runDreams(GLOBAL, auto, w.deps)
    expect(r).toMatchObject({ kind: 'failed', steps: [{ name: 'boom', state: 'not-run' }, { name: 'maintain', state: 'not-run' }] })
    expect((await rec(w)).failure?.count).toBe(1)
    shouldThrow = false
    // 没到重试时间：认领后确认就挡下
    expect((await runDreams(GLOBAL, auto, w.deps)).kind).toBe('not-due')
    w.state.now += 3_600_000
    expect((await runDreams(GLOBAL, auto, w.deps)).kind).toBe('completed')
    const saved = await rec(w)
    expect(saved.failure).toBeUndefined()
    expect(saved.unfinished).toBeUndefined()
  })

  it('步骤之前有会话在跑：让路，这一步和后面的都不做；不计连续出错，下次不看间隔接着做', async () => {
    const w = world()
    await enable(w)
    w.state.activity.set('/proj/b', running(T0 - 5))
    const maintain = vi.spyOn(w.store, 'maintain')
    const r = await runDreams(GLOBAL, auto, w.deps)
    expect(r).toMatchObject({ kind: 'yielded', steps: [{ name: 'maintain', state: 'not-run' }] })
    expect(maintain).not.toHaveBeenCalled()
    const saved = await rec(w)
    expect(saved.unfinished).toMatchObject({ reason: 'yielded' })
    expect(saved.failure).toBeUndefined()
    expect(saved.lastResult?.kind).toBe('yielded')
    w.state.activity.clear()
    expect((await runDreams(GLOBAL, auto, w.deps)).kind).toBe('completed')
  })

  it('活动表读不全：按有会话在跑处理，让路', async () => {
    const w = world()
    await enable(w)
    w.state.isActivityComplete = false
    expect((await runDreams(GLOBAL, auto, w.deps)).kind).toBe('yielded')
  })

  it('一步里多个操作，中途该停了：后面的操作不做，这一步算没做完，已做的留着并有回执', async () => {
    let w!: World
    w = world(() => [{
      name: 'edit', needsChanges: false,
      run: async (ctx) => {
        const a = (await w.store.get('mem_a', {}))!
        const b = (await w.store.get('mem_b', {}))!
        const r = await ctx.apply([editOp(a, 'o1', '甲改'), editOp(b, 'o2', '乙改')])
        expect(r.outcomes.map(o => o.kind)).toEqual(['applied', 'skipped'])
      },
    }])
    await enable(w)
    await seed(w)
    await seed(w, { id: 'mem_b' })
    // 第一个操作落盘时认领被接手：后面的操作不做
    const applied: string[] = []
    const onWrite = vi.spyOn(w.decisions, 'appendChange')
    const realAppend = PendingDecisionsStore.prototype.appendChange
    onWrite.mockImplementation(async function (this: PendingDecisionsStore, id, receipt) {
      applied.push(receipt.id)
      w.state.lose?.()
      return realAppend.call(w.decisions, id, receipt)
    })
    const r = await runDreams(GLOBAL, auto, w.deps)
    expect(applied).toEqual(['o1'])
    expect(r.kind).toBe('lost')
    expect((await w.store.get('mem_a', {}))?.content).toBe('甲改')
    expect((await w.store.get('mem_b', {}))?.content).toBe('旧正文')
    expect((await receiptsOfEntry(w.decisions, 'run_1')).map(c => c.id)).toEqual(['o1'])
  })

  it('步骤进行中有会话开始跑（定时查到）：步骤查到该停，这一步算没做完，按让路收；定时随运行结束停掉', async () => {
    let w!: World
    const seen: boolean[] = []
    w = world(() => [{
      name: 'ask', needsChanges: false,
      run: async (ctx) => {
        seen.push(ctx.shouldStop())
        w.state.activity.set('/proj/b', running(w.state.now))
        for (const poll of w.state.polls) poll()
        await new Promise(resolve => setImmediate(resolve))
        seen.push(ctx.shouldStop())
      },
    }])
    await enable(w)
    const r = await runDreams(GLOBAL, auto, w.deps)
    expect(seen).toEqual([false, true])
    expect(r).toMatchObject({ kind: 'yielded', steps: [{ name: 'ask', state: 'not-run' }] })
    expect(w.state.polls).toEqual([])
  })

  it('拿不到模型：按没做完收，原因记成模型用不了，不计连续出错', async () => {
    const w = world(() => [{ name: 'ask', needsChanges: false, run: async (ctx) => { await ctx.llm() } }])
    await enable(w)
    w.state.resolved = { llm: null, isSelected: false, fellBack: false }
    const r = await runDreams(GLOBAL, auto, w.deps)
    expect(r.kind).toBe('model-unavailable')
    const saved = await rec(w)
    expect(saved.unfinished?.reason).toBe('model-unavailable')
    expect(saved.failure).toBeUndefined()
    expect(new DreamsModelUnavailable().name).toBe('DreamsModelUnavailable')
  })

  it('记结果写不进：结果照常返回，记录停在记开始写的样子，下次按上次没做完处理', async () => {
    const w = world()
    await enable(w)
    vi.spyOn(w.dreams, 'complete').mockRejectedValue(new Error('disk'))
    expect((await runDreams(GLOBAL, auto, w.deps)).kind).toBe('completed')
    expect((await rec(w)).unfinished).toMatchObject({ runId: 'run_1', reason: 'lost' })
    expect(await w.claims.isClaimed('global')).toBe(false)
  })
})

describe('认领被接手、取消', () => {
  it('运行中认领被别的进程接手，对方已开始新的一次：旧的这次不改记录、不写基线', async () => {
    let w!: World
    w = world(() => [{
      name: 'slow', needsChanges: false,
      run: async () => {
        w.state.lose?.()
        await w.dreams.begin(GLOBAL, 'other', T0 + 500)
      },
    }])
    await enable(w)
    const r = await runDreams(GLOBAL, auto, w.deps)
    expect(r.kind).toBe('lost')
    expect((await rec(w)).unfinished).toMatchObject({ runId: 'other' })
    expect((await rec(w)).lastResult).toBeUndefined()
    expect(await w.marks.get('global')).toBeUndefined()
  })

  it('心跳还没发现认领没了，对方已开始新的一次：收尾的写入核对运行 id，什么都不写', async () => {
    let w!: World
    w = world(() => [{ name: 'slow', needsChanges: false, run: async () => { await w.dreams.begin(GLOBAL, 'other', T0 + 500) } }])
    await enable(w)
    expect((await runDreams(GLOBAL, auto, w.deps)).kind).toBe('lost')
    expect((await rec(w)).completed).toBeUndefined()
    expect(await w.marks.get('global')).toBeUndefined()
  })

  it('取消信号（插件卸载）：在下一个检查点停，不写记录，记录停在没做完', async () => {
    const abort = new AbortController()
    const ran: string[] = []
    const w = world(() => [
      { name: 'one', needsChanges: false, run: async () => { ran.push('one'); abort.abort() } },
      { name: 'two', needsChanges: false, run: async () => { ran.push('two') } },
    ])
    await enable(w)
    expect((await runDreams(GLOBAL, { by: 'auto', signal: abort.signal }, w.deps)).kind).toBe('lost')
    expect(ran).toEqual(['one'])
    expect((await rec(w)).unfinished).toMatchObject({ runId: 'run_1', reason: 'lost' })
    expect((await rec(w)).lastResult).toBeUndefined()
  })
})

describe('手动立即运行', () => {
  it('只对开始之后才开始跑的会话让路：开始前就在跑的不让它停下，运行中新开的让它停下', async () => {
    let w!: World
    const ran: string[] = []
    w = world(() => [
      { name: 'one', needsChanges: false, run: async () => { ran.push('one'); w.state.activity.set('/proj/a', running(w.state.now)) } },
      { name: 'two', needsChanges: false, run: async () => { ran.push('two') } },
    ])
    w.state.activity.set('/proj/a', running(T0 - 60_000))
    const r = await runDreams(WS, { by: 'manual', yieldOnlyToNew: true }, w.deps)
    expect(ran).toEqual(['one'])
    expect(r).toMatchObject({ kind: 'yielded', steps: [{ name: 'one', state: 'done' }, { name: 'two', state: 'not-run' }] })
  })

  it('没要求只让新会话时：开始前就在跑的也让路', async () => {
    const w = world()
    w.state.activity.set('/proj/a', running(T0 - 60_000))
    expect((await runDreams(WS, { by: 'manual' }, w.deps)).kind).toBe('yielded')
  })

  it('别的项目的会话不影响这个项目', async () => {
    const w = world()
    w.state.activity.set('/proj/b', running(T0 - 1))
    expect((await runDreams(WS, { by: 'manual' }, w.deps)).kind).toBe('completed')
  })
})

describe('步骤写记忆、调模型', () => {
  const editing = (holder: { w?: World }, extra: (ctx: Parameters<DreamsStep['run']>[0]) => Promise<void> = async () => {}): DreamsStep => ({
    name: 'edit', needsChanges: false,
    run: async (ctx) => {
      const a = (await holder.w!.store.get('mem_a', {}))!
      await ctx.apply([editOp(a, 'o1', '梦境改的')])
      await extra(ctx)
    },
  })

  it('应用变更集：回执记在这次运行的批次条目上，发起方是梦境；做完后条目收尾留在账本里', async () => {
    const holder: { w?: World } = {}
    const w = holder.w = world(() => [editing(holder)])
    await enable(w)
    await seed(w)
    const r = await runDreams(GLOBAL, auto, w.deps)
    expect(r).toMatchObject({ kind: 'completed', entryId: 'run_1' })
    const a = (await w.store.get('mem_a', {}))!
    expect(a.content).toBe('梦境改的')
    expect(a.lastChange?.by).toBe('dreams')
    const entry = (await w.decisions.listSettled()).find(d => d.id === 'run_1')!
    expect(entry.memoryIds).toEqual(['mem_a'])
    expect(entry.receipts).toHaveLength(1)
    expect((await rec(w)).lastResult?.entryId).toBe('run_1')
    // 条目的占用放掉了
    expect(await w.decisions.hold('run_1')).toBeTypeOf('function')
  })

  it('运行中途前台保存了另一条、又改了梦境读过的这一条：前台的两次写入都在，梦境对不上的那个操作跳过', async () => {
    let w!: World
    const outcomes: string[] = []
    w = world(() => [{
      name: 'edit', needsChanges: false,
      run: async (ctx) => {
        const a = (await w.store.get('mem_a', {}))!
        const b = (await w.store.get('mem_b', {}))!
        // 梦境读完之后、动手之前，前台新存了一条，并改了 mem_a
        await w.store.create(record({ id: 'mem_new', content: '前台新存的' }))
        await w.store.updateIfLive({ id: 'mem_a' }, cur => ({ ...cur, content: '前台改的', updatedAt: T0 + 5 }))
        const r = await ctx.apply([editOp(a, 'o1', '梦境改甲'), editOp(b, 'o2', '梦境改乙')])
        outcomes.push(...r.outcomes.map(o => o.kind))
      },
    }])
    await enable(w)
    await seed(w)
    await seed(w, { id: 'mem_b' })
    expect((await runDreams(GLOBAL, auto, w.deps)).kind).toBe('completed')
    expect(outcomes).toEqual(['skipped', 'applied'])
    expect((await w.store.get('mem_a', {}))?.content).toBe('前台改的')
    expect((await w.store.get('mem_new', {}))?.content).toBe('前台新存的')
    expect((await w.store.get('mem_b', {}))?.content).toBe('梦境改乙')
  })

  it('用户上了锁的记忆：梦境的操作跳过，原样留着', async () => {
    let w!: World
    const reasons: unknown[] = []
    w = world(() => [{
      name: 'edit', needsChanges: false,
      run: async (ctx) => {
        const a = (await w.store.get('mem_a', {}))!
        const r = await ctx.apply([editOp(a, 'o1', '梦境改甲')])
        reasons.push(...r.outcomes.map(o => (o.kind === 'skipped' ? o.reason : o.kind)))
      },
    }])
    await enable(w)
    await seed(w, { locked: true })
    const r = await runDreams(GLOBAL, auto, w.deps)
    expect(r.kind).toBe('completed')
    expect(reasons).toEqual(['locked'])
    expect((await w.store.get('mem_a', {}))?.content).toBe('旧正文')
    // 一个操作都没做成：账本里不留条目
    expect(await w.decisions.listSettled()).toEqual([])
  })

  it('两次应用之间这次运行的条目被撤销、移出账本了：后面的不再写，这次按出错收', async () => {
    let w!: World
    w = world(() => [{
      name: 'edit', needsChanges: false,
      run: async (ctx) => {
        await ctx.apply([editOp((await w.store.get('mem_a', {}))!, 'o1', '第一批')])
        await w.decisions.remove(ctx.entryId()!)
        await ctx.apply([editOp((await w.store.get('mem_b', {}))!, 'o2', '第二批')])
      },
    }])
    await enable(w)
    await seed(w)
    await seed(w, { id: 'mem_b' })
    expect((await runDreams(GLOBAL, auto, w.deps)).kind).toBe('failed')
    expect((await w.store.get('mem_b', {}))?.content).toBe('旧正文')
  })

  it('梦境自己写成的记忆记进这次的基线：下次不算内容变了；软删的从基线里拿掉', async () => {
    let w!: World
    const seen: Array<number | 'unknown'> = []
    let isEditing = true
    w = world(() => [{
      name: 'edit', needsChanges: false,
      run: async (ctx) => {
        seen.push(ctx.changes)
        if (!isEditing) return
        const a = (await w.store.get('mem_a', {}))!
        const b = (await w.store.get('mem_b', {}))!
        await ctx.apply([editOp(a, 'o1', '梦境改的'), { id: 'o2', kind: 'forget', memoryId: b.id, scopeKey: scopeKeyOf(b), basis: [basisOf(b)] }])
      },
    }])
    await enable(w)
    const a = await seed(w)
    await seed(w, { id: 'mem_b' })
    await runDreams(GLOBAL, auto, w.deps)
    expect((await w.marks.get('global'))?.marks).toEqual({ mem_a: dreamContentFingerprint({ ...a, content: '梦境改的' }) })
    isEditing = false
    w.state.now += 8 * DAY
    await runDreams(GLOBAL, auto, w.deps)
    expect(seen).toEqual([2, 0])
  })

  it('批次条目收尾没成：这次不记成做完，下次运行先把它收掉', async () => {
    const holder: { w?: World } = {}
    let isEditing = true
    const w = holder.w = world(() => [{
      name: 'edit', needsChanges: false,
      run: async (ctx) => { if (isEditing) await ctx.apply([editOp((await w.store.get('mem_a', {}))!, 'o1', '梦境改的')]) },
    }])
    await enable(w)
    await seed(w)
    vi.spyOn(w.decisions, 'finishChangeRun').mockRejectedValueOnce(new Error('disk'))
    expect((await runDreams(GLOBAL, auto, w.deps)).kind).toBe('failed')
    expect((await rec(w)).unfinished?.entryIds).toEqual(['run_1'])
    expect((await w.decisions.listSettled()).find(d => d.id === 'run_1')?.receipts).toBeUndefined()
    isEditing = false
    w.state.now += 3_600_000
    expect((await runDreams(GLOBAL, auto, w.deps)).kind).toBe('completed')
    expect((await w.decisions.listSettled()).find(d => d.id === 'run_1')?.receipts).toEqual([])
    expect((await rec(w)).unfinished).toBeUndefined()
  })

  it('应用期间占着批次条目：别处这时占不到', async () => {
    const holder: { w?: World } = {}
    let heldDuring: unknown = 'unset'
    const w = holder.w = world(() => [editing(holder)])
    await enable(w)
    await seed(w)
    const append = PendingDecisionsStore.prototype.appendChange
    vi.spyOn(w.decisions, 'appendChange').mockImplementation(async (id, receipt) => {
      heldDuring = await PendingDecisionsStore.prototype.hold.call(w.decisions, id)
      return append.call(w.decisions, id, receipt)
    })
    await runDreams(GLOBAL, auto, w.deps)
    expect(heldDuring).toBeUndefined()
  })

  it('一次应用的操作超过上限：这一步出错', async () => {
    let w!: World
    w = world(() => [{
      name: 'many', needsChanges: false,
      run: async (ctx) => {
        const a = (await w.store.get('mem_a', {}))!
        await ctx.apply(Array.from({ length: 21 }, (_, i) => editOp(a, `o${i}`, `v${i}`)))
      },
    }])
    await enable(w)
    await seed(w)
    expect((await runDreams(GLOBAL, auto, w.deps)).kind).toBe('failed')
    expect((await w.store.get('mem_a', {}))?.content).toBe('旧正文')
  })

  it('模型一次运行只解析一次；退回了别的模型的记进结果', async () => {
    const w = world(() => [
      { name: 'a', needsChanges: false, run: async (ctx) => { await ctx.llm() } },
      { name: 'b', needsChanges: false, run: async (ctx) => { await ctx.llm() } },
    ])
    await enable(w)
    w.state.resolved = { llm: { complete: async () => 'ok' }, isSelected: true, fellBack: true, reason: 'model-gone' as never }
    const r = await runDreams(GLOBAL, auto, w.deps)
    expect(w.state.resolveCalls).toBe(1)
    expect(r.modelFallback).toEqual({ to: 'checkup', reason: 'model-gone' })
    expect((await rec(w)).lastResult?.modelFallback).toEqual({ to: 'checkup', reason: 'model-gone' })
  })

  it('退到默认模型的记成 default', async () => {
    const w = world(() => [{ name: 'a', needsChanges: false, run: async (ctx) => { await ctx.llm() } }])
    await enable(w)
    w.state.resolved = { llm: { complete: async () => 'ok' }, isSelected: false, fellBack: true, reason: 'model-gone' as never }
    expect((await runDreams(GLOBAL, auto, w.deps)).modelFallback).toEqual({ to: 'default', reason: 'model-gone' })
  })

  it('用量每次调用之后立刻记下：步骤随后出错也不漏', async () => {
    const w = world(() => [{ name: 'a', needsChanges: false, run: async (ctx) => { await ctx.addUsage(120); await ctx.addUsage(30); throw new Error('x') } }])
    await enable(w)
    const r = await runDreams(GLOBAL, auto, w.deps)
    expect(r).toMatchObject({ kind: 'failed', usageTokens: 150 })
    expect((await w.dreams.read()).usageRuns).toMatchObject([{ runId: 'run_1', tokens: 150 }])
    expect((await rec(w)).lastResult?.usageTokens).toBe(150)
  })
})

describe('上次没做完的收尾', () => {
  it('进程中途退出（做了一组里的第一步就丢掉运行）：下次运行先把半个组撤掉，上次的批次条目收掉，并交给步骤', async () => {
    const holder: { w?: World; seenPrevious?: readonly string[]; isCrashing: boolean } = { isCrashing: true }
    const w = holder.w = world(() => [{
      name: 'pair', needsChanges: false,
      run: async (ctx) => {
        holder.seenPrevious = ctx.previousEntryIds
        if (!holder.isCrashing) return
        const a = (await w.store.get('mem_a', {}))!
        // 组里只做了第一步，进程就没了：组的标记和这一步的回执留在条目上
        await ctx.apply([editOp(a, 'o1', '半个组', { group: 'g1' })])
        throw new Error('进程没了')
      },
    }])
    await enable(w)
    await seed(w)
    // 模拟进程退出：组没合上，收尾和结果记录都没发生
    vi.spyOn(w.decisions, 'closeGroup').mockResolvedValue(undefined as never)
    vi.spyOn(w.decisions, 'finishChangeRun').mockRejectedValue(new Error('进程没了'))
    vi.spyOn(w.dreams, 'stop').mockResolvedValue(false)
    await runDreams(GLOBAL, auto, w.deps)
    vi.restoreAllMocks()
    expect((await rec(w)).unfinished).toMatchObject({ runId: 'run_1', reason: 'lost', entryIds: ['run_1'] })
    expect((await w.store.get('mem_a', {}))?.content).toBe('半个组')
    expect((await w.decisions.withOpenGroups()).map(e => e.id)).toEqual(['run_1'])

    holder.isCrashing = false
    const r = await runDreams(GLOBAL, auto, w.deps)
    expect(r.kind).toBe('completed')
    expect(holder.seenPrevious).toEqual(['run_1'])
    expect((await w.store.get('mem_a', {}))?.content).toBe('旧正文')
    expect(await w.decisions.withOpenGroups()).toEqual([])
    expect((await w.decisions.listSettled()).find(d => d.id === 'run_1')).toBeUndefined()
    expect((await rec(w)).unfinished).toBeUndefined()
  })

  it('连着两次中断：第一次留下的条目一直带在记录里，收尾成了才拿掉；收尾出错的那次也不丢', async () => {
    const holder: { w?: World } = {}
    const seen: Array<readonly string[]> = []
    let mode: 'edit-then-lose' | 'noop' = 'edit-then-lose'
    const w = holder.w = world(() => [{
      name: 'edit', needsChanges: false,
      run: async (ctx) => {
        seen.push(ctx.previousEntryIds)
        if (mode === 'noop') return
        await ctx.apply([editOp((await w.store.get('mem_a', {}))!, 'o1', '梦境改的')])
        w.state.lose?.()
      },
    }])
    await enable(w)
    await seed(w)
    expect((await runDreams(GLOBAL, auto, w.deps)).kind).toBe('lost')
    mode = 'noop'
    // 第二次：记了开始就没了（收尾没来得及做）
    await w.dreams.begin(GLOBAL, 'restart', T0 + 100)
    expect((await rec(w)).unfinished?.entryIds).toEqual(['run_1', 'restart'])
    // 第三次：收尾时出错
    vi.spyOn(w.decisions, 'withOpenGroups').mockRejectedValueOnce(new Error('EIO'))
    expect((await runDreams(GLOBAL, auto, w.deps)).kind).toBe('failed')
    expect((await rec(w)).unfinished?.entryIds).toEqual(['run_1', 'restart'])
    // 第四次：收成了
    w.state.now += 3_600_000
    expect((await runDreams(GLOBAL, auto, w.deps)).kind).toBe('completed')
    expect(seen.at(-1)).toEqual(['run_1', 'restart'])
    expect((await w.decisions.listSettled()).find(d => d.id === 'run_1')).toMatchObject({ memoryIds: ['mem_a'], receipts: [] })
    expect((await rec(w)).unfinished).toBeUndefined()
  })

  it('账本读不全：上次留下的条目不当成收过了，这次按出错收、引用留着，读得全了再收', async () => {
    const holder: { w?: World } = {}
    let mode: 'edit-then-lose' | 'noop' = 'edit-then-lose'
    const w = holder.w = world(() => [{
      name: 'edit', needsChanges: false,
      run: async (ctx) => {
        if (mode === 'noop') return
        await ctx.apply([editOp((await w.store.get('mem_a', {}))!, 'o1', '梦境改的')])
        w.state.lose?.()
      },
    }])
    await enable(w)
    await seed(w)
    expect((await runDreams(GLOBAL, auto, w.deps)).kind).toBe('lost')
    mode = 'noop'
    // 那条条目这次读不出：列表里没有它，完整性为假
    const held = (await w.pending.get('run_1'))!
    await w.pending.delete('run_1')
    w.pending.isComplete = false
    expect((await runDreams(GLOBAL, auto, w.deps)).kind).toBe('failed')
    expect((await rec(w)).unfinished?.entryIds).toEqual(['run_1'])
    expect((await rec(w)).completed).toBeUndefined()
    // 读得出了
    await w.pending.put('run_1', held)
    w.pending.isComplete = true
    w.state.now += 3_600_000
    expect((await runDreams(GLOBAL, auto, w.deps)).kind).toBe('completed')
    expect((await w.decisions.listSettled()).find(d => d.id === 'run_1')).toMatchObject({ memoryIds: ['mem_a'], receipts: [] })
    expect((await rec(w)).unfinished).toBeUndefined()
  })

  it('基线写了、完成记录没写上：下次变化数按不知道算（要有变化才做的步骤照做）', async () => {
    const seen: Array<number | 'unknown'> = []
    const w = world(() => [{ name: 'tidy', needsChanges: true, run: async (ctx) => { seen.push(ctx.changes) } }])
    await enable(w)
    await seed(w)
    await runDreams(GLOBAL, auto, w.deps)
    // 做完过一次（run_1），随后的一次只写了基线
    await w.marks.put('global', { id: 'global', runId: 'run_x', takenAt: T0, marks: {} })
    w.state.now += 8 * DAY
    const r = await runDreams(GLOBAL, auto, w.deps)
    expect(r.steps).toEqual([{ name: 'tidy', state: 'done' }])
    expect(seen).toEqual([1, 'unknown'])
  })

  it('一层里同一个 id 有几份在用副本：几份的指纹排序后拼在一起', async () => {
    const w = world()
    const a = record({ id: 'mem_a', content: '甲' })
    const b = record({ id: 'mem_a', content: '乙' })
    vi.spyOn(w.store, 'readRaw').mockResolvedValue({ records: [{ record: a }, { record: b }, { record: record({ id: 'mem_c', status: 'deleted' }) }], listedCount: 3, quarantined: [], directoryNotes: [] } as never)
    expect(await readDreamMarks(w.store, GLOBAL)).toEqual({ mem_a: [dreamContentFingerprint(a), dreamContentFingerprint(b)].sort().join('+') })
  })
})
