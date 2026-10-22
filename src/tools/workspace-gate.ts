import type { MemoryRecord } from '../record-schema.ts'
import type { GovernanceRejectCode } from '../contract-codes.ts'

/**
 * 跨 workspace 门（S2）：治理工具只在用户明确选择「全局整理」后才动其他项目的记录。
 * 可见集合 = global + 当前 workspace；判定只看定位结果的 scope / workspacePath。
 */

/** 治理执行器的会话上下文。无工作目录的会话 workspacePath 为 undefined，可见集合只剩 global。 */
export interface GovernanceContext {
  workspacePath: string | undefined
}

/** 被门拒绝的记录：单独列出，不影响同批可见记录。 */
export interface CrossWorkspaceRejection {
  id: string
  code: GovernanceRejectCode
  workspacePath: string
}

/** 带参数放行的非可见记录：结果里标出所属 workspace。 */
export interface OtherWorkspaceMark {
  id: string
  workspacePath: string
}

type Located = Pick<MemoryRecord, 'id' | 'scope' | 'workspacePath'>

/** 工具参数：五个治理工具共用同一份说明。 */
export const ALLOW_CROSS_WORKSPACE_PARAM = {
  type: 'boolean',
  description: '缺省 false，只能操作当前项目与全局记忆。只有用户在治理开始时明确选择了「全局整理」才传 true，'
    + '用来操作其他项目的记忆；用户只选了整理本项目时绝不传。',
} as const

export function isVisible(record: Pick<MemoryRecord, 'scope' | 'workspacePath'>, context: GovernanceContext): boolean {
  return record.scope === 'global' || (context.workspacePath !== undefined && record.workspacePath === context.workspacePath)
}

/** 记录所属 workspace 的标签：global 记忆为 'global'（待决账本的 workspaces 字段同口径）。 */
export function workspaceLabel(record: Pick<MemoryRecord, 'scope' | 'workspacePath'> | undefined): string {
  if (record === undefined) return '(未知)'
  return record.scope === 'global' ? 'global' : record.workspacePath ?? '(未知项目)'
}

/** 按门分拣：可见的放行；不可见的带参数放行并标出、不带参数拒绝。保持输入顺序。 */
export function gateRecords<T extends Located>(records: readonly T[], context: GovernanceContext, allowCrossWorkspace: boolean | undefined): {
  allowed: T[]
  rejected: CrossWorkspaceRejection[]
  otherWorkspaces: OtherWorkspaceMark[]
} {
  const allowed: T[] = []
  const rejected: CrossWorkspaceRejection[] = []
  const otherWorkspaces: OtherWorkspaceMark[] = []
  for (const r of records) {
    if (isVisible(r, context)) { allowed.push(r); continue }
    const workspacePath = workspaceLabel(r)
    if (allowCrossWorkspace === true) {
      allowed.push(r)
      otherWorkspaces.push({ id: r.id, workspacePath })
    } else {
      rejected.push({ id: r.id, code: 'cross-workspace', workspacePath })
    }
  }
  return { allowed, rejected, otherWorkspaces }
}

const listed = (items: ReadonlyArray<{ id: string; workspacePath: string }>) =>
  items.map(i => `${i.id}（属于 ${i.workspacePath}）`).join('、')

/** 消息尾注：拒绝的与跨项目放行的分别列出，带所属 workspace 路径。都没有时为空串。 */
export function crossWorkspaceNote(rejected: readonly CrossWorkspaceRejection[], otherWorkspaces: readonly OtherWorkspaceMark[]): string {
  const parts: string[] = []
  if (otherWorkspaces.length > 0) parts.push(`其中 ${otherWorkspaces.length} 条属于其他项目：${listed(otherWorkspaces)}。`)
  if (rejected.length > 0) {
    parts.push(`${rejected.length} 条属于其他项目，未操作：${listed(rejected)}。`
      + '只有用户明确选择「全局整理」后才能带 allowCrossWorkspace: true 操作其他项目的记忆。')
  }
  return parts.length > 0 ? `\n${parts.join('\n')}` : ''
}

/** 待决项双方各自的 workspace（与 memoryIds 一一对应）：账本里记了就用账本的，旧条目按记录现状补出。 */
export function decisionWorkspaces(
  entry: { memoryIds: readonly string[]; workspaces?: readonly string[] },
  lookup: (id: string) => Pick<MemoryRecord, 'scope' | 'workspacePath'> | undefined,
): string[] {
  return entry.workspaces !== undefined ? [...entry.workspaces] : entry.memoryIds.map(id => workspaceLabel(lookup(id)))
}

/** 待决项列表行的 workspace 尾注，例如「（workspace：/a ↔ global）」。 */
export function decisionWorkspacesNote(workspaces: readonly string[]): string {
  return workspaces.length > 0 ? `（workspace：${workspaces.join(' ↔ ')}）` : ''
}
