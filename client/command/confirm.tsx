/**
 * 命令往返的确认与反馈：跨项目确认、彻底删除确认、疑似密钥确认、失败与别处已处理的提示（CommandFeedback 按 runner 的状态画），
 * 以及各处删除按钮的原位软删确认。待处理卡、记忆查看、最近删除、对话交付卡、右侧栏共用。
 */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { baseName, useT } from '../i18n.tsx'
import { Button } from '../ui/Button.tsx'
import { useReturnFocus } from '../ui/focus-return.ts'
import type { CommandRunner } from './useCommandRunner.ts'

/**
 * 行内确认的外壳：说明文字 + 按钮组，role=group。收起时把焦点还给打开它的控件，控件没了就落到附近（useReturnFocus）。
 * 跨项目确认、彻底删除确认、疑似密钥确认都用它，各处不再自己管焦点。
 */
export function ConfirmGroup({ label, children }: { label: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  useReturnFocus(ref)
  return <div ref={ref} className="pm-pending-confirm" role="group" aria-label={label}>{children}</div>
}

/** 跨项目确认行：写明记忆属于哪个项目，「取消」或「继续处理」。 */
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
 * 普通删除含密钥的记忆时服务端回 has-secret（什么都没动），也在原位出现（CommandFeedback），「彻底删除」改发 hard-delete。
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

/** 直接改、直接合并的新内容像密钥（服务端回 secret-suspected）：确认不是密钥后「仍然保存」。 */
function SuspectedConfirm({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: () => void }) {
  const t = useT()
  return (
    <ConfirmGroup label={t('pending.edit.saveAnyway')}>
      <p className="pm-pending-text">{t('pending.edit.secretSuspected')}</p>
      <div className="pm-pending-actions">
        <Button autoFocus onClick={onCancel}>{t('pending.cancel')}</Button>
        <Button onClick={onConfirm}>{t('pending.edit.saveAnyway')}</Button>
      </div>
    </ConfirmGroup>
  )
}

/**
 * 一个 key 的反馈，画在动作所在的位置：三种确认，失败（role=alert，正文色），别处已处理（调用方没接走时）。空闲、进行中不画。
 */
export function CommandFeedback({ runner, id }: { runner: CommandRunner; id: string }) {
  const t = useT()
  const state = runner.stateOf(id)
  const cancel = () => { runner.cancel(id) }
  const confirm = () => { runner.confirm(id) }
  switch (state.kind) {
    case 'confirm-cross': return <CrossConfirm workspacePath={state.workspacePath} isMove={state.isMove} onCancel={cancel} onConfirm={confirm} />
    case 'confirm-secret': return <SecretDeleteConfirm onCancel={cancel} onConfirm={confirm} />
    case 'confirm-suspected': return <SuspectedConfirm onCancel={cancel} onConfirm={confirm} />
    case 'failed':
      return <p className="pm-pending-error" role="alert">{t('command.failed', { detail: state.isLocalized ? t(state.detail) : state.detail })}</p>
    case 'handled-elsewhere': return <p className="pm-pending-error" role="status">{t('command.handledElsewhere')}</p>
    default: return null
  }
}

/**
 * 普通删除（软删）的原位确认：对话交付卡、右侧栏、记忆查看、待处理的建议整理卡里，删除按钮的位置换成「删除这条？ 删除 · 取消」，点「删除」才删。
 * 删了还能撤销或去最近删除找回，所以不展开确认块、不用危险样式。取消、Esc、焦点移到这一组以外的控件、在这一组以外按下指针
 * 都收起，什么都不发。焦点没落到任何控件上不算移出：Safari 等点按钮时不给按钮焦点，「取消」会先失焦到页面上，
 * 这时收起就点不到「删除」了；切到别的应用也是这样。「取消」排在最后，落在原来按钮的位置上，连点两下也删不掉；焦点进来时也停在它上面。
 */
export function SoftDeleteConfirm({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: () => void }) {
  const t = useT()
  const ref = useRef<HTMLSpanElement>(null)
  const questionId = useId()
  const cancel = useRef(onCancel)
  cancel.current = onCancel
  useReturnFocus(ref)
  useEffect(() => {
    const doc = ref.current?.ownerDocument
    if (doc === undefined) return
    const onPointer = (event: PointerEvent) => {
      if (!(ref.current?.contains(event.target as Node) ?? false)) cancel.current()
    }
    doc.addEventListener('pointerdown', onPointer, true)
    return () => { doc.removeEventListener('pointerdown', onPointer, true) }
  }, [])
  return (
    <span
      ref={ref}
      className="pm-soft-confirm"
      role="group"
      aria-labelledby={questionId}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        event.preventDefault()
        event.stopPropagation()
        onCancel()
      }}
      onBlur={(event) => {
        const next = event.relatedTarget as Node | null
        if (next !== null && !event.currentTarget.contains(next)) onCancel()
      }}
    >
      <span id={questionId} className="pm-soft-confirm-text">{t('pending.softDelete.question')}</span>
      <button type="button" className="pm-link" onClick={onConfirm}>{t('pending.softDelete.confirm')}</button>
      <i className="pm-sep" aria-hidden="true">·</i>
      <button type="button" className="pm-link pm-soft-confirm-cancel" autoFocus onClick={onCancel}>{t('pending.cancel')}</button>
    </span>
  )
}

/**
 * 删除按钮连同它的原位确认：`trigger` 画按钮，点了调 `open` 换成 SoftDeleteConfirm，点「删除」才调 `onDelete`。
 * 确认开没开记在这个控件自己身上，跟着这一行走：行删掉了、从列表里没了就一起卸载，记忆撤销或恢复回来时是按钮，不会带着没收起的确认抢焦点。
 */
export function DeleteWithConfirm({ trigger, onDelete }: { trigger: (open: () => void) => ReactNode; onDelete: () => void }) {
  const [isOpen, setOpen] = useState(false)
  if (!isOpen) return <>{trigger(() => { setOpen(true) })}</>
  return <SoftDeleteConfirm onCancel={() => { setOpen(false) }} onConfirm={() => { setOpen(false); onDelete() }} />
}

/**
 * 确认块与反馈的样式；待处理卡的说明文字和按钮组也用这两个类。失败与别处已处理的基础样式（正文色、无外边距）在这里，
 * 各处的间距由所在的布局给。软删确认（SoftDeleteConfirm）的样式也在这里，各处共用。
 */
export const confirmCss = `
.pm-pending-text { margin: 0; font-size: 12px; line-height: 1.5; color: var(--pm-text-2); }
.pm-pending-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
.pm-pending-confirm-title { font-weight: 600; color: var(--pm-text); }
.pm-pending-confirm { display: flex; flex-direction: column; gap: 8px; padding: 12px; border-radius: var(--dsw-radius-md, 12px); background: var(--pm-bg-block); }
.pm-pending-error { margin: 0; font-size: 12px; line-height: 1.5; color: var(--pm-text); }
.pm-soft-confirm {
  display: inline-flex; flex: none; align-items: center; min-height: 24px; gap: 8px;
  font-size: 12px; line-height: 1.5; white-space: nowrap; color: var(--pm-text-2);
}
.pm-soft-confirm .pm-sep { margin: 0 -2px; }
.pm-soft-confirm .pm-link { font-size: 12px; }
.pm-soft-confirm .pm-soft-confirm-cancel { font-weight: 400; color: var(--pm-text-2); }
.pm-soft-confirm .pm-soft-confirm-cancel:hover { color: var(--pm-text); text-decoration: none; }
`
