import { runSavePipeline } from "../pipeline.js";
/** 把管线结果渲染成给模型看的一段文本。纯函数。 */
export function renderSaveResult(result) {
    let text;
    switch (result.kind) {
        case 'saved':
            text = `已保存记忆 ${result.record.id}（${result.record.type}，${result.record.scope}）。下个会话注入；本会话若触发上下文压缩，压缩后即生效。`;
            break;
        case 'updated':
            text = `已更新记忆 ${result.record.id}。`;
            break;
        case 'duplicate-suspected':
            text = `这个主题可能已有记忆：\n${result.existing.map(e => `- ${e.id}：${e.summary}`).join('\n')}\n如需修改已有记忆，用 action=update 和对应 id 重发；确认是新信息就加 force=true 重发。`;
            break;
        case 'rejected':
            text = `未保存：${result.reason}`;
            break;
    }
    // 渲染警告行
    if ((result.kind === 'saved' || result.kind === 'updated') && result.warnings) {
        const warnings = result.warnings.map(w => `⚠️ ${w}`).join('\n');
        text = `${text}\n${warnings}`;
    }
    return text;
}
/**
 * memory_save 工具的真正执行逻辑：解析上下文、归一化候选、跑写入管线。
 * 不依赖任何 dsh 框架包，测试直接调它。
 */
export async function executeSave(args, exec, deps) {
    const context = await deps.resolveContext(exec);
    const candidate = { ...args, tags: args.tags ?? [] }; // 可选参数归一化
    return runSavePipeline(candidate, {
        store: deps.store,
        registry: deps.registry,
        // 无条件传真实 workspace 上下文：pipeline 要靠它判断 global 是否降级为候选（scope=global 时
        // 也需要知道当前有没有 workspace 桶）。global 记忆最终不带 workspacePath 由 pipeline 组装时归 undefined。
        workspacePath: context.workspacePath,
        session: context.session,
        snapshots: deps.snapshots,
    });
}
