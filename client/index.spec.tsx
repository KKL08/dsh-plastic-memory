// 面板注册壳：apply 注册双语字典、左栏图标与记忆页；记忆页挂在宿主标准 props 上能渲染出两态。
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ComponentType } from 'react'
import { apply, inject, PACKAGE_NAME } from './index.tsx'
import type { RootStandardProps, SessionListState, SessionStandardProps } from './host.ts'
import { createTranslator } from './i18n.tsx'
import { en, NS, zh } from './locales.ts'
import { PANEL_ID } from './nav.ts'
import { createFakeConfigForm } from './settings/config-form.fake.ts'
import { fakeHostContext } from './test-utils.tsx'

function setup(overrides: Parameters<typeof fakeHostContext>[0] = {}) {
  const registered: Array<{ options: { name: string; id?: string; key?: string; label?: string | (() => string) }; component: ComponentType<never> }> = []
  const register = vi.fn()
  const ctx = fakeHostContext({
    configForms: { get: () => createFakeConfigForm() },
    slots: {
      inject: (_name, fn) => { fn(); return () => {} },
      register: (options, component) => { registered.push({ options, component: component as ComponentType<never> }); return () => {} },
    },
    locale: { register, bind: () => createTranslator(zh) as (key: string) => string, getSnapshot: () => 0, subscribe: () => () => {} },
    ...overrides,
  })
  apply(ctx)
  return { ctx, registered, register }
}

const props = (state: SessionListState): RootStandardProps => ({
  useSessions: selector => selector(state),
  useResource: () => ({ status: 'none', value: undefined, failure: undefined }),
})

describe('apply', () => {
  it('依赖 locale 与 layout；注册命名空间的中英字典', () => {
    expect(inject).toEqual(expect.arrayContaining(['slots', 'locale', 'layout', 'remote.commands', 'remote.workspaceFiles', 'remote.session']))
    const { register } = setup()
    expect(register).toHaveBeenCalledWith(NS, { zh, en })
  })

  it('右侧栏、插件页导航、配置表单是可选服务，不进 inject（缺了插件照常加载）', () => {
    for (const service of ['sidebarRight', 'sidebarRightTabs', 'pluginNavigation', 'configForms']) expect(inject).not.toContain(service)
  })

  it('宿主有插件页导航：记忆页页头「设置」跳插件页里本插件的详情', () => {
    const { registered, ctx } = setup()
    const Page = registered.find(r => r.options.name === 'main')!.component as ComponentType<RootStandardProps>
    render(<Page {...props({ ids: ['s1'], byId: { s1: { id: 's1', displayTitle: 's1', running: false, updatedAt: 1, retainedBy: {} } }, phase: 'ready' })} />)
    fireEvent.click(screen.getByRole('button', { name: '设置' }))
    expect(ctx.pluginNavigation!.openBundle).toHaveBeenCalledWith(PACKAGE_NAME)
  })

  it('宿主缺可选服务：记忆页照常注册，不注册右侧栏 tab 与设置页，也不画「设置」', () => {
    const { registered } = setup({ sidebarRight: undefined, sidebarRightTabs: undefined, pluginNavigation: undefined, configForms: undefined })
    expect(registered.map(r => r.options.name)).toEqual(expect.arrayContaining(['main', 'sidebar.panellist', 'conversation.composer.dock']))
    expect(registered.map(r => r.options.name)).not.toContain('sidebar.right.pane.tab')
    expect(registered.map(r => r.options.name)).not.toContain('plugins.bundle.config')
    const Page = registered.find(r => r.options.name === 'main')!.component as ComponentType<RootStandardProps>
    render(<Page {...props({ ids: ['s1'], byId: { s1: { id: 's1', displayTitle: 's1', running: false, updatedAt: 1, retainedBy: {} } }, phase: 'ready' })} />)
    expect(screen.getAllByRole('tab')).toHaveLength(4)
    expect(screen.queryByRole('button', { name: '设置' })).toBeNull()
  })

  it('左栏图标与记忆页同 id，图标名称走 locale', () => {
    const { registered } = setup()
    const icon = registered.find(r => r.options.name === 'sidebar.panellist')!
    const page = registered.find(r => r.options.name === 'main')!
    expect(icon.options.id).toBe(PANEL_ID)
    expect(page.options.key).toBe(PANEL_ID)
    expect((icon.options.label as () => string)()).toBe('记忆')
  })

  it('记忆页接宿主 props：没有会话显示空态，有会话显示 tab', () => {
    const { registered } = setup()
    const Page = registered.find(r => r.options.name === 'main')!.component as ComponentType<RootStandardProps>
    const { unmount } = render(<Page {...props({ ids: [], byId: {}, phase: 'ready' })} />)
    expect(screen.getByText('开一个会话后这里可用')).toBeInTheDocument()
    unmount()
    render(<Page {...props({ ids: ['s1'], byId: { s1: { id: 's1', displayTitle: 's1', running: false, updatedAt: 1, retainedBy: {} } }, phase: 'ready' })} />)
    expect(screen.getAllByRole('tab')).toHaveLength(4)
  })

  it('左栏图标接宿主 {size, active} + 根作用域 props；没有会话时只画图标、不亮点', () => {
    const { registered } = setup()
    const Icon = registered.find(r => r.options.name === 'sidebar.panellist')!.component as ComponentType<RootStandardProps & { size: number; active: boolean }>
    const { container } = render(<Icon {...props({ ids: [], byId: {}, phase: 'ready' })} size={18} active={false} />)
    const svg = container.querySelector('svg')!
    expect(svg).toHaveAttribute('width', '18')
    expect(svg).not.toHaveAttribute('data-marker')
  })

  it('左栏图标与记忆页共用一个网关：借会话要 memoryRoot 只发一次 info', () => {
    localStorage.clear()
    const { registered, ctx } = setup()
    const Icon = registered.find(r => r.options.name === 'sidebar.panellist')!.component as ComponentType<RootStandardProps & { size: number; active: boolean }>
    const Page = registered.find(r => r.options.name === 'main')!.component as ComponentType<RootStandardProps>
    const state: SessionListState = { ids: ['s1'], byId: { s1: { id: 's1', displayTitle: 's1', running: true, updatedAt: 1, retainedBy: {} } }, phase: 'ready' }
    const infoCalls = () => vi.mocked(ctx.remote.commands.execute).mock.calls.filter(([, line]) => line === '/memory info')
    // 图标自己就要读待处理视图
    const icon = render(<Icon {...props(state)} size={18} active={false} />)
    expect(infoCalls()).toHaveLength(1)
    icon.unmount()
    render(<><Icon {...props(state)} size={18} active /><Page {...props(state)} /></>)
    expect(infoCalls()).toHaveLength(1)
  })

  it('记忆页、输入框按钮、右侧栏 tab、设置页共用一个网关：一次页面加载只发一次 info 和一次 refresh-views', async () => {
    localStorage.clear()
    const { registered, ctx } = setup()
    const info = JSON.stringify({ ok: true, cmd: 'info', info: { memoryRoot: '/home/me/.dsh/memories', viewDir: '/home/me/.dsh/memories/.state/gui', views: { pending: '', health: '', library: '', deleted: '' }, version: 1 } })
    vi.mocked(ctx.remote.commands.execute).mockImplementation(async (_sid, line) => ({
      ok: true as const,
      value: { commandId: 'c', result: { kind: 'success' as const, text: line === '/memory info' ? info : JSON.stringify({ ok: true, cmd: line.split(' ')[1] }) } },
    }))
    const component = <P,>(name: string) => registered.find(r => r.options.name === name)!.component as ComponentType<P>
    const Page = component<RootStandardProps>('main')
    const Dock = component<SessionStandardProps>('conversation.composer.dock')
    const Side = component<SessionStandardProps>('sidebar.right.pane.tab')
    const Settings = component<RootStandardProps & { view: 'page' }>('plugins.bundle.config')
    const state: SessionListState = { ids: ['s1'], byId: { s1: { id: 's1', displayTitle: 's1', running: true, cwd: '/w/app', updatedAt: 1, retainedBy: { mainView: 1 } } }, phase: 'ready' }
    const session = { ...props(state), sessionId: 's1', useProjection: () => undefined }
    render(<><Page {...props(state)} /><Dock {...session} /><Side {...session} /><Settings {...props(state)} view="page" /></>)
    await waitFor(() => expect(vi.mocked(ctx.remote.commands.execute).mock.calls.map(([, line]) => line)).toEqual(['/memory info', '/memory refresh-views']))
  })
})
