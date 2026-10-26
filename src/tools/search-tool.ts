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
    description: [
      '查长期记忆用这个工具：想知道某件事有没有记过、记的是什么，或按 id 取一条。',
      '范围是本项目和全局记忆。结果按相关性排好，密钥已遮盖，每条带出处、是否陈旧和记忆文件的绝对路径，要看原文就直接读这个文件。代码和项目文件用 grep 搜；记忆目录不要用 grep 搜：那里还存着已删除和其他项目的记忆，grep 的结果也不排序，所以找记忆统一用这个工具。',
      '怎么写关键词：',
      '- 写 2 到 4 个实词。版本号、路径这类原样文字可以直接搜。',
      '- 优先用开头记忆索引里出现过的说法；用户的说法和索引对不上时，把用户原话的词和你推测的记忆写法一起带上。',
      '- 术语的中英两种写法都带上。',
      '',
      '怎么读结果：',
      '- 同时命中全部关键词的排在最前，其次是命中部分关键词的，最后是关键词只以子串出现的。',
      '- 开头只说没有记忆同时含全部关键词、没提示命中弱时，排第一的那条含了查询的大部分内容。',
      '- 开头提示命中弱时会列出各关键词命中几条：先换掉一条都没命中的词，或换同义词、减少词数、换个角度再搜一次。结果不像要找的内容时也这样做。',
      '- 开头说明共命中多少条、返回不全时：要更全就调大 limit，太杂就换更具体的关键词。',
    ].join('\n'),
    parameters: {
      query: { type: 'string', required: true, description: '关键词，中英文均可，2 到 4 个实词、空格分隔；对名称、摘要、标签、内容匹配。没有记录命中全部关键词时结果开头会说明；排第一的也只含其中一部分、或只有子串命中时还会提示命中弱，建议换词再搜一次，并列出各关键词命中几条' },
      types: { type: 'array', items: { type: 'string' } },
      scope: { type: 'string', enum: ['global', 'workspace', 'all-visible'], description: '缺省 all-visible（global + 当前 workspace）' },
      limit: { type: 'number', description: '返回条数上限，缺省 10，最大 50；命中更多时结果开头会说明总数' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: renderSearchResult(value as unknown as { hits: SearchHit[]; note?: string; moreNote?: string }) }],
    },
    execute: async (args, exec) => toToolOutput(await executeSearch(args, exec, deps)),
  })
}
