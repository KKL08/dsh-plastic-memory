import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryCard } from './MemoryCard.tsx'
import { PanelShell } from './PanelShell.tsx'
import { createFakeGateway } from '../gateway.fake.ts'
import { createTranslator } from '../i18n.tsx'
import { en } from '../locales.ts'
import { memory, mockMemoryTextOverflow, NOW, renderInShell } from '../test-utils.tsx'
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

  it('子 agent 写入的记忆：元信息在时间后面写第几层和是否确认；普通记忆不写', () => {
    const metaOf = (delegation: MemoryCardData['delegation']) => {
      const { container, unmount } = renderInShell(<MemoryCard memory={memory(delegation === undefined ? {} : { delegation })} now={NOW} typeLabel="行为偏好" />)
      const texts = [...container.querySelector('.pm-mc-meta')!.children].map(s => s.textContent)
      unmount()
      return texts
    }
    expect(metaOf({ depth: 1 })).toEqual(['行为偏好', '本项目', '你明确说的', '9 月 12 日', '子 agent 写入 · 第 1 层 · 待确认'])
    expect(metaOf({ depth: 2, reviewed: 'main' })).toEqual(['行为偏好', '本项目', '你明确说的', '9 月 12 日', '子 agent 写入 · 第 2 层 · 主会话已接受'])
    expect(metaOf({ depth: 3, reviewed: 'user' })).toEqual(['行为偏好', '本项目', '你明确说的', '9 月 12 日', '子 agent 写入 · 第 3 层 · 用户已改'])
    expect(metaOf(undefined)).toEqual(['行为偏好', '本项目', '你明确说的', '9 月 12 日'])
  })

  it('子 agent 标注的英文文案', () => {
    const textOf = (delegation: MemoryCardData['delegation']) => {
      const { container, unmount } = render(<PanelShell gateway={createFakeGateway()} t={createTranslator(en)}><MemoryCard memory={memory({ delegation })} now={NOW} /></PanelShell>)
      const text = container.querySelector('.pm-mc-meta')!.lastElementChild!.textContent
      unmount()
      return text
    }
    expect(textOf({ depth: 1 })).toBe('Written by a subagent · level 1 · pending review')
    expect(textOf({ depth: 2, reviewed: 'main' })).toBe('Written by a subagent · level 2 · accepted by the main session')
    expect(textOf({ depth: 2, reviewed: 'user' })).toBe('Written by a subagent · level 2 · edited by you')
  })

  it('已过期：原文改次文字色（pm-mc--expired），元信息写「不再带入对话」', () => {
    const { container } = renderInShell(<MemoryCard memory={memory({ validTo: NOW - 1 })} now={NOW} />)
    expect(container.querySelector('.pm-mc')).toHaveClass('pm-mc--expired')
    expect(screen.getByText('不再带入对话')).toBeInTheDocument()
  })

  describe('长记忆折叠（collapsible）', () => {
    afterEach(() => { vi.restoreAllMocks() })
    it('超出行数时限行，给「展开」；展开后整段显示、按钮换成「收起」，再点收回', () => {
      mockMemoryTextOverflow()
      const { container } = renderInShell(<MemoryCard memory={memory()} now={NOW} collapsible />)
      const text = container.querySelector('.pm-mc-text')!
      expect(text).toHaveClass('pm-mc-text--clamped')
      const toggle = screen.getByRole('button', { name: '展开' })
      expect(toggle).toHaveAttribute('aria-expanded', 'false')
      expect(toggle).toHaveAttribute('aria-controls', text.id)
      fireEvent.click(toggle)
      expect(text).not.toHaveClass('pm-mc-text--clamped')
      expect(screen.getByRole('button', { name: '收起' })).toHaveAttribute('aria-expanded', 'true')
      fireEvent.click(screen.getByRole('button', { name: '收起' }))
      expect(text).toHaveClass('pm-mc-text--clamped')
      expect(screen.getByRole('button', { name: '展开' })).toBeInTheDocument()
    })

    it('没超出行数：不出按钮', () => {
      mockMemoryTextOverflow(false)
      renderInShell(<MemoryCard memory={memory()} now={NOW} collapsible />)
      expect(screen.queryByRole('button')).toBeNull()
    })

    it('不传 collapsible：不限行、不出按钮（右侧栏、对话卡照旧）', () => {
      mockMemoryTextOverflow()
      const { container } = renderInShell(<MemoryCard memory={memory()} now={NOW} />)
      expect(container.querySelector('.pm-mc-text')).not.toHaveClass('pm-mc-text--clamped')
      expect(screen.queryByRole('button')).toBeNull()
    })

    it('按钮对齐宿主的折叠按钮：「展开」带向下箭头、「收起」带向上箭头', () => {
      mockMemoryTextOverflow()
      const { container } = renderInShell(<MemoryCard memory={memory()} now={NOW} collapsible />)
      const toggle = screen.getByRole('button', { name: '展开' })
      expect(toggle.querySelector('svg')).not.toBeNull()
      const icon = toggle.innerHTML
      fireEvent.click(toggle)
      expect(screen.getByRole('button', { name: '收起' }).innerHTML).not.toBe(icon)
      expect(container.querySelector('.pm-mc-toggle')).toBe(screen.getByRole('button', { name: '收起' }))
    })

    it('展开着的时候原文变了（改写、整理、重新遮住密钥）：回到折叠，重新量，变短了就不再给按钮', () => {
      mockMemoryTextOverflow()
      const { container, rerender } = renderInShell(<MemoryCard memory={memory()} now={NOW} collapsible />)
      fireEvent.click(screen.getByRole('button', { name: '展开' }))
      vi.restoreAllMocks()
      mockMemoryTextOverflow(false)
      rerender(<MemoryCard memory={memory({ content: '短了。' })} now={NOW} collapsible />)
      expect(container.querySelector('.pm-mc-text')).toHaveClass('pm-mc-text--clamped')
      expect(screen.queryByRole('button')).toBeNull()
    })

    it('折叠着的长记忆：标签在原文末尾会被截掉，在按钮旁边再显示一份（读屏只读原文里那份）；展开后只在原文末尾', () => {
      mockMemoryTextOverflow()
      const { container } = renderInShell(<MemoryCard memory={memory()} now={NOW} collapsible badge={<span>已改写</span>} />)
      const more = container.querySelector('.pm-mc-more')!
      expect(more).toHaveTextContent('已改写')
      expect(more.querySelector('.pm-mc-badge')).toHaveAttribute('aria-hidden', 'true')
      expect(container.querySelector('.pm-mc-text .pm-mc-badge')).toHaveTextContent('已改写')
      fireEvent.click(screen.getByRole('button', { name: '展开' }))
      expect(container.querySelector('.pm-mc-more')).not.toHaveTextContent('已改写')
      expect(container.querySelector('.pm-mc-text .pm-mc-badge')).toHaveTextContent('已改写')
    })

    it('短记忆：标签只在原文末尾', () => {
      mockMemoryTextOverflow(false)
      const { container } = renderInShell(<MemoryCard memory={memory()} now={NOW} collapsible badge={<span>已改写</span>} />)
      expect(container.querySelectorAll('.pm-mc-badge')).toHaveLength(1)
      expect(container.querySelector('.pm-mc-text .pm-mc-badge')).toHaveTextContent('已改写')
    })

    it('加上标签才挤出第 7 行：重新量，给按钮', () => {
      vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
        return this.classList.contains('pm-mc-text') && this.querySelector('.pm-mc-badge') !== null ? 500 : 0
      })
      vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
        return this.classList.contains('pm-mc-text') ? 100 : 0
      })
      const { rerender } = renderInShell(<MemoryCard memory={memory()} now={NOW} collapsible />)
      expect(screen.queryByRole('button')).toBeNull()
      rerender(<MemoryCard memory={memory()} now={NOW} collapsible badge={<span>已改写</span>} />)
      expect(screen.getByRole('button', { name: '展开' })).toBeInTheDocument()
    })

    it('英文文案', () => {
      mockMemoryTextOverflow()
      render(<PanelShell gateway={createFakeGateway()} t={createTranslator(en)}><MemoryCard memory={memory()} now={NOW} collapsible /></PanelShell>)
      fireEvent.click(screen.getByRole('button', { name: 'Expand' }))
      expect(screen.getByRole('button', { name: 'Collapse' })).toBeInTheDocument()
    })
  })
})
