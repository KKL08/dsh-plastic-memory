import { defineTool } from '@deepseek-ai/dsh-tools';
import { executeSnapshotTool } from "./snapshot.js";
/**
 * 把 memory_snapshot 接到 dsh 框架上。测试只测 snapshot.ts 纯逻辑，
 * 本文件由 typecheck + 真机冒烟保证（docs/p1-verification.md）。
 */
export function createSnapshotTool(deps) {
    return defineTool({
        name: 'memory_snapshot',
        description: '记忆快照管理：action=create 手动快照（大清理前先拍）；list 列出 14 天内的快照（forget/裁决前会自动拍）；show 查看某快照与当前状态的差异；restore 恢复误删的记忆（可指定 memoryIds 只恢复部分，快照后被改过的记录默认跳过）。',
        parameters: {
            action: { type: 'string', enum: ['create', 'list', 'show', 'restore'], required: true },
            snapshotId: { type: 'string', description: 'show/restore 时必填，snap_ 开头' },
            memoryIds: { type: 'array', items: { type: 'string' }, description: 'create：只快照这些记忆；restore：只恢复这些记忆' },
            description: { type: 'string', description: 'create 时的备注' },
            overwriteChanged: { type: 'boolean', description: 'restore 时覆盖快照后被修改过的记录（需用户确认）' },
        },
        output: {
            schema: { type: 'json' },
            render: (_args, value) => [{ type: 'text', text: value.message }],
        },
        execute: (args) => executeSnapshotTool(args, deps),
    });
}
