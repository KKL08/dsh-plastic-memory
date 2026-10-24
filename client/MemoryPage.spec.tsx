import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, screen } from '@testing-library/react'
import { GUI_VIEW_VERSION, type LibraryView, type PendingView } from '../src/gui/contract.ts'
import { createFakeGateway } from './gateway.fake.ts'
import { MemoryPage } from './MemoryPage.tsx'
import { createNavStore, openMemoryPage, PANEL_ID } from './nav.ts'
import { memory, renderInShell } from './test-utils.tsx'

const pending: PendingView = {
  version: GUI_VIEW_VERSION, dot: 'amber', typeLabels: {},
  items: [{ kind: 'promote-candidate', decisionId: 'd1', firstSeenAt: 1, memory: memory() }],
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

  it('有会话：四个 tab，待处理与全部记忆带数；默认作用域是当前项目，并按它借会话', () => {
    const gateway = createFakeGateway({ currentWorkspace: '/w/app', views: { pending, library } })
    renderInShell(<MemoryPage nav={createNavStore()} />, gateway)
    expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual(['待处理1', '全部记忆2', '健康', '最近删除'])
    expect(screen.getByRole('tab', { name: /待处理/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('button', { name: /本项目 app/ })).toHaveAttribute('aria-haspopup', 'listbox')
    expect(screen.getByRole('tabpanel')).toHaveTextContent('这条适合所有项目')
    expect(gateway.sessionRequests.at(-1)).toBe('/w/app')
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
    expect(screen.getByRole('tab', { name: /全部记忆/ })).toHaveTextContent('全部记忆1')
    expect(gateway.sessionRequests.at(-1)).toBeUndefined()
  })

  it('切 tab 写回导航 store', () => {
    const nav = createNavStore()
    renderInShell(<MemoryPage nav={nav} />, createFakeGateway({ views: { pending, library } }))
    fireEvent.click(screen.getByRole('tab', { name: '健康' }))
    expect(nav.get().tab).toBe('health')
    expect(screen.getByRole('tab', { name: '健康' })).toHaveAttribute('aria-selected', 'true')
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
    expect(screen.getByRole('tab', { name: /全部记忆/ })).toHaveAttribute('aria-selected', 'true')
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
// 待处理有条目落在待处理，为空落在全部记忆（当前项目）。入口先写过目标的，照目标走。
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

  it('待处理为空：落在全部记忆；视图晚到也按到达时判断', () => {
    const gateway = createFakeGateway({ currentWorkspace: '/w/app', views: { pending: { status: 'loading' }, library } })
    const nav = createNavStore()
    renderInShell(<MemoryPage nav={nav} />, gateway)
    tabSelected(/待处理/)
    act(() => { gateway.setView('pending', emptyPending) })
    expect(nav.get()).toEqual({ tab: 'library' })
    tabSelected(/全部记忆/)
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
    tabSelected(/全部记忆/)
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
