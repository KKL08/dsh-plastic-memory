// 「全部记忆」tab：对假网关断言渲染出什么、每个动作发出了哪条命令或宿主调用。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { GUI_VIEW_VERSION, type LibraryView, type PendingView } from '../../src/gui/contract.ts'
import type { BorrowedSession } from '../gateway.ts'
import { createFakeGateway } from '../gateway.fake.ts'
import { createNavStore } from '../nav.ts'
import { memory, NOW, renderInShell, levelCountsOf } from '../test-utils.tsx'
import { LibraryTab } from './LibraryTab.tsx'
import { FLASH_MS } from './shared.tsx'

const app = { kind: 'workspace', workspacePath: '/w/app' } as const
const blog = { kind: 'workspace', workspacePath: '/w/blog' } as const
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

/** 点这一行的「删除」，再点原位确认里的「删除」。 */
async function remove(row: HTMLElement) {
  await act(async () => { fireEvent.click(within(row).getByRole('button', { name: '删除' })) })
  await act(async () => { fireEvent.click(within(within(row).getByRole('group', { name: '删除这条？' })).getByRole('button', { name: '删除' })) })
}

describe('全部记忆', () => {
  it('列出范围里的记忆卡；搜索框下一行存储说明「每条一个文件 · 目录 · 打开目录」，完整路径在 title 里', () => {
    renderInShell(<LibraryTab nav={createNavStore()} scope={app} session={session} now={NOW} />, createFakeGateway({ views: { library: library() } }))
    expect(screen.getAllByRole('listitem').map(li => li.querySelector('.pm-mc-text')?.textContent))
      .toEqual(['测试里不要 mock 数据库，用 testcontainers 起真实 Postgres。', '提交前跑 typecheck'])
    expect(screen.getByRole('searchbox', { name: '搜索记忆' })).toHaveAttribute('placeholder', '搜索记忆原文')
    const storage = document.querySelector('.pm-lib-storage')!
    expect(storage).toHaveTextContent(/^每条一个文件\s*·\s*\/m\/app-1\s*打开目录$/)
    expect(within(storage as HTMLElement).getByText('/m/app-1')).toHaveAttribute('title', '/m/app-1')
    expect(screen.queryByText(/MEMORY\.md/)).toBeNull()
  })

  it('全局写全局目录；「全部」不写存储说明，按层分段，段标题写层名和条数', () => {
    const { unmount } = renderInShell(<LibraryTab nav={createNavStore()} scope={{ kind: 'global' }} session={session} now={NOW} />, createFakeGateway({ views: { library: library() } }))
    expect(document.querySelector('.pm-lib-storage')).toHaveTextContent('/m/global')
    expect(screen.queryByRole('heading', { level: 3 })).toBeNull()
    unmount()
    renderInShell(<LibraryTab nav={createNavStore()} scope={{ kind: 'all' }} session={session} now={NOW} />, createFakeGateway({ views: { library: library() } }))
    expect(document.querySelector('.pm-lib-storage')).toBeNull()
    expect(screen.getAllByRole('heading', { level: 3 }).map(h => h.textContent)).toEqual(['全局1', 'app2', 'blog1'])
    expect(screen.getAllByRole('listitem')).toHaveLength(4)
  })

  it('搜索按名称、摘要、正文和标签筛（不分大小写）；都不匹配时说没找到', () => {
    renderInShell(<LibraryTab nav={createNavStore()} scope={{ kind: 'all' }} session={session} now={NOW} />, createFakeGateway({ views: { library: library() } }))
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索记忆' }), { target: { value: 'TYPECHECK' } })
    expect(screen.getAllByRole('listitem').map(li => li.querySelector('.pm-mc-text')?.textContent)).toEqual(['提交前跑 typecheck'])
    expect(screen.getAllByRole('heading', { level: 3 }).map(h => h.textContent)).toEqual(['app1'])
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索记忆' }), { target: { value: '没有这种东西' } })
    expect(screen.queryByRole('list')).toBeNull()
    expect(screen.getByRole('status')).toHaveTextContent('没有找到匹配的记忆')
  })

  it('行尾先是「删除」（幽灵按钮），再是「打开文件」；没有「在访达中显示」', () => {
    renderInShell(<LibraryTab nav={createNavStore()} scope={app} session={session} now={NOW} />, createFakeGateway({ views: { library: library() } }))
    const buttons = within(rowOf('提交前跑 typecheck')).getAllByRole('button')
    expect(buttons.map(b => b.textContent)).toEqual(['删除', '打开文件'])
    expect(buttons[0]).toHaveClass('pm-btn--ghost')
  })

  it('类型写显示名（待处理视图的 typeLabels）；认不出的类型写 id', () => {
    const view = library({ layers: [{ layer: app, items: [memory({ id: 'a1' }), memory({ id: 'a2', type: 'mystery', content: '提交前跑 typecheck' })] }] })
    const pending: PendingView = { version: GUI_VIEW_VERSION, dot: 'none', items: [], levelCounts: levelCountsOf([]), typeLabels: { preference: '行为偏好' } }
    renderInShell(<LibraryTab nav={createNavStore()} scope={app} session={session} now={NOW} />, createFakeGateway({ views: { library: view, pending } }))
    expect(screen.getAllByRole('listitem').map(li => li.querySelector('.pm-mc-meta span')?.textContent)).toEqual(['行为偏好', 'mystery'])
  })

  it('待处理视图没有这个类型时，用全部记忆视图自带的 typeLabels', () => {
    const view = library({ layers: [{ layer: app, items: [memory({ id: 'a1', type: 'domain-term' })] }], typeLabels: { 'domain-term': '术语' } })
    const pending: PendingView = { version: GUI_VIEW_VERSION, dot: 'none', items: [], levelCounts: levelCountsOf([]), typeLabels: {} }
    renderInShell(<LibraryTab nav={createNavStore()} scope={app} session={session} now={NOW} />, createFakeGateway({ views: { library: view, pending } }))
    expect(screen.getByRole('listitem').querySelector('.pm-mc-meta span')).toHaveTextContent('术语')
  })

  it('目录问题来自视图，灰色一行一条，路径相对存储目录', () => {
    const view = library({
      directoryIssues: [
        { code: 'duplicate-id', path: '/m/app-1/a1-copy.md', keptPath: '/m/app-1/a1.md' },
        { code: 'duplicate-id', path: '/m/app-1/a3-copy.md' },
        { code: 'reserved-keys', path: '/m/app-1/a2.md', keys: ['scope', 'content'] },
      ],
    })
    renderInShell(<LibraryTab nav={createNavStore()} scope={app} session={session} now={NOW} />, createFakeGateway({ views: { library: view } }))
    const issues = screen.getByRole('list', { name: '目录问题' })
    expect(within(issues).getAllByRole('listitem').map(li => li.textContent)).toEqual([
      '同一 id 有多份文件：在用 app-1/a1.md，未用 app-1/a1-copy.md',
      '目录有问题：app-1/a3-copy.md',
      '文件里写了插件自己管的字段（scope, content），已忽略：app-1/a2.md',
    ])
  })

  it('打开文件、打开目录都走宿主 openWorkspacePath；宿主拒绝时提示', async () => {
    const gateway = createFakeGateway({ views: { library: library() } })
    renderInShell(<LibraryTab nav={createNavStore()} scope={app} session={session} now={NOW} />, gateway)
    const row = rowOf('提交前跑 typecheck')
    await act(async () => { fireEvent.click(within(row).getByRole('button', { name: '打开文件' })) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '打开目录' })) })
    expect(gateway.opened).toEqual([{ path: '/m/app-1/a2.md' }, { path: '/m/app-1' }])
    expect(gateway.executed).toEqual([])

    const refusing = createFakeGateway({ views: { library: library() }, openOk: false })
    renderInShell(<LibraryTab nav={createNavStore()} scope={{ kind: 'global' }} session={session} now={NOW} />, refusing)
    await act(async () => { fireEvent.click(within(rowOf('回答用中文')).getByRole('button', { name: '打开文件' })) })
    expect(screen.getByRole('status')).toHaveTextContent('没能打开，DeepSeek Harness 拒绝了这个路径。')
  })

  it('删除发 /memory forget（软删），这一行原位换成结果行，视图刷新后还在原处；「撤销」发 restore，没有去最近删除的链接', async () => {
    const gateway = createFakeGateway({ views: { library: library() } })
    renderInShell(<LibraryTab nav={createNavStore({ view: 'library' })} scope={app} session={session} now={NOW} />, gateway)
    await remove(rowOf('提交前跑 typecheck'))
    expect(gateway.executed).toEqual([{ sessionId: 's1', command: { cmd: 'forget', memoryId: 'a2', layer: app } }])
    const result = () => screen.getAllByRole('listitem')[1]!
    expect(result()).toHaveTextContent('已删除，14 天内可在「最近删除」找回。')
    expect(screen.queryByRole('button', { name: '去最近删除 ›' })).toBeNull()

    const without = library()
    act(() => { gateway.setView('library', { ...without, layers: without.layers.map(l => ({ ...l, items: l.items.filter(m => m.id !== 'a2') })) }) })
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    expect(result()).toHaveTextContent('已删除，14 天内可在「最近删除」找回。')
    await act(async () => { fireEvent.click(within(result()).getByRole('button', { name: '撤销' })) })
    expect(gateway.executed.map(e => e.command)).toEqual([
      { cmd: 'forget', memoryId: 'a2', layer: app },
      { cmd: 'restore', memoryId: 'a2', layer: app },
    ])
    expect(screen.queryByText('已删除，14 天内可在「最近删除」找回。')).toBeNull()
    expect(within(result()).getByRole('button', { name: '删除' })).toBeInTheDocument()
  })

  it('删掉一个项目的最后一条：视图里这一层没了，结果行照样留在原位、能撤销；「全部」里段标题也还在', async () => {
    const onlyBlog = library({ layers: [{ layer: { kind: 'global' }, items: [memory({ id: 'g1', scope: 'global', workspacePath: undefined, content: '回答用中文' })] }, { layer: blog, items: [memory({ id: 'b1', workspacePath: '/w/blog', content: '博客用 Astro' })] }] })
    const blogGone = library({ layers: [onlyBlog.layers[0]!] })
    for (const scope of [blog, { kind: 'all' } as const]) {
      const gateway = createFakeGateway({ views: { library: onlyBlog } })
      const { unmount } = renderInShell(<LibraryTab nav={createNavStore()} scope={scope} session={session} now={NOW} />, gateway)
      await remove(rowOf('博客用 Astro'))
      act(() => { gateway.setView('library', blogGone) })
      expect(rowOf('博客用 Astro')).toHaveTextContent('已删除，14 天内可在「最近删除」找回。')
      if (scope.kind === 'all') expect(screen.getAllByRole('heading', { level: 3 }).map(h => h.textContent)).toEqual(['全局1', 'blog1'])
      await act(async () => { fireEvent.click(within(rowOf('博客用 Astro')).getByRole('button', { name: '撤销' })) })
      expect(gateway.executed.map(e => e.command)).toEqual([
        { cmd: 'forget', memoryId: 'b1', layer: blog },
        { cmd: 'restore', memoryId: 'b1', layer: blog },
      ])
      expect(within(rowOf('博客用 Astro')).getByRole('button', { name: '删除' })).toBeInTheDocument()
      unmount()
    }
  })

  it('确认开着时这一行从列表里没了（别处删了）：再回来时是「删除」按钮，不带着没收起的确认', async () => {
    const gateway = createFakeGateway({ views: { library: library() } })
    renderInShell(<LibraryTab nav={createNavStore()} scope={app} session={session} now={NOW} />, gateway)
    await act(async () => { fireEvent.click(within(rowOf('提交前跑 typecheck')).getByRole('button', { name: '删除' })) })
    expect(screen.getByRole('group', { name: '删除这条？' })).toBeInTheDocument()
    const without = library()
    act(() => { gateway.setView('library', { ...without, layers: without.layers.map(l => ({ ...l, items: l.items.filter(m => m.id !== 'a2') })) }) })
    expect(screen.queryByText('提交前跑 typecheck')).toBeNull()
    act(() => { gateway.setView('library', library()) })
    expect(within(rowOf('提交前跑 typecheck')).queryByRole('group', { name: '删除这条？' })).toBeNull()
    expect(within(rowOf('提交前跑 typecheck')).getByRole('button', { name: '删除' })).toBeInTheDocument()
  })

  it('点「删除」不直接删：原位换成「删除这条？ 删除 · 取消」，焦点在「取消」；「取消」、Esc、焦点移走、点别处都收起，什么都不发', async () => {
    const gateway = createFakeGateway({ views: { library: library() } })
    renderInShell(<LibraryTab nav={createNavStore()} scope={app} session={session} now={NOW} />, gateway)
    const row = within(rowOf('提交前跑 typecheck'))
    const open = async () => {
      const del = row.getByRole('button', { name: '删除' })
      del.focus()
      await act(async () => { fireEvent.click(del) })
      return within(row.getByRole('group', { name: '删除这条？' }))
    }
    const confirm = await open()
    expect(confirm.getAllByRole('button').map(b => b.textContent)).toEqual(['删除', '取消'])
    expect(confirm.getByRole('button', { name: '取消' })).toHaveFocus()
    expect(row.getAllByRole('button', { name: '删除' })).toHaveLength(1)

    fireEvent.click(confirm.getByRole('button', { name: '取消' }))
    await waitFor(() => { expect(row.getByRole('button', { name: '删除' })).toHaveFocus() })
    fireEvent.keyDown((await open()).getByRole('button', { name: '取消' }), { key: 'Escape' })
    expect(row.queryByRole('group', { name: '删除这条？' })).toBeNull()
    await open()
    act(() => { row.getByRole('button', { name: '打开文件' }).focus() })
    expect(row.queryByRole('group', { name: '删除这条？' })).toBeNull()
    await open()
    act(() => { fireEvent.pointerDown(screen.getByRole('searchbox', { name: '搜索记忆' })) })
    expect(row.queryByRole('group', { name: '删除这条？' })).toBeNull()
    expect(row.getByRole('button', { name: '删除' })).toBeInTheDocument()
    expect(gateway.executed).toEqual([])
    expect(screen.queryByRole('status')).toBeNull()
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
    await remove(row)
    expect(within(row).getByText('彻底删除后不进最近删除、不能恢复，以前快照里的副本也会抹掉。')).toBeInTheDocument()
    expect(within(row).getByText('这条记忆里有密钥')).toBeInTheDocument()
    expect(within(row).getByRole('button', { name: '删除' })).toHaveAttribute('aria-disabled', 'true')
    expect(screen.queryByRole('status')).toBeNull()

    fireEvent.click(within(row).getByRole('button', { name: '取消' }))
    expect(screen.queryByText('彻底删除后不进最近删除、不能恢复，以前快照里的副本也会抹掉。')).toBeNull()
    await remove(row)
    await act(async () => { fireEvent.click(within(row).getByRole('button', { name: '彻底删除' })) })
    expect(gateway.executed.map(e => e.command)).toEqual([
      { cmd: 'forget', memoryId: 'a2', layer: app },
      { cmd: 'forget', memoryId: 'a2', layer: app },
      { cmd: 'hard-delete', memoryId: 'a2', layer: app },
    ])
    expect(screen.queryByText('彻底删除后不进最近删除、不能恢复，以前快照里的副本也会抹掉。')).toBeNull()
    expect(screen.getByRole('status')).toHaveTextContent('已彻底删除。如果它是真的凭证，记得去换一个新的。')
    expect(screen.queryByText(/14 天/)).toBeNull()
  })

  it('删别的项目里的记忆：服务端拒（cross-workspace）后在行里确认，「继续处理」才带 allowCrossWorkspace 重发；失败显示原话', async () => {
    const gateway = createFakeGateway({
      views: { library: library() },
      respond: command => 'allowCrossWorkspace' in command && command.allowCrossWorkspace === true
        ? { ok: false, cmd: command.cmd, code: 'not-found', detail: '记忆 b1 不存在' }
        : { ok: false, cmd: command.cmd, code: 'cross-workspace', rejected: [{ id: 'b1', workspacePath: '/w/blog' }] },
    })
    renderInShell(<LibraryTab nav={createNavStore()} scope={{ kind: 'workspace', workspacePath: '/w/blog' }} session={session} now={NOW} />, gateway)
    await remove(screen.getByRole('listitem'))
    expect(gateway.executed.map(e => e.command)).toEqual([{ cmd: 'forget', memoryId: 'b1', layer: blog }])
    expect(screen.getByText('这条记忆属于 blog 项目，不是当前项目。确定在这里处理它吗？')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '删除' })).toHaveAttribute('aria-disabled', 'true')
    expect(screen.queryByRole('status')).toBeNull()

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '继续处理' })) })
    expect(gateway.executed.map(e => e.command)).toEqual([
      { cmd: 'forget', memoryId: 'b1', layer: blog },
      { cmd: 'forget', memoryId: 'b1', layer: blog, allowCrossWorkspace: true },
    ])
    expect(screen.queryByText(/属于 blog 项目/)).toBeNull()
    expect(screen.getByRole('status')).toHaveTextContent('没有成功：记忆 b1 不存在')
  })

  it('别的项目里含密钥的记忆：先确认彻底删除，再确认跨项目，重发的是带 allowCrossWorkspace 的 hard-delete，最后提示不可恢复', async () => {
    const gateway = createFakeGateway({
      views: { library: library() },
      respond: command => command.cmd === 'forget'
        ? { ok: false, cmd: command.cmd, code: 'has-secret', detail: '记忆 b1 含密钥，删除后不可恢复，未做任何改动' }
        : 'allowCrossWorkspace' in command && command.allowCrossWorkspace === true
          ? { ok: true, cmd: command.cmd, memoryIds: ['b1'] }
          : { ok: false, cmd: command.cmd, code: 'cross-workspace', rejected: [{ id: 'b1', workspacePath: '/w/blog' }] },
    })
    renderInShell(<LibraryTab nav={createNavStore()} scope={{ kind: 'workspace', workspacePath: '/w/blog' }} session={session} now={NOW} />, gateway)
    await remove(screen.getByRole('listitem'))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '彻底删除' })) })
    expect(screen.getByText('这条记忆属于 blog 项目，不是当前项目。确定在这里处理它吗？')).toBeInTheDocument()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '继续处理' })) })
    expect(gateway.executed.map(e => e.command)).toEqual([
      { cmd: 'forget', memoryId: 'b1', layer: blog },
      { cmd: 'hard-delete', memoryId: 'b1', layer: blog },
      { cmd: 'hard-delete', memoryId: 'b1', layer: blog, allowCrossWorkspace: true },
    ])
    expect(screen.getByRole('status')).toHaveTextContent('已彻底删除。如果它是真的凭证，记得去换一个新的。')
    expect(screen.queryByText(/14 天/)).toBeNull()
    expect(screen.queryByRole('button', { name: '去最近删除 ›' })).toBeNull()
  })

  it('别的项目里含密钥的记忆，先确认了跨项目：彻底删除沿用那条命令的层与 allowCrossWorkspace，不再问一次', async () => {
    const gateway = createFakeGateway({
      views: { library: library() },
      respond: command => !('allowCrossWorkspace' in command && command.allowCrossWorkspace === true)
        ? { ok: false, cmd: command.cmd, code: 'cross-workspace', rejected: [{ id: 'b1', workspacePath: '/w/blog' }] }
        : command.cmd === 'forget'
          ? { ok: false, cmd: command.cmd, code: 'has-secret' }
          : { ok: true, cmd: command.cmd, memoryIds: ['b1'] },
    })
    renderInShell(<LibraryTab nav={createNavStore()} scope={blog} session={session} now={NOW} />, gateway)
    await remove(screen.getByRole('listitem'))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '继续处理' })) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '彻底删除' })) })
    expect(gateway.executed.map(e => e.command)).toEqual([
      { cmd: 'forget', memoryId: 'b1', layer: blog },
      { cmd: 'forget', memoryId: 'b1', layer: blog, allowCrossWorkspace: true },
      { cmd: 'hard-delete', memoryId: 'b1', layer: blog, allowCrossWorkspace: true },
    ])
    expect(screen.getByRole('status')).toHaveTextContent('已彻底删除。如果它是真的凭证，记得去换一个新的。')
  })

  it('空状态：一条记忆都没有是首次空态「还没有记忆」；只是这一层空是日常空态', () => {
    const empty = library({ layers: [{ layer: { kind: 'global' }, items: [] }] })
    const { unmount } = renderInShell(<LibraryTab nav={createNavStore()} scope={{ kind: 'global' }} session={session} now={NOW} />, createFakeGateway({ views: { library: empty } }))
    expect(screen.getByRole('status')).toHaveClass('pm-empty--first')
    expect(screen.getByRole('status')).toHaveTextContent('还没有记忆')
    expect(document.querySelector('.pm-lib-storage')).toBeNull()
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

  describe('确认收起后的键盘焦点', () => {
    const A1 = '测试里不要 mock 数据库，用 testcontainers 起真实 Postgres。'
    const secretFirst = () => createFakeGateway({
      views: { library: library() },
      respond: command => command.cmd === 'forget'
        ? { ok: false, cmd: command.cmd, code: 'has-secret' }
        : { ok: true, cmd: command.cmd },
    })
    /** 键盘用户按回车：焦点先落在按钮上再触发点击。 */
    const press = async (button: HTMLElement) => {
      button.focus()
      await act(async () => { fireEvent.click(button) })
    }
    /** 这一行的「删除」（等确认时是确认里的那个）。 */
    const delOf = (text: string) => within(rowOf(text)).getByRole('button', { name: '删除' })
    /** 键盘点「删除」，再在原位确认里点「删除」。 */
    const pressRemove = async (text: string) => {
      await press(delOf(text))
      await press(delOf(text))
    }

    it('普通删除：确认后这一行换成结果行，焦点落在它的「撤销」上；视图刷新后焦点不动', async () => {
      const gateway = createFakeGateway({ views: { library: library() } })
      renderInShell(<LibraryTab nav={createNavStore()} scope={app} session={session} now={NOW} />, gateway)
      await pressRemove(A1)
      const undo = () => within(screen.getAllByRole('listitem')[0]!).getByRole('button', { name: '撤销' })
      await waitFor(() => { expect(undo()).toHaveFocus() })
      act(() => { gateway.setView('library', library({ layers: [{ layer: app, items: [memory({ id: 'a2', content: '提交前跑 typecheck' })] }] })) })
      expect(undo()).toHaveFocus()
    })

    it('视图先于命令结果刷新（宿主先推了新版本）：这一行留在原位，结果回来后换成结果行，焦点照样落在「撤销」上', async () => {
      let answer: (() => void) | undefined
      const gateway = createFakeGateway({
        views: { library: library() },
        respond: command => new Promise((resolve) => { answer = () => { resolve({ ok: true, cmd: command.cmd }) } }),
      })
      renderInShell(<LibraryTab nav={createNavStore()} scope={app} session={session} now={NOW} />, gateway)
      await pressRemove(A1)
      await waitFor(() => { expect(delOf(A1)).toHaveFocus() })
      act(() => { gateway.setView('library', library({ layers: [{ layer: app, items: [memory({ id: 'a2', content: '提交前跑 typecheck' })] }] })) })
      expect(delOf(A1)).toHaveFocus()
      await act(async () => { answer?.() })
      await waitFor(() => { expect(within(rowOf(A1)).getByRole('button', { name: '撤销' })).toHaveFocus() })
      expect(screen.getAllByRole('listitem')[0]).toBe(rowOf(A1))
    })

    it('含密钥确认点「取消」：焦点回到这一行的「删除」', async () => {
      renderInShell(<LibraryTab nav={createNavStore()} scope={app} session={session} now={NOW} />, secretFirst())
      await pressRemove(A1)
      await press(within(rowOf(A1)).getByRole('button', { name: '取消' }))
      await waitFor(() => { expect(delOf(A1)).toHaveFocus() })
    })

    it('彻底删除后这一行没了：焦点落到下一行的「删除」；删的是最后一条时落到提示上', async () => {
      const gateway = secretFirst()
      renderInShell(<LibraryTab nav={createNavStore()} scope={app} session={session} now={NOW} />, gateway)
      await pressRemove(A1)
      await press(within(rowOf(A1)).getByRole('button', { name: '彻底删除' }))
      await waitFor(() => { expect(delOf(A1)).toHaveFocus() })
      act(() => { gateway.setView('library', library({ layers: [{ layer: app, items: [memory({ id: 'a2', content: '提交前跑 typecheck' })] }] })) })
      await waitFor(() => { expect(delOf('提交前跑 typecheck')).toHaveFocus() })

      await pressRemove('提交前跑 typecheck')
      await press(within(rowOf('提交前跑 typecheck')).getByRole('button', { name: '彻底删除' }))
      act(() => { gateway.setView('library', library({ layers: [{ layer: app, items: [] }, { layer: { kind: 'global' }, items: [memory({ id: 'g1' })] }] })) })
      await waitFor(() => { expect(screen.getByText('已彻底删除。如果它是真的凭证，记得去换一个新的。')).toHaveFocus() })
    })

    it('跨项目确认出现时焦点移进确认、落在「取消」上；直接回车取消后回到「删除」', async () => {
      const gateway = createFakeGateway({
        views: { library: library() },
        respond: command => ({ ok: false, cmd: command.cmd, code: 'cross-workspace', rejected: [{ id: 'a1', workspacePath: '/w/blog' }] }),
      })
      renderInShell(<LibraryTab nav={createNavStore()} scope={app} session={session} now={NOW} />, gateway)
      await pressRemove(A1)
      const cancel = screen.getByRole('button', { name: '取消' })
      expect(cancel).toHaveFocus()
      await act(async () => { fireEvent.click(cancel) })
      await waitFor(() => { expect(delOf(A1)).toHaveFocus() })
    })

    it('跨项目确认：「取消」回到「删除」；「继续处理」删掉后这一行换成结果行，焦点落在「撤销」上', async () => {
      const gateway = createFakeGateway({
        views: { library: library() },
        respond: command => 'allowCrossWorkspace' in command && command.allowCrossWorkspace === true
          ? { ok: true, cmd: command.cmd, memoryIds: ['a1'] }
          : { ok: false, cmd: command.cmd, code: 'cross-workspace', rejected: [{ id: 'a1', workspacePath: '/w/blog' }] },
      })
      renderInShell(<LibraryTab nav={createNavStore()} scope={app} session={session} now={NOW} />, gateway)
      await pressRemove(A1)
      await press(screen.getByRole('button', { name: '取消' }))
      await waitFor(() => { expect(delOf(A1)).toHaveFocus() })

      await pressRemove(A1)
      await press(screen.getByRole('button', { name: '继续处理' }))
      await waitFor(() => { expect(within(rowOf(A1)).getByRole('button', { name: '撤销' })).toHaveFocus() })
      expect(rowOf(A1)).toHaveTextContent('已删除，14 天内可在「最近删除」找回。')
    })
  })

  describe('带 memoryId 打开', () => {
    const scrollIntoView = vi.fn()
    beforeEach(() => { vi.useFakeTimers(); scrollIntoView.mockClear(); Element.prototype.scrollIntoView = scrollIntoView })
    afterEach(() => { vi.useRealTimers(); delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView })

    it('目标行滚入视野并高亮一次；视图刷新不重播，播完收起，入口再导航一次会重播', () => {
      const gateway = createFakeGateway({ views: { library: library() } })
      const nav = createNavStore({ view: 'library', scope: app, memoryId: 'a2' })
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

      act(() => { nav.navigate({ view: 'library', scope: app, memoryId: 'a2' }) })
      expect(rowOf('提交前跑 typecheck')).toHaveClass('pm-flash')
      expect(scrollIntoView).toHaveBeenCalledTimes(2)
    })

    it('目标行视图晚到时，到了再高亮', () => {
      const gateway = createFakeGateway({ views: { library: { status: 'loading' } } })
      renderInShell(<LibraryTab nav={createNavStore({ view: 'library', memoryId: 'a1' })} scope={app} session={session} now={NOW} />, gateway)
      expect(scrollIntoView).not.toHaveBeenCalled()
      act(() => { gateway.setView('library', library()) })
      expect(rowOf('测试里不要 mock 数据库，用 testcontainers 起真实 Postgres。')).toHaveClass('pm-flash')
      expect(scrollIntoView).toHaveBeenCalledTimes(1)
    })
  })
})
