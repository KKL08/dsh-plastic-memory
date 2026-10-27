import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { GUI_VIEW_VERSION, type HealthView, type LibraryView, type PendingView } from '../src/gui/contract.ts'
import { createFakeGateway } from './gateway.fake.ts'
import { createTranslator } from './i18n.tsx'
import { en } from './locales.ts'
import { MemoryPage } from './MemoryPage.tsx'
import { createNavStore, openMemoryPage, PANEL_ID, type MemoryTab } from './nav.ts'
import { memory, renderInShell } from './test-utils.tsx'
import { PanelShell } from './ui/PanelShell.tsx'

const pending: PendingView = {
  version: GUI_VIEW_VERSION, dot: 'amber', typeLabels: {},
  items: [{ kind: 'promote-candidate', level: 'your-call', decisionId: 'd1', firstSeenAt: 1, memory: memory() }],
  levelCounts: { 'must-fix': 0, 'your-call': 1, 'advice': 0 },
}
const library: LibraryView = {
  version: GUI_VIEW_VERSION, memoryRoot: '/h/memories', directoryIssues: [],
  layers: [
    { layer: { kind: 'global' }, items: [memory({ id: 'g1', scope: 'global' })] },
    { layer: { kind: 'workspace', workspacePath: '/w/app' }, items: [memory({ id: 'a1' }), memory({ id: 'a2' })] },
    { layer: { kind: 'workspace', workspacePath: '/w/blog' }, items: [memory({ id: 'b1' })] },
  ],
}

describe('记忆页外壳', () => {
  it('无会话：标题 + 空态「开一个会话后这里可用」，没有 tab 和作用域下拉', () => {
    renderInShell(<MemoryPage nav={createNavStore()} />, createFakeGateway({ session: { kind: 'none' } }))
    expect(screen.getByRole('heading', { level: 1, name: '记忆' })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('开一个会话后这里可用')
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(screen.queryByRole('button', { name: /本项目/ })).toBeNull()
  })

  it('有会话：四个 tab 依次是待处理、健康、记忆查看、最近删除，待处理与记忆查看带数；默认作用域是当前项目，并按它借会话', () => {
    const gateway = createFakeGateway({ currentWorkspace: '/w/app', views: { pending, library } })
    renderInShell(<MemoryPage nav={createNavStore()} />, gateway)
    expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual(['待处理1', '健康', '记忆查看2', '最近删除'])
    expect(screen.getByRole('tab', { name: /待处理/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('button', { name: /本项目 app/ })).toHaveAttribute('aria-haspopup', 'listbox')
    expect(screen.getByRole('tabpanel')).toHaveTextContent('这条适合所有项目')
    expect(gateway.sessionRequests.at(-1)).toBe('/w/app')
  })

  it('待处理 tab 的数 = 高优问题 + 待你处理（读不出的文件也算）', () => {
    const conflict = { kind: 'conflict-horizontal', level: 'your-call', decisionId: 'd2', firstSeenAt: 2, summary: 's', left: null, right: null } as const
    const leveled: PendingView = {
      ...pending,
      items: [
        { kind: 'secret', level: 'must-fix', memory: memory({ id: 's1' }) },
        { kind: 'unreadable-file', level: 'must-fix', layer: { kind: 'global' }, filePath: '/m/x.md', relativePath: 'x.md', error: 'bad' },
        ...pending.items, conflict,
      ],
      levelCounts: { 'must-fix': 2, 'your-call': 2, 'advice': 0 },
    }
    renderInShell(<MemoryPage nav={createNavStore()} />, createFakeGateway({ currentWorkspace: '/w/app', views: { pending: leveled, library } }))
    expect(screen.getByRole('tab', { name: /待处理/ })).toHaveTextContent('待处理4')
  })

  it('待处理 tab 写「待处理 N · 建议 M」：建议条数灰色单写、不进主数；没有建议时不写后半段', () => {
    const advice: PendingView['items'][number] = { kind: 'advice', level: 'advice', type: 'stale', memories: [memory({ id: 'x' })] }
    const withAdvice: PendingView = { ...pending, items: [...pending.items, advice, advice], levelCounts: { 'must-fix': 0, 'your-call': 1, 'advice': 2 } }
    const gateway = createFakeGateway({ currentWorkspace: '/w/app', views: { pending: withAdvice, library } })
    renderInShell(<MemoryPage nav={createNavStore()} />, gateway)
    const tab = screen.getByRole('tab', { name: /待处理/ })
    expect([...tab.querySelectorAll('.pm-tab-count')].map(n => n.textContent)).toEqual(['1', '· 建议 2'])
    act(() => { gateway.setView('pending', pending) })
    expect([...tab.querySelectorAll('.pm-tab-count')].map(n => n.textContent)).toEqual(['1'])
  })

  it('只有建议整理：主数写 0，仍落在待处理', () => {
    const advice: PendingView['items'][number] = { kind: 'advice', level: 'advice', type: 'bloat', memories: [memory({ id: 'x' })] }
    const onlyAdvice: PendingView = { ...pending, dot: 'none', items: [advice], levelCounts: { 'must-fix': 0, 'your-call': 0, 'advice': 1 } }
    const nav = createNavStore()
    renderInShell(<MemoryPage nav={nav} />, createFakeGateway({ currentWorkspace: '/w/app', views: { pending: onlyAdvice, library } }))
    expect([...screen.getByRole('tab', { name: /待处理/ }).querySelectorAll('.pm-tab-count')].map(n => n.textContent)).toEqual(['0', '· 建议 1'])
    expect(nav.get().tab).toBe('pending')
  })

  it('英文界面：tab 依次是 Pending、Health、Browse、Recently deleted', () => {
    const gateway = createFakeGateway({ currentWorkspace: '/w/app', views: { pending, library } })
    render(<PanelShell gateway={gateway} t={createTranslator(en)}><MemoryPage nav={createNavStore()} /></PanelShell>)
    expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual(['Pending1', 'Health', 'Browse2', 'Recently deleted'])
  })

  it('当前项目还在确认（会话归属对照没读到）：只显示读取中，不先按别的作用域渲染再跳；确认后直接落在当前项目', () => {
    const gateway = createFakeGateway({ currentWorkspace: { status: 'loading' }, views: { pending, library } })
    renderInShell(<MemoryPage nav={createNavStore()} />, gateway)
    expect(screen.getByRole('status')).toHaveTextContent('正在读取…')
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(screen.queryByRole('button', { name: /全局|本项目/ })).toBeNull()
    act(() => { gateway.setCurrentWorkspace('/w/app') })
    expect(screen.getByRole('button', { name: /本项目 app/ })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /记忆查看/ })).toHaveTextContent('记忆查看2')
  })

  it('作用域下拉列出当前项目、视图里的其他项目和全局；选了写回导航 store、按新作用域借会话', () => {
    const gateway = createFakeGateway({ currentWorkspace: '/w/app', views: { pending, library } })
    const nav = createNavStore()
    renderInShell(<MemoryPage nav={nav} />, gateway)
    fireEvent.click(screen.getByRole('button', { name: /本项目 app/ }))
    expect(screen.getAllByRole('option').map(o => o.textContent)).toEqual(['本项目 app', 'blog', '全局'])
    fireEvent.click(screen.getByRole('option', { name: '全局' }))
    expect(nav.get().scope).toEqual({ kind: 'global' })
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(screen.getByRole('tab', { name: /记忆查看/ })).toHaveTextContent('记忆查看1')
    expect(gateway.sessionRequests.at(-1)).toBeUndefined()
  })

  describe('作用域下拉的键盘操作（listbox）', () => {
    const open = () => {
      const gateway = createFakeGateway({ currentWorkspace: '/w/app', views: { pending, library } })
      const nav = createNavStore()
      renderInShell(<MemoryPage nav={nav} />, gateway)
      const button = screen.getByRole('button', { name: /本项目 app/ })
      button.focus()
      return { nav, button }
    }
    const option = (name: string) => screen.getByRole('option', { name })

    it('打开时焦点落在选中项；上下键逐项移动，Home / End 到首尾', () => {
      const { button } = open()
      fireEvent.click(button)
      expect(option('本项目 app')).toHaveFocus()
      fireEvent.keyDown(option('本项目 app'), { key: 'ArrowDown' })
      expect(option('blog')).toHaveFocus()
      fireEvent.keyDown(option('blog'), { key: 'ArrowDown' })
      fireEvent.keyDown(option('全局'), { key: 'ArrowDown' })
      expect(option('全局')).toHaveFocus()
      fireEvent.keyDown(option('全局'), { key: 'ArrowUp' })
      expect(option('blog')).toHaveFocus()
      fireEvent.keyDown(option('blog'), { key: 'Home' })
      expect(option('本项目 app')).toHaveFocus()
      fireEvent.keyDown(option('本项目 app'), { key: 'End' })
      expect(option('全局')).toHaveFocus()
    })

    it('按钮上按下键也能打开；选项不在 Tab 序列里，焦点靠方向键移动', () => {
      const { button } = open()
      fireEvent.keyDown(button, { key: 'ArrowDown' })
      expect(screen.getByRole('listbox')).toBeInTheDocument()
      expect(option('本项目 app')).toHaveFocus()
      expect(screen.getAllByRole('option').map(o => o.tabIndex)).toEqual([-1, -1, -1])
    })

    it('回车或空格选中，收起后焦点回到按钮', () => {
      const { nav, button } = open()
      fireEvent.click(button)
      fireEvent.keyDown(option('本项目 app'), { key: 'End' })
      expect(option('全局')).toHaveFocus()
      fireEvent.keyDown(option('全局'), { key: 'Enter' })
      expect(nav.get().scope).toEqual({ kind: 'global' })
      expect(screen.queryByRole('listbox')).toBeNull()
      expect(screen.getByRole('button', { name: '全局' })).toHaveFocus()

      fireEvent.click(screen.getByRole('button', { name: '全局' }))
      expect(option('全局')).toHaveFocus()
      fireEvent.keyDown(option('全局'), { key: 'ArrowDown' })
      expect(option('blog')).toHaveFocus()
      fireEvent.keyDown(option('blog'), { key: ' ' })
      expect(nav.get().scope).toEqual({ kind: 'workspace', workspacePath: '/w/blog' })
      expect(screen.getByRole('button', { name: 'blog' })).toHaveFocus()
    })

    it('焦点在选项上按 Esc：收起，焦点回到按钮，作用域不变', () => {
      const { nav, button } = open()
      fireEvent.click(button)
      option('blog').focus()
      fireEvent.keyDown(option('blog'), { key: 'Escape' })
      expect(screen.queryByRole('listbox')).toBeNull()
      expect(button).toHaveFocus()
      expect(nav.get().scope).toBeUndefined()
    })
  })

  it('切 tab 写回导航 store', () => {
    const nav = createNavStore()
    renderInShell(<MemoryPage nav={nav} />, createFakeGateway({ views: { pending, library } }))
    fireEvent.click(screen.getByRole('tab', { name: '健康' }))
    expect(nav.get().tab).toBe('health')
    expect(screen.getByRole('tab', { name: '健康' })).toHaveAttribute('aria-selected', 'true')
  })

  it('健康页「去处理 ›」：切到待处理，焦点落在对应组的标题上；之后切 tab 不再带着组定位', () => {
    const health: HealthView = {
      version: GUI_VIEW_VERSION, governanceEnabled: true,
      layers: [{
        layer: { kind: 'workspace', workspacePath: '/w/app' }, totalMemories: 1, score: 90, tier: 'green', gate: { secret: false },
        issues: [{ type: 'expired', count: 1, level: 'advice' }], staleCount: 0, semanticCachedAt: 1, overflow: null, ignored: [],
      }],
    }
    const expired: PendingView['items'][number] = { kind: 'advice', level: 'advice', type: 'expired', memories: [memory({ id: 'e1' })] }
    const withAdvice: PendingView = { ...pending, items: [...pending.items, expired], levelCounts: { 'must-fix': 0, 'your-call': 1, 'advice': 1 } }
    const nav = createNavStore()
    openMemoryPage({ layout: { selectPanel: vi.fn() } }, nav, { tab: 'health' })
    renderInShell(<MemoryPage nav={nav} />, createFakeGateway({ currentWorkspace: '/w/app', views: { pending: withAdvice, library, health } }))
    fireEvent.click(screen.getByRole('button', { name: '已过有效期 1 条 去处理 ›' }))
    expect(screen.getByRole('tab', { name: /待处理/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('heading', { level: 2, name: '建议整理 1' })).toHaveFocus()
    fireEvent.click(screen.getByRole('tab', { name: '健康' }))
    expect(nav.get()).toEqual({ tab: 'health', memoryId: undefined })
  })

  it('入口直达：先写目标再切面板，页面跟着目标走', () => {
    const nav = createNavStore()
    const order: string[] = []
    const selectPanel = vi.fn(() => { order.push('select') })
    renderInShell(<MemoryPage nav={nav} />, createFakeGateway({ currentWorkspace: '/w/app', views: { pending, library } }))
    nav.subscribe(() => { order.push('nav') })
    act(() => { openMemoryPage({ layout: { selectPanel } }, nav, { tab: 'library', scope: { kind: 'workspace', workspacePath: '/w/blog' }, memoryId: 'b1' }) })
    expect(order).toEqual(['nav', 'select'])
    expect(selectPanel).toHaveBeenCalledWith(PANEL_ID)
    expect(nav.get()).toEqual({ tab: 'library', scope: { kind: 'workspace', workspacePath: '/w/blog' }, memoryId: 'b1' })
    expect(screen.getByRole('tab', { name: /记忆查看/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('button', { name: 'blog' })).toBeInTheDocument()
  })

  it('页头右上「设置」跳插件页里本插件的配置；没有会话时也在', () => {
    const openSettings = vi.fn()
    const { unmount } = renderInShell(<MemoryPage nav={createNavStore(undefined, { openSettings })} />, createFakeGateway({ views: { pending, library } }))
    fireEvent.click(screen.getByRole('button', { name: '设置' }))
    expect(openSettings).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: '体检当前项目' })).toBeInTheDocument()
    unmount()
    renderInShell(<MemoryPage nav={createNavStore(undefined, { openSettings })} />, createFakeGateway({ session: { kind: 'none' } }))
    fireEvent.click(screen.getByRole('button', { name: '设置' }))
    expect(openSettings).toHaveBeenCalledTimes(2)
  })

  it('会话从无到有：空态换成 tab', () => {
    const gateway = createFakeGateway({ session: { kind: 'none' }, views: { pending, library } })
    renderInShell(<MemoryPage nav={createNavStore()} />, gateway)
    expect(screen.queryByRole('tablist')).toBeNull()
    act(() => { gateway.setSession({ kind: 'ready', sessionId: 's1', cwd: undefined }) })
    expect(screen.getByRole('tablist')).toBeInTheDocument()
  })
})

// 左栏图标入口：点图标是宿主行为（selectPanel 只收面板 id），记忆页挂载时没有入口写过目标，就按默认落点：
// 待处理有条目落在待处理，为空落在记忆查看（当前项目）。入口先写过目标的，照目标走。
describe('左栏图标入口的落点', () => {
  const emptyPending: PendingView = { ...pending, dot: 'none', items: [] }
  const tabSelected = (name: RegExp) => expect(screen.getByRole('tab', { name })).toHaveAttribute('aria-selected', 'true')

  it('待处理有条目：落在待处理，作用域回到当前项目', () => {
    const nav = createNavStore({ tab: 'deleted', scope: { kind: 'global' } })
    renderInShell(<MemoryPage nav={nav} />, createFakeGateway({ currentWorkspace: '/w/app', views: { pending, library } }))
    expect(nav.get()).toEqual({ tab: 'pending' })
    tabSelected(/待处理/)
    expect(screen.getByRole('button', { name: /本项目 app/ })).toBeInTheDocument()
  })

  it('待处理为空：落在记忆查看；视图晚到也按到达时判断', () => {
    const gateway = createFakeGateway({ currentWorkspace: '/w/app', views: { pending: { status: 'loading' }, library } })
    const nav = createNavStore()
    renderInShell(<MemoryPage nav={nav} />, gateway)
    tabSelected(/待处理/)
    act(() => { gateway.setView('pending', emptyPending) })
    expect(nav.get()).toEqual({ tab: 'library' })
    tabSelected(/记忆查看/)
    // 只落一次：之后待处理再变空也不再跳
    act(() => { nav.update({ tab: 'health' }) })
    act(() => { gateway.setView('pending', { ...emptyPending }) })
    expect(nav.get().tab).toBe('health')
  })

  it('视图到达前用户已经切了 tab：不再改落点', () => {
    const gateway = createFakeGateway({ views: { pending: { status: 'loading' }, library } })
    const nav = createNavStore()
    renderInShell(<MemoryPage nav={nav} />, gateway)
    fireEvent.click(screen.getByRole('tab', { name: '健康' }))
    act(() => { gateway.setView('pending', emptyPending) })
    expect(nav.get().tab).toBe('health')
  })

  it('入口先写了目标再切面板：记忆页照目标走，不套默认落点', () => {
    const nav = createNavStore()
    const target = { tab: 'library', scope: { kind: 'workspace', workspacePath: '/w/blog' }, memoryId: 'b1' } as const
    openMemoryPage({ layout: { selectPanel: vi.fn() } }, nav, target)
    renderInShell(<MemoryPage nav={nav} />, createFakeGateway({ currentWorkspace: '/w/app', views: { pending, library } }))
    expect(nav.get()).toEqual(target)
    tabSelected(/记忆查看/)
  })

  it('入口按内部 tab 标识直达：每个标识落到原来的 tab（改序改名不影响旧链接）', () => {
    const shown: Record<MemoryTab, RegExp> = { pending: /待处理/, health: /健康/, library: /记忆查看/, deleted: /最近删除/ }
    for (const tab of Object.keys(shown) as MemoryTab[]) {
      const nav = createNavStore()
      openMemoryPage({ layout: { selectPanel: vi.fn() } }, nav, { tab })
      const { unmount } = renderInShell(<MemoryPage nav={nav} />, createFakeGateway({ currentWorkspace: '/w/app', views: { pending, library } }))
      expect(nav.get()).toEqual({ tab })
      tabSelected(shown[tab])
      unmount()
    }
  })

  it('入口在记忆页开着时写的目标当场生效；下次从图标进来照样按默认落点', () => {
    const nav = createNavStore()
    const gateway = createFakeGateway({ currentWorkspace: '/w/app', views: { pending, library } })
    const first = renderInShell(<MemoryPage nav={nav} />, gateway)
    act(() => { openMemoryPage({ layout: { selectPanel: vi.fn() } }, nav, { tab: 'deleted' }) })
    tabSelected(/最近删除/)
    first.unmount()
    renderInShell(<MemoryPage nav={nav} />, gateway)
    expect(nav.get()).toEqual({ tab: 'pending' })
  })
})
