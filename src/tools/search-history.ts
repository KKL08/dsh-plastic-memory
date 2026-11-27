import { historyWithMerged, readHistoryVersion } from '../merged-history.ts'
import { byVersionEnd, versionReason, type HistoryVersion } from '../storage/history.ts'
import { byPosition } from '../storage/table.ts'
import { maskSecrets, maskSecretSurface } from '../secrets.ts'
import { sourceNote } from '../index-line.ts'
import { DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT } from './search.ts'
import { isVisible } from './workspace-gate.ts'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { SearchNoteCode } from '../contract-codes.ts'
import type { SearchArgs, SearchHit, SearchToolDeps } from './search.ts'

/**
 * memory_search 的历史模式：按记忆 id 列它的历史版本，或按版本标识读一版。和关键词检索并列的一条分支，不走取候选。
 * 只读：不进写入段，不计召回，不写任何派生数据。读历史一律经 historyWithMerged（并进来的版本在两个阶段读出来一样）。
 */

/** 历史模式的入参：参数组合已经过 searchArgsError 校验，带着 id，history 和 version 恰好给了一个。 */
export type HistorySearchArgs = Pick<SearchArgs, 'scope' | 'limit' | 'history' | 'version'> & { id: string }

/** 列表里的一版：每版渲染成一行。 */
export interface HistoryEntry {
  /** 版本标识，按它读这一版。 */
  versionId: string
  /** 这一版的结束时间，ISO 8601（UTC）。 */
  endedAt: string
  /** 变化原因：先遮盖密钥，再把换行折成空格成一行；没有原因为空串。 */
  reason: string
  /** 并进来的版本才有：原来那条记忆的 id，渲染成「并入自」。 */
  mergedFrom?: string
  /** 输出长度到了上限、这一行只留版本标识时才有。 */
  isIdOnly?: boolean
}

/** 按 id 列历史版本的结果。 */
export interface HistoryListing {
  memoryId: string
  /** 新的在前，按 limit 取前几版。 */
  versions: HistoryEntry[]
  /** 读到的版本总数（按 limit 截取之前）。 */
  total: number
  /** 自己这份和并进来的各份都读全时为真；为假时 versions 只是读到的那几版。 */
  isComplete: boolean
}

/** 按版本标识读一版时，这一版自己的信息；正文作为一条命中放在 hits[0]，和检索结果同一条遮盖和渲染路径。 */
export interface HistoryVersionInfo {
  memoryId: string
  versionId: string
  /** 这一版从什么时候起是当前版、到什么时候被换掉，ISO 8601（UTC）。 */
  startedAt: string
  endedAt: string
  /** 同 HistoryEntry.reason。 */
  reason: string
  mergedFrom?: string
}

/**
 * 历史模式的结果。和检索结果同一个外形：说明放 note（码在 noteCode），列表截断的说明放 moreNote。
 * 列历史时 hits 为空、history 有值；读一版成功时 hits 恰好一条（这一版的整条记录，遮盖后全文）、version 有值；
 * 失败时只有 note 和 noteCode。
 */
export interface HistorySearchOutcome {
  hits: SearchHit[]
  note?: string
  noteCode?: SearchNoteCode
  moreNote?: string
  history?: HistoryListing
  version?: HistoryVersionInfo
}

/**
 * 按 id 定位记忆（scope 照普通检索的语义：缺省会话视角、当前项目优先），再列它的历史或读一版。
 * 定位不到、在最近删除里：memory-not-found；被取代的照常读。失败与读不全的处理见各说明码。
 */
export async function executeHistorySearch(args: HistorySearchArgs, exec: ToolRunContext, deps: SearchToolDeps): Promise<HistorySearchOutcome> {
  const { workspacePath } = await deps.host.contextOf(exec)
  if (args.scope === 'workspace' && workspacePath === undefined) return { hits: [], noteCode: 'no-workspace', note: '当前会话没有工作目录，无法限定项目范围；查全局记忆请用 scope: "global"。' }
  const target = args.scope === 'global' ? { kind: 'global' as const }
    : args.scope === 'workspace' ? { kind: 'workspace' as const, workspacePath: workspacePath! } : { workspacePath }
  const found = await deps.store.locate(args.id, target)
  if (found === undefined || byPosition(found).status === 'deleted'
    || (target.kind === undefined && !isVisible(found.record, { workspacePath }))) return { hits: [], noteCode: 'memory-not-found', note: '当前范围内找不到可读的这条记忆，请核对 id 和 scope；最近删除里的记忆可先恢复再查历史。' }
  if (args.history === true) {
    const listing = await historyWithMerged(deps.store, found)
    const total = listing.versions.length
    const versions = [...listing.versions].sort((a, b) => byVersionEnd(b, a))
      .slice(0, Math.min(args.limit ?? DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT)).map(entryOf)
    return {
      hits: [], history: { memoryId: args.id, versions, total, isComplete: listing.isComplete },
      ...(!listing.isComplete ? { noteCode: 'history-incomplete' as const, note: total > 0
        ? '有部分历史版本没读出来，下面只列出读到的版本，其余版本可能还在。可以用其中的版本标识配 version 读一版；需要完整历史时，可以请用户检查记忆目录。'
        : '这次没读出这条记忆的历史，不代表它没有历史版本。需要时可以请用户检查记忆目录；要读当前内容，把 id 填进 query。' }
        : total === 0 ? { noteCode: 'no-history' as const, note: '这条记忆没有历史版本；要读当前内容，请把 id 填进 query。' } : {}),
      ...(total > versions.length ? { moreNote: versions.length < MAX_SEARCH_LIMIT
        ? `只列出最新的 ${versions.length} 版，要看更早的版本可以调大 limit（最多 ${MAX_SEARCH_LIMIT} 版）。`
        : `limit 已是上限 ${MAX_SEARCH_LIMIT}，只列出最新的 ${versions.length} 版。` } : {}),
    }
  }
  const read = await readHistoryVersion(deps.store, found, args.version!)
  if (read.kind === 'unreadable') return { hits: [], noteCode: 'version-unreadable', note: '这一版的文件读不出来。可以用 id 配 history: true 看其他版本，或把 id 填进 query 读当前内容。' }
  if (read.kind === 'missing') return read.isComplete
    ? { hits: [], noteCode: 'version-not-found', note: '找不到这一版（可能已被清理或撤销，也可能版本标识有误）。可以用 id 配 history: true 列出现有的版本。' }
    : { hits: [], noteCode: 'history-incomplete', note: '这次没找到这一版，历史还有读不出的部分，所以不能确定它已经不在。可以用 id 配 history: true 看目前读得到的版本。' }
  const version = read.version
  const record = version.record
  const masked = maskSecretSurface(record)
  return {
    hits: [{ id: record.id, type: record.type, summary: masked.summary, content: masked.content, sourceNote: sourceNote(record), stalenessNote: '', matchNote: '' }],
    version: { memoryId: args.id, ...entryOf(version), startedAt: new Date(version.startedAt).toISOString() },
  }
}

/** 原因先遮盖再折行，让跨行密钥仍能被识别，同时保持列表每版一行。 */
function entryOf(version: HistoryVersion): HistoryEntry {
  return {
    versionId: version.versionId, endedAt: new Date(version.endedAt).toISOString(),
    reason: maskSecrets(versionReason(version)).replace(/\s*[\r\n]+\s*/g, ' ').trim(),
    ...(version.mergedFrom !== undefined ? { mergedFrom: version.mergedFrom } : {}),
  }
}
