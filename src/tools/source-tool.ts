import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { executeSource, renderSourceResult, type SourceToolDeps, type SourceResult } from './source.ts'
import { toToolOutput } from './output.ts'
import type { ContextHost } from './host-session.ts'

export interface SourceToolBindingDeps extends SourceToolDeps {
  host: SourceToolDeps['host'] & ContextHost<Parameters<typeof executeSource>[1]>
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
      '回查一条长期记忆的全部出处，可选择出处、前后翻页、按关键词找、带上工具调用和结果、追溯父子会话。',
      '只读，只能回查当前项目和全局记忆；原始会话已不可读时会明确告知。',
      '也能按原话检索结果里给的消息引用看那条消息的完整内容和前后各一轮。',
    ].join(''),
    parameters: {
      messageRef: { type: 'string', description: '原话检索结果里给的消息引用' },
      memoryId: { type: 'string', description: '要回查的记忆 id（快照/搜索结果里的 mem_ 开头 id）' },
      anchor: { type: 'number', description: '出处清单中的编号，从 1 起，缺省 1（最新的）' },
      mode: { type: 'string', enum: ['window', 'page', 'find'], description: 'window 围绕出处开窗（缺省），page 接着翻，find 按关键词找' },
      cursor: { type: 'string', description: '上次返回的 before:<seq> 或 after:<seq>，find 只支持 after' },
      query: { type: 'string', description: 'find 的关键词，去首尾空白后 1–200 个字符' },
      include: { type: 'string', enum: ['text', 'all'], description: 'text 只读对话文字（缺省），all 带上工具调用和结果' },
      hop: { type: 'string', enum: ['parent', 'child'], description: 'parent 读父会话委派前后，child 读子会话原始过程' },
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
