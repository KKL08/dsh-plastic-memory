/**
 * 宿主两种分段控件的对齐版（技能禁止外部插件 require ui-primitives，标记与 CSS 对齐宿主 0.2.1-rc.2）：
 * - SegmentedTabs：插件页顶部的页内 tab（ui-primitives/SegmentedTabs），记忆页四个 tab 用它；
 * - SegmentedControl：设置卡里切换模式（ui-primitives/SegmentedControl），如「自动放宽 / 严格按上限」。
 * 两者都是受控的 tablist，左右键 / Home / End 切换，只有选中项是 tab 停靠点，面板由调用方渲染。
 */
import { useEffect, useRef, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react'

export interface SegmentedTab<Value extends string = string> {
  value: Value
  label: ReactNode
  id: string
  panelId: string
}

export function SegmentedTabs<Value extends string>({ items, value, onChange, label }: {
  items: readonly [SegmentedTab<Value>, ...SegmentedTab<Value>[]]
  value: Value
  onChange: (value: Value) => void
  label: string
}) {
  const selectedIndex = items.findIndex(item => item.value === value)
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next: number
    switch (event.key) {
      case 'ArrowLeft': next = (index + items.length - 1) % items.length; break
      case 'ArrowRight': next = (index + 1) % items.length; break
      case 'Home': next = 0; break
      case 'End': next = items.length - 1; break
      default: return
    }
    event.preventDefault()
    event.stopPropagation()
    const nextItem = items[next]
    if (nextItem === undefined) return
    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]').item(next).focus()
    onChange(nextItem.value)
  }
  return (
    <div role="tablist" aria-label={label} className="pm-tabs" style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }}>
      <span
        className="pm-tabs-indicator"
        aria-hidden="true"
        style={{ width: `calc((100% - 8px) / ${items.length})`, transform: `translateX(${selectedIndex * 100}%)` }}
      />
      {items.map((item, index) => (
        <button
          key={item.value}
          id={item.id}
          type="button"
          role="tab"
          className="pm-tab"
          aria-selected={value === item.value}
          aria-controls={item.panelId}
          tabIndex={value === item.value ? 0 : -1}
          onClick={() => { onChange(item.value) }}
          onKeyDown={(event) => { onKeyDown(event, index) }}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}

export interface SegmentedControlOption<Value extends string> {
  value: Value
  label: string
  disabled?: boolean
  /** 悬停提示，通常是为什么锁着。 */
  title?: string
}

type WalkKey = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown' | 'Home' | 'End'

function isWalkKey(key: string): key is WalkKey {
  return key === 'ArrowLeft' || key === 'ArrowRight' || key === 'ArrowUp' || key === 'ArrowDown' || key === 'Home' || key === 'End'
}

function walk<Value extends string>(options: readonly SegmentedControlOption<Value>[], from: number, key: WalkKey) {
  const enabled = options.filter(option => option.disabled !== true)
  if (key === 'Home') return enabled[0]
  if (key === 'End') return enabled[enabled.length - 1]
  const step = key === 'ArrowRight' || key === 'ArrowDown' ? 1 : -1
  const count = options.length
  for (let offset = 1; offset < count; offset += 1) {
    const candidate = options[((from + step * offset) % count + count) % count]
    if (candidate !== undefined && candidate.disabled !== true) return candidate
  }
  return undefined
}

export function SegmentedControl<Value extends string>({ id, value, options, onChange, label, disabled = false }: {
  /** 每个 tab 的 id 是 `<id>-<value>`，控制 `<id>-<value>-panel`。 */
  id: string
  value: Value
  options: readonly SegmentedControlOption<Value>[]
  onChange: (next: Value) => void
  label: string
  disabled?: boolean
}) {
  const list = useRef<HTMLDivElement>(null)
  const selected = options.findIndex(option => option.value === value)
  useEffect(() => {
    const root = list.current
    if (root === null || !root.contains(document.activeElement)) return
    root.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')?.focus()
  }, [value])
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (!isWalkKey(event.key)) return
    event.preventDefault()
    const target = walk(options, selected, event.key)
    if (target !== undefined && target.value !== value) onChange(target.value)
  }
  const indicator = { '--pm-segment-count': String(options.length), '--pm-segment-index': String(selected) } as CSSProperties
  // 一项都没选（必填项还没填）时不画指示块，第一个可用项当 tab 停靠点
  const stop = selected >= 0 ? options[selected]?.value : options.find(option => option.disabled !== true)?.value
  return (
    <div ref={list} role="tablist" aria-label={label} className="pm-segmented" style={indicator}>
      {selected >= 0 ? <span aria-hidden="true" className="pm-segmented-indicator" /> : null}
      {options.map((option) => {
        const active = option.value === value
        return (
          <button
            key={option.value}
            id={`${id}-${option.value}`}
            type="button"
            role="tab"
            aria-selected={active}
            aria-controls={`${id}-${option.value}-panel`}
            tabIndex={option.value === stop ? 0 : -1}
            disabled={disabled || option.disabled === true}
            title={option.title}
            className="pm-segment"
            onClick={() => { if (!active) onChange(option.value) }}
            onKeyDown={onKeyDown}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

export const segmentedCss = `
.pm-tabs { position: relative; display: grid; padding: 4px; border-radius: var(--dsw-radius-lg, 16px); background: var(--pm-bg-block); }
.pm-tabs-indicator {
  position: absolute; inset: 4px auto 4px 4px; border: .5px solid var(--pm-line-card);
  border-radius: var(--dsw-radius-md, 12px); background: var(--pm-bg-raised); transition: transform 180ms ease; pointer-events: none;
}
.pm-tab {
  position: relative; display: inline-flex; align-items: center; justify-content: center; gap: 4px; height: 34px; padding: 0 12px;
  border: none; border-radius: var(--dsw-radius-md, 12px); background: transparent; cursor: pointer;
  font: inherit; font-size: 14px; line-height: 20px; color: var(--pm-text-2); transition: color 180ms ease;
}
.pm-tab:hover, .pm-tab[aria-selected='true'] { color: var(--pm-text); }
.pm-tab[aria-selected='true'] { font-weight: 600; }
.pm-root .pm-tab:focus-visible { outline: none; text-decoration: underline; text-decoration-thickness: 1px; text-underline-offset: 4px; }

.pm-segmented {
  position: relative; display: inline-grid; grid-auto-flow: column; grid-auto-columns: 1fr; gap: 2px; padding: 4px;
  border-radius: var(--dsw-radius-md, 12px); background: var(--pm-hover);
}
.pm-segmented-indicator {
  position: absolute; top: 4px; left: 4px;
  width: calc((100% - 8px - 2px * (var(--pm-segment-count) - 1)) / var(--pm-segment-count)); height: calc(100% - 8px);
  border: 0; border-radius: var(--dsw-radius-sm, 8px); background: var(--pm-bg); box-shadow: var(--dsw-elevation-soft);
  transform: translateX(calc(var(--pm-segment-index) * (100% + 2px))); transition: transform 160ms ease; pointer-events: none;
}
.pm-segment {
  position: relative; z-index: 1; height: 28px; padding: 0 16px; border: 0; border-radius: var(--dsw-radius-sm, 8px);
  background: transparent; color: var(--pm-text-2); font: inherit; font-size: 13px; line-height: 20px; font-weight: 500;
  white-space: nowrap; cursor: pointer; transition: color 120ms ease;
}
.pm-segment:hover:not(:disabled), .pm-segment[aria-selected='true'] { color: var(--pm-text); }
.pm-segment:disabled { cursor: default; opacity: .4; }
.pm-root .pm-segment:focus-visible { outline-offset: -2px; }
@media (prefers-reduced-motion: reduce) {
  .pm-tabs-indicator, .pm-tab, .pm-segmented-indicator, .pm-segment { transition: none; }
}
`
