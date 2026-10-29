import { describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'
import { MemoryCard } from './MemoryCard.tsx'
import { memory, NOW, renderInShell } from '../test-utils.tsx'
import type { MemoryCard as MemoryCardData } from '../../src/gui/contract.ts'

describe('MemoryCard', () => {
  it('两行：原文一行；元信息类型是浅灰胶囊，作用域、来源、时间各带宿主图标，不用圆点分隔', () => {
    const { container } = renderInShell(<MemoryCard memory={memory()} now={NOW} typeLabel="行为偏好" />)
    expect(container.querySelector('.pm-mc-text')).toHaveTextContent('测试里不要 mock 数据库，用 testcontainers 起真实 Postgres。')
    const meta = container.querySelector('.pm-mc-meta')!
    expect([...meta.children].map(s => s.textContent)).toEqual(['行为偏好', '本项目', '你明确说的', '9 月 12 日'])
    expect(meta.firstElementChild).toHaveClass('pm-chip', 'pm-chip--neutral')
    expect([...meta.querySelectorAll('.pm-mc-item')].map(s => s.querySelectorAll('svg').length)).toEqual([1, 1, 1])
    expect(meta.querySelectorAll('.pm-sep')).toHaveLength(0)
    expect(container.querySelector('.pm-mc')).not.toHaveClass('pm-mc--expired')
  })

  it('来源图标按是谁：你 / agent / 环境各一种，无出处不画', () => {
    const iconOf = (sourceMode: MemoryCardData['sourceMode']) => {
      const { container, unmount } = renderInShell(<MemoryCard memory={memory({ sourceMode })} now={NOW} />)
      const source = container.querySelectorAll('.pm-mc-item')[1]!
      const html = source.querySelector('svg')?.innerHTML
      unmount()
      return html
    }
    expect(iconOf('user-explicit')).toBe(iconOf('user-behavior'))
    expect(iconOf('agent-inferred')).toBe(iconOf('agent-action-confirmed'))
    expect(new Set([iconOf('user-explicit'), iconOf('agent-inferred'), iconOf('environment-observed')]).size).toBe(3)
    expect(iconOf(undefined)).toBeUndefined()
  })

  it('没给类型名时显示类型 id；全局、无出处、刚写的', () => {
    const { container } = renderInShell(<MemoryCard memory={memory({ scope: 'global', sourceMode: undefined, updatedAt: NOW - 5_000 })} now={NOW} />)
    expect(screen.getByText('preference')).toBeInTheDocument()
    expect(screen.getByText('全局')).toBeInTheDocument()
    expect(screen.getByText('无出处')).toBeInTheDocument()
    expect(screen.getByText('刚刚')).toBeInTheDocument()
    expect(container.querySelector('.pm-mc-item svg')!.innerHTML).not.toBe(
      renderInShell(<MemoryCard memory={memory()} now={NOW} />).container.querySelector('.pm-mc-item svg')!.innerHTML,
    )
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
})
