import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { executeForget, type ForgetResult, type ForgetToolDeps } from './forget.ts'

/**
 * 把 memory_forget 工具接到 dsh 框架上。顶层 import defineTool，运行时无法在
 * 本地测试环境加载（dsh peer 依赖未装），所以测试只测 forget.ts 的纯逻辑；
 * 本文件的正确性由 typecheck 保证，真机接线见 docs/p1-verification.md。
 */
export function createForgetTool(deps: ForgetToolDeps): ToolDefinition {
  return defineTool({
    name: 'memory_forget',
    description: '把一条或多条记忆标记为已删除（软删除，不再注入和检索）。删除前自动快照，14 天内可恢复。用户明确要求遗忘、或确认记忆已错误/过期时使用；批量清理时一次传入全部 id。',
    parameters: {
      ids: { type: 'array', items: { type: 'string' }, required: true, description: '要遗忘的记忆 id 列表，单条也用数组' },
      reason: { type: 'string', required: true, description: '为何遗忘' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: (value as ForgetResult).message }],
    },
    execute: (args) => executeForget(args, deps) as never,
  })
}
