import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { executeSearch, renderSearchResult, type SearchToolDeps } from './search.ts'
import { toToolOutput } from './output.ts'
import type { TypeRegistry } from '../type-registry.ts'
import { SEARCH_SOURCES } from '../contract-codes.ts'
import { DIALOGUE_SECTION_HEADING, MEMORY_SECTION_HEADING } from '../search/dialogue-format.ts'

/**
 * types 的参数说明：固定用法 + 当前场景的类型列表。类型可配置，名字全从类型表读；
 * core 类型说「通常」已带入，是因为严格上限模式下可能被省略。
 */
function describeTypes(registry: TypeRegistry): string {
  const list = registry.all().map(t => t.recall === 'core' ? `${t.name}（${t.label}）：通常已整条带入开头的长期记忆` : `${t.name}（${t.label}）`)
  return [
    '按类型筛选，不填查全部类型。',
    'query 留空、只填 types 时列出这几类的记忆，按置信度和最近确认时间排，受 limit 限制，命中更多时结果开头会说明总数。',
    '其他场景和已退役类型的记忆也能按类型名搜到，类型名是开头记忆索引分组标题括号里的英文名。',
    `当前场景的类型：${list.join('；')}`,
  ].join('')
}

/**
 * memory_search 的 source 参数：这次查哪里，缺省跟随设置。工具形状不随设置变：设置是只查记忆时参数仍在，
 * 传了 dialogue 或 both 就照常查记忆并附一句说明。按配置决定是否执行原话检索。
 */
export const SEARCH_SOURCE_PARAMETER = {
  type: 'string',
  enum: [...SEARCH_SOURCES],
  description: '查哪里，缺省跟随用户的设置。memory：只查长期记忆；dialogue：只查本项目过往对话的原话，能找到没记成记忆的内容；both：两者都查。用户设置成只查记忆时，这里填 dialogue 或 both 仍只查记忆，结果开头会说明',
} as const

/** 按主题浏览与主题内关键词检索的工具说明。 */
export const SEARCH_TOPIC_DESCRIPTION = '用 topic 按主题看记忆：只给 topic 时按主题索引的顺序列出这个主题下的记忆，每条带 id、名称、摘要、标签和文件路径，不含正文；同时给 query 时在这个主题里按关键词查。两种用法都用 limit 控制每页条数、offset 翻页。检索结果的头行标出每条记忆所属的主题；不传 topic 时没搜到或命中弱，结果末尾附当下的主题目录。'
/** 主题参数只选记忆，兼容曾用名。 */
export const SEARCH_TOPIC_PARAMETER = { type: 'string', description: '主题名或曾用名；传「未整理」看还没归入任何主题的记忆。只给 topic 时按主题索引的顺序列出成员，同时给 query 时在这个主题里按关键词查，都用 limit、offset 翻页。只查记忆，source 不传或设为 memory' } as const
/** 分页起点以结果给出的 offset 为准。 */
export const SEARCH_OFFSET_PARAMETER = { type: 'number', description: '跳过前面多少条，填 0 或正整数，缺省 0。关键词检索、按类型列出和按主题浏览都可以翻页，结果里会给下一页的 offset；原话不翻页，只查原话时不传，两者都查时第二页起只翻记忆' } as const

/**
 * 把 memory_search 工具接到 dsh 框架上。纯逻辑在 search.ts，不依赖框架包，测试直接测它；
 * 本文件由 typecheck + 真机验证保证。types 说明在创建时从类型表生成，类型配置热更新后由 index.ts 重注册。
 */
export function createSearchTool(deps: SearchToolDeps): ToolDefinition {
  return defineTool({
    name: 'memory_search',
    description: [
      '查长期记忆用这个工具：想知道某件事有没有记过、记的是什么，或按 id 取一条。',
      '范围是本项目和全局记忆。结果按相关性排好，记忆条目里的密钥已遮盖，每条带出处、是否陈旧和记忆文件的绝对路径，要看原文就直接读这个文件；正文给全文或其中一段（节选）。代码和项目文件用 grep 搜；记忆目录不要用 grep 搜：那里还存着已删除和其他项目的记忆，grep 的结果也不排序，所以找记忆统一用这个工具。',
      '能查本项目过往对话的原话，能找到没记成记忆的内容。原话照当时的原文给出，可能含密钥等敏感内容。',
      `排在前面的记忆后面可能附着它出处的原话（看用户的设置）。记忆和原话都查时，结果分${MEMORY_SECTION_HEADING}${DIALOGUE_SECTION_HEADING}两段：其他原话是没附在记忆下面的原话，某一轮是某条记忆的出处时会注明对应哪条记忆。`,
      '原话结果里每条消息带引用，可以用 memory_source 看这条消息的更多内容；展开的内容有长度上限，超出会标明截断。',
      '用 id 配 history: true 列出历史版本（新的在前，用 limit 控制条数）；用 id 配 version 读一版的全文，正文里的密钥已遮盖。要读当前内容，把 id 填进 query。',
      SEARCH_TOPIC_DESCRIPTION,
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
      '- 开头说明共命中多少条、返回不全时：要更全就按结果里给的 offset 翻下一页，太杂就换更具体的关键词。',
      '- 排在前面的带完整正文；很长的记忆和排在后面的条目可能只给正文的一段（有命中词时取命中词附近），头行会标「节选」和正文总字符数。要全文，用这个工具按 id 查，或读头行末尾的文件。',
      '- 输出长度跟随 DeepSeek Harness 的工具结果裁剪阈值，一般压在阈值以内。放不下时先省其他原话和可省的说明，再从排在后面的条目起改为节选、只给头行，最后把条目移到下一页；阈值调得越低，越多条目只给节选或头行，结果开头会说明这次省了什么、怎么取回。按 id 查的那条照给全文。阈值偏低时 memory_health 会列出建议的调法。',
    ].join('\n'),
    parameters: {
      source: SEARCH_SOURCE_PARAMETER,
      topic: SEARCH_TOPIC_PARAMETER,
      offset: SEARCH_OFFSET_PARAMETER,
      id: { type: 'string', description: '记忆 id。配 history: true 列历史版本，配 version 读一版；要读当前内容，把 id 填进 query' },
      history: { type: 'boolean', description: '配 id 设为 true 时列历史版本；false 等同未传' },
      version: { type: 'string', description: '配 id 读一版的全文，填列历史（history: true）返回的版本标识，不含 .md 后缀' },
      query: { type: 'string', description: '空格分隔的关键词，中英文均可；对名称、摘要、标签、内容匹配。不是全命中的结果在头行标出完整对上的关键词；没有记录命中全部关键词时结果开头会说明，排第一的有关键词没完整对上时列出各关键词命中几条；排第一的对上的查询内容不到一半、或只有子串命中时会提示命中弱' },
      types: { type: 'array', items: { type: 'string' }, description: describeTypes(deps.registry) },
      scope: { type: 'string', enum: ['global', 'workspace', 'all-visible'], description: '缺省 all-visible（global + 当前 workspace）' },
      limit: { type: 'number', description: '每页最多返回几条，填正整数，缺省 10，最大 50；命中更多时结果开头会说明总数和下一页的 offset' },
      match: { type: 'string', enum: ['any', 'all'], description: '匹配模式，缺省 any：返回按档位排好的全部命中；all：只返回同时含全部关键词的记忆' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: renderSearchResult(value as unknown as Parameters<typeof renderSearchResult>[0]) }],
    },
    execute: async (args, exec) => toToolOutput(await executeSearch(args, exec, deps)),
  })
}
