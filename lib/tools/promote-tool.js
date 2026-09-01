import { defineTool } from '@deepseek-ai/dsh-tools';
import { executePromote } from "./promote.js";
/**
 * memory_promote 框架绑定层：纯执行——把用户已确认的候选提升到 global / AGENTS.md。
 * 确认必须由模型先调 ask_user_question 完成（真机限制：ctx.userQuestions.ask 在工具内部调用
 * 会被 web 会话拒绝 "requires an agent-owned session"，而模型自己调 ask_user_question 允许）。
 * 故 global 写入的"用户确认"这道闸放在模型调本工具之前，本工具只落地已确认的 ids。
 */
export function createPromoteTool(deps) {
    return defineTool({
        name: 'memory_promote',
        description: '把治理时"建议提升全局"的候选记忆提升到全局。**调用前你必须先用 ask_user_question 让用户勾选确认要提升哪些**——'
            + '只把用户明确勾选要提升的 id 传进 ids，用户没勾的绝不传。global 写入必须经用户确认，你不能自作主张。'
            + 'ids 从 memory_scan / memory_health 的提升建议里取；target 省略用默认。'
            + '向用户发起确认前，可先用 memory_source 回查候选的出生语境，确认当时确实是跨项目通用的表述。'
            + '用户明确表示不想提升的候选，传 dismiss: true 清除其候选标记，之后治理不再提示这些记忆；用户已表态的不要反复追问。',
        parameters: {
            ids: { type: 'array', items: { type: 'string' }, required: true, description: '用户确认要提升、或明确拒绝提升的候选记忆 id' },
            target: { type: 'string', enum: ['global', 'agents-md'], description: 'global=插件全局记忆（默认）；agents-md=写入 ~/.dsh/AGENTS.md 交由用户统一维护' },
            dismiss: { type: 'boolean', description: 'true=用户明确不想提升，只清除这些候选的提升标记、记忆留在项目内，忽略 target' },
        },
        output: { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: v.message }] },
        execute: async (args) => {
            const target = args.target ?? deps.defaultTarget;
            return executePromote({ confirmedIds: args.ids, target, dismiss: args.dismiss }, deps);
        },
    });
}
