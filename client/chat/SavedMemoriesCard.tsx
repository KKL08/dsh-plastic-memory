/**
 * 折叠区外的交付卡（DESIGN.md「Navigation & Entries」）：「这一轮记住了 N 条」，每条一张记忆卡，行尾垃圾桶图标
 * （软删 `/memory forget`，可撤销，不用红），删后原位留「已删除。14 天内也能在最近删除里找回。」和「撤销」；
 * 右下角「查看详情 ›」（次文字色、常规字重）打开记忆页「全部记忆」并定位到这一条。
 * 密钥不会出现在这里：厂商格式写入时就被拒，疑似的写入前已问过用户。
 */
import { useMemo, useState } from 'react'
import type { GuiLayerRef } from '../../src/gui/contract.ts'
import { useGateway, type BorrowedSession } from '../gateway.ts'
import { useT } from '../i18n.tsx'
import type { NavTarget } from '../nav.ts'
import { Button } from '../ui/Button.tsx'
import { useTypeLabel } from '../library/shared.tsx'
import { MemoryCard } from '../ui/MemoryCard.tsx'
import type { SavedMemory } from './saved-turn.ts'

type RowState = { kind: 'idle' } | { kind: 'busy' } | { kind: 'deleted' } | { kind: 'failed'; detail: string }

export interface SavedMemoriesCardProps {
  sessionId: string
  /** 会话的工作目录：本项目记忆的「查看详情」落在这个作用域。 */
  cwd: string | undefined
  saved: readonly SavedMemory[]
  now: number
  /** 打开记忆页（入口先写导航目标再切面板）。 */
  openDetail: (target: NavTarget) => void
  /** 删过的记忆 id：交付卡随对话滚动会卸载重挂，删除状态留在这里。 */
  deleted: Set<string>
}

const TrashIcon = () => (
  <svg width={16} height={16} viewBox="0 0 16 16" fill="none" aria-hidden="true" strokeWidth={1}>
    <path d="M1.28149 3.88831H14.7187" stroke="currentColor" />
    <path d="M5.41602 3.88833V2.47962C5.41602 2.29282 5.52492 2.11366 5.71876 1.98157C5.9126 1.84948 6.17551 1.77527 6.44964 1.77527H9.55053C9.82466 1.77527 10.0876 1.84948 10.2814 1.98157C10.4753 2.11366 10.5842 2.29282 10.5842 2.47962V3.88833" stroke="currentColor" />
    <path d="M2.57349 3.88831L3.19366 13.2943C3.21937 13.5502 3.33952 13.7872 3.53065 13.9593C3.72178 14.1313 3.97016 14.2259 4.22729 14.2246H11.7728C12.0299 14.2259 12.2783 14.1313 12.4694 13.9593C12.6605 13.7872 12.7807 13.5502 12.8064 13.2943L13.4266 3.88831" stroke="currentColor" />
    <path d="M6.44946 6.98926V11.1238" stroke="currentColor" />
    <path d="M9.55054 6.98926V11.1238" stroke="currentColor" />
  </svg>
)

function SavedRow({ sessionId, item, now, deleted, typeLabel }: { sessionId: string; item: SavedMemory; now: number; deleted: Set<string>; typeLabel: (type: string) => string }) {
  const t = useT()
  const gateway = useGateway()
  const id = item.memory.id
  const [state, setState] = useState<RowState>(deleted.has(id) ? { kind: 'deleted' } : { kind: 'idle' })
  const run = async (cmd: 'forget' | 'restore') => {
    if (state.kind === 'busy') return
    const before = state
    setState({ kind: 'busy' })
    const result = await gateway.execute(sessionId, { cmd, memoryId: id })
    if (result.ok) {
      if (cmd === 'forget') deleted.add(id)
      else deleted.delete(id)
      setState(cmd === 'forget' ? { kind: 'deleted' } : { kind: 'idle' })
    } else {
      setState(before.kind === 'deleted' ? before : { kind: 'failed', detail: result.detail ?? result.code })
    }
  }
  if (state.kind === 'deleted') {
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
      </div>
      <button
        type="button"
        className="pm-icon-btn"
        aria-label={t('chat.card.delete')}
        title={t('chat.card.delete')}
        aria-disabled={state.kind === 'busy' || undefined}
        onClick={() => { void run('forget') }}
      >
        <TrashIcon />
      </button>
    </div>
  )
}

export function SavedMemoriesCard({ sessionId, cwd, saved, now, openDetail, deleted }: SavedMemoriesCardProps) {
  const t = useT()
  const session = useMemo<BorrowedSession>(() => ({ kind: 'ready', sessionId, cwd }), [sessionId, cwd])
  const typeLabel = useTypeLabel(session)
  const first = saved[0]!.memory
  const scope: GuiLayerRef | undefined = first.scope === 'global' ? { kind: 'global' }
    : cwd === undefined ? undefined : { kind: 'workspace', workspacePath: cwd }
  return (
    <section className="pm-saved" aria-label={t('chat.card.title', { count: saved.length })}>
      <h3 className="pm-saved-title">{t('chat.card.title', { count: saved.length })}</h3>
      <div className="pm-saved-list">
        {saved.map(item => <SavedRow key={item.callId} sessionId={sessionId} item={item} now={now} deleted={deleted} typeLabel={typeLabel} />)}
      </div>
      <div className="pm-saved-foot">
        <button
          type="button"
          className="pm-link"
          onClick={() => openDetail({ tab: 'library', ...(scope === undefined ? {} : { scope }), memoryId: first.id })}
        >
          {t('chat.card.detail')}
        </button>
      </div>
    </section>
  )
}

export const savedMemoriesCardCss = `
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
.pm-link {
  padding: 0; border: 0; background: none; font: inherit; font-size: 12px; font-weight: 400;
  color: var(--pm-text-2); cursor: pointer;
}
.pm-link:hover { color: var(--pm-text); }
`
