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
    nav.subscribe(() => { order.push('nav') })
    const selectPanel = vi.fn(() => { order.push('select') })
    renderInShell(<MemoryPage nav={nav} />, createFakeGateway({ currentWorkspace: '/w/app', views: { pending, library } }))
    act(() => { openMemoryPage({ layout: { selectPanel } }, nav, { tab: 'library', scope: { kind: 'workspace', workspacePath: '/w/blog' }, memoryId: 'b1' }) })
    expect(order).toEqual(['nav', 'select'])
    expect(selectPanel).toHaveBeenCalledWith(PANEL_ID)
    expect(nav.get()).toEqual({ tab: 'library', scope: { kind: 'workspace', workspacePath: '/w/blog' }, memoryId: 'b1' })
    expect(screen.getByRole('tab', { name: /全部记忆/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('button', { name: 'blog' })).toBeInTheDocument()
  })

  it('会话从无到有：空态换成 tab', () => {
    const gateway = createFakeGateway({ session: { kind: 'none' }, views: { pending, library } })
    renderInShell(<MemoryPage nav={createNavStore()} />, gateway)
    expect(screen.queryByRole('tablist')).toBeNull()
    act(() => { gateway.setSession({ kind: 'ready', sessionId: 's1', cwd: undefined }) })
    expect(screen.getByRole('tablist')).toBeInTheDocument()
  })
})
