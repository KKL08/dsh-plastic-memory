import { beforeEach } from 'vitest'
import { fireEvent, screen, within } from '@testing-library/react'
import { GUI_VIEW_VERSION, type HealthView, type PendingItem, type PendingView } from '../../src/gui/contract.ts'
import { createFakeGateway, type FakeGatewayInit } from '../gateway.fake.ts'
import { type PluginConfig } from '../gateway.ts'
import { ALL_SCOPE, createNavStore, type NavStore } from '../nav.ts'
import { memory, NOW, renderInShell, levelCountsOf } from '../test-utils.tsx'
import { PendingTab } from './PendingTab.tsx'

// 待处理 tab：给定一份待处理视图，断言每类卡渲染出什么、点按钮向网关发了什么命令。

const SESSION = { kind: 'ready', sessionId: 's1', cwd: '/w/app' } as const
const config: PluginConfig = { snapshotTokenBudget: 4000, snapshotOverflow: 'relax', governanceEnabled: true, globalPromoteTarget: 'plugin-global', accent: 'ella', customTypes: {} }

const A = memory({ id: 'a', name: 'postgres-in-tests', content: '测试用真实 Postgres。', sourceMode: 'user-explicit' })
const B = memory({ id: 'b', name: 'mock-db-in-tests', content: '测试里 mock 数据库就行。', sourceMode: 'agent-inferred' })
const horizontal: Extract<PendingItem, { kind: 'conflict-horizontal' }> = { kind: 'conflict-horizontal', level: 'your-call', decisionId: 'd-h', firstSeenAt: 1, summary: '测试里怎么准备数据库，两条记忆互相矛盾', left: A, right: B, preferredId: 'a' }
const vertical: Extract<PendingItem, { kind: 'conflict-vertical' }> = { kind: 'conflict-vertical', level: 'your-call', decisionId: 'd-v', firstSeenAt: 2, summary: '包管理器和基线矛盾', memory: memory({ id: 'v', content: '用 npm。' }), baselineRef: 'AGENTS.md：用 pnpm' }
const promote: Extract<PendingItem, { kind: 'promote-candidate' }> = { kind: 'promote-candidate', level: 'your-call', decisionId: 'd-p', firstSeenAt: 3, memory: memory({ id: 'p', content: '所有项目都用 vitest。' }) }
const secret: Extract<PendingItem, { kind: 'secret' }> = { kind: 'secret', level: 'must-fix', memory: memory({ id: 's', content: '部署 token [已隐藏]', filePath: '/m/app/deploy.md' }) }
const overflow: Extract<PendingItem, { kind: 'overflow' }> = { kind: 'overflow', level: 'your-call', decisionId: 'd-o', firstSeenAt: 4, mode: 'relax', tier: 1, workspacePath: '/w/app' }
const unreadable: PendingItem = {
  kind: 'unreadable-file', level: 'must-fix', layer: { kind: 'workspace', workspacePath: '/w/app' }, filePath: '/m/app/broken.md', relativePath: 'app/broken.md',
  error: 'YAMLException: unexpected end of the stream within a flow collection (2:8)',
}

const tidy: Extract<PendingItem, { kind: 'advice' }> = { kind: 'advice', level: 'advice', type: 'bloat', memories: [memory({ id: 't1', name: '很长的一条', digest: 'sha1:t1', filePath: '/m/app/t1.md' })] }

const view = (...items: PendingItem[]): PendingView => ({ version: GUI_VIEW_VERSION, dot: 'amber', items, levelCounts: levelCountsOf(items), typeLabels: { preference: '行为偏好' } })
const scannedHealth = (at: number | null): HealthView => ({
  version: GUI_VIEW_VERSION,
  governanceEnabled: true,
  layers: [{ layer: { kind: 'global' }, totalMemories: 1, score: 1, tier: 'green', gate: { secret: false }, issues: [], lastCheckupAt: at, ignored: [], deductions: { rule: { points: 0, types: [] }, content: { points: 0, types: [] }, freshness: { points: 0, types: [] } } }],
})

function setup(items: PendingItem[], init: FakeGatewayInit = {}, nav: NavStore = createNavStore()) {
  const gateway = createFakeGateway({ session: SESSION, config, views: { pending: view(...items), health: scannedHealth(NOW) }, ...init })
  const utils = renderInShell(<PendingTab nav={nav} session={SESSION} scope={ALL_SCOPE} workspacePath="/w/app" now={NOW} />, gateway)
  const commands = () => gateway.executed.map(e => e.command)
  return { ...utils, gateway, commands }
}

/** Select a horizontal conflict action, then confirm it inline. */
const CONFIRM_OF = { '保留 A': '保留 A', '保留 B': '保留 B', '确实不冲突': '确实不冲突', '记成例外': '记成例外' } as const
function ruleConflict(label: keyof typeof CONFIRM_OF) {
  fireEvent.click(screen.getByRole('button', { name: label }))
  fireEvent.click(within(document.querySelector('.pm-soft-confirm') as HTMLElement).getByRole('button', { name: CONFIRM_OF[label] }))
}

/** Select a vertical conflict action, then confirm it inline. */
const VERTICAL_CONFIRM_OF = { '以文件为准，删除这条': '删除这条', '确实不冲突': '确实不冲突', '记成例外': '记成例外' } as const
function ruleVertical(label: keyof typeof VERTICAL_CONFIRM_OF) {
  fireEvent.click(screen.getByRole('button', { name: label }))
  fireEvent.click(within(document.querySelector('.pm-soft-confirm') as HTMLElement).getByRole('button', { name: VERTICAL_CONFIRM_OF[label] }))
}

// 修改方式的偏好存在本地存储里（edit-modes.tsx），每个用例从默认「让模型改」开始
beforeEach(() => { localStorage.clear() })
export { SESSION, config, A, B, horizontal, vertical, promote, secret, overflow, unreadable, tidy, view, scannedHealth, setup, CONFIRM_OF, ruleConflict, VERTICAL_CONFIRM_OF, ruleVertical }
