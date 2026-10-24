/**
 * 右侧栏「记忆」tab 与「开始」页入口的文案，由 locales.ts 合并进同一个命名空间。
 * 类型名是内置与模板类型的显示名（对照 src/type-registry.ts）；自定义类型视图里没有显示名，直接显示类型 id。
 */

export const sidebarZh = {
  'sidebar.tab.title': '记忆',
  'sidebar.guide.title': '记忆',
  'sidebar.guide.description': '这次对话带入和新记的记忆',

  'sidebar.crumb.scope': '本项目 /',
  'sidebar.usage.title': '这次对话带入的记忆',
  'sidebar.saved.title': '这次对话新记的',
  'sidebar.groups.title': '带入的记忆',
  'sidebar.saved.delete': '删除这条记忆',

  'sidebar.empty.title': '还没有记忆',
  'sidebar.empty.body': 'agent 在对话里记下你的偏好、项目约定后，每次对话带入了哪些会列在这里。',
  'sidebar.globalOnly': '本项目还没有记忆，这次带入的都是全局记忆。',
  'sidebar.noSnapshot.title': '这次对话还没带入记忆',
  'sidebar.noSnapshot.body': '发出第一条消息后，这里会列出带入的记忆和用量。',
  'sidebar.stale.title': '重启后未重新带入',
  'sidebar.stale.body': '宿主重启过，这次对话还没重新带入记忆，继续对话后这里会更新。下面是重启前带入的。',

  'sidebar.footer.pending': '本项目还有 {n} 处待处理',
  'sidebar.footer.pendingLink': '在记忆页处理 ›',
  'sidebar.footer.count': '本项目 {n} 条记忆',
  'sidebar.footer.countLink': '在记忆页查看 ›',

  'sidebar.ruled.keepA': '已按 A',
  'sidebar.ruled.keepB': '已按 B',
  'sidebar.ruled.keepBoth': '都保留',
  'sidebar.ruled.deletedA': 'A 已删除，14 天内可恢复。',
  'sidebar.ruled.deletedB': 'B 已删除，14 天内可恢复。',
  'sidebar.ruled.keptBoth': '以后体检不再把它们当冲突。',
  'sidebar.ruled.keepBaseline': '已按基线',
  'sidebar.ruled.keepMemory': '已保留这条记忆',
  'sidebar.ruled.deletedMemory': '这条记忆已删除，14 天内可恢复。',
  'sidebar.ruled.keptMemory': '基线和记忆都不变时不再报。',
  'sidebar.ruled.undo': '撤销',
  'sidebar.action.busy': '正在处理…',
  'sidebar.action.failed': '没有成功：{detail}',

  'sidebar.type.profile': '用户画像',
  'sidebar.type.preference': '行为偏好',
  'sidebar.type.knowledge': '事实与经验',
  'sidebar.type.project': '项目信息',
  'sidebar.type.reference': '参考引用',
  'sidebar.type.procedure': '可复用流程',
  'sidebar.type.decision': '决定',
  'sidebar.type.commitment': '承诺',
  'sidebar.type.person': '人物',
} as const

export const sidebarEn: Record<keyof typeof sidebarZh, string> = {
  'sidebar.tab.title': 'Memory',
  'sidebar.guide.title': 'Memory',
  'sidebar.guide.description': 'Memories this chat brought in and saved',

  'sidebar.crumb.scope': 'This project /',
  'sidebar.usage.title': 'Brought into this chat',
  'sidebar.saved.title': 'Saved in this chat',
  'sidebar.groups.title': 'Brought-in memories',
  'sidebar.saved.delete': 'Delete this memory',

  'sidebar.empty.title': 'No memories yet',
  'sidebar.empty.body': 'Once the agent saves your preferences and project conventions during chats, this tab lists which ones each chat brings in.',
  'sidebar.globalOnly': 'This project has no memories yet. Everything brought in is global.',
  'sidebar.noSnapshot.title': 'Nothing brought into this chat yet',
  'sidebar.noSnapshot.body': 'After the first message, this tab lists the memories brought in and how much they use.',
  'sidebar.stale.title': 'Not brought in again since the restart',
  'sidebar.stale.body': 'The host restarted and this chat has not brought memories in again. This updates once the chat continues. Below is what was brought in before the restart.',

  'sidebar.footer.pending': '{n} more pending in this project',
  'sidebar.footer.pendingLink': 'Handle on the Memory page ›',
  'sidebar.footer.count': '{n} memories in this project',
  'sidebar.footer.countLink': 'View on the Memory page ›',

  'sidebar.ruled.keepA': 'Went with A',
  'sidebar.ruled.keepB': 'Went with B',
  'sidebar.ruled.keepBoth': 'Kept both',
  'sidebar.ruled.deletedA': 'A was deleted. It can be restored within 14 days.',
  'sidebar.ruled.deletedB': 'B was deleted. It can be restored within 14 days.',
  'sidebar.ruled.keptBoth': 'Future checkups will not treat them as a conflict.',
  'sidebar.ruled.keepBaseline': 'Went with the baseline',
  'sidebar.ruled.keepMemory': 'Kept this memory',
  'sidebar.ruled.deletedMemory': 'This memory was deleted. It can be restored within 14 days.',
  'sidebar.ruled.keptMemory': 'Not reported again while neither changes.',
  'sidebar.ruled.undo': 'Undo',
  'sidebar.action.busy': 'Working…',
  'sidebar.action.failed': 'Did not go through: {detail}',

  'sidebar.type.profile': 'Profile',
  'sidebar.type.preference': 'Preference',
  'sidebar.type.knowledge': 'Facts & lessons',
  'sidebar.type.project': 'Project',
  'sidebar.type.reference': 'Reference',
  'sidebar.type.procedure': 'Procedure',
  'sidebar.type.decision': 'Decision',
  'sidebar.type.commitment': 'Commitment',
  'sidebar.type.person': 'Person',
}
