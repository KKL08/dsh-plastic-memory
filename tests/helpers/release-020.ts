import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { MemoryRecord } from '../../src/record-schema.ts'
import type { Scope } from '../../src/scope.ts'

/**
 * 已发布的 0.2.0 包（开发依赖里的别名），在同一个记忆根上扮演旧版本，逐行对照新旧版本共用的兼容表。
 * 只按文件路径加载它编译好的存储层：入口要有宿主在跑才加载得起来。
 */
const require = createRequire(import.meta.url)
const releaseDir = dirname(require.resolve('dsh-plastic-memory-0.2.0/package.json'))

export interface Release020Table {
  create(record: MemoryRecord): Promise<void>
  update(id: string, from: Scope, fn: (current: MemoryRecord) => MemoryRecord): Promise<MemoryRecord>
  /** 整条替换：0.2.0 的 memory_save 改写走这条，记录由调用方给全（它读出来的记录不带新键） */
  put(value: MemoryRecord, from: Scope | undefined): Promise<unknown>
  locate(id: string, target: Scope): Promise<{ record: MemoryRecord } | undefined>
  /** 物理删除（0.2.0 的彻底删除、密钥硬删走这条）。 */
  delete(id: string, at: Scope): Promise<boolean>
}

const quiet = { info() {}, warn() {}, error() {}, debug() {} }

export async function openRelease020Table(opts: { root: string; stats: unknown }): Promise<Release020Table> {
  const url = pathToFileURL(join(releaseDir, 'lib', 'storage', 'file-table.js')).href
  const mod = await import(url) as { FileTable: new (options: object) => Release020Table }
  return new mod.FileTable({ ...opts, log: quiet })
}

/** 0.2.0 的待决账本表（它自己的侧表实现和条目 schema）：list 读出它认得的条目，解析不了的跳过并记日志。 */
export interface Release020Pending { list(): Promise<Array<[string, { id: string }]>> }

export async function openRelease020Pending(opts: { root: string; warnings: string[] }): Promise<Release020Pending> {
  const load = async <T>(...path: string[]) => await import(pathToFileURL(join(releaseDir, 'lib', ...path)).href) as T
  const sidecar = await load<{ SidecarStore: new (options: object) => { pending: Release020Pending } }>('storage', 'sidecar.js')
  const schema = await load<Record<string, unknown>>('governance', 'schema.js')
  const log = { ...quiet, warn: (message: string) => { opts.warnings.push(message) } }
  return new sidecar.SidecarStore({
    root: opts.root, log,
    schemas: { snapshots: schema.memorySnapshotSchema, pending: schema.pendingDecisionSchema, scanCache: schema.scanCacheSchema, adviceIgnores: schema.adviceIgnoreSchema },
  }).pending
}

/** 0.2.0 的插件配置 schema：从它的入口模块取，构造出来就是宿主按它加载配置时拿到的值。 */
export async function openRelease020Config(): Promise<new (raw: unknown) => { search: Record<string, unknown> }> {
  const mod = await import(pathToFileURL(join(releaseDir, 'lib', 'index.js')).href) as { Config: new (raw: unknown) => { search: Record<string, unknown> } }
  return mod.Config
}

/** 0.2.0 读侧表条目用的 schema（体检记录、语义缓存、待决条目）：新版写的东西拿它解析，看旧版能不能照读。 */
export interface Release020Schemas {
  checkupRecord: { safeParse(value: unknown): { success: boolean; data?: unknown } }
  scanCache: { safeParse(value: unknown): { success: boolean; data?: unknown } }
  pendingDecision: { safeParse(value: unknown): { success: boolean; data?: unknown } }
}

export async function loadRelease020Schemas(): Promise<Release020Schemas> {
  const load = async (...path: string[]) => await import(pathToFileURL(join(releaseDir, 'lib', ...path)).href) as Record<string, Release020Schemas['checkupRecord']>
  const storage = await load('storage', 'schema.js')
  const governance = await load('governance', 'schema.js')
  return { checkupRecord: storage.checkupRecordSchema!, scanCache: governance.scanCacheSchema!, pendingDecision: governance.pendingDecisionSchema! }
}
