// 输入框「记忆」按钮：dock 根接假网关 + 假投影，断言显示条件、两种数字、两种超限行、两个跳转。
import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import type { ComponentType } from 'react'
import { GUI_VIEW_VERSION, type LibraryView, type SessionView } from '../../src/gui/contract.ts'
import { createFakeGateway } from '../gateway.fake.ts'
import type { ContextPressureProjection, SessionStandardProps } from '../host.ts'
import { createTranslator } from '../i18n.tsx'
import { apply, inject } from '../index.tsx'
import { zh } from '../locales.ts'
import { createNavStore, PANEL_ID } from '../nav.ts'
import { fakeHostContext, memory } from '../test-utils.tsx'
import { createComposerDock, DOCK_ID, DOCK_ORDER } from './dock.tsx'
import { memoryShare } from './MemoryButton.tsx'

function sessionView(overrides: Partial<SessionView> = {}): SessionView {
  return {
    version: GUI_VIEW_VERSION, sessionId: 's1', workspacePath: '/w/app', frozenAt: 1, origin: 'start',
    budget: 4000, overflowMode: 'relax',
    tokens: { workspace: 1870, global: 1050, fixed: 200 },
    usedTokens: 3120, injectedIds: ['a', 'b'], coreIds: ['a'], titleOnlyIds: [], omittedCount: 0, savedIds: ['c'],
    ...overrides,
  }
}

function setup({ view, pressure, hasSidebar = true, library }: {
  view?: SessionView; pressure?: ContextPressureProjection; hasSidebar?: boolean; library?: LibraryView
} = {}) {
  const gateway = createFakeGateway({ views: { ...(view === undefined ? {} : { session: view }), ...(library === undefined ? {} : { library }) } })
  const ctx = { layout: { selectPanel: vi.fn() } }
  const openSidebarTab = vi.fn()
  const nav = createNavStore({ view: 'library' }, hasSidebar ? { openSidebarTab } : {})
  const t = createTranslator(zh)
  const Dock = createComposerDock(ctx, nav, () => gateway, () => t)
  const props: SessionStandardProps = {
    sessionId: 's1',
    useProjection: () => pressure,
    useSessions: selector => selector({ ids: [], byId: {}, phase: 'ready' }),
    useResource: () => ({ status: 'none', value: undefined, failure: undefined }),
  }
  render(<Dock {...props} />)
  return { ctx, nav, openSidebarTab, gateway }
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
  it('有投影：占比按三段之和 / contextWindow，「约已用 / 上限」按计入上限的用量，明细和条数', () => {
    setup({ view: sessionView({ usedTokens: 2970 }), pressure: { pressureTokens: 50_000, contextWindow: 128_000 } })
    const dialog = openPanel()
    expect(dialog).toHaveTextContent('记忆占上下文2%') // 3,120 / 128,000 ≈ 2.4%，按宿主取整
    expect(dialog).toHaveTextContent('约 2,970 / 上限 4,000')
    expect(dialog).toHaveTextContent('本项目约 1,870')
    expect(dialog).toHaveTextContent('全局约 1,050')
    expect(dialog).toHaveTextContent('标题约 50')
    expect(dialog).toHaveTextContent('固定说明（不计上限）约 150')
    expect(dialog).toHaveTextContent('开始时带入 2 条 · 新写入 1 条')
    expect(dialog).not.toHaveTextContent('处理 ›')
  })

  it('新写入只数还在的：在这里或别处删掉的、全部记忆里已经没有的都不算（和右侧栏同一口径）', async () => {
    const card = (id: string) => memory({ id, workspacePath: '/w/app' })
    const library: LibraryView = {
      version: GUI_VIEW_VERSION, memoryRoot: '/m', directoryIssues: [],
      layers: [{ layer: { kind: 'global' }, items: [] }, { layer: { kind: 'workspace', workspacePath: '/w/app' }, items: [card('c'), card('d')] }],
    }
    const { gateway } = setup({ view: sessionView({ savedIds: ['c', 'd', 'e'] }), library })
    expect(openPanel()).toHaveTextContent('开始时带入 2 条 · 新写入 2 条') // e 已不在全部记忆里
    await act(async () => { await gateway.execute('s1', { cmd: 'forget', memoryId: 'c', layer: { kind: 'workspace', workspacePath: '/w/app' } }) })
    expect(screen.getByRole('dialog')).toHaveTextContent('开始时带入 2 条 · 新写入 1 条')
  })

  it('续上已有轮次的会话：写「重新带入」', () => {
    setup({ view: sessionView({ origin: 'resumed' }) })
    expect(openPanel()).toHaveTextContent('重新带入 2 条 · 新写入 1 条')
  })

  it('对话中补发了新快照：写「对话中重新带入」', () => {
    setup({ view: sessionView({ origin: 'refreshed' }) })
    expect(openPanel()).toHaveTextContent('对话中重新带入 2 条 · 新写入 1 条')
  })

  it('压缩后重建的：写「压缩后重新带入」，进了新快照的新写入算在带入里，不重复计', () => {
    setup({ view: sessionView({ origin: 'compacted', compactedAt: 1, injectedIds: ['a', 'b', 'c'], savedIds: ['c', 'd'] }) })
    const dialog = openPanel()
    expect(dialog).toHaveTextContent('压缩后重新带入 3 条 · 新写入 1 条')
    expect(dialog).not.toHaveTextContent('开始时带入')
  })

  it('占比的分子是三段之和（真正放进上下文的量），「约已用」的分子是计入上限的 usedTokens（和右侧栏用量条同一口径）', () => {
    setup({ view: sessionView({ usedTokens: 2920 }), pressure: { contextWindow: 10_000 } })
    const dialog = openPanel()
    expect(dialog).toHaveTextContent('记忆占上下文31%') // 3,120 / 10,000；按 usedTokens 会是 29%
    expect(dialog).toHaveTextContent('约 2,920 / 上限 4,000')
  })

  it('少量记忆（本项目 88、全局 93、固定说明 596）：分子不是 777；三段条与明细和右侧栏共用色段、色块，不计上限的部分斜纹', () => {
    setup({ view: sessionView({ tokens: { workspace: 88, global: 93, fixed: 596 }, usedTokens: 211 }) })
    const dialog = openPanel()
    expect(dialog).toHaveTextContent('约 211 / 上限 4,000')
    expect(dialog).not.toHaveTextContent('777')
    const tints = (selector: string) => [...dialog.querySelectorAll(selector)].map(el => [...el.classList].find(c => c.startsWith('pm-budget-tint--')))
    expect(tints('.pm-composer-bar > .pm-budget-seg:not(.pm-budget-seg--fixed), .pm-composer-bar .pm-budget-seg--fixed > i'))
      .toEqual(['pm-budget-tint--workspace', 'pm-budget-tint--global', 'pm-budget-tint--headings', 'pm-budget-tint--uncounted'])
    expect(tints('.pm-composer-rows .pm-budget-swatch'))
      .toEqual(['pm-budget-tint--workspace', 'pm-budget-tint--global', 'pm-budget-tint--headings', 'pm-budget-tint--uncounted'])
    expect(dialog).toHaveTextContent('固定说明（不计上限）约 566')
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
  it('自动放宽：超出上限 N，已自动放宽到 M · 处理 ›；分子是计入上限的用量', () => {
    setup({ view: sessionView({ usedTokens: 4480, tokens: { workspace: 3000, global: 1400, fixed: 300 } }) })
    const dialog = openPanel()
    expect(dialog).toHaveTextContent('约 4,480 / 上限 4,000')
    expect(dialog).toHaveTextContent('超出上限 480，已自动放宽到 5,000·处理 ›')
  })

  it('严格：已到上限，N 条没带入 · 处理 ›', () => {
    setup({ view: sessionView({ overflowMode: 'strict', usedTokens: 4000, omittedCount: 3, tokens: { workspace: 2800, global: 1150, fixed: 250 } }) })
    const dialog = openPanel()
    expect(dialog).toHaveTextContent('约 4,000 / 上限 4,000')
    expect(dialog).toHaveTextContent('已到上限，3 条没带入·处理 ›')
    expect(dialog).not.toHaveTextContent('放宽')
  })
})

describe('跳转', () => {
  it('「查看带入的记忆 ›」经 nav store 打开右侧栏记忆 tab 并收起弹层', () => {
    const { openSidebarTab } = setup({ view: sessionView() })
    openPanel()
    fireEvent.click(screen.getByRole('button', { name: '查看带入的记忆 ›' }))
    expect(openSidebarTab).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('宿主没有右侧栏：不画「查看带入的记忆 ›」', () => {
    setup({ view: sessionView(), hasSidebar: false })
    expect(openPanel()).not.toHaveTextContent('查看带入的记忆')
  })

  it('「处理 ›」经 nav store 打开记忆页待处理', () => {
    const { ctx, nav } = setup({ view: sessionView({ overflowMode: 'strict', omittedCount: 2 }) })
    openPanel()
    fireEvent.click(screen.getByRole('button', { name: '处理 ›' }))
    expect(nav.get()).toEqual({ view: 'todo', fromChat: true })
    expect(ctx.layout.selectPanel).toHaveBeenCalledWith(PANEL_ID)
  })

  it('Esc 收起弹层', () => {
    setup({ view: sessionView() })
    openPanel()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('焦点在弹层里时 Esc 收起，焦点回到「记忆」按钮', () => {
    setup({ view: sessionView() })
    openPanel()
    const link = screen.getByRole('button', { name: '查看带入的记忆 ›' })
    link.focus()
    fireEvent.keyDown(link, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('button', { name: '记忆' })).toHaveFocus()
  })
})

describe('注册', () => {
  it('apply 在 conversation.composer.dock 注册按钮；右侧栏是可选服务，不进 inject', () => {
    const registered: Array<{ options: { name: string; id?: string; order?: number }; component: ComponentType<never> }> = []
    const ctx = fakeHostContext({
      slots: {
        inject: (_name, fn) => { fn(); return () => {} },
        register: (options, component) => { registered.push({ options, component: component as ComponentType<never> }); return () => {} },
      },
    })
    apply(ctx)
    expect(inject).not.toContain('sidebarRight')
    const dock = registered.find(r => r.options.name === 'conversation.composer.dock')
    expect(dock?.options).toMatchObject({ id: DOCK_ID, order: DOCK_ORDER })
  })
})
