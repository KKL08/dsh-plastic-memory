/**
 * 处理卡的建议块（见词表「处理建议」「处理卡」）：有建议时写模型图标、加粗的结论、一句理由，融合、改写时带稿、写进哪条和原位对照；
 * 没有建议时写原因，能补的给「补上建议」（失败、模型判断不了之后是「再试一次」）。采纳和直接处理的按钮在块外（cards.tsx HorizontalActions）；
 * 采纳时这份建议已失效，卡片把它当作没有建议，并经 notice 写明原因。冲突卡之外的卡型以后各给结论文案。
 * 模型判断不了哪条对时如实写明加它说的理由，不按错误显示：不给结论，由用户用下面的按钮自己定。
 * 「补上建议」发 suggest：服务端生成后写进账本、重写视图，建议跟着视图来，命令结果只说成没成。生成中只锁这一块。
 * 「停止」只是不再等：已经发出的这一条照常生成、写进账本，稍后跟着视图出现；之后到达的结果按请求序号认出来丢掉。换了会话同样作废在途请求、清掉本地状态。
 * 体检之后的后续段正在给这一条排队或生成时（视图带「正在生成」标记），写「正在生成建议……」、不给按钮也不给「停止」：那一段不归这张卡管，生成完建议跟着视图来。
 * 页面加载时不问模型（问一次会在借来的会话日志里留一条记录）：只读这个会话已知的模型状态（别处问过才有），此外点过之后服务端回 llm-unavailable 才知道拿不到。
 */
import { createContext, useContext, useEffect, useRef, useState } from 'react'
import type { MemoryCard, MemoryCommand, NoSuggestion, PendingItem, ProposalAction, Suggestion } from '../../src/gui/contract.ts'
import { interpret } from '../command/protocol.ts'
import { causeText } from '../checkup/StatusBar.tsx'
import { useGateway, type BorrowedSession } from '../gateway.ts'
import { formatNumber, useT, type Translate } from '../i18n.tsx'
import type { LocaleKey } from '../locales.ts'
import { Button } from '../ui/Button.tsx'
import { keepFocusInPlace } from '../ui/focus-return.ts'
import { Icon } from '../ui/Icon.tsx'
import { DraftCompare, ModelBusy, modelFailureOf } from './model-edit.tsx'

/** 处理建议结论的显示名：记忆页的建议块和右侧栏的冲突行同用。 */
export const ACTION_LABEL = {
  'merge': 'pending.suggestion.action.merge',
  'keep-a': 'pending.suggestion.action.keepA',
  'keep-b': 'pending.suggestion.action.keepB',
  'keep-both': 'pending.suggestion.action.keepBoth',
  'rewrite': 'pending.suggestion.action.rewrite',
  'delete': 'pending.suggestion.action.delete',
} as const satisfies Record<ProposalAction, LocaleKey>

/**
 * 本地状态：idle 照视图显示；busy 命令在途；waiting 命令成功、等视图带来建议（signature 是点击时视图里没有建议的原因，变了就不再等）；
 * failed 命令失败的原话或文案，视图里的原因变了就让给视图；unavailable 服务端说这个会话拿不到模型，不再给按钮。换了会话都清掉。
 */
type Phase =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'waiting'; signature: string }
  | { kind: 'failed'; message: string; signature: string }
  | { kind: 'unavailable' }

/** 命令成功后等视图带来建议的上限：视图通常随命令结果一起到。 */
export const WAIT_FOR_VIEW_MS = 5000

const signatureOf = (none: NoSuggestion | undefined) => JSON.stringify(none ?? null)

/** 没生成成的原因写成一句：模型错误按宿主错误码、再按种类（同体检的原因文案），稿里带进密钥单独一句。 */
function failureText(cause: NonNullable<NoSuggestion['cause']>, t: Translate): string {
  if (cause.kind === 'secret-in-draft') return t('pending.suggestion.secretInDraft')
  return causeText({ kind: cause.kind, ...(cause.hostCode !== undefined ? { hostCode: cause.hostCode } : {}) }, t)
}

export function SuggestionBlock({ decisionId, left, right, suggestion, noSuggestion, isGenerating = false, notice, session, onRefused }: {
  decisionId: string
  /** A、B 两条（视图里的卡片），融合稿写进哪条、对照的原文按它们找；垂直冲突只有这一条（left）。 */
  left: MemoryCard
  right?: MemoryCard | undefined
  suggestion: Suggestion | undefined
  noSuggestion: NoSuggestion | undefined
  /** 体检之后的后续段正在给这一条生成（视图里的「正在生成」标记）。 */
  isGenerating?: boolean
  /** 没有建议时代替原因写的一句（采纳时建议已失效）：标题改成「这次没有建议」，读屏会念出来。 */
  notice?: string | undefined
  session: BorrowedSession
  /** 这一条已在别处处理（条目不在了、正被认领）。 */
  onRefused: () => void
}) {
  const t = useT()
  const gateway = useGateway()
  const model = gateway.useModel(session, { shouldAsk: false })
  const isBatchCurrent = useContext(BatchSuggesting) === decisionId
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  /** 正在等的那次请求的序号：停止、换会话、卸载后序号前进，旧请求的结果对不上号就丢掉。 */
  const seq = useRef(0)
  const sessionId = session.kind === 'ready' ? session.sessionId : undefined
  useEffect(() => () => {
    seq.current += 1
    setPhase({ kind: 'idle' })
  }, [sessionId])
  const signature = signatureOf(noSuggestion)
  /** 此刻视图里没有建议的原因：命令结果到达时和点击时的比，变了就让给视图。 */
  const latestSignature = useRef(signature)
  latestSignature.current = signature
  // 视图换了（建议来了、原因变了）：在等的、本地写的失败都让给视图
  useEffect(() => {
    setPhase(prev => ((prev.kind === 'waiting' || prev.kind === 'failed') && (suggestion !== undefined || prev.signature !== signature) ? { kind: 'idle' } : prev))
  }, [signature, suggestion])
  // 命令成功而视图一直没变（建议刚写完，两条又被改了，它在视图里已不算数）：等够时间回到可以再点的样子
  const isWaiting = phase.kind === 'waiting'
  useEffect(() => {
    if (!isWaiting) return
    const timer = setTimeout(() => { setPhase(prev => (prev.kind === 'waiting' ? { kind: 'idle' } : prev)) }, WAIT_FOR_VIEW_MS)
    return () => { clearTimeout(timer) }
  }, [isWaiting])

  if (suggestion !== undefined) return <SuggestionView suggestion={suggestion} left={left} right={right} />
  if (noSuggestion === undefined) return null
  const isVertical = right === undefined

  const generate = () => {
    if (session.kind !== 'ready') return
    const command: MemoryCommand = { cmd: 'suggest', decisionId }
    const mine = ++seq.current
    const clicked = signature
    keepFocusInPlace()
    setPhase({ kind: 'busy' })
    void gateway.execute(session.sessionId, command).then((r) => {
      if (mine !== seq.current) return
      // 等结果期间视图已经换了（别处生成完、记下了失败或判断不了）：照视图显示，不再等、不再写本地的错误
      const isViewChanged = latestSignature.current !== clicked
      if (r.ok) { setPhase(isViewChanged ? { kind: 'idle' } : { kind: 'waiting', signature: clicked }); return }
      if (r.code === 'llm-unavailable') { setPhase({ kind: 'unavailable' }); return }
      // 认领不到只是这次没写进去，条目还在：回到可以再点的样子
      if (r.code === 'claimed') { setPhase({ kind: 'idle' }); return }
      if (interpret(command, r).kind === 'handled-elsewhere') { setPhase({ kind: 'idle' }); onRefused(); return }
      setPhase(isViewChanged ? { kind: 'idle' } : { kind: 'failed', message: modelFailureOf(command, r, t), signature: clicked })
    })
  }
  const stop = () => {
    seq.current += 1
    setPhase({ kind: 'idle' })
  }

  if (phase.kind === 'busy' || phase.kind === 'waiting') {
    return <div className="pm-suggestion"><ModelBusy label={t('pending.suggestion.busy')} onStop={stop} /></div>
  }
  if ((isGenerating || isBatchCurrent) && notice === undefined) {
    return (
      <div className="pm-suggestion">
        <div className="pm-model-busy" role="status"><span className="pm-model-dot" aria-hidden="true" /><span>{t('pending.suggestion.busy')}</span></div>
      </div>
    )
  }
  if (noSuggestion.code === 'has-secret') {
    const side = left.hasSecret === true && right?.hasSecret === true ? 'A、B' : left.hasSecret === true ? 'A' : 'B'
    return (
      <div className="pm-suggestion">
        <p className="pm-suggestion-line">
          <strong className="pm-suggestion-title">{t('pending.suggestion.none')}</strong>
          <span>{isVertical ? t('pending.suggestion.secretVertical') : t('pending.suggestion.secret', { side })}</span>
        </p>
      </div>
    )
  }
  const isUnavailable = model.status === 'unavailable' || phase.kind === 'unavailable'
  const isUndecided = noSuggestion.code === 'undecided'
  const reason = notice ?? (isUndecided ? noSuggestion.reason
    : isUnavailable ? t('pending.model.unavailable')
      : noSuggestion.code === 'failed' && noSuggestion.cause !== undefined ? t('pending.suggestion.failed', { reason: failureText(noSuggestion.cause, t) })
        : phase.kind === 'failed' ? undefined
          : noSuggestion.code === 'quota-exhausted' ? t('pending.suggestion.quotaExhausted')
            : noSuggestion.code === 'no-baseline' ? t('pending.suggestion.noBaseline')
              : t(isVertical ? 'pending.suggestion.notGeneratedVertical' : 'pending.suggestion.notGenerated'))
  const isRetry = phase.kind === 'failed' || noSuggestion.code === 'failed' || isUndecided
  return (
    <div className="pm-suggestion">
      <p className="pm-suggestion-line" role={notice !== undefined ? 'status' : undefined}>
        <strong className="pm-suggestion-title">{t(notice !== undefined ? 'pending.suggestion.none' : isUndecided ? 'pending.suggestion.undecided' : 'pending.suggestion.missing')}</strong>
        {reason !== undefined ? <span>{reason}</span> : null}
      </p>
      {phase.kind === 'failed' ? <p className="pm-pending-error" role="alert">{phase.message}</p> : null}
      {isUnavailable
        ? null
        : (
          <div className="pm-suggestion-actions">
            <Button unavailable={session.kind === 'ready' ? undefined : t('session.none.hint')} onClick={generate}>
              <Icon name="sparkle" size={14} />{t(isRetry ? 'pending.suggestion.retry' : 'pending.suggestion.generate')}
            </Button>
          </div>
        )}
    </div>
  )
}

/** 「全部补上」此刻正在给哪一条生成：那张卡的建议块照「正在生成」显示，不再给自己的按钮。 */
export const BatchSuggesting = createContext<string | undefined>(undefined)

type ConflictItem = Extract<PendingItem, { kind: 'conflict-horizontal' | 'conflict-vertical' }>

/**
 * 「全部补上」要补的一条：等你决定里的冲突，记忆都读得出，视图写着还没有建议（没生成、上次失败、自动体检名额用完；垂直冲突还有缺基线），
 * 体检之后的后续段也没在生成它。
 */
export function isMissingSuggestion(item: PendingItem): item is ConflictItem {
  if (item.level !== 'your-call') return false
  if (item.kind !== 'conflict-horizontal' && item.kind !== 'conflict-vertical') return false
  if (item.kind === 'conflict-horizontal' ? item.left === null || item.right === null : item.memory === null) return false
  if (item.suggestion !== undefined || item.isGeneratingSuggestion === true) return false
  const code = item.noSuggestion?.code
  return code === 'not-generated' || code === 'failed' || code === 'quota-exhausted' || (item.kind === 'conflict-vertical' && code === 'no-baseline')
}

type BatchPhase = { kind: 'idle' } | { kind: 'running'; at: number; total: number } | { kind: 'unavailable' }

/**
 * 「等你决定」分区标题下的一行：两条以上没有建议时写「{N} 条还没有建议 · 全部补上」。
 * 点了按点击那一刻的这些条目依次发 suggest（一条回来再发下一条），行内写进度和「停止」；轮到时已经不缺建议的（处理掉了、别处生成了）跳过。
 * 「停止」同单卡：只是不再等、不再发下一条，已经发出的那条照常生成、写进账本；已生成的都留着。换了会话、离开页面同样停下。
 * 当前会话已知拿不到模型时不显示；发出去才知道拿不到（llm-unavailable）就停下，行内写原因。
 */
export function SuggestAll({ items, session, onCurrent }: {
  /** 此刻视图里缺建议的条目（isMissingSuggestion）。 */
  items: readonly ConflictItem[]
  session: BorrowedSession
  /** 正在给哪一条生成（没有在生成时 undefined）。 */
  onCurrent: (decisionId: string | undefined) => void
}) {
  const t = useT()
  const gateway = useGateway()
  const model = gateway.useModel(session, { shouldAsk: false })
  const [phase, setPhase] = useState<BatchPhase>({ kind: 'idle' })
  const seq = useRef(0)
  const current = useRef(onCurrent)
  current.current = onCurrent
  /** 此刻还缺建议的条目：轮到某条时它已不在里面就跳过。 */
  const missing = useRef(items)
  missing.current = items
  const sessionId = session.kind === 'ready' ? session.sessionId : undefined
  useEffect(() => () => {
    seq.current += 1
    setPhase({ kind: 'idle' })
    current.current(undefined)
  }, [sessionId])

  const run = async () => {
    if (session.kind !== 'ready') return
    const ids = items.map(item => item.decisionId)
    const mine = ++seq.current
    keepFocusInPlace()
    for (const [index, decisionId] of ids.entries()) {
      if (mine !== seq.current) return
      if (!missing.current.some(item => item.decisionId === decisionId)) continue
      setPhase({ kind: 'running', at: index + 1, total: ids.length })
      current.current(decisionId)
      const r = await gateway.execute(session.sessionId, { cmd: 'suggest', decisionId })
      if (mine !== seq.current) return
      // 其余的失败（没生成成、条目已在别处处理）由服务端写进视图、卡上自己写原因，接着下一条
      if (!r.ok && r.code === 'llm-unavailable') {
        current.current(undefined)
        setPhase({ kind: 'unavailable' })
        return
      }
    }
    current.current(undefined)
    setPhase({ kind: 'idle' })
  }
  const stop = () => {
    seq.current += 1
    current.current(undefined)
    setPhase({ kind: 'idle' })
  }

  if (phase.kind === 'running') {
    return (
      <div className="pm-suggest-all">
        <ModelBusy label={t('pending.suggestAll.progress', { at: formatNumber(phase.at), total: formatNumber(phase.total) })} onStop={stop} />
      </div>
    )
  }
  if (phase.kind === 'unavailable') return <p className="pm-suggest-all" role="alert">{t('pending.model.unavailable')}</p>
  if (items.length < 2 || model.status === 'unavailable') return null
  return (
    <div className="pm-suggest-all">
      <span>{t('pending.suggestAll.missing', { n: formatNumber(items.length) })}</span>
      <i className="pm-sep" aria-hidden="true">·</i>
      <Button variant="ghost" size="sm" unavailable={session.kind === 'ready' ? undefined : t('session.none.hint')} onClick={() => { void run() }}>
        <Icon name="sparkle" size={14} />{t('pending.suggestAll.run')}
      </Button>
    </div>
  )
}

/** 有建议：模型图标、加粗的结论、一句理由；融合、改写时带稿、写进哪条，「看和原文的对照」原位换成左右对照。 */
function SuggestionView({ suggestion, left, right }: { suggestion: Suggestion; left: MemoryCard; right: MemoryCard | undefined }) {
  const t = useT()
  const [isComparing, setComparing] = useState(false)
  const edit = suggestion.ops.find(op => op.kind === 'edit')
  const keeper = edit === undefined ? undefined : edit.memoryId === right?.id ? right : left
  const draft = edit === undefined ? undefined : { content: edit.content, name: edit.name, summary: edit.summary, tags: edit.tags }
  return (
    <div className="pm-suggestion">
      <p className="pm-suggestion-line">
        <span className="pm-suggestion-icon"><Icon name="sparkle" size={14} /></span>
        <strong className="pm-suggestion-title">{t(ACTION_LABEL[suggestion.action])}</strong>
        <span>{suggestion.reason}</span>
      </p>
      {keeper !== undefined && draft !== undefined
        ? (
          <div className="pm-suggestion-draft">
            <p className="pm-suggestion-into">
              {suggestion.action === 'rewrite' ? t('pending.suggestion.rewriteInto')
                : t('pending.suggestion.mergeInto', keeper === right ? { keep: 'B', drop: 'A' } : { keep: 'A', drop: 'B' })}
            </p>
            {isComparing
              ? <DraftCompare memories={[keeper]} base={{ content: keeper.content, name: keeper.name, summary: keeper.summary, tags: keeper.tags }} draft={draft} />
              : <p className="pm-model-text">{draft.content}</p>}
            <Button variant="ghost" size="sm" aria-expanded={isComparing} onClick={() => { setComparing(v => !v) }}>
              {t(isComparing ? 'pending.suggestion.compareHide' : 'pending.suggestion.compare')}
            </Button>
          </div>
        )
        : null}
    </div>
  )
}

export const suggestionCss = `
.pm-suggestion { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; border-radius: var(--dsw-radius-md, 12px); background: var(--pm-accent-tint); }
.pm-suggestion-line { display: flex; flex-wrap: wrap; align-items: baseline; column-gap: 1em; row-gap: 2px; margin: 0; font-size: 13px; line-height: 1.5; color: var(--pm-text); }
.pm-suggestion-icon { display: inline-flex; align-self: center; color: var(--pm-accent); }
.pm-suggestion-line .pm-suggestion-icon { margin-right: -0.5em; }
.pm-suggestion-title { font-weight: 600; }
.pm-suggestion-draft { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; min-width: 0; }
.pm-suggestion-draft > * { max-width: 100%; }
.pm-suggestion-into { margin: 0; font-size: 12px; line-height: 1.5; color: var(--pm-text-2); }
.pm-suggestion-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.pm-suggest-all { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 6px; margin: 0; font-size: 12px; line-height: 1.5; color: var(--pm-text-2); }
.pm-suggest-all .pm-sep { margin: 0; }
.pm-suggest-all .pm-model-busy { flex: 1; font-size: 12px; }
`
