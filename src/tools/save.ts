import type { MemoryStore } from '../store.ts'
import type { TypeRegistry } from '../type-registry.ts'
import { runSavePipeline, type PipelineResult, type SaveCandidate } from '../pipeline.ts'

/** memory_save 运行时需要的会话上下文，由框架绑定层的 resolveContext 提供。 */
export interface SaveContext {
  workspacePath: string | undefined
  session: { id: string; lastSeq: number }
}

/** memory_save 工具的依赖，纯逻辑层与框架绑定层共用。 */
export interface SaveToolDeps {
  store: MemoryStore
  registry: TypeRegistry
  resolveContext(exec: unknown): Promise<SaveContext>
}

/** 把管线结果渲染成给模型看的一段文本。纯函数。 */
export function renderSaveResult(result: PipelineResult): string {
  switch (result.kind) {
    case 'saved':
      return `已保存记忆 ${result.record.id}（${result.record.type}，${result.record.scope}），下个会话生效。`
    case 'updated':
      return `已更新记忆 ${result.record.id}。`
    case 'duplicate-suspected':
      return `这个主题可能已有记忆：\n${result.existing.map(e => `- ${e.id}：${e.summary}`).join('\n')}\n如需修改已有记忆，用 action=update 和对应 id 重发；确认是新信息就加 force=true 重发。`
    case 'rejected':
      return `未保存：${result.reason}`
  }
}

/**
 * memory_save 工具的真正执行逻辑：解析上下文、归一化候选、跑写入管线。
 * 不依赖任何 dsh 框架包，测试直接调它。
 */
export async function executeSave(
  rawArgs: unknown,
  exec: unknown,
  deps: SaveToolDeps,
): Promise<PipelineResult> {
  const context = await deps.resolveContext(exec)
  const raw = rawArgs as SaveCandidate & { tags?: string[] }
  const candidate: SaveCandidate = { ...raw, tags: raw.tags ?? [] } // 可选参数归一化
  return runSavePipeline(candidate, {
    store: deps.store,
    registry: deps.registry,
    workspacePath: candidate.scope === 'workspace' ? context.workspacePath : undefined,
    session: context.session,
  })
}
