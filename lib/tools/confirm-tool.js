import { defineTool } from '@deepseek-ai/dsh-tools';
import { executeConfirm } from "./confirm.js";
/**
 * 把 memory_confirm 接到 dsh 框架上。测试只测 confirm.ts 纯逻辑，
 * 本文件由 typecheck + 真机冒烟保证（docs/p1-verification.md）。
 */
export function createConfirmTool(deps) {
    return defineTool({
        name: 'memory_confirm',
        description: '两个用途：action=refresh 确认某条记忆仍然准确（刷新新鲜度）；action=resolve 裁决 memory_scan 发现的待决冲突。裁决约定：横向冲突 left/right 对应待决项 memoryIds 的第一/第二条；垂直冲突 left=记忆、right=AGENTS.md 基线，其中 keep-left 保留记忆（不删除任何内容），keep-right 是基线胜出、会删除该记忆——选错会误删记忆，请谨慎判断。keep-both=并存不冲突，dismiss=误报。裁决删除会自动快照。拿不准时先用 memory_source 回查冲突双方的原始出处（横向冲突看当时谁说的什么语境；垂直冲突核对当前基线内容即可，不必回查旧会话）。',
        parameters: {
            action: { type: 'string', enum: ['refresh', 'resolve'], required: true },
            memoryId: { type: 'string', description: 'action=refresh 时必填' },
            decisionId: { type: 'string', description: 'action=resolve 时必填，待决项 id（pd_ 开头）' },
            verdict: { type: 'string', enum: ['keep-left', 'keep-right', 'keep-both', 'dismiss'], description: 'action=resolve 时必填' },
        },
        output: {
            schema: { type: 'json' },
            render: (_args, value) => [{ type: 'text', text: value.message }],
        },
        execute: (args) => executeConfirm(args, deps),
    });
}
