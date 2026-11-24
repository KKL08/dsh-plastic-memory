import { sidecarSchemas } from './helpers/sidecar-schemas.ts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileTable } from '../src/storage/file-table.ts'
import { SidecarStore } from '../src/storage/sidecar.ts'
import { layerOf, type HistoryVersion } from '../src/storage/history.ts'
import { MemoryStore } from '../src/store.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'
import { PendingDecisionsStore } from '../src/governance/decisions.ts'
import { SnapshotStore } from '../src/governance/snapshots.ts'
import { InMemoryKvTable, InMemoryBatchKvTable } from './helpers/in-memory-kv.ts'
import { InMemoryTable } from './helpers/in-memory-table.ts'
import { runSavePipeline, type PipelineResult, type SaveDelegation } from '../src/pipeline.ts'
import { executeSave, type SaveToolDeps } from '../src/tools/save.ts'
import { anchorsOf, type MemoryRecord, type SourceAnchor } from '../src/record-schema.ts'
import type { MemorySnapshot } from '../src/governance/schema.ts'
import { RETENTION_MS } from '../src/retention.ts'
import { MEMORY_TOOL_NAMES } from '../src/contract-codes.ts'
import { SOURCE_TRAIL_CAP } from '../src/change.ts'
import { UNATTENDED_NOTE, unattendedNote } from '../src/index-line.ts'
import type { AnchorFacts } from '../src/session-log.ts'
import { scopeAt } from '../src/scope.ts'
import { candidate } from './helpers/record.ts'
import { fakeExec } from './helpers/exec.ts'
import { messageFrom, saveHost, turnOpenedBy } from './helpers/session-log.ts'

// 出处锚记下这一轮是谁开的、有哪类证据；不是用户本人开的轮只能按观察或推断写。

const T0 = 1_700_000_000_000
const MINUTE = 60_000
const WS = '/tmp/pm-source-initiator'
const quietLog = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
const registry = buildTypeRegistry({ template: 'coding', customTypes: {} })

/** 用户本人开的一轮，锚范围里有用户的话。 */
const byUser = (startTime: number): AnchorFacts => ({ initiator: 'user', isUserInitiated: true, evidence: { user: true, tool: false }, startTime })
/** 定时任务开的一轮，锚范围里有工具结果。 */
const bySchedule = (startTime: number): AnchorFacts => ({ initiator: 'schedule', isUserInitiated: false, evidence: { user: false, tool: true }, startTime })
/** 宿主给不出发起方。 */
const unknownTurn: AnchorFacts = { isUserInitiated: false }

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'pm-source-initiator-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

function env() {
  const clock = { now: T0 }
  const now = () => clock.now
  const open = () => {
    const sidecar = new SidecarStore({ root, log: quietLog, now, schemas: sidecarSchemas })
    const store = new MemoryStore(new FileTable({ root, stats: sidecar.recallStats, log: quietLog, now }), quietLog, sidecar.recallStats)
    return { store, decisions: new PendingDecisionsStore(sidecar.pending, sidecar.lock), snapshots: new SnapshotStore(sidecar.snapshots) }
  }
  const opened = open()
  let seq = 0
  const save = async (partial: object, turn: AnchorFacts | undefined, opts: { session?: string; delegation?: SaveDelegation } = {}): Promise<PipelineResult> => {
    clock.now += MINUTE
    return runSavePipeline(candidate({ scope: 'workspace', force: true, ...partial }), {
      ...opened, registry, workspacePath: WS,
      session: { id: opts.session ?? 'sess-1', lastSeq: ++seq, turnStartSeq: seq },
      callId: `call-${seq}`, now, turn, delegation: opts.delegation,
    })
  }
  return { ...opened, clock, save, reopen: open }
}
type Env = ReturnType<typeof env>

const update = (e: Env, id: string, partial: object, turn: AnchorFacts | undefined, opts?: Parameters<Env['save']>[2]) =>
  e.save({ action: 'update', id, name: '部署方式', summary: '怎么部署', ...partial }, turn, opts)
function written(r: PipelineResult): MemoryRecord {
  if (r.kind !== 'saved' && r.kind !== 'updated') throw new Error(JSON.stringify(r))
  return r.record
}
async function versionsOf(store: MemoryStore, id: string): Promise<HistoryVersion[]> {
  const found = (await store.locate(id, scopeAt(WS)))!
  return store.history.list(layerOf(found), id)
}
const facts = (anchors: readonly SourceAnchor[]) => anchors.map(a => ({ at: a.at, sourceMode: a.sourceMode, initiator: a.initiator, evidence: a.evidence }))

describe('锚记下发起方和证据类别', () => {
  it('新建加两次补证后出处清单有三个锚，各带时间、来源方式、发起方、证据类别；状态变化后三个锚随历史版本走，当前只剩这次的', async () => {
    const e = env()
    const made = written(await e.save({ name: '部署方式', content: '部署用 Docker Compose', summary: '怎么部署', sourceMode: 'user-explicit' }, byUser(T0 - 5_000)))
    written(await update(e, made.id, { change: 'corroborate', sourceMode: 'environment-observed' }, bySchedule(T0 + 90_000)))
    written(await update(e, made.id, { change: 'corroborate', sourceMode: 'agent-inferred' }, byUser(T0 + 150_000)))

    const three = [
      { at: T0 + 150_000, sourceMode: 'agent-inferred', initiator: 'user', evidence: { user: true, tool: false } },
      { at: T0 + 90_000, sourceMode: 'environment-observed', initiator: 'schedule', evidence: { user: false, tool: true } },
      { at: T0 - 5_000, sourceMode: 'user-explicit', initiator: 'user', evidence: { user: true, tool: false } },
    ]
    expect(facts(anchorsOf((await e.store.get(made.id, scopeAt(WS)))!))).toEqual(three)

    written(await update(e, made.id, { change: 'state-change', content: '部署改用 Kubernetes', sourceMode: 'user-explicit', changeReason: '单机撑不住了' }, byUser(T0 + 400_000)))
    const versions = await versionsOf(e.store, made.id)
    expect(versions).toHaveLength(1)
    expect(facts(anchorsOf(versions[0]!.record))).toEqual(three)
    expect(facts(anchorsOf((await e.store.get(made.id, scopeAt(WS)))!))).toEqual([
      { at: T0 + 400_000, sourceMode: 'user-explicit', initiator: 'user', evidence: { user: true, tool: false } },
    ])
  })

  it('读不到当轮起点的时间时，锚的时间取写入时刻', async () => {
    const e = env()
    const made = written(await e.save({ sourceMode: 'agent-inferred' }, { isUserInitiated: true, initiator: 'user' }))
    expect(made.sourceTrail![0]!.at).toBe(e.clock.now)
    expect(made.sourceTrail![0]).not.toHaveProperty('evidence')
  })
})

describe('出处清单封顶时保住最近一个写下内容的锚', () => {
  it('定时任务新建后连续补证到超过上限：清单仍是上限长、新的在前，末位是那次新建，注入仍带无人值守标注', async () => {
    const e = env()
    const made = written(await e.save({ name: '部署方式', summary: '怎么部署', sourceMode: 'environment-observed' }, bySchedule(T0)))
    for (let i = 1; i <= SOURCE_TRAIL_CAP + 1; i++) {
      written(await update(e, made.id, { change: 'corroborate', sourceMode: 'environment-observed' }, byUser(T0 + i * MINUTE)))
    }
    const current = (await e.store.get(made.id, scopeAt(WS)))!
    const trail = anchorsOf(current)
    expect(trail).toHaveLength(SOURCE_TRAIL_CAP)
    expect(trail.slice(0, -1).every(a => a.change === 'corroborate')).toBe(true)
    expect(trail.slice(0, -1).map(a => a.at)).toEqual(Array.from({ length: SOURCE_TRAIL_CAP - 1 }, (_, i) => T0 + (SOURCE_TRAIL_CAP + 1 - i) * MINUTE))
    expect(trail.at(-1)).toMatchObject({ change: 'create', initiator: 'schedule' })
    expect(unattendedNote(current)).toBe(UNATTENDED_NOTE)
  })

  it('清单里还留着写下内容的锚：照常截掉最旧的', async () => {
    const e = env()
    const made = written(await e.save({ name: '部署方式', summary: '怎么部署', sourceMode: 'environment-observed' }, bySchedule(T0)))
    for (let i = 1; i <= SOURCE_TRAIL_CAP; i++) {
      const change = i === 3 ? { change: 'refine', content: `部署用 Docker Compose 第 ${i} 版` } : { change: 'corroborate' }
      written(await update(e, made.id, { ...change, sourceMode: 'environment-observed' }, bySchedule(T0 + i * MINUTE)))
    }
    const trail = anchorsOf((await e.store.get(made.id, scopeAt(WS)))!)
    expect(trail).toHaveLength(SOURCE_TRAIL_CAP)
    expect(trail.map(a => a.at)).toEqual(Array.from({ length: SOURCE_TRAIL_CAP }, (_, i) => T0 + (SOURCE_TRAIL_CAP - i) * MINUTE))
    expect(trail.some(a => a.change === 'create')).toBe(false)
  })
})

describe('不是用户本人开的轮只能按观察或推断写', () => {
  for (const sourceMode of ['user-explicit', 'user-behavior', 'agent-action-confirmed'] as const) {
    it(`定时任务开的轮里填 ${sourceMode} 退回，什么都没写`, async () => {
      const e = env()
      const r = await e.save({ sourceMode }, bySchedule(T0))
      expect(r).toMatchObject({ kind: 'rejected', code: 'not-user-initiated' })
      if (r.kind === 'rejected') {
        expect(r.reason).toContain('environment-observed')
        expect(r.reason).toContain('agent-inferred')
      }
      expect(await e.store.query({ scope: { kind: 'workspace', workspacePath: WS }, status: ['active'] })).toEqual([])
    })
  }

  it('按观察或推断填照常写下，锚记着定时任务', async () => {
    const e = env()
    for (const sourceMode of ['environment-observed', 'agent-inferred'] as const) {
      const made = written(await e.save({ name: `观察 ${sourceMode}`, sourceMode }, bySchedule(T0)))
      expect(made.sourceTrail![0]).toMatchObject({ initiator: 'schedule', sourceMode })
    }
  })

  it('宿主给不出发起方时按非用户发起处理', async () => {
    const e = env()
    expect(await e.save({ sourceMode: 'user-explicit' }, unknownTurn)).toMatchObject({ kind: 'rejected', code: 'not-user-initiated' })
    const made = written(await e.save({ sourceMode: 'environment-observed' }, unknownTurn))
    expect(made.sourceTrail![0]).not.toHaveProperty('initiator')
  })

  it('改写已有记忆同样受限：定时任务的轮里补证填用户明说退回，记录不动', async () => {
    const e = env()
    const made = written(await e.save({ name: '部署方式', sourceMode: 'user-explicit' }, byUser(T0)))
    const r = await update(e, made.id, { change: 'corroborate', sourceMode: 'user-explicit' }, bySchedule(T0))
    expect(r).toMatchObject({ kind: 'rejected', code: 'not-user-initiated' })
    expect((await e.store.get(made.id, scopeAt(WS)))!.sourceTrail).toHaveLength(1)
  })

  it('用户本人开的轮里填用户明说照常写下', async () => {
    const e = env()
    expect(await e.save({ sourceMode: 'user-explicit' }, byUser(T0))).toMatchObject({ kind: 'saved' })
  })
})

describe('回执清掉之后仍看得出是谁写的', () => {
  it('子 agent 新建、主会话改写，回执过了保留期，重新读出的记录里最近一次内容改动和每个锚都带写入方', async () => {
    const e = env()
    const delegation: SaveDelegation = { depth: 1, parentSessionId: 'sess-1', mode: 'one-shot' }
    const made = written(await e.save({ name: '部署方式', type: 'knowledge', sourceMode: 'environment-observed', force: undefined }, bySchedule(T0), { session: 'child-1', delegation }))
    written(await update(e, made.id, { type: 'knowledge', change: 'refine', content: '部署用 Docker Compose，镜像放内网仓库', sourceMode: 'user-explicit' }, byUser(T0)))
    expect((await e.decisions.listSettled()).length).toBeGreaterThan(0)

    await e.decisions.sweep(e.clock.now + RETENTION_MS + MINUTE)
    expect(await e.decisions.listSettled()).toEqual([])

    const again = (await e.reopen().store.get(made.id, scopeAt(WS)))!
    expect(again.lastChange?.by).toBe('main')
    expect(anchorsOf(again).map(a => a.by)).toEqual(['main', 'subagent'])
  })
})

describe('保存工具从会话日志读出发起方和证据', () => {
  function deps(log: Parameters<typeof saveHost>[1]): SaveToolDeps {
    return {
      store: new MemoryStore(new InMemoryTable(), undefined, new InMemoryBatchKvTable()),
      registry,
      snapshots: new SnapshotStore(new InMemoryKvTable<MemorySnapshot>()),
      host: saveHost({ workspacePath: '/proj', session: { id: 's1', lastSeq: 9, turnStartSeq: 0 } }, log),
      memoryRoot: '/home/u/.dsh/memory',
      homeDir: '/home/u',
    }
  }
  const base = { action: 'create' as const, type: 'knowledge', scope: 'workspace' as const, name: '构建结果', content: '夜间构建通过', summary: '构建', tags: [] }
  const call = (seq: number, callId: string, name: string, args: object) => ({ type: 'tool/call', seq, data: { callId, name, arguments: JSON.stringify(args) } })
  const result = (seq: number, callId: string, text = '输出') => ({ type: 'tool/result', seq, data: { message: { role: 'tool', toolCallId: callId, content: [{ type: 'text', text }] } } })

  it('定时任务开的轮：用户明说退回；按观察写下时锚记着 schedule', async () => {
    const d = deps(turnOpenedBy('schedule'))
    expect(await executeSave({ ...base, sourceMode: 'user-explicit' }, fakeExec(), d)).toMatchObject({ kind: 'rejected', code: 'not-user-initiated' })
    const saved = await executeSave({ ...base, sourceMode: 'environment-observed' }, fakeExec(), d)
    if (saved.kind !== 'saved') throw new Error(JSON.stringify(saved))
    expect(saved.record.sourceTrail![0]).toMatchObject({ initiator: 'schedule', at: 1, evidence: { user: false, tool: false } })
  })

  it('会话日志读不到：按非用户发起处理', async () => {
    expect(await executeSave({ ...base, sourceMode: 'user-explicit' }, fakeExec(), deps(null))).toMatchObject({ kind: 'rejected', code: 'not-user-initiated' })
  })

  it('本插件工具的结果、读记忆根下文件的结果不算工具证据', async () => {
    const log = turnOpenedBy('user', [
      call(2, 'c1', MEMORY_TOOL_NAMES[0]!, { query: '构建' }), result(3, 'c1'),
      call(4, 'c2', 'read', { path: '/home/u/.dsh/memory/global/构建.md' }), result(5, 'c2'),
      call(6, 'c3', 'bash', { command: 'cat ~/.dsh/memory/MEMORY.md' }), result(7, 'c3'),
    ])
    const saved = await executeSave({ ...base, sourceMode: 'user-explicit' }, fakeExec(), deps(log))
    if (saved.kind !== 'saved') throw new Error(JSON.stringify(saved))
    expect(saved.record.sourceTrail![0]!.evidence).toEqual({ user: true, tool: false })
  })

  it('别的工具的结果算工具证据', async () => {
    const log = turnOpenedBy('user', [call(2, 'c1', 'bash', { command: 'pnpm build' }), result(3, 'c1')])
    const saved = await executeSave({ ...base, sourceMode: 'user-explicit' }, fakeExec(), deps(log))
    if (saved.kind !== 'saved') throw new Error(JSON.stringify(saved))
    expect(saved.record.sourceTrail![0]).toMatchObject({ initiator: 'user', evidence: { user: true, tool: true } })
  })

  it.each([
    ['普通 seeded 会话', { isSeeded: true }],
    ['委派的 seeded 会话', { isSeeded: true, delegationDepth: 1, origin: 'subagent' }],
  ])('%s拿不到继承边界：用户明说退回；按观察写下时锚上没有证据', async (_label, header) => {
    const log = { header, inheritedEventCount: undefined, events: [{ type: 'turn/start', seq: 0, time: 1 }, messageFrom('user', 1, '记一下'), call(2, 'c1', 'bash', { command: 'pnpm build' }), result(3, 'c1')] }
    const d = deps(log)
    expect(await executeSave({ ...base, sourceMode: 'user-explicit' }, fakeExec(), d)).toMatchObject({ kind: 'rejected', code: 'not-user-initiated' })
    const saved = await executeSave({ ...base, sourceMode: 'environment-observed' }, fakeExec(), d)
    if (saved.kind !== 'saved') throw new Error(JSON.stringify(saved))
    expect(saved.record.sourceTrail![0]!.evidence).toEqual({ user: false, tool: false })
  })

  it('子 agent 会话里委派来的任务不算用户本人开的轮', async () => {
    const log = { header: { isSeeded: false, delegationDepth: 1, origin: 'subagent' }, inheritedEventCount: 0, events: [{ type: 'turn/start', seq: 0, time: 1 }, messageFrom('user', 1, '查一下构建')] }
    const d = deps(log)
    d.host = saveHost({ workspacePath: '/proj', session: { id: 's1', lastSeq: 9, turnStartSeq: 0 }, delegation: { depth: 1, parentSessionId: 'p', mode: 'one-shot' } }, log)
    const saved = await executeSave({ ...base, sourceMode: 'environment-observed' }, fakeExec(), d)
    if (saved.kind !== 'saved') throw new Error(JSON.stringify(saved))
    expect(saved.record.sourceTrail![0]!.evidence).toEqual({ user: false, tool: false })
  })
})
