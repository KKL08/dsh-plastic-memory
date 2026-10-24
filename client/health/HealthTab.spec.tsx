// 健康 tab：按层三段（分数与结论、问题、上次体检时间）、密钥不打分、超限列为问题不扣分、从没体检过、体检关闭。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, within } from '@testing-library/react'
import { GUI_VIEW_VERSION, type HealthView, type PendingView } from '../../src/gui/contract.ts'
import { createFakeGateway } from '../gateway.fake.ts'
import { createNavStore } from '../nav.ts'
import { memory, NOW, renderInShell } from '../test-utils.tsx'
import { HealthTab } from './HealthTab.tsx'

const WS = { kind: 'workspace', workspacePath: '/w/app' } as const
const session = { kind: 'ready', sessionId: 's1', cwd: '/w/app' } as const
type Layer = HealthView['layers'][number]

const layer = (overrides: Partial<Layer> = {}): Layer => ({
  layer: WS, totalMemories: 12, score: 86, tier: 'green', gate: { secret: false },
  issues: [], staleCount: 0, semanticCachedAt: new Date(2026, 9, 15).getTime(), overflow: null,
  ...overrides,
})
const health = (layers: Layer[], governanceEnabled = true): HealthView => ({ version: GUI_VIEW_VERSION, governanceEnabled, layers })

function renderTab(view: HealthView, opts: { scope?: typeof WS | { kind: 'global' }; pending?: PendingView; openSettings?: () => void } = {}) {
  const gateway = createFakeGateway({ session, views: { health: view, ...(opts.pending ? { pending: opts.pending } : {}) } })
  const nav = createNavStore(undefined, { openSettings: opts.openSettings ?? (() => {}) })
  return renderInShell(<HealthTab session={session} scope={opts.scope ?? WS} nav={nav} />, gateway)
}

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW) })
afterEach(() => { vi.useRealTimers() })

describe('健康 tab', () => {
  it('按层三段：结论行写条数、分数与结论词，下一行上次体检时间，下面是问题；看项目时本项目在前、全局在后', () => {
    renderTab(health([
      layer({ issues: [{ type: 'expired', count: 1 }, { type: 'conflict', count: 2 }], staleCount: 3 }),
      layer({ layer: { kind: 'global' }, totalMemories: 4, score: 62, tier: 'amber' }),
    ]))
    const [ws, global] = screen.getAllByRole('region')
    expect(ws).toHaveAccessibleName('本项目')
    expect(ws).toHaveTextContent('本项目·12 条·86 分·良好')
    expect(ws).toHaveTextContent('上次体检：10 月 15 日')
    expect(within(ws!).getAllByRole('listitem').map(li => li.textContent)).toEqual([
      '已过有效期 1 条', '记忆冲突 2 条', '很久没确认、可能过时 3 条，带进对话时会标注',
    ])
    expect(global).toHaveAccessibleName('全局')
    expect(global).toHaveTextContent('全局·4 条·62 分·需要留意')
    expect(global).toHaveTextContent('没有发现问题')
    expect(screen.queryByText('内容检查还没做过')).toBeNull()
  })

  it('看全局时只列全局层；本项目不在视图里时写还没有记忆', () => {
    const { unmount } = renderTab(health([layer(), layer({ layer: { kind: 'global' } })]), { scope: { kind: 'global' } })
    expect(screen.getAllByRole('region').map(r => r.getAttribute('aria-label'))).toEqual(['全局'])
    unmount()
    renderTab(health([layer({ layer: { kind: 'global' } })]))
    expect(screen.getByRole('region', { name: '本项目' })).toHaveTextContent('本项目还没有记忆。')
  })

  it('有密钥的层不打分，写原因；超出上限列为问题、不扣分', () => {
    renderTab(health([
      layer({ score: null, tier: 'red', gate: { secret: true }, issues: [{ type: 'secret', count: 1 }] }),
      layer({ layer: { kind: 'global' }, overflow: { mode: 'relax', tier: 2 } }),
    ]))
    const ws = screen.getByRole('region', { name: '本项目' })
    expect(ws).toHaveTextContent('本项目·12 条·有密钥，先处理它再看分数')
    expect(ws).not.toHaveTextContent('分·')
    expect(ws.querySelector('.pm-marker--secret')).not.toBeNull()
    expect(within(ws).getByRole('listitem')).toHaveTextContent('密钥（厂商格式） 1 条')
    const global = screen.getByRole('region', { name: '全局' })
    expect(global).toHaveTextContent('86 分')
    expect(within(global).getByRole('listitem')).toHaveTextContent('带入的记忆超出上限，已自动放宽 50%（不扣分）')
  })

  it('从没体检过：不显示分数，时间行写内容检查还没做过，下面给空状态（没有按钮）', () => {
    renderTab(health([layer({ semanticCachedAt: null, score: 100 }), layer({ layer: { kind: 'global' }, semanticCachedAt: null })]))
    const ws = screen.getByRole('region', { name: '本项目' })
    expect(ws).toHaveTextContent('本项目·12 条·还没体检过，体检后打分')
    expect(ws).not.toHaveTextContent('100 分')
    expect(ws).toHaveTextContent('内容检查还没做过')
    expect(screen.getByRole('status')).toHaveTextContent('内容检查还没做过')
    expect(screen.getByRole('status')).toHaveTextContent('规则检查的结果')
    expect(within(screen.getByRole('status')).queryByRole('button')).toBeNull()
  })

  it('体检关闭：内容置灰，给「去设置里打开 ›」；密钥与读不出的文件仍提示（只看列出的层）', () => {
    const openSettings = vi.fn()
    const pending: PendingView = {
      version: GUI_VIEW_VERSION, dot: 'red',
      items: [
        { kind: 'secret', memory: memory({ id: 's1', name: 'deploy-token' }) },
        { kind: 'secret', memory: memory({ id: 's2', name: 'other-project', workspacePath: '/w/blog' }) },
        { kind: 'unreadable-file', layer: { kind: 'global' }, filePath: '/m/global/bad.md', relativePath: 'global/bad.md', error: 'yaml-parse' },
      ],
      typeLabels: {},
    }
    renderTab(health([layer(), layer({ layer: { kind: 'global' } })], false), { pending, openSettings })
    expect(screen.getByRole('status')).toHaveTextContent('体检已关闭')
    fireEvent.click(screen.getByRole('button', { name: '去设置里打开 ›' }))
    expect(openSettings).toHaveBeenCalledTimes(1)
    expect(screen.getByText('有密钥：deploy-token')).toBeInTheDocument()
    expect(screen.getByText('读不出来：global/bad.md')).toBeInTheDocument()
    expect(screen.queryByText('有密钥：other-project')).toBeNull()
    const greyed = screen.getByRole('region', { name: '本项目' }).closest('[aria-disabled="true"]')
    expect(greyed).not.toBeNull()
    expect(greyed).toContainElement(screen.getByRole('region', { name: '全局' }))
  })

  it('视图还没生成：写说明，不渲染层', () => {
    const gateway = createFakeGateway({ session, views: { health: { status: 'missing' } } })
    renderInShell(<HealthTab session={session} scope={WS} nav={createNavStore()} />, gateway)
    expect(screen.getByText('还没有生成这份数据。')).toBeInTheDocument()
    expect(screen.queryByRole('region')).toBeNull()
  })
})
