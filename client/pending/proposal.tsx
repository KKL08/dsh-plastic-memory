/**
 * 横向冲突卡的「补充要求」（spec 故事 7–19）：写一句要求或点常用处理 → 借来的会话的模型按两条原文和要求出处理方案 → 看结论、说明和对照 → 点「应用」才落盘。
 * - 常用处理里「保留 A / 保留 B / 都保留，不算冲突」不过模型，交回卡片走原来的裁决（原位确认）；「两者融合」把要求填进文本框，可以接着改。
 * - 生成发 draft-proposal（只读，方案只在这个组件的内存里），带条目 id、要求、两条的卡片版本；「改要求」后再带此前的要求和上一份方案（只作参照）。
 *   服务端回的方案带依据版本，应用时原样带回，由卡片发 apply-proposal。
 * - 「停止」只是不再等：之后到达的结果按请求序号认出来丢掉。生成中只锁这块，别的卡照常可点。
 * - 两条在看方案或生成时被改了（视图带来新版本，或应用时服务端回 stale）：方案作废，回到写要求并写明原因，写过的要求留着。
 * - 同一时刻只展开一个输入区（RequestSlots，由列表给出）：在别的卡上点「补充要求」，这张写了内容先原位问要不要放弃，没写就直接换过去。
 */
import { createContext, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { CONFLICT_ACTION_VERDICTS, type MemoryCard, type MemoryCommand, type RequestedProposal } from '../../src/gui/contract.ts'
import { interpret, refuseBeforeSend } from '../command/protocol.ts'
import { useGateway, type BorrowedSession } from '../gateway.ts'
import { useT } from '../i18n.tsx'
import type { Intent } from '../library/intents.ts'
import { Button } from '../ui/Button.tsx'
import { keepFocusInPlace, useReturnFocus } from '../ui/focus-return.ts'
import { Icon } from '../ui/Icon.tsx'
import { baseOf, draftOf } from './card-edit.ts'
import { DraftCompare, ModelBusy, modelFailureOf, RequestBox, requestFootOf } from './model-edit.tsx'
import { ACTION_LABEL } from './suggestion.tsx'

type DraftCommand = Extract<MemoryCommand, { cmd: 'draft-proposal' }>
type Previous = NonNullable<DraftCommand['previous']>
type Verdict = 'keep-left' | 'keep-right' | 'keep-both'

const { horizontal } = CONFLICT_ACTION_VERDICTS

/** 常用处理，按显示顺序：直接处理三个（不过模型）和「两者融合」（填要求）。 */
const CANDIDATES = [
  { id: horizontal.keepA, label: 'pending.conflict.keepA' },
  { id: horizontal.keepB, label: 'pending.conflict.keepB' },
  { id: 'merge', label: 'pending.proposal.merge', template: 'pending.proposal.merge.template' },
  { id: horizontal.keepBoth, label: 'pending.conflict.keepBoth' },
] as const satisfies readonly Intent[]

const isVerdict = (id: string): id is Verdict => id === horizontal.keepA || id === horizontal.keepB || id === horizontal.keepBoth

type Phase =
  /** notice：方案因两条被改过而作废的说明；error：这次没生成成。 */
  | { kind: 'ask'; error?: string; notice?: string }
  | { kind: 'busy' }
  | { kind: 'result'; proposal: RequestedProposal }
  | { kind: 'infeasible'; reason: string }

export function ProposalRequest({ decisionId, left, right, session, unavailable, isHidden, voided, discardAsk, onClose, onPick, onApply, onRefused, onDirtyChange }: {
  decisionId: string
  left: MemoryCard
  right: MemoryCard
  session: BorrowedSession
  /** 卡片的忙状态（应用中、等确认）。 */
  unavailable: string | undefined
  /** 点了常用处理的直接处理、卡片正在原位确认：这块先藏起来，写的要求留着，取消后原样回来。 */
  isHidden: boolean
  /** 应用时服务端回 stale 的次数：变了就作废手上的方案。 */
  voided: number
  /** 别的卡想展开输入区、这块写了内容时，卡片给的原位确认。 */
  discardAsk?: ReactNode
  onClose: () => void
  onPick: (verdict: Verdict) => void
  onApply: (proposal: RequestedProposal) => void
  onRefused: () => void
  onDirtyChange: (isDirty: boolean) => void
}) {
  const t = useT()
  const id = useId()
  const gateway = useGateway()
  // 展开时才问借来的会话用哪个模型（每个会话只问一次）
  const model = gateway.useModel(session)
  const [phase, setPhase] = useState<Phase>({ kind: 'ask' })
  const [request, setRequest] = useState('')
  /** 此前每一轮写过的要求，按先后：「改要求」后带上，前几轮说过的不丢。 */
  const [priorRequests, setPriorRequests] = useState<string[]>([])
  /** 上一份方案（「改要求」的起点）；做不到的那轮没有方案，沿用更早的一份。 */
  const [previous, setPrevious] = useState<Previous | undefined>(undefined)
  /** 正在等的那次请求的序号：停止、作废、收起后序号前进，旧请求的结果对不上号就丢掉。 */
  const seq = useRef(0)
  useEffect(() => () => { seq.current += 1 }, [])
  const root = useRef<HTMLDivElement>(null)
  useReturnFocus(root)

  const isDirty = request.trim() !== '' || phase.kind !== 'ask' || previous !== undefined || priorRequests.length > 0
  const dirtyChange = useRef(onDirtyChange)
  dirtyChange.current = onDirtyChange
  useEffect(() => { dirtyChange.current(isDirty) }, [isDirty])
  useEffect(() => () => { dirtyChange.current(false) }, [])

  // 两条被改过：在等的、手上的方案都作废，回到写要求并写明原因；上一份方案是按旧内容出的，不再带
  const invalidate = () => {
    seq.current += 1
    setPrevious(undefined)
    setPhase(prev => (prev.kind === 'ask' ? prev : { kind: 'ask', notice: t('pending.proposal.stale') }))
  }
  const target = [left, right].map(m => `${m.id}@${m.updatedAt}@${m.digest ?? ''}`).join('|')
  const lastTarget = useRef(target)
  useEffect(() => {
    if (lastTarget.current === target) return
    lastTarget.current = target
    invalidate()
  }, [target])
  const lastVoided = useRef(voided)
  useEffect(() => {
    if (lastVoided.current === voided) return
    lastVoided.current = voided
    invalidate()
  }, [voided])

  const generate = () => {
    if (session.kind !== 'ready') return
    const text = request.trim()
    if (text === '') return
    const command: DraftCommand = {
      cmd: 'draft-proposal', decisionId, request: text, bases: [baseOf(left), baseOf(right)],
      ...(priorRequests.length > 0 ? { priorRequests } : {}),
      ...(previous !== undefined ? { previous } : {}),
    }
    // 命令文本会进借用会话的日志：要求、此前的要求、上一份方案里有高危密钥就不发
    const refused = refuseBeforeSend(command)
    if (refused !== undefined) { setPhase({ kind: 'ask', error: refused.isLocalized ? t(refused.detail) : refused.detail }); return }
    const mine = ++seq.current
    keepFocusInPlace()
    setPhase({ kind: 'busy' })
    void gateway.execute(session.sessionId, command).then((r) => {
      if (mine !== seq.current) return
      if (!r.ok) {
        if (r.code === 'stale') { invalidate(); return }
        if (interpret(command, r).kind === 'handled-elsewhere') { setPhase({ kind: 'ask' }); onRefused(); return }
        setPhase({ kind: 'ask', error: modelFailureOf(command, r, t) })
        return
      }
      if (r.infeasible !== undefined) { setPhase({ kind: 'infeasible', reason: r.infeasible.reason }); return }
      if (r.proposal === undefined) { setPhase({ kind: 'ask', error: t('pending.model.invalid') }); return }
      setPhase({ kind: 'result', proposal: r.proposal })
    })
  }
  const stop = () => {
    seq.current += 1
    setPhase({ kind: 'ask' })
  }
  const again = () => {
    const text = request.trim()
    if (text !== '') setPriorRequests(prior => [...prior, text])
    if (phase.kind === 'result') {
      const { action, reason, ops } = phase.proposal
      setPrevious({ action, reason, ops })
    }
    setRequest('')
    setPhase({ kind: 'ask' })
  }

  const className = phase.kind === 'result' ? 'pm-edit pm-proposal pm-model-result' : 'pm-edit pm-proposal'
  let body: ReactNode
  if (phase.kind === 'busy') {
    body = <ModelBusy label={t('pending.proposal.busy')} onStop={stop} />
  } else if (phase.kind === 'ask') {
    const foot = requestFootOf(model, request.trim() === '', t, undefined, 'pending.proposal.empty')
    // 上面的说明行已经写了「先给你看结果再决定」：能生成时这里只说用哪个模型，没拿到模型名就不写
    const hint = foot.blocked !== undefined ? foot.hint : model.status === 'ready' && model.model !== undefined ? t('pending.proposal.hint', { model: model.model }) : ''
    body = (
      <>
        {phase.notice !== undefined ? <p className="pm-proposal-notice" role="status">{phase.notice}</p> : null}
        <RequestBox
          id={id}
          label={t('pending.proposal.ask')}
          value={request}
          onChange={setRequest}
          intents={CANDIDATES}
          intentsLabel={t('pending.proposal.intents')}
          onPick={(picked) => { if (isVerdict(picked)) onPick(picked) }}
          placeholder={t('pending.proposal.placeholder')}
        />
        <p className="pm-model-note"><Icon name="info" size={14} /><span>{t('pending.proposal.note')}</span></p>
        {phase.error !== undefined ? <p className="pm-pending-error" role="alert">{phase.error}</p> : null}
        <div className="pm-edit-foot">
          <span className="pm-edit-hint">{hint}</span>
          <Button variant="ghost" unavailable={unavailable} onClick={onClose}>{t('pending.cancel')}</Button>
          <Button variant="primary" unavailable={unavailable ?? foot.blocked} onClick={generate}>{t('pending.proposal.generate')}</Button>
        </div>
      </>
    )
  } else {
    body = (
      <>
        {phase.kind === 'result'
          ? <ProposalView proposal={phase.proposal} left={left} right={right} />
          : (
            <p className="pm-suggestion-line">
              <strong className="pm-suggestion-title">{t('pending.proposal.infeasible')}</strong>
              <span>{phase.reason}</span>
            </p>
          )}
        <div className="pm-edit-foot">
          <span className="pm-edit-hint" />
          <Button variant="ghost" unavailable={unavailable} onClick={onClose}>{t('pending.cancel')}</Button>
          <Button unavailable={unavailable} onClick={again}>{t('pending.proposal.again')}</Button>
          {phase.kind === 'result'
            ? <Button variant="primary" unavailable={unavailable} onClick={() => { onApply(phase.proposal) }}>{t('pending.model.apply')}</Button>
            : null}
        </div>
      </>
    )
  }
  // 输入区被候选项的原位确认盖住时，「要不要放弃」的询问照样要看得见：放到隐藏的容器外面
  return (
    <>
      {isHidden === true ? discardAsk : null}
      <div ref={root} className={className} hidden={isHidden}>
        {isHidden === true ? null : discardAsk}
        {body}
      </div>
    </>
  )
}

/** 一份方案：模型图标、加粗的结论、说明；融合写清写进哪条、和原文对照，留一条写留下的那条和另一条的去向，都保留一句话。 */
function ProposalView({ proposal, left, right }: { proposal: RequestedProposal; left: MemoryCard; right: MemoryCard }) {
  const t = useT()
  const edit = proposal.ops.find(op => op.kind === 'edit')
  const kept = proposal.action === 'keep-a' ? left : proposal.action === 'keep-b' ? right : undefined
  let detail: ReactNode = null
  if (proposal.action === 'merge' && edit?.kind === 'edit') {
    const keeper = edit.memoryId === right.id ? right : left
    detail = (
      <div className="pm-suggestion-draft">
        <p className="pm-suggestion-into">{t('pending.suggestion.mergeInto', keeper === right ? { keep: 'B', drop: 'A' } : { keep: 'A', drop: 'B' })}</p>
        <DraftCompare memories={[keeper]} base={draftOf(keeper)} draft={{ content: edit.content, name: edit.name, summary: edit.summary, tags: edit.tags }} />
      </div>
    )
  } else if (kept !== undefined) {
    detail = (
      <>
        <div className="pm-model-body"><p className="pm-model-text">{kept.content}</p></div>
        <p className="pm-suggestion-into">{t('pending.proposal.dropNote', { drop: kept === left ? 'B' : 'A' })}</p>
      </>
    )
  } else if (proposal.action === 'keep-both') {
    detail = <p className="pm-suggestion-into">{t('pending.proposal.keepBothNote')}</p>
  }
  return (
    <>
      <p className="pm-suggestion-line">
        <span className="pm-suggestion-icon"><Icon name="sparkle" size={14} /></span>
        <strong className="pm-suggestion-title">{t(ACTION_LABEL[proposal.action])}</strong>
        <span>{proposal.reason}</span>
      </p>
      {detail}
    </>
  )
}

/** 同一时刻只展开一个补充要求的输入区：开着哪一条、哪一条在等这张放弃（写了内容才问）。 */
export interface RequestSlots {
  openId: string | undefined
  waitingId: string | undefined
  want(decisionId: string): void
  close(decisionId: string): void
  report(decisionId: string, isDirty: boolean): void
  /** 放弃开着那张写的内容，换到在等的那张。 */
  discard(): void
  keep(): void
}

export function useRequestSlots(): RequestSlots {
  const [state, setState] = useState<{ openId?: string; waitingId?: string }>({})
  /** 写了内容的那几张（只在点击时读，不必触发重画）。 */
  const dirty = useRef(new Set<string>())
  const actions = useMemo(() => ({
    want(decisionId: string) {
      setState(s => (s.openId === undefined || s.openId === decisionId || !dirty.current.has(s.openId) ? { openId: decisionId } : { ...s, waitingId: decisionId }))
    },
    close(decisionId: string) {
      dirty.current.delete(decisionId)
      setState(s => (s.openId === decisionId ? {} : s.waitingId === decisionId ? { openId: s.openId } : s))
    },
    report(decisionId: string, isDirty: boolean) {
      if (isDirty) dirty.current.add(decisionId)
      else dirty.current.delete(decisionId)
    },
    discard() {
      setState(s => (s.waitingId === undefined ? s : { openId: s.waitingId }))
    },
    keep() {
      setState(s => ({ openId: s.openId }))
    },
  }), [])
  return useMemo(() => ({ openId: state.openId, waitingId: state.waitingId, ...actions }), [state, actions])
}

/** 由列表给出；不在列表里（单独渲染一张卡）时各卡自管。 */
export const RequestSlotsContext = createContext<RequestSlots | undefined>(undefined)

/** 这张卡的输入区：开没开、要不要原位问放弃。 */
export function useRequestSlot(decisionId: string) {
  const shared = useContext(RequestSlotsContext)
  const local = useRequestSlots()
  const slots = shared ?? local
  const latest = useRef(slots)
  latest.current = slots
  // 卡片换成结果卡、离开页面：这张占着的位置让出来
  useEffect(() => () => { latest.current.close(decisionId) }, [decisionId])
  const isOpen = slots.openId === decisionId
  return {
    isOpen,
    isAskingDiscard: isOpen && slots.waitingId !== undefined,
    open() { slots.want(decisionId) },
    close() { slots.close(decisionId) },
    report(isDirty: boolean) { slots.report(decisionId, isDirty) },
    discard: slots.discard,
    keep: slots.keep,
  }
}

export const proposalCss = `
.pm-proposal-notice { margin: 0; font-size: 12px; line-height: 1.5; color: var(--pm-text); }
`
