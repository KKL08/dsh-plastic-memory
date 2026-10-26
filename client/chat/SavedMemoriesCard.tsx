/**
 * 折叠区外的交付卡（DESIGN.md「Navigation & Entries」）：「这一轮记住了 N 条」，每条一张记忆卡，行尾垃圾桶图标
 * （软删 `/memory forget`，可撤销，不用红），删后原位留「已删除。14 天内也能在最近删除里找回。」和「撤销」；
 * 每条右下角「查看详情 ›」（次文字色、常规字重）打开记忆页「记忆查看」并定位到这一条（故事 41）。
 * 含密钥的记忆不能软删（服务端回 has-secret，什么都没动）：原位确认，「彻底删除」发 hard-delete，删后只留不可恢复的说明、没有撤销。
 * 删没删读网关的删除状态：在右侧栏、全部记忆里删了同一条，或 agent 在对话里删了它，这里也换成删后的样子。
 * 密钥不会出现在这里：记忆卡在 savedMemoryCard 里已遮盖，口径比视图宽（疑似密钥也遮，见 tool-summary.ts）。
 */
import { useMemo, useState } from 'react'
import { layerOfMemory, type GuiLayerRef } from '../../src/gui/contract.ts'
import { useGateway, type BorrowedSession } from '../gateway.ts'
import { useT } from '../i18n.tsx'
import type { NavTarget } from '../nav.ts'
import { Button } from '../ui/Button.tsx'
import { useTypeLabel } from '../library/shared.tsx'
import { MemoryCard } from '../ui/MemoryCard.tsx'
import { keepFocusInPlace } from '../ui/focus-return.ts'
import { TrashIcon } from '../ui/TrashIcon.tsx'
import { crossConfirmCss, SecretDeleteConfirm } from '../pending/action.tsx'
import type { SavedMemory } from './saved-turn.ts'

/** 这一行自己的进行中 / 失败 / 等确认；删没删读网关的删除状态（别处删的也算，交付卡卸载重挂也还在）。 */
type RowState =
  | { kind: 'idle' } | { kind: 'busy' } | { kind: 'failed'; detail: string }
  /** 等用户确认彻底删除（含密钥）。 */
  | { kind: 'secret' }

export interface SavedMemoriesCardProps {
  sessionId: string
  /** 会话的工作目录：本项目记忆的「查看详情」落在这个作用域。 */
  cwd: string | undefined
  saved: readonly SavedMemory[]
  now: number
  /** 打开记忆页（入口先写导航目标再切面板）。 */
  openDetail: (target: NavTarget) => void
}

function SavedRow({ sessionId, item, now, typeLabel, onDetail }: {
  sessionId: string
  item: SavedMemory
  now: number
  typeLabel: (type: string) => string
  onDetail: () => void
}) {
  const t = useT()
  const gateway = useGateway()
  const id = item.memory.id
  // 记下的时刻取记忆卡上的（结果事件的时间）；没有就用这一行第一次出现的时刻。只有晚于它的视图才拿来判彻底删除
  const [firstSeen] = useState(() => Date.now())
  const savedAt = Number.isFinite(item.memory.updatedAt) && item.memory.updatedAt > 0 ? item.memory.updatedAt : firstSeen
  const how = gateway.useDeletions().of(id, savedAt)
  const [state, setState] = useState<RowState>({ kind: 'idle' })
  const run = async (cmd: 'forget' | 'restore' | 'hard-delete') => {
    if (state.kind === 'busy') return
    keepFocusInPlace()
    setState({ kind: 'busy' })
    const result = await gateway.execute(sessionId, { cmd, memoryId: id, layer: layerOfMemory(item.memory) })
    if (result.ok) setState({ kind: 'idle' })
    else if (cmd === 'forget' && result.code === 'has-secret') setState({ kind: 'secret' })
    // 撤销失败时那一行还是「已删除」，不另写原因
    else setState(cmd === 'restore' ? { kind: 'idle' } : { kind: 'failed', detail: result.detail ?? result.code })
  }
  if (how === 'hard') {
    return (
      <div className="pm-saved-row pm-saved-row--deleted" data-memory-id={id}>
        <p className="pm-saved-note" tabIndex={-1}>{t('pending.secret.deletedNotice')}</p>
      </div>
    )
  }
  if (how === 'soft' && state.kind !== 'busy') {
    return (
      <div className="pm-saved-row pm-saved-row--deleted" data-memory-id={id}>
        <p className="pm-saved-note">{t('chat.card.deleted')}</p>
        <Button onClick={() => { void run('restore') }}>{t('chat.card.undo')}</Button>
      </div>
    )
  }
  return (
    <div className="pm-saved-row" data-memory-id={id}>
      <div className="pm-saved-main">
        <MemoryCard memory={item.memory} now={now} typeLabel={typeLabel(item.memory.type)} />
        {state.kind === 'failed' ? <p className="pm-saved-note">{t('chat.card.failed', { detail: state.detail })}</p> : null}
        {state.kind === 'secret'
          ? <SecretDeleteConfirm onCancel={() => { setState({ kind: 'idle' }) }} onConfirm={() => { void run('hard-delete') }} />
          : null}
        <div className="pm-saved-foot">
          <button type="button" className="pm-link" onClick={onDetail}>{t('chat.card.detail')}</button>
        </div>
      </div>
      <button
        type="button"
        className="pm-icon-btn"
        aria-label={t('chat.card.delete')}
        title={t('chat.card.delete')}
        aria-disabled={state.kind === 'busy' || state.kind === 'secret' || undefined}
        onClick={() => { if (state.kind !== 'secret') void run('forget') }}
      >
        <TrashIcon />
      </button>
    </div>
  )
}

export function SavedMemoriesCard({ sessionId, cwd, saved, now, openDetail }: SavedMemoriesCardProps) {
  const t = useT()
  const session = useMemo<BorrowedSession>(() => ({ kind: 'ready', sessionId, cwd }), [sessionId, cwd])
  const typeLabel = useTypeLabel(session)
  // 全局记忆落在全局；本项目记忆落在会话的工作目录，不知道工作目录时只带 id
  const detail = (memory: SavedMemory['memory']) => {
    const scope: GuiLayerRef | undefined = memory.scope === 'global' ? { kind: 'global' }
      : cwd === undefined ? undefined : { kind: 'workspace', workspacePath: cwd }
    openDetail({ tab: 'library', ...(scope === undefined ? {} : { scope }), memoryId: memory.id })
  }
  return (
    <section className="pm-saved" aria-label={t('chat.card.title', { count: saved.length })}>
      <h3 className="pm-saved-title">{t('chat.card.title', { count: saved.length })}</h3>
      <div className="pm-saved-list">
        {saved.map(item => (
          <SavedRow
            key={item.callId}
            sessionId={sessionId}
            item={item}
            now={now}
            typeLabel={typeLabel}
            onDetail={() => { detail(item.memory) }}
          />
        ))}
      </div>
    </section>
  )
}

export const savedMemoriesCardCss = crossConfirmCss + `
.pm-saved {
  display: flex; flex-direction: column; gap: 10px; margin: 4px 0; padding: 12px 14px;
  border: 0.5px solid var(--pm-line-card); border-radius: var(--dsw-radius-lg, 16px); background: var(--pm-bg);
}
.pm-saved-title { margin: 0; font-size: 13px; font-weight: 600; line-height: 1.5; color: var(--pm-text); }
.pm-saved-list { display: flex; flex-direction: column; gap: 12px; }
.pm-saved-row { display: flex; align-items: flex-start; gap: 8px; }
.pm-saved-row--deleted { align-items: center; justify-content: space-between; }
.pm-saved-main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.pm-saved-note { margin: 0; font-size: 12px; line-height: 1.5; color: var(--pm-text-2); }
.pm-icon-btn {
  flex: none; display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px;
  padding: 0; border: 0; border-radius: var(--dsw-radius-sm, 8px); background: none; color: var(--pm-text-2); cursor: pointer;
}
.pm-icon-btn svg { width: 14px; height: 14px; }
.pm-icon-btn:hover:not([aria-disabled='true']) { background: var(--pm-hover); color: var(--pm-text); }
.pm-icon-btn[aria-disabled='true'] { opacity: .4; cursor: default; }
.pm-saved-foot { display: flex; justify-content: flex-end; }
.pm-saved-foot .pm-link { font-size: 12px; font-weight: 400; color: var(--pm-text-2); }
.pm-saved-foot .pm-link:hover { color: var(--pm-text); text-decoration: none; }
`
