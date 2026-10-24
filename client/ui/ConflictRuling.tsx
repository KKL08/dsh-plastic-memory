/**
 * 冲突裁决（DESIGN.md「Conflict Ruling」）：琥珀圆点 + 标题，A / B 描边圆标 + 各自的记忆卡，
 * 三个按钮「以 A 为准 / 以 B 为准 / 都保留」，按钮到 verdict 的映射取契约 CONFLICT_ACTION_VERDICTS。
 * - 宽版（记忆页）：A、B 按钮进各自卡片底部，「都保留」居中压在横贯两卡的细线上，下方紧跟后果说明；
 * - 窄版（右侧栏）：三个按钮一行，后果说明在按钮下面。
 * 任一方定位不到（视图里为 null）时裁决会报错，三个按钮都不可用。裁决后的结果态在待处理票里做。
 */
import type { ReactNode } from 'react'
import { CONFLICT_ACTION_VERDICTS, type MemoryCard as MemoryCardData } from '../../src/gui/contract.ts'
import { useT } from '../i18n.tsx'
import { Button } from './Button.tsx'
import { MemoryCard } from './MemoryCard.tsx'
import { StatusMarker } from './StatusMarker.tsx'

type HorizontalVerdict = (typeof CONFLICT_ACTION_VERDICTS.horizontal)[keyof typeof CONFLICT_ACTION_VERDICTS.horizontal]

export interface ConflictRulingProps {
  layout: 'wide' | 'narrow'
  left: MemoryCardData | null
  right: MemoryCardData | null
  now: number
  onRule: (verdict: HorizontalVerdict) => void
  /** 缺省「两条记忆互相矛盾，等你决定」；记忆页用条目标题。 */
  title?: ReactNode
  /** 动作暂不可用的原因（无会话等）。 */
  unavailable?: string | undefined
  typeLabel?: (type: string) => string
  hideScope?: boolean
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
          : <MemoryCard memory={memory} now={props.now} typeLabel={props.typeLabel?.(memory.type)} hideScope={props.hideScope} />}
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

export const conflictRulingCss = `
.pm-conflict { padding-bottom: 18px; }
.pm-conflict-head { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
.pm-conflict-title { margin: 0; font-size: 14px; font-weight: 600; line-height: 1.5; color: var(--pm-text); }
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
`
