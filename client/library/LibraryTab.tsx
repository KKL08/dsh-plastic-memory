/**
 * 「记忆查看」：选中范围里的记忆卡列表。搜索框 → 项目和全局下一行存储说明（每条一个文件 · 目录 · 打开目录）→ 目录问题（来自视图，
 * 不在这里重算）→ 列表。单个范围按类型分组，每组先露 3 条；「全部」跨范围按更新时间分四段，卡片上的范围名点了下钻到那个范围。行尾「删除」（先原位确认「删除这条？ 删除 · 取消」，再软删）·「打开文件」；
 * 删掉的那行原位换成结果行，可撤销（发 restore）；含密钥的再确认一次彻底删除，不可恢复。别处正在处理这一条时列表上方写明没有生效。
 */
import { useEffect, useState } from 'react'
import { checkupKey, scopeOfMemory, type LibraryView, type MemoryCard as MemoryCardData } from '../../src/gui/contract.ts'
import { useGateway, type BorrowedSession } from '../gateway.ts'
import { baseName, useT, type Translate } from '../i18n.tsx'
import { isInScope, scopeLabel, type NavStore, type PageScope } from '../nav.ts'
import { Button } from '../ui/Button.tsx'
import { EmptyState } from '../ui/EmptyState.tsx'
import { Icon } from '../ui/Icon.tsx'
import { MemoryCard } from '../ui/MemoryCard.tsx'
import { DeleteWithConfirm } from '../command/confirm.tsx'
import { bucketize, GROUP_PREVIEW, groupByType, MemoryGroup, RECENT_BUCKETS, recentBucketOf, useFold, type FoldMemory } from './groups.tsx'
import { FlashRow, matchesQuery, SearchBox, useFlashTarget, useRowActions, useTypeLabel, ViewMessage } from './shared.tsx'

function dirName(path: string): string {
  return path.replace(/[\\/][^\\/]*$/, '')
}

/** 这个作用域的目录：记忆文件都在作用域目录顶层，取任一条的所在目录；空的全局落在 `<memoryRoot>/global`。 */
function scopeDir(view: LibraryView, scope: PageScope, firstFile: string | undefined): string | undefined {
  if (scope.kind === 'all') return undefined
  if (firstFile !== undefined && firstFile !== '') return dirName(firstFile)
  return scope.kind === 'global' ? `${view.memoryRoot.replace(/[\\/]+$/, '')}/global` : undefined
}

function shortPath(path: string, root: string): string {
  const base = root.replace(/[\\/]+$/, '')
  return path.startsWith(`${base}/`) ? path.slice(base.length + 1) : path
}

function issueText(issue: LibraryView['directoryIssues'][number], root: string, t: Translate): string {
  const path = shortPath(issue.path, root)
  switch (issue.code) {
    case 'duplicate-id':
      // 在用的那份缺省时（旧视图文件）只能泛泛地说
      return issue.keptPath === undefined
        ? t('library.issue.other', { path })
        : t('library.issue.duplicate-id', { kept: shortPath(issue.keptPath, root), path })
    case 'marker-missing':
    case 'dir-unreadable':
      return t(`library.issue.${issue.code}`, { path })
    case 'reserved-keys':
      return t('library.issue.reserved-keys', { path, keys: (issue.keys ?? []).join(', ') })
    default:
      return t('library.issue.other', { path })
  }
}

/**
 * 本页删掉的记忆：deleting 是删除发出、结果还没回来，照原样画（宿主可能先推来没有它的视图），命令不在进行中时不算；
 * deleted 画结果行；restored 是撤销了、视图还没刷新回来，照原样画。index 是删时在这个范围列表里的位置。
 */
interface DoneRow { memory: MemoryCardData; index: number; state: 'deleting' | 'deleted' | 'restored' }

/** 一个组：单个范围按类型（先露 3 条），「全部」按时间段（不截断，「更早」默认收起）。 */
interface Group { key: string; title: string; items: MemoryCardData[]; isOpenByDefault: boolean; truncates: boolean; latest?: number }

export function LibraryTab({ nav, scope, session, fold, now = Date.now() }: {
  nav: NavStore
  scope: PageScope
  session: BorrowedSession
  /** 折叠状态：记忆页持有，这次打开期间保留；不给时用自己的一份。 */
  fold?: FoldMemory
  now?: number
}) {
  const t = useT()
  const gateway = useGateway()
  const view = gateway.useView(session, 'library')
  const [query, setQuery] = useState('')
  const [done, setDone] = useState<ReadonlyMap<string, DoneRow>>(new Map())
  const actions = useRowActions(session)
  const kept = [...done.values()].filter(row => row.state !== 'deleting' || actions.isBusy(row.memory.id))
  const viewItems = view.status === 'ready' ? view.data.layers.filter(l => isInScope([l.layer], scope)).flatMap(l => l.items) : []
  // 本页删掉、视图里已经没有的那几条留在原位（等结果、结果行或撤销后等视图回来）；分组的排序是稳定的，插回原位就落回原来的组和位置
  const scopeItems = [...viewItems]
  for (const row of kept) {
    const at = scopeOfMemory(row.memory)
    if (at === undefined || !isInScope([at], scope) || scopeItems.some(m => m.id === row.memory.id)) continue
    scopeItems.splice(Math.min(row.index, scopeItems.length), 0, row.memory)
  }
  const isSearching = query.trim() !== ''
  const items = scopeItems.filter(m => matchesQuery(m, query))
  const viewIds = viewItems.map(m => m.id).join('\n')
  // 撤销后视图里又有了：不用再替它占位
  useEffect(() => {
    const ids = new Set(viewIds.split('\n'))
    setDone((prev) => {
      const stale = [...prev.values()].filter(row => row.state === 'restored' && ids.has(row.memory.id))
      if (stale.length === 0) return prev
      const next = new Map(prev)
      for (const row of stale) next.delete(row.memory.id)
      return next
    })
  }, [viewIds])
  const { flashId, revealId, targetId, clear } = useFlashTarget(nav, items.map(m => m.id))
  const typeLabel = useTypeLabel(session)
  const folds = useFold(fold, `library|${checkupKey(scope)}`, isSearching)
  if (view.status !== 'ready') return <ViewMessage state={view} idle={null} />

  const data = view.data
  const total = data.layers.reduce((n, l) => n + l.items.length, 0)
  const dir = scopeDir(data, scope, viewItems[0]?.filePath)
  const notice = actions.notice
  const mark = (memory: MemoryCardData, state: DoneRow['state']) => {
    setDone((prev) => {
      const index = (state === 'deleting' ? undefined : prev.get(memory.id)?.index) ?? Math.max(0, viewItems.findIndex(m => m.id === memory.id))
      return new Map(prev).set(memory.id, { memory, index, state })
    })
  }
  const isAll = scope.kind === 'all'
  const groups: Group[] = isAll
    ? bucketize([...items].sort((a, b) => b.updatedAt - a.updatedAt), RECENT_BUCKETS, m => recentBucketOf(m.updatedAt, now))
      .map(({ key, items: rows }) => ({ key: `recent:${key}`, title: t(`library.recent.${key}`), items: rows, isOpenByDefault: key !== 'older', truncates: false }))
    : groupByType(items, data.typeOrder, typeLabel)
      .map(({ type, items: rows }) => ({ key: `type:${type}`, title: typeLabel(type), items: rows, isOpenByDefault: true, truncates: true, latest: rows[0]!.updatedAt }))
  // 高亮播完：目标所在的组记成展开（第 4 条以后的连展开其余），免得那一行在眼前缩回去
  const endFlash = () => {
    for (const group of groups) {
      const index = group.items.findIndex(m => m.id === flashId)
      if (index >= 0) folds.remember(group.key, { isOpen: true, ...(group.truncates && index >= GROUP_PREVIEW ? { isFull: true } : {}) })
    }
    clear()
  }

  /** 「全部」里卡片上的范围名：点了落到那个范围的记忆查看，这一条所在的组展开，滚到中间、高亮、接住焦点。 */
  const scopeLink = (memory: MemoryCardData) => {
    const own = scopeOfMemory(memory)
    if (own === undefined) return undefined
    const name = scopeLabel(own, t)
    return (
      <button
        type="button"
        className="pm-mc-item pm-lib-scope"
        aria-label={t('library.goScope', { scope: name })}
        onClick={() => { nav.update({ scope: own, memoryId: memory.id }) }}
      >
        <Icon name={own.kind === 'global' ? 'globe' : 'folder'} size={13} />
        {name}
        <span aria-hidden="true">›</span>
      </button>
    )
  }

  const row = (memory: MemoryCardData) => {
    const own = scopeOfMemory(memory)
    if (done.get(memory.id)?.state === 'deleted') {
      return (
        <li key={memory.id} className="pm-list-row pm-lib-done">
          <div className="pm-row-body">
            <div className="pm-lib-gone">
              <MemoryCard
                memory={memory}
                now={now}
                typeLabel={typeLabel(memory.type)}
                hideType={!isAll}
                hideScope={!isAll}
                projectName={memory.workspacePath === undefined ? undefined : baseName(memory.workspacePath)}
              />
            </div>
            <div className="pm-lib-result">
              <p className="pm-lib-result-text">{t('library.deletedResult')}</p>
              <Button
                variant="ghost"
                unavailable={actions.unavailable(memory.id)}
                onClick={() => { actions.run(memory.id, { cmd: 'restore', memoryId: memory.id, layer: own }, null, () => { mark(memory, 'restored') }) }}
              >
                {t('library.undo')}
              </Button>
            </div>
            {actions.feedback(memory.id)}
          </div>
        </li>
      )
    }
    return (
      <FlashRow key={memory.id} className="pm-list-row" flashing={flashId === memory.id} onFlashEnd={endFlash} takesFocus={memory.id === targetId}>
        <div className="pm-row-body">
          {isAll
            ? <MemoryCard memory={memory} now={now} typeLabel={typeLabel(memory.type)} scopeSlot={scopeLink(memory)} />
            : <MemoryCard memory={memory} now={now} hideType hideScope />}
          {actions.feedback(memory.id)}
        </div>
        <div className="pm-row-actions">
          <DeleteWithConfirm
            onDelete={() => {
              // 删的是正在高亮的那一条：当作播完，所在的组记成展开，结果行和「撤销」不缩回「展开其余」里
              if (memory.id === flashId) endFlash()
              mark(memory, 'deleting')
              actions.run(memory.id, { cmd: 'forget', memoryId: memory.id, layer: own }, null, () => { mark(memory, 'deleted') })
            }}
            trigger={open => <Button variant="ghost" unavailable={actions.unavailable(memory.id)} onClick={open}>{t('library.delete')}</Button>}
          />
          <Button onClick={() => { void actions.open(memory.filePath) }}>{t('library.openFile')}</Button>
        </div>
      </FlashRow>
    )
  }

  const group = ({ key, title, items: rows, isOpenByDefault, truncates, latest }: Group) => {
    const reveal = rows.findIndex(m => m.id === revealId)
    const isOpen = reveal >= 0 || folds.isOpen(key, isOpenByDefault)
    const isFull = !truncates || reveal >= GROUP_PREVIEW || folds.isFull(key)
    const shown = isFull ? rows : rows.slice(0, GROUP_PREVIEW)
    // 直达高亮期间收起这个组：高亮一起结束，不再把组撑着
    const settle = () => { if (reveal >= 0) clear() }
    return (
      <MemoryGroup
        key={key}
        title={title}
        count={rows.length}
        latest={latest}
        now={now}
        isOpen={isOpen}
        onToggle={() => { settle(); folds.toggle(key, isOpen) }}
        hidden={rows.length - shown.length}
        onMore={() => { folds.remember(key, { isFull: true }) }}
        onLess={truncates && isFull && !isSearching && rows.length > GROUP_PREVIEW ? () => { settle(); folds.remember(key, { isFull: false }) } : undefined}
      >
        {shown.map(row)}
      </MemoryGroup>
    )
  }

  return (
    <div className="pm-lib">
      <SearchBox label={t('library.search.label')} placeholder={t('library.search.placeholder')} value={query} onChange={setQuery} />
      {viewItems.length > 0 && dir !== undefined
        ? (
          <p className="pm-lib-storage">
            <span>{t('library.storage.oneFile')}</span>
            <i className="pm-sep" aria-hidden="true">·</i>
            <span className="pm-lib-path" title={dir}>{dir}</span>
            <button type="button" className="pm-link" onClick={() => { void actions.open(dir) }}>{t('library.storage.openDir')}</button>
          </p>
        )
        : null}
      {data.directoryIssues.length > 0
        ? (
          <ul className="pm-lib-issues" aria-label={t('library.issues.label')}>
            {data.directoryIssues.map((issue, i) => <li key={i}>{issueText(issue, data.memoryRoot, t)}</li>)}
          </ul>
        )
        : null}
      {notice !== undefined ? <p className="pm-notice" role="status" tabIndex={-1}>{notice.text}</p> : null}
      {actions.strayFailures(items.map(m => m.id))}
      {items.length === 0
        ? (total === 0 && kept.length === 0
            ? <EmptyState variant="first" title={t('library.empty.first.title')}>{t('library.empty.first.body')}</EmptyState>
            : viewItems.length > 0 || kept.length > 0
              ? <EmptyState variant="daily" title={t('library.search.none')} />
              : <EmptyState variant="daily" title={t('library.empty.scope')} />)
        : (
          <>
            {isAll && !isSearching && groups.every(g => g.key === 'recent:older') ? <p className="pm-lib-quiet">{t('library.recent.quiet')}</p> : null}
            <div className="pm-memgroups">{groups.map(group)}</div>
          </>
        )}
    </div>
  )
}

export const libraryTabCss = `
.pm-lib { display: flex; flex-direction: column; gap: 12px; }
.pm-lib-storage { display: flex; align-items: center; min-width: 0; margin: 0; padding: 0 16px; font-size: 12px; line-height: 1.5; color: var(--pm-text-2); }
.pm-lib-storage > span:first-child { flex-shrink: 0; white-space: nowrap; }
.pm-lib-storage .pm-link { margin-left: 8px; flex-shrink: 0; font-size: 12px; }
.pm-lib-path { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 12px; }
.pm-lib-issues { margin: 0; padding: 0 16px; list-style: none; font-size: 12px; line-height: 1.5; color: var(--pm-text-2); overflow-wrap: anywhere; }
.pm-lib > .pm-notice { padding: 0 16px; }
.pm-lib-quiet { margin: 0; padding: 0 16px; font-size: 12px; line-height: 1.5; color: var(--pm-text-2); }
.pm-lib-scope { padding: 0; border: 0; background: none; font: inherit; color: inherit; cursor: pointer; }
.pm-lib-scope:hover { color: var(--pm-text); text-decoration: underline; text-underline-offset: 3px; }
.pm-lib-gone { opacity: .55; }
.pm-lib-result { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.pm-lib-result-text { margin: 0; font-size: 12px; line-height: 1.5; color: var(--pm-text-2); }
`
