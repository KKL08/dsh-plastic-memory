/**
 * 页头「体检当前项目」：发 `/memory scan`（带页面当前项目），按钮原位变状态——进行中禁用、失败变「再试一次」；
 * 下面一行是结果区：进行中提示可以先做别的，完成、失败写体检结果行（与设置页状态卡共用 ScanResult），链接在页内切 tab。
 * 有待处理时用次按钮，不抢待处理的位置。体检关闭（健康视图 governanceEnabled = false）时按钮不可用，给「去设置里打开 ›」。
 */
import type { ReactNode } from 'react'
import { useGateway, type BorrowedSession } from '../gateway.ts'
import { useT } from '../i18n.tsx'
import { useCanOpen, type NavStore } from '../nav.ts'
import { Button } from '../ui/Button.tsx'
import { ScanResult, useScanCommand } from './ScanResult.tsx'

export function ScanControl({ session, workspacePath, hasPending, nav, leading }: {
  session: Extract<BorrowedSession, { kind: 'ready' }>
  /** 体检哪个项目；缺省体检全部层。 */
  workspacePath: string | undefined
  /** 有待处理时用次按钮。 */
  hasPending: boolean
  nav: NavStore
  /** 同一行排在按钮前面的东西（记忆页页头的「设置」）。 */
  leading?: ReactNode
}) {
  const t = useT()
  const gateway = useGateway()
  const health = gateway.useView(session, 'health')
  const isOff = health.status === 'ready' && !health.data.governanceEnabled
  const { state, run } = useScanCommand(session)

  const canOpenSettings = useCanOpen(nav, 'settings')
  const openSettings = canOpenSettings
    ? <><i className="pm-sep" aria-hidden="true">·</i><button type="button" className="pm-link" onClick={() => { nav.openSettings() }}>{t('scan.openSettings')}</button></>
    : null
  const isRunning = state.kind === 'running'
  let status: ReactNode = null
  if (isOff) {
    status = <>{t('scan.off')}{openSettings}</>
  } else if (state.kind === 'running') {
    status = t('scan.runningHint')
  } else if (state.kind === 'done' || state.kind === 'failed') {
    status = <ScanResult state={state} onOpen={(tab) => { nav.update({ tab, memoryId: undefined }) }} off={openSettings} />
  }

  return (
    <div className="pm-scan">
      <div className="pm-scan-row">
        {leading}
        <Button
          variant={hasPending ? 'secondary' : 'primary'}
          disabled={isRunning}
          unavailable={isOff ? t('scan.off') : undefined}
          onClick={() => { run(workspacePath) }}
        >
          {isRunning ? t('scan.running') : state.kind === 'failed' ? t('scan.retry') : t('scan.button')}
        </Button>
      </div>
      <p className="pm-scan-status" role="status">{status}</p>
    </div>
  )
}
