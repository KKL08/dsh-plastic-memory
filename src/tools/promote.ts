import type { MemoryStore } from '../store.ts'
import type { AgentsMdWriter } from '../storage/agents-md.ts'
import type { SnapshotStore } from '../governance/snapshots.ts'
import type { MemoryRecord } from '../record-schema.ts'
import type { MemorySnapshot } from '../governance/schema.ts'
import { hasSecret } from '../secrets.ts'
import { crossWorkspaceNote, gateRecords, type CrossWorkspaceRejection, type GovernanceContext, type OtherWorkspaceMark } from './workspace-gate.ts'

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
  /** 属于其他项目、因未带 allowCrossWorkspace 被拒的记录。 */
  rejected: CrossWorkspaceRejection[]
  /** 带参数放行、属于其他项目的记录。 */
  otherWorkspaces: OtherWorkspaceMark[]
  /** 提升前的自动快照；dismiss 或没有目标时为 null。 */
  snapshotId: string | null
  message: string
}

/**
 * memory_promote 纯逻辑：把已确认的候选记忆提升到 global 或写入 AGENTS.md。
 * confirmedIds 是用户已确认的 id 列表——确认由模型先调 ask_user_question 完成
 * （工具内部弹窗会被 web 会话拒绝，见 promote-tool.ts），纯逻辑不弹窗，便于测。
 * - target=global：scope 改 global（FileTable persist 检测目录变化自动搬家），清除候选标记。
 * - target=agents-md：内容写进 ~/.dsh/AGENTS.md 专属区块，原项目记忆软删（已脱离插件治理，避免重复）。
 *   含密钥（critical 或 force 放行的 suspected）的记录拒绝写入，原样留在项目内，计入 skipped。
 * - dismiss=true：用户明确不想提升，只清除候选标记、记忆留在项目内，忽略 target。
 */
export async function executePromote(
  args: { confirmedIds: string[]; target: PromoteTarget; dismiss?: boolean; allowCrossWorkspace?: boolean },
  context: GovernanceContext,
  deps: PromoteDeps,
): Promise<PromoteResult> {
  const now = deps.now?.() ?? Date.now()
  // 预读范围：按 id 逐条两级定位（含非 active，当前 workspace 优先），已删的计入 skipped；
  // 定位到的再过跨 workspace 门，其他项目的记录不带参数时单独列出、不动
  const promoted: PromoteResult['promoted'] = []
  const skipped: string[] = []
  const located: MemoryRecord[] = []
  for (const id of args.confirmedIds) {
    const r = await deps.store.get(id, { workspacePath: context.workspacePath })
    if (!r || r.status === 'deleted') { skipped.push(id); continue }
    located.push(r)
  }
  const { allowed, rejected, otherWorkspaces } = gateRecords(located, context, args.allowCrossWorkspace)
  const wsNote = crossWorkspaceNote(rejected, otherWorkspaces)
  // AGENTS.md 是宿主的全局指令文件，原文进每个项目的每次会话，不遮密钥，也不归插件管（forget 擦不到）；
  // 原记忆进回收站后，留下的只剩这份明文。
  // 两级密钥一视同仁：suspected 是用户确认过才放行保存的，但那份确认只针对本地记忆库，不针对提交进仓库。
  const secretIds = args.dismiss || args.target !== 'agents-md' ? [] : allowed.filter(hasSecret).map(r => r.id)
  const found = secretIds.length === 0 ? allowed : allowed.filter(r => !secretIds.includes(r.id))
  skipped.push(...secretIds)
  const secretNote = secretIds.length > 0 ? `${secretIds.length} 条含密钥的记忆不能写入 AGENTS.md（该文件原文注入所有项目的会话，插件无法遮盖或删除），已原样保留在项目内，见 skipped。` : ''

  // dismiss：用户表态不提升，清除候选标记即可。清标记可逆（模型可经 update 重新标记），故不拍快照、
  // 不写 AGENTS.md、不搬目录。updatedAt 不动——这不是内容编辑，改了会让快照把记忆误判为"快照后被
  // 编辑过"而拒绝恢复（对齐 confirm refresh 的同款理由）；put 语义保留召回统计。
  if (args.dismiss) {
    const dismissed: string[] = []
    for (const r of found) {
      // 无损 JSON 不变式：解构剔键而非置 undefined。读到之后被别处删掉的计入 skipped，同预读时就不在
      if (await deps.store.updateIfLive(r, ({ globalCandidate, ...rest }) => rest)) dismissed.push(r.id)
      else skipped.push(r.id)
    }
    const skipNote = skipped.length > 0 ? `（${skipped.length} 条不存在或已删除，见 skipped）` : ''
    return {
      promoted: [], dismissed, skipped, rejected, otherWorkspaces, snapshotId: null,
      message: `已清除 ${dismissed.length} 条提升候选标记，这些记忆保留在项目内，之后不再提示提升。${skipNote}${wsNote}`,
    }
  }

  // 缺失/已删的已计 skipped、其他项目被拒的已计 rejected，都不进快照；found 才是本次实际提升的目标。
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
      // 按原记录的 workspace 定位：同 id 多副本时搬走的才是门放行的这份，不是 global 或别的项目的副本
      if (!(await deps.store.updateIfLive(r, ({ workspacePath, globalCandidate, ...rest }) => ({ ...rest, scope: 'global' })))) {
        skipped.push(r.id)   // 读到之后被别处删掉
        continue
      }
    } else {
      // 两步无法原子：先软删再写 AGENTS.md，append 失败回滚软删——失败方向宁可"没提升"
      // 也不能"两处并存"（原顺序 append 成功+softDelete 失败会双份注入且结果谎报 promoted）。
      if (!(await deps.store.updateIfLive(r, cur => ({ ...cur, status: 'deleted', updatedAt: Date.now() })))) {
        skipped.push(r.id)   // 读到之后被别处删掉（软删）：不写 AGENTS.md
        continue
      }
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
    ? (secretIds.length > 0 && skipped.length === secretIds.length ? '没有记忆被提升。' : '没有记忆被提升（目标已删除、不存在，或写入失败，见 skipped）。')
    : args.target === 'global'
      ? `已提升 ${promoted.length} 条记忆到全局（插件 global 记忆）。${snapNote}`
      : `已写入 ${promoted.length} 条记忆到 ~/.dsh/AGENTS.md，原项目记忆已归档软删。${snapNote}`
  return { promoted, dismissed: [], skipped, rejected, otherWorkspaces, snapshotId: snapshot?.id ?? null, message: `${message}${secretNote}${wsNote}` }
}
