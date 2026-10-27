/**
 * 左栏记忆页：左栏选范围（全部、全局、各项目），右栏看这个范围——标题行、状态条、视图切换（处理 / 记忆查看 / 最近删除）、视图内容。
 * 视图按全库各一份，这里按范围筛选、算件数：条目属于哪些范围、条目身份用契约里同一份函数（pendingItemScopes、pendingItemKey）。
 * 一个会话都没有 → 空态；有会话 → 全功能。当前范围与视图在导航 store 里，入口直达时先写 store 再切面板。
 * 落点：不是入口打开的（点左栏图标、宿主恢复上次的面板）落在「全部」的处理视图；从对话进来没写范围的落在那个对话的项目，
 * 只说「去处理」而项目既没有待处理也没有可以整理时改落记忆查看。
 * 容器窄于 720px 时左栏收起，换成「范围」下拉和「其他范围还有 N 件待处理 ›」（两套都在 DOM 里，由容器查询切换）。
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type ChangeEvent, type KeyboardEvent, type MutableRefObject, type ReactNode } from 'react'
import {
  layerOfMemory, pendingItemKey, pendingItemScopes, sameLayer,
  type DeletedView, type GuiLayerRef, type HealthView, type LibraryView, type PendingView,
} from '../src/gui/contract.ts'
import { useGateway, type ViewState } from './gateway.ts'
import { baseName, formatNumber, useT, type Translate } from './i18n.tsx'
import {
  ALL_SCOPE, MEMORY_VIEWS, compareLayers, isInScope, samePageScope, useCanOpen, useNavTarget,
  type MemoryView, type NavStore, type NavTarget, type PageScope,
} from './nav.ts'
import { PendingTab } from './pending/PendingTab.tsx'
import { Button } from './ui/Button.tsx'
import { Chip } from './ui/Chip.tsx'
import { EmptyState } from './ui/EmptyState.tsx'
import { StatusMarker, type MarkerKind } from './ui/StatusMarker.tsx'
import { DeletedTab, deletedTabCss } from './deleted/DeletedTab.tsx'
import { LibraryTab, libraryTabCss } from './library/LibraryTab.tsx'
import { sharedTabCss } from './library/shared.tsx'
import { SegmentedTabs, type SegmentedTab } from './ui/Segmented.tsx'

const VIEW_LABEL = { todo: 'tab.todo', library: 'tab.library', deleted: 'tab.deleted' } as const satisfies Record<MemoryView, string>

type HealthLayer = HealthView['layers'][number]

/** 一个范围里的件数：todo = 先处理加等你决定，advice = 可以整理；按条目身份去重。 */
interface TodoCount { todo: number; advice: number; hasSecret: boolean }

/** 范围里的件数；outside = 反过来数不在这个范围里的（窄屏「其他范围还有 N 件待处理」）。 */
function countTodo(pending: PendingView | undefined, scope: PageScope, outside = false): TodoCount {
  const seen = new Set<string>()
  const count: TodoCount = { todo: 0, advice: 0, hasSecret: false }
  for (const item of pending?.items ?? []) {
    if (isInScope(pendingItemScopes(item), scope) === outside) continue
    const key = pendingItemKey(item)
    if (seen.has(key)) continue
    seen.add(key)
    if (item.level === 'advice') count.advice += 1
    else count.todo += 1
    if (item.kind === 'secret') count.hasSecret = true
  }
  return count
}

function dataOf<V>(state: ViewState<V>): V | undefined {
  return state.status === 'ready' ? state.data : undefined
}

/**
 * 左栏列出的作用域：全局在前，项目按显示名的字母序（同名按路径）。项目取有记忆的、只剩最近删除的、有待处理的；
 * extra 是另外要列出的项目（当前对话的项目，没有记忆也列）。
 */
function listScopes(library: LibraryView | undefined, deleted: DeletedView | undefined, pending: PendingView | undefined, extra: readonly string[]): GuiLayerRef[] {
  const paths = new Set<string>(extra)
  for (const { layer } of library?.layers ?? []) if (layer.kind === 'workspace') paths.add(layer.workspacePath)
  for (const { memory } of deleted?.items ?? []) if (memory.workspacePath !== undefined && memory.scope === 'workspace') paths.add(memory.workspacePath)
  for (const item of pending?.items ?? []) for (const layer of pendingItemScopes(item)) if (layer.kind === 'workspace') paths.add(layer.workspacePath)
  const projects = [...paths].map((workspacePath): GuiLayerRef => ({ kind: 'workspace', workspacePath })).sort(compareLayers)
  return [{ kind: 'global' }, ...projects]
}

function scopeKey(scope: PageScope): string {
  return scope.kind === 'workspace' ? `workspace:${scope.workspacePath}` : scope.kind
}

function scopeName(scope: PageScope, t: Translate): string {
  return scope.kind === 'all' ? t('scope.all') : scope.kind === 'global' ? t('scope.global') : baseName(scope.workspacePath)
}

function allSub(projects: number, t: Translate): string {
  return t(projects === 1 ? 'scope.all.sub.one' : 'scope.all.sub', { n: formatNumber(projects) })
}

/** 分数能不能写：有密钥不打分；从没体检过也不写，只有规则检查的分数会让人误以为体检过了。 */
function scoreOf(layer: HealthLayer | undefined): number | 'secret' | undefined {
  if (layer === undefined) return undefined
  if (layer.gate.secret || layer.score === null) return 'secret'
  return layer.lastCheckupAt === null ? undefined : layer.score
}

const TIER_MARKER = { green: 'ok', amber: 'pending', red: 'error' } as const satisfies Record<HealthLayer['tier'], MarkerKind>

export function MemoryPage({ nav }: { nav: NavStore }) {
  const t = useT()
  const gateway = useGateway()
  const target = useNavTarget(nav)
  const current = gateway.useCurrentWorkspace()
  // 从对话进来的那个对话的项目（不在项目里时是全局）；归属对照还在读时为 undefined
  const chat: GuiLayerRef | undefined = target.fromChat === true && current.status === 'ready'
    ? current.workspacePath === undefined ? { kind: 'global' } : { kind: 'workspace', workspacePath: current.workspacePath }
    : undefined
  const resolved: PageScope | undefined = target.scope ?? (target.fromChat === true ? chat : ALL_SCOPE)
  const session = gateway.useSession(resolved?.kind === 'workspace' ? resolved.workspacePath : undefined)
  const pendingState = gateway.useView(session, 'pending')
  const library = dataOf(gateway.useView(session, 'library'))
  const deleted = dataOf(gateway.useView(session, 'deleted'))
  const health = dataOf(gateway.useView(session, 'health'))
  const pending = dataOf(pendingState)
  const tabsId = useId()
  const entry = useLanding(nav)
  useChatLanding(nav, entry, target, resolved, pending)
  const canOpenSettings = useCanOpen(nav, 'settings')

  if (session.kind === 'none') {
    return (
      <div className="pm-page pm-page--empty">
        <header className="pm-page-head">
          <h1 className="pm-page-title">{t('page.title')}</h1>
          {canOpenSettings ? <Button onClick={() => { nav.openSettings() }}>{t('page.settings')}</Button> : null}
        </header>
        <EmptyState variant="daily" title={t('session.none.title')}>{t('session.none.body')}</EmptyState>
      </div>
    )
  }
  if (resolved === undefined) return <div className="pm-page-frame" aria-busy="true" />
  const scope = resolved
  /** 标「当前对话」的项目：从对话进来、对话在项目里时。 */
  const chatPath = chat?.kind === 'workspace' ? chat.workspacePath : undefined

  const scopes = listScopes(library, deleted, pending, [chatPath, scope.kind === 'workspace' ? scope.workspacePath : undefined].filter(p => p !== undefined))
  const isChat = (s: PageScope) => chatPath !== undefined && s.kind === 'workspace' && s.workspacePath === chatPath
  const projectCount = scopes.length - 1
  const select = (next: PageScope) => { nav.update({ scope: next, memoryId: undefined }) }
  const counts = countTodo(pending, scope)
  const libraryCount = library?.layers.filter(l => isInScope([l.layer], scope)).reduce((n, l) => n + l.items.length, 0)
  const deletedCount = deleted?.items.filter(item => isInScope([layerOfMemory(item.memory)].filter(l => l !== undefined), scope)).length

  const tabLabel = (view: MemoryView): ReactNode => {
    const count = view === 'todo' ? (pending === undefined ? undefined : counts.todo) : view === 'library' ? libraryCount : deletedCount || undefined
    return (
      <>
        {t(VIEW_LABEL[view])}
        {count !== undefined ? <span className="pm-tab-count">{formatNumber(count)}</span> : null}
        {view === 'todo' && counts.advice > 0 ? <span className="pm-tab-count">{t('tab.todo.advice', { n: formatNumber(counts.advice) })}</span> : null}
      </>
    )
  }
  const items = MEMORY_VIEWS.map((view): SegmentedTab<MemoryView> => ({
    value: view, label: tabLabel(view), id: `${tabsId}-${view}`, panelId: `${tabsId}-${view}-panel`,
  })) as [SegmentedTab<MemoryView>, ...SegmentedTab<MemoryView>[]]
  const layerHealth = scope.kind === 'all' ? undefined : health?.layers.find(l => sameLayer(l.layer, scope))

  return (
    <div className="pm-page-frame">
      <div className="pm-page">
        <aside className="pm-rail">
          <h1 className="pm-page-title">{t('page.title')}</h1>
          <ScopeRail
            scopes={[ALL_SCOPE, ...scopes]}
            selected={scope}
            onSelect={select}
            row={(s) => {
              const count = countTodo(pending, s)
              if (s.kind === 'all') return { sub: allSub(projectCount, t), count }
              const layer = library?.layers.find(l => sameLayer(l.layer, s))
              const n = layer?.items.length ?? 0
              const score = scoreOf(health?.layers.find(l => sameLayer(l.layer, s)))
              const parts = [t(n === 1 ? 'rail.count.one' : 'rail.count', { n: formatNumber(n) })]
              if (score === 'secret') parts.push(t('rail.unscored'))
              else if (score !== undefined) parts.push(t('health.score', { score: formatNumber(score) }))
              if (isChat(s)) parts.push(t('scope.currentChat'))
              return { sub: parts.join(' · '), count }
            }}
          />
          {canOpenSettings
            ? (
              <div className="pm-rail-foot">
                <button type="button" className="pm-rail-settings" onClick={() => { nav.openSettings() }}>
                  {t('rail.settings')}
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>
                </button>
              </div>
            )
            : null}
        </aside>
        <main className="pm-main">
          <NarrowScope
            scopes={[ALL_SCOPE, ...scopes]}
            selected={scope}
            onSelect={select}
            others={scope.kind === 'all' ? undefined : countTodo(pending, scope, true)}
            onSettings={canOpenSettings ? () => { nav.openSettings() } : undefined}
          />
          <header className="pm-head">
            <div className="pm-head-main">
              <h2 className="pm-head-title">{scopeName(scope, t)}</h2>
              {isChat(scope) ? <Chip variant="neutral">{t('scope.currentChat')}</Chip> : null}
              <span className="pm-head-path" title={scope.kind === 'workspace' ? scope.workspacePath : undefined}>
                {scope.kind === 'all' ? allSub(projectCount, t) : scope.kind === 'global' ? t('scope.global.sub') : scope.workspacePath}
              </span>
            </div>
            {/* 右边留给作用于这个范围的「自动体检」「立即体检」 */}
            <div className="pm-head-actions" />
          </header>
          {scope.kind !== 'all' && layerHealth !== undefined ? <ScopeStatus layer={layerHealth} /> : null}
          <SegmentedTabs label={t('tabs.label')} items={items} value={target.view} onChange={(view) => { nav.update({ view, memoryId: undefined }) }} />
          <div role="tabpanel" id={`${tabsId}-${target.view}-panel`} aria-labelledby={`${tabsId}-${target.view}`} className="pm-page-panel">
            {target.view === 'todo'
              ? <PendingTab nav={nav} session={session} scope={scope} workspacePath={scope.kind === 'workspace' ? scope.workspacePath : undefined} />
              : target.view === 'library'
                ? <LibraryTab nav={nav} scope={scope} session={session} />
                : <DeletedTab nav={nav} scope={scope} session={session} />}
          </div>
        </main>
      </div>
    </div>
  )
}

/**
 * 落点：挂载时取走入口标记，入口写过目标就照目标走；没有（点左栏图标、宿主恢复上次的面板）就落在「全部」的处理视图。
 * 页面开着时入口写的目标当场生效，标记随即作废，免得下次从图标进来被误当成入口。返回入口写的那个目标（处理完由调用方清掉）。
 */
function useLanding(nav: NavStore): MutableRefObject<NavTarget | undefined> {
  const entry = useRef<NavTarget | undefined>(undefined)
  const [fromEntry] = useState(() => {
    const was = nav.takeEntry()
    if (was) entry.current = nav.get()
    return was
  })
  useLayoutEffect(() => {
    const drain = nav.subscribe(() => { if (nav.takeEntry()) entry.current = nav.get() })
    if (!fromEntry) nav.navigate({ view: 'todo' })
    return drain
  }, [nav])
  return entry
}

/**
 * 从对话进来、只说「去处理」（没带组和记忆）：等范围和待处理视图都到了看一次，范围里既没有待处理也没有可以整理就改落记忆查看。
 * 只看入口写的那一次，之后用户自己切回处理视图不再改。
 */
function useChatLanding(
  nav: NavStore,
  entry: MutableRefObject<NavTarget | undefined>,
  target: NavTarget,
  scope: PageScope | undefined,
  pending: PendingView | undefined,
): void {
  useEffect(() => {
    if (entry.current === undefined) return
    if (entry.current !== target || target.fromChat !== true || target.view !== 'todo' || target.level !== undefined || target.memoryId !== undefined) {
      entry.current = undefined
      return
    }
    if (scope === undefined || pending === undefined) return
    entry.current = undefined
    const count = countTodo(pending, scope)
    if (count.todo === 0 && count.advice === 0) nav.update({ view: 'library' })
  })
}

/**
 * 窄屏（容器 720px 以下）顶部：「范围」下拉加「设置」；别的范围还有待处理时下面一行「其他范围还有 N 件待处理 ›」，点了回到「全部」。
 * 宽屏时由样式藏起来。
 */
function NarrowScope({ scopes, selected, onSelect, others, onSettings }: {
  scopes: readonly PageScope[]
  selected: PageScope
  onSelect: (scope: PageScope) => void
  /** 不在当前范围里的件数；当前是「全部」时不给。 */
  others: TodoCount | undefined
  onSettings: (() => void) | undefined
}) {
  const t = useT()
  const onChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const next = scopes.find(s => scopeKey(s) === event.target.value)
    if (next !== undefined && !samePageScope(next, selected)) onSelect(next)
  }
  return (
    <div className="pm-narrow">
      <div className="pm-narrow-bar">
        <label className="pm-narrow-scope">
          {t('rail.label')}
          <select value={scopeKey(selected)} onChange={onChange}>
            {scopes.map(s => <option key={scopeKey(s)} value={scopeKey(s)}>{scopeName(s, t)}</option>)}
          </select>
        </label>
        {onSettings !== undefined ? <Button variant="ghost" onClick={onSettings}>{t('page.settings')}</Button> : null}
      </div>
      {others !== undefined && others.todo > 0
        ? (
          <button type="button" className="pm-narrow-others" onClick={() => { onSelect(ALL_SCOPE) }}>
            <StatusMarker kind={others.hasSecret ? 'secret' : 'pending'} />
            {t('narrow.others', { n: formatNumber(others.todo) })}
          </button>
        )
        : null}
    </div>
  )
}

/**
 * 左栏范围列表：每行名称、副行（条数 · 分数）、右侧待处理标记加件数（密钥红三角，其余琥珀圆点；读屏念件数）。
 * 上下键在范围间移动并选中，只有选中行在 Tab 序列里。
 */
function ScopeRail({ scopes, selected, onSelect, row }: {
  scopes: readonly PageScope[]
  selected: PageScope
  onSelect: (scope: PageScope) => void
  row: (scope: PageScope) => { sub: string; count: TodoCount }
}) {
  const t = useT()
  const list = useRef<HTMLUListElement>(null)
  const index = Math.max(0, scopes.findIndex(s => samePageScope(s, selected)))
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0
    if (step === 0) return
    event.preventDefault()
    const next = Math.min(scopes.length - 1, Math.max(0, index + step))
    list.current?.querySelectorAll<HTMLButtonElement>('.pm-rail-scope').item(next).focus()
    if (next !== index) onSelect(scopes[next]!)
  }
  return (
    <nav aria-label={t('rail.label')} className="pm-rail-nav">
      <ul ref={list} className="pm-rail-list">
        {scopes.map((scope, i) => {
          const isSelected = i === index
          const { sub, count } = row(scope)
          return (
            <li key={scopeKey(scope)} className={scope.kind === 'all' ? 'pm-rail-item pm-rail-item--all' : 'pm-rail-item'}>
              <button
                type="button"
                className="pm-rail-scope"
                aria-current={isSelected ? 'true' : undefined}
                tabIndex={isSelected ? 0 : -1}
                onClick={() => { if (!isSelected) onSelect(scope) }}
                onKeyDown={onKeyDown}
              >
                <span className="pm-rail-name">{scopeName(scope, t)}</span>
                <span className="pm-rail-sub">{sub}</span>
                {count.todo > 0
                  ? (
                    <span className="pm-rail-badge">
                      <StatusMarker kind={count.hasSecret ? 'secret' : 'pending'} />
                      <span aria-hidden="true">{formatNumber(count.todo)}</span>
                      <span className="pm-sr-only">{t(count.hasSecret ? 'rail.badge.secret' : 'rail.badge', { n: formatNumber(count.todo) })}</span>
                    </span>
                  )
                  : null}
              </button>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}

/** 状态条首行：有密钥红三角、不打分；否则分档圆点加分数和分档文字；从没做过内容检查不写分数。 */
function ScopeStatus({ layer }: { layer: HealthLayer }) {
  const t = useT()
  const score = scoreOf(layer)
  return (
    <section className="pm-status" aria-label={t('status.label')}>
      <p className="pm-status-line">
        {score === 'secret'
          ? (
            <>
              <span className="pm-status-mark"><StatusMarker kind="secret" /></span>
              {t('status.unscored')}<i className="pm-sep" aria-hidden="true">·</i><span className="pm-status-soft">{t('status.secretFirst')}</span>
            </>
          )
          : score === undefined
            ? <span className="pm-status-soft">{t('health.unscored')}</span>
            : (
              <>
                <span className="pm-status-mark"><StatusMarker kind={TIER_MARKER[layer.tier]} /></span>
                {t('health.score', { score: formatNumber(score) })}<i className="pm-sep" aria-hidden="true">·</i><span className="pm-status-soft">{t(`health.tier.${layer.tier}`)}</span>
              </>
            )}
      </p>
    </section>
  )
}

export const memoryPageCss = `
/* 宿主中栏是纵向 flex：根要占满中栏、允许压缩，页面里的滚动区才有固定高度可滚。 */
.pm-root--page { flex: 1 1 0; height: 100%; min-height: 0; }
/* 顶部留白都加上宿主窗口顶带的下沉量（对齐宿主入口页；普通浏览器里为 0），侧栏收起时内容不压在红绿灯和侧栏开关下。 */
.pm-page-frame { height: 100%; min-height: 0; container-type: inline-size; background: var(--pm-bg); }
.pm-page { height: 100%; min-height: 0; display: grid; grid-template-columns: 240px minmax(0, 1fr); background: var(--pm-bg); }
.pm-page--empty { display: flex; flex-direction: column; gap: 16px; padding: calc(20px + var(--dsh-frame-top-clearance, 0px)) 32px 48px; overflow: auto; }
.pm-page-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.pm-page-title { margin: 0; font-size: 20px; font-weight: 600; line-height: 28px; color: var(--pm-text); }
.pm-rail {
  min-height: 0; display: flex; flex-direction: column; gap: 12px; padding: calc(20px + var(--dsh-frame-top-clearance, 0px)) 12px 12px;
  border-right: .5px solid var(--pm-line);
}
.pm-rail > .pm-page-title { padding: 0 10px; }
.pm-rail-nav { flex: 1; min-height: 0; overflow: auto; scrollbar-gutter: stable; }
.pm-rail-list { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 2px; }
.pm-rail-item--all { padding-bottom: 6px; margin-bottom: 4px; border-bottom: .5px solid var(--pm-line); }
.pm-rail-scope {
  width: 100%; display: grid; grid-template-columns: minmax(0, 1fr) auto; column-gap: 8px; align-items: center;
  padding: 7px 10px; border: 0; border-radius: 10px; background: transparent; font: inherit; text-align: left; color: var(--pm-text); cursor: pointer;
}
.pm-rail-scope:hover { background: var(--pm-hover); }
.pm-rail-scope[aria-current='true'] { background: var(--pm-pressed); }
.pm-rail-name { grid-column: 1; font-size: 14px; line-height: 1.5; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pm-rail-scope[aria-current='true'] .pm-rail-name { font-weight: 600; }
.pm-rail-sub { grid-column: 1; font-size: 12px; line-height: 1.5; color: var(--pm-text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pm-rail-badge { grid-column: 2; grid-row: 1 / span 2; display: inline-flex; align-items: center; gap: 4px; font-size: 12px; font-weight: 600; }
.pm-rail-foot { padding-top: 8px; border-top: .5px solid var(--pm-line); }
.pm-rail-settings {
  width: 100%; display: flex; align-items: center; justify-content: space-between; padding: 7px 10px; border: 0; border-radius: 10px;
  background: transparent; font: inherit; font-size: 13px; color: var(--pm-text-2); cursor: pointer;
}
.pm-rail-settings:hover { background: var(--pm-hover); color: var(--pm-text); }
.pm-main {
  min-height: 0; overflow: auto; scrollbar-gutter: stable;
  display: flex; flex-direction: column; gap: 16px; padding: calc(20px + var(--dsh-frame-top-clearance, 0px)) 32px 48px;
}
.pm-main > * { max-width: 840px; }
.pm-narrow { display: none; flex-direction: column; gap: 8px; }
.pm-narrow-bar { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.pm-narrow-scope {
  display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 4px 0 12px; border-radius: 10px;
  background: var(--pm-bg-block); font-size: 13px; font-weight: 600; color: var(--pm-text-2);
}
.pm-narrow-scope select {
  max-width: 220px; height: 100%; border: 0; background: transparent; font: inherit; font-weight: 600; color: var(--pm-text); cursor: pointer;
}
.pm-narrow-others {
  align-self: flex-start; display: inline-flex; align-items: center; gap: 6px; padding: 0; border: 0; background: transparent;
  font: inherit; font-size: 12px; line-height: 1.5; color: var(--pm-text-2); cursor: pointer;
}
.pm-narrow-others:hover { color: var(--pm-text); }
@container (max-width: 720px) {
  .pm-page { grid-template-columns: minmax(0, 1fr); }
  .pm-rail { display: none; }
  .pm-narrow { display: flex; }
  .pm-main { padding: calc(16px + var(--dsh-frame-top-clearance, 0px)) 16px 40px; }
}
.pm-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.pm-head-main { min-width: 0; display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 8px; }
.pm-head-title { margin: 0; font-size: 20px; font-weight: 600; line-height: 28px; color: var(--pm-text); }
.pm-head-path { min-width: 0; font-size: 12px; line-height: 1.5; color: var(--pm-text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pm-head-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
.pm-status { display: flex; flex-direction: column; gap: 6px; padding: 14px 16px; border-radius: var(--dsw-radius-lg, 16px); background: var(--pm-bg-block); }
.pm-status-line { display: flex; align-items: center; margin: 0; font-size: 14px; font-weight: 600; line-height: 1.5; color: var(--pm-text); }
.pm-status-mark { display: inline-flex; justify-content: center; width: 14px; margin-right: 8px; }
.pm-status-soft { font-weight: 400; }
.pm-tab-count { font-weight: 400; color: var(--pm-text-2); }
.pm-page-panel { min-height: 0; }
.pm-page-placeholder { margin: 24px 0; text-align: center; font-size: 12px; color: var(--pm-text-2); }
` + sharedTabCss + libraryTabCss + deletedTabCss
