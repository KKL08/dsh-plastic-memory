import { sourceNote, formatIndexLine } from "./index-line.js";
import { workspaceDirName } from "./storage/paths.js";
import { EVIDENCE_GUIDANCE } from "./evidence-guidance.js";
import { stalenessNote, withinValidity } from "./record-freshness.js";
export const COLD_START_TEXT = `记忆库当前为空。如果时机合适，可以问一句用户是否愿意介绍自己的背景（角色、常用技术、工作习惯），愿意就用 memory_save 记下来；不愿意就在后续任务中自然积累，不要追问。`;
/** 粗略 token 估算：中文字 ×1.5，其余按空白分词 ×1.3。预算是软约束，够用即可。 */
export function estimateTokens(text) {
    const cjk = (text.match(/[一-鿿]/g) ?? []).length;
    const words = text.replace(/[一-鿿]/g, ' ').split(/\s+/).filter(Boolean).length;
    return Math.ceil(cjk * 1.5 + words * 1.3);
}
export function assembleSnapshot(deps) {
    const { registry, now } = deps;
    const visible = deps.store.query({ scope: { kind: 'visible', workspacePath: deps.workspacePath } });
    if (visible.length === 0)
        return { text: COLD_START_TEXT, coreIds: [] };
    const all = visible.filter(r => withinValidity(r, now));
    const parts = ['# 长期记忆'];
    let used = estimateTokens(parts[0]);
    // core 区：完整正文，占预算一半以内
    const coreBudget = deps.budget * 0.5;
    const coreRecords = all
        .filter(r => registry.get(r.type).recall === 'core')
        .sort((a, b) => b.confidence - a.confidence || b.recallCount - a.recallCount);
    const coreIncluded = [];
    for (const r of coreRecords) {
        // 归属前缀：模型不信来路不明的裸句，标出这是长期记忆及其类型，减少"全文在手仍重搜"
        const line = `- [${r.id}]【记忆·${registry.get(r.type).label}】${r.content}${sourceNote(r)}${stalenessNote(r, registry.get(r.type).decayDays, now)}`;
        const cost = estimateTokens(line);
        if (used + cost > coreBudget)
            break;
        parts.push(line);
        used += cost;
        coreIncluded.push(r);
    }
    // 索引区：全部记忆按类型分组（含 core 区已出现的）。组按治理优先级 high → low 顺序申领预算，
    // 组内逐条估算逐条装（排序与 core 区一致：confidence 降序、再 recallCount 降序）。预算耗尽即停：
    // 当前组截断、后续各组整组计入 omitted 尾注——避免只出孤组头。整组丢弃改成部分装入，让临界预算
    // 也能带上高优先级组的前几条，而不是差一点就丢掉整组几十条。
    // core 类型的正文已在 core 区（带 id），索引区不再重复列它们——避免同一条记忆两处冗余。
    const groups = new Map();
    for (const r of all) {
        if (registry.get(r.type).recall === 'core')
            continue;
        const list = groups.get(r.type) ?? [];
        list.push(r);
        groups.set(r.type, list);
    }
    const priorityOrder = { high: 0, medium: 1, low: 2 };
    const sortedGroups = [...groups.entries()]
        .sort((a, b) => priorityOrder[registry.get(a[0]).governancePriority] - priorityOrder[registry.get(b[0]).governancePriority]);
    const omitted = [];
    let exhausted = false;
    for (const [type, records] of sortedGroups) {
        const def = registry.get(type);
        // 预算已耗尽：剩余各组不再尝试，整组计入 omitted
        if (exhausted) {
            omitted.push({ type, count: records.length });
            continue;
        }
        const sorted = [...records].sort((a, b) => b.confidence - a.confidence || b.recallCount - a.recallCount);
        const groupLines = [`\n## ${def.label}（${type}）`];
        let groupCost = estimateTokens(groupLines[0]);
        for (const r of sorted) {
            const line = formatIndexLine(r, { passive: def.recall === 'passive' }) + stalenessNote(r, def.decayDays, now);
            const cost = estimateTokens(line);
            if (used + groupCost + cost > deps.budget) {
                exhausted = true;
                break;
            }
            groupLines.push(line);
            groupCost += cost;
        }
        // 只剩组头（组头本身放不下，或首条正文就放不下）：不留孤组头，整组进 omitted
        if (groupLines.length === 1) {
            exhausted = true;
            omitted.push({ type, count: records.length });
            continue;
        }
        parts.push(...groupLines);
        used += groupCost;
        const dropped = records.length - (groupLines.length - 1);
        if (dropped > 0)
            omitted.push({ type, count: dropped });
    }
    for (const o of omitted) {
        parts.push(`\n另有 ${o.count} 条 ${o.type} 记忆未列出，可用 memory_search 查询。`);
    }
    parts.push('\n想看索引里某条记忆的全文，用 memory_search 按 id 或关键词查。');
    // 磁盘路径：让 dsh 原生 grep/Read 通道可发现记忆文件。**只透 global + 当前项目两处**——
    // 所有 workspace 记忆都在同一 memories 根下当兄弟目录，若透整根会让模型 grep 到别项目的
    // 私有记忆（跨项目泄漏）。跨项目透明可读的只应是 global；别项目记忆除非用户明确给路径才访问。
    if (deps.memoryRoot) {
        const lines = ['\n记忆文件在磁盘（可直接 grep/读取全文）：', `- 全局记忆：${deps.memoryRoot}/global/`];
        if (deps.workspacePath !== undefined) {
            lines.push(`- 本项目记忆：${deps.memoryRoot}/${workspaceDirName(deps.workspacePath)}/`);
        }
        lines.push('其他项目的记忆不在上列——除非用户明确给出该项目路径，否则不要去读别的 workspace 目录。');
        parts.push(lines.join('\n'));
    }
    // 证据下钻引导：固定尾注不计预算（与磁盘路径行同待遇，预算是软约束）
    if (deps.evidenceLookup)
        parts.push(`\n${EVIDENCE_GUIDANCE[deps.evidenceLookup]}`);
    return { text: parts.join('\n'), coreIds: coreIncluded.map(r => r.id) };
}
