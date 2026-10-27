/**
 * 折叠区外的交付卡（DESIGN.md「Navigation & Entries」）：默认折叠成一行「这轮记住了 N 条新记忆：首条名称 ›」（名称单行截断），
 * 点了展开成「这一轮记住了 N 条」，再点收起；展开与否只在这一次挂载里，不记。
 * 展开后每条一张记忆卡，行尾垃圾桶图标（软删 `/memory forget`，可撤销，不用红）：点了原位换成「删除这条？ 删除 · 取消」，
 * 点「删除」才发，删后原位留「已删除。14 天内也能在最近删除里找回。」和「撤销」；
 * 每条右下角「查看详情 ›」（次文字色、常规字重）打开记忆页「记忆查看」并定位到这一条（故事 41）。
 * 含密钥的记忆不能软删（服务端回 has-secret，什么都没动）：原位确认，「彻底删除」发 hard-delete，删后只留不可恢复的说明、没有撤销。
 * 删没删读网关的删除状态：在右侧栏、全部记忆里删了同一条，或 agent 在对话里删了它，这里也换成删后的样子。
 * 密钥不会出现在这里：记忆卡在 savedMemoryCard 里已遮盖，口径比视图宽（疑似密钥也遮，见 tool-summary.ts）。
 * 模型标成全局提升候选的（全部记忆视图里的 promotion）：折叠行末尾「· N 条可提升为全局」，展开后那条元信息带「可提升为全局」，
 * 下方「留在本项目」「提升为全局」，处理过的换成结果文字（见 promote-in-place.tsx）。
 */
import { useId, useMemo, useState } from 'react'
import { layerOfMemory, type GuiLayerRef, type LibraryView } from '../../src/gui/contract.ts'
import { samePath, useGateway, type BorrowedSession } from '../gateway.ts'
import { useT } from '../i18n.tsx'
import type { NavTarget } from '../nav.ts'
import { Button } from '../ui/Button.tsx'
import { useTypeLabel } from '../library/shared.tsx'
import { MemoryCard } from '../ui/MemoryCard.tsx'
import { keepFocusInPlace } from '../ui/focus-return.ts'
import { TrashIcon } from '../ui/TrashIcon.tsx'
import { crossConfirmCss, DeleteWithConfirm, SecretDeleteConfirm } from '../pending/action.tsx'
import { promoteInPlaceCss, promotionOf, usePromoteInPlace, type InPlacePromotion } from '../pending/promote-in-place.tsx'
import type { SavedMemory } from './saved-turn.ts'

/** 这一行自己的进行中 / 失败 / 等确认；删没删读网关的删除状态（别处删的也算，交付卡卸载重挂也还在）。 */
type RowState =
  | { kind: 'idle' } | { kind: 'busy' } | { kind: 'failed'; detail: string }
  /** 等用户确认彻底删除（含密钥）。 */
  | { kind: 'secret' }

export interface SavedMemoriesCardProps {
  sessionId: string
  /** 会话的工作目录：本项目记忆的「查看详情」落在这个作用域。 */
  cwd: string | undefined
  saved: readonly SavedMemory[]
  now: number
  /** 打开记忆页（入口先写导航目标再切面板）。 */
  openDetail: (target: NavTarget) => void
}

/** 这条新记的记忆此刻在全部记忆视图里的样子：先找它所在的层，没有再找全局（提升过了）。视图没读到时 undefined。 */
function liveCard(library: LibraryView | undefined, id: string, layer: GuiLayerRef | undefined) {
  if (library === undefined) return undefined
  const find = (match: (l: GuiLayerRef) => boolean) => library.layers.find(l => match(l.layer))?.items.find(m => m.id === id)
  const sameLayer = (l: GuiLayerRef) => layer !== undefined && l.kind === layer.kind && (l.kind === 'global' || (layer.kind === 'workspace' && samePath(l.workspacePath, layer.workspacePath)))
  return find(sameLayer) ?? find(l => l.kind === 'global')
}

function SavedRow({ session, item, layer, promotion, now, typeLabel, onDetail, onWroteAgentsMd }: {
  session: BorrowedSession & { kind: 'ready' }
  item: SavedMemory
  /** 这条记忆所在的层：删除、撤销、提升、留下都带上它，同 id 别层还在用时也只动这一份。 */
  layer: GuiLayerRef | undefined
  /** 提升为全局的状态（全部记忆视图）。 */
  promotion: InPlacePromotion | undefined
  now: number
  typeLabel: (type: string) => string
  onDetail: () => void
  onWroteAgentsMd: () => void
}) {
  const t = useT()
  const gateway = useGateway()
  const { sessionId } = session
  const id = item.memory.id
  const promote = usePromoteInPlace(session, item.memory, layer, promotion, onWroteAgentsMd)
  // 写进了 AGENTS.md：项目里那条进了最近删除，这一行留着结果，不再给删除、查看详情
  const isWrittenToAgentsMd = promotion === 'wrote-agents-md'
  // 记下的时刻取记忆卡上的（结果事件的时间）；没有就用这一行第一次出现的时刻。只有晚于它的视图才拿来判彻底删除
  const [firstSeen] = useState(() => Date.now())
  const savedAt = Number.isFinite(item.memory.updatedAt) && item.memory.updatedAt > 0 ? item.memory.updatedAt : firstSeen
  const how = gateway.useDeletions().of(id, layer, savedAt)
  const [state, setState] = useState<RowState>({ kind: 'idle' })
  const run = async (cmd: 'forget' | 'restore' | 'hard-delete') => {
    if (state.kind === 'busy') return
    keepFocusInPlace()
    setState({ kind: 'busy' })
    const result = await gateway.execute(sessionId, { cmd, memoryId: id, layer })
    if (result.ok) setState({ kind: 'idle' })
    else if (cmd === 'forget' && result.code === 'has-secret') setState({ kind: 'secret' })
    // 撤销失败时那一行还是「已删除」，不另写原因
    else setState(cmd === 'restore' ? { kind: 'idle' } : { kind: 'failed', detail: result.detail ?? result.code })
  }
  if (isWrittenToAgentsMd) {
    return (
      <div className="pm-saved-row" data-memory-id={id}>
        <div className="pm-saved-main">
          <MemoryCard memory={item.memory} now={now} typeLabel={typeLabel(item.memory.type)} chip={promote.chip} />
          <p className="pm-saved-note pm-saved-note--meta">{t('pending.result.wroteAgentsMdBody')}</p>
        </div>
      </div>
    )
  }
  if (how === 'hard') {
    return (
      <div className="pm-saved-row pm-saved-row--deleted" data-memory-id={id}>
        <p className="pm-saved-note" tabIndex={-1}>{t('pending.secret.deletedNotice')}</p>
      </div>
    )
  }
  if (how === 'soft' && state.kind !== 'busy') {
    return (
      <div className="pm-saved-row pm-saved-row--deleted" data-memory-id={id}>
        <p className="pm-saved-note">{t('chat.card.deleted')}</p>
        <Button onClick={() => { void run('restore') }}>{t('chat.card.undo')}</Button>
      </div>
    )
  }
  return (
    <div className="pm-saved-row" data-memory-id={id}>
      <div className="pm-saved-main">
        <MemoryCard memory={item.memory} now={now} typeLabel={typeLabel(item.memory.type)} chip={promote.chip} />
        {promote.controls}
        {state.kind === 'failed' ? <p className="pm-saved-note">{t('chat.card.failed', { detail: state.detail })}</p> : null}
        {state.kind === 'secret'
          ? <SecretDeleteConfirm onCancel={() => { setState({ kind: 'idle' }) }} onConfirm={() => { void run('hard-delete') }} />
          : null}
        <div className="pm-saved-foot">
          <button type="button" className="pm-link" onClick={onDetail}>{t('chat.card.detail')}</button>
        </div>
      </div>
      <DeleteWithConfirm
        onDelete={() => { void run('forget') }}
        trigger={open => (
          <button
            type="button"
            className="pm-icon-btn"
            aria-label={t('chat.card.delete')}
            title={t('chat.card.delete')}
            aria-disabled={state.kind === 'busy' || state.kind === 'secret' || undefined}
            onClick={() => { if (state.kind !== 'busy' && state.kind !== 'secret') open() }}
          >
            <TrashIcon />
          </button>
        )}
      />
    </div>
  )
}

export function SavedMemoriesCard({ sessionId, cwd, saved, now, openDetail }: SavedMemoriesCardProps) {
  const t = useT()
  const [isOpen, setOpen] = useState(false)
  /** 这里写进了 AGENTS.md 的：记忆已离开视图，按 id 留着结果。 */
  const [wroteAgentsMd, setWroteAgentsMd] = useState<ReadonlySet<string>>(new Set())
  const listId = useId()
  const session = useMemo<BorrowedSession & { kind: 'ready' }>(() => ({ kind: 'ready', sessionId, cwd }), [sessionId, cwd])
  const typeLabel = useTypeLabel(session)
  const gateway = useGateway()
  // 本项目记忆的层：工具结果里没有项目路径，取服务端给这个会话定的项目（会话视图），还没有时退回会话的工作目录
  const sessionView = gateway.useView(session, 'session')
  const library = gateway.useView(session, 'library')
  const workspacePath = (sessionView.status === 'ready' ? sessionView.data.workspacePath : undefined) ?? cwd
  const layerOf = (memory: SavedMemory['memory']): GuiLayerRef | undefined => layerOfMemory(memory)
    ?? (workspacePath === undefined ? undefined : { kind: 'workspace', workspacePath })
  // 提升过的按全局那一份写作用域，删除、撤销、查看详情也落在全局
  const current = (item: SavedMemory): { memory: SavedMemory['memory']; promotion: InPlacePromotion | undefined } => {
    if (wroteAgentsMd.has(item.memory.id)) return { memory: item.memory, promotion: 'wrote-agents-md' }
    const live = liveCard(library.status === 'ready' ? library.data : undefined, item.memory.id, layerOf(item.memory))
    const promotion = promotionOf(live)
    if (promotion !== 'promoted') return { memory: item.memory, promotion }
    const { workspacePath: _workspacePath, ...rest } = item.memory
    return { memory: { ...rest, scope: 'global' }, promotion }
  }
  const candidates = saved.filter(item => current(item).promotion === 'candidate').length
  // 全局记忆落在全局；本项目记忆落在会话的工作目录，不知道工作目录时只带 id
  const detail = (memory: SavedMemory['memory']) => {
    const scope: GuiLayerRef | undefined = memory.scope === 'global' ? { kind: 'global' }
      : cwd === undefined ? undefined : { kind: 'workspace', workspacePath: cwd }
    openDetail({ tab: 'library', ...(scope === undefined ? {} : { scope }), memoryId: memory.id })
  }
  return (
    <section className="pm-saved" data-open={isOpen || undefined} aria-label={t('chat.card.title', { count: saved.length })}>
      <h3 className="pm-saved-title">
        <button type="button" className="pm-saved-toggle" aria-expanded={isOpen} aria-controls={listId} onClick={() => { setOpen(!isOpen) }}>
          {isOpen
            ? <span className="pm-saved-lead">{t('chat.card.title', { count: saved.length })}</span>
            : (
              <>
                <span className="pm-saved-lead">{t(saved.length === 1 ? 'chat.card.folded.one' : 'chat.card.folded', { count: saved.length })}</span>
                <span className="pm-saved-first" title={saved[0]?.memory.name}>{saved[0]?.memory.name}</span>
                {candidates > 0
                  ? <span className="pm-saved-hint"><i className="pm-sep" aria-hidden="true">·</i>{t('chat.card.folded.promote', { count: candidates })}</span>
                  : null}
              </>
            )}
          <span className="pm-saved-chevron" aria-hidden="true">›</span>
        </button>
      </h3>
      <div className="pm-saved-list" id={listId} hidden={!isOpen}>
        {isOpen ? saved.map((item) => {
          const { memory, promotion } = current(item)
          return (
            <SavedRow
              key={item.callId}
              session={session}
              item={{ ...item, memory }}
              layer={layerOf(memory)}
              promotion={promotion}
              now={now}
              typeLabel={typeLabel}
              onDetail={() => { detail(memory) }}
              onWroteAgentsMd={() => { setWroteAgentsMd(prev => new Set(prev).add(item.memory.id)) }}
            />
          )
        }) : null}
      </div>
    </section>
  )
}

export const savedMemoriesCardCss = crossConfirmCss + promoteInPlaceCss + `
.pm-saved {
  display: flex; flex-direction: column; gap: 10px; margin: 4px 0; padding: 12px 14px;
  border: 0.5px solid var(--pm-line-card); border-radius: var(--dsw-radius-lg, 16px); background: var(--pm-bg);
}
.pm-saved-title { margin: 0; font-size: 13px; font-weight: 600; line-height: 1.5; color: var(--pm-text); }
.pm-saved-toggle {
  display: flex; align-items: baseline; width: 100%; min-width: 0; padding: 0; border: 0; background: none;
  font: inherit; color: inherit; text-align: left; cursor: pointer;
}
.pm-saved-lead { flex: none; white-space: pre; }
.pm-saved-first { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 400; color: var(--pm-text-2); }
.pm-saved-hint { flex: none; font-weight: 400; color: var(--pm-text-2); white-space: nowrap; }
.pm-saved-chevron { flex: none; margin-left: auto; padding-left: 8px; font-weight: 400; color: var(--pm-text-2); transition: transform 150ms ease; }
.pm-saved[data-open] .pm-saved-chevron { transform: rotate(90deg); }
.pm-saved-toggle:hover .pm-saved-chevron, .pm-saved-toggle:hover .pm-saved-first, .pm-saved-toggle:hover .pm-saved-hint { color: var(--pm-text); }
.pm-saved-list[hidden] { display: none; }
.pm-saved-list { display: flex; flex-direction: column; gap: 12px; }
.pm-saved-row { display: flex; align-items: flex-start; gap: 8px; }
.pm-saved-row--deleted { align-items: center; justify-content: space-between; }
.pm-saved-main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.pm-saved-note { margin: 0; font-size: 12px; line-height: 1.5; color: var(--pm-text-2); }
.pm-saved-note--meta { padding-left: 14px; }
.pm-icon-btn {
  flex: none; display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px;
  padding: 0; border: 0; border-radius: var(--dsw-radius-sm, 8px); background: none; color: var(--pm-text-2); cursor: pointer;
}
.pm-icon-btn svg { width: 14px; height: 14px; }
.pm-icon-btn:hover:not([aria-disabled='true']) { background: var(--pm-hover); color: var(--pm-text); }
.pm-icon-btn[aria-disabled='true'] { opacity: .4; cursor: default; }
.pm-saved-foot { display: flex; justify-content: flex-end; }
.pm-saved-foot .pm-link { font-size: 12px; font-weight: 400; color: var(--pm-text-2); }
.pm-saved-foot .pm-link:hover { color: var(--pm-text); text-decoration: none; }
`
