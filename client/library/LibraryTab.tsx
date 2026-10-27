/**
 * 「记忆查看」tab：页面作用域那一层的记忆卡列表。顶部存储说明（多少条、目录、MEMORY.md 是生成的索引、
 * 模型怎么读到）和目录问题（来自视图，不在这里重算）；行尾打开文件、在访达中显示、删除（先原位确认「删除这条？ 删除 · 取消」，
 * 再软删，提示去最近删除恢复；含密钥的再确认一次彻底删除，不可恢复）。
 */
import { layerOfMemory, type GuiLayerRef, type LibraryView } from '../../src/gui/contract.ts'
import { useGateway, type BorrowedSession } from '../gateway.ts'
import { formatNumber, useT, type Translate } from '../i18n.tsx'
import { sameScope, type NavStore } from '../nav.ts'
import { Button } from '../ui/Button.tsx'
import { EmptyState } from '../ui/EmptyState.tsx'
import { MemoryCard } from '../ui/MemoryCard.tsx'
import { DeleteWithConfirm } from '../pending/action.tsx'
import { FlashRow, useFlashTarget, useRowActions, useTypeLabel, ViewMessage } from './shared.tsx'

function dirName(path: string): string {
  return path.replace(/[\\/][^\\/]*$/, '')
}

/** 这一层的目录：记忆文件都在层目录顶层，取任一条的所在目录；空的全局层落在 `<memoryRoot>/global`。 */
function layerDir(view: LibraryView, scope: GuiLayerRef, firstFile: string | undefined): string | undefined {
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

export function LibraryTab({ nav, scope, session, now = Date.now() }: {
  nav: NavStore
  scope: GuiLayerRef
  session: BorrowedSession
  now?: number
}) {
  const t = useT()
  const gateway = useGateway()
  const view = gateway.useView(session, 'library')
  const items = view.status === 'ready' ? view.data.layers.find(l => sameScope(l.layer, scope))?.items ?? [] : []
  const { flashId, clear } = useFlashTarget(nav, items.map(m => m.id))
  const actions = useRowActions(session)
  const typeLabel = useTypeLabel(session)
  if (view.status !== 'ready') return <ViewMessage state={view} />

  const data = view.data
  const total = data.layers.reduce((n, l) => n + l.items.length, 0)
  const dir = layerDir(data, scope, items[0]?.filePath)
  const notice = actions.notice

  return (
    <div className="pm-lib">
      {items.length > 0
        ? (
          <section className="pm-lib-storage" aria-label={t('tab.library')}>
            <p className="pm-lib-storage-line">
              <span>{t('library.storage.count', { n: formatNumber(items.length) })}</span>
              {dir !== undefined
                ? (
                  <>
                    <i className="pm-sep" aria-hidden="true">·</i>
                    <span className="pm-lib-path" title={dir}>{dir}</span>
                    <button type="button" className="pm-link" onClick={() => { void actions.open(dir) }}>{t('library.storage.openDir')}</button>
                  </>
                )
                : null}
            </p>
            <p className="pm-lib-storage-note">{t('library.storage.index')}{t('library.storage.read')}</p>
          </section>
        )
        : null}
      {data.directoryIssues.length > 0
        ? (
          <ul className="pm-lib-issues" aria-label={t('library.issues.label')}>
            {data.directoryIssues.map((issue, i) => <li key={i}>{issueText(issue, data.memoryRoot, t)}</li>)}
          </ul>
        )
        : null}
      {notice !== undefined
        ? (
          <p className="pm-notice" role="status" tabIndex={-1}>
            {notice.text}
            {notice.kind === 'ok'
              ? (
                <button type="button" className="pm-link" onClick={() => { nav.update({ tab: 'deleted', memoryId: notice.memoryId }) }}>
                  {t('library.goDeleted')}
                </button>
              )
              : null}
          </p>
        )
        : null}
      {items.length === 0
        ? (total === 0
            ? <EmptyState variant="first" title={t('library.empty.first.title')}>{t('library.empty.first.body')}</EmptyState>
            : <EmptyState variant="daily" title={t('library.empty.scope')} />)
        : (
          <ul className="pm-list">
            {items.map(memory => (
              <FlashRow key={memory.id} className="pm-list-row" flashing={flashId === memory.id} onFlashEnd={clear}>
                <div className="pm-row-body">
                  <MemoryCard memory={memory} now={now} typeLabel={typeLabel(memory.type)} hideScope />
                  {actions.crossConfirm(memory.id)}
                  {actions.secretConfirm(memory.id)}
                </div>
                <div className="pm-row-actions">
                  <Button onClick={() => { void actions.open(memory.filePath) }}>{t('library.openFile')}</Button>
                  <Button onClick={() => { void actions.open(memory.filePath, 'reveal') }}>{t('library.reveal')}</Button>
                  <DeleteWithConfirm
                    onDelete={() => {
                      void actions.run(memory.id, { cmd: 'forget', memoryId: memory.id, layer: layerOfMemory(memory) }, () => t('library.deletedNotice'))
                    }}
                    trigger={open => <Button unavailable={actions.unavailable(memory.id)} onClick={open}>{t('library.delete')}</Button>}
                  />
                </div>
              </FlashRow>
            ))}
          </ul>
        )}
    </div>
  )
}

export const libraryTabCss = `
.pm-lib { display: flex; flex-direction: column; gap: 12px; }
.pm-lib-storage { display: flex; flex-direction: column; gap: 2px; padding: 0 16px; }
.pm-lib-storage-line { display: flex; align-items: center; gap: 0; min-width: 0; margin: 0; font-size: 13px; color: var(--pm-text); }
.pm-lib-storage-line > span:first-child { flex-shrink: 0; white-space: nowrap; }
.pm-lib-storage-line .pm-link { margin-left: 8px; flex-shrink: 0; }
.pm-lib-path { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--pm-text-2); font-size: 12px; }
.pm-lib-storage-note { margin: 0; font-size: 12px; line-height: 1.5; color: var(--pm-text-2); }
.pm-lib-issues { margin: 0; padding: 0 16px; list-style: none; font-size: 12px; line-height: 1.5; color: var(--pm-text-2); overflow-wrap: anywhere; }
.pm-lib > .pm-notice { padding: 0 16px; }
`
