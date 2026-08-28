import type { MemoryStore } from './store.ts'
import type { TypeRegistry } from './type-registry.ts'
import type { EvidenceLookupLevel } from './evidence-guidance.ts'
import { assembleSnapshot } from './snapshot.ts'

/**
 * session 内冻结的 snapshot 缓存，按 session 隔离（WeakMap），compaction 结束后失效重建。
 * workspacePath 由 session/created 异步解析：解析未完成时 render 用 global-only 兜底组装，
 * 不写缓存、不计召回；下一个 step 解析已就绪，才组装完整版并冻结、计召回一次。
 */
export class SnapshotCache {
  private cache = new WeakMap<object, string>()
  /** 值为 undefined 表示"已解析、无 workspace"；键不存在表示"还没解析完" */
  private workspacePaths = new WeakMap<object, string | undefined>()

  constructor(private deps: { store: MemoryStore; registry: TypeRegistry; budget: number; memoryRoot?: string; evidenceLookup?: EvidenceLookupLevel }) {}

  setWorkspacePath(session: object, path: string | undefined): void {
    this.workspacePaths.set(session, path)
  }

  render(session: object): string {
    const cached = this.cache.get(session)
    if (cached !== undefined) return cached

    if (!this.workspacePaths.has(session)) {
      // workspace 解析未完成：global-only 兜底，不冻结、不计召回
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
    this.deps.store.markRecalled(coreIds)
    return text
  }

  invalidate(session: object): void {
    this.cache.delete(session)
  }
}

/** 从 cwd 解析所属 workspace 路径；workspace 插件缺席或解析失败时静默返回 undefined。 */
export async function resolveWorkspacePath(
  ctx: { get(name: string): unknown },
  cwd: string | undefined,
): Promise<string | undefined> {
  if (!cwd) return undefined
  const registry = ctx.get('workspaceRegistry') as
    | { resolveByPath(path: string): Promise<{ path: string } | undefined> }
    | undefined
  if (!registry) return undefined
  const workspace = await registry.resolveByPath(cwd).catch(() => undefined)
  return workspace?.path
}
