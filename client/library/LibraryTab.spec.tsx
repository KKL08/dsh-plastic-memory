// 「全部记忆」tab：对假网关断言渲染出什么、每个动作发出了哪条命令或宿主调用。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, screen, within } from '@testing-library/react'
import { GUI_VIEW_VERSION, type LibraryView, type PendingView } from '../../src/gui/contract.ts'
import type { BorrowedSession } from '../gateway.ts'
import { createFakeGateway } from '../gateway.fake.ts'
import { createNavStore } from '../nav.ts'
import { memory, NOW, renderInShell } from '../test-utils.tsx'
import { LibraryTab } from './LibraryTab.tsx'
import { FLASH_MS } from './shared.tsx'

const app = { kind: 'workspace', workspacePath: '/w/app' } as const
const session: BorrowedSession = { kind: 'ready', sessionId: 's1', cwd: '/w/app' }

function library(patch: Partial<LibraryView> = {}): LibraryView {
  return {
    version: GUI_VIEW_VERSION, memoryRoot: '/m',
    layers: [
      { layer: { kind: 'global' }, items: [memory({ id: 'g1', scope: 'global', workspacePath: undefined, content: '回答用中文', filePath: '/m/global/zh.md' })] },
      { layer: app, items: [memory({ id: 'a1', filePath: '/m/app-1/a1.md' }), memory({ id: 'a2', content: '提交前跑 typecheck', filePath: '/m/app-1/a2.md' })] },
      { layer: { kind: 'workspace', workspacePath: '/w/blog' }, items: [memory({ id: 'b1', workspacePath: '/w/blog', filePath: '/m/blog-1/b1.md' })] },
    ],
    directoryIssues: [],
    ...patch,
  }
}

function rowOf(text: string): HTMLElement {
  return screen.getByText(text).closest('li')!
}

describe('全部记忆', () => {
  it('列出作用域那一层的记忆卡；顶部存储说明写条数、目录、MEMORY.md 是生成的索引、模型怎么读到', () => {
    renderInShell(<LibraryTab nav={createNavStore()} scope={app} session={session} now={NOW} />, createFakeGateway({ views: { library: library() } }))
    expect(screen.getAllByRole('listitem').map(li => li.querySelector('.pm-mc-text')?.textContent))
      .toEqual(['测试里不要 mock 数据库，用 testcontainers 起真实 Postgres。', '提交前跑 typecheck'])
    expect(screen.getByText('2 条记忆，每条一个文件')).toBeInTheDocument()
    expect(screen.getByText('/m/app-1')).toBeInTheDocument()
    expect(screen.getByText(/MEMORY\.md 是插件生成的索引，手改会被覆盖。/)).toHaveTextContent('agent 需要细节时再读文件')
  })

  it('类型写显示名（待处理视图的 typeLabels）；认不出的类型写 id', () => {
    const view = library({ layers: [{ layer: app, items: [memory({ id: 'a1' }), memory({ id: 'a2', type: 'mystery', content: '提交前跑 typecheck' })] }] })
    const pending: PendingView = { version: GUI_VIEW_VERSION, dot: 'none', items: [], typeLabels: { preference: '行为偏好' } }
    renderInShell(<LibraryTab nav={createNavStore()} scope={app} session={session} now={NOW} />, createFakeGateway({ views: { library: view, pending } }))
    expect(screen.getAllByRole('listitem').map(li => li.querySelector('.pm-mc-meta span')?.textContent)).toEqual(['行为偏好', 'mystery'])
  })

  it('待处理视图没有这个类型时，用全部记忆视图自带的 typeLabels', () => {
    const view = library({ layers: [{ layer: app, items: [memory({ id: 'a1', type: 'domain-term' })] }], typeLabels: { 'domain-term': '术语' } })
    const pending: PendingView = { version: GUI_VIEW_VERSION, dot: 'none', items: [], typeLabels: {} }
    renderInShell(<LibraryTab nav={createNavStore()} scope={app} session={session} now={NOW} />, createFakeGateway({ views: { library: view, pending } }))
    expect(screen.getByRole('listitem').querySelector('.pm-mc-meta span')).toHaveTextContent('术语')
  })

  it('目录问题来自视图，灰色一行一条，路径相对存储目录', () => {
    const view = library({
      directoryIssues: [
        { code: 'duplicate-id', path: '/m/app-1/a1-copy.md' },
        { code: 'reserved-keys', path: '/m/app-1/a2.md', keys: ['scope', 'content'] },
      ],
    })
    renderInShell(<LibraryTab nav={createNavStore()} scope={app} session={session} now={NOW} />, createFakeGateway({ views: { library: view } }))
    const issues = screen.getByRole('list', { name: '目录问题' })
    expect(within(issues).getAllByRole('listitem').map(li => li.textContent)).toEqual([
      '同一 id 有多份文件，只用了其中一份：app-1/a1-copy.md',
      '文件里写了插件自己管的字段（scope, content），已忽略：app-1/a2.md',
    ])
  })

  it('打开文件、在访达中显示、打开目录都走宿主 openWorkspacePath；宿主拒绝时提示', async () => {
    const gateway = createFakeGateway({ views: { library: library() } })
    renderInShell(<LibraryTab nav={createNavStore()} scope={app} session={session} now={NOW} />, gateway)
    const row = rowOf('提交前跑 typecheck')
    await act(async () => { fireEvent.click(within(row).getByRole('button', { name: '打开文件' })) })
    await act(async () => { fireEvent.click(within(row).getByRole('button', { name: '在访达中显示' })) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '打开目录' })) })
    expect(gateway.opened).toEqual([{ path: '/m/app-1/a2.md' }, { path: '/m/app-1/a2.md', action: 'reveal' }, { path: '/m/app-1' }])
    expect(gateway.executed).toEqual([])

    const refusing = createFakeGateway({ views: { library: library() }, openOk: false })
    renderInShell(<LibraryTab nav={createNavStore()} scope={{ kind: 'global' }} session={session} now={NOW} />, refusing)
    await act(async () => { fireEvent.click(within(rowOf('回答用中文')).getByRole('button', { name: '打开文件' })) })
    expect(screen.getByRole('status')).toHaveTextContent('没能打开，宿主拒绝了这个路径。')
  })

  it('删除发 /memory forget（软删），提示 14 天内可在最近删除恢复，链接跳到最近删除那一条', async () => {
    const gateway = createFakeGateway({ views: { library: library() } })
    const nav = createNavStore({ tab: 'library' })
    renderInShell(<LibraryTab nav={nav} scope={app} session={session} now={NOW} />, gateway)
    await act(async () => { fireEvent.click(within(rowOf('提交前跑 typecheck')).getByRole('button', { name: '删除' })) })
    expect(gateway.executed).toEqual([{ sessionId: 's1', command: { cmd: 'forget', memoryId: 'a2' } }])
    expect(screen.getByRole('status')).toHaveTextContent('已删除，14 天内可在「最近删除」恢复。')
    fireEvent.click(screen.getByRole('button', { name: '去最近删除 ›' }))
    expect(nav.get()).toEqual({ tab: 'deleted', memoryId: 'a2' })
  })

  it('含密钥的记忆：forget 回 has-secret（什么都没动）后在行里确认、不提示可恢复；取消收起；「彻底删除」发 hard-delete，之后提示不可恢复、不带去最近删除的链接', async () => {
    const gateway = createFakeGateway({
      views: { library: library() },
      respond: command => command.cmd === 'forget'
        ? { ok: false, cmd: command.cmd, code: 'has-secret', detail: '记忆 a2 含密钥，删除后不可恢复，未做任何改动' }
        : { ok: true, cmd: command.cmd, memoryIds: ['a2'] },
    })
    renderInShell(<LibraryTab nav={createNavStore()} scope={app} session={session} now={NOW} />, gateway)
    const row = rowOf('提交前跑 typecheck')
    await act(async () => { fireEvent.click(within(row).getByRole('button', { name: '删除' })) })
    expect(within(row).getByText('这条记忆里有密钥，删除后不进最近删除、不能恢复，以前快照里的副本也会抹掉。')).toBeInTheDocument()
    expect(within(row).getByRole('button', { name: '删除' })).toHaveAttribute('aria-disabled', 'true')
    expect(screen.queryByRole('status')).toBeNull()

    fireEvent.click(within(row).getByRole('button', { name: '取消' }))
    expect(screen.queryByText('这条记忆里有密钥，删除后不进最近删除、不能恢复，以前快照里的副本也会抹掉。')).toBeNull()
    await act(async () => { fireEvent.click(within(row).getByRole('button', { name: '删除' })) })
    await act(async () => { fireEvent.click(within(row).getByRole('button', { name: '彻底删除' })) })
    expect(gateway.executed.map(e => e.command)).toEqual([
      { cmd: 'forget', memoryId: 'a2' },
      { cmd: 'forget', memoryId: 'a2' },
      { cmd: 'hard-delete', memoryId: 'a2' },
    ])
    expect(screen.queryByText('这条记忆里有密钥，删除后不进最近删除、不能恢复，以前快照里的副本也会抹掉。')).toBeNull()
    expect(screen.getByRole('status')).toHaveTextContent('已彻底删除。如果它是真的凭证，记得去换一个新的。')
    expect(screen.queryByText(/14 天/)).toBeNull()
    expect(screen.queryByRole('button', { name: '去最近删除 ›' })).toBeNull()
  })

  it('删别的项目里的记忆：服务端拒（cross-workspace）后在行里确认，「继续处理」才带 allowCrossWorkspace 重发；失败显示原话', async () => {
    const gateway = createFakeGateway({
      views: { library: library() },
      respond: command => 'allowCrossWorkspace' in command && command.allowCrossWorkspace === true
        ? { ok: false, cmd: command.cmd, code: 'not-found', detail: '记忆 b1 不存在' }
        : { ok: false, cmd: command.cmd, code: 'cross-workspace', rejected: [{ id: 'b1', workspacePath: '/w/blog' }] },
    })
    renderInShell(<LibraryTab nav={createNavStore()} scope={{ kind: 'workspace', workspacePath: '/w/blog' }} session={session} now={NOW} />, gateway)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '删除' })) })
    expect(gateway.executed.map(e => e.command)).toEqual([{ cmd: 'forget', memoryId: 'b1' }])
    expect(screen.getByText('这条记忆属于 blog 项目，不是当前项目。确定在这里处理它吗？')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '删除' })).toHaveAttribute('aria-disabled', 'true')
    expect(screen.queryByRole('status')).toBeNull()

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '继续处理' })) })
    expect(gateway.executed.map(e => e.command)).toEqual([
      { cmd: 'forget', memoryId: 'b1' },
      { cmd: 'forget', memoryId: 'b1', allowCrossWorkspace: true },
    ])
    expect(screen.queryByText(/属于 blog 项目/)).toBeNull()
    expect(screen.getByRole('status')).toHaveTextContent('没有成功：记忆 b1 不存在')
  })

  it('空状态：一条记忆都没有是首次空态「还没有记忆」；只是这一层空是日常空态', () => {
    const empty = library({ layers: [{ layer: { kind: 'global' }, items: [] }] })
    const { unmount } = renderInShell(<LibraryTab nav={createNavStore()} scope={{ kind: 'global' }} session={session} now={NOW} />, createFakeGateway({ views: { library: empty } }))
    expect(screen.getByRole('status')).toHaveClass('pm-empty--first')
    expect(screen.getByRole('status')).toHaveTextContent('还没有记忆')
    expect(screen.queryByText(/条记忆，每条一个文件/)).toBeNull()
    unmount()

    renderInShell(<LibraryTab nav={createNavStore()} scope={{ kind: 'workspace', workspacePath: '/w/none' }} session={session} now={NOW} />, createFakeGateway({ views: { library: library() } }))
    expect(screen.getByRole('status')).toHaveClass('pm-empty--daily')
    expect(screen.getByRole('status')).toHaveTextContent('这里还没有记忆')
  })

  it('视图还没生成：一行说明，不画列表', () => {
    renderInShell(<LibraryTab nav={createNavStore()} scope={app} session={session} now={NOW} />, createFakeGateway())
    expect(screen.getByText('还没有生成这份数据。')).toBeInTheDocument()
    expect(screen.queryByRole('list')).toBeNull()
  })

  describe('带 memoryId 打开', () => {
    const scrollIntoView = vi.fn()
    beforeEach(() => { vi.useFakeTimers(); scrollIntoView.mockClear(); Element.prototype.scrollIntoView = scrollIntoView })
    afterEach(() => { vi.useRealTimers(); delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView })

    it('目标行滚入视野并高亮一次；视图刷新不重播，播完收起，入口再导航一次会重播', () => {
      const gateway = createFakeGateway({ views: { library: library() } })
      const nav = createNavStore({ tab: 'library', scope: app, memoryId: 'a2' })
      renderInShell(<LibraryTab nav={nav} scope={app} session={session} now={NOW} />, gateway)
      const row = rowOf('提交前跑 typecheck')
      expect(row).toHaveClass('pm-flash')
      expect(rowOf('测试里不要 mock 数据库，用 testcontainers 起真实 Postgres。')).not.toHaveClass('pm-flash')
      expect(scrollIntoView).toHaveBeenCalledTimes(1)
      expect(scrollIntoView.mock.contexts[0]).toBe(row)

      act(() => { gateway.setView('library', library()) })
      expect(scrollIntoView).toHaveBeenCalledTimes(1)
      act(() => { vi.advanceTimersByTime(FLASH_MS) })
      expect(row).not.toHaveClass('pm-flash')

      act(() => { nav.navigate({ tab: 'library', scope: app, memoryId: 'a2' }) })
      expect(rowOf('提交前跑 typecheck')).toHaveClass('pm-flash')
      expect(scrollIntoView).toHaveBeenCalledTimes(2)
    })

    it('目标行视图晚到时，到了再高亮', () => {
      const gateway = createFakeGateway({ views: { library: { status: 'loading' } } })
      renderInShell(<LibraryTab nav={createNavStore({ tab: 'library', memoryId: 'a1' })} scope={app} session={session} now={NOW} />, gateway)
      expect(scrollIntoView).not.toHaveBeenCalled()
      act(() => { gateway.setView('library', library()) })
      expect(rowOf('测试里不要 mock 数据库，用 testcontainers 起真实 Postgres。')).toHaveClass('pm-flash')
      expect(scrollIntoView).toHaveBeenCalledTimes(1)
    })
  })
})
