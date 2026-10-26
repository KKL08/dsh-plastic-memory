/**
 * 待处理的各类卡（PRD 5.2；建议整理见 spec「建议整理的动作」）与处理后留在原位的结果卡。每张卡动手前写清后果；动作经 useItemAction 发命令，
 * 成功后把结果（Outcome）交给列表，由列表在原位换成结果卡。
 */
import { useState, type ReactNode } from 'react'
import { CONFLICT_ACTION_VERDICTS, layerOfMemory, type AdviceType, type GuiLayerRef, type MemoryCard as MemoryCardData, type PendingItem } from '../../src/gui/contract.ts'
import { belongsTo, useGateway, type BorrowedSession } from '../gateway.ts'
import { baseName, formatDay, formatNumber, useT, type Translate } from '../i18n.tsx'
import type { LocaleKey } from '../locales.ts'
import { Button } from '../ui/Button.tsx'
import { Chip } from '../ui/Chip.tsx'
import { ConflictRuling, VerticalConflictRuling } from '../ui/ConflictRuling.tsx'
import { MemoryCard } from '../ui/MemoryCard.tsx'
import { StatusMarker } from '../ui/StatusMarker.tsx'
import { ActionFeedback, SecretDeleteConfirm, useItemAction } from './action.tsx'

type Item<K extends PendingItem['kind']> = Extract<PendingItem, { kind: K }>
type Verdict = 'keep-left' | 'keep-right' | 'keep-both'

/** 一次动作的结果，结果卡按它写文案、决定能不能撤销。 */
export type Outcome =
  | { kind: 'resolved'; verdict: Verdict }
  | { kind: 'promoted'; target: 'global' | 'agents-md' }
  | { kind: 'kept-local' }
  | { kind: 'hard-deleted' }
  | { kind: 'dismissed' }
  | { kind: 'raised'; budget: number }
  | { kind: 'confirmed' }
  | { kind: 'deleted' }

export interface CardProps<K extends PendingItem['kind']> {
  item: Item<K>
  session: BorrowedSession
  now: number
  typeLabels: Readonly<Record<string, string>>
  onDone: (outcome: Outcome) => void
  /** 这一条正在别处处理或刚处理完，什么都没动（见 isHandledElsewhere）：由列表在卡片外提示。 */
  onRefused: () => void
}

/** 记忆在别的项目里（相对借来的会话所在项目）时返回项目路径。 */
function otherProject(memory: MemoryCardData | null, session: BorrowedSession): string | undefined {
  if (memory?.workspacePath === undefined) return undefined
  return session.kind === 'ready' && belongsTo(session.cwd, memory.workspacePath, session.workspaces ?? {}) ? undefined : memory.workspacePath
}

/** 记忆卡上的作用域：在别的项目里写项目名，在本项目里照常写「本项目」。 */
function projectNameOf(session: BorrowedSession): (memory: MemoryCardData) => string | undefined {
  return (memory) => {
    const other = otherProject(memory, session)
    return other === undefined ? undefined : baseName(other)
  }
}

/** 记忆文件全文 → 正文（去掉 frontmatter）。 */
export function bodyOf(text: string): string {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(text)
  return (m === null ? text : text.slice(m[0].length)).trim()
}

const isMac = () => typeof navigator !== 'undefined' && /mac/i.test(navigator.platform)

/** focusable：结果卡可以接住焦点（tabIndex=-1），确认收起后原来的按钮没了就落在它上面。 */
function Card({ marker, title, aside, focusable = false, children }: {
  marker?: ReactNode
  title: ReactNode
  aside?: ReactNode
  focusable?: boolean
  children: ReactNode
}) {
  return (
    <article className="pm-pending-item" tabIndex={focusable ? -1 : undefined}>
      <header className="pm-pending-head">
        {marker}
        <h3 className="pm-pending-title">{title}</h3>
        {aside !== undefined ? <div className="pm-pending-aside">{aside}</div> : null}
      </header>
      <div className="pm-pending-body">{children}</div>
    </article>
  )
}

function MemoryOf({ memory, session, now, typeLabels, chip }: {
  memory: MemoryCardData
  session: BorrowedSession
  now: number
  typeLabels: Readonly<Record<string, string>>
  chip?: ReactNode
}) {
  return <MemoryCard memory={memory} now={now} typeLabel={typeLabels[memory.type]} projectName={projectNameOf(session)(memory)} chip={chip} />
}

export function titleOf(item: PendingItem, t: Translate): string {
  switch (item.kind) {
    case 'secret': return t('pending.secret.title')
    case 'conflict-horizontal': return item.summary || t('conflict.title')
    case 'conflict-vertical': return item.summary || t('conflict.title')
    case 'promote-candidate': return t('pending.promote.title')
    case 'overflow': return t('pending.overflow.title')
    case 'unreadable-file': return t('pending.unreadable.title')
    case 'advice': return t(ADVICE_COPY[item.type].title)
  }
}

// —— 密钥 ——

export function SecretCard({ item, session, now, typeLabels, onDone }: CardProps<'secret'>) {
  const t = useT()
  const gateway = useGateway()
  const action = useItemAction(session, () => { onDone({ kind: 'hard-deleted' }) })
  /** 本机临时展开的原文：只在这个组件的内存里，收起或离开页面就没了。 */
  const [revealed, setRevealed] = useState<string | null | undefined>(undefined)
  const [confirming, setConfirming] = useState(false)
  const { memory } = item
  const show = () => {
    if (session.kind !== 'ready') return
    void gateway.readFile(session.sessionId, memory.filePath).then((text) => { setRevealed(text === undefined ? null : bodyOf(text)) })
  }
  const open = () => { void gateway.openPath(memory.filePath, 'open').then((ok) => { if (!ok) action.fail(t('pending.openFailed')) }) }
  return (
    <Card marker={<StatusMarker kind="secret" label={t('marker.secret')} />} title={t('pending.secret.title')}>
      <MemoryOf session={session} memory={typeof revealed === 'string' ? { ...memory, content: revealed } : memory} now={now} typeLabels={typeLabels} />
      {revealed === null ? <p className="pm-pending-text">{t('pending.secret.readFailed')}</p> : null}
      <p className="pm-pending-text">{t('pending.secret.body')}</p>
      {confirming
        ? (
          <SecretDeleteConfirm
            showTitle={false}
            unavailable={action.unavailable}
            onCancel={() => { setConfirming(false) }}
            onConfirm={() => { action.run({ cmd: 'hard-delete', memoryId: memory.id, layer: layerOfMemory(memory) }) }}
          />
        )
        : (
          <div className="pm-pending-actions">
            {typeof revealed === 'string'
              ? <Button onClick={() => { setRevealed(undefined) }}>{t('pending.secret.hide')}</Button>
              : <Button unavailable={action.unavailable} onClick={show}>{t('pending.secret.show')}</Button>}
            <Button onClick={open}>{t('pending.secret.rewrite')}</Button>
            <Button variant="danger" unavailable={action.unavailable} onClick={() => { setConfirming(true) }}>{t('pending.secret.delete')}</Button>
          </div>
        )}
      <ActionFeedback action={action} />
    </Card>
  )
}

// —— 冲突 ——

export function HorizontalCard({ item, session, now, typeLabels, onDone, onRefused }: CardProps<'conflict-horizontal'>) {
  const t = useT()
  const action = useItemAction(session, (command) => {
    if (command.cmd === 'resolve') onDone({ kind: 'resolved', verdict: command.verdict })
  }, onRefused)
  const preferred = item.preferredId === undefined ? undefined
    : item.left?.id === item.preferredId ? { side: 'A', memory: item.left }
      : item.right?.id === item.preferredId ? { side: 'B', memory: item.right } : undefined
  const note = preferred === undefined ? undefined
    : t(preferred.memory.sourceMode === 'user-explicit' ? 'pending.conflict.preferredExplicit' : 'pending.conflict.preferred', { side: preferred.side })
  return (
    <div className="pm-pending-item">
      <ConflictRuling
        layout="wide"
        left={item.left}
        right={item.right}
        now={now}
        title={titleOf(item, t)}
        note={note}
        unavailable={action.unavailable}
        typeLabel={type => typeLabels[type] ?? type}
        projectName={projectNameOf(session)}
        onRule={(verdict) => { action.run({ cmd: 'resolve', decisionId: item.decisionId, verdict }) }}
      />
      <ActionFeedback action={action} />
    </div>
  )
}

export function VerticalCard({ item, session, now, typeLabels, onDone, onRefused }: CardProps<'conflict-vertical'>) {
  const t = useT()
  const action = useItemAction(session, (command) => {
    if (command.cmd === 'resolve') onDone({ kind: 'resolved', verdict: command.verdict })
  }, onRefused)
  return (
    <div className="pm-pending-item">
      <VerticalConflictRuling
        layout="wide"
        memory={item.memory}
        baselineRef={item.baselineRef}
        now={now}
        title={titleOf(item, t)}
        unavailable={action.unavailable}
        typeLabel={type => typeLabels[type] ?? type}
        projectName={projectNameOf(session)}
        onRule={(verdict) => { action.run({ cmd: 'resolve', decisionId: item.decisionId, verdict }) }}
      />
      <ActionFeedback action={action} />
    </div>
  )
}

// —— 提升候选 ——

export function PromoteCard({ item, session, now, typeLabels, onDone, onRefused, promoteTarget }: CardProps<'promote-candidate'> & {
  /** 来自配置 governance.globalPromoteTarget；还没读到为 undefined。 */
  promoteTarget: 'global' | 'agents-md' | undefined
}) {
  const t = useT()
  const action = useItemAction(session, (command) => {
    if (command.cmd === 'promote') onDone({ kind: 'promoted', target: command.target })
    if (command.cmd === 'keep-local') onDone({ kind: 'kept-local' })
  }, onRefused)
  const other = otherProject(item.memory, session)
  const unavailable = action.unavailable ?? (item.memory === null ? t('conflict.missingHint') : undefined)
  const promoteLabel = promoteTarget === 'agents-md' ? t('pending.promote.agentsMd')
    : other !== undefined ? t('pending.promote.globalIn', { name: baseName(other) }) : t('pending.promote.global')
  return (
    <Card
      marker={<StatusMarker kind="pending" />}
      title={other !== undefined ? t('pending.promote.titleIn', { name: baseName(other) }) : t('pending.promote.title')}
    >
      {item.memory === null
        ? <p className="pm-pending-text">{t('conflict.missing')}</p>
        : <MemoryOf session={session} memory={item.memory} now={now} typeLabels={typeLabels} />}
      {promoteTarget !== undefined
        ? <p className="pm-pending-text">{t(promoteTarget === 'agents-md' ? 'pending.promote.agentsMdNote' : 'pending.promote.globalNote')}</p>
        : null}
      <div className="pm-pending-actions">
        <Button unavailable={unavailable} onClick={() => { action.run({ cmd: 'keep-local', decisionId: item.decisionId }) }}>
          {t('pending.promote.keepLocal')}
        </Button>
        <Button
          unavailable={unavailable ?? (promoteTarget === undefined ? t('pending.promote.configLoading') : undefined)}
          onClick={() => { if (promoteTarget !== undefined) action.run({ cmd: 'promote', decisionId: item.decisionId, target: promoteTarget }) }}
        >
          {promoteLabel}
        </Button>
      </div>
      <ActionFeedback action={action} />
    </Card>
  )
}

// —— 超出上限 ——

/** 第 tier 档放宽到的上限：budget × (1 + 0.25 × tier)。 */
const capOf = (budget: number, tier: number) => Math.round(budget * (1 + 0.25 * tier))

export function OverflowCard({ item, session, onDone, onRefused, budget, onCleanup }: CardProps<'overflow'> & {
  budget: number | undefined
  /** 「整理记忆 ›」：去全部记忆，作用域是这张卡那一层。 */
  onCleanup: (scope: GuiLayerRef) => void
}) {
  const t = useT()
  const gateway = useGateway()
  const action = useItemAction(session, () => { onDone({ kind: 'dismissed' }) }, onRefused)
  // 建议值：下一档的起点向上取整到百，填了就不会在这一档再提醒
  const suggested = budget === undefined ? '' : String(Math.ceil(capOf(budget, item.tier + 1) / 100) * 100)
  const [draft, setDraft] = useState<string | undefined>(undefined)
  const value = draft ?? suggested
  const parsed = Number(value)
  const invalid = budget === undefined || !/^\d+$/.test(value.trim()) || parsed <= budget
  const [saving, setSaving] = useState(false)
  const save = () => {
    if (invalid) return
    setSaving(true)
    void gateway.setConfig('snapshotTokenBudget', parsed).then((ok) => {
      setSaving(false)
      if (ok) onDone({ kind: 'raised', budget: parsed })
      else action.fail(t('pending.overflow.saveFailed'))
    })
  }
  const over = 25 * item.tier
  const summary = item.mode === 'relax'
    ? budget === undefined ? t('pending.overflow.relaxNoBudget', { over })
      : t('pending.overflow.relax', { over, cap: formatNumber(capOf(budget, item.tier)), budget: formatNumber(budget) })
    : budget === undefined ? t('pending.overflow.strictNoBudget') : t('pending.overflow.strict', { budget: formatNumber(budget) })
  return (
    <Card
      marker={<StatusMarker kind="pending" />}
      title={t('pending.overflow.title')}
      aside={(
        <Button variant="quiet" unavailable={action.unavailable} onClick={() => { action.run({ cmd: 'dismiss-overflow', decisionId: item.decisionId }) }}>
          {t('pending.overflow.dismiss')}
        </Button>
      )}
    >
      {item.workspacePath !== undefined ? <p className="pm-pending-text">{t('pending.inProject', { name: baseName(item.workspacePath) })}</p> : null}
      <p className="pm-pending-text">{summary}</p>
      <div className="pm-pending-option">
        <label className="pm-pending-option-label">
          {t('pending.overflow.raise')}
          <input
            className="pm-pending-input"
            inputMode="numeric"
            value={value}
            aria-invalid={budget !== undefined && invalid}
            onChange={(event) => { setDraft(event.target.value) }}
          />
        </label>
        <Button unavailable={saving ? t('pending.busy') : invalid ? t('pending.overflow.invalid', { budget: budget === undefined ? '' : formatNumber(budget) }) : undefined} onClick={save}>
          {t('pending.overflow.save')}
        </Button>
      </div>
      <p className="pm-pending-hint">
        {budget !== undefined && invalid && value.trim() !== '' ? t('pending.overflow.invalid', { budget: formatNumber(budget) }) : t('pending.overflow.raiseHint')}
        <button
          type="button"
          className="pm-link"
          onClick={() => { onCleanup(item.workspacePath !== undefined ? { kind: 'workspace', workspacePath: item.workspacePath } : { kind: 'global' }) }}
        >
          {t('pending.overflow.cleanup')}
        </button>
      </p>
      <ActionFeedback action={action} />
    </Card>
  )
}

// —— 读不出的文件 ——

export function UnreadableCard({ item, session }: CardProps<'unreadable-file'>) {
  const t = useT()
  const gateway = useGateway()
  const action = useItemAction(session, () => {})
  const open = (how: 'open' | 'reveal') => {
    void gateway.openPath(item.filePath, how).then((ok) => { if (!ok) action.fail(t('pending.openFailed')) })
  }
  return (
    <Card title={t('pending.unreadable.title')}>
      <p className="pm-pending-path">{item.relativePath}</p>
      <pre className="pm-pending-error-text">{item.error}</pre>
      <div className="pm-pending-actions">
        <Button onClick={() => { open('reveal') }}>{t(isMac() ? 'pending.unreadable.revealMac' : 'pending.unreadable.revealOther')}</Button>
        <Button onClick={() => { open('open') }}>{t('pending.unreadable.open')}</Button>
      </div>
      <ActionFeedback action={action} />
    </Card>
  )
}

// —— 建议整理 ——

/** 每类建议的标题、动手前的说明和动作（按 spec 表，「忽略」「在对话里修改」以后加）。按钮顺序即显示顺序。 */
const ADVICE_COPY = {
  expired: { title: 'pending.advice.expired.title', body: 'pending.advice.expired.body', actions: ['delete', 'open'] },
  stale: { title: 'pending.advice.stale.title', body: 'pending.advice.stale.body', actions: ['confirm', 'delete', 'open'] },
  bloat: { title: 'pending.advice.bloat.title', body: 'pending.advice.bloat.body', actions: ['open'] },
  orphan: { title: 'pending.advice.orphan.title', body: 'pending.advice.orphan.body', actions: ['open'] },
} as const satisfies Record<AdviceType, { title: LocaleKey; body: LocaleKey; actions: ReadonlyArray<'confirm' | 'delete' | 'open'> }>

/** 建议整理卡：不着色、不带状态标记。删除走 forget（进最近删除），含密钥时原位改问彻底删除。 */
export function AdviceCard({ item, session, now, typeLabels, onDone, onRefused }: CardProps<'advice'>) {
  const t = useT()
  const gateway = useGateway()
  const action = useItemAction(session, (command) => {
    if (command.cmd === 'confirm') onDone({ kind: 'confirmed' })
    if (command.cmd === 'forget') onDone({ kind: 'deleted' })
    if (command.cmd === 'hard-delete') onDone({ kind: 'hard-deleted' })
  }, onRefused)
  const copy = ADVICE_COPY[item.type]
  const [memory] = item.memories
  const layer = layerOfMemory(memory)
  const open = () => { void gateway.openPath(memory.filePath, 'open').then((ok) => { if (!ok) action.fail(t('pending.openFailed')) }) }
  const buttons = {
    confirm: <Button key="confirm" unavailable={action.unavailable} onClick={() => { action.run({ cmd: 'confirm', memoryId: memory.id, layer }) }}>{t('pending.advice.confirm')}</Button>,
    delete: <Button key="delete" unavailable={action.unavailable} onClick={() => { action.run({ cmd: 'forget', memoryId: memory.id, layer }) }}>{t('pending.advice.delete')}</Button>,
    open: <Button key="open" onClick={open}>{t('pending.advice.open')}</Button>,
  }
  return (
    <Card title={t(copy.title)}>
      {item.memories.map(m => <MemoryOf key={m.id} session={session} memory={m} now={now} typeLabels={typeLabels} />)}
      <p className="pm-pending-text">{t(copy.body, { date: formatDay(memory.lastConfirmedAt, now, t) })}</p>
      <div className="pm-pending-actions">{copy.actions.map(a => buttons[a])}</div>
      <ActionFeedback action={action} />
    </Card>
  )
}

// —— 结果卡：刚处理完留在原位，能撤销的带「撤销」 ——

interface ResultCopy { memory?: MemoryCardData | null; chip: string; body: string; undoable: boolean }

function resultCopy(item: PendingItem, outcome: Outcome, t: Translate): ResultCopy {
  if (outcome.kind === 'resolved' && item.kind === 'conflict-horizontal') {
    if (outcome.verdict === 'keep-left') return { memory: item.left, chip: t('pending.result.keptA'), body: t('pending.result.deletedSide', { side: 'B' }), undoable: true }
    if (outcome.verdict === 'keep-right') return { memory: item.right, chip: t('pending.result.keptB'), body: t('pending.result.deletedSide', { side: 'A' }), undoable: true }
    return { chip: t('pending.result.keptBoth'), body: t('pending.result.keptBothBody'), undoable: true }
  }
  if (outcome.kind === 'resolved' && item.kind === 'conflict-vertical') {
    return outcome.verdict === CONFLICT_ACTION_VERDICTS.vertical.keepBaseline
      ? { chip: t('pending.result.followedBaseline'), body: t('pending.result.followedBaselineBody'), undoable: true }
      : { memory: item.memory, chip: t('pending.result.keptMemory'), body: t('pending.result.keptMemoryBody'), undoable: true }
  }
  const memory = 'memory' in item ? item.memory : item.kind === 'advice' ? item.memories[0] : undefined
  switch (outcome.kind) {
    case 'promoted':
      // 写进 AGENTS.md 没有执行器能撤回那一行，服务端直接移出账本
      return outcome.target === 'global'
        ? { memory, chip: t('pending.result.promoted'), body: t('pending.result.promotedBody'), undoable: true }
        : { chip: t('pending.result.wroteAgentsMd'), body: t('pending.result.wroteAgentsMdBody'), undoable: false }
    case 'kept-local': return { memory, chip: t('pending.result.keptLocal'), body: t('pending.result.keptLocalBody'), undoable: true }
    case 'hard-deleted': return { chip: t('pending.secret.deleted'), body: t('pending.secret.deletedBody'), undoable: false }
    case 'dismissed': return { chip: t('pending.result.dismissed'), body: t('pending.result.dismissedBody'), undoable: false }
    case 'raised': return { chip: t('pending.result.raised', { budget: formatNumber(outcome.budget) }), body: t('pending.overflow.raiseHint'), undoable: false }
    case 'confirmed': return { memory, chip: t('pending.result.confirmed'), body: t('pending.result.confirmedBody'), undoable: false }
    case 'deleted': return { chip: t('pending.result.deleted'), body: t('pending.result.deletedBody'), undoable: false }
    case 'resolved': throw new Error(`resolved outcome on ${item.kind}`)
  }
}

export function ResultCard({ item, outcome, session, now, typeLabels, onUndone, onRefused }: {
  item: PendingItem
  outcome: Outcome
  session: BorrowedSession
  now: number
  typeLabels: Readonly<Record<string, string>>
  onUndone: () => void
  onRefused: () => void
}) {
  const t = useT()
  const action = useItemAction(session, () => { onUndone() }, onRefused)
  const copy = resultCopy(item, outcome, t)
  const chip = <Chip variant="result">{copy.chip}</Chip>
  return (
    <Card title={titleOf(item, t)} focusable>
      {copy.memory ? <MemoryOf session={session} memory={copy.memory} now={now} typeLabels={typeLabels} chip={chip} /> : <div>{chip}</div>}
      <div className="pm-pending-result">
        <p className="pm-pending-text">{copy.body}</p>
        {copy.undoable && 'decisionId' in item
          ? (
            <Button className="pm-pending-undo" unavailable={action.unavailable} onClick={() => { action.run({ cmd: 'undo', decisionId: item.decisionId }) }}>
              {t('pending.undo')}
            </Button>
          )
          : null}
      </div>
      <ActionFeedback action={action} />
    </Card>
  )
}
