import type { CATEGORIES } from '../../tests/fixtures/conflict-eval.ts'

type Category = typeof CATEGORIES[number]
// Targets describe the intended detector, independently of baseline results.
export const THRESHOLDS: Record<Category, { minRecall: number; maxFalsePositiveRate: number; reason: string }> = {
  contradiction: { minRecall: 0.9, maxFalsePositiveRate: 0.05, reason: '矛盾会触发裁决，需高召回且少误报。' },
  change: { minRecall: 0.8, maxFalsePositiveRate: 0.05, reason: '明确时间差应被识别，避免把独立事件误并成版本。' },
  exception: { minRecall: 0.8, maxFalsePositiveRate: 0.05, reason: '项目差异应被保留，但硬性规则不能被例外掩盖。' },
  'premise-changed': { minRecall: 0.8, maxFalsePositiveRate: 0.05, reason: '明确前提变化应触发复查，避免无关变化反复打扰。' },
}
