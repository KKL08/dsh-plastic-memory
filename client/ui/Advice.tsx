/**
 * 建议区与结果行（DESIGN.md「Advice」）：记忆卡下面、动作行上面。不画细线：细线只用来分条目，建议区靠开头的图标认出来。
 * - AdviceNote：图标 + 加粗的「建议」（灯泡；冲突裁决写「说明」，信息图标），后面一段次文字，写来由和每个动作的后果。
 * - ResultLine：处理之后建议区和动作原位换成它：结果 chip（自带圆点，不另加图标）+ 一句后果 + 撤销（能撤销时）。
 * 状态和它的动作放在一起，记忆卡的元信息行只放属性。
 */
import type { ReactNode } from 'react'
import { useT } from '../i18n.tsx'
import { Chip } from './Chip.tsx'
import { Icon } from './Icon.tsx'

/** 灯泡：宿主图标集里没有，按同一规格画（16 栅格、1px 描边、currentColor）。 */
function BulbIcon() {
  return (
    <svg width={15} height={15} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1} strokeLinecap="square" aria-hidden="true">
      <path d="M6.2 10.8V10.3C4.7 9.5 3.6 8 3.6 6.3C3.6 3.9 5.6 2 8 2C10.4 2 12.4 3.9 12.4 6.3C12.4 8 11.3 9.5 9.8 10.3V10.8" />
      <path d="M6.2 12.3H9.8" />
      <path d="M6.9 14.1H9.1" />
    </svg>
  )
}

export function AdviceNote({ label = 'advice', children }: { label?: 'advice' | 'note'; children: ReactNode }) {
  const t = useT()
  return (
    <div className="pm-advice">
      {label === 'note' ? <Icon name="info" size={15} /> : <BulbIcon />}
      <span className="pm-advice-label">{t(label === 'note' ? 'advice.label.note' : 'advice.label')}</span>
      <p className="pm-advice-text">{children}</p>
    </div>
  )
}

export function ResultLine({ chip, children, undo }: { chip: string; children: ReactNode; undo?: ReactNode }) {
  return (
    <div className="pm-result-line">
      <Chip variant="result">{chip}</Chip>
      <p className="pm-result-text">{children}</p>
      {undo}
    </div>
  )
}

export const adviceCss = `
.pm-advice, .pm-result-line { display: flex; gap: 6px; margin: 0; padding-top: 4px; }
.pm-advice > svg { flex: none; margin-top: 2px; color: var(--pm-text); }
.pm-advice-label { flex: none; margin-right: 2px; font-size: 12px; font-weight: 600; line-height: 1.6; color: var(--pm-text); }
.pm-advice-text, .pm-result-text { flex: 1; min-width: 0; margin: 0; font-size: 12px; line-height: 1.6; color: var(--pm-text-2); }
.pm-result-line { align-items: center; flex-wrap: wrap; gap: 8px; }
.pm-result-line .pm-link { font-size: 12px; }
`
