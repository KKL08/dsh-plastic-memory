import { extractEntities } from "../text.js";
import { isAbort } from "./semantic-scan.js";
/** 呈现限流：体检报告最多列这些，避免弱信号淹没主报告。 */
export const CROSS_WS_LIMIT = 3;
/**
 * 规则层保底（无 LLM 时用）：跨 workspace 实体重叠聚类。实体抽取对中文散文召回有限、
 * 常见标识符会误报，所以措辞用"疑似"、限流呈现，只当线索不当结论。
 */
export function findEntityDuplicates(byWorkspace, globalRecords) {
    const globalEntities = new Set(globalRecords.flatMap(r => extractEntities(`${r.content}\n${r.summary}`)));
    const entityWs = new Map();
    for (const [ws, records] of byWorkspace) {
        for (const r of records) {
            for (const e of extractEntities(`${r.content}\n${r.summary}`)) {
                if (globalEntities.has(e))
                    continue;
                const set = entityWs.get(e) ?? new Set();
                set.add(ws);
                entityWs.set(e, set);
            }
        }
    }
    return [...entityWs.entries()]
        .filter(([, wsSet]) => wsSet.size >= 2)
        .sort((a, b) => b[1].size - a[1].size)
        .slice(0, CROSS_WS_LIMIT)
        .map(([entity, wsSet]) => ({
        topic: entity,
        workspaces: [...wsSet].sort(),
        suggestion: `疑似跨项目重复（实体「${entity}」出现在 ${wsSet.size} 个项目），若确属通用可提炼一条 global 记忆`,
    }));
}
const SYSTEM_PROMPT = `你是记忆库治理审查员。给出的是多个项目（workspace）各自的记忆摘要清单和全局（global）记忆清单。
找出"多个项目重复记录同一件事、而 global 缺位"的主题——这是该内容本应全局共享的行为证据。
判定标准：至少两个项目在讲同一个事实/偏好/流程；global 清单里没有对应条目；内容确实与具体项目无关。
只报有把握的，不确定不报。只输出 JSON，格式：
{"duplicates":[{"topic":"一句话概括主题","workspaces":["路径1","路径2"],"suggestion":"建议提炼成怎样的一条 global 记忆"}]}
没有发现输出 {"duplicates":[]}`;
export function buildCrossWsPrompt(byWorkspace, globalRecords) {
    const sections = [];
    for (const [ws, records] of byWorkspace) {
        sections.push(`## 项目 ${ws}（${records.length} 条）\n${records.map(r => `- ${r.summary}`).join('\n')}`);
    }
    sections.push(`## global（${globalRecords.length} 条）\n${globalRecords.length > 0 ? globalRecords.map(r => `- ${r.summary}`).join('\n') : '（空）'}`);
    return { system: SYSTEM_PROMPT, user: sections.join('\n\n') };
}
export function parseCrossWsResult(raw, knownWs) {
    const stripped = raw.replace(/```(?:json)?/g, '').trim();
    const start = stripped.indexOf('{');
    const end = stripped.lastIndexOf('}');
    if (start < 0 || end <= start)
        return null;
    let parsed;
    try {
        parsed = JSON.parse(stripped.slice(start, end + 1));
    }
    catch {
        return null;
    }
    const duplicates = parsed.duplicates;
    if (!Array.isArray(duplicates))
        return null;
    const out = [];
    for (const item of duplicates) {
        if (item === null || typeof item !== 'object')
            continue;
        const d = item;
        const workspaces = (Array.isArray(d.workspaces) ? d.workspaces : [])
            .filter((w) => typeof w === 'string' && knownWs.has(w));
        if (workspaces.length < 2 || typeof d.topic !== 'string' || d.topic.length === 0)
            continue;
        out.push({
            topic: d.topic,
            workspaces: workspaces.sort(),
            suggestion: typeof d.suggestion === 'string' ? d.suggestion : '',
        });
    }
    return out.slice(0, CROSS_WS_LIMIT);
}
/** 语义层主力：一次调用聚合分析。失败（调用抛出或输出无法解析）返回 failed，调用方降级到实体保底。 */
export async function runCrossWsScan(byWorkspace, globalRecords, llm, signal) {
    const prompt = buildCrossWsPrompt(byWorkspace, globalRecords);
    let raw = null;
    try {
        raw = await llm.complete(prompt, signal);
    }
    catch (err) {
        // 用户取消不降级到实体保底：立即向上抛（宿主 exec.signal 契约）。
        if (isAbort(err, signal))
            throw err;
        // 普通失败降级到调用方的实体保底
    }
    const items = raw === null ? null : parseCrossWsResult(raw, new Set(byWorkspace.keys()));
    if (items === null)
        return { items: [], failed: true };
    return { items, failed: false };
}
