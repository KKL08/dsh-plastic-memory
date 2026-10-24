// 右侧栏「记忆」tab：四种状态、用量条两种超限、就地裁决与撤销、新记的实时增加、底部入口跳转。全部对内存假网关。
import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, screen, within } from '@testing-library/react'
import {
  GUI_VIEW_VERSION,
  type LibraryView, type MemoryCard, type PendingItem, type PendingView, type SessionView,
} from '../../src/gui/contract.ts'
import { createFakeGateway, type FakeGatewayInit } from '../gateway.fake.ts'
import { createNavStore, openMemoryPage, PANEL_ID } from '../nav.ts'
import { memory, renderInShell } from '../test-utils.tsx'
import { SidebarTab } from './SidebarTab.tsx'

const WS = '/w/app'
const STARTED = 1_000

const pref = memory({ id: 'p1', type: 'preference', content: '测试用真实 Postgres。' })
const pref2 = memory({ id: 'p2', type: 'preference', content: '测试里 mock 数据库就行。' })
const proj = memory({ id: 'j1', type: 'project', content: 'merge freeze 到 3 月 5 日。' })
const glob = memory({ id: 'g1', type: 'profile', scope: 'global', workspacePath: undefined, content: '用户是数据工程师。' })

function library(...items: MemoryCard[]): LibraryView {
  return {
    version: GUI_VIEW_VERSION, memoryRoot: '/m', directoryIssues: [],
    layers: [
      { layer: { kind: 'global' }, items: items.filter(m => m.scope === 'global') },
      { layer: { kind: 'workspace', workspacePath: WS }, items: items.filter(m => m.scope === 'workspace') },
    ],
  }
}

function snapshot(overrides: Partial<SessionView> = {}): SessionView {
  return {
    version: GUI_VIEW_VERSION, sessionId: 's1', workspacePath: WS, frozenAt: STARTED + 1, budget: 4000, overflowMode: 'relax',
    tokens: { workspace: 1870, global: 1050, fixed: 200 }, usedTokens: 2920,
    injectedIds: ['p1', 'j1', 'g1'], omittedCount: 0, savedIds: [],
    ...overrides,
  }
}

function pending(...items: PendingItem[]): PendingView {
  return { version: GUI_VIEW_VERSION, dot: items.length > 0 ? 'amber' : 'none', items, typeLabels: {} }
}

const conflict: PendingItem = { kind: 'conflict-horizontal', decisionId: 'pd_1', firstSeenAt: 1, summary: '', left: pref, right: pref2 }
const promote: PendingItem = { kind: 'promote-candidate', decisionId: 'pd_2', firstSeenAt: 1, memory: proj }

function setup(views: FakeGatewayInit['views'], respond?: FakeGatewayInit['respond']) {
  const gateway = createFakeGateway({ views, ...(respond === undefined ? {} : { respond }) })
  const openPage = vi.fn()
  const utils = renderInShell(<SidebarTab sessionId="s1" workspacePath={WS} hostStartedAt={STARTED} openPage={openPage} />, gateway)
  return { ...utils, gateway, openPage }
}

describe('SidebarTab 四种状态', () => {
  it('无记忆：首次空状态，说明记忆从哪来', () => {
    setup({ library: library(), session: snapshot({ injectedIds: [], tokens: { workspace: 0, global: 0, fixed: 0 }, usedTokens: 0 }), pending: pending() })
    expect(screen.getByText('还没有记忆')).toBeInTheDocument()
    expect(screen.getByText(/agent 在对话里记下你的偏好/)).toBeInTheDocument()
    expect(screen.queryByText('这次对话带入的记忆')).toBeNull()
  })

  it('有全局没本项目：提示本项目还没有记忆，列出带入的全局记忆，不写「本项目 0 条」', () => {
    setup({ library: library(glob), session: snapshot({ injectedIds: ['g1'] }), pending: pending() })
    expect(screen.getByText('本项目还没有记忆，这次带入的都是全局记忆。')).toBeInTheDocument()
    expect(screen.getByText('用户是数据工程师。')).toBeInTheDocument()
    expect(screen.queryByText(/本项目 0 条/)).toBeNull()
  })

  it('正常：面包屑「本项目 /」次文字色，用量条带「约」，带入的记忆按类型分组带数，底部写本项目条数', () => {
    const { container, openPage } = setup({ library: library(pref, proj, glob), session: snapshot(), pending: pending() })
    const crumb = container.querySelector('.pm-side-crumb')!
    expect(crumb).toHaveTextContent('本项目 / app')
    expect(crumb.querySelector('.pm-side-crumb-scope')).toHaveTextContent('本项目 /')
    expect(screen.getByText('3 条 · 约 3,120 / 4,000')).toBeInTheDocument()
    expect(screen.getByText('全部带入')).toBeInTheDocument()
    const groups = within(screen.getByRole('region', { name: '带入的记忆' }))
    expect(groups.getByRole('heading', { name: '行为偏好 1' })).toBeInTheDocument()
    expect(groups.getByRole('heading', { name: '项目信息 1' })).toBeInTheDocument()
    expect(groups.getByRole('heading', { name: '用户画像 1' })).toBeInTheDocument()
    expect(screen.queryByText('本项目还没有记忆，这次带入的都是全局记忆。')).toBeNull()
    expect(screen.queryByText(/处待处理/)).toBeNull()
    expect(screen.getByText(/本项目 2 条记忆/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '在记忆页查看 ›' }))
    expect(openPage).toHaveBeenCalledWith({ tab: 'library', scope: { kind: 'workspace', workspacePath: WS } })
  })

  it('frozenAt 早于宿主启动：写「重启后未重新带入」，不画过时的用量条', () => {
    const { container } = setup({ library: library(pref, proj, glob), session: snapshot({ frozenAt: STARTED - 1 }), pending: pending() })
    expect(screen.getByText('重启后未重新带入')).toBeInTheDocument()
    expect(container.querySelector('.pm-budget')).toBeNull()
  })

  it('会话视图还没有（这次对话没组装过快照）：说明发出第一条消息后才有', () => {
    setup({ library: library(pref), pending: pending() })
    expect(screen.getByText('这次对话还没带入记忆')).toBeInTheDocument()
  })
})

describe('SidebarTab 用量条超限', () => {
  it('严格模式：「已到上限，N 条没带入 · 处理 ›」，处理跳记忆页待处理', () => {
    const { openPage } = setup({
      library: library(pref, proj, glob),
      session: snapshot({ overflowMode: 'strict', omittedCount: 2, usedTokens: 4000, tokens: { workspace: 2800, global: 1200, fixed: 200 } }),
      pending: pending(),
    })
    expect(screen.getByText(/已到上限，2 条没带入/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '处理 ›' }))
    expect(openPage).toHaveBeenCalledWith({ tab: 'pending', scope: { kind: 'workspace', workspacePath: WS } })
  })

  it('自动放宽：计入上限的用量超过上限时写「已放宽到 N」', () => {
    setup({
      library: library(pref, proj, glob),
      session: snapshot({ usedTokens: 4600, tokens: { workspace: 3000, global: 1600, fixed: 200 } }),
      pending: pending(),
    })
    expect(screen.getByText('已放宽到 5,000')).toBeInTheDocument()
  })
})

describe('SidebarTab 这次对话新记的', () => {
  it('memory_save 后会话视图版本变化，新记的实时增加；行尾删除发 forget', async () => {
    const { gateway } = setup({ library: library(pref, proj, glob), session: snapshot(), pending: pending() })
    expect(screen.queryByText('这次对话新记的')).toBeNull()
    const fresh = memory({ id: 'n1', type: 'knowledge', content: '报销截止每月 25 日。' })
    act(() => {
      gateway.setView('library', library(pref, proj, glob, fresh))
      gateway.setView('session', snapshot({ savedIds: ['n1'] }))
    })
    const saved = within(screen.getByRole('region', { name: '这次对话新记的' }))
    expect(saved.getByText('报销截止每月 25 日。')).toBeInTheDocument()
    await act(async () => { fireEvent.click(saved.getByRole('button', { name: '删除这条记忆' })) })
    expect(gateway.executed.map(e => e.command)).toEqual([{ cmd: 'forget', memoryId: 'n1' }])
    expect(screen.queryByText('报销截止每月 25 日。')).toBeNull()
  })
})

describe('SidebarTab 就地裁决', () => {
  it('冲突卡挂在那条记忆所在组里，另一方不再单独列；裁决后留原位，撤销后冲突回来', async () => {
    const { gateway, container } = setup({
      library: library(pref, pref2, proj, glob),
      session: snapshot({ injectedIds: ['p1', 'j1', 'p2', 'g1'] }),
      pending: pending(conflict),
    })
    const group = within(screen.getByRole('region', { name: '行为偏好' }))
    expect(group.getByRole('heading', { name: '两条记忆互相矛盾，等你决定' })).toBeInTheDocument()
    expect(group.getByRole('heading', { name: '行为偏好 2' })).toBeInTheDocument()
    expect(screen.getAllByText('测试里 mock 数据库就行。')).toHaveLength(1)
    expect(container.querySelectorAll('.pm-conflict-buttons button')).toHaveLength(3)

    await act(async () => { fireEvent.click(group.getByRole('button', { name: '以 A 为准' })) })
    expect(gateway.executed.map(e => e.command)).toEqual([{ cmd: 'resolve', decisionId: 'pd_1', verdict: 'keep-left' }])
    // 视图刷新：冲突出了待处理，B 被删
    act(() => {
      gateway.setView('pending', pending())
      gateway.setView('library', library(pref, proj, glob))
    })
    expect(screen.queryByRole('heading', { name: '两条记忆互相矛盾，等你决定' })).toBeNull()
    expect(screen.getByText('已按 A')).toBeInTheDocument()
    expect(screen.getByText(/B 已删除，14 天内可恢复。/)).toBeInTheDocument()

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '撤销' })) })
    expect(gateway.executed.map(e => e.command)[1]).toEqual({ cmd: 'undo', decisionId: 'pd_1' })
    expect(screen.queryByText('已按 A')).toBeNull()
    act(() => {
      gateway.setView('pending', pending(conflict))
      gateway.setView('library', library(pref, pref2, proj, glob))
    })
    expect(screen.getByRole('heading', { name: '两条记忆互相矛盾，等你决定' })).toBeInTheDocument()
  })

  it('裁决失败：原位写宿主原话，冲突卡还在', async () => {
    setup(
      { library: library(pref, pref2), session: snapshot({ injectedIds: ['p1'] }), pending: pending(conflict) },
      () => ({ ok: false, code: 'not-found', detail: '条目已处理' }),
    )
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '都保留' })) })
    expect(screen.getByRole('alert')).toHaveTextContent('没有成功：条目已处理')
    expect(screen.getByRole('heading', { name: '两条记忆互相矛盾，等你决定' })).toBeInTheDocument()
  })
})

describe('SidebarTab 底部入口', () => {
  it('其余待处理只在底部带数字（就地显示的冲突不算），经导航 store 跳记忆页待处理', () => {
    const gateway = createFakeGateway({
      views: {
        library: library(pref, pref2, proj, glob),
        session: snapshot({ injectedIds: ['p1', 'j1'] }),
        pending: pending(conflict, promote),
      },
    })
    const nav = createNavStore({ tab: 'library' })
    const layout = { selectPanel: vi.fn() }
    renderInShell(
      <SidebarTab sessionId="s1" workspacePath={WS} hostStartedAt={STARTED} openPage={(target) => { openMemoryPage({ layout }, nav, target) }} />,
      gateway,
    )
    expect(screen.getByText(/本项目还有 1 处待处理/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '在记忆页处理 ›' }))
    expect(nav.get()).toEqual({ tab: 'pending', scope: { kind: 'workspace', workspacePath: WS } })
    expect(layout.selectPanel).toHaveBeenCalledWith(PANEL_ID)
  })
})
