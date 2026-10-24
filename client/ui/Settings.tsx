/**
 * 设置页（宿主绑定面）的结构：
 * - SettingsForm：照抄宿主 ui-primitives/settings-form/SettingsForm 的框架——只读提示、控件、保存行（保存靠左，
 *   主按钮没有改动时 .4 置灰）。离开页面丢弃暂存改动由调用方 onDiscard 处理。
 * - SettingsGroupCard：我们按用户决定加的分组卡片（「记什么 · 怎么用 · 怎么管」），组标题在卡片外。
 * - SettingsItem：卡片里的一项，上下各 14px，项与项之间 0.5px 细线。
 */
import { useEffect, useRef, type ReactNode } from 'react'
import { useT } from '../i18n.tsx'
import { Button } from './Button.tsx'

export interface SettingsFormState {
  /** 宿主是否在服务这份配置。 */
  available: boolean
  writable: boolean
  dirty: boolean
  invalid: boolean
  saving: boolean
  failed: boolean
}

export function SettingsForm({ state, onSave, onDiscard, children }: {
  state: SettingsFormState
  onSave: () => void
  onDiscard: () => void
  children: ReactNode
}) {
  const t = useT()
  const discard = useRef(onDiscard)
  discard.current = onDiscard
  useEffect(() => () => { discard.current() }, [])
  if (!state.available) return <p className="pm-form-note" role="status">{t('settings.unavailable')}</p>
  return (
    <div className="pm-form">
      {!state.writable ? <p className="pm-form-note" role="status">{t('settings.readOnly')}</p> : null}
      {children}
      <div className="pm-form-footer">
        {state.failed ? <p className="pm-form-failed" role="status">{t('settings.saveFailed')}</p> : null}
        <Button variant="primary" disabled={!state.dirty || state.invalid || state.saving || !state.writable} onClick={onSave}>
          {state.saving ? t('settings.saving') : t('settings.save')}
        </Button>
      </div>
    </div>
  )
}

export function SettingsGroupCard({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <section className="pm-group">
      <h2 className="pm-group-title">{title}</h2>
      <div className="pm-group-card">{children}</div>
    </section>
  )
}

export function SettingsItem({ label, hint, htmlFor, children }: {
  label: ReactNode
  hint?: ReactNode
  /** 控件 id，和标签关联。 */
  htmlFor?: string
  children: ReactNode
}) {
  return (
    <div className="pm-setting">
      <label className="pm-setting-label" htmlFor={htmlFor}>{label}</label>
      {children}
      {hint !== undefined ? <p className="pm-setting-hint">{hint}</p> : null}
    </div>
  )
}

export const settingsCss = `
.pm-form { display: flex; flex-direction: column; }
.pm-form-note { margin: 0 0 12px; font-size: 12px; line-height: 1.5; color: var(--pm-text-3); }
.pm-form-footer { display: flex; align-items: center; gap: 8px; padding-top: 16px; }
.pm-form-failed { flex: 1; min-width: 0; margin: 0; font-size: 12px; line-height: 1.5; color: var(--pm-error); }
.pm-group + .pm-group { margin-top: 32px; }
.pm-group-title { margin: 0 0 8px; padding-left: 16px; font-size: 16px; font-weight: 500; line-height: 24px; color: var(--pm-text); }
.pm-group-card { padding: 0 16px; border: .5px solid var(--pm-line-card); border-radius: var(--dsw-radius-lg, 16px); background: var(--pm-bg); }
.pm-setting { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; padding: 14px 0; }
.pm-setting + .pm-setting { border-top: .5px solid var(--pm-line); }
.pm-setting-label { font-size: 13px; font-weight: 500; line-height: 1.5; color: var(--pm-text); }
.pm-setting-hint { margin: 0; font-size: 12px; line-height: 1.5; color: var(--pm-text-3); }
`
