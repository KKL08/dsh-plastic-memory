/**
 * 待处理卡片上的一次动作：借来的会话里发一条 `/memory` 命令。
 * 涉及其他项目时服务端先拒（cross-workspace，什么都没动），卡片里就地写明是哪个项目，用户点「继续处理」才带
 * allowCrossWorkspace 重发。失败把宿主 / 执行器的原话显示在卡片里。
 */
import { useRef, useState, type ReactNode } from 'react'
import type { MemoryCommand, MemoryCommandResult } from '../../src/gui/contract.ts'
import { useGateway, type BorrowedSession } from '../gateway.ts'
import { baseName, useT } from '../i18n.tsx'
import { Button } from '../ui/Button.tsx'
import { useReturnFocus } from '../ui/focus-return.ts'

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

/**
 * 行内确认的外壳：说明文字 + 按钮组，role=group。收起时把焦点还给打开它的控件，控件没了就落到附近（useReturnFocus）。
 * 跨项目确认和彻底删除确认都用它，各处不再自己管焦点。
 */
function ConfirmGroup({ label, children }: { label: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  useReturnFocus(ref)
  return <div ref={ref} className="pm-pending-confirm" role="group" aria-label={label}>{children}</div>
}

/** 跨项目确认行：写明记忆属于哪个项目，「取消」或「继续处理」。待处理卡和全部记忆 / 最近删除的行共用。 */
export function CrossConfirm({ workspacePath, onCancel, onConfirm }: { workspacePath: string; onCancel: () => void; onConfirm: () => void }) {
  const t = useT()
  return (
    <ConfirmGroup label={t('pending.cross.confirm')}>
      <p className="pm-pending-text">{t('pending.cross.body', { name: baseName(workspacePath) })}</p>
      <div className="pm-pending-actions">
        <Button onClick={onCancel}>{t('pending.cancel')}</Button>
        <Button onClick={onConfirm}>{t('pending.cross.confirm')}</Button>
      </div>
    </ConfirmGroup>
  )
}

/**
 * 彻底删除的确认：不进最近删除、不能恢复，快照里的副本也抹掉。待处理的密钥卡点「彻底删除…」时出现；
 * 全部记忆、对话交付卡、右侧栏普通删除含密钥的记忆时服务端回 has-secret（什么都没动），也在原位出现，「彻底删除」改发 hard-delete。
 * 密钥卡标题已写明有密钥，`showTitle={false}`；其余地方用户只点了删除，先补一行「这条记忆里有密钥」说明为什么。
 */
export function SecretDeleteConfirm({ onCancel, onConfirm, unavailable, showTitle = true }: {
  onCancel: () => void
  onConfirm: () => void
  /** 「彻底删除」暂不可用的原因（密钥卡没有会话、正在处理时）。 */
  unavailable?: string | undefined
  showTitle?: boolean
}) {
  const t = useT()
  return (
    <ConfirmGroup label={t('pending.secret.confirmDelete')}>
      {showTitle ? <p className="pm-pending-text pm-pending-confirm-title">{t('pending.secret.title')}</p> : null}
      <p className="pm-pending-text">{t('pending.secret.confirmBody')}</p>
      <div className="pm-pending-actions">
        {/* 默认焦点在「取消」：回车不会手滑删掉 */}
        <Button autoFocus onClick={onCancel}>{t('pending.cancel')}</Button>
        <Button variant="danger" unavailable={unavailable} onClick={onConfirm}>{t('pending.secret.confirmDelete')}</Button>
      </div>
    </ConfirmGroup>
  )
}

/** CrossConfirm 的样式；待处理卡的说明文字和按钮组也用这两个类。 */
export const crossConfirmCss = `
.pm-pending-text { margin: 0; font-size: 12px; line-height: 1.5; color: var(--pm-text-2); }
.pm-pending-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
.pm-pending-confirm-title { font-weight: 600; color: var(--pm-text); }
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
