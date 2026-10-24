// 左栏图标的圆点：读待处理视图的 dot（服务端已按「读不出的文件不亮点、密钥盖过琥珀」算好），处理完视图更新就撤掉。
import { describe, expect, it } from 'vitest'
import { act, render } from '@testing-library/react'
import { GUI_VIEW_VERSION, type PendingView } from '../src/gui/contract.ts'
import { createFakeGateway } from './gateway.fake.ts'
import { GatewayProvider } from './gateway.ts'
import { NavIcon } from './NavIcon.tsx'
import { memory } from './test-utils.tsx'

const promote = { kind: 'promote-candidate', decisionId: 'd1', firstSeenAt: 1, memory: memory() } as const
const pending = (dot: PendingView['dot'], items: PendingView['items'] = dot === 'none' ? [] : [promote]): PendingView =>
  ({ version: GUI_VIEW_VERSION, dot, items, typeLabels: {} })

function setup(view: PendingView | undefined, session: 'ready' | 'none' = 'ready') {
  const gateway = createFakeGateway({
    ...(session === 'none' ? { session: { kind: 'none' } } : {}),
    ...(view !== undefined ? { views: { pending: view } } : {}),
  })
  const utils = render(<GatewayProvider value={gateway}><NavIcon size={18} active={false} /></GatewayProvider>)
  const marker = () => utils.container.querySelector('svg')?.getAttribute('data-marker') ?? null
  return { ...utils, gateway, marker }
}

describe('左栏图标圆点', () => {
  it('图标是设计稿定的鲸尾出水线稿：尾叶、尾柄、水波三笔', () => {
    const { container } = setup(undefined)
    const paths = [...container.querySelectorAll('path')].map(el => el.getAttribute('d') ?? '')
    expect(paths).toHaveLength(3)
    expect(paths[0]).toMatch(/^M12 13\.2C/)
    expect(paths[1]).toBe('M12 12v4.3')
    expect(paths[2]).toMatch(/^M3\.5 18\.3/)
  })

  it('有等你决定的条目：琥珀圆点，图标线条在圆点处被 mask 挖空', () => {
    const { container, marker } = setup(pending('amber'))
    expect(marker()).toBe('pending')
    expect(container.querySelector('.pm-nav-dot')).not.toBeNull()
    const mask = container.querySelector('mask')
    expect(mask).not.toBeNull()
    expect(container.querySelector('g[mask]')?.getAttribute('mask')).toBe(`url(#${mask!.id})`)
  })

  it('有密钥：红色小三角盖过琥珀点', () => {
    const { container, marker } = setup(pending('red', [{ kind: 'secret', memory: memory() }, promote]))
    expect(marker()).toBe('secret')
    expect(container.querySelector('.pm-nav-secret')).not.toBeNull()
    expect(container.querySelector('.pm-nav-dot')).toBeNull()
  })

  it('只有读不出的文件（dot = none）、视图没就绪、没有会话：都不亮点，也不挖洞', () => {
    const unreadable = { kind: 'unreadable-file', layer: { kind: 'global' }, filePath: '/m/x.md', relativePath: 'x.md', error: 'bad' } as const
    for (const { container, marker, unmount } of [setup(pending('none', [unreadable])), setup(undefined), setup(pending('amber'), 'none')]) {
      expect(marker()).toBeNull()
      expect(container.querySelector('mask')).toBeNull()
      unmount()
    }
  })

  it('裁决 / 忽略后视图更新，圆点撤掉', () => {
    const { gateway, marker } = setup(pending('amber'))
    expect(marker()).toBe('pending')
    act(() => { gateway.setView('pending', pending('none')) })
    expect(marker()).toBeNull()
  })

  it('借会话不限项目：待处理视图覆盖全部层', () => {
    const { gateway } = setup(pending('amber'))
    expect(gateway.sessionRequests.at(-1)).toBeUndefined()
  })
})
