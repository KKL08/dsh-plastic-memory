/** 分数与分档的文案（记忆页左栏、状态条用），由 locales.ts 合并进命名空间字典。 */

export const healthZh = {
  'health.score': '{score} 分',
  'health.tier.green': '良好',
  'health.tier.amber': '需要留意',
  'health.tier.red': '有问题',
  'health.unscored': '还没体检过，体检后打分',
} as const

export type HealthLocaleKey = keyof typeof healthZh

export const healthEn: Record<HealthLocaleKey, string> = {
  'health.score': 'Score {score}',
  'health.tier.green': 'Good',
  'health.tier.amber': 'Needs attention',
  'health.tier.red': 'Has problems',
  'health.unscored': 'Not checked yet; scored after a checkup',
}
