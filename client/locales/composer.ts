/** 输入框「记忆」按钮与弹层的文案，由 locales.ts 合并进同一命名空间。 */

export const composerZh = {
  'composer.button': '记忆',
  'composer.dialog': '记忆用量',
  // {percent} 是分割点：两边各自成段，语序由各语言自己决定（照宿主 context.aria 的做法）
  'composer.share': '记忆占上下文 {percent}',
  'composer.figures': '约 {used} / 上限 {budget}',
  'composer.workspace': '本项目',
  'composer.global': '全局',
  'composer.fixed': '固定说明',
  'composer.approx': '约 {n}',
  'composer.counts': '带入 {injected} 条 · 这次新记 {saved} 条',
  'composer.relaxed': '超出上限 {over}，已自动放宽到 {cap}',
  'composer.truncated': '已到上限，{n} 条没带入',
  'composer.handle': '处理 ›',
  'composer.viewInjected': '查看带入的记忆 ›',
} as const

export const composerEn: Record<keyof typeof composerZh, string> = {
  'composer.button': 'Memory',
  'composer.dialog': 'Memory usage',
  'composer.share': 'Memory uses {percent} of context',
  'composer.figures': '~{used} / limit {budget}',
  'composer.workspace': 'This project',
  'composer.global': 'Global',
  'composer.fixed': 'Fixed notes',
  'composer.approx': '~{n}',
  'composer.counts': '{injected} brought in · {saved} new this time',
  'composer.relaxed': 'Over the limit by {over}, relaxed to {cap}',
  'composer.truncated': 'At the limit, {n} not brought in',
  'composer.handle': 'Handle ›',
  'composer.viewInjected': 'View memories brought in ›',
}
