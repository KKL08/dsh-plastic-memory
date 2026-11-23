/**
 * 「最近删除」：选中范围里 14 天内软删的记忆。搜索框 → 一行保留规则 → 列表，按删除那天分「今天 / 近 7 天 / 更早」三段，
 * 都默认展开、不截断（截断会把快到期的藏起来），「全部」里卡片写范围名。每行写何时删；裁决时删掉的标来源
 * （「以「胜方名」为准时删除」，次文字色，不用颜色），下一行提示恢复后冲突会回到待处理。行尾「还能恢复 N 天 · 彻底删除… · 恢复」：
 * 恢复发 `/memory restore`；「彻底删除…」在行内确认一次，确认后发 `/memory hard-delete`，不等到期。别处正在处理这一条时上方写明没有生效。
 * 融合时并入删掉的，提示下面多一个「撤销融合」，按来源里的条目和改前快照发 `/memory undo`（期间撤销后又重新处理过的不再动手）：两条都退回融合前。入口只靠视图，离开处理视图、刷新后都还在。
 * 密钥是物理删除，不在这里，空状态写明。
 */
import { Fragment, useState } from 'react'
import { checkupKey, scopeOfMemory, type DeletedView, type LibraryView } from '../../src/gui/contract.ts'
import { useGateway, type BorrowedSession } from '../gateway.ts'
import { baseName, formatDay, useT, type Translate } from '../i18n.tsx'
import { isInScope, type NavStore, type PageScope } from '../nav.ts'
import { Button } from '../ui/Button.tsx'
import { EmptyState } from '../ui/EmptyState.tsx'
import { MemoryCard } from '../ui/MemoryCard.tsx'
import { SecretDeleteConfirm } from '../command/confirm.tsx'
import { bucketize, DELETED_BUCKETS, deletedBucketOf, MemoryGroup, useFold, type FoldMemory } from '../library/groups.tsx'
import { FlashRow, matchesQuery, SearchBox, useFlashTarget, useRowActions, useTypeLabel, ViewMessage } from '../library/shared.tsx'

type DeletedItem = DeletedView['items'][number]

const DAY_MS = 24 * 60 * 60 * 1000

function inScope(item: DeletedItem, scope: PageScope): boolean {
  const own = scopeOfMemory(item.memory)
  return isInScope(own === undefined ? [] : [own], scope)
}

/**
 * 来源：垂直冲突（有基线出处）是「以基线为准」；横向写胜方（counterpartId）的名字，在全部记忆和最近删除里都找不到时写 id；
 * 融合时并入删掉的（plan-applied）写并进了哪条。旧条目没记对方：keep-left 删的是 B（以 A 为准），keep-right 删的是 A。
 */
function causeLabel(cause: NonNullable<DeletedItem['cause']>, names: ReadonlyMap<string, string>, t: Translate): string {
  if (cause.baselineRef !== undefined) return t('deleted.cause.baseline')
  if (cause.counterpartId !== undefined) return t(cause.verdict === 'plan-applied' ? 'deleted.cause.merged' : 'deleted.cause.keep', { name: counterpartName(cause, names) })
  return t(cause.verdict === 'keep-left' ? 'deleted.cause.keepA' : 'deleted.cause.keepB')
}

const counterpartName = (cause: NonNullable<DeletedItem['cause']>, names: ReadonlyMap<string, string>) =>
  cause.counterpartId === undefined ? '' : names.get(cause.counterpartId) ?? cause.counterpartId

/**
 * 恢复之后会怎样：删一方的裁决恢复即撤销、冲突回到待处理；融合时并入的只带回这一条，融合稿不退回，要两条都退回用「撤销融合」
 * （体检关闭时撤销不了，不提）。
 */
function restoreHint(cause: NonNullable<DeletedItem['cause']>, names: ReadonlyMap<string, string>, canUndoMerge: boolean, t: Translate): string {
  if (cause.verdict !== 'plan-applied') return t('deleted.restoreHint')
  return t(canUndoMerge ? 'deleted.restoreHintMerged' : 'deleted.restoreHintMergedOnly', { name: counterpartName(cause, names) })
}

/** 记忆 id → 名字：全部记忆（各作用域 active）加最近删除。 */
function memoryNames(library: LibraryView | undefined, deleted: DeletedView): Map<string, string> {
  const names = new Map<string, string>()
  for (const { memory } of deleted.items) names.set(memory.id, memory.name)
  for (const group of library?.layers ?? []) for (const memory of group.items) names.set(memory.id, memory.name)
  return names
}

/** 剩余不足 1 天单独写，否则按天向上取整：刚删除的写 14 天，和「保留 14 天」对得上。 */
function leftLabel(purgeAt: number, now: number, t: Translate): string {
  const left = (purgeAt - now) / DAY_MS
  if (left < 1) return t('deleted.left.today')
  const days = Math.ceil(left)
  return t(days === 1 ? 'deleted.left.days.one' : 'deleted.left.days', { n: days })
}

export function DeletedTab({ nav, scope, session, fold, isGovernanceEnabled = true, now = Date.now() }: {
  nav: NavStore
  scope: PageScope
  session: BorrowedSession
  /** 折叠状态：记忆页持有，这次打开期间保留；不给时用自己的一份。 */
  fold?: FoldMemory
  /** 体检关闭时不给「撤销融合」（服务端会拒绝）。 */
  isGovernanceEnabled?: boolean
  now?: number
}) {
  const t = useT()
  const gateway = useGateway()
  const view = gateway.useView(session, 'deleted')
  const library = gateway.useView(session, 'library')
  const [query, setQuery] = useState('')
  const scopeItems = view.status === 'ready' ? view.data.items.filter(item => inScope(item, scope)) : []
  const items = scopeItems.filter(item => matchesQuery(item.memory, query))
  const { flashId, revealId, clear } = useFlashTarget(nav, items.map(item => item.memory.id))
  const actions = useRowActions(session)
  const typeLabel = useTypeLabel(session)
  /** 正在等彻底删除确认的那一行。 */
  const [confirming, setConfirming] = useState<string | undefined>(undefined)
  const isSearching = query.trim() !== ''
  const folds = useFold(fold, `deleted|${checkupKey(scope)}`, isSearching)
  if (view.status !== 'ready') return <ViewMessage state={view} idle={null} />
  const names = memoryNames(library.status === 'ready' ? library.data : undefined, view.data)
  // 高亮播完：目标所在的段记成展开，免得那一行在眼前缩回去
  const endFlash = () => {
    const target = items.find(item => item.memory.id === flashId)
    if (target !== undefined) folds.remember(deletedBucketOf(target.deletedAt, now), { isOpen: true })
    clear()
  }

  const row = ({ memory, deletedAt, purgeAt, cause }: DeletedItem) => {
    const meta = [cause !== undefined ? causeLabel(cause, names, t) : t('deleted.label'), formatDay(deletedAt, now, t)]
    const unavailable = actions.unavailable(memory.id) ?? (confirming === memory.id ? t('pending.awaitingConfirm') : undefined)
    return (
      <FlashRow key={memory.id} className="pm-list-row" flashing={flashId === memory.id} onFlashEnd={endFlash}>
        <div className="pm-del-body">
          <MemoryCard
            memory={memory}
            now={now}
            typeLabel={typeLabel(memory.type)}
            hideScope={scope.kind !== 'all'}
            projectName={memory.workspacePath === undefined ? undefined : baseName(memory.workspacePath)}
            collapsible={!isSearching}
          />
          <p className="pm-del-meta">
            {meta.map((text, i) => (
              <Fragment key={i}>
                {i > 0 ? <i className="pm-sep" aria-hidden="true">·</i> : null}
                <span>{text}</span>
              </Fragment>
            ))}
          </p>
          {cause !== undefined ? <p className="pm-del-hint">{restoreHint(cause, names, isGovernanceEnabled, t)}</p> : null}
          {cause?.verdict === 'plan-applied' && isGovernanceEnabled
            ? (
              <div className="pm-del-hint-action">
                <Button
                  variant="ghost"
                  size="sm"
                  unavailable={unavailable}
                  onClick={() => {
                    // stale 是保留的那条之后又被改过、或冲突已重新处理：点名保留的那条，不沿用「这条记忆之后又被改过」
                    actions.run(memory.id, { cmd: 'undo', decisionId: cause.decisionId, snapshotId: cause.snapshotId }, () => t('deleted.mergeUndone'), undefined, failure => (failure.code === 'stale'
                      ? { kind: 'failed', code: 'stale', detail: t('deleted.undoMergeStale', { name: counterpartName(cause, names) }), isLocalized: false }
                      : false))
                  }}
                >
                  {t('deleted.undoMerge')}
                </Button>
              </div>
            )
            : null}
          {actions.feedback(memory.id)}
          {confirming === memory.id
            ? (
              <SecretDeleteConfirm
                showTitle={false}
                body={t('deleted.hardDeleteConfirm')}
                onCancel={() => { setConfirming(undefined) }}
                onConfirm={() => {
                  setConfirming(undefined)
                  actions.run(memory.id, { cmd: 'hard-delete', memoryId: memory.id, layer: scopeOfMemory(memory) }, () => t('deleted.hardDeleted'))
                }}
              />
            )
            : null}
        </div>
        <div className="pm-row-actions pm-del-actions">
          <span className="pm-del-left">{leftLabel(purgeAt, now, t)}</span>
          <Button variant="ghost" size="sm" unavailable={unavailable} onClick={() => { setConfirming(memory.id) }}>{t('deleted.hardDelete')}</Button>
          <Button
            size="sm"
            unavailable={unavailable}
            onClick={() => {
              actions.run(
                memory.id,
                { cmd: 'restore', memoryId: memory.id, layer: scopeOfMemory(memory) },
                result => t(result.decisionId !== undefined ? 'deleted.restoredConflict' : 'deleted.restored'),
              )
            }}
          >
            {t('deleted.restore')}
          </Button>
        </div>
      </FlashRow>
    )
  }

  // 恢复的是最后一条时空状态和结果提示同时在：提示在上面，也是确认收起后焦点的落点
  return (
    <div className="pm-del">
      <SearchBox label={t('deleted.search.label')} placeholder={t('deleted.search.placeholder')} value={query} onChange={setQuery} />
      {scopeItems.length > 0 ? <p className="pm-del-note">{t('deleted.note')}</p> : null}
      {actions.notice !== undefined ? <p className="pm-notice" role="status" tabIndex={-1}>{actions.notice.text}</p> : null}
      {actions.strayFailures(items.map(item => item.memory.id))}
      {items.length === 0
        ? scopeItems.length > 0
          ? <EmptyState variant="daily" title={t('deleted.search.none')} />
          : <EmptyState variant="daily" title={t('deleted.empty.title')}>{t('deleted.empty.body')}</EmptyState>
        : (
          <div className="pm-memgroups">
            {bucketize(items, DELETED_BUCKETS, item => deletedBucketOf(item.deletedAt, now)).map(({ key, items: rows }) => {
              const isRevealing = rows.some(item => item.memory.id === revealId)
              const isOpen = isRevealing || folds.isOpen(key, true)
              return (
                <MemoryGroup
                  key={key}
                  title={t(`deleted.when.${key}`)}
                  count={rows.length}
                  now={now}
                  isOpen={isOpen}
                  onToggle={() => { if (isRevealing) clear(); folds.toggle(key, isOpen) }}
                >
                  {rows.map(row)}
                </MemoryGroup>
              )
            })}
          </div>
        )}
    </div>
  )
}

export const deletedTabCss = `
.pm-del { display: flex; flex-direction: column; gap: 12px; }
.pm-del > .pm-notice { padding: 0 16px; }
.pm-del-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.pm-del-meta { display: flex; flex-wrap: wrap; align-items: center; margin: 0; padding-left: 14px; font-size: 12px; line-height: 1.5; color: var(--pm-text-2); }
.pm-del-actions { align-items: center; }
.pm-del-note { margin: 0; padding: 0 16px; font-size: 12px; line-height: 1.5; color: var(--pm-text-2); }
.pm-del-hint { margin: 0; padding-left: 14px; font-size: 12px; line-height: 1.5; color: var(--pm-text-2); }
/* 「撤销融合」单占一行，字和提示的左缘对齐（悬停底色向左多出按钮的内边距） */
.pm-del-hint-action { padding-left: 14px; }
.pm-del-hint-action > .pm-btn { margin-left: -10px; }
.pm-del-left { font-size: 12px; line-height: 1.5; color: var(--pm-text-2); white-space: nowrap; }
`
