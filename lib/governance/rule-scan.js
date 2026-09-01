import { SEVERITY_BY_TYPE } from "./schema.js";
import { detectSecrets } from "../secrets.js";
export const BLOAT_THRESHOLD = 2000;
/**
 * 规则层四类检测（secret/expired/bloat/orphan）。纯函数、免费、memory_health 每次实时算。
 * lookup 用于 orphan 检测按 id 直查（含 deleted 记录），records 传入的应是 active 集合。
 */
export function runRuleScan(records, lookup, now) {
    const findings = [];
    for (const r of records) {
        // summary 进注入索引、name 进文件名、tags 进索引行——密钥藏这三处同样会泄漏，一起喂进检测。
        const hits = detectSecrets(`${r.content}\n${r.name}\n${r.summary}\n${r.tags.join(' ')}`);
        if (hits.length > 0) {
            findings.push({
                type: 'secret', layer: 'rule', severity: SEVERITY_BY_TYPE.secret,
                memoryIds: [r.id],
                summary: `疑似密钥泄漏（${hits.map(h => h.name).join('、')}）`,
                suggestedAction: '确认后用 memory_forget 删除，并轮换泄漏的凭证',
            });
        }
        if (r.validTo !== undefined && r.validTo < now) {
            findings.push({
                type: 'expired', layer: 'rule', severity: SEVERITY_BY_TYPE.expired,
                memoryIds: [r.id],
                summary: `已过有效期（validTo=${r.validTo}）`,
                suggestedAction: '确认后用 memory_forget 删除，或用 memory_save 更新有效期',
            });
        }
        if (r.content.length > BLOAT_THRESHOLD) {
            findings.push({
                type: 'bloat', layer: 'rule', severity: SEVERITY_BY_TYPE.bloat,
                memoryIds: [r.id],
                summary: `内容超长（${r.content.length} 字符 > ${BLOAT_THRESHOLD}）`,
                suggestedAction: '用 memory_save 精简内容，保留可执行要点',
            });
        }
        const orphanRefs = (r.supersedes ?? []).filter(id => {
            const target = lookup(id);
            return !target || target.status === 'deleted';
        });
        if (orphanRefs.length > 0) {
            findings.push({
                type: 'orphan', layer: 'rule', severity: SEVERITY_BY_TYPE.orphan,
                memoryIds: [r.id],
                summary: `supersedes 指向已删/不存在的记录：${orphanRefs.join('、')}`,
                suggestedAction: '用 memory_save 更新该记忆，移除失效的 supersedes 引用',
            });
        }
    }
    return findings;
}
/**
 * 隔离区（FileTable.quarantined，解析失败被隔离的记忆文件）→ malformed finding。
 * 无解析成功的记录，memoryIds 留空；路径与错误信息进 summary。
 */
export function buildMalformedFindings(quarantined) {
    return quarantined.map(({ path, error }) => ({
        type: 'malformed', layer: 'rule', severity: SEVERITY_BY_TYPE.malformed,
        memoryIds: [],
        summary: `记忆文件无法解析：${path}（${error}）`,
        suggestedAction: '手工修复该文件的 frontmatter，或删除后用 memory_save 重建',
    }));
}
