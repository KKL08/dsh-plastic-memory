import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { executeHealth, renderHealthResult, type HealthToolDeps, type HealthToolResult } from './health.ts'

/**
 * 把 memory_health 接到 dsh 框架上。测试只测 health.ts 纯逻辑，
 * 本文件由 typecheck + 真机冒烟保证（docs/p1-verification.md）。
 */
export function createHealthTool(deps: HealthToolDeps): ToolDefinition {
  return defineTool({
    name: 'memory_health',
    description: '查看记忆库健康分（0-100，绿/琥珀/红三档）。纯读取零成本：规则层实时算，语义层用上次 memory_scan 的缓存，另含新鲜度轴与待决冲突提醒。用户问记忆状况、或长时间未治理时调用。',
    parameters: {
      scope: { type: 'string', description: '限定某个 workspace 路径，不填看全库' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: renderHealthResult(value as HealthToolResult) }],
    },
    execute: (args) => executeHealth(args, deps) as never,
  })
}
