import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { executeSource, renderSourceResult, type SourceToolDeps, type SourceResult } from './source.ts'
import { toToolOutput } from './output.ts'
import type { ContextHost } from './host-session.ts'

export interface SourceToolBindingDeps extends SourceToolDeps {
  host: ContextHost<Parameters<typeof executeSource>[1]>
}

/**
 * memory_source 绑定：回查某条记忆的原始出处窗口。
 * 何时该调由注入快照里的档位文案（EVIDENCE_GUIDANCE）引导，工具描述只说能力不说姿态——
 * 姿态归档位管，写进描述会让 off 档的"不鼓励"失效。
 */
export function createSourceTool(deps: SourceToolBindingDeps): ToolDefinition {
  return defineTool({
    name: 'memory_source',
    description: [
      '回查一条长期记忆的原始出处：读取产生这条记忆的会话轨迹片段（当时的对话原文）。',
      '用于核对记忆的来源语境，例如记忆之间矛盾、或治理裁决前想看当时用户怎么说的。',
      '只读，只能回查当前项目和全局记忆；原始会话已不可读时会明确告知。',
    ].join(''),
    parameters: {
      memoryId: { type: 'string', required: true, description: '要回查的记忆 id（快照/搜索结果里的 mem_ 开头 id）' },
      window: { type: 'number', description: '读取的事件条数，缺省覆盖记忆产生的当轮对话，上限 24' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: renderSourceResult(value as unknown as SourceResult) }],
    },
    execute: async (args, exec) => {
      const context = await deps.host.contextOf(exec)
      return toToolOutput(await executeSource(args, context, deps))
    },
  })
}
