/**
 * 存储规模基准：在临时目录生成一棵记忆根，用插件自己的存储层与工具执行器计时常见操作，
 * 输出 markdown 表格（各操作的中位数耗时）。手动运行，不进 CI；跑完删除临时目录。
 *
 * 用法：
 *   pnpm bench:storage                                   默认 10 个项目 × 1000 条 + 200 条 global，每项 10 轮
 *   pnpm bench:storage --projects 3 --per-project 100 --rounds 5
 *   node scripts/bench-storage.ts --projects 3 ...       同上（Node ≥23.6 原生执行 .ts）
 *
 * 计时口径（每项先空跑一轮预热，不计入；之后跑 --rounds 轮取中位数）：
 *   - 插件加载：新建 SidecarStore + FileTable，首次 load()（读全部记忆文件、合并召回统计、核对索引）。
 *   - refreshIfChanged（无变化）：工具调用前的外部改动检测，下面四个工具项都包含这一步。
 *   - 快照冻结：SnapshotCache.assemble，每轮一个新 session（预读可见记录 + 组装 + 首次冻结计召回）。
 *   - memory_search / memory_save / update / memory_health：refreshIfChanged + 对应执行器，
 *     与插件接线（index.ts 的 withRefresh）一致；不接 llm / sessionQuery，health 只有规则层。
 * 页缓存是热的：测的是同一进程内反复操作的稳态，不含冷盘 I/O。
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir, cpus, platform, arch } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { parseArgs } from 'node:util'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { FileTable } from '../src/storage/file-table.ts'
import { SidecarStore } from '../src/storage/sidecar.ts'
import { encodeRecord } from '../src/storage/frontmatter.ts'
import { GLOBAL_DIR, WORKSPACE_MARKER, workspaceDirName } from '../src/storage/paths.ts'
import type { MemoryLogger } from '../src/storage/table.ts'
import type { MemoryRecord } from '../src/record-schema.ts'
import { MemoryStore } from '../src/store.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'
import { formatIndexLine } from '../src/index-line.ts'
import { SnapshotCache } from '../src/runtime.ts'
import { PendingDecisionsStore } from '../src/governance/decisions.ts'
import { memorySnapshotSchema, pendingDecisionSchema, scanCacheSchema } from '../src/governance/schema.ts'
import { resolveHealthThresholds } from '../src/governance/health-presets.ts'
import { executeSearch } from '../src/tools/search.ts'
import { executeSave } from '../src/tools/save.ts'
import { executeHealth } from '../src/tools/health.ts'

const GLOBAL_COUNT = 200
const DAY = 86_400_000

const { values: opts } = parseArgs({
  options: {
    projects: { type: 'string', default: '10' },
    'per-project': { type: 'string', default: '1000' },
    rounds: { type: 'string', default: '10' },
  },
})
function positiveInt(name: string, raw: string): number {
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1) throw new Error(`--${name} 必须是正整数：${raw}`)
  return n
}
const projects = positiveInt('projects', opts.projects)
const perProject = positiveInt('per-project', opts['per-project'])
const rounds = positiveInt('rounds', opts.rounds)

// —— 确定性数据生成 ——

/** mulberry32：同参数每次生成同一棵树，前后两次基准可比。 */
function prng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rand = prng(20261022)
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]

// 小写词与中文短语：不带反引号、路径、引号、全大写缩写，避免被去重的实体轴当成实体
const WORDS = ['redis', 'postgres', 'vite', 'kafka', 'docker', 'nginx', 'vitest', 'pnpm', 'zod', 'grpc', 'webpack', 'eslint', 'terraform', 'sqlite', 'prisma', 'rollup', 'deno', 'bun', 'jest', 'helm']
const PHRASES = ['部署流程', '缓存失效', '连接池上限', '迁移脚本', '发版检查', '日志采样', '权限模型', '重试策略', '索引重建', '配置加载', '超时阈值', '构建缓存']
const TYPES = ['profile', 'preference', 'knowledge', 'project', 'reference', 'procedure'] as const
const MODES = ['user-explicit', 'user-behavior', 'environment-observed', 'agent-inferred', 'agent-action-confirmed'] as const

function makeRecord(id: string, name: string, loc: { scope: 'global' } | { scope: 'workspace'; workspacePath: string }, now: number): MemoryRecord {
  const w1 = pick(WORDS), w2 = pick(WORDS), p1 = pick(PHRASES), p2 = pick(PHRASES)
  const roll = rand()
  const status = roll < 0.95 ? 'active' : roll < 0.98 ? 'superseded' : 'deleted'
  // deleted 的 updatedAt 留在 14 天清扫窗口内，否则预热加载会把它们物理清掉、改变数据集
  const updatedAt = status === 'deleted' ? now - Math.floor(rand() * 5 * DAY) : now - Math.floor(rand() * 60 * DAY)
  const createdAt = updatedAt - Math.floor(rand() * 30 * DAY)
  return {
    id, name, type: pick(TYPES), ...loc,
    tags: [w1, p1],
    content: `${p1}里 ${w1} 与 ${w2} 配合时要先确认${p2}，第 ${Math.floor(rand() * 100)} 次排查记下的经验：改动后重跑 ${w2} 相关检查，再看${p1}是否回归。`,
    summary: `${w1} ${p1}要点`,
    source: { sessionId: `bench-${Math.floor(rand() * 500)}`, eventRange: [0, Math.floor(rand() * 200)], sourceMode: pick(MODES) },
    createdAt, updatedAt, lastConfirmedAt: updatedAt,
    lastRecalledAt: null, recallCount: 0,
    status, confidence: pick([0.5, 0.8, 0.9]),
  }
}

async function writeDir(dir: string, records: MemoryRecord[]): Promise<void> {
  await mkdir(dir, { recursive: true })
  await Promise.all(records.map(r => writeFile(join(dir, `${r.name}.md`), encodeRecord(r, {}), 'utf8')))
}

async function generate(root: string, workspaces: string[], now: number): Promise<MemoryRecord[]> {
  const all: MemoryRecord[] = []
  const globals = Array.from({ length: GLOBAL_COUNT }, (_, i) =>
    makeRecord(`mem_bench_g_${i}`, `bench-global-${i}`, { scope: 'global' }, now))
  await writeDir(join(root, GLOBAL_DIR), globals)
  all.push(...globals)
  for (const [w, wsPath] of workspaces.entries()) {
    const dir = join(root, workspaceDirName(wsPath))
    const records = Array.from({ length: perProject }, (_, i) =>
      makeRecord(`mem_bench_w${w}_${i}`, `bench-w${w}-${i}`, { scope: 'workspace', workspacePath: wsPath }, now))
    await writeDir(dir, records)
    await writeFile(join(dir, WORKSPACE_MARKER), `${wsPath}\n`, 'utf8')
    all.push(...records)
  }
  return all
}

// —— 计时 ——

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

async function bench(label: string, fn: (round: number) => Promise<unknown>): Promise<{ label: string; ms: number }> {
  await fn(-1) // 预热，不计入
  const samples: number[] = []
  for (let i = 0; i < rounds; i++) {
    const t0 = performance.now()
    await fn(i)
    samples.push(performance.now() - t0)
  }
  return { label, ms: median(samples) }
}

// —— 主流程 ——

let warnings = 0
const quietLog: MemoryLogger = { info() {}, warn() { warnings++ }, error() { warnings++ } }
const registry = buildTypeRegistry({ template: 'coding', customTypes: {} })
const fmtIndex = (r: MemoryRecord) => formatIndexLine(r, { passive: registry.get(r.type).recall === 'passive' })
const newSidecar = (root: string) => new SidecarStore({
  root,
  schemas: { snapshots: memorySnapshotSchema, pending: pendingDecisionSchema, scanCache: scanCacheSchema },
  log: quietLog,
})

const root = await mkdtemp(join(tmpdir(), 'plastic-bench-'))
try {
  const now = Date.now()
  // 虚构的 workspace 路径：只写进 .workspace 标记，不需要在本机存在
  const workspaces = Array.from({ length: projects }, (_, i) => `/bench/project-${String(i).padStart(2, '0')}`)
  const currentWs = workspaces[0]
  const t0 = performance.now()
  const seeded = await generate(root, workspaces, now)
  // 约三成记录带召回统计，接近用过一阵的库
  const seedSidecar = newSidecar(root)
  await seedSidecar.recallStats.putMany(seeded.filter(() => rand() < 0.3)
    .map(r => [r.id, { id: r.id, recallCount: 1 + Math.floor(rand() * 20), lastRecalledAt: now - Math.floor(rand() * 30 * DAY) }]))
  const genMs = performance.now() - t0

  // 工具共用的一份运行时（对应插件加载后的常驻状态）
  const sidecar = newSidecar(root)
  const fileTable = new FileTable({ root, stats: sidecar.recallStats, formatIndexLine: fmtIndex, log: quietLog })
  await fileTable.load()
  const store = new MemoryStore(fileTable, quietLog, sidecar.recallStats)
  const decisions = new PendingDecisionsStore(sidecar.pending)
  const exec = { signal: new AbortController().signal } as ToolRunContext
  const session = { id: 'bench-session', lastSeq: 10, turnStartSeq: 5 }
  const resolveContext = async () => ({ workspacePath: currentWs, session })
  const snapshotCache = new SnapshotCache({ store, registry, budget: 4000, memoryRoot: root, evidenceLookup: 'strict', log: quietLog })
  const healthDeps = {
    store, registry, decisions, cache: sidecar.scanCache,
    thresholds: resolveHealthThresholds('normal'),
    getQuarantined: () => fileTable.quarantined(),
    memoryRoot: root, resolveContext,
  }
  const updateTargets = seeded.filter(r => r.workspacePath === currentWs && r.status === 'active')

  const results = [
    await bench('插件加载（构造 + 首次 load）', async () => {
      const table = new FileTable({ root, stats: newSidecar(root).recallStats, formatIndexLine: fmtIndex, log: quietLog })
      await table.load()
    }),
    await bench('refreshIfChanged（无变化）', () => fileTable.refreshIfChanged()),
    await bench('快照冻结（当前项目 + global）', async () => {
      const s = {}
      snapshotCache.setWorkspacePath(s, currentWs)
      const text = await snapshotCache.assemble(s)
      if (!text.startsWith('# 长期记忆')) throw new Error('快照没有组装出记忆内容')
    }),
    await bench('memory_search', async () => {
      await fileTable.refreshIfChanged()
      const r = await executeSearch({ query: `${WORDS[0]} 部署流程` }, exec, { store, registry, resolveContext })
      if (r.hits.length === 0) throw new Error('memory_search 没有命中')
    }),
    await bench('memory_save（create）', async round => {
      await fileTable.refreshIfChanged()
      // 正文全是随机词：每轮都要真的落盘，不能被 bigram 相似度判成前几轮样本的重复
      const words = Array.from({ length: 6 }, () => Math.random().toString(36).slice(2, 10))
      const r = await executeSave({
        action: 'create', name: `bench-save-${round + 1}-${words[0]}`, type: 'knowledge', scope: 'workspace',
        content: words.join(' '), summary: words.slice(0, 2).join(' '), sourceMode: 'user-explicit',
      }, exec, { store, registry, resolveContext })
      if (r.kind !== 'saved') throw new Error(`memory_save 未落盘：${r.kind}`)
    }),
    await bench('memory_save（update）', async round => {
      await fileTable.refreshIfChanged()
      const target = updateTargets[(round + 1) % updateTargets.length]
      const r = await executeSave({
        action: 'update', id: target.id, name: target.name, type: target.type, scope: 'workspace',
        content: `${target.content}（第 ${round + 2} 次更新）`, summary: target.summary, sourceMode: 'user-explicit',
      }, exec, { store, registry, resolveContext })
      if (r.kind !== 'updated') throw new Error(`update 未落盘：${r.kind}`)
    }),
    await bench('memory_health 单层（当前项目）', async () => {
      await fileTable.refreshIfChanged()
      await executeHealth({}, healthDeps, exec)
    }),
    await bench(`memory_health 全库（global + ${projects} 个项目）`, async () => {
      await fileTable.refreshIfChanged()
      await executeHealth({ scope: 'all' }, healthDeps, exec)
    }),
  ]

  const cpu = cpus()[0]?.model ?? 'unknown'
  console.log(`Node ${process.version}，${platform()} ${arch()}，${cpu}`)
  console.log(`记录数：${projects} 个项目 × ${perProject} 条 + ${GLOBAL_COUNT} 条 global = ${seeded.length} 条（约 5% 非 active）；生成耗时 ${Math.round(genMs)} ms`)
  console.log(`每项预热 1 轮后计 ${rounds} 轮取中位数；存储层告警 ${warnings} 条`)
  console.log('')
  console.log('| 操作 | 中位数 ms | 轮数 |')
  console.log('| --- | ---: | ---: |')
  for (const r of results) console.log(`| ${r.label} | ${r.ms.toFixed(1)} | ${rounds} |`)
} finally {
  await rm(root, { recursive: true, force: true })
}
