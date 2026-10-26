// 页头「体检当前项目」：主 / 次按钮、进行中、失败、拿不到模型、体检关闭四种状态，以及结果行（新增条数、链接、说明）。挂在真实记忆页里测。
import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { GUI_VIEW_VERSION, type HealthView, type MemoryCommandResult, type PendingView } from '../../src/gui/contract.ts'
import { createFakeGateway, type FakeGatewayInit } from '../gateway.fake.ts'
import { MemoryPage } from '../MemoryPage.tsx'
import { createTranslator } from '../i18n.tsx'
import { en } from '../locales.ts'
import { createNavStore } from '../nav.ts'
import { PanelShell } from '../ui/PanelShell.tsx'
import { memory, renderInShell, levelCountsOf } from '../test-utils.tsx'

const health = (governanceEnabled = true): HealthView => ({ version: GUI_VIEW_VERSION, governanceEnabled, layers: [] })
const noPending: PendingView = { version: GUI_VIEW_VERSION, dot: 'none', items: [], levelCounts: levelCountsOf([]), typeLabels: {} }
const somePending: PendingView = {
  version: GUI_VIEW_VERSION, dot: 'amber',
  items: [{ kind: 'promote-candidate', level: 'your-call', decisionId: 'd1', firstSeenAt: 1, memory: memory() }],
  levelCounts: { 'must-fix': 0, 'your-call': 1, 'advice': 0 },
  typeLabels: {},
}

function renderPage(init: FakeGatewayInit = {}, openSettings = vi.fn()) {
  const gateway = createFakeGateway({ currentWorkspace: '/w/app', views: { pending: noPending, health: health() }, ...init })
  const nav = createNavStore(undefined, { openSettings })
  const { container } = renderInShell(<MemoryPage nav={nav} />, gateway)
  return {
    gateway, nav, openSettings,
    button: () => screen.getByRole('button', { name: /体检当前项目|再试一次/ }),
    /** 按钮下面那一行。 */
    statusLine: () => container.querySelector('.pm-scan-status')!,
  }
}

const scanned = (patch: Partial<Extract<MemoryCommandResult, { ok: true }>> = {}): MemoryCommandResult =>
  ({ ok: true, cmd: 'scan', notes: [], added: { pending: 0, advice: 0 }, ...patch })

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

  it('按钮下常驻一行 token 消耗说明；体检关闭时不写', () => {
    const { unmount } = renderInShell(<MemoryPage nav={createNavStore()} />, createFakeGateway({ currentWorkspace: '/w/app', views: { pending: noPending, health: health() } }))
    expect(screen.getByText('会用当前对话的模型检查记忆内容，消耗少量 token。')).toHaveClass('pm-scan-hint')
    unmount()
    renderPage({ views: { pending: noPending, health: health(false) } })
    expect(screen.queryByText('会用当前对话的模型检查记忆内容，消耗少量 token。')).toBeNull()
  })

  it('有待处理时用次按钮，不抢待处理的位置', () => {
    renderPage({ views: { pending: somePending, health: health() } })
    expect(screen.getByRole('button', { name: '体检当前项目' })).toHaveClass('pm-btn--secondary')
  })

  it('点击发 scan，带页面当前项目；进行中按钮禁用并原位显示状态，完成后写结果（没带新增条数时只写体检完成）', async () => {
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
    const { statusLine } = renderPage({ respond: () => scanned({ notes: ['baseline-session-scoped'] }) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '体检当前项目' })) })
    expect(statusLine()).toHaveTextContent(/^没有发现新问题·查看分数 ›这次没有对照本项目的 AGENTS.md 检查冲突/)
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

  describe('结果行', () => {
    async function scan(result: MemoryCommandResult, init: FakeGatewayInit = {}) {
      const page = renderPage({ respond: () => result, ...init })
      await act(async () => { fireEvent.click(page.button()) })
      return page
    }

    it('有新增：写新增几条待处理、几条建议；待处理分在两组时落在待处理顶部，建议落在建议整理组，查看分数去健康', async () => {
      const { nav, statusLine } = await scan(scanned({ added: { pending: 2, advice: 1 } }))
      expect(statusLine()).toHaveTextContent(/^体检完成：新增 2 条待处理 ›·新增 1 条建议 ›·查看分数 ›$/)
      fireEvent.click(screen.getByRole('button', { name: '新增 2 条待处理 ›' }))
      expect(nav.get()).toMatchObject({ tab: 'pending' })
      expect(nav.get().level).toBeUndefined()
      fireEvent.click(screen.getByRole('button', { name: '查看分数 ›' }))
      expect(nav.get()).toMatchObject({ tab: 'health' })
      expect(nav.get().level).toBeUndefined()
      fireEvent.click(screen.getByRole('button', { name: '新增 1 条建议 ›' }))
      expect(nav.get()).toMatchObject({ tab: 'pending', level: 'advice' })
    })

    it.each(['must-fix', 'your-call'] as const)('新增的待处理都在同一组（%s）：链接落到那一组', async (level) => {
      const { nav } = await scan(scanned({ added: { pending: 1, advice: 0, pendingLevel: level } }))
      fireEvent.click(screen.getByRole('button', { name: '新增 1 条待处理 ›' }))
      expect(nav.get()).toMatchObject({ tab: 'pending', level })
    })

    it('只有建议：没有「待处理」那段', async () => {
      const { statusLine } = await scan(scanned({ added: { pending: 0, advice: 3 } }))
      expect(statusLine()).toHaveTextContent(/^体检完成：新增 3 条建议 ›·查看分数 ›$/)
    })

    it('没有新增：写没有发现新问题，只留查看分数', async () => {
      const { statusLine } = await scan(scanned())
      expect(statusLine()).toHaveTextContent(/^没有发现新问题·查看分数 ›$/)
      expect(within(statusLine() as HTMLElement).getAllByRole('button').map(b => b.textContent)).toEqual(['查看分数 ›'])
    })

    it('内容检查没做完：结果照写，说明附在后面', async () => {
      const { statusLine } = await scan(scanned({ added: { pending: 1, advice: 0 }, notes: ['semantic-failed'] }))
      expect(statusLine()).toHaveTextContent(/^体检完成：新增 1 条待处理 ›·查看分数 ›内容检查没有完成，这次只更新了规则检查。$/)
    })

    it('分了批：写分几批、跨批的冲突和重复可能查不出', async () => {
      const { statusLine } = await scan(scanned({ notes: ['semantic-batched'], semanticBatches: 3 }))
      expect(statusLine()).toHaveTextContent(/^没有发现新问题·查看分数 ›记忆较多，分 3 批检查，不同批之间的冲突和重复可能查不出。$/)
    })

    it('宿主报了用量：结果行末尾写实际用量，说明照样附在后面', async () => {
      const { statusLine } = await scan(scanned({ added: { pending: 1, advice: 0 }, notes: ['semantic-batched'], semanticBatches: 2, usageTokens: 6800 }))
      expect(statusLine()).toHaveTextContent(/^体检完成：新增 1 条待处理 ›·查看分数 ›·本次用了约 6,800 token记忆较多，分 2 批检查/)
    })

    it('宿主没报用量：结果行不写用量', async () => {
      const { statusLine } = await scan(scanned())
      expect(statusLine()).not.toHaveTextContent(/token/)
    })

    it('没带新增条数也写用量', async () => {
      const { statusLine } = await scan({ ok: true, cmd: 'scan', notes: [], usageTokens: 1234 })
      expect(statusLine()).toHaveTextContent(/^体检完成。本次用了约 1,234 token$/)
    })

    it('英文：分批说明与用量', async () => {
      const gateway = createFakeGateway({
        currentWorkspace: '/w/app', views: { pending: noPending, health: health() },
        respond: () => scanned({ notes: ['semantic-batched'], semanticBatches: 3, usageTokens: 6800 }),
      })
      const { container } = render(<PanelShell gateway={gateway} t={createTranslator(en)}><MemoryPage nav={createNavStore()} /></PanelShell>)
      expect(container.querySelector('.pm-scan-hint')).toHaveTextContent('Uses the model of the current chat to check memory content, which takes a few tokens.')
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Check this project' })) })
      expect(container.querySelector('.pm-scan-status')!.textContent).toBe(
        'No new issues found·View scores ›·Used about 6,800 tokens this time'
        + 'Many memories, so the content was checked in 3 batches; conflicts and duplicates across batches may be missed.')
    })

    it('英文：数字在前，建议按单复数', async () => {
      const lineIn = async (added: { pending: number; advice: number }) => {
        const gateway = createFakeGateway({ currentWorkspace: '/w/app', views: { pending: noPending, health: health() }, respond: () => scanned({ added }) })
        const { container, unmount } = render(<PanelShell gateway={gateway} t={createTranslator(en)}><MemoryPage nav={createNavStore()} /></PanelShell>)
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Check this project' })) })
        const text = container.querySelector('.pm-scan-status')!.textContent
        unmount()
        return text
      }
      expect(await lineIn({ pending: 2, advice: 1 })).toBe('Checkup finished: 2 new to handle ›·1 new suggestion ›·View scores ›')
      expect(await lineIn({ pending: 0, advice: 3 })).toBe('Checkup finished: 3 new suggestions ›·View scores ›')
    })

    it('原地跑：体检完成不切走当前 tab', async () => {
      const pending = deferred()
      const { nav, button } = renderPage({ respond: () => pending.promise })
      act(() => { nav.update({ tab: 'library' }) })
      fireEvent.click(button())
      await act(async () => { pending.resolve(scanned({ added: { pending: 1, advice: 1 } })) })
      expect(nav.get().tab).toBe('library')
    })

    it('命令回来说体检已关闭：写体检已关闭并给「去设置里打开 ›」', async () => {
      const { openSettings, statusLine } = await scan({ ok: false, cmd: 'scan', code: 'governance-disabled', detail: '体检已关闭，可在插件设置里打开' })
      expect(statusLine()).toHaveTextContent(/^体检已关闭·去设置里打开 ›$/)
      fireEvent.click(screen.getByRole('button', { name: '去设置里打开 ›' }))
      expect(openSettings).toHaveBeenCalledTimes(1)
    })
  })

  it('没有会话时不出现按钮', () => {
    renderPage({ session: { kind: 'none' } })
    expect(screen.queryByRole('button', { name: '体检当前项目' })).toBeNull()
  })
})
