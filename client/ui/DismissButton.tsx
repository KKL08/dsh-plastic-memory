/**
 * 不再提醒（DESIGN.md「Dismiss」）：卡片标题行右上角的叉，只表示「不再提醒这一项」，别的动作留在动作行。
 * 平时只有一个 10px 的叉；悬停或键盘聚焦时向左展开出字，压在标题行上、不挤动标题和胶囊。
 * 不用原生 disabled，理由同 Button 的 `unavailable`。
 */
export function DismissButton({ label, unavailable, onClick }: {
  /** 展开后显示的字，也是读屏名称。 */
  label: string
  unavailable?: string | undefined
  onClick: () => void
}) {
  const blocked = unavailable !== undefined
  return (
    <button
      type="button"
      className="pm-dismiss"
      aria-label={label}
      aria-disabled={blocked || undefined}
      title={blocked ? unavailable : undefined}
      onClick={() => { if (!blocked) onClick() }}
    >
      <span className="pm-dismiss-label" aria-hidden="true">{label}</span>
      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" aria-hidden="true">
        <path d="m1.5 1.5 7 7m0-7-7 7" />
      </svg>
    </button>
  )
}

// 展开后盖住下面的胶囊：按钮自己铺不透明的面板底，::before 再叠半透明的悬停色（隔离的层叠上下文里 -1 层画在按钮底之上）
export const dismissButtonCss = `
.pm-dismiss {
  position: absolute; top: 0; right: 0; isolation: isolate; display: inline-flex; align-items: center; justify-content: flex-end;
  height: 24px; min-width: 24px; padding: 0 7px; border: 0; border-radius: var(--dsw-radius-sm, 8px);
  font: inherit; font-size: 12px; font-weight: 400; line-height: 1; white-space: nowrap;
  background: transparent; color: var(--pm-text-2); cursor: pointer;
  clip-path: inset(0 0 0 calc(100% - 24px) round var(--dsw-radius-sm, 8px));
  transition: color .15s ease-out, clip-path .2s cubic-bezier(0.23, 1, 0.32, 1);
}
.pm-dismiss::before { content: ''; position: absolute; inset: 0; z-index: -1; border-radius: inherit; transition: background-color .15s ease-out; }
.pm-dismiss-label { margin-right: 4px; opacity: 0; transition: opacity .15s ease-out; }
/* 键盘聚焦时不可用也展开出字（整体半透明），不只剩一个淡淡的叉 */
:is(.pm-dismiss:hover:not([aria-disabled='true']), .pm-dismiss:focus-visible) { background: var(--pm-bg); color: var(--pm-text); clip-path: inset(-4px round calc(var(--dsw-radius-sm, 8px) + 4px)); }
:is(.pm-dismiss:hover:not([aria-disabled='true']), .pm-dismiss:focus-visible)::before { background: var(--pm-hover); }
:is(.pm-dismiss:hover:not([aria-disabled='true']), .pm-dismiss:focus-visible) .pm-dismiss-label { opacity: 1; }
.pm-dismiss[aria-disabled='true'] { opacity: .4; cursor: default; }
@media (prefers-reduced-motion: reduce) { .pm-dismiss, .pm-dismiss::before, .pm-dismiss-label { transition: none; } }
`
