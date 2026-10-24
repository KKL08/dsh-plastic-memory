import { describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'
import { MemoryCard } from './MemoryCard.tsx'
import { Chip } from './Chip.tsx'
import { memory, NOW, renderInShell } from '../test-utils.tsx'

describe('MemoryCard', () => {
  it('两行：原文一行，元信息按「类型 · 作用域 · 来源 · 时间」', () => {
    const { container } = renderInShell(<MemoryCard memory={memory()} now={NOW} typeLabel="行为偏好" />)
    expect(container.querySelector('.pm-mc-text')).toHaveTextContent('测试里不要 mock 数据库，用 testcontainers 起真实 Postgres。')
    const meta = container.querySelector('.pm-mc-meta')!
    expect([...meta.querySelectorAll(':scope > span')].map(s => s.textContent)).toEqual(['行为偏好', '本项目', '你明确说的', '9 月 12 日'])
    expect(meta.querySelectorAll('.pm-sep')).toHaveLength(3)
    expect(container.querySelector('.pm-mc')).not.toHaveClass('pm-mc--expired')
  })

  it('没给类型名时显示类型 id；全局、无出处、刚写的', () => {
    renderInShell(<MemoryCard memory={memory({ scope: 'global', sourceMode: undefined, updatedAt: NOW - 5_000 })} now={NOW} />)
    expect(screen.getByText('preference')).toBeInTheDocument()
    expect(screen.getByText('全局')).toBeInTheDocument()
    expect(screen.getByText('无出处')).toBeInTheDocument()
    expect(screen.getByText('刚刚')).toBeInTheDocument()
  })

  it('hideScope 不重复作用域；跨年带年份', () => {
    renderInShell(<MemoryCard memory={memory({ updatedAt: new Date(2025, 11, 3).getTime() })} now={NOW} hideScope />)
    expect(screen.queryByText('本项目')).toBeNull()
    expect(screen.getByText('2025 年 12 月 3 日')).toBeInTheDocument()
  })

  it('已过期：原文改次文字色（pm-mc--expired），元信息写「不再带入对话」', () => {
    const { container } = renderInShell(<MemoryCard memory={memory({ validTo: NOW - 1 })} now={NOW} />)
    expect(container.querySelector('.pm-mc')).toHaveClass('pm-mc--expired')
    expect(screen.getByText('不再带入对话')).toBeInTheDocument()
  })

  it('状态 chip 放在元信息最后', () => {
    const { container } = renderInShell(
      <MemoryCard memory={memory()} now={NOW} chip={<Chip variant="status" tone="warn">有冲突</Chip>} />,
    )
    const meta = container.querySelector('.pm-mc-meta')!
    expect(meta.lastElementChild).toHaveTextContent('有冲突')
    expect(meta.lastElementChild).toHaveClass('pm-chip', 'pm-chip--warn')
  })
})
