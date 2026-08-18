import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { executeForget, type ForgetResult, type ForgetToolDeps } from './forget.ts'

/**
 * 把 memory_forget 工具接到 dsh 框架上。顶层 import defineTool，运行时无法在
 * 本地测试环境加载（dsh peer 依赖未装），所以测试只测 forget.ts 的纯逻辑；
 * 本文件的正确性由 typecheck 保证，真机接线留到 Task 10 验证。
 */
export function createForgetTool(deps: ForgetToolDeps): ToolDefinition {
  return defineTool({
    name: 'memory_forget',
    description: '把一条记忆标记为已删除（软删除，不再注入和检索）。用户明确要求遗忘、或确认记忆已错误时使用。',
    parameters: {
      id: { type: 'string', required: true },
      reason: { type: 'string', required: true, description: '为何遗忘' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: (value as ForgetResult).message }],
    },
    execute: (args) => executeForget(args, deps) as never,
  })
}
