/**
 * 按钮（DESIGN.md「Buttons」）：主按钮对齐宿主设置页保存按钮；次按钮白底细描边；淡灰小按钮只给提醒卡的「忽略」
 * 「知道了」；危险按钮白底红字淡红描边；ghost 无边框、次文字色，给同一行里退后一级的动作（最近删除的「彻底删除…」、建议整理卡的「打开文件」、「撤销」「取消」「放弃」「停止」）。`unavailable` 给「现在做不了」的动作：不用原生 disabled，
 * 这样提示文字能悬停看到、读屏也念得出，点击被吞掉。
 */
import type { ButtonHTMLAttributes, MouseEvent } from 'react'

export type ButtonVariant = 'primary' | 'secondary' | 'quiet' | 'danger' | 'ghost'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  /** 动作暂不可用时的原因（例如「先开一个会话」）。 */
  unavailable?: string | undefined
}

export function Button({ variant = 'secondary', unavailable, className, onClick, title, ...rest }: ButtonProps) {
  const blocked = unavailable !== undefined
  return (
    <button
      type="button"
      {...rest}
      className={['pm-btn', `pm-btn--${variant}`, className].filter(Boolean).join(' ')}
      aria-disabled={blocked || undefined}
      title={blocked ? unavailable : title}
      onClick={(event: MouseEvent<HTMLButtonElement>) => { if (!blocked) onClick?.(event) }}
    />
  )
}

export const buttonCss = `
.pm-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 4px; flex-shrink: 0;
  font: inherit; font-size: 13px; line-height: 1.5; white-space: nowrap;
  padding: 5px 14px; border-radius: var(--dsw-radius-md, 12px);
  border: 0.5px solid var(--pm-line-input); background: var(--pm-bg); color: var(--pm-text);
  cursor: pointer;
}
.pm-btn:hover:not(:disabled):not([aria-disabled='true']) { background: var(--pm-hover); }
.pm-btn--primary { border: 1px solid transparent; background: var(--pm-text); color: var(--pm-bg-raised); }
.pm-btn--primary:hover:not(:disabled):not([aria-disabled='true']) { background: var(--pm-text); }
.pm-btn--quiet {
  height: 24px; padding: 0 8px; font-size: 12px; border: 0;
  border-radius: var(--dsw-radius-sm, 8px); background: var(--pm-hover); color: var(--pm-text-2);
}
.pm-btn--quiet:hover:not(:disabled):not([aria-disabled='true']) { background: var(--pm-pressed); color: var(--pm-text); }
.pm-btn--danger { color: var(--pm-error); border-color: color-mix(in srgb, var(--pm-error) 35%, transparent); }
.pm-btn--ghost { border-color: transparent; background: transparent; color: var(--pm-text-2); }
.pm-btn:disabled, .pm-btn[aria-disabled='true'] { opacity: .4; cursor: default; }
`
