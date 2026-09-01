import { FINDING_TYPES } from "./schema.js";
/** 红线触发时 score 的红区上限：密钥存在即不可接受，gate 判死而非扣分算术（高分不能稀释它）。 */
export const SECRET_GATE_SCORE_CAP = 40;
/** 重问题：conflict 计条扣分——大库里 3 条未裁决冲突占比趋零但依然要紧，占比制会漏；
 *  也不进红线：观点更新产生冲突是正常使用的一部分，已有待决账本流程，判死会让红色麻木。 */
export const CONFLICT_UNIT = 10;
export const CONFLICT_CAP = 30;
/**
 * 噪音八类满格上限（100 分健康预算的分配表）。cap 与库大小无关——规模影响全部由进度项承担，
 * cap 回答的是"这类问题满格时值多少分"这一价值判断。
 * 权重叙事：会误导模型的重（global 层 misplaced 10——项目私货混进 global 在所有会话生效；
 * freshness 15——超衰减期的记忆仍在注入、只有标注），不误导只占地方的轻（expired 6——
 * validTo 过期已被注入/检索过滤，危害降级为存储噪音；workspace 层 misplaced 6——
 * "该升未升"是机会成本，另有提升候选流程承接）。
 */
export const NOISE_CAPS = {
    redundancy: 6, misplaced: 6, unclear: 6, bloat: 6, expired: 6, orphan: 6, malformed: 6,
};
export const GLOBAL_MISPLACED_CAP = 10;
export const FRESHNESS_CAP = 15;
/**
 * 噪音进度双轴满格线："条数够多、占比也够高，这类问题才算大"。
 * 两轴取小是早期到中后期连续过渡的机关：小库占比虚高由条数轴按住（1 条不吓人），
 * 大库条数易过线由占比轴放宽（500 条里 5 条冗余不算事）；无分段、无库规模开关。
 */
export const COUNT_FULL = 3;
export const RATIO_FULL = 0.10;
/** 噪音进度 ∈ [0,1]：min(条数进度, 占比进度)。total=0 时占比轴缺席，只按条数轴（隔离区 malformed 可在空库出现）。 */
export function noiseProgress(n, total) {
    if (n === 0)
        return 0;
    const countAxis = n / COUNT_FULL;
    const ratioAxis = total > 0 ? (n / total) / RATIO_FULL : Infinity;
    return Math.min(1, countAxis, ratioAxis);
}
export function computeHealth(input) {
    const layer = input.layer ?? 'workspace';
    const counts = Object.fromEntries(FINDING_TYPES.map(t => [t, 0]));
    for (const f of [...input.ruleFindings, ...input.semanticFindings])
        counts[f.type]++;
    const capOf = (type) => type === 'misplaced' && layer === 'global' ? GLOBAL_MISPLACED_CAP : NOISE_CAPS[type];
    const noisePenalty = (type) => capOf(type) * noiseProgress(counts[type], input.totalMemories);
    const conflictPenalty = Math.min(CONFLICT_CAP, counts.conflict * CONFLICT_UNIT);
    // rule/semantic 的划分沿用 finding 的产出层；secret 不进扣分算术（走红线门）
    const rulePenalty = ['expired', 'bloat', 'orphan', 'malformed'].reduce((s, t) => s + noisePenalty(t), 0);
    const semanticPenalty = conflictPenalty + ['redundancy', 'misplaced', 'unclear'].reduce((s, t) => s + noisePenalty(t), 0);
    // 新鲜度当第八类噪音：超期条数走同一进度公式（深度不加权——超 1 天和超 10 倍都算 1 条，
    // 引导动作一样是 confirm/update；avgRatio 仅供展示）
    const ratios = input.freshnessRatios;
    const staleCount = ratios.filter(r => r > 1).length;
    const freshness = {
        avgRatio: ratios.length > 0 ? ratios.reduce((a, b) => a + b, 0) / ratios.length : 0,
        staleCount,
        penalty: FRESHNESS_CAP * noiseProgress(staleCount, ratios.length),
    };
    const gate = { secret: counts.secret > 0 };
    const raw = Math.max(0, 100 - rulePenalty - semanticPenalty - freshness.penalty);
    const score = gate.secret ? Math.min(raw, SECRET_GATE_SCORE_CAP) : raw;
    const tier = gate.secret ? 'red' : score >= 80 ? 'green' : score >= 50 ? 'amber' : 'red';
    return { score, tier, gate, counts, rulePenalty, semanticPenalty, freshness };
}
