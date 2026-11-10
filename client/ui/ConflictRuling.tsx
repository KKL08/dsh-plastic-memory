/**
 * 冲突裁决（DESIGN.md「Conflict Ruling」）：琥珀圆点 + 标题，A / B 描边圆标 + 各自的记忆卡，
 * 三个按钮「以 A 为准 / 以 B 为准 / 都保留」，按钮到 verdict 的映射取契约 CONFLICT_ACTION_VERDICTS。
 * 两版结构相同：标题下一句默认行为，A、B 记忆卡，后果说明进建议区（「说明」），下面三个平级按钮一排。
 * - 宽版（记忆页）：A、B 各一张描边卡并排，卡里只放记忆；按钮靠右，和其它卡的动作行对齐；
 * - 窄版（右侧栏）：A、B 上下排，按钮一行靠左。
 * 任一方定位不到（视图里为 null）时裁决会报错，三个按钮都不可用。裁决后的结果态在待处理票里做。
 * 败方含高危密钥（hasSecret）时裁决会彻底删除它：后果说明里那一句换成「将彻底删除、不可恢复」。
 * 记忆和基线（AGENTS.md）冲突用 VerticalConflictRuling：同一套标题与后果说明，只有一张记忆卡，
 * 按钮「以基线为准 / 保留这条记忆」，并写明基线不会被删除。
 */
import type { ReactNode } from 'react'
import { CONFLICT_ACTION_VERDICTS, type MemoryCard as MemoryCardData } from '../../src/gui/contract.ts'
import { useT } from '../i18n.tsx'
import { AdviceNote } from './Advice.tsx'
import { Button } from './Button.tsx'
import { MemoryCard } from './MemoryCard.tsx'
import { StatusMarker } from './StatusMarker.tsx'

type HorizontalVerdict = (typeof CONFLICT_ACTION_VERDICTS.horizontal)[keyof typeof CONFLICT_ACTION_VERDICTS.horizontal]
type VerticalVerdict = (typeof CONFLICT_ACTION_VERDICTS.vertical)[keyof typeof CONFLICT_ACTION_VERDICTS.vertical]

/** 两版共用的参数。 */
interface RulingSharedProps {
  layout: 'wide' | 'narrow'
  now: number
  /** 缺省各自的默认标题；记忆页用条目标题。 */
  title?: ReactNode
  /** 动作暂不可用的原因（无会话等）。 */
  unavailable?: string | undefined
  typeLabel?: (type: string) => string
  hideScope?: boolean
  /** 记忆在别的项目里时的项目名（见 MemoryCard 的 projectName）。 */
  projectName?: (memory: MemoryCardData) => string | undefined
  /** 标题后面的附加内容（记忆页「全部」里的范围胶囊）。 */
  headExtra?: ReactNode
}

export interface ConflictRulingProps extends RulingSharedProps {
  left: MemoryCardData | null
  right: MemoryCardData | null
  onRule: (verdict: HorizontalVerdict) => void
  /** 一句默认行为（「决定之前，agent 按 A 来做。」），在标题下。 */
  note?: string
}

export function ConflictRuling(props: ConflictRulingProps) {
  const t = useT()
  const { horizontal } = CONFLICT_ACTION_VERDICTS
  const isSecretA = props.left?.hasSecret === true
  const isSecretB = props.right?.hasSecret === true
  const consequence = isSecretA && isSecretB ? 'conflict.consequence.secretBoth'
    : isSecretA ? 'conflict.consequence.secretA' : isSecretB ? 'conflict.consequence.secretB' : 'conflict.consequence'
  const side = (letter: 'A' | 'B', memory: MemoryCardData | null) => (
    <section className="pm-conflict-side" aria-label={t('conflict.side', { side: letter })}>
      <span className="pm-ab" aria-hidden="true">{letter}</span>
      <div className="pm-conflict-body"><RulingMemory {...props} memory={memory} /></div>
    </section>
  )
  return (
    <RulingShell
      {...props}
      title={props.title ?? t('conflict.title')}
      isMissing={props.left === null || props.right === null}
      consequence={t(consequence)}
      actions={[
        [t('conflict.keepA'), () => { props.onRule(horizontal.keepA) }],
        [t('conflict.keepB'), () => { props.onRule(horizontal.keepB) }],
        [t('conflict.keepBoth'), () => { props.onRule(horizontal.keepBoth) }],
      ]}
    >
      <div className="pm-conflict-sides">
        {side('A', props.left)}
        {side('B', props.right)}
      </div>
    </RulingShell>
  )
}

export interface VerticalConflictRulingProps extends RulingSharedProps {
  memory: MemoryCardData | null
  /** 基线出处（「AGENTS.md：包管理」）。 */
  baselineRef: string
  onRule: (verdict: VerticalVerdict) => void
}

/** 记忆和基线冲突：结构同上，只有一张记忆卡。 */
export function VerticalConflictRuling(props: VerticalConflictRulingProps) {
  const t = useT()
  const { vertical } = CONFLICT_ACTION_VERDICTS
  return (
    <RulingShell
      {...props}
      title={props.title ?? t('conflict.vertical.title')}
      note={t('conflict.vertical.baseline')}
      isMissing={props.memory === null}
      consequence={t(props.memory?.hasSecret === true ? 'conflict.vertical.consequence.secret' : 'conflict.vertical.consequence')}
      actions={[
        [t('conflict.vertical.keepBaseline'), () => { props.onRule(vertical.keepBaseline) }],
        [t('conflict.vertical.keepMemory'), () => { props.onRule(vertical.keepMemory) }],
      ]}
    >
      <div className="pm-conflict-single">
        <RulingMemory {...props} />
        <p className="pm-conflict-baseline">{t('conflict.vertical.baselineRef', { ref: props.baselineRef })}</p>
      </div>
    </RulingShell>
  )
}

/** 两版共用的外壳：标题行、标题下一句、各自的记忆区、后果说明、一排按钮。任一方定位不到（isMissing）时按钮都不可用。 */
function RulingShell({ layout, title, headExtra, note, unavailable, isMissing, consequence, actions, children }: RulingSharedProps & {
  note?: string | undefined
  isMissing: boolean
  consequence: string
  /** 按钮文字与点击动作，按显示顺序。 */
  actions: ReadonlyArray<readonly [label: string, onClick: () => void]>
  children: ReactNode
}) {
  const t = useT()
  const reason = unavailable ?? (isMissing ? t('conflict.missingHint') : undefined)
  return (
    <article className={`pm-conflict pm-conflict--${layout}`}>
      <header className="pm-conflict-head">
        <span className="pm-conflict-mark"><StatusMarker kind="pending" /></span>
        <h3 className="pm-conflict-title">{title}</h3>
        {headExtra}
      </header>
      {note !== undefined ? <p className="pm-conflict-note">{note}</p> : null}
      {children}
      <div className="pm-conflict-advice"><AdviceNote label="note">{consequence}</AdviceNote></div>
      <div className="pm-conflict-buttons">
        {actions.map(([label, onClick]) => <Button key={label} unavailable={reason} onClick={onClick}>{label}</Button>)}
      </div>
    </article>
  )
}

/** 一方的记忆卡；定位不到时一句说明。 */
function RulingMemory({ memory, now, typeLabel, hideScope, projectName }: RulingSharedProps & { memory: MemoryCardData | null }) {
  const t = useT()
  return memory === null
    ? <p className="pm-conflict-missing">{t('conflict.missing')}</p>
    : <MemoryCard memory={memory} now={now} typeLabel={typeLabel?.(memory.type)} hideScope={hideScope} projectName={projectName?.(memory)} />
}

export const conflictRulingCss = `
.pm-conflict { padding-bottom: 18px; }
.pm-conflict-head { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
/* 记忆页（宽版）的标记列和处理视图其他卡片一样 14px，标题和下面各段都从 22px 起；侧栏窄版不变 */
.pm-conflict-mark { display: inline-flex; }
.pm-conflict--wide .pm-conflict-mark { justify-content: center; flex: 0 0 14px; }
.pm-conflict--wide .pm-conflict-note { margin-left: 22px; }
/* 标题是模型写的摘要，可能带长函数名、路径：允许在任意处折行，不把右边的胶囊挤出去 */
.pm-conflict-title { margin: 0; min-width: 0; overflow-wrap: anywhere; font-size: 14px; font-weight: 600; line-height: 1.5; color: var(--pm-text); }
.pm-conflict-note { margin: -6px 0 12px 16px; font-size: 12px; line-height: 1.5; color: var(--pm-text-2); }
.pm-conflict-sides { display: flex; flex-direction: column; gap: 12px; }
.pm-conflict--wide .pm-conflict-sides { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; padding-left: 22px; }
.pm-conflict-side { display: flex; align-items: flex-start; gap: 8px; min-width: 0; }
.pm-conflict-body { display: flex; flex-direction: column; gap: 10px; flex: 1; min-width: 0; }
.pm-conflict-missing { margin: 0; font-size: 12px; line-height: 1.5; color: var(--pm-text-2); }
.pm-ab {
  flex-shrink: 0; min-width: 10px;
  font-size: 13px; font-weight: 600; line-height: 22px; color: var(--pm-text-2);
}
.pm-conflict--wide .pm-conflict-side { padding: 12px 14px; border: .5px solid var(--pm-line-card); border-radius: var(--dsw-radius-lg, 16px); }
/* A / B 改成上下排：记忆页窄屏（pm-page 720px 以下），或主区（pm-main，不含左栏）内容宽 640px 以下 */
@container pm-page (max-width: 720px) { .pm-conflict--wide .pm-conflict-sides { grid-template-columns: minmax(0, 1fr); } }
@container pm-main (max-width: 640px) { .pm-conflict--wide .pm-conflict-sides { grid-template-columns: minmax(0, 1fr); } }
.pm-conflict-buttons { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
.pm-conflict-advice { margin-top: 12px; }
.pm-conflict-single { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.pm-conflict--wide .pm-conflict-single { padding-left: 22px; }
.pm-conflict-baseline { margin: 0; padding-left: 14px; font-size: 12px; line-height: 1.5; color: var(--pm-text-2); overflow-wrap: anywhere; }
.pm-conflict--wide .pm-conflict-buttons { justify-content: flex-end; }
.pm-conflict--wide .pm-conflict-advice { padding-left: 22px; }
`
