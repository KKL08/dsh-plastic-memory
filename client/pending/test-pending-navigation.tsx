import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { GUI_VIEW_VERSION, type CheckupView, type HealthView, type MemoryCommand, type PendingItem } from '../../src/gui/contract.ts'
import { createFakeGateway } from '../gateway.fake.ts'
import { useGateway } from '../gateway.ts'
import { FLASH_MS } from '../library/shared.tsx'
import { ALL_SCOPE, createNavStore } from '../nav.ts'
import { memory, NOW, renderInShell } from '../test-utils.tsx'
import { PendingTab } from './PendingTab.tsx'
import { SESSION, config, horizontal, vertical, promote, secret, overflow, unreadable, tidy, view, scannedHealth, setup, ruleConflict } from './test-pending.tsx'


describe('待处理：确认收起后的键盘焦点', () => {
  /** 键盘用户按回车：焦点先落在按钮上再触发点击。 */
  const press = async (button: HTMLElement) => {
    button.focus()
    await act(async () => { fireEvent.click(button) })
  }

  it('不用确认的动作：卡片换成结果卡后焦点落到结果卡的「撤销」', async () => {
    setup([promote])
    await press(screen.getByRole('button', { name: '提升为全局' }))
    await waitFor(() => { expect(screen.getByRole('button', { name: '撤销' })).toHaveFocus() })
  })

  it('视图先于命令结果刷新（宿主先推了新版本）：卡片留在原位、焦点不动，结果回来后换成结果卡，焦点落到「撤销」', async () => {
    let answer: (() => void) | undefined
    const { gateway } = setup([promote, vertical], {
      respond: command => new Promise((resolve) => { answer = () => { resolve({ ok: true, cmd: command.cmd }) } }),
    })
    const button = screen.getByRole('button', { name: '提升为全局' })
    await press(button)
    act(() => { gateway.setView('pending', view(vertical)) })
    expect(button).toHaveFocus()
    expect(screen.getByRole('heading', { level: 2, name: '等你决定 2' })).toBeInTheDocument()
    await act(async () => { answer?.() })
    await waitFor(() => { expect(screen.getByRole('button', { name: '撤销' })).toHaveFocus() })
    expect(screen.getAllByRole('article')[0]).toHaveTextContent('撤销')
  })

  it('密钥卡：「取消」回到「彻底删除…」；确认删除后落到原位的结果卡上', async () => {
    setup([secret, promote])
    await press(screen.getByRole('button', { name: '彻底删除…' }))
    await press(screen.getByRole('button', { name: '取消' }))
    await waitFor(() => { expect(screen.getByRole('button', { name: '彻底删除…' })).toHaveFocus() })

    await press(screen.getByRole('button', { name: '彻底删除…' }))
    await press(screen.getByRole('button', { name: '彻底删除' }))
    const result = (await screen.findByText('如果它是真的凭证，记得去换一个新的。')).closest('article')
    await waitFor(() => { expect(result).toHaveFocus() })
  })

  it('跨项目确认：「取消」回到裁决按钮；「继续处理」裁决完落到结果卡的「撤销」', async () => {
    const respond = (command: MemoryCommand) => 'allowCrossWorkspace' in command && command.allowCrossWorkspace
      ? { ok: true as const, cmd: command.cmd }
      : { ok: false as const, cmd: command.cmd, code: 'cross-workspace' as const, rejected: [{ id: 'a', workspacePath: '/w/blog' }] }
    setup([horizontal], { respond })
    const keepA = () => screen.getByRole('button', { name: '保留 A' })
    const confirmKeepA = () => within(document.querySelector('.pm-soft-confirm') as HTMLElement).getByRole('button', { name: '保留 A' })
    await press(keepA())
    await press(confirmKeepA())
    await press(screen.getByRole('button', { name: '取消' }))
    await waitFor(() => { expect(keepA()).toHaveFocus() })

    await press(keepA())
    await press(confirmKeepA())
    await press(screen.getByRole('button', { name: '继续处理' }))
    await screen.findByText('已保留「postgres-in-tests」')
    await waitFor(() => { expect(screen.getByRole('button', { name: '撤销' })).toHaveFocus() })
  })

  // 裁决 → 视图去掉这条 → 撤销（本地原样画回）→ 视图带回：画回的卡和视图带回的是同一张，不重挂，焦点不动、位置不变
  it.each([
    { kind: '横向冲突', item: horizontal, action: '保留 A', confirm: '保留 A', landsOn: '保留 A' },
    { kind: '垂直冲突', item: vertical, action: '都保留，不算冲突', confirm: '都保留', landsOn: undefined },
    { kind: '提升候选', item: promote, action: '提升为全局', confirm: undefined, landsOn: undefined },
    { kind: '超限', item: overflow, action: '不再提醒', confirm: undefined, landsOn: undefined },
    { kind: '可以整理', item: tidy, action: '不再提醒', confirm: undefined, landsOn: undefined },
  ])('$kind：撤销后视图带回这条，卡片不重挂、焦点留在原控件上、列表位置不变', async ({ item, action, confirm, landsOn }) => {
    const { gateway } = setup([secret, item, unreadable])
    const headings = () => screen.getAllByRole('heading', { level: 3 }).map(h => h.textContent)
    const before = headings()
    await press(screen.getByRole('button', { name: action }))
    if (confirm !== undefined) await press(within(document.querySelector('.pm-soft-confirm') as HTMLElement).getByRole('button', { name: confirm }))
    await waitFor(() => { expect(screen.getByRole('button', { name: '撤销' })).toHaveFocus() })
    act(() => { gateway.setView('pending', view(secret, unreadable)) })
    await press(screen.getByRole('button', { name: '撤销' }))
    await waitFor(() => { expect(document.activeElement?.closest('article')?.querySelector('h3')).not.toBeNull() })
    const focused = document.activeElement as HTMLElement
    if (landsOn !== undefined) expect(focused).toHaveAccessibleName(landsOn)
    const card = focused.closest('article')!
    expect(headings()).toEqual(before)

    act(() => { gateway.setView('pending', view(secret, item, unreadable)) })
    expect(card.isConnected).toBe(true)
    expect(focused).toHaveFocus()
    expect(headings()).toEqual(before)
  })
})

describe('待处理：两态与空状态', () => {
  it('没有会话：读不到视图，提示先开会话', () => {
    const gateway = createFakeGateway({ session: { kind: 'none' }, config, views: { pending: view(horizontal) } })
    renderInShell(<PendingTab nav={createNavStore()} session={{ kind: 'none' }} scope={ALL_SCOPE} workspacePath={undefined} now={NOW} />, gateway)
    expect(screen.getByRole('status')).toHaveTextContent('开一个会话后这里可用')
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('有结果卡时会话没了：撤销不可用并提示「先开一个会话」', async () => {
    // 和页面一样从网关借会话
    function Tab() {
      return <PendingTab nav={createNavStore()} session={useGateway().useSession('/w/app')} scope={ALL_SCOPE} workspacePath="/w/app" now={NOW} />
    }
    const gateway = createFakeGateway({ session: SESSION, config, views: { pending: view(horizontal), health: scannedHealth(NOW) } })
    renderInShell(<Tab />, gateway)
    ruleConflict('保留 A')
    await screen.findByText('已保留「postgres-in-tests」')
    act(() => { gateway.setSession({ kind: 'none' }) })
    const undo = screen.getByRole('button', { name: '撤销' })
    expect(undo).toHaveAttribute('aria-disabled', 'true')
    expect(undo).toHaveAttribute('title', '先开一个会话')
    fireEvent.click(undo)
    expect(gateway.executed.map(e => e.command.cmd)).toEqual(['resolve'])
  })

  it('三组都空：「没有要处理的事」加上次体检时间，不画组标题，没有体检按钮', () => {
    setup([], { views: { pending: view(), health: scannedHealth(new Date(2026, 9, 15, 9).getTime()) } })
    expect(screen.getByRole('status')).toHaveTextContent('没有要处理的事')
    expect(screen.getByRole('status')).toHaveTextContent('上次体检 10 月 15 日。新的冲突和建议会出现在这里。')
    expect(screen.queryByRole('heading', { level: 2 })).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('三组都空、从没体检过：写「还没体检过」，不提体检按钮，也不放按钮', () => {
    setup([], { views: { pending: view(), health: scannedHealth(null) } })
    expect(screen.getByRole('status')).toHaveTextContent('没有要处理的事')
    expect(screen.getByRole('status')).toHaveTextContent('还没体检过。新的冲突和建议会出现在这里。')
    expect(screen.getByRole('status')).not.toHaveTextContent('体检当前项目')
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('上次体检按选中的范围取：项目范围只看那个项目，「全部」取最近一次', () => {
    const layer = (l: HealthView['layers'][number]['layer'], at: number | null): HealthView['layers'][number] => ({
      layer: l, totalMemories: 1, score: 1, tier: 'green', gate: { secret: false }, issues: [], lastCheckupAt: at, ignored: [],
      deductions: { rule: { points: 0, types: [] }, content: { points: 0, types: [] }, freshness: { points: 0, types: [] } },
    })
    const health: HealthView = {
      version: GUI_VIEW_VERSION,
      governanceEnabled: true,
      layers: [layer({ kind: 'global' }, new Date(2026, 9, 16, 9).getTime()), layer({ kind: 'workspace', workspacePath: '/w/app' }, new Date(2026, 9, 3, 9).getTime())],
    }
    const gateway = createFakeGateway({ session: SESSION, config, views: { pending: view(), health } })
    const { unmount } = renderInShell(<PendingTab nav={createNavStore()} session={SESSION} scope={{ kind: 'workspace', workspacePath: '/w/app' }} workspacePath="/w/app" now={NOW} />, gateway)
    expect(screen.getByRole('status')).toHaveTextContent('上次体检 10 月 3 日')
    unmount()
    renderInShell(<PendingTab nav={createNavStore()} session={SESSION} scope={ALL_SCOPE} workspacePath={undefined} now={NOW} />, gateway)
    expect(screen.getByRole('status')).toHaveTextContent('上次体检 10 月 16 日')
  })

  it('项目记忆删光了（健康视图不列它）：上次体检取体检视图，不写成「还没体检过」', () => {
    const old = { kind: 'workspace' as const, workspacePath: '/w/old' }
    const checkups: CheckupView = {
      version: GUI_VIEW_VERSION, governanceEnabled: true, defaultFrequency: 'manual', allResult: null,
      scopes: [{
        scope: old, isCheckable: false, frequency: 7, isOwn: true, lastCheckupAt: new Date(2026, 9, 5, 9).getTime(), nextCheckupAt: null, isDue: false,
        isInProgress: false, failure: null, modelUnavailable: null, lastResult: null,
      }],
    }
    const gateway = createFakeGateway({ session: SESSION, config, views: { pending: view(), health: scannedHealth(null), checkups } })
    renderInShell(<PendingTab nav={createNavStore()} session={SESSION} scope={old} workspacePath="/w/app" now={NOW} />, gateway)
    expect(screen.getByRole('status')).toHaveTextContent('上次体检 10 月 5 日')
  })

  it('体检视图还在读：先不写上次体检，读到了再写（不闪「还没体检过」）', () => {
    const old = { kind: 'workspace' as const, workspacePath: '/w/old' }
    const checkups: CheckupView = {
      version: GUI_VIEW_VERSION, governanceEnabled: true, defaultFrequency: 'manual', allResult: null,
      scopes: [{
        scope: old, isCheckable: false, frequency: 7, isOwn: true, lastCheckupAt: new Date(2026, 9, 5, 9).getTime(), nextCheckupAt: null, isDue: false,
        isInProgress: false, failure: null, modelUnavailable: null, lastResult: null,
      }],
    }
    const gateway = createFakeGateway({ session: SESSION, config, views: { pending: view(), health: scannedHealth(null), checkups: { status: 'loading' } } })
    renderInShell(<PendingTab nav={createNavStore()} session={SESSION} scope={old} workspacePath="/w/app" now={NOW} />, gateway)
    expect(screen.getByRole('status')).not.toHaveTextContent('还没体检过')
    expect(screen.getByRole('status')).not.toHaveTextContent('上次体检')
    act(() => { gateway.setView('checkups', checkups) })
    expect(screen.getByRole('status')).toHaveTextContent('上次体检 10 月 5 日')
  })

  it('配置文件关掉体检：写明在配置文件里关闭，没有可点的东西（界面上不提供打开体检）', () => {
    setup([], { views: { pending: view(), health: { ...scannedHealth(NOW), governanceEnabled: false } } }, createNavStore(undefined, { openSettings: vi.fn() }))
    expect(screen.getByRole('status')).toHaveTextContent('体检已在配置文件里关闭')
    expect(screen.getByRole('status')).toHaveTextContent('governance.enabled')
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('体检开关以健康视图为准（和健康 tab、页头一致），不看插件配置', () => {
    setup([], { config: { ...config, governanceEnabled: false } })
    expect(screen.getByRole('status')).not.toHaveTextContent('体检已在配置文件里关闭')
  })
})

// 入口带记忆 id 打开待处理：含这条记忆的卡（冲突任一方、提升候选、密钥）滚入视野并高亮一次。
describe('待处理：直达某条记忆', () => {
  const scrollIntoView = vi.fn()
  beforeEach(() => { vi.useFakeTimers(); scrollIntoView.mockClear(); Element.prototype.scrollIntoView = scrollIntoView })
  afterEach(() => { vi.useRealTimers(); delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView })
  const cardOf = (title: string) => screen.getByRole('heading', { level: 3, name: title }).closest('.pm-pending-row')!

  it('记忆在横向冲突的 B 方：那张冲突卡高亮并滚入视野，播完收起', () => {
    const nav = createNavStore({ view: 'todo', memoryId: 'b' })
    setup([vertical, horizontal, promote], {}, nav)
    const row = cardOf('测试里怎么准备数据库，两条记忆互相矛盾')
    expect(row).toHaveClass('pm-flash')
    expect(document.querySelectorAll('.pm-flash')).toHaveLength(1)
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
    expect(scrollIntoView.mock.contexts[0]).toBe(row)
    act(() => { vi.advanceTimersByTime(FLASH_MS) })
    expect(row).not.toHaveClass('pm-flash')
  })

  it('提升候选、垂直冲突、密钥都认它们那条记忆；入口换一条再高亮一次', () => {
    const nav = createNavStore({ view: 'todo', memoryId: 'p' })
    setup([secret, vertical, promote], {}, nav)
    expect(cardOf('这条适合所有项目')).toHaveClass('pm-flash')
    act(() => { nav.navigate({ view: 'todo', memoryId: 'v' }) })
    expect(cardOf('包管理器和基线矛盾')).toHaveClass('pm-flash')
    act(() => { nav.navigate({ view: 'todo', memoryId: 's' }) })
    expect(cardOf('这条记忆里有密钥')).toHaveClass('pm-flash')
  })

  it('目标不在待处理里：不高亮、不滚动', () => {
    setup([horizontal], {}, createNavStore({ view: 'todo', memoryId: 'nope' }))
    expect(document.querySelector('.pm-flash')).toBeNull()
    expect(scrollIntoView).not.toHaveBeenCalled()
  })
})

// 健康页「去处理 ›」带组标识进来：焦点落在那一组的标题上并滚入视野；组已经没有了（处理完）就落在待处理顶部。
describe('待处理：定位到组', () => {
  const scrollIntoView = vi.fn()
  beforeEach(() => { scrollIntoView.mockClear(); Element.prototype.scrollIntoView = scrollIntoView })
  afterEach(() => { delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView })
  const advice: PendingItem = { kind: 'advice', level: 'advice', type: 'expired', memories: [memory({ id: 'e1', validTo: NOW - 1 })] }
  const top = () => document.querySelector('.pm-pending')

  it('三组各自能定位：焦点在组标题上，标题滚入视野', () => {
    for (const [level, heading] of [['must-fix', '先处理 1'], ['your-call', '等你决定 1'], ['advice', '可以整理 1']] as const) {
      const { unmount } = setup([secret, horizontal, advice], {}, createNavStore({ view: 'todo', level }))
      const title = screen.getByRole('heading', { level: 2, name: heading })
      expect(title).toHaveFocus()
      expect(scrollIntoView.mock.contexts.at(-1)).toBe(title)
      unmount()
    }
  })

  it('那一组已经没有了：焦点落在待处理顶部', () => {
    setup([secret, advice], {}, createNavStore({ view: 'todo', level: 'your-call' }))
    expect(top()).toHaveFocus()
    expect(scrollIntoView.mock.contexts.at(-1)).toBe(top())
  })

  it('待处理全空：同样落在顶部（空状态在里面）', () => {
    setup([], {}, createNavStore({ view: 'todo', level: 'advice' }))
    expect(top()).toHaveFocus()
    expect(top()).toHaveTextContent('没有要处理的事')
  })

  it('视图晚到：到了再定位', () => {
    const nav = createNavStore({ view: 'todo', level: 'advice' })
    const { gateway } = setup([], { views: { pending: { status: 'loading' }, health: scannedHealth(NOW) } }, nav)
    expect(document.body).toHaveFocus()
    act(() => { gateway.setView('pending', view(secret, advice)) })
    expect(screen.getByRole('heading', { level: 2, name: '可以整理 1' })).toHaveFocus()
  })

  it('只定位一次：视图刷新不再抢焦点；不带组标识进来不动焦点', () => {
    const nav = createNavStore({ view: 'todo', level: 'advice' })
    const { gateway } = setup([secret, advice], {}, nav)
    const ignore = screen.getByRole('button', { name: '不再提醒' })
    ignore.focus()
    act(() => { gateway.setView('pending', view(secret, horizontal, advice)) })
    expect(ignore).toHaveFocus()
    act(() => { nav.update({ view: 'todo' }) })
    expect(ignore).toHaveFocus()
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
  })
})

// —— 键盘（故事 50）：裁决、提升、删除都是原生 button，能 Tab 到；焦点环用宿主令牌（见 ui/basics.spec 的主题检查） ——

describe('键盘', () => {
  it('裁决 / 提升 / 删除控件都是原生 button，不在 Tab 序列外', () => {
    setup([secret, horizontal, vertical, promote])
    const names = ['保留 A', '保留 B', '都保留，不算冲突', '以文件为准，删除这条', '提升为全局', '留在本项目', '彻底删除…']
    for (const button of names.flatMap(name => screen.getAllByRole('button', { name }))) {
      expect(button.tagName).toBe('BUTTON')
      expect(button).not.toBeDisabled()
      expect(button.tabIndex).toBe(0)
      button.focus()
      expect(document.activeElement).toBe(button)
    }
  })
})