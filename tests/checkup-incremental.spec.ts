import { afterEach, describe, expect, it } from 'vitest'
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { checkupEnv, bigRecord, stubModel, findingKeys, CHECKUP_NOW, DAY_MS, type CheckupEnv, type StubModel } from './helpers/checkup-env.ts'
import { record } from './helpers/record.ts'
import { ARCHIVE_DIR, CHECKUP_CACHE_FILE, GLOBAL_DIR, WORKSPACE_MARKER, workspaceDirName } from '../src/storage/paths.ts'
import { encodeRecord } from '../src/storage/frontmatter.ts'
import { CROSS_WS_ROUND, REFRESH_AFTER_MS, SCAN_TOKEN_CAP_DEFAULT } from '../src/governance/checkup-plan.ts'
import { renderScanResult, runScan, type CheckupScanResult, type ScanToolResult, type SingleScanResult } from '../src/tools/scan.ts'
import { checkupKey, isFullyCovered } from '../src/gui/contract.ts'
import type { MemoryRecord } from '../src/record-schema.ts'
import { scopeCacheKey, type Scope } from '../src/scope.ts'
import { executeConfirm } from '../src/tools/confirm.ts'
import { SnapshotStore } from '../src/governance/snapshots.ts'
import type { MemorySnapshot } from '../src/governance/schema.ts'
import { InMemoryKvTable } from './helpers/in-memory-kv.ts'
import { instructionsOf, noInstructions } from './helpers/instructions.ts'
import { SidecarStore } from '../src/storage/sidecar.ts'
import { sidecarSchemas } from './helpers/plugin-env.ts'
import { PendingDecisionsStore } from '../src/governance/decisions.ts'
import type { SemanticLlm } from '../src/governance/semantic-scan.ts'

const GLOBAL: Scope = { kind: 'global' }
const envs: CheckupEnv[] = []
afterEach(async () => { for (const e of envs.splice(0)) await e.close() })

async function env(opts: Parameters<typeof checkupEnv>[0] = {}): Promise<CheckupEnv> {
  const e = await checkupEnv(opts)
  envs.push(e)
  return e
}

function single(r: ScanToolResult): SingleScanResult {
  if (r.kind !== 'single') throw new Error(`expected single, got ${r.kind}`)
  return r
}
function checkup(r: ScanToolResult): CheckupScanResult {
  if (r.kind !== 'checkup') throw new Error(`expected checkup, got ${r.kind}`)
  return r
}
/** 这次体检某一轮的覆盖。 */
function coverageOf(r: ScanToolResult, scope: Scope = GLOBAL) {
  if (r.kind === 'error') throw new Error(r.message)
  const round = r.rounds?.find(x => checkupKey(x.scope) === checkupKey(scope))
  if (round === undefined) throw new Error('这一轮没跑内容检查')
  return round.coverage
}
/** 这次模型调用发出的全部记忆 id（不含重试的重复）。 */
const sentIds = (m: StubModel, from = 0) => new Set(m.calls.slice(from).flat())

/** 直接改库文件里的行（行坏掉、被别处改过）。 */
function rawDb(e: CheckupEnv): DatabaseSync {
  return new DatabaseSync(join(e.root, CHECKUP_CACHE_FILE))
}

/** 三条长记忆、各成一批（同类型，按创建时间分）。 */
async function threeBatches(e: CheckupEnv, extra: Partial<MemoryRecord> = {}): Promise<MemoryRecord[]> {
  const records = [
    bigRecord({ id: 'mem_b1', createdAt: 1, ...extra }),
    bigRecord({ id: 'mem_b2', createdAt: 2, ...extra }),
    bigRecord({ id: 'mem_b3', createdAt: 3, ...extra }),
  ]
  for (const r of records) await e.store.put(r)
  return records
}

/** 全局的最近删除目录读不了（换成同名文件）：这个范围这次没读全，顶层的记忆照常读到。 */
function unreadableArchive(e: CheckupEnv): void {
  writeFileSync(join(e.memoryRoot, GLOBAL_DIR, ARCHIVE_DIR), '')
}

/**
 * 三批：A = 长记忆 b1 + 一对冲突 s1a、s1b；B = 长记忆 b2 + 一对冲突 s2a、s2b；C = 长记忆 b3。同类型按创建时间连续切开。
 */
async function pairedBatches(e: CheckupEnv): Promise<void> {
  const rows: Array<[string, number, boolean]> = [['mem_b1', 1, true], ['mem_s1a', 2, false], ['mem_s1b', 3, false], ['mem_b2', 4, true], ['mem_s2a', 5, false], ['mem_s2b', 6, false], ['mem_b3', 7, true]]
  for (const [id, createdAt, isBig] of rows) await e.store.put(isBig ? bigRecord({ id, createdAt }) : record({ id, name: id, content: `${id} 的正文`, createdAt }))
}
const PAIR_FINDINGS = [
  { type: 'conflict' as const, ids: ['mem_s1a', 'mem_s1b'] },
  { type: 'conflict' as const, ids: ['mem_s2a', 'mem_s2b'] },
]

describe('命中与重查', () => {
  it('模型桩的输出依赖上下文：换模型后重查，视图是新模型的结果；换回去且旧行还在 → 不调模型，视图是旧模型那次的结果', async () => {
    const e = await env()
    await threeBatches(e)
    const findings = [{ type: 'unclear' as const, ids: ['mem_b1'] }, { type: 'unclear' as const, ids: ['mem_b2'] }, { type: 'unclear' as const, ids: ['mem_b3'] }]
    const a = stubModel({ model: 'model-a', findings })
    await e.scan({ llm: a })
    expect(a.calls).toHaveLength(3)
    expect((await e.view(GLOBAL))!.findings.map(f => f.summary)).toEqual(['model-a 查出的问题', 'model-a 查出的问题', 'model-a 查出的问题'])

    // 换模型、上限只够一批：发出的那批是新模型的结论，旧模型的行没清（没全覆盖）
    const b = stubModel({ model: 'model-b', findings })
    e.tokenCap.value = 1
    await e.scan({ llm: b })
    expect(b.calls).toHaveLength(1)
    const summaries = (await e.view(GLOBAL))!.findings.map(f => f.summary)
    expect(summaries.filter(s => s === 'model-b 查出的问题')).toHaveLength(1)

    // 换回去：每批的旧行都在，不调模型，视图是旧模型那次的结论
    const back = stubModel({ model: 'model-a', findings })
    e.tokenCap.value = undefined
    e.clock.now += 1000
    await e.scan({ llm: back })
    expect(back.calls).toHaveLength(0)
    expect((await e.view(GLOBAL))!.findings.map(f => f.summary)).toEqual(['model-a 查出的问题', 'model-a 查出的问题', 'model-a 查出的问题'])
  })

  it('什么都没变：不调模型，视图不变；改名称、摘要、正文、类型、事实时间、有效期任一项，它所在的批重发；只改标签不重发', async () => {
    const e = await env()
    const target = record({ id: 'mem_t', name: '原名', content: '原文', type: 'knowledge' })
    await e.store.put(target)
    await e.store.put(record({ id: 'mem_other', name: '另一条' }))
    const m = stubModel({ findings: [{ type: 'unclear', ids: ['mem_t'] }] })
    await e.scan({ llm: m })
    expect(m.calls).toHaveLength(1)
    const before = await e.view(GLOBAL)
    e.clock.now += 1000
    await e.scan({ llm: m })
    expect(m.calls).toHaveLength(1)
    expect(findingKeys(await e.view(GLOBAL))).toEqual(findingKeys(before))

    const changes: Array<Partial<MemoryRecord>> = [
      { name: '新名' }, { summary: '新摘要' }, { content: '新正文' }, { type: 'preference' }, { factTime: '2026-11' },
      { validTo: CHECKUP_NOW + 365 * DAY_MS }, { validFrom: CHECKUP_NOW + 30 * DAY_MS },
    ]
    let current = target
    for (const change of changes) {
      current = { ...current, ...change }
      await e.store.put(current)
      const from = m.calls.length
      e.clock.now += 1000
      await e.scan({ llm: m })
      expect(sentIds(m, from).has('mem_t'), JSON.stringify(change)).toBe(true)
    }
    await e.store.put({ ...current, tags: ['新标签'] })
    const from = m.calls.length
    e.clock.now += 1000
    await e.scan({ llm: m })
    expect(m.calls.length).toBe(from)
  })

  it('补证只换了模型看不到的（出处会话、事件区间、取代关系，来源方式和改动性质不变）：批照常命中，不调模型', async () => {
    const e = await env()
    const target = record({
      id: 'mem_t', name: '原名', content: '原文',
      source: { sessionId: 'sess_1', eventRange: [0, 1], sourceMode: 'user-explicit' },
      lastChange: { kind: 'corroborate', at: CHECKUP_NOW - DAY_MS, op: 'op_corroborate_1' },
    })
    await e.store.put(target)
    const m = stubModel()
    await e.scan({ llm: m })
    expect(m.calls).toHaveLength(1)
    await e.store.put({
      ...target, updatedAt: CHECKUP_NOW,
      source: { sessionId: 'sess_2', eventRange: [3, 4], sourceMode: 'user-explicit' },
      lastChange: { kind: 'corroborate', at: CHECKUP_NOW, op: 'op_corroborate_2' },
      supersedes: ['mem_old'],
    })
    e.clock.now += 1000
    await e.scan({ llm: m })
    expect(m.calls).toHaveLength(1)
  })

  it('补证改了来源方式或改动性质（模型看得到的线索）：这一批重发一次，之后照常命中', async () => {
    const changes: Array<Partial<MemoryRecord>> = [
      { source: { sessionId: 'sess_2', eventRange: [3, 4], sourceMode: 'agent-inferred' } },
      { lastChange: { kind: 'state-change', at: CHECKUP_NOW, op: 'op_state' } },
    ]
    for (const change of changes) {
      const e = await env()
      const target = record({ id: 'mem_t', name: '原名', content: '原文', source: { sessionId: 'sess_1', eventRange: [0, 1], sourceMode: 'user-explicit' } })
      await e.store.put(target)
      const m = stubModel()
      await e.scan({ llm: m })
      expect(m.calls, JSON.stringify(change)).toHaveLength(1)
      await e.store.put({ ...target, updatedAt: CHECKUP_NOW, ...change })
      e.clock.now += 1000
      await e.scan({ llm: m })
      expect(m.calls, JSON.stringify(change)).toHaveLength(2)
      expect(m.calls[1], JSON.stringify(change)).toContain('mem_t')
      e.clock.now += 1000
      await e.scan({ llm: m })
      expect(m.calls, JSON.stringify(change)).toHaveLength(2)
    }
  })

  it('记忆过期：不进模型、语义发现消失，规则层的过期提示还在；有效期延到未来：重新进；还没生效的照常进', async () => {
    const e = await env()
    const g1 = record({ id: 'mem_g1', name: '甲' })
    await e.store.put(g1)
    await e.store.put(record({ id: 'mem_g2', name: '乙' }))
    await e.store.put(record({ id: 'mem_later', name: '还没生效', validFrom: CHECKUP_NOW + 10 * DAY_MS }))
    const m = stubModel({ findings: [{ type: 'unclear', ids: ['mem_g1'] }] })
    await e.scan({ llm: m })
    expect(sentIds(m)).toEqual(new Set(['mem_g1', 'mem_g2', 'mem_later']))
    expect(findingKeys(await e.view(GLOBAL))).toEqual(['unclear:mem_g1'])

    await e.store.put({ ...g1, validTo: CHECKUP_NOW - 1 })
    e.clock.now += 1000
    const from = m.calls.length
    const r = single(await e.scan({ llm: m }))
    expect(sentIds(m, from).has('mem_g1')).toBe(false)
    expect(findingKeys(await e.view(GLOBAL))).toEqual([])
    expect(r.findings.some(f => f.type === 'expired' && f.memoryIds.includes('mem_g1'))).toBe(true)

    await e.store.put({ ...g1, validTo: CHECKUP_NOW + 100 * DAY_MS })
    e.clock.now += 1000
    const again = m.calls.length
    await e.scan({ llm: m })
    expect(sentIds(m, again).has('mem_g1')).toBe(true)
    expect(findingKeys(await e.view(GLOBAL))).toEqual(['unclear:mem_g1'])
  })

  it('刷新：没命中的批都发完、预算有余时才发到期批，从最旧的开始；预算紧时不发，没命中的批不受它影响', async () => {
    const e = await env()
    const [b1, b2] = await threeBatches(e)
    const m = stubModel()
    await e.scan({ llm: m })
    expect(m.calls.map(c => c[0])).toEqual(['mem_b1', 'mem_b2', 'mem_b3'])

    // 跨过 30 天，上限只够一批：没命中的批（改过的 b2）先走，到期的批不享受第一批的豁免，一批都不刷新
    e.clock.now += REFRESH_AFTER_MS + DAY_MS
    e.tokenCap.value = 1
    for (let i = 0; i < 3; i++) {
      await e.store.put({ ...b2!, content: `${b2!.content}改${i}` })
      const from = m.calls.length
      await e.scan({ llm: m })
      expect(m.calls.slice(from).map(c => c[0])).toEqual(['mem_b2'])
      e.clock.now += DAY_MS
    }

    // 预算够：b1、b3 到期，按检查时间从旧到新刷新
    e.tokenCap.value = undefined
    await e.store.put({ ...b1!, content: `${b1!.content}改` })
    const from = m.calls.length
    await e.scan({ llm: m })
    expect(m.calls.slice(from).map(c => c[0])).toEqual(['mem_b1', 'mem_b3'])
  })
})

describe('刷新失败', () => {
  it('刷新批报模型用不了：只记日志，结果是完成、没有说明，旧结论照用，跨项目比较照跑', async () => {
    const e = await env()
    const [p1, p2] = ['/work/p1', '/work/p2']
    await e.store.put(record({ id: 'mem_g' }))
    await e.store.put(record({ id: 'mem_p1', scope: 'workspace', workspacePath: p1 }))
    await e.store.put(record({ id: 'mem_p2', scope: 'workspace', workspacePath: p2 }))
    const target = { kind: 'checkup' as const, workspaces: [p1, p2] }
    // 第一次：各轮都查过；跨项目比较的输出解析不了，不进库
    const first = stubModel({ findings: [{ type: 'unclear', ids: ['mem_g'] }] })
    first.crossReply = '不是 JSON'
    await e.scan({ llm: first, target })
    const before = await e.view(GLOBAL)

    e.clock.now += REFRESH_AFTER_MS + DAY_MS
    const m = stubModel()
    m.fail = () => Object.assign(new Error('host ACCOUNT_SIGN_IN_REQUIRED'), { code: 'ACCOUNT_SIGN_IN_REQUIRED' })
    const r = checkup(await e.scan({ llm: m, target }))
    expect(m.calls.length).toBeGreaterThan(0)
    expect(r.rounds!.map(x => x.closing)).toEqual(['complete', 'complete', 'complete'])
    expect(r.notes.map(n => n.code)).not.toContain('model-unavailable')
    expect(m.crossCalls).toBe(1)
    expect(r.duplicates.via).toBe('semantic')
    expect(findingKeys(await e.view(GLOBAL))).toEqual(findingKeys(before))
    expect(e.logs.some(l => l.includes('刷新'))).toBe(true)
  })

  it('三批到期刷新、模型用不了：只调了一批（含重试），剩下的刷新这次不再试；其余失败照旧接着试下一批', async () => {
    const e = await env()
    await threeBatches(e)
    await e.scan({ llm: stubModel() })
    e.clock.now += REFRESH_AFTER_MS + DAY_MS
    const m = stubModel()
    m.fail = () => Object.assign(new Error('host ACCOUNT_SIGN_IN_REQUIRED'), { code: 'ACCOUNT_SIGN_IN_REQUIRED' })
    const r = single(await e.scan({ llm: m }))
    expect(m.calls.length).toBeGreaterThan(0)
    expect(new Set(m.calls.map(ids => ids.join('+'))).size).toBe(1)
    expect(r.notes.map(n => n.code)).not.toContain('model-unavailable')
    // 输出解析不了：每批都试
    const other = await env()
    await threeBatches(other)
    await other.scan({ llm: stubModel() })
    other.clock.now += REFRESH_AFTER_MS + DAY_MS
    const bad = stubModel()
    bad.fail = () => 'unparseable'
    await other.scan({ llm: bad })
    expect(new Set(bad.calls.map(ids => ids.join('+'))).size).toBe(3)
  })
})

describe('库', () => {
  it('行的结构校验：JSON 坏了、result_json 是 {}、members_json 是 null、发现引用了批外的 id、checked_at 非法 → 都当没命中重发', async () => {
    const corruptions = [
      "UPDATE checks SET result_json = '{坏'",
      "UPDATE checks SET result_json = '{}'",
      "UPDATE checks SET members_json = 'null'",
      `UPDATE checks SET result_json = '${JSON.stringify([{ type: 'unclear', layer: 'semantic', severity: 'info', memoryIds: ['mem_elsewhere'], summary: 'x', suggestedAction: 'y' }])}'`,
      'UPDATE checks SET checked_at = -5',
      "UPDATE checks SET checked_at = 'later'",
    ]
    for (const sql of corruptions) {
      const e = await env()
      await e.store.put(record({ id: 'mem_g1' }))
      const m = stubModel({ findings: [{ type: 'unclear', ids: ['mem_g1'] }] })
      await e.scan({ llm: m })
      const db = rawDb(e)
      db.exec(sql)
      db.close()
      e.clock.now += 1000
      await e.scan({ llm: m })
      expect(m.calls, sql).toHaveLength(2)
      expect(findingKeys(await e.view(GLOBAL)), sql).toEqual(['unclear:mem_g1'])
    }
  })

  it('库打不开：体检照常查完并发布，下次全部重发', async () => {
    const e = await env()
    // 库文件的位置是个目录：打不开
    await mkdir(join(e.root, CHECKUP_CACHE_FILE), { recursive: true })
    await e.store.put(record({ id: 'mem_g1' }))
    const m = stubModel({ findings: [{ type: 'unclear', ids: ['mem_g1'] }] })
    const r = single(await e.scan({ llm: m }))
    expect(findingKeys(await e.view(GLOBAL))).toEqual(['unclear:mem_g1'])
    expect(coverageOf(r)).toMatchObject({ checkedNow: 1, isHistoryUnknown: true })
    e.clock.now += 1000
    await e.scan({ llm: m })
    expect(m.calls).toHaveLength(2)
    expect(e.logs.some(l => l.includes('体检结果库不可用'))).toBe(true)
  })

  it('库这次打不开（不是忙）只影响这一次体检：这次只记一条日志；打不开的原因没了，下一次体检用上库，再下一次命中', async () => {
    const e = await env()
    await mkdir(join(e.root, CHECKUP_CACHE_FILE), { recursive: true })
    await e.store.put(record({ id: 'mem_g1' }))
    await e.store.put(record({ id: 'mem_g2', type: 'feedback' }))
    const m = stubModel()
    await e.scan({ llm: m })
    expect(e.logs.filter(l => l.includes('体检结果库不可用'))).toHaveLength(1)
    await rm(join(e.root, CHECKUP_CACHE_FILE), { recursive: true })
    e.clock.now += 1000
    await e.scan({ llm: m })
    const sent = m.calls.length
    e.clock.now += 1000
    await e.scan({ llm: m })
    expect(m.calls).toHaveLength(sent)
  })

  it('库被独占：体检照常查完并发布，下次全部重发', async () => {
    const e = await env()
    await e.store.put(record({ id: 'mem_g1' }))
    // 别的连接以独占模式占住库，这个实例打开时一直忙
    const holder = rawDb(e)
    holder.exec('PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS held(x); COMMIT; BEGIN EXCLUSIVE')
    try {
      const m = stubModel({ findings: [{ type: 'unclear', ids: ['mem_g1'] }] })
      await e.scan({ llm: m })
      expect(findingKeys(await e.view(GLOBAL))).toEqual(['unclear:mem_g1'])
      e.clock.now += 1000
      await e.scan({ llm: m })
      expect(m.calls).toHaveLength(2)
    } finally {
      holder.exec('ROLLBACK')
      holder.close()
    }
  })

  it('只有写失败（读得了）：这次照常完成、日志一条，下次这些批重发', async () => {
    const e = await env()
    await e.store.put(record({ id: 'mem_g1' }))
    const m = stubModel({ findings: [{ type: 'unclear', ids: ['mem_g1'] }] })
    // 先建好库、读一次，再让别的连接占着写锁：读照常，写在等锁超时后失败
    expect(e.db.readRound('global')).toEqual({ rows: [], recheckBefore: 0 })
    const holder = rawDb(e)
    holder.exec('BEGIN IMMEDIATE')
    try {
      const r = single(await e.scan({ llm: m }))
      expect(r.findings.map(f => f.type)).toContain('unclear')
      expect(findingKeys(await e.view(GLOBAL))).toEqual(['unclear:mem_g1'])
      expect(e.logs.filter(l => l.includes('体检结果库写失败'))).toHaveLength(1)
    } finally {
      holder.exec('ROLLBACK')
      holder.close()
    }
    e.clock.now += 1000
    await e.scan({ llm: m })
    expect(m.calls).toHaveLength(2)
  })

  it('全覆盖状态下只删视图：下次体检不调模型，视图和之前一样；只删库：全部重发，发现和之前一样', async () => {
    const e = await env()
    await threeBatches(e)
    const m = stubModel({ findings: [{ type: 'unclear', ids: ['mem_b2'] }] })
    expect(isFullyCovered(coverageOf(await e.scan({ llm: m })))).toBe(true)
    const before = findingKeys(await e.view(GLOBAL))
    await e.views.delete('global')
    e.clock.now += 1000
    await e.scan({ llm: m })
    expect(m.calls).toHaveLength(3)
    expect(findingKeys(await e.view(GLOBAL))).toEqual(before)

    e.db.close()
    await rm(join(e.root, CHECKUP_CACHE_FILE))
    e.clock.now += 1000
    await e.scan({ llm: m })
    expect(m.calls).toHaveLength(6)
    expect(findingKeys(await e.view(GLOBAL))).toEqual(before)
  })

  it('手删一条记忆的文件：范围读全、全覆盖后，它的发现不在视图里，库里过时的行被清掉', async () => {
    const e = await env()
    const [, b2] = await threeBatches(e)
    const m = stubModel({ findings: [{ type: 'unclear', ids: ['mem_b2'] }] })
    await e.scan({ llm: m })
    expect(e.db.readRound('global')!.rows).toHaveLength(3)
    await e.store.hardDelete(b2!)
    e.clock.now += 1000
    expect(isFullyCovered(coverageOf(await e.scan({ llm: m })))).toBe(true)
    expect(findingKeys(await e.view(GLOBAL))).toEqual([])
    expect(e.db.readRound('global')!.rows.map(r => r.members.map(([copy]) => copy).join())).not.toContain(expect.stringContaining('mem_b2'))
    expect(e.db.readRound('global')!.rows).toHaveLength(2)
  })

  it('手删一条记忆的文件，范围读不全：不清库、不写完成记录，读不到的那条的旧发现还在视图里', async () => {
    const e = await env()
    const [, b2] = await threeBatches(e)
    const m = stubModel({ findings: [{ type: 'unclear', ids: ['mem_b2'] }] })
    await e.scan({ llm: m })
    const completed = (await e.checkups.list())[0]!.completed
    await e.store.hardDelete(b2!)
    unreadableArchive(e)
    e.clock.now += 1000
    const r = single(await e.scan({ llm: m }))
    expect(coverageOf(r).isReadComplete).toBe(false)
    expect(r.rounds![0]!.closing).toBe('read-incomplete')
    expect(findingKeys(await e.view(GLOBAL))).toEqual(['unclear:mem_b2'])
    expect(e.db.readRound('global')!.rows).toHaveLength(3)
    expect((await e.checkups.list())[0]!.completed).toEqual(completed)
  })

  it('有读不出的记忆文件（坏文件）：不算没读全，照常全覆盖、清库、写完成记录；规则层报坏文件', async () => {
    const e = await env()
    const [, b2] = await threeBatches(e)
    await e.scan({ llm: stubModel() })
    await e.store.hardDelete(b2!)
    await writeFile(join(e.memoryRoot, GLOBAL_DIR, 'broken.md'), '没有 frontmatter\n')
    e.clock.now += 1000
    const r = single(await e.scan({ llm: stubModel() }))
    expect(r.rounds![0]!.closing).toBe('complete')
    expect(isFullyCovered(coverageOf(r))).toBe(true)
    expect(e.db.readRound('global')!.rows).toHaveLength(2)
    expect((await e.checkups.list())[0]!.completed?.startedAt).toBe(e.clock.now)
    expect(r.findings.map(f => f.type)).toContain('malformed')
  })

  it('全库体检时一个项目读取抛错：体检照常结束，那个项目记没读全，别的范围的结果都在', async () => {
    const e = await env()
    const [p1, p2] = ['/work/p1', '/work/p2']
    await e.store.put(record({ id: 'mem_g' }))
    await e.store.put(record({ id: 'mem_p1', scope: 'workspace', workspacePath: p1 }))
    await e.store.put(record({ id: 'mem_p2', scope: 'workspace', workspacePath: p2 }))
    const readRaw = e.store.readRaw.bind(e.store)
    e.store.readRaw = async (scope, opts) => {
      if (scope?.kind === 'workspace' && scope.workspacePath === p2) throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
      return readRaw(scope, opts)
    }
    const r = checkup(await e.scan({ llm: stubModel(), target: { kind: 'checkup', workspaces: [p1, p2] } }))
    expect(r.rows.map(row => row.workspacePath ?? row.layer)).toEqual(['global', p1, p2])
    expect(coverageOf(r, { kind: 'workspace', workspacePath: p2 }).isReadComplete).toBe(false)
    expect(isFullyCovered(coverageOf(r, { kind: 'workspace', workspacePath: p1 }))).toBe(true)
    expect(await e.view({ kind: 'workspace', workspacePath: p1 })).toBeDefined()
  })

  it('不指定项目的全库体检、一个项目读取抛错：它照样在报告里、记没读全，跨项目比较的旧行不清', async () => {
    const e = await env()
    const [p1, p2, p3] = ['/work/p1', '/work/p2', '/work/p3']
    await e.store.put(record({ id: 'mem_g' }))
    for (const [id, ws] of [['mem_p1', p1], ['mem_p2', p2], ['mem_p3', p3]] as const) await e.store.put(record({ id, scope: 'workspace', workspacePath: ws }))
    const all = { kind: 'checkup' as const }
    const m = stubModel()
    await e.scan({ llm: m, target: all })
    const crossKeys = e.db.readRound(CROSS_WS_ROUND)!.rows.map(row => row.key)
    expect(crossKeys).toHaveLength(1)
    const completedOf = async (ws: string) => (await e.checkups.list()).find(c => c.id === ws)?.completed?.completedAt
    const p2Completed = await completedOf(p2)
    const readRaw = e.store.readRaw.bind(e.store)
    e.store.readRaw = async (scope, opts) => {
      if (scope?.kind === 'workspace' && scope.workspacePath === p2) throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
      return readRaw(scope, opts)
    }
    e.clock.now += 1000
    const r = checkup(await e.scan({ llm: m, target: all }))
    expect(r.rows.map(row => row.workspacePath ?? row.layer)).toEqual(['global', p1, p2, p3])
    expect(coverageOf(r, { kind: 'workspace', workspacePath: p2 }).isReadComplete).toBe(false)
    expect(renderScanResult(r)).toContain(p2)
    expect(e.db.readRound(CROSS_WS_ROUND)!.rows.map(row => row.key)).toEqual(expect.arrayContaining(crossKeys))
    // 没读全：不写这次的完成记录，上次的留着
    expect(await completedOf(p2)).toBe(p2Completed)
    expect(await completedOf(p1)).toBeGreaterThan(p2Completed!)
  })

  it('不指定项目的全库体检、一个项目的标记读得到但记忆目录列不出：它在报告里、记没读全；跨项目比较的旧行、它那一轮的旧行和视图、提升候选都不清，完成记录不写', async () => {
    const e = await env()
    const [p1, p2, p3] = ['/work/p1', '/work/p2', '/work/p3']
    const locked: Scope = { kind: 'workspace', workspacePath: p3 }
    await e.store.put(record({ id: 'mem_g' }))
    for (const [id, ws] of [['mem_p1', p1], ['mem_p2', p2], ['mem_p3', p3]] as const) {
      await e.store.put(record({ id, scope: 'workspace', workspacePath: ws, globalCandidate: ws === p3 }))
    }
    const all = { kind: 'checkup' as const }
    const m = stubModel({ findings: [{ type: 'unclear', ids: ['mem_p3'] }] })
    await e.scan({ llm: m, target: all })
    const crossKeys = e.db.readRound(CROSS_WS_ROUND)!.rows.map(row => row.key)
    const lockedKeys = e.db.readRound(p3)!.rows.map(row => row.key)
    expect(findingKeys(await e.view(locked))).toEqual(['unclear:mem_p3'])
    const completedOf = async (ws: string) => (await e.checkups.list()).find(c => c.id === ws)?.completed?.completedAt
    const lockedCompleted = await completedOf(p3)
    const candidates = async () => (await e.decisions.list()).filter(d => d.kind === 'promote-candidate').map(d => d.memoryIds)
    expect(await candidates()).toEqual([['mem_p3']])
    // 只留执行权限：标记文件按名字读得到，目录里有什么列不出来
    const dir = join(e.memoryRoot, workspaceDirName(p3))
    await chmod(dir, 0o111)
    try {
      e.clock.now += 1000
      const r = checkup(await e.scan({ llm: m, target: all }))
      expect(r.rows.map(row => row.workspacePath ?? row.layer)).toEqual(['global', p1, p2, p3])
      expect(coverageOf(r, locked).isReadComplete).toBe(false)
      expect(r.rounds!.find(x => checkupKey(x.scope) === p3)!.closing).toBe('read-incomplete')
      expect(renderScanResult(r).split('\n').find(l => l.startsWith(`- ${p3}：`))).toContain('这个范围没读全')
      // 同一个目录的说明只列一次
      expect(r.directoryNotes.filter(n => n.code === 'dir-unreadable')).toHaveLength(1)
      expect(e.db.readRound(CROSS_WS_ROUND)!.rows.map(row => row.key)).toEqual(expect.arrayContaining(crossKeys))
      expect(e.db.readRound(p3)!.rows.map(row => row.key)).toEqual(expect.arrayContaining(lockedKeys))
      expect(findingKeys(await e.view(locked))).toEqual(['unclear:mem_p3'])
      expect(await completedOf(p3)).toBe(lockedCompleted)
      expect(await completedOf(p1)).toBeGreaterThan(lockedCompleted!)
      expect(await candidates()).toEqual([['mem_p3']])
    } finally {
      await chmod(dir, 0o700)
    }
  })

  it('同步提升候选时排在前面的项目读取抛错：后面项目的候选照常入账，记一条日志', async () => {
    const e = await env()
    const [pa, pb] = ['/work/a', '/work/b']
    await e.store.put(record({ id: 'mem_a', scope: 'workspace', workspacePath: pa }))
    await e.store.put(record({ id: 'mem_b', scope: 'workspace', workspacePath: pb, globalCandidate: true }))
    const readRaw = e.store.readRaw.bind(e.store)
    e.store.readRaw = async (scope, opts) => {
      if (scope?.kind === 'workspace' && scope.workspacePath === pa) throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
      return readRaw(scope, opts)
    }
    await e.scan({ llm: stubModel(), target: { kind: 'checkup' } })
    expect((await e.decisions.list()).filter(d => d.kind === 'promote-candidate').map(d => d.memoryIds)).toEqual([['mem_b']])
    expect(e.logs.some(l => l.includes('提升候选') && l.includes(pa))).toBe(true)
  })

  it('不指定项目的全库体检、一个项目只有坏文件：它在报告里', async () => {
    const e = await env()
    const [p1, p2] = ['/work/p1', '/work/p2']
    await e.store.put(record({ id: 'mem_g' }))
    await e.store.put(record({ id: 'mem_p1', scope: 'workspace', workspacePath: p1 }))
    const dir = join(e.memoryRoot, workspaceDirName(p2))
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, WORKSPACE_MARKER), p2 + '\n')
    await writeFile(join(dir, 'broken.md'), '没有 frontmatter\n')
    const r = checkup(await e.scan({ llm: stubModel(), target: { kind: 'checkup' } }))
    expect(r.rows.map(row => row.workspacePath ?? row.layer)).toEqual(['global', p1, p2])
  })

  it('全库 layers=rule 不碰库：项目已经不在了的那一轮也不清；跑内容检查的全库体检才清', async () => {
    const e = await env()
    await e.store.put(record({ id: 'mem_a' }))
    // 项目文件夹不在（上级在）：判为真的不在了
    await mkdir(join(e.root, 'projects'), { recursive: true })
    const gone = join(e.root, 'projects', 'gone')
    e.db.write(gone, { key: 'k', checkedAt: 1, members: [[JSON.stringify([gone, 'mem_p']), 'fp']], result: [] })
    await e.scan({ llm: stubModel(), layers: 'rule', target: { kind: 'checkup' } })
    expect(e.db.rounds()).toEqual([gone])
    await e.scan({ llm: stubModel(), target: { kind: 'checkup' } })
    expect(e.db.rounds()).not.toContain(gone)
  })

  it('记忆删光但项目文件夹还在：不占预算、视图不带覆盖、库里的行不动；项目真的不在了：全库体检后库里没有它那一轮的行', async () => {
    const e = await env()
    // 项目文件夹不在（上级在）：删掉记忆目录后判为真的不在了
    const project = join(e.root, 'projects', 'gone')
    await mkdir(join(e.root, 'projects'), { recursive: true })
    const own = record({ id: 'mem_p1', scope: 'workspace', workspacePath: project })
    await e.store.put(own)
    await e.store.put(record({ id: 'mem_g1' }))
    const m = stubModel()
    await e.scan({ llm: m, target: { kind: 'checkup', workspaces: [project] } })
    const rowsBefore = e.db.readRound(project)!.rows
    expect(rowsBefore).toHaveLength(1)

    await e.store.hardDelete(own)
    e.clock.now += 1000
    const from = m.calls.length
    // 删光记忆的项目不进体检清单（目录还在）
    const r = checkup(await e.scan({ llm: m, target: { kind: 'checkup' } }))
    expect(m.calls.length).toBe(from)
    expect(r.rounds?.some(x => x.scope.kind === 'workspace')).toBe(false)
    expect(e.db.readRound(project)!.rows).toEqual(rowsBefore)

    await rm(join(e.memoryRoot, workspaceDirName(project)), { recursive: true })
    e.clock.now += 1000
    await e.scan({ llm: m, target: { kind: 'checkup' } })
    expect(e.db.rounds()).not.toContain(project)
  })
})

describe('上限、沿用', () => {
  it('到上限停下：成功的批写了、其余没写，下次接着，有限次后全覆盖；第一批超上限照发，只豁免这一批', async () => {
    const e = await env({ tokenCap: 20_000 })
    await threeBatches(e)
    const m = stubModel()
    const first = await e.scan({ llm: m })
    expect(m.calls).toHaveLength(1)
    expect(e.db.readRound('global')!.rows).toHaveLength(1)
    expect(coverageOf(first)).toMatchObject({ stopped: 'cap', checkedNow: 1, never: 2 })
    let runs = 1
    while (!isFullyCovered(coverageOf(await e.scan({ llm: m })))) {
      runs++
      e.clock.now += 1000
      expect(runs).toBeLessThan(5)
    }
    expect(m.calls).toHaveLength(3)
    expect(e.db.readRound('global')!.rows).toHaveLength(3)
  })

  it('全库多轮共用一个上限、轮流取批：后面的范围有限次内轮得到', async () => {
    const e = await env({ tokenCap: 1 })
    const project = '/work/proj'
    await threeBatches(e)
    for (const [i, id] of ['mem_p1', 'mem_p2'].entries()) await e.store.put(bigRecord({ id, scope: 'workspace', workspacePath: project, createdAt: 10 + i }))
    const m = stubModel()
    const covered = new Set<string>()
    for (let run = 0; run < 12 && covered.size < 2; run++) {
      const r = checkup(await e.scan({ llm: m, target: { kind: 'checkup', workspaces: [project] } }))
      expect(m.calls.length).toBe(run + 1)
      for (const round of r.rounds ?? []) if (isFullyCovered(round.coverage)) covered.add(checkupKey(round.scope))
      e.clock.now += 1000
    }
    expect(covered).toEqual(new Set(['global', project]))
  })

  it('上限配成 0、负数、字符串：用默认值，记一条日志', async () => {
    for (const cap of [0, -5, 'abc']) {
      const e = await env({ tokenCap: cap })
      await threeBatches(e)
      const m = stubModel()
      await e.scan({ llm: m })
      expect(m.calls, String(cap)).toHaveLength(3)
      expect(e.logs.some(l => l.includes(`默认值 ${SCAN_TOKEN_CAP_DEFAULT}`)), String(cap)).toBe(true)
    }
  })

  it('改了指令文件后被上限打断：没查到的批的旧发现还在视图里，覆盖记「等着重查」，这些发现没有被重新挂账', async () => {
    let rules = '规则一'
    const e = await env({ instructions: instructionsOf({ global: () => rules }) })
    await pairedBatches(e)
    const m = stubModel({ findings: PAIR_FINDINGS })
    await e.scan({ llm: m })
    const ledgerBefore = await e.decisions.list()
    expect(ledgerBefore).toHaveLength(2)
    const pairOf = (ids: string[]) => ledgerBefore.find(d => d.memoryIds.includes(ids[0]!))!

    rules = '规则二'
    e.tokenCap.value = 1
    e.clock.now += 1000
    const r = await e.scan({ llm: m })
    expect(m.calls).toHaveLength(4)
    expect(findingKeys(await e.view(GLOBAL))).toEqual(['conflict:mem_s1a+mem_s1b', 'conflict:mem_s2a+mem_s2b'])
    expect(coverageOf(r)).toMatchObject({ stopped: 'cap', never: 0, changed: 0, awaiting: 4 })
    const ledgerAfter = await e.decisions.list()
    // 没查到的那对：条目原样（没有被重新挂账）
    expect(ledgerAfter.find(d => d.id === pairOf(['mem_s2a']).id)).toEqual(pairOf(['mem_s2a']))
  })

  it('沿用的冲突已被裁决过：视图里照旧有（读侧按账本核对），memory_scan 的返回里不再列出', async () => {
    let rules = '规则一'
    const e = await env({ instructions: instructionsOf({ global: () => rules }) })
    await pairedBatches(e)
    const m = stubModel({ findings: PAIR_FINDINGS })
    await e.scan({ llm: m })
    const settled = (await e.decisions.list()).find(d => d.memoryIds.includes('mem_s2a'))!
    expect((await executeConfirm({ action: 'resolve', decisionId: settled.id, verdict: 'keep-both' }, { workspacePath: undefined }, {
      store: e.store, decisions: e.decisions, snapshots: new SnapshotStore(new InMemoryKvTable<MemorySnapshot>()), instructions: noInstructions, now: () => e.clock.now,
    })).kind).toBe('resolved')
    // 指令文件改了、上限只够一批：s2 那一对所在的批没查到，它的冲突是沿用的
    rules = '规则二'
    e.tokenCap.value = 1
    e.clock.now += 1000
    const r = single(await e.scan({ llm: m }))
    expect(findingKeys(await e.view(GLOBAL))).toContain('conflict:mem_s2a+mem_s2b')
    expect(r.findings.filter(f => f.type === 'conflict').map(f => f.memoryIds.join('+'))).toEqual(['mem_s1a+mem_s1b'])
  })

  it('更新的行已经查过同一组记忆、没有这条发现：更旧的行里的这条不再沿用', async () => {
    const e = await env()
    await threeBatches(e)
    const unclear = [{ type: 'unclear' as const, ids: ['mem_b2'] }]
    await e.scan({ llm: stubModel({ findings: unclear }) })
    // 换模型，上限只够一批：两次查完 b1、b2，b2 这次没有发现；b3 没查到，库里新旧两份行都在
    e.tokenCap.value = 1
    const b = stubModel({ model: 'model-b' })
    for (let i = 0; i < 2; i++) {
      e.clock.now += 1000
      await e.scan({ llm: b })
    }
    expect(findingKeys(await e.view(GLOBAL))).toEqual([])
    // 全部重查被上限打断在 b1：model-a 那一行里 b2 的旧发现不能复活
    e.clock.now += 1000
    await e.scan({ llm: b, isFullRecheck: true })
    expect(findingKeys(await e.view(GLOBAL))).toEqual([])
  })

  it('项目读不全时，读不到的那份按读不到算：同 id 在全局另有一份，不当成这份已删', async () => {
    const e = await env()
    const project: Scope = { kind: 'workspace', workspacePath: '/work/p' }
    await e.store.put(record({ id: 'mem_x', name: '项目那份', scope: 'workspace', workspacePath: '/work/p' }))
    // 同 id 的全局那份直接写文件（写入路径会把同 id 当成同一条）
    await mkdir(join(e.memoryRoot, GLOBAL_DIR), { recursive: true })
    await writeFile(join(e.memoryRoot, GLOBAL_DIR, 'mem-x.md'), encodeRecord(record({ id: 'mem_x', name: '全局那份' }), {}), 'utf8')
    await e.scan({ llm: stubModel({ findings: [{ type: 'unclear', ids: ['mem_x'] }] }), target: { kind: 'scope', scope: project } })
    expect(findingKeys(await e.view(project))).toEqual(['unclear:mem_x'])
    const readRaw = e.store.readRaw.bind(e.store)
    e.store.readRaw = async (scope, opts) => {
      if (scope?.kind === 'workspace') throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
      return readRaw(scope, opts)
    }
    e.clock.now += 1000
    const r = single(await e.scan({ llm: stubModel(), target: { kind: 'scope', scope: project } }))
    expect(coverageOf(r, project).isReadComplete).toBe(false)
    expect(findingKeys(await e.view(project))).toEqual(['unclear:mem_x'])
  })

  it('项目读全、全局读不全：项目里已删掉的那条按删了算，旧发现不沿用（视图和返回里都没有）', async () => {
    const e = await env()
    const project: Scope = { kind: 'workspace', workspacePath: '/work/p' }
    const target = { kind: 'scope' as const, scope: project }
    const gone = record({ id: 'mem_old', scope: 'workspace', workspacePath: '/work/p' })
    await e.store.put(gone)
    await e.store.put(record({ id: 'mem_keep', scope: 'workspace', workspacePath: '/work/p' }))
    await e.scan({ target, llm: stubModel({ findings: [{ type: 'unclear', ids: ['mem_old'] }] }) })
    expect(findingKeys(await e.view(project))).toEqual(['unclear:mem_old'])
    await e.store.hardDelete(gone)
    const readRaw = e.store.readRaw.bind(e.store)
    e.store.readRaw = async (scope, opts) => {
      if (scope?.kind === 'global') throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
      return readRaw(scope, opts)
    }
    e.clock.now += 1000
    const r = single(await e.scan({ target, llm: stubModel() }))
    expect(coverageOf(r, project).isReadComplete).toBe(false)
    expect(findingKeys(await e.view(project))).toEqual([])
    expect(r.findings.filter(f => f.type === 'unclear')).toEqual([])
  })

  it('没查到的批里有一条改过：引用它的旧发现不沿用，覆盖记「改过还没重查」；从没进过库的新记忆记「从没查过」', async () => {
    const e = await env()
    await pairedBatches(e)
    const m = stubModel({ findings: PAIR_FINDINGS })
    await e.scan({ llm: m })
    // b1 改了（A 没命中），s2a 改了、新记忆 n1 进了 B（B 没命中）；上限只够一批：A 发、B 没查到
    const b1 = (await e.store.get('mem_b1'))!
    const s2a = (await e.store.get('mem_s2a'))!
    await e.store.put({ ...b1, content: `${b1.content}改` })
    await e.store.put({ ...s2a, content: '改过的正文' })
    await e.store.put(record({ id: 'mem_n1', name: 'mem_n1', createdAt: 5 }))
    e.tokenCap.value = 1
    e.clock.now += 1000
    const r = await e.scan({ llm: m })
    expect(coverageOf(r)).toMatchObject({ stopped: 'cap', never: 1, changed: 1, awaiting: 2 })
    expect(findingKeys(await e.view(GLOBAL))).toEqual(['conflict:mem_s1a+mem_s1b'])
  })

  it('零发现的批查过之后换模型被打断：它的成员记「等着重查」，不是「从没查过」', async () => {
    const e = await env()
    await threeBatches(e)
    await e.scan({ llm: stubModel() })
    e.tokenCap.value = 1
    e.clock.now += 1000
    const r = await e.scan({ llm: stubModel({ model: 'model-b' }) })
    expect(coverageOf(r)).toMatchObject({ checkedNow: 1, never: 0, changed: 0, awaiting: 2 })
  })

  /** 两条小记忆查过一次；之后改一条，库里留下一行过时的；账本里放一条全局记忆的遗留垂直条目。 */
  async function staleRowAndVertical(e: CheckupEnv): Promise<void> {
    await e.store.put(record({ id: 'mem_a', content: '原文' }))
    await e.store.put(record({ id: 'mem_b' }))
    await e.scan({ llm: stubModel() })
    await e.store.put(record({ id: 'mem_a', content: '改过' }))
    await e.pending.put('pd_stale', {
      id: 'pd_stale', memoryIds: ['mem_a'], baselineRef: '旧的指令文件', summary: '遗留的垂直条目', firstSeenAt: 1, fingerprint: '对不上的指纹',
    })
    e.clock.now += 1000
  }

  it('挂完账、写视图之前收到取消：取消往上抛，视图和完成记录都不写；已挂的账留着', async () => {
    const e = await env()
    await e.store.put(record({ id: 'mem_a' }))
    await e.store.put(record({ id: 'mem_b' }))
    const controller = new AbortController()
    const upsert = e.decisions.upsert.bind(e.decisions)
    // 挂账刚做完时插件卸载或认领被接手
    e.decisions.upsert = async (...args) => {
      const r = await upsert(...args)
      controller.abort()
      return r
    }
    const m = stubModel({ findings: [{ type: 'conflict', ids: ['mem_a', 'mem_b'] }] })
    await expect(e.scan({ llm: m, signal: controller.signal })).rejects.toThrow()
    expect(await e.view(GLOBAL)).toBeUndefined()
    expect((await e.checkups.list())[0]?.completed).toBeUndefined()
    expect((await e.decisions.list()).map(d => [...d.memoryIds].sort())).toEqual([['mem_a', 'mem_b']])
  })

  it('写视图出错（提交没成）：不清库、不清遗留垂直条目、不报已提交', async () => {
    const e = await env()
    await staleRowAndVertical(e)
    e.views.update = async () => { throw new Error('disk full') }
    let isCommitted = false
    const r = await runScan({ target: { kind: 'scope', scope: GLOBAL }, llm: stubModel(), startedAt: e.clock.now }, e.deps, { onCommitted: () => { isCommitted = true } })
    expect(r.kind === 'single' && r.rounds![0]!.closing).toBe('failed')
    expect(e.db.readRound('global')!.rows).toHaveLength(2)
    expect((await e.decisions.list()).map(d => d.id)).toEqual(['pd_stale'])
    expect(isCommitted).toBe(false)
  })

  it('这一轮有一批写不进库：全覆盖也不清库里过时的行', async () => {
    const e = await env()
    await staleRowAndVertical(e)
    e.deps.checkupCache = { ...e.db, readRound: r => e.db.readRound(r), write: () => false, prune: (r, k, t, s) => e.db.prune(r, k, t, s), dropRound: r => e.db.dropRound(r), rounds: () => e.db.rounds(), markRecheck: (r, t) => e.db.markRecheck(r, t), retryOpen: () => { e.db.retryOpen() } }
    let isCommitted = false
    const r = await runScan({ target: { kind: 'scope', scope: GLOBAL }, llm: stubModel(), startedAt: e.clock.now }, e.deps, { onCommitted: () => { isCommitted = true } })
    expect(isFullyCovered(coverageOf(r))).toBe(true)
    expect(e.db.readRound('global')!.rows).toHaveLength(1)
    expect(isCommitted).toBe(true)
  })

  it('全局轮没全覆盖时不跑清遗留垂直条目；全覆盖时才清', async () => {
    const e = await env({ tokenCap: 1 })
    await threeBatches(e)
    await e.pending.put('pd_stale', {
      id: 'pd_stale', memoryIds: ['mem_b1'], baselineRef: '旧的指令文件', summary: '遗留的垂直条目', firstSeenAt: 1, fingerprint: '对不上的指纹',
    })
    const m = stubModel()
    expect(isFullyCovered(coverageOf(await e.scan({ llm: m })))).toBe(false)
    expect((await e.decisions.list()).map(d => d.id)).toEqual(['pd_stale'])
    e.tokenCap.value = undefined
    e.clock.now += 1000
    expect(isFullyCovered(coverageOf(await e.scan({ llm: m })))).toBe(true)
    expect(await e.decisions.list()).toEqual([])
  })
})

describe('全部重查', () => {
  const P1 = '/work/one'
  const P2 = '/work/two'
  async function seed(e: CheckupEnv): Promise<void> {
    await e.store.put(record({ id: 'mem_g', name: '全局' }))
    await e.store.put(record({ id: 'mem_p1', name: '一', scope: 'workspace', workspacePath: P1 }))
    await e.store.put(record({ id: 'mem_p2', name: '二', scope: 'workspace', workspacePath: P2 }))
  }
  const all = { kind: 'checkup' as const, workspaces: [P1, P2] }
  const rounds = ['global', P1, P2, CROSS_WS_ROUND]

  it('选「全部」、上限只够第一轮：下一次普通体检第二轮不命中、接着查；跨项目比较也重查；全查完后 meta 行没了', async () => {
    const e = await env()
    await seed(e)
    const m = stubModel()
    await e.scan({ llm: m, target: all })
    const calls = m.calls.length
    expect(m.crossCalls).toBe(1)

    e.clock.now += 1000
    e.tokenCap.value = 1
    const recheckAt = e.clock.now
    await e.scan({ llm: m, target: all, isFullRecheck: true })
    expect(m.calls.length).toBe(calls + 1)
    // 全局这一轮只有一批、这次查完了：全覆盖，它的 meta 行当场清掉；其余几轮还记着
    expect(e.db.readRound('global')!.recheckBefore).toBe(0)
    for (const round of [P1, P2, CROSS_WS_ROUND]) expect(e.db.readRound(round)!.recheckBefore, round).toBe(recheckAt)

    // 之后的普通体检：被作废的轮不命中，接着查（每次一批），跨项目比较最后也重查
    let runs = 0
    let isDone = false
    while (!isDone) {
      e.clock.now += 1000
      const r = checkup(await e.scan({ llm: m, target: all }))
      isDone = (r.rounds ?? []).every(x => isFullyCovered(x.coverage)) && !r.isCrossWsSkipped
      expect(++runs).toBeLessThan(6)
    }
    expect(m.calls.length).toBe(calls + 3)
    expect(m.crossCalls).toBe(2)
    for (const round of rounds) expect(e.db.readRound(round)!.recheckBefore, round).toBe(0)
  })

  it('一批都没成功：checks 的行一条没少', async () => {
    const e = await env()
    await threeBatches(e)
    const m = stubModel()
    await e.scan({ llm: m })
    m.fail = () => 'unparseable'
    e.clock.now += 1000
    await e.scan({ llm: m, isFullRecheck: true })
    expect(e.db.readRound('global')!.rows).toHaveLength(3)
  })

  it('读不全的轮做全部重查：查完了库里的行也一条没删，meta 行留着', async () => {
    const e = await env()
    const [, b2] = await threeBatches(e)
    const m = stubModel()
    await e.scan({ llm: m })
    await e.store.hardDelete(b2!)
    unreadableArchive(e)
    e.clock.now += 1000
    const r = single(await e.scan({ llm: m, isFullRecheck: true }))
    expect(r.rounds![0]!.closing).toBe('read-incomplete')
    // 两批按原键重写，删掉的那条所在的过时行还在
    expect(e.db.readRound('global')!.rows).toHaveLength(3)
    expect(e.db.readRound('global')!.rows.some(row => row.members.some(([copy]) => copy.includes('mem_b2')))).toBe(true)
    expect(e.db.readRound('global')!.recheckBefore).toBe(e.clock.now)
  })

  it('同一毫秒内先体检再点全部重查：旧行都不命中，全部重发；这次查的结论之后照常命中', async () => {
    const e = await env()
    await threeBatches(e)
    const m = stubModel()
    await e.scan({ llm: m })
    await e.scan({ llm: m, isFullRecheck: true })
    expect(m.calls).toHaveLength(6)
    await e.scan({ llm: m })
    expect(m.calls).toHaveLength(6)
  })

  it('记不下全部重查：这次照样全部重查，记一条日志', async () => {
    const e = await env()
    await threeBatches(e)
    const m = stubModel()
    await e.scan({ llm: m })
    e.deps.checkupCache = { ...e.db, readRound: r => e.db.readRound(r), write: (r, row) => e.db.write(r, row), prune: (r, k, t, s) => e.db.prune(r, k, t, s), dropRound: r => e.db.dropRound(r), rounds: () => e.db.rounds(), markRecheck: () => false, retryOpen: () => { e.db.retryOpen() } }
    e.clock.now += 1000
    await e.scan({ llm: m, isFullRecheck: true })
    expect(m.calls).toHaveLength(6)
    expect(e.logs.some(l => l.includes('全部重查记不下来'))).toBe(true)
  })
})

describe('裁决过的冲突', () => {
  const PAIR = [{ type: 'conflict' as const, ids: ['mem_x', 'mem_y'] }]
  async function seed(e: CheckupEnv): Promise<void> {
    await e.store.put(record({ id: 'mem_x', name: 'x', content: '用 pnpm' }))
    await e.store.put(record({ id: 'mem_y', name: 'y', content: '用 npm' }))
  }
  const resolve = (e: CheckupEnv, decisionId: string, verdict: 'keep-both' | 'dismiss') =>
    executeConfirm({ action: 'resolve', decisionId, verdict }, { workspacePath: undefined }, {
      store: e.store, decisions: e.decisions, snapshots: new SnapshotStore(new InMemoryKvTable<MemorySnapshot>()), instructions: noInstructions, now: () => e.clock.now,
    })

  it('两条都留、标记误报：都没变时再报不重新挂账；一方改了事实时间后再报，重新挂成未决', async () => {
    for (const verdict of ['keep-both', 'dismiss'] as const) {
      const e = await env()
      await seed(e)
      const m = stubModel({ findings: PAIR })
      await e.scan({ llm: m })
      const [entry] = await e.decisions.list()
      expect(entry!.memberScanFingerprints, verdict).toBeDefined()
      expect((await resolve(e, entry!.id, verdict)).kind, verdict).toBe('resolved')
      // 换个模型让这一批重查，同一冲突再报一次：结论仍成立
      e.clock.now += 1000
      await e.scan({ llm: stubModel({ model: 'model-b', findings: PAIR }) })
      expect(await e.decisions.list(), verdict).toEqual([])
      // 只改事实时间：冲突指纹不变，扫描指纹变了
      const x = (await e.store.get('mem_x'))!
      await e.store.put({ ...x, factTime: '2026-11' })
      e.clock.now += 1000
      await e.scan({ llm: m })
      expect((await e.decisions.list()).map(d => d.memoryIds), verdict).toEqual([['mem_x', 'mem_y']])
    }
  })

  it('两条都留之后其中一条被补证（只换出处和改动性质）：换个模型再报，不重新挂账', async () => {
    const e = await env()
    await seed(e)
    await e.scan({ llm: stubModel({ findings: PAIR }) })
    const [entry] = await e.decisions.list()
    expect((await resolve(e, entry!.id, 'keep-both')).kind).toBe('resolved')
    const x = (await e.store.get('mem_x'))!
    await e.store.put({ ...x, source: { sessionId: 'sess_2', eventRange: [3, 4], sourceMode: 'user-explicit' }, lastChange: { kind: 'corroborate', at: e.clock.now, op: 'op_corroborate' } })
    e.clock.now += 1000
    await e.scan({ llm: stubModel({ model: 'model-b', findings: PAIR }) })
    expect(await e.decisions.list()).toEqual([])
  })

  it('纵向冲突保留记忆：都没变时再报不重新挂账；改了有效期后再报，重新挂成未决', async () => {
    const e = await env({ instructions: instructionsOf({ global: '用 npm' }) })
    await e.store.put(record({ id: 'mem_v', name: 'v', content: '用 pnpm' }))
    const vertical = [{ type: 'conflict' as const, ids: ['mem_v'], baselineRef: '指令文件说用 npm' }]
    await e.scan({ llm: stubModel({ findings: vertical }) })
    const [entry] = await e.decisions.list()
    expect((await executeConfirm({ action: 'resolve', decisionId: entry!.id, verdict: 'keep-left' }, { workspacePath: undefined }, {
      store: e.store, decisions: e.decisions, snapshots: new SnapshotStore(new InMemoryKvTable<MemorySnapshot>()), instructions: instructionsOf({ global: '用 npm' }), now: () => e.clock.now,
    })).kind).toBe('resolved')
    e.clock.now += 1000
    await e.scan({ llm: stubModel({ model: 'model-b', findings: vertical }) })
    expect(await e.decisions.list()).toEqual([])
    const v = (await e.store.get('mem_v'))!
    await e.store.put({ ...v, validTo: CHECKUP_NOW + 365 * DAY_MS })
    e.clock.now += 1000
    await e.scan({ llm: stubModel({ findings: vertical }) })
    expect((await e.decisions.list()).map(d => d.memoryIds)).toEqual([['mem_v']])
  })

  it('没有扫描指纹的旧条目：照旧只按冲突指纹，改了事实时间也不重新挂账', async () => {
    const e = await env()
    await seed(e)
    const m = stubModel({ findings: PAIR })
    await e.scan({ llm: m })
    const [entry] = await e.decisions.list()
    await resolve(e, entry!.id, 'keep-both')
    // 上一个发布版写回过：字段丢了
    const settled = (await e.pending.get(entry!.id))!
    const { memberScanFingerprints: _dropped, ...legacy } = settled
    await e.pending.put(entry!.id, legacy)
    const x = (await e.store.get('mem_x'))!
    await e.store.put({ ...x, factTime: '2026-11' })
    e.clock.now += 1000
    await e.scan({ llm: m })
    expect(await e.decisions.list()).toEqual([])
  })
})

describe('跨项目', () => {
  const P1 = '/work/one'
  const P2 = '/work/two'
  async function seed(e: CheckupEnv): Promise<void> {
    await e.store.put(record({ id: 'mem_g', name: '全局' }))
    await e.store.put(record({ id: 'mem_p1', name: '一', summary: '用 pnpm', scope: 'workspace', workspacePath: P1 }))
    await e.store.put(record({ id: 'mem_p2', name: '二', summary: '用 pnpm', scope: 'workspace', workspacePath: P2 }))
  }
  const DUP = JSON.stringify({ duplicates: [{ topic: '包管理器', workspaces: [P1, P2], suggestion: '提一条全局' }] })
  const all = { kind: 'checkup' as const, workspaces: [P1, P2] }

  it('摘要没变不调模型、返回缓存结果；变了且轮到则重算', async () => {
    const e = await env()
    await seed(e)
    const m = stubModel()
    m.crossReply = DUP
    const first = checkup(await e.scan({ llm: m, target: all }))
    expect([m.crossCalls, first.duplicates]).toEqual([1, { items: [{ topic: '包管理器', workspaces: [P1, P2], suggestion: '提一条全局' }], via: 'semantic' }])
    e.clock.now += 1000
    const again = checkup(await e.scan({ llm: m, target: all }))
    expect([m.crossCalls, again.duplicates]).toEqual([1, first.duplicates])

    const p1 = (await e.store.get('mem_p1'))!
    await e.store.put({ ...p1, summary: '用 pnpm 9' })
    e.clock.now += 1000
    await e.scan({ llm: m, target: all })
    expect(m.crossCalls).toBe(2)
  })

  it('重算的结论写不进库：这次照用，库里旧的那一行不清', async () => {
    const e = await env()
    await seed(e)
    const m = stubModel()
    m.crossReply = DUP
    await e.scan({ llm: m, target: all })
    const before = e.db.readRound(CROSS_WS_ROUND)!.rows.map(row => row.key)
    const p1 = (await e.store.get('mem_p1'))!
    await e.store.put({ ...p1, summary: '用 pnpm 9' })
    const write = e.db.write.bind(e.db)
    e.db.write = (round, row) => (round === CROSS_WS_ROUND ? false : write(round, row))
    e.clock.now += 1000
    const r = checkup(await e.scan({ llm: m, target: all }))
    expect([m.crossCalls, r.duplicates.via]).toEqual([2, 'semantic'])
    expect(e.db.readRound(CROSS_WS_ROUND)!.rows.map(row => row.key)).toEqual(before)
  })

  it('调用失败：退回实体匹配、带现有说明、不写库', async () => {
    const e = await env()
    await seed(e)
    const m = stubModel()
    m.crossReply = '不是 JSON'
    const r = checkup(await e.scan({ llm: m, target: all }))
    expect(r.duplicates.via).toBe('entity')
    expect(r.notes.map(n => n.code)).toContain('cross-ws-failed')
    expect(e.db.readRound(CROSS_WS_ROUND)!.rows).toEqual([])
  })

  it('没轮到：不出语义结果、有说明、不影响各轮完成记录', async () => {
    const e = await env()
    await seed(e)
    const m = stubModel()
    m.crossReply = DUP
    await e.scan({ llm: m, target: all })
    // 一个项目改了：它那一轮没命中，跨项目也没命中；上限只够那一批
    const p1 = (await e.store.get('mem_p1'))!
    await e.store.put({ ...p1, summary: '用 pnpm 9' })
    e.tokenCap.value = 1
    e.clock.now += 1000
    const r = checkup(await e.scan({ llm: m, target: all }))
    expect(m.crossCalls).toBe(1)
    expect([r.duplicates, r.isCrossWsSkipped]).toEqual([{ items: [], via: 'none' }, true])
    expect(renderScanResult(r)).toContain('跨项目重复这次没比')
    expect((await e.checkups.list()).find(x => x.id === P1)?.completed?.startedAt).toBe(e.clock.now)
  })

  it('缓存的行过它自己的结构校验：结论不是数组当没命中重算', async () => {
    const e = await env()
    await seed(e)
    const m = stubModel()
    m.crossReply = DUP
    await e.scan({ llm: m, target: all })
    const db = rawDb(e)
    db.prepare("UPDATE checks SET result_json = '{\"x\":1}' WHERE round = ?").run(CROSS_WS_ROUND)
    db.close()
    e.clock.now += 1000
    await e.scan({ llm: m, target: all })
    expect(m.crossCalls).toBe(2)
  })
})

describe('调用方叫停、不做到期刷新', () => {
  /** 一批里两对冲突（四条短记忆）。 */
  async function twoPairs(e: CheckupEnv): Promise<StubModel> {
    for (const id of ['mem_a', 'mem_b', 'mem_c', 'mem_d']) await e.store.put(record({ id, name: id, content: `${id} 的正文` }))
    return stubModel({ findings: [{ type: 'conflict', ids: ['mem_a', 'mem_b'] }, { type: 'conflict', ids: ['mem_c', 'mem_d'] }] })
  }
  const pairsOf = async (e: CheckupEnv) => (await e.decisions.list()).map(d => [...d.memoryIds].sort().join('+')).sort()
  const isAbortError = (err: unknown) => err instanceof Error && err.name === 'AbortError'

  /** 叫停之后的下一次扫描（不叫停）：成员没变，命中库里这次写下的结论、不调模型，把挂账和视图补齐。 */
  async function completesNextTime(e: CheckupEnv, m: StubModel) {
    const calls = m.calls.length
    e.clock.now += 1000
    await e.scan({ llm: m })
    expect(m.calls.length).toBe(calls)
    expect(await pairsOf(e)).toEqual(['mem_a+mem_b', 'mem_c+mem_d'])
    expect(findingKeys(await e.view(GLOBAL))).toEqual(['conflict:mem_a+mem_b', 'conflict:mem_c+mem_d'])
  }

  it('不做到期刷新：过了刷新时间、全部命中时一次模型都不调；不传时照常刷新', async () => {
    const e = await env()
    await threeBatches(e)
    const m = stubModel()
    await e.scan({ llm: m })
    e.clock.now += REFRESH_AFTER_MS + DAY_MS
    await e.scan({ llm: m, isRefreshSkipped: true })
    expect(m.calls).toHaveLength(3)
    await e.scan({ llm: m })
    expect(m.calls).toHaveLength(6)
  })

  it('每次模型调用的实际用量交给调用方，叫停抛出时已用的也交过了', async () => {
    const e = await env()
    await threeBatches(e)
    const m = stubModel()
    const llm: SemanticLlm = { ...m, complete: async (input, signal, onUsage) => { onUsage?.(7); return m.complete(input, signal) } }
    const used: number[] = []
    const r = await e.scan({ llm, onUsage: tokens => { used.push(tokens) } })
    expect(used).toEqual([7, 7, 7])
    expect(r.kind === 'single' && r.usageTokens).toBe(21)
    used.length = 0
    await threeBatches(e, { summary: '改过' })
    const stopped = e.scan({ llm, onUsage: tokens => { used.push(tokens) }, shouldStop: () => m.calls.length >= 4 })
    await expect(stopped).rejects.toSatisfy(isAbortError)
    expect(used).toEqual([7])
  })

  it('一批的模型调用返回之后叫停：这一批的结论不写进库，后面的批不再发，不挂账、不写视图', async () => {
    const e = await env()
    await threeBatches(e)
    const m = stubModel()
    await expect(e.scan({ llm: m, shouldStop: () => m.calls.length >= 1 })).rejects.toSatisfy(isAbortError)
    expect(m.calls).toHaveLength(1)
    expect(e.db.readRound('global')?.rows ?? []).toEqual([])
    expect(await e.view(GLOBAL)).toBeUndefined()
  })

  it('一批的结论写进库之后叫停：下一批不再发模型请求，写进库的那批下一次命中', async () => {
    const e = await env()
    await threeBatches(e)
    const m = stubModel()
    let isStopped = false
    const write = e.db.write.bind(e.db)
    e.db.write = (...args) => { isStopped = true; return write(...args) }
    await expect(e.scan({ llm: m, shouldStop: () => isStopped })).rejects.toSatisfy(isAbortError)
    expect(m.calls).toHaveLength(1)
    expect(e.db.readRound('global')?.rows).toHaveLength(1)
    e.db.write = write
    e.clock.now += 1000
    await e.scan({ llm: m })
    expect(m.calls).toHaveLength(3)
  })

  it('结论写进库之后、挂账之前叫停：不挂账、不写视图；下一次扫描命中、补齐', async () => {
    const e = await env()
    const m = await twoPairs(e)
    let isStopped = false
    const write = e.db.write.bind(e.db)
    e.db.write = (...args) => { isStopped = true; return write(...args) }
    await expect(e.scan({ llm: m, shouldStop: () => isStopped })).rejects.toSatisfy(isAbortError)
    expect(e.db.readRound('global')?.rows).toHaveLength(1)
    expect(await pairsOf(e)).toEqual([])
    expect(await e.view(GLOBAL)).toBeUndefined()
    e.db.write = write
    await completesNextTime(e, m)
  })

  it('挂账重读成员期间叫停：这一条不挂，之后都不挂、不写视图；下一次扫描补齐', async () => {
    const e = await env()
    const m = await twoPairs(e)
    let isStopped = false
    let isArmed = false
    const complete = m.complete
    m.complete = async (...args) => { const r = await complete(...args); isArmed = true; return r }
    const get = e.store.get.bind(e.store)
    e.store.get = async (...args) => { if (isArmed) isStopped = true; return get(...args) }
    await expect(e.scan({ llm: m, shouldStop: () => isStopped })).rejects.toSatisfy(isAbortError)
    expect(await pairsOf(e)).toEqual([])
    expect(await e.view(GLOBAL)).toBeUndefined()
    e.store.get = get
    await completesNextTime(e, m)
  })

  it('两条挂账之间叫停：已挂的那条留着，不再开始新的挂账、不写视图；下一次扫描补齐', async () => {
    const e = await env()
    const m = await twoPairs(e)
    let isStopped = false
    const upsert = e.decisions.upsert.bind(e.decisions)
    e.decisions.upsert = async (...args) => { const r = await upsert(...args); isStopped = true; return r }
    await expect(e.scan({ llm: m, shouldStop: () => isStopped })).rejects.toSatisfy(isAbortError)
    expect(await pairsOf(e)).toHaveLength(1)
    expect(await e.view(GLOBAL)).toBeUndefined()
    e.decisions.upsert = upsert
    await completesNextTime(e, m)
  })

  it('写视图等写锁期间叫停：拿到锁、读到当前视图之后不写，挂好的账留着；下一次扫描补齐', async () => {
    const e = await env()
    // 真实侧表：视图和账本都在记忆根的 .state 下，同一把记忆根写锁
    const sidecar = new SidecarStore({ root: e.memoryRoot, schemas: sidecarSchemas, now: () => e.clock.now, log: e.deps.log })
    e.deps.cache = sidecar.scanCache
    e.decisions = new PendingDecisionsStore(sidecar.pending, sidecar.lock)
    e.deps.decisions = e.decisions
    const m = await twoPairs(e)
    let isStopped = false
    let releaseLock!: () => void
    const held = new Promise<void>(resolve => { releaseLock = resolve })
    let onWaiting!: () => void
    const waiting = new Promise<void>(resolve => { onWaiting = resolve })
    let holding: Promise<void> | undefined
    const update = sidecar.scanCache.update.bind(sidecar.scanCache)
    sidecar.scanCache.update = async (key, fn) => {
      // 别处先占着写锁，体检排在它后面等
      let onLocked!: () => void
      const locked = new Promise<void>(resolve => { onLocked = resolve })
      holding ??= sidecar.lock.run(async () => { onLocked(); await held })
      await locked
      const pending = update(key, fn)
      onWaiting()
      return pending
    }
    const scan = e.scan({ llm: m, shouldStop: () => isStopped })
    await waiting
    isStopped = true
    releaseLock()
    await expect(scan).rejects.toSatisfy(isAbortError)
    await holding
    expect(await pairsOf(e)).toEqual(['mem_a+mem_b', 'mem_c+mem_d'])
    expect(await sidecar.scanCache.get(scopeCacheKey(GLOBAL))).toBeUndefined()
    sidecar.scanCache.update = update
    const calls = m.calls.length
    e.clock.now += 1000
    await e.scan({ llm: m })
    expect(m.calls.length).toBe(calls)
    expect(findingKeys(await sidecar.scanCache.get(scopeCacheKey(GLOBAL)))).toEqual(['conflict:mem_a+mem_b', 'conflict:mem_c+mem_d'])
  })
})
