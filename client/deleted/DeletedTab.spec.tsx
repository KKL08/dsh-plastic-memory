// 「最近删除」tab：对假网关断言每行的清除时刻、裁决来源、恢复命令与空状态。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { GUI_VIEW_VERSION, type DeletedView, type LibraryView, type PendingView } from '../../src/gui/contract.ts'
import type { BorrowedSession } from '../gateway.ts'
import { createFakeGateway } from '../gateway.fake.ts'
import { createNavStore } from '../nav.ts'
import { memory, NOW, renderInShell, levelCountsOf } from '../test-utils.tsx'
import { DeletedTab } from './DeletedTab.tsx'

const DAY = 24 * 60 * 60 * 1000
const app = { kind: 'workspace', workspacePath: '/w/app' } as const
const blog = { kind: 'workspace', workspacePath: '/w/blog' } as const
const session: BorrowedSession = { kind: 'ready', sessionId: 's1', cwd: '/w/app' }

const plain = { memory: memory({ id: 'd1', name: 'pnpm-only', content: '用 pnpm 不用 npm' }), deletedAt: NOW - 2 * DAY, purgeAt: NOW + 12 * DAY }
const ruledA = {
  memory: memory({ id: 'd2', content: '测试用 sqlite' }), deletedAt: NOW - 13.5 * DAY, purgeAt: NOW + 0.5 * DAY,
  cause: { decisionId: 'pd1', verdict: 'keep-left' as const, counterpartId: 'm9', snapshotId: 'snap1' },
}
const ruledB = { memory: memory({ id: 'd3', content: '缩进用 tab' }), deletedAt: NOW, purgeAt: NOW + 14 * DAY, cause: { decisionId: 'pd2', verdict: 'keep-right' as const, counterpartId: 'd1' } }
const ruledBaseline = { memory: memory({ id: 'd4', content: '分支直接推 main' }), deletedAt: NOW, purgeAt: NOW + 14 * DAY, cause: { decisionId: 'pd3', verdict: 'keep-right' as const, baselineRef: 'AGENTS.md#L12' } }
const otherProject = { memory: memory({ id: 'd5', content: '博客用 Astro', workspacePath: '/w/blog' }), deletedAt: NOW, purgeAt: NOW + 14 * DAY }

const deleted: DeletedView = { version: GUI_VIEW_VERSION, items: [ruledB, ruledBaseline, otherProject, plain, ruledA] }
/** 裁决的胜方 m9 还在全部记忆里。 */
const library: LibraryView = {
  version: GUI_VIEW_VERSION, memoryRoot: '/m', directoryIssues: [],
  layers: [{ layer: app, items: [memory({ id: 'm9', name: 'postgres-in-tests', content: '测试用真实 Postgres' })] }],
}
const pending: PendingView = { version: GUI_VIEW_VERSION, dot: 'none', items: [], levelCounts: levelCountsOf([]), typeLabels: { preference: '行为偏好' } }

function rowOf(text: string): HTMLElement {
  return screen.getByText(text).closest('li')!
}

describe('最近删除', () => {
  it('只列作用域里的；每行写何时删、多久后彻底清除（客户端按当前时间算）', () => {
    renderInShell(<DeletedTab nav={createNavStore()} scope={app} session={session} now={NOW} />, createFakeGateway({ views: { deleted } }))
    expect(screen.getAllByRole('listitem')).toHaveLength(4)
    expect(screen.queryByText('博客用 Astro')).toBeNull()
    expect(rowOf('用 pnpm 不用 npm').querySelector('.pm-del-meta')).toHaveTextContent('已删除·10 月 15 日·12 天后彻底清除')
    expect(rowOf('测试用 sqlite').querySelector('.pm-del-meta')).toHaveTextContent('一天内彻底清除')
    expect(within(rowOf('用 pnpm 不用 npm')).queryByText('恢复后这条冲突会回到待处理')).toBeNull()
  })

  it('裁决删掉的标来源，写出胜方的名字（全部记忆或最近删除里找；次文字色的元信息行，不用 chip），恢复按钮旁提示冲突会回到待处理', () => {
    renderInShell(<DeletedTab nav={createNavStore()} scope={app} session={session} now={NOW} />, createFakeGateway({ views: { deleted, library } }))
    const a = rowOf('测试用 sqlite')
    expect(a.querySelector('.pm-del-meta')).toHaveTextContent(/^以「postgres-in-tests」为准时删除/)
    expect(a.querySelector('.pm-chip')).toBeNull()
    expect(within(a).getByText('恢复后这条冲突会回到待处理')).toHaveClass('pm-del-hint')
    expect(rowOf('缩进用 tab').querySelector('.pm-del-meta')).toHaveTextContent(/^以「pnpm-only」为准时删除·刚刚/)
    expect(rowOf('分支直接推 main').querySelector('.pm-del-meta')).toHaveTextContent(/^以基线为准时删除/)
  })

  it('胜方哪里都找不到时写它的 id；没记对方是谁（旧条目）时按裁决写 A / B', () => {
    const view: DeletedView = {
      version: GUI_VIEW_VERSION,
      items: [
        { ...ruledA, cause: { decisionId: 'pd1', verdict: 'keep-left', counterpartId: 'mem_gone' } },
        { ...ruledB, cause: { decisionId: 'pd2', verdict: 'keep-right' } },
      ],
    }
    renderInShell(<DeletedTab nav={createNavStore()} scope={app} session={session} now={NOW} />, createFakeGateway({ views: { deleted: view, library } }))
    expect(rowOf('测试用 sqlite').querySelector('.pm-del-meta')).toHaveTextContent(/^以「mem_gone」为准时删除/)
    expect(rowOf('缩进用 tab').querySelector('.pm-del-meta')).toHaveTextContent(/^以 B 为准时删除/)
  })

  it('类型写显示名（待处理视图的 typeLabels），不写类型 id', () => {
    renderInShell(<DeletedTab nav={createNavStore()} scope={app} session={session} now={NOW} />, createFakeGateway({ views: { deleted, pending } }))
    expect(rowOf('用 pnpm 不用 npm').querySelector('.pm-mc-meta')).toHaveTextContent(/^行为偏好/)
  })

  it('待处理视图还没到时，类型显示名取最近删除视图自带的 typeLabels', () => {
    const view = { ...deleted, typeLabels: { preference: '行为偏好' } }
    renderInShell(<DeletedTab nav={createNavStore()} scope={app} session={session} now={NOW} />, createFakeGateway({ views: { deleted: view, pending: { status: 'loading' } } }))
    expect(rowOf('用 pnpm 不用 npm').querySelector('.pm-mc-meta')).toHaveTextContent(/^行为偏好/)
  })

  it('恢复发 /memory restore；被裁决删掉的恢复后提示冲突回到待处理', async () => {
    const gateway = createFakeGateway({
      views: { deleted },
      respond: command => ({ ok: true, cmd: command.cmd, memoryIds: ['d2'], decisionId: 'pd1' }),
    })
    renderInShell(<DeletedTab nav={createNavStore()} scope={app} session={session} now={NOW} />, gateway)
    await act(async () => { fireEvent.click(within(rowOf('测试用 sqlite')).getByRole('button', { name: '恢复' })) })
    expect(gateway.executed).toEqual([{ sessionId: 's1', command: { cmd: 'restore', memoryId: 'd2', layer: app } }])
    expect(screen.getByRole('status')).toHaveTextContent('已恢复，这条冲突回到了待处理。')
  })

  it('恢复别的项目里的：服务端拒后在行里确认，「取消」不重发，「继续处理」带 allowCrossWorkspace 重发；普通恢复只说已恢复', async () => {
    const gateway = createFakeGateway({
      views: { deleted },
      respond: command => 'allowCrossWorkspace' in command && command.allowCrossWorkspace === true
        ? { ok: true, cmd: command.cmd, memoryIds: ['d5'] }
        : { ok: false, cmd: command.cmd, code: 'cross-workspace', rejected: [{ id: 'd5', workspacePath: '/w/blog' }] },
    })
    renderInShell(<DeletedTab nav={createNavStore()} scope={{ kind: 'workspace', workspacePath: '/w/blog' }} session={session} now={NOW} />, gateway)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '恢复' })) })
    expect(screen.getByText('这条记忆属于 blog 项目，不是当前项目。确定在这里处理它吗？')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByText(/属于 blog 项目/)).toBeNull()
    expect(gateway.executed.map(e => e.command)).toEqual([{ cmd: 'restore', memoryId: 'd5', layer: blog }])

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '恢复' })) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '继续处理' })) })
    expect(gateway.executed.map(e => e.command)).toEqual([
      { cmd: 'restore', memoryId: 'd5', layer: blog },
      { cmd: 'restore', memoryId: 'd5', layer: blog },
      { cmd: 'restore', memoryId: 'd5', layer: blog, allowCrossWorkspace: true },
    ])
    expect(screen.getByRole('status')).toHaveTextContent('已恢复。')
  })

  it('恢复的是作用域里最后一条：空状态出来后结果提示还在，焦点落在提示上', async () => {
    const gateway = createFakeGateway({
      views: { deleted: { version: GUI_VIEW_VERSION, items: [otherProject] } },
      respond: command => 'allowCrossWorkspace' in command && command.allowCrossWorkspace === true
        ? { ok: true, cmd: command.cmd, memoryIds: ['d5'], decisionId: 'pd9' }
        : { ok: false, cmd: command.cmd, code: 'cross-workspace', rejected: [{ id: 'd5', workspacePath: '/w/blog' }] },
    })
    renderInShell(<DeletedTab nav={createNavStore()} scope={blog} session={session} now={NOW} />, gateway)
    const restore = screen.getByRole('button', { name: '恢复' })
    restore.focus()
    await act(async () => { fireEvent.click(restore) })
    const confirm = screen.getByRole('button', { name: '继续处理' })
    confirm.focus()
    await act(async () => { fireEvent.click(confirm) })
    act(() => { gateway.setView('deleted', { version: GUI_VIEW_VERSION, items: [] }) })
    expect(screen.getByText('最近删除为空')).toBeInTheDocument()
    const notice = screen.getByText('已恢复，这条冲突回到了待处理。')
    await waitFor(() => { expect(notice).toHaveFocus() })
  })

  it('不用确认的恢复：这一行没了焦点落到下一行的「恢复」；恢复的是最后一条时落到提示上', async () => {
    const two: DeletedView = { version: GUI_VIEW_VERSION, items: [plain, ruledA] }
    const gateway = createFakeGateway({ views: { deleted: two } })
    renderInShell(<DeletedTab nav={createNavStore()} scope={app} session={session} now={NOW} />, gateway)
    const restore = within(rowOf('用 pnpm 不用 npm')).getByRole('button', { name: '恢复' })
    restore.focus()
    await act(async () => { fireEvent.click(restore) })
    act(() => { gateway.setView('deleted', { version: GUI_VIEW_VERSION, items: [ruledA] }) })
    const next = within(rowOf('测试用 sqlite')).getByRole('button', { name: '恢复' })
    await waitFor(() => { expect(next).toHaveFocus() })

    await act(async () => { fireEvent.click(next) })
    act(() => { gateway.setView('deleted', { version: GUI_VIEW_VERSION, items: [] }) })
    await waitFor(() => { expect(screen.getByText('已恢复。')).toHaveFocus() })
  })

  it('空状态写保留规则和密钥例外', () => {
    renderInShell(<DeletedTab nav={createNavStore()} scope={{ kind: 'global' }} session={session} now={NOW} />, createFakeGateway({ views: { deleted } }))
    const empty = screen.getByRole('status')
    expect(empty).toHaveClass('pm-empty--daily')
    expect(empty).toHaveTextContent('最近删除为空')
    expect(empty).toHaveTextContent('保留 14 天')
    expect(empty).toHaveTextContent('含密钥的记忆删除时直接抹掉，不进这里。')
  })

  describe('带 memoryId 打开', () => {
    const scrollIntoView = vi.fn()
    beforeEach(() => { scrollIntoView.mockClear(); Element.prototype.scrollIntoView = scrollIntoView })
    afterEach(() => { delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView })

    it('目标行滚入视野并高亮一次', () => {
      renderInShell(<DeletedTab nav={createNavStore({ tab: 'deleted', memoryId: 'd1' })} scope={app} session={session} now={NOW} />, createFakeGateway({ views: { deleted } }))
      expect(rowOf('用 pnpm 不用 npm')).toHaveClass('pm-flash')
      expect(screen.getAllByRole('listitem').filter(li => li.classList.contains('pm-flash'))).toHaveLength(1)
      expect(scrollIntoView).toHaveBeenCalledTimes(1)
    })
  })
})
