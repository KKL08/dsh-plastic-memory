import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import type { MemoryCard, MemoryCommandResult } from '../../src/gui/contract.ts'
import { createFakeGateway, type FakeGatewayInit } from '../gateway.fake.ts'
import { createTranslator } from '../i18n.tsx'
import { zh } from '../locales.ts'
import { memory } from '../test-utils.tsx'
import { PanelShell } from '../ui/PanelShell.tsx'
import { EDIT_MODE_STORAGE_KEY, EditModes, readEditMode } from './edit-modes.tsx'
import { EditPanel } from './edit.tsx'
import { ModelEditPanel } from './model-edit.tsx'

// 两段切换的外壳单独测：方式偏好的本地存储、目标版本变了丢弃晚到的结果。挂在卡片上的行为见 PendingTab.spec.tsx。

const SESSION = { kind: 'ready', sessionId: 's1', cwd: '/w/app' } as const
const target = memory({ id: 'b1', name: '发版流程', content: '先跑测试，再打包，再发版。', digest: 'sha1:b1', updatedAt: 111 })
const draftOf = (target: MemoryCard) => ({ content: target.content, name: target.name, summary: target.summary, tags: target.tags })

function Panel({ card, onClose = () => {}, unavailable, onSend = () => {} }: { card: MemoryCard; onClose?: () => void; unavailable?: string; onSend?: () => void }) {
  return (
    <EditModes
      onClose={onClose}
      model={report => (
        <ModelEditPanel
          memories={[card]}
          adviceType="bloat"
          typeTitle="内容过长"
          base={draftOf(card)}
          session={SESSION}
          unavailable={unavailable}
          onClose={onClose}
          onApply={onSend}
          onStateChange={report}
        />
      )}
      manual={report => (
        <EditPanel
          initial={draftOf(card)}
          original={{ content: card.content, summary: card.summary, chars: card.content.length }}
          isMerge={false}
          unavailable={unavailable}
          onCancel={onClose}
          onSave={onSend}
          onStateChange={report}
        />
      )}
    />
  )
}

function setup(card: MemoryCard = target, respond?: FakeGatewayInit['respond']) {
  const gateway = createFakeGateway({ session: SESSION, respond })
  const wrap = (c: MemoryCard) => <PanelShell gateway={gateway} t={createTranslator(zh)}><Panel card={c} /></PanelShell>
  const utils = render(wrap(card))
  return { gateway, rerender: (c: MemoryCard) => { utils.rerender(wrap(c)) } }
}

const tab = (name: string) => screen.getByRole('tab', { name })

describe('两段切换的方式偏好（故事 2a）', () => {
  beforeEach(() => { localStorage.clear() })
  afterEach(() => { vi.restoreAllMocks(); localStorage.clear() })

  it('没存过、存的不是认得的值：按默认「让模型改」', () => {
    expect(readEditMode()).toBe('model')
    localStorage.setItem(EDIT_MODE_STORAGE_KEY, 'something-else')
    expect(readEditMode()).toBe('model')
    localStorage.setItem(EDIT_MODE_STORAGE_KEY, 'manual')
    expect(readEditMode()).toBe('manual')
  })

  it('本地存储读不了：按默认打开；写不进：照样能切，只是记不住', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied') })
    setup()
    expect(tab('让模型改')).toHaveAttribute('aria-selected', 'true')
    fireEvent.click(tab('手动改'))
    expect(tab('手动改')).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('textbox', { name: '正文' })).toBeInTheDocument()
  })

  it('切换时写进本地存储', () => {
    setup()
    fireEvent.click(tab('手动改'))
    expect(localStorage.getItem(EDIT_MODE_STORAGE_KEY)).toBe('manual')
    fireEvent.click(tab('让模型改'))
    expect(localStorage.getItem(EDIT_MODE_STORAGE_KEY)).toBe('model')
  })
})

describe('两段切换的焦点与关闭（故事 2b）', () => {
  beforeEach(() => { localStorage.clear() })

  it('打开时焦点在选中那一侧的输入框；没选中的一侧 hidden，里面的控件不进焦点顺序', () => {
    setup()
    expect(screen.getByRole('textbox', { name: /想怎么改/ })).toHaveFocus()
    const manual = document.getElementById(tab('手动改').getAttribute('aria-controls')!)!
    expect(manual).toHaveAttribute('hidden')
    expect(manual).toHaveAttribute('role', 'tabpanel')
    expect(screen.queryByRole('textbox', { name: '正文' })).toBeNull()

    localStorage.setItem(EDIT_MODE_STORAGE_KEY, 'manual')
    setup()
    expect(screen.getAllByRole('textbox', { name: '正文' })[0]).toHaveFocus()
  })

  it('Esc 关闭整个面板；输入法选词时的 Esc 不算', () => {
    const onClose = vi.fn()
    const gateway = createFakeGateway({ session: SESSION })
    render(<PanelShell gateway={gateway} t={createTranslator(zh)}><Panel card={target} onClose={onClose} /></PanelShell>)
    const box = screen.getByRole('textbox', { name: /想怎么改/ })
    fireEvent.keyDown(box, { key: 'Escape', isComposing: true })
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.keyDown(box, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('模型一侧的请求序号', () => {
  beforeEach(() => { localStorage.clear() })

  it('生成中目标记忆的版本变了：回到写要求，旧结果晚到直接丢弃', async () => {
    let resolve: (r: MemoryCommandResult) => void = () => {}
    const { rerender } = setup(target, () => new Promise<MemoryCommandResult>((r) => { resolve = r }))
    fireEvent.change(screen.getByRole('textbox', { name: /想怎么改/ }), { target: { value: '短一点' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '生成修改' })) })
    expect(screen.getByText('正在生成修改……')).toBeInTheDocument()
    rerender({ ...target, content: '别处改的', updatedAt: 222, digest: 'sha1:b1x' })
    expect(screen.getByRole('textbox', { name: /想怎么改/ })).toHaveValue('短一点')
    await act(async () => { resolve({ ok: true, cmd: 'draft-edit', draft: { content: '先跑单测。', summary: 's' } } as MemoryCommandResult) })
    expect(screen.queryByRole('region', { name: '改后' })).toBeNull()
    expect(screen.getByRole('button', { name: '生成修改' })).toBeInTheDocument()
  })
})

describe('编辑器报告的状态', () => {
  beforeEach(() => { localStorage.clear() })

  it('故事 2：「再改改」后还没写新要求，上一稿没应用，仍算有未保存的内容', async () => {
    const onStateChange = vi.fn()
    const gateway = createFakeGateway({ session: SESSION, respond: () => ({ ok: true, cmd: 'draft-edit', draft: { content: '先跑单测。', summary: 's' } }) })
    render(
      <PanelShell gateway={gateway} t={createTranslator(zh)}>
        <ModelEditPanel memories={[target]} adviceType="bloat" typeTitle="内容过长" base={draftOf(target)} session={SESSION} unavailable={undefined} onClose={() => {}} onApply={() => {}} onStateChange={onStateChange} />
      </PanelShell>,
    )
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '生成修改' })) })
    expect(onStateChange).toHaveBeenLastCalledWith({ phase: 'result', isDirty: true })
    fireEvent.click(screen.getByRole('button', { name: '再改改' }))
    expect(screen.getByRole('textbox', { name: /想怎么改/ })).toHaveValue('')
    expect(onStateChange).toHaveBeenLastCalledWith({ phase: 'idle', isDirty: true })
  })
})

describe('点过保存、应用之后命令回来了', () => {
  beforeEach(() => { localStorage.clear() })
  const draft: MemoryCommandResult = { ok: true, cmd: 'draft-edit', draft: { content: '先跑单测。', summary: 's' } }
  /** 卡片的忙状态：点保存、应用时同一批更新里忙起来（同 useCommandRunner），之后由测试改。 */
  function setupBusy() {
    const onClose = vi.fn()
    const gateway = createFakeGateway({ session: SESSION, respond: () => draft })
    let setUnavailable: (unavailable: string | undefined) => void = () => {}
    function Card() {
      const [unavailable, set] = useState<string>()
      setUnavailable = set
      return <Panel card={target} onClose={onClose} unavailable={unavailable} onSend={() => { set('正在处理…') }} />
    }
    render(<PanelShell gateway={gateway} t={createTranslator(zh)}><Card /></PanelShell>)
    return { onClose, rerender: (unavailable: string | undefined) => { act(() => { setUnavailable(unavailable) }) } }
  }

  it('手动改：保存中切换控件置灰、Esc 不关；保存失败（或确认被取消）后复位，之后卡片因别的原因忙着，切换控件可用、Esc 照常关', () => {
    localStorage.setItem(EDIT_MODE_STORAGE_KEY, 'manual')
    const { onClose, rerender } = setupBusy()
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(tab('让模型改')).toBeDisabled()
    fireEvent.keyDown(screen.getAllByRole('textbox', { name: '正文' })[0]!, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
    rerender(undefined)
    rerender('借来的会话不可用')
    expect(tab('让模型改')).not.toBeDisabled()
    fireEvent.keyDown(screen.getAllByRole('textbox', { name: '正文' })[0]!, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('让模型改：应用中 Esc 不关；应用失败后复位，之后卡片因别的原因忙着，Esc 照常关', async () => {
    const { onClose, rerender } = setupBusy()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '生成修改' })) })
    fireEvent.click(screen.getByRole('button', { name: '应用' }))
    const result = screen.getByRole('region', { name: '改后' })
    fireEvent.keyDown(result, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
    rerender(undefined)
    rerender('借来的会话不可用')
    fireEvent.keyDown(screen.getByRole('region', { name: '改后' }), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
