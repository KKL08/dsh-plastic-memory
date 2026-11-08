import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { executeSearch, renderSearchResult, type SearchHit, type SearchToolDeps } from './search.ts'
import { toToolOutput } from './output.ts'
import type { TypeRegistry } from '../type-registry.ts'

/**
 * types 的参数说明：固定用法 + 当前场景的类型列表。类型可配置，名字全从类型表读；
 * core 类型说「通常」已带入，是因为严格上限模式下可能被省略。
 */
function describeTypes(registry: TypeRegistry): string {
  const list = registry.all().map(t => t.recall === 'core' ? `${t.name}（${t.label}）：通常已整条带入开头的长期记忆` : `${t.name}（${t.label}）`)
  return [
    '按类型筛选，不填查全部类型。类型名是开头记忆索引分组标题括号里的英文名。',
    'query 留空、只填 types 时列出这几类的记忆，按置信度和最近确认时间排，受 limit 限制，命中更多时结果开头会说明总数。',
    '其他场景和已退役类型的记忆也能按类型名搜到。',
    `当前场景的类型：${list.join('；')}`,
  ].join('')
}

/**
 * 把 memory_search 工具接到 dsh 框架上。纯逻辑在 search.ts，不依赖框架包，测试直接测它；
 * 本文件由 typecheck + 真机验证保证。types 说明在创建时从类型表生成，类型配置热更新后由 index.ts 重注册。
 */
export function createSearchTool(deps: SearchToolDeps): ToolDefinition {
  return defineTool({
    name: 'memory_search',
    description: [
      '查长期记忆用这个工具：想知道某件事有没有记过、记的是什么，或按 id 取一条。',
      '范围是本项目和全局记忆。结果按相关性排好，密钥已遮盖，每条带出处、是否陈旧和记忆文件的绝对路径，要看原文就直接读这个文件。代码和项目文件用 grep 搜；记忆目录不要用 grep 搜：那里还存着已删除和其他项目的记忆，grep 的结果也不排序，所以找记忆统一用这个工具。',
      '查询写法：',
      '- 查询是空格分隔的关键词，中英文均可，版本号、路径这类原样文字可以直接搜。同时含全部关键词的记忆排在最前，所以一次查询里放预期会在同一条记忆里一起出现的词，排序最准。',
      '- 记忆里的说法可能和用户的不同：开头记忆索引里的说法、用户的原话，以及你判断意思相近或相关的写法，都可以拿来搜。',
      '- 中文和英文写法分开匹配：记忆里只有其中一种写法时，两种一起写只算部分命中。',
      '- match 缺省为 any，返回按档位排好的全部命中；设为 all 只返回同时含全部关键词的记忆；有部分命中但没有全命中时，开头会说明并列出各关键词命中几条。',
      '- 想从几个角度找，可以分几次搜，每次一个角度。搜几次、什么时候停，由你根据结果是否已经回答了问题来判断。',
      '',
      '怎么读结果：',
      '- 同时命中全部关键词的排在最前，其次是命中部分关键词的，最后是关键词只以子串出现的。',
      '- 不是全命中的结果，头行会注明命中情况：完整对上了哪些关键词，或只对上一部分、只以子串出现；全命中的不标。',
      '- 没有记忆同时含全部关键词时，开头会说明；排第一的有关键词没完整对上时，还会列出各关键词在范围内命中几条。',
      '- 排第一的对上的查询内容不到一半、或只有子串命中时，开头会提示命中弱，并列出各关键词命中几条。',
      '- 这些说明是参考信号，结果是否已经回答了问题，以你读到的内容为准。',
      '- 开头说明共命中多少条、返回不全时：要更全就调大 limit，太杂就换更具体的关键词。',
    ].join('\n'),
    parameters: {
      query: { type: 'string', required: true, description: '空格分隔的关键词，中英文均可；对名称、摘要、标签、内容匹配。不是全命中的结果在头行标出完整对上的关键词；没有记录命中全部关键词时结果开头会说明，排第一的有关键词没完整对上时列出各关键词命中几条；排第一的对上的查询内容不到一半、或只有子串命中时会提示命中弱' },
      types: { type: 'array', items: { type: 'string' }, description: describeTypes(deps.registry) },
      scope: { type: 'string', enum: ['global', 'workspace', 'all-visible'], description: '缺省 all-visible（global + 当前 workspace）' },
      limit: { type: 'number', description: '返回条数上限，缺省 10，最大 50；命中更多时结果开头会说明总数' },
      match: { type: 'string', enum: ['any', 'all'], description: '匹配模式，缺省 any：返回按档位排好的全部命中；all：只返回同时含全部关键词的记忆' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: renderSearchResult(value as unknown as { hits: SearchHit[]; note?: string; moreNote?: string }) }],
    },
    execute: async (args, exec) => toToolOutput(await executeSearch(args, exec, deps)),
  })
}
