/**
 * 建议区与结果行（DESIGN.md「Advice」）：记忆卡下面，用一条细线和记忆隔开，动作行跟在建议区下面。
 * - AdviceNote：开头一个加粗的「建议」（冲突裁决写「说明」），后面一段次文字，写来由和每个动作的后果。
 * - ResultLine：处理之后建议区和动作原位换成它：结果 chip + 一句后果 + 撤销（能撤销时）。前面没有记忆卡时（卡片没留下）传 isStandalone，不画细线。
 * 状态和它的动作放在一起，记忆卡的元信息行只放属性。
 */
import type { ReactNode } from 'react'
import { useT } from '../i18n.tsx'
import { Chip } from './Chip.tsx'

export function AdviceNote({ label = 'advice', children }: { label?: 'advice' | 'note'; children: ReactNode }) {
  const t = useT()
  return (
    <div className="pm-advice">
      <span className="pm-advice-label">{t(label === 'note' ? 'advice.label.note' : 'advice.label')}</span>
      <p className="pm-advice-text">{children}</p>
    </div>
  )
}

export function ResultLine({ chip, children, undo, isStandalone = false }: { chip: string; children: ReactNode; undo?: ReactNode; isStandalone?: boolean }) {
  return (
    <div className={isStandalone ? 'pm-result-line pm-result-line--standalone' : 'pm-result-line'}>
      <Chip variant="result">{chip}</Chip>
      <p className="pm-result-text">{children}</p>
      {undo}
    </div>
  )
}

export const adviceCss = `
.pm-advice, .pm-result-line { display: flex; gap: 8px; margin: 0; padding-top: 10px; border-top: .5px solid var(--pm-line); }
.pm-advice-label { flex: none; font-size: 12px; font-weight: 600; line-height: 1.6; color: var(--pm-text); }
.pm-advice-text, .pm-result-text { flex: 1; min-width: 0; margin: 0; font-size: 12px; line-height: 1.6; color: var(--pm-text-2); }
.pm-result-line { align-items: center; flex-wrap: wrap; }
.pm-result-line .pm-link { font-size: 12px; }
.pm-result-line--standalone { padding-top: 0; border-top: 0; }
`
