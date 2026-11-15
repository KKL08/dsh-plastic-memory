import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileTable } from '../src/storage/file-table.ts'
import { SidecarStore } from '../src/storage/sidecar.ts'
import { createAgentsMdWriter } from '../src/storage/agents-md.ts'
import { MemoryStore } from '../src/store.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'
import { PendingDecisionsStore } from '../src/governance/decisions.ts'
import { SnapshotStore } from '../src/governance/snapshots.ts'
import { AdviceIgnoreStore } from '../src/governance/advice-ignores.ts'
import { CheckupRecordStore } from '../src/governance/checkup-records.ts'
import { AutoCheckupSettingStore } from '../src/governance/auto-checkups.ts'
import { memorySnapshotSchema, pendingDecisionSchema, scanCacheSchema, adviceIgnoreSchema } from '../src/governance/schema.ts'
import { RETENTION_MS } from '../src/retention.ts'
import { ViewWriter, collectCheckupView, collectGlobalViews } from '../src/gui/view-writer.ts'
import { createMemoryCommand } from '../src/gui/commands.ts'
import { AutoCheckupScheduler } from '../src/gui/auto-checkup.ts'
import { MEMORY_COMMAND_NAME, encodeMemoryCommand, memoryCommandResultSchema, type MemoryCommand } from '../src/gui/contract.ts'
import { executeConfirm } from '../src/tools/confirm.ts'
import { record } from './helpers/record.ts'
import { noInstructions } from './helpers/instructions.ts'
import { depthLock, unlockedModel } from './helpers/depth-lock.ts'

// RL-12 持锁时不等模型：写锁换成记录持锁深度的替身，模型换成假的、被调用时记下此刻的深度。
// 其余是接线层同款的真实组件、真实临时目录。每条路径都断言：确实进过锁（maxDepth ≥ 1），模型每次被调用时深度为 0。

const NOW = 10 * RETENTION_MS
const SESSION_WS = '/tmp/pm-lock-depth-session'
const registry = buildTypeRegistry({ template: 'coding', customTypes: {} })
const quietLog = { info() {}, warn() {}, error() {} }

let root: string
let schedulers: AutoCheckupScheduler[] = []
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'pm-lock-depth-')) })
afterEach(async () => {
  for (const s of schedulers.splice(0)) await s.dispose()
  await rm(root, { recursive: true, force: true })
})

function env(answer?: (input: { system: string; user: string }) => string) {
  const lock = depthLock()
  const model = unlockedModel(lock, answer)
  const now = () => NOW
  const sidecar = new SidecarStore({
    root, lock, log: quietLog, now,
    schemas: { snapshots: memorySnapshotSchema, pending: pendingDecisionSchema, scanCache: scanCacheSchema, adviceIgnores: adviceIgnoreSchema },
  })
  const store = new MemoryStore(new FileTable({ root, lock, stats: sidecar.recallStats, now, log: quietLog }), quietLog, sidecar.recallStats)
  const decisions = new PendingDecisionsStore(sidecar.pending, lock)
  const snapshots = new SnapshotStore(sidecar.snapshots)
  const cache = sidecar.scanCache
  const ignores = new AdviceIgnoreStore(sidecar.adviceIgnores)
  const checkups = new CheckupRecordStore(sidecar.checkups)
  const autoCheckups = new AutoCheckupSettingStore(sidecar.autoCheckups)
  const views = new ViewWriter({
    memoryRoot: root, log: quietLog, now, sleep: async () => {},
    collect: () => collectGlobalViews({ store, decisions, snapshots, cache, ignores, checkups, autoCheckups, registry, memoryRoot: root, now }),
    collectCheckups: () => collectCheckupView({ store, checkups, autoCheckups, cache, now }),
  })
  const command = createMemoryCommand({
    memoryRoot: root, store, decisions, snapshots, cache, checkups, autoCheckups, ignores, registry, views,
    agentsMd: createAgentsMdWriter(join(root, 'AGENTS.md')), instructions: noInstructions, log: quietLog,
    host: { contextOf: async () => ({ workspacePath: SESSION_WS, delegationDepth: 0, session: { id: 'sess-1' } }), llmOf: () => model.llm },
    now,
  })
  const run = async (c: MemoryCommand) => {
    const r = await command.handler({ rawInput: encodeMemoryCommand(c).slice(`/${MEMORY_COMMAND_NAME}`.length), agent: {} })
    const body = memoryCommandResultSchema.parse(JSON.parse(r.text!))
    expect(body.ok, JSON.stringify(body)).toBe(true)
    return body
  }
  const scheduler = () => {
    const s = new AutoCheckupScheduler({
      scan: { store, registry, decisions, cache, ignores, instructions: noInstructions },
      checkups, views, status: () => collectCheckupView({ store, checkups, autoCheckups, cache, now }),
      host: { defaultLlm: () => model.llm }, isGovernanceEnabled: () => true,
      timer: { timeout: () => () => {}, interval: () => () => {} },
      now, log: quietLog,
    })
    schedulers.push(s)
    return s
  }
  return { lock, model, store, decisions, snapshots, autoCheckups, checkups, run, scheduler }
}
type Env = ReturnType<typeof env>

async function seedPair(e: Env) {
  await e.store.create(record({ id: 'mem_a', name: '甲', content: '用 pnpm' }))
  await e.store.create(record({ id: 'mem_b', name: '乙', content: '用 npm' }))
  return (await e.decisions.upsert({ memoryIds: ['mem_a', 'mem_b'], summary: '包管理器矛盾', fingerprint: 'fp-ab' }, 1)).entry
}

async function seedCandidate(e: Env) {
  await e.store.create(record({ id: 'mem_c', name: '候选', scope: 'workspace', workspacePath: SESSION_WS, globalCandidate: true }))
  return (await e.decisions.upsert({ kind: 'promote-candidate', memoryIds: ['mem_c'], summary: '候选', workspaces: [SESSION_WS], fingerprint: 'fp-c' }, 1)).entry
}

/** 走过锁、模型调用（有的话）全在锁外。 */
function expectModelOutsideLock(e: Env) {
  expect(e.lock.maxDepth).toBeGreaterThanOrEqual(1)
  expect(e.model.depths.every(d => d === 0), `模型被调用时的持锁深度：${e.model.depths.join(',')}`).toBe(true)
  expect(e.lock.depth).toBe(0)
}

describe('RL-12 持锁时不等模型', () => {
  it('RL-12 提升：认领段在锁内，不调模型', async () => {
    const e = env()
    const entry = await seedCandidate(e)
    await e.run({ cmd: 'promote', decisionId: entry.id, target: 'global' })
    expect((await e.store.get('mem_c'))!.scope).toBe('global')
    expectModelOutsideLock(e)
  })

  it('RL-12 留在本项目：认领段在锁内，不调模型', async () => {
    const e = env()
    const entry = await seedCandidate(e)
    await e.run({ cmd: 'keep-local', decisionId: entry.id })
    expect((await e.decisions.listSettled()).map(d => d.settled?.verdict)).toEqual(['keep-local'])
    expectModelOutsideLock(e)
  })

  it('RL-12 忽略超限：认领段在锁内，不调模型', async () => {
    const e = env()
    const { entry } = await e.decisions.upsert({ kind: 'overflow', memoryIds: [], summary: '超出上限', fingerprint: '1' }, 1)
    await e.run({ cmd: 'dismiss-overflow', decisionId: entry.id })
    expect((await e.decisions.listSettled()).map(d => d.settled?.verdict)).toEqual(['dismiss'])
    expectModelOutsideLock(e)
  })

  it('RL-12 撤销：认领段在锁内，不调模型', async () => {
    const e = env()
    const entry = await seedPair(e)
    await e.run({ cmd: 'resolve', decisionId: entry.id, verdict: 'keep-left' })
    await e.run({ cmd: 'undo', decisionId: entry.id })
    expect((await e.store.get('mem_b'))!.status).toBe('active')
    expectModelOutsideLock(e)
  })

  it('RL-12 确认工具裁决：认领段在锁内，不调模型', async () => {
    const e = env()
    const entry = await seedPair(e)
    const r = await executeConfirm(
      { action: 'resolve', decisionId: entry.id, verdict: 'keep-left' }, { workspacePath: SESSION_WS },
      { store: e.store, decisions: e.decisions, snapshots: e.snapshots, instructions: noInstructions, now: () => NOW, log: quietLog },
    )
    expect(r.kind).toBe('resolved')
    expect((await e.store.get('mem_b'))!.status).toBe('deleted')
    expectModelOutsideLock(e)
  })

  it('RL-12 draft-edit：生成草稿时不持锁', async () => {
    const e = env(() => JSON.stringify({ content: '1. 跑测试\n2. 打包', summary: '发版两步' }))
    await e.store.create(record({ id: 'mem_l', name: '发版流程', scope: 'workspace', workspacePath: SESSION_WS, content: `发版流程：${'先跑测试再打包，'.repeat(20)}`, summary: '发版步骤' }))
    await e.run({ cmd: 'draft-edit', adviceType: 'bloat', memories: [{ memoryId: 'mem_l', layer: { kind: 'workspace', workspacePath: SESSION_WS } }] } as MemoryCommand)
    expect(e.model.depths).toHaveLength(1)
    expectModelOutsideLock(e)
  })

  it('RL-12 手动体检：模型调用期间不持锁，写盘各自进锁', async () => {
    const e = env()
    await seedPair(e)
    await e.run({ cmd: 'scan', layer: { kind: 'global' } })
    expect(e.model.depths.length).toBeGreaterThanOrEqual(1)
    expect(await e.checkups.list()).toHaveLength(1)
    expectModelOutsideLock(e)
  })

  it('RL-12 自动体检：模型调用期间不持锁，写盘各自进锁', async () => {
    const e = env()
    await seedPair(e)
    await e.autoCheckups.set({ kind: 'global' }, 1)
    const s = e.scheduler()
    await s.recheck()
    await s.whenIdle()
    expect(e.model.depths.length).toBeGreaterThanOrEqual(1)
    expect((await e.checkups.list()).map(r => r.completed?.by)).toEqual(['auto'])
    expectModelOutsideLock(e)
  })
})
