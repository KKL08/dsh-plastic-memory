import { act, fireEvent, screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { MemoryCommand, MemoryCommandResult } from '../../src/gui/contract.ts'
import { createFakeGateway } from '../gateway.fake.ts'
import { renderInShell } from '../test-utils.tsx'
import { CommandFeedback } from './confirm.tsx'
import { SAMPLE_COMMANDS } from './test-commands.ts'
import { ItemSending, useCommandRunner, type CommandRunner, type RunHandlers } from './useCommandRunner.ts'

const forget = SAMPLE_COMMANDS.forget

/** 结果由测试放行的命令。 */
function deferred() {
  const pending: Array<(result: MemoryCommandResult) => void> = []
  return {
    respond: () => new Promise<MemoryCommandResult>((resolve) => { pending.push(resolve) }),
    async release(result: MemoryCommandResult) { await act(async () => { pending.shift()!(result) }) },
  }
}

let runner: CommandRunner

/** 两行，各一个按钮、各自的反馈；runner 暴露给测试。 */
function Rows({ command = forget, handlers = {} }: { command?: MemoryCommand; handlers?: RunHandlers }) {
  runner = useCommandRunner({ kind: 'ready', sessionId: 's1', cwd: '/w/app' })
  return (
    <>
      {(['a', 'b'] as const).map(key => (
        <div key={key}>
          <button type="button" aria-disabled={runner.unavailable(key) !== undefined || undefined} onClick={() => { runner.run(key, command, handlers) }}>{`删除 ${key}`}</button>
          <CommandFeedback runner={runner} id={key} />
        </div>
      ))}
    </>
  )
}

const cross = (command: MemoryCommand): MemoryCommandResult => ({ ok: false, cmd: command.cmd, code: 'cross-workspace', rejected: [{ id: 'm1', workspacePath: '/w/blog' }] })

describe('useCommandRunner', () => {
  it('同一个 key 在途时再点不重发；别的 key 照常发', async () => {
    const d = deferred()
    const { gateway } = renderInShell(<Rows />, createFakeGateway({ respond: d.respond }))
    fireEvent.click(screen.getByRole('button', { name: '删除 a' }))
    fireEvent.click(screen.getByRole('button', { name: '删除 a' }))
    expect(gateway.executed).toHaveLength(1)
    expect(runner.unavailable('a')).toBe('正在处理…')
    fireEvent.click(screen.getByRole('button', { name: '删除 b' }))
    expect(gateway.executed).toHaveLength(2)
    await d.release({ ok: true, cmd: 'forget' })
    expect(runner.stateOf('a')).toEqual({ kind: 'idle' })
    fireEvent.click(screen.getByRole('button', { name: '删除 a' }))
    expect(gateway.executed).toHaveLength(3)
  })

  it('跨项目：原位确认，等确认时按钮不可用；「继续处理」发协议给的重发命令，成功回调拿到的是重发的那条', async () => {
    const onOk = vi.fn()
    const { gateway } = renderInShell(<Rows handlers={{ onOk }} />, createFakeGateway({
      respond: command => ('allowCrossWorkspace' in command && command.allowCrossWorkspace === true ? { ok: true, cmd: command.cmd } : cross(command)),
    }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '删除 a' })) })
    expect(screen.getByRole('group', { name: '继续处理' })).toHaveTextContent('blog')
    // 等的是用户回答，不是命令在途
    expect(runner.unavailable('a')).toBe('等你先确认')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '继续处理' })) })
    expect(gateway.executed.map(e => e.command)).toEqual([forget, { ...forget, allowCrossWorkspace: true }])
    expect(onOk).toHaveBeenCalledWith({ ok: true, cmd: 'forget' }, { ...forget, allowCrossWorkspace: true })
    expect(screen.queryByRole('group')).not.toBeInTheDocument()
  })

  it('含密钥：「彻底删除」改发 hard-delete；「取消」收起，什么都不发', async () => {
    const { gateway } = renderInShell(<Rows />, createFakeGateway({
      respond: command => (command.cmd === 'forget' ? { ok: false, cmd: command.cmd, code: 'has-secret' } : { ok: true, cmd: command.cmd }),
    }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '删除 a' })) })
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('group')).not.toBeInTheDocument()
    expect(runner.unavailable('a')).toBeUndefined()
    expect(gateway.executed).toHaveLength(1)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '删除 a' })) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '彻底删除' })) })
    expect(gateway.executed.map(e => e.command.cmd)).toEqual(['forget', 'forget', 'hard-delete'])
  })

  it('另一行开始动作时只收起这一行的消息（失败、别处已处理），等确认的留着；结果回来不碰别的行', async () => {
    const failed = (command: MemoryCommand): MemoryCommandResult => ({ ok: false, cmd: command.cmd, code: 'failed', detail: '磁盘满了' })
    const first = renderInShell(<Rows />, createFakeGateway({ respond: failed }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '删除 a' })) })
    expect(screen.getByRole('alert')).toHaveTextContent('没有成功：磁盘满了')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '删除 b' })) })
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(runner.stateOf('a')).toEqual({ kind: 'idle' })
    first.unmount()

    // a 等确认时 b 开始、b 失败：a 的确认一直开着
    const later = deferred()
    let calls = 0
    renderInShell(<Rows />, createFakeGateway({ respond: command => (calls++ === 0 ? cross(command) : later.respond()) }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '删除 a' })) })
    expect(runner.stateOf('a').kind).toBe('confirm-cross')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '删除 b' })) })
    expect(runner.stateOf('a').kind).toBe('confirm-cross')
    await later.release(failed(forget))
    expect(runner.stateOf('a').kind).toBe('confirm-cross')
    expect(screen.getByRole('button', { name: '继续处理' })).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('没有成功：磁盘满了')
  })

  it('两行同时在途：先回来的失败不会被后回来的结果收起', async () => {
    const later = deferred()
    renderInShell(<Rows />, createFakeGateway({ respond: later.respond }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '删除 a' })) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '删除 b' })) })
    await later.release({ ok: false, cmd: 'forget', code: 'failed', detail: 'a 失败' })
    await later.release({ ok: false, cmd: 'forget', code: 'failed', detail: 'b 失败' })
    expect(screen.getAllByRole('alert').map(a => a.textContent)).toEqual(['没有成功：a 失败', '没有成功：b 失败'])
  })

  it('别处已处理：调用方接走时不在原位画；没接走时原位写一句', async () => {
    const respond = (command: MemoryCommand): MemoryCommandResult => ({ ok: false, cmd: command.cmd, code: 'claimed', detail: '正在被另一次操作处理' })
    const onHandledElsewhere = vi.fn()
    const first = renderInShell(<Rows handlers={{ onHandledElsewhere }} />, createFakeGateway({ respond }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '删除 a' })) })
    expect(onHandledElsewhere).toHaveBeenCalledOnce()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    first.unmount()
    renderInShell(<Rows />, createFakeGateway({ respond }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '删除 a' })) })
    expect(screen.getByRole('status')).toHaveTextContent('这次操作没有生效')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('失败的显式选项：silent 不显示；函数接走（返回 true）不显示，没接走照常显示', async () => {
    const respond = (command: MemoryCommand): MemoryCommandResult => ({ ok: false, cmd: command.cmd, code: 'stale', detail: '又改过' })
    const first = renderInShell(<Rows handlers={{ onFailed: 'silent' }} />, createFakeGateway({ respond }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '删除 a' })) })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    first.unmount()
    const seen: string[] = []
    renderInShell(<Rows handlers={{ onFailed: (f) => { seen.push(f.code ?? ''); return f.code === 'stale' } }} />, createFakeGateway({ respond }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '删除 a' })) })
    expect(seen).toEqual(['stale'])
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('高危密钥在发出前拦下：不发，原位写本地文案', async () => {
    const edit = { ...SAMPLE_COMMANDS['edit-memory'], content: `发版用 ${'sk-' + 'TESTONLY'.padEnd(24, 'a')}` }
    const { gateway } = renderInShell(<Rows command={edit} />)
    fireEvent.click(screen.getByRole('button', { name: '删除 a' }))
    expect(gateway.executed).toEqual([])
    expect(screen.getByRole('alert')).toHaveTextContent('内容里有高危密钥，没有保存。')
  })

  it('列表的发送回调：发出报 true，结果回来先报 false 再调成功回调', async () => {
    const d = deferred()
    const calls: string[] = []
    renderInShell(
      <ItemSending.Provider value={(isSending) => { calls.push(`sending:${isSending}`) }}>
        <Rows handlers={{ onOk: () => { calls.push('ok') } }} />
      </ItemSending.Provider>,
      createFakeGateway({ respond: d.respond }),
    )
    fireEvent.click(screen.getByRole('button', { name: '删除 a' }))
    expect(calls).toEqual(['sending:true'])
    await d.release({ ok: true, cmd: 'forget' })
    expect(calls).toEqual(['sending:true', 'sending:false', 'ok'])
  })

  it('没有会话：不发，按钮写先开会话', () => {
    function NoSession() {
      const r = useCommandRunner({ kind: 'none' })
      return <button type="button" title={r.unavailable('a')} onClick={() => { r.run('a', forget) }}>删除</button>
    }
    const { gateway } = renderInShell(<NoSession />)
    fireEvent.click(screen.getByRole('button'))
    expect(gateway.executed).toEqual([])
    expect(screen.getByRole('button')).toHaveAttribute('title', '先开一个会话')
  })

  it('焦点：点的那个控件在成功后消失，焦点落到附近同名的控件上，不掉到页面上', async () => {
    function Removable() {
      const r = useCommandRunner({ kind: 'ready', sessionId: 's1', cwd: '/w/app' })
      const [rows, setRows] = useState(['a', 'b'])
      return (
        <ul>
          {rows.map(key => (
            <li key={key}>
              <button type="button" onClick={() => { r.run(key, forget, { onOk: () => { setRows(prev => prev.filter(k => k !== key)) } }) }}>删除</button>
            </li>
          ))}
        </ul>
      )
    }
    renderInShell(<Removable />)
    const [first] = screen.getAllByRole('button', { name: '删除' })
    first!.focus()
    await act(async () => { fireEvent.click(first!) })
    await act(async () => {})
    expect(screen.getAllByRole('button', { name: '删除' })).toHaveLength(1)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '删除' }))
  })
})
