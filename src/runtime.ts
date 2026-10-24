import { realpath } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import type { MemoryLogger, MemoryStore } from './store.ts'
import type { MemoryRecord } from './record-schema.ts'
import { resolveDuplicates } from './storage/table.ts'
import type { TypeRegistry } from './type-registry.ts'
import type { EvidenceLookupLevel } from './evidence-guidance.ts'
import { assembleSnapshot, escapePromptBraces, overflowLevel, type OverflowMode, type SnapshotUsage } from './snapshot.ts'
import type { OverflowLevel } from './contract-codes.ts'
import type { SessionView } from './gui/contract.ts'

/**
 * 快照的预读：global + 当前 workspace 顶层的 active 记录（同 id 按取舍规则留一份，口径同 queryScope 的默认查询），
 * 外加 id → 文件路径（相对记忆根目录：`<目录名>/<文件名>`），索引行末尾用它。走 readLayer 是为了拿到文件路径——
 * queryScope 只回记录。同一次读取的隔离文件数给冷启动文案用。
 */
export async function prereadSnapshot(store: MemoryStore, workspacePath: string | undefined): Promise<{
  records: MemoryRecord[]; files: Map<string, string>; quarantinedCount: number
}> {
  const read = await store.readLayer({ kind: 'visible', workspacePath })
  const located = resolveDuplicates(read.records, { workspacePath }).filter(l => l.record.status === 'active')
  return {
    records: located.map(l => l.record),
    files: new Map(located.map(l => [l.record.id, `${basename(l.dir)}/${basename(l.filePath)}`])),
    quarantinedCount: read.quarantined.length,
  }
}

/**
 * session 内冻结的 snapshot 缓存，按 session 隔离（WeakMap）。
 * 构建只发生在 assemble（system-prompt/assemble 中间件调用，异步）：等 workspace 解析落定或超时 →
 * 缓存缺失或已过期则预读可见记录、组装、冻结 → 首次冻结计一次召回 → 维护点（global + 当前 workspace）。同步的 render（context provider）
 * 只回缓存，没有缓存回空串；冷启动文案由组装在可见集合为空时产出，provider 不兜底。
 * compaction 结束只标过期（markStale）不清空：宿主只调同步 provider 的 admission refresh 拿到上一份快照。
 * workspacePath 走 pull + memoize：render 发现某 session 未解析时触发一次 fire-and-forget 解析
 * （同 session 去重），HMR 后存量 session 也能自愈；session/created 只做 eager 预热（prewarm）。
 * 已知窗口：HMR 后存量 session 缓存为空，首次 provider 回空串，首次中间件补上。
 * 缓存存原文；render 与 assemble 在出口统一转义 `{{`，每条路径都只转义一次。
 */
/** 超限提醒的账本（PendingDecisionsStore 满足它）：按项目同步当前档位，返回账本是否有变化。 */
export interface OverflowLedger {
  syncOverflow(scope: string, level: OverflowLevel | undefined, now: number, summary: string): Promise<boolean>
}

/** 快照冻结时交给 onFrozen 的信息：会话视图除 sessionId、savedIds 外的全部字段，外加超限账本这次有没有变（变了要重写待处理 / 健康视图）。 */
export type FrozenSnapshotInfo = Omit<SessionView, 'version' | 'sessionId' | 'savedIds'> & { overflowChanged: boolean }

/** 写进账本的超限说明（给 agent 和日志看；界面文案由客户端按结构渲染）。 */
function overflowSummary(level: OverflowLevel, usage: SnapshotUsage, budget: number): string {
  return level.mode === 'relax'
    ? `带入记忆约 ${usage.usedTokens} token，超出上限 ${budget}，已自动放宽到 ${Math.round(budget * (1 + 0.25 * level.tier))}`
    : `带入记忆约 ${usage.usedTokens} token，已用到上限 ${budget} 的 95%${usage.omittedCount > 0 ? `，${usage.omittedCount} 条没带入` : ''}`
}

export interface SnapshotCacheDeps {
  store: MemoryStore
  registry: TypeRegistry
  budget: number
  memoryRoot?: string
  evidenceLookup?: EvidenceLookupLevel
  /** 超出上限的处理，缺省 relax（与配置默认一致）。 */
  overflow?: OverflowMode
  /** 给出时，每次冻结按会话所属项目（无项目为 'global'）同步超限提醒。 */
  overflowLedger?: OverflowLedger
  /** 冻结之后调用（会话视图的写入口，接线在 index.ts）。失败只记日志。 */
  onFrozen?: (session: object, info: FrozenSnapshotInfo) => void | Promise<void>
  resolveWorkspace?: (session: object) => Promise<string | undefined>
  /** 日志注入口，缺省回退 console（见 store.ts MemoryLogger）。 */
  log?: MemoryLogger
}

export class SnapshotCache {
  /** 冻结快照与冻结时的代次；代次落后于 generations 即为过期（仍可被 provider 读到）。 */
  private cache = new WeakMap<object, { text: string; generation: number }>()
  /** 每次 markStale 加一（缺省 0）。构建开始时记下代次，写缓存前核对：中途被标过期的构建结果不进缓存。 */
  private generations = new WeakMap<object, number>()
  /** 全体代次：每次 markAllStale 加一，计入每个会话的代次。 */
  private epoch = 0
  /** 值为 undefined 表示"已解析、无工作目录"（无 cwd 或目录已不存在）；键不存在表示"还没解析完" */
  private workspacePaths = new WeakMap<object, string | undefined>()
  /** 已计过召回的 session。语义是"每会话计一次"：markStale 不清它，同一 session 多次
   * 压缩重建不重复计数，否则 recallCount 会从"被多少会话用过"膨胀成"组装过多少次"。
   * 代价：压缩后重建时新进 core 的记忆不补计召回——可接受。 */
  private recalled = new WeakSet<object>()
  /** 在途 lazy 解析（按 session memoize 的 Promise）：防同一 session 重发解析，且可被 awaitResolved 等待。 */
  private resolving = new WeakMap<object, Promise<void>>()

  private deps: SnapshotCacheDeps

  constructor(deps: SnapshotCacheDeps) {
    this.deps = deps
  }

  setWorkspacePath(session: object, path: string | undefined): void {
    this.workspacePaths.set(session, path)
  }

  /** 未解析 session 的自愈：触发一次异步解析并落缓存（同 session 去重、可等待）。
   *  纯测试场景（未注入 resolveWorkspace）时不做事，维持"等 setWorkspacePath 显式喂"的现行为。 */
  private ensureResolving(session: object): Promise<void> | undefined {
    const resolve = this.deps.resolveWorkspace
    if (!resolve || this.workspacePaths.has(session)) return undefined
    let pending = this.resolving.get(session)
    if (!pending) {
      pending = resolve(session)
        .then(path => this.setWorkspacePath(session, path))
        .catch(() => this.setWorkspacePath(session, undefined))
        .finally(() => this.resolving.delete(session))
      this.resolving.set(session, pending)
    }
    return pending
  }

  /** session/created 的 eager 预热：只触发 workspace 解析（与 awaitResolved 共用同一份 memoize），
   *  不组装——快照仍在首次中间件组装时冻结。 */
  prewarm(session: object): void {
    this.ensureResolving(session)
  }

  /** 只等 workspace 解析落定或超时，不组装。 */
  async awaitResolved(session: object, timeoutMs = 1500): Promise<void> {
    const pending = this.ensureResolving(session)
    if (!pending) return
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([pending, new Promise<void>(r => { timer = setTimeout(r, timeoutMs) })])
    clearTimeout(timer)
  }

  /** assemble 中间件的入口，返回本次要写进 context 的（已转义）文本。
   *  解析落定：缓存存在且未过期直接用；否则读盘组装、冻结、每会话首次冻结计召回。
   *  解析超时（或未注入 resolver 且未显式喂）：global-only 临时文本，只给本次用，不冻结、不计召回。
   *  组装失败只记日志，回落到 render（旧快照或空串），不拖垮宿主组装。 */
  async assemble(session: object, timeoutMs = 1500): Promise<string> {
    await this.awaitResolved(session, timeoutMs)
    try {
      return escapePromptBraces(await this.build(session))
    } catch (err) {
      ;(this.deps.log ?? console).error('[plastic-memory] 快照组装失败:', err)
      return this.render(session)
    }
  }

  /** 会话的当前代次：本会话的 markStale 次数加全体的 markAllStale 次数。 */
  private generationOf(session: object): number {
    return (this.generations.get(session) ?? 0) + this.epoch
  }

  private async build(session: object): Promise<string> {
    const generation = this.generationOf(session)
    const cached = this.cache.get(session)
    if (cached && cached.generation === generation) return cached.text
    const isResolved = this.workspacePaths.has(session)
    const workspacePath = isResolved ? this.workspacePaths.get(session) : undefined
    // 上限、超限处理、溯源档位可能是用时读配置的 getter：一次构建只取一次值，组装与冻结后的超限同步用同一份
    const deps = { ...this.deps }
    // 预读范围：只读 active，global + 当前 workspace（未解析时 global-only）；同一次读取的隔离文件数给冷启动文案用
    const now = Date.now()
    const { text, coreIds, ...usage } = assembleSnapshot({ ...deps, ...(await prereadSnapshot(deps.store, workspacePath)), workspacePath, now })
    if (!isResolved) return text
    // 构建期间被标过期：这份文本只给本次用，不进缓存、不计召回，下一次中间件按新代次重建
    if (this.generationOf(session) !== generation) return text
    // 同代次的并发构建：先落定的那份为准，保证冻结内容一致
    const landed = this.cache.get(session)
    if (landed && landed.generation === generation) return landed.text
    this.cache.set(session, { text, generation })
    if (!this.recalled.has(session)) {
      this.recalled.add(session)
      await this.deps.store.markRecalled(coreIds)
    }
    // 快照冻结是维护点之一（设计稿 §5 §6）：对 global + 当前 workspace 做维护；失败只记日志，不拖垮注入
    try {
      await this.deps.store.maintain({ kind: 'visible', workspacePath })
    } catch (err) {
      ;(this.deps.log ?? console).error('[plastic-memory] 记忆目录维护失败:', err)
    }
    await this.afterFreeze(deps, session, workspacePath, now, usage)
    return text
  }

  /** 冻结之后：同步超限提醒、交出会话视图的原料。都是旁路，失败只记日志。 */
  private async afterFreeze(deps: SnapshotCacheDeps, session: object, workspacePath: string | undefined, now: number, usage: SnapshotUsage): Promise<void> {
    const { budget, overflowLedger, onFrozen } = deps
    const mode = deps.overflow ?? 'relax'
    let overflowChanged = false
    try {
      if (overflowLedger) {
        const level = overflowLevel(mode, usage.usedTokens, budget)
        overflowChanged = await overflowLedger.syncOverflow(workspacePath ?? 'global', level, now, level ? overflowSummary(level, usage, budget) : '')
      }
      await onFrozen?.(session, {
        ...(workspacePath !== undefined ? { workspacePath } : {}),
        frozenAt: now, budget, overflowMode: mode, ...usage, overflowChanged,
      })
    } catch (err) {
      ;(this.deps.log ?? console).error('[plastic-memory] 快照冻结后的超限同步或会话视图失败:', err)
    }
  }

  /** 同步 provider 的出口：只回冻结缓存（过期的也回），没有缓存回空串。未解析的 session
   *  顺手触发一次自愈解析（HMR 后存量 session 首次 provider 即开始解析），组装留给下一次中间件。 */
  render(session: object): string {
    const cached = this.cache.get(session)
    if (cached !== undefined) return escapePromptBraces(cached.text)
    if (!this.workspacePaths.has(session)) this.ensureResolving(session)
    return ''
  }

  /** compaction 结束：标记过期，不清空缓存（provider 继续回旧快照），也不清召回记录。 */
  markStale(session: object): void {
    this.generations.set(session, (this.generations.get(session) ?? 0) + 1)
  }

  /** 配置热更新：所有会话一起标过期（会话按 WeakMap 存、无法枚举，改为抬全体代次），语义同 markStale。 */
  markAllStale(): void {
    this.epoch++
  }
}

/**
 * 从 cwd 解析记忆归属目录，三级：
 * 1) cwd（realpath 规范化后）精确命中注册 workspace，归属该 workspace；
 * 2) 逐级向上探测祖先目录——registry.resolveByPath 只做精确规范路径匹配、不解析子树，
 *    没有这步，在项目子目录里开的会话会解析不到所属 workspace；
 * 3) 都不中则用规范化后的 cwd 本身当目录桶。dsh 的 Ungrouped 会话（cwd 不属任何注册
 *    workspace）是一等状态，没注册不等于没有项目边界——落 global 会跨项目污染，还会让
 *    global 直写闸（依赖 workspacePath 存在才降级为候选）随之蒸发。将来该目录注册成
 *    workspace，realpath 一致，桶自动接上。
 * 返回 undefined 仅当 cwd 缺失或目录已不存在（此时 memory_save 拒存，见 pipeline）。
 */
export async function resolveWorkspacePath(
  ctx: { get(name: string): unknown },
  cwd: string | undefined,
): Promise<string | undefined> {
  if (!cwd) return undefined
  let canonical: string
  try {
    canonical = await realpath(cwd)
  } catch {
    return undefined
  }
  const registry = ctx.get('workspaceRegistry') as
    | { resolveByPath(path: string): Promise<{ path: string } | undefined> }
    | undefined
  if (registry) {
    for (let dir = canonical; ; dir = dirname(dir)) {
      const workspace = await registry.resolveByPath(dir).catch(() => undefined)
      if (workspace) return workspace.path
      if (dirname(dir) === dir) break
    }
  }
  return canonical
}
