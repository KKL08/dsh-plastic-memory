// 设置页注册：等 configForms 就位后按包名注册 plugins.bundle.config，组件自己按 entryId 取表单；入口经导航 store 直达记忆页。
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { ComponentType } from 'react'
import { createHostGateway } from '../gateway.ts'
import type { HostContext, RootStandardProps } from '../host.ts'
import { createTranslator } from '../i18n.tsx'
import { zh } from '../locales.ts'
import { createNavStore, PANEL_ID } from '../nav.ts'
import { createFakeConfigForm } from './config-form.fake.ts'
import { applySettings, type ConfigFormsService } from './index.tsx'

type CardProps = RootStandardProps & { view?: 'summary' | 'page' }

function setup(withConfigForms = true) {
  const registered: Array<{ options: { name: string; key?: string }; component: ComponentType<CardProps> }> = []
  const form = createFakeConfigForm()
  const configForms: ConfigFormsService = { get: vi.fn(() => form) }
  const selectPanel = vi.fn()
  const ctx = {
    slots: {
      inject: (_name: string, fn: () => void) => { fn(); return () => {} },
      register: (options: { name: string; key?: string }, component: ComponentType<CardProps>) => { registered.push({ options, component }); return () => {} },
    },
    locale: { register: vi.fn(), bind: () => createTranslator(zh) as (key: string) => string, getSnapshot: () => 0, subscribe: () => () => {} },
    layout: { selectPanel },
    remote: {
      commands: { execute: vi.fn(async () => ({ ok: false as const, error: { code: 'x', message: 'x' } })) },
      workspaceFiles: { read: vi.fn() },
    },
    inject: (deps: string[], fn: (scope: unknown) => void) => { expect(deps).toEqual(['configForms']); fn(withConfigForms ? { ...ctx, configForms } : ctx) },
  } as unknown as HostContext
  const nav = createNavStore()
  applySettings(ctx, nav, createHostGateway(ctx), () => createTranslator(zh))
  return { registered, configForms, selectPanel, nav }
}

const props: RootStandardProps = {
  useSessions: selector => selector({ ids: [], byId: {}, phase: 'ready' }),
  useResource: () => ({ status: 'none', value: undefined, failure: undefined }),
}

describe('applySettings', () => {
  it('按包名注册 plugins.bundle.config，组件取 entryId = plastic-memory 的表单', () => {
    const { registered, configForms } = setup()
    expect(registered.map(r => r.options)).toEqual([{ name: 'plugins.bundle.config', key: 'dsh-plastic-memory' }])
    const Card = registered[0]!.component
    render(<Card {...props} view="page" />)
    expect(configForms.get).toHaveBeenCalledWith('plastic-memory')
    expect(screen.getByRole('heading', { name: '记什么' })).toBeInTheDocument()
  })

  it('只渲染 page 视图', () => {
    const Card = setup().registered[0]!.component
    const { container } = render(<Card {...props} view="summary" />)
    expect(container).toBeEmptyDOMElement()
  })

  it('最近删除入口先写导航目标再切到记忆页', () => {
    const { registered, selectPanel, nav } = setup()
    const Card = registered[0]!.component
    render(<Card {...props} view="page" />)
    fireEvent.click(screen.getByRole('button', { name: '查看最近删除 ›' }))
    expect(nav.get()).toEqual({ tab: 'deleted' })
    expect(selectPanel).toHaveBeenCalledWith(PANEL_ID)
  })

  it('状态卡「打开记忆页 ›」（入口⑤）：先写导航目标（读不到视图时落待处理）再切到记忆页', () => {
    const { registered, selectPanel, nav } = setup()
    const Card = registered[0]!.component
    render(<Card {...props} view="page" />)
    fireEvent.click(screen.getByRole('button', { name: '打开记忆页 ›' }))
    expect(nav.get()).toEqual({ tab: 'pending' })
    expect(selectPanel).toHaveBeenCalledWith(PANEL_ID)
  })

  it('宿主不提供 configForms 时不注册', () => {
    expect(setup(false).registered).toEqual([])
  })
})
