// 组件测试的渲染入口：真实的面板外壳 + 内存假网关 + 中文字典，和宿主里组件拿到的上下文同构。
import type { ReactElement } from 'react'
import { render } from '@testing-library/react'
import type { MemoryCard } from '../src/gui/contract.ts'
import { createFakeGateway, type FakeGateway } from './gateway.fake.ts'
import { createTranslator } from './i18n.tsx'
import { zh } from './locales.ts'
import { PanelShell } from './ui/PanelShell.tsx'

export function renderInShell(ui: ReactElement, gateway: FakeGateway = createFakeGateway()) {
  return { gateway, ...render(<PanelShell gateway={gateway} t={createTranslator(zh)}>{ui}</PanelShell>) }
}

/** 2026-10-17 10:00（本机时区）。 */
export const NOW = new Date(2026, 9, 17, 10, 0).getTime()

export function memory(overrides: Partial<MemoryCard> = {}): MemoryCard {
  return {
    id: 'm1', name: 'db-in-tests', type: 'preference', scope: 'workspace', workspacePath: '/w/app',
    summary: '测试不 mock 数据库', content: '测试里不要 mock 数据库，用 testcontainers 起真实 Postgres。', tags: [],
    sourceMode: 'user-explicit', createdAt: NOW, updatedAt: new Date(2026, 8, 12).getTime(), lastConfirmedAt: NOW,
    filePath: '/m/app/db-in-tests.md',
    ...overrides,
  }
}
