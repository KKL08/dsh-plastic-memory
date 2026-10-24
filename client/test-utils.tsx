// 组件测试的渲染入口：真实的面板外壳 + 内存假网关 + 中文字典，和宿主里组件拿到的上下文同构。
import type { ReactElement } from 'react'
import { render } from '@testing-library/react'
import { vi } from 'vitest'
import type { MemoryCard } from '../src/gui/contract.ts'
import { createFakeGateway, type FakeGateway } from './gateway.fake.ts'
import type { HostContext, SidebarHost } from './host.ts'
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

export type FakeHost = HostContext & SidebarHost

/**
 * 假的宿主插件上下文（注册类测试用）：每个服务都是 vi.fn 间谍，slots.inject 立即执行，effect 立即执行。
 * `inject` 照 cordis 语义：依赖的服务都在才执行回调（回调拿到的就是这个上下文）。
 * overrides 按顶层键替换；`remote` 按子服务合并，只改要断言的那一个。
 */
export function fakeHostContext<E extends object = object>(
  overrides: Partial<Omit<FakeHost, 'remote'>> & { remote?: Partial<FakeHost['remote']> } & E = {} as E,
): FakeHost & E {
  const { remote, ...rest } = overrides
  const t = createTranslator(zh) as (key: string) => string
  return {
    inject(deps: string[], fn: (scope: HostContext) => void) {
      if (deps.every(dep => (this as unknown as Record<string, unknown>)[dep] !== undefined)) fn(this)
    },
    effect: vi.fn((execute: () => () => void) => { execute() }),
    slots: {
      inject: (_name: string, fn: () => (() => void) | void) => { fn(); return () => {} },
      register: vi.fn(() => () => {}),
    },
    locale: { register: vi.fn(() => () => {}), bind: () => t, getSnapshot: () => 0, subscribe: () => () => {} },
    layout: { selectPanel: vi.fn() },
    sidebarRight: { openTab: vi.fn() },
    sidebarRightTabs: { register: vi.fn(() => () => {}) },
    pluginNavigation: { openBundle: vi.fn() },
    remote: {
      commands: { execute: vi.fn(async () => ({ ok: false as const, error: { code: 'x', message: 'x' } })) },
      workspaceFiles: { read: vi.fn(async (_sid: string, path: string) => ({ ok: false as const, error: { code: 'workspace-file/not-found', message: path } })) },
      session: { openWorkspacePath: vi.fn(async () => ({ ok: true as const, value: {} })) },
      ...remote,
    },
    ...rest,
  } as FakeHost & E
}
