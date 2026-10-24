// 右侧栏 tab 的宿主注册：tab 类型（含一条「开始」页入口）包在 effect 里，正文与标题按类型 id 进插槽，openTab 按 kind 打开。
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { ComponentType } from 'react'
import type { HostContext, SessionStandardProps, SidebarHost, SidebarTabDefinition } from '../host.ts'
import { createTranslator } from '../i18n.tsx'
import { zh } from '../locales.ts'
import { createNavStore, SIDEBAR_TAB_ID, SIDEBAR_TAB_KIND } from '../nav.ts'
import { openMemoryTab, registerSidebarTab } from './register.tsx'

function setup() {
  const t = createTranslator(zh)
  const slots: Array<{ name: string; key?: string; component: ComponentType<never> }> = []
  const definitions: SidebarTabDefinition[] = []
  const effects: string[] = []
  const ctx: HostContext & SidebarHost = {
    inject: () => () => {},
    slots: {
      inject: (_name, fn) => { fn(); return () => {} },
      register: (options, component) => { slots.push({ name: options.name, key: options.key, component: component as ComponentType<never> }); return () => {} },
    },
    locale: { register: vi.fn(), bind: () => t as (key: string) => string, getSnapshot: () => 0, subscribe: () => () => {} },
    effect: (fn, label) => { effects.push(label ?? ''); fn() },
    sidebarRightTabs: { register: vi.fn((definition: SidebarTabDefinition) => { definitions.push(definition); return () => {} }) },
    sidebarRight: { openTab: vi.fn() },
    layout: { selectPanel: vi.fn() },
    pluginNavigation: { openBundle: vi.fn() },
    remote: {
      commands: { execute: vi.fn(async () => ({ ok: false as const, error: { code: 'x', message: 'x' } })) },
      workspaceFiles: { read: vi.fn() },
      session: { openWorkspacePath: vi.fn() },
    },
  }
  registerSidebarTab(ctx, createNavStore(), () => t)
  return { ctx, slots, definitions, effects }
}

describe('registerSidebarTab', () => {
  it('登记页面类 tab 类型（不认地址），包在插件自己的 effect 里；「开始」页一条入口', () => {
    const { definitions, effects } = setup()
    expect(effects).toEqual(['plastic-memory: sidebar tab type'])
    expect(definitions).toHaveLength(1)
    const def = definitions[0]!
    expect(def).toMatchObject({ id: SIDEBAR_TAB_ID, kind: SIDEBAR_TAB_KIND })
    expect(def).not.toHaveProperty('patterns')
    expect(def.title('')).toBe('记忆')
    expect(def.guide).toHaveLength(1)
    expect(def.guide![0]).toMatchObject({ id: 'memory', order: 40 })
    expect(def.guide![0]!.title()).toBe('记忆')
    expect(def.guide![0]!.description?.()).toBe('这次对话带入和新记的记忆')
    expect(def.guide![0]!.icon).toBeDefined()
  })

  it('正文与标题按类型 id 进 sidebar.right.pane.tab / .title', () => {
    const { slots } = setup()
    expect(slots.map(s => [s.name, s.key])).toEqual([
      ['sidebar.right.pane.tab', SIDEBAR_TAB_ID],
      ['sidebar.right.pane.tab.title', SIDEBAR_TAB_ID],
    ])
    const Title = slots[1]!.component as ComponentType<Record<string, never>>
    render(<Title />)
    expect(screen.getByText('记忆')).toBeInTheDocument()
  })

  it('正文接宿主会话插槽 props 能渲染（tab 根节点占满高度）', () => {
    const { slots } = setup()
    const Body = slots[0]!.component as ComponentType<SessionStandardProps>
    const { container } = render(
      <Body
        sessionId="s1"
        useSessions={selector => selector({ ids: ['s1'], byId: { s1: { id: 's1', displayTitle: 's1', running: true, cwd: '/w/app', updatedAt: 1, retainedBy: {} } }, phase: 'ready' })}
        useResource={() => ({ status: 'none', value: undefined, failure: undefined })}
        useProjection={() => undefined}
      />,
    )
    expect(container.querySelector('.pm-root.pm-side-root .pm-side')).not.toBeNull()
  })

  it('openMemoryTab 按 kind 走 sidebarRight.openTab', () => {
    const { ctx } = setup()
    openMemoryTab(ctx)
    expect(ctx.sidebarRight.openTab).toHaveBeenCalledWith(SIDEBAR_TAB_KIND)
  })
})
