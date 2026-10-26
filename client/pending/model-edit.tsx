/**
 * 建议整理卡里的「让模型改 / 让模型合并」：写一句要求（可不写）→ 借来的会话的模型生成一稿 → 原文与改后左右对照 → 点「应用」才写入。
 * 生成发 draft-edit（只读，结果只在这个组件的内存里）；应用交回卡片，按直接改、直接合并发 edit-memory / merge-memories，
 * 之后的结果行、撤销都和直接改一样。生成中只锁这张卡。
 * 「停止」只是不再等：命令没法从界面取消，之后到达的结果按请求序号认出来丢掉。
 */
import { diffWords, type Change } from 'diff'
import { Fragment, useEffect, useId, useRef, useState } from 'react'
import { layerOfMemory, type MemoryCard, type MemoryCommand, type MemoryCommandResult, type ModelEditAdviceType } from '../../src/gui/contract.ts'
import { useGateway, type BorrowedSession } from '../gateway.ts'
import { formatNumber, useT, type Translate } from '../i18n.tsx'
import { Button } from '../ui/Button.tsx'
import { keepFocusInPlace, useReturnFocus } from '../ui/focus-return.ts'
import type { EditDraft } from './edit.tsx'

type DraftCommand = Extract<MemoryCommand, { cmd: 'draft-edit' }>

type Phase =
  | { kind: 'ask'; error?: string }
  | { kind: 'busy' }
  | { kind: 'result'; draft: EditDraft }

/** 按中文词切分后对照：只用在单条记忆上，合并只并排不高亮。 */
const segmenter = new Intl.Segmenter('zh', { granularity: 'word' })
const diffOf = (before: string, after: string) => diffWords(before, after, { intlSegmenter: segmenter })

function failureOf(r: Extract<MemoryCommandResult, { ok: false }>, t: Translate): string {
  switch (r.code) {
    case 'llm-unavailable': return t('pending.model.unavailable')
    case 'llm-failed': return t('pending.model.failed', { detail: r.detail ?? '' })
    case 'llm-invalid-output': return t('pending.model.invalid')
    default: return t('pending.failed', { detail: r.detail ?? r.code })
  }
}

export function ModelEditPanel({ memories, adviceType, typeTitle, base, keeper, session, model, unavailable, onClose, onApply }: {
  /** 一条，或合并时两条（卡片上的左右顺序）。 */
  memories: readonly [MemoryCard] | readonly [MemoryCard, MemoryCard]
  adviceType: ModelEditAdviceType
  /** 建议类型的标题，写进输入框的说明。 */
  typeTitle: string
  /** 模型没改名称、标签时沿用的值，也是对照里原来的名称、摘要、标签：单条是它自己，合并是直接合并的预填。 */
  base: EditDraft
  /** 合并时保留哪条（mergeKeeperIndex）。 */
  keeper?: 0 | 1
  session: BorrowedSession
  /** 借来的会话的模型名；拿不到名字时提示只写后半句。 */
  model: string | undefined
  /** 卡片的忙状态（应用中、等确认）。 */
  unavailable: string | undefined
  onClose: () => void
  onApply: (draft: EditDraft) => void
}) {
  const t = useT()
  const id = useId()
  const gateway = useGateway()
  const [phase, setPhase] = useState<Phase>({ kind: 'ask' })
  const [request, setRequest] = useState('')
  /** 「再改改」的起点。 */
  const [previous, setPrevious] = useState<EditDraft | undefined>(undefined)
  /** 正在等的那次请求的序号：停止、收起后序号前进，旧请求的结果对不上号就丢掉。 */
  const seq = useRef(0)
  useEffect(() => () => { seq.current += 1 }, [])
  const root = useRef<HTMLDivElement>(null)
  useReturnFocus(root)

  const generate = () => {
    if (session.kind !== 'ready') return
    const mine = ++seq.current
    const text = request.trim()
    const command: DraftCommand = {
      cmd: 'draft-edit',
      adviceType,
      memories: memories.map(m => ({ memoryId: m.id, layer: layerOfMemory(m) })) as DraftCommand['memories'],
      ...(text !== '' ? { request: text } : {}),
      ...(previous !== undefined ? { previous } : {}),
    }
    keepFocusInPlace()
    setPhase({ kind: 'busy' })
    void gateway.execute(session.sessionId, command).then((r) => {
      if (mine !== seq.current) return
      if (!r.ok) { setPhase({ kind: 'ask', error: failureOf(r, t) }); return }
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
        <div className="pm-model-busy" role="status">
          <span className="pm-model-dot" aria-hidden="true" />
          <span>{t('pending.model.busy')}</span>
          <Button variant="ghost" onClick={stop}>{t('pending.model.stop')}</Button>
        </div>
      </div>
    )
  }

  if (phase.kind === 'ask') {
    return (
      <div ref={root} className="pm-edit">
        <label className="pm-edit-label" htmlFor={`${id}-ask`}>{t('pending.model.ask', { type: typeTitle })}</label>
        <textarea
          id={`${id}-ask`}
          className="pm-edit-input pm-model-ask"
          value={request}
          autoFocus
          onChange={(event) => { setRequest(event.target.value) }}
        />
        {phase.error !== undefined ? <p className="pm-pending-error" role="alert">{phase.error}</p> : null}
        <div className="pm-edit-foot">
          <span className="pm-edit-hint">{model !== undefined ? t('pending.model.hint', { model }) : t('pending.model.hintNoName')}</span>
          <Button variant="ghost" unavailable={unavailable} onClick={onClose}>{t('pending.cancel')}</Button>
          <Button variant="primary" unavailable={unavailable} onClick={generate}>{t('pending.model.generate')}</Button>
        </div>
      </div>
    )
  }

  const { draft } = phase
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
    <div ref={root} className="pm-edit pm-model-result">
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
      <div className="pm-edit-foot">
        <span className="pm-edit-hint" />
        <Button variant="ghost" unavailable={unavailable} onClick={onClose}>{t('pending.model.discard')}</Button>
        <Button
          unavailable={unavailable}
          onClick={() => { setPrevious(draft); setRequest(''); setPhase({ kind: 'ask' }) }}
        >
          {t('pending.model.again')}
        </Button>
        <Button variant="primary" unavailable={unavailable} onClick={() => { onApply(draft) }}>{t('pending.model.apply')}</Button>
      </div>
    </div>
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
.pm-model-busy { display: flex; align-items: center; gap: 10px; font-size: 13px; line-height: 1.5; color: var(--pm-text-2); }
.pm-model-busy .pm-btn { margin-left: auto; }
.pm-model-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--pm-accent); animation: pm-model-pulse 1.2s ease-in-out infinite; }
@keyframes pm-model-pulse { 0%, 100% { opacity: .3; } 50% { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .pm-model-dot { animation: none; } }
.pm-model-result { container-type: inline-size; }
.pm-model-compare { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
@container (max-width: 520px) { .pm-model-compare { grid-template-columns: minmax(0, 1fr); } }
.pm-model-pane { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.pm-model-pane-title { margin: 0; font-size: 12px; font-weight: 500; line-height: 1.5; color: var(--pm-text-3); }
.pm-model-body {
  display: flex; flex-direction: column; gap: 6px; padding: 10px 12px; border-radius: var(--dsw-radius-sm, 8px);
  background: var(--pm-bg); border: .5px solid var(--pm-line-card);
}
.pm-model-text, .pm-model-field { margin: 0; font-size: 13px; line-height: 1.6; color: var(--pm-text); white-space: pre-wrap; overflow-wrap: anywhere; }
.pm-model-field { font-size: 12px; }
.pm-model-field-label { margin-right: 8px; color: var(--pm-text-3); }
.pm-model-body del { color: var(--pm-text-3); text-decoration-color: var(--pm-text-3); background: var(--pm-hover); }
.pm-model-body ins { text-decoration: none; background: var(--pm-accent-tint); box-shadow: inset 0 -1px 0 var(--pm-accent-soft); }
.pm-model-stat { margin: 0; font-size: 12px; line-height: 1.5; color: var(--pm-text-3); font-variant-numeric: tabular-nums; }
`
