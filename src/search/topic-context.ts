import { groupTopics, usableMembers, topicDisplayName } from '../topic-members.ts'
import { readIndex, keyOf, type IndexFiles } from '../topic-index.ts'
import { resolveLiveFirst } from '../storage/table.ts'
import { isPendingDelegated } from '../record-schema.ts'
import { findMemoryCandidates } from './memory-candidates.ts'
import { tokenizerForQuery } from './jieba-segmenter.ts'
import { tokenHitsIn } from './ranking.ts'
import { termHitCounts } from './coverage.ts'
import type { MemoryRecord } from '../record-schema.ts'
import type { MemoryStore } from '../store.ts'
import type { TopicGroup } from '../topic-members.ts'
import type { MemoryCandidateDeps, MemoryCandidateQuery, MemoryCandidateSet } from './memory-candidates.ts'

/**
 * 记忆检索的主题这一侧：读磁盘上当下的主题索引，给候选集挂上主题信息；只给主题时，候选换成这个主题的成员。
 * 只读：不写索引、不写派生库、不记召回。关键词怎么取候选仍由 findMemoryCandidates 决定，这里不改它的结果，只在它之后加工。
 */

/** 主题所在的作用域。记忆的作用域身份同它：record.scope 是 global 的归全局，其余归项目。 */
export type TopicScope = 'workspace' | 'global'

/** 一个作用域里的一组，带作用域身份。名称、说明、曾用名是索引文件原样。 */
export interface ScopedTopicGroup extends TopicGroup {
  scope: TopicScope
  /**
   * 这一组的索引页里，指向的记忆这次在这个作用域里一个副本都没读到的 id 个数（去重；文件不在、读不出、解析不了）。
   * 「未整理」只数页里的行，不数补进来的。过期、还没生效、同 id 被另一作用域那份取走的不算。
   */
  unreadableRows: number
}

export interface TopicContext {
  /**
   * 范围内各作用域的组：项目在前、全局在后，每个作用域内按 groupTopics 的先后（「未整理」最后，成员为空也在）。
   * 还没有索引文件的作用域（store.readIndex 回 undefined）按空索引分组，记录全在「未整理」，同注入。
   * 读不出的作用域没有组。没给 topic、范围内每个作用域都还没有索引文件时为空数组（不出主题信息）。
   */
  groups: readonly ScopedTopicGroup[]
  /**
   * 主题索引读不出的作用域，项目在前、全局在后：store.readIndex 抛错；或项目这一层 readIndex 回 undefined、
   * 而这次按范围读记录的目录说明里有 dir-unreadable（项目目录读不出，或找项目目录时有目录读不出）。
   */
  unreadable: readonly TopicScope[]
  /** 查询的 token 命中主题名、曾用名或说明的组（「未整理」不算），按 groups 的先后。查询没有可打分的 token、或给了 topic 时为空。 */
  matched: readonly ScopedTopicGroup[]
  /**
   * 给了 topic 时：主题名、任一曾用名或显示名（topicDisplayName）对上它的组，判同用 keyOf；按 groups 的先后。
   * 没给 topic 时为 undefined。
   */
  browsed?: readonly ScopedTopicGroup[]
}

export interface TopicCandidateQuery extends MemoryCandidateQuery {
  /** 只在这个主题的成员里取候选（名字和曾用名都算，判同用 keyOf）。只用来比名字，不拼路径。 */
  topic?: string
}

export interface TopicCandidateDeps extends MemoryCandidateDeps {
  store: Pick<MemoryStore, 'readRaw' | 'readIndex'>
}

/**
 * 带主题信息的取候选。先读范围内各作用域磁盘上当下的主题索引；按主题列出只整范围读一次，其余调用经 findMemoryCandidates 取候选：
 * - 没给 topic：candidates、isDirectHit、diagnostics 原样是 findMemoryCandidates 的结果，只加上 topics；
 * - 给了 topic、查询没有词项（空串或只有空白）：candidates 换成 browsed 各组里可用的成员（usableMembers），按组的先后、组内按索引先后，
 *   只整范围读一次，不取关键词候选；诊断词项为空、listedCount 取这次读取。填了类型的按类型过滤；tier 为 all、tokenHits 为空数组；isDirectHit 为 false；
 * - 给了 topic、查询有词项：candidates 是关键词候选里属于 browsed 各组的那些（按作用域 + id 认），保留原来的名次；
 *   isDirectHit 只在原来置顶的那条留下来时为真。
 * 给了 topic 时 diagnostics 不带 missingTypeCounts，termHits 按换过之后的候选重算（同一个 termHitCounts）。
 * 没给 topic、且范围内每个作用域都还没有索引文件（readIndex 全回 undefined、没有抛错的）时不多读盘、不出主题信息；
 * 其余关键词检索按同一范围不带预筛、不带类型再读一次记录，用来分组、计数、找每行指向的记忆、看项目目录读不读得出。
 */
export async function findTopicCandidates(q: TopicCandidateQuery, deps: TopicCandidateDeps): Promise<MemoryCandidateSet & { topics: TopicContext }> {
  const hint = q.scope.kind === 'global' ? undefined : q.scope.workspacePath
  const scopes: TopicScope[] = q.scope.kind === 'global' ? ['global'] : q.scope.kind === 'workspace' ? ['workspace'] : hint !== undefined ? ['workspace', 'global'] : ['global']
  const files = new Map<TopicScope, IndexFiles | undefined>()
  const unreadable: TopicScope[] = []
  for (const scope of scopes) {
    try {
      files.set(scope, await deps.store.readIndex(scope === 'global' ? { kind: 'global' } : { kind: 'workspace', workspacePath: hint! }))
    } catch {
      unreadable.push(scope)
    }
  }
  const isBrowse = q.topic !== undefined && q.query.trim() === ''
  const keyword = isBrowse ? undefined : await findMemoryCandidates(q, deps)
  if (q.topic === undefined && unreadable.length === 0 && scopes.every(scope => files.get(scope) === undefined)) {
    return { ...keyword!, topics: { groups: [], unreadable: [], matched: [] } }
  }
  const at = keyword?.at ?? deps.now?.() ?? Date.now()
  const full = await deps.store.readRaw(q.scope)
  const base: MemoryCandidateSet = keyword ?? {
    candidates: [], isDirectHit: false, at,
    diagnostics: { listedCount: full.listedCount, tokens: [], legacyTerms: [], groups: [], termHits: [] },
  }
  if (scopes.includes('workspace') && !unreadable.includes('workspace') && files.get('workspace') === undefined && full.directoryNotes.some(n => n.code === 'dir-unreadable')) unreadable.unshift('workspace')
  const located = resolveLiveFirst(full.records, { workspacePath: hint }).filter(l => l.record.status === 'active' && !isPendingDelegated(l.record))
  const scopeOf = (r: MemoryRecord): TopicScope => r.scope === 'global' ? 'global' : 'workspace'
  const groups = scopes.flatMap(scope => {
    if (unreadable.includes(scope)) return []
    const indexFiles = files.get(scope) ?? { entry: '', pages: {} }
    const index = readIndex(indexFiles)
    const present = new Set(full.records.filter(l => scopeOf(l.record) === scope).map(l => l.record.id))
    return groupTopics(indexFiles, located.filter(l => scopeOf(l.record) === scope).map(l => l.record)).map(g => {
      const ids = g.isUnsorted ? index.unsorted : index.topics.find(t => t.fileName === g.fileName)!.memberIds
      return { ...g, scope, unreadableRows: [...new Set(ids)].filter(id => !present.has(id)).length }
    })
  })
  let matched: ScopedTopicGroup[] = []
  if (q.topic === undefined && base.diagnostics.tokens.length > 0) {
    const tokenize = await tokenizerForQuery(q.query, deps.tokenizer)
    matched = groups.filter(g => !g.isUnsorted && tokenHitsIn([g.name, ...g.aliases, g.about], base.diagnostics.tokens, tokenize).some(Boolean))
  }
  const browsed = q.topic === undefined ? undefined : groups.filter(g => [g.name, ...g.aliases, topicDisplayName(g)].some(name => keyOf(name) === keyOf(q.topic!)))
  const topics: TopicContext = { groups, unreadable, matched, ...(browsed !== undefined ? { browsed } : {}) }
  if (browsed === undefined) return { ...base, topics }
  const members = browsed.flatMap(g => usableMembers(g.members, base.at))
  const filePathOf = new Map(located.map(l => [l.record, l.filePath]))
  const memberKeys = new Set(members.map(r => `${scopeOf(r)}\0${r.id}`))
  const candidates = isBrowse
    ? members.filter(r => !q.types?.length || q.types.includes(r.type)).map(record => ({ record, filePath: filePathOf.get(record)!, tier: 'all' as const, tokenHits: [] }))
    : base.candidates.filter(c => memberKeys.has(`${scopeOf(c.record)}\0${c.record.id}`))
  const { missingTypeCounts: _missingTypeCounts, ...diagnostics } = base.diagnostics
  return {
    ...base, topics, candidates,
    isDirectHit: q.query.trim() !== '' && base.isDirectHit && candidates[0] === base.candidates[0],
    diagnostics: { ...diagnostics, termHits: termHitCounts(diagnostics.groups, diagnostics.tokens, candidates.map(c => c.tokenHits)) },
  }
}

/** 一条记录所在的组：按作用域 + id 在 context.groups 里找；不在任何组（待确认的、这次分组时没读到的）回 undefined。 */
export function topicGroupOf(context: TopicContext, record: MemoryRecord): ScopedTopicGroup | undefined {
  const scope = record.scope === 'global' ? 'global' : 'workspace'
  return context.groups.find(g => g.scope === scope && g.members.some(r => r.id === record.id))
}
