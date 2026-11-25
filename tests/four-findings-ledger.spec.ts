import { afterEach, describe, expect, it } from 'vitest'
import { conflictFingerprint } from '../src/governance/decisions.ts'
import { LEDGER_ONLY_FINDING_TYPES, type MemorySnapshot, type PendingDecision } from '../src/governance/schema.ts'
import { SnapshotStore } from '../src/governance/snapshots.ts'
import { executeConfirm, type ConfirmArgs } from '../src/tools/confirm.ts'
import type { ScanToolResult, SingleScanResult } from '../src/tools/scan.ts'
import { STATE_CHANGE_VERSION, layerOf } from '../src/storage/history.ts'
import type { Scope } from '../src/scope.ts'
import { checkupEnv, type CheckupEnv } from './helpers/checkup-env.ts'
import { findingModel, type ReplyFinding } from './helpers/finding-model.ts'
import { InMemoryKvTable } from './helpers/in-memory-kv.ts'
import { noInstructions } from './helpers/instructions.ts'
import { record } from './helpers/record.ts'

// 体检把漏记的变化、例外挂进待决账本；它们不进体检视图、不计分；用户对一对记忆下过「确实不冲突」「记成例外」之后，三种判断都不再报这一对

const GLOBAL: Scope = { kind: 'global' }
const envs: CheckupEnv[] = []
afterEach(async () => { for (const e of envs.splice(0)) await e.close() })
async function env(): Promise<CheckupEnv> {
  const e = await checkupEnv()
  envs.push(e)
  return e
}
function single(r: ScanToolResult): SingleScanResult {
  if (r.kind !== 'single') throw new Error(`不是单范围结果：${r.kind}`)
  return r
}

async function seed(e: CheckupEnv): Promise<void> {
  await e.store.put(record({ id: 'mem_a', name: '旧端口', content: '服务监听 8100' }))
  await e.store.put(record({ id: 'mem_b', name: '新端口', content: '服务监听 8200' }))
  await e.store.put(record({ id: 'mem_c', name: '通用规则', content: '所有服务都用 UTF-8' }))
  await e.store.put(record({ id: 'mem_e', name: '老系统例外', content: '老系统用 GBK' }))
}
const pairOf = (d: Pick<PendingDecision, 'memoryIds'>) => [...d.memoryIds].sort().join('+')
const openOf = async (e: CheckupEnv) => (await e.decisions.list()).map(d => [d.kind ?? 'conflict', pairOf(d)]).sort()
const confirmDeps = (e: CheckupEnv) => ({
  store: e.store, decisions: e.decisions, snapshots: new SnapshotStore(new InMemoryKvTable<MemorySnapshot>()), instructions: noInstructions, now: () => e.clock.now,
})
async function resolve(e: CheckupEnv, kind: string, pair: string, verdict: Extract<ConfirmArgs, { action: 'resolve' }>['verdict']): Promise<void> {
  const entry = (await e.decisions.list()).find(d => (d.kind ?? 'conflict') === kind && pairOf(d) === pair)!
  expect(await executeConfirm({ action: 'resolve', decisionId: entry.id, verdict }, { workspacePath: undefined }, confirmDeps(e))).toMatchObject({ kind: 'resolved', verdict })
}

const MISSED: ReplyFinding = { type: 'missed-change', ids: ['mem_a', 'mem_b'], current: 'mem_b', summary: '端口从 8100 换成了 8200' }
const EXCEPTION: ReplyFinding = { type: 'exception', ids: ['mem_c', 'mem_e'], summary: '老系统是编码规则的例外' }

describe('挂账', () => {
  it('漏记的变化、例外各挂一条，带种类和方案；结果的待处理清单里标出种类，冲突照旧不标', async () => {
    const e = await env()
    await seed(e)
    const r = single(await e.scan({ llm: findingModel({ findings: [MISSED, EXCEPTION, { type: 'conflict', ids: ['mem_a', 'mem_c'] }] }) }))
    expect(await openOf(e)).toEqual([['conflict', 'mem_a+mem_c'], ['exception', 'mem_c+mem_e'], ['missed-change', 'mem_a+mem_b']])
    const open = await e.decisions.list()
    const missed = open.find(d => d.kind === 'missed-change')!
    const [a, b] = [(await e.store.get('mem_a'))!, (await e.store.get('mem_b'))!]
    expect(missed).toMatchObject({ plan: { kind: 'as-versions', current: 'mem_b' }, fingerprint: conflictFingerprint([a, b]), summary: '端口从 8100 换成了 8200' })
    expect(Object.keys(missed.memberScanFingerprints ?? {})).toHaveLength(2)
    expect(open.find(d => d.kind === 'exception')).not.toHaveProperty('plan')
    const kinds = Object.fromEntries(r.pendingDecisions.items.map(i => [[...i.memoryIds].sort().join('+'), i.kind ?? null]))
    expect(kinds).toEqual({ 'mem_a+mem_b': 'missed-change', 'mem_c+mem_e': 'exception', 'mem_a+mem_c': null })
  })

  it('新发现在工具结果里，不进体检视图（视图是上一个发布版也读的）', async () => {
    const e = await env()
    await seed(e)
    const r = single(await e.scan({ llm: findingModel({ findings: [MISSED, EXCEPTION, { type: 'unclear', ids: ['mem_a'] }] }) }))
    expect(r.findings.map(f => f.type).sort()).toEqual(['exception', 'missed-change', 'unclear'])
    const view = await e.view(GLOBAL)
    expect(view!.findings.map(f => f.type)).toEqual(['unclear'])
    expect(view!.findings.some(f => (LEDGER_ONLY_FINDING_TYPES as readonly string[]).includes(f.type))).toBe(false)
  })

  it('这一批没变：结论从体检结果库里照用，不调模型，账本里的条目不变', async () => {
    const e = await env()
    await seed(e)
    const m = findingModel({ findings: [MISSED, EXCEPTION] })
    await e.scan({ llm: m })
    const before = await e.decisions.list()
    expect(before.map(d => d.kind).sort()).toEqual(['exception', 'missed-change'])
    e.clock.now += 1000
    await e.scan({ llm: m })
    expect(m.batchCalls).toHaveLength(1)
    expect((await e.decisions.list()).map(d => [d.id, d.kind])).toEqual(before.map(d => [d.id, d.kind]))
  })
})

describe('配对排除', () => {
  it('冲突裁成「确实不冲突」：同一对再被报成漏记的变化、例外、冲突都不挂账；别的对照常报', async () => {
    const e = await env()
    await seed(e)
    await e.scan({ llm: findingModel({ findings: [{ type: 'conflict', ids: ['mem_a', 'mem_b'] }] }) })
    await resolve(e, 'conflict', 'mem_a+mem_b', 'not-conflict')
    e.clock.now += 1000
    const r = single(await e.scan({ llm: findingModel({ model: 'model-b', findings: [MISSED, { type: 'exception', ids: ['mem_a', 'mem_b'] }, EXCEPTION] }) }))
    expect(await openOf(e)).toEqual([['exception', 'mem_c+mem_e']])
    expect(r.findings.filter(f => [...f.memoryIds].sort().join('+') === 'mem_a+mem_b')).toEqual([])
    e.clock.now += 1000
    const third = findingModel({ model: 'model-c', findings: [{ type: 'conflict', ids: ['mem_a', 'mem_b'] }] })
    await e.scan({ llm: third })
    expect(third.batchCalls).toHaveLength(1)
    expect(await openOf(e)).toEqual([['exception', 'mem_c+mem_e']])
  })

  it('例外提示忽略之后同一对报成冲突照常挂账；冲突裁成「记成例外」或两条都留之后，三种判断都不再报这一对', async () => {
    const e = await env()
    await seed(e)
    await e.scan({ llm: findingModel({ findings: [EXCEPTION, { type: 'conflict', ids: ['mem_a', 'mem_b'] }] }) })
    await resolve(e, 'exception', 'mem_c+mem_e', 'dismiss')
    const conflictOnCe = findingModel({ model: 'model-b', findings: [{ type: 'conflict', ids: ['mem_c', 'mem_e'] }] })
    e.clock.now += 1000
    await e.scan({ llm: conflictOnCe })
    // 忽略只管这一种：同一对被报成冲突照常挂账
    expect(await openOf(e)).toEqual([['conflict', 'mem_a+mem_b'], ['conflict', 'mem_c+mem_e']])
    await resolve(e, 'conflict', 'mem_c+mem_e', 'exception')
    await resolve(e, 'conflict', 'mem_a+mem_b', 'keep-both')
    e.clock.now += 1000
    await e.scan({ llm: findingModel({ model: 'model-c', findings: [MISSED, { type: 'missed-change', ids: ['mem_c', 'mem_e'] }, { type: 'exception', ids: ['mem_a', 'mem_b'] }, { type: 'conflict', ids: ['mem_b', 'mem_c'] }] }) })
    expect(await openOf(e)).toEqual([['conflict', 'mem_b+mem_c']])
  })

  it('同一对的冲突、漏记的变化、例外互相排斥地挂账：一种正被处理时另两种这次不挂；别的种类不受影响；放开后照常挂', async () => {
    const e = await env()
    const input = (kind?: 'missed-change' | 'exception' | 'premise-changed') => ({ ...(kind !== undefined ? { kind } : {}), memoryIds: ['mem_a', 'mem_b'], summary: '体检报的', fingerprint: 'fp' })
    const held = await e.decisions.withPairClaim({ memoryIds: ['mem_a', 'mem_b'] }, async () => [
      await e.decisions.upsert(input('missed-change'), e.clock.now),
      await e.decisions.upsert(input('exception'), e.clock.now),
      await e.decisions.upsert(input('premise-changed'), e.clock.now),
    ])
    expect(held.isClaimed).toBe(true)
    const [missed, exception, premise] = held.isClaimed ? held.value : []
    expect([missed?.isSkipped, exception?.isSkipped]).toEqual([true, true])
    expect(premise).toMatchObject({ created: true })
    const reverse = await e.decisions.withPairClaim({ kind: 'missed-change', memoryIds: ['mem_b', 'mem_a'] }, () => e.decisions.upsert(input(), e.clock.now))
    expect(reverse).toMatchObject({ isClaimed: true, value: { isSkipped: true } })
    expect((await e.decisions.list()).map(d => d.kind)).toEqual(['premise-changed'])
    // 认领放开之后照常挂
    expect(await e.decisions.upsert(input('missed-change'), e.clock.now)).toMatchObject({ created: true })
    expect((await e.decisions.list()).map(d => d.kind).sort()).toEqual(['missed-change', 'premise-changed'])
  })

  it('确实不冲突之后其中一条只被补证（来源方式变了）：这一批重发给模型，但这一对不重新挂账', async () => {
    const e = await env()
    await seed(e)
    const m = findingModel({ findings: [{ type: 'conflict', ids: ['mem_a', 'mem_b'] }] })
    await e.scan({ llm: m })
    await resolve(e, 'conflict', 'mem_a+mem_b', 'not-conflict')
    const a = (await e.store.get('mem_a'))!
    await e.store.put({ ...a, source: { sessionId: 'sess_2', eventRange: [3, 4], sourceMode: 'agent-inferred' } })
    e.clock.now += 1000
    await e.scan({ llm: m })
    expect(m.batchCalls).toHaveLength(2)
    expect(m.batchCalls[1]).toContain('mem_a')
    expect(await e.decisions.list()).toEqual([])
  })

  it('裁过之后有一边改了事实时间：排除不再算数，重新报', async () => {
    const e = await env()
    await seed(e)
    await e.scan({ llm: findingModel({ findings: [{ type: 'conflict', ids: ['mem_a', 'mem_b'] }] }) })
    await resolve(e, 'conflict', 'mem_a+mem_b', 'not-conflict')
    await e.store.put({ ...(await e.store.get('mem_a'))!, factTime: '2025-06' })
    e.clock.now += 1000
    await e.scan({ llm: findingModel({ model: 'model-b', findings: [MISSED] }) })
    expect(await openOf(e)).toEqual([['missed-change', 'mem_a+mem_b']])
  })
})

describe('重查的触发', () => {
  it('只改了最近一次改动的性质（模型看得到的线索）：这一条所在的批重新发给模型', async () => {
    const e = await env()
    await seed(e)
    const m = findingModel({ findings: [MISSED] })
    await e.scan({ llm: m })
    await e.store.put({ ...(await e.store.get('mem_a'))!, lastChange: { kind: 'state-change', at: e.clock.now, op: 'op_1' } })
    e.clock.now += 1000
    await e.scan({ llm: m })
    expect(m.batchCalls).toHaveLength(2)
    expect(m.batchCalls[1]).toContain('mem_a')
    expect(await openOf(e)).toEqual([['missed-change', 'mem_a+mem_b']])
  })

  it('有历史版本的记忆在提示词里带上版本数', async () => {
    const e = await env()
    await seed(e)
    const a = (await e.store.get('mem_a'))!
    const located = (await e.store.locate('mem_a', GLOBAL))!
    await e.store.history.write(layerOf(located), { versionId: 'v-old', record: { ...a, content: '服务监听 8000' }, extras: {}, startedAt: 1, endedAt: 2, kind: STATE_CHANGE_VERSION, writes: [] })
    const m = findingModel({ findings: [MISSED] })
    await e.scan({ llm: m })
    const user = m.users[0]!
    const blockOf = (id: string) => {
      const start = user.indexOf(`- id=${id} `)
      const next = user.indexOf('\n- id=', start + 1)
      return user.slice(start, next < 0 ? undefined : next)
    }
    expect(blockOf('mem_a')).toContain('\n  versions: 1')
    expect(blockOf('mem_b')).not.toContain('versions:')
    expect(await openOf(e)).toEqual([['missed-change', 'mem_a+mem_b']])
  })
})
