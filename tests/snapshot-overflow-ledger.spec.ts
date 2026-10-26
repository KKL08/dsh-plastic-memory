import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SidecarStore } from '../src/storage/sidecar.ts'
import { PendingDecisionsStore, overflowLevelOf } from '../src/governance/decisions.ts'
import { memorySnapshotSchema, pendingDecisionSchema, scanCacheSchema } from '../src/governance/schema.ts'
import { SnapshotCache, type FrozenSnapshotInfo } from '../src/runtime.ts'
import { MemoryStore, InMemoryTable } from '../src/store.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'
import type { OverflowMode } from '../src/snapshot.ts'
import type { MemoryRecord } from '../src/record-schema.ts'
import { record as baseRecord } from './helpers/record.ts'

// 超出上限提醒进待决账本（kind: overflow，指纹 = 档位）：快照冻结时按会话所属项目同步。
// 真实临时目录 + 文件侧表；记忆走内存表（与 runtime.spec 同一口径）。

const registry = buildTypeRegistry({ template: 'coding', customTypes: {} })
const WS = '/repo/proj'
const record = (partial: Partial<MemoryRecord> = {}) => baseRecord({ createdAt: Date.now(), updatedAt: Date.now(), lastConfirmedAt: Date.now(), ...partial })

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'pm-overflow-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

function ledger() {
  const sidecar = new SidecarStore({ root, schemas: { snapshots: memorySnapshotSchema, pending: pendingDecisionSchema, scanCache: scanCacheSchema } })
  return new PendingDecisionsStore(sidecar.pending)
}

async function seed(store: MemoryStore, n: number, prefix = 'mem') {
  for (let i = 0; i < n; i++) {
    await store.put(record({ id: `${prefix}_${i}`, name: `条目${i}`, summary: '一段用来占预算的摘要文字', scope: 'workspace', workspacePath: WS }))
  }
}

/** 在 WS 会话里冻结一次快照，返回冻结信息。每次新建会话对象 = 一次新的组装。 */
async function freeze(store: MemoryStore, decisions: PendingDecisionsStore | undefined, budget: number, overflow: OverflowMode = 'relax'): Promise<FrozenSnapshotInfo> {
  let info: FrozenSnapshotInfo | undefined
  const cache = new SnapshotCache({ store, registry, budget, overflow, ...(decisions ? { overflowLedger: decisions } : {}), onFrozen: (_s, i) => { info = i } })
  const session = {}
  cache.setWorkspacePath(session, WS)
  await cache.assemble(session)
  if (!info) throw new Error('没有冻结')
  return info
}

const overflowEntries = async (d: PendingDecisionsStore) => ({
  open: (await d.list()).filter(e => e.kind === 'overflow'),
  settled: (await d.listSettled()).filter(e => e.kind === 'overflow'),
})

describe('自动放宽：档位提醒', () => {
  it('超过上限进入第 1 档记一条；同档再组装不重复；升档换成新档', async () => {
    const store = new MemoryStore(new InMemoryTable())
    await seed(store, 10)
    const used = (await freeze(store, undefined, 1e9)).usedTokens
    const d = ledger()

    const first = await freeze(store, d, used - 1)
    expect(first.overflowChanged).toBe(true)
    let { open } = await overflowEntries(d)
    expect(open).toHaveLength(1)
    expect(open[0]).toMatchObject({ kind: 'overflow', workspaces: [WS] })
    expect(overflowLevelOf(open[0])).toEqual({ mode: 'relax', tier: 1 })

    expect((await freeze(store, d, used - 1)).overflowChanged).toBe(false)
    expect((await overflowEntries(d)).open).toHaveLength(1)

    await freeze(store, d, Math.floor(used / 1.3)) // 用量约为上限的 1.3 倍：第 2 档
    ;({ open } = await overflowEntries(d))
    expect(open.map(overflowLevelOf)).toEqual([{ mode: 'relax', tier: 2 }])
  })

  it('忽略（settled）后同档不再提醒；进入更高档重新提醒', async () => {
    const store = new MemoryStore(new InMemoryTable())
    await seed(store, 10)
    const used = (await freeze(store, undefined, 1e9)).usedTokens
    const d = ledger()
    await freeze(store, d, used - 1)
    const [entry] = (await overflowEntries(d)).open
    expect(await d.settle(entry.id, 'dismiss', Date.now())).toBe(true)

    expect((await freeze(store, d, used - 1)).overflowChanged).toBe(false)
    expect((await overflowEntries(d)).open).toEqual([])

    await freeze(store, d, Math.floor(used / 1.3))
    expect((await overflowEntries(d)).open.map(overflowLevelOf)).toEqual([{ mode: 'relax', tier: 2 }])
  })

  it('用量降回上限以内：删除条目，再超出时重新提醒', async () => {
    const store = new MemoryStore(new InMemoryTable())
    await seed(store, 10)
    const used = (await freeze(store, undefined, 1e9)).usedTokens
    const d = ledger()
    await freeze(store, d, used - 1)
    const [entry] = (await overflowEntries(d)).open
    await d.settle(entry.id, 'dismiss', Date.now())

    // 真的少了记忆：用量降回上限以内
    for (let i = 5; i < 10; i++) await store.put(record({ id: `mem_${i}`, status: 'deleted', scope: 'workspace', workspacePath: WS }))
    expect((await freeze(store, d, used - 1)).overflowChanged).toBe(true)
    expect(await overflowEntries(d)).toEqual({ open: [], settled: [] })

    await seed(store, 10)
    await freeze(store, d, used - 1)
    expect((await overflowEntries(d)).open.map(overflowLevelOf)).toEqual([{ mode: 'relax', tier: 1 }])
  })

  it('从已忽略的高档降一档：高档条目删除，低档沿用忽略，不因回落打扰；再升回高档重新提醒', async () => {
    const store = new MemoryStore(new InMemoryTable())
    await seed(store, 10)
    const used = (await freeze(store, undefined, 1e9)).usedTokens
    const d = ledger()
    await freeze(store, d, Math.floor(used / 1.3))
    const [tier2] = (await overflowEntries(d)).open
    await d.settle(tier2.id, 'dismiss', Date.now())

    await freeze(store, d, used - 1) // 回到第 1 档
    let { open, settled } = await overflowEntries(d)
    expect(open).toEqual([])
    expect(settled.map(overflowLevelOf)).toEqual([{ mode: 'relax', tier: 1 }])

    await freeze(store, d, Math.floor(used / 1.3))
    ;({ open, settled } = await overflowEntries(d))
    expect(open.map(overflowLevelOf)).toEqual([{ mode: 'relax', tier: 2 }])
    expect(settled).toEqual([])
  })

  it('按项目各记各的：另一个项目没超限不会删掉这个项目的提醒', async () => {
    const store = new MemoryStore(new InMemoryTable())
    await seed(store, 10)
    const used = (await freeze(store, undefined, 1e9)).usedTokens
    const d = ledger()
    await freeze(store, d, used - 1)

    const cache = new SnapshotCache({ store, registry, budget: used - 1, overflowLedger: d })
    const other = {}
    cache.setWorkspacePath(other, '/repo/other')
    await cache.assemble(other)
    expect((await overflowEntries(d)).open.map(e => e.workspaces)).toEqual([[WS]])
  })

  it('workspace 未解析的临时文本不冻结，也不碰账本', async () => {
    const store = new MemoryStore(new InMemoryTable())
    await store.put(record({ id: 'mem_g', summary: '一段用来占预算的摘要文字' }))
    const d = ledger()
    const cache = new SnapshotCache({ store, registry, budget: 1, overflowLedger: d })
    await cache.assemble({})
    expect(await overflowEntries(d)).toEqual({ open: [], settled: [] })
  })
})

describe('估算口径变了（升级）：已有提醒在下次冻结时重新同步', () => {
  // 旧版本按旧口径写下的条目：账本里只有档位与说明，不记当时怎么算的；升级后第一次冻结按新口径重算
  const oldSummary = '带入记忆约 9000 token，超出上限 4000，已自动放宽到 9000'

  it('新口径下回到上限以内：旧提醒删除，不留已忽略的残条', async () => {
    const store = new MemoryStore(new InMemoryTable())
    await seed(store, 10)
    const used = (await freeze(store, undefined, 1e9)).usedTokens
    const d = ledger()
    await d.syncOverflow(WS, { mode: 'relax', tier: 5 }, Date.now(), oldSummary)

    expect((await freeze(store, d, used)).overflowChanged).toBe(true)
    expect(await overflowEntries(d)).toEqual({ open: [], settled: [] })
  })

  it('新口径下仍超出：换成新档位，说明里是新口径的用量', async () => {
    const store = new MemoryStore(new InMemoryTable())
    await seed(store, 10)
    const used = (await freeze(store, undefined, 1e9)).usedTokens
    const d = ledger()
    await d.syncOverflow(WS, { mode: 'relax', tier: 5 }, Date.now(), oldSummary)

    await freeze(store, d, used - 1)
    const { open, settled } = await overflowEntries(d)
    expect(settled).toEqual([])
    expect(open.map(overflowLevelOf)).toEqual([{ mode: 'relax', tier: 1 }])
    expect(open[0].summary).toContain(`带入记忆约 ${used} token，超出上限 ${used - 1}`)
  })
})

describe('严格按上限：95% 提醒', () => {
  it('用到 95% 记一条 strict 提醒；截断条数进冻结信息；切回自动放宽时旧提醒换掉', async () => {
    const store = new MemoryStore(new InMemoryTable())
    await seed(store, 10)
    const used = (await freeze(store, undefined, 1e9)).usedTokens
    // 每条索引行等长：量出单行与固定开销，预算恰好装下 5 条（用量 = 上限）
    const nine = new MemoryStore(new InMemoryTable())
    await seed(nine, 9)
    const line = used - (await freeze(nine, undefined, 1e9)).usedTokens
    const fiveLines = used - 5 * line
    const d = ledger()

    const loose = await freeze(store, d, used * 2, 'strict')
    expect(loose.omittedCount).toBe(0)
    expect(await overflowEntries(d)).toEqual({ open: [], settled: [] })

    const tight = await freeze(store, d, fiveLines, 'strict')
    expect(tight.overflowMode).toBe('strict')
    expect(tight.injectedIds).toHaveLength(5)
    expect(tight.omittedCount).toBe(5)
    expect(tight.usedTokens).toBe(fiveLines)
    const { open } = await overflowEntries(d)
    expect(open.map(overflowLevelOf)).toEqual([{ mode: 'strict', tier: 0 }])
    // 指纹与放宽档位区分开
    expect(open[0].fingerprint).not.toMatch(/^\d+$/)

    await freeze(store, d, used - 1, 'relax')
    expect((await overflowEntries(d)).open.map(overflowLevelOf)).toEqual([{ mode: 'relax', tier: 1 }])
  })
})

describe('冻结信息：会话视图的原料', () => {
  it('三段 token、带入 id、上限与模式；冻结时刻', async () => {
    const store = new MemoryStore(new InMemoryTable())
    await seed(store, 3)
    await store.put(record({ id: 'mem_global', summary: '全局的一条' }))
    const before = Date.now()
    const info = await freeze(store, undefined, 4000)
    expect(info.workspacePath).toBe(WS)
    expect(info.budget).toBe(4000)
    expect(info.overflowMode).toBe('relax')
    expect(info.frozenAt).toBeGreaterThanOrEqual(before)
    expect([...info.injectedIds].sort()).toEqual(['mem_0', 'mem_1', 'mem_2', 'mem_global'])
    expect(info.tokens.workspace).toBeGreaterThan(0)
    expect(info.tokens.global).toBeGreaterThan(0)
    expect(info.tokens.fixed).toBeGreaterThan(0)
    expect(info.omittedCount).toBe(0)
  })
})
