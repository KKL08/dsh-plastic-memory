/**
 * 左栏记忆页的外壳：标题「记忆」+ 作用域下拉，四个 tab（待处理、全部记忆带数；健康、最近删除），tab 内容由后续票填。
 * 两态：一个会话都没有 → 空态「开一个会话后这里可用」；有会话 → 全功能。
 * 当前视图与作用域在导航 store 里，入口直达时先写 store 再切面板。
 */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import type { GuiLayerRef } from '../src/gui/contract.ts'
import { useGateway, type ViewState } from './gateway.ts'
import { baseName, formatNumber, useT, type Translate } from './i18n.tsx'
import { MEMORY_TABS, useNavTarget, type MemoryTab, type NavStore } from './nav.ts'
import { PendingTab } from './pending/PendingTab.tsx'
import { EmptyState } from './ui/EmptyState.tsx'
import { SegmentedTabs, type SegmentedTab } from './ui/Segmented.tsx'

const TAB_LABEL = { pending: 'tab.pending', library: 'tab.library', health: 'tab.health', deleted: 'tab.deleted' } as const

function sameScope(a: GuiLayerRef, b: GuiLayerRef): boolean {
  return a.kind === b.kind && (a.kind === 'global' || (b.kind === 'workspace' && a.workspacePath === b.workspacePath))
}

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
  const currentWorkspace = gateway.useCurrentWorkspace()
  const scope: GuiLayerRef = target.scope
    ?? (currentWorkspace !== undefined ? { kind: 'workspace', workspacePath: currentWorkspace } : { kind: 'global' })
  const session = gateway.useSession(scope.kind === 'workspace' ? scope.workspacePath : undefined)
  const pending = gateway.useView(session, 'pending')
  const library = gateway.useView(session, 'library')
  const tabsId = useId()

  const options: GuiLayerRef[] = []
  const add = (ref: GuiLayerRef) => { if (!options.some(o => sameScope(o, ref))) options.push(ref) }
  if (currentWorkspace !== undefined) add({ kind: 'workspace', workspacePath: currentWorkspace })
  add(scope)
  if (library.status === 'ready') for (const layer of library.data.layers) if (layer.layer.kind === 'workspace') add(layer.layer)
  add({ kind: 'global' })

  const counts: Partial<Record<MemoryTab, number>> = {
    pending: countOf(pending, data => data.items.length),
    library: countOf(library, data => data.layers.find(l => sameScope(l.layer, scope))?.items.length ?? 0),
  }
  const tabLabel = (tab: MemoryTab): ReactNode => (
    <>
      {t(TAB_LABEL[tab])}
      {counts[tab] !== undefined ? <span className="pm-tab-count">{formatNumber(counts[tab])}</span> : null}
    </>
  )
  const items = MEMORY_TABS.map((tab): SegmentedTab<MemoryTab> => ({
    value: tab, label: tabLabel(tab), id: `${tabsId}-${tab}`, panelId: `${tabsId}-${tab}-panel`,
  })) as [SegmentedTab<MemoryTab>, ...SegmentedTab<MemoryTab>[]]

  return (
    <div className="pm-page">
      <header className="pm-page-head">
        <h1 className="pm-page-title">{t('page.title')}</h1>
        {session.kind === 'ready'
          ? (
            <ScopePicker
              value={scope}
              options={options}
              label={(ref) => scopeLabel(ref, currentWorkspace, t)}
              onChange={(next) => { nav.update({ scope: next, memoryId: undefined }) }}
            />
          )
          : null}
      </header>
      {session.kind === 'none'
        ? <EmptyState variant="daily" title={t('session.none.title')}>{t('session.none.body')}</EmptyState>
        : (
          <>
            <SegmentedTabs label={t('tabs.label')} items={items} value={target.tab} onChange={(tab) => { nav.update({ tab, memoryId: undefined }) }} />
            <div role="tabpanel" id={`${tabsId}-${target.tab}-panel`} aria-labelledby={`${tabsId}-${target.tab}`} className="pm-page-panel">
              {target.tab === 'pending'
                ? <PendingTab session={session} workspacePath={scope.kind === 'workspace' ? scope.workspacePath : undefined} />
                : <p className="pm-page-placeholder">{t('page.placeholder')}</p>}
            </div>
          </>
        )}
    </div>
  )
}

function ScopePicker({ value, options, label, onChange }: {
  value: GuiLayerRef
  options: readonly GuiLayerRef[]
  label: (scope: GuiLayerRef) => string
  onChange: (scope: GuiLayerRef) => void
}) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const listId = useId()
  useEffect(() => {
    if (!open) return
    const close = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('pointerdown', close)
    return () => { document.removeEventListener('pointerdown', close) }
  }, [open])
  const pick = (scope: GuiLayerRef) => { setOpen(false); if (!sameScope(scope, value)) onChange(scope) }
  return (
    <div className="pm-scope" ref={root} onKeyDown={(event) => { if (event.key === 'Escape') setOpen(false) }}>
      <button
        type="button"
        className="pm-scope-button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => { setOpen(!open) }}
      >
        {label(value)}
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><path d="m3 4.5 3 3 3-3" /></svg>
      </button>
      {open
        ? (
          <ul className="pm-scope-menu" role="listbox" id={listId} aria-label={t('scope.label')}>
            {options.map((scope) => {
              const selected = sameScope(scope, value)
              return (
                <li
                  key={scope.kind === 'global' ? 'global' : scope.workspacePath}
                  role="option"
                  aria-selected={selected}
                  tabIndex={0}
                  className="pm-scope-option"
                  onClick={() => { pick(scope) }}
                  onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); pick(scope) } }}
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
.pm-scope-option:hover { background: var(--pm-hover); }
.pm-scope-option[aria-selected='true'] { font-weight: 600; }
@media (max-width: 560px) { .pm-page { padding: 16px; } }
`
