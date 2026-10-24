/**
 * 右侧栏「记忆」tab 正文（DESIGN.md Layout「右侧栏记忆 tab 内容（结构 A）」）。从上到下：
 * 面包屑「本项目 / 项目名」→ 这次对话带入的记忆（用量条）→ 这次对话新记的（可删）→ 带入的记忆（按类型分组，
 * 带入的记忆有待决横向冲突时冲突卡挂在那条记忆所在组里就地裁决）→ 底部一行入口（其余待处理只在这里带数字）。
 * 数据：会话视图（带入 / 新记的 id、用量）、全部记忆视图（按 id 取记忆卡）、待处理视图（冲突与本项目待处理数）、
 * 健康视图（bootedAt：插件本次加载时刻）。
 * 四种状态：无记忆、有全局没本项目、正常、frozenAt 早于插件本次加载（重启后未重新带入；视图没带 bootedAt 时不判断）。
 * 刚裁决的冲突在本地留原位可撤销，tab 卸载后收起。
 */
import { useMemo, useState, type ReactNode } from 'react'
import type { MemoryCard as MemoryCardData, MemoryCommand, PendingItem } from '../../src/gui/contract.ts'
import { useGateway, type BorrowedSession, type ViewState } from '../gateway.ts'
import { baseName, formatNumber, useT, type Translate } from '../i18n.tsx'
import type { LocaleKey } from '../locales.ts'
import { sidebarZh } from '../locales/sidebar.ts'
import type { NavTarget } from '../nav.ts'
import { Chip } from '../ui/Chip.tsx'
import { ConflictRuling } from '../ui/ConflictRuling.tsx'
import { ContextBudgetBar } from '../ui/ContextBudgetBar.tsx'
import { EmptyState } from '../ui/EmptyState.tsx'
import { MemoryCard } from '../ui/MemoryCard.tsx'

type Conflict = Extract<PendingItem, { kind: 'conflict-horizontal' }>
type Verdict = 'keep-left' | 'keep-right' | 'keep-both'

/** 刚裁决的冲突：两条记忆的快照留着，败方被删后仍能原位显示。 */
interface Ruled { decisionId: string; verdict: Verdict; left: MemoryCardData; right: MemoryCardData }

type Entry =
  | { kind: 'memory'; memory: MemoryCardData }
  | { kind: 'conflict'; item: Conflict }
  | { kind: 'ruled'; ruled: Ruled }

export interface SidebarTabProps {
  /** tab 所在的会话。 */
  sessionId: string
  /** 该会话的工作目录；会话视图带了 workspacePath 时以视图为准。 */
  workspacePath?: string | undefined
  /** 跳到记忆页（经导航 store）。 */
  openPage: (target: NavTarget) => void
}

function samePath(a: string | undefined, b: string): boolean {
  return a !== undefined && a.replace(/[\\/]+$/, '') === b.replace(/[\\/]+$/, '')
}

function typeLabel(t: Translate, type: string): string {
  const key = `sidebar.type.${type}`
  return key in sidebarZh ? t(key as LocaleKey) : type
}

/** 待处理条目是否属于这个项目。 */
function inWorkspace(item: PendingItem, ws: string): boolean {
  const own = (m: MemoryCardData | null) => m !== null && m.scope === 'workspace' && samePath(m.workspacePath, ws)
  switch (item.kind) {
    case 'secret': case 'conflict-vertical': case 'promote-candidate': return own(item.memory)
    case 'conflict-horizontal': return own(item.left) || own(item.right)
    case 'overflow': return samePath(item.workspacePath, ws)
    case 'unreadable-file': return item.layer.kind === 'workspace' && samePath(item.layer.workspacePath, ws)
  }
}

export function SidebarTab({ sessionId, workspacePath: cwd, openPage }: SidebarTabProps) {
  const t = useT()
  const gateway = useGateway()
  const session = useMemo<BorrowedSession>(() => ({ kind: 'ready', sessionId, cwd }), [sessionId, cwd])
  const sessionView = gateway.useView(session, 'session')
  const library = gateway.useView(session, 'library')
  const pending = gateway.useView(session, 'pending')
  const health = gateway.useView(session, 'health')
  const [ruled, setRuled] = useState<readonly Ruled[]>([])
  const [forgotten, setForgotten] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState<string | undefined>(undefined)
  const [failure, setFailure] = useState<{ id: string; detail: string } | undefined>(undefined)

  const run = async (id: string, command: MemoryCommand, onOk: () => void) => {
    setBusy(id)
    setFailure(undefined)
    const result = await gateway.execute(sessionId, command)
    setBusy(undefined)
    if (result.ok) onOk()
    else setFailure({ id, detail: result.detail ?? result.code })
  }
  const rule = (item: Conflict, verdict: Verdict) => {
    const { left, right } = item
    if (left === null || right === null) return
    void run(item.decisionId, { cmd: 'resolve', decisionId: item.decisionId, verdict }, () => {
      setRuled(prev => [...prev, { decisionId: item.decisionId, verdict, left, right }])
    })
  }
  const undo = (decisionId: string) => {
    void run(decisionId, { cmd: 'undo', decisionId }, () => { setRuled(prev => prev.filter(r => r.decisionId !== decisionId)) })
  }
  const forget = (memoryId: string) => {
    void run(memoryId, { cmd: 'forget', memoryId }, () => { setForgotten(prev => new Set(prev).add(memoryId)) })
  }

  if (library.status !== 'ready') return <div className="pm-side"><ViewNote state={library} /></div>

  const snapshot = sessionView.status === 'ready' ? sessionView.data : undefined
  const ws = snapshot?.workspacePath ?? cwd
  const byId = new Map<string, MemoryCardData>()
  let globalCount = 0
  let projectCount = 0
  for (const { layer, items } of library.data.layers) {
    for (const item of items) byId.set(item.id, item)
    if (layer.kind === 'global') globalCount += items.length
    else if (ws !== undefined && samePath(layer.workspacePath, ws)) projectCount += items.length
  }
  if (globalCount === 0 && projectCount === 0) {
    return <div className="pm-side"><EmptyState variant="first" title={t('sidebar.empty.title')}>{t('sidebar.empty.body')}</EmptyState></div>
  }

  // 带入的记忆按类型分组；记忆有待决横向冲突（或刚裁决完）时，那张冲突卡占它的位置，另一方不再单独列
  const conflicts = pending.status === 'ready'
    ? pending.data.items.filter((item): item is Conflict => item.kind === 'conflict-horizontal')
    : []
  const ruledIds = new Set(ruled.map(r => r.decisionId))
  const inline = new Set<string>()
  const shown = new Set<string>()
  const groups = new Map<string, Entry[]>()
  const counts = new Map<string, number>()
  const push = (type: string, entry: Entry) => { groups.set(type, [...groups.get(type) ?? [], entry]) }
  for (const id of snapshot?.injectedIds ?? []) {
    const done = ruled.find(r => r.left.id === id || r.right.id === id)
    const memory = byId.get(id) ?? (done === undefined ? undefined : done.left.id === id ? done.left : done.right)
    if (memory === undefined) continue
    counts.set(memory.type, (counts.get(memory.type) ?? 0) + 1)
    if (shown.has(id)) continue
    const open = done === undefined
      ? conflicts.find(c => !ruledIds.has(c.decisionId) && (c.left?.id === id || c.right?.id === id))
      : undefined
    if (done !== undefined) {
      push(memory.type, { kind: 'ruled', ruled: done })
      shown.add(done.left.id).add(done.right.id)
    } else if (open !== undefined) {
      push(memory.type, { kind: 'conflict', item: open })
      inline.add(open.decisionId)
      for (const side of [open.left, open.right]) if (side !== null) shown.add(side.id)
    } else {
      push(memory.type, { kind: 'memory', memory })
      shown.add(id)
    }
  }
  const saved = (snapshot?.savedIds ?? []).filter(id => !forgotten.has(id)).flatMap(id => byId.get(id) ?? [])
  const scope = ws === undefined ? undefined : { kind: 'workspace' as const, workspacePath: ws }
  const restPending = ws === undefined || pending.status !== 'ready'
    ? 0
    : pending.data.items.filter(item => inWorkspace(item, ws) && !('decisionId' in item && (inline.has(item.decisionId) || ruledIds.has(item.decisionId)))).length
  const now = Date.now()
  const card = (memory: MemoryCardData, chip?: ReactNode) => (
    <MemoryCard memory={memory} now={now} typeLabel={typeLabel(t, memory.type)} hideScope={memory.scope === 'workspace'} chip={chip} />
  )
  const failed = (id: string) => (failure?.id === id
    ? <p className="pm-side-error" role="alert">{t('sidebar.action.failed', { detail: failure.detail })}</p>
    : null)

  // 会话快照冻结在插件本次加载之前 = 重启后还没重新带入
  const bootedAt = health.status === 'ready' ? health.data.bootedAt : undefined
  const usage = snapshot === undefined
    ? sessionView.status === 'missing'
      ? <Note title={t('sidebar.noSnapshot.title')}>{t('sidebar.noSnapshot.body')}</Note>
      : <ViewNote state={sessionView} />
    : bootedAt !== undefined && snapshot.frozenAt < bootedAt
      ? <Note title={t('sidebar.stale.title')}>{t('sidebar.stale.body')}</Note>
      : (
        <ContextBudgetBar
          count={snapshot.injectedIds.length}
          budget={snapshot.budget}
          tokens={snapshot.tokens}
          limitTokens={snapshot.usedTokens}
          droppedCount={snapshot.overflowMode === 'strict' ? snapshot.omittedCount : 0}
          onHandle={() => { openPage({ tab: 'pending', ...(scope === undefined ? {} : { scope }) }) }}
        />
      )

  return (
    <div className="pm-side">
      {ws !== undefined
        ? <p className="pm-side-crumb"><span className="pm-side-crumb-scope">{t('sidebar.crumb.scope')}</span> {baseName(ws)}</p>
        : null}
      {projectCount === 0 ? <p className="pm-side-crumb-hint">{t('sidebar.globalOnly')}</p> : null}

      <section className="pm-side-usage" aria-label={t('sidebar.usage.title')}>
        <h2 className="pm-side-title">{t('sidebar.usage.title')}</h2>
        {usage}
      </section>

      {saved.length > 0
        ? (
          <section className="pm-side-section" aria-label={t('sidebar.saved.title')}>
            <h2 className="pm-side-title">{t('sidebar.saved.title')}</h2>
            {saved.map(memory => (
              <div key={memory.id} className="pm-side-saved">
                <div className="pm-side-saved-card">{card(memory)}</div>
                <button
                  type="button"
                  className="pm-side-delete"
                  aria-label={t('sidebar.saved.delete')}
                  title={t('sidebar.saved.delete')}
                  aria-disabled={busy === memory.id || undefined}
                  onClick={() => { if (busy !== memory.id) forget(memory.id) }}
                >
                  <TrashIcon />
                </button>
                {failed(memory.id)}
              </div>
            ))}
          </section>
        )
        : null}

      {groups.size > 0
        ? (
          <section className="pm-side-section" aria-label={t('sidebar.groups.title')}>
            <h2 className="pm-side-title">{t('sidebar.groups.title')}</h2>
            {[...groups].map(([type, entries]) => (
              <section key={type} className="pm-side-group" aria-label={typeLabel(t, type)}>
                <h3 className="pm-side-group-title">
                  {typeLabel(t, type)}{' '}
                  <span className="pm-side-group-count">{formatNumber(counts.get(type) ?? 0)}</span>
                </h3>
                {entries.map((entry) => {
                  if (entry.kind === 'memory') return <div key={entry.memory.id}>{card(entry.memory)}</div>
                  if (entry.kind === 'conflict') {
                    const { item } = entry
                    return (
                      <div key={item.decisionId}>
                        <ConflictRuling
                          layout="narrow"
                          left={item.left}
                          right={item.right}
                          now={now}
                          typeLabel={type => typeLabel(t, type)}
                          hideScope={item.left?.scope !== 'global' && item.right?.scope !== 'global'}
                          unavailable={busy === item.decisionId ? t('sidebar.action.busy') : undefined}
                          onRule={(verdict) => { rule(item, verdict) }}
                        />
                        {failed(item.decisionId)}
                      </div>
                    )
                  }
                  const { ruled: r } = entry
                  return (
                    <div key={r.decisionId}>
                      <RuledCard ruled={r} card={card} busy={busy === r.decisionId} onUndo={() => { undo(r.decisionId) }} />
                      {failed(r.decisionId)}
                    </div>
                  )
                })}
              </section>
            ))}
          </section>
        )
        : null}

      {scope !== undefined && (restPending > 0 || projectCount > 0)
        ? (
          <p className="pm-side-footer">
            {restPending > 0
              ? t('sidebar.footer.pending', { n: formatNumber(restPending) })
              : t('sidebar.footer.count', { n: formatNumber(projectCount) })}
            <i className="pm-sep" aria-hidden="true">·</i>
            <button
              type="button"
              className="pm-link"
              onClick={() => { openPage({ tab: restPending > 0 ? 'pending' : 'library', scope }) }}
            >
              {t(restPending > 0 ? 'sidebar.footer.pendingLink' : 'sidebar.footer.countLink')}
            </button>
          </p>
        )
        : null}
    </div>
  )
}

/** 刚裁决完：留下的那条带「已按 A」，下面一行后果 +「撤销」。 */
function RuledCard({ ruled, card, busy, onUndo }: {
  ruled: Ruled
  card: (memory: MemoryCardData, chip?: ReactNode) => ReactNode
  busy: boolean
  onUndo: () => void
}) {
  const t = useT()
  const { verdict, left, right } = ruled
  const chipKey = verdict === 'keep-left' ? 'sidebar.ruled.keepA' : verdict === 'keep-right' ? 'sidebar.ruled.keepB' : 'sidebar.ruled.keepBoth'
  const noteKey = verdict === 'keep-left' ? 'sidebar.ruled.deletedB' : verdict === 'keep-right' ? 'sidebar.ruled.deletedA' : 'sidebar.ruled.keptBoth'
  const kept = verdict === 'keep-left' ? [left] : verdict === 'keep-right' ? [right] : [left, right]
  return (
    <article className="pm-side-ruled">
      {kept.map((memory, i) => <div key={memory.id}>{card(memory, i === 0 ? <Chip variant="result">{t(chipKey)}</Chip> : undefined)}</div>)}
      <p className="pm-side-ruled-note">
        {t(noteKey)}
        <button type="button" className="pm-link" aria-disabled={busy || undefined} onClick={() => { if (!busy) onUndo() }}>
          {t('sidebar.ruled.undo')}
        </button>
      </p>
    </article>
  )
}

function Note({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="pm-side-note" role="status">
      <p className="pm-side-note-title">{title}</p>
      <p className="pm-side-note-body">{children}</p>
    </div>
  )
}

function ViewNote({ state }: { state: ViewState<unknown> }) {
  const t = useT()
  const text = state.status === 'error' ? t('view.error', { message: state.message })
    : state.status === 'outdated' ? t('view.outdated')
    : state.status === 'missing' ? t('view.missing')
    : t('view.loading')
  return <p className="pm-side-hint" role="status">{text}</p>
}

function TrashIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 4.5h11M6.5 4.5V3h3v1.5M4 4.5l.7 8.5h6.6l.7-8.5M6.8 7v4M9.2 7v4" />
    </svg>
  )
}

export const sidebarTabCss = `
.pm-side-root { height: 100%; min-height: 0; }
.pm-side {
  height: 100%; min-height: 0; overflow: auto; scrollbar-gutter: stable;
  display: flex; flex-direction: column; gap: 20px; padding: 12px 16px 24px; background: var(--pm-bg);
}
.pm-side-crumb { margin: 0; font-size: 13px; line-height: 1.5; color: var(--pm-text); overflow-wrap: anywhere; }
.pm-side-crumb-scope { color: var(--pm-text-2); }
.pm-side-crumb-hint { margin: -14px 0 0; font-size: 12px; line-height: 1.5; color: var(--pm-text-2); }
.pm-side-hint { margin: 0; font-size: 12px; line-height: 1.5; color: var(--pm-text-2); }
.pm-side-title { margin: 0; font-size: 13px; font-weight: 600; line-height: 1.5; color: var(--pm-text); }
.pm-side-usage { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: baseline; gap: 6px 8px; }
.pm-side-usage > .pm-budget { display: contents; }
.pm-side-usage .pm-budget-summary { grid-column: 2; grid-row: 1; }
.pm-side-usage .pm-budget-bar, .pm-side-usage .pm-budget-legend, .pm-side-usage > .pm-side-note, .pm-side-usage > .pm-side-hint { grid-column: 1 / -1; }
.pm-side-section { display: flex; flex-direction: column; gap: 12px; }
.pm-side-group { display: flex; flex-direction: column; gap: 12px; }
.pm-side-group-title { margin: 4px 0 0; font-size: 12px; font-weight: 500; line-height: 1.5; color: var(--pm-text-2); }
.pm-side-group-count { margin-left: 2px; font-weight: 400; color: var(--pm-caption); }
.pm-side-saved { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: start; gap: 4px 8px; }
.pm-side-saved > .pm-side-error { grid-column: 1 / -1; }
.pm-side-delete {
  display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; padding: 0;
  border: 0; border-radius: var(--dsw-radius-sm, 8px); background: transparent; color: var(--pm-text-3); cursor: pointer;
}
.pm-side-delete:hover { background: var(--pm-hover); color: var(--pm-text); }
.pm-side-delete[aria-disabled='true'] { opacity: .4; cursor: default; }
.pm-side .pm-conflict { padding-bottom: 0; }
.pm-side .pm-conflict .pm-mc-text {
  display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; overflow: hidden;
}
.pm-side .pm-conflict-buttons { flex-wrap: nowrap; }
.pm-side .pm-conflict-buttons .pm-btn { padding: 5px 10px; }
.pm-side-ruled { display: flex; flex-direction: column; gap: 10px; }
.pm-side-ruled-note { margin: 0; padding-left: 14px; font-size: 12px; line-height: 1.6; color: var(--pm-text-2); }
.pm-side-ruled-note .pm-link { margin-left: 8px; font-size: 12px; }
.pm-link[aria-disabled='true'] { opacity: .4; cursor: default; }
.pm-side-note { display: flex; flex-direction: column; gap: 2px; padding: 12px 14px; border-radius: var(--dsw-radius-md, 12px); background: var(--pm-bg-block); }
.pm-side-note-title { margin: 0; font-size: 13px; font-weight: 500; line-height: 1.5; color: var(--pm-text); }
.pm-side-note-body { margin: 0; font-size: 12px; line-height: 1.5; color: var(--pm-text-2); }
.pm-side-error { margin: 0; font-size: 12px; line-height: 1.5; color: var(--pm-error); }
.pm-side-footer {
  margin: auto 0 0; padding-top: 12px; border-top: .5px solid var(--pm-line);
  font-size: 12px; line-height: 1.5; color: var(--pm-text-2);
}
.pm-side-footer .pm-link { font-size: 12px; }
`
