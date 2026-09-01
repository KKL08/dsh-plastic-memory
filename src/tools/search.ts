import type { MemoryStore } from '../store.ts'
import { expandQueryTerms, matchScore } from '../text.ts'
import type { TypeRegistry } from '../type-registry.ts'
import { sourceNote } from '../index-line.ts'
import { stalenessNote, withinValidity } from '../record-freshness.ts'

/** memory_search 运行时需要的会话上下文，由框架绑定层的 resolveContext 提供。 */
export interface SearchContext {
  workspacePath: string | undefined
  session: { id: string; lastSeq: number }
}

/** memory_search 工具的依赖，纯逻辑层与框架绑定层共用。 */
export interface SearchToolDeps {
  store: MemoryStore
  registry: TypeRegistry
  resolveContext(exec: unknown): Promise<SearchContext>
}

export interface SearchArgs {
  query: string
  types?: string[]
  scope?: 'global' | 'workspace' | 'all-visible'
  limit?: number
}

export interface SearchHit {
  id: string
  type: string
  summary: string
  content: string
  sourceNote: string
  stalenessNote: string
}

/** 把命中结果渲染成给模型看的一段文本。纯函数。 */
export function renderSearchResult(result: { hits: SearchHit[]; note?: string }): string {
  if (result.note !== undefined) return result.note
  if (result.hits.length === 0) return '没有匹配的记忆。'
  return result.hits.map(h => `[${h.id}] ${h.type}｜${h.summary}${h.sourceNote}${h.stalenessNote}\n${h.content}`).join('\n\n')
}

/**
 * memory_search 工具的真正执行逻辑：解析上下文、组 scope 过滤、查询、排序截断、标记召回。
 * 不依赖任何 dsh 框架包，测试直接调它。
 */
export async function executeSearch(
  args: SearchArgs,
  exec: unknown,
  deps: SearchToolDeps,
): Promise<{ hits: SearchHit[]; note?: string }> {
  const a = args
  const { workspacePath } = await deps.resolveContext(exec)
  // 明确要"只看本项目"而当前会话没有工作目录：显式说明而非静默落回 global-only——
  // 用户要项目范围时给他全局结果是误导
  if (a.scope === 'workspace' && workspacePath === undefined) {
    return { hits: [], note: '当前会话没有工作目录，无法限定项目范围；查全局记忆请用 scope: "global"。' }
  }
  const limit = Math.min(a.limit ?? 10, 50)
  const scopeFilter = a.scope === 'global'
    ? { kind: 'global' as const }
    : a.scope === 'workspace' && workspacePath
      ? { kind: 'workspace' as const, path: workspacePath }
      : { kind: 'visible' as const, workspacePath }
  // OR 匹配后按（命中词数 ↓ → confidence ↓ → recallCount ↓）排序：命中更多查询词者更相关。
  const terms = expandQueryTerms(a.query)
  const now = Date.now()
  const hits = deps.store
    .query({ keyword: a.query, types: a.types, scope: scopeFilter })
    .filter(r => withinValidity(r, now)) // validTo 已过期的不进检索，与注入口径一致（治理扫描仍可见）
    .map(r => ({ r, score: matchScore(r, terms) }))
    .sort((x, y) => y.score - x.score || y.r.confidence - x.r.confidence || y.r.recallCount - x.r.recallCount)
    .slice(0, limit)
    .map(e => e.r)
  deps.store.markRecalled(hits.map(h => h.id))
  return {
    hits: hits.map(h => ({
      id: h.id, type: h.type, summary: h.summary, content: h.content,
      sourceNote: sourceNote(h),
      stalenessNote: stalenessNote(h, deps.registry.get(h.type).decayDays, now),
    })),
  }
}
