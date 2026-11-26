import { afterEach, describe, expect, it } from 'vitest'
import { findPremiseChanges, premiseChangeFingerprint, type PremiseLookup } from '../src/governance/premise-check.ts'
import { premiseDigest } from '../src/links.ts'
import { SEVERITY_BY_TYPE, type MemorySnapshot } from '../src/governance/schema.ts'
import { SnapshotStore } from '../src/governance/snapshots.ts'
import { executeConfirm } from '../src/tools/confirm.ts'
import type { SingleScanResult, ScanToolResult } from '../src/tools/scan.ts'
import type { MemoryRecord } from '../src/record-schema.ts'
import type { Scope } from '../src/scope.ts'
import { checkupEnv, type CheckupEnv } from './helpers/checkup-env.ts'
import { findingModel } from './helpers/finding-model.ts'
import { InMemoryKvTable } from './helpers/in-memory-kv.ts'
import { noInstructions } from './helpers/instructions.ts'
import { record } from './helpers/record.ts'

// 依据已变：决定记下的前提摘要和被依据记忆现在的对不上，代码直接判，挂进待决账本等用户复查

const P1 = '/work/one'
const P2 = '/work/two'
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

const premise = record({ id: 'mem_p', name: '归档容量', content: '归档区容量 10 单位' })
const decision = (premises: MemoryRecord['premises'], partial: Partial<MemoryRecord> = {}) =>
  record({ id: 'mem_d', name: '暂停归档', content: '容量不够，暂停新增归档', premises, ...partial })
const changed = { ...premise, content: '归档区容量扩到 1000 单位' }

describe('判定', () => {
  const lookupOf = (...records: MemoryRecord[]): PremiseLookup => (_owner, id) => records.find(r => r.id === id)

  it('前提此刻的内容摘要和记下的对不上：报一条，memoryIds 是决定和前提，文字里写名称', () => {
    const found = findPremiseChanges([decision([{ id: 'mem_p', digest: premiseDigest(premise) }])], lookupOf(changed))
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ type: 'premise-changed', layer: 'rule', severity: SEVERITY_BY_TYPE['premise-changed'], memoryIds: ['mem_d', 'mem_p'] })
    expect(found[0]!.summary).toContain('暂停归档')
    expect(found[0]!.summary).toContain('归档容量')
    expect(`${found[0]!.summary}${found[0]!.suggestedAction}`).not.toContain('mem_')
  })

  it('摘要一致、前提找不到、决定不在用、没有前提的都不报；同一个前提写了两次只报一次', () => {
    const same = decision([{ id: 'mem_p', digest: premiseDigest(premise) }])
    // 前提：同一条决定在前提改过时确实报
    expect(findPremiseChanges([same], lookupOf(changed))).toHaveLength(1)
    expect(findPremiseChanges([same], lookupOf(premise))).toEqual([])
    expect(findPremiseChanges([same], lookupOf())).toEqual([])
    expect(findPremiseChanges([decision([{ id: 'mem_p', digest: premiseDigest(premise) }], { status: 'deleted' })], lookupOf(changed))).toEqual([])
    expect(findPremiseChanges([record({ id: 'mem_x' })], lookupOf(changed))).toEqual([])
    const twice = decision([{ id: 'mem_p', digest: premiseDigest(premise) }, { id: 'mem_p', digest: premiseDigest(premise) }])
    expect(findPremiseChanges([twice], lookupOf(changed))).toHaveLength(1)
  })

  it('指纹由决定、前提和前提此刻的摘要决定，三者任一变了指纹就变', () => {
    const base = premiseChangeFingerprint('mem_d', 'mem_p', 'digest-1')
    expect(premiseChangeFingerprint('mem_d', 'mem_p', 'digest-1')).toBe(base)
    expect(new Set([
      base,
      premiseChangeFingerprint('mem_e', 'mem_p', 'digest-1'),
      premiseChangeFingerprint('mem_d', 'mem_q', 'digest-1'),
      premiseChangeFingerprint('mem_d', 'mem_p', 'digest-2'),
    ]).size).toBe(4)
  })
})

describe('体检挂账', () => {
  async function seedChanged(e: CheckupEnv): Promise<void> {
    await e.store.put(premise)
    await e.store.put(decision([{ id: 'mem_p', digest: premiseDigest(premise) }]))
    await e.store.put(changed)
  }

  it('只跑规则层也挂账，不调模型；挂成依据已变、带指纹，出现在工具结果里、不进体检视图；决定那条不动', async () => {
    const e = await env()
    await seedChanged(e)
    const before = await e.store.get('mem_d')
    const m = findingModel()
    const r = single(await e.scan({ llm: m, layers: 'rule' }))
    expect(m.users).toEqual([])
    const open = await e.decisions.list()
    expect(open).toHaveLength(1)
    expect(open[0]).toMatchObject({ kind: 'premise-changed', memoryIds: ['mem_d', 'mem_p'], fingerprint: premiseChangeFingerprint('mem_d', 'mem_p', premiseDigest(changed)) })
    expect(r.findings.filter(f => f.type === 'premise-changed').map(f => f.memoryIds)).toEqual([['mem_d', 'mem_p']])
    expect(r.pendingDecisions.items).toMatchObject([{ id: open[0]!.id, kind: 'premise-changed', memoryIds: ['mem_d', 'mem_p'] }])
    expect((await e.view(GLOBAL))?.findings.some(f => f.type === 'premise-changed') ?? false).toBe(false)
    expect(await e.store.get('mem_d')).toEqual(before)
  })

  it('内容检查一起跑时同样挂账，只挂一条', async () => {
    const e = await env()
    await seedChanged(e)
    await e.scan({ llm: findingModel() })
    e.clock.now += 1000
    await e.scan({ llm: findingModel({ model: 'model-b' }) })
    expect((await e.decisions.list()).map(d => d.kind)).toEqual(['premise-changed'])
  })

  it('只跑内容检查（layers=semantic）不判依据已变；同一份数据跑全部（full）时才挂', async () => {
    const e = await env()
    await seedChanged(e)
    const m = findingModel()
    const r = single(await e.scan({ llm: m, layers: 'semantic' }))
    expect(m.batchCalls).toHaveLength(1)
    expect(r.findings.some(f => f.type === 'premise-changed')).toBe(false)
    expect(await e.decisions.list()).toEqual([])
    e.clock.now += 1000
    await e.scan({ llm: m, layers: 'full' })
    expect((await e.decisions.list()).map(d => [d.kind, d.memoryIds])).toEqual([['premise-changed', ['mem_d', 'mem_p']]])
  })

  it('用户忽略之后前提没再变就不再报；前提又改了重新报', async () => {
    const e = await env()
    await seedChanged(e)
    await e.scan({ llm: null, layers: 'rule' })
    const [entry] = await e.decisions.list()
    const deps = { store: e.store, decisions: e.decisions, snapshots: new SnapshotStore(new InMemoryKvTable<MemorySnapshot>()), instructions: noInstructions, now: () => e.clock.now }
    expect(await executeConfirm({ action: 'resolve', decisionId: entry!.id, verdict: 'dismiss' }, { workspacePath: undefined }, deps)).toMatchObject({ kind: 'resolved' })
    e.clock.now += 1000
    await e.scan({ llm: null, layers: 'rule' })
    expect(await e.decisions.list()).toEqual([])
    await e.store.put({ ...changed, content: '归档区容量又缩回 20 单位' })
    e.clock.now += 1000
    await e.scan({ llm: null, layers: 'rule' })
    expect((await e.decisions.list()).map(d => [d.kind, d.memoryIds])).toEqual([['premise-changed', ['mem_d', 'mem_p']]])
  })

  it('项目记忆的前提按作用域找：全局里的前提会查，别的项目里同 id 的不算', async () => {
    const e = await env()
    const globalPremise = record({ id: 'mem_g', name: '全局约定', content: '旧约定' })
    await e.store.put({ ...globalPremise, content: '新约定' })
    const other = record({ id: 'mem_o', name: '别的项目', content: '旧', scope: 'workspace', workspacePath: P2 })
    await e.store.put({ ...other, content: '新' })
    await e.store.put(record({
      id: 'mem_d', name: '项目决定', scope: 'workspace', workspacePath: P1,
      premises: [{ id: 'mem_g', digest: premiseDigest(globalPremise) }, { id: 'mem_o', digest: premiseDigest(other) }],
    }))
    await e.scan({ llm: null, layers: 'rule', target: { kind: 'scope', scope: { kind: 'workspace', workspacePath: P1 } } })
    expect((await e.decisions.list()).map(d => [d.kind, d.memoryIds])).toEqual([['premise-changed', ['mem_d', 'mem_g']]])
  })
})
