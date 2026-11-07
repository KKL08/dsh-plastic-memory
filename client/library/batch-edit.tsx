/**
 * 「整理所选」的工作区：记忆查看多选后点「整理所选…」，列表换成这一块（页头、状态条、三段切换照旧）。
 * 标题「整理所选的 N 条」，右上「返回列表」（回到多选，勾选保留），下面步骤条「写要求 / 看计划 / 对照应用」。
 * 工作区拿的是点下那一刻的卡片快照（含作用域和版本），之后视图刷新不改它：各步按快照显示原文，命令带快照里的版本核对。
 * 写要求：已选清单（可移出）+ 要求框（四个多条快捷意图），发 plan-edits（只读）。看计划：模型的理解、每条一个动作和理由，
 * 改动项可取消勾选（取消承接的改写时依赖它的删除一起取消），改写项下的提问可回答；计划不写入任何东西。
 * 「停止」只是不再等：之后到达的结果按请求序号认出来丢掉，回到写要求，输入保留。
 */
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { scopeOfMemory, type EditPlan, type MemoryCard, type MemoryCommand, type MemoryCommandResult, type PlanOp, type Scope } from '../../src/gui/contract.ts'
import { interpret, LLM_FAILURE_KEYS, refuseBeforeSend } from '../command/protocol.ts'
import { useGateway, type BorrowedSession } from '../gateway.ts'
import { useT, type Translate } from '../i18n.tsx'
import { baseOf } from '../pending/cards.tsx'
import { hintOf, RequestBox } from '../pending/model-edit.tsx'
import { Button } from '../ui/Button.tsx'
import { Chip } from '../ui/Chip.tsx'
import { Icon } from '../ui/Icon.tsx'
import { StatusMarker } from '../ui/StatusMarker.tsx'
import { BATCH_INTENTS } from './intents.ts'
import { useTypeLabel } from './shared.tsx'

/** 选中的一条：卡片快照，和命令里引用它的那一份（作用域、版本）。 */
export interface BatchItem {
  memory: MemoryCard
  ref: { memoryId: string; layer: Scope | undefined; base: { updatedAt: number; digest: string } }
}

export const toBatchItems = (memories: readonly MemoryCard[]): BatchItem[] =>
  memories.map(memory => ({ memory, ref: { memoryId: memory.id, layer: scopeOfMemory(memory), base: baseOf(memory) } }))

export const BATCH_STEPS = ['request', 'plan', 'apply'] as const
export type BatchStep = typeof BATCH_STEPS[number]

/** 步骤条：当前步加粗，之前的步前加「✓」。 */
export function BatchSteps({ current }: { current: BatchStep }) {
  const t = useT()
  const at = BATCH_STEPS.indexOf(current)
  return (
    <ol className="pm-batch-steps" aria-label={t('library.batch.steps')}>
      {BATCH_STEPS.map((step, i) => (
        <li
          key={step}
          className={['pm-batch-step', i === at ? 'pm-batch-step--current' : '', i < at ? 'pm-batch-step--done' : ''].filter(Boolean).join(' ')}
          aria-current={i === at ? 'step' : undefined}
        >
          {i < at ? <span aria-hidden="true">✓</span> : null}
          {t(`library.batch.step.${step}`)}
        </li>
      ))}
    </ol>
  )
}

type PlanCommand = Extract<MemoryCommand, { cmd: 'plan-edits' }>

/** 看计划时用户的选择，交给对照应用：勾上的改动项（改写、删除）和改写项提问的回答（没填的不在里面，按默认处理）。 */
export interface PlanChoice {
  request: string
  plan: EditPlan
  checked: readonly string[]
  answers: Readonly<Record<string, string>>
}

type Stage =
  | { kind: 'request'; error?: string }
  | { kind: 'planning' }
  | { kind: 'plan'; plan: EditPlan }
  | { kind: 'apply'; choice: PlanChoice }

const STEP_OF = { request: 'request', planning: 'plan', plan: 'plan', apply: 'apply' } as const satisfies Record<Stage['kind'], BatchStep>

function failureOf(command: MemoryCommand, r: Extract<MemoryCommandResult, { ok: false }>, t: Translate): string {
  if (r.code === 'llm-failed') return t(LLM_FAILURE_KEYS[r.code], { detail: r.detail ?? '' })
  const outcome = interpret(command, r)
  if (outcome.kind !== 'failed') return t('command.failed', { detail: r.detail ?? r.code })
  return outcome.isLocalized ? t(outcome.detail) : t('command.failed', { detail: outcome.detail })
}

export function BatchEdit({ items, session, onBack }: {
  items: readonly BatchItem[]
  session: BorrowedSession
  /** 回到多选，勾选保留。 */
  onBack: () => void
}) {
  const t = useT()
  const titleId = useId()
  const title = useRef<HTMLHeadingElement>(null)
  const gateway = useGateway()
  // 列表整块换掉了：焦点接到标题上，不掉到页面上
  useEffect(() => { title.current?.focus() }, [])
  /** 这次要整理的：起初是选中的全部，写要求时可以移出。 */
  const [picked, setPicked] = useState<readonly BatchItem[]>(items)
  const [request, setRequest] = useState('')
  const [stage, setStage] = useState<Stage>({ kind: 'request' })
  /** 正在等的那次请求的序号：停止、离开后序号前进，旧请求的结果对不上号就丢掉。 */
  const seq = useRef(0)
  useEffect(() => () => { seq.current += 1 }, [])

  const generate = () => {
    if (session.kind !== 'ready') return
    const text = request.trim()
    if (text === '' || picked.length < 2) return
    const command: PlanCommand = { cmd: 'plan-edits', memories: picked.map(item => item.ref), request: text }
    // 命令文本会进借用会话的日志：要求里有高危密钥就不发
    const refused = refuseBeforeSend(command)
    if (refused !== undefined) { setStage({ kind: 'request', error: refused.isLocalized ? t(refused.detail) : refused.detail }); return }
    const mine = ++seq.current
    setStage({ kind: 'planning' })
    void gateway.execute(session.sessionId, command).then((r) => {
      if (mine !== seq.current) return
      if (!r.ok) { setStage({ kind: 'request', error: failureOf(command, r, t) }); return }
      if (r.plan === undefined) { setStage({ kind: 'request', error: t('pending.model.invalid') }); return }
      setStage({ kind: 'plan', plan: r.plan })
    })
  }
  const stop = () => {
    seq.current += 1
    setStage({ kind: 'request' })
  }

  return (
    <section className="pm-batch" aria-labelledby={titleId}>
      <div className="pm-batch-head">
        <h3 ref={title} id={titleId} className="pm-batch-title" tabIndex={-1}>{t('library.batch.title', { n: picked.length })}</h3>
        <Button variant="ghost" onClick={onBack}>{t('library.batch.back')}</Button>
      </div>
      <BatchSteps current={STEP_OF[stage.kind]} />
      {stage.kind === 'request'
        ? (
          <RequestStep
            session={session}
            picked={picked}
            onUnpick={(id) => { setPicked(prev => prev.filter(item => item.memory.id !== id)) }}
            request={request}
            onRequest={setRequest}
            error={stage.error}
            onCancel={onBack}
            onGenerate={generate}
          />
        )
        : stage.kind === 'planning'
          ? (
            <div className="pm-model-busy" role="status">
              <span className="pm-model-dot" aria-hidden="true" />
              <span>{t('library.batch.planning')}</span>
              <Button variant="ghost" onClick={stop}>{t('pending.model.stop')}</Button>
            </div>
          )
          : stage.kind === 'plan'
            ? (
              <PlanStep
                plan={stage.plan}
                picked={picked}
                onRevise={() => { setStage({ kind: 'request' }) }}
                onConfirm={(checked, answers) => { setStage({ kind: 'apply', choice: { request: request.trim(), plan: stage.plan, checked, answers } }) }}
              />
            )
            : null}
    </section>
  )
}

/** 写要求：已选清单（类型 + 单行原文 + 「✕」移出）、要求框、说明、「取消」「生成整理计划」。 */
function RequestStep({ session, picked, onUnpick, request, onRequest, error, onCancel, onGenerate }: {
  session: BorrowedSession
  picked: readonly BatchItem[]
  onUnpick: (memoryId: string) => void
  request: string
  onRequest: (value: string) => void
  error: string | undefined
  onCancel: () => void
  onGenerate: () => void
}) {
  const t = useT()
  const id = useId()
  const gateway = useGateway()
  const model = gateway.useModel(session)
  const typeLabel = useTypeLabel(session)
  const list = useRef<HTMLUListElement>(null)
  /** 刚移出的那条原来的位置：渲染完把焦点交给接上来的那条（或上一条）的「✕」。 */
  const removedAt = useRef<number>()
  useLayoutEffect(() => {
    const at = removedAt.current
    if (at === undefined) return
    removedAt.current = undefined
    const buttons = list.current?.querySelectorAll<HTMLElement>('.pm-batch-unpick') ?? []
    buttons[Math.min(at, buttons.length - 1)]?.focus()
  }, [picked])
  const isMissing = request.trim() === ''
  const blocked = model.status === 'unavailable' ? t('pending.model.unavailable')
    : picked.length < 2 ? t('library.select.tooFew') : isMissing ? t('library.model.empty') : undefined
  return (
    <>
      <section className="pm-batch-picked" aria-label={t('library.batch.picked')}>
        <ul ref={list} className="pm-batch-picked-list">
          {picked.map((item, index) => (
            <li key={item.memory.id} className="pm-batch-picked-row">
              <Chip variant="neutral">{typeLabel(item.memory.type)}</Chip>
              <span className="pm-batch-picked-text">{item.memory.content}</span>
              <Button
                variant="icon"
                className="pm-batch-unpick"
                aria-label={t('library.batch.unpick', { name: item.memory.name })}
                title={t('library.batch.unpickHint')}
                onClick={() => { removedAt.current = index; onUnpick(item.memory.id) }}
              >
                <span aria-hidden="true">✕</span>
              </Button>
            </li>
          ))}
        </ul>
        <p className="pm-batch-picked-count">{t('library.batch.count', { n: picked.length })}</p>
      </section>
      <div className="pm-edit">
        <RequestBox
          id={id}
          label={t('library.batch.ask')}
          value={request}
          onChange={onRequest}
          intents={BATCH_INTENTS}
          placeholder={t('library.batch.placeholder')}
        />
        <p className="pm-model-note"><Icon name="info" size={14} /><span>{t('library.batch.note')}</span></p>
        {error !== undefined ? <p className="pm-pending-error" role="alert">{error}</p> : null}
        <div className="pm-edit-foot">
          <span className="pm-edit-hint">{isMissing && model.status !== 'unavailable' ? t('library.model.empty') : hintOf(model, t)}</span>
          <Button variant="ghost" onClick={onCancel}>{t('pending.cancel')}</Button>
          <Button variant="primary" unavailable={blocked} onClick={onGenerate}>{t('library.batch.generate')}</Button>
        </div>
      </div>
    </>
  )
}

/**
 * 看计划：模型的理解，每条一项（动作标签 + 原文，下一行理由；删除项注明内容并入哪条）。改动项默认勾上，不动项置灰。
 * 取消某个改写项时，内容要并进它的删除项一起取消并提示；重新勾上改写，删除项不自动勾回，由用户自己决定。
 */
function PlanStep({ plan, picked, onRevise, onConfirm }: {
  plan: EditPlan
  picked: readonly BatchItem[]
  onRevise: () => void
  onConfirm: (checked: string[], answers: Record<string, string>) => void
}) {
  const t = useT()
  const id = useId()
  const nameOf = (memoryId: string) => picked.find(item => item.memory.id === memoryId)?.memory.name ?? memoryId
  const [checked, setChecked] = useState<ReadonlySet<string>>(() => new Set(plan.ops.filter(op => op.action !== 'keep').map(op => op.memoryId)))
  /** 因承接的改写取消而跟着取消的删除项：下面写明原因。 */
  const [held, setHeld] = useState<ReadonlySet<string>>(new Set())
  const [answers, setAnswers] = useState<Readonly<Record<string, string>>>({})
  const dependents = (op: PlanOp) => plan.ops.filter(d => d.action === 'delete' && d.into === op.memoryId).map(d => d.memoryId)
  const toggle = (op: PlanOp) => {
    const isOn = !checked.has(op.memoryId)
    const next = new Set(checked)
    const nextHeld = new Set(held)
    if (isOn) next.add(op.memoryId)
    else next.delete(op.memoryId)
    nextHeld.delete(op.memoryId)
    if (op.action === 'rewrite') {
      for (const d of dependents(op)) {
        if (!isOn && next.delete(d)) nextHeld.add(d)
        if (isOn) nextHeld.delete(d)
      }
    }
    setChecked(next)
    setHeld(nextHeld)
  }
  const chosen = plan.ops.filter(op => op.action !== 'keep' && checked.has(op.memoryId))
  const isDeleteOnly = chosen.length > 0 && chosen.every(op => op.action === 'delete')
  const confirm = () => {
    const ids = chosen.map(op => op.memoryId)
    const replies = Object.fromEntries(Object.entries(answers).map(([k, v]) => [k, v.trim()]).filter(([k, v]) => v !== '' && ids.includes(k)))
    onConfirm(ids, replies)
  }
  return (
    <>
      <section className="pm-plan-understanding" aria-labelledby={`${id}-understanding`}>
        <h4 id={`${id}-understanding`} className="pm-plan-understanding-title">{t('library.batch.understanding')}</h4>
        <p className="pm-plan-understanding-text">{plan.understanding}</p>
      </section>
      <ul className="pm-plan-ops" aria-label={t('library.batch.ops')}>
        {plan.ops.map((op, index) => {
          const item = picked.find(i => i.memory.id === op.memoryId)
          const action = t(`library.batch.action.${op.action}`)
          const questionId = `${id}-q${index}`
          return (
            <li key={op.memoryId} className={['pm-plan-op', op.action === 'keep' ? 'pm-plan-op--keep' : ''].filter(Boolean).join(' ')}>
              <input
                type="checkbox"
                className="pm-plan-check"
                aria-label={t('library.batch.op', { action, name: nameOf(op.memoryId) })}
                checked={op.action !== 'keep' && checked.has(op.memoryId)}
                disabled={op.action === 'keep'}
                onChange={() => { toggle(op) }}
              />
              <div className="pm-plan-op-body">
                <p className="pm-plan-op-head">
                  <span className="pm-plan-action">{action}</span>
                  <span className="pm-plan-op-text">{item?.memory.content ?? op.memoryId}</span>
                </p>
                <p className="pm-plan-reason">
                  {op.reason}
                  {op.into !== undefined ? <>{' '}<span className="pm-plan-into">{t('library.batch.into', { name: nameOf(op.into) })}</span></> : null}
                </p>
                {held.has(op.memoryId) ? <p className="pm-plan-held">{t('library.batch.held')}</p> : null}
                {op.action === 'rewrite' && op.question !== undefined
                  ? (
                    <div className="pm-plan-ask">
                      <p className="pm-plan-question">
                        <StatusMarker kind="pending" />
                        <span>{t('library.batch.decide')}<span id={questionId}>{op.question.text}</span></span>
                      </p>
                      <input
                        type="text"
                        className="pm-edit-input"
                        aria-labelledby={questionId}
                        placeholder={op.question.placeholder}
                        value={answers[op.memoryId] ?? ''}
                        onChange={(event) => { const value = event.target.value; setAnswers(prev => ({ ...prev, [op.memoryId]: value })) }}
                      />
                    </div>
                  )
                  : null}
              </div>
            </li>
          )
        })}
      </ul>
      <div className="pm-edit-foot pm-plan-foot">
        <span className="pm-edit-hint">{t('library.batch.summary', { changes: chosen.length, keeps: plan.ops.length - chosen.length })}</span>
        <Button variant="ghost" onClick={onRevise}>{t('library.batch.revise')}</Button>
        <Button variant="primary" unavailable={chosen.length === 0 ? t('library.batch.noChange') : undefined} onClick={confirm}>
          {t(isDeleteOnly ? 'library.batch.next' : 'library.batch.draft')}
        </Button>
      </div>
    </>
  )
}

export const batchEditCss = `
.pm-batch { display: flex; flex-direction: column; gap: 16px; }
.pm-batch-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.pm-batch-title { margin: 0; font-size: 14px; font-weight: 600; line-height: 1.5; color: var(--pm-text); outline: none; }
.pm-batch-steps { display: flex; flex-wrap: wrap; gap: 6px 20px; margin: 0; padding: 0; list-style: none; font-size: 12px; line-height: 1.5; color: var(--pm-text-2); }
.pm-batch-step { display: inline-flex; gap: 4px; }
.pm-batch-step--current { font-weight: 600; color: var(--pm-text); }
.pm-batch-picked { display: flex; flex-direction: column; gap: 2px; padding: 6px; border-radius: var(--dsw-radius-md, 12px); background: var(--pm-bg-block); }
.pm-batch-picked-list { display: flex; flex-direction: column; gap: 2px; margin: 0; padding: 0; list-style: none; }
.pm-batch-picked-row { display: flex; align-items: center; gap: 8px; min-width: 0; padding: 3px 4px 3px 8px; font-size: 13px; line-height: 1.5; color: var(--pm-text); }
.pm-batch-picked-text, .pm-plan-op-text { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.pm-batch-picked-count { margin: 0; padding: 2px 8px 4px; font-size: 12px; line-height: 1.5; color: var(--pm-text-2); font-variant-numeric: tabular-nums; }
.pm-plan-understanding { display: flex; flex-direction: column; gap: 2px; padding: 10px 12px; border-radius: var(--dsw-radius-md, 12px); background: var(--pm-bg-block); }
.pm-plan-understanding-title { margin: 0; font-size: 12px; font-weight: 600; line-height: 1.5; color: var(--pm-text-2); }
.pm-plan-understanding-text { margin: 0; font-size: 13px; line-height: 1.6; color: var(--pm-text); }
.pm-plan-ops { display: flex; flex-direction: column; margin: 0; padding: 0; list-style: none; }
.pm-plan-op { display: flex; gap: 10px; padding: 12px 0; }
.pm-plan-op + .pm-plan-op { border-top: .5px solid var(--pm-line); }
.pm-plan-check { flex-shrink: 0; align-self: flex-start; margin: 4px 0 0; accent-color: var(--pm-text); }
.pm-plan-op-body { display: flex; flex-direction: column; gap: 3px; flex: 1; min-width: 0; }
.pm-plan-op-head { display: flex; align-items: center; gap: 8px; min-width: 0; margin: 0; font-size: 13px; line-height: 1.5; color: var(--pm-text); }
.pm-plan-action {
  flex-shrink: 0; padding: 1px 8px; border-radius: 6px; background: var(--pm-bg-block);
  font-size: 12px; font-weight: 600; line-height: 18px; color: var(--pm-text);
}
.pm-plan-op--keep .pm-plan-op-head { color: var(--pm-text-2); }
.pm-plan-reason, .pm-plan-held { margin: 0; font-size: 12px; line-height: 1.5; color: var(--pm-text-2); }
.pm-plan-held { color: var(--pm-text); }
.pm-plan-ask { display: flex; flex-direction: column; gap: 6px; margin-top: 6px; padding: 8px 10px; border-radius: var(--dsw-radius-sm, 8px); background: var(--pm-bg-block); }
.pm-plan-question { display: flex; align-items: baseline; gap: 6px; margin: 0; font-size: 12px; line-height: 1.5; color: var(--pm-text); }
.pm-plan-question .pm-marker { align-self: center; }
.pm-plan-foot { padding-top: 12px; border-top: .5px solid var(--pm-line); }
`
