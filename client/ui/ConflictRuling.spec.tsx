import { describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, within } from '@testing-library/react'
import { ConflictRuling, VerticalConflictRuling } from './ConflictRuling.tsx'
import { memory, NOW, renderInShell } from '../test-utils.tsx'

const left = memory({ id: 'a', content: '测试用真实 Postgres。' })
const right = memory({ id: 'b', content: '测试里 mock 数据库就行。' })

describe('ConflictRuling', () => {
  it('标题带琥珀圆点，A / B 各一张记忆卡', () => {
    const { container } = renderInShell(<ConflictRuling layout="narrow" left={left} right={right} now={NOW} onRule={() => {}} />)
    expect(screen.getByRole('heading', { name: '两条记忆互相矛盾，等你决定' })).toBeInTheDocument()
    expect(container.querySelector('.pm-conflict-head > .pm-conflict-mark > .pm-marker--pending')).not.toBeNull()
    expect(within(screen.getByRole('region', { name: '记忆 A' })).getByText('测试用真实 Postgres。')).toBeInTheDocument()
    expect(within(screen.getByRole('region', { name: '记忆 B' })).getByText('测试里 mock 数据库就行。')).toBeInTheDocument()
  })

  it('三个按钮按契约映射发 verdict：A = keep-left、B = keep-right、都保留 = keep-both', () => {
    const onRule = vi.fn()
    renderInShell(<ConflictRuling layout="narrow" left={left} right={right} now={NOW} onRule={onRule} />)
    fireEvent.click(screen.getByRole('button', { name: '以 A 为准' }))
    fireEvent.click(screen.getByRole('button', { name: '以 B 为准' }))
    fireEvent.click(screen.getByRole('button', { name: '都保留' }))
    expect(onRule.mock.calls).toEqual([['keep-left'], ['keep-right'], ['keep-both']])
  })

  it('窄版：后果说明进建议区（「说明」），下面三个按钮一行', () => {
    const { container } = renderInShell(<ConflictRuling layout="narrow" left={left} right={right} now={NOW} onRule={() => {}} />)
    const row = container.querySelector('.pm-conflict-buttons')!
    expect(row.querySelectorAll('button')).toHaveLength(3)
    expect(row.previousElementSibling).toHaveTextContent(/^说明.*14 天内可恢复/)
  })

  it('宽版：A、B 两张卡只放记忆；下面和窄版一样是「说明」加一排三个平级按钮，默认行为写在标题下', () => {
    const { container } = renderInShell(<ConflictRuling layout="wide" left={left} right={right} now={NOW} note="决定之前，agent 按 A 来做。" onRule={() => {}} />)
    for (const name of ['记忆 A', '记忆 B']) expect(within(screen.getByRole('region', { name })).queryByRole('button')).toBeNull()
    expect(screen.queryByText('B 会删掉，14 天内可恢复')).toBeNull()
    const row = container.querySelector('.pm-conflict-buttons')!
    expect([...row.querySelectorAll('button')].map(b => b.textContent)).toEqual(['以 A 为准', '以 B 为准', '都保留'])
    expect(row.previousElementSibling).toHaveTextContent(/^说明.*14 天内可恢复/)
    expect(container.querySelector('.pm-conflict-note')).toHaveTextContent('决定之前，agent 按 A 来做。')
  })

  it('一方找不到：显示说明，三个按钮都不可用且不发裁决', () => {
    const onRule = vi.fn()
    renderInShell(<ConflictRuling layout="narrow" left={left} right={null} now={NOW} onRule={onRule} />)
    expect(screen.getByText('这条记忆找不到了，可能已经被删除。')).toBeInTheDocument()
    for (const name of ['以 A 为准', '以 B 为准', '都保留']) {
      const button = screen.getByRole('button', { name })
      expect(button).toHaveAttribute('aria-disabled', 'true')
      fireEvent.click(button)
    }
    expect(onRule).not.toHaveBeenCalled()
  })

  it('unavailable 时按钮带原因提示且不发裁决', () => {
    const onRule = vi.fn()
    renderInShell(<ConflictRuling layout="narrow" left={left} right={right} now={NOW} onRule={onRule} unavailable="先开一个会话" />)
    const button = screen.getByRole('button', { name: '都保留' })
    expect(button).toHaveAttribute('title', '先开一个会话')
    fireEvent.click(button)
    expect(onRule).not.toHaveBeenCalled()
  })
})

describe('VerticalConflictRuling', () => {
  it('写明基线不会被删除和基线出处；「以基线为准」= keep-right、「保留这条记忆」= keep-left', () => {
    const onRule = vi.fn()
    const { container } = renderInShell(<VerticalConflictRuling layout="narrow" memory={left} baselineRef="AGENTS.md：用 pnpm" now={NOW} onRule={onRule} />)
    expect(screen.getByRole('heading', { name: '这条记忆和基线矛盾，等你决定' })).toBeInTheDocument()
    expect(container.querySelector('.pm-conflict-head > .pm-conflict-mark > .pm-marker--pending')).not.toBeNull()
    expect(screen.getByText('AGENTS.md 是基线，不会被删除。')).toBeInTheDocument()
    expect(screen.getByText('基线：AGENTS.md：用 pnpm')).toBeInTheDocument()
    expect(screen.getByText('测试用真实 Postgres。')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '以基线为准' }))
    fireEvent.click(screen.getByRole('button', { name: '保留这条记忆' }))
    expect(onRule.mock.calls).toEqual([['keep-right'], ['keep-left']])
    const row = container.querySelector('.pm-conflict-buttons')!
    expect(row.querySelectorAll('button')).toHaveLength(2)
    expect(row.previousElementSibling).toHaveTextContent(/^说明以基线为准会删掉这条记忆/)
  })

  it('记忆找不到：显示说明，两个按钮都不可用', () => {
    const onRule = vi.fn()
    renderInShell(<VerticalConflictRuling layout="narrow" memory={null} baselineRef="AGENTS.md" now={NOW} onRule={onRule} />)
    expect(screen.getByText('这条记忆找不到了，可能已经被删除。')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '以基线为准' }))
    expect(onRule).not.toHaveBeenCalled()
  })
})
