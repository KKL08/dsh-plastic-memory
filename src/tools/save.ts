import type { MemoryStore } from '../store.ts'
import type { TypeRegistry } from '../type-registry.ts'
import type { SnapshotStore } from '../governance/snapshots.ts'
import { runSavePipeline, type PipelineResult, type SaveCandidate } from '../pipeline.ts'

/** memory_save 运行时需要的会话上下文，由框架绑定层的 resolveContext 提供。 */
export interface SaveContext {
  workspacePath: string | undefined
  /** turnStartSeq 是证据锚的起点（当轮 turn/start 的 seq）；缺省时管线回退整会话锚。 */
  session: { id: string; lastSeq: number; turnStartSeq?: number }
}

/** memory_save 的入参：schema 里 tags 可选，落库前归一化成 SaveCandidate（tags 必填）。 */
export type SaveArgs = Omit<SaveCandidate, 'tags'> & { tags?: string[] }

/** memory_save 工具的依赖，纯逻辑层与框架绑定层共用。 */
export interface SaveToolDeps {
  store: MemoryStore
  registry: TypeRegistry
  resolveContext(exec: unknown): Promise<SaveContext>
  /** update global 目标前拍快照用（快照先行）；生产接线传入已有实例，测试可缺省。 */
  snapshots?: SnapshotStore
}

/** 把管线结果渲染成给模型看的一段文本。纯函数。 */
export function renderSaveResult(result: PipelineResult): string {
  let text: string
  switch (result.kind) {
    case 'saved':
      text = `已保存记忆 ${result.record.id}（${result.record.type}，${result.record.scope}）。下个会话注入；本会话若触发上下文压缩，压缩后即生效。`
      break
    case 'updated':
      text = `已更新记忆 ${result.record.id}。`
      break
    case 'duplicate-suspected':
      text = `这个主题可能已有记忆：\n${result.existing.map(e => `- ${e.id}：${e.summary}`).join('\n')}\n如需修改已有记忆，用 action=update 和对应 id 重发；确认是新信息就加 force=true 重发。`
      break
    case 'rejected':
      text = `未保存：${result.reason}`
      break
  }

  // 渲染警告行
  if ((result.kind === 'saved' || result.kind === 'updated') && result.warnings) {
    const warnings = result.warnings.map(w => `⚠️ ${w.text}`).join('\n')
    text = `${text}\n${warnings}`
  }

  return text
}

/**
 * memory_save 工具的真正执行逻辑：解析上下文、归一化候选、跑写入管线。
 * 不依赖任何 dsh 框架包，测试直接调它。
 */
export async function executeSave(
  args: SaveArgs,
  exec: unknown,
  deps: SaveToolDeps,
): Promise<PipelineResult> {
  const context = await deps.resolveContext(exec)
  const candidate: SaveCandidate = { ...args, tags: args.tags ?? [] } // 可选参数归一化
  return runSavePipeline(candidate, {
    store: deps.store,
    registry: deps.registry,
    // 无条件传真实 workspace 上下文：pipeline 要靠它判断 global 是否降级为候选（scope=global 时
    // 也需要知道当前有没有 workspace 桶）。global 记忆最终不带 workspacePath 由 pipeline 组装时归 undefined。
    workspacePath: context.workspacePath,
    session: context.session,
    snapshots: deps.snapshots,
  })
}
