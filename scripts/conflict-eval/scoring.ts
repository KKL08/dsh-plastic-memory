import { CATEGORIES } from '../../tests/fixtures/conflict-eval.ts'
import { THRESHOLDS } from './thresholds.ts'

type Category = typeof CATEGORIES[number]
export type Prediction = Category | 'other'
export interface Observation { expected: Category | 'none'; predicted: Prediction[]; failed: boolean }

// Only explicit types count. Prose must never repair an incorrect model label.
export function classify(findings: readonly { type: string; summary?: string }[]): Prediction[] {
  return [...new Set(findings.map((f): Prediction => {
    if (f.type === 'conflict') return 'contradiction'
    if ((CATEGORIES as readonly string[]).includes(f.type)) return f.type as Category
    return 'other'
  }))]
}

export function score(rows: readonly Observation[]) {
  const classes = Object.fromEntries(CATEGORIES.map(category => {
    const positives = rows.filter(r => r.expected === category).length
    const hits = rows.filter(r => !r.failed && r.expected === category && r.predicted.includes(category)).length
    const falsePositives = rows.filter(r => !r.failed && r.expected !== category && r.predicted.includes(category)).length
    const negatives = rows.length - positives
    const recall = positives ? hits / positives : null
    const falsePositiveRate = negatives ? falsePositives / negatives : null
    const target = THRESHOLDS[category]
    return [category, { positives, negatives, hits, misses: positives - hits, falsePositives, recall, falsePositiveRate,
      passed: recall !== null && falsePositiveRate !== null && recall >= target.minRecall && falsePositiveRate <= target.maxFalsePositiveRate }]
  })) as Record<Category, { positives: number; negatives: number; hits: number; misses: number; falsePositives: number; recall: number | null; falsePositiveRate: number | null; passed: boolean }>
  return { classes, total: rows.length, failures: rows.filter(r => r.failed).length,
    exact: rows.filter(r => !r.failed && (r.expected === 'none' ? r.predicted.length === 0 : new Set(r.predicted).size === 1 && r.predicted.includes(r.expected))).length,
    cleanFalsePositives: rows.filter(r => !r.failed && r.expected === 'none' && r.predicted.length > 0).length,
  }
}
