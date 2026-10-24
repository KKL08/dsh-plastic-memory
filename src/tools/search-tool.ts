import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { executeSearch, renderSearchResult, type SearchHit, type SearchToolDeps } from './search.ts'
import { toToolOutput } from './output.ts'

/**
 * 把 memory_search 工具接到 dsh 框架上。纯逻辑在 search.ts，不依赖框架包，测试直接测它；
 * 本文件由 typecheck + 真机验证保证。
 */
export function createSearchTool(deps: SearchToolDeps): ToolDefinition {
  return defineTool({
    name: 'memory_search',
    description: '按相关性检索长期记忆，中英文查询都可用。同时命中全部关键词的排在前面，其次是命中部分关键词的，最后是关键词只以子串出现的；每条命中带记忆文件的绝对路径。',
    parameters: {
      query: { type: 'string', required: true, description: '关键词，中英文均可，可写多个词；对名称、摘要、标签、内容匹配。没有记录命中全部关键词、或只有子串命中时，结果开头会说明' },
      types: { type: 'array', items: { type: 'string' } },
      scope: { type: 'string', enum: ['global', 'workspace', 'all-visible'], description: '缺省 all-visible（global + 当前 workspace）' },
      limit: { type: 'number', description: '返回条数上限，缺省 10，最大 50' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: renderSearchResult(value as unknown as { hits: SearchHit[]; note?: string }) }],
    },
    execute: async (args, exec) => toToolOutput(await executeSearch(args, exec, deps)),
  })
}
