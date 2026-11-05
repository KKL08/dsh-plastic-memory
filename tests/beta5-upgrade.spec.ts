// 本文件与 fixtures/beta5-upgrade 随旧 KV 导入代码在 0.3.0 一起删除。
//
// 升级样本：0.1.1-beta.5 真实写进宿主 KV 的四张表和它落盘的记忆文件，冻结成 fixture，
// 交给当前插件的旧 KV 导入。fixture 里的机器路径是占位符，时间是相对生成时刻的偏移（@T±毫秒），
// 这里按临时目录和「现在」展开，系统时钟怎么走都不触发保留期、过期规则。
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { apply, Config } from '../src/index.ts'
import { fakeExec } from './helpers/exec.ts'

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'beta5-upgrade')
const TIME_RE = /^@T([+-]\d+)$/
/** 样本最晚的时间戳比生成时刻晚不到一秒；基准往前挪一分钟，展开后全是过去的时间。 */
const baseMs = () => Date.now() - 60_000

type Rows = Array<[string, unknown]>
type KvFixture = Record<'snapshots' | 'pending_decisions' | 'recall_stats' | 'scan_cache', Rows>

/** 宿主 storageDomain 表的替身（KvTable 的形状）：读同步、写异步。 */
class HostKvTable {
  readonly map: Map<string, unknown>
  constructor(rows: Rows = []) { this.map = new Map(rows) }
  get(key: string) { return this.map.get(key) }
  entries() { return this.map.entries() }
  keys() { return this.map.keys() }
  async put(key: string, value: unknown) { this.map.set(key, value) }
  async delete(key: string) { return this.map.delete(key) }
}

/** 记忆目录名：可读前缀 + 路径 sha1 前 8 位（磁盘布局是冻结契约，这里照写，不从 src 取）。 */
function projectDirName(projectPath: string): string {
  return `demo-project-${createHash('sha1').update(projectPath).digest('hex').slice(0, 8)}`
}

/** 展开 fixture：占位符换成本次的临时路径，@T±n 按 asTime 换成时间。 */
function expander(paths: { memoryRoot: string; project: string }, base: number) {
  const text = (s: string) => s.split('{{MEMORY_ROOT}}').join(paths.memoryRoot).split('{{PROJECT}}').join(paths.project)
  const value = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const m = TIME_RE.exec(v)
      return m ? base + Number(m[1]) : text(v)
    }
    if (Array.isArray(v)) return v.map(value)
    if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [text(k), value(x)]))
    return v
  }
  const file = (s: string) => text(s).replace(/@T([+-]\d+)/g, (_m, off: string) => new Date(base + Number(off)).toISOString())
  return { text, value, file }
}

async function listFiles(dir: string, prefix = ''): Promise<string[]> {
  const out: string[] = []
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.isDirectory()) out.push(...await listFiles(join(dir, e.name), join(prefix, e.name)))
    else out.push(join(prefix, e.name))
  }
  return out
}

const tmpDirs: string[] = []
afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map(d => rm(d, { recursive: true, force: true })))
})

/** 按 fixture 摆好 beta.5 留下的现场：记忆文件落进临时 memoryRoot，KV 行装进假域。 */
async function stageBeta5() {
  const work = await mkdtemp(join(tmpdir(), 'plastic-memory-beta5-'))
  tmpDirs.push(work)
  await mkdir(join(work, 'demo-project'))
  const project = await realpath(join(work, 'demo-project'))
  const memoryRoot = join(work, 'memories')
  const x = expander({ memoryRoot, project }, baseMs())

  const memoryFiles = await listFiles(join(FIXTURE, 'memories'))
  for (const rel of memoryFiles) {
    const target = join(memoryRoot, rel.split('{{PROJECT_DIR}}').join(projectDirName(project)))
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, x.file(await readFile(join(FIXTURE, 'memories', rel), 'utf8')), 'utf8')
  }
  const raw = JSON.parse(await readFile(join(FIXTURE, 'kv.json'), 'utf8')) as KvFixture
  const kv = Object.fromEntries(Object.entries(raw).map(([table, rows]) => [table, rows.map(([k, v]) => [x.text(k), x.value(v)])])) as KvFixture

  // 每次打开都从同一组表取：导入读一次、删旧行再开一次
  const tables = new Map(Object.entries(kv).map(([name, rows]) => [name, new HostKvTable(structuredClone(rows))]))
  const storageDomain = {
    open: async () => ({
      table: (name: string) => {
        let t = tables.get(name)
        if (!t) tables.set(name, t = new HostKvTable())
        return t
      },
      global: {}, name: 'plastic_memory', close: async () => {},
    }),
  }
  const tools = new Map<string, { execute(args: unknown, exec: unknown): Promise<unknown> }>()
  const ctx = {
    tools: { register: (def: { name: string; execute(args: unknown, exec: unknown): Promise<unknown> }) => { tools.set(def.name, def); return () => {} } },
    on: () => () => {},
    get: (name: string) => (name === 'storageDomain' ? storageDomain : undefined),
    inject: () => () => {},
    logger: { info() {}, warn() {}, error() {} },
  }
  const run = (name: string, args: unknown) => tools.get(name)!.execute(args, fakeExec())
  return { memoryRoot, project, kv, tables, ctx, run, memoryFiles }
}

/** fixture 记忆文件里 status: active 的条数，按层分（global / 项目）。 */
async function activeCounts(memoryFiles: string[]) {
  const counts = { global: 0, project: 0 }
  for (const rel of memoryFiles.filter(f => f.endsWith('.md') && !f.endsWith('MEMORY.md'))) {
    const text = await readFile(join(FIXTURE, 'memories', rel), 'utf8')
    if (/^status: active$/m.test(text)) counts[rel.startsWith('global') ? 'global' : 'project']++
  }
  return counts
}

describe('beta.5 升级样本', () => {
  it('PA-24：beta.5 的快照与待决逐字段迁进 .state/，记忆照读，召回统计与扫描缓存留在 KV 不导', async () => {
    const { memoryRoot, project, kv, tables, ctx, run, memoryFiles } = await stageBeta5()
    // 样本覆盖面：快照四种操作以上、待决横向与垂直、四张表都有行
    expect(new Set(kv.snapshots.map(([, s]) => (s as { operation: string }).operation)).size).toBeGreaterThanOrEqual(4)
    expect(kv.pending_decisions.some(([, p]) => (p as { baselineRef?: string }).baselineRef !== undefined)).toBe(true)
    expect(kv.recall_stats.length).toBeGreaterThan(0)
    expect(kv.scan_cache.length).toBeGreaterThan(0)

    await apply(ctx as never, new Config({ memoryRoot } as never))
    await run('memory_snapshot', { action: 'list' }) // 首次侧表访问触发导入

    const state = join(memoryRoot, '.state')
    // 每条 beta.5 行落成一个文件，内容逐字段相等（当前 schema 新增的字段都是可选、无缺省值，不应出现）
    for (const [dir, rows] of [['snapshots', kv.snapshots], ['pending', kv.pending_decisions]] as const) {
      expect((await readdir(join(state, dir))).sort()).toEqual(rows.map(([key]) => `${key}.json`).sort())
      for (const [key, row] of rows) {
        expect(JSON.parse(await readFile(join(state, dir, `${key}.json`), 'utf8')), `${dir}/${key}`).toEqual(row)
      }
    }

    // 导入标记：来自 KV、条数对得上、旧行已清
    expect(JSON.parse(await readFile(join(state, 'kv-import.json'), 'utf8'))).toEqual({
      version: 1, importedAt: expect.any(Number), source: 'kv',
      counts: { snapshots: kv.snapshots.length, pending: kv.pending_decisions.length }, discarded: true,
    })
    expect([...tables.get('snapshots')!.keys()]).toEqual([])
    expect([...tables.get('pending_decisions')!.keys()]).toEqual([])

    // beta.5 写下的记忆当前插件照读：各层 active 条数与 fixture 一致
    const health = await run('memory_health', { scope: 'all' }) as { rows: Array<{ layer: string; workspacePath?: string; totalMemories: number }> }
    const expected = await activeCounts(memoryFiles)
    expect(health.rows.map(r => [r.layer, r.workspacePath, r.totalMemories])).toEqual([
      ['global', undefined, expected.global],
      ['workspace', project, expected.project],
    ])

    // 召回统计、扫描缓存不导：.state/ 里没有它们的行，KV 里的行原样不动
    await expect(stat(join(state, 'scan-cache'))).rejects.toMatchObject({ code: 'ENOENT' })
    const recall = await readFile(join(state, 'recall-stats.json'), 'utf8').then(t => JSON.parse(t) as Record<string, unknown>, () => ({}))
    expect(Object.keys(recall).filter(id => kv.recall_stats.some(([key]) => key === id))).toEqual([])
    expect([...tables.get('recall_stats')!.entries()]).toEqual(kv.recall_stats)
    expect([...tables.get('scan_cache')!.entries()]).toEqual(kv.scan_cache)
  })
})
