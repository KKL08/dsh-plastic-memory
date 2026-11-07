// 「全部记忆」tab：对假网关断言渲染出什么、每个动作发出了哪条命令或宿主调用。
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { GUI_VIEW_VERSION, checkupKey, type LibraryView, type MemoryCard, type MemoryCommand, type MemoryCommandResult, type PendingView } from '../../src/gui/contract.ts'
import type { BorrowedSession } from '../gateway.ts'
import { createFakeGateway } from '../gateway.fake.ts'
import { createNavStore, type PageScope } from '../nav.ts'
import { EDIT_MODE_STORAGE_KEY } from '../pending/edit-modes.tsx'
import { memory, NOW, renderInShell, levelCountsOf } from '../test-utils.tsx'
import { LibraryTab } from './LibraryTab.tsx'
import type { FoldMemory } from './groups.tsx'
import { FLASH_MS } from './shared.tsx'
import { createTranslator } from '../i18n.tsx'
import { en } from '../locales.ts'
import { PanelShell } from '../ui/PanelShell.tsx'

const app = { kind: 'workspace', workspacePath: '/w/app' } as const
const blog = { kind: 'workspace', workspacePath: '/w/blog' } as const
const session: BorrowedSession = { kind: 'ready', sessionId: 's1', cwd: '/w/app' }
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

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

/** 一个项目按类型分组：偏好 1 条，事实与经验 5 条（第 4、5 条收在「展开其余」里），退役的人物 1 条。 */
function typed(): LibraryView {
  const k = (n: number) => memory({ id: `k${n}`, type: 'knowledge', content: `经验 ${n}`, updatedAt: NOW - n * HOUR })
  return library({
    layers: [{ layer: app, items: [memory({ id: 'p1', type: 'person', content: '人物 1', updatedAt: NOW - 10 * DAY }), k(1), k(2), k(3), k(4), k(5), memory({ id: 'f1', type: 'preference', content: '偏好 1', updatedAt: NOW - 30 * DAY })] }],
    typeOrder: ['preference', 'knowledge', 'person'],
    typeLabels: { preference: '行为偏好', knowledge: '事实与经验', person: '人物' },
  })
}

/** 跨范围、不同新旧：24 小时内 1 条，近 3 天 1 条，近 7 天 4 条，更早 1 条。 */
function recent(): LibraryView {
  return library({
    layers: [
      { layer: { kind: 'global' }, items: [memory({ id: 'g1', scope: 'global', workspacePath: undefined, content: '回答用中文', updatedAt: NOW - 100 * HOUR })] },
      { layer: app, items: [memory({ id: 'a1', content: '刚记的', updatedAt: NOW - HOUR }), memory({ id: 'a2', content: '前天改的', updatedAt: NOW - 30 * HOUR }), memory({ id: 'a3', content: '上个月的', updatedAt: NOW - 30 * DAY })] },
      { layer: blog, items: ['b1', 'b2', 'b3'].map((id, i) => memory({ id, workspacePath: '/w/blog', content: `博客 ${id}`, updatedAt: NOW - (120 + i) * HOUR })) },
    ],
  })
}

/** 列表里每行的记忆原文。 */
function texts(within_: HTMLElement | Document = document): string[] {
  return [...within_.querySelectorAll('.pm-list > li .pm-mc-text')].map(p => p.textContent ?? '')
}

/** 组标题按钮（名字以类型或时间段开头）。 */
function groupToggle(title: string): HTMLElement {
  return screen.getByRole('button', { name: new RegExp(`^${title}\\d`) })
}

/** 组体：组标题 aria-controls 指的那一块。 */
function groupBody(title: string): HTMLElement {
  return document.getElementById(groupToggle(title).getAttribute('aria-controls')!)!
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

  it('全局写全局目录、按类型分组；「全部」不写存储说明，跨范围按更新时间分段，7 天前的收在「更早」里并说一句', () => {
    const { unmount } = renderInShell(<LibraryTab nav={createNavStore()} scope={{ kind: 'global' }} session={session} now={NOW} />, createFakeGateway({ views: { library: library() } }))
    expect(document.querySelector('.pm-lib-storage')).toHaveTextContent('/m/global')
    expect(screen.getAllByRole('heading', { level: 3 }).map(h => h.textContent)).toEqual(['行为偏好1'])
    expect(screen.queryByText('最近 7 天没有新记或改动的记忆。')).toBeNull()
    unmount()
    renderInShell(<LibraryTab nav={createNavStore()} scope={{ kind: 'all' }} session={session} now={NOW} />, createFakeGateway({ views: { library: library() } }))
    expect(document.querySelector('.pm-lib-storage')).toBeNull()
    expect(screen.getAllByRole('heading', { level: 3 }).map(h => h.textContent)).toEqual(['更早4'])
    expect(screen.getByRole('button', { name: '更早4' })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryAllByRole('listitem')).toHaveLength(0)
    expect(screen.getByText('最近 7 天没有新记或改动的记忆。')).toBeInTheDocument()
  })

  it('搜索按名称、摘要、正文和标签筛（不分大小写）；都不匹配时说没找到', () => {
    renderInShell(<LibraryTab nav={createNavStore()} scope={{ kind: 'all' }} session={session} now={NOW} />, createFakeGateway({ views: { library: library() } }))
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索记忆' }), { target: { value: 'TYPECHECK' } })
    expect(screen.getAllByRole('listitem').map(li => li.querySelector('.pm-mc-text')?.textContent)).toEqual(['提交前跑 typecheck'])
    expect(screen.getAllByRole('heading', { level: 3 }).map(h => h.textContent)).toEqual(['更早1'])
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索记忆' }), { target: { value: '没有这种东西' } })
    expect(screen.queryByRole('list')).toBeNull()
    expect(screen.getByRole('status')).toHaveTextContent('没有找到匹配的记忆')
  })

  it('没有版本（digest）的行尾只有「删除」（幽灵按钮）和「打开文件」（纯图标）；没有「在访达中显示」', () => {
    renderInShell(<LibraryTab nav={createNavStore()} scope={app} session={session} now={NOW} />, createFakeGateway({ views: { library: library() } }))
    const buttons = within(rowOf('提交前跑 typecheck')).getAllByRole('button')
    expect(buttons.map(b => b.getAttribute('aria-label') ?? b.textContent)).toEqual(['删除', '打开文件'])
    expect(buttons[0]).toHaveClass('pm-btn--ghost')
  })

  it('类型写显示名（待处理视图的 typeLabels），认不出的类型写 id：单个范围写在组标题上、卡片不再写；「全部」写在卡片上', () => {
    const view = library({
      layers: [{ layer: app, items: [memory({ id: 'a1', updatedAt: NOW - HOUR }), memory({ id: 'a2', type: 'mystery', content: '提交前跑 typecheck', updatedAt: NOW - 2 * HOUR })] }],
      typeOrder: ['preference'],
    })
    const pending: PendingView = { version: GUI_VIEW_VERSION, dot: 'none', items: [], levelCounts: levelCountsOf([]), typeLabels: { preference: '行为偏好' } }
    const { unmount } = renderInShell(<LibraryTab nav={createNavStore()} scope={app} session={session} now={NOW} />, createFakeGateway({ views: { library: view, pending } }))
    expect(screen.getAllByRole('heading', { level: 3 }).map(h => h.textContent)).toEqual(['行为偏好1', 'mystery1'])
    expect(document.querySelector('.pm-mc-meta .pm-chip')).toBeNull()
    unmount()
    renderInShell(<LibraryTab nav={createNavStore()} scope={{ kind: 'all' }} session={session} now={NOW} />, createFakeGateway({ views: { library: view, pending } }))
    expect(screen.getAllByRole('listitem').map(li => li.querySelector('.pm-mc-meta .pm-chip')?.textContent)).toEqual(['行为偏好', 'mystery'])
  })

  it('待处理视图没有这个类型时，用全部记忆视图自带的 typeLabels', () => {
    const view = library({ layers: [{ layer: app, items: [memory({ id: 'a1', type: 'domain-term' })] }], typeLabels: { 'domain-term': '术语' } })
    const pending: PendingView = { version: GUI_VIEW_VERSION, dot: 'none', items: [], levelCounts: levelCountsOf([]), typeLabels: {} }
    renderInShell(<LibraryTab nav={createNavStore()} scope={app} session={session} now={NOW} />, createFakeGateway({ views: { library: view, pending } }))
    expect(screen.getByRole('heading', { level: 3 })).toHaveTextContent('术语1')
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

  it('PA-44 撤销删除时这条正在别处处理（claimed）：提示已在别处处理，不显示失败，结果行照旧', async () => {
    const gateway = createFakeGateway({
      views: { library: library() },
      respond: command => command.cmd === 'restore'
        ? { ok: false, cmd: command.cmd, code: 'claimed', detail: '待决项 pd1 正在被另一次操作处理，未做任何改动' }
        : { ok: true, cmd: command.cmd },
    })
    renderInShell(<LibraryTab nav={createNavStore({ view: 'library' })} scope={app} session={session} now={NOW} />, gateway)
    await remove(rowOf('提交前跑 typecheck'))
    const result = () => screen.getAllByRole('listitem')[1]!
    await act(async () => { fireEvent.click(within(result()).getByRole('button', { name: '撤销' })) })
    expect(screen.getByRole('status')).toHaveTextContent('这次操作没有生效：这一条正在别处处理，或者刚在别处处理完。')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByText(/没有成功|正在被另一次操作处理/)).toBeNull()
    expect(result()).toHaveTextContent('已删除，14 天内可在「最近删除」找回。')
  })

  it('删掉一个项目的最后一条：视图里这一层没了，结果行照样留在原位、能撤销；组标题也还在', async () => {
    const onlyBlog = library({ layers: [{ layer: { kind: 'global' }, items: [memory({ id: 'g1', scope: 'global', workspacePath: undefined, content: '回答用中文' })] }, { layer: blog, items: [memory({ id: 'b1', workspacePath: '/w/blog', content: '博客用 Astro', updatedAt: NOW - HOUR })] }] })
    const blogGone = library({ layers: [onlyBlog.layers[0]!] })
    for (const scope of [blog, { kind: 'all' } as const]) {
      const gateway = createFakeGateway({ views: { library: onlyBlog } })
      const { unmount } = renderInShell(<LibraryTab nav={createNavStore()} scope={scope} session={session} now={NOW} />, gateway)
      await remove(rowOf('博客用 Astro'))
      act(() => { gateway.setView('library', blogGone) })
      expect(rowOf('博客用 Astro')).toHaveTextContent('已删除，14 天内可在「最近删除」找回。')
      expect(screen.getAllByRole('heading', { level: 3 }).map(h => h.textContent)).toEqual(scope.kind === 'all' ? ['24 小时内1', '更早1'] : ['行为偏好1'])
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

  it('删除失败时这一行已经不在了（别处删掉）：失败提示挪到列表上方，不跟着那一行消失', async () => {
    let release: ((result: MemoryCommandResult) => void) | undefined
    const gateway = createFakeGateway({ views: { library: library() }, respond: () => new Promise((resolve) => { release = resolve }) })
    renderInShell(<LibraryTab nav={createNavStore()} scope={app} session={session} now={NOW} />, gateway)
    await remove(rowOf('提交前跑 typecheck'))
    act(() => { gateway.setView('library', library({ layers: library().layers.map(l => ({ ...l, items: l.items.filter(m => m.id !== 'a2') })) })) })
    await act(async () => { release!({ ok: false, cmd: 'forget', code: 'not-found', detail: '记忆 a2 不存在' }) })
    expect(screen.queryByText('提交前跑 typecheck')).toBeNull()
    expect(screen.getByRole('alert')).toHaveTextContent('没有成功：这条记忆已经不在了，可能在别处删掉了。列表已更新。')
  })

  it('删别的项目里的记忆：服务端拒（cross-workspace）后在行里确认，「继续处理」才带 allowCrossWorkspace 重发；失败显示原话', async () => {
    const gateway = createFakeGateway({
      views: { library: library() },
      respond: command => 'allowCrossWorkspace' in command && command.allowCrossWorkspace === true
        ? { ok: false, cmd: command.cmd, code: 'failed', detail: '记忆 b1 不存在' }
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
    expect(within(screen.getByRole('listitem')).getByRole('alert')).toHaveTextContent('没有成功：记忆 b1 不存在')
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
      // 确认组打开时焦点在「取消」上
      await waitFor(() => { expect(screen.getByRole('button', { name: '取消' })).toHaveFocus() })
      await press(screen.getByRole('button', { name: '取消' }))
      await waitFor(() => { expect(delOf(A1)).toHaveFocus() })

      await pressRemove(A1)
      await press(screen.getByRole('button', { name: '继续处理' }))
      await waitFor(() => { expect(within(rowOf(A1)).getByRole('button', { name: '撤销' })).toHaveFocus() })
      expect(rowOf(A1)).toHaveTextContent('已删除，14 天内可在「最近删除」找回。')
    })
  })

  describe('单个范围按类型分组', () => {
    const scrollIntoView = vi.fn()
    beforeEach(() => { scrollIntoView.mockClear(); Element.prototype.scrollIntoView = scrollIntoView })
    afterEach(() => { delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView })

    it('组按 typeOrder 排、退役类型在后，标题写类型和条数；每组先露 3 条（新的在前），其余收在「展开其余 N 条」里', () => {
      renderInShell(<LibraryTab nav={createNavStore()} scope={app} session={session} now={NOW} />, createFakeGateway({ views: { library: typed() } }))
      expect(screen.getAllByRole('heading', { level: 3 }).map(h => h.textContent)).toEqual(['行为偏好1', '事实与经验5', '人物1'])
      expect(texts(groupBody('事实与经验'))).toEqual(['经验 1', '经验 2', '经验 3'])
      expect(within(groupBody('事实与经验')).getByRole('button', { name: '展开其余 2 条' })).toBeInTheDocument()
      expect(within(groupBody('行为偏好')).queryByRole('button', { name: /展开其余|收起到/ })).toBeNull()
    })

    it('点组标题收起、再展开：aria-expanded 翻转，收起时组体藏起来、标题写最近一次更新；只有点标题展开的组体带撑开动效', () => {
      renderInShell(<LibraryTab nav={createNavStore()} scope={app} session={session} now={NOW} />, createFakeGateway({ views: { library: typed() } }))
      const toggle = groupToggle('事实与经验')
      expect(toggle).toHaveAttribute('aria-expanded', 'true')
      expect(groupBody('事实与经验').querySelector('.pm-arrive')).toBeNull()
      fireEvent.click(toggle)
      expect(toggle).toHaveAttribute('aria-expanded', 'false')
      expect(groupBody('事实与经验')).not.toBeVisible()
      expect(toggle).toHaveTextContent('事实与经验5最近 10 月 17 日')
      fireEvent.click(toggle)
      expect(toggle).toHaveAttribute('aria-expanded', 'true')
      expect(toggle).toHaveTextContent(/^事实与经验5$/)
      expect(groupBody('事实与经验').querySelector('.pm-arrive')).not.toBeNull()
      expect(groupBody('行为偏好').querySelector('.pm-arrive')).toBeNull()
    })

    it('「展开其余」露出全部、焦点落在新露出的第一条，不播撑开；「收起到 3 条」收回，组标题滚进视野、焦点回到标题', () => {
      renderInShell(<LibraryTab nav={createNavStore()} scope={app} session={session} now={NOW} />, createFakeGateway({ views: { library: typed() } }))
      fireEvent.click(screen.getByRole('button', { name: '展开其余 2 条' }))
      expect(texts(groupBody('事实与经验'))).toEqual(['经验 1', '经验 2', '经验 3', '经验 4', '经验 5'])
      expect(rowOf('经验 4')).toHaveFocus()
      expect(rowOf('经验 5')).not.toHaveAttribute('tabindex')
      // 行只在接住焦点期间可聚焦：焦点走了，鼠标点它的正文不再把焦点落到整行
      act(() => { groupToggle('事实与经验').focus() })
      expect(rowOf('经验 4')).not.toHaveAttribute('tabindex')
      expect(groupBody('事实与经验').querySelector('.pm-arrive')).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: '收起到 3 条' }))
      expect(texts(groupBody('事实与经验'))).toEqual(['经验 1', '经验 2', '经验 3'])
      expect(groupToggle('事实与经验')).toHaveFocus()
      expect(scrollIntoView.mock.contexts.at(-1)).toBe(groupToggle('事实与经验'))
      expect(scrollIntoView).toHaveBeenLastCalledWith({ block: 'nearest' })
    })

    it('搜索时组都展开、不截断，搜索里点标题只收起这一次；清空搜索回到原来的折叠状态', () => {
      renderInShell(<LibraryTab nav={createNavStore()} scope={app} session={session} now={NOW} />, createFakeGateway({ views: { library: typed() } }))
      fireEvent.click(groupToggle('人物'))
      const search = screen.getByRole('searchbox', { name: '搜索记忆' })
      fireEvent.change(search, { target: { value: '经验' } })
      expect(screen.getAllByRole('heading', { level: 3 }).map(h => h.textContent)).toEqual(['事实与经验5'])
      expect(texts()).toHaveLength(5)
      expect(screen.queryByRole('button', { name: /展开其余|收起到/ })).toBeNull()
      fireEvent.change(search, { target: { value: '人物' } })
      expect(groupToggle('人物')).toHaveAttribute('aria-expanded', 'true')
      fireEvent.change(search, { target: { value: '1' } })
      fireEvent.click(groupToggle('事实与经验'))
      expect(groupToggle('事实与经验')).toHaveAttribute('aria-expanded', 'false')
      fireEvent.change(search, { target: { value: '' } })
      expect(groupToggle('人物')).toHaveAttribute('aria-expanded', 'false')
      expect(groupToggle('事实与经验')).toHaveAttribute('aria-expanded', 'true')
      expect(texts(groupBody('事实与经验'))).toHaveLength(3)
      // 上一次搜索里的收起清空搜索时就丢了：再搜索，组照样都展开
      fireEvent.change(search, { target: { value: '1' } })
      expect(groupToggle('事实与经验')).toHaveAttribute('aria-expanded', 'true')
    })

    it('StrictMode 下分组行为不变：搜索里收起、清空复原、再搜都展开；「展开其余」焦点落在新露出的第一条', () => {
      renderInShell(<StrictMode><LibraryTab nav={createNavStore()} scope={app} session={session} now={NOW} /></StrictMode>, createFakeGateway({ views: { library: typed() } }))
      const search = screen.getByRole('searchbox', { name: '搜索记忆' })
      fireEvent.change(search, { target: { value: '1' } })
      fireEvent.click(groupToggle('事实与经验'))
      expect(groupToggle('事实与经验')).toHaveAttribute('aria-expanded', 'false')
      fireEvent.change(search, { target: { value: '' } })
      expect(groupToggle('事实与经验')).toHaveAttribute('aria-expanded', 'true')
      fireEvent.change(search, { target: { value: '1' } })
      expect(groupToggle('事实与经验')).toHaveAttribute('aria-expanded', 'true')
      fireEvent.change(search, { target: { value: '' } })
      fireEvent.click(screen.getByRole('button', { name: '展开其余 2 条' }))
      expect(rowOf('经验 4')).toHaveFocus()
    })

    it('折叠状态记在记忆页给的那一份里：切走再回来（重挂）还在，另一个范围不受影响', () => {
      const fold: FoldMemory = new Map()
      const gateway = createFakeGateway({ views: { library: typed() } })
      const { unmount } = renderInShell(<LibraryTab nav={createNavStore()} scope={app} session={session} fold={fold} now={NOW} />, gateway)
      fireEvent.click(groupToggle('行为偏好'))
      fireEvent.click(screen.getByRole('button', { name: '展开其余 2 条' }))
      unmount()
      const { unmount: unmountAgain } = renderInShell(<LibraryTab nav={createNavStore()} scope={app} session={session} fold={fold} now={NOW} />, gateway)
      expect(groupToggle('行为偏好')).toHaveAttribute('aria-expanded', 'false')
      expect(texts(groupBody('事实与经验'))).toHaveLength(5)
      expect(groupBody('事实与经验').querySelector('.pm-arrive')).toBeNull()
      unmountAgain()
      renderInShell(<LibraryTab nav={createNavStore()} scope={{ kind: 'workspace', workspacePath: '/w/app2' }} session={session} fold={fold} now={NOW} />, gateway)
      expect([...fold.keys()].every(key => key.startsWith(`library|${checkupKey(app)}|`))).toBe(true)
    })
  })

  describe('「全部」跨范围按时间', () => {
    it('分「24 小时内 / 近 3 天 / 近 7 天 / 更早」四段，新的在前，都不截断；「更早」默认收起；卡片写类型和范围名', () => {
      renderInShell(<LibraryTab nav={createNavStore()} scope={{ kind: 'all' }} session={session} now={NOW} />, createFakeGateway({ views: { library: recent() } }))
      expect(screen.getAllByRole('heading', { level: 3 }).map(h => h.textContent)).toEqual(['24 小时内1', '近 3 天1', '近 7 天4', '更早1'])
      expect(texts()).toEqual(['刚记的', '前天改的', '回答用中文', '博客 b1', '博客 b2', '博客 b3'])
      expect(groupToggle('更早')).toHaveAttribute('aria-expanded', 'false')
      expect(screen.queryByRole('button', { name: /展开其余/ })).toBeNull()
      expect(screen.queryByText('最近 7 天没有新记或改动的记忆。')).toBeNull()
      const row = rowOf('博客 b1')
      expect(row.querySelector('.pm-chip')).toHaveTextContent('行为偏好')
      expect(within(row).getByRole('button', { name: '到「blog」查看这条' })).toHaveTextContent('blog›')
      expect(within(rowOf('回答用中文')).getByRole('button', { name: '到「全局」查看这条' })).toBeInTheDocument()
    })

    it('搜索时四段都展开，「更早」也展开', () => {
      renderInShell(<LibraryTab nav={createNavStore()} scope={{ kind: 'all' }} session={session} now={NOW} />, createFakeGateway({ views: { library: recent() } }))
      fireEvent.change(screen.getByRole('searchbox', { name: '搜索记忆' }), { target: { value: '上个月' } })
      expect(groupToggle('更早')).toHaveAttribute('aria-expanded', 'true')
      expect(texts()).toEqual(['上个月的'])
    })

    it('点卡片上的范围名：落到那个范围、带上这条记忆，视图不变', () => {
      const nav = createNavStore({ view: 'library', scope: { kind: 'all' } })
      renderInShell(<LibraryTab nav={nav} scope={{ kind: 'all' }} session={session} now={NOW} />, createFakeGateway({ views: { library: recent() } }))
      fireEvent.click(within(rowOf('博客 b2')).getByRole('button', { name: '到「blog」查看这条' }))
      expect(nav.get()).toEqual({ view: 'library', scope: blog, memoryId: 'b2' })
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

    it('目标在收起的组、第 4 条以后：同一次渲染里展开组和其余，高亮那一行并接住焦点；高亮播完组照样展开着', () => {
      const fold: FoldMemory = new Map([[`library|${checkupKey(app)}|type:knowledge`, { isOpen: false }]])
      const nav = createNavStore({ view: 'library', scope: app, memoryId: 'k5' })
      renderInShell(<LibraryTab nav={nav} scope={app} session={session} fold={fold} now={NOW} />, createFakeGateway({ views: { library: typed() } }))
      const row = rowOf('经验 5')
      expect(row).toHaveClass('pm-flash')
      expect(row).toHaveFocus()
      expect(scrollIntoView.mock.contexts[0]).toBe(row)
      expect(groupBody('事实与经验').querySelector('.pm-arrive')).toBeNull()
      act(() => { vi.advanceTimersByTime(FLASH_MS) })
      expect(row).not.toHaveClass('pm-flash')
      expect(row).toHaveFocus()
      expect(rowOf('经验 4')).not.toHaveAttribute('tabindex')
      expect(groupToggle('事实与经验')).toHaveAttribute('aria-expanded', 'true')
      expect(texts(groupBody('事实与经验'))).toHaveLength(5)
      expect(fold.get(`library|${checkupKey(app)}|type:knowledge`)).toEqual({ isOpen: true, isFull: true })
    })

    it('高亮期间目标行被搜索滤掉：高亮就此结束；清空搜索后不重播，不抢搜索框的焦点', () => {
      const nav = createNavStore({ view: 'library', scope: app, memoryId: 'k2' })
      renderInShell(<LibraryTab nav={nav} scope={app} session={session} now={NOW} />, createFakeGateway({ views: { library: typed() } }))
      const search = screen.getByRole('searchbox', { name: '搜索记忆' })
      act(() => { search.focus() })
      fireEvent.change(search, { target: { value: '经验 1' } })
      fireEvent.change(search, { target: { value: '' } })
      expect(rowOf('经验 2')).not.toHaveClass('pm-flash')
      expect(search).toHaveFocus()
      expect(scrollIntoView).toHaveBeenCalledTimes(1)
    })

    it('高亮期间删掉目标行（第 4 条以后）：高亮结束，结果行和撤销留在眼前；撤销后行回来不重播', async () => {
      const nav = createNavStore({ view: 'library', scope: app, memoryId: 'k5' })
      renderInShell(<LibraryTab nav={nav} scope={app} session={session} now={NOW} />, createFakeGateway({ views: { library: typed() } }))
      await remove(rowOf('经验 5'))
      const undo = within(rowOf('经验 5')).getByRole('button', { name: '撤销' })
      expect(texts(groupBody('事实与经验'))).toHaveLength(5)
      await act(async () => { fireEvent.click(undo) })
      expect(rowOf('经验 5')).not.toHaveClass('pm-flash')
      expect(scrollIntoView).toHaveBeenCalledTimes(1)
    })

    it('高亮期间点组标题收起：组收起，高亮一起结束', () => {
      const nav = createNavStore({ view: 'library', scope: app, memoryId: 'k5' })
      renderInShell(<LibraryTab nav={nav} scope={app} session={session} now={NOW} />, createFakeGateway({ views: { library: typed() } }))
      fireEvent.click(groupToggle('事实与经验'))
      expect(groupToggle('事实与经验')).toHaveAttribute('aria-expanded', 'false')
      expect(document.querySelector('.pm-flash')).toBeNull()
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

describe('记忆查看：单条修改', () => {
  const target = memory({ id: 'a1', name: '发版流程', content: '每周三发版，先跑测试再打包。', summary: '发版的节奏', tags: ['发版'], digest: 'sha1:a1', updatedAt: 111, filePath: '/m/app-1/a1.md' })
  const other = memory({ id: 'a2', name: '提交前检查', content: '提交前跑 typecheck', summary: '提交前', digest: 'sha1:a2', updatedAt: 222, filePath: '/m/app-1/a2.md' })
  const base = { updatedAt: 111, digest: 'sha1:a1' }
  const view = (items = [target, other]) => library({ layers: [{ layer: app, items }] })
  const drafted = (draft: object = {}): MemoryCommandResult => ({ ok: true, cmd: 'draft-edit', draft: { content: '每周四发版，先跑测试再打包。', summary: '发版的节奏', ...draft }, model: 'deepseek-v4-flash' } as MemoryCommandResult)
  const edited: MemoryCommandResult = { ok: true, cmd: 'edit-memory', decisionId: 'pd_e', memoryIds: ['a1'], snapshotId: 'snap_e', filePath: '/m/app-1/a1.md' }
  const respondWith = (draft: object = {}) => (command: MemoryCommand): MemoryCommandResult | Promise<MemoryCommandResult> =>
    command.cmd === 'draft-edit' ? drafted(draft) : command.cmd === 'edit-memory' ? edited : { ok: true, cmd: command.cmd }
  const critical = `${'sk-' + 'TESTONLY'.padEnd(24, 'a')}`

  function setup({ items, respond = respondWith(), model, scope = app }: {
    items?: MemoryCard[]
    respond?: (command: MemoryCommand) => MemoryCommandResult | Promise<MemoryCommandResult>
    model?: string | null
    scope?: PageScope
  } = {}) {
    const gateway = createFakeGateway({ views: { library: view(items) }, respond, ...(model !== undefined ? { model } : {}) })
    const utils = renderInShell(<LibraryTab nav={createNavStore({ view: 'library' })} scope={scope} session={session} now={NOW} />, gateway)
    return { gateway, utils, commands: () => gateway.executed.map(e => e.command) }
  }
  /** 记忆卡原文是这一句的那一行（面板里的编辑框、对照也有同样的字，不能按全文找）。 */
  const row = (text = '每周三发版，先跑测试再打包。') => {
    const hit = [...document.querySelectorAll<HTMLElement>('.pm-list > li')].find(li => li.querySelector('.pm-mc-text')?.firstChild?.textContent === text)
    if (hit === undefined) throw new Error(`没有原文是「${text}」的行`)
    return hit
  }
  const open = (li = row()) => { fireEvent.click(within(li).getByRole('button', { name: '修改' })) }
  const ask = () => screen.getByRole('textbox', { name: '想怎么改这条？' })
  const write = (text: string) => { fireEvent.change(ask(), { target: { value: text } }) }
  const generate = async () => { await act(async () => { fireEvent.click(screen.getByRole('button', { name: '生成修改' })) }) }
  const apply = async () => { await act(async () => { fireEvent.click(screen.getByRole('button', { name: '应用' })) }) }

  beforeEach(() => { localStorage.clear() })
  afterEach(() => { vi.useRealTimers(); localStorage.clear() })

  it('故事 1：行尾依次是「修改」（小号次按钮）·「删除」（幽灵）·「打开文件」（纯图标，读屏名称和悬停提示都是「打开文件」）', () => {
    const { gateway } = setup()
    const buttons = within(row()).getAllByRole('button')
    expect(buttons.map(b => b.getAttribute('aria-label') ?? b.textContent)).toEqual(['修改', '删除', '打开文件'])
    expect(buttons[0]).toHaveClass('pm-btn--secondary')
    expect(buttons[1]).toHaveClass('pm-btn--ghost')
    expect(buttons[2]).toHaveClass('pm-btn--icon')
    expect(buttons[2]).toHaveAttribute('title', '打开文件')
    expect(buttons[2]).toHaveTextContent(/^$/)
    expect(buttons[2]!.querySelector('svg')).not.toBeNull()
    fireEvent.click(buttons[2]!)
    expect(gateway.opened).toEqual([{ path: '/m/app-1/a1.md' }])
  })

  it('故事 1：含密钥或没有版本（digest）的不显示「修改」；「全部」范围同样有「修改」', () => {
    const secret = memory({ id: 'a3', content: '部署 token [已隐藏]', digest: 'sha1:a3', hasSecret: true })
    const bare = memory({ id: 'a4', content: '没有版本的那条' })
    const { utils } = setup({ items: [target, secret, bare] })
    expect(within(row('部署 token [已隐藏]')).queryByRole('button', { name: '修改' })).toBeNull()
    expect(within(row('没有版本的那条')).queryByRole('button', { name: '修改' })).toBeNull()
    utils.unmount()
    setup({ items: [{ ...target, updatedAt: NOW - HOUR }], scope: { kind: 'all' } })
    expect(within(row()).getByRole('button', { name: '修改' })).toBeInTheDocument()
  })

  it('故事 2：点「修改」在这一行下展开面板，行尾按钮收起；默认停在「让模型改」', () => {
    setup()
    open()
    const li = row()
    expect(within(li).getByRole('tablist', { name: '修改方式' })).toBeInTheDocument()
    expect(within(li).getByRole('tab', { name: '让模型改' })).toHaveAttribute('aria-selected', 'true')
    expect(within(li).queryByRole('button', { name: '删除' })).toBeNull()
    expect(within(li).queryByRole('button', { name: '打开文件' })).toBeNull()
    expect(within(li).getByRole('textbox', { name: '想怎么改这条？' })).toBeInTheDocument()
    // 别的行照常
    expect(within(row('提交前跑 typecheck')).getByRole('button', { name: '修改' })).toBeInTheDocument()
    fireEvent.click(within(li).getByRole('button', { name: '取消' }))
    expect(within(row()).getByRole('button', { name: '修改' })).toBeInTheDocument()
  })

  it('故事 2：同一时刻只展开一个面板；没写东西时直接换过去', () => {
    setup()
    open()
    open(row('提交前跑 typecheck'))
    expect(screen.getAllByRole('tablist')).toHaveLength(1)
    expect(within(row('提交前跑 typecheck')).getByRole('tablist', { name: '修改方式' })).toBeInTheDocument()
    expect(within(row()).getByRole('button', { name: '修改' })).toBeInTheDocument()
  })

  it('故事 2：已展开的面板有没发出的输入时，换行前先原位问「放弃刚写的内容？」；取消留在原处，确认后再换', () => {
    setup()
    open()
    write('再短一点')
    open(row('提交前跑 typecheck'))
    const question = within(row('提交前跑 typecheck')).getByRole('group', { name: '放弃刚写的内容？' })
    expect(ask()).toHaveValue('再短一点')
    fireEvent.click(within(question).getByRole('button', { name: '取消' }))
    expect(within(row('提交前跑 typecheck')).queryByRole('group', { name: '放弃刚写的内容？' })).toBeNull()
    expect(ask()).toHaveValue('再短一点')
    open(row('提交前跑 typecheck'))
    fireEvent.click(within(within(row('提交前跑 typecheck')).getByRole('group', { name: '放弃刚写的内容？' })).getByRole('button', { name: '放弃' }))
    expect(screen.getAllByRole('tablist')).toHaveLength(1)
    expect(within(row('提交前跑 typecheck')).getByRole('tablist')).toBeInTheDocument()
    expect(ask()).toHaveValue('')
  })

  it('故事 2：已出稿没应用也算没保存的内容，换行前先问', async () => {
    setup()
    open()
    write('改成周四')
    await generate()
    open(row('提交前跑 typecheck'))
    expect(within(row('提交前跑 typecheck')).getByRole('group', { name: '放弃刚写的内容？' })).toBeInTheDocument()
  })

  it('故事 2a：选过手动改，下次在别的行打开也停在手动改（和待处理共用偏好）', () => {
    setup()
    open()
    fireEvent.click(screen.getByRole('tab', { name: '手动改' }))
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    open(row('提交前跑 typecheck'))
    expect(screen.getByRole('tab', { name: '手动改' })).toHaveAttribute('aria-selected', 'true')
    expect(localStorage.getItem(EDIT_MODE_STORAGE_KEY)).toBe('manual')
  })

  it('故事 2b：切换方式不丢输入；生成中切换控件置灰', async () => {
    setup({ respond: command => (command.cmd === 'draft-edit' ? new Promise<never>(() => {}) : { ok: true, cmd: command.cmd }) })
    open()
    write('改成周四')
    fireEvent.click(screen.getByRole('tab', { name: '手动改' }))
    fireEvent.click(screen.getByRole('tab', { name: '让模型改' }))
    expect(ask()).toHaveValue('改成周四')
    await generate()
    expect(screen.getByRole('tab', { name: '手动改' })).toBeDisabled()
  })

  it('故事 2c：手动改：正文预填，「更多」里是名称、摘要、标签；字数、说明；正文或名称为空时「保存」置灰', () => {
    localStorage.setItem(EDIT_MODE_STORAGE_KEY, 'manual')
    setup()
    open()
    const li = row()
    const content = within(li).getByRole('textbox', { name: '正文' })
    expect(content).toHaveValue('每周三发版，先跑测试再打包。')
    expect(within(li).getByText('直接改正文，保存后可以撤销。类型改不了：换类型要先删再记。')).toBeInTheDocument()
    expect(within(li).getByText('14 字 → 14 字')).toBeInTheDocument()
    fireEvent.click(within(li).getByRole('button', { name: /更多/ }))
    expect(within(li).getByRole('textbox', { name: '名称' })).toHaveValue('发版流程')
    expect(within(li).getByRole('textbox', { name: '摘要' })).toHaveValue('发版的节奏')
    expect(within(li).getByText('发版')).toBeInTheDocument()
    expect(within(li).getAllByRole('button').slice(-2).map(b => b.textContent)).toEqual(['取消', '保存'])
    fireEvent.change(content, { target: { value: '  ' } })
    expect(within(li).getByRole('button', { name: '保存' })).toHaveAttribute('aria-disabled', 'true')
  })

  it('故事 2d：手动改保存发 edit-memory（带层和打开时的版本），行内换成新内容、标「刚改」，结果行「已保存修改 · 撤销」', async () => {
    localStorage.setItem(EDIT_MODE_STORAGE_KEY, 'manual')
    const { commands } = setup()
    open()
    fireEvent.change(screen.getByRole('textbox', { name: '正文' }), { target: { value: '每周四发版。' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '保存' })) })
    expect(commands()).toEqual([{ cmd: 'edit-memory', memoryId: 'a1', layer: app, base, content: '每周四发版。', name: '发版流程', summary: '发版的节奏', tags: ['发版'] }])
    const li = row('每周四发版。')
    expect(within(li).queryByRole('tablist')).toBeNull()
    expect(within(li).getByText('刚改')).toHaveClass('pm-chip--neutral')
    expect(within(li).getByText('已保存修改')).toBeInTheDocument()
    expect(within(li).getByRole('button', { name: '撤销' })).toBeInTheDocument()
  })

  it('故事 3：标签「想怎么改这条？」，下面「常用写法（可选）」跟四个快捷意图，文本框有占位例句', () => {
    setup()
    open()
    const intents = screen.getByRole('group', { name: '常用写法（可选）' })
    expect(within(intents).getAllByRole('button').map(b => b.textContent)).toEqual(['压缩要点', '改清楚', '纠正内容', '补充信息'])
    expect(ask()).toHaveAttribute('placeholder', '也可以直接输入你的要求，例如：「每周三发版」已经不对了，现在改成每周四，以这个为准。')
  })

  it('故事 4：点快捷意图把模板填进文本框（替换原有内容），按钮按下，选中第一个「___」', () => {
    setup()
    open()
    write('原来写的')
    const intents = screen.getByRole('group', { name: '常用写法（可选）' })
    fireEvent.click(within(intents).getByRole('button', { name: '纠正内容' }))
    const box = ask() as HTMLTextAreaElement
    expect(box).toHaveValue('「___」已经不对了，现在是「___」，以这个为准。')
    expect(within(intents).getByRole('button', { name: '纠正内容' })).toHaveAttribute('aria-pressed', 'true')
    expect(box).toHaveFocus()
    expect([box.selectionStart, box.selectionEnd]).toEqual([1, 4])
    fireEvent.click(within(intents).getByRole('button', { name: '压缩要点' }))
    expect(box).toHaveValue('压缩成要点，保留 ___，可以删掉 ___。')
    expect([box.selectionStart, box.selectionEnd]).toEqual([9, 12])
    expect(within(intents).getByRole('button', { name: '纠正内容' })).toHaveAttribute('aria-pressed', 'false')
    expect(within(intents).getByRole('button', { name: '压缩要点' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(within(intents).getByRole('button', { name: '改清楚' }))
    expect(box).toHaveValue('「___」写得含糊，指的是 ___。')
    fireEvent.click(within(intents).getByRole('button', { name: '补充信息' }))
    expect(box).toHaveValue('补上：___（原文没有，按我写的加）。')
  })

  it('故事 5：要求必填：空着或只有空白时「生成修改」置灰并提示怎么开头；有内容就能发（留着「___」也行），不带建议类型', async () => {
    const { commands } = setup({ model: 'deepseek-v4-flash' })
    open()
    const button = () => screen.getByRole('button', { name: '生成修改' })
    expect(button()).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByText('先写要求，或从常用写法开个头')).toBeInTheDocument()
    write('   ')
    expect(button()).toHaveAttribute('aria-disabled', 'true')
    await generate()
    expect(commands()).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: '补充信息' }))
    expect(button()).not.toHaveAttribute('aria-disabled')
    expect(screen.getByText('用当前模型 deepseek-v4-flash 生成，先给你看结果再决定')).toBeInTheDocument()
    await generate()
    expect(commands()).toEqual([{ cmd: 'draft-edit', memories: [{ memoryId: 'a1', layer: app }], request: '补上：___（原文没有，按我写的加）。' }])
  })

  it('故事 6：面板说明写清模型只用原文和你写的信息', () => {
    setup()
    open()
    const note = screen.getByText('模型按原文和你的要求改写这条记忆，格式由它保持，比手动改文件稳妥。它只用你写的信息，不会自己补充。会消耗少量 token。')
    expect(note.closest('.pm-model-note')?.querySelector('svg')).not.toBeNull()
  })

  it('故事 7：生成中只锁这一行（别的行照常能点）；「停止」回到写要求，输入保留', async () => {
    setup({ respond: command => (command.cmd === 'draft-edit' ? new Promise<never>(() => {}) : { ok: true, cmd: command.cmd }) })
    open()
    write('改成周四')
    await generate()
    expect(within(row()).getByRole('status')).toHaveTextContent('正在生成修改……')
    const others = within(row('提交前跑 typecheck'))
    expect(others.getByRole('button', { name: '修改' })).not.toHaveAttribute('aria-disabled')
    expect(others.getByRole('button', { name: '删除' })).not.toHaveAttribute('aria-disabled')
    fireEvent.click(screen.getByRole('button', { name: '停止' }))
    expect(ask()).toHaveValue('改成周四')
  })

  it('故事 8：出稿后左右对照、字数变化，「放弃 · 再改改 · 应用」；再改改带上一稿和此前的要求', async () => {
    const { commands } = setup()
    open()
    write('「每周三发版」已经不对了，现在是「每周四」，以这个为准。')
    await generate()
    expect(screen.getByRole('region', { name: '原文' }).querySelector('del')).toHaveTextContent('三')
    expect(screen.getByRole('region', { name: '改后' }).querySelector('ins')).toHaveTextContent('四')
    expect(document.querySelector('.pm-model-stat')).toHaveTextContent('14 字 → 14 字')
    expect(within(row()).getAllByRole('button').slice(-3).map(b => b.textContent)).toEqual(['放弃', '再改改', '应用'])
    fireEvent.click(screen.getByRole('button', { name: '再改改' }))
    expect(ask()).toHaveValue('')
    write('再短一点')
    await generate()
    expect(commands().at(-1)).toEqual({
      cmd: 'draft-edit', memories: [{ memoryId: 'a1', layer: app }], request: '再短一点',
      priorRequests: ['「每周三发版」已经不对了，现在是「每周四」，以这个为准。'],
      previous: { content: '每周四发版，先跑测试再打包。', summary: '发版的节奏', name: '发版流程', tags: ['发版'] },
    })
  })

  it('故事 9：应用发 edit-memory；行内换成新内容、高亮一次、标「刚改」（中性胶囊），结果行「已按你的要求改写这条 · 撤销」；撤销发 undo，结果行和「刚改」都收起', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { gateway, commands } = setup()
    open()
    write('改成周四')
    await generate()
    await apply()
    expect(commands().at(-1)).toEqual({ cmd: 'edit-memory', memoryId: 'a1', layer: app, base, content: '每周四发版，先跑测试再打包。', name: '发版流程', summary: '发版的节奏', tags: ['发版'] })
    // 视图还没推来：先按应用的稿子画
    const li = row('每周四发版，先跑测试再打包。')
    expect(li).toHaveClass('pm-flash')
    expect(within(li).getByText('刚改')).toHaveClass('pm-chip--neutral')
    expect(within(li).getByText('已按你的要求改写这条')).toBeInTheDocument()
    act(() => { vi.advanceTimersByTime(FLASH_MS) })
    expect(row('每周四发版，先跑测试再打包。')).not.toHaveClass('pm-flash')
    // 视图推来新版本：照视图画
    act(() => { gateway.setView('library', view([{ ...target, content: '每周四发版，先跑测试再打包。', updatedAt: 333, digest: 'sha1:a1b' }, other])) })
    expect(within(row('每周四发版，先跑测试再打包。')).getByText('刚改')).toBeInTheDocument()

    await act(async () => { fireEvent.click(within(row('每周四发版，先跑测试再打包。')).getByRole('button', { name: '撤销' })) })
    expect(commands().at(-1)).toEqual({ cmd: 'undo', decisionId: 'pd_e' })
    act(() => { gateway.setView('library', view()) })
    expect(within(row()).queryByText('已按你的要求改写这条')).toBeNull()
    expect(within(row()).queryByText('刚改')).toBeNull()
  })

  it('故事 9：结果行在展开别的面板后收起（「刚改」留着）；撤销被拒时写明原因', async () => {
    const { gateway } = setup({ respond: command => (command.cmd === 'undo' ? { ok: false, cmd: 'undo', code: 'stale' } : respondWith()(command)) })
    open()
    write('改成周四')
    await generate()
    await apply()
    act(() => { gateway.setView('library', view([{ ...target, content: '每周四发版，先跑测试再打包。', updatedAt: 333, digest: 'sha1:a1b' }, other])) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '撤销' })) })
    expect(within(row('每周四发版，先跑测试再打包。')).getByRole('alert')).toHaveTextContent('这条记忆之后又被改过')
    open(row('提交前跑 typecheck'))
    expect(screen.queryByText('已按你的要求改写这条')).toBeNull()
    expect(screen.queryByRole('button', { name: '撤销' })).toBeNull()
    expect(within(row('每周四发版，先跑测试再打包。')).getByText('刚改')).toBeInTheDocument()
  })

  it('故事 10：要求里有高危密钥：不发送，面板里写明原因', async () => {
    const { commands } = setup()
    open()
    write(`把 ${critical} 删掉`)
    await generate()
    expect(commands()).toEqual([])
    expect(screen.getByRole('alert')).toHaveTextContent('要求里有高危密钥，没有发送。去掉密钥再生成。')
  })

  it('故事 11：应用时这条已被别处改过（stale）：面板关闭，行内换成最新内容，结果行提示重新打开', async () => {
    const { gateway } = setup({ respond: command => (command.cmd === 'edit-memory' ? { ok: false, cmd: 'edit-memory', code: 'stale' } : respondWith()(command)) })
    open()
    write('改成周四')
    await generate()
    await apply()
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(within(row()).getByText('这条刚被改过，已换成最新内容。要改请重新打开。')).toBeInTheDocument()
    expect(within(row()).queryByRole('button', { name: '撤销' })).toBeNull()
    expect(within(row()).queryByText('刚改')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    act(() => { gateway.setView('library', view([{ ...target, content: '每周五发版。', updatedAt: 444, digest: 'sha1:a1c' }, other])) })
    expect(within(row('每周五发版。')).getByText('这条刚被改过，已换成最新内容。要改请重新打开。')).toBeInTheDocument()
  })

  it('故事 12：改后稿像密钥（secret-suspected）：原位确认后带 force 重发', async () => {
    const { commands } = setup({ respond: command => (command.cmd === 'edit-memory' && command.force !== true ? { ok: false, cmd: 'edit-memory', code: 'secret-suspected' } : respondWith()(command)) })
    open()
    write('改成周四')
    await generate()
    await apply()
    const confirm = within(row()).getByRole('group', { name: '仍然保存' })
    expect(confirm).toHaveTextContent('内容里有像密钥的片段。确定不是密钥再保存。')
    await act(async () => { fireEvent.click(within(confirm).getByRole('button', { name: '仍然保存' })) })
    expect(commands().filter(c => c.cmd === 'edit-memory').map(c => c.cmd === 'edit-memory' && c.force)).toEqual([undefined, true])
    expect(within(row('每周四发版，先跑测试再打包。')).getByText('已按你的要求改写这条')).toBeInTheDocument()
  })

  it('故事 12：改后稿含高危密钥：发出前拦下，不保存', async () => {
    const { commands } = setup({ respond: respondWith({ content: `部署用 ${critical}` }) })
    open()
    write('加上部署 token')
    await generate()
    await apply()
    expect(commands().map(c => c.cmd)).toEqual(['draft-edit'])
    expect(within(row()).getByRole('alert')).toHaveTextContent('内容里有高危密钥，没有保存。')
  })
})

describe('类型显示名', () => {
  const config = { snapshotTokenBudget: 4000, snapshotOverflow: 'relax', governanceEnabled: true, globalPromoteTarget: 'plugin-global', accent: 'ella' } as const

  it('PA-20：改过名的预设类型显示配置里的名字（和右侧栏、设置页同名）', () => {
    const view = library({ layers: [{ layer: app, items: [memory({ id: 'c1', type: 'procedure', content: '发版先跑全量测试' })] }], typeOrder: ['procedure'], typeLabels: { procedure: '可复用流程' } })
    renderInShell(<LibraryTab nav={createNavStore()} scope={app} session={session} now={NOW} />,
      createFakeGateway({ views: { library: view }, config: { ...config, customTypes: { procedure: { label: '发版手册' } } } }))
    expect(screen.getAllByRole('heading', { level: 3 }).map(h => h.textContent)).toEqual(['发版手册1'])
  })

  it('PA-20：英文界面下内置、退役类型都写英文名，不用视图里的中文名', () => {
    render(<PanelShell gateway={createFakeGateway({ views: { library: typed() } })} t={createTranslator(en)}><LibraryTab nav={createNavStore()} scope={app} session={session} now={NOW} /></PanelShell>)
    expect(screen.getAllByRole('heading', { level: 3 }).map(h => h.textContent)).toEqual(['Preference1', 'Facts & lessons5', 'Person1'])
  })

  it('配置里没有、也不是内置类型（切模板前的旧类型）：用视图里的名字，再没有显示 id', () => {
    const view = library({ layers: [{ layer: app, items: [memory({ id: 'x1', type: 'term' }), memory({ id: 'x2', type: 'mystery' })] }], typeOrder: ['term', 'mystery'], typeLabels: { term: '术语' } })
    renderInShell(<LibraryTab nav={createNavStore()} scope={app} session={session} now={NOW} />, createFakeGateway({ views: { library: view } }))
    expect(screen.getAllByRole('heading', { level: 3 }).map(h => h.textContent)).toEqual(['术语1', 'mystery1'])
  })
})
