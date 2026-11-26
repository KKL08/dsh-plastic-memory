import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { Config } from '../src/index.ts'
import { PendingDecisionsStore, type PendingTable } from '../src/governance/decisions.ts'
import { SnapshotStore } from '../src/governance/snapshots.ts'
import { AdviceIgnoreStore } from '../src/governance/advice-ignores.ts'
import { basisOf, scopeKeyOf, type ChangeOp } from '../src/governance/changeset.ts'
import { versionPlan } from '../src/governance/changeset-plans.ts'
import { DREAMS_DEFAULTS } from '../src/governance/dreams-gate.ts'
import { DreamsStore } from '../src/governance/dreams-records.ts'
import type { AdviceIgnore, MemorySnapshot, PendingDecision } from '../src/governance/schema.ts'
import type { DreamMarks, DreamsRecord } from '../src/storage/schema.ts'
import { SidecarStore } from '../src/storage/sidecar.ts'
import { workspaceDirName } from '../src/storage/paths.ts'
import { runSavePipeline, type PipelineResult } from '../src/pipeline.ts'
import { applyChangeset } from '../src/tools/changeset.ts'
import { runDreams, type DreamsRunDeps } from '../src/tools/dreams-run.ts'
import { executeConfirm } from '../src/tools/confirm.ts'
import { executeUndo } from '../src/tools/undo.ts'
import { dropRelatedRechecks, relatedRecheckHook, RELATED_RECHECK_CHANGE_TEXT, RELATED_RECHECK_VIA } from '../src/tools/related-recheck.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'
import { premiseDigest } from '../src/links.ts'
import { ledgerLabel, type Scope } from '../src/scope.ts'
import type { MemoryRecord } from '../src/record-schema.ts'
import { checkupEnv, type CheckupEnv } from './helpers/checkup-env.ts'
import { InMemoryKvTable } from './helpers/in-memory-kv.ts'
import { noInstructions } from './helpers/instructions.ts'
import { candidate, record } from './helpers/record.ts'
import { FAKE_SECRET } from './helpers/secrets.ts'
import { loadRelease020Schemas, openRelease020Pending } from './helpers/release-020.ts'
import { sidecarSchemas } from './helpers/sidecar-schemas.ts'

// 沿关联发复查信号（实验）：状态页做了状态变化或纠错，related 里挂着它的决定进待决账本，标「依据已变」，不改决定。
// 记忆是临时目录里真的文件，账本在内存里；各入口走真实的保存管线、变更集执行器、记忆梦境的一次运行。

const P1 = '/work/one'
const P2 = '/work/two'
const GLOBAL: Scope = { kind: 'global' }
const WS1: Scope = { kind: 'workspace', workspacePath: P1 }
const MINUTE = 60_000
const registry = buildTypeRegistry({ template: 'office', customTypes: {} })
const quiet = { info() {}, warn() {}, error() {}, debug() {} }

const envs: CheckupEnv[] = []
const roots: string[] = []
afterEach(async () => {
  for (const e of envs.splice(0)) await e.close()
  for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true })
})

/** 测试环境：记忆文件、账本、快照；钩子接在 decisions 上，开关和 warn 由测试控制。hookDecisions 给了时钩子写它（写失败的用例用）。 */
async function env(opts: { hookDecisions?: PendingDecisionsStore } = {}) {
  const e = await checkupEnv()
  envs.push(e)
  const flag = { on: true }
  const warns: string[] = []
  const log = { info() {}, warn: (...args: unknown[]) => { warns.push(args.map(String).join(' ')) }, error() {} }
  const hook = relatedRecheckHook({ decisions: opts.hookDecisions ?? e.decisions, isEnabled: () => flag.on, log })
  const snapshots = new SnapshotStore(new InMemoryKvTable<MemorySnapshot>())
  const ignores = new AdviceIgnoreStore(new InMemoryKvTable<AdviceIgnore>())
  let seq = 0
  const now = () => e.clock.now
  /** 走保存管线（memory_save 的执行器）；每次调用时钟往前一分钟。 */
  const save = async (partial: object, workspacePath: string | undefined = P1): Promise<PipelineResult> => {
    e.clock.now += MINUTE
    return runSavePipeline(candidate({ scope: 'workspace', force: true, sourceMode: 'agent-inferred', ...partial }), {
      store: e.store, registry, workspacePath, session: { id: 'sess-1', lastSeq: ++seq, turnStartSeq: seq },
      snapshots, decisions: e.decisions, callId: `call-${seq}`, now, relatedRecheck: hook,
    })
  }
  /** 对一条项目记忆声明改动性质的 memory_save update。 */
  const update = (page: MemoryRecord, content: string, change?: string) =>
    save({ action: 'update', id: page.id, type: page.type, name: page.name, summary: page.summary, content, ...(change !== undefined ? { change } : {}) }, page.workspacePath)
  /** 走变更集执行器：一个改正文的操作，by 是界面。 */
  const edit = async (page: MemoryRecord, content: string, change?: 'refine' | 'correct' | 'state-change') => {
    e.clock.now += MINUTE
    const runId = `pd_run_${++seq}`
    await e.decisions.addChangeRun(runId, { kind: 'edit', summary: '测试', workspaces: [ledgerLabel(scopeOf(page))], memoryIds: [] }, 'batch-edited', now())
    return applyChangeset([editOp(page, `o${seq}`, content, change)], { entryId: runId, by: 'gui', at: now(), isSecretChecked: false },
      { store: e.store, snapshots, decisions: e.decisions, relatedRecheck: hook })
  }
  const confirmDeps = { store: e.store, decisions: e.decisions, snapshots, instructions: noInstructions, now }
  return {
    e, flag, warns, hook, snapshots, save, update, edit,
    dismiss: (decisionId: string) => executeConfirm({ action: 'resolve', decisionId, verdict: 'dismiss' }, { workspacePath: P1 }, confirmDeps),
    undo: (decisionId: string) => executeUndo({ decisionId }, { workspacePath: P1 }, { ...confirmDeps, ignores }),
    /** 账本里沿关联发的、还没结清的条目。 */
    signals: async () => (await e.decisions.list()).filter(d => d.kind === 'premise-changed' && d.via === RELATED_RECHECK_VIA),
    get: (id: string, scope: Scope = WS1) => e.store.get(id, scope),
  }
}
type Env = Awaited<ReturnType<typeof env>>

const scopeOf = (r: MemoryRecord): Scope => (r.scope === 'global' ? GLOBAL : { kind: 'workspace', workspacePath: r.workspacePath! })
const editOp = (read: MemoryRecord, id: string, content: string, change?: 'refine' | 'correct' | 'state-change'): ChangeOp =>
  ({ id, memoryId: read.id, scopeKey: scopeKeyOf(read), basis: [basisOf(read)], kind: 'edit', patch: { content }, expect: { content: read.content }, ...(change !== undefined ? { change } : {}) })
const inWs = (workspacePath: string, partial: Partial<MemoryRecord>) => record({ scope: 'workspace', workspacePath, ...partial })

/** 状态页（项目 P1）和挂在它上面的决定。 */
const page = (partial: Partial<MemoryRecord> = {}) => inWs(P1, { id: 'mem_p', type: 'project', name: '归档容量', summary: '归档区多大', content: '归档区容量 10 单位', ...partial })
const decision = (partial: Partial<MemoryRecord> = {}) => inWs(P1, { id: 'mem_d', type: 'decision', name: '暂停归档', summary: '先不归档', content: '容量不够，暂停新增归档', related: ['mem_p'], ...partial })

async function seed(t: Env, ...records: MemoryRecord[]): Promise<void> {
  for (const r of records) await t.e.store.put(r)
}
function updated(r: PipelineResult): MemoryRecord {
  expect(r.kind, JSON.stringify(r)).toBe('updated')
  return (r as Extract<PipelineResult, { kind: 'updated' }>).record
}

describe('触发入口', () => {
  it('memory_save 声明状态变化：挂在状态页上的决定进待处理，种类依据已变、带 via related、账本记在决定所在的项目，决定本身不动', async () => {
    const t = await env()
    await seed(t, page(), decision())
    const before = await t.get('mem_d')
    updated(await t.update(page(), '归档区容量扩到 1000 单位', 'state-change'))
    const signals = await t.signals()
    expect(signals).toHaveLength(1)
    expect(signals[0]).toMatchObject({ kind: 'premise-changed', via: RELATED_RECHECK_VIA, memoryIds: ['mem_d', 'mem_p'], workspaces: [P1, P1] })
    expect(signals[0]!.summary).toContain('暂停归档')
    expect(signals[0]!.summary).toContain('归档容量')
    expect(signals[0]!.summary).toContain(RELATED_RECHECK_CHANGE_TEXT['state-change'])
    expect(signals[0]!.summary).not.toContain('mem_')
    expect(await t.get('mem_d')).toEqual(before)
  })

  it('memory_save 声明纠错：同样发，说明里用纠错的说法', async () => {
    const t = await env()
    await seed(t, page(), decision())
    updated(await t.update(page(), '归档区容量其实一直是 12 单位', 'correct'))
    const signals = await t.signals()
    expect(signals.map(d => d.memoryIds)).toEqual([['mem_d', 'mem_p']])
    expect(signals[0]!.summary).toContain(RELATED_RECHECK_CHANGE_TEXT.correct)
  })

  it('细化、补证、只挂关联的保存都不发；同一张状态页随后的状态变化照发', async () => {
    const t = await env()
    await seed(t, page(), decision(), inWs(P1, { id: 'mem_x', type: 'knowledge', name: '别的事' }))
    updated(await t.update(page(), '归档区容量 10 单位，按块计', 'refine'))
    updated(await t.save({ action: 'update', id: 'mem_p', change: 'corroborate', sourceMode: 'user-explicit' }))
    updated(await t.save({ action: 'update', id: 'mem_p', name: undefined, type: undefined, scope: undefined, content: undefined, summary: undefined, tags: undefined, force: undefined, related: ['mem_x'] }))
    expect(await t.e.decisions.list()).toEqual([])
    updated(await t.update(page(), '归档区容量扩到 1000 单位', 'state-change'))
    expect((await t.signals()).map(d => d.memoryIds)).toEqual([['mem_d', 'mem_p']])
  })

  it('变更集里改正文的操作声明状态变化、纠错时发，没声明（按细化）的不发', async () => {
    const t = await env()
    const pages = ['mem_p1', 'mem_p2', 'mem_p3'].map(id => page({ id, name: `状态页${id.slice(-1)}` }))
    const decisions = pages.map((p, i) => decision({ id: `mem_d${i + 1}`, name: `决定${i + 1}`, related: [p.id] }))
    await seed(t, ...pages, ...decisions)
    const outcomes = [
      await t.edit((await t.get('mem_p1'))!, '新状态', 'state-change'),
      await t.edit((await t.get('mem_p2'))!, '更正后的内容', 'correct'),
      await t.edit((await t.get('mem_p3'))!, '补了细节'),
    ]
    expect(outcomes.map(r => r.outcomes.map(o => o.kind))).toEqual([['applied'], ['applied'], ['applied']])
    expect((await t.signals()).map(d => d.memoryIds).sort()).toEqual([['mem_d1', 'mem_p1'], ['mem_d2', 'mem_p2']])
  })

  it('记忆梦境直接处理的改正文操作声明状态变化时同样发', async () => {
    const t = await env()
    await seed(t, page(), decision())
    const dreams = new DreamsStore(new InMemoryKvTable<DreamsRecord>(), new InMemoryKvTable<DreamMarks>())
    await dreams.setEnabled('all', true)
    const claims = new InMemoryKvTable<{ id: string }>()
    const applied: string[][] = []
    let runSeq = 0
    const deps: DreamsRunDeps = {
      store: t.e.store, snapshots: t.snapshots, decisions: t.e.decisions, dreams, log: quiet, relatedRecheck: t.hook,
      claimScope: async (scope) => {
        const release = await claims.claim(scope.kind === 'global' ? 'global' : scope.workspacePath)
        return release === undefined ? { busy: scope } : { release }
      },
      activity: async () => ({ isComplete: true, workspaces: new Map() }),
      resolveLlm: async () => ({ llm: { complete: async () => 'ok' }, isSelected: true, fellBack: false }),
      config: () => ({ ...DREAMS_DEFAULTS, minChanges: 0, maxChangeRatio: 1 }),
      isGovernanceEnabled: () => true,
      plan: [{
        name: 'tidy', needsChanges: false,
        run: async (ctx) => {
          const r = await ctx.apply([editOp((await t.get('mem_p'))!, 'o1', '归档区容量扩到 1000 单位', 'state-change')])
          applied.push(r.outcomes.map(o => o.kind))
        },
      }],
      interval: () => () => {},
      now: () => t.e.clock.now++,
      newRunId: () => `run_${++runSeq}`,
    }
    expect((await runDreams(WS1, { by: 'manual' }, deps)).kind).toBe('completed')
    expect(applied).toEqual([['applied']])
    expect((await t.signals()).map(d => d.memoryIds)).toEqual([['mem_d', 'mem_p']])
  })

  it('并成版本不发：旧状态那条软删、当前页不写；当前页之后的状态变化照发', async () => {
    const t = await env()
    await seed(t, page(), decision(), page({ id: 'mem_o', name: '旧的归档容量', content: '归档区容量 5 单位' }))
    const runId = 'pd_version'
    await t.e.decisions.addChangeRun(runId, { kind: 'edit', summary: '并成版本', workspaces: [P1], memoryIds: [] }, 'batch-edited', t.e.clock.now)
    const r = await applyChangeset(versionPlan({ id: 'v1', current: (await t.get('mem_p'))!, old: (await t.get('mem_o'))! }),
      { entryId: runId, by: 'gui', at: t.e.clock.now, isSecretChecked: false }, { store: t.e.store, snapshots: t.snapshots, decisions: t.e.decisions, relatedRecheck: t.hook })
    expect(r.outcomes.map(o => o.kind)).toEqual(['applied'])
    expect((await t.get('mem_o'))?.status).toBe('deleted')
    expect(await t.signals()).toEqual([])
    await t.edit((await t.get('mem_p'))!, '归档区容量扩到 1000 单位', 'state-change')
    expect((await t.signals()).map(d => d.memoryIds)).toEqual([['mem_d', 'mem_p']])
  })

  it('撤销那次状态变化之后，已发出的信号留着，用户自己忽略', async () => {
    const t = await env()
    await seed(t, page(), decision())
    updated(await t.update(page(), '归档区容量扩到 1000 单位', 'state-change'))
    const [signal] = await t.signals()
    expect(signal).toBeDefined()
    const rewrite = (await t.e.decisions.listSettled()).find(d => d.kind === 'rewrite' && d.memoryIds.includes('mem_p'))
    expect(rewrite).toBeDefined()
    expect((await t.undo(rewrite!.id)).kind).toBe('undone')
    expect((await t.get('mem_p'))?.content).toBe('归档区容量 10 单位')
    expect((await t.signals()).map(d => d.id)).toEqual([signal!.id])
  })
})

describe('判定', () => {
  it('只发给自己 related 里列着这张状态页、在用的决定：状态页反过来列的、别的类型、已删除的都不发', async () => {
    const t = await env()
    await seed(t,
      page({ related: ['mem_back'] }),
      decision(),
      decision({ id: 'mem_back', name: '反向挂的决定', related: [] }),
      inWs(P1, { id: 'mem_k', type: 'knowledge', name: '查明的事实', related: ['mem_p'] }),
      decision({ id: 'mem_gone', name: '删掉的决定', status: 'deleted' }),
    )
    updated(await t.update(page({ related: ['mem_back'] }), '归档区容量扩到 1000 单位', 'state-change'))
    expect((await t.signals()).map(d => d.memoryIds)).toEqual([['mem_d', 'mem_p']])
  })

  it('决定的前提里已经有这张状态页：沿关联不发，体检按前提判出一条，同一对只有一张卡', async () => {
    const t = await env()
    const p = page()
    await seed(t, p,
      decision({ premises: [{ id: 'mem_p', digest: premiseDigest(p) }] }),
      decision({ id: 'mem_e', name: '只挂关联的决定' }),
    )
    updated(await t.update(p, '归档区容量扩到 1000 单位', 'state-change'))
    // 前提：钩子确实跑了，只挂关联的那条决定收到了
    expect((await t.signals()).map(d => d.memoryIds)).toEqual([['mem_e', 'mem_p']])
    await t.e.scan({ llm: null, layers: 'rule', target: { kind: 'scope', scope: WS1 } })
    const forPair = (await t.e.decisions.list()).filter(d => d.kind === 'premise-changed' && [...d.memoryIds].sort().join('+') === 'mem_d+mem_p')
    expect(forPair).toHaveLength(1)
    expect(forPair[0]!.via).toBeUndefined()
  })

  it('同一次写入再报一次不多挂；状态页又做了一次状态变化，未结清的那条沿用、不多出一张', async () => {
    const t = await env()
    await seed(t, page(), decision())
    const written = updated(await t.update(page(), '归档区容量扩到 1000 单位', 'state-change'))
    const [first] = await t.signals()
    await t.hook(written, t.e.store)
    expect((await t.signals()).map(d => d.id)).toEqual([first!.id])
    updated(await t.update(written, '归档区容量又扩到 2000 单位', 'state-change'))
    expect((await t.signals()).map(d => d.id)).toEqual([first!.id])
  })

  it('用户忽略之后：同一次写入不再挂；状态页再做一次状态变化照发', async () => {
    const t = await env()
    await seed(t, page(), decision())
    const written = updated(await t.update(page(), '归档区容量扩到 1000 单位', 'state-change'))
    const [signal] = await t.signals()
    expect(await t.dismiss(signal!.id)).toMatchObject({ kind: 'resolved' })
    expect(await t.signals()).toEqual([])
    await t.hook(written, t.e.store)
    expect(await t.signals()).toEqual([])
    updated(await t.update(written, '归档区容量又缩回 20 单位', 'state-change'))
    expect((await t.signals()).map(d => d.memoryIds)).toEqual([['mem_d', 'mem_p']])
  })

  it('状态页最近一次内容改动的性质认不出（手改成别的值）：按细化，不发', async () => {
    const t = await env()
    await seed(t, decision())
    const odd = page({ lastChange: { kind: 'future-kind', at: 5, op: 'op_hand', by: 'main' } })
    await t.hook(odd, t.e.store)
    expect(await t.e.decisions.list()).toEqual([])
    // 前提：同一张页声明成状态变化时钩子确实发
    await t.hook({ ...odd, lastChange: { kind: 'state-change', at: 5, op: 'op_hand', by: 'main' } }, t.e.store)
    expect((await t.signals()).map(d => d.memoryIds)).toEqual([['mem_d', 'mem_p']])
  })

  it('说明里的名称先遮密钥：名称里的疑似密钥不进账本', async () => {
    const t = await env()
    await seed(t, decision({ name: `用 ${FAKE_SECRET.sk} 的决定` }))
    await t.hook(page({ name: `密钥 ${FAKE_SECRET.sk} 的状态页`, lastChange: { kind: 'state-change', at: 5, op: 'op_1', by: 'main' } }), t.e.store)
    const [signal] = await t.signals()
    expect(signal).toBeDefined()
    expect(signal!.summary).not.toContain(FAKE_SECRET.sk)
  })
})

describe('作用域', () => {
  it('全局状态页：全局决定和各项目的决定各挂一条，账本按决定所在的作用域记', async () => {
    const t = await env()
    const gPage = record({ id: 'mem_g', type: 'project', name: '全局约定', content: '旧约定' })
    await seed(t, gPage,
      record({ id: 'mem_dg', type: 'decision', name: '全局决定', related: ['mem_g'] }),
      inWs(P1, { id: 'mem_d1', type: 'decision', name: '项目一的决定', related: ['mem_g'] }),
      inWs(P2, { id: 'mem_d2', type: 'decision', name: '项目二的决定', related: ['mem_g'] }),
    )
    await t.edit((await t.get('mem_g', GLOBAL))!, '新约定', 'state-change')
    const byDecision = Object.fromEntries((await t.signals()).map(d => [d.memoryIds[0], d.workspaces]))
    expect(byDecision).toEqual({ mem_dg: ['global', 'global'], mem_d1: [P1, 'global'], mem_d2: [P2, 'global'] })
  })

  it('项目状态页只看本项目：别的项目、全局里手改挂上来的决定不发', async () => {
    const t = await env()
    await seed(t, page(), decision(),
      inWs(P2, { id: 'mem_other', type: 'decision', name: '别的项目的决定', related: ['mem_p'] }),
      record({ id: 'mem_global', type: 'decision', name: '全局决定', related: ['mem_p'] }),
    )
    updated(await t.update(page(), '归档区容量扩到 1000 单位', 'state-change'))
    expect((await t.signals()).map(d => d.memoryIds)).toEqual([['mem_d', 'mem_p']])
  })

  it('同一个 id 的决定在两个项目各有一份、都挂着全局状态页：只挂一条，记在排在前面的那个项目', async () => {
    const t = await env()
    await seed(t, record({ id: 'mem_g', type: 'project', name: '全局约定', content: '旧约定' }),
      inWs(P2, { id: 'mem_d', type: 'decision', name: '决定（项目二）', related: ['mem_g'] }),
      inWs(P1, { id: 'mem_d', type: 'decision', name: '决定（项目一）', related: ['mem_g'] }),
    )
    await t.edit((await t.get('mem_g', GLOBAL))!, '新约定', 'state-change')
    const signals = await t.signals()
    expect(signals.map(d => [d.memoryIds, d.workspaces])).toEqual([[['mem_d', 'mem_g'], [P1, 'global']]])
  })
})

describe('失败与开关', () => {
  it('反向链接查不全：一条都不发，只记一条 warn；查得全之后照发', async () => {
    const t = await env()
    await seed(t, page(), decision())
    const broken = join(t.e.memoryRoot, workspaceDirName(P1), 'broken.md')
    await writeFile(broken, '---\nid: [没闭合\n---\n半截文件', 'utf8')
    updated(await t.update(page(), '归档区容量扩到 1000 单位', 'state-change'))
    expect(await t.signals()).toEqual([])
    expect(t.warns).toHaveLength(1)
    await unlink(broken)
    updated(await t.update((await t.get('mem_p'))!, '归档区容量又扩到 2000 单位', 'state-change'))
    expect((await t.signals()).map(d => d.memoryIds)).toEqual([['mem_d', 'mem_p']])
    expect(t.warns).toHaveLength(1)
  })

  it('写账本失败：保存照常成功、内容落盘，只记一条 warn', async () => {
    const table = new InMemoryKvTable<PendingDecision>()
    let attempts = 0
    const failing: PendingTable = Object.assign(Object.create(table) as PendingTable, {
      put: async () => { attempts++; throw new Error('账本写不进去') },
    })
    const t = await env({ hookDecisions: new PendingDecisionsStore(failing) })
    await seed(t, page(), decision())
    const written = updated(await t.update(page(), '归档区容量扩到 1000 单位', 'state-change'))
    expect(written.content).toBe('归档区容量扩到 1000 单位')
    expect((await t.get('mem_p'))?.content).toBe('归档区容量扩到 1000 单位')
    expect(attempts).toBeGreaterThan(0)
    expect(t.warns).toHaveLength(1)
  })

  it('开关关着：保存和变更集都不发；打开之后下一次状态变化照发', async () => {
    const t = await env()
    await seed(t, page(), decision(), page({ id: 'mem_p2', name: '另一张页' }), decision({ id: 'mem_d2', name: '另一个决定', related: ['mem_p2'] }))
    t.flag.on = false
    updated(await t.update(page(), '归档区容量扩到 1000 单位', 'state-change'))
    expect((await t.edit((await t.get('mem_p2'))!, '更正', 'correct')).outcomes.map(o => o.kind)).toEqual(['applied'])
    expect(await t.e.decisions.list()).toEqual([])
    t.flag.on = true
    updated(await t.update((await t.get('mem_p'))!, '归档区容量又扩到 2000 单位', 'state-change'))
    expect((await t.signals()).map(d => d.memoryIds)).toEqual([['mem_d', 'mem_p']])
  })

  it('开关关着时写的状态变化，之后打开、再体检也不补发', async () => {
    const t = await env()
    await seed(t, page(), decision())
    t.flag.on = false
    updated(await t.update(page(), '归档区容量扩到 1000 单位', 'state-change'))
    t.flag.on = true
    t.e.deps.isRelatedRecheckEnabled = () => true
    await t.e.scan({ llm: null, layers: 'rule', target: { kind: 'scope', scope: WS1 } })
    expect(await t.e.decisions.list()).toEqual([])
  })
})

describe('开关关掉之后的体检', () => {
  const entry = (id: string, partial: Partial<PendingDecision> = {}): PendingDecision =>
    ({ id, kind: 'premise-changed', memoryIds: ['mem_d', 'mem_p'], summary: '依据变了', firstSeenAt: 1, workspaces: [P1, P1], fingerprint: `fp-${id}`, ...partial })
  async function seeded() {
    const t = await env()
    await seed(t, page(), decision())
    await t.e.pending.put('pd_open', entry('pd_open', { via: RELATED_RECHECK_VIA }))
    await t.e.pending.put('pd_done', entry('pd_done', { via: RELATED_RECHECK_VIA, memoryIds: ['mem_d', 'mem_q'], settled: { verdict: 'dismiss', at: 2 } }))
    await t.e.pending.put('pd_premise', entry('pd_premise', { memoryIds: ['mem_e', 'mem_p'] }))
    await t.e.pending.put('pd_future', entry('pd_future', { via: 'future-source', memoryIds: ['mem_f', 'mem_p'] }))
    // 前提：四条都在账本里，三条未结清
    expect((await t.e.decisions.list()).map(d => d.id).sort()).toEqual(['pd_future', 'pd_open', 'pd_premise'])
    return t
  }

  it('删掉沿关联发的未结清条目；已结清的、按前提判的、via 是别的取值的都留着；之后再打开照发', async () => {
    const t = await seeded()
    t.e.deps.isRelatedRecheckEnabled = () => false
    await t.e.scan({ llm: null, layers: 'rule', target: { kind: 'scope', scope: WS1 } })
    expect((await t.e.decisions.list()).map(d => d.id).sort()).toEqual(['pd_future', 'pd_premise'])
    expect((await t.e.decisions.listSettled()).map(d => d.id)).toEqual(['pd_done'])
    t.e.deps.isRelatedRecheckEnabled = () => true
    updated(await t.update(page(), '归档区容量扩到 1000 单位', 'state-change'))
    expect((await t.signals()).map(d => d.memoryIds)).toEqual([['mem_d', 'mem_p']])
  })

  it('开关开着、或体检没拿到开关时都不清', async () => {
    const t = await seeded()
    t.e.deps.isRelatedRecheckEnabled = () => true
    await t.e.scan({ llm: null, layers: 'rule', target: { kind: 'scope', scope: WS1 } })
    delete t.e.deps.isRelatedRecheckEnabled
    t.e.clock.now += MINUTE
    await t.e.scan({ llm: null, layers: 'rule', target: { kind: 'scope', scope: WS1 } })
    expect((await t.e.decisions.list()).map(d => d.id).sort()).toEqual(['pd_future', 'pd_open', 'pd_premise'])
  })

  it('直接调清理：只删沿关联发的未结清条目', async () => {
    const t = await seeded()
    await dropRelatedRechecks(t.e.decisions)
    expect((await t.e.decisions.list()).map(d => d.id).sort()).toEqual(['pd_future', 'pd_premise'])
    expect((await t.e.decisions.listSettled()).map(d => d.id)).toEqual(['pd_done'])
  })
})

describe('版本共存', () => {
  it('上一个发布版读到沿关联发的条目：整条跳过、记日志、不删；新版照读，via 还在', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pm-related-recheck-compat-'))
    roots.push(root)
    const decisions = new PendingDecisionsStore(new SidecarStore({ root, schemas: sidecarSchemas, log: quiet }).pending)
    const t = await env({ hookDecisions: decisions })
    await seed(t, decision())
    await t.hook(page({ lastChange: { kind: 'state-change', at: 5, op: 'op_1', by: 'main' } }), t.e.store)
    const [signal] = (await decisions.list()).filter(d => d.via === RELATED_RECHECK_VIA)
    expect(signal).toMatchObject({ kind: 'premise-changed', memoryIds: ['mem_d', 'mem_p'] })
    expect((await loadRelease020Schemas()).pendingDecision.safeParse(signal).success).toBe(false)
    const warnings: string[] = []
    const old = await openRelease020Pending({ root, warnings })
    expect(await old.list()).toEqual([])
    expect(warnings).toHaveLength(1)
    expect((await decisions.list()).map(d => [d.id, d.via])).toEqual([[signal!.id, RELATED_RECHECK_VIA]])
  })
})

describe('实验开关与说明', () => {
  it('配置键 governance.relatedRecheck：缺省关，配置文件可改，用时现读', () => {
    expect(new Config({} as never).governance.relatedRecheck.get()).toBe(false)
    expect(new Config(parse('governance:\n  relatedRecheck: true\n') as never).governance.relatedRecheck.get()).toBe(true)
    expect(() => new Config({ governance: { relatedRecheck: 'yes' } } as never)).toThrow()
  })

  it('条目说明里两种改动的说法非空、互不相同', () => {
    const texts = Object.values(RELATED_RECHECK_CHANGE_TEXT)
    expect(Object.keys(RELATED_RECHECK_CHANGE_TEXT).sort()).toEqual(['correct', 'state-change'])
    expect(texts.every(s => s.trim() !== '')).toBe(true)
    expect(new Set(texts).size).toBe(texts.length)
  })

  it('配置参考里列了这个实验开关、缺省值和它做什么', async () => {
    const guide = await readFile(new URL('../guide/configuration.md', import.meta.url), 'utf8')
    const row = guide.split('\n').find(line => line.includes('`governance.relatedRecheck`'))
    expect(row).toBeDefined()
    expect(row).toContain('`false`')
    expect(row).toContain('实验')
  })
})
