/**
 * 模型用 memory_save 改写、替代已有记忆的就地撤销（对话交付卡、右侧栏「这次新写入的」共用），数据是全部记忆视图的 modelChanges。
 * 改写：记忆卡下方一行开头写「已改写」，后面「改前 / 改后」展开对照；替代：一行「替代了「旧名」」。两种都带「撤销修改」，
 * 按这次改动的 decisionId 发 undo，服务端按改前快照恢复（替代的是让旧记忆回到在用，替代它的那条不动）。撤销不删任何记忆，不用原位确认。
 * 之后又被改过（手改、模型再改、删除）的不覆盖：视图标 changed、或撤销回 stale，按钮换成「之后又改过，没法直接撤销」；
 * 改前快照过了 14 天（视图里已不列、调用时刻超出保留窗口）换成「改前版本已超过 14 天，无法恢复」；撤销过的写「已撤销」。
 * 这里撤销的结果只顶到视图下一次变化为止，之后跟着视图走。
 */
import { useId, useState } from 'react'
import type { MemoryCard, ModelChange, ModelChangeState } from '../../src/gui/contract.ts'
import { useGateway, type BorrowedSession } from '../gateway.ts'
import { useT } from '../i18n.tsx'
import { Button } from '../ui/Button.tsx'
import { keepFocusInPlace } from '../ui/focus-return.ts'

/** expired：视图里已没有这次改动、且已过保留窗口（只有对话卡会遇到）。 */
type Shown = ModelChangeState | 'expired'

/**
 * 一次改动的就地说明与撤销。change 为 'expired' 时只写过期说明（对话卡认不出自己那次改动、调用时刻已超出保留窗口）。
 * after：改写后的那份（对话卡取工具参数，右侧栏取全部记忆视图），改前 / 改后对照用；bySubject：右侧栏替代行写明是谁替代的；
 * count：过期的替代不知道旧记忆叫什么，按条数写。
 */
export function ModelChangeLine({ session, change, kind, after, bySubject, count = 1 }: {
  session: BorrowedSession
  change: ModelChange | 'expired'
  /** change 为 'expired' 时这是哪一种改动。 */
  kind: ModelChange['kind']
  after?: MemoryCard | undefined
  bySubject?: string | undefined
  count?: number
}) {
  const t = useT()
  const gateway = useGateway()
  const diffId = useId()
  const [isOpen, setOpen] = useState(false)
  const [local, setLocal] = useState<'busy' | ModelChangeState | { failed: string } | undefined>(undefined)
  const viewState: Shown = change === 'expired' ? 'expired' : change.state
  // 视图一变就以视图为准
  const [seen, setSeen] = useState(viewState)
  if (seen !== viewState) {
    setSeen(viewState)
    setLocal(undefined)
  }
  const shown: Shown = local === undefined || local === 'busy' || typeof local === 'object' ? viewState : local
  const undo = async () => {
    if (change === 'expired' || local === 'busy' || session.kind !== 'ready') return
    keepFocusInPlace()
    setLocal('busy')
    const r = await gateway.execute(session.sessionId, { cmd: 'undo', decisionId: change.decisionId })
    if (r.ok) setLocal('undone')
    else if (r.code === 'stale') setLocal('changed')
    else setLocal({ failed: r.detail ?? r.code })
  }
  const before = change === 'expired' ? undefined : change.before
  const status = shown === 'undoable'
    ? (
      <Button className="pm-change-undo" unavailable={local === 'busy' ? t('pending.busy') : session.kind !== 'ready' ? t('session.none.hint') : undefined} onClick={() => { void undo() }}>
        {t('chat.change.undo')}
      </Button>
    )
    : <span className="pm-change-note" role="status">{t(shown === 'undone' ? 'chat.change.undone' : shown === 'changed' ? 'chat.change.changed' : 'chat.change.expired')}</span>
  const subject = before === undefined ? t(count === 1 ? 'chat.change.supersededOlder.one' : 'chat.change.supersededOlder', { count })
    : bySubject === undefined ? t('chat.change.superseded', { name: before.name }) : t('chat.change.supersededBy', { by: bySubject, name: before.name })
  return (
    <div className="pm-change" data-change={kind}>
      <div className="pm-change-head">
        {kind === 'rewrite'
          ? (
            <span className="pm-change-lead">
              <span className="pm-change-text">{t('chat.change.rewritten')}</span>
              {before !== undefined && after !== undefined
                ? (
                  <button type="button" className="pm-link pm-change-toggle" aria-expanded={isOpen} aria-controls={diffId} onClick={() => { setOpen(!isOpen) }}>
                    {t('chat.change.compare')}
                  </button>
                )
                : null}
            </span>
          )
          : <span className="pm-change-text">{subject}</span>}
        {status}
      </div>
      {typeof local === 'object' ? <p className="pm-change-error" role="alert">{t('chat.card.failed', { detail: local.failed })}</p> : null}
      {kind === 'rewrite' && before !== undefined && after !== undefined
        ? (
          <dl className="pm-change-diff" id={diffId} hidden={!isOpen}>
            <dt>{t('chat.change.before')}</dt>
            <dd>{before.content}</dd>
            <dt>{t('chat.change.after')}</dt>
            <dd>{after.content}</dd>
          </dl>
        )
        : null}
    </div>
  )
}

/** 两处的行都窄：说明与按钮一行，按钮用列表行尾的小号；对照用正文色、保留换行。 */
export const modelChangeCss = `
.pm-change { display: flex; flex-direction: column; gap: 6px; padding-left: 14px; }
.pm-change-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; }
.pm-change-lead { display: flex; align-items: center; gap: 10px; min-width: 0; }
.pm-change-text { min-width: 0; font-size: 12px; line-height: 1.5; color: var(--pm-text); overflow-wrap: anywhere; }
.pm-change-toggle { font-size: 12px; font-weight: 400; color: var(--pm-text-2); }
.pm-change-toggle:hover { color: var(--pm-text); text-decoration: none; }
.pm-change .pm-change-undo { padding: 2px 10px; font-size: 12px; }
.pm-change-note { flex: none; font-size: 12px; line-height: 1.5; color: var(--pm-text-2); }
.pm-change-error { margin: 0; font-size: 12px; line-height: 1.5; color: var(--pm-text); }
.pm-change-diff[hidden] { display: none; }
.pm-change-diff {
  display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 4px 10px; margin: 0; padding: 8px 10px;
  border-radius: var(--dsw-radius-sm, 8px); background: var(--pm-bg-block); font-size: 12px; line-height: 1.5;
}
.pm-change-diff dt { color: var(--pm-text-2); }
.pm-change-diff dd { margin: 0; min-width: 0; color: var(--pm-text); white-space: pre-wrap; overflow-wrap: anywhere; }
`
