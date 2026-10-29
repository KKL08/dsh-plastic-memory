/** 输入框「记忆」按钮与弹层的文案，由 locales.ts 合并进同一命名空间。 */

export const composerZh = {
  'composer.button': '记忆',
  'composer.dialog': '记忆用量',
  // {percent} 是分割点：两边各自成段，语序由各语言自己决定（照宿主 context.aria 的做法）
  'composer.share': '记忆占上下文 {percent}',
  'composer.figures': '约 {used} / 上限 {budget}',
  'composer.approx': '约 {n}',
  'composer.counts': '开始时带入 {injected} 条 · 新写入 {saved} 条',
  'composer.countsResumed': '重新带入 {injected} 条 · 新写入 {saved} 条',
  'composer.countsCompacted': '压缩后重新带入 {injected} 条 · 新写入 {saved} 条',
  'composer.countsRefreshed': '对话中重新带入 {injected} 条 · 新写入 {saved} 条',
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
  'composer.approx': '~{n}',
  'composer.counts': '{injected} brought in at start · {saved} newly written',
  'composer.countsResumed': '{injected} brought in again · {saved} newly written',
  'composer.countsCompacted': '{injected} brought in again after compaction · {saved} newly written',
  'composer.countsRefreshed': '{injected} brought in again during the chat · {saved} newly written',
  'composer.relaxed': 'Over the limit by {over}, relaxed to {cap}',
  'composer.truncated': 'At the limit, {n} not brought in',
  'composer.handle': 'Handle ›',
  'composer.viewInjected': 'View memories brought in ›',
}
