// 页头「体检当前项目」：主 / 次按钮、进行中、失败、拿不到模型、体检关闭四种状态，以及结果区的说明。挂在真实记忆页里测。
import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, screen } from '@testing-library/react'
import { GUI_VIEW_VERSION, type HealthView, type MemoryCommandResult, type PendingView } from '../../src/gui/contract.ts'
import { createFakeGateway, type FakeGatewayInit } from '../gateway.fake.ts'
import { MemoryPage } from '../MemoryPage.tsx'
import { createNavStore } from '../nav.ts'
import { memory, renderInShell } from '../test-utils.tsx'

const health = (governanceEnabled = true): HealthView => ({ version: GUI_VIEW_VERSION, governanceEnabled, layers: [] })
const noPending: PendingView = { version: GUI_VIEW_VERSION, dot: 'none', items: [], typeLabels: {} }
const somePending: PendingView = {
  version: GUI_VIEW_VERSION, dot: 'amber',
  items: [{ kind: 'promote-candidate', decisionId: 'd1', firstSeenAt: 1, memory: memory() }],
  typeLabels: {},
}

function renderPage(init: FakeGatewayInit = {}, openSettings = vi.fn()) {
  const gateway = createFakeGateway({ currentWorkspace: '/w/app', views: { pending: noPending, health: health() }, ...init })
  renderInShell(<MemoryPage nav={createNavStore(undefined, { openSettings })} />, gateway)
  return { gateway, openSettings, button: () => screen.getByRole('button', { name: /体检当前项目|再试一次/ }) }
}

function deferred() {
  let resolve!: (r: MemoryCommandResult) => void
  const promise = new Promise<MemoryCommandResult>((r) => { resolve = r })
  return { promise, resolve }
}

describe('体检当前项目', () => {
  it('没有待处理时用主按钮', () => {
    renderPage()
    expect(screen.getByRole('button', { name: '体检当前项目' })).toHaveClass('pm-btn--primary')
  })

  it('有待处理时用次按钮，不抢待处理的位置', () => {
    renderPage({ views: { pending: somePending, health: health() } })
    expect(screen.getByRole('button', { name: '体检当前项目' })).toHaveClass('pm-btn--secondary')
  })

  it('点击发 scan，带页面当前项目；进行中按钮禁用并原位显示状态，完成后写体检完成', async () => {
    const pending = deferred()
    const { gateway, button } = renderPage({ respond: () => pending.promise })
    fireEvent.click(button())
    expect(gateway.executed).toEqual([{ sessionId: 'fake-session', command: { cmd: 'scan', workspacePath: '/w/app' } }])
    expect(screen.getByRole('button', { name: '正在体检当前项目…' })).toBeDisabled()
    expect(screen.getByText('可以先做别的')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '正在体检当前项目…' }))
    expect(gateway.executed).toHaveLength(1)
    await act(async () => { pending.resolve({ ok: true, cmd: 'scan', notes: [] }) })
    expect(screen.getByText('体检完成。')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '体检当前项目' })).not.toBeDisabled()
  })

  it('作用域切到别的项目时体检那个项目', async () => {
    const gateway = createFakeGateway({ currentWorkspace: '/w/app', views: { pending: noPending, health: health() } })
    const nav = createNavStore()
    renderInShell(<MemoryPage nav={nav} />, gateway)
    act(() => { nav.update({ tab: 'health', scope: { kind: 'workspace', workspacePath: '/w/blog' } }) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '体检当前项目' })) })
    expect(gateway.executed[0]!.command).toEqual({ cmd: 'scan', workspacePath: '/w/blog' })
  })

  it('借的会话不属于当前项目：结果区显示基线检查已跳过', async () => {
    renderPage({ respond: () => ({ ok: true, cmd: 'scan', notes: ['baseline-session-scoped'] }) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '体检当前项目' })) })
    expect(screen.getByText('体检完成。')).toBeInTheDocument()
    expect(screen.getByText(/这次没有对照本项目的 AGENTS.md 检查冲突/)).toBeInTheDocument()
  })

  it('失败：显示原话并提示在对话里让 agent 体检，按钮变再试一次', async () => {
    const { gateway } = renderPage({ respond: () => ({ ok: false, cmd: 'scan', code: 'failed', detail: 'model quota exceeded' }) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '体检当前项目' })) })
    expect(screen.getByText(/体检没有完成：model quota exceeded/)).toHaveTextContent('可以在对话里让 agent 体检。')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '再试一次' })) })
    expect(gateway.executed).toHaveLength(2)
  })

  it('拿不到模型：写清原因并提示在对话里让 agent 体检', async () => {
    renderPage({ respond: () => ({ ok: false, cmd: 'scan', code: 'llm-unavailable', detail: '借用的会话拿不到模型' }) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '体检当前项目' })) })
    expect(screen.getByText(/这次没能体检：借用的会话拿不到模型。/)).toHaveTextContent('可以在对话里让 agent 体检。')
    expect(screen.getByRole('button', { name: '再试一次' })).toBeInTheDocument()
  })

  it('体检关闭：按钮不可用、点了不发命令，给「去设置里打开 ›」', () => {
    const { gateway, openSettings } = renderPage({ views: { pending: noPending, health: health(false) } })
    const button = screen.getByRole('button', { name: '体检当前项目' })
    expect(button).toHaveAttribute('aria-disabled', 'true')
    expect(button).toHaveAttribute('title', '体检已关闭')
    fireEvent.click(button)
    expect(gateway.executed).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: '去设置里打开 ›' }))
    expect(openSettings).toHaveBeenCalledTimes(1)
  })

  it('没有会话时不出现按钮', () => {
    renderPage({ session: { kind: 'none' } })
    expect(screen.queryByRole('button', { name: '体检当前项目' })).toBeNull()
  })
})
