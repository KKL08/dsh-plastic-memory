import { describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { GUI_VIEW_VERSION, type DeletedView, type GuiLayerRef, type HealthView, type LibraryView, type PendingView } from '../src/gui/contract.ts'
import { createFakeGateway } from './gateway.fake.ts'
import { createTranslator } from './i18n.tsx'
import { en } from './locales.ts'
import { MemoryPage } from './MemoryPage.tsx'
import { createNavStore, openMemoryPage, PANEL_ID } from './nav.ts'
import { levelCountsOf, memory, NOW, renderInShell } from './test-utils.tsx'
import { PanelShell } from './ui/PanelShell.tsx'

const GLOBAL: GuiLayerRef = { kind: 'global' }
const APP: GuiLayerRef = { kind: 'workspace', workspacePath: '/w/app' }
const ZETA: GuiLayerRef = { kind: 'workspace', workspacePath: '/w/zeta' }

const g1 = memory({ id: 'g1', name: 'g1', scope: 'global', workspacePath: undefined })
const a1 = memory({ id: 'a1', name: 'a1' })
const a2 = memory({ id: 'a2', name: 'a2' })
const z1 = memory({ id: 'z1', name: 'z1', workspacePath: '/w/zeta' })
const b1 = memory({ id: 'b1', name: 'b1', workspacePath: '/w/blog' })

/** 夹具：全局和 app 之间一条冲突，app 一条提升候选，zeta 一条密钥；建议整理 app、全局各一条；blog 只剩最近删除。 */
const items: PendingView['items'] = [
  { kind: 'secret', level: 'must-fix', memory: z1 },
  { kind: 'conflict-horizontal', level: 'your-call', decisionId: 'c1', firstSeenAt: 1, summary: '全局和 app 说法相反', left: g1, right: a1 },
  { kind: 'promote-candidate', level: 'your-call', decisionId: 'p1', firstSeenAt: 2, memory: a2 },
  { kind: 'advice', level: 'advice', type: 'stale', memories: [a1] },
  { kind: 'advice', level: 'advice', type: 'expired', memories: [g1] },
]
const pending: PendingView = { version: GUI_VIEW_VERSION, dot: 'red', typeLabels: {}, items, levelCounts: levelCountsOf(items) }
const library: LibraryView = {
  version: GUI_VIEW_VERSION, memoryRoot: '/h/memories', directoryIssues: [],
  layers: [
    { layer: GLOBAL, items: [g1] },
    { layer: APP, items: [a1, a2] },
    { layer: ZETA, items: [z1] },
  ],
}
const deleted: DeletedView = { version: GUI_VIEW_VERSION, items: [{ memory: b1, deletedAt: NOW - 1000, purgeAt: NOW + 5 * 86_400_000 }] }

function healthLayer(layer: GuiLayerRef, score: number | null, tier: 'green' | 'amber' | 'red', totalMemories = 1): HealthView['layers'][number] {
  return {
    layer, totalMemories, score, tier, gate: { secret: score === null }, issues: [], staleCount: 0,
    lastCheckupAt: NOW - 86_400_000, overflow: null, ignored: [],
    deductions: { rule: { points: 0, types: [] }, content: { points: 0, types: [] }, freshness: { points: 0, types: [] } },
  }
}
const health: HealthView = {
  version: GUI_VIEW_VERSION, governanceEnabled: true,
  layers: [healthLayer(GLOBAL, 85, 'green'), healthLayer(APP, 60, 'amber', 2), healthLayer(ZETA, null, 'red')],
}

const views = { pending, library, deleted, health }

const rail = () => within(screen.getByRole('navigation', { name: '范围' }))
const railRow = (name: RegExp | string) => rail().getByRole('button', { name: typeof name === 'string' ? new RegExp(`^${name}`) : name })
const rowParts = (button: HTMLElement) => ({
  name: button.querySelector('.pm-rail-name')?.textContent,
  sub: button.querySelector('.pm-rail-sub')?.textContent,
  badge: button.querySelector('.pm-rail-badge')?.textContent ?? '',
})
const tab = (name: RegExp) => screen.getByRole('tab', { name })
const panel = () => screen.getByRole('tabpanel')
const cardTitles = () => within(panel()).queryAllByRole('heading', { level: 3 }).map(h => h.textContent)

function open(target: Parameters<typeof openMemoryPage>[2] = { view: 'todo' }, gateway = createFakeGateway({ currentWorkspace: '/w/app', views })) {
  const nav = createNavStore()
  openMemoryPage({ layout: { selectPanel: vi.fn() } }, nav, target)
  renderInShell(<MemoryPage nav={nav} />, gateway)
  return { nav, gateway }
}

describe('左栏范围', () => {
  it('依次是「全部」、全局、各项目按显示名的字母序；只剩最近删除的项目也列出', () => {
    open()
    const names = rail().getAllByRole('button').map(b => rowParts(b).name)
    expect(names).toEqual(['全部', '全局', 'app', 'blog', 'zeta'])
  })

  it('每行副行写条数和分数，有密钥写「暂不打分」；「全部」写「N 个项目和全局」', () => {
    open()
    expect(rail().getAllByRole('button').map(b => rowParts(b).sub)).toEqual([
      '3 个项目和全局', '1 条 · 85 分', '2 条 · 60 分', '0 条', '1 条 · 暂不打分',
    ])
  })

  it('一个项目都没有：「全部」的副行、标题行和状态条都写「只有全局」，不写「0 个项目」', () => {
    const globalOnly = {
      pending: { ...pending, dot: 'none' as const, items: [], levelCounts: levelCountsOf([]) },
      library: { ...library, layers: [{ layer: GLOBAL, items: [g1] }] },
      deleted: { ...deleted, items: [] },
      health: { ...health, layers: [healthLayer(GLOBAL, 85, 'green')] },
    }
    open({ view: 'todo', scope: { kind: 'all' } }, createFakeGateway({ views: globalOnly }))
    expect(rowParts(railRow('全部')).sub).toBe('只有全局')
    expect(document.querySelector('.pm-head-title')!.parentElement).toHaveTextContent('只有全局')
    expect(screen.getByRole('region', { name: '记忆状况' })).toHaveTextContent('只有全局，共 1 条记忆')
    expect(document.body).not.toHaveTextContent('0 个项目')
  })

  it('配置文件关掉体检：副行只写条数，不写分数', () => {
    open({ view: 'todo' }, createFakeGateway({ currentWorkspace: '/w/app', views: { ...views, health: { ...health, governanceEnabled: false } } }))
    expect(rail().getAllByRole('button').map(b => rowParts(b).sub)).toEqual([
      '3 个项目和全局', '1 条', '2 条', '0 条', '1 条',
    ])
  })

  it('有事要处理的行带标记和件数：密钥红三角，其余琥珀圆点；读屏念「N 件待处理」，含密钥时说明；「全部」按条目去重', () => {
    open()
    const marker = (name: string) => railRow(name).querySelector('.pm-marker')?.getAttribute('class') ?? ''
    expect(rowParts(railRow('全部')).badge).toBe('3，3 件待处理，含密钥')
    expect(marker('全部')).toContain('pm-marker--secret')
    expect(rowParts(railRow('全局')).badge).toBe('1，1 件待处理')
    expect(marker('全局')).toContain('pm-marker--pending')
    expect(rowParts(railRow('app')).badge).toBe('2，2 件待处理')
    expect(rowParts(railRow('blog')).badge).toBe('')
    expect(rowParts(railRow('zeta')).badge).toBe('1，1 件待处理，含密钥')
    expect(marker('zeta')).toContain('pm-marker--secret')
  })

  it('点一行：写回导航、标为当前，右栏只看这个范围，按它借会话', () => {
    const { nav, gateway } = open()
    fireEvent.click(railRow('zeta'))
    expect(nav.get().scope).toEqual(ZETA)
    expect(railRow('zeta')).toHaveAttribute('aria-current', 'true')
    expect(railRow('全部')).not.toHaveAttribute('aria-current')
    expect(gateway.sessionRequests.at(-1)).toBe('/w/zeta')
    fireEvent.click(railRow('全局'))
    expect(gateway.sessionRequests.at(-1)).toBeUndefined()
  })

  it('上下键在范围间移动并选中，焦点跟着走；只有选中行在 Tab 序列里', () => {
    const { nav } = open()
    railRow('全部').focus()
    fireEvent.keyDown(railRow('全部'), { key: 'ArrowDown' })
    expect(nav.get().scope).toEqual(GLOBAL)
    expect(railRow('全局')).toHaveFocus()
    fireEvent.keyDown(railRow('全局'), { key: 'ArrowDown' })
    expect(railRow('app')).toHaveFocus()
    fireEvent.keyDown(railRow('app'), { key: 'ArrowUp' })
    fireEvent.keyDown(railRow('全局'), { key: 'ArrowUp' })
    expect(nav.get().scope).toEqual({ kind: 'all' })
    fireEvent.keyDown(railRow('全部'), { key: 'ArrowUp' })
    expect(railRow('全部')).toHaveFocus()
    expect(rail().getAllByRole('button').map(b => b.tabIndex)).toEqual([0, -1, -1, -1, -1])
  })

  it('底部「插件设置」跳插件页里本插件的配置', () => {
    const openSettings = vi.fn()
    const nav = createNavStore(undefined, { openSettings })
    renderInShell(<MemoryPage nav={nav} />, createFakeGateway({ views }))
    fireEvent.click(screen.getByRole('button', { name: '插件设置' }))
    expect(openSettings).toHaveBeenCalledTimes(1)
  })
})

describe('标题行与状态条', () => {
  const heading = () => document.querySelector<HTMLElement>('.pm-head-title')!
  const statusBar = () => screen.queryByRole('region', { name: '记忆状况' })

  it('标题行：项目写名称和路径，全局写「所有项目共用」，全部写「N 个项目和全局」', () => {
    open({ view: 'todo', scope: APP })
    expect(heading()).toHaveTextContent('app')
    expect(heading().parentElement).toHaveTextContent('/w/app')
    fireEvent.click(railRow('全局'))
    expect(heading()).toHaveTextContent('全局')
    expect(heading().parentElement).toHaveTextContent('所有项目共用')
    fireEvent.click(railRow('全部'))
    expect(heading()).toHaveTextContent('全部')
    expect(heading().parentElement).toHaveTextContent('3 个项目和全局')
  })

  it('分数分档：85 / 60 / 40 分别是绿、琥珀、红圆点，写良好 / 需要留意 / 有问题', () => {
    const scored: HealthView = { ...health, layers: [healthLayer(GLOBAL, 85, 'green'), healthLayer(APP, 60, 'amber'), healthLayer(ZETA, 40, 'red')] }
    open({ view: 'todo', scope: GLOBAL }, createFakeGateway({ views: { ...views, health: scored } }))
    const check = (text: RegExp, marker: string) => {
      expect(statusBar()).toHaveTextContent(text)
      expect(statusBar()!.querySelector('.pm-marker')).toHaveClass(marker)
    }
    check(/85 分\s*·\s*良好/, 'pm-marker--ok')
    fireEvent.click(railRow('app'))
    check(/60 分\s*·\s*需要留意/, 'pm-marker--pending')
    fireEvent.click(railRow('zeta'))
    check(/40 分\s*·\s*有问题/, 'pm-marker--error')
  })

  it('有密钥的范围：状态条红三角、不打分，写「暂不打分 · 有密钥，先处理」；条目在先处理组', () => {
    open({ view: 'todo', scope: ZETA })
    expect(statusBar()).toHaveTextContent(/暂不打分\s*·\s*有密钥，先处理/)
    expect(statusBar()).not.toHaveTextContent(/\d+ 分/)
    expect(statusBar()!.querySelector('.pm-marker')).toHaveClass('pm-marker--secret')
    expect(within(panel()).getByRole('heading', { level: 2 })).toHaveTextContent('先处理')
  })

  it('「全部」的状态条不打总分', () => {
    open()
    expect(statusBar()).toBeInTheDocument()
    expect(statusBar()).not.toHaveTextContent(/\d+ 分/)
  })
})

describe('视图切换与按范围筛选', () => {
  it('三个视图依次是处理、记忆查看、最近删除；计数跟着范围，最近删除为 0 时不写数', () => {
    open({ view: 'todo', scope: APP })
    expect(screen.getAllByRole('tab').map(t => t.textContent)).toEqual(['处理2· 可整理 1', '记忆查看2', '最近删除'])
    fireEvent.click(railRow('全部'))
    expect(screen.getAllByRole('tab').map(t => t.textContent)).toEqual(['处理3· 可整理 2', '记忆查看4', '最近删除1'])
  })

  it('英文界面：To do、Browse、Recently deleted', () => {
    const nav = createNavStore()
    render(<PanelShell gateway={createFakeGateway({ views })} t={createTranslator(en)}><MemoryPage nav={nav} /></PanelShell>)
    expect(screen.getAllByRole('tab').map(t => t.textContent)).toEqual(['To do3· Cleanup 2', 'Browse4', 'Recently deleted1'])
  })

  it('左栏件数和视图切换里的「处理 N」一致', () => {
    open()
    for (const name of ['全部', '全局', 'app', 'zeta']) {
      fireEvent.click(railRow(name))
      const n = rowParts(railRow(name)).badge.split('，')[0]
      expect(tab(/^处理/).querySelector('.pm-tab-count')?.textContent).toBe(n)
    }
  })

  it('选 app：处理视图只出现和 app 有关的条目；全局和 app 之间的冲突在全局、app 里都出现，在「全部」里只出现一次', () => {
    open({ view: 'todo', scope: APP })
    expect(cardTitles()).toEqual(['全局和 app 说法相反', '这条适合所有项目', '很久没确认'])
    fireEvent.click(railRow('全局'))
    expect(cardTitles()).toEqual(['全局和 app 说法相反', '已过有效期'])
    fireEvent.click(railRow('全部'))
    expect(cardTitles().filter(title => title === '全局和 app 说法相反')).toHaveLength(1)
  })

  it('「全部」里每条带范围胶囊（跨两个范围的带两个），选了具体范围就不带', () => {
    open()
    const chips = (title: string) => {
      const card = within(panel()).getByRole('heading', { level: 3, name: title }).closest('header')!
      return [...card.querySelectorAll('.pm-pending-scope')].map(c => c.textContent)
    }
    expect(chips('全局和 app 说法相反')).toEqual(['全局', 'app'])
    expect(chips('这条记忆里有密钥')).toEqual(['zeta'])
    fireEvent.click(railRow('app'))
    expect(chips('全局和 app 说法相反')).toEqual([])
  })

  it('换范围：上一个范围刚处理的结果卡不跟过来，也不写「都处理完了」', async () => {
    open({ view: 'todo', scope: GLOBAL })
    fireEvent.click(within(panel()).getByRole('button', { name: '忽略' }))
    await within(panel()).findByText('已忽略')
    fireEvent.click(railRow('blog'))
    expect(within(panel()).queryByText('已忽略')).toBeNull()
    expect(within(panel()).queryByRole('button', { name: '撤销' })).toBeNull()
    expect(within(panel()).queryByText('都处理完了，agent 之后按你的决定来。')).toBeNull()
  })

  it('左右键切视图，写回导航', () => {
    const { nav } = open()
    tab(/^处理/).focus()
    fireEvent.keyDown(tab(/^处理/), { key: 'ArrowRight' })
    expect(nav.get().view).toBe('library')
    expect(tab(/^记忆查看/)).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(tab(/^记忆查看/), { key: 'ArrowRight' })
    expect(nav.get().view).toBe('deleted')
  })

  it('入口直达：先写目标再切面板，页面跟着目标走', () => {
    const nav = createNavStore()
    const order: string[] = []
    const selectPanel = vi.fn(() => { order.push('select') })
    renderInShell(<MemoryPage nav={nav} />, createFakeGateway({ views }))
    nav.subscribe(() => { order.push('nav') })
    act(() => { openMemoryPage({ layout: { selectPanel } }, nav, { view: 'library', scope: APP, memoryId: 'a2' }) })
    expect(order).toEqual(['nav', 'select'])
    expect(selectPanel).toHaveBeenCalledWith(PANEL_ID)
    expect(tab(/^记忆查看/)).toHaveAttribute('aria-selected', 'true')
    expect(railRow('app')).toHaveAttribute('aria-current', 'true')
  })
})

describe('落点与旧导航目标', () => {
  const titleRow = () => document.querySelector<HTMLElement>('.pm-head-main')!

  it('从左栏图标进（没有入口写目标）落在「全部」的处理视图', () => {
    const nav = createNavStore({ view: 'library', scope: APP })
    renderInShell(<MemoryPage nav={nav} />, createFakeGateway({ currentWorkspace: '/w/app', views }))
    expect(nav.get()).toEqual({ view: 'todo' })
    expect(railRow('全部')).toHaveAttribute('aria-current', 'true')
    expect(tab(/^处理/)).toHaveAttribute('aria-selected', 'true')
  })

  it('从对话进来落在那个对话的项目，标题行和左栏都标「当前对话」', () => {
    open({ view: 'todo', fromChat: true })
    expect(railRow('app')).toHaveAttribute('aria-current', 'true')
    expect(tab(/^处理/)).toHaveAttribute('aria-selected', 'true')
    expect(within(titleRow()).getAllByText(/./).map(el => el.textContent)).toEqual(['app', '当前对话', '/w/app'])
    expect(rowParts(railRow('app')).sub).toMatch(/· 当前对话$/)
    expect(rowParts(railRow('全局')).sub).not.toMatch(/当前对话/)
  })

  it('不是从对话进来的不标「当前对话」', () => {
    open({ view: 'todo', scope: APP })
    expect(titleRow()).not.toHaveTextContent('当前对话')
    expect(rowParts(railRow('app')).sub).not.toMatch(/当前对话/)
  })

  it('对话的项目没有待处理也没有可整理：落在记忆查看；没有记忆也列进左栏', () => {
    open({ view: 'todo', fromChat: true }, createFakeGateway({ currentWorkspace: '/w/new', views }))
    expect(railRow('new')).toHaveAttribute('aria-current', 'true')
    expect(rail().getAllByRole('button').map(b => rowParts(b).name)).toEqual(['全部', '全局', 'app', 'blog', 'new', 'zeta'])
    expect(tab(/^记忆查看/)).toHaveAttribute('aria-selected', 'true')
    // 落点只改一次：用户自己切回处理视图就停在处理
    fireEvent.click(tab(/^处理/))
    expect(tab(/^处理/)).toHaveAttribute('aria-selected', 'true')
  })

  it('从对话进来带了组或记忆：照目标落，不改去记忆查看', () => {
    open({ view: 'todo', fromChat: true, level: 'your-call' }, createFakeGateway({ currentWorkspace: '/w/blog', views }))
    expect(tab(/^处理/)).toHaveAttribute('aria-selected', 'true')
  })

  it('对话不在项目里：落在全局', () => {
    open({ view: 'todo', fromChat: true }, createFakeGateway({ currentWorkspace: undefined, views }))
    expect(railRow('全局')).toHaveAttribute('aria-current', 'true')
  })

  it('「查看详情」落在那条记忆所在范围的记忆查看，高亮那一行', () => {
    open({ view: 'library', scope: APP, memoryId: 'a2', fromChat: true })
    expect(railRow('app')).toHaveAttribute('aria-current', 'true')
    expect(tab(/^记忆查看/)).toHaveAttribute('aria-selected', 'true')
    expect(within(panel()).getAllByRole('listitem').filter(li => li.classList.contains('pm-flash'))).toHaveLength(1)
  })

  it('旧目标「健康」落在处理视图；带组的焦点落在组标题', async () => {
    const { nav } = open({ tab: 'health', level: 'must-fix' })
    expect(nav.get()).toEqual({ view: 'todo', level: 'must-fix' })
    expect(tab(/^处理/)).toHaveAttribute('aria-selected', 'true')
    await waitFor(() => { expect(within(panel()).getByRole('heading', { level: 2, name: /^先处理/ })).toHaveFocus() })
  })

  it('旧目标「待处理」「全部记忆」「最近删除」分别落在处理、记忆查看、最近删除', () => {
    for (const [legacy, name] of [['pending', /^处理/], ['library', /^记忆查看/], ['deleted', /^最近删除/]] as const) {
      open({ tab: legacy })
      expect(tab(name)).toHaveAttribute('aria-selected', 'true')
      cleanup()
    }
  })
})

describe('窄屏', () => {
  const select = () => screen.getByRole('combobox', { name: '范围' })

  it('「范围」下拉列出全部、全局、各项目，选了就换范围；旁边「设置」跳插件页', () => {
    const openSettings = vi.fn()
    const nav = createNavStore(undefined, { openSettings })
    renderInShell(<MemoryPage nav={nav} />, createFakeGateway({ views }))
    expect(within(select()).getAllByRole('option').map(o => o.textContent)).toEqual(['全部', '全局', 'app', 'blog', 'zeta'])
    expect(select()).toHaveDisplayValue('全部')
    fireEvent.change(select(), { target: { value: within(select()).getByRole('option', { name: 'zeta' }).getAttribute('value') } })
    expect(nav.get().scope).toEqual(ZETA)
    expect(document.querySelector('.pm-head-title')).toHaveTextContent('zeta')
    fireEvent.click(screen.getByRole('button', { name: '设置' }))
    expect(openSettings).toHaveBeenCalledTimes(1)
  })

  it('别的范围还有待处理时下拉下面一行「其他范围还有 N 件待处理 ›」，带密钥时是红三角；点了回到「全部」', () => {
    const { nav } = open({ view: 'todo', scope: APP })
    const others = screen.getByRole('button', { name: /^其他范围还有/ })
    expect(others).toHaveTextContent('其他范围还有 1 件待处理 ›')
    expect(others.querySelector('.pm-marker')).toHaveClass('pm-marker--secret')
    fireEvent.click(others)
    expect(nav.get().scope).toEqual({ kind: 'all' })
    expect(screen.queryByRole('button', { name: /^其他范围还有/ })).toBeNull()
  })

  it('其他范围按条目去重：跨全局和 app 的冲突在 app 里算本范围', () => {
    open({ view: 'todo', scope: ZETA })
    expect(screen.getByRole('button', { name: /^其他范围还有/ })).toHaveTextContent('其他范围还有 2 件待处理 ›')
  })
})

describe('没有会话', () => {
  it('显示空态和「开始一次对话后，这里会显示记忆和体检结果。」；没有左栏、标题行、视图切换和状态条', () => {
    renderInShell(<MemoryPage nav={createNavStore()} />, createFakeGateway({ session: { kind: 'none' }, views }))
    expect(screen.getByRole('status')).toHaveTextContent('开始一次对话后，这里会显示记忆和体检结果。')
    expect(screen.queryByRole('navigation', { name: '范围' })).toBeNull()
    expect(screen.queryByRole('combobox', { name: '范围' })).toBeNull()
    expect(document.querySelector('.pm-head-title')).toBeNull()
    expect(screen.queryByRole('tab')).toBeNull()
    expect(screen.queryByRole('region', { name: '记忆状况' })).toBeNull()
  })
})
