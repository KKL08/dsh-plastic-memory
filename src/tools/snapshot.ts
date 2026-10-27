import type { MemoryStore } from '../store.ts'
import type { SnapshotStore, SnapshotDiffEntry } from '../governance/snapshots.ts'
import type { MemoryRecord } from '../record-schema.ts'
import { maskSecretSurface } from '../secrets.ts'
import { crossWorkspaceNote, gateRecords, isVisible, type CrossWorkspaceRejection, type GovernanceContext, type OtherWorkspaceMark } from './workspace-gate.ts'

export interface SnapshotToolDeps {
  store: MemoryStore
  snapshots: SnapshotStore
  now?: () => number
}

/** allowCrossWorkspace：用户明确选择「全局整理」时才为 true，放行其他项目的记录（见 workspace-gate.ts）。 */
export type SnapshotToolArgs =
  | { action: 'create'; description?: string; memoryIds?: string[]; allowCrossWorkspace?: boolean }
  | { action: 'list'; allowCrossWorkspace?: boolean }
  | { action: 'show'; snapshotId: string; allowCrossWorkspace?: boolean }
  | { action: 'restore'; snapshotId: string; memoryIds?: string[]; overwriteChanged?: boolean; allowCrossWorkspace?: boolean }

/** rejected：属于其他项目、因未带参数被拒的记录；otherWorkspaces：带参数放行、属于其他项目的记录。 */
interface CrossWorkspaceFields {
  rejected: CrossWorkspaceRejection[]
  otherWorkspaces: OtherWorkspaceMark[]
}

/** 只给 GUI 用的选项，不在工具参数里。isExactLayer：show / restore 按快照里每条记录自己的那一层定位与写回，
 *  不取别层更新的同 id 副本（GUI 恢复页面上那一份）。overwriteIf：给了它就只写现状过了它的记录，快照后被修改过的照样覆盖、
 *  已删除的也要过它（撤销：现状正是那次写下的内容）。 */
export interface SnapshotToolOptions {
  isExactLayer?: boolean
  overwriteIf?: (current: MemoryRecord) => boolean
}

export type SnapshotToolResult =
  | { kind: 'created'; snapshotId: string; count: number; missing: string[]; message: string } & CrossWorkspaceFields
  | { kind: 'listed'; snapshots: Array<{ id: string; createdAt: number; operation: string; description: string; count: number }>; message: string }
  | { kind: 'shown'; entries: SnapshotDiffEntry[]; message: string } & CrossWorkspaceFields
  /** skipped 含 redacted：redacted 是含密钥已物理删除、快照里只剩脱敏副本的记录，永不恢复。 */
  | { kind: 'restored'; restored: string[]; skipped: string[]; redacted: string[]; message: string } & CrossWorkspaceFields
  | { kind: 'error'; message: string }

/**
 * memory_snapshot（docs/p1-governance-health-design.md §6 恢复流程的工具面）：create 手动快照 / list 清单 /
 * show 对比 / restore 选择性恢复。restore 冲突保护：快照后被修改过的记录默认跳过。
 */
export async function executeSnapshotTool(
  rawArgs: unknown,
  context: GovernanceContext,
  deps: SnapshotToolDeps,
  options: SnapshotToolOptions = {},
): Promise<SnapshotToolResult> {
  const args = rawArgs as SnapshotToolArgs
  const now = deps.now?.() ?? Date.now()
  await deps.snapshots.sweep(now)  // 任何动作都先清一遍超窗旧快照（list 入口也发生）

  if (args.action === 'create') {
    // 去重（与 memory_forget 的约定一致）：调用者传入重复 id 不应重复计入快照
    const uniqueIds = args.memoryIds ? [...new Set(args.memoryIds)] : undefined
    // 预读范围：给了 id 则逐条两级定位（含非 active，当前 workspace 优先，再剔除已删）并过跨 workspace 门；
    // 否则只读可见集合（global + 当前 workspace）的 active，与注入、检索同口径，allowCrossWorkspace 不放宽这一路
    const gated = uniqueIds
      ? gateRecords((await Promise.all(uniqueIds.map(id => deps.store.get(id, { workspacePath: context.workspacePath }))))
          .filter((r): r is MemoryRecord => r !== undefined && r.status !== 'deleted'), context, args.allowCrossWorkspace)
      : { allowed: await deps.store.query({ scope: { kind: 'visible', workspacePath: context.workspacePath }, status: ['active'] }), rejected: [], otherWorkspaces: [] }
    const { allowed: records, rejected, otherWorkspaces } = gated
    const snap = await deps.snapshots.capture({
      operation: 'manual',
      description: args.description ?? `手动快照（${records.length} 条）`,
      records,
    }, now)
    // 未找到或已删除的 id 不能悄悄丢掉——否则用户以为安全网覆盖了全部请求的记忆，
    // 实际只存了一部分
    const handledIds = new Set([...records.map(r => r.id), ...rejected.map(r => r.id)])
    const missing = (uniqueIds ?? []).filter(id => !handledIds.has(id))
    const missingNote = missing.length > 0 ? `；未找到或已删除：${missing.join('、')}` : ''
    return {
      kind: 'created', snapshotId: snap.id, count: records.length, missing, rejected, otherWorkspaces,
      message: `已创建快照 ${snap.id}（${records.length} 条记忆），14 天内可恢复${missingNote}。${crossWorkspaceNote(rejected, otherWorkspaces)}`,
    }
  }

  if (args.action === 'list') {
    // 跨 workspace 门：只列含可见记录（global + 当前 workspace）的快照，条数按可见记录算；全是其他项目记录的快照
    // 连描述也不露。按快照里记录自己的位置判定，不逐条读现状；带参数时照旧全列
    const snapshots = (await deps.snapshots.list())
      .map(s => ({
        id: s.id, createdAt: s.createdAt, operation: s.operation, description: s.description,
        count: args.allowCrossWorkspace === true ? s.memoryIds.length : s.data.filter(r => isVisible(r, context)).length,
      }))
      .filter(s => args.allowCrossWorkspace === true || s.count > 0)
    return {
      kind: 'listed', snapshots,
      message: snapshots.length === 0
        ? '当前没有快照（保留窗口 14 天）。'
        : `共 ${snapshots.length} 个快照：\n${snapshots.map(s => `- ${s.id} [${s.operation}] ${s.description}（${s.count} 条）`).join('\n')}`,
    }
  }

  const snap = await deps.snapshots.get(args.snapshotId)
  if (!snap) {
    return { kind: 'error', message: `快照不存在：${args.snapshotId}（可能已超过 14 天保留窗口）` }
  }
  // show / restore 的预读范围：快照内每个记录的现状，按该记录自己的 workspace 定位（含非 active）——restore 的 put 按同一
  // 提示定位，冲突判断看的就是将被覆盖的那份文件；按会话 workspace 定位会在同 id 多副本时比错对象。
  const exact = options.isExactLayer === true ? { isExactLayer: true } : {}
  const current = new Map<string, MemoryRecord>()
  for (const { id, workspacePath } of snap.data) {
    const r = await deps.store.get(id, { workspacePath, ...exact })
    if (r) current.set(id, r)
  }
  // 跨 workspace 门：快照里的记录与它的现状任一方落在其他项目，就按那个项目判定（restore 写回快照里的位置）
  const targets = args.action === 'restore' && args.memoryIds ? snap.data.filter(r => args.memoryIds!.includes(r.id)) : snap.data
  const { allowed, rejected, otherWorkspaces } = gateRecords(targets.map(r => {
    const present = current.get(r.id)
    return present !== undefined && !isVisible(present, context) ? present : r
  }), context, args.allowCrossWorkspace)
  const allowedIds = new Set(allowed.map(r => r.id))
  const wsNote = crossWorkspaceNote(rejected, otherWorkspaces)

  if (args.action === 'show') {
    // 结果会进模型上下文：快照内与现状两份都按注入的口径遮明确密钥（手工编辑或恢复的归档副本可能带着）
    const entries = deps.snapshots.diff(snap, current).filter(e => allowedIds.has(e.id)).map(e => ({
      ...e, snapshotted: maskSecretSurface(e.snapshotted), current: e.current && maskSecretSurface(e.current),
    }))
    const lines = entries.map(e => {
      const state = e.snapshotted.redacted ? '含密钥已物理删除（快照内为脱敏副本，不可恢复）'
        : e.current === undefined ? '当前不存在（已删）'
        : e.current.status === 'deleted' ? '当前已软删'
        : e.changedAfterSnapshot ? '快照后被修改过 ⚠️' : '与快照一致或未变'
      return `- ${e.id}：${state}｜快照内容：${e.snapshotted.summary}`
    })
    return { kind: 'shown', entries, rejected, otherWorkspaces, message: `快照 ${snap.id}（${snap.description}）：\n${lines.join('\n')}${wsNote}` }
  }

  // restore
  const { restored, skipped, redacted } = await deps.snapshots.restore(
    snap, [...allowedIds],
    (r, skipIf) => deps.store.put(r, options.isExactLayer === true ? { workspacePath: r.workspacePath, isExactLayer: true } : undefined, skipIf),
    current,
    options.overwriteIf ?? args.overwriteChanged ?? false,
    // 撤回只删刚写回的那一份（快照里这条记录自己的那一层），别层同 id 的副本不是这次恢复写的
    r => deps.store.hardDelete(r, { isExactLayer: true }),
    () => deps.now?.() ?? Date.now(),
  )
  const changedCount = skipped.length - redacted.length
  const skippedNote = changedCount > 0
    ? `；${changedCount} 条因快照后被修改而跳过（确认覆盖请带 overwriteChanged: true）`
    : ''
  const redactedNote = redacted.length > 0
    ? `；${redacted.length} 条因含密钥已物理删除而跳过（${redacted.join('、')}），快照里只剩脱敏副本，不可恢复`
    : ''
  return {
    kind: 'restored', restored, skipped, redacted, rejected, otherWorkspaces,
    message: `已恢复 ${restored.length} 条记忆（${restored.join('、')}）${skippedNote}${redactedNote}。${wsNote}`,
  }
}
