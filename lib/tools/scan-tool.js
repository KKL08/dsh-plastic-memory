import { defineTool } from '@deepseek-ai/dsh-tools';
import { executeScan, renderScanResult } from "./scan.js";
/** 把 memory_scan 接到 dsh 框架上。测试只测 scan.ts 纯逻辑，本文件由 typecheck 保证。 */
export function createScanTool(deps) {
    return defineTool({
        name: 'memory_scan',
        description: '对记忆库做治理扫描。规则层（密钥泄漏/过期/超长/孤儿引用）免费实时；语义层（冲突/冗余/错位/模糊）'
            + '调用 LLM 深扫，结果按 scope 分桶缓存供 memory_health 使用，发现的冲突自动登记为待决项。'
            + '默认只扫当前项目的可见记忆（global + 本 workspace）。'
            + '**全库体检（scope="all"）会对每个 workspace 各调一次 LLM，调用前你必须先用 ask_user_question 让用户选择范围**——'
            + '全部 workspace 都扫，还是只扫指定几个（用户勾选的路径传 scopes）。'
            + '扫描只读不清理——清理动作需向用户呈现 findings 并确认后，用 memory_forget / memory_save / memory_confirm 执行。',
        parameters: {
            scope: { type: 'string', description: '缺省=当前 workspace；"all"=全库体检（须先经用户确认范围）；也可传 workspace 的绝对路径（项目目录路径，如 /Users/me/proj——记忆存储目录名不是合法值）' },
            scopes: { type: 'array', items: { type: 'string' }, description: '体检范围：用户经 ask_user_question 勾选的 workspace 绝对路径列表（合法路径可先用 memory_health scope="all" 免费查看）；给出时忽略 scope' },
            layers: { type: 'string', enum: ['rule', 'semantic', 'full'], description: '默认 full。rule 免费秒回；semantic 需要 LLM 调用' },
        },
        output: {
            schema: { type: 'json' },
            render: (_args, value) => [{ type: 'text', text: renderScanResult(value) }],
        },
        execute: (args, exec) => executeScan(args, deps, exec),
    });
}
