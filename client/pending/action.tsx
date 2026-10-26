/**
 * 待处理卡片上的一次动作：借来的会话里发一条 `/memory` 命令。
 * 涉及其他项目时服务端先拒（cross-workspace，什么都没动），卡片里就地写明是哪个项目，用户点「继续处理」才带
 * allowCrossWorkspace 重发。失败把宿主 / 执行器的原话显示在卡片里；条目正在别处处理或刚处理完时交给列表提示（isHandledElsewhere）。
 */
import { useRef, useState, type ReactNode } from 'react'
import type { MemoryCommand, MemoryCommandResult } from '../../src/gui/contract.ts'
import { useGateway, type BorrowedSession } from '../gateway.ts'
import { baseName, useT } from '../i18n.tsx'
import { Button } from '../ui/Button.tsx'
import { keepFocusInPlace, useReturnFocus } from '../ui/focus-return.ts'

export type ActionState =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'error'; detail: string }
  | { kind: 'cross'; workspacePath: string; command: MemoryCommand }
  /** forget 的目标含密钥（服务端回 has-secret，什么都没动）：等用户确认后改发 hard-delete，沿用这条命令指明的那一份。 */
  | { kind: 'secret'; command: Extract<MemoryCommand, { cmd: 'forget' }> }

type Ok = Extract<MemoryCommandResult, { ok: true }>

/** 处理待决项、条目还开着才能做的命令；not-found 对它们只可能是条目已出了待决。 */
const OPEN_ITEM_COMMANDS: ReadonlySet<MemoryCommand['cmd']> = new Set(['resolve', 'promote', 'keep-local', 'dismiss-overflow'])

/**
 * 命令没做任何改动，因为这一条正在别处（别的标签页、宿主进程、体检）处理（claimed），或刚在别处处理完（not-found）。
 * 那边的结果写进视图后卡片随之消失，提示得放在卡片外面，否则用户只看到冲突没了，以为自己的选择生效了。
 * undo 的 not-found 还可能是快照过期，照常显示原话。
 */
export function isHandledElsewhere(command: MemoryCommand, result: MemoryCommandResult): boolean {
  if (result.ok) return false
  return result.code === 'claimed' || (result.code === 'not-found' && OPEN_ITEM_COMMANDS.has(command.cmd))
}

export interface ItemAction {
  state: ActionState
  /** 按钮不可用的原因：没有会话、正在处理、等跨项目确认。 */
  unavailable: string | undefined
  run(command: MemoryCommand): void
  /** 命令以外的失败（打开文件、写配置）也显示在同一处。 */
  fail(detail: string): void
  confirmCross(): void
  /** 取消跨项目确认或彻底删除确认。 */
  cancelCross(): void
  confirmSecret(): void
}

/** onRefused：isHandledElsewhere 为真时调用，卡片里不再显示原话。 */
export function useItemAction(session: BorrowedSession, onOk: (command: MemoryCommand, result: Ok) => void, onRefused?: () => void): ItemAction {
  const t = useT()
  const gateway = useGateway()
  const [state, setState] = useState<ActionState>({ kind: 'idle' })
  const run = (command: MemoryCommand) => {
    if (session.kind !== 'ready') return
    keepFocusInPlace()
    setState({ kind: 'busy' })
    void gateway.execute(session.sessionId, command).then((r) => {
      if (r.ok) { setState({ kind: 'idle' }); onOk(command, r); return }
      if (onRefused !== undefined && isHandledElsewhere(command, r)) { setState({ kind: 'idle' }); onRefused(); return }
      const workspacePath = r.rejected?.[0]?.workspacePath
      const allowed = 'allowCrossWorkspace' in command && command.allowCrossWorkspace === true
      if (r.code === 'cross-workspace' && !allowed && workspacePath !== undefined) setState({ kind: 'cross', workspacePath, command })
      else if (r.code === 'has-secret' && command.cmd === 'forget') setState({ kind: 'secret', command })
      else setState({ kind: 'error', detail: r.detail ?? r.code })
    })
  }
  const unavailable = session.kind !== 'ready' ? t('session.none.hint')
    : state.kind === 'busy' || state.kind === 'cross' || state.kind === 'secret' ? t('pending.busy') : undefined
  return {
    state,
    unavailable,
    run,
    fail: detail => { setState({ kind: 'error', detail }) },
    confirmCross() {
      if (state.kind === 'cross') run({ ...state.command, allowCrossWorkspace: true } as MemoryCommand)
    },
    cancelCross() { setState({ kind: 'idle' }) },
    confirmSecret() {
      if (state.kind === 'secret') run({ ...state.command, cmd: 'hard-delete' })
    },
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
        {/* 焦点移进确认，停在不改动任何东西的「取消」上 */}
        <Button autoFocus onClick={onCancel}>{t('pending.cancel')}</Button>
        <Button onClick={onConfirm}>{t('pending.cross.confirm')}</Button>
      </div>
    </ConfirmGroup>
  )
}

/**
 * 彻底删除的确认：不进最近删除、不能恢复，快照里的副本也抹掉。待处理的密钥卡点「彻底删除…」时出现；
 * 全部记忆、对话交付卡、右侧栏、待处理的建议整理普通删除含密钥的记忆时服务端回 has-secret（什么都没动），也在原位出现，「彻底删除」改发 hard-delete。
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

/** 动作的反馈：跨项目确认行、彻底删除确认（删除的记忆含密钥），或失败原话。 */
export function ActionFeedback({ action }: { action: ItemAction }) {
  const t = useT()
  const { state } = action
  if (state.kind === 'cross') return <CrossConfirm workspacePath={state.workspacePath} onCancel={action.cancelCross} onConfirm={action.confirmCross} />
  if (state.kind === 'secret') return <SecretDeleteConfirm onCancel={action.cancelCross} onConfirm={action.confirmSecret} />
  if (state.kind === 'error') return <p className="pm-pending-error" role="alert">{t('pending.failed', { detail: state.detail })}</p>
  return null
}
