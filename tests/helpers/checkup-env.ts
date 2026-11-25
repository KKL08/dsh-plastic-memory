import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CheckupCache } from '../../src/storage/checkup-cache.ts'
import { CHECKUP_CACHE_FILE } from '../../src/storage/paths.ts'
import { MemoryStore } from '../../src/store.ts'
import { PendingDecisionsStore } from '../../src/governance/decisions.ts'
import { CheckupRecordStore } from '../../src/governance/checkup-records.ts'
import { buildTypeRegistry } from '../../src/type-registry.ts'
import { runScan, type ScanCoreDeps, type ScanInput, type ScanToolResult } from '../../src/tools/scan.ts'
import type { SemanticLlm } from '../../src/governance/semantic-scan.ts'
import type { ReadInstructions } from '../../src/governance/instructions.ts'
import type { CheckupRecord, RecallStats } from '../../src/storage/schema.ts'
import type { PendingDecision, ScanCacheEntry } from '../../src/governance/schema.ts'
import type { MemoryRecord } from '../../src/record-schema.ts'
import type { CheckupInitiator } from '../../src/contract-codes.ts'
import { scopeCacheKey, type Scope } from '../../src/scope.ts'
import { FileTable } from '../../src/storage/file-table.ts'
import { InMemoryBatchKvTable, InMemoryKvTable } from './in-memory-kv.ts'
import { noInstructions } from './instructions.ts'
import { record } from './record.ts'

/** 增量体检测试的起点时刻（体检开始时间、记录的检查时刻都从这里推）。 */
export const CHECKUP_NOW = 1_800_000_000_000
export const DAY_MS = 86_400_000

/** 模型桩报的一条发现：涉及的记忆都在这一批里才报。 */
export interface StubFinding {
  type: 'conflict' | 'redundancy' | 'misplaced' | 'unclear'
  ids: readonly string[]
  summary?: string
  baselineRef?: string
}

/**
 * 模型桩：照提示词里的 `id=` 认出这一批的记忆，报 findings 里成员都在这批里的发现；summary 缺省带上模型名（输出依赖上下文）。
 * calls 记下每次调用发出的记忆 id（重试也算一次）；fail 返回非 undefined 时这次调用抛错（Error）或回一段解析不了的文字（'unparseable'）。
 */
export interface StubModel extends SemanticLlm {
  calls: string[][]
  /** 跨项目比较的调用次数。 */
  crossCalls: number
  findings: StubFinding[]
  crossReply: string
  fail: ((ids: readonly string[], call: number) => Error | 'unparseable' | undefined) | undefined
}

export function stubModel(init: { model?: string; provider?: string; findings?: StubFinding[] } = {}): StubModel {
  const m: StubModel = {
    provider: init.provider ?? 'stub',
    model: init.model ?? 'model-a',
    calls: [],
    crossCalls: 0,
    findings: init.findings ?? [],
    crossReply: '{"duplicates":[]}',
    fail: undefined,
    complete: async (input) => {
      if (input.system.includes('多个项目（workspace）')) {
        m.crossCalls++
        return m.crossReply
      }
      const ids = [...input.user.matchAll(/^- id=(\S+)/gm)].map(x => x[1]!)
      m.calls.push(ids)
      const failure = m.fail?.(ids, m.calls.length)
      if (failure instanceof Error) throw failure
      if (failure === 'unparseable') return '不是 JSON'
      const present = new Set(ids)
      return JSON.stringify({
        findings: m.findings.filter(f => f.ids.every(id => present.has(id))).map(f => ({
          type: f.type, memoryIds: f.ids, summary: f.summary ?? `${m.model} 查出的问题`, suggestedAction: '处理',
          ...(f.baselineRef !== undefined ? { baselineRef: f.baselineRef } : {}),
        })),
      })
    },
  }
  return m
}

/** 一条很长的记忆：两条同类型的长记忆装不进一批，分成两批。 */
export function bigRecord(partial: Partial<MemoryRecord> & { id: string }): MemoryRecord {
  return record({ name: partial.id, content: `${partial.id}：${'记'.repeat(27_000)}`, ...partial })
}

export interface CheckupEnv {
  root: string
  /** 记忆根（真实目录）。 */
  memoryRoot: string
  /** 待决账本的表（直接放条目用）。 */
  pending: InMemoryKvTable<PendingDecision>
  clock: { now: number }
  store: MemoryStore
  decisions: PendingDecisionsStore
  views: InMemoryKvTable<ScanCacheEntry>
  checkups: CheckupRecordStore
  db: CheckupCache
  logs: string[]
  /** 整次的 token 上限（配置现读）。 */
  tokenCap: { value: unknown }
  deps: ScanCoreDeps
  scan(input: Partial<ScanInput> & { llm: SemanticLlm | null }, opts?: { by?: CheckupInitiator }): Promise<ScanToolResult>
  view(scope: Scope): Promise<ScanCacheEntry | undefined>
  /** 再开一个库连接（另一个进程那样）。 */
  openDb(): CheckupCache
  close(): Promise<void>
}

/** 增量体检的测试环境：记忆是临时目录里真的文件，侧表在内存里，体检结果库是临时目录里真的 SQLite。 */
export async function checkupEnv(opts: { instructions?: ReadInstructions; tokenCap?: unknown; root?: string } = {}): Promise<CheckupEnv> {
  const root = opts.root ?? await mkdtemp(join(tmpdir(), 'pm-checkup-'))
  const logs: string[] = []
  const log = { info: () => {}, warn: (...args: unknown[]) => { logs.push(args.map(String).join(' ')) }, error: (...args: unknown[]) => { logs.push(args.map(String).join(' ')) } }
  const clock = { now: CHECKUP_NOW }
  const tokenCap = { value: opts.tokenCap }
  const path = join(root, CHECKUP_CACHE_FILE)
  const db = new CheckupCache({ path, log })
  const memoryRoot = join(root, 'memory')
  await mkdir(memoryRoot, { recursive: true })
  const store = new MemoryStore(new FileTable({ root: memoryRoot, stats: new InMemoryKvTable<RecallStats>() }), undefined, new InMemoryBatchKvTable())
  const pending = new InMemoryKvTable<PendingDecision>()
  const decisions = new PendingDecisionsStore(pending)
  const views = new InMemoryKvTable<ScanCacheEntry>()
  const checkups = new CheckupRecordStore(new InMemoryKvTable<CheckupRecord>())
  const deps: ScanCoreDeps = {
    store, decisions, cache: views, checkups, checkupCache: db, log,
    registry: buildTypeRegistry({ template: 'coding', customTypes: {} }),
    instructions: opts.instructions ?? noInstructions,
    tokenCap: () => tokenCap.value,
    now: () => clock.now,
  }
  const opened: CheckupCache[] = [db]
  return {
    root, memoryRoot, pending, clock, store, decisions, views, checkups, db, logs, tokenCap, deps,
    scan: (input, o = {}) => runScan({ target: { kind: 'scope', scope: { kind: 'global' } }, layers: 'full', startedAt: clock.now, ...input }, deps, { by: o.by ?? 'manual' }),
    view: scope => views.get(scopeCacheKey(scope)),
    openDb: () => {
      const other = new CheckupCache({ path, log })
      opened.push(other)
      return other
    },
    close: async () => {
      for (const d of opened) d.close()
      if (opts.root === undefined) await rm(root, { recursive: true, force: true })
    },
  }
}

/** 视图里发现的可比形状：类型和涉及的记忆。 */
export function findingKeys(entry: Pick<ScanCacheEntry, 'findings'> | undefined): string[] {
  return (entry?.findings ?? []).map(f => `${f.type}:${[...f.memoryIds].sort().join('+')}`).sort()
}
