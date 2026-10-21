import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { MemoryStore, KeywordMatch } from '../store.ts'
import type { SearchNoteCode } from '../contract-codes.ts'
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
  resolveContext(exec: ToolRunContext): Promise<SearchContext>
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

/** OR 回退的说明文案（noteCode 'or-fallback'）。 */
export const OR_FALLBACK_NOTE = '没有同时命中全部关键词的记忆，以下是命中任一关键词的结果，按命中词数排序。'

/** 把命中结果渲染成给模型看的一段文本：有说明先写说明，再列命中。纯函数。 */
export function renderSearchResult(result: { hits: SearchHit[]; note?: string }): string {
  const blocks = result.hits.map(h => `[${h.id}] ${h.type}｜${h.summary}${h.sourceNote}${h.stalenessNote}\n${h.content}`)
  if (result.note !== undefined) blocks.unshift(result.note)
  return blocks.length === 0 ? '没有匹配的记忆。' : blocks.join('\n\n')
}

/**
 * memory_search 工具的真正执行逻辑：解析上下文、组 scope 过滤、查询、排序截断、标记召回。
 * 不依赖任何 dsh 框架包，测试直接调它。
 */
export async function executeSearch(
  args: SearchArgs,
  exec: ToolRunContext,
  deps: SearchToolDeps,
): Promise<{ hits: SearchHit[]; note?: string; noteCode?: SearchNoteCode }> {
  const a = args
  const { workspacePath } = await deps.resolveContext(exec)
  // 明确要"只看本项目"而当前会话没有工作目录：显式说明而非静默落回 global-only——
  // 用户要项目范围时给他全局结果是误导
  if (a.scope === 'workspace' && workspacePath === undefined) {
    return { hits: [], noteCode: 'no-workspace', note: '当前会话没有工作目录，无法限定项目范围；查全局记忆请用 scope: "global"。' }
  }
  const limit = Math.min(a.limit ?? 10, 50)
  const scopeFilter = a.scope === 'global'
    ? { kind: 'global' as const }
    : a.scope === 'workspace' && workspacePath
      ? { kind: 'workspace' as const, path: workspacePath }
      : { kind: 'visible' as const, workspacePath }
  const terms = expandQueryTerms(a.query)
  const now = Date.now()
  // 预读范围：只读 active（store.query 缺省 status），按 scope 与关键词过滤；
  // validTo 已过期的不进检索，与注入口径一致（治理扫描仍可见）
  const find = async (keywordMatch: KeywordMatch) =>
    (await deps.store.query({ keyword: a.query, keywordMatch, types: a.types, scope: scopeFilter })).filter(r => withinValidity(r, now))
  // 先 AND（全部词项命中）；零命中且不止一个词项时回退 OR（任一命中），并说明走了回退
  let found = await find('all')
  let fallback = false
  if (found.length === 0 && terms.length > 1) {
    found = await find('any')
    fallback = found.length > 0
  }
  // 命中词数 ↓ → confidence ↓ → lastConfirmedAt ↓；召回计数不参与
  const hits = found
    .map(r => ({ r, score: matchScore(r, terms) }))
    .sort((x, y) => y.score - x.score || y.r.confidence - x.r.confidence || y.r.lastConfirmedAt - x.r.lastConfirmedAt)
    .slice(0, limit)
    .map(e => e.r)
  await deps.store.markRecalled(hits.map(h => h.id))
  return {
    ...(fallback ? { noteCode: 'or-fallback' as const, note: OR_FALLBACK_NOTE } : {}),
    hits: hits.map(h => ({
      id: h.id, type: h.type, summary: h.summary, content: h.content,
      sourceNote: sourceNote(h),
      stalenessNote: stalenessNote(h, deps.registry.get(h.type).decayDays, now),
    })),
  }
}
