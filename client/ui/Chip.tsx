/**
 * Chip（DESIGN.md「Chips」）：
 * - result：中性底 + 绿色小圆点 + 文字，例如「已按 A」；
 * - neutral：浅灰胶囊，例如版本号、「规划中」。
 */
import type { ReactNode } from 'react'

export interface ChipProps { variant: 'result' | 'neutral'; children: ReactNode }

export function Chip({ variant, children }: ChipProps) {
  return (
    <span className={`pm-chip pm-chip--${variant}`}>
      {variant === 'result' ? <span className="pm-chip-dot" aria-hidden="true" /> : null}
      {children}
    </span>
  )
}

export const chipCss = `
.pm-chip {
  display: inline-flex; align-items: center; gap: 4px; flex-shrink: 0;
  font-size: 11px; line-height: 16px; padding: 1px 6px; border-radius: 4px;
  color: var(--pm-text); white-space: nowrap;
}
.pm-chip--result { background: var(--pm-bg-block); }
.pm-chip-dot { width: 6px; height: 6px; border-radius: 999px; background: var(--pm-success); }
.pm-chip--neutral { background: var(--pm-bg-block); color: var(--pm-text-2); border-radius: 999px; padding: 1px 8px; }
`
