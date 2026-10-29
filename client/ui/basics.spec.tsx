// 小组件的渲染测试：按钮、不再提醒的叉、状态标记、chip、建议区与结果行、体检横幅、空状态。
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import { Button, buttonCss } from './Button.tsx'
import { themeCss } from './theme.ts'
import { AdviceNote, ResultLine, adviceCss } from './Advice.tsx'
import { Chip } from './Chip.tsx'
import { DismissButton } from './DismissButton.tsx'
import { EmptyState } from './EmptyState.tsx'
import { HealthBanner } from './HealthBanner.tsx'
import { StatusMarker } from './StatusMarker.tsx'
import { renderInShell } from '../test-utils.tsx'

describe('Button', () => {
  it('四种样式各有修饰类，缺省是次按钮', () => {
    renderInShell(<>
      <Button>默认</Button>
      <Button variant="primary">主</Button>
      <Button variant="quiet">忽略</Button>
      <Button variant="danger">彻底删除…</Button>
    </>)
    expect(screen.getByRole('button', { name: '默认' })).toHaveClass('pm-btn', 'pm-btn--secondary')
    expect(screen.getByRole('button', { name: '主' })).toHaveClass('pm-btn--primary')
    expect(screen.getByRole('button', { name: '忽略' })).toHaveClass('pm-btn--quiet')
    expect(screen.getByRole('button', { name: '彻底删除…' })).toHaveClass('pm-btn--danger')
  })

  it('unavailable：aria-disabled + 提示，点击被吞；可用时照常回调', () => {
    const onClick = vi.fn()
    const { rerender } = renderInShell(<Button unavailable="先开一个会话" onClick={onClick}>体检</Button>)
    const button = screen.getByRole('button', { name: '体检' })
    expect(button).toHaveAttribute('aria-disabled', 'true')
    expect(button).toHaveAttribute('title', '先开一个会话')
    expect(button).toBeEnabled()
    fireEvent.click(button)
    expect(onClick).not.toHaveBeenCalled()
    rerender(<Button onClick={onClick}>体检</Button>)
    fireEvent.click(screen.getByRole('button', { name: '体检' }))
    expect(onClick).toHaveBeenCalledTimes(1)
  })
})

describe('DismissButton', () => {
  it('读屏名称是展开后的字，叉本身不念；点击回调', () => {
    const onClick = vi.fn()
    renderInShell(<DismissButton label="不再提醒" onClick={onClick} />)
    const button = screen.getByRole('button', { name: '不再提醒' })
    expect(button).toHaveClass('pm-dismiss')
    expect(button.querySelector('.pm-dismiss-label')).toHaveAttribute('aria-hidden', 'true')
    expect(button).not.toHaveAttribute('aria-disabled')
    fireEvent.click(button)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('unavailable：aria-disabled + 提示，仍可聚焦，点击被吞', () => {
    const onClick = vi.fn()
    renderInShell(<DismissButton label="不再提醒" unavailable="正在处理上一步" onClick={onClick} />)
    const button = screen.getByRole('button', { name: '不再提醒' })
    expect(button).toHaveAttribute('aria-disabled', 'true')
    expect(button).toHaveAttribute('title', '正在处理上一步')
    expect(button).toBeEnabled()
    fireEvent.click(button)
    expect(onClick).not.toHaveBeenCalled()
  })
})

describe('StatusMarker', () => {
  it('等你决定 = 琥珀圆点，良好 = 绿点，密钥 = 带「!」的红三角', () => {
    const { container } = renderInShell(<>
      <StatusMarker kind="pending" label="等你决定" />
      <StatusMarker kind="ok" />
      <StatusMarker kind="secret" label="有密钥要处理" />
    </>)
    expect(screen.getByRole('img', { name: '等你决定' })).toHaveClass('pm-marker--dot', 'pm-marker--pending', 'pm-marker--page')
    expect(container.querySelector('.pm-marker--ok')).toHaveAttribute('aria-hidden', 'true')
    const secret = screen.getByRole('img', { name: '有密钥要处理' })
    expect(secret.tagName.toLowerCase()).toBe('svg')
    expect(secret.querySelectorAll('path')).toHaveLength(2)
  })

  it('导航尺寸：圆点 7px 档，三角不画「!」', () => {
    const { container } = renderInShell(<><StatusMarker kind="pending" size="nav" /><StatusMarker kind="secret" size="nav" /></>)
    expect(container.querySelector('.pm-marker--pending')).toHaveClass('pm-marker--nav')
    expect(container.querySelector('svg.pm-marker--secret')!.querySelectorAll('path')).toHaveLength(1)
  })
})

describe('Chip', () => {
  it('状态 chip 按色调混底；结果 chip 带绿点；中性胶囊', () => {
    const { container } = renderInShell(<>
      <Chip variant="status" tone="warn">有冲突</Chip>
      <Chip variant="result">已按 A</Chip>
      <Chip variant="neutral">规划中</Chip>
    </>)
    expect(screen.getByText('有冲突')).toHaveClass('pm-chip', 'pm-chip--warn')
    expect(screen.getByText('已按 A')).toHaveClass('pm-chip--result')
    expect(screen.getByText('已按 A').querySelector('.pm-chip-dot')).not.toBeNull()
    expect(screen.getByText('规划中')).toHaveClass('pm-chip--neutral')
    expect(container.querySelectorAll('.pm-chip-dot')).toHaveLength(1)
  })
})

describe('HealthBanner', () => {
  it('标记 + 结论一行，体检时间一行，右边动作', () => {
    const { container } = renderInShell(
      <HealthBanner marker="pending" conclusion="有 2 处冲突等你决定" detail="上次体检：10 月 17 日" actions={<Button>立即体检</Button>} />,
    )
    const title = container.querySelector('.pm-banner-title')!
    expect(title).toHaveTextContent('有 2 处冲突等你决定')
    expect(title.querySelector('.pm-marker--pending')).not.toBeNull()
    expect(screen.getByText('上次体检：10 月 17 日')).toHaveClass('pm-banner-detail')
    expect(container.querySelector('.pm-banner-actions')).toContainElement(screen.getByRole('button', { name: '立即体检' }))
  })
})


describe('EmptyState', () => {
  it('首次：银藤底图标里是鲸尾线稿，鼠标移上去重播（重挂一次线稿）', () => {
    const { container } = renderInShell(<EmptyState variant="first" title="还没有记忆">记忆由 agent 在对话里写下。</EmptyState>)
    expect(screen.getByRole('status')).toHaveClass('pm-empty--first')
    expect(screen.getByText('还没有记忆')).toHaveClass('pm-empty-title')
    const before = container.querySelector('.pm-whale')!
    expect(before.querySelector('.pm-whale-tail')).not.toBeNull()
    expect(before.querySelectorAll('.pm-whale-ripple')).toHaveLength(2)
    expect(before.querySelectorAll('.pm-whale-drip')).toHaveLength(3)
    fireEvent.mouseEnter(container.querySelector('.pm-empty-icon')!)
    expect(container.querySelector('.pm-whale')).not.toBe(before)
  })

  it('日常：一句结论，最多一个动作，没有鲸尾', () => {
    const { container } = renderInShell(<EmptyState variant="daily" title="待处理为空" action={<Button>体检当前项目</Button>} />)
    expect(screen.getByRole('status')).toHaveClass('pm-empty--daily')
    expect(container.querySelector('.pm-whale')).toBeNull()
    expect(container.querySelector('.pm-empty-body')).toBeNull()
    expect(screen.getAllByRole('button')).toHaveLength(1)
  })
})

describe('焦点环（故事 50）', () => {
  it('按钮与链接的焦点环对齐宿主令牌，自有控件不写 outline: none', () => {
    expect(themeCss).toMatch(/:focus-visible\s*\{\s*outline: var\(--dsw-focus-ring-width, 2px\) solid var\(--pm-focus\);\s*outline-offset: 2px;/)
    expect(themeCss).toContain('--pm-focus: var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary))')
    for (const css of [themeCss, buttonCss]) expect(css).not.toMatch(/outline:\s*(none|0)/)
  })
})

describe('建议区与结果行', () => {
  it('建议区：加粗的「建议」开头，后面一段说明；冲突裁决写「说明」', () => {
    const { container } = renderInShell(<><AdviceNote>这条看起来对所有项目都适用。</AdviceNote><AdviceNote label="note">以基线为准会删掉这条记忆。</AdviceNote></>)
    const notes = [...container.querySelectorAll('.pm-advice')]
    expect(notes.map(n => n.querySelector('.pm-advice-label')!.textContent)).toEqual(['建议', '说明'])
    expect(notes[0]!.querySelector('.pm-advice-text')).toHaveTextContent('这条看起来对所有项目都适用。')
  })

  it('结果行：结果 chip、一句后果、撤销排成一行', () => {
    const { container } = renderInShell(<ResultLine chip="已提升为全局" undo={<button type="button">撤销</button>}>所有项目都会带入它。</ResultLine>)
    const line = container.querySelector('.pm-result-line')!
    expect([...line.children].map(c => c.textContent)).toEqual(['已提升为全局', '所有项目都会带入它。', '撤销'])
    expect(line.firstElementChild).toHaveClass('pm-chip--result')
  })

  it('细线由调用方决定：只有前面没有记忆卡时才不画，不看在容器里排第几', () => {
    const { container } = renderInShell(<>
      <div><AdviceNote>包在一层里的建议。</AdviceNote></div>
      <div><ResultLine chip="已按 A">包在一层里的结果。</ResultLine></div>
      <ResultLine chip="已保留基线" isStandalone>卡片没留下。</ResultLine>
    </>)
    const lines = [...container.querySelectorAll('.pm-advice, .pm-result-line')]
    expect(lines.map(l => l.classList.contains('pm-result-line--standalone'))).toEqual([false, false, true])
    // jsdom 算不出带 var() 的 border 简写，这里直接看规则：去掉细线只认修饰类，不按位置
    expect(adviceCss).not.toMatch(/:first-child|:only-child|:first-of-type/)
  })
})
