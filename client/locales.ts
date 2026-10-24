/**
 * 客户端界面文案（`ctx.locale.register(NS, {zh, en})`）。插件元信息（标题、描述）在仓库根 `locale/*.json`，
 * 那是宿主插件页读的，和这里分开。占位符 `{name}` 由宿主 locale 服务替换。
 */

import { composerEn, composerZh } from './locales/composer.ts'
import { libraryEn, libraryZh } from './locales/library.ts'

/** 宿主 locale 命名空间，和面板 id 同名。 */
export const NS = 'plastic-memory'

export const zh = {
  'nav.label': '记忆',

  'page.title': '记忆',
  'page.placeholder': '这一栏还在做。',

  'scope.label': '作用域',
  'scope.current': '本项目 {name}',
  'scope.global': '全局',
  'scope.workspace': '本项目',

  'tabs.label': '记忆视图',
  'tab.pending': '待处理',
  'tab.library': '全部记忆',
  'tab.health': '健康',
  'tab.deleted': '最近删除',

  'session.none.title': '开一个会话后这里可用',
  'session.none.body': '记忆页要借一个会话来读取记忆、执行操作。在任意项目里开一个会话，回到这里就能用。',
  'session.none.hint': '先开一个会话',

  'view.loading': '正在读取…',
  'view.missing': '还没有生成这份数据。',
  'view.outdated': '数据格式已更新，需要刷新。',
  'view.error': '读取失败：{message}',

  'time.justNow': '刚刚',
  'time.monthDay': '{month} 月 {day} 日',
  'time.yearMonthDay': '{year} 年 {month} 月 {day} 日',

  'source.user-explicit': '你明确说的',
  'source.user-behavior': '从你的做法看出',
  'source.environment-observed': '从环境观察到',
  'source.agent-inferred': 'agent 推断',
  'source.agent-action-confirmed': 'agent 操作后确认',
  'source.none': '无出处',
  'memory.expired': '不再带入对话',

  'marker.pending': '等你决定',
  'marker.secret': '有密钥要处理',
  'marker.ok': '状态良好',

  'conflict.title': '两条记忆互相矛盾，等你决定',
  'conflict.side': '记忆 {side}',
  'conflict.keepA': '以 A 为准',
  'conflict.keepB': '以 B 为准',
  'conflict.keepBoth': '都保留',
  'conflict.consequence': '以 A 为准会删掉 B，以 B 为准会删掉 A，14 天内可恢复。都保留：以后体检不再把它们当冲突。',
  'conflict.missing': '这条记忆找不到了，可能已经被删除。',
  'conflict.missingHint': '有一条记忆找不到了，先重新体检',

  'budget.summary': '{count} 条 · 约 {used} / {budget}',
  'budget.workspace': '本项目 {n}',
  'budget.global': '全局 {n}',
  'budget.fixed': '固定说明 {n}',
  'budget.allIn': '全部带入',
  'budget.truncated': '已到上限，{n} 条没带入',
  'budget.handle': '处理 ›',
  'budget.relaxed': '已放宽到 {cap}',
  'budget.aria': '已用 {percent}%：本项目 {workspace}，全局 {global}，固定说明 {fixed}',

  'settings.save': '保存',
  'settings.saving': '正在保存…',
  'settings.saveFailed': '没有保存成功，再试一次。',
  'settings.readOnly': '当前配置是只读的，改不了。',
  'settings.unavailable': '宿主暂时没有提供这份配置。',
  ...composerZh,
  ...libraryZh,
} as const

export type LocaleKey = keyof typeof zh

export const en: Record<LocaleKey, string> = {
  'nav.label': 'Memory',

  'page.title': 'Memory',
  'page.placeholder': 'This view is still being built.',

  'scope.label': 'Scope',
  'scope.current': 'This project {name}',
  'scope.global': 'Global',
  'scope.workspace': 'This project',

  'tabs.label': 'Memory views',
  'tab.pending': 'Pending',
  'tab.library': 'All memories',
  'tab.health': 'Health',
  'tab.deleted': 'Recently deleted',

  'session.none.title': 'Available once you open a session',
  'session.none.body': 'The Memory page borrows a session to read memories and run actions. Open a session in any project, then come back here.',
  'session.none.hint': 'Open a session first',

  'view.loading': 'Loading…',
  'view.missing': 'This data has not been generated yet.',
  'view.outdated': 'The data format changed and needs a refresh.',
  'view.error': 'Could not read: {message}',

  'time.justNow': 'Just now',
  'time.monthDay': '{monthName} {day}',
  'time.yearMonthDay': '{monthName} {day}, {year}',

  'source.user-explicit': 'You said so',
  'source.user-behavior': 'From what you did',
  'source.environment-observed': 'Observed in the environment',
  'source.agent-inferred': 'Inferred by the agent',
  'source.agent-action-confirmed': 'Confirmed after an agent action',
  'source.none': 'No source',
  'memory.expired': 'No longer brought into chats',

  'marker.pending': 'Waiting for your decision',
  'marker.secret': 'A secret needs attention',
  'marker.ok': 'All good',

  'conflict.title': 'Two memories contradict each other',
  'conflict.side': 'Memory {side}',
  'conflict.keepA': 'Go with A',
  'conflict.keepB': 'Go with B',
  'conflict.keepBoth': 'Keep both',
  'conflict.consequence': 'Going with A deletes B and going with B deletes A; either can be restored within 14 days. Keep both: future checkups stop treating them as a conflict.',
  'conflict.missing': 'This memory can no longer be found. It may have been deleted.',
  'conflict.missingHint': 'One memory is missing. Run a checkup first',

  'budget.summary': '{count} memories · ~{used} / {budget}',
  'budget.workspace': 'This project {n}',
  'budget.global': 'Global {n}',
  'budget.fixed': 'Fixed notes {n}',
  'budget.allIn': 'All brought in',
  'budget.truncated': 'At the limit, {n} not brought in',
  'budget.handle': 'Handle ›',
  'budget.relaxed': 'Relaxed to {cap}',
  'budget.aria': '{percent}% used: this project {workspace}, global {global}, fixed notes {fixed}',

  'settings.save': 'Save',
  'settings.saving': 'Saving…',
  'settings.saveFailed': 'Could not save. Try again.',
  'settings.readOnly': 'These settings are read-only.',
  'settings.unavailable': 'The host is not serving these settings right now.',
  ...composerEn,
  ...libraryEn,
}
