import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { executeForget, type ForgetResult, type ForgetToolDeps } from './forget.ts'
import { toToolOutput } from './output.ts'
import { ALLOW_CROSS_WORKSPACE_PARAM, type GovernanceContext } from './workspace-gate.ts'

export interface ForgetToolBindingDeps extends ForgetToolDeps {
  resolveContext: (exec: ToolRunContext) => Promise<GovernanceContext>
}

/**
 * 把 memory_forget 工具接到 dsh 框架上。纯逻辑在 forget.ts，不依赖框架包，测试直接测它；
 * 本文件由 typecheck + 真机验证保证。
 */
export function createForgetTool(deps: ForgetToolBindingDeps): ToolDefinition {
  return defineTool({
    name: 'memory_forget',
    description: '把一条或多条记忆标记为已删除（软删除，不再注入和检索）。删除前自动快照，14 天内可恢复。含密钥的记忆例外：立即物理删除，不进 14 天回收、不可恢复，所有快照里的副本一并脱敏。用户明确要求遗忘、或确认记忆已错误/过期时使用；批量清理时一次传入全部 id。',
    parameters: {
      ids: { type: 'array', items: { type: 'string' }, required: true, description: '要遗忘的记忆 id 列表，单条也用数组' },
      reason: { type: 'string', required: true, description: '为何遗忘' },
      allowCrossWorkspace: ALLOW_CROSS_WORKSPACE_PARAM,
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: (value as unknown as ForgetResult).message }],
    },
    execute: async (args, exec) => toToolOutput(await executeForget(args, await deps.resolveContext(exec), deps)),
  })
}
