/**
 * 九个记忆工具的折叠行摘要，和 `memory_save` 结果的解析（交付卡也用）。纯函数，不碰 React。
 *
 * 宿主只把工具结果渲染出的文本（`content`）记进会话日志，执行器的 JSON 值不落盘，所以「记住了哪条」
 * 「搜到几条」只能从 `src/tools/*` 的结果文本里读；那几句是服务端的中文定稿，改了要同步这里的正则。
 * 其余工具的摘要只看参数。
 */
import { maskSecretSurface, type MemoryCard } from '../../src/gui/contract.ts'
import { baseName } from '../path.ts'
import type { LocaleKey } from '../locales.ts'

export const MEMORY_TOOLS = [
  'memory_save', 'memory_search', 'memory_forget', 'memory_snapshot', 'memory_source',
  'memory_confirm', 'memory_scan', 'memory_health', 'memory_promote',
] as const
export type MemoryToolName = (typeof MEMORY_TOOLS)[number]

export interface Summary {
  key: LocaleKey
  params?: Record<string, string | number>
}

type Args = Record<string, unknown>

/** 参数 JSON → 对象；流式未完成或不是对象时 undefined。 */
export function parseArgs(argsRaw: string | null | undefined): Args | undefined {
  if (argsRaw === null || argsRaw === undefined || argsRaw === '') return undefined
  try {
    const value: unknown = JSON.parse(argsRaw)
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Args : undefined
  } catch {
    return undefined
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

export interface SavedResult {
  kind: 'saved' | 'updated'
  id: string
  type?: string
  scope?: 'global' | 'workspace'
}

/** `renderSaveResult` 的首行：「已保存记忆 <id>（<type>，<scope>）…」「已更新记忆 <id>。」；其余（疑似重复、拒绝）不算记住。 */
export function parseSaveResult(text: string): SavedResult | undefined {
  const saved = /^已保存记忆 ([^\s（]+)（([^，）]+)，(global|workspace)）/.exec(text)
  if (saved) return { kind: 'saved', id: saved[1]!, type: saved[2]!, scope: saved[3] as 'global' | 'workspace' }
  const updated = /^已更新记忆 ([^\s。]+)。/.exec(text)
  if (updated) return { kind: 'updated', id: updated[1]! }
  return undefined
}

/** `renderSearchResult`：每条命中一段，段首「[id] 类型｜摘要」。 */
export function countSearchHits(text: string): number {
  return text.split('\n\n').filter(block => /^\[[^\]\s]+\] [^\n]*｜/.test(block)).length
}

/** `memory_forget` 的「已遗忘 N 条记忆」；全部不存在时没有这句。 */
function forgottenCount(text: string): number {
  const m = /已遗忘 (\d+) 条/.exec(text)
  return m ? Number(m[1]) : 0
}

const SOURCE_MODES = ['user-explicit', 'user-behavior', 'environment-observed', 'agent-inferred', 'agent-action-confirmed'] as const

/**
 * 一次成功的新记（kind = saved）或改写（kind = updated）→ 记忆卡：id / 类型 / 作用域取结果，原文、名字、来源取参数。
 * 改写的结果只有 id：类型取参数，作用域也先取参数（改写不改作用域，参数可能填错），由交付卡按全部记忆视图校正。
 * 参数是 agent 发的原文，没经过视图的遮盖，这里遮掉密钥片段，疑似密钥也遮（带 force 存下的也不例外）。
 */
export function savedMemoryCard(args: Args | undefined, resultText: string, time: number): MemoryCard | undefined {
  const result = parseSaveResult(resultText)
  if (result === undefined || args === undefined) return undefined
  const sourceMode = SOURCE_MODES.find(mode => mode === args.sourceMode)
  return maskSecretSurface({
    id: result.id,
    name: str(args.name),
    type: result.type ?? str(args.type),
    scope: result.scope ?? (args.scope === 'global' ? 'global' : 'workspace'),
    summary: str(args.summary),
    content: str(args.content),
    tags: list(args.tags).filter((tag): tag is string => typeof tag === 'string'),
    ...(sourceMode === undefined ? {} : { sourceMode }),
    createdAt: time,
    updatedAt: time,
    lastConfirmedAt: time,
    filePath: '',
  }, { severity: 'suspected' })
}

function scopeSummary(args: Args): Summary {
  const scopes = list(args.scopes).filter(s => typeof s === 'string')
  if (scopes.length > 0) return { key: scopes.length === 1 ? 'chat.scope.paths.one' : 'chat.scope.paths', params: { count: scopes.length } }
  const scope = str(args.scope)
  if (scope === '') return { key: 'chat.scope.workspace' }
  if (scope === 'all') return { key: 'chat.scope.all' }
  return { key: 'chat.scope.path', params: { name: baseName(scope) } }
}

/**
 * 折叠行摘要。`resultText` 为 null 表示还在跑；参数还没齐时返回 null（行里只留标题）。
 * 作用域这类嵌套文案先由调用方翻译 `scope` 再填进外层（见 toolSummaryText）。
 */
export function toolSummary(toolName: MemoryToolName, args: Args | undefined, resultText: string | null): (Summary & { scope?: Summary }) | null {
  if (args === undefined) return null
  switch (toolName) {
    case 'memory_save': {
      const name = str(args.name)
      if (resultText === null) return { key: 'chat.tool.save.running', params: { name } }
      const result = parseSaveResult(resultText)
      return { key: result === undefined ? 'chat.tool.save.notSaved' : `chat.tool.save.${result.kind}`, params: { name } }
    }
    case 'memory_search': {
      const query = str(args.query)
      if (resultText === null) return { key: 'chat.tool.search.running', params: { query } }
      const count = countSearchHits(resultText)
      return count === 0 ? { key: 'chat.tool.search.none', params: { query } } : { key: 'chat.tool.search.found', params: { count, query } }
    }
    case 'memory_forget': {
      if (resultText === null) {
        const ids = list(args.ids).length
        return { key: ids === 1 ? 'chat.tool.forget.running.one' : 'chat.tool.forget.running', params: { count: ids } }
      }
      const count = forgottenCount(resultText)
      return count === 0 ? { key: 'chat.tool.forget.none' } : { key: count === 1 ? 'chat.tool.forget.done.one' : 'chat.tool.forget.done', params: { count } }
    }
    case 'memory_snapshot': {
      const action = str(args.action)
      if (action === 'create' || action === 'list') return { key: `chat.tool.snapshot.${action}` }
      if (action === 'show' || action === 'restore') return { key: `chat.tool.snapshot.${action}`, params: { id: str(args.snapshotId) } }
      return null
    }
    case 'memory_source':
      return { key: 'chat.tool.source', params: { id: str(args.memoryId) } }
    case 'memory_confirm':
      return args.action === 'resolve'
        ? { key: 'chat.tool.confirm.resolve', params: { id: str(args.decisionId) } }
        : { key: 'chat.tool.confirm.refresh', params: { id: str(args.memoryId) } }
    case 'memory_scan':
      return { key: 'chat.tool.scan', scope: scopeSummary(args) }
    case 'memory_health':
      return { key: 'chat.tool.health', scope: scopeSummary(args) }
    case 'memory_promote': {
      const count = list(args.ids).length
      if (args.dismiss === true) return { key: 'chat.tool.promote.dismiss', params: { count } }
      return { key: args.target === 'agents-md' ? 'chat.tool.promote.agentsMd' : 'chat.tool.promote.global', params: { count } }
    }
  }
}
