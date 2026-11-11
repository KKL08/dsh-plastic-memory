/**
 * 建议整理卡里的「让模型改 / 让模型合并」：写一句要求（可不写）→ 借来的会话的模型生成一稿 → 原文与改后左右对照 → 点「应用」才写入。
 * 生成发 draft-edit（只读，结果只在这个组件的内存里）；应用交回卡片，按手动改、手动合并发 edit-memory / merge-memories，
 * 之后的结果行、撤销都和手动改一样。生成中只锁这张卡。
 * 「停止」只是不再等：命令没法从界面取消，之后到达的结果按请求序号认出来丢掉；目标记忆或它的版本变了也一样。
 * 挂在两段切换的外壳（edit-modes.tsx）里：「放弃」只清掉这一稿、回到写要求（要求保留），关闭面板走外壳。
 * 记忆查看里的修改不是从建议来的，没有建议类型：要求必填，空着时「生成修改」置灰；单条时给快捷意图和说明。
 */
import { diffWords, type Change } from 'diff'
import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { scopeOfMemory, type MemoryCard, type MemoryCommand, type MemoryCommandResult, type ModelEditAdviceType } from '../../src/gui/contract.ts'
import { interpret, LLM_FAILURE_KEYS, refuseBeforeSend } from '../command/protocol.ts'
import { useGateway, type BorrowedSession, type ModelState } from '../gateway.ts'
import { formatNumber, useT, type Translate } from '../i18n.tsx'
import { INTENT_BLANK, SINGLE_INTENTS, type Intent } from '../library/intents.ts'
import type { LocaleKey } from '../locales.ts'
import { Button } from '../ui/Button.tsx'
import { keepFocusInPlace, useReturnFocus } from '../ui/focus-return.ts'
import { Icon } from '../ui/Icon.tsx'
import type { EditDraft } from './edit.tsx'
import { useReportEditState, type EditPhase, type EditState } from './edit-modes.tsx'

type DraftCommand = Extract<MemoryCommand, { cmd: 'draft-edit' }>

type Phase =
  | { kind: 'ask'; error?: string }
  | { kind: 'busy' }
  | { kind: 'result'; draft: EditDraft }

/** 按中文词切分后对照：只用在单条记忆上，合并只并排不高亮。 */
const segmenter = new Intl.Segmenter('zh', { granularity: 'word' })
const diffOf = (before: string, after: string) => diffWords(before, after, { intlSegmenter: segmenter })

/**
 * 让模型改、整理所选这几条命令失败的文案：模型出错带原话，其余按命令协议（拿不到模型、输出不合格式、stale、not-found 等换本地文案）。
 * 单条修改的生成和整理的计划、出稿、应用共用。
 */
export function modelFailureOf(command: MemoryCommand, r: Extract<MemoryCommandResult, { ok: false }>, t: Translate): string {
  if (r.code === 'llm-failed') return t(LLM_FAILURE_KEYS[r.code], { detail: r.detail ?? '' })
  const outcome = interpret(command, r)
  if (outcome.kind !== 'failed') return t('command.failed', { detail: r.detail ?? r.code })
  return outcome.isLocalized ? t(outcome.detail) : t('command.failed', { detail: outcome.detail })
}

/** 拿到模型名写全句；会话没有模型写原因；还在问或没给名字只写后半句。 */
function hintOf(model: ModelState, t: Translate): string {
  if (model.status === 'unavailable') return t('pending.model.unavailable')
  return model.status === 'ready' && model.model !== undefined ? t('pending.model.hint', { model: model.model }) : t('pending.model.hintNoName')
}

/**
 * 写要求区底栏：左侧的提示和「生成」的置灰原因。拿不到模型最先；other 是调用方另有的原因，排在它之后、要求空着之前。
 * 要求空着（isMissing）时提示写要求（empty 是调用方换的说法），否则写用哪个模型。
 */
export function requestFootOf(model: ModelState, isMissing: boolean, t: Translate, other?: string, empty: LocaleKey = 'library.model.empty'): { hint: string; blocked: string | undefined } {
  const isUnavailable = model.status === 'unavailable'
  return {
    hint: isMissing && !isUnavailable ? t(empty) : hintOf(model, t),
    blocked: isUnavailable ? t('pending.model.unavailable') : other ?? (isMissing ? t(empty) : undefined),
  }
}

/** 模型生成中的一行：跳动的点、在做什么、「停止」。 */
export function ModelBusy({ label, onStop }: { label: string; onStop: () => void }) {
  const t = useT()
  return (
    <div className="pm-model-busy" role="status">
      <span className="pm-model-dot" aria-hidden="true" />
      <span>{label}</span>
      <Button variant="ghost" onClick={onStop}>{t('pending.model.stop')}</Button>
    </div>
  )
}

export function ModelEditPanel({ memories, adviceType, typeTitle, base, keeper, session, unavailable, onClose, onApply, onStateChange }: {
  /** 一条，或合并时两条（卡片上的左右顺序）。 */
  memories: readonly [MemoryCard] | readonly [MemoryCard, MemoryCard]
  /** 从建议整理卡来时的建议类型（要求可不写，按它的默认要求）；记忆查看里没有，要求必填。 */
  adviceType?: ModelEditAdviceType
  /** 建议类型的标题，写进输入框的说明。 */
  typeTitle?: string
  /** 模型没改名称、标签时沿用的值，也是对照里原来的名称、摘要、标签：单条是它自己，合并是手动合并的预填。 */
  base: EditDraft
  /** 合并时保留哪条（mergeKeeperIndex）。 */
  keeper?: 0 | 1
  session: BorrowedSession
  /** 卡片的忙状态（应用中、等确认）。 */
  unavailable: string | undefined
  /** 写要求时的「取消」：关闭整个面板。 */
  onClose: () => void
  onApply: (draft: EditDraft) => void
  onStateChange?: (state: EditState) => void
}) {
  const t = useT()
  const id = useId()
  const gateway = useGateway()
  // 面板打开时才问借来的会话用哪个模型（每个会话只问一次）：问一次会在那个会话的日志里留一条记录
  const model = gateway.useModel(session)
  const [phase, setPhase] = useState<Phase>({ kind: 'ask' })
  const [request, setRequest] = useState('')
  /** 「再改改」的起点。 */
  const [previous, setPrevious] = useState<EditDraft | undefined>(undefined)
  /** 此前每一轮写过的要求，按先后：「再改改」时带上，前几轮纠正过的事实不丢。 */
  const [priorRequests, setPriorRequests] = useState<string[]>([])
  /** 正在等的那次请求的序号：停止、收起后序号前进，旧请求的结果对不上号就丢掉。 */
  const seq = useRef(0)
  useEffect(() => () => { seq.current += 1 }, [])
  // 目标记忆或它的版本变了：在等的那次作废，回到写要求
  const target = memories.map(m => `${m.id}@${m.updatedAt}@${m.digest ?? ''}`).join('|')
  const lastTarget = useRef(target)
  useEffect(() => {
    if (lastTarget.current === target) return
    lastTarget.current = target
    seq.current += 1
    setPhase(prev => (prev.kind === 'busy' ? { kind: 'ask' } : prev))
  }, [target])
  /** 点过「应用」：之后卡片忙着（保存中、等确认）就报 saving。 */
  const [hasApplied, setApplied] = useState(false)
  // 卡片不忙了（命令回来了：失败、确认被取消，或发送前就拦下）就复位，之后卡片因别的原因不可用不算保存中
  useEffect(() => { if (hasApplied && unavailable === undefined) setApplied(false) }, [hasApplied, unavailable])
  const reported: EditPhase = phase.kind === 'ask' ? 'idle' : phase.kind === 'busy' ? 'busy' : hasApplied && unavailable !== undefined ? 'saving' : 'result'
  // 「再改改」后还没写新要求时，上一稿也是没应用的稿
  useReportEditState(onStateChange, reported, request.trim() !== '' || phase.kind === 'result' || previous !== undefined)
  const root = useRef<HTMLDivElement>(null)
  useReturnFocus(root)

  const isRequired = adviceType === undefined
  const isSingle = memories.length === 1
  const generate = () => {
    if (session.kind !== 'ready') return
    const text = request.trim()
    if (isRequired && text === '') return
    const command: DraftCommand = {
      cmd: 'draft-edit',
      ...(adviceType !== undefined ? { adviceType } : {}),
      memories: memories.map(m => ({ memoryId: m.id, layer: scopeOfMemory(m) })) as DraftCommand['memories'],
      ...(text !== '' ? { request: text } : {}),
      ...(priorRequests.length > 0 ? { priorRequests } : {}),
      ...(previous !== undefined ? { previous } : {}),
    }
    // 命令文本会进借用会话的日志：要求、此前的要求、上一稿里有高危密钥就不发
    const refused = refuseBeforeSend(command)
    if (refused !== undefined) { setPhase({ kind: 'ask', error: refused.isLocalized ? t(refused.detail) : refused.detail }); return }
    const mine = ++seq.current
    keepFocusInPlace()
    setPhase({ kind: 'busy' })
    void gateway.execute(session.sessionId, command).then((r) => {
      if (mine !== seq.current) return
      if (!r.ok) { setPhase({ kind: 'ask', error: modelFailureOf(command, r, t) }); return }
      if (r.draft === undefined) { setPhase({ kind: 'ask', error: t('pending.model.invalid') }); return }
      const { content, summary, name, tags } = r.draft
      setPhase({ kind: 'result', draft: { content, summary, name: name ?? base.name, tags: tags ?? base.tags } })
    })
  }
  const stop = () => {
    seq.current += 1
    setPhase({ kind: 'ask' })
  }

  if (phase.kind === 'busy') {
    return (
      <div ref={root} className="pm-edit">
        <ModelBusy label={t('pending.model.busy')} onStop={stop} />
      </div>
    )
  }

  if (phase.kind === 'ask') {
    const foot = requestFootOf(model, isRequired && request.trim() === '', t)
    return (
      <div ref={root} className="pm-edit">
        <RequestBox
          id={id}
          label={isRequired ? t('library.model.ask') : t('pending.model.ask', { type: typeTitle ?? '' })}
          value={request}
          onChange={setRequest}
          intents={isSingle ? SINGLE_INTENTS : undefined}
          placeholder={isSingle ? t('library.model.placeholder') : undefined}
        />
        {isRequired
          ? <p className="pm-model-note"><Icon name="info" size={14} /><span>{t('library.model.note')}</span></p>
          : null}
        {phase.error !== undefined ? <p className="pm-pending-error" role="alert">{phase.error}</p> : null}
        <div className="pm-edit-foot">
          <span className="pm-edit-hint">{foot.hint}</span>
          <Button variant="ghost" unavailable={unavailable} onClick={onClose}>{t('pending.cancel')}</Button>
          <Button variant="primary" unavailable={unavailable ?? foot.blocked} onClick={generate}>{t('pending.model.generate')}</Button>
        </div>
      </div>
    )
  }

  const { draft } = phase
  return (
    <div ref={root} className="pm-edit pm-model-result">
      <DraftCompare memories={memories} base={base} draft={draft} keeper={keeper} />
      <div className="pm-edit-foot">
        <span className="pm-edit-hint" />
        <Button variant="ghost" unavailable={unavailable} onClick={() => { setPhase({ kind: 'ask' }) }}>{t('pending.model.discard')}</Button>
        <Button
          unavailable={unavailable}
          onClick={() => {
            const text = request.trim()
            if (text !== '') setPriorRequests(prior => [...prior, text])
            setPrevious(draft); setRequest(''); setPhase({ kind: 'ask' })
          }}
        >
          {t('pending.model.again')}
        </Button>
        <Button variant="primary" unavailable={unavailable} onClick={() => { setApplied(true); onApply(draft) }}>{t('pending.model.apply')}</Button>
      </div>
    </div>
  )
}

/**
 * 原文与改后左右对照：单条按词高亮（原文一侧标删掉的、改后一侧标新增的），合并只并排；下方「N → M 字」，合并时加上哪条进最近删除。
 * 名称、摘要、标签变了才列出来。单条、合并的模型面板和整理所选的对照应用共用。
 */
export function DraftCompare({ memories, base, draft, keeper }: {
  memories: readonly [MemoryCard] | readonly [MemoryCard, MemoryCard]
  /** 对照里原来的名称、摘要、标签。 */
  base: EditDraft
  draft: EditDraft
  keeper?: 0 | 1 | undefined
}) {
  const t = useT()
  const id = useId()
  const isMerge = memories.length === 2
  const chars = memories.reduce((n, m) => n + m.content.length, 0)
  // 名称、摘要、标签：变了才列出来
  const fields = [
    { label: t('pending.edit.summary'), before: base.summary, after: draft.summary },
    { label: t('pending.edit.name'), before: base.name, after: draft.name },
    { label: t('pending.edit.tags'), before: base.tags.join('、'), after: draft.tags.join('、') },
  ].filter(f => f.before !== f.after).map(f => ({ ...f, parts: isMerge ? undefined : diffOf(f.before, f.after) }))
  const side = (index: 0 | 1) => t(index === 0 ? 'pending.model.left' : 'pending.model.right')
  const removed = keeper === undefined ? undefined : side(keeper === 0 ? 1 : 0)
  const contentParts = isMerge ? undefined : diffOf(memories[0].content, draft.content)
  const before = contentParts === undefined
    ? memories.map(m => <p key={m.id} className="pm-model-text">{m.content}</p>)
    : <p className="pm-model-text"><Diff parts={contentParts} side="before" /></p>
  const after = <p className="pm-model-text">{contentParts === undefined ? draft.content : <Diff parts={contentParts} side="after" />}</p>
  const fieldRows = (which: 'before' | 'after') => fields.map(f => (
    <p key={f.label} className="pm-model-field">
      <span className="pm-model-field-label">{f.label}</span>
      {f.parts === undefined ? f[which] : <Diff parts={f.parts} side={which} />}
    </p>
  ))
  return (
    <>
      <div className="pm-model-compare">
        <section className="pm-model-pane" aria-labelledby={`${id}-before`}>
          <h4 id={`${id}-before`} className="pm-model-pane-title">{t(isMerge ? 'pending.model.mergeBefore' : 'pending.model.before')}</h4>
          <div className="pm-model-body">{before}{fieldRows('before')}</div>
        </section>
        <section className="pm-model-pane" aria-labelledby={`${id}-after`}>
          <h4 id={`${id}-after`} className="pm-model-pane-title">
            {keeper !== undefined ? t('pending.model.mergeAfter', { side: side(keeper) }) : t('pending.model.after')}
          </h4>
          <div className="pm-model-body">{after}{fieldRows('after')}</div>
        </section>
      </div>
      <p className="pm-model-stat">
        <span>{t('pending.edit.count', { from: formatNumber(chars), to: formatNumber(draft.content.length) })}</span>
        {removed !== undefined ? <><span aria-hidden="true">{' · '}</span><span>{t('pending.model.mergeNote', { side: removed })}</span></> : null}
      </p>
    </>
  )
}

/**
 * 写要求区：标签、快捷意图（给了才有）、要求框。点快捷意图把模板换进要求框（替换原有内容）、按钮按下，
 * 选中第一个「___」等用户改。单条修改、待处理卡的让模型改、冲突卡的补充要求共用。
 * 没有模板的意图不填要求框，点了交给 onPick（补充要求里的保留 A、B 这类直接处理）。
 */
export function RequestBox({ id, label, value, onChange, intents, intentsLabel, onPick, placeholder }: {
  /** 要求框的 id 前缀（同一面板里的 useId）。 */
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  intents?: readonly Intent[] | undefined
  /** 快捷意图那一组的标签，缺省「快捷意图」的说法。 */
  intentsLabel?: string | undefined
  onPick?: ((id: string) => void) | undefined
  placeholder?: string | undefined
}) {
  const t = useT()
  const box = useRef<HTMLTextAreaElement>(null)
  const [picked, setPicked] = useState<string>()
  /** 每填一次模板加一：填进去之后（渲染完）选中第一个空。 */
  const [filled, setFilled] = useState(0)
  useLayoutEffect(() => {
    const el = box.current
    if (filled === 0 || el === null) return
    el.focus()
    const at = el.value.indexOf(INTENT_BLANK)
    if (at >= 0) el.setSelectionRange(at, at + INTENT_BLANK.length)
  }, [filled])
  return (
    <>
      <label className="pm-edit-label" htmlFor={`${id}-ask`}>{label}</label>
      {intents !== undefined
        ? (
          <div className="pm-intents" role="group" aria-labelledby={`${id}-intents`}>
            <span id={`${id}-intents`} className="pm-intents-label">{intentsLabel ?? t('library.model.intents')}</span>
            {intents.map(intent => (
              <Button
                key={intent.id}
                variant="quiet"
                className="pm-intent"
                aria-pressed={intent.template === undefined ? undefined : picked === intent.id && value !== ''}
                onClick={() => {
                  const { template } = intent
                  if (template === undefined) { onPick?.(intent.id); return }
                  onChange(t(template)); setPicked(intent.id); setFilled(n => n + 1)
                }}
              >
                {t(intent.label)}
              </Button>
            ))}
          </div>
        )
        : null}
      <textarea
        ref={box}
        id={`${id}-ask`}
        className="pm-edit-input pm-model-ask"
        value={value}
        placeholder={placeholder}
        autoFocus
        onChange={(event) => { onChange(event.target.value) }}
      />
    </>
  )
}

/** 对照的一侧：原文一侧只标删掉的，改后一侧只标新增的。 */
function Diff({ parts, side }: { parts: Change[]; side: 'before' | 'after' }) {
  return (
    <>
      {parts.map((part, i) => part.added ? (side === 'after' ? <ins key={i}>{part.value}</ins> : null)
        : part.removed ? (side === 'before' ? <del key={i}>{part.value}</del> : null)
          : <Fragment key={i}>{part.value}</Fragment>)}
    </>
  )
}

export const modelEditCss = `
.pm-model-ask { min-height: 58px; resize: vertical; }
.pm-model-ask::placeholder { color: var(--pm-text-2); }
.pm-intents { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.pm-intents-label { margin-right: 2px; font-size: 12px; line-height: 1.5; color: var(--pm-text-2); }
.pm-intent[aria-pressed='true'] { background: var(--pm-pressed); color: var(--pm-text); }
.pm-model-note { display: flex; align-items: flex-start; gap: 6px; margin: 0; font-size: 12px; line-height: 1.5; color: var(--pm-text-2); }
.pm-model-note svg { flex-shrink: 0; margin-top: 2px; }
.pm-model-busy { display: flex; align-items: center; gap: 10px; font-size: 13px; line-height: 1.5; color: var(--pm-text-2); }
.pm-model-busy .pm-btn { margin-left: auto; }
.pm-model-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--pm-text-2); animation: pm-model-pulse 1.2s ease-in-out infinite; }
@keyframes pm-model-pulse { 0%, 100% { opacity: .3; } 50% { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .pm-model-dot { animation: none; } }
.pm-model-result { container-type: inline-size; }
.pm-model-compare { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
@container (max-width: 520px) { .pm-model-compare { grid-template-columns: minmax(0, 1fr); } }
.pm-model-pane { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.pm-model-pane-title { margin: 0; font-size: 12px; font-weight: 600; line-height: 1.5; color: var(--pm-text-2); }
.pm-model-body {
  display: flex; flex-direction: column; gap: 6px; padding: 10px 12px; border-radius: var(--dsw-radius-sm, 8px);
  background: var(--pm-bg); border: .5px solid var(--pm-line-card);
}
.pm-model-text, .pm-model-field { margin: 0; font-size: 13px; line-height: 1.6; color: var(--pm-text); white-space: pre-wrap; overflow-wrap: anywhere; }
.pm-model-field { font-size: 12px; }
.pm-model-field-label { margin-right: 8px; color: var(--pm-text-2); }
.pm-model-body del { color: var(--pm-text-2); text-decoration-color: var(--pm-text-2); background: var(--pm-hover); }
.pm-model-body ins { text-decoration: none; background: var(--pm-hover); box-shadow: inset 0 -1px 0 var(--pm-text); }
.pm-model-stat { margin: 0; font-size: 12px; line-height: 1.5; color: var(--pm-text-2); font-variant-numeric: tabular-nums; }
`
