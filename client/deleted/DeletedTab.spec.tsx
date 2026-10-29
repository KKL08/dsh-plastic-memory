// 「最近删除」tab：对假网关断言每行的清除时刻、裁决来源、恢复与彻底删除命令、空状态。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { GUI_VIEW_VERSION, type DeletedView, type LibraryView, type PendingView } from '../../src/gui/contract.ts'
import type { BorrowedSession } from '../gateway.ts'
import { createFakeGateway } from '../gateway.fake.ts'
import { createNavStore } from '../nav.ts'
import { memory, NOW, renderInShell, levelCountsOf } from '../test-utils.tsx'
import { DeletedTab } from './DeletedTab.tsx'
import { createTranslator } from '../i18n.tsx'
import { en } from '../locales.ts'
import { PanelShell } from '../ui/PanelShell.tsx'

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

describe('最近删除英文单复数', () => {
  it('还剩 1 天写 1 day，多天写 days；不到一天单独写', () => {
    const view: DeletedView = { version: GUI_VIEW_VERSION, items: [
      { memory: memory({ id: 'e1', content: 'one day left' }), deletedAt: NOW - 13 * DAY, purgeAt: NOW + DAY },
      { memory: memory({ id: 'e2', content: 'many days left' }), deletedAt: NOW - 2 * DAY, purgeAt: NOW + 12 * DAY },
      { memory: memory({ id: 'e3', content: 'hours left' }), deletedAt: NOW - 14 * DAY, purgeAt: NOW + DAY / 2 },
    ] }
    render(<PanelShell gateway={createFakeGateway({ views: { deleted: view } })} t={createTranslator(en)}><DeletedTab nav={createNavStore()} scope={app} session={session} now={NOW} /></PanelShell>)
    expect(within(rowOf('one day left')).getByText('1 day left')).toBeInTheDocument()
    expect(within(rowOf('many days left')).getByText('12 days left')).toBeInTheDocument()
    expect(within(rowOf('hours left')).getByText('Less than a day left')).toBeInTheDocument()
  })
})

describe('最近删除剩余天数', () => {
  it('按天向上取整：刚删除的写「还能恢复 14 天」（和保留 14 天对得上），剩 1.5 天写 2 天，不到 1 天单独写', () => {
    const view: DeletedView = { version: GUI_VIEW_VERSION, items: [
      { memory: memory({ id: 'f1', content: 'just deleted' }), deletedAt: NOW - 60_000, purgeAt: NOW + 14 * DAY - 60_000 },
      { memory: memory({ id: 'f2', content: 'a day and a half' }), deletedAt: NOW - 12.5 * DAY, purgeAt: NOW + 1.5 * DAY },
      { memory: memory({ id: 'f3', content: 'hours' }), deletedAt: NOW - 13.9 * DAY, purgeAt: NOW + 0.1 * DAY },
    ] }
    renderInShell(<DeletedTab nav={createNavStore()} scope={app} session={session} now={NOW} />, createFakeGateway({ views: { deleted: view } }))
    expect(within(rowOf('just deleted')).getByText('还能恢复 14 天')).toBeInTheDocument()
    expect(within(rowOf('a day and a half')).getByText('还能恢复 2 天')).toBeInTheDocument()
    expect(within(rowOf('hours')).getByText('还能恢复不到 1 天')).toBeInTheDocument()
  })
})

describe('最近删除', () => {
  it('只列范围里的；搜索框下一行写保留规则；每行写何时删，行尾依次是「还能恢复 N 天 · 彻底删除… · 恢复」', () => {
    renderInShell(<DeletedTab nav={createNavStore()} scope={app} session={session} now={NOW} />, createFakeGateway({ views: { deleted } }))
    expect(screen.getAllByRole('listitem')).toHaveLength(4)
    expect(screen.queryByText('博客用 Astro')).toBeNull()
    expect(screen.getByRole('searchbox', { name: '搜索已删除的记忆' })).toBeInTheDocument()
    expect(screen.getByText('删除的记忆保留 14 天，期间可以恢复。')).toBeInTheDocument()
    expect(rowOf('用 pnpm 不用 npm').querySelector('.pm-del-meta')).toHaveTextContent(/^已删除·10 月 15 日$/)
    const tail = rowOf('用 pnpm 不用 npm').querySelector('.pm-row-actions')!
    expect(tail).toHaveTextContent(/^还能恢复 12 天彻底删除…恢复$/)
    expect(rowOf('测试用 sqlite').querySelector('.pm-row-actions')).toHaveTextContent(/^还能恢复不到 1 天/)
    expect(within(rowOf('用 pnpm 不用 npm')).queryByText('恢复后这条冲突会回到待处理')).toBeNull()
  })

  it('「全部」按层分段，段标题写层名和条数；搜索按内容筛', () => {
    renderInShell(<DeletedTab nav={createNavStore()} scope={{ kind: 'all' }} session={session} now={NOW} />, createFakeGateway({ views: { deleted } }))
    expect(screen.getAllByRole('heading', { level: 3 }).map(h => h.textContent)).toEqual(['app4', 'blog1'])
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索已删除的记忆' }), { target: { value: 'astro' } })
    expect(screen.getAllByRole('listitem').map(li => li.querySelector('.pm-mc-text')?.textContent)).toEqual(['博客用 Astro'])
    expect(screen.getAllByRole('heading', { level: 3 }).map(h => h.textContent)).toEqual(['blog1'])
  })

  it('裁决删掉的标来源，写出胜方的名字（全部记忆或最近删除里找；次文字色的元信息行，不用 chip），元信息下一行提示恢复后冲突会回到待处理', () => {
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
    expect(screen.getByText('最近没有删除过记忆')).toBeInTheDocument()
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

  describe('彻底删除', () => {
    const confirmText = '现在就彻底删除这条记忆？删除后不能恢复，以前快照里的副本也一起抹掉。'

    it('「彻底删除…」是 ghost 按钮、在「恢复」左边；点了只在行内展开确认，不发命令，两个按钮都暂不可用；取消后什么都不变', () => {
      const gateway = createFakeGateway({ views: { deleted } })
      renderInShell(<DeletedTab nav={createNavStore()} scope={app} session={session} now={NOW} />, gateway)
      const row = rowOf('用 pnpm 不用 npm')
      const buttons = within(row.querySelector('.pm-del-actions') as HTMLElement).getAllByRole('button')
      expect(buttons.map(b => b.textContent)).toEqual(['彻底删除…', '恢复'])
      // 「彻底删除…」是无边框、次文字色的 ghost 按钮，和「恢复」区分开
      expect(buttons[0]).toHaveClass('pm-btn--ghost')
      expect(buttons[1]).not.toHaveClass('pm-btn--ghost')

      fireEvent.click(buttons[0]!)
      expect(within(row).getByText(confirmText)).toBeInTheDocument()
      expect(screen.queryByRole('dialog')).toBeNull()
      expect(gateway.executed).toEqual([])
      expect(within(row).getByRole('button', { name: '恢复' })).toHaveAttribute('aria-disabled', 'true')
      expect(within(row).getByRole('button', { name: '彻底删除…' })).toHaveAttribute('aria-disabled', 'true')
      expect(screen.getAllByText(confirmText)).toHaveLength(1)

      fireEvent.click(within(row).getByRole('button', { name: '取消' }))
      expect(screen.queryByText(confirmText)).toBeNull()
      expect(gateway.executed).toEqual([])
      expect(within(row).getByRole('button', { name: '恢复' })).not.toHaveAttribute('aria-disabled')
      expect(screen.queryByRole('status')).toBeNull()
    })

    it('确认后发 /memory hard-delete（带这一份的层），提示已彻底删除', async () => {
      const gateway = createFakeGateway({ views: { deleted }, respond: command => ({ ok: true, cmd: command.cmd, memoryIds: ['d2'] }) })
      renderInShell(<DeletedTab nav={createNavStore()} scope={app} session={session} now={NOW} />, gateway)
      const row = rowOf('测试用 sqlite')
      fireEvent.click(within(row).getByRole('button', { name: '彻底删除…' }))
      await act(async () => { fireEvent.click(within(row).getByRole('button', { name: '彻底删除' })) })
      expect(gateway.executed).toEqual([{ sessionId: 's1', command: { cmd: 'hard-delete', memoryId: 'd2', layer: app } }])
      expect(screen.queryByText(confirmText)).toBeNull()
      expect(screen.getByRole('status')).toHaveTextContent('已彻底删除。')
      expect(screen.queryByText('去最近删除 ›')).toBeNull()
    })

    it('失败写原因，这一行和「恢复」照旧可用', async () => {
      const gateway = createFakeGateway({ views: { deleted }, respond: command => ({ ok: false, cmd: command.cmd, code: 'not-found', detail: '不存在或已处理：d1' }) })
      renderInShell(<DeletedTab nav={createNavStore()} scope={app} session={session} now={NOW} />, gateway)
      const row = rowOf('用 pnpm 不用 npm')
      fireEvent.click(within(row).getByRole('button', { name: '彻底删除…' }))
      await act(async () => { fireEvent.click(within(row).getByRole('button', { name: '彻底删除' })) })
      expect(screen.getByRole('status')).toHaveTextContent('没有成功：不存在或已处理：d1')
      expect(within(row).getByRole('button', { name: '恢复' })).not.toHaveAttribute('aria-disabled')
      expect(within(row).getByRole('button', { name: '彻底删除…' })).not.toHaveAttribute('aria-disabled')
    })

    it('别的项目里的：服务端拒后在行里确认，「继续处理」带 allowCrossWorkspace 重发', async () => {
      const gateway = createFakeGateway({
        views: { deleted },
        respond: command => 'allowCrossWorkspace' in command && command.allowCrossWorkspace === true
          ? { ok: true, cmd: command.cmd, memoryIds: ['d5'] }
          : { ok: false, cmd: command.cmd, code: 'cross-workspace', rejected: [{ id: 'd5', workspacePath: '/w/blog' }] },
      })
      renderInShell(<DeletedTab nav={createNavStore()} scope={blog} session={session} now={NOW} />, gateway)
      fireEvent.click(screen.getByRole('button', { name: '彻底删除…' }))
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: '彻底删除' })) })
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: '继续处理' })) })
      expect(gateway.executed.map(e => e.command)).toEqual([
        { cmd: 'hard-delete', memoryId: 'd5', layer: blog },
        { cmd: 'hard-delete', memoryId: 'd5', layer: blog, allowCrossWorkspace: true },
      ])
      expect(screen.getByRole('status')).toHaveTextContent('已彻底删除。')
    })
  })

  it('空状态写保留规则和密钥例外，上面不再重复保留规则那行', () => {
    renderInShell(<DeletedTab nav={createNavStore()} scope={{ kind: 'global' }} session={session} now={NOW} />, createFakeGateway({ views: { deleted } }))
    const empty = screen.getByRole('status')
    expect(empty).toHaveClass('pm-empty--daily')
    expect(screen.queryByText('删除的记忆保留 14 天，期间可以恢复。')).toBeNull()
    expect(empty).toHaveTextContent('最近没有删除过记忆')
    expect(empty).toHaveTextContent('保留 14 天')
    expect(empty).toHaveTextContent('含密钥的记忆删除时直接抹掉，不进这里。')
  })

  describe('带 memoryId 打开', () => {
    const scrollIntoView = vi.fn()
    beforeEach(() => { scrollIntoView.mockClear(); Element.prototype.scrollIntoView = scrollIntoView })
    afterEach(() => { delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView })

    it('目标行滚入视野并高亮一次', () => {
      renderInShell(<DeletedTab nav={createNavStore({ view: 'deleted', memoryId: 'd1' })} scope={app} session={session} now={NOW} />, createFakeGateway({ views: { deleted } }))
      expect(rowOf('用 pnpm 不用 npm')).toHaveClass('pm-flash')
      expect(screen.getAllByRole('listitem').filter(li => li.classList.contains('pm-flash'))).toHaveLength(1)
      expect(scrollIntoView).toHaveBeenCalledTimes(1)
    })
  })
})
