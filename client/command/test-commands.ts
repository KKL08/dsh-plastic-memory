// 测试用：每个 `/memory` 子命令一条合法样例。按命令名穷举，schema 加了子命令这里不补就过不了类型检查。
import type { MemoryCommand } from '../../src/gui/contract.ts'

const base = { updatedAt: 1, digest: 'sha1:x' }
const ws = { kind: 'workspace', workspacePath: '/w/app' } as const

export const SAMPLE_COMMANDS: { [K in MemoryCommand['cmd']]: Extract<MemoryCommand, { cmd: K }> } = {
  'info': { cmd: 'info' },
  'resolve': { cmd: 'resolve', decisionId: 'd1', verdict: 'keep-left' },
  'undo': { cmd: 'undo', decisionId: 'd1' },
  'promote': { cmd: 'promote', decisionId: 'd1', target: 'global' },
  'keep-local': { cmd: 'keep-local', decisionId: 'd1' },
  'promote-memory': { cmd: 'promote-memory', memoryId: 'm1', layer: ws },
  'keep-local-memory': { cmd: 'keep-local-memory', memoryId: 'm1', layer: ws },
  'move-memory': { cmd: 'move-memory', memoryId: 'm1', workspacePath: '/w/blog' },
  'forget': { cmd: 'forget', memoryId: 'm1', layer: ws },
  'restore': { cmd: 'restore', memoryId: 'm1', layer: ws },
  'hard-delete': { cmd: 'hard-delete', memoryId: 'm1', layer: ws },
  'confirm': { cmd: 'confirm', memoryId: 'm1', layer: ws },
  'edit-memory': { cmd: 'edit-memory', memoryId: 'm1', layer: ws, base, content: '正文', name: 'n', summary: 's', tags: [] },
  'merge-memories': {
    cmd: 'merge-memories', memories: [{ memoryId: 'm1', layer: ws, base }, { memoryId: 'm2', base }], content: '正文', name: 'n', summary: 's', tags: [],
  },
  'model-info': { cmd: 'model-info' },
  'draft-edit': { cmd: 'draft-edit', adviceType: 'bloat', memories: [{ memoryId: 'm1', layer: ws }] },
  'plan-edits': { cmd: 'plan-edits', memories: [{ memoryId: 'm1', layer: ws, base }, { memoryId: 'm2', layer: ws, base }], request: '合成一条' },
  'dismiss-overflow': { cmd: 'dismiss-overflow', decisionId: 'd1' },
  'ignore-advice': { cmd: 'ignore-advice', type: 'bloat', memories: [{ memoryId: 'm1', layer: ws, base }] },
  'unignore-advice': { cmd: 'unignore-advice', type: 'bloat', memoryIds: ['m1'] },
  'scan': { cmd: 'scan', workspacePath: '/w/app' },
  'set-auto-checkup': { cmd: 'set-auto-checkup', scope: { kind: 'all' }, frequency: 'manual' },
  'refresh-views': { cmd: 'refresh-views' },
  'migrate-type': { cmd: 'migrate-type', from: 'old', action: 'forget' },
}
