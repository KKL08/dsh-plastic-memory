/**
 * 记忆列表行（DESIGN.md「Memory List Row」）：34px 高、圆角 10px、左内边距 16px；选中用银藤底，
 * 行首 4px 处一条 2px 银藤竖条（上下各留 9px）；悬停用 interactive-bg-hover。
 */
import type { ReactNode } from 'react'

export interface MemoryListRowProps {
  label: ReactNode
  /** 行尾的次要信息（如「全局」）。 */
  trailing?: ReactNode
  selected?: boolean
  onSelect?: () => void
}

export function MemoryListRow({ label, trailing, selected = false, onSelect }: MemoryListRowProps) {
  return (
    <button type="button" className={selected ? 'pm-row pm-row--on' : 'pm-row'} aria-current={selected || undefined} onClick={onSelect}>
      <span className="pm-row-label">{label}</span>
      {trailing !== undefined ? <span className="pm-row-trailing">{trailing}</span> : null}
    </button>
  )
}

export const memoryListRowCss = `
.pm-row {
  position: relative; display: flex; align-items: center; gap: 8px; width: 100%; height: 34px;
  padding: 0 12px 0 16px; border: 0; border-radius: 10px; background: transparent;
  font: inherit; font-size: 13px; color: var(--pm-text); text-align: left; cursor: pointer;
}
.pm-row:hover { background: var(--pm-hover); }
.pm-row--on { background: var(--pm-accent-tint); }
.pm-row--on::before {
  content: ''; position: absolute; left: 4px; top: 9px; bottom: 9px; width: 2px; border-radius: 2px; background: var(--pm-accent);
}
.pm-row-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pm-row-trailing { flex-shrink: 0; font-size: 12px; color: var(--pm-text-2); }
`
