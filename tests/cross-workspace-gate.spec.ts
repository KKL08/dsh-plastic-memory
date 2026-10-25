import { afterEach, describe, expect, it } from 'vitest'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateJsonSchemaValue, type JsonSchemaNode, type ToolDefinition } from '@deepseek-ai/dsh-tools'

import { createForgetTool } from '../src/tools/forget-tool.ts'
import { createConfirmTool } from '../src/tools/confirm-tool.ts'
import { createPromoteTool } from '../src/tools/promote-tool.ts'
import { createSnapshotTool } from '../src/tools/snapshot-tool.ts'
import { createSaveTool } from '../src/tools/save-tool.ts'
import { createSourceTool } from '../src/tools/source-tool.ts'
import { executeForget } from '../src/tools/forget.ts'
import { executeConfirm } from '../src/tools/confirm.ts'
import { executePromote } from '../src/tools/promote.ts'
import { executeSnapshotTool } from '../src/tools/snapshot.ts'
import { executeSave } from '../src/tools/save.ts'
import { executeSource } from '../src/tools/source.ts'
import { executeScan, renderScanResult } from '../src/tools/scan.ts'
import { executeHealth, renderHealthResult } from '../src/tools/health.ts'
import { MemoryStore, InMemoryTable } from '../src/store.ts'
import { FileTable } from '../src/storage/file-table.ts'
import { ARCHIVE_DIR, workspaceDirName } from '../src/storage/paths.ts'
import { PendingDecisionsStore } from '../src/governance/decisions.ts'
import { SnapshotStore } from '../src/governance/snapshots.ts'
import { resolveHealthThresholds } from '../src/governance/health-presets.ts'
import { pendingDecisionSchema, type MemorySnapshot, type PendingDecision, type ScanCacheEntry } from '../src/governance/schema.ts'
import { InMemoryKvTable } from '../src/kv-table.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'
import type { GovernanceRejectCode, RejectCode } from '../src/contract-codes.ts'
import type { RecallStats } from '../src/storage/schema.ts'
import type { MemoryLogger } from "../src/storage/table.ts"
import type { MemoryRecord } from '../src/record-schema.ts'
import { record } from './helpers/record.ts'
import { fakeExec } from './helpers/exec.ts'

// 票 14（S2）：治理动作只有在用户明确选择「全局整理」后才能跨项目。
// 场景统一为：会话在项目 A，B 是另一个项目；global 记忆对任何会话都可见。

const A = '/home/dev/proj-a'
const B = '/home/dev/proj-b'
const CROSS: GovernanceRejectCode = 'cross-workspace'
const SAVE_CROSS: RejectCode = 'cross-workspace'
const IN_A = { workspacePath: A as string | undefined }
const registry = buildTypeRegistry({ template: 'coding', customTypes: {} })
const exec = fakeExec()
const schemaOf = (tool: ToolDefinition): JsonSchemaNode => tool.parameters as unknown as JsonSchemaNode

const inA = (id: string, partial: Partial<MemoryRecord> = {}) => record({ id, scope: 'workspace', workspacePath: A, ...partial })
const inB = (id: string, partial: Partial<MemoryRecord> = {}) => record({ id, scope: 'workspace', workspacePath: B, ...partial })
const glob = (id: string, partial: Partial<MemoryRecord> = {}) => record({ id, scope: 'global', ...partial })

function world() {
  const store = new MemoryStore(new InMemoryTable())
  const snapshots = new SnapshotStore(new InMemoryKvTable<MemorySnapshot>())
  const decisions = new PendingDecisionsStore(new InMemoryKvTable<PendingDecision>())
  const agentsMd = { lines: [] as string[], append: async function (line: string) { this.lines.push(line) } }
  const now = () => 5000
  const resolveContext = async () => ({ workspacePath: A as string | undefined })
  return {
    store, snapshots, decisions, agentsMd,
    deps: { store, snapshots, decisions, agentsMd, now },
    resolveContext,
    seed: async (...records: MemoryRecord[]) => { for (const r of records) await store.put(r) },
  }
}

describe('forget / confirm refresh / confirm resolve / promote / snapshot create（指定 id）/ show / restore 新增布尔参数 allowCrossWorkspace，缺省 false；工具说明写明只有用户明确选了全局整理才传', () => {
  const w = world()
  const tools: Array<[string, ToolDefinition, Record<string, unknown>]> = [
    ['memory_forget', createForgetTool({ ...w.deps, resolveContext: w.resolveContext }), { ids: ['mem_x'], reason: '过期' }],
    ['memory_confirm', createConfirmTool({ ...w.deps, resolveContext: w.resolveContext }), { action: 'refresh', memoryId: 'mem_x' }],
    ['memory_promote', createPromoteTool({ ...w.deps, agentsMd: w.agentsMd, defaultTarget: 'global', resolveContext: w.resolveContext }), { ids: ['mem_x'] }],
    ['memory_snapshot', createSnapshotTool({ ...w.deps, resolveContext: w.resolveContext }), { action: 'restore', snapshotId: 'snap_x' }],
  ]

  for (const [name, tool, legal] of tools) {
    it(`${name}：allowCrossWorkspace 是可选布尔参数，说明写明只有用户明确选了全局整理才传`, () => {
      const schema = schemaOf(tool) as { properties: Record<string, { type: string; description?: string }>; required?: string[] }
      expect(schema.properties.allowCrossWorkspace.type).toBe('boolean')
      expect(schema.properties.allowCrossWorkspace.description).toContain('全局整理')
      expect(schema.required ?? []).not.toContain('allowCrossWorkspace')
      expect(validateJsonSchemaValue(schemaOf(tool), legal)).toEqual([])
      expect(validateJsonSchemaValue(schemaOf(tool), { ...legal, allowCrossWorkspace: true })).toEqual([])
      expect(validateJsonSchemaValue(schemaOf(tool), { ...legal, allowCrossWorkspace: 'yes' }).length).toBeGreaterThan(0)
    })
  }

  it('缺省即 false：不传参数时跨项目目标被拒，与显式 false 同效', async () => {
    const w2 = world()
    await w2.seed(inB('mem_b1'), inB('mem_b2'))
    const omitted = await executeForget({ ids: ['mem_b1'], reason: '清理' }, IN_A, w2.deps)
    const explicit = await executeForget({ ids: ['mem_b2'], reason: '清理', allowCrossWorkspace: false }, IN_A, w2.deps)
    expect(omitted.rejected.map(r => r.code)).toEqual([CROSS])
    expect(explicit.rejected.map(r => r.code)).toEqual([CROSS])
    expect((await w2.store.get('mem_b1'))!.status).toBe('active')
    expect((await w2.store.get('mem_b2'))!.status).toBe('active')
  })
})

describe('不带参数：目标不在可见集合（global + 当前 workspace）→ cross-workspace 拒绝，消息含所属 workspace 路径；批量操作里单独列出，不影响同批可见记录', () => {
  it('forget：B 的记录被拒并报 B 路径，同批 A 与 global 照常遗忘', async () => {
    const w = world()
    await w.seed(inA('mem_a'), inB('mem_b'), glob('mem_g'))
    const r = await executeForget({ ids: ['mem_a', 'mem_b', 'mem_g'], reason: '清理' }, IN_A, w.deps)
    expect(r.ok).toBe(true)
    expect(r.forgotten.sort()).toEqual(['mem_a', 'mem_g'])
    expect(r.rejected).toEqual([{ id: 'mem_b', code: CROSS, workspacePath: B }])
    expect(r.missing).toEqual([])
    expect(r.message).toContain(B)
    expect((await w.store.get('mem_b'))!.status).toBe('active')
    expect((await w.snapshots.list())[0].memoryIds.sort()).toEqual(['mem_a', 'mem_g'])
  })

  it('forget：全部目标都在其他项目时 ok=false、不拍快照', async () => {
    const w = world()
    await w.seed(inB('mem_b'))
    const r = await executeForget({ ids: ['mem_b'], reason: '清理' }, IN_A, w.deps)
    expect(r.ok).toBe(false)
    expect(r.rejected).toEqual([{ id: 'mem_b', code: CROSS, workspacePath: B }])
    expect(r.message).toContain(B)
    expect(await w.snapshots.list()).toHaveLength(0)
  })

  it('无工作目录的会话：可见集合只有 global，任何 workspace 记录都被拒', async () => {
    const w = world()
    await w.seed(inA('mem_a'), glob('mem_g'))
    const r = await executeForget({ ids: ['mem_a', 'mem_g'], reason: '清理' }, { workspacePath: undefined }, w.deps)
    expect(r.forgotten).toEqual(['mem_g'])
    expect(r.rejected).toEqual([{ id: 'mem_a', code: CROSS, workspacePath: A }])
  })

  it('confirm refresh：B 的记录被拒（code + B 路径），新鲜度不动', async () => {
    const w = world()
    await w.seed(inB('mem_b', { lastConfirmedAt: 1 }))
    const r = await executeConfirm({ action: 'refresh', memoryId: 'mem_b' }, IN_A, w.deps)
    expect(r).toMatchObject({ kind: 'error', code: CROSS })
    expect(r.message).toContain(B)
    expect((await w.store.get('mem_b'))!.lastConfirmedAt).toBe(1)
  })

  it('promote：B 的候选被拒并报 B 路径，同批 A 的候选照常提升', async () => {
    const w = world()
    await w.seed(inA('mem_a', { globalCandidate: true }), inB('mem_b', { globalCandidate: true }))
    const r = await executePromote({ confirmedIds: ['mem_a', 'mem_b'], target: 'global' }, IN_A, w.deps)
    expect(r.promoted).toEqual([{ id: 'mem_a', target: 'global' }])
    expect(r.rejected).toEqual([{ id: 'mem_b', code: CROSS, workspacePath: B }])
    expect(r.message).toContain(B)
    expect((await w.store.get('mem_b'))!.scope).toBe('workspace')
    expect((await w.snapshots.list())[0].memoryIds).toEqual(['mem_a'])
  })

  it('promote dismiss：B 的候选标记不动', async () => {
    const w = world()
    await w.seed(inA('mem_a', { globalCandidate: true }), inB('mem_b', { globalCandidate: true }))
    const r = await executePromote({ confirmedIds: ['mem_a', 'mem_b'], target: 'global', dismiss: true }, IN_A, w.deps)
    expect(r.dismissed).toEqual(['mem_a'])
    expect(r.rejected).toEqual([{ id: 'mem_b', code: CROSS, workspacePath: B }])
    expect((await w.store.get('mem_b'))!.globalCandidate).toBe(true)
  })

  it('snapshot create（指定 id）：B 的 id 不进快照、单独列出', async () => {
    const w = world()
    await w.seed(inA('mem_a'), inB('mem_b'))
    const r = await executeSnapshotTool({ action: 'create', memoryIds: ['mem_a', 'mem_b'] }, IN_A, w.deps)
    if (r.kind !== 'created') throw new Error(r.kind)
    expect(r.count).toBe(1)
    expect(r.rejected).toEqual([{ id: 'mem_b', code: CROSS, workspacePath: B }])
    expect(r.message).toContain(B)
    expect((await w.snapshots.get(r.snapshotId))!.memoryIds).toEqual(['mem_a'])
  })

  it('snapshot create（不给 id）：只拍 global 与当前项目，B 的记录不进快照，show 也看不到；allowCrossWorkspace 只对指定 id 生效', async () => {
    const w = world()
    await w.seed(inA('mem_a'), glob('mem_g'), inB('mem_b', { summary: 'B 的内容' }))
    for (const allowCrossWorkspace of [undefined, true]) {
      const r = await executeSnapshotTool({ action: 'create', allowCrossWorkspace }, IN_A, w.deps)
      if (r.kind !== 'created') throw new Error(r.kind)
      expect(r.count).toBe(2)
      expect((await w.snapshots.get(r.snapshotId))!.memoryIds.sort()).toEqual(['mem_a', 'mem_g'])
      const shown = await executeSnapshotTool({ action: 'show', snapshotId: r.snapshotId, allowCrossWorkspace }, IN_A, w.deps)
      if (shown.kind !== 'shown') throw new Error(shown.kind)
      expect(shown.entries.map(e => e.id).sort()).toEqual(['mem_a', 'mem_g'])
      expect(shown.message).not.toContain('B 的内容')
    }
    // 项目 B 的会话照样只拍 B 与 global
    const inB_ = await executeSnapshotTool({ action: 'create' }, { workspacePath: B }, w.deps)
    if (inB_.kind !== 'created') throw new Error(inB_.kind)
    expect((await w.snapshots.get(inB_.snapshotId))!.memoryIds.sort()).toEqual(['mem_b', 'mem_g'])
  })

  it('snapshot show / restore：快照里 B 的记录不展示、不恢复，同快照 A 的记录照常', async () => {
    const w = world()
    const a = inA('mem_a', { summary: 'A 的旧内容' })
    const b = inB('mem_b', { summary: 'B 的旧内容' })
    const snap = await w.snapshots.capture({ operation: 'manual', description: '混合快照', records: [a, b] }, 4000)

    const shown = await executeSnapshotTool({ action: 'show', snapshotId: snap.id }, IN_A, w.deps)
    if (shown.kind !== 'shown') throw new Error(shown.kind)
    expect(shown.entries.map(e => e.id)).toEqual(['mem_a'])
    expect(shown.rejected).toEqual([{ id: 'mem_b', code: CROSS, workspacePath: B }])
    expect(shown.message).toContain(B)
    expect(shown.message).not.toContain('B 的旧内容')

    const restored = await executeSnapshotTool({ action: 'restore', snapshotId: snap.id }, IN_A, w.deps)
    if (restored.kind !== 'restored') throw new Error(restored.kind)
    expect(restored.restored).toEqual(['mem_a'])
    expect(restored.rejected).toEqual([{ id: 'mem_b', code: CROSS, workspacePath: B }])
    expect(restored.message).toContain(B)
    expect(await w.store.get('mem_b')).toBeUndefined()
    expect((await w.store.get('mem_a'))!.summary).toBe('A 的旧内容')
  })

  it('snapshot restore（指定 memoryIds 只含 B）：拒绝，什么都不写', async () => {
    const w = world()
    const snap = await w.snapshots.capture({ operation: 'manual', description: 'B', records: [inB('mem_b')] }, 4000)
    const r = await executeSnapshotTool({ action: 'restore', snapshotId: snap.id, memoryIds: ['mem_b'] }, IN_A, w.deps)
    if (r.kind !== 'restored') throw new Error(r.kind)
    expect(r.restored).toEqual([])
    expect(r.rejected).toEqual([{ id: 'mem_b', code: CROSS, workspacePath: B }])
    expect(await w.store.get('mem_b')).toBeUndefined()
  })
})

describe('带参数：放行，结构化结果与渲染文本对非可见集合的记录标出 workspace 路径', () => {
  it('forget：B 的记录被遗忘，otherWorkspaces 与消息标出 B，可见记录不标', async () => {
    const w = world()
    await w.seed(inA('mem_a'), inB('mem_b'))
    const r = await executeForget({ ids: ['mem_a', 'mem_b'], reason: '全局整理', allowCrossWorkspace: true }, IN_A, w.deps)
    expect(r.forgotten.sort()).toEqual(['mem_a', 'mem_b'])
    expect(r.rejected).toEqual([])
    expect(r.otherWorkspaces).toEqual([{ id: 'mem_b', workspacePath: B }])
    expect(r.message).toContain(B)
    expect((await w.store.get('mem_b'))!.status).toBe('deleted')
  })

  it('forget 绑定层：参数透传到执行器，渲染文本标出 B', async () => {
    const w = world()
    await w.seed(inB('mem_b'))
    const tool = createForgetTool({ ...w.deps, resolveContext: w.resolveContext })
    const args = { ids: ['mem_b'], reason: '全局整理', allowCrossWorkspace: true }
    const result = await tool.execute(args, exec)
    const text = (tool.output.render(args as never, result as never) as Array<{ text: string }>)[0].text
    expect(text).toContain(B)
    expect((await w.store.get('mem_b'))!.status).toBe('deleted')
  })

  it('confirm refresh：放行并在结果与消息里标出 B', async () => {
    const w = world()
    await w.seed(inB('mem_b', { lastConfirmedAt: 1 }))
    const r = await executeConfirm({ action: 'refresh', memoryId: 'mem_b', allowCrossWorkspace: true }, IN_A, w.deps)
    if (r.kind !== 'refreshed') throw new Error(r.kind)
    expect(r.otherWorkspaces).toEqual([{ id: 'mem_b', workspacePath: B }])
    expect(r.message).toContain(B)
    expect((await w.store.get('mem_b'))!.lastConfirmedAt).toBe(5000)
  })

  it('confirm refresh：可见记录不标 workspace', async () => {
    const w = world()
    await w.seed(inA('mem_a'))
    const r = await executeConfirm({ action: 'refresh', memoryId: 'mem_a', allowCrossWorkspace: true }, IN_A, w.deps)
    if (r.kind !== 'refreshed') throw new Error(r.kind)
    expect(r.otherWorkspaces).toEqual([])
    expect(r.message).not.toContain(A)
  })

  it('promote：B 的候选提升到 global，结果与消息标出 B', async () => {
    const w = world()
    await w.seed(inB('mem_b', { globalCandidate: true }))
    const r = await executePromote({ confirmedIds: ['mem_b'], target: 'global', allowCrossWorkspace: true }, IN_A, w.deps)
    expect(r.promoted).toEqual([{ id: 'mem_b', target: 'global' }])
    expect(r.otherWorkspaces).toEqual([{ id: 'mem_b', workspacePath: B }])
    expect(r.message).toContain(B)
    expect((await w.store.get('mem_b'))!.scope).toBe('global')
  })

  it('snapshot create / show / restore：B 的记录放行并标出 B', async () => {
    const w = world()
    await w.seed(inA('mem_a'), inB('mem_b', { summary: 'B 的旧内容' }))
    const created = await executeSnapshotTool({ action: 'create', memoryIds: ['mem_a', 'mem_b'], allowCrossWorkspace: true }, IN_A, w.deps)
    if (created.kind !== 'created') throw new Error(created.kind)
    expect(created.count).toBe(2)
    expect(created.otherWorkspaces).toEqual([{ id: 'mem_b', workspacePath: B }])
    expect(created.message).toContain(B)

    await w.store.softDelete(inB('mem_b'))
    const shown = await executeSnapshotTool({ action: 'show', snapshotId: created.snapshotId, allowCrossWorkspace: true }, IN_A, w.deps)
    if (shown.kind !== 'shown') throw new Error(shown.kind)
    expect(shown.entries.map(e => e.id).sort()).toEqual(['mem_a', 'mem_b'])
    expect(shown.otherWorkspaces).toEqual([{ id: 'mem_b', workspacePath: B }])
    expect(shown.message).toContain(B)

    const restored = await executeSnapshotTool({ action: 'restore', snapshotId: created.snapshotId, memoryIds: ['mem_b'], allowCrossWorkspace: true }, IN_A, w.deps)
    if (restored.kind !== 'restored') throw new Error(restored.kind)
    expect(restored.restored).toEqual(['mem_b'])
    expect(restored.otherWorkspaces).toEqual([{ id: 'mem_b', workspacePath: B }])
    expect(restored.message).toContain(B)
    expect((await w.store.get('mem_b'))!.status).toBe('active')
  })
})

describe('待决账本条目新增 workspaces 字段（global 用 global），scan / health 列出时带上；confirm resolve 涉及其他项目同样要求该参数', () => {
  it('schema 向后兼容：没有 workspaces 的旧条目仍能解析，新条目带 workspaces', () => {
    const old = { id: 'pd_old', memoryIds: ['mem_a', 'mem_b'], summary: '旧', firstSeenAt: 1 }
    expect(pendingDecisionSchema.parse(old)).toEqual(old)
    const fresh = { ...old, workspaces: [A, 'global'] }
    expect(pendingDecisionSchema.parse(fresh).workspaces).toEqual([A, 'global'])
  })

  it('scan 挂账：条目按 memoryIds 顺序记录双方 workspace，global 记作 global；结果与渲染带上', async () => {
    const store = new MemoryStore(new InMemoryTable())
    const decisions = new PendingDecisionsStore(new InMemoryKvTable<PendingDecision>())
    await store.put(inA('mem_a', { content: '用 pnpm' }))
    await store.put(glob('mem_g', { content: '用 npm' }))
    const conflictLlm = {
      complete: async () => JSON.stringify({
        findings: [{ type: 'conflict', memoryIds: ['mem_a', 'mem_g'], summary: '包管理矛盾', suggestedAction: '裁决' }],
      }),
    }
    const r = await executeScan({ layers: 'full' }, {
      store, registry, decisions, cache: new InMemoryKvTable<ScanCacheEntry>(),
      getBaseline: () => null, getLlm: () => conflictLlm,
      resolveContext: async () => ({ workspacePath: A }), now: () => 9000,
    }, fakeExec())
    if (r.kind !== 'single') throw new Error(r.kind)
    const [entry] = await decisions.list()
    expect(entry.workspaces).toEqual([A, 'global'])
    expect(r.pendingDecisions.items[0].workspaces).toEqual([A, 'global'])
    expect(renderScanResult(r)).toContain(`${A}`)
  })

  it('health 列出待决项带 workspaces；旧条目缺字段时按记录现状补出', async () => {
    const store = new MemoryStore(new InMemoryTable())
    const decisions = new PendingDecisionsStore(new InMemoryKvTable<PendingDecision>())
    await store.put(inA('mem_a'))
    await store.put(glob('mem_g'))
    await store.put(inA('mem_a2'))
    await decisions.upsert({ memoryIds: ['mem_a', 'mem_g'], summary: '新条目', workspaces: [A, 'global'] }, 1)
    // 旧版本写入的条目：没有 workspaces
    const kv = new InMemoryKvTable<PendingDecision>()
    const legacy = new PendingDecisionsStore(kv)
    await kv.put('pd_old', { id: 'pd_old', memoryIds: ['mem_a2', 'mem_g'], summary: '旧条目', firstSeenAt: 1 })
    for (const ds of [decisions, legacy]) {
      const r = await executeHealth({}, {
        store, registry, decisions: ds, cache: new InMemoryKvTable<ScanCacheEntry>(),
        thresholds: resolveHealthThresholds('normal'), resolveContext: async () => ({ workspacePath: A }), now: () => 9000,
      }, fakeExec())
      if (r.kind !== 'single') throw new Error(r.kind)
      expect(r.pendingDecisions.items[0].workspaces).toEqual([A, 'global'])
      expect(renderHealthResult(r)).toContain(A)
    }
  })

  it('upsert 已有条目时补写 workspaces，并按条目里 memoryIds 的顺序对齐', async () => {
    const decisions = new PendingDecisionsStore(new InMemoryKvTable<PendingDecision>())
    const first = await decisions.upsert({ memoryIds: ['mem_a', 'mem_g'], summary: 's' }, 1)
    expect(first.entry.workspaces).toBeUndefined()
    const again = await decisions.upsert({ memoryIds: ['mem_g', 'mem_a'], summary: 's2', workspaces: ['global', A] }, 2)
    expect(again.created).toBe(false)
    const stored = (await decisions.get(first.entry.id))!
    expect(stored.memoryIds).toEqual(['mem_a', 'mem_g'])
    expect(stored.workspaces).toEqual([A, 'global'])
  })

  it('confirm resolve：条目涉及 B 的记忆，不带参数被拒（code + B 路径），账本与记忆都不动', async () => {
    const w = world()
    await w.seed(inA('mem_a'), inB('mem_b'))
    const { entry } = await w.decisions.upsert({ memoryIds: ['mem_a', 'mem_b'], summary: '矛盾', workspaces: [A, B] }, 1)
    const r = await executeConfirm({ action: 'resolve', decisionId: entry.id, verdict: 'keep-left' }, IN_A, w.deps)
    expect(r).toMatchObject({ kind: 'error', code: CROSS })
    expect(r.message).toContain(B)
    expect((await w.store.get('mem_b'))!.status).toBe('active')
    expect(await w.decisions.get(entry.id)).toBeDefined()
    expect(await w.snapshots.list()).toHaveLength(0)
  })

  it('confirm resolve：dismiss 也要求该参数（不删记忆也是对 B 的治理动作）', async () => {
    const w = world()
    await w.seed(inA('mem_a'), inB('mem_b'))
    const { entry } = await w.decisions.upsert({ memoryIds: ['mem_a', 'mem_b'], summary: '矛盾' }, 1)
    const r = await executeConfirm({ action: 'resolve', decisionId: entry.id, verdict: 'dismiss' }, IN_A, w.deps)
    expect(r).toMatchObject({ kind: 'error', code: CROSS })
    expect(await w.decisions.get(entry.id)).toBeDefined()
  })

  it('confirm resolve：带参数放行，删 B 的败方，结果与消息标出 B', async () => {
    const w = world()
    await w.seed(inA('mem_a'), inB('mem_b'))
    const { entry } = await w.decisions.upsert({ memoryIds: ['mem_a', 'mem_b'], summary: '矛盾' }, 1)
    const r = await executeConfirm({ action: 'resolve', decisionId: entry.id, verdict: 'keep-left', allowCrossWorkspace: true }, IN_A, w.deps)
    if (r.kind !== 'resolved') throw new Error(r.kind)
    expect(r.otherWorkspaces).toEqual([{ id: 'mem_b', workspacePath: B }])
    expect(r.message).toContain(B)
    expect((await w.store.get('mem_b'))!.status).toBe('deleted')
    expect(await w.decisions.get(entry.id)).toBeUndefined()
  })

  it('confirm resolve：双方都在可见集合（A + global）时不需要参数', async () => {
    const w = world()
    await w.seed(inA('mem_a'), glob('mem_g'))
    const { entry } = await w.decisions.upsert({ memoryIds: ['mem_a', 'mem_g'], summary: '矛盾' }, 1)
    const r = await executeConfirm({ action: 'resolve', decisionId: entry.id, verdict: 'keep-right' }, IN_A, w.deps)
    if (r.kind !== 'resolved') throw new Error(r.kind)
    expect(r.otherWorkspaces).toEqual([])
    expect((await w.store.get('mem_a'))!.status).toBe('deleted')
  })
})

describe('confirm resolve 定位不到败方时报错并保留账本条目', () => {
  it('横向冲突 keep-left：败方（right）不存在 → error，条目仍在，胜方不动', async () => {
    const w = world()
    await w.seed(inA('mem_a'))
    const { entry } = await w.decisions.upsert({ memoryIds: ['mem_a', 'mem_ghost'], summary: '矛盾' }, 1)
    const r = await executeConfirm({ action: 'resolve', decisionId: entry.id, verdict: 'keep-left' }, IN_A, w.deps)
    expect(r.kind).toBe('error')
    expect(r.message).toContain('mem_ghost')
    expect(await w.decisions.get(entry.id)).toBeDefined()
    expect((await w.store.get('mem_a'))!.status).toBe('active')
    expect(await w.snapshots.list()).toHaveLength(0)
  })

  it('垂直冲突 keep-right：记忆不存在 → error，条目仍在', async () => {
    const w = world()
    const { entry } = await w.decisions.upsert({ memoryIds: ['mem_ghost'], baselineRef: 'AGENTS.md：规则', summary: '与基线矛盾' }, 1)
    const r = await executeConfirm({ action: 'resolve', decisionId: entry.id, verdict: 'keep-right' }, IN_A, w.deps)
    expect(r.kind).toBe('error')
    expect(await w.decisions.get(entry.id)).toBeDefined()
  })

  it('不涉及删除的裁决（dismiss）不受影响：一方定位不到也照常移除条目', async () => {
    const w = world()
    await w.seed(inA('mem_a'))
    const { entry } = await w.decisions.upsert({ memoryIds: ['mem_a', 'mem_ghost'], summary: '矛盾' }, 1)
    const r = await executeConfirm({ action: 'resolve', decisionId: entry.id, verdict: 'dismiss' }, IN_A, w.deps)
    expect(r.kind).toBe('resolved')
    expect(await w.decisions.get(entry.id)).toBeUndefined()
  })
})

describe('memory_save update 的 cross-workspace 与 memory_source 的 forbidden 不变、不接受该参数', () => {
  const w = world()
  const ctx = async () => ({ workspacePath: A as string | undefined, session: { id: 's', lastSeq: 1 } })

  it('memory_save / memory_source 的参数 schema 里没有 allowCrossWorkspace', () => {
    const save = createSaveTool({ store: w.store, registry, resolveContext: ctx })
    const source = createSourceTool({ store: w.store, resolveContext: ctx, getReadEvent: () => null })
    for (const tool of [save, source]) {
      const schema = schemaOf(tool) as { properties: Record<string, unknown> }
      expect(Object.keys(schema.properties)).not.toContain('allowCrossWorkspace')
    }
  })

  it('save update 硬塞 allowCrossWorkspace: true 仍被 cross-workspace 拒绝，B 的记录不变', async () => {
    const w2 = world()
    await w2.seed(inB('mem_b', { content: '原文' }))
    const args = {
      action: 'update' as const, id: 'mem_b', name: '条目', type: 'knowledge', scope: 'workspace' as const,
      content: '改写', summary: '摘要', sourceMode: 'user-explicit' as const, allowCrossWorkspace: true,
    }
    const r = await executeSave(args, exec, { store: w2.store, registry, resolveContext: ctx })
    expect(r).toMatchObject({ kind: 'rejected', code: SAVE_CROSS })
    expect((await w2.store.get('mem_b'))!.content).toBe('原文')
  })

  it('source 硬塞 allowCrossWorkspace: true 仍返回 forbidden', async () => {
    const w2 = world()
    await w2.seed(inB('mem_b'))
    const r = await executeSource({ memoryId: 'mem_b', allowCrossWorkspace: true } as never, IN_A, { store: w2.store, getReadEvent: () => null })
    expect(r.kind).toBe('forbidden')
  })
})

describe('在项目 A 的会话里操作项目 B 记录的正反两组测试', () => {
  const roots: string[] = []
  afterEach(async () => { for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true }) })

  async function onDisk() {
    const root = await mkdtemp(join(tmpdir(), 'pm-cross-ws-'))
    roots.push(root)
    const store = new MemoryStore(new FileTable({ root, stats: new InMemoryKvTable<RecallStats>() }))
    const snapshots = new SnapshotStore(new InMemoryKvTable<MemorySnapshot>())
    const decisions = new PendingDecisionsStore(new InMemoryKvTable<PendingDecision>())
    await store.create(inA('mem_a', { name: 'A 规则' }))
    await store.create(inB('mem_b', { name: 'B 规则' }))
    const exists = (p: string) => access(p).then(() => true, () => false)
    return { root, store, deps: { store, snapshots, decisions, now: () => 5000 }, exists }
  }

  it('反：不带参数，A 会话遗忘 B 的记录被拒，B 目录里的文件原地不动', async () => {
    const { root, deps, exists } = await onDisk()
    const r = await executeForget({ ids: ['mem_b'], reason: '清理' }, IN_A, deps)
    expect(r.rejected).toEqual([{ id: 'mem_b', code: CROSS, workspacePath: B }])
    expect(r.message).toContain(B)
    expect(await exists(join(root, workspaceDirName(B), 'B-规则.md'))).toBe(true)
  })

  it('正：带参数，A 会话遗忘 B 的记录成功，文件搬进 B 的 .archive/，结果标出 B', async () => {
    const { root, deps, store, exists } = await onDisk()
    const r = await executeForget({ ids: ['mem_b'], reason: '全局整理', allowCrossWorkspace: true }, IN_A, deps)
    expect(r.forgotten).toEqual(['mem_b'])
    expect(r.otherWorkspaces).toEqual([{ id: 'mem_b', workspacePath: B }])
    expect(await exists(join(root, workspaceDirName(B), 'B-规则.md'))).toBe(false)
    expect(await exists(join(root, workspaceDirName(B), ARCHIVE_DIR, 'B-规则.md'))).toBe(true)
    expect((await store.get('mem_a'))!.status).toBe('active')
  })

  it('反：不带参数，A 会话裁决 A↔B 冲突被拒，账本保留', async () => {
    const { deps, store } = await onDisk()
    const { entry } = await deps.decisions.upsert({ memoryIds: ['mem_a', 'mem_b'], summary: '矛盾' }, 1)
    const r = await executeConfirm({ action: 'resolve', decisionId: entry.id, verdict: 'keep-left' }, IN_A, deps)
    expect(r).toMatchObject({ kind: 'error', code: CROSS })
    expect((await store.get('mem_b'))!.status).toBe('active')
    expect(await deps.decisions.get(entry.id)).toBeDefined()
  })

  it('正：带参数，A 会话裁决 A↔B 冲突删掉 B 的败方', async () => {
    const { deps, store } = await onDisk()
    const { entry } = await deps.decisions.upsert({ memoryIds: ['mem_a', 'mem_b'], summary: '矛盾' }, 1)
    const r = await executeConfirm({ action: 'resolve', decisionId: entry.id, verdict: 'keep-left', allowCrossWorkspace: true }, IN_A, deps)
    if (r.kind !== 'resolved') throw new Error(r.kind)
    expect(r.otherWorkspaces).toEqual([{ id: 'mem_b', workspacePath: B }])
    expect((await store.get('mem_b'))!.status).toBe('deleted')
  })
})

describe('同 id 多副本时，门放行的那份就是被改的那份：删除按放行记录自己的 workspace 定位', () => {
  // 门用当前 workspace 提示定位（global + 当前项目优先），删除若不带提示会先看 global、再按路径序全库取舍，
  // 同 id 多副本时两步可能落到不同文件：改了门没检查的那份，门检查过的那份还活着。
  const ZETA = '/home/dev/zeta'    // 当前项目：目录名排在后
  const ALPHA = '/home/dev/alpha'  // 其他项目：目录名排在前
  const IN_ZETA = { workspacePath: ZETA as string | undefined }
  const quiet = { info() {}, warn() {}, error() {}, debug() {} } as unknown as MemoryLogger

  function dupWorld() {
    const table = new InMemoryTable()
    const store = new MemoryStore(table)
    const deps = {
      store, log: quiet, now: () => 5000,
      snapshots: new SnapshotStore(new InMemoryKvTable<MemorySnapshot>()),
      decisions: new PendingDecisionsStore(new InMemoryKvTable<PendingDecision>()),
    }
    const activeIn = async (path: string) =>
      (await store.queryScope({ scope: { kind: 'workspace', path }, status: ['active'] })).records.map(r => r.id)
    return { table, store, deps, activeIn }
  }

  it('forget：当前项目的副本较新、global 有旧副本 → 归档的是当前项目那份', async () => {
    const w = dupWorld()
    w.table.seedFile({ dir: w.table.globalDir, fileName: 'dup.md', record: glob('mem_dup', { updatedAt: 100 }) })
    w.table.seedFile({ dir: join('/in-memory', workspaceDirName(ZETA)), fileName: 'dup.md', record: record({ id: 'mem_dup', scope: 'workspace', workspacePath: ZETA, updatedAt: 200 }) })
    const r = await executeForget({ ids: ['mem_dup'], reason: '清理' }, IN_ZETA, w.deps)
    expect(r.forgotten).toEqual(['mem_dup'])
    expect(await w.activeIn(ZETA)).toEqual([])
  })

  it('forget：其他项目有同 id、同 updatedAt 的副本且目录名排在前 → 门放行当前项目那份，其他项目那份不动', async () => {
    const w = dupWorld()
    w.table.seedFile({ dir: join('/in-memory', workspaceDirName(ALPHA)), fileName: 'dup.md', record: record({ id: 'mem_dup', scope: 'workspace', workspacePath: ALPHA, updatedAt: 100 }) })
    w.table.seedFile({ dir: join('/in-memory', workspaceDirName(ZETA)), fileName: 'dup.md', record: record({ id: 'mem_dup', scope: 'workspace', workspacePath: ZETA, updatedAt: 100 }) })
    const r = await executeForget({ ids: ['mem_dup'], reason: '清理' }, IN_ZETA, w.deps)
    expect(r.forgotten).toEqual(['mem_dup'])
    expect(r.rejected).toEqual([])
    expect(await w.activeIn(ZETA)).toEqual([])
    expect(await w.activeIn(ALPHA)).toEqual(['mem_dup'])
  })

  it('forget 硬删：含密钥的当前项目副本被物理删除，其他项目的同 id 副本不动', async () => {
    const w = dupWorld()
    const secret = 'token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmnopqrstuvwxyz'
    w.table.seedFile({ dir: join('/in-memory', workspaceDirName(ALPHA)), fileName: 'dup.md', record: record({ id: 'mem_dup', scope: 'workspace', workspacePath: ALPHA, updatedAt: 100, content: secret }) })
    w.table.seedFile({ dir: join('/in-memory', workspaceDirName(ZETA)), fileName: 'dup.md', record: record({ id: 'mem_dup', scope: 'workspace', workspacePath: ZETA, updatedAt: 100, content: secret }) })
    const r = await executeForget({ ids: ['mem_dup'], reason: '泄漏' }, IN_ZETA, w.deps)
    expect(r.hardDeleted).toEqual(['mem_dup'])
    expect(await w.activeIn(ZETA)).toEqual([])
    expect(await w.activeIn(ALPHA)).toEqual(['mem_dup'])
  })
})
