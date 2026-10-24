/**
 * 待处理卡片上的一次动作：借来的会话里发一条 `/memory` 命令。
 * 涉及其他项目时服务端先拒（cross-workspace，什么都没动），卡片里就地写明是哪个项目，用户点「继续处理」才带
 * allowCrossWorkspace 重发。失败把宿主 / 执行器的原话显示在卡片里。
 */
import { useState } from 'react'
import type { MemoryCommand, MemoryCommandResult } from '../../src/gui/contract.ts'
import { useGateway, type BorrowedSession } from '../gateway.ts'
import { baseName, useT } from '../i18n.tsx'
import { Button } from '../ui/Button.tsx'

export type ActionState =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'error'; detail: string }
  | { kind: 'cross'; workspacePath: string; command: MemoryCommand }

type Ok = Extract<MemoryCommandResult, { ok: true }>

export interface ItemAction {
  state: ActionState
  /** 按钮不可用的原因：没有会话、正在处理、等跨项目确认。 */
  unavailable: string | undefined
  run(command: MemoryCommand): void
  /** 命令以外的失败（打开文件、写配置）也显示在同一处。 */
  fail(detail: string): void
  confirmCross(): void
  cancelCross(): void
}

export function useItemAction(session: BorrowedSession, onOk: (command: MemoryCommand, result: Ok) => void): ItemAction {
  const t = useT()
  const gateway = useGateway()
  const [state, setState] = useState<ActionState>({ kind: 'idle' })
  const run = (command: MemoryCommand) => {
    if (session.kind !== 'ready') return
    setState({ kind: 'busy' })
    void gateway.execute(session.sessionId, command).then((r) => {
      if (r.ok) { setState({ kind: 'idle' }); onOk(command, r); return }
      const workspacePath = r.rejected?.[0]?.workspacePath
      const allowed = 'allowCrossWorkspace' in command && command.allowCrossWorkspace === true
      if (r.code === 'cross-workspace' && !allowed && workspacePath !== undefined) setState({ kind: 'cross', workspacePath, command })
      else setState({ kind: 'error', detail: r.detail ?? r.code })
    })
  }
  const unavailable = session.kind !== 'ready' ? t('session.none.hint')
    : state.kind === 'busy' || state.kind === 'cross' ? t('pending.busy') : undefined
  return {
    state,
    unavailable,
    run,
    fail: detail => { setState({ kind: 'error', detail }) },
    confirmCross() {
      if (state.kind === 'cross') run({ ...state.command, allowCrossWorkspace: true } as MemoryCommand)
    },
    cancelCross() { setState({ kind: 'idle' }) },
  }
}

/** 跨项目确认行：写明记忆属于哪个项目，「取消」或「继续处理」。待处理卡和全部记忆 / 最近删除的行共用。 */
export function CrossConfirm({ workspacePath, onCancel, onConfirm }: { workspacePath: string; onCancel: () => void; onConfirm: () => void }) {
  const t = useT()
  return (
    <div className="pm-pending-confirm" role="group" aria-label={t('pending.cross.confirm')}>
      <p className="pm-pending-text">{t('pending.cross.body', { name: baseName(workspacePath) })}</p>
      <div className="pm-pending-actions">
        <Button onClick={onCancel}>{t('pending.cancel')}</Button>
        <Button onClick={onConfirm}>{t('pending.cross.confirm')}</Button>
      </div>
    </div>
  )
}

/** CrossConfirm 的样式；待处理卡的说明文字和按钮组也用这两个类。 */
export const crossConfirmCss = `
.pm-pending-text { margin: 0; font-size: 12px; line-height: 1.5; color: var(--pm-text-2); }
.pm-pending-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
.pm-pending-confirm { display: flex; flex-direction: column; gap: 8px; padding: 12px; border-radius: var(--dsw-radius-md, 12px); background: var(--pm-bg-block); }
`

/** 动作的反馈：跨项目确认行，或失败原话。 */
export function ActionFeedback({ action }: { action: ItemAction }) {
  const t = useT()
  const { state } = action
  if (state.kind === 'cross') return <CrossConfirm workspacePath={state.workspacePath} onCancel={action.cancelCross} onConfirm={action.confirmCross} />
  if (state.kind === 'error') return <p className="pm-pending-error" role="alert">{t('pending.failed', { detail: state.detail })}</p>
  return null
}
