// 照抄宿主的设置结构与分段控件，加分组卡片。
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import { SegmentedControl, SegmentedTabs } from './Segmented.tsx'
import { SettingsForm, SettingsGroupCard, SettingsItem, type SettingsFormState } from './Settings.tsx'
import { renderInShell } from '../test-utils.tsx'

const state = (patch: Partial<SettingsFormState> = {}): SettingsFormState => ({
  available: true, writable: true, dirty: false, invalid: false, saving: false, failed: false, ...patch,
})

describe('SettingsForm', () => {
  it('没有改动时保存置灰；有改动可保存；保存中换文案', () => {
    const onSave = vi.fn()
    const { rerender } = renderInShell(<SettingsForm state={state()} onSave={onSave} onDiscard={() => {}}><span>控件</span></SettingsForm>)
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled()
    rerender(<SettingsForm state={state({ dirty: true })} onSave={onSave} onDiscard={() => {}}><span>控件</span></SettingsForm>)
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(onSave).toHaveBeenCalledTimes(1)
    rerender(<SettingsForm state={state({ dirty: true, saving: true })} onSave={onSave} onDiscard={() => {}}><span>控件</span></SettingsForm>)
    expect(screen.getByRole('button', { name: '正在保存…' })).toBeDisabled()
  })

  it('只读提示、保存失败提示、宿主不服务时只显示一行', () => {
    const { rerender } = renderInShell(<SettingsForm state={state({ writable: false, failed: true })} onSave={() => {}} onDiscard={() => {}}><span>控件</span></SettingsForm>)
    expect(screen.getByText('当前配置是只读的，改不了。')).toBeInTheDocument()
    expect(screen.getByText('没有保存成功，再试一次。')).toBeInTheDocument()
    rerender(<SettingsForm state={state({ available: false })} onSave={() => {}} onDiscard={() => {}}><span>控件</span></SettingsForm>)
    expect(screen.getByRole('status')).toHaveTextContent('宿主暂时没有提供这份配置。')
    expect(screen.queryByText('控件')).toBeNull()
  })

  it('卸载时丢弃暂存改动', () => {
    const onDiscard = vi.fn()
    const { unmount } = renderInShell(<SettingsForm state={state()} onSave={() => {}} onDiscard={onDiscard}><span /></SettingsForm>)
    unmount()
    expect(onDiscard).toHaveBeenCalledTimes(1)
  })
})

describe('SettingsGroupCard', () => {
  it('组标题在卡片外，卡片里每项一行', () => {
    const { container } = renderInShell(
      <SettingsGroupCard title="怎么用">
        <SettingsItem label="上限" hint="默认 4,000。" htmlFor="budget"><input id="budget" /></SettingsItem>
        <SettingsItem label="超出上限时"><span /></SettingsItem>
      </SettingsGroupCard>,
    )
    const title = screen.getByRole('heading', { name: '怎么用' })
    expect(title.parentElement).toHaveClass('pm-group')
    expect(container.querySelector('.pm-group-card')!.contains(title)).toBe(false)
    expect(container.querySelectorAll('.pm-group-card > .pm-setting')).toHaveLength(2)
    expect(screen.getByLabelText('上限')).toBeInTheDocument()
    expect(screen.getByText('默认 4,000。')).toHaveClass('pm-setting-hint')
  })
})

describe('SegmentedControl', () => {
  const options = [{ value: 'relaxed', label: '自动放宽' }, { value: 'strict', label: '严格按上限' }] as const

  it('受控 tablist：点未选中项回调，方向键走到下一项', () => {
    const onChange = vi.fn()
    renderInShell(<SegmentedControl id="overflow" label="超出上限时" value="relaxed" options={options} onChange={onChange} />)
    const tabs = screen.getAllByRole('tab')
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true')
    expect(tabs[0]).toHaveAttribute('id', 'overflow-relaxed')
    expect(tabs[0]).toHaveAttribute('aria-controls', 'overflow-relaxed-panel')
    fireEvent.click(tabs[0]!)
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.click(tabs[1]!)
    fireEvent.keyDown(tabs[0]!, { key: 'ArrowRight' })
    expect(onChange.mock.calls).toEqual([['strict'], ['strict']])
  })
})

describe('SegmentedTabs', () => {
  it('只有选中项是 tab 停靠点；End 跳到最后一项', () => {
    const onChange = vi.fn()
    const items = [
      { value: 'a', label: '待处理', id: 't-a', panelId: 'p-a' },
      { value: 'b', label: '健康', id: 't-b', panelId: 'p-b' },
    ] as const
    renderInShell(<SegmentedTabs label="记忆视图" items={items} value="a" onChange={onChange} />)
    expect(screen.getByRole('tablist', { name: '记忆视图' })).toBeInTheDocument()
    const [first, second] = screen.getAllByRole('tab')
    expect(first).toHaveAttribute('tabindex', '0')
    expect(second).toHaveAttribute('tabindex', '-1')
    fireEvent.keyDown(first!, { key: 'End' })
    expect(onChange).toHaveBeenCalledWith('b')
  })
})
