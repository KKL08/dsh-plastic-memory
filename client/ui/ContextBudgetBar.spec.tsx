import { describe, expect, it, vi } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import { barScale, budgetParts, ContextBudgetBar, relaxedCap } from './ContextBudgetBar.tsx'
import { renderInShell } from '../test-utils.tsx'

const widths = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLElement>('.pm-budget-seg')].map(el => el.style.width)
/** 图例逐项：色块的着色类 + 文字。 */
const legendKeys = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLElement>('.pm-budget-key')].map(el => ({
    tint: [...el.querySelector('.pm-budget-swatch')!.classList].find(c => c.startsWith('pm-budget-tint--')),
    text: el.textContent,
  }))

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

describe('budgetParts', () => {
  it('固定说明拆成计入上限的标题（usedTokens 减两段记忆）和不计上限的部分（三段之和减 usedTokens）', () => {
    expect(budgetParts({ tokens: { workspace: 88, global: 93, fixed: 596 }, usedTokens: 211 })).toEqual({
      total: 777, counted: 211, workspace: 88, global: 93, headings: 30, uncounted: 566,
    })
  })

  it('冷启动（没带入记忆，usedTokens 为 0）：固定说明全部不计上限，不出负数', () => {
    expect(budgetParts({ tokens: { workspace: 0, global: 0, fixed: 120 }, usedTokens: 0 })).toMatchObject({ headings: 0, uncounted: 120 })
  })
})

describe('ContextBudgetBar', () => {
  it('少量记忆（本项目 88、全局 93、固定说明 596）：分子是计入上限的用量，不是三段之和', () => {
    const { container } = renderInShell(<ContextBudgetBar count={6} budget={4000} tokens={{ workspace: 88, global: 93, fixed: 596 }} usedTokens={211} />)
    expect(screen.getByText('6 条 · 约 211 / 4,000')).toBeInTheDocument()
    expect(container).not.toHaveTextContent('777')
    expect(screen.getByRole('img')).toHaveAttribute('aria-label', '已用上限的 5%：本项目 88，全局 93，标题 30；固定说明 566，不计上限')
    expect(screen.getByText('全部带入')).toBeInTheDocument()
  })

  it('条内三段：本项目、全局实色；固定说明段前面的标题实色、后面不计上限的部分斜纹，按各自 token 分宽', () => {
    const { container } = renderInShell(<ContextBudgetBar count={6} budget={4000} tokens={{ workspace: 88, global: 93, fixed: 596 }} usedTokens={211} />)
    widths(container).forEach((w, i) => expect(parseFloat(w)).toBeCloseTo([2.2, 2.325, 14.9][i]))
    expect(widths(container)).toHaveLength(3)
    const fixed = container.querySelector('.pm-budget-seg--fixed')!
    const inner = [...fixed.children] as HTMLElement[]
    expect(inner.map(el => el.className)).toEqual(['pm-budget-tint--headings', 'pm-budget-tint--uncounted'])
    expect(inner.map(el => el.style.flexGrow)).toEqual(['30', '566'])
  })

  it('图例是色块 + 名称 + 数字；固定说明用斜纹色块并写「不计上限」，状态留在右侧', () => {
    const { container } = renderInShell(<ContextBudgetBar count={6} budget={4000} tokens={{ workspace: 88, global: 93, fixed: 596 }} usedTokens={211} />)
    expect(legendKeys(container)).toEqual([
      { tint: 'pm-budget-tint--workspace', text: '本项目 88' },
      { tint: 'pm-budget-tint--global', text: '全局 93' },
      { tint: 'pm-budget-tint--headings', text: '标题 30' },
      { tint: 'pm-budget-tint--uncounted', text: '固定说明 566（不计上限）' },
    ])
    expect(container.querySelector('.pm-budget-legend > .pm-budget-status')).toHaveTextContent('全部带入')
  })

  it('某段为 0 时不画空段，图例和读屏都不念「标题 0」', () => {
    const { container } = renderInShell(<ContextBudgetBar count={1} budget={4000} tokens={{ workspace: 0, global: 40, fixed: 300 }} usedTokens={40} />)
    expect(widths(container)).toEqual(['1%', '7.5%'])
    expect(container.querySelector('.pm-budget-tint--headings')).toBeNull()
    expect(legendKeys(container).map(k => k.text)).toEqual(['本项目 0', '全局 40', '固定说明 300（不计上限）'])
    expect(screen.getByRole('img')).toHaveAttribute('aria-label', '已用上限的 1%：本项目 0，全局 40；固定说明 300，不计上限')
  })

  it('自动放宽超出：分子是计入上限的用量，满格换成当前档，细线标出上限，状态写放宽到多少', () => {
    const { container } = renderInShell(<ContextBudgetBar count={50} budget={4000} tokens={{ workspace: 3000, global: 1500, fixed: 500 }} usedTokens={4700} />)
    expect(screen.getByText('50 条 · 约 4,700 / 4,000')).toBeInTheDocument()
    expect(widths(container)).toEqual(['60%', '30%', '10%'])
    expect(container.querySelector<HTMLElement>('.pm-budget-limit')!.style.left).toBe('80%')
    expect(screen.getByText('已放宽到 5,000')).toBeInTheDocument()
    expect(screen.getByRole('img').getAttribute('aria-label')).toMatch(/^已用上限的 118%/)
  })

  it('是否放宽按计入上限的用量算：不计上限的部分把三段之和顶过上限时不算放宽', () => {
    const { container } = renderInShell(<ContextBudgetBar count={40} budget={4000} tokens={{ workspace: 2900, global: 1000, fixed: 200 }} usedTokens={3900} />)
    expect(screen.getByText('40 条 · 约 3,900 / 4,000')).toBeInTheDocument()
    expect(screen.getByText('全部带入')).toBeInTheDocument()
    expect(container.querySelector('.pm-budget-limit')).toBeNull()
    // 满格取三段之和，三段不溢出条外
    expect(widths(container).reduce((sum, w) => sum + parseFloat(w), 0)).toBeCloseTo(100)
  })

  it('严格模式装不下：分子不超过上限，写没带入的条数，「处理 ›」回调', () => {
    const onHandle = vi.fn()
    renderInShell(<ContextBudgetBar count={40} budget={4000} tokens={{ workspace: 2800, global: 1000, fixed: 500 }} usedTokens={4000} droppedCount={3} onHandle={onHandle} />)
    expect(screen.getByText('40 条 · 约 4,000 / 4,000')).toBeInTheDocument()
    expect(screen.getByText(/已到上限，3 条没带入/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '处理 ›' }))
    expect(onHandle).toHaveBeenCalledTimes(1)
  })
})
