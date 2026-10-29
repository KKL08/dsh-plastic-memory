import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmod, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileTable } from '../src/storage/file-table.ts'
import { SidecarStore } from '../src/storage/sidecar.ts'
import { STATE_DIR } from '../src/storage/paths.ts'
import { createAgentsMdWriter } from '../src/storage/agents-md.ts'
import { MemoryStore } from '../src/store.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'
import { PendingDecisionsStore } from '../src/governance/decisions.ts'
import { SnapshotStore } from '../src/governance/snapshots.ts'
import { CheckupRecordStore } from '../src/governance/checkup-records.ts'
import { AutoCheckupSettingStore } from '../src/governance/auto-checkups.ts'
import { AdviceIgnoreStore } from '../src/governance/advice-ignores.ts'
import { resolveHealthThresholds } from '../src/governance/health-presets.ts'
import { BLOAT_THRESHOLD } from '../src/governance/rule-scan.ts'
import { memorySnapshotSchema, pendingDecisionSchema, scanCacheSchema, adviceIgnoreSchema, type Finding } from '../src/governance/schema.ts'
import type { SemanticLlm } from '../src/governance/semantic-scan.ts'
import { RETENTION_MS } from '../src/retention.ts'
import { computeDigest } from '../src/storage/frontmatter.ts'
import { ViewWriter, collectGlobalViews } from '../src/gui/view-writer.ts'
import { createMemoryCommand } from '../src/gui/commands.ts'
import {
  GUI_VIEW_DIR, GUI_VIEW_FILES, GUI_VIEW_VERSION, MEMORY_COMMAND_NAME, encodeMemoryCommand, healthViewSchema, layerOfMemory, memoryCommandResultSchema, pendingViewSchema,
  type IgnorableAdviceType, type MemoryCommand, type MemoryCommandResult,
} from '../src/gui/contract.ts'
import { executeHealth, renderHealthResult, type SingleHealthResult, type CheckupHealthResult } from '../src/tools/health.ts'
import { executeScan, renderScanResult, type SingleScanResult } from '../src/tools/scan.ts'
import { fakeExec } from './helpers/exec.ts'
import { record } from './helpers/record.ts'

// 建议整理的忽略与取消忽略：真实临时目录（FileTable + .state 侧表 + 视图文件），宿主那一侧（借来的会话、模型）换成测试桩。
// 断言命令结果、写出的视图、忽略表的终态，以及 memory_health / memory_scan 的输出与界面一致。

const NOW = 10 * RETENTION_MS
const WS = '/tmp/pm-ignore-ws'
const OTHER_WS = '/tmp/pm-ignore-other'
const registry = buildTypeRegistry({ template: 'coding', customTypes: {} })
const LONG = 'x'.repeat(BLOAT_THRESHOLD + 1)

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'pm-advice-ignore-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

/** 一个宿主实例：各自的侧表、FileTable、视图写入器，共用同一个根。 */
function env(opts: { llm?: SemanticLlm } = {}) {
  const sidecar = new SidecarStore({ root, schemas: { snapshots: memorySnapshotSchema, pending: pendingDecisionSchema, scanCache: scanCacheSchema, adviceIgnores: adviceIgnoreSchema } })
  const store = new MemoryStore(new FileTable({ root, stats: sidecar.recallStats, now: () => NOW }), undefined, sidecar.recallStats)
  const decisions = new PendingDecisionsStore(sidecar.pending)
  const snapshots = new SnapshotStore(sidecar.snapshots)
  const ignores = new AdviceIgnoreStore(sidecar.adviceIgnores)
  const cache = sidecar.scanCache
  const views = new ViewWriter({ memoryRoot: root, collect: () => collectGlobalViews({ store, decisions, cache, ignores, registry, memoryRoot: root, now: () => NOW }) })
  const resolveContext = async () => ({ workspacePath: WS, delegationDepth: 0, session: { id: 'sess-1' } })
  const getLlm = () => opts.llm ?? null
  const command = createMemoryCommand({
    memoryRoot: root, store, decisions, snapshots, cache, checkups: new CheckupRecordStore(sidecar.checkups), autoCheckups: new AutoCheckupSettingStore(sidecar.autoCheckups), ignores, registry, views,
    agentsMd: createAgentsMdWriter(join(root, 'AGENTS.md')),
    resolveContext, getLlm, getBaseline: () => null, now: () => NOW,
  })
  /** 按宿主 parseCommand 的切法：命令名之后的原文交给处理器。 */
  const runRaw = async (rawInput: string): Promise<MemoryCommandResult> =>
    memoryCommandResultSchema.parse(JSON.parse((await command.handler({ rawInput, agent: {} })).text!))
  const run = (c: MemoryCommand) => runRaw(encodeMemoryCommand(c).slice(`/${MEMORY_COMMAND_NAME}`.length))
  const readView = async (name: keyof typeof GUI_VIEW_FILES) => JSON.parse(await readFile(join(root, GUI_VIEW_DIR, GUI_VIEW_FILES[name]), 'utf8')) as unknown
  const pending = async () => pendingViewSchema.parse(await readView('pending'))
  const health = async () => healthViewSchema.parse(await readView('health'))
  const toolDeps = { store, registry, decisions, cache, ignores, resolveContext, now: () => NOW }
  const healthTool = (scope?: string) => executeHealth(scope === undefined ? {} : { scope }, { ...toolDeps, thresholds: resolveHealthThresholds('normal') }, fakeExec())
  const scanTool = (args: { scope?: string; layers?: 'rule' | 'full' } = {}) =>
    executeScan({ layers: 'rule', ...args }, { ...toolDeps, getBaseline: () => null, getLlm }, fakeExec())
  /** 照界面的做法点「忽略」：从待处理视图里那张卡带上每条记忆的层和卡片版本。 */
  const ignore = async (type: IgnorableAdviceType, ids: readonly string[]) => {
    const key = [...ids].sort().join(',')
    const item = (await pending()).items.find(i => i.kind === 'advice' && i.type === type && i.memories.map(m => m.id).sort().join(',') === key)
    if (item?.kind !== 'advice') throw new Error(`待处理里没有 ${type}:${key}`)
    return run({ cmd: 'ignore-advice', type, memories: item.memories.map(m => ({ memoryId: m.id, layer: layerOfMemory(m), base: { updatedAt: m.updatedAt, digest: m.digest! } })) })
  }
  return { store, decisions, ignores, cache, run, runRaw, ignore, readView, pending, health, healthTool, scanTool }
}

type Ok = Extract<MemoryCommandResult, { ok: true }>
type Err = Extract<MemoryCommandResult, { ok: false }>
const ok = (r: MemoryCommandResult): Ok => { expect(r.ok, JSON.stringify(r)).toBe(true); return r as Ok }
const err = (r: MemoryCommandResult): Err => { expect(r.ok, JSON.stringify(r)).toBe(false); return r as Err }

/** 待处理里的建议整理项（不算「很久没确认」：夹具记忆的确认时间很早，每条都有一项）。 */
const adviceOf = async (e: ReturnType<typeof env>) => (await e.pending()).items
  .flatMap(i => i.kind === 'advice' && i.type !== 'stale' ? [`${i.type}:${i.memories.map(m => m.id).join(',')}`] : [])
const wsLayerOf = async (e: ReturnType<typeof env>) => (await e.health()).layers.find(l => l.layer.kind === 'workspace' && l.layer.workspacePath === WS)!
const ignoreFiles = async () => (await readdir(join(root, STATE_DIR, 'advice-ignores')).catch(() => [] as string[])).filter(n => n.endsWith('.json'))

/** 项目里一条过长、一条正常的记忆。 */
async function seedBloat(e: ReturnType<typeof env>) {
  await e.store.create(record({ id: 'mem_long', name: '长的', content: LONG, scope: 'workspace', workspacePath: WS }))
  await e.store.create(record({ id: 'mem_ok', name: '正常的', content: '短', scope: 'workspace', workspacePath: WS }))
  ok(await e.run({ cmd: 'refresh-views' }))
}

describe('忽略与取消忽略', () => {
  it('忽略后该项从待处理消失、健康分不再扣、该层「已忽略」列出它；取消忽略后都恢复', async () => {
    const e = env()
    await seedBloat(e)
    const before = await wsLayerOf(e)
    expect(await adviceOf(e)).toEqual(['bloat:mem_long'])
    expect(before.issues).toEqual([{ type: 'bloat', count: 1, level: 'advice' }])
    expect(before.ignored).toEqual([])

    expect(ok(await e.ignore('bloat', ['mem_long']))).toMatchObject({ cmd: 'ignore-advice', memoryIds: ['mem_long'] })
    expect(await adviceOf(e)).toEqual([])
    const ignored = await wsLayerOf(e)
    expect(ignored.issues).toEqual([])
    expect(ignored.score!).toBeGreaterThan(before.score!)
    expect(ignored.ignored).toEqual([{ type: 'bloat', memories: [{ id: 'mem_long', name: '长的', summary: '摘要' }] }])

    ok(await e.run({ cmd: 'unignore-advice', type: 'bloat', memoryIds: ['mem_long'] }))
    expect(await adviceOf(e)).toEqual(['bloat:mem_long'])
    expect(await wsLayerOf(e)).toEqual(before)
    expect(await ignoreFiles()).toEqual([])
  })

  it('改了记忆内容后被忽略的问题（仍然过长）重新出现，旧的忽略记录在视图生成时清掉', async () => {
    const e = env()
    await seedBloat(e)
    ok(await e.ignore('bloat', ['mem_long']))
    expect(await adviceOf(e)).toEqual([])
    const r = (await e.store.get('mem_long'))!
    await e.store.update(r, cur => ({ ...cur, content: `${LONG}y` }))
    ok(await e.run({ cmd: 'refresh-views' }))
    expect(await adviceOf(e)).toEqual(['bloat:mem_long'])
    expect((await wsLayerOf(e)).ignored).toEqual([])
    expect(await e.ignores.list()).toEqual([])
  })

  it('只改了内容以外的东西（确认时间）：照旧算已忽略', async () => {
    const e = env()
    await seedBloat(e)
    ok(await e.ignore('bloat', ['mem_long']))
    ok(await e.run({ cmd: 'confirm', memoryId: 'mem_long' }))
    expect(await adviceOf(e)).toEqual([])
    expect((await wsLayerOf(e)).ignored.map(i => i.type)).toEqual(['bloat'])
  })

  it('建议依据的其他字段变了也重新出现：改摘要、延长（仍已过期的）有效期、换层', async () => {
    const e = env()
    await seedBloat(e)
    ok(await e.ignore('bloat', ['mem_long']))
    const long = (await e.store.get('mem_long', { workspacePath: WS }))!
    await e.store.update(long, cur => ({ ...cur, summary: '新的摘要' }))
    ok(await e.run({ cmd: 'refresh-views' }))
    expect(await adviceOf(e)).toEqual(['bloat:mem_long'])

    await e.store.create(record({ id: 'mem_exp', name: '过期的', content: '短', scope: 'workspace', workspacePath: WS, validTo: NOW - 10 * 60_000 }))
    ok(await e.run({ cmd: 'refresh-views' }))
    ok(await e.ignore('expired', ['mem_exp']))
    const exp = (await e.store.get('mem_exp', { workspacePath: WS }))!
    await e.store.update(exp, cur => ({ ...cur, validTo: NOW - 5 * 60_000 }))
    ok(await e.run({ cmd: 'refresh-views' }))
    expect(await adviceOf(e)).toContain('expired:mem_exp')

    ok(await e.ignore('bloat', ['mem_long']))
    ok(await e.run({ cmd: 'promote-memory', memoryId: 'mem_long', layer: { kind: 'workspace', workspacePath: WS } }))
    expect(await adviceOf(e)).toContain('bloat:mem_long')
  })

  it('只改标签：照旧算已忽略', async () => {
    const e = env()
    await seedBloat(e)
    ok(await e.ignore('bloat', ['mem_long']))
    const long = (await e.store.get('mem_long', { workspacePath: WS }))!
    await e.store.update(long, cur => ({ ...cur, tags: ['新标签'] }))
    ok(await e.run({ cmd: 'refresh-views' }))
    expect(await adviceOf(e)).toEqual([])
  })

  it('记忆删除后忽略记录被清掉；从最近删除恢复后问题重新出现', async () => {
    const e = env()
    await seedBloat(e)
    ok(await e.ignore('bloat', ['mem_long']))
    expect(await ignoreFiles()).toHaveLength(1)
    ok(await e.run({ cmd: 'forget', memoryId: 'mem_long' }))
    expect(await ignoreFiles()).toEqual([])
    ok(await e.run({ cmd: 'restore', memoryId: 'mem_long' }))
    expect(await adviceOf(e)).toEqual(['bloat:mem_long'])
  })

  it('两个实例同根并发忽略同一项：只留一条记录', async () => {
    const [a, b] = [env(), env()]
    await seedBloat(a)
    await Promise.all([
      a.ignore('bloat', ['mem_long']),
      b.ignore('bloat', ['mem_long']),
    ]).then(rs => rs.forEach(ok))
    expect(await ignoreFiles()).toHaveLength(1)
    expect((await b.ignores.list()).map(i => i.memoryIds)).toEqual([['mem_long']])
    // 一个实例取消，另一个实例刷新后看到同样结果
    ok(await a.run({ cmd: 'unignore-advice', type: 'bloat', memoryIds: ['mem_long'] }))
    ok(await b.run({ cmd: 'refresh-views' }))
    expect(await adviceOf(b)).toEqual(['bloat:mem_long'])
  })

  it('内容重复按两条记忆一起忽略（id 顺序不论）；其中一条改了内容就不再算已忽略', async () => {
    const llm: SemanticLlm = { complete: async () => JSON.stringify({ findings: [{ type: 'redundancy', memoryIds: ['mem_b', 'mem_a'], summary: '说的是一件事' }] }) }
    const e = env({ llm })
    await e.store.create(record({ id: 'mem_a', name: '甲', content: '用 pnpm', scope: 'workspace', workspacePath: WS }))
    await e.store.create(record({ id: 'mem_b', name: '乙', content: '包管理用 pnpm', scope: 'workspace', workspacePath: WS }))
    ok(await e.run({ cmd: 'scan' }))
    expect(await adviceOf(e)).toEqual(['redundancy:mem_a,mem_b'])
    ok(await e.ignore('redundancy', ['mem_b', 'mem_a']))
    expect(await adviceOf(e)).toEqual([])
    expect((await wsLayerOf(e)).ignored).toEqual([{ type: 'redundancy', memories: [
      { id: 'mem_a', name: '甲', summary: '摘要' }, { id: 'mem_b', name: '乙', summary: '摘要' },
    ] }])
    // 改了一条：重新体检后问题还在，就重新提示
    const b = (await e.store.get('mem_b'))!
    await e.store.update(b, cur => ({ ...cur, content: '包管理器一律 pnpm' }))
    ok(await e.run({ cmd: 'scan' }))
    expect(await adviceOf(e)).toEqual(['redundancy:mem_a,mem_b'])
  })

  it('体检结果的新增建议不算已忽略的：上次体检没报、这次又报出来的已忽略重复不计入', async () => {
    let findings: object[] = [{ type: 'redundancy', memoryIds: ['mem_a', 'mem_b'], summary: '说的是一件事' }]
    const e = env({ llm: { complete: async () => JSON.stringify({ findings }) } })
    await e.store.create(record({ id: 'mem_a', name: '甲', content: '用 pnpm', scope: 'workspace', workspacePath: WS }))
    await e.store.create(record({ id: 'mem_b', name: '乙', content: '包管理用 pnpm', scope: 'workspace', workspacePath: WS }))
    expect(ok(await e.run({ cmd: 'scan', workspacePath: WS })).added).toEqual({ pending: 0, advice: 1 })
    ok(await e.ignore('redundancy', ['mem_a', 'mem_b']))
    // 模型这次没报，语义缓存里没有了；忽略记录还在（两条记忆都没改）
    findings = []
    ok(await e.run({ cmd: 'scan', workspacePath: WS }))
    expect(await e.ignores.list()).toHaveLength(1)
    findings = [{ type: 'redundancy', memoryIds: ['mem_b', 'mem_a'], summary: '还是一件事' }]
    expect(ok(await e.run({ cmd: 'scan', workspacePath: WS })).added).toEqual({ pending: 0, advice: 0 })
    expect((await wsLayerOf(e)).ignored.map(i => i.type)).toEqual(['redundancy'])
  })

  it('参数：很久没确认不可忽略；单条类型只收一条记忆；记忆不在用 → not-found，什么都不记', async () => {
    const e = env()
    await seedBloat(e)
    const layer = { kind: 'workspace', workspacePath: WS } as const
    const refOf = async (id: string) => {
      const r = await e.store.get(id, { workspacePath: WS })
      return { memoryId: id, layer, base: { updatedAt: r?.updatedAt ?? 0, digest: r === undefined ? '' : computeDigest(r.name, r.summary, r.content) } }
    }
    const stale = { memoryId: 'mem_ok', layer, base: { updatedAt: 1, digest: 'd' } }
    expect(err(await e.runRaw(` ignore-advice ${JSON.stringify({ type: 'stale', memories: [stale] })}`)).code).toBe('invalid-args')
    expect(err(await e.run({ cmd: 'ignore-advice', type: 'bloat', memories: [await refOf('mem_long'), await refOf('mem_ok')] })).code).toBe('invalid-args')
    expect(err(await e.run({ cmd: 'ignore-advice', type: 'bloat', memories: [await refOf('mem_none')] })).code).toBe('not-found')
    const okRef = await refOf('mem_ok')
    ok(await e.run({ cmd: 'forget', memoryId: 'mem_ok' }))
    expect(err(await e.run({ cmd: 'ignore-advice', type: 'expired', memories: [okRef] })).code).toBe('not-found')
    expect(await ignoreFiles()).toEqual([])
  })

  it('同 id 在两个项目各有一份：忽略的是卡片上那一份（视图取的较新那份），之后不会被当成过时清掉', async () => {
    const e = env()
    await e.store.create(record({ id: 'mem_dup', name: '本项目那份', content: LONG, scope: 'workspace', workspacePath: WS, updatedAt: 1 }))
    await e.store.create(record({ id: 'mem_dup', name: '别的项目那份', content: `${LONG}z`, scope: 'workspace', workspacePath: OTHER_WS, updatedAt: 2 }))
    ok(await e.run({ cmd: 'refresh-views' }))
    expect(await adviceOf(e)).toEqual(['bloat:mem_dup'])
    ok(await e.ignore('bloat', ['mem_dup']))
    expect(await adviceOf(e)).toEqual([])
    ok(await e.run({ cmd: 'refresh-views' }))
    expect(await adviceOf(e)).toEqual([])
    expect(await ignoreFiles()).toHaveLength(1)
  })

  it('卡片加载后记忆被改过（比如 agent 刚改）：回 stale，什么都不记', async () => {
    const e = env()
    await seedBloat(e)
    const view = await e.pending()
    const r = (await e.store.get('mem_long', { workspacePath: WS }))!
    await e.store.update(r, cur => ({ ...cur, content: `${LONG}y`, updatedAt: NOW }))
    const item = view.items.find(i => i.kind === 'advice' && i.type === 'bloat')!
    if (item.kind !== 'advice') throw new Error('unreachable')
    const [m] = item.memories
    const result = await e.run({ cmd: 'ignore-advice', type: 'bloat', memories: [{ memoryId: m.id, layer: layerOfMemory(m), base: { updatedAt: m.updatedAt, digest: m.digest! } }] })
    expect(err(result).code).toBe('stale')
    expect(await ignoreFiles()).toEqual([])
  })

  it('取消一条没有忽略过的：照常成功（结果就是不再忽略）', async () => {
    const e = env()
    await seedBloat(e)
    ok(await e.run({ cmd: 'unignore-advice', type: 'bloat', memoryIds: ['mem_long'] }))
    expect(await adviceOf(e)).toEqual(['bloat:mem_long'])
  })
})

describe('agent 工具认忽略', () => {
  it('memory_health：分数与界面一致、被忽略的不扣分，输出注明已忽略条数', async () => {
    const e = env()
    await seedBloat(e)
    const plain = await e.healthTool() as SingleHealthResult
    expect(plain.ignoredCount).toBe(0)
    expect(renderHealthResult(plain)).not.toContain('已忽略')
    ok(await e.ignore('bloat', ['mem_long']))
    const r = await e.healthTool() as SingleHealthResult
    expect(r.score).toBe((await wsLayerOf(e)).score)
    expect(r.score).toBeGreaterThan(plain.score)
    expect(r.breakdown.ruleLayer.bloat).toBe(0)
    expect(r.ignoredCount).toBe(1)
    expect(renderHealthResult(r)).toContain('已忽略 1 条（用户可在记忆页健康里取消）')
    const all = await e.healthTool('all') as CheckupHealthResult
    expect(all.rows.find(row => row.workspacePath === WS)).toMatchObject({ score: r.score, ignoredCount: 1 })
    expect(renderHealthResult(all)).toContain('已忽略 1 条（用户可在记忆页健康里取消）')
  })

  it('memory_scan：已忽略的不列为发现，输出注明已忽略条数；体检表的分数与界面一致', async () => {
    const e = env()
    await seedBloat(e)
    ok(await e.ignore('bloat', ['mem_long']))
    const r = await e.scanTool() as SingleScanResult
    expect(r.findings.filter((f: Finding) => f.type === 'bloat')).toEqual([])
    expect(r.stats.byType).toEqual({})
    expect(r.ignoredCount).toBe(1)
    const text = renderScanResult(r)
    expect(text).not.toContain('bloat mem_long')
    expect(text).toContain('已忽略 1 条（用户可在记忆页健康里取消）')
    const all = await e.scanTool({ scope: 'all' })
    if (all.kind !== 'checkup') throw new Error(all.kind)
    expect(all.rows.find(row => row.workspacePath === WS)).toMatchObject({ score: (await wsLayerOf(e)).score, issues: 0, ignoredCount: 1 })
    expect(renderScanResult(all)).toContain('已忽略 1 条（用户可在记忆页健康里取消）')
  })
})

describe('清理点', () => {
  it('判定过时之后、删除之前别处按新内容重新忽略了同一项：新的那条留着', async () => {
    const e = env()
    await seedBloat(e)
    ok(await e.ignore('bloat', ['mem_long']))
    const long = (await e.store.get('mem_long', { workspacePath: WS }))!
    await e.store.update(long, cur => ({ ...cur, content: `${LONG}y` }))
    // 清理点读到的旧记录（指纹已对不上）
    const judged = await e.ignores.list()
    // 这时别处按新内容重新忽略
    await e.ignores.ignore('bloat', [(await e.store.get('mem_long', { workspacePath: WS }))!], NOW + 1)
    await e.ignores.remove(judged)
    expect((await e.ignores.list()).map(i => i.ignoredAt)).toEqual([NOW + 1])
  })

  it('清理出错不挡视图：照常生成视图，记一条日志', async () => {
    const e = env()
    await seedBloat(e)
    ok(await e.ignore('bloat', ['mem_long']))
    const long = (await e.store.get('mem_long', { workspacePath: WS }))!
    await e.store.update(long, cur => ({ ...cur, content: `${LONG}y` }))
    const dir = join(root, STATE_DIR, 'advice-ignores')
    const warnings: unknown[][] = []
    const log = { info() {}, warn: (...args: unknown[]) => { warnings.push(args) }, error() {} }
    await chmod(dir, 0o500)
    try {
      const views = await collectGlobalViews({ store: e.store, decisions: e.decisions, cache: e.cache, ignores: e.ignores, registry, memoryRoot: root, now: () => NOW, log })
      expect(views.pending.items.some(i => i.kind === 'advice' && i.type === 'bloat')).toBe(true)
    } finally {
      await chmod(dir, 0o755)
    }
    expect(warnings).toHaveLength(1)
    expect(String(warnings[0]![0])).toContain('建议忽略表')
  })
})

describe('视图版本', () => {
  it('健康视图带新版本号', async () => {
    const e = env()
    await seedBloat(e)
    expect((await e.health()).version).toBe(GUI_VIEW_VERSION)
  })
})
