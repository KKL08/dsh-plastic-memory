import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { PipelineResult } from '../pipeline.ts'
import { executeSave, renderSaveResult, type SaveToolDeps } from './save.ts'
import { toToolOutput } from './output.ts'

/**
 * 把 memory_save 工具接到 dsh 框架上。纯逻辑在 save.ts，不依赖框架包，测试直接测它；
 * 本文件由 typecheck + 真机验证保证。
 */
export function createSaveTool(deps: SaveToolDeps): ToolDefinition {
  const typeNames = deps.registry.all().map(t => t.name)
  return defineTool({
    name: 'memory_save',
    description: deps.registry.renderSaveDescription(),
    parameters: {
      // dsh 参数 DSL：漏写 required: true 即为可选，必填字段一个都不能漏
      action: { type: 'string', enum: ['create', 'update'], required: true },
      id: { type: 'string', description: 'action=update 时必填，目标记忆 id' },
      name: { type: 'string', required: true, description: '简短标题（2-16 字）' },
      type: { type: 'string', enum: typeNames, required: true },
      scope: { type: 'string', enum: ['global', 'workspace'], required: true },
      content: { type: 'string', required: true, description: '正文。先写事实或规则本身；再用一句交代用户给的理由，或者当时在聊什么（用户没说理由就写情境，不要替用户编理由）。只有不写就会做错的时候，才补一句具体做法。不写使用场景清单和通用注意事项；不写行号、临时路径这类很快过时的细节，改写稳定的位置描述。完整经过可以用 memory_source 回查，不用抄进正文。' },
      summary: { type: 'string', required: true, description: '一句话说清这条记忆讲什么，显示在索引里，供人和模型判断相关不相关；不复述 name，不堆关键词。' },
      tags: { type: 'array', items: { type: 'string' }, description: '只写正文、name、summary 里都没出现、但以后可能被拿来搜它的词：同义词、中英文别名、缩写。不写泛化概念。' },
      sourceMode: { type: 'string', enum: ['user-explicit', 'user-behavior', 'environment-observed', 'agent-inferred', 'agent-action-confirmed'], required: true, description: '信息从哪来，决定置信度上限。user-explicit：用户明说的。agent-action-confirmed：你做的事经用户确认有效，或被采纳。user-behavior：用户反复做出的动作（多次改写、撤销、拒绝同一类做法）；对一次举动揣测动机不算。environment-observed：从文件、命令输出、配置里直接读到的事实。agent-inferred：你自己的推断和解读；只要中间有一步是你推出来的、不是直接看到的，就填它。' },
      confidence: { type: 'number', description: '取值 0–1（0.9=确定，0.5=推测）。越界会被夹到边界、不报错，所以想表达低置信就填小值，别填 0 以上的整数' },
      supersedes: { type: 'array', items: { type: 'string' } },
      validFrom: { type: 'number', description: '生效起始（epoch ms），有明确时效的记忆才填' },
      validTo: { type: 'number', description: '失效截止（epoch ms）' },
      force: { type: 'boolean', description: '跳过结构去重与疑似密钥拦截（用户已确认）' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: renderSaveResult(value as unknown as PipelineResult) }],
    },
    execute: async (args, exec) => toToolOutput(await executeSave(args, exec, deps)),
  })
}
