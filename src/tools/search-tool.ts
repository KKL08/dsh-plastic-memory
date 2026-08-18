import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { executeSearch, renderSearchResult, type SearchHit, type SearchToolDeps } from './search.ts'

/**
 * 把 memory_search 工具接到 dsh 框架上。顶层 import defineTool，运行时无法在
 * 本地测试环境加载（dsh peer 依赖未装），所以测试只测 search.ts 的纯逻辑；
 * 本文件的正确性由 typecheck 保证，真机接线留到 Task 10 验证。
 */
export function createSearchTool(deps: SearchToolDeps): ToolDefinition {
  return defineTool({
    name: 'memory_search',
    description: '按关键词检索长期记忆。索引里列出的记忆想看全文、或怀疑有相关记忆没列出时用。',
    parameters: {
      query: { type: 'string', required: true, description: '关键词，对内容、摘要、标签匹配' },
      types: { type: 'array', items: { type: 'string' } },
      scope: { type: 'string', enum: ['global', 'workspace', 'all-visible'], description: '缺省 all-visible（global + 当前 workspace）' },
      limit: { type: 'number', description: '返回条数上限，缺省 10，最大 50' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: renderSearchResult((value as { hits: SearchHit[] }).hits) }],
    },
    execute: (args, exec) => executeSearch(args, exec, deps) as never,
  })
}
