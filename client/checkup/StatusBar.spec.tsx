import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import {
  GUI_VIEW_VERSION, pendingItemKey,
  type AutoCheckupFrequency, type CheckupResult, type CheckupView, type GuiLayerRef, type HealthView, type LibraryView, type MemoryCommandResult, type PendingView,
} from '../../src/gui/contract.ts'
import { createFakeGateway, type FakeGatewayInit } from '../gateway.fake.ts'
import { createTranslator } from '../i18n.tsx'
import { en } from '../locales.ts'
import { MemoryPage } from '../MemoryPage.tsx'
import { createNavStore, openMemoryPage, type NavTarget } from '../nav.ts'
import { levelCountsOf, memory, NOW, renderInShell } from '../test-utils.tsx'
import { PanelShell } from '../ui/PanelShell.tsx'
import { FLASH_MS } from '../library/shared.tsx'

const GLOBAL: GuiLayerRef = { kind: 'global' }
const APP: GuiLayerRef = { kind: 'workspace', workspacePath: '/w/app' }
const BLOG: GuiLayerRef = { kind: 'workspace', workspacePath: '/w/blog' }
const DAY = 86_400_000
const HOUR = 3_600_000

const g1 = memory({ id: 'g1', name: 'g1', scope: 'global', workspacePath: undefined })
const g2 = memory({ id: 'g2', name: 'g2', scope: 'global', workspacePath: undefined })
const a1 = memory({ id: 'a1', name: 'a1' })
const a2 = memory({ id: 'a2', name: 'a2' })
const b1 = memory({ id: 'b1', name: 'b1', workspacePath: '/w/blog' })

/** 夹具：全局和 app 之间一条冲突、两条全局记忆之间一条冲突、app 一条提升候选；建议整理 app 两条。 */
const items: PendingView['items'] = [
  { kind: 'conflict-horizontal', level: 'your-call', decisionId: 'c1', firstSeenAt: 1, summary: '全局和 app 说法相反', left: g1, right: a1 },
  { kind: 'conflict-horizontal', level: 'your-call', decisionId: 'c2', firstSeenAt: 2, summary: '两条全局记忆打架', left: g1, right: g2 },
  { kind: 'promote-candidate', level: 'your-call', decisionId: 'p1', firstSeenAt: 3, memory: a2 },
  { kind: 'advice', level: 'advice', type: 'stale', memories: [a1] },
  { kind: 'advice', level: 'advice', type: 'expired', memories: [a2] },
]
const KEY = {
  c1: pendingItemKey(items[0]!), c2: pendingItemKey(items[1]!), p1: pendingItemKey(items[2]!),
  stale: pendingItemKey(items[3]!), expired: pendingItemKey(items[4]!),
}
const TITLE = { c1: '全局和 app 说法相反', c2: '两条全局记忆打架', p1: '这条适合所有项目', stale: '很久没确认', expired: '已过有效期' }

const pending: PendingView = { version: GUI_VIEW_VERSION, dot: 'amber', typeLabels: {}, items, levelCounts: levelCountsOf(items) }
const library: LibraryView = {
  version: GUI_VIEW_VERSION, memoryRoot: '/h/memories', directoryIssues: [],
  layers: [{ layer: GLOBAL, items: [g1, g2] }, { layer: APP, items: [a1, a2] }, { layer: BLOG, items: [b1] }],
}

type Deductions = HealthView['layers'][number]['deductions']
const NO_DEDUCTIONS: Deductions = { rule: { points: 0, types: [] }, content: { points: 0, types: [] }, freshness: { points: 0, types: [] } }

function healthLayer(layer: GuiLayerRef, total: number, overrides: Partial<HealthView['layers'][number]> = {}): HealthView['layers'][number] {
  return {
    layer, totalMemories: total, score: 90, tier: 'green', gate: { secret: false }, issues: [], staleCount: 0,
    lastCheckupAt: NOW - DAY, overflow: null, ignored: [], deductions: NO_DEDUCTIONS, ...overrides,
  }
}
function health({ governanceEnabled = true, app = {} }: { governanceEnabled?: boolean; app?: Partial<HealthView['layers'][number]> } = {}): HealthView {
  return { version: GUI_VIEW_VERSION, governanceEnabled, layers: [healthLayer(GLOBAL, 2), healthLayer(APP, 2, app), healthLayer(BLOG, 1)] }
}

type ScopeEntry = CheckupView['scopes'][number]
function result(overrides: Partial<CheckupResult> = {}): CheckupResult {
  return { checkupId: 'ck1', by: 'manual', completedAt: NOW - HOUR, added: { keys: [], pending: 0, advice: 0 }, notes: [], ...overrides }
}
/** 体检视图夹具：每个范围默认仅手动、昨天体检过；scopes 按范围键（global 或项目路径）覆盖字段。 */
function checkups({ all = 'manual', scopes = {}, allResult = null, governanceEnabled = true }: {
  all?: AutoCheckupFrequency
  scopes?: Record<string, Partial<ScopeEntry>>
  allResult?: CheckupResult | null
  governanceEnabled?: boolean
} = {}): CheckupView {
  const entry = (layer: GuiLayerRef): ScopeEntry => ({
    scope: layer, frequency: all, isOwn: false, lastCheckupAt: NOW - DAY, nextCheckupAt: null, isDue: false,
    isInProgress: false, failure: null, modelUnavailable: null, lastResult: null,
    ...scopes[layer.kind === 'global' ? 'global' : layer.workspacePath],
  })
  return { version: GUI_VIEW_VERSION, governanceEnabled, defaultFrequency: all, allResult, scopes: [entry(GLOBAL), entry(APP), entry(BLOG)] }
}

const views = { pending, library, health: health(), checkups: checkups() }

/** 打开记忆页：给范围就落在它的处理视图。 */
function open(target: NavTarget | GuiLayerRef = APP, init: FakeGatewayInit = {}) {
  const nav = createNavStore()
  openMemoryPage({ layout: { selectPanel: vi.fn() } }, nav, 'view' in target ? target : { view: 'todo', scope: target })
  const gateway = createFakeGateway({ currentWorkspace: '/w/app', ...init, views: { ...views, ...init.views } })
  renderInShell(<MemoryPage nav={nav} />, gateway)
  return { nav, gateway }
}

const bar = () => screen.getByRole('region', { name: '记忆状况' })
const lines = () => [...bar().querySelectorAll('p')].map(p => p.textContent)
const second = () => bar().querySelector<HTMLElement>('.pm-status-meta')!
const live = () => bar().querySelector<HTMLElement>('[aria-live]')!
const rail = () => within(screen.getByRole('navigation', { name: '范围' }))
const pick = (name: string) => { fireEvent.click(rail().getByRole('button', { name: new RegExp(`^${name}`) })) }
const tab = (name: RegExp) => screen.getByRole('tab', { name })
const panel = () => screen.getByRole('tabpanel')
const rowOf = (title: string) => within(panel()).getByText(title).closest<HTMLElement>('.pm-pending-row')!
const isNew = (title: string) => within(rowOf(title)).queryByText('新') !== null
/** 组里卡片标题的顺序。 */
const groupTitles = (group: string) => {
  const section = within(panel()).getByRole('heading', { level: 2, name: new RegExp(`^${group}`) }).closest('section')!
  return [...section.querySelectorAll('.pm-pending-row')].map(row => row.querySelector('h3')?.textContent)
}

function deferred() {
  let resolve!: (r: MemoryCommandResult) => void
  const promise = new Promise<MemoryCommandResult>((r) => { resolve = r })
  return { promise, resolve }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  localStorage.clear()
})
afterEach(() => {
  delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('状态条第二行', () => {
  it('条数 · 上次体检 · 下次自动体检 · 分数怎么来的', () => {
    open(APP, { views: { checkups: checkups({ all: 7, scopes: { '/w/app': { nextCheckupAt: NOW + 6 * DAY } } }) } })
    expect(second()).toHaveTextContent(/^2 条记忆\s*·\s*上次体检 10 月 16 日\s*·\s*下次自动体检 10 月 23 日 10:00 后\s*·\s*分数怎么来的$/)
  })

  it('仅手动时不写下次；已到期写「自动体检已到期，马上在后台查」', () => {
    const { gateway } = open(APP)
    expect(second()).toHaveTextContent(/^2 条记忆\s*·\s*上次体检 10 月 16 日\s*·\s*分数怎么来的$/)
    act(() => { gateway.setView('checkups', checkups({ all: 1, scopes: { '/w/app': { isDue: true, nextCheckupAt: NOW } } })) })
    expect(second()).toHaveTextContent(/上次体检 10 月 16 日\s*·\s*自动体检已到期，马上在后台查\s*·/)
  })

  it('从没体检过：不写上次体检，也没有「分数怎么来的」', () => {
    open(APP, {
      views: { health: health({ app: { lastCheckupAt: null } }), checkups: checkups({ scopes: { '/w/app': { lastCheckupAt: null } } }) },
    })
    expect(second()).toHaveTextContent(/^2 条记忆$/)
    // 首行没有标记：下面几行不再缩进去对一个不存在的标记
    expect(screen.getByRole('region', { name: '记忆状况' })).toHaveClass('pm-status--plain')
  })

  it('「分数怎么来的」展开三行里只列扣分不为 0 的项，写扣几分和包括哪些问题', () => {
    const deductions: Deductions = {
      rule: { points: 3.5, types: ['expired', 'bloat'] },
      content: { points: 0, types: [] },
      freshness: { points: 2, types: ['stale'] },
    }
    open(APP, { views: { health: health({ app: { deductions, score: 94.5 } }) } })
    const toggle = within(bar()).getByRole('button', { name: /分数怎么来的/ })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    const list = within(bar()).getByRole('list', { name: '分数怎么来的' })
    expect(within(list).getAllByRole('listitem').map(li => li.textContent)).toEqual([
      '规则检查扣 3.5 分：已过有效期、内容过长',
      '新鲜度扣 2 分：很久没确认',
    ])
  })

  it('三项都是 0 写「没有扣分」', () => {
    open(APP)
    fireEvent.click(within(bar()).getByRole('button', { name: /分数怎么来的/ }))
    expect(within(bar()).getByRole('list', { name: '分数怎么来的' })).toHaveTextContent('没有扣分')
  })

  it('有密钥不打分时没有「分数怎么来的」', () => {
    open(APP, { views: { health: health({ app: { score: null, gate: { secret: true } } }) } })
    expect(within(bar()).queryByRole('button', { name: /分数怎么来的/ })).toBeNull()
  })
})

describe('「全部」的状态条', () => {
  it('不打总分；首行写哪些范围要处理，第二行写范围数、总条数、最近一次体检', () => {
    open({ view: 'todo', scope: { kind: 'all' } })
    expect(lines()[0]).toMatch(/^全局有事等你决定\s*·\s*app 有事等你决定$/)
    expect(bar()).not.toHaveTextContent(/\d+ 分/)
    expect(second()).toHaveTextContent(/^2 个项目和全局，共 5 条记忆\s*·\s*上次体检 10 月 16 日$/)
    expect(bar().querySelector('.pm-marker')).toHaveClass('pm-marker--pending')
  })

  it('有密钥的范围写「有密钥要先处理」，标记取红三角；都没有事时写「没有要你决定的事」、绿圆点', () => {
    const secret: PendingView['items'] = [{ kind: 'secret', level: 'must-fix', memory: b1 }, ...items]
    const { gateway } = open({ view: 'todo', scope: { kind: 'all' } }, { views: { pending: { ...pending, items: secret, levelCounts: levelCountsOf(secret) } } })
    expect(lines()[0]).toMatch(/^全局有事等你决定\s*·\s*app 有事等你决定\s*·\s*blog 有密钥要先处理$/)
    expect(bar().querySelector('.pm-marker')).toHaveClass('pm-marker--secret')
    act(() => { gateway.setView('pending', { ...pending, items: [], levelCounts: levelCountsOf([]) }) })
    expect(lines()[0]).toBe('没有要你决定的事')
    expect(bar().querySelector('.pm-marker')).toHaveClass('pm-marker--ok')
  })

  it('第二行的自动体检概况：没有单独设置写「每 7 天自动体检全部记忆」；有单独设置写哪些；全是仅手动且没有单独设置不写', () => {
    const { gateway } = open({ view: 'todo', scope: { kind: 'all' } }, { views: { checkups: checkups({ all: 7 }) } })
    expect(second()).toHaveTextContent(/上次体检 10 月 16 日\s*·\s*每 7 天自动体检全部记忆$/)
    act(() => { gateway.setView('checkups', checkups({ all: 7, scopes: { '/w/app': { isOwn: true, frequency: 1 } } })) })
    expect(second()).toHaveTextContent(/·\s*每 7 天自动体检，app 单独设置$/)
    act(() => { gateway.setView('checkups', checkups({ scopes: { global: { isOwn: true, frequency: 1 }, '/w/app': { isOwn: true, frequency: 3 } } })) })
    expect(second()).toHaveTextContent(/·\s*默认仅手动，全局、app 单独设置$/)
    act(() => { gateway.setView('checkups', checkups()) })
    expect(second()).toHaveTextContent(/^2 个项目和全局，共 5 条记忆\s*·\s*上次体检 10 月 16 日$/)
  })
})

describe('体检在配置文件里关闭', () => {
  it('项目：状态条只写条数，不打分、不写上次和下次体检', () => {
    open(APP, { views: { health: health({ governanceEnabled: false }), checkups: checkups({ governanceEnabled: false, all: 7 }) } })
    expect(lines()).toEqual(['2 条记忆'])
  })

  it('「全部」：只写范围数和总条数', () => {
    open({ view: 'todo', scope: { kind: 'all' } }, { views: { health: health({ governanceEnabled: false }), checkups: checkups({ governanceEnabled: false, all: 7 }) } })
    expect(lines()).toEqual(['2 个项目和全局，共 5 条记忆'])
  })
})

describe('结果行：进行中', () => {
  it('本窗口发起的：写「正在体检 app 的记忆，可以先做别的」；结果行带 aria-live', async () => {
    const run = deferred()
    open(APP, { respond: () => run.promise })
    expect(live()).toHaveAttribute('aria-live', 'polite')
    fireEvent.click(screen.getByRole('button', { name: /立即体检/ }))
    expect(live()).toHaveTextContent('正在体检 app 的记忆，可以先做别的')
    await act(async () => { run.resolve({ ok: true, cmd: 'scan' }) })
    expect(live()).not.toHaveTextContent('正在体检')
  })

  it('自动体检或别的窗口在查（视图里进行中）：同样写；「全部」写正在体检谁；本窗口发起「全部」写全部记忆', () => {
    const { gateway } = open(GLOBAL, { views: { checkups: checkups({ scopes: { global: { isInProgress: true } } }) } })
    expect(live()).toHaveTextContent('正在体检全局记忆，可以先做别的')
    pick('全部')
    expect(live()).toHaveTextContent('正在体检全局记忆，可以先做别的')
    act(() => { gateway.setView('checkups', checkups({ scopes: { '/w/app': { isInProgress: true } } })) })
    expect(live()).toHaveTextContent('正在体检 app 的记忆，可以先做别的')
  })

  it('本窗口发起「全部」：写「正在体检全部记忆」', () => {
    const run = deferred()
    open({ view: 'todo', scope: { kind: 'all' } }, { respond: () => run.promise })
    fireEvent.click(screen.getByRole('button', { name: /立即体检/ }))
    expect(live()).toHaveTextContent('正在体检全部记忆，可以先做别的')
  })
})

describe('结果行：体检完成', () => {
  it('写新增几条等你决定、几条可以整理（链接），用量；说明各占一行', () => {
    const last = result({
      added: { keys: [KEY.p1, KEY.expired], pending: 1, advice: 1 }, usageTokens: 3120,
      notes: [{ code: 'semantic-batched' }, { code: 'baseline-session-scoped' }],
    })
    open(APP, { views: { checkups: checkups({ scopes: { '/w/app': { lastResult: last } } }) } })
    const rows = [...live().querySelectorAll('p')].map(p => p.textContent)
    expect(rows[0]).toMatch(/^体检完成：新增 1 条等你决定 ›\s*·\s*新增 1 条可以整理 ›\s*·\s*本次用了约 3,120 token$/)
    expect(rows.slice(1)).toEqual([
      '记忆较多，分批检查，不同批之间的冲突和重复可能查不出。',
      '这次没有对照本项目的 AGENTS.md 检查冲突：借用的会话不在这个项目里。在本项目的对话里体检可以补上。',
    ])
    expect(within(live()).getByRole('button', { name: '新增 1 条等你决定 ›' })).toBeInTheDocument()
  })

  it('为 0 的段省略，都为 0 写「没有发现新问题」；宿主没报用量不写；自动体检写「自动体检完成」', () => {
    const { gateway } = open(APP, { views: { checkups: checkups({ scopes: { '/w/app': { lastResult: result({ added: { keys: [KEY.expired], pending: 0, advice: 1 } }) } } }) } })
    expect(live()).toHaveTextContent(/^体检完成：新增 1 条可以整理 ›$/)
    act(() => { gateway.setView('checkups', checkups({ scopes: { '/w/app': { lastResult: result({ checkupId: 'ck2', by: 'auto' }) } } })) })
    expect(live()).toHaveTextContent(/^自动体检完成：没有发现新问题$/)
  })

  it('内容检查没做完、模型用不了：说明写原因', () => {
    const last = result({
      notes: [
        { code: 'semantic-failed', cause: { kind: 'model-error', hostCode: 'RATE_LIMIT', message: '429' } },
        { code: 'model-unavailable', cause: { kind: 'model-error', hostCode: 'ACCOUNT_SIGN_IN_REQUIRED' } },
      ],
    })
    open(APP, { views: { checkups: checkups({ scopes: { '/w/app': { lastResult: last } } }) } })
    const rows = [...live().querySelectorAll('p')].map(p => p.textContent)
    expect(rows.slice(1)).toEqual([
      '内容检查没有完成（请求太频繁，被限流了），这次只更新了规则检查。',
      '内容检查没有做：模型现在用不了（账号没登录），这次只更新了规则检查。',
    ])
  })

  it('自动体检的结果写明后台不查和 AGENTS.md 的冲突；手动体检的不写', () => {
    const notes: CheckupResult['notes'] = [{ code: 'baseline-missing' }]
    const { gateway } = open(APP, { views: { checkups: checkups({ scopes: { '/w/app': { lastResult: result({ by: 'auto', notes }) } } }) } })
    expect([...live().querySelectorAll('p')].map(p => p.textContent).slice(1)).toEqual(['自动体检在后台进行，没有对照 AGENTS.md 检查冲突。'])
    act(() => { gateway.setView('checkups', checkups({ scopes: { '/w/app': { lastResult: result({ checkupId: 'ck2', notes }) } } })) })
    expect([...live().querySelectorAll('p')].map(p => p.textContent)).toEqual(['体检完成：没有发现新问题'])
  })

  it('看过这个范围的处理视图后，离开再回来结果行收起；没看过处理视图的不收', () => {
    const last = result({ added: { keys: [KEY.p1], pending: 1, advice: 0 } })
    const { nav } = open({ view: 'library', scope: APP }, { views: { checkups: checkups({ scopes: { '/w/app': { lastResult: last } } }) } })
    expect(live()).toHaveTextContent('体检完成')
    pick('全局')
    pick('app')
    expect(live()).toHaveTextContent('体检完成')
    act(() => { nav.update({ view: 'todo' }) })
    expect(live()).toHaveTextContent('体检完成')
    // 同一个范围里处理 → 记忆查看 → 处理不算离开
    fireEvent.click(tab(/记忆查看/))
    expect(live()).toHaveTextContent('体检完成')
    fireEvent.click(tab(/处理/))
    expect(live()).toHaveTextContent('体检完成')
    pick('全局')
    pick('app')
    expect(live()).toHaveTextContent(/^$/)
    expect(second()).toHaveTextContent('上次体检 10 月 16 日')
  })
})

describe('「新」', () => {
  const last = result({ added: { keys: [KEY.p1, KEY.expired], pending: 1, advice: 1 } })
  const withResult = { views: { checkups: checkups({ scopes: { '/w/app': { lastResult: last } } }) } }

  it('最近一次体检新增的条目带「新」、排在组内最前；同一范围里切视图仍在，换范围再回来就不再标', () => {
    open(APP, withResult)
    expect(groupTitles('等你决定')).toEqual([TITLE.p1, TITLE.c1])
    expect(groupTitles('可以整理')).toEqual([TITLE.expired, TITLE.stale])
    expect(isNew(TITLE.p1)).toBe(true)
    expect(isNew(TITLE.expired)).toBe(true)
    expect(isNew(TITLE.c1)).toBe(false)
    fireEvent.click(tab(/记忆查看/))
    fireEvent.click(tab(/处理/))
    expect(isNew(TITLE.p1)).toBe(true)
    expect(groupTitles('等你决定')).toEqual([TITLE.p1, TITLE.c1])
    pick('全局')
    pick('app')
    expect(isNew(TITLE.p1)).toBe(false)
    expect(groupTitles('等你决定')).toEqual([TITLE.c1, TITLE.p1])
  })

  it('一条新条目在「全部」里也标；在哪里显示过都算', () => {
    open({ view: 'todo', scope: { kind: 'all' } }, withResult)
    expect(isNew(TITLE.p1)).toBe(true)
    pick('app')
    expect(isNew(TITLE.p1)).toBe(false)
  })

  it('浏览器本地存储不可用时照常显示「新」', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied') })
    open(APP, withResult)
    expect(isNew(TITLE.p1)).toBe(true)
    expect(live()).toHaveTextContent('体检完成')
  })

  it('本地记录只留体检视图里还在的那几次体检', () => {
    const { gateway } = open(APP, withResult)
    const stored = () => JSON.parse(localStorage.getItem('dsh-plastic-memory.gui.checkupSeen')!) as { checkups: Array<{ id: string }> }
    expect(stored().checkups.map(c => c.id)).toEqual(['ck1'])
    act(() => { gateway.setView('checkups', checkups({ scopes: { '/w/app': { lastResult: result({ checkupId: 'ck2', added: { keys: [KEY.c1], pending: 1, advice: 0 } }) } } })) })
    expect(stored().checkups.map(c => c.id)).toEqual(['ck2'])
  })
})

describe('结果行的链接', () => {
  const last = result({ added: { keys: [KEY.p1, KEY.expired], pending: 1, advice: 1 } })
  const withResult = { views: { checkups: checkups({ scopes: { '/w/app': { lastResult: last } } }) } }

  it('「新增 N 条等你决定 ›」切到处理视图，第一条带「新」的条目滚到视野中间、闪一次并接住焦点', () => {
    const scroll = vi.fn()
    Element.prototype.scrollIntoView = scroll
    open({ view: 'library', scope: APP }, withResult)
    fireEvent.click(within(live()).getByRole('button', { name: '新增 1 条等你决定 ›' }))
    expect(tab(/处理/)).toHaveAttribute('aria-selected', 'true')
    expect(rowOf(TITLE.p1)).toHaveClass('pm-flash')
    expect(rowOf(TITLE.p1)).toHaveFocus()
    expect(scroll).toHaveBeenCalledWith({ block: 'center' })
  })

  it('「新增 N 条可以整理 ›」跳到可以整理里第一条带「新」的', () => {
    Element.prototype.scrollIntoView = vi.fn()
    open(APP, withResult)
    fireEvent.click(within(live()).getByRole('button', { name: '新增 1 条可以整理 ›' }))
    expect(rowOf(TITLE.expired)).toHaveClass('pm-flash')
  })

  it('系统减弱动态效果时不闪，改成焦点描边', () => {
    Element.prototype.scrollIntoView = vi.fn()
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(prefers-reduced-motion: reduce)' }))
    open(APP, withResult)
    fireEvent.click(within(live()).getByRole('button', { name: '新增 1 条等你决定 ›' }))
    expect(rowOf(TITLE.p1)).not.toHaveClass('pm-flash')
    expect(rowOf(TITLE.p1)).toHaveClass('pm-flash-ring')
    expect(rowOf(TITLE.p1)).toHaveFocus()
  })

  it('减弱动态效果时描边跟着焦点走：闪烁时长过了仍在，焦点离开才去掉', () => {
    vi.useRealTimers()
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    vi.setSystemTime(NOW)
    Element.prototype.scrollIntoView = vi.fn()
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(prefers-reduced-motion: reduce)' }))
    open(APP, withResult)
    fireEvent.click(within(live()).getByRole('button', { name: '新增 1 条等你决定 ›' }))
    act(() => { vi.advanceTimersByTime(FLASH_MS + 100) })
    expect(rowOf(TITLE.p1)).toHaveFocus()
    expect(rowOf(TITLE.p1)).toHaveClass('pm-flash-ring')
    act(() => { tab(/^处理/).focus() })
    expect(rowOf(TITLE.p1)).not.toHaveClass('pm-flash-ring')
  })

  it('项目体检顺带发现的全局新增另写「全局新增 N 条 ›」，点了切到全局并看到这条带「新」', () => {
    Element.prototype.scrollIntoView = vi.fn()
    const withGlobal = result({ added: { keys: [], pending: 0, advice: 0 }, globalAdded: { keys: [KEY.c2], pending: 1, advice: 0 } })
    const { nav } = open(APP, { views: { checkups: checkups({ scopes: { '/w/app': { lastResult: withGlobal } } }) } })
    expect(live()).toHaveTextContent(/^体检完成：全局新增 1 条 ›$/)
    expect(within(panel()).queryByText(TITLE.c2)).toBeNull()
    fireEvent.click(within(live()).getByRole('button', { name: '全局新增 1 条 ›' }))
    expect(nav.get().scope).toEqual(GLOBAL)
    expect(isNew(TITLE.c2)).toBe(true)
    expect(rowOf(TITLE.c2)).toHaveClass('pm-flash')
  })
})

describe('结果行：自动体检没做完、模型用不了', () => {
  it('没做完写原因和什么时候再试；连续失败到上限时写「下次 {时间}」', () => {
    const { gateway } = open(APP, {
      views: { checkups: checkups({ all: 7, scopes: { '/w/app': { isDue: true, failure: { count: 1, retryAt: NOW + HOUR, isRetryLimitReached: false, cause: { kind: 'model-error', hostCode: 'RATE_LIMIT', message: '429 Too Many Requests' } } } } }) },
    })
    expect(live()).toHaveTextContent('自动体检没做完：请求太频繁，被限流了。10 月 17 日 11:00 后再试')
    expect(live().querySelector('p')).toHaveAttribute('title', '429 Too Many Requests')
    // 第二行不再说马上在后台查
    expect(second()).not.toHaveTextContent('已到期')
    act(() => {
      gateway.setView('checkups', checkups({ all: 7, scopes: { '/w/app': { isDue: true, failure: { count: 3, retryAt: NOW + 7 * DAY, isRetryLimitReached: true, cause: { kind: 'unparseable' } } } } }))
    })
    expect(live()).toHaveTextContent('自动体检没做完：模型的回复读不出结果。下次 10 月 24 日 10:00')
    // 改成仅手动：不再自动重试，不写什么时候再试
    act(() => {
      gateway.setView('checkups', checkups({ scopes: { '/w/app': { failure: { count: 1, retryAt: NOW + HOUR, isRetryLimitReached: false, cause: { kind: 'unparseable' } } } } }))
    })
    expect(live()).not.toHaveTextContent('自动体检没做完')
  })

  it('默认模型用不了：写「默认模型现在用不了（原因），自动体检先暂停。」；仅手动的范围不写', () => {
    const { gateway } = open(APP, {
      views: { checkups: checkups({ all: 1, scopes: { '/w/app': { isDue: true, modelUnavailable: { kind: 'model-error', hostCode: 'ACCOUNT_SIGN_IN_REQUIRED' } } } }) },
    })
    expect(live()).toHaveTextContent('默认模型现在用不了（账号没登录），自动体检先暂停。')
    act(() => { gateway.setView('checkups', checkups({ all: 1, scopes: { '/w/app': { modelUnavailable: { kind: 'no-default-model' } } } })) })
    expect(live()).toHaveTextContent('默认模型现在用不了（dsh 还没有可用的默认模型），自动体检先暂停。')
    act(() => { gateway.setView('checkups', checkups({ scopes: { '/w/app': { modelUnavailable: { kind: 'no-default-model' } } } })) })
    expect(live()).toHaveTextContent(/^$/)
  })
})

describe('结果行：没有宿主原话', () => {
  it('key 被拒（AUTH）不带原话：正文照常按码写原因，不出悬停提示', () => {
    open(APP, { views: { checkups: checkups({ all: 1, scopes: { '/w/app': { isDue: true, modelUnavailable: { kind: 'model-error', hostCode: 'AUTH' } } } }) } })
    const line = live().querySelector('p')!
    expect(line).toHaveTextContent('默认模型现在用不了')
    expect(line).not.toHaveAttribute('title')
  })
})

describe('结果行：手动体检没做成', () => {
  it('拿不到模型：写原因和「可以在对话里让 agent 体检」；再体检一次就收起', async () => {
    let answer: MemoryCommandResult = { ok: false, cmd: 'scan', code: 'llm-unavailable' }
    open(APP, { respond: () => answer })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /立即体检/ })) })
    expect(live()).toHaveTextContent('这次没能体检：借用的会话拿不到模型。可以在对话里让 agent 体检。')
    answer = { ok: true, cmd: 'scan' }
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /立即体检/ })) })
    expect(live()).not.toHaveTextContent('没能体检')
  })

  it('失败之后这个范围在别处体检成功（视图里出现更晚的上次体检或结果）：失败行收起；更早的完成不算', async () => {
    const { gateway } = open(APP, { respond: () => ({ ok: false, cmd: 'scan', code: 'llm-unavailable' }) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /立即体检/ })) })
    expect(live()).toHaveTextContent('这次没能体检')
    act(() => { gateway.setView('checkups', checkups({ scopes: { '/w/app': { lastCheckupAt: NOW - HOUR } } })) })
    expect(live()).toHaveTextContent('这次没能体检')
    act(() => { gateway.setView('checkups', checkups({ scopes: { '/w/app': { lastCheckupAt: NOW + 1000 } } })) })
    expect(live()).not.toHaveTextContent('这次没能体检')
  })

  it('「全部」失败之后，视图里出现更晚的「全部」结果：失败行收起', async () => {
    const { gateway } = open({ view: 'todo', scope: { kind: 'all' } }, { respond: () => ({ ok: false, cmd: 'scan', code: 'failed', detail: '磁盘满了' }) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /立即体检/ })) })
    expect(live()).toHaveTextContent('体检没有完成：磁盘满了')
    act(() => { gateway.setView('checkups', checkups({ allResult: result({ checkupId: 'ck9', completedAt: NOW + 1000 }) })) })
    expect(live()).not.toHaveTextContent('体检没有完成')
  })

  it('别的错误写宿主原话', async () => {
    open({ view: 'todo', scope: { kind: 'all' } }, { respond: () => ({ ok: false, cmd: 'scan', code: 'failed', detail: '磁盘满了' }) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /立即体检/ })) })
    expect(live()).toHaveTextContent('体检没有完成：磁盘满了')
  })
})

describe('「全部」的结果行', () => {
  it('显示「全部」手动体检的结果；另有没看过的自动体检结果时加一行按范围合计；看过后离开再回来收起', () => {
    const allResult = result({ checkupId: 'ck-all', added: { keys: [KEY.c1, KEY.p1], pending: 2, advice: 0 } })
    const auto = (id: string, pendingN: number, advice: number) => result({ checkupId: id, by: 'auto', added: { keys: [], pending: pendingN, advice } })
    open({ view: 'todo', scope: { kind: 'all' } }, {
      views: { checkups: checkups({ allResult, scopes: { global: { lastResult: auto('ck-g', 1, 0) }, '/w/blog': { lastResult: auto('ck-b', 1, 2) } } }) },
    })
    const rows = () => [...live().querySelectorAll('p')].map(p => p.textContent)
    expect(rows()[0]).toMatch(/^体检完成：新增 2 条等你决定 ›$/)
    expect(rows()[1]).toMatch(/^自动体检新增 2 条等你决定 ›\s*·\s*2 条可以整理 ›$/)
    pick('全局')
    pick('全部')
    expect(rows()).toEqual([])
  })

  it('借用的会话不在某些项目里：「全部」的说明写「有的项目」，不写「本项目」', () => {
    const notes: CheckupResult['notes'] = [{ code: 'baseline-session-scoped' }]
    const { gateway } = open({ view: 'todo', scope: { kind: 'all' } }, { views: { checkups: checkups({ allResult: result({ checkupId: 'ck-all', notes }) }) } })
    expect([...live().querySelectorAll('p')].map(p => p.textContent).slice(1)).toEqual(['这次有的项目没有对照自己的 AGENTS.md 检查冲突：借用的会话不在那些项目里。在各项目的对话里体检可以补上。'])
    act(() => { gateway.setView('checkups', checkups({ scopes: { '/w/app': { lastResult: result({ checkupId: 'ck-app', notes }) } } })) })
    pick('app')
    expect([...live().querySelectorAll('p')].map(p => p.textContent).slice(1)).toEqual(['这次没有对照本项目的 AGENTS.md 检查冲突：借用的会话不在这个项目里。在本项目的对话里体检可以补上。'])
  })

  it('自动体检的结果同样带「新」；在那个范围看过了，「全部」里不再合计', () => {
    const auto = result({ checkupId: 'ck-a', by: 'auto', added: { keys: [KEY.p1], pending: 1, advice: 0 } })
    open(APP, { views: { checkups: checkups({ scopes: { '/w/app': { lastResult: auto } } }) } })
    expect(live()).toHaveTextContent('自动体检完成：新增 1 条等你决定 ›')
    expect(isNew(TITLE.p1)).toBe(true)
    pick('全部')
    expect(live()).toHaveTextContent(/^$/)
  })
})

describe('英文界面', () => {
  it('第二行、结果行和「新」用英文', () => {
    const nav = createNavStore()
    openMemoryPage({ layout: { selectPanel: vi.fn() } }, nav, { view: 'todo', scope: APP })
    const last = result({ added: { keys: [KEY.p1], pending: 1, advice: 0 }, globalAdded: { keys: [KEY.c2], pending: 1, advice: 0 }, usageTokens: 900 })
    const gateway = createFakeGateway({
      currentWorkspace: '/w/app',
      views: { ...views, checkups: checkups({ all: 7, scopes: { '/w/app': { nextCheckupAt: NOW + 6 * DAY, lastResult: last } } }) },
    })
    render(<PanelShell gateway={gateway} t={createTranslator(en)}><MemoryPage nav={nav} /></PanelShell>)
    const status = screen.getByRole('region', { name: 'Memory status' })
    expect(status.querySelector('.pm-status-meta')).toHaveTextContent(/^2 memories\s*·\s*Last checkup Oct 16\s*·\s*Next auto checkup after Oct 23, 10:00\s*·\s*How the score is made$/)
    expect(status.querySelector('[aria-live]')).toHaveTextContent(/^Checkup finished: 1 new waiting on you ›\s*·\s*1 new in global ›\s*·\s*Used about 900 tokens this time$/)
    expect(within(rowOf('This fits every project')).getByText('New')).toBeInTheDocument()
  })
})
