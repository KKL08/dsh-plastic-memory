/**
 * 设置页（宿主绑定面）的结构：
 * - SettingsForm：对齐宿主 ui-primitives/settings-form/SettingsForm 的框架——只读提示、控件、保存行（保存靠左，
 *   主按钮没有改动时 .4 置灰）。离开页面丢弃暂存改动由调用方 onDiscard 处理。
 *   和宿主不同：页面长，保存行吸在可视区底部（滚到页尾时回到原位），有改动时按钮后面写还有几项没保存。
 *   bottom 取 -48px：宿主插件页的滚动容器（.page）底部内边距 48px，吸附按内边距内沿算，不抵掉会悬在窗口底上方、下面露出内容。
 * - SettingsSection：设置页每个分页里的一个小节（带入、检索、体检…）：标题和一句「什么时候发生、花多少」在卡外上方，卡下可有一行脚注。
 *   分页本身（「记什么 · 怎么用 · 怎么管 · 外观」）是页内顶部标签，不在这里。
 * - SettingsCard：小节里的那张卡；「记什么」「外观」两页不分小节，直接一张卡。
 * - SettingsItem：卡片里的一项，上下各 14px，项与项之间 0.5px 细线（画在卡的左右内边距里，不通栏）；sub 是跟着上一项的子项，
 *   缩进 16px、和上一项之间不画线。SettingsSwitchItem 是开关一项：标签和说明在左，开关在右（同宿主 Switch 行）。
 * - 「记什么」的卡片里是两段小卡（.pm-subgroup：场景、记忆类型），段与段之间同样一条细线；每段前一个小标题（.pm-subgroup-title），
 *   小卡排成网格（.pm-tiles，同宿主 Agent 预设的卡片网格），卡身 .pm-tile-main、卡脚 .pm-tile-foot（细线隔开的操作），
 *   单选卡的整个卡身是单选框（.pm-tile-radio 盖满卡身），选中同宿主外观方块：平台底色 + bluish-400 描边；新建是网格最后一张虚线卡（.pm-tile-add）。
 *   小卡套在设置卡里，圆角小一档（12px）、描边浅一级（border-l2），和外框分出层次。
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
      {/* tabIndex -1：保存按钮置灰时焦点的落点（确认框点了保存之后），Tab 一下就是保存按钮 */}
      <div className="pm-form-footer" tabIndex={-1}>
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

/** 一个小节：标题、说明（和标题后的小标签）在卡外上方，项在卡里，脚注在卡下；整节是一个以标题命名的区域。 */
export function SettingsSection({ title, description, badge, footnote, children }: {
  title: ReactNode
  /** 标题后面同一行的一句说明。 */
  description: ReactNode
  /** 标题后的小标签（如「实验性」），读屏念在标题里。 */
  badge?: ReactNode
  /** 卡下的一行脚注。 */
  footnote?: ReactNode
  children: ReactNode
}) {
  const titleId = useId()
  return (
    <section className="pm-sec" aria-labelledby={titleId}>
      <div className="pm-sec-head">
        {/* 标题和小标签之间的空格给读屏断词；标题是 flex 容器，空格不占位 */}
        <h3 className="pm-sec-title" id={titleId}>{title}{badge !== undefined ? <>{' '}{badge}</> : null}</h3>
        <p className="pm-sec-desc">{description}</p>
      </div>
      <SettingsCard>{children}</SettingsCard>
      {footnote !== undefined ? <p className="pm-sec-foot">{footnote}</p> : null}
    </section>
  )
}

/** 设置卡：白底细描边的圆角卡，项与项之间的细线画在卡的左右内边距里。 */
export function SettingsCard({ children }: { children: ReactNode }) {
  return <div className="pm-group-card">{children}</div>
}

interface ItemProps {
  label: ReactNode
  hint?: ReactNode
  /** 控件 id，和标签关联。 */
  htmlFor?: string
  /** 标签自己的 id：控件是一组按钮时（步进），组用它作名字。 */
  labelId?: string
  /** 置灰保留（例如体检关闭时依赖它的项）：标签和说明降为次级色，控件由调用方禁用。 */
  disabled?: boolean
  /** 跟着上一项的子项（只在上一项开着时有用）。 */
  sub?: boolean
  /** 标签后的小标签（如「实验性」），不进控件的名字。 */
  badge?: ReactNode
}

const itemClass = (base: string, { disabled = false, sub = false }: Pick<ItemProps, 'disabled' | 'sub'>) =>
  [base, disabled && 'pm-setting--disabled', sub && 'pm-setting--sub'].filter(Boolean).join(' ')

function ItemLabel({ label, htmlFor, labelId, badge }: Pick<ItemProps, 'label' | 'htmlFor' | 'labelId' | 'badge'>) {
  const text = <label className="pm-setting-label" htmlFor={htmlFor} id={labelId}>{label}</label>
  return badge === undefined ? text : <span className="pm-setting-head">{text}{badge}</span>
}

/** 卡里的一项：标签在上，控件和说明在下。 */
export function SettingsItem({ children, hint, ...props }: ItemProps & { children: ReactNode }) {
  return (
    <div className={itemClass('pm-setting', props)}>
      <ItemLabel {...props} />
      {children}
      {hint !== undefined ? <p className="pm-setting-hint">{hint}</p> : null}
    </div>
  )
}

/** 开关一项：开关是 children（id 给 htmlFor），放在右边。 */
export function SettingsSwitchItem({ children, hint, ...props }: ItemProps & { children: ReactNode }) {
  return (
    <div className={itemClass('pm-setting pm-setting--switch', props)}>
      <div className="pm-setting-text">
        <ItemLabel {...props} />
        {hint !== undefined ? <p className="pm-setting-hint">{hint}</p> : null}
      </div>
      {children}
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
/* 只是焦点落点，不画焦点框（主题的 [tabindex] 焦点环同权重、先加载，这里加 .pm-root 压过它） */
.pm-root .pm-form-footer:focus { outline: none; }
.pm-form-pending { margin: 0; font-size: 12px; line-height: 1.5; color: var(--pm-text-3); }
.pm-form-failed { flex: 1; min-width: 0; margin: 0; font-size: 12px; line-height: 1.5; color: var(--pm-error); }
.pm-sec + .pm-sec { margin-top: 24px; }
.pm-sec-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 10px; margin: 0 0 8px; padding: 0 16px; }
.pm-sec-title { display: inline-flex; align-items: center; gap: 8px; margin: 0; font-size: 14px; font-weight: 600; line-height: 20px; color: var(--pm-text); }
.pm-sec-title .pm-chip { font-weight: 400; }
.pm-sec-desc { margin: 0; font-size: 12px; line-height: 18px; color: var(--pm-text-3); }
.pm-sec-foot { margin: 8px 0 0; padding: 0 16px; font-size: 12px; line-height: 1.5; color: var(--pm-text-3); }
.pm-group-card { padding: 0 16px; border: .5px solid var(--pm-line-card); border-radius: var(--dsw-radius-lg, 16px); background: var(--pm-bg); }
.pm-setting { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; padding: 14px 0; }
.pm-setting + .pm-setting { border-top: .5px solid var(--pm-line); }
.pm-setting--sub { padding-left: 16px; }
.pm-setting + .pm-setting--sub { border-top: 0; padding-top: 0; }
.pm-setting--switch { flex-direction: row; justify-content: space-between; gap: 24px; }
.pm-setting-text { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; min-width: 0; }
.pm-setting-head { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.pm-setting-label { font-size: 13px; font-weight: 500; line-height: 1.5; color: var(--pm-text); }
.pm-setting-hint { margin: 0; font-size: 12px; line-height: 1.5; color: var(--pm-text-3); }
.pm-setting--disabled .pm-setting-label { color: var(--pm-text-3); }
/* 上 14px 同设置项，下 16px 让网格离外框和分隔线一样远 */
.pm-subgroup { padding: 14px 0 16px; }
.pm-subgroup + .pm-subgroup { border-top: .5px solid var(--pm-line); }
.pm-subgroup-title { margin: 0 0 8px; font-size: 13px; font-weight: 500; line-height: 20px; color: var(--pm-text-2); }
.pm-subgroup-hint { margin: -4px 0 8px; font-size: 12px; line-height: 1.5; color: var(--pm-text-3); }
.pm-tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(268px, 100%), 1fr)); gap: 12px; margin: 0; padding: 0; list-style: none; }
.pm-tile {
  display: flex; flex-direction: column; min-width: 0; border: .5px solid transparent; border-radius: var(--dsw-radius-md, 12px); background: var(--pm-bg);
  /* 宿主轻投影：描边画在投影里，重绑成 var(--pm-line) 兜住白底上的边界 */
  --dsw-elevation-stroke-color: var(--pm-line); box-shadow: var(--dsw-elevation-soft); transition: border-color .16s, background .16s, box-shadow .16s;
}
.pm-tile-main { position: relative; display: flex; flex: 1; flex-direction: column; gap: 4px; padding: 14px 16px; }
.pm-tile-head { display: flex; align-items: center; gap: 6px; min-width: 0; }
.pm-tile-title { min-width: 0; font-size: 13px; font-weight: 500; line-height: 1.5; color: var(--pm-text); }
.pm-tile-detail { font-size: 12px; line-height: 1.5; color: var(--pm-text-2); }
.pm-tile-foot {
  display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 4px; padding: 8px 12px;
  /* 卡脚细线同卡的外沿一样画成 0.5px 投影（border 在 1 倍屏上会取整成 1px，比外沿还重）；暗色取宿主更浅一级的发丝线，不抢过卡的外沿 */
  box-shadow: inset 0 .5px 0 var(--dsw-alias-border-l2-darkmode-thin);
}
.pm-tile-radio { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; opacity: 0; cursor: pointer; }
.pm-tile-radio:disabled { cursor: default; }
.pm-tile:not(.pm-tile--selected):has(.pm-tile-radio:enabled:hover) { background: var(--pm-hover); }
.pm-tile--selected { border-color: var(--pm-line-selected); background: var(--pm-bg-block); box-shadow: none; }
/* 暗色下柔光几乎看不见，靠描边分开：对齐宿主浮层面的做法，描边深一级 */
body[data-ds-dark-theme] .pm-tile { --dsw-elevation-stroke-color: var(--pm-line-card); }
.pm-tile:has(.pm-tile-radio:focus-visible) { outline: var(--dsw-focus-ring-width, 2px) solid var(--pm-focus); outline-offset: 2px; }
.pm-tile-add-item { display: flex; min-width: 0; }
/* 独占一行时和带卡脚的普通小卡一样高：卡身 14 + 19.5 + 4 + 18 + 14，卡脚 8 + 24 + 8，加上下 0.5px 描边（卡脚细线画在投影里，不占高度），共 110.5px */
.pm-tile-add {
  display: flex; flex: 1; flex-direction: column; align-items: center; justify-content: center; gap: 2px; min-width: 0; min-height: 110.5px; padding: 14px 16px;
  border: 1px dashed var(--pm-line-card); border-radius: var(--dsw-radius-md, 12px); background: transparent;
  font: inherit; font-size: 13px; line-height: 1.5; color: var(--pm-text); cursor: pointer;
}
.pm-tile-add:hover:not(:disabled) { background: var(--pm-hover); }
.pm-tile-add:disabled { opacity: .4; cursor: default; }
.pm-tile-add-title { display: inline-flex; align-items: center; gap: 6px; }
.pm-tile-add-note { font-size: 12px; color: var(--pm-text-3); }
`
