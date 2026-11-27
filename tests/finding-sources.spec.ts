import { afterEach, describe, expect, it } from 'vitest'
import { SOURCE_CHECK_LIMIT, type FindingSourceDeps } from '../src/tools/finding-sources.ts'
import type { ReadEventFn, RawEvent } from '../src/tools/source.ts'
import type { PendingDecision } from '../src/governance/schema.ts'
import type { MemoryRecord } from '../src/record-schema.ts'
import type { ScanToolResult, SingleScanResult } from '../src/tools/scan.ts'
import { checkupEnv, type CheckupEnv } from './helpers/checkup-env.ts'
import { findingModel, verifyReply, type FindingModel } from './helpers/finding-model.ts'
import { instructionsOf } from './helpers/instructions.ts'
import { record } from './helpers/record.ts'
import { FAKE_SECRET } from './helpers/secrets.ts'

// 疑似矛盾先读两边出处：横向冲突报出之前读两条各自的那段对话，交给模型再判一次；读不到的一边不判，照报并标明

const envs: CheckupEnv[] = []
afterEach(async () => { for (const e of envs.splice(0)) await e.close() })
async function env(opts: Parameters<typeof checkupEnv>[0] = {}): Promise<CheckupEnv> {
  const e = await checkupEnv(opts)
  envs.push(e)
  return e
}
function single(r: ScanToolResult): SingleScanResult {
  if (r.kind !== 'single') throw new Error(`不是单范围结果：${r.kind}`)
  return r
}

/** 会话里用户说的那句话：出处节选里应能看到它。 */
const saidIn = (sessionId: string) => `${sessionId} 里用户说的原话`
const userEvent = (sessionId: string): RawEvent => ({ type: 'user/message', seq: 1, data: { id: `msg_${sessionId}`, role: 'user', content: [{ type: 'text', text: saidIn(sessionId) }] } })
const toolEvent: RawEvent = { type: 'tool/result', seq: 1, data: { output: '工具输出' } }

/** 宿主读事件的替身：按会话给事件，throws 里的会话抛错；记下读过哪些会话。 */
function fakeHost(opts: { throws?: string[]; empty?: string[]; marked?: string[]; isListBroken?: boolean; isUnavailable?: boolean } = {}) {
  const reads: string[] = []
  const readEvent: ReadEventFn = async (req) => {
    reads.push(req.sessionId)
    if (opts.throws?.includes(req.sessionId)) throw new Error('会话读不出')
    return { events: opts.empty?.includes(req.sessionId) ? [toolEvent] : [userEvent(req.sessionId)] }
  }
  const sources: FindingSourceDeps = {
    readEvent: () => (opts.isUnavailable ? null : readEvent),
    noReview: {
      isMarkedNoReview: async (sessionId) => {
        if (opts.isListBroken) throw new Error('名单读不出')
        return opts.marked?.includes(sessionId) ?? false
      },
    },
  }
  return { reads, sources }
}

const mem = (id: string, partial: Partial<MemoryRecord> = {}) =>
  record({ id, name: `${id} 的名称`, content: `${id} 的正文`, source: { sessionId: `s_${id}`, eventRange: [0, 1], sourceMode: 'user-explicit' }, ...partial })

async function seedPair(e: CheckupEnv, partialB: Partial<MemoryRecord> = {}): Promise<void> {
  await e.store.put(mem('mem_a'))
  await e.store.put(mem('mem_b', partialB))
}
const CONFLICT_AB = { type: 'conflict', ids: ['mem_a', 'mem_b'] }
const only = async (e: CheckupEnv): Promise<PendingDecision> => {
  const open = await e.decisions.list()
  expect(open).toHaveLength(1)
  return open[0]!
}

describe('两边都读得到', () => {
  it('回查判成漏记的变化：改挂成漏记的变化，带回查标记、方案和回查给的文字；两段原话都发给了模型', async () => {
    const e = await env()
    await seedPair(e)
    e.deps.sources = fakeHost().sources
    const m = findingModel({ findings: [CONFLICT_AB] })
    m.verify = () => verifyReply('missed-change', { current: 'mem_b', summary: '出处里 8100 是旧的，后来换成 8200' })
    const r = single(await e.scan({ llm: m }))
    expect(m.verifyCalls).toHaveLength(1)
    expect([...m.verifyCalls[0]!.ids].sort()).toEqual(['mem_a', 'mem_b'])
    expect(m.verifyCalls[0]!.user).toContain(saidIn('s_mem_a'))
    expect(m.verifyCalls[0]!.user).toContain(saidIn('s_mem_b'))
    expect(await only(e)).toMatchObject({ kind: 'missed-change', sourceCheck: 'checked', plan: { kind: 'as-versions', current: 'mem_b' }, summary: '出处里 8100 是旧的，后来换成 8200' })
    expect(r.findings.filter(f => f.type === 'conflict')).toEqual([])
    expect(r.findings.find(f => f.type === 'missed-change')).toMatchObject({ sourceCheck: 'checked', current: 'mem_b' })
  })

  it.each([
    ['conflict', 'conflict'],
    ['exception', 'exception'],
  ])('回查判成 %s：挂成 %s，标为核实过', async (verdict, kind) => {
    const e = await env()
    await seedPair(e)
    e.deps.sources = fakeHost().sources
    const m = findingModel({ findings: [CONFLICT_AB] })
    m.verify = () => verifyReply(verdict)
    await e.scan({ llm: m })
    const entry = await only(e)
    expect([entry.kind ?? 'conflict', entry.sourceCheck]).toEqual([kind, 'checked'])
  })

  it('回查判成不算问题：不挂账，结果里也没有这一对', async () => {
    const e = await env()
    await seedPair(e)
    e.deps.sources = fakeHost().sources
    const m = findingModel({ findings: [CONFLICT_AB, { type: 'unclear', ids: ['mem_a'] }] })
    m.verify = () => verifyReply('none')
    const r = single(await e.scan({ llm: m }))
    expect(m.verifyCalls).toHaveLength(1)
    expect(await e.decisions.list()).toEqual([])
    expect(r.findings.map(f => f.type)).toEqual(['unclear'])
  })
})

describe('有一边读不到', () => {
  it.each<[string, Parameters<typeof fakeHost>[0], Partial<MemoryRecord>]>([
    ['没有出处（手建的）', {}, { source: undefined }],
    ['会话读不出', { throws: ['s_mem_b'] }, {}],
    ['那段对话里没有用户和助手的话', { empty: ['s_mem_b'] }, {}],
    ['宿主给不了读事件', { isUnavailable: true }, {}],
    ['不回看名单读不出', { isListBroken: true }, {}],
  ])('%s：不回查，照报冲突，标为出处读不到', async (_case, host, partialB) => {
    const e = await env()
    await seedPair(e, partialB)
    e.deps.sources = fakeHost(host).sources
    const m = findingModel({ findings: [CONFLICT_AB] })
    await e.scan({ llm: m })
    expect(m.verifyCalls).toEqual([])
    const entry = await only(e)
    expect([entry.kind ?? 'conflict', entry.sourceCheck]).toEqual(['conflict', 'unreadable'])
  })

  it('用户标了不回看的会话：不读，那里的话不发给模型，按出处读不到算', async () => {
    const e = await env()
    await seedPair(e)
    const host = fakeHost({ marked: ['s_mem_b'] })
    e.deps.sources = host.sources
    const m = findingModel({ findings: [CONFLICT_AB] })
    await e.scan({ llm: m })
    expect(host.reads).not.toContain('s_mem_b')
    expect(m.users.some(u => u.includes(saidIn('s_mem_b')))).toBe(false)
    expect(m.verifyCalls).toEqual([])
    expect((await only(e)).sourceCheck).toBe('unreadable')
  })
})

describe('上限与失败', () => {
  it(`一次体检最多回查 ${SOURCE_CHECK_LIMIT} 对，超出的照报冲突，标为这次没读`, async () => {
    const e = await env()
    const pairs = 7
    const findings = []
    for (let i = 0; i < pairs; i++) {
      await e.store.put(mem(`mem_l${i}`))
      await e.store.put(mem(`mem_r${i}`))
      findings.push({ type: 'conflict', ids: [`mem_l${i}`, `mem_r${i}`] })
    }
    e.deps.sources = fakeHost().sources
    const m = findingModel({ findings })
    await e.scan({ llm: m })
    expect(m.verifyCalls).toHaveLength(SOURCE_CHECK_LIMIT)
    const marks = (await e.decisions.list()).map(d => d.sourceCheck).sort()
    expect(marks).toEqual([...Array(SOURCE_CHECK_LIMIT).fill('checked'), ...Array(pairs - SOURCE_CHECK_LIMIT).fill('unchecked')].sort())
  })

  it('读之前就知道读不到的对（一边没有出处）不占回查名额；真去读了、读事件抛错的照旧占', async () => {
    const e = await env()
    const findings = []
    for (let i = 0; i < SOURCE_CHECK_LIMIT; i++) {
      await e.store.put(mem(`mem_l${i}`, { source: undefined }))
      await e.store.put(mem(`mem_r${i}`))
      findings.push({ type: 'conflict', ids: [`mem_l${i}`, `mem_r${i}`] })
    }
    await e.store.put(mem('mem_l9'))
    await e.store.put(mem('mem_r9'))
    findings.push({ type: 'conflict', ids: ['mem_l9', 'mem_r9'] })
    e.deps.sources = fakeHost().sources
    const m = findingModel({ findings })
    await e.scan({ llm: m })
    expect(m.verifyCalls.map(c => [...c.ids].sort())).toEqual([['mem_l9', 'mem_r9']])
    const marks = Object.fromEntries((await e.decisions.list()).map(d => [[...d.memoryIds].sort().join('+'), d.sourceCheck]))
    expect(marks['mem_l9+mem_r9']).toBe('checked')
    expect(Object.values(marks).filter(v => v === 'unreadable')).toHaveLength(SOURCE_CHECK_LIMIT)

    // 读事件抛错是真去读了：前 5 对都读过、都抛错，第 6 对超出名额
    const thrown = await env()
    const thrownFindings = []
    const broken: string[] = []
    for (let i = 0; i < SOURCE_CHECK_LIMIT; i++) {
      await thrown.store.put(mem(`mem_l${i}`))
      await thrown.store.put(mem(`mem_r${i}`))
      broken.push(`s_mem_l${i}`)
      thrownFindings.push({ type: 'conflict', ids: [`mem_l${i}`, `mem_r${i}`] })
    }
    await thrown.store.put(mem('mem_l9'))
    await thrown.store.put(mem('mem_r9'))
    thrownFindings.push({ type: 'conflict', ids: ['mem_l9', 'mem_r9'] })
    const host = fakeHost({ throws: broken })
    thrown.deps.sources = host.sources
    const m2 = findingModel({ findings: thrownFindings })
    await thrown.scan({ llm: m2 })
    expect(broken.every(sid => host.reads.includes(sid))).toBe(true)
    expect(m2.verifyCalls).toEqual([])
    const marks2 = Object.fromEntries((await thrown.decisions.list()).map(d => [[...d.memoryIds].sort().join('+'), d.sourceCheck]))
    expect(marks2['mem_l9+mem_r9']).toBe('unchecked')
    expect(Object.values(marks2).filter(v => v === 'unreadable')).toHaveLength(SOURCE_CHECK_LIMIT)
  })

  it.each<[string, (m: FindingModel) => void]>([
    ['调用出错', m => { m.verify = () => new Error('限流') }],
    ['回复解析不了', m => { m.verify = () => '不是 JSON' }],
    ['回复里的判断不认识', m => { m.verify = () => verifyReply('contradiction') }],
  ])('回查那次%s：照报冲突，标为这次没读，不重试', async (_case, arrange) => {
    const e = await env()
    await seedPair(e)
    e.deps.sources = fakeHost().sources
    const m = findingModel({ findings: [CONFLICT_AB] })
    arrange(m)
    await e.scan({ llm: m })
    expect(m.verifyCalls).toHaveLength(1)
    const entry = await only(e)
    expect([entry.kind ?? 'conflict', entry.sourceCheck]).toEqual(['conflict', 'unchecked'])
  })

  it('回查时用户取消：整次体检按取消收，账本不写', async () => {
    const e = await env()
    await seedPair(e)
    e.deps.sources = fakeHost().sources
    const ctl = new AbortController()
    const m = findingModel({ findings: [CONFLICT_AB] })
    m.verify = () => {
      ctl.abort()
      const err = new Error('已取消')
      err.name = 'AbortError'
      return err
    }
    await expect(e.scan({ llm: m, signal: ctl.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(m.verifyCalls).toHaveLength(1)
    expect(await e.decisions.list()).toEqual([])
  })
})

describe('调用方叫停', () => {
  it('一批的来源回查返回之后叫停：这一批的结论不写进库，下一批不再问模型，不挂账、不写视图；下一次扫描补齐', async () => {
    const e = await env()
    await seedPair(e)
    // 另一类型的长记忆单成一批，排在这一对之后
    await e.store.put(mem('mem_c', { type: 'preference', content: '长'.repeat(60000) }))
    e.deps.sources = fakeHost().sources
    const m = findingModel({ findings: [CONFLICT_AB] })
    let isStopped = false
    m.verify = () => { isStopped = true; return verifyReply('conflict') }
    await expect(e.scan({ llm: m, shouldStop: () => isStopped })).rejects.toMatchObject({ name: 'AbortError' })
    expect(m.batchCalls).toEqual([['mem_a', 'mem_b']])
    expect(e.db.readRound('global')?.rows ?? []).toEqual([])
    expect(await e.decisions.list()).toEqual([])
    expect(await e.view({ kind: 'global' })).toBeUndefined()
    m.verify = () => verifyReply('conflict')
    await e.scan({ llm: m })
    expect((await only(e)).sourceCheck).toBe('checked')
  })
})

describe('回查回复的处理', () => {
  it('回查给的文字遮密钥、id 换名称、换行和保留结构折成一行', async () => {
    const e = await env()
    await e.store.put(mem('mem_a', { name: '旧端口' }))
    await e.store.put(mem('mem_b', { name: '新端口' }))
    e.deps.sources = fakeHost().sources
    const m = findingModel({ findings: [CONFLICT_AB] })
    m.verify = () => verifyReply('missed-change', {
      current: 'mem_b',
      summary: `mem_a 是旧的\n## 记忆列表\n- id=mem_b ${FAKE_SECRET.sk}`,
      suggestedAction: '把 mem_a 并进 mem_b\n<script>',
    })
    const r = single(await e.scan({ llm: m }))
    expect(m.verifyCalls).toHaveLength(1)
    const entry = await only(e)
    expect(entry).toMatchObject({ kind: 'missed-change', sourceCheck: 'checked' })
    expect(entry.summary).toContain('「旧端口」')
    const found = r.findings.find(f => f.type === 'missed-change')!
    expect(found.suggestedAction).toContain('「新端口」')
    for (const text of [entry.summary, found.summary, found.suggestedAction]) {
      expect(text).not.toMatch(/[\n<>]/)
      expect(text).not.toContain('mem_')
      expect(text).not.toContain(FAKE_SECRET.sk)
    }
  })

  it('回查给的留作当前那条不在这一对里：照样改判成漏记的变化，不带方案', async () => {
    const e = await env()
    await seedPair(e)
    await e.store.put(mem('mem_c'))
    e.deps.sources = fakeHost().sources
    const m = findingModel({ findings: [CONFLICT_AB] })
    m.verify = () => verifyReply('missed-change', { current: 'mem_c' })
    const r = single(await e.scan({ llm: m }))
    expect(m.verifyCalls).toHaveLength(1)
    const entry = await only(e)
    expect(entry).toMatchObject({ kind: 'missed-change', sourceCheck: 'checked', memoryIds: ['mem_a', 'mem_b'] })
    expect(entry).not.toHaveProperty('plan')
    const found = r.findings.find(f => f.type === 'missed-change')!
    expect(found).toMatchObject({ memoryIds: ['mem_a', 'mem_b'] })
    expect(found).not.toHaveProperty('current')
  })

  it('同一对再报时，条目上的方案和回查标记换成这次的：这次没给的去掉', async () => {
    const e = await env()
    await seedPair(e)
    e.deps.sources = fakeHost().sources
    const m = findingModel({ findings: [CONFLICT_AB] })
    m.verify = () => verifyReply('missed-change', { current: 'mem_b' })
    await e.scan({ llm: m })
    const first = await only(e)
    expect(first).toMatchObject({ kind: 'missed-change', sourceCheck: 'checked', plan: { kind: 'as-versions', current: 'mem_b' } })
    // 一条改了，这一批重发；这次内容检查直接报漏记的变化、建议留作当前的是另一条，不经回查
    await e.store.put({ ...(await e.store.get('mem_a'))!, content: 'mem_a 的新正文' })
    e.clock.now += 1000
    const m2 = findingModel({ model: 'model-b', findings: [{ type: 'missed-change', ids: ['mem_a', 'mem_b'], current: 'mem_a' }] })
    await e.scan({ llm: m2 })
    expect(m2.batchCalls).toHaveLength(1)
    const second = await only(e)
    expect(second).toMatchObject({ id: first.id, kind: 'missed-change', plan: { kind: 'as-versions', current: 'mem_a' } })
    expect(second).not.toHaveProperty('sourceCheck')
    // 再走一步：这次没给 current，方案也去掉
    await e.store.put({ ...(await e.store.get('mem_a'))!, content: 'mem_a 又改了' })
    e.clock.now += 1000
    const m3 = findingModel({ model: 'model-c', findings: [{ type: 'missed-change', ids: ['mem_a', 'mem_b'] }] })
    await e.scan({ llm: m3 })
    expect(m3.batchCalls).toHaveLength(1)
    const third = await only(e)
    expect(third).toMatchObject({ id: first.id, kind: 'missed-change' })
    expect(third).not.toHaveProperty('plan')
  })
})

describe('沿用与范围', () => {
  it('这一批没变：回查的结论随批存下，下次照用，不再读出处、不再调模型', async () => {
    const e = await env()
    await seedPair(e)
    const host = fakeHost()
    e.deps.sources = host.sources
    const m = findingModel({ findings: [CONFLICT_AB] })
    m.verify = () => verifyReply('missed-change', { current: 'mem_b' })
    await e.scan({ llm: m })
    const readsBefore = host.reads.length
    e.clock.now += 1000
    await e.scan({ llm: m })
    expect([m.batchCalls.length, m.verifyCalls.length, host.reads.length]).toEqual([1, 1, readsBefore])
    expect(await only(e)).toMatchObject({ kind: 'missed-change', sourceCheck: 'checked' })
  })

  it('纵向冲突不回查、不带标记；没给回查依赖时横向冲突也不回查', async () => {
    const e = await env({ instructions: instructionsOf({ global: '端口用 8000' }) })
    await seedPair(e)
    await e.store.put(mem('mem_v'))
    e.deps.sources = fakeHost().sources
    const m = findingModel({ findings: [CONFLICT_AB, { type: 'conflict', ids: ['mem_v'], baselineRef: 'AGENTS.md：端口' }] })
    await e.scan({ llm: m })
    expect(m.verifyCalls.map(c => [...c.ids].sort())).toEqual([['mem_a', 'mem_b']])
    const open = await e.decisions.list()
    expect(open.find(d => d.baselineRef !== undefined)).not.toHaveProperty('sourceCheck')
    expect(open.find(d => d.baselineRef === undefined)?.sourceCheck).toBe('checked')

    const bare = await env()
    await seedPair(bare)
    const m2 = findingModel({ findings: [CONFLICT_AB] })
    await bare.scan({ llm: m2 })
    expect(m2.verifyCalls).toEqual([])
    expect(await only(bare)).not.toHaveProperty('sourceCheck')
  })
})
