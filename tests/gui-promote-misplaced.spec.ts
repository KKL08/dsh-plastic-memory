import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileTable } from '../src/storage/file-table.ts'
import { SidecarStore } from '../src/storage/sidecar.ts'
import { createAgentsMdWriter } from '../src/storage/agents-md.ts'
import { MemoryStore } from '../src/store.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'
import { PendingDecisionsStore } from '../src/governance/decisions.ts'
import { SnapshotStore } from '../src/governance/snapshots.ts'
import { AdviceIgnoreStore, adviceFingerprint } from '../src/governance/advice-ignores.ts'
import { InMemoryKvTable } from '../src/kv-table.ts'
import { CheckupRecordStore } from '../src/governance/checkup-records.ts'
import { AutoCheckupSettingStore } from '../src/governance/auto-checkups.ts'
import { memorySnapshotSchema, pendingDecisionSchema, scanCacheSchema, adviceIgnoreSchema, type AdviceIgnore } from '../src/governance/schema.ts'
import type { SemanticLlm } from '../src/governance/semantic-scan.ts'
import { RETENTION_MS } from '../src/retention.ts'
import { computeDigest } from '../src/storage/frontmatter.ts'
import { ViewWriter, collectGlobalViews } from '../src/gui/view-writer.ts'
import { createMemoryCommand } from '../src/gui/commands.ts'
import {
  GUI_VIEW_DIR, GUI_VIEW_FILES, GUI_VIEW_VERSION, MEMORY_COMMAND_NAME, encodeMemoryCommand, healthViewSchema, memoryCommandResultSchema, pendingViewSchema,
  type MemoryCommand, type MemoryCommandResult,
} from '../src/gui/contract.ts'
import { record } from './helpers/record.ts'

// 提升候选与放错层合并：同一条项目记忆既是提升候选、又被判放错层（项目 → 全局）时，处理视图只出提升卡；
// 「留在本项目」顺带写一条放错层的忽略并记进账本条目，撤销时只删它写的那一条。
// 真实临时目录（FileTable + .state 侧表 + 视图文件），宿主那一侧（借来的会话、模型）换成测试桩。

const NOW = 10 * RETENTION_MS
const WS = '/tmp/pm-promote-misplaced-ws'
const registry = buildTypeRegistry({ template: 'coding', customTypes: {} })
const wsLayer = { kind: 'workspace', workspacePath: WS } as const

/** 模型把 mem_m 判为放错层（该放全局）。 */
const misplacedLlm: SemanticLlm = { complete: async () => JSON.stringify({ findings: [{ type: 'misplaced', memoryIds: ['mem_m'], summary: '对所有项目都适用' }] }) }

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'pm-promote-misplaced-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

function env() {
  const sidecar = new SidecarStore({ root, schemas: { snapshots: memorySnapshotSchema, pending: pendingDecisionSchema, scanCache: scanCacheSchema, adviceIgnores: adviceIgnoreSchema } })
  const clock = { now: NOW }
  const store = new MemoryStore(new FileTable({ root, stats: sidecar.recallStats, now: () => clock.now }), undefined, sidecar.recallStats)
  const decisions = new PendingDecisionsStore(sidecar.pending)
  const snapshots = new SnapshotStore(sidecar.snapshots)
  const ignores = new AdviceIgnoreStore(sidecar.adviceIgnores)
  const cache = sidecar.scanCache
  const checkups = new CheckupRecordStore(sidecar.checkups)
  const autoCheckups = new AutoCheckupSettingStore(sidecar.autoCheckups)
  const views = new ViewWriter({ memoryRoot: root, collect: () => collectGlobalViews({ store, decisions, snapshots, cache, checkups, autoCheckups, ignores, registry, memoryRoot: root, now: () => clock.now }) })
  const command = createMemoryCommand({
    memoryRoot: root, store, decisions, snapshots, cache, checkups, autoCheckups, ignores, registry, views,
    agentsMd: createAgentsMdWriter(join(root, 'AGENTS.md')),
    resolveContext: async () => ({ workspacePath: WS, delegationDepth: 0, session: { id: 'sess-1' } }),
    getLlm: () => misplacedLlm, getBaseline: () => null, now: () => clock.now,
  })
  const run = async (c: MemoryCommand): Promise<MemoryCommandResult> => memoryCommandResultSchema.parse(JSON.parse(
    (await command.handler({ rawInput: encodeMemoryCommand(c).slice(`/${MEMORY_COMMAND_NAME}`.length), agent: {} })).text!,
  ))
  const readView = async (name: keyof typeof GUI_VIEW_FILES) => JSON.parse(await readFile(join(root, GUI_VIEW_DIR, GUI_VIEW_FILES[name]), 'utf8')) as unknown
  const pending = async () => pendingViewSchema.parse(await readView('pending'))
  const wsHealth = async () => healthViewSchema.parse(await readView('health')).layers.find(l => l.layer.kind === 'workspace' && l.layer.workspacePath === WS)!
  /** 照界面的做法忽略 mem_m 的放错层：带上记忆此刻的版本。 */
  const ignoreMisplaced = async () => {
    const r = (await store.get('mem_m'))!
    return run({ cmd: 'ignore-advice', type: 'misplaced', memories: [{ memoryId: 'mem_m', layer: wsLayer, base: { updatedAt: r.updatedAt, digest: computeDigest(r.name, r.summary, r.content) } }] })
  }
  return { store, decisions, ignores, pendingTable: sidecar.pending, clock, run, pending, wsHealth, ignoreMisplaced }
}
type Env = ReturnType<typeof env>

type Ok = Extract<MemoryCommandResult, { ok: true }>
const ok = (r: MemoryCommandResult): Ok => { expect(r.ok, JSON.stringify(r)).toBe(true); return r as Ok }

/** 处理视图里 mem_m 相关的项：提升卡、放错层建议（不看「很久没确认」：夹具记忆的确认时间很早）。 */
const itemsOfM = async (e: Env) => (await e.pending()).items.flatMap(i =>
  i.kind === 'promote-candidate' && i.memory?.id === 'mem_m' ? ['promote-candidate']
    : i.kind === 'advice' && i.type === 'misplaced' && i.memories.some(m => m.id === 'mem_m') ? ['misplaced'] : [])
const misplacedIssue = async (e: Env) => (await e.wsHealth()).issues.find(i => i.type === 'misplaced')
const ignoreOfM = async (e: Env) => (await e.ignores.list()).filter(i => i.type === 'misplaced' && i.memoryIds.includes('mem_m'))
const fingerprintOfM = async (e: Env) => adviceFingerprint((await e.store.get('mem_m'))!)

/** mem_m 是本项目的提升候选，体检又判它放错层：等你决定里挂了它的提升候选条目。 */
async function seedCandidate(e: Env) {
  await e.store.create(record({ id: 'mem_m', name: '己', content: '所有项目都用 vitest', scope: 'workspace', workspacePath: WS, globalCandidate: true }))
  ok(await e.run({ cmd: 'scan' }))
  const [open] = await e.decisions.list()
  expect(open).toMatchObject({ kind: 'promote-candidate', memoryIds: ['mem_m'] })
  return open!
}

describe('提升候选和放错层合并', () => {
  it('同一条项目记忆是提升候选又被判放错层：处理视图只出提升卡，放错层照常扣分；视图形状和版本不变', async () => {
    const e = env()
    await seedCandidate(e)
    expect(await itemsOfM(e)).toEqual(['promote-candidate'])
    expect(await misplacedIssue(e)).toEqual({ type: 'misplaced', count: 1, level: 'advice' })
    expect((await e.pending()).version).toBe(GUI_VIEW_VERSION)
  })

  it('不是提升候选的放错层照常列在可以整理', async () => {
    const e = env()
    await e.store.create(record({ id: 'mem_m', name: '己', scope: 'workspace', workspacePath: WS }))
    ok(await e.run({ cmd: 'scan' }))
    expect(await itemsOfM(e)).toEqual(['misplaced'])
  })
})

describe('「留在本项目」顺带忽略放错层', () => {
  it('留下：写一条放错层的忽略并记进账本条目，可以整理里不出、不再扣分；撤销：删掉那条忽略，提升卡回来、放错层仍并在提升卡里', async () => {
    const e = env()
    const open = await seedCandidate(e)
    const scoreDuringMerge = (await e.wsHealth()).score!

    ok(await e.run({ cmd: 'keep-local', decisionId: open.id }))
    const fingerprint = await fingerprintOfM(e)
    expect(await ignoreOfM(e)).toEqual([{ id: 'misplaced:mem_m', type: 'misplaced', memoryIds: ['mem_m'], fingerprints: [fingerprint], ignoredAt: NOW }])
    const [settled] = await e.decisions.listSettled()
    expect(settled!.settled).toMatchObject({ verdict: 'keep-local', misplacedIgnore: { ignoredAt: NOW, fingerprint } })
    expect(await itemsOfM(e)).toEqual([])
    expect(await misplacedIssue(e)).toBeUndefined()
    expect((await e.wsHealth()).score!).toBeGreaterThan(scoreDuringMerge)

    e.clock.now = NOW + 1000
    ok(await e.run({ cmd: 'undo', decisionId: open.id }))
    expect(await ignoreOfM(e)).toEqual([])
    expect(await itemsOfM(e)).toEqual(['promote-candidate'])
    expect(await misplacedIssue(e)).toEqual({ type: 'misplaced', count: 1, level: 'advice' })
    expect((await e.decisions.list()).map(d => d.id)).toEqual([open.id])
  })

  it('之前用户自己忽略过放错层：留下不另写、账本条目不记；撤销后忽略仍在', async () => {
    const e = env()
    await e.store.create(record({ id: 'mem_m', name: '己', scope: 'workspace', workspacePath: WS }))
    ok(await e.run({ cmd: 'scan' }))
    ok(await e.ignoreMisplaced())
    const before = await ignoreOfM(e)
    // 之后模型把它标成全局候选，下次体检挂进等你决定
    e.clock.now = NOW + 1000
    await e.store.updateIfLive((await e.store.get('mem_m'))!, r => ({ ...r, globalCandidate: true }))
    ok(await e.run({ cmd: 'scan' }))
    const [open] = await e.decisions.list()

    e.clock.now = NOW + 2000
    ok(await e.run({ cmd: 'keep-local', decisionId: open!.id }))
    expect(await ignoreOfM(e)).toEqual(before)
    expect((await e.decisions.listSettled())[0]!.settled).not.toHaveProperty('misplacedIgnore')

    e.clock.now = NOW + 3000
    ok(await e.run({ cmd: 'undo', decisionId: open!.id }))
    expect(await ignoreOfM(e)).toEqual(before)
    expect(await itemsOfM(e)).toEqual(['promote-candidate'])
  })

  it('撤销前用户又重新忽略过：撤销不删', async () => {
    const e = env()
    const open = await seedCandidate(e)
    ok(await e.run({ cmd: 'keep-local', decisionId: open.id }))
    e.clock.now = NOW + 1000
    ok(await e.run({ cmd: 'unignore-advice', type: 'misplaced', memoryIds: ['mem_m'] }))
    e.clock.now = NOW + 2000
    ok(await e.ignoreMisplaced())
    const reignored = await ignoreOfM(e)
    expect(reignored.map(i => i.ignoredAt)).toEqual([NOW + 2000])

    e.clock.now = NOW + 3000
    ok(await e.run({ cmd: 'undo', decisionId: open.id }))
    expect(await ignoreOfM(e)).toEqual(reignored)
    expect(await itemsOfM(e)).toEqual(['promote-candidate'])
  })

  it('留下之后用户取消了那条忽略：撤销照常成功，什么都不删', async () => {
    const e = env()
    const open = await seedCandidate(e)
    ok(await e.run({ cmd: 'keep-local', decisionId: open.id }))
    ok(await e.run({ cmd: 'unignore-advice', type: 'misplaced', memoryIds: ['mem_m'] }))
    expect(await itemsOfM(e)).toEqual(['misplaced'])
    ok(await e.run({ cmd: 'undo', decisionId: open.id }))
    expect(await ignoreOfM(e)).toEqual([])
    expect(await itemsOfM(e)).toEqual(['promote-candidate'])
  })

  it('旧的忽略记录指纹已对不上（内容改过）：算作还没忽略，留下时按此刻的记忆重写一条', async () => {
    const e = env()
    const open = await seedCandidate(e)
    await e.ignores.ignore('misplaced', [{ ...(await e.store.get('mem_m'))!, content: '改之前的内容' }], NOW - 1000)
    ok(await e.run({ cmd: 'keep-local', decisionId: open.id }))
    const fingerprint = await fingerprintOfM(e)
    expect((await ignoreOfM(e)).map(i => [i.fingerprints, i.ignoredAt])).toEqual([[[fingerprint], NOW]])
    expect((await e.decisions.listSettled())[0]!.settled).toMatchObject({ misplacedIgnore: { ignoredAt: NOW, fingerprint } })
  })

  it('记忆内容改了：指纹对不上，下次体检放错层重新出现在可以整理', async () => {
    const e = env()
    const open = await seedCandidate(e)
    ok(await e.run({ cmd: 'keep-local', decisionId: open.id }))
    expect(await itemsOfM(e)).toEqual([])

    e.clock.now = NOW + 1000
    await e.store.update((await e.store.get('mem_m'))!, r => ({ ...r, content: '所有项目都用 vitest 和 playwright' }))
    ok(await e.run({ cmd: 'scan' }))
    expect(await itemsOfM(e)).toEqual(['misplaced'])
    expect(await misplacedIssue(e)).toEqual({ type: 'misplaced', count: 1, level: 'advice' })
  })
})

describe('按 id 的 keep-local-memory（对话卡、右侧栏）', () => {
  it('等你决定里已有它的提升候选：同样顺带忽略、记进结清的那一条；撤销时删掉，提升卡回来', async () => {
    const e = env()
    const open = await seedCandidate(e)
    const body = ok(await e.run({ cmd: 'keep-local-memory', memoryId: 'mem_m', layer: wsLayer }))
    expect(body.decisionId).toBe(open.id)
    const fingerprint = await fingerprintOfM(e)
    expect((await ignoreOfM(e)).map(i => [i.fingerprints, i.ignoredAt])).toEqual([[[fingerprint], NOW]])
    expect((await e.decisions.listSettled())[0]!.settled).toMatchObject({ verdict: 'keep-local', misplacedIgnore: { ignoredAt: NOW, fingerprint } })
    expect(await itemsOfM(e)).toEqual([])

    ok(await e.run({ cmd: 'undo', decisionId: open.id }))
    expect(await ignoreOfM(e)).toEqual([])
    expect(await itemsOfM(e)).toEqual(['promote-candidate'])
  })

  it('账本里还没有条目（就地新记、生来结清）：同样顺带忽略；撤销时条目移出账本、忽略删掉', async () => {
    const e = env()
    // 体检时还不是候选：放错层已在可以整理里，账本没有它的提升候选
    await e.store.create(record({ id: 'mem_m', name: '己', scope: 'workspace', workspacePath: WS }))
    ok(await e.run({ cmd: 'scan' }))
    await e.store.updateIfLive((await e.store.get('mem_m'))!, r => ({ ...r, globalCandidate: true }))
    expect(await e.decisions.list()).toEqual([])

    const body = ok(await e.run({ cmd: 'keep-local-memory', memoryId: 'mem_m', layer: wsLayer }))
    const [settled] = await e.decisions.listSettled()
    expect(settled!.settled).toMatchObject({ verdict: 'keep-local', isBornSettled: true, misplacedIgnore: { ignoredAt: NOW, fingerprint: await fingerprintOfM(e) } })
    expect(await ignoreOfM(e)).toHaveLength(1)
    expect(await itemsOfM(e)).toEqual([])

    ok(await e.run({ cmd: 'undo', decisionId: body.decisionId! }))
    expect([...await e.decisions.list(), ...await e.decisions.listSettled()]).toEqual([])
    expect(await ignoreOfM(e)).toEqual([])
    expect(await itemsOfM(e)).toEqual(['misplaced'])
  })
})

describe('账本兼容', () => {
  it('旧的 keep-local 条目没有 misplacedIgnore：撤销不碰忽略表', async () => {
    const e = env()
    const open = await seedCandidate(e)
    ok(await e.run({ cmd: 'keep-local', decisionId: open.id }))
    // 模拟旧版本写下的条目：结清记录里没有这个字段
    const [entry] = await e.decisions.listSettled()
    const { misplacedIgnore: _dropped, ...oldSettled } = entry!.settled!
    await e.pendingTable.put(entry!.id, { ...entry!, settled: oldSettled })
    const before = await ignoreOfM(e)

    ok(await e.run({ cmd: 'undo', decisionId: open.id }))
    expect(await ignoreOfM(e)).toEqual(before)
  })
})

describe('留下时顺带写忽略：不吞掉用户自己的忽略', () => {
  const m = record({ id: 'mem_m', scope: 'workspace', workspacePath: WS })

  it('已有一条指纹对得上的用户忽略：不覆盖，返回没写', async () => {
    const ignores = new AdviceIgnoreStore(new InMemoryKvTable<AdviceIgnore>())
    const mine = await ignores.ignore('misplaced', [m], NOW)
    expect(await ignores.ignoreIfAbsent('misplaced', [m], NOW + 1)).toBeUndefined()
    expect(await ignores.list()).toEqual([mine])
  })

  it('读到「没有」之后、写之前用户刚忽略了同一项：用户那条留着', async () => {
    const ignores = new AdviceIgnoreStore(new InMemoryKvTable<AdviceIgnore>())
    const [, mine] = await Promise.all([
      ignores.ignoreIfAbsent('misplaced', [m], NOW),
      ignores.ignore('misplaced', [m], NOW + 1),
    ])
    expect(await ignores.list()).toEqual([mine])
  })
})
