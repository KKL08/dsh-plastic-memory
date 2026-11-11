import { describe, expect, it } from 'vitest'
import { screen, within } from '@testing-library/react'
import { ConflictRuling, VerticalConflictRuling } from './ConflictRuling.tsx'
import { memory, NOW, renderInShell } from '../test-utils.tsx'

const left = memory({ id: 'a', content: '测试用真实 Postgres。' })
const right = memory({ id: 'b', content: '测试里 mock 数据库就行。' })

describe('ConflictRuling', () => {
  const footer = <p className="test-footer">建议和动作</p>

  it('标题带琥珀圆点，A / B 各一张记忆卡', () => {
    const { container } = renderInShell(<ConflictRuling layout="narrow" left={left} right={right} now={NOW} footer={footer} />)
    expect(screen.getByRole('heading', { name: '两条记忆互相矛盾，等你决定' })).toBeInTheDocument()
    expect(container.querySelector('.pm-conflict-head > .pm-conflict-mark > .pm-marker--pending')).not.toBeNull()
    expect(within(screen.getByRole('region', { name: '记忆 A' })).getByText('测试用真实 Postgres。')).toBeInTheDocument()
    expect(within(screen.getByRole('region', { name: '记忆 B' })).getByText('测试里 mock 数据库就行。')).toBeInTheDocument()
  })

  it.each(['narrow', 'wide'] as const)('%s：A、B 下面整块是调用方给的 footer，不另画后果说明和裁决按钮', (layout) => {
    const { container } = renderInShell(<ConflictRuling layout={layout} left={left} right={right} now={NOW} footer={footer} />)
    const block = container.querySelector('.pm-conflict-footer')!
    expect(block.previousElementSibling).toHaveClass('pm-conflict-sides')
    expect(within(block as HTMLElement).getByText('建议和动作')).toBeInTheDocument()
    expect(container.querySelector('.pm-conflict-buttons, .pm-conflict-advice')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('宽版：A、B 两张卡只放记忆，默认行为写在标题下', () => {
    const { container } = renderInShell(<ConflictRuling layout="wide" left={left} right={right} now={NOW} note="决定之前，agent 按 A 来做。" footer={footer} />)
    for (const name of ['记忆 A', '记忆 B']) expect(within(screen.getByRole('region', { name })).queryByRole('button')).toBeNull()
    expect(container.querySelector('.pm-conflict-note')).toHaveTextContent('决定之前，agent 按 A 来做。')
  })

  it('一方找不到：那一方写说明', () => {
    renderInShell(<ConflictRuling layout="narrow" left={left} right={null} now={NOW} footer={footer} />)
    expect(screen.getByText('这条记忆找不到了，可能已经被删除。')).toBeInTheDocument()
  })
})

describe('VerticalConflictRuling', () => {
  const footer = <p className="test-footer">建议和动作</p>

  it('写明基线不会被删除和基线出处；记忆卡下面整块是调用方给的 footer，不另画裁决按钮', () => {
    const { container } = renderInShell(<VerticalConflictRuling layout="narrow" memory={left} baselineRef="AGENTS.md：用 pnpm" now={NOW} footer={footer} />)
    expect(screen.getByRole('heading', { name: '这条记忆和基线矛盾，等你决定' })).toBeInTheDocument()
    expect(container.querySelector('.pm-conflict-head > .pm-conflict-mark > .pm-marker--pending')).not.toBeNull()
    expect(screen.getByText('指令文件不会被改动，处理只针对这条记忆。')).toBeInTheDocument()
    expect(screen.getByText('基线：AGENTS.md：用 pnpm')).toBeInTheDocument()
    expect(screen.getByText('测试用真实 Postgres。')).toBeInTheDocument()
    const block = container.querySelector('.pm-conflict-footer')!
    expect(block.previousElementSibling).toHaveClass('pm-conflict-single')
    expect(within(block as HTMLElement).getByText('建议和动作')).toBeInTheDocument()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('记忆找不到：显示说明', () => {
    renderInShell(<VerticalConflictRuling layout="narrow" memory={null} baselineRef="AGENTS.md" now={NOW} footer={footer} />)
    expect(screen.getByText('这条记忆找不到了，可能已经被删除。')).toBeInTheDocument()
  })
})
