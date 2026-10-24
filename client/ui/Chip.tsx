/**
 * Chip（DESIGN.md「Chips」）：
 * - status：状态主色 12% 混进面板底、字用主文字色（The Mixed Chip Rule），例如「有冲突」「待确认」；
 * - result：中性底 + 绿色小圆点 + 文字，例如「已按 A」；
 * - neutral：浅灰胶囊，例如版本号、「规划中」。
 */
import type { ReactNode } from 'react'

export type ChipProps =
  | { variant: 'status'; tone: 'warn' | 'error' | 'success'; children: ReactNode }
  | { variant: 'result' | 'neutral'; children: ReactNode }

export function Chip(props: ChipProps) {
  const modifier = props.variant === 'status' ? `pm-chip--${props.tone}` : `pm-chip--${props.variant}`
  return (
    <span className={`pm-chip ${modifier}`}>
      {props.variant === 'result' ? <span className="pm-chip-dot" aria-hidden="true" /> : null}
      {props.children}
    </span>
  )
}

export const chipCss = `
.pm-chip {
  display: inline-flex; align-items: center; gap: 4px; flex-shrink: 0;
  font-size: 11px; line-height: 16px; padding: 1px 6px; border-radius: 4px;
  color: var(--pm-text); white-space: nowrap;
}
.pm-chip--warn { background: color-mix(in srgb, var(--pm-warn) 12%, var(--pm-bg)); }
.pm-chip--error { background: color-mix(in srgb, var(--pm-error) 12%, var(--pm-bg)); }
.pm-chip--success { background: color-mix(in srgb, var(--pm-success) 12%, var(--pm-bg)); }
.pm-chip--result { background: var(--pm-bg-block); }
.pm-chip-dot { width: 6px; height: 6px; border-radius: 999px; background: var(--pm-success); }
.pm-chip--neutral { background: var(--pm-bg-block); color: var(--pm-text-2); border-radius: 999px; padding: 1px 8px; }
`
