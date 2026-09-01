import { defineTool } from '@deepseek-ai/dsh-tools';
import { executeSearch, renderSearchResult } from "./search.js";
/**
 * 把 memory_search 工具接到 dsh 框架上。纯逻辑在 search.ts，不依赖框架包，测试直接测它；
 * 本文件由 typecheck + 真机验证保证。
 */
export function createSearchTool(deps) {
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
            render: (_args, value) => [{ type: 'text', text: renderSearchResult(value) }],
        },
        execute: (args, exec) => executeSearch(args, exec, deps),
    });
}
