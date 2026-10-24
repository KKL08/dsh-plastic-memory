/**
 * 记忆页「待处理」tab（PRD 5.2、5.13）：视图里的条目按服务端排好的顺序（密钥 → 冲突 → 提升候选 → 超限 → 读不出的文件）
 * 各出一张卡。视图不含刚处理完的条目，所以列表在本地记住最近一次处理（原条目 + 结果 + 原位置），在原位显示结果卡；
 * 撤销成功后等视图把条目带回来，再去掉本地那张。离开页面就收起。
 * 空状态三种：体检关闭（「去设置里打开 ›」）、从没体检过（说明体检是什么，按钮在页头）、待处理为空（上次体检时间）。
 * 入口带记忆 id 打开时，含这条记忆的卡（冲突任一方、提升候选、密钥）滚入视野并高亮一次。
 */
import { useEffect, useState, type ReactElement } from 'react'
import type { HealthView, PendingItem, PendingView } from '../../src/gui/contract.ts'
import { useGateway, type BorrowedSession, type ViewState } from '../gateway.ts'
import { formatDay, useT } from '../i18n.tsx'
import { FlashRow, useFlashTarget } from '../library/shared.tsx'
import { useCanOpen, type NavStore } from '../nav.ts'
import { EmptyState } from '../ui/EmptyState.tsx'
import {
  HorizontalCard, OverflowCard, PromoteCard, ResultCard, SecretCard, UnreadableCard, VerticalCard, type Outcome,
} from './cards.tsx'

/** 条目在视图之间的身份。 */
function keyOf(item: PendingItem): string {
  switch (item.kind) {
    case 'secret': return `secret:${item.memory.id}`
    case 'unreadable-file': return `file:${item.filePath}`
    default: return item.decisionId
  }
}

/** 卡里出现的记忆 id（直达高亮用）；超限和读不出的文件不对应某条记忆。 */
function memoryIdsOf(item: PendingItem): string[] {
  switch (item.kind) {
    case 'secret': return [item.memory.id]
    case 'conflict-horizontal': return [item.left?.id, item.right?.id].filter((id): id is string => id !== undefined)
    case 'conflict-vertical':
    case 'promote-candidate': return item.memory === null ? [] : [item.memory.id]
    default: return []
  }
}

interface Recent { item: PendingItem; index: number; outcome: Outcome; undone: boolean }

export function PendingTab({ nav, session, workspacePath, now = Date.now() }: {
  nav: NavStore
  session: BorrowedSession
  /** 页面当前作用域的项目（「体检当前项目」体检它）；全局为 undefined。 */
  workspacePath: string | undefined
  now?: number
}) {
  const gateway = useGateway()
  const pending = gateway.useView(session, 'pending')
  const health = gateway.useView(session, 'health')
  const config = gateway.useConfig()
  const [recent, setRecent] = useState<Recent | undefined>(undefined)

  const viewItems = pending.status === 'ready' ? pending.data.items : []
  const typeLabels = pending.status === 'ready' ? pending.data.typeLabels : {}
  const { flashId, clear } = useFlashTarget(nav, viewItems.flatMap(memoryIdsOf))
  const recentKey = recent === undefined ? undefined : keyOf(recent.item)
  const backInView = recentKey !== undefined && viewItems.some(i => keyOf(i) === recentKey)
  // 撤销后视图把条目带回来了：本地那张让位
  useEffect(() => { if (recent?.undone && backInView) setRecent(undefined) }, [recent, backInView])

  if (pending.status !== 'ready' && recent === undefined) return <ViewStatus state={pending} />

  // 视图还没重写时刚处理的条目仍在里面：先藏起来，原位放结果卡
  const items = viewItems.filter(i => recent === undefined || recent.undone || keyOf(i) !== recentKey)
  const rows: Array<{ key: string; node: ReactElement; flashing?: boolean }> = items.map((item, index) => ({
    key: keyOf(item),
    flashing: flashId !== undefined && memoryIdsOf(item).includes(flashId),
    node: renderCard(item, (outcome) => { setRecent({ item, index, outcome, undone: false }) }),
  }))
  if (recent !== undefined && !(recent.undone && backInView)) {
    rows.splice(Math.min(recent.index, rows.length), 0, {
      key: `recent:${recentKey}`,
      node: recent.undone
        // 撤销已生效、视图还没带回来：先按原样显示，可以接着处理
        ? renderCard(recent.item, (outcome) => { setRecent({ ...recent, outcome, undone: false }) })
        : (
          <ResultCard
            item={recent.item}
            outcome={recent.outcome}
            session={session}
            now={now}
            typeLabels={typeLabels}
            onUndone={() => { setRecent({ ...recent, undone: true }) }}
          />
        ),
    })
  }

  function renderCard(item: PendingItem, onDone: (outcome: Outcome) => void): ReactElement {
    const props = { session, now, typeLabels, onDone }
    switch (item.kind) {
      case 'secret': return <SecretCard item={item} {...props} />
      case 'conflict-horizontal': return <HorizontalCard item={item} {...props} />
      case 'conflict-vertical': return <VerticalCard item={item} {...props} />
      case 'promote-candidate': {
        const target = config === undefined ? undefined : config.globalPromoteTarget === 'agents-md' ? 'agents-md' : 'global'
        return <PromoteCard item={item} {...props} promoteTarget={target} />
      }
      case 'overflow': return <OverflowCard item={item} {...props} budget={config?.snapshotTokenBudget} />
      case 'unreadable-file': return <UnreadableCard item={item} {...props} />
    }
  }

  return (
    <div className="pm-pending">
      <style data-plastic-memory-pending="">{pendingCss}</style>
      {rows.length === 0
        ? <PendingEmpty nav={nav} session={session} workspacePath={workspacePath} health={health.status === 'ready' ? health.data : undefined} governanceEnabled={config?.governanceEnabled} now={now} />
        : rows.map(row => (
          <FlashRow key={row.key} as="div" className="pm-pending-row" flashing={row.flashing ?? false} onFlashEnd={clear}>{row.node}</FlashRow>
        ))}
    </div>
  )
}

function ViewStatus({ state }: { state: Exclude<ViewState<PendingView>, { status: 'ready' }> }) {
  const t = useT()
  const text = state.status === 'error' ? t('view.error', { message: state.message })
    : state.status === 'missing' ? t('view.missing')
      : state.status === 'outdated' ? t('view.outdated')
        : state.status === 'idle' ? t('session.none.title') : t('view.loading')
  return <p className="pm-page-placeholder" role="status">{text}</p>
}

/** 最近一次内容检查（语义层体检）的时间；一层都没做过为 null。 */
function lastScanAt(health: HealthView): number | null {
  const times = health.layers.map(l => l.semanticCachedAt).filter((v): v is number => v !== null)
  return times.length === 0 ? null : Math.max(...times)
}

function PendingEmpty({ nav, session, workspacePath, health, governanceEnabled, now }: {
  nav: NavStore
  session: BorrowedSession
  workspacePath: string | undefined
  health: HealthView | undefined
  governanceEnabled: boolean | undefined
  now: number
}) {
  const t = useT()
  const canOpenSettings = useCanOpen(nav, 'settings')

  if (governanceEnabled === false) {
    return (
      <EmptyState
        variant="daily"
        title={t('pending.off.title')}
        action={canOpenSettings ? <button type="button" className="pm-pending-link" onClick={() => { nav.openSettings() }}>{t('pending.off.action')}</button> : undefined}
      >
        {t('pending.off.body')}
      </EmptyState>
    )
  }
  const last = health === undefined ? undefined : lastScanAt(health)
  if (last === null) {
    // 「体检当前项目」在页头（ScanControl），这里只说明体检是什么，不重复放按钮
    return (
      <EmptyState variant="daily" title={t('pending.never.title')}>
        {t('pending.never.body')}
      </EmptyState>
    )
  }
  return (
    <EmptyState variant="daily" title={t('pending.empty.title')}>
      {last === undefined ? undefined : t('pending.empty.lastScan', { date: formatDay(last, now, t) })}
    </EmptyState>
  )
}

export const pendingCss = `
.pm-pending { display: flex; flex-direction: column; }
.pm-pending-row { position: relative; }
.pm-pending-row + .pm-pending-row { border-top: .5px solid var(--pm-line); }
.pm-pending-row.pm-flash { margin-inline: -12px; padding-inline: 12px; border-radius: 10px; }
.pm-pending-row.pm-flash::before { left: 2px; }
.pm-pending-item { padding: 16px 0 18px; }
.pm-pending-head { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
.pm-pending-title { margin: 0; flex: 1; min-width: 0; font-size: 14px; font-weight: 600; line-height: 1.5; color: var(--pm-text); }
.pm-pending-aside { margin-left: auto; }
.pm-pending-body { display: flex; flex-direction: column; gap: 10px; padding-left: 16px; }
.pm-pending-text { margin: 0; font-size: 12px; line-height: 1.5; color: var(--pm-text-2); }
.pm-pending-hint { margin: 0; font-size: 12px; line-height: 1.5; color: var(--pm-text-2); }
.pm-pending-error { margin: 6px 0 0; font-size: 12px; line-height: 1.5; color: var(--pm-text); }
.pm-pending-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
.pm-pending-confirm { display: flex; flex-direction: column; gap: 8px; padding: 12px; border-radius: var(--dsw-radius-md, 12px); background: var(--pm-bg-block); }
.pm-pending-result { display: flex; align-items: center; gap: 12px; }
.pm-pending-result .pm-pending-text { flex: 1; }
.pm-pending-undo { font-weight: 600; }
.pm-pending-path { margin: 0; font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 12px; color: var(--pm-text); overflow-wrap: anywhere; }
.pm-pending-error-text {
  margin: 0; padding: 8px 12px; border-radius: var(--dsw-radius-sm, 8px); background: var(--pm-bg-block);
  font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 12px; line-height: 1.5;
  color: var(--pm-text); white-space: pre-wrap; overflow-wrap: anywhere;
}
.pm-pending-option { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.pm-pending-option-label { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--pm-text); }
.pm-pending-input {
  width: 96px; height: 28px; padding: 0 8px; font: inherit; font-size: 13px; color: var(--pm-text); background: var(--pm-bg);
  border: .5px solid var(--pm-line-input); border-radius: var(--dsw-radius-md, 12px);
}
.pm-pending-link { padding: 0; border: 0; background: none; font: inherit; font-size: 13px; font-weight: 600; color: var(--pm-text); cursor: pointer; }
`
