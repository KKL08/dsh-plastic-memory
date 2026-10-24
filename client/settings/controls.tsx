/**
 * 设置页用到的控件，标记与样式对齐宿主 0.2.1-rc.2 ui-primitives（宿主规则不允许外部插件 require 它）：
 * Switch（Switch.tsx）、文本输入（settings-form/fields 的 .input / .invalid）、Dialog（Modal.tsx 的居中弹层）。
 */
import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export function Switch({ checked, onChange, label, disabled = false }: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className="pm-switch"
      onClick={() => { onChange(!checked) }}
    >
      <span className="pm-switch-thumb" />
    </button>
  )
}

/** 文本输入；`error` 非空时描红并在下方就地写原因（替换说明）。 */
export function TextField({ id, value, onChange, error, hint, multiline = false, readOnly = false, disabled = false, inputMode }: {
  id: string
  value: string
  onChange: (text: string) => void
  error?: string | undefined
  hint?: ReactNode
  multiline?: boolean
  readOnly?: boolean
  disabled?: boolean
  inputMode?: 'numeric'
}) {
  const messageId = `${id}-message`
  const props = {
    id, value, readOnly, disabled,
    className: multiline ? 'pm-input pm-input--multiline' : 'pm-input',
    'aria-describedby': error !== undefined || hint !== undefined ? messageId : undefined,
    ...(error !== undefined ? { 'aria-invalid': true } : {}),
  }
  return (
    <>
      {multiline
        ? <textarea rows={2} {...props} onChange={(event) => { onChange(event.target.value) }} />
        : <input type="text" inputMode={inputMode} {...props} onChange={(event) => { onChange(event.target.value) }} />}
      {error !== undefined
        ? <p id={messageId} className="pm-input-invalid" role="status">{error}</p>
        : hint !== undefined ? <p id={messageId} className="pm-setting-hint">{hint}</p> : null}
    </>
  )
}

/** 居中弹层：挂到 body，Esc 与点遮罩关闭，打开时聚焦第一个输入框，关闭后焦点回到打开它的元素。 */
export function Dialog({ title, closeLabel, onClose, footer, children }: {
  title: string
  closeLabel: string
  onClose: () => void
  footer: ReactNode
  children: ReactNode
}) {
  const dialog = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    dialog.current?.querySelector<HTMLElement>('input, textarea, button')?.focus()
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); close.current() } }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey); opener?.focus?.() }
  }, [])
  return createPortal((
    <div className="pm-root pm-dialog-root" role="presentation">
      <div className="pm-dialog-mask" aria-hidden="true" onClick={() => { close.current() }} />
      <div ref={dialog} className="pm-dialog" role="dialog" aria-modal="true" aria-label={title}>
        <div className="pm-dialog-header">
          <h2 className="pm-dialog-title">{title}</h2>
          <button type="button" className="pm-dialog-close" aria-label={closeLabel} onClick={() => { close.current() }}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><path d="m3.5 3.5 7 7m0-7-7 7" /></svg>
          </button>
        </div>
        <div className="pm-dialog-body">{children}</div>
        <div className="pm-dialog-footer">{footer}</div>
      </div>
    </div>
  ), document.body)
}

export const controlsCss = `
.pm-switch {
  position: relative; flex: 0 0 auto; width: 36px; height: 20px; padding: 2px; border: 0; border-radius: 999px;
  background: var(--dsw-alias-border-l3); cursor: pointer;
}
.pm-switch[aria-checked='true'] { background: var(--dsw-alias-brand-primary); }
.pm-switch:disabled { cursor: default; opacity: .5; }
.pm-switch-thumb {
  display: block; width: 16px; height: 16px; border-radius: 50%;
  background: var(--dsw-alias-label-primary-foreground); transition: transform 120ms ease;
}
.pm-switch[aria-checked='false'] .pm-switch-thumb { background: var(--dsw-alias-switch-thumb); }
.pm-switch[aria-checked='true'] .pm-switch-thumb { transform: translateX(16px); }

.pm-input {
  width: 100%; max-width: 320px; height: 34px; padding: 0 12px; border: .5px solid var(--pm-line-input);
  border-radius: var(--dsw-radius-md, 12px); background: var(--pm-bg-raised); font: inherit; font-size: 13px; line-height: 1.5; color: var(--pm-text);
}
.pm-input--multiline { max-width: none; height: auto; min-height: 56px; padding: 6px 12px; resize: vertical; }
.pm-input:focus-visible { outline: none; border-color: var(--dsw-alias-state-business-primary); }
.pm-input:disabled, .pm-input:read-only { color: var(--pm-text-3); cursor: default; }
.pm-input[aria-invalid='true'] { border-color: var(--pm-error); }
.pm-input-invalid { margin: 0; font-size: 12px; line-height: 1.5; color: var(--pm-error); }

.pm-dialog-root {
  position: fixed; inset: 0; z-index: 1000; display: flex; align-items: center; justify-content: center;
  padding: max(24px, var(--dsh-frame-overlay-top, 24px)) 24px;
}
.pm-dialog-mask { position: absolute; inset: var(--dsh-frame-chrome-top, 0px) 0 0; backdrop-filter: var(--dsw-mask-blur); background: var(--dsw-alias-bg-mask-1); }
.pm-dialog {
  position: relative; z-index: 1; display: flex; flex-direction: column; gap: 20px; width: min(440px, 100%); max-height: 100%;
  padding: 0 0 24px; overflow: hidden; border-radius: var(--dsw-radius-panel, 20px); background: var(--dsw-alias-bg-layer-2);
  box-shadow: var(--dsw-elevation-prominent);
}
.pm-dialog-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 22px 14px 0 24px; }
.pm-dialog-title { margin: 0; font-size: 16px; line-height: 24px; font-weight: 500; color: var(--pm-text); }
.pm-dialog-close {
  display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border: 0;
  border-radius: var(--dsw-radius-sm, 8px); background: transparent; color: var(--pm-text-2); cursor: pointer;
}
.pm-dialog-close:hover { background: var(--pm-hover); }
.pm-dialog-body { min-height: 0; overflow: auto; scrollbar-gutter: stable; padding: 0 24px; display: flex; flex-direction: column; gap: 14px; }
.pm-dialog-footer { display: flex; align-items: center; justify-content: flex-end; gap: 8px; padding: 0 24px; }
.pm-field { display: flex; flex-direction: column; gap: 6px; }
@media (prefers-reduced-motion: reduce) { .pm-switch-thumb { transition: none; } }
`
