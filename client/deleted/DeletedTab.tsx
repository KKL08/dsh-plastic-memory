/**
 * 「最近删除」tab：页面作用域里 14 天内软删的记忆，每行写何时删、多久后彻底清除；裁决时删掉的标来源
 * （「以「胜方名」为准时删除」，次文字色，不用颜色），恢复按钮旁提示冲突会回到待处理。恢复发 `/memory restore`。
 * 密钥是物理删除，不在这里，空状态写明。
 */
import { Fragment } from 'react'
import { layerOfMemory, type DeletedView, type GuiLayerRef, type LibraryView } from '../../src/gui/contract.ts'
import { useGateway, type BorrowedSession } from '../gateway.ts'
import { formatDay, useT, type Translate } from '../i18n.tsx'
import type { NavStore } from '../nav.ts'
import { Button } from '../ui/Button.tsx'
import { EmptyState } from '../ui/EmptyState.tsx'
import { MemoryCard } from '../ui/MemoryCard.tsx'
import { FlashRow, useFlashTarget, useRowActions, useTypeLabel, ViewMessage } from '../library/shared.tsx'

type DeletedItem = DeletedView['items'][number]

const DAY_MS = 24 * 60 * 60 * 1000

function inScope(item: DeletedItem, scope: GuiLayerRef): boolean {
  return scope.kind === 'global' ? item.memory.scope === 'global' : item.memory.workspacePath === scope.workspacePath
}

/**
 * 来源：垂直冲突（有基线出处）是「以基线为准」；横向写胜方（counterpartId）的名字，在全部记忆和最近删除里都找不到时写 id。
 * 旧条目没记对方：keep-left 删的是 B（以 A 为准），keep-right 删的是 A。
 */
function causeLabel(cause: NonNullable<DeletedItem['cause']>, names: ReadonlyMap<string, string>, t: Translate): string {
  if (cause.baselineRef !== undefined) return t('deleted.cause.baseline')
  if (cause.counterpartId !== undefined) return t('deleted.cause.keep', { name: names.get(cause.counterpartId) ?? cause.counterpartId })
  return t(cause.verdict === 'keep-left' ? 'deleted.cause.keepA' : 'deleted.cause.keepB')
}

/** 记忆 id → 名字：全部记忆（各层 active）加最近删除。 */
function memoryNames(library: LibraryView | undefined, deleted: DeletedView): Map<string, string> {
  const names = new Map<string, string>()
  for (const { memory } of deleted.items) names.set(memory.id, memory.name)
  for (const layer of library?.layers ?? []) for (const memory of layer.items) names.set(memory.id, memory.name)
  return names
}

function purgeLabel(purgeAt: number, now: number, t: Translate): string {
  const days = Math.floor((purgeAt - now) / DAY_MS)
  return days < 1 ? t('deleted.purge.today') : t('deleted.purge.days', { n: days })
}

export function DeletedTab({ nav, scope, session, now = Date.now() }: {
  nav: NavStore
  scope: GuiLayerRef
  session: BorrowedSession
  now?: number
}) {
  const t = useT()
  const gateway = useGateway()
  const view = gateway.useView(session, 'deleted')
  const library = gateway.useView(session, 'library')
  const items = view.status === 'ready' ? view.data.items.filter(item => inScope(item, scope)) : []
  const { flashId, clear } = useFlashTarget(nav, items.map(item => item.memory.id))
  const actions = useRowActions(session)
  const typeLabel = useTypeLabel(session)
  if (view.status !== 'ready') return <ViewMessage state={view} />
  const names = memoryNames(library.status === 'ready' ? library.data : undefined, view.data)

  // 恢复的是最后一条时空状态和结果提示同时在：提示在上面，也是确认收起后焦点的落点
  return (
    <div className="pm-del">
      {actions.notice !== undefined ? <p className="pm-notice" role="status" tabIndex={-1}>{actions.notice.text}</p> : null}
      {items.length === 0
        ? <EmptyState variant="daily" title={t('deleted.empty.title')}>{t('deleted.empty.body')}</EmptyState>
        : (
          <ul className="pm-list">
            {items.map(({ memory, deletedAt, purgeAt, cause }) => {
              const meta = [
                cause !== undefined ? causeLabel(cause, names, t) : t('deleted.label'),
                formatDay(deletedAt, now, t),
                purgeLabel(purgeAt, now, t),
              ]
              return (
                <FlashRow key={memory.id} className="pm-list-row" flashing={flashId === memory.id} onFlashEnd={clear}>
                  <div className="pm-del-body">
                    <MemoryCard memory={memory} now={now} typeLabel={typeLabel(memory.type)} hideScope />
                    <p className="pm-del-meta">
                      {meta.map((text, i) => (
                        <Fragment key={i}>
                          {i > 0 ? <i className="pm-sep" aria-hidden="true">·</i> : null}
                          <span>{text}</span>
                        </Fragment>
                      ))}
                    </p>
                    {actions.crossConfirm(memory.id)}
                  </div>
                  <div className="pm-row-actions pm-del-actions">
                    {cause !== undefined ? <span className="pm-del-hint">{t('deleted.restoreHint')}</span> : null}
                    <Button
                      unavailable={actions.unavailable(memory.id)}
                      onClick={() => {
                        void actions.run(
                          memory.id,
                          { cmd: 'restore', memoryId: memory.id, layer: layerOfMemory(memory) },
                          result => t(result.decisionId !== undefined ? 'deleted.restoredConflict' : 'deleted.restored'),
                        )
                      }}
                    >
                      {t('deleted.restore')}
                    </Button>
                  </div>
                </FlashRow>
              )
            })}
          </ul>
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
.pm-del-hint { font-size: 12px; line-height: 1.5; color: var(--pm-text-2); }
`
