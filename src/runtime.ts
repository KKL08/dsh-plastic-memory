import { realpath } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { MemoryLogger, MemoryStore } from './store.ts'
import type { TypeRegistry } from './type-registry.ts'
import type { EvidenceLookupLevel } from './evidence-guidance.ts'
import { assembleSnapshot, escapePromptBraces, COLD_START_TEXT } from './snapshot.ts'

/**
 * session 内冻结的 snapshot 缓存，按 session 隔离（WeakMap），compaction 结束后失效重建。
 * 存储读取是异步的，组装只发生在 awaitResolved（assemble 中间件每次组装前调用）：等 workspace
 * 解析落定或超时，再预读可见记录、组装快照写入缓存；同步的 render 只回缓存或冷槽。
 * workspacePath 走 pull + memoize：render 发现某 session 未解析时触发一次 fire-and-forget 解析
 * （同 session 去重），HMR 后存量 session 也能自愈；session/created 只做 eager 预热（prewarm）。
 * 缓存存原文；render 在出口统一转义 `{{`，冷启动、冷槽、命中三条路径都只转义一次。
 */
export interface SnapshotCacheDeps {
  store: MemoryStore
  registry: TypeRegistry
  budget: number
  memoryRoot?: string
  evidenceLookup?: EvidenceLookupLevel
  resolveWorkspace?: (session: object) => Promise<string | undefined>
  /** 日志注入口，缺省回退 console（见 store.ts MemoryLogger）。 */
  log?: MemoryLogger
}

export class SnapshotCache {
  private cache = new WeakMap<object, string>()
  /** 冷槽：workspace 未解析（超时或未注入 resolver）时的 global-only 文本。不冻结、不计召回，
   *  每次 awaitResolved 重新组装；解析落定、冻结后让位给 cache。 */
  private cold = new WeakMap<object, string>()
  /** 值为 undefined 表示"已解析、无工作目录"（无 cwd 或目录已不存在）；键不存在表示"还没解析完" */
  private workspacePaths = new WeakMap<object, string | undefined>()
  /** 已计过召回的 session。语义是"每会话计一次"：invalidate 不清它，同一 session 多次
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
   *  不组装——快照仍在首次组装时冻结。 */
  prewarm(session: object): void {
    this.ensureResolving(session)
  }

  /** 每次组装前调用（system-prompt/assemble 中间件）：等 workspace 解析落定或超时，再异步预读并组装。
   *  已冻结的不重组。解析落定 → 组装完整版冻结、每会话首次计召回；超时（或未注入 resolver 且未显式喂）
   *  → global-only 文本进冷槽，不冻结、不计召回，降级语义与旧行为一致。组装失败只记日志，
   *  render 回落到冷槽或冷启动文案，不拖垮宿主组装。 */
  async awaitResolved(session: object, timeoutMs = 1500): Promise<void> {
    const pending = this.ensureResolving(session)
    if (pending) {
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([pending, new Promise<void>(r => { timer = setTimeout(r, timeoutMs) })])
      clearTimeout(timer)
    }
    try {
      await this.build(session)
    } catch (err) {
      ;(this.deps.log ?? console).error('[plastic-memory] 快照组装失败:', err)
    }
  }

  private async build(session: object): Promise<void> {
    if (this.cache.has(session)) return
    const isResolved = this.workspacePaths.has(session)
    const workspacePath = isResolved ? this.workspacePaths.get(session) : undefined
    // 预读范围：只读 active，global + 当前 workspace（未解析时 global-only）
    const records = await this.deps.store.query({ scope: { kind: 'visible', workspacePath } })
    const { text, coreIds } = assembleSnapshot({ ...this.deps, records, workspacePath, now: Date.now() })
    if (!isResolved) {
      this.cold.set(session, text)
      return
    }
    if (this.cache.has(session)) return // 并发组装：先落定的那份为准
    this.cache.set(session, text)
    this.cold.delete(session)
    if (!this.recalled.has(session)) {
      this.recalled.add(session)
      await this.deps.store.markRecalled(coreIds)
    }
  }

  /** 快照进宿主的唯一出口：缓存与组装都是原文，每次在这里转义 `{{`（见 escapePromptBraces）。 */
  render(session: object): string {
    return escapePromptBraces(this.renderRaw(session))
  }

  /** 同步：只回冻结缓存或冷槽，两者都没有时回冷启动文案。未解析的 session 顺手触发一次自愈解析
   *  （HMR 后存量 session 首次 render 即开始解析），组装留给下一次 awaitResolved。 */
  private renderRaw(session: object): string {
    const cached = this.cache.get(session)
    if (cached !== undefined) return cached
    if (!this.workspacePaths.has(session)) this.ensureResolving(session)
    return this.cold.get(session) ?? COLD_START_TEXT
  }

  invalidate(session: object): void {
    this.cache.delete(session)
    this.cold.delete(session)
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
