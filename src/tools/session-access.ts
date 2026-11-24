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
  if (record.scope === 'workspace' && record.workspacePath !== context.workspacePath) return { ok: false, kind: 'forbidden' }
  if (context.delegation !== undefined && anchorSessionId !== context.session?.id) {
    return { ok: false, kind: 'rejected', code: 'subagent-restricted', reason: '这条记忆的出处在别的会话，带回主会话查' }
  }
  return { ok: true }
}
