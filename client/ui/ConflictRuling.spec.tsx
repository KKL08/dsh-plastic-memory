import { describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, within } from '@testing-library/react'
import { ConflictRuling } from './ConflictRuling.tsx'
import { memory, NOW, renderInShell } from '../test-utils.tsx'

const left = memory({ id: 'a', content: '测试用真实 Postgres。' })
const right = memory({ id: 'b', content: '测试里 mock 数据库就行。' })

describe('ConflictRuling', () => {
  it('标题带琥珀圆点，A / B 各一张记忆卡', () => {
    const { container } = renderInShell(<ConflictRuling layout="narrow" left={left} right={right} now={NOW} onRule={() => {}} />)
    expect(screen.getByRole('heading', { name: '两条记忆互相矛盾，等你决定' })).toBeInTheDocument()
    expect(container.querySelector('.pm-conflict-head .pm-marker--pending')).not.toBeNull()
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

  it('窄版：三个按钮一行，后果说明在按钮下面', () => {
    const { container } = renderInShell(<ConflictRuling layout="narrow" left={left} right={right} now={NOW} onRule={() => {}} />)
    const row = container.querySelector('.pm-conflict-buttons')!
    expect(row.querySelectorAll('button')).toHaveLength(3)
    expect(row.nextElementSibling).toHaveClass('pm-conflict-consequence')
    expect(row.nextElementSibling).toHaveTextContent('14 天内可恢复')
  })

  it('宽版：A、B 按钮进各自卡片，「都保留」压在细线中间，下面紧跟说明', () => {
    const { container } = renderInShell(<ConflictRuling layout="wide" left={left} right={right} now={NOW} onRule={() => {}} />)
    expect(within(screen.getByRole('region', { name: '记忆 A' })).getByRole('button', { name: '以 A 为准' })).toBeInTheDocument()
    expect(within(screen.getByRole('region', { name: '记忆 B' })).getByRole('button', { name: '以 B 为准' })).toBeInTheDocument()
    const line = container.querySelector('.pm-keep-line')!
    expect([...line.children].map(el => el.tagName)).toEqual(['SPAN', 'BUTTON', 'SPAN'])
    expect(line.querySelector('button')).toHaveTextContent('都保留')
    expect(line.nextElementSibling).toHaveClass('pm-conflict-consequence')
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
