/**
 * 设置页（宿主绑定面）的结构：
 * - SettingsForm：对齐宿主 ui-primitives/settings-form/SettingsForm 的框架——只读提示、控件、保存行（保存靠左，
 *   主按钮没有改动时 .4 置灰）。离开页面丢弃暂存改动由调用方 onDiscard 处理。
 *   和宿主不同：页面长，保存行吸在可视区底部（滚到页尾时回到原位），有改动时按钮后面写还有几项没保存。
 *   bottom 取 -48px：宿主插件页的滚动容器（.page）底部内边距 48px，吸附按内边距内沿算，不抵掉会悬在窗口底上方、下面露出内容。
 * - SettingsGroupCard：我们按用户决定加的分组卡片（「记什么 · 怎么用 · 怎么管」），组标题在卡片外。
 * - SettingsItem：卡片里的一项，上下各 14px，项与项之间 0.5px 细线。
 * - SettingsGroup：只有组标题的一组，组里放几组小卡（「记什么」的场景、记忆类型）：每组前一个小标题（.pm-subgroup-title），
 *   小卡排成网格（.pm-tiles，同宿主 Agent 预设的卡片网格），卡身 .pm-tile-main、卡脚 .pm-tile-foot（细线隔开的操作），
 *   单选卡的整个卡身是单选框（.pm-tile-radio 盖满卡身），选中同宿主外观方块：平台底色 + bluish-400 描边；新建是网格下的虚线条（.pm-tile-add）。
 */
import { useEffect, useId, useRef, type ReactNode } from 'react'
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

export function SettingsForm({ state, pending, onSave, onDiscard, children }: {
  state: SettingsFormState
  /** 保存按钮后面的一句（还有几项改动没保存），也是按钮的描述。 */
  pending?: string | undefined
  onSave: () => void
  onDiscard: () => void
  children: ReactNode
}) {
  const t = useT()
  const pendingId = useId()
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
        <Button variant="primary" disabled={!state.dirty || state.invalid || state.saving || !state.writable}
          aria-describedby={pending !== undefined ? pendingId : undefined} onClick={onSave}>
          {state.saving ? t('settings.saving') : t('settings.save')}
        </Button>
        {pending !== undefined ? <p className="pm-form-pending" id={pendingId}>{pending}</p> : null}
      </div>
    </div>
  )
}

export function SettingsGroup({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <section className="pm-group">
      <h2 className="pm-group-title">{title}</h2>
      {children}
    </section>
  )
}

export function SettingsGroupCard({ title, children }: { title: ReactNode; children: ReactNode }) {
  return <SettingsGroup title={title}><div className="pm-group-card">{children}</div></SettingsGroup>
}

export function SettingsItem({ label, hint, htmlFor, disabled = false, children }: {
  label: ReactNode
  hint?: ReactNode
  /** 控件 id，和标签关联。 */
  htmlFor?: string
  /** 置灰保留（例如体检关闭时依赖它的项）：标签和说明降为次级色，控件由调用方禁用。 */
  disabled?: boolean
  children: ReactNode
}) {
  return (
    <div className={disabled ? 'pm-setting pm-setting--disabled' : 'pm-setting'}>
      <label className="pm-setting-label" htmlFor={htmlFor}>{label}</label>
      {children}
      {hint !== undefined ? <p className="pm-setting-hint">{hint}</p> : null}
    </div>
  )
}

export const settingsCss = `
.pm-form { display: flex; flex-direction: column; }
.pm-form-note { margin: 0 0 12px; font-size: 12px; line-height: 1.5; color: var(--pm-text-3); }
.pm-form-footer {
  position: sticky; bottom: -48px; z-index: 1; display: flex; align-items: center; gap: 12px;
  margin-top: 16px; padding: 12px 0; border-top: .5px solid var(--pm-line); background: var(--pm-bg-page);
}
.pm-form-pending { margin: 0; font-size: 12px; line-height: 1.5; color: var(--pm-text-3); }
.pm-form-failed { flex: 1; min-width: 0; margin: 0; font-size: 12px; line-height: 1.5; color: var(--pm-error); }
.pm-group + .pm-group { margin-top: 32px; }
.pm-group-title { margin: 0 0 8px; padding-left: 16px; font-size: 16px; font-weight: 500; line-height: 24px; color: var(--pm-text); }
.pm-group-card { padding: 0 16px; border: .5px solid var(--pm-line-card); border-radius: var(--dsw-radius-lg, 16px); background: var(--pm-bg); }
.pm-setting { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; padding: 14px 0; }
.pm-setting + .pm-setting { border-top: .5px solid var(--pm-line); }
.pm-setting-label { font-size: 13px; font-weight: 500; line-height: 1.5; color: var(--pm-text); }
.pm-setting-hint { margin: 0; font-size: 12px; line-height: 1.5; color: var(--pm-text-3); }
.pm-setting--disabled .pm-setting-label { color: var(--pm-text-3); }
.pm-subgroup + .pm-subgroup { margin-top: 24px; }
.pm-subgroup-title { margin: 0 0 8px; padding-left: 16px; font-size: 13px; font-weight: 500; line-height: 20px; color: var(--pm-text-2); }
.pm-subgroup-hint { margin: -4px 0 8px; padding-left: 16px; font-size: 12px; line-height: 1.5; color: var(--pm-text-3); }
.pm-tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(268px, 100%), 1fr)); gap: 12px; margin: 0; padding: 0; list-style: none; }
.pm-tile { display: flex; flex-direction: column; min-width: 0; border: .5px solid var(--pm-line-card); border-radius: var(--dsw-radius-lg, 16px); background: var(--pm-bg); transition: border-color .16s, background .16s; }
.pm-tile-main { position: relative; display: flex; flex: 1; flex-direction: column; gap: 4px; padding: 14px 16px; }
.pm-tile-head { display: flex; align-items: center; gap: 6px; min-width: 0; }
.pm-tile-title { min-width: 0; font-size: 13px; font-weight: 500; line-height: 1.5; color: var(--pm-text); }
.pm-tile-detail { font-size: 12px; line-height: 1.5; color: var(--pm-text-2); }
.pm-tile-foot { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 4px; padding: 8px 12px; border-top: .5px solid var(--pm-line); }
.pm-tile-radio { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; opacity: 0; cursor: pointer; }
.pm-tile-radio:disabled { cursor: default; }
.pm-tile:not(.pm-tile--selected):has(.pm-tile-radio:enabled:hover) { background: var(--pm-hover); }
.pm-tile--selected { border-color: var(--pm-line-selected); background: var(--pm-bg-block); }
.pm-tile:has(.pm-tile-radio:focus-visible) { outline: var(--dsw-focus-ring-width, 2px) solid var(--pm-focus); outline-offset: 2px; }
.pm-tile-add {
  display: flex; align-items: center; justify-content: center; gap: 6px; width: 100%; min-height: 44px; margin-top: 12px; padding: 0 16px;
  border: 1px dashed var(--pm-line-card); border-radius: var(--dsw-radius-lg, 16px); background: transparent;
  font: inherit; font-size: 13px; line-height: 1.5; color: var(--pm-text); cursor: pointer;
}
.pm-tile-add:hover:not(:disabled) { background: var(--pm-hover); }
.pm-tile-add:disabled { opacity: .4; cursor: default; }
.pm-tile-add-note { margin-left: 4px; font-size: 12px; color: var(--pm-text-3); }
.pm-tile-group-title + .pm-tile-add { margin-top: 0; }
`
