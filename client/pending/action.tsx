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
  /** 直接改、直接合并的新内容像密钥（服务端回 secret-suspected，什么都没动）：用户确认不是密钥后带 force 重发。 */
  | { kind: 'suspected'; command: EditCommand }

export type EditCommand = Extract<MemoryCommand, { cmd: 'edit-memory' | 'merge-memories' }>

type Ok = Extract<MemoryCommandResult, { ok: true }>

/**
 * 条目还开着才能做的命令：处理待决项的，not-found 只可能是条目已出了待决；按记忆 id 提升为全局的，
 * not-found 只可能是那条记忆已不在那个项目里（别处已提升或删掉）；移到项目的同理，是那条已不在全局；
 * 忽略建议的，not-found 只可能是涉及的记忆已在别处删掉。
 */
const OPEN_ITEM_COMMANDS: ReadonlySet<MemoryCommand['cmd']> = new Set(['resolve', 'promote', 'keep-local', 'dismiss-overflow', 'promote-memory', 'move-memory', 'ignore-advice'])

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
  /** 取消跨项目确认、彻底删除确认或疑似密钥确认。 */
  cancelCross(): void
  confirmSecret(): void
  confirmSuspected(): void
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
      else if (r.code === 'secret-suspected' && (command.cmd === 'edit-memory' || command.cmd === 'merge-memories')) setState({ kind: 'suspected', command })
      // 这几种服务端原话只有中文，界面换成本地文案
      else if (r.code === 'stale') setState({ kind: 'error', detail: t('pending.edit.stale') })
      else if (r.code === 'secret-critical') setState({ kind: 'error', detail: t('pending.edit.secretCritical') })
      else if (r.code === 'target-taken') setState({ kind: 'error', detail: t(command.cmd === 'undo' ? 'pending.move.undoTaken' : 'pending.move.taken') })
      else setState({ kind: 'error', detail: r.detail ?? r.code })
    })
  }
  const unavailable = session.kind !== 'ready' ? t('session.none.hint')
    : state.kind === 'busy' || state.kind === 'cross' || state.kind === 'secret' || state.kind === 'suspected' ? t('pending.busy') : undefined
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
    confirmSuspected() {
      if (state.kind === 'suspected') run({ ...state.command, force: true })
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
export function CrossConfirm({ workspacePath, isMove = false, onCancel, onConfirm }: {
  workspacePath: string
  /** 移到项目：写的是要移去的项目，不是记忆所在的项目。 */
  isMove?: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  const t = useT()
  return (
    <ConfirmGroup label={t('pending.cross.confirm')}>
      <p className="pm-pending-text">{t(isMove ? 'pending.cross.moveBody' : 'pending.cross.body', { name: baseName(workspacePath) })}</p>
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
 * 最近删除里点「彻底删除…」也用它，`body` 换成那里的说明。
 */
export function SecretDeleteConfirm({ onCancel, onConfirm, unavailable, showTitle = true, body }: {
  onCancel: () => void
  onConfirm: () => void
  /** 「彻底删除」暂不可用的原因（密钥卡没有会话、正在处理时）。 */
  unavailable?: string | undefined
  showTitle?: boolean
  /** 说明文字，缺省是密钥条目的那句。 */
  body?: string
}) {
  const t = useT()
  return (
    <ConfirmGroup label={t('pending.secret.confirmDelete')}>
      {showTitle ? <p className="pm-pending-text pm-pending-confirm-title">{t('pending.secret.title')}</p> : null}
      <p className="pm-pending-text">{body ?? t('pending.secret.confirmBody')}</p>
      <div className="pm-pending-actions">
        {/* 默认焦点在「取消」：回车不会手滑删掉 */}
        <Button autoFocus onClick={onCancel}>{t('pending.cancel')}</Button>
        <Button variant="danger" unavailable={unavailable} onClick={onConfirm}>{t('pending.secret.confirmDelete')}</Button>
      </div>
    </ConfirmGroup>
  )
}

/**
 * 普通删除（软删）的原位确认：对话交付卡、右侧栏、记忆查看里，删除按钮的位置换成「删除这条？ 删除 · 取消」，点「删除」才删。
 * 删了还能撤销或去最近删除找回，所以不展开确认块、不用危险样式。取消、Esc、焦点移出这一组都收起，什么都不发；
 * 窗口失焦（切到别的应用）不算移出。「取消」排在最后，落在原来按钮的位置上，连点两下也删不掉；焦点进来时也停在它上面。
 */
export function SoftDeleteConfirm({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: () => void }) {
  const t = useT()
  const ref = useRef<HTMLSpanElement>(null)
  useReturnFocus(ref)
  return (
    <span
      ref={ref}
      className="pm-soft-confirm"
      role="group"
      aria-label={t('pending.softDelete.question')}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        event.preventDefault()
        event.stopPropagation()
        onCancel()
      }}
      onBlur={(event) => {
        const next = event.relatedTarget as Node | null
        // 焦点没落到任何控件上：点了空白处（文档仍有焦点）才收起，切到别的应用不收
        if (next === null ? event.currentTarget.ownerDocument.hasFocus() : !event.currentTarget.contains(next)) onCancel()
      }}
    >
      <span className="pm-soft-confirm-text">{t('pending.softDelete.question')}</span>
      <button type="button" className="pm-link" onClick={onConfirm}>{t('pending.softDelete.confirm')}</button>
      <i className="pm-sep" aria-hidden="true">·</i>
      <button type="button" className="pm-link pm-soft-confirm-cancel" autoFocus onClick={onCancel}>{t('pending.cancel')}</button>
    </span>
  )
}

/** CrossConfirm 的样式；待处理卡的说明文字和按钮组也用这两个类。软删确认（SoftDeleteConfirm）的样式也在这里，三处共用。 */
export const crossConfirmCss = `
.pm-pending-text { margin: 0; font-size: 12px; line-height: 1.5; color: var(--pm-text-2); }
.pm-pending-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
.pm-pending-confirm-title { font-weight: 600; color: var(--pm-text); }
.pm-pending-confirm { display: flex; flex-direction: column; gap: 8px; padding: 12px; border-radius: var(--dsw-radius-md, 12px); background: var(--pm-bg-block); }
.pm-soft-confirm {
  display: inline-flex; flex: none; align-items: center; min-height: 24px; gap: 8px;
  font-size: 12px; line-height: 1.5; white-space: nowrap; color: var(--pm-text-2);
}
.pm-soft-confirm .pm-sep { margin: 0 -2px; }
.pm-soft-confirm .pm-link { font-size: 12px; }
.pm-soft-confirm .pm-soft-confirm-cancel { font-weight: 400; color: var(--pm-text-2); }
.pm-soft-confirm .pm-soft-confirm-cancel:hover { color: var(--pm-text); text-decoration: none; }
`

/** 动作的反馈：跨项目确认行、彻底删除确认（删除的记忆含密钥）、疑似密钥确认（直接改的新内容像密钥），或失败原话。 */
export function ActionFeedback({ action }: { action: ItemAction }) {
  const t = useT()
  const { state } = action
  if (state.kind === 'cross') {
    return <CrossConfirm workspacePath={state.workspacePath} isMove={state.command.cmd === 'move-memory'} onCancel={action.cancelCross} onConfirm={action.confirmCross} />
  }
  if (state.kind === 'secret') return <SecretDeleteConfirm onCancel={action.cancelCross} onConfirm={action.confirmSecret} />
  if (state.kind === 'suspected') {
    return (
      <ConfirmGroup label={t('pending.edit.saveAnyway')}>
        <p className="pm-pending-text">{t('pending.edit.secretSuspected')}</p>
        <div className="pm-pending-actions">
          <Button autoFocus onClick={action.cancelCross}>{t('pending.cancel')}</Button>
          <Button onClick={action.confirmSuspected}>{t('pending.edit.saveAnyway')}</Button>
        </div>
      </ConfirmGroup>
    )
  }
  if (state.kind === 'error') return <p className="pm-pending-error" role="alert">{t('pending.failed', { detail: state.detail })}</p>
  return null
}
