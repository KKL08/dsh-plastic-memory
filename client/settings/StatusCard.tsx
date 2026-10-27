/**
 * 设置页顶部的状态卡（Health Banner）：一句结论 + 记忆数与上次体检时间 + 「立即体检」「打开记忆页 ›」。
 * 插件页是全局页面，结论按全部层汇总；数据来自视图文件（借一个会话读，没有会话时只写一句提示）。
 * 结论按优先级：体检关闭 → 有密钥 → 有 N 处等你决定 → 还没有记忆 → 还没体检过 → 状态良好。
 * 「打开记忆页 ›」有等你决定的事时去待处理，否则去健康（PRD §4 入口⑤）。
 * 「立即体检」和记忆页页头一样发 `/memory scan`：插件页没有自己的项目，体检当前选中会话所在的项目，没有选中的会话就体检全部层；
 * 按钮下常驻一行 token 消耗说明（体检关闭、没有可用会话时不写）；完成、失败写在再下面一行，与页头共用体检结果行（ScanResult），
 * 链接经导航直达记忆页对应的 tab。
 */
import { isAwaitingDecision, type HealthView, type LibraryView, type PendingView } from '../../src/gui/contract.ts'
import { useGateway, type BorrowedSession, type ViewState } from '../gateway.ts'
import { formatDay, formatNumber, useT, type Translate } from '../i18n.tsx'
import type { MemoryTab, NavTarget } from '../nav.ts'
import { ScanResult, useScanCommand } from '../health/ScanResult.tsx'
import { Button } from '../ui/Button.tsx'
import { HealthBanner } from '../ui/HealthBanner.tsx'
import type { MarkerKind } from '../ui/StatusMarker.tsx'

interface Status { marker?: MarkerKind; conclusion: string; detail?: string }

export function summarize(
  views: { pending: PendingView; health: HealthView; library: LibraryView },
  governanceEnabled: boolean,
  now: number,
  t: Translate,
): Status {
  const count = views.library.layers.reduce((sum, layer) => sum + layer.items.length, 0)
  const scannedAt = views.health.layers.reduce<number | null>(
    (latest, layer) => layer.semanticCachedAt !== null && (latest === null || layer.semanticCachedAt > latest) ? layer.semanticCachedAt : latest, null)
  const countText = t('settings.status.count', { n: formatNumber(count) })
  if (!governanceEnabled) return { conclusion: t('settings.status.disabled'), detail: countText }
  const detail = `${countText} · ${scannedAt === null ? t('settings.status.neverScanned') : t('settings.status.lastScan', { date: formatDay(scannedAt, now, t) })}`
  const items = views.pending.items
  if (items.some(item => item.kind === 'secret')) return { marker: 'secret', conclusion: t('settings.status.secret'), detail }
  // 读不出的文件、建议整理不算「等你决定」（左栏图标也不为它们亮点），在记忆页里处理
  const decisions = items.filter(isAwaitingDecision).length
  if (decisions > 0) return { marker: 'pending', conclusion: t('settings.status.pending', { n: formatNumber(decisions) }), detail }
  if (count === 0) return { conclusion: t('settings.status.empty') }
  if (scannedAt === null) return { conclusion: t('settings.status.unscanned'), detail }
  return { marker: 'ok', conclusion: t('settings.status.ok'), detail }
}

function settled<V>(state: ViewState<V>): V | undefined {
  return state.status === 'ready' ? state.data : undefined
}

/** 有等你决定的事（含密钥；读不出的文件、建议整理不算）时去待处理，否则去健康。还没读到视图时去待处理。 */
export function openTarget(pending: PendingView | undefined): MemoryTab {
  if (pending === undefined) return 'pending'
  return pending.items.some(isAwaitingDecision) ? 'pending' : 'health'
}

function useScan(session: BorrowedSession) {
  const gateway = useGateway()
  const current = gateway.useCurrentWorkspace()
  const workspacePath = current.status === 'ready' ? current.workspacePath : undefined
  const { state, run } = useScanCommand(session)
  // 当前项目还没确认时不发：否则会按全部项目去体检
  return { state, run: () => { if (current.status !== 'loading') run(workspacePath) } }
}

export function StatusCard({ governanceEnabled, onOpen, now = Date.now() }: {
  governanceEnabled: boolean
  /** 经导航 store 直达记忆页的某个 tab（待处理可带要定位的组）。 */
  onOpen: (target: Pick<NavTarget, 'tab' | 'level'>) => void
  now?: number
}) {
  const t = useT()
  const gateway = useGateway()
  const session = gateway.useSession(undefined)
  const pending = settled(gateway.useView(session, 'pending'))
  const health = settled(gateway.useView(session, 'health'))
  const library = settled(gateway.useView(session, 'library'))
  const status: Status = session.kind === 'none'
    ? { conclusion: t('settings.status.noSession') }
    : pending !== undefined && health !== undefined && library !== undefined
      ? summarize({ pending, health, library }, governanceEnabled, now, t)
      : { conclusion: t('settings.status.loading') }
  const scan = useScan(session)
  const isRunning = scan.state.kind === 'running'
  const unavailable = !governanceEnabled ? t('scan.off') : session.kind === 'none' ? t('session.none.hint') : undefined
  return (
    <HealthBanner
      {...(status.marker !== undefined ? { marker: status.marker } : {})}
      conclusion={status.conclusion}
      {...(status.detail !== undefined ? { detail: status.detail } : {})}
      actions={(
        <div className="pm-status-actions">
          <div className="pm-status-buttons">
            <Button disabled={isRunning} unavailable={unavailable} onClick={scan.run}>
              {isRunning ? t('settings.status.scanning') : scan.state.kind === 'failed' ? t('scan.retry') : t('settings.status.scan')}
            </Button>
            <button type="button" className="pm-link" onClick={() => { onOpen({ tab: openTarget(pending) }) }}>{t('settings.status.open')}</button>
          </div>
          {governanceEnabled && session.kind !== 'none' ? <p className="pm-scan-hint">{t('scan.hint')}</p> : null}
          <p className="pm-status-scan" role="status">
            {scan.state.kind === 'done' || scan.state.kind === 'failed' ? <ScanResult state={scan.state} onOpen={onOpen} /> : null}
          </p>
        </div>
      )}
    />
  )
}

export const statusCardCss = `
.pm-status-actions { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; }
.pm-status-buttons { display: flex; align-items: center; gap: 12px; }
.pm-status-scan, .pm-status-actions .pm-scan-hint { margin: 0; max-width: 360px; text-align: right; font-size: 12px; line-height: 1.5; color: var(--pm-text-2); }
.pm-status-scan:empty { display: none; }
.pm-status-scan .pm-scan-note { display: block; }
.pm-status-scan .pm-scan-usage { white-space: nowrap; }
`
