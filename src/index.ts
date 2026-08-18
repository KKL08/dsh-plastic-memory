import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import type { AssembleContext } from '@deepseek-ai/dsh-system-prompt'
import type { MemoryTypeDefinition } from './types.ts'
import { buildTypeRegistry } from './type-registry.ts'
import { memoryDomainSpec } from './domain-spec.ts'
import { MemoryStore, type MemoryTable } from './store.ts'
import { createSaveTool } from './tools/save-tool.ts'
import { createSearchTool } from './tools/search-tool.ts'
import { createForgetTool } from './tools/forget-tool.ts'
import { SnapshotCache, resolveWorkspacePath } from './runtime.ts'

export interface Config {
  writeMode: 'proactive' | 'reflective'
  reflectModel: string | null
  reflectIdleMinutes: number
  approval: 'auto' | 'always' | 'by-type'
  approvalTypes: string[]
  snapshotTokenBudget: number
  template: 'coding' | 'office' | 'custom'
  customTypes: Record<string, Omit<MemoryTypeDefinition, 'name'>>
  governance: { enabled: boolean; onWrite: boolean }
}

export const Config: z<Config> = z.object({
  writeMode: z.union(['proactive', 'reflective'] as const).default('proactive'),
  reflectModel: z.union([z.string(), z.const(null)]).default(null),
  reflectIdleMinutes: z.number().default(30),
  approval: z.union(['auto', 'always', 'by-type'] as const).default('auto'),
  approvalTypes: z.array(z.string()).default([]),
  snapshotTokenBudget: z.number().default(4000),
  template: z.union(['coding', 'office', 'custom'] as const).default('coding'),
  customTypes: z.dict(z.object({
    label: z.string().required(),
    description: z.string().required(),
    recall: z.union(['core', 'search', 'passive'] as const).required(),
    decayDays: z.union([z.number(), z.const(null)]).default(null),
    governancePriority: z.union(['high', 'medium', 'low'] as const).required(),
  })).default({}),
  governance: z.object({
    enabled: z.boolean().default(true),
    onWrite: z.boolean().default(true),
  }),
})

export const name = 'dsh-plastic-memory'
export const inject = ['tools', 'systemPrompt', 'storageDomain']

/** session/created 回调里用得到的最小 session 结构（真实类型是 dsh-session 的 Session）。 */
type SessionLike = object & { header?: { cwd?: string } }

export async function apply(ctx: Context, config: Config) {
  const registry = buildTypeRegistry(config) // 重名内置类型在这里抛错，加载即失败
  if (config.approval !== 'auto') {
    console.warn('[plastic-memory] P0 只支持 approval=auto，其余取值按 auto 处理')
  }
  if (config.writeMode === 'reflective') {
    console.warn('[plastic-memory] reflective 写入模式尚未实现（P1），当前按 proactive 运行')
  }

  const domain = await ctx.storageDomain.open(memoryDomainSpec)
  ctx.effect(() => () => void domain.close())
  const store = new MemoryStore(domain.table('memories') as unknown as MemoryTable)
  const snapshotCache = new SnapshotCache({ store, registry, budget: config.snapshotTokenBudget })

  // 工具执行上下文：从 exec.agent.session 取 session 与 workspace（session.log 私有，用 events）
  async function resolveContext(exec: unknown) {
    const agent = (exec as { agent?: { session?: { header?: { id?: string; cwd?: string }; events?: unknown[] } } }).agent
    const session = agent?.session
    return {
      workspacePath: await resolveWorkspacePath(ctx, session?.header?.cwd),
      session: {
        id: session?.header?.id ?? 'unknown',
        lastSeq: Math.max((session?.events?.length ?? 1) - 1, 0),
      },
    }
  }

  ctx.tools.register(createSaveTool({ store, registry, resolveContext }))
  ctx.tools.register(createSearchTool({ store, registry, resolveContext }))
  ctx.tools.register(createForgetTool({ store }))

  // frozen snapshot：按 session 隔离缓存，session/created 异步解析 workspace，compaction 结束失效重建。
  // session/* 事件由常驻的 @deepseek-ai/dsh-session 提供，但其 cordis Events 增广不在本插件的
  // 类型图内（该包非直接依赖），故按最小结构签名订阅；运行时事件名只是字符串，行为不受影响。
  const lifecycle = ctx as unknown as {
    on(name: 'session/created', fn: (session: SessionLike) => void): () => void
    on(name: 'session/event', fn: (session: object, event: { type: string }) => void): () => void
  }
  lifecycle.on('session/created', session => {
    void resolveWorkspacePath(ctx, session.header?.cwd)
      .then(path => snapshotCache.setWorkspacePath(session, path))
      .catch(() => snapshotCache.setWorkspacePath(session, undefined))
  })
  lifecycle.on('session/event', (session, event) => {
    if (event.type === 'compaction/end') snapshotCache.invalidate(session)
  })
  ctx.systemPrompt.context({
    name: 'plastic-memory',
    order: 50,
    // AssembleContext.scope 是发起组装的 Agent，从它拿到所属 session，按 session 渲染各自的冻结快照
    text: (assembleCtx?: AssembleContext) => {
      const session = (assembleCtx?.scope as { session?: object } | undefined)?.session
      return session ? snapshotCache.render(session) : ''
    },
  })
}
