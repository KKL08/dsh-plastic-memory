/**
 * 空状态（DESIGN.md「Empty State」）：
 * - first（「还没有记忆」）：40px 银藤底图标，里面是银藤色鲸尾线稿；出现时播一次约 2 秒的出水动画，
 *   鼠标移上去重播，减弱动态效果时直接静止。不循环、不做渐变。
 * - daily（「待处理为空」「还没体检过」「体检已关闭」…）：浅灰图标底 + 次文字色图标，一句结论，最多一个动作。
 * 不放假按钮：记忆由 agent 在对话里写。
 */
import { useId, useState, type ReactNode } from 'react'
import { MemoryIcon } from '../MemoryIcon.tsx'

export interface EmptyStateProps {
  variant: 'first' | 'daily'
  title: ReactNode
  /** 说明从哪来 / 会发生什么。 */
  children?: ReactNode
  /** 最多一个动作（按钮或「去设置里打开 ›」）。 */
  action?: ReactNode
  /** daily 的图标，缺省用记忆图标。 */
  icon?: ReactNode
}

export function EmptyState({ variant, title, children, action, icon }: EmptyStateProps) {
  const [play, setPlay] = useState(0)
  return (
    <div className={`pm-empty pm-empty--${variant}`} role="status">
      <div className="pm-empty-icon" onMouseEnter={variant === 'first' ? () => { setPlay(n => n + 1) } : undefined}>
        {variant === 'first' ? <WhaleTail key={play} /> : (icon ?? <MemoryIcon size={20} />)}
      </div>
      <p className="pm-empty-title">{title}</p>
      {children !== undefined ? <p className="pm-empty-body">{children}</p> : null}
      {action !== undefined ? <div className="pm-empty-action">{action}</div> : null}
    </div>
  )
}

/** 鲸尾出水线稿：24 栅格、1.6 描边、currentColor。尾干从水面伸出，两片尾叶上翘，后缘中间一个缺口，两侧水波线。 */
export function WhaleTail() {
  const clip = useId()
  return (
    <svg className="pm-whale" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <defs><clipPath id={clip}><rect x="0" y="0" width="24" height="18.6" /></clipPath></defs>
      <g clipPath={`url(#${clip})`}>
        <g className="pm-whale-tail">
          <path d="M12 19.5v-6.6" />
          <path d="M12 12.9C10.6 10.4 8.2 8.9 4.6 8.4c.5 2.7 3 4.6 7.4 4.5Z" />
          <path d="M12 12.9c1.4-2.5 3.8-4 7.4-4.5-.5 2.7-3 4.6-7.4 4.5Z" />
        </g>
      </g>
      <path d="M2.5 19.6c1.1 0 1.7-.8 2.8-.8s1.7.8 2.8.8" />
      <path d="M15.9 19.6c1.1 0 1.7-.8 2.8-.8s1.7.8 2.8.8" />
      <ellipse className="pm-whale-ripple pm-whale-ripple--1" cx="12" cy="19.4" rx="4" ry=".9" strokeWidth={1} />
      <ellipse className="pm-whale-ripple pm-whale-ripple--2" cx="12" cy="19.4" rx="6" ry="1.3" strokeWidth={1} />
      <circle className="pm-whale-drip pm-whale-drip--1" cx="5.2" cy="9.4" r=".5" fill="currentColor" stroke="none" />
      <circle className="pm-whale-drip pm-whale-drip--2" cx="12" cy="13.4" r=".5" fill="currentColor" stroke="none" />
      <circle className="pm-whale-drip pm-whale-drip--3" cx="18.8" cy="9.4" r=".5" fill="currentColor" stroke="none" />
    </svg>
  )
}

export const emptyStateCss = `
.pm-empty { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 48px 16px; text-align: center; }
.pm-empty-icon {
  display: inline-flex; align-items: center; justify-content: center; width: 40px; height: 40px;
  border-radius: var(--dsw-radius-md, 12px); background: var(--pm-bg-block); color: var(--pm-text-2);
}
.pm-empty--first .pm-empty-icon { background: var(--pm-accent-tint); color: var(--pm-accent); }
.pm-empty-title { margin: 4px 0 0; font-size: 14px; font-weight: 600; line-height: 1.5; color: var(--pm-text); }
.pm-empty-body { margin: 0; max-width: 420px; font-size: 12px; line-height: 1.5; color: var(--pm-text-2); }
.pm-empty-action { margin-top: 4px; }

.pm-whale { overflow: visible; }
.pm-whale-tail { transform-box: view-box; transform-origin: 12px 19px; animation: pm-whale-rise 2s cubic-bezier(.22,.8,.24,1) both; }
.pm-whale-ripple { transform-box: fill-box; transform-origin: center; opacity: 0; animation: pm-whale-ripple 1.5s ease-out both; }
.pm-whale-ripple--1 { animation-delay: .4s; }
.pm-whale-ripple--2 { animation-delay: .75s; }
.pm-whale-drip { opacity: 0; animation: pm-whale-drip .8s cubic-bezier(.55,0,1,.45) both; }
.pm-whale-drip--1 { animation-delay: 1.15s; }
.pm-whale-drip--2 { animation-delay: 1.3s; }
.pm-whale-drip--3 { animation-delay: 1.45s; }
@keyframes pm-whale-rise {
  0% { transform: translateY(9px) rotate(0deg); }
  42% { transform: translateY(0) rotate(0deg); }
  62% { transform: translateY(0) rotate(-8deg); }
  80% { transform: translateY(0) rotate(5deg); }
  100% { transform: translateY(0) rotate(0deg); }
}
@keyframes pm-whale-ripple { 0% { transform: scale(.3); opacity: 0; } 20% { opacity: .9; } 100% { transform: scale(1.4); opacity: 0; } }
@keyframes pm-whale-drip { 0% { transform: translateY(0); opacity: 0; } 15% { opacity: 1; } 100% { transform: translateY(6px); opacity: 0; } }
@media (prefers-reduced-motion: reduce) {
  .pm-whale-tail, .pm-whale-ripple, .pm-whale-drip { animation: none; }
}
`
