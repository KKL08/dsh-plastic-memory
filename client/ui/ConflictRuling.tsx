/**
 * 冲突裁决（DESIGN.md「Conflict Ruling」）：琥珀圆点 + 标题，A / B 字母标记（不套圆、不加底）+ 各自的记忆卡。
 * 横向冲突 A、B 下面的整块由调用方给（footer）：记忆页是处理卡的建议块、说明行和按钮行（pending/cards.tsx HorizontalActions），
 * 右侧栏是建议结论一行和「采纳建议」或去记忆页的入口（sidebar/SidebarTab.tsx）。
 * - 宽版（记忆页）：A、B 各一张描边卡并排，卡里只放记忆；按钮靠右，和其它卡的动作行对齐；
 * - 窄版（右侧栏）：A、B 上下排，按钮一行靠左。
 * 记忆和基线（AGENTS.md / CLAUDE.md）冲突用 VerticalConflictRuling：只有一张记忆卡，标题下写明基线不会被删除；
 * 下面的整块同样由调用方给（记忆页是同一张处理卡，右侧栏是建议结论一行和「采纳建议」或去记忆页的入口）。
 */
import type { ReactNode } from 'react'
import type { MemoryCard as MemoryCardData } from '../../src/gui/contract.ts'
import { useT } from '../i18n.tsx'
import { MemoryCard } from './MemoryCard.tsx'
import { StatusMarker } from './StatusMarker.tsx'

/** 两版共用的参数。 */
interface RulingSharedProps {
  layout: 'wide' | 'narrow'
  now: number
  /** 缺省各自的默认标题；记忆页用条目标题。 */
  title?: ReactNode
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
  /** 一句默认行为（「决定之前，agent 按 A 来做。」），在标题下。 */
  note?: string | undefined
  /** A、B 下面的整块：建议、说明和动作。 */
  footer: ReactNode
}

export function ConflictRuling(props: ConflictRulingProps) {
  const t = useT()
  const side = (letter: 'A' | 'B', memory: MemoryCardData | null) => (
    <section className="pm-conflict-side" aria-label={t('conflict.side', { side: letter })}>
      <span className="pm-ab" aria-hidden="true">{letter}</span>
      <div className="pm-conflict-body"><RulingMemory {...props} memory={memory} /></div>
    </section>
  )
  return (
    <RulingShell {...props} title={props.title ?? t('conflict.title')}>
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
  /** 记忆卡下面的整块：建议、说明和动作。 */
  footer: ReactNode
}

/** 记忆和基线冲突：结构同上，只有一张记忆卡。 */
export function VerticalConflictRuling(props: VerticalConflictRulingProps) {
  const t = useT()
  return (
    <RulingShell {...props} title={props.title ?? t('conflict.vertical.title')} note={t('conflict.vertical.baseline')}>
      <div className="pm-conflict-single">
        <RulingMemory {...props} />
        <p className="pm-conflict-baseline">{t('conflict.vertical.baselineRef', { ref: props.baselineRef })}</p>
      </div>
    </RulingShell>
  )
}

/** 两版共用的外壳：标题行、标题下一句、各自的记忆区，下面是调用方给的 footer。 */
function RulingShell({ layout, title, headExtra, note, footer, children }: RulingSharedProps & {
  note?: string | undefined
  footer: ReactNode
  children: ReactNode
}) {
  return (
    <article className={`pm-conflict pm-conflict--${layout}`}>
      <header className="pm-conflict-head">
        <span className="pm-conflict-mark"><StatusMarker kind="pending" /></span>
        <h3 className="pm-conflict-title">{title}</h3>
        {headExtra}
      </header>
      {note !== undefined ? <p className="pm-conflict-note">{note}</p> : null}
      {children}
      <div className="pm-conflict-footer">{footer}</div>
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
.pm-conflict-single { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.pm-conflict--wide .pm-conflict-single { padding-left: 22px; }
.pm-conflict-baseline { margin: 0; padding-left: 14px; font-size: 12px; line-height: 1.5; color: var(--pm-text-2); overflow-wrap: anywhere; }
.pm-conflict-footer { display: flex; flex-direction: column; gap: 12px; margin-top: 12px; }
.pm-conflict--wide .pm-conflict-footer { padding-left: 22px; }
/* footer 里的按钮行（采纳建议、三个候选项）靠左，采纳在前 */
.pm-conflict-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
`
