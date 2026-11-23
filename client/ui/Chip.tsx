/**
 * Chip（DESIGN.md「Chips」）：
 * - result：中性底 + 绿色小圆点 + 文字，例如「已保留「名称」」；文字里带记忆名称，过长时单行截断加省略号，不撑出行宽；
 * - neutral：浅灰胶囊，例如版本号、「规划中」。
 */
import type { ReactNode } from 'react'

export interface ChipProps { variant: 'result' | 'neutral'; children: ReactNode }

export function Chip({ variant, children }: ChipProps) {
  return (
    <span className={`pm-chip pm-chip--${variant}`}>
      {variant === 'result' ? <><span className="pm-chip-dot" aria-hidden="true" /><span className="pm-chip-text">{children}</span></> : children}
    </span>
  )
}

export const chipCss = `
.pm-chip {
  display: inline-flex; align-items: center; gap: 4px; flex-shrink: 0;
  font-size: 11px; line-height: 16px; padding: 1px 6px; border-radius: 4px;
  color: var(--pm-text); white-space: nowrap; max-width: 100%;
}
.pm-chip-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.pm-chip--result { background: var(--pm-bg-block); }
.pm-chip-dot { flex: none; width: 6px; height: 6px; border-radius: 999px; background: var(--pm-success); }
.pm-chip--neutral { background: var(--pm-bg-block); color: var(--pm-text-2); border-radius: 999px; padding: 1px 8px; }
`
