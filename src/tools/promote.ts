import type { MemoryStore } from '../store.ts'
import type { AgentsMdWriter } from '../storage/agents-md.ts'

export type PromoteTarget = 'global' | 'agents-md'

export interface PromoteDeps {
  store: MemoryStore
  agentsMd: AgentsMdWriter
}

export interface PromoteResult {
  promoted: Array<{ id: string; target: PromoteTarget }>
  skipped: string[]
  message: string
}

/**
 * memory_promote 纯逻辑：把已确认的候选记忆提升到 global 或写入 AGENTS.md。
 * confirmedIds 由绑定层经 ctx.userQuestions.ask() 用户确认后传入——纯逻辑不弹窗，便于测。
 * - target=global：scope 改 global（FileTable persist 检测目录变化自动搬家），清除候选标记。
 * - target=agents-md：内容写进 ~/.dsh/AGENTS.md 专属区块，原项目记忆软删（已脱离插件治理，避免重复）。
 */
export async function executePromote(
  args: { confirmedIds: string[]; target: PromoteTarget },
  deps: PromoteDeps,
): Promise<PromoteResult> {
  const promoted: PromoteResult['promoted'] = []
  const skipped: string[] = []
  for (const id of args.confirmedIds) {
    const r = deps.store.get(id)
    if (!r || r.status === 'deleted') { skipped.push(id); continue }
    if (args.target === 'global') {
      await deps.store.put({ ...r, scope: 'global', workspacePath: undefined, globalCandidate: undefined })
    } else {
      // 两步无法原子：先软删再写 AGENTS.md，append 失败回滚软删——失败方向宁可"没提升"
      // 也不能"两处并存"（原顺序 append 成功+softDelete 失败会双份注入且结果谎报 promoted）。
      await deps.store.softDelete(r.id)
      try {
        await deps.agentsMd.append(`${r.name} — ${r.content}`)
      } catch {
        await deps.store.put(r)
        skipped.push(id)
        continue
      }
    }
    promoted.push({ id, target: args.target })
  }
  const message = promoted.length === 0
    ? '没有可提升的记忆（都已删除或不存在）。'
    : args.target === 'global'
      ? `已提升 ${promoted.length} 条记忆到全局（插件 global 记忆）。`
      : `已写入 ${promoted.length} 条记忆到 ~/.dsh/AGENTS.md，原项目记忆已归档软删。`
  return { promoted, skipped, message }
}
