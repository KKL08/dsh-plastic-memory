/**
 * 记忆页状态条（DESIGN.md Scope Status Bar）：只放信息、不放按钮。
 * - 项目 / 全局：首行分数和分档（有密钥不打分）；第二行条数 · 上次体检 · 下次自动体检 · 分数怎么来的 ⌄，
 *   展开列出规则检查、内容检查、新鲜度各扣几分、包括哪些问题（扣 0 分的不列，都是 0 写「没有扣分」）。
 * - 「全部」：不打总分，首行写哪些范围要处理；第二行写范围数、总条数、最近一次体检和自动体检概况。
 * - 体检在配置文件里关闭：只写条数。
 * - 结果行（aria-live）：体检进行中写正在体检谁；完成后写新增几条（链接跳到第一条带「新」的条目）、用量和说明，
 *   看过这个范围的处理视图后离开再回来就收起（记录见 seen.ts）；自动体检没做完、默认模型用不了时写原因和什么时候再试；
 *   本窗口的手动体检没做成写原因。「全部」写「全部」手动体检的结果，另把没看过的自动体检结果按范围合计成一行。
 * 进行中和手动体检没做成读标题行同一份 useCheckupRuns。
 */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import {
  sameLayer, scopeKey, SCOPE_KEYS,
  type CheckupCause, type CheckupResult, type CheckupView, type GuiLayerRef, type HealthView,
} from '../../src/gui/contract.ts'
import { baseName, formatDay, formatDayTime, formatNumber, useT, type Translate } from '../i18n.tsx'
import type { LocaleKey } from '../locales.ts'
import { allScopesSub, scopeName, type MemoryView, type NavStore, type NewItemJump, type PageScope } from '../nav.ts'
import { StatusMarker, type MarkerKind } from '../ui/StatusMarker.tsx'
import type { CheckupRuns, RunFailure } from './runs.ts'
import { checkupResults, isResultSeen, markSeen, type Seen, type SeenMark } from './seen.ts'
import { frequencyText } from './TitleControls.tsx'

type HealthLayer = HealthView['layers'][number]
type ScopeEntry = CheckupView['scopes'][number]

/** 分数能不能写：有密钥不打分；从没体检过也不写，只有规则检查的分数会让人误以为体检过了。 */
export function scoreOf(layer: HealthLayer | undefined): number | 'secret' | undefined {
  if (layer === undefined) return undefined
  if (layer.gate.secret || layer.score === null) return 'secret'
  return layer.lastCheckupAt === null ? undefined : layer.score
}

const TIER_MARKER = { green: 'ok', amber: 'pending', red: 'error' } as const satisfies Record<HealthLayer['tier'], MarkerKind>

const DEDUCTIONS = ['rule', 'content', 'freshness'] as const
const DEDUCTION_LABEL = {
  rule: 'checkup.status.deduction.rule',
  content: 'checkup.status.deduction.content',
  freshness: 'checkup.status.deduction.freshness',
} as const satisfies Record<(typeof DEDUCTIONS)[number], LocaleKey>
/** 扣分里的问题类型（governance/schema.ts FINDING_TYPES 里扣分的几类，加新鲜度的 stale）；认不出的照原样写。 */
const ISSUE_LABEL: Readonly<Record<string, LocaleKey>> = {
  expired: 'checkup.status.issue.expired',
  bloat: 'checkup.status.issue.bloat',
  orphan: 'checkup.status.issue.orphan',
  malformed: 'checkup.status.issue.malformed',
  conflict: 'checkup.status.issue.conflict',
  redundancy: 'checkup.status.issue.redundancy',
  misplaced: 'checkup.status.issue.misplaced',
  unclear: 'checkup.status.issue.unclear',
  stale: 'checkup.status.issue.stale',
}

/** 宿主错误码 → 原因（模型用不了的五个码见 governance/host-llm.ts，其余是宿主模型调用的稳定错误码）。 */
const HOST_CODE_CAUSE: Readonly<Record<string, LocaleKey>> = {
  ACCOUNT_SIGN_IN_REQUIRED: 'checkup.cause.signIn',
  ACCOUNT_TOKEN_INVALID: 'checkup.cause.tokenInvalid',
  MISSING_CREDENTIAL: 'checkup.cause.missingCredential',
  INVALID_CREDENTIAL: 'checkup.cause.invalidCredential',
  AUTH: 'checkup.cause.auth',
  QUOTA: 'checkup.cause.quota',
  RATE_LIMIT: 'checkup.cause.rateLimit',
  TIMEOUT: 'checkup.cause.timeout',
  TRANSPORT: 'checkup.cause.transport',
  SERVER: 'checkup.cause.server',
  CONTEXT_WINDOW_EXCEEDED: 'checkup.cause.contextWindow',
}
const CAUSE_KIND = {
  'no-default-model': 'checkup.cause.noDefaultModel',
  'model-error': 'checkup.cause.modelError',
  'unparseable': 'checkup.cause.unparseable',
  'error': 'checkup.cause.error',
} as const satisfies Record<CheckupCause['kind'], LocaleKey>

/** 原因按宿主错误码、再按 kind 写成界面文案；宿主原话（message）不进正文，由调用方放进悬停提示。 */
export function causeText(cause: CheckupCause, t: Translate): string {
  const byCode = cause.hostCode === undefined ? undefined : HOST_CODE_CAUSE[cause.hostCode]
  return t(byCode ?? CAUSE_KIND[cause.kind])
}


/** 扣分保留一位小数（不足 0.1 的写 0.1，免得列出来却写 0）。 */
function formatPoints(points: number): string {
  return String(Math.max(0.1, Math.round(points * 10) / 10))
}

const Sep = () => <i className="pm-sep" aria-hidden="true">·</i>

/** 用 · 连起来的几段。 */
function joined(parts: readonly ReactNode[]): ReactNode {
  return parts.map((part, i) => <span key={i}>{i > 0 ? <Sep /> : null}{part}</span>)
}

export function StatusBar({ scope, view, nav, runs, seen, health, checkups, isGovernanceEnabled, memoryCount, projectCount, needs }: {
  scope: PageScope
  view: MemoryView
  nav: NavStore
  runs: CheckupRuns
  /** 进入这个范围时读的「看过」记录（记忆页给出）。 */
  seen: Seen
  /** 健康视图；项目和全局的分数、扣分取它。 */
  health: HealthView
  checkups: CheckupView | undefined
  isGovernanceEnabled: boolean
  /** 这个范围的记忆条数（「全部」是总数）。 */
  memoryCount: number
  /** 「全部」第二行的「N 个项目和全局」。 */
  projectCount: number
  /** 「全部」首行：各范围（左栏的顺序）要处理的件数和有没有密钥。 */
  needs: ReadonlyArray<{ scope: GuiLayerRef; todo: number; hasSecret: boolean }>
}) {
  const t = useT()
  const now = Date.now()
  const count = t(memoryCount === 1 ? 'checkup.status.count.one' : 'checkup.status.count', { n: formatNumber(memoryCount) })
  const allCount = () => t(memoryCount === 1 ? 'checkup.status.all.count.one' : 'checkup.status.all.count', {
    scopes: allScopesSub(projectCount, t),
    n: formatNumber(memoryCount),
  })

  if (!isGovernanceEnabled) {
    return (
      <section className="pm-status" aria-label={t('status.label')}>
        <p className="pm-status-line"><span className="pm-status-soft">{scope.kind === 'all' ? allCount() : count}</span></p>
      </section>
    )
  }
  const result = <ResultRow scope={scope} isTodoView={view === 'todo'} nav={nav} runs={runs} seen={seen} checkups={checkups} now={now} />
  if (scope.kind === 'all') {
    const lastAt = Math.max(...(checkups?.scopes ?? health.layers).map(s => s.lastCheckupAt ?? -Infinity))
    const meta = [allCount()]
    if (Number.isFinite(lastAt)) meta.push(t('checkup.status.last', { date: formatDay(lastAt, now, t) }))
    const auto = checkups === undefined ? undefined : autoSummary(checkups, t)
    if (auto !== undefined) meta.push(auto)
    return (
      <section className="pm-status" aria-label={t('status.label')}>
        <AllHeadline needs={needs} />
        <p className="pm-status-meta">{joined(meta)}</p>
        {result}
      </section>
    )
  }
  const layer = health.layers.find(l => sameLayer(l.layer, scope))
  const entry = checkups?.scopes.find(s => sameLayer(s.scope, scope))
  return <ScopeStatus layer={layer} entry={entry} count={count} now={now} result={result} />
}

/** 项目 / 全局：首行分数、第二行、分数怎么来的，最后是结果行。 */
function ScopeStatus({ layer, entry, count, now, result }: {
  layer: HealthLayer | undefined
  entry: ScopeEntry | undefined
  count: string
  now: number
  result: ReactNode
}) {
  const t = useT()
  const whyId = useId()
  const [isWhyOpen, setWhyOpen] = useState(false)
  const score = scoreOf(layer)
  const lastAt = entry?.lastCheckupAt ?? layer?.lastCheckupAt ?? null
  const meta: ReactNode[] = [count]
  if (lastAt !== null) meta.push(t('checkup.status.last', { date: formatDay(lastAt, now, t) }))
  // 没做完、模型用不了时由结果行说什么时候再试，这里不再说「马上在后台查」
  if (entry !== undefined && entry.frequency !== 'manual' && entry.failure === null && entry.modelUnavailable === null) {
    if (entry.isDue) meta.push(t('checkup.status.due'))
    else if (entry.nextCheckupAt !== null) meta.push(t('checkup.status.next', { time: formatDayTime(entry.nextCheckupAt, now, t) }))
  }
  if (typeof score === 'number') {
    meta.push(
      <button type="button" className="pm-status-why" aria-expanded={isWhyOpen} aria-controls={isWhyOpen ? whyId : undefined} onClick={() => { setWhyOpen(!isWhyOpen) }}>
        {t('checkup.status.why')}
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M7 10l5 5 5-5" />
        </svg>
      </button>,
    )
  }
  const deductions = layer === undefined ? [] : DEDUCTIONS.filter(d => layer.deductions[d].points > 0)
  // 首行没有标记（还没打分）时，下面几行不缩进去对一个不存在的标记
  const isPlain = score !== 'secret' && (score === undefined || layer === undefined)
  return (
    <section className={isPlain ? 'pm-status pm-status--plain' : 'pm-status'} aria-label={t('status.label')}>
      <p className="pm-status-line">
        {score === 'secret'
          ? (
            <>
              <span className="pm-status-mark"><StatusMarker kind="secret" /></span>
              {t('status.unscored')}<Sep /><span className="pm-status-soft">{t('status.secretFirst')}</span>
            </>
          )
          : score === undefined || layer === undefined
            ? <span className="pm-status-soft">{t('health.unscored')}</span>
            : (
              <>
                <span className="pm-status-mark"><StatusMarker kind={TIER_MARKER[layer.tier]} /></span>
                {t('health.score', { score: formatNumber(score) })}<Sep /><span className="pm-status-soft">{t(`health.tier.${layer.tier}`)}</span>
              </>
            )}
      </p>
      <p className="pm-status-meta">{joined(meta)}</p>
      {isWhyOpen && layer !== undefined
        ? (
          <ul id={whyId} className="pm-status-deductions" aria-label={t('checkup.status.why')}>
            {deductions.length === 0
              ? <li>{t('checkup.status.noDeduction')}</li>
              : deductions.map((d) => {
                const { points, types } = layer.deductions[d]
                const label = t(DEDUCTION_LABEL[d])
                const typeText = types.map(type => (ISSUE_LABEL[type] === undefined ? type : t(ISSUE_LABEL[type]))).join(t('checkup.status.listSep'))
                return (
                  <li key={d}>
                    {types.length === 0
                      ? t('checkup.status.deduction.bare', { label, points: formatPoints(points) })
                      : t('checkup.status.deduction', { label, points: formatPoints(points), types: typeText })}
                  </li>
                )
              })}
          </ul>
        )
        : null}
      {result}
    </section>
  )
}

/** 「全部」首行：哪些范围要处理（有密钥的写「有密钥要先处理」），标记取最急的；都没有时绿圆点「没有要你决定的事」。 */
function AllHeadline({ needs }: { needs: ReadonlyArray<{ scope: GuiLayerRef; todo: number; hasSecret: boolean }> }) {
  const t = useT()
  const busy = needs.filter(n => n.todo > 0)
  if (busy.length === 0) {
    return (
      <p className="pm-status-line">
        <span className="pm-status-mark"><StatusMarker kind="ok" /></span>{t('checkup.status.all.clear')}
      </p>
    )
  }
  const phrase = ({ scope, hasSecret }: (typeof busy)[number]) => scope.kind === 'global'
    ? t(hasSecret ? 'checkup.status.all.secret.global' : 'checkup.status.all.todo.global')
    : t(hasSecret ? 'checkup.status.all.secret' : 'checkup.status.all.todo', { name: baseName(scope.workspacePath) })
  return (
    <p className="pm-status-line">
      <span className="pm-status-mark"><StatusMarker kind={busy.some(n => n.hasSecret) ? 'secret' : 'pending'} /></span>
      {joined(busy.map((n, i) => (i === 0 ? phrase(n) : <span className="pm-status-soft">{phrase(n)}</span>)))}
    </p>
  )
}

/** 「全部」第二行的自动体检概况；全是仅手动且没有单独设置时不写。 */
function autoSummary(view: CheckupView, t: Translate): string | undefined {
  const own = view.scopes.filter(s => s.isOwn).map(s => scopeName(s.scope, t))
  const frequency = view.defaultFrequency
  if (own.length === 0) return frequency === 'manual' ? undefined : t('checkup.status.all.auto', { frequency: frequencyText(frequency, t) })
  const names = own.join(t('checkup.status.listSep'))
  return frequency === 'manual'
    ? t('checkup.status.all.manualOwn', { names })
    : t('checkup.status.all.autoOwn', { frequency: frequencyText(frequency, t), names })
}

function runningText(scope: PageScope, t: Translate): string {
  return scope.kind === 'all' ? t('checkup.result.running.all')
    : scope.kind === 'global' ? t('checkup.result.running.global')
      : t('checkup.result.running.workspace', { name: baseName(scope.workspacePath) })
}

function failureText(failure: RunFailure, t: Translate): string {
  return failure.code === 'llm-unavailable' ? t('checkup.result.llmUnavailable')
    : failure.code === 'governance-disabled' ? t('settings.governanceOff')
      : t('checkup.result.failed', { detail: failure.detail ?? failure.code })
}

/** 一行结果：p，原话（宿主的 message）放进悬停提示。 */
function Line({ children, title, isSoft = false }: { children: ReactNode; title?: string | undefined; isSoft?: boolean }) {
  return <p className={isSoft ? 'pm-status-result-line pm-status-soft-line' : 'pm-status-result-line'} title={title}>{children}</p>
}

/**
 * 结果行。按进入这个范围（换范围、重开页面）时读的「看过」记录显示，同一范围里切视图不重读；在处理视图里显示过的结果
 * 随即记为看过，换范围再回来就收起。链接只写导航目标，处理视图负责跳到第一条带「新」的条目。
 */
function ResultRow({ scope, isTodoView, nav, runs, seen, checkups, now }: {
  scope: PageScope
  isTodoView: boolean
  nav: NavStore
  runs: CheckupRuns
  seen: Seen
  checkups: CheckupView | undefined
  now: number
}) {
  const t = useT()
  const shown = useRef<SeenMark[]>([])
  shown.current = []
  useEffect(() => {
    if (isTodoView && checkups !== undefined) markSeen(checkups, shown.current)
  })
  const key = scopeKey(scope)
  const jump = (to: NewItemJump, target?: GuiLayerRef) => {
    nav.update({ view: 'todo', newItem: to, memoryId: undefined, ...(target !== undefined ? { scope: target } : {}) })
  }
  const link = (text: string, onClick: () => void) => <button type="button" className="pm-link" onClick={onClick}>{text}</button>

  const lines: ReactNode[] = []
  const busy = runs.busyScope(scope)
  if (busy !== undefined) {
    lines.push(<Line key="running" isSoft>{runningText(busy, t)}</Line>)
  } else {
    const failure = runs.failure(scope)
    if (failure !== undefined) lines.push(<Line key="manual-failed" title={failure.detail}>{failureText(failure, t)}</Line>)
    if (scope.kind === 'all') {
      const all = checkups?.allResult ?? null
      if (all !== null && !isResultSeen(seen, all.checkupId, key)) {
        shown.current.push({ checkupId: all.checkupId, scope: key })
        lines.push(...resultLines(all, 'all'))
      }
      // 还没看过的自动体检结果：在那个范围、在「全部」看过的都不算
      const autos = checkupResults(checkups).filter(({ scope: s, result }) => s !== SCOPE_KEYS.all && result.by === 'auto'
        && !isResultSeen(seen, result.checkupId, s) && !isResultSeen(seen, result.checkupId, key))
      const sum = (pick: (r: CheckupResult) => number) => autos.reduce((n, { result }) => n + pick(result), 0)
      const pendingN = sum(r => r.added.pending + (r.globalAdded?.pending ?? 0))
      const adviceN = sum(r => r.added.advice + (r.globalAdded?.advice ?? 0))
      if (pendingN + adviceN > 0) {
        for (const { result } of autos) shown.current.push({ checkupId: result.checkupId, scope: key })
        const parts: ReactNode[] = []
        if (pendingN > 0) parts.push(link(t('checkup.result.autoNewTodo', { n: formatNumber(pendingN) }), () => { jump('todo') }))
        if (adviceN > 0) {
          parts.push(link(t(pendingN > 0 ? 'checkup.result.autoNewAdvice' : 'checkup.result.autoNewAdviceOnly', { n: formatNumber(adviceN) }), () => { jump('advice') }))
        }
        lines.push(<Line key="auto">{joined(parts)}</Line>)
      }
    } else {
      const entry = checkups?.scopes.find(s => sameLayer(s.scope, scope))
      // 仅手动的范围不会自动重试：失败行和「模型用不了」一样不写
      if (entry?.failure != null && entry.frequency !== 'manual') {
        const { cause, retryAt, isRetryLimitReached } = entry.failure
        const time = formatDayTime(retryAt, now, t)
        lines.push(
          <Line key="auto-failed" title={cause.message}>
            {t(isRetryLimitReached ? 'checkup.result.autoFailed.next' : 'checkup.result.autoFailed.retry', { cause: causeText(cause, t), time })}
          </Line>,
        )
      }
      if (entry?.modelUnavailable != null && entry.frequency !== 'manual') {
        lines.push(
          <Line key="model" title={entry.modelUnavailable.message}>
            {t('checkup.result.modelUnavailable', { cause: causeText(entry.modelUnavailable, t) })}
          </Line>,
        )
      }
      const last = entry?.lastResult ?? null
      if (last !== null && !isResultSeen(seen, last.checkupId, key)) {
        shown.current.push({ checkupId: last.checkupId, scope: key })
        lines.push(...resultLines(last, key))
      }
    }
  }

  /** 一次结果：首行新增几条（链接）· 全局新增 · 用量；说明各占一行。 */
  function resultLines(result: CheckupResult, lineKey: string): ReactNode[] {
    const parts: ReactNode[] = []
    if (result.added.pending > 0) parts.push(link(t('checkup.result.newTodo', { n: formatNumber(result.added.pending) }), () => { jump('todo') }))
    if (result.added.advice > 0) parts.push(link(t('checkup.result.newAdvice', { n: formatNumber(result.added.advice) }), () => { jump('advice') }))
    const globalN = (result.globalAdded?.pending ?? 0) + (result.globalAdded?.advice ?? 0)
    if (globalN > 0) parts.push(link(t('checkup.result.newGlobal', { n: formatNumber(globalN) }), () => { jump('any', { kind: 'global' }) }))
    const head = (
      <Line key={`${lineKey}:head`}>
        {t(result.by === 'auto' ? 'checkup.result.autoDone' : 'checkup.result.done')}
        {parts.length === 0 ? t('checkup.result.nothingNew') : joined(parts)}
        {result.usageTokens !== undefined
          // 用量连同前面的分隔点不拆行：放不下时整段折到下一行
          ? <span className="pm-status-usage"><Sep />{t('checkup.result.usage', { n: formatNumber(result.usageTokens) })}</span>
          : null}
      </Line>
    )
    const notes = result.notes.flatMap(({ code, cause }): ReactNode[] => {
      const text = code === 'semantic-failed'
        ? cause === undefined ? t('checkup.result.note.semanticFailed.bare') : t('checkup.result.note.semanticFailed', { cause: causeText(cause, t) })
        : code === 'model-unavailable'
          ? cause === undefined ? t('checkup.result.note.modelUnavailable.bare') : t('checkup.result.note.modelUnavailable', { cause: causeText(cause, t) })
          : code === 'semantic-batched' ? t('checkup.result.note.semanticBatched')
            : code === 'baseline-session-scoped' ? t(lineKey === 'all' ? 'checkup.result.note.baselineSessionScoped.all' : 'checkup.result.note.baselineSessionScoped')
              // 自动体检没有会话、不查和基线的冲突；手动体检缺基线是常态，不写
              : code === 'baseline-missing' && result.by === 'auto' ? t('checkup.result.note.autoBaseline') : undefined
      return text === undefined ? [] : [<Line key={`${lineKey}:${code}`} title={cause?.message}>{text}</Line>]
    })
    return [head, ...notes]
  }

  return <div className="pm-status-result" aria-live="polite">{lines}</div>
}

export const statusBarCss = `
.pm-status { display: flex; flex-direction: column; gap: 6px; padding: 14px 16px; border-radius: var(--dsw-radius-lg, 16px); background: var(--pm-bg-block); }
.pm-status-line { display: flex; align-items: center; flex-wrap: wrap; margin: 0; font-size: 14px; font-weight: 600; line-height: 1.5; color: var(--pm-text); }
.pm-status-mark { display: inline-flex; justify-content: center; width: 14px; margin-right: 8px; }
.pm-status-soft { font-weight: 400; }
.pm-status-meta, .pm-status-deductions, .pm-status-result { margin: 0; padding-left: 22px; font-size: 12px; line-height: 1.5; color: var(--pm-text-2); }
.pm-status-why {
  display: inline-flex; align-items: center; gap: 2px; padding: 0; border: 0; background: none;
  font: inherit; color: var(--pm-text-2); cursor: pointer;
}
.pm-status-why:hover { color: var(--pm-text); }
.pm-status-why[aria-expanded='true'] svg { transform: rotate(180deg); }
.pm-status--plain :is(.pm-status-meta, .pm-status-result) { padding-left: 0; }
.pm-status-deductions { list-style: none; display: flex; flex-direction: column; gap: 2px; margin-left: 22px; padding: 6px 0 0; border-top: .5px solid var(--pm-line); }
.pm-status-result { display: flex; flex-direction: column; gap: 2px; color: var(--pm-text); }
/* 结果行一直在 DOM 里（aria-live 要先在场），空着时不占状态条的行距 */
.pm-status-result:empty { margin-top: -6px; }
.pm-status-result-line { margin: 0; }
.pm-status-soft-line { color: var(--pm-text-2); }
.pm-status-result .pm-link { font-size: 12px; }
.pm-status-usage { white-space: nowrap; }
`
