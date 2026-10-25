// 设置页的居中弹层：aria-modal 弹层把键盘焦点关在里面，Esc 关闭，关闭后焦点回到打开它的按钮。
import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { Dialog } from './controls.tsx'

function Harness() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" onClick={() => { setOpen(true) }}>打开</button>
      <button type="button">弹层外</button>
      {open
        ? (
          <Dialog title="添加类型" closeLabel="关闭" onClose={() => { setOpen(false) }} footer={<button type="button">确定</button>}>
            <input aria-label="名称" />
          </Dialog>
        )
        : null}
    </>
  )
}

function openDialog() {
  render(<Harness />)
  const opener = screen.getByRole('button', { name: '打开' })
  opener.focus()
  fireEvent.click(opener)
  return { opener, dialog: screen.getByRole('dialog', { name: '添加类型' }) }
}

describe('Dialog', () => {
  it('打开时焦点在弹层里', () => {
    openDialog()
    expect(screen.getByLabelText('名称')).toHaveFocus()
  })

  it('Tab 到最后一个控件后回到第一个，Shift+Tab 从第一个回到最后一个，不离开弹层', () => {
    openDialog()
    const first = screen.getByRole('button', { name: '关闭' })
    const last = screen.getByRole('button', { name: '确定' })
    last.focus()
    fireEvent.keyDown(last, { key: 'Tab' })
    expect(first).toHaveFocus()
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true })
    expect(last).toHaveFocus()
  })

  it('焦点跑到弹层外时，Tab 把它拉回弹层', () => {
    openDialog()
    const outside = screen.getByRole('button', { name: '弹层外' })
    outside.focus()
    fireEvent.keyDown(outside, { key: 'Tab' })
    expect(screen.getByRole('button', { name: '关闭' })).toHaveFocus()
  })

  it('Esc 关闭，焦点回到打开它的按钮', () => {
    const { opener } = openDialog()
    fireEvent.keyDown(screen.getByLabelText('名称'), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(opener).toHaveFocus()
  })
})
