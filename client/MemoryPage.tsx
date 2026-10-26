/**
 * 左栏记忆页的外壳：标题「记忆」+ 作用域下拉，四个 tab（待处理带数、健康、记忆查看带数、最近删除）。
 * 两态：一个会话都没有 → 空态「开一个会话后这里可用」；有会话 → 全功能。
 * 当前视图与作用域在导航 store 里，入口直达时先写 store 再切面板。
 * 不是入口打开的（点左栏图标、宿主恢复上次的面板）按默认落点：待处理有条目落在待处理，为空落在记忆查看（PRD §4 入口③）。
 * 右上是「设置」和「体检当前项目」。
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { GuiLayerRef } from '../src/gui/contract.ts'
import { useGateway, type ViewState } from './gateway.ts'
import { baseName, formatNumber, useT, type Translate } from './i18n.tsx'
import { MEMORY_TABS, sameScope, useCanOpen, useNavTarget, type MemoryTab, type NavStore, type NavTarget } from './nav.ts'
import { HealthTab } from './health/HealthTab.tsx'
import { ScanControl } from './health/ScanControl.tsx'
import { PendingTab } from './pending/PendingTab.tsx'
import { Button } from './ui/Button.tsx'
import { EmptyState } from './ui/EmptyState.tsx'
import { DeletedTab, deletedTabCss } from './deleted/DeletedTab.tsx'
import { LibraryTab, libraryTabCss } from './library/LibraryTab.tsx'
import { sharedTabCss } from './library/shared.tsx'
import { SegmentedTabs, type SegmentedTab } from './ui/Segmented.tsx'

const TAB_LABEL = { pending: 'tab.pending', library: 'tab.library', health: 'tab.health', deleted: 'tab.deleted' } as const

function scopeLabel(scope: GuiLayerRef, currentWorkspace: string | undefined, t: Translate): string {
  if (scope.kind === 'global') return t('scope.global')
  const name = baseName(scope.workspacePath)
  return scope.workspacePath === currentWorkspace ? t('scope.current', { name }) : name
}

function countOf<V>(state: ViewState<V>, count: (data: V) => number): number | undefined {
  return state.status === 'ready' ? count(state.data) : undefined
}

export function MemoryPage({ nav }: { nav: NavStore }) {
  const t = useT()
  const gateway = useGateway()
  const target = useNavTarget(nav)
  const current = gateway.useCurrentWorkspace()
  const currentWorkspace = current.status === 'ready' ? current.workspacePath : undefined
  // 当前项目还在确认、入口也没指定作用域：先不定作用域（显示读取中），免得先按别的作用域渲染再跳过去
  const isScopeLoading = target.scope === undefined && current.status === 'loading'
  const scope: GuiLayerRef = target.scope
    ?? (currentWorkspace !== undefined ? { kind: 'workspace', workspacePath: currentWorkspace } : { kind: 'global' })
  const session = gateway.useSession(scope.kind === 'workspace' && !isScopeLoading ? scope.workspacePath : undefined)
  const pending = gateway.useView(session, 'pending')
  const library = gateway.useView(session, 'library')
  const tabsId = useId()
  useDefaultLanding(nav, pending)

  const options: GuiLayerRef[] = []
  const add = (ref: GuiLayerRef) => { if (!options.some(o => sameScope(o, ref))) options.push(ref) }
  if (currentWorkspace !== undefined) add({ kind: 'workspace', workspacePath: currentWorkspace })
  add(scope)
  if (library.status === 'ready') for (const layer of library.data.layers) if (layer.layer.kind === 'workspace') add(layer.layer)
  add({ kind: 'global' })

  const counts: Partial<Record<MemoryTab, number>> = {
    // 主数只算高优问题和待你处理
    pending: countOf(pending, data => data.levelCounts['must-fix'] + data.levelCounts['your-call']),
    library: countOf(library, data => data.layers.find(l => sameScope(l.layer, scope))?.items.length ?? 0),
  }
  const tabLabel = (tab: MemoryTab): ReactNode => (
    <>
      {t(TAB_LABEL[tab])}
      {counts[tab] !== undefined ? <span className="pm-tab-count">{formatNumber(counts[tab])}</span> : null}
    </>
  )
  const canOpenSettings = useCanOpen(nav, 'settings')
  const settingsButton = canOpenSettings ? <Button onClick={() => { nav.openSettings() }}>{t('page.settings')}</Button> : null
  const items = MEMORY_TABS.map((tab): SegmentedTab<MemoryTab> => ({
    value: tab, label: tabLabel(tab), id: `${tabsId}-${tab}`, panelId: `${tabsId}-${tab}-panel`,
  })) as [SegmentedTab<MemoryTab>, ...SegmentedTab<MemoryTab>[]]

  return (
    <div className="pm-page">
      <header className="pm-page-head">
        <h1 className="pm-page-title">{t('page.title')}</h1>
        {session.kind === 'ready' && !isScopeLoading
          ? (
            <ScopePicker
              value={scope}
              options={options}
              label={(ref) => scopeLabel(ref, currentWorkspace, t)}
              onChange={(next) => { nav.update({ scope: next, memoryId: undefined }) }}
            />
          )
          : null}
        {session.kind === 'ready' && !isScopeLoading
          ? <ScanControl session={session} workspacePath={scope.kind === 'workspace' ? scope.workspacePath : currentWorkspace} hasPending={(counts.pending ?? 1) > 0} nav={nav} leading={settingsButton} />
          : <div className="pm-scan">{settingsButton}</div>}
      </header>
      {session.kind === 'none'
        ? <EmptyState variant="daily" title={t('session.none.title')}>{t('session.none.body')}</EmptyState>
        : isScopeLoading
          ? <p className="pm-page-placeholder" role="status">{t('view.loading')}</p>
          : (
            <>
              <SegmentedTabs label={t('tabs.label')} items={items} value={target.tab} onChange={(tab) => { nav.update({ tab, memoryId: undefined }) }} />
              <div role="tabpanel" id={`${tabsId}-${target.tab}-panel`} aria-labelledby={`${tabsId}-${target.tab}`} className="pm-page-panel">
                {target.tab === 'pending'
                  ? <PendingTab nav={nav} session={session} workspacePath={scope.kind === 'workspace' ? scope.workspacePath : undefined} />
                  : target.tab === 'library'
                    ? <LibraryTab nav={nav} scope={scope} session={session} />
                    : target.tab === 'deleted'
                      ? <DeletedTab nav={nav} scope={scope} session={session} />
                      : <HealthTab session={session} scope={scope} nav={nav} />}
              </div>
            </>
          )}
    </div>
  )
}

/**
 * 默认落点。挂载时取走入口标记：有就照入口写的目标走；没有就先落在待处理（作用域回到当前项目），
 * 待处理视图到了发现为空再改落记忆查看——只判断一次，用户在这之前动过目标就不改。
 * 页面开着时入口写的目标当场生效，标记随即作废，免得下次从图标进来被误当成入口。
 */
function useDefaultLanding(nav: NavStore, pending: ViewState<{ items: readonly unknown[] }>): void {
  const [fromEntry] = useState(() => nav.takeEntry())
  const landedAt = useRef<NavTarget | undefined>(undefined)
  const decided = useRef(fromEntry)
  useLayoutEffect(() => {
    const drain = nav.subscribe(() => { nav.takeEntry() })
    if (!fromEntry) {
      nav.navigate({ tab: 'pending' })
      landedAt.current = nav.get()
    }
    return drain
  }, [nav])
  useLayoutEffect(() => {
    if (decided.current || pending.status !== 'ready') return
    decided.current = true
    if (nav.get() === landedAt.current && pending.data.items.length === 0) nav.navigate({ tab: 'library' })
  }, [nav, pending])
}

/**
 * 作用域下拉：按钮 + listbox。打开时焦点落在选中项，上下键逐项移动、Home / End 到首尾，回车或空格选中，
 * Esc 收起；选中、Esc 后焦点回到按钮。选项不在 Tab 序列里，Tab 离开或点别处就收起。
 */
function ScopePicker({ value, options, label, onChange }: {
  value: GuiLayerRef
  options: readonly GuiLayerRef[]
  label: (scope: GuiLayerRef) => string
  onChange: (scope: GuiLayerRef) => void
}) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLUListElement>(null)
  const listId = useId()
  const selectedIndex = Math.max(0, options.findIndex(o => sameScope(o, value)))
  useEffect(() => {
    if (!open) return
    const close = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('pointerdown', close)
    return () => { document.removeEventListener('pointerdown', close) }
  }, [open])
  const optionAt = (index: number) => list.current?.querySelectorAll<HTMLElement>('[role="option"]')[index]
  // 只在打开的那一刻把焦点放到选中项
  useLayoutEffect(() => { if (open) optionAt(selectedIndex)?.focus() }, [open])
  const close = () => { setOpen(false); button.current?.focus() }
  const pick = (scope: GuiLayerRef) => { close(); if (!sameScope(scope, value)) onChange(scope) }
  const onListKey = (event: KeyboardEvent<HTMLUListElement>) => {
    const items = [...(list.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])]
    const current = items.indexOf(document.activeElement as HTMLElement)
    const move = { ArrowDown: Math.min(current + 1, items.length - 1), ArrowUp: Math.max(current - 1, 0), Home: 0, End: items.length - 1 }[event.key]
    if (move !== undefined) { event.preventDefault(); items[move]?.focus(); return }
    if ((event.key === 'Enter' || event.key === ' ') && current >= 0) { event.preventDefault(); pick(options[current]!) }
  }
  return (
    <div
      className="pm-scope"
      ref={root}
      onKeyDown={(event) => { if (event.key === 'Escape' && open) { event.preventDefault(); close() } }}
      onBlur={(event) => { if (open && !root.current?.contains(event.relatedTarget as Node | null)) setOpen(false) }}
    >
      <button
        ref={button}
        type="button"
        className="pm-scope-button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => { setOpen(!open) }}
        onKeyDown={(event) => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setOpen(true) } }}
      >
        {label(value)}
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><path d="m3 4.5 3 3 3-3" /></svg>
      </button>
      {open
        ? (
          <ul ref={list} className="pm-scope-menu" role="listbox" id={listId} aria-label={t('scope.label')} onKeyDown={onListKey}>
            {options.map((scope) => {
              const selected = sameScope(scope, value)
              return (
                <li
                  key={scope.kind === 'global' ? 'global' : scope.workspacePath}
                  role="option"
                  aria-selected={selected}
                  tabIndex={-1}
                  className="pm-scope-option"
                  onClick={() => { pick(scope) }}
                >
                  {label(scope)}
                </li>
              )
            })}
          </ul>
        )
        : null}
    </div>
  )
}

export const memoryPageCss = `
.pm-page {
  height: 100%; min-height: 0; overflow: auto; scrollbar-gutter: stable;
  padding: 20px 32px 48px; background: var(--pm-bg); display: flex; flex-direction: column; gap: 16px;
}
.pm-page-head { display: flex; align-items: center; gap: 12px; }
.pm-page-title { margin: 0; font-size: 20px; font-weight: 600; line-height: 28px; color: var(--pm-text); }
.pm-tab-count { font-weight: 400; color: var(--pm-text-2); }
.pm-page-panel { min-height: 0; }
.pm-page-placeholder { margin: 24px 0; text-align: center; font-size: 12px; color: var(--pm-text-2); }
.pm-scope { position: relative; }
.pm-scope-button {
  display: inline-flex; align-items: center; gap: 4px; height: 28px; padding: 0 8px; border: 0;
  border-radius: var(--dsw-radius-sm, 8px); background: transparent; font: inherit; font-size: 13px; color: var(--pm-text-2); cursor: pointer;
}
.pm-scope-button:hover, .pm-scope-button[aria-expanded='true'] { background: var(--pm-hover); color: var(--pm-text); }
.pm-scope-menu {
  position: absolute; z-index: 10; top: calc(100% + 4px); left: 0; min-width: 200px; max-height: 320px; overflow: auto;
  margin: 0; padding: 4px; list-style: none; border: .5px solid var(--pm-line-card); border-radius: var(--dsw-radius-md, 12px);
  background: var(--pm-bg); box-shadow: var(--dsw-elevation-panel);
}
.pm-scope-option { padding: 6px 10px; border-radius: var(--dsw-radius-sm, 8px); font-size: 13px; color: var(--pm-text); cursor: pointer; white-space: nowrap; }
.pm-scope-option:hover, .pm-scope-option:focus-visible { background: var(--pm-hover); }
.pm-scope-option[aria-selected='true'] { font-weight: 600; }
@media (max-width: 560px) { .pm-page { padding: 16px; } }
` + sharedTabCss + libraryTabCss + deletedTabCss
