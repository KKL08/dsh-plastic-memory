/**
 * 设置页「存储」里的对话记录库一项：状态一行、删除按钮、原位确认，以及保存后「已不再使用，要删掉吗」的提示。
 * 状态在打开设置页、点删除、删完之后各现取一次（dialogue-records-state，只读）；删除立即执行（delete-dialogue-records），不进保存行。
 * 读不到状态时照写读不到、照样能点删除，不显示成没建。用不用得上按已保存的配置算（isDialogueInUse）。
 */
import { useEffect, useRef, useState } from 'react'
import type { MemoryCommandResult } from '../../src/gui/contract.ts'
import { useGateway } from '../gateway.ts'
import { formatNumber, useT } from '../i18n.tsx'
import { Button } from '../ui/Button.tsx'
import { SettingsItem } from '../ui/Settings.tsx'

type Status = NonNullable<Extract<MemoryCommandResult, { ok: true }>['dialogueRecords']>
/** 页面上的状态：loading = 还在取，failed = 取不到（库读不出或命令失败）。 */
type RecordsState = { status: 'loading' } | { status: 'failed' } | Status

export interface DialogueRecords {
  /** undefined = 没有会话，查看和删除都做不了。 */
  sessionId: string | undefined
  state: RecordsState
  /** checking = 点了删除、正在现查。 */
  phase: 'idle' | 'checking' | 'confirming' | 'deleting'
  isDeleteFailed: boolean
  /** 保存后用不上了、现查库明确还在：问要不要删。读不到、没建、又用得上、换了会话都不问。 */
  isOffered: boolean
  /** 点删除：先现查一次状态，库还在（或读不到）才展开确认。 */
  requestDelete(): Promise<void>
  cancel(): void
  confirmDelete(): Promise<void>
  /** 保存让它用不上了：现查一次，库明确还在才问要不要删。 */
  offerDelete(): void
}

const isPresent = (state: RecordsState) => state.status === 'ready' || state.status === 'building' || state.status === 'rebuilding'

/**
 * 对话记录库的状态和删除流程；打开设置页（有会话）时取一次状态。isInUse 按已保存的配置算。
 * 换了会话（含断开）时状态、确认、提示都从头来；别的会话发出的查询晚回来不算数。
 */
export function useDialogueRecords(sessionId: string | undefined, isInUse: boolean): DialogueRecords {
  const gateway = useGateway()
  const [state, setState] = useState<RecordsState>({ status: 'loading' })
  const [phase, setPhase] = useState<DialogueRecords['phase']>('idle')
  const [isDeleteFailed, setDeleteFailed] = useState(false)
  const [isOffered, setOffered] = useState(false)
  // 现在的会话；卸载后为 undefined。查询回来时对不上就丢掉
  const current = useRef<string | undefined>(sessionId)
  /** 现取一次状态；回来时会话已经换了返回 undefined，什么都不改。 */
  const fetchState = async (target: string): Promise<RecordsState | undefined> => {
    const result = await gateway.execute(target, { cmd: 'dialogue-records-state' })
    if (current.current !== target) return undefined
    const next: RecordsState = result.ok && result.dialogueRecords !== undefined ? result.dialogueRecords : { status: 'failed' }
    setState(next)
    return next
  }
  useEffect(() => {
    current.current = sessionId
    setState({ status: 'loading' })
    setPhase('idle')
    setDeleteFailed(false)
    setOffered(false)
    if (sessionId !== undefined) void fetchState(sessionId)
    return () => { current.current = undefined }
  }, [gateway, sessionId])
  useEffect(() => { if (isInUse) setOffered(false) }, [isInUse])

  return {
    sessionId,
    state,
    phase,
    isDeleteFailed,
    isOffered: isOffered && !isInUse && phase === 'idle' && isPresent(state),
    async requestDelete() {
      if (sessionId === undefined || phase !== 'idle') return
      setDeleteFailed(false)
      setPhase('checking')
      const next = await fetchState(sessionId)
      if (next === undefined) return
      if (next.status === 'none') { setOffered(false); setPhase('idle'); return }
      setPhase('confirming')
    },
    cancel() { setPhase('idle') },
    async confirmDelete() {
      if (sessionId === undefined) return
      setPhase('deleting')
      const result = await gateway.execute(sessionId, { cmd: 'delete-dialogue-records' })
      if (current.current !== sessionId) return
      setPhase('idle')
      if (!result.ok) { setDeleteFailed(true); return }
      setOffered(false)
      await fetchState(sessionId)
    },
    offerDelete() {
      if (sessionId === undefined) return
      void fetchState(sessionId).then((next) => { if (next !== undefined) setOffered(isPresent(next)) })
    },
  }
}

/** 「存储」里的对话记录库一项。isInUse 按已保存的配置算，决定没建时和确认删除时的说法。 */
export function DialogueRecordsItem({ records, isInUse, deleteId }: {
  records: DialogueRecords
  isInUse: boolean
  /** 删除按钮的 id：保存行旁的「前往存储」切过来后把焦点放在这里。 */
  deleteId: string
}) {
  const t = useT()
  const { state, phase } = records
  const line = (() => {
    if (records.sessionId === undefined) return { title: t('settings.records.noSession') }
    if (phase === 'deleting') return { title: t('settings.records.deleting'), isBusy: true }
    // 保存后的提示原位替换状态一行（只在库明确还在时）
    if (records.isOffered) return { title: t('settings.records.unused') }
    switch (state.status) {
      case 'loading': return { title: t('settings.records.loading') }
      case 'failed': return { title: t('settings.records.failed'), detail: t('settings.records.failedDetail') }
      case 'none': return { title: t('settings.records.none'), detail: t(isInUse ? 'settings.records.noneInUse' : 'settings.records.noneUnused') }
      case 'building': return {
        title: t(state.sessions === 1 ? 'settings.records.building.one' : 'settings.records.building', { n: formatNumber(state.sessions) }),
        detail: t('settings.records.buildingDetail'),
        isBusy: true,
      }
      case 'rebuilding': return { title: t('settings.records.rebuilding'), detail: t('settings.records.rebuildingDetail'), isBusy: true }
      case 'ready': return { title: t('settings.records.ready') }
    }
  })()
  const canDelete = records.sessionId !== undefined && (phase === 'idle' || phase === 'checking') && state.status !== 'none' && state.status !== 'loading'
  return (
    <SettingsItem label={t('settings.records.label')} hint={t('settings.records.hint')}>
      <div className="pm-store">
        <p className="pm-store-line" role="status">
          {line.isBusy === true ? <span className="pm-store-spinner" aria-hidden="true" /> : null}
          <span className="pm-store-title">{line.title}</span>
          {line.detail !== undefined ? <span className="pm-store-detail">{line.detail}</span> : null}
        </p>
        {canDelete
          ? <Button id={deleteId} size="sm" unavailable={phase === 'checking' ? t('settings.records.loading') : undefined} onClick={() => { void records.requestDelete() }}>{t('settings.records.delete')}</Button>
          : null}
      </div>
      {records.isDeleteFailed ? <p className="pm-input-invalid" role="status">{t('settings.records.deleteFailed')}</p> : null}
      {phase === 'confirming' && records.sessionId !== undefined
        ? (
          <div className="pm-store-confirm" role="group" aria-label={t('settings.records.confirmLabel')}>
            <p>{t(isInUse ? 'settings.records.confirmInUse' : 'settings.records.confirmUnused')}</p>
            <div className="pm-store-confirm-actions">
              <Button variant="ghost" size="sm" onClick={records.cancel}>{t('settings.records.confirmCancel')}</Button>
              <Button variant="danger" size="sm" onClick={() => { void records.confirmDelete() }}>{t('settings.records.confirmDelete')}</Button>
            </div>
          </div>
        )
        : null}
    </SettingsItem>
  )
}

export const dialogueRecordsCss = `
.pm-store { display: flex; align-self: stretch; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 16px; }
.pm-store-line { display: flex; flex: 1 1 240px; flex-wrap: wrap; align-items: center; gap: 2px 8px; min-width: 0; margin: 0; font-size: 13px; line-height: 1.5; color: var(--pm-text); }
.pm-store-title { flex: 1 1 0; min-width: 0; }
.pm-store-detail { flex-basis: 100%; font-size: 12px; color: var(--pm-text-2); }
.pm-store-spinner {
  flex: none; width: 12px; height: 12px; border: 1.5px solid var(--pm-line-card); border-top-color: var(--pm-text-2); border-radius: 50%;
  animation: pm-store-spin 900ms linear infinite;
}
@keyframes pm-store-spin { to { transform: rotate(360deg); } }
.pm-store-confirm { display: flex; align-self: stretch; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 16px; padding: 10px 12px; border-radius: var(--dsw-radius-md, 12px); background: var(--pm-bg-block); }
.pm-store-confirm p { flex: 1 1 240px; margin: 0; font-size: 12px; line-height: 1.5; color: var(--pm-text); }
.pm-store-confirm-actions { display: flex; gap: 8px; margin-left: auto; }
@media (prefers-reduced-motion: reduce) { .pm-store-spinner { animation: none; } }
`
