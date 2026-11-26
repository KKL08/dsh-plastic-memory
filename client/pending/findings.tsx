/**
 * 体检的四种新发现（spec 五）：漏记的变化、例外提示、依据已变、跨项目重复。每种只给自己能用的裁决（同服务端 VERDICTS_BY_KIND），
 * 其余组合不出按钮。卡片的样子沿用待处理的既有做法：可以整理的两种同建议整理卡（不带标记，右上角叉是「不再提醒」），
 * 等你决定的两种带琥珀圆点、动作在动作行；先选一条再动手的（并成版本、提升为全局）在卡里展开单选，同「移到项目…」。
 */
import { useId, useState } from 'react'
import { scopeOfMemory, type MemoryCard as MemoryCardData, type PendingItem } from '../../src/gui/contract.ts'
import type { BorrowedSession } from '../gateway.ts'
import { baseName, useT, type Translate } from '../i18n.tsx'
import { AdviceNote } from '../ui/Advice.tsx'
import { Button } from '../ui/Button.tsx'
import { Chip } from '../ui/Chip.tsx'
import { DismissButton } from '../ui/DismissButton.tsx'
import { StatusMarker } from '../ui/StatusMarker.tsx'
import { Card, MemoryOf, newerOf, resolvedTo, titleOf, useCardAction, type CardAction, type CardProps } from './cards.tsx'
import { ChoicePanel } from './choice.tsx'

/** 处理这四种的动作：resolve 结清（带裁决和留作当前的那条），跨项目重复的提升走按记忆提升，撤销按它带回的账本条目。 */
function useFindingAction({ session, onDone, onRefused }: Pick<CardProps<PendingItem['kind']>, 'session' | 'onDone' | 'onRefused'>): CardAction {
  const resolved = resolvedTo(onDone)
  return useCardAction(session, {
    onOk: (result, command) => {
      if (command.cmd === 'promote-memory') onDone({ kind: 'promoted', target: 'global', decisionId: result.decisionId, memoryId: command.memoryId })
      else resolved(result, command)
    },
    onHandledElsewhere: onRefused,
  })
}

/** 说明句开头的摘要：自带句末标点就照用，否则补上当前语言的句号，免得拼出「。。」。 */
function leadOf(summary: string, t: Translate): string {
  const trimmed = summary.trimEnd()
  return /[。！？.!?]$/u.test(trimmed) ? trimmed : t('pending.finding.lead', { summary: trimmed })
}

function Missing() {
  const t = useT()
  return <p className="pm-pending-text">{t('conflict.missing')}</p>
}

/** 并排的几条记忆，每条一个以名称（或给定的标签）命名的区块，标注跟在原文末尾。 */
function Members({ memories, session, now, typeLabel, labelOf = m => m.name, projectOf, badgeOf }: {
  memories: ReadonlyArray<MemoryCardData | null>
  session: BorrowedSession
  now: number
  typeLabel: (type: string) => string
  labelOf?: (memory: MemoryCardData) => string
  projectOf?: (memory: MemoryCardData) => string | undefined
  badgeOf?: (memory: MemoryCardData) => string | undefined
}) {
  const present = memories.filter((m): m is MemoryCardData => m !== null)
  return (
    <>
      <div className={present.length > 1 ? 'pm-pending-advice-group' : undefined}>
        {present.map((m) => {
          const badge = badgeOf?.(m)
          return (
            <section key={m.id} className="pm-pending-advice-side" aria-label={labelOf(m)}>
              <MemoryOf
                session={session} memory={m} now={now} typeLabel={typeLabel} collapsible
                projectName={projectOf?.(m)}
                badge={badge === undefined ? undefined : <Chip variant="neutral">{badge}</Chip>}
              />
            </section>
          )
        })}
      </div>
      {present.length < memories.length ? <Missing /> : null}
    </>
  )
}

// —— 漏记的变化 ——

export function MissedChangeCard({ item, session, now, typeLabel, onDone, onRefused }: CardProps<'missed-change'>) {
  const t = useT()
  const action = useFindingAction({ session, onDone, onRefused })
  const [isPicking, setPicking] = useState(false)
  const { left, right } = item
  // 面板开着时有一条变成读不到：面板收起，右上角「不再提醒」回来
  const isChoosing = isPicking && left !== null && right !== null
  const current = item.current === undefined ? undefined : [left, right].find(m => m?.id === item.current) ?? undefined
  const old = current === undefined ? undefined : (current === left ? right : left)
  const body = current !== undefined && old !== null && old !== undefined
    ? t('pending.missed.body', { current: current.name, old: old.name })
    : t('pending.missed.bodyNoPlan')
  const resolve = (verdict: 'not-conflict' | 'dismiss') => { action.run({ cmd: 'resolve', decisionId: item.decisionId, verdict }) }
  return (
    <Card
      title={titleOf(item, t, session)}
      aside={isChoosing ? undefined : <DismissButton label={t('pending.dismiss')} unavailable={action.unavailable} onClick={() => { resolve('dismiss') }} />}
    >
      <Members
        memories={[left, right]} session={session} now={now} typeLabel={typeLabel}
        badgeOf={m => (m.id === current?.id ? t('pending.missed.current') : undefined)}
      />
      {isChoosing
        ? (
          <ChoicePanel
            legend={t('pending.versions.pick')}
            options={[{ value: left.id, label: left.name }, { value: right.id, label: right.name }]}
            initial={current?.id ?? newerOf(left, right)}
            hint={t('pending.versions.hint')}
            confirmLabel={t('pending.conflict.asVersions')}
            unavailable={action.unavailable}
            onCancel={() => { setPicking(false) }}
            onConfirm={(id) => {
              setPicking(false)
              action.run({ cmd: 'resolve', decisionId: item.decisionId, verdict: 'as-versions', current: id })
            }}
          />
        )
        : (
          <>
            <AdviceNote>{leadOf(item.summary, t)}{body}</AdviceNote>
            <div className="pm-pending-actions">
              <Button unavailable={action.unavailable} onClick={() => { resolve('not-conflict') }}>{t('pending.conflict.notConflict')}</Button>
              <Button
                unavailable={action.unavailable ?? (left === null || right === null ? t('conflict.missingHint') : undefined)}
                onClick={() => { setPicking(true) }}
              >
                {t('pending.conflict.asVersions')}
              </Button>
            </div>
          </>
        )}
      {action.feedback}
    </Card>
  )
}

// —— 例外提示 ——

export function ExceptionCard({ item, session, now, typeLabel, onDone, onRefused }: CardProps<'exception'>) {
  const t = useT()
  const action = useFindingAction({ session, onDone, onRefused })
  return (
    <Card
      title={titleOf(item, t, session)}
      aside={<DismissButton label={t('pending.dismiss')} unavailable={action.unavailable} onClick={() => { action.run({ cmd: 'resolve', decisionId: item.decisionId, verdict: 'dismiss' }) }} />}
    >
      <Members memories={item.memories} session={session} now={now} typeLabel={typeLabel} />
      {item.baselineRef !== undefined ? <p className="pm-pending-hint">{t('pending.exception.baseline', { ref: item.baselineRef })}</p> : null}
      <AdviceNote>{leadOf(item.summary, t)}{t(item.baselineRef !== undefined ? 'pending.exception.bodyBaseline' : 'pending.exception.body')}</AdviceNote>
      {action.feedback}
    </Card>
  )
}

// —— 依据已变 ——

/** 带小标题的一块（决定、依据）：区块以小标题命名。 */
function Labelled({ label, memory, session, now, typeLabel }: {
  label: string
  memory: MemoryCardData | null
  session: BorrowedSession
  now: number
  typeLabel: (type: string) => string
}) {
  const id = useId()
  return (
    <section className="pm-pending-advice-side" aria-labelledby={id}>
      <p id={id} className="pm-finding-label">{label}</p>
      {memory === null ? <Missing /> : <MemoryOf session={session} memory={memory} now={now} typeLabel={typeLabel} collapsible />}
    </section>
  )
}

export function PremiseCard({ item, session, now, typeLabel, onDone, onRefused, onEditDecision }: CardProps<'premise-changed'> & {
  /** 「去改这条决定 ›」：去记忆查看、定位到这条决定。 */
  onEditDecision: (decision: MemoryCardData) => void
}) {
  const t = useT()
  const action = useFindingAction({ session, onDone, onRefused })
  const { decision, premise } = item
  return (
    <Card marker={<StatusMarker kind="pending" />} title={titleOf(item, t, session)}>
      <div className="pm-pending-advice-group">
        <Labelled label={t('pending.premise.decision')} memory={decision} session={session} now={now} typeLabel={typeLabel} />
        <Labelled label={t('pending.premise.premise')} memory={premise} session={session} now={now} typeLabel={typeLabel} />
      </div>
      <AdviceNote>
        {decision !== null && premise !== null ? t('pending.premise.body', { premise: premise.name, decision: decision.name }) : leadOf(item.summary, t)}
        {decision !== null
          ? <button type="button" className="pm-link" onClick={() => { onEditDecision(decision) }}>{t('pending.premise.edit')}</button>
          : null}
      </AdviceNote>
      <div className="pm-pending-actions">
        <Button unavailable={action.unavailable} onClick={() => { action.run({ cmd: 'resolve', decisionId: item.decisionId, verdict: 'dismiss' }) }}>
          {t('pending.premise.stillHolds')}
        </Button>
      </div>
      {action.feedback}
    </Card>
  )
}

// —— 跨项目重复 ——

export function CrossDuplicateCard({ item, session, now, typeLabel, onDone, onRefused }: CardProps<'cross-duplicate'>) {
  const t = useT()
  const action = useFindingAction({ session, onDone, onRefused })
  const [isPicking, setPicking] = useState(false)
  // 所在项目这次没读全、没读到的那条（null）只写找不到，不能选来提升
  const present = item.memories.filter((m): m is MemoryCardData => m !== null)
  const projectOf = (m: MemoryCardData) => (m.workspacePath === undefined ? undefined : baseName(m.workspacePath))
  const labelOf = (m: MemoryCardData) => {
    const project = projectOf(m)
    return project === undefined ? m.name : t('pending.crossDup.member', { name: m.name, project })
  }
  return (
    <Card marker={<StatusMarker kind="pending" />} title={titleOf(item, t, session)}>
      <Members
        memories={item.memories} session={session} now={now} typeLabel={typeLabel} labelOf={labelOf} projectOf={projectOf}
        badgeOf={m => (m.id === item.promoteId ? t('pending.crossDup.suggested') : undefined)}
      />
      {isPicking
        ? (
          <ChoicePanel
            legend={t('pending.crossDup.pick')}
            options={present.map(m => ({ value: m.id, label: labelOf(m) }))}
            initial={item.promoteId}
            confirmLabel={t('pending.promote.global')}
            unavailable={action.unavailable}
            onCancel={() => { setPicking(false) }}
            onConfirm={(id) => {
              const memory = present.find(m => m.id === id)
              if (memory === undefined) return
              setPicking(false)
              action.run({ cmd: 'promote-memory', memoryId: memory.id, layer: scopeOfMemory(memory) })
            }}
          />
        )
        : (
          <>
            <AdviceNote>{leadOf(item.summary, t)}{t('pending.crossDup.body')}</AdviceNote>
            <div className="pm-pending-actions">
              <Button unavailable={action.unavailable} onClick={() => { action.run({ cmd: 'resolve', decisionId: item.decisionId, verdict: 'dismiss' }) }}>
                {t('pending.crossDup.keep')}
              </Button>
              <Button unavailable={action.unavailable} onClick={() => { setPicking(true) }}>{t('pending.promote.global')}</Button>
            </div>
          </>
        )}
      {action.feedback}
    </Card>
  )
}
