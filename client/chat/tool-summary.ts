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
  /** 类型名（按类型列时）：调用方按界面语言换成显示名，拼好填进 `{types}`。 */
  types?: string[]
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
  /** 已更新的那条的名称（只传 edits 的更新参数里没有名称）；旧格式的结果没有。 */
  name?: string
}

/** `renderSaveResult` 的首行：「已保存记忆 <id>（<type>，<scope>）…」「已更新记忆 <id>（<名称>）。」（旧格式没有名称）；其余（疑似重复、拒绝）不算记住。 */
export function parseSaveResult(text: string): SavedResult | undefined {
  const saved = /^已保存记忆 ([^\s（]+)（([^，）]+)，(global|workspace)）/.exec(text)
  if (saved) return { kind: 'saved', id: saved[1]!, type: saved[2]!, scope: saved[3] as 'global' | 'workspace' }
  const updated = /^已更新记忆 ([^\s。（]+)(?:（(.+?)）)?。/.exec(text)
  if (updated) return { kind: 'updated', id: updated[1]!, ...(updated[2] === undefined ? {} : { name: updated[2] }) }
  return undefined
}

/** 项目会话改写全局记忆、要模型先确认的那段引导（服务端 globalUpdateGuide）：没写入，但不是失败，折叠行另写一句。 */
export function isGlobalConfirmPending(text: string): boolean {
  return /^未保存：[^\n]*是全局记忆，改动会影响所有项目/.test(text)
}

/** 原话没查成、改查了记忆时，结果开头单独一行的说明（`renderSearchResult` 的 pathNote），后面紧跟记忆检索结果。 */
const PATH_NOTES = ['当前设置是只查记忆，这次没有查过往对话的原话。', '过往对话的原话暂时查不了，这次只查了记忆。', '这次读不到会话信息，过往对话的原话没查。']

function pathNoteOf(text: string): string | undefined {
  return PATH_NOTES.find(note => text.startsWith(`${note}\n`))
}

/**
 * `renderSearchResult`：每条命中一段，段首「[id] 类型｜摘要」。开头的路径说明和第一条命中只隔一个换行，先去掉再数。
 * 同时搜过往对话时分「【记忆条目】」「【其他原话】」两段（`renderSearchSections`），只数记忆条目段；
 * 原话段在最后，记忆正文里也可能写着这个标题，所以从最后一处切。
 */
export function countSearchHits(text: string): number {
  const pathNote = pathNoteOf(text)
  if (pathNote !== undefined) return countSearchHits(text.slice(pathNote.length + 1))
  if (text.startsWith('【其他原话】\n')) return 0
  let memories = text
  if (text.startsWith('【记忆条目】\n')) {
    const dialogueAt = text.lastIndexOf('\n\n【其他原话】\n')
    memories = text.slice('【记忆条目】\n'.length, dialogueAt === -1 ? undefined : dialogueAt)
  }
  // 正文以换行结尾时块之间多出空行：按连续空行切，下一条的头行仍在块首
  return memories.split(/\n{2,}/).filter(block => /^\[[^\]\s]+\] [^\n]*｜/.test(block)).length
}

/** 按主题浏览的结果：每条一行「- [id] 名称（摘要）…」，输出放不下时缩到只剩「- [id]」。 */
function countBrowseRows(text: string): number {
  return text.match(/^- \[[^\]\s]+\](?: |$)/gm)?.length ?? 0
}

/** 列历史的头行「记忆 <id> 的历史：共读到 N 版，给出 M 版。」→ 给出的版数；参数错、找不到这条记忆时没有这行。 */
function historyGiven(text: string): number | undefined {
  const m = /^记忆 \S+ 的历史：共读到 \d+ 版，给出 (\d+) 版。/.exec(text)
  return m ? Number(m[1]) : undefined
}

/**
 * memory_search 按参数分五种用法，判定顺序同服务端：给了 id 是列历史或读一版，其次有关键词是检索（可带 topic、types），
 * 再次只给 topic 是按主题浏览，只给 types 是按类型列。结果只说「列出 / 搜到 N 条」，参数错、找不到、读不全时不说找到了什么。
 * 给了 topic 时服务端只查记忆；其余情况下 source 为 dialogue 是只搜过往对话，不数条数（原话没查成、改查了记忆时除外）。
 */
function searchSummary(args: Args, resultText: string | null): Summary {
  const id = str(args.id)
  const version = str(args.version)
  if (id !== '' && version !== '') {
    if (resultText === null) return { key: 'chat.tool.search.version.running', params: { id, version } }
    const isRead = /^记忆 \S+ 的版本 \S+ · 起始 /.test(resultText)
    return { key: isRead ? 'chat.tool.search.version.done' : 'chat.tool.search.version.failed', params: { id, version } }
  }
  if (id !== '' && args.history === true) {
    if (resultText === null) return { key: 'chat.tool.search.history.running', params: { id } }
    const count = historyGiven(resultText)
    if (count === undefined) return { key: 'chat.tool.search.history.failed', params: { id } }
    if (count === 0) return { key: resultText.includes('这条记忆没有历史版本') ? 'chat.tool.search.history.none' : 'chat.tool.search.history.failed', params: { id } }
    const kind = resultText.includes('有部分历史版本没读出来') ? 'partial' : 'found'
    return { key: count === 1 ? `chat.tool.search.history.${kind}.one` : `chat.tool.search.history.${kind}`, params: { id, count } }
  }
  const query = str(args.query)
  const topic = str(args.topic).trim()
  if (query.trim() === '' && topic !== '') {
    if (resultText === null) return { key: 'chat.tool.search.topic.running', params: { topic } }
    const count = countBrowseRows(resultText)
    return count === 0 ? { key: 'chat.tool.search.topic.none', params: { topic } } : { key: 'chat.tool.search.topic.found', params: { topic, count } }
  }
  // 结果以路径说明开头时原话没查成、改查了记忆，照关键词检索数
  if (args.source === 'dialogue' && topic === '' && (resultText === null || pathNoteOf(resultText) === undefined)) {
    // 原话按会话和轮分组，数不出说得清的条数：只说搜了过往对话，说明里有「过往对话里没有找到。」这一行时说没搜到
    if (resultText === null) return { key: 'chat.tool.search.dialogue.running', params: { query } }
    const isNoHit = resultText.split('\n').includes('过往对话里没有找到。')
    return { key: isNoHit ? 'chat.tool.search.dialogue.none' : 'chat.tool.search.dialogue.done', params: { query } }
  }
  const types = list(args.types).filter((type): type is string => typeof type === 'string' && type !== '')
  if (query.trim() === '' && types.length > 0) {
    if (resultText === null) return { key: 'chat.tool.search.types.running', types }
    const count = countSearchHits(resultText)
    return count === 0 ? { key: 'chat.tool.search.types.none', types } : { key: 'chat.tool.search.types.found', params: { count }, types }
  }
  if (resultText === null) return { key: 'chat.tool.search.running', params: { query } }
  const count = countSearchHits(resultText)
  return count === 0 ? { key: 'chat.tool.search.none', params: { query } } : { key: 'chat.tool.search.found', params: { count, query } }
}

/** `memory_forget` 的「已遗忘 N 条记忆」；全部不存在时没有这句。 */
function forgottenCount(text: string): number {
  const m = /已遗忘 (\d+) 条/.exec(text)
  return m ? Number(m[1]) : 0
}

const SOURCE_MODES = ['user-explicit', 'user-behavior', 'environment-observed', 'agent-inferred', 'agent-action-confirmed'] as const

/**
 * 一次成功的新记（kind = saved）或改写（kind = updated）→ 记忆卡：id / 类型 / 作用域取结果，原文、名字、来源取参数。
 * 改写的结果只有 id 和名称：类型取参数，作用域也先取参数（改写不改作用域，参数可能填错），由交付卡按全部记忆视图校正。
 * 只传 edits 的改写参数里没有名称、正文这些：名称取结果，其余留空，由交付卡从全部记忆视图取改后的样子。
 * 参数是 agent 发的原文，没经过视图的遮盖，这里遮掉密钥片段，疑似密钥也遮（带 allowSecret 存下的也不例外）。
 */
export function savedMemoryCard(args: Args | undefined, resultText: string, time: number): MemoryCard | undefined {
  const result = parseSaveResult(resultText)
  if (result === undefined || args === undefined) return undefined
  const sourceMode = SOURCE_MODES.find(mode => mode === args.sourceMode)
  return maskSecretSurface({
    id: result.id,
    name: str(args.name) || (result.name ?? ''),
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
      // 只传 edits 的更新参数里没有名称：取结果里的，旧格式结果也没有时写 id
      const name = str(args.name) || str(args.id)
      if (resultText === null) return { key: 'chat.tool.save.running', params: { name } }
      const result = parseSaveResult(resultText)
      const notSaved = isGlobalConfirmPending(resultText) ? 'chat.tool.save.confirmingGlobal' : 'chat.tool.save.notSaved'
      return { key: result === undefined ? notSaved : `chat.tool.save.${result.kind}`, params: { name: str(args.name) || (result?.name ?? name) } }
    }
    case 'memory_search':
      return searchSummary(args, resultText)
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
      if (args.action === 'resolve') return { key: 'chat.tool.confirm.resolve', params: { id: str(args.decisionId) } }
      return { key: args.action === 'accept-subagent' ? 'chat.tool.confirm.acceptSubagent' : 'chat.tool.confirm.refresh', params: { id: str(args.memoryId) } }
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
