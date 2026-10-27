// 设置页注册：等 configForms 就位后按包名注册 plugins.bundle.config，组件自己按 entryId 取表单；入口经导航 store 直达记忆页。
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { ComponentType } from 'react'
import { createHostGateway } from '../gateway.ts'
import type { RootStandardProps } from '../host.ts'
import { createTranslator } from '../i18n.tsx'
import { zh } from '../locales.ts'
import { createNavStore, PANEL_ID } from '../nav.ts'
import { fakeHostContext } from '../test-utils.tsx'
import { createFakeConfigForm } from './config-form.fake.ts'
import { applySettings, type ConfigFormsService } from './index.tsx'

type CardProps = RootStandardProps & { view?: 'summary' | 'page' }

function setup(withConfigForms = true) {
  const registered: Array<{ options: { name: string; key?: string }; component: ComponentType<CardProps> }> = []
  const form = createFakeConfigForm()
  const configForms: ConfigFormsService = { get: vi.fn(() => form) }
  const selectPanel = vi.fn()
  const ctx = fakeHostContext({
    ...(withConfigForms ? { configForms } : {}),
    slots: {
      inject: (_name, fn) => { fn(); return () => {} },
      register: (options, component) => { registered.push({ options, component: component as ComponentType<CardProps> }); return () => {} },
    },
    layout: { selectPanel },
  })
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
    expect(nav.get()).toEqual({ view: 'deleted' })
    expect(selectPanel).toHaveBeenCalledWith(PANEL_ID)
  })

  it('状态卡「打开记忆页 ›」（入口⑤）：先写导航目标（「全部」的处理视图）再切到记忆页', () => {
    const { registered, selectPanel, nav } = setup()
    const Card = registered[0]!.component
    render(<Card {...props} view="page" />)
    fireEvent.click(screen.getByRole('button', { name: '打开记忆页 ›' }))
    expect(nav.get()).toEqual({ view: 'todo', scope: { kind: 'all' } })
    expect(selectPanel).toHaveBeenCalledWith(PANEL_ID)
  })

  it('宿主不提供 configForms 时不注册', () => {
    expect(setup(false).registered).toEqual([])
  })
})
