/**
 * 「记忆查看」：选中范围里的记忆卡列表。搜索框 → 项目和全局下一行存储说明（每条一个文件 · 目录 · 打开目录）→ 目录问题（来自视图，
 * 不在这里重算）→ 列表，「全部」里按层分段。行尾「删除」（先原位确认「删除这条？ 删除 · 取消」，再软删）·「打开文件」；
 * 删掉的那行原位换成结果行，可撤销（发 restore）；含密钥的再确认一次彻底删除，不可恢复。
 */
import { useEffect, useState } from 'react'
import { layerOfMemory, sameLayer, type LibraryView, type MemoryCard as MemoryCardData } from '../../src/gui/contract.ts'
import { useGateway, type BorrowedSession } from '../gateway.ts'
import { useT, type Translate } from '../i18n.tsx'
import { compareLayers, isInScope, type NavStore, type PageScope } from '../nav.ts'
import { Button } from '../ui/Button.tsx'
import { EmptyState } from '../ui/EmptyState.tsx'
import { MemoryCard } from '../ui/MemoryCard.tsx'
import { DeleteWithConfirm } from '../pending/action.tsx'
import { FlashRow, LayerHeading, matchesQuery, SearchBox, useFlashTarget, useRowActions, useTypeLabel, ViewMessage } from './shared.tsx'

function dirName(path: string): string {
  return path.replace(/[\\/][^\\/]*$/, '')
}

/** 这一层的目录：记忆文件都在层目录顶层，取任一条的所在目录；空的全局层落在 `<memoryRoot>/global`。 */
function layerDir(view: LibraryView, scope: PageScope, firstFile: string | undefined): string | undefined {
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
 * deleted 画结果行；restored 是撤销了、视图还没刷新回来，照原样画。index 是删时在那一层列表里的位置。
 */
interface DoneRow { memory: MemoryCardData; index: number; state: 'deleting' | 'deleted' | 'restored' }

export function LibraryTab({ nav, scope, session, now = Date.now() }: {
  nav: NavStore
  scope: PageScope
  session: BorrowedSession
  now?: number
}) {
  const t = useT()
  const gateway = useGateway()
  const view = gateway.useView(session, 'library')
  const [query, setQuery] = useState('')
  const [done, setDone] = useState<ReadonlyMap<string, DoneRow>>(new Map())
  const actions = useRowActions(session)
  const kept = [...done.values()].filter(row => row.state !== 'deleting' || actions.isBusy(row.memory.id))
  const viewLayers = view.status === 'ready' ? view.data.layers.filter(l => isInScope([l.layer], scope)) : []
  // 一层的最后一条删掉后视图里就没有这一层了，留在原位的那几条照样要有地方放
  const keptLayers = kept.flatMap((row) => {
    const at = layerOfMemory(row.memory)
    return at !== undefined && isInScope([at], scope) && !viewLayers.some(l => sameLayer(l.layer, at)) ? [at] : []
  }).filter((layer, i, all) => all.findIndex(other => sameLayer(other, layer)) === i)
  const layers = [...viewLayers, ...keptLayers.map(layer => ({ layer, items: [] }))].sort((a, b) => compareLayers(a.layer, b.layer))
  // 本页删掉、视图里已经没有的那几条留在原位（等结果、结果行或撤销后等视图回来）
  const sections = layers.map(({ layer, items }) => {
    const rows = [...items]
    for (const row of kept) {
      const at = layerOfMemory(row.memory)
      if (at === undefined || !sameLayer(at, layer) || rows.some(m => m.id === row.memory.id)) continue
      rows.splice(Math.min(row.index, rows.length), 0, row.memory)
    }
    return { layer, items: rows.filter(m => matchesQuery(m, query)) }
  }).filter(section => section.items.length > 0)
  const items = sections.flatMap(section => section.items)
  const viewIds = layers.flatMap(l => l.items.map(m => m.id)).join('\n')
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
  const { flashId, clear } = useFlashTarget(nav, items.map(m => m.id))
  const typeLabel = useTypeLabel(session)
  if (view.status !== 'ready') return <ViewMessage state={view} />

  const data = view.data
  const total = data.layers.reduce((n, l) => n + l.items.length, 0)
  const scopeItems = layers.flatMap(l => l.items)
  const dir = layerDir(data, scope, scopeItems[0]?.filePath)
  const notice = actions.notice
  const mark = (memory: MemoryCardData, state: DoneRow['state']) => {
    setDone((prev) => {
      const layer = layerOfMemory(memory)
      const list = layers.find(l => layer !== undefined && sameLayer(l.layer, layer))?.items ?? []
      const index = (state === 'deleting' ? undefined : prev.get(memory.id)?.index) ?? Math.max(0, list.findIndex(m => m.id === memory.id))
      return new Map(prev).set(memory.id, { memory, index, state })
    })
  }

  const row = (memory: MemoryCardData) => {
    const layer = layerOfMemory(memory)
    if (done.get(memory.id)?.state === 'deleted') {
      return (
        <li key={memory.id} className="pm-list-row pm-lib-done">
          <div className="pm-row-body">
            <div className="pm-lib-gone"><MemoryCard memory={memory} now={now} typeLabel={typeLabel(memory.type)} hideScope /></div>
            <div className="pm-lib-result">
              <p className="pm-lib-result-text">{t('library.deletedResult')}</p>
              <Button
                variant="ghost"
                unavailable={actions.unavailable(memory.id)}
                onClick={() => { void actions.run(memory.id, { cmd: 'restore', memoryId: memory.id, layer }, null, () => { mark(memory, 'restored') }) }}
              >
                {t('library.undo')}
              </Button>
            </div>
            {actions.crossConfirm(memory.id)}
          </div>
        </li>
      )
    }
    return (
      <FlashRow key={memory.id} className="pm-list-row" flashing={flashId === memory.id} onFlashEnd={clear}>
        <div className="pm-row-body">
          <MemoryCard memory={memory} now={now} typeLabel={typeLabel(memory.type)} hideScope />
          {actions.crossConfirm(memory.id)}
          {actions.secretConfirm(memory.id)}
        </div>
        <div className="pm-row-actions">
          <DeleteWithConfirm
            onDelete={() => {
              mark(memory, 'deleting')
              void actions.run(memory.id, { cmd: 'forget', memoryId: memory.id, layer }, null, () => { mark(memory, 'deleted') })
            }}
            trigger={open => <Button variant="ghost" unavailable={actions.unavailable(memory.id)} onClick={open}>{t('library.delete')}</Button>}
          />
          <Button onClick={() => { void actions.open(memory.filePath) }}>{t('library.openFile')}</Button>
        </div>
      </FlashRow>
    )
  }

  return (
    <div className="pm-lib">
      <SearchBox label={t('library.search.label')} placeholder={t('library.search.placeholder')} value={query} onChange={setQuery} />
      {scopeItems.length > 0 && dir !== undefined
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
      {items.length === 0
        ? (total === 0 && kept.length === 0
            ? <EmptyState variant="first" title={t('library.empty.first.title')}>{t('library.empty.first.body')}</EmptyState>
            : scopeItems.length > 0 || kept.length > 0
              ? <EmptyState variant="daily" title={t('library.search.none')} />
              : <EmptyState variant="daily" title={t('library.empty.scope')} />)
        : scope.kind === 'all'
          ? sections.map(section => (
            <section key={section.layer.kind === 'global' ? 'global' : section.layer.workspacePath} className="pm-lib-section">
              <LayerHeading layer={section.layer} count={section.items.length} />
              <ul className="pm-list">{section.items.map(row)}</ul>
            </section>
          ))
          : <ul className="pm-list">{items.map(row)}</ul>}
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
.pm-lib-section { display: flex; flex-direction: column; }
.pm-lib-gone { opacity: .55; }
.pm-lib-result { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.pm-lib-result-text { margin: 0; font-size: 12px; line-height: 1.5; color: var(--pm-text-2); }
`
