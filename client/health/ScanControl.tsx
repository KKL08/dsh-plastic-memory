/**
 * 页头「体检当前项目」：发 `/memory scan`（带页面当前项目），按钮原位变状态——进行中禁用、失败变「再试一次」；
 * 下面一行是结果区：进行中提示可以先做别的，失败写原话并提示在对话里让 agent 体检，成功时列出体检的说明（如基线检查被跳过）。
 * 有待处理时用次按钮，不抢待处理的位置。体检关闭（健康视图 governanceEnabled = false）时按钮不可用，给「去设置里打开 ›」。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { MemoryCommandResult } from '../../src/gui/contract.ts'
import { useGateway, type BorrowedSession } from '../gateway.ts'
import { useT } from '../i18n.tsx'
import type { NavStore } from '../nav.ts'
import { Button } from '../ui/Button.tsx'

type ScanNote = NonNullable<Extract<MemoryCommandResult, { ok: true }>['notes']>[number]
type ScanFailure = Extract<MemoryCommandResult, { ok: false }>

type ScanState =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'done'; notes: readonly ScanNote[] }
  | { kind: 'failed'; code: ScanFailure['code']; detail: string | undefined }

export function ScanControl({ session, workspacePath, hasPending, nav }: {
  session: Extract<BorrowedSession, { kind: 'ready' }>
  /** 体检哪个项目；缺省体检全部层。 */
  workspacePath: string | undefined
  /** 有待处理时用次按钮。 */
  hasPending: boolean
  nav: NavStore
}) {
  const t = useT()
  const gateway = useGateway()
  const health = gateway.useView(session, 'health')
  const isOff = health.status === 'ready' && !health.data.governanceEnabled
  const [state, setState] = useState<ScanState>({ kind: 'idle' })
  const live = useRef(true)
  useEffect(() => () => { live.current = false }, [])

  const run = () => {
    setState({ kind: 'running' })
    void gateway.execute(session.sessionId, { cmd: 'scan', ...(workspacePath !== undefined ? { workspacePath } : {}) }).then((result) => {
      if (!live.current) return
      setState(result.ok ? { kind: 'done', notes: result.notes ?? [] } : { kind: 'failed', code: result.code, detail: result.detail })
    })
  }

  const openSettings = <button type="button" className="pm-link" onClick={() => { nav.openSettings() }}>{t('scan.openSettings')}</button>
  const isRunning = state.kind === 'running'
  let status: ReactNode = null
  if (isOff || (state.kind === 'failed' && state.code === 'governance-disabled')) {
    status = <>{t('scan.off')}<i className="pm-sep" aria-hidden="true">·</i>{openSettings}</>
  } else if (state.kind === 'running') {
    status = t('scan.runningHint')
  } else if (state.kind === 'failed') {
    const reason = state.code === 'llm-unavailable' ? t('scan.llmUnavailable') : t('scan.failed', { detail: state.detail ?? state.code })
    status = <>{reason} {t('scan.askAgent')}</>
  } else if (state.kind === 'done') {
    status = (
      <>
        {t('scan.done')}
        {state.notes.includes('semantic-failed') ? <span className="pm-scan-note">{t('scan.note.semanticFailed')}</span> : null}
        {state.notes.includes('baseline-session-scoped') ? <span className="pm-scan-note">{t('scan.note.baselineSessionScoped')}</span> : null}
      </>
    )
  }

  return (
    <div className="pm-scan">
      <Button
        variant={hasPending ? 'secondary' : 'primary'}
        disabled={isRunning}
        unavailable={isOff ? t('scan.off') : undefined}
        onClick={run}
      >
        {isRunning ? t('scan.running') : state.kind === 'failed' ? t('scan.retry') : t('scan.button')}
      </Button>
      <p className="pm-scan-status" role="status">{status}</p>
    </div>
  )
}
