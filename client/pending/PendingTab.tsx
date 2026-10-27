/**
 * 记忆页「待处理」tab（PRD 5.2、5.13）：待处理项按级别分组（高优问题 → 待你处理 → 建议整理），组标题带条数，没有内容的组不画；
 * 组内按服务端排好的顺序各出一张卡，建议整理先显示前 5 张，其余收进「展开其余 N 条」（直达的那条在折叠里时整组展开）。视图不含刚处理完的条目，所以列表在本地记住最近一次处理（原条目 + 结果 + 原位置），在原位显示结果卡；
 * 撤销成功后等视图把条目带回来，再去掉本地那张。离开页面就收起。
 * 动作碰上这一条正在别处处理或刚处理完（什么都没动）：在原位留一行说明，那边的结果写进视图、卡片消失后也还在，
 * 列表空了就留在空状态上面；之后哪张卡做成了一件事就收起。
 * 空状态三种：体检关闭（「去设置里打开 ›」）、从没体检过（说明体检是什么，按钮在页头）、待处理为空（说明待处理收什么、上次体检时间）。
 * 入口带记忆 id 打开时，含这条记忆的卡（冲突任一方、提升候选、密钥）滚入视野并高亮一次。
 * 带组标识进来时（健康页「去处理 ›」）焦点落在那一组的标题上，组已不在（处理完了）落在待处理顶部；每次导航只定位一次。
 */
import { useEffect, useId, useRef, useState, type ReactElement, type ReactNode, type RefObject } from 'react'
import { PENDING_LEVELS, type HealthView, type LibraryView, type PendingItem, type PendingLevel, type PendingView } from '../../src/gui/contract.ts'
import { useGateway, type BorrowedSession, type ViewState } from '../gateway.ts'
import { baseName, formatDay, formatNumber, useT } from '../i18n.tsx'
import { FlashRow, useFlashTarget } from '../library/shared.tsx'
import type { LocaleKey } from '../locales.ts'
import { useCanOpen, useNavTarget, type NavStore, type NavTarget } from '../nav.ts'
import { EmptyState } from '../ui/EmptyState.tsx'
import { crossConfirmCss } from './action.tsx'
import { editCss } from './edit.tsx'
import { modelEditCss } from './model-edit.tsx'
import { moveCss } from './move.tsx'
import {
  AdviceCard, HorizontalCard, OverflowCard, PromoteCard, ResultCard, SecretCard, titleOf, UnreadableCard, VerticalCard, type Outcome,
} from './cards.tsx'

/** 建议整理先显示的行数，其余收进「展开其余 N 条」；要紧的两组全部显示。 */
const GROUP_PREVIEW = 5
const FOLDED_LEVEL: PendingLevel = 'advice'

/** 条目在视图之间的身份。 */
function keyOf(item: PendingItem): string {
  switch (item.kind) {
    case 'secret': return `secret:${item.memory.id}`
    case 'unreadable-file': return `file:${item.filePath}`
    case 'advice': return `advice:${item.type}:${item.memories.map(m => m.id).join(',')}`
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
    case 'advice': return item.memories.map(m => m.id)
    default: return []
  }
}

interface Recent { item: PendingItem; index: number; outcome: Outcome; undone: boolean }

/** 没有生效的那次动作：哪一条（标题写进说明，卡片没了也认得出）、在列表里的位置、在哪一组。 */
interface Refused { key: string; index: number; title: string; level: PendingLevel }

const LEVEL_LABEL = {
  'must-fix': 'pending.level.must-fix',
  'your-call': 'pending.level.your-call',
  'advice': 'pending.level.advice',
} as const satisfies Record<PendingLevel, LocaleKey>

/** 一行：待处理项的卡，或原位的结果卡、没有生效的说明。isItem 的行才算进组标题的条数。 */
interface Row { key: string; node: ReactElement; level: PendingLevel; isItem: boolean; flashing?: boolean }

export function PendingTab({ nav, session, workspacePath, now = Date.now() }: {
  nav: NavStore
  session: BorrowedSession
  /** 页面当前作用域的项目（「体检当前项目」体检它）；全局为 undefined。 */
  workspacePath: string | undefined
  now?: number
}) {
  const t = useT()
  const gateway = useGateway()
  const pending = gateway.useView(session, 'pending')
  const health = gateway.useView(session, 'health')
  const library = gateway.useView(session, 'library')
  const current = gateway.useCurrentWorkspace()
  const config = gateway.useConfig()
  // 「移到项目…」默认选当前页面的项目，页面在全局时选借来的会话所在的项目
  const defaultProject = workspacePath ?? (current.status === 'ready' ? current.workspacePath : undefined)
  const projects = knownProjects(defaultProject, session, library.status === 'ready' ? library.data : undefined)
  const [recent, setRecent] = useState<Recent | undefined>(undefined)
  const [refused, setRefused] = useState<Refused | undefined>(undefined)
  /** 点过「展开其余 N 条」的组。 */
  const [expanded, setExpanded] = useState<ReadonlySet<PendingLevel>>(new Set())
  const done = (next: Recent) => { setRecent(next); setRefused(undefined) }
  const refuse = (item: PendingItem, index: number) => () => { setRefused({ key: keyOf(item), index, title: titleOf(item, t), level: item.level }) }

  const viewItems = pending.status === 'ready' ? pending.data.items : []
  const typeLabels = pending.status === 'ready' ? pending.data.typeLabels : {}
  const { flashId, clear } = useFlashTarget(nav, viewItems.flatMap(memoryIdsOf))
  const root = useRef<HTMLDivElement>(null)
  useGroupFocus(nav, root, pending.status === 'ready')
  const recentKey = recent === undefined ? undefined : keyOf(recent.item)
  const backInView = recentKey !== undefined && viewItems.some(i => keyOf(i) === recentKey)
  // 撤销后视图把条目带回来了：本地那张让位
  useEffect(() => { if (recent?.undone && backInView) setRecent(undefined) }, [recent, backInView])

  if (pending.status !== 'ready' && recent === undefined) return <ViewStatus state={pending} />

  // 视图还没重写时刚处理的条目仍在里面：先藏起来，原位放结果卡
  const items = viewItems.filter(i => recent === undefined || recent.undone || keyOf(i) !== recentKey)
  const rows: Row[] = items.map((item, index) => ({
    key: keyOf(item),
    level: item.level,
    isItem: true,
    flashing: flashId !== undefined && memoryIdsOf(item).includes(flashId),
    node: renderCard(item, (outcome) => { done({ item, index, outcome, undone: false }) }, refuse(item, index)),
  }))
  if (recent !== undefined && !(recent.undone && backInView)) {
    rows.splice(Math.min(recent.index, rows.length), 0, {
      key: `recent:${recentKey}`,
      level: recent.item.level,
      isItem: recent.undone,
      node: recent.undone
        // 撤销已生效、视图还没带回来：先按原样显示，可以接着处理
        ? renderCard(recent.item, (outcome) => { done({ ...recent, outcome, undone: false }) }, refuse(recent.item, recent.index))
        : (
          <ResultCard
            item={recent.item}
            outcome={recent.outcome}
            session={session}
            now={now}
            typeLabels={typeLabels}
            onUndone={() => { done({ ...recent, undone: true }) }}
            onRefused={refuse(recent.item, recent.index)}
          />
        ),
    })
  }

  const isEmpty = rows.length === 0
  const refusedRow: Row | undefined = refused === undefined ? undefined : {
    key: `refused:${refused.key}`,
    level: refused.level,
    isItem: false,
    node: <p className="pm-pending-refused" role="alert" tabIndex={-1}>{t('pending.refused', { title: refused.title })}</p>,
  }
  if (refused !== undefined && refusedRow !== undefined && !isEmpty) rows.splice(Math.min(refused.index, rows.length), 0, refusedRow)

  function renderCard(item: PendingItem, onDone: (outcome: Outcome) => void, onRefused: () => void): ReactElement {
    const props = { session, now, typeLabels, onDone, onRefused }
    switch (item.kind) {
      case 'secret': return <SecretCard item={item} {...props} />
      case 'conflict-horizontal': return <HorizontalCard item={item} {...props} />
      case 'conflict-vertical': return <VerticalCard item={item} {...props} />
      case 'promote-candidate': {
        const target = config === undefined ? undefined : config.globalPromoteTarget === 'agents-md' ? 'agents-md' : 'global'
        return <PromoteCard item={item} {...props} promoteTarget={target} />
      }
      case 'overflow': return (
        <OverflowCard
          item={item}
          {...props}
          budget={config?.snapshotTokenBudget}
          onCleanup={(scope) => { nav.update({ tab: 'library', scope, memoryId: undefined }) }}
        />
      )
      case 'unreadable-file': return <UnreadableCard item={item} {...props} />
      case 'advice': return <AdviceCard item={item} {...props} projects={projects} defaultProject={defaultProject} />
    }
  }

  return (
    <div ref={root} className="pm-pending" tabIndex={-1}>
      <style data-plastic-memory-pending="">{pendingCss}</style>
      {isEmpty
        ? (
          <>
            {refusedRow?.node}
            <PendingEmpty nav={nav} session={session} workspacePath={workspacePath} health={health.status === 'ready' ? health.data : undefined} now={now} />
          </>
        )
        : PENDING_LEVELS.map((level) => {
          const group = rows.filter(row => row.level === level)
          const isOpen = level !== FOLDED_LEVEL || expanded.has(level) || group.slice(GROUP_PREVIEW).some(row => row.flashing === true)
          const shown = isOpen ? group : group.slice(0, GROUP_PREVIEW)
          return group.length === 0 ? null : (
            <PendingGroup key={level} level={level} count={group.filter(row => row.isItem).length}>
              {shown.map(row => (
                <FlashRow key={row.key} as="div" className="pm-pending-row" flashing={row.flashing ?? false} onFlashEnd={clear}>{row.node}</FlashRow>
              ))}
              {shown.length < group.length
                ? (
                  <button type="button" className="pm-pending-more" onClick={() => { setExpanded(prev => new Set(prev).add(level)) }}>
                    {t('pending.more', { n: formatNumber(group.length - shown.length) })}
                  </button>
                )
                : null}
            </PendingGroup>
          )
        })}
    </div>
  )
}

/**
 * 导航目标带组标识时定位一次：焦点落在那一组的标题上并滚到顶，组不在了落在待处理顶部。
 * 按目标对象认「一次」（视图刷新不重播）；视图还没到就等它到。
 */
function useGroupFocus(nav: NavStore, root: RefObject<HTMLDivElement | null>, isReady: boolean): void {
  const target = useNavTarget(nav)
  const handled = useRef<NavTarget | undefined>(undefined)
  useEffect(() => {
    if (target.level === undefined || !isReady || root.current === null || handled.current === target) return
    handled.current = target
    const spot = root.current.querySelector<HTMLElement>(`[data-level="${target.level}"]`) ?? root.current
    spot.focus({ preventScroll: true })
    spot.scrollIntoView?.({ block: 'start' })
  }, [target, isReady, root])
}

/**
 * 「移到项目…」列出的已知项目：会话归属对照里的项目，加上全部记忆里有记忆的项目（同作用域下拉）。
 * 默认项排第一，其余按项目名。
 */
function knownProjects(defaultProject: string | undefined, session: BorrowedSession, library: LibraryView | undefined): string[] {
  const paths = new Set<string>(session.kind === 'ready' ? Object.values(session.workspaces ?? {}) : [])
  for (const { layer } of library?.layers ?? []) if (layer.kind === 'workspace') paths.add(layer.workspacePath)
  if (defaultProject !== undefined) paths.delete(defaultProject)
  const rest = [...paths].sort((a, b) => baseName(a).localeCompare(baseName(b)) || a.localeCompare(b))
  return defaultProject === undefined ? rest : [defaultProject, ...rest]
}

/** 一级一组：组标题写级别和还在等你的条数（只剩结果卡时不写 0）。 */
function PendingGroup({ level, count, children }: { level: PendingLevel; count: number; children: ReactNode }) {
  const t = useT()
  const titleId = useId()
  return (
    <section className="pm-pending-group" aria-labelledby={titleId}>
      <h2 id={titleId} className="pm-pending-group-title" data-level={level} tabIndex={-1}>
        {t(LEVEL_LABEL[level])}
        {count > 0 ? <>{' '}<span className="pm-pending-group-count">{formatNumber(count)}</span></> : null}
      </h2>
      {children}
    </section>
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
  const times = health.layers.map(l => l.lastCheckupAt).filter((v): v is number => v !== null)
  return times.length === 0 ? null : Math.max(...times)
}

/** 体检开关取健康视图（和健康 tab、页头的体检按钮同一来源）；视图还没到时按开着处理。 */
function PendingEmpty({ nav, session, workspacePath, health, now }: {
  nav: NavStore
  session: BorrowedSession
  workspacePath: string | undefined
  health: HealthView | undefined
  now: number
}) {
  const t = useT()
  const canOpenSettings = useCanOpen(nav, 'settings')

  if (health?.governanceEnabled === false) {
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
      {t('pending.empty.body')}
      {last === undefined ? null : <><br />{t('pending.empty.lastScan', { date: formatDay(last, now, t) })}</>}
    </EmptyState>
  )
}

export const pendingCss = crossConfirmCss + editCss + modelEditCss + moveCss + `
.pm-pending { display: flex; flex-direction: column; }
.pm-root .pm-pending:focus-visible { outline: none; }
.pm-pending-group { display: flex; flex-direction: column; }
.pm-pending-group + .pm-pending-group { margin-top: 24px; }
.pm-pending-group-title { margin: 4px 0 0; font-size: 16px; font-weight: 600; line-height: 1.5; color: var(--pm-text); }
.pm-pending-advice-memories .pm-mc-text { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; overflow: hidden; }
.pm-pending-advice-group { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.pm-pending-advice-side { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.pm-pending-group-count { font-weight: 400; color: var(--pm-text-2); }
.pm-pending-row { position: relative; }
.pm-pending-row + .pm-pending-row { border-top: .5px solid var(--pm-line); }
.pm-pending-row.pm-flash { margin-inline: -12px; padding-inline: 12px; border-radius: 10px; }
.pm-pending-row.pm-flash::before { left: 2px; }
.pm-pending-item { padding: 16px 0 18px; }
.pm-pending-head { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
.pm-pending-title { margin: 0; flex: 1; min-width: 0; font-size: 14px; font-weight: 600; line-height: 1.5; color: var(--pm-text); }
.pm-pending-aside { margin-left: auto; }
.pm-pending-body { display: flex; flex-direction: column; gap: 10px; padding-left: 16px; }
.pm-pending-hint { margin: 0; font-size: 12px; line-height: 1.5; color: var(--pm-text-2); }
.pm-pending-hint .pm-link { margin-left: 8px; font-size: 12px; }
.pm-pending-error { margin: 6px 0 0; font-size: 12px; line-height: 1.5; color: var(--pm-text); }
.pm-pending-refused { margin: 0; padding: 12px 0; font-size: 12px; line-height: 1.5; color: var(--pm-text); }
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
.pm-pending-more {
  align-self: flex-start; margin-top: 4px; padding: 6px 0; border: 0; background: none;
  font: inherit; font-size: 13px; color: var(--pm-text-2); cursor: pointer;
}
.pm-pending-more:hover { color: var(--pm-text); }
`
