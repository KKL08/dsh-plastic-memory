// 健康 tab：按层三段（分数与结论、问题、上次体检时间）、密钥不打分、超限列为问题不扣分、从没体检过、体检关闭、已忽略。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { GUI_VIEW_VERSION, type HealthView, type PendingView } from '../../src/gui/contract.ts'
import { createFakeGateway, type FakeGatewayInit } from '../gateway.fake.ts'
import { createNavStore } from '../nav.ts'
import { memory, NOW, renderInShell, levelCountsOf } from '../test-utils.tsx'
import { HealthTab } from './HealthTab.tsx'
import { createTranslator } from '../i18n.tsx'
import { en } from '../locales.ts'
import { PanelShell } from '../ui/PanelShell.tsx'

const WS = { kind: 'workspace', workspacePath: '/w/app' } as const
const session = { kind: 'ready', sessionId: 's1', cwd: '/w/app' } as const
type Layer = HealthView['layers'][number]

const layer = (overrides: Partial<Layer> = {}): Layer => ({
  layer: WS, totalMemories: 12, score: 86, tier: 'green', gate: { secret: false },
  issues: [], staleCount: 0, semanticCachedAt: new Date(2026, 9, 15).getTime(), overflow: null, ignored: [],
  ...overrides,
})
const health = (layers: Layer[], governanceEnabled = true): HealthView => ({ version: GUI_VIEW_VERSION, governanceEnabled, layers })

function renderTab(view: HealthView, opts: { scope?: typeof WS | { kind: 'global' }; pending?: PendingView; openSettings?: () => void } = {}) {
  const gateway = createFakeGateway({ session, views: { health: view, ...(opts.pending ? { pending: opts.pending } : {}) } })
  const nav = createNavStore(undefined, { openSettings: opts.openSettings ?? (() => {}) })
  return renderInShell(<HealthTab session={session} scope={opts.scope ?? WS} nav={nav} />, gateway)
}

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW) })
afterEach(() => { vi.useRealTimers() })

describe('健康 tab 英文单复数', () => {
  const renderEn = (view: HealthView) => {
    const gateway = createFakeGateway({ session, views: { health: view } })
    return render(<PanelShell gateway={gateway} t={createTranslator(en)}><HealthTab session={session} scope={WS} nav={createNavStore()} /></PanelShell>)
  }

  it('1 条记忆、1 条久未确认用单数，多条用复数', () => {
    const { unmount } = renderEn(health([layer({ totalMemories: 1, staleCount: 1 })]))
    expect(screen.getByText('1 memory')).toBeInTheDocument()
    expect(screen.getByText(/^1 not confirmed in a long time and may be outdated; it is flagged when brought into a chat/)).toBeInTheDocument()
    unmount()
    renderEn(health([layer({ totalMemories: 12, staleCount: 2 })]))
    expect(screen.getByText('12 memories')).toBeInTheDocument()
    expect(screen.getByText(/^2 not confirmed in a long time and may be outdated; they are flagged/)).toBeInTheDocument()
  })
})

describe('健康 tab', () => {
  it('按层三段：结论行写条数、分数与结论词，下一行上次体检时间，下面是问题；看项目时本项目在前、全局在后', () => {
    renderTab(health([
      layer({ issues: [{ type: 'expired', count: 1, level: 'advice' }, { type: 'conflict', count: 2, level: 'your-call' }], staleCount: 3 }),
      layer({ layer: { kind: 'global' }, totalMemories: 4, score: 62, tier: 'amber' }),
    ]))
    const [ws, global] = screen.getAllByRole('region')
    expect(ws).toHaveAccessibleName('本项目')
    expect(ws).toHaveTextContent('本项目·12 条·86 分·良好')
    expect(ws).toHaveTextContent('上次体检：10 月 15 日')
    expect(within(ws!).getAllByRole('listitem').map(li => li.textContent)).toEqual([
      '已过有效期 1 条·去处理 ›', '记忆冲突 2 条·去处理 ›', '很久没确认、可能过时 3 条，带进对话时会标注·去处理 ›',
    ])
    expect(global).toHaveAccessibleName('全局')
    expect(global).toHaveTextContent('全局·4 条·62 分·需要留意')
    expect(global).toHaveTextContent('没有扣分')
    expect(screen.queryByText('内容检查还没做过')).toBeNull()
  })

  it('看全局时只列全局层；本项目不在视图里时写还没有记忆', () => {
    const { unmount } = renderTab(health([layer(), layer({ layer: { kind: 'global' } })]), { scope: { kind: 'global' } })
    expect(screen.getAllByRole('region').map(r => r.getAttribute('aria-label'))).toEqual(['全局'])
    unmount()
    renderTab(health([layer({ layer: { kind: 'global' } })]))
    expect(screen.getByRole('region', { name: '本项目' })).toHaveTextContent('本项目还没有记忆。')
  })

  it('有密钥的层不打分，写原因；超出上限列为问题、不扣分', () => {
    renderTab(health([
      layer({ score: null, tier: 'red', gate: { secret: true }, issues: [{ type: 'secret', count: 1, level: 'must-fix' }] }),
      layer({ layer: { kind: 'global' }, overflow: { mode: 'relax', tier: 2, isDismissed: false } }),
    ]))
    const ws = screen.getByRole('region', { name: '本项目' })
    expect(ws).toHaveTextContent('本项目·12 条·有密钥，先处理它再看分数')
    expect(ws).not.toHaveTextContent('分·')
    expect(ws.querySelector('.pm-marker--secret')).not.toBeNull()
    expect(within(ws).getByRole('listitem')).toHaveTextContent('密钥（厂商格式） 1 条')
    const global = screen.getByRole('region', { name: '全局' })
    expect(global).toHaveTextContent('86 分')
    expect(within(global).getByRole('listitem')).toHaveTextContent('带入的记忆超出上限，已自动放宽 50%（不扣分）')
  })

  it('超限行带「去处理 ›」，落到待处理的待你处理组（超限提醒在那一组）', () => {
    const gateway = createFakeGateway({ session, views: { health: health([layer({ overflow: { mode: 'relax', tier: 1, isDismissed: false } }), layer({ layer: { kind: 'global' } })]) } })
    const nav = createNavStore({ tab: 'health' })
    renderInShell(<HealthTab session={session} scope={WS} nav={nav} />, gateway)
    const ws = screen.getByRole('region', { name: '本项目' })
    expect(within(ws).getByRole('listitem')).toHaveTextContent('带入的记忆超出上限，已自动放宽 25%（不扣分）')
    fireEvent.click(within(ws).getByRole('button', { name: /去处理 ›$/ }))
    expect(nav.get()).toEqual({ tab: 'pending', level: 'your-call' })
  })

  it('本项目自己没有记忆、但带入超限：照实写 0 条和超限这一行（不打分、不写体检时间），能去处理', () => {
    const view: HealthView = {
      ...health([layer({ layer: { kind: 'global' } })]),
      overflowOnlyLayers: [{ layer: WS, overflow: { mode: 'strict', tier: 0, isDismissed: false } }],
    }
    const gateway = createFakeGateway({ session, views: { health: view } })
    const nav = createNavStore({ tab: 'health' })
    renderInShell(<HealthTab session={session} scope={WS} nav={nav} />, gateway)
    const ws = screen.getByRole('region', { name: '本项目' })
    expect(ws).toHaveTextContent('本项目·0 条')
    expect(ws).not.toHaveTextContent(/\d+ 分/)
    expect(ws).not.toHaveTextContent('本项目还没有记忆。')
    expect(ws).not.toHaveTextContent('上次体检')
    expect(ws).not.toHaveTextContent('内容检查还没做过')
    expect(within(ws).getByRole('listitem')).toHaveTextContent('带入的记忆已用到上限的 95%（不扣分）')
    fireEvent.click(within(ws).getByRole('button', { name: /去处理 ›$/ }))
    expect(nav.get()).toEqual({ tab: 'pending', level: 'your-call' })
  })

  it('从没体检过：不显示分数，时间行写内容检查还没做过，下面给空状态（没有按钮）', () => {
    renderTab(health([layer({ semanticCachedAt: null, score: 100 }), layer({ layer: { kind: 'global' }, semanticCachedAt: null })]))
    const ws = screen.getByRole('region', { name: '本项目' })
    expect(ws).toHaveTextContent('本项目·12 条·还没体检过，体检后打分')
    expect(ws).not.toHaveTextContent('100 分')
    expect(ws).toHaveTextContent('内容检查还没做过')
    expect(screen.getByRole('status')).toHaveTextContent('内容检查还没做过')
    expect(screen.getByRole('status')).toHaveTextContent('规则检查的结果')
    expect(within(screen.getByRole('status')).queryByRole('button')).toBeNull()
  })

  it('体检关闭：内容置灰，给「去设置里打开 ›」；密钥与读不出的文件仍提示（只看列出的层）', () => {
    const openSettings = vi.fn()
    const pending: PendingView = {
      version: GUI_VIEW_VERSION, dot: 'red',
      items: [
        { kind: 'secret', level: 'must-fix', memory: memory({ id: 's1', name: 'deploy-token' }) },
        { kind: 'secret', level: 'must-fix', memory: memory({ id: 's2', name: 'other-project', workspacePath: '/w/blog' }) },
        { kind: 'unreadable-file', level: 'must-fix', layer: { kind: 'global' }, filePath: '/m/global/bad.md', relativePath: 'global/bad.md', error: 'yaml-parse' },
      ],
      levelCounts: { 'must-fix': 3, 'your-call': 0, 'advice': 0 },
      typeLabels: {},
    }
    renderTab(health([layer(), layer({ layer: { kind: 'global' } })], false), { pending, openSettings })
    expect(screen.getByRole('status')).toHaveTextContent('体检已关闭')
    fireEvent.click(screen.getByRole('button', { name: '去设置里打开 ›' }))
    expect(openSettings).toHaveBeenCalledTimes(1)
    expect(screen.getByText('有密钥：deploy-token')).toBeInTheDocument()
    expect(screen.getByText('读不出来：global/bad.md')).toBeInTheDocument()
    expect(screen.queryByText('有密钥：other-project')).toBeNull()
    const greyed = screen.getByRole('region', { name: '本项目' }).closest('[aria-disabled="true"]')
    expect(greyed).not.toBeNull()
    expect(greyed).toContainElement(screen.getByRole('region', { name: '全局' }))
  })

  it('视图还没生成：写说明，不渲染层', () => {
    const gateway = createFakeGateway({ session, views: { health: { status: 'missing' } } })
    renderInShell(<HealthTab session={session} scope={WS} nav={createNavStore()} />, gateway)
    expect(screen.getByText('还没有生成这份数据。')).toBeInTheDocument()
    expect(screen.queryByRole('region')).toBeNull()
  })
})

// 层块下面两行入口（PRD 5.4）：待你决定的条数（读不出的文件不算）与其中等了 7 天以上的，可提升为全局的条数；都去待处理。
describe('健康 tab：去待处理的入口', () => {
  const DAY = 24 * 60 * 60 * 1000
  const conflict = (id: string, firstSeenAt: number) => ({
    kind: 'conflict-horizontal', level: 'your-call', decisionId: id, firstSeenAt, summary: 's', left: memory({ id: `${id}l` }), right: memory({ id: `${id}r` }),
  }) as const
  const promote = { kind: 'promote-candidate', level: 'your-call', decisionId: 'p1', firstSeenAt: NOW, memory: memory({ id: 'p' }) } as const
  const unreadable = { kind: 'unreadable-file', level: 'must-fix', layer: WS, filePath: '/m/app/x.md', relativePath: 'app/x.md', error: 'bad' } as const
  const pendingOf = (...items: PendingView['items']): PendingView => ({ version: GUI_VIEW_VERSION, dot: items.length > 0 ? 'amber' : 'none', items, levelCounts: levelCountsOf(items), typeLabels: {} })
  function render(pending: PendingView, governanceEnabled = true) {
    const gateway = createFakeGateway({ session, views: { health: health([layer()], governanceEnabled), pending } })
    const nav = createNavStore({ tab: 'health' })
    return { nav, ...renderInShell(<HealthTab session={session} scope={WS} nav={nav} />, gateway) }
  }

  it('两行入口带数，点了都落到待处理', () => {
    const { nav } = render(pendingOf(conflict('d1', NOW - 10 * DAY), conflict('d2', NOW - DAY), promote, unreadable))
    expect(screen.getByText('待你决定 3 条，其中 1 条超过 7 天')).toBeInTheDocument()
    expect(screen.getByText('可提升为全局 1 条')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /去处理 ›$/ }))
    expect(nav.get()).toEqual({ tab: 'pending' })
    nav.update({ tab: 'health' })
    fireEvent.click(screen.getByRole('button', { name: /去看 ›$/ }))
    expect(nav.get().tab).toBe('pending')
  })

  it('没有超过 7 天的不写后半句；没有提升候选不出第二行', () => {
    render(pendingOf(conflict('d1', NOW - DAY)))
    expect(screen.getByText('待你决定 1 条')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /去看 ›$/ })).toBeNull()
  })

  it('建议整理不算「待你决定」：只有建议时不出入口行，和冲突一起时不计入条数', () => {
    const advice: PendingView['items'][number] = { kind: 'advice', level: 'advice', type: 'expired', memories: [memory({ id: 'e' })] }
    const { unmount } = render(pendingOf(advice))
    expect(screen.queryByRole('button', { name: /去处理 ›$/ })).toBeNull()
    unmount()
    render(pendingOf(conflict('d1', NOW - DAY), advice))
    expect(screen.getByText('待你决定 1 条')).toBeInTheDocument()
  })

  it('只有读不出的文件、体检关闭：都不出入口行', () => {
    const { unmount } = render(pendingOf(unreadable))
    expect(screen.queryByRole('button', { name: /去处理 ›$/ })).toBeNull()
    unmount()
    render(pendingOf(conflict('d1', NOW), promote), false)
    expect(screen.queryByRole('button', { name: /去处理 ›$/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /去看 ›$/ })).toBeNull()
  })
})

// 扣分原因与待处理对齐：扣分原因、超限、很久没确认行尾都有「去处理 ›」，落到待处理里对应的组。
// 扣分原因的组取视图（issues.level，null = 待处理里此刻没有）；超限、很久没确认不在 issues 里，组由客户端按 PENDING_LEVEL_OF_KIND 取。
describe('健康 tab：扣分原因去处理', () => {
  const all: Layer['issues'] = [
    { type: 'secret', count: 1, level: 'must-fix' },
    { type: 'expired', count: 2, level: 'advice' },
    { type: 'bloat', count: 1, level: 'advice' },
    { type: 'orphan', count: 1, level: 'advice' },
    { type: 'malformed', count: 1, level: 'must-fix' },
    { type: 'conflict', count: 3, level: 'your-call' },
    { type: 'redundancy', count: 1, level: 'advice' },
    { type: 'misplaced', count: 1, level: 'advice' },
    { type: 'unclear', count: 1, level: 'advice' },
  ]
  const LINK = ' 去处理 ›'
  function render(view: HealthView) {
    const gateway = createFakeGateway({ session, views: { health: view } })
    const nav = createNavStore({ tab: 'health' })
    renderInShell(<HealthTab session={session} scope={WS} nav={nav} />, gateway)
    return nav
  }
  /** 一层里某个分区标签下的行（标签与列表同在 .pm-health-issues 里）。 */
  const sectionRows = (region: HTMLElement, title: string) =>
    within(within(region).getByRole('heading', { level: 3, name: title }).parentElement!).queryAllByRole('listitem').map(li => li.textContent)

  it('分区标签：「扣分原因」；不扣分的超限、很久没确认另列在「其他提醒」，没有就不出这一段', () => {
    render(health([
      layer({ issues: [{ type: 'expired', count: 2, level: 'advice' }], staleCount: 4, overflow: { mode: 'strict', tier: 0, isDismissed: false } }),
      layer({ layer: { kind: 'global' }, issues: [{ type: 'bloat', count: 1, level: 'advice' }] }),
    ]))
    const ws = screen.getByRole('region', { name: '本项目' })
    expect(within(ws).getAllByRole('heading', { level: 3 }).map(h => h.textContent)).toEqual(['扣分原因', '其他提醒'])
    expect(sectionRows(ws, '扣分原因')).toEqual(['已过有效期 2 条·去处理 ›'])
    expect(sectionRows(ws, '其他提醒')).toEqual([
      '带入的记忆已用到上限的 95%（不扣分）·去处理 ›', '很久没确认、可能过时 4 条，带进对话时会标注·去处理 ›',
    ])
    const global = screen.getByRole('region', { name: '全局' })
    expect(within(global).getAllByRole('heading', { level: 3 }).map(h => h.textContent)).toEqual(['扣分原因'])
  })

  it('没有扣分、只有提醒：扣分原因下写「没有扣分」，提醒照列', () => {
    render(health([layer({ staleCount: 2 })]))
    const ws = screen.getByRole('region', { name: '本项目' })
    expect(within(within(ws).getByRole('heading', { level: 3, name: '扣分原因' }).parentElement!).getByText('没有扣分')).toBeInTheDocument()
    expect(sectionRows(ws, '其他提醒')).toEqual(['很久没确认、可能过时 2 条，带进对话时会标注·去处理 ›'])
  })

  it('每类扣分原因、超限、很久没确认都有「去处理 ›」，名字带上那一行，点了落到对应的组', () => {
    const nav = render(health([layer({ score: null, gate: { secret: true }, issues: all, staleCount: 4, overflow: { mode: 'strict', tier: 0, isDismissed: false } })]))
    const ws = screen.getByRole('region', { name: '本项目' })
    const expected: Array<[string, string]> = [
      ['密钥（厂商格式） 1 条', 'must-fix'],
      ['已过有效期 2 条', 'advice'],
      ['内容过长 1 条', 'advice'],
      ['指向的旧记忆已不在 1 条', 'advice'],
      ['文件读不出来 1 条', 'must-fix'],
      ['记忆冲突 3 条', 'your-call'],
      ['内容重复 1 条', 'advice'],
      ['该放全局却在项目里（或反过来） 1 条', 'advice'],
      ['表述不清 1 条', 'advice'],
      ['带入的记忆已用到上限的 95%（不扣分）', 'your-call'],
      ['很久没确认、可能过时 4 条，带进对话时会标注', 'advice'],
    ]
    expect(within(ws).getAllByRole('button', { name: /去处理 ›$/ })).toHaveLength(expected.length)
    for (const [text, level] of expected) {
      act(() => { nav.update({ tab: 'health' }) })
      fireEvent.click(within(ws).getByRole('button', { name: text + LINK }))
      expect({ text, target: nav.get() }).toEqual({ text, target: { tab: 'pending', level } })
    }
  })

  it('认不出的问题类型：原样显示，照样能去处理', () => {
    const nav = render(health([layer({ issues: [{ type: 'future-kind', count: 1, level: 'advice' }] })]))
    fireEvent.click(screen.getByRole('button', { name: 'future-kind 1 条' + LINK }))
    expect(nav.get()).toEqual({ tab: 'pending', level: 'advice' })
  })

  it('体检关闭：待处理里没有的几类（冲突、语义建议，视图给 null）只写文字不给链接；密钥、读不出的文件、规则类、超限、很久没确认照给', () => {
    const off: Layer['issues'] = all.map(i => ['conflict', 'redundancy', 'misplaced', 'unclear'].includes(i.type) ? { ...i, level: null } : i)
    const nav = render(health([layer({ issues: off, staleCount: 4, overflow: { mode: 'strict', tier: 0, isDismissed: false } })], false))
    const ws = screen.getByRole('region', { name: '本项目' })
    expect(within(ws).getAllByRole('button', { name: /去处理 ›$/ }).map(b => b.getAttribute('aria-labelledby')!.split(' ').map(id => document.getElementById(id)!.textContent).join(' ')))
      .toEqual([
        '密钥（厂商格式） 1 条 去处理 ›', '已过有效期 2 条 去处理 ›', '内容过长 1 条 去处理 ›', '指向的旧记忆已不在 1 条 去处理 ›',
        '文件读不出来 1 条 去处理 ›', '带入的记忆已用到上限的 95%（不扣分） 去处理 ›', '很久没确认、可能过时 4 条，带进对话时会标注 去处理 ›',
      ])
    expect(sectionRows(ws, '扣分原因')).toContain('记忆冲突 3 条')
    expect(sectionRows(ws, '扣分原因')).toContain('内容重复 1 条')
    fireEvent.click(within(ws).getByRole('button', { name: '文件读不出来 1 条' + LINK }))
    expect(nav.get()).toEqual({ tab: 'pending', level: 'must-fix' })
  })

  it('已忽略的超限提醒：照列这一行，不给「去处理 ›」（待处理里已没有它）', () => {
    render(health([layer({ overflow: { mode: 'relax', tier: 1, isDismissed: true } })]))
    const ws = screen.getByRole('region', { name: '本项目' })
    expect(sectionRows(ws, '其他提醒')).toEqual(['带入的记忆超出上限，已自动放宽 25%（不扣分）'])
    expect(within(ws).queryByRole('button', { name: /去处理 ›$/ })).toBeNull()
  })

  it('底部「待你决定 N 条 · 去处理 ›」保留，落到待处理顶部（不定位到组）', () => {
    const conflict = { kind: 'conflict-horizontal', level: 'your-call', decisionId: 'd1', firstSeenAt: NOW, summary: 's', left: memory({ id: 'l' }), right: memory({ id: 'r' }) } as const
    const gateway = createFakeGateway({ session, views: {
      health: health([layer({ issues: [{ type: 'conflict', count: 1, level: 'your-call' }] })]),
      pending: { version: GUI_VIEW_VERSION, dot: 'amber', items: [conflict], levelCounts: levelCountsOf([conflict]), typeLabels: {} },
    } })
    const nav = createNavStore({ tab: 'health' })
    renderInShell(<HealthTab session={session} scope={WS} nav={nav} />, gateway)
    fireEvent.click(screen.getByRole('button', { name: '待你决定 1 条' + LINK }))
    expect(nav.get()).toEqual({ tab: 'pending' })
  })
})

// 用户在待处理里忽略的建议：不扣分，层下写「已忽略 N 条」，展开能看到是哪几条、各自什么问题，并能取消忽略。
describe('健康 tab：已忽略', () => {
  const ignored: Layer['ignored'] = [
    { type: 'bloat', memories: [{ id: 'b1', name: '发版流程', summary: '发版的步骤' }] },
    { type: 'redundancy', memories: [{ id: 'r1', name: '数据库约定', summary: 's' }, { id: 'r2', name: '测试数据库', summary: 's' }] },
  ]
  function render(view: HealthView, respond?: FakeGatewayInit['respond']) {
    const gateway = createFakeGateway({ session, views: { health: view }, ...(respond ? { respond } : {}) })
    renderInShell(<HealthTab session={session} scope={WS} nav={createNavStore()} />, gateway)
    return gateway
  }

  it('收起时只写「已忽略 N 条」；展开逐条列问题类型和记忆名，再点收起', () => {
    render(health([layer({ ignored }), layer({ layer: { kind: 'global' } })]))
    const ws = screen.getByRole('region', { name: '本项目' })
    const toggle = within(ws).getByRole('button', { name: '已忽略 2 条' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(within(ws).queryByRole('button', { name: '取消忽略' })).toBeNull()
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    const list = within(ws).getByRole('list', { name: '已忽略 2 条' })
    expect(within(list).getAllByRole('listitem').map(li => li.textContent)).toEqual([
      '内容过长·发版流程取消忽略', '内容重复·数据库约定·测试数据库取消忽略',
    ])
    fireEvent.click(toggle)
    expect(within(ws).queryByRole('list', { name: '已忽略 2 条' })).toBeNull()
    // 没有忽略的层不出这一行
    expect(within(screen.getByRole('region', { name: '全局' })).queryByRole('button', { name: /已忽略/ })).toBeNull()
  })

  it('「取消忽略」发 unignore-advice（类型 + 这一项的全部记忆 id）', async () => {
    const gateway = render(health([layer({ ignored })]))
    fireEvent.click(screen.getByRole('button', { name: '已忽略 2 条' }))
    const [, redundancy] = within(screen.getByRole('list', { name: '已忽略 2 条' })).getAllByRole('listitem')
    await act(async () => { fireEvent.click(within(redundancy!).getByRole('button', { name: '取消忽略' })) })
    expect(gateway.executed.map(e => e.command)).toEqual([{ cmd: 'unignore-advice', type: 'redundancy', memoryIds: ['r1', 'r2'] }])
  })

  it('取消失败：原话写在那一条下面', async () => {
    render(health([layer({ ignored })]), command => ({ ok: false, cmd: command.cmd, code: 'failed', detail: '写不进去' }))
    fireEvent.click(screen.getByRole('button', { name: '已忽略 2 条' }))
    await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: '取消忽略' })[0]!) })
    expect(screen.getByRole('alert')).toHaveTextContent('写不进去')
  })
})
