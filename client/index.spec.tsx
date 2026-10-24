// 面板注册壳：apply 注册双语字典、左栏图标与记忆页；记忆页挂在宿主标准 props 上能渲染出两态。
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { ComponentType } from 'react'
import { apply, inject } from './index.tsx'
import type { HostContext, RootStandardProps, SessionListState } from './host.ts'
import { createTranslator } from './i18n.tsx'
import { en, NS, zh } from './locales.ts'
import { PANEL_ID } from './nav.ts'

function setup() {
  const registered: Array<{ options: { name: string; id?: string; key?: string; label?: string | (() => string) }; component: ComponentType<never> }> = []
  const register = vi.fn()
  const ctx: HostContext = {
    inject: () => () => {},
    slots: {
      inject: (_name, fn) => { fn(); return () => {} },
      register: (options, component) => { registered.push({ options, component: component as ComponentType<never> }); return () => {} },
    },
    locale: { register, bind: () => createTranslator(zh) as (key: string) => string, getSnapshot: () => 0, subscribe: () => () => {} },
    layout: { selectPanel: vi.fn() },
    sidebarRight: { openTab: vi.fn() },
    pluginNavigation: { openBundle: vi.fn() },
    remote: {
      commands: { execute: vi.fn(async () => ({ ok: false as const, error: { code: 'x', message: 'x' } })) },
      workspaceFiles: { read: vi.fn() },
      session: { openWorkspacePath: vi.fn() },
    },
  }
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

  it('依赖 pluginNavigation（「去设置里打开 ›」跳插件页）', () => {
    expect(inject).toContain('pluginNavigation')
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
})
