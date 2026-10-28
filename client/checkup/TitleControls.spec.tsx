import { describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import {
  GUI_VIEW_VERSION,
  type AutoCheckupFrequency, type CheckupView, type GuiLayerRef, type HealthView, type LibraryView, type MemoryCommand, type MemoryCommandResult, type PendingView,
} from '../../src/gui/contract.ts'
import { createFakeGateway, type FakeGatewayInit } from '../gateway.fake.ts'
import { createTranslator } from '../i18n.tsx'
import { en } from '../locales.ts'
import { MemoryPage, memoryPageCss } from '../MemoryPage.tsx'
import { createNavStore, openMemoryPage } from '../nav.ts'
import { levelCountsOf, memory, NOW, renderInShell } from '../test-utils.tsx'
import { PanelShell } from '../ui/PanelShell.tsx'

const GLOBAL: GuiLayerRef = { kind: 'global' }
const APP: GuiLayerRef = { kind: 'workspace', workspacePath: '/w/app' }
const BLOG: GuiLayerRef = { kind: 'workspace', workspacePath: '/w/blog' }
const ZETA: GuiLayerRef = { kind: 'workspace', workspacePath: '/w/zeta' }

const g1 = memory({ id: 'g1', name: 'g1', scope: 'global', workspacePath: undefined })
const a1 = memory({ id: 'a1', name: 'a1' })
const a2 = memory({ id: 'a2', name: 'a2' })
const b1 = memory({ id: 'b1', name: 'b1', workspacePath: '/w/blog' })
const z1 = memory({ id: 'z1', name: 'z1', workspacePath: '/w/zeta' })

const conflictItems: PendingView['items'] = [
  { kind: 'conflict-horizontal', level: 'your-call', decisionId: 'c1', firstSeenAt: 1, summary: '全局和 app 说法相反', left: g1, right: a1 },
]
const pending: PendingView = { version: GUI_VIEW_VERSION, dot: 'amber', typeLabels: {}, items: conflictItems, levelCounts: levelCountsOf(conflictItems) }
const library: LibraryView = {
  version: GUI_VIEW_VERSION, memoryRoot: '/h/memories', directoryIssues: [],
  layers: [{ layer: GLOBAL, items: [g1] }, { layer: APP, items: [a1, a2] }, { layer: BLOG, items: [b1] }, { layer: ZETA, items: [z1] }],
}

function healthLayer(layer: GuiLayerRef): HealthView['layers'][number] {
  return {
    layer, totalMemories: 1, score: 90, tier: 'green', gate: { secret: false }, issues: [], staleCount: 0,
    lastCheckupAt: NOW - 86_400_000, overflow: null, ignored: [],
    deductions: { rule: { points: 0, types: [] }, content: { points: 0, types: [] }, freshness: { points: 0, types: [] } },
  }
}
const health = (governanceEnabled = true): HealthView => ({
  version: GUI_VIEW_VERSION, governanceEnabled, layers: [healthLayer(GLOBAL), healthLayer(APP), healthLayer(BLOG), healthLayer(ZETA)],
})

/** 体检视图夹具：own 是单独设置了的范围（键：global 或项目路径）；zeta 不在视图里，当作刚加的新项目。 */
function checkups({ all = 'manual', own = {}, inProgress = [], governanceEnabled = true }: {
  all?: AutoCheckupFrequency
  own?: Record<string, AutoCheckupFrequency>
  inProgress?: readonly string[]
  governanceEnabled?: boolean
} = {}): CheckupView {
  const scope = (layer: GuiLayerRef): CheckupView['scopes'][number] => {
    const key = layer.kind === 'global' ? 'global' : layer.workspacePath
    const isOwn = own[key] !== undefined
    return {
      scope: layer, frequency: own[key] ?? all, isOwn, lastCheckupAt: NOW - 86_400_000, nextCheckupAt: null, isDue: false,
      isInProgress: inProgress.includes(key), failure: null, modelUnavailable: null, lastResult: null,
    }
  }
  return { version: GUI_VIEW_VERSION, governanceEnabled, defaultFrequency: all, allResult: null, scopes: [scope(GLOBAL), scope(APP), scope(BLOG)] }
}

const views = { pending, library, health: health(), checkups: checkups() }

function open(scope: GuiLayerRef | { kind: 'all' } = { kind: 'all' }, init: FakeGatewayInit = {}) {
  const nav = createNavStore()
  openMemoryPage({ layout: { selectPanel: vi.fn() } }, nav, { view: 'todo', scope })
  const gateway = createFakeGateway({ currentWorkspace: '/w/app', views, ...init, ...(init.views ? { views: { ...views, ...init.views } } : {}) })
  renderInShell(<MemoryPage nav={nav} />, gateway)
  return { nav, gateway }
}

const rail = () => within(screen.getByRole('navigation', { name: '范围' }))
const pick = (name: string) => { fireEvent.click(rail().getByRole('button', { name: new RegExp(`^${name}`) })) }
const head = () => document.querySelector<HTMLElement>('.pm-head')!
const runButton = () => within(head()).getByRole('button', { name: /立即体检|体检中…/ })
const autoButton = () => within(head()).getByRole('button', { name: /的自动体检：/ })
const menu = () => screen.getByRole('menu')
const option = (name: RegExp | string) => within(menu()).getByRole('menuitemradio', { name })
const checkedOption = () => within(menu()).getAllByRole('menuitemradio').filter(el => el.getAttribute('aria-checked') === 'true')
const daysInput = () => within(menu()).getByRole('textbox')
const overrides = () => within(menu()).queryAllByRole('menuitem').map(el => el.closest('li')!.querySelector('.pm-auto-own-label')!.textContent)

/** 可以手动放行的命令结果：模拟体检进行中。 */
function deferred() {
  let resolve!: (r: MemoryCommandResult) => void
  const promise = new Promise<MemoryCommandResult>((r) => { resolve = r })
  return { promise, resolve }
}

describe('立即体检：按范围发出的 scan 目标', () => {
  it('「全部」不带参数；全局只查全局层；项目带它的路径', async () => {
    const { gateway } = open()
    await act(async () => { fireEvent.click(runButton()) })
    pick('全局')
    await act(async () => { fireEvent.click(runButton()) })
    pick('app')
    await act(async () => { fireEvent.click(runButton()) })
    expect(gateway.executed.map(e => e.command)).toEqual([
      { cmd: 'scan' },
      { cmd: 'scan', layer: { kind: 'global' } },
      { cmd: 'scan', workspacePath: '/w/app' },
    ])
  })

  it('悬停提示写清会查谁、记忆越多 token 越多；「全部」写逐个查全局和 N 个项目', () => {
    open()
    expect(runButton()).toHaveAttribute('title', '逐个检查全局和 3 个项目的记忆；记忆越多，用的 token 越多')
    pick('全局')
    expect(runButton()).toHaveAttribute('title', '只检查全局记忆；记忆越多，用的 token 越多')
    pick('app')
    expect(runButton()).toHaveAttribute('title', '检查 app 的记忆；记忆越多，用的 token 越多')
  })

  it('「全部」提示里的项目数按会体检的范围算：只剩最近删除的项目列在左栏，不算进去', () => {
    const old = memory({ id: 'o1', name: 'o1', workspacePath: '/w/old' })
    open({ kind: 'all' }, { views: { deleted: { version: GUI_VIEW_VERSION, items: [{ memory: old, deletedAt: NOW - 1000, purgeAt: NOW + 86_400_000 }] } } })
    expect(head()).toHaveTextContent('4 个项目和全局')
    expect(runButton()).toHaveAttribute('title', '逐个检查全局和 3 个项目的记忆；记忆越多，用的 token 越多')
  })
})

describe('立即体检：范围里还没有记忆', () => {
  const NEW: GuiLayerRef = { kind: 'workspace', workspacePath: '/w/new' }
  const emptyLibrary = (layers: LibraryView['layers']): LibraryView => ({ ...library, layers })
  const note = () => screen.getByRole('dialog')

  it('还没有记忆的项目：不发命令，在按钮处弹出提示；按钮不置灰、悬停提示照旧；Esc 关掉、焦点回按钮', async () => {
    const { gateway } = open(NEW)
    expect(runButton()).not.toHaveAttribute('aria-disabled')
    expect(runButton()).toHaveAttribute('title', '检查 new 的记忆；记忆越多，用的 token 越多')
    await act(async () => { fireEvent.click(runButton()) })
    expect(gateway.executed).toEqual([])
    expect(note()).toHaveTextContent('这个项目暂时没有记忆，没有可体检的内容。')
    expect(head()).toContainElement(note())
    expect(note()).toContainElement(document.activeElement as HTMLElement)
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(runButton()).toHaveFocus()
    expect(runButton()).toHaveTextContent('立即体检')
  })

  it('点外面关掉；再点按钮收起', () => {
    open(NEW)
    fireEvent.click(runButton())
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(runButton())
    expect(note()).toBeInTheDocument()
    fireEvent.click(runButton())
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('全局、「全部」整体为空时各写各的；只剩最近删除的项目同样算没有记忆', () => {
    const empty = emptyLibrary([{ layer: GLOBAL, items: [] }])
    open(GLOBAL, { views: { library: empty } })
    fireEvent.click(runButton())
    expect(note()).toHaveTextContent('全局暂时没有记忆，没有可体检的内容。')
    cleanup()
    const { gateway } = open({ kind: 'all' }, { views: { library: empty } })
    fireEvent.click(runButton())
    expect(note()).toHaveTextContent('暂时没有记忆，没有可体检的内容。')
    expect(note()).not.toHaveTextContent('全局')
    expect(gateway.executed).toEqual([])
    cleanup()
    const gone = memory({ id: 'o1', name: 'o1', workspacePath: '/w/gone' })
    open({ kind: 'workspace', workspacePath: '/w/gone' }, { views: { deleted: { version: GUI_VIEW_VERSION, items: [{ memory: gone, deletedAt: NOW - 1000, purgeAt: NOW + 86_400_000 }] } } })
    fireEvent.click(runButton())
    expect(note()).toHaveTextContent('这个项目暂时没有记忆，没有可体检的内容。')
  })

  it('有记忆的范围照常发命令，不弹提示', async () => {
    const { gateway } = open(APP)
    await act(async () => { fireEvent.click(runButton()) })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(gateway.executed.map(e => e.command)).toEqual([{ cmd: 'scan', workspacePath: '/w/app' }])
  })
})

describe('立即体检：体检中…', () => {
  it('本窗口发起的：点了就禁用、显示「体检中…」，再点不重发；切去别的范围再回来仍在体检；命令回来后恢复', async () => {
    const run = deferred()
    const { gateway } = open(APP, { respond: () => run.promise })
    fireEvent.click(runButton())
    expect(runButton()).toHaveTextContent('体检中…')
    expect(runButton()).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(runButton())
    expect(gateway.executed).toHaveLength(1)
    pick('全局')
    expect(runButton()).toHaveTextContent('立即体检')
    pick('全部')
    // 「全部」在任一范围进行中时置灰
    expect(runButton()).toHaveAttribute('aria-disabled', 'true')
    expect(runButton()).toHaveAttribute('title', 'app 正在体检，查完再来')
    pick('app')
    expect(runButton()).toHaveTextContent('体检中…')
    await act(async () => { run.resolve({ ok: true, cmd: 'scan' }) })
    expect(runButton()).toHaveTextContent('立即体检')
    expect(runButton()).not.toHaveAttribute('aria-disabled')
  })

  it('本窗口发起「全部」：各范围的按钮也显示「体检中…」', () => {
    const run = deferred()
    open({ kind: 'all' }, { respond: () => run.promise })
    fireEvent.click(runButton())
    expect(runButton()).toHaveTextContent('体检中…')
    pick('全局')
    expect(runButton()).toHaveTextContent('体检中…')
    expect(runButton()).toHaveAttribute('aria-disabled', 'true')
  })

  it('视图里这个范围正在体检（别的窗口或自动体检）：显示「体检中…」并禁用，别的范围不受影响；「全部」置灰并写谁在体检', () => {
    const { gateway } = open(APP, { views: { checkups: checkups({ inProgress: ['/w/app'] }) } })
    expect(runButton()).toHaveTextContent('体检中…')
    expect(runButton()).toHaveAttribute('aria-disabled', 'true')
    expect(runButton()).toHaveAttribute('title', 'app 正在体检，查完再来')
    fireEvent.click(runButton())
    expect(gateway.executed).toEqual([])
    pick('全局')
    expect(runButton()).toHaveTextContent('立即体检')
    expect(runButton()).not.toHaveAttribute('aria-disabled')
    pick('全部')
    expect(runButton()).toHaveTextContent('体检中…')
    expect(runButton()).toHaveAttribute('aria-disabled', 'true')
    expect(runButton()).toHaveAttribute('title', 'app 正在体检，查完再来')
    // 体检完、视图重写后恢复
    act(() => { gateway.setView('checkups', checkups()) })
    expect(runButton()).toHaveTextContent('立即体检')
    expect(runButton()).toHaveAttribute('title', '逐个检查全局和 3 个项目的记忆；记忆越多，用的 token 越多')
  })

  it('全局正在体检时「全部」的提示写「全局记忆正在体检」', () => {
    open({ kind: 'all' }, { views: { checkups: checkups({ inProgress: ['global'] }) } })
    expect(runButton()).toHaveAttribute('title', '全局记忆正在体检，查完再来')
  })

  it('命令回 busy：按「体检中…」显示，不报错；体检视图重写后恢复', async () => {
    const { gateway } = open(GLOBAL, { respond: () => ({ ok: false, cmd: 'scan', code: 'busy', detail: '全局 正在体检，查完再来' }) })
    await act(async () => { fireEvent.click(runButton()) })
    expect(runButton()).toHaveTextContent('体检中…')
    expect(runButton()).toHaveAttribute('aria-disabled', 'true')
    expect(screen.queryByText(/正在体检，查完再来/)).toBeNull()
    act(() => { gateway.setView('checkups', checkups()) })
    expect(runButton()).toHaveTextContent('立即体检')
  })

  it('「全部」回 busy：只有「全部」显示「体检中…」，各范围照常可以体检', async () => {
    open({ kind: 'all' }, { respond: () => ({ ok: false, cmd: 'scan', code: 'busy', detail: '/w/blog 正在体检，查完再来' }) })
    await act(async () => { fireEvent.click(runButton()) })
    expect(runButton()).toHaveTextContent('体检中…')
    pick('全局')
    expect(runButton()).toHaveTextContent('立即体检')
    expect(runButton()).not.toHaveAttribute('aria-disabled')
    pick('app')
    expect(runButton()).toHaveTextContent('立即体检')
  })

  it('busy 与 claimed 分开：裁决回 claimed 写原有的「没有生效」，不让体检按钮变成「体检中…」；体检回别的错误也不显示体检中', async () => {
    const respond = (command: MemoryCommand): MemoryCommandResult => command.cmd === 'scan'
      ? { ok: false, cmd: 'scan', code: 'llm-unavailable' }
      : { ok: false, cmd: command.cmd, code: 'claimed', detail: '待决项 c1 正在被另一次裁决处理，未做任何改动。' }
    open(APP, { respond })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '以 B 为准' })) })
    expect(await screen.findByRole('alert')).toHaveTextContent('没有生效：它正在别处处理，或者刚在别处处理完。')
    expect(runButton()).toHaveTextContent('立即体检')
    await act(async () => { fireEvent.click(runButton()) })
    expect(runButton()).toHaveTextContent('立即体检')
    expect(runButton()).not.toHaveAttribute('aria-disabled')
  })
})

describe('自动体检按钮与菜单：情况表', () => {
  const openMenu = () => { fireEvent.click(autoButton()) }

  it('什么都没设：「全部」仅手动；项目仅手动（跟随），菜单第一项「跟随全部（仅手动）」打勾', () => {
    open()
    expect(autoButton()).toHaveTextContent('自动体检仅手动')
    expect(autoButton()).toHaveAccessibleName('全部记忆的自动体检：仅手动')
    openMenu()
    expect(within(menu()).queryByRole('menuitemradio', { name: /跟随全部/ })).toBeNull()
    expect(checkedOption().map(el => el.getAttribute('aria-label'))).toEqual(['仅手动'])
    expect(overrides()).toEqual([])
    fireEvent.keyDown(menu(), { key: 'Escape' })
    pick('app')
    expect(autoButton()).toHaveTextContent('自动体检仅手动')
    expect(autoButton()).toHaveAccessibleName('app 的自动体检：仅手动，跟随全部')
    openMenu()
    expect(within(menu()).getAllByRole('menuitemradio')[0]).toHaveAccessibleName('跟随全部（仅手动）')
    expect(checkedOption().map(el => el.getAttribute('aria-label'))).toEqual(['跟随全部（仅手动）'])
  })

  it('在「全部」改成每 7 天：发 set-auto-checkup；视图更新后「全部」、跟随的项目、新项目都是每 7 天', async () => {
    const { gateway } = open()
    openMenu()
    fireEvent.change(daysInput(), { target: { value: '7' } })
    await act(async () => { fireEvent.keyDown(daysInput(), { key: 'Enter' }) })
    expect(gateway.executed.map(e => e.command)).toEqual([{ cmd: 'set-auto-checkup', scope: { kind: 'all' }, frequency: 7 }])
    expect(screen.queryByRole('menu')).toBeNull()
    act(() => { gateway.setView('checkups', checkups({ all: 7 })) })
    expect(autoButton()).toHaveTextContent('自动体检每 7 天')
    pick('app')
    expect(autoButton()).toHaveAccessibleName('app 的自动体检：每 7 天，跟随全部')
    pick('zeta')
    expect(autoButton()).toHaveAccessibleName('zeta 的自动体检：每 7 天，跟随全部')
  })

  it('在项目里单独改成每天：项目每天（单独设置），「全部」菜单列出「app · 每天」，其他范围仍每 7 天', async () => {
    const { gateway } = open(APP, { views: { checkups: checkups({ all: 7 }) } })
    openMenu()
    await act(async () => { fireEvent.click(option('每天')) })
    expect(gateway.executed.map(e => e.command)).toEqual([{ cmd: 'set-auto-checkup', scope: APP, frequency: 1 }])
    act(() => { gateway.setView('checkups', checkups({ all: 7, own: { '/w/app': 1 } })) })
    expect(autoButton()).toHaveAccessibleName('app 的自动体检：每天，单独设置')
    openMenu()
    expect(checkedOption().map(el => el.getAttribute('aria-label'))).toEqual(['每天'])
    fireEvent.keyDown(menu(), { key: 'Escape' })
    pick('全局')
    expect(autoButton()).toHaveAccessibleName('全局记忆的自动体检：每 7 天，跟随全部')
    pick('全部')
    expect(autoButton()).toHaveTextContent('每 7 天')
    openMenu()
    expect(within(menu()).getByText('单独设置的，不跟这里')).toBeInTheDocument()
    expect(overrides()).toEqual(['app · 每天'])
    expect(menu()).toHaveTextContent('其余范围和新项目都按这个频率查，各自计时。')
  })

  it('回到「全部」改成仅手动：单独设置的项目不跟，仍每天，列表里仍有它', async () => {
    const { gateway } = open({ kind: 'all' }, { views: { checkups: checkups({ all: 7, own: { '/w/app': 1 } }) } })
    openMenu()
    await act(async () => { fireEvent.click(option('仅手动')) })
    expect(gateway.executed.map(e => e.command)).toEqual([{ cmd: 'set-auto-checkup', scope: { kind: 'all' }, frequency: 'manual' }])
    act(() => { gateway.setView('checkups', checkups({ all: 'manual', own: { '/w/app': 1 } })) })
    expect(autoButton()).toHaveTextContent('仅手动')
    openMenu()
    expect(overrides()).toEqual(['app · 每天'])
    fireEvent.keyDown(menu(), { key: 'Escape' })
    pick('app')
    expect(autoButton()).toHaveAccessibleName('app 的自动体检：每天，单独设置')
    pick('blog')
    expect(autoButton()).toHaveAccessibleName('blog 的自动体检：仅手动，跟随全部')
  })

  it('项目里选「跟随全部」：发 follow；视图更新后跟随、列表清空', async () => {
    const { gateway } = open(APP, { views: { checkups: checkups({ own: { '/w/app': 1 } }) } })
    openMenu()
    await act(async () => { fireEvent.click(option('跟随全部（仅手动）')) })
    expect(gateway.executed.map(e => e.command)).toEqual([{ cmd: 'set-auto-checkup', scope: APP, frequency: 'follow' }])
    act(() => { gateway.setView('checkups', checkups()) })
    expect(autoButton()).toHaveAccessibleName('app 的自动体检：仅手动，跟随全部')
    pick('全部')
    openMenu()
    expect(overrides()).toEqual([])
    expect(within(menu()).queryByText('单独设置的，不跟这里')).toBeNull()
  })

  it('在「全部」点「改回跟随」：发 follow，这一行消失，菜单不关，焦点留在菜单里', async () => {
    const { gateway } = open({ kind: 'all' }, { views: { checkups: checkups({ own: { '/w/app': 1, global: 3 } }) } })
    openMenu()
    expect(overrides()).toEqual(['全局 · 每 3 天', 'app · 每天'])
    const back = within(menu()).getByRole('menuitem', { name: 'app 改回跟随' })
    back.focus()
    await act(async () => { fireEvent.click(back) })
    expect(gateway.executed.map(e => e.command)).toEqual([{ cmd: 'set-auto-checkup', scope: APP, frequency: 'follow' }])
    expect(screen.getByRole('menu')).toBeInTheDocument()
    expect(overrides()).toEqual(['全局 · 每 3 天'])
    expect(menu()).toContainElement(document.activeElement as HTMLElement)
    // 视图跟上后仍不出现
    act(() => { gateway.setView('checkups', checkups({ own: { global: 3 } })) })
    expect(overrides()).toEqual(['全局 · 每 3 天'])
  })

  it('「改回跟随」失败：这一行回来', async () => {
    open({ kind: 'all' }, {
      views: { checkups: checkups({ own: { '/w/app': 1 } }) },
      respond: () => ({ ok: false, cmd: 'set-auto-checkup', code: 'failed', detail: 'x' }),
    })
    openMenu()
    await act(async () => { fireEvent.click(within(menu()).getByRole('menuitem', { name: 'app 改回跟随' })) })
    expect(overrides()).toEqual(['app · 每天'])
  })

  it('选一档失败：按钮旁写「没有保存成功，再试一次。」，按钮保持原值；下一次成功后消失', async () => {
    let isOk = false
    open({ kind: 'all' }, { respond: command => isOk ? { ok: true, cmd: command.cmd } : { ok: false, cmd: command.cmd, code: 'failed', detail: 'x' } })
    expect(within(head()).queryByText('没有保存成功，再试一次。')).toBeNull()
    openMenu()
    await act(async () => { fireEvent.click(option('每天')) })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(within(head()).getByRole('status')).toHaveTextContent('没有保存成功，再试一次。')
    expect(autoButton()).toHaveTextContent('自动体检仅手动')
    isOk = true
    openMenu()
    await act(async () => { fireEvent.click(option('每天')) })
    expect(within(head()).queryByText('没有保存成功，再试一次。')).toBeNull()
  })

  it('窄窗口（主区约 400px）里提示不撑出横向滚动：标题行动作区和自动体检控件都能折行，动作区不超过标题行宽', () => {
    /** 选择器正好是 selector 的那条规则的声明。 */
    const rule = (selector: string) => memoryPageCss.match(new RegExp(`(?:^|\\n)${selector.replace(/[.-]/g, '\\$&')} \\{([^}]*)\\}`))?.[1] ?? ''
    expect(rule('.pm-head-actions')).toMatch(/flex-wrap: wrap/)
    expect(rule('.pm-head-actions')).toMatch(/min-width: 0/)
    expect(rule('.pm-head-actions')).toMatch(/max-width: 100%/)
    expect(rule('.pm-head-actions')).not.toMatch(/flex-shrink: 0/)
    expect(rule('.pm-auto')).toMatch(/flex-wrap: wrap/)
    expect(rule('.pm-auto')).toMatch(/min-width: 0/)
  })

  it('失败的提示在再次打开、关掉菜单后消失；「改回跟随」失败也写这一句', async () => {
    open({ kind: 'all' }, {
      views: { checkups: checkups({ own: { '/w/app': 1 } }) },
      respond: command => ({ ok: false, cmd: command.cmd, code: 'failed', detail: 'x' }),
    })
    openMenu()
    await act(async () => { fireEvent.click(within(menu()).getByRole('menuitem', { name: 'app 改回跟随' })) })
    expect(screen.getByRole('menu')).toBeInTheDocument()
    expect(within(head()).getByText('没有保存成功，再试一次。')).toBeInTheDocument()
    fireEvent.keyDown(menu(), { key: 'Escape' })
    expect(within(head()).queryByText('没有保存成功，再试一次。')).toBeNull()
  })

  it('「全部」每 7 天时在项目里手动选每 7 天：算单独设置，之后改「全部」它不跟', async () => {
    const { gateway } = open(APP, { views: { checkups: checkups({ all: 7 }) } })
    openMenu()
    expect(daysInput()).toHaveValue('7')
    await act(async () => { fireEvent.keyDown(daysInput(), { key: 'Enter' }) })
    expect(gateway.executed.map(e => e.command)).toEqual([{ cmd: 'set-auto-checkup', scope: APP, frequency: 7 }])
    act(() => { gateway.setView('checkups', checkups({ all: 7, own: { '/w/app': 7 } })) })
    expect(autoButton()).toHaveAccessibleName('app 的自动体检：每 7 天，单独设置')
    openMenu()
    expect(checkedOption().map(el => el.getAttribute('aria-label'))).toEqual(['每 7 天'])
    fireEvent.keyDown(menu(), { key: 'Escape' })
    act(() => { gateway.setView('checkups', checkups({ all: 'manual', own: { '/w/app': 7 } })) })
    expect(autoButton()).toHaveAccessibleName('app 的自动体检：每 7 天，单独设置')
    pick('全部')
    openMenu()
    expect(overrides()).toEqual(['app · 每 7 天'])
  })

  it('新加的项目（体检视图里还没有）跟随「全部」当前的值', () => {
    open(ZETA, { views: { checkups: checkups({ all: 3, own: { '/w/app': 1 } }) } })
    expect(autoButton()).toHaveAccessibleName('zeta 的自动体检：每 3 天，跟随全部')
  })

  it('菜单标题和底部说明随范围变', () => {
    open()
    fireEvent.click(autoButton())
    expect(menu()).toHaveAccessibleName('全部记忆的自动体检')
    expect(menu()).toHaveTextContent('全局和各项目都按这个频率查，各自计时；新项目也一样。用 dsh 当前的默认模型检查内容，记忆越多，token 用得越多；dsh 没开时不查，打开后补上。')
    fireEvent.keyDown(menu(), { key: 'Escape' })
    pick('全局')
    fireEvent.click(autoButton())
    expect(menu()).toHaveAccessibleName('全局记忆的自动体检')
    expect(menu()).toHaveTextContent('只查全局记忆。用 dsh 当前的默认模型检查内容')
    fireEvent.keyDown(menu(), { key: 'Escape' })
    pick('app')
    fireEvent.click(autoButton())
    expect(menu()).toHaveAccessibleName('app 的自动体检')
    expect(menu()).toHaveTextContent('只查 app 的记忆。用 dsh 当前的默认模型检查内容')
  })
})

describe('自动体检菜单：每 N 天的输入', () => {
  const setup = () => {
    const result = open()
    fireEvent.click(autoButton())
    return result
  }
  const hint = () => document.getElementById(daysInput().getAttribute('aria-describedby')!)

  it('边输边校验：0、91、小数、非数字、空都说明换成「填 1 到 90 的整数。」，回车不生效；带着错值失焦只收起不发', async () => {
    const { gateway } = setup()
    for (const value of ['0', '91', '2.5', 'abc', '']) {
      fireEvent.change(daysInput(), { target: { value } })
      expect(daysInput()).toHaveAttribute('aria-invalid', 'true')
      expect(hint()).toHaveTextContent('填 1 到 90 的整数。')
      await act(async () => { fireEvent.keyDown(daysInput(), { key: 'Enter' }) })
      expect(screen.getByRole('menu')).toBeInTheDocument()
    }
    fireEvent.change(daysInput(), { target: { value: '90' } })
    expect(daysInput()).not.toHaveAttribute('aria-invalid')
    expect(hint()).toHaveTextContent('dsh 开着时，距上次体检满这么多天就在后台查一次。')
    fireEvent.change(daysInput(), { target: { value: '0' } })
    await act(async () => { fireEvent.blur(daysInput()) })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(gateway.executed).toEqual([])
  })

  it('失焦生效：改过的合法值在焦点离开菜单时发出去并收起；没改过只收起不发；在菜单里上下移动不算失焦', async () => {
    const { gateway } = setup()
    fireEvent.blur(daysInput())
    expect(screen.queryByRole('menu')).toBeNull()
    expect(gateway.executed).toEqual([])
    fireEvent.click(autoButton())
    fireEvent.change(daysInput(), { target: { value: '30' } })
    fireEvent.keyDown(daysInput(), { key: 'ArrowUp' })
    expect(option('每天')).toHaveFocus()
    expect(gateway.executed).toEqual([])
    daysInput().focus()
    await act(async () => { fireEvent.blur(daysInput()) })
    expect(gateway.executed.map(e => e.command)).toEqual([{ cmd: 'set-auto-checkup', scope: { kind: 'all' }, frequency: 30 }])
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('点菜单外：改过的合法值同样生效', async () => {
    const { gateway } = setup()
    fireEvent.change(daysInput(), { target: { value: '12' } })
    await act(async () => { fireEvent.pointerDown(document.body) })
    expect(gateway.executed.map(e => e.command)).toEqual([{ cmd: 'set-auto-checkup', scope: { kind: 'all' }, frequency: 12 }])
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('Esc 放弃改了一半的天数', () => {
    const { gateway } = setup()
    fireEvent.change(daysInput(), { target: { value: '12' } })
    fireEvent.keyDown(daysInput(), { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(gateway.executed).toEqual([])
  })

  it('选中每 1 天按每天发', async () => {
    const { gateway } = setup()
    fireEvent.change(daysInput(), { target: { value: '1' } })
    await act(async () => { fireEvent.keyDown(daysInput(), { key: 'Enter' }) })
    expect(gateway.executed.map(e => e.command)).toEqual([{ cmd: 'set-auto-checkup', scope: { kind: 'all' }, frequency: 1 }])
  })
})

describe('自动体检菜单：键盘与读屏', () => {
  it('打开时焦点落在选中项；上下键在各项间移动（含输入框和「改回跟随」，首尾循环）；Esc 关闭并把焦点还给按钮', () => {
    open({ kind: 'all' }, { views: { checkups: checkups({ all: 1, own: { '/w/app': 3 } }) } })
    fireEvent.click(autoButton())
    expect(option('每天')).toHaveFocus()
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
    expect(daysInput()).toHaveFocus()
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
    expect(within(menu()).getByRole('menuitem', { name: 'app 改回跟随' })).toHaveFocus()
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
    expect(option('仅手动')).toHaveFocus()
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' })
    expect(within(menu()).getByRole('menuitem', { name: 'app 改回跟随' })).toHaveFocus()
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(autoButton()).toHaveFocus()
    expect(autoButton()).toHaveAttribute('aria-expanded', 'false')
  })

  it('选中的是每 N 天时焦点落在输入框；项目菜单第一项是「跟随全部」', () => {
    open(APP, { views: { checkups: checkups({ all: 1, own: { '/w/app': 14 } }) } })
    fireEvent.click(autoButton())
    expect(daysInput()).toHaveFocus()
    expect(daysInput()).toHaveValue('14')
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' })
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' })
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' })
    expect(option('跟随全部（每天）')).toHaveFocus()
  })

  it('每 N 天选中时，焦点在输入框上也念得出「已选中」；没选中时不念', () => {
    open(APP, { views: { checkups: checkups({ own: { '/w/app': 14 } }) } })
    fireEvent.click(autoButton())
    expect(daysInput()).toHaveFocus()
    expect(daysInput()).toHaveAccessibleName('天数，已选中')
    fireEvent.keyDown(menu(), { key: 'Escape' })
    pick('全局')
    fireEvent.click(autoButton())
    expect(daysInput()).toHaveAccessibleName('天数')
  })

  it('回车选中一档后关闭菜单、焦点还给按钮；点菜单外也关闭', async () => {
    const { gateway } = open()
    fireEvent.click(autoButton())
    expect(autoButton()).toHaveAttribute('aria-expanded', 'true')
    expect(autoButton()).toHaveAttribute('aria-haspopup', 'menu')
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
    await act(async () => { fireEvent.keyDown(document.activeElement!, { key: 'Enter' }) })
    expect(gateway.executed.map(e => e.command)).toEqual([{ cmd: 'set-auto-checkup', scope: { kind: 'all' }, frequency: 1 }])
    expect(screen.queryByRole('menu')).toBeNull()
    expect(autoButton()).toHaveFocus()
    fireEvent.click(autoButton())
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('menu')).toBeNull()
  })
})

describe('体检在配置文件里关闭', () => {
  it('标题行只写「体检已在配置文件里关闭」，没有两个控件', () => {
    open(APP, { views: { checkups: checkups({ governanceEnabled: false }), health: health(false) } })
    expect(head()).toHaveTextContent('体检已在配置文件里关闭')
    expect(within(head()).queryByRole('button')).toBeNull()
  })

  it('体检视图还没读到时按健康视图判断', () => {
    open({ kind: 'all' }, { views: { checkups: { status: 'loading' }, health: health(false) } })
    expect(head()).toHaveTextContent('体检已在配置文件里关闭')
  })
})

describe('英文界面', () => {
  const openEn = (scope: GuiLayerRef | { kind: 'all' }) => {
    const nav = createNavStore()
    openMemoryPage({ layout: { selectPanel: vi.fn() } }, nav, { view: 'todo', scope })
    const gateway = createFakeGateway({ currentWorkspace: '/w/app', views: { ...views, checkups: checkups({ all: 7, own: { global: 1 } }) } })
    render(<PanelShell gateway={gateway} t={createTranslator(en)}><MemoryPage nav={nav} /></PanelShell>)
  }

  it('项目：按钮和菜单项用 spec 的译名', () => {
    openEn(APP)
    expect(within(head()).getByRole('button', { name: /^Check now/ })).toBeInTheDocument()
    const auto = within(head()).getByRole('button', { name: 'Auto checkup for app: Every 7 days, following All' })
    expect(auto).toHaveTextContent('Auto checkupEvery 7 days')
    fireEvent.click(auto)
    const items = within(screen.getByRole('menu')).getAllByRole('menuitemradio').map(el => el.getAttribute('aria-label'))
    expect(items).toEqual(['Follow All (Every 7 days)', 'Manual only', 'Daily', 'Every 7 days'])
  })

  it('还没有记忆的范围：提示用英文', () => {
    openEn({ kind: 'workspace', workspacePath: '/w/new' })
    fireEvent.click(within(head()).getByRole('button', { name: /^Check now/ }))
    expect(screen.getByRole('dialog')).toHaveTextContent('This project has no memories yet, so there is nothing to check.')
  })

  it('「全部」：单独设置列表和「改回跟随」', () => {
    openEn({ kind: 'all' })
    fireEvent.click(within(head()).getByRole('button', { name: /Auto checkup for all memories/ }))
    expect(screen.getByRole('menu')).toHaveTextContent('Set separately')
    expect(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Global: back to following' })).toHaveTextContent('Back to following')
  })
})
