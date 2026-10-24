import { describe, expect, it, vi } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import { barScale, ContextBudgetBar, relaxedCap } from './ContextBudgetBar.tsx'
import { renderInShell } from '../test-utils.tsx'

const widths = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLElement>('.pm-budget-seg')].map(el => el.style.width)

describe('relaxedCap', () => {
  it('没超上限是上限本身；超出按 25% 一档向上取', () => {
    expect(relaxedCap(3000, 4000)).toBe(4000)
    expect(relaxedCap(4000, 4000)).toBe(4000)
    expect(relaxedCap(4001, 4000)).toBe(5000)
    expect(relaxedCap(5000, 4000)).toBe(5000)
    expect(relaxedCap(5200, 4000)).toBe(6000)
  })
})

describe('barScale', () => {
  it('满格 = 按计入上限的用量放宽到的档，三段之和更大时取三段之和', () => {
    expect(barScale(3120, 3120, 4000)).toBe(4000)
    expect(barScale(5000, 4500, 4000)).toBe(5000)
    expect(barScale(4100, 3900, 4000)).toBe(4100)
    expect(barScale(0, 0, 0)).toBe(1)
  })
})

describe('ContextBudgetBar', () => {
  it('都装下：三段按上限折算宽度，总数与图例带千分位，状态「全部带入」', () => {
    const { container } = renderInShell(<ContextBudgetBar count={38} budget={4000} tokens={{ workspace: 1870, global: 1050, fixed: 200 }} />)
    expect(screen.getByText('38 条 · 约 3,120 / 4,000')).toBeInTheDocument()
    expect(widths(container)).toEqual(['46.75%', '26.25%', '5%'])
    expect(container.querySelector('.pm-budget-legend')).toHaveTextContent('本项目 1,870·全局 1,050·固定说明 200')
    expect(screen.getByText('全部带入')).toBeInTheDocument()
    expect(screen.getByRole('img')).toHaveAttribute('aria-label', '已用 78%：本项目 1,870，全局 1,050，固定说明 200')
    expect(container.querySelector('.pm-budget-limit')).toBeNull()
  })

  it('自动放宽超出：满格换成当前档，细线标出上限，状态写放宽到多少', () => {
    const { container } = renderInShell(<ContextBudgetBar count={50} budget={4000} tokens={{ workspace: 3000, global: 1500, fixed: 500 }} />)
    expect(widths(container)).toEqual(['60%', '30%', '10%'])
    expect(container.querySelector<HTMLElement>('.pm-budget-limit')!.style.left).toBe('80%')
    expect(screen.getByText('已放宽到 5,000')).toBeInTheDocument()
  })

  it('是否放宽按计入上限的用量算：固定说明把三段之和顶过上限时不算放宽', () => {
    const { container } = renderInShell(<ContextBudgetBar count={40} budget={4000} tokens={{ workspace: 2900, global: 1000, fixed: 200 }} limitTokens={3900} />)
    expect(screen.getByText('40 条 · 约 4,100 / 4,000')).toBeInTheDocument()
    expect(screen.getByText('全部带入')).toBeInTheDocument()
    expect(container.querySelector('.pm-budget-limit')).toBeNull()
    // 满格取三段之和，三段不溢出条外
    expect(widths(container).reduce((sum, w) => sum + parseFloat(w), 0)).toBeCloseTo(100)
  })

  it('严格模式装不下：写没带入的条数，「处理 ›」回调', () => {
    const onHandle = vi.fn()
    renderInShell(<ContextBudgetBar count={40} budget={4000} tokens={{ workspace: 2800, global: 1000, fixed: 200 }} droppedCount={3} onHandle={onHandle} />)
    expect(screen.getByText(/已到上限，3 条没带入/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '处理 ›' }))
    expect(onHandle).toHaveBeenCalledTimes(1)
  })
})
