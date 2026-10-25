/**
 * 冲突裁决（DESIGN.md「Conflict Ruling」）：琥珀圆点 + 标题，A / B 描边圆标 + 各自的记忆卡，
 * 三个按钮「以 A 为准 / 以 B 为准 / 都保留」，按钮到 verdict 的映射取契约 CONFLICT_ACTION_VERDICTS。
 * - 宽版（记忆页）：A、B 按钮进各自卡片底部，「都保留」居中压在横贯两卡的细线上，下方紧跟后果说明；
 * - 窄版（右侧栏）：三个按钮一行，后果说明在按钮下面。
 * 任一方定位不到（视图里为 null）时裁决会报错，三个按钮都不可用。裁决后的结果态在待处理票里做。
 * 记忆和基线（AGENTS.md）冲突用 VerticalConflictRuling：同一套标题与后果说明，只有一张记忆卡，
 * 按钮「以基线为准 / 保留这条记忆」，并写明基线不会被删除。
 */
import type { ReactNode } from 'react'
import { CONFLICT_ACTION_VERDICTS, type MemoryCard as MemoryCardData } from '../../src/gui/contract.ts'
import { useT } from '../i18n.tsx'
import { Button } from './Button.tsx'
import { MemoryCard } from './MemoryCard.tsx'
import { StatusMarker } from './StatusMarker.tsx'

type HorizontalVerdict = (typeof CONFLICT_ACTION_VERDICTS.horizontal)[keyof typeof CONFLICT_ACTION_VERDICTS.horizontal]
type VerticalVerdict = (typeof CONFLICT_ACTION_VERDICTS.vertical)[keyof typeof CONFLICT_ACTION_VERDICTS.vertical]

export interface ConflictRulingProps {
  layout: 'wide' | 'narrow'
  left: MemoryCardData | null
  right: MemoryCardData | null
  now: number
  onRule: (verdict: HorizontalVerdict) => void
  /** 缺省「两条记忆互相矛盾，等你决定」；记忆页用条目标题。 */
  title?: ReactNode
  /** 标题下的一句默认行为（「决定前 agent 按 A 来。」）。 */
  note?: ReactNode
  /** 动作暂不可用的原因（无会话等）。 */
  unavailable?: string | undefined
  typeLabel?: (type: string) => string
  hideScope?: boolean
  /** 记忆在别的项目里时的项目名（见 MemoryCard 的 projectName）。 */
  projectName?: (memory: MemoryCardData) => string | undefined
}

export function ConflictRuling(props: ConflictRulingProps) {
  const t = useT()
  const { horizontal } = CONFLICT_ACTION_VERDICTS
  const unavailable = props.unavailable ?? (props.left === null || props.right === null ? t('conflict.missingHint') : undefined)
  const side = (letter: 'A' | 'B', memory: MemoryCardData | null, button: ReactNode) => (
    <section className="pm-conflict-side" aria-label={t('conflict.side', { side: letter })}>
      <span className="pm-ab" aria-hidden="true">{letter}</span>
      <div className="pm-conflict-body">
        {memory === null
          ? <p className="pm-conflict-missing">{t('conflict.missing')}</p>
          : <MemoryCard memory={memory} now={props.now} typeLabel={props.typeLabel?.(memory.type)} hideScope={props.hideScope} projectName={props.projectName?.(memory)} />}
        {button}
      </div>
    </section>
  )
  const keepA = <Button unavailable={unavailable} onClick={() => { props.onRule(horizontal.keepA) }}>{t('conflict.keepA')}</Button>
  const keepB = <Button unavailable={unavailable} onClick={() => { props.onRule(horizontal.keepB) }}>{t('conflict.keepB')}</Button>
  const keepBoth = <Button unavailable={unavailable} onClick={() => { props.onRule(horizontal.keepBoth) }}>{t('conflict.keepBoth')}</Button>
  const wide = props.layout === 'wide'

  return (
    <article className={`pm-conflict pm-conflict--${props.layout}`}>
      <header className="pm-conflict-head">
        <StatusMarker kind="pending" />
        <h3 className="pm-conflict-title">{props.title ?? t('conflict.title')}</h3>
      </header>
      {props.note !== undefined ? <p className="pm-conflict-note">{props.note}</p> : null}
      <div className="pm-conflict-sides">
        {side('A', props.left, wide ? <div className="pm-conflict-actions">{keepA}</div> : null)}
        {side('B', props.right, wide ? <div className="pm-conflict-actions">{keepB}</div> : null)}
      </div>
      {wide
        ? (
          <div className="pm-keep">
            <div className="pm-keep-line"><span />{keepBoth}<span /></div>
            <p className="pm-conflict-consequence">{t('conflict.consequence')}</p>
          </div>
        )
        : (
          <>
            <div className="pm-conflict-buttons">{keepA}{keepB}{keepBoth}</div>
            <p className="pm-conflict-consequence">{t('conflict.consequence')}</p>
          </>
        )}
    </article>
  )
}

export interface VerticalConflictRulingProps {
  layout: 'wide' | 'narrow'
  memory: MemoryCardData | null
  /** 基线出处（「AGENTS.md：包管理」）。 */
  baselineRef: string
  now: number
  onRule: (verdict: VerticalVerdict) => void
  /** 缺省「这条记忆和基线矛盾，等你决定」；记忆页用条目标题。 */
  title?: ReactNode
  unavailable?: string | undefined
  typeLabel?: (type: string) => string
  hideScope?: boolean
  projectName?: (memory: MemoryCardData) => string | undefined
}

/** 记忆和基线冲突：宽版按钮靠右，窄版按钮一行靠左，后果说明都在按钮下面。 */
export function VerticalConflictRuling(props: VerticalConflictRulingProps) {
  const t = useT()
  const { vertical } = CONFLICT_ACTION_VERDICTS
  const unavailable = props.unavailable ?? (props.memory === null ? t('conflict.missingHint') : undefined)
  return (
    <article className={`pm-conflict pm-conflict--${props.layout} pm-conflict--vertical`}>
      <header className="pm-conflict-head">
        <StatusMarker kind="pending" />
        <h3 className="pm-conflict-title">{props.title ?? t('conflict.vertical.title')}</h3>
      </header>
      <p className="pm-conflict-note">{t('conflict.vertical.baseline')}</p>
      <div className="pm-conflict-single">
        {props.memory === null
          ? <p className="pm-conflict-missing">{t('conflict.missing')}</p>
          : <MemoryCard memory={props.memory} now={props.now} typeLabel={props.typeLabel?.(props.memory.type)} hideScope={props.hideScope} projectName={props.projectName?.(props.memory)} />}
        <p className="pm-conflict-baseline">{t('conflict.vertical.baselineRef', { ref: props.baselineRef })}</p>
      </div>
      <div className="pm-conflict-buttons">
        <Button unavailable={unavailable} onClick={() => { props.onRule(vertical.keepBaseline) }}>{t('conflict.vertical.keepBaseline')}</Button>
        <Button unavailable={unavailable} onClick={() => { props.onRule(vertical.keepMemory) }}>{t('conflict.vertical.keepMemory')}</Button>
      </div>
      <p className="pm-conflict-consequence">{t('conflict.vertical.consequence')}</p>
    </article>
  )
}

export const conflictRulingCss = `
.pm-conflict { padding-bottom: 18px; }
.pm-conflict-head { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
.pm-conflict-title { margin: 0; font-size: 14px; font-weight: 600; line-height: 1.5; color: var(--pm-text); }
.pm-conflict-note { margin: -6px 0 12px 16px; font-size: 12px; line-height: 1.5; color: var(--pm-text-2); }
.pm-conflict-sides { display: flex; flex-direction: column; gap: 12px; }
.pm-conflict--wide .pm-conflict-sides { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; padding-left: 16px; }
.pm-conflict-side { display: flex; align-items: flex-start; gap: 8px; min-width: 0; }
.pm-conflict-body { display: flex; flex-direction: column; gap: 10px; flex: 1; min-width: 0; }
.pm-conflict-missing { margin: 0; font-size: 12px; line-height: 1.5; color: var(--pm-text-2); }
.pm-ab {
  display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0;
  width: 18px; height: 18px; margin-top: 2px; border-radius: 999px; border: 1px solid var(--pm-text);
  font-size: 11px; font-weight: 600; line-height: 1; color: var(--pm-text);
}
.pm-conflict-actions { display: flex; justify-content: flex-end; }
.pm-keep { margin: 2px 0 4px 42px; }
.pm-keep-line { display: flex; align-items: center; gap: 12px; }
.pm-keep-line > span { flex: 1; height: .5px; background: var(--pm-line-soft); }
.pm-conflict-buttons { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
.pm-conflict-consequence { margin: 6px 0 0; font-size: 12px; line-height: 1.6; color: var(--pm-text-2); }
.pm-keep .pm-conflict-consequence { text-align: center; }
.pm-conflict-single { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.pm-conflict--wide .pm-conflict-single { padding-left: 16px; }
.pm-conflict-baseline { margin: 0; padding-left: 14px; font-size: 12px; line-height: 1.5; color: var(--pm-text-2); overflow-wrap: anywhere; }
.pm-conflict--vertical.pm-conflict--wide .pm-conflict-buttons { justify-content: flex-end; }
.pm-conflict--vertical.pm-conflict--wide .pm-conflict-consequence { padding-left: 16px; }
`
