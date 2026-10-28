/**
 * 记忆页的处理视图（PRD 5.2、5.13）：条目按级别分组（先处理 → 等你决定 → 可以整理），组标题带条数，没有内容的组不画；
 * 组内按服务端排好的顺序各出一张卡，建议整理先显示前 5 张，其余收进「展开其余 N 条」（直达的那条在折叠里时整组展开）。视图不含刚处理完的条目，所以列表在本地记住最近一次处理（原条目 + 结果 + 原位置），在原位显示结果卡；
 * 撤销成功后等视图把条目带回来，再去掉本地那张。离开页面、换范围就收起。
 * 动作碰上这一条正在别处处理或刚处理完（什么都没动）：在原位留一行说明，那边的结果写进视图、卡片消失后也还在，
 * 列表空了就留在空状态上面；之后哪张卡做成了一件事就收起。
 * 留下的只剩结果卡时，组上方写「都处理完了」。「可以整理」组底部是这个范围的「不再提醒的 N 条」，展开逐条恢复提醒。
 * 空状态两种：配置文件关掉体检（写明在配置文件里改，界面上不提供打开）、三组都空（写上次体检时间，不放体检按钮）；「不再提醒的 N 条」那一行跟在空状态下面。
 * 入口带记忆 id 打开时，含这条记忆的卡（冲突任一方、提升候选、密钥）滚入视野并高亮一次。
 * 带组标识进来时（健康页「去处理 ›」）焦点落在那一组的标题上，组已不在（处理完了）落在待处理顶部；每次导航只定位一次。
 * 「新」：最近一次界面手动或自动体检新增、这一趟进来时还没显示过的条目，标题后带「新」、排在组内最前（记录见 checkup/seen.ts）。
 * 按进入这个范围时读的记录标（记忆页给出，同一范围里切视图不重读）；显示出来的随即记下，换范围再回来就不标了。
 * 带 newItem 进来时（状态条结果行的链接）跳到第一条带「新」的条目：滚到视野中间、闪一次、接住焦点；没有就落在顶部。
 */
import { useEffect, useId, useRef, useState, type ReactElement, type ReactNode, type RefObject } from 'react'
import { PENDING_LEVELS, pendingItemKey, pendingItemScopes, type GuiLayerRef, type HealthView, type LibraryView, type PendingItem, type PendingLevel, type PendingView } from '../../src/gui/contract.ts'
import { isNewItem, markSeen, newItemIndex, readSeen, type Seen } from '../checkup/seen.ts'
import { useGateway, type BorrowedSession, type ViewState } from '../gateway.ts'
import { baseName, formatDay, formatNumber, useT } from '../i18n.tsx'
import { FlashRow, useFlashTarget } from '../library/shared.tsx'
import type { LocaleKey } from '../locales.ts'
import { compareLayers, isInScope, scopeName, useNavTarget, type NavStore, type NavTarget, type NewItemJump, type PageScope } from '../nav.ts'
import { Button } from '../ui/Button.tsx'
import { Chip } from '../ui/Chip.tsx'
import { EmptyState } from '../ui/EmptyState.tsx'
import { Arrival, useArrivals } from '../ui/motion.tsx'
import { StatusMarker } from '../ui/StatusMarker.tsx'
import { ActionFeedback, crossConfirmCss, ItemSending, useItemAction } from './action.tsx'
import { editCss } from './edit.tsx'
import { modelEditCss } from './model-edit.tsx'
import { moveCss } from './move.tsx'
import {
  AdviceCard, adviceTitle, HorizontalCard, ItemIsNew, ItemScopeNames, OverflowCard, PromoteCard, ResultCard, SecretCard, titleOf, UnreadableCard, VerticalCard, type Outcome,
} from './cards.tsx'

/** 建议整理先显示的行数，其余收进「展开其余 N 条」；要紧的两组全部显示。 */
const GROUP_PREVIEW = 5
const FOLDED_LEVEL: PendingLevel = 'advice'

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

/** 一行：待处理项的卡，或原位的结果卡、没有生效的说明。isItem 的行才算进组标题的条数；isNew 的行带「新」。 */
interface Row { key: string; node: ReactElement; level: PendingLevel; isItem: boolean; isNew?: boolean; flashing?: boolean }

/** 结果行链接跳到的组：等你决定那条链接管先处理和等你决定，可以整理那条只管可以整理。 */
const JUMP_LEVELS = {
  todo: ['must-fix', 'your-call'],
  advice: ['advice'],
  any: PENDING_LEVELS,
} as const satisfies Record<NewItemJump, readonly PendingLevel[]>

export function PendingTab({ nav, session, scope, workspacePath, seen: visitSeen, now = Date.now() }: {
  nav: NavStore
  session: BorrowedSession
  /** 左栏选中的范围：只列属于它的条目；「全部」里每张卡带范围名胶囊。 */
  scope: PageScope
  /** 页面当前范围的项目（「移到项目…」默认选它）；全局、全部为 undefined。 */
  workspacePath: string | undefined
  /** 进入这个范围时读的「显示过」记录；不给时按挂载时读的。 */
  seen?: Seen
  now?: number
}) {
  const t = useT()
  const gateway = useGateway()
  const pending = gateway.useView(session, 'pending')
  const health = gateway.useView(session, 'health')
  const library = gateway.useView(session, 'library')
  const checkupState = gateway.useView(session, 'checkups')
  const checkups = checkupState.status === 'ready' ? checkupState.data : undefined
  const current = gateway.useCurrentWorkspace()
  const config = gateway.useConfig()
  // 「移到项目…」默认选当前页面的项目，页面在全局时选借来的会话所在的项目
  const defaultProject = workspacePath ?? (current.status === 'ready' ? current.workspacePath : undefined)
  const projects = knownProjects(defaultProject, session, library.status === 'ready' ? library.data : undefined)
  const [recent, setRecent] = useState<Recent | undefined>(undefined)
  const [refused, setRefused] = useState<Refused | undefined>(undefined)
  /** 命令正在进行中的卡（按条目 key）：视图先刷新掉它时留在原位。index 同 Recent。 */
  const [sending, setSending] = useState<ReadonlyMap<string, { item: PendingItem; index: number }>>(new Map())
  /** 点过「展开其余 N 条」的组。 */
  const [expanded, setExpanded] = useState<ReadonlySet<PendingLevel>>(new Set())
  const [mountSeen] = useState(readSeen)
  const seen = visitSeen ?? mountSeen
  const newIndex = newItemIndex(checkups)
  const isNew = (item: PendingItem) => isNewItem(newIndex, seen, pendingItemKey(item))
  /** 这次渲染里显示出来的「新」条目，渲染后记下。 */
  const shownNew = useRef<string[]>([])
  shownNew.current = []
  useEffect(() => {
    if (checkups === undefined) return
    markSeen(checkups, shownNew.current.flatMap(key => (newIndex.get(key) ?? []).map(checkupId => ({ checkupId, keys: [key] }))))
  })
  const done = (next: Recent) => { setRecent(next); setRefused(undefined) }
  const refuse = (item: PendingItem, index: number) => () => { setRefused({ key: pendingItemKey(item), index, title: titleOf(item, t), level: item.level }) }

  // 带「新」的排在组内最前（各组按级别分开画，整体稳定排序即可）
  const viewItems = (pending.status === 'ready' ? pending.data.items.filter(item => isInScope(pendingItemScopes(item), scope)) : [])
    .map(item => ({ item, isNew: isNew(item) }))
    .sort((a, b) => Number(b.isNew) - Number(a.isNew))
    .map(({ item }) => item)
  const layerName = (layer: GuiLayerRef) => scopeName(layer, t)
  const scopeNames = (item: PendingItem): readonly string[] => scope.kind !== 'all' ? [] : pendingItemScopes(item).map(layerName)
  const healthLayers = health.status === 'ready' ? health.data.layers.filter(l => isInScope([l.layer], scope)) : []
  const ignored = [...healthLayers].sort((a, b) => compareLayers(a.layer, b.layer))
    .flatMap(l => l.ignored.map(item => ({ item, scopeName: scope.kind === 'all' ? layerName(l.layer) : undefined })))
  const ignoredBlock = ignored.length === 0 ? null : <Ignored entries={ignored} session={session} />
  const typeLabels = pending.status === 'ready' ? pending.data.typeLabels : {}
  const { flashId, clear } = useFlashTarget(nav, viewItems.flatMap(memoryIdsOf))
  const root = useRef<HTMLDivElement>(null)
  useGroupFocus(nav, root, pending.status === 'ready')
  const jump = useNewItemJump(nav, root, pending.status === 'ready' && checkupState.status !== 'loading', (to) => {
    const levels: readonly PendingLevel[] = JUMP_LEVELS[to]
    const hit = levels.flatMap(level => viewItems.filter(item => item.level === level && isNew(item)))[0]
    return hit === undefined ? undefined : pendingItemKey(hit)
  })
  // 体检、对话在页面开着时带来的新条目：撑开位置再落进来
  const arrivals = useArrivals(pending.status === 'ready' ? viewItems.map(pendingItemKey) : undefined)
  const recentKey = recent === undefined ? undefined : pendingItemKey(recent.item)
  const backInView = recentKey !== undefined && viewItems.some(i => pendingItemKey(i) === recentKey)
  // 撤销后视图把条目带回来了：本地那张让位
  useEffect(() => { if (recent?.undone && backInView) setRecent(undefined) }, [recent, backInView])

  if (pending.status !== 'ready' && recent === undefined) return <ViewStatus state={pending} />

  // 视图还没重写时刚处理的条目仍在里面：先藏起来，原位放结果卡
  const items = viewItems.filter(i => recent === undefined || recent.undone || pendingItemKey(i) !== recentKey)
  const cardRow = (item: PendingItem, index: number): Row => {
    const key = pendingItemKey(item)
    const isNewRow = isNew(item)
    const onSending = (isSending: boolean) => {
      setSending((prev) => {
        const next = new Map(prev)
        if (isSending) next.set(key, { item, index })
        else next.delete(key)
        return next
      })
    }
    return {
      key,
      level: item.level,
      isItem: true,
      isNew: isNewRow,
      flashing: (flashId !== undefined && memoryIdsOf(item).includes(flashId)) || (jump.isFlashing && jump.key === key),
      node: (
        <ItemSending.Provider value={onSending}>
          <ItemIsNew.Provider value={isNewRow}>
            <ItemScopeNames.Provider value={scopeNames(item)}>{renderCard(item, (outcome) => { done({ item, index, outcome, undone: false }) }, refuse(item, index))}</ItemScopeNames.Provider>
          </ItemIsNew.Provider>
        </ItemSending.Provider>
      ),
    }
  }
  const rows: Row[] = items.map(cardRow)
  // 命令还在进行中、视图已经没有它的卡：同一个 key 留在原位，卡片不重挂，焦点不丢
  for (const { item, index } of sending.values()) {
    const key = pendingItemKey(item)
    if (key !== recentKey && !items.some(i => pendingItemKey(i) === key)) rows.splice(Math.min(index, rows.length), 0, cardRow(item, index))
  }
  if (recent !== undefined && !(recent.undone && backInView)) {
    rows.splice(Math.min(recent.index, rows.length), 0, {
      key: `recent:${recentKey}`,
      level: recent.item.level,
      isItem: recent.undone,
      node: (
        <ItemScopeNames.Provider value={scopeNames(recent.item)}>
          {recent.undone
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
            )}
        </ItemScopeNames.Provider>
      ),
    })
  }

  const isEmpty = rows.length === 0
  // 留下的只剩结果卡：这个范围处理完了
  const isAllDone = !isEmpty && !rows.some(row => row.isItem)
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
          onCleanup={(layer) => { nav.update({ view: 'library', scope: layer, memoryId: undefined }) }}
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
            <PendingEmpty
              isOff={health.status === 'ready' && !health.data.governanceEnabled}
              lastCheckupAt={health.status === 'ready' ? lastScanAt(healthLayers) : undefined}
              now={now}
            />
            {ignoredBlock}
          </>
        )
        : (
          <>
            {isAllDone ? <p className="pm-pending-all-done"><StatusMarker kind="ok" />{t('pending.allDone')}</p> : null}
            {PENDING_LEVELS.map((level) => {
              const group = rows.filter(row => row.level === level)
              const isOpen = level !== FOLDED_LEVEL || expanded.has(level) || group.slice(GROUP_PREVIEW).some(row => row.flashing === true)
              const shown = isOpen ? group : group.slice(0, GROUP_PREVIEW)
              for (const row of shown) if (row.isNew === true) shownNew.current.push(row.key)
              const tail = level === 'advice' ? ignoredBlock : null
              return group.length === 0 && tail === null ? null : (
                <PendingGroup key={level} level={level} count={group.filter(row => row.isItem).length}>
                  {shown.map(row => (
                    <FlashRow
                      key={row.key}
                      as="div"
                      className="pm-pending-row"
                      flashing={row.flashing ?? false}
                      takesFocus={row.key === jump.key}
                      onFlashEnd={() => { clear(); jump.end() }}
                    >
                      <Arrival arrivals={arrivals} id={row.key}>{row.node}</Arrival>
                    </FlashRow>
                  ))}
                  {shown.length < group.length
                    ? (
                      <button type="button" className="pm-pending-more" onClick={() => { setExpanded(prev => new Set(prev).add(level)) }}>
                        {t('pending.more', { n: formatNumber(group.length - shown.length) })}
                      </button>
                    )
                    : null}
                  {tail}
                </PendingGroup>
              )
            })}
          </>
        )}
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
 * 导航目标带 newItem 时跳一次：firstNew 给出那一类里第一条带「新」的条目，它闪一次并接住焦点（key 留着，焦点不因闪完而丢）；
 * 没有就落在处理视图顶部。按目标对象认「一次」；视图还没到就等它到。
 */
function useNewItemJump(
  nav: NavStore,
  root: RefObject<HTMLDivElement | null>,
  isReady: boolean,
  firstNew: (to: NewItemJump) => string | undefined,
): { key: string | undefined; isFlashing: boolean; end: () => void } {
  const target = useNavTarget(nav)
  const handled = useRef<NavTarget | undefined>(undefined)
  const [key, setKey] = useState<string | undefined>(undefined)
  const [isFlashing, setFlashing] = useState(false)
  useEffect(() => {
    if (target.newItem === undefined || !isReady || handled.current === target) return
    handled.current = target
    const hit = firstNew(target.newItem)
    setKey(hit)
    setFlashing(hit !== undefined)
    if (hit === undefined) root.current?.focus({ preventScroll: true })
  })
  return { key, isFlashing, end: () => { setFlashing(false) } }
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

/** 一级一组：组标题写级别和还在等你的条数（只剩结果卡时不写 0）；「可以整理」标题后写处理它有什么用。 */
function PendingGroup({ level, count, children }: { level: PendingLevel; count: number; children: ReactNode }) {
  const t = useT()
  const titleId = useId()
  return (
    <section className="pm-pending-group" aria-labelledby={titleId}>
      <header className="pm-pending-group-head">
        <h2 id={titleId} className="pm-pending-group-title" data-level={level} tabIndex={-1}>
          {t(LEVEL_LABEL[level])}
          {count > 0 ? <>{' '}<span className="pm-pending-group-count">{formatNumber(count)}</span></> : null}
        </h2>
        {level === 'advice'
          ? <p className="pm-pending-group-note"><i className="pm-sep" aria-hidden="true">·</i><span>{t('pending.level.advice.note')}</span></p>
          : null}
      </header>
      {children}
    </section>
  )
}

type IgnoredItem = HealthView['layers'][number]['ignored'][number]

/** 不再提醒的一条：问题类型 · 记忆名（「全部」里带范围胶囊），「恢复提醒」发 unignore-advice；成功后视图重写，这一条随之消失。 */
function IgnoredRow({ item, scopeName, session }: { item: IgnoredItem; scopeName: string | undefined; session: BorrowedSession }) {
  const t = useT()
  const action = useItemAction(session, () => {})
  return (
    <li className="pm-ignored-row">
      <span className="pm-ignored-text">{[adviceTitle(item.type, t), ...item.memories.map(m => m.name)].join(' · ')}</span>
      {scopeName !== undefined ? <Chip variant="neutral">{scopeName}</Chip> : null}
      <Button
        variant="ghost"
        className="pm-ignored-undo"
        unavailable={action.unavailable}
        onClick={() => { action.run({ cmd: 'unignore-advice', type: item.type, memoryIds: item.memories.map(m => m.id) }) }}
      >
        {t('pending.ignored.unignore')}
      </Button>
      <ActionFeedback action={action} />
    </li>
  )
}

/** 「不再提醒的 N 条 查看 ⌄」：默认收起，展开逐条列出。数据取健康视图里这个范围各层的已忽略。 */
function Ignored({ entries, session }: { entries: ReadonlyArray<{ item: IgnoredItem; scopeName: string | undefined }>; session: BorrowedSession }) {
  const t = useT()
  const [isOpen, setOpen] = useState(false)
  const listId = useId()
  const label = t('pending.ignored.count', { n: formatNumber(entries.length) })
  return (
    <div className="pm-ignored">
      <p className="pm-ignored-line">
        <span>{label}</span>
        <button type="button" className="pm-ignored-toggle" aria-expanded={isOpen} aria-controls={listId} onClick={() => { setOpen(!isOpen) }}>
          {t(isOpen ? 'pending.ignored.hide' : 'pending.ignored.show')}
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M7 10l5 5 5-5" />
          </svg>
        </button>
      </p>
      {isOpen
        ? (
          <ul id={listId} className="pm-ignored-list" aria-label={label}>
            {entries.map(({ item, scopeName }) => (
              <IgnoredRow key={`${scopeName ?? ''}:${item.type}:${item.memories.map(m => m.id).join(',')}`} item={item} scopeName={scopeName} session={session} />
            ))}
          </ul>
        )
        : null}
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

/** 这个范围最近一次体检的时间；一层都没体检过为 null。 */
function lastScanAt(layers: HealthView['layers']): number | null {
  const times = layers.map(l => l.lastCheckupAt).filter((v): v is number => v !== null)
  return times.length === 0 ? null : Math.max(...times)
}

/**
 * 三组都空。体检开关取健康视图（和状态条同一来源），视图还没到时按开着处理、不写上次体检。
 * 不放体检按钮：体检入口在标题行。
 */
function PendingEmpty({ isOff, lastCheckupAt, now }: {
  isOff: boolean
  /** 这个范围的上次体检；null = 从没体检过，undefined = 健康视图还没到。 */
  lastCheckupAt: number | null | undefined
  now: number
}) {
  const t = useT()

  if (isOff) return <EmptyState variant="daily" title={t('pending.off.title')}>{t('pending.off.body')}</EmptyState>
  return (
    <EmptyState variant="daily" title={t('pending.empty.title')}>
      {lastCheckupAt === undefined ? undefined
        : lastCheckupAt === null ? t('pending.empty.never') : t('pending.empty.lastScan', { date: formatDay(lastCheckupAt, now, t) })}
    </EmptyState>
  )
}

export const pendingCss = crossConfirmCss + editCss + modelEditCss + moveCss + `
.pm-pending { display: flex; flex-direction: column; }
.pm-root .pm-pending:focus-visible { outline: none; }
.pm-pending-group { display: flex; flex-direction: column; }
.pm-pending-group + .pm-pending-group { margin-top: 24px; }
.pm-pending-group-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0 6px; margin-top: 4px; }
.pm-pending-group-title { margin: 0; font-size: 16px; font-weight: 600; line-height: 1.5; color: var(--pm-text); }
.pm-pending-group-note { display: inline-flex; gap: 6px; margin: 0; font-size: 12px; line-height: 1.5; color: var(--pm-text-2); }
.pm-pending-all-done { display: flex; align-items: center; gap: 8px; margin: 0 0 16px; font-size: 13px; line-height: 1.55; color: var(--pm-text); }
.pm-ignored { padding: 12px 0 4px; border-top: .5px solid var(--pm-line); font-size: 12px; line-height: 1.5; color: var(--pm-text-2); }
.pm-ignored-line { display: flex; align-items: center; gap: 8px; margin: 0; }
.pm-ignored-toggle {
  display: inline-flex; align-items: center; gap: 2px; padding: 0; border: 0; background: none;
  font: inherit; font-size: 12px; font-weight: 600; color: var(--pm-text); cursor: pointer;
}
.pm-ignored-toggle svg { transition: transform 120ms ease; }
.pm-ignored-toggle[aria-expanded='true'] svg { transform: rotate(180deg); }
@media (prefers-reduced-motion: reduce) { .pm-ignored-toggle svg { transition: none; } }
.pm-ignored-list { margin: 8px 0 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 4px; }
.pm-ignored-row { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; }
.pm-ignored-text { min-width: 0; overflow-wrap: anywhere; }
.pm-ignored-undo { margin-left: auto; padding: 2px 10px; font-size: 12px; }
.pm-ignored-row .pm-pending-error { flex-basis: 100%; margin: 0; }
.pm-pending-advice-memories .pm-mc-text { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; overflow: hidden; }
.pm-pending-advice-group { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.pm-pending-advice-side { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.pm-pending-group-count { font-weight: 400; color: var(--pm-text-2); }
.pm-pending-row { position: relative; }
.pm-pending-row + .pm-pending-row { border-top: .5px solid var(--pm-line); }
.pm-pending-row.pm-flash { margin-inline: -12px; padding-inline: 12px; border-radius: 10px; }
.pm-pending-row.pm-flash::before { left: 2px; }
.pm-pending-item { padding: 16px 0 18px; }
.pm-pending-head { display: flex; align-items: center; gap: 8px; min-height: 24px; margin-bottom: 12px; }
/* 标记列 14px（密钥三角的宽度）：圆点、三角、灰点的标题都从 22px 起，和状态条的缩进一致 */
.pm-pending-mark { display: inline-flex; justify-content: center; flex: 0 0 14px; }
.pm-pending-title { margin: 0; flex: 0 1 auto; min-width: 0; font-size: 14px; font-weight: 600; line-height: 1.5; color: var(--pm-text); }
/* 标题折成两行时叉仍在右上角 */
.pm-pending-aside { position: relative; flex: 0 0 24px; align-self: flex-start; height: 24px; margin-left: auto; }
.pm-pending-scope { display: inline-flex; }
.pm-pending-body { display: flex; flex-direction: column; gap: 10px; padding-left: 16px; }
.pm-pending-item--marked .pm-pending-body { padding-left: 22px; }
.pm-pending-hint { margin: 0; font-size: 12px; line-height: 1.5; color: var(--pm-text-2); }
.pm-pending-hint .pm-link { margin-left: 8px; font-size: 12px; }
.pm-pending-error { margin: 6px 0 0; font-size: 12px; line-height: 1.5; color: var(--pm-text); }
.pm-pending-refused { margin: 0; padding: 12px 0; font-size: 12px; line-height: 1.5; color: var(--pm-text); }
.pm-pending-result { display: flex; align-items: center; gap: 12px; }
.pm-pending-result .pm-pending-text { flex: 1; }
.pm-pending-item--result { transition: opacity 120ms ease-out; }
@starting-style { .pm-pending-item--result { opacity: 0; } }
@media (prefers-reduced-motion: reduce) { .pm-pending-item--result { transition: none; } }
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
.pm-pending-more {
  align-self: flex-start; margin-top: 4px; padding: 6px 0; border: 0; background: none;
  font: inherit; font-size: 13px; color: var(--pm-text-2); cursor: pointer;
}
.pm-pending-more:hover { color: var(--pm-text); }
`
