// 记忆查看里的记忆详情：行尾「详情」打开，历史版本区；对假网关断言画出什么、发了哪些命令。
import { describe, expect, it } from 'vitest'
import { act, fireEvent, screen, within } from '@testing-library/react'
import {
  GUI_VIEW_VERSION, type HistoryEntry, type LibraryView, type MemoryCommand, type MemoryCommandResult, type MemoryDetail, type VersionDetail,
} from '../../src/gui/contract.ts'
import type { BorrowedSession } from '../gateway.ts'
import { createFakeGateway } from '../gateway.fake.ts'
import { createNavStore, type NavStore } from '../nav.ts'
import { memory, NOW, renderInShell } from '../test-utils.tsx'
import { LibraryTab } from './LibraryTab.tsx'

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

function setup(respond: Respond, nav: NavStore = createNavStore({ view: 'library', scope: app })) {
  const gateway = createFakeGateway({ session, views: { library: library() }, respond })
  return { nav, ...renderInShell(<LibraryTab nav={nav} scope={app} session={session} now={NOW} />, gateway) }
}

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
