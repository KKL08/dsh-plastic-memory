import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { checkupEnv, bigRecord, stubModel, CHECKUP_NOW, type CheckupEnv } from './helpers/checkup-env.ts'
import { instructionsOf } from './helpers/instructions.ts'
import { record } from './helpers/record.ts'
import { fakeExec } from './helpers/exec.ts'
import { renderScanResult, type ScanToolResult } from '../src/tools/scan.ts'
import { executeHealth, renderHealthResult, type HealthToolResult } from '../src/tools/health.ts'
import { coverageText } from '../src/governance/scope-health.ts'
import { checkupKey } from '../src/gui/contract.ts'
import type { ReadInstructions } from '../src/governance/instructions.ts'

// 覆盖怎么说：memory_scan、memory_health 的返回文字。没覆盖全时不说「发现 0 个问题」「记忆库健康」，三种没查到分开说，写最久一次检查的时间。

const PROJECT = '/work/proj'
const envs: CheckupEnv[] = []
afterEach(async () => { for (const e of envs.splice(0)) await e.close() })

async function env(opts: { instructions?: ReadInstructions; tokenCap?: unknown } = {}): Promise<CheckupEnv> {
  const e = await checkupEnv(opts)
  envs.push(e)
  return e
}
async function threeGlobal(e: CheckupEnv): Promise<void> {
  for (const [i, id] of ['mem_g1', 'mem_g2', 'mem_g3'].entries()) await e.store.put(bigRecord({ id, createdAt: 1 + i }))
}
function health(e: CheckupEnv, scope?: string): Promise<HealthToolResult> {
  return executeHealth(scope !== undefined ? { scope } : {}, {
    store: e.store, registry: e.deps.registry, decisions: e.decisions, cache: e.views, checkups: e.checkups,
    thresholds: { actionScoreThreshold: 70, pendingOverdueDays: 7, scanStaleDays: 7 },
    host: { contextOf: async () => ({ workspacePath: undefined }) }, now: () => e.clock.now,
  }, fakeExec())
}
const text = (r: ScanToolResult) => renderScanResult(r)
/** 刚确认过的小记忆：规则层和新鲜度都没有问题。 */
const fresh = (id: string) => record({ id, lastConfirmedAt: CHECKUP_NOW })

describe('部分覆盖', () => {
  it('memory_scan：不说「发现 0 个问题」，写还有几条没查到；覆盖一行分开说三种、停下的原因、最久一次检查的时间', async () => {
    const e = await env({ tokenCap: 1 })
    await threeGlobal(e)
    const first = text(await e.scan({ llm: stubModel() }, { by: 'agent' }))
    expect(first).not.toContain('发现 0 个问题')
    // 长记忆规则层报内容过长：查到的部分有问题
    expect(first).toContain('查到的部分发现 3 个问题，内容检查还有 2 条没查到')
    expect(first).toContain('内容检查共 3 条，这次查了 1 条；从没查过 2 条；到了这次体检的 token 上限，下次接着查')
    // 第二次：第一批命中（写最久一次检查的时间），第二批查了，第三批还没查
    e.clock.now += 1000
    const second = text(await e.scan({ llm: stubModel() }, { by: 'agent' }))
    expect(second).toContain('内容检查共 3 条，这次查了 1 条；从没查过 1 条；到了这次体检的 token 上限，下次接着查；最久一次检查在 2027-01-15')
  })

  it('memory_scan：没覆盖全时按查到的部分说有没有问题', async () => {
    const e = await env({ tokenCap: 1 })
    await threeGlobal(e)
    // 长记忆在规则层报内容过长，这里是有问题的说法；没有问题的说法换一条小记忆看（指令文件取不到，也没覆盖全）
    const r = text(await e.scan({ llm: stubModel() }, { by: 'agent' }))
    expect(r).toMatch(/查到的部分发现 3 个问题，内容检查还有 2 条没查到/)
    const small = await env({ instructions: instructionsOf({ global: { kind: 'unavailable', reason: '读不了' } }) })
    await small.store.put(fresh('mem_a'))
    expect(text(await small.scan({ llm: stubModel() }))).toContain('查到的部分没有发现问题，内容检查没覆盖全')
  })

  it('全库报告：每个范围一行带覆盖，项目写明含全局几条；没覆盖全的范围有一句总的', async () => {
    const e = await env({ tokenCap: 1 })
    await threeGlobal(e)
    await e.store.put(record({ id: 'mem_p1', scope: 'workspace', workspacePath: PROJECT }))
    const r = await e.scan({ llm: stubModel(), target: { kind: 'checkup', workspaces: [PROJECT] } })
    const lines = text(r).split('\n')
    expect(lines[0]).toContain('其中 2 个范围的内容检查没覆盖全（见各行）')
    expect(lines.find(l => l.startsWith('- global：'))).toContain('｜内容检查共 3 条，这次查了 1 条；从没查过 2 条')
    expect(lines.find(l => l.startsWith(`- ${PROJECT}：`))).toContain('｜内容检查共 4 条（含全局 3 条），这次查了 0 条；从没查过 4 条；这次没轮到，下次再查')
  })

  it('memory_health 单范围：带覆盖一行，不说「记忆库健康」，给一条「覆盖不全」的建议', async () => {
    const e = await env({ tokenCap: 1 })
    await threeGlobal(e)
    await e.scan({ llm: stubModel() })
    const r = await health(e)
    if (r.kind !== 'single') throw new Error(r.kind)
    expect(r.recommendationKinds).toContain('checkup-incomplete')
    expect(r.message).not.toContain('记忆库健康')
    expect(r.recommendation).toContain('上次体检的内容检查没覆盖全（2 条还没查），建议再运行一次 memory_scan')
    expect(renderHealthResult(r)).toContain('内容检查共 3 条，这次查了 1 条；从没查过 2 条')
  })

  it('memory_health 全库：每个范围一行带覆盖，没覆盖全的范围有一句建议', async () => {
    const e = await env({ tokenCap: 1 })
    await threeGlobal(e)
    await e.scan({ llm: stubModel() })
    const lines = renderHealthResult(await health(e, 'all')).split('\n')
    expect(lines.find(l => l.startsWith('- global：'))).toContain('｜内容检查共 3 条，这次查了 1 条')
    expect(lines).toContain('1 个范围上次体检的内容检查没覆盖全（见各行），建议再运行一次 memory_scan')
  })

  it('全库 layers=rule：本轮没有内容检查，各行不说「这次查了」；提到的覆盖写明是上次体检的', async () => {
    const e = await env({ tokenCap: 1 })
    await threeGlobal(e)
    await e.scan({ llm: stubModel() })
    e.clock.now += 1000
    const m = stubModel()
    const r = await e.scan({ llm: m, layers: 'rule', target: { kind: 'checkup' } }, { by: 'agent' })
    expect(m.calls).toHaveLength(0)
    const line = text(r).split('\n').find(l => l.startsWith('- global：'))
    expect(line).not.toContain('这次')
    expect(line).toContain('｜上次体检的内容检查共 3 条，查了 1 条；从没查过 2 条')
  })

  it('库这次读不了：三种分不出，统称「还没查」，不说「从没查过」', async () => {
    const e = await env({ tokenCap: 1 })
    await threeGlobal(e)
    e.deps.checkupCache = { ...e.db, readRound: () => undefined, write: () => false, markRecheck: () => false, prune: () => {}, dropRound: () => {}, rounds: () => undefined, retryOpen: () => {} }
    const r = text(await e.scan({ llm: stubModel() }))
    expect(r).toContain('还没查 2 条')
    expect(r).not.toContain('从没查过')
  })
})

describe('全覆盖与指令文件', () => {
  it('全覆盖：memory_scan 照常说「发现 0 个问题」，memory_health 可以说「记忆库健康」', async () => {
    const e = await env()
    await e.store.put(fresh('mem_a'))
    const r = text(await e.scan({ llm: stubModel() }))
    expect(r).toContain('发现 0 个问题')
    expect(r).toContain('内容检查共 1 条，这次查了 1 条')
    const h = await health(e)
    expect(h.kind === 'single' ? h.message : '').toContain('记忆库健康，无需操作')
  })

  it('指令文件取不到、被截断：查完也不说没问题；没有指令文件：可以说', async () => {
    for (const [given, isClear] of [
      [{ kind: 'unavailable' as const, reason: '读不了' }, false],
      [{ kind: 'found' as const, texts: ['前半段'], isTruncated: true }, false],
      [undefined, true],
    ] as const) {
      const e = await env({ instructions: instructionsOf(given === undefined ? {} : { global: given }) })
      await e.store.put(fresh('mem_a'))
      const r = text(await e.scan({ llm: stubModel() }))
      const h = await health(e)
      const label = given?.kind ?? 'none'
      expect(r.includes('发现 0 个问题'), label).toBe(isClear)
      expect(r.includes('查到的部分没有发现问题，内容检查没覆盖全'), label).toBe(!isClear)
      expect(h.kind === 'single' && h.message.includes('记忆库健康'), label).toBe(isClear)
    }
  })
})

describe('上一个发布版写的记录', () => {
  it('完成记录没有覆盖字段：照常说「记忆库健康」，不加覆盖一行', async () => {
    const e = await env()
    await e.store.put(fresh('mem_a'))
    await e.checkups.complete([{ kind: 'global' }], { startedAt: CHECKUP_NOW, completedAt: CHECKUP_NOW, by: 'manual' })
    const h = await health(e)
    if (h.kind !== 'single') throw new Error(h.kind)
    expect(h.message).toContain('记忆库健康，无需操作')
    expect(h).not.toHaveProperty('coverage')
    expect(renderHealthResult(h)).not.toContain('内容检查共')
    expect((await e.checkups.list()).find(x => x.id === checkupKey({ kind: 'global' }))!.completed).not.toHaveProperty('coverage')
  })
})

describe('最久一次检查的日期', () => {
  const saved = process.env.TZ
  beforeAll(() => { process.env.TZ = 'Asia/Shanghai' })
  afterAll(() => { if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved })

  it('按本地日期写（和界面一致）：本地凌晨的检查不写成前一天', () => {
    const at = new Date(2027, 0, 15, 0, 30).getTime()
    const c = { isReadComplete: true, baseline: 'read', total: 2, checkedNow: 0, never: 1, changed: 0, awaiting: 0, oldestCheckedAt: at, stopped: 'cap' } as const
    expect(coverageText(c)).toContain('最久一次检查在 2027-01-15')
  })
})
