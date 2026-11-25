/**
 * 记忆查看里一条记忆的详情：列表原位换成它，顶上「返回列表」。从上到下是这条记忆的卡片、历史版本区。
 * 数据在打开时（换中心时）经 memory-detail 现取，不缓存、不进视图文件；打开期间这条被别处改了不跟着变，下次打开再取。
 * 历史版本新的在前，每版写时段、变化原因、事实时间、出处会话，并进来的写「并入自」；点开一版经 read-version 读它的内容。
 * 列不全时写「部分历史读不到」，不写「没有历史版本」；点开一版读不出、已不在时如实说。文字都是服务端遮盖过的，按纯文本显示。
 */
import { useEffect, useId, useState } from 'react'
import { scopeKey, type HistoryEntry, type MemoryDetail as MemoryDetailData, type Scope, type VersionDetail } from '../../src/gui/contract.ts'
import { useGateway, type BorrowedSession, type ExecutionResult } from '../gateway.ts'
import { formatDay, useT, type Translate } from '../i18n.tsx'
import { NOT_RUN_KEYS } from '../command/protocol.ts'
import { Button } from '../ui/Button.tsx'
import { Chip } from '../ui/Chip.tsx'
import { Icon } from '../ui/Icon.tsx'
import { MemoryCard } from '../ui/MemoryCard.tsx'
import { baseName } from '../path.ts'
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

export function MemoryDetail({ center, session, now, onBack }: {
  center: DetailCenter
  session: BorrowedSession
  now: number
  onBack: () => void
}) {
  const t = useT()
  const gateway = useGateway()
  const typeLabel = useTypeLabel(session)
  const [load, setLoad] = useState<Load<MemoryDetailData>>({ kind: 'loading' })
  const sessionId = session.kind === 'ready' ? session.sessionId : undefined
  const centerKey = `${scopeKey(center.scope)}\u0000${center.id}`
  useEffect(() => {
    if (sessionId === undefined) return
    let isCurrent = true
    setLoad({ kind: 'loading' })
    void gateway.execute(sessionId, { cmd: 'memory-detail', memoryId: center.id, layer: center.scope }).then((r) => {
      if (!isCurrent) return
      setLoad(r.ok && r.detail !== undefined ? { kind: 'ready', data: r.detail } : { kind: 'failed', text: r.ok ? t('detail.failed', { detail: r.cmd }) : failureText(r, t) })
    })
    return () => { isCurrent = false }
  }, [centerKey, sessionId])

  const back = (
    <div className="pm-detail-bar">
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
  const { memory, status, history } = load.data
  return (
    <div className="pm-detail" key={centerKey}>
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
      <HistorySection key={centerKey} center={center} session={session} versions={history.versions} isComplete={history.isComplete} now={now} />
    </div>
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
  const toggle = () => {
    if (isOpen) { setRead(undefined); return }
    if (session.kind !== 'ready') return
    setRead({ kind: 'loading' })
    void gateway.execute(session.sessionId, { cmd: 'read-version', memoryId: center.id, layer: center.scope, versionId: version.versionId }).then((r) => {
      setRead(prev => (prev === undefined ? prev : r.ok && r.version !== undefined ? { kind: 'ready', data: r.version } : { kind: 'failed', text: r.ok ? t('detail.failed', { detail: r.cmd }) : failureText(r, t) }))
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
