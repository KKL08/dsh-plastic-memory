/**
 * 记忆查看里一条记忆的详情：列表原位换成它，顶上「返回列表」。从上到下是这条记忆的卡片、一层关联图（RelationGraph.tsx）、历史版本区。
 * 数据在打开时（换中心时）经 memory-detail 现取，不缓存、不进视图文件；打开期间这条被别处改了不跟着变，下次打开再取。
 * 借来的会话在两个就绪的会话之间换了不重新读：读到的是磁盘上的记忆，和借哪个会话无关。
 * 打开、换中心后焦点落在「返回列表」（原来拿着焦点的那一行、那个节点已经不在了）。
 * 历史版本新的在前，每版写时段、变化原因、事实时间、出处会话，并进来的写「并入自」；点开一版经 read-version 读它的内容。
 * 列不全时写「部分历史读不到」，不写「没有历史版本」；点开一版读不出、已不在时如实说。文字都是服务端遮盖过的，按纯文本显示。
 * 关联图的链接来自 memory-detail，待你决定的矛盾来自待处理视图。点同一作用域的邻居以它为中心重画（onCenter）；
 * 点别的作用域的邻居切左栏范围并直接打开它的详情；点矛盾去处理视图、定位到这一条。反向查询不全时标「关联可能不全」。
 */
import { useEffect, useId, useRef, useState } from 'react'
import { scopeKey, type HistoryEntry, type LinkEdge, type MemoryDetail as MemoryDetailData, type Scope, type VersionDetail } from '../../src/gui/contract.ts'
import { useGateway, type BorrowedSession, type ExecutionResult } from '../gateway.ts'
import { formatDay, useT, type Translate } from '../i18n.tsx'
import { NOT_RUN_KEYS } from '../command/protocol.ts'
import { Button } from '../ui/Button.tsx'
import { Chip } from '../ui/Chip.tsx'
import { Icon } from '../ui/Icon.tsx'
import { MemoryCard } from '../ui/MemoryCard.tsx'
import type { NavStore } from '../nav.ts'
import { baseName } from '../path.ts'
import { conflictNeighbours, graphNeighbours, RelationGraph, type GraphNeighbour, type GraphPick } from './RelationGraph.tsx'
import { useTypeLabel } from './shared.tsx'

/** 详情的中心：按作用域 + id 认。 */
export interface DetailCenter { id: string; scope: Scope }

type Load<T> = { kind: 'loading' } | { kind: 'ready'; data: T } | { kind: 'failed'; text: string }

/** 读取失败的一句话：这一条不在了、什么都没执行（会话在别处用着等），其余给原话。 */
function failureText(r: Extract<ExecutionResult, { ok: false }>, t: Translate): string {
  if (r.notRun !== undefined) return t(NOT_RUN_KEYS[r.notRun])
  if (r.code === 'not-found') return t('detail.gone')
  return t('detail.failed', { detail: r.detail ?? r.code })
}

/** 出处会话只露前 8 位，完整 id 在悬停提示里。 */
const shortSession = (id: string) => (id.length > 8 ? `${id.slice(0, 8)}…` : id)

export function MemoryDetail({ center, session, now, nav, onBack, onCenter }: {
  center: DetailCenter
  session: BorrowedSession
  now: number
  nav: NavStore
  onBack: () => void
  /** 以同一作用域里的另一条为中心重画。 */
  onCenter: (next: DetailCenter) => void
}) {
  const t = useT()
  const gateway = useGateway()
  const typeLabel = useTypeLabel(session)
  const centerKey = `${scopeKey(center.scope)}\u0000${center.id}`
  /** 读到的结果连同它是哪个中心的：换中心那一帧还没读，不拿上一个中心的数据配新中心。 */
  const [loaded, setLoaded] = useState<{ key: string; load: Load<MemoryDetailData> }>()
  const sessionId = session.kind === 'ready' ? session.sessionId : undefined
  const sessionRef = useRef(sessionId)
  sessionRef.current = sessionId
  const hasSession = sessionId !== undefined
  useEffect(() => {
    const id = sessionRef.current
    if (id === undefined) return
    let isCurrent = true
    void gateway.execute(id, { cmd: 'memory-detail', memoryId: center.id, layer: center.scope }).then((r) => {
      if (!isCurrent) return
      setLoaded({ key: centerKey, load: r.ok && r.detail !== undefined ? { kind: 'ready', data: r.detail } : { kind: 'failed', text: r.ok ? t('detail.failed', { detail: r.cmd }) : failureText(r, t) } })
    })
    return () => { isCurrent = false }
  }, [centerKey, hasSession])
  const backBar = useRef<HTMLDivElement>(null)
  useEffect(() => { backBar.current?.querySelector<HTMLElement>('button')?.focus() }, [centerKey])
  const load: Load<MemoryDetailData> = loaded?.key === centerKey ? loaded.load : { kind: 'loading' }

  const back = (
    <div className="pm-detail-bar" ref={backBar}>
      <Button variant="ghost" onClick={onBack}><Icon name="chevronRight" size={14} className="pm-detail-back-icon" />{t('detail.back')}</Button>
    </div>
  )
  if (load.kind !== 'ready') {
    return (
      <div className="pm-detail">
        {back}
        <p className="pm-detail-message" role="status">{load.kind === 'loading' ? t('detail.loading') : load.text}</p>
      </div>
    )
  }
  const { memory, status, history, links } = load.data
  const pick = (neighbour: GraphNeighbour, how: GraphPick) => {
    const { node } = neighbour
    if (how === 'resolve') nav.update({ view: 'todo', memoryId: center.id })
    else if (node.scope === undefined) return
    else if (how === 'switch-scope') nav.update({ view: 'library', scope: node.scope, memoryId: node.id, detail: true })
    else onCenter({ id: node.id, scope: node.scope })
  }
  return (
    <div className="pm-detail">
      {back}
      <div className="pm-detail-head">
        <h3 className="pm-detail-name">{memory.name}</h3>
        {status === 'active' ? null : <Chip variant="neutral">{t(`detail.status.${status}`)}</Chip>}
      </div>
      <MemoryCard
        memory={memory}
        now={now}
        typeLabel={typeLabel(memory.type)}
        projectName={memory.workspacePath === undefined ? undefined : baseName(memory.workspacePath)}
        collapsible
      />
      <LinksSection key={`links${centerKey}`} center={center} centerName={memory.name} session={session} edges={links.edges} isComplete={links.isComplete} onPick={pick} />
      <HistorySection key={centerKey} center={center} session={session} versions={history.versions} isComplete={history.isComplete} now={now} />
    </div>
  )
}

/**
 * 关联区：一层关联图。提示写在图上面同一处：反向查询不全时「关联可能不全」，待处理视图读不出时「矛盾读不到」；
 * 链接读全、待处理视图读到了、又一条都没有时才说「还没有记下」，待处理视图还在读时先写「正在读取」。
 */
function LinksSection({ center, centerName, session, edges, isComplete, onPick }: {
  center: DetailCenter
  centerName: string
  session: BorrowedSession
  edges: readonly LinkEdge[]
  isComplete: boolean
  onPick: (neighbour: GraphNeighbour, how: GraphPick) => void
}) {
  const t = useT()
  const titleId = useId()
  const pending = useGateway().useView(session, 'pending')
  const conflicts = pending.status === 'ready' ? conflictNeighbours(pending.data.items, center) : []
  const neighbours = graphNeighbours(edges, conflicts)
  const isPendingRead = pending.status === 'ready'
  const isPendingLoading = pending.status === 'loading' || pending.status === 'idle'
  const notes: string[] = []
  if (!isComplete) notes.push(t(neighbours.length === 0 ? 'detail.graph.partialEmpty' : 'detail.graph.partial'))
  if (!isPendingRead && !isPendingLoading) notes.push(t('detail.graph.conflictsUnreadable'))
  if (notes.length === 0 && neighbours.length === 0) notes.push(t(isPendingRead ? 'detail.graph.none' : 'detail.loading'))
  return (
    <section className="pm-detail-section" aria-labelledby={titleId}>
      <h4 id={titleId} className="pm-detail-title">{t('detail.graph.title')}</h4>
      {notes.map(note => <p key={note} className="pm-detail-note">{note}</p>)}
      {neighbours.length > 0 ? <RelationGraph center={center.scope} centerName={centerName} neighbours={neighbours} onPick={onPick} /> : null}
    </section>
  )
}

/** 历史版本区：新的在前，一版一行，点开读这一版。 */
function HistorySection({ center, session, versions, isComplete, now }: {
  center: DetailCenter
  session: BorrowedSession
  versions: readonly HistoryEntry[]
  isComplete: boolean
  now: number
}) {
  const t = useT()
  const titleId = useId()
  const note = !isComplete ? t(versions.length === 0 ? 'detail.history.partialEmpty' : 'detail.history.partial')
    : versions.length === 0 ? t('detail.history.none') : undefined
  return (
    <section className="pm-detail-section" aria-labelledby={titleId}>
      <h4 id={titleId} className="pm-detail-title">{t('detail.history.title')}</h4>
      {note !== undefined ? <p className="pm-detail-note">{note}</p> : null}
      {versions.length > 0
        ? <ol className="pm-history">{versions.map(v => <VersionRow key={v.versionId} center={center} session={session} version={v} now={now} />)}</ol>
        : null}
    </section>
  )
}

/** 一版：时段、变化原因、事实时间、出处会话、并入自；点开经 read-version 读内容，收起再点开重新读。 */
function VersionRow({ center, session, version, now }: { center: DetailCenter; session: BorrowedSession; version: HistoryEntry; now: number }) {
  const t = useT()
  const gateway = useGateway()
  const bodyId = useId()
  const [read, setRead] = useState<Load<VersionDetail>>()
  const isOpen = read !== undefined
  /** 每次点开、收起都换一个序号，只收最后一次点开的响应；卸载后不再写。 */
  const requestSeq = useRef(0)
  useEffect(() => () => { requestSeq.current += 1 }, [])
  const toggle = () => {
    const seq = ++requestSeq.current
    if (isOpen) { setRead(undefined); return }
    if (session.kind !== 'ready') return
    setRead({ kind: 'loading' })
    void gateway.execute(session.sessionId, { cmd: 'read-version', memoryId: center.id, layer: center.scope, versionId: version.versionId }).then((r) => {
      if (seq !== requestSeq.current) return
      setRead(r.ok && r.version !== undefined ? { kind: 'ready', data: r.version } : { kind: 'failed', text: r.ok ? t('detail.failed', { detail: r.cmd }) : failureText(r, t) })
    })
  }
  const { factTime, sourceSessionId, mergedFrom } = version
  return (
    <li className="pm-history-row">
      <button type="button" className="pm-history-toggle" aria-expanded={isOpen} aria-controls={bodyId} onClick={toggle}>
        <span className="pm-history-span">
          {t('detail.history.span', { start: formatDay(version.startedAt, now, t), end: formatDay(version.endedAt, now, t) })}
          <Icon name={isOpen ? 'chevronUp' : 'chevronDown'} size={14} />
        </span>
        <span className="pm-history-reason">{version.reason !== '' ? version.reason : t('detail.history.noReason')}</span>
        {factTime !== undefined || sourceSessionId !== undefined || mergedFrom !== undefined
          ? (
            <span className="pm-history-meta">
              {mergedFrom !== undefined ? <Chip variant="neutral">{t('detail.history.mergedFrom', { name: mergedFrom.name })}</Chip> : null}
              {factTime !== undefined ? <span>{t('detail.history.factTime', { time: factTime })}</span> : null}
              {sourceSessionId !== undefined ? <span title={sourceSessionId}>{t('detail.history.session', { id: shortSession(sourceSessionId) })}</span> : null}
            </span>
          )
          : null}
      </button>
      {isOpen ? <div id={bodyId} className="pm-history-body">{versionBody(read, t)}</div> : null}
    </li>
  )
}

function versionBody(read: Load<VersionDetail>, t: Translate) {
  if (read.kind === 'loading') return <p className="pm-detail-note" role="status">{t('detail.loading')}</p>
  if (read.kind === 'failed') return <p className="pm-detail-note" role="alert">{read.text}</p>
  const v = read.data
  if (v.status === 'unreadable') return <p className="pm-detail-note">{t('detail.version.unreadable')}</p>
  if (v.status === 'missing') return <p className="pm-detail-note">{t(v.isComplete ? 'detail.version.missing' : 'detail.version.missingPartial')}</p>
  return (
    <>
      <p className="pm-history-version-name">{v.name}</p>
      <p className="pm-history-version-text">{v.content}</p>
    </>
  )
}

export const memoryDetailCss = `
.pm-detail { display: flex; flex-direction: column; gap: 16px; }
.pm-detail-bar { display: flex; align-items: center; }
.pm-detail-bar .pm-btn { padding-left: 6px; }
.pm-detail-back-icon { transform: rotate(180deg); }
.pm-detail-message { margin: 24px 0; text-align: center; font-size: 12px; color: var(--pm-text-2); }
.pm-detail-head { display: flex; align-items: center; gap: 8px; min-width: 0; padding: 0 16px; }
.pm-detail-name { margin: 0; min-width: 0; font-size: 16px; font-weight: 600; line-height: 24px; color: var(--pm-text); overflow-wrap: anywhere; }
.pm-detail > .pm-mc { padding: 0 16px; }
.pm-detail-section { display: flex; flex-direction: column; gap: 8px; padding: 0 16px; }
.pm-detail-title { margin: 0; font-size: 13px; font-weight: 600; line-height: 1.5; color: var(--pm-text); }
.pm-detail-note { margin: 0; font-size: 12px; line-height: 1.5; color: var(--pm-text-2); }
.pm-history { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.pm-history-row { position: relative; }
.pm-history-row + .pm-history-row::before { content: ''; position: absolute; left: 0; right: 0; top: 0; border-top: .5px solid var(--pm-line); }
.pm-history-toggle {
  display: flex; flex-direction: column; align-items: flex-start; gap: 2px; width: 100%; padding: 10px 8px; margin: 0 -8px; box-sizing: content-box;
  border: 0; border-radius: 10px; background: transparent; font: inherit; text-align: left; color: var(--pm-text); cursor: pointer;
}
@media (hover: hover) { .pm-history-toggle:hover { background: var(--pm-hover); } }
.pm-history-span { display: inline-flex; align-items: center; gap: 4px; font-size: 13px; font-weight: 600; line-height: 1.5; }
.pm-history-span .pm-icon, .pm-history-span svg { color: var(--pm-text-2); }
.pm-history-reason { font-size: 13px; line-height: 1.55; color: var(--pm-text); overflow-wrap: anywhere; }
.pm-history-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; font-size: 12px; line-height: 1.5; color: var(--pm-text-2); }
.pm-history-body { display: flex; flex-direction: column; gap: 4px; padding: 0 0 12px; }
.pm-history-version-name { margin: 0; font-size: 12px; font-weight: 600; line-height: 1.5; color: var(--pm-text-2); overflow-wrap: anywhere; }
.pm-history-version-text {
  margin: 0; padding-left: 12px; border-left: 2px solid var(--pm-line-input);
  font-size: var(--dsh-content-font-size, 14px); line-height: 1.6; color: var(--pm-text); white-space: pre-wrap; overflow-wrap: anywhere;
}
`
