/**
 * 「整理所选」的工作区：记忆查看多选后点「整理所选…」，列表换成这一块（页头、状态条、三段切换照旧）。
 * 标题「整理所选的 N 条」，右上「返回列表」（回到多选，勾选保留），下面步骤条「写要求 / 看计划 / 对照应用」。
 * 工作区拿的是点下那一刻的卡片快照（含作用域和版本），之后视图刷新不改它：各步按快照显示原文，命令带快照里的版本核对。
 * 写要求：已选清单（可移出）+ 要求框（四个多条快捷意图），发 plan-edits（只读）。看计划：模型的理解、每条一个动作和理由，
 * 改动项可取消勾选（取消承接的改写时依赖它的删除一起取消），改写项下的提问可回答；计划不写入任何东西。
 * 对照应用：勾选的改写项一次发 draft-plan（只读）出稿，全是删除时不发；逐项对照，单项可「再改改」（draft-edit）或放弃，
 * 「应用全部」把最终改动交给 onApply；有删除项时先原位换成确认条「其中 a 项会删除「…」，确认应用？」。「停止」只是不再等：之后到达的结果按请求序号认出来丢掉，回到上一步，输入保留。
 * 任一步回 stale、not-found（选中的记忆被别处改过或删了）：顶部提示有几条刚被改过，回到写要求、要求保留；已选清单等视图里这几条的版本
 * 和旧 base 不同（或已不在）再换成最新内容、移出已删的，视图没到时清单显示「正在换成最新内容……」、「生成整理计划」置灰。
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import {
  scopeOfMemory, type DraftPlanOp, type EditPlan, type MemoryCard, type MemoryCommand, type MemoryCommandResult, type PlanOp, type Scope,
} from '../../src/gui/contract.ts'
import { SoftDeleteConfirm } from '../command/confirm.tsx'
import { interpret, LLM_FAILURE_KEYS, refuseBeforeSend } from '../command/protocol.ts'
import { useGateway, type BorrowedSession } from '../gateway.ts'
import { useT, type Translate } from '../i18n.tsx'
import { baseOf, isEditable } from '../pending/cards.tsx'
import type { EditDraft } from '../pending/edit.tsx'
import { DraftCompare, hintOf, RequestBox } from '../pending/model-edit.tsx'
import { Button } from '../ui/Button.tsx'
import { Chip } from '../ui/Chip.tsx'
import { Icon } from '../ui/Icon.tsx'
import { StatusMarker } from '../ui/StatusMarker.tsx'
import { BATCH_INTENTS, SINGLE_INTENTS } from './intents.ts'
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
type DraftPlanCommand = Extract<MemoryCommand, { cmd: 'draft-plan' }>
type DraftCommand = Extract<MemoryCommand, { cmd: 'draft-edit' }>

/** 看计划时用户的选择，交给对照应用：勾上的改动项（改写、删除）和改写项提问的回答（没填的不在里面，按默认处理）。 */
export interface PlanChoice {
  request: string
  plan: EditPlan
  checked: readonly string[]
  answers: Readonly<Record<string, string>>
}

/** 命令里引用一条选中记忆的那一份（作用域、版本）。 */
export type BatchRef = BatchItem['ref']
/** 对照完要应用的一项：改写带四个面，删除带承接它内容的那条（计划里的 into）。 */
export type BatchApplyOp = ({ kind: 'edit' } & BatchRef & EditDraft) | ({ kind: 'forget'; into?: string } & BatchRef)
/**
 * 「应用全部」交出的最终改动：ops 按计划顺序、不含放弃的项；keep 是删除承接到、但这次不写的记忆，只用来核对版本。
 * total 是这次整理的条数（写要求时移出的不算），结果条用它算「没动」的条数。
 */
export interface BatchApplication {
  ops: BatchApplyOp[]
  keep: BatchRef[]
  total: number
}

/** 勾选的改动项，按计划顺序。 */
const chosenOps = (choice: PlanChoice) => choice.plan.ops.filter(op => op.action !== 'keep' && choice.checked.includes(op.memoryId))

/** 对照后的最终改动：勾选且没放弃的项；承接它的改写不在这批里的删除项不交出去（独有的信息没有去处）；计划里不动的承接项进 keep。 */
export function applicationOf(choice: PlanChoice, picked: readonly BatchItem[], drafts: Readonly<Record<string, EditDraft>>, dropped: ReadonlySet<string>): BatchApplication {
  const refOf = (memoryId: string) => picked.find(item => item.memory.id === memoryId)!.ref
  const live = chosenOps(choice).filter(op => !dropped.has(op.memoryId))
  const kept = live.filter(op => !isOrphanDelete(op, choice.plan.ops, new Set(live.map(o => o.memoryId))))
  const ops = kept.map((op): BatchApplyOp => (op.action === 'rewrite'
    ? { kind: 'edit', ...refOf(op.memoryId), ...drafts[op.memoryId]! }
    : { kind: 'forget', ...refOf(op.memoryId), ...(op.into !== undefined ? { into: op.into } : {}) }))
  const edited = new Set(kept.filter(op => op.action === 'rewrite').map(op => op.memoryId))
  const intos = new Set(kept.flatMap(op => (op.action === 'delete' && op.into !== undefined && !edited.has(op.into) ? [op.into] : [])))
  return { ops, keep: choice.plan.ops.filter(op => op.action === 'keep' && intos.has(op.memoryId)).map(op => refOf(op.memoryId)), total: picked.length }
}

/** 删除项承接到计划里的改写、而那条改写这次不做（没勾或放弃了）：单独删掉它，独有的信息就丢了。 */
function isOrphanDelete(op: PlanOp, planOps: readonly PlanOp[], active: ReadonlySet<string>): boolean {
  return op.action === 'delete' && op.into !== undefined && !active.has(op.into)
    && planOps.some(o => o.memoryId === op.into && o.action === 'rewrite')
}

/** 勾选的改写项交给 draft-plan 的样子：理由、提问、回答（没填不带），并进它、也勾上了的删除项作承接。 */
function draftOpsOf(choice: PlanChoice): DraftPlanOp[] {
  const chosen = chosenOps(choice)
  return chosen.filter(op => op.action === 'rewrite').map((op) => {
    const absorbs = chosen.filter(d => d.action === 'delete' && d.into === op.memoryId).map(d => d.memoryId)
    const answer = choice.answers[op.memoryId]
    return {
      memoryId: op.memoryId, reason: op.reason,
      ...(op.question !== undefined ? { question: op.question } : {}),
      ...(answer !== undefined ? { answer } : {}),
      ...(absorbs.length > 0 ? { absorbs } : {}),
    }
  })
}

/** 模型给的一稿补全成四个面：没改的名称、标签沿用 fallback（第一稿是原记忆，再改改是上一稿）。 */
const fillDraft = (draft: { content: string; summary: string; name?: string | undefined; tags?: string[] | undefined }, fallback: { name: string; tags: readonly string[] }): EditDraft =>
  ({ content: draft.content, summary: draft.summary, name: draft.name ?? fallback.name, tags: draft.tags ?? [...fallback.tags] })

type Stage =
  | { kind: 'request'; error?: string }
  | { kind: 'planning' }
  /** choice：从出稿退回来时用户的勾选和回答。 */
  | { kind: 'plan'; plan: EditPlan; choice?: PlanChoice; error?: string }
  | { kind: 'drafting'; choice: PlanChoice }
  | { kind: 'apply'; choice: PlanChoice; drafts: Readonly<Record<string, EditDraft>> }

const STEP_OF = { request: 'request', planning: 'plan', plan: 'plan', drafting: 'apply', apply: 'apply' } as const satisfies Record<Stage['kind'], BatchStep>

function failureOf(command: MemoryCommand, r: Extract<MemoryCommandResult, { ok: false }>, t: Translate): string {
  if (r.code === 'llm-failed') return t(LLM_FAILURE_KEYS[r.code], { detail: r.detail ?? '' })
  const outcome = interpret(command, r)
  if (outcome.kind !== 'failed') return t('command.failed', { detail: r.detail ?? r.code })
  return outcome.isLocalized ? t(outcome.detail) : t('command.failed', { detail: outcome.detail })
}

export function BatchEdit({ items, latest, session, onBack, onApply, applyUnavailable, applyFeedback }: {
  items: readonly BatchItem[]
  /** 视图里此刻的记忆（视图没到时缺省）：有记忆刚被别处改过时，等这几条换成新版本再重建清单。 */
  latest?: readonly MemoryCard[] | undefined
  session: BorrowedSession
  /** 回到多选，勾选保留。 */
  onBack: () => void
  /**
   * 「应用全部」：对照后的最终改动，和此刻清单里的各条（换成最新内容重建过的话是重建后的版本，结果条按它比版本）。
   * 应用回 stale、not-found 时调用方把对不上的那几条交给 onBehind。
   */
  onApply?: (application: BatchApplication, picked: readonly BatchItem[], onBehind: (memoryIds: readonly string[]) => void) => void
  /** 「应用全部」暂不可用的原因（没有会话、正在应用或等确认）。 */
  applyUnavailable?: string | undefined
  /** 应用的确认与失败，画在底部按钮下。 */
  applyFeedback?: ReactNode
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
  /** 刚被别处改过或删了的那几条和它们的旧版本：视图里换成新版本（或已不在）之前，清单不重建。 */
  const [refreshing, setRefreshing] = useState<ReadonlyMap<string, BatchRef['base']>>()
  /** 顶部提示：有几条刚被改过。重新生成计划时收起。 */
  const [behindCount, setBehindCount] = useState<number>()
  useEffect(() => {
    if (refreshing === undefined || latest === undefined) return
    const fresh = new Map(latest.map(m => [m.id, m]))
    const isArrived = [...refreshing].every(([id, base]) => {
      const m = fresh.get(id)
      return m === undefined || baseOf(m).updatedAt !== base.updatedAt || baseOf(m).digest !== base.digest
    })
    if (!isArrived) return
    // 换成最新原文；已删的、变得不能整理的（写进了密钥、读不到版本）移出清单
    setPicked(prev => prev.flatMap((item) => {
      if (!refreshing.has(item.memory.id)) return [item]
      const m = fresh.get(item.memory.id)
      return m !== undefined && isEditable(m) ? toBatchItems([m]) : []
    }))
    setRefreshing(undefined)
  }, [latest, refreshing])
  /** 选中的记忆被别处改过或删了：在等的作废，回到写要求（要求保留），等视图把这几条换成最新内容。 */
  const behind = (memoryIds: readonly string[]) => {
    seq.current += 1
    const waiting = new Map(picked.filter(item => memoryIds.includes(item.memory.id)).map(item => [item.memory.id, item.ref.base]))
    setRefreshing(waiting.size > 0 ? waiting : undefined)
    setBehindCount(memoryIds.length)
    setStage({ kind: 'request' })
  }
  /** 失败是 stale、not-found 且说得出是哪几条：按 behind 处理。返回是否这样处理了。 */
  const isBehind = (r: Extract<MemoryCommandResult, { ok: false }>) => {
    if ((r.code !== 'stale' && r.code !== 'not-found') || r.memoryIds === undefined || r.memoryIds.length === 0) return false
    behind(r.memoryIds)
    return true
  }

  const generate = () => {
    if (session.kind !== 'ready' || refreshing !== undefined) return
    const text = request.trim()
    if (text === '' || picked.length < 2) return
    const command: PlanCommand = { cmd: 'plan-edits', memories: picked.map(item => item.ref), request: text }
    // 命令文本会进借用会话的日志：要求里有高危密钥就不发
    const refused = refuseBeforeSend(command)
    if (refused !== undefined) { setStage({ kind: 'request', error: refused.isLocalized ? t(refused.detail) : refused.detail }); return }
    const mine = ++seq.current
    setBehindCount(undefined)
    setStage({ kind: 'planning' })
    void gateway.execute(session.sessionId, command).then((r) => {
      if (mine !== seq.current) return
      if (!r.ok) { if (!isBehind(r)) setStage({ kind: 'request', error: failureOf(command, r, t) }); return }
      if (r.plan === undefined) { setStage({ kind: 'request', error: t('pending.model.invalid') }); return }
      setStage({ kind: 'plan', plan: r.plan })
    })
  }
  const stop = () => {
    seq.current += 1
    setStage({ kind: 'request' })
  }
  /** 按计划出稿：勾选的改写项一次出稿；全是删除时不调模型，直接进对照。 */
  const draftFromPlan = (choice: PlanChoice) => {
    const ops = draftOpsOf(choice)
    if (ops.length === 0) { setStage({ kind: 'apply', choice, drafts: {} }); return }
    if (session.kind !== 'ready') return
    const back = (error: string) => { setStage({ kind: 'plan', plan: choice.plan, choice, error }) }
    const command: DraftPlanCommand = { cmd: 'draft-plan', memories: picked.map(item => item.ref), request: choice.request, ops }
    // 要求、理由、提问和回答都进命令文本：有高危密钥就不发
    const refused = refuseBeforeSend(command)
    if (refused !== undefined) { back(refused.isLocalized ? t(refused.detail) : refused.detail); return }
    const mine = ++seq.current
    setStage({ kind: 'drafting', choice })
    void gateway.execute(session.sessionId, command).then((r) => {
      if (mine !== seq.current) return
      if (!r.ok) { if (!isBehind(r)) back(failureOf(command, r, t)); return }
      const drafts: Record<string, EditDraft> = {}
      for (const { memoryId, draft } of r.drafts ?? []) {
        const memory = picked.find(item => item.memory.id === memoryId)?.memory
        if (memory !== undefined) drafts[memoryId] = fillDraft(draft, memory)
      }
      if (ops.some(op => drafts[op.memoryId] === undefined)) { back(t('pending.model.invalid')); return }
      setStage({ kind: 'apply', choice, drafts })
    })
  }
  const stopDrafting = (choice: PlanChoice) => {
    seq.current += 1
    setStage({ kind: 'plan', plan: choice.plan, choice })
  }

  return (
    <section className="pm-batch" aria-labelledby={titleId}>
      <div className="pm-batch-head">
        <h3 ref={title} id={titleId} className="pm-batch-title" tabIndex={-1}>{t('library.batch.title', { n: picked.length })}</h3>
        <Button variant="ghost" onClick={onBack}>{t('library.batch.back')}</Button>
      </div>
      <BatchSteps current={STEP_OF[stage.kind]} />
      {behindCount !== undefined ? <p className="pm-notice" role="status">{t('library.batch.behind', { n: behindCount })}</p> : null}
      {stage.kind === 'request'
        ? (
          <RequestStep
            session={session}
            picked={picked}
            isRefreshing={refreshing !== undefined}
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
                initial={stage.choice}
                error={stage.error}
                picked={picked}
                onRevise={() => { setStage({ kind: 'request' }) }}
                onConfirm={(checked, answers) => { draftFromPlan({ request: request.trim(), plan: stage.plan, checked, answers }) }}
              />
            )
            : stage.kind === 'drafting'
              ? (
                <div className="pm-model-busy" role="status">
                  <span className="pm-model-dot" aria-hidden="true" />
                  <span>{t('library.batch.drafting')}</span>
                  <Button variant="ghost" onClick={() => { stopDrafting(stage.choice) }}>{t('pending.model.stop')}</Button>
                </div>
              )
              : (
                <ApplyStep
                  session={session}
                  choice={stage.choice}
                  picked={picked}
                  drafts={stage.drafts}
                  onDiscardAll={onBack}
                  onApply={onApply === undefined ? undefined : (application) => { onApply(application, picked, behind) }}
                  onBehind={behind}
                  unavailable={applyUnavailable}
                  feedback={applyFeedback}
                />
              )}
    </section>
  )
}

/** 写要求：已选清单（类型 + 单行原文 + 「✕」移出）、要求框、说明、「取消」「生成整理计划」。 */
function RequestStep({ session, picked, isRefreshing, onUnpick, request, onRequest, error, onCancel, onGenerate }: {
  session: BorrowedSession
  picked: readonly BatchItem[]
  /** 有几条刚被别处改过，视图还没把它们换成最新内容。 */
  isRefreshing: boolean
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
  const blocked = isRefreshing ? t('library.batch.refreshing') : model.status === 'unavailable' ? t('pending.model.unavailable')
    : picked.length < 2 ? t('library.select.tooFew') : isMissing ? t('library.model.empty') : undefined
  return (
    <>
      <section className="pm-batch-picked" aria-label={t('library.batch.picked')}>
        {isRefreshing ? <p className="pm-batch-picked-count" role="status">{t('library.batch.refreshing')}</p> : null}
        <ul ref={list} className="pm-batch-picked-list" hidden={isRefreshing}>
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
        {isRefreshing ? null : <p className="pm-batch-picked-count">{t('library.batch.count', { n: picked.length })}</p>}
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
function PlanStep({ plan, initial, error, picked, onRevise, onConfirm }: {
  plan: EditPlan
  /** 从出稿退回来时接着上次的勾选和回答。 */
  initial?: PlanChoice | undefined
  error?: string | undefined
  picked: readonly BatchItem[]
  onRevise: () => void
  onConfirm: (checked: string[], answers: Record<string, string>) => void
}) {
  const t = useT()
  const id = useId()
  const nameOf = (memoryId: string) => picked.find(item => item.memory.id === memoryId)?.memory.name ?? memoryId
  const [checked, setChecked] = useState<ReadonlySet<string>>(() => new Set(initial?.checked ?? plan.ops.filter(op => op.action !== 'keep').map(op => op.memoryId)))
  /** 因承接的改写取消而跟着取消的删除项：下面写明原因。退回来时按勾选重新认出来。 */
  const [held, setHeld] = useState<ReadonlySet<string>>(() => new Set(initial === undefined ? [] : plan.ops.filter(d =>
    d.action === 'delete' && !initial.checked.includes(d.memoryId)
    && plan.ops.some(op => op.memoryId === d.into && op.action === 'rewrite' && !initial.checked.includes(op.memoryId))).map(d => d.memoryId)))
  const [answers, setAnswers] = useState<Readonly<Record<string, string>>>(initial?.answers ?? {})
  const dependents = (op: PlanOp) => plan.ops.filter(d => d.action === 'delete' && d.into === op.memoryId).map(d => d.memoryId)
  const toggle = (op: PlanOp) => {
    const isOn = !checked.has(op.memoryId)
    if (isOn && isOrphanDelete(op, plan.ops, checked)) return
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
                disabled={op.action === 'keep' || isOrphanDelete(op, plan.ops, checked)}
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
      {error !== undefined ? <p className="pm-pending-error" role="alert">{error}</p> : null}
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

/**
 * 对照应用：按计划顺序逐项。改写项原文 / 改后对照，可「再改改」（单项 draft-edit）或放弃；删除项划掉原文，只能放弃。
 * 放弃的项变淡、按钮换成「恢复这项」；放弃改写项时并进它的删除项一起放弃并提示，恢复改写不自动恢复删除（同看计划的取消勾选）。
 */
function ApplyStep({ session, choice, picked, drafts: initialDrafts, onDiscardAll, onApply, onBehind, unavailable, feedback }: {
  session: BorrowedSession
  choice: PlanChoice
  picked: readonly BatchItem[]
  drafts: Readonly<Record<string, EditDraft>>
  onDiscardAll: () => void
  onApply: ((application: BatchApplication) => void) | undefined
  /** 「再改改」时这一项已被别处删了。 */
  onBehind: (memoryIds: readonly string[]) => void
  unavailable: string | undefined
  feedback: ReactNode
}) {
  const t = useT()
  const ops = chosenOps(choice)
  const [drafts, setDrafts] = useState(initialDrafts)
  const [dropped, setDropped] = useState<ReadonlySet<string>>(new Set())
  /** 因承接的改写放弃而跟着放弃的删除项：下面写明原因。 */
  const [held, setHeld] = useState<ReadonlySet<string>>(new Set())
  /** 正在「再改改」生成的项：生成完才能应用。 */
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set())
  /** 有删除项时点了「应用全部」：按钮原位换成确认条。 */
  const [isConfirming, setConfirming] = useState(false)
  const toggle = (op: PlanOp) => {
    const isDropping = !dropped.has(op.memoryId)
    const next = new Set(dropped)
    const nextHeld = new Set(held)
    if (isDropping) next.add(op.memoryId)
    else next.delete(op.memoryId)
    nextHeld.delete(op.memoryId)
    if (op.action === 'rewrite') {
      for (const d of ops.filter(d => d.action === 'delete' && d.into === op.memoryId)) {
        if (isDropping && !next.has(d.memoryId)) { next.add(d.memoryId); nextHeld.add(d.memoryId) }
        if (!isDropping) nextHeld.delete(d.memoryId)
      }
    }
    setDropped(next)
    setHeld(nextHeld)
  }
  const setItemBusy = (memoryId: string, isBusy: boolean) => {
    setBusy((prev) => {
      if (prev.has(memoryId) === isBusy) return prev
      const next = new Set(prev)
      if (isBusy) next.add(memoryId)
      else next.delete(memoryId)
      return next
    })
  }
  const live = ops.filter(op => !dropped.has(op.memoryId))
  const deleting = live.filter(op => op.action === 'delete')
  const deletes = deleting.length
  const nameOf = (memoryId: string) => picked.find(item => item.memory.id === memoryId)!.memory.name
  const refOf = (memoryId: string) => {
    const { ref } = picked.find(item => item.memory.id === memoryId)!
    return { memoryId: ref.memoryId, layer: ref.layer }
  }
  const apply = () => { onApply?.(applicationOf(choice, picked, drafts, dropped)) }
  return (
    <>
      <ul className="pm-batch-items" aria-label={t('library.batch.items')}>
        {ops.map((op) => {
          const item = picked.find(i => i.memory.id === op.memoryId)!
          const draft = drafts[op.memoryId]
          return op.action === 'rewrite' && draft !== undefined
            ? (
              <RewriteItem
                key={op.memoryId}
                session={session}
                op={op}
                item={item}
                draft={draft}
                request={choice.request}
                answer={choice.answers[op.memoryId]}
                absorbs={deleting.filter(d => d.into === op.memoryId).map(d => refOf(d.memoryId))}
                isDropped={dropped.has(op.memoryId)}
                onToggle={() => { toggle(op) }}
                onDraft={(next) => { setDrafts(prev => ({ ...prev, [op.memoryId]: next })) }}
                onBusy={(isBusy) => { setItemBusy(op.memoryId, isBusy) }}
                onBehind={onBehind}
              />
            )
            : (
              <li
                key={op.memoryId}
                className={['pm-batch-item', dropped.has(op.memoryId) ? 'pm-batch-item--dropped' : ''].filter(Boolean).join(' ')}
                aria-label={t('library.batch.op', { action: t('library.batch.action.delete'), name: item.memory.name })}
              >
                <ItemHead action={t('library.batch.action.delete')} name={item.memory.name}>
                  <Button
                    variant="ghost"
                    unavailable={dropped.has(op.memoryId) && isOrphanDelete(op, ops, new Set(live.map(o => o.memoryId))) ? t('library.batch.dropHeld') : undefined}
                    onClick={() => { toggle(op) }}
                  >
                    {t(dropped.has(op.memoryId) ? 'library.batch.restore' : 'library.batch.drop')}
                  </Button>
                </ItemHead>
                <p className="pm-batch-struck"><del>{item.memory.content}</del></p>
                {op.into !== undefined ? <p className="pm-batch-item-note">{t('library.batch.into', { name: nameOf(op.into) })}</p> : null}
                <p className="pm-batch-item-note">{t('library.batch.deleteNote')}</p>
                {held.has(op.memoryId) ? <p className="pm-plan-held">{t('library.batch.dropHeld')}</p> : null}
              </li>
            )
        })}
      </ul>
      <div className="pm-edit-foot pm-plan-foot">
        <span className="pm-edit-hint">{t('library.batch.applySummary', { n: live.length, deletes, rewrites: live.length - deletes })}</span>
        <Button variant="ghost" onClick={onDiscardAll}>{t('library.batch.discardAll')}</Button>
        {isConfirming
          ? (
            <SoftDeleteConfirm
              question={t('library.batch.confirmDelete', { n: deletes, names: deleting.map(op => nameOf(op.memoryId)).join(t('library.batch.nameSep')) })}
              confirmLabel={t('library.batch.confirmApply')}
              onCancel={() => { setConfirming(false) }}
              onConfirm={() => { setConfirming(false); apply() }}
            />
          )
          : (
            <Button
              variant="primary"
              unavailable={live.length === 0 ? t('library.batch.nothing') : busy.size > 0 ? t('library.batch.waitItem') : unavailable}
              onClick={() => { if (deletes > 0) setConfirming(true); else apply() }}
            >
              {t('library.batch.applyAll')}
            </Button>
          )}
      </div>
      {feedback}
    </>
  )
}

/** 对照里一项的项头：动作标签、名称，右边是这一项的按钮。 */
function ItemHead({ action, name, children }: { action: string; name: string; children: ReactNode }) {
  return (
    <div className="pm-batch-item-head">
      <span className="pm-plan-action">{action}</span>
      <span className="pm-batch-item-name">{name}</span>
      <span className="pm-batch-item-actions">{children}</span>
    </div>
  )
}

type ItemPhase =
  | { kind: 'idle' }
  | { kind: 'ask'; text: string; error?: string }
  | { kind: 'busy'; text: string }

/**
 * 对照里的一个改写项。「再改改」在这一项下写新要求，发 draft-edit：本轮要求、此前的要求（整体要求在前，再是这一项之前每轮的要求）、
 * 这一项的计划（理由、提问、回答）、并进它且仍要删的记忆和上一稿。生成中只锁这一项，「停止」回到写要求、输入保留。
 */
function RewriteItem({ session, op, item, draft, request, answer, absorbs, isDropped, onToggle, onDraft, onBusy, onBehind }: {
  session: BorrowedSession
  op: PlanOp
  item: BatchItem
  draft: EditDraft
  /** 整体要求。 */
  request: string
  /** 用户对这一项提问的回答（没填缺省）。 */
  answer: string | undefined
  /** 内容并进这一项、此刻仍要删的删除项（没放弃的）：再改改时一起发给模型，免得它们独有的信息被改掉。 */
  absorbs: NonNullable<DraftCommand['absorbs']>
  isDropped: boolean
  onToggle: () => void
  onDraft: (draft: EditDraft) => void
  onBusy: (isBusy: boolean) => void
  /** 这一项已被别处删了（not-found）：交给工作区回到写要求。 */
  onBehind: (memoryIds: readonly string[]) => void
}) {
  const t = useT()
  const id = useId()
  const gateway = useGateway()
  const model = gateway.useModel(session)
  const [phase, setPhaseState] = useState<ItemPhase>({ kind: 'idle' })
  /** 这一项此前每一轮「再改改」的要求，按先后。 */
  const [rounds, setRounds] = useState<readonly string[]>([])
  const seq = useRef(0)
  useEffect(() => () => { seq.current += 1 }, [])
  const setPhase = (next: ItemPhase) => { setPhaseState(next); onBusy(next.kind === 'busy') }
  const { memory } = item
  const label = t('library.batch.op', { action: t('library.batch.action.rewrite'), name: memory.name })

  const toggle = () => {
    // 放弃时在等的那次作废、写了一半的要求收起
    if (!isDropped) { seq.current += 1; setPhase({ kind: 'idle' }) }
    onToggle()
  }
  const generate = (text: string) => {
    if (session.kind !== 'ready' || text.trim() === '') return
    const command: DraftCommand = {
      cmd: 'draft-edit',
      memories: [{ memoryId: memory.id, layer: scopeOfMemory(memory) }] as DraftCommand['memories'],
      request: text.trim(),
      priorRequests: [request, ...rounds],
      planNote: { reason: op.reason, ...(op.question !== undefined ? { question: op.question } : {}), ...(answer !== undefined ? { answer } : {}) },
      ...(absorbs.length > 0 ? { absorbs } : {}),
      previous: draft,
    }
    // 命令文本会进借用会话的日志：要求、此前的要求、计划、上一稿里有高危密钥就不发
    const refused = refuseBeforeSend(command)
    if (refused !== undefined) { setPhase({ kind: 'ask', text, error: refused.isLocalized ? t(refused.detail) : refused.detail }); return }
    const mine = ++seq.current
    setPhase({ kind: 'busy', text })
    void gateway.execute(session.sessionId, command).then((r) => {
      if (mine !== seq.current) return
      if (!r.ok && r.code === 'not-found') { setPhase({ kind: 'idle' }); onBehind(r.memoryIds ?? [memory.id]); return }
      if (!r.ok) { setPhase({ kind: 'ask', text, error: failureOf(command, r, t) }); return }
      if (r.draft === undefined) { setPhase({ kind: 'ask', text, error: t('pending.model.invalid') }); return }
      onDraft(fillDraft(r.draft, draft))
      setRounds(prev => [...prev, text.trim()])
      setPhase({ kind: 'idle' })
    })
  }

  return (
    <li className={['pm-batch-item', isDropped ? 'pm-batch-item--dropped' : ''].filter(Boolean).join(' ')} aria-label={label}>
      <ItemHead action={t('library.batch.action.rewrite')} name={memory.name}>
        <Button variant="ghost" onClick={toggle}>{t(isDropped ? 'library.batch.restore' : 'library.batch.drop')}</Button>
        {!isDropped && phase.kind === 'idle'
          ? <Button onClick={() => { setPhase({ kind: 'ask', text: '' }) }}>{t('pending.model.again')}</Button>
          : null}
      </ItemHead>
      <div className="pm-model-result">
        <DraftCompare memories={[memory]} base={{ content: memory.content, summary: memory.summary, name: memory.name, tags: memory.tags }} draft={draft} />
      </div>
      {phase.kind === 'busy'
        ? (
          <div className="pm-model-busy" role="status">
            <span className="pm-model-dot" aria-hidden="true" />
            <span>{t('pending.model.busy')}</span>
            <Button variant="ghost" onClick={() => { seq.current += 1; setPhase({ kind: 'ask', text: phase.text }) }}>{t('pending.model.stop')}</Button>
          </div>
        )
        : phase.kind === 'ask'
          ? (
            <div className="pm-edit pm-batch-again">
              <RequestBox
                id={id}
                label={t('library.batch.againAsk')}
                value={phase.text}
                onChange={(text) => { setPhaseState({ kind: 'ask', text }) }}
                intents={SINGLE_INTENTS}
                placeholder={t('library.model.placeholder')}
              />
              {phase.error !== undefined ? <p className="pm-pending-error" role="alert">{phase.error}</p> : null}
              <div className="pm-edit-foot">
                <span className="pm-edit-hint">{phase.text.trim() === '' && model.status !== 'unavailable' ? t('library.model.empty') : hintOf(model, t)}</span>
                <Button variant="ghost" onClick={() => { setPhase({ kind: 'idle' }) }}>{t('pending.cancel')}</Button>
                <Button
                  variant="primary"
                  unavailable={model.status === 'unavailable' ? t('pending.model.unavailable') : phase.text.trim() === '' ? t('library.model.empty') : undefined}
                  onClick={() => { generate(phase.text) }}
                >
                  {t('pending.model.generate')}
                </Button>
              </div>
            </div>
          )
          : null}
    </li>
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
.pm-batch-items { display: flex; flex-direction: column; margin: 0; padding: 0; list-style: none; }
.pm-batch-item { display: flex; flex-direction: column; gap: 8px; padding: 12px 0; }
.pm-batch-item + .pm-batch-item { border-top: .5px solid var(--pm-line); }
.pm-batch-item--dropped > :not(.pm-batch-item-head), .pm-batch-item--dropped .pm-batch-item-head > :not(.pm-batch-item-actions) { opacity: .45; }
.pm-batch-item-head { display: flex; align-items: center; gap: 8px; min-width: 0; font-size: 13px; line-height: 1.5; color: var(--pm-text); }
.pm-batch-item-name { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-weight: 600; }
.pm-batch-item-actions { display: inline-flex; flex-shrink: 0; gap: 6px; }
.pm-batch-struck { margin: 0; font-size: 13px; line-height: 1.6; color: var(--pm-text-2); white-space: pre-wrap; overflow-wrap: anywhere; }
.pm-batch-struck del { text-decoration-color: var(--pm-text-2); }
.pm-batch-item-note { margin: 0; font-size: 12px; line-height: 1.5; color: var(--pm-text-2); }
`
