import type { MemoryRecord } from '../record-schema.ts'
import type { SessionLog } from '../session-log.ts'
import type { HostSession } from './host-session.ts'

/** 一个会话当下的读取事实，每次现查。isMarkedNoReview：用户不让回看这个会话（没给清单时为 false）。 */
export interface SessionFacts { exists: boolean; log: SessionLog | null; isMarkedNoReview: boolean }

/** 读取事实与日志一起返回，调用方无需重复读取。各条读取入口拿同一份事实，放不放行各自定。 */
export async function sessionFacts(
  sessionId: string, host: Pick<HostSession, 'readSessionLog'>, noReview?: { isMarkedNoReview(sessionId: string): Promise<boolean> },
): Promise<SessionFacts> {
  const [log, isMarkedNoReview] = await Promise.all([host.readSessionLog(sessionId), noReview?.isMarkedNoReview(sessionId) ?? false])
  return { exists: log !== null, log, isMarkedNoReview }
}

/** 凭记忆的锚读会话：先隔离项目，再限制子 agent 只能读自己的出处。 */
export function anchorReadPolicy(
  record: Pick<MemoryRecord, 'scope' | 'workspacePath'>,
  anchorSessionId: string,
  context: { workspacePath: string | undefined; session?: { id: string }; delegation?: object },
): { ok: true } | { ok: false; kind: 'forbidden' } | { ok: false; kind: 'rejected'; code: 'subagent-restricted'; reason: string } {
  if (record.scope === 'workspace' && (record.workspacePath === undefined || record.workspacePath !== context.workspacePath)) return { ok: false, kind: 'forbidden' }
  if (context.delegation !== undefined && anchorSessionId !== context.session?.id) {
    return { ok: false, kind: 'rejected', code: 'subagent-restricted', reason: '这条记忆的出处在别的会话，带回主会话查' }
  }
  return { ok: true }
}

declare const checkedAnchor: unique symbol

/** 已经过了记忆规则的锚：只能由 checkAnchor 产生，调用方造不出一个随手的放行。 */
export interface CheckedAnchor {
  readonly record: Pick<MemoryRecord, 'id'>
  readonly sessionId: string
  readonly [checkedAnchor]: true
}

/** 记忆的锚先过 anchorReadPolicy（项目隔离、子 agent 只读自己的出处），过了才给出 CheckedAnchor。 */
export function checkAnchor(
  record: Pick<MemoryRecord, 'id' | 'scope' | 'workspacePath'>,
  anchorSessionId: string,
  context: { workspacePath: string | undefined; session?: { id: string }; delegation?: object },
): { ok: true; anchor: CheckedAnchor } | Exclude<ReturnType<typeof anchorReadPolicy>, { ok: true }> {
  const policy = anchorReadPolicy(record, anchorSessionId, context)
  if (!policy.ok) return policy
  return { ok: true, anchor: { record, sessionId: anchorSessionId } as CheckedAnchor }
}

/**
 * 记忆带原话：锚已过记忆规则（全局记忆的锚指到别的项目也算），再看会话事实——会话还在、没标不回看。
 * 事实取自这次检索现查的会话表，不逐个读会话日志；会话表这次读不全时不放行，也不说会话没了。
 */
export function quoteReadPolicy(anchor: CheckedAnchor, table: SessionTable): { ok: true } | { ok: false; kind: 'unavailable' | 'gone' | 'no-review' } {
  if (!table.isComplete) return { ok: false, kind: 'unavailable' }
  if (table.get(anchor.sessionId) === undefined) return { ok: false, kind: 'gone' }
  if (table.isMarkedNoReview(anchor.sessionId)) return { ok: false, kind: 'no-review' }
  return { ok: true }
}

/** 一次列举形成的会话表，不读取日志；信息不完整时禁止据此放行。 */
export interface SessionTable {
  isComplete: boolean
  get(sessionId: string): { workspacePath: string | undefined; isSubagent: boolean } | undefined
  isMarkedNoReview(sessionId: string): boolean
}

/** 每次现查会话和不回看清单，同一工作目录只解析一次项目根。 */
export async function sessionTable(
  host: Pick<HostSession, 'listSessions'>,
  noReview: { sessionIds(): Promise<Set<string>> },
  workspaceOf: (cwd: string | undefined) => Promise<string | undefined>,
): Promise<SessionTable> {
  const entries = new Map<string, { workspacePath: string | undefined; isSubagent: boolean }>()
  let marked = new Set<string>()
  let isComplete = false
  try {
    const [listed, ids] = await Promise.all([host.listSessions(), noReview.sessionIds()])
    marked = ids
    if (listed !== null) {
      const workspaces = new Map<string | undefined, Promise<string | undefined>>()
      for (const entry of listed) {
        let workspace = workspaces.get(entry.cwd)
        if (workspace === undefined) workspaces.set(entry.cwd, workspace = workspaceOf(entry.cwd))
        entries.set(entry.id, { workspacePath: await workspace, isSubagent: entry.isSubagent })
      }
      isComplete = true
    }
  } catch { /* 清单或项目归属读不出，这次不放行。 */ }
  return { isComplete, get: id => entries.get(id), isMarkedNoReview: id => marked.has(id) }
}

/** 凭会话放行：当前项目、子会话自身、用户允许回看三项都要满足。 */
export function sessionReadPolicy(
  table: SessionTable, sessionId: string,
  context: { workspacePath: string | undefined; session?: { id: string }; delegation?: object },
): { ok: true } | { ok: false; kind: 'unavailable'; reason: string } | { ok: false; kind: 'forbidden' } | { ok: false; kind: 'rejected'; code: 'subagent-restricted'; reason: string } {
  if (!table.isComplete) return { ok: false, kind: 'unavailable', reason: '这次读不到会话信息，稍后再试' }
  const entry = table.get(sessionId)
  if (!entry || entry.workspacePath === undefined || entry.workspacePath !== context.workspacePath) return { ok: false, kind: 'forbidden' }
  // 不回看先于子 agent 限制：标了不回看的会话对谁都是同一个回答，不提示「带回主会话查」
  if (table.isMarkedNoReview(sessionId)) return { ok: false, kind: 'forbidden' }
  if (context.delegation !== undefined && sessionId !== context.session?.id) return { ok: false, kind: 'rejected', code: 'subagent-restricted', reason: '只能读自己的会话，其他会话带回主会话查' }
  return { ok: true }
}
