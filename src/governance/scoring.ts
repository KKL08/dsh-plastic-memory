import { FINDING_TYPES, type Finding, type FindingType } from './schema.ts'

/** 绝对扣分（"绝对不该有"，每条直接扣，不随库规模归一）。设计稿 §5。 */
export const ABSOLUTE_WEIGHTS = { secret: 20, conflict: 10 } as const

/** 比例扣分系数（噪音类）：penalty = min(系数, 系数 × 问题数/总数 × 100)。 */
export const PROPORTIONAL_COEFF = {
  redundancy: 3, misplaced: 5, unclear: 3, bloat: 3, expired: 5, orphan: 3, malformed: 3,
} as const

export const FRESHNESS_PENALTY_CAP = 15

export interface HealthInput {
  totalMemories: number
  ruleFindings: Finding[]
  semanticFindings: Finding[]
  /** 每条有 decayDays 的活跃记忆的 (now − lastConfirmedAt) / (decayDays × 86400000)。 */
  freshnessRatios: number[]
}

export interface HealthScore {
  score: number
  tier: 'green' | 'amber' | 'red'
  counts: Record<FindingType, number>
  rulePenalty: number
  semanticPenalty: number
  freshness: { avgRatio: number; staleCount: number; penalty: number }
}

export function computeHealth(input: HealthInput): HealthScore {
  const counts = Object.fromEntries(FINDING_TYPES.map(t => [t, 0])) as Record<FindingType, number>
  for (const f of [...input.ruleFindings, ...input.semanticFindings]) counts[f.type]++

  const penaltyOf = (type: FindingType): number => {
    const n = counts[type]
    if (n === 0) return 0
    if (type in ABSOLUTE_WEIGHTS) {
      return n * ABSOLUTE_WEIGHTS[type as keyof typeof ABSOLUTE_WEIGHTS]
    }
    const coeff = PROPORTIONAL_COEFF[type as keyof typeof PROPORTIONAL_COEFF]
    if (input.totalMemories === 0) return coeff
    return Math.min(coeff, coeff * (n / input.totalMemories) * 100)
  }

  const ruleTypes: FindingType[] = ['secret', 'expired', 'bloat', 'orphan', 'malformed']
  const semanticTypes: FindingType[] = ['conflict', 'redundancy', 'misplaced', 'unclear']
  const rulePenalty = ruleTypes.reduce((sum, t) => sum + penaltyOf(t), 0)
  const semanticPenalty = semanticTypes.reduce((sum, t) => sum + penaltyOf(t), 0)

  // 新鲜度：只有超期部分（ratio > 1）贡献扣分，均值按超期记录数算（设计稿 §5 算例）
  const ratios = input.freshnessRatios
  const overdue = ratios.filter(r => r > 1).map(r => r - 1)
  const avgOverdue = overdue.length > 0 ? overdue.reduce((a, b) => a + b, 0) / overdue.length : 0
  const freshness = {
    avgRatio: ratios.length > 0 ? ratios.reduce((a, b) => a + b, 0) / ratios.length : 0,
    staleCount: overdue.length,
    penalty: Math.min(FRESHNESS_PENALTY_CAP, avgOverdue * 10),
  }

  const score = Math.max(0, 100 - rulePenalty - semanticPenalty - freshness.penalty)
  const tier = score >= 80 ? 'green' : score >= 50 ? 'amber' : 'red'
  return { score, tier, counts, rulePenalty, semanticPenalty, freshness }
}
