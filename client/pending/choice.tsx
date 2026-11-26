/**
 * 先在卡片里选一条再动手：「并成版本」选哪条是现在的状态，跨项目重复的「提升为全局」选提升哪一条。
 * 同「移到项目…」（move.tsx）的样子和规矩：单选，默认选建议的那条，「取消」收起，点确认按钮才发命令；收起时焦点回到打开它的按钮。
 */
import { useId, useRef, useState } from 'react'
import { useT } from '../i18n.tsx'
import { Button } from '../ui/Button.tsx'
import { useReturnFocus } from '../ui/focus-return.ts'

export function ChoicePanel({ legend, options, initial, hint, confirmLabel, unavailable, onCancel, onConfirm }: {
  legend: string
  /** 能选的几条，按显示顺序。 */
  options: ReadonlyArray<{ value: string; label: string }>
  /** 默认选中的；不在 options 里时选第一个。 */
  initial: string | undefined
  /** 选项下面一句后果（12px 次文字）。 */
  hint?: string | undefined
  confirmLabel: string
  /** 确认按钮暂不可用的原因（正在处理、等跨项目确认）。 */
  unavailable: string | undefined
  onCancel: () => void
  onConfirm: (value: string) => void
}) {
  const t = useT()
  const ref = useRef<HTMLFieldSetElement>(null)
  useReturnFocus(ref)
  const name = useId()
  const [selected, setSelected] = useState(options.some(o => o.value === initial) ? initial : options[0]?.value)
  return (
    <fieldset ref={ref} className="pm-move">
      <legend className="pm-pending-text pm-pending-confirm-title">{legend}</legend>
      <div className="pm-move-list">
        {options.map(option => (
          <label key={option.value} className="pm-move-option">
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={selected === option.value}
              autoFocus={selected === option.value}
              onChange={() => { setSelected(option.value) }}
            />
            <span className="pm-move-name">{option.label}</span>
          </label>
        ))}
      </div>
      {hint !== undefined ? <p className="pm-pending-text">{hint}</p> : null}
      <div className="pm-pending-actions">
        <Button variant="ghost" onClick={onCancel}>{t('pending.cancel')}</Button>
        <Button variant="primary" unavailable={unavailable} onClick={() => { if (selected !== undefined) onConfirm(selected) }}>{confirmLabel}</Button>
      </div>
    </fieldset>
  )
}
