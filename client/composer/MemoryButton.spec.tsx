// 输入框「记忆」按钮：dock 根接假网关 + 假投影，断言显示条件、两种数字、两种超限行、两个跳转。
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { ComponentType } from 'react'
import { GUI_VIEW_VERSION, type SessionView } from '../../src/gui/contract.ts'
import { createFakeGateway } from '../gateway.fake.ts'
import type { ContextPressureProjection, SessionStandardProps } from '../host.ts'
import { createTranslator } from '../i18n.tsx'
import { apply, inject } from '../index.tsx'
import { zh } from '../locales.ts'
import { createNavStore, PANEL_ID, SIDEBAR_TAB_KIND } from '../nav.ts'
import { fakeHostContext } from '../test-utils.tsx'
import { createComposerDock, DOCK_ID, DOCK_ORDER } from './dock.tsx'
import { memoryShare } from './MemoryButton.tsx'

function sessionView(overrides: Partial<SessionView> = {}): SessionView {
  return {
    version: GUI_VIEW_VERSION, sessionId: 's1', workspacePath: '/w/app', frozenAt: 1,
    budget: 4000, overflowMode: 'relax',
    tokens: { workspace: 1870, global: 1050, fixed: 200 },
    usedTokens: 3120, injectedIds: ['a', 'b'], omittedCount: 0, savedIds: ['c'],
    ...overrides,
  }
}

function setup({ view, pressure }: { view?: SessionView; pressure?: ContextPressureProjection } = {}) {
  const gateway = createFakeGateway({ views: view === undefined ? {} : { session: view } })
  const ctx = { layout: { selectPanel: vi.fn() }, sidebarRight: { openTab: vi.fn() } }
  const nav = createNavStore({ tab: 'library' })
  const t = createTranslator(zh)
  const Dock = createComposerDock(ctx, nav, () => gateway, () => t)
  const props: SessionStandardProps = {
    sessionId: 's1',
    useProjection: () => pressure,
    useSessions: selector => selector({ ids: [], byId: {}, phase: 'ready' }),
    useResource: () => ({ status: 'none', value: undefined, failure: undefined }),
  }
  render(<Dock {...props} />)
  return { ctx, nav }
}

const openPanel = () => { fireEvent.click(screen.getByRole('button', { name: '记忆' })); return screen.getByRole('dialog') }

describe('显示条件', () => {
  it('会话视图不存在时不显示按钮', () => {
    setup()
    expect(screen.queryByRole('button', { name: '记忆' })).toBeNull()
  })

  it('带入与新记都为空时不显示', () => {
    setup({ view: sessionView({ injectedIds: [], savedIds: [] }) })
    expect(screen.queryByRole('button', { name: '记忆' })).toBeNull()
  })

  it('只有新记的也显示；按钮只有图标', () => {
    setup({ view: sessionView({ injectedIds: [], savedIds: ['c'] }) })
    const button = screen.getByRole('button', { name: '记忆' })
    expect(button).toHaveTextContent('')
    expect(button).toHaveAttribute('aria-expanded', 'false')
  })
})

describe('弹层数字', () => {
  it('有投影：占比按快照 usedTokens / contextWindow，带约已用 / 上限、三段和条数', () => {
    setup({ view: sessionView(), pressure: { pressureTokens: 50_000, contextWindow: 128_000 } })
    const dialog = openPanel()
    expect(dialog).toHaveTextContent('记忆占上下文2%') // 3,120 / 128,000 ≈ 2.4%，按宿主取整
    expect(dialog).toHaveTextContent('约 3,120 / 上限 4,000')
    expect(dialog).toHaveTextContent('本项目约 1,870')
    expect(dialog).toHaveTextContent('全局约 1,050')
    expect(dialog).toHaveTextContent('固定说明约 200')
    expect(dialog).toHaveTextContent('带入 2 条 · 这次新记 1 条')
    expect(dialog).not.toHaveTextContent('处理 ›')
  })

  it('读不到投影：只写约已用 / 上限，不写百分比', () => {
    setup({ view: sessionView() })
    const dialog = openPanel()
    expect(dialog).toHaveTextContent('约 3,120 / 上限 4,000')
    expect(dialog).not.toHaveTextContent('%')
    expect(dialog).not.toHaveTextContent('记忆占上下文')
  })

  it('不到 1% 写 <1%，有窗口没读数也照算', () => {
    expect(memoryShare(900, { contextWindow: 1_000_000 })).toBe('<1%')
    expect(memoryShare(0, { contextWindow: 128_000 })).toBe('0%')
    expect(memoryShare(3120, {})).toBeNull()
  })
})

describe('超限行', () => {
  it('自动放宽：超出上限 N，已自动放宽到 M · 处理 ›', () => {
    setup({ view: sessionView({ usedTokens: 4480 }) })
    expect(openPanel()).toHaveTextContent('超出上限 480，已自动放宽到 5,000·处理 ›')
  })

  it('严格：已到上限，N 条没带入 · 处理 ›', () => {
    setup({ view: sessionView({ overflowMode: 'strict', usedTokens: 4000, omittedCount: 3 }) })
    const dialog = openPanel()
    expect(dialog).toHaveTextContent('已到上限，3 条没带入·处理 ›')
    expect(dialog).not.toHaveTextContent('放宽')
  })
})

describe('跳转', () => {
  it('「查看带入的记忆 ›」打开右侧栏记忆 tab 并收起弹层', () => {
    const { ctx } = setup({ view: sessionView() })
    openPanel()
    fireEvent.click(screen.getByRole('button', { name: '查看带入的记忆 ›' }))
    expect(ctx.sidebarRight.openTab).toHaveBeenCalledWith(SIDEBAR_TAB_KIND)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('「处理 ›」经 nav store 打开记忆页待处理', () => {
    const { ctx, nav } = setup({ view: sessionView({ overflowMode: 'strict', omittedCount: 2 }) })
    openPanel()
    fireEvent.click(screen.getByRole('button', { name: '处理 ›' }))
    expect(nav.get()).toEqual({ tab: 'pending' })
    expect(ctx.layout.selectPanel).toHaveBeenCalledWith(PANEL_ID)
  })

  it('Esc 收起弹层', () => {
    setup({ view: sessionView() })
    openPanel()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('注册', () => {
  it('apply 在 conversation.composer.dock 注册按钮，依赖 sidebarRight', () => {
    const registered: Array<{ options: { name: string; id?: string; order?: number }; component: ComponentType<never> }> = []
    const ctx = fakeHostContext({
      slots: {
        inject: (_name, fn) => { fn(); return () => {} },
        register: (options, component) => { registered.push({ options, component: component as ComponentType<never> }); return () => {} },
      },
    })
    apply(ctx)
    expect(inject).toContain('sidebarRight')
    const dock = registered.find(r => r.options.name === 'conversation.composer.dock')
    expect(dock?.options).toMatchObject({ id: DOCK_ID, order: DOCK_ORDER })
  })
})
