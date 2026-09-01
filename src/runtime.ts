import { realpath } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { MemoryStore } from './store.ts'
import type { TypeRegistry } from './type-registry.ts'
import type { EvidenceLookupLevel } from './evidence-guidance.ts'
import { assembleSnapshot } from './snapshot.ts'

/**
 * session 内冻结的 snapshot 缓存，按 session 隔离（WeakMap），compaction 结束后失效重建。
 * workspacePath 走 pull + memoize：render 发现某 session 未解析时，除返回 global-only 兜底外，
 * 触发一次 fire-and-forget 解析（同 session 去重），落定后下一次 render 组装完整版并冻结、计召回一次。
 * session/created 只是 eager 预热；靠它单点灌缓存会在插件热重载（HMR）后对存量 session 永久退化——
 * 旧注册清理后 WeakMap 全空、宿主又不为存量 session 重发 session/created，render 会一直走兜底。
 */
export interface SnapshotCacheDeps {
  store: MemoryStore
  registry: TypeRegistry
  budget: number
  memoryRoot?: string
  evidenceLookup?: EvidenceLookupLevel
  resolveWorkspace?: (session: object) => Promise<string | undefined>
}

export class SnapshotCache {
  private cache = new WeakMap<object, string>()
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

  /** 首轮组装前显式等待 workspace 解析（system-prompt/assemble 中间件调用）。
   *  已解析或未注入 resolver 立即返回；超时按未解析放行——render 侧 global-only
   *  兜底照旧，降级语义与旧行为一致，只是不再赌「解析总赶在首轮组装前」的宿主时序。 */
  async awaitResolved(session: object, timeoutMs = 1500): Promise<void> {
    const pending = this.ensureResolving(session)
    if (!pending) return
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([pending, new Promise<void>(r => { timer = setTimeout(r, timeoutMs) })])
    clearTimeout(timer)
  }

  render(session: object): string {
    const cached = this.cache.get(session)
    if (cached !== undefined) return cached

    if (!this.workspacePaths.has(session)) {
      // workspace 解析未完成：触发一次自愈解析（HMR 后存量 session 首次 render 即重建），
      // 本次仍走 global-only 兜底，不冻结、不计召回
      this.ensureResolving(session)
      const { text } = assembleSnapshot({
        ...this.deps,
        workspacePath: undefined,
        now: Date.now(),
      })
      return text
    }

    const { text, coreIds } = assembleSnapshot({
      ...this.deps,
      workspacePath: this.workspacePaths.get(session),
      now: Date.now(),
    })
    this.cache.set(session, text)
    if (!this.recalled.has(session)) {
      this.recalled.add(session)
      this.deps.store.markRecalled(coreIds)
    }
    return text
  }

  invalidate(session: object): void {
    this.cache.delete(session)
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
