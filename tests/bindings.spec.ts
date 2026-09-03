import { describe, expect, it } from 'vitest'
import { snapshotJsonValue } from '@deepseek-ai/dsh-session'
import { validateJsonSchemaValue, type JsonSchemaNode, type ToolDefinition } from '@deepseek-ai/dsh-tools'

import { createSaveTool } from '../src/tools/save-tool.ts'
import { createSearchTool } from '../src/tools/search-tool.ts'
import { createForgetTool } from '../src/tools/forget-tool.ts'
import { createConfirmTool } from '../src/tools/confirm-tool.ts'
import { createScanTool } from '../src/tools/scan-tool.ts'
import { createHealthTool } from '../src/tools/health-tool.ts'
import { createPromoteTool } from '../src/tools/promote-tool.ts'
import { createSnapshotTool } from '../src/tools/snapshot-tool.ts'
import { createSourceTool } from '../src/tools/source-tool.ts'

import { MemoryStore, InMemoryTable } from '../src/store.ts'
import { PendingDecisionsStore } from '../src/governance/decisions.ts'
import { SnapshotStore } from '../src/governance/snapshots.ts'
import { InMemoryKvTable } from '../src/kv-table.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'
import { runSavePipeline } from '../src/pipeline.ts'
import type { MemorySnapshot, PendingDecision, ScanCacheEntry } from '../src/governance/schema.ts'
import type { MemoryRecord } from '../src/record-schema.ts'

/**
 * 九个工具绑定层（src/tools/*-tool.ts）的契约测试。绑定层此前从未被测：纯逻辑在
 * src/tools/<x>.ts 有独立单测，但 defineTool 把逻辑接到框架、以及"结果必须是无损 JSON"
 * 这层契约没人守。本文件用真实 defineTool 构造每个工具，喂典型参数，对每个工具独立断言三件事：
 *   (a) 参数 DSL 校验——合法参数过、非法（缺必填 / 违枚举 / 错类型）拒；
 *   (b) execute 结果过宿主同款深度校验 snapshotJsonValue(result) !== undefined；
 *   (c) render 返回非空 ContentBlock[]，且每块过 snapshotJsonValue。
 *
 * 关于 (a) 的取材：dsh 不把作者面的 ParameterSchemaSpec 挂到定义上，defineTool 编译后
 * 只在 def.parameters 上留下等价的 JSON Schema。故用 dsh 自带的 validateJsonSchemaValue
 * 直接校验 def.parameters（宿主发给模型、并据以校验入参的同一份 schema），而不是另造校验器。
 *
 * 契约说明：宿主用 snapshotJsonValue 深校验每个工具结果，任何含 undefined / 非纯对象 /
 * NaN 的值都会被判为不可无损序列化。memory_snapshot 的 show 在被引用记录已从存储硬移除时，
 * diff 条目带 current: undefined——在 toToolOutput 出口收口落地前，(b) 断言在此处为红，
 * 是本文件先于实现写下时暴露的契约缺口；现在它钉住"结果须为无损 JSON"不被回退。
 * 其余工具的结果在运行时本就不含 undefined（可选字段用条件展开省略、除法有兜底）。
 */

const registry = buildTypeRegistry({ template: 'coding', customTypes: {} })
const NOW = 1_000_000
/** 绑定层 execute 只从 exec 读 signal（scan）或转交给 resolveContext；最小桩即可。 */
const exec = {} as never
const jsonOk = (v: unknown): boolean => snapshotJsonValue(v) !== undefined
const schemaOf = (tool: ToolDefinition): JsonSchemaNode => tool.parameters as unknown as JsonSchemaNode

function record(partial: Partial<MemoryRecord>): MemoryRecord {
  return {
    id: 'mem_' + Math.random().toString(36).slice(2), name: '条目', type: 'knowledge', scope: 'global',
    tags: [], content: '内容', summary: '摘要',
    source: { sessionId: 's', eventRange: [0, 1], sourceMode: 'user-explicit' },
    createdAt: 1, updatedAt: 1, lastConfirmedAt: 1, lastRecalledAt: null,
    recallCount: 0, status: 'active', confidence: 0.9, ...partial,
  }
}

/** 断言 render 投影非空且每块无损 JSON——(c) 的共用体。 */
function expectRenderClean(tool: ToolDefinition, args: unknown, value: unknown): void {
  const blocks = tool.output.render(args as never, value as never)
  expect(Array.isArray(blocks)).toBe(true)
  expect(blocks.length).toBeGreaterThan(0)
  for (const block of blocks) expect(jsonOk(block)).toBe(true)
}

// ---------------------------------------------------------------------------
// memory_save
// ---------------------------------------------------------------------------
describe('memory_save 绑定', () => {
  const makeTool = (store = new MemoryStore(new InMemoryTable())) => createSaveTool({
    store, registry,
    resolveContext: async () => ({ workspacePath: '/proj', session: { id: 's', lastSeq: 1 } }),
  })
  const legal = { action: 'create', name: '标题', type: 'preference', scope: 'global', content: '内容', summary: '摘要', sourceMode: 'user-explicit' }

  it('(a) 合法参数过、缺必填拒', () => {
    const tool = makeTool()
    expect(validateJsonSchemaValue(schemaOf(tool), legal)).toEqual([])
    // 缺 name/type/scope/content/summary/sourceMode 等必填
    expect(validateJsonSchemaValue(schemaOf(tool), { action: 'create' }).length).toBeGreaterThan(0)
  })

  it('(b) execute 结果无损 JSON', async () => {
    const result = await makeTool().execute(
      { ...legal, scope: 'workspace', name: 'commit 语言', content: 'commit 用英文', summary: 'commit 英文' }, exec)
    expect((result as { kind: string }).kind).toBe('saved')
    expect(jsonOk(result)).toBe(true)
  })

  it('(c) render 块无损 JSON', async () => {
    const tool = makeTool()
    const result = await tool.execute({ ...legal, scope: 'workspace', name: 't', content: 'c', summary: 's' }, exec)
    expectRenderClean(tool, {}, result)
  })
})

// ---------------------------------------------------------------------------
// memory_search
// ---------------------------------------------------------------------------
describe('memory_search 绑定', () => {
  async function seededTool() {
    const store = new MemoryStore(new InMemoryTable())
    const r = await runSavePipeline({
      action: 'create', name: '认证位置', type: 'knowledge', scope: 'workspace',
      content: '认证逻辑在 src/auth.ts', summary: 'auth 位置', tags: ['auth'], sourceMode: 'user-explicit', force: true,
    }, { store, registry, workspacePath: '/proj', session: { id: 's', lastSeq: 1 } })
    if (r.kind !== 'saved') throw new Error(r.kind)
    return createSearchTool({ store, registry, resolveContext: async () => ({ workspacePath: '/proj', session: { id: 's', lastSeq: 1 } }) })
  }

  it('(a) 合法参数过、缺必填（query）拒', async () => {
    const tool = await seededTool()
    expect(validateJsonSchemaValue(schemaOf(tool), { query: 'auth' })).toEqual([])
    expect(validateJsonSchemaValue(schemaOf(tool), {}).length).toBeGreaterThan(0)
  })

  it('(b) 命中结果无损 JSON', async () => {
    const tool = await seededTool()
    const result = await tool.execute({ query: '认证' }, exec)
    expect((result as { hits: unknown[] }).hits.length).toBeGreaterThan(0)
    expect(jsonOk(result)).toBe(true)
  })

  it('(b) 零命中结果无损 JSON', async () => {
    const tool = await seededTool()
    const result = await tool.execute({ query: 'zzz无此词zzz' }, exec)
    expect((result as { hits: unknown[] }).hits.length).toBe(0)
    expect(jsonOk(result)).toBe(true)
  })

  it('(c) render 块无损 JSON', async () => {
    const tool = await seededTool()
    const result = await tool.execute({ query: '认证' }, exec)
    expectRenderClean(tool, { query: '认证' }, result)
  })
})

// ---------------------------------------------------------------------------
// memory_forget
// ---------------------------------------------------------------------------
describe('memory_forget 绑定', () => {
  async function makeTool(seed = true) {
    const store = new MemoryStore(new InMemoryTable())
    if (seed) await store.put(record({ id: 'mem_f' }))
    return createForgetTool({
      store, snapshots: new SnapshotStore(new InMemoryKvTable<MemorySnapshot>()),
      decisions: new PendingDecisionsStore(new InMemoryKvTable<PendingDecision>()), now: () => NOW,
    })
  }

  it('(a) 合法参数过、缺必填（ids/reason）拒', async () => {
    const tool = await makeTool()
    expect(validateJsonSchemaValue(schemaOf(tool), { ids: ['mem_f'], reason: '过期' })).toEqual([])
    expect(validateJsonSchemaValue(schemaOf(tool), { ids: ['mem_f'] }).length).toBeGreaterThan(0)
  })

  it('(b) 遗忘成功结果无损 JSON', async () => {
    const result = await (await makeTool()).execute({ ids: ['mem_f'], reason: '过期' }, exec)
    expect((result as { ok: boolean }).ok).toBe(true)
    expect(jsonOk(result)).toBe(true)
  })

  it('(b) 全部未命中结果无损 JSON', async () => {
    const result = await (await makeTool(false)).execute({ ids: ['mem_none'], reason: '过期' }, exec)
    expect((result as { ok: boolean }).ok).toBe(false)
    expect(jsonOk(result)).toBe(true)
  })

  it('(c) render 块无损 JSON', async () => {
    const tool = await makeTool()
    const result = await tool.execute({ ids: ['mem_f'], reason: '过期' }, exec)
    expectRenderClean(tool, {}, result)
  })
})

// ---------------------------------------------------------------------------
// memory_promote
// ---------------------------------------------------------------------------
describe('memory_promote 绑定', () => {
  async function makeTool() {
    const store = new MemoryStore(new InMemoryTable())
    await store.put(record({ id: 'mem_p', scope: 'workspace', workspacePath: '/proj', globalCandidate: true }))
    return createPromoteTool({
      store, agentsMd: { append: async () => {} } as never,
      snapshots: new SnapshotStore(new InMemoryKvTable<MemorySnapshot>()), defaultTarget: 'global', now: () => NOW,
    })
  }

  it('(a) 合法参数过、缺必填（ids）拒', async () => {
    const tool = await makeTool()
    expect(validateJsonSchemaValue(schemaOf(tool), { ids: ['mem_p'] })).toEqual([])
    expect(validateJsonSchemaValue(schemaOf(tool), { target: 'global' }).length).toBeGreaterThan(0)
  })

  it('(b) 提升成功结果无损 JSON', async () => {
    const result = await (await makeTool()).execute({ ids: ['mem_p'] }, exec)
    expect((result as { promoted: unknown[] }).promoted).toHaveLength(1)
    expect(jsonOk(result)).toBe(true)
  })

  it('(b) 空 ids 结果无损 JSON', async () => {
    const result = await (await makeTool()).execute({ ids: [] }, exec)
    expect((result as { promoted: unknown[] }).promoted).toHaveLength(0)
    expect(jsonOk(result)).toBe(true)
  })

  it('(c) render 块无损 JSON', async () => {
    const tool = await makeTool()
    const result = await tool.execute({ ids: ['mem_p'] }, exec)
    expectRenderClean(tool, { ids: ['mem_p'] }, result)
  })
})

// ---------------------------------------------------------------------------
// memory_confirm
// ---------------------------------------------------------------------------
describe('memory_confirm 绑定', () => {
  async function makeTool() {
    const store = new MemoryStore(new InMemoryTable())
    await store.put(record({ id: 'mem_c' }))
    return createConfirmTool({
      store, decisions: new PendingDecisionsStore(new InMemoryKvTable<PendingDecision>()),
      snapshots: new SnapshotStore(new InMemoryKvTable<MemorySnapshot>()), now: () => NOW,
    })
  }

  it('(a) 合法参数过、缺必填（action）拒', async () => {
    const tool = await makeTool()
    expect(validateJsonSchemaValue(schemaOf(tool), { action: 'refresh', memoryId: 'mem_c' })).toEqual([])
    expect(validateJsonSchemaValue(schemaOf(tool), { memoryId: 'mem_c' }).length).toBeGreaterThan(0)
  })

  it('(b) refresh 结果无损 JSON', async () => {
    const result = await (await makeTool()).execute({ action: 'refresh', memoryId: 'mem_c' }, exec)
    expect((result as { kind: string }).kind).toBe('refreshed')
    expect(jsonOk(result)).toBe(true)
  })

  it('(b) 未知 decisionId 的 error 结果无损 JSON', async () => {
    const result = await (await makeTool()).execute({ action: 'resolve', decisionId: 'pd_unknown', verdict: 'dismiss' }, exec)
    expect((result as { kind: string }).kind).toBe('error')
    expect(jsonOk(result)).toBe(true)
  })

  it('(c) render 块无损 JSON', async () => {
    const tool = await makeTool()
    const result = await tool.execute({ action: 'refresh', memoryId: 'mem_c' }, exec)
    expectRenderClean(tool, {}, result)
  })
})

// ---------------------------------------------------------------------------
// memory_snapshot
// ---------------------------------------------------------------------------
describe('memory_snapshot 绑定', () => {
  const makeTool = (store: MemoryStore, snapshots: SnapshotStore) =>
    createSnapshotTool({ store, snapshots, now: () => NOW })

  it('(a) 合法参数过、缺必填（action）拒', () => {
    const tool = makeTool(new MemoryStore(new InMemoryTable()), new SnapshotStore(new InMemoryKvTable<MemorySnapshot>()))
    expect(validateJsonSchemaValue(schemaOf(tool), { action: 'create' })).toEqual([])
    expect(validateJsonSchemaValue(schemaOf(tool), { description: '无 action' }).length).toBeGreaterThan(0)
  })

  it('(b) 空库 create 结果无损 JSON', async () => {
    const tool = makeTool(new MemoryStore(new InMemoryTable()), new SnapshotStore(new InMemoryKvTable<MemorySnapshot>()))
    const result = await tool.execute({ action: 'create' }, exec)
    expect((result as { kind: string }).kind).toBe('created')
    expect(jsonOk(result)).toBe(true)
  })

  it('(b) list 结果无损 JSON', async () => {
    const tool = makeTool(new MemoryStore(new InMemoryTable()), new SnapshotStore(new InMemoryKvTable<MemorySnapshot>()))
    expect(jsonOk(await tool.execute({ action: 'list' }, exec))).toBe(true)
  })

  // 钉住边界：show 的 diff 条目在被引用记录已从存储硬移除时带 current: undefined，
  // 宿主 snapshotJsonValue 深校验会因此返回 undefined。断言"结果必须是无损 JSON"当前失败，
  // 出口收口前此例为红（暴露绑定层未把结果钉成无损 JSON），现在锁定该契约不回退。
  it('(b) show 悬空记录（快照后被移除）结果须为无损 JSON', async () => {
    const table = new InMemoryTable()
    const store = new MemoryStore(table)
    const snapshots = new SnapshotStore(new InMemoryKvTable<MemorySnapshot>())
    const rec = record({ id: 'mem_gone' })
    await store.put(rec)
    const snap = await snapshots.capture({ operation: 'manual', description: '清理前', records: [rec] }, NOW)
    await table.delete('mem_gone') // 记录文件被移除，快照仍引用它 → diff.current = undefined
    const result = await makeTool(store, snapshots).execute({ action: 'show', snapshotId: snap.id }, exec)
    expect((result as { kind: string }).kind).toBe('shown')
    expect(snapshotJsonValue(result)).not.toBe(undefined)
  })

  it('(c) render 块无损 JSON', async () => {
    const tool = makeTool(new MemoryStore(new InMemoryTable()), new SnapshotStore(new InMemoryKvTable<MemorySnapshot>()))
    const result = await tool.execute({ action: 'create' }, exec)
    expectRenderClean(tool, {}, result)
  })
})

// ---------------------------------------------------------------------------
// memory_source
// ---------------------------------------------------------------------------
describe('memory_source 绑定', () => {
  async function makeTool() {
    const store = new MemoryStore(new InMemoryTable())
    await store.put(record({ id: 'mem_s', scope: 'workspace', workspacePath: '/proj' }))
    return createSourceTool({
      store, getReadEvent: () => null, // 会话查询服务不可用 → unavailable
      resolveContext: async () => ({ workspacePath: '/proj' }),
    })
  }

  it('(a) 合法参数过、缺必填（memoryId）拒', async () => {
    const tool = await makeTool()
    expect(validateJsonSchemaValue(schemaOf(tool), { memoryId: 'mem_s' })).toEqual([])
    expect(validateJsonSchemaValue(schemaOf(tool), { window: 5 }).length).toBeGreaterThan(0)
  })

  it('(b) 悬空锚（服务不可用）结果无损 JSON', async () => {
    const result = await (await makeTool()).execute({ memoryId: 'mem_s' }, exec)
    expect((result as { kind: string }).kind).toBe('unavailable')
    expect(jsonOk(result)).toBe(true)
  })

  it('(b) 记忆不存在（not-found）结果无损 JSON', async () => {
    const result = await (await makeTool()).execute({ memoryId: 'mem_none' }, exec)
    expect((result as { kind: string }).kind).toBe('not-found')
    expect(jsonOk(result)).toBe(true)
  })

  it('(c) render 块无损 JSON', async () => {
    const tool = await makeTool()
    const result = await tool.execute({ memoryId: 'mem_s' }, exec)
    expectRenderClean(tool, { memoryId: 'mem_s' }, result)
  })
})

// ---------------------------------------------------------------------------
// memory_scan
// ---------------------------------------------------------------------------
describe('memory_scan 绑定', () => {
  async function makeTool(workspacePath?: string, seed?: (store: MemoryStore) => Promise<void>) {
    const store = new MemoryStore(new InMemoryTable())
    await seed?.(store)
    return createScanTool({
      store, registry,
      decisions: new PendingDecisionsStore(new InMemoryKvTable<PendingDecision>()),
      cache: new InMemoryKvTable<ScanCacheEntry>(),
      getBaseline: () => null,
      getLlm: () => null, // 无 LLM：语义层跳过，只跑规则层
      resolveContext: async () => ({ workspacePath }),
      now: () => NOW,
    })
  }

  it('(a) 合法参数过、非法枚举（layers）拒', async () => {
    const tool = await makeTool()
    // scan 无必填参数，故 (a) 的"拒"改测枚举违例
    expect(validateJsonSchemaValue(schemaOf(tool), { layers: 'full' })).toEqual([])
    expect(validateJsonSchemaValue(schemaOf(tool), { layers: 'bogus' }).length).toBeGreaterThan(0)
  })

  it('(b) 空库单层（global）结果无损 JSON', async () => {
    const result = await (await makeTool()).execute({}, exec)
    expect((result as { kind: string }).kind).toBe('single')
    expect(jsonOk(result)).toBe(true)
  })

  it('(b) 无 LLM 的 rule 层结果无损 JSON', async () => {
    const tool = await makeTool('/proj', async store => {
      await store.put(record({ id: 'mem_ws', scope: 'workspace', workspacePath: '/proj', validTo: 100 }))
    })
    const result = await tool.execute({ layers: 'rule' }, exec)
    expect((result as { findings: unknown[] }).findings.length).toBeGreaterThan(0) // expired
    expect(jsonOk(result)).toBe(true)
  })

  it('(c) render 块无损 JSON', async () => {
    const tool = await makeTool()
    const result = await tool.execute({}, exec)
    expectRenderClean(tool, {}, result)
  })
})

// ---------------------------------------------------------------------------
// memory_health
// ---------------------------------------------------------------------------
describe('memory_health 绑定', () => {
  async function makeTool(workspacePath?: string, seed?: (store: MemoryStore) => Promise<void>) {
    const store = new MemoryStore(new InMemoryTable())
    await seed?.(store)
    return createHealthTool({
      store, registry,
      decisions: new PendingDecisionsStore(new InMemoryKvTable<PendingDecision>()),
      cache: new InMemoryKvTable<ScanCacheEntry>(),
      thresholds: { actionScoreThreshold: 70, pendingOverdueDays: 7, scanStaleDays: 7 },
      resolveContext: async () => ({ workspacePath }),
      now: () => NOW,
    })
  }

  it('(a) 合法参数过、错类型（scope 非字符串）拒', async () => {
    const tool = await makeTool()
    // health 无必填参数，故 (a) 的"拒"改测类型违例
    expect(validateJsonSchemaValue(schemaOf(tool), { scope: 'all' })).toEqual([])
    expect(validateJsonSchemaValue(schemaOf(tool), { scope: 123 }).length).toBeGreaterThan(0)
  })

  it('(b) 空库单层结果无损 JSON', async () => {
    const result = await (await makeTool()).execute({}, exec)
    expect((result as { kind: string }).kind).toBe('single')
    expect(jsonOk(result)).toBe(true)
  })

  it('(b) scope=all 多 workspace 分层表结果无损 JSON', async () => {
    const tool = await makeTool('/proj', async store => {
      await store.put(record({ id: 'mem_a', scope: 'workspace', workspacePath: '/proj' }))
      await store.put(record({ id: 'mem_b', scope: 'workspace', workspacePath: '/proj2' }))
      await store.put(record({ id: 'mem_g' }))
    })
    const result = await tool.execute({ scope: 'all' }, exec)
    expect((result as { kind: string }).kind).toBe('checkup')
    expect((result as { rows: unknown[] }).rows.length).toBe(3) // global + 2 ws
    expect(jsonOk(result)).toBe(true)
  })

  it('(c) render 块无损 JSON', async () => {
    const tool = await makeTool()
    const result = await tool.execute({}, exec)
    expectRenderClean(tool, {}, result)
  })
})
