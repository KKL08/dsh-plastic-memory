/**
 * 设置页用到的宿主控件对齐版（标记与 CSS 对齐宿主 0.2.1-rc.2 ui-primitives，技能禁止外部插件 require 它）：
 * 文本输入（settings-form/fields 的 .input / .invalid）、Dialog（Modal.tsx 的居中弹层）、开关（Switch）。
 * 步进（Stepper）宿主没有，借分段控件的轨道：两头各一个方按钮，中间是当前值。
 */
import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useGateway } from '../gateway.ts'

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

/** 开关：开关状态只看 aria-checked，样子和读屏念的不会对不上。名字由设置项的标签给（id 对上 htmlFor）。 */
export function Switch({ id, checked, onChange, disabled = false }: {
  id: string
  checked: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
}) {
  return (
    <button id={id} type="button" role="switch" aria-checked={checked} disabled={disabled} className="pm-switch" onClick={() => { onChange(!checked) }}>
      <span className="pm-switch-thumb" aria-hidden="true" />
    </button>
  )
}

/**
 * 步进：一组两个按钮夹着当前值，到两端那一头的按钮置灰。值变了读屏念新值（aria-live）。
 * @param labelledBy 设置项标签的 id，作这一组的名字。
 */
export function Stepper({ labelledBy, value, lessLabel, moreLabel, canLess, canMore, onStep, disabled = false }: {
  labelledBy: string
  value: ReactNode
  lessLabel: string
  moreLabel: string
  canLess: boolean
  canMore: boolean
  onStep: (direction: 1 | -1) => void
  disabled?: boolean
}) {
  return (
    <div role="group" aria-labelledby={labelledBy} className={disabled ? 'pm-stepper pm-stepper--disabled' : 'pm-stepper'}>
      <button type="button" className="pm-stepper-btn" aria-label={lessLabel} disabled={disabled || !canLess} onClick={() => { onStep(-1) }}>−</button>
      <span className="pm-stepper-value" aria-live="polite">{value}</span>
      <button type="button" className="pm-stepper-btn" aria-label={moreLabel} disabled={disabled || !canMore} onClick={() => { onStep(1) }}>+</button>
    </div>
  )
}

const TABBABLE = 'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'

/**
 * 居中弹层：挂到 body，Esc 与点遮罩关闭，打开时聚焦第一个输入框（没有就第一个控件），关闭后焦点回到打开它的元素。
 * aria-modal：Tab / Shift+Tab 在弹层里循环，焦点跑到外面时 Tab 拉回第一个控件。
 * 给了 onBack 时标题左边多一个「‹ 返回」：同一个弹层换内容（场景弹层里的类型表单），不叠第二层。
 * 换内容时用 key 重挂，打开时的聚焦随之重来。
 */
export function Dialog({ title, closeLabel, onClose, footer, children, onBack, backLabel }: {
  title: string
  closeLabel: string
  onClose: () => void
  footer: ReactNode
  children: ReactNode
  onBack?: (() => void) | undefined
  backLabel?: string
}) {
  const accent = useGateway().useConfig()?.accent
  const dialog = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    // 逐个元素筛，保证按文档顺序（选择器列表的查询结果有的实现不按文档顺序）
    const tabbable = () => [...dialog.current?.querySelectorAll<HTMLElement>('*') ?? []].filter(el => el.matches(TABBABLE))
    const initial = tabbable().find(el => el.matches('input, textarea')) ?? tabbable()[0]
    initial?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.stopPropagation(); close.current(); return }
      if (event.key !== 'Tab') return
      const items = tabbable()
      const first = items[0]
      const last = items.at(-1)
      if (first === undefined || last === undefined) return
      const active = document.activeElement
      const isInside = dialog.current?.contains(active) ?? false
      if (!isInside || (event.shiftKey ? active === first : active === last)) {
        event.preventDefault()
        const target = event.shiftKey && isInside ? last : first
        target.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey); opener?.focus?.() }
  }, [])
  return createPortal((
    <div className="pm-root pm-dialog-root" role="presentation" data-pm-accent={accent}>
      <div className="pm-dialog-mask" aria-hidden="true" onClick={() => { close.current() }} />
      <div ref={dialog} className="pm-dialog" role="dialog" aria-modal="true" aria-label={title}>
        <div className="pm-dialog-header">
          <h2 className="pm-dialog-title">
            {onBack !== undefined ? <button type="button" className="pm-dialog-back" onClick={onBack}>{backLabel}</button> : null}
            {title}
          </h2>
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
.pm-dialog-mask, .pm-dialog { animation: pm-dialog-in 200ms cubic-bezier(0.4, 0, 0.2, 1); }
@keyframes pm-dialog-in { from { opacity: 0; } }
@media (prefers-reduced-motion: reduce) { .pm-dialog-mask, .pm-dialog { animation: none; } }
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
.pm-dialog-back {
  margin-right: 6px; padding: 0; border: 0; background: none; font: inherit; font-size: 13px; font-weight: 400;
  color: var(--pm-text-2); cursor: pointer;
}
.pm-dialog-back:hover { color: var(--pm-text); }
.pm-dialog-body { min-height: 0; overflow: auto; scrollbar-gutter: stable; padding: 0 24px; display: flex; flex-direction: column; gap: 14px; }
.pm-dialog-footer { display: flex; align-items: center; justify-content: flex-end; gap: 8px; padding: 0 24px; }
.pm-field { display: flex; flex-direction: column; gap: 6px; }

/* 开关：对齐宿主 Switch（36×20，开时品牌色，关时 border-l3；滑块 120ms 平移） */
.pm-switch {
  position: relative; flex: 0 0 auto; width: 36px; height: 20px; padding: 2px; border: 0; border-radius: 999px;
  background: var(--pm-line-card); cursor: pointer;
}
.pm-switch[aria-checked='true'] { background: var(--dsw-alias-brand-primary); }
.pm-switch:disabled { cursor: default; opacity: .5; }
.pm-switch-thumb {
  display: block; width: 16px; height: 16px; border-radius: 50%; background: var(--dsw-alias-switch-thumb); transition: transform 120ms ease;
}
.pm-switch[aria-checked='true'] .pm-switch-thumb { background: var(--dsw-alias-label-primary-foreground); transform: translateX(16px); }
/* 步进：分段控件同一条轨道（悬停底色、圆角 12、内边距 4），两头 28px 方按钮 */
.pm-stepper { display: inline-flex; align-items: center; gap: 2px; padding: 4px; border-radius: var(--dsw-radius-md, 12px); background: var(--pm-hover); }
.pm-stepper-btn {
  width: 28px; height: 28px; padding: 0; border: 0; border-radius: var(--dsw-radius-sm, 8px); background: transparent;
  font: inherit; font-size: 16px; line-height: 1; color: var(--pm-text); cursor: pointer;
}
.pm-stepper-btn:hover:not(:disabled) { background: var(--pm-bg); box-shadow: var(--dsw-elevation-soft); }
.pm-stepper-btn:disabled { opacity: .4; cursor: default; }
.pm-stepper-value { min-width: 148px; padding: 0 10px; text-align: center; font-size: 13px; font-weight: 500; line-height: 28px; color: var(--pm-text); font-variant-numeric: tabular-nums; }
.pm-stepper-value small { font-size: 12px; font-weight: 400; color: var(--pm-text-2); }
.pm-stepper--disabled .pm-stepper-value { color: var(--pm-text-3); }
.pm-stepper--disabled .pm-stepper-value small { color: var(--pm-text-3); }
@media (prefers-reduced-motion: reduce) { .pm-switch-thumb { transition: none; } }
`
