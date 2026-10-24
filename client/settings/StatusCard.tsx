/**
 * 设置页顶部的状态卡（Health Banner）：一句结论 + 记忆数与上次体检时间 + 「打开记忆页 ›」。
 * 插件页是全局页面，结论按全部层汇总；数据来自视图文件（借一个会话读，没有会话时只写一句提示）。
 * 结论按优先级：体检关闭 → 有密钥 → 有 N 处等你决定 → 还没有记忆 → 还没体检过 → 状态良好。
 */
import type { HealthView, LibraryView, PendingView } from '../../src/gui/contract.ts'
import { useGateway, type ViewState } from '../gateway.ts'
import { formatDay, formatNumber, useT, type Translate } from '../i18n.tsx'
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
  // 读不出的文件不算「等你决定」（左栏图标也不为它亮点），在记忆页里处理
  const decisions = items.filter(item => item.kind !== 'unreadable-file').length
  if (decisions > 0) return { marker: 'pending', conclusion: t('settings.status.pending', { n: formatNumber(decisions) }), detail }
  if (count === 0) return { conclusion: t('settings.status.empty') }
  if (scannedAt === null) return { conclusion: t('settings.status.unscanned'), detail }
  return { marker: 'ok', conclusion: t('settings.status.ok'), detail }
}

function settled<V>(state: ViewState<V>): V | undefined {
  return state.status === 'ready' ? state.data : undefined
}

export function StatusCard({ governanceEnabled, onOpen, now = Date.now() }: {
  governanceEnabled: boolean
  onOpen: () => void
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
  return (
    <HealthBanner
      {...(status.marker !== undefined ? { marker: status.marker } : {})}
      conclusion={status.conclusion}
      {...(status.detail !== undefined ? { detail: status.detail } : {})}
      actions={<button type="button" className="pm-link" onClick={onOpen}>{t('settings.status.open')}</button>}
    />
  )
}
