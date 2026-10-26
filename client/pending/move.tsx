/**
 * 放错层里全局那条的「移到项目…」：在卡片里展开已知项目（单选，默认选当前页面的项目），「取消」收起，点「移过去」才发命令。
 * 收起时焦点回到「移到项目…」，按钮没了就落到附近（useReturnFocus）。
 */
import { useId, useRef, useState } from 'react'
import { baseName, useT } from '../i18n.tsx'
import { Button } from '../ui/Button.tsx'
import { useReturnFocus } from '../ui/focus-return.ts'

export function MovePanel({ projects, initial, unavailable, onCancel, onMove }: {
  /** 已知项目（绝对路径），按显示顺序。 */
  projects: readonly string[]
  /** 默认选中的项目；不在 projects 里时选第一个。 */
  initial: string | undefined
  /** 「移过去」暂不可用的原因（没有会话、正在处理、等跨项目确认）。 */
  unavailable: string | undefined
  onCancel: () => void
  onMove: (workspacePath: string) => void
}) {
  const t = useT()
  const ref = useRef<HTMLFieldSetElement>(null)
  useReturnFocus(ref)
  const name = useId()
  const [selected, setSelected] = useState(initial !== undefined && projects.includes(initial) ? initial : projects[0])
  return (
    <fieldset ref={ref} className="pm-move">
      <legend className="pm-pending-text pm-pending-confirm-title">{t('pending.move.title')}</legend>
      {projects.length === 0
        ? <p className="pm-pending-text">{t('pending.move.none')}</p>
        : (
          <div className="pm-move-list">
            {projects.map(path => (
              <label key={path} className="pm-move-option">
                <input
                  type="radio"
                  name={name}
                  value={path}
                  checked={selected === path}
                  autoFocus={selected === path}
                  onChange={() => { setSelected(path) }}
                />
                <span className="pm-move-name">{baseName(path)}</span>
                <span className="pm-move-path">{path}</span>
              </label>
            ))}
          </div>
        )}
      <div className="pm-pending-actions">
        {/* 没有可选的项目时焦点落在这里：「移到项目…」已收起，不接住就掉到页面上 */}
        <Button variant="ghost" autoFocus={selected === undefined} onClick={onCancel}>{t('pending.cancel')}</Button>
        <Button
          variant="primary"
          unavailable={unavailable ?? (selected === undefined ? t('pending.move.none') : undefined)}
          onClick={() => { if (selected !== undefined) onMove(selected) }}
        >
          {t('pending.move.confirm')}
        </Button>
      </div>
    </fieldset>
  )
}

export const moveCss = `
.pm-move { display: flex; flex-direction: column; gap: 8px; min-width: 0; margin: 0; padding: 12px; border: 0; border-radius: var(--dsw-radius-md, 12px); background: var(--pm-bg-block); }
.pm-move legend { float: left; width: 100%; padding: 0; }
.pm-move-list { display: flex; flex-direction: column; gap: 2px; }
.pm-move-option { display: flex; align-items: baseline; gap: 8px; min-width: 0; padding: 4px 0; font-size: 13px; line-height: 1.5; color: var(--pm-text); cursor: pointer; }
.pm-move-option input { flex-shrink: 0; margin: 0; accent-color: var(--pm-text); transform: translateY(2px); }
.pm-move-option input:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--pm-focus); outline-offset: 2px; }
.pm-move-name { flex-shrink: 0; }
.pm-move-path { min-width: 0; font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 12px; color: var(--pm-text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
`
