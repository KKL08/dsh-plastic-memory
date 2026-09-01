import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { executeHealth, renderHealthResult, type HealthToolDeps, type HealthToolResult } from './health.ts'

/** 把 memory_health 接到 dsh 框架上。测试只测 health.ts 纯逻辑，本文件由 typecheck 保证。 */
export function createHealthTool(deps: HealthToolDeps): ToolDefinition {
  return defineTool({
    name: 'memory_health',
    description: '查看记忆库健康分（0-100，绿/黄/红三档；检出密钥直接红线判定）。纯读取零成本：'
      + '规则层实时算，语义层用上次 memory_scan 的缓存（按 scope 分桶），另含新鲜度轴与待决冲突提醒。'
      + '默认看当前项目（分母是本项目自身规模）；scope="all" 输出各 workspace 分数表 + global 层，'
      + '免 LLM 调用、无需向用户确认。用户问记忆状况、或长时间未治理时调用。',
    parameters: {
      scope: { type: 'string', description: '缺省=当前 workspace；"all"=全库分层体检表；也可传 workspace 的绝对路径（项目目录路径，记忆存储目录名不是合法值）' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: renderHealthResult(value as HealthToolResult) }],
    },
    execute: (args, exec) => executeHealth(args, deps, exec),
  })
}
