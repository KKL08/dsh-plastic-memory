// 记忆查看里的记忆详情：行尾「详情」打开，历史版本区、一层关联图；对假网关断言画出什么、发了哪些命令。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import {
  GUI_VIEW_VERSION, type HistoryEntry, type LibraryView, type LinkEdge, type MemoryCommand, type MemoryCommandResult, type MemoryDetail, type PendingView,
  type VersionDetail,
} from '../../src/gui/contract.ts'
import type { BorrowedSession } from '../gateway.ts'
import { createFakeGateway } from '../gateway.fake.ts'
import { createTranslator } from '../i18n.tsx'
import { en, zh } from '../locales.ts'
import { ALL_SCOPE, createNavStore, type NavStore, type PageScope } from '../nav.ts'
import { PanelShell } from '../ui/PanelShell.tsx'
import { levelCountsOf, memory, NOW, renderInShell } from '../test-utils.tsx'
import { LibraryTab } from './LibraryTab.tsx'
import { relationGraphCss } from './RelationGraph.tsx'

const app = { kind: 'workspace', workspacePath: '/w/app' } as const
const session: BorrowedSession = { kind: 'ready', sessionId: 's1', cwd: '/w/app' }
const DAY = 24 * 60 * 60 * 1000

const deploy = memory({ id: 'a1', name: '部署方式', content: '部署走 release 分支', digest: 'd1' })

function library(): LibraryView {
  return { version: GUI_VIEW_VERSION, memoryRoot: '/m', layers: [{ layer: app, items: [deploy, memory({ id: 'a2', content: '提交前跑 typecheck', digest: 'd2' })] }], directoryIssues: [] }
}

const version = (patch: Partial<HistoryEntry> = {}): HistoryEntry => ({
  versionId: '20261010T000000000Z', startedAt: NOW - 20 * DAY, endedAt: NOW - 7 * DAY, reason: '从 main 分支改成 release 分支', ...patch,
})

function detail(patch: Partial<MemoryDetail> = {}): MemoryDetail {
  return {
    memory: deploy, status: 'active',
    history: { versions: [version()], isComplete: true },
    links: { edges: [], isComplete: true },
    ...patch,
  }
}

type Respond = (command: MemoryCommand) => MemoryCommandResult | Promise<MemoryCommandResult>

function setup(respond: Respond, nav: NavStore = createNavStore({ view: 'library', scope: app }), pending?: PendingView | { status: 'loading' | 'missing' | 'outdated' } | { status: 'error'; message: string }, scope: PageScope = app) {
  const gateway = createFakeGateway({ session, views: { library: library(), ...(pending === undefined ? {} : { pending }) }, respond })
  return { nav, ...renderInShell(<LibraryTab nav={nav} scope={scope} session={session} now={NOW} />, gateway) }
}

/** 空的待处理视图：读到了、没有矛盾。 */
const noPending = (): PendingView => ({ version: GUI_VIEW_VERSION, dot: 'none', typeLabels: {}, items: [], levelCounts: levelCountsOf([]) })

const okDetail = (d: MemoryDetail): Respond => command =>
  command.cmd === 'memory-detail' ? { ok: true, cmd: command.cmd, detail: d } : { ok: true, cmd: command.cmd }

async function openDetail(text = '部署走 release 分支') {
  const row = screen.getByText(text).closest('li')!
  await act(async () => { fireEvent.click(within(row).getByRole('button', { name: '详情' })) })
}

const history = () => screen.getByRole('region', { name: '历史版本' })

describe('打开详情', () => {
  it('点「详情」：按这一条的作用域发 memory-detail，列表原位换成详情（名称、卡片）；「返回列表」回到列表，来的那一行高亮', async () => {
    const { gateway } = setup(okDetail(detail()))
    await openDetail()
    expect(gateway.executed.map(e => e.command)).toEqual([{ cmd: 'memory-detail', memoryId: 'a1', layer: app }])
    expect(screen.getByRole('heading', { name: '部署方式' })).toBeInTheDocument()
    expect(screen.queryByText('提交前跑 typecheck')).toBeNull()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '返回列表' })) })
    expect(screen.getByText('提交前跑 typecheck')).toBeInTheDocument()
    expect(screen.getByText('部署走 release 分支').closest('li')).toHaveClass('pm-flash')
  })

  it('读取中写「正在读取」；这一条已经不在（not-found）：如实说已经不在了', async () => {
    let answer!: (r: MemoryCommandResult) => void
    setup(() => new Promise((resolve) => { answer = resolve }))
    await openDetail()
    expect(screen.getByRole('status')).toHaveTextContent('正在读取…')
    await act(async () => { answer({ ok: false, cmd: 'memory-detail', code: 'not-found' }) })
    expect(screen.getByRole('status')).toHaveTextContent('这条记忆已经不在了。')
  })

  it('这一条读不出（作用域没读全，failed）：说读不出来，不说已经不在', async () => {
    setup(command => ({ ok: false, cmd: command.cmd, code: 'failed', detail: '这个作用域有读不出的文件或目录' }))
    await openDetail()
    expect(screen.getByRole('status')).toHaveTextContent('没有读出来：这个作用域有读不出的文件或目录')
    expect(screen.getByRole('status')).not.toHaveTextContent('已经不在')
  })

  it('被取代的记忆：名称旁标「已被取代」', async () => {
    setup(okDetail(detail({ status: 'superseded' })))
    await openDetail()
    expect(screen.getByRole('heading', { name: '部署方式' }).parentElement).toHaveTextContent('已被取代')
  })

  it('修改面板里有没保存的输入时点「详情」：先原位问，确认放弃才打开', async () => {
    const { gateway } = setup(okDetail(detail()))
    const row = screen.getByText('提交前跑 typecheck').closest('li')!
    await act(async () => { fireEvent.click(within(row).getByRole('button', { name: '修改' })) })
    fireEvent.change(within(row).getByRole('textbox'), { target: { value: '写了一半' } })
    await openDetail()
    expect(gateway.executed).toEqual([])
    const ask = within(screen.getByText('部署走 release 分支').closest('li')!).getByRole('group', { name: '放弃刚写的内容？' })
    await act(async () => { fireEvent.click(within(ask).getByRole('button', { name: '放弃' })) })
    expect(gateway.executed.map(e => e.command.cmd)).toEqual(['memory-detail'])
  })

  it('详情开着时，从别的入口导航到同一范围里的另一条（不带 detail）：关掉详情，回到列表并定位到那一条', async () => {
    const { nav } = setup(okDetail(detail()))
    await openDetail()
    await act(async () => { nav.update({ view: 'library', memoryId: 'a2' }) })
    expect(screen.queryByRole('button', { name: '返回列表' })).toBeNull()
    expect(screen.getByText('提交前跑 typecheck').closest('li')).toHaveClass('pm-flash')
  })

  it('从「全部」打开详情再返回列表：不往导航里写，左栏范围不动；来的那一行照样高亮', async () => {
    const nav = createNavStore({ view: 'library', scope: ALL_SCOPE })
    const { gateway } = setup(okDetail(detail()), nav, undefined, ALL_SCOPE)
    // 「全部」按最近更新分段，早的那段默认收起：让这一条落在展开的那段里
    await act(async () => { gateway.setView('library', { ...library(), layers: [{ layer: app, items: [{ ...deploy, updatedAt: NOW }] }] }) })
    const before = nav.get()
    await openDetail()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '返回列表' })) })
    expect(nav.get()).toBe(before)
    expect(screen.getByText('部署走 release 分支').closest('li')).toHaveClass('pm-flash')
  })

  it('焦点：打开详情落在「返回列表」；返回时落在来的那一行，那一行已经不在列表里就落在搜索框', async () => {
    const { gateway } = setup(okDetail(detail()))
    await openDetail()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '返回列表' }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '返回列表' })) })
    expect(document.activeElement).toBe(screen.getByText('部署走 release 分支').closest('li'))
    await openDetail()
    await act(async () => { gateway.setView('library', { ...library(), layers: [{ layer: app, items: [memory({ id: 'a2', content: '提交前跑 typecheck', digest: 'd2' })] }] }) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '返回列表' })) })
    expect(document.activeElement).toBe(screen.getByRole('searchbox'))
  })

  it('借来的会话换了一个（都就绪）：详情不重新读取，展开着的一版还开着', async () => {
    const read: VersionDetail = { status: 'found', versionId: 'v1', name: '部署方式', summary: '摘要', content: '旧的写法', tags: [] }
    const gateway = createFakeGateway({ session, views: { library: library() }, respond: command => command.cmd === 'read-version' ? { ok: true, cmd: command.cmd, version: read } : okDetail(detail({ history: { versions: [version({ versionId: 'v1' })], isComplete: true } }))(command) })
    const nav = createNavStore({ view: 'library', scope: app })
    const tree = (s: BorrowedSession) => <PanelShell gateway={gateway} t={createTranslator(zh)}><LibraryTab nav={nav} scope={app} session={s} now={NOW} /></PanelShell>
    const { rerender } = renderInShell(<LibraryTab nav={nav} scope={app} session={session} now={NOW} />, gateway)
    rerender(tree(session))
    await openDetail()
    await act(async () => { fireEvent.click(within(history()).getByRole('button', { expanded: false })) })
    const sent = gateway.executed.length
    await act(async () => { rerender(tree({ kind: 'ready', sessionId: 's2', cwd: '/w/app' })) })
    expect(gateway.executed).toHaveLength(sent)
    expect(within(history()).getByText('旧的写法')).toBeInTheDocument()
  })

  it('导航目标带 detail：一挂载就打开那一条的详情', async () => {
    const nav = createNavStore({ view: 'library', scope: app, memoryId: 'a1', detail: true })
    const { gateway } = setup(okDetail(detail()), nav)
    await act(async () => {})
    expect(gateway.executed.map(e => e.command)).toEqual([{ cmd: 'memory-detail', memoryId: 'a1', layer: app }])
    expect(screen.getByRole('heading', { name: '部署方式' })).toBeInTheDocument()
  })
})

describe('历史版本区', () => {
  it('每版一行，新的在前：时段、变化原因、事实时间、出处会话（露前 8 位，悬停看全）；并进来的标「并入自」', async () => {
    const versions = [
      version({ versionId: 'v3', reason: '并进来的那条换了', mergedFrom: { id: 'a9', name: '旧部署记录' } }),
      version({ versionId: 'v2', factTime: '2026-03', sourceSessionId: 'sess-1234567890' }),
      version({ versionId: 'v1', reason: '' }),
    ]
    setup(okDetail(detail({ history: { versions, isComplete: true } })))
    await openDetail()
    const rows = within(history()).getAllByRole('listitem')
    expect(rows.map(r => r.textContent)).toEqual([
      '9 月 27 日 – 10 月 10 日并进来的那条换了并入自「旧部署记录」',
      '9 月 27 日 – 10 月 10 日从 main 分支改成 release 分支事实时间 2026-03出处会话 sess-123…',
      '9 月 27 日 – 10 月 10 日没有记下变化原因',
    ])
    expect(within(rows[1]!).getByText('出处会话 sess-123…')).toHaveAttribute('title', 'sess-1234567890')
    expect(within(history()).queryByText('还没有历史版本。')).toBeNull()
  })

  it('点开一版：发 read-version 读它的内容，按纯文本显示；再点收起', async () => {
    const read: VersionDetail = { status: 'found', versionId: 'v1', name: '部署方式', summary: '摘要', content: '旧的写法 <b>不加粗</b>', tags: [] }
    const { gateway } = setup(command => command.cmd === 'read-version' ? { ok: true, cmd: command.cmd, version: read } : okDetail(detail({ history: { versions: [version({ versionId: 'v1' })], isComplete: true } }))(command))
    await openDetail()
    const toggle = within(history()).getByRole('button', { expanded: false })
    await act(async () => { fireEvent.click(toggle) })
    expect(gateway.executed.at(-1)!.command).toEqual({ cmd: 'read-version', memoryId: 'a1', layer: app, versionId: 'v1' })
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(within(history()).getByText('旧的写法 <b>不加粗</b>')).toBeInTheDocument()
    expect(history().querySelector('b')).toBeNull()
    await act(async () => { fireEvent.click(toggle) })
    expect(within(history()).queryByText('旧的写法 <b>不加粗</b>')).toBeNull()
  })

  it('点开一版读不出、已不在、历史不全时没找到：各说各的，不显示内容', async () => {
    const answers: VersionDetail[] = [{ status: 'unreadable' }, { status: 'missing', isComplete: true }, { status: 'missing', isComplete: false }]
    const versions = [version({ versionId: 'v3' }), version({ versionId: 'v2' }), version({ versionId: 'v1' })]
    setup(command => command.cmd === 'read-version'
      ? { ok: true, cmd: command.cmd, version: answers[['v3', 'v2', 'v1'].indexOf(command.versionId)]! }
      : okDetail(detail({ history: { versions, isComplete: true } }))(command))
    await openDetail()
    for (const toggle of within(history()).getAllByRole('button')) await act(async () => { fireEvent.click(toggle) })
    const rows = within(history()).getAllByRole('listitem')
    expect(rows[0]).toHaveTextContent('这一版读不出来。')
    expect(rows[1]).toHaveTextContent('这一版已经不在了，可能已被清理或撤销。')
    expect(rows[2]).toHaveTextContent('这次没找到这一版；历史还有读不出的部分，不能确定它已经不在。')
  })

  it('点开、收起、再点开一版：只收最后一次读取的结果，前一次晚到的不覆盖', async () => {
    const answers: Array<(r: MemoryCommandResult) => void> = []
    const found = (content: string): MemoryCommandResult => ({ ok: true, cmd: 'read-version', version: { status: 'found', versionId: 'v1', name: '部署方式', summary: '', content, tags: [] } })
    setup(command => command.cmd === 'read-version'
      ? new Promise((resolve) => { answers.push(resolve) })
      : okDetail(detail({ history: { versions: [version({ versionId: 'v1' })], isComplete: true } }))(command))
    await openDetail()
    const toggle = within(history()).getByRole('button')
    await act(async () => { fireEvent.click(toggle) })
    await act(async () => { fireEvent.click(toggle) })
    await act(async () => { fireEvent.click(toggle) })
    expect(answers).toHaveLength(2)
    await act(async () => { answers[1]!(found('后一次读到的')) })
    await act(async () => { answers[0]!(found('前一次读到的')) })
    expect(within(history()).getByText('后一次读到的')).toBeInTheDocument()
    expect(within(history()).queryByText('前一次读到的')).toBeNull()
  })

  it('还没有历史：写「还没有历史版本」', async () => {
    setup(okDetail(detail({ history: { versions: [], isComplete: true } })))
    await openDetail()
    expect(history()).toHaveTextContent('还没有历史版本。')
  })

  it('历史列不全：写「部分历史读不到」，不写「没有历史版本」；读到的照列', async () => {
    const { unmount } = setup(okDetail(detail({ history: { versions: [], isComplete: false } })))
    await openDetail()
    expect(history()).toHaveTextContent('部分历史读不到，这次一版也没有读出来。')
    expect(history()).not.toHaveTextContent('还没有历史版本')
    unmount()
    setup(okDetail(detail({ history: { versions: [version()], isComplete: false } })))
    await openDetail()
    expect(history()).toHaveTextContent('部分历史读不到，下面只列出读到的版本。')
    expect(within(history()).getAllByRole('listitem')).toHaveLength(1)
  })
})

const global = { kind: 'global' } as const
const edge = (kind: LinkEdge['kind'], direction: LinkEdge['direction'], node: LinkEdge['node']): LinkEdge => ({ kind, direction, node })
const graph = () => screen.getByRole('region', { name: '关联' })
const node = (name: string) => within(graph()).getByRole('button', { name })

/** 待处理视图里一组「等你决定」的矛盾：这一条和另一条。 */
function conflictWith(other: ReturnType<typeof memory> | null): PendingView {
  const items: PendingView['items'] = [{ kind: 'conflict-horizontal', level: 'your-call', decisionId: 'c1', firstSeenAt: NOW, summary: '两条说法相反', left: deploy, right: other }]
  return { version: GUI_VIEW_VERSION, dot: 'amber', typeLabels: {}, items, levelCounts: levelCountsOf(items) }
}

/** 节点在图里的横坐标（节点组的 translate）。 */
const xOf = (el: Element) => Number(/translate\(([-\d.]+)/.exec(el.getAttribute('transform') ?? '')![1])
const yOf = (el: Element) => Number(/translate\([-\d.]+ ([-\d.]+)/.exec(el.getAttribute('transform') ?? '')![1])

describe('关联图', () => {
  const edges = [
    edge('premise', 'out', { id: 'b1', scope: app, state: 'active', name: '发布流程' }),
    edge('supersedes', 'out', { id: 'b2', scope: app, state: 'superseded', name: '旧部署方式' }),
    edge('related', 'out', { id: 'b3', scope: global, state: 'active', name: '全局分支约定' }),
    edge('premise', 'in', { id: 'c1', scope: app, state: 'active', name: '上线检查' }),
    edge('supersedes', 'in', { id: 'c2', scope: app, state: 'deleted', name: '删掉的新写法' }),
    edge('related', 'in', { id: 'c3', scope: app, state: 'active', name: '回滚办法' }),
  ]

  it('中间是这一条；依据、取代、相关两个方向各画成一个邻居，标出关系、状态和跨作用域；待你决定的矛盾也画上', async () => {
    setup(okDetail(detail({ links: { edges, isComplete: true } })), undefined, conflictWith(memory({ id: 'd1', name: '部署走 main', digest: 'd9' })))
    await openDetail()
    expect(within(graph()).getByRole('img', { name: '部署方式，这条' })).toBeInTheDocument()
    expect(node('发布流程，依据')).toBeInTheDocument()
    expect(node('旧部署方式，被这条取代，已被取代')).toBeInTheDocument()
    expect(node('全局分支约定，相关，全局')).toBeInTheDocument()
    expect(node('上线检查，依据这条')).toBeInTheDocument()
    expect(within(graph()).getByRole('img', { name: '删掉的新写法，取代了这条，已删除' })).toBeInTheDocument()
    expect(node('回滚办法，关联到这条')).toBeInTheDocument()
    expect(node('部署走 main，矛盾，待你决定')).toBeInTheDocument()
  })

  it('这条指出去的画在左边、指向这条的画在右边；连线带箭头，矛盾是不带箭头的虚线，节点上一个等你决定的圆点', async () => {
    setup(okDetail(detail({ links: { edges, isComplete: true } })), undefined, conflictWith(memory({ id: 'd1', name: '部署走 main', digest: 'd9' })))
    await openDetail()
    const centerX = xOf(within(graph()).getByRole('img', { name: '部署方式，这条' }))
    for (const name of ['发布流程，依据', '旧部署方式，被这条取代，已被取代', '全局分支约定，相关，全局']) expect(xOf(node(name))).toBeLessThan(centerX)
    for (const name of ['上线检查，依据这条', '回滚办法，关联到这条']) expect(xOf(node(name))).toBeGreaterThan(centerX)
    const lines = [...graph().querySelectorAll('.pm-graph-edge')]
    expect(lines).toHaveLength(7)
    const conflictLines = lines.filter(l => l.classList.contains('pm-graph-edge--conflict'))
    expect(conflictLines).toHaveLength(1)
    expect(conflictLines[0]).not.toHaveAttribute('marker-end')
    expect(conflictLines[0]).not.toHaveAttribute('marker-start')
    // 连线都从中间画到邻居：指出去的箭头在邻居那头（marker-end），指向这条的箭头在中间那头（marker-start）
    const arrows = lines.filter(l => !l.classList.contains('pm-graph-edge--conflict')).map(l => [l.hasAttribute('marker-end'), l.hasAttribute('marker-start')])
    expect(arrows.filter(([end, start]) => end && !start)).toHaveLength(3)
    expect(arrows.filter(([end, start]) => !end && start)).toHaveLength(3)
    for (const line of lines.filter(l => !l.classList.contains('pm-graph-edge--conflict'))) expect(line.getAttribute('marker-end') ?? line.getAttribute('marker-start')).toMatch(/^url\(#/)
    expect(node('部署走 main，矛盾，待你决定').querySelector('.pm-graph-dot')).not.toBeNull()
    expect(graph().querySelectorAll('.pm-graph-dot')).toHaveLength(1)
  })

  it('被取代、已删除的画成灰色；读不到的标「读不到」、已不在的标「已不在」，和已删除分开，点不了', async () => {
    const odd = [
      edge('premise', 'out', { id: 'b2', scope: app, state: 'superseded', name: '旧部署方式' }),
      edge('premise', 'in', { id: 'c2', scope: app, state: 'deleted', name: '删掉的新写法' }),
      edge('related', 'out', { id: 'gone1', state: 'missing' }),
      edge('related', 'in', { id: 'bad1', state: 'unreadable' }),
    ]
    setup(okDetail(detail({ links: { edges: odd, isComplete: true } })))
    await openDetail()
    expect(node('旧部署方式，依据，已被取代')).toHaveClass('pm-graph-node--faded')
    const deleted = within(graph()).getByRole('img', { name: '删掉的新写法，依据这条，已删除' })
    expect(deleted).toHaveClass('pm-graph-node--faded')
    const unreadable = within(graph()).getByRole('img', { name: 'bad1，关联到这条，读不到' })
    expect(unreadable).toHaveClass('pm-graph-node--unreadable')
    expect(unreadable).not.toHaveClass('pm-graph-node--faded')
    expect(unreadable).toHaveTextContent('读不到')
    expect(unreadable).not.toHaveTextContent('已删除')
    expect(within(graph()).getByRole('img', { name: 'gone1，相关，已不在' })).toHaveClass('pm-graph-node--unreadable')
    for (const el of [deleted, unreadable]) expect(el).not.toHaveAttribute('tabindex')
  })

  it('点同一作用域的邻居（含被取代的）：以它为中心重画，按它的作用域重新发 memory-detail；键盘回车同样', async () => {
    const neighbour: MemoryDetail = detail({
      memory: memory({ id: 'b1', name: '发布流程', content: '发布按清单走' }),
      links: { edges: [edge('premise', 'in', { id: 'a1', scope: app, state: 'active', name: '部署方式' })], isComplete: true },
    })
    const { gateway } = setup(command => command.cmd === 'memory-detail' && command.memoryId === 'b1'
      ? { ok: true, cmd: command.cmd, detail: neighbour }
      : okDetail(detail({ links: { edges: [edge('premise', 'out', { id: 'b1', scope: app, state: 'active', name: '发布流程' })], isComplete: true } }))(command))
    await openDetail()
    await act(async () => { fireEvent.click(node('发布流程，依据')) })
    expect(gateway.executed.at(-1)!.command).toEqual({ cmd: 'memory-detail', memoryId: 'b1', layer: app })
    expect(screen.getByRole('heading', { name: '发布流程' })).toBeInTheDocument()
    await act(async () => { fireEvent.keyDown(node('部署方式，依据这条'), { key: 'Enter' }) })
    expect(gateway.executed.at(-1)!.command).toEqual({ cmd: 'memory-detail', memoryId: 'a1', layer: app })
    expect(screen.getByRole('heading', { name: '部署方式' })).toBeInTheDocument()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '返回列表' }))
  })

  it('被取代的邻居也能点：点击、回车都以它为中心重画', async () => {
    const old = (id: string, name: string) => detail({ memory: memory({ id, name, content: `${name}的正文` }), status: 'superseded', links: { edges: [edge('supersedes', 'in', { id: 'a1', scope: app, state: 'active', name: '部署方式' })], isComplete: true } })
    const { gateway } = setup(command => command.cmd === 'memory-detail' && command.memoryId !== 'a1'
      ? { ok: true, cmd: command.cmd, detail: old(command.memoryId, command.memoryId === 'b2' ? '旧部署方式' : '更旧的部署方式') }
      : okDetail(detail({ links: { edges: [
        edge('supersedes', 'out', { id: 'b2', scope: app, state: 'superseded', name: '旧部署方式' }),
        edge('supersedes', 'out', { id: 'b4', scope: app, state: 'superseded', name: '更旧的部署方式' }),
      ], isComplete: true } }))(command))
    await openDetail()
    await act(async () => { fireEvent.click(node('旧部署方式，被这条取代，已被取代')) })
    expect(gateway.executed.at(-1)!.command).toEqual({ cmd: 'memory-detail', memoryId: 'b2', layer: app })
    expect(screen.getByRole('heading', { name: '旧部署方式' })).toBeInTheDocument()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '返回列表' })) })
    await openDetail()
    await act(async () => { fireEvent.keyDown(node('更旧的部署方式，被这条取代，已被取代'), { key: 'Enter' }) })
    expect(gateway.executed.at(-1)!.command).toEqual({ cmd: 'memory-detail', memoryId: 'b4', layer: app })
    expect(screen.getByRole('heading', { name: '更旧的部署方式' })).toBeInTheDocument()
  })

  it('同一条记忆和中间有几种关系：只画一个节点，写出全部关系；有指出去的就放左边', async () => {
    setup(okDetail(detail({ links: { edges: [
      edge('premise', 'out', { id: 'b1', scope: app, state: 'active', name: '发布流程' }),
      edge('related', 'in', { id: 'b1', scope: app, state: 'active', name: '发布流程' }),
      edge('related', 'in', { id: 'c3', scope: app, state: 'active', name: '回滚办法' }),
    ], isComplete: true } })))
    await openDetail()
    expect(within(graph()).getAllByRole('button').map(b => b.getAttribute('aria-label'))).toEqual(['发布流程，依据，关联到这条', '回滚办法，关联到这条'])
    const centerX = xOf(within(graph()).getByRole('img', { name: '部署方式，这条' }))
    expect(xOf(node('发布流程，依据，关联到这条'))).toBeLessThan(centerX)
    expect(node('发布流程，依据，关联到这条')).toHaveTextContent('依据 · 关联到这条')
    const lines = [...graph().querySelectorAll('.pm-graph-edge')]
    expect(lines).toHaveLength(2)
    expect(lines.filter(l => l.hasAttribute('marker-end') && l.hasAttribute('marker-start'))).toHaveLength(1)
  })

  it('英文界面：节点的读屏名称按英文的分隔符拼', async () => {
    const gateway = createFakeGateway({ session, views: { library: library() }, respond: okDetail(detail({ links: { edges: [edge('premise', 'out', { id: 'b1', scope: app, state: 'superseded', name: 'Release flow' })], isComplete: true } })) })
    const nav = createNavStore({ view: 'library', scope: app })
    renderInShell(<span />, gateway).unmount()
    const { container } = render(<PanelShell gateway={gateway} t={createTranslator(en)}><LibraryTab nav={nav} scope={app} session={session} now={NOW} /></PanelShell>)
    const row = within(container).getByText('部署走 release 分支').closest('li')!
    await act(async () => { fireEvent.click(within(row).getByRole('button', { name: 'Details' })) })
    expect(within(container).getByRole('button', { name: 'Release flow, Based on, Replaced' })).toBeInTheDocument()
    expect(within(container).getByRole('img', { name: '部署方式, This memory' })).toBeInTheDocument()
  })

  it('可点节点的焦点框只有一层：盖掉全局的 outline，只留节点自己的描边', () => {
    expect(relationGraphCss).toMatch(/\.pm-root \.pm-graph-node:focus-visible\s*\{\s*outline: none;\s*\}/)
    expect(relationGraphCss).toMatch(/\.pm-graph-node--pickable:focus-visible rect\s*\{[^}]*stroke: var\(--pm-focus\)/)
  })

  it('点别的作用域的邻居：左栏范围切到它的作用域，记忆查看直接打开它的详情', async () => {
    const { nav, gateway, unmount } = setup(okDetail(detail({ links: { edges: [edge('related', 'out', { id: 'g1', scope: global, state: 'active', name: '全局分支约定' })], isComplete: true } })))
    await openDetail()
    const sent = gateway.executed.length
    await act(async () => { fireEvent.click(node('全局分支约定，相关，全局')) })
    expect(nav.get()).toMatchObject({ view: 'library', scope: global, memoryId: 'g1', detail: true })
    // 还在原范围的这一页不接别的范围的目标；换到全局范围后新挂载的一页按全局打开它
    expect(gateway.executed).toHaveLength(sent)
    unmount()
    renderInShell(<LibraryTab nav={nav} scope={global} session={session} now={NOW} />, gateway)
    await act(async () => {})
    expect(gateway.executed.at(-1)!.command).toEqual({ cmd: 'memory-detail', memoryId: 'g1', layer: global })
  })

  it('点待你决定的矛盾：去处理视图，定位到这一条', async () => {
    const { nav } = setup(okDetail(detail()), undefined, conflictWith(memory({ id: 'd1', name: '部署走 main', digest: 'd9' })))
    await openDetail()
    await act(async () => { fireEvent.click(node('部署走 main，矛盾，待你决定')) })
    expect(nav.get()).toMatchObject({ view: 'todo', scope: app, memoryId: 'a1' })
    expect(nav.get().detail).toBeUndefined()
  })

  it('别处的矛盾、这条在别的作用域的同 id 副本参与的矛盾都不画', async () => {
    const elsewhere = conflictWith(memory({ id: 'd1', name: '部署走 main', digest: 'd9' }))
    const twin = { ...deploy, scope: 'global' as const, workspacePath: undefined }
    elsewhere.items.push({ kind: 'conflict-horizontal', level: 'your-call', decisionId: 'c2', firstSeenAt: NOW, summary: '别处', left: twin, right: memory({ id: 'e1', name: '不相干', scope: 'global', workspacePath: undefined }) })
    setup(okDetail(detail()), undefined, elsewhere)
    await openDetail()
    expect(within(graph()).getAllByRole('button').map(b => b.getAttribute('aria-label'))).toEqual(['部署走 main，矛盾，待你决定'])
  })

  it('邻居名称按纯文本画，过长截断，悬停提示里是全名', async () => {
    const long = '<b>很长很长的一条记忆名称，超过节点宽度也不撑破图</b>'
    setup(okDetail(detail({ links: { edges: [edge('premise', 'out', { id: 'b1', scope: app, state: 'active', name: long })], isComplete: true } })))
    await openDetail()
    const el = node(`${long}，依据`)
    expect(el.querySelector('b')).toBeNull()
    expect(el.querySelector('title')).toHaveTextContent(long)
    const label = el.querySelector('.pm-graph-name')!.textContent!
    expect(label.endsWith('…')).toBe(true)
    expect(long.startsWith(label.slice(0, -1))).toBe(true)
  })

  describe('窄面板', () => {
    afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })
    it('不够两栏宽时上下排：这一条在上，邻居依次缩进排在下面，不分左右', async () => {
      vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
      vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
        return this.classList.contains('pm-graph') ? 360 : 0
      })
      setup(okDetail(detail({ links: { edges: edges.slice(0, 4), isComplete: true } })))
      await openDetail()
      expect(graph().querySelector('svg')).toHaveAttribute('width', '360')
      const center = within(graph()).getByRole('img', { name: '部署方式，这条' })
      const below = ['发布流程，依据', '旧部署方式，被这条取代，已被取代', '全局分支约定，相关，全局', '上线检查，依据这条'].map(node)
      for (const el of below) expect(xOf(el)).toBeGreaterThan(xOf(center))
      expect(new Set(below.map(xOf)).size).toBe(1)
      expect(below.map(yOf)).toEqual([...below.map(yOf)].sort((a, b) => a - b))
      expect(yOf(below[0]!)).toBeGreaterThan(yOf(center))
    })
  })

  it('关联读得全但一条也没有：写「还没有记下」，不画图；反向查询不全：标「关联可能不全」，读到的照画', async () => {
    const { unmount } = setup(okDetail(detail({ links: { edges: [], isComplete: true } })), undefined, noPending())
    await openDetail()
    expect(graph()).toHaveTextContent('还没有记下和其他记忆的依据、相关或取代。')
    expect(graph().querySelector('svg')).toBeNull()
    unmount()
    const second = setup(okDetail(detail({ links: { edges: [], isComplete: false } })), undefined, noPending())
    await openDetail()
    expect(graph()).toHaveTextContent('关联可能不全：有的记忆读不出来，这次一条也没有列出。')
    expect(graph()).not.toHaveTextContent('还没有记下')
    second.unmount()
    setup(okDetail(detail({ links: { edges: [edge('premise', 'out', { id: 'b1', scope: app, state: 'active', name: '发布流程' })], isComplete: false } })), undefined, noPending())
    await openDetail()
    expect(graph()).toHaveTextContent('关联可能不全：有的记忆读不出来，指向这条的可能没列全。')
    expect(node('发布流程，依据')).toBeInTheDocument()
  })

  it('待处理视图读不出（出错、还没生成、版本不认识）：不说没有关联，标「待你决定的矛盾读不到」；读到的链接照画', async () => {
    const states = [{ status: 'error', message: '坏了' }, { status: 'missing' }, { status: 'outdated' }] as const
    for (const state of states) {
      const { unmount } = setup(okDetail(detail({ links: { edges: [], isComplete: true } })), undefined, state)
      await openDetail()
      expect(graph()).toHaveTextContent('待你决定的矛盾这次读不到，图里没有画。')
      expect(graph()).not.toHaveTextContent('还没有记下')
      unmount()
    }
    setup(okDetail(detail({ links: { edges: [edge('premise', 'out', { id: 'b1', scope: app, state: 'active', name: '发布流程' })], isComplete: false } })), undefined, { status: 'error', message: '坏了' })
    await openDetail()
    expect(graph()).toHaveTextContent('关联可能不全：有的记忆读不出来，指向这条的可能没列全。待你决定的矛盾这次读不到，图里没有画。')
    expect(node('发布流程，依据')).toBeInTheDocument()
  })

  it('待处理视图还在读：先不下「没有关联」的结论', async () => {
    setup(okDetail(detail({ links: { edges: [], isComplete: true } })), undefined, { status: 'loading' })
    await openDetail()
    expect(graph()).toHaveTextContent('正在读取…')
    expect(graph()).not.toHaveTextContent('还没有记下')
  })
})
