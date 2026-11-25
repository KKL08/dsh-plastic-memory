import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sidecarSchemas, createPluginEnv } from './helpers/plugin-env.ts'
import { checkupEnv, bigRecord, stubModel, DAY_MS, type CheckupEnv, type StubModel } from './helpers/checkup-env.ts'
import { instructionsOf, noInstructions } from './helpers/instructions.ts'
import { record } from './helpers/record.ts'
import { SidecarStore } from '../src/storage/sidecar.ts'
import { CheckupCache } from '../src/storage/checkup-cache.ts'
import { ARCHIVE_DIR, CHECKUP_CACHE_FILE, GLOBAL_DIR } from '../src/storage/paths.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'
import { RETENTION_MS } from '../src/retention.ts'
import { ViewWriter, collectCheckupView, collectGlobalViews } from '../src/gui/view-writer.ts'
import { runCheckup, type CheckupRunDeps, type CheckupRunInput } from '../src/gui/checkup-run.ts'
import { checkupKey, memoryCommandSchema } from '../src/gui/contract.ts'
import type { PendingTable } from '../src/governance/decisions.ts'
import type { ReadInstructions } from '../src/governance/instructions.ts'
import type { ScanCacheEntry } from '../src/governance/schema.ts'
import type { CasKvTable } from '../src/kv-table.ts'
import { renderScanResult, runScan } from '../src/tools/scan.ts'
import { executeHealth, renderHealthResult } from '../src/tools/health.ts'
import { fakeExec } from './helpers/exec.ts'
import { scopeCacheKey, type Scope } from '../src/scope.ts'
import { checkupRecordSchema } from '../src/storage/schema.ts'
import { loadRelease020Schemas } from './helpers/release-020.ts'

// 收尾表（界面手动体检、自动体检）和入口矩阵：真实临时目录（文件表、.state 侧表、视图文件、体检结果库）；
// 只换掉进程边界：模型（桩）、心跳计时、时钟，以及注入存储出错的那张表。

const NOW = 10 * RETENTION_MS
const PROJECT = '/tmp/pm-closing-project'
const GLOBAL: Scope = { kind: 'global' }
const PROJ: Scope = { kind: 'workspace', workspacePath: PROJECT }
const registry = buildTypeRegistry({ template: 'coding', customTypes: {} })

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'pm-closing-')) })
afterEach(async () => {
  for (const db of opened.splice(0)) db.close()
  await rm(root, { recursive: true, force: true })
})
const opened: CheckupCache[] = []

function env(opts: {
  tokenCap?: unknown
  instructions?: ReadInstructions
  wrapCache?: (table: CasKvTable<ScanCacheEntry>) => CasKvTable<ScanCacheEntry>
  wrapPending?: (table: PendingTable) => PendingTable
} = {}) {
  const clock = { now: NOW }
  const logs: string[] = []
  const log = { info() {}, warn: (...args: unknown[]) => { logs.push(args.map(String).join(' ')) }, error: (...args: unknown[]) => { logs.push(args.map(String).join(' ')) } }
  const sidecar = new SidecarStore({ root, schemas: sidecarSchemas, now: () => clock.now, log })
  const { store, decisions, snapshots, ignores, checkups, autoCheckups } = createPluginEnv(
    sidecar, { root, stats: sidecar.recallStats, now: () => clock.now },
    { log, ...(opts.wrapPending !== undefined ? { pending: opts.wrapPending(sidecar.pending) } : {}) },
  )
  const cache = sidecar.scanCache
  const db = new CheckupCache({ path: join(root, CHECKUP_CACHE_FILE), log })
  opened.push(db)
  const tokenCap = { value: opts.tokenCap }
  const checkupView = () => collectCheckupView({ store, checkups, autoCheckups, cache, now: () => clock.now })
  const writer = new ViewWriter({
    memoryRoot: root, log,
    collect: () => collectGlobalViews({ store, decisions, snapshots, cache, ignores, checkups, autoCheckups, registry, memoryRoot: root, now: () => clock.now, log }),
    collectCheckups: checkupView,
    now: () => clock.now, sleep: async () => {}, lock: sidecar.lock,
  })
  const deps: CheckupRunDeps = {
    scan: {
      store, registry, decisions, cache: opts.wrapCache?.(cache) ?? cache, ignores, instructions: opts.instructions ?? noInstructions,
      checkupCache: db, tokenCap: () => tokenCap.value,
    },
    checkups, views: writer, interval: () => () => {}, now: () => clock.now, log,
  }
  const run = (input: Partial<CheckupRunInput> & Pick<CheckupRunInput, 'target' | 'llm'>) => runCheckup({ by: 'manual', ...input }, deps)
  const recordOf = async (scope: Scope) => (await checkups.list()).find(r => r.id === checkupKey(scope))
  const viewOf = async (scope: Scope) => (await checkupView()).scopes.find(s => checkupKey(s.scope) === checkupKey(scope))!
  return { clock, logs, store, decisions, cache, checkups, autoCheckups, db, tokenCap, deps, run, recordOf, viewOf }
}
type Env = ReturnType<typeof env>

/** 全局三条长记忆，各成一批。 */
async function threeGlobal(e: Env): Promise<void> {
  for (const [i, id] of ['mem_g1', 'mem_g2', 'mem_g3'].entries()) await e.store.put(bigRecord({ id, createdAt: 1 + i }))
}
/** 项目一条长记忆。 */
async function oneProject(e: Env): Promise<void> {
  await e.store.put(bigRecord({ id: 'mem_p1', scope: 'workspace', workspacePath: PROJECT, createdAt: 10 }))
}
const hostError = (code: string): StubModel => {
  const m = stubModel()
  m.fail = () => Object.assign(new Error(`host ${code}`), { code })
  return m
}

describe('收尾表：七行', () => {
  it('第 1 行 提交前取消：完成记录、最近结果都不写，回取消', async () => {
    const e = env()
    await threeGlobal(e)
    const controller = new AbortController()
    const m = stubModel()
    // 第二批发出时取消：还在提交点之前
    m.fail = (_ids, call) => { if (call === 2) controller.abort(); return undefined }
    expect(await e.run({ target: GLOBAL, llm: m, signal: controller.signal })).toEqual({ kind: 'cancelled' })
    expect(await e.recordOf(GLOBAL)).toBeUndefined()
    // 停下时已成功的那批留着
    expect(e.db.readRound('global')!.rows.length).toBeGreaterThanOrEqual(1)
  })

  it('第 1 行 挂完账、写视图之前收到取消：视图、完成记录、最近结果都不写，回取消；已挂的账留着', async () => {
    for (const by of ['manual', 'auto'] as const) {
      const e = env()
      await e.store.put(record({ id: 'mem_a' }))
      await e.store.put(record({ id: 'mem_b' }))
      const controller = new AbortController()
      const upsert = e.decisions.upsert.bind(e.decisions)
      // 挂账刚做完时插件卸载或认领被接手
      const spy = vi.spyOn(e.decisions, 'upsert').mockImplementation(async (...args) => {
        const r = await upsert(...args)
        controller.abort()
        return r
      })
      const m = stubModel({ findings: [{ type: 'conflict', ids: ['mem_a', 'mem_b'] }] })
      expect(await e.run({ target: GLOBAL, llm: m, signal: controller.signal, by }), by).toEqual({ kind: 'cancelled' })
      spy.mockRestore()
      expect(await e.cache.get(scopeCacheKey(GLOBAL)), by).toBeUndefined()
      expect(await e.recordOf(GLOBAL), by).toBeUndefined()
      expect((await e.decisions.list()).map(d => [...d.memoryIds].sort()), by).toEqual([['mem_a', 'mem_b']])
      await rm(join(root, '.state'), { recursive: true, force: true })
      for (const db of opened.splice(0)) db.close()
      await rm(join(root, CHECKUP_CACHE_FILE), { force: true })
    }
  })

  it('第 2 行 模型不可用：不写完成记录，最近结果带覆盖；自动体检回「模型用不了」，不记失败', async () => {
    for (const by of ['manual', 'auto'] as const) {
      const e = env()
      await threeGlobal(e)
      const outcome = await e.run({ target: GLOBAL, llm: hostError('ACCOUNT_SIGN_IN_REQUIRED'), by })
      expect(outcome.kind, by).toBe(by === 'auto' ? 'model-unavailable' : 'done')
      const rec = await e.recordOf(GLOBAL)
      expect(rec?.completed, by).toBeUndefined()
      expect(rec?.failure, by).toBeUndefined()
      expect(rec?.lastResult?.coverage, by).toMatchObject({ stopped: 'model-unavailable', checkedNow: 0, never: 3 })
      await rm(join(root, '.state'), { recursive: true, force: true })
      for (const db of opened.splice(0)) db.close()
      await rm(join(root, CHECKUP_CACHE_FILE), { force: true })
    }
  })

  it('第 3 行 有批失败：不写完成记录，最近结果带覆盖和原因；自动体检记失败', async () => {
    for (const by of ['manual', 'auto'] as const) {
      const e = env()
      await threeGlobal(e)
      const m = stubModel()
      m.fail = () => 'unparseable'
      const outcome = await e.run({ target: GLOBAL, llm: m, by })
      expect(outcome.kind, by).toBe(by === 'auto' ? 'failed' : 'done')
      const rec = await e.recordOf(GLOBAL)
      expect(rec?.completed, by).toBeUndefined()
      expect(rec?.lastResult?.coverage, by).toMatchObject({ stopped: 'batch-failed', checkedNow: 0 })
      expect(rec?.lastResult?.notes, by).toEqual([{ code: 'semantic-failed', cause: expect.objectContaining({ kind: 'unparseable' }) }])
      expect(rec?.failure?.count, by).toBe(by === 'auto' ? 1 : undefined)
      await rm(join(root, '.state'), { recursive: true, force: true })
      for (const db of opened.splice(0)) db.close()
      await rm(join(root, CHECKUP_CACHE_FILE), { force: true })
    }
  })

  it('第 3 行 提交前写视图或挂账出错（注入）：按没做成收，最近结果带覆盖，原因 kind 为 error；完成记录不写', async () => {
    /** 这张表的一个写方法一调就抛错，其余照常（读写同一份数据）。 */
    const failing = <T extends object>(table: T, method: keyof T): T => new Proxy(table, {
      get: (target, key, receiver) => {
        if (key === method) return async () => { throw new Error('磁盘写不进') }
        const value: unknown = Reflect.get(target, key, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    for (const where of ['view', 'ledger'] as const) {
      for (const by of ['manual', 'auto'] as const) {
        const e = env(where === 'view' ? { wrapCache: t => failing(t, 'update') } : { wrapPending: t => failing(t, 'put') })
        await e.store.put(record({ id: 'mem_a', name: 'a', content: '用 pnpm' }))
        await e.store.put(record({ id: 'mem_b', name: 'b', content: '用 npm' }))
        const m = stubModel({ findings: [{ type: 'conflict', ids: ['mem_a', 'mem_b'] }] })
        const outcome = await e.run({ target: GLOBAL, llm: m, by })
        expect(outcome, `${where} ${by}`).toEqual({ kind: 'failed', cause: { kind: 'error', message: '磁盘写不进' } })
        const rec = await e.recordOf(GLOBAL)
        expect(rec?.completed, `${where} ${by}`).toBeUndefined()
        expect(rec?.lastResult?.notes, `${where} ${by}`).toEqual([{ code: 'semantic-failed', cause: { kind: 'error', message: '磁盘写不进' } }])
        expect(rec?.lastResult?.coverage, `${where} ${by}`).toMatchObject({ stopped: 'done', checkedNow: 2 })
        expect(rec?.failure?.count, `${where} ${by}`).toBe(by === 'auto' ? 1 : undefined)
        await rm(join(root, '.state'), { recursive: true, force: true })
        for (const db of opened.splice(0)) db.close()
        await rm(join(root, CHECKUP_CACHE_FILE), { force: true })
      }
    }
  })

  it('第 4 行 范围读不全：不写完成记录，最近结果带覆盖；自动体检记失败，按失败的节奏重试，不会每 10 分钟重跑', async () => {
    for (const by of ['manual', 'auto'] as const) {
      const e = env()
      await threeGlobal(e)
      await e.autoCheckups.set(GLOBAL, 1)
      // 最近删除目录读不了（换成同名文件）：这个范围这次没读全
      await mkdir(join(root, GLOBAL_DIR), { recursive: true })
      await writeFile(join(root, GLOBAL_DIR, ARCHIVE_DIR), '')
      const outcome = await e.run({ target: GLOBAL, llm: stubModel(), by })
      expect(outcome.kind, by).toBe(by === 'auto' ? 'failed' : 'done')
      const rec = await e.recordOf(GLOBAL)
      expect(rec?.completed, by).toBeUndefined()
      expect(rec?.lastResult?.coverage, by).toMatchObject({ isReadComplete: false, stopped: 'done' })
      if (by === 'auto') {
        const view = await e.viewOf(GLOBAL)
        expect(view.failure!.count).toBe(1)
        expect(view.failure!.retryAt).toBeGreaterThan(NOW + 10 * 60_000)
      }
      await rm(join(root, '.state'), { recursive: true, force: true })
      await rm(join(root, GLOBAL_DIR, ARCHIVE_DIR))
      for (const db of opened.splice(0)) db.close()
      await rm(join(root, CHECKUP_CACHE_FILE), { force: true })
    }
  })

  it('第 5 行 有没命中的批但一批都没轮到：完成记录不写（从没体检过的仍没有上次体检），最近结果写「这次没轮到」，一天后接着查', async () => {
    const e = env({ tokenCap: 1 })
    await threeGlobal(e)
    await oneProject(e)
    await e.autoCheckups.set(PROJ, 7)
    expect((await e.run({ target: { kind: 'all' }, llm: stubModel() })).kind).toBe('done')
    const rec = await e.recordOf(PROJ)
    expect(rec?.completed).toBeUndefined()
    expect(rec?.lastResult?.coverage).toMatchObject({ stopped: 'not-reached', checkedNow: 0, total: 4, globalTotal: 3, never: 4 })
    expect(rec?.continueAt).toBe(NOW + DAY_MS)
    const view = await e.viewOf(PROJ)
    expect([view.lastCheckupAt, view.nextCheckupAt, view.isDue]).toEqual([null, NOW + DAY_MS, false])
  })

  it('第 5 行 体检过且没轮到：旧完成记录原样留着，结果行的覆盖是「这次没轮到」', async () => {
    const e = env()
    await threeGlobal(e)
    await oneProject(e)
    await e.run({ target: { kind: 'all' }, llm: stubModel() })
    const before = (await e.recordOf(PROJ))!.completed
    // 都换了：两轮都没命中；上限只够第一批（全局在前）
    e.tokenCap.value = 1
    e.clock.now = NOW + 1000
    await e.run({ target: { kind: 'all' }, llm: stubModel({ model: 'model-b' }) })
    const rec = await e.recordOf(PROJ)
    expect(rec?.completed).toEqual(before)
    expect(rec?.lastResult?.coverage).toMatchObject({ stopped: 'not-reached', never: 0, changed: 0, awaiting: 4 })
    expect(rec?.continueAt).toBe(NOW + 1000 + DAY_MS)
  })

  it('第 6 行 到上限停下：完成记录照写、覆盖如实；下次自动体检取完成后一天和原周期的较早者', async () => {
    const e = env({ tokenCap: 1 })
    await threeGlobal(e)
    await e.autoCheckups.set(GLOBAL, 7)
    await e.run({ target: GLOBAL, llm: stubModel(), by: 'auto' })
    const rec = (await e.recordOf(GLOBAL))!
    expect(rec.completed).toEqual({ startedAt: NOW, completedAt: NOW, by: 'auto', coverage: expect.objectContaining({ stopped: 'cap', checkedNow: 1, never: 2 }) })
    expect(rec.lastResult?.coverage).toMatchObject({ stopped: 'cap' })
    expect(rec.continueAt).toBe(NOW + DAY_MS)
    expect((await e.viewOf(GLOBAL)).nextCheckupAt).toBe(NOW + DAY_MS)
  })

  it('第 7 行 全覆盖：完成记录照写，约的接着查清掉，按原周期；只剩刷新没轮到也算', async () => {
    const e = env({ tokenCap: 1 })
    await threeGlobal(e)
    await e.autoCheckups.set(GLOBAL, 7)
    await e.run({ target: GLOBAL, llm: stubModel() })
    e.tokenCap.value = undefined
    e.clock.now = NOW + 1000
    await e.run({ target: GLOBAL, llm: stubModel() })
    const rec = (await e.recordOf(GLOBAL))!
    expect(rec.completed?.coverage).toMatchObject({ stopped: 'done', never: 0, changed: 0, awaiting: 0 })
    expect(rec).not.toHaveProperty('continueAt')
    expect((await e.viewOf(GLOBAL)).nextCheckupAt).toBe(NOW + 1000 + 7 * DAY_MS)
    // 31 天后：各批都到期该刷新，上限只够一批——刷新没轮到的不算没覆盖
    e.tokenCap.value = 1
    e.clock.now = NOW + 31 * DAY_MS
    await e.run({ target: GLOBAL, llm: stubModel() })
    const later = (await e.recordOf(GLOBAL))!
    expect(later.completed).toMatchObject({ startedAt: NOW + 31 * DAY_MS, coverage: { stopped: 'done', never: 0, changed: 0, awaiting: 0 } })
    expect(later).not.toHaveProperty('continueAt')
  })

  it('第 7 行 本来没有要查的、指令文件取不到：照写完成记录；取不到时覆盖记下来，不算全覆盖', async () => {
    const e = env({ instructions: instructionsOf({ global: { kind: 'unavailable', reason: '读不了' } }) })
    await e.store.put(record({ id: 'mem_g', name: '全局' }))
    await e.run({ target: GLOBAL, llm: stubModel() })
    expect((await e.recordOf(GLOBAL))!.completed?.coverage).toMatchObject({ baseline: 'unavailable', stopped: 'done', never: 0 })
  })
})

describe('收尾表：提交之后', () => {
  it('提交后写体检记录失败：视图已更新、有日志、不抛，照样算做完', async () => {
    const e = env()
    await threeGlobal(e)
    vi.spyOn(e.checkups, 'complete').mockRejectedValue(new Error('体检记录写不进'))
    expect((await e.run({ target: GLOBAL, llm: stubModel() })).kind).toBe('done')
    expect((await e.cache.get(scopeCacheKey(GLOBAL)))?.scannedAt).toBe(NOW)
    expect(e.logs.some(l => l.includes('写体检记录失败'))).toBe(true)
  })

  it('提交后取消（跨项目比较期间）：按已提交的收，各轮的完成记录都在', async () => {
    const e = env()
    await e.store.put(record({ id: 'mem_g' }))
    await e.store.put(record({ id: 'mem_p1', summary: '用 pnpm', scope: 'workspace', workspacePath: PROJECT }))
    await e.store.put(record({ id: 'mem_p2', summary: '用 pnpm', scope: 'workspace', workspacePath: `${PROJECT}-2` }))
    const controller = new AbortController()
    const m = stubModel()
    const complete = m.complete
    m.complete = async (input, signal, onUsage) => {
      if (input.system.includes('多个项目（workspace）')) {
        controller.abort()
        throw signal?.reason ?? new DOMException('aborted', 'AbortError')
      }
      return complete(input, signal, onUsage)
    }
    expect((await e.run({ target: { kind: 'all' }, llm: m, signal: controller.signal })).kind).toBe('done')
    for (const scope of [GLOBAL, PROJ, { kind: 'workspace' as const, workspacePath: `${PROJECT}-2` }]) {
      expect((await e.recordOf(scope))?.completed?.coverage, checkupKey(scope)).toMatchObject({ stopped: 'done' })
    }
  })
})

describe('入口矩阵', () => {
  const envs: CheckupEnv[] = []
  afterEach(async () => { for (const x of envs.splice(0)) await x.close() })
  async function core(): Promise<CheckupEnv> {
    const x = await checkupEnv()
    envs.push(x)
    await x.store.put(record({ id: 'mem_a', name: 'a', content: '用 pnpm' }))
    return x
  }

  it('memory_scan layers=rule：不碰库、不碰视图、不写完成记录和最近结果', async () => {
    const x = await core()
    const m = stubModel()
    await x.scan({ llm: m, layers: 'rule' })
    expect(m.calls).toEqual([])
    expect(x.db.rounds()).toEqual([])
    expect(await x.view(GLOBAL)).toBeUndefined()
    expect(await x.checkups.list()).toEqual([])
  })

  it('memory_scan（发起方 agent）到上限停下或没轮到：不约下次接着查，只有界面手动和自动体检约', async () => {
    const x = await checkupEnv({ tokenCap: 1 })
    envs.push(x)
    for (const [i, id] of ['mem_g1', 'mem_g2'].entries()) await x.store.put(bigRecord({ id, createdAt: 1 + i }))
    await x.store.put(bigRecord({ id: 'mem_p1', scope: 'workspace', workspacePath: PROJECT, createdAt: 10 }))
    await x.scan({ llm: stubModel(), target: { kind: 'checkup', workspaces: [PROJECT] } }, { by: 'agent' })
    const records = await x.checkups.list()
    expect(records.length).toBeGreaterThan(0)
    for (const rec of records) expect(rec, rec.id).not.toHaveProperty('continueAt')
  })

  it('memory_scan layers=semantic：读写库、发布视图，不写完成记录和最近结果', async () => {
    const x = await core()
    await x.scan({ llm: stubModel(), layers: 'semantic' }, { by: 'agent' })
    expect(x.db.readRound('global')!.rows).toHaveLength(1)
    expect(await x.view(GLOBAL)).toBeDefined()
    expect(await x.checkups.list()).toEqual([])
  })

  it('memory_scan layers=full：读写库、发布视图；完成记录照现有行为写（发起方 agent），最近结果不写', async () => {
    const x = await core()
    await x.scan({ llm: stubModel(), layers: 'full' }, { by: 'agent' })
    expect(x.db.readRound('global')!.rows).toHaveLength(1)
    expect(await x.view(GLOBAL)).toBeDefined()
    const [rec] = await x.checkups.list()
    expect(rec!.completed?.by).toBe('agent')
    expect(rec).not.toHaveProperty('lastResult')
  })

  it('界面手动体检、自动体检：读写库、发布视图、按收尾表写完成记录和最近结果', async () => {
    for (const by of ['manual', 'auto'] as const) {
      const e = env()
      await e.store.put(record({ id: 'mem_a', name: 'a' }))
      expect((await e.run({ target: GLOBAL, llm: stubModel(), by })).kind, by).toBe('done')
      expect(e.db.readRound('global')!.rows, by).toHaveLength(1)
      expect(await e.cache.get(scopeCacheKey(GLOBAL)), by).toBeDefined()
      const rec = await e.recordOf(GLOBAL)
      expect([rec?.completed?.by, rec?.lastResult?.by], by).toEqual([by, by])
      await rm(join(root, '.state'), { recursive: true, force: true })
      for (const db of opened.splice(0)) db.close()
      await rm(join(root, CHECKUP_CACHE_FILE), { force: true })
    }
  })

  it('没有默认模型、进执行器前就返回的入口照现有处理：不产生覆盖', async () => {
    const x = await core()
    const r = await x.scan({ llm: null })
    expect(r.kind === 'single' ? r.rounds : 'error').toBeUndefined()
    expect(renderScanResult(r)).not.toContain('内容检查共')
  })
})

describe('最近一次读不全之后', () => {
  // 界面各处（状态条首行、左栏、设置页状态卡、待处理空态）都按健康视图这一层的覆盖用 isCoverageClear 判断能不能说良好
  it('完成记录是上次全覆盖的、最近一次读不全：健康视图的覆盖取最近这次，界面和 memory_health 单范围、全库都不说健康；上次体检时间仍是完成记录的', async () => {
    const e = env()
    await e.store.put(record({ id: 'mem_ok', lastConfirmedAt: NOW }))
    const healthOf = (scope?: string) => executeHealth(scope !== undefined ? { scope } : {}, {
      ...e.deps.scan, checkups: e.checkups, thresholds: { actionScoreThreshold: 70, pendingOverdueDays: 7, scanStaleDays: 7 },
      host: { contextOf: async () => ({ workspacePath: undefined }) }, now: () => e.clock.now,
    }, fakeExec())
    const globalLayer = async () => (await e.deps.views.collectViews()).health.layers.find(l => l.layer.kind === 'global')!
    expect((await e.run({ target: GLOBAL, llm: stubModel() })).kind).toBe('done')
    const first = await e.recordOf(GLOBAL)
    expect(first?.completed?.coverage?.isReadComplete).toBe(true)
    expect((await globalLayer()).coverage).toMatchObject({ isReadComplete: true, never: 0, changed: 0, awaiting: 0 })
    expect(renderHealthResult(await healthOf())).toContain('记忆库健康，无需操作')

    e.clock.now += 10_000
    // 最近删除目录读不了（换成同名文件）：这次没读全
    await writeFile(join(root, GLOBAL_DIR, ARCHIVE_DIR), '')
    expect((await e.run({ target: GLOBAL, llm: stubModel() })).kind).toBe('done')
    const latest = await e.recordOf(GLOBAL)
    expect(latest?.completed).toEqual(first?.completed)
    expect(latest?.lastResult?.coverage?.isReadComplete).toBe(false)

    const layer = await globalLayer()
    expect(layer.lastCheckupAt).toBe(first?.completed?.completedAt)
    expect(layer.coverage?.isReadComplete).toBe(false)
    const single = await healthOf()
    expect(renderHealthResult(single)).not.toContain('记忆库健康')
    expect(single.kind === 'single' && single.recommendationKinds).toContain('checkup-incomplete')
    const all = renderHealthResult(await healthOf('all')).split('\n')
    expect(all.find(l => l.startsWith('- global：'))).toContain('这个范围没读全')
    expect(all).toContain('1 个范围上次体检的内容检查没覆盖全（见各行），建议再运行一次 memory_scan')
  })

  it('最近一次结果比完成记录旧（之后 memory_scan 又写了完成记录）：按完成记录说', async () => {
    const e = env()
    await e.store.put(record({ id: 'mem_ok', lastConfirmedAt: NOW }))
    await writeFile(join(root, GLOBAL_DIR, ARCHIVE_DIR), '')
    expect((await e.run({ target: GLOBAL, llm: stubModel() })).kind).toBe('done')
    expect((await e.recordOf(GLOBAL))?.lastResult?.coverage?.isReadComplete).toBe(false)
    await rm(join(root, GLOBAL_DIR, ARCHIVE_DIR))
    e.clock.now += 10_000
    await runScan({ target: { kind: 'scope', scope: GLOBAL }, layers: 'full', llm: stubModel(), startedAt: e.clock.now },
      { ...e.deps.scan, checkups: e.checkups, now: () => e.clock.now }, { by: 'agent' })
    expect((await e.deps.views.collectViews()).health.layers.find(l => l.layer.kind === 'global')!.coverage).toMatchObject({ isReadComplete: true, never: 0, changed: 0, awaiting: 0 })
  })
})

describe('和 0.2.0 共存', () => {
  it('这一版写的体检记录（完成记录和最近结果带覆盖、约的接着查）和视图，0.2.0 照常解析；落盘的说明码、发起方、原因没有新值', async () => {
    const old = await loadRelease020Schemas()
    const e = env({ tokenCap: 1 })
    await threeGlobal(e)
    await oneProject(e)
    await e.run({ target: { kind: 'all' }, llm: stubModel() })
    // 存储出错收尾的那一种（原因 kind 为 error）也在
    const failing = env({ wrapCache: t => ({ ...t, get: k => t.get(k), list: () => t.list(), delete: k => t.delete(k), update: async () => { throw new Error('写不进') } }) as CasKvTable<ScanCacheEntry> })
    await failing.run({ target: GLOBAL, llm: stubModel() })
    const records = await e.checkups.list()
    expect(records.some(r => r.completed?.coverage !== undefined && r.continueAt !== undefined)).toBe(true)
    expect(records.some(r => r.lastResult?.coverage?.stopped === 'not-reached')).toBe(true)
    for (const r of records) expect(old.checkupRecord.safeParse(r).success, r.id).toBe(true)
    for (const [, entry] of await e.cache.list()) expect(old.scanCache.safeParse(entry).success).toBe(true)
  })

  it('带各成员扫描指纹的待决条目（未决的、两边都留结清的）：0.2.0 照常解析', async () => {
    const old = await loadRelease020Schemas()
    const e = env()
    await e.store.put(record({ id: 'mem_a', name: 'a', content: '用 pnpm' }))
    await e.store.put(record({ id: 'mem_b', name: 'b', content: '用 npm' }))
    await e.run({ target: GLOBAL, llm: stubModel({ findings: [{ type: 'conflict', ids: ['mem_a', 'mem_b'] }] }) })
    const [open] = await e.decisions.list()
    expect(open!.memberScanFingerprints).toBeDefined()
    expect(old.pendingDecision.safeParse(open).success).toBe(true)
    await e.decisions.settle(open!.id, 'keep-both', NOW, { memberScanFingerprints: open!.memberScanFingerprints! })
    const [settled] = await e.decisions.listSettled()
    expect(old.pendingDecision.safeParse(settled).success).toBe(true)
  })

  it('0.2.0 写的、0.2.0 写回丢了覆盖字段的记录：这一版照常读，不加覆盖', async () => {
    const old = await loadRelease020Schemas()
    const e = env({ tokenCap: 1 })
    await threeGlobal(e)
    await e.run({ target: GLOBAL, llm: stubModel() })
    const mine = (await e.recordOf(GLOBAL))!
    // 0.2.0 读进来再写回：不认识的键丢掉
    const rewritten = old.checkupRecord.safeParse(mine).data as Record<string, unknown>
    expect(rewritten).not.toHaveProperty('continueAt')
    expect(rewritten.completed).not.toHaveProperty('coverage')
    const parsed = checkupRecordSchema.parse(rewritten)
    expect(parsed.completed).toEqual({ startedAt: NOW, completedAt: NOW, by: 'manual' })
    expect(parsed.lastResult).not.toHaveProperty('coverage')
  })
})

describe('全部重查经界面体检', () => {
  it('scan 命令带 isFullRecheck 时，没改过的也重新交给模型；不带时直接用上次的结论', async () => {
    const e = env()
    await threeGlobal(e)
    const m = stubModel()
    await e.run({ target: GLOBAL, llm: m })
    e.clock.now = NOW + 1000
    await e.run({ target: GLOBAL, llm: m })
    expect(m.calls).toHaveLength(3)
    e.clock.now = NOW + 2000
    await e.run({ target: GLOBAL, llm: m, isFullRecheck: true })
    expect(m.calls).toHaveLength(6)
  })

  it('命令契约：isFullRecheck 可选，只收布尔值', () => {
    expect(memoryCommandSchema.safeParse({ cmd: 'scan', isFullRecheck: true }).success).toBe(true)
    expect(memoryCommandSchema.safeParse({ cmd: 'scan', workspacePath: PROJECT, isFullRecheck: false }).success).toBe(true)
    expect(memoryCommandSchema.safeParse({ cmd: 'scan', isFullRecheck: 'yes' }).success).toBe(false)
  })
})
