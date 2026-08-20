import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { PipelineResult } from '../pipeline.ts'
import { executeSave, renderSaveResult, type SaveToolDeps } from './save.ts'

/**
 * 把 memory_save 工具接到 dsh 框架上。顶层 import defineTool，运行时无法在
 * 本地测试环境加载（dsh peer 依赖未装），所以测试只测 save.ts 的纯逻辑；
 * 本文件的正确性由 typecheck 保证，真机接线留到 Task 10 验证。
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
      content: { type: 'string', required: true },
      summary: { type: 'string', required: true, description: '一行摘要，会显示在记忆索引里' },
      tags: { type: 'array', items: { type: 'string' }, description: '检索用关键词——技术名、路径、专有名词，不写泛化概念' },
      sourceMode: { type: 'string', enum: ['user-explicit', 'user-behavior', 'environment-observed', 'agent-inferred', 'agent-action-confirmed'], required: true },
      confidence: { type: 'number' },
      supersedes: { type: 'array', items: { type: 'string' } },
      validFrom: { type: 'number', description: '生效起始（epoch ms），有明确时效的记忆才填' },
      validTo: { type: 'number', description: '失效截止（epoch ms）' },
      force: { type: 'boolean', description: '确认不是重复后重发时置 true' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: renderSaveResult(value as PipelineResult) }],
    },
    execute: (args, exec) => executeSave(args, exec, deps) as never,
  })
}
