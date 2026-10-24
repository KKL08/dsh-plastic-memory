/**
 * 健康 tab：按层各一块（看项目时本项目 + 全局，看全局时只有全局），每块三段——体检横幅里是分数与结论、
 * 下一行上次体检时间，横幅下是问题列表。从没体检过不显示分数（不出现 0 或 100 分），时间行写「内容检查还没做过」。
 * 有密钥的层不打分（score 为 null），写原因；超出上限列为问题、不扣分。
 * 体检关闭时整块置灰并给「去设置里打开 ›」，密钥与读不出的文件仍从待处理视图提示（规则检查，不调模型）。
 * 层块下面两行入口：「待你决定 N 条，其中 M 条超过 7 天 · 去处理 ›」「可提升为全局 N 条 · 去看 ›」，都去待处理 tab。
 */
import type { ReactNode } from 'react'
import type { GuiLayerRef, HealthView, PendingView } from '../../src/gui/contract.ts'
import { useGateway, type BorrowedSession, type ViewState } from '../gateway.ts'
import { formatDay, formatNumber, useT, type Translate } from '../i18n.tsx'
import type { LocaleKey } from '../locales.ts'
import { healthZh } from '../locales/health.ts'
import { useCanOpen, type NavStore } from '../nav.ts'
import { EmptyState } from '../ui/EmptyState.tsx'
import { HealthBanner } from '../ui/HealthBanner.tsx'

type HealthLayer = HealthView['layers'][number]

function sameLayer(a: GuiLayerRef, b: GuiLayerRef): boolean {
  return a.kind === b.kind && (a.kind === 'global' || (b.kind === 'workspace' && a.workspacePath === b.workspacePath))
}

function layerName(layer: GuiLayerRef, t: Translate): string {
  return t(layer.kind === 'global' ? 'health.layer.global' : 'health.layer.workspace')
}

/** 问题类型来自视图（governance FINDING_TYPES）；不认识的类型原样显示。 */
function issueLabel(type: string, t: Translate): string {
  const key = `health.issue.${type}`
  return key in healthZh ? t(key as LocaleKey) : type
}

function Dotted({ parts }: { parts: readonly ReactNode[] }) {
  return <>{parts.map((part, i) => <span key={i}>{i > 0 ? <i className="pm-sep" aria-hidden="true">·</i> : null}{part}</span>)}</>
}

function LayerHealth({ layer, data, now }: { layer: GuiLayerRef; data: HealthLayer | undefined; now: number }) {
  const t = useT()
  const name = layerName(layer, t)
  if (data === undefined) {
    return <section className="pm-health-layer" aria-label={name}><HealthBanner conclusion={t('health.noMemories')} /></section>
  }
  // 从没体检过不显示分数：只有规则检查的分数会让人误以为体检过了
  const scorePart = data.score === null
    ? t('health.secretGate')
    : data.semanticCachedAt === null
      ? t('health.unscored')
      : <Dotted parts={[t('health.score', { score: formatNumber(data.score) }), t(`health.tier.${data.tier}`)]} />
  const issues: string[] = data.issues.map(i => t('health.issueCount', { label: issueLabel(i.type, t), n: formatNumber(i.count) }))
  if (data.overflow !== null) {
    issues.push(data.overflow.mode === 'relax'
      ? t('health.overflow.relax', { percent: data.overflow.tier * 25 })
      : t('health.overflow.strict'))
  }
  if (data.staleCount > 0) issues.push(t('health.stale', { n: formatNumber(data.staleCount) }))
  return (
    <section className="pm-health-layer" aria-label={name}>
      <HealthBanner
        marker={data.gate.secret ? 'secret' : data.tier === 'green' && data.semanticCachedAt !== null ? 'ok' : undefined}
        conclusion={<Dotted parts={[name, t('health.count', { n: formatNumber(data.totalMemories) }), scorePart]} />}
        detail={data.semanticCachedAt === null ? t('health.neverScanned') : t('health.lastScan', { date: formatDay(data.semanticCachedAt, now, t) })}
      />
      <div className="pm-health-issues">
        <h3 className="pm-health-issues-title">{t('health.issues')}</h3>
        {issues.length === 0
          ? <p className="pm-health-none">{t('health.noIssues')}</p>
          : <ul>{issues.map(text => <li key={text}>{text}</li>)}</ul>}
      </div>
    </section>
  )
}

/** 体检关闭时仍要提示的硬问题：密钥、读不出的文件（只看页面上列出的层）。 */
function HardAlerts({ pending, layers }: { pending: ViewState<PendingView>; layers: readonly GuiLayerRef[] }) {
  const t = useT()
  if (pending.status !== 'ready') return null
  const inShown = (ref: GuiLayerRef) => layers.some(l => sameLayer(l, ref))
  const lines: Array<{ key: string; text: string }> = []
  for (const item of pending.data.items) {
    if (item.kind === 'secret') {
      const ref: GuiLayerRef = item.memory.scope === 'global' ? { kind: 'global' } : { kind: 'workspace', workspacePath: item.memory.workspacePath ?? '' }
      if (inShown(ref)) lines.push({ key: `s:${item.memory.id}`, text: t('health.off.secret', { name: item.memory.name }) })
    } else if (item.kind === 'unreadable-file' && inShown(item.layer)) {
      lines.push({ key: `u:${item.filePath}`, text: t('health.off.unreadable', { path: item.relativePath }) })
    }
  }
  if (lines.length === 0) return null
  return <ul className="pm-health-alerts">{lines.map(l => <li key={l.key}>{l.text}</li>)}</ul>
}

const WAITING_LONG_MS = 7 * 24 * 60 * 60 * 1000

/** 去待处理的两行入口。读不出的文件不算「待你决定」（与左栏圆点、状态卡同一口径）；条数为 0 的行不出。 */
function PendingEntries({ pending, nav, now }: { pending: ViewState<PendingView>; nav: NavStore; now: number }) {
  const t = useT()
  if (pending.status !== 'ready') return null
  const decisions = pending.data.items.filter(item => item.kind !== 'unreadable-file')
  const old = decisions.filter(item => 'firstSeenAt' in item && now - item.firstSeenAt > WAITING_LONG_MS).length
  const promotable = decisions.filter(item => item.kind === 'promote-candidate').length
  if (decisions.length === 0) return null
  const go = () => { nav.update({ tab: 'pending', memoryId: undefined }) }
  const n = formatNumber(decisions.length)
  return (
    <ul className="pm-health-entries">
      <li>
        <span>{old > 0 ? t('health.entry.pendingOld', { n, old: formatNumber(old) }) : t('health.entry.pending', { n })}</span>
        <i className="pm-sep" aria-hidden="true">·</i>
        <button type="button" className="pm-link" onClick={go}>{t('health.entry.pendingLink')}</button>
      </li>
      {promotable > 0
        ? (
          <li>
            <span>{t('health.entry.promote', { n: formatNumber(promotable) })}</span>
            <i className="pm-sep" aria-hidden="true">·</i>
            <button type="button" className="pm-link" onClick={go}>{t('health.entry.promoteLink')}</button>
          </li>
        )
        : null}
    </ul>
  )
}

export function HealthTab({ session, scope, nav }: { session: BorrowedSession; scope: GuiLayerRef; nav: NavStore }) {
  const t = useT()
  const gateway = useGateway()
  const health = gateway.useView(session, 'health')
  const pending = gateway.useView(session, 'pending')
  const canOpenSettings = useCanOpen(nav, 'settings')
  if (health.status !== 'ready') return <ViewStatus state={health} />

  const now = Date.now()
  const layers: GuiLayerRef[] = scope.kind === 'workspace' ? [scope, { kind: 'global' }] : [{ kind: 'global' }]
  const rows = layers.map(layer => ({ layer, data: health.data.layers.find(l => sameLayer(l.layer, layer)) }))
  const body = rows.map(({ layer, data }) => (
    <LayerHealth key={layer.kind === 'global' ? 'global' : layer.workspacePath} layer={layer} data={data} now={now} />
  ))

  if (!health.data.governanceEnabled) {
    return (
      <div className="pm-health">
        <EmptyState
          variant="daily"
          title={t('health.off.title')}
          action={canOpenSettings ? <button type="button" className="pm-link" onClick={() => { nav.openSettings() }}>{t('scan.openSettings')}</button> : undefined}
        >
          {t('health.off.body')}
        </EmptyState>
        <HardAlerts pending={pending} layers={layers} />
        <div className="pm-health-off" aria-disabled="true">{body}</div>
      </div>
    )
  }

  const neverScanned = rows.every(r => r.data === undefined || r.data.semanticCachedAt === null)
  return (
    <div className="pm-health">
      {body}
      <PendingEntries pending={pending} nav={nav} now={now} />
      {neverScanned
        ? <EmptyState variant="daily" title={t('health.semanticEmpty.title')}>{t('health.semanticEmpty.body')}</EmptyState>
        : null}
    </div>
  )
}

function ViewStatus({ state }: { state: ViewState<unknown> }) {
  const t = useT()
  if (state.status === 'idle' || state.status === 'ready') return null
  const text = state.status === 'error' ? t('view.error', { message: state.message }) : t(`view.${state.status}`)
  return <p className="pm-health-status">{text}</p>
}

export const healthCss = `
.pm-health { display: flex; flex-direction: column; gap: 20px; padding-top: 4px; }
.pm-health-layer { display: flex; flex-direction: column; gap: 8px; }
.pm-health-issues { padding: 0 16px; }
.pm-health-issues-title { margin: 0 0 4px; font-size: 12px; font-weight: 600; line-height: 1.5; color: var(--pm-text-2); }
.pm-health-issues ul, .pm-health-alerts { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 2px; font-size: 13px; line-height: 1.55; }
.pm-health-none { margin: 0; font-size: 13px; color: var(--pm-text-2); }
.pm-health-alerts { padding: 0 16px; }
.pm-health-entries { margin: 0; padding: 0 16px; list-style: none; display: flex; flex-direction: column; gap: 4px; font-size: 13px; line-height: 1.55; color: var(--pm-text); }
.pm-health-off { opacity: .5; }
.pm-health-status { margin: 24px 0; text-align: center; font-size: 12px; color: var(--pm-text-2); }
.pm-scan { margin-left: auto; display: flex; flex-direction: column; align-items: flex-end; gap: 4px; }
.pm-scan-row { display: flex; align-items: center; gap: 8px; }
.pm-scan-status { margin: 0; max-width: 420px; text-align: right; font-size: 12px; line-height: 1.5; color: var(--pm-text-2); }
.pm-scan-status:empty { display: none; }
.pm-scan-note { display: block; }
`
