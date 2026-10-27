/** 体检结果、分数与分档的文案（状态条、设置页状态卡用），由 locales.ts 合并进命名空间字典。 */

export const healthZh = {
  'scan.busy': '体检中…',
  'scan.done': '体检完成。',
  'scan.retry': '再试一次',
  'scan.llmUnavailable': '这次没能体检：借用的会话拿不到模型。',
  'scan.failed': '体检没有完成：{detail}',
  'scan.askAgent': '可以在对话里让 agent 体检。',
  'scan.note.baselineSessionScoped': '这次没有对照本项目的 AGENTS.md 检查冲突：借用的会话不在这个项目里。在本项目的对话里体检可以补上。',
  'scan.note.semanticFailed': '内容检查没有完成，这次只更新了规则检查。',
  'scan.note.semanticBatched': '记忆较多，分 {n} 批检查，不同批之间的冲突和重复可能查不出。',
  'scan.hint': '会用当前对话的模型检查记忆内容，记忆越多，用的 token 越多。',
  'scan.usage': '本次用了约 {n} token',
  'scan.result.done': '体检完成：',
  'scan.result.newPending': '新增 {n} 条待处理 ›',
  'scan.result.newAdvice': '新增 {n} 条建议 ›',
  'scan.result.newAdvice.one': '新增 {n} 条建议 ›',
  'scan.result.nothingNew': '没有发现新问题',
  'scan.result.scores': '查看分数 ›',
  'scan.off': '体检已关闭',

  'health.score': '{score} 分',
  'health.tier.green': '良好',
  'health.tier.amber': '需要留意',
  'health.tier.red': '有问题',
  'health.unscored': '还没体检过，体检后打分',
} as const

export type HealthLocaleKey = keyof typeof healthZh

export const healthEn: Record<HealthLocaleKey, string> = {
  'scan.busy': 'Checkup in progress…',
  'scan.done': 'Checkup finished.',
  'scan.retry': 'Try again',
  'scan.llmUnavailable': 'Could not run the checkup: the borrowed session has no model.',
  'scan.failed': 'The checkup did not finish: {detail}',
  'scan.askAgent': 'You can ask the agent to run a checkup in a chat.',
  'scan.note.baselineSessionScoped': 'Conflicts with this project\'s AGENTS.md were not checked: the borrowed session is not in this project. Run a checkup from a chat in this project to cover them.',
  'scan.note.semanticFailed': 'The content check did not finish; only the rule check was updated.',
  'scan.note.semanticBatched': 'Many memories, so the content was checked in {n} batches; conflicts and duplicates across batches may be missed.',
  'scan.hint': 'Uses this chat\'s model to check memory content; the more memories, the more tokens it uses.',
  'scan.usage': 'Used about {n} tokens this time',
  'scan.result.done': 'Checkup finished: ',
  'scan.result.newPending': '{n} new to handle ›',
  'scan.result.newAdvice': '{n} new suggestions ›',
  'scan.result.newAdvice.one': '{n} new suggestion ›',
  'scan.result.nothingNew': 'No new issues found',
  'scan.result.scores': 'View scores ›',
  'scan.off': 'Checkups are off',

  'health.score': 'Score {score}',
  'health.tier.green': 'Good',
  'health.tier.amber': 'Needs attention',
  'health.tier.red': 'Has problems',
  'health.unscored': 'Not checked yet; scored after a checkup',
}
