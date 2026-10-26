/**
 * 健康 tab：按层各一块（看项目时本项目 + 全局，看全局时只有全局），每块三段——体检横幅里是分数与结论、
 * 下一行上次体检时间，横幅下是扣分原因，再下面是不扣分的「其他提醒」（超出上限、很久没确认，没有就不出）。
 * 从没体检过不显示分数（不出现 0 或 100 分），时间行写「内容检查还没做过」。有密钥的层不打分（score 为 null），写原因。
 * 每行行尾「去处理 ›」落到待处理里对应的组：扣分原因的组取视图（issues.level），超限、很久没确认按 PENDING_LEVEL_OF_KIND 取；
 * 这一行的条目此刻不在待处理里时不给链接（体检关闭时的冲突与语义建议、已忽略的超限提醒）。本项目自己没有记忆、只有超限提醒时
 * （视图的 overflowOnlyLayers）照实写 0 条和超限这一行。
 * 体检关闭时整块置灰并给「去设置里打开 ›」，密钥与读不出的文件仍从待处理视图提示（规则检查，不调模型）。
 * 用户忽略的建议不扣分，层下写「已忽略 N 条」，展开逐条列问题类型和记忆名，每条可「取消忽略」。
 * 层块下面两行入口：「待你决定 N 条，其中 M 条超过 7 天 · 去处理 ›」「可提升为全局 N 条 · 去看 ›」，都去待处理 tab。
 */
import { useId, useState, type ReactNode } from 'react'
import { isAwaitingDecision, PENDING_LEVEL_OF_KIND, type GuiLayerRef, type HealthView, type PendingLevel, type PendingView } from '../../src/gui/contract.ts'
import { useGateway, type BorrowedSession, type ViewState } from '../gateway.ts'
import { formatDay, formatNumber, useT, type Translate } from '../i18n.tsx'
import type { LocaleKey } from '../locales.ts'
import { healthZh } from '../locales/health.ts'
import { sameScope, useCanOpen, type NavStore } from '../nav.ts'
import { ActionFeedback, useItemAction } from '../pending/action.tsx'
import { Button } from '../ui/Button.tsx'
import { EmptyState } from '../ui/EmptyState.tsx'
import { HealthBanner } from '../ui/HealthBanner.tsx'

type HealthLayer = HealthView['layers'][number]

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

type OverflowLevel = NonNullable<HealthLayer['overflow']>

/** 健康页的一行：文字 + 它在待处理里所在的组；null = 待处理里此刻没有它，不给「去处理 ›」。 */
interface HealthRow { key: string; text: string; level: PendingLevel | null }

/**
 * 「文字 · 链接」一行，没有去处时只写文字。链接的名字连上这行文字（aria-labelledby 指向文字和链接自己），
 * 同一页好几个「去处理 ›」，读屏时分得清是哪一条。
 */
function LinkRow({ text, link, onClick }: { text: string; link: string; onClick: (() => void) | undefined }) {
  const textId = useId()
  const linkId = useId()
  return (
    <li>
      <span id={textId}>{text}</span>
      {onClick === undefined
        ? null
        : (
          <>
            <i className="pm-sep" aria-hidden="true">·</i>
            <button type="button" id={linkId} className="pm-link" aria-labelledby={`${textId} ${linkId}`} onClick={onClick}>{link}</button>
          </>
        )}
    </li>
  )
}

/** 一段：分区标签 + 行；empty 给出时没有行也画（写这句），否则整段不出。 */
function RowSection({ title, rows, empty, onHandle }: { title: string; rows: readonly HealthRow[]; empty?: string; onHandle: (level: PendingLevel) => void }) {
  const t = useT()
  if (rows.length === 0 && empty === undefined) return null
  return (
    <div className="pm-health-issues">
      <h3 className="pm-health-issues-title">{title}</h3>
      {rows.length === 0
        ? <p className="pm-health-none">{empty}</p>
        : (
          <ul>
            {rows.map(({ key, text, level }) => (
              <LinkRow key={key} text={text} link={t('health.entry.pendingLink')} onClick={level === null ? undefined : () => { onHandle(level) }} />
            ))}
          </ul>
        )}
    </div>
  )
}

/** 不扣分的提醒：超出上限（已忽略的照列、不给去处，待处理里已没有它）、很久没确认（待处理里是建议整理项）。 */
function noticeRows(overflow: OverflowLevel | null, staleCount: number, t: Translate): HealthRow[] {
  const rows: HealthRow[] = []
  if (overflow !== null) {
    const text = overflow.mode === 'relax' ? t('health.overflow.relax', { percent: overflow.tier * 25 }) : t('health.overflow.strict')
    rows.push({ key: 'overflow', text, level: overflow.isDismissed ? null : PENDING_LEVEL_OF_KIND['overflow'] })
  }
  if (staleCount > 0) rows.push({ key: 'stale', text: t('health.stale', { n: formatNumber(staleCount) }), level: PENDING_LEVEL_OF_KIND['advice'] })
  return rows
}

type IgnoredItem = HealthLayer['ignored'][number]

/** 已忽略的一条：问题类型 · 记忆名，「取消忽略」发 unignore-advice；成功后视图重写，这一条随之消失。 */
function IgnoredRow({ item, session }: { item: IgnoredItem; session: BorrowedSession }) {
  const t = useT()
  const action = useItemAction(session, () => {})
  return (
    <li>
      <span><Dotted parts={[issueLabel(item.type, t), ...item.memories.map(m => m.name)]} /></span>
      <Button
        variant="ghost"
        unavailable={action.unavailable}
        onClick={() => { action.run({ cmd: 'unignore-advice', type: item.type, memoryIds: item.memories.map(m => m.id) }) }}
      >
        {t('health.ignored.unignore')}
      </Button>
      <ActionFeedback action={action} />
    </li>
  )
}

/** 「已忽略 N 条」：默认收起，点开列出每一条。没有忽略的层不出。 */
function Ignored({ items, session }: { items: readonly IgnoredItem[]; session: BorrowedSession }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const listId = useId()
  if (items.length === 0) return null
  const label = t('health.ignored.toggle', { n: formatNumber(items.length) })
  return (
    <div className="pm-health-ignored">
      <button type="button" className="pm-link" aria-expanded={open} aria-controls={listId} onClick={() => { setOpen(!open) }}>{label}</button>
      {open
        ? <ul id={listId} aria-label={label}>{items.map(item => <IgnoredRow key={`${item.type}:${item.memories.map(m => m.id).join(',')}`} item={item} session={session} />)}</ul>
        : null}
    </div>
  )
}

function LayerHealth({ layer, data, overflowOnly, now, session, onHandle }: {
  layer: GuiLayerRef
  data: HealthLayer | undefined
  /** 这一层不在体检清单里（自己没有记忆）、只有超限提醒时的档位。 */
  overflowOnly: OverflowLevel | undefined
  now: number
  session: BorrowedSession
  onHandle: (level: PendingLevel) => void
}) {
  const t = useT()
  const name = layerName(layer, t)
  if (data === undefined) {
    // 没有记忆可打分：照实写 0 条和超限这一行，不写分数与体检时间
    return (
      <section className="pm-health-layer" aria-label={name}>
        {overflowOnly === undefined
          ? <HealthBanner conclusion={t('health.noMemories')} />
          : (
            <>
              <HealthBanner conclusion={<Dotted parts={[name, t('health.count', { n: formatNumber(0) })]} />} />
              <RowSection title={t('health.notices')} rows={noticeRows(overflowOnly, 0, t)} onHandle={onHandle} />
            </>
          )}
      </section>
    )
  }
  // 从没体检过不显示分数：只有规则检查的分数会让人误以为体检过了
  const scorePart = data.score === null
    ? t('health.secretGate')
    : data.semanticCachedAt === null
      ? t('health.unscored')
      : <Dotted parts={[t('health.score', { score: formatNumber(data.score) }), t(`health.tier.${data.tier}`)]} />
  return (
    <section className="pm-health-layer" aria-label={name}>
      <HealthBanner
        marker={data.gate.secret ? 'secret' : data.tier === 'green' && data.semanticCachedAt !== null ? 'ok' : undefined}
        conclusion={<Dotted parts={[name, t('health.count', { n: formatNumber(data.totalMemories) }), scorePart]} />}
        detail={data.semanticCachedAt === null ? t('health.neverScanned') : t('health.lastScan', { date: formatDay(data.semanticCachedAt, now, t) })}
      />
      <RowSection
        title={t('health.issues')}
        rows={data.issues.map(i => ({ key: i.type, text: t('health.issueCount', { label: issueLabel(i.type, t), n: formatNumber(i.count) }), level: i.level }))}
        empty={t('health.noIssues')}
        onHandle={onHandle}
      />
      <RowSection title={t('health.notices')} rows={noticeRows(data.overflow, data.staleCount, t)} onHandle={onHandle} />
      <Ignored items={data.ignored} session={session} />
    </section>
  )
}

/** 体检关闭时仍要提示的硬问题：密钥、读不出的文件（只看页面上列出的层）。 */
function HardAlerts({ pending, layers }: { pending: ViewState<PendingView>; layers: readonly GuiLayerRef[] }) {
  const t = useT()
  if (pending.status !== 'ready') return null
  const inShown = (ref: GuiLayerRef) => layers.some(l => sameScope(l, ref))
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

/** 去待处理的两行入口。读不出的文件、建议整理不算「待你决定」（与左栏圆点、状态卡同一口径）；条数为 0 的行不出。 */
function PendingEntries({ pending, nav, now }: { pending: ViewState<PendingView>; nav: NavStore; now: number }) {
  const t = useT()
  if (pending.status !== 'ready') return null
  const decisions = pending.data.items.filter(isAwaitingDecision)
  const old = decisions.filter(item => 'firstSeenAt' in item && now - item.firstSeenAt > WAITING_LONG_MS).length
  const promotable = decisions.filter(item => item.kind === 'promote-candidate').length
  if (decisions.length === 0) return null
  const go = () => { nav.update({ tab: 'pending', memoryId: undefined }) }
  const n = formatNumber(decisions.length)
  return (
    <ul className="pm-health-entries">
      <LinkRow text={old > 0 ? t('health.entry.pendingOld', { n, old: formatNumber(old) }) : t('health.entry.pending', { n })} link={t('health.entry.pendingLink')} onClick={go} />
      {promotable > 0 ? <LinkRow text={t('health.entry.promote', { n: formatNumber(promotable) })} link={t('health.entry.promoteLink')} onClick={go} /> : null}
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
  const rows = layers.map(layer => ({ layer, data: health.data.layers.find(l => sameScope(l.layer, layer)) }))
  const overflowOnly = (layer: GuiLayerRef) => health.data.overflowOnlyLayers?.find(l => sameScope(l.layer, layer))?.overflow
  const toGroup = (level: PendingLevel) => { nav.update({ tab: 'pending', memoryId: undefined, level }) }
  const body = rows.map(({ layer, data }) => (
    <LayerHealth
      key={layer.kind === 'global' ? 'global' : layer.workspacePath}
      layer={layer} data={data} overflowOnly={overflowOnly(layer)} now={now} session={session} onHandle={toGroup}
    />
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
.pm-health-ignored { padding: 0 16px; font-size: 13px; line-height: 1.55; }
.pm-health-ignored ul { margin: 4px 0 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 4px; }
.pm-health-ignored li { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 4px 8px; color: var(--pm-text-2); }
/* 取消失败的原话（待处理的样式表只在待处理 tab 注入，这里自带一份） */
.pm-health-ignored .pm-pending-error { flex-basis: 100%; margin: 0; font-size: 12px; color: var(--pm-text); }
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
