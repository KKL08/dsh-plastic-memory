import type { MemoryRecord } from '../record-schema.ts'
import type { GovernanceRejectCode } from '../contract-codes.ts'
import type { MemoryStore } from '../store.ts'
import { ledgerLabel, scopeOfMemory, type Scope } from '../scope.ts'

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

/** 同 id 在几个作用域里各有一份时，target 指明哪一份（GUI 按页面上那一份操作）。 */
export function isCopyOf(record: Pick<MemoryRecord, 'scope' | 'workspacePath'>, target: Scope): boolean {
  return target.kind === 'global' ? record.scope === 'global' : record.scope === 'workspace' && record.workspacePath === target.workspacePath
}

/**
 * 按副本定位（含非 active）：只读目标作用域（isExactLayer），别的作用域里同 id 的副本再新也不取；目标作用域没有这个 id 时当作没找到。
 * 写回时调用方带同样的只认层提示（store 删除类方法的 isExactLayer），改的就是读到的这一份。
 */
export async function locateCopy(store: Pick<MemoryStore, 'get'>, id: string, target: Scope): Promise<MemoryRecord | undefined> {
  const record = await store.get(id, { workspacePath: target.kind === 'workspace' ? target.workspacePath : undefined, isExactLayer: true })
  return record !== undefined && isCopyOf(record, target) ? record : undefined
}

/**
 * records 里此刻在各自作用域里已经不在了（任何状态都没有，即被彻底删除）的那些副本。每个作用域整读一次（含归档），
 * 不逐条定位：按 id 定位要扫整个作用域，一份快照几百条时成了平方级；缺 workspacePath 的按 id 两级定位。
 * 接线层把它交给 SnapshotStore，拍完快照落盘后复核（见 SnapshotStore.capture）。
 */
export const goneCopies = (store: Pick<MemoryStore, 'get' | 'readRaw'>) => async <T extends Located>(records: readonly T[]): Promise<Set<T>> => {
  const present = new Map<string, Set<string>>()   // 作用域标签 → 盘上有的 id
  const gone = new Set<T>()
  for (const r of records) {
    const scope = scopeOfMemory(r)
    if (scope === undefined) {
      if ((await store.get(r.id)) === undefined) gone.add(r)
      continue
    }
    const label = workspaceLabel(r)
    let ids = present.get(label)
    if (ids === undefined) {
      const read = await store.readRaw(scope, { includeArchive: true })
      ids = new Set(read.records.map(l => l.record.id))
      present.set(label, ids)
    }
    if (!ids.has(r.id)) gone.add(r)
  }
  return gone
}

/**
 * 只动 target 那一份时，快照里哪些同 id 记录算它的历史：target 作用域的，加上别的作用域里、那个作用域此刻已定位不到这个 id（含归档）的——
 * 那是这条记忆换作用域（提升、移到项目）之前留下的。别的作用域还有这个 id 的，是那一份自己的历史，不算。
 * 先按作用域算好保留集合，返回的谓词是同步的（快照表在串行化的重写里用）。
 */
export async function copyHistory(
  store: Pick<MemoryStore, 'get'>, records: Iterable<Located>, ids: ReadonlySet<string>, target: Scope,
): Promise<(record: Located) => boolean> {
  const key = (r: Located) => `${r.id}\0${workspaceLabel(r)}`
  const kept = new Set<string>()
  const checked = new Set<string>()
  for (const r of records) {
    if (!ids.has(r.id) || isCopyOf(r, target) || checked.has(key(r))) continue
    checked.add(key(r))
    const scope = scopeOfMemory(r)
    if (scope !== undefined && (await locateCopy(store, r.id, scope)) !== undefined) kept.add(key(r))
  }
  return r => ids.has(r.id) && !kept.has(key(r))
}

/** 记录所属 workspace 的标签：global 记忆为 'global'（待决账本的 workspaces 字段同口径）。 */
export function workspaceLabel(record: Pick<MemoryRecord, 'scope' | 'workspacePath'> | undefined): string {
  if (record === undefined) return '(未知)'
  const scope = scopeOfMemory(record)
  return scope === undefined ? '(未知项目)' : ledgerLabel(scope)
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
