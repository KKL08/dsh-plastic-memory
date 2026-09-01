import type { MemoryStore } from '../store.ts'
import type { AgentsMdWriter } from '../storage/agents-md.ts'
import type { SnapshotStore } from '../governance/snapshots.ts'
import type { MemoryRecord } from '../record-schema.ts'
import type { MemorySnapshot } from '../governance/schema.ts'

export type PromoteTarget = 'global' | 'agents-md'

export interface PromoteDeps {
  store: MemoryStore
  agentsMd: AgentsMdWriter
  snapshots: SnapshotStore
  now?: () => number
}

export interface PromoteResult {
  promoted: Array<{ id: string; target: PromoteTarget }>
  dismissed: string[]
  skipped: string[]
  message: string
}

/**
 * memory_promote 纯逻辑：把已确认的候选记忆提升到 global 或写入 AGENTS.md。
 * confirmedIds 是用户已确认的 id 列表——确认由模型先调 ask_user_question 完成
 * （工具内部弹窗会被 web 会话拒绝，见 promote-tool.ts），纯逻辑不弹窗，便于测。
 * - target=global：scope 改 global（FileTable persist 检测目录变化自动搬家），清除候选标记。
 * - target=agents-md：内容写进 ~/.dsh/AGENTS.md 专属区块，原项目记忆软删（已脱离插件治理，避免重复）。
 * - dismiss=true：用户明确不想提升，只清除候选标记、记忆留在项目内，忽略 target。
 */
export async function executePromote(
  args: { confirmedIds: string[]; target: PromoteTarget; dismiss?: boolean },
  deps: PromoteDeps,
): Promise<PromoteResult> {
  const now = deps.now?.() ?? Date.now()
  const promoted: PromoteResult['promoted'] = []
  const skipped: string[] = []

  // dismiss：用户表态不提升，清除候选标记即可。清标记可逆（模型可经 update 重新标记），故不拍快照、
  // 不写 AGENTS.md、不搬目录。updatedAt 不动——这不是内容编辑，改了会让快照把记忆误判为"快照后被
  // 编辑过"而拒绝恢复（对齐 confirm refresh 的同款理由）；put 语义保留召回统计。
  if (args.dismiss) {
    const dismissed: string[] = []
    for (const id of args.confirmedIds) {
      const r = deps.store.get(id)
      if (!r || r.status === 'deleted') { skipped.push(id); continue }
      // 无损 JSON 不变式：解构剔键而非置 undefined。
      const { globalCandidate, ...rest } = r
      await deps.store.put(rest)
      dismissed.push(id)
    }
    const skipNote = skipped.length > 0 ? `（${skipped.length} 条不存在或已删除，见 skipped）` : ''
    return {
      promoted: [], dismissed, skipped,
      message: `已清除 ${dismissed.length} 条提升候选标记，这些记忆保留在项目内，之后不再提示提升。${skipNote}`,
    }
  }

  // 缺失/已删的先剔除计 skipped，不进快照；剩下的才是本次实际提升的目标。
  const found: MemoryRecord[] = []
  for (const id of args.confirmedIds) {
    const r = deps.store.get(id)
    if (!r || r.status === 'deleted') { skipped.push(id); continue }
    found.push(r)
  }

  // 快照先行（对齐 forget/confirm）：global 分支搬家、agents-md 分支软删，都在改动前对整批目标
  // 拍一次快照——否则 agents-md 软删后 14 天 sweep 就不可恢复。无目标时不拍。
  let snapshot: MemorySnapshot | undefined
  if (found.length > 0) {
    snapshot = await deps.snapshots.capture({
      operation: 'pre-promote',
      description: `提升 ${found.length} 条记忆到 ${args.target} 前`,
      records: found,
    }, now)
  }

  for (const r of found) {
    if (args.target === 'global') {
      // 无损 JSON 不变式：不能把 workspacePath/globalCandidate 置为 undefined 键，解构剔键。
      const { workspacePath, globalCandidate, ...rest } = r
      await deps.store.put({ ...rest, scope: 'global' })
    } else {
      // 两步无法原子：先软删再写 AGENTS.md，append 失败回滚软删——失败方向宁可"没提升"
      // 也不能"两处并存"（原顺序 append 成功+softDelete 失败会双份注入且结果谎报 promoted）。
      await deps.store.softDelete(r.id)
      try {
        await deps.agentsMd.append(`${r.name} — ${r.content}`)
      } catch {
        await deps.store.put(r)
        skipped.push(r.id)
        continue
      }
    }
    promoted.push({ id: r.id, target: args.target })
  }

  const snapNote = snapshot ? ` 已自动快照（${snapshot.id}），14 天内可用 memory_snapshot 恢复。` : ''
  const message = promoted.length === 0
    ? '没有记忆被提升（目标已删除、不存在，或写入失败，见 skipped）。'
    : args.target === 'global'
      ? `已提升 ${promoted.length} 条记忆到全局（插件 global 记忆）。${snapNote}`
      : `已写入 ${promoted.length} 条记忆到 ~/.dsh/AGENTS.md，原项目记忆已归档软删。${snapNote}`
  return { promoted, dismissed: [], skipped, message }
}
